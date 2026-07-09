---
phase: 09-discovery-foundation
plan: 01
subsystem: database
tags: [supabase, postgres, plpgsql, zod, row-level-security, atomic-claim, discovery]

# Dependency graph
requires:
  - phase: 08-brf-auto-fetch
    provides: additive-nullable migration convention, brf_status bare-text-column-no-check-constraint pattern
provides:
  - discovery_jobs table (live, pushed) with owner-only RLS and running-total counters
  - claim_discovery_slice atomic RPC (FOR UPDATE SKIP LOCKED, SECURITY DEFINER)
  - slim intentFilterSchema + DiscoveryFilter type + hard-cap constants
  - discoveryCostSek incremental cost function
  - PII-safe DiscoveryCandidate allowlist shape + toCandidate mapper + filterCandidates deterministic filter
affects: [09-discovery-foundation Plan 02/03/04, 10-niche-ranking]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "FOR UPDATE SKIP LOCKED CTE + UPDATE...RETURNING inside a SECURITY DEFINER plpgsql function for race-free job-queue claims (first RPC in this codebase; PostgREST's query builder cannot express this)"
    - "Slim Claude-facing Zod schema discipline (only optional numeric fields nullable, no .min()/.max()/.int() chains) applied to a second schema beyond brf/extract.ts"
    - "PII-safe persisted shape via explicit allowlist object-literal construction (never ...raw spread), proven with an exact-key test"

key-files:
  created:
    - supabase/migrations/010_discovery_jobs.sql
    - src/lib/discovery/filter-schema.ts
    - src/lib/discovery/filter-schema.test.ts
    - src/lib/discovery/cost.ts
    - src/lib/discovery/cost.test.ts
    - src/lib/discovery/candidate.ts
    - src/lib/discovery/candidate.test.ts
  modified: []

key-decisions:
  - "CAP_CANDIDATES_MAX = 25 (mid-point of the locked 20-30 band)"
  - "CAP_SEK_MAX = 5 (per-search SEK ceiling; RESEARCH cost math lands under 1 SEK/search in the typical case)"
  - "CAP_IMAGES_PER_LISTING = 0 declared now as a Phase 9 no-op contract placeholder; real vision image fetch is Phase 11"
  - "discovery_jobs RLS includes an owner-only UPDATE policy (unlike 001_analyses.sql's select+insert-only shape) because the client-tick path updates running counters under the user's own session; claim_discovery_slice itself runs SECURITY DEFINER and bypasses RLS for the atomic claim"
  - "status is a bare text column with no check constraint, mirroring the brf_status convention from migration 009 so new status words never require DDL"

patterns-established:
  - "Atomic slice-claim RPC pattern for any future job-queue table needing race-free claim-one-of-N semantics"
  - "discoveryCostSek as the template for composing a Haiku parse cost with a per-render scrape cost across any future incremental-cost discovery mechanism"

requirements-completed: [DISC-01, DISC-02, DISC-07]

# Metrics
duration: 25min
completed: 2026-07-07
---

# Phase 9 Plan 1: Discovery Foundation — Data + Contract Layer Summary

**Live `discovery_jobs` table + a real `FOR UPDATE SKIP LOCKED` atomic claim RPC, plus the slim Zod filter schema, incremental cost function, and PII-safe candidate allowlist that Plans 03/04 build against.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-07-07T09:06Z (approx.)
- **Completed:** 2026-07-07T09:12Z
- **Tasks:** 3 completed
- **Files modified:** 7 (1 migration + 6 new TS files)

## Accomplishments

- `discovery_jobs` table + `claim_discovery_slice` RPC written, pushed live via `supabase db push --linked`, and verified against `information_schema` (table + routine each return exactly one row) — the genuinely-new atomic-claim mechanism this phase required.
- Slim Claude-facing `intentFilterSchema` (no `.min()/.max()/.int()` chains, only optional numerics nullable) + hard-cap constants (`CAP_CANDIDATES_MAX`, `CAP_SEK_MAX`, `CAP_IMAGES_PER_LISTING`) implemented and unit-tested.
- `discoveryCostSek` composing the existing `costSek` (Haiku) precedent with a per-render SEK term, mirroring `soldSourceCostSek`.
- `DiscoveryCandidate` PII-safe allowlist + `toCandidate` (no-spread, exact-key-tested) + `filterCandidates` (deterministic AND, null-clause-skip, cap truncation + true scanned count).

## Task Commits

Each task was committed atomically:

1. **Task 1: Migration 010 — discovery_jobs table + claim_discovery_slice RPC + push** - `3830452` (feat)
2. **Task 2: Structured filter schema + hard-cap constants + cost function** - `86fff7f` (test, RED) → `bb2b630` (feat, GREEN)
3. **Task 3: PII-safe candidate shape + toCandidate mapper + deterministic filter** - `62a17c0` (test, RED) → `2ba5357` (feat, GREEN)

**Plan metadata:** (this commit)

_Note: Tasks 2 and 3 are `tdd="true"` — each has a RED test commit followed by a GREEN implementation commit; no REFACTOR commit was needed for either._

## Files Created/Modified

- `supabase/migrations/010_discovery_jobs.sql` - `discovery_jobs` table (owner-only RLS incl. UPDATE, cap columns, running-total counters, `cap_reached` flag) + `claim_discovery_slice(p_job_id, p_stale_ms)` SECURITY DEFINER RPC using `FOR UPDATE SKIP LOCKED`; pushed live.
- `src/lib/discovery/filter-schema.ts` - `intentFilterSchema`, `DiscoveryFilter` type, `CAP_CANDIDATES_MAX`/`CAP_SEK_MAX`/`CAP_IMAGES_PER_LISTING`.
- `src/lib/discovery/filter-schema.test.ts` - parse/reject/cap-bound tests.
- `src/lib/discovery/cost.ts` - `discoveryCostSek`, `DISCOVERY_COST_CAP_SEK`, `USD_PER_RENDER`.
- `src/lib/discovery/cost.test.ts` - decomposition + zero-usage + scaling tests.
- `src/lib/discovery/candidate.ts` - `DiscoveryCandidate` interface, `toCandidate`, `filterCandidates`.
- `src/lib/discovery/candidate.test.ts` - exact-key PII test, field-mapping test, null-tolerance test, AND-filter test, cap-truncation test.

## Decisions Made

See `key-decisions` in frontmatter. All within plan scope; no architectural deviations.

## Deviations from Plan

None - plan executed exactly as written. The migration push succeeded on the first non-interactive `supabase db push --linked` invocation (no operator-gated halt needed).

## Issues Encountered

- `supabase db execute --sql` does not exist in the installed CLI (v2.105.0); the correct subcommand is `supabase db query --linked "<sql>"`. Used that instead to run the two `information_schema` verification queries — both returned exactly one row as required. No plan or code impact, purely a verification-tooling correction.

## User Setup Required

None - no external service configuration required. The Supabase CLI was already linked (migrations 006-009 precedent) and the push completed non-interactively.

## Next Phase Readiness

- `discovery_jobs` + `claim_discovery_slice` are live and verified — Plan 03 (`tick-discovery.ts`/`job.ts`) can call the RPC directly.
- `filter-schema.ts`, `cost.ts`, `candidate.ts` are fully typed and tested — Plan 02 (`parse-intent.ts`/`resolve-area.ts`) and Plan 04 (UI) can import `DiscoveryFilter`, `discoveryCostSek`, `DiscoveryCandidate`/`toCandidate`/`filterCandidates` directly.
- No blockers. The Phase 9 legal go/no-go gate and the Vercel Cron/free-text-reliability spike (STATE.md Blockers) remain separate, unaffected prerequisites for later plans in this phase.

---
*Phase: 09-discovery-foundation*
*Completed: 2026-07-07*

## Self-Check: PASSED

All 7 created files verified present on disk; all 5 task commit hashes (3830452, 86fff7f, bb2b630, 62a17c0, 2ba5357) verified present in git log.
