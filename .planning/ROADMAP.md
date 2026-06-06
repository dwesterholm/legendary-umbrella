# Roadmap: Bostad AI

## Overview

Bostad AI delivers an AI-powered property analysis tool for the Swedish market in four phases. Phase 1 establishes the core input mechanism (paste Booli URL, get listing data). Phase 2 adds the primary differentiator (BRF financial analysis from arsredovisning PDFs). Phase 3 enriches the report with market context (comparable prices, area demographics). Phase 4 synthesizes everything into a polished AI report with risk flags and PDF export. Each phase delivers a verifiable, standalone capability that builds on the previous.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation + Core Pipeline** - App shell, Booli scraping, and listing data display (completed 2026-06-06)
- [ ] **Phase 2: BRF Financial Analysis** - PDF upload, financial extraction, and A-F health scoring
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
**Plans**: TBD

Plans:
- [ ] 02-01: TBD
- [ ] 02-02: TBD

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
| 2. BRF Financial Analysis | 0/0 | Not started | - |
| 3. Market Context | 0/0 | Not started | - |
| 4. AI Report + Delivery | 0/0 | Not started | - |
