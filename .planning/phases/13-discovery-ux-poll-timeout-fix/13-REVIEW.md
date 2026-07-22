---
phase: 13-discovery-ux-poll-timeout-fix
reviewed: 2026-07-22T07:31:15Z
depth: deep
files_reviewed: 6
files_reviewed_list:
  - src/lib/discovery/job.ts
  - src/lib/discovery/job.test.ts
  - src/lib/booli/transport.ts
  - src/lib/booli/client.ts
  - src/lib/booli/client.test.ts
  - src/components/discovery-progress.tsx
  - src/components/discovery-progress.test.tsx
findings:
  critical: 0
  warning: 5
  info: 2
  total: 7
status: issues_found
---

# Phase 13: Code Review Report

**Reviewed:** 2026-07-22T07:31:15Z
**Depth:** deep
**Files Reviewed:** 6 source files (+2 test files read for context)
**Status:** issues_found

## Summary

Reviewed the phase-13 diff (`git diff $(git merge-base HEAD origin/main)..HEAD -- src/`) against the five locked invariants in the review brief: D-03 cost-cap race safety, additive-only transport/`fetchListing` opts, `Promise.allSettled` concurrency correctness in `runSlice`, timer/effect correctness in `discovery-progress.tsx`, and counter monotonicity.

No blockers found. The core locked invariants hold up under adversarial tracing:

- The synchronous cost pre-check (`job.ts:169-173`) genuinely stays before `Promise.allSettled` (`job.ts:186-188`); there is still exactly one persisting write in `runSlice`, at the end (`job.ts:244-251`), so D-03's "read from claimedRow, write once" discipline is intact and concurrency did not reopen a check-then-act window.
- Every existing `runPlaywrightRender`/`fetchListing` call site that does not pass `opts` (`analyze.ts:70`, `resolve-area.ts:131`, `fetch-broker-page.ts:161`, `client.ts`'s area-suggestion rungs) verifiably still gets the byte-for-byte 240s/3-retry defaults (`transport.ts:68-69`) — confirmed by direct read of every call site, not just the doc comments.
- `tsc --noEmit`, `eslint`, and the three relevant test files (`discovery-progress.test.tsx`, `job.test.ts`, `client.test.ts`, 108 tests) all pass clean.

That said, tracing the concurrency and timer changes surfaced several real correctness/robustness gaps that were not caught by the (passing) test suite because the tests use idealized (instant or artificially-staggered) mocks rather than adversarial timing. These are detailed below, worst first.

## Warnings

### WR-01: `readStatus()` has no staleness/ordering guard, unlike the dispatch it was split from

**File:** `src/components/discovery-progress.tsx:137-180` (esp. 150-163, 195-198)
**Issue:** 13-04 deliberately decoupled `readStatus()` from the `inFlight`-guarded `dispatchTick()` so the badge doesn't freeze during a long tick (GAP-1). But in removing the guard from the read, no replacement ordering protection was added: `tick()` fires `void readStatus()` on every `POLL_MS` (1500ms) interval tick with **no in-flight check at all** for the read. If any one Supabase round-trip takes longer than 1500ms (real-network latency spike, backgrounded tab causing `setInterval` to fire in a burst on resume, etc.), two or more `readStatus()` calls can be in flight simultaneously. If the **older** request resolves **after** the newer one (out-of-order network completion), `setStatus`, `setCandidateCount`, and `setCapReached` (`discovery-progress.tsx:150-151,162`) are all set from the stale response, overwriting the fresher state that was just committed — the UI can momentarily show an older `candidate_count`/`status`/`cap_reached` combination. `analyzed` alone is protected (`Math.max(prev, …)` at line 160); the other three fields are not. This directly touches the "no overlapping ticks" / timer-correctness invariant called out in the review brief — the invariant was preserved for the dispatch but not extended to the newly-unguarded read.
**Fix:** Track a monotonically increasing request id (or use `AbortController`) and ignore a `readStatus()` response that isn't the latest in-flight request:
```ts
let latestRequestId = 0;
async function readStatus() {
  if (!active) return;
  const requestId = ++latestRequestId;
  const { data } = await supabase.from("discovery_jobs")...single();
  if (!active || requestId !== latestRequestId) return; // stale response, drop it
  ...
}
```

### WR-02: Sequential `enrichCandidateImages` loop can still exceed the Vercel Server Action ceiling even with the new bounded opts

**File:** `src/lib/discovery/job.ts:390` (`VISION_ENRICH_LIMIT = 8`), `486-555` (sequential `for` loop), `booli/client.ts:660-661` (`DETAIL_ENRICH_WAIT_SECS = 90`, `DETAIL_ENRICH_MAX_RETRIES = 2`)
**Issue:** 13-04's fix for GAP-2 bounds each detail fetch to at most 2 rungs × `90s` wait ceiling ≈ 180s worst case per candidate. But `enrichCandidateImages` still visits up to `VISION_ENRICH_LIMIT = 8` candidates **sequentially** (plain `for...of`, no concurrency) — worst case ≈ 8 × 180s = 1440s (24 min), still well past the documented ~300s `TICK_DISCOVERY_MAX_DURATION_SEC` Server Action ceiling this whole phase is trying to respect. The 13-03 live smoke's own observed failure mode (a Booli 403 + Cloudflare 60s timeout on the retry budget) is exactly the scenario that would repeat across multiple candidates in the same run if the block is IP-level (as the code comment itself concedes: "the 403 itself is environmental... local IP blocking"), not per-candidate — so the "one blocked candidate" framing in the doc comment (`job.ts:505-507`, `client.ts:648-658`) undersells the actual worst case. This is a real reliability risk for a job that has already reached `vision_processing` (post-scrape, non-recoverable via the scrape claim), not merely a performance nit — a Server Action that times out mid-write leaves the job's row unrecoverable at `"vision_processing"` per `runVisionForJob`'s own doc comment (`job.ts:364-372`), which explicitly warns this exact state is a stuck-forever row.
**Fix:** Either bound `enrichCandidateImages`'s total wall-clock budget explicitly (track elapsed time and stop enriching further candidates once a wall-clock ceiling is hit, degrading gracefully as the function already does for other failure modes), or run the detail fetches with bounded concurrency (e.g. `Promise.allSettled` in batches of 2-3) the same way `runSlice`'s area scrape was just parallelized in this same phase.

### WR-03: Failed-rung Apify spend during a partial multi-area scrape is never added to `cost_sek_total`

**File:** `src/lib/discovery/job.ts:186-209` (aggregation), `223-232` (`sliceCostSek` computed from `rendersUsed`)
**Issue:** `rendersUsed` is only incremented for areas whose `Promise.allSettled` outcome is `"fulfilled"` (line 195). An area whose `fetchAreaListings` call throws (`walkFallbackTree` exhausting both own-render rungs) has already incurred real Apify actor-call cost for up to 2 rung attempts (each a real `client.actor(...).call(...)`, per `transport.ts:71-90`) — that cost is silently never reflected in `newCostSekTotal` (line 232). In a multi-area query where one area succeeds and another throws, the job still persists as `"done"` (since `raw.length > 0` at line 206), permanently under-recording the true spend for that job. This predates phase 13 structurally (the same `rendersUsed += 1`-on-success-only pattern existed in the old sequential loop), but the review brief explicitly asks to verify the D-03 cost-cap invariant, and parallelizing the area scrape (this phase's own change) means more areas — and therefore more silently-uncounted failed-rung spend — can be attempted per tick than before. `cap_sek` is therefore enforced against an increasingly optimistic estimate of real spend as multi-area queries get wider.
**Fix:** At minimum, log the uncounted spend for operator visibility (e.g. `console.error` with a distinguishable code when `anyThrew` is true and `raw.length > 0`, so a partial-failure job's true cost is auditable from logs even though it's not folded into `cost_sek_total`). A fuller fix would attribute a render's cost to `rendersUsed` regardless of whether the area's overall result fulfilled or rejected — since `discoveryCostSek` charges per attempted render, not per successful one, in spirit.

### WR-04: `dispatchTick()`'s `tickDiscovery()` call has no `.catch` — an unexpected rejection is an unhandled promise rejection with no user-visible signal

**File:** `src/components/discovery-progress.tsx:182-193`
**Issue:** `dispatchTick` does `try { await tickDiscovery(jobId); } finally { inFlight = false; }` — there is no `catch`. `tickDiscovery` (`src/actions/tick-discovery.ts`) is written to swallow its own Supabase-level errors internally, but it is a Next.js Server Action invoked over the network from the client; if the network call itself fails (e.g. dropped connection, Server Action framework-level error, cold-start failure), the rejection propagates out of `dispatchTick()` as an unhandled promise rejection since it's invoked via `void dispatchTick()` (line 197) with no `.catch` anywhere in the chain. The `finally` still runs (so `inFlight` correctly resets, preventing a permanent stuck-guard), but the user gets zero feedback that ticks are silently failing — the counter/badge simply stalls until the 15-minute `ABSOLUTE_CEILING_MS` eventually fires "failed", which is a much worse UX than the two-tier soft/hard system this phase was built to deliver. This gap predates phase 13 (the old single `poll()` had the same missing catch around its `tickDiscovery` call) but the decoupling makes it more consequential: previously a `tickDiscovery` failure also skipped that cycle's status read (same try block), so the badge would visibly freeze, hinting something was wrong; now the read runs independently and keeps refreshing normally, so a silently-failing tick is now **less** visible to the user than before, not more — the badge and counter both look fine while the server-side slice-advancing tick is quietly failing every 1.5s.
**Fix:** Add a `.catch` (or try/catch) around the `tickDiscovery` call that at minimum logs client-side, and consider surfacing a distinct "retry-in-progress" indicator distinct from the calm soft-notice if N consecutive ticks fail.

### WR-05: `onComplete` passed to `DiscoveryProgress` is a fresh inline arrow function every render, defeating the timer-persistence assumption the new two-tier system depends on

**File:** `src/components/discovery-progress-live.tsx:28`, consumed at `src/components/discovery-progress.tsx:227` (`useEffect(..., [jobId, onComplete])`)
**Issue:** `DiscoveryProgressLive` passes `onComplete={() => router.refresh()}` — a new function identity on every render of `DiscoveryProgressLive`. The `useEffect` in `DiscoveryProgress` that owns `interval`, `softTimeout`, and `hardTimeout` depends on `[jobId, onComplete]` (line 227); if `DiscoveryProgressLive` (or anything above it) ever re-renders while a job is still in progress, the effect tears down and re-establishes, silently resetting both the soft-notice countdown and the 15-minute absolute ceiling back to zero. This file is unchanged by phase 13 (verified via `git diff` — zero changes), so it is not a regression introduced by this diff, but the phase materially raises the stakes: previously there was one 5-minute hard timeout to reset; now there are two independently-tuned timers whose whole purpose (per the 13-05/13-04 design docs) is calibrated persistence across the actual scrape+vision duration. If this component ever gains a re-render trigger (a very plausible future change, e.g. adding local UI state to `DiscoveryProgressLive`), the two-tier timeout system silently stops functioning with no test coverage that would catch it, since the current tests render `DiscoveryProgress` directly with a stable `onComplete` mock.
**Fix:** Wrap the `onComplete` callback passed from `DiscoveryProgressLive` in `useCallback` (`const onComplete = useCallback(() => router.refresh(), [router]);`) as defensive-in-depth, independent of whether it currently re-renders.

## Info

### IN-01: `cost_sek_total` is selected but never read in `discovery-progress.tsx`

**File:** `src/components/discovery-progress.tsx:141-143` (select string), `DiscoveryJobRow` interface at line 22
**Issue:** The `.select(...)` string still includes `cost_sek_total`, and the `DiscoveryJobRow` interface still declares it, but no code path in the component reads or displays it (only `status`, `candidate_count`, `cap_candidates`, `cap_reached` are used). This predates phase 13 (only `processed_count` was removed from this select in this diff) but is worth cleaning up while the type/select were already being touched.
**Fix:** Drop `cost_sek_total` from both the select string and the `DiscoveryJobRow` interface, or use it (e.g. surface real spend to the user) if that's the intent.

### IN-02: `enrichCandidateImages`'s reno-priority resort recomputes `enrichmentVisitOrder` from scratch even though only image-less candidates are ever visited

**File:** `src/lib/discovery/job.ts:456-462`, `498`
**Issue:** Not a correctness bug — the visit-order/filter/limit logic is correct and well-tested — but `enrichmentVisitOrder` sorts the *entire* candidate array (including candidates that already have images and will be `continue`d past at line 501) every time `enrichCandidateImages` runs. With candidate sets capped at `cap_candidates` (typically ≤25-30), this is negligible in practice; flagging only because a reviewer tracing the loop should be aware the sort touches more elements than the loop ultimately acts on. Out of v1 performance scope; no action required.

---

_Reviewed: 2026-07-22T07:31:15Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
