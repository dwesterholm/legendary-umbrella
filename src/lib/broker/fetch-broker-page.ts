import { Agent } from "undici";
import { resolveSafeExternalUrl } from "./url-guard";
import { parseBrokerPage, type BrokerFields } from "./parse-broker-page";

/**
 * fetch-broker-page.ts — SSRF-guarded, best-effort fetch + parse of a
 * broker's own listing page (LSTG-03/04). Adapts `src/lib/market/scb.ts`'s
 * `fetchScbTable` house pattern (native `fetch`, try/catch → null, no
 * Playwright — broker CMS sites are not behind Booli's Cloudflare wall) to a
 * GET request against an arbitrary third-party URL.
 *
 * Every failure path (guard rejection, non-2xx, redirect, network error,
 * malformed HTML) returns `null` — this function NEVER throws. The caller
 * (Plan 03's `analyzeUrl`) relies on null-not-throw so a broker-page failure
 * can never fail the primary listing analysis (independent-degradation
 * pattern, T-06-07).
 *
 * CR-01 — DNS-rebinding TOCTOU fix: `resolveSafeExternalUrl` resolves the
 * hostname EXACTLY ONCE and returns the validated address. That resolved
 * address is then pinned as the actual TCP connection target via a
 * per-request undici `Agent` with a custom `connect.lookup` override — the
 * URL's original hostname is still sent as the Host header / TLS SNI (only
 * the connect-time address resolution is overridden), so the request still
 * reaches the correct virtual host, but `fetch()` can never independently
 * re-resolve the hostname to a different (attacker-rebound) address. The
 * address validated by the guard is therefore guaranteed to be the address
 * the socket actually connects to.
 */
export async function fetchBrokerListingPage(url: string): Promise<BrokerFields | null> {
  // `let` at function scope so the `finally` can always tear the Agent down
  // (WR-02 — sibling of allabrf.ts's leak). resolveSafeExternalUrl stays INSIDE
  // the try so even a defensive throw from it still degrades to null, never
  // propagating (this function's never-throw contract, T-06-07).
  let pinnedAgent: Agent | null = null;
  try {
    const resolved = await resolveSafeExternalUrl(url);
    if (!resolved) {
      console.error("[broker]", `rejected unsafe URL: ${safeUrlForLog(url)}`);
      return null;
    }

    pinnedAgent = new Agent({
      connect: {
        lookup: (_hostname, options, callback) => {
          // WR-01 (shard-2 review): honor undici's requested address family.
          // We validated exactly ONE address; if undici explicitly asks for the
          // other family (dual-stack host), we cannot satisfy it without a
          // second, UNVALIDATED resolution — so fail closed (→ fetch error →
          // null) rather than returning a family-mismatched address that would
          // surface as an opaque connect failure. family 0 = "any" is fine.
          const wantFamily = typeof options?.family === "number" ? options.family : 0;
          if (wantFamily !== 0 && wantFamily !== resolved.family) {
            callback(new Error("SSRF_GUARD_FAMILY_MISMATCH"), []);
            return;
          }
          callback(null, [{ address: resolved.address, family: resolved.family }]);
        },
      },
    });

    // redirect: "manual" — a redirect response is treated as a failure
    // rather than followed, so a 3xx cannot smuggle the request to an
    // internal target after the SSRF guard already passed (DNS-rebinding /
    // TOCTOU mitigation, T-06-04, Pitfall 2). Combined with the pinned
    // dispatcher above, even the INITIAL request cannot diverge from the
    // validated address.
    //
    // Send realistic browser request headers. A bare (UA-less) fetch is 403'd
    // by most broker CMS / Cloudflare / Akamai front-ends, which was the
    // dominant cause of broker enrichment silently failing. This does NOT relax
    // the SSRF posture — the connection is still pinned to the guard-validated
    // address and redirects are still refused; only the request headers change.
    const res = await fetch(url, {
      redirect: "manual",
      dispatcher: pinnedAgent,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "sv-SE,sv;q=0.9,en;q=0.8",
      },
    } as RequestInit);

    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      console.error("[broker]", `refused redirect response for ${safeUrlForLog(url)}`);
      return null;
    }

    if (!res.ok) {
      console.error("[broker]", `${safeUrlForLog(url)} → HTTP ${res.status}`);
      return null;
    }

    const html = await res.text();
    return parseBrokerPage(html);
  } catch (error) {
    // WR-02: log the sanitized target + the error's message/name only — never
    // the raw error object (whose message can embed the full URL, incl. any
    // userinfo credentials).
    console.error("[broker]", `fetch failed for ${safeUrlForLog(url)}`, {
      code: error instanceof Error ? error.name : "UNKNOWN",
    });
    return null;
  } finally {
    // WR-02 (shard-4 review): tear down the per-request Agent's connection pool
    // (null if we failed before/at resolution).
    if (pinnedAgent) await pinnedAgent.destroy().catch(() => undefined);
  }
}

/**
 * WR-02 (shard-2 review): a broker URL is attacker-influenceable (Booli-sourced
 * `agencyListingUrl`) and `new URL` preserves any `user:pass@` userinfo, so
 * logging the raw URL could leak credentials into server logs. Reduce to
 * `origin + pathname` (drops userinfo, query, and fragment); fall back to a
 * fixed placeholder if the string won't even parse.
 */
function safeUrlForLog(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<unparseable-url>";
  }
}
