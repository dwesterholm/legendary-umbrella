import { describe, it, expect } from "vitest";
import {
  safeParseAreaData,
  type AreaData,
} from "@/lib/market/scb-schema";

describe("safeParseAreaData — persisted area_data read-guard (AREA-01, mirrors safeParseBrfData)", () => {
  // A complete, valid AreaData payload — the durable cache-of-record the page
  // reads back from the area_data jsonb column (D-08/D-09).
  const fullData: AreaData = {
    geo: {
      kommunCode: "0180",
      desoCode: "0180C1010",
      level: "deso",
    },
    metrics: {
      population: 1842,
      age: { "0-19": 320, "20-64": 1100, "65+": 422 },
      income: 412000,
      tenure: { BOSTADSRÄTT: 1275, HYRESRÄTT: 315, ÖVRIGT: 26 },
    },
    years: {
      population: "2024",
      income: "2022",
      tenure: "2023",
    },
    source: "SCB PxWebApi",
    fetchedAt: "2026-06-22T10:30:00Z",
  };

  it("round-trips a complete valid AreaData object unchanged (typed equality)", () => {
    const result = safeParseAreaData(fullData);
    expect(result).not.toBeNull();
    expect(result).toEqual(fullData);
    expect(result?.geo.level).toBe("deso");
    expect(result?.metrics.tenure?.["BOSTADSRÄTT"]).toBe(1275);
  });

  it("treats all-null metrics as VALID — the honest sparse-area contract (D-06)", () => {
    // A sparse area legitimately has every metric null (SCB suppression / absent
    // table). That is a valid cached row, NOT a parse failure → must round-trip.
    const sparse: AreaData = {
      geo: { kommunCode: "0180", desoCode: null, level: "kommun" },
      metrics: {
        population: null,
        age: null,
        income: null,
        tenure: null,
      },
      years: { population: null, income: null, tenure: null },
      source: "SCB PxWebApi",
      fetchedAt: "2026-06-22T10:30:00Z",
    };
    const result = safeParseAreaData(sparse);
    expect(result).not.toBeNull();
    expect(result).toEqual(sparse);
    expect(result?.metrics.population).toBeNull();
    expect(result?.metrics.tenure).toBeNull();
  });

  it("returns null for null and undefined (not enriched yet)", () => {
    expect(safeParseAreaData(null)).toBeNull();
    expect(safeParseAreaData(undefined)).toBeNull();
  });

  it("returns null for non-object primitives (string, number, boolean)", () => {
    expect(safeParseAreaData("area_data")).toBeNull();
    expect(safeParseAreaData(0)).toBeNull();
    expect(safeParseAreaData(false)).toBeNull();
  });

  // Strip a single top-level key from a clone without an unused-binding warning.
  const without = (key: keyof AreaData) => {
    const clone: Record<string, unknown> = { ...fullData };
    delete clone[key];
    return clone;
  };

  it("returns null and NEVER throws on a missing required `geo` block", () => {
    const noGeo = without("geo");
    expect(() => safeParseAreaData(noGeo)).not.toThrow();
    expect(safeParseAreaData(noGeo)).toBeNull();
  });

  it("returns null and NEVER throws on an out-of-enum geo.level", () => {
    const badLevel = { ...fullData, geo: { ...fullData.geo, level: "street" } };
    expect(() => safeParseAreaData(badLevel)).not.toThrow();
    expect(safeParseAreaData(badLevel)).toBeNull();
  });

  it("returns null and NEVER throws on a missing required `source`", () => {
    const noSource = without("source");
    expect(() => safeParseAreaData(noSource)).not.toThrow();
    expect(safeParseAreaData(noSource)).toBeNull();
  });

  it("returns null and NEVER throws on a missing required `fetchedAt`", () => {
    const noFetchedAt = without("fetchedAt");
    expect(() => safeParseAreaData(noFetchedAt)).not.toThrow();
    expect(safeParseAreaData(noFetchedAt)).toBeNull();
  });
});
