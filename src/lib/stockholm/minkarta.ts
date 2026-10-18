/**
 * minkarta.ts - rung (c): Lantmäteriet's public Min Karta map answers "which fastighet is at this address"
 * (Phase 14.6, CASE-01, D-02, R-06).
 *
 * PORTED from the rental repo's `scripts/resolve_beteckning.py` (~/dev/rental-apartments, read only), with the rules
 * as restated in 14.6-RESEARCH section 3.1:
 *   1. search      GET /api/searchservice/searchinput?searchtext=<address>     -> hits with east/north (SWEREF 99 TM)
 *   2. candidates  GET .../registerenhetermedbuffer/v1?east&north&buffer&transactionId, buffer 0, then 5, then 10:
 *                  the first buffer that returns anything wins. Neighbouring plots and the street land itself are
 *                  swept into a 10 m buffer (Bondegatan 59 returns Oljan 29, Oljan 17, Södermalm 8:57, Södermalm
 *                  10:35), so one candidate is trusted as it is, several are tested by point-in-polygon.
 *   3. geometry    GET /api/searchservice/fastighetsinfo/v1?objektidentitet=<id> -> the boundary polygons. Outer ring
 *                  in, holes out, any polygon of a multi-part parcel counts. Street land ("Södermalm 8:57") is one
 *                  outer ring with a hole per building, so it never contains a building's point.
 * Statuses: resolved | ambiguous | no_candidates | fetch_failed. `fetch_failed` is never cached by the caller.
 *
 * NO FUZZY FALLBACK. A hit must be in Stockholm kommun AND have the same address as the one asked; the first hit is
 * never taken "because it is close". The answer must also be a Stockholm designation.
 *
 * THE RULES OF CONDUCT (D-01, R-06). This is a public map's own interface, not a bulk endpoint: one request at a
 * time, each started at least 3 000 ms after the previous Min Karta request (its own pacer, separate from the city's),
 * one attempt and no retry, at most 5 calls per address (search, up to three buffer steps, then the boundary of as
 * many candidates as the rest of the budget allows). The User-Agent is honest and names this project. The rental
 * repo's file forbids, and so does this one, anything that rotates, randomises or disguises the client, anything that
 * routes a request through another host so that it looks like a different caller, and anything that defeats a
 * challenge. If Min Karta refuses (HTTP 403 or 429, or an answer that is not JSON), the host goes on the 24 hour
 * list in host-gate.ts, the lookup ends as fetch_failed, and nothing else is tried. A host entry marked `disabled`
 * (plan 04's spike writes it if the honest User-Agent is refused) means no request at all.
 *
 * Script-side only (node:crypto for the transaction id). Candidates only: never used for the sold-price join.
 * `niche-score.ts` and `report/flags.ts` must NEVER import it.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod/v4";
import { cleanAddressForSearch, isStreetLandBeteckning, normaliseBeteckning } from "@/lib/stockholm/beteckning-text";
import { HOST_GATES_PATH, CITY_DATA_DIR, blockHost, hostBlockedUntil, makeHostPacer, readHostGates } from "@/lib/stockholm/host-gate";

export const MINKARTA_HOST = "minkarta.lantmateriet.se";
export const MINKARTA_USER_AGENT = "bostadai-bygglov/1.0 (personal research; address to fastighetsbeteckning, 1 request per 3 s)";
/** Buffer widths in metres, tried in this order. */
export const BUFFER_LADDER = [0, 5, 10] as const;
/** Search + three buffer steps + one boundary: the most one address may cost. */
export const MINKARTA_MAX_CALLS_PER_ADDRESS = 5;

export const MINKARTA_LIMITS = {
  /** A larger answer is refused (the biggest boundary seen is 18 KB). */
  maxBytes: 2 * 1024 * 1024,
  requestTimeoutMs: 30_000,
};

const REFERER = `https://${MINKARTA_HOST}/`;
const SEARCH_PATH = "/api/searchservice/searchinput";
const REGISTERENHETER_PATH = "/api/positionsinformation/positionsinformation/registerenhetermedbuffer/v1";
const FASTIGHETSINFO_PATH = "/api/searchservice/fastighetsinfo/v1";

/** An object id is a UUID; anything else read from an answer is never put into a URL. */
const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Answers (untrusted: only the fields that are read, all optional)
// ---------------------------------------------------------------------------

export interface MinKartaHit {
  readonly headertext: string;
  readonly subtext: string;
  readonly east: number;
  readonly north: number;
}

const searchSchema = z.object({
  sokresultat: z
    .array(
      z.object({
        headertext: z.string().optional(),
        subtext: z.string().optional(),
        position: z.object({ east: z.number(), north: z.number() }).optional(),
      }),
    )
    .optional(),
});

/** The hits of a search answer; a hit without a position is dropped. A wrong shape gives an empty list. */
export function parseSearchHits(answer: unknown): MinKartaHit[] {
  const parsed = searchSchema.safeParse(answer);
  if (!parsed.success) return [];
  const hits: MinKartaHit[] = [];
  for (const hit of parsed.data.sokresultat ?? []) {
    if (hit.position === undefined) continue;
    hits.push({
      headertext: (hit.headertext ?? "").trim(),
      subtext: (hit.subtext ?? "").trim(),
      east: hit.position.east,
      north: hit.position.north,
    });
  }
  return hits;
}

export interface MinKartaCandidate {
  /** "STOCKHOLM OLJAN 29" as Min Karta writes it. */
  readonly text: string;
  /** The object id, or null when the answer had none we can use. */
  readonly id: string | null;
}

const registerenheterSchema = z.object({
  registerenheter: z.array(z.object({ objectText: z.string().optional(), objectId: z.string().optional() })).optional(),
});

/** The candidates of a buffer answer; an entry without text is dropped. */
export function parseCandidates(answer: unknown): MinKartaCandidate[] {
  const parsed = registerenheterSchema.safeParse(answer);
  if (!parsed.success) return [];
  const out: MinKartaCandidate[] = [];
  for (const unit of parsed.data.registerenheter ?? []) {
    const text = (unit.objectText ?? "").trim();
    if (text === "") continue;
    out.push({ text, id: unit.objectId !== undefined && OBJECT_ID.test(unit.objectId) ? unit.objectId : null });
  }
  return out;
}

export type Point = readonly [number, number];
export type Ring = readonly Point[];
/** A polygon: the first ring is the outer boundary, every further ring is a hole. */
export type Polygon = readonly Ring[];

const fastighetsinfoSchema = z.object({
  beteckningtext: z.string().optional(),
  enhetsutbredning: z
    .array(z.object({ yta: z.array(z.object({ coordinates: z.array(z.unknown()).optional() })).optional() }))
    .optional(),
});

/** A ring in either shape the API may use: a list of [e, n] pairs or a flat [e, n, e, n, ...] list. */
function coerceRing(coords: unknown): Point[] {
  if (!Array.isArray(coords) || coords.length === 0) return [];
  if (Array.isArray(coords[0])) {
    const ring: Point[] = [];
    for (const p of coords) {
      if (Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number") ring.push([p[0], p[1]]);
    }
    return ring;
  }
  const flat = coords.filter((v): v is number => typeof v === "number");
  const ring: Point[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) ring.push([flat[i], flat[i + 1]]);
  return ring;
}

export interface Fastighetsinfo {
  /** "Stockholm Oljan 29" as Min Karta writes it, or null. */
  readonly beteckningtext: string | null;
  /** Every polygon of the parcel (a parcel can be several separate pieces). */
  readonly polygons: readonly Polygon[];
}

export function parseFastighetsinfo(answer: unknown): Fastighetsinfo {
  const body = Array.isArray(answer) ? answer[0] : answer;
  const parsed = fastighetsinfoSchema.safeParse(body);
  if (!parsed.success) return { beteckningtext: null, polygons: [] };
  const polygons: Polygon[] = [];
  for (const utbredning of parsed.data.enhetsutbredning ?? []) {
    for (const yta of utbredning.yta ?? []) {
      // GeoJSON Polygon: `coordinates` is a LIST OF RINGS (outer first, then holes), not a single ring.
      const rings = (yta.coordinates ?? []).map(coerceRing).filter((ring) => ring.length >= 3);
      if (rings.length > 0) polygons.push(rings);
    }
  }
  const text = parsed.data.beteckningtext?.trim();
  return { beteckningtext: text !== undefined && text !== "" ? text : null, polygons };
}

// ---------------------------------------------------------------------------
// Rules ported from the rental repo
// ---------------------------------------------------------------------------

/** Re-export under the name the rental repo uses: strip a flat number or floor, close an entrance letter. */
export const cleanSearchAddress = cleanAddressForSearch;

const textKey = (text: string): string => text.replace(/\s+/g, " ").trim().toLocaleLowerCase("sv");
/** "Hantverkargatan 5 C" and "Hantverkargatan 5C" compare equal. */
const addressMatchKey = (text: string): string => textKey(text).replace(/(\d)\s+([a-zåäö])\b/gu, "$1$2");
const kommunOf = (subtext: string): string => textKey(subtext.split("|", 1)[0] ?? "");

/**
 * The one search hit to trust, or null. Two guards, both there to prevent a confidently wrong answer: the kommun
 * segment of `subtext` (before "|") must be Stockholm, and the hit's `headertext` must equal the address asked for
 * (casefolded, entrance letter closed). There is NO first-hit fallback: a hit that is merely close is a wrong building.
 */
export function pickBestHit(hits: readonly MinKartaHit[], query: string): MinKartaHit | null {
  const target = addressMatchKey(cleanAddressForSearch(query));
  for (const hit of hits) {
    if (kommunOf(hit.subtext) !== "stockholm") continue;
    if (addressMatchKey(hit.headertext) === target) return hit;
  }
  return null;
}

/** Even-odd ray cast against one closed ring. Planar: SWEREF 99 TM is a projected system in metres. */
function ringContains(east: number, north: number, ring: Ring): boolean {
  if (ring.length < 3) return false;
  let inside = false;
  let j = ring.length - 1;
  for (let i = 0; i < ring.length; i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > north !== yj > north) {
      const denominator = yj - yi;
      if (denominator !== 0 && east < ((xj - xi) * (north - yi)) / denominator + xi) inside = !inside;
    }
    j = i;
  }
  return inside;
}

/** Outer ring in, holes out. */
function polygonContains(east: number, north: number, polygon: Polygon): boolean {
  if (polygon.length === 0 || !ringContains(east, north, polygon[0])) return false;
  return !polygon.slice(1).some((hole) => ringContains(east, north, hole));
}

/**
 * True when the point lies inside ANY polygon of the parcel (a parcel can be several separate pieces); a hole punched
 * out for a building means the street land does not contain that building's point.
 */
export function pointInParcel(east: number, north: number, polygons: readonly Polygon[]): boolean {
  return polygons.some((polygon) => polygonContains(east, north, polygon));
}

/** Lower-case "OLJAN 29" to "Oljan 29"; a text that already has lower-case letters is left as it is. */
function titleCaseIfShouting(text: string): string {
  if (text !== text.toLocaleUpperCase("sv")) return text;
  return text
    .toLocaleLowerCase("sv")
    .split(" ")
    .map((word) => (word === "" ? word : word[0].toLocaleUpperCase("sv") + word.slice(1)))
    .join(" ");
}

/** "STOCKHOLM OLJAN 29" gives "Oljan 29". Null for a designation outside Stockholm kommun. */
function stockholmBeteckning(text: string): string | null {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!/^stockholm\s+\S/i.test(cleaned)) return null;
  return titleCaseIfShouting(normaliseBeteckning(cleaned));
}

// ---------------------------------------------------------------------------
// The lookup
// ---------------------------------------------------------------------------

export type MinKartaStatus = "resolved" | "ambiguous" | "no_candidates" | "fetch_failed";

export interface MinKartaResult {
  status: MinKartaStatus;
  /** "Oljan 29" (kommun dropped), set only when resolved. */
  beteckning: string | null;
  /** Min Karta requests made for this address (at most 5). */
  calls: number;
  /** A fixed Swedish phrase saying why, for logs and the run report. */
  reason: string;
}

/** The slice of `fetch` this module uses. `globalThis.fetch` fits. */
export type MinKartaFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface MinKartaDeps {
  fetchImpl: MinKartaFetch;
  now: () => Date;
  log: (line: string) => void;
  /** Where the 24 hour block lives; tests pass a temp file. */
  gatesPath?: string;
  /** The directory the block file must stay inside; tests pass a temp directory. */
  dataDir?: string;
  /** A fresh random hex id per call; tests pass a fixed one. */
  transactionId?: () => string;
  /** Awaited right before every request: the 3 000 ms floor between two Min Karta request starts. */
  pace: (host: string) => Promise<void>;
}

const fmtKb = (bytes: number) => Math.round(bytes / 1024).toString();
const fmtSec = (ms: number) => (ms / 1000).toFixed(1).replace(".", ",");

type Called = { ok: true; json: unknown } | { ok: false; reason: string };

/** Resolves one address to a fastighetsbeteckning through Min Karta, or says why not. Never throws on a bad answer. */
export async function resolveViaMinKarta(address: string, deps: MinKartaDeps): Promise<MinKartaResult> {
  const gatesPath = deps.gatesPath ?? HOST_GATES_PATH;
  const dataDir = deps.dataDir ?? CITY_DATA_DIR;
  const newTransactionId = deps.transactionId ?? (() => randomBytes(16).toString("hex"));
  const line = (text: string) => deps.log(`[stockholm] ${text}`);
  let calls = 0;

  /** One GET: block check, budget, gate, ONE fetch, then status / content-type / size / JSON. */
  async function get(path: string, query: ReadonlyArray<readonly [string, string]>): Promise<Called> {
    const until = hostBlockedUntil(readHostGates(gatesPath, deps.log), MINKARTA_HOST, deps.now());
    if (until !== null) {
      line(`Min Karta pausad (spärr på ${MINKARTA_HOST})`);
      return { ok: false, reason: "pausad" };
    }
    if (calls >= MINKARTA_MAX_CALLS_PER_ADDRESS) return { ok: false, reason: "budget" };
    await deps.pace(MINKARTA_HOST);
    calls += 1;

    const url = new URL(`https://${MINKARTA_HOST}${path}`);
    url.search = query.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const started = deps.now().getTime();
    const took = () => fmtSec(deps.now().getTime() - started);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MINKARTA_LIMITS.requestTimeoutMs);
    timer.unref?.();

    /** A refusal: the host goes on the 24 hour list and this lookup ends. */
    const refuse = (label: string): Called => {
      blockHost(gatesPath, MINKARTA_HOST, label, deps.now(), { dir: dataDir, log: deps.log });
      line(`${MINKARTA_HOST} blockerad i 24 timmar (${label})`);
      return { ok: false, reason: label };
    };

    try {
      let response: Response;
      try {
        response = await deps.fetchImpl(url.toString(), {
          method: "GET",
          headers: { "User-Agent": MINKARTA_USER_AGENT, Referer: REFERER, Accept: "application/json" },
          redirect: "error",
          signal: controller.signal,
        });
      } catch (error) {
        line(`${MINKARTA_HOST}${path} ${error instanceof Error ? error.name : "okänt fel"} (${took()} s)`);
        return { ok: false, reason: "natverksfel" };
      }
      const status = response.status;
      if (status === 403 || status === 429) {
        await response.body?.cancel().catch(() => undefined);
        line(`${MINKARTA_HOST}${path} HTTP ${status} (${took()} s)`);
        return refuse(`http-${status}`);
      }
      if (status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        line(`${MINKARTA_HOST}${path} HTTP ${status} (${took()} s)`);
        return { ok: false, reason: `http-${status}` };
      }
      if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("json")) {
        await response.body?.cancel().catch(() => undefined);
        line(`${MINKARTA_HOST}${path} HTTP ${status}, fel innehållstyp (${took()} s)`);
        return refuse("fel-innehallstyp");
      }
      const text = await response.text();
      const bytes = Buffer.byteLength(text);
      if (bytes > MINKARTA_LIMITS.maxBytes) {
        line(`${MINKARTA_HOST}${path} HTTP ${status}, för stort svar (${took()} s)`);
        return { ok: false, reason: "storlek" };
      }
      line(`${MINKARTA_HOST}${path} HTTP ${status}, ${fmtKb(bytes)} kB, ${took()} s`);
      try {
        return { ok: true, json: JSON.parse(text) as unknown };
      } catch {
        return { ok: false, reason: "ogiltig-json" };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  const done = (status: MinKartaStatus, beteckning: string | null, reason: string): MinKartaResult => ({
    status,
    beteckning,
    calls,
    reason,
  });
  const failed = (reason: string) => done("fetch_failed", null, reason);

  // 1. search: one call on the cleaned building address
  const query = cleanAddressForSearch(address);
  if (query === "" || query.length > 80) return done("no_candidates", null, "ingen sökbar adress");
  const search = await get(SEARCH_PATH, [["searchtext", query]]);
  if (!search.ok) return failed(search.reason);
  const hit = pickBestHit(parseSearchHits(search.json), query);
  if (hit === null) return done("no_candidates", null, "ingen träff i Stockholm med samma adress");

  // 2. the buffer ladder: the first width that returns anything
  let candidates: MinKartaCandidate[] = [];
  for (const buffer of BUFFER_LADDER) {
    const answer = await get(REGISTERENHETER_PATH, [
      ["east", String(hit.east)],
      ["north", String(hit.north)],
      ["buffer", String(buffer)],
      ["transactionId", newTransactionId()],
    ]);
    if (!answer.ok) return failed(answer.reason);
    // Only designations in Stockholm kommun are of use; a neighbour kommun's plot is dropped, never mapped.
    candidates = parseCandidates(answer.json).filter((c) => stockholmBeteckning(c.text) !== null);
    if (candidates.length > 0) break;
  }
  if (candidates.length === 0) return done("no_candidates", null, "inga registerenheter i närheten");

  // 3. exactly one candidate is the answer
  if (candidates.length === 1) {
    return done("resolved", stockholmBeteckning(candidates[0].text), "en enda registerenhet");
  }

  // 4. several: the boundary of each, building plots before district-named street land (which is never accepted
  // anyway), and the first parcel that contains the point wins. Stops when the call budget is spent.
  const ordered = [...candidates].sort(
    (a, b) => Number(isStreetLandBeteckning(stockholmBeteckning(a.text) ?? "")) - Number(isStreetLandBeteckning(stockholmBeteckning(b.text) ?? "")),
  );
  for (const candidate of ordered) {
    if (candidate.id === null) continue;
    if (calls >= MINKARTA_MAX_CALLS_PER_ADDRESS) break;
    const answer = await get(FASTIGHETSINFO_PATH, [["objektidentitet", candidate.id]]);
    if (!answer.ok) return failed(answer.reason);
    const info = parseFastighetsinfo(answer.json);
    if (!pointInParcel(hit.east, hit.north, info.polygons)) continue;
    const beteckning = stockholmBeteckning(info.beteckningtext ?? "") ?? stockholmBeteckning(candidate.text);
    return done("resolved", beteckning, "gränsen innehåller adresspunkten");
  }
  return done("ambiguous", null, "ingen enskild registerenhet innehåller adresspunkten");
}

/** A resolver with its own pacer, so every address of a run shares the one 3 000 ms floor. */
export function makeMinKartaResolver(
  deps: Omit<MinKartaDeps, "pace"> & { sleep: (ms: number) => Promise<void> },
): (address: string) => Promise<MinKartaResult> {
  const pace = makeHostPacer({ now: () => deps.now().getTime(), sleep: deps.sleep });
  return (address) => resolveViaMinKarta(address, { ...deps, pace });
}
