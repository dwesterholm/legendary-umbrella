import { describe, it, expect } from "vitest";
import * as SunCalc from "suncalc";
import {
  computeSunExposure,
  extractOrientationFromDescription,
  type Facade,
} from "@/lib/discovery/sun-path";

// Stockholm, a representative northern-hemisphere lat/lon used throughout
// (matches RESEARCH.md's Code Examples and Task 1's install-time smoke check).
const STOCKHOLM_LAT = 59.33;
const STOCKHOLM_LON = 18.06;

describe("azimuth convention (Pitfall 1 — MANDATORY, must pass before any bucketing test is trusted)", () => {
  it("suncalc's getPosition places true solar noon at azimuth ~180 (south) in the northern hemisphere, under the installed degrees/north-zero/clockwise convention", () => {
    // Use the library's OWN getTimes().solarNoon for the reference date
    // rather than a guessed UTC clock time — solar noon at a given lat/lon
    // is rarely exactly 12:00 UTC, and asserting against a guessed timestamp
    // would risk conflating a real convention bug with an off-by-longitude
    // artifact. This is the belt-and-suspenders "code half" of Pitfall 1 —
    // Task 1's install-time index.d.ts read was the "belt" half.
    const times = SunCalc.getTimes(
      new Date("2026-03-20T12:00:00Z"),
      STOCKHOLM_LAT,
      STOCKHOLM_LON,
    );
    const pos = SunCalc.getPosition(times.solarNoon, STOCKHOLM_LAT, STOCKHOLM_LON);

    // Degrees, north-zero, clockwise: 0=N, 90=E, 180=S, 270=W (index.d.ts).
    expect(pos.azimuth).toBeGreaterThan(170);
    expect(pos.azimuth).toBeLessThan(190);
    // Above the horizon at solar noon (sanity check the timestamp is valid).
    expect(pos.altitude).toBeGreaterThan(0);
  });
});

describe("computeSunExposure — null-propagation contract (Pitfall 4)", () => {
  const validLat = STOCKHOLM_LAT;
  const validLon = STOCKHOLM_LON;
  const validFloor = 3;
  const validOrientation: Facade[] = ["south"];

  it("returns byFacadeAndSeason: null when latitude is null", () => {
    const result = computeSunExposure(null, validLon, validFloor, validOrientation);
    expect(result.byFacadeAndSeason).toBeNull();
    expect(result.orientationSource).toBe("unavailable");
    expect(result.orientationConfidence).toBeNull();
  });

  it("returns byFacadeAndSeason: null when longitude is null", () => {
    const result = computeSunExposure(validLat, null, validFloor, validOrientation);
    expect(result.byFacadeAndSeason).toBeNull();
    expect(result.orientationSource).toBe("unavailable");
    expect(result.orientationConfidence).toBeNull();
  });

  it("returns byFacadeAndSeason: null when floor is null", () => {
    const result = computeSunExposure(validLat, validLon, null, validOrientation);
    expect(result.byFacadeAndSeason).toBeNull();
    expect(result.orientationSource).toBe("unavailable");
    expect(result.orientationConfidence).toBeNull();
  });

  it("returns byFacadeAndSeason: null when orientation is null", () => {
    const result = computeSunExposure(validLat, validLon, validFloor, null);
    expect(result.byFacadeAndSeason).toBeNull();
    expect(result.orientationSource).toBe("unavailable");
    expect(result.orientationConfidence).toBeNull();
  });

  it("never defaults a missing input to an empty/zeroed object — always the null sentinel", () => {
    const result = computeSunExposure(null, null, null, null);
    expect(result.byFacadeAndSeason).toBeNull();
    expect(result.byFacadeAndSeason).not.toEqual({});
  });
});

describe("computeSunExposure — facade/season bucketing correctness", () => {
  it("computes a non-null qualitative breakdown ONLY for the requested facades, all 3 seasons, when all inputs are present", () => {
    const result = computeSunExposure(STOCKHOLM_LAT, STOCKHOLM_LON, 3, [
      "south",
      "west",
    ]);
    expect(result.byFacadeAndSeason).not.toBeNull();
    expect(result.orientationSource).toBe("description");
    expect(result.orientationConfidence).not.toBeNull();

    const grid = result.byFacadeAndSeason!;
    const requestedFacades: Facade[] = ["south", "west"];
    for (const facade of requestedFacades) {
      expect(grid[facade]?.winter).toBeTypeOf("string");
      expect(grid[facade]?.springAutumn).toBeTypeOf("string");
      expect(grid[facade]?.summer).toBeTypeOf("string");
    }
  });

  // WR-02 (12-REVIEW.md): `orientation` genuinely SCOPES computation — a
  // facade NOT passed in must be absent from the returned grid entirely,
  // never computed and never fabricated as a phantom entry.
  it("does NOT populate a facade that was not passed in `orientation`", () => {
    const result = computeSunExposure(STOCKHOLM_LAT, STOCKHOLM_LON, 3, ["south"]);
    const grid = result.byFacadeAndSeason!;
    expect(grid.south).toBeDefined();
    expect(grid.north).toBeUndefined();
    expect(grid.east).toBeUndefined();
    expect(grid.west).toBeUndefined();
  });

  it("a north-only facade is never the sunniest exposure at a Stockholm-latitude listing (Pitfall 1 warning sign)", () => {
    const result = computeSunExposure(STOCKHOLM_LAT, STOCKHOLM_LON, 3, [
      "north",
      "east",
      "south",
      "west",
    ]);
    const grid = result.byFacadeAndSeason!;

    // "No direct sun" must rank at or below every other facade's summer
    // descriptor for north — if north claimed the sunniest label, that is
    // the documented Pitfall 1 convention-bug warning sign.
    expect(grid.north?.summer).not.toBe(grid.south?.summer);
    expect(SUN_QUALITY_RANK[grid.north!.summer]).toBeLessThanOrEqual(
      SUN_QUALITY_RANK[grid.south!.summer],
    );
  });

  it("south facade shows more/earlier direct sun in summer than in winter (Stockholm latitude)", () => {
    const result = computeSunExposure(STOCKHOLM_LAT, STOCKHOLM_LON, 3, ["south"]);
    const grid = result.byFacadeAndSeason!;
    expect(SUN_QUALITY_RANK[grid.south!.summer]).toBeGreaterThanOrEqual(
      SUN_QUALITY_RANK[grid.south!.winter],
    );
  });
});

// Mirrors the qualitative Swedish descriptor set implemented in sun-path.ts,
// ranked worst → best purely for this test's own ordinal comparisons (never
// exported/used by production code — the UI never sees a numeric rank).
const SUN_QUALITY_RANK: Record<string, number> = {
  "Ingen direkt sol": 0,
  "Morgon, låg sol": 1,
  "Kväll, låg sol": 1,
  "Morgon, hög sol": 2,
  "Kväll, hög sol": 2,
  "Sol större delen av dagen": 3,
};

describe("extractOrientationFromDescription — never a guess (Pattern 3)", () => {
  it("returns null for null input", () => {
    expect(extractOrientationFromDescription(null)).toBeNull();
  });

  it("returns null for text with no väderstreck keyword", () => {
    expect(
      extractOrientationFromDescription("en trevlig tvåa utan väderstreck"),
    ).toBeNull();
  });

  it("returns south with low confidence for a stated söderläge", () => {
    const result = extractOrientationFromDescription("ljust söderläge med balkong");
    expect(result).not.toBeNull();
    expect(result!.facades).toContain("south");
    expect(result!.confidence).toBe(0.5);
  });

  it("returns west for a stated västerläge", () => {
    const result = extractOrientationFromDescription("balkong i västerläge, fint kvällsljus");
    expect(result).not.toBeNull();
    expect(result!.facades).toContain("west");
  });

  it("returns multiple facades for a corner apartment description mentioning two directions", () => {
    const result = extractOrientationFromDescription(
      "hörnlägenhet med balkong mot söder och fönster mot öster",
    );
    expect(result).not.toBeNull();
    expect(result!.facades).toContain("south");
    expect(result!.facades).toContain("east");
  });

  it("never derives orientation from an address string alone (no address-only match)", () => {
    // Sanity check the locked "never guess from address" constraint: a bare
    // street address with no stated väderstreck word must return null.
    expect(extractOrientationFromDescription("Söderlångsgatan 4, Stockholm")).toBeNull();
  });

  describe("WR-01 (12-REVIEW.md) — place-name false-positive regression", () => {
    // The previous unbounded `.*` span let a directional word anywhere in
    // the REMAINING string match as a substring of a place name whenever a
    // balkong/fönster mention appeared earlier in the description — even
    // across sentence boundaries. All of these must return null: none
    // states an actual orientation, they merely mention a balcony/window
    // AND a common söder-/norr-/väster-/öster- Swedish place name.
    it.each([
      "Fin balkong. Bostaden ligger i ett soligt läge nära Norrköping.",
      "Balkong i bottenplan, mysigt kvarter nära Söderort.",
      "Stor balkong. Utsikt mot Södertälje.",
      "fönster ut mot Söderhamn",
      "Lägenhet nära Norrköping med stor balkong.",
      "Västerås är en fin stad, balkong finns också.",
      "Söker lägenhet nära Södermalm med balkong.",
      "Härlig balkong, ligger nära Österåker.",
    ])("returns null for %s", (description) => {
      expect(extractOrientationFromDescription(description)).toBeNull();
    });

    // Genuine orientation phrases (same words, but stating an actual
    // väderstreck) must still resolve to the correct facade — the fix must
    // not overcorrect into never matching real orientation phrases.
    it.each([
      ["Fin balkong. Bostaden ligger i ett soligt söderläge.", "south"],
      ["Härlig balkong i söderläge.", "south"],
      ["balkong i söder, fantastiskt ljus", "south"],
      ["Stor balkong mot norr, svalt på sommaren.", "north"],
    ] as const)("returns %s for %s", (description, expectedFacade) => {
      const result = extractOrientationFromDescription(description);
      expect(result).not.toBeNull();
      expect(result!.facades).toContain(expectedFacade);
    });
  });
});
