---
phase: 10-niche-ranking
fixed_at: 2026-07-07T14:36:58Z
review_path: .planning/phases/10-niche-ranking/10-REVIEW.md
iteration: 1
findings_in_scope: 3
fixed: 3
skipped: 0
status: all_fixed
---

# Phase 10: Code Review Fix Report

**Fixed at:** 2026-07-07T14:36:58Z
**Source review:** .planning/phases/10-niche-ranking/10-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 3 (1 Critical + 2 Warning; IN-01 excluded from this pass per instruction)
- Fixed: 3
- Skipped: 0

## Fixed Issues

### CR-01: `.optional()` Zod fields produce `undefined`, not `null`, breaking the not-assessable guarantee for pre-Phase-10 rows

**Files modified:** `src/lib/discovery/candidate.ts`, `src/app/(app)/discover/[jobId]/page.tsx`, `src/lib/discovery/niche-score.ts`, `src/lib/discovery/candidate.test.ts`, `src/lib/discovery/niche-score.test.ts`
**Commit:** `f5a62d8`
**Applied fix:**
- `candidate.ts`: changed `constructionYear`/`brfName`/`tenureForm` from `.nullable().optional()` to `.nullable().default(null)` so a pre-Phase-10 row missing the key normalizes to `null` at parse time instead of `undefined`.
- `page.tsx`: replaced the bogus `(typeof rawResults)[number]` type predicate (which resolved to `any`) with plain `.filter((parsed) => parsed.success).map((parsed) => parsed.data)`, letting TypeScript's control-flow narrowing on `.success` produce the real Zod-inferred type. This also resolves WR-02 (see below — same root cause/fix).
- `niche-score.ts`: changed the `push` helper's guard from `subScore !== null` to `subScore != null` (loose), and all 5 call-site guards (`candidate.constructionYear === null` / `candidate.tenureForm === null` / `ratio === null` / the `candidatePricePerSqm` derivation) from strict `===` to loose `==`, so a stray `undefined` is treated identically to `null` (not assessable, contribution 0) rather than producing `NaN`.
- Added regression tests: `candidate.test.ts` asserts an old-shape row (missing the 3 keys) parses them to `null` and explicitly not `undefined`; `niche-score.test.ts` adds two tests — one confirming an `undefined` `constructionYear` yields `assessable:false`/`contribution:0`/no `NaN` score, and one confirming a 3-candidate set including a legacy/`undefined` candidate sorts deterministically (well-defined old candidate ranks first, legacy candidate present in the output, no `NaN` in any score).

### WR-01: `MIN_RANKABLE_CANDIDATES` and `MIN_BASELINE_SAMPLE` count different populations, silently collapsing `renovation-upside` to a single signal with no indication to the user

**Files modified:** `src/components/discovery-results.tsx`, `src/components/discovery-results.test.tsx`
**Commit:** `50aa30a`
**Applied fix:** Kept ranking active (per the fix's preferred option) and added a `baselineThinForActiveNiche` derived flag (`rankable && niche === "renovation-upside" && areaBaseline.medianPricePerSqm === null`) that surfaces an honest inline caption — "Prisjämförelse saknas för denna sökning — för få annonser med pris och boarea för att beräkna ett områdesgenomsnitt. Rangordningen baseras enbart på byggår." — consistent with the existing cited-signal honesty pattern, rather than only being inferable from the per-card chip list. Added a regression test with 3 candidates (passes `isDegenerate`) where only 1 has a usable price+livingArea pair (fails `MIN_BASELINE_SAMPLE`), confirming the caption appears, ranking still proceeds (rank badges present), and the degenerate banner does NOT appear.

### WR-02: Bogus type predicate in `page.tsx` widens the read-path type to `any`, defeating compile-time verification of the Zod-parsed shape

**Files modified:** `src/app/(app)/discover/[jobId]/page.tsx` (same edit as CR-01(b))
**Commit:** `f5a62d8`
**Applied fix:** Covered by the CR-01(b) fix above — the `(typeof rawResults)[number]` predicate was removed entirely in favor of `.filter((parsed) => parsed.success)`, restoring real compile-time typing of `parsed.data` via TypeScript's control-flow narrowing (no lingering `any`-eroding predicate). Verified via a clean `npx tsc --noEmit` run with zero errors in the modified file.

## Skipped Issues

None — all 3 in-scope findings were fixed. (IN-01 was explicitly excluded from this pass per instruction and left untouched.)

## Verification

- `npx tsc --noEmit`: clean, zero errors.
- `npx eslint` on all touched files: clean, zero errors/warnings.
- `npx vitest run` (full suite): 505 passed, 2 skipped (pre-existing skips, unrelated to this fix pass), 0 failed.
- `npm run build`: succeeded (Turbopack production build, all routes compiled including `/discover/[jobId]`).
- `DISCOVERY_ENABLED` flag: not touched, remains OFF by default.
- `.planning/STATE.md` / `.planning/ROADMAP.md`: not modified.
- No new database migration introduced.

---

_Fixed: 2026-07-07T14:36:58Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
