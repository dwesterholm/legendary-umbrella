# Bostad AI

## What This Is

An AI-powered property analysis tool for the Swedish market. A buyer pastes a Booli listing URL and gets an instant, independent analysis — BRF financial health, price comparison against nearby sold properties, area statistics, and AI-generated risk/opportunity flags. Think "second opinion on a 4 million SEK decision" delivered in seconds.

## Core Value

Give Swedish home buyers an independent, data-driven analysis of any listing — the one thing their mäklare won't provide. If nothing else works, the paste-a-URL → AI report flow must.

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

### Active (next milestone candidates)

- [ ] Auto-fetch BRF årsredovisning from Allabrf/Bolagsverket (only PDF-upload path shipped in v1.0)
- [ ] Area statistics from BRÅ (crime) and Skolverket (schools) — only SCB demographics shipped in v1.0
- [ ] Payment via Stripe (SEK 149/analysis or SEK 349/month subscription) — PAY-01/02, deferred from v1.0
- [ ] Deeper enrichment + advanced analysis — see ROADMAP Backlog (999.1–999.8)

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

**Legal:** Scraping Booli carries some risk but user-initiated model (user pastes URL they're already viewing) minimizes exposure. BRF reports are public records. No license required for property analysis in Sweden. Disclaimers essential ("ej finansiell rådgivning").

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

---
*Last updated: 2026-07-06 after v1.0 MVP milestone*
