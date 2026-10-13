import { describe, expect, it } from "vitest";
import {
  OSM_ATTRIBUTION,
  buildOsmIndex,
  levelsOf,
  normalizeStreetName,
  parseOsmExtract,
  pointInBuilding,
  projectFrom,
  unprojectFrom,
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
