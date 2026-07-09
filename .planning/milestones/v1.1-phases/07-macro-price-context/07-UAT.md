---
status: testing
phase: 07-macro-price-context
source: [07-VERIFICATION.md]
started: 2026-07-06T20:00:00Z
updated: 2026-07-06T20:00:00Z
---

## Current Test

number: 1
name: Live macro-context render on a real analysis
expected: |
  Run a real analysis in the running app (live Riksbank SWEA + SCB PxWebApi). The "Makroekonomisk kontext"
  section renders as its own labeled panel, visually separate from the listing price comparison, showing the
  current Riksbank policy rate, KPIF inflation, and the regional (län) price-index trend — each with its source
  and reference period. No text frames macro data as a future-price prediction, timing advice, or buy/sell signal.
  When one macro source is unavailable, that indicator degrades to "Ej tillgänglig" without blanking price or area data.
awaiting: user response

## Tests

### 1. Live macro-context render on a real analysis
expected: Makroekonomisk kontext section shows policy rate + KPIF + regional trend with source + reference period, visually separate from listing comparison, strictly descriptive (no prediction/verdict), per-indicator degradation to "Ej tillgänglig".
result: [pending]

## Summary

total: 1
passed: 0
issues: 0
pending: 1
skipped: 0
blocked: 0

## Gaps
