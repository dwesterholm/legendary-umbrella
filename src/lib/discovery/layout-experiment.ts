/**
 * layout-experiment.ts - the layout experiments of Phase 14.5 (LAYACC-02, D-10, R-04): variant specs, one
 * cache file per variant, the runner and the stored-answer-to-fact mapping.
 *
 * The question: which way of reading a flat's plan and photos is right often enough to be believed? D-10 fixes the
 * contenders before any result exists, so nothing is tuned on the truth set: a = today's prompt on Sonnet (the
 * baseline), b = a reworked prompt with explicit evidence rules and per-field certainty on Sonnet, c = the same
 * prompt on the Opus tier, d = a two-step read (plan only, then photos only) combined in code.
 *
 * Why a SEPARATE runner and cache per variant: `runLayoutReads` (layout-read.ts) keys its cache ids on the module
 * constant `LAYOUT_READ_VERSION` and, when it saves, keeps only entries of that one version. Running a second
 * prompt through it with the production cache path would delete the stored production reads (Pitfall 3, T-14.5-20).
 * A variant therefore carries its own version (a hash of its prompts, model, schema, call shape and image policy) and
 * its own file `.planning/calibration/data/layout-exp-<id>.json`. Nothing here reads, rewrites or deletes the
 * production `layout-cache.json`; {@link saveVariantCache} refuses that path and any file that is not a
 * `layout-exp-<id>.json` inside the data directory.
 *
 * Pictures (Pitfall 8): every variant, the baseline included, reads the Booli pictures only (the plan and three
 * photos). Broker photos exist only as bytes in memory during a weekly run and cannot be replayed, so a comparable
 * round cannot use them. Production adds up to three broker photos on top; the report must say so.
 *
 * Script-side only. The model call is INJECTED ({@link VariantCallFn}); this module never imports the SDK (only
 * layout-call.ts does), so its tests need no network and no key. Only enums, numbers and ids are cached, never a
 * picture or a URL.
 *
 * STRUCTURAL SEPARATION (LOCKED): `niche-score.ts` and `report/flags.ts` must never import it.
 */
import { resolve, basename } from "node:path";
import { z } from "zod/v4";
import type { BrokerImageBytes } from "@/lib/broker/broker-images";
import { guardedDataPath, readJsonIfExists, writeJsonAtomic } from "@/lib/discovery/json-store";
import {
  ACCURACY_FIELDS,
  formatPrecision,
  type AccuracyField,
  type AccuracyReport,
  type Precision,
} from "@/lib/discovery/layout-accuracy";
import type { LayoutFact } from "@/lib/discovery/layout-fact";
import {
  LAYOUT_CACHE_DIR,
  LAYOUT_CACHE_PATH,
  LAYOUT_LOGIC_REVISION,
  LAYOUT_MAX_BOOLI_PHOTOS,
  LAYOUT_MAX_TOKENS,
  LAYOUT_MODEL,
  LAYOUT_OPUS_MODEL,
  LAYOUT_SYSTEM_PROMPT,
  LAYOUT_SYSTEM_PROMPT_V2,
  LAYOUT_USER_INSTRUCTION,
  LAYOUT_USER_INSTRUCTION_V2,
  layoutBlockUrls,
  layoutFactFromRead,
  layoutImagesOf,
  layoutReadSchema,
  layoutReadSchemaV2,
  layoutReadVersion,
  type LayoutImageBlock,
  type LayoutReadStatus,
} from "@/lib/discovery/layout-read";
import { FloorPlanCallError, formatSek } from "@/lib/discovery/sun-floorplan";
import { imageSetKey, visionListingKey } from "@/lib/discovery/vision-cache";

/** The most one paid round may spend, SEK (D-13, R-05). Enforced on real usage at the model's own rates. */
export const LAYOUT_ROUND_CAP_SEK = 40;
/** The most one live smoke may spend, SEK (R-05). */
export const LAYOUT_SMOKE_CAP_SEK = 1;

// ---------------------------------------------------------------------------
// The variant spec
// ---------------------------------------------------------------------------

/** A reasoning effort the API accepts on the Opus tier; null = the parameter is not sent. */
export type VariantEffort = "low" | "medium" | null;

/**
 * Everything that decides what one experiment reads and what it means: the model, the prompts, the strict-output
 * schema, the call shape (temperature, effort, max tokens, one or two steps) and the image policy.
 */
export interface LayoutVariantSpec {
  /** "a", "b", "c", "d-sonnet" or "d-opus": the file name part and the report name. */
  id: string;
  /** A short Swedish label for the printed line. */
  label: string;
  model: string;
  systemPrompt: string;
  userInstruction: string;
  /** The strict-output schema of the (final) answer. For a two-step variant it is the combined answer. */
  schema: z.ZodType;
  /** Sampling temperature, or null when the model rejects the parameter (Opus 5.5, Pitfall 5). */
  temperature: number | null;
  effort: VariantEffort;
  maxTokens: number;
  steps: 1 | 2;
  /** The pictures a read uses: the plan plus up to `maxBooliPhotos` Booli photos; never a broker photo (Pitfall 8). */
  images: { maxBooliPhotos: number; maxBrokerPhotos: 0 };
  /** What one read is assumed to cost before it is made, SEK. Checked against the round cap before every call. */
  estSekPerFlat: number;
  /** Set on a two-step variant (plan 05 task 3): the two step prompts and schemas. */
  twoStep?: {
    stepA: { systemPrompt: string; userInstruction: string; schema: z.ZodType };
    stepB: { systemPrompt: string; userInstruction: string; schema: z.ZodType };
  };
}

/**
 * The variants, written down before any paid call (D-10, T-14.5-19). Variant a is built from the production
 * constants of layout-read.ts, and an invariant test pins that, so the weekly read already is "variant a" apart
 * from its image policy (production adds broker photos).
 */
export const LAYOUT_VARIANTS: Readonly<Record<string, LayoutVariantSpec>> = {
  a: {
    id: "a",
    label: "dagens prompt på Sonnet",
    model: LAYOUT_MODEL,
    systemPrompt: LAYOUT_SYSTEM_PROMPT,
    userInstruction: LAYOUT_USER_INSTRUCTION,
    schema: layoutReadSchema,
    temperature: 0,
    effort: null,
    maxTokens: LAYOUT_MAX_TOKENS,
    steps: 1,
    images: { maxBooliPhotos: LAYOUT_MAX_BOOLI_PHOTOS, maxBrokerPhotos: 0 },
    estSekPerFlat: 0.35,
  },
  b: {
    id: "b",
    label: "omarbetad prompt med bevisregler och säkerhet per fält på Sonnet",
    model: LAYOUT_MODEL,
    systemPrompt: LAYOUT_SYSTEM_PROMPT_V2,
    userInstruction: LAYOUT_USER_INSTRUCTION_V2,
    schema: layoutReadSchemaV2,
    temperature: 0,
    effort: null,
    maxTokens: 600,
    steps: 1,
    images: { maxBooliPhotos: LAYOUT_MAX_BOOLI_PHOTOS, maxBrokerPhotos: 0 },
    estSekPerFlat: 0.4,
  },
  c: {
    id: "c",
    label: "samma prompt som b på Opus-nivån",
    model: LAYOUT_OPUS_MODEL,
    systemPrompt: LAYOUT_SYSTEM_PROMPT_V2,
    userInstruction: LAYOUT_USER_INSTRUCTION_V2,
    schema: layoutReadSchemaV2,
    // Opus 5.5 rejects temperature (HTTP 400) and always thinks; effort low keeps the thinking short (Pitfall 5).
    temperature: null,
    effort: "low",
    maxTokens: 4000,
    steps: 1,
    images: { maxBooliPhotos: LAYOUT_MAX_BOOLI_PHOTOS, maxBrokerPhotos: 0 },
    estSekPerFlat: 1.0,
  },
};

/** Every variant id in the fixed order of D-10; slot d is d-sonnet or d-opus. */
export const LAYOUT_VARIANT_IDS = ["a", "b", "c", "d-sonnet", "d-opus"] as const;

/** The schema the stored answer must parse as: the final answer for one step, both step answers for two. */
export function storedSchemaOf(spec: LayoutVariantSpec): z.ZodType {
  if (spec.steps === 2 && spec.twoStep !== undefined) {
    return z.object({ stepA: spec.twoStep.stepA.schema, stepB: spec.twoStep.stepB.schema.nullable() });
  }
  return spec.schema;
}

/**
 * The version of a variant: a hash of its model, prompts, schema, call shape and image policy plus the logic
 * revision. Same recipe as {@link layoutReadVersion}; the image policy and call shape are part of the prompt part,
 * so changing any of them re-keys the variant's cache (and none of the production cache). Pure.
 */
export function variantVersion(spec: LayoutVariantSpec): string {
  const stepSchemas =
    spec.twoStep === undefined
      ? null
      : {
          a: z.toJSONSchema(spec.twoStep.stepA.schema, { unrepresentable: "any" }),
          b: z.toJSONSchema(spec.twoStep.stepB.schema, { unrepresentable: "any" }),
        };
  return layoutReadVersion({
    prompt: JSON.stringify({
      variant: spec.id,
      system: spec.systemPrompt,
      user: spec.userInstruction,
      images: spec.images,
      temperature: spec.temperature,
      effort: spec.effort,
      maxTokens: spec.maxTokens,
      steps: spec.steps,
      twoStep:
        spec.twoStep === undefined
          ? null
          : {
              aSystem: spec.twoStep.stepA.systemPrompt,
              aUser: spec.twoStep.stepA.userInstruction,
              bSystem: spec.twoStep.stepB.systemPrompt,
              bUser: spec.twoStep.stepB.userInstruction,
              schemas: stepSchemas,
            },
    }),
    model: spec.model,
    schema: z.toJSONSchema(spec.schema, { unrepresentable: "any" }),
    revision: LAYOUT_LOGIC_REVISION,
  });
}

// ---------------------------------------------------------------------------
// One cache file per variant
// ---------------------------------------------------------------------------

const VARIANT_ID_RE = /^[a-z0-9-]+$/;
const VARIANT_FILE_RE = /^layout-exp-[a-z0-9-]+\.json$/;

/** `.planning/calibration/data/layout-exp-<id>.json`. Throws on an id that is not lower-case letters, digits and hyphens. */
export function layoutVariantCachePath(id: string): string {
  if (!VARIANT_ID_RE.test(id)) throw new Error(`Ogiltigt variant-id: ${id}`);
  return `${LAYOUT_CACHE_DIR}/layout-exp-${id}.json`;
}

const variantCacheEntrySchema = z.object({
  id: z.string(),
  storedAt: z.string(),
  costSek: z.number(),
  result: z.unknown(),
});

const variantCacheFileSchema = z.object({
  version: z.literal(1),
  variantId: z.string(),
  variantVersion: z.string(),
  entries: z.record(z.string(), variantCacheEntrySchema),
  /** Everything this variant has ever paid, SEK: reads, billed failures and smokes. A ledger, never a cap. */
  spentSekTotal: z.number().min(0),
});

export type VariantCache = z.infer<typeof variantCacheFileSchema>;
export type VariantCacheEntry = VariantCache["entries"][string];

const emptyVariantCache = (spec: LayoutVariantSpec, spentSekTotal = 0): VariantCache => ({
  version: 1,
  variantId: spec.id,
  variantVersion: variantVersion(spec),
  entries: {},
  spentSekTotal,
});

export interface LoadedVariantCache {
  cache: VariantCache;
  /** Entries dropped because their answer fails the spec's schema, or the whole file was written for another version. */
  dropped: number;
  /** True when the file exists but could not be read or parsed. The file is NOT renamed; a caller must not save over it. */
  unreadable: boolean;
  warning: string | null;
}

/**
 * Reads a variant cache. A missing file is an empty cache. A file written for another variant version keeps its
 * ledger but none of its entries (their ids are keyed on the old version). An entry whose stored answer fails the spec's
 * schema is dropped and counted. A file that is not valid JSON or has the wrong shape reads as empty with
 * `unreadable` true; in no case is a file renamed or deleted. Never throws.
 */
export function loadVariantCache(path: string, spec: LayoutVariantSpec): LoadedVariantCache {
  let raw: unknown;
  try {
    raw = readJsonIfExists(path);
  } catch {
    return { cache: emptyVariantCache(spec), dropped: 0, unreadable: true, warning: `Variantcachen ${path} kunde inte läsas och lästes som tom; filen rörs inte` };
  }
  if (raw === null) return { cache: emptyVariantCache(spec), dropped: 0, unreadable: false, warning: null };
  const parsed = variantCacheFileSchema.safeParse(raw);
  if (!parsed.success) {
    return { cache: emptyVariantCache(spec), dropped: 0, unreadable: true, warning: `Variantcachen ${path} har fel form och lästes som tom; filen rörs inte` };
  }
  const file = parsed.data;
  const version = variantVersion(spec);
  if (file.variantId !== spec.id || file.variantVersion !== version) {
    const dropped = Object.keys(file.entries).length;
    return {
      cache: emptyVariantCache(spec, file.spentSekTotal),
      dropped,
      unreadable: false,
      warning: dropped > 0 ? `Variantcachen ${path} gäller en annan version av variant ${spec.id}; ${dropped} lagrade läsningar används inte` : null,
    };
  }
  const schema = storedSchemaOf(spec);
  const entries: VariantCache["entries"] = {};
  let dropped = 0;
  for (const [id, entry] of Object.entries(file.entries)) {
    const result = schema.safeParse(entry.result);
    if (result.success) entries[id] = { ...entry, result: result.data };
    else dropped += 1;
  }
  return {
    cache: { ...file, entries },
    dropped,
    unreadable: false,
    warning: dropped > 0 ? `${dropped} lagrade läsningar i ${path} passar inte schemat och används inte` : null,
  };
}

/**
 * Writes a variant cache atomically. Refuses (by throwing) the production layout cache, a path outside the data
 * directory (`opts.dir` exists for tests), and any file name that is not `layout-exp-<id>.json`, so an experiment can
 * never overwrite the production cache, the sold-price cache or a report.
 */
export function saveVariantCache(path: string, cache: VariantCache, opts: { dir?: string } = {}): void {
  const dir = opts.dir ?? LAYOUT_CACHE_DIR;
  if (resolve(path) === resolve(LAYOUT_CACHE_PATH)) throw new Error("Variantcachen får aldrig skrivas till produktionscachen");
  if (!VARIANT_FILE_RE.test(basename(path))) throw new Error(`Variantcachen måste heta layout-exp-<id>.json (fick ${basename(path)})`);
  const safe = guardedDataPath(path, { dir, ext: ".json" });
  if (safe === null) throw new Error(`Variantcachen får bara skrivas under ${dir}/ (fick ${path})`);
  writeJsonAtomic(safe, cache);
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/** One flat to read: its Booli id, listing path and picture URLs (the plan is image 1). */
export interface VariantReadItem {
  booliId: number;
  listingPath: string;
  imageUrls: readonly string[] | null;
  /** The plan as bytes instead of image 1 (the smoke uses it for the committed synthetic plan). */
  planImage?: BrokerImageBytes;
}

/** One model read on one flat's pictures; `costSek` is what Anthropic charged (both steps summed for a two-step variant). */
export type VariantCallFn = (blocks: LayoutImageBlock[]) => Promise<{ result: unknown; costSek: number }>;

export interface VariantReadOutcome {
  booliId: number;
  listingPath: string;
  status: LayoutReadStatus;
  /** What this run paid for this item (a cache hit is 0). */
  costSek: number;
  /** The stored answer (parsed), or null when none was made. */
  result: unknown;
  /** The answer as a stored fact, or null when there is none. */
  fact: LayoutFact | null;
  /** How many Booli pictures the read saw; broker pictures are never sent. */
  images: { booli: number; broker: 0 };
  /** Error NAME or code only, never a message (a message can carry a URL). */
  errorCode?: string;
}

export interface VariantRunResult {
  /** Same length and order as the items. */
  reads: VariantReadOutcome[];
  /** What THIS run paid, SEK. */
  spentSek: number;
  /** What the variant has paid in all runs so far including this one, SEK. A printed ledger, never a limit. */
  totalSpentSek: number;
  /** Fresh reads that came back usable. */
  calls: number;
  cacheHits: number;
  /** The loaded cache plus this run's new reads, with the ledger. */
  cacheNext: VariantCache;
}

const isMoney = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

const errorLabel = (error: unknown): string =>
  error instanceof FloorPlanCallError ? error.code : error instanceof Error ? error.name : "UNKNOWN";

/** Everything a variant has paid before this run: the recorded total, or the sum of its stored reads when larger. */
export function variantSpentSek(cache: VariantCache): number {
  const fromEntries = Object.values(cache.entries).reduce((sum, e) => sum + (isMoney(e.costSek) ? e.costSek : 0), 0);
  return Math.max(isMoney(cache.spentSekTotal) ? cache.spentSekTotal : 0, fromEntries);
}

/** The pictures a variant uses for one item (Booli only, no broker photo). */
export function variantImagesOf(spec: LayoutVariantSpec, item: VariantReadItem) {
  return layoutImagesOf(item.imageUrls, [], {
    maxBooliPhotos: spec.images.maxBooliPhotos,
    ...(item.planImage ? { planImage: item.planImage } : {}),
  });
}

/**
 * The cache id of one item under one variant: `booli:<id>|<imageSetKey>` keyed on the picture URLs and the variant
 * version, or null when no read can be made (image 1 off the host allowlist, or no image 1). Pure.
 */
export function variantReadId(spec: LayoutVariantSpec, item: VariantReadItem): string | null {
  const images = variantImagesOf(spec, item);
  if (images.status !== "ok") return null;
  return `${visionListingKey(item.listingPath)}|${imageSetKey(layoutBlockUrls(images.blocks), 0, variantVersion(spec))}`;
}

/**
 * Reads each item under `variant`, within a per-run ceiling and never paying twice. Copied from `runLayoutReads` and
 * parameterised: the id and the cache use the variant's version, broker photos are never sent, and the production
 * cache is never an input.
 *
 *  - Image 1 off the host allowlist: "host", never handed to `call` (SSRF). No image 1: "no_plan".
 *  - A cache entry of the same listing, the same picture set and this variant's version is a free hit.
 *  - Before every call: when `spent this run + estimate > runCapSek` (strictly greater; equal is allowed, with 1e-9
 *    slack for float noise) the item is "cost_cap" and no call is made.
 *  - A call that comes back with a non-finite or non-positive cost is counted at the estimate.
 *  - A call that throws is "failed" with the error name only and the run goes on; money billed for an
 *    answered-and-failed call (`LayoutCallError`) still counts. An answer that does not parse as the variant's
 *    schema is "failed" ("BAD_ANSWER") and its money counts.
 *
 * Never throws because of one flat.
 */
export async function runVariantReads(
  items: ReadonlyArray<VariantReadItem>,
  opts: {
    variant: LayoutVariantSpec;
    call: VariantCallFn;
    cache: VariantCache;
    runCapSek: number;
    today: string;
    /** Replaces the spec's estimate for the cap test (the smoke uses a lower one so two reads fit under 1 kr). */
    estSekPerFlat?: number;
    /**
     * Called with the cache as it stands after every PAID call (a usable read or a billed failure), so the caller can save
     * it right away: a crash or an interrupt later in the run then costs nothing already paid for (R-05).
     */
    checkpoint?: (cache: VariantCache) => void;
  },
): Promise<VariantRunResult> {
  const spec = opts.variant;
  const version = variantVersion(spec);
  const schema = storedSchemaOf(spec);
  const estimate = isMoney(opts.estSekPerFlat) ? opts.estSekPerFlat : spec.estSekPerFlat;
  const priorSek = variantSpentSek(opts.cache);
  const runCapSek = Number.isFinite(opts.runCapSek) ? opts.runCapSek : 0;
  const reads: VariantReadOutcome[] = [];
  const fresh = new Map<string, VariantCacheEntry>();
  let spentSek = 0;
  let calls = 0;
  let cacheHits = 0;
  const cacheNow = (): VariantCache => ({
    version: 1,
    variantId: spec.id,
    variantVersion: version,
    entries: { ...opts.cache.entries, ...Object.fromEntries(fresh) },
    spentSekTotal: priorSek + spentSek,
  });

  for (const item of items) {
    const images = variantImagesOf(spec, item);
    const seen = { booli: images.booli, broker: 0 as const };
    const base = { booliId: item.booliId, listingPath: item.listingPath };
    if (images.status !== "ok") {
      reads.push({ ...base, status: images.status, costSek: 0, result: null, fact: null, images: seen });
      continue;
    }
    const id = `${visionListingKey(item.listingPath)}|${imageSetKey(layoutBlockUrls(images.blocks), 0, version)}`;
    const hit = opts.cache.entries[id];
    if (hit && schema.safeParse(hit.result).success) {
      cacheHits += 1;
      reads.push({ ...base, status: "cache", costSek: 0, result: hit.result, fact: factFromVariantRead(spec, hit.result, seen), images: seen });
      continue;
    }
    if (spentSek + estimate > runCapSek + 1e-9) {
      reads.push({ ...base, status: "cost_cap", costSek: 0, result: null, fact: null, images: seen });
      continue;
    }
    try {
      const { result: raw, costSek } = await opts.call(images.blocks);
      const paid = isMoney(costSek) ? costSek : estimate;
      spentSek += paid;
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        reads.push({ ...base, status: "failed", costSek: paid, result: null, fact: null, images: seen, errorCode: "BAD_ANSWER" });
        opts.checkpoint?.(cacheNow());
        continue;
      }
      calls += 1;
      reads.push({ ...base, status: "read", costSek: paid, result: parsed.data, fact: factFromVariantRead(spec, parsed.data, seen), images: seen });
      fresh.set(id, { id, storedAt: opts.today, costSek: paid, result: parsed.data });
      opts.checkpoint?.(cacheNow());
    } catch (error) {
      const billed = error instanceof FloorPlanCallError && isMoney(error.billedSek) ? error.billedSek : 0;
      spentSek += billed;
      reads.push({ ...base, status: "failed", costSek: billed, result: null, fact: null, images: seen, errorCode: errorLabel(error) });
      if (billed > 0) opts.checkpoint?.(cacheNow());
    }
  }

  const cacheNext = cacheNow();
  return { reads, spentSek, totalSpentSek: priorSek + spentSek, calls, cacheHits, cacheNext };
}

// ---------------------------------------------------------------------------
// Stored answer -> stored fact
// ---------------------------------------------------------------------------

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * The stored fact of one variant's answer: the version is the variant's, the pictures are the Booli ones it saw,
 * and the gate that decides whether it is believed stays in layout-fact.ts (`believedLayout`). A V2 answer also fills
 * `fieldConfidence` (each certainty clamped to 0..1) and `planPresent`; a variant a answer fills neither, so
 * `believedLayout` falls back to the single `confidence`. Throws on an answer that does not parse as the variant's
 * schema.
 */
export function factFromVariantRead(
  spec: LayoutVariantSpec,
  result: unknown,
  meta: { booli: number; broker?: number },
): LayoutFact {
  const answer = spec.schema.parse(result) as Record<string, unknown>;
  const fact = layoutFactFromRead(layoutReadSchema.parse(answer), {
    version: variantVersion(spec),
    booli: meta.booli,
    broker: meta.broker ?? 0,
  });
  if (typeof answer.planPresent === "boolean") fact.planPresent = answer.planPresent;
  const { balconyConfidence, windowsConfidence, bedroomConfidence } = answer;
  if (typeof balconyConfidence === "number" && typeof windowsConfidence === "number" && typeof bedroomConfidence === "number") {
    fact.fieldConfidence = {
      balcony: clamp01(balconyConfidence),
      windows: clamp01(windowsConfidence),
      bedroom: clamp01(bedroomConfidence),
    };
  }
  return fact;
}

// ---------------------------------------------------------------------------
// The rounds: which variant to run next, and who won
// ---------------------------------------------------------------------------

/** The four slots of D-10 in their fixed order; slot d is whichever two-step variant (Sonnet or Opus tier) has a report. */
export const LAYOUT_ROUND_SLOTS = ["a", "b", "c", "d"] as const;
export type RoundSlot = (typeof LAYOUT_ROUND_SLOTS)[number];
export type TwoStepTier = "sonnet" | "opus";

const FIELD_NAME: Record<AccuracyField, string> = { balcony: "Balkongsida", korsdrag: "Korsdrag", bedroom: "Sovrumssida" };

export interface RoundFieldResult {
  pass: boolean;
  gate: number | null;
  holdout: Precision | null;
  reason: string | null;
}

export interface RoundRow {
  slot: RoundSlot;
  /** The variant id of the row: a, b, c, d-sonnet or d-opus (for an unrun slot d, the tier the rule picked). */
  variant: string;
  /** "run" = a report exists; "skipped" = not run because a winner was found earlier; "not_run" = not run yet. */
  status: "run" | "skipped" | "not_run";
  /** What the variant has paid in all its runs and smokes, SEK (its cache's spentSekTotal). */
  spentSek: number;
  fields: Record<AccuracyField, RoundFieldResult> | null;
  pass: boolean | null;
}

export interface BestHoldout {
  variant: string;
  holdout: Precision;
  pass: boolean;
  reason: string | null;
}

export interface RoundsDecision {
  rounds: RoundRow[];
  /** The first variant, in the fixed order, whose report passes all three fields; null when none does. */
  winner: string | null;
  /** True once a winner exists: later variants are not run (D-10: stop at the first that reaches the bar). */
  stop: boolean;
  /** The next variant to run, or null when there is a winner or every slot has a report. */
  next: string | null;
  /** The tier the two-step variant runs on, by {@link pickTwoStepTier}. */
  tierForD: TwoStepTier;
  /** Per field, the best holdout precision any run reached (the most right, then the most believed answers), or null. */
  bestByField: Record<AccuracyField, BestHoldout | null>;
  totalSpentSek: number;
}

const finiteMoney = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

/** Mean dev precision over the report's measurable fields; a field with no believed dev answer counts as 0. Null with no measurable field. */
function meanDevPrecision(report: AccuracyReport): number | null {
  const measurable = ACCURACY_FIELDS.filter((f) => report.measurability[f].measurable);
  if (measurable.length === 0) return null;
  const sum = measurable.reduce((acc, f) => {
    const dev = report.fields[f].dev;
    return acc + (dev !== null && dev.n > 0 ? dev.k / dev.n : 0);
  }, 0);
  return sum / measurable.length;
}

/**
 * The tier of the two-step read (variant d), by a rule fixed before any round runs: the tier whose single-step variant
 * (b on Sonnet, c on Opus) has the higher mean dev precision over its measurable fields. A tie, a missing report or no
 * measurable field picks Sonnet, the cheaper one. Pure.
 */
export function pickTwoStepTier(reportB: AccuracyReport | undefined | null, reportC: AccuracyReport | undefined | null): TwoStepTier {
  if (!reportB || !reportC) return "sonnet";
  const b = meanDevPrecision(reportB);
  const c = meanDevPrecision(reportC);
  if (b === null || c === null) return "sonnet";
  return c > b + 1e-9 ? "opus" : "sonnet";
}

/**
 * Where the rounds stand (D-10): the variants in the fixed order a, b, c, d, the first whose report passes all three
 * fields wins, and the rounds stop there. `reports` is keyed by variant id (d meaning d-sonnet or d-opus, whichever
 * has a report; if both do, the one {@link pickTwoStepTier} chooses); `spentByVariant` by variant id, each value a
 * variant cache's `spentSekTotal`, smokes included. Pure.
 */
export function decideRounds(
  reports: Readonly<Record<string, AccuracyReport | undefined>>,
  spentByVariant: Readonly<Record<string, number>>,
): RoundsDecision {
  const tierForD = pickTwoStepTier(reports.b, reports.c);
  const dId = (["d-sonnet", "d-opus"] as const).filter((id) => reports[id] !== undefined);
  const dVariant = dId.length === 0 ? `d-${tierForD}` : dId.length === 1 ? dId[0] : `d-${tierForD}`;
  const idOf = (slot: RoundSlot): string => (slot === "d" ? dVariant : slot);

  let winner: string | null = null;
  for (const slot of LAYOUT_ROUND_SLOTS) {
    const report = reports[idOf(slot)];
    if (report !== undefined && report.pass) {
      winner = idOf(slot);
      break;
    }
  }

  const rounds: RoundRow[] = LAYOUT_ROUND_SLOTS.map((slot) => {
    const variant = idOf(slot);
    const report = reports[variant];
    const spentSek = finiteMoney(spentByVariant[variant]);
    if (report === undefined) {
      return { slot, variant, status: winner !== null ? "skipped" : "not_run", spentSek, fields: null, pass: null } satisfies RoundRow;
    }
    const fields = Object.fromEntries(
      ACCURACY_FIELDS.map((f) => [f, { pass: report.fields[f].pass, gate: report.fields[f].gate, holdout: report.fields[f].holdout, reason: report.fields[f].reason }]),
    ) as Record<AccuracyField, RoundFieldResult>;
    return { slot, variant, status: "run", spentSek, fields, pass: report.pass } satisfies RoundRow;
  });

  const bestByField = Object.fromEntries(
    ACCURACY_FIELDS.map((field) => {
      let best: BestHoldout | null = null;
      for (const row of rounds) {
        const holdout = row.fields?.[field].holdout ?? null;
        if (row.fields === null || holdout === null || holdout.n === 0) continue;
        const rate = holdout.k / holdout.n;
        const bestRate = best === null ? -1 : best.holdout.k / best.holdout.n;
        if (best === null || rate > bestRate + 1e-9 || (Math.abs(rate - bestRate) <= 1e-9 && holdout.n > best.holdout.n)) {
          best = { variant: row.variant, holdout, pass: row.fields[field].pass, reason: row.fields[field].reason };
        }
      }
      return [field, best];
    }),
  ) as Record<AccuracyField, BestHoldout | null>;

  const next = winner !== null ? null : (rounds.find((r) => r.status === "not_run")?.variant ?? null);
  const totalSpentSek = Object.values(spentByVariant).reduce<number>((sum, v) => sum + finiteMoney(v), 0);
  return { rounds, winner, stop: winner !== null, next, tierForD, bestByField, totalSpentSek };
}

const yesNo = (pass: boolean | undefined): string => (pass === undefined ? "-" : pass ? "ja" : "nej");

/**
 * The decision as Swedish markdown: one table row per variant in the fixed order (run, skipped by the stop rule, or not
 * run yet), then the verdict: the winner or "ingen", for each field the best holdout precision reached with its interval,
 * its believed-call count and variant, the rule that failed when it failed, and the total spend in kronor. Pure.
 */
export function renderRoundsMd(decision: RoundsDecision): string {
  const out: string[] = [];
  out.push("# Omgångar för layoutläsningen");
  out.push("");
  out.push("Varianterna körs i fast ordning och omgångarna stoppas vid den första som klarar alla tre fälten.");
  out.push("");
  out.push("| Variant | Status | Kostnad (kr) | Balkongsida | Korsdrag | Sovrumssida | Alla tre |");
  out.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const row of decision.rounds) {
    const status =
      row.status === "run"
        ? "körd"
        : row.status === "skipped"
          ? `hoppas över: stoppregeln, vinnare ${decision.winner ?? "-"}`
          : decision.next === row.variant
            ? "nästa att köra"
            : "inte körd ännu";
    out.push(
      `| ${row.variant} | ${status} | ${formatSek(row.spentSek)} | ${yesNo(row.fields?.balcony.pass)} | ${yesNo(row.fields?.korsdrag.pass)} | ${yesNo(row.fields?.bedroom.pass)} | ${yesNo(row.pass ?? undefined)} |`,
    );
  }
  out.push("");
  out.push("## Utslag");
  out.push("");
  out.push(`Vinnare: ${decision.winner ?? "ingen"}`);
  out.push("");
  out.push(`Tvåstegsläsningen (d) körs på nivån ${decision.tierForD === "opus" ? "Opus" : "Sonnet"} (regel: den nivå vars enstegsvariant hade högst medelprecision på dev över de mätbara fälten; lika eller saknade data ger Sonnet).`);
  out.push("");
  for (const field of ACCURACY_FIELDS) {
    const best = decision.bestByField[field];
    if (best === null) {
      out.push(`- ${FIELD_NAME[field]}: ingen variant gav någon holdout-precision (ingen spärr nåddes eller ingen körd variant).`);
      continue;
    }
    const tail = best.pass ? "fältet klarar kraven i den varianten" : `regeln som brast: ${best.reason ?? "okänd"}`;
    out.push(`- ${FIELD_NAME[field]}: bästa holdout-precision ${formatPrecision(best.holdout)} med ${best.holdout.n} trodda svar, variant ${best.variant}; ${tail}.`);
  }
  out.push("");
  out.push(`Total kostnad för alla varianter: ${formatSek(decision.totalSpentSek)} kr.`);
  return `${out.join("\n")}\n`;
}
