/**
 * osm-cache.ts - the local cache of the innerstan OpenStreetMap extract
 * (Phase 14.3, SUN-01 data, SUN-05 refresh rule, R-05).
 *
 * Script-side only (node:fs, through json-store.ts). The weekly run reads this
 * file and never calls Overpass while the file is younger than 31 days; this
 * module owns that rule. The download itself is injected (`download`), so the
 * rule is tested without a network.
 *
 * THE RULE (boundary inclusive): a refresh is needed when the file is missing,
 * unreadable (that includes a file whose metadata is fine but whose geometry
 * `parseOsmExtract` refuses or that holds no building: it would otherwise stay
 * "fresh" for 31 days while every flat reads okänd, 14.3 review WR-05),
 * its `fetchedAt` does not parse, `fetchedAt` lies more than one
 * day in the future (a clock or a typing error), or the file is 31 days old or
 * older. 30 days 23 h 59 min is fresh; exactly 31 days is not.
 *
 * FAILURE KEEPS WHAT WORKS: the new file is written to a temp file in the same
 * directory and renamed, only after the whole download succeeded. A failed
 * download leaves the previous file byte-identical, and two downloads at once
 * each rename a complete file, so a reader never sees a partial one.
 *
 * The file is about 20 MB, so it is written compact (pretty JSON would roughly
 * double it). It lives under the gitignored `.planning/calibration/data/` and is
 * never committed (ODbL, T-14.3-07).
 *
 * `niche-score.ts` and `report/flags.ts` must NEVER import this module.
 */
import { z } from "zod/v4";
import { guardedDataPath, readJsonIfExists, writeTextAtomic } from "@/lib/discovery/json-store";
import { OSM_ATTRIBUTION, parseOsmExtract } from "@/lib/discovery/osm-buildings";
import type { OsmExtract } from "@/lib/discovery/osm-buildings";

/** The one directory the cache may be written to (gitignored with the rest of the data directory). */
export const OSM_CACHE_DIR = ".planning/calibration/data/osm";
export const OSM_CACHE_PATH = ".planning/calibration/data/osm/innerstan.json";
/** SUN-05: the cache is refreshed when it is this many days old or older. */
export const OSM_REFRESH_DAYS = 31;
/** ODbL attribution written into every file (one definition, in osm-buildings.ts). */
export { OSM_ATTRIBUTION };

const DAY_MS = 86_400_000;
/** A `fetchedAt` further ahead of the clock than this is treated as wrong. */
const FUTURE_TOLERANCE_MS = DAY_MS;

export interface OsmCacheMeta {
  fetchedAt: string;
  osmBase: string;
  /** Set by the research import (`research download 2026-10-13`); absent for a live download. */
  source: string | null;
  counts: { buildings: number; relations: number; roads: number };
}

/**
 * True when the cache must be downloaded again. `meta` is null for a missing or
 * unreadable file. Pure: the clock is a parameter.
 */
export function osmCacheNeedsRefresh(meta: { fetchedAt: string } | null, now: Date): boolean {
  if (meta === null) return true;
  const fetched = Date.parse(meta.fetchedAt);
  if (Number.isNaN(fetched)) return true;
  const age = now.getTime() - fetched;
  if (age < -FUTURE_TOLERANCE_MS) return true;
  return age >= OSM_REFRESH_DAYS * DAY_MS;
}

/** Reads only what the refresh decision needs; the full geometry is validated by `parseOsmExtract` in the consumer. */
const metaSchema = z.object({
  version: z.literal(1),
  attribution: z.string(),
  fetchedAt: z.string(),
  osmBase: z.string(),
  source: z.string().optional(),
  buildings: z.array(z.unknown()),
  relations: z.array(z.unknown()),
  roads: z.array(z.unknown()),
});

export type OsmCacheLoadError = "saknas" | "ogiltig JSON" | "fel format" | "oläsbar";

/**
 * Reads the cache file. Never throws and never renames or deletes the file (a
 * refresh overwrites it): a bad file comes back as an error word the caller
 * prints, so the weekly run fails closed to "okänd" out loud.
 *
 * Valid metadata is not enough: the geometry must parse with `parseOsmExtract` and hold at least one building,
 * else the file is "oläsbar" (treated as missing, so the refresh rule downloads it again).
 */
export function loadOsmCacheRaw(path: string): { raw: unknown; meta: OsmCacheMeta } | { error: OsmCacheLoadError } {
  let raw: unknown;
  try {
    raw = readJsonIfExists(path);
  } catch (error) {
    return { error: error instanceof SyntaxError ? "ogiltig JSON" : "oläsbar" };
  }
  if (raw === null) return { error: "saknas" };
  const parsed = metaSchema.safeParse(raw);
  if (!parsed.success) return { error: "fel format" };
  const f = parsed.data;
  let usable = false;
  try {
    usable = parseOsmExtract(raw).buildings.length >= 1;
  } catch {
    usable = false;
  }
  if (!usable) return { error: "oläsbar" };
  return {
    raw,
    meta: {
      fetchedAt: f.fetchedAt,
      osmBase: f.osmBase,
      source: f.source ?? null,
      counts: { buildings: f.buildings.length, relations: f.relations.length, roads: f.roads.length },
    },
  };
}

/**
 * The fixed okänd reason a flat gets when the cache cannot be used, from the failure text the run prints
 * ("saknas (filen finns inte)", "saknas (oläsbar)", "ogiltig (<first issue>)"). Three fixed labels, so the sun report
 * groups them; the printed failure keeps the detail.
 */
export function osmCacheUnknownReason(failure: string): "OSM-cache saknas" | "OSM-cache ogiltig" | "OSM-cache oläsbar" {
  if (failure.includes("oläsbar")) return "OSM-cache oläsbar";
  if (failure.startsWith("ogiltig")) return "OSM-cache ogiltig";
  return "OSM-cache saknas";
}

/** The failure text of {@link loadOsmCacheRaw}'s error word, as the weekly run prints it. */
export function osmCacheFailureText(error: OsmCacheLoadError): string {
  return error === "saknas" ? "saknas (filen finns inte)" : error === "oläsbar" ? "saknas (oläsbar)" : `ogiltig (${error})`;
}

/** The cache's meta, or null when the file is missing, unreadable or the wrong shape. Never throws. */
export function readOsmCacheMeta(path: string): OsmCacheMeta | null {
  const loaded = loadOsmCacheRaw(path);
  return "error" in loaded ? null : loaded.meta;
}

/**
 * Writes the cache: guarded to `.planning/calibration/data/osm/*.json`
 * (`opts.dir` exists for tests), compact JSON, temp file then rename. Throws a
 * Swedish message for a path outside the directory.
 */
export function saveOsmCache(path: string, file: OsmExtract, opts: { dir?: string } = {}): void {
  const dir = opts.dir ?? OSM_CACHE_DIR;
  const safe = guardedDataPath(path, { dir, ext: ".json" });
  if (safe === null) throw new Error(`OSM-cachen får bara skrivas under ${dir}/ som .json-fil (fick ${path})`);
  writeTextAtomic(safe, JSON.stringify(file));
}

export interface OsmCacheRefreshResult {
  action: "fresh" | "downloaded" | "failed-kept-old" | "failed-no-cache";
  /** Age of the cache in days after this call (0 or so for a download); null when there is no usable cache. */
  ageDays: number | null;
  /** The failure reason for the two failed actions. */
  reason?: string;
  /** Meta of the file that is on disk after this call; null when there is none. */
  meta: OsmCacheMeta | null;
}

const ageDaysOf = (meta: OsmCacheMeta | null, now: Date): number | null => {
  if (meta === null) return null;
  const fetched = Date.parse(meta.fetchedAt);
  if (Number.isNaN(fetched)) return null;
  return Math.max(0, (now.getTime() - fetched) / DAY_MS);
};

const fmtAge = (ageDays: number | null) => (ageDays === null ? "okänd" : ageDays.toFixed(1).replace(".", ","));

/**
 * The four pinned lines. Fresh: age with one decimal and a decimal comma and the
 * words "ingen hämtning (gräns 31 dagar)"; downloaded: fetchedAt, the three
 * counts and the OSM time; failed: the reason and what is used instead.
 */
export function renderOsmCacheLine(result: Omit<OsmCacheRefreshResult, "message">): string {
  switch (result.action) {
    case "fresh":
      return `OSM-cache: ${fmtAge(result.ageDays)} dagar gammal, ingen hämtning (gräns ${OSM_REFRESH_DAYS} dagar)`;
    case "downloaded": {
      const m = result.meta;
      const counts = m === null ? "" : `byggnader ${m.counts.buildings}, relationer ${m.counts.relations}, gator ${m.counts.roads}, OSM-tid ${m.osmBase}`;
      return `OSM-cache: hämtad ${m?.fetchedAt ?? "?"} (${counts})`;
    }
    case "failed-kept-old":
      return `OSM-cache: hämtning misslyckades (${result.reason ?? "okänd orsak"}), använder ${fmtAge(result.ageDays)} dagar gammal cache`;
    case "failed-no-cache":
      return `OSM-cache: hämtning misslyckades (${result.reason ?? "okänd orsak"}), ingen cache`;
  }
}

/**
 * The refresh decision. `download` is called only when `force` is set or the
 * age rule says so, and its result is saved only when it succeeded; a failure
 * leaves any existing file untouched. Never throws.
 */
export async function refreshOsmCacheIfStale(opts: {
  path: string;
  now: Date;
  force: boolean;
  download: () => Promise<OsmExtract>;
  /** Directory guard for the save; tests only. */
  dir?: string;
}): Promise<OsmCacheRefreshResult & { message: string }> {
  const { path, now } = opts;
  const finish = (r: OsmCacheRefreshResult) => ({ ...r, message: renderOsmCacheLine(r) });
  const before = readOsmCacheMeta(path);

  if (!opts.force && !osmCacheNeedsRefresh(before, now)) {
    return finish({ action: "fresh", ageDays: ageDaysOf(before, now), meta: before });
  }

  const failed = (reason: string) =>
    finish(
      before === null
        ? { action: "failed-no-cache", ageDays: null, reason, meta: null }
        : { action: "failed-kept-old", ageDays: ageDaysOf(before, now), reason, meta: before },
    );

  // A path the save would refuse is found out before 20 MB are downloaded for nothing.
  if (guardedDataPath(path, { dir: opts.dir ?? OSM_CACHE_DIR, ext: ".json" }) === null) {
    return failed(`OSM-cachen får bara skrivas under ${opts.dir ?? OSM_CACHE_DIR}/ som .json-fil (fick ${path})`);
  }

  try {
    const file = await opts.download();
    saveOsmCache(path, file, { dir: opts.dir });
    const after: OsmCacheMeta = {
      fetchedAt: file.fetchedAt,
      osmBase: file.osmBase,
      source: file.source ?? null,
      counts: { buildings: file.buildings.length, relations: file.relations.length, roads: file.roads.length },
    };
    return finish({ action: "downloaded", ageDays: ageDaysOf(after, now), meta: after });
  } catch (error) {
    return failed(error instanceof Error ? error.message : "okänt fel");
  }
}
