import { describe, it, expect } from "vitest";
import { normalizeSoldOutput, type SoldComp } from "@/lib/market/sold-schema";
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
