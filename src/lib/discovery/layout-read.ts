/**
 * layout-read.ts - the slim layout read (Phase 14.4, LAY-01, D-07, D-08, R-07).
 *
 * The question: for one for-sale flat, which side is the balcony on (street or courtyard), are the
 * living room, kitchen and bedroom on that side, do the windows sit on one side, on two opposite sides
 * (korsdrag) or in a corner, which side is the bedroom on, and what in the PHOTOS settled street versus
 * courtyard? 14.3 knows which facade faces the street, but not whether the living space faces it, so it
 * counts the better of the two sides at half weight. This read answers that, once per flat, cached.
 *
 * Why a SEPARATE call with its own schema and its own cache: `VISION_PROMPT_VERSION` (vision-cache.ts) is
 * a hash of both vision prompts, both model ids, the vision schemas and a logic revision. Adding one field
 * to the existing schema re-keys all 77 cached reads and re-bills about 33 kr. So the existing vision
 * schema, prompts and cache are not touched; this file has its own cache file (`layout-cache.json`,
 * gitignored with the data directory) keyed by the listing, the picture set and {@link LAYOUT_READ_VERSION}.
 *
 * Strict-output limits (memory anthropic-structured-output-limits): the schema is eight flat fields
 * (four enums, three booleans, one number), with no nullable value, no union and no numeric constraint.
 * Unit tests cannot prove the grammar compiles; the live smoke in `scripts/layout-read-probe.ts` does
 * (RUN_LLM_EVALS=1). The prompt never asks for a compass or a bearing (14.3: the model fell for the
 * front-door arrow on 6 of 11 plans); whether a read is believed is decided by plain code in layout-fact.ts.
 *
 * Money (R-07): the call is estimated at {@link LAYOUT_EST_SEK_PER_FLAT} before it is made and a run may
 * spend at most {@link LAYOUT_RUN_CAP_SEK}. The cache also keeps a LIFETIME ledger (`spentSekTotal`) that is
 * printed but never enforced, so the weekly job is not stopped by what earlier weeks spent.
 *
 * Script-side only. The model call is INJECTED (`call`), exactly like `runFloorPlanProbe`, so this module
 * never loads the Anthropic client and tests need no network and no key. GDPR: only the eight read fields
 * are cached, never a picture; broker photos exist as bytes in memory during a run and nowhere else.
 *
 * STRUCTURAL SEPARATION (LOCKED): `niche-score.ts` and `report/flags.ts` must never import it.
 */
import { createHash } from "node:crypto";
import { renameSync } from "node:fs";
import { z } from "zod/v4";
import { isAllowedImageHost } from "@/lib/booli/image-host";
import type { BrokerImageBytes } from "@/lib/broker/broker-images";
import {
  BALCONY_SIDES,
  BEDROOM_SIDES,
  STREET_EVIDENCE,
  WINDOW_SIDES,
  type LayoutFact,
} from "@/lib/discovery/layout-fact";
import { guardedDataPath, readJsonIfExists, writeJsonAtomic } from "@/lib/discovery/json-store";
import { FloorPlanCallError, asBilledFailure, type FloorPlanImageBlock } from "@/lib/discovery/sun-floorplan";
import { imageSetKey, visionListingKey } from "@/lib/discovery/vision-cache";
import { VISION_SONNET_MODEL } from "@/lib/discovery/vision-prompt";

/** The model of the read: the Sonnet deep-pass tier, because reading a plan is the hard part (D-07). */
export const LAYOUT_MODEL = VISION_SONNET_MODEL;

/** Bump when code that is not text (the gate in layout-fact.ts, the image choice here) changes what a stored read means. */
export const LAYOUT_LOGIC_REVISION = 1;

/** The cache file. Gitignored (the whole data directory is). */
export const LAYOUT_CACHE_PATH = ".planning/calibration/data/layout-cache.json";
/** The only directory the cache may be written to. */
export const LAYOUT_CACHE_DIR = ".planning/calibration/data";

/** What one read is assumed to cost before it is made, SEK (R-07: the plan plus up to 6 photos, about 0,43 kr). */
export const LAYOUT_EST_SEK_PER_FLAT = 0.6;
/** The most one RUN may spend, SEK (R-07). Per run, not lifetime: the weekly job must never be stopped by old spend. */
export const LAYOUT_RUN_CAP_SEK = 40;
/** The plan is image 1; up to this many more Booli photos follow. */
export const LAYOUT_MAX_BOOLI_PHOTOS = 3;
/** Up to this many broker photos (bytes, in memory only) follow. */
export const LAYOUT_MAX_BROKER_PHOTOS = 3;
/** The answer is eight short fields. */
export const LAYOUT_MAX_TOKENS = 400;

/** The answer the model gives (D-08). Eight flat fields; see the file header for why it stays this small. */
export const layoutReadSchema = z.object({
  balconySide: z
    .enum(BALCONY_SIDES)
    .describe("Vilken sida balkongen ligger på: street (mot gatan), courtyard (mot gården), none (ingen balkong) eller unknown (bilderna visar det inte)."),
  livingOnBalconySide: z.boolean().describe("True om vardagsrummet ligger på samma sida som balkongen, annars false."),
  kitchenOnBalconySide: z.boolean().describe("True om köket ligger på samma sida som balkongen, annars false."),
  bedroomOnBalconySide: z.boolean().describe("True om något sovrum ligger på samma sida som balkongen, annars false."),
  windowSides: z
    .enum(WINDOW_SIDES)
    .describe("Hur fönstren sitter: one (alla åt ett håll), twoOpposite (åt två motsatta håll, genomgående), corner (i ett hörn) eller unknown."),
  bedroomSide: z
    .enum(BEDROOM_SIDES)
    .describe("Vilken sida huvudsovrummet vänder åt: street (mot gatan), courtyard (mot gården) eller unknown."),
  streetEvidence: z
    .enum(STREET_EVIDENCE)
    .describe("Vad i FOTONA som visade gata eller gård: cars (bilar eller körbana), oppositeFacade (en husfasad på nära håll mitt emot), courtyardGreenery (en gård med grönska) eller none (fotona visar det inte)."),
  confidence: z.number().describe("Din säkerhet 0 till 1 i hela bedömningen."),
});

export type LayoutRead = z.infer<typeof layoutReadSchema>;

export const LAYOUT_SYSTEM_PROMPT = [
  "Du tittar på bilder från en svensk bostadsannons. Bild 1 är normalt planritningen (en ritning av lägenheten ovanifrån) och resten är foton från lägenheten.",
  "Avgör vilken sida av lägenheten balkongen sitter på, vilka rum (vardagsrum, kök, sovrum) som ligger på samma sida som balkongen, om fönstren sitter åt ett håll, åt två motsatta håll (genomgående, ger korsdrag) eller i ett hörn, och vilken sida huvudsovrummet vänder åt.",
  "Vilken sida som är gatusidan och vilken som är gårdssidan avgörs av FOTONA, aldrig av planritningen ensam: bilar eller körbana, en husfasad på nära håll mitt emot, eller en gård med grönska. Ange i streetEvidence vad i fotona som visade det, eller none om fotona inte visar det.",
  "Visar bilderna det inte, svara unknown, none eller false. Gissa inte. Svara bara genom fälten.",
].join(" ");

/** The short instruction that follows the images in the user turn. */
export const LAYOUT_USER_INSTRUCTION =
  "Läs av balkongens sida, fönstersidorna och sovrummets sida enligt instruktionen.";

/**
 * What decides the meaning of a stored read: the prompt, the model id, the JSON schema (which carries the
 * field descriptions) and the logic revision. Same recipe as `floorPlanProbeVersion` in sun-floorplan.ts.
 * Pure, so a test can change one part and watch the hash move.
 */
export function layoutReadVersion(parts: { prompt: string; model: string; schema: unknown; revision: number }): string {
  return createHash("sha256")
    .update(JSON.stringify({ model: parts.model, prompt: parts.prompt, schema: parts.schema, logic: parts.revision }))
    .digest("hex")
    .slice(0, 16);
}

export const LAYOUT_READ_VERSION: string = layoutReadVersion({
  prompt: `${LAYOUT_SYSTEM_PROMPT}\n${LAYOUT_USER_INSTRUCTION}`,
  model: LAYOUT_MODEL,
  schema: z.toJSONSchema(layoutReadSchema, { unrepresentable: "any" }),
  revision: LAYOUT_LOGIC_REVISION,
});

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

/** The image content block of the Messages API: a URL or inline base64 bytes. */
export type LayoutImageBlock = FloorPlanImageBlock;

export interface LayoutImages {
  blocks: LayoutImageBlock[];
  /** "ok" = a read can be made; "host" = image 1 is not on the allowlist; "no_plan" = there is no image 1. */
  status: "ok" | "host" | "no_plan";
  /** How many Booli pictures (the plan included) and broker pictures the blocks hold. */
  booli: number;
  broker: number;
}

/**
 * The pictures one read uses (R-07): the plan (Booli image 1) first, then up to {@link LAYOUT_MAX_BOOLI_PHOTOS}
 * more Booli photos, then up to {@link LAYOUT_MAX_BROKER_PHOTOS} broker photos as inline bytes: at most 7.
 * Every URL must pass the host allowlist (SSRF): a disallowed FIRST image means no read ("host"), a disallowed
 * later one is skipped. `opts.planImage` supplies the plan as bytes instead of image 1 (the smoke uses it for the
 * committed synthetic plan); then every URL is a photo. Pure.
 */
export function layoutImagesOf(
  imageUrls: readonly string[] | null | undefined,
  brokerImages: readonly BrokerImageBytes[] | null | undefined,
  opts: { planImage?: BrokerImageBytes; maxBooliPhotos?: number } = {},
): LayoutImages {
  const maxPhotos = opts.maxBooliPhotos ?? LAYOUT_MAX_BOOLI_PHOTOS;
  const urls = imageUrls ?? [];
  const blocks: LayoutImageBlock[] = [];
  let photoUrls: readonly string[];
  if (opts.planImage !== undefined) {
    blocks.push({ type: "image", source: { type: "base64", media_type: opts.planImage.mediaType, data: opts.planImage.data } });
    photoUrls = urls;
  } else {
    if (urls.length === 0) return { blocks: [], status: "no_plan", booli: 0, broker: 0 };
    if (!isAllowedImageHost(urls[0])) return { blocks: [], status: "host", booli: 0, broker: 0 };
    blocks.push({ type: "image", source: { type: "url", url: urls[0] } });
    photoUrls = urls.slice(1);
  }
  let photos = 0;
  for (const u of photoUrls) {
    if (photos >= maxPhotos) break;
    if (!isAllowedImageHost(u)) continue;
    blocks.push({ type: "image", source: { type: "url", url: u } });
    photos += 1;
  }
  // The plan counts as a Booli picture when it is image 1 of the listing; planImage bytes are not Booli's.
  const booli = (opts.planImage !== undefined ? 0 : 1) + photos;
  let broker = 0;
  for (const b of brokerImages ?? []) {
    if (broker >= LAYOUT_MAX_BROKER_PHOTOS) break;
    blocks.push({ type: "image", source: { type: "base64", media_type: b.mediaType, data: b.data } });
    broker += 1;
  }
  return { blocks, status: "ok", booli, broker };
}

/** The URLs a set of blocks holds, in order (for the cache key). Exported for the experiment runner (Phase 14.5). */
export const layoutBlockUrls = (blocks: readonly LayoutImageBlock[]): string[] =>
  blocks.flatMap((b) => (b.source.type === "url" ? [b.source.url] : []));

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const layoutCacheEntrySchema = z.object({
  id: z.string(),
  promptVersion: z.string(),
  storedAt: z.string(),
  costSek: z.number(),
  result: layoutReadSchema,
});

export const layoutCacheSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), layoutCacheEntrySchema),
  /**
   * Everything this read has ever paid, SEK, failed and dropped reads included. A LEDGER: printed, never a
   * cap (R-07). Optional: a file written before this field existed reads as the sum of its stored reads.
   */
  spentSekTotal: z.number().min(0).optional(),
});

export type LayoutCache = z.infer<typeof layoutCacheSchema>;

const emptyCache = (): LayoutCache => ({ version: 1, entries: {} });

/**
 * Reads the cache. A missing file is an empty cache. A file that is not valid JSON or does not match the
 * schema is read as empty, a warning string is returned, and the bad file is renamed to `<path>.bak-<stamp>`
 * so the next save does not overwrite the evidence. Never throws.
 */
export function loadLayoutCache(
  path: string,
  opts: { now?: () => number } = {},
): { cache: LayoutCache; warning: string | null } {
  try {
    const raw = readJsonIfExists(path);
    if (raw === null) return { cache: emptyCache(), warning: null };
    const parsed = layoutCacheSchema.safeParse(raw);
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
    warning: `Layoutcachen ${path} kunde inte läsas och lästes som tom${moved ? `; filen flyttades till ${aside}` : " (filen kunde inte flyttas)"}`,
  };
}

/** Writes the cache atomically. Refuses a path outside the data directory by throwing; `opts.dir` exists for tests. */
export function saveLayoutCache(path: string, cache: LayoutCache, opts: { dir?: string } = {}): void {
  const dir = opts.dir ?? LAYOUT_CACHE_DIR;
  const safe = guardedDataPath(path, { dir, ext: ".json" });
  if (safe === null) throw new Error(`Layoutcachen får bara skrivas under ${dir}/ (fick ${path})`);
  writeJsonAtomic(safe, cache);
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/**
 * Thrown by the injected call when the model answered (so Anthropic charged for it) but the answer is
 * unusable (refusal, truncation, nothing parsed). Carries the money already billed, so the cap sees it.
 * It extends {@link FloorPlanCallError} so `asBilledFailure` of sun-floorplan.ts passes it through unchanged.
 */
export class LayoutCallError extends FloorPlanCallError {
  constructor(code: string, billedSek: number) {
    super(code, billedSek);
    this.name = "LayoutCallError";
  }
}

/** One model call on one flat's pictures; `costSek` is what Anthropic charged for it. */
export type LayoutCallFn = (blocks: LayoutImageBlock[]) => Promise<{ result: LayoutRead; costSek: number }>;

/** Re-exported so the script's call can turn an SDK error into one the cap can see. */
export { asBilledFailure };

export type LayoutReadStatus = "read" | "cache" | "cost_cap" | "host" | "no_plan" | "failed";

export interface LayoutReadItem {
  listingPath: string;
  imageUrls: readonly string[] | null;
  /** Broker photos as bytes (in memory only). */
  brokerImages: readonly BrokerImageBytes[];
  /** The plan as bytes instead of image 1 (smoke only). */
  planImage?: BrokerImageBytes;
}

export interface LayoutReadOutcome {
  listingPath: string;
  status: LayoutReadStatus;
  /** What this run paid for this item (a cache hit is 0). */
  costSek: number;
  result: LayoutRead | null;
  /** How many Booli and broker pictures the read saw (0/0 when none was made). */
  images: { booli: number; broker: number };
  /** Error NAME or code only, never a message (a message can carry a URL). */
  errorCode?: string;
}

export interface LayoutRunResult {
  /** Same length and order as the items. */
  reads: LayoutReadOutcome[];
  /** What THIS run paid, SEK. */
  spentSek: number;
  /** What the read has paid in all runs so far including this one, SEK. A printed ledger, never a limit. */
  totalSpentSek: number;
  /** Fresh model reads that came back usable. */
  calls: number;
  cacheHits: number;
  /** The loaded cache plus this run's new reads; entries of another version are dropped. Carries `spentSekTotal`. */
  cacheNext: LayoutCache;
}

const errorLabel = (error: unknown): string =>
  error instanceof FloorPlanCallError ? error.code : error instanceof Error ? error.name : "UNKNOWN";

const isMoney = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * Everything the read has paid before this run, SEK: the recorded total, or the sum of the stored reads' costs
 * when that is larger. Non-finite numbers count as 0.
 */
export function layoutSpentSek(cache: LayoutCache): number {
  const fromEntries = Object.values(cache.entries).reduce((sum, e) => sum + (isMoney(e.costSek) ? e.costSek : 0), 0);
  return Math.max(isMoney(cache.spentSekTotal) ? cache.spentSekTotal : 0, fromEntries);
}

/**
 * Reads the layout of each item, within a per-run ceiling and never paying twice.
 *
 *  - Image 1 off the host allowlist: "host", never handed to `call` (SSRF). No image 1: "no_plan".
 *  - A cache entry of the same listing, the same picture set (count form for the broker photos) AND the
 *    current version is a free hit: no call.
 *  - Before every call: when `spent this run + estimate > runCapSek` (strictly greater; equal is allowed) the
 *    item is "cost_cap" and no call is made. What earlier runs spent never blocks a run.
 *  - A call that comes back with a non-finite or non-positive cost is counted at the estimate.
 *  - A call that throws is "failed" with the error name only and the run goes on; money billed for an
 *    answered-and-failed call ({@link LayoutCallError}) still counts toward `spentSek`.
 *
 * Never throws because of one flat.
 */
export async function runLayoutReads(
  items: ReadonlyArray<LayoutReadItem>,
  opts: { call: LayoutCallFn; cache: LayoutCache; runCapSek: number; today: string; estSekPerFlat?: number },
): Promise<LayoutRunResult> {
  const estimate = opts.estSekPerFlat ?? LAYOUT_EST_SEK_PER_FLAT;
  const priorSek = layoutSpentSek(opts.cache);
  const runCapSek = Number.isFinite(opts.runCapSek) ? opts.runCapSek : 0;
  const reads: LayoutReadOutcome[] = [];
  const fresh = new Map<string, LayoutCache["entries"][string]>();
  let spentSek = 0;
  let calls = 0;
  let cacheHits = 0;

  for (const item of items) {
    const images = layoutImagesOf(item.imageUrls, item.brokerImages, item.planImage ? { planImage: item.planImage } : {});
    const seen = { booli: images.booli, broker: images.broker };
    if (images.status !== "ok") {
      reads.push({ listingPath: item.listingPath, status: images.status, costSek: 0, result: null, images: seen });
      continue;
    }
    const id = `${visionListingKey(item.listingPath)}|${imageSetKey(layoutBlockUrls(images.blocks), images.broker, LAYOUT_READ_VERSION)}`;
    const hit = opts.cache.entries[id];
    if (hit && hit.promptVersion === LAYOUT_READ_VERSION) {
      cacheHits += 1;
      reads.push({ listingPath: item.listingPath, status: "cache", costSek: 0, result: hit.result, images: seen });
      continue;
    }
    // The 1e-9 only absorbs float noise from summing small SEK amounts: equal to the cap is allowed.
    if (spentSek + estimate > runCapSek + 1e-9) {
      reads.push({ listingPath: item.listingPath, status: "cost_cap", costSek: 0, result: null, images: seen });
      continue;
    }
    try {
      const { result, costSek } = await opts.call(images.blocks);
      const paid = isMoney(costSek) ? costSek : estimate;
      spentSek += paid;
      calls += 1;
      reads.push({ listingPath: item.listingPath, status: "read", costSek: paid, result, images: seen });
      fresh.set(id, { id, promptVersion: LAYOUT_READ_VERSION, storedAt: opts.today, costSek: paid, result });
    } catch (error) {
      const billed = error instanceof FloorPlanCallError && isMoney(error.billedSek) ? error.billedSek : 0;
      spentSek += billed;
      reads.push({
        listingPath: item.listingPath,
        status: "failed",
        costSek: billed,
        result: null,
        images: seen,
        errorCode: errorLabel(error),
      });
    }
  }

  const entries: LayoutCache["entries"] = {};
  for (const [id, e] of Object.entries(opts.cache.entries)) {
    if (e.promptVersion === LAYOUT_READ_VERSION) entries[id] = e;
  }
  for (const [id, e] of fresh) entries[id] = e;

  const totalSpentSek = priorSek + spentSek;
  return { reads, spentSek, totalSpentSek, calls, cacheHits, cacheNext: { version: 1, entries, spentSekTotal: totalSpentSek } };
}

/**
 * The stored fact for a read: the eight fields (confidence clamped to [0, 1], a non-finite one stored as 0),
 * where it came from, the version that produced it and how many pictures it saw. The gate that decides whether
 * the fact is believed lives in layout-fact.ts, not here.
 */
export function layoutFactFromRead(read: LayoutRead, meta: { version: string; booli: number; broker: number }): LayoutFact {
  const confidence = Number.isFinite(read.confidence) ? Math.min(1, Math.max(0, read.confidence)) : 0;
  return {
    balconySide: read.balconySide,
    livingOnBalconySide: read.livingOnBalconySide,
    kitchenOnBalconySide: read.kitchenOnBalconySide,
    bedroomOnBalconySide: read.bedroomOnBalconySide,
    windowSides: read.windowSides,
    bedroomSide: read.bedroomSide,
    streetEvidence: read.streetEvidence,
    confidence,
    source: "planritning+foto",
    version: meta.version,
    images: { booli: Math.max(0, Math.floor(meta.booli)), broker: Math.max(0, Math.floor(meta.broker)) },
  };
}
