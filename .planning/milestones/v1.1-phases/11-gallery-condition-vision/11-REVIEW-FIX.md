---
phase: 11-gallery-condition-vision
fixed_at: 2026-07-07T16:05:29Z
review_path: .planning/phases/11-gallery-condition-vision/11-REVIEW.md
iteration: 1
findings_in_scope: 8
fixed: 8
skipped: 0
status: all_fixed
---

# Phase 11: Code Review Fix Report

**Fixed at:** 2026-07-07T16:05:29Z
**Source review:** .planning/phases/11-gallery-condition-vision/11-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 8 (4 Critical + 4 Warning; IN-01 intentionally out of scope per instructions, though its ask — extracting a named cost helper — was satisfied as a side effect of the CR-01 fix)
- Fixed: 8
- Skipped: 0

## Fixed Issues

### CR-01: Vision cost cap check uses a fabricated average, not a real per-call estimate

**Files modified:** `src/lib/discovery/cost.ts`, `src/lib/discovery/vision.ts`
**Commit:** `13ece07`
**Applied fix:** Added `estimateVisionCallSek()` to `cost.ts` — a real, priced worst-case per-call estimate derived from `CAP_IMAGES_PER_LISTING` images at the Standard-tier ~1568-visual-token estimate, run through both the Haiku pre-filter and Sonnet deep-pass rate tables (via the existing `costSek`/`costSekSonnet`), plus each call's `max_tokens` ceiling billed as pure output. `runVisionPass`'s pre-spend gate in `vision.ts` now checks this real figure before every Sonnet-eligible call instead of `CAP_VISION_SEK_MAX / candidates.length`, which shrank arbitrarily as the candidate set grew. This also satisfies IN-01's request (a named, reusable helper mirroring `estimatedSliceCostSek`'s precedent) as a natural side effect, without separately addressing IN-01 as an in-scope finding. Verified by the existing `cost.test.ts`/`vision.test.ts` suites (20 tests, all passing).

### CR-02: Uncaught vision-pipeline error strands already-scraped job results with no retry path

**Files modified:** `src/lib/discovery/vision.ts`, `src/lib/discovery/vision.test.ts`, `src/lib/discovery/job.ts`, `src/lib/discovery/job.test.ts`, `src/lib/discovery/candidate.ts`, `src/components/gallery-condition-vision.tsx`, `src/components/gallery-condition-vision.test.tsx`
**Commit:** `3622172` (combined with WR-04 — see note below)
**Applied fix:** `runVisionPass` now wraps its per-candidate `runVisionForCandidate` call in a try/catch; a thrown error degrades ONLY that candidate to `visionSkippedReason: "vision_error"` and the loop continues to the next candidate, instead of the throw propagating up through `runVisionForJob` and out of `tickDiscovery`/the sweep route uncaught. `runVisionForJob` also wraps its own body in a defense-in-depth try/catch that never rethrows (with a nested try/catch around its own recovery write, so even an unexpected synchronous client failure can't escape). Added `"vision_error"` to the `DiscoveryCandidate.visionSkippedReason` union (interface + its read-path zod guard) and a corresponding UI state in `GalleryConditionVision`. Regression tests added: a failing candidate does not strand a later candidate in the same pass; `runVisionForJob` never rethrows on an unexpected failure.
**Note:** Committed together with WR-04 because both findings' fixes live inside the same `runVisionForJob`/`updateJob` code region and are logically coupled (the try/catch boundary CR-02 adds is also where WR-04's persist-failure check lives) — splitting them would have required re-implementing overlapping hunks twice with no net benefit to reviewability.

### CR-03: Dedupe-map fallback key collision cross-contaminates vision results between candidates with a missing sourceListingUrl

**Files modified:** `src/lib/discovery/vision.ts`, `src/lib/discovery/vision.test.ts`
**Commit:** `05bac9c`
**Applied fix:** `runVisionPass`'s dedupe key fallback changed from a shared `"unknown"` sentinel to the candidate's own array index (`unknown-${i}`, threaded via `candidates.entries()`), which is guaranteed unique within one pass. Added a regression test with two `sourceListingUrl: null` candidates carrying distinct image sets, proving both get independent Anthropic calls and distinct, non-cross-contaminated `VisionResult`s.

### CR-04: Concurrent tabs/sweep racing after runSlice completion can still double-invoke vision for the same job

**Files modified:** `src/lib/discovery/job.ts`, `src/lib/discovery/job.test.ts`, `src/actions/tick-discovery.ts`, `src/actions/tick-discovery.test.ts`, `src/app/api/discovery/sweep/route.ts`, `src/app/api/discovery/sweep/route.test.ts`
**Commit:** `01cb71a`
**Applied fix:** Added `claimVisionSlice` (job.ts) — an atomic single-row CAS status transition (`"done"` → `"vision_processing"`) mirroring `generate-report.ts`'s conditional-update pattern exactly (`.update({...}).eq("id", id).eq("status", "done").select().maybeSingle()`). No migration required — `status` is a bare `text` column with no check constraint. `claimAndRunVisionForJob` composes the CAS with `runVisionForJob` so only the invocation that wins the transition ever spends; `runVisionForJob`'s own write restores `status` to `"done"` on both success and its defense-in-depth catch path so a claimed row never wedges at `"vision_processing"`. Both call sites (`tickDiscovery`, `sweep/route.ts`) now unconditionally delegate to `claimAndRunVisionForJob` instead of running their own unlocked check-then-act `SELECT status`. Added regression tests proving exactly one of two concurrent `claimVisionSlice`/`claimAndRunVisionForJob` invocations on the same `"done"` job wins and runs vision.

### WR-01: UI-SPEC-required 24px gap between the ranking grid and the vision section is actually 16px

**Files modified:** `src/components/discovery-results.tsx`, `src/components/discovery-results.test.tsx`
**Commit:** `110cf02`
**Applied fix:** Added `mt-6` to the vision section's wrapper `<div>` (its existing `space-y-6` only governs spacing between vision cards inside that wrapper, not the gap above it, since both the grid and the wrapper are direct children of the outer `space-y-4` container). Added a regression test asserting the vision wrapper (the grid's next DOM sibling) carries both `mt-6` and `space-y-6`.

### WR-02: `imageIndex` has no bounds validation — a hallucinated out-of-range citation silently passes the confidence/null filter

**Files modified:** `src/lib/discovery/vision.ts`, `src/lib/discovery/vision.test.ts`
**Commit:** `6832ded`
**Applied fix:** The Sonnet deep-pass claim filter in `runVisionForCandidate` now also requires `1 <= imageIndex <= capped.length` before keeping a claim, dropping any claim whose citation doesn't resolve to a real sent image even at full confidence. Fixed a pre-existing test that had been silently asserting a kept `imageIndex: 2` claim against a single-image candidate (itself an instance of the bug this finding describes); added a dedicated regression test for out-of-range (2 with 1 image sent) and zero `imageIndex` at full confidence, both correctly dropped.

### WR-03: `.bcdn.se` added to the image-host allowlist without the documented pinning discipline the rest of the file follows

**Files modified:** `src/lib/booli/client.ts`, `src/lib/booli/client.test.ts`
**Commit:** `8463603`
**Applied fix:** Removed the unverified `.bcdn.se` entry from `isAllowedImageHost`, restoring the allowlist to `booli.se`/`*.booli.se` only — the only hosts 11-RESEARCH.md's SSRF discussion and Assumption A1 ever reference. Added a doc comment explaining the removal and the exact re-add condition (a confirmed probe finding). Added a regression test proving a bare `bcdn.se` host is dropped while `bcdn.booli.se` (a genuine `*.booli.se` subdomain used throughout the existing fixtures) remains allowed.
**UAT follow-up flag:** if the deferred live probe (`scripts/probe-booli-images.ts`, operator-run against a real listing) confirms Booli genuinely serves gallery images from a distinct `bcdn.se` (or other) CDN host, re-add it to the allowlist with a citation to the probe output — never speculatively ahead of that confirmation. This was not run as part of this fix pass per the task's live-probe exclusion constraint.

### WR-04: `runVisionForJob`'s `updateJob` failure is silently swallowed, leaving vision results computed-but-unpersisted with no signal to the caller

**Files modified:** `src/lib/discovery/job.ts`, `src/lib/discovery/job.test.ts`
**Commit:** `3622172` (combined with CR-02 — see note above)
**Applied fix:** `updateJob` now returns a boolean success indicator instead of a bare `Promise<void>` (existing `runSlice` call sites are unaffected since they never read the return value). `runVisionForJob` checks it and logs a distinguishable `"vision computed but not persisted — spend lost"` error (GDPR-safe: `{ jobId, code: "VISION_PERSIST_FAILED" }` only) when the final results write fails, so Anthropic spend already incurred is no longer a silent, unobservable loss. Added a regression test proving a failed persist logs `VISION_PERSIST_FAILED` and does not throw.

## Skipped Issues

None — all 8 in-scope findings (CR-01 through CR-04, WR-01 through WR-04) were fixed. IN-01 was intentionally excluded from this pass per the task instructions (its underlying ask — a named cost-estimate helper — was satisfied as a side effect of the CR-01 fix, but IN-01 itself was not separately actioned).

## Verification

- `npx vitest run` — **572 passed, 3 skipped** (skipped tests are pre-existing live-DB/live-LLM integration/eval tests gated behind `RUN_DB_INTEGRATION=1`/`RUN_LLM_EVALS=1`, unaffected by this pass and not run per the live-probe/validation-gate exclusion constraint).
- `npx tsc --noEmit` — clean, no errors.
- `npm run build` — succeeds (Next.js 16.1.6 / Turbopack), all routes compile including `/api/discovery/sweep`, `/discover`, `/discover/[jobId]`.
- `npx eslint` on all touched files — clean, no warnings or errors.
- `DISCOVERY_ENABLED` flag gating untouched — feature remains flag-OFF by default.
- `STATE.md`/`ROADMAP.md` not modified.
- No new Supabase migration — `discovery_jobs.status` remains a bare `text` column; the new `"vision_processing"`/`"vision_error"` status/reason words follow the existing "a new status word never needs DDL" precedent (`010_discovery_jobs.sql`).
- Structural-separation invariant preserved: no vision value was threaded into `computeNicheScore`/`ReportFlags`/`niche-score.ts`/`flags.ts`; `niche-score.test.ts`'s static-grep invariant test still passes unmodified.

---

_Fixed: 2026-07-07T16:05:29Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
