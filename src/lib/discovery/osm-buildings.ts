/**
 * osm-buildings.ts - the OpenStreetMap extract file (Phase 14.3, SUN-01): its
 * schema, the parser and the building / road index the sun modules read.
 *
 * PURE, synchronous - no file or environment access, no network, no clock, no
 * randomness. The caller reads the JSON file and hands the parsed value to
 * `parseOsmExtract`; the same extract always gives the same index.
 *
 * LICENCE (ODbL, R-07): the data is (c) OpenStreetMap contributors. Every
 * extract file carries an `attribution` field and the schema refuses a file
 * that does not mention "OpenStreetMap contributors", so a copy of the data
 * cannot lose the line. The downloaded cache stays under the gitignored
 * `.planning/calibration/data/`; only the trimmed test fixture is committed.
 *
 * STRUCTURAL SEPARATION (LOCKED): `niche-score.ts` and `report/flags.ts` must
 * NEVER import this module. The static-grep invariant in `niche-score.test.ts`
 * enforces that; the `discovery/osm-` prefix is registered there.
 *
 * Coordinates: OSM geometry is { lat, lon }; this module stores rings as
 * [lng, lat] pairs (the GeoJSON order) and converts to local metres only
 * through `projectFrom`.
 */

import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point, polygon } from "@turf/helpers";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Extract file (the contract plan 02 writes the real cache in)
// ---------------------------------------------------------------------------

/** The attribution value written everywhere the data is stored. */
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors, ODbL 1.0, https://www.openstreetmap.org/copyright";

/** A geometry point cap per way and a member cap per relation (T-14.3-01). */
export const OSM_MAX_POINTS_PER_WAY = 10_000;
export const OSM_MAX_MEMBERS_PER_RELATION = 5_000;

const latSchema = z.number().min(-90).max(90);
const lonSchema = z.number().min(-180).max(180);
const pointSchema = z.object({ lat: latSchema, lon: lonSchema });
const geometrySchema = z.array(pointSchema).max(OSM_MAX_POINTS_PER_WAY);
const tagsSchema = z.record(z.string(), z.string()).default({});

const waySchema = z.object({
  type: z.literal("way"),
  id: z.number().int(),
  tags: tagsSchema,
  geometry: geometrySchema.default([]),
});

const memberSchema = z.object({
  type: z.string(),
  ref: z.number().int(),
  role: z.string(),
  geometry: geometrySchema.optional(),
});

const relationSchema = z.object({
  type: z.literal("relation"),
  id: z.number().int(),
  tags: tagsSchema,
  members: z.array(memberSchema).max(OSM_MAX_MEMBERS_PER_RELATION).default([]),
});

export const osmExtractSchema = z.object({
  version: z.literal(1),
  attribution: z
    .string()
    .refine((s) => s.includes("OpenStreetMap contributors"), 'attribution must mention "OpenStreetMap contributors" (ODbL)'),
  /** ISO-8601 UTC timestamp of the download. */
  fetchedAt: z.iso.datetime(),
  /** Overpass `osm3s.timestamp_osm_base`. */
  osmBase: z.iso.datetime(),
  bbox: z.object({ south: latSchema, west: lonSchema, north: latSchema, east: lonSchema }),
  /** `way["building"](bbox);out geom tags;` */
  buildings: z.array(waySchema),
  /** `relation["building"](bbox);out geom;` */
  relations: z.array(relationSchema),
  /** `way["highway"]["name"](bbox);out geom tags;` */
  roads: z.array(waySchema),
  source: z.string().optional(),
});

export type OsmExtract = z.infer<typeof osmExtractSchema>;

/** Parses an untrusted extract value, or throws one readable Error (no partial index). */
export function parseOsmExtract(raw: unknown): OsmExtract {
  const result = osmExtractSchema.safeParse(raw);
  if (result.success) return result.data;
  const issues = result.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
  throw new Error(`Invalid OSM extract: ${issues}`);
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * SUN-01 encoding: two street names are equal when their normalized forms are
 * equal - Unicode NFD, combining marks U+0300-U+036F removed, lower-cased with
 * the sv-SE locale, runs of whitespace collapsed to one space, trimmed. No
 * prefix, suffix or fuzzy matching ("gatan" is never stripped).
 */
export function normalizeStreetName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("sv-SE")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** A ring of [lng, lat] pairs, first point equal to the last. */
export type Ring = Array<[number, number]>;

/**
 * Metres per degree of latitude and of longitude at `latDeg`, WGS84 (the standard series for the length of a
 * degree on the ellipsoid, as in the NGA / Wikipedia "Geographic coordinate system" tables). At Stockholm
 * (59,33 N) that is about 111 402 m and 56 944 m. The old constants (110 574 for latitude, which is the
 * equatorial value, and the spherical 111 320 x cos(lat) for longitude) scaled the two axes differently: 300 m
 * due north came out as 297,8 m (14.3 review WR-02).
 */
export function metresPerDegree(latDeg: number): { lat: number; lng: number } {
  const phi = (latDeg * Math.PI) / 180;
  return {
    lat: 111_132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi) - 0.0023 * Math.cos(6 * phi),
    lng: 111_412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi),
  };
}

/**
 * Equirectangular projection around (lat0, lng0): (lng, lat) -> [x east, y north] in metres, with both axes
 * scaled at lat0. Within about 0,1 m over 300 m at Stockholm's latitude (RESEARCH "Local projection and bearing").
 */
export function projectFrom(lat0: number, lng0: number): (lng: number, lat: number) => [number, number] {
  const m = metresPerDegree(lat0);
  return (lng, lat) => [(lng - lng0) * m.lng, (lat - lat0) * m.lat];
}

/** The inverse of {@link projectFrom}: [x east, y north] in metres -> [lng, lat]. */
export function unprojectFrom(lat0: number, lng0: number): (x: number, y: number) => [number, number] {
  const m = metresPerDegree(lat0);
  return (x, y) => [lng0 + x / m.lng, lat0 + y / m.lat];
}

/**
 * Storeys above ground from `building:levels`: the first number, with a comma
 * or a dot as decimal separator ("5,5" is 5.5, "5;6" is 5). Null when absent
 * or not a number.
 */
export function levelsOf(tags: Readonly<Record<string, string>>): number | null {
  const raw = tags["building:levels"];
  if (raw === undefined) return null;
  const m = /^\s*(\d+(?:[.,]\d+)?)/.exec(raw);
  if (m === null) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Absolute area of a ring in square metres (shoelace, local projection at its first vertex). */
function ringAreaM2(ring: Ring): number {
  const proj = projectFrom(ring[0][1], ring[0][0]);
  const xy = ring.map(([lng, lat]) => proj(lng, lat));
  let sum = 0;
  for (let i = 0; i < xy.length - 1; i++) sum += xy[i][0] * xy[i + 1][1] - xy[i + 1][0] * xy[i][1];
  return Math.abs(sum) / 2;
}

function bboxOfRing(ring: Ring): [number, number, number, number] {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLng, minLat, maxLng, maxLat];
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export interface OsmBuilding {
  /** "way/<id>" or "relation/<id>". */
  readonly id: string;
  readonly outer: Ring;
  /** Courtyard holes: a point inside one is outside the building. */
  readonly inners: Ring[];
  readonly tags: Readonly<Record<string, string>>;
  /** `building:levels`, null when absent or not a number. */
  readonly levels: number | null;
  /** Area of the outer ring, square metres. */
  readonly areaM2: number;
  /** [minLng, minLat, maxLng, maxLat] of the outer ring. */
  readonly bbox: readonly [number, number, number, number];
}

export interface OsmRoad {
  readonly id: string;
  readonly name: string;
  readonly normalizedName: string;
  readonly points: Ring;
}

export interface OsmIndex {
  readonly buildings: readonly OsmBuilding[];
  readonly roads: readonly OsmRoad[];
  /** Roads grouped by normalized name. */
  readonly roadsByName: ReadonlyMap<string, readonly OsmRoad[]>;
  readonly bbox: OsmExtract["bbox"];
  readonly attribution: string;
  readonly skipped: { invalidWays: number; relationsWithoutOuter: number };
}

const toRing = (geometry: ReadonlyArray<{ lat: number; lon: number }>): Ring => geometry.map((p) => [p.lon, p.lat]);

function isClosed(ring: Ring): boolean {
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

function makeBuilding(id: string, outer: Ring, inners: Ring[], tags: Readonly<Record<string, string>>): OsmBuilding {
  return { id, outer, inners, tags, levels: levelsOf(tags), areaM2: ringAreaM2(outer), bbox: bboxOfRing(outer) };
}

/** Joins per decimals-7 endpoint equality; a stitched ring is capped at this many joins. */
const MAX_STITCH_JOINS = 500;
const MIN_RING_POINTS = 4;

const pointKey = (p: readonly [number, number]): string => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;

/**
 * Joins member fragments into closed rings (RESEARCH Pitfall 2): a fragment is
 * appended when its start equals the ring's end at 7 decimals, reversed when
 * its END matches. Fragments that never close, and rings under 4 points, are
 * dropped. The returned rings end exactly on their first point.
 */
function stitchRings(fragments: readonly Ring[]): Ring[] {
  const pool = fragments.filter((f) => f.length >= 2).map((f) => f.slice());
  const rings: Ring[] = [];
  while (pool.length > 0) {
    let current = pool.shift() as Ring;
    let joins = 0;
    while (pointKey(current[0]) !== pointKey(current[current.length - 1]) && joins++ < MAX_STITCH_JOINS) {
      const end = pointKey(current[current.length - 1]);
      let at = pool.findIndex((f) => pointKey(f[0]) === end);
      let reverse = false;
      if (at < 0) {
        at = pool.findIndex((f) => pointKey(f[f.length - 1]) === end);
        reverse = true;
      }
      if (at < 0) break;
      let next = pool.splice(at, 1)[0];
      if (reverse) next = next.slice().reverse();
      current = current.concat(next.slice(1));
    }
    if (current.length >= MIN_RING_POINTS && pointKey(current[0]) === pointKey(current[current.length - 1])) {
      current[current.length - 1] = current[0];
      rings.push(current);
    }
  }
  return rings;
}

function ringContains(ring: Ring, p: readonly [number, number]): boolean {
  return booleanPointInPolygon(point([p[0], p[1]]), polygon([ring]));
}

/** Builds the building and road index from a parsed extract. */
export function buildOsmIndex(extract: OsmExtract): OsmIndex {
  const skipped = { invalidWays: 0, relationsWithoutOuter: 0 };
  const buildings: OsmBuilding[] = [];
  for (const way of extract.buildings) {
    const ring = toRing(way.geometry);
    if (ring.length < 4 || !isClosed(ring)) {
      skipped.invalidWays += 1;
      continue;
    }
    buildings.push(makeBuilding(`way/${way.id}`, ring, [], way.tags));
  }

  // Courtyard buildings: one entry per closed outer ring, holes attached to the outer that contains them.
  for (const rel of extract.relations) {
    const fragments = (role: string): Ring[] =>
      rel.members.filter((m) => m.role === role && m.geometry !== undefined).map((m) => toRing(m.geometry ?? []));
    const outers = stitchRings(fragments("outer"));
    if (outers.length === 0) {
      skipped.relationsWithoutOuter += 1;
      continue;
    }
    const holes: Ring[][] = outers.map(() => []);
    for (const inner of stitchRings(fragments("inner"))) {
      const owner = outers.findIndex((outer) => ringContains(outer, inner[0]));
      if (owner >= 0) holes[owner].push(inner);
    }
    outers.forEach((outer, k) => {
      buildings.push(makeBuilding(k === 0 ? `relation/${rel.id}` : `relation/${rel.id}#${k + 1}`, outer, holes[k], rel.tags));
    });
  }

  const roads: OsmRoad[] = [];
  const roadsByName = new Map<string, OsmRoad[]>();
  for (const way of extract.roads) {
    const name = way.tags.name;
    if (name === undefined || way.geometry.length < 2) continue;
    const road: OsmRoad = { id: `way/${way.id}`, name, normalizedName: normalizeStreetName(name), points: toRing(way.geometry) };
    roads.push(road);
    const list = roadsByName.get(road.normalizedName);
    if (list === undefined) roadsByName.set(road.normalizedName, [road]);
    else list.push(road);
  }

  return { buildings, roads, roadsByName, bbox: extract.bbox, attribution: extract.attribution, skipped };
}

/** True when (lng, lat) lies in the building's solid part: inside the outer ring and in no courtyard hole. */
export function pointInBuilding(building: OsmBuilding, lng: number, lat: number): boolean {
  const [minLng, minLat, maxLng, maxLat] = building.bbox;
  if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) return false;
  return booleanPointInPolygon(point([lng, lat]), polygon([building.outer, ...building.inners]));
}

// ---------------------------------------------------------------------------
// Heights and walls (Phase 14.3, SUN-03)
// ---------------------------------------------------------------------------

/**
 * Tunable numbers of the height model, in one table (functions own no constants).
 *
 * D-06 / R-04: a `height` tag is used as it is; else `building:levels` x 3 m +
 * 2 m; else a small building type gets 3 m; else the median of the tag-derived
 * heights of ordinary buildings whose centre lies within 150 m; else the
 * innerstan median of 5 storeys (17 m). Every height that does not come from a
 * tag is marked `estimated`, which prints as "höjd uppskattad".
 *
 * SANITY RULE (14.3 review CR-01): a `height` tag is used as it is UNLESS it is
 * implausible, because one bad import (Ringen centrum, way/715073073: 151,7 m on
 * a six-storey mall) put a 150 m wall next to Skanstull and moved the shade
 * hours of every flat in reach. A tag is "orimlig" when it is more than
 * `suspectFactor` (2,5) times the largest of the storey formula, the local
 * median and the innerstan typical height (17 m; without that floor a low-rise
 * pocket with a 5,75 m median made Vasamuseet's 41 m and the palace's 39 m
 * look absurd), or more than `suspectAbsM` (60 m) on a building of at most
 * `suspectAbsMaxLevels` (8) storeys. An orimlig tag is replaced by the storey
 * formula (else the local median), marked `estimated` AND `suspect`, and
 * counted by {@link suspectHeights}. Genuinely tall landmarks are exempt:
 * churches, towers and chimneys by tag (`trustedBuildingTypes`,
 * `trustedManMade`) and a few named ways by OSM id (`trustedTallIds`).
 *
 * The research prototype also added 1,5 m per `roof:levels`. That term is
 * left out on purpose: the locked formula is levels x 3 + 2, and the +-3 m
 * envelope the hours engine applies to every neighbour already covers an attic
 * storey. A reader should therefore expect 6 storeys + 1 roof level = 20 m.
 *
 * HOW OFTEN THE ESTIMATE IS USED (RESEARCH, measured on the 78-flat snapshot):
 * 73,8 % of innerstan buildings carry a height or storey tag - 86 % around
 * Södermalm flats, 78 % Vasastan, 59,5 % Kungsholmen. The remaining quarter
 * (more than 40 % on Kungsholmen) gets the local median, whose leave-one-out
 * error is 3 m (median), 4,5 m (p75) and 9 m (p90).
 */
export const HEIGHT_PARAMS = {
  storeyM: 3,
  baseM: 2,
  smallTypes: ["shed", "garage", "garages", "hut", "kiosk", "carport", "roof", "allotment_house", "greenhouse"] as readonly string[],
  smallM: 3,
  neighbourRadiusM: 150,
  fallbackLevels: 5,
  gridCellM: 150,
  wallMarginM: 50,
  /** A height tag above this many times max(storey formula, local median, innerstan typical height) is orimlig. */
  suspectFactor: 2.5,
  /** ... and so is any tag above this many metres on a building of at most `suspectAbsMaxLevels` storeys. */
  suspectAbsM: 60,
  suspectAbsMaxLevels: 8,
  /** Tall by nature: a church spire or a chimney is not a data error. `building=` values. */
  trustedBuildingTypes: ["church", "cathedral", "chapel", "mosque", "synagogue", "temple", "tower", "chimney"] as readonly string[],
  /** ... and `man_made=` values. */
  trustedManMade: ["tower", "chimney", "mast", "lighthouse", "water_tower", "silo", "communications_tower"] as readonly string[],
  /**
   * Named tall landmarks that are neither a church nor a tower by tag, checked by hand against the
   * innerstan extract (2026-10-13): the Gröna Lund rides Fritt fall (80 m) and Katapulten (55 m), and
   * the 121 m industrial "torn". Add an id here when `suspectHeights` lists a real landmark.
   */
  trustedTallIds: ["way/1122922291", "way/1122927971", "way/877287650"] as readonly string[],
} as const;

/** A building's height in metres and whether it is our estimate rather than a tag. */
export interface BuildingHeight {
  readonly heightM: number;
  readonly estimated: boolean;
  /** Present (true) only when the building carries a height tag we rejected as orimlig; `heightM` is then our estimate. */
  readonly suspect?: true;
}

/** A wall segment in metres east/north of a point, with the height of its building. */
export interface OsmWall {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly heightM: number;
  readonly estimated: boolean;
}

/** The first number of a tag value, comma or dot as decimal separator ("21 m", "5,5", "21;24"). */
function firstNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const m = /^\s*(\d+(?:[.,]\d+)?)/.exec(raw);
  if (m === null) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

const isSmallType = (tags: Readonly<Record<string, string>>): boolean =>
  tags.building !== undefined && HEIGHT_PARAMS.smallTypes.includes(tags.building);

/**
 * The height a building's own tags give, or null when only its neighbourhood
 * can tell. Order: `height` (a positive number, used as it is) -> `building:levels`
 * x 3 + 2 -> a small type's 3 m (estimated).
 */
export function heightOf(tags: Readonly<Record<string, string>>): BuildingHeight | null {
  const tagged = firstNumber(tags.height);
  if (tagged !== null && tagged > 0) return { heightM: tagged, estimated: false };
  const levels = levelsOf(tags);
  if (levels !== null) return { heightM: levels * HEIGHT_PARAMS.storeyM + HEIGHT_PARAMS.baseM, estimated: false };
  if (isSmallType(tags)) return { heightM: HEIGHT_PARAMS.smallM, estimated: true };
  return null;
}

/** The tag value of `height` when it is a positive number, else null. */
function taggedHeightOf(tags: Readonly<Record<string, string>>): number | null {
  const tagged = firstNumber(tags.height);
  return tagged !== null && tagged > 0 ? tagged : null;
}

const baseIdOf = (id: string): string => id.replace(/#\d+$/, "");

/** Tall by nature (church, tower, chimney) or a hand-checked landmark: its height tag is believed whatever its size. */
function isTrustedTall(id: string, tags: Readonly<Record<string, string>>): boolean {
  const P = HEIGHT_PARAMS;
  return (
    P.trustedTallIds.includes(baseIdOf(id)) ||
    (tags.building !== undefined && P.trustedBuildingTypes.includes(tags.building)) ||
    (tags.man_made !== undefined && P.trustedManMade.includes(tags.man_made))
  );
}

/** The storey-formula height of a building, or null without a storey count. */
const heightFromLevels = (levels: number | null): number | null =>
  levels === null ? null : levels * HEIGHT_PARAMS.storeyM + HEIGHT_PARAMS.baseM;

/** Is this height tag orimlig next to `reference` (the largest of the storey formula, the local median and the innerstan typical height)? */
function isOrimlig(tagged: number, levels: number | null, reference: number): boolean {
  const P = HEIGHT_PARAMS;
  if (tagged > P.suspectFactor * reference) return true;
  return levels !== null && levels <= P.suspectAbsMaxLevels && tagged > P.suspectAbsM;
}

/** Innerstan's typical height (5 storeys), the stand-in for the local median where no neighbourhood is known yet. */
const FALLBACK_HEIGHT_M = HEIGHT_PARAMS.fallbackLevels * HEIGHT_PARAMS.storeyM + HEIGHT_PARAMS.baseM;

/**
 * The height a building contributes to a NEIGHBOUR's median: its own tags, with an orimlig height tag
 * judged against the storey formula and the innerstan typical height (no neighbourhood needed), so one
 * bad tag cannot pull a median. A rejected tag with a storey count gives the storey formula; without
 * one the building contributes nothing.
 */
function neighbourContribution(id: string, tags: Readonly<Record<string, string>>): number | null {
  if (isSmallType(tags)) return null;
  const own = heightOf(tags);
  const tagged = taggedHeightOf(tags);
  if (own === null || tagged === null || isTrustedTall(id, tags)) return own?.heightM ?? null;
  const levels = levelsOf(tags);
  if (!isOrimlig(tagged, levels, Math.max(heightFromLevels(levels) ?? 0, FALLBACK_HEIGHT_M))) return own.heightM;
  return heightFromLevels(levels);
}

interface GeometryContext {
  /** Projection around the extract's bounding-box centre; only used to find neighbours. */
  readonly proj: (lng: number, lat: number) => [number, number];
  readonly centroids: ReadonlyArray<readonly [number, number]>;
  /** Projected outer-ring vertices of each building, [x0, y0, x1, y1, ...]. */
  readonly outerXY: readonly Float64Array[];
  /** Tag-derived height of an ordinary (not small) building, else null: what a neighbour contributes to a median. */
  readonly neighbourHeight: ReadonlyArray<number | null>;
  /** Grid cell -> positions of the buildings whose bounding box touches the cell. */
  readonly cells: ReadonlyMap<number, readonly number[]>;
  /** Position of each building object in `index.buildings` (O(1) instead of a scan per lookup). */
  readonly position: ReadonlyMap<OsmBuilding, number>;
  readonly memo: Map<string, BuildingHeight>;
}

const contexts = new WeakMap<OsmIndex, GeometryContext>();

const cellKey = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);

function geometryContextOf(index: OsmIndex): GeometryContext {
  const cached = contexts.get(index);
  if (cached !== undefined) return cached;
  const proj = projectFrom((index.bbox.south + index.bbox.north) / 2, (index.bbox.west + index.bbox.east) / 2);
  const cell = HEIGHT_PARAMS.gridCellM;
  const centroids: Array<readonly [number, number]> = [];
  const outerXY: Float64Array[] = [];
  const neighbourHeight: Array<number | null> = [];
  const cells = new Map<number, number[]>();
  const position = new Map<OsmBuilding, number>();
  index.buildings.forEach((b, i) => {
    position.set(b, i);
    const xy = new Float64Array(b.outer.length * 2);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let sx = 0;
    let sy = 0;
    b.outer.forEach(([lng, lat], k) => {
      const [x, y] = proj(lng, lat);
      xy[2 * k] = x;
      xy[2 * k + 1] = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (k < b.outer.length - 1) {
        sx += x;
        sy += y;
      }
    });
    const distinct = Math.max(1, b.outer.length - 1);
    centroids.push([sx / distinct, sy / distinct]);
    outerXY.push(xy);
    neighbourHeight.push(neighbourContribution(b.id, b.tags));
    for (let cx = Math.floor(minX / cell); cx <= Math.floor(maxX / cell); cx++) {
      for (let cy = Math.floor(minY / cell); cy <= Math.floor(maxY / cell); cy++) {
        const key = cellKey(cx, cy);
        const list = cells.get(key);
        if (list === undefined) cells.set(key, [i]);
        else list.push(i);
      }
    }
  });
  const ctx: GeometryContext = { proj, centroids, outerXY, neighbourHeight, cells, position, memo: new Map() };
  contexts.set(index, ctx);
  return ctx;
}

/** Median of a non-empty list; an even count averages the two middle values. */
function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The median of the neighbour contributions of ordinary buildings whose centre is within 150 m of
 * (cx0, cy0) (inclusive, compared at one decimal so 150,0 m counts and 150,1 m does not), `skip`
 * (the building itself) left out; null when none is in reach. Neighbours come from a 150 m grid
 * (3 x 3 cells), never an all-pairs scan.
 */
function localMedian(ctx: GeometryContext, cx0: number, cy0: number, skip: number | undefined): number | null {
  const cell = HEIGHT_PARAMS.gridCellM;
  const seen = new Set<number>();
  const values: number[] = [];
  for (let cx = Math.floor(cx0 / cell) - 1; cx <= Math.floor(cx0 / cell) + 1; cx++) {
    for (let cy = Math.floor(cy0 / cell) - 1; cy <= Math.floor(cy0 / cell) + 1; cy++) {
      for (const j of ctx.cells.get(cellKey(cx, cy)) ?? []) {
        if (seen.has(j)) continue;
        seen.add(j);
        if (j === skip) continue;
        const h = ctx.neighbourHeight[j];
        if (h === null) continue;
        const [x, y] = ctx.centroids[j];
        if (Math.round(Math.hypot(x - cx0, y - cy0) * 10) <= HEIGHT_PARAMS.neighbourRadiusM * 10) values.push(h);
      }
    }
  }
  return values.length > 0 ? median(values) : null;
}

/**
 * The height of a building, resolved lazily and memoised per building id: its
 * own tags first, else the median of the tag-derived heights of ordinary
 * buildings whose centre is within 150 m, else 5 storeys = 17 m. The result
 * does not depend on the order of `index.buildings`.
 *
 * A `height` tag that is orimlig (see HEIGHT_PARAMS: more than 2,5 times the
 * larger of the storey formula and the local median, or over 60 m on at most 8
 * storeys, and not a church, tower or listed landmark) is NOT used: the height
 * becomes the storey formula, else the local median, marked `estimated` and
 * `suspect`.
 */
export function buildingHeight(index: OsmIndex, building: OsmBuilding): BuildingHeight {
  const ctx = geometryContextOf(index);
  const memoised = ctx.memo.get(building.id);
  if (memoised !== undefined) return memoised;

  const at = ctx.position.get(building);
  const centre = (): [number, number] => (at !== undefined ? [ctx.centroids[at][0], ctx.centroids[at][1]] : centroidOf(building, ctx.proj));
  let result: BuildingHeight;
  const own = heightOf(building.tags);
  const tagged = taggedHeightOf(building.tags);
  if (own !== null && tagged !== null && !isTrustedTall(building.id, building.tags)) {
    const levels = levelsOf(building.tags);
    const fromLevels = heightFromLevels(levels);
    // The local median only matters when the tag is big enough to be orimlig against the storey formula alone.
    const [cx0, cy0] = centre();
    const reference =
      tagged > HEIGHT_PARAMS.suspectFactor * Math.max(fromLevels ?? 0, FALLBACK_HEIGHT_M)
        ? Math.max(fromLevels ?? 0, localMedian(ctx, cx0, cy0, at) ?? 0, FALLBACK_HEIGHT_M)
        : Infinity;
    if (isOrimlig(tagged, levels, reference)) {
      result = { heightM: fromLevels ?? localMedian(ctx, cx0, cy0, at) ?? FALLBACK_HEIGHT_M, estimated: true, suspect: true };
    } else {
      result = own;
    }
  } else if (own !== null) {
    result = own;
  } else {
    const [cx0, cy0] = centre();
    result = { heightM: localMedian(ctx, cx0, cy0, at) ?? FALLBACK_HEIGHT_M, estimated: true };
  }
  ctx.memo.set(building.id, result);
  return result;
}

/**
 * The buildings whose `height` tag was rejected as orimlig, as { id, taggedM, usedM }, in index order.
 * Only buildings that carry a height tag can be listed, so the scan is cheap. The weekly run prints the
 * count next to the cache line so a bad import is visible, and the ids tell what to check by hand.
 */
export function suspectHeights(index: OsmIndex): Array<{ id: string; taggedM: number; usedM: number }> {
  const found: Array<{ id: string; taggedM: number; usedM: number }> = [];
  for (const b of index.buildings) {
    const tagged = taggedHeightOf(b.tags);
    if (tagged === null) continue;
    const h = buildingHeight(index, b);
    if (h.suspect === true) found.push({ id: b.id, taggedM: tagged, usedM: h.heightM });
  }
  return found;
}

function centroidOf(building: OsmBuilding, proj: (lng: number, lat: number) => [number, number]): [number, number] {
  const pts = building.outer.slice(0, Math.max(1, building.outer.length - 1)).map(([lng, lat]) => proj(lng, lat));
  return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
}

/**
 * Every edge of the outer AND inner (courtyard) rings of each building that has
 * a vertex within `radiusM` + the wall margin (50 m) of (lat, lng), in metres
 * east/north of that point, each with its building's height and estimated flag.
 * The buildings come from a 150 m grid over their bounding boxes, so a long
 * building whose centre is far away is still found. Order: buildings in the
 * index's order, rings outer first.
 */
export function wallsNear(index: OsmIndex, lat: number, lng: number, radiusM: number): OsmWall[] {
  const ctx = geometryContextOf(index);
  const reach = radiusM + HEIGHT_PARAMS.wallMarginM;
  const cell = HEIGHT_PARAMS.gridCellM;
  const [qx, qy] = ctx.proj(lng, lat);
  const hits = new Set<number>();
  for (let cx = Math.floor((qx - reach) / cell); cx <= Math.floor((qx + reach) / cell); cx++) {
    for (let cy = Math.floor((qy - reach) / cell); cy <= Math.floor((qy + reach) / cell); cy++) {
      for (const i of ctx.cells.get(cellKey(cx, cy)) ?? []) {
        if (hits.has(i)) continue;
        const xy = ctx.outerXY[i];
        for (let k = 0; k < xy.length; k += 2) {
          if (Math.hypot(xy[k] - qx, xy[k + 1] - qy) <= reach) {
            hits.add(i);
            break;
          }
        }
      }
    }
  }
  const proj = projectFrom(lat, lng);
  const walls: OsmWall[] = [];
  for (const i of [...hits].sort((a, b) => a - b)) {
    const building = index.buildings[i];
    const { heightM, estimated } = buildingHeight(index, building);
    for (const ring of [building.outer, ...building.inners]) {
      for (let k = 0; k < ring.length - 1; k++) {
        const [x1, y1] = proj(ring[k][0], ring[k][1]);
        const [x2, y2] = proj(ring[k + 1][0], ring[k + 1][1]);
        if (x1 === x2 && y1 === y2) continue;
        walls.push({ x1, y1, x2, y2, heightM, estimated });
      }
    }
  }
  return walls;
}
