---
phase: 13-discovery-ux-poll-timeout-fix
plan: 05
subsystem: discovery
tags: [react, vitest, supabase, polling, ux]

# Dependency graph
requires:
  - phase: 13-04
    provides: "the decoupled readStatus()/dispatchTick() split (unchanged here) and the vision-phase onProgress callback this plan reverts"
provides:
  - "discovery-progress.tsx's counter reads LOCKED 2026-07-22 semantics: denominator = candidate_count (never cap_candidates), numerator = a monotonic analyzed count clamped to candidate_count, reaching candidate_count at status done"
  - "runVisionForJob no longer writes processed_count during vision — enrichCandidateImages loses its onProgress param entirely; processed_count keeps its scanned-listings scrape/cost meaning exclusively (written only by runSlice)"
affects: [14, 15, 16, 17]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Monotonic + clamped display-state as a display-layer fix for a race-prone/misleading DB counter, without a schema change: setAnalyzed((prev) => Math.max(prev, Math.min(next, denominator))) makes both 'never exceeds denominator' and 'never decreases' hold by construction, independent of what the row's other columns contain."

key-files:
  created: []
  modified:
    - src/lib/discovery/job.ts
    - src/lib/discovery/job.test.ts
    - src/components/discovery-progress.tsx
    - src/components/discovery-progress.test.tsx

key-decisions:
  - "No DB migration. The numerator ('analyzed') is component state, not a persisted column — its value is 0 while pending/processing/vision_processing and candidate_count at done. This means the counter is quiet ('0 av N') for the entire multi-minute vision window; liveness during that window is still carried by the 13-04 badge advancement (Analyserar -> Analyserar bilder) and the soft-notice, not by this numeric counter. A persisted mid-run numerator would need a new column and was explicitly out of scope per operator guidance."
  - "Denominator is candidate_count, not cap_candidates. cap_candidates only drives the (unchanged) cap-reached banner. This one substitution, plus the removal of processed_count from the client select entirely, is what makes '350 av 25' and a backward numerator jump structurally impossible rather than merely unlikely."
  - "Reverted only the 13-04 Task 2 onProgress wiring (the processed_count-during-vision write) — 13-04 Task 1 (decoupled readStatus/dispatchTick) and Task 3 (bounded fetchListing opts, DETAIL_ENRICH_WAIT_SECS/MAX_RETRIES) are untouched and still fully in effect."

patterns-established:
  - "For any future poll-driven counter, prefer deriving a monotonic+clamped display value from stable row fields (here: candidate_count + status) over introducing a new persisted running-count column, when the same UX goal (visible liveness) can be met by an existing status transition + independent timer signal."

requirements-completed: []

# Metrics
duration: 8min
completed: 2026-07-22
---

# Phase 13 Plan 05: Fix the Discovery Progress Counter (Analyzed / Found) Summary

**Reworked the discovery progress counter to mean "candidates analyzed / candidates found" (denominator = candidate_count, monotonic clamped numerator) and reverted the 13-04 vision-phase processed_count write that caused the counter to jump backward — eliminating both halves of the "350 av 25" defect from the 13-03 live smoke.**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-07-22T09:09:22+02:00 (first RED commit)
- **Completed:** 2026-07-22T09:14:08+02:00
- **Tasks:** 2 completed (both TDD: RED test commit → GREEN impl commit)
- **Files modified:** 4

## Accomplishments
- `runVisionForJob` reverted to a single terminal `updateJob({ results, status: "done" })` write — the 13-04 Task 2 `onProgress` callback (which overwrote `processed_count` with the enriched-so-far count, 1..≤8) is gone. `enrichCandidateImages` no longer has an `onProgress` parameter at all. `processed_count` now carries its scanned-listings scrape/cost meaning exclusively, written only by `runSlice` — grep-verified (`grep -n "processed_count" src/lib/discovery/job.ts` shows only the `runSlice`-region doc comment, interface field, and the scrape-path `newProcessedCount` computation/persist line).
- `discovery-progress.tsx`'s counter now renders `${Math.min(analyzed, candidateCount)} av ${candidateCount} annonser analyserade` — denominator is `candidate_count` (never `cap_candidates`), numerator is a `useState` value held monotonic (`Math.max(prev, …)`) and clamped to the denominator (`Math.min(…, candidate_count)`). `processed_count` is dropped from the client's `.select(...)` string and from the `DiscoveryJobRow` interface entirely — the client never reads it again, grep-verified empty.
- The counter now reads "0 av N" throughout `pending`/`processing`/`vision_processing` and snaps to "N av N" only at `done` — a row shaped exactly like the live-smoke defect (`processed_count: 350, candidate_count: 18, cap_candidates: 25`) renders "0 av 18": never "350…", never "…av 25". A poll sequence with `processed_count` 350 then 3 (candidate_count 18 throughout, still running) never renders a decreasing numerator — proven by a dedicated backward-jump test using the existing `singleMock.mockImplementation` call-count pattern + fake timers.

## Task Commits

Each task was committed atomically (TDD: RED test commit → GREEN impl commit):

1. **Task 1 RED — prove runVisionForJob issues no processed_count write** - `6667401` (test)
2. **Task 1 GREEN — revert 13-04's processed_count overwrite in runVisionForJob** - `7c0ac3c` (fix)
3. **Task 2 RED — assert LOCKED analyzed/found counter semantics** - `32948ec` (test)
4. **Task 2 GREEN — counter = candidates analyzed / candidates found** - `0a5b5ac` (feat)

**Plan metadata:** (this commit) `docs(13-05): complete plan`

## Files Created/Modified
- `src/lib/discovery/job.ts` - `runVisionForJob` calls `enrichCandidateImages(results, VISION_ENRICH_LIMIT)` with no third argument; `enrichCandidateImages`'s `onProgress` param, its doc paragraph, and the in-loop `await onProgress?.(fetched)` call are all removed. `runSlice`'s scrape-path `processed_count` computation/persist is byte-for-byte unchanged.
- `src/lib/discovery/job.test.ts` - deleted the 13-04 "incremental processed_count writes" describe block; added a "no processed_count write during vision (13-05 revert)" regression test asserting exactly one `updateJob` call with keys `["results", "status"]` and no `processed_count` key anywhere.
- `src/components/discovery-progress.tsx` - `analyzed`/`candidateCount` state replace `processedCount`; `readStatus` computes `nextAnalyzed = status === "done" ? candidate_count : 0` and commits it via a monotonic-max + denominator-clamp; the select string and `DiscoveryJobRow` type drop `processed_count`; the render line and its doc comment updated to the LOCKED analyzed/found semantics.
- `src/components/discovery-progress.test.tsx` - updated the two counter-bearing pre-existing tests (LOCKED-counter test now checks "N av N" at done + "0 av N" running; cap-reached test's counter assertion changes from "25 av 25" to "0 av 25", banner assertion unchanged) and added a new "analyzed/found counter (LOCKED 2026-07-22)" describe block (N-av-N at done, 0-av-N running, 350-av-25-impossible, monotonic vision_processing→done, backward-jump-impossible).

## Decisions Made
- No DB migration — the numerator is component state (0 until `done`, then `candidate_count`), not a persisted mid-run column. During the multi-minute `vision_processing` window the counter itself is quiet at "0 av N"; the 13-04 badge advancement ("Analyserar" → "Analyserar bilder") and the independent soft-notice timer remain the liveness signals during that window. This tradeoff was explicit in the plan's `<design_decision>` and is intentional, not a gap.
- Denominator is `candidate_count`, never `cap_candidates` — `cap_candidates` continues to drive only the cap-reached banner, which is unchanged and still asserted by its pre-existing test.
- Only the 13-04 Task 2 `onProgress` wiring was reverted. 13-04 Task 1 (the decoupled `readStatus()`/`dispatchTick()` split) and Task 3 (`DETAIL_ENRICH_WAIT_SECS`/`DETAIL_ENRICH_MAX_RETRIES` bounding `fetchListing` during enrichment) are fully intact and unaffected — confirmed via the passing decoupled-read describe block and the `enrichCandidateImages` opts-forwarding tests, both untouched by this plan's edits.

## Deviations from Plan

None — plan executed exactly as written. Both tasks followed the TDD RED→GREEN sequence specified. One micro-adjustment during Task 2 GREEN: the new counter doc comment initially referenced the literal string `processed_count`, which would have broken the plan's own acceptance-criteria grep (`grep -n "processedCount\|processed_count" src/components/discovery-progress.tsx` must return nothing) — reworded the comment to describe the server-side counter without using that literal token before committing. This is a wording-only self-correction to satisfy the plan's own stated acceptance criterion, not a behavior change; not logged as a numbered deviation since no rule application was needed (no bug, no missing functionality, no blocker — just matching the letter of the plan's own grep check).

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- DXUX-01 remains **Pending** — NOT marked complete in REQUIREMENTS.md per this plan's explicit constraint. It is still gated on the operator's live-smoke re-run (from a non-Booli/Cloudflare-blocked IP) to confirm the badge visibly advances and the counter now snaps cleanly to "N av N" at done on a real multi-area query, with no "350 av 25" and no backward jump.
- Full `npm run test`: 745 passed, 3 skipped (DB-integration + LLM-eval self-skips, no `RUN_DB_INTEGRATION=1`/`RUN_LLM_EVALS=1` set). `npx tsc --noEmit` clean. `npm run lint` clean.
- Grep-verified: `processed_count` in `job.ts` appears only in the `runSlice` region (doc comment, interface field, `newProcessedCount` computation/persist); `processedCount`/`processed_count` do not appear anywhere in `discovery-progress.tsx`; `git diff --stat src/components/discovery-progress-live.tsx` shows zero changes.
- Ready for the operator's live-smoke re-run of Phase 13 as a whole (13-01 through 13-05); independent of Phase 14's analysis-brain work, which can proceed in parallel.

## Self-Check: PASSED

All 4 modified files confirmed present on disk. All 4 task commit hashes (6667401, 7c0ac3c, 32948ec, 0a5b5ac) confirmed present in `git log --oneline --all`.

---
*Phase: 13-discovery-ux-poll-timeout-fix*
*Completed: 2026-07-22*
