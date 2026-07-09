---
phase: 09-discovery-foundation
fixed_at: 2026-07-07T12:10:00Z
review_path: .planning/phases/09-discovery-foundation/09-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 6
skipped: 0
status: all_fixed
---

# Phase 9: Code Review Fix Report

**Fixed at:** 2026-07-07T12:10:00Z
**Source review:** .planning/phases/09-discovery-foundation/09-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 6 (3 Critical + 3 Warning; IN-01/IN-02 explicitly out of scope this pass)
- Fixed: 6
- Skipped: 0

## Fixed Issues

### CR-01: `claim_discovery_slice` RPC has no ownership check

**Files modified:** `supabase/migrations/011_claim_slice_ownership.sql` (new), `src/lib/discovery/job.integration.test.ts`
**Commit:** `59fea01`
**Applied fix:** Added a new migration (010 is already applied/pushed and was never edited in place) that `CREATE OR REPLACE`s `claim_discovery_slice` to require `auth.uid() = user_id OR auth.role() = 'service_role'` inside the claimable CTE, so only the owning user or the trusted cron-sweep service-role path can claim a slice. Grants re-stated (`authenticated`, `service_role`). Pushed live via `supabase db push --linked` and verified via `supabase migration list --linked` (Local=Remote=011 confirmed). Added a live-DB-gated (`RUN_DB_INTEGRATION=1`) integration test that signs in as a second, non-owner authenticated user via the anon key and proves a direct RPC claim against another user's job returns zero rows and leaves the victim job unmutated (still `pending`, `claimed_at` null).

### CR-02: `/api/discovery/sweep` has no authentication/authorization

**Files modified:** `src/app/api/discovery/sweep/route.ts`, `src/lib/supabase/service-role.ts` (new), `src/app/api/discovery/sweep/route.test.ts` (new)
**Commit:** `65a0585`
**Applied fix:** Added `src/lib/supabase/service-role.ts` (a service-role-key client, used ONLY by this one route). The route now checks `Authorization: Bearer ${CRON_SECRET}` as the literal first action — a missing/wrong header, or an unset `CRON_SECRET`, returns 401 before the service-role client is even constructed. Documented that `CRON_SECRET` + `SUPABASE_SERVICE_ROLE_KEY` must both be set in the deployment environment for the sweep to function (operator env setup, not enabled by this change). New `route.test.ts` proves: missing header → 401 + zero DB calls; wrong secret → 401 + zero DB calls; unset `CRON_SECRET` → 401 + zero DB calls; correct secret → proceeds via the service-role client and reclaims stuck jobs.

### CR-03: Area dropdown selection silently discarded

**Files modified:** `src/actions/start-discovery.ts`, `src/actions/start-discovery.test.ts`
**Commit:** `e1f92b4`
**Applied fix:** `startDiscovery` now reads `formData.get("areaQuery")` and, when present and non-empty, overrides the Haiku-parsed `areaQuery` — inserted alongside the other override blocks, before `objectType`, consistent with existing merge order and the "explicit user filters win" contract. Added tests proving the explicit dropdown pick wins over the Haiku-inferred area, and that the Haiku-inferred area is still used when no override is present.

### WR-01: Per-day job cap TOCTOU (non-atomic count-then-insert)

**Files modified:** `supabase/migrations/011_claim_slice_ownership.sql` (shared with CR-01; DB half shipped in that commit), `src/actions/start-discovery.ts`, `src/actions/start-discovery.test.ts`
**Commit:** `3c144a0` (app-layer wiring; the `insert_discovery_job_if_under_cap` RPC itself was added to migration 011 and pushed live as part of CR-01's commit `59fea01`, since both are additive/replace-function-only changes to the same new migration file)
**Applied fix:** Replaced the plain `SELECT count(*)` + separate `INSERT` with a single call to a new `insert_discovery_job_if_under_cap` RPC that serializes concurrent callers for the SAME user via `pg_advisory_xact_lock(hashtext(auth.uid()::text))` and performs the count + conditional insert inside one function invocation. The owner is always derived from `auth.uid()` server-side inside the function, never from a caller-supplied value. Updated `start-discovery.test.ts`'s Supabase mock to assert against the RPC call shape; all prior coverage (flag-first, auth gate, cap-exceeded, low-confidence, empty free_text) preserved and passing.

### WR-02: `objectType` override bypasses the Zod enum via unchecked assertion

**Files modified:** `src/actions/start-discovery.ts`, `src/actions/start-discovery.test.ts`
**Commit:** `25cd6ab`
**Applied fix:** Replaced the bare `as DiscoveryFilter["objectType"]` assertion with `intentFilterSchema.shape.objectType.safeParse(...)` — reuses the existing Zod enum as the single source of truth. An invalid override is silently ignored (falls back to the Haiku-parsed value) rather than persisting an out-of-enum string. Added tests proving an invalid override is ignored and a valid override is accepted.

### WR-03: `DiscoveryProgress` polling has no overlap guard

**Files modified:** `src/components/discovery-progress.tsx`, `src/components/discovery-progress.test.tsx`
**Commit:** `c7527a8`
**Applied fix:** Added an `inFlight` boolean flag inside the `useEffect` closure; `poll()` returns immediately if a prior call is still in flight, and releases the flag in a `finally` block so a thrown error cannot leave polling permanently stuck. Added a test that makes the first `tickDiscovery` call slower than `POLL_MS` and asserts a second interval firing during that window does not trigger an overlapping call, then confirms the guard releases once the first call resolves.

## Skipped Issues

None — all 6 in-scope findings were fixed.

---

_Fixed: 2026-07-07T12:10:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
