---
status: testing
phase: 10-niche-ranking
source: [10-VERIFICATION.md]
started: 2026-07-07T16:30:00Z
updated: 2026-07-07T16:30:00Z
---

## Current Test

number: 1
name: Niche-ranking kill-criterion judgement on real data
expected: |
  With DISCOVERY_ENABLED=true, run one real discovery job and switch between the three niches
  (renovation-upside, turnkey, imminent-stambyte-where-BRF-pays). Confirm: (1) the ordering VISIBLY changes
  between niches; (2) each candidate's top position is defensible via its cited signals (not an opaque score);
  (3) real-world sparse constructionYear/tenureForm coverage still yields useful, honest rankings (thin-baseline
  caption appears when the price/sqm sample is too small). KILL CRITERION: if the three niches produce
  near-identical orderings on real data, ship discovery with FILTERING ONLY and defer niche ranking.
awaiting: user response

## Tests

### 1. Niche-ranking kill-criterion judgement
expected: niche switching visibly reorders + cited-signal-defensible on real scraped data; else ship filtering-only per the roadmap kill criterion.
result: [pending]

## Summary

total: 1
passed: 0
issues: 0
pending: 1
skipped: 0
blocked: 0

## Gaps
