---
status: testing
phase: 14-holistic-analysis-brain
source: [14-VERIFICATION.md]
started: 2026-08-10T14:20:00Z
updated: 2026-08-11T00:00:00Z
deferral:
  reason: >
    All four items require a live discovery run against real Apify/Allabrf, which
    no mocked test can substitute for (real latency, real spend accounting, real
    Allabrf extraction quality). They are UNRUN, not blocked.
  accepted_by: "Daniel Westerholm"
  accepted_at: "2026-08-10T14:20:00Z"
  blocks_phase_completion: false
  unblocked_by: "Runnable now — work these four items with /gsd-verify-work 14"
corrected_2026_08_11: >
  CORRECTION. This file previously recorded status `deferred_live` behind two
  environment blockers, BOTH of which were wrong:
    (1) "Supabase project is paused" — it was restored. Verified live 2026-08-11:
        GET /rest/v1/area_cache?select=area_id&limit=1 -> HTTP 200 in 0.14s. The
        table is queryable but EMPTY, so resolveArea will do live area probes on a
        first run (expected, costs a few Apify renders, not a blocker).
    (2) "operator IP is Booli/Cloudflare-blocked" — structurally incoherent for
        this codebase. There is no direct-fetch rung to Booli anywhere (grep
        'fetch(' across src/lib/booli/ returns nothing); every rung goes through
        apify/playwright-scraper on an Apify RESIDENTIAL/SE proxy
        (src/lib/booli/transport.ts:75), so the operator's IP never contacts
        Booli. The 403s that seeded this claim (13-SMOKE-FINDINGS.md, 2026-07-19,
        where the cause was correctly hedged as "likely partly environmental")
        were Cloudflare challenging the Apify proxy session — exactly what
        maxRequestRetries:3 and rung 2's fresh-container/new-proxy-session design
        exist to absorb, consistent with one fetch succeeding on rung 2 in that
        same run.
  consequence: >
    These four items are runnable today. Note two real cost/risk factors when
    running them (neither is a blocker): 13-REVIEW.md WR-02's worst case (up to 8
    candidates x ~180s sequential enrichment) can still exceed the ~300s Server
    Action ceiling; and fetchListing rung 3 (paid Lexis actor) is commented out
    for cost, so a Cloudflare-challenge streak has less headroom than in July.
---

## Current Test

number: 1
name: Live end-to-end discovery run — real comps + BRF folded into a real multi-area job
expected: |
  Comps fetched once per distinct area, BRF attempted only for top-N,
  cost_sek_total stays within CAP_VISION_SEK_MAX, no tick timeout, every
  candidate shows >=1 actionable item.
awaiting: operator to run the live smoke (no environment blocker — Supabase is live)

## Tests

### 1. Live end-to-end discovery run: real comps + BRF fetched and folded into a real multi-area job, within the CAP_VISION_SEK_MAX cost cap and inside the tick window.
expected: Comps fetched once per distinct area, BRF attempted only for top-N, cost_sek_total stays within cap, no tick timeout, every candidate shows >=1 actionable item.
why_human: No mocked test can observe real Apify/Allabrf latency, real spend accounting, or true end-to-end wall-clock inside the ~300s ceiling. (Runnable now — the previously-recorded Supabase-paused and operator-IP-blocked blockers were both incorrect; see corrected_2026_08_11 in the frontmatter.)
result: [pending]

### 2. Confirm genitive kommun corroboration reaches resolveOrgNr confidence 'high' against the live Allabrf registry for unambiguous single-name matches.
expected: 'high' confidence reached for real BRF names, unblocking the BRF top-N lookup in production (today gated to 'high' only, per D-14-09's explicit rejection of relaxing to 'low').
why_human: Only fixture-level genitive forms have been tested; real registry spelling variance can only be confirmed live.
result: [pending]

### 3. Capture real tenureForm values across a wide live result set to determine whether a tomträtt-shaped value ever appears at all.
expected: Either at least one tomträtt-bearing tenureForm is observed (confirming the confounder is live), or confirmation that it is currently inert in production (recorded, not silently assumed working).
why_human: Every committed tenureForm fixture is 'Bostadsrätt' — no tomträtt sample exists in the test suite to verify against (14-RESEARCH.md OQ-2).
result: [pending]

### 4. Re-run the landed CR-02 fix (commit b841563) against a real Allabrf-extracted BRF document with a genuinely high debt/m².
expected: A real 20-40k kr/m² debt is shown, flagged "(högre än vanligt)", folded into the debt-inclusive price basis, and named brf_debt_high — matching brf-lookup.test.ts:334's assertions against real production data, not just a fixture.
why_human: The mocked pipeline test proves the code path is reachable and correct; a live document is still needed to confirm Allabrf's real extraction quality at this debt level (OCR legibility, table layout variance) matches the fixture's assumed shape.
result: [pending]

## Summary

total: 4
passed: 0
issues: 0
pending: 4
skipped: 0
blocked: 0

## Gaps
