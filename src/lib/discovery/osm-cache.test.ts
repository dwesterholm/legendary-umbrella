import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OSM_ATTRIBUTION as OSM_BUILDINGS_ATTRIBUTION, parseOsmExtract, type OsmExtract } from "@/lib/discovery/osm-buildings";
import {
  OSM_ATTRIBUTION,
  OSM_CACHE_DIR,
  OSM_CACHE_PATH,
  OSM_REFRESH_DAYS,
  loadOsmCacheRaw,
  osmCacheFailureText,
  osmCacheNeedsRefresh,
  osmCacheUnknownReason,
  readOsmCacheMeta,
  refreshOsmCacheIfStale,
  renderOsmCacheLine,
  saveOsmCache,
} from "@/lib/discovery/osm-cache";

const DAY = 86_400_000;
const NOW = new Date("2026-11-20T12:00:00.000Z");
const iso = (msBeforeNow: number) => new Date(NOW.getTime() - msBeforeNow).toISOString();

function extractFile(overrides: Partial<OsmExtract> = {}): OsmExtract {
  const ring = [
    { lat: 59.3, lon: 18.0 },
    { lat: 59.3, lon: 18.001 },
    { lat: 59.301, lon: 18.001 },
    { lat: 59.3, lon: 18.0 },
  ];
  return {
    version: 1,
    attribution: OSM_ATTRIBUTION,
    fetchedAt: NOW.toISOString(),
    osmBase: "2026-11-20T11:40:00Z",
    bbox: { south: 59.295, west: 17.985, north: 59.355, east: 18.125 },
    buildings: [
      { type: "way", id: 1, tags: { building: "yes" }, geometry: ring },
      { type: "way", id: 2, tags: { building: "apartments" }, geometry: ring },
    ],
    relations: [{ type: "relation", id: 9, tags: { building: "yes" }, members: [{ type: "way", ref: 1, role: "outer", geometry: ring }] }],
    roads: [{ type: "way", id: 3, tags: { highway: "residential", name: "Folkungagatan" }, geometry: ring }],
    ...overrides,
  };
}

let dir: string;
let cachePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "osm-cache-test-"));
  cachePath = join(dir, "innerstan.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const writeCache = (file: OsmExtract) => writeFileSync(cachePath, JSON.stringify(file), "utf8");

describe("constants", () => {
  it("pins the cache location, the 31-day rule and the attribution", () => {
    expect(OSM_CACHE_DIR).toBe(".planning/calibration/data/osm");
    expect(OSM_CACHE_PATH).toBe(".planning/calibration/data/osm/innerstan.json");
    expect(OSM_REFRESH_DAYS).toBe(31);
    expect(OSM_ATTRIBUTION).toBe("© OpenStreetMap contributors, ODbL 1.0, https://www.openstreetmap.org/copyright");
    expect(OSM_ATTRIBUTION).toBe(OSM_BUILDINGS_ATTRIBUTION);
  });
});

// ---------------------------------------------------------------------------
// The age rule (SUN-05)
// ---------------------------------------------------------------------------

describe("osmCacheNeedsRefresh (boundary inclusive at 31 days)", () => {
  const meta = (fetchedAt: string) => ({ fetchedAt });

  it("a missing or unreadable file needs a refresh", () => {
    expect(osmCacheNeedsRefresh(null, NOW)).toBe(true);
  });

  it("an unparsable fetchedAt needs a refresh", () => {
    expect(osmCacheNeedsRefresh(meta("not a date"), NOW)).toBe(true);
    expect(osmCacheNeedsRefresh(meta(""), NOW)).toBe(true);
  });

  it("31 days minus one minute is still fresh", () => {
    expect(osmCacheNeedsRefresh(meta(iso(31 * DAY - 60_000)), NOW)).toBe(false);
  });

  it("exactly 31 days needs a refresh", () => {
    expect(osmCacheNeedsRefresh(meta(iso(31 * DAY)), NOW)).toBe(true);
  });

  it("31 days plus one millisecond needs a refresh", () => {
    expect(osmCacheNeedsRefresh(meta(iso(31 * DAY + 1)), NOW)).toBe(true);
  });

  it("a fetchedAt two days in the future (clock error) needs a refresh; 12 hours ahead is tolerated", () => {
    expect(osmCacheNeedsRefresh(meta(iso(-2 * DAY)), NOW)).toBe(true);
    expect(osmCacheNeedsRefresh(meta(iso(-12 * 3_600_000)), NOW)).toBe(false);
  });

  it("a brand-new cache is fresh", () => {
    expect(osmCacheNeedsRefresh(meta(NOW.toISOString()), NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

describe("loadOsmCacheRaw / readOsmCacheMeta (fail closed, never throw)", () => {
  it("a missing file is { error: 'saknas' }", () => {
    expect(loadOsmCacheRaw(cachePath)).toEqual({ error: "saknas" });
    expect(readOsmCacheMeta(cachePath)).toBeNull();
  });

  it("invalid JSON is { error: 'ogiltig JSON' } and the file is left in place", () => {
    writeFileSync(cachePath, "{ not json", "utf8");
    expect(loadOsmCacheRaw(cachePath)).toEqual({ error: "ogiltig JSON" });
    expect(existsSync(cachePath)).toBe(true);
    expect(readFileSync(cachePath, "utf8")).toBe("{ not json");
    expect(readdirSync(dir)).toEqual(["innerstan.json"]);
    expect(readOsmCacheMeta(cachePath)).toBeNull();
  });

  it("a file of the wrong shape is { error: 'fel format' }", () => {
    writeFileSync(cachePath, JSON.stringify({ version: 2, buildings: [] }), "utf8");
    expect(loadOsmCacheRaw(cachePath)).toEqual({ error: "fel format" });
    writeFileSync(cachePath, JSON.stringify({ ...extractFile(), buildings: "nope" }), "utf8");
    expect(loadOsmCacheRaw(cachePath)).toEqual({ error: "fel format" });
  });

  it("a path that cannot be read as a file does not throw", () => {
    const asDir = join(dir, "adir.json");
    mkdirSync(asDir);
    const result = loadOsmCacheRaw(asDir);
    expect("error" in result).toBe(true);
  });

  it("a good file gives the raw value and the meta with counts", () => {
    writeCache(extractFile({ source: "research download 2026-10-13" }));
    const loaded = loadOsmCacheRaw(cachePath);
    expect("error" in loaded).toBe(false);
    if ("error" in loaded) return;
    expect(() => parseOsmExtract(loaded.raw)).not.toThrow();
    expect(loaded.meta).toEqual({
      fetchedAt: NOW.toISOString(),
      osmBase: "2026-11-20T11:40:00Z",
      source: "research download 2026-10-13",
      counts: { buildings: 2, relations: 1, roads: 1 },
    });
    expect(readOsmCacheMeta(cachePath)).toEqual(loaded.meta);
  });
});

describe("a cache with good metadata but unusable geometry is not a cache (14.3 review WR-05)", () => {
  /** Valid metadata (the refresh decision's view) around geometry parseOsmExtract refuses: a latitude of 99. */
  const badGeometry = (): OsmExtract => {
    const file = extractFile();
    return { ...file, buildings: [{ type: "way", id: 1, tags: { building: "yes" }, geometry: [{ lat: 99, lon: 18 }] }] };
  };

  it("loads as { error: 'oläsbar' } and reads as no meta, although the metadata alone is fine", () => {
    writeCache(badGeometry());
    expect(loadOsmCacheRaw(cachePath)).toEqual({ error: "oläsbar" });
    expect(readOsmCacheMeta(cachePath)).toBeNull();
    expect(existsSync(cachePath)).toBe(true);
  });

  it("a file with no building at all is unusable too", () => {
    writeCache(extractFile({ buildings: [] }));
    expect(loadOsmCacheRaw(cachePath)).toEqual({ error: "oläsbar" });
    expect(readOsmCacheMeta(cachePath)).toBeNull();
  });

  it("a brand-new but unusable file is downloaded again (old code: 'fresh' for 31 days, no download)", async () => {
    writeCache(badGeometry());
    const download = vi.fn(async () => extractFile({ fetchedAt: NOW.toISOString() }));
    const result = await refreshOsmCacheIfStale({ path: cachePath, now: NOW, force: false, download, dir });
    expect(download).toHaveBeenCalledTimes(1);
    expect(result.action).toBe("downloaded");
    expect("error" in loadOsmCacheRaw(cachePath)).toBe(false);
  });

  it("a failed download leaves the unusable file in place and reports no cache", async () => {
    writeCache(badGeometry());
    const before = readFileSync(cachePath);
    const result = await refreshOsmCacheIfStale({
      path: cachePath,
      now: NOW,
      force: false,
      download: async () => {
        throw new Error("nere");
      },
      dir,
    });
    expect(result.action).toBe("failed-no-cache");
    expect(readFileSync(cachePath).equals(before)).toBe(true);
  });

  it("a usable file of the same age is still fresh and never downloaded", async () => {
    writeCache(extractFile());
    const download = vi.fn(async () => extractFile());
    const result = await refreshOsmCacheIfStale({ path: cachePath, now: NOW, force: false, download, dir });
    expect(result.action).toBe("fresh");
    expect(download).not.toHaveBeenCalled();
  });

  it("names the okänd reason by what is wrong with the cache, with three fixed labels", () => {
    expect(osmCacheUnknownReason(osmCacheFailureText("saknas"))).toBe("OSM-cache saknas");
    expect(osmCacheUnknownReason(osmCacheFailureText("oläsbar"))).toBe("OSM-cache oläsbar");
    expect(osmCacheUnknownReason(osmCacheFailureText("ogiltig JSON"))).toBe("OSM-cache ogiltig");
    expect(osmCacheUnknownReason(osmCacheFailureText("fel format"))).toBe("OSM-cache ogiltig");
    expect(osmCacheUnknownReason("ogiltig (bbox.north: Too big)")).toBe("OSM-cache ogiltig");
    expect(osmCacheFailureText("saknas")).toBe("saknas (filen finns inte)");
    expect(osmCacheFailureText("fel format")).toBe("ogiltig (fel format)");
  });
});

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

describe("saveOsmCache (guarded, atomic, compact)", () => {
  it("writes compact JSON inside the osm directory and reads it back", () => {
    saveOsmCache(cachePath, extractFile(), { dir });
    const text = readFileSync(cachePath, "utf8");
    expect(text).toBe(JSON.stringify(extractFile()));
    expect(text).not.toMatch(/\n\s*[\]{["]/);
    expect(text).not.toContain("\n");
    expect("error" in loadOsmCacheRaw(cachePath)).toBe(false);
    expect(readdirSync(dir)).toEqual(["innerstan.json"]);
  });

  it("creates the directory when it does not exist yet", () => {
    const nested = join(dir, "osm");
    saveOsmCache(join(nested, "innerstan.json"), extractFile(), { dir: nested });
    expect(existsSync(join(nested, "innerstan.json"))).toBe(true);
  });

  it("refuses a path outside the osm directory", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "osm-elsewhere-"));
    try {
      expect(() => saveOsmCache(join(elsewhere, "innerstan.json"), extractFile(), { dir })).toThrow(/får bara skrivas under/);
      expect(() => saveOsmCache(join(dir, "..", "innerstan.json"), extractFile(), { dir })).toThrow(/får bara skrivas under/);
      expect(() => saveOsmCache(`${dir}-evil/innerstan.json`, extractFile(), { dir })).toThrow(/får bara skrivas under/);
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("refuses a path without the .json ending", () => {
    expect(() => saveOsmCache(join(dir, "innerstan.txt"), extractFile(), { dir })).toThrow(/får bara skrivas under/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("with the default directory, a path outside .planning/calibration/data/osm is refused", () => {
    expect(() => saveOsmCache(join(dir, "innerstan.json"), extractFile())).toThrow(/får bara skrivas under/);
  });
});

// ---------------------------------------------------------------------------
// The refresh decision
// ---------------------------------------------------------------------------

describe("fresh cache never downloads (SUN-05)", () => {
  it("a 3-day-old cache: action fresh, the download spy is never called, the line is pinned, the file is untouched", async () => {
    writeCache(extractFile({ fetchedAt: iso(3 * DAY) }));
    const before = readFileSync(cachePath);
    const download = vi.fn(async () => extractFile());
    const result = await refreshOsmCacheIfStale({ path: cachePath, now: NOW, force: false, download, dir });
    expect(result.action).toBe("fresh");
    expect(download).not.toHaveBeenCalled();
    expect(result.ageDays).toBeCloseTo(3, 5);
    expect(renderOsmCacheLine(result)).toBe("OSM-cache: 3,0 dagar gammal, ingen hämtning (gräns 31 dagar)");
    expect(result.message).toBe("OSM-cache: 3,0 dagar gammal, ingen hämtning (gräns 31 dagar)");
    expect(readFileSync(cachePath).equals(before)).toBe(true);
  });

  it("30 days 23 hours 59 minutes old: still fresh, no download", async () => {
    writeCache(extractFile({ fetchedAt: iso(31 * DAY - 60_000) }));
    const download = vi.fn(async () => extractFile());
    const result = await refreshOsmCacheIfStale({ path: cachePath, now: NOW, force: false, download, dir });
    expect(result.action).toBe("fresh");
    expect(download).not.toHaveBeenCalled();
    expect(renderOsmCacheLine(result)).toBe("OSM-cache: 31,0 dagar gammal, ingen hämtning (gräns 31 dagar)");
  });

  it("the age is printed with one decimal and a decimal comma", async () => {
    writeCache(extractFile({ fetchedAt: iso(12.34 * DAY) }));
    const result = await refreshOsmCacheIfStale({ path: cachePath, now: NOW, force: false, download: vi.fn(), dir });
    expect(renderOsmCacheLine(result)).toBe("OSM-cache: 12,3 dagar gammal, ingen hämtning (gräns 31 dagar)");
  });

  it("exactly 31 days old: the download is called", async () => {
    writeCache(extractFile({ fetchedAt: iso(31 * DAY) }));
    const download = vi.fn(async () => extractFile({ fetchedAt: NOW.toISOString() }));
    const result = await refreshOsmCacheIfStale({ path: cachePath, now: NOW, force: false, download, dir });
    expect(download).toHaveBeenCalledTimes(1);
    expect(result.action).toBe("downloaded");
  });

  it("force on a fresh cache downloads anyway and replaces the file", async () => {
    writeCache(extractFile({ fetchedAt: iso(1 * DAY) }));
    const replacement = extractFile({ fetchedAt: NOW.toISOString(), osmBase: "2026-11-20T11:59:00Z" });
    const download = vi.fn(async () => replacement);
    const result = await refreshOsmCacheIfStale({ path: cachePath, now: NOW, force: true, download, dir });
    expect(download).toHaveBeenCalledTimes(1);
    expect(result.action).toBe("downloaded");
    expect(readFileSync(cachePath, "utf8")).toBe(JSON.stringify(replacement));
  });
});

describe("refreshOsmCacheIfStale: stale, missing and failed", () => {
  it("no file: downloads, saves, and renders the pinned 'hämtad' line", async () => {
    const fresh = extractFile();
    const download = vi.fn(async () => fresh);
    const result = await refreshOsmCacheIfStale({ path: cachePath, now: NOW, force: false, download, dir });
    expect(result.action).toBe("downloaded");
    expect(download).toHaveBeenCalledTimes(1);
    expect(renderOsmCacheLine(result)).toBe(
      `OSM-cache: hämtad ${NOW.toISOString()} (byggnader 2, relationer 1, gator 1, OSM-tid 2026-11-20T11:40:00Z)`,
    );
    expect(readFileSync(cachePath, "utf8")).toBe(JSON.stringify(fresh));
  });

  it("stale + download throws + old file present: failed-kept-old, the old file byte-identical, reason in the line", async () => {
    writeCache(extractFile({ fetchedAt: iso(40 * DAY) }));
    const before = readFileSync(cachePath);
    const download = vi.fn(async () => {
      throw new Error("Overpass svarade inte");
    });
    const result = await refreshOsmCacheIfStale({ path: cachePath, now: NOW, force: false, download, dir });
    expect(result.action).toBe("failed-kept-old");
    expect(readFileSync(cachePath).equals(before)).toBe(true);
    expect(readdirSync(dir)).toEqual(["innerstan.json"]);
    expect(renderOsmCacheLine(result)).toBe("OSM-cache: hämtning misslyckades (Overpass svarade inte), använder 40,0 dagar gammal cache");
  });

  it("stale + download throws + no file: failed-no-cache and no file is created", async () => {
    const download = vi.fn(async () => {
      throw new Error("Overpass svarade inte");
    });
    const result = await refreshOsmCacheIfStale({ path: cachePath, now: NOW, force: false, download, dir });
    expect(result.action).toBe("failed-no-cache");
    expect(existsSync(cachePath)).toBe(false);
    expect(renderOsmCacheLine(result)).toBe("OSM-cache: hämtning misslyckades (Overpass svarade inte), ingen cache");
  });

  it("force + download throws on a fresh cache keeps the fresh cache", async () => {
    writeCache(extractFile({ fetchedAt: iso(2 * DAY) }));
    const before = readFileSync(cachePath);
    const result = await refreshOsmCacheIfStale({
      path: cachePath,
      now: NOW,
      force: true,
      download: async () => {
        throw new Error("nere");
      },
      dir,
    });
    expect(result.action).toBe("failed-kept-old");
    expect(readFileSync(cachePath).equals(before)).toBe(true);
  });

  it("a corrupt old file counts as no cache, and a failed download does not overwrite it", async () => {
    writeFileSync(cachePath, "{ broken", "utf8");
    const result = await refreshOsmCacheIfStale({
      path: cachePath,
      now: NOW,
      force: false,
      download: async () => {
        throw new Error("nere");
      },
      dir,
    });
    expect(result.action).toBe("failed-no-cache");
    expect(readFileSync(cachePath, "utf8")).toBe("{ broken");
  });

  it("a path outside the osm directory fails before any download is attempted", async () => {
    const download = vi.fn(async () => extractFile());
    const result = await refreshOsmCacheIfStale({ path: join(tmpdir(), "outside-innerstan.json"), now: NOW, force: true, download, dir });
    expect(download).not.toHaveBeenCalled();
    expect(result.action).toBe("failed-no-cache");
    expect(renderOsmCacheLine(result)).toContain("får bara skrivas under");
  });

  it("two downloads at once each rename a complete file: the result always parses and no temp file is left", async () => {
    const a = extractFile({ osmBase: "2026-11-20T11:41:00Z" });
    const b = extractFile({ osmBase: "2026-11-20T11:42:00Z" });
    const slow = (file: OsmExtract) => async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return file;
    };
    const [ra, rb] = await Promise.all([
      refreshOsmCacheIfStale({ path: cachePath, now: NOW, force: true, download: slow(a), dir }),
      refreshOsmCacheIfStale({ path: cachePath, now: NOW, force: true, download: slow(b), dir }),
    ]);
    expect(ra.action).toBe("downloaded");
    expect(rb.action).toBe("downloaded");
    const text = readFileSync(cachePath, "utf8");
    expect([JSON.stringify(a), JSON.stringify(b)]).toContain(text);
    expect(() => parseOsmExtract(JSON.parse(text))).not.toThrow();
    expect(readdirSync(dir)).toEqual(["innerstan.json"]);
  });
});

describe("renderOsmCacheLine", () => {
  it("is the fourth pinned line for a failure without a cache", () => {
    expect(renderOsmCacheLine({ action: "failed-no-cache", ageDays: null, reason: "x", meta: null })).toBe("OSM-cache: hämtning misslyckades (x), ingen cache");
  });
});
