/**
 * sun-facade.ts - which way a flat's building faces, from its footprint
 * (Phase 14.3, SUN-01). Given an OpenStreetMap index, a flat's point and its
 * address, it finds the building the point lies in, takes the walls that face
 * a street of the SAME NAME as the address, and returns the street facade as a
 * compass bearing, its 4-sector facade and a confidence. The courtyard facade
 * is the opposite side.
 *
 * PURE, synchronous - no file or environment access, no network, no clock, no
 * randomness, no console output. The same index and the same input always give
 * the same answer: ties are settled by id, never by array order.
 *
 * HONEST DEGRADE (D-02): it never guesses. When it cannot tell it returns
 * `{ status: "unknown", reason }` with one of {@link SUN_UNKNOWN_REASONS}, and an
 * unknown never scores and prints "okänd". The street name comes from the
 * ADDRESS (R-02); the OSM `addr:street` tag is never read - 40 % of buildings
 * carry no address tag and the tag can disagree with the street the flat is
 * sold under.
 *
 * Azimuth convention (the same as sun-path.ts): degrees, 0 = north, 90 = east,
 * 180 = south, 270 = west, clockwise.
 *
 * Every number lives in {@link SUN_FACADE_PARAMS}; the functions own no
 * constants. Rounding is Math.round on the scaled value (half towards
 * +infinity); the facade is taken from the STORED (rounded) bearing.
 *
 * STRUCTURAL SEPARATION (LOCKED): `niche-score.ts` and `report/flags.ts` must
 * NEVER import this module. The static-grep invariant in `niche-score.test.ts`
 * enforces that; the `discovery/sun-` prefix is registered there.
 */

import {
  type OsmBuilding,
  type OsmIndex,
  type OsmRoad,
  normalizeStreetName,
  pointInBuilding,
  projectFrom,
  unprojectFrom,
} from "@/lib/discovery/osm-buildings";
import type { Facade } from "@/lib/discovery/sun-path";

export { normalizeStreetName };

/** Every tunable number of the facade inference, in one place (like TASTE_WEIGHTS). */
export const SUN_FACADE_PARAMS = {
  /** Walls shorter than this are ignored (metres). */
  edgeMinM: 2.5,
  /** A wall qualifies as a frontage only when the same-name road is at most this far from its midpoint (metres, inclusive). */
  streetMaxM: 35,
  /** ... and the road lies in front of the wall: dot(outward normal, unit vector to the road) must exceed this. */
  frontDotMin: 0.5,
  /** Walls whose normals are within this many degrees share a group. */
  groupTolDeg: 25,
  /** Wall weight = length x exp(-road distance / decayM). */
  decayM: 12,
  /** A point outside every polygon snaps to the nearest wall at most this far away (metres, inclusive). */
  snapMaxM: 25,
  /** The second group makes the flat a corner flat when its weight is STRICTLY greater than this share of the top group's. */
  ambiguousRatio: 0.6,
  /** The street / courtyard point is pushed this far out of the wall (metres). */
  outwardPushM: 0.3,
  /** A wall can hold the courtyard point when its normal is within this many degrees (inclusive) of the courtyard bearing. */
  courtyardTolDeg: 45,
  /** The outward normal is the one whose point this far from the wall midpoint is NOT inside the building (metres). */
  normalProbeM: 0.5,
  /** Group weights closer than this relative difference count as a tie (settled by street distance, then bearing). */
  weightTieRel: 1e-9,
  /** Judgement, not measurement (RESEARCH A5): ranks flats by plausibility. */
  confidence: {
    snapped: 0.7,
    nearStreetM: 10,
    farStreet: 0.8,
    frontageMinM: 8,
    shortFrontage: 0.7,
    floorAboveLevels: 0.5,
    shareBase: 0.4,
    shareWeight: 0.6,
  },
  /** Sector starts of the 4 facades, in degrees: north is [northFrom, 360) and [0, eastFrom). */
  sectors: { eastFrom: 45, southFrom: 135, westFrom: 225, northFrom: 315 },
  /** Stored precision: bearing, distance and length to 1 decimal, confidence to 2, points to 7. */
  decimals: { bearing: 1, distance: 1, confidence: 2, point: 7 },
} as const;

/** The five reasons a flat gets "okänd". The first check that fires is the reason. */
export const SUN_UNKNOWN_REASONS = [
  "koordinater saknas",
  "adress saknas",
  "utanför OSM-utdraget",
  "ingen byggnad inom 25 m",
  "ingen gata med samma namn inom 35 m",
] as const;
export type SunUnknownReason = (typeof SUN_UNKNOWN_REASONS)[number];

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const roundTo = (n: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(n * f) / f || 0; // `|| 0` turns -0 into 0
};

/** A bearing rounded to its stored precision; 360,0 becomes 0,0. */
const roundBearing = (deg: number): number => {
  const r = roundTo(((deg % 360) + 360) % 360, SUN_FACADE_PARAMS.decimals.bearing);
  return r >= 360 ? 0 : r;
};

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * The street of an address: the trailing house number, an optional letter and
 * an optional "-number" range removed ("Folkungagatan 61 B" and "Karlbergsvägen
 * 77-81" give the street alone). Empty string when the address is missing or
 * holds no letters.
 */
export function streetNameOf(address: string | null | undefined): string {
  if (address === null || address === undefined) return "";
  const street = address.replace(/\s+\d+\s*[A-Za-zÅÄÖåäö]?(?:-\d+)?\s*$/, "").trim();
  return /\p{L}/u.test(street) ? street : "";
}

/** The smaller angle between two bearings, in [0, 180]. */
export function angularDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** The 4-sector facade of a bearing: north [315, 45), east [45, 135), south [135, 225), west [225, 315). */
export function bearingToFacade(deg: number): Facade {
  const s = SUN_FACADE_PARAMS.sectors;
  const d = ((deg % 360) + 360) % 360;
  if (d >= s.northFrom || d < s.eastFrom) return "north";
  if (d < s.southFrom) return "east";
  if (d < s.westFrom) return "south";
  return "west";
}

/** Ids order by their number, then by text ("lower id" wins ties). */
function compareIds(a: string, b: string): number {
  const na = Number(/\d+/.exec(a)?.[0] ?? 0);
  const nb = Number(/\d+/.exec(b)?.[0] ?? 0);
  if (na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Planar geometry (local metres, x east, y north)
// ---------------------------------------------------------------------------

type XY = [number, number];

const bearingOfXY = (dx: number, dy: number): number => ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;

function closestOnSegment(p: XY, a: XY, b: XY): { d: number; c: XY } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  const c: XY = [a[0] + t * dx, a[1] + t * dy];
  return { d: Math.hypot(p[0] - c[0], p[1] - c[1]), c };
}

/** Even-odd ray casting. */
function inRingXY(p: XY, ring: readonly XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const inSolidXY = (p: XY, outer: readonly XY[], inners: readonly XY[][]): boolean =>
  inRingXY(p, outer) && !inners.some((h) => inRingXY(p, h));

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface FootprintOk {
  readonly status: "ok";
  /** "way/<id>" or "relation/<id>" of the building the flat belongs to. */
  readonly osmId: string;
  /** True when the Booli point lay inside the building; false when it snapped to the nearest wall. */
  readonly inside: boolean;
  /** Distance from the point to the nearest wall when it snapped, else 0 (metres, 1 decimal). */
  readonly snapM: number;
  readonly streetBearingDeg: number;
  readonly streetFacade: Facade;
  readonly courtyardBearingDeg: number;
  readonly courtyardFacade: Facade;
  readonly confidence: number;
  /** Total length of the walls facing the street (metres, 1 decimal). */
  readonly frontageM: number;
  /** Distance from the nearest frontage wall to the street (metres, 1 decimal). */
  readonly streetDistM: number;
  /** A corner flat: a second wall group faces the street almost as strongly. */
  readonly ambiguous: boolean;
  /** The Booli floor is above the building's `building:levels`: probably the wrong building. */
  readonly floorAboveLevels: boolean;
  /** Where the street side's windows would be: on the wall, pushed out 0,3 m. Null when unknown. */
  readonly streetPoint: { readonly lat: number; readonly lng: number };
  /** The same for the courtyard side, null when no wall faces the courtyard bearing. */
  readonly courtyardPoint: { readonly lat: number; readonly lng: number } | null;
}

export interface FootprintUnknown {
  readonly status: "unknown";
  readonly reason: SunUnknownReason;
}

export type FootprintResult = FootprintOk | FootprintUnknown;

export interface FacadeInput {
  readonly lat: number | null;
  readonly lng: number | null;
  readonly address: string | null;
  /** The Booli floor, null when unknown. */
  readonly floor: number | null;
}

const unknown = (reason: SunUnknownReason): FootprintUnknown => ({ status: "unknown", reason });

/** One wall of the building (outer ring first, then courtyard holes) of at least edgeMinM. */
interface Wall {
  /** Position in the building's wall list. */
  readonly order: number;
  readonly a: XY;
  readonly b: XY;
  readonly lengthM: number;
  /** Unit normal pointing out of the building. */
  readonly normal: XY;
  readonly bearing: number;
}

/** A wall that faces a same-name road. */
interface Edge extends Wall {
  readonly roadDistM: number;
  readonly weight: number;
}

interface Group {
  bearing: number;
  weight: number;
  readonly edges: Edge[];
}

/** Weighted circular mean of the edges' normal bearings. */
function circularMean(edges: readonly Edge[]): number {
  let sx = 0;
  let sy = 0;
  for (const e of edges) {
    sx += e.weight * Math.sin((e.bearing * Math.PI) / 180);
    sy += e.weight * Math.cos((e.bearing * Math.PI) / 180);
  }
  return ((Math.atan2(sx, sy) * 180) / Math.PI + 360) % 360;
}

const toXY = (proj: (lng: number, lat: number) => XY, ring: readonly [number, number][]): XY[] => ring.map(([x, y]) => proj(x, y));

/**
 * The building the point belongs to: the smallest polygon containing it (tie:
 * lower id), else the building with the nearest wall (outer ring or hole) at
 * most snapMaxM away (compared at stored precision, so 25,0 m snaps whatever the
 * float noise). Null when neither exists.
 */
function findOwnBuilding(index: OsmIndex, lat: number, lng: number): { building: OsmBuilding; inside: boolean; snapM: number } | null {
  const P = SUN_FACADE_PARAMS;
  const containing = index.buildings.filter((b) => pointInBuilding(b, lng, lat));
  if (containing.length > 0) {
    containing.sort((a, b) => a.areaM2 - b.areaM2 || compareIds(a.id, b.id));
    return { building: containing[0], inside: true, snapM: 0 };
  }
  const proj = projectFrom(lat, lng);
  const origin: XY = [0, 0];
  // Cheap prefilter: the building's box grown by the snap distance must contain the point.
  const dLat = (P.snapMaxM + 1) / 110_574;
  const dLng = (P.snapMaxM + 1) / (111_320 * Math.cos((lat * Math.PI) / 180));
  let best: { building: OsmBuilding; d: number } | null = null;
  for (const b of index.buildings) {
    const [minLng, minLat, maxLng, maxLat] = b.bbox;
    if (lng < minLng - dLng || lng > maxLng + dLng || lat < minLat - dLat || lat > maxLat + dLat) continue;
    let d = Infinity;
    for (const ring of [b.outer, ...b.inners]) {
      const xy = toXY(proj, ring);
      for (let i = 0; i < xy.length - 1; i++) d = Math.min(d, closestOnSegment(origin, xy[i], xy[i + 1]).d);
    }
    if (best === null || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && compareIds(b.id, best.building.id) < 0)) best = { building: b, d };
  }
  if (best === null) return null;
  const snapM = roundTo(best.d, P.decimals.distance);
  return snapM <= P.snapMaxM ? { building: best.building, inside: false, snapM } : null;
}

/**
 * The street facade and the courtyard facade of the building a flat belongs to.
 *
 * Checks run in this order and the first that fires is the reason: coordinates,
 * address, extract bounds, building, same-name street.
 */
export function inferStreetFacade(index: OsmIndex, input: FacadeInput): FootprintResult {
  const P = SUN_FACADE_PARAMS;
  const { lat, lng } = input;
  if (lat === null || lng === null || !Number.isFinite(lat) || !Number.isFinite(lng)) return unknown("koordinater saknas");
  const street = streetNameOf(input.address);
  if (street === "") return unknown("adress saknas");
  const { south, west, north, east } = index.bbox;
  if (lat < south || lat > north || lng < west || lng > east) return unknown("utanför OSM-utdraget");
  const found = findOwnBuilding(index, lat, lng);
  if (found === null) return unknown("ingen byggnad inom 25 m");
  const own = found.building;

  const proj = projectFrom(lat, lng);
  const unproj = unprojectFrom(lat, lng);
  const origin: XY = [0, 0];
  const outerXY = toXY(proj, own.outer);
  const innersXY = own.inners.map((h) => toXY(proj, h));

  // Same-name road segments (the street is matched by NAME, never by tag).
  const roads: readonly OsmRoad[] = index.roadsByName.get(normalizeStreetName(street)) ?? [];
  const segments: Array<[XY, XY]> = [];
  for (const road of roads) {
    const pts = toXY(proj, road.points);
    for (let i = 0; i < pts.length - 1; i++) segments.push([pts[i], pts[i + 1]]);
  }

  // Walls: the outer ring, then the courtyard holes.
  const walls: Wall[] = [];
  let order = 0;
  for (const ring of [outerXY, ...innersXY]) {
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i];
      const b = ring[i + 1];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const lengthM = Math.hypot(dx, dy);
      const myOrder = order++;
      if (lengthM < P.edgeMinM) continue;
      const mid: XY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      // Outward normal without relying on ring winding: the side whose probe point is NOT inside the building.
      let normal: XY = [dy / lengthM, -dx / lengthM];
      const probe: XY = [mid[0] + P.normalProbeM * normal[0], mid[1] + P.normalProbeM * normal[1]];
      if (inSolidXY(probe, outerXY, innersXY)) normal = [-normal[0], -normal[1]];
      walls.push({ order: myOrder, a, b, lengthM, normal, bearing: bearingOfXY(normal[0], normal[1]) });
    }
  }

  // Frontage: walls with a same-name road in front of them and close enough.
  const edges: Edge[] = [];
  for (const w of walls) {
    const mid: XY = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
    let best: { d: number; c: XY } | null = null;
    for (const [s0, s1] of segments) {
      const hit = closestOnSegment(mid, s0, s1);
      if (best === null || hit.d < best.d) best = hit;
    }
    if (best === null) continue;
    const toStreet: XY = best.d > 0 ? [(best.c[0] - mid[0]) / best.d, (best.c[1] - mid[1]) / best.d] : [0, 0];
    const facing = w.normal[0] * toStreet[0] + w.normal[1] * toStreet[1];
    // Compared at stored precision so 35,0 m qualifies whatever the float noise.
    if (!(facing > P.frontDotMin) || roundTo(best.d, P.decimals.distance) > P.streetMaxM) continue;
    edges.push({ ...w, roadDistM: best.d, weight: w.lengthM * Math.exp(-best.d / P.decayM) });
  }
  if (edges.length === 0) return unknown("ingen gata med samma namn inom 35 m");

  // Greedy grouping over edges sorted by weight desc, then wall order.
  const sorted = [...edges].sort((x, y) => y.weight - x.weight || x.order - y.order);
  const groups: Group[] = [];
  for (const e of sorted) {
    let g = groups.find((cand) => angularDistance(cand.bearing, e.bearing) <= P.groupTolDeg);
    if (g === undefined) {
      g = { bearing: e.bearing, weight: 0, edges: [] };
      groups.push(g);
    }
    g.edges.push(e);
    g.weight += e.weight;
    g.bearing = circularMean(g.edges);
  }
  const minDist = (g: Group): number => Math.min(...g.edges.map((e) => e.roadDistM));
  // Top group: highest weight, then the nearer street, then the lower bearing.
  groups.sort((g1, g2) => {
    const tie = Math.abs(g1.weight - g2.weight) <= P.weightTieRel * Math.max(g1.weight, g2.weight);
    if (!tie) return g2.weight - g1.weight;
    // Distances compare at stored precision so float noise cannot decide a tie.
    return roundTo(minDist(g1), P.decimals.distance) - roundTo(minDist(g2), P.decimals.distance) || g1.bearing - g2.bearing;
  });
  const top = groups[0];
  const second: Group | undefined = groups[1];
  const totalWeight = groups.reduce((s, g) => s + g.weight, 0);
  const share = top.weight / totalWeight;
  const streetDist = roundTo(minDist(top), P.decimals.distance);
  const frontage = roundTo(
    top.edges.reduce((s, e) => s + e.lengthM, 0),
    P.decimals.distance,
  );
  const ambiguous = second !== undefined && second.weight > P.ambiguousRatio * top.weight;

  const streetBearingDeg = roundBearing(top.bearing);
  const courtyardBearingDeg = roundBearing(streetBearingDeg + 180);

  // The street point: the nearest spot on the winning walls to the Booli point, pushed out of the wall.
  const streetPoint = pushedPoint(top.edges, origin, P.outwardPushM, unproj);
  // The courtyard point: the same on any wall whose normal is within the tolerance of the courtyard bearing.
  const courtyardWalls = walls.filter((w) => angularDistance(w.bearing, courtyardBearingDeg) <= P.courtyardTolDeg);
  const courtyardPoint = courtyardWalls.length > 0 ? pushedPoint(courtyardWalls, origin, P.outwardPushM, unproj) : null;

  const c = P.confidence;
  const floorAboveLevels = input.floor !== null && own.levels !== null && input.floor > own.levels;
  const confidence = roundTo(
    clamp01(
      (found.inside ? 1 : c.snapped) *
        (c.shareBase + c.shareWeight * share) *
        (streetDist <= c.nearStreetM ? 1 : c.farStreet) *
        (frontage >= c.frontageMinM ? 1 : c.shortFrontage) *
        (floorAboveLevels ? c.floorAboveLevels : 1),
    ),
    P.decimals.confidence,
  );

  return {
    status: "ok",
    osmId: own.id,
    inside: found.inside,
    snapM: found.snapM,
    streetBearingDeg,
    streetFacade: bearingToFacade(streetBearingDeg),
    courtyardBearingDeg,
    courtyardFacade: bearingToFacade(courtyardBearingDeg),
    confidence,
    frontageM: frontage,
    streetDistM: streetDist,
    ambiguous,
    floorAboveLevels,
    streetPoint,
    courtyardPoint,
  };
}

/** The point on the nearest of `walls` to `from`, pushed `push` metres along that wall's normal, as stored lat/lng. */
function pushedPoint(
  walls: readonly Wall[],
  from: XY,
  push: number,
  unproj: (x: number, y: number) => [number, number],
): { lat: number; lng: number } {
  let best = { ...closestOnSegment(from, walls[0].a, walls[0].b), normal: walls[0].normal };
  for (const w of walls.slice(1)) {
    const hit = closestOnSegment(from, w.a, w.b);
    if (hit.d < best.d) best = { ...hit, normal: w.normal };
  }
  const [lng, lat] = unproj(best.c[0] + best.normal[0] * push, best.c[1] + best.normal[1] * push);
  return { lat: roundTo(lat, SUN_FACADE_PARAMS.decimals.point), lng: roundTo(lng, SUN_FACADE_PARAMS.decimals.point) };
}
