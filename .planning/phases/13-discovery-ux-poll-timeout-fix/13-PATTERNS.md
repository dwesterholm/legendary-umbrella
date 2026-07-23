# Phase 13: Discovery UX / Poll-Timeout Fix - Pattern Map

**Mapped:** 2026-07-18
**Files analyzed:** 4 (all modified, none new)
**Analogs found:** 4 / 4 (all analogs are IN the same file being modified, or a sibling file already read as canonical reference — this is a bug-fix phase with zero greenfield files)

## File Classification

| Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---------------|------|-----------|-----------------|----------------|
| `src/lib/discovery/job.ts` (`runSlice` area loop, lines 175-191) | service (orchestration) | batch / event-driven | `src/lib/booli/client.ts` `fetchAreaListings` pages-2..N loop (lines 719-736) | exact — same aggregation shape one level down, in the same codebase family |
| `src/lib/booli/transport.ts` (`runPlaywrightRender`, lines 57-113) | service (transport wrapper) | request-response | itself — extend signature with optional `opts` param; sibling precedent: `walkFallbackTree`'s rung-attempt closures already thread config per-call | role-match (self-extension) |
| `src/lib/booli/client.ts` (`fetchAreaPage`, lines 663-686) | service (transport call-site) | request-response | itself — add a second call-site variant that passes `opts` to `runPlaywrightRender`; `fetchListing`'s call-sites (lines 526, 531) are the "leave unchanged" analog proving the override must be additive-only | exact |
| `src/components/discovery-progress.tsx` (`STATUS_LABELS` + timeout `useEffect`, lines 36-146) | component (client poll/tick state machine) | event-driven (polling state machine) | `src/components/brf-progress.tsx` (`BrfProgress` — explicitly named in this file's own doc comment, line 55, as the model this component was built from) | exact — same author-declared analog |

## Pattern Assignments

### `src/lib/discovery/job.ts` — area-loop parallelization (D-01)

**Analog:** `src/lib/booli/client.ts:719-736` (`fetchAreaListings`'s existing pages-2..N `Promise.allSettled` block)

**Current sequential loop to replace** (`job.ts:175-191`):
```typescript
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
    console.error("[discovery-job] kill-switch degraded", {
      jobId,
      areaId,
      code: error instanceof Error ? error.message : "UNKNOWN",
    });
  }
}
```

**Analog to mirror verbatim** (`client.ts:719-736`, the proven pattern one level down — pages within an area):
```typescript
const settled = await Promise.allSettled(
  laterPages.map((page) => fetchAreaPage(areaId, objectType, page)),
);
for (let i = 0; i < settled.length; i++) {
  const outcome = settled[i];
  if (outcome.status === "fulfilled") {
    addNew(outcome.value);
  } else {
    console.error(
      `[booli-client] fetchAreaListings page ${laterPages[i]} failed (non-fatal; keeping ${collected.length} listings)`,
      { code: outcome.reason instanceof Error ? outcome.reason.name : "UNKNOWN" },
    );
  }
}
```

**Target shape for job.ts** (same aggregation semantics — fulfilled → push/count, rejected → set flag + log — just at the area level instead of the page level):
```typescript
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
      jobId,
      areaId: areaIds[i],
      code: outcome.reason instanceof Error ? outcome.reason.message : "UNKNOWN",
    });
  }
}
```

**Error handling pattern:** identical to the analog — `outcome.status === "fulfilled"` vs the `else` branch; log via `console.error` with a structured object (`jobId`/`areaId`/`code`), never rethrow. The existing kill-switch decision below the loop (`if (raw.length === 0) { status: anyThrew ? "degraded" : "done" }`, `job.ts:192-195`) is UNCHANGED — it already reads `raw`/`anyThrew` generically, not the loop shape.

**Invariant to preserve (D-03):** the cost pre-check at `job.ts:161-167` runs BEFORE this loop and reads only `claimedRow` fields (`cost_sek_total`, `cap_sek`) — do not move it after or make it per-area. The loop remains pure in-memory aggregation; the ONE terminal `updateJob(...)` call stays after the loop, unchanged in position.

---

### `src/lib/booli/transport.ts` — scoped `waitSecs`/`maxRequestRetries` override (D-02)

**Analog:** itself (additive signature change) — the guiding constraint is `client.ts`'s existing `fetchListing` call-sites (lines 526, 531), which must NOT change, proving any new parameter must be optional with a default equal to the current literal.

**Current signature and call site to extend** (`transport.ts:57-80`):
```typescript
export async function runPlaywrightRender(
  url: string,
  pageFunction: string,
): Promise<unknown[]> {
  try {
    const run = await client.actor(PLAYWRIGHT_SCRAPER_ACTOR).call(
      {
        startUrls: [{ url }],
        launcher: "chromium",
        proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"], apifyProxyCountry: "SE" },
        maxRequestRetries: 3,
        maxPagesPerCrawl: 1,
        pageFunction,
      },
      { waitSecs: 240 },
    );
```

**Target shape** (optional `opts`, default preserves the exact existing literals — the doc comment's own warning at lines 17-23 not to "clean up" these values must stay true for every call site EXCEPT the new area-page one):
```typescript
export async function runPlaywrightRender(
  url: string,
  pageFunction: string,
  opts?: { waitSecs?: number; maxRequestRetries?: number },
): Promise<unknown[]> {
  const waitSecs = opts?.waitSecs ?? 240;
  const maxRequestRetries = opts?.maxRequestRetries ?? 3;
  try {
    const run = await client.actor(PLAYWRIGHT_SCRAPER_ACTOR).call(
      {
        startUrls: [{ url }],
        launcher: "chromium",
        proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"], apifyProxyCountry: "SE" },
        maxRequestRetries,
        maxPagesPerCrawl: 1,
        pageFunction,
      },
      { waitSecs },
    );
```

**Error handling pattern:** unchanged — the existing catch block (`transport.ts:105-112`) already logs via `console.error("[booli-transport]", error)` then throws a fixed Swedish user-facing message. No new error path needed; the override only affects the actor-call config object.

**Call sites that must stay byte-for-byte unchanged (regression guard):** `client.ts:526,531` (`fetchListing`'s two rungs) and `client.ts:891,895` (sold-comps rungs) — pass no `opts`, inheriting the 240/3 defaults.

---

### `src/lib/booli/client.ts` — `fetchAreaPage` scoped override call-site (D-02)

**Analog:** itself, lines 663-686 (`fetchAreaPage`) — modify only this function's two `runPlaywrightRender` calls (lines 673, 678) to pass the new lower `waitSecs`; leave `fetchListing` (lines 526, 531) untouched as the "proven, don't regress" reference.

**Current call site** (`client.ts:670-680`):
```typescript
const rungs = [
  {
    source: "own-playwright" as const,
    attempt: () =>
      runPlaywrightRender(url, APOLLO_PAGE_FUNCTION).then(extractListingEntities),
  },
  {
    source: "own-playwright-retry" as const,
    attempt: () =>
      runPlaywrightRender(url, APOLLO_PAGE_FUNCTION).then(extractListingEntities),
  },
];
```

**Target shape** (add a scoped constant near the top of `client.ts`, pass via `opts`):
```typescript
const AREA_PAGE_WAIT_SECS = 120; // planner's discretion per RESEARCH.md Open Question #1 — start conservative, instrument the existing rung log line to tighten later

const rungs = [
  {
    source: "own-playwright" as const,
    attempt: () =>
      runPlaywrightRender(url, APOLLO_PAGE_FUNCTION, { waitSecs: AREA_PAGE_WAIT_SECS })
        .then(extractListingEntities),
  },
  {
    source: "own-playwright-retry" as const,
    attempt: () =>
      runPlaywrightRender(url, APOLLO_PAGE_FUNCTION, { waitSecs: AREA_PAGE_WAIT_SECS })
        .then(extractListingEntities),
  },
];
```

**Existing log line to keep for calibration** (`client.ts:682-684`, unchanged):
```typescript
console.error(
  `[booli-client] fetchAreaListings page ${page} served by rung ${result.rung} (${result.source}, health=${result.health})`,
);
```

---

### `src/components/discovery-progress.tsx` — two-tier timeout + complete STATUS_LABELS (D-04/D-05/D-06/D-07)

**Analog:** `src/components/brf-progress.tsx` — this file's own doc comment (line 55) names `BrfProgress` as the model its polling skeleton was built from; the divergence is documented at lines 56-58 (this component also calls `tickDiscovery` before reading status).

**Current STATUS_LABELS (incomplete)** (`discovery-progress.tsx:40-46`):
```typescript
const STATUS_LABELS: Record<string, string> = {
  pending: "I kö",
  processing: "Analyserar",
  done: "Klar",
  failed: "Misslyckades",
  degraded: "Avbruten",
};
```

**Target (D-06/D-07 — add the one missing entry, exhaustive over the 6-value vocabulary confirmed in RESEARCH.md's status audit):**
```typescript
const STATUS_LABELS: Record<string, string> = {
  pending: "I kö",
  processing: "Analyserar",
  vision_processing: "Analyserar bilder",
  done: "Klar",
  failed: "Misslyckades",
  degraded: "Avbruten",
};

const KNOWN_STATUSES = ["pending", "processing", "vision_processing", "done", "failed", "degraded"] as const;
```

**Current single hard-fail timeout** (`discovery-progress.tsx:36`, `:133-139`):
```typescript
const MAX_POLL_MS = 5 * 60_000;
...
const timeout = setTimeout(() => {
  if (!active) return;
  active = false;
  clearInterval(interval);
  setTimedOut(true);
  onComplete?.("failed");
}, MAX_POLL_MS);
```

**Target two-tier shape (D-04/D-05)** — replace the single `timedOut` boolean + one `setTimeout` with a `slow` (non-terminal) state plus the existing `timedOut` (terminal) state, using TWO independent timers:
```typescript
const SOFT_THRESHOLD_MS = 90_000; // planner's discretion — RESEARCH.md Open Question #2
const ABSOLUTE_CEILING_MS = 15 * 60_000; // "well above" the old 5-min ceiling, planner's discretion

const softTimeout = setTimeout(() => {
  if (!active) return;
  setSlow(true); // non-terminal — do NOT clearInterval, do NOT call onComplete
}, SOFT_THRESHOLD_MS);

const hardTimeout = setTimeout(() => {
  if (!active) return;
  active = false;
  clearInterval(interval);
  setTimedOut(true);
  onComplete?.("failed");
}, ABSOLUTE_CEILING_MS);
```

**Terminal-status branch must clear BOTH timers** (extend the existing pattern at `discovery-progress.tsx:119-124`, which already clears `interval`/`timeout` — add `clearTimeout(softTimeout)` alongside the existing `clearTimeout(timeout)`/`clearTimeout(hardTimeout)`, and reset `setSlow(false)` defensively per Pitfall 5):
```typescript
if (next && TERMINAL_STATUSES.has(next)) {
  active = false;
  clearInterval(interval);
  clearTimeout(softTimeout);
  clearTimeout(hardTimeout);
  setSlow(false);
  onComplete?.(next);
}
```

**Cleanup return must also clear both** (extend `discovery-progress.tsx:141-145`):
```typescript
return () => {
  active = false;
  clearInterval(interval);
  clearTimeout(softTimeout);
  clearTimeout(hardTimeout);
};
```

**Copy text to render on soft notice (non-failing banner)** — a new conditional block modeled on the existing `isFailed`/`isDegraded` banners (lines 179-208), same `rounded-lg bg-*-50 px-4 py-3` card shape but a calmer tone (not terracotta/error color):
```typescript
{slow && !isFailed && !isDegraded && status !== "done" && (
  <div className="rounded-lg bg-warm-gray-50 px-4 py-3">
    <p className="text-sm text-warm-gray-600">
      Det tar längre tid än väntat, fortsätter…
    </p>
  </div>
)}
```

**`isFailed`'s existing copy branch (line 197-199) stays as the real-failure message** — no change needed there; it already reads `timedOut` which now only fires from the absolute ceiling.

---

## Shared Patterns

### `Promise.allSettled` fulfilled/rejected aggregation
**Source:** `src/lib/booli/client.ts:719-736` (canonical), also present at `src/lib/booli/client.ts:663-681` via `walkFallbackTree`'s internal rung-attempt handling
**Apply to:** `src/lib/discovery/job.ts`'s area loop
**Shape:** iterate `settled` by index (not `for...of` on values) so the original input array (`areaIds`/`laterPages`) stays available for error-context logging (`areaId: areaIds[i]`).

### Additive-optional-parameter for shared transport config
**Source:** the project's own established discipline, explicit in `transport.ts`'s doc comment (lines 17-23): never change a proven global constant in place; existing call sites must remain byte-for-byte identical.
**Apply to:** `runPlaywrightRender`'s new `opts` parameter — every existing call site (`fetchListing` at `client.ts:526,531`, sold-comps at `client.ts:891,895`) must compile and behave unchanged with zero edits.

### Client poll+tick state machine (`BrfProgress` lineage)
**Source:** `src/components/brf-progress.tsx` (named analog per `discovery-progress.tsx:55`)
**Apply to:** `discovery-progress.tsx`'s timer/state additions — keep the same `active`/`clearInterval`/`clearTimeout` discipline; the terminal-status branch inside `poll()` remains the single source of truth that can cancel any pending timer, per Pitfall 5 in RESEARCH.md.

### Structured `console.error` logging (never throw from aggregation loops)
**Source:** `src/lib/discovery/job.ts:184-189` and `src/lib/booli/client.ts:727-734`
**Apply to:** both the area-loop rejection branch and any new logging in `fetchAreaPage`'s scoped-wait rungs — always a plain object with `jobId`/identifying-id + `code`, never the raw `Error` object or a stack trace.

## No Analog Found

None — every file in scope for this phase already has a directly-applicable in-repo analog (either the sibling page-level pattern in `client.ts`, or the file's own previously-established sibling `BrfProgress`). This phase is confirmed pure refactor/extension work, consistent with RESEARCH.md's "no new concurrency primitive" framing.

## Metadata

**Analog search scope:** `src/lib/discovery/`, `src/lib/booli/`, `src/components/` (discovery-progress*.tsx, brf-progress.tsx)
**Files scanned:** `job.ts`, `client.ts`, `transport.ts`, `discovery-progress.tsx`, `discovery-progress-live.tsx` (confirmed no changes needed — thin wrapper, see RESEARCH.md)
**Pattern extraction date:** 2026-07-18
