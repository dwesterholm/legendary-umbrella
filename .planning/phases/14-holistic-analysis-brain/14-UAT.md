---
status: deferred_live
phase: 14-holistic-analysis-brain
source: [14-VERIFICATION.md]
started: 2026-08-10T14:20:00Z
updated: 2026-08-10T14:20:00Z
deferral:
  reason: >
    All four items require a live discovery run. Two hard environment blocks make
    that impossible right now: the Supabase project (nsheegvczxjeeayngqrv) is
    paused, so `resolveArea` cannot read `area_cache`; and the operator IP is
    Booli/Cloudflare-blocked (403 on detail pages). No mocked test can stand in
    for real Apify/Allabrf latency, real spend, or real Allabrf extraction
    quality. Recorded as a deferred-live operator gate per 14-VALIDATION.md,
    consistent with the Phases 11-13 precedent in this project.
  accepted_by: "Daniel Westerholm"
  accepted_at: "2026-08-10T14:20:00Z"
  blocks_phase_completion: false
  unblocked_by: "Restore the paused Supabase project + run from a non-blocked IP, then work these four items with /gsd-verify-work 14"
---

## Current Test

number: 1
name: Live end-to-end discovery run — real comps + BRF folded into a real multi-area job
expected: |
  Comps fetched once per distinct area, BRF attempted only for top-N,
  cost_sek_total stays within CAP_VISION_SEK_MAX, no tick timeout, every
  candidate shows >=1 actionable item.
awaiting: live environment (Supabase restore + non-blocked IP)

## Tests

### 1. Live end-to-end discovery run: real comps + BRF fetched and folded into a real multi-area job, within the CAP_VISION_SEK_MAX cost cap and inside the tick window.
expected: Comps fetched once per distinct area, BRF attempted only for top-N, cost_sek_total stays within cap, no tick timeout, every candidate shows >=1 actionable item.
why_human: Supabase project is paused (resolveArea reads area_cache) and the operator IP is Booli/Cloudflare-blocked (403 on detail pages) — no mocked test can observe real Apify/Allabrf latency or real spend.
result: [deferred]

### 2. Confirm genitive kommun corroboration reaches resolveOrgNr confidence 'high' against the live Allabrf registry for unambiguous single-name matches.
expected: 'high' confidence reached for real BRF names, unblocking the BRF top-N lookup in production (today gated to 'high' only, per D-14-09's explicit rejection of relaxing to 'low').
why_human: Only fixture-level genitive forms have been tested; real registry spelling variance can only be confirmed live.
result: [deferred]

### 3. Capture real tenureForm values across a wide live result set to determine whether a tomträtt-shaped value ever appears at all.
expected: Either at least one tomträtt-bearing tenureForm is observed (confirming the confounder is live), or confirmation that it is currently inert in production (recorded, not silently assumed working).
why_human: Every committed tenureForm fixture is 'Bostadsrätt' — no tomträtt sample exists in the test suite to verify against (14-RESEARCH.md OQ-2).
result: [deferred]

### 4. Re-run the landed CR-02 fix (commit b841563) against a real Allabrf-extracted BRF document with a genuinely high debt/m².
expected: A real 20-40k kr/m² debt is shown, flagged "(högre än vanligt)", folded into the debt-inclusive price basis, and named brf_debt_high — matching brf-lookup.test.ts:334's assertions against real production data, not just a fixture.
why_human: The mocked pipeline test proves the code path is reachable and correct; a live document is still needed to confirm Allabrf's real extraction quality at this debt level (OCR legibility, table layout variance) matches the fixture's assumed shape.
result: [deferred]

## Summary

total: 4
passed: 0
issues: 0
pending: 0
skipped: 0
blocked: 4

## Gaps
