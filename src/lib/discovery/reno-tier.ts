/**
 * reno-tier.ts - renovation-cost bundles for the fit score (Phase 14.1, R-01):
 * turns a condition state per attribute (kitchen, bathroom, overall) into one
 * cost estimate with a low-mid-high range, priced from `RENO_COST_MATRIX`.
 *
 * PURE, synchronous - no clock, no randomness, no network, no async, no file or
 * environment access. Same input, same output.
 *
 * STRUCTURAL SEPARATION (LOCKED): like `flip-economics.ts` this module sits on
 * the vision/analysis path. `niche-score.ts` and `report/flags.ts` must NEVER
 * import it; the static-grep invariant in `niche-score.test.ts` enforces that
 * and this module's specifier is registered there.
 *
 * HONESTY RULE: a flat the pictures were not read for is "unknown", never
 * "fresh" and never "dated". Unknown is priced as the cosmetic mid bundle
 * (105 000 kr) and flagged by the caller, so a missing image read cannot make a
 * flat look like a free bargain or a money pit.
 *
 * In this plan the classifier is a stub: {@link renoEstimateFromVision} returns
 * the unknown bundle for every input. 14.1-06 adds claim classification behind
 * the same signature.
 */

import type { VisionResult } from "@/lib/discovery/vision-schema";
import {
  RENO_COST_MATRIX,
  type CostTier,
  type RenoOpportunity,
} from "@/lib/discovery/flip-economics";

export type RenoAttribute = "kitchen" | "bathroom" | "overall";
export type RenoState = "fresh" | "ok" | "dated" | "unknown";

/**
 * Price band every bundle item is read from. "mid" (R-01): the "high" band
 * would price a 35 m2 reno near 1 Mkr and erase every reno object. Change here
 * to re-price everything; an item whose `invalidTiers` lists the band steps up.
 */
export const RENO_BAND: CostTier = "mid";

interface BundleItem {
  readonly item: RenoOpportunity;
  /** Overrides {@link RENO_BAND} for this item (a fresh flat only needs a cheap touch-up). */
  readonly band?: CostTier;
}

/**
 * The bundle for each attribute and state. Empty list = nothing to spend.
 * Totals at the mid band: all fresh 10 000, all unknown 105 000, all dated
 * 427 500 kr.
 */
export const RENO_BUNDLE_ITEMS: Readonly<
  Record<RenoAttribute, Readonly<Record<RenoState, readonly BundleItem[]>>>
> = {
  kitchen: {
    fresh: [],
    ok: [{ item: "kitchen-cosmetic" }],
    dated: [{ item: "kitchen-full" }],
    unknown: [{ item: "kitchen-cosmetic" }],
  },
  bathroom: {
    fresh: [],
    ok: [{ item: "bathroom-cosmetic" }],
    dated: [{ item: "bathroom-full" }],
    unknown: [{ item: "bathroom-cosmetic" }],
  },
  overall: {
    fresh: [{ item: "paint-apartment", band: "cheap" }],
    ok: [{ item: "paint-apartment" }],
    dated: [{ item: "paint-apartment" }, { item: "floors" }],
    unknown: [{ item: "paint-apartment" }],
  },
};

export interface RenoEstimate {
  readonly states: Readonly<Record<RenoAttribute, RenoState>>;
  /** Sum of band midpoints: the number the profit uses. */
  readonly midSek: number;
  /** Sum of band lower ends. */
  readonly lowSek: number;
  /** Sum of band upper ends. */
  readonly highSek: number;
  /** "low" all fresh, "mid" all unknown, "high" all dated, otherwise "mixed". */
  readonly tier: "low" | "mid" | "high" | "mixed";
  readonly anyDated: boolean;
  readonly anyUnknown: boolean;
  /** "vision" when a picture read produced the states, "none" when it did not. */
  readonly source: "vision" | "none";
}

/** Every attribute unknown: the estimate for a flat nobody has looked at. */
export const UNKNOWN_RENO_STATES: Readonly<Record<RenoAttribute, RenoState>> = {
  kitchen: "unknown",
  bathroom: "unknown",
  overall: "unknown",
};

const TIER_UP: Readonly<Record<CostTier, CostTier>> = { cheap: "mid", mid: "high", high: "high" };

/** The requested tier, or the next one up while the item lists it as invalid. */
function usableTier(item: RenoOpportunity, requested: CostTier): CostTier {
  const invalid = RENO_COST_MATRIX[item].invalidTiers ?? [];
  let tier = requested;
  while (invalid.includes(tier) && TIER_UP[tier] !== tier) tier = TIER_UP[tier];
  return tier;
}

/** Prices one set of per-attribute states into a {@link RenoEstimate}. */
export function renoBundle(
  states: Readonly<Record<RenoAttribute, RenoState>>,
  source: "vision" | "none" = "none",
): RenoEstimate {
  let lowSek = 0;
  let highSek = 0;
  const attributes: readonly RenoAttribute[] = ["kitchen", "bathroom", "overall"];
  for (const attribute of attributes) {
    for (const { item, band } of RENO_BUNDLE_ITEMS[attribute][states[attribute]]) {
      const [lo, hi] = RENO_COST_MATRIX[item][usableTier(item, band ?? RENO_BAND)];
      lowSek += lo;
      highSek += hi;
    }
  }
  // Midpoint of a sum of ranges equals the sum of midpoints.
  const midSek = (lowSek + highSek) / 2;

  const values = attributes.map((a) => states[a]);
  const all = (s: RenoState) => values.every((v) => v === s);
  const tier = all("fresh") ? "low" : all("unknown") ? "mid" : all("dated") ? "high" : "mixed";

  return {
    states,
    midSek,
    lowSek,
    highSek,
    tier,
    anyDated: values.includes("dated"),
    anyUnknown: values.includes("unknown"),
    source,
  };
}

/**
 * Reno estimate from a vision read. Stub in 14.1-03: every input, including
 * null, yields the unknown bundle with source "none". 14.1-06 classifies the
 * claims behind this same signature.
 */
export function renoEstimateFromVision(vision: VisionResult | null): RenoEstimate {
  void vision; // not read until 14.1-06 classifies the claims
  return renoBundle(UNKNOWN_RENO_STATES, "none");
}
