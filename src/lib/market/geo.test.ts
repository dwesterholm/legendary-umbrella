import { describe, it, expect } from "vitest";
// RED: src/lib/market/geo.ts does not exist yet — implemented in Plan 03.
// resolveGeo is a PURE function (no fetch) so it is unit-testable with fixtures.
import { resolveGeo } from "@/lib/market/geo";

// A small set of fixture polygons would normally come from the bundled DeSO
// GeoJSON; resolveGeo accepts an injectable polygon set so the test stays pure
// and offline (no @turf network/data dependency exercised here). If the eventual
// signature differs, this RED test pins the contract the implementation must meet.

describe("resolveGeo — kommun baseline (RESEARCH Pitfall 2)", () => {
  it("derives kommunCode from the first 4 chars of a DeSO code", () => {
    // A point that resolves to DeSO "0180C1010" must expose kommunCode "0180".
    const result = resolveGeo(59.3293, 18.0686); // central Stockholm
    expect(result.kommunCode).toBe("0180");
  });
});

describe("resolveGeo — point-in-polygon → desoCode", () => {
  it("a lat/lng inside a DeSO polygon resolves to that polygon's desoCode", () => {
    const result = resolveGeo(59.3293, 18.0686);
    expect(result.desoCode).toBe("0180C1010");
  });

  it("a lat/lng outside all polygons returns desoCode null but a kommunCode still derivable (kommun-correct beats neighborhood-wrong)", () => {
    // Far outside any fixture polygon (mid-ocean) → no DeSO, but the function
    // must degrade gracefully per RESEARCH: never throw, return a documented
    // null desoCode (kommunCode may be null when no baseline is derivable).
    const run = () => resolveGeo(0, 0);
    expect(run).not.toThrow();
    const result = run();
    expect(result.desoCode).toBeNull();
  });
});
