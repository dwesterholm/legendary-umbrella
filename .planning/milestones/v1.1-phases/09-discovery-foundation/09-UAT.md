---
status: testing
phase: 09-discovery-foundation
source: [09-VERIFICATION.md, 09-REVIEW.md]
started: 2026-07-06T22:00:00Z
updated: 2026-07-06T22:00:00Z
---

## Current Test

number: 1
name: Live discovery end-to-end (flag ON, operator-only)
expected: |
  With DISCOVERY_ENABLED=true + CRON_SECRET + SUPABASE_SERVICE_ROLE_KEY set in a real environment:
  free-text + hard filters → background job → progress ("12 av 25 annonser analyserade") that advances via the
  client tick → persisted results at /discover/[jobId] (leave & return works). A broad-area query stops at the
  candidate/SEK cap with the honest "vi skannade X, stannade vid Y" banner and never exceeds the per-search SEK cap.
  Kill switch degrades to single-URL on a Booli block. discovery_jobs.results contain ONLY allowlisted PII-safe
  fields. Opening another user's /discover/[jobId] returns 404. The once-daily Vercel Cron sweep registers on Hobby.
awaiting: user response

## Tests

### 1. Live discovery end-to-end (flag ON)
expected: full lifecycle + honest cap banner + PII-safe persisted results + kill-switch degrade, per 09-04 operator checklist.
result: [pending]

### 2. Live claim_discovery_slice concurrency + ownership (CR-01) against local/live Postgres
expected: run job.integration.test.ts with RUN_DB_INTEGRATION=1 — two concurrent claims → exactly one wins (FOR UPDATE SKIP LOCKED); a non-owner authenticated claim returns NO row (in-body ownership guard, migration 011).
result: [pending]

### 3. Live Booli area-search-box probe (area resolution)
expected: run resolveArea("Södermalm")/("Nacka") live; confirm the probe resolves an areaId, or confirm v1 ships seed-primary (Stockholm-region only) as documented. Broader geographic coverage pending probe validation.
result: [pending]

### 4. Cron sweep secret + service-role wiring (CR-02)
expected: /api/discovery/sweep returns 401 without the correct Bearer CRON_SECRET; with CRON_SECRET + SUPABASE_SERVICE_ROLE_KEY set, the sweep reclaims stale-claimed orphaned jobs cross-user via the service-role client.
result: [pending]

### 5. Orphan-recovery latency + FINAL legal go/no-go (operator/legal decision)
expected: (a) explicitly acknowledge the ~24h worst-case orphan-recovery latency (client-tick + once-daily cron) is acceptable for v1, OR upgrade to Vercel Pro; (b) complete the FINAL legal go/no-go — re-read Booli/Hemnet ToS, re-derive proportionality — BEFORE flipping DISCOVERY_ENABLED on in production. A no-go retroactively cancels Phases 10–12.
result: [pending]

## Summary

total: 5
passed: 0
issues: 0
pending: 5
skipped: 0
blocked: 0

## Gaps
