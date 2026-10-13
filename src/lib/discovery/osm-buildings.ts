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

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LNG_AT_EQUATOR = 111_320;

/**
 * Equirectangular projection around (lat0, lng0): (lng, lat) -> [x east, y
 * north] in metres. Good to a few centimetres over 300 m at Stockholm's
 * latitude (RESEARCH "Local projection and bearing").
 */
export function projectFrom(lat0: number, lng0: number): (lng: number, lat: number) => [number, number] {
  const mLng = M_PER_DEG_LNG_AT_EQUATOR * Math.cos((lat0 * Math.PI) / 180);
  return (lng, lat) => [(lng - lng0) * mLng, (lat - lat0) * M_PER_DEG_LAT];
}

/** The inverse of {@link projectFrom}: [x east, y north] in metres -> [lng, lat]. */
export function unprojectFrom(lat0: number, lng0: number): (x: number, y: number) => [number, number] {
  const mLng = M_PER_DEG_LNG_AT_EQUATOR * Math.cos((lat0 * Math.PI) / 180);
  return (x, y) => [lng0 + x / mLng, lat0 + y / M_PER_DEG_LAT];
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
