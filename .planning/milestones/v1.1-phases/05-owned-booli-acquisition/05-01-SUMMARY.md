---
phase: 05-owned-booli-acquisition
plan: 01
subsystem: testing
tags: [vitest, apify-client, zod, mocking, regression-test]

# Dependency graph
requires:
  - phase: 03-market-context
    provides: "sold-source.ts's proven ApifyClient .actor().call()/.dataset().listItems() chain and its throw-not-empty (HIGH-1) discipline — the shape this plan's mock models"
provides:
  - "Shared vi-mockable ApifyClient factory (actorCall/listItems spies + resetApifyMock) for every future booli/ test"
  - "Direct regression-test proof that normalizeScraperOutput/scraperOutputSchema already tolerate both the paid-actor-flat shape and the detail-page Apollo-entity shape (listPrice-as-{raw}, numeric booliId)"
affects: [05-02-PLAN, 05-03-PLAN, 05-04-PLAN, 05-05-PLAN]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Canonical apify-client vi.mock factory under src/lib/booli/__mocks__/ — future Apify-backed tests import actorCall/listItems/resetApifyMock/apifyClientMockFactory instead of hand-rolling a fake"
    - "Plain describe/it/expect regression-guard test style (no mocks) for schema/normalizer modules, mirroring sold-source.test.ts"

key-files:
  created:
    - src/lib/booli/__mocks__/apify-client.ts
    - src/lib/schemas/listing.test.ts
  modified: []

key-decisions:
  - "listPrice (not price) is the correct key for the { raw } detail-page-shaped variant in the no-op-migration test — normalizeScraperOutput's actual fallback is num(raw.price) ?? rawOf(raw.listPrice), it does not accept price itself as a { raw } object. Fixture built to match the real coercion contract rather than the plan prose's slightly ambiguous phrasing."

patterns-established:
  - "Pattern 1: apify-client mock factory — src/lib/booli/__mocks__/apify-client.ts is the single canonical vi.mock(\"apify-client\", factory) shape for this phase; do not let client.test.ts or fallback-tree.test.ts invent their own."

requirements-completed: [ACQ-01, ACQ-02, ACQ-03]

# Metrics
duration: 12min
completed: 2026-07-06
---

# Phase 5 Plan 1: Wave 0 Test Infrastructure Summary

**Shared `ApifyClient` vi.mock factory plus a `listing.test.ts` regression guard that proves `normalizeScraperOutput` already tolerates both the paid-actor and detail-page-Apollo payload shapes — zero production code touched.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-07-06T13:46:30Z
- **Completed:** 2026-07-06T13:49:18Z
- **Tasks:** 2 completed
- **Files modified:** 2 (both new)

## Accomplishments
- Built the one canonical `ApifyClient` mock shape (`actorCall`, `listItems`, `resetApifyMock`, `apifyClientMockFactory`) that every downstream `booli/` test in this phase (`client.test.ts`, `fallback-tree.test.ts`) will import, preventing three independent hand-rolled fakes from drifting apart.
- Added `src/lib/schemas/listing.test.ts` — the first direct unit test `normalizeScraperOutput`/`scraperOutputSchema` have ever had — and used it to concretely prove the phase's central "no-op migration" claim: the SAME logical listing, once shaped like the flat paid-actor payload and once shaped like a detail-page Apollo entity (`listPrice` as `{ raw }`, numeric `booliId`), normalizes to an identical `NormalizedListing`.
- Confirmed (via the regression test) that the existing coercion helpers already handle the detail-page shape correctly for `price`/`booliId` under the real fallback contract (`num(raw.price) ?? rawOf(raw.listPrice)`, `idStr()`) — no changes needed to `listing.ts`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Shared ApifyClient mock factory** - `bd5b12e` (test)
2. **Task 2: listing.ts no-op-migration regression guard** - `94eaf2c` (test)

**Plan metadata:** pending (this commit)

_Note: Task 2 carries `tdd="true"`; see TDD Gate Compliance below — this task's expected/documented outcome is "green immediately" (no RED phase), not a standard RED→GREEN cycle, because `listing.ts` is read-only this phase and the plan explicitly anticipated an immediate pass._

## Files Created/Modified
- `src/lib/booli/__mocks__/apify-client.ts` - Shared `vi.mock("apify-client", ...)` factory: `actorCall`/`listItems` spies modeling `.actor().call()`/`.dataset().listItems()`, plus `resetApifyMock()` for `beforeEach`. Test-support only; never reads `process.env`, never imported by non-test code.
- `src/lib/schemas/listing.test.ts` - 8-test regression suite for `normalizeScraperOutput`/`scraperOutputSchema`: exact-field mapping for the actor-flat shape, identical-output proof for the detail-page shape, the concrete `listPrice`-object-vs-bare-`price` equivalence assertion, numeric-vs-string `booliId` equivalence, `.passthrough()` tolerance, and null-safe handling of sparse/empty payloads.

## Decisions Made
- **Fixture shape for the "detail-page" variant:** Built the detail-page-shaped fixture using `listPrice: { raw: N }` rather than `price: { raw: N }`. Read `normalizeScraperOutput`'s actual implementation first (`price: num(raw.price) ?? rawOf(raw.listPrice)`) and confirmed the code only accepts a `{ raw }` object under the `listPrice` key, never under `price` itself — a bare `price: { raw: N }` normalizes to `null` (verified by the initial RED run before the fixture was corrected). The plan's own acceptance criteria phrasing ("a `{ raw }`-shaped `price`/`listPrice`") supports this reading. This keeps the test asserting a TRUE claim about existing code rather than a claim the code doesn't actually make, and required no change to `listing.ts` (which stays read-only this phase as directed).

## Deviations from Plan

None — plan executed exactly as written. The one wrinkle (documented above under Decisions Made) was resolving genuine ambiguity in the plan's prose in favor of the literal, verified behavior of `normalizeScraperOutput`, not a deviation from any instruction — the plan explicitly named `listing.ts` as read-only and instructed asserting real coercion behavior, which is what the corrected fixture does.

## TDD Gate Compliance

Task 2 (`tdd="true"`) did not follow a strict RED→GREEN commit-pair sequence. During interactive drafting (before the task commit), an initial fixture using `price: { raw: N }` correctly produced a failing assertion (`expected null to be 4200000`) — confirming the coercion helpers do NOT accept that specific shape under the `price` key. This was not a "test passes when it shouldn't" fail-fast trip; it was a true RED caused by an incorrect fixture assumption, corrected before committing (per the plan's explicit instruction that `listing.ts` stays read-only — the fix was in the test's fixture, not the source). The single committed test-only commit (`94eaf2c`) is a `test(...)` commit with all 8 assertions green; no corresponding `feat(...)` commit exists because no production code changed, which matches the plan's stated goal ("no production code changes") rather than violating the standard RED/GREEN/REFACTOR cycle.

## Issues Encountered
None beyond the fixture-shape correction described above, resolved before commit.

## User Setup Required

None - no external service configuration required. No new packages installed (per plan's threat_model T-05-SC — zero new installs this plan).

## Next Phase Readiness
- `src/lib/booli/__mocks__/apify-client.ts` is ready for import by 05-02/05-03's `client.test.ts` and `fallback-tree.test.ts` (per 05-VALIDATION.md's Wave 0 Requirements — this closes that gap).
- `src/lib/schemas/listing.test.ts` gives the rest of this phase a fast, mock-free regression guard: any future change to `client.ts`'s raw-payload shape can be sanity-checked against this suite before wiring `normalizeScraperOutput` into the new fetch path.
- No blockers. This plan's wave-sibling (05-02) is a human checkpoint deferred per the orchestrator's sequential-mode contract; STATE.md/ROADMAP.md are updated here since 05-01 runs alone this wave.

---
*Phase: 05-owned-booli-acquisition*
*Completed: 2026-07-06*

## Self-Check: PASSED

- FOUND: src/lib/booli/__mocks__/apify-client.ts
- FOUND: src/lib/schemas/listing.test.ts
- FOUND: 05-01-SUMMARY.md
- FOUND: bd5b12e (test: shared ApifyClient mock factory)
- FOUND: 94eaf2c (test: listing.ts no-op-migration regression guard)
- FOUND: a01c0bd (docs: plan summary)
