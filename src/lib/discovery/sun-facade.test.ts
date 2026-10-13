import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOsmIndex, parseOsmExtract } from "@/lib/discovery/osm-buildings";
import { inferStreetFacade } from "@/lib/discovery/sun-facade";
import { formatSolCell, sunFactFromFootprint, unknownSunFact } from "@/lib/discovery/sun-fact";

// Real OSM data (c) OpenStreetMap contributors, ODbL: a 220 m cut around Folkungagatan 61, downloaded 2026-10-13.
const FIXTURE = join(__dirname, "__fixtures__", "osm-folkungagatan-61.fixture.json");
const loadFixture = (): unknown => JSON.parse(readFileSync(FIXTURE, "utf8"));

// Booli's point for Folkungagatan 61 (taste.test.ts uses the same one).
const FOLKUNGAGATAN = { lat: 59.3147546, lng: 18.07681659 };

describe("parseOsmExtract", () => {
  it("accepts the committed fixture and carries the ODbL attribution", () => {
    const extract = parseOsmExtract(loadFixture());
    expect(extract.attribution).toContain("OpenStreetMap contributors");
    expect(extract.buildings.length).toBeGreaterThan(100);
    expect(extract.roads.length).toBeGreaterThan(100);
  });

  it("refuses a file without the attribution, with one readable error", () => {
    const raw = { ...(loadFixture() as Record<string, unknown>), attribution: "somebody's data" };
    expect(() => parseOsmExtract(raw)).toThrowError(/Invalid OSM extract: .*attribution/);
  });

  it("refuses a latitude of 95", () => {
    const raw = loadFixture() as { buildings: Array<{ geometry: Array<{ lat: number; lon: number }> }> };
    raw.buildings[0].geometry[0].lat = 95;
    expect(() => parseOsmExtract(raw)).toThrowError(/Invalid OSM extract: .*lat/);
  });

  it("refuses version 2", () => {
    const raw = { ...(loadFixture() as Record<string, unknown>), version: 2 };
    expect(() => parseOsmExtract(raw)).toThrowError(/Invalid OSM extract: .*version/);
  });
});

describe("inferStreetFacade: Folkungagatan 61 on the real fixture (tracer calibration)", () => {
  const index = buildOsmIndex(parseOsmExtract(loadFixture()));
  const result = inferStreetFacade(index, { ...FOLKUNGAGATAN, address: "Folkungagatan 61", floor: 5 });

  it("lands in way 1372512603 and reads the street side as south", () => {
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.osmId).toBe("way/1372512603");
    expect(result.inside).toBe(true);
    expect(result.streetBearingDeg).toBeGreaterThanOrEqual(161.2);
    expect(result.streetBearingDeg).toBeLessThanOrEqual(171.2);
    expect(result.streetFacade).toBe("south");
  });

  it("puts the courtyard on the opposite side with a confident answer", () => {
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.courtyardBearingDeg).toBeCloseTo((result.streetBearingDeg + 180) % 360, 1);
    expect(result.courtyardFacade).toBe("north");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.floorAboveLevels).toBe(false);
  });

  it("turns into a fastighet/gata SunFact with a street and a courtyard side", () => {
    const fact = sunFactFromFootprint(result);
    expect(fact.source).toBe("fastighet/gata");
    expect(fact.conflict).toBe(false);
    expect(fact.unknownReason).toBeNull();
    expect(fact.sides.map((s) => [s.side, s.facade, s.share, s.hours])).toEqual([
      ["gata", "south", 0.5, null],
      ["gård", "north", 0.5, null],
    ]);
    expect(fact.footprint?.osmId).toBe("way/1372512603");
  });

  it("prints the Sol cell with the confidence as two decimals and a decimal comma", () => {
    expect(formatSolCell(sunFactFromFootprint(result))).toMatch(/^S gata\/N gård \(fastighet\/gata, \d,\d\d\)$/);
  });

  it("is deterministic", () => {
    expect(inferStreetFacade(index, { ...FOLKUNGAGATAN, address: "Folkungagatan 61", floor: 5 })).toEqual(result);
  });
});

describe("formatSolCell", () => {
  it("prints a dash when the run knows nothing and okänd when it looked and could not tell", () => {
    expect(formatSolCell(null)).toBe("-");
    expect(formatSolCell(unknownSunFact("adress saknas"))).toBe("okänd");
  });
});
