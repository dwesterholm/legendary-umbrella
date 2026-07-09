---
phase: 05-owned-booli-acquisition
plan: 03
subsystem: api
tags: [apify-client, playwright, apollo-state, fallback-tree, vitest]

# Dependency graph
requires:
  - phase: 05-owned-booli-acquisition (Plan 01)
    provides: "Shared ApifyClient vi.mock factory pattern precedent (not directly used here — fallback-tree.test.ts needs no ApifyClient mock, but the module coexists with __mocks__/apify-client.ts for Plan 04)"
provides:
  - "runPlaywrightRender(url, pageFunction) — the one owned Apify actor-call core (src/lib/booli/transport.ts), reproducing sold-source.ts's proven config verbatim"
  - "APOLLO_PAGE_FUNCTION — the one shared __APOLLO_STATE__ extraction string (src/lib/booli/page-functions.ts), serving both detail and area-search reads"
  - "walkFallbackTree + FallbackResult<T> — ACQ-03 rung-iteration observability (src/lib/booli/fallback-tree.ts), throws on all-rungs-fail (HIGH-1)"
affects: [05-04-PLAN, 05-05-PLAN]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "transport.ts is now the ONLY module that instantiates ApifyClient for the owned transport — client.ts (Plan 04) calls through runPlaywrightRender, never re-instantiates"
    - "One shared page-function string differentiated only by startUrls, never by per-page-type variants"
    - "walkFallbackTree: rung index 0 = health 'ok', any fallback index = health 'degraded'; throws distinguishably when every rung is exhausted"
    - "Rung 2 = a second independent runPlaywrightRender() call site (fresh Apify container/proxy session), not a parameterized 'different proxy config' — documented in fallback-tree.ts doc comment per RESEARCH Pitfall 5"

key-files:
  created:
    - src/lib/booli/transport.ts
    - src/lib/booli/page-functions.ts
    - src/lib/booli/fallback-tree.ts
    - src/lib/booli/fallback-tree.test.ts
  modified: []

key-decisions:
  - "Rung-2 distinctness (RESEARCH Pitfall 5) is resolved at the fallback-tree.ts doc-comment level, not in code: walkFallbackTree is a generic rung-array walker with no opinion on what makes rung 2 different from rung 1 — that responsibility is documented as belonging to Plan 04's caller, which must construct rung 2 as a second independent runPlaywrightRender() invocation site rather than reusing the same exhausted attempt."

patterns-established:
  - "Pattern: fallback-tree.ts throw-on-total-failure mirrors sold-source.ts's per-source HIGH-1 discipline, but at the tree level — 'Alla Booli-kallor misslyckades: <lastError.message>' is the canonical all-rungs-fail message future callers should match against with a regex, not an exact string."

requirements-completed: [ACQ-03]

# Metrics
duration: 3min
completed: 2026-07-06
---

# Phase 5 Plan 3: Transport Core + Fallback-Tree Observability Summary

**Shared `runPlaywrightRender`/`APOLLO_PAGE_FUNCTION` transport substrate plus a tested `walkFallbackTree` that surfaces `{source, rung, health}` and throws (never silently empties) when every rung fails — the ACQ-03 observability layer Plan 04's `client.ts` composes on top of.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-07-06T15:29:35Z
- **Completed:** 2026-07-06T15:31:39Z
- **Tasks:** 2 completed
- **Files modified:** 4 (all new)

## Accomplishments
- `transport.ts` reproduces `sold-source.ts`'s proven `apify/playwright-scraper` actor-call config verbatim (`launcher: "chromium"`, RESIDENTIAL/SE proxy, `maxRequestRetries: 3`, `maxPagesPerCrawl: 1`, `waitSecs: 240`) behind a single `runPlaywrightRender(url, pageFunction)` entry point, carrying forward the HIGH-1 throw-not-empty discipline and the never-log-the-token error-logging pattern.
- `page-functions.ts` extracts the exact `__APOLLO_STATE__` read from `sold-source.ts` into one shared `APOLLO_PAGE_FUNCTION` string, documented as serving both detail-page and area-search reads without per-page-type variants.
- `fallback-tree.ts` implements `walkFallbackTree`/`FallbackResult<T>` per 05-RESEARCH.md Pattern 3 near-verbatim, with a doc comment explicitly recording the RESEARCH Pitfall 5 rung-2-distinctness rationale (a second independent Apify run/proxy session, not a duplicate of rung 1) so Plan 04's executor wires rungs correctly without re-deriving the reasoning.
- `fallback-tree.test.ts` follows the TDD RED→GREEN cycle: 5 tests covering rung-1 success (ok), rung-2 fallthrough (degraded), rung-3 fallthrough (degraded), all-rungs-fail throw (both multi-rung and single-rung cases), and per-rung `console.error("[booli-client] ...")` log assertions — all green, no `ApifyClient` mock needed (pure injected-fake rungs).

## Task Commits

Each task was committed atomically:

1. **Task 1: Transport core + shared page function** - `c3c2ab4` (feat)
2. **Task 2: Fallback-tree walker + tests (ACQ-03)** - `f6548a2` (test, RED) → `32c767a` (feat, GREEN)

**Plan metadata:** pending (this commit)

## TDD Gate Compliance

Task 2 carried `tdd="true"`. Gate sequence verified in git log:
- RED gate: `f6548a2` `test(05-03): add failing tests for walkFallbackTree (ACQ-03)` — confirmed failing (module-not-found) before any implementation existed.
- GREEN gate: `32c767a` `feat(05-03): implement walkFallbackTree (ACQ-03)` — all 5 tests pass immediately after.
- REFACTOR gate: not needed — no cleanup required after GREEN; skipped per the "only commit if changes" rule.

## Files Created/Modified
- `src/lib/booli/transport.ts` - `runPlaywrightRender(url, pageFunction)`, the one Apify actor-call core (RESIDENTIAL/SE proxy, `maxRequestRetries: 3`, `waitSecs: 240`); HIGH-1 throw-not-empty; error logging never leaks the token.
- `src/lib/booli/page-functions.ts` - `APOLLO_PAGE_FUNCTION`, the one shared `__APOLLO_STATE__` extraction string reused by detail-page and area-search reads.
- `src/lib/booli/fallback-tree.ts` - `walkFallbackTree`, `FallbackResult<T>` — ACQ-03 rung iteration with `source`/`rung`/`health` observability; throws `"Alla Booli-kallor misslyckades: ..."` when every rung fails.
- `src/lib/booli/fallback-tree.test.ts` - 5-test Vitest suite covering all four rung-outcome behaviors plus the HIGH-1 all-fail throw case, using injected `vi.fn()` fake rungs (no `ApifyClient` mock).

## Decisions Made
- Kept `walkFallbackTree` fully generic (no opinion on rung-2 construction) and pushed the RESEARCH Pitfall 5 rung-2-distinctness responsibility into a doc comment for Plan 04's caller to honor — this matches 05-RESEARCH.md's own recommendation that rung 1 and rung 2 share code but differ by invocation site, which is a caller-level (client.ts) concern, not something the tree walker itself can or should enforce structurally.

## Deviations from Plan

None — plan executed exactly as written. Both tasks matched their `<action>`/`<behavior>` specs verbatim, including the exact actor-config values, the exact `APOLLO_PAGE_FUNCTION` extraction body, and the exact `walkFallbackTree` discriminated-result shape.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required. No new packages installed (`apify-client` already a dependency, matching 05-RESEARCH.md's Package Legitimacy Audit finding of zero new packages this phase).

## Next Phase Readiness

Plan 04 (`client.ts` — `fetchListing`/`fetchAreaListings`/`fetchSoldComps`) can now import and wire:
- `runPlaywrightRender(url: string, pageFunction: string): Promise<unknown[]>` from `src/lib/booli/transport.ts`
- `APOLLO_PAGE_FUNCTION: string` from `src/lib/booli/page-functions.ts`
- `walkFallbackTree<T>(rungs: Array<{ source: FallbackResult<T>["source"]; attempt: () => Promise<T> }>): Promise<FallbackResult<T>>` and `FallbackResult<T>` (`{ data, source, rung, health }`) from `src/lib/booli/fallback-tree.ts`

Plan 04's executor should construct rung 1 and rung 2 as two separate `runPlaywrightRender()` invocation sites (per the rung-2-distinctness doc comment in `fallback-tree.ts`), and rung 3 as the existing `booli-scraper.ts` paid-actor logic. No blockers identified.

---
*Phase: 05-owned-booli-acquisition*
*Completed: 2026-07-06*

## Self-Check: PASSED

All claimed files exist on disk; all claimed commit hashes (`c3c2ab4`, `f6548a2`, `32c767a`) verified present in git log.
