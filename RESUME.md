# RESUME — Bostad AI / Discovery analysis redesign

> Working handoff. Reconstructed 2026-07-17 from memory (`discovery-analysis-redesign.md`)
> + `.planning/research/` docs. Milestone v1.1 is **complete & archived** — the work
> below is the *next* body of work, not yet promoted into an active milestone/phase.

## Where things stand

- **Area-search data overhaul — DONE + merged to `main`** (merge `11a3c7a`, PR #8, E2E-verified 2026-07-17).
  - Multi-area split (`splitAreaQuery` in `resolve-area.ts`, cap 4), `runSlice` resolve+scrape+`dedupeCandidates`.
  - One-shot termination fix: `runSlice` always sets `status:"done"` (was stranding under-cap searches in `processing`).
  - Pagination `buildTillSaluUrl` walks `&page=N`; page 1 sequential, pages 2..5 parallel (`Promise.allSettled`).
  - **kr/m² sort**: every page `?sort=listSqmPrice&ascending=true` (numerically confirmed ascending).
  - Verified with "Renoveringsobjekt i Södermalm och Vasastan under 4 miljoner" → 315 listings (vs 71 before).
- **Analysis-redesign scaffolding — BUILT, NOT WIRED.** Research + SPEC + pure cores exist and pass tests,
  but are not yet connected to the live analysis path.

## Next work (prioritized)

### P1 — client-timeout UX (surfaced by the E2E)
The richer scrape (315 listings + vision + Booli `networkidle` 60s timeouts) now **exceeds the client's
5-min poll timeout** (`MAX_POLL_MS` in `discovery-progress.tsx`) → user sees "Det tar längre tid än väntat"
and must reload (server finishes fine).
- Root contributors: areas scraped **sequentially** in `runSlice` (only pages parallel); one timing-out
  page blocks its area's `allSettled` batch ~180s.
- Fix options: parallelize across **areas** in `runSlice`; lower per-page render timeout / cap retries;
  raise `MAX_POLL_MS`; or stream partial results.
- Minor: `vision_processing` has no Swedish label (raw string shows) in `STATUS_LABELS` (discovery-progress.tsx).

### P2 — the original core goal: AI analysis quality (Phase A.3–A.5 → B → C)
Wire the built cores into a real per-candidate `OpportunityBrief`. **No DB migration** (rides in JSONB
`results`; comps use re-resolved areaId).
- **A.4 wiring** in `runVisionForJob`: re-resolve areaId → `fetchSoldComps` (synthesize single-crumb
  `SoldSourceQuery`) → `normalizeSoldOutput` → `computeAreaComps` + per-candidate BRF summary →
  inject into deep-pass payload.
- **A.5**: prompt (in `2026-07-10-A5-PROMPT-AND-VERIFICATION.md`) + `vision-schema.ts` `OpportunityBrief` —
  **needs a LIVE Anthropic strict-output smoke** (mocked tests hide 400s — see
  `anthropic-structured-output-limits` memory).
- **B**: wire `valueGap` into ranking (`discovery-results.tsx:112-115`) + "från bildtolkning" marker.
- **C**: proposed planritning for HIGH value-gap candidates only.

Built cores (tested, separation-grep enforced so they can't leak into niche-score/flags):
`flip-economics.ts` (`valueGap`/`buyerSegment`/`RENO_COST_MATRIX`/`applyRot`/`taxLines`),
`area-comps.ts` (`computeAreaComps`). Phase A.1 pre-filter flip + A.2 triage flip already done.

## ⚠️ Operator principle: low kr/m² ≠ reno object
The kr/m² sort is a **surfacing signal only, never a conclusion**. Low kr/m² can be reno-upside OR a
legit discount (ground/bottom floor, no elevator/balcony, traffic/noise, cheaper sub-area, tomträtt,
BRF debt, odd BOA). P2 analysis MUST normalize kr/m² against these before attributing to condition.
Never render UI implying "low kr/m² ⇒ reno". Encoded in SPEC §2.6.

## Locked constraint
`niche-score.ts` / `flags.ts` must NEVER import vision/value-gap/area-comps types (static-grep tested).
Use the separate `condition-score.ts` path + "från bildtolkning" marker.

## Source docs
- Memory: `discovery-analysis-redesign.md` (+ `booli-sold-price-source`, `supabase-migration-already-applied`,
  `anthropic-structured-output-limits`, `lexis-paid-actor-disabled`).
- `.planning/research/2026-07-10-ANALYSIS-REDESIGN-SPEC.md` — full ruleset, Phase A/B/C, 4 locked operator decisions (§6).
- `.planning/research/2026-07-10-A5-PROMPT-AND-VERIFICATION.md` — A.5 prompt + OpportunityBrief schema + verification runbook.
- `.planning/research/2026-07-10-what-makes-apartments-increase-in-price.md` — research §1–§8.
- `.planning/research/2026-07-10-ANALYSIS-REDESIGN-FOLLOWUPS.md`.

## Now roadmapped as milestone v1.2 (2026-07-17)
This work is now formal **milestone v1.2 — Renovator-Grade Discovery Analysis**, Phases 13–17:
- **Phase 13** — Discovery UX / poll-timeout fix (= P1 above) — DXUX-01/02
- **Phase 14** — Holistic Analysis Brain (A.3 no-empty + A.4 comps/BRF wiring, confounder-normalize) — ANL-01..04
- **Phase 15** — ROI-Aware Opportunity Brief (A.5 prompt + OpportunityBrief schema + live Anthropic smoke) — ROI-01..05
- **Phase 16** — Value-Gap Scoring & Ranking (wire `valueGap` + "från bildtolkning" marker) — VGAP-01..03
- **Phase 17** — Proposed Planritning Generation (image-gen, HIGH value-gap only) — DRAW-01

See `.planning/ROADMAP.md` (v1.2 section) + `.planning/REQUIREMENTS.md` for full success criteria.
**Next:** `/gsd-plan-phase 13` — or `/gsd-autonomous` to drive all five phases.
