---
phase: 07-macro-price-context
plan: 01
subsystem: api
tags: [zod, supabase, riksbank, scb, pxwebapi, macro-data, cache]

# Dependency graph
requires:
  - phase: 03-area-demographics
    provides: scb-schema.ts's jsonStat2Schema + normalizer discipline, scb.ts's whitelisted-table SSRF pattern
provides:
  - macro_snapshots shared cache table (live, RLS-protected)
  - macro-schema.ts (MacroData type, macroDataSchema, safeParseMacroData, normalizers)
  - macro.ts (fetchMacroSnapshot read-through cache, fetchPolicyRate/fetchInflation/fetchRegionalPriceTrend, buildPxWebQuery)
affects: [07-02-enrich-branch, 07-03-macro-card]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Shared non-owner-scoped Supabase table with explicit any-authenticated-user RLS (first in project — Assumption A4)"
    - "Read-through TTL cache against a dedicated cache table (distinct from scb.ts's persisted-column-as-cache pattern)"
    - "buildPxWebQuery thin abstraction for future SCB v1→v2 migration insurance"
    - "Schema-shape no-prediction enforcement (mirrors reportSchema's no-verdict discipline)"

key-files:
  created:
    - supabase/migrations/006_macro_snapshots.sql
    - src/lib/market/macro-schema.ts
    - src/lib/market/macro-schema.test.ts
    - src/lib/market/macro.ts
    - src/lib/market/macro.test.ts
    - src/lib/market/__fixtures__/riksbank-policy-rate.json
    - src/lib/market/__fixtures__/scb-cpif.json
    - src/lib/market/__fixtures__/scb-bo0501c-lan.json
  modified: []

key-decisions:
  - "macro_snapshots uses an explicit 'any authenticated user' RLS policy (SELECT+INSERT+UPDATE on auth.uid() is not null) since the table has no user_id and there is no service-role client in this codebase (RESEARCH Assumption A4)"
  - "CPIF (not plain CPI) is the persisted 'inflation' figure — matches the Riksbank's own policy target measure (RESEARCH Pitfall 3)"
  - "Single conservative 24h TTL for all three indicators (RESEARCH Open Q2 resolution) rather than per-indicator TTLs"
  - "Regional scope keyed by the 21 län codes (not the 4 storstad aggregates) — natural match for kommunCode.slice(0,2) (RESEARCH Open Q3 resolution)"

patterns-established:
  - "readThroughMacroCache: select-by-key + freshness check + upsert-on-miss/stale, generic over payload type"
  - "Each of the three macro indicators wrapped in its own try/catch inside fetchMacroSnapshot's Promise.all so one source failure never blanks the others"

requirements-completed: [MACRO-01, MACRO-02]

# Metrics
duration: 25min
completed: 2026-07-06
---

# Phase 7 Plan 1: Macro Data Layer Summary

**Shared `macro_snapshots` Supabase cache (live, RLS-protected) + Zod schemas/normalizers for Riksbank policy rate, SCB CPIF inflation, and län-level regional BRF price, with a read-through 24h TTL cache and structural no-prediction enforcement.**

## Performance

- **Duration:** 25 min
- **Started:** 2026-07-06T21:53:00Z
- **Completed:** 2026-07-06T22:18:00Z
- **Tasks:** 3 (Task 2 and 3 each ran as RED→GREEN TDD pairs)
- **Files modified:** 8 (3 new source files, 2 new test files, 3 new fixtures, 1 new migration)

## Accomplishments
- `006_macro_snapshots.sql` pushed live via `supabase db push --linked`, confirmed applied (`supabase migration list` shows local 006 = remote 006)
- Three independent Riksbank/SCB normalizers (`normalizePolicyRate`, `normalizeInflation`, `normalizeRegionalPrice`) that never throw and each degrade to null independently
- `macroDataSchema` structurally excludes any direction/trend/magnitude/forecast/outlook/deltaPct field — proven by an automated schema-shape test (MACRO-02)
- `fetchMacroSnapshot` read-through cache: fresh hit skips fetch entirely; miss/stale fetches live + upserts with `onConflict: "scope,region_code"`; each of the three indicators independently degrades to null on its own source's failure without blanking the other two
- `isValidLanCode` allowlist (21 län codes + 5 storstad aggregates) gates every region code before it reaches an SCB query body — proven by a test asserting the regional-price fetch is never even called for an invalid code

## Task Commits

1. **Task 1: macro_snapshots migration + [BLOCKING] schema push** - `9525273` (feat)
2. **Task 2 RED: failing normalizer/schema-shape test** - `6fb05c3` (test)
2. **Task 2 GREEN: macro-schema.ts implementation** - `4498b26` (feat)
3. **Task 3 RED: failing cache/degradation test** - `48f9e88` (test)
3. **Task 3 GREEN: macro.ts implementation** - `65ae22c` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified
- `supabase/migrations/006_macro_snapshots.sql` - New shared cache table + 3 explicit RLS policies (SELECT/INSERT/UPDATE on `auth.uid() is not null`)
- `src/lib/market/macro-schema.ts` - `normalizePolicyRate`/`normalizeInflation`/`normalizeRegionalPrice`, `macroDataSchema`, `MacroData`, `safeParseMacroData`
- `src/lib/market/macro-schema.test.ts` - normalize + schema-shape (MACRO-02) test blocks
- `src/lib/market/macro.ts` - `fetchPolicyRate`/`fetchInflation`/`fetchRegionalPriceTrend`, `buildPxWebQuery`, `readThroughMacroCache`, `fetchMacroSnapshot`
- `src/lib/market/macro.test.ts` - cache hit/miss/stale + independent-degradation + SSRF allowlist tests (mocked Supabase + mocked fetch)
- `src/lib/market/__fixtures__/riksbank-policy-rate.json` - Riksbank flat `{date,value}` fixture (RESEARCH verified-live shape)
- `src/lib/market/__fixtures__/scb-cpif.json` - json-stat2 CPIF annual-change fixture
- `src/lib/market/__fixtures__/scb-bo0501c-lan.json` - json-stat2 län-level regional price fixture, including the SCB "preliminary" note

## Decisions Made
- Live schema push succeeded non-interactively: `supabase db push --linked < /dev/null` defaulted the `[Y/n]` prompt to Y on closed stdin and applied migration 006. Verified via `supabase migration list --linked` (local 006 = remote 006). No operator deferral was needed.
- `SupabaseLike` is a minimal structural interface (not the concrete `@supabase/supabase-js` type) so `macro.ts` has no new import dependency and the test's chainable fake satisfies it via a `never` cast, mirroring the project's existing lightweight-mock convention (`generate-report.test.ts`).
- CPIF contentsCode hardcoded as `"PR0101G1"` (fixture-consistent placeholder per RESEARCH's documented table structure — RESEARCH did not capture the literal ContentsCode value for CPIF the way it did for CPI's `"00000804""`; this should be spot-checked against a live SCB call before Plan 02 wires the real enrich branch, since a wrong code would 400 rather than silently misreport, and the null-on-failure discipline means this fails safe either way).

## Deviations from Plan

None — plan executed exactly as written. The `supabase db push` step succeeded live (not deferred to operator); the plan's contingency for operator-gating was not needed.

## Issues Encountered
- Local shell has no `timeout` binary (`command not found: timeout`); worked around by backgrounding the `supabase db push` process and polling/killing after a bounded sleep, per the "bounded, non-blocking" instruction in the task brief.
- `.planning/STATE.md` had a small pre-existing uncommitted diff (8 lines) from the init-time `state.load` step, unrelated to this plan's file list — left untouched and staged only the plan's own files in each task commit, per the individual-file-staging rule.

## User Setup Required

None - no external service configuration required. The migration is already live; no `SUPABASE_ACCESS_TOKEN`/`SUPABASE_DB_PASSWORD` env vars were needed because the CLI was already authenticated/linked in this environment.

## Next Phase Readiness

Plan 02 can now wire the 4th independent `enrichMarketContext` branch: derive `lanCode = geo.kommunCode ? geo.kommunCode.slice(0,2) : null`, call `fetchMacroSnapshot(supabase, lanCode)`, and persist the result onto `analyses.macro_data` (new column, not yet added — Plan 02's responsibility) alongside `price_data`/`area_data`. Plan 03 can read `MacroData`/`safeParseMacroData` for the card and fact-sheet slot.

One item worth a quick live spot-check before Plan 02 ships: the CPIF `ContentsCode` value (`PR0101G1`) was inferred from the table's structure, not captured verbatim from a live curl in 07-RESEARCH.md (which only verified the CPI table's `00000804` code explicitly). If wrong, `fetchInflation` fails safe (HTTP 400 → null, per the never-throw discipline) but will silently under-report inflation as "ej tillgänglig" until corrected.

---
*Phase: 07-macro-price-context*
*Completed: 2026-07-06*

## Self-Check: PASSED

All 8 created files verified present on disk; all 5 task commits + the SUMMARY commit verified present in git log.
