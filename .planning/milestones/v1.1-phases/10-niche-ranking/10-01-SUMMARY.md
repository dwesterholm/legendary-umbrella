---
phase: 10-niche-ranking
plan: 01
subsystem: discovery
tags: [zod, typescript, deterministic-scoring, discovery, niche-ranking]

# Dependency graph
requires:
  - phase: 09-discovery-foundation
    provides: "DiscoveryCandidate 7-field PII-safe allowlist, toCandidate/discoveryCandidateSchema, filterCandidates"
provides:
  - "DiscoveryCandidate extended to 10 PII-safe fields (constructionYear, brfName, tenureForm)"
  - "NICHE_WEIGHTS single-source-of-truth weight/threshold table for the 3 niches"
  - "computeNicheScore pure deterministic scorer with cited-signal breakdown"
affects: [10-02-niche-ranking-frontend]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "computeNicheScore mirrors computeBrfGrade's push()-accumulator + not_assessable discipline exactly"
    - "SignalContribution mirrors flags.ts's cited-signal shape (sourceRef on every row, no fabricated negatives)"
    - "NICHE_WEIGHTS mirrors BRF_SCORE_THRESHOLDS as the single source-of-truth constant object"

key-files:
  created:
    - src/lib/discovery/niches.ts
    - src/lib/discovery/niche-score.ts
    - src/lib/discovery/niche-score.test.ts
  modified:
    - src/lib/discovery/candidate.ts
    - src/lib/discovery/candidate.test.ts
    - src/lib/discovery/job.test.ts

key-decisions:
  - "discoveryCandidateSchema's 3 new fields use .nullable().optional() (not bare .nullable()) so pre-Phase-10 persisted discovery_jobs.results rows missing the keys entirely still safeParse — no migration, no backfill"
  - "brfName is treated as public-registry data (same class as areaLabel), not occupant/seller PII, per RESEARCH Assumption A1"
  - "imminent-stambyte niche v1 ships as a hedged construction-year proxy keyed 'stambyteProxyAge', deliberately distinct from FLAG_IDS.STAMBYTE_PLANERAT; the real per-candidate BRF-backed signal is deferred (would blow CAP_SEK_MAX if run for every discovery candidate)"
  - "computeNicheScore's internal [0,1] score is used only for sorting and is never rendered bare — the UI (Plan 10-02) always renders the breakdown as cited chips"
  - "renovation-upside rewards old+cheap-per-sqm; turnkey rewards new+Bostadsrätt and explicitly does NOT reward a price discount; imminent-stambyte rewards old via a distinct hedged proxy — this is what makes the 3 orderings distinguishable"

patterns-established:
  - "Deterministic score + auditable breakdown (computeNicheScore) as the third instance of the computeBrfGrade/computeFlags pattern in this codebase"

requirements-completed: [DISC-03]

# Metrics
duration: 12min
completed: 2026-07-07
---

# Phase 10 Plan 1: Data + Deterministic Scorer Core Summary

**Extended the PII-safe DiscoveryCandidate allowlist with 3 already-derived facts and shipped computeNicheScore — a pure, deterministic scorer mirroring computeBrfGrade's push-accumulator and flags.ts's cited-signal discipline, proven to produce distinguishable orderings across the 3 niches on a shared fixture set.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-07-07T10:31:09Z (per STATE.md "Phase 10 execution started")
- **Completed:** 2026-07-07T10:37:46Z
- **Tasks:** 3 completed
- **Files modified:** 6 (3 created, 3 modified)

## Accomplishments
- `DiscoveryCandidate` extended from 7 to 10 PII-safe fields (`constructionYear`, `brfName`, `tenureForm`), still a no-spread explicit allowlist; old pre-Phase-10 persisted rows still `safeParse` via `.nullable().optional()`
- `NICHE_WEIGHTS` single source-of-truth table for the 3 niches (`renovation-upside`, `turnkey`, `imminent-stambyte`), mirroring `BRF_SCORE_THRESHOLDS`'s structure — every numeric boundary is a named constant, no magic numbers in the scorer
- `computeNicheScore` — a pure, synchronous scorer returning an internal composite score plus a cited-signal `breakdown` (never an opaque number), with `assessable:false`/contribution-0 for null facts and a distinctly-keyed hedged proxy (`stambyteProxyAge`) for the stambyte niche
- Cross-niche distinguishability proven by unit test: on a shared 4-candidate fixture set, `turnkey`'s top pick (newest building) differs from `imminent-stambyte`'s top pick (oldest, above-baseline-priced building)

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend the DiscoveryCandidate allowlist** - `b90f425` (feat)
2. **Task 2: NICHE_WEIGHTS single-source-of-truth table** - `87e544f` (feat)
3. **Task 3: computeNicheScore pure scorer + cited-signal breakdown** - `d10f8fb` (feat)

**Deviation fix (Rule 1):** `8a5f87a` (test) — updated `job.test.ts`'s allowlist regression assertion, a direct consequence of Task 1's allowlist extension.

**Plan metadata:** _pending_ (docs: complete plan — committed after this summary)

## Files Created/Modified
- `src/lib/discovery/candidate.ts` - `DiscoveryCandidate` interface + `toCandidate` + `discoveryCandidateSchema` extended with `constructionYear`/`brfName`/`tenureForm`
- `src/lib/discovery/candidate.test.ts` - Exact-key allowlist test updated to 10 keys; new old-shape-row backward-compat `safeParse` test added
- `src/lib/discovery/job.test.ts` - Regression test's expected allowlist shape updated to match the extended `DiscoveryCandidate` (Rule 1 fix)
- `src/lib/discovery/niches.ts` - NEW: `NicheId`, `NICHE_IDS`, `NICHE_WEIGHTS` — the single source of truth for every niche weight/threshold
- `src/lib/discovery/niche-score.ts` - NEW: `computeNicheScore`, `SignalContribution`, `NicheScoreResult`, `AreaBaseline` — the pure deterministic scorer
- `src/lib/discovery/niche-score.test.ts` - NEW: determinism, not_assessable null handling, stambyte proxy key discipline, weights-sum-to-1, cross-niche distinguishability tests

## Decisions Made
- `.nullable().optional()` (not bare `.nullable()`) on the 3 new Zod fields — the load-bearing choice that lets pre-Phase-10 rows missing the keys entirely still parse, avoiding a migration/backfill
- `toCandidate` reads `raw.brfName` as a plain string (already computed by `reshapeListingEntity` via `brfNameFromBreadcrumbs` at client.ts:227) rather than re-deriving it — keeps the mapper a pure allowlist read, no re-derivation logic duplicated
- Per-niche weight design: `renovation-upside` = old + cheap-per-sqm (50/50); `turnkey` = new (70%) + Bostadsrätt-match (30%), deliberately NOT rewarding a price discount; `imminent-stambyte` = 100% on the hedged construction-year proxy, since the real BRF-backed signal is out of scope for v1
- `computeNicheScore`'s composite score is explicitly documented as internal-only/never-rendered-bare, matching the binding UI-SPEC constraint that Plan 10-02 must honor

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated job.test.ts's allowlist regression test to match the extended DiscoveryCandidate**
- **Found during:** Post-Task-3 full suite run
- **Issue:** `job.test.ts`'s `runSlice` happy-path test asserted the OLD 7-key allowlist shape (`Object.keys(results[0]).sort()` + a full `toEqual`), which Task 1 of this same plan intentionally extended to 10 keys — the test was failing after the allowlist change, not because of a bug in the new code but because a sibling regression test hadn't been told about the (in-plan) shape change.
- **Fix:** Updated the expected key array and the full-object `toEqual` to include `constructionYear`/`brfName`/`tenureForm` as `null` (the test's mocked raw entity carries none of these fields, so `null` is the correct expected value).
- **Files modified:** `src/lib/discovery/job.test.ts`
- **Verification:** `npx vitest run` — full suite green (491 passed, 2 skipped)
- **Committed in:** `8a5f87a`

---

**Total deviations:** 1 auto-fixed (1 bug fix, directly caused by this plan's own Task 1 change)
**Impact on plan:** No scope creep — this is the expected ripple effect of intentionally widening the PII-safe allowlist; every other test in the suite already accounted for the extension or was unaffected.

## Issues Encountered
- Initial cross-niche distinguishability test fixture had two candidates tie for the `imminent-stambyte` top spot (both clamped to the max sub-score below the `stambyteProxyYearCutoff`). Resolved by redesigning the fixture set so exactly one candidate is strictly below the cutoff while another sits just above it — no production code change needed, this was a test-fixture-only adjustment caught before any commit.

## User Setup Required

None - no external service configuration required. No migration was created (JSONB additive extension per RESEARCH Open Question 3, resolved).

## Next Phase Readiness

Plan 10-02 (frontend: niche selector, results component, extended candidate card, page wiring) can now consume:
- The 10-field `DiscoveryCandidate` type and its `.nullable().optional()`-safe read-path schema
- `NICHE_IDS`/`NICHE_WEIGHTS` for the niche selector's option list and Swedish copy mapping
- `computeNicheScore` as the pure, client-side, zero-network reorder function

No blockers. The area price/sqm baseline (`AreaBaseline`) must be computed client-side by Plan 10-02 per RESEARCH Assumption A4 (sold-comps infra doesn't fit a stored discovery job — computed as a pure median over the candidate set itself), not reused from `market/compare.ts` directly.

---
*Phase: 10-niche-ranking*
*Completed: 2026-07-07*

## Self-Check: PASSED

All 6 created/modified source files and the SUMMARY.md itself confirmed present on disk; all 4 task/deviation commit hashes (`b90f425`, `87e544f`, `8a5f87a`, `d10f8fb`) confirmed present in `git log`.
