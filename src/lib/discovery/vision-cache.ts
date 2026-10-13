/**
 * vision-cache.ts - picture reading for EVERY candidate of the weekly run,
 * within a hard ceiling, and never paid for twice (Phase 14.2, WATCH-02, D-06,
 * R-09).
 *
 * Three jobs:
 *  1. Lanes. The candidates are dealt into 3 interleaved lanes (index mod 3) that
 *     run in parallel. One lane reads about 20 s per flat, so 77 flats in one lane
 *     would take 25 minutes; three lanes take a third of that.
 *  2. A ceiling that cannot be passed. Each lane gets `capSekTotal / chunks`
 *     (60 / 3 = 20 SEK) through `runVisionPass`'s `capSek` option, so the three
 *     lanes together can never pass `HEADLESS_VISION_CAP_SEK` (60 SEK) even when
 *     they all run at once. The in-app cap (`CAP_VISION_SEK_MAX`, 25 SEK) is a
 *     different number for a different caller and is not touched.
 *  3. A cache. A flat that was read last week, with the same set of pictures, is
 *     not read (or paid for) again. The key is the listing path plus a hash of the
 *     picture set, so a re-photographed flat is read again.
 *
 * GDPR: only the claim text is cached (the `VisionResult`: short Swedish
 * sentences about kitchen and bathroom, picture numbers and the Booli CDN
 * picture URLs the read used). Pictures and broker descriptions are never stored.
 *
 * Cost: a cache hit is free in the run that uses it, so the copy attached to the
 * candidate has `costSek` 0. The stored entry keeps the original cost. The spend
 * printed for a run is therefore only what this run paid.
 *
 * Known gap: money billed for a call that then failed (refused, truncated) is
 * counted inside `runVisionPass` against its cap, but is not visible in the
 * returned candidates, so it is not in `spentSek` here either.
 *
 * Script-side only: loaded by `scripts/fit-score.ts`. The vision pass itself is
 * injected as `runPass`, so this module never loads the Anthropic client.
 */
import { createHash } from "node:crypto";
import { renameSync } from "node:fs";
import { z } from "zod/v4";
import type { BrokerImageBytes } from "@/lib/broker/broker-images";
import type { DiscoveryCandidate } from "@/lib/discovery/candidate";
import { guardedDataPath, readJsonIfExists, writeJsonAtomic } from "@/lib/discovery/json-store";
import { visionResultSchema, type VisionResult } from "@/lib/discovery/vision-schema";

/** The cache file. Gitignored (the whole data directory is). */
export const VISION_CACHE_PATH = ".planning/calibration/data/vision-cache.json";
/** The only directory the cache may be written to. */
export const VISION_CACHE_DIR = ".planning/calibration/data";
/** D-06 / R-09: the headless ceiling for one run, SEK. The in-app CAP_VISION_SEK_MAX (25) is separate. */
export const HEADLESS_VISION_CAP_SEK = 60;
/** Parallel lanes. */
export const HEADLESS_VISION_CHUNKS = 3;

const cacheEntrySchema = z.object({
  listingKey: z.string(),
  imageKey: z.string(),
  storedAt: z.string(),
  result: visionResultSchema,
});

const visionCacheSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), cacheEntrySchema),
});

export type VisionCache = z.infer<typeof visionCacheSchema>;

const emptyCache = (): VisionCache => ({ version: 1, entries: {} });

const entryId = (listingKey: string, imageKey: string): string => `${listingKey}#${imageKey}`;

/**
 * A key for the set of pictures a read would use: the Booli picture URLs
 * (order does not matter) and how many broker pictures were available. One URL
 * more or less, or a different broker picture count, gives a different key.
 */
export function imageSetKey(imageUrls: readonly string[] | null | undefined, brokerImageCount: number): string {
  const urls = [...(imageUrls ?? [])].sort();
  return createHash("sha256")
    .update(JSON.stringify({ urls, broker: Math.max(0, Math.floor(brokerImageCount)) }))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Reads the cache. A missing file is an empty cache. A file that is not valid
 * JSON or does not match the schema is read as empty, a warning string is
 * returned, and the bad file is renamed to `<path>.bak-<timestamp>` so the next
 * save does not overwrite the evidence. Never throws.
 */
export function loadVisionCache(
  path: string,
  opts: { now?: () => number } = {},
): { cache: VisionCache; warning: string | null } {
  let raw: unknown;
  try {
    raw = readJsonIfExists(path);
    if (raw === null) return { cache: emptyCache(), warning: null };
    const parsed = visionCacheSchema.safeParse(raw);
    if (parsed.success) return { cache: parsed.data, warning: null };
  } catch {
    // fall through: unreadable or not JSON is handled like a schema failure
  }
  const stamp = new Date((opts.now ?? Date.now)()).toISOString().replace(/[:.]/g, "-");
  const aside = `${path}.bak-${stamp}`;
  let moved = true;
  try {
    renameSync(path, aside);
  } catch {
    moved = false;
  }
  return {
    cache: emptyCache(),
    warning: `Bildcachen ${path} kunde inte läsas och lästes som tom${moved ? `; filen flyttades till ${aside}` : " (filen kunde inte flyttas)"}`,
  };
}

/**
 * Writes the cache atomically. Refuses a path outside the data directory
 * (T-14.2-13) by throwing; `opts.dir` exists for tests.
 */
export function saveVisionCache(path: string, cache: VisionCache, opts: { dir?: string } = {}): void {
  const safe = guardedDataPath(path, { dir: opts.dir ?? VISION_CACHE_DIR, ext: ".json" });
  if (safe === null) throw new Error(`Bildcachen får bara skrivas under ${opts.dir ?? VISION_CACHE_DIR}/ (fick ${path})`);
  writeJsonAtomic(safe, cache);
}

/** The vision pass as `runVisionPass` exposes it (injected, so tests need no Anthropic mock). */
export type VisionPassFn = (
  candidates: DiscoveryCandidate[],
  opts: {
    brokerImagesOf: (candidate: DiscoveryCandidate, index: number) => BrokerImageBytes[];
    capSek: number;
  },
) => Promise<DiscoveryCandidate[]>;

export interface RunVisionChunksOptions {
  /** Broker photos for the candidate at GLOBAL index `index` (the index in the array given to runVisionChunks). */
  brokerImagesOf: (candidate: DiscoveryCandidate, index: number) => BrokerImageBytes[];
  cache: VisionCache;
  runPass: VisionPassFn;
  /** Total ceiling for the run, SEK. Default {@link HEADLESS_VISION_CAP_SEK}. */
  capSekTotal?: number;
  /** Lanes. Default {@link HEADLESS_VISION_CHUNKS}. */
  chunks?: number;
  /** The listing key (the listing path), or null when there is none (such a candidate is never cached). */
  keyOf: (candidate: DiscoveryCandidate) => string | null;
  /** "YYYY-MM-DD", stored with each new entry. */
  today: string;
}

export interface VisionChunksResult {
  /** Same length and order as the input. */
  candidates: DiscoveryCandidate[];
  /** What this run paid, SEK (cache hits are 0). */
  spentSek: number;
  /** Candidates that got a fresh vision result. */
  calls: number;
  cacheHits: number;
  /** Skipped reason -> number of candidates (no_images, cost_cap, vision_error). */
  skipped: Record<string, number>;
  /** Lane sizes (candidates dealt to each lane, cache hits included). */
  chunkSizes: number[];
  /** The cache to save: the loaded one plus this run's new results. */
  cacheNext: VisionCache;
}

/**
 * Reads the pictures of every candidate in `chunks` parallel lanes (index mod
 * `chunks`), each lane capped at `capSekTotal / chunks`, serving what it can from
 * the cache. The output keeps the input order whatever order the lanes finish in.
 * Never throws: a lane whose pass throws marks its candidates `vision_error`.
 */
export async function runVisionChunks(
  candidates: DiscoveryCandidate[],
  opts: RunVisionChunksOptions,
): Promise<VisionChunksResult> {
  const chunks = Math.max(1, Math.floor(opts.chunks ?? HEADLESS_VISION_CHUNKS));
  const capSekTotal = opts.capSekTotal ?? HEADLESS_VISION_CAP_SEK;
  const laneCapSek = capSekTotal / chunks;

  const lanes: number[][] = Array.from({ length: chunks }, () => []);
  candidates.forEach((_c, i) => lanes[i % chunks].push(i));
  const chunkSizes = lanes.map((l) => l.length);

  const out: DiscoveryCandidate[] = new Array<DiscoveryCandidate>(candidates.length);
  const keyed = new Map<number, { listingKey: string; imageKey: string }>();
  const pending = new Set<number>();
  let cacheHits = 0;

  candidates.forEach((c, i) => {
    const listingKey = opts.keyOf(c);
    if (listingKey !== null) {
      const imageKey = imageSetKey(c.imageUrls, opts.brokerImagesOf(c, i).length);
      keyed.set(i, { listingKey, imageKey });
      const hit = opts.cache.entries[entryId(listingKey, imageKey)];
      if (hit) {
        // Free this run: the attached copy costs 0, the stored entry keeps the original cost.
        out[i] = { ...c, vision: { ...hit.result, costSek: 0 }, visionSkippedReason: null };
        cacheHits += 1;
        return;
      }
    }
    pending.add(i);
  });

  await Promise.all(
    lanes.map(async (lane) => {
      const todo = lane.filter((i) => pending.has(i));
      if (todo.length === 0) return;
      const failed = (i: number): DiscoveryCandidate => ({ ...candidates[i], vision: null, visionSkippedReason: "vision_error" });
      let result: DiscoveryCandidate[];
      try {
        result = await opts.runPass(
          todo.map((i) => candidates[i]),
          { brokerImagesOf: (c, local) => opts.brokerImagesOf(c, todo[local] ?? local), capSek: laneCapSek },
        );
      } catch (error) {
        console.error("[vision-cache] lane failed (non-fatal)", { code: error instanceof Error ? error.name : "UNKNOWN" });
        result = todo.map(failed);
      }
      todo.forEach((globalIndex, local) => {
        out[globalIndex] = result[local] ?? failed(globalIndex);
      });
    }),
  );

  let spentSek = 0;
  let calls = 0;
  const skipped: Record<string, number> = {};
  const fresh: { id: string; listingKey: string; imageKey: string; result: VisionResult }[] = [];
  for (const i of pending) {
    const c = out[i];
    if (c.vision !== null) {
      calls += 1;
      spentSek += c.vision.costSek;
      const k = keyed.get(i);
      // A result is cached; a null result (skipped or failed) never is.
      if (k) fresh.push({ id: entryId(k.listingKey, k.imageKey), ...k, result: c.vision });
    } else {
      const reason = c.visionSkippedReason ?? "okänd";
      skipped[reason] = (skipped[reason] ?? 0) + 1;
    }
  }

  // New entries replace older entries of the same listing (an old picture set is dead weight).
  const replaced = new Set(fresh.map((f) => f.listingKey));
  const entries: VisionCache["entries"] = {};
  for (const [id, e] of Object.entries(opts.cache.entries)) {
    if (!replaced.has(e.listingKey)) entries[id] = e;
  }
  for (const f of fresh) {
    entries[f.id] = { listingKey: f.listingKey, imageKey: f.imageKey, storedAt: opts.today, result: f.result };
  }

  return { candidates: out, spentSek, calls, cacheHits, skipped, chunkSizes, cacheNext: { version: 1, entries } };
}

/**
 * The one pinned spend line of a run, for example
 * "Bildtolkning: 9 anrop, 1 från cache, 0 hoppades över, 4,10 kr av tak 60 kr (delar: 4/3/3 kandidater)".
 * Pure. `skipped` is the total or the per-reason record; spend has 2 decimals and a decimal comma.
 */
export function renderVisionLine(stats: {
  calls: number;
  cacheHits: number;
  skipped: number | Record<string, number>;
  spentSek: number;
  chunkSizes: readonly number[];
  capSek?: number;
}): string {
  const skipped = typeof stats.skipped === "number" ? stats.skipped : Object.values(stats.skipped).reduce((a, b) => a + b, 0);
  const spent = stats.spentSek.toFixed(2).replace(".", ",");
  const cap = stats.capSek ?? HEADLESS_VISION_CAP_SEK;
  return `Bildtolkning: ${stats.calls} anrop, ${stats.cacheHits} från cache, ${skipped} hoppades över, ${spent} kr av tak ${cap} kr (delar: ${stats.chunkSizes.join("/")} kandidater)`;
}
