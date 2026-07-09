---
phase: 08-brf-auto-fetch
fixed_at: 2026-07-07T08:30:28Z
review_path: .planning/phases/08-brf-auto-fetch/08-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 6
skipped: 0
status: all_fixed
---

# Phase 8: Code Review Fix Report

**Fixed at:** 2026-07-07T08:30:28Z
**Source review:** .planning/phases/08-brf-auto-fetch/08-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 6 (Critical: 2, Warning: 4 — Info findings IN-01/02/03 explicitly excluded from this pass per instruction)
- Fixed: 6
- Skipped: 0

## Fixed Issues

### CR-01: `confirmAndAnalyze`'s redundant-work guard is check-then-act, not atomic

**Files modified:** `src/actions/fetch-brf-auto.ts`, `src/actions/fetch-brf-auto.test.ts`
**Commit:** `27a81f3`
**Applied fix:** Replaced the plain-read-then-unconditional-write guard with a single atomic conditional UPDATE (`update({brf_status:"auto_fetching"}).eq("id",id).or("brf_status.is.null,and(brf_status.neq.auto_fetching,brf_status.neq.done)").select("id").maybeSingle()`), mirroring `generate-report.ts`'s real CAS mechanism instead of only its intent. A `null`/empty `acquired` result now means "another request already in flight" and aborts before any scrape/bill. Used `.or(is.null, neq...)` rather than a bare `.neq`/`NOT IN` predicate specifically to avoid the PostgREST NULL-filter trap (a brand-new analysis's `brf_status` is NULL, and `NULL <> 'x'` evaluates to unknown in three-valued SQL logic — a bare negation would silently exclude every first-ever auto-fetch attempt). Added a regression test (`fetch-brf-auto.test.ts`) proving a concurrent double-trigger acquires the lock exactly once and the second (racing) caller aborts without a second scrape/bill.

**Note for human verification:** this is a concurrency-control fix (logic, not pure syntax) — the mock-based regression test proves the intended CAS *shape* (single conditional UPDATE + `.select().maybeSingle()` result check) is wired correctly, but true DB-level serialization of two genuinely concurrent requests cannot be exercised without a real Postgres instance. Recommend a manual/staging verification of the `.or()` predicate against a live Supabase project before this ships to production traffic, per the constraints (no live smoke test run in this pass).

### WR-02: `confirmAndAnalyze`'s failure path can clobber a status a concurrent/retried request already advanced past

**Files modified:** `src/actions/fetch-brf-auto.ts`, `src/actions/fetch-brf-auto.test.ts`
**Commit:** `27a81f3` (same commit as CR-01 — the review explicitly states this fix only makes sense once CR-01's CAS exists, and both edits live in the same code block)
**Applied fix:** The catch block's `brf_status: null` release write is now conditional (`.eq("brf_status", "auto_fetching")`), so it only fires when this invocation still owns the lock. A concurrent/retried request that has since progressed the row to `extracting`/`scoring`/`done` is no longer regressed back to `null`. Added a regression test proving the release does not clobber a status a concurrent request already advanced to `"done"`.

### CR-02: iXBRL-derived text has no size cap before it reaches the Claude call

**Files modified:** `src/lib/brf/ixbrl-to-text.ts`, `src/lib/brf/ixbrl-to-text.test.ts`
**Commit:** `95e88c1`
**Applied fix:** Added a `MAX_TEXT_CHARS = 300_000` hard cap in `ixbrlToPlainText` — the stripped text is truncated to a bounded prefix when it exceeds the cap, never passed through unbounded, and the function still never throws (consistent with its existing degrade-not-throw contract). This closes the gap between `allabrf.ts`'s 8 MB raw-HTML cap and `extract.ts`'s uncapped `text/plain` document block, mirroring the PDF path's `BASE64_MAX_BYTES` threshold discipline. Added three regression tests: oversized text (400k chars) truncates to exactly 300k chars matching the expected prefix, at-cap text (exactly 300k chars) passes through untouched, and normal-sized documents are never truncated.

### WR-01: `resolveOrgNrAction` and `confirmAndAnalyze` independently fetch the same Allabrf document

**Files modified:** `src/actions/fetch-brf-auto.ts`
**Commit:** `df75973`
**Applied fix:** Per the review's own guidance ("low-risk, keep it simple... or explicitly document why a double-fetch is acceptable"), chose documentation over caching: added an inline comment explaining the double-fetch is intentional (resolution/confirmation can be arbitrarily far apart in time; re-fetching gets current data) and low-risk (both calls hit only the free Allabrf scrape, never Claude — CR-01's atomic CAS already guarantees the billed `runBrfExtraction` call fires at most once per confirm, so there is no double-bill risk). No behavioral change; a short-TTL cache was considered and rejected as added complexity (invalidation, store lifetime) not justified by saving one free HTTP scrape.

### WR-03: `walkBrfSources`'s `rungs.length > 3` guard — reachability/test-coverage concern

**Files modified:** `src/lib/brf-source/fetch-document.ts`
**Commit:** `08a5c70`
**Applied fix:** On inspection, `fetch-document.test.ts` already contains a passing regression test ("throws a loud, immediate error for a rung list longer than 3 (IN-04)") that exercises this exact guard and asserts no rung's `attempt()` runs once it trips — the review's characterization of this path as "not exercised by any test today" did not match the current test file state. No code/logic change was needed; expanded the doc comment to explicitly cross-reference the guard's reachability (it fires synchronously before any rung executes) and the existing test coverage, so a future contributor adding a 4th (Bolagsverket) rung has clear guidance.

### WR-04: `BrfSection`'s org.nr-resolution effect has a stale-closure risk on `brfStatus`/`listingData`

**Files modified:** `src/components/brf-section.tsx`, `src/components/brf-section.test.tsx`
**Commit:** `3c84e2b`
**Applied fix:** Added `brfStatus` and `listingData` to the effect's dependency array (removing the `eslint-disable-next-line react-hooks/exhaustive-deps`), and introduced a `resolutionAttemptedForId` ref that gates against a duplicate resolution attempt for the same `analysisId`. Because a ref update never triggers a re-render/re-run, this closes the stale-closure gap (a future caller re-rendering `BrfSection` with updated props now has those props actually observed by the effect) without introducing any infinite-loop risk. Added two regression tests: one proving resolution fires at most once per `analysisId` across re-renders with new prop object references (guards against a loop), and one proving a live `brfStatus` update advancing past the resolvable window (e.g. to `"done"`) is observed on a re-render rather than stuck on a stale mount-time value (proves the stale-closure fix).

## Skipped Issues

None — all 6 in-scope findings (CR-01, CR-02, WR-01, WR-02, WR-03, WR-04) were fixed. IN-01, IN-02, IN-03 were explicitly excluded from this pass per instruction and were not attempted.

## Verification

- `npx vitest run` (full suite): **411 passed, 1 skipped** (pre-existing skip, unrelated to this pass) — 0 failures.
- `npx tsc --noEmit`: clean, no errors.
- `npm run build`: succeeds (Next.js 16.1.6 / Turbopack production build, all routes compiled).
- `npx eslint` on all touched files: clean except one **pre-existing** warning (`_fiscalYear` unused parameter in `fetch-brf-auto.ts`, confirmed present on the base branch before this pass — not introduced by these fixes).
- New/extended regression tests added for CR-01 (concurrent double-trigger aborts the second caller), CR-02 (oversized stripped text is bounded), WR-02 (conditional release doesn't clobber a concurrent request's advanced status), and WR-04 (stale-closure fix verified via re-render, no-loop guarantee verified via call-count assertion).

---

_Fixed: 2026-07-07T08:30:28Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
