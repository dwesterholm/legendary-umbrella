/**
 * image-host.ts - the Booli image-host allowlist as a PURE module (no network,
 * no transport import). It lives here, not in client.ts, so the pure
 * discovery modules (candidate.ts, vision-schema.ts) and the offline replay
 * path load no Apify transport code (14.1-03 deviation 1, 14.1-09). client.ts
 * re-exports it, so every existing import keeps working.
 */

/**
 * SSRF defense-in-depth (T-11-02, mirrors `isBooliUrl`'s real-hostname-check
 * discipline, NEVER a substring match): only Booli's own CDN host(s) are
 * allowed through. Even though Anthropic's servers (not this app) perform the
 * actual image fetch, this filter ensures the PII-safe persisted allowlist
 * itself never carries a non-Booli-CDN URL.
 *
 * WR-03 (11-REVIEW.md): this allowlist is intentionally restricted to
 * `booli.se`/`*.booli.se` — the ONLY hosts 11-RESEARCH.md's SSRF discussion
 * (line 614) and Assumption A1 (line 515) ever reference. A `*.bcdn.se`
 * entry was previously added here speculatively, without the probe-pinning
 * discipline the rest of this file follows (contrast
 * `LISTING_ENTITY_PREFIX`, pinned via `05-PROBE-FINDINGS.md`) — there is no
 * probe finding or research citation confirming `bcdn.se` as a real,
 * Booli-owned CDN host. Since this allowlist is the ONE place standing
 * between an Apollo-supplied URL and inclusion in the PII-safe persisted
 * `imageUrls` field (and subsequently sent to Anthropic's image fetcher),
 * widening it ahead of confirmation would speculatively expand the SSRF
 * surface.
 *
 * UAT FOLLOW-UP RESOLVED (2026-07-09): a live headless render of a real Booli
 * detail page (`/bostad/708259`) confirmed Booli serves ALL gallery/interior/
 * floor-plan images from `bcdn.se` (e.g. `https://bcdn.se/images/cache/
 * 54356971_1440x0.webp`), never from `booli.se`. `bcdn.se` is therefore added
 * here WITH that probe confirmation (not speculatively) — without it,
 * `extractImageUrls` filtered out every image and the vision pass could never
 * run (always `no_images`). `hm.bcdn.se` (broker-logo subdomain) is covered by
 * the `.bcdn.se` suffix match.
 *
 * WR-03 (12-REVIEW.md): exported (was module-private) so `candidate.ts`'s
 * READ-path Zod guard (`discoveryCandidateSchema`) can re-apply this SAME
 * check to a persisted/legacy row's `imageUrls` before it is trusted for
 * rendering — defense-in-depth so a write-path-only check is never the sole
 * thing standing between a tampered/corrupted row and an `<img src={...}>`.
 */
export function isAllowedImageHost(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== "https:") return false;
    return (
      hostname === "booli.se" ||
      hostname.endsWith(".booli.se") ||
      hostname === "bcdn.se" ||
      hostname.endsWith(".bcdn.se")
    );
  } catch {
    return false;
  }
}
