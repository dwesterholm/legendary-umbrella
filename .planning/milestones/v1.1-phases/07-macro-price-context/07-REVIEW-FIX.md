---
phase: 07-macro-price-context
fixed_at: 2026-07-06T22:37:00Z
review_path: .planning/phases/07-macro-price-context/07-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 6
skipped: 0
status: all_fixed
---

# Phase 7: Code Review Fix Report

**Fixed at:** 2026-07-06
**Source review:** .planning/phases/07-macro-price-context/07-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 6 (Critical: 2, Warning: 4 — Info findings IN-01/IN-02 explicitly excluded per fix scope)
- Fixed: 6
- Skipped: 0

## Fixed Issues

### CR-01: Shared `macro_snapshots` cache accepts unvalidated payloads from any authenticated user (cache poisoning) and the read path never re-validates them

**Files modified:** `src/lib/market/macro.ts`, `src/lib/market/macro.test.ts`, `src/lib/market/macro-schema.ts`, `supabase/migrations/008_macro_snapshots_write_check.sql`
**Commits:** `aba0683` (read-side re-validation), `9d6ec14` (write-side RLS tightening)
**Applied fix:**
- Read-side (mandatory): `readThroughMacroCache<T>` is now generic over a required `ZodType<T>` schema parameter. Two new per-scope schemas (`nationalMacroPayloadSchema`, `regionalMacroPayloadSchema`, derived via `macroDataSchema.pick(...)`) are passed at each of the two call sites. Every cached row is `safeParse`d before being trusted; a parse failure is logged and treated as a cache MISS, falling through to a live re-fetch. A poisoned or shape-drifted row can never reach the fact-sheet or UI. Added two regression tests: one with an arbitrary-string poisoned `policyRate` payload, one with a wrong-shape payload missing required keys — both prove the poisoned/malformed data is discarded and the correct live values are returned instead.
- Write-side (defense-in-depth): migration 006 is already applied/pushed, so per project convention (never edit a pushed migration) a new migration `008_macro_snapshots_write_check.sql` was added. It `drop`s and re-`create`s the INSERT and UPDATE policies on `macro_snapshots` with a real structural `WITH CHECK` (`scope in ('national','regional')`, a well-formed `region_code` pattern, `payload is not null`) instead of the original's unconstrained `auth.uid() is not null`. This migration was pushed non-interactively via `supabase db push --linked` and verified live against `pg_policies` on the linked remote project (`nsheegvczxjeeayngqrv` / bostad-ai) — both policies confirmed carrying the tightened `WITH CHECK` in production.

### CR-02: `normalizeInflation`/`normalizeRegionalPrice` take the last array element, which is `null`, and drop the whole indicator when SCB has not yet published the most recent period

**Files modified:** `src/lib/market/macro-schema.ts`, `src/lib/market/macro-schema.test.ts`
**Commit:** `5a84a80`
**Applied fix:** Added a `lastNonNull` helper that walks backward from the end of the json-stat2 `value` array to find the last non-null cell, returning both the value and its index. Both normalizers now use this instead of blindly indexing `values[values.length - 1]`, and look up the matching period/year label at the SAME index rather than always taking the last label. Added trailing-null fixture regression tests for both `normalizeInflation` and `normalizeRegionalPrice` proving the real prior-period value is recovered instead of the indicator degrading to all-null.

### WR-01: The read-through cache re-fetches the two national indicators (policy rate, CPIF) once per distinct län instead of once system-wide

**Files modified:** `src/lib/market/macro.ts`, `src/lib/market/macro.test.ts`
**Commit:** `ec20d2d`
**Applied fix:** Split the single `regional`-scoped read-through cache into `readThroughNationalCache` (policy rate + inflation, single system-wide key `"SE"`, independent of region) and `readThroughRegionalCache` (regional price only, keyed by `lanCode`). `fetchMacroSnapshot` now runs both in parallel and merges the results; each scope still degrades independently (a national-cache failure never blanks the regional price, and vice versa). Added two regression tests: one proving the Riksbank/CPIF live fetchers run exactly once across two `fetchMacroSnapshot` calls with two different län codes (with separate regional cache rows persisted per län), and one proving independent degradation across the new scope split.

### WR-02: `postScbTable` and `fetchPolicyRate`'s `fetch()` calls have no timeout/`AbortSignal`

**Files modified:** `src/lib/market/macro.ts`
**Commit:** `271db6c`
**Applied fix:** Added a shared `FETCH_TIMEOUT_MS = 8_000` constant and passed `signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)` to both the `postScbTable` fetch call (covers both the CPIF and regional-price SCB queries) and the `fetchPolicyRate` Riksbank fetch call. Both are already wrapped in try/catch, so an `AbortError`/`TimeoutError` degrades that indicator to null exactly like any other fetch failure — no new failure path was introduced.

### WR-03: `isValidLanCode`'s `STORSTAD_AGGREGATES` branch is untested and unverified

**Files modified:** `src/lib/market/macro.ts`
**Commit:** `fb8c86f`
**Applied fix:** Removed the `STORSTAD_AGGREGATES` set and its branch from `isValidLanCode` entirely, per RESEARCH's already-resolved Q3 decision (län-only, full 21-code geographic coverage, no storstad aggregates). `LAN_CODES` is now the single allowlist. Confirmed no other file in the codebase referenced `STORSTAD_AGGREGATES`.

### WR-04: `normalizeRegionalPrice` reads `note` off the unvalidated `raw` argument instead of the `safeParse`d `stat`

**Files modified:** `src/lib/market/macro-schema.ts`, `src/lib/market/macro-schema.test.ts`
**Commit:** `21c67f1`
**Applied fix:** Changed `(raw as { note?: unknown }).note` to `(stat as { note?: unknown }).note`, keeping the function entirely inside the schema boundary the rest of the file enforces. While making this change, also added a guard so the `preliminary` flag only applies when the recovered value is actually the latest queried period — relevant because CR-02's fix (landed first) can now fall back to an older, already-final period, which must not inherit the "preliminary" caveat meant for the not-yet-published latest period. Added a regression test confirming `note` detection still works correctly when reading from the parsed `stat`.

## Skipped Issues

None — all 6 in-scope findings (CR-01, CR-02, WR-01, WR-02, WR-03, WR-04) were fixed. IN-01 and IN-02 were explicitly excluded from this fix pass per the stated scope and were not touched.

---

_Fixed: 2026-07-06_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
