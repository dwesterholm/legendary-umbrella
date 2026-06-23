import { describe, it, expect } from "vitest";
import {
  normalizeSoldOutput,
  safeParsePriceData,
  type PriceData,
  type SoldComp,
} from "@/lib/market/sold-schema";
// The committed fixture is a REAL redacted Booli slutpriser payload stored in the
// TRUE live shape: `{ items: [{ hasApollo, __APOLLO_STATE__ }] }` — the exact
// shape `fetchSoldComps` returns (an array of Apify dataset items). Tests run
// offline; no live source calls.
import soldFixture from "./__fixtures__/sold-comps.json";

const items = (soldFixture as { items: unknown[] }).items;

/** Usable = a finite positive pris/kvm AND a parseable sold date (the enrich gate). */
function usable(comps: SoldComp[]): SoldComp[] {
  return comps.filter(
    (c) =>
      typeof c.prisPerKvm === "number" &&
      Number.isFinite(c.prisPerKvm) &&
      (c.prisPerKvm ?? 0) > 0 &&
      !!c.soldDate &&
      Number.isFinite(Date.parse(c.soldDate)),
  );
}

describe("normalizeSoldOutput — live shape (Apify dataset-item array)", () => {
  it("normalizes the live ARRAY of `{ hasApollo, __APOLLO_STATE__ }` items into usable comps (regression: the array shape previously yielded 0 → false 'thin')", () => {
    // This is the exact value `fetchSoldComps` resolves to.
    const comps = normalizeSoldOutput(items);
    expect(comps.length).toBeGreaterThan(2); // clears the thinMaxComps=2 gate
    const u = usable(comps);
    expect(u.length).toBeGreaterThan(2);
    // The comparison axis (D-03) is present on the usable comps.
    expect(typeof u[0].prisPerKvm).toBe("number");
    expect(u[0].soldDate).toBeTruthy();
  });

  it("still accepts a single dataset-item wrapper object `{ hasApollo, __APOLLO_STATE__ }`", () => {
    const comps = normalizeSoldOutput(items[0]);
    expect(comps.length).toBeGreaterThan(2);
  });

  it("still accepts a bare `{ __APOLLO_STATE__ }` payload (back-compat)", () => {
    const bare = { __APOLLO_STATE__: (items[0] as { __APOLLO_STATE__: unknown }).__APOLLO_STATE__ };
    const comps = normalizeSoldOutput(bare);
    expect(comps.length).toBeGreaterThan(2);
  });

  it("merges comps across multiple dataset items (paginated render)", () => {
    const single = normalizeSoldOutput([items[0]]);
    const doubled = normalizeSoldOutput([items[0], items[0]]);
    expect(doubled.length).toBe(single.length * 2);
  });

  it("is null-tolerant: a malformed / empty input yields [] and never throws", () => {
    expect(() => normalizeSoldOutput(null)).not.toThrow();
    expect(normalizeSoldOutput(null)).toEqual([]);
    expect(normalizeSoldOutput([])).toEqual([]);
    expect(normalizeSoldOutput([{ hasApollo: false, __APOLLO_STATE__: null }])).toEqual([]);
  });
});

describe("normalizeSoldOutput — deterministic displayAttributes variant pick (WR-05)", () => {
  // A SoldProperty entry carrying TWO displayAttributes(...) variants: a
  // non-SERP detail-page variant (no pris/kvm dataPoint) and the SERP variant
  // (which carries pris/kvm). A first-by-insertion-order prefix match could pick
  // the detail variant and drop the comp; the deterministic pick must prefer SERP.
  const twoVariantState = {
    "SoldProperty:1": {
      __typename: "SoldProperty",
      soldDate: "2026-03-01",
      // Non-SERP variant inserted FIRST — must NOT win.
      'displayAttributes({"queryContext":"DETAIL_PAGE"})': {
        dataPoints: [{ value: { plainText: "99 m²" } }],
      },
      // SERP variant carries the pris/kvm dataPoint.
      'displayAttributes({"queryContext":"SERP_LIST_LISTING"})': {
        dataPoints: [{ value: { plainText: "85 000 kr/m²" } }],
      },
    },
  };

  it("prefers the SERP_LIST_LISTING variant so the pris/kvm dataPoint is never dropped", () => {
    const comps = normalizeSoldOutput({ __APOLLO_STATE__: twoVariantState });
    expect(comps).toHaveLength(1);
    expect(comps[0].prisPerKvm).toBe(85000);
  });

  it("is order-independent: the same entry with variants in reverse insertion order yields the same comp", () => {
    const reversed = {
      "SoldProperty:1": {
        __typename: "SoldProperty",
        soldDate: "2026-03-01",
        'displayAttributes({"queryContext":"SERP_LIST_LISTING"})': {
          dataPoints: [{ value: { plainText: "85 000 kr/m²" } }],
        },
        'displayAttributes({"queryContext":"DETAIL_PAGE"})': {
          dataPoints: [{ value: { plainText: "99 m²" } }],
        },
      },
    };
    const comps = normalizeSoldOutput({ __APOLLO_STATE__: reversed });
    expect(comps[0].prisPerKvm).toBe(85000);
    // The m² dataPoint from the non-SERP variant is still merged (livingArea).
    expect(comps[0].livingArea).toBe(99);
  });
});

describe("safeParsePriceData — persisted price_data read-guard (PRICE-01, CR-01 / RESEARCH Pattern 4)", () => {
  // A complete, valid `ok`-state PriceData payload — the happy path the page
  // reads back from the price_data jsonb column.
  const okData: PriceData = {
    reason: "ok",
    areaAvg: 88000,
    deltaPct: 8.2,
    min: 85000,
    max: 90000,
    trendSlope: 12.5,
    sampleSize: 5,
    tier: "neighborhood",
    confidence: 0.81,
    comps: [
      {
        prisPerKvm: 85000,
        soldDate: "2026-01-15",
        soldPrice: 5280000,
        soldVsListPct: 3.5,
        objectType: "Lägenhet",
        livingArea: 62,
        rooms: 2,
        floor: "vån 3",
        daysActive: 14,
      },
      { prisPerKvm: 90000, soldDate: "2026-05-19" },
    ],
    source: "Booli",
    sourceLabel: "sålda bostäder",
    recency: "senaste 24 mån",
  };

  it("round-trips a valid `ok`-state PriceData object unchanged (typed equality)", () => {
    const result = safeParsePriceData(okData);
    expect(result).not.toBeNull();
    expect(result).toEqual(okData);
    // The discriminator and the D-05 receipt array survive the round-trip.
    expect(result?.reason).toBe("ok");
    expect(result?.comps).toHaveLength(2);
    expect(result?.comps[0].prisPerKvm).toBe(85000);
  });

  it("round-trips a non-`ok` honest-state payload (source_unavailable, nullable figures)", () => {
    // The honest-state contract: a dead/unparseable source persists with the
    // reason discriminator + all figures null, NOT a fabricated comparison.
    const honest: PriceData = {
      reason: "source_unavailable",
      areaAvg: null,
      deltaPct: null,
      min: null,
      max: null,
      trendSlope: null,
      sampleSize: 0,
      tier: null,
      confidence: 0,
      comps: [],
      source: null,
      sourceLabel: null,
      recency: null,
    };
    const result = safeParsePriceData(honest);
    expect(result).not.toBeNull();
    expect(result).toEqual(honest);
    expect(result?.reason).toBe("source_unavailable");
    expect(result?.comps).toEqual([]);
  });

  it("returns null for null and undefined (not analysed yet)", () => {
    expect(safeParsePriceData(null)).toBeNull();
    expect(safeParsePriceData(undefined)).toBeNull();
  });

  it("returns null for non-object primitives (string, number, boolean)", () => {
    expect(safeParsePriceData("price_data")).toBeNull();
    expect(safeParsePriceData(42)).toBeNull();
    expect(safeParsePriceData(true)).toBeNull();
  });

  // Strip a single key from a clone without an unused-binding lint warning.
  const without = (key: keyof PriceData) => {
    const clone: Record<string, unknown> = { ...okData };
    delete clone[key];
    return clone;
  };

  it("returns null and NEVER throws on a missing required `reason`", () => {
    const noReason = without("reason");
    expect(() => safeParsePriceData(noReason)).not.toThrow();
    expect(safeParsePriceData(noReason)).toBeNull();
  });

  it("returns null and NEVER throws on an out-of-enum `reason`", () => {
    const badReason = { ...okData, reason: "exploded" };
    expect(() => safeParsePriceData(badReason)).not.toThrow();
    expect(safeParsePriceData(badReason)).toBeNull();
  });

  it("returns null and NEVER throws on a missing required `sampleSize`", () => {
    const noSample = without("sampleSize");
    expect(() => safeParsePriceData(noSample)).not.toThrow();
    expect(safeParsePriceData(noSample)).toBeNull();
  });

  it("returns null and NEVER throws on a missing required `confidence`", () => {
    const noConfidence = without("confidence");
    expect(() => safeParsePriceData(noConfidence)).not.toThrow();
    expect(safeParsePriceData(noConfidence)).toBeNull();
  });

  it("returns null and NEVER throws on a wrong type for a required field (sampleSize as string)", () => {
    const wrongType = { ...okData, sampleSize: "five" };
    expect(() => safeParsePriceData(wrongType)).not.toThrow();
    expect(safeParsePriceData(wrongType)).toBeNull();
  });

  it("returns null and NEVER throws on a shape-drifted comps receipt (comp missing required prisPerKvm)", () => {
    const driftedComp = {
      ...okData,
      comps: [{ soldDate: "2026-01-15" }],
    };
    expect(() => safeParsePriceData(driftedComp)).not.toThrow();
    expect(safeParsePriceData(driftedComp)).toBeNull();
  });
});
