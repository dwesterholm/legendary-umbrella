import type { SoldComp } from "@/lib/market/sold-schema";

// Re-export the canonical SoldComp so consumers (and compare.test.ts) can import
// the comparison's input type from the comparator itself.
export type { SoldComp } from "@/lib/market/sold-schema";

/**
 * compare.ts — the PRICE-01 deterministic comparison engine.
 *
 * The trust core (D-08/D-09, mirrors `src/lib/brf/score.ts`): a single exported
 * config const, small pure helpers, one pure entry function, an auditable result
 * interface. NO `Date`-as-now / `Math.random` / network — same input → same
 * output. The ±%, trend, distribution, tier label and confidence are arithmetic,
 * NEVER an LLM (D-09 trust model). This is a *statistical comparison*, not a
 * valuation verdict — there is deliberately NO verdict/valuation field.
 */

/**
 * The single source of truth for every threshold the comparison uses. The
 * methodology page ("Så räknar vi", D-09) imports this exact constant — the
 * numbers are NOT duplicated anywhere else (score.ts:25-57 pattern).
 *
 * `thinMaxComps`: at or below this many *usable* comps the sample is too small
 * to trust → reason "thin", low confidence (D-08). The compare RED tests pin
 * 2 comps as thin and 5 as ok, so the boundary is 2.
 *
 * `confidence`: confidence is driven by sample size + tier (D-09), never model
 * output. A larger usable sample raises it; a broader (less specific) tier
 * lowers it via `tierFactor`. The bands map a usable-comp count to a base
 * confidence; the tier factor scales it.
 */
export const PRICE_COMPARISON_THRESHOLDS = {
  /** ≤ this many usable comps → reason "thin" (D-08). */
  thinMaxComps: 2,
  /** 24-month comparison window in days (D-02) — comps older are de-weighted. */
  windowDays: 730,
  confidence: {
    /** usable-comp count → base confidence (monotonic, clamped to [0,1]). */
    sampleBands: [
      { minComps: 12, base: 0.9 },
      { minComps: 8, base: 0.8 },
      { minComps: 5, base: 0.65 },
      { minComps: 3, base: 0.45 },
      { minComps: 1, base: 0.3 },
      { minComps: 0, base: 0.0 },
    ],
    /** tier specificity → multiplier (a more specific tier is more confident). */
    tierFactor: {
      building: 1.0,
      neighborhood: 0.85,
      wide: 0.65,
    },
  },
} as const;

/** The tier the comps were drawn from (D-01 fallback ladder). */
export type PriceTier = "building" | "neighborhood" | "wide";

/**
 * The honest-state discriminator on a comparison result. compare.ts only ever
 * sets `ok` | `thin` | `listing_pris_okand`; `source_unavailable` is owned by
 * Plan 05's catch around the fetch (a dead source is never conflated with a
 * genuinely-thin area — HIGH-1).
 */
export type PriceComparisonReason = "ok" | "thin" | "listing_pris_okand";

/**
 * The deterministic comparison result. All headline figures are nullable so a
 * non-`ok` state omits them honestly (never a false -100 % — HIGH-3 — and never
 * a NaN areaAvg — the areaAvg-NaN guard). NO valuation/verdict field (D-09).
 */
export interface PriceComparison {
  /** Mean pris/kvm over the usable comps; null when no usable sample. */
  areaAvg: number | null;
  /** Listing ±% vs areaAvg (D-04); null unless reason is "ok". */
  deltaPct: number | null;
  /** Distribution min pris/kvm over usable comps (D-05); null when none. */
  min: number | null;
  /** Distribution max pris/kvm over usable comps (D-05); null when none. */
  max: number | null;
  /** 24-mo least-squares slope of pris/kvm over sale dates (D-02); null when not computable. */
  trendSlope: number | null;
  /** Number of usable comps (finite pris/kvm > 0) the figures are based on. */
  sampleSize: number;
  /** The tier the comps came from, echoed through (D-01). */
  tier: PriceTier;
  /** Confidence in [0,1] from sample size + tier (D-09), NOT model output. */
  confidence: number;
  /** Honest-state discriminator (HIGH-1/HIGH-3). */
  reason: PriceComparisonReason;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Returns the usable comps: those with a finite pris/kvm > 0. */
function usableCompsOf(comps: SoldComp[]): SoldComp[] {
  return comps.filter(
    (c) => typeof c.prisPerKvm === "number" && Number.isFinite(c.prisPerKvm) && c.prisPerKvm > 0,
  );
}

/** Confidence from usable-comp count + tier (D-09). Pure, clamped to [0,1]. */
function computeConfidence(usableCount: number, tier: PriceTier): number {
  const { sampleBands, tierFactor } = PRICE_COMPARISON_THRESHOLDS.confidence;
  const band = sampleBands.find((b) => usableCount >= b.minComps);
  const base = band ? band.base : 0;
  const factor = tierFactor[tier];
  const confidence = base * factor;
  return Math.min(1, Math.max(0, confidence));
}

/**
 * Least-squares slope of pris/kvm regressed on sale time (D-02), in kr/m² per
 * day. Pure: parses each comp's `soldDate` (parsing a stored date is fine — it
 * is NOT a "now" read). Returns null when fewer than two dated, usable points
 * exist or the time span is degenerate (guards a divide-by-zero → never NaN).
 */
function computeTrendSlope(usable: SoldComp[]): number | null {
  const points: { x: number; y: number }[] = [];
  for (const c of usable) {
    if (!c.soldDate || c.prisPerKvm == null) continue;
    const t = Date.parse(c.soldDate);
    if (!Number.isFinite(t)) continue;
    points.push({ x: t, y: c.prisPerKvm });
  }
  if (points.length < 2) return null;

  // Rescale x from ms to days so the slope is in kr/m² per day (readable units).
  const MS_PER_DAY = 86_400_000;
  const xs = points.map((p) => p.x / MS_PER_DAY);
  const ys = points.map((p) => p.y);
  const n = points.length;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    num += dx * (ys[i] - meanY);
    den += dx * dx;
  }
  if (den === 0) return null; // all comps on the same day → no slope
  const slope = num / den;
  return Number.isFinite(slope) ? slope : null;
}

// ---------------------------------------------------------------------------
// Entry function
// ---------------------------------------------------------------------------

/**
 * Computes the deterministic price comparison for a listing against its area's
 * sold comps. Pure (no Date-as-now / Math.random / network) — same input always
 * yields the same result.
 *
 * Guards are ordered FIRST (the headline-poisoning bugs):
 *  1. listingPrisPerKvm null or ≤ 0 → reason "listing_pris_okand", deltaPct null
 *     (NEVER a false "-100 % under snitt" — HIGH-3).
 *  2. 0 usable comps (all pris/kvm null) → reason "thin", deltaPct null, areaAvg
 *     null (NEVER divide-by-zero / NaN — the areaAvg-NaN guard).
 *  3. ≤ thinMaxComps usable → reason "thin", low confidence, still returns the
 *     computable figures, never throws (D-08).
 *  4. otherwise reason "ok": deltaPct, distribution, trend, sample size, tier,
 *     and a sample+tier-driven confidence.
 *
 * @param input - the listing's pris/kvm, the tier-filtered comps, and the tier
 * @returns the deterministic comparison (statistics, never a valuation verdict)
 */
export function computePriceComparison(input: {
  listingPrisPerKvm: number;
  comps: SoldComp[];
  tier: PriceTier;
}): PriceComparison {
  const { listingPrisPerKvm, comps, tier } = input;

  const usable = usableCompsOf(comps);
  const usableCount = usable.length;
  const confidence = computeConfidence(usableCount, tier);

  // areaAvg over the usable sample (guarded: null when no usable comps → no NaN).
  const areaAvg =
    usableCount > 0
      ? usable.reduce((s, c) => s + (c.prisPerKvm as number), 0) / usableCount
      : null;

  // GUARD 1 (HIGH-3): the listing's own pris/kvm is unknown/0 → no ±% headline.
  if (
    listingPrisPerKvm == null ||
    !Number.isFinite(listingPrisPerKvm) ||
    listingPrisPerKvm <= 0
  ) {
    return {
      areaAvg,
      deltaPct: null,
      min: null,
      max: null,
      trendSlope: null,
      sampleSize: usableCount,
      tier,
      confidence: Math.min(confidence, 0.3),
      reason: "listing_pris_okand",
    };
  }

  // GUARD 2 (areaAvg-NaN) + GUARD 3 (D-08 thin): no usable / too-thin sample.
  if (usableCount === 0 || usableCount <= PRICE_COMPARISON_THRESHOLDS.thinMaxComps) {
    const prices = usable.map((c) => c.prisPerKvm as number);
    return {
      areaAvg, // null when usableCount === 0 — guarded, never NaN
      deltaPct: null,
      min: prices.length ? Math.min(...prices) : null,
      max: prices.length ? Math.max(...prices) : null,
      trendSlope: computeTrendSlope(usable),
      sampleSize: usableCount,
      tier,
      confidence,
      reason: "thin",
    };
  }

  // GUARD 4: a real comparison. areaAvg is guaranteed finite > 0 here.
  const avg = areaAvg as number;
  const prices = usable.map((c) => c.prisPerKvm as number);
  const deltaPct = ((listingPrisPerKvm - avg) / avg) * 100;

  return {
    areaAvg: avg,
    deltaPct,
    min: Math.min(...prices),
    max: Math.max(...prices),
    trendSlope: computeTrendSlope(usable),
    sampleSize: usableCount,
    tier,
    confidence,
    reason: "ok",
  };
}
