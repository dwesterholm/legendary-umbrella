---
phase: 13-discovery-ux-poll-timeout-fix
plan: 01
subsystem: api
tags: [discovery, apify, playwright, concurrency, vitest, promise-allsettled]

# Dependency graph
requires: []
provides:
  - "runSlice's area loop parallelized via Promise.allSettled (D-01) — collapses sum(area times) to max(area times) for multi-area queries"
  - "runPlaywrightRender's additive opts param { waitSecs?, maxRequestRetries? } (D-02) — every existing call site unaffected"
  - "client.ts AREA_PAGE_WAIT_SECS=120 constant scoping area-page renders below the 240s detail-page default"
affects: [13-02, 13-03]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Promise.allSettled fulfilled/rejected aggregation applied one level up (areas, not just pages), mirroring booli/client.ts:719-736 exactly"
    - "Additive-optional-parameter discipline for shared transport config (opts?: {...} defaulting to proven literals) so existing call sites stay byte-for-byte unchanged"

key-files:
  created: []
  modified:
    - src/lib/discovery/job.ts
    - src/lib/discovery/job.test.ts
    - src/lib/booli/transport.ts
    - src/lib/booli/client.ts
    - src/lib/booli/client.test.ts

key-decisions:
  - "AREA_PAGE_WAIT_SECS set to 120 (< 240 detail-page default) as a conservative first value, exported from client.ts for test assertions — flagged pending calibration against the [booli-client] fetchAreaListings page N served by rung... log via the 13-03 live smoke (RESEARCH Open Question #1)"
  - "Iterated settled results by index (not for...of on values) so areaIds[i] stays available for kill-switch error-context logging, matching the client.ts pages-2..N analog exactly"

patterns-established:
  - "Area-level Promise.allSettled aggregation in job.ts runSlice — same shape as client.ts's page-level pattern, one level up"

requirements-completed: [DXUX-01]

# Metrics
duration: 25min
completed: 2026-07-18
---

# Phase 13 Plan 01: Parallelize Area Scrape + Scoped Area-Page Wait Ceiling Summary

**Areas within one `runSlice` invocation now scrape concurrently via `Promise.allSettled` (collapsing sum(area times) to max(area times)), and area-page Apify renders use a new scoped `AREA_PAGE_WAIT_SECS=120` override — while detail/broker/sold-comps renders keep their proven 240s/3-retry defaults byte-for-byte unchanged.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-07-18T14:14:00Z (approx.)
- **Completed:** 2026-07-18T14:39:30Z
- **Tasks:** 2 completed (both TDD: RED test commit → GREEN impl commit)
- **Files modified:** 5

## Accomplishments
- `runSlice`'s sequential `for (const areaId of areaIds)` loop replaced with `Promise.allSettled(areaIds.map(...))`, mirroring `fetchAreaListings`'s existing pages-2..N pattern one level up — proven via a new staggered-real-delay timing test (elapsed ≈ max, not sum).
- `runPlaywrightRender` gained an additive-only `opts?: { waitSecs?, maxRequestRetries? }` param defaulting to the existing proven 240/3 — grep-verified every existing call site (`fetchListing`, sold-comps) is untouched.
- `fetchAreaPage`'s two rungs now pass `{ waitSecs: AREA_PAGE_WAIT_SECS }` (120s), bounding worst-case per-area render time well under the 300s Vercel Server Action ceiling even with D-01's concurrent areas.
- The D-03 LOCKED invariant preserved: the synchronous cost pre-check (job.ts:163-164) still runs BEFORE `Promise.allSettled`; the loop remains pure in-memory aggregation (zero per-area DB writes); the single terminal `updateJob` stays after the loop.

## Task Commits

Each task was committed atomically (TDD: RED test commit → GREEN impl commit):

1. **Task 1 RED — concurrency-timing proof** - `6f348ac` (test)
2. **Task 1 GREEN — parallelize runSlice area loop** - `a2960a3` (feat)
3. **Task 2 RED — scoped waitSecs override assertion** - `314ec7d` (test)
4. **Task 2 GREEN — additive opts + AREA_PAGE_WAIT_SECS** - `7cfd990` (feat)

**Plan metadata:** (this commit) `docs(13-01): complete plan`

## Files Created/Modified
- `src/lib/discovery/job.ts` - `runSlice`'s area loop now `Promise.allSettled(areaIds.map(fetchAreaListings))`; unchanged fulfilled→push/count, rejected→anyThrew+log aggregation; cost pre-check and terminal update stay in their locked source-order positions.
- `src/lib/discovery/job.test.ts` - added a staggered-real-delay concurrency-timing test to the existing `describe("runSlice — multi-area search")` block; all 6 pre-existing multi-area tests pass unmodified.
- `src/lib/booli/transport.ts` - `runPlaywrightRender` gains optional third param `opts?: { waitSecs?, maxRequestRetries? }`; defaults preserve the exact 240/3 literals.
- `src/lib/booli/client.ts` - new exported `AREA_PAGE_WAIT_SECS = 120` constant; `fetchAreaPage`'s two rungs pass `{ waitSecs: AREA_PAGE_WAIT_SECS }`; `fetchListing`/sold-comps rungs unchanged (grep-verified, no third arg).
- `src/lib/booli/client.test.ts` - added assertions proving the area-page override (`{ waitSecs: AREA_PAGE_WAIT_SECS }`) and detail-page non-regression (`{ waitSecs: 240 }`).

## Decisions Made
- `AREA_PAGE_WAIT_SECS = 120` chosen per RESEARCH Open Question #1's recommendation (conservative first value, well below 240, above the ~60-180s observed real-world stalls) — exported from `client.ts` so tests can assert against the live constant rather than a duplicated magic number; explicitly flagged as **pending calibration** by the 13-03 live smoke against real Apify timing telemetry (the `[booli-client] fetchAreaListings page N served by rung...` log line already exists for this purpose).
- Timing-proof test uses real `setTimeout`-based staggered delays (100ms vs 20ms), not fake timers or instant mocks, per RESEARCH Pitfall 4 — an instant-mock test cannot distinguish sequential-await-in-a-loop from `Promise.allSettled`.

## Deviations from Plan

None — plan executed exactly as written. Both tasks followed the TDD RED→GREEN sequence specified, and the LOCKED D-03 invariant (cost pre-check before `Promise.allSettled`, single terminal update, zero per-area DB writes) was preserved by construction, matching the plan's guidance precisely.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `AREA_PAGE_WAIT_SECS=120` is a tunable constant pending real-timing calibration — 13-03's live smoke (RESUME.md's "Renoveringsobjekt i Södermalm och Vasastan under 4 miljoner" query) should observe actual per-page render latency via the existing rung log line and tighten/loosen the value if needed.
- Full test suite (`npm run test`) green: 727 passed, 3 skipped (DB-integration + LLM-eval self-skips, no `RUN_DB_INTEGRATION=1`/`RUN_LLM_EVALS=1` set).
- Ready for 13-02 (client-side soft-notice/absolute-ceiling timeout UX + `STATUS_LABELS` completeness, D-04 through D-07) — independent of this plan's backend throughput fix.
- The regression sweep noted in the plan's `<verification>` block (`RUN_DB_INTEGRATION=1 ... job.integration.test.ts`) was not run this session (requires live Supabase creds) — it needs no code change from this plan, per RESEARCH; flagged for the operator's discretion at the phase gate.

## Self-Check: PASSED

All 5 modified/created files confirmed present on disk. All 4 task commit hashes (6f348ac, a2960a3, 314ec7d, 7cfd990) confirmed present in `git log --oneline --all`.

---
*Phase: 13-discovery-ux-poll-timeout-fix*
*Completed: 2026-07-18*
