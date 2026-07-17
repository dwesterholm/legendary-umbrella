import { describe, it, expect } from "vitest";
import {
  buyerSegment,
  applyRot,
  taxLines,
  valueGap,
  RENO_COST_MATRIX,
  CGT_EFFECTIVE_RATE,
  ROT_CAP_PER_PERSON,
  type ValueGapInput,
} from "@/lib/discovery/flip-economics";

/**
 * flip-economics.test.ts — the pure economic core (SPEC §2.3/§2.4/§2.6/§2.7).
 * No I/O, no model calls; every rule is deterministic and unit-checkable.
 */

describe("buyerSegment (§2.4)", () => {
  it("rooms <= 1 → etta; rooms >= 2 → par-2-3rok (incl. 4+)", () => {
    expect(buyerSegment(1, 30)).toBe("etta");
    expect(buyerSegment(2, 55)).toBe("par-2-3rok");
    expect(buyerSegment(3, 75)).toBe("par-2-3rok");
    expect(buyerSegment(4, 100)).toBe("par-2-3rok");
  });

  it("falls back to living area when rooms unknown", () => {
    expect(buyerSegment(null, 32)).toBe("etta");
    expect(buyerSegment(null, 60)).toBe("par-2-3rok");
  });

  it("defaults to the premium-tolerant bucket when neither signal exists", () => {
    // Safer default — does NOT suppress renovation upside the way etta does.
    expect(buyerSegment(null, null)).toBe("par-2-3rok");
  });
});

describe("tiered reno cost matrix (§2.3)", () => {
  it("marks DIY wet room and DIY bearing wall as invalid tiers", () => {
    expect(RENO_COST_MATRIX["bathroom-full"].invalidTiers).toContain("cheap");
    expect(RENO_COST_MATRIX["wall-bearing"].invalidTiers).toContain("cheap");
  });

  it("kitchen-cosmetic carries the best-ROI uplift anchor and every band is ordered low<=high", () => {
    expect(RENO_COST_MATRIX["kitchen-cosmetic"].upliftAnchor).toEqual([80_000, 150_000]);
    for (const profile of Object.values(RENO_COST_MATRIX)) {
      for (const tier of ["cheap", "mid", "high"] as const) {
        const [lo, hi] = profile[tier];
        expect(lo).toBeLessThanOrEqual(hi);
      }
    }
  });
});

describe("applyRot (§2.3)", () => {
  it("DIY (0 owners) gets no relief", () => {
    expect(applyRot(100_000, 0)).toBe(100_000);
  });

  it("one owner: 30% off labor, capped at 50k", () => {
    expect(applyRot(100_000, 1)).toBe(70_000); // 30k < cap
    expect(applyRot(300_000, 1)).toBe(250_000); // 90k relief capped to 50k
  });

  it("two owners double the cap to 100k", () => {
    expect(applyRot(400_000, 2)).toBe(300_000); // 120k relief capped to 100k
    expect(ROT_CAP_PER_PERSON).toBe(50_000);
  });
});

describe("taxLines (§2.7)", () => {
  it("applies the flat 22% to a gain; both lines returned", () => {
    const t = taxLines(150_000);
    expect(t.taxSek).toBe(150_000 * CGT_EFFECTIVE_RATE); // 33,000
    expect(t.profitWithoutTax).toBe(150_000);
    expect(t.profitWithTax).toBe(150_000 - 33_000);
  });

  it("a loss incurs no tax (max(vinst,0)); both lines equal the loss", () => {
    const t = taxLines(-80_000);
    expect(t.taxSek).toBe(0);
    expect(t.profitWithoutTax).toBe(-80_000);
    expect(t.profitWithTax).toBe(-80_000);
  });
});

describe("valueGap (§2.6)", () => {
  const base: ValueGapInput = {
    askingPrice: 3_000_000,
    livingArea: 40, // asking 75,000/m²
    renovatedMedianPerSqm: 100_000, // 25% below → but that trips the guard; tuned per-case below
    unrenovatedMedianPerSqm: 78_000,
    renoCostSek: 150_000,
    expectedOverbid: 0,
    salesCostsSek: 100_000,
    isDated: true,
  };

  it("flags HIGH for a dated, meaningfully-below-market flat with strong uplift", () => {
    // asking 90,000/m² vs R_med 100,000 → 10% below (under the 25% guard),
    // resale 4,000,000, uplift 4.0M − 3.6M(asking*... ) etc. Tune for HIGH.
    const g = valueGap({
      ...base,
      askingPrice: 3_600_000,
      livingArea: 40, // asking 90,000/m²
      renovatedMedianPerSqm: 106_000, // ~15.1% below
      unrenovatedMedianPerSqm: 88_000,
      renoCostSek: 150_000,
      salesCostsSek: 100_000,
    });
    // resaleW = 4,240,000; purchaseP = 3,600,000; vinst = 4.24M−3.6M−150k−100k = 390k
    expect(g.belowMarketPct).toBeGreaterThanOrEqual(0.15);
    expect(g.netUpliftWithoutTax).toBeGreaterThanOrEqual(150_000);
    expect(g.hiddenDefectRisk).toBe(false);
    expect(g.flag).toBe("HIGH");
    expect(g.netUpliftWithTax).toBeLessThan(g.netUpliftWithoutTax);
  });

  it("holds at MED (never HIGH) when the below-market gap exceeds the 25% discount-attribution guard", () => {
    const g = valueGap({
      ...base,
      askingPrice: 3_000_000,
      livingArea: 40, // 75,000/m²
      renovatedMedianPerSqm: 110_000, // ~32% below → guard trips
      unrenovatedMedianPerSqm: 85_000,
    });
    expect(g.hiddenDefectRisk).toBe(true);
    expect(g.flag).toBe("MED");
  });

  it("flags LOW when asking is within ±5% of the renovated median (already priced renovated)", () => {
    const g = valueGap({
      ...base,
      askingPrice: 3_900_000,
      livingArea: 40, // 97,500/m²
      renovatedMedianPerSqm: 100_000, // 2.5% below
      unrenovatedMedianPerSqm: 95_000,
    });
    expect(g.flag).toBe("LOW");
  });

  it("a non-dated flat cannot reach HIGH even with a big gap (dated is required)", () => {
    const g = valueGap({
      ...base,
      askingPrice: 3_600_000,
      livingArea: 40,
      renovatedMedianPerSqm: 106_000,
      unrenovatedMedianPerSqm: 88_000,
      isDated: false,
    });
    expect(g.flag).toBe("MED");
  });

  it("ROI-floor: fails when condition-recovered value < 65% of reno cost", () => {
    const g = valueGap({
      ...base,
      askingPrice: 3_600_000,
      livingArea: 40,
      renovatedMedianPerSqm: 106_000, // resale 4.24M
      unrenovatedMedianPerSqm: 104_000, // recovered = (106k−104k)*40 = 80k
      renoCostSek: 200_000, // 65% = 130k > 80k → fails
    });
    expect(g.roiFloorMet).toBe(false);
  });

  it("applies the renovated 75th-pct cap to Resale_W when provided", () => {
    const uncapped = valueGap({ ...base, renovatedMedianPerSqm: 120_000, renovatedCapPerSqm: undefined });
    const capped = valueGap({ ...base, renovatedMedianPerSqm: 120_000, renovatedCapPerSqm: 100_000 });
    expect(capped.resaleW).toBeLessThan(uncapped.resaleW);
    expect(capped.resaleW).toBe(100_000 * base.livingArea);
  });
});
