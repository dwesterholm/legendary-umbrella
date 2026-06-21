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
