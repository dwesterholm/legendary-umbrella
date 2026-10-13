---
phase: 13-discovery-ux-poll-timeout-fix
plan: 03
subsystem: discovery-ux
tags: [live-smoke, dxux-01, timing-calibration]
requires: [13-01, 13-02, 13-04, 13-05]
provides: [observed live timings for the three Phase 13 constants]
affects: [discovery-progress.tsx constants (not changed here)]
tech-stack: [next 16 dev server, local supabase, apify playwright renders]
key-files:
  created:
    - .planning/phases/13-discovery-ux-poll-timeout-fix/13-03-SUMMARY.md
  modified: []
key-decisions:
  - "No constant changed in this plan; the observed numbers below argue for a change that is its own fix."
status: complete
completed: 2026-10-13
---

# 13-03 — Live-smoke checkpoint (DXUX-01 phase gate)

Run by Claude in the browser pane per Daniel's standing instruction (he never tests manually).
Local dev server (`bostad-ai-dev`, port 3001) against the local Supabase stack. Done as Task 2 of
Phase 14.1 plan 10, so the same run also serves 14-UAT test 1.

## The run

| Item | Observed |
|---|---|
| Query | "Lägenheter i innerstan under 4 miljoner, minst 35 kvm" (free text, no chips) |
| Job | `d32ae1fe-3b8a-41b1-bd7e-8afa156ce08b` |
| Submitted | 2026-10-13 02:44:20 local |
| Intent parsed, districts resolved | within the first poll (seed + cache, no live area probe) |
| Scrape done (status → done, vision claim) | 02:50:54 — 6 min 34 s; 703 listings fetched, 60 kept (cap reached), `failed_areas: []` |
| Soft notice "Det tar längre tid än väntat, fortsätter…" | shown (at ~90 s), polling continued |
| Client ceiling | ~02:59 (15 min): page switched to "Det tar längre tid än väntat. Försök igen." with a retry button while the server was still working |
| Vision/comps pass done (status → done) | 03:10:58 — 20 min 04 s after the claim |
| Results rendered | yes, on the same page, WITHOUT a reload, at ~03:11 |
| Total wall-clock | 26 min 38 s |
| Candidates | 60; Kungsholmen present (26 incl. sub-areas); 60/60 with ≥1 actionable item (54 vision claims, 6 data-only briefs); comps on 52/60; BRF on 0/60 (Allabrf source dead) |
| Spend | `cost_sek_total` 1.573 SEK (scrape ledger, cap_sek 5); Apify headroom moved 4.26 → 2.71 USD during the scrape and did not move during vision; vision SEK not surfaced in the row or server log |
| Server-side errors | many `Booli-kallan blev inte klar i tid (status: RUNNING)` at AREA_PAGE_WAIT_SECS=120 on rung 1, all recovered by rung 2 (own-playwright-retry); 3 comps sub-areas `AREA_UNRESOLVED` (non-fatal); comps per-pass cap 8 dropped 4 of 12 labels |

Evidence (gitignored): `.planning/calibration/data/evidence/14.1-10-inapp-02-vision-soft-notice.jpg`,
`…-03-ceiling-forsok-igen.jpg`, `…-04-results-rendered.jpg`.

## Truths

1. **Completes and renders without a reload** — PASS. 703-listing, 4-district query; results appeared on the original page with no reload.
2. **Soft notice, never a false failure, polling continues** — FAIL. The calm soft notice did show and polling did continue, but at 15 minutes the ABSOLUTE_CEILING branch rendered "Försök igen", which reads as a failure while the job was still running correctly and later finished. Nothing was lost (the result still rendered), but the user was told to retry a job that did not need it.
3. **Constants calibrated or confirmed adequate** — measured:
   - `AREA_PAGE_WAIT_SECS = 120`: confirmed adequate in effect — rung 1 timed out repeatedly, rung 2 recovered every page; raising it would trade retry renders for longer waits, no clear win.
   - `SOFT_THRESHOLD_MS = 90 000`: confirmed adequate — the notice is correct for this workload.
   - `ABSOLUTE_CEILING_MS = 15 × 60 000`: **inadequate**. A 60-candidate innerstan run with vision took 26.6 min end to end, 20 min of it in the vision pass. The ceiling should be ≥ 30 min, or the ceiling message should keep polling and say "fortsätter" instead of "Försök igen", or the vision pass should write progress incrementally so the client can see it is alive (the row showed `processed_count` frozen at 703 for 20 min). Not changed here.

## Follow-ups (not fixed here)

- Raise or soften `ABSOLUTE_CEILING_MS` and keep polling past it (DXUX-01 regression at innerstan scale).
- Surface vision SEK in the job row / server log; `cost_sek_total` only counts the scrape.
- Vision pass is sequential and ~20 min for 60 candidates; incremental `processed_count` writes during vision would make the counter honest.
