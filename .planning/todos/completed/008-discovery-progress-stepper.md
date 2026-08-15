---
title: "Discovery needs a real progress stepper — a status badge is not enough confirmation that anything is happening"
status: done
completed: 2026-08-11
priority: P1
source: "captured 2026-08-11 — operator, after the first successful live discovery run"
created: 2026-08-11
theme: ux
area: fullstack
---

## Goal

Show the user what the job is actually doing, stage by stage, so a multi-minute run reads as working rather than hung.

> "We need A LOT more confirmations during the search. It should e.g. be a stepper that describes each part of the process … because otherwise nobody will think it's working in the background"

## Where this stands today

Phase 13 fixed the *acute* version of this — no forced reload, Swedish labels for every job state, a calm "Det tar längre tid än väntat, fortsätter…" notice, and a monotonic `N av N` counter (13-02, 13-04, 13-05). That was the right first cut. What it does not do is explain the **shape** of the work: the badge moves through a handful of coarse states while the pipeline underneath runs many distinct, individually-slow stages.

The operator ran a job that worked correctly and still could not tell it was progressing.

## The stages actually exist already

`runVisionForJob` is an explicit sequence — enrich → comps → BRF → vision → brief → persist — and `runSlice` has its own resolve/scrape/dedupe phases before that. The stepper does not need new orchestration; it needs those existing boundaries reported. Suggested granularity, close to the operator's own phrasing:

- "Tolkar din sökning…" (parse intent)
- "Söker i {area}…" (per resolved area — names the scope, which would also make a todo-005-style mis-scope visible immediately)
- "Hittade N objekt, rangordnar…" (candidate set + prefilter)
- "Hämtar bilder för objekt i/N…" (enrichment, per candidate)
- "Analyserar område och förening…" (comps + BRF)
- "Analyserar bilder för objekt i/N…" (vision, per candidate)
- "Sammanställer analys…" (brief + persist)

## Design constraints

- **Per-item counters must be monotonic and honest.** 13-05 exists because the counter previously showed things like "350 av 25" and jumped backward. Any new per-candidate progress must not reintroduce that — same discipline: a stable denominator, a numerator that only advances.
- **The status read is already decoupled from the tick** (13-04), so surfacing finer progress means writing more granular state, not making the client poll harder. Mind the cost: `processed_count` writes were deliberately made incremental rather than per-item.
- **Enrichment can now stop early** (WR-02, `ENRICH_DEADLINE_MS`). When the deadline trips, the stepper should say so plainly ("hann inte analysera alla bilder") rather than silently showing fewer analyzed objects than promised.
- Stages that are skipped (cost cap hit, no BRF match, vision skipped) should be *shown as skipped* with a reason, not omitted — the honest-partial-state principle already used across the report surfaces.

## Related

Pairs naturally with todo 007 (per-candidate detail page) and todo 002 (feature picker) as one coherent discovery-UX phase. Also worth revisiting the timing constants 13-03 was meant to calibrate once a real live run produces observed stage timings.
