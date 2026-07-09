import { describe, it, expect } from "vitest";
import {
  normalizePolicyRate,
  normalizeInflation,
  normalizeRegionalPrice,
  macroDataSchema,
  safeParseMacroData,
  type MacroData,
} from "@/lib/market/macro-schema";
import riksbankPolicyRate from "./__fixtures__/riksbank-policy-rate.json";
import scbCpif from "./__fixtures__/scb-cpif.json";
import scbBo0501cLan from "./__fixtures__/scb-bo0501c-lan.json";

describe("normalize — live-shaped Riksbank/SCB fixtures (MACRO-01)", () => {
  it("normalizePolicyRate parses the Riksbank flat {date,value} fixture", () => {
    const result = normalizePolicyRate(riksbankPolicyRate as unknown);
    expect(result.value).toBe(1.75);
    expect(result.date).toBe("2026-07-06");
  });

  it("normalizePolicyRate degrades malformed/empty input to all-null, never throws", () => {
    const run = () => normalizePolicyRate({} as unknown);
    expect(run).not.toThrow();
    const result = run();
    expect(result.value).toBeNull();
    expect(result.date).toBeNull();
  });

  it("normalizeInflation parses the CPIF json-stat2 fixture (annual change %, period)", () => {
    const result = normalizeInflation(scbCpif as unknown);
    expect(result.value).toBe(1.4);
    expect(result.period).toBe("2026M05");
  });

  it("normalizeInflation degrades an absent/malformed value to all-null, never throws", () => {
    const run = () => normalizeInflation({} as unknown);
    expect(run).not.toThrow();
    const result = run();
    expect(result.value).toBeNull();
    expect(result.period).toBeNull();
  });

  it("CR-02: normalizeInflation recovers the last NON-null value when the latest queried period is null-padded (not-yet-published)", () => {
    const trailingNullFixture = {
      class: "dataset",
      id: ["ContentsCode", "Tid"],
      size: [1, 2],
      dimension: {
        Tid: { category: { index: { "2026M05": 0, "2026M06": 1 } } },
      },
      value: [1.4, null],
    };
    const result = normalizeInflation(trailingNullFixture as unknown);
    expect(result.value).toBe(1.4);
    expect(result.period).toBe("2026M05");
  });

  it("normalizeRegionalPrice parses the BO0501C län-level fixture, taking the latest year as preliminary", () => {
    const result = normalizeRegionalPrice(scbBo0501cLan as unknown);
    expect(result.value).toBe(3500);
    expect(result.year).toBe("2025");
    expect(result.preliminary).toBe(true);
  });

  it("normalizeRegionalPrice degrades an absent/malformed payload to all-null, never throws", () => {
    const run = () => normalizeRegionalPrice({} as unknown);
    expect(run).not.toThrow();
    const result = run();
    expect(result.value).toBeNull();
    expect(result.year).toBeNull();
    expect(result.preliminary).toBeNull();
  });

  it("CR-02: normalizeRegionalPrice recovers the last NON-null value when the latest queried year is null-padded (not-yet-computed), and does NOT mark the recovered (older, final) year as preliminary", () => {
    const trailingNullFixture = {
      class: "dataset",
      id: ["Region", "ContentsCode", "Tid"],
      size: [1, 1, 2],
      dimension: {
        Tid: { category: { index: { "2024": 0, "2025": 1 } } },
      },
      value: [3400, null],
      note: ["Most recent year's figures are preliminary."],
    };
    const result = normalizeRegionalPrice(trailingNullFixture as unknown);
    expect(result.value).toBe(3400);
    expect(result.year).toBe("2024");
    expect(result.preliminary).toBe(false);
  });

  it("WR-04: normalizeRegionalPrice reads `note` from the safeParsed stat (schema boundary), not the unvalidated raw arg", () => {
    const fixture = {
      class: "dataset",
      id: ["Region", "ContentsCode", "Tid"],
      size: [1, 1, 1],
      dimension: {
        Tid: { category: { index: { "2025": 0 } } },
      },
      value: [3500],
      note: ["Most recent year's figures are preliminary."],
    };
    const result = normalizeRegionalPrice(fixture as unknown);
    expect(result.preliminary).toBe(true);
  });
});

describe("macroDataSchema — schema shape (MACRO-02 no-prediction enforcement)", () => {
  const fullData: MacroData = {
    policyRate: { value: 1.75, date: "2026-07-06", source: "Riksbank" },
    inflation: { value: 1.4, period: "2026M05", source: "SCB", measure: "KPIF" },
    regionalPrice: {
      value: 3500,
      year: "2025",
      preliminary: true,
      regionCode: "01",
      source: "SCB",
    },
  };

  it("safeParse of a fully-populated MacroData object succeeds", () => {
    const result = macroDataSchema.safeParse(fullData);
    expect(result.success).toBe(true);
  });

  it("has NO key named direction/trend/magnitude/forecast/outlook/deltaPct anywhere in its shape", () => {
    const banned = [
      "direction",
      "trend",
      "magnitude",
      "forecast",
      "outlook",
      "deltaPct",
    ];
    const json = JSON.stringify(fullData).toLowerCase();
    for (const key of banned) {
      expect(json).not.toContain(key.toLowerCase());
    }
    // Also assert directly against the schema's declared shape keys.
    const shape = macroDataSchema.shape;
    expect(Object.keys(shape)).not.toEqual(
      expect.arrayContaining(banned),
    );
  });

  it("safeParseMacroData returns null on malformed input (defensive read guard)", () => {
    expect(safeParseMacroData(null)).toBeNull();
    expect(safeParseMacroData(undefined)).toBeNull();
    expect(safeParseMacroData("not an object")).toBeNull();
    expect(safeParseMacroData({ policyRate: "bad" })).toBeNull();
  });

  it("safeParseMacroData round-trips a valid MacroData object", () => {
    const result = safeParseMacroData(fullData);
    expect(result).toEqual(fullData);
  });
});
