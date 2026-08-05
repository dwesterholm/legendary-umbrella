import { describe, it, expect } from "vitest";
import {
  normalizeForConfounders,
  buildHolisticBrief,
  BANNED_RENO_ATTRIBUTION_PATTERNS,
  RENO_ATTRIBUTION_FALLBACK_TEXT,
  MAX_CONDITION_EXPLAINED_PCT,
  DISCOUNT_ATTRIBUTION_TRIGGER_PCT,
  HIGH_BRF_DEBT_PER_SQM,
  type ConfounderGuardInput,
  type BuildHolisticBriefInput,
} from "@/lib/discovery/confounder-guard";
import { MIN_COMPS_FOR_CONFIDENCE } from "@/lib/discovery/area-comps";
import {
  HOLISTIC_DATA_ONLY_MARKER,
  type AreaCompsSummary,
  type BrfSummary,
} from "@/lib/discovery/holistic-schema";

/**
 * confounder-guard.test.ts — pure unit tests for SPEC §2.6's discount-
 * attribution guard. No mocks, no async — every rule is a plain
 * `expect(normalizeForConfounders(input)).toMatchObject(...)` assertion.
 */

function makeComps(overrides: Partial<AreaCompsSummary> = {}): AreaCompsSummary {
  return {
    areaId: "area-1",
    renovatedMedianPerSqm: 100_000,
    unrenovatedMedianPerSqm: 70_000,
    overallMedianPerSqm: 85_000,
    renovatedCapPerSqm: 110_000,
    sampleSize: 6,
    confident: true,
    asOf: "2026-07-01",
    widenedBand: false,
    ...overrides,
  };
}

function makeBrf(overrides: Partial<BrfSummary> = {}): BrfSummary {
  return {
    skuldPerKvm: null,
    avgiftsniva: 3_500,
    kassaflode: 100_000,
    stambytePlanerat: null,
    tomtratt: null,
    fiscalYear: 2025,
    source: "allabrf",
    ...overrides,
  };
}

function makeInput(overrides: Partial<ConfounderGuardInput> = {}): ConfounderGuardInput {
  return {
    pricePerSqm: null,
    livingArea: null,
    floor: null,
    balcony: null,
    tenureForm: null,
    comps: null,
    brf: null,
    ...overrides,
  };
}

describe("debt-inclusive kr/m² normalization", () => {
  it("adds skuldPerKvm to pricePerSqm when the BRF summary has a finite debt figure", () => {
    const r = normalizeForConfounders(
      makeInput({ pricePerSqm: 60_000, brf: makeBrf({ skuldPerKvm: 8_000 }) }),
    );
    expect(r.effectivePricePerSqm).toBe(68_000);
    expect(r.debtIncluded).toBe(true);
  });

  it("falls back to plain pricePerSqm when brf is null", () => {
    const r = normalizeForConfounders(makeInput({ pricePerSqm: 60_000, brf: null }));
    expect(r.effectivePricePerSqm).toBe(60_000);
    expect(r.debtIncluded).toBe(false);
  });

  it("returns null effectivePricePerSqm when pricePerSqm is null", () => {
    const r = normalizeForConfounders(makeInput({ pricePerSqm: null, brf: makeBrf({ skuldPerKvm: 8_000 }) }));
    expect(r.effectivePricePerSqm).toBeNull();
  });
});

describe("discount vs renovated median", () => {
  it("computes a positive discount when effective price is below the renovated median", () => {
    const r = normalizeForConfounders(
      makeInput({ pricePerSqm: 70_000, comps: makeComps({ renovatedMedianPerSqm: 100_000 }) }),
    );
    expect(r.discountVsRenovatedPct).toBeCloseTo(0.3, 5);
  });

  it("returns a NEGATIVE value, never clamped to 0, when the price is above the median", () => {
    const r = normalizeForConfounders(
      makeInput({ pricePerSqm: 105_000, comps: makeComps({ renovatedMedianPerSqm: 100_000 }) }),
    );
    expect(r.discountVsRenovatedPct).not.toBeNull();
    expect(r.discountVsRenovatedPct!).toBeLessThan(0);
  });

  it("returns null when the renovated median is unavailable", () => {
    const r = normalizeForConfounders(
      makeInput({ pricePerSqm: 70_000, comps: makeComps({ renovatedMedianPerSqm: null }) }),
    );
    expect(r.discountVsRenovatedPct).toBeNull();
  });
});

describe("the >25% guard caps condition-explained at 20% and routes the residual to the specific confounders present", () => {
  it("caps conditionExplainedPct and names bottenvaning + brf_debt_high in order", () => {
    const r = normalizeForConfounders(
      makeInput({
        pricePerSqm: 50_000, // + 20_000 debt = 70_000 effective
        floor: 0,
        brf: makeBrf({ skuldPerKvm: 20_000 }),
        comps: makeComps({ renovatedMedianPerSqm: 100_000 }),
      }),
    );
    expect(r.deepDiscount).toBe(true);
    expect(r.conditionExplainedPct).toBe(MAX_CONDITION_EXPLAINED_PCT);
    expect(r.conditionCapApplied).toBe(true);
    expect(r.residualDrivers).toEqual(["bottenvaning", "brf_debt_high"]);
  });

  it("a deep discount with NO known confounder yields an empty residual and a non-empty unknown list", () => {
    const r = normalizeForConfounders(
      makeInput({
        pricePerSqm: 70_000,
        floor: 1,
        balcony: true,
        livingArea: 50,
        tenureForm: "Bostadsrätt",
        brf: null,
        comps: makeComps({ renovatedMedianPerSqm: 100_000 }),
      }),
    );
    expect(r.deepDiscount).toBe(true);
    expect(r.residualDrivers).toEqual([]);
    expect(r.unknownConfounders.length).toBeGreaterThan(0);
  });
});

describe("a shallow discount is NOT capped", () => {
  it("passes through ~10% as-is with no cap applied", () => {
    const r = normalizeForConfounders(
      makeInput({ pricePerSqm: 90_000, comps: makeComps({ renovatedMedianPerSqm: 100_000 }) }),
    );
    expect(r.deepDiscount).toBe(false);
    expect(r.conditionExplainedPct).toBeCloseTo(0.1, 5);
    expect(r.conditionCapApplied).toBe(false);
  });
});

describe("fewer than 5 comps in the window downgrades confidence", () => {
  it("sampleSize 4 + not-confident is thin and low-confidence", () => {
    const r = normalizeForConfounders(
      makeInput({ pricePerSqm: 90_000, comps: makeComps({ sampleSize: 4, confident: false }) }),
    );
    expect(r.compsThin).toBe(true);
    expect(r.confidence).toBe("low");
  });

  it("sampleSize 6 + confident + BRF present + shallow discount is medium confidence", () => {
    const r = normalizeForConfounders(
      makeInput({
        pricePerSqm: 85_000,
        brf: makeBrf({ skuldPerKvm: 5_000 }),
        comps: makeComps({ sampleSize: 6, confident: true, renovatedMedianPerSqm: 100_000 }),
      }),
    );
    expect(r.compsThin).toBe(false);
    expect(r.confidence).toBe("medium");
  });

  it("MIN_COMPS_FOR_CONFIDENCE (5) is the exact threshold driving compsThin", () => {
    expect(MIN_COMPS_FOR_CONFIDENCE).toBe(5);
    const atThreshold = normalizeForConfounders(
      makeInput({ comps: makeComps({ sampleSize: MIN_COMPS_FOR_CONFIDENCE }) }),
    );
    const belowThreshold = normalizeForConfounders(
      makeInput({ comps: makeComps({ sampleSize: MIN_COMPS_FOR_CONFIDENCE - 1 }) }),
    );
    expect(atThreshold.compsThin).toBe(false);
    expect(belowThreshold.compsThin).toBe(true);
  });
});

describe("confidence is never high", () => {
  it("returns only low or medium across a varied table of inputs", () => {
    const table: ConfounderGuardInput[] = [
      makeInput(),
      makeInput({ pricePerSqm: 90_000, comps: makeComps({ renovatedMedianPerSqm: 100_000 }) }),
      makeInput({
        pricePerSqm: 85_000,
        brf: makeBrf({ skuldPerKvm: 5_000 }),
        comps: makeComps({ sampleSize: 6, confident: true, renovatedMedianPerSqm: 100_000 }),
      }),
      makeInput({ comps: makeComps({ sampleSize: 4, confident: false }) }),
      makeInput({ pricePerSqm: 50_000, floor: 0, brf: makeBrf({ skuldPerKvm: 20_000 }), comps: makeComps() }),
      makeInput({ pricePerSqm: 120_000, comps: makeComps({ renovatedMedianPerSqm: 100_000 }) }),
    ];
    for (const input of table) {
      expect(["low", "medium"]).toContain(normalizeForConfounders(input).confidence);
    }
  });
});

describe("tomträtt is handled defensively (research OQ-2)", () => {
  it("tenureForm 'Tomträtt' names tomtratt as a residual driver, not unknown", () => {
    const r = normalizeForConfounders(makeInput({ tenureForm: "Tomträtt" }));
    expect(r.residualDrivers).toContain("tomtratt");
    expect(r.unknownConfounders).not.toContain("tomtratt_unknown");
  });

  it("tenureForm 'Bostadsrätt' (the only value ever observed live) is unknown, never a residual driver", () => {
    const r = normalizeForConfounders(makeInput({ tenureForm: "Bostadsrätt" }));
    expect(r.unknownConfounders).toContain("tomtratt_unknown");
    expect(r.residualDrivers).not.toContain("tomtratt");
  });

  it("tenureForm null behaves identically to 'Bostadsrätt'", () => {
    const withNull = normalizeForConfounders(makeInput({ tenureForm: null }));
    const withBostadsratt = normalizeForConfounders(makeInput({ tenureForm: "Bostadsrätt" }));
    expect(withNull.unknownConfounders).toEqual(withBostadsratt.unknownConfounders);
    expect(withNull.residualDrivers).toEqual(withBostadsratt.residualDrivers);
  });
  // This test is what makes the OQ-2 inertness OBSERVABLE rather than assumed:
  // every committed tenureForm fixture across the repo is "Bostadsrätt", and
  // this suite proves that value is structurally treated as unknown, never
  // as a disproof of tomträtt.
});

describe("D-14-05 default posture", () => {
  it("canAttributeToCondition is false for every input, including the most favourable one", () => {
    const table: ConfounderGuardInput[] = [
      makeInput(),
      // The most favourable input: confident comps, BRF present, known floor
      // and balcony, shallow discount.
      makeInput({
        pricePerSqm: 90_000,
        floor: 3,
        balcony: true,
        tenureForm: "Bostadsrätt",
        brf: makeBrf({ skuldPerKvm: 2_000 }),
        comps: makeComps({ confident: true, renovatedMedianPerSqm: 100_000 }),
      }),
      makeInput({ pricePerSqm: 50_000, floor: 0, brf: makeBrf({ skuldPerKvm: 20_000 }), comps: makeComps() }),
      makeInput({ comps: makeComps({ sampleSize: 4, confident: false }) }),
      makeInput({ pricePerSqm: 120_000, comps: makeComps({ renovatedMedianPerSqm: 100_000 }) }),
      makeInput({ tenureForm: "Tomträtt", floor: 1, balcony: false }),
    ];
    for (const input of table) {
      const r = normalizeForConfounders(input);
      expect(r.canAttributeToCondition).toBe(false);
      expect(r.unknownConfounders).toContain("elevator_unknown");
      expect(r.unknownConfounders).toContain("micro_location_unknown");
      expect(r.unknownConfounders).toContain("sub_area_unknown");
    }
  });
  // Intentional this phase (D-14-05): elevator + micro-location are never
  // fetched, so "cannot attribute to condition" is always the posture.
});

describe("never throws / never fabricates", () => {
  it("an all-null input returns a fully-formed result with no throw", () => {
    expect(() => normalizeForConfounders(makeInput())).not.toThrow();
    const r = normalizeForConfounders(makeInput());
    expect(r.discountVsRenovatedPct).toBeNull();
    expect(r.conditionExplainedPct).toBeNull();
    expect(r.confidence).toBe("low");
  });
});

// Sanity check that HIGH_BRF_DEBT_PER_SQM / DISCOUNT_ATTRIBUTION_TRIGGER_PCT
// are the exact SPEC-locked values these tests rely on.
describe("SPEC-locked constants sanity", () => {
  it("matches the SPEC-locked values", () => {
    expect(DISCOUNT_ATTRIBUTION_TRIGGER_PCT).toBe(0.25);
    expect(MAX_CONDITION_EXPLAINED_PCT).toBe(0.2);
    expect(HIGH_BRF_DEBT_PER_SQM).toBe(15_000);
  });
});

function briefFrom(overrides: Partial<ConfounderGuardInput> = {}) {
  const input = makeInput(overrides);
  const guard = normalizeForConfounders(input);
  const briefInput: BuildHolisticBriefInput = {
    guard,
    comps: input.comps,
    brf: input.brf,
    pricePerSqm: input.pricePerSqm,
  };
  return buildHolisticBrief(briefInput);
}

describe("buildHolisticBrief — ANL-01 non-empty guarantee + the LOW kr/m² ≠ RENO OBJECT guard", () => {
  it("returns items.length >= 1 for an all-null input, whose single item is insufficient-data", () => {
    const brief = briefFrom();
    expect(brief.items.length).toBeGreaterThanOrEqual(1);
    expect(brief.items).toHaveLength(1);
    expect(brief.items[0].kind).toBe("insufficient-data");
  });

  it("returns items.length >= 1 for at least four further input shapes", () => {
    const shapes: Partial<ConfounderGuardInput>[] = [
      { pricePerSqm: 90_000, comps: makeComps({ renovatedMedianPerSqm: 100_000 }) },
      { brf: makeBrf({ avgiftsniva: 3_800 }) },
      { pricePerSqm: 50_000, floor: 0, brf: makeBrf({ skuldPerKvm: 20_000 }), comps: makeComps() },
      { floor: 2, balcony: false },
    ];
    for (const overrides of shapes) {
      expect(briefFrom(overrides).items.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("marker is always HOLISTIC_DATA_ONLY_MARKER and confidence equals the guard's", () => {
    const overrides = { pricePerSqm: 90_000, comps: makeComps({ renovatedMedianPerSqm: 100_000 }) };
    const guard = normalizeForConfounders(makeInput(overrides));
    const brief = briefFrom(overrides);
    expect(brief.marker).toBe(HOLISTIC_DATA_ONLY_MARKER);
    expect(brief.confidence).toBe(guard.confidence);
  });

  it("a comps-present input produces a comps-positioning item naming the sample size", () => {
    const comps = makeComps({ renovatedMedianPerSqm: 100_000, sampleSize: 7 });
    const brief = briefFrom({ pricePerSqm: 90_000, comps });
    const item = brief.items.find((i) => i.kind === "comps-positioning");
    expect(item).toBeDefined();
    expect(item!.text).toContain(String(comps.sampleSize));
  });

  it("a brf-present input produces a brf item mentioning the avgift figure and the fiscalYear", () => {
    const brf = makeBrf({ avgiftsniva: 4_200, fiscalYear: 2024, stambytePlanerat: null });
    const brief = briefFrom({ brf });
    const item = brief.items.find((i) => i.kind === "brf");
    expect(item).toBeDefined();
    expect(item!.text).toContain("4200");
    expect(item!.text).toContain("2024");
  });

  it("a deep-discount input's conditionAttribution is capped at exactly 0.2", () => {
    const brief = briefFrom({ pricePerSqm: 70_000, comps: makeComps({ renovatedMedianPerSqm: 100_000 }) });
    expect(brief.conditionAttribution.capped).toBe(true);
    expect(brief.conditionAttribution.explainedPct).toBe(0.2);
  });

  it("no item text — across a table of at least eight varied inputs — ever implies low kr/m² means a renovation object", () => {
    const table: Partial<ConfounderGuardInput>[] = [
      {},
      { pricePerSqm: 90_000, comps: makeComps({ renovatedMedianPerSqm: 100_000 }) },
      { pricePerSqm: 40_000, comps: makeComps({ renovatedMedianPerSqm: 100_000 }) }, // deep discount, very low kr/m²
      { brf: makeBrf({ avgiftsniva: 3_800, skuldPerKvm: 25_000 }) },
      { pricePerSqm: 50_000, floor: 0, brf: makeBrf({ skuldPerKvm: 20_000 }), comps: makeComps() },
      { floor: 2, balcony: false, tenureForm: "Tomträtt" },
      { pricePerSqm: 60_000, brf: makeBrf({ skuldPerKvm: 8_000 }), comps: makeComps({ sampleSize: 4, confident: false }) },
      { livingArea: 15, pricePerSqm: 200_000 },
    ];
    for (const overrides of table) {
      const brief = briefFrom(overrides);
      const concatenated = brief.items.map((i) => i.text).join(" ");
      for (const pattern of BANNED_RENO_ATTRIBUTION_PATTERNS) {
        expect(concatenated).not.toMatch(pattern);
      }
      expect(concatenated).not.toContain("renoveringsobjekt");
    }
  });

  it("RENO_ATTRIBUTION_FALLBACK_TEXT itself is clean against every banned pattern", () => {
    for (const pattern of BANNED_RENO_ATTRIBUTION_PATTERNS) {
      expect(RENO_ATTRIBUTION_FALLBACK_TEXT).not.toMatch(pattern);
    }
  });

  it("exercises the drop-and-replace enforcement branch: a brf item whose composed text would contain the banned word is replaced entirely", () => {
    // stambytePlanerat is a free string field the builder concatenates
    // verbatim into the brf item's text — feeding a banned word through it
    // proves the enforcement path replaces, not merely permits, bad text.
    const brf = makeBrf({ stambytePlanerat: "Föreningen klassas som ett renoveringsobjekt enligt senaste protokollet" });
    const brief = briefFrom({ brf });
    const item = brief.items.find((i) => i.kind === "brf");
    expect(item).toBeDefined();
    expect(item!.text).toBe(RENO_ATTRIBUTION_FALLBACK_TEXT);
    expect(item!.text).not.toContain("renoveringsobjekt");
  });
});
