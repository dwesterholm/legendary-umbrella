import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HEIGHT_PARAMS,
  OSM_ATTRIBUTION,
  buildOsmIndex,
  buildingHeight,
  heightOf,
  levelsOf,
  normalizeStreetName,
  parseOsmExtract,
  pointInBuilding,
  projectFrom,
  suspectHeights,
  unprojectFrom,
  wallsNear,
  type OsmExtract,
} from "@/lib/discovery/osm-buildings";

// ---------------------------------------------------------------------------
// Synthetic extract builders (they write the file contract, so the parser is part of every test)
// ---------------------------------------------------------------------------

const LAT0 = 59.3;
const LNG0 = 18.0;
const unproj = unprojectFrom(LAT0, LNG0);

type XY = [number, number];
const geo = (pts: XY[]): Array<{ lat: number; lon: number }> =>
  pts.map(([x, y]) => {
    const [lng, lat] = unproj(x, y);
    return { lat, lon: lng };
  });

const way = (id: number, pts: XY[], tags: Record<string, string> = { building: "yes" }) => ({
  type: "way" as const,
  id,
  tags,
  geometry: geo(pts),
});

const member = (ref: number, role: string, pts: XY[]) => ({ type: "way", ref, role, geometry: geo(pts) });
const relation = (id: number, members: ReturnType<typeof member>[], tags: Record<string, string> = { building: "yes", type: "multipolygon" }) => ({
  type: "relation" as const,
  id,
  tags,
  members,
});

function extract(over: Partial<Record<keyof OsmExtract, unknown>> = {}): unknown {
  return {
    version: 1,
    attribution: OSM_ATTRIBUTION,
    fetchedAt: "2026-10-13T14:02:29Z",
    osmBase: "2026-10-13T14:02:29Z",
    bbox: { south: LAT0 - 0.01, west: LNG0 - 0.02, north: LAT0 + 0.01, east: LNG0 + 0.02 },
    buildings: [],
    relations: [],
    roads: [],
    ...over,
  };
}

const rect = (x0: number, y0: number, x1: number, y1: number): XY[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];

const index = (over: Partial<Record<keyof OsmExtract, unknown>>) => buildOsmIndex(parseOsmExtract(extract(over)));

// ---------------------------------------------------------------------------

describe("parseOsmExtract (T-14.3-01, T-14.3-07)", () => {
  it("accepts a minimal valid extract", () => {
    expect(parseOsmExtract(extract()).attribution).toBe(OSM_ATTRIBUTION);
  });

  it.each([
    ["no attribution line", { attribution: "(c) somebody" }, /attribution/],
    ["version 2", { version: 2 }, /version/],
    ["a timestamp that is not ISO", { fetchedAt: "yesterday" }, /fetchedAt/],
    ["a bounding box latitude of 95", { bbox: { south: 59, west: 18, north: 95, east: 19 } }, /bbox/],
  ])("refuses %s with one readable Error", (_name, over, pattern) => {
    expect(() => parseOsmExtract(extract(over))).toThrowError(pattern);
    expect(() => parseOsmExtract(extract(over))).toThrowError(/^Invalid OSM extract: /);
  });

  it("refuses a longitude of 181 inside a way", () => {
    const bad = { type: "way", id: 1, tags: {}, geometry: [{ lat: 59, lon: 181 }] };
    expect(() => parseOsmExtract(extract({ buildings: [bad] }))).toThrowError(/lon/);
  });

  it("refuses more than 10 000 geometry points on one way and 5 000 members on one relation", () => {
    const manyPoints = { type: "way", id: 1, tags: {}, geometry: Array.from({ length: 10_001 }, () => ({ lat: 59, lon: 18 })) };
    expect(() => parseOsmExtract(extract({ buildings: [manyPoints] }))).toThrowError(/Invalid OSM extract/);
    const manyMembers = { type: "relation", id: 2, tags: {}, members: Array.from({ length: 5_001 }, () => ({ type: "way", ref: 1, role: "outer" })) };
    expect(() => parseOsmExtract(extract({ relations: [manyMembers] }))).toThrowError(/Invalid OSM extract/);
  });

  it("reports at most five issues", () => {
    const bad = Array.from({ length: 9 }, (_, i) => ({ type: "way", id: i, tags: {}, geometry: [{ lat: 99, lon: 18 }] }));
    const message = (() => {
      try {
        parseOsmExtract(extract({ buildings: bad }));
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(message.split("; ").length).toBeLessThanOrEqual(5);
  });
});

describe("levelsOf", () => {
  it.each([
    [{ "building:levels": "6" }, 6],
    [{ "building:levels": "5,5" }, 5.5],
    [{ "building:levels": "5.5" }, 5.5],
    [{ "building:levels": "5;6" }, 5],
    [{ "building:levels": "abc" }, null],
    [{}, null],
  ])("%j gives %j", (tags, expected) => {
    expect(levelsOf(tags)).toBe(expected);
  });
});

describe("normalizeStreetName (SUN-01 encoding)", () => {
  it("makes case, accents and runs of spaces irrelevant", () => {
    expect(normalizeStreetName("FOLKUNGAGATAN")).toBe("folkungagatan");
    expect(normalizeStreetName("Åsögatan")).toBe("asogatan");
    expect(normalizeStreetName("Asogatan")).toBe(normalizeStreetName("Åsögatan"));
    expect(normalizeStreetName("  Ola   Hanssons  gata ")).toBe("ola hanssons gata");
  });

  it("never matches by prefix, suffix or a stripped 'gatan'", () => {
    expect(normalizeStreetName("Folkunga")).not.toBe(normalizeStreetName("Folkungagatan"));
    expect(normalizeStreetName("Folkungagatan")).toBe("folkungagatan");
  });

  it("treats a decomposed and a precomposed ä as the same letter", () => {
    expect(normalizeStreetName("Trädgårdsgatan")).toBe(normalizeStreetName("Trädgårdsgatan"));
  });
});

describe("projection", () => {
  it("is 110 574 m per degree of latitude and 111 320 x cos(lat) per degree of longitude", () => {
    const p = projectFrom(60, 18);
    const [x, y] = p(18, 61);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(110_574, 3);
    const [x2, y2] = p(19, 60);
    expect(x2).toBeCloseTo(111_320 * 0.5, 2);
    expect(y2).toBeCloseTo(0, 6);
  });

  it("unprojectFrom is its inverse", () => {
    const [lng, lat] = unprojectFrom(59.3, 18.07)(123.4, -56.7);
    const [x, y] = projectFrom(59.3, 18.07)(lng, lat);
    expect(x).toBeCloseTo(123.4, 6);
    expect(y).toBeCloseTo(-56.7, 6);
  });
});

describe("buildOsmIndex: ways and roads", () => {
  it("indexes a closed way with its id, levels and area", () => {
    const idx = index({ buildings: [way(11, rect(0, 0, 20, 10), { building: "apartments", "building:levels": "6" })] });
    expect(idx.buildings).toHaveLength(1);
    expect(idx.buildings[0].id).toBe("way/11");
    expect(idx.buildings[0].levels).toBe(6);
    expect(idx.buildings[0].areaM2).toBeCloseTo(200, 0);
    expect(idx.skipped).toEqual({ invalidWays: 0, relationsWithoutOuter: 0 });
  });

  it("skips and counts ways with fewer than 4 points or an unclosed ring", () => {
    const three = way(1, [[0, 0], [10, 0], [0, 0]]);
    const open = way(2, [[0, 0], [10, 0], [10, 10], [0, 10]]);
    const ok = way(3, rect(0, 0, 5, 5));
    const idx = index({ buildings: [three, open, ok] });
    expect(idx.buildings.map((b) => b.id)).toEqual(["way/3"]);
    expect(idx.skipped.invalidWays).toBe(2);
  });

  it("indexes only named roads with at least two points, grouped by normalized name", () => {
    const idx = index({
      roads: [
        way(1, [[0, 0], [50, 0]], { highway: "residential", name: "Folkungagatan" }),
        way(2, [[50, 0], [90, 0]], { highway: "residential", name: "FOLKUNGAGATAN" }),
        way(3, [[0, 5], [50, 5]], { highway: "service" }),
        way(4, [[0, 9]], { highway: "residential", name: "Punktgatan" }),
      ],
    });
    expect(idx.roads).toHaveLength(2);
    expect(idx.roadsByName.get("folkungagatan")).toHaveLength(2);
    expect(idx.roadsByName.has("punktgatan")).toBe(false);
  });
});

describe("buildOsmIndex: courtyard multipolygons (RESEARCH Pitfalls 2 and 3)", () => {
  // Outer ring A(0,0) B(40,0) C(40,30) D(0,30), cut into fragments.
  const A: XY = [0, 0];
  const B: XY = [40, 0];
  const C: XY = [40, 30];
  const D: XY = [0, 30];

  it("stitches two fragments that join end to start plus one reversed fragment into one closed ring", () => {
    const rel = relation(7, [member(1, "outer", [A, B, C]), member(2, "outer", [C, D]), member(3, "outer", [A, D])]);
    const idx = index({ relations: [rel] });
    expect(idx.buildings).toHaveLength(1);
    expect(idx.buildings[0].id).toBe("relation/7");
    const ring = idx.buildings[0].outer;
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(idx.buildings[0].areaM2).toBeCloseTo(1200, 0);
    expect(idx.skipped.relationsWithoutOuter).toBe(0);
  });

  it("stitches fragments given out of order", () => {
    const rel = relation(8, [member(3, "outer", [A, D]), member(2, "outer", [C, D]), member(1, "outer", [A, B, C])]);
    const idx = index({ relations: [rel] });
    expect(idx.buildings).toHaveLength(1);
    expect(idx.buildings[0].areaM2).toBeCloseTo(1200, 0);
  });

  it("skips a relation whose outer fragments cannot close and counts it", () => {
    const rel = relation(9, [member(1, "outer", [A, B, C]), member(2, "outer", [C, D])]);
    const idx = index({ relations: [rel] });
    expect(idx.buildings).toHaveLength(0);
    expect(idx.skipped.relationsWithoutOuter).toBe(1);
  });

  it("skips a relation with no outer member at all", () => {
    const idx = index({ relations: [relation(10, [member(1, "inner", rect(10, 10, 20, 20))])] });
    expect(idx.buildings).toHaveLength(0);
    expect(idx.skipped.relationsWithoutOuter).toBe(1);
  });

  it("makes an inner ring a hole of the outer that contains it: a point in the hole is outside the building", () => {
    const rel = relation(12, [member(1, "outer", rect(0, 0, 40, 30)), member(2, "inner", rect(10, 10, 30, 20))]);
    const idx = index({ relations: [rel] });
    const b = idx.buildings[0];
    expect(b.inners).toHaveLength(1);
    const at = (x: number, y: number) => {
      const [lng, lat] = unproj(x, y);
      return pointInBuilding(b, lng, lat);
    };
    expect(at(20, 15)).toBe(false); // in the courtyard
    expect(at(5, 5)).toBe(true); // in the solid part
    expect(at(100, 100)).toBe(false); // nowhere near
  });

  it("stitches a hole that arrives in two fragments", () => {
    const hole: XY[] = rect(10, 10, 30, 20);
    const rel = relation(13, [member(1, "outer", rect(0, 0, 40, 30)), member(2, "inner", hole.slice(0, 3)), member(3, "inner", hole.slice(2))]);
    const idx = index({ relations: [rel] });
    expect(idx.buildings[0].inners).toHaveLength(1);
  });

  it("gives each outer ring its own entry (relation/<id>, then relation/<id>#2) and attaches each hole to its own outer", () => {
    const rel = relation(14, [
      member(1, "outer", rect(0, 0, 40, 30)),
      member(2, "outer", rect(100, 0, 140, 30)),
      member(3, "inner", rect(110, 10, 130, 20)),
    ]);
    const idx = index({ relations: [rel] });
    expect(idx.buildings.map((b) => b.id)).toEqual(["relation/14", "relation/14#2"]);
    expect(idx.buildings[0].inners).toHaveLength(0);
    expect(idx.buildings[1].inners).toHaveLength(1);
  });

  it("drops an inner ring that no outer contains", () => {
    const rel = relation(15, [member(1, "outer", rect(0, 0, 40, 30)), member(2, "inner", rect(200, 200, 210, 210))]);
    const idx = index({ relations: [rel] });
    expect(idx.buildings).toHaveLength(1);
    expect(idx.buildings[0].inners).toHaveLength(0);
  });

  it("takes the building tags (levels) from the relation", () => {
    const rel = relation(16, [member(1, "outer", rect(0, 0, 40, 30))], { building: "apartments", "building:levels": "5" });
    expect(index({ relations: [rel] }).buildings[0].levels).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Heights (D-06 / R-04) and walls around a point (plan 14.3-04, task 1)
// ---------------------------------------------------------------------------

describe("heightOf (D-06: tag, then levels x 3 + 2, then small types)", () => {
  it.each([
    ["a dot decimal", { height: "18.5" }, 18.5],
    ["a comma decimal", { height: "5,5" }, 5.5],
    ["a trailing ' m'", { height: "21 m" }, 21],
    ["the first number of a list", { height: "21;24" }, 21],
  ])("reads the height tag with %s as it is, not estimated", (_name, tags, expected) => {
    expect(heightOf(tags)).toEqual({ heightM: expected, estimated: false });
  });

  it("lets the height tag win over the storey count", () => {
    expect(heightOf({ height: "18.5", "building:levels": "9" })).toEqual({ heightM: 18.5, estimated: false });
  });

  it("falls back to the storey count when the height tag is not a positive number", () => {
    expect(heightOf({ height: "tall", "building:levels": "4" })).toEqual({ heightM: 14, estimated: false });
    expect(heightOf({ height: "0", "building:levels": "4" })).toEqual({ heightM: 14, estimated: false });
  });

  it("turns 6 storeys into 20 m (6 x 3 + 2), a tag-derived figure that is not estimated", () => {
    expect(heightOf({ "building:levels": "6" })).toEqual({ heightM: 20, estimated: false });
    expect(heightOf({ "building:levels": "5,5" })).toEqual({ heightM: 18.5, estimated: false });
  });

  it("adds no roof allowance: 6 storeys plus 1 roof level is still 20 m", () => {
    expect(heightOf({ "building:levels": "6", "roof:levels": "1" })).toEqual({ heightM: 20, estimated: false });
    expect(HEIGHT_PARAMS.storeyM).toBe(3);
    expect(HEIGHT_PARAMS.baseM).toBe(2);
  });

  it.each(["shed", "garage", "garages", "hut", "kiosk", "carport", "roof", "allotment_house", "greenhouse"])(
    "gives a %s without a height or storey tag 3 m, marked estimated",
    (kind) => {
      expect(heightOf({ building: kind })).toEqual({ heightM: 3, estimated: true });
    },
  );

  it("lets a storey count beat the small-type default", () => {
    expect(heightOf({ building: "garage", "building:levels": "2" })).toEqual({ heightM: 8, estimated: false });
  });

  it("returns null when only the neighbourhood can tell (no tags, an ordinary building type)", () => {
    expect(heightOf({})).toBeNull();
    expect(heightOf({ building: "yes" })).toBeNull();
    expect(heightOf({ building: "apartments" })).toBeNull();
  });
});

describe("buildingHeight (local median within 150 m, then the innerstan median)", () => {
  /** An untagged 10 x 10 m building centred at (cx, cy), plus tagged ones around it. */
  const square = (cx: number, cy: number): XY[] => rect(cx - 5, cy - 5, cx + 5, cy + 5);
  const tagged = (id: number, cx: number, cy: number, tags: Record<string, string>) => way(id, square(cx, cy), { building: "yes", ...tags });
  const centre = way(1, square(0, 0));
  const find = (idx: ReturnType<typeof index>, id: string) => {
    const b = idx.buildings.find((x) => x.id === id);
    if (b === undefined) throw new Error(`no building ${id}`);
    return b;
  };

  it("returns a tagged building's own height and does not flag it", () => {
    const idx = index({ buildings: [tagged(2, 0, 0, { "building:levels": "5" })] });
    expect(buildingHeight(idx, find(idx, "way/2"))).toEqual({ heightM: 17, estimated: false });
  });

  it("takes the median of 14, 17, 20 and 23 m (even count: mean of the two middle values) = 18.5, estimated", () => {
    const idx = index({
      buildings: [
        centre,
        tagged(2, 50, 0, { height: "14" }),
        tagged(3, 0, 50, { height: "17" }),
        tagged(4, -50, 0, { height: "20" }),
        tagged(5, 0, -50, { height: "23" }),
      ],
    });
    expect(buildingHeight(idx, find(idx, "way/1"))).toEqual({ heightM: 18.5, estimated: true });
  });

  it("takes the middle value for an odd count", () => {
    const idx = index({
      buildings: [centre, tagged(2, 50, 0, { height: "14" }), tagged(3, 0, 50, { height: "20" }), tagged(4, -50, 0, { height: "30" })],
    });
    expect(buildingHeight(idx, find(idx, "way/1")).heightM).toBe(20);
  });

  it("counts a neighbour whose centre is exactly 150.0 m away (the 150 m boundary is inclusive)", () => {
    const idx = index({ buildings: [centre, tagged(2, 150, 0, { height: "30" })] });
    expect(buildingHeight(idx, find(idx, "way/1"))).toEqual({ heightM: 30, estimated: true });
  });

  it("ignores a neighbour whose centre is 150.1 m away: the 150 m boundary is not off by a step", () => {
    const idx = index({ buildings: [centre, tagged(2, 150.1, 0, { height: "30" })] });
    expect(buildingHeight(idx, find(idx, "way/1"))).toEqual({ heightM: 17, estimated: true });
  });

  it("measures the distance in a straight line, not along the axes (a neighbour at (110, 110) is 155.6 m away)", () => {
    const idx = index({ buildings: [centre, tagged(2, 110, 110, { height: "30" })] });
    expect(buildingHeight(idx, find(idx, "way/1")).heightM).toBe(17);
  });

  it("does not count shed-like neighbours, even when they carry a height tag", () => {
    const idx = index({
      buildings: [centre, tagged(2, 40, 0, { height: "20" }), tagged(3, -40, 0, { building: "shed", height: "3" }), tagged(4, 0, 40, { building: "garage", "building:levels": "1" })],
    });
    expect(buildingHeight(idx, find(idx, "way/1")).heightM).toBe(20);
  });

  it("does not count untagged neighbours, so one estimate never feeds another", () => {
    const idx = index({ buildings: [centre, tagged(2, 40, 0, { height: "26" }), way(3, square(0, 40)), way(4, square(0, -40))] });
    expect(buildingHeight(idx, find(idx, "way/1")).heightM).toBe(26);
    expect(buildingHeight(idx, find(idx, "way/3")).heightM).toBe(26);
  });

  it("falls back to the innerstan median of 5 storeys = 17 m, estimated, when no tagged neighbour is in reach", () => {
    expect(HEIGHT_PARAMS.fallbackLevels).toBe(5);
    const alone = index({ buildings: [centre] });
    expect(buildingHeight(alone, alone.buildings[0])).toEqual({ heightM: 17, estimated: true });
    const idx = index({ buildings: [centre, tagged(2, 300, 0, { height: "30" }), tagged(3, 0, 160, { height: "30" })] });
    expect(buildingHeight(idx, find(idx, "way/1"))).toEqual({ heightM: 17, estimated: true });
  });

  it("gives a shed 3 m, estimated, without looking at the neighbours", () => {
    const idx = index({ buildings: [way(1, square(0, 0), { building: "shed" }), tagged(2, 30, 0, { height: "40" })] });
    expect(buildingHeight(idx, find(idx, "way/1"))).toEqual({ heightM: 3, estimated: true });
  });

  it("uses the building's centroid, so a long building looks at its own surroundings", () => {
    const idx = index({
      buildings: [way(1, rect(-60, -5, 60, 5)), tagged(2, 0, 100, { height: "24" }), tagged(3, 200, 0, { height: "40" })],
    });
    expect(buildingHeight(idx, find(idx, "way/1")).heightM).toBe(24);
  });

  it("returns the same object on the second call (memoised per building)", () => {
    const idx = index({ buildings: [centre, tagged(2, 50, 0, { height: "14" })] });
    const b = find(idx, "way/1");
    expect(buildingHeight(idx, b)).toBe(buildingHeight(idx, b));
  });

  it("gives every building the same height whatever the order of the buildings array", () => {
    const list = [
      centre,
      tagged(2, 50, 0, { height: "14" }),
      tagged(3, 0, 50, { height: "17" }),
      tagged(4, -50, 0, { height: "20" }),
      tagged(5, 0, -50, { height: "23" }),
      way(6, square(120, 120)),
      tagged(7, 140, 0, { "building:levels": "7" }),
      way(8, square(-90, 30), { building: "shed" }),
    ];
    const forward = index({ buildings: list });
    const backward = index({ buildings: [...list].reverse() });
    for (const b of forward.buildings) {
      expect(buildingHeight(backward, find(backward, b.id))).toEqual(buildingHeight(forward, b));
    }
  });

  it("works on the real Folkungagatan fixture: every building gets a finite height and the estimated share is the minority", () => {
    const idx = buildOsmIndex(parseOsmExtract(JSON.parse(readFileSync(join(__dirname, "__fixtures__", "osm-folkungagatan-61.fixture.json"), "utf8"))));
    const heights = idx.buildings.map((b) => buildingHeight(idx, b));
    expect(heights.every((h) => Number.isFinite(h.heightM) && h.heightM > 0)).toBe(true);
    const estimated = heights.filter((h) => h.estimated).length;
    expect(estimated).toBeGreaterThan(0);
    expect(estimated).toBeLessThan(heights.length / 2);
  });
});

describe("buildingHeight sanity rule: an orimlig height tag is replaced and flagged (14.3 review CR-01)", () => {
  const square = (cx: number, cy: number): XY[] => rect(cx - 5, cy - 5, cx + 5, cy + 5);
  const tagged = (id: number, cx: number, cy: number, tags: Record<string, string>) => way(id, square(cx, cy), { building: "yes", ...tags });
  const find = (idx: ReturnType<typeof index>, id: string) => {
    const b = idx.buildings.find((x) => x.id === id);
    if (b === undefined) throw new Error(`no building ${id}`);
    return b;
  };
  /** Two ordinary 20 m neighbours, so the local median is 20. */
  const neighbours = [tagged(90, 60, 0, { "building:levels": "6" }), tagged(91, -60, 0, { "building:levels": "6" })];

  it("replaces the Ringen centrum tag (151,7 m on 6 storeys) with the storey formula, estimated and suspect", () => {
    const idx = index({ buildings: [...neighbours, tagged(1, 0, 0, { height: "151.703703", "building:levels": "6" })] });
    expect(buildingHeight(idx, find(idx, "way/1"))).toEqual({ heightM: 20, estimated: true, suspect: true });
  });

  it("flags a tag over 2,5 times the storey formula even next to low neighbours", () => {
    const idx = index({ buildings: [tagged(1, 0, 0, { height: "60", "building:levels": "4" })] });
    expect(buildingHeight(idx, find(idx, "way/1"))).toMatchObject({ heightM: 14, estimated: true, suspect: true });
  });

  it("flags more than 60 m on at most 8 storeys even when the ratio rule would pass it", () => {
    // 8 storeys = 26 m, 2,5 x 26 = 65 m: a 62 m tag passes the ratio rule but not the 60 m / 8 storeys rule.
    const idx = index({ buildings: [tagged(1, 0, 0, { height: "62", "building:levels": "8" })] });
    expect(buildingHeight(idx, find(idx, "way/1"))).toMatchObject({ heightM: 26, estimated: true, suspect: true });
    const nine = index({ buildings: [tagged(1, 0, 0, { height: "62", "building:levels": "9" })] });
    expect(buildingHeight(nine, find(nine, "way/1"))).toEqual({ heightM: 62, estimated: false });
  });

  it("falls back to the local median when an orimlig tag comes with no storey count", () => {
    const idx = index({ buildings: [...neighbours, tagged(1, 0, 0, { height: "90" })] });
    expect(buildingHeight(idx, find(idx, "way/1"))).toEqual({ heightM: 20, estimated: true, suspect: true });
  });

  it("keeps a real tall block: 12 storeys tagged 40 m", () => {
    const idx = index({ buildings: [...neighbours, tagged(1, 0, 0, { height: "40", "building:levels": "12" })] });
    expect(buildingHeight(idx, find(idx, "way/1"))).toEqual({ heightM: 40, estimated: false });
  });

  it("does not let a low-rise pocket make a 41 m museum on 4 storeys look absurd (the innerstan typical height is the floor)", () => {
    const low = [tagged(90, 60, 0, { height: "5" }), tagged(91, -60, 0, { height: "5" }), tagged(92, 0, 60, { height: "6" })];
    const idx = index({ buildings: [...low, tagged(1, 0, 0, { height: "41", "building:levels": "4", building: "museum" })] });
    expect(buildingHeight(idx, find(idx, "way/1"))).toEqual({ heightM: 41, estimated: false });
  });

  it.each([
    ["a church", { building: "church", height: "64.5", "building:levels": "1.5" }],
    ["a chimney", { building: "yes", man_made: "chimney", height: "108" }],
    ["a tower", { building: "yes", man_made: "tower", height: "90" }],
  ])("believes the height tag of %s however tall", (_name, tags) => {
    const idx = index({ buildings: [...neighbours, way(1, square(0, 0), tags)] });
    const h = buildingHeight(idx, find(idx, "way/1"));
    expect(h).toEqual({ heightM: Number(tags.height), estimated: false });
    expect(h.suspect).toBeUndefined();
  });

  it("believes a way on the landmark allowlist (Fritt fall, Gröna Lund) even though it is a plain building=yes", () => {
    expect(HEIGHT_PARAMS.trustedTallIds).toContain("way/1122922291");
    const idx = index({ buildings: [...neighbours, tagged(1122922291, 0, 0, { height: "80" })] });
    expect(buildingHeight(idx, find(idx, "way/1122922291"))).toEqual({ heightM: 80, estimated: false });
  });

  it("does not let a rejected tag pull a neighbour's median: one 151,7 m neighbour and one 14 m neighbour give 17 m, not 82,9 m", () => {
    const idx = index({
      buildings: [way(1, square(0, 0)), tagged(2, 50, 0, { height: "151.7", "building:levels": "6" }), tagged(3, -50, 0, { height: "14" })],
    });
    expect(buildingHeight(idx, find(idx, "way/1"))).toEqual({ heightM: 17, estimated: true });
  });

  it("hands the replaced height to the wall step: the walls of the Ringen-style building are 20 m and estimated", () => {
    const idx = index({ buildings: [tagged(1, 100, 0, { height: "151.7", "building:levels": "6" })] });
    const walls = wallsNear(idx, LAT0, LNG0, 250);
    expect(walls).toHaveLength(4);
    for (const w of walls) {
      expect(w.heightM).toBe(20);
      expect(w.estimated).toBe(true);
    }
  });

  it("suspectHeights lists every rejected tag with the tag and the height used, and nothing else", () => {
    const idx = index({
      buildings: [
        ...neighbours,
        tagged(1, 0, 0, { height: "151.7", "building:levels": "6" }),
        tagged(2, 0, 60, { height: "40", "building:levels": "12" }),
        way(3, square(0, -60), { building: "church", height: "116" }),
        way(4, square(120, 0), { building: "yes" }),
      ],
    });
    expect(suspectHeights(idx)).toEqual([{ id: "way/1", taggedM: 151.7, usedM: 20 }]);
    expect(suspectHeights(index({ buildings: neighbours }))).toEqual([]);
  });

  it("is stable: asking twice, or in the other building order, gives the same answer", () => {
    const list = [...neighbours, tagged(1, 0, 0, { height: "151.7", "building:levels": "6" }), way(5, square(0, 40))];
    const forward = index({ buildings: list });
    const backward = index({ buildings: [...list].reverse() });
    for (const b of forward.buildings) expect(buildingHeight(backward, find(backward, b.id))).toEqual(buildingHeight(forward, b));
  });
});

describe("wallsNear (every ring edge of the buildings within reach, in metres around the point)", () => {
  const tagged = (id: number, pts: XY[], height = "20") => way(id, pts, { building: "yes", height });

  it("returns the four edges of a square building in metres east/north of the point, with its height", () => {
    const idx = index({ buildings: [tagged(1, rect(100, -5, 110, 5), "22")] });
    const walls = wallsNear(idx, LAT0, LNG0, 250);
    expect(walls).toHaveLength(4);
    for (const w of walls) {
      expect(w.heightM).toBe(22);
      expect(w.estimated).toBe(false);
      for (const x of [w.x1, w.x2]) expect(x).toBeGreaterThan(99.9);
      for (const x of [w.x1, w.x2]) expect(x).toBeLessThan(110.1);
      for (const y of [w.y1, w.y2]) expect(Math.abs(y)).toBeLessThan(5.1);
    }
  });

  it("measures around the asked point, not around the extract centre", () => {
    const idx = index({ buildings: [tagged(1, rect(100, -5, 110, 5))] });
    const [lng, lat] = unproj(100, 0);
    const xs = wallsNear(idx, lat, lng, 250).flatMap((w) => [w.x1, w.x2]);
    expect(Math.min(...xs)).toBeCloseTo(0, 1);
    expect(Math.max(...xs)).toBeCloseTo(10, 1);
  });

  it("includes the edges of the courtyard hole as well as the outer ring", () => {
    const rel = relation(7, [member(1, "outer", rect(60, -30, 120, 30)), member(2, "inner", rect(80, -10, 100, 10))], { building: "yes", height: "18", type: "multipolygon" });
    const idx = index({ relations: [rel] });
    const walls = wallsNear(idx, LAT0, LNG0, 250);
    expect(walls).toHaveLength(8);
    const inner = walls.filter((w) => Math.max(Math.abs(w.y1), Math.abs(w.y2)) <= 10.1 && Math.min(w.x1, w.x2) >= 79.9 && Math.max(w.x1, w.x2) <= 100.1);
    expect(inner).toHaveLength(4);
  });

  it("carries the estimated flag of untagged buildings (the local estimate)", () => {
    const idx = index({ buildings: [tagged(1, rect(60, -5, 70, 5), "24"), way(2, rect(-70, -5, -60, 5))] });
    const walls = wallsNear(idx, LAT0, LNG0, 250);
    expect(walls.filter((w) => w.estimated)).toHaveLength(4);
    expect(walls.filter((w) => w.estimated).every((w) => w.heightM === 24)).toBe(true);
  });

  it("takes a building with a vertex at 299 m (radius 250 + margin 50) and leaves one whose nearest vertex is 301 m away", () => {
    expect(HEIGHT_PARAMS.wallMarginM).toBe(50);
    const idx = index({ buildings: [tagged(1, rect(299, 0, 310, 10)), tagged(2, rect(-301, 0, -310, 10))] });
    const walls = wallsNear(idx, LAT0, LNG0, 250);
    expect(walls).toHaveLength(4);
    expect(Math.min(...walls.flatMap((w) => [w.x1, w.x2]))).toBeGreaterThan(298.9);
  });

  it("finds a long building whose centre is far away but whose end is near (the grid is not centroid-only)", () => {
    const idx = index({ buildings: [tagged(1, rect(200, -5, 900, 5))] });
    expect(wallsNear(idx, LAT0, LNG0, 250)).toHaveLength(4);
  });

  it("returns nothing for an empty extract and for a point far from every building", () => {
    expect(wallsNear(index({}), LAT0, LNG0, 250)).toEqual([]);
    expect(wallsNear(index({ buildings: [tagged(1, rect(1000, 1000, 1010, 1010))] }), LAT0, LNG0, 250)).toEqual([]);
  });

  it("returns the same walls whatever the order of the buildings array", () => {
    const list = [tagged(1, rect(50, 0, 60, 10)), tagged(2, rect(-80, 20, -60, 40), "12"), way(3, rect(0, 120, 30, 140)), tagged(4, rect(150, -90, 170, -60), "9")];
    const key = (ws: ReturnType<typeof wallsNear>) => ws.map((w) => JSON.stringify(w)).sort();
    expect(key(wallsNear(index({ buildings: [...list].reverse() }), LAT0, LNG0, 250))).toEqual(key(wallsNear(index({ buildings: list }), LAT0, LNG0, 250)));
  });

  it("lists the walls around Folkungagatan 61 on the real fixture", () => {
    const idx = buildOsmIndex(parseOsmExtract(JSON.parse(readFileSync(join(__dirname, "__fixtures__", "osm-folkungagatan-61.fixture.json"), "utf8"))));
    const walls = wallsNear(idx, 59.3147546, 18.07681659, 250);
    expect(walls.length).toBeGreaterThan(500);
    expect(walls.every((w) => Number.isFinite(w.x1 + w.y1 + w.x2 + w.y2) && w.heightM > 0)).toBe(true);
    expect(Math.max(...walls.flatMap((w) => [Math.hypot(w.x1, w.y1)]))).toBeGreaterThan(150);
  });
});
