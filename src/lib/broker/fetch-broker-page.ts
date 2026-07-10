import { Agent } from "undici";
import { resolveSafeExternalUrl } from "./url-guard";
import { parseBrokerPage, type BrokerFields } from "./parse-broker-page";

/**
 * fetch-broker-page.ts — SSRF-guarded, best-effort fetch + parse of a broker's
 * own listing page (LSTG-03/04). Every failure path (guard rejection, non-2xx,
 * an unfollowable redirect, network error, malformed HTML) returns `null` —
 * this function NEVER throws, so a broker-page failure can never fail the
 * primary analysis (independent-degradation, T-06-07).
 *
 * DNS-rebinding TOCTOU fix (CR-01): `resolveSafeExternalUrl` resolves the
 * hostname EXACTLY ONCE and returns the validated address, pinned as the TCP
 * connection target via a per-request undici `Agent` (`connect.lookup`
 * override). The URL's hostname is still sent as Host/SNI, so the request
 * reaches the right vhost, but `fetch()` can never re-resolve to a different
 * (attacker-rebound) address.
 *
 * ONE SAFE REDIRECT HOP (2026-07-10): real broker CMSs almost always answer
 * the Booli-supplied `agencyListingUrl` with a 3xx (http→https, trailing
 * slash, canonical host) — refusing all redirects made broker enrichment
 * (text AND images) silently always-empty. We now follow at most ONE hop, and
 * the redirect target is re-validated through the SAME resolve-then-pin guard
 * (`guardedGet`), so the SSRF/rebinding posture is preserved: a redirect to an
 * internal address is still rejected. No chains — a second redirect is refused.
 */

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "sv-SE,sv;q=0.9,en;q=0.8",
} as const;

type GetOutcome =
  | { kind: "html"; html: string }
  | { kind: "redirect"; location: string | null }
  | { kind: "fail" };

/**
 * Fetches ONE url through the resolve-then-pin SSRF guard. Returns the HTML, a
 * redirect signal (with the raw Location), or a generic fail — never throws.
 * Owns its Agent's full lifecycle (destroyed in `finally`).
 */
async function guardedGet(url: string): Promise<GetOutcome> {
  let pinnedAgent: Agent | null = null;
  try {
    const resolved = await resolveSafeExternalUrl(url);
    if (!resolved) {
      console.error("[broker]", `rejected unsafe URL: ${safeUrlForLog(url)}`);
      return { kind: "fail" };
    }

    pinnedAgent = new Agent({
      connect: {
        lookup: (_hostname, options, callback) => {
          // Honor undici's requested address family (WR-01); we validated
          // exactly one address, so fail closed on a family we can't satisfy.
          const wantFamily = typeof options?.family === "number" ? options.family : 0;
          if (wantFamily !== 0 && wantFamily !== resolved.family) {
            callback(new Error("SSRF_GUARD_FAMILY_MISMATCH"), []);
            return;
          }
          callback(null, [{ address: resolved.address, family: resolved.family }]);
        },
      },
    });

    const res = await fetch(url, {
      redirect: "manual",
      dispatcher: pinnedAgent,
      headers: BROWSER_HEADERS,
    } as RequestInit);

    if (res.type === "opaqueredirect") return { kind: "redirect", location: null };
    if (res.status >= 300 && res.status < 400) {
      return { kind: "redirect", location: res.headers.get("location") };
    }
    if (!res.ok) {
      console.error("[broker]", `${safeUrlForLog(url)} → HTTP ${res.status}`);
      return { kind: "fail" };
    }
    return { kind: "html", html: await res.text() };
  } catch (error) {
    // Log the sanitized target + error name only — never the raw error (whose
    // message can embed the full URL incl. any userinfo credentials) (WR-02).
    console.error("[broker]", `fetch failed for ${safeUrlForLog(url)}`, {
      code: error instanceof Error ? error.name : "UNKNOWN",
    });
    return { kind: "fail" };
  } finally {
    if (pinnedAgent) await pinnedAgent.destroy().catch(() => undefined);
  }
}

export async function fetchBrokerListingPage(url: string): Promise<BrokerFields | null> {
  let outcome = await guardedGet(url);

  // One safe redirect hop — the target is re-validated by guardedGet's own
  // resolve-then-pin guard, so SSRF/rebinding protection is preserved.
  if (outcome.kind === "redirect") {
    const target = resolveRedirectTarget(url, outcome.location);
    if (!target) {
      console.error("[broker]", `refused redirect response for ${safeUrlForLog(url)}`);
      return null;
    }
    outcome = await guardedGet(target);
    if (outcome.kind === "redirect") {
      // No chains — one hop only.
      console.error("[broker]", `refused second redirect for ${safeUrlForLog(target)}`);
      return null;
    }
  }

  if (outcome.kind !== "html") return null;
  return parseBrokerPage(outcome.html);
}

/**
 * Resolves a redirect `Location` (absolute or relative) against the origin url
 * into an absolute https URL, or `null` if absent/unparseable/non-https. Only
 * https targets are followed (guardedGet re-validates the address regardless).
 */
function resolveRedirectTarget(fromUrl: string, location: string | null): string | null {
  if (!location) return null;
  try {
    const target = new URL(location, fromUrl);
    return target.protocol === "https:" ? target.toString() : null;
  } catch {
    return null;
  }
}

/**
 * A broker URL is attacker-influenceable (Booli-sourced `agencyListingUrl`) and
 * `new URL` preserves any `user:pass@` userinfo, so logging the raw URL could
 * leak credentials. Reduce to `origin + pathname` (drops userinfo/query/
 * fragment); fall back to a placeholder if the string won't parse (WR-02).
 */
function safeUrlForLog(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<unparseable-url>";
  }
}
