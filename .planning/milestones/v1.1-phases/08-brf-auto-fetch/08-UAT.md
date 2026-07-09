---
status: testing
phase: 08-brf-auto-fetch
source: [08-VERIFICATION.md, 08-REVIEW.md]
started: 2026-07-06T21:00:00Z
updated: 2026-07-06T21:00:00Z
---

## Current Test

number: 1
name: Live Allabrf auto-fetch end-to-end on a real listing
expected: |
  In the running app, analyze a real listing whose BRF has an Allabrf årsredovisning:
  (1) org.nr resolves with geographic corroboration; (2) the confirmation step shows org.nr + fiscal year
  ("Stämmer detta med din bostad?"); (3) confirming runs the IDENTICAL extraction/scoring the manual upload uses;
  (4) rejecting lands on the manual upload with zero friction; (5) a listing with no resolvable org.nr degrades
  silently to manual (no false error); (6) the report shows fiscal year prominently and flags staleness when the
  fetched year isn't the most recent. Also confirm Allabrf ToS/robots posture before enabling in production.
awaiting: user response

## Tests

### 1. Live Allabrf auto-fetch end-to-end
expected: org.nr resolves → confirmation (org.nr + fiscal year) → confirm runs identical scoring; reject → manual with zero friction; no-org.nr → silent manual degrade; fiscal year prominent + staleness flagged.
result: [pending]

### 2. Concurrent-trigger in-flight guard (CR-01) against live Postgres
expected: Two genuinely concurrent confirmAndAnalyze calls for the same analysis result in exactly ONE scrape/Claude bill; the second aborts cleanly (atomic CAS `.neq('brf_status','auto_fetching')` + `.or()` release predicate serialize correctly at the DB level).
result: [pending]

### 3. Allabrf markup assumptions (IN-01)
expected: The `data-fiscal-year` / selector assumptions in allabrf parsing match real Allabrf HTML; if markup differs, parsing degrades gracefully (no wrong data), not silently mis-extracts.
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
