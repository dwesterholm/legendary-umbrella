import { describe, it, expect } from "vitest";
import {
  normalizeForConfounders,
  buildHolisticBrief,
  applyBannedAttributionGuard,
  BANNED_RENO_ATTRIBUTION_PATTERNS,
  RENO_ATTRIBUTION_FALLBACK_TEXT,
  BRF_OUT_OF_BAND_FIGURE_TEXT,
  BRF_LOW_CONFIDENCE_FIGURE_TEXT,
  MAX_CONDITION_EXPLAINED_PCT,
  DISCOUNT_ATTRIBUTION_TRIGGER_PCT,
  HIGH_BRF_DEBT_PER_SQM,
  IMPLAUSIBLE_BRF_DEBT_PER_SQM,
  type ConfounderGuardInput,
  type BuildHolisticBriefInput,
} from "@/lib/discovery/confounder-guard";
import { MIN_COMPS_FOR_CONFIDENCE } from "@/lib/discovery/area-comps";
import { BRF_SANITY_BANDS } from "@/lib/brf/sanity";
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
    // CR-01: avgiftsniva is SEK/m² PER YEAR with a 300-1200 plausible band
    // (sanity.ts:27); 650 is a monthly-total-shaped fixture within that band
    // — this is what made CR-01's ~6x kr/mån mislabeling survive review, so
    // it stays the default going forward.
    avgiftsniva: 650,
    kassaflode: 100_000,
    stambytePlanerat: null,
    tomtratt: null,
    fiscalYear: 2025,
    source: "allabrf",
    fieldConfidence: { skuldPerKvm: 0.9, avgiftsniva: 0.9, kassaflode: 0.8 },
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
    // NOTE (CR-02 re-review): 20_000 sits outside BRF_SANITY_BANDS.skuldPerKvm
    // (max 15_000) but well inside IMPLAUSIBLE_BRF_DEBT_PER_SQM (60_000), so
    // it is a real, usable high-debt reading whether its confidence arrives
    // trusted (as makeBrf's 0.9 default) or band-downgraded to 0.2 — see the
    // dedicated reachability test in the CR-02 block below.
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
      // Out-of-band but plausible (see the CR-02 note above) — a real
      // high-debt reading, usable for arithmetic.
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
      // Out-of-band but plausible (see the CR-02 note above).
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

describe("CR-02 — an untrusted BRF debt figure never reaches the discount math", () => {
  it("ANL-04 keystone: an out-of-band skuldPerKvm at low confidence is excluded from the math AND the §2.6 cap still fires on the genuinely deep discount", () => {
    // Before this fix, this exact input produced deepDiscount === false and
    // no cap: 60_000 + 480_000 = 540_000 effective, far ABOVE the 100_000
    // renovated median, making discountVsRenovatedPct strongly negative.
    const r = normalizeForConfounders(
      makeInput({
        pricePerSqm: 60_000,
        comps: makeComps({ renovatedMedianPerSqm: 100_000 }),
        brf: makeBrf({ skuldPerKvm: 480_000, fieldConfidence: { skuldPerKvm: 0.2, avgiftsniva: 0.9, kassaflode: 0.8 } }),
      }),
    );
    expect(r.debtIncluded).toBe(false);
    expect(r.effectivePricePerSqm).toBe(60_000);
    expect(r.deepDiscount).toBe(true);
    expect(r.conditionExplainedPct).toBe(MAX_CONDITION_EXPLAINED_PCT);
    expect(r.conditionCapApplied).toBe(true);
  });

  it("the same debt figure at trusted confidence IS admitted into the math", () => {
    const r = normalizeForConfounders(
      makeInput({
        pricePerSqm: 60_000,
        comps: makeComps({ renovatedMedianPerSqm: 100_000 }),
        brf: makeBrf({ skuldPerKvm: 8_000, fieldConfidence: { skuldPerKvm: 0.9, avgiftsniva: 0.9, kassaflode: 0.8 } }),
      }),
    );
    expect(r.debtIncluded).toBe(true);
    expect(r.effectivePricePerSqm).toBe(68_000);
  });

  it("an IMPLAUSIBLE skuldPerKvm does NOT produce brf_debt_high but DOES produce brf_unknown", () => {
    // 480_000 is the classic misextraction (total förening debt read as
    // debt/m²) — above IMPLAUSIBLE_BRF_DEBT_PER_SQM, so it is suppressed from
    // the math and routed to brf_unknown rather than asserted as an alarm.
    const r = normalizeForConfounders(
      makeInput({
        brf: makeBrf({ skuldPerKvm: 480_000, fieldConfidence: { skuldPerKvm: 0.2, avgiftsniva: 0.9, kassaflode: 0.8 } }),
      }),
    );
    expect(r.residualDrivers).not.toContain("brf_debt_high");
    expect(r.unknownConfounders).toContain("brf_unknown");
  });

  it("a sanity-band-downgraded but PLAUSIBLE skuldPerKvm produces brf_debt_high — the SPEC §2.2 flag is reachable from the real pipeline shape (CR-02 re-review)", () => {
    // This is EXACTLY the shape `scoreExtraction` -> `applySanityChecks`
    // produces for a genuinely high-debt förening: the value survives, and its
    // confidence is pinned to 0.2 purely for sitting above the 15 000 band
    // ceiling. Before the implausibility/alarm split this asserted the
    // OPPOSITE, which is what made the ANL-04 red flag structurally dead.
    const r = normalizeForConfounders(
      makeInput({
        pricePerSqm: 55_000,
        brf: makeBrf({ skuldPerKvm: 30_000, fieldConfidence: { skuldPerKvm: 0.2, avgiftsniva: 0.9, kassaflode: 0.8 } }),
      }),
    );
    expect(r.residualDrivers).toContain("brf_debt_high");
    expect(r.unknownConfounders).not.toContain("brf_unknown");
    // And it is normalized INTO the price basis, never dropped from it: a
    // dangerously indebted förening must not read as a bigger bargain.
    expect(r.debtIncluded).toBe(true);
    expect(r.effectivePricePerSqm).toBe(85_000);
  });

  it("a trusted skuldPerKvm > HIGH_BRF_DEBT_PER_SQM still produces brf_debt_high (branch preserved)", () => {
    const r = normalizeForConfounders(makeInput({ brf: makeBrf({ skuldPerKvm: 20_000 }) }));
    expect(r.residualDrivers).toContain("brf_debt_high");
  });

  it("a debt-LIGHT förening below the band's 2 000 floor is used, not suppressed (the symmetric case)", () => {
    // sanity.ts downgrades anything under 2 000 too, so before the split the
    // most attractive possible signal — a near-debt-free förening — was
    // hedged away as "outside a reasonable range".
    const r = normalizeForConfounders(
      makeInput({
        pricePerSqm: 60_000,
        brf: makeBrf({ skuldPerKvm: 0, fieldConfidence: { skuldPerKvm: 0.2, avgiftsniva: 0.9, kassaflode: 0.8 } }),
      }),
    );
    expect(r.debtIncluded).toBe(true);
    expect(r.effectivePricePerSqm).toBe(60_000);
    expect(r.residualDrivers).not.toContain("brf_debt_high");
    expect(r.unknownConfounders).not.toContain("brf_unknown");
  });

  it("an IN-BAND figure the model itself could not read stays suppressed (the confidence gate is not abandoned)", () => {
    // 8_000 is inside BRF_SANITY_BANDS, so a 0.2 here is the MODEL's own
    // low confidence, not a band downgrade — that genuinely means "we can't
    // read this" and must not enter the math.
    const r = normalizeForConfounders(
      makeInput({
        pricePerSqm: 60_000,
        brf: makeBrf({ skuldPerKvm: 8_000, fieldConfidence: { skuldPerKvm: 0.2, avgiftsniva: 0.9, kassaflode: 0.8 } }),
      }),
    );
    expect(r.debtIncluded).toBe(false);
    expect(r.effectivePricePerSqm).toBe(60_000);
    expect(r.unknownConfounders).toContain("brf_unknown");
  });

  it("buildBrfItem states a real high debt as FACT with the (högre än vanligt) flag, never as a withheld figure", () => {
    const brf = makeBrf({
      skuldPerKvm: 30_000,
      avgiftsniva: null,
      kassaflode: null,
      fieldConfidence: { skuldPerKvm: 0.2, avgiftsniva: 0.9, kassaflode: 0.8 },
    });
    const brief = briefFrom({ brf });
    const item = brief.items.find((i) => i.kind === "brf");
    expect(item).toBeDefined();
    expect(item!.text).toContain("30000 kr/kvm (högre än vanligt)");
    expect(item!.text).not.toContain(BRF_OUT_OF_BAND_FIGURE_TEXT);
    expect(item!.text).not.toContain(BRF_LOW_CONFIDENCE_FIGURE_TEXT);
  });

  it("the implausibility ceiling sits well ABOVE the SPEC §2.2 alarm threshold and above the shared sanity band", () => {
    expect(IMPLAUSIBLE_BRF_DEBT_PER_SQM).toBeGreaterThan(HIGH_BRF_DEBT_PER_SQM);
    expect(IMPLAUSIBLE_BRF_DEBT_PER_SQM).toBeGreaterThan(BRF_SANITY_BANDS.skuldPerKvm.max);
    // The alarm threshold intentionally still EQUALS the shared band ceiling —
    // the fix is that the band no longer decides usability on its own.
    expect(HIGH_BRF_DEBT_PER_SQM).toBe(BRF_SANITY_BANDS.skuldPerKvm.max);
  });

  it("brf === null pushes brf_unknown exactly once (no double push)", () => {
    const r = normalizeForConfounders(makeInput({ brf: null }));
    expect(r.unknownConfounders.filter((c) => c === "brf_unknown")).toHaveLength(1);
  });

  it("an untrusted debt figure also pushes brf_unknown exactly once", () => {
    const r = normalizeForConfounders(
      makeInput({
        brf: makeBrf({ skuldPerKvm: 8_000, fieldConfidence: { skuldPerKvm: 0.2, avgiftsniva: 0.9, kassaflode: 0.8 } }),
      }),
    );
    expect(r.unknownConfounders.filter((c) => c === "brf_unknown")).toHaveLength(1);
  });

  it("buildBrfItem suppresses an untrusted avgiftsniva figure and appends the LOW-CONFIDENCE hedge (WR-05: 900 is IN band, so no range check failed)", () => {
    const brf = makeBrf({
      avgiftsniva: 900,
      skuldPerKvm: null,
      kassaflode: null,
      fieldConfidence: { skuldPerKvm: 0.9, avgiftsniva: 0.2, kassaflode: 0.8 },
    });
    const brief = briefFrom({ brf });
    const item = brief.items.find((i) => i.kind === "brf");
    expect(item).toBeDefined();
    expect(item!.text).not.toContain("900");
    expect(item!.text).toContain(BRF_LOW_CONFIDENCE_FIGURE_TEXT);
    // Claiming a range check that never ran would be the WR-05 defect.
    expect(item!.text).not.toContain(BRF_OUT_OF_BAND_FIGURE_TEXT);
  });

  it("WR-05: an OUT-OF-BAND avgiftsniva gets the out-of-range wording instead", () => {
    const brf = makeBrf({
      avgiftsniva: 4_200, // outside the 300-1200 SEK/m²/år band (a kr/mån misread)
      skuldPerKvm: null,
      kassaflode: null,
      fieldConfidence: { skuldPerKvm: 0.9, avgiftsniva: 0.2, kassaflode: 0.8 },
    });
    const brief = briefFrom({ brf });
    const item = brief.items.find((i) => i.kind === "brf");
    expect(item).toBeDefined();
    expect(item!.text).not.toContain("4200");
    expect(item!.text).toContain(BRF_OUT_OF_BAND_FIGURE_TEXT);
    expect(item!.text).not.toContain(BRF_LOW_CONFIDENCE_FIGURE_TEXT);
  });

  it("WR-05: a suppressed kassaflode NEVER claims it was out of range — that field has no band at all", () => {
    const brf = makeBrf({
      avgiftsniva: null,
      skuldPerKvm: null,
      kassaflode: 5_000,
      fieldConfidence: { skuldPerKvm: 0.9, avgiftsniva: 0.9, kassaflode: 0.3 },
    });
    const brief = briefFrom({ brf });
    const item = brief.items.find((i) => i.kind === "brf");
    expect(item).toBeDefined();
    expect(item!.text).toContain(BRF_LOW_CONFIDENCE_FIGURE_TEXT);
    expect(item!.text).not.toContain(BRF_OUT_OF_BAND_FIGURE_TEXT);
  });

  it("buildBrfItem does NOT append the hedge text when every numeric field is simply null (nothing suppressed)", () => {
    const brf = makeBrf({
      avgiftsniva: null,
      skuldPerKvm: null,
      kassaflode: null,
      stambytePlanerat: null,
      tomtratt: true,
      fiscalYear: null,
    });
    const brief = briefFrom({ brf });
    const item = brief.items.find((i) => i.kind === "brf");
    expect(item).toBeDefined();
    expect(item!.text).not.toContain(BRF_OUT_OF_BAND_FIGURE_TEXT);
    expect(item!.text).not.toContain(BRF_LOW_CONFIDENCE_FIGURE_TEXT);
  });

  it("a brief built from a fully untrusted BRF still satisfies items.length >= 1 (ANL-01)", () => {
    const brf = makeBrf({
      avgiftsniva: 900,
      skuldPerKvm: 480_000,
      kassaflode: 1,
      fieldConfidence: { skuldPerKvm: 0.2, avgiftsniva: 0.2, kassaflode: 0.2 },
    });
    const brief = briefFrom({ brf });
    expect(brief.items.length).toBeGreaterThanOrEqual(1);
  });
});

describe("CR-01 — the avgift sentence carries the unit the field actually has", () => {
  it("states kr/kvm och år AND a derived kr/mån figure when livingArea is known", () => {
    const brf = makeBrf({ avgiftsniva: 650 });
    const brief = briefFrom({ brf, livingArea: 70 });
    const item = brief.items.find((i) => i.kind === "brf");
    expect(item).toBeDefined();
    expect(item!.text).toContain("650 kr/kvm och år");
    expect(item!.text).toContain("3792 kr/mån");
    expect(item!.text).toContain("70 kvm");
  });

  it("states ONLY kr/kvm och år, with no kr/mån substring at all, when livingArea is null", () => {
    const brf = makeBrf({ avgiftsniva: 650 });
    const brief = briefFrom({ brf, livingArea: null });
    const item = brief.items.find((i) => i.kind === "brf");
    expect(item).toBeDefined();
    expect(item!.text).toContain("650 kr/kvm och år");
    expect(item!.text).not.toContain("kr/mån");
  });

  it("guards against a livingArea of 0 — no divide-by-zero, no kr/mån substring", () => {
    const brf = makeBrf({ avgiftsniva: 650 });
    const brief = briefFrom({ brf, livingArea: 0 });
    const item = brief.items.find((i) => i.kind === "brf");
    expect(item).toBeDefined();
    expect(item!.text).not.toContain("kr/mån");
  });

  it("an untrusted avgiftsniva with a known livingArea still shows neither the raw value nor kr/mån", () => {
    const brf = makeBrf({
      avgiftsniva: 900,
      skuldPerKvm: null,
      kassaflode: null,
      fieldConfidence: { skuldPerKvm: 0.9, avgiftsniva: 0.2, kassaflode: 0.8 },
    });
    const brief = briefFrom({ brf, livingArea: 70 });
    const item = brief.items.find((i) => i.kind === "brf");
    expect(item).toBeDefined();
    expect(item!.text).not.toContain("900");
    expect(item!.text).not.toContain("kr/mån");
    expect(item!.text).toContain(BRF_LOW_CONFIDENCE_FIGURE_TEXT);
  });

  it("across a wide table of fixtures, no item text ever states a bare kr/mån without also stating kr/kvm och år", () => {
    const table: Partial<ConfounderGuardInput>[] = [
      {},
      { brf: makeBrf({ avgiftsniva: 650 }), livingArea: 70 },
      { brf: makeBrf({ avgiftsniva: 700 }), livingArea: null },
      { brf: makeBrf({ avgiftsniva: 1000, skuldPerKvm: 5_000 }), livingArea: 45 },
      { brf: makeBrf({ avgiftsniva: null }), livingArea: 60 },
      { pricePerSqm: 90_000, comps: makeComps({ renovatedMedianPerSqm: 100_000 }), livingArea: 55 },
      { pricePerSqm: 50_000, floor: 0, brf: makeBrf({ skuldPerKvm: 20_000 }), comps: makeComps(), livingArea: 80 },
      { brf: makeBrf({ avgiftsniva: 550, stambytePlanerat: "planerat" }), livingArea: 90 },
    ];
    for (const overrides of table) {
      const brief = briefFrom(overrides);
      const concatenated = brief.items.map((i) => i.text).join(" ");
      const monthlyMatches = concatenated.match(/\d+\s*kr\/mån/g) ?? [];
      if (monthlyMatches.length > 0) {
        expect(concatenated).toContain("kr/kvm och år");
      }
    }
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
    livingArea: input.livingArea,
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
      { brf: makeBrf({ avgiftsniva: 700 }) },
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
    const brf = makeBrf({ avgiftsniva: 650, fiscalYear: 2024, stambytePlanerat: null });
    const brief = briefFrom({ brf });
    const item = brief.items.find((i) => i.kind === "brf");
    expect(item).toBeDefined();
    expect(item!.text).toContain("650 kr/kvm och år");
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
      { brf: makeBrf({ avgiftsniva: 700, skuldPerKvm: 25_000 }) },
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
      // CR-03 no-raw-enum invariant: a snake_case token in Swedish prose is
      // by construction an internal identifier leak.
      expect(concatenated).not.toMatch(/[A-Za-zÅÄÖåäö]+_[A-Za-zÅÄÖåäö]+/);
    }
  });

  it("RENO_ATTRIBUTION_FALLBACK_TEXT itself is clean against every banned pattern", () => {
    for (const pattern of BANNED_RENO_ATTRIBUTION_PATTERNS) {
      expect(RENO_ATTRIBUTION_FALLBACK_TEXT).not.toMatch(pattern);
    }
  });

  // CR-03: stambytePlanerat is now a bounded enum lookup (STAMBYTE_PROSE),
  // not free-form prose, so the banned word can no longer reach the brf
  // item through this field. The drop-and-replace enforcement branch is
  // proven directly below instead.
  it("applyBannedAttributionGuard replaces banned text and passes clean text through unchanged", () => {
    expect(
      applyBannedAttributionGuard("Priset är lågt kr/kvm och det är ett renoveringsbehov enligt mäklaren."),
    ).toBe(RENO_ATTRIBUTION_FALLBACK_TEXT);
    expect(applyBannedAttributionGuard("Avgiften är låg.")).toBe("Avgiften är låg.");
  });

  it("a free-form banned string fed through stambytePlanerat is now dropped entirely, never rendered", () => {
    // stambytePlanerat is a BOUNDED ENUM lookup (STAMBYTE_PROSE) as of
    // CR-03 — a free-form string is an unmapped value and fails closed to
    // no sentence at all, so this string can no longer reach any item text.
    const freeForm = "Föreningen klassas som ett renoveringsobjekt enligt senaste protokollet";
    const brf = makeBrf({ stambytePlanerat: freeForm });
    const brief = briefFrom({ brf });
    const concatenated = brief.items.map((i) => i.text).join(" ");
    expect(concatenated).not.toContain(freeForm);
    expect(concatenated).not.toContain("Stambyte-läge");
  });
});

describe("CR-03 — stambyte renders as prose, and 'not mentioned' is not an item", () => {
  it('stambytePlanerat "planerat" renders the planned-stambyte sentence', () => {
    const brf = makeBrf({ stambytePlanerat: "planerat" });
    const brief = briefFrom({ brf });
    const item = brief.items.find((i) => i.kind === "brf");
    expect(item).toBeDefined();
    expect(item!.text).toContain("Föreningen har ett planerat stambyte.");
  });

  it('stambytePlanerat "nyligen_genomfort" renders the completed-stambyte sentence', () => {
    const brf = makeBrf({ stambytePlanerat: "nyligen_genomfort" });
    const brief = briefFrom({ brf });
    const item = brief.items.find((i) => i.kind === "brf");
    expect(item).toBeDefined();
    expect(item!.text).toContain("Föreningen har nyligen genomfört stambyte.");
  });

  it('stambytePlanerat "ej_nämnt" produces NO stambyte sentence, and with every other field null produces NO brf item at all', () => {
    const brf = makeBrf({
      stambytePlanerat: "ej_nämnt",
      avgiftsniva: null,
      skuldPerKvm: null,
      kassaflode: null,
      fiscalYear: null,
      tomtratt: null,
    });
    const brief = briefFrom({ brf });
    expect(brief.items.some((i) => i.kind === "brf")).toBe(false);
    expect(brief.items.length).toBeGreaterThanOrEqual(1);
  });

  it("an unmapped stambytePlanerat string is suppressed entirely — fails closed", () => {
    const brf = makeBrf({ stambytePlanerat: "some_unmapped_value" });
    const brief = briefFrom({ brf });
    const concatenated = brief.items.map((i) => i.text).join(" ");
    expect(concatenated).not.toContain("some_unmapped_value");
  });

  it("stambytePlanerat null is unchanged — no sentence, no throw", () => {
    const brf = makeBrf({ stambytePlanerat: null });
    expect(() => briefFrom({ brf })).not.toThrow();
    const brief = briefFrom({ brf });
    const concatenated = brief.items.map((i) => i.text).join(" ");
    expect(concatenated).not.toContain("Stambyte-läge");
  });
});
