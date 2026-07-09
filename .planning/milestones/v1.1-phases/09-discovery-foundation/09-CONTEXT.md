# Phase 9: Discovery Foundation - Context

**Gathered:** 2026-07-06
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped) + explicit operator legal decision

<domain>
## Phase Boundary

Let a user describe desired properties in free text (+ a few hard filters) and get back matching candidate listings, produced by a bounded, cost-capped background job with progress polling — behind a documented legal go/no-go gate and PII guardrails.

</domain>

<decisions>
## Implementation Decisions

### Legal Posture — Conservative GO (LOCKED, operator decision 2026-07-06)
- Area-wide proactive scraping is provisionally sanctioned as a **conservative GO** (operator chose this over halt).
- Discovery MUST ship behind a **feature flag, OFF by default**. The flag must not be turned on until the operator completes the final legal sign-off (re-read Booli/Hemnet ToS, re-derive proportionality).
- **Strict per-query AND per-day scrape request caps enforced in code** (not just config).
- **Hard per-search caps**: candidate count (20–30), images/listing, and total SEK — checked INCREMENTALLY per slice, never only at the end.
- **Kill switch**: degrade to single-URL-only if Booli signals displeasure (CAPTCHA/blocking).
- **PII/GDPR guardrails**: ignore people and personal documents; do NOT persist raw scraped fields beyond the ranked result.
- PROJECT.md "Legal" line has been updated to reflect this provisional posture (final sign-off remains operator action).

### Architecture (from ROADMAP approach — binding)
- **DB-row-as-job-queue**: a `discovery_jobs` table (new migration, next is 010). NO new infra.
- **Vercel Cron poller** processing small bounded slices; atomic-CAS claim extended to `FOR UPDATE SKIP LOCKED` (build it as a CORRECT atomic claim — note the Phase 8 review found a check-then-act CAS bug; do not repeat).
- A cheap Claude call translates free text → structured search filters.
- Client polls `discovery_jobs.status`/`processed_count` like `BrfProgress`; results persist, viewable at a distinct `/discover/[jobId]` route.
- Reuse Phase 5's owned area-search client (`fetchAreaListings` / area resolution) for the scrape.
- Honest reporting: "12 av 25 annonser analyserade"; report scanned-vs-shown; never exceed per-search cost cap.

### Claude's Discretion
All other implementation choices are at Claude's discretion (discuss skipped) within the above locked constraints and the ROADMAP success criteria.

</decisions>

<code_context>
## Existing Code Insights

Reuse: Phase 5 owned area-search client (`src/lib/booli/client.ts` — fetchAreaListings/resolveAreaId), the `generateReport` atomic-lock/CAS + BrfProgress polling patterns (build the discovery claim as a CORRECT atomic CAS / FOR UPDATE SKIP LOCKED), cost-cap discipline (costSek gates), and the additive-nullable migration convention (next migration 010). Gathered further during plan-phase research.

</code_context>

<specifics>
## Specific Ideas

Requirements DISC-01 (free-text + filters → candidates), DISC-02 (background job with progress polling + persisted results), DISC-07 (legal gate + caps + kill switch + PII guardrails). BLOCKING spike: Vercel Cron limits on current tier + free-text→filter reliability + FOR UPDATE SKIP LOCKED prototype + area-scrape cost smoke test.

</specifics>

<deferred>
## Deferred Ideas

- Niche ranking of candidates → Phase 10.
- Gallery/vision condition signals → Phase 11.
- Final legal go/no-go SIGN-OFF and flipping the feature flag ON → operator action (not this phase).

</deferred>
