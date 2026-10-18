/**
 * bygglov-client.ts - the one polite door to Stockholm stad's building-permit e-service (Phase 14.6, D-01, R-01,
 * CASE-02).
 *
 * Script-side network module. It imports no HTTP client: the caller injects `fetch`, `sleep`, the clock and a logger,
 * so tests run without a network and without waiting. Nothing in the app tree may import it, and `niche-score.ts` and
 * `report/flags.ts` must NEVER import it (the `stockholm/` prefix is registered in the structural-separation test).
 *
 * THE RULES (we behave like a careful person at a keyboard):
 *  - One request at a time, and a new one starts at least 3 000 ms after the previous one to the same host
 *    (`makeStartGate(3000)` via host-gate.ts).
 *  - A plain GET to the fixed host. Every URL is built from the fixed host plus digits or percent-encoded values; no
 *    URL is ever read from page content (T-14.6-11). `redirect: "error"`.
 *  - An honest User-Agent that names the project. No cookie is sent and Set-Cookie is never read.
 *  - ONE attempt per request. No retry, ever.
 *  - Answers are untrusted: HTTP 200, an HTML content-type, at most 5 MiB (declared and streamed).
 *  - A refusal ends the run AND keeps us away for 24 hours (host-gate.ts): HTTP 403 or 429, a login wall, a terms
 *    page, a changed page shape, an answer that is not HTML. Every public call checks that block first, then the
 *    request budget, then waits for the gate, then makes its one fetch.
 *  - The client takes NO Monday-window rule (R-02): manual tools check `assertManualRunAllowed` themselves, the weekly
 *    job's own lookups are not subject to it.
 *
 * LOGS (T-14.6-13): host, path WITHOUT query, HTTP status, kB and seconds, or a fixed label. Never a URL query, a
 * body, a header or a cookie. Every line starts with "[stockholm] ".
 */
import { classifyDescription, toStoredCase, type StoredCase } from "@/lib/stockholm/bygglov-classify";
import type { SweepCase } from "@/lib/stockholm/bygglov-cache";
import {
  exactMatchRows,
  parseAddressFragment,
  parseCaseDetail,
  parseCaseList,
  type AddressOption,
  type CaseDetail,
  type ParseFailure,
} from "@/lib/stockholm/bygglov-parse";
import { CITY_DATA_DIR, HOST_GATES_PATH, blockHost, hostBlockedUntil, makeHostPacer, readHostGates } from "@/lib/stockholm/host-gate";

/** The only host this client may call. */
export const CITY_HOST = "etjanster.stockholm.se";

export const CITY_USER_AGENT = "bostadai-bygglov/1.0 (personal research; cached, 1 request per 3 s)";

export const CITY_LIMITS = {
  /** A page above this is refused (the biggest page seen is 835 KB). */
  maxBytes: 5 * 1024 * 1024,
  requestTimeoutMs: 30_000,
  /** robots.txt text is cut at this many bytes. */
  robotsMaxBytes: 64 * 1024,
  /** Default request budget per client (one run); a caller can pass a smaller or larger `budget`. */
  maxRequestsPerRun: 400,
};

/**
 * A run that must stop. `label` is a fixed word; `blocked` tells whether the host was put on the 24 hour list
 * (or already was, for "pausad").
 */
export class CityStop extends Error {
  constructor(
    readonly label: string,
    readonly blocked: boolean = false,
  ) {
    super(`Stadens e-tjänst: ${label}`);
    this.name = "CityStop";
  }
}

/** The slice of `fetch` this module uses. `globalThis.fetch` fits. */
export type CityFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface CityDeps {
  fetchImpl: CityFetch;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  log: (line: string) => void;
  /** Where the 24 hour block lives; tests pass a temp file. */
  gatesPath?: string;
  /** The directory the block file must stay inside; tests pass a temp directory. */
  dataDir?: string;
  /** At most this many requests from this client; the next call throws CityStop "budget" (no block). */
  budget?: number;
}

export interface CaseListAnswer {
  /** Stored build cases of the asked beteckning (exact match only). */
  cases: StoredCase[];
  /** Stored cases of the "other" list (OVK, lift orders); used at most for the hiss tag. */
  otherCases: StoredCase[];
  headingCount: number | null;
  termsLinks: string[];
  /**
   * The street addresses the exact-match rows are listed under (at most 40, each cut at 80 characters, no
   * duplicates). Kept in memory for the BRF-name rung (14.6-03); the case-list cache does not store them.
   */
  addresses: string[];
}

export interface ExtendedSearchParams {
  /** Stadsdel, spelled as the city's dropdown spells it ("Södermalm", "Vasastaden"). */
  district?: string;
  /** One search word ("stambyte"). */
  description?: string;
  /** YYYY-MM-DD. */
  from?: string;
  /** YYYY-MM-DD. */
  to?: string;
}

export type ExtendedSearchAnswer =
  | { ok: true; cases: SweepCase[]; headingCount: number | null }
  /** `storlek`: the page is over the cap. `antal`: the page's own count differs from its rows (a hidden cap). Both: split the window. */
  | { ok: false; reason: "storlek" | "antal" };

const fmtKb = (bytes: number) => Math.round(bytes / 1024).toString();
const fmtSec = (ms: number) => (ms / 1000).toFixed(1).replace(".", ",");

/** What a page that cannot be read means for the block label. */
const PARSE_LABEL: Record<ParseFailure, string> = {
  login: "inloggning",
  terms: "villkor",
  shape: "andrad-sida",
  count: "andrad-sida",
};

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A search value: 1 to `max` characters, no control characters. Throws a Swedish message before any request. */
function checkedText(value: string, what: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length === 0 || text.length > max || CONTROL_CHARS.test(text)) throw new Error(`Ogiltigt värde för ${what}`);
  return text;
}

/**
 * Reads a body. Over `max` bytes (declared or streamed) gives "overflow" - or, with `truncate`, the first `max`
 * bytes. The declared length is checked before reading.
 */
async function readCapped(response: Response, max: number, truncate = false): Promise<{ text: string; bytes: number } | "overflow"> {
  const declared = Number(response.headers.get("content-length"));
  if (!truncate && Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    return "overflow";
  }
  if (response.body === null) {
    const text = await response.text();
    const bytes = Buffer.byteLength(text);
    if (bytes <= max) return { text, bytes };
    return truncate ? { text: Buffer.from(text).subarray(0, max).toString("utf8"), bytes: max } : "overflow";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    chunks.push(value);
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      if (!truncate) return "overflow";
      return { text: Buffer.concat(chunks).subarray(0, max).toString("utf8"), bytes: max };
    }
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes: total };
}

export function makeCityClient(deps: CityDeps) {
  const gatesPath = deps.gatesPath ?? HOST_GATES_PATH;
  const dataDir = deps.dataDir ?? CITY_DATA_DIR;
  const budget = deps.budget ?? CITY_LIMITS.maxRequestsPerRun;
  const pacer = makeHostPacer({ now: () => deps.now().getTime(), sleep: deps.sleep });
  let used = 0;

  const line = (text: string) => deps.log(`[stockholm] ${text}`);

  /** Puts the host on the 24 hour list, says so, and ends the run. */
  function refuse(label: string): never {
    blockHost(gatesPath, CITY_HOST, label, deps.now(), { dir: dataDir, log: deps.log });
    line(`${CITY_HOST} blockerad i 24 timmar (${label})`);
    throw new CityStop(label, true);
  }

  /** Throws CityStop "pausad" when the host is on the block list. Makes no request. */
  function assertNotBlocked(): void {
    const gates = readHostGates(gatesPath, deps.log);
    const until = hostBlockedUntil(gates, CITY_HOST, deps.now());
    if (until === null) return;
    const reason = gates[CITY_HOST]?.reason ?? "okänd";
    if (gates[CITY_HOST]?.disabled === true) line(`Stadens e-tjänst avstängd (${reason})`);
    else line(`Stadens e-tjänst pausad till ${until.toISOString()} (${reason})`);
    throw new CityStop("pausad", true);
  }

  type Fetched = { text: string; status: number } | "overflow";

  /**
   * One GET: block check, budget, gate, ONE fetch, then status / content-type / size. `mode "robots"` skips the
   * HTML check, accepts any status below 500 except 403/429, and cuts the text instead of refusing it.
   */
  async function send(path: string, query: ReadonlyArray<readonly [string, string]>, mode: "page" | "robots"): Promise<Fetched> {
    assertNotBlocked();
    if (used >= budget) {
      line(`budgeten på ${budget} anrop är slut`);
      throw new CityStop("budget");
    }
    await pacer(CITY_HOST);
    used += 1;

    const url = new URL(`https://${CITY_HOST}${path}`);
    if (query.length > 0) url.search = query.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const started = deps.now().getTime();
    const took = () => fmtSec(deps.now().getTime() - started);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CITY_LIMITS.requestTimeoutMs);
    timer.unref?.();
    try {
      let response: Response;
      try {
        response = await deps.fetchImpl(url.toString(), {
          method: "GET",
          headers: { "User-Agent": CITY_USER_AGENT, Accept: mode === "robots" ? "text/plain" : "text/html" },
          redirect: "error",
          signal: controller.signal,
        });
      } catch (error) {
        line(`${CITY_HOST}${path} ${error instanceof Error ? error.name : "okänt fel"} (${took()} s)`);
        throw new CityStop("natverksfel");
      }
      const status = response.status;
      if (status === 403 || status === 429) {
        await response.body?.cancel().catch(() => undefined);
        line(`${CITY_HOST}${path} HTTP ${status} (${took()} s)`);
        return refuse(`http-${status}`);
      }
      const acceptable = mode === "robots" ? status >= 200 && status < 500 : status === 200;
      if (!acceptable) {
        await response.body?.cancel().catch(() => undefined);
        line(`${CITY_HOST}${path} HTTP ${status} (${took()} s)`);
        throw new CityStop(`http-${status}`);
      }
      if (mode === "page" && !(response.headers.get("content-type") ?? "").toLowerCase().includes("html")) {
        await response.body?.cancel().catch(() => undefined);
        line(`${CITY_HOST}${path} HTTP ${status}, fel innehållstyp (${took()} s)`);
        return refuse("fel-innehallstyp");
      }
      const body =
        mode === "robots"
          ? await readCapped(response, CITY_LIMITS.robotsMaxBytes, true)
          : await readCapped(response, CITY_LIMITS.maxBytes);
      if (body === "overflow") {
        line(`${CITY_HOST}${path} HTTP ${status}, för stort svar (${took()} s)`);
        return "overflow";
      }
      line(`${CITY_HOST}${path} HTTP ${status}, ${fmtKb(body.bytes)} kB, ${took()} s`);
      return { text: body.text, status };
    } finally {
      clearTimeout(timer);
    }
  }

  const LIST_PATH = "/byggochplantjansten/arendeochhandlingar";

  /** The case list of one fastighetsbeteckning (exact matches only), classified in memory. */
  async function caseList(beteckning: string): Promise<CaseListAnswer> {
    const wanted = checkedText(beteckning, "fastighetsbeteckning", 80);
    const page = await send(LIST_PATH, [["ExtendedAddress", "false"], ["RealEstateName", wanted]], "page");
    if (page === "overflow") throw new CityStop("storlek");
    const parsed = parseCaseList(page.text);
    if (!parsed.ok) return refuse(PARSE_LABEL[parsed.reason]);
    const store = (rows: typeof parsed.rows) =>
      exactMatchRows(rows, wanted).map((row) => toStoredCase(row, classifyDescription(row.description)));
    const addresses = [
      ...new Set(exactMatchRows(parsed.rows, wanted).flatMap((row) => row.addresses.map((a) => a.slice(0, 80)))),
    ].slice(0, 40);
    return {
      cases: store(parsed.rows),
      otherCases: store(parsed.otherRows),
      headingCount: parsed.headingCount,
      termsLinks: [...parsed.termsLinks],
      addresses,
    };
  }

  /**
   * One extended search (stadsdel + word + start-date window). The names are the unprefixed District, Description,
   * CaseStartDateFrom, CaseStartDateTo (R-01: the `SearchParameters.` prefix returns the empty form). A page that is
   * too big or whose own count differs from its rows is NOT a refusal: the caller splits the window.
   */
  async function extendedSearch(params: ExtendedSearchParams): Promise<ExtendedSearchAnswer> {
    const query: Array<readonly [string, string]> = [];
    if (params.district !== undefined) query.push(["District", checkedText(params.district, "stadsdel", 60)]);
    if (params.description !== undefined) query.push(["Description", checkedText(params.description, "sökord", 60)]);
    for (const [key, value] of [["CaseStartDateFrom", params.from], ["CaseStartDateTo", params.to]] as const) {
      if (value === undefined) continue;
      if (!DATE.test(value)) throw new Error(`Ogiltigt datum för ${key}: använd ÅÅÅÅ-MM-DD`);
      query.push([key, value]);
    }
    if (query.length === 0) throw new Error("En utökad sökning behöver minst ett filter");

    const page = await send(LIST_PATH, query, "page");
    if (page === "overflow") return { ok: false, reason: "storlek" };
    const parsed = parseCaseList(page.text);
    if (!parsed.ok) {
      if (parsed.reason === "count") return { ok: false, reason: "antal" };
      return refuse(PARSE_LABEL[parsed.reason]);
    }
    const cases: SweepCase[] = parsed.rows.map((row) => {
      const c = classifyDescription(row.description);
      return {
        rec: row.rec,
        beteckning: row.beteckning,
        addresses: row.addresses.slice(0, 20).map((a) => a.slice(0, 80)),
        startDate: row.startDate,
        kinds: [...c.kinds],
        primary: c.primary,
        tillsyn: c.tillsyn,
        archived: row.archived,
      };
    });
    return { ok: true, cases, headingCount: parsed.headingCount };
  }

  /** One case's detail page, reduced to decisions and dates (no officer, no documents, no free text). */
  async function caseDetail(rec: string, archived: boolean): Promise<CaseDetail> {
    if (!/^\d{1,12}$/.test(rec)) throw new Error("Ogiltigt rec-nummer: bara siffror (1-12 tecken)");
    const page = await send(
      `/Byggochplantjansten/arende/arende/${rec}`,
      [["dataSource", archived ? "Archived" : "Active"]],
      "page",
    );
    if (page === "overflow") throw new CityStop("storlek");
    const parsed = parseCaseDetail(page.text);
    if (!parsed.ok) return refuse(PARSE_LABEL[parsed.reason]);
    return parsed.detail;
  }

  /**
   * The city's "address to fastighetsbeteckning" lookup (a prefix match; the caller applies the equal-address rule).
   * An answer with no select list (an unknown address) is an empty list, not a refusal.
   */
  async function addressSearch(address: string): Promise<AddressOption[]> {
    const wanted = checkedText(address, "adress", 80);
    const page = await send("/Byggochplantjansten/CaseSearch/AddressSearch", [["addressSearchField", wanted]], "page");
    if (page === "overflow") throw new CityStop("storlek");
    return parseAddressFragment(page.text) ?? [];
  }

  /** robots.txt: status and text (cut at 64 KB). A 404 is a normal answer. */
  async function robots(): Promise<{ status: number; text: string }> {
    const page = await send("/robots.txt", [], "robots");
    if (page === "overflow") throw new CityStop("storlek");
    return { status: page.status, text: page.text };
  }

  return { caseList, extendedSearch, caseDetail, addressSearch, robots };
}

export type CityClient = ReturnType<typeof makeCityClient>;
