import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OSM_ATTRIBUTION,
  buildOsmIndex,
  parseOsmExtract,
  projectFrom,
  unprojectFrom,
  type OsmExtract,
  type OsmIndex,
} from "@/lib/discovery/osm-buildings";
import {
  SUN_FACADE_PARAMS,
  angularDistance,
  bearingToFacade,
  inferStreetFacade,
  streetNameOf,
  type FootprintOk,
  type FootprintResult,
} from "@/lib/discovery/sun-facade";
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

// ---------------------------------------------------------------------------
// Synthetic scenes: the Booli point is always the origin (LAT0, LNG0); shapes are laid out in metres around it
// ---------------------------------------------------------------------------

const LAT0 = 59.3;
const LNG0 = 18.0;
const unproj = unprojectFrom(LAT0, LNG0);

type XY = [number, number];
type Tags = Record<string, string>;
const geo = (pts: XY[]): Array<{ lat: number; lon: number }> =>
  pts.map(([x, y]) => {
    const [lng, lat] = unproj(x, y);
    return { lat, lon: lng };
  });
const rect = (x0: number, y0: number, x1: number, y1: number): XY[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];
const way = (id: number, pts: XY[], tags: Tags) => ({ type: "way" as const, id, tags, geometry: geo(pts) });
const building = (id: number, pts: XY[], tags: Tags = { building: "apartments" }) => way(id, pts, tags);
const road = (id: number, pts: XY[], name = "Testgatan") => way(id, pts, { highway: "residential", name });

function scene(over: { buildings?: unknown[]; roads?: unknown[]; relations?: unknown[]; bbox?: OsmExtract["bbox"] } = {}): OsmIndex {
  return buildOsmIndex(
    parseOsmExtract({
      version: 1,
      attribution: OSM_ATTRIBUTION,
      fetchedAt: "2026-10-13T14:02:29Z",
      osmBase: "2026-10-13T14:02:29Z",
      bbox: over.bbox ?? { south: LAT0 - 0.01, west: LNG0 - 0.02, north: LAT0 + 0.01, east: LNG0 + 0.02 },
      buildings: over.buildings ?? [],
      relations: over.relations ?? [],
      roads: over.roads ?? [],
    }),
  );
}

const at = (address: string | null = "Testgatan 3", floor: number | null = 2) => ({ lat: LAT0, lng: LNG0, address, floor });
const ok = (r: FootprintResult): FootprintOk => {
  if (r.status !== "ok") throw new Error(`expected ok, got unknown: ${r.reason}`);
  return r;
};

/** A 20 x 12 m slab whose south wall is `southWallY` metres from the point, with Testgatan 6 m south of that wall. */
function slab(southWallY: number, opts: { roadGap?: number; tags?: Tags; reverse?: boolean } = {}): OsmIndex {
  const pts = rect(-10, southWallY, 10, southWallY + 12);
  return scene({
    buildings: [building(100, opts.reverse ? [...pts].reverse() : pts, opts.tags)],
    roads: [road(200, [[-60, southWallY - (opts.roadGap ?? 6)], [60, southWallY - (opts.roadGap ?? 6)]])],
  });
}

describe("streetNameOf", () => {
  it.each([
    ["Folkungagatan 61", "Folkungagatan"],
    ["Folkungagatan 61 B", "Folkungagatan"],
    ["TESTGATAN 3 B", "TESTGATAN"],
    ["Wennerbergsgatan 6A", "Wennerbergsgatan"],
    ["Karlbergsvägen 77-81", "Karlbergsvägen"],
    ["Karlbergsvägen 77A-81", "Karlbergsvägen"],
    ["Östgötagatan 12", "Östgötagatan"],
    ["Lidnersplan", "Lidnersplan"],
    ["", ""],
    ["   ", ""],
    ["61", ""],
    [null, ""],
  ])("%j gives %j", (address, street) => {
    expect(streetNameOf(address)).toBe(street);
  });
});

describe("bearingToFacade and angularDistance (sector rule)", () => {
  it.each([
    [0, "north"],
    [44.9, "north"],
    [45, "east"],
    [134.9, "east"],
    [135, "south"],
    [224.9, "south"],
    [225, "west"],
    [314.9, "west"],
    [315, "north"],
    [359.9, "north"],
    [360, "north"],
    [-10, "north"],
  ])("%d degrees is %s", (deg, facade) => {
    expect(bearingToFacade(deg)).toBe(facade);
  });

  it("measures the smaller angle", () => {
    expect(angularDistance(10, 350)).toBe(20);
    expect(angularDistance(0, 180)).toBe(180);
    expect(angularDistance(90, 90)).toBe(0);
    expect(angularDistance(359, 1)).toBe(2);
  });
});

describe("inferStreetFacade: a synthetic slab", () => {
  const result = ok(inferStreetFacade(slab(-6), at("TESTGATAN 3 B")));

  it("reads a road south of the building as a south street side and a north courtyard", () => {
    expect(result.osmId).toBe("way/100");
    expect(result.inside).toBe(true);
    expect(result.snapM).toBe(0);
    expect(result.streetBearingDeg).toBeCloseTo(180, 0);
    expect(Math.abs(result.streetBearingDeg - 180)).toBeLessThanOrEqual(5);
    expect(result.streetFacade).toBe("south");
    expect(result.courtyardBearingDeg).toBeCloseTo(0, 0);
    expect(result.courtyardFacade).toBe("north");
    expect(result.frontageM).toBe(20);
    expect(result.streetDistM).toBe(6);
    expect(result.confidence).toBe(1);
    expect(result.ambiguous).toBe(false);
  });

  it("puts the street point 0,3 m south of the south wall and the courtyard point 0,3 m north of the north wall", () => {
    const toM = projectFrom(LAT0, LNG0);
    const [sx, sy] = toM(result.streetPoint.lng, result.streetPoint.lat);
    expect(sx).toBeCloseTo(0, 1);
    expect(sy).toBeCloseTo(-6.3, 1);
    expect(result.courtyardPoint).not.toBeNull();
    const [cx, cy] = toM((result.courtyardPoint as { lng: number }).lng, (result.courtyardPoint as { lat: number }).lat);
    expect(cx).toBeCloseTo(0, 1);
    expect(cy).toBeCloseTo(6.3, 1);
  });

  it("does not depend on the ring winding", () => {
    const reversed = ok(inferStreetFacade(slab(-6, { reverse: true }), at("TESTGATAN 3 B")));
    expect(reversed.streetBearingDeg).toBe(result.streetBearingDeg);
    expect(reversed.courtyardBearingDeg).toBe(result.courtyardBearingDeg);
  });

  it("matches the street by normalized name only", () => {
    expect(inferStreetFacade(slab(-6), at("Testvägen 3"))).toEqual({ status: "unknown", reason: "ingen gata med samma namn inom 35 m" });
    expect(inferStreetFacade(slab(-6), at("Test 3"))).toEqual({ status: "unknown", reason: "ingen gata med samma namn inom 35 m" });
  });

  it("never reads the OSM addr:street tag (R-02)", () => {
    const tagged = slab(-6, { tags: { building: "apartments", "addr:street": "Testvägen" } });
    expect(ok(inferStreetFacade(tagged, at("Testgatan 3"))).streetFacade).toBe("south");
    expect(inferStreetFacade(tagged, at("Testvägen 3")).status).toBe("unknown");
  });

  it.each([
    [0, "north"],
    [44.96, "east"],
    [90, "east"],
    [134.96, "south"],
    [224.96, "west"],
    [314.96, "north"],
    [359.96, "north"],
  ])("takes the facade from the STORED bearing: a street side facing %d degrees is %s", (bearing, facade) => {
    // A 20 x 12 slab turned so its front wall faces `bearing`, with Testgatan 12 m from the centre along that normal.
    const rad = (bearing * Math.PI) / 180;
    const n: XY = [Math.sin(rad), Math.cos(rad)]; // front normal
    const t: XY = [Math.cos(rad), -Math.sin(rad)]; // along the wall
    const p = (a: number, b: number): XY => [a * t[0] + b * n[0], a * t[1] + b * n[1]];
    const body = [p(-10, -6), p(10, -6), p(10, 6), p(-10, 6), p(-10, -6)];
    const idx = scene({ buildings: [building(100, body)], roads: [road(200, [p(-60, 12), p(60, 12)])] });
    const r = ok(inferStreetFacade(idx, at("Testgatan 3")));
    expect(r.streetFacade).toBe(facade);
    expect(angularDistance(r.streetBearingDeg, bearing)).toBeLessThanOrEqual(0.06);
    expect(r.streetBearingDeg).toBeLessThan(360);
  });

  it("stores 359,96 as 0,0 and calls it north", () => {
    const rad = (359.96 * Math.PI) / 180;
    const n: XY = [Math.sin(rad), Math.cos(rad)];
    const t: XY = [Math.cos(rad), -Math.sin(rad)];
    const p = (a: number, b: number): XY => [a * t[0] + b * n[0], a * t[1] + b * n[1]];
    const idx = scene({
      buildings: [building(100, [p(-10, -6), p(10, -6), p(10, 6), p(-10, 6), p(-10, -6)])],
      roads: [road(200, [p(-60, 12), p(60, 12)])],
    });
    const r = ok(inferStreetFacade(idx, at("Testgatan 3")));
    expect(r.streetBearingDeg).toBe(0);
    expect(r.streetFacade).toBe("north");
    expect(r.courtyardBearingDeg).toBe(180);
  });
});

describe("inferStreetFacade: snapping (RESEARCH Pitfall 5)", () => {
  it("snaps a point 10 m outside the building to its nearest wall at 0,7 x the inside confidence", () => {
    const inside = ok(inferStreetFacade(slab(-6), at()));
    const snapped = ok(inferStreetFacade(slab(10), at()));
    expect(snapped.inside).toBe(false);
    expect(snapped.snapM).toBe(10);
    expect(snapped.streetFacade).toBe("south");
    expect(snapped.confidence).toBe(Math.round(inside.confidence * SUN_FACADE_PARAMS.confidence.snapped * 100) / 100);
    expect(snapped.confidence).toBe(0.7);
  });

  it("snaps at exactly 25,0 m and refuses at 25,1 m", () => {
    expect(ok(inferStreetFacade(slab(25), at())).snapM).toBe(25);
    expect(inferStreetFacade(slab(25.1), at())).toEqual({ status: "unknown", reason: "ingen byggnad inom 25 m" });
  });

  it("prefers the building the point is inside over a nearer wall of another building", () => {
    const idx = scene({
      buildings: [building(1, rect(-10, -6, 10, 6)), building(2, rect(11, -6, 20, 6))],
      roads: [road(200, [[-60, -12], [60, -12]])],
    });
    expect(ok(inferStreetFacade(idx, at())).osmId).toBe("way/1");
  });

  it("picks the smallest containing polygon, and the lower id on equal areas, whatever the array order", () => {
    const big = building(5, rect(-30, -30, 30, 30));
    const small = building(9, rect(-10, -6, 10, 6));
    const twinA = building(7, rect(-10, -6, 10, 6));
    const roads = [road(200, [[-60, -12], [60, -12]])];
    expect(ok(inferStreetFacade(scene({ buildings: [big, small], roads }), at())).osmId).toBe("way/9");
    expect(ok(inferStreetFacade(scene({ buildings: [small, big], roads }), at())).osmId).toBe("way/9");
    expect(ok(inferStreetFacade(scene({ buildings: [small, twinA], roads }), at())).osmId).toBe("way/7");
    expect(ok(inferStreetFacade(scene({ buildings: [twinA, small], roads }), at())).osmId).toBe("way/7");
  });
});

describe("inferStreetFacade: how far the street may be", () => {
  const withRoadGap = (gap: number) => slab(-6, { roadGap: gap });

  it("accepts a road exactly 35,0 m from the wall midpoint", () => {
    const r = ok(inferStreetFacade(withRoadGap(35), at()));
    expect(r.streetDistM).toBe(35);
    expect(r.streetFacade).toBe("south");
  });

  it("refuses a road 35,1 m away", () => {
    expect(inferStreetFacade(withRoadGap(35.1), at())).toEqual({ status: "unknown", reason: "ingen gata med samma namn inom 35 m" });
  });

  it("lowers the confidence to 0,8 when the nearest road is more than 10 m away", () => {
    expect(ok(inferStreetFacade(withRoadGap(10), at())).confidence).toBe(1);
    expect(ok(inferStreetFacade(withRoadGap(10.1), at())).confidence).toBe(0.8);
  });

  it("lowers the confidence to 0,7 when the facing frontage is shorter than 8 m", () => {
    const narrow = scene({
      buildings: [building(100, rect(-3.5, -6, 3.5, 6))],
      roads: [road(200, [[-60, -12], [60, -12]])],
    });
    const r = ok(inferStreetFacade(narrow, at()));
    expect(r.frontageM).toBe(7);
    expect(r.confidence).toBe(0.7);
  });

  it("ignores walls shorter than 2,5 m", () => {
    const sliver = scene({
      buildings: [building(100, rect(-1.2, -6, 1.2, 6))],
      roads: [road(200, [[-60, -12], [60, -12]])],
    });
    expect(inferStreetFacade(sliver, at())).toEqual({ status: "unknown", reason: "ingen gata med samma namn inom 35 m" });
  });
});

describe("inferStreetFacade: corner flats", () => {
  // A 12 x 12 block with Testgatan running along its south wall AND its east wall, 6 m from each.
  const corner = scene({
    buildings: [building(100, rect(-6, -6, 6, 6))],
    roads: [road(200, [[-30, -12], [12, -12], [12, 30]])],
  });
  const single = scene({
    buildings: [building(100, rect(-6, -6, 6, 6))],
    roads: [road(200, [[-30, -12], [30, -12]])],
  });

  it("flags the ambiguity and lowers the confidence below the single-front block", () => {
    const c = ok(inferStreetFacade(corner, at()));
    const s = ok(inferStreetFacade(single, at()));
    expect(c.ambiguous).toBe(true);
    expect(s.ambiguous).toBe(false);
    expect(c.confidence).toBeLessThan(s.confidence);
    expect(c.confidence).toBe(0.7);
  });

  it("settles the tie between the two fronts the same way every time (nearest street, then lower bearing)", () => {
    const c = ok(inferStreetFacade(corner, at()));
    expect(c.streetFacade).toBe("east");
    expect(inferStreetFacade(corner, at())).toEqual(inferStreetFacade(corner, at()));
  });

  it("ends the Sol cell with ' hörn'", () => {
    const cell = formatSolCell(sunFactFromFootprint(inferStreetFacade(corner, at())));
    expect(cell.endsWith(" hörn")).toBe(true);
    expect(formatSolCell(sunFactFromFootprint(inferStreetFacade(single, at()))).endsWith(" hörn")).toBe(false);
  });
});

describe("inferStreetFacade: the wrong-building self-check", () => {
  const tagged = (levels: string) => slab(-6, { tags: { building: "apartments", "building:levels": levels } });

  it("halves the confidence and flags a Booli floor above the building's levels", () => {
    const r = ok(inferStreetFacade(tagged("4"), at("Testgatan 3", 6)));
    expect(r.floorAboveLevels).toBe(true);
    expect(r.confidence).toBe(0.5);
    expect(formatSolCell(sunFactFromFootprint(r))).toContain("0,50");
  });

  it("leaves a floor at or below the levels, an unknown floor and an untagged building alone", () => {
    expect(ok(inferStreetFacade(tagged("4"), at("Testgatan 3", 4)))).toMatchObject({ floorAboveLevels: false, confidence: 1 });
    expect(ok(inferStreetFacade(tagged("4"), at("Testgatan 3", null)))).toMatchObject({ floorAboveLevels: false, confidence: 1 });
    expect(ok(inferStreetFacade(slab(-6), at("Testgatan 3", 9)))).toMatchObject({ floorAboveLevels: false, confidence: 1 });
  });
});

describe("inferStreetFacade: courtyard buildings (relations)", () => {
  const member = (ref: number, role: string, pts: XY[]) => ({ type: "way", ref, role, geometry: geo(pts) });

  it("treats a point inside a courtyard hole as outside the building", () => {
    // The point (origin) sits in the middle of a 30 x 20 m courtyard; the block around it is 50 x 40 m.
    const rel = {
      type: "relation" as const,
      id: 7,
      tags: { building: "apartments", type: "multipolygon" },
      members: [member(1, "outer", rect(-25, -20, 25, 20)), member(2, "inner", rect(-15, -10, 15, 10))],
    };
    const idx = scene({ relations: [rel], roads: [road(200, [[-60, -26], [60, -26]])] });
    const r = ok(inferStreetFacade(idx, at()));
    expect(r.osmId).toBe("relation/7");
    expect(r.inside).toBe(false);
    expect(r.snapM).toBe(10);
  });

  it("uses the walls of the block, not of its courtyard, for the street side", () => {
    // A 50 x 40 block with a courtyard hole; the point is in the solid south wing (y -8..2), Testgatan 6 m south of the block.
    const rel = {
      type: "relation" as const,
      id: 7,
      tags: { building: "apartments", type: "multipolygon" },
      members: [member(1, "outer", rect(-25, -8, 25, 32)), member(2, "inner", rect(-15, 2, 15, 22))],
    };
    const idx = scene({ relations: [rel], roads: [road(200, [[-60, -14], [60, -14]])] });
    const r = ok(inferStreetFacade(idx, at("Testgatan 3", 1)));
    expect(r.osmId).toBe("relation/7");
    expect(r.inside).toBe(true);
    expect(r.streetFacade).toBe("south");
    expect(r.frontageM).toBe(50);
  });
});

describe("inferStreetFacade: five pinned reasons, in order", () => {
  const idx = slab(-6);

  it("coordinates first", () => {
    expect(inferStreetFacade(idx, { lat: null, lng: LNG0, address: "", floor: null })).toEqual({ status: "unknown", reason: "koordinater saknas" });
    expect(inferStreetFacade(idx, { lat: LAT0, lng: null, address: "Testgatan 3", floor: null })).toEqual({ status: "unknown", reason: "koordinater saknas" });
  });

  it("then the address", () => {
    expect(inferStreetFacade(idx, at("", 2))).toEqual({ status: "unknown", reason: "adress saknas" });
    expect(inferStreetFacade(idx, at(null, 2))).toEqual({ status: "unknown", reason: "adress saknas" });
    expect(inferStreetFacade(idx, at("61", 2))).toEqual({ status: "unknown", reason: "adress saknas" });
  });

  it("then the extract bounds", () => {
    const away = scene({
      buildings: [building(100, rect(-10, -6, 10, 6))],
      roads: [road(200, [[-60, -12], [60, -12]])],
      bbox: { south: 59.4, west: 18.1, north: 59.41, east: 18.12 },
    });
    expect(inferStreetFacade(away, at())).toEqual({ status: "unknown", reason: "utanför OSM-utdraget" });
    // Outside the bounds wins over "no building" (the extract here has no buildings either).
    expect(inferStreetFacade(scene({ bbox: { south: 59.4, west: 18.1, north: 59.41, east: 18.12 } }), at())).toEqual({
      status: "unknown",
      reason: "utanför OSM-utdraget",
    });
  });

  it("then the building, including an extract with no buildings at all", () => {
    expect(inferStreetFacade(scene(), at())).toEqual({ status: "unknown", reason: "ingen byggnad inom 25 m" });
    expect(inferStreetFacade(slab(30), at())).toEqual({ status: "unknown", reason: "ingen byggnad inom 25 m" });
  });

  it("then the same-name street, and a nearer road of another name does not help (no fallback)", () => {
    const other = scene({
      buildings: [building(100, rect(-10, -6, 10, 6))],
      roads: [road(200, [[-60, -12], [60, -12]], "Annangatan")],
    });
    expect(inferStreetFacade(other, at())).toEqual({ status: "unknown", reason: "ingen gata med samma namn inom 35 m" });
    expect(inferStreetFacade(scene({ buildings: [building(100, rect(-10, -6, 10, 6))] }), at())).toEqual({
      status: "unknown",
      reason: "ingen gata med samma namn inom 35 m",
    });
  });

  it("an unknown never carries a number: sunFactFromFootprint prints okänd with the reason", () => {
    const fact = sunFactFromFootprint(inferStreetFacade(idx, at("", 2)));
    expect(fact).toMatchObject({ source: "okänd", unknownReason: "adress saknas", confidence: 0, sides: [], footprint: null });
    expect(formatSolCell(fact)).toBe("okänd");
  });
});

describe("inferStreetFacade: determinism on the real fixture", () => {
  const extract = parseOsmExtract(loadFixture());
  const input = { ...FOLKUNGAGATAN, address: "Folkungagatan 61", floor: 5 };
  const expected = inferStreetFacade(buildOsmIndex(extract), input);

  it("gives the same answer whatever the order of buildings, relations and roads", () => {
    const shuffled: OsmExtract = {
      ...extract,
      buildings: [...extract.buildings].reverse(),
      relations: [...extract.relations].reverse(),
      roads: [...extract.roads].reverse(),
    };
    expect(inferStreetFacade(buildOsmIndex(shuffled), input)).toEqual(expected);
    const rotated: OsmExtract = { ...extract, buildings: [...extract.buildings.slice(40), ...extract.buildings.slice(0, 40)] };
    expect(inferStreetFacade(buildOsmIndex(rotated), input)).toEqual(expected);
  });

  it("assembles the fixture's two courtyard relations", () => {
    const idx = buildOsmIndex(extract);
    expect(extract.relations).toHaveLength(2);
    expect(idx.skipped.relationsWithoutOuter).toBe(0);
    expect(idx.buildings.filter((b) => b.id.startsWith("relation/")).length).toBeGreaterThanOrEqual(2);
    expect(idx.buildings.filter((b) => b.id.startsWith("way/"))).toHaveLength(extract.buildings.length - idx.skipped.invalidWays);
  });
});
