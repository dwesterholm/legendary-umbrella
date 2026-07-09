---
phase: 07-macro-price-context
reviewed: 2026-07-06T00:00:00Z
depth: standard
files_reviewed: 12
files_reviewed_list:
  - src/lib/market/macro.ts
  - src/lib/market/macro-schema.ts
  - src/actions/enrich-market-context.ts
  - src/actions/generate-report.ts
  - src/lib/report/fact-sheet.ts
  - src/lib/report/prompt.ts
  - src/lib/report/banned-phrases.ts
  - src/components/macro-context-card.tsx
  - src/components/market-context-section.tsx
  - src/app/(app)/analysis/[id]/page.tsx
  - supabase/migrations/006_macro_snapshots.sql
  - supabase/migrations/007_macro_data_column.sql
findings:
  critical: 2
  warning: 4
  info: 2
  total: 8
status: issues_found
---

# Phase 7: Code Review Report

**Reviewed:** 2026-07-06
**Depth:** standard
**Files Reviewed:** 12
**Status:** issues_found

## Summary

Reviewed the MACRO-01/MACRO-02 macro price-context feature: the Riksbank/SCB
client (`macro.ts`), its schemas/normalizers (`macro-schema.ts`), the shared
`macro_snapshots` cache table + RLS (migration 006), the per-analysis
`macro_data` column (migration 007), the `enrich-market-context.ts` MACRO
branch, the fact-sheet/prompt/banned-phrase no-prediction enforcement, and the
UI (`macro-context-card.tsx`, `market-context-section.tsx`, `page.tsx`).

The no-prediction enforcement (schema shape + prompt ABSOLUT REGEL 5 +
`banned-predictive-phrases.test.ts`) is solid and well cross-checked. Independent
degradation for the macro branch (never gating `terminalStatus`, never blanking
price/area) is correctly implemented in `enrich-market-context.ts`. Fingerprint
parity between `generate-report.ts` and `page.tsx` for the new `macro` fact-sheet
field is byte-identical — no stale-report trap introduced here.

However, the shared-cache RLS policy has a real cache-poisoning gap (any
authenticated user can write arbitrary payloads that get served system-wide for
up to 24h, and the read path never re-validates the cached payload against the
schema), and the CPIF/regional-price normalizers have a "trailing value" bug
that will silently drop indicators for the exact preliminary-data scenario the
code explicitly anticipates. The read-through cache also does not honor its own
stated call-budget goal for the two national indicators.

## Critical Issues

### CR-01: Shared `macro_snapshots` cache accepts unvalidated payloads from any authenticated user (cache poisoning) and the read path never re-validates them

**File:** `supabase/migrations/006_macro_snapshots.sql:52-54`, `src/lib/market/macro.ts:262-263`

**Issue:** The UPDATE policy on the shared, non-owner-scoped `macro_snapshots`
table declares only a `USING` clause:

```sql
create policy "Authenticated users can update macro snapshots"
  on public.macro_snapshots for update
  using (auth.uid() is not null);
```

Per Postgres RLS semantics, when an UPDATE policy omits `WITH CHECK`, the
`USING` expression is reused as the check on the *new* row. Since
`auth.uid() is not null` does not reference `scope`, `region_code`, or
`payload` at all, there is effectively **no constraint on what any
authenticated user can write** to this table (the same gap exists on the
INSERT policy's `WITH CHECK`, migration 006 lines 46-48, which is equally
unconstrained on column values). Contrast with `002_brf.sql:21-23`, which sets
`with check (auth.uid() = user_id)` — an actual row-level constraint — for the
owner-scoped `analyses` table.

Compounding this, `readThroughMacroCache` (`macro.ts:262-264`) trusts the
cached row unconditionally:

```ts
if (isFresh) {
  return row.payload as T;
}
```

This is a bare type assertion with no `macroDataSchema.safeParse` (or any
runtime check) on read. Any authenticated user's browser session can issue
`supabase.from("macro_snapshots").upsert({ scope: "regional", region_code: "01",
payload: { policyRate: { value: 999, date: "...", source: "Riksbank" }, ... },
fetched_at: new Date().toISOString() }, { onConflict: "scope,region_code" })`
directly against PostgREST — RLS permits it, and the poisoned payload is then
served as-is to **every subsequent analysis for that region** for up to 24h
(`TTL_HOURS`), landing in `macro_data`, the `MacroContextCard` render, and the
LLM fact-sheet (`assembleFactSheet` → `synthesizeReport`) without any
validation gate in between. This is both a data-integrity issue (silent
cross-user cache poisoning) and an injection vector into LLM input and
rendered UI text — worse than a "shared read cache," since the write surface
is fully open to arbitrary JSON, not just the shape written by `fetchMacroSnapshot`.

**Fix:**
1. Add an explicit `WITH CHECK` on the UPDATE policy (and tighten INSERT) that
   at minimum restricts to the known `scope` enum and non-null structural
   invariants, e.g.:
   ```sql
   with check (
     auth.uid() is not null
     and scope in ('national', 'regional')
     and region_code ~ '^[A-Z0-9]{2,4}$'
   );
   ```
2. Re-validate the cached payload on every read before trusting it:
   ```ts
   if (isFresh) {
     const parsed = macroDataSchema.safeParse(row.payload);
     if (parsed.success) return parsed.data as T;
     // fall through to re-fetch live on a shape-drifted/poisoned row
   }
   ```
   (Note: `readThroughMacroCache<T>` is currently generic/untyped against
   `MacroData`; consider narrowing it to take the schema as a parameter so this
   check is enforced structurally rather than left to each caller.)

---

### CR-02: `normalizeInflation`/`normalizeRegionalPrice` take the last array element, which is `null` (and drops the whole indicator) exactly when SCB has not yet published the most recent period — the scenario the `preliminary` flag exists to handle

**File:** `src/lib/market/macro-schema.ts:99-112`, `src/lib/market/macro-schema.ts:143-158`

**Issue:** Both normalizers do:

```ts
const value = num(values[values.length - 1]);
if (value === null) return result;
```

SCB's json-stat2 `value` array is positionally aligned to the queried
dimensions (`size`) and pads a not-yet-published cell with `null` — this is
precisely the case the code's own `preliminary` flag (derived from SCB's
`note` array, e.g. "Most recent year's figures are preliminary") anticipates.
`fetchRegionalPriceTrend` explicitly queries `time: ["2024", "2025"]`
(macro.ts:231) so that a preliminary/unpublished 2025 cell can be detected —
but if SCB has not yet computed 2025 at all, `value[1]` is `null`, and `num(null)`
returns `null`, causing the function to `return result` (all-null) at line 147
**even though `value[0]` (2024) is a perfectly good, real median price**. The
same bug applies to `normalizeInflation` for the single queried period. The net
effect: the regional price / inflation indicator degrades to "Ej tillgänglig"
exactly when SCB is mid-publication-cycle for the latest period, instead of
correctly falling back to the latest *available* period as the `preliminary`
handling implies it should. No test in `macro-schema.test.ts` exercises a
`value` array with a trailing `null` — every fixture has both years populated
(`src/lib/market/__fixtures__/scb-bo0501c-lan.json`).

**Fix:** Walk backward from the end of the array to find the last non-null
value (and correspondingly index into the matching period/year), rather than
blindly taking the final index:

```ts
function lastNonNull(values: (number | null)[]): { value: number; index: number } | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = num(values[i]);
    if (v !== null) return { value: v, index: i };
  }
  return null;
}
// ...
const found = lastNonNull(values);
if (!found) return result;
const period = periods[found.index] ?? null;
```

## Warnings

### WR-01: The read-through cache re-fetches the two *national* indicators (policy rate, CPIF) once per distinct län instead of once system-wide, undermining the module's own stated call-budget goal

**File:** `src/lib/market/macro.ts:287-356`, `src/lib/market/macro.ts:19-28`

**Issue:** The module's own header comment states the shared cache "bounds
live calls to at most once per window system-wide, honoring the SCB
30-calls/10s budget." But `fetchMacroSnapshot` caches under key `scope:
"regional", region_code: lanCode` (or `"SE"` when no coords), and the entire
`fetchLive` closure — including `fetchPolicyRate()` (Riksbank, national) and
`fetchInflation()` (SCB CPIF, national — not län-scoped) — is re-run and
re-cached independently for every distinct `lanCode` that shows up. With up to
21 län codes + 5 storstad aggregates + the `"SE"` no-coords fallback, the two
national indicators can be live-fetched up to ~27x per TTL window instead of
once, contradicting the design intent documented in the module's own comment
and increasing (not eliminating) load on the Riksbank/SCB endpoints relative
to what the doc comment promises reviewers.

**Fix:** Split the cache into two independent read-throughs: one for the
`"national"` scope (policy rate + inflation, single row, key-independent of
region) and one for `"regional"` scope (regional price only, keyed by
`lanCode`). Merge the two results in `fetchMacroSnapshot`.

### WR-02: `postScbTable` and `fetchPolicyRate`'s `fetch()` calls have no timeout/`AbortSignal`, so a hanging Riksbank/SCB endpoint can stall the macro branch indefinitely

**File:** `src/lib/market/macro.ts:162-181`, `src/lib/market/macro.ts:187-202`

**Issue:** None of the three external `fetch()` calls in this file set a
timeout or pass an `AbortSignal`. A slow/hanging upstream response (Riksbank or
SCB) will hold the request open for as long as the platform's own outer
request timeout allows, rather than failing fast into the "independent
degradation" path the rest of the module is designed around. This is a
pre-existing pattern shared with `scb.ts` (not introduced fresh here), but this
PR is a good point to close it for the macro fetches given they run inside
`enrichMarketContext`'s `Promise.all`, which is awaited before the AREA branch
proceeds — a hang here delays (though does not block, since branches are
independent) the whole action's response.

**Fix:**
```ts
const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(8_000) });
```
applied to all three fetch call sites (`postScbTable`, `fetchPolicyRate`).

### WR-03: `isValidLanCode`'s `STORSTAD_AGGREGATES` branch is completely untested, and it is unverified whether SCB's `BO0501C` table's `Region` dimension actually accepts those 4-digit storstad codes

**File:** `src/lib/market/macro.ts:140-154`, `src/lib/market/macro.test.ts`

**Issue:** `LAN_CODES` (2-digit län codes) is exercised by the happy-path test
fixture; `STORSTAD_AGGREGATES` (`"00"`, `"0010"`, `"0020"`, `"0030"`, `"0060"`
— note the inconsistent code lengths, 2 vs 4 digits, within the same set) has
no test coverage at all. If any of these codes are not valid `Region` category
values for the `BO0501C/FastprisBRFRegionAr` table, `postScbTable` will either
400 (returns `null`, degrading silently to "Ej tillgänglig" — no crash, but a
silently-broken code path for whatever slice of users maps to a storstad
aggregate) or worse, return a shape that `jsonStat2Schema` happens to still
parse but with wrong/empty values. Given this is reachable in production for
any listing whose `kommunCode.slice(0,2)` happens to equal `"00"`, this
deserves at least one live-shaped fixture test per RESEARCH verification
practice already used elsewhere in this module (e.g., the KPIF contents-code
correction noted in `macro.ts:84-87`).

**Fix:** Add a fixture-backed test asserting a storstad aggregate code
round-trips correctly through `fetchRegionalPriceTrend`, or (if unverified)
downgrade the aggregate set to a documented "unverified, needs live spot-check"
TODO with a tracking issue, consistent with how `macro.ts:84-87` documents its
own verified/corrected contents code.

### WR-04: `normalizeRegionalPrice` reads `note` off the unvalidated `raw` argument instead of the `safeParse`d `stat`, which is fragile and inconsistent with the rest of the function

**File:** `src/lib/market/macro-schema.ts:153`

**Issue:**
```ts
const parsed = jsonStat2Schema.safeParse(raw);
if (!parsed.success) return result;
const stat = parsed.data;
// ... uses `stat` throughout ...
const notes = (raw as { note?: unknown }).note;
```
`jsonStat2Schema` is defined with `.passthrough()` (`scb-schema.ts:33-41`), so
`stat.note` would carry the exact same value as `raw.note` post-parse — there
is no functional reason to reach back into `raw`. Reading from `raw` bypasses
the schema boundary this file otherwise takes pains to enforce (the file's own
header comment states "every normalizer `safeParse`s first"), and is a latent
foot-gun: if `jsonStat2Schema` is ever tightened to `.strict()` or `note` is
promoted to a declared (and differently-typed) field, this line will silently
diverge from the validated shape without any test catching it, since no
current test supplies a mismatched `raw`/`parsed.data` pair.

**Fix:**
```ts
const notes = (stat as { note?: unknown }).note;
```

## Info

### IN-01: `fetchInflation` queries a hardcoded literal period `"2026M05"` that will silently go stale

**File:** `src/lib/market/macro.ts:208-215`

**Issue:**
```ts
export async function fetchInflation() {
  const body = buildPxWebQuery({
    contentsCode: [MACRO_SCB_TABLES.inflation.contentsCode],
    time: ["2026M05"],
  });
```
The queried time period is a hardcoded string tied to the current month at
implementation time. Once SCB publishes June 2026 (and every month after),
this query will keep asking for the May 2026 figure specifically, which SCB
may eventually stop serving in the "latest" sense (or may still serve, just
increasingly stale) — the CPIF figure will silently fall further and further
behind without any error, since a valid-but-old response still parses
successfully. There's no visible mechanism (env var, computed month, or a
"latest N periods" query pattern) to keep this current. Contrast with
`fetchRegionalPriceTrend`, whose `time: ["2024", "2025"]` window will at least
naturally roll forward once 2026 data appears (assuming CR-02's trailing-null
fix), but even that window is hardcoded and will need a manual bump for 2026.

**Fix:** Query a relative/rolling window instead of a pinned literal, e.g. ask
PxWebApi for the last N periods via its `"top"` selection value
(`{ filter: "top", values: ["1"] }` for `Tid`) rather than an absolute period
string, so the query self-updates without code changes.

### IN-02: `MAX_SOURCE_CALLS = 3` renders-per-tier accounting comment in `walkSoldTiers`'s failure branch assumes exactly 2 renders per failed tier, but this is a magic number duplicated from another module's internal fallback-tree depth

**File:** `src/actions/enrich-market-context.ts:216-224`

**Issue:** Not new to this phase's diff directly (pre-existing from Phase 5),
but touched by this review's scope: the `catch` block hardcodes `renders += 2`
with a comment explaining it mirrors `fetchSoldComps`'s internal fallback-tree
depth (own-playwright + own-playwright-retry). This couples
`enrich-market-context.ts`'s cost accounting to an implementation detail of
`sold-source.ts` via a magic number rather than a shared/exported constant. If
`sold-source.ts`'s fallback tree depth ever changes (e.g., a rung is added, per
the recent `73c7448` commit message "fail loudly on a 4th+ walkFallbackTree
rung"), this `2` will silently under/over-report cost without any compiler or
test signal tying the two together.

**Fix:** Export the fallback-tree depth (or a `MAX_RENDERS_PER_TIER` constant)
from `sold-source.ts` and import it here instead of the bare literal `2`, so a
future change to the fallback depth is a compile-visible one-file edit.

---

_Reviewed: 2026-07-06_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
