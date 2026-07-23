# Phase 13: Discovery UX / Poll-Timeout Fix - Context

**Gathered:** 2026-07-18
**Status:** Ready for planning

<domain>
## Phase Boundary

The now-live discovery flow must finish within the user's patience window (no forced reload) and show a human-readable Swedish label for every job state. Covers exactly DXUX-01 (in-window completion) and DXUX-02 (Swedish label for every state, incl. `vision_processing`). NOT the analysis-quality work (Phases 14–17) — this phase touches only the discovery run's throughput and the progress UI.

</domain>

<decisions>
## Implementation Decisions

### In-window completion (DXUX-01)
- **D-01 (primary lever):** Parallelize across **areas** in `runSlice` — today only pages within an area run concurrently (`Promise.allSettled`), while the areas themselves scrape sequentially, so "Södermalm och Vasastan" run back-to-back and a single timing-out page blocks its area's batch ~180s. Run the areas concurrently too.
- **D-02 (secondary lever):** Cap per-page render retries / lower the Booli `networkidle` 60s per-page timeout so one slow page can't stall its area's batch. Apply as a complementary tactic to D-01, not instead of it.
- **D-03 (cost-cap invariant — LOCKED):** Parallelizing areas must NOT weaken the shared incremental cost/candidate caps. The atomic claim/accounting (`claim_discovery_slice`, cost gate) must stay race-free under concurrent area scrapes — no double-spend, caps still enforced exactly. Real Apify + Anthropic spend per run.

### Long-run fallback UX (DXUX-01)
- **D-04:** Replace the current hard-fail-at-ceiling behavior (`discovery-progress.tsx:133-139` sets `timedOut` + `onComplete("failed")`, forcing a reload while the server finishes fine) with a **calm, non-failing** state: at the soft threshold show "Det tar längre tid än väntat, fortsätter…" and **keep polling + ticking** until the row reaches a terminal status. A false "Misslyckades" must never show for a run the server will complete.
- **D-05:** Keep a generous ABSOLUTE safety ceiling (well above the current 5 min) so a genuinely dead server eventually surfaces a real failure — the soft "tar längre tid" notice is not the same as giving up. Exact value at planner's discretion; the point is: soft-notice early, hard-stop only far out.

### Swedish status labels (DXUX-02)
- **D-06:** Add `vision_processing: "Analyserar bilder"` to `STATUS_LABELS` in `discovery-progress.tsx`. Chosen over "Bildanalys"/"Tolkar bilder" — reads as the natural next step after the existing "Analyserar" scrape label.
- **D-07:** Audit the full set of job statuses the row can hold and ensure EVERY one has a `STATUS_LABELS` entry — no raw enum string may ever reach the badge via the `?? status` fallback. Known statuses from the codebase: pending, processing, vision_processing, done, failed, degraded (verify against the discovery_jobs status set during planning).

### Claude's Discretion
- Exact soft-threshold vs absolute-ceiling millisecond values, the concrete concurrency primitive for area-level parallelism, and whether `discovery-progress-live.tsx` needs the same label/threshold treatment (check both components).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase spec / requirements
- `.planning/ROADMAP.md` (Phase 13 section) — goal + success criteria
- `.planning/REQUIREMENTS.md` — DXUX-01, DXUX-02
- `RESUME.md` (P1 section) — root-cause narrative for the timeout (sequential areas + one timing-out page blocking allSettled ~180s)
- `.planning/research/2026-07-10-ANALYSIS-REDESIGN-SPEC.md` §5 — cost-cap invariants (`CAP_VISION_SEK_MAX=10`, `VISION_ENRICH_LIMIT=8`, `CAP_CANDIDATES_MAX=25`), `DISCOVERY_ENABLED` fail-closed

### Code
- `src/components/discovery-progress.tsx` — `MAX_POLL_MS` (:36), `STATUS_LABELS` (:40), timeout hard-fail (:133-139), poll+tick loop
- `src/components/discovery-progress-live.tsx` — sibling live variant (check for the same gaps)
- `src/lib/discovery/job.ts` — `runSlice`, `fetchAreaListings`, area/page scrape orchestration
- `src/lib/booli/client.ts` — per-page fetch / `networkidle` timeout, `MAX_AREA_PAGES`
- `src/actions/tick-discovery.ts` — the Server Action the client tick invokes
- `src/lib/discovery/cost.ts` — incremental cost-cap accounting (must stay race-free under D-03)
- `src/app/api/discovery/sweep/route.ts` — orphan-recovery cron (`vision_processing` recovery, WR-04)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `discovery-progress.tsx` poll+tick skeleton is the driver — modeled on `BrfProgress`. The fix is localized to its timeout branch + `STATUS_LABELS`.
- `Promise.allSettled` page-parallel pattern already exists in `runSlice`/`fetchAreaPage` — extend the same primitive up one level to areas.
- `claim_discovery_slice` atomic RPC already guarantees race-free slice claiming — the safety net for concurrent area work.

### Established Patterns
- Client-tick-drives-the-queue (09-PATTERNS.md Pattern 1): each 1.5s `poll()` calls `tickDiscovery(jobId)` which claims+advances ONE bounded slice before reading status. Area parallelism must fit within this per-tick slice model or advance more per tick without breaking the cost gate.
- Cost/candidate caps are enforced incrementally per slice — the invariant that must survive parallelization.

### Integration Points
- `discovery-progress.tsx` ⇄ `tick-discovery.ts` ⇄ `job.ts` `runSlice` ⇄ `booli/client.ts`.
- The sweep cron (`sweep/route.ts`) is the orphan-resume net, secondary to the client tick — its `vision_processing` recovery must stay compatible with any label/state changes.

</code_context>

<specifics>
## Specific Ideas

- Long-run copy: "Det tar längre tid än väntat, fortsätter…" (calm, not an error) — replaces the current failure surface.
- Vision label: exactly "Analyserar bilder".

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope. (Analysis throughput improvements that change WHAT is analyzed belong to Phases 14–17.)

</deferred>

---

*Phase: 13-discovery-ux-poll-timeout-fix*
*Context gathered: 2026-07-18*
