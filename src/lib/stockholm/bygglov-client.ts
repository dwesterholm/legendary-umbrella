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
 *
 * LOGS (T-14.6-13): host, path WITHOUT query, HTTP status, kB and seconds, or a fixed label. Never a URL query, a
 * body, a header or a cookie. Every line starts with "[stockholm] ".
 */
import { exactMatchRows, parseCaseList } from "@/lib/stockholm/bygglov-parse";
import { classifyDescription, toStoredCase, type StoredCase } from "@/lib/stockholm/bygglov-classify";
import { makeHostPacer } from "@/lib/stockholm/host-gate";

/** The only host this client may call. */
export const CITY_HOST = "etjanster.stockholm.se";

export const CITY_USER_AGENT = "bostadai-bygglov/1.0 (personal research; cached, 1 request per 3 s)";

export const CITY_LIMITS = {
  /** A page above this is refused (the biggest page seen is 835 KB). */
  maxBytes: 5 * 1024 * 1024,
  requestTimeoutMs: 30_000,
};

/** A run that must stop. `label` is a fixed word; `blocked` tells whether the host was put on the 24 hour list. */
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
}

export interface CaseListAnswer {
  /** Stored build cases of the asked beteckning (exact match only). */
  cases: StoredCase[];
  /** Stored cases of the "other" list (OVK, lift orders); used at most for the hiss tag. */
  otherCases: StoredCase[];
  headingCount: number | null;
  termsLinks: string[];
}

const fmtKb = (bytes: number) => Math.round(bytes / 1024).toString();
const fmtSec = (ms: number) => (ms / 1000).toFixed(1).replace(".", ",");

/** Reads a body, giving up as soon as it passes the cap; the declared length is checked before reading. */
async function readCapped(response: Response, max: number): Promise<{ text: string; bytes: number } | "overflow"> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    return "overflow";
  }
  if (response.body === null) {
    const text = await response.text();
    const bytes = Buffer.byteLength(text);
    return bytes > max ? "overflow" : { text, bytes };
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
      return "overflow";
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes: total };
}

export function makeCityClient(deps: CityDeps) {
  const pacer = makeHostPacer({ now: () => deps.now().getTime(), sleep: deps.sleep });

  const line = (text: string) => deps.log(`[stockholm] ${text}`);

  /** One GET: gate, one attempt, status / content-type / size checks. Returns the page text or "overflow". */
  async function getHtml(path: string, query: ReadonlyArray<readonly [string, string]>): Promise<string | "overflow"> {
    await pacer(CITY_HOST);
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
          headers: { "User-Agent": CITY_USER_AGENT, Accept: "text/html" },
          redirect: "error",
          signal: controller.signal,
        });
      } catch (error) {
        line(`${CITY_HOST}${path} ${error instanceof Error ? error.name : "okänt fel"} (${took()} s)`);
        throw new CityStop("natverksfel");
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        line(`${CITY_HOST}${path} HTTP ${response.status} (${took()} s)`);
        throw new CityStop(`http-${response.status}`);
      }
      if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("html")) {
        await response.body?.cancel().catch(() => undefined);
        line(`${CITY_HOST}${path} fel innehållstyp (${took()} s)`);
        throw new CityStop("fel-innehallstyp");
      }
      const body = await readCapped(response, CITY_LIMITS.maxBytes);
      if (body === "overflow") {
        line(`${CITY_HOST}${path} HTTP 200, för stort svar (${took()} s)`);
        return "overflow";
      }
      line(`${CITY_HOST}${path} HTTP 200, ${fmtKb(body.bytes)} kB, ${took()} s`);
      return body.text;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The case list of one fastighetsbeteckning (exact matches only), classified in memory. */
  async function caseList(beteckning: string): Promise<CaseListAnswer> {
    const html = await getHtml("/byggochplantjansten/arendeochhandlingar", [
      ["ExtendedAddress", "false"],
      ["RealEstateName", beteckning],
    ]);
    if (html === "overflow") throw new CityStop("storlek");
    const parsed = parseCaseList(html);
    if (!parsed.ok) throw new CityStop("andrad-sida");
    const store = (rows: typeof parsed.rows) =>
      exactMatchRows(rows, beteckning).map((row) => toStoredCase(row, classifyDescription(row.description)));
    return {
      cases: store(parsed.rows),
      otherCases: store(parsed.otherRows),
      headingCount: parsed.headingCount,
      termsLinks: [...parsed.termsLinks],
    };
  }

  return { caseList };
}

export type CityClient = ReturnType<typeof makeCityClient>;
