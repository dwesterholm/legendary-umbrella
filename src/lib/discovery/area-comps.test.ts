import { describe, it, expect } from "vitest";
import {
  computeAreaComps,
  MIN_COMPS_FOR_CONFIDENCE,
  type AreaCompsFilter,
} from "@/lib/discovery/area-comps";
import type { SoldComp } from "@/lib/market/sold-schema";

/**
 * area-comps.test.ts — pure comp aggregation (SPEC §2.2/§2.6). Renovated vs
 * unrenovated is the kr/m² tercile proxy; thin samples must read as null +
 * not-confident, never fabricated.
 */

const comp = (prisPerKvm: number, extra: Partial<SoldComp> = {}): SoldComp => ({
  prisPerKvm,
  soldDate: "2026-06-01",
  livingArea: 40,
  rooms: 1,
  floor: null,
  ...extra,
});

const baseFilter: AreaCompsFilter = { rooms: 1, livingArea: 40, asOf: "2026-07-01" };

describe("computeAreaComps (§2.2/§2.6)", () => {
  it("returns all-null + not-confident when nothing passes the filter", () => {
    const r = computeAreaComps([], baseFilter);
    expect(r.sampleSize).toBe(0);
    expect(r.confident).toBe(false);
    expect(r.renovatedMedianPerSqm).toBeNull();
    expect(r.unrenovatedMedianPerSqm).toBeNull();
  });

  it("infers renovated (top tercile) above unrenovated (bottom tercile)", () => {
    const comps = [60_000, 70_000, 80_000, 90_000, 100_000, 110_000, 120_000, 130_000, 140_000].map(
      (v) => comp(v),
    );
    const r = computeAreaComps(comps, baseFilter);
    expect(r.sampleSize).toBe(9);
    expect(r.confident).toBe(true);
    // bottom third [60,70,80] median 70k; top third [120,130,140] median 130k.
    expect(r.unrenovatedMedianPerSqm).toBe(70_000);
    expect(r.renovatedMedianPerSqm).toBe(130_000);
    expect(r.renovatedMedianPerSqm!).toBeGreaterThan(r.unrenovatedMedianPerSqm!);
    expect(r.overallMedianPerSqm).toBe(100_000);
  });

  it("computes the 75th-percentile cap (the Resale_W ceiling)", () => {
    const comps = [80_000, 90_000, 100_000, 110_000, 120_000].map((v) => comp(v));
    const r = computeAreaComps(comps, baseFilter);
    // p75 over [80,90,100,110,120]: idx = 0.75*4 = 3 → 110,000.
    expect(r.renovatedCapPerSqm).toBe(110_000);
  });

  it("drops comps outside the ±15% size band", () => {
    const comps = [
      comp(100_000, { livingArea: 40 }), // in band
      comp(200_000, { livingArea: 60 }), // 60 vs 40 → +50%, out
      comp(100_000, { livingArea: 34 }), // -15% → in (34 = 40*0.85)
      comp(100_000, { livingArea: 33 }), // -17.5% → out
    ];
    const r = computeAreaComps(comps, baseFilter);
    expect(r.sampleSize).toBe(2);
  });

  it("drops comps with a non-matching room count (when both known)", () => {
    const comps = [comp(100_000, { rooms: 1 }), comp(100_000, { rooms: 2 })];
    const r = computeAreaComps(comps, baseFilter);
    expect(r.sampleSize).toBe(1);
  });

  it("drops comps older than the recency window", () => {
    const comps = [
      comp(100_000, { soldDate: "2026-06-01" }), // ~1mo → keep
      comp(100_000, { soldDate: "2025-01-01" }), // ~18mo → drop
    ];
    const r = computeAreaComps(comps, { ...baseFilter, maxAgeMonths: 12 });
    expect(r.sampleSize).toBe(1);
  });

  it("keeps comps whose optional fields are absent (only filters on known data)", () => {
    const comps = [
      comp(100_000, { livingArea: null, rooms: null, soldDate: null }),
      comp(110_000, { livingArea: null, rooms: null, soldDate: null }),
    ];
    const r = computeAreaComps(comps, baseFilter);
    expect(r.sampleSize).toBe(2);
  });

  it("ignores comps with a missing/non-positive kr/m²", () => {
    const comps = [
      comp(100_000),
      { ...comp(0), prisPerKvm: null } as SoldComp,
      { ...comp(0), prisPerKvm: 0 } as SoldComp,
    ];
    const r = computeAreaComps(comps, baseFilter);
    expect(r.sampleSize).toBe(1);
  });

  it("a sub-threshold sample is not confident but still yields medians", () => {
    const comps = [90_000, 100_000, 110_000].map((v) => comp(v));
    const r = computeAreaComps(comps, baseFilter);
    expect(r.sampleSize).toBeLessThan(MIN_COMPS_FOR_CONFIDENCE);
    expect(r.confident).toBe(false);
    expect(r.overallMedianPerSqm).toBe(100_000);
  });
});
