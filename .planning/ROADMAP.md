# Roadmap: Bostad AI

## Overview

Bostad AI delivers an AI-powered property analysis tool for the Swedish market in four phases. Phase 1 establishes the core input mechanism (paste Booli URL, get listing data). Phase 2 adds the primary differentiator (BRF financial analysis from arsredovisning PDFs). Phase 3 enriches the report with market context (comparable prices, area demographics). Phase 4 synthesizes everything into a polished AI report with risk flags and PDF export. Each phase delivers a verifiable, standalone capability that builds on the previous.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation + Core Pipeline** - App shell, Booli scraping, and listing data display (completed 2026-06-06)
- [x] **Phase 2: BRF Financial Analysis** - PDF upload, financial extraction, and A-F health scoring (completed 2026-06-16 — UAT 7/7, security 20/20 threats closed)
- [ ] **Phase 3: Market Context** - Comparable sold prices and area demographics
- [ ] **Phase 4: AI Report + Delivery** - Synthesized AI assessment, risk flags, and PDF export

## Phase Details

### Phase 1: Foundation + Core Pipeline

**Goal**: User can paste a Booli listing URL and see a structured summary of the property's key data
**Depends on**: Nothing (first phase)
**Requirements**: LSTG-01, LSTG-02
**Success Criteria** (what must be TRUE):

  1. User can paste a Booli URL into an input field and trigger an analysis
  2. System extracts listing data (price, size, avgift, rooms, byggar, address, BRF name) from the Booli URL
  3. User sees a structured, clearly formatted listing summary with all extracted data points
  4. User can create an account, log in, and see their previous analyses in a dashboard
  5. When Booli scraping fails or returns partial data, the user sees a clear error or partial result (not a crash)

**Plans:** 3 plans

Plans:

- [x] 01-01-PLAN.md — Project setup: Next.js 16, Tailwind v4 theme, Supabase config, auth pages, database schema
- [x] 01-02-PLAN.md — Core pipeline: Apify scraping, Zod schemas, server action, listing UI, coming-soon sections
- [x] 01-03-PLAN.md — Dashboard: analysis history card grid, end-to-end verification

### Phase 2: BRF Financial Analysis

**Goal**: User can upload a BRF arsredovisning and see a financial health assessment with a transparent A-F score
**Depends on**: Phase 1
**Requirements**: BRF-01, BRF-02, BRF-03
**Success Criteria** (what must be TRUE):

  1. User can upload a BRF arsredovisning PDF for any analysis
  2. System extracts and displays key BRF financials (skuld/kvm, avgiftsniva, kassaflode, underhallsplan status) from the uploaded PDF
  3. System assigns a BRF health score (A-F) with visible explanation of what drove the score
  4. When PDF parsing produces low-confidence results, user sees which fields are uncertain rather than silently wrong numbers

**Plans**: 6 plans
Plans:
**Wave 1**

- [x] 02-01-PLAN.md — Wave 0: install Vitest/Promptfoo + RED deterministic-core tests (scorer, sanity, cost, schema)
- [x] 02-02-PLAN.md — Migration: brf-pdfs private bucket, RLS, brf_* columns, analyses UPDATE policy, schema push
- [x] 02-03-PLAN.md — Deterministic core: brfExtractionSchema + normalizer, A–F scorer (D-08), sanity bands (D-10), cost

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 02-04-PLAN.md — Extraction: versioned prompt + single Haiku call (citations/caching) + analyzeBrf/correctBrfField actions

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 02-05-PLAN.md — Upload + progress UI: dropzone (D-05 gate), live status (D-13), wire into analysis page (D-04)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 02-06-PLAN.md — Score card (D-07/D-10/D-11/D-12) + public "Så räknar vi" methodology page (D-09)

### Phase 3: Market Context

**Goal**: User can see how a listing's price compares to recent sales in the area and understand the neighborhood demographics
**Depends on**: Phase 1
**Requirements**: PRICE-01, AREA-01
**Success Criteria** (what must be TRUE):

  1. User sees a price comparison showing listing price vs recently sold properties in the same area/building (pris/kvm, area average, trend direction, sample size)
  2. User sees SCB-sourced neighborhood demographics (income levels, population trends) for the listing's location
  3. When comparable sales data or SCB data is unavailable, the report still loads with the available sections

**Plans**: TBD

Plans:

- [ ] 03-01: TBD
- [ ] 03-02: TBD

### Phase 4: AI Report + Delivery

**Goal**: User receives a complete, opinionated AI analysis combining all data sources into an actionable report they can download and share
**Depends on**: Phase 2, Phase 3
**Requirements**: RPRT-01, RPRT-02, RPRT-03
**Success Criteria** (what must be TRUE):

  1. User sees an AI-generated "vad du bor tanka pa" summary that synthesizes listing data, BRF financials, price comparisons, and area statistics into an opinionated assessment
  2. User sees clearly labeled red and green flags for risk indicators (high BRF debt, planned stambyte, avgiftshojning, unusual pricing patterns)
  3. User can download and share the complete analysis as a PDF report
  4. The AI summary references specific data points from the analysis (not generic advice)

**Plans**: TBD

Plans:

- [ ] 04-01: TBD
- [ ] 04-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation + Core Pipeline | 3/3 | Complete | 2026-06-06 |
| 2. BRF Financial Analysis | 6/6 | Complete    | 2026-06-16 |
| 3. Market Context | 0/0 | Not started | - |
| 4. AI Report + Delivery | 0/0 | Not started | - |

## Backlog

### Phase 999.1: Proprietary price estimator (BACKLOG)

**Goal:** [Captured for future planning] Build a price estimator that beats Booli's "value based price." Booli's dropdown exposes which reference objects drive their estimate — ours would weigh historical data, trends, floor level, balcony, BRF debt, and more. Prior art: a friend's hand-built scraper + estimator outperformed Booli's during his own apartment search. Synergy: actor already returns Booli's `estimate` and `listSqmPrice` for benchmarking.

**Sun exposure tracking:** Track how the sun hits the apartment from the address (friend did this via a mix of sun-tracking websites — feasibility unconfirmed but probably doable). The actor already returns `latitude`/`longitude`, so sun-path computation (e.g. suncalc-style libraries or APIs) is a candidate beyond scraping websites. Standalone value even outside the estimator: a UI where the user sees a map preview (Google Maps) and can visually drag the sun's position through the day — possibly via iframe embed of an existing sun-tracking site (e.g. ShadeMap/SunCalc.org-style tools), or built natively. Sun exposure is also a plausible estimator feature (sunny balconies price higher).
**Requirements:** TBD
**Plans:** 6/6 plans complete

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)

### Phase 999.2: Deeper listing extraction via broker sites (BACKLOG)

**Goal:** [Captured for future planning] Extract more detail per listing than the Booli actor provides — potentially following through to the broker's own page (actor already returns `agencyListingUrl`, e.g. Vitec links). Could recover fields the actor lacks: floor, balcony, BRF name, renovation status, full description.
**Requirements:** TBD
**Plans:** 0 plans

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)

### Phase 999.3: Macro-driven price estimates (BACKLOG)

**Goal:** [Captured for future planning] Feed macroeconomic indicators (interest rates, inflation, regional price indices — SCB/Riksbank data) into valuations so estimates aren't purely based on a few comparable sales. Natural companion to 999.1 (estimator) and Phase 3 (SCB integration groundwork).
**Requirements:** TBD
**Plans:** 0 plans

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
**Requirements:** relates to ADV-01, ADV-02 (v2 Advanced Analysis) — likely promote/merge with them
**Plans:** 0 plans

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
**Requirements:** TBD (cross-cutting; spans LSTG/BRF/PRICE/AREA/RPRT + 999.4)
**Plans:** 0 plans

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)
