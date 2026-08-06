---
phase: 14-holistic-analysis-brain
plan: 06
subsystem: discovery
tags: [brf-lookup, promise-allsettled, cost-cap, holistic-brief, vision, discovery-orchestrator]

# Dependency graph
requires:
  - phase: 14-holistic-analysis-brain
    plan: 01
    provides: "DiscoveryCandidate.brfSummary/holisticBrief/kommun slots + HolisticBrief/BrfSummary types, HOLISTIC_DATA_ONLY_MARKER"
  - phase: 14-holistic-analysis-brain
    plan: 02
    provides: "normalizeForConfounders + buildHolisticBrief (the ANL-01 non-empty-brief builder) this plan wires into the live pipeline"
  - phase: 14-holistic-analysis-brain
    plan: 03
    provides: "brf-lookup.ts's lookupBrfSummary/BRF_TOP_N — the never-throwing per-candidate BRF orchestrator this plan batches concurrently"
  - phase: 14-holistic-analysis-brain
    plan: 05
    provides: "resolveCompsForCandidates + runVisionPass's initialSpentSek seed — the shared CAP_VISION_SEK_MAX pool this plan's BRF spend joins"
provides:
  - "lookupBrfForTopCandidates + BrfResolution exported from job.ts — the ANL-03 bounded-concurrent top-N BRF fetch"
  - "runVisionForJob's final five-step pipeline: enrich -> comps -> BRF -> vision -> brief -> persist, one shared CAP_VISION_SEK_MAX pool across comps+BRF+vision"
  - "Every candidate ending the vision pass with no surviving image claims (all three visionSkippedReason states + both claims:[] paths) carries a non-null holisticBrief with >=1 item and the D-14-04 marker — closing ANL-01 end-to-end"
affects: [15, 16]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Bounded top-N Promise.allSettled batch over an already-merged prelim rank (enrichmentVisitOrder), never a new priority function or a sequential for-await loop"
    - "Mutable accumulators declared OUTSIDE a try block so an unexpected error returns partial progress instead of discarding it (mirrors resolveCompsForCandidates's own discipline)"
    - "Mocking the underlying LLM SDK (not vision.ts itself) to drive states through the REAL vision.ts/job.ts code path in a file that otherwise stays Anthropic-free"

key-files:
  created: []
  modified:
    - src/lib/discovery/job.ts
    - src/lib/discovery/job.test.ts
    - .planning/phases/14-holistic-analysis-brain/deferred-items.md

key-decisions:
  - "Comps run BEFORE BRF in the pipeline (not the plan-neutral either order) — comps are per-area/amortized and cheaper, and the holistic-brief fallback needs them for EVERY candidate, whereas BRF only ever covers the top-N (D-14-08's front-load-the-cheap-structurally-necessary-spend ordering)"
  - "The brief-attachment branch is written as ONE combined hasNoImageClaims(c) check (vision === null || vision.claims.length === 0) rather than four near-duplicate branches — it does not need to know WHICH of the four states produced the empty array, only that it did"
  - "Drove the vision_error and claims:[] states by mocking @anthropic-ai/sdk directly (mirrors vision.test.ts's own mock shape) rather than mocking vision.ts itself — this exercises the REAL runVisionPass/runVisionForCandidate logic end-to-end instead of reimplementing it in a stub, and is a no-op for every pre-existing test in the file (all use imageUrls: null, so parse() is never invoked by them)"
  - "job.integration.test.ts received NO addition — every guarantee this plan proves (BRF batching, budget sharing, the ANL-01 brief guarantee) is pure Vitest-mockable logic; nothing here requires the real RPC/service-role posture that file exists for"

requirements-completed: [ANL-01, ANL-03]

# Metrics
duration: 25min
completed: 2026-08-06
---

# Phase 14 Plan 06: BRF Top-N Fetch + Holistic Brief Wiring Summary

**Closed the phase: `lookupBrfForTopCandidates` fetches BRF summaries for the top-N prelim-ranked candidates concurrently under a shared budget, and `runVisionForJob`'s final pipeline (enrich → comps → BRF → vision → brief → persist) now attaches a non-empty holistic brief to every candidate that leaves vision with no surviving image claims — the step that makes the Ringvägen 122 scenario actually produce something.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-08-06T17:54:00+02:00
- **Tasks:** 3
- **Files modified:** 2 code files (0 created, 2 modified) + 1 doc (deferred-items.md)

## Accomplishments

- `lookupBrfForTopCandidates` selects the top `BRF_TOP_N` (=4) candidates by the ALREADY-MERGED `enrichmentPriority`/`enrichmentVisitOrder` rank, restricted to those with a `brfName`, and fetches their BRF summaries under one bounded `Promise.allSettled` batch — proven concurrent (a deferred-promise test asserts all `BRF_TOP_N` invocations happen before any resolves, the Phase 13 WR-02 max-vs-sum proof).
- A rejected lookup or any non-`"ok"` `BrfLookupOutcome` (e.g. `"low_confidence"`) degrades ONLY that candidate — logged with by-index error context — while the rest of the batch still succeeds; the function itself never throws and takes no `supabase` parameter (D-14-12 boundary confirmed by a zero-`analyses`/zero-`.from(` grep).
- The BRF budget is a pre-gate computed as `Math.max(0, CAP_VISION_SEK_MAX - comps.spentSek)` — checked BEFORE any network call — and its spend folds into `runVisionPass`'s `initialSpentSek` alongside comps, so comps + BRF + vision genuinely share ONE 10 SEK ceiling; an exhausted pool skips BRF entirely (zero `lookupBrfSummary` calls) while every candidate still gets a brief.
- `runVisionForJob`'s pipeline is now **enrich → comps → BRF → vision → brief → persist**. After `runVisionPass` returns, every candidate where `vision === null || vision.claims.length === 0` — covering ALL FOUR no-image-claims states (`visionSkippedReason` `"no_images"`/`"cost_cap"`/`"vision_error"`, plus a non-null `vision` with an empty `claims` array) — gets `normalizeForConfounders` + `buildHolisticBrief` run against its `areaComps`/`brfSummary`, guaranteeing `holisticBrief.items.length >= 1` and the `HOLISTIC_DATA_ONLY_MARKER`. A candidate WITH a surviving image claim keeps `holisticBrief: null`.
- `vision.ts`, `visionResultSchema`, and `condition-score.ts` are byte-identical (confirmed via `git diff`) — the brief attachment step reads `vision.claims` but writes nothing back into it, so `condition-score.ts`'s `claims.length === 0 → 0` behaviour is untouched; a data-only brief correctly contributes zero vision-derived condition signal.
- The terminal `updateJob` write still carries exactly the keys `["results", "status"]` — no new column, no migration — verified by a dedicated test even with BRF+brief data attached.
- 18 new tests across two `describe` blocks (`lookupBrfForTopCandidates` — 9 tests; `runVisionForJob` ANL-01 guarantee — 9 tests) drive every state through the REAL `job.ts`/`vision.ts` code path, not a stub of it.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add lookupBrfForTopCandidates — bounded concurrent top-N BRF fetch** - `4296394` (feat)
2. **Task 2: Wire BRF + the holistic-brief attachment into runVisionForJob** - `6d3a464` (feat)
3. **Task 3: Test the BRF batch, the shared budget, and the ANL-01 non-empty guarantee** - `6adef2f` (test)

_No TDD tasks in this plan — Tasks 1/2 are feat commits extending `job.ts` (module addition, then wiring), Task 3 is the paired test commit, mirroring 14-01/14-03/14-05's precedent of same-commit tests rather than separate RED/GREEN cycles._

## Files Created/Modified

- `src/lib/discovery/job.ts` - New imports (`lookupBrfSummary`/`BRF_TOP_N` from `brf-lookup.ts`; `estimateBrfLookupSek` from `cost.ts`; `normalizeForConfounders`/`buildHolisticBrief` from `confounder-guard.ts`; `BrfSummary` type from `holistic-schema.ts`). New exports `BrfResolution` + `lookupBrfForTopCandidates`. `runVisionForJob` extended to the five-step pipeline with the brief-attachment step and an updated pipeline doc comment.
- `src/lib/discovery/job.test.ts` - New `vi.mock` for `@/lib/discovery/brf-lookup` (partial mock preserving the real `BRF_TOP_N`) and for `@anthropic-ai/sdk`/`@anthropic-ai/sdk/helpers/zod` (mirrors `vision.test.ts`'s shape, a no-op for every pre-existing test). New `makeBrfSummary`/`baseUsage`/`attr` fixture helpers. Two new `describe` blocks (18 tests total) covering `lookupBrfForTopCandidates`'s selection/concurrency/degradation/budget behaviour and `runVisionForJob`'s ANL-01 non-empty guarantee across all states.
- `.planning/phases/14-holistic-analysis-brain/deferred-items.md` - Logged a recurrence of the pre-existing full-suite timing flake (unrelated concurrency-timing test) already tracked under 14-03.

## Decisions Made

- Comps run BEFORE BRF in the pipeline: comps are per-area/amortized and cheap, and the holistic-brief fallback needs them for EVERY candidate, whereas BRF only ever covers the D-14-01 top-N (D-14-08's front-load-the-cheap-structurally-necessary-spend ordering).
- The brief-attachment branch is a single `hasNoImageClaims(c)` check, not four near-duplicate branches — it does not need to know which of the four states produced the empty claims array.
- The `vision_error` and `claims: []` (Haiku `worthDeepPass: false`) states are driven by mocking `@anthropic-ai/sdk` directly (the same shape `vision.test.ts` already uses), not by mocking `vision.ts` itself — this exercises the REAL `runVisionPass`/`runVisionForCandidate` orchestration end-to-end (including the real per-candidate try/catch and the real cost accounting) rather than reimplementing that logic in a job.test.ts stub. Every pre-existing test in the file uses `imageUrls: null`, so `parse()` is never invoked by them — the new mock is a no-op for the rest of the suite (confirmed: the full 72-test file and the full 874-test suite both stayed green).
- `job.integration.test.ts` received no addition. Every guarantee this plan proves — BRF batching/concurrency, shared-budget gating, the ANL-01 brief guarantee — is pure, Vitest-mockable logic; none of it needs the real Postgres RPC/service-role posture that file exists to test (`claim_discovery_slice`'s atomicity and ownership).

## Deviations from Plan

None — plan executed exactly as written. All acceptance criteria were verified directly via the greps/test runs listed below, not assumed.

## Issues Encountered

- A pre-existing, sandbox-load-dependent timing flake (`job.test.ts`'s "scrapes both areas CONCURRENTLY" test, a fixed `elapsed < 110ms` threshold) failed once under `npm run test`'s full-suite parallel load (`112` vs `110`), then passed on an immediate full-suite re-run (874/877, 3 pre-existing skips) and in isolation. This is the SAME class of flake already logged under 14-03's `deferred-items.md` (a different concurrency-timing test that time) — not in this plan's `files_modified` in a way that changes its timing, not fixed (out of scope per the SCOPE BOUNDARY rule), recorded as a recurrence in `deferred-items.md`.

## Verification (from the plan's `<verification>` block)

- `npx vitest run src/lib/discovery/job.test.ts src/lib/discovery/job.integration.test.ts` — **72/72 passed | 1 pre-existing skip**.
- `npx vitest run src/lib/discovery/brf-lookup.test.ts src/lib/discovery/confounder-guard.test.ts src/lib/discovery/vision.test.ts src/lib/discovery/condition-score.test.ts src/lib/discovery/cost.test.ts` — **104/104 passed** (combined run with `niche-score.test.ts`).
- `npx vitest run src/lib/discovery/niche-score.test.ts` — passed within the combined run above; the structural-separation guard is unaffected (`job.ts` already imported `discovery/confounder-guard`/`discovery/brf-lookup` as of 14-01/14-05; `niche-score.ts`/`flags.ts` still import neither).
- `npx tsc --noEmit` — clean.
- `npm run lint` — clean.
- `npm run test` (full suite) — **874 passed | 3 skipped** (the 3 skips are pre-existing, unrelated to this plan; see Issues Encountered for one flaky re-run).

### Acceptance-criteria checks (confirmed directly, not assumed)

- `lookupBrfForTopCandidates`/`BrfResolution` exported from `src/lib/discovery/job.ts` — confirmed.
- Selection expression is exactly `enrichmentVisitOrder(candidates).filter((i) => candidates[i].brfName !== null).slice(0, BRF_TOP_N)` — no new priority function defined.
- `grep -c 'Promise.allSettled' src/lib/discovery/job.ts` → `8` (well above the required minimum of 3: `runSlice`'s, comps's two, this plan's new one, plus doc-comment mentions); no `await lookupBrfSummary` inside a `for` loop.
- `lookupBrfForTopCandidates` takes no `supabase` parameter; its body contains zero `.from(` calls.
- `grep -c 'analyses' src/lib/discovery/job.ts` → `0`.
- `runVisionForJob` calls, in order: `enrichCandidateImages`, `resolveCompsForCandidates`, `lookupBrfForTopCandidates`, `runVisionPass`, the brief attachment, then exactly one `updateJob` — confirmed via source read.
- `runVisionPass` is called with `initialSpentSek: comps.spentSek + brf.spentSek`; the BRF budget is `Math.max(0, CAP_VISION_SEK_MAX - comps.spentSek)` — both confirmed via grep.
- `git diff src/lib/discovery/vision.ts` → empty (this plan touches zero lines in `vision.ts`); `grep -c 'visionResultSchema\|claims: \[\]' src/lib/discovery/vision.ts` → `2`, unchanged from before this plan.
- The final `updateJob` payload has exactly the keys `results` and `status` — confirmed by a dedicated new test AND the pre-existing `toEqual(["results","status"])` assertions passing unchanged.

## Known Stubs

None — every code path is fully implemented and exercised by a real (mocked-only-at-the-network/LLM-edge) test; no placeholder/mock data path exists in the shipped (non-test) code.

## Threat Flags

None beyond what the plan's own `<threat_model>` already disposes (T-14-23 through T-14-29, T-14-SC): the BRF path constructs no URL and adds no `fetch` call (delegated wholly to `brf-lookup.ts`, confirmed by the zero-`analyses`/zero-`.from(` greps); every non-`"ok"` outcome is now logged so a run that never reaches `"high"` confidence is diagnosable; only the aggregate `BrfSummary` ever crosses into `job.ts` (no raw document text, no `analyses`-table write); the bounded `Promise.allSettled` over `BRF_TOP_N=4` plus the concurrency test satisfies the DoS/availability mitigation; the pre-spend budget gate plus the exhausted-pool test satisfies the DoS/cost mitigation; a failed lookup yields `brfSummary: null` which `normalizeForConfounders` records as `"brf_unknown"` (never a zero-debt assumption).

## User Setup Required

None - no external service configuration required. No DB migration (BRF summaries and holistic briefs ride in the existing JSONB `results` column via fields already added in 14-01).

## Operator Next Steps — DEFERRED-LIVE (does NOT block phase completion, per the Phase 13 DXUX-01 precedent)

1. **Restore the paused Supabase project** (`nsheegvczxjeeayngqrv`, per project memory `supabase-project-paused` — needs a manual dashboard Restore) and run from a non-Booli/Cloudflare-blocked IP with `DISCOVERY_ENABLED=true`.
2. Query **"Renoveringsobjekt i Södermalm och Vasastan under 4 miljoner"** through to completion and confirm:
   - Comps are fetched once per area (not per candidate) — already proven by 14-05's unit tests; confirm under live load.
   - BRF is attempted only for the top-N (`BRF_TOP_N=4`) candidates by `enrichmentPriority`.
   - `resolveOrgNr` reaches `confidence: "high"` for at least one unambiguous match — log its confidence per top-N candidate. This is the FIRST live opportunity to observe the 14-03 genitive-kommun fix fire against real Allabrf/Booli data.
   - The vision budget (comps + BRF + vision combined) stays inside `CAP_VISION_SEK_MAX = 10` SEK; no tick timeout inside the ~300s Server Action ceiling.
   - Every candidate shows at least one actionable item (either an image-derived claim or a holistic brief) — the Ringvägen 122 scenario should no longer dead-end.
3. **Capture real BRF latency** inside the tick: 2 Allabrf fetches + 1 Haiku call per top-N candidate, run concurrently — confirm the real wall-clock addition stays well under the sequential-sum estimate (the Phase 13 WR-02 trap this plan's concurrency discipline exists to avoid).
4. **Capture the `tenureForm` values** across a wide result set — per 14-02's OQ-2 tomträtt-inertness finding, if no tomträtt-shaped value ever appears in real data, record tomträtt-as-confounder as INERT (research OQ-2) rather than assumed working. `tomtrattFromTenureForm` never returns `false` by design (14-01), so this is purely an observational confirmation, not a code change.
5. **Confirm the expected `"cost_cap"` increase**: with three spend sources (comps, BRF, vision) now sharing one 10 SEK pool, a job with a large candidate set should hit `"cost_cap"` MORE often than pre-Phase-14 — this is an intended behaviour change (14-RESEARCH.md Q3), not a regression; visually confirm the holistic brief still appears for those cost-capped candidates.

## Next Phase Readiness

- Phase 14 (ANL-01/02/03/04) is functionally complete: every discovery candidate that leaves the vision pass with no surviving image claims now carries a non-empty, confidence-capped, banned-attribution-guarded holistic brief backed by real comps + BRF data where available, and the UI (14-04) already renders it. `job.ts`'s five-step pipeline is fully wired, budget-shared, and unit-tested end-to-end.
- Phase 15/16 can consume `DiscoveryCandidate.areaComps`/`brfSummary`/`holisticBrief` directly — all three are already populated by this plan's pipeline and persisted in the existing JSONB `results` column, with no migration required.
- No blockers for `/gsd-verify-phase 14`. The five DEFERRED-LIVE items above are operator-gated verifications against a live Supabase/Allabrf/Booli environment, not phase-completion blockers — the Supabase pause and Booli/Cloudflare IP block noted throughout this phase's summaries still apply and must be resolved before any of them can be executed.

## Self-Check: PASSED

All claimed files exist on disk (`src/lib/discovery/job.ts`, `src/lib/discovery/job.test.ts`, `.planning/phases/14-holistic-analysis-brain/deferred-items.md`) and all three task commit hashes (`4296394`, `6d3a464`, `6adef2f`) are present in `git log`.

---
*Phase: 14-holistic-analysis-brain*
*Completed: 2026-08-06*
