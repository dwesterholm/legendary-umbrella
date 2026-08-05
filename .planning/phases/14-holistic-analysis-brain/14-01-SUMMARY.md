---
phase: 14-holistic-analysis-brain
plan: 01
subsystem: discovery
tags: [zod, typescript, discovery-candidate, booli-client, brf-source]

# Dependency graph
requires:
  - phase: 11-gallery-condition-vision
    provides: vision-schema.ts's read-guard discipline (nullable-tolerant Zod, no numeric constraints) — the exact template this plan's holistic-schema.ts read guards mirror
  - phase: 10-niche-ranking
    provides: DiscoveryCandidate's additive-nullable field precedent (constructionYear/brfName/tenureForm) — the exact template for this plan's four new fields
provides:
  - VISION_MODULE_SPECIFIERS extended with discovery/holistic-schema, discovery/confounder-guard, discovery/brf-lookup (LOCKED structural-separation guard, registered BEFORE any of those modules exist)
  - holistic-schema.ts — HolisticBrief/AreaCompsSummary/BrfSummary types + Zod read guards + HOLISTIC_DATA_ONLY_MARKER + tomtrattFromTenureForm
  - DiscoveryCandidate + discoveryCandidateSchema carry kommun/areaComps/brfSummary/holisticBrief (additive-nullable, no migration)
  - Single shared kommunFromBreadcrumbs exported from src/lib/booli/client.ts, wired into reshapeListingEntity, consumed by fetch-brf-auto.ts
affects: [14-02, 14-03, 14-04, 14-05, 14-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Additive-nullable persisted candidate field (.nullable().default(null), never bare .optional())"
    - "Read-path Zod guard for a code-composed (never Claude-facing) persisted shape"
    - "Structural-separation grep-list registration BEFORE the module that needs it exists"

key-files:
  created:
    - src/lib/discovery/holistic-schema.ts
    - src/lib/discovery/holistic-schema.test.ts
  modified:
    - src/lib/discovery/niche-score.test.ts
    - src/lib/discovery/candidate.ts
    - src/lib/discovery/candidate.test.ts
    - src/lib/booli/client.ts
    - src/lib/booli/client.test.ts
    - src/actions/fetch-brf-auto.ts
    - src/lib/discovery/job.test.ts
    - src/lib/discovery/vision.test.ts
    - src/components/discovery-results.test.tsx
    - src/components/discovery-candidate-card.test.tsx

key-decisions:
  - "tomtrattFromTenureForm never returns false — tenureForm cannot disprove tomträtt (the BRF, not the unit, holds it), so unknown stays null rather than a silently-wrong false"
  - "holisticBriefSchema restricts confidence to low|medium at the schema level — a stored 'high' (write-path bug, hand-edited row) fails safeParse rather than being trusted (D-14-04 mandatory downgrade)"
  - "kommunFromBreadcrumbs relocated to client.ts as the SINGLE shared implementation (was a private near-duplicate in fetch-brf-auto.ts) — takes unknown, mirroring brfNameFromBreadcrumbs's own signature, so both the discovery scrape path and the single-listing BRF path call the same function"

requirements-completed: [ANL-01, ANL-02, ANL-03]

# Metrics
duration: 45min
completed: 2026-08-05
---

# Phase 14 Plan 01: Holistic Analysis Brain Foundation Summary

**Registered three new Phase-14 modules in the LOCKED structural-separation grep list, built the `holistic-schema.ts` type/read-guard module (marker constant, tomträtt derivation, three aggregate types + Zod guards), added four additive-nullable `DiscoveryCandidate` fields (`kommun`/`areaComps`/`brfSummary`/`holisticBrief`), and de-duplicated `kommunFromBreadcrumbs` into a single shared, exported implementation wired into the scrape path.**

## Performance

- **Duration:** ~45 min
- **Completed:** 2026-08-05T18:45:00Z
- **Tasks:** 3
- **Files modified:** 12 (2 created, 10 modified)

## Accomplishments

- The structural-separation guard (`niche-score.test.ts`'s `VISION_MODULE_SPECIFIERS`) now names `discovery/holistic-schema`, `discovery/confounder-guard`, `discovery/brf-lookup` — registered BEFORE any of those modules exist, and proven LIVE (not inert) via an injected-import-then-revert check.
- `holistic-schema.ts` exists with `HOLISTIC_DATA_ONLY_MARKER`, `tomtrattFromTenureForm` (provably never returns `false`), `AreaCompsSummary`/`BrfSummary`/`HolisticBrief` types, and their three read-path Zod guards — all unit-tested (30 tests across the two files combined).
- `DiscoveryCandidate` and `discoveryCandidateSchema` carry `kommun`/`areaComps`/`brfSummary`/`holisticBrief`; a legacy row missing all four keys still `safeParse`s and normalizes them to `null` (never `undefined`), asserted with an explicit `Object.keys(...).toContain(...)` check.
- `kommun` is now derived at scrape time from the same `entry.breadcrumbs` value `brfName` already reads (zero extra network cost) — this unblocks ANL-03: `resolveOrgNr` can now reach `confidence: "high"` for a discovery candidate, which was previously unreachable behind a missing `kommun` field (D-14-09).
- Exactly one `kommunFromBreadcrumbs` implementation exists in the repo (`src/lib/booli/client.ts`, exported); the private near-duplicate in `fetch-brf-auto.ts` was deleted and that action now imports the shared function.

## Task Commits

Each task was committed atomically:

1. **Task 1: Register the three new module specifiers in VISION_MODULE_SPECIFIERS, then create holistic-schema.ts** - `de93a2b` (feat)
2. **Task 2: Add kommun / areaComps / brfSummary / holisticBrief to DiscoveryCandidate and discoveryCandidateSchema** - `40df0c4` (feat)
3. **Task 3: Derive kommun at scrape time from breadcrumbs and de-duplicate kommunFromBreadcrumbs** - `184953b` (feat)

_No TDD tasks in this plan — all three tasks are single feat commits (schema/module additions with same-commit tests, not separate RED/GREEN cycles)._

## Files Created/Modified

- `src/lib/discovery/holistic-schema.ts` - NEW: `HOLISTIC_DATA_ONLY_MARKER`, `TOMTRATT_TENURE_PATTERN`, `tomtrattFromTenureForm`, `AreaCompsSummary`/`areaCompsSummarySchema`, `BrfSummary`/`brfSummarySchema`, `HOLISTIC_BRIEF_ITEM_KINDS`, `HolisticBrief`/`holisticBriefSchema`
- `src/lib/discovery/holistic-schema.test.ts` - NEW: unit tests for the marker, tomträtt derivation, and all three read guards (round-trip + reject-wrong-type + reject-confidence-high)
- `src/lib/discovery/niche-score.test.ts` - `VISION_MODULE_SPECIFIERS` extended with the three Phase-14 module specifiers; `makeCandidate` factory gained the four new keys
- `src/lib/discovery/candidate.ts` - `DiscoveryCandidate` interface + `toCandidate` + `discoveryCandidateSchema` gain `kommun`/`areaComps`/`brfSummary`/`holisticBrief`; allowlist doc comment corrected from stale "SEVENTEEN" to accurate "TWENTY-FOUR"
- `src/lib/discovery/candidate.test.ts` - `ALLOWLIST_KEYS` extended; new Phase 14 `discoveryCandidateSchema` describe block (legacy-row-safeParse + new-row-round-trip); new `toCandidate` test for `kommun` mapping + always-null enforcement on the other three; every `DiscoveryCandidate`-typed literal updated
- `src/lib/booli/client.ts` - `kommunFromBreadcrumbs` exported (relocated/generalized from `fetch-brf-auto.ts`, now `unknown`-typed); wired into `reshapeListingEntity` alongside `brfName` on the same `entry.breadcrumbs` read
- `src/lib/booli/client.test.ts` - new `kommunFromBreadcrumbs` unit tests (genitive strip, case-insensitivity, non-array/malformed inputs, malformed-crumb skip) + a `reshapeListingEntity`/`toCandidate` integration test on the real fixture
- `src/actions/fetch-brf-auto.ts` - private `kommunFromBreadcrumbs` deleted; imports the shared `client.ts` implementation instead; unused `Breadcrumb` type import removed
- `src/lib/discovery/job.test.ts` - `makeCandidate` factory + the PII-safe-allowlist exact-key-set assertion + its paired `toEqual` object all gained the four new keys
- `src/lib/discovery/vision.test.ts`, `src/components/discovery-results.test.tsx`, `src/components/discovery-candidate-card.test.tsx` - `makeCandidate` factories gained the four new keys (flagged by `tsc --noEmit`, confirmed against output before editing)

## Decisions Made

- `tomtrattFromTenureForm` returns `true | null` only, never `false` — `tenureForm` structurally cannot disprove tomträtt (the BRF, not the unit, holds it); a `false` would silently assert "no tomträtt" on evidence that cannot support it.
- `holisticBriefSchema`'s `confidence` field is a bounded `z.enum(["low", "medium"])` — a persisted `"high"` value (write-path bug or hand-edited row) fails `safeParse` rather than being trusted, enforcing D-14-04's "a data-only brief can never claim high confidence" invariant at the read-guard level, not just at construction time.
- `kommunFromBreadcrumbs` was relocated (not duplicated) from a private `fetch-brf-auto.ts` helper to an exported `client.ts` function taking `unknown` (mirroring `brfNameFromBreadcrumbs`'s own signature) — both the discovery scrape path and the single-listing BRF auto-fetch path now call the exact same implementation, per the plan's "exactly ONE implementation in the repo" requirement.
- `areaComps`/`brfSummary`/`holisticBrief` are ALWAYS `null` at `toCandidate` time (verified by a dedicated test using stray raw keys with those names) — they are a later pass's output, exactly mirroring the existing `vision`/`visionSkippedReason` precedent.

## Deviations from Plan

None — plan executed exactly as written. All acceptance criteria in the plan were verified directly (see Verification below) rather than assumed.

## Issues Encountered

- The `holistic-schema.ts` file-level doc comment initially quoted the literal strings `.min()`/`.max()`/`.int()` when explaining the read-guard discipline, which tripped the plan's own numeric-constraint grep check (`grep -c 'min(\|max(\|\.int()'` returned 1 instead of the required 0). Reworded the comment to describe the discipline without using those literal substrings; the grep now returns 0 and the meaning is unchanged.

## Verification (from the plan's `<verification>` block)

- `npx vitest run src/lib/discovery/niche-score.test.ts src/lib/discovery/holistic-schema.test.ts src/lib/discovery/candidate.test.ts src/lib/booli/client.test.ts` — **110/110 passed**.
- `npx tsc --noEmit` — clean.
- `npm run lint` — clean.
- `npm run test` (full suite) — **769 passed | 3 skipped** (the 3 skips are pre-existing, unrelated to this plan).
- Injected-violation check: added `import { HOLISTIC_DATA_ONLY_MARKER } from "@/lib/discovery/holistic-schema";` to `niche-score.ts` and re-ran `npx vitest run src/lib/discovery/niche-score.test.ts` — the separation test **FAILED** with `AssertionError: expected true to be false` on `niche-score.ts does not import from vision-schema.ts, vision.ts, or sun-path.ts`, confirming the guard is live for the newly-registered specifier. The import was then reverted; the same test file re-ran green (30/30 in the combined run with `holistic-schema.test.ts`).
- `VISION_MODULE_SPECIFIERS` final contents (11 entries): `"discovery/vision-schema"`, `"discovery/vision\""`, `"discovery/vision'"`, `"discovery/sun-path"`, `"discovery/sun-path\""`, `"discovery/sun-path'"`, `"discovery/flip-economics"`, `"discovery/area-comps"`, `"discovery/holistic-schema"`, `"discovery/confounder-guard"`, `"discovery/brf-lookup"`.
- Test files whose `DiscoveryCandidate`-typed factories/literals needed the four new keys (confirmed against `tsc --noEmit` output, not guessed): `src/lib/discovery/candidate.test.ts` (4 literals + `ALLOWLIST_KEYS`), `src/lib/discovery/job.test.ts` (`makeCandidate` + the exact-key-set assertion + its `toEqual` object), `src/lib/discovery/vision.test.ts`, `src/lib/discovery/niche-score.test.ts`, `src/components/discovery-results.test.tsx`, `src/components/discovery-candidate-card.test.tsx`.
- Allowlist field count: the doc comment now correctly says "TWENTY-FOUR" (was stale at "SEVENTEEN" despite the interface already carrying 20 fields pre-Phase-14; Phase 14 brought the true count to 24 and the doc comment back into sync).

## Known Stubs

None — this plan introduces persisted-shape plumbing only (types, schemas, derivation); no UI renders these fields yet (that is Phase 15/16 per 14-CONTEXT.md's scope boundary), so there is no rendering surface that could show an empty/placeholder value.

## Threat Flags

None — every new persisted shape (`AreaCompsSummary`, `BrfSummary`, `HolisticBrief`) and the new `kommun` field are explicitly covered by this plan's own `<threat_model>` (T-14-01 through T-14-04), and no new network endpoint, auth path, or schema at a new trust boundary was introduced beyond what the threat model already disposes.

## User Setup Required

None - no external service configuration required. No DB migration (all four fields ride in the existing JSONB `results` column).

## Next Phase Readiness

- `holistic-schema.ts`'s types and read guards are ready for plan 14-02 (confounder guard) and later plans (BRF lookup, comps wiring, UI marker) to import and populate.
- `DiscoveryCandidate.kommun` is now populated at scrape time end-to-end (verified against the real Booli fixture), unblocking `resolveOrgNr`'s `confidence: "high"` path for discovery candidates in a later plan.
- No blockers. The Supabase project pause (noted in STATE.md/memory) does not affect this plan — no live DB work was performed or required.

## Self-Check: PASSED

All claimed files exist on disk (`src/lib/discovery/holistic-schema.ts`, `holistic-schema.test.ts`, `candidate.ts`, `candidate.test.ts`, `src/lib/booli/client.ts`, `client.test.ts`, `src/actions/fetch-brf-auto.ts`) and all three task commit hashes (`de93a2b`, `40df0c4`, `184953b`) are present in `git log`.

---
*Phase: 14-holistic-analysis-brain*
*Completed: 2026-08-05*
