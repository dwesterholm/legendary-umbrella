import { describe, it, expect } from "vitest";
import {
  HOLISTIC_DATA_ONLY_MARKER,
  TOMTRATT_TENURE_PATTERN,
  tomtrattFromTenureForm,
  areaCompsSummarySchema,
  brfSummarySchema,
  holisticBriefSchema,
  HOLISTIC_BRIEF_ITEM_KINDS,
  type AreaCompsSummary,
  type BrfSummary,
  type HolisticBrief,
} from "@/lib/discovery/holistic-schema";

describe("HOLISTIC_DATA_ONLY_MARKER — D-14-04's data-only marker", () => {
  it("is the exact Swedish marker string", () => {
    expect(HOLISTIC_DATA_ONLY_MARKER).toBe("Baserat på områdesdata — ingen bildtolkning");
  });
});

describe("TOMTRATT_TENURE_PATTERN / tomtrattFromTenureForm — never returns false", () => {
  it("returns true for 'Tomträtt' and 'tomtratt' (either graphy, case-insensitive)", () => {
    expect(tomtrattFromTenureForm("Tomträtt")).toBe(true);
    expect(tomtrattFromTenureForm("tomtratt")).toBe(true);
    expect(TOMTRATT_TENURE_PATTERN.test("Tomträtt")).toBe(true);
  });

  it("returns null (never false) for Bostadsrätt, Äganderätt, and null", () => {
    expect(tomtrattFromTenureForm("Bostadsrätt")).toBeNull();
    expect(tomtrattFromTenureForm("Äganderätt")).toBeNull();
    expect(tomtrattFromTenureForm(null)).toBeNull();
  });

  it("never returns false for any input", () => {
    const inputs = ["Bostadsrätt", "Äganderätt", "Tomträtt", "tomtratt", null, "", "gibberish"];
    for (const input of inputs) {
      expect(tomtrattFromTenureForm(input)).not.toBe(false);
    }
  });
});

describe("areaCompsSummarySchema — read guard", () => {
  const valid: AreaCompsSummary = {
    areaId: "115341",
    renovatedMedianPerSqm: 95_000,
    unrenovatedMedianPerSqm: 75_000,
    overallMedianPerSqm: 85_000,
    renovatedCapPerSqm: 100_000,
    sampleSize: 12,
    confident: true,
    asOf: "2026-08-05",
    widenedBand: false,
  };

  it("round-trips a fully-populated object", () => {
    const result = areaCompsSummarySchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(valid);
  });

  it("rejects a wrong-typed field", () => {
    const result = areaCompsSummarySchema.safeParse({ ...valid, sampleSize: "twelve" });
    expect(result.success).toBe(false);
  });
});

describe("brfSummarySchema — read guard", () => {
  const valid: BrfSummary = {
    skuldPerKvm: 12_000,
    avgiftsniva: 550,
    kassaflode: 150_000,
    stambytePlanerat: "planerat",
    tomtratt: null,
    fiscalYear: 2025,
    source: "allabrf",
  };

  it("round-trips a fully-populated object", () => {
    const result = brfSummarySchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(valid);
  });

  it("rejects a wrong-typed field", () => {
    const result = brfSummarySchema.safeParse({ ...valid, source: "manual" });
    expect(result.success).toBe(false);
  });
});

describe("holisticBriefSchema — read guard", () => {
  const valid: HolisticBrief = {
    marker: HOLISTIC_DATA_ONLY_MARKER,
    confidence: "low",
    items: [{ kind: "comps-positioning", text: "Ligger nära områdets median kr/m²." }],
    dataSources: ["comps"],
    conditionAttribution: {
      explainedPct: null,
      capped: false,
      residualDrivers: [],
      canAttributeToCondition: false,
    },
  };

  it("round-trips a fully-populated object", () => {
    const result = holisticBriefSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(valid);
  });

  it("rejects a wrong-typed field", () => {
    const result = holisticBriefSchema.safeParse({
      ...valid,
      items: [{ kind: "not-a-real-kind", text: "x" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence: 'high' — a data-only brief can never claim high confidence", () => {
    const result = holisticBriefSchema.safeParse({ ...valid, confidence: "high" });
    expect(result.success).toBe(false);
  });

  it("HOLISTIC_BRIEF_ITEM_KINDS lists exactly the four expected kinds", () => {
    expect(HOLISTIC_BRIEF_ITEM_KINDS).toEqual([
      "comps-positioning",
      "confounder",
      "brf",
      "insufficient-data",
    ]);
  });
});
