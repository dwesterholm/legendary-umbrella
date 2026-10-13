/**
 * fit-score.ts - the pure profit composer and ranking for the personal fit
 * score (Phase 14.1, FIT-03/FIT-06): for each for-sale row it predicts the
 * market price from the hedonic model, adds a renovation bundle, and returns
 * the expected flip profit with every component visible.
 *
 *   profit = credit - reno - sales costs - holding costs - tax + taste
 *   credit = resale - expected final price (the full gap; no ceiling since 14.4)
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
 * ignored; this module composes the credit, costs, tax and taste itself.
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
 *   D-07  a reno object with a large credit can outrank a nice-but-fairly-
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
 * right"): RESIDUAL_FLAG_BASIS / RESIDUAL_FLAG_SD (when a flat is flagged as far
 * below the model; the flag never changes a number), RENO_RESALE_PREMIUM
 * (low end of the researched range), TASTE_CAP_PCT (Daniel's 5 % ceiling),
 * FIT_VISION_WINDOW (a spend bound), and the fitted bid-premium model. There is
 * no level offset, no per-district fudge and no weight whose only purpose is to
 * move one address.
 */

import { z } from "zod/v4";
import { discoveryCandidateSchema, type DiscoveryCandidate } from "@/lib/discovery/candidate";
import { taxLines, valueGap, type ValueGapInput } from "@/lib/discovery/flip-economics";
import { candidateFactsSchema } from "@/lib/discovery/listing-facts";
import {
  INNERSTAN_DISTRICTS,
  expectedOverbidDetail,
  predictKrPerSqm,
  renovatedCapKrPerSqm,
  type HedonicInput,
  type HedonicModel,
  type InnerstanDistrict,
  type OverbidDetail,
} from "@/lib/discovery/hedonic-model";
import {
  UNKNOWN_RENO_STATES,
  renoBundle,
  renoEstimateFromVision,
  type RenoEstimate,
} from "@/lib/discovery/reno-tier";
import { computeNicheScore } from "@/lib/discovery/niche-score";
import { sunFactSchema, type SunFact } from "@/lib/discovery/sun-fact";
import { tasteBonus, type InferredSunInput } from "@/lib/discovery/taste";

// ---------------------------------------------------------------------------
// Named constants (R-02: every knob is named, documented and principled)
// ---------------------------------------------------------------------------

/**
 * Which ratio decides the "ovanligt långt under modellpris" flag (R-04, 14.4).
 *
 * "expectedFinal" (default) compares the price the buyer is expected to pay with
 * the model's price per m2. The model is fitted on SOLD prices, so this is the
 * like-for-like comparison. "asking" compares the asking price with the model
 * (the original D-05 wording); asking prices sit below sold prices by the
 * expected overbid, so that basis fired on 30 of 77 rows on the 2026-10-13
 * snapshot, against 7 for the like-for-like basis. Flip the constant to choose.
 * The flag only explains; it never changes a number.
 */
export type ResidualFlagBasis = "expectedFinal" | "asking";
export const RESIDUAL_FLAG_BASIS: ResidualFlagBasis = "expectedFinal";

/**
 * How many residual standard deviations (in log kr/m2) below the model a flat
 * must be before it is flagged: further below than about 97.5 % of the sales
 * the model was fitted on.
 */
export const RESIDUAL_FLAG_SD = 2;

/**
 * Whether a flat is further below the model than the features can explain (R-04).
 * Strict on both bases: a ratio exactly on the limit is not flagged.
 *  - expectedFinal: ln(expected final kr/m2 / model kr/m2) < -RESIDUAL_FLAG_SD x residualSdLog
 *  - asking:        asking kr/m2 / model kr/m2 < exp(-RESIDUAL_FLAG_SD x residualSdLog)
 */
export function residualFlagFires(
  basis: ResidualFlagBasis,
  ratios: { readonly askToPred: number; readonly expectedFinalToPred: number },
  residualSdLog: number,
): boolean {
  if (basis === "asking") return ratios.askToPred < Math.exp(-RESIDUAL_FLAG_SD * residualSdLog);
  return Math.log(ratios.expectedFinalToPred) < -RESIDUAL_FLAG_SD * residualSdLog;
}

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
  /**
   * R-08 (Phase 14.2): what Booli's payloads said beyond the 24 candidate fields (tenure,
   * avgift, listing age, stated sun, ...), beside the candidate and never inside it.
   * `.nullable().default(null)`: a snapshot written before 14.2 still parses and its rows
   * read as "no facts".
   */
  facts: candidateFactsSchema.nullable().default(null),
  /**
   * R-08 (Phase 14.3): what the sun spike worked out for this flat (facade, source, confidence),
   * beside the candidate and never inside it. Reads null when absent AND when the stored value
   * does not match the current schema (`.catch(null)`): an old or foreign record never breaks a
   * replay, it just reads as "this run did not look".
   */
  sun: sunFactSchema.nullable().catch(null).default(null),
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
  | "residualFlag"
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
  /** Which ratio decides the residual flag; defaults to {@link RESIDUAL_FLAG_BASIS}. */
  readonly residualFlagBasis?: ResidualFlagBasis;
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
  /** How the expected overbid was put together (base form, days-on-market term, label); null when not comparable. */
  readonly overbidDetail: OverbidDetail | null;
  /** Expected final kr/m2 divided by the model's kr/m2 (the like-for-like ratio); null when not comparable. */
  readonly expectedFinalToPred: number | null;
  /** The chosen basis' ratio minus 1 (negative = below the model); null when not comparable. */
  readonly residualPct: number | null;
  /** resale - expected final: what the flat is worth renovated minus what it is expected to cost. */
  readonly gapSek: number | null;
  /** The part of the gap the profit takes credit for: the full gap (14.4 removed the 20 % ceiling, features in the model now explain cheap flats). */
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
  /** The row's sun record passed through unchanged (Phase 14.3); null when the run did not look. */
  readonly sun: SunFact | null;
}

/**
 * Which date's hours scale the sun taste (Phase 14.3, D-07; research Pattern 4):
 * 21 March, the most stable month in the research envelope for the
 * morning-and-midday window.
 */
export const TASTE_SUN_OBSTRUCTION_DATE = "mar" as const;

/**
 * The stored sun fact as the plain numbers taste.ts takes (D-07, R-03). Per side
 * the obstruction factor is obstructed nominal / theoretical hours of the
 * morning-and-midday window on {@link TASTE_SUN_OBSTRUCTION_DATE}, clamped to
 * [0, 1], and 1 when the side has no hours, no obstructed range or no
 * theoretical sun. Pure and does no rounding: the fact is already stored rounded.
 */
export function inferredSunForTaste(sun: SunFact | null): InferredSunInput | null {
  if (sun === null) return null;
  if (sun.source === "okänd") return { source: "okänd", confidence: 0, sides: [] };
  return {
    source: sun.source,
    confidence: sun.confidence,
    sides: sun.sides.map((side) => {
      const date = side.hours?.[TASTE_SUN_OBSTRUCTION_DATE];
      const theoretical = date?.theoreticalWindow ?? 0;
      const nominal = date?.obstructedWindow?.nominal;
      const factor =
        nominal === undefined || !(theoretical > 0) ? 1 : Math.min(1, Math.max(0, nominal / theoretical));
      return { facade: side.facade, obstructionFactor: factor };
    }),
  };
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
 * What the hedonic model is told about one for-sale row (D-01, 14.4). Besides the
 * candidate's own fields it passes the three inputs the sold side trains on, built
 * the same way: avgift per m2 and month from the listing's avgift, the association's
 * debt per m2, and tomträtt from the stated land lease. An unknown value stays null
 * (never a made-up number), so the model marginalises it and names it in `imputed`.
 */
export function hedonicInputOf(row: FitInputRow, area: number): HedonicInput {
  const c = row.candidate;
  const facts = row.facts;
  const avgift = facts?.avgiftMonthlySek ?? null;
  const debt = facts?.brf?.debtPerSqm ?? null;
  return {
    district: row.district,
    latitude: c.latitude,
    longitude: c.longitude,
    floor: c.floor,
    livingArea: area,
    balcony: c.balcony,
    constructionYear: c.constructionYear,
    avgiftPerSqmMonth: avgift !== null && Number.isFinite(avgift) && avgift > 0 && area > 0 ? avgift / area : null,
    brfDebtPerSqm: debt !== null && Number.isFinite(debt) && debt >= 0 ? debt : null,
    tomtratt: facts?.landLease ?? null,
  };
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
    sun: row.sun,
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
      overbidDetail: null,
      expectedFinalToPred: null,
      residualPct: null,
      gapSek: null,
      creditSek: null,
      taxSek: 0,
      profitSek: null,
      flags: [...outsideWindow, ...unknownReno, ...outsideSize, "notComparable"],
      featuresImputed: [],
    };
  }

  const { krPerSqm: pred, imputed } = predictKrPerSqm(model, hedonicInputOf(row, area));
  const askingPerSqm = price / area;
  // Days on market move the expected FINAL price (the bid premium), never the resale value (D-02).
  const overbidDetail = expectedOverbidDetail(model, row.district, askingPerSqm, pred, {
    daysOnMarket: row.facts?.daysOnMarket ?? null,
  });
  const overbid = overbidDetail.pct;

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
  const creditSek = gapSek;
  const gain = creditSek - reno.midSek - salesCostsSek - holdingCostsSek;
  const taxSek = opts.applyTax === true ? taxLines(gain).taxSek : 0;
  const taste = tasteBonus({
    latitude: c.latitude,
    longitude: c.longitude,
    orientation: c.orientation,
    sunPhrases: row.sunPhrases,
    inferredSun: inferredSunForTaste(row.sun),
  });
  const tasteSek = cappedTasteSek(taste.pct, gap.resaleW);
  const askToPred = askingPerSqm / pred;
  const expectedFinalToPred = gap.purchaseP / area / pred;
  const residualBasis = opts.residualFlagBasis ?? RESIDUAL_FLAG_BASIS;
  const residualPct = (residualBasis === "asking" ? askToPred : expectedFinalToPred) - 1;

  const notComparable = askToPred < NOT_COMPARABLE_ASK_TO_PRED;
  const profit = gain - taxSek + tasteSek;

  const flags: FitFlag[] = [];
  if (gap.purchaseP > EXPECTED_FINAL_CEILING_SEK) flags.push("expectedFinalOver4M");
  flags.push(...outsideWindow);
  if (gap.hiddenDefectRisk) flags.push("hiddenDefectRisk");
  if (residualFlagFires(residualBasis, { askToPred, expectedFinalToPred }, model.residualSdLog)) {
    flags.push("residualFlag");
  }
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
    overbidPct: overbidDetail.pct,
    overbidDetail,
    expectedFinalToPred,
    residualPct,
    gapSek,
    creditSek,
    taxSek,
    profitSek: notComparable ? null : profit,
    flags,
    featuresImputed: imputed,
  };
}

/**
 * How many ranked rows the residual flag would mark under each basis (R-04: both
 * counts are printed on every run, so the choice of {@link RESIDUAL_FLAG_BASIS}
 * is an informed one). `primary` is the basis in force, `other` the alternative.
 * Pure; a row that is not comparable has no ratios and is not counted.
 */
export function residualFlagCounts(
  ranked: readonly Pick<FitScoreResult, "askToPred" | "expectedFinalToPred">[],
  residualSdLog: number,
  primaryBasis: ResidualFlagBasis = RESIDUAL_FLAG_BASIS,
): { n: number; primaryBasis: ResidualFlagBasis; primary: number; otherBasis: ResidualFlagBasis; other: number } {
  const otherBasis: ResidualFlagBasis = primaryBasis === "asking" ? "expectedFinal" : "asking";
  let primary = 0;
  let other = 0;
  let n = 0;
  for (const r of ranked) {
    if (r.askToPred === null || r.expectedFinalToPred === null) continue;
    n += 1;
    const ratios = { askToPred: r.askToPred, expectedFinalToPred: r.expectedFinalToPred };
    if (residualFlagFires(primaryBasis, ratios, residualSdLog)) primary += 1;
    if (residualFlagFires(otherBasis, ratios, residualSdLog)) other += 1;
  }
  return { n, primaryBasis, primary, otherBasis, other };
}

// ---------------------------------------------------------------------------
// Ordering (FIT-05)
// ---------------------------------------------------------------------------

/** Descending order for numbers: -1 when `a` comes first. Never subtracts, so infinities cannot give NaN. */
function byDescending(a: number, b: number): number {
  return a > b ? -1 : a < b ? 1 : 0;
}

/** Booli id ascending, rows without an id last, then address ascending. */
function byIdThenAddress(
  a: { readonly booliId: number | null; readonly address: string | null },
  b: { readonly booliId: number | null; readonly address: string | null },
): number {
  if (a.booliId !== b.booliId) {
    if (a.booliId === null) return 1;
    if (b.booliId === null) return -1;
    return a.booliId - b.booliId;
  }
  const aAddr = a.address ?? "";
  const bAddr = b.address ?? "";
  return aAddr < bAddr ? -1 : aAddr > bAddr ? 1 : 0;
}

/**
 * One comparable row after the free pre-rank: the row, its profit with the
 * unknown reno bundle (vision ignored), its renovation-upside niche score and
 * its 1-based position.
 */
export interface PreRankedRow {
  readonly row: FitInputRow;
  readonly pre: FitScoreResult;
  readonly nicheScore: number;
  readonly position: number;
}

/**
 * Pre-rank order (D-10): pre-profit descending, then the renovation-upside
 * niche score descending, then Booli id ascending (no id last), then address.
 * The same order picks the picture-read window, so a tie at the window edge is
 * always settled the same way.
 */
export function comparePreRank(a: PreRankedRow, b: PreRankedRow): number {
  const byProfit = byDescending(a.pre.profitSek ?? Number.NEGATIVE_INFINITY, b.pre.profitSek ?? Number.NEGATIVE_INFINITY);
  if (byProfit !== 0) return byProfit;
  const byNiche = byDescending(a.nicheScore, b.nicheScore);
  if (byNiche !== 0) return byNiche;
  return byIdThenAddress(a.pre, b.pre);
}

/** Final order: profit descending, then Booli id ascending (no id last), then address. */
export function compareFinal(a: FitScoreResult, b: FitScoreResult): number {
  const byProfit = byDescending(a.profitSek ?? Number.NEGATIVE_INFINITY, b.profitSek ?? Number.NEGATIVE_INFINITY);
  if (byProfit !== 0) return byProfit;
  return byIdThenAddress(a, b);
}

/** Median of a non-empty list (mean of the two middle values for an even count). */
function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The free ranking that decides who gets the (paid) picture read. Every
 * comparable row is scored with the UNKNOWN reno bundle (vision is ignored at
 * this stage, so the order cannot depend on pictures nobody has read yet) and
 * ordered with {@link comparePreRank}.
 *
 * READING OF D-10 ("existing niche score + hedonic resale"): the pre-profit
 * already contains the hedonic resale, and the existing renovation-upside niche
 * score from `niche-score.ts` is the secondary key. D-10's "(cap 60)" was the
 * expected candidate count, not a truncation: this ranks ALL comparable rows
 * because it is free, and truncating before scoring would let Booli's own sort
 * decide who is dropped. The caller caps only the printed table.
 *
 * The niche baseline is the median asking kr/m2 of the comparable rows, the
 * same instrument `scripts/find-reno.ts` uses.
 */
export function preRank(
  rows: readonly FitInputRow[],
  model: HedonicModel,
): { ranked: PreRankedRow[]; notComparable: FitScoreResult[] } {
  const unknownBundle = renoBundle(UNKNOWN_RENO_STATES);
  const scored = rows.map((row) => ({ row, pre: fitScore(row, model, { renoOverride: unknownBundle }) }));
  const comparable = scored.filter((x) => x.pre.comparable && x.pre.profitSek !== null);
  const notComparable = scored.filter((x) => !(x.pre.comparable && x.pre.profitSek !== null)).map((x) => x.pre);

  const perSqm = comparable.map((x) => (x.pre.askingSek as number) / (x.pre.livingArea as number));
  const medianPricePerSqm = perSqm.length > 0 ? medianOf(perSqm) : null;

  const withNiche = comparable.map((x) => ({
    row: x.row,
    pre: x.pre,
    nicheScore: computeNicheScore(x.row.candidate, "renovation-upside", { medianPricePerSqm }).score,
    position: 0,
  }));
  withNiche.sort(comparePreRank);
  return { ranked: withNiche.map((x, i) => ({ ...x, position: i + 1 })), notComparable };
}

/**
 * The picture-read window: exactly the first `n` rows of the pre-rank order
 * (default {@link FIT_VISION_WINDOW}). The input is re-sorted with
 * {@link comparePreRank}, so a tie at the edge goes to the lower Booli id and
 * the result does not depend on the order the rows arrive in.
 */
export function selectVisionWindow(
  pre: readonly PreRankedRow[],
  n: number = FIT_VISION_WINDOW,
): { inWindow: PreRankedRow[]; outside: PreRankedRow[] } {
  const size = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  const sorted = [...pre].sort(comparePreRank);
  return { inWindow: sorted.slice(0, size), outside: sorted.slice(size) };
}

/** Median expected final price / model price outside this band means the model and the market disagree. */
export const MODEL_HEALTH_BAND = [0.85, 1.15] as const;

export interface ModelHealth {
  /** Median of purchaseSek / (predKrPerSqm x livingArea) over comparable rows; null with no rows. */
  readonly medianFinalToPred: number | null;
  readonly band: readonly [number, number];
  /** True when the median lies outside the band (the band edges themselves are healthy). */
  readonly outOfBand: boolean;
  /** Number of comparable rows the median is over. */
  readonly n: number;
}

/**
 * How well the model's price level matches what the market asks and pays
 * today. NO automatic level offset is applied when this is out of band (R-02:
 * nothing shifts levels to make the list look right); the caller prints the
 * warning and a person decides.
 */
export function modelHealth(results: readonly FitScoreResult[]): ModelHealth {
  const ratios: number[] = [];
  for (const r of results) {
    if (!r.comparable || r.purchaseSek === null || r.predKrPerSqm === null || r.livingArea === null) continue;
    ratios.push(r.purchaseSek / (r.predKrPerSqm * r.livingArea));
  }
  const [lo, hi] = MODEL_HEALTH_BAND;
  if (ratios.length === 0) {
    return { medianFinalToPred: null, band: MODEL_HEALTH_BAND, outOfBand: false, n: 0 };
  }
  const medianFinalToPred = medianOf(ratios);
  return {
    medianFinalToPred,
    band: MODEL_HEALTH_BAND,
    outOfBand: medianFinalToPred < lo || medianFinalToPred > hi,
    n: ratios.length,
  };
}

/**
 * Scores every row and orders the comparable ones with {@link compareFinal}
 * (profit descending, then Booli id ascending), so ties and reruns come out
 * identical. Rows that cannot be compared are returned separately, in input
 * order. `health` reports whether the model's price level matches the asking
 * prices; it changes no number.
 */
export function rankFit(
  rows: readonly FitInputRow[],
  model: HedonicModel,
  opts: FitScoreOptions = {},
): { ranked: FitScoreResult[]; notComparable: FitScoreResult[]; health: ModelHealth } {
  const scored = rows.map((row) => fitScore(row, model, opts));
  const ranked = scored.filter((r) => r.comparable && r.profitSek !== null).sort(compareFinal);
  return {
    ranked,
    notComparable: scored.filter((r) => !r.comparable),
    health: modelHealth(ranked),
  };
}

/** The numbers D-14's "never below a clearly worse flat" is measured on. */
interface DominanceKeys {
  readonly pred: number;
  readonly area: number;
  readonly tasteShare: number;
  readonly reno: number;
  readonly pricePerSqm: number;
}

function dominanceKeys(r: FitScoreResult): DominanceKeys | null {
  if (
    r.predKrPerSqm === null ||
    r.livingArea === null ||
    r.resaleSek === null ||
    r.purchaseSek === null ||
    !(r.resaleSek > 0) ||
    !(r.livingArea > 0)
  ) {
    return null;
  }
  return {
    pred: r.predKrPerSqm,
    area: r.livingArea,
    tasteShare: r.tasteSek / r.resaleSek,
    reno: r.renoSek,
    pricePerSqm: r.purchaseSek / r.livingArea,
  };
}

/**
 * Every row ranked ABOVE the target that the target dominates: the row is no
 * better on location (model kr/m2), size (larger is better), taste share of
 * resale or reno cost (lower is better), is not cheaper per m2 of expected
 * final price, and is strictly worse on at least one of those. Such a row
 * sitting above the target is an order violation worth showing, so D-14's
 * "never ranked below a clearly worse flat" is measured, not assumed.
 * A target that is not in the list gives an empty list.
 */
export function clearlyWorseAbove(
  ranked: readonly FitScoreResult[],
  targetBooliId: number,
): FitScoreResult[] {
  const targetIndex = ranked.findIndex((r) => r.booliId === targetBooliId);
  if (targetIndex < 0) return [];
  const t = dominanceKeys(ranked[targetIndex]);
  if (t === null) return [];
  const worse: FitScoreResult[] = [];
  for (let i = 0; i < targetIndex; i++) {
    const x = dominanceKeys(ranked[i]);
    if (x === null) continue;
    const noBetter =
      x.pred <= t.pred &&
      x.area <= t.area &&
      x.tasteShare <= t.tasteShare &&
      x.reno >= t.reno &&
      x.pricePerSqm >= t.pricePerSqm;
    const strictlyWorse =
      x.pred < t.pred ||
      x.area < t.area ||
      x.tasteShare < t.tasteShare ||
      x.reno > t.reno ||
      x.pricePerSqm > t.pricePerSqm;
    if (noBetter && strictlyWorse) worse.push(ranked[i]);
  }
  return worse;
}
