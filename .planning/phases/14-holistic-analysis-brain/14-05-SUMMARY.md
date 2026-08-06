---
phase: 14-holistic-analysis-brain
plan: 05
subsystem: discovery
tags: [area-comps, booli-client, cost-cap, promise-allsettled, holistic-schema]

# Dependency graph
requires:
  - phase: 14-holistic-analysis-brain
    plan: 01
    provides: "DiscoveryCandidate.areaComps + AreaCompsSummary type/read-guard, so this plan has a persisted slot to write real comps into"
  - phase: 14-holistic-analysis-brain
    plan: 02
    provides: "WIDENED_SIZE_BAND_PCT/WIDENED_MAX_AGE_MONTHS — the thin-segment widen-or-downgrade constants this plan's second computeAreaComps call consumes"
provides:
  - "renderSek — the single render→SEK conversion in cost.ts; discoveryCostSek refactored onto it (behaviour-preserving)"
  - "estimateCompsFetchSek/estimateBrfLookupSek — named worst-case pre-spend estimators for one area's comps fetch and one BRF extraction, with a D-14-08 headroom test proving the worst-case batch leaves room inside CAP_VISION_SEK_MAX"
  - "runVisionPass(candidates, { initialSpentSek }) — additive-optional seed for the existing budget accumulator, every prior call site/test unchanged"
  - "resolveCompsForCandidates(supabase, candidates, opts) — per-candidate areaLabel resolution + amortized per-area comps fetch, exported from job.ts"
  - "runVisionForJob's pipeline order is now enrich -> comps -> vision -> persist, with comps/vision sharing ONE CAP_VISION_SEK_MAX pool"
affects: [15, 16]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Named worst-case pre-spend estimator built from the real cost model (mirrors estimateVisionCallSek), never an arbitrary average"
    - "Check-before-spend budget pre-gate computed BEFORE any network call (mirrors runVisionPass/runSlice)"
    - "Concurrent Promise.allSettled over both a resolve step and a fetch step, de-duped by the RESOLVED id (not the input label), so two different inputs collapsing to one real resource still produce exactly one network call"
    - "Whole-body try/catch with accumulators declared OUTSIDE the try so an unexpected error returns partial progress instead of discarding it"

key-files:
  created: []
  modified:
    - src/lib/discovery/cost.ts
    - src/lib/discovery/cost.test.ts
    - src/lib/discovery/vision.ts
    - src/lib/discovery/vision.test.ts
    - src/lib/discovery/job.ts
    - src/lib/discovery/job.test.ts

key-decisions:
  - "Rule 1 reconciliation on the plan's own test-list item (i): the plan asked for a '4-comp' thin tight segment where confident stays false even AFTER widening admits more comps — mathematically impossible once MIN_COMPS_FOR_CONFIDENCE=5, since a widen is only kept when strictly larger than the tight count (4 -> minimum 5, which flips confident to true). The test instead starts the tight segment at 3 comps and widens to 4, demonstrating identical widen-or-downgrade mechanics while satisfying 'confident: false either way' literally."
  - "resolution == null (loose), not === null, when checking a resolveArea outcome inside resolveCompsForCandidates — the real contract returns AreaResolution | null, but a test double (or a future caller) returning undefined must degrade identically rather than crash into the whole-body catch over a loose-vs-strict nullish distinction."
  - "Two pre-existing runVisionForJob test blocks in job.test.ts were given a scoped resolveArea.mockResolvedValue(undefined) override (fix by configuration, per the plan's own instruction) rather than relying on the whole-body catch's crash-recovery path to keep comps cleanly skipped and the assertions unweakened."
  - "The initialSpentSek/comps-wiring test asserts via an exhausted-budget outcome (an artificially large mocked rendersUsed, never realistic) rather than spying on the vision module — keeps job.test.ts's existing Anthropic-free unit-test posture with zero new SDK mocking."

requirements-completed: [ANL-02]

# Metrics
duration: 17min
completed: 2026-08-06
---

# Phase 14 Plan 05: Real Area Comps Wiring Summary

**Wired real renovated-vs-unrenovated area comps (R_med/U_med) into every enriched discovery candidate via a new `resolveCompsForCandidates`, resolved once per distinct areaId and folded into the single `CAP_VISION_SEK_MAX` budget pool shared with the vision pass.**

## Performance

- **Duration:** ~17 min
- **Completed:** 2026-08-06T15:39:31Z
- **Tasks:** 3
- **Files modified:** 6 (0 created, 6 modified)

## Accomplishments

- `computeAreaComps` (built 2026-07-10, tested since) is finally called on the live discovery path — every candidate with a resolvable `areaLabel` now carries a real `AreaCompsSummary` (R_med/U_med + overall + cap + sample size + confidence) instead of the field staying permanently `null`, closing the D3 image-only-analysis gap for ANL-02.
- `renderSek` is now the single render→SEK conversion in `cost.ts` — `discoveryCostSek` was refactored to call it (behaviour-preserving; the pre-existing test passes with NO edit to its assertion), and `estimateCompsFetchSek`/`estimateBrfLookupSek` are named worst-case pre-spend estimators built from the real cost model, with a headroom test proving two areas' comps plus a full 4-candidate BRF batch stays inside `CAP_VISION_SEK_MAX=10`.
- `runVisionPass` gained an additive-optional `initialSpentSek` that seeds its existing budget accumulator — every pre-existing call site and test is byte-for-byte unchanged, and an exhausted pool provably makes zero Anthropic calls.
- `resolveCompsForCandidates` resolves each candidate's OWN `areaLabel`, de-dupes the fetch set BY resolved areaId (not by label — two labels can resolve to the same area), and runs BOTH the area-resolve step and the comps-fetch step concurrently via `Promise.allSettled`, so wall clock is max(area times) not sum(area times).
- A thin tight comp segment (`sampleSize < MIN_COMPS_FOR_CONFIDENCE`) triggers exactly one widened re-computation (`WIDENED_SIZE_BAND_PCT`/`WIDENED_MAX_AGE_MONTHS` from 14-02), kept only when it strictly grows the sample — never presented as more confident than it is.
- Every failure path — an unresolvable areaLabel, a `null` resolution, a throwing `fetchSoldComps` call, budget exhaustion, or any unexpected error — degrades that candidate's `areaComps` to absent and never fails the tick; the whole function body is wrapped so a partial `CompsResolution` is always returned rather than discarded.
- `runVisionForJob`'s pipeline is now **enrich → comps → vision → persist**: comps spend is computed BEFORE vision and seeds `runVisionPass`'s `initialSpentSek`, so comps, BRF (future), and vision all share ONE `CAP_VISION_SEK_MAX` ceiling — the terminal `updateJob` payload still writes exactly `results` and `status`.
- Only the pre-aggregated `AreaCompsSummary` is ever persisted — the raw `SoldComp[]` fetched per area lives in an in-memory `Map` local to one `resolveCompsForCandidates` call, never reaching the returned result or `discovery_jobs.results` (verified by a dedicated key-set test).

## Task Commits

Each task was committed atomically:

1. **Task 1: Factor render→SEK conversion into renderSek and add the comps/BRF spend estimators** - `c993c4f` (feat)
2. **Task 2: Give runVisionPass an additive-optional initialSpentSek so one budget pool spans comps, BRF and vision** - `2de4178` (feat)
3. **Task 3: Add resolveCompsForCandidates and wire it into runVisionForJob** - `7828290` (feat)

_No TDD tasks in this plan — all three are single feat commits (module extension + wiring, same-commit tests, not separate RED/GREEN cycles)._

## Files Created/Modified

- `src/lib/discovery/cost.ts` - `renderSek` (the single render→SEK conversion), `COMPS_MAX_RENDERS_PER_AREA=2`, `estimateCompsFetchSek`, `BRF_EXTRACT_INPUT_TOKENS_ESTIMATE=60_000`, `BRF_EXTRACT_MAX_OUTPUT_TOKENS=2048`, `estimateBrfLookupSek`; `discoveryCostSek` refactored to call `renderSek` instead of inlining the formula.
- `src/lib/discovery/cost.test.ts` - Tests for `renderSek`'s clamping (0/negative/NaN), `discoveryCostSek`'s behaviour-preserving refactor, `estimateCompsFetchSek`/`COMPS_MAX_RENDERS_PER_AREA`, `estimateBrfLookupSek`'s lower/upper bounds, and the D-14-08 headroom arithmetic check.
- `src/lib/discovery/vision.ts` - `runVisionPass`'s `opts` type gains `initialSpentSek?: number`; `runningVisionSek` seeds from it (finite/non-negative, else 0); extended doc comment records the D-14-08 shared-pool rationale and the intended `"cost_cap"`-more-often side effect.
- `src/lib/discovery/vision.test.ts` - New `describe("runVisionPass — shared budget pool via initialSpentSek (D-14-08)")`: exhausted pool → zero Anthropic calls; `0`/omitted are deep-equal; `undefined`/negative/`NaN` all behave as 0; a partial budget allows exactly one call before `cost_cap`.
- `src/lib/discovery/job.ts` - New `resolveCompsForCandidates` + `CompsResolution` export + `buildCompsQuery` helper; `runVisionForJob` now calls `resolveCompsForCandidates` between `enrichCandidateImages` and `runVisionPass`, attaching `areaComps` and threading `initialSpentSek`.
- `src/lib/discovery/job.test.ts` - `fetchSoldComps` added to the wholesale `@/lib/booli/client` mock; new `describe("resolveCompsForCandidates — ANL-02 amortized per-area comps")` (10 tests, items a-j from the plan) and `describe("runVisionForJob — comps wiring")` (2 tests); two pre-existing `runVisionForJob` describe blocks given a scoped `resolveArea.mockResolvedValue(undefined)` so comps cleanly skip without altering their original assertions.

## Decisions Made

- `resolution == null` (loose), not `=== null` — the real `resolveArea` contract returns `AreaResolution | null`, but treating an `undefined` outcome identically avoids a spurious crash-into-whole-body-catch over a loose-vs-strict nullish distinction that carries no real behavioral meaning.
- The `initialSpentSek` wiring test asserts via an exhausted-budget outcome (mocking an unrealistically large `rendersUsed` to prove the arithmetic, not a realistic fetch result) rather than spying on the `vision` module — keeps `job.test.ts`'s existing Anthropic-free unit-test posture intact with zero new SDK mocking, per the plan's own "whichever keeps the existing posture" latitude.
- The probe-render charging rule: a `resolveArea` resolution with `source: "probe"` adds exactly `renderSek(1)` to `spentSek` (a live search-box probe is a real Apify render); a `"seed"` or `"cache"` resolution costs nothing, matching `resolveArea`'s own resolution-order cost profile.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Self-referential grep trap in cost.ts's renderSek doc comment**
- **Found during:** Task 1, immediately after writing `renderSek`'s doc comment
- **Issue:** The doc comment explaining "don't re-inline the formula" literally quoted `renders * USD_PER_RENDER * USD_SEK_RATE`, tripping the plan's own acceptance-criteria grep (`grep -c 'USD_PER_RENDER \* USD_SEK_RATE'` must return exactly 1, only inside the real implementation) — the comment's own citation counted as a second occurrence.
- **Fix:** Reworded the comment to describe the arithmetic without quoting the literal substring. Re-ran the grep: returns 1.
- **Files modified:** `src/lib/discovery/cost.ts`
- **Commit:** `c993c4f`

**2. [Rule 1 - Bug] Test-list item (i)'s literal "4 comps + confident:false either way" is mathematically impossible**
- **Found during:** Task 3, while designing the thin-segment widen test
- **Issue:** The plan's action text asks for a tight segment of exactly 4 comps where `confident` stays `false` even after the widened re-computation. `MIN_COMPS_FOR_CONFIDENCE=5` and a widen is only KEPT when it is strictly larger than the tight count, so starting at 4 forces the widened count to be >=5 by construction — which flips `confident` to `true`, contradicting "confident: false either way" in the same sentence.
- **Fix:** Started the tight segment at 3 comps (still thin, still `< MIN_COMPS_FOR_CONFIDENCE`) and widened to 4 — the exact same widen-or-downgrade code path is exercised, and `confident: false` now holds both before and after widening, literally satisfying the "either way" requirement. Documented in the test's own comment.
- **Files modified:** `src/lib/discovery/job.test.ts`
- **Commit:** `7828290`

---

**Total deviations:** 2 auto-fixed (2 bugs — both self-referential/internally-inconsistent plan-text traps, same class as the 14-01/14-03 precedents)
**Impact on plan:** No scope creep; both fixes preserve the plan's intended meaning/behavior while resolving an internal contradiction in the plan's own literal wording.

## Issues Encountered

None beyond the two auto-fixed issues documented above. All pre-existing `runSlice`/`runVisionForJob` tests passed unmodified once the two scoped `resolveArea` overrides were added (fix by configuration, never by weakening an assertion, per the plan's own instruction).

## Verification (from the plan's `<verification>` block)

- `npx vitest run src/lib/discovery/cost.test.ts src/lib/discovery/vision.test.ts src/lib/discovery/job.test.ts src/lib/discovery/job.integration.test.ts src/lib/discovery/area-comps.test.ts` — **all passed** (`job.integration.test.ts` is pre-existing-skipped, needs a live DB env, unaffected by this plan).
- `npx vitest run src/lib/discovery/niche-score.test.ts` (separation guard) — **27/27 passed** (`job.ts` now imports `area-comps`/`confounder-guard`, which is allowed per the plan; `niche-score.ts`/`flags.ts` still import neither — unaffected).
- `npx tsc --noEmit` — clean.
- `npm run lint` — clean.
- `npm run test` (full suite) — **855 passed | 3 skipped** (the 3 skips are pre-existing, unrelated to this plan).

### Acceptance-criteria checks (confirmed directly, not assumed)

- `grep -c 'USD_PER_RENDER \* USD_SEK_RATE' src/lib/discovery/cost.ts` → `1` (only inside `renderSek`'s real implementation).
- `COMPS_MAX_RENDERS_PER_AREA === 2`, `BRF_EXTRACT_MAX_OUTPUT_TOKENS === 2048` — asserted directly.
- `estimateBrfLookupSek() >= 0.71` and `< CAP_VISION_SEK_MAX` — asserted directly.
- `grep -c 'initialSpentSek' src/lib/discovery/vision.ts` → `5` (type, seed, doc-comment mentions).
- `git diff src/lib/discovery/vision.ts` shows NO change to the `runningVisionSek + estimate > CAP_VISION_SEK_MAX` gate expression or `costCapHit` mechanics — confirmed via diff inspection.
- `resolveCompsForCandidates`/`CompsResolution` exported from `src/lib/discovery/job.ts` — confirmed.
- `grep -cE 'for \(const .* of .*await|await fetchSoldComps\(' src/lib/discovery/job.ts` → `0` (both the resolve step and the fetch step use `Promise.allSettled`, no sequential await-in-loop).
- Test (j) asserts `Object.keys(summary).sort()` exactly equals the 9-field `AreaCompsSummary` list — no raw comp rows persisted.
- The pre-existing `expect(Object.keys(updateCalls[0]).sort()).toEqual(["results", "status"])` assertion passes UNCHANGED in both its original test locations.

## Known Stubs

None — every code path is fully implemented and unit-tested; no placeholder/mock data path exists in the shipped (non-test) code.

## Threat Flags

None beyond what the plan's own `<threat_model>` already disposes (T-14-18 through T-14-22, T-14-SC): the synthesized breadcrumb URL is built from a `resolveArea`-returned areaId re-validated by `resolveAreaId`'s digits-only regex and re-encoded via `URLSearchParams` (no new host, no new outbound transport); comps are de-duped by areaId and capped at `MAX_AREAS_PER_SEARCH` with a pre-spend gate; the existing `claimVisionSlice` CAS already covers the new comps spend with zero new code; only the aggregate `AreaCompsSummary` is ever persisted (test-verified); every failure path degrades via `Promise.allSettled` + a whole-body catch, proven non-fatal.

## User Setup Required

None - no external service configuration required. No DB migration (comps ride in the existing JSONB `results` column via `DiscoveryCandidate.areaComps`, added in 14-01).

## Operator Next Steps — DEFERRED-LIVE

- **[Phase 14 Plan 05 — DEFERRED-LIVE, does NOT block phase completion]** Confirm on a real discovery job that: (1) real Apify comps come back non-empty for a real resolved areaId, (2) comps are genuinely fetched once per area rather than once per candidate under live conditions, and (3) the true wall-clock stays inside the ~300s tick window with the new comps step added to the pipeline.
  - **Blocked by:** the Supabase project pause (`nsheegvczxjeeayngqrv`, per project memory `supabase-project-paused` — needs a manual dashboard Restore) and the Booli/Cloudflare IP block noted in 14-VALIDATION.md.
  - **Verified instead via:** the full `resolveCompsForCandidates`/`runVisionForJob` unit-test suite above (10 + 2 new tests covering amortization, concurrency, budget gating, widen-or-downgrade, and the shared-pool wiring).
  - Run "Renoveringsobjekt i Södermalm och Vasastan under 4 miljoner" once Supabase is restored, per the plan's own `<verification>` DEFERRED-LIVE instruction, and confirm real `rendersUsed` spend stayed inside `CAP_VISION_SEK_MAX`.

## Next Phase Readiness

- `resolveCompsForCandidates`/`CompsResolution`/`renderSek`/`estimateCompsFetchSek`/`estimateBrfLookupSek` are all stable, exported, and unit-tested — ready for Plan 14-06 (BRF-fetch wiring, which will consume `estimateBrfLookupSek` and the same shared budget pool via `initialSpentSek`) and Phase 15/16 (which consume `DiscoveryCandidate.areaComps`'s R_med/U_med for the ROI-aware brief and value-gap ranking).
- No blockers for continuing Phase 14. The DEFERRED-LIVE comps run above is an operator step, not a phase-completion gate.

## Self-Check: PASSED

All claimed files exist on disk (`src/lib/discovery/cost.ts`, `cost.test.ts`, `vision.ts`, `vision.test.ts`, `job.ts`, `job.test.ts`) and all three task commit hashes (`c993c4f`, `2de4178`, `7828290`) are present in `git log` — verified directly, not assumed.

---
*Phase: 14-holistic-analysis-brain*
*Completed: 2026-08-06*
