/**
 * osm-overpass.ts - the one-off / monthly Overpass download of the innerstan
 * buildings and named streets (Phase 14.3, R-05, SUN-01).
 *
 * Script-side network module. It imports no HTTP client: the caller injects
 * `fetch`, `sleep`, the clock and a logger, so tests run without a network and
 * without waiting. Nothing in the app tree may import it, and `niche-score.ts`
 * and `report/flags.ts` must NEVER import it (the `discovery/osm-` prefix is
 * registered in the structural-separation test). `scripts/fit-score.ts` may
 * load it only by dynamic import in its live branch; the weekly run itself
 * reads the cache file and never calls Overpass while the cache is younger
 * than 31 days (osm-cache.ts owns that rule).
 *
 * WHY AN ENDPOINT LIST: the main host overpass-api.de is overloaded. The
 * research (2026-10-13) got HTTP 504 from it on every request for minutes,
 * while lz4.overpass-api.de, z.overpass-api.de and overpass.openstreetmap.fr
 * each worked intermittently. So the mirrors come first and the main host is
 * last. The list is fixed in code: no URL ever comes from data, arguments or a
 * redirect (`redirect: "error"`), which closes the SSRF door (T-14.3-02).
 *
 * POLITENESS (T-14.3-09): one request at a time, 3 s between endpoints, 15 s
 * between rounds, at most 3 rounds per query, a descriptive User-Agent, and the
 * download itself is a monthly job.
 *
 * ANSWERS ARE UNTRUSTED (T-14.3-01): an answer is accepted only with HTTP 200,
 * a json content-type, at most 50 MB (declared and streamed), parsable JSON,
 * an `elements` array under 200 000 passing a bounded zod schema, no `remark`
 * mentioning an error, and enough ways to look like a real innerstan extract.
 * Anything else is a failed attempt and the walk moves on. The caller saves a
 * file only after all three queries succeeded.
 *
 * LOGS (T-14.3-06): host, HTTP status, element count, MB and seconds, or a
 * fixed Swedish reason label or an error NAME. Never a response body, never an
 * error message from the network layer, never an environment value.
 *
 * LICENCE (T-14.3-07): ODbL; every file carries the attribution string.
 */
import { z } from "zod/v4";
import { OSM_ATTRIBUTION, OSM_MAX_MEMBERS_PER_RELATION, OSM_MAX_POINTS_PER_WAY, type OsmExtract } from "@/lib/discovery/osm-buildings";

/** The only hosts ever requested, in the order they are tried. The overloaded main host is last. */
export const OVERPASS_ENDPOINTS = [
  "https://lz4.overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass-api.de/api/interpreter",
] as const;

/**
 * The innerstan box: the research box (59.30-59.35 N, 17.99-18.12 E, which
 * already covers every candidate in the snapshot) plus a margin of about 250 m,
 * so the north-most candidate (lat 59.3487) still has its full ray radius of
 * map around it.
 */
export const OSM_BBOX = { south: 59.295, west: 17.985, north: 59.355, east: 18.125 };

const BOX = `${OSM_BBOX.south},${OSM_BBOX.west},${OSM_BBOX.north},${OSM_BBOX.east}`;

/** One bbox query per element class. Relations need `out geom` (not `tags`) so their members carry geometry. */
export const OVERPASS_QUERIES = {
  buildings: `[out:json][timeout:180];way["building"](${BOX});out geom tags;`,
  relations: `[out:json][timeout:180];relation["building"](${BOX});out geom;`,
  roads: `[out:json][timeout:180];way["highway"]["name"](${BOX});out geom tags;`,
} as const;

export const OVERPASS_LIMITS = {
  rounds: 3,
  endpointPauseMs: 3000,
  roundPauseMs: 15000,
  requestTimeoutMs: 200000,
  maxBytes: 50 * 1024 * 1024,
  maxElements: 200000,
  maxPointsPerWay: OSM_MAX_POINTS_PER_WAY,
  maxMembers: OSM_MAX_MEMBERS_PER_RELATION,
  /** The research box held 12 750 building ways; fewer than 5 000 means an empty or partial answer. */
  minBuildingWays: 5000,
  /** The research box held 10 022 named highway ways. */
  minRoadWays: 1000,
};

export const OVERPASS_USER_AGENT = "bostadai-sun-orientation/1.0 (personal research; monthly cache refresh)";

type QueryKind = keyof typeof OVERPASS_QUERIES;

/** The research download the fallback import reads, and the file names in it. */
const RESEARCH_SOURCE = "research download 2026-10-13";
const RESEARCH_BBOX = { south: 59.3, west: 17.99, north: 59.35, east: 18.12 };
const RESEARCH_FILES: Record<QueryKind, string> = {
  buildings: "osm-innerstan-buildings.json",
  relations: "osm-innerstan-building-relations.json",
  roads: "osm-innerstan-roads.json",
};

// ---------------------------------------------------------------------------
// Element schema (bounded numbers before any geometry code sees them)
// ---------------------------------------------------------------------------

const pointSchema = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });
const geometrySchema = z.array(pointSchema).max(OVERPASS_LIMITS.maxPointsPerWay);
const tagsSchema = z.record(z.string(), z.string()).default({});

/** Unknown keys (`bounds`, ...) are dropped on purpose: nothing reads them and the file stays small. */
const waySchema = z.object({
  type: z.literal("way"),
  id: z.number().int(),
  tags: tagsSchema,
  geometry: geometrySchema.default([]),
});

const relationSchema = z.object({
  type: z.literal("relation"),
  id: z.number().int(),
  tags: tagsSchema,
  members: z
    .array(z.object({ type: z.string(), ref: z.number().int(), role: z.string(), geometry: geometrySchema.optional() }))
    .max(OVERPASS_LIMITS.maxMembers)
    .default([]),
});

const elementsSchema = z.array(z.discriminatedUnion("type", [waySchema, relationSchema]));

type Element = z.infer<typeof elementsSchema>[number];
type WayElement = z.infer<typeof waySchema>;
type RelationElement = z.infer<typeof relationSchema>;

const isWay = (e: Element): e is WayElement => e.type === "way";
const isRelation = (e: Element): e is RelationElement => e.type === "relation";

// ---------------------------------------------------------------------------
// Validation of one answer
// ---------------------------------------------------------------------------

/** A rejected answer. `label` is a fixed Swedish phrase, never text taken from the answer. */
class AnswerRejected extends Error {
  constructor(readonly label: string) {
    super(label);
    this.name = "AnswerRejected";
  }
}

interface CheckedAnswer {
  ways: WayElement[];
  relations: RelationElement[];
  /** `osm3s.timestamp_osm_base`, or null when the answer has none. */
  osmBase: string | null;
  elementCount: number;
}

const isoSchema = z.iso.datetime();

/** Checks the text of one answer for the query it belongs to. Throws {@link AnswerRejected}. */
function checkAnswerText(text: string, kind: QueryKind): CheckedAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AnswerRejected("ogiltig JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new AnswerRejected("ogiltigt svar");
  const body = parsed as Record<string, unknown>;
  if (typeof body.remark === "string" && /error/i.test(body.remark)) throw new AnswerRejected("Overpass meldade fel");
  const rawElements = body.elements;
  if (!Array.isArray(rawElements)) throw new AnswerRejected("ogiltigt svar");
  if (rawElements.length > OVERPASS_LIMITS.maxElements) throw new AnswerRejected("för många element");
  const checked = elementsSchema.safeParse(rawElements);
  if (!checked.success) throw new AnswerRejected("ogiltigt element");

  const ways = checked.data.filter(isWay);
  const relations = checked.data.filter(isRelation);
  if (kind === "buildings" && ways.length < OVERPASS_LIMITS.minBuildingWays) throw new AnswerRejected("misstänkt tomt svar");
  if (kind === "roads" && ways.length < OVERPASS_LIMITS.minRoadWays) throw new AnswerRejected("misstänkt tomt svar");

  const osm3s = body.osm3s;
  const stamp =
    typeof osm3s === "object" && osm3s !== null ? (osm3s as Record<string, unknown>).timestamp_osm_base : undefined;
  const osmBase = typeof stamp === "string" && isoSchema.safeParse(stamp).success ? stamp : null;
  if (kind === "buildings" && osmBase === null) throw new AnswerRejected("saknar OSM-tid");

  return { ways, relations, osmBase, elementCount: checked.data.length };
}

/** The elements a query is allowed to contribute: ways for buildings and roads, relations for relations. */
const pick = (kind: QueryKind, answer: CheckedAnswer): WayElement[] | RelationElement[] =>
  kind === "relations" ? answer.relations : answer.ways;

// ---------------------------------------------------------------------------
// One request
// ---------------------------------------------------------------------------

/** The slice of `fetch` this module uses. `globalThis.fetch` fits. */
export type OverpassFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface OverpassDeps {
  fetchImpl: OverpassFetch;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  log: (line: string) => void;
}

const fmtMb = (bytes: number) => (bytes / 1_000_000).toFixed(1).replace(".", ",");
const fmtSec = (ms: number) => (ms / 1000).toFixed(1).replace(".", ",");

/** Reads a body, giving up as soon as it passes the cap; the declared length is checked before reading. */
async function readCapped(response: Response): Promise<{ text: string; bytes: number }> {
  const max = OVERPASS_LIMITS.maxBytes;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    throw new AnswerRejected("för stort svar");
  }
  if (response.body === null) {
    const text = await response.text();
    const bytes = Buffer.byteLength(text);
    if (bytes > max) throw new AnswerRejected("för stort svar");
    return { text, bytes };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new AnswerRejected("för stort svar");
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes: total };
}

type Attempt = { ok: true; answer: CheckedAnswer } | { ok: false; label: string };

async function attemptOnce(endpoint: string, kind: QueryKind, deps: OverpassDeps): Promise<Attempt> {
  const host = new URL(endpoint).host;
  const started = deps.now().getTime();
  const took = () => fmtSec(deps.now().getTime() - started);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OVERPASS_LIMITS.requestTimeoutMs);
  timer.unref?.();
  let status: number | null = null;
  try {
    const response = await deps.fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "User-Agent": OVERPASS_USER_AGENT,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `data=${encodeURIComponent(OVERPASS_QUERIES[kind])}`,
      redirect: "error",
      signal: controller.signal,
    });
    status = response.status;
    if (status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      deps.log(`Overpass ${kind}: ${host} HTTP ${status} (${took()} s)`);
      return { ok: false, label: `HTTP ${status}` };
    }
    if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("json")) {
      await response.body?.cancel().catch(() => undefined);
      throw new AnswerRejected("fel innehållstyp");
    }
    const { text, bytes } = await readCapped(response);
    const answer = checkAnswerText(text, kind);
    deps.log(`Overpass ${kind}: ${host} HTTP 200, ${answer.elementCount} element, ${fmtMb(bytes)} MB, ${took()} s`);
    return { ok: true, answer };
  } catch (error) {
    const label = error instanceof AnswerRejected ? error.label : error instanceof Error ? error.name : "okänt fel";
    const prefix = status === null ? "" : `HTTP ${status}, `;
    deps.log(`Overpass ${kind}: ${host} ${prefix}${label} (${took()} s)`);
    return { ok: false, label: status === null ? label : `HTTP ${status}, ${label}` };
  } finally {
    clearTimeout(timer);
  }
}

/** One query through the endpoint / round walk. Resolves with the first acceptable answer. */
async function runQuery(kind: QueryKind, deps: OverpassDeps): Promise<CheckedAnswer> {
  const failures: string[] = [];
  let first = true;
  for (let round = 1; round <= OVERPASS_LIMITS.rounds; round++) {
    for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
      if (!first) await deps.sleep(i === 0 ? OVERPASS_LIMITS.roundPauseMs : OVERPASS_LIMITS.endpointPauseMs);
      first = false;
      const endpoint = OVERPASS_ENDPOINTS[i];
      const result = await attemptOnce(endpoint, kind, deps);
      if (result.ok) return result.answer;
      failures.push(`${new URL(endpoint).host} ${result.label}`);
    }
  }
  throw new Error(
    `Overpass gav inget godtagbart svar på ${kind}-frågan efter ${OVERPASS_LIMITS.rounds} omgångar: ${failures.join("; ")}`,
  );
}

// ---------------------------------------------------------------------------
// The two ways to build the file
// ---------------------------------------------------------------------------

/**
 * The live download: three queries one after another, each walked over the
 * endpoint list. Resolves with the file contract (`parseOsmExtract` accepts it)
 * or rejects; it writes nothing, so a failure cannot damage an existing cache.
 */
export async function downloadOsmExtract(deps: OverpassDeps): Promise<OsmExtract> {
  const buildings = await runQuery("buildings", deps);
  await deps.sleep(OVERPASS_LIMITS.endpointPauseMs);
  const relations = await runQuery("relations", deps);
  await deps.sleep(OVERPASS_LIMITS.endpointPauseMs);
  const roads = await runQuery("roads", deps);
  return {
    version: 1,
    attribution: OSM_ATTRIBUTION,
    fetchedAt: deps.now().toISOString(),
    osmBase: buildings.osmBase as string,
    bbox: { ...OSM_BBOX },
    buildings: pick("buildings", buildings) as WayElement[],
    relations: pick("relations", relations) as RelationElement[],
    roads: pick("roads", roads) as WayElement[],
  };
}

/**
 * The fallback for a dead Overpass: builds the same file from the three
 * research downloads of 2026-10-13 (`dir` holds the three files), with the same
 * validation and minimum counts. `fetchedAt` is the OSM time of the buildings
 * download, so the 31-day clock runs from when the data was true. The box is
 * the research box (no 250 m margin), which the file records in `bbox`.
 */
export function importResearchExtract(dir: string, deps: { readText: (path: string) => string }): OsmExtract {
  const read = (kind: QueryKind): CheckedAnswer => {
    const path = `${dir.replace(/\/+$/, "")}/${RESEARCH_FILES[kind]}`;
    let text: string;
    try {
      text = deps.readText(path);
    } catch {
      throw new Error(`Researchfilen ${RESEARCH_FILES[kind]} kunde inte läsas i ${dir}`);
    }
    if (Buffer.byteLength(text) > OVERPASS_LIMITS.maxBytes) throw new AnswerRejected("för stort svar");
    return checkAnswerText(text, kind);
  };
  const buildings = read("buildings");
  const relations = read("relations");
  const roads = read("roads");
  return {
    version: 1,
    attribution: OSM_ATTRIBUTION,
    fetchedAt: buildings.osmBase as string,
    osmBase: buildings.osmBase as string,
    bbox: { ...RESEARCH_BBOX },
    buildings: pick("buildings", buildings) as WayElement[],
    relations: pick("relations", relations) as RelationElement[],
    roads: pick("roads", roads) as WayElement[],
    source: RESEARCH_SOURCE,
  };
}
