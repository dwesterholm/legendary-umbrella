import { describe, it, expect } from "vitest";
// RED: these modules do not exist yet — implemented in Plan 04 (src/lib/market/compare.ts).
// The import itself fails until then, which is the intended Wave 0 red state
// (mirrors the Phase 2 Wave-0 precedent in src/lib/brf/score.test.ts).
import {
  computePriceComparison,
  PRICE_COMPARISON_THRESHOLDS,
  type PriceComparison,
  type SoldComp,
} from "@/lib/market/compare";

// A SoldComp is a single normalized sold record. Minimum: a sold date + a
// pris/kvm (kr/m²); pris/kvm is the comparison axis (D-03). Some comps may carry
// a null prisPerKvm (the live source occasionally omits it) — the guards below
// pin that those NEVER poison the headline (D-08 / review HIGH-3 + areaAvg-NaN).
const comp = (prisPerKvm: number | null, soldDate: string): SoldComp => ({
  prisPerKvm,
  soldDate,
});

// A healthy comp set averaging ~88 000 kr/m².
const healthyComps: SoldComp[] = [
  comp(85000, "2026-01-15"),
  comp(87000, "2026-02-20"),
  comp(88000, "2026-03-18"),
  comp(90000, "2026-04-22"),
  comp(90000, "2026-05-19"),
];

describe("computePriceComparison — headline ±% (D-04)", () => {
  it("computes deltaPct ≈ +8 for a listing 8% above the area average", () => {
    const result = computePriceComparison({
      listingPrisPerKvm: 95200,
      comps: healthyComps,
      tier: "neighborhood",
    });
    expect(result.areaAvg).toBeCloseTo(88000, -2); // ~88 000 kr/m²
    expect(result.deltaPct).toBeCloseTo(8, 0); // +8% (±0.5 → toBeCloseTo 0 dp)
    expect(result.reason).toBe("ok");
  });

  it("distribution min/max reflect the comp set's pris/kvm spread", () => {
    const result = computePriceComparison({
      listingPrisPerKvm: 88000,
      comps: healthyComps,
      tier: "neighborhood",
    });
    expect(result.min).toBe(85000);
    expect(result.max).toBe(90000);
  });
});

describe("computePriceComparison — tier preserved on the result", () => {
  it("preserves the building tier when comps came from the building tier", () => {
    const result = computePriceComparison({
      listingPrisPerKvm: 88000,
      comps: healthyComps,
      tier: "building",
    });
    expect(result.tier).toBe("building");
  });

  it("preserves the wide tier when comps came from the wide-area tier", () => {
    const result = computePriceComparison({
      listingPrisPerKvm: 88000,
      comps: healthyComps,
      tier: "wide",
    });
    expect(result.tier).toBe("wide");
  });
});

describe("computePriceComparison — confidence from sampleSize + tier (D-09)", () => {
  it("is higher for many building-tier comps than for 2 wide-tier comps", () => {
    const manyBuilding = computePriceComparison({
      listingPrisPerKvm: 88000,
      comps: healthyComps, // 5 comps
      tier: "building",
    });
    const fewWide = computePriceComparison({
      listingPrisPerKvm: 88000,
      comps: [comp(85000, "2026-01-15"), comp(90000, "2026-05-19")], // 2 comps
      tier: "wide",
    });
    // Confidence is driven by sample size + tier, NOT model output (D-09).
    expect(manyBuilding.confidence).toBeGreaterThan(fewWide.confidence);
  });
});

describe("computePriceComparison — 24-mo trend (least-squares, no stats dep)", () => {
  it("returns a finite positive slope for rising prices over the sale dates", () => {
    const rising: SoldComp[] = [
      comp(80000, "2025-07-01"),
      comp(83000, "2025-10-01"),
      comp(86000, "2026-01-01"),
      comp(90000, "2026-04-01"),
    ];
    const result = computePriceComparison({
      listingPrisPerKvm: 90000,
      comps: rising,
      tier: "neighborhood",
    });
    expect(Number.isFinite(result.trendSlope)).toBe(true);
    expect(result.trendSlope).toBeGreaterThan(0);
  });
});

describe("computePriceComparison — thin data, never throws (D-08)", () => {
  it("flags reason 'thin' + low confidence for ≤2 comps and never throws", () => {
    const run = () =>
      computePriceComparison({
        listingPrisPerKvm: 88000,
        comps: [comp(85000, "2026-01-15"), comp(90000, "2026-05-19")],
        tier: "wide",
      });
    expect(run).not.toThrow();
    const result = run();
    expect(result.reason).toBe("thin");
    expect(result.confidence).toBeLessThan(0.5);
  });
});

describe("computePriceComparison — HIGH-3: listingPrisPerKvm <= 0 / null guard", () => {
  it("listingPrisPerKvm of 0 → reason 'listing_pris_okand', deltaPct null (NOT -100), no throw", () => {
    const run = () =>
      computePriceComparison({
        listingPrisPerKvm: 0,
        comps: healthyComps,
        tier: "neighborhood",
      });
    expect(run).not.toThrow();
    const result: PriceComparison = run();
    expect(result.reason).toBe("listing_pris_okand");
    // The headline is suppressed — never a confident "-100 % under snitt".
    expect(result.deltaPct).toBeNull();
  });

  it("listingPrisPerKvm of null → reason 'listing_pris_okand', deltaPct null, no throw", () => {
    const run = () =>
      computePriceComparison({
        listingPrisPerKvm: null as unknown as number,
        comps: healthyComps,
        tier: "neighborhood",
      });
    expect(run).not.toThrow();
    const result = run();
    expect(result.reason).toBe("listing_pris_okand");
    expect(result.deltaPct).toBeNull();
  });
});

describe("computePriceComparison — LOW: areaAvg-NaN guard (all comps null pris/kvm)", () => {
  it("comps present but EVERY prisPerKvm null → no usable sample, never NaN/Infinity, no throw", () => {
    const allNull: SoldComp[] = [
      comp(null, "2026-01-15"),
      comp(null, "2026-02-20"),
      comp(null, "2026-03-18"),
      comp(null, "2026-04-22"),
    ];
    const run = () =>
      computePriceComparison({
        listingPrisPerKvm: 88000,
        comps: allNull,
        tier: "neighborhood",
      });
    expect(run).not.toThrow();
    const result = run();
    // No usable sample → thin (or a documented no-usable-comps marker), deltaPct null.
    expect(result.reason).toBe("thin");
    expect(result.deltaPct).toBeNull();
    // areaAvg must be guarded — never NaN or Infinity.
    expect(result.areaAvg === null || Number.isFinite(result.areaAvg)).toBe(true);
    expect(Number.isNaN(result.areaAvg as number)).toBe(false);
  });
});

describe("computePriceComparison — 24-month window (windowDays, WR-01)", () => {
  // Anchor "now" so the window is deterministic (the function is pure given nowMs).
  const NOW = Date.parse("2026-06-22T00:00:00Z");

  it("excludes comps sold older than windowDays from areaAvg/deltaPct/min/max", () => {
    // Five RECENT comps (~88 000) + two STALE comps (sold > 2 years ago) at a
    // wildly different price. If the window were NOT applied, the stale comps
    // would drag areaAvg down and poison the ±% headline.
    const withStale: SoldComp[] = [
      ...healthyComps, // 2026 dates, in-window
      comp(40000, "2022-01-01"), // ~4.5 yrs old → out of the 730-day window
      comp(42000, "2023-01-01"), // ~3.5 yrs old → out of the 730-day window
    ];
    const result = computePriceComparison({
      listingPrisPerKvm: 95200,
      comps: withStale,
      tier: "neighborhood",
      nowMs: NOW,
    });
    // Only the 5 in-window comps count — the stale ones are dropped.
    expect(result.sampleSize).toBe(5);
    expect(result.areaAvg).toBeCloseTo(88000, -2);
    expect(result.min).toBe(85000);
    expect(result.max).toBe(90000);
    expect(result.reason).toBe("ok");
  });

  it("drops to 'thin' when only stale (out-of-window) comps remain", () => {
    const allStale: SoldComp[] = [
      comp(85000, "2020-01-15"),
      comp(87000, "2020-02-20"),
      comp(88000, "2020-03-18"),
      comp(90000, "2020-04-22"),
      comp(90000, "2020-05-19"),
    ];
    const result = computePriceComparison({
      listingPrisPerKvm: 95200,
      comps: allStale,
      tier: "neighborhood",
      nowMs: NOW,
    });
    expect(result.sampleSize).toBe(0);
    expect(result.reason).toBe("thin");
    expect(result.areaAvg).toBeNull();
    expect(result.deltaPct).toBeNull();
  });

  it("keeps undated comps (no staleness signal) in the usable sample", () => {
    const withUndated: SoldComp[] = [
      ...healthyComps,
      comp(91000, ""), // no soldDate → kept per documented policy
    ];
    const result = computePriceComparison({
      listingPrisPerKvm: 88000,
      comps: withUndated,
      tier: "neighborhood",
      nowMs: NOW,
    });
    expect(result.sampleSize).toBe(6);
    expect(result.reason).toBe("ok");
  });
});

describe("PRICE_COMPARISON_THRESHOLDS — shared source of truth", () => {
  it("is exported so the methodology page and the comparator agree", () => {
    expect(PRICE_COMPARISON_THRESHOLDS).toBeDefined();
  });
});
