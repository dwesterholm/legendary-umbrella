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
import {
  tomtrattFromTenureForm,
  type AreaCompsSummary,
  type BrfSummary,
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

  // 1. Debt-inclusive kr/m² normalization (SPEC §2.6 "Normalize kr/m²
  // inclusive of förening debt/m²"). KNOWN ASYMMETRY: the comp side's debt is
  // unknowable from `computeAreaComps` output, so a debt-adjusted candidate
  // is compared against un-adjusted comps — this is why `debtIncluded ===
  // true` forces `confidence: "low"` (rule 7) rather than being presented as
  // a precise figure.
  let effectivePricePerSqm: number | null;
  let debtIncluded: boolean;
  if (pricePerSqm === null) {
    effectivePricePerSqm = null;
    debtIncluded = false;
  } else if (
    brf?.skuldPerKvm !== null &&
    brf?.skuldPerKvm !== undefined &&
    Number.isFinite(brf.skuldPerKvm)
  ) {
    effectivePricePerSqm = pricePerSqm + brf.skuldPerKvm;
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
  if (
    brf?.skuldPerKvm !== null &&
    brf?.skuldPerKvm !== undefined &&
    Number.isFinite(brf.skuldPerKvm) &&
    brf.skuldPerKvm > HIGH_BRF_DEBT_PER_SQM
  ) {
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
  if (brf === null) unknownConfounders.push("brf_unknown");
  // Per 14-01, tenureForm structurally cannot DISPROVE tomträtt, so anything
  // other than a positive match is unknown, including "Bostadsrätt".
  if (tomtrattFromTenureForm(tenureForm) !== true) unknownConfounders.push("tomtratt_unknown");

  // 7. compsThin / confidence. Never "high" (D-14-04).
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
