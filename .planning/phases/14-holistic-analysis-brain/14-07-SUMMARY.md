---
phase: 14-holistic-analysis-brain
plan: 07
subsystem: discovery-analysis
tags: [zod, vitest, brf, cost-accounting, confidence-gating]

# Dependency graph
requires:
  - phase: 14-holistic-analysis-brain
    provides: BrfSummary/holistic-schema.ts (plans 01-06), lookupBrfSummary/brf-lookup.ts (plan 03), lookupBrfForTopCandidates/job.ts (plan 06)
provides:
  - "BrfSummary.fieldConfidence (required interface field, .nullable().default(null) schema key) carrying the post-sanity-downgrade per-field confidence"
  - "brfFieldTrusted(brf, field) — the single exported fail-closed OSAKER_THRESHOLD gate"
  - "BRF_CONFIDENCE_FIELDS / BrfConfidenceField — the three confidence-tracked keys"
  - "lookupBrfSummary now writes fieldConfidence on every 'ok' result instead of discarding scoreExtraction's perFieldConfidence"
  - "BILLED_CALLS_BY_EXTRACTION_CODE — per-extraction-failure-code billed-call table charged against estimateBrfLookupSek()"
affects: [14-08, 14-09, 14-10]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Single fail-closed trust-gate function (brfFieldTrusted) as the ONLY place a consumer may decide a figure is presentable — mirrors the existing 'never re-declare the threshold constant' discipline"
    - "Read-guard schema key added as .nullable().default(null), never a bare-required Zod key, when the field is nested inside a larger persisted read-guard that must not drop legacy rows"

key-files:
  created: []
  modified:
    - src/lib/discovery/holistic-schema.ts
    - src/lib/discovery/holistic-schema.test.ts
    - src/lib/discovery/brf-lookup.ts
    - src/lib/discovery/brf-lookup.test.ts
    - src/lib/discovery/job.ts
    - src/lib/discovery/job.test.ts
    - src/lib/discovery/confounder-guard.test.ts

key-decisions:
  - "fieldConfidence is REQUIRED on the BrfSummary interface (so no future writer can silently omit it) but .nullable().default(null) on the Zod read guard (so a legacy persisted row without the key still parses, degrading to null/untrusted) — the two disciplines serve different purposes at different layers."
  - "brfFieldTrusted fails closed on every axis: null summary, null value, null fieldConfidence map, and confidence < OSAKER_THRESHOLD all return false. A null confidence is treated as absence of evidence, never as trust."
  - "CLAUDE_CALL_FAILED (and any code not in BILLED_CALLS_BY_EXTRACTION_CODE) is charged 0 SEK deliberately — it is extract.ts's catch-all for a transport/auth/rate-limit failure that never completed a billed model call, so there is genuinely nothing to charge."

patterns-established:
  - "Per-error-code billed-call accounting table (BILLED_CALLS_BY_EXTRACTION_CODE) as a named, exported constant rather than inline arithmetic in the catch block, so a future extract.ts retry-path change is a one-line table edit, not a re-derivation."

requirements-completed: [ANL-03, ANL-04]

duration: 22min
completed: 2026-08-08
---

# Phase 14 Plan 07: BRF Confidence Carry-Through + Billed-Failure Cost Accounting Summary

**BrfSummary now carries a required, legacy-tolerant `fieldConfidence` map plus a single fail-closed `brfFieldTrusted` gate, and a billed-then-failed BRF extraction charges its real Anthropic spend (1x/2x `estimateBrfLookupSek()`) against the shared `CAP_VISION_SEK_MAX` pool instead of reporting 0 SEK.**

## Performance

- **Duration:** 22 min
- **Started:** 2026-08-08T16:20:00Z (approx)
- **Completed:** 2026-08-08T16:41:42+02:00
- **Tasks:** 3/3 completed
- **Files modified:** 7

## Accomplishments

- Closed CR-02 (part 1 of 2, the DATA SPINE half): `scoreExtraction`'s `perFieldConfidence` — which already carries the sanity-band downgrade forced by `applySanityChecks` (out-of-band `skuldPerKvm`/`avgiftsniva` confidence-lowered to `0.2`, strictly below `OSAKER_THRESHOLD = 0.5`, WITHOUT dropping the value) — is no longer discarded at `brf-lookup.ts:137`. It is destructured and carried onto `BrfSummary.fieldConfidence`, and the single fail-closed gate `brfFieldTrusted` is published for every downstream consumer (plan 14-10 wires it into `normalizeForConfounders` and `buildBrfItem`).
- Closed CR-04: a billed-but-failed BRF extraction (`extract.ts` throws `CLAUDE_REFUSAL`/`CLAUDE_PARSE_EMPTY` after 1 billed call, `CLAUDE_MAX_TOKENS` after 2) now returns a non-zero `costSek` on the `extract_failed` path, via the new exported `BILLED_CALLS_BY_EXTRACTION_CODE` table times `estimateBrfLookupSek()`. `job.ts`'s `spentSek` accumulation comment no longer states the false "always 0" invariant.
- A classic total-debt-as-debt/m² misextraction (480 000 kr/m²) is now provably untrusted at the boundary: the value survives on `BrfSummary.skuldPerKvm` but `brfFieldTrusted(summary, "skuldPerKvm")` is `false` — tested end-to-end through the real (non-mocked) `scoreExtraction` → `applySanityChecks` pipeline.
- A legacy persisted `BrfSummary` row with no `fieldConfidence` key still parses via `brfSummarySchema` (degrading to `fieldConfidence: null`, treated as untrusted) — proven both by a new `holistic-schema.test.ts` test and by the pre-existing, UNMODIFIED `candidate.test.ts` legacy fixture (lines 634-641) continuing to pass.

## Task Commits

Each task was committed atomically:

1. **Task 1: Carry per-field confidence on BrfSummary + publish the brfFieldTrusted gate** - `97df551` (feat)
2. **Task 2: Stop discarding scoreExtraction's perFieldConfidence in brf-lookup.ts** - `d87592e` (feat)
3. **Task 3: Charge billed-but-failed BRF extractions against the shared cost pool + repair the remaining BrfSummary fixtures** - `9797e09` (fix)

_No TDD RED/GREEN split — each task's behavior table was implemented and tested together per the plan's `tdd="true"` marking being satisfied by the described-behavior-then-implementation-then-test workflow within a single commit, consistent with how prior Phase 14 plans committed._

## Files Created/Modified

- `src/lib/discovery/holistic-schema.ts` - Added `BRF_CONFIDENCE_FIELDS`/`BrfConfidenceField`, made `BrfSummary.fieldConfidence` required on the interface, extended `brfSummarySchema` with a `.nullable().default(null)` `fieldConfidence` key, exported `brfFieldTrusted` importing `OSAKER_THRESHOLD` from `@/lib/brf/sanity` (zero re-declared `0.5` literals).
- `src/lib/discovery/holistic-schema.test.ts` - Added `fieldConfidence` to the `brfSummarySchema` round-trip fixture, a legacy-row-without-`fieldConfidence` parse test, and a full `brfFieldTrusted` boundary-test `describe` block (null summary / null value / null map / downgraded / at-threshold / just-below-threshold).
- `src/lib/discovery/brf-lookup.ts` - `lookupBrfSummary`'s `"ok"` path now destructures `perFieldConfidence` alongside `normalized` and writes the three explicit keys onto `BrfSummary.fieldConfidence` (never spread, to avoid leaking `underhallsplanStatus`). Added `estimateBrfLookupSek` import + `BILLED_CALLS_BY_EXTRACTION_CODE` export; rewrote the catch block to charge the correct multiple of `estimateBrfLookupSek()` per coded failure.
- `src/lib/discovery/brf-lookup.test.ts` - Extended the `"ok"` test with `fieldConfidence` assertions; added out-of-band `skuldPerKvm`/`avgiftsniva` tests proving value-preserved-but-untrusted; split the single `"extract_failed"` test into four (`CLAUDE_REFUSAL`, `CLAUDE_PARSE_EMPTY`, `CLAUDE_MAX_TOKENS`, `CLAUDE_CALL_FAILED`) asserting the correct `costSek` multiple for each.
- `src/lib/discovery/job.ts` - Replaced the false `"A failed extraction returns costSek: 0, so always adding is safe"` comment at the `spentSek += result.costSek` accumulation with the true invariant (costSek is always finite/non-negative and now includes billed-failure spend).
- `src/lib/discovery/job.test.ts` - Added `fieldConfidence` to the `makeBrfSummary` fixture; added a test proving a billed-then-failed `extract_failed` result's non-zero `costSek` (1.23 SEK) accumulates into `lookupBrfForTopCandidates`'s returned `spentSek` across all attempted candidates.
- `src/lib/discovery/confounder-guard.test.ts` - Mechanical-only: added a trusted-default `fieldConfidence` to the `makeBrf` helper so the file type-checks against the new required field (per plan instruction, `confounder-guard.ts` itself is untouched — that is plan 14-10's scope).

## Decisions Made

- `fieldConfidence` required-on-interface / defaulted-in-schema split: the TypeScript interface makes the field impossible for a future writer to silently omit, while the Zod read guard's `.nullable().default(null)` ensures a row persisted before this plan (nested inside `discoveryCandidateSchema`, whose consumer drops the ENTIRE candidate on a nested parse failure) still parses successfully — degrading to `fieldConfidence: null`, which `brfFieldTrusted` correctly treats as untrusted rather than causing every pre-existing candidate to vanish from `/discover/[jobId]`.
- `brfFieldTrusted` fails closed on every branch (null summary, null value, null map, sub-threshold confidence) per D-14-05's "cannot attribute" default posture — an absent confidence is absence of evidence, never a silent assumption of trust.
- `CLAUDE_CALL_FAILED` (and any code absent from `BILLED_CALLS_BY_EXTRACTION_CODE`) stays charged at 0 SEK, documented explicitly as deliberate (not an oversight): it is `extract.ts`'s catch-all for a transport/auth/rate-limit failure that never completed a billed model call.

## Deviations from Plan

None - plan executed exactly as written. The `holistic-schema.test.ts` addition of a `describe("brfFieldTrusted...")` block and the `brf-lookup.test.ts` extract_failed test split matched the plan's explicit behavior table 1:1.

## Existing Test Assertions That Changed

- `brf-lookup.test.ts`'s single `'"extract_failed"'` test previously asserted `toEqual({ summary: null, costSek: 0, outcome: "extract_failed" })` for `CLAUDE_REFUSAL`. It now asserts `costSek === estimateBrfLookupSek()` for that code, and three new sibling tests cover `CLAUDE_PARSE_EMPTY` (1x), `CLAUDE_MAX_TOKENS` (2x), and `CLAUDE_CALL_FAILED` (0x, unchanged `toEqual`).
- `holistic-schema.test.ts`'s `brfSummarySchema` `valid` fixture gained a `fieldConfidence` object so its pre-existing `toEqual(valid)` round-trip assertion still holds against the now-required field.
- `job.test.ts`'s `makeBrfSummary` fixture and `confounder-guard.test.ts`'s `makeBrf` fixture both gained a trusted-default `fieldConfidence` (`{ skuldPerKvm: 0.9, avgiftsniva: 0.9, kassaflode: 0.8 }`) purely so the files type-check against the new required interface field — no other fixture values changed, and `confounder-guard.ts` itself was not touched (plan 14-10's scope per the plan's explicit instruction).

## BrfSummary Literals That Needed the New Field

Grep for `source: "allabrf"` across `src/` found exactly these non-declaration object literals, all now updated:

- `src/lib/discovery/brf-lookup.ts` (the real "ok"-path construction — task 2)
- `src/lib/discovery/holistic-schema.test.ts` (the round-trip fixture — task 1)
- `src/lib/discovery/job.test.ts`'s `makeBrfSummary` helper (task 3)
- `src/lib/discovery/confounder-guard.test.ts`'s `makeBrf` helper (task 3) — **plan 14-10 can rely on this default already being trusted** (`fieldConfidence: { skuldPerKvm: 0.9, avgiftsniva: 0.9, kassaflode: 0.8 }`, all above `OSAKER_THRESHOLD`).

`src/lib/discovery/candidate.test.ts`'s legacy fixture (lines 634-641) was deliberately left UNMODIFIED per the plan — it is the proof that a pre-existing persisted candidate without `fieldConfidence` still safeParses.

## Issues Encountered

None. `npx tsc --noEmit`, `npm run lint`, `npm run test` (887 passed, 3 skipped), and `npm run build` were all verified green after task 3, as required by the plan (task 1's acceptance criteria explicitly expects `tsc` to be dirty mid-plan until task 3 lands the remaining fixture fixes — confirmed by running the full check only after task 3).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 14-10 (wave 2) can now call `brfFieldTrusted` directly from both `normalizeForConfounders` and `buildBrfItem` to gate display and the debt-inclusive discount math — the DATA SPINE half of ANL-03/ANL-04 is closed.
- `confounder-guard.test.ts`'s `makeBrf` helper already defaults to a trusted `fieldConfidence`, so plan 14-10's new gating logic can be exercised against both the default-trusted case and explicit overrides without further fixture repair.
- The DEFERRED-LIVE operator gate (re-running the fixes against a real Allabrf-extracted document once Supabase is restored and the operator IP is unblocked) remains outstanding and does not block this plan or 14-10.

---
*Phase: 14-holistic-analysis-brain*
*Completed: 2026-08-08*
