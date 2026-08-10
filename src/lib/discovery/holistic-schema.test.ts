import { describe, it, expect } from "vitest";
import {
  HOLISTIC_DATA_ONLY_MARKER,
  TOMTRATT_TENURE_PATTERN,
  tomtrattFromTenureForm,
  areaCompsSummarySchema,
  brfSummarySchema,
  brfFieldTrusted,
  holisticBriefSchema,
  HOLISTIC_BRIEF_ITEM_KINDS,
  STAMBYTE_STATUSES,
  type AreaCompsSummary,
  type BrfSummary,
  type HolisticBrief,
} from "@/lib/discovery/holistic-schema";
import { OSAKER_THRESHOLD } from "@/lib/brf/sanity";

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
    fieldConfidence: { skuldPerKvm: 0.9, avgiftsniva: 0.9, kassaflode: 0.8 },
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

  it("a legacy row without fieldConfidence still parses, degrading to null (never dropping the candidate)", () => {
    const { fieldConfidence, ...legacyRow } = valid;
    void fieldConfidence;
    const result = brfSummarySchema.safeParse(legacyRow);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.fieldConfidence).toBeNull();
  });
});

describe("brfFieldTrusted — the OSAKER_THRESHOLD gate", () => {
  const base: BrfSummary = {
    skuldPerKvm: null,
    avgiftsniva: null,
    kassaflode: null,
    stambytePlanerat: null,
    tomtratt: null,
    fiscalYear: null,
    source: "allabrf",
    fieldConfidence: null,
  };

  it("returns false for a null summary", () => {
    expect(brfFieldTrusted(null, "skuldPerKvm")).toBe(false);
  });

  it("returns false when the field's value is null, even with a high confidence", () => {
    const brf: BrfSummary = {
      ...base,
      skuldPerKvm: null,
      fieldConfidence: { skuldPerKvm: 0.9, avgiftsniva: null, kassaflode: null },
    };
    expect(brfFieldTrusted(brf, "skuldPerKvm")).toBe(false);
  });

  it("returns false when fieldConfidence is null (legacy row, unknown confidence, fail closed)", () => {
    const brf: BrfSummary = { ...base, skuldPerKvm: 8000, fieldConfidence: null };
    expect(brfFieldTrusted(brf, "skuldPerKvm")).toBe(false);
  });

  it("returns false when the mapped confidence was downgraded below OSAKER_THRESHOLD (sanity downgrade)", () => {
    const brf: BrfSummary = {
      ...base,
      skuldPerKvm: 480_000,
      fieldConfidence: { skuldPerKvm: 0.2, avgiftsniva: null, kassaflode: null },
    };
    expect(brfFieldTrusted(brf, "skuldPerKvm")).toBe(false);
  });

  it("returns true at the OSAKER_THRESHOLD boundary (>=, matching the UI badge boundary)", () => {
    const brf: BrfSummary = {
      ...base,
      skuldPerKvm: 8000,
      fieldConfidence: { skuldPerKvm: OSAKER_THRESHOLD, avgiftsniva: null, kassaflode: null },
    };
    expect(brfFieldTrusted(brf, "skuldPerKvm")).toBe(true);
  });

  it("returns false for a value just below OSAKER_THRESHOLD", () => {
    const brf: BrfSummary = {
      ...base,
      skuldPerKvm: 8000,
      fieldConfidence: {
        skuldPerKvm: OSAKER_THRESHOLD - 0.01,
        avgiftsniva: null,
        kassaflode: null,
      },
    };
    expect(brfFieldTrusted(brf, "skuldPerKvm")).toBe(false);
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
      effectivePricePerSqm: 72_000,
      debtIncluded: false,
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

  it("WR-15 — a drifted stambytePlanerat token normalizes to null WITHOUT discarding the avgift/debt figures", () => {
    const drifted = {
      skuldPerKvm: 12_000,
      avgiftsniva: 550,
      kassaflode: 150_000,
      stambytePlanerat: "toString", // an Object.prototype name, and not the enum
      tomtratt: null,
      fiscalYear: 2025,
      source: "allabrf",
      fieldConfidence: { skuldPerKvm: 0.9, avgiftsniva: 0.9, kassaflode: 0.8 },
    };

    const result = brfSummarySchema.safeParse(drifted);

    expect(result.success).toBe(true);
    expect(result.data?.stambytePlanerat).toBeNull();
    // The valuable figures survive — failing the whole parse would have lost
    // them (and, via candidate.ts's WR-09 soft guard, the whole BRF summary).
    expect(result.data?.skuldPerKvm).toBe(12_000);
    expect(result.data?.avgiftsniva).toBe(550);
  });

  it("WR-15 — each real StambyteStatus value round-trips unchanged", () => {
    for (const status of STAMBYTE_STATUSES) {
      const result = brfSummarySchema.safeParse({
        skuldPerKvm: null,
        avgiftsniva: null,
        kassaflode: null,
        stambytePlanerat: status,
        tomtratt: null,
        fiscalYear: null,
        source: "allabrf",
        fieldConfidence: null,
      });
      expect(result.success).toBe(true);
      expect(result.data?.stambytePlanerat).toBe(status);
    }
  });

  it("WR-11 — a brief persisted BEFORE effectivePricePerSqm/debtIncluded existed still parses, defaulting both", () => {
    const legacy = {
      ...valid,
      conditionAttribution: {
        explainedPct: null,
        capped: false,
        residualDrivers: [],
        canAttributeToCondition: false,
        // effectivePricePerSqm / debtIncluded absent entirely
      },
    };

    const result = holisticBriefSchema.safeParse(legacy);

    // A required key here would have degraded every pre-existing persisted
    // brief the moment the field shipped (the same reason
    // fieldConfidence.default(null) is load-bearing).
    expect(result.success).toBe(true);
    expect(result.data?.conditionAttribution.effectivePricePerSqm).toBeNull();
    expect(result.data?.conditionAttribution.debtIncluded).toBe(false);
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
