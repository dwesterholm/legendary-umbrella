---
phase: 09-discovery-foundation
plan: 03
subsystem: discovery
tags: [anthropic-haiku, server-actions, postgres-rpc, feature-flag, discovery]

# Dependency graph
requires:
  - phase: 09-discovery-foundation
    provides: "Plan 01's discovery_jobs table + claim_discovery_slice RPC + filter-schema/cost/candidate contracts; Plan 02's resolveArea probe-then-seed resolver"
provides:
  - "parseIntent(freeText) -> Haiku free-text-to-filter parse, user-message-only, low-confidence fail-safe"
  - "runSlice(supabase, claimedRow) -> the bounded-slice orchestrator: incremental cap gate, area resolve, cost pre-check, kill switch, PII-safe persist"
  - "startDiscovery(formData) -> the flag-first, auth-gated, per-day-capped Server Action that creates a pending discovery_jobs row"
  - "tickDiscovery(jobId) -> the atomic-claim Server Action that advances exactly one bounded slice per client poll"
affects: ["09-discovery-foundation Plan 04 (UI)", "10-niche-ranking"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Client-tick-drives-the-queue: each client poll round-trip both reads job status AND invokes a Server Action (tickDiscovery) that claims-and-executes one bounded slice — genuinely new composition, no prior codebase precedent (BrfProgress only reads state)"
    - "Feature-flag-as-literal-first-line fail-closed discipline (process.env.DISCOVERY_ENABLED !== 'true' before auth/parse/insert) — a direct curl/devtools call fails closed even with the UI hidden"
    - "Incremental per-slice cap gating (candidate count + SEK cost checked BEFORE each scrape, from the claim RPC's RETURNING row, never a fresh SELECT) as a generalizable discipline beyond the existing job-completion-only cost caps"

key-files:
  created:
    - src/lib/discovery/parse-intent.ts
    - src/lib/discovery/parse-intent.test.ts
    - src/lib/discovery/job.ts
    - src/lib/discovery/job.test.ts
    - src/lib/discovery/job.integration.test.ts
    - src/actions/start-discovery.ts
    - src/actions/start-discovery.test.ts
    - src/actions/tick-discovery.ts
    - src/actions/tick-discovery.test.ts
  modified: []

key-decisions:
  - "JOBS_PER_DAY_CAP = 5 (new constant, not locked by prior plans) — bounds the OTHER dimension of the cost-DoS surface (rapid job creation), complementing the per-slice incremental caps already locked in Plan 01"
  - "DiscoveryJobsWriter type derived from Awaited<ReturnType<typeof createClient>> (mirrors generate-report.ts's StatusWriter precedent) rather than a hand-rolled minimal interface — the real Supabase PostgrestFilterBuilder is thenable, not a plain Promise, so an overly-strict hand-rolled type failed tsc against the production client while still passing against a naive mock"
  - "job.integration.test.ts uses a service-role Supabase client (bypasses RLS) deliberately — it proves the RPC's OWN FOR UPDATE SKIP LOCKED atomicity guarantee, not the RLS policy layer, which is a separate, already-covered concern (Plan 01's RLS policies)"
  - "runSlice's per-slice cost pre-check uses a conservative single-render SEK estimate (ignores the already-spent Haiku parse cost, which is comparatively tiny and already reflected in cost_sek_total) rather than a more precise but unknowable-in-advance token estimate"

patterns-established:
  - "Incremental-cap-before-spend as the template for any future job-queue slice that accrues cost across multiple ticks (10-niche-ranking will need the same discipline if it adds per-slice vision/scoring spend)"
  - "Ownership pre-check + atomic RPC claim as the template for any future tick-driven queue advancement action"

requirements-completed: [DISC-01, DISC-02, DISC-07]

# Metrics
duration: 35min
completed: 2026-07-07
---

# Phase 9 Plan 3: Discovery Backend — parseIntent, runSlice, startDiscovery, tickDiscovery Summary

**The full bounded-background-job backend: a Haiku free-text-to-filter parser sent user-message-only, a slice orchestrator enforcing incremental candidate/SEK caps plus a kill switch plus PII-safe persistence, and two Server Actions (startDiscovery flag-first/auth/per-day-cap, tickDiscovery atomic-claim) — every locked Phase 9 constraint lands and is unit-tested, plus an env-gated RPC concurrency integration test.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-07-07T11:20Z (approx.)
- **Completed:** 2026-07-07T11:28Z (approx.)
- **Tasks:** 3 completed
- **Files modified:** 9 (all new)

## Accomplishments

- `parseIntent` implemented as an exact mirror of `extract.ts`'s Haiku call shape: free text sent as `messages:[{role:"user",content:freeText}]` only (never concatenated into `system` — proven by inspecting mocked call args against an injected "IGNORE ALL PRIOR INSTRUCTIONS" payload), confidence < 0.6 fails safe to `needsConfirmation` without throwing, and call failures log only a stable code (never the free text).
- `startDiscovery` implemented with the `DISCOVERY_ENABLED` flag check as the literal first executable line — proven by a test asserting the Anthropic/Supabase mocks are never invoked when the flag is off/unset — followed by auth, a new per-user-per-day job cap (`JOBS_PER_DAY_CAP = 5`, using safe `.gte()` timestamp comparison, not the `.eq(col,null)` NULL-filter trap), the Haiku parse, and a zeroed-counter `discovery_jobs` insert.
- `runSlice` implemented as the claim-row-driven orchestrator: the incremental cap gate and cost pre-check both run BEFORE any scrape (proven by tests asserting `fetchAreaListings` is never called in those branches); a `fetchAreaListings` throw (the owned client's CAPTCHA/blocking kill-switch signal) flips the job to `degraded` and halts; all counters are computed exclusively from the claimed row (a test's mock `select()` throws if `runSlice` ever re-reads the job, proving Pitfall 4 compliance); persisted results are the exact PII-safe `toCandidate` allowlist shape (asserted via exact key-set equality).
- `tickDiscovery` implemented with `export const maxDuration = 300`, an auth gate, an IDOR ownership pre-check before the claim, and the REAL `claim_discovery_slice` RPC call (`.rpc(...).maybeSingle()`) — never a reimplemented PostgREST check-then-act. Empty claim result is a benign no-op; an RPC error fails closed (no scrape).
- `job.integration.test.ts` added as an env-gated (`RUN_DB_INTEGRATION=1` + `SUPABASE_SERVICE_ROLE_KEY`) proof of the RPC's `FOR UPDATE SKIP LOCKED` single-winner guarantee under real concurrency, plus fresh-lock-not-reclaimable and stale-lock-reclaimable assertions — mirrors the `RUN_LLM_EVALS=1` self-skip pattern so the default suite is unaffected (confirmed: it self-skips as exactly one skipped test).

## Task Commits

Each task was committed atomically:

1. **Task 1: parseIntent + startDiscovery** — `d0a3d1f` (test, RED) → `38ffbac` (feat, GREEN)
2. **Task 2: runSlice + tickDiscovery** — `f42db92` (test, RED) → `a86cee9` (feat, GREEN)
3. **Task 3: RPC concurrency integration test** — `c9741f7` (test, env-gated, self-skipping)

_Tasks 1 and 2 are `tdd="true"` — each has a RED test commit followed by a GREEN implementation commit; no REFACTOR commit was needed for either (the type-fix for `DiscoveryJobsWriter` was folded into Task 2's GREEN commit since it was required to make that commit's own new code type-check, not a separate cleanup pass)._

## Files Created/Modified

- `src/lib/discovery/parse-intent.ts` - `parseIntent(freeText)`: module-scope `Anthropic` client + `MODEL="claude-haiku-4-5-20251001"`, `INTENT_PARSE_SYSTEM_PROMPT` (steering-only, no user text), `messages.parse` + `zodOutputFormat(intentFilterSchema)`, confidence-threshold fail-safe, coded-error logging.
- `src/lib/discovery/parse-intent.test.ts` - happy path, low-confidence branch, user-message-only assertion against an injection payload, model-id/output-format assertion, coded-error logging assertion.
- `src/lib/discovery/job.ts` - `runSlice(supabase, claimedRow)`: incremental cap gate → `resolveArea` → cost pre-check → `fetchAreaListings` kill-switch try/catch → `toCandidate`/`filterCandidates` → single PII-safe persisting UPDATE; exports `DiscoveryJobsWriter`/`ClaimedDiscoveryJob` types.
- `src/lib/discovery/job.test.ts` - cap-gate (candidate + cost + pre-check) no-scrape tests, happy-path scrape+persist with exact-key PII assertion, cap-reached transition, area-resolve failure, kill-switch degrade test (mock `select()` throws to prove no re-SELECT).
- `src/lib/discovery/job.integration.test.ts` - env-gated (`RUN_DB_INTEGRATION=1`) two-concurrent-claims / fresh-not-reclaimable / stale-reclaimable tests against a live local Supabase via a service-role `@supabase/supabase-js` client.
- `src/actions/start-discovery.ts` - `startDiscovery(formData)`: `DISCOVERY_ENABLED` flag-first guard → free-text validation → auth → per-day cap (`JOBS_PER_DAY_CAP=5`) → `parseIntent` → merge explicit FormData overrides → insert.
- `src/actions/start-discovery.test.ts` - flag-off short-circuit (both unset and `"false"`), auth gate, per-day-cap refusal, needsConfirmation branch (no insert), happy-path insert with payload assertions, empty-free-text refusal.
- `src/actions/tick-discovery.ts` - `tickDiscovery(jobId)`: `maxDuration=300`, auth, IDOR ownership pre-check, `claim_discovery_slice` RPC call, `runSlice` invocation.
- `src/actions/tick-discovery.test.ts` - `maxDuration` assertion, empty-RPC no-op, RPC-error fail-closed, happy-path claim→runSlice, auth gate, IDOR ownership guard.

## Decisions Made

See `key-decisions` in frontmatter. The most consequential: `JOBS_PER_DAY_CAP` is a new constant this plan introduces (not pre-locked by Plan 01/02) to close the rapid-job-creation dimension of the cost-DoS threat (T-09-09) that the per-slice incremental caps alone don't address.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `DiscoveryJobsWriter` type too strict against the real Supabase client**
- **Found during:** Task 2, first `tsc --noEmit` pass after implementing `job.ts`/`tick-discovery.ts`.
- **Issue:** The initial hand-rolled `DiscoveryJobsWriter` interface typed `.update().eq()` as returning a plain `Promise<{error}>`, but the real Supabase `PostgrestFilterBuilder` is a thenable builder object (has `.then()` but also chainable methods), not a plain Promise — `tsc` rejected passing the real production client into `runSlice`.
- **Fix:** Changed `DiscoveryJobsWriter` to `Awaited<ReturnType<typeof createClient>>`, mirroring `generate-report.ts`'s existing `StatusWriter` type precedent exactly. The `updateJob` helper's `await` usage was already compatible with a thenable, so no logic changed.
- **Files modified:** `src/lib/discovery/job.ts`.
- **Commit:** `a86cee9` (folded into Task 2's GREEN commit, since the type error blocked that commit's own code from compiling).

**2. [Rule 1 - Bug] Test fixture typed as `string` instead of the `DiscoveryFilter` literal union**
- **Found during:** Task 2, same `tsc` pass.
- **Issue:** `job.test.ts`'s `claimedRow()` helper's inline object literal inferred `objectType: string`, which doesn't satisfy `DiscoveryFilter["objectType"]`'s `"Lägenhet" | "Villa" | "Radhus" | "Alla"` union — a type-checking bug in the test file itself, not a logic bug in the tested code.
- **Fix:** Typed `claimedRow`'s parameter and return as `Partial<ClaimedDiscoveryJob>`/`ClaimedDiscoveryJob` (imported from `job.ts`) so the literal narrows correctly.
- **Files modified:** `src/lib/discovery/job.test.ts`.
- **Commit:** `a86cee9`.

No architectural deviations (Rule 4) — the plan's specified order, RPC-based claim, and PII-safe persistence shape were all implemented exactly as written.

## Issues Encountered

- Local Docker/Supabase was not running during this execution (`supabase status` failed with "Cannot connect to the Docker daemon"), so `job.integration.test.ts`'s live-database assertions could not be executed end-to-end in this session — only its self-skip path was verified (confirmed: exactly one skipped test, zero DB connection attempted, zero cost). This is expected and by design per the plan's Task 3 acceptance criteria ("self-skips when `RUN_DB_INTEGRATION` is unset"); running it live against a real `supabase start` instance remains a manual verification step for `/gsd-verify-work` per the plan's own instruction.
- There is no standalone `src/lib/brf/extract.test.ts` in the current codebase (the extraction test coverage now lives in `run-extraction.test.ts`, post Phase 8 refactor) — `parse-intent.test.ts` mocks `@anthropic-ai/sdk` directly instead, since that is the closest available live mocking precedent and achieves the same assertion goals (call-arg inspection, model id, output format).

## User Setup Required

**To run the Task 3 integration test locally** (optional — not required for `npm run test` / CI, which self-skip cleanly):
1. `supabase start` (requires Docker running).
2. Note the printed `service_role` key (or `supabase status`).
3. `RUN_DB_INTEGRATION=1 SUPABASE_SERVICE_ROLE_KEY=<key> npx vitest run src/lib/discovery/job.integration.test.ts`.

**To enable the discovery feature at all** (unrelated to this plan's tests, but required before `startDiscovery` will ever succeed in any environment): set `DISCOVERY_ENABLED=true` as a server-only env var (never `NEXT_PUBLIC_`). It remains OFF by default in every environment until explicitly set — this is the intended legal go/no-go gate `STATE.md` tracks separately.

## Known Stubs

None. `parseIntent`, `runSlice`, `startDiscovery`, and `tickDiscovery` are all fully implemented, real code paths against the live `discovery_jobs` table / `claim_discovery_slice` RPC / Haiku API / owned Booli client — nothing returns hardcoded empty/placeholder data.

## Threat Flags

None. All six threat-register rows this plan owns (T-09-07 prompt injection, T-09-08 flag bypass, T-09-09 cost DoS, T-09-10 kill-switch DoS, T-09-06 IDOR, T-09-05 PII) are implemented exactly as specified in the plan's threat model, each with a corresponding test assertion — no new surface introduced beyond what was already flagged.

## Next Phase Readiness

- `parseIntent`, `runSlice`, `startDiscovery`, `tickDiscovery` are fully wired, unit-tested, and verified against `tsc`/`eslint` — Plan 04 (UI) can call `startDiscovery`/`tickDiscovery` directly from client components without any further contract changes.
- The feature remains OFF by default (`DISCOVERY_ENABLED` unset in every environment) until the separate legal go/no-go gate is cleared — this plan's flag-first discipline guarantees the backend cannot be reached even if the UI ships ahead of that gate.
- The RPC concurrency integration test is implemented and self-skips cleanly; running it live against a local Supabase (Docker required) remains a recommended manual verification step before `/gsd-verify-work` signs off on Phase 9, but does not block Plan 04.
- No other blockers. Plan 02's Stockholm-region-only seed-list limitation (documented in `09-02-SUMMARY.md`) still applies transitively — `runSlice`'s `resolveArea` call will return `failed` status for any area outside the 3-entry seed list until the live probe is confirmed; Plan 04's UI copy should account for this.

---
*Phase: 09-discovery-foundation*
*Completed: 2026-07-07*

## Self-Check: PASSED

All 9 created source/test files + SUMMARY.md + deferred-items.md verified present on disk; all 5 task commit hashes (d0a3d1f, 38ffbac, f42db92, a86cee9, c9741f7) verified present in git log.
