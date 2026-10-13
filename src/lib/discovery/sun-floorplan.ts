/**
 * sun-floorplan.ts - the floor-plan compass probe (Phase 14.3, R-01, R-09, SUN-02).
 *
 * The question: do broker floor plans carry a compass? The research looked at all 69 first
 * pictures of the snapshot by eye and found a north arrow on none of them (and an arrow at the
 * front door on many, which a model could take for north). This module lets a small model
 * measure it, for at most 2 kr, and records the verdict: the route stays closed unless at
 * least 10 % of the floor plans show a compass. If it opens, plan 07 wires cached reads into
 * the precedence order and plan 08 may run the same read over all candidates within the D-09
 * 30 kr ceiling (R-09). If it stays closed, the balcony side stays unknown.
 *
 * Why a SEPARATE call with its own schema and its own cache: `VISION_PROMPT_VERSION`
 * (vision-cache.ts) is a hash of both vision prompts, both model ids, the vision schemas and a
 * logic revision. Adding one field to the existing schema re-keys all 77 cached reads and
 * re-bills about 33 kr. So the existing vision schema, prompts and cache are not touched; this
 * file has its own cache file (`floorplan-cache.json`, gitignored with the data directory)
 * keyed by the picture id and {@link FLOORPLAN_PROBE_VERSION}.
 *
 * Strict-output limits (memory anthropic-structured-output-limits): the schema is five flat
 * fields (two booleans, two numbers, one enum), with no nullable value, no union and no numeric
 * constraint. Unit tests cannot prove the grammar compiles; the live smoke in
 * `scripts/sun-floorplan-probe.ts` does (RUN_LLM_EVALS=1).
 *
 * Script-side only. The model call is INJECTED (`call`), exactly like `runPass` in
 * vision-cache.ts, so this module never loads the Anthropic client and tests need no network
 * and no key. GDPR: only the five read fields are cached, never the picture.
 *
 * The decision is written here by hand after the real probe: see {@link FLOORPLAN_ROUTE_ENABLED}
 * and {@link FLOORPLAN_PROBE_SUMMARY}; the numbers live in
 * `.planning/phases/14.3-sun-orientation-spike/evidence/floorplan-probe.json`.
 *
 * STRUCTURAL SEPARATION (LOCKED): `niche-score.ts` and `report/flags.ts` must never import it.
 */
import { createHash } from "node:crypto";
import { renameSync } from "node:fs";
import { z } from "zod/v4";
import { isAllowedImageHost } from "@/lib/booli/image-host";
import { guardedDataPath, readJsonIfExists, writeJsonAtomic } from "@/lib/discovery/json-store";
import { VISION_HAIKU_MODEL } from "@/lib/discovery/vision-prompt";

/** The model of the probe: the cheap Haiku tier, the same id the vision pre-filter uses. */
export const FLOORPLAN_MODEL = VISION_HAIKU_MODEL;

/** Bump when code that is not text (the confidence gate, the bearing maths) changes what a stored read means. */
export const FLOORPLAN_LOGIC_REVISION = 1;

/** The cache file. Gitignored (the whole data directory is). */
export const FLOORPLAN_CACHE_PATH = ".planning/calibration/data/floorplan-cache.json";
/** The only directory the cache may be written to. */
export const FLOORPLAN_CACHE_DIR = ".planning/calibration/data";

/** What one call is assumed to cost before it is made, SEK (the research measured 0,02 to 0,03). */
export const FLOORPLAN_EST_SEK_PER_CALL = 0.05;
/** The hard ceiling of the whole probe, smoke included, SEK. */
export const FLOORPLAN_CAP_SEK = 2;
/** A compass counts only at or above this confidence (R-01). */
export const FLOORPLAN_MIN_CONFIDENCE = 0.6;
/** R-01: the route opens only when at least this share of the floor plans shows a compass. */
export const FLOORPLAN_MIN_PREVALENCE_PCT = 10;

/** The answer the model gives. Five flat fields; see the file header for why it stays this small. */
export const floorPlanCompassSchema = z.object({
  isFloorPlan: z
    .boolean()
    .describe("True om bilden är en planritning (ritning ovanifrån av lägenheten), annars false."),
  northArrowPresent: z
    .boolean()
    .describe(
      "True ENDAST om ritningen har en tydlig norrpil eller kompassros märkt N. En pil vid ytterdörren eller entrén visar var man går in och är INTE en norrpil.",
    ),
  northBearingDeg: z
    .number()
    .describe(
      "Grader medurs från bildens överkant till norr enligt norrpilen (0 = norr uppåt, 90 = norr åt höger). 0 om ingen norrpil finns.",
    ),
  balconySide: z
    .enum(["upp", "höger", "ned", "vänster", "ingen"])
    .describe("Vilken sida av bilden balkongen ligger på: upp, höger, ned, vänster, eller ingen om ingen balkong syns."),
  confidence: z.number().describe("Din säkerhet 0 till 1 i bedömningen av norrpilen."),
});

export type FloorPlanRead = z.infer<typeof floorPlanCompassSchema>;
export type BalconySide = FloorPlanRead["balconySide"];

export const FLOORPLAN_SYSTEM_PROMPT = [
  "Du tittar på en bild från en svensk bostadsannons.",
  "Avgör om bilden är en planritning. Om den är det: leta efter en norrpil eller en kompassros märkt N, och ange hur många grader medurs norr ligger från bildens överkant.",
  "En pil vid ytterdörren eller entrén markerar var man går in i lägenheten och är INTE en norrpil. Rapportera aldrig en ytterdörrspil som norr.",
  "Ange också vilken sida av bilden balkongen ligger på, om en balkong syns.",
  "Gissa inte: finns ingen tydlig norrpil, sätt northArrowPresent till false. Svara bara genom fälten.",
].join(" ");

/**
 * What decides the meaning of a stored read: the prompt, the model id, the JSON schema (which carries the
 * field descriptions) and the logic revision. Same recipe as `VISION_PROMPT_VERSION` in vision-cache.ts.
 * Pure, so a test can change one part and watch the hash move.
 */
export function floorPlanProbeVersion(parts: { prompt: string; model: string; schema: unknown; revision: number }): string {
  return createHash("sha256")
    .update(JSON.stringify({ model: parts.model, prompt: parts.prompt, schema: parts.schema, logic: parts.revision }))
    .digest("hex")
    .slice(0, 16);
}

export const FLOORPLAN_PROBE_VERSION: string = floorPlanProbeVersion({
  prompt: FLOORPLAN_SYSTEM_PROMPT,
  model: FLOORPLAN_MODEL,
  schema: z.toJSONSchema(floorPlanCompassSchema, { unrepresentable: "any" }),
  revision: FLOORPLAN_LOGIC_REVISION,
});

/**
 * The decision of the real probe of 2026-10-13 (evidence/floorplan-probe.json). False means: no plan bearing is
 * used anywhere and the balcony side stays unknown (R-01).
 *
 * It is false although the mechanical 10 % rule said "go". The model read a north arrow on 6 of 11 floor plans
 * (54,5 %), and looking at those six pictures showed that every one is the arrow at the front door that marks the
 * entrance, the exact trap the prompt and the field description warn about. The model fell for it despite the
 * warning, so the 6 are false positives, 0 of 11 plans have a real compass (the research found 0 of 69 by eye), and
 * opening the route would put wrong facades above correct footprint ones (T-14.3-08). Flip this to true only after a
 * read that survives the same look at the pictures.
 */
export const FLOORPLAN_ROUTE_ENABLED: boolean = false;

/** The measured numbers behind {@link FLOORPLAN_ROUTE_ENABLED}, in the words the report uses. */
export const FLOORPLAN_PROBE_SUMMARY: string =
  "0 av 11 planer med verklig kompass (modellen läste 6 av 11, 54,5 %, men alla 6 är ytterdörrspilar), väg stängd, 2026-10-13";

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

/** The image content block of the Messages API, the two shapes vision.ts uses. */
export type FloorPlanImageBlock = {
  type: "image";
  source:
    | { type: "url"; url: string }
    | { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string };
};

/**
 * The picture id of a Booli CDN URL: `https://bcdn.se/images/cache/49231065_1440x0.webp` is "49231065".
 * A URL without that shape gets the sha256 hex of the whole URL, so it still has a stable key.
 */
export function floorPlanImageId(imageUrl: string): string {
  const m = /\/images\/cache\/(\d+)_/.exec(imageUrl);
  return m ? m[1] : createHash("sha256").update(imageUrl).digest("hex");
}

const BOOLI_ID_IN_URL = /\/(?:bostad|annons)\/(\d+)(?:[/?#].*)?$/;

/**
 * The probe sample (R-01): rows sorted by Booli id ascending, one item per Booli id, the first image of each
 * row that passes the host allowlist. The first Booli image is the floor plan for 69 of 77 flats (research).
 * Rows without a Booli id or without an allowed image are skipped. Pure.
 */
export function pickProbeSample(
  rows: ReadonlyArray<{ sourceListingUrl: string | null; imageUrls: readonly string[] | null }>,
  n: number,
): { booliId: string; imageUrl: string }[] {
  const byId = new Map<number, string>();
  for (const row of rows) {
    const m = row.sourceListingUrl === null ? null : BOOLI_ID_IN_URL.exec(row.sourceListingUrl);
    if (!m) continue;
    const id = Number(m[1]);
    if (byId.has(id)) continue;
    const image = (row.imageUrls ?? []).find((u) => isAllowedImageHost(u));
    if (image !== undefined) byId.set(id, image);
  }
  return [...byId.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, n > 0 ? Math.floor(n) : 0)
    .map(([id, imageUrl]) => ({ booliId: String(id), imageUrl }));
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const floorPlanCacheEntrySchema = z.object({
  imageId: z.string(),
  promptVersion: z.string(),
  storedAt: z.string(),
  costSek: z.number(),
  result: floorPlanCompassSchema,
});

const floorPlanCacheSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), floorPlanCacheEntrySchema),
});

export type FloorPlanCache = z.infer<typeof floorPlanCacheSchema>;

const emptyCache = (): FloorPlanCache => ({ version: 1, entries: {} });

/**
 * Reads the cache. A missing file is an empty cache. A file that is not valid JSON or does not match the
 * schema is read as empty, a warning string is returned, and the bad file is renamed to `<path>.bak-<stamp>`
 * so the next save does not overwrite the evidence. Never throws.
 */
export function loadFloorPlanCache(
  path: string,
  opts: { now?: () => number } = {},
): { cache: FloorPlanCache; warning: string | null } {
  try {
    const raw = readJsonIfExists(path);
    if (raw === null) return { cache: emptyCache(), warning: null };
    const parsed = floorPlanCacheSchema.safeParse(raw);
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
    warning: `Planritningscachen ${path} kunde inte läsas och lästes som tom${moved ? `; filen flyttades till ${aside}` : " (filen kunde inte flyttas)"}`,
  };
}

/** Writes the cache atomically. Refuses a path outside the data directory by throwing; `opts.dir` exists for tests. */
export function saveFloorPlanCache(path: string, cache: FloorPlanCache, opts: { dir?: string } = {}): void {
  const dir = opts.dir ?? FLOORPLAN_CACHE_DIR;
  const safe = guardedDataPath(path, { dir, ext: ".json" });
  if (safe === null) throw new Error(`Planritningscachen får bara skrivas under ${dir}/ (fick ${path})`);
  writeJsonAtomic(safe, cache);
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/**
 * Thrown by the injected call when the model answered (so Anthropic charged for it) but the answer is
 * unusable (refusal, truncation, nothing parsed). Carries the money already billed, so the cap sees it.
 */
export class FloorPlanCallError extends Error {
  readonly code: string;
  readonly billedSek: number;

  constructor(code: string, billedSek: number) {
    super(code);
    this.name = "FloorPlanCallError";
    this.code = code;
    this.billedSek = billedSek;
  }
}

/** One model call on one picture; `costSek` is what Anthropic charged for it. */
export type FloorPlanCallFn = (image: FloorPlanImageBlock) => Promise<{ result: FloorPlanRead; costSek: number }>;

export type FloorPlanReadStatus = "read" | "cache" | "cost_cap" | "host" | "failed";

export interface FloorPlanProbeRead {
  booliId: string;
  result: FloorPlanRead | null;
  status: FloorPlanReadStatus;
  /** What this run paid for this item (a cache hit is 0). */
  costSek: number;
  /** Error NAME or code only, never a message (a message can carry a URL). */
  error?: string;
}

export interface FloorPlanProbeResult {
  /** Same length and order as the items. */
  reads: FloorPlanProbeRead[];
  spentSek: number;
  /** Fresh model reads that came back usable. */
  calls: number;
  cacheHits: number;
  /** The loaded cache plus this run's new reads; entries of another prompt version are dropped. */
  cacheNext: FloorPlanCache;
}

const errorLabel = (error: unknown): string =>
  error instanceof FloorPlanCallError ? error.code : error instanceof Error ? error.name : "UNKNOWN";

/**
 * Reads the first picture of each item, within a hard ceiling and never paying twice.
 *
 *  - An item whose URL fails the host allowlist is skipped as "host" and never reaches `call` (SSRF).
 *  - A cache entry of the same picture id AND the current version is a free hit: no call.
 *  - Before every call: when `spent + estimate > cap` (strictly greater; equal is allowed) the item and every
 *    later uncached item are "cost_cap" and no call is made.
 *  - A call that throws is "failed" with the error name only and the run goes on; money billed for an
 *    answered-and-failed call ({@link FloorPlanCallError}) still counts toward `spentSek`.
 *
 * Never throws because of one picture.
 */
export async function runFloorPlanProbe(
  items: ReadonlyArray<{ booliId: string; imageUrl: string }>,
  opts: { call: FloorPlanCallFn; cache: FloorPlanCache; capSek: number; today: string; estSekPerCall?: number },
): Promise<FloorPlanProbeResult> {
  const estimate = opts.estSekPerCall ?? FLOORPLAN_EST_SEK_PER_CALL;
  const reads: FloorPlanProbeRead[] = [];
  const fresh = new Map<string, FloorPlanCache["entries"][string]>();
  let spentSek = 0;
  let calls = 0;
  let cacheHits = 0;

  for (const item of items) {
    if (!isAllowedImageHost(item.imageUrl)) {
      reads.push({ booliId: item.booliId, result: null, status: "host", costSek: 0 });
      continue;
    }
    const imageId = floorPlanImageId(item.imageUrl);
    const hit = opts.cache.entries[imageId];
    if (hit && hit.promptVersion === FLOORPLAN_PROBE_VERSION) {
      cacheHits += 1;
      reads.push({ booliId: item.booliId, result: hit.result, status: "cache", costSek: 0 });
      continue;
    }
    // The 1e-9 only absorbs float noise from summing small SEK amounts: equal to the cap is allowed.
    if (spentSek + estimate > opts.capSek + 1e-9) {
      reads.push({ booliId: item.booliId, result: null, status: "cost_cap", costSek: 0 });
      continue;
    }
    try {
      const { result, costSek } = await opts.call({ type: "image", source: { type: "url", url: item.imageUrl } });
      spentSek += costSek;
      calls += 1;
      reads.push({ booliId: item.booliId, result, status: "read", costSek });
      fresh.set(imageId, { imageId, promptVersion: FLOORPLAN_PROBE_VERSION, storedAt: opts.today, costSek, result });
    } catch (error) {
      const billed = error instanceof FloorPlanCallError && Number.isFinite(error.billedSek) && error.billedSek > 0 ? error.billedSek : 0;
      spentSek += billed;
      reads.push({ booliId: item.booliId, result: null, status: "failed", costSek: billed, error: errorLabel(error) });
    }
  }

  const entries: FloorPlanCache["entries"] = {};
  for (const [id, e] of Object.entries(opts.cache.entries)) {
    if (e.promptVersion === FLOORPLAN_PROBE_VERSION) entries[id] = e;
  }
  for (const [id, e] of fresh) entries[id] = e;

  return { reads, spentSek, calls, cacheHits, cacheNext: { version: 1, entries } };
}

// ---------------------------------------------------------------------------
// Verdict and bearing
// ---------------------------------------------------------------------------

/** True when the read is a floor plan with a north arrow the model is at least {@link FLOORPLAN_MIN_CONFIDENCE} sure of. */
export function isCompassRead(r: FloorPlanRead): boolean {
  return r.isFloorPlan && r.northArrowPresent && r.confidence >= FLOORPLAN_MIN_CONFIDENCE;
}

/** floorPlans = reads that are floor plans; withCompass = those that show a trusted compass. */
export function summariseReads(reads: ReadonlyArray<FloorPlanRead>): { floorPlans: number; withCompass: number } {
  let floorPlans = 0;
  let withCompass = 0;
  for (const r of reads) {
    if (!r.isFloorPlan) continue;
    floorPlans += 1;
    if (isCompassRead(r)) withCompass += 1;
  }
  return { floorPlans, withCompass };
}

/**
 * R-01 decision rule, boundary inclusive: "go" when there is at least one floor plan and
 * withCompass x 100 >= 10 x floorPlans (1 of 10 goes, 1 of 11 does not), else "dropped".
 */
export function probeVerdict(counts: { floorPlans: number; withCompass: number }): "go" | "dropped" {
  if (!(counts.floorPlans > 0)) return "dropped";
  return counts.withCompass * 100 >= FLOORPLAN_MIN_PREVALENCE_PCT * counts.floorPlans ? "go" : "dropped";
}

const SIDE_OFFSET_DEG: Readonly<Record<Exclude<BalconySide, "ingen">, number>> = {
  upp: 0,
  höger: 90,
  ned: 180,
  vänster: 270,
};

/**
 * The compass bearing (degrees clockwise from north, 0 up to 360, one decimal) the balcony side of the plan faces,
 * or null when the read cannot support one: not a floor plan, no north arrow, confidence below
 * {@link FLOORPLAN_MIN_CONFIDENCE}, no balcony, or a non-finite number.
 *
 * `northBearingDeg` n is the angle from the top of the picture clockwise to north, so the top of the picture
 * points at 360 - n and each quarter turn clockwise adds 90: bearing = (360 - n + side offset) mod 360.
 */
export function planBearingOf(r: FloorPlanRead): number | null {
  if (!r.isFloorPlan || !r.northArrowPresent) return null;
  if (!(r.confidence >= FLOORPLAN_MIN_CONFIDENCE)) return null;
  if (r.balconySide === "ingen") return null;
  if (!Number.isFinite(r.northBearingDeg)) return null;
  const n = ((r.northBearingDeg % 360) + 360) % 360;
  const bearing = (360 - n + SIDE_OFFSET_DEG[r.balconySide]) % 360;
  const rounded = Math.round(bearing * 10) / 10;
  return Number.isFinite(rounded) ? (rounded >= 360 ? 0 : rounded) : null;
}

// ---------------------------------------------------------------------------
// Printing helpers (shared by the script)
// ---------------------------------------------------------------------------

/** SEK with 2 decimals and a decimal comma, for example "0,13". */
export const formatSek = (sek: number): string => sek.toFixed(2).replace(".", ",");

/** A percentage with 1 decimal and a decimal comma, for example "8,3". Zero floor plans give "0,0". */
export const formatPct = (withCompass: number, floorPlans: number): string =>
  (floorPlans > 0 ? (withCompass * 100) / floorPlans : 0).toFixed(1).replace(".", ",");
