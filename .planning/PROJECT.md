# Bostad AI

## What This Is

An AI-powered property analysis tool for the Swedish market. A buyer pastes a Booli listing URL and gets an instant, independent analysis — BRF financial health, price comparison against nearby sold properties, area statistics, and AI-generated risk/opportunity flags. Think "second opinion on a 4 million SEK decision" delivered in seconds.

## Core Value

Give Swedish home buyers an independent, data-driven analysis of any listing — the one thing their mäklare won't provide. If nothing else works, the paste-a-URL → AI report flow must.

## Current State

- ✅ **v1.0 MVP** shipped 2026-07-06 (Phases 1–4).
- ✅ **v1.1 Owned Data Layer & Intelligent Discovery** shipped code-complete 2026-07-07 (Phases 5–12; 27 plans; 629 tests; migrations 006–011 live). Archive: `milestones/v1.1-ROADMAP.md` · audit: `milestones/v1.1-MILESTONE-AUDIT.md`.
  - **Discovery surface (Phases 9–12): legal go/no-go = GO (operator, 2026-07-08); `DISCOVERY_ENABLED` now ON** in the operator env. The flag is retained as the runtime kill switch (not removed). Live validation gates (Phase 11 20–30-listing accuracy gate + Phase 12 floor-plan hedging kill-criterion, see phase `*-UAT.md`) still stand as separate operator checks. Phases 5–8 (owned acquisition, broker extraction, macro context, BRF auto-fetch) are independently shippable after lighter live smoke checks.
- 🔨 **v1.2 Renovator-Grade Discovery Analysis** started 2026-07-17. The discovery data layer is solid; **analysis quality is the gap** — turn the image-only condition read into a holistic, ROI-aware, buyer-tailored opportunity brief per candidate, and fix the poll-timeout UX that the richer scrape surfaced. Cores already built + tested on `main` (`flip-economics.ts`, `area-comps.ts`, pre-filter/triage flips); this milestone wires them into the live analysis. See `.planning/research/2026-07-10-ANALYSIS-REDESIGN-SPEC.md`.

## Current Milestone: v1.2 Renovator-Grade Discovery Analysis

**Goal:** Turn the discovery surface's AI from image-only condition notes into a holistic, ROI-aware, buyer-tailored opportunity brief per candidate — acting like a renovator / interior-designer / architect — and make the now-live discovery flow finish within the client's patience window.

**Target features:**
- **Poll-timeout UX fix** — the richer scrape (315 listings + vision) must complete without the user having to reload (parallelize across areas / stream partial / cap per-page retries); add the missing `vision_processing` Swedish status label.
- **Analysis brain (Phase A)** — no-empty-analysis fallback; wire holistic inputs (re-resolved area comps R_med/U_med + per-candidate BRF summary) into the deep-pass payload; ROI-aware, buyer-segment, tiered cost/profit ±tax prompt + `OpportunityBrief` schema (with a live Anthropic strict-output smoke).
- **Value-gap scoring (Phase B)** — wire `valueGap()` into the ranking tiebreaker + "från bildtolkning" UI marker; extend the separation static-grep test.
- **Proposed planritning (Phase C)** — image-gen redraw for HIGH value-gap candidates only, daylight/bearing caveats stamped; provider TBD; bounded by cost caps.

**Locked constraints:** `niche-score.ts` / `flags.ts` must never import vision/value-gap/area-comps types (static-grep enforced); all analysis reads go through the `condition-score.ts`-style path + "från bildtolkning" marker. **Low kr/m² ≠ reno object** — surfacing signal only; analysis normalizes against confounders (floor, elevator, balcony, micro-location, sub-area, tomträtt, BRF debt) before attributing to condition. No DB migration (rides in JSONB `results`). `DISCOVERY_ENABLED` fail-closed + cost caps respected; GDPR — broker/gallery images analyze-only, never persisted.

## Shipped Milestone: v1.1 Owned Data Layer & Intelligent Discovery

**Goal (achieved in code):** Own the Booli acquisition pipeline end-to-end, extract richer per-listing data, and evolve the product from "analyze one pasted URL" into "describe what you want and let AI find & assess it" — while enriching valuation context and cutting the manual BRF-upload step.

**Target features:**
- Own the Booli acquisition layer — replace the paid Apify actor with an owned `booli-graphql` client + fallback tree (999.6; feasibility spike gates the migration)
- Deeper listing extraction — recover floor, balcony, BRF name, renovation status, full description via broker pages (999.2)
- Macro-driven price context — feed SCB/Riksbank macro indicators into the Phase 3 market-context layer (999.3)
- AI free-text listing discovery + vision scraper — agentic area-wide scrape, vision analysis of description/gallery/floor-plan images, configurable niche ranking, sun-path exposure (999.7)
- Auto-fetch BRF årsredovisning from Allabrf/Bolagsverket — supplement with manual PDF upload as fallback

## Requirements

### Validated

- ✓ Paste a Booli URL → structured listing analysis — v1.0 (LSTG-01/02)
- ✓ Scrape listing data (price, size, avgift, BRF name, address, byggår, våning, rum) from Booli via Apify — v1.0
- ✓ Claude generates a structured report from the combined data — v1.0 (RPRT-01)
- ✓ Upload BRF årsredovisning PDF — v1.0 (BRF-03)
- ✓ Claude parses BRF årsredovisning → key financials (skuld/kvm, avgiftsnivå, kassaflöde, underhåll) — v1.0 (BRF-01)
- ✓ BRF health score (A–F) with transparent methodology — v1.0 (BRF-02)
- ✓ Scrape comparable sold prices from Booli for the area — v1.0 (PRICE-01)
- ✓ Price comparison: listing vs area sold prices (pris/kvm vs snitt, trend, confidence) — v1.0 (PRICE-01)
- ✓ Area demographics from SCB (population, income, tenure) at DeSO precision — v1.0 (AREA-01)
- ✓ Red/green risk flags (high BRF debt, planned stambyte, avgiftshöjning, unusual patterns) — v1.0 (RPRT-02)
- ✓ AI summary "vad du bör tänka på" — synthesized, cited, no buy/sell verdict — v1.0 (RPRT-01)
- ✓ Partial reports when a source fails — honest "Ej tillgänglig", no fabrication — v1.0 (D-07)
- ✓ Download analysis as PDF report (å/ä/ö correct, login-gated) — v1.0 (RPRT-03)
- ✓ Own the Booli acquisition layer — owned client + observable fallback tree — v1.1 (ACQ-01/02/03)
- ✓ Deeper listing extraction via broker sites — floor, balcony, BRF name, renovation, description — v1.1 (LSTG-03/04)
- ✓ Macro-driven price context — Riksbank/SCB indicators into market-context layer — v1.1 (MACRO-01/02)
- ✓ Auto-fetch BRF årsredovisning from Allabrf, manual upload as fallback — v1.1 (ENRICH-01/02)
- ✓ AI free-text listing discovery — cost-capped background area search — v1.1 (DISC-01/02/07)
- ✓ Configurable niche ranking of discovery candidates — v1.1 (DISC-03)
- ✓ Hedged, image-cited gallery condition vision — v1.1 (DISC-04)
- ✓ Floor-plan investigation-prompts + theoretical sun-path — v1.1 (DISC-05/06)

### Active (v1.2 — scoped in REQUIREMENTS.md)

- [ ] Discovery flow completes within the client poll window (no forced reload)
- [ ] Holistic per-candidate analysis — fold BRF (avgift/debt/stambyte) + renovated-vs-unrenovated comps into the value case
- [ ] Every surfaced candidate gets ≥1 actionable opportunity (no empty `claims: []`)
- [ ] ROI-aware, buyer-segment-tailored opportunity brief — tiered cost/profit bands, profit shown with & without tax
- [ ] Value-gap headline metric that also re-orders discovery results (separate read path)
- [ ] Proposed planritning (image-gen) for HIGH value-gap candidates, with daylight/bearing caveats

### Deferred (future milestone candidates)

- [ ] Proprietary price estimator that beats Booli's estimate (999.1)
- [ ] Advanced BRF risk analysis — loan-book/refinancing risk, stambyte prediction, new-build inversion (999.4)
- [ ] Buyer due-diligence checklist — connective UX layer over all phases (999.5)
- [ ] Walkable 3D model from listing images (999.8)
- [ ] Area statistics from BRÅ (crime) and Skolverket (schools) — only SCB demographics shipped in v1.0
- [ ] Payment via Stripe (SEK 149/analysis or SEK 349/month subscription) — PAY-01/02, deferred from v1.0

### Out of Scope

- Mobile native app — web-first, responsive is enough
- Real-time chat/conversational AI assistant — structured reports only for v1
- "Find best listings" batch search feature — requires proactive Hemnet crawling, defer post-validation
- Area comparison/recommendation tool — natural expansion but not MVP
- B2B features (bank integrations, mäklare tools) — revisit after consumer validation
- OAuth/social login — email/password sufficient
- Hemnet scraping — Booli only, avoids legal complications with Hemnet ToS directly
- Norway/Denmark expansion — validate Sweden first
- Custom valuation algorithms — Claude's reasoning substitutes for statistical models in v1

## Context

**Market:** ~100,000–120,000 transactions/year in Sweden, average price SEK 3–4M nationally (4–6M+ in Stockholm). Hemnet has 2.5–3M monthly uniques. No existing product combines AI analysis with BRF scoring and listing evaluation.

**Competitive landscape:** Allabrf.se does basic BRF scoring (SEK 149–499/report, no AI). Hemnet/Booli provide raw data, no analysis. No Swedish product does what this does.

**Data access:**
- Open/free: SCB API (demographics, income, price indices), BRÅ (crime), Skolverket (schools), BRF årsredovisningar via Bolagsverket
- Scraping (gray zone): Booli listing data and sold prices via Apify
- Expensive/locked: Lantmäteriet property register, Mäklarstatistik transaction data

**Legal:** Scraping Booli carries some risk but the user-initiated model (user pastes URL they're already viewing) minimizes exposure. BRF reports are public records. No license required for property analysis in Sweden. Disclaimers essential ("ej finansiell rådgivning").

**Legal — v1.1 Discovery (Phase 9+), FINAL GO (operator decision 2026-07-08):** Phase 9 introduces *proactive, area-wide* scraping to build candidate sets — a materially different legal fact-pattern than the v1.0 user-initiated model. The operator has made the **final legal go/no-go call: GO**, superseding the 2026-07-06 provisional/conservative-GO posture. Discovery proceeds with strict per-query/per-day request caps, hard per-search cost/candidate/image caps, and PII guardrails enforced in code. The `DISCOVERY_ENABLED` feature flag is **retained** as the runtime control / kill switch (defence-in-depth: `startDiscovery` and the sweep route fail closed unless it is exactly `"true"`) and is now enabled in the operator environment. This line supersedes the user-initiated-only framing for discovery features only; all v1.0 analysis remains user-initiated.

**Tech:** Claude handles Swedish real estate terminology well. BRF årsredovisningar follow standardized K2/K3 formats — good for LLM parsing.

**Validation:** No user validation done yet. MVP is now built (v1.0 shipped 2026-07-06) — the paste-URL → BRF score → market context → AI report → PDF flow works end-to-end. Next: validate with real users. Kill criteria: need paying users within first months of launch (payment not yet built — deferred to a post-v1.0 milestone).

**Current state (v1.0, 2026-07-06):** ~11.5k LOC TypeScript. Stack: Next.js 16, Supabase (auth + Postgres/RLS), Tailwind v4, Claude (Haiku for BRF extraction, Sonnet for report synthesis), Apify (Booli listing + slutpriser scraping), SCB PxWebApi, @react-pdf/renderer. All 4 phases verified; 175 unit tests green. Known tech debt tracked in MILESTONES.md and the v1.0 audit.

## Constraints

- **Solo developer**: Side project, 5–10h/week — scope must stay tight
- **Budget**: Near-zero. Infrastructure costs must stay under ~$100/month
- **Data access**: Cannot depend on licensed data (Lantmäteriet, Mäklarstatistik) until revenue justifies it
- **Legal**: Must avoid scraping that creates legal liability — user-initiated model preferred
- **Scraping fragility**: Booli frontend changes will break scrapers — need graceful degradation

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Booli as listing data source (not Hemnet directly) | Apify scraper exists, less legal exposure than Hemnet | ✓ Good — shipped v1.0; slutpriser also read via Apify Playwright after the Cloudflare blocker |
| BRF analysis as core differentiator | Public data, proven willingness to pay (Allabrf pricing), unique AI angle | ✓ Good — A–F score shipped v1.0 with transparent methodology |
| Build MVP before validation | Developer wants working product to validate with, not just landing page | ✓ Good — full MVP shipped v1.0, ready to validate |
| Per-analysis + subscription pricing | SEK 149/analysis captures casual users, SEK 349/month captures active searchers | — Pending — payment not yet built (deferred post-v1.0) |
| Claude for analysis (not custom models) | Handles Swedish well, no ML infrastructure needed, fast iteration on prompts | ✓ Good — Haiku (BRF extract) + Sonnet (synthesis) shipped; deterministic flags/score kept in code, not the LLM |
| Deterministic flags/score in code, LLM for synthesis only | Trust + reproducibility: no model-minted flags, no buy/sell verdict, every claim cited | ✓ Good — v1.0; enforced by schema (no verdict field) + pure computeFlags |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-07-17 — milestone v1.2 (Renovator-Grade Discovery Analysis) started*
