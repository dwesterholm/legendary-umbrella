import { describe, it, expect } from "vitest";
// RED: these modules do not exist yet — implemented in Plan 03 (src/lib/brf/score.ts).
// The import itself fails until then, which is the intended Wave 0 red state.
import {
  computeBrfGrade,
  BRF_SCORE_THRESHOLDS,
  type BrfScoreResult,
} from "@/lib/brf/score";
import type { NormalizedBrf } from "@/lib/schemas/brf";

// A förening with strong financials: low debt, low fee, positive cash flow,
// current maintenance plan. Should land at the top of the A–F scale.
const strongBrf: NormalizedBrf = {
  skuldPerKvm: 4000,
  avgiftsniva: 600,
  kassaflode: 350,
  underhallsplanStatus: "finns_aktuell",
};

// A förening with weak financials: high debt, negative cash flow, no plan.
const weakBrf: NormalizedBrf = {
  skuldPerKvm: 13000,
  avgiftsniva: 1100,
  kassaflode: -200,
  underhallsplanStatus: "saknas",
};

describe("computeBrfGrade — determinism (D-08)", () => {
  it("returns an identical grade for the same input across repeated calls", () => {
    const a = computeBrfGrade(strongBrf);
    const b = computeBrfGrade(strongBrf);
    expect(a.grade).toBe(b.grade);
    // The full result (including the per-metric breakdown) must be deeply equal —
    // no hidden randomness, timestamps, or ordering drift.
    expect(a).toEqual(b);
  });

  it("is a pure function — does not mutate its input", () => {
    const input: NormalizedBrf = { ...strongBrf };
    const snapshot = JSON.stringify(input);
    computeBrfGrade(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("computeBrfGrade — grade mapping (D-07/D-08)", () => {
  it("maps strong financials to a high grade (A or B)", () => {
    const result = computeBrfGrade(strongBrf);
    expect(["A", "B"]).toContain(result.grade);
  });

  it("maps weak financials to a low grade (D, E, or F)", () => {
    const result = computeBrfGrade(weakBrf);
    expect(["D", "E", "F"]).toContain(result.grade);
  });

  it("grades strong financials strictly better than weak financials", () => {
    const strong = computeBrfGrade(strongBrf);
    const weak = computeBrfGrade(weakBrf);
    // Lower letter (earlier in the alphabet) == better grade.
    expect(strong.grade < weak.grade).toBe(true);
  });
});

describe("computeBrfGrade — per-metric breakdown (D-07)", () => {
  it("exposes a breakdown array with one entry per assessed metric", () => {
    const result = computeBrfGrade(strongBrf);
    expect(Array.isArray(result.breakdown)).toBe(true);
    // Four core metrics: skuldPerKvm, avgiftsniva, kassaflode, underhallsplanStatus.
    expect(result.breakdown.length).toBe(4);
  });

  it("each breakdown entry carries its value, a rating, and a weight contribution", () => {
    const result = computeBrfGrade(strongBrf);
    for (const metric of result.breakdown) {
      expect(metric).toHaveProperty("key");
      expect(metric).toHaveProperty("value");
      expect(metric).toHaveProperty("rating");
      expect(metric).toHaveProperty("weight");
      expect(typeof metric.weight).toBe("number");
    }
  });

  it("the metric weights sum to 1 (full coverage of the grade)", () => {
    const result = computeBrfGrade(strongBrf);
    const total = result.breakdown.reduce((sum, m) => sum + m.weight, 0);
    expect(total).toBeCloseTo(1, 5);
  });
});

describe("computeBrfGrade — null handling (not assessable, must not crash)", () => {
  const partialBrf: NormalizedBrf = {
    skuldPerKvm: null,
    avgiftsniva: 600,
    kassaflode: 350,
    underhallsplanStatus: "finns_aktuell",
  };

  it("does not throw when a metric value is null", () => {
    expect(() => computeBrfGrade(partialBrf)).not.toThrow();
  });

  it("treats a null metric as not-assessable, never silently as good", () => {
    const result: BrfScoreResult = computeBrfGrade(partialBrf);
    const nullMetric = result.breakdown.find((m) => m.key === "skuldPerKvm");
    expect(nullMetric).toBeDefined();
    expect(nullMetric!.value).toBeNull();
    // A not-assessable metric must be flagged as such, not rated "good".
    expect(nullMetric!.rating).toBe("not_assessable");
  });
});

describe("BRF_SCORE_THRESHOLDS — shared source of truth", () => {
  it("is exported so the methodology page (Plan 05) and the scorer agree", () => {
    expect(BRF_SCORE_THRESHOLDS).toBeDefined();
    // Thresholds for the debt metric must exist (skuld/kvm is the load-bearing band).
    expect(BRF_SCORE_THRESHOLDS).toHaveProperty("skuldPerKvm");
  });
});
