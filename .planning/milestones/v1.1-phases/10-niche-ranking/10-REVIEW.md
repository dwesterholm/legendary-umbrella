---
phase: 10-niche-ranking
reviewed: 2026-07-07T00:00:00Z
depth: standard
files_reviewed: 7
files_reviewed_list:
  - src/lib/discovery/candidate.ts
  - src/lib/discovery/niches.ts
  - src/lib/discovery/niche-score.ts
  - src/components/discovery-niche-selector.tsx
  - src/components/discovery-candidate-card.tsx
  - src/components/discovery-results.tsx
  - src/app/(app)/discover/[jobId]/page.tsx
findings:
  critical: 1
  warning: 2
  info: 1
  total: 4
status: issues_found
---

# Phase 10: Code Review Report

**Reviewed:** 2026-07-07T00:00:00Z
**Depth:** standard
**Files Reviewed:** 7
**Status:** issues_found

## Summary

Reviewed the niche-ranking scorer (`niche-score.ts`/`niches.ts`), the extended PII-safe candidate allowlist (`candidate.ts`), and the client-side reorder UI (`discovery-results.tsx`, `discovery-candidate-card.tsx`, `discovery-niche-selector.tsx`, `page.tsx`).

`computeNicheScore` is genuinely pure (no I/O/clock/randomness), all thresholds are centralized in `NICHE_WEIGHTS`, and the not-assessable discipline (`=== null` → `assessable:false`, `contribution:0`) is applied consistently and is well covered by `niche-score.test.ts` (determinism, cross-niche distinguishability, hedged-proxy key discipline). `candidate.ts`'s `toCandidate` mapper remains a no-spread, explicit-allowlist object literal — the three Phase 10 additions (`constructionYear`, `brfName`, `tenureForm`) do not widen the PII surface. `discovery-candidate-card.tsx` never renders the raw `[0,1]` score; only cited chips and the `#N` rank badge, confirmed by an explicit test. `discovery-results.tsx`'s degenerate-count and scorer-throw paths both fall back to original order with a banner and never crash, confirmed by tests. `page.tsx`'s diff against the pre-Phase-10 version is isolated to exactly the `done + candidates.length > 0` branch — auth/empty/failed/degraded branches are byte-for-byte unchanged.

However, the backward-compatibility path this phase specifically relies on — a pre-Phase-10 `discovery_jobs.results` row that lacks the three new keys entirely, which `discoveryCandidateSchema`'s `.nullable().optional()` fields were added to accept — is not actually safe end-to-end. A row missing `constructionYear`/`brfName`/`tenureForm` keys parses successfully but yields `undefined` (not `null`) for those fields once spread into `DiscoveryCandidate`, and `computeNicheScore`'s guards are all strict `=== null` checks that do not catch `undefined`, causing `NaN` to silently poison the score and sort order for exactly the legacy-row case the schema change was meant to protect. This is a Critical finding — see CR-01.

## Critical Issues

### CR-01: `.optional()` Zod fields produce `undefined`, not `null`, breaking the not-assessable guarantee for pre-Phase-10 rows

**File:** `src/app/(app)/discover/[jobId]/page.tsx:71-76`, `src/lib/discovery/candidate.ts:91-93`, `src/lib/discovery/niche-score.ts:132,149,161,184,199,214`

**Issue:**
`discoveryCandidateSchema`'s Phase 10 additions use `z.number().nullable().optional()` / `z.string().nullable().optional()` specifically so that a pre-Phase-10 `discovery_jobs.results` row — one that has no `constructionYear`/`brfName`/`tenureForm` keys at all — still `safeParse`s (per the inline comment at candidate.ts:87-90 and RESEARCH Open Question 2). That part works.

The problem is downstream: `.optional()` means a missing key parses to `data.constructionYear === undefined`, not `null`. `page.tsx`'s read path then does:

```ts
const candidates = rawResults
  .map((raw) => discoveryCandidateSchema.safeParse(raw))
  .filter((parsed): parsed is { success: true; data: (typeof rawResults)[number] } =>
    parsed.success,
  )
  .map((parsed) => parsed.data);
```

The type predicate asserts `data: (typeof rawResults)[number]` — since `rawResults` comes from an untyped Supabase JSONB column, this type is `any`, so TypeScript silently accepts the assignment to `DiscoveryCandidate[]` even though the Zod-inferred shape (verified via a standalone `tsc` check) is NOT structurally assignable to `DiscoveryCandidate` (the optional fields make it a different, incompatible type). This masks the mismatch at compile time.

At runtime, for a legacy row missing the key entirely, `candidate.constructionYear` is `undefined`. Every guard in `niche-score.ts` checks `candidate.constructionYear === null` (e.g. line 149, 184, 214) — this is `false` for `undefined`, so execution falls into the "assessable" branch and calls:

```ts
scoreYearAge(candidate.constructionYear, oldCutoff, newCutoff, preferOld)
```

with `year = undefined`. `Math.max(undefined, oldCutoff)` is `NaN`, so `scoreYearAge` returns `NaN`, `push()`'s `contribution = weight * subScore` becomes `NaN` (not `0`), and `score = breakdown.reduce((sum, r) => sum + r.contribution, 0)` becomes `NaN` for that candidate. `Array.prototype.sort`'s comparator `(b.result?.score ?? 0) - (a.result?.score ?? 0)` then receives `NaN` for that candidate, which V8 treats as `0` per-comparison — silently corrupting that candidate's position in the ranking rather than triggering the clean "not assessable" (`contribution: 0`) path the module doc promises, and rather than triggering the `try/catch` fallback banner (no exception is thrown — `NaN` propagates silently).

This is the exact scenario the review brief calls out as a binding backward-compat requirement, and it is not handled correctly:

```
> Backward-compat parse — `.nullable().optional()` so pre-Phase-10 discovery_jobs.results rows still safeParse.
```

Parsing succeeds, but scoring for that row is silently wrong.

**Fix:** Use `.nullable().default(null)` instead of `.nullable().optional()` so a missing key is normalized to `null` at parse time, matching the `DiscoveryCandidate` interface's actual (non-optional, nullable) field types and closing the `undefined` gap entirely:

```ts
constructionYear: z.number().nullable().default(null),
brfName: z.string().nullable().default(null),
tenureForm: z.string().nullable().default(null),
```

This keeps the "missing key parses fine" guarantee, but the resulting `parsed.data` is now structurally identical to `DiscoveryCandidate` (no `?:` optionality), so the bogus `(typeof rawResults)[number]` type predicate in `page.tsx` can also be replaced with the schema's real inferred type:

```ts
.filter((parsed): parsed is { success: true; data: z.infer<typeof discoveryCandidateSchema> } =>
  parsed.success,
)
```

As defense in depth, `niche-score.ts`'s null guards could additionally use `== null` (loose) instead of `=== null` (strict) to catch both `null` and `undefined` at the scorer boundary regardless of how the value was produced — but the schema fix above is the correct root-cause fix.

## Warnings

### WR-01: `MIN_RANKABLE_CANDIDATES` and `MIN_BASELINE_SAMPLE` count different populations, silently collapsing `renovation-upside` to a single signal with no indication to the user

**File:** `src/components/discovery-results.tsx:18-20, 61, 87`

**Issue:** `isDegenerate` gates on `candidates.length < 3` (total candidates), while `computeAreaBaseline` requires `>= 3` candidates with a *usable* `price` + `livingArea > 0` pair. With exactly 3 total candidates where one lacks price/livingArea, `isDegenerate` is `false` (ranking proceeds, no banner), but `computeAreaBaseline` returns `{ medianPricePerSqm: null }` (below its own threshold). In that case `renovation-upside`'s `pricePerSqmVsBaseline` signal is `assessable: false` for every candidate in the set, and the niche silently degrades to ranking purely by `constructionYearAge` (weight 0.5 of the intended 1.0) — this is handled without crashing (by design, via the `assessable`/`contribution:0` mechanism), but the user sees "Rangordnat efter: Renoveringspotential" with no indication that half the intended signal could never be assessed for this result set.

**Fix:** Either align the two thresholds (compute `isDegenerate` from the same usable-sample count `computeAreaBaseline` uses when the active niche depends on price/sqm), or surface a lighter-weight inline note when a niche's `assessableSignals` ratio is unusually low across the whole set (e.g., "prisjämförelse saknas för denna sökning" caption), so the ranking's partial-signal nature is visible rather than only inferable from the per-card chip list.

### WR-02: Bogus type predicate in `page.tsx` widens the read-path type to `any`, defeating compile-time verification of the Zod-parsed shape

**File:** `src/app/(app)/discover/[jobId]/page.tsx:71-76`

**Issue:** Independent of CR-01's runtime bug, the type predicate itself is incorrect as a general pattern:

```ts
.filter((parsed): parsed is { success: true; data: (typeof rawResults)[number] } =>
  parsed.success,
)
```

`(typeof rawResults)[number]` is the raw/untyped JSONB row shape (effectively `any`, since `rawResults` originates from an untyped Supabase select), not the Zod-validated output shape. Asserting this as the predicate's narrowed type means `parsed.data` after `.filter()` carries none of the type information `safeParse` actually produced — the whole point of validating with Zod (catching shape drift at compile time, not just runtime) is lost. This is why CR-01's structural mismatch between the Zod-inferred type and `DiscoveryCandidate` was not caught by `tsc`.

**Fix:** Use `z.infer<typeof discoveryCandidateSchema>` (or drop the custom predicate entirely and use `parsed.success` inline with `.map(p => p.data)` after a `.filter(p => p.success)` — TypeScript's control-flow narrowing on `.success` handles this correctly without a hand-written predicate):

```ts
const candidates = rawResults
  .map((raw) => discoveryCandidateSchema.safeParse(raw))
  .filter((parsed) => parsed.success)
  .map((parsed) => parsed.data);
```

## Info

### IN-01: `NICHE_IDS` re-export from `discovery-results.tsx` is dead code

**File:** `src/components/discovery-results.tsx:164-166`

**Issue:** `discovery-results.tsx` re-exports `NICHE_IDS` ("Re-exported for tests / potential future reuse"), but no file imports `NICHE_IDS` from `@/components/discovery-results` — all actual consumers (`niche-score.test.ts`, `discovery-results.tsx` itself) import it directly from `@/lib/discovery/niches`. This re-export is unused.

**Fix:** Remove the re-export (lines 164-166) unless a concrete near-term consumer is planned; if kept for a specific reason, add a comment naming that consumer rather than "potential future reuse."

---

_Reviewed: 2026-07-07T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
