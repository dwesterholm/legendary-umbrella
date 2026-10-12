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
 * CLASSIFICATION (14.1-06, FIT-04): {@link renoEstimateFromVision} reads the
 * free-text vision claims the Anthropic pass already persists and sorts each of
 * kitchen / bathroom / overall into fresh / ok / dated with a handful of
 * regexes. No model output is trusted as a number: the cost always comes from
 * `RENO_COST_MATRIX`. The vocabulary is shared with `condition-score.ts` (its
 * DATED / RENOVATED regexes are imported, not copied). No schema change to the
 * Anthropic output was made (RESEARCH Pattern 3 option B rejected; revisit only
 * if the live run shows more than 20 % of claims misclassified).
 */

import { DATED, RENOVATED } from "@/lib/discovery/condition-score";
import type { VisionConditionClaim, VisionResult } from "@/lib/discovery/vision-schema";
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

/**
 * Prices one set of per-attribute states into a {@link RenoEstimate}. `band`
 * defaults to {@link RENO_BAND}; an item that lists the band as invalid steps
 * up to the next tier. `source` is set by the caller that knows where the
 * states came from.
 */
export function renoBundle(
  states: Readonly<Record<RenoAttribute, RenoState>>,
  band: CostTier = RENO_BAND,
  source: "vision" | "none" = "none",
): RenoEstimate {
  let lowSek = 0;
  let highSek = 0;
  const attributes: readonly RenoAttribute[] = ["kitchen", "bathroom", "overall"];
  for (const attribute of attributes) {
    for (const { item, band: itemBand } of RENO_BUNDLE_ITEMS[attribute][states[attribute]]) {
      const [lo, hi] = RENO_COST_MATRIX[item][usableTier(item, itemBand ?? band)];
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
 * Negated renovation: "orenoverat", "ej renoverat", "inte renoverat", "verkar
 * inte renoverat", "inte ut att vara renoverat". Up to three words may sit
 * between the negation and the verb, but never a sentence boundary, so
 * "Ej synliga skador. Nyrenoverat kök" is not negated. Checked BEFORE the
 * shared RENOVATED regex, which would read the "renoverat" inside as fresh.
 */
export const NEGATED_RENOVATION: RegExp =
  /\borenover(?:at|ad|ade)|\b(?:ej|inte|icke|aldrig)\s+(?:[^\s.,;:!?]+\s+){0,3}\S*?renover(?:at|ad|ade|ats)/i;

/**
 * "No renovation need": "inget (uppenbart) renoveringsbehov", "utan
 * renoveringsbehov", "ej något renoveringsbehov". Checked first because the
 * shared DATED regex treats the bare word "renoveringsbehov" as dated.
 */
export const NO_RENOVATION_NEED: RegExp =
  /\b(?:inget|ingen|inga|utan|(?:inte|ej)(?:\s+(?:något|några))?)\s+(?:[^\s.,;:!?]+\s+)?renoveringsbehov/i;

/**
 * Inflected forms of the dated vocabulary that the shared DATED regex (written
 * for a display tiebreaker) does not match. Kept here, not added to DATED, so
 * `conditionScore` behaves exactly as before.
 */
const DATED_EXTRA = /slitna|nedslitna|utslitna|daterade|omoderna|ursprungliga/i;

/** One claim's text as fresh / ok / dated. Order: no-need, negation, dated, renovated, else ok. */
export function classifyClaimText(text: string): Exclude<RenoState, "unknown"> {
  if (NO_RENOVATION_NEED.test(text)) return "ok";
  if (NEGATED_RENOVATION.test(text)) return "dated";
  if (DATED.test(text) || DATED_EXTRA.test(text)) return "dated";
  if (RENOVATED.test(text)) return "fresh";
  return "ok";
}

const STATE_SEVERITY: Readonly<Record<Exclude<RenoState, "unknown">, number>> = {
  fresh: 0,
  ok: 1,
  dated: 2,
};

/**
 * The state of one attribute from all claims about it. Worst state wins
 * (dated > ok > fresh) so a cost is never understated. No claim about the
 * attribute is "unknown", never "fresh". `remodelPotential` claims are not an
 * attribute here and add no cost (D-04).
 */
export function classifyAttribute(
  claims: readonly VisionConditionClaim[],
  attribute: RenoAttribute,
): RenoState {
  let worst: Exclude<RenoState, "unknown"> | null = null;
  for (const c of claims) {
    if (c.attribute !== attribute) continue;
    const state = classifyClaimText(`${c.claim} ${c.whatWasSeen}`);
    if (worst === null || STATE_SEVERITY[state] > STATE_SEVERITY[worst]) worst = state;
  }
  return worst ?? "unknown";
}

/**
 * Reno estimate from a vision read. Null vision, or a read with no claims,
 * gives the unknown bundle with source "none". Claims under the persisted 0.6
 * confidence bar never reach here, so no confidence filter is added.
 */
export function renoEstimateFromVision(vision: VisionResult | null): RenoEstimate {
  if (!vision || vision.claims.length === 0) return renoBundle(UNKNOWN_RENO_STATES, RENO_BAND, "none");
  const states: Record<RenoAttribute, RenoState> = {
    kitchen: classifyAttribute(vision.claims, "kitchen"),
    bathroom: classifyAttribute(vision.claims, "bathroom"),
    overall: classifyAttribute(vision.claims, "overall"),
  };
  return renoBundle(states, RENO_BAND, "vision");
}
