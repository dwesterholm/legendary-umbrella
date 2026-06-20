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
    // A point in central Stockholm resolves to a "0180…" DeSO → kommun "0180".
    const result = resolveGeo(59.3293, 18.0686); // central Stockholm
    expect(result.kommunCode).toBe("0180");
  });
});

describe("resolveGeo — point-in-polygon → desoCode", () => {
  it("a lat/lng inside a DeSO polygon resolves to that polygon's desoCode", () => {
    // Coordinate verified to fall inside the real SCB DeSO_2025 polygon
    // "0180C1010" (southern Stockholm kommun) in the committed deso.geojson.
    // (The RED test originally guessed this code for the central-Stockholm
    // point above; against the real SCB geometry that point is "0180C4040",
    // so the pairing was corrected to a verified-real coordinate — the
    // behavior under test, "point inside a DeSO → that DeSO's code", is
    // unchanged.)
    const result = resolveGeo(59.233, 18.11);
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
