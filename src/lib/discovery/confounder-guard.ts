/**
 * confounder-guard.ts — PURE discount-attribution guard for the discovery
 * value-gap (SPEC 2026-07-10 §2.6) plus the 2026-07-17 operator rule
 * "LOW kr/m² ≠ RENO OBJECT". Before a low kr/m² is ever attributed to
 * condition/reno-upside, it must be normalized against the SPECIFIC
 * confounders present (floor, balcony, BRF debt, tomträtt, odd BOA) and the
 * confounders that cannot be evaluated this phase (elevator, micro-location,
 * sub-area) must be named as unknown rather than silently assumed away.
 *
 * STRUCTURAL SEPARATION: on the vision/analysis read path; like
 * `area-comps.ts` / `flip-economics.ts` it must never be imported by
 * `niche-score.ts` / `flags.ts` (enforced by the niche-score.test.ts
 * static-grep invariant — this module's specifier is already registered in
 * `niche-score.test.ts`'s `VISION_MODULE_SPECIFIERS`, added in 14-01 BEFORE
 * this module existed).
 *
 * Pure — no I/O, no model calls, no `Date.now()`. Its output is never sent
 * to Claude: every field here is a code-computed number/enum, never a model
 * output, so the Anthropic strict-output slim-schema discipline does not
 * apply to this module.
 */

import { MIN_COMPS_FOR_CONFIDENCE } from "@/lib/discovery/area-comps";
import { BRF_SANITY_BANDS } from "@/lib/brf/sanity";
import {
  tomtrattFromTenureForm,
  brfFieldTrusted,
  HOLISTIC_DATA_ONLY_MARKER,
  type AreaCompsSummary,
  type BrfConfidenceField,
  type BrfSummary,
  type HolisticBrief,
  type HolisticBriefItem,
} from "@/lib/discovery/holistic-schema";

// ---------------------------------------------------------------------------
// SPEC-locked constants
// ---------------------------------------------------------------------------

/** SPEC §2.6: >25% below R_med triggers the discount-attribution guard. */
export const DISCOUNT_ATTRIBUTION_TRIGGER_PCT = 0.25;

/** SPEC §2.6: when the guard triggers, condition-explained is capped at 20%. */
export const MAX_CONDITION_EXPLAINED_PCT = 0.2;

/** SPEC §2.2's ">15k red flag" for förening debt per kvm. */
export const HIGH_BRF_DEBT_PER_SQM = 15_000;

/**
 * CR-02 (14-REVIEW.md re-review / 14-VERIFICATION.md ANL-04 gap): the
 * IMPLAUSIBILITY ceiling for a `skuldPerKvm` reading, deliberately DISTINCT
 * from — and far above — the SPEC §2.2 ALARM threshold above.
 *
 * The two answer different questions and must never share a value:
 *  - `HIGH_BRF_DEBT_PER_SQM` (15 000) asks "is this förening dangerously
 *    indebted?" A reading above it is a FACT to surface (`brf_debt_high`), and
 *    it MUST enter the debt-inclusive kr/m² basis (SPEC §2.6 rule 1) — that is
 *    precisely the candidate whose apparent discount is not real.
 *  - this constant asks "is this number even a debt-per-m² figure?" Above it
 *    the reading is a denominator/unit misextraction (total förening debt read
 *    as debt/m², e.g. 480 000 instead of ~8 000) — a fact about the PDF, not
 *    about the förening, so it is suppressed from both the math and the prose.
 *
 * Before this split the alarm threshold was numerically identical to
 * `BRF_SANITY_BANDS.skuldPerKvm.max`, so `applySanityChecks` downgraded every
 * genuinely high-but-real debt figure below `OSAKER_THRESHOLD`, which dropped
 * it out of `effectivePricePerSqm` and made `brf_debt_high` unreachable — a
 * dangerously indebted förening read as a BIGGER bargain than it is (the exact
 * inversion 14-VERIFICATION.md records as the open ANL-04 gap).
 *
 * 60 000 kr/m²: roughly 4x the Stockholm sanity ceiling and several times the
 * highest debt levels seen in real Stockholm föreningar, while still an order
 * of magnitude below a six-figure total-debt misread. `sanity.ts`'s shared band
 * is deliberately NOT widened — it also drives the single-listing "Osäker"
 * badge and the published methodology page, where "outside the plausible
 * Stockholm band" is the correct, narrower claim.
 */
export const IMPLAUSIBLE_BRF_DEBT_PER_SQM = 60_000;

/**
 * Whether a `BrfSummary`'s `skuldPerKvm` may be used as FACT — admitted into
 * the debt-inclusive kr/m² basis (rule 1), named as `brf_debt_high` (rule 5),
 * and stated in `buildBrfItem`'s prose.
 *
 * This is the CR-02 split of "implausible reading" from "alarming but plausible
 * reading". `brfFieldTrusted` alone cannot make that distinction, because
 * `applySanityChecks` collapses BOTH causes into the same
 * `DOWNGRADED_CONFIDENCE` (0.2): a value is downgraded purely for being outside
 * `BRF_SANITY_BANDS.skuldPerKvm`, regardless of how legibly it was read.
 *
 * The decision therefore branches on WHY the confidence is what it is:
 *  1. Absent / non-finite value -> unusable (nothing to state).
 *  2. Negative, or above `IMPLAUSIBLE_BRF_DEBT_PER_SQM` -> unusable. This is
 *     the misextraction case the sanity band exists to catch.
 *  3. No `fieldConfidence` map at all (a legacy persisted row) -> unusable.
 *     Fails closed exactly as `brfFieldTrusted` does; an absent confidence is
 *     an absence of evidence (D-14-05).
 *  4. Value INSIDE the sanity band -> the stored confidence is the model's OWN
 *     judgement of legibility (the band never touched it), so the ordinary
 *     `OSAKER_THRESHOLD` gate applies: a smudged-scan 0.2 stays suppressed.
 *  5. Value OUTSIDE the band but plausible (the 15k..60k alarm window, and the
 *     symmetric debt-light case below the band's 2 000 floor) -> the stored
 *     confidence was pinned by the band and carries no information about
 *     legibility, so the figure is USED. A real 30 000 kr/m² debt is a fact to
 *     surface, and a debt-free förening is the most attractive possible signal
 *     — neither may be hedged away as unreadable.
 *
 * @param brf - the `BrfSummary` to check, or `null`
 * @returns `true` only when the debt figure is present, plausible, and either
 *   in-band-and-confident or out-of-band-for-band-reasons-only
 */
export function brfDebtPerSqmUsable(brf: BrfSummary | null): boolean {
  if (brf === null) return false;
  const value = brf.skuldPerKvm;
  if (value === null || !Number.isFinite(value)) return false;
  if (value < 0 || value > IMPLAUSIBLE_BRF_DEBT_PER_SQM) return false;
  const band = BRF_SANITY_BANDS.skuldPerKvm;
  const outOfBand = value < band.min || value > band.max;
  if (outOfBand) {
    // The sanity downgrade is fully explained by the band itself — see (5).
    // A manual override (MANUAL_CONFIDENCE) lands here too and is equally
    // usable, so no separate branch is needed.
    return true;
  }
  return brfFieldTrusted(brf, "skuldPerKvm");
}

/** SPEC §2.6 "odd BOA" lower bound (m²). */
export const ODD_BOA_MIN_SQM = 20;
/** SPEC §2.6 "odd BOA" upper bound (m²). */
export const ODD_BOA_MAX_SQM = 160;

/**
 * The widened ±m² band the CALLER passes to a second `computeAreaComps` call
 * when the tight segment has fewer than `MIN_COMPS_FOR_CONFIDENCE` comps
 * (SPEC §2.6 "require ≥5 comps in 12mo or widen band"). Exported here so
 * `job.ts` uses a named value, never a literal.
 */
export const WIDENED_SIZE_BAND_PCT = 0.3;
/** The widened recency window (months) paired with `WIDENED_SIZE_BAND_PCT`. */
export const WIDENED_MAX_AGE_MONTHS = 24;

// ---------------------------------------------------------------------------
// normalizeForConfounders — SPEC §2.6 rules 1-8
// ---------------------------------------------------------------------------

/**
 * The confounders this module can reason about. `*_unknown` variants name a
 * confounder that cannot be evaluated with the data available this phase —
 * per D-14-05, "cannot attribute to condition" is the default posture, never
 * a silent assumption.
 */
export type ConfounderId =
  | "bottenvaning"
  | "no_balcony"
  | "brf_debt_high"
  | "tomtratt"
  | "odd_boa"
  | "elevator_unknown"
  | "micro_location_unknown"
  | "brf_unknown"
  | "balcony_unknown"
  | "floor_unknown"
  | "tomtratt_unknown"
  | "sub_area_unknown";

export interface ConfounderGuardInput {
  readonly pricePerSqm: number | null;
  readonly livingArea: number | null;
  readonly floor: number | null;
  readonly balcony: boolean | null;
  readonly tenureForm: string | null;
  readonly comps: AreaCompsSummary | null;
  readonly brf: BrfSummary | null;
}

export interface ConfounderGuardResult {
  readonly effectivePricePerSqm: number | null;
  readonly debtIncluded: boolean;
  readonly discountVsRenovatedPct: number | null;
  readonly deepDiscount: boolean;
  readonly conditionExplainedPct: number | null;
  readonly conditionCapApplied: boolean;
  readonly residualDrivers: ConfounderId[];
  readonly unknownConfounders: ConfounderId[];
  /**
   * Whether the discount CAN be attributed to condition at all. Because rule
   * 6 below unconditionally records elevator/micro-location/sub-area as
   * unknown this phase, this value is ALWAYS `false` in Phase 14 — that is
   * D-14-05's intended default posture ("cannot attribute to condition",
   * never a silent assumption), and the expression is written so a later
   * phase that supplies those inputs flips it with no shape change.
   */
  readonly canAttributeToCondition: boolean;
  readonly compsThin: boolean;
  readonly confidence: "low" | "medium";
}

/**
 * Implements SPEC §2.6's discount-attribution guard, in this order:
 *
 * 1. Debt-inclusive kr/m² normalization.
 * 2. Discount vs renovated median.
 * 3. Deep-discount trigger (>25% below R_med).
 * 4. Condition attribution (capped at 20% when deep-discount).
 * 5. Residual drivers — the SPECIFIC confounders known to be present.
 * 6. Unknown confounders — confounders that cannot be evaluated this phase.
 * 7. Comps-thin / confidence.
 * 8. canAttributeToCondition — D-14-05's default posture.
 */
export function normalizeForConfounders(
  input: ConfounderGuardInput,
): ConfounderGuardResult {
  const { pricePerSqm, livingArea, floor, balcony, tenureForm, comps, brf } = input;

  // CR-02 (14-REVIEW.md): the SINGLE admission decision for the BRF debt
  // figure, computed once and reused by rules 1/5/6 below. See
  // `brfDebtPerSqmUsable` for the full reasoning — in short, it suppresses an
  // IMPLAUSIBLE reading (a misextraction: total debt read as debt/m², e.g.
  // 480 000 instead of ~8 000, which would push `effectivePricePerSqm` far
  // above `renovatedMedianPerSqm` and silently disable the SPEC §2.6 20% cap)
  // while ADMITTING a high-but-plausible one (a real 30 000 kr/m², which must
  // enter the debt-inclusive basis and be named `brf_debt_high`, or the
  // candidate reads as a bigger bargain than it is — ANL-04 in both
  // directions).
  const debtUsable = brfDebtPerSqmUsable(brf);

  // 1. Debt-inclusive kr/m² normalization (SPEC §2.6 "Normalize kr/m²
  // inclusive of förening debt/m²"). KNOWN ASYMMETRY: the comp side's debt is
  // unknowable from `computeAreaComps` output, so a debt-adjusted candidate
  // is compared against un-adjusted comps — this is why `debtIncluded ===
  // true` forces `confidence: "low"` (rule 7) rather than being presented as
  // a precise figure. An UNTRUSTED debt figure (debtUsable === false) is
  // treated exactly like "no BRF at all" — never admitted into the math.
  let effectivePricePerSqm: number | null;
  let debtIncluded: boolean;
  if (pricePerSqm === null) {
    effectivePricePerSqm = null;
    debtIncluded = false;
  } else if (debtUsable) {
    effectivePricePerSqm = pricePerSqm + brf!.skuldPerKvm!;
    debtIncluded = true;
  } else {
    effectivePricePerSqm = pricePerSqm;
    debtIncluded = false;
  }

  // 2. Discount vs renovated median. A negative value (at/above the median)
  // is returned as-is — never clamped to 0.
  const renovatedMedian = comps?.renovatedMedianPerSqm ?? null;
  const discountVsRenovatedPct =
    effectivePricePerSqm === null ||
    renovatedMedian === null ||
    !Number.isFinite(renovatedMedian) ||
    renovatedMedian <= 0
      ? null
      : (renovatedMedian - effectivePricePerSqm) / renovatedMedian;

  // 3. Deep-discount trigger.
  const deepDiscount =
    discountVsRenovatedPct !== null && discountVsRenovatedPct > DISCOUNT_ATTRIBUTION_TRIGGER_PCT;

  // 4. Condition attribution.
  let conditionExplainedPct: number | null;
  let conditionCapApplied: boolean;
  if (discountVsRenovatedPct === null) {
    conditionExplainedPct = null;
    conditionCapApplied = false;
  } else if (deepDiscount) {
    conditionExplainedPct = MAX_CONDITION_EXPLAINED_PCT;
    conditionCapApplied = true;
  } else {
    conditionExplainedPct = Math.max(0, discountVsRenovatedPct);
    conditionCapApplied = false;
  }

  // 5. residualDrivers — the SPECIFIC confounders KNOWN to be present, in
  // this deterministic order. Never a generic entry.
  const residualDrivers: ConfounderId[] = [];
  if (floor !== null && floor <= 0) residualDrivers.push("bottenvaning");
  if (balcony === false) residualDrivers.push("no_balcony");
  // DESIGN NOTE (CR-02): this rule is REACHABLE through the real extraction
  // pipeline. `HIGH_BRF_DEBT_PER_SQM` (15 000) sits inside
  // `brfDebtPerSqmUsable`'s plausible range (ceiling
  // `IMPLAUSIBLE_BRF_DEBT_PER_SQM` = 60 000), so an extraction-sourced
  // 15k..60k reading — whose confidence `applySanityChecks` pins to 0.2
  // purely for being outside the narrower Stockholm band — is admitted here
  // and named. Only a misextraction above the implausibility ceiling routes
  // to `brf_unknown` (rule 6) instead. Naming "hög föreningsskuld per kvm"
  // for a real high reading is what SPEC §2.2 exists to do; suppressing it
  // was NOT the conservative direction, it made the risky candidate look
  // safer (14-VERIFICATION.md's ANL-04 gap).
  if (debtUsable && brf!.skuldPerKvm! > HIGH_BRF_DEBT_PER_SQM) {
    residualDrivers.push("brf_debt_high");
  }
  if (brf?.tomtratt === true || tomtrattFromTenureForm(tenureForm) === true) {
    residualDrivers.push("tomtratt");
  }
  if (livingArea !== null && (livingArea < ODD_BOA_MIN_SQM || livingArea > ODD_BOA_MAX_SQM)) {
    residualDrivers.push("odd_boa");
  }

  // 6. unknownConfounders — confounders that cannot be evaluated, in this
  // deterministic order. elevator/micro-location/sub-area are ALWAYS
  // unknown this phase (D-14-05: no new scraping, no data source exists).
  const unknownConfounders: ConfounderId[] = [
    "elevator_unknown",
    "micro_location_unknown",
    "sub_area_unknown",
  ];
  if (floor === null) unknownConfounders.push("floor_unknown");
  if (balcony === null) unknownConfounders.push("balcony_unknown");
  // CR-02: an untrusted debt reading is an ABSENCE of usable
  // föreningsekonomi data — D-14-05's posture is that an unevaluable
  // confounder is named as unknown rather than silently dropped. Pushed at
  // most once (brf === null and !debtUsable never both independently push).
  if (brf === null || !debtUsable) unknownConfounders.push("brf_unknown");
  // Per 14-01, tenureForm structurally cannot DISPROVE tomträtt, so anything
  // other than a positive match is unknown, including "Bostadsrätt".
  if (tomtrattFromTenureForm(tenureForm) !== true) unknownConfounders.push("tomtratt_unknown");

  // 7. compsThin / confidence. Never "high" (D-14-04). This expression
  // already requires `debtIncluded === true` for `"medium"`, so an untrusted
  // debt figure automatically keeps the brief at `"low"` — this now follows
  // from the CR-02 gate above rather than by accident.
  const compsThin = comps === null || comps.sampleSize < MIN_COMPS_FOR_CONFIDENCE;
  const confidence: "low" | "medium" =
    comps !== null &&
    comps.confident === true &&
    brf !== null &&
    debtIncluded === true &&
    deepDiscount === false
      ? "medium"
      : "low";

  // 8. canAttributeToCondition — see the doc comment on the result field:
  // because rule 6 unconditionally records elevator/micro-location/sub-area
  // as unknown this phase, `unknownConfounders.length === 0` never holds, so
  // this is ALWAYS `false` in Phase 14. That is the intended default
  // posture; a later phase that supplies those inputs flips it with no
  // shape change.
  const canAttributeToCondition =
    !deepDiscount && unknownConfounders.length === 0 && comps !== null && comps.confident === true;

  return {
    effectivePricePerSqm,
    debtIncluded,
    discountVsRenovatedPct,
    deepDiscount,
    conditionExplainedPct,
    conditionCapApplied,
    residualDrivers,
    unknownConfounders,
    canAttributeToCondition,
    compsThin,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// buildHolisticBrief — the holistic-data-only brief builder (ANL-01)
// ---------------------------------------------------------------------------

/**
 * Case-insensitive patterns that catch a low-price-implies-renovation-object
 * claim in Swedish. The bare catch-all (`/renoveringsobjekt/i`) is
 * deliberately absolute: this phase's briefs must NEVER use the word at all,
 * because the reno CONCLUSION is deferred to Phase 15/16 (SPEC §2.6's
 * closing sentence, "Never render UI text implying 'low kr/m² ⇒ renovation
 * object.'").
 */
export const BANNED_RENO_ATTRIBUTION_PATTERNS: readonly RegExp[] = [
  /l[åa]gt?\s*(kr|pris)[\s/]*kv?m[\s\S]{0,60}renoverings(objekt|behov)/i,
  /renoverings(objekt|behov)[\s\S]{0,60}l[åa]gt?\s*(kr|pris)[\s/]*kv?m/i,
  /under\s+snittet[\s\S]{0,60}renoverings(objekt|behov)/i,
  /renoverings(objekt|behov)[\s\S]{0,60}under\s+snittet/i,
  /renoveringsobjekt/i,
];

/**
 * A hedged Swedish sentence stating that a lower kr/m² is a surfacing signal
 * only and can equally reflect factors that price alone cannot separate.
 * Used as the drop-and-replace fallback when composed text matches any
 * `BANNED_RENO_ATTRIBUTION_PATTERNS` entry.
 */
export const RENO_ATTRIBUTION_FALLBACK_TEXT =
  "Ett lägre pris per kvadratmeter är enbart en signal om att titta närmare — det kan lika gärna bero på våning, hiss, balkong, mikroläge, delområde eller föreningens skuld som på skicket. Ingen slutsats om skick dras här.";

/**
 * CR-02's display counterpart to the `debtUsable` arithmetic gate, split in two
 * by WR-05 (14-REVIEW.md) because the two suppression CAUSES are different
 * facts and only one of them involves a range at all:
 *
 *  - `BRF_OUT_OF_BAND_FIGURE_TEXT` — the value exists but falls outside its
 *    `BRF_SANITY_BANDS` band, i.e. a likely unit/denominator misextraction.
 *    Only `skuldPerKvm` and `avgiftsniva` HAVE a band.
 *  - `BRF_LOW_CONFIDENCE_FIGURE_TEXT` — the value is in-band (or has no band at
 *    all, as `kassaflode` does) and was simply not legible enough. Claiming it
 *    "låg utanför ett rimligt intervall" would state a range check that never
 *    ran — on a surface whose whole premise is `HOLISTIC_DATA_ONLY_MARKER`
 *    ("trust this, it's data"), an unsupported reason is exactly the discipline
 *    violation this phase is built around.
 *
 * Either is appended only for a NON-NULL value that was withheld; a simply-null
 * field is absent data, not a withheld figure. Both keep the item ACTIONABLE
 * (ANL-01) by telling the user what to check.
 */
export const BRF_OUT_OF_BAND_FIGURE_TEXT =
  "En av föreningens siffror låg utanför ett rimligt intervall och visas därför inte här — kontrollera avgift och skuld per kvm i föreningens årsredovisning.";

/** See `BRF_OUT_OF_BAND_FIGURE_TEXT` — the honest wording when no range was checked. */
export const BRF_LOW_CONFIDENCE_FIGURE_TEXT =
  "En av föreningens siffror kunde inte läsas med tillräcklig säkerhet och visas därför inte här — kontrollera den i föreningens årsredovisning.";

/**
 * Whether `value` falls outside `field`'s plausible band. `false` when the
 * field has NO band (`kassaflode`) — the absence of a band is precisely why
 * such a figure must never be reported as "out of range" (WR-05).
 */
function brfFigureOutOfBand(field: BrfConfidenceField, value: number): boolean {
  // `Object.hasOwn`, not `in`: `in` walks the prototype chain (WR-06's class of
  // defect). `field` is a bounded union today, so this is defence-in-depth.
  if (!Object.hasOwn(BRF_SANITY_BANDS, field)) return false;
  const band = BRF_SANITY_BANDS[field as keyof typeof BRF_SANITY_BANDS];
  return value < band.min || value > band.max;
}

/**
 * CR-03: `stambytePlanerat` is a bounded enum keyed to `brfExtractionSchema`
 * (`src/lib/schemas/brf.ts`) / the extraction prompt (`prompt.ts:36-40`), NOT
 * free-form prose — concatenating it verbatim leaked the raw token into
 * buyer-facing Swedish. `"ej_nämnt"` maps to `null` deliberately: per
 * `prompt.ts:40` it means the document does NOT mention stambyte at all, so
 * rendering it would present an ABSENCE of information as an information
 * item — padding a brief whose entire purpose (ANL-01) is at least one
 * ACTIONABLE item.
 *
 * WR-06 (14-REVIEW.md): a `Map`, NOT an object literal. `BrfSummary
 * .stambytePlanerat` is read from persisted JSONB, and an object-literal lookup
 * keyed by an unconstrained string resolves `Object.prototype` members —
 * `STAMBYTE_PROSE["toString"]` returned `Function.prototype.toString`, which is
 * not nullish, so `?? null` never fired and the FUNCTION SOURCE would have been
 * `join(" ")`-ed into buyer-facing Swedish prose. `Map.get` has no prototype
 * chain to fall through, so the fail-closed claim above actually holds.
 */
export const STAMBYTE_PROSE: ReadonlyMap<string, string | null> = new Map([
  ["planerat", "Föreningen har ett planerat stambyte."],
  ["nyligen_genomfort", "Föreningen har nyligen genomfört stambyte."],
  ["ej_nämnt", null],
]);

export interface BuildHolisticBriefInput {
  readonly guard: ConfounderGuardResult;
  readonly comps: AreaCompsSummary | null;
  readonly brf: BrfSummary | null;
  /**
   * The candidate's own kr/m². WR-10 (14-REVIEW.md): this used to be written by
   * `job.ts` and read by NOBODY — `buildCompsPositioningItem` emitted the sample
   * size and the two medians but never the candidate's own position, so a
   * "positioning" item did not position. It is now consumed there.
   */
  readonly pricePerSqm: number | null;
  /**
   * The candidate's boarea in m², used ONLY to derive a monthly avgift from
   * the SEK/m²/år `avgiftsniva` (CR-01) — never for anything else here.
   */
  readonly livingArea: number | null;
}

function confounderLabel(id: ConfounderId): string {
  switch (id) {
    case "bottenvaning":
      return "bottenvåning";
    case "no_balcony":
      return "ingen balkong";
    case "brf_debt_high":
      return "hög föreningsskuld per kvm";
    case "tomtratt":
      return "tomträtt";
    case "odd_boa":
      return "ovanlig boarea";
    case "elevator_unknown":
      return "hiss (okänt)";
    case "micro_location_unknown":
      return "mikroläge (okänt)";
    case "brf_unknown":
      return "föreningens ekonomi (okänt)";
    case "balcony_unknown":
      return "balkong (okänt)";
    case "floor_unknown":
      return "våning (okänt)";
    case "tomtratt_unknown":
      return "tomträtt (okänt)";
    case "sub_area_unknown":
      return "delområde (okänt)";
  }
}

/**
 * Exported (was module-private) per CR-03: after this fix no pipeline field
 * carries free-form prose into a brief item, so the drop-and-replace
 * enforcement branch can no longer be reached through a fixture and must be
 * proven directly. Behaviour is unchanged.
 */
export function applyBannedAttributionGuard(text: string): string {
  const isBanned = BANNED_RENO_ATTRIBUTION_PATTERNS.some((pattern) => pattern.test(text));
  return isBanned ? RENO_ATTRIBUTION_FALLBACK_TEXT : text;
}

function buildCompsPositioningItem(input: BuildHolisticBriefInput): HolisticBriefItem | null {
  const { guard, comps, pricePerSqm } = input;
  if (comps === null || guard.discountVsRenovatedPct === null) return null;

  const parts: string[] = [];
  // WR-10: state the candidate's OWN kr/m² when known — an item called
  // "comps-positioning" that never names the thing being positioned is not a
  // positioning item. Falls back to the previous wording when `pricePerSqm` is
  // null, so nothing is fabricated.
  const sampleClause =
    `${comps.sampleSize} sålda jämförelseobjekt` + (comps.widenedBand ? " (brett urval)" : "");
  if (pricePerSqm !== null && Number.isFinite(pricePerSqm)) {
    parts.push(`Priset ligger på ca ${Math.round(pricePerSqm)} kr/kvm och jämförs mot ${sampleClause}.`);
  } else {
    parts.push(`Priset per kvadratmeter ligger mot ett urval av ${sampleClause}.`);
  }
  if (comps.renovatedMedianPerSqm !== null) {
    parts.push(
      `Median för nyare/renoverade objekt verkar ligga kring ${Math.round(comps.renovatedMedianPerSqm)} kr/kvm.`,
    );
  }
  if (comps.unrenovatedMedianPerSqm !== null) {
    parts.push(
      `Median för äldre/orenoverade objekt verkar ligga kring ${Math.round(comps.unrenovatedMedianPerSqm)} kr/kvm.`,
    );
  }
  // WR-10: the actual position against the renovated median — the single most
  // decision-relevant number the guard computes, previously never surfaced.
  // Uses `effectivePricePerSqm` implicitly (the discount is computed from it),
  // so a debt-inclusive basis is reflected here rather than the raw asking
  // kr/m². Deliberately states no conclusion about SKICK (SPEC §2.6).
  if (guard.discountVsRenovatedPct !== null) {
    const pct = Math.round(Math.abs(guard.discountVsRenovatedPct) * 100);
    parts.push(
      guard.discountVsRenovatedPct >= 0
        ? `Det är ca ${pct}% under medianen för nyare/renoverade objekt.`
        : `Det är ca ${pct}% över medianen för nyare/renoverade objekt.`,
    );
  }

  if (guard.canAttributeToCondition === false) {
    // WR-07 (14-REVIEW.md): state the POSITION here and defer the naming to
    // `buildConfounderItems`, which emits the same two lists as its own items.
    // Naming them in both places repeated "hiss (okänt), mikroläge (okänt),
    // delområde (okänt), …" verbatim in adjacent bullets of every brief with
    // comps — and since `canAttributeToCondition` is always false this phase,
    // that duplication was unconditional. ANL-01's criterion is >=1 ACTIONABLE
    // item; a verbatim duplicate degrades exactly that.
    parts.push(
      "Skillnaden kan bero på skick, men kan lika gärna bero på faktorer som priset ensamt inte kan skilja ut (se nedan).",
    );
  }

  if (guard.deepDiscount) {
    parts.push(
      `Högst ${Math.round(MAX_CONDITION_EXPLAINED_PCT * 100)}% av skillnaden tillskrivs skick här — resten tillskrivs de nämnda faktorerna.`,
    );
  }

  return { kind: "comps-positioning", text: parts.join(" ") };
}

function buildConfounderItems(guard: ConfounderGuardResult): HolisticBriefItem[] {
  const items: HolisticBriefItem[] = [];
  if (guard.residualDrivers.length > 0) {
    items.push({
      kind: "confounder",
      text: `Kända faktorer som kan förklara delar av prisbilden: ${guard.residualDrivers.map(confounderLabel).join(", ")}.`,
    });
  }
  items.push({
    kind: "confounder",
    text: `Hiss och mikroläge hämtas inte i den här analysen och kan därför inte uteslutas: ${guard.unknownConfounders.map(confounderLabel).join(", ")}.`,
  });
  return items;
}

function buildBrfItem(brf: BrfSummary | null, livingArea: number | null): HolisticBriefItem | null {
  if (brf === null) return null;
  const parts: string[] = [];
  // CR-02: each numeric sentence is gated before display — a sanity-rejected
  // figure is never shown as a normal reading (T-14-42). WR-05: a suppressed
  // NON-NULL value records WHY it was withheld, so the hedge sentence states a
  // true reason instead of always claiming a range check that may never have
  // run. A simply-null field is absent data, not a withheld figure, and
  // triggers no hedge at all.
  let outOfBandSuppressed = false;
  let lowConfidenceSuppressed = false;
  const recordSuppressed = (field: BrfConfidenceField, value: number): void => {
    if (brfFigureOutOfBand(field, value)) outOfBandSuppressed = true;
    else lowConfidenceSuppressed = true;
  };
  if (brf.avgiftsniva !== null) {
    if (brfFieldTrusted(brf, "avgiftsniva")) {
      // CR-01: `avgiftsniva` is SEK/m² PER YEAR (prompt.ts:29, sanity.ts:27's
      // 300-1200 band, score.ts:15's ~550-750 healthy middle) — NEVER a
      // monthly figure. The ONLY per-month figure this module may ever emit
      // is one DERIVED as avgiftsniva * livingArea / 12 (see the clause
      // below); the raw field itself must never be relabelled per-month
      // (the ~6x understatement CR-01 fixes).
      if (livingArea === null || !Number.isFinite(livingArea) || livingArea <= 0) {
        parts.push(`Årsavgiften ligger kring ${Math.round(brf.avgiftsniva)} kr/kvm och år.`);
      } else {
        parts.push(
          `Årsavgiften ligger kring ${Math.round(brf.avgiftsniva)} kr/kvm och år ` +
            `(motsvarar ca ${Math.round((brf.avgiftsniva * livingArea) / 12)} kr/mån för ${Math.round(livingArea)} kvm).`,
        );
      }
    } else {
      recordSuppressed("avgiftsniva", brf.avgiftsniva);
    }
  }
  if (brf.skuldPerKvm !== null) {
    // CR-02: gated on `brfDebtPerSqmUsable`, NOT `brfFieldTrusted` — the same
    // gate rules 1/5 use, so display and math can never disagree about the
    // same figure. A real 20-40k kr/m² debt renders as FACT carrying the
    // "(högre än vanligt)" flag (SPEC §2.2's red flag, which is the whole
    // point of surfacing it); only a misextraction above
    // `IMPLAUSIBLE_BRF_DEBT_PER_SQM` is withheld and hedged.
    if (brfDebtPerSqmUsable(brf)) {
      const flag = brf.skuldPerKvm > HIGH_BRF_DEBT_PER_SQM ? " (högre än vanligt)" : "";
      parts.push(`Föreningens skuld per kvm verkar ligga kring ${Math.round(brf.skuldPerKvm)} kr/kvm${flag}.`);
    } else {
      // A suppressed debt figure is ALWAYS an implausible reading now
      // (`brfDebtPerSqmUsable` admits every plausible one), which is an
      // out-of-range fact — never the low-confidence wording.
      outOfBandSuppressed = true;
    }
  }
  if (brf.kassaflode !== null) {
    if (brfFieldTrusted(brf, "kassaflode")) {
      parts.push(`Kassaflödet verkar ligga kring ${Math.round(brf.kassaflode)} kr.`);
    } else {
      // WR-05: `kassaflode` has NO BRF_SANITY_BANDS entry — `run-extraction.ts`
      // passes its model confidence through untouched — so a suppression here
      // can only ever mean "not legible enough", never "out of range".
      recordSuppressed("kassaflode", brf.kassaflode);
    }
  }
  // CR-03: lookup through STAMBYTE_PROSE rather than concatenating the raw
  // enum, so no unmapped token can reach user-facing prose and "ej_nämnt"
  // correctly produces no sentence at all. WR-06: the lookup is a `Map.get`,
  // which — unlike the object-literal indexing this used to be — cannot
  // resolve an `Object.prototype` member for a drifted persisted value.
  const stambyteProse =
    brf.stambytePlanerat === null ? null : STAMBYTE_PROSE.get(brf.stambytePlanerat) ?? null;
  if (stambyteProse !== null) parts.push(stambyteProse);
  if (brf.tomtratt === true) parts.push("Föreningen har tomträtt.");
  if (brf.fiscalYear !== null) parts.push(`Siffrorna kommer från räkenskapsåret ${brf.fiscalYear}.`);
  // WR-05: state each cause that actually occurred, out-of-band first. Both can
  // fire in one brief (e.g. a misextracted debt AND an illegible kassaflöde).
  if (outOfBandSuppressed) parts.push(BRF_OUT_OF_BAND_FIGURE_TEXT);
  if (lowConfidenceSuppressed) parts.push(BRF_LOW_CONFIDENCE_FIGURE_TEXT);
  if (parts.length === 0) return null;
  return { kind: "brf", text: parts.join(" ") };
}

/**
 * Builds the holistic-data-only opportunity brief (D-14-03) that fills in
 * for an empty `claims: []` vision result. GUARANTEE: `items.length >= 1`
 * for every possible input (ANL-01) — enforced as an explicit
 * post-composition check, never an implicit consequence. Mirrors
 * `vision.ts`'s banned-word ordering discipline: the RAW composed text is
 * inspected first, then replaced with a safe fallback.
 */
export function buildHolisticBrief(input: BuildHolisticBriefInput): HolisticBrief {
  const { guard, comps, brf, livingArea } = input;

  const dataSources: Array<"comps" | "brf" | "hedonic"> = [];
  if (comps !== null) dataSources.push("comps");
  if (brf !== null) dataSources.push("brf");
  dataSources.push("hedonic");

  const items: HolisticBriefItem[] = [];
  const compsItem = buildCompsPositioningItem(input);
  if (compsItem !== null) items.push(compsItem);
  // The confounder items only make sense attached to SOME data source —
  // with neither comps nor a BRF summary there is nothing for the hedonic
  // reasoning to relate to, so they are skipped here and the
  // "insufficient-data" fallback below takes over instead of a confounder
  // item that names unknowns about nothing.
  if (comps !== null || brf !== null) {
    items.push(...buildConfounderItems(guard));
  }
  const brfItem = buildBrfItem(brf, livingArea);
  if (brfItem !== null) items.push(brfItem);

  // GUARANTEE (ANL-01): items.length >= 1 for every possible input.
  if (items.length === 0) {
    items.push({
      kind: "insufficient-data",
      text:
        "Det finns inte tillräckligt med områdesdata för den här annonsen just nu. " +
        "Kontrollera själv avgift, skuld per kvm och senaste slutpriser i området innan du drar slutsatser.",
    });
  }

  // BANNED-ATTRIBUTION ENFORCEMENT: check the RAW text of every item —
  // including "insufficient-data" — and drop-and-replace on any match.
  const guardedItems = items.map((item) => ({
    ...item,
    text: applyBannedAttributionGuard(item.text),
  }));

  return {
    marker: HOLISTIC_DATA_ONLY_MARKER,
    confidence: guard.confidence,
    items: guardedItems,
    dataSources,
    conditionAttribution: {
      // WR-08 (14-REVIEW.md): a persisted record must not simultaneously say
      // "cannot attribute to condition" and "here is the fraction attributable
      // to condition". `canAttributeToCondition` is unconditionally false this
      // phase (rule 6 always records three unknowns), so a positive
      // `explainedPct` alongside it was self-contradicting, and a Phase 15/16
      // consumer reading `explainedPct` has no reason to also check the flag.
      // No information is lost: `capped` plus the exported
      // `MAX_CONDITION_EXPLAINED_PCT` fully determine the capped value.
      explainedPct: guard.canAttributeToCondition ? guard.conditionExplainedPct : null,
      capped: guard.conditionCapApplied,
      residualDrivers: guard.residualDrivers,
      canAttributeToCondition: guard.canAttributeToCondition,
    },
  };
}
