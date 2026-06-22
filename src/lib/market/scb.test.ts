import { describe, it, expect } from "vitest";
// RED: src/lib/market/scb.ts does not exist yet — implemented in Plan 03/05.
import { normalizeScbOutput } from "@/lib/market/scb";
// The committed json-stat2 fixtures (offline; tests make no live SCB calls).
import scbPopulation from "./__fixtures__/scb-population.json";
import scbTenure from "./__fixtures__/scb-tenure.json";

describe("normalizeScbOutput — json-stat2 → four-metric shape (RESEARCH Code Examples + Pitfall 3)", () => {
  it("parses the population json-stat2 fixture into the normalized shape with population present", () => {
    const result = normalizeScbOutput(scbPopulation as unknown);
    // Population is the control metric — must be present and a finite number.
    expect(result.population).not.toBeNull();
    expect(Number.isFinite(result.population as number)).toBe(true);
    // Age breakdown is present (the fixture carries an Alder dimension).
    expect(result.age).not.toBeNull();
  });

  it("normalizes an absent metric (income missing at DeSO) to null, never throwing (D-06/D-08)", () => {
    // The fixture deliberately omits income (Pitfall 3: income lags / may be
    // absent at a given geography/year). The normalizer must surface null for
    // that metric rather than throwing or fabricating a value.
    const run = () => normalizeScbOutput(scbPopulation as unknown);
    expect(run).not.toThrow();
    const result = run();
    expect(result.income).toBeNull();
  });

  it("is tolerant of a malformed / empty json-stat2 payload — every metric null, never throws", () => {
    const run = () => normalizeScbOutput({} as unknown);
    expect(run).not.toThrow();
    const result = run();
    expect(result.population).toBeNull();
    expect(result.income).toBeNull();
    expect(result.tenure).toBeNull();
  });
});

describe("normalizeScbOutput — tenure / upplåtelseform (WR-04 regression)", () => {
  it("parses the tenure json-stat2 fixture into a per-form mix (only the four COMPONENT forms, no TOTALT)", () => {
    const result = normalizeScbOutput(scbTenure as unknown);
    // The tenure metric is present; population/income are absent in this fixture.
    expect(result.tenure).not.toBeNull();
    expect(result.population).toBeNull();
    expect(result.income).toBeNull();
    const tenure = result.tenure as Record<string, number>;
    // The four component forms are the dimension members — never a "TOTALT"
    // aggregate (which omitting Upplatelseform would have summed in, WR-04).
    expect(Object.keys(tenure)).not.toContain("TOTALT");
    // Real (redacted) values: BOSTADSRÄTT=1275, HYRESRÄTT=315, ÖVRIGT=26.
    expect(tenure["BOSTADSRÄTT"]).toBe(1275);
    expect(tenure["HYRESRÄTT"]).toBe(315);
    expect(tenure["ÖVRIGT"]).toBe(26);
  });

  it("tolerates a suppressed (null) tenure cell — that form is simply absent, never NaN, never throws", () => {
    const run = () => normalizeScbOutput(scbTenure as unknown);
    expect(run).not.toThrow();
    const tenure = run().tenure as Record<string, number>;
    // ÄG/ANDEL is null (SCB cell suppression) → omitted, not 0/NaN.
    expect("ÄG/ANDEL" in tenure).toBe(false);
    for (const v of Object.values(tenure)) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});
