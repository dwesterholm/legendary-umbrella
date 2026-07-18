---
phase: 13-discovery-ux-poll-timeout-fix
plan: 02
subsystem: ui
tags: [discovery, react, polling, timeout-ux, vitest, fake-timers, i18n]

# Dependency graph
requires: []
provides:
  - "Two-tier client poll timeout (SOFT_THRESHOLD_MS=90s non-failing notice + ABSOLUTE_CEILING_MS=15min real fail) replacing the single MAX_POLL_MS 5-min hard-fail (D-04, D-05)"
  - "Complete 6-entry STATUS_LABELS + exported KNOWN_STATUSES exhaustiveness guard (D-06, D-07) — vision_processing now renders 'Analyserar bilder'"
affects: [13-03]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two independent setTimeout timers (soft non-terminal + hard terminal) replacing one MAX_POLL_MS timer, mirroring the file's existing active/clearInterval/clearTimeout discipline"
    - "vi.useFakeTimers() + vi.advanceTimersByTimeAsync() wrapped in React's act() to reliably flush React 19 state updates scheduled from fake-timer callbacks in RTL component tests"

key-files:
  created: []
  modified:
    - src/components/discovery-progress.tsx
    - src/components/discovery-progress.test.tsx

key-decisions:
  - "SOFT_THRESHOLD_MS=90_000 and ABSOLUTE_CEILING_MS=15*60_000 chosen per RESEARCH Open Question #2's recommendation — both explicitly flagged as tunable constants pending calibration by the 13-03 live smoke against real post-13-01 completion timing (area parallelism + scoped AREA_PAGE_WAIT_SECS should make the typical case finish well under the soft threshold; vision runs as a separate post-scrape pass that must also fit inside these windows)"
  - "STATUS_LABELS and KNOWN_STATUSES exported directly from discovery-progress.tsx (not re-derived in the test file) so the exhaustiveness test enumerates the single canonical source of truth rather than a duplicated status list"
  - "New fake-timer tests wrap every vi.advanceTimersByTimeAsync(...) call in React Testing Library's act() — plain awaits left React 19's scheduler unflushed under jsdom + fake timers, causing the soft-notice banner assertion to see stale DOM; every pre-existing real-timer test in the file was left untouched since only the new fake-timer describe block hit this"

patterns-established:
  - "Soft (non-terminal) + hard (terminal) timer pair as the standard shape for any future 'don't fail early, but do eventually give up' client polling UX in this codebase"

requirements-completed: [DXUX-02]

# Metrics
duration: 20min
completed: 2026-07-18
---

# Phase 13 Plan 02: Two-Tier Poll Timeout + Complete Status Labels Summary

**Replaced `discovery-progress.tsx`'s single 5-minute hard-fail poll ceiling with a calm two-tier timeout (90s soft "tar längre tid" non-failing notice + 15min absolute real-fail ceiling) and completed `STATUS_LABELS` with the missing `vision_processing: "Analyserar bilder"` entry plus an exported `KNOWN_STATUSES` exhaustiveness guard.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-07-18T14:41:00Z (approx.)
- **Completed:** 2026-07-18T14:47:50Z
- **Tasks:** 2 completed (both TDD: RED test commit → GREEN impl commit)
- **Files modified:** 2

## Accomplishments

- `STATUS_LABELS` completed to all 6 known `discovery_jobs.status` values; `vision_processing` no longer leaks the raw enum through the `?? status` fallback. `KNOWN_STATUSES` exported as the canonical vocabulary an exhaustiveness test enumerates — a future 7th status word (no DB check constraint on the column) will fail the test loudly instead of silently regressing.
- `MAX_POLL_MS` (single 5-min hard-fail) replaced with `SOFT_THRESHOLD_MS` (90s, non-failing) and `ABSOLUTE_CEILING_MS` (15min, real fail). A long-running job now shows "Det tar längre tid än väntat, fortsätter…" in a calm `bg-warm-gray-50` card and keeps polling+ticking — no more false "Misslyckades" forcing a reload for a run the server will complete.
- The terminal-status branch inside `poll()` remains the single source of truth (RESEARCH Pitfall 5): it now clears BOTH `softTimeout` and `hardTimeout` and resets `slow` to `false`, so neither timer can fire after a terminal status is observed, regardless of race.
- `discovery-progress-live.tsx` confirmed unchanged (thin wrapper inherits the fix automatically, per RESEARCH).

## Task Commits

Each task was committed atomically (TDD: RED test commit → GREEN impl commit):

1. **Task 1 RED — STATUS_LABELS exhaustiveness + vision_processing label tests** - `b9a7d44` (test)
2. **Task 1 GREEN — complete STATUS_LABELS + KNOWN_STATUSES** - `38b2477` (feat)
3. **Task 2 RED — two-tier poll timeout tests** - `63b6178` (test)
4. **Task 2 GREEN — soft-notice + absolute-ceiling timer state machine** - `bde3b5c` (feat)

**Plan metadata:** (this commit) `docs(13-02): complete plan`

## Files Created/Modified

- `src/components/discovery-progress.tsx` — `STATUS_LABELS`/`KNOWN_STATUSES` exported and completed (6 entries); `MAX_POLL_MS` replaced by exported `SOFT_THRESHOLD_MS`/`ABSOLUTE_CEILING_MS`/`POLL_MS`; new `slow` state + calm soft-notice banner; terminal branch and cleanup return each clear both timers.
- `src/components/discovery-progress.test.tsx` — added an exhaustiveness describe block (6-status label coverage + vision_processing badge render) and a fake-timer describe block (soft-notice non-failing behavior, absolute-ceiling real fail, terminal-before-soft race safety). All 6 pre-existing tests pass unmodified.

## Decisions Made

- `SOFT_THRESHOLD_MS=90_000` / `ABSOLUTE_CEILING_MS=15 * 60_000` — both explicitly tunable, pending calibration by 13-03's live smoke on the RESUME.md multi-area query, per RESEARCH Open Question #2.
- Exported `STATUS_LABELS`, `KNOWN_STATUSES`, `POLL_MS`, `SOFT_THRESHOLD_MS`, `ABSOLUTE_CEILING_MS` from the component (all were previously module-private) so tests import the single canonical source rather than duplicating magic numbers/lists.
- Fake-timer test discipline: unlike the file's pre-existing timeout-adjacent test ("skips an overlapping poll") which uses real `setTimeout` delays, the new soft/hard-timer tests use `vi.useFakeTimers()` — real-time delays of 90s/15min would make the suite unacceptably slow. Every `vi.advanceTimersByTimeAsync(...)` call in these tests is wrapped in RTL's `act()`; without it, React 19's scheduler left state updates unflushed in jsdom, and the soft-notice banner assertion saw stale DOM.

## Deviations from Plan

None — plan executed exactly as written. Both tasks followed the TDD RED→GREEN sequence, `discovery-progress-live.tsx` was left untouched as directed, and the terminal-status branch's dual-timer-clear + `setSlow(false)` reset matches 13-PATTERNS.md's target shape exactly.

One implementation-detail addition not explicit in the plan text: wrapping fake-timer advances in `act()` (Rule 1 — auto-fix; the tests were flaky/failing without it, a straightforward test-infrastructure bug fix, not a behavior change to the component itself).

## Issues Encountered

None blocking. The one test-infra wrinkle (fake timers + React 19 act-wrapping) was resolved within the normal RED→GREEN cycle and is documented above.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `SOFT_THRESHOLD_MS=90_000` and `ABSOLUTE_CEILING_MS=15 * 60_000` are tunable constants pending real-timing calibration — 13-03's live smoke (RESUME.md's "Renoveringsobjekt i Södermalm och Vasastan under 4 miljoner" query) should observe actual end-to-end completion time (scrape + vision pass) and tighten/loosen both values if needed.
- Full test suite (`npm run test`) green: 733 passed, 3 skipped (DB-integration + LLM-eval self-skips, no `RUN_DB_INTEGRATION=1`/`RUN_LLM_EVALS=1` set).
- DXUX-02 (Swedish label for every job state) is now fully delivered by this plan — safe to mark complete. DXUX-01 (in-window completion) also needs 13-01's backend parallelization (already landed) AND this plan's UX fix, but the requirement's live-timing validation is deferred to 13-03's live smoke per the phase's own verification contract — left open here per the executor's judgment call, matching 13-01's precedent of deferring DXUX-01 to the live smoke.

## Self-Check: PASSED

Both modified files confirmed present on disk. All 4 task commit hashes (b9a7d44, 38b2477, 63b6178, bde3b5c) confirmed present in `git log --oneline --all`.

---
*Phase: 13-discovery-ux-poll-timeout-fix*
*Completed: 2026-07-18*
