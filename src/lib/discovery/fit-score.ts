/**
 * fit-score.ts - the pure profit composer and ranking for the personal fit
 * score (Phase 14.1, FIT-03/FIT-06): for each for-sale row it predicts the
 * market price from the hedonic model, adds a renovation bundle, and returns
 * the expected flip profit with every component visible.
 *
 *   profit = credit - reno - sales costs - holding costs - tax + taste
 *   credit = min(resale - expected final price, MAX_CREDIT_PCT x resale)
 *
 * PURE, synchronous - no clock, no randomness, no network, no async, no file or
 * environment access, no console output and no fixed-decimal string formatting.
 * Money stays as floats; rounding happens only where a person reads it. The
 * same snapshot and model always yield the same ranking, which is what makes
 * the offline replay (FIT-06) a real test.
 *
 * STRUCTURAL SEPARATION (LOCKED, amended 2026-10-12): vision MAY influence the
 * ORDER of this headless ranking, but only through this file. `niche-score.ts`
 * and `report/flags.ts` must NEVER import it, nor `hedonic-model.ts`,
 * `reno-tier.ts`, `taste.ts` or the fit pipeline. The static-grep invariant in
 * `niche-score.test.ts` enforces that, and its positive control proves the
 * matcher recognises this file as importing a registered specifier.
 *
 * HONESTY RULE: a missing price or size makes a row "not comparable" with a
 * null profit; a flat nobody looked at carries the unknown reno bundle and the
 * ejBildtolkad flag; an unknown floor, balcony or location is listed in
 * `featuresImputed`. Nothing is fabricated to make a row rankable.
 *
 * `valueGap()` is called unchanged (D-01). Its own tax and uplift lines are
 * ignored; this module composes the credit cap, costs, tax and taste itself.
 *
 * DECISIONS THIS FILE CARRIES:
 *   D-01  profit in kr; valueGap() is reused unchanged.
 *   D-02  resale comes from the hedonic kr/m2 model; the fitted coefficients
 *         are the weights, so floor and balcony are worth what the market paid.
 *   D-03  purchase is asking x the district's expected overbid; an expected
 *         final above 4 000 000 kr is flagged, never dropped.
 *   D-04  reno cost comes from the vision verdict, priced from RENO_COST_MATRIX;
 *         unknown is the mid bundle, flagged.
 *   D-05  sales costs, holding costs and tax default to zero (gross profit).
 *   D-06  taste adds at most TASTE_CAP_PCT of resale and never subtracts.
 *   D-07  a reno object with a capped credit can outrank a nice-but-fairly-
 *         priced flat; this falls out of the arithmetic and is held by a
 *         regression test, not by a bonus.
 *   D-10  rows outside the picture-read window carry the unknown reno bundle
 *         and ejBildtolkad; rows inside use what the pictures said. The
 *         pre-rank and the window selection live below.
 *   R-01  reno cost is priced at the mid band of RENO_COST_MATRIX.
 *   R-02  measured, not tuned: no number exists to lift one listing.
 *   R-12  a size outside the range the model was fitted on is flagged
 *         (utanförModellensStorlek); the profit is still computed and shown.
 *
 * KNOBS (each named, documented, with a reason that is not "make the list look
 * right"): MAX_CREDIT_PCT (reused discount-attribution cap), RENO_RESALE_PREMIUM
 * (low end of the researched range), TASTE_CAP_PCT (Daniel's 5 % ceiling),
 * FIT_VISION_WINDOW (a spend bound), and the fitted bid-premium model. There is
 * no level offset, no per-district fudge and no weight whose only purpose is to
 * move one address.
 */

import { z } from "zod/v4";
import { discoveryCandidateSchema, type DiscoveryCandidate } from "@/lib/discovery/candidate";
import { MAX_CONDITION_EXPLAINED_PCT } from "@/lib/discovery/confounder-guard";
import { taxLines, valueGap, type ValueGapInput } from "@/lib/discovery/flip-economics";
import {
  INNERSTAN_DISTRICTS,
  expectedOverbid,
  predictKrPerSqm,
  renovatedCapKrPerSqm,
  type HedonicModel,
  type InnerstanDistrict,
} from "@/lib/discovery/hedonic-model";
import {
  UNKNOWN_RENO_STATES,
  renoBundle,
  renoEstimateFromVision,
  type RenoEstimate,
} from "@/lib/discovery/reno-tier";
import { tasteBonus } from "@/lib/discovery/taste";

// ---------------------------------------------------------------------------
// Named constants (R-02: every knob is named, documented and principled)
// ---------------------------------------------------------------------------

/**
 * Most of the resale price that condition (a renovation) may be credited with.
 * Reuses the discount-attribution cap from `confounder-guard.ts`: a cheap flat
 * is mostly cheap for reasons other than its kitchen.
 */
export const MAX_CREDIT_PCT = MAX_CONDITION_EXPLAINED_PCT;

/**
 * How much more a renovated flat fetches than the model's (average-condition)
 * price, as a fraction. Low end of the 10-20 % range seen in the research
 * ([ASSUMED], RESEARCH A4); the renovated cap below usually binds first.
 */
export const RENO_RESALE_PREMIUM = 0.1;

/** Most that personal taste may add to the profit, as a fraction of resale (D-06). */
export const TASTE_CAP_PCT = 0.05;

/** Expected final prices above this get the expectedFinalOver4M flag (D-03). */
export const EXPECTED_FINAL_CEILING_SEK = 4_000_000;

/** How many top pre-ranked rows get the (paid) picture read in the live run (R-03). */
export const FIT_VISION_WINDOW = 20;

/**
 * Asking price below this share of the model's price means the model and the
 * listing disagree too much to trust either (different kind of flat, a wrong
 * area, a data error). The row is listed as not comparable (RESEARCH Pitfall 2c).
 */
export const NOT_COMPARABLE_ASK_TO_PRED = 0.5;

// ---------------------------------------------------------------------------
// Snapshot (the stored for-sale pull the replay reads)
// ---------------------------------------------------------------------------

const sunPhrasesSchema = z.object({ allDaySun: z.boolean(), throughFlat: z.boolean() });

const fitRowSchema = z.object({
  district: z.enum(INNERSTAN_DISTRICTS),
  /** Whether the detail page was fetched for this row (orientation, balcony, year). */
  detailFetched: z.boolean(),
  /** Whether this row sits inside the picture-read window. */
  inVisionWindow: z.boolean(),
  sunPhrases: sunPhrasesSchema.nullable(),
  /** Re-parsed with the app's own schema, which re-applies the image-host allowlist. */
  candidate: discoveryCandidateSchema,
});

export const fitSnapshotSchema = z.object({
  version: z.literal(1),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.string().optional(),
  rows: z.array(fitRowSchema),
});

export type FitSnapshot = z.infer<typeof fitSnapshotSchema>;
export type FitInputRow = FitSnapshot["rows"][number];

/** Parses an untrusted snapshot value, or throws one readable Error. */
export function parseFitSnapshot(json: unknown): FitSnapshot {
  const result = fitSnapshotSchema.safeParse(json);
  if (result.success) return result.data;
  const issues = result.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
  throw new Error(`Invalid fit snapshot: ${issues}`);
}

/** The Booli id from a listing URL ending in /bostad/<n> or /annons/<n>, else null. */
export function booliIdOf(candidate: Pick<DiscoveryCandidate, "sourceListingUrl">): number | null {
  const url = candidate.sourceListingUrl;
  if (url === null) return null;
  const m = /\/(?:bostad|annons)\/(\d+)(?:[/?#].*)?$/.exec(url);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type FitFlag =
  | "expectedFinalOver4M"
  | "ejBildtolkad"
  | "hiddenDefectRisk"
  | "creditCapped"
  | "renoUnknown"
  | "utanförModellensStorlek"
  | "notComparable";

/** Cost options. All default to zero / false (D-05): the profit is gross unless asked. */
export interface FitScoreOptions {
  readonly salesCostsSek?: number;
  readonly holdingCostsSek?: number;
  /** Apply the flat 22 % capital-gains tax to the (credit - costs) gain. */
  readonly applyTax?: boolean;
  /** Replaces the reno estimate (tests, what-if runs). */
  readonly renoOverride?: RenoEstimate;
}

/**
 * One row, fully decomposed. A field is null only where the input made it
 * impossible to compute (a row without price or size).
 */
export interface FitScoreResult {
  readonly booliId: number | null;
  readonly address: string | null;
  readonly sourceListingUrl: string | null;
  readonly district: InnerstanDistrict;
  readonly floor: number | null;
  readonly comparable: boolean;
  /** Why the row is not comparable (Swedish, for the printed list), else null. */
  readonly notComparableReason: string | null;
  readonly askingSek: number | null;
  readonly livingArea: number | null;
  readonly predKrPerSqm: number | null;
  /** Asking kr/m2 divided by the model's kr/m2 (1 = asked at model price). */
  readonly askToPred: number | null;
  /** Renovated resale value (capped), SEK. */
  readonly resaleSek: number | null;
  /** Expected final price including the expected overbid, SEK. */
  readonly purchaseSek: number | null;
  readonly overbidPct: number | null;
  /** resale - expected final, before the credit cap. */
  readonly gapSek: number | null;
  /** The part of the gap the profit takes credit for, after the cap. */
  readonly creditSek: number | null;
  readonly renoSek: number;
  readonly renoLowSek: number;
  readonly renoHighSek: number;
  readonly renoTier: RenoEstimate["tier"];
  readonly renoStates: RenoEstimate["states"];
  readonly tasteSek: number;
  readonly tasteSunPct: number;
  readonly tasteHubPct: number;
  readonly nearestHub: string | null;
  readonly hubMeters: number | null;
  readonly salesCostsSek: number;
  readonly holdingCostsSek: number;
  readonly taxSek: number;
  /** Null when the row is not comparable. */
  readonly profitSek: number | null;
  readonly flags: readonly FitFlag[];
  readonly featuresImputed: readonly string[];
}

/**
 * The taste bonus in SEK: `tastePct` of the resale value, clamped to
 * [0, TASTE_CAP_PCT] (D-06). A negative or non-finite share is zero, so taste
 * can order flats whose money case is close but never rescue a bad deal and
 * never subtract.
 */
export function cappedTasteSek(tastePct: number, resaleSek: number): number {
  if (!Number.isFinite(tastePct)) return 0;
  return Math.min(TASTE_CAP_PCT, Math.max(0, tastePct)) * resaleSek;
}

/**
 * Scores one row. Never throws on missing data: it returns a not-comparable
 * result instead.
 */
export function fitScore(
  row: FitInputRow,
  model: HedonicModel,
  opts: FitScoreOptions = {},
): FitScoreResult {
  const c = row.candidate;
  const salesCostsSek = opts.salesCostsSek ?? 0;
  const holdingCostsSek = opts.holdingCostsSek ?? 0;
  // Reno: an override wins; a row inside the picture-read window uses what the
  // pictures said; every other row carries the unknown bundle (D-10, R-01).
  const reno =
    opts.renoOverride ??
    (row.inVisionWindow
      ? renoEstimateFromVision(c.vision)
      : renoBundle(UNKNOWN_RENO_STATES));

  const base = {
    booliId: booliIdOf(c),
    address: c.address,
    sourceListingUrl: c.sourceListingUrl,
    district: row.district,
    floor: c.floor,
    renoSek: reno.midSek,
    renoLowSek: reno.lowSek,
    renoHighSek: reno.highSek,
    renoTier: reno.tier,
    renoStates: reno.states,
    salesCostsSek,
    holdingCostsSek,
  } as const;

  /** A row whose price or size is missing has no resale to take a taste share of. */
  const noTaste = {
    tasteSek: 0,
    tasteSunPct: 0,
    tasteHubPct: 0,
    nearestHub: null,
    hubMeters: null,
  } as const;

  const outsideWindow: readonly FitFlag[] = row.inVisionWindow ? [] : ["ejBildtolkad"];
  const unknownReno: readonly FitFlag[] =
    row.inVisionWindow && reno.anyUnknown ? ["renoUnknown"] : [];
  // R-12: a size outside the range the model was fitted on is an extrapolation.
  // The flag changes no number; it makes the extrapolation visible.
  const outsideSize: readonly FitFlag[] =
    c.livingArea !== null &&
    c.livingArea > 0 &&
    (c.livingArea < model.minLivingArea || c.livingArea > model.maxLivingArea)
      ? ["utanförModellensStorlek"]
      : [];

  const price = c.price;
  const area = c.livingArea;
  if (price === null || !(price > 0) || area === null || !(area > 0)) {
    return {
      ...base,
      ...noTaste,
      comparable: false,
      notComparableReason: price === null || !(price > 0) ? "pris saknas" : "kvm saknas",
      askingSek: price,
      livingArea: area,
      predKrPerSqm: null,
      askToPred: null,
      resaleSek: null,
      purchaseSek: null,
      overbidPct: null,
      gapSek: null,
      creditSek: null,
      taxSek: 0,
      profitSek: null,
      flags: [...outsideWindow, ...unknownReno, ...outsideSize, "notComparable"],
      featuresImputed: [],
    };
  }

  const { krPerSqm: pred, imputed } = predictKrPerSqm(model, {
    district: row.district,
    latitude: c.latitude,
    longitude: c.longitude,
    floor: c.floor,
    livingArea: area,
    balcony: c.balcony,
    constructionYear: c.constructionYear,
  });
  const askingPerSqm = price / area;
  const overbid = expectedOverbid(model, row.district, askingPerSqm, pred);

  const gapInput: ValueGapInput = {
    askingPrice: price,
    livingArea: area,
    renovatedMedianPerSqm: pred * (1 + RENO_RESALE_PREMIUM),
    unrenovatedMedianPerSqm: pred,
    renovatedCapPerSqm: renovatedCapKrPerSqm(model, pred),
    renoCostSek: reno.midSek,
    expectedOverbid: overbid,
    salesCostsSek,
    isDated: reno.anyDated,
  };
  const gap = valueGap(gapInput);

  const gapSek = gap.resaleW - gap.purchaseP;
  const creditCap = MAX_CREDIT_PCT * gap.resaleW;
  const creditSek = Math.min(gapSek, creditCap);
  const gain = creditSek - reno.midSek - salesCostsSek - holdingCostsSek;
  const taxSek = opts.applyTax === true ? taxLines(gain).taxSek : 0;
  const taste = tasteBonus({
    latitude: c.latitude,
    longitude: c.longitude,
    orientation: c.orientation,
    sunPhrases: row.sunPhrases,
  });
  const tasteSek = cappedTasteSek(taste.pct, gap.resaleW);
  const askToPred = askingPerSqm / pred;

  const notComparable = askToPred < NOT_COMPARABLE_ASK_TO_PRED;
  const profit = gain - taxSek + tasteSek;

  const flags: FitFlag[] = [];
  if (gap.purchaseP > EXPECTED_FINAL_CEILING_SEK) flags.push("expectedFinalOver4M");
  flags.push(...outsideWindow);
  if (gap.hiddenDefectRisk) flags.push("hiddenDefectRisk");
  if (gapSek > creditCap) flags.push("creditCapped");
  flags.push(...unknownReno);
  flags.push(...outsideSize);
  if (notComparable) flags.push("notComparable");

  return {
    ...base,
    tasteSek,
    tasteSunPct: taste.sunPct,
    tasteHubPct: taste.hubPct,
    nearestHub: taste.nearestHub,
    hubMeters: taste.hubMeters,
    comparable: !notComparable,
    notComparableReason: notComparable ? "utgångspris långt under modellvärdet" : null,
    askingSek: price,
    livingArea: area,
    predKrPerSqm: pred,
    askToPred,
    resaleSek: gap.resaleW,
    purchaseSek: gap.purchaseP,
    overbidPct: overbid,
    gapSek,
    creditSek,
    taxSek,
    profitSek: notComparable ? null : profit,
    flags,
    featuresImputed: imputed,
  };
}

/**
 * Scores every row and orders the comparable ones: profit descending, then
 * Booli id ascending (rows without an id last, then by address), so ties and
 * reruns come out identical. Rows that cannot be compared are returned
 * separately, in input order.
 */
export function rankFit(
  rows: readonly FitInputRow[],
  model: HedonicModel,
  opts: FitScoreOptions = {},
): { readonly ranked: readonly FitScoreResult[]; readonly notComparable: readonly FitScoreResult[] } {
  const scored = rows.map((row) => fitScore(row, model, opts));
  const ranked = scored
    .filter((r) => r.comparable && r.profitSek !== null)
    .sort((a, b) => {
      const byProfit = (b.profitSek as number) - (a.profitSek as number);
      if (byProfit !== 0) return byProfit;
      if (a.booliId !== b.booliId) {
        if (a.booliId === null) return 1;
        if (b.booliId === null) return -1;
        return a.booliId - b.booliId;
      }
      const aAddr = a.address ?? "";
      const bAddr = b.address ?? "";
      return aAddr < bAddr ? -1 : aAddr > bAddr ? 1 : 0;
    });
  return { ranked, notComparable: scored.filter((r) => !r.comparable) };
}
