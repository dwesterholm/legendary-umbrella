# Roadmap: Bostad AI

Bostad AI — an AI-powered property analysis tool for the Swedish market.

## Milestones

- ✅ **v1.0 MVP** — Phases 1–4 (shipped 2026-07-06) — [archive](milestones/v1.0-ROADMAP.md) · [audit](milestones/v1.0-MILESTONE-AUDIT.md)
- ✅ **v1.1 Owned Data Layer & Intelligent Discovery** — Phases 5–12 (shipped code-complete 2026-07-07) — [archive](milestones/v1.1-ROADMAP.md) · [audit](milestones/v1.1-MILESTONE-AUDIT.md)
  - Discovery surface (Phases 9–12) ships behind `DISCOVERY_ENABLED` (now ON; retained as kill switch) — legal go/no-go = GO (operator 2026-07-08).
- 🔨 **v1.2 Renovator-Grade Discovery Analysis** — Phases 13–17 (started 2026-07-17) — wiring the already-merged analysis cores (`flip-economics.ts`, `area-comps.ts`, pre-filter/triage flips) into a holistic, ROI-aware, buyer-tailored opportunity brief per candidate + fixing the poll-timeout UX. Spec: [`research/2026-07-10-ANALYSIS-REDESIGN-SPEC.md`](research/2026-07-10-ANALYSIS-REDESIGN-SPEC.md).

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1–4) — SHIPPED 2026-07-06</summary>

- [x] Phase 1: Foundation + Core Pipeline (3/3 plans) — completed 2026-06-06
- [x] Phase 2: BRF Financial Analysis (6/6 plans) — completed 2026-06-16
- [x] Phase 3: Market Context (6/6 plans) — completed 2026-06-22
- [x] Phase 4: AI Report + Delivery (6/6 plans) — completed 2026-07-06

Full phase details: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md).

</details>

<details>
<summary>✅ v1.1 Owned Data Layer & Intelligent Discovery (Phases 5–12) — SHIPPED (code-complete) 2026-07-07</summary>

- [x] Phase 5: Owned Booli Acquisition (5/5 plans) — completed 2026-07-06
- [x] Phase 6: Deeper Listing Extraction (3/3 plans) — completed 2026-07-06
- [x] Phase 7: Macro Price Context (3/3 plans) — completed 2026-07-06
- [x] Phase 8: BRF Auto-Fetch (4/4 plans + gap-closure) — completed 2026-07-07
- [x] Phase 9: Discovery Foundation (4/4 plans) — completed 2026-07-07
- [x] Phase 10: Niche Ranking (2/2 plans) — completed 2026-07-07
- [x] Phase 11: Gallery Condition Vision (3/3 plans) — completed 2026-07-07
- [x] Phase 12: Floor-Plan & Sun-Path (4/4 plans) — completed 2026-07-07

Full phase details, goals, and success criteria: [milestones/v1.1-ROADMAP.md](milestones/v1.1-ROADMAP.md).
Deferred operator verification (legal go/no-go, live validation gates, UAT): [milestones/v1.1-MILESTONE-AUDIT.md](milestones/v1.1-MILESTONE-AUDIT.md) and phase `*-UAT.md` files.

</details>

### 🔨 v1.2 Renovator-Grade Discovery Analysis (Phases 13–17) — IN PROGRESS

- [ ] **Phase 13: Discovery UX / Poll-Timeout Fix** — the live discovery flow finishes inside the client poll window (no forced reload) and every job state shows a Swedish status label.
- [ ] **Phase 14: Holistic Analysis Brain** — fold re-resolved area comps (R_med/U_med) + per-candidate BRF into the value case; no candidate leaves analysis with empty `claims: []`; low kr/m² normalized against confounders before any reno attribution.
- [ ] **Phase 15: ROI-Aware Opportunity Brief** — prioritized, buyer-segment-tailored opportunities with tiered cost/uplift, profit ±22% tax, freshness-based bathroom scoring, interior-designer specifics; `OpportunityBrief` schema passes a live Anthropic strict-output smoke.
- [ ] **Phase 16: Value-Gap Scoring & Ranking** — §2.6 value-gap headline metric that re-orders results on the separate read path, with a "från bildtolkning" UI marker; separation static-grep test extended.
- [ ] **Phase 17: Proposed Planritning Generation** — image-gen proposed floor plan for HIGH value-gap candidates only, daylight/bearing caveats stamped, bounded by cost caps; source images analyze-only (GDPR).

## Phase Details

> v1.2 phases only. v1.0/v1.1 phase details live in their milestone archives (linked above). Numbering **continues** from v1.1's Phase 12 — no reset. Phases 1–12 are untouched.

### Phase 13: Discovery UX / Poll-Timeout Fix

**Goal**: The now-live discovery flow finishes within the user's patience window and every job state shows a human-readable Swedish label — no forced reload, no raw enum leak. (Independent, unblocks confidence in the live discovery surface; can go first.)
**Depends on**: Nothing new (the discovery surface is already live on `main`); independent of the analysis phases.
**Requirements**: DXUX-01, DXUX-02
**Success Criteria** (what must be TRUE):

  1. A realistic multi-area query (e.g. "1:a i Södermalm och Vasastan under 4 miljoner", 300+ listings + vision) reaches and displays results without the user reloading the page — the server-side run finishes inside the client poll window.
  2. While a job runs, every state (including vision processing) shows a Swedish status label in the progress UI — no raw enum string (e.g. `vision_processing`) ever appears on screen.
  3. A long run visibly progresses within the window (area work parallelized / partial results surfaced / per-page render retries capped) rather than appearing to hang until a manual refresh.

**Notes**: Respect `DISCOVERY_ENABLED` fail-closed + cost caps (`CAP_VISION_SEK_MAX=10`, `VISION_ENRICH_LIMIT=8`, `CAP_CANDIDATES_MAX=25`) — every run is real Apify + Anthropic spend. Client tick is the primary job driver; the sweep cron is only an orphan-resume net.
**Plans**: 5 plans

- [x] 13-01-PLAN.md — Parallelize area scrapes in runSlice + scoped area-page waitSecs override (DXUX-01 backend throughput; D-01/D-02/D-03)
- [x] 13-02-PLAN.md — Two-tier poll timeout (calm soft-notice, keep polling) + complete Swedish STATUS_LABELS (DXUX-01 client UX + DXUX-02; D-04/D-05/D-06/D-07)
- [ ] 13-03-PLAN.md — Live-smoke checkpoint: large multi-area run completes in-window; calibrate timing constants (DXUX-01 phase gate)
- [x] 13-04-PLAN.md — Close live-smoke gaps: decouple status read from tick, incremental processed_count writes, bound vision detail-fetch render (DXUX-01 visible in-window progress)
- [ ] 13-05-PLAN.md — Fix the "annonser analyserade" counter (analyzed/found = candidate_count denominator, monotonic numerator, N av N at done) + revert the 13-04 processed_count overwrite regression (DXUX-01 counter correctness; gap from the 13-03 re-smoke)

**UI hint**: yes

### Phase 14: Holistic Analysis Brain

**Goal**: Every surfaced candidate is analyzed against holistic context — renovated-vs-unrenovated area comps and its BRF's finances — always leaves analysis with ≥1 actionable opportunity, and never mistakes a low kr/m² for a renovation signal. (SPEC Phase A: A.3 no-empty fallback + A.4 comps/BRF wiring; A.1/A.2 flips already merged.)
**Depends on**: Analysis cores already merged on `main` (`area-comps.ts` `computeAreaComps`, `flip-economics.ts`, pre-filter flip A.1, Haiku triage flip A.2). Independent of Phase 13.
**Requirements**: ANL-01, ANL-02, ANL-03, ANL-04
**Success Criteria** (what must be TRUE):

  1. A dated/original flat that previously produced `claims: []` (the Ringvägen 122 scenario) now surfaces with ≥1 actionable opportunity — when no image attributes survive the confidence/imageIndex gates, a holistic-data-only brief is produced instead of an empty one.
  2. A candidate's value case folds in renovated-vs-unrenovated area comps (R_med / U_med from `computeAreaComps`), resolved via the re-resolved areaId — the analysis references how its kr/m² sits against renovated vs unrenovated sales nearby.
  3. For top candidates (within cost caps), the value case folds in the BRF summary — avgift, debt/m², stambyte funding state, tomträtt, soliditet.
  4. Where a listing's kr/m² is low, the analysis normalizes against confounders (floor, elevator, balcony, micro-location, sub-area, tomträtt, BRF debt) before any condition/reno attribution, and the UI never renders text implying "low kr/m² ⇒ renovation object".

**Notes**: No DB migration — `OpportunityBrief` + BRF summary ride in the existing JSONB `results` column; comps use the re-resolved `areaId` (cached `resolveArea`), not lat/lng. Broker/gallery/BRF source data is analyze-only, never persisted. Real Apify/Anthropic spend — fold comps + BRF fetches into the vision cost gate. **A.4 must land before Phase 16** (VGAP needs R_med/U_med from here).
**Plans**: TBD
**UI hint**: yes

### Phase 15: ROI-Aware Opportunity Brief

**Goal**: Each analyzed candidate produces a prioritized, buyer-tailored opportunity brief — tiered cost/uplift, profit with and without tax, freshness-based bathroom scoring, and concrete interior-designer specifics — delivered through a slim schema that survives Anthropic strict-output. (SPEC Phase A.5.)
**Depends on**: Phase 14 (needs comps/BRF folded into the deep-pass payload so `valueGap` / `taxLines` / `buyerSegment` / `RENO_COST_MATRIX` can be code-attached to the brief).
**Requirements**: ROI-01, ROI-02, ROI-03, ROI-04, ROI-05
**Success Criteria** (what must be TRUE):

  1. A candidate shows a prioritized opportunity list — each item has a cheap/mid/high cost band, an expected uplift, a confidence, and a hedged plain-Swedish rationale; structural items keep the "kräver konstruktör / väggutredning" caveat.
  2. Recommendations are visibly tailored to the derived buyer segment — an etta never gets luxury-kitchen recs (capped at MID), while a 2–3:a is weighted toward an extra room / open plan / a scale-4 kitchen.
  3. Every opportunity shows profit both with and without tax (flat 22% on vinst) plus the static uppskov (interest-free) and same-year loss-offset notes — no per-session tax input required.
  4. A dated bathroom yields a cosmetic-refresh opportunity scored on freshness (not material tier), and any microcement-over-våtmatta suggestion carries the HIGH-RISK caveat that it is cosmetic ytskikt only and does not renew the tätskikt / våtrumsintyg.
  5. The brief includes concrete per-room interior-designer specifics (named colors, named furniture moves) — never generic "inrett i nordisk stil" — and the `OpportunityBrief` schema passes a **live** Anthropic strict-output smoke (no 400).

**Notes**: The model does the QUALITATIVE read only (opportunities, rationale, designer tips, architect note); `flip-economics.ts` + `area-comps.ts` compute all money deterministically in code and attach it — no hallucinated numbers. Keep the schema SLIM (single-nullable-leaf, numbers unconstrained) — mocked tests hide 400s, so the live smoke (`RUN_LLM_EVALS=1`, ~2 frozen fixtures) is mandatory; if it 400s, slim further before touching UI. No verdict, every claim cited/hedged.
**Plans**: TBD

### Phase 16: Value-Gap Scoring & Ranking

**Goal**: Each candidate carries a value-gap headline metric that re-orders discovery results — computed on the separate analysis read path and clearly marked "från bildtolkning" so buyers can tell interpreted signals from verified deterministic flags. (SPEC Phase B.)
**Depends on**: Phase 14 (R_med/U_med comps) and Phase 15 (the brief that carries the value-gap object). Primary blocker is Phase 14's A.4 comps.
**Requirements**: VGAP-01, VGAP-02, VGAP-03
**Success Criteria** (what must be TRUE):

  1. Each candidate shows a value-gap headline (net uplift + HIGH/MED/LOW flag + confidence) per the §2.6 formula — Resale_W capped at the area renovated 75th percentile, Purchase_P with overbid bias — including the >25%-below discount-attribution guard (condition-explained gap capped at 20%, residual routed to hidden-defect penalty).
  2. Discovery results are re-ordered by value-gap as a ranking input, and the static-grep separation test — **extended to cover the value-gap module** — stays green, proving `niche-score.ts` / `flags.ts` never import it.
  3. Analysis-derived signals (condition and value-gap) render with a "från bildtolkning" marker in the discovery results UI, visually distinct from the deterministic verified flags.

**Notes**: Value-gap is a ranking input **and** display (operator decision #1), computed on the separate vision/analysis read path (extend `condition-score.ts` or a sibling), NOT `computeNicheScore`. Structural separation is LOCKED + tested — extend `niche-score.test.ts` grep list. "Low kr/m² ≠ reno object" invariant from Phase 14 carries through the ranking.
**Plans**: TBD
**UI hint**: yes

### Phase 17: Proposed Planritning Generation

**Goal**: HIGH value-gap candidates get a generated proposed floor plan illustrating the suggested conversion, with daylight/bearing caveats stamped on it, bounded by cost caps — while source images stay analyze-only and are never persisted. (SPEC Phase C.)
**Depends on**: Phase 16 (the HIGH value-gap flag gates which candidates get a drawing).
**Requirements**: DRAW-01
**Success Criteria** (what must be TRUE):

  1. A candidate flagged HIGH value-gap shows a generated proposed planritning illustrating the suggested conversion; candidates without a HIGH flag show none (bounding image-gen spend).
  2. The generated drawing has daylight and bearing-wall caveats stamped on it — never asserting a wall's bärande status as fact.
  3. Drawing generation stays within the per-search cost caps, and broker/gallery source images used for analysis are never rendered or persisted — only generated drawings persist (GDPR).

**Notes**: Image-gen provider TBD at phase start (`nano-banana` skill / `higgsfield` / other). HIGH-only gate bounds spend. This is the one place persistence is allowed — generated drawings only, never source images.
**Plans**: TBD

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation + Core Pipeline | v1.0 | 3/3 | Complete | 2026-06-06 |
| 2. BRF Financial Analysis | v1.0 | 6/6 | Complete | 2026-06-16 |
| 3. Market Context | v1.0 | 6/6 | Complete | 2026-06-22 |
| 4. AI Report + Delivery | v1.0 | 6/6 | Complete | 2026-07-06 |
| 5. Owned Booli Acquisition | v1.1 | 5/5 | Complete | 2026-07-06 |
| 6. Deeper Listing Extraction | v1.1 | 3/3 | Complete | 2026-07-06 |
| 7. Macro Price Context | v1.1 | 3/3 | Complete | 2026-07-06 |
| 8. BRF Auto-Fetch | v1.1 | 4/4 | Complete | 2026-07-07 |
| 9. Discovery Foundation | v1.1 | 4/4 | Complete | 2026-07-07 |
| 10. Niche Ranking | v1.1 | 2/2 | Complete | 2026-07-07 |
| 11. Gallery Condition Vision | v1.1 | 3/3 | Complete | 2026-07-07 |
| 12. Floor-Plan & Sun-Path | v1.1 | 4/4 | Complete | 2026-07-07 |
| 13. Discovery UX / Poll-Timeout Fix | v1.2 | 3/5 | In Progress|  |
| 14. Holistic Analysis Brain | v1.2 | 0/TBD | Not started | - |
| 15. ROI-Aware Opportunity Brief | v1.2 | 0/TBD | Not started | - |
| 16. Value-Gap Scoring & Ranking | v1.2 | 0/TBD | Not started | - |
| 17. Proposed Planritning Generation | v1.2 | 0/TBD | Not started | - |

## Backlog

Items captured for future planning. Promote via `/gsd-review-backlog` when ready. Four former backlog items (999.6, 999.2, 999.3, 999.7) were promoted into v1.1 Phases 5–12.

- **999.6 → promoted to Phase 5** (Owned Booli Acquisition)
- **999.2 → promoted to Phase 6** (Deeper Listing Extraction)
- **999.3 → promoted to Phase 7** (Macro Price Context)
- **999.7 → promoted to Phases 9–12** (Discovery Foundation, Niche Ranking, Gallery Condition Vision, Floor-Plan & Sun-Path)

### Phase 999.1: Proprietary price estimator (BACKLOG)

**Goal:** [Captured for future planning] Build a price estimator that beats Booli's "value based price." Booli's dropdown exposes which reference objects drive their estimate — ours would weigh historical data, trends, floor level, balcony, BRF debt, and more. Prior art: a friend's hand-built scraper + estimator outperformed Booli's during his own apartment search. Synergy: actor already returns Booli's `estimate` and `listSqmPrice` for benchmarking.

**Sun exposure tracking:** Track how the sun hits the apartment from the address (friend did this via a mix of sun-tracking websites — feasibility unconfirmed but probably doable). The actor already returns `latitude`/`longitude`, so sun-path computation (e.g. suncalc-style libraries or APIs) is a candidate beyond scraping websites. Standalone value even outside the estimator: a UI where the user sees a map preview (Google Maps) and can visually drag the sun's position through the day — possibly via iframe embed of an existing sun-tracking site (e.g. ShadeMap/SunCalc.org-style tools), or built natively. Sun exposure is also a plausible estimator feature (sunny balconies price higher). *(Note: theoretical sun-path landed in v1.1 Phase 12; this backlog item is the richer interactive/map-based version.)*
**Requirements:** EST-01 (Future). MACRO-01 (Phase 7) lays groundwork.

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)

### Phase 999.4: Advanced BRF risk analysis — beyond hard-coded rules (BACKLOG)

**Goal:** [Captured for future planning] Evolve the Phase 2 BRF score from purely deterministic threshold rules (D-08) into forward-looking *risk* analysis that anticipates future debt/avgift pressure and feeds it back into the grade as explicit, explained risk factors. Experimental — to be prototyped (likely Claude-assisted reasoning over the extracted financials + årsredovisning narrative, kept auditable). Each risk factor must surface as a visible flag with its reasoning, not a black-box score nudge (preserves the D-09/D-11 transparency contract).

**Candidate risk signals to explore:**

- **Maintenance-cycle prediction (renovation timing).** Major works recur on rough cycles — e.g. *stambyte* (pipe replacement) roughly every ~30–60 years, façade/*fasad* renovation, roof, windows. If the last stambyte was ~30 years ago, another is likely imminent → large future debt → downgrade + "Kommande stambyte trolig" risk flag. If the façade hasn't been touched in a long time, flag likely upcoming cost. **TODO: verify the real required/typical intervals per work type (regulatory + practical) before encoding thresholds.**
- **New-build inversion.** For a newly built BRF, high debt is *expected and usually fine* — they won't need major renovations for ~20–30 years. The same high-debt figure that's a red flag for an old building should be contextualized (or even neutral/positive) for a new one. The maintenance-cycle signal runs in reverse here.
- **Loan maturity + rate-curve exposure.** Extract the BRF's loan book — amounts, per-loan interest rates, and expiry/refinancing dates — and compare against the current/forward rate curve (Riksbank/market). A BRF forced to refinance a large loan into a higher-rate environment will likely raise avgift and/or grow debt over time → quantify and flag refinancing risk. (Overlaps and should be unified with **ADV-01** interest-rate stress test and **ADV-02** avgiftshöjning prediction in the v2 requirements — promote together.)

**FIRST STEP — investigate data availability (gates everything else).** Before any modelling, spike what's actually extractable across a sample of real årsredovisningar (and broker loan data sheets where available): is the loan book present (amounts, per-loan rates, expiry/refinancing dates)? Is renovation history present (last stambyte / fasadrenovering / inglasning, planned maintenance / underhållsplan)? Each risk signal below is only as good as the data feeding it, and availability is the main unknown — confirm feasibility per signal before committing to build.

**Design constraints:** keep the deterministic core as the auditable baseline; advanced signals layer on top as explained adjustments/flags. Any rule of thumb (e.g. stambyte interval) must cite a verifiable source. Degrade gracefully when a signal's data is absent (don't fabricate risk from missing data — surface "uppgift saknas" instead).
**Requirements:** ADV-01, ADV-02 (v2 Advanced Analysis) — likely promote/merge with them

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)

### Phase 999.5: Buyer due-diligence checklist (BACKLOG)

**Goal:** [Captured for future planning] A guided "have I checked everything critical?" checklist that orchestrates the whole product into a calm, step-by-step due-diligence flow. Most buyers don't *know* what they should check (BRF debt, loan maturity, upcoming stambyte, etc.) — the checklist removes that anxiety by making the unknowns explicit and tracking what's still missing. More a "how the product feels and works" layer than a new data source: it pulls from everything we already do and frames it as progress toward a complete picture.

**Shape (illustrative step order):**

1. Get the object data (paste Booli link → listing summary) — Phase 1.
2. Upload the BRF årsredovisning → financial overview + A–F score — Phase 2.
3. Provide the loan data sheets → loan book / maturity / rates (feeds 999.4 refinancing risk).
4. Provide / point to the document highlighting upcoming renovations + when the last major works were done (stambyte, fasadrenovering, inglasning av balkonger, tak, fönster) — feeds 999.4 maintenance-cycle prediction.
5. Market context (comparable prices, area stats) — Phase 3.
6. Final synthesized AI report + risk flags + PDF — Phase 4.

**Behavior:** each step shows done / pending / not-applicable, explains *why it matters* in plain Swedish, and ends with a "nothing critical missed" confidence summary. Gracefully handles steps the buyer can't complete (data unavailable) — shows them as known gaps rather than silently dropping them, so the buyer understands the limits of the analysis. Cross-cutting across Phases 1–4 + 999.4; best built once those data sources exist, as the connective UX tissue over them.
**Requirements:** DUE-01 (Future; cross-cutting; spans LSTG/BRF/PRICE/AREA/RPRT + 999.4)

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)

### Phase 999.8: Walkable 3D model from listing images (BACKLOG)

**Goal:** [Captured for future planning] Generate a 3D model of an apartment that the user can walk around inside, reconstructed from the images in the listing gallery.

**Feasibility:** verified — the user has seen someone build exactly this using existing libraries, so it's a known-possible, not a research bet.

**Related:** companion to 999.7 (both are image/vision-driven enrichment of a listing); consumes the same gallery images 999.7's condition/floor-plan analysis uses (now Phases 11–12).
**Requirements:** VIZ-01 (Future; 3D reconstruction from photos; interactive viewer)

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)
