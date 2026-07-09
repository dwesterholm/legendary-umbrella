# Phase 5: Owned Booli Acquisition - Context

**Gathered:** 2026-07-06
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped via workflow.skip_discuss) + enriched with verified spike findings

<domain>
## Phase Boundary

Own the Booli acquisition layer for both single listings and area searches, with an observable fallback tree — so the product no longer silently depends on the paid Apify actor and has the area-search foundation discovery (Phase 9) needs. Requirements: ACQ-01, ACQ-02, ACQ-03. See ROADMAP.md Phase 5 for full Approach + Success Criteria.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
Implementation choices at Claude's discretion, guided by the ROADMAP phase goal, success criteria, and codebase conventions — EXCEPT the pre-decided direction below, which is not open for re-litigation.

### Pre-decided (verified 2026-07-06 — do NOT re-research)
- **Generalize the PROVEN transport, do NOT build a keyless GraphQL client.** The SSR `__NEXT_DATA__ → props.pageProps.__APOLLO_STATE__` scrape via `apify/playwright-scraper` (chromium) + Apify `RESIDENTIAL`/`SE` proxy already ships in production in [src/lib/market/sold-source.ts](../../../src/lib/market/sold-source.ts). Raw `fetch` (even via the residential proxy) → 403; the `/graphql` POST → 403 (a separate, stricter Cloudflare zone). Both are dead ends — do not pursue them.
- **Target shape:** unify active + sold behind one `src/lib/booli/client.ts`; fallback tree direct → Apify SE-residential proxy → paid actor (`bpf1JaYRBbia2nQU9`) as last resort. Drop-in for `scrapeBooli()`; keep output shape so `normalizeScraperOutput` is untouched.
- **The spike is a NARROW confirmation, not a redo.** `03-SPIKE.md` §2 already scraped the listing **detail page** and read `breadcrumbs` from its Apollo state, proving the detail page SSRs its `Listing` object via the same transport. Residual (~1–2h): (1) confirm the detail-page `__APOLLO_STATE__` `Listing:<booliId>` has **full field parity** with the paid actor so it can be dropped with zero field loss; (2) pin the exact Apollo key/path. Escalate only if parity is incomplete.

</decisions>

<code_context>
## Existing Code Insights

- [src/lib/market/sold-source.ts](../../../src/lib/market/sold-source.ts) — the proven transport + `PAGE_FUNCTION` reading `__APOLLO_STATE__`; the pattern to generalize.
- [src/lib/apify/booli-scraper.ts](../../../src/lib/apify/booli-scraper.ts) — the current paid-actor wrapper (`bpf1JaYRBbia2nQU9`) that this phase replaces as the default path.
- [.planning/phases/03-market-context/03-SPIKE.md](../03-market-context/03-SPIKE.md) — canonical transport/field/cost evidence (GO, ~$0.0055/render, 4/4 reliable, keyless, no new deps).
- [.planning/spikes/booli-own-acquisition-SPIKE.md](../../spikes/booli-own-acquisition-SPIKE.md) — the 999.6 brief (field parity + transport confirmed).

</code_context>

<specifics>
## Specific Ideas

Refer to ROADMAP.md Phase 5 Approach, Spike (NARROW confirmation), and the 4 success criteria. Secret posture: keyless SSR path; only `APIFY_API_TOKEN` (already configured, server-only). No new env var, no `serverExternalPackages` change expected.

</specifics>

<deferred>
## Deferred Ideas

Broker-page field recovery (floor/brfName/renovation) is Phase 6 — but note `03-SPIKE.md` appendix suggests brfName (final breadcrumb) and floor (`infoPoints`) may already be present in the detail-page Apollo state; Phase 6's spike checks that first.

</deferred>
