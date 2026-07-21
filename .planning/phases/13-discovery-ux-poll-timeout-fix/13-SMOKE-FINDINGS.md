# Phase 13 — Live Smoke Findings (13-03)

**Run:** 2026-07-19, query "Renoveringsobjekt i Södermalm och Vasastan under 4 miljoner", max 4M, job `b24f053b-984c-4305-9f3e-432feb37c4f3`, local dev (port 3001), `DISCOVERY_ENABLED=true`, real Apify + Anthropic.

## Confirmed working (the core Phase 13 delivery)
- **Multi-area parse** — "Södermalm och Vasastan" resolved to two areas.
- **Soft-notice, no false-fail (DXUX-01 / D-04, D-05)** — at the ~90s soft threshold the calm banner **"Det tar längre tid än väntat, fortsätter…"** appeared and the run KEPT polling with a green badge, replacing the old hard-fail + forced reload. Visually confirmed. No forced reload.
- Client-tick loop firing; area scrape completed (candidates found; run reached the vision phase).

## Gaps surfaced (only observable via a live run — mocked timers can't catch these)

### GAP-1 — UI shows no progress during the long vision tick
The client poll does `await tickDiscovery()` **then** reads status, both under one `inFlight` guard (`src/components/discovery-progress.tsx:92-128`). But a single tick runs the ENTIRE area-scrape + full vision pass in one multi-minute call (`tickDiscovery` → `claimAndRunVisionForJob` → `runVisionForJob`, `job.ts:~575`). While that long tick is in flight, the status read never runs, so the badge stayed **"I kö"** for 8+ minutes even though the DB row was `processing` then `vision_processing`. The soft-notice (an independent client timer) was the only thing that updated. → DXUX-01's "visibly progresses within the window" is not met.

Root cause detail: `runVisionForJob` writes to the DB **once at the end** (`updateJob(status:"done", results)`, `job.ts:~588`) — no incremental progress write during enrichment/vision. So even a decoupled read only surfaces the coarse status flip, not counter movement, unless incremental writes are added.

### GAP-2 — vision-enrichment detail fetches are unbounded + failing
`enrichCandidateImages` (`job.ts:~499`) calls `fetchListing(c.sourceListingUrl)` (detail pages), which uses the **default** transport (`runPlaywrightRender` `waitSecs:240` / `maxRequestRetries:3`, `transport.ts:63-68`). 13-01 only scoped the AREA listing pages (`fetchAreaPage`), NOT detail pages. Live logs showed each candidate detail page getting Booli **`403 blocked`** then `page.goto: Timeout 60000ms exceeded`, retrying 3× over 2 rungs (`booli.se/bostad/420675` retryCount 1→2→3) — minutes burned per candidate. One fetch succeeded via "rung 2 (own-playwright-retry, health=degraded)". The 403 is likely partly environmental (local IP blocked by Booli/Cloudflare), but the unbounded 240s×2-rung detail render is a real per-candidate cost lever the phase left untouched.

## 13-04 fix scope (decided with operator 2026-07-19)
1. **Decouple status read from the tick** — read job status/counters on every poll independent of the in-flight tick guard, so the badge shows `Analyserar` / `Analyserar bilder` during a long tick. Keep the `inFlight` guard on the tick DISPATCH only.
2. **Incremental progress writes** — update `processed_count` during the enrichment/vision loop so the "n av N analyserade" counter advances (meets "visibly progresses").
3. **Bound detail-fetch render** — add an additive optional `opts?: { waitSecs?, maxRequestRetries? }` to `fetchListing(url, opts?)`, thread to `runPlaywrightRender(url, APOLLO_PAGE_FUNCTION, opts)`; `enrichCandidateImages` passes a bounded value (shorter waitSecs + fewer retries) so a blocked/slow detail page can't burn ~480s. `/analyze` single-listing call site (no opts) stays at the 240s default.

Note: the 403 itself is environmental (local IP) and NOT a code defect to "fix" here — bounding the render caps its cost; robust behavior is degrade-gracefully (enrichCandidateImages already never throws).

## Calibration read
- `SOFT_THRESHOLD_MS=90s` fired appropriately (showed while genuinely still working).
- `ABSOLUTE_CEILING_MS=15min` not reached in the observation window; run was halted at ~8min for spend/time.
- Area-page `waitSecs` (13-01) fine; the un-scoped DETAIL-page render is the real lever (GAP-2).
