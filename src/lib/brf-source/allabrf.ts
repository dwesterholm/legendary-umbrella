import { Agent } from "undici";
import * as cheerio from "cheerio";
import { resolveSafeExternalUrl } from "@/lib/broker/url-guard";
import { ixbrlToPlainText } from "@/lib/brf/ixbrl-to-text";
import { isValidOrgNr } from "@/lib/brf-source/org-nr-resolver";

/**
 * allabrf.ts — SSRF-guarded fetch of Allabrf's public pages (name→org.nr
 * candidate search, org.nr→document retrieval), the v1 auto-fetch rung
 * (08-RESEARCH.md Open Question 2 — Bolagsverket bulk-feed DEFERRED).
 *
 * SSRF guard discipline (T-08-05) — copied from `fetch-broker-page.ts`'s
 * resolve-then-pin orchestration, applied on TOP of a host allowlist (this
 * file's own `assertAllowedHost`, IN ADDITION to `resolveSafeExternalUrl`,
 * not instead of it — Allabrf is a single known-good domain so an allowlist
 * is cheap defense-in-depth, but the shared guard is still required because
 * `resolveSafeExternalUrl` is the only thing that resolves-then-pins the DNS
 * result to defeat rebinding TOCTOU; a host string check alone cannot do
 * that): resolve the hostname exactly once via `resolveSafeExternalUrl`
 * (imported, never forked — see url-guard.ts's own doc comment on why a
 * bespoke DNS/IP classifier must not be reinvented per call site), pin the
 * TCP connection to that resolved address via a per-request `undici.Agent`,
 * send the request with `redirect: "manual"`, and treat any 3xx/opaque
 * redirect as a failure rather than following it.
 *
 * V5 Input Validation (T-08-05): an org.nr is validated via `isValidOrgNr`
 * BEFORE any URL is constructed — a malformed/attacker-crafted org.nr never
 * reaches `new URL(...)`, closing the SSRF-via-org.nr-interpolation path at
 * its source.
 *
 * Every failure path (guard rejection, disallowed host, non-2xx, redirect,
 * oversized body, malformed HTML, network error) degrades to `null`/`[]` —
 * this module NEVER throws (mirrors `fetch-broker-page.ts`/`parse-broker-
 * page.ts`'s independent-degradation contract, T-08-09's caller,
 * `fetch-document.ts`, treats a null/[] rung result as "this rung failed,
 * try the next one").
 *
 * GDPR / T-08-08: every logged line emits only a stable `[brf-source]`/
 * `[allabrf]` code plus a host/org.nr/id — never scraped HTML, financial
 * figures, board-member names, or other PII.
 */

/** Allabrf hosts this fetch is permitted to talk to (defense-in-depth on top of resolveSafeExternalUrl). */
const ALLABRF_ALLOWED_HOSTS = new Set(["allabrf.se", "www.allabrf.se", "sv.allabrf.se"]);

/** Bounds a fetched document's body so an oversized response is never fully buffered into extraction. */
const MAX_DOC_BYTES = 8 * 1024 * 1024; // 8 MB

/**
 * Rejects any URL whose hostname is not on the Allabrf allowlist. This is
 * IN ADDITION to `resolveSafeExternalUrl`'s private/loopback/link-local
 * classification, not a substitute for it.
 *
 * Exported for direct unit testing of the allowlist decision (both
 * `searchUrlFor`/`documentUrlFor` always construct an allowed-host URL, so
 * exercising the rejection path end-to-end from the public API would
 * require breaking that invariant — this function is the honest seam).
 */
export function assertAllowedHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLABRF_ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function searchUrlFor(brfName: string): string {
  return `https://www.allabrf.se/sok/?q=${encodeURIComponent(brfName)}`;
}

function documentUrlFor(orgNr: string): string {
  return `https://www.allabrf.se/brf/${encodeURIComponent(orgNr)}/`;
}

/**
 * Runs the shared resolve-then-pin SSRF guard + host allowlist for `url`.
 * Returns a ready-to-use pinned `Agent`, or `null` if the URL fails any
 * guard — logging a coded `[brf-source][allabrf]` line on rejection.
 */
async function guardedAgentFor(url: string): Promise<Agent | null> {
  if (!assertAllowedHost(url)) {
    console.error("[brf-source][allabrf]", "rejected disallowed host", {
      host: safeHostOf(url),
    });
    return null;
  }

  const resolved = await resolveSafeExternalUrl(url);
  if (!resolved) {
    console.error("[brf-source][allabrf]", "rejected unsafe URL", {
      host: safeHostOf(url),
    });
    return null;
  }

  return new Agent({
    connect: {
      lookup: (_hostname, _options, callback) => {
        callback(null, [{ address: resolved.address, family: resolved.family }]);
      },
    },
  });
}

function safeHostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid-url";
  }
}

/**
 * Fetches `url` through the guard, treats 3xx/opaqueredirect/non-2xx as
 * failure, and returns the body text CAPPED at `MAX_DOC_BYTES` — a larger
 * response is truncated to the cap rather than fully buffered, per T-08-07.
 * Returns `null` on any failure; never throws.
 */
async function guardedFetchText(url: string): Promise<string | null> {
  // WR-02 (shard-4 review): the per-request undici Agent owns a connection
  // pool; without an explicit destroy it leaks sockets across repeated
  // auto-fetches. Create it outside the try so `finally` can always tear it
  // down.
  const pinnedAgent = await guardedAgentFor(url);
  if (!pinnedAgent) return null;
  try {
    const res = await fetch(url, {
      redirect: "manual",
      dispatcher: pinnedAgent,
    } as RequestInit);

    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      console.error("[brf-source][allabrf]", "refused redirect response", {
        host: safeHostOf(url),
        status: res.status,
      });
      return null;
    }

    if (!res.ok) {
      console.error("[brf-source][allabrf]", "non-2xx response", {
        host: safeHostOf(url),
        status: res.status,
      });
      return null;
    }

    return await readBoundedText(res);
  } catch (error) {
    console.error("[brf-source][allabrf]", "fetch failed", {
      host: safeHostOf(url),
      code: error instanceof Error ? error.name : "UNKNOWN",
    });
    return null;
  } finally {
    await pinnedAgent.destroy().catch(() => undefined);
  }
}

/**
 * Reads a Response body capped at `MAX_DOC_BYTES` bytes — an oversized body
 * is truncated rather than fully buffered (T-08-07 DoS/cost mitigation).
 * Falls back to `res.text()` (still bounded by the caller re-slicing) if the
 * body is not a readable stream in the current runtime.
 */
async function readBoundedText(res: Response): Promise<string> {
  const body = res.body;
  if (!body || typeof (body as ReadableStream).getReader !== "function") {
    const full = await res.text();
    return full.length > MAX_DOC_BYTES ? full.slice(0, MAX_DOC_BYTES) : full;
  }

  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > MAX_DOC_BYTES) {
      const overshoot = received - MAX_DOC_BYTES;
      chunks.push(value.slice(0, value.byteLength - overshoot));
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }

  // WR-03 (shard-4 review): decode INCREMENTALLY with a streaming decoder so a
  // multi-byte UTF-8 sequence split across the byte-cap truncation (very likely
  // for Swedish å/ä/ö, 2 bytes each) doesn't corrupt into U+FFFD mid-text. The
  // final flush surfaces any incomplete trailing sequence left by the cut; we
  // trim that single trailing replacement char rather than persist it.
  const decoder = new TextDecoder("utf-8");
  let text = "";
  for (const chunk of chunks) {
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return text.replace(/�+$/, "");
}

/** A single name-search result candidate from Allabrf's search page. */
export interface AllabrfCandidate {
  orgNr: string;
  name: string;
  kommun: string | null;
}

/**
 * Searches Allabrf by BRF name, returning parsed `{orgNr, name, kommun}`
 * candidates. Never throws — any guard rejection, fetch failure, or
 * malformed-HTML parse failure degrades to `[]`.
 */
export async function searchAllabrfByName(brfName: string): Promise<AllabrfCandidate[]> {
  if (!brfName || brfName.trim().length === 0) return [];

  const html = await guardedFetchText(searchUrlFor(brfName));
  if (html === null) return [];

  try {
    return parseSearchResults(html);
  } catch (error) {
    console.error("[brf-source][allabrf]", "search parse failed", {
      code: error instanceof Error ? error.name : "UNKNOWN",
    });
    return [];
  }
}

/**
 * Parses Allabrf search-result rows out of HTML. Mirrors
 * `parse-broker-page.ts`'s try/catch-per-block discipline — a malformed row
 * is skipped, never allowed to throw out of the loop.
 */
function parseSearchResults(html: string): AllabrfCandidate[] {
  const $ = cheerio.load(html);
  const candidates: AllabrfCandidate[] = [];

  $("[data-orgnr]").each((_, el) => {
    try {
      const node = $(el);
      const orgNr = node.attr("data-orgnr")?.trim();
      const name = node.attr("data-name")?.trim() ?? node.text().trim();
      const kommun = node.attr("data-kommun")?.trim() || null;
      if (!orgNr || !name) return;
      candidates.push({ orgNr, name, kommun });
    } catch {
      // Malformed row — skip, don't throw (parse-broker-page.ts discipline).
    }
  });

  return candidates;
}

/** A fetched Allabrf document, stripped to plain text, with fiscal-year metadata. */
export interface AllabrfDocument {
  text: string;
  fiscalYear: number | null;
  availableYears: number[];
}

/**
 * Fetches the årsredovisning document for `orgNr` from Allabrf. Rejects an
 * invalid org.nr BEFORE constructing any URL (T-08-05 — no SSRF via
 * org.nr interpolation). Returns `null` on any failure; never throws.
 */
export async function fetchAllabrfDocument(orgNr: string): Promise<AllabrfDocument | null> {
  if (!isValidOrgNr(orgNr)) {
    console.error("[brf-source][allabrf]", "rejected invalid org.nr format");
    return null;
  }

  const html = await guardedFetchText(documentUrlFor(orgNr));
  if (html === null) return null;

  try {
    return parseDocumentPage(html);
  } catch (error) {
    console.error("[brf-source][allabrf]", "document parse failed", {
      code: error instanceof Error ? error.name : "UNKNOWN",
    });
    return null;
  }
}

/**
 * Parses a fetched Allabrf document page: strips the iXBRL/HTML to plain
 * text via `ixbrlToPlainText`, and reads the fiscal year + the list of
 * available fiscal years Allabrf exposes for that BRF (used by
 * `fetch-document.ts`'s staleness flag). Never throws — a document with no
 * discoverable fiscal-year markers degrades to `fiscalYear: null,
 * availableYears: []`, never a fabricated guess.
 */
function parseDocumentPage(html: string): AllabrfDocument {
  const $ = cheerio.load(html);

  let fiscalYear: number | null = null;
  const fiscalYearAttr = $("[data-fiscal-year]").first().attr("data-fiscal-year");
  if (fiscalYearAttr && /^\d{4}$/.test(fiscalYearAttr)) {
    fiscalYear = Number(fiscalYearAttr);
  }

  const availableYears: number[] = [];
  $("[data-available-year]").each((_, el) => {
    try {
      const value = $(el).attr("data-available-year");
      if (value && /^\d{4}$/.test(value)) {
        availableYears.push(Number(value));
      }
    } catch {
      // Malformed year node — skip, don't throw.
    }
  });

  // WR-05 (shard-4 review): the fiscalYear read from `.first([data-fiscal-year])`
  // can be a sidebar/nav node rather than the rendered document's own year. If
  // we DO have a list of available years and the picked value isn't among them,
  // it's internally inconsistent — degrade to null (which also nulls the
  // derived isMostRecent) rather than persist a possibly-wrong year. Pitfall-5
  // "silently stale" guard; a fabricated/mismatched year is worse than none.
  if (fiscalYear !== null && availableYears.length > 0 && !availableYears.includes(fiscalYear)) {
    fiscalYear = null;
  }

  const text = ixbrlToPlainText(html);

  return { text, fiscalYear, availableYears };
}
