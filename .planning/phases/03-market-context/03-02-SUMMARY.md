---
phase: 03-market-context
plan: 02
subsystem: database
tags: [supabase, postgres, migration, rls, jsonb, market-context]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: analyses table + per-user SELECT RLS (001_analyses.sql)
  - phase: 02-brf-financial-analysis
    provides: brf_* additive-column idiom + per-user UPDATE RLS (002_brf.sql) that the new columns inherit
provides:
  - "analyses.price_data jsonb (PRICE-01 sold comparison; carries reason discriminator ok|thin|source_unavailable|listing_pris_okand)"
  - "analyses.area_data jsonb (AREA-01 SCB demographics)"
  - "analyses.market_status text (null=never-enriched fetch affordance | fetching | done | failed)"
  - "analyses.market_source text (which sold-source produced price_data)"
  - "analyses.market_cost_sek numeric (per-analysis sold-source cost guard)"
  - "Live remote schema with the five columns applied (migration 003 in sync)"
affects: [03-04, 03-05, 03-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Additive add-column-if-not-exists migration under inherited RLS (no policy re-creation)"
    - "market_status state machine mirrors brf_status null=affordance semantics"
    - "price_data.reason discriminator separates dead-source degrade from thin-area, keeping status 'done'"

key-files:
  created:
    - supabase/migrations/003_market_context.sql
  modified: []

key-decisions:
  - "market_status null = never-enriched (page shows 'Hämta marknadsdata' affordance), mirroring brf_status null = upload affordance"
  - "Dead/unreachable sold source recorded as price_data.reason='source_unavailable' (runtime degrade), NOT a market_status value — status stays 'done' so the area panel can still render"
  - "No create policy: existing SELECT (001) + UPDATE (002) per-user RLS cover the new columns; a duplicate UPDATE policy would error and half-apply the push"

patterns-established:
  - "Pattern 1: Market-context columns are additive + idempotent, inheriting existing per-user RLS"
  - "Pattern 2: Runtime-degrade reasons live in price_data.reason, terminal lifecycle lives in market_status"

requirements-completed: [PRICE-01, AREA-01]

# Metrics
duration: 3min
completed: 2026-06-20
---

# Phase 3 Plan 02: Market-Context Persistence Layer Summary

**Five additive market-context columns (price_data/area_data jsonb + market_status/market_source/market_cost_sek) applied to the live analyses table under existing per-user RLS, with documented null/'done'/'failed' state semantics and a price_data.reason degrade discriminator.**

## Performance

- **Duration:** 3 min (finalize session; Task 1 + Task 2 push completed in prior session)
- **Started:** 2026-06-20T20:39:00Z
- **Completed:** 2026-06-20T20:42:00Z
- **Tasks:** 2 (Task 1 migration, Task 2 human-gated push)
- **Files modified:** 1

## Accomplishments
- Added `price_data`, `area_data`, `market_status`, `market_source`, `market_cost_sek` to `public.analyses` via idempotent `add column if not exists`.
- Documented the `market_status` state machine (null = never-enriched fetch affordance | 'fetching' | 'done' | 'failed') plus the `price_data.reason` discriminator (ok | thin | source_unavailable | listing_pris_okand) directly in the migration comment block.
- Applied the migration to the live remote project (bostad-ai, nsheegvczxjeeayngqrv): `supabase db push --include-all` succeeded and `supabase migration list` shows 001/002/003 with Local == Remote. No RLS error occurred — confirming Task 1 correctly omitted any duplicate UPDATE policy.

## Task Commits

Each task was committed atomically:

1. **Task 1: Write 003_market_context.sql** - `d869921` (feat)
2. **Task 2: Apply migration to live database (supabase db push)** - human-gated push, no code commit (live-DB mutation; verified via `supabase migration list`)

**Plan metadata:** this commit (docs: complete plan)

## Files Created/Modified
- `supabase/migrations/003_market_context.sql` - Five additive market-context columns on `analyses`, idempotent, documented status/reason semantics, NO new RLS policy.

## Decisions Made
- **market_status null semantics:** null = never enriched → page shows the "Hämta marknadsdata" fetch affordance, mirroring brf_status null = upload affordance (002_brf.sql). 'done' counts any partial success.
- **Degrade vs. lifecycle split:** a dead/unreachable sold source is `price_data.reason='source_unavailable'` (a runtime-degrade reason), NOT a separate market_status — so the area panel can still be 'done'. This is a degrade path, not the default state; the Booli SSR sold source is confirmed working (03-SPIKE.md).
- **No policy re-creation:** the new columns inherit the existing per-user SELECT (001) and UPDATE (002) RLS; re-declaring the UPDATE policy would error on a duplicate and half-apply the push (T-03-04 mitigation).

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None. The free-tier 7-day pause risk (STATE.md infra note, T-03-05) did not materialize — the project was awake, so no dashboard wake or CLI re-auth was needed before the push. The push and `supabase migration list` sync confirmation completed without prompts beyond the standard push approval.

## Threat Surface
- T-03-03 (info disclosure on new columns): mitigated — columns inherit `auth.uid() = user_id` SELECT/UPDATE RLS, no access broadening.
- T-03-04 (duplicate UPDATE policy): mitigated — no `create policy` in the migration; push landed with no RLS error.
- T-03-05 (paused free-tier project): accepted — project was awake, no wake step required.

No new threat surface beyond the plan's threat_model.

## User Setup Required
None - migration applied to the live database via the human-gated push (already completed).

## Next Phase Readiness
- The live `analyses` table now exposes `price_data`, `area_data`, `market_status`, `market_source`, `market_cost_sek` for Plan 05's server action to write and Plan 06's RSC page to read.
- Migration state is in sync (Local 001/002/003 == Remote). No blockers.

## Self-Check: PASSED

- FOUND: supabase/migrations/003_market_context.sql
- FOUND: .planning/phases/03-market-context/03-02-SUMMARY.md
- FOUND: commit d869921

---
*Phase: 03-market-context*
*Completed: 2026-06-20*
