# Bostad AI

## What This Is

An AI-powered property analysis tool for the Swedish market. A buyer pastes a Booli listing URL and gets an instant, independent analysis — BRF financial health, price comparison against nearby sold properties, area statistics, and AI-generated risk/opportunity flags. Think "second opinion on a 4 million SEK decision" delivered in seconds.

## Core Value

Give Swedish home buyers an independent, data-driven analysis of any listing — the one thing their mäklare won't provide. If nothing else works, the paste-a-URL → AI report flow must.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] User can paste a Booli URL and get a structured AI analysis of the listing
- [ ] System scrapes listing data (price, size, avgift, BRF name, address, byggår, våning, rum) from Booli via Apify
- [ ] Claude generates a structured report from scraped listing data
- [ ] System auto-fetches BRF årsredovisning from Allabrf/Bolagsverket when available
- [ ] User can upload BRF årsredovisning PDF as fallback when auto-fetch fails
- [ ] Claude parses BRF årsredovisning and extracts key financials (skuld/kvm, avgiftstrend, underhållsplan, kassaflöde)
- [ ] BRF health score (A–F) based on financial metrics
- [ ] System scrapes comparable sold prices from Booli for the same area/building
- [ ] Price comparison: listing vs sold prices in area (pris/kvm vs snitt, trend)
- [ ] Area statistics from SCB (demographics, income), BRÅ (crime), Skolverket (schools)
- [ ] Red/green flags: high BRF debt, planned stambyte, recent renovations, avgiftshöjning
- [ ] AI summary: "vad du bör tänka på" — synthesized assessment
- [ ] Partial reports when some data sources fail, with prompts to fill gaps
- [ ] Payment via Stripe (SEK 149/analysis or SEK 349/month subscription)

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

**Validation:** No validation done yet. Plan is to build MVP first, then validate with real users. Kill criteria: need paying users within first months of launch.

## Constraints

- **Solo developer**: Side project, 5–10h/week — scope must stay tight
- **Budget**: Near-zero. Infrastructure costs must stay under ~$100/month
- **Data access**: Cannot depend on licensed data (Lantmäteriet, Mäklarstatistik) until revenue justifies it
- **Legal**: Must avoid scraping that creates legal liability — user-initiated model preferred
- **Scraping fragility**: Booli frontend changes will break scrapers — need graceful degradation

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Booli as listing data source (not Hemnet directly) | Apify scraper exists, less legal exposure than Hemnet | — Pending |
| BRF analysis as core differentiator | Public data, proven willingness to pay (Allabrf pricing), unique AI angle | — Pending |
| Build MVP before validation | Developer wants working product to validate with, not just landing page | — Pending |
| Per-analysis + subscription pricing | SEK 149/analysis captures casual users, SEK 349/month captures active searchers | — Pending |
| Claude for analysis (not custom models) | Handles Swedish well, no ML infrastructure needed, fast iteration on prompts | — Pending |

---
*Last updated: 2026-02-24 after initialization*
