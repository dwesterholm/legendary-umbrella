/**
 * sold-condition.ts - the slim sold-photo condition read (Phase 14.4, BID-01, D-12, R-08).
 *
 * The question: from the broker photos of one SOLD flat, was the kitchen and bathroom dated, ordinary or
 * freshly renovated? With that label on a few hundred sold flats the bid-premium fit (hedonic-model.ts) can
 * test whether a dated flat really drew a smaller overbid than a fresh one, and keep the term only if
 * cross-validation says the error drops. If sold pages carry no readable photos, or the term is rejected, the
 * premium ignores condition and says "skick ej mätt" (R-08): no invented number.
 *
 * Why a SEPARATE module with its own schema and cache: `VISION_PROMPT_VERSION` (vision-cache.ts) hashes the two
 * vision prompts, both model ids and the vision schemas. Touching any of them re-keys every cached picture read
 * of the for-sale candidates and re-bills about 33 kr. So the existing vision schema, prompts and cache are not
 * touched; this file has its own cache file (`sold-condition-cache.json`, gitignored with the data directory)
 * keyed by the sold listing, the picture set and {@link SOLD_CONDITION_VERSION}.
 *
 * Strict-output limits (memory anthropic-structured-output-limits): the schema is two flat fields, one enum and
 * one plain number. No nullable value, no union, no numeric constraint. Unit tests cannot prove the grammar
 * compiles; the live smoke in `scripts/sold-condition-probe.ts` does (RUN_LLM_EVALS=1).
 *
 * Money (D-12, D-17): a call is estimated at {@link SOLD_CONDITION_EST_SEK_PER_FLAT} before it is made, and the
 * total this read has EVER paid may not pass {@link SOLD_CONDITION_CAP_SEK}. Unlike the weekly layout read, this
 * is a phase budget: the cache keeps a LIFETIME ledger (`spentSekTotal`) and that ledger is enforced, so a rerun
 * can never spend the 30 kr twice. Billed failures count.
 *
 * Pictures: ids come from scraped sold pages, so a URL is built only from a digits-only id on the fixed host
 * bcdn.se (`bcdnImageUrl`) and re-checked with `isAllowedImageHost` before it can reach Anthropic (SSRF).
 * GDPR: only the enum, the confidence and the ids are stored; a picture is never downloaded or written here.
 *
 * Script-side only. The model call is INJECTED (`call`), exactly like `runLayoutReads`, so this module never
 * loads the Anthropic client, reads no environment variable and no clock (`today` is passed in).
 *
 * STRUCTURAL SEPARATION (LOCKED, D-16): `niche-score.ts` and `report/flags.ts` must never import it.
 */
import { createHash } from "node:crypto";
import { renameSync } from "node:fs";
import { z } from "zod/v4";
import { bcdnImageUrl, isAllowedImageHost } from "@/lib/booli/image-host";
import { SOLD_DETAIL_VERSION, stratifiedHashSample, type SoldRow } from "@/lib/booli/slutpriser";
import { guardedDataPath, readJsonIfExists, writeJsonAtomic } from "@/lib/discovery/json-store";
import { FloorPlanCallError, asBilledFailure, type FloorPlanImageBlock } from "@/lib/discovery/sun-floorplan";
import { VISION_HAIKU_MODEL } from "@/lib/discovery/vision-prompt";

/** The model of the read: Haiku, because the question is coarse and the budget is small (D-12). */
export const SOLD_CONDITION_MODEL = VISION_HAIKU_MODEL;

/** Bump when code that is not text (the image choice, the sample) changes what a stored read means. */
export const SOLD_CONDITION_LOGIC_REVISION = 1;

/** The cache file. Gitignored (the whole data directory is). */
export const SOLD_CONDITION_CACHE_PATH = ".planning/calibration/data/sold-condition-cache.json";
/** The only directory the cache may be written to. */
export const SOLD_CONDITION_CACHE_DIR = ".planning/calibration/data";

/** What one read is assumed to cost before it is made, SEK (5 images, Haiku: about 0,09 kr). */
export const SOLD_CONDITION_EST_SEK_PER_FLAT = 0.1;
/** The most this read may EVER spend, SEK (D-12, D-17): a phase budget, enforced against the lifetime ledger. */
export const SOLD_CONDITION_CAP_SEK = 30;
/** At most this many pictures per flat: 5 images cost about 0,091 kr, 6 would pass the 0,1 kr estimate. */
export const SOLD_CONDITION_MAX_IMAGES = 5;
/** The answer is one enum and one number. */
export const SOLD_CONDITION_MAX_TOKENS = 100;
/** A read below this confidence is excluded from the fit, never coded as "ok". */
export const SOLD_CONDITION_MIN_CONFIDENCE = 0.6;
/** Rows in the stratified sample (D-12). */
export const SOLD_CONDITION_SAMPLE_N = 300;
/** The fit branch needs at least this many sales with photo ids and an asking price (R-08, RESEARCH Q9). */
export const SOLD_CONDITION_MIN_ELIGIBLE = 200;
/** Seed of the stratified hash sample: fixed, so the sample is the same on every run. */
export const SOLD_CONDITION_SAMPLE_SEED = "14.4-skick";

/** The smoke reads this many sold flats and the fit branch needs at least {@link SOLD_CONDITION_SMOKE_MIN_READ} usable answers. */
export const SOLD_CONDITION_SMOKE_N = 5;
export const SOLD_CONDITION_SMOKE_MIN_READ = 4;

export const SOLD_CONDITION_VALUES = ["dated", "ok", "fresh"] as const;

/** The answer the model gives: one enum and one confidence. See the file header for why it stays this small. */
export const soldConditionSchema = z.object({
  condition: z
    .enum(SOLD_CONDITION_VALUES)
    .describe("Skicket på kök och badrum: dated (omodernt eller slitet så att en köpare vill byta), ok (vanligt skick) eller fresh (nyrenoverat)."),
  confidence: z.number().describe("Din säkerhet 0 till 1 i bedömningen."),
});

export type SoldConditionRead = z.infer<typeof soldConditionSchema>;

export const SOLD_CONDITION_SYSTEM_PROMPT = [
  "Du tittar på bilder från en såld lägenhets bostadsannons i Stockholm.",
  "Bedöm kök, badrum och helhetsintryck.",
  'Svara "dated" när köket eller badrummet är omodernt eller slitet så att en köpare vill byta det, "fresh" när det är nyrenoverat, annars "ok".',
  "Hoppa över planritningar.",
  'Gissa inte: visar bilderna inte kök eller badrum, välj "ok" med låg säkerhet.',
  "Svara bara genom fälten.",
].join(" ");

/** The short instruction that follows the images in the user turn. */
export const SOLD_CONDITION_USER_INSTRUCTION = "Bedöm skicket på kök och badrum enligt instruktionen.";

/**
 * What decides the meaning of a stored read: the prompt, the model id, the JSON schema (which carries the field
 * descriptions) and the logic revision. Same recipe as `layoutReadVersion`. Pure, so a test can change one part
 * and watch the hash move.
 */
export function soldConditionVersion(parts: { prompt: string; model: string; schema: unknown; revision: number }): string {
  return createHash("sha256")
    .update(JSON.stringify({ model: parts.model, prompt: parts.prompt, schema: parts.schema, logic: parts.revision }))
    .digest("hex")
    .slice(0, 16);
}

export const SOLD_CONDITION_VERSION: string = soldConditionVersion({
  prompt: `${SOLD_CONDITION_SYSTEM_PROMPT}\n${SOLD_CONDITION_USER_INSTRUCTION}`,
  model: SOLD_CONDITION_MODEL,
  schema: z.toJSONSchema(soldConditionSchema, { unrepresentable: "any" }),
  revision: SOLD_CONDITION_LOGIC_REVISION,
});

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

/** The image content block of the Messages API (a URL block; sold photos are never sent as bytes). */
export type SoldConditionImageBlock = FloorPlanImageBlock;

/**
 * The photo ids one read uses: digits only, in the order the page listed them, at most
 * {@link SOLD_CONDITION_MAX_IMAGES}. An id that is not digits only is dropped (T-14.4-33). Pure.
 */
export function soldConditionUsableIds(imageIds: readonly string[] | null | undefined): string[] {
  const ids: string[] = [];
  for (const id of imageIds ?? []) {
    if (ids.length >= SOLD_CONDITION_MAX_IMAGES) break;
    if (typeof id === "string" && /^\d+$/.test(id)) ids.push(id);
  }
  return ids;
}

/**
 * The URL blocks of one read: {@link soldConditionUsableIds} turned into bcdn.se URLs by `bcdnImageUrl` and
 * re-checked with `isAllowedImageHost` (a URL that fails the check is dropped, never sent). Pure.
 */
export function soldConditionImagesOf(imageIds: readonly string[] | null | undefined): SoldConditionImageBlock[] {
  const blocks: SoldConditionImageBlock[] = [];
  for (const id of soldConditionUsableIds(imageIds)) {
    const url = bcdnImageUrl(id);
    if (!isAllowedImageHost(url)) continue;
    blocks.push({ type: "image", source: { type: "url", url } });
  }
  return blocks;
}

/** Cache key of one read: the sold listing and the sorted ids the read used (order does not matter). */
export function soldConditionEntryId(booliId: string, usedIds: readonly string[]): string {
  const digest = createHash("sha256").update(JSON.stringify([...usedIds].sort())).digest("hex").slice(0, 16);
  return `booli:${booliId}|${digest}`;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const soldConditionCacheEntrySchema = z.object({
  id: z.string(),
  promptVersion: z.string(),
  storedAt: z.string(),
  costSek: z.number(),
  result: soldConditionSchema,
});

export const soldConditionCacheSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), soldConditionCacheEntrySchema),
  /**
   * Everything this read has ever paid, SEK, failed and dropped reads included. A LEDGER that IS enforced
   * (the 30 kr phase budget). Optional: a file written before this field existed reads as the sum of its reads.
   */
  spentSekTotal: z.number().min(0).optional(),
});

export type SoldConditionCache = z.infer<typeof soldConditionCacheSchema>;

const emptyCache = (): SoldConditionCache => ({ version: 1, entries: {} });

/**
 * Reads the cache. A missing file is an empty cache. A file that is not valid JSON or does not match the schema
 * is read as empty, a warning string is returned, and the bad file is renamed to `<path>.bak-<stamp>` so the next
 * save does not overwrite the evidence. Never throws.
 */
export function loadSoldConditionCache(
  path: string,
  opts: { now?: () => number } = {},
): { cache: SoldConditionCache; warning: string | null } {
  try {
    const raw = readJsonIfExists(path);
    if (raw === null) return { cache: emptyCache(), warning: null };
    const parsed = soldConditionCacheSchema.safeParse(raw);
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
    warning: `Skickcachen ${path} kunde inte läsas och lästes som tom${moved ? `; filen flyttades till ${aside}` : " (filen kunde inte flyttas)"}`,
  };
}

/** Writes the cache atomically. Refuses a path outside the data directory by throwing; `opts.dir` exists for tests. */
export function saveSoldConditionCache(path: string, cache: SoldConditionCache, opts: { dir?: string } = {}): void {
  const dir = opts.dir ?? SOLD_CONDITION_CACHE_DIR;
  const safe = guardedDataPath(path, { dir, ext: ".json" });
  if (safe === null) throw new Error(`Skickcachen får bara skrivas under ${dir}/ (fick ${path})`);
  writeJsonAtomic(safe, cache);
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/**
 * Thrown by the injected call when the model answered (so Anthropic charged for it) but the answer is unusable
 * (refusal, truncation, nothing parsed). Carries the money already billed, so the cap sees it. It extends
 * {@link FloorPlanCallError} so `asBilledFailure` of sun-floorplan.ts passes it through unchanged.
 */
export class SoldConditionCallError extends FloorPlanCallError {
  constructor(code: string, billedSek: number) {
    super(code, billedSek);
    this.name = "SoldConditionCallError";
  }
}

/** One model call on one sold flat's pictures; `costSek` is what Anthropic charged for it. */
export type SoldConditionCallFn = (
  blocks: SoldConditionImageBlock[],
) => Promise<{ result: SoldConditionRead; costSek: number }>;

/** Re-exported so the script's call can turn an SDK error into one the cap can see. */
export { asBilledFailure };

export type SoldConditionReadStatus = "read" | "cache" | "cost_cap" | "no_images" | "failed";

export interface SoldConditionItem {
  booliId: string;
  imageIds: readonly string[] | null | undefined;
}

export interface SoldConditionOutcome {
  booliId: string;
  status: SoldConditionReadStatus;
  /** What this run paid for this item (a cache hit is 0). */
  costSek: number;
  result: SoldConditionRead | null;
  /** How many pictures the read saw (0 when none was made). */
  images: number;
  /** Error NAME or code only, never a message (a message can carry a URL). */
  errorCode?: string;
}

export interface SoldConditionRunResult {
  /** Same length and order as the items. */
  reads: SoldConditionOutcome[];
  /** What THIS run paid, SEK. */
  spentSek: number;
  /** What the read has paid in all runs so far including this one, SEK (the number the cap is checked against). */
  totalSpentSek: number;
  /** Fresh model reads that came back usable. */
  calls: number;
  cacheHits: number;
  /** The loaded cache plus this run's new reads; entries of another version are dropped. Carries `spentSekTotal`. */
  cacheNext: SoldConditionCache;
}

const errorLabel = (error: unknown): string =>
  error instanceof FloorPlanCallError ? error.code : error instanceof Error ? error.name : "UNKNOWN";

const isMoney = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * Everything the read has paid before this run, SEK: the recorded total, or the sum of the stored reads' costs
 * when that is larger. Non-finite numbers count as 0.
 */
export function soldConditionSpentSek(cache: SoldConditionCache): number {
  const fromEntries = Object.values(cache.entries).reduce((sum, e) => sum + (isMoney(e.costSek) ? e.costSek : 0), 0);
  return Math.max(isMoney(cache.spentSekTotal) ? cache.spentSekTotal : 0, fromEntries);
}

/**
 * Reads the condition of each sold flat, within a LIFETIME ceiling and never paying twice.
 *
 *  - No usable photo id: "no_images", never handed to `call`.
 *  - A cache entry of the same sold listing, the same sorted ids AND the current version is a free hit: no call.
 *  - Before every call: when `paid before + spent so far + estimate > capSek` (strictly greater; equal is
 *    allowed) the item is "cost_cap" and no call is made. "Paid before" is what earlier runs spent
 *    ({@link soldConditionSpentSek}), so the cap is the cap of the whole phase, not of one run.
 *  - A call that comes back with a non-finite or non-positive cost is counted at the estimate.
 *  - A call that throws is "failed" with the error name only and the run goes on; money billed for an
 *    answered-and-failed call ({@link SoldConditionCallError}) still counts toward `spentSek`.
 *
 * Never throws because of one flat.
 */
export async function runSoldConditionReads(
  items: ReadonlyArray<SoldConditionItem>,
  opts: { call: SoldConditionCallFn; cache: SoldConditionCache; capSek: number; today: string; estSekPerFlat?: number },
): Promise<SoldConditionRunResult> {
  const estimate = opts.estSekPerFlat ?? SOLD_CONDITION_EST_SEK_PER_FLAT;
  const priorSek = soldConditionSpentSek(opts.cache);
  const capSek = Number.isFinite(opts.capSek) ? opts.capSek : 0;
  const reads: SoldConditionOutcome[] = [];
  const fresh = new Map<string, SoldConditionCache["entries"][string]>();
  let spentSek = 0;
  let calls = 0;
  let cacheHits = 0;

  for (const item of items) {
    const usedIds = soldConditionUsableIds(item.imageIds);
    const blocks = soldConditionImagesOf(item.imageIds);
    if (blocks.length === 0) {
      reads.push({ booliId: item.booliId, status: "no_images", costSek: 0, result: null, images: 0 });
      continue;
    }
    const id = soldConditionEntryId(item.booliId, usedIds);
    const hit = opts.cache.entries[id];
    if (hit && hit.promptVersion === SOLD_CONDITION_VERSION) {
      cacheHits += 1;
      reads.push({ booliId: item.booliId, status: "cache", costSek: 0, result: hit.result, images: blocks.length });
      continue;
    }
    // The 1e-9 only absorbs float noise from summing small SEK amounts: equal to the cap is allowed.
    if (priorSek + spentSek + estimate > capSek + 1e-9) {
      reads.push({ booliId: item.booliId, status: "cost_cap", costSek: 0, result: null, images: blocks.length });
      continue;
    }
    try {
      const { result, costSek } = await opts.call(blocks);
      const paid = isMoney(costSek) ? costSek : estimate;
      spentSek += paid;
      calls += 1;
      reads.push({ booliId: item.booliId, status: "read", costSek: paid, result, images: blocks.length });
      fresh.set(id, { id, promptVersion: SOLD_CONDITION_VERSION, storedAt: opts.today, costSek: paid, result });
    } catch (error) {
      const billed = error instanceof FloorPlanCallError && isMoney(error.billedSek) ? error.billedSek : 0;
      spentSek += billed;
      reads.push({
        booliId: item.booliId,
        status: "failed",
        costSek: billed,
        result: null,
        images: blocks.length,
        errorCode: errorLabel(error),
      });
    }
  }

  const entries: SoldConditionCache["entries"] = {};
  for (const [id, e] of Object.entries(opts.cache.entries)) {
    if (e.promptVersion === SOLD_CONDITION_VERSION) entries[id] = e;
  }
  for (const [id, e] of fresh) entries[id] = e;

  const totalSpentSek = priorSek + spentSek;
  return { reads, spentSek, totalSpentSek, calls, cacheHits, cacheNext: { version: 1, entries, spentSekTotal: totalSpentSek } };
}

// ---------------------------------------------------------------------------
// Coding a read, and the sample
// ---------------------------------------------------------------------------

/**
 * A read as the condition index of the bid-premium fit: dated -1, ok 0, fresh +1. A read below
 * {@link SOLD_CONDITION_MIN_CONFIDENCE} (or with a non-finite confidence) is `null`: EXCLUDED from the fit, never
 * coded as 0, because 0 would claim "ordinary condition" for a flat nobody could judge.
 */
export function conditionIndexOfRead(read: SoldConditionRead): -1 | 0 | 1 | null {
  if (!(Number.isFinite(read.confidence) && read.confidence >= SOLD_CONDITION_MIN_CONFIDENCE)) return null;
  return read.condition === "dated" ? -1 : read.condition === "fresh" ? 1 : 0;
}

/** True when the row can feed the condition fit: read under the v2 shape, at least one photo id, an asking price. */
export function isConditionEligible(row: SoldRow): boolean {
  return (
    row.enriched?.detailVersion === SOLD_DETAIL_VERSION &&
    (row.enriched.imageIds?.length ?? 0) > 0 &&
    row.askingPrice !== null &&
    row.askingPrice > 0
  );
}

/**
 * The rows of the condition read (D-12): from the eligible rows ({@link isConditionEligible}) a stratified hash
 * sample (district x size band) of `n`, seed {@link SOLD_CONDITION_SAMPLE_SEED}. Deterministic and independent of
 * input order; the input is untouched.
 */
export function selectConditionSample(rows: readonly SoldRow[], n: number = SOLD_CONDITION_SAMPLE_N): SoldRow[] {
  return stratifiedHashSample(rows.filter(isConditionEligible), n, SOLD_CONDITION_SAMPLE_SEED);
}

// ---------------------------------------------------------------------------
// The branch rule (R-08)
// ---------------------------------------------------------------------------

export interface SoldConditionBranch {
  branch: "fit" | "prior";
  /** Plain Swedish reason; empty for the fit branch. */
  reason: string;
}

/**
 * The R-08 rule, measured and not assumed: the condition term is FITTED only when at least
 * {@link SOLD_CONDITION_MIN_ELIGIBLE} sales have photo ids and an asking price AND the smoke read at least
 * {@link SOLD_CONDITION_SMOKE_MIN_READ} of {@link SOLD_CONDITION_SMOKE_N} sold flats successfully. Otherwise the
 * prior branch applies: the term is 0 and the premium says "skick ej mätt". `smoke` is null when no smoke has run.
 */
export function soldConditionBranch(input: {
  eligible: number;
  smoke: { attempted: number; read: number } | null;
}): SoldConditionBranch {
  if (input.eligible <= 0) return { branch: "prior", reason: "inga säljfoton" };
  if (input.eligible < SOLD_CONDITION_MIN_ELIGIBLE) {
    return { branch: "prior", reason: `för få säljfoton: ${input.eligible} rader, kräver ${SOLD_CONDITION_MIN_ELIGIBLE}` };
  }
  if (input.smoke === null) return { branch: "prior", reason: "smoketestet är inte körd" };
  if (input.smoke.read < SOLD_CONDITION_SMOKE_MIN_READ) {
    return {
      branch: "prior",
      reason: `smoketestet läste ${input.smoke.read} av ${SOLD_CONDITION_SMOKE_N} säljbilder, kräver ${SOLD_CONDITION_SMOKE_MIN_READ}`,
    };
  }
  return { branch: "fit", reason: "" };
}
