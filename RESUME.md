# RESUME — Bostad AI / Discovery analysis redesign

> Working handoff. Milestone v1.2 (Renovator-Grade Discovery Analysis, Phases 13–17)
> is now roadmapped and **Phase 13 is code-complete**. The section directly below is
> the live pick-up point (updated 2026-07-22). Older context follows further down.

---

## ⏸️ PICK UP HERE (updated 2026-07-23 — Phase 13 SHIPPED as PR #9)

### Pacing decision: RESOLVED → "Ship Phase 13 first"
You chose option 3 (ship Phase 13 independently). Done:
- **PR #9 open:** https://github.com/dwesterholm/legendary-umbrella/pull/9 (base `main`, MERGEABLE, not yet merged).
- Rich PR body generated from planning artifacts; verification status surfaced honestly as `human_needed`
  (DXUX-01 live gate deferred + WR-02/WR-03 follow-ups noted).
- Repo has **no CI checks**, so nothing gates the merge mechanically — merging is your call.

### The two open decisions now (answer when back)
1. **Merge PR #9?** — code review is already done in-branch (13-REVIEW.md + WR-01/04/05 fixes applied).
   The only thing NOT proven is DXUX-01 end-to-end in-window completion, which can only be confirmed from a
   **non-Booli-blocked IP** (deploy/staging) — see "To close DXUX-01" below. Merge now (verify live post-deploy)
   or run the operator live-smoke first, your call.
2. **Then Phase 14** — proceed into Phase 14 (Holistic Analysis Brain). ⚠️ config still has `skip_discuss: true`
   + `mode: yolo`; you wanted discuss-first, so flip `workflow.skip_discuss` via `/gsd-settings` OR run
   `/gsd-discuss-phase 14` explicitly. (Note: `66c126b` set skip_discuss=false on this branch — verify which value
   is live after any merge.)

### Where we are
- **Branch:** `gsd/phase-13-discovery-ux-poll-timeout-fix` — **~40 commits ahead of `main`, clean tree, pushed as PR #9, NOT merged.**
- **Milestone:** v1.2 — Phase 13 of 5 done (code-complete + verified); Phases 14–17 not started.
- **Discuss:** config has `skip_discuss: true` + `mode: yolo`. In the *first* `/gsd-autonomous` attempt
  you chose **"Enable discuss first"** — i.e. you want each phase to gather context interactively
  before planning. That preference has NOT yet been applied to config (skip_discuss is still `true`).
  **Before Phase 14, either flip `workflow.skip_discuss` to false (via `/gsd-settings`) or I run
  `/gsd-discuss-phase 14` explicitly.** Don't let 14 auto-skip discuss.

### Phase 13 — exact disposition (code-complete, one live gate deferred)
Shipped, all committed, 748 tests + tsc + lint green, code-reviewed + fixed:
- **13-01** area-parallel scrape (`Promise.allSettled` in `runSlice`) + bounded area-page renders; D-03 cost-cap invariant preserved.
- **13-02** two-tier timeout (soft-notice "Det tar längre tid än väntat, fortsätter…", no false-fail) + complete Swedish `STATUS_LABELS` + `KNOWN_STATUSES` exhaustiveness.
- **13-04** decoupled status read (badge advances during long ticks) + bounded detail-page render (`DETAIL_ENRICH_WAIT_SECS=90` / `MAX_RETRIES=2`).
- **13-05** coherent counter = `candidates analyzed / candidate_count` (clamped, monotonic, "N av N" at done; killed the "350 av 25" + backward-jump bug the live smoke caught).
- **Code-review fixes:** WR-01 (readStatus out-of-order guard), WR-04 (dispatchTick `.catch`), WR-05 (onComplete held in a ref).

**DXUX-02 = DONE.** **DXUX-01 = still `Pending`** — `human_needed`. Reason: my local IP is Booli/Cloudflare-blocked
(403 on detail pages), so end-to-end *in-window completion* can only be proven by an **operator live-smoke from a
non-blocked IP**. Same shape as v1.1's deferred live gates. See `.planning/phases/13-discovery-ux-poll-timeout-fix/13-VERIFICATION.md` (status: human_needed).

### To close DXUX-01 (operator action, needs a non-Booli-blocked IP)
Run the discovery flow with the query **"Renoveringsobjekt i Södermalm och Vasastan under 4 miljoner"**
(`DISCOVERY_ENABLED=true`, real Apify + Anthropic spend) and confirm it reaches results **without a forced reload**,
badge advances `Analyserar → Analyserar bilder`, and the counter reads coherently ("N av N" at done).

### Two deferred follow-ups (captured as background-task chips + in 13-REVIEW.md)
- **WR-02** — `enrichCandidateImages` still loops the ≤8 detail fetches **sequentially**; pathological all-fail worst
  case (~24 min) can still blow the ~300s serverless ceiling. Parallelize it (same `Promise.allSettled` pattern as
  the area scrape), preserving the D-03 cost pre-check. This is the *last* piece of robust in-window completion (DXUX-01).
- **WR-03** — failed fallback-tree rungs (403/timeout retries) incur real Apify spend that is **never added to
  `cost_sek_total`**, so the cost cap can be silently overshot (worse now that area scraping runs in parallel). Add
  failed-render cost accounting; keep the D-03 field-scoped-write invariant.

### Then: Phases 14 → 15 → 16 → 17 (strict dependency spine)
See "Next work" and the roadmap section below. Key spend/decision flags to remember:
- **Phase 15** includes a **live Anthropic strict-output smoke** (`RUN_LLM_EVALS=1`) — real API spend, and the
  `OpportunityBrief` schema must stay slim (single-nullable-leaf) or it 400s (memory `anthropic-structured-output-limits`).
- **Phase 17** needs an **image-gen provider decision** (nano-banana skill / higgsfield / other) before planning.

---

## Where things stand (original context, pre-Phase-13)

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
