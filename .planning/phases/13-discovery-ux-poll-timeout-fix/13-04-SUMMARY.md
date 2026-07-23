---
phase: 13-discovery-ux-poll-timeout-fix
plan: 04
subsystem: discovery
tags: [react, polling, supabase, vitest, apify, playwright, vision, ux]

# Dependency graph
requires:
  - phase: 13-01
    provides: "runPlaywrightRender's additive opts param { waitSecs?, maxRequestRetries? } — reused here to bound the vision-enrichment detail-page render"
  - phase: 13-02
    provides: "the poll/timer + terminal-branch-as-single-source-of-truth structure in discovery-progress.tsx — edited (split, not replaced) here"
provides:
  - "discovery-progress.tsx's status read decoupled from the tickDiscovery dispatch — a cheap Supabase read runs every POLL_MS ungated; the inFlight guard now covers only the tick DISPATCH"
  - "enrichCandidateImages gains an additive optional onProgress callback; runVisionForJob wires it to incremental processed_count-only writes during vision enrichment"
  - "fetchListing gains an additive optional opts param, threaded into both own-render rungs; new DETAIL_ENRICH_WAIT_SECS=90 / DETAIL_ENRICH_MAX_RETRIES=2 constants bound the vision-enrichment detail fetch"
affects: [14, 15, 16, 17]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Split a single guarded poll() into an ungated read + a separately-guarded dispatch — the in-flight guard protects only the expensive/slow operation, never the cheap read that drives the UI"
    - "Success-only progress callback: onProgress fires only after a SUCCESSFUL per-item attempt (not in the catch branch), keeping the counter strictly increasing without needing the caller to track a separate base value"
    - "Additive-optional-parameter discipline for shared transport config, extended a second time (13-01 established it for area-page renders; this plan extends it to vision-enrichment detail renders) — every existing call site (/analyze) stays byte-for-byte unchanged"

key-files:
  created: []
  modified:
    - src/components/discovery-progress.tsx
    - src/components/discovery-progress.test.tsx
    - src/lib/discovery/job.ts
    - src/lib/discovery/job.test.ts
    - src/lib/booli/client.ts
    - src/lib/booli/client.test.ts

key-decisions:
  - "processed_count during vision enrichment counts enriched-so-far (fetched, 1..N) rather than continuing from the scrape phase's true processed_count — runVisionForJob receives only the candidate array, not the claimedRow's counters, and threading the true base value through claimVisionSlice/claimAndRunVisionForJob was out of scope for this plan's minimal fix. The plan's own action text explicitly sanctioned this as one of two valid choices ('count enriched-so-far'). Strict monotonic increase (the hard requirement) holds; the displayed counter may show a lower absolute number than pre-vision for one tick before climbing again — acceptable given the counter's purpose is proving liveness, not exact accounting."
  - "onProgress fires only on a SUCCESSFUL detail-enrichment attempt (inside the try block, after the broker-gallery sub-attempt), never from the catch branch — this is what keeps the pre-existing 'writes vision-annotated results back in ONE update' test passing unmodified (that test's fetchListing is unmocked/undefined, so toCandidate throws and the candidate never counts toward progress)."
  - "DETAIL_ENRICH_WAIT_SECS=90 / DETAIL_ENRICH_MAX_RETRIES=2 chosen at the midpoint of 13-SMOKE-FINDINGS.md's 60-90s/1-2-retry recommended envelope — same 'tunable, pending calibration' posture as 13-01's AREA_PAGE_WAIT_SECS."
  - "job.test.ts's vi.mock(\"@/lib/booli/client\") factory now also exports literal DETAIL_ENRICH_WAIT_SECS=90/DETAIL_ENRICH_MAX_RETRIES=2 (kept numerically in sync with client.ts's real values) rather than importActual-ing the whole module, to avoid pulling the real ApifyClient construction (transport.ts) into job.test.ts's test run — client.test.ts (which does NOT mock booli/client wholesale) asserts against the real exported constants directly, matching 13-01's precedent there."

patterns-established:
  - "Ungated-read / guarded-dispatch split for any future poll-driven UI that both reads status AND triggers a potentially-long server action on the same interval"

requirements-completed: []

# Metrics
duration: 26min
completed: 2026-07-21
---

# Phase 13 Plan 04: Close Live-Smoke Gaps (Visible In-Window Progress) Summary

**Decoupled the discovery status read from the long-running tick dispatch, added incremental processed_count writes during vision enrichment, and bounded the vision-enrichment detail-page render to 90s/2-retry — closing the two gaps the 13-03 live smoke surfaced (frozen badge + unbounded per-candidate render) without touching the /analyze path or the D-03 cost-cap invariant.**

## Performance

- **Duration:** ~26 min
- **Started:** 2026-07-21T10:44:00Z (approx.)
- **Completed:** 2026-07-21T10:50:01Z
- **Tasks:** 3 completed (all TDD: RED test commit → GREEN impl commit)
- **Files modified:** 6

## Accomplishments
- `discovery-progress.tsx`'s single guarded `poll()` split into an ungated `readStatus()` (runs every `POLL_MS` regardless of a pending tick) and a still-guarded `dispatchTick()` (WR-03 in-flight protection preserved) — during a long multi-minute vision tick the badge now advances "Analyserar" → "Analyserar bilder" from the DB read alone, instead of freezing on the last-seen status. Proven with a fake-timer test where `tickDiscovery` is mocked to never resolve.
- `enrichCandidateImages` gained an additive optional `onProgress` callback (default `undefined`, every existing call site unaffected); `runVisionForJob` wires it to `updateJob(supabase, jobId, { processed_count: enrichedCount })` — the "n av N annonser analyserade" counter now advances during vision enrichment instead of staying frozen until the single terminal write. Verified: ≥2 strictly-increasing `processed_count`-only writes precede the terminal `{ results, status: "done" }` write, and every incremental payload's key set is exactly `["processed_count"]` (D-03 LOCKED — never `cost_sek_total`/`candidate_count`/`cap_*`/`results`/`status`).
- `fetchListing` gained an additive optional `opts?: { waitSecs?, maxRequestRetries? }`, threaded verbatim into both own-render rungs. New exported `DETAIL_ENRICH_WAIT_SECS=90`/`DETAIL_ENRICH_MAX_RETRIES=2` (client.ts) bound `enrichCandidateImages`'s detail fetch so one blocked/slow candidate (the live-smoke Booli 403 + 60s Cloudflare timeout looping across retries and rungs) can no longer burn ~480s. The `/analyze` single-listing call site (`analyze.ts:70`, no opts) keeps the proven 240s/3-retry default byte-for-byte — grep-verified.

## Task Commits

Each task was committed atomically (TDD: RED test commit → GREEN impl commit):

1. **Task 1 RED — prove the status read is not gated behind the in-flight tick** - `66275e8` (test)
2. **Task 1 GREEN — decouple readStatus() from dispatchTick()** - `e6f3e10` (feat)
3. **Task 2 RED — prove processed_count advances during vision enrichment** - `92dc745` (test)
4. **Task 2 GREEN — wire onProgress to incremental processed_count writes** - `476bb90` (feat)
5. **Task 3 RED — prove fetchListing forwards a bounded opts to both rungs** - `c1eaa02` (test)
6. **Task 3 GREEN — thread opts + bound the detail-enrichment render** - `a657649` (feat)

**Plan metadata:** (this commit) `docs(13-04): complete plan`

## Files Created/Modified
- `src/components/discovery-progress.tsx` - `poll()` split into ungated `readStatus()` + inFlight-guarded `dispatchTick()`; the terminal-status branch (single source of truth) stays inside `readStatus()`, unchanged in behavior.
- `src/components/discovery-progress.test.tsx` - added a 3-test describe block (fake timers) proving the decoupled read, the surviving in-flight guard, and terminal-branch authority with a permanently-pending `tickDiscovery`.
- `src/lib/discovery/job.ts` - `enrichCandidateImages` gained `onProgress?` (fires post-success, inside the try block); `runVisionForJob` wires it to a `processed_count`-only `updateJob` call; `enrichCandidateImages`'s `fetchListing` call site now passes `{ waitSecs: DETAIL_ENRICH_WAIT_SECS, maxRequestRetries: DETAIL_ENRICH_MAX_RETRIES }`.
- `src/lib/discovery/job.test.ts` - added a describe block asserting ≥2 strictly-increasing `processed_count`-only writes precede the terminal write (D-03 guard test included); mock factory extended with `DETAIL_ENRICH_WAIT_SECS`/`DETAIL_ENRICH_MAX_RETRIES`; updated the pre-existing Ringvägen D1 exact-arg assertion to include the now-mandatory bounded opts; added a dedicated opts-forwarding test.
- `src/lib/booli/client.ts` - `fetchListing(url, opts?)`; new exported `DETAIL_ENRICH_WAIT_SECS = 90` / `DETAIL_ENRICH_MAX_RETRIES = 2` constants.
- `src/lib/booli/client.test.ts` - added an opts-forwarding test (forced rung-1-fails/rung-2-succeeds, asserts both rungs received the passed opts) and a no-opts `maxRequestRetries: 3` non-regression assertion complementing the pre-existing `waitSecs: 240` test.

## Decisions Made
- `processed_count` during vision enrichment counts enriched-so-far (1..N), not a continuation of the scrape phase's true `processed_count` — `runVisionForJob` only receives the candidate array, not the claimed row's counters; threading the true base value through `claimVisionSlice`/`claimAndRunVisionForJob` was out of scope for this plan's minimal fix, and the plan's action text explicitly sanctioned "count enriched-so-far" as a valid choice. The hard requirement (strict monotonic increase) holds by construction.
- `onProgress` fires only on a *successful* per-candidate detail-enrichment attempt (inside the try block, after the broker-gallery sub-attempt), never from the catch branch — this is precisely what keeps the pre-existing "writes vision-annotated results back in ONE update" test passing unmodified without any change to that test (its `fetchListing` mock is unset/`undefined`, so `toCandidate` throws and the candidate never advances progress).
- `DETAIL_ENRICH_WAIT_SECS=90` / `DETAIL_ENRICH_MAX_RETRIES=2` chosen at the midpoint of 13-SMOKE-FINDINGS.md's recommended 60-90s/1-2-retry envelope, exported as a tunable constant pending real-timing calibration — same posture as 13-01's `AREA_PAGE_WAIT_SECS`.
- `job.test.ts`'s wholesale `vi.mock("@/lib/booli/client")` factory now also exports literal `DETAIL_ENRICH_WAIT_SECS`/`DETAIL_ENRICH_MAX_RETRIES` values kept numerically in sync with `client.ts`'s real exports, rather than `importActual`-ing the whole module — avoids pulling the real `ApifyClient` construction (`transport.ts`) into `job.test.ts`'s test run. `client.test.ts` (which does not mock `booli/client` wholesale) asserts against the real exported constants directly, mirroring 13-01's `AREA_PAGE_WAIT_SECS` precedent there.

## Deviations from Plan

None — plan executed exactly as written. All three tasks followed the TDD RED→GREEN sequence specified; the D-03 LOCKED invariant (processed_count-only incremental payload, never cost/candidate/cap/results/status; terminal `updateJob(status:"done")` unchanged) and the `/analyze` byte-for-byte non-regression were both preserved by construction and grep-verified, matching the plan's constraints precisely. One pre-existing test assertion (the Ringvägen D1 exact-arg check in `job.test.ts`) was updated to include the now-mandatory bounded opts — this was an anticipated, plan-mandated consequence of Task 3's required behavior change (`enrichCandidateImages` must now always pass bounded opts to `fetchListing`), not an unplanned deviation.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- DXUX-01 is still gated on a follow-up LIVE smoke run (from a non-blocked IP, per the operator's 13-03 note that the local IP was Booli/Cloudflare-blocked) to confirm the badge visibly advances and the counter visibly increments on a real multi-area query — NOT marked complete in REQUIREMENTS.md per this plan's explicit constraint.
- `DETAIL_ENRICH_WAIT_SECS`/`DETAIL_ENRICH_MAX_RETRIES` (90/2) and the vision-phase `processed_count` semantics (enriched-so-far, not a scrape-phase continuation) are both flagged as tunable/pending-calibration by that same live smoke.
- Full `npm run test` green: 741 passed, 3 skipped (DB-integration + LLM-eval self-skips, no `RUN_DB_INTEGRATION=1`/`RUN_LLM_EVALS=1` set). `tsc --noEmit` clean. `npm run lint` clean.
- Ready for the operator's live-smoke re-run; independent of Phase 14's analysis-brain work.

## Self-Check: PASSED

All 6 modified files confirmed present on disk. All 6 task commit hashes (66275e8, e6f3e10, 92dc745, 476bb90, c1eaa02, a657649) confirmed present in `git log --oneline --all`.

---
*Phase: 13-discovery-ux-poll-timeout-fix*
*Completed: 2026-07-21*
