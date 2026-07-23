# Phase 13: Discovery UX / Poll-Timeout Fix - Research

**Researched:** 2026-07-18
**Domain:** Client-tick-driven job queue concurrency (Next.js Server Actions + Supabase RPC) + progress-UI state machine
**Confidence:** HIGH (this is entirely internal-codebase archaeology — every architectural claim below was read directly from source, not from external docs)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01 (primary lever):** Parallelize across **areas** in `runSlice` — today only pages within an area run concurrently (`Promise.allSettled`), while the areas themselves scrape sequentially, so "Södermalm och Vasastan" run back-to-back and a single timing-out page blocks its area's batch ~180s. Run the areas concurrently too.
- **D-02 (secondary lever):** Cap per-page render retries / lower the Booli `networkidle` 60s per-page timeout so one slow page can't stall its area's batch. Apply as a complementary tactic to D-01, not instead of it.
- **D-03 (cost-cap invariant — LOCKED):** Parallelizing areas must NOT weaken the shared incremental cost/candidate caps. The atomic claim/accounting (`claim_discovery_slice`, cost gate) must stay race-free under concurrent area scrapes — no double-spend, caps still enforced exactly. Real Apify + Anthropic spend per run.
- **D-04:** Replace the current hard-fail-at-ceiling behavior (`discovery-progress.tsx:133-139` sets `timedOut` + `onComplete("failed")`, forcing a reload while the server finishes fine) with a **calm, non-failing** state: at the soft threshold show "Det tar längre tid än väntat, fortsätter…" and **keep polling + ticking** until the row reaches a terminal status. A false "Misslyckades" must never show for a run the server will complete.
- **D-05:** Keep a generous ABSOLUTE safety ceiling (well above the current 5 min) so a genuinely dead server eventually surfaces a real failure — the soft "tar längre tid" notice is not the same as giving up. Exact value at planner's discretion; the point is: soft-notice early, hard-stop only far out.
- **D-06:** Add `vision_processing: "Analyserar bilder"` to `STATUS_LABELS` in `discovery-progress.tsx`. Chosen over "Bildanalys"/"Tolkar bilder" — reads as the natural next step after the existing "Analyserar" scrape label.
- **D-07:** Audit the full set of job statuses the row can hold and ensure EVERY one has a `STATUS_LABELS` entry — no raw enum string may ever reach the badge via the `?? status` fallback. Known statuses from the codebase: pending, processing, vision_processing, done, failed, degraded (verify against the discovery_jobs status set during planning).

### Claude's Discretion

- Exact soft-threshold vs absolute-ceiling millisecond values, the concrete concurrency primitive for area-level parallelism, and whether `discovery-progress-live.tsx` needs the same label/threshold treatment (check both components).

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope. (Analysis throughput improvements that change WHAT is analyzed belong to Phases 14–17.)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DXUX-01 | A discovery job for a realistic multi-area query (300+ listings + vision) completes and shows results without a reload — the server-side run finishes within the client poll window (parallelize across areas / cap per-page render retries) | Architecture Patterns §"Area parallelism fits inside one slice", Common Pitfalls #1–#4, Code Examples §1–§3 |
| DXUX-02 | Every discovery job state renders a Swedish status label — no raw enum string leaks (fixes missing `vision_processing` label) | Architecture Patterns §"Complete status vocabulary", Code Examples §4 |
</phase_requirements>

## Summary

This phase fixes a real, already-diagnosed production bug, not a greenfield build — the fix is fully scoped to two files' internals (`src/lib/discovery/job.ts`'s `runSlice` and `src/components/discovery-progress.tsx`'s timeout/label logic). No new libraries, no new architecture, no DB migration. The root cause (RESUME.md P1, confirmed by reading `job.ts` directly) is a plain sequential `for...of` loop over resolved area IDs (job.ts:178–191) that calls `fetchAreaListings` one area at a time — while `fetchAreaListings` itself already parallelizes PAGES 2–5 within one area via `Promise.allSettled` (`booli/client.ts:719–722`). The fix is to apply the exact same already-proven primitive one level up: `Promise.allSettled` across `areaIds` instead of a sequential loop.

Critically, this change fits **entirely inside a single `runSlice` invocation** — it does not touch the slice/claim granularity at all. `runSlice` already reads all of its counters from the frozen `claimedRow` (never a fresh SELECT) and writes exactly ONE terminal `UPDATE` at the end, after all area fetches (however many run concurrently) have settled. `claim_discovery_slice`'s atomic `FOR UPDATE SKIP LOCKED` RPC is what prevents two ticks from ever running `runSlice` concurrently on the *same* job — a mechanism area-level parallelism never touches. So D-03's race-free invariant is preserved by construction, not by anything new that needs to be built.

The second, less obvious finding: D-02 is not just a UX nicety, it is load-bearing for D-01 to actually work. The per-render wait ceiling is `waitSecs: 240` in `transport.ts`'s `runPlaywrightRender` (shared by every Booli read — single-listing, area-page, broker enrichment). Each area page attempts up to 2 rungs (`fetchAreaPage`'s `walkFallbackTree`), so **one straggling page can legitimately cost up to ~480s** in the worst case — already over the documented 300s Vercel Server Action ceiling (`TICK_DISCOVERY_MAX_DURATION_SEC`), independent of whether areas run in parallel. A killed-mid-execution tick leaves the row `processing` with a fresh `claimed_at`, unreclaimable for a further 5 minutes (the same `STALE_MS`/`p_stale_ms` window used by `claim_discovery_slice` and the sweep route) — so an unbounded per-page timeout can silently add a 5-minute stall on top of anything the client UI does. D-02 must scope a materially lower wait ceiling to AREA-page renders specifically (not detail-page renders, which the codebase's own comments warn against regressing) to keep worst-case tick duration comfortably under 300s.

There is no literal `networkidle`/`60s` constant anywhere in the codebase (confirmed by grep across `src/`) — CONTEXT.md's phrasing describes the Apify actor's page-load behavior conceptually, not a named value in code. The actual, only controllable lever is the `waitSecs` parameter passed to the Apify actor `.call()` in `transport.ts` (currently a single global `240`), plus the `maxRequestRetries: 3` actor input (also currently global). Both need a scoped override for area-page rungs to avoid regressing the proven detail-page reliability.

**Primary recommendation:** Change job.ts's sequential area loop to `Promise.allSettled`, mirroring `fetchAreaListings`'s existing page-parallel pattern exactly (same aggregation shape: collect fulfilled results, track any-rejected for the degrade/done branch). Add an optional, area-page-scoped lower `waitSecs` override to `runPlaywrightRender`/`fetchAreaPage` so a single slow render can't blow the Vercel tick ceiling even with areas parallelized. Replace `discovery-progress.tsx`'s single `MAX_POLL_MS` hard-fail with two thresholds (soft notice, keep polling; absolute ceiling, real fail) and complete `STATUS_LABELS` with `vision_processing`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Area-level scrape concurrency | API / Backend (Server Action → `job.ts`) | — | `runSlice` runs server-side inside `tickDiscovery`; the client never sees individual area fetches, only the aggregated row |
| Per-page render timeout/retry bound | API / Backend (`booli/transport.ts`, `booli/client.ts`) | — | Apify actor call config; purely a backend concern, no client visibility |
| Atomic slice claim / no-double-spend | Database (Postgres RPC `claim_discovery_slice`) | API / Backend (calls the RPC) | The `FOR UPDATE SKIP LOCKED` guarantee can only be enforced at the DB layer; the app layer merely invokes it correctly |
| Soft-notice / absolute-ceiling timeout UX | Browser / Client (`discovery-progress.tsx`) | — | Pure client-side `setTimeout` state machine; no server involvement |
| Status → Swedish label mapping | Browser / Client (`discovery-progress.tsx`'s `STATUS_LABELS`) | — | Presentation-only; the status vocabulary itself is set server-side but the label table lives in the client component |
| Orphan-resume recovery (sweep cron) | API / Backend (`/api/discovery/sweep/route.ts`) | Database (same RPC) | Secondary safety net, not the primary driver — must stay compatible with any status/label changes but needs no new logic this phase |

## Standard Stack

No new libraries. This phase is a targeted fix inside existing, already-adopted primitives:

| Primitive | Already used at | Reused for |
|-----------|-----------------|------------|
| `Promise.allSettled` | `src/lib/booli/client.ts:720` (pages 2–5 within one area) | Areas within one slice (D-01) — same aggregation shape, one level up |
| Apify actor `.call()` config (`waitSecs`, `maxRequestRetries`) | `src/lib/booli/transport.ts:62–80` | Adding a second, lower-value override path for area-page rungs (D-02) |
| `claim_discovery_slice` RPC (`FOR UPDATE SKIP LOCKED`) | `supabase/migrations/010_discovery_jobs.sql` | Unchanged — already provides the race-free guarantee D-03 requires |
| `setTimeout`/`setInterval` poll loop | `src/components/discovery-progress.tsx` | Split into a soft-threshold timer (non-failing) + an absolute-ceiling timer (real fail), instead of one `MAX_POLL_MS` timer |

**Installation:** none — no `npm install` needed for this phase.

## Package Legitimacy Audit

Not applicable — this phase introduces zero new external packages. No slopcheck/registry verification is required.

## Architecture Patterns

### System Architecture Diagram

```
Client poll (1.5s interval, discovery-progress.tsx)
  │
  ├─► tickDiscovery(jobId)  [Server Action, tick-discovery.ts]
  │     │
  │     ├─► auth + IDOR ownership pre-check (SELECT user_id)
  │     ├─► claim_discovery_slice RPC  ── DB: FOR UPDATE SKIP LOCKED ──►
  │     │     zero rows returned  → benign no-op, return
  │     │     one row returned    → status flipped to 'processing', claimed_at=now()
  │     │
  │     ├─► runSlice(claimedRow)                       [job.ts]
  │     │     1. incremental cap gate (read from claimedRow only)
  │     │     2. resolve each area name → areaId (splitAreaQuery, cap 4)
  │     │     3. cost pre-check for ALL areas' renders (before any network call)
  │     │     4. ◄── THIS PHASE'S FIX ──►
  │     │        Promise.allSettled( areaIds.map(fetchAreaListings) )
  │     │          ├─ area A: fetchAreaPage(1) seq → allSettled(pages 2..5)
  │     │          ├─ area B: fetchAreaPage(1) seq → allSettled(pages 2..5)
  │     │          └─ area C/D: same shape, all running CONCURRENTLY now
  │     │     5. merge + dedupe candidates across ALL areas
  │     │     6. ONE terminal UPDATE (results, counters, status) ─────► DB
  │     │
  │     └─► claimAndRunVisionForJob(jobId)  [separate CAS: done → vision_processing]
  │
  └─► SELECT status, processed_count, ... FROM discovery_jobs WHERE id=jobId
        │
        ├─ status in {pending, processing, vision_processing} → still running
        │    elapsed < SOFT_THRESHOLD_MS  → normal "{n} av {total}" copy
        │    elapsed ≥ SOFT_THRESHOLD_MS  → "Det tar längre tid än väntat, fortsätter…" (D-04, non-failing)
        │    elapsed ≥ ABSOLUTE_CEILING_MS → real timeout, onComplete("failed") (D-05)
        │
        └─ status in {done, failed, degraded} → terminal, stop poll+tick, onComplete(status)
```

### Area parallelism fits inside one slice (the critical question, resolved)

**Question posed:** does area parallelism require advancing multiple slices per tick, or a different slice granularity?

**Answer: no — it fits entirely within the existing single-slice-per-tick contract.** Evidence:

1. `runSlice` receives `claimedRow` once (the `RETURNING` clause of `claim_discovery_slice`) and never re-reads the row mid-function (job.ts's own "Pitfall 4" doc comment, lines 26–31). All accounting — `candidate_count`, `cost_sek_total`, `processed_count` — is computed from this frozen snapshot plus whatever the current invocation just fetched.
2. The area loop (job.ts:178–191) is pure in-memory aggregation (`raw.push(...part)`, `anyThrew` flag) — it touches the database **zero times** until step 6's single `UPDATE`. Changing the loop from sequential `for...of` to `Promise.allSettled` changes nothing about when or how many times the DB is written.
3. The thing that actually prevents two concurrent `runSlice` executions on the *same job* is `claim_discovery_slice`'s row-level claim: once a row is `status='processing'` with a fresh `claimed_at`, a second `claim_discovery_slice(p_job_id)` call finds zero claimable rows (`status in ('pending','processing') AND (status='pending' OR claimed_at stale)`) and returns nothing — a benign no-op. This guarantee is completely orthogonal to what happens *inside* one already-won claim's execution.

**Conclusion:** parallelizing the area loop is a pure refactor of step 4's control flow, containable to `job.ts`. It does not touch `tick-discovery.ts`, the RPC, or the claim/slice contract at all. D-03 (race-free cost caps) is preserved automatically because the caps are only ever checked/written from `claimedRow` + one final `UPDATE`, never per-area.

**Recommended implementation shape** (mirrors `fetchAreaListings`'s own pattern at `booli/client.ts:719–730` almost verbatim):

```typescript
// BEFORE (job.ts:178-191, current sequential loop):
const raw: Record<string, unknown>[] = [];
let anyThrew = false;
let rendersUsed = 0;
for (const areaId of areaIds) {
  try {
    const part = await fetchAreaListings(areaId, filters.objectType);
    rendersUsed += 1;
    raw.push(...part);
  } catch (error) {
    anyThrew = true;
    console.error("[discovery-job] kill-switch degraded", { jobId, areaId, code: ... });
  }
}

// AFTER (Promise.allSettled — same aggregation semantics, concurrent execution):
const settled = await Promise.allSettled(
  areaIds.map((areaId) => fetchAreaListings(areaId, filters.objectType)),
);
const raw: Record<string, unknown>[] = [];
let anyThrew = false;
let rendersUsed = 0;
for (let i = 0; i < settled.length; i++) {
  const outcome = settled[i];
  if (outcome.status === "fulfilled") {
    rendersUsed += 1;
    raw.push(...outcome.value);
  } else {
    anyThrew = true;
    console.error("[discovery-job] kill-switch degraded", {
      jobId, areaId: areaIds[i],
      code: outcome.reason instanceof Error ? outcome.reason.message : "UNKNOWN",
    });
  }
}
```

This preserves every existing behavior the current test suite (`job.test.ts`'s "multi-area search" `describe` block, lines 348–441) asserts: call count, call args (order-independent matchers already used — `toHaveBeenCalledWith` per area, not positional), partial-failure survival, degrade-only-on-all-throw, and per-successful-area render billing. Those tests should require no logic changes, only (optionally) an added assertion proving concurrency (see Validation Architecture).

### Complete status vocabulary (D-07, resolved)

Grepped exhaustively across `src/lib/discovery/`, `src/actions/`, `src/app/api/discovery/`, and the only DDL that touches this column (`010_discovery_jobs.sql`, a bare `text` column with **no check constraint** — "a new status word never needs DDL"). The full, closed set of values a `discovery_jobs.status` can hold is exactly six:

| Status | Set by | Terminal? | Current label |
|--------|--------|-----------|----------------|
| `pending` | table default | no | "I kö" ✓ |
| `processing` | `claim_discovery_slice` RPC | no | "Analyserar" ✓ |
| `vision_processing` | `claimVisionSlice`'s CAS (`job.ts:281`) | no | **MISSING** — falls through to raw string via `?? status` |
| `done` | `runSlice`, `runVisionForJob`, sweep recovery | yes | "Klar" ✓ |
| `failed` | `runSlice` (area resolution failure) | yes | "Misslyckades" ✓ |
| `degraded` | `runSlice` (kill-switch, all areas threw) | yes | "Avbruten" ✓ |

Only `vision_processing` is missing from `STATUS_LABELS` (confirms CONTEXT.md's D-06/D-07 framing exactly). No 7th status exists anywhere in the codebase — the audit is complete, not partial.

### `discovery-progress-live.tsx` needs no changes

Read in full: it is a 31-line pure wrapper that renders `<DiscoveryProgress>` with `onComplete={() => router.refresh()}`. It defines no `STATUS_LABELS`, no timeout constant, no polling logic of its own — every byte of the timeout/label fix lives in `discovery-progress.tsx` and is inherited automatically. **Resolves the Claude's Discretion question**: no parallel edit needed in the live variant.

### Recommended timeout state machine (D-04/D-05)

Two independent `setTimeout`s replace the current single `MAX_POLL_MS` one:

```typescript
const SOFT_THRESHOLD_MS = /* planner's discretion, e.g. 90_000 */;
const ABSOLUTE_CEILING_MS = /* planner's discretion, well above current 5*60_000 */;

const softTimeout = setTimeout(() => {
  if (!active) return;
  setSlow(true); // renders "Det tar längre tid än väntat, fortsätter…" — NOT terminal
  // deliberately does NOT clearInterval, does NOT call onComplete
}, SOFT_THRESHOLD_MS);

const hardTimeout = setTimeout(() => {
  if (!active) return;
  active = false;
  clearInterval(interval);
  setTimedOut(true);
  onComplete?.("failed"); // the ONLY place a real failure surfaces from the client side
}, ABSOLUTE_CEILING_MS);
```

The existing `poll()` function's terminal-status branch (`TERMINAL_STATUSES.has(next)`) already clears both timeouts on success — no change needed there. `setSlow`/the soft-notice banner must be reset to `false` if a later poll finds a terminal status before the soft threshold ever fires (defensive; the terminal branch already runs first in the same tick if it wins the race).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Area-level concurrency | A custom worker pool / queue for area fetches | `Promise.allSettled(areaIds.map(fetchAreaListings))` | Identical shape already proven at the page level one file over; zero new abstractions |
| Preventing double-spend under concurrent area fetches | A new lock/mutex around the cost counters | Nothing new — `runSlice`'s existing "read from claimedRow, write once at the end" discipline already makes this race-free | The claim RPC is the only lock that matters; per-area writes never happen today and must not be introduced |
| Bounding per-render worst-case time | A custom timeout wrapper around `runPlaywrightRender` | The Apify actor's own `waitSecs` input (already the real ceiling) — add a second, lower override value scoped to area-page rungs | `waitSecs` already IS the timeout primitive; a second `Promise.race`/`AbortController` layer would fight the actor's own run lifecycle and complicate the HIGH-1 "throw not []" contract |
| Progress timeout UX | A generic "loading state machine" library | Two plain `setTimeout`s (mirrors the existing single-timeout code exactly, just split in two) | The component is 31 lines of hand-rolled but simple, well-tested state already; no library reduces the complexity here |

**Key insight:** every lever this phase needs already exists in the codebase in a working, tested form one abstraction level away (page parallelism, actor wait config, claim RPC, timeout state). The entire phase is "apply the existing pattern one level up / add a second instance of an existing config knob" — there is no green-field design here, and any plan that introduces a genuinely new concurrency primitive should be treated as a red flag.

## Common Pitfalls

### Pitfall 1: `Promise.allSettled` alone does not bound wall-clock time
**What goes wrong:** Parallelizing areas reduces total time from `sum(area times)` to `max(area times)` — but if any single area's `fetchAreaListings` call itself takes up to ~480s in the worst case (page 1 sequential, up to 2 rungs × 240s `waitSecs` each), the WHOLE tick still takes up to 480s even with perfect area concurrency. `Promise.allSettled` has no timeout of its own; it waits for every promise to settle regardless of how long the slowest one takes.
**Why it happens:** D-01 and D-02 solve different axes of the same problem — D-01 collapses N areas into 1 area's worst-case time; D-02 must independently cap what that 1 area's worst-case time even is.
**How to avoid:** Ship D-01 and D-02 together, not D-01 alone. Verify with a live smoke on a genuinely large multi-area query (not just unit tests with instant mocks) before considering DXUX-01 done.
**Warning signs:** A plan that treats D-02 as "nice to have" or defers it to a later phase.

### Pitfall 2: A killed Vercel Server Action silently adds a 5-minute stall
**What goes wrong:** `TICK_DISCOVERY_MAX_DURATION_SEC = 300` documents (does not enforce, per the Next.js Server Actions bundler constraint) that Vercel will kill a Server Action invocation at ~300s. If a tick's `runSlice` call is still running an area fetch past that point, the platform kills the whole request — but the row is left at `status='processing'` with a `claimed_at` set moments ago. `claim_discovery_slice`'s own stale-reclaim window (`p_stale_ms`, default 300000ms = 5 min) means NO other tick (next client poll, or the daily sweep) can reclaim this row until that stale window elapses.
**Why it happens:** The stale-reclaim window and the platform kill ceiling are numerically the same (5 min / 300s) by convention, not by any enforced relationship — a tick that runs even slightly past 300s can hit exactly this gap.
**How to avoid:** Keep worst-case per-tick duration comfortably under 300s via D-02's lowered per-page wait ceiling (e.g., area-page renders capped well below the 240s detail-page value). Do not treat "the tick usually finishes fast" as sufficient — the pathological case is what causes user-visible stalls.
**Warning signs:** A plan that lowers `MAX_POLL_MS`/adds soft-notice UX but never touches `waitSecs`/`maxRequestRetries` for area pages — this masks the symptom without fixing the underlying worst-case duration.

### Pitfall 3: Global `waitSecs`/`maxRequestRetries` changes regress the proven detail-page path
**What goes wrong:** `runPlaywrightRender` in `transport.ts` is the ONE shared transport for single-listing detail fetches (`fetchListing`), area-page fetches (`fetchAreaPage`), AND broker enrichment fetches. Its doc comments explicitly warn: `maxRequestRetries: 3` was raised from 1 because a single retry budget produced a real false negative in production, and `waitSecs: 240` accounts for genuine Apify cold-start latency. Lowering these globally to fix area-page latency risks reintroducing the exact false-negative/premature-timeout bugs those values were raised to fix — for single-listing analysis, which is NOT in this phase's scope.
**Why it happens:** The transport function currently takes no per-call override for these values; the tempting minimal-diff fix is to just lower the constants in place.
**How to avoid:** Add an optional parameter (e.g., `runPlaywrightRender(url, pageFunction, opts?: { waitSecs?: number; maxRequestRetries?: number })`) that defaults to the existing proven values (240/3) so every EXISTING call site (detail fetch, broker fetch) is byte-for-byte unchanged, and only `fetchAreaPage`'s call sites pass a lower override.
**Warning signs:** A diff that touches the literal `240`/`3` constants in `transport.ts` directly, rather than adding a scoped override parameter.

### Pitfall 4: Test call-order assumptions silently baked into mocks
**What goes wrong:** `job.test.ts`'s existing multi-area tests already use order-independent assertions (`toHaveBeenCalledWith` per area, not `toHaveBeenNthCalledWith`), so they should keep passing once the loop becomes `Promise.allSettled`. But a new test asserting the two areas ran CONCURRENTLY (not just that both were called) needs care: `vi.fn().mockImplementation(async () => ...)` with synchronous mock resolution proves nothing about concurrency — a test must introduce artificial staggered delays (e.g., one mock resolves after 50ms, the other after 10ms) and assert total elapsed time is close to `max(50,10)`, not `50+10`, to actually prove the fix.
**Why it happens:** Unit tests with instantly-resolving mocks cannot distinguish sequential-await-in-a-loop from `Promise.allSettled` — both produce identical call counts and identical final state.
**How to avoid:** Add at least one explicit timing-based test (fake timers or real staggered `setTimeout`-based mocks) asserting concurrent execution, not just correct aggregation.
**Warning signs:** A plan whose only "proof" of D-01 is the existing multi-area describe block passing unchanged — that block would pass identically whether or not the fix was actually applied.

### Pitfall 5: A false "soft-notice reset" bug — forgetting to clear `slow` state on late-arriving terminal status
**What goes wrong:** If `setSlow(true)` fires from the soft timeout right as (or just before) a poll() call discovers a terminal status, the component could theoretically render the "tar längre tid" banner for one frame even though the job is already done, or (worse) leave `slow` stuck true after `onComplete` fires and the component unmounts into a different tree state (e.g., if `DiscoveryProgressLive`'s `router.refresh()` doesn't immediately unmount `DiscoveryProgress`).
**Why it happens:** Two independent timers (soft + hard) plus the existing poll-driven terminal-status branch means three code paths that all mutate overlapping UI state.
**How to avoid:** Make the terminal-status branch inside `poll()` the single source of truth: it should clear BOTH timeouts (already does for the old single one) so once a terminal status is observed, neither soft nor hard timer can fire afterward, regardless of race.

## Code Examples

### 1. Area-loop parallelization (job.ts)
See Architecture Patterns §"Area parallelism fits inside one slice" above for the full before/after — reproduced there rather than duplicated here since it is the load-bearing example for this phase.

### 2. Scoped `waitSecs` override (transport.ts / client.ts)

```typescript
// transport.ts — add an optional override, default preserves existing behavior:
export async function runPlaywrightRender(
  url: string,
  pageFunction: string,
  opts?: { waitSecs?: number; maxRequestRetries?: number },
): Promise<unknown[]> {
  const waitSecs = opts?.waitSecs ?? 240;
  const maxRequestRetries = opts?.maxRequestRetries ?? 3;
  // ... unchanged body, using `waitSecs`/`maxRequestRetries` in place of the
  // literals at the two call sites (`{ waitSecs }` passed as the 2nd .call() arg,
  // `maxRequestRetries` inside the actor input object).
}

// client.ts — fetchAreaPage passes the lower override; fetchListing (detail
// fetches) and broker-images.ts pass nothing, keeping their proven 240/3 values:
async function fetchAreaPage(areaId, objectType, page) {
  const url = buildTillSaluUrl(areaId, objectType, page);
  const AREA_PAGE_WAIT_SECS = /* planner's discretion, materially < 240 */;
  const rungs = [
    { source: "own-playwright" as const,
      attempt: () => runPlaywrightRender(url, APOLLO_PAGE_FUNCTION, { waitSecs: AREA_PAGE_WAIT_SECS })
        .then(extractListingEntities) },
    { source: "own-playwright-retry" as const,
      attempt: () => runPlaywrightRender(url, APOLLO_PAGE_FUNCTION, { waitSecs: AREA_PAGE_WAIT_SECS })
        .then(extractListingEntities) },
  ];
  // ... unchanged
}
```

### 3. Bounding retries specifically for non-page-1 renders (optional secondary tactic)

Page 1 of each area is the sequential gate whose failure IS the kill-switch/degrade signal — it should keep full resilience (240/3). Pages 2..5 already tolerate individual failure via `allSettled` (a lost page just means fewer listings, not a failed job) — these are the safest candidates for a lower `waitSecs` AND a lower retry budget, since the cost of being wrong (missing one page's ~36 listings) is much lower than the cost of being wrong on page 1 (failing the whole area).

### 4. `STATUS_LABELS` completeness (discovery-progress.tsx)

```typescript
const STATUS_LABELS: Record<string, string> = {
  pending: "I kö",
  processing: "Analyserar",
  vision_processing: "Analyserar bilder", // D-06 — the only currently-missing entry
  done: "Klar",
  failed: "Misslyckades",
  degraded: "Avbruten",
};

// Recommended: a co-located exhaustiveness guard so a future new status word
// (the migration's own "no check constraint, new words need no DDL" design)
// can't silently regress this completeness invariant:
const KNOWN_STATUSES = ["pending", "processing", "vision_processing", "done", "failed", "degraded"] as const;
// (test-only) assert every KNOWN_STATUSES entry has a STATUS_LABELS key.
```

## State of the Art

| Old Approach | Current/Recommended Approach | When Changed | Impact |
|--------------|------------------------------|---------------|--------|
| Areas scraped sequentially in `runSlice` | Areas scraped via `Promise.allSettled`, mirroring the existing page-parallel pattern | This phase | Collapses `sum(area times)` to `max(area times)` for multi-area queries (up to 4 areas per `MAX_AREAS_PER_SEARCH`) |
| Global 240s/3-retries `waitSecs`/`maxRequestRetries` for every Booli render | Same defaults preserved for detail/broker fetches; a lower, scoped override for area-page fetches only | This phase | Bounds worst-case per-tick duration without touching the proven detail-page reliability |
| Single `MAX_POLL_MS` (5 min) hard-fail | Two-tier: soft non-failing notice + a generous absolute ceiling | This phase | Eliminates the false "Misslyckades" for jobs the server will complete; a genuinely dead server still eventually surfaces a real failure |
| `STATUS_LABELS` missing `vision_processing` | Complete 6-entry table matching the full status vocabulary | This phase | No raw enum string ("vision_processing") ever reaches the badge |

**Deprecated/outdated:** none — this is a bug fix within an already-current architecture, not a migration away from an old pattern.

## Assumptions Log

No claims in this research required external verification (Context7/WebSearch) — every factual claim is a direct, grep/read-confirmed observation of this repository's own source at research time (2026-07-18). There is nothing to tag `[ASSUMED]`.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| — | (none) | — | — |

**This table is empty:** all claims in this research were verified directly against the codebase — no user confirmation needed on factual grounds. (The exact millisecond values for `SOFT_THRESHOLD_MS`/`ABSOLUTE_CEILING_MS`/`AREA_PAGE_WAIT_SECS` are explicitly left to the planner's discretion per CONTEXT.md, not asserted as fact here.)

## Open Questions

1. **Exact `AREA_PAGE_WAIT_SECS` / retry-budget values for D-02**
   - What we know: current global value is 240s wait / 3 retries; RESUME.md observed real-world stalls of ~180s from a single slow page; the hard ceiling to stay under is the ~300s Vercel Server Action limit, shared across up to 4 concurrent areas each potentially doing page1 + a parallel pages-2-5 batch.
   - What's unclear: the actual live latency distribution of Booli area-page renders (no timing telemetry exists in the codebase today) — a too-low value risks false "blocked" kill-switch triggers on legitimately slow-but-real Apify cold starts.
   - Recommendation: pick a conservative first value (e.g., 90–120s) and instrument the existing `[booli-client] fetchAreaListings page N served by rung...` log line (already present) to observe real timing before tightening further; treat as a tunable constant, not a one-shot decision.

2. **Exact `SOFT_THRESHOLD_MS` / `ABSOLUTE_CEILING_MS` values for D-04/D-05**
   - What we know: current single ceiling is 5 min; D-01+D-02 should make the typical case finish well under that; D-05 wants "well above" 5 min for the absolute ceiling.
   - What's unclear: no data yet on typical post-fix completion time for a genuinely large (300+ listing, 4-area) query with vision enrichment included (vision runs as a SEPARATE post-scrape pass via `claimAndRunVisionForJob`, adding further wall-clock after the scrape itself completes — the client's poll loop must keep ticking through BOTH phases, which it already does since `tickDiscovery` calls both unconditionally each tick).
   - Recommendation: a live smoke run (per the phase's likely verification step) on the "Renoveringsobjekt i Södermalm och Vasastan under 4 miljoner" query (the same one RESUME.md already used to validate the area-search overhaul) will give a real number to calibrate both thresholds against before locking them in the plan.

## Environment Availability

No new external dependency is introduced by this phase. `APIFY_API_TOKEN`, Supabase (client + service-role for the sweep route), and `DISCOVERY_ENABLED` are already required and already live in production per STATE.md ("the discovery surface is live on `main` and `DISCOVERY_ENABLED` is ON"). Nothing to newly provision.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (existing) |
| Config file | `vitest.config.ts` |
| Quick run command | `npx vitest run src/lib/discovery/job.test.ts src/components/discovery-progress.test.tsx` |
| Full suite command | `npm run test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DXUX-01 | Areas fetched concurrently, not sequentially (timing proof) | unit (fake/staggered timers) | `npx vitest run src/lib/discovery/job.test.ts -t "multi-area"` | ❌ Wave 0 — extend existing `describe("runSlice — multi-area search")` block with a new timing-based test |
| DXUX-01 | Existing multi-area aggregation/partial-failure/degrade semantics unchanged after the loop→allSettled refactor | unit | `npx vitest run src/lib/discovery/job.test.ts` | ✅ (lines 348–441, should pass unmodified) |
| DXUX-01 | `claim_discovery_slice` still serializes concurrent claims (D-03 race-free invariant, unaffected by this phase but must be re-run as a regression check) | integration (real Postgres, gated) | `RUN_DB_INTEGRATION=1 SUPABASE_SERVICE_ROLE_KEY=<key> npx vitest run src/lib/discovery/job.integration.test.ts` | ✅ (already exists, no code changes expected here) |
| DXUX-01 | Area-page render respects a lower `waitSecs` override without regressing detail-page fetches | unit | `npx vitest run src/lib/booli/client.test.ts` | ❌ Wave 0 — add assertion that `fetchAreaPage`'s `runPlaywrightRender` calls pass the scoped override while `fetchListing`'s calls pass none/defaults |
| DXUX-01 | Soft-notice shows without calling `onComplete("failed")`; polling continues past the old 5-min mark | component (RTL + fake timers) | `npx vitest run src/components/discovery-progress.test.tsx` | ❌ Wave 0 — replace/extend the existing timeout test (mirrors the removed `timedOut` hard-fail test) |
| DXUX-01 | Absolute ceiling still surfaces a real failure for a genuinely stuck job | component (RTL + fake timers) | `npx vitest run src/components/discovery-progress.test.tsx` | ❌ Wave 0 — new test advancing fake timers past the new, larger absolute ceiling |
| DXUX-02 | Every known status string has a `STATUS_LABELS` entry (no raw-string fallback reachable) | unit | `npx vitest run src/components/discovery-progress.test.tsx` | ❌ Wave 0 — add an exhaustiveness test enumerating the 6 known statuses |
| DXUX-02 | `vision_processing` renders "Analyserar bilder" in the live badge | component (RTL) | `npx vitest run src/components/discovery-progress.test.tsx` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run src/lib/discovery/job.test.ts src/components/discovery-progress.test.tsx src/lib/booli/client.test.ts`
- **Per wave merge:** `npm run test` (full suite; the DB-gated integration test self-skips without `RUN_DB_INTEGRATION=1`, zero cost in CI)
- **Phase gate:** Full suite green, PLUS one live manual smoke on a real large multi-area query (the same query RESUME.md already validated the area-search overhaul against) before `/gsd-verify-work` — this is the only way to observe real completion timing to sanity-check the chosen threshold constants (see Open Questions #1/#2). This mirrors the project's established "mocked tests hide it, run one live smoke" discipline (see `anthropic-structured-output-limits` memory) applied to timing rather than to schema shape.

### Wave 0 Gaps
- [ ] Timing-based concurrency proof test in `job.test.ts` (staggered mock delays, assert elapsed ≈ max not sum) — covers DXUX-01
- [ ] `client.test.ts` assertion that area-page rungs pass a scoped `waitSecs` override, detail/broker fetches do not — covers DXUX-01
- [ ] `discovery-progress.test.tsx`: replace the hard-fail timeout test with soft-notice (non-failing, keeps polling) + absolute-ceiling (real fail) tests — covers DXUX-01
- [ ] `discovery-progress.test.tsx`: exhaustiveness test over the 6 known status strings against `STATUS_LABELS` — covers DXUX-02
- [ ] Framework install: none — Vitest, RTL, and fake-timer utilities are all already present in the repo (`discovery-progress.test.tsx` already uses fake timers per its existing "skips an overlapping poll" test)

## Security Domain

This phase's config does not set `security_enforcement: false`, so this section is included per policy — but the phase's actual security surface is minimal: no new inputs, no new auth boundary, no new persisted data shape.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Unchanged — `tickDiscovery` already gates on `supabase.auth.getUser()` |
| V3 Session Management | no | No session-touching change |
| V4 Access Control | yes (regression-only) | The existing IDOR ownership pre-check (`tickDiscovery`, `row.user_id !== user.id`) and RLS policies on `discovery_jobs` must remain untouched by this phase's refactor — verify the plan does not move any area-fetch logic to a code path that bypasses this check |
| V5 Input Validation | no | No new user input surface (area names/filters are already validated upstream in `startDiscovery`, out of this phase's scope) |
| V6 Cryptography | no | N/A |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Concurrent-request double-spend on shared cost/candidate caps | Tampering (via race, not malicious input) | Already mitigated by `claim_discovery_slice`'s atomic row claim — this phase must not introduce any per-area DB write that reopens the check-then-act window `runSlice`'s "read from claimedRow, write once" discipline exists to prevent |
| Cost-DoS via unbounded concurrent Apify renders | Denial of Service (cost exhaustion) | The cost pre-check (step 3, job.ts:161–167) already estimates ALL area renders' cost BEFORE any network call — this must remain a synchronous check that happens before `Promise.allSettled` is invoked, not something reordered to run per-area after fetches begin |

## Sources

### Primary (HIGH confidence — direct source reads, this session, 2026-07-18)
- `src/components/discovery-progress.tsx` — full read (timeout, STATUS_LABELS, poll/tick loop)
- `src/components/discovery-progress-live.tsx` — full read (confirmed thin wrapper, no independent state)
- `src/lib/discovery/job.ts` — full read (`runSlice`, vision claim/run, enrichment)
- `src/actions/tick-discovery.ts` — full read (claim → runSlice → vision composition)
- `src/lib/discovery/cost.ts` — full read (cap accounting model)
- `src/app/api/discovery/sweep/route.ts` — full read (orphan-resume, vision-wedge recovery)
- `src/lib/booli/client.ts` (lines 580–730) — `fetchAreaListings`/`fetchAreaPage` page-parallel pattern, `MAX_AREA_PAGES`
- `src/lib/booli/transport.ts` — full read (`runPlaywrightRender`, `waitSecs`/`maxRequestRetries`)
- `src/lib/booli/page-functions.ts`, `src/lib/booli/fallback-tree.ts` — full read (rung model)
- `src/lib/discovery/resolve-area.ts` (grep) — `MAX_AREAS_PER_SEARCH = 4`
- `src/lib/discovery/tick-config.ts` — full read (`TICK_DISCOVERY_MAX_DURATION_SEC = 300`)
- `supabase/migrations/010_discovery_jobs.sql` — full read (status vocabulary, `claim_discovery_slice` RPC definition)
- `src/lib/discovery/job.test.ts` (lines 135–441) and `job.integration.test.ts` (lines 1–45) — existing test coverage/patterns
- `src/components/discovery-progress.test.tsx` (grep of `describe`/`it` titles) — existing component test coverage
- Grep across `src/` confirming NO literal `networkidle` constant exists anywhere in the codebase
- `.planning/phases/13-discovery-ux-poll-timeout-fix/13-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md`, `RESUME.md` — phase scope and root-cause narrative

### Secondary (MEDIUM confidence)
- None used — this phase required no external library research.

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries; every primitive cited was read directly from this repo's source
- Architecture: HIGH — the slice/claim/concurrency model was traced end-to-end through actual source, including the specific line ranges where the sequential loop and the page-parallel pattern live
- Pitfalls: HIGH for the technical ones (Vercel ceiling interaction, global-vs-scoped timeout regression risk) since these follow directly from documented constants already in the code; MEDIUM for the exact tunable values (explicitly flagged as Open Questions, not asserted as fact)

**Research date:** 2026-07-18
**Valid until:** 30 days (stable internal architecture; no external-dependency drift risk since no new packages are introduced)
