# Project Research Summary

**Project:** Bostad AI — AI-powered Swedish property analysis
**Domain:** Proptech / AI analysis tool (scraping + PDF parsing + LLM + payments)
**Researched:** 2026-02-24
**Confidence:** MEDIUM-HIGH

## Executive Summary

Bostad AI fits a well-understood product category — on-demand AI analysis of specific listings — but is built on fragile foundations (web scraping) with a legally and technically complex data pipeline. The market gap is clear: no Swedish competitor combines listing data, BRF financials, and area statistics into a single AI-synthesized report. Allabrf (the incumbent, 200K monthly users) only does BRF data. BRFrapport and AI BRF are narrow and early-stage. The recommended approach is a Next.js frontend on Vercel, an Inngest event-driven pipeline handling the multi-step analysis, Supabase for auth/database/storage, the Apify-managed Booli scraper, Claude API for BRF PDF parsing and analysis, and Stripe for payments. Infrastructure cost is under $40/month at MVP scale.

The critical architectural decision is to run the analysis pipeline asynchronously via Inngest rather than as a synchronous function — the full pipeline takes 30-90 seconds and involves multiple external services that can each fail independently. Each step (scrape listing, parse BRF PDF, fetch area stats, run Claude analysis) must be independently retryable and contribute to a progress UI via Supabase Realtime. Graceful degradation — delivering a partial report when any data source fails — is a first-class requirement, not an afterthought.

The three biggest risks are: (1) scraping fragility — Booli is the only data source and can change or block access without notice; (2) AI hallucination in financial extraction — LLMs achieve ~56% accuracy on financial PDF tables, which is unacceptable when users make multi-million SEK decisions; and (3) legal exposure under the EU Database Directive if scraping ever moves beyond user-initiated, one-at-a-time requests. All three must be addressed architecturally in Phase 1, not patched after launch.

## Key Findings

### Recommended Stack

The stack is split between a TypeScript frontend (Next.js 16 on Vercel) and Python-native integrations orchestrated by Inngest. There is no separate FastAPI backend in the recommended architecture — Inngest functions run as Next.js API routes, calling Apify, Claude, Supabase, and Swedish public APIs directly. Python libraries like pymupdf4llm were considered but the architecture research settled on sending PDFs natively to Claude API (which handles Swedish K2/K3 formats without a separate parsing step). This eliminates an entire preprocessing pipeline.

**Core technologies:**
- Next.js 16 (Vercel): Frontend + API routes + Inngest endpoint — zero-ops deployment, handles auth, payment, report display
- Inngest: Event-driven pipeline orchestration — replaces synchronous functions, enables per-step retry and progress tracking
- Supabase: PostgreSQL database + auth + file storage + Realtime — bundles 4 services into one, free tier sufficient for MVP
- Claude API (Sonnet 4.6): BRF PDF parsing + analysis synthesis — handles Swedish, 200k context, structured JSON output
- Apify (lexis-solutions/booli-se-scraper): Managed Booli scraping — pre-built actor, proxy rotation handled, avoid building scraping infra
- Stripe: Payments in SEK — Embedded Checkout, subscription + per-analysis pricing

**Critical version notes:**
- Next.js 16.x with React 19.2 and Tailwind CSS 4.2 (CSS-first config, no tailwind.config.js)
- Supabase JS 2.97.x with @supabase/ssr (required for App Router cookie-based auth)
- SCB API is now PxWebApi v2 (migrated October 2025) — old v1 endpoints are stale
- K3 becomes mandatory for all BRFs from fiscal year 2026 — standardization improving over time

### Expected Features

No Swedish competitor combines listing, BRF, and area data. That is the gap and the product's reason to exist.

**Must have (table stakes):**
- Booli URL paste + listing data extraction — core input; everything depends on this
- BRF financial overview with A-F score — proven willingness to pay (Allabrf charges 99-149 SEK)
- BRF arsredovisning upload (manual) — auto-fetch is optimization, manual upload is MVP
- Price comparison vs recent sold properties in area — high value, low incremental cost via Booli scraper
- Red/green flag system — rule-based risk indicators (skuld/kvm thresholds, stambyte flags)
- AI-synthesized "vad du bor tanka pa" summary — the core differentiator, no Swedish competitor does this
- Shareable PDF report — justifies payment, shareable with partner
- Stripe payment (149 SEK/analysis) — validate willingness to pay before adding subscription
- Partial reports with gap prompts — graceful degradation when any data source fails

**Should have (competitive differentiators, add post-validation):**
- BRF arsredovisning auto-fetch (from Allabrf or Bolagsverket) — reduces friction
- Area statistics (SCB demographics, BRA crime, Skolverket schools) — no Swedish competitor includes this
- Interest rate stress test — low effort, high perceived value
- Avgiftshojning (fee increase) prediction — needs multi-year data, AI pattern recognition
- Subscription pricing (349 SEK/month) — add when repeat buyers emerge

**Defer (v2+):**
- Conversational Q&A / chat about listing — scope explosion, structured reports are more useful
- Custom valuation / price prediction — requires licensed transaction data (Maklarstatistik, Lantmateriet)
- Hemnet scraping — ToS explicitly prohibit it, legal risk is real
- Batch search / proactive "find best listings" — different product category entirely
- Norway/Denmark expansion — each country multiplies data integration work

### Architecture Approach

The recommended architecture is a Next.js monorepo (no separate Python backend) with Inngest handling the multi-step analysis pipeline as event-driven background functions. Each analysis step — scrape listing, fetch BRF report, fetch area stats, run Claude — is an independent Inngest step that can retry on failure without re-running successful steps. Parallel steps (comparable sales, area statistics, BRF fetch) run concurrently to minimize total time. Supabase Realtime pushes status updates to the report page so users see live progress without polling.

**Major components:**
1. Next.js App (Vercel) — landing, auth flows, URL input form, report display, payment initiation
2. Inngest Pipeline — orchestrates scrape → parse → analyze → store; handles retries and parallelism
3. Apify (Booli scraper) — scrapes listing data and comparable sold prices; maintained by Apify partner
4. Claude API — native PDF parsing of arsredovisningar + structured JSON analysis output
5. Public API integrators — SCB PxWebApi v2, BRA, Skolverket; fetched in Inngest steps
6. Supabase — Postgres (analysis records, users, payments), Storage (uploaded PDFs), Realtime (progress), Auth
7. Stripe — Checkout Sessions (149 SEK one-time), Subscriptions (349 SEK/month), Webhooks → Supabase entitlements

### Critical Pitfalls

1. **Scraping fragility** — treat every scraped field as "might be null tomorrow." Abstract the Booli scraper behind an interface. Run daily health-check scrapes on 3-5 known listings. Build partial reports from day one so scraper failure degrades gracefully, not catastrophically.

2. **AI hallucination in financial extraction** — never let Claude both extract and analyze numbers in a single step. Use structured output mode to force explicit field mapping with source page references. Implement sanity checks (skuld/kvm for Stockholm BRFs: 2,000-15,000 SEK; flag anything outside 500-50,000). Show source quotes alongside every financial claim. Manually verify first 50 reports.

3. **Legal exposure (EU Database Directive)** — user-initiated model only: one scrape per user request, never batch-scraping. Never permanently store raw Booli listing data. Transform scraped data into analysis output immediately. Respect robots.txt. Keep a legal contingency plan for Booli blocking access.

4. **API cost explosion** — budget maximum Claude cost per 149 SEK report (target: under 5 SEK / $0.50). Use model tiering: Haiku for extraction steps, Sonnet only for final synthesis. Cache SCB/BRA/Skolverket responses (30-day TTL). Track cost per analysis from the first deployed report and set alerts.

5. **PDF parsing unreliability** — BRF arsredovisningar vary wildly in layout (50+ different accounting firm templates). Test against 20+ diverse PDFs from different firms before launch. Implement per-field confidence scores. When confidence is low, prompt user for manual input rather than silently delivering wrong data.

## Implications for Roadmap

Based on the architecture's build-order dependencies and pitfall-phase mapping, a 5-phase structure is recommended:

### Phase 1: Foundation
**Rationale:** Everything requires auth, database, and basic Next.js structure. Cannot build anything else without this. Also the right time to address legal and security architecture that cannot be retrofitted.
**Delivers:** Supabase schema + auth, Next.js app shell with routing, environment configuration, URL validation (SSRF prevention), PDF deletion policy, basic error handling infrastructure.
**Addresses:** Auth-gated dashboard, responsive web shell (table stakes).
**Avoids:** Legal exposure (enforce user-initiated model from day one), GDPR (PDF retention policy set at the start, not patched later).
**Research flag:** Standard patterns — well-documented Next.js + Supabase auth setup. Skip deep research.

### Phase 2: Core Pipeline (the product)
**Rationale:** Architecture research is explicit: "Phase 2 is the proof-of-concept. If paste URL → AI analysis does not feel valuable with just listing data, adding BRF scoring and area stats will not save it." Validate the core loop before adding enrichment.
**Delivers:** Booli URL → Apify scrape → Claude analysis → basic report. Inngest pipeline with per-step retry. Supabase Realtime progress UI. Partial report infrastructure (graceful degradation from day one).
**Addresses:** Booli URL paste, listing summary, basic AI summary (P1 features).
**Avoids:** Synchronous pipeline anti-pattern (Inngest required here), scraping fragility (abstracted behind interface, health-check scraping, partial reports).
**Research flag:** Inngest integration patterns may need a focused research spike — the event-driven pipeline is not trivial to wire up correctly with Supabase Realtime progress.

### Phase 3: BRF Analysis
**Rationale:** The highest-value differentiator and the biggest technical risk (PDF parsing, hallucination). Build it as a dedicated phase so it can be tested thoroughly before payment is added.
**Delivers:** BRF arsredovisning upload → Claude PDF parsing (structured output) → A-F score → red/green flags → financial metrics with source quotes. Sanity checks on all extracted numbers. Per-field confidence scores. Manual correction flow.
**Addresses:** BRF financial overview, A-F score, red/green flags, arsredovisning upload (all P1 features).
**Avoids:** AI hallucination (separated extraction from analysis, sanity checks, source quotes shown), PDF parsing unreliability (tested against 20+ diverse PDFs, confidence scores).
**Research flag:** Needs deeper research on Claude structured output for Swedish K2/K3 financial formats and sanity check thresholds for BRF financial metrics.

### Phase 4: Monetization
**Rationale:** Architecture research places payment after a working report exists. Need real user reports to validate willingness to pay before adding payment friction.
**Delivers:** Stripe Embedded Checkout (149 SEK/analysis), webhook-driven entitlement in Supabase, payment gating on report access, Stripe tax (25% Swedish moms), shareable PDF report generation.
**Addresses:** Payment/paywall, shareable PDF report (P1 features).
**Avoids:** Stripe moms misconfiguration (use Stripe Tax), trusting client-side payment confirmation (webhook-only).
**Research flag:** Standard Stripe patterns — skip deep research. Swedish moms handling is the one non-obvious element.

### Phase 5: Data Enrichment + Polish
**Rationale:** Area statistics (SCB, BRA, Skolverket) and comparable sales enrich the report but are independent of BRF analysis. Add after core pipeline is stable and paying users exist. Caching and cost optimization belong here too.
**Delivers:** Price comparison vs sold properties, area statistics (demographics, crime, schools), interest rate stress test, BRF arsredovisning auto-fetch, SCB rate limiting + caching, Claude cost monitoring and model tiering.
**Addresses:** Price comparison, area statistics, stress test (P2 features).
**Avoids:** SCB API rate limiting (rate limiter + 30-day cache), API cost explosion (model tiering implemented here).
**Research flag:** SCB PxWebApi v2 (new API as of October 2025) and BRA/Skolverket data structures need a focused research spike. APIs are public but integration details are sparse.

### Phase Ordering Rationale

- Phase 1 before everything: auth and DB schema are prerequisites; legal architecture cannot be retrofitted after launch.
- Phase 2 before Phase 3: validates the core value prop with simpler data before adding the most complex, highest-risk feature (BRF PDF parsing).
- Phase 3 before Phase 4: payment should gate a fully working BRF report, not a partial one. Users should not pay 149 SEK for listing-only analysis.
- Phase 4 before Phase 5: start collecting revenue before adding enrichment features that increase complexity and cost.
- Phase 5 last: area statistics are differentiators, not table stakes. They make a good product great, but they don't make a broken product work.

### Research Flags

Phases needing deeper research during planning:
- **Phase 2:** Inngest + Supabase Realtime wiring, Apify webhook callback pattern vs. polling tradeoffs.
- **Phase 3:** Claude structured output schemas for Swedish K2/K3 financial statements, sanity check thresholds for BRF metrics across Swedish markets.
- **Phase 5:** SCB PxWebApi v2 table IDs and query patterns for relevant demographic/income data, BRA and Skolverket API availability and data formats.

Phases with standard patterns (can skip research-phase):
- **Phase 1:** Next.js + Supabase auth is extensively documented.
- **Phase 4:** Stripe Embedded Checkout + subscriptions is well-documented; Swedish moms handling is a known configuration.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All major versions verified against official sources (PyPI, changelogs, docs). Infrastructure costs calculated against known pricing. |
| Features | MEDIUM | Competitor analysis is solid (Allabrf, BRFrapport, AI BRF verified). International references (Zillow, Localize.city) provide directional confidence. Swedish AI-BRF competitors are new (2025 launches) so feature sets are still evolving. |
| Architecture | MEDIUM-HIGH | Inngest event-driven pattern is well-documented for Next.js. Claude native PDF support verified. SCB PxWebApi v2 confirmed. BRA and Skolverket integration details are thinner — verified they exist, not detailed API shapes. |
| Pitfalls | MEDIUM-HIGH | Scraping legal risks well-documented (EU Database Directive, Ryanair v. PR Aviation case). AI hallucination in financial extraction cited with specific accuracy data (56%). Swedish-specific legal risks (GDPR + BRF arsredovisning personal data) require ongoing monitoring as regulation evolves. |

**Overall confidence:** MEDIUM-HIGH

### Gaps to Address

- **BRA and Skolverket API details:** Confirmed as public data sources; exact API endpoints, data formats, and geographic mapping (postnummer/kommun codes) need validation during Phase 5 planning. Plan for possible scraping fallback.
- **Allabrf as structured data source:** Research mentions Allabrf as a potential source for common BRF metrics before falling back to PDF parsing. Allabrf is a website, not an API — scraping it carries the same legal risks as Booli. This dependency should be evaluated carefully before Phase 3 implementation.
- **Bolagsverket API for arsredovisningar:** Mandatory digital submission only starts from 2025 fiscal year. Historical reports (which buyers care about for trend analysis) may not be in the API. Need to define the historical data strategy (Allabrf fallback, user upload, accept the gap).
- **Apify actor maintenance risk:** The Booli scraper (lexis-solutions/booli-se-scraper) is maintained by a certified Apify partner but is a community actor. Assess whether to fork and self-maintain from Phase 2 onward.
- **Subscription pricing timing:** Research recommends per-analysis pricing first (149 SEK) and subscription second (349 SEK/month). The trigger for adding subscription is "seeing repeat buyers." Define what metric triggers this before Phase 4 closes.

## Sources

### Primary (HIGH confidence)
- [Next.js 16 Blog Post](https://nextjs.org/blog/next-16) — Turbopack stable, cache components, React 19.2
- [FastAPI PyPI](https://pypi.org/project/fastapi/) — Version 0.133.0, Python requirements
- [Anthropic Python SDK PyPI](https://pypi.org/project/anthropic/) — Version 0.83.0
- [Supabase Python PyPI](https://pypi.org/project/supabase/) — Version 2.28.0
- [pymupdf4llm PyPI](https://pypi.org/project/pymupdf4llm/) — Version 0.3.4, PDF-to-Markdown
- [Stripe Python PyPI](https://pypi.org/project/stripe/) — Version 14.3.0
- [Tailwind CSS v4.2 Release](https://tailwindcss.com/blog) — CSS-first config
- [Apify Booli Scraper](https://apify.com/lexis-solutions/booli-se-scraper) — Pre-built Booli.se scraper
- [SCB PxWebApi v2](https://www.scb.se/en/services/open-data-api/pxwebapi/) — New API released October 2025
- [Claude PDF Support](https://platform.claude.com/docs/en/build-with-claude/pdf-support) — Native PDF input
- [Claude Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) — JSON schema-guaranteed responses
- [Inngest Background Jobs for Next.js](https://www.inngest.com/blog/run-nextjs-functions-in-the-background) — Event-driven pipeline pattern
- [Allabrf.se](https://sv.allabrf.se/) — Competitor analysis, 200K+ monthly users, A++ to C rating
- [BRFrapport.se](https://brfrapport.se/) — Free AI-powered BRF analysis, launched August 2025
- [AI BRF (aibrf.se)](https://aibrf.se/) — 69 SEK BRF analysis
- [Bolagsverket API](https://bolagsverket.se/apierochoppnadata.2531.html) — Official BRF submission API
- [BRF K3 Mandatory from 2026](https://www.fastighetsagarna.se/aktuellt/nyheter/2024/sverige/brfs-arsredovisning-for-2025-och-framat-ska-skickas-till-bolagsverket/) — New law
- [EU Database Directive — IAPP](https://iapp.org/news/a/the-state-of-web-scraping-in-the-eu) — Legal scraping landscape
- [Ryanair v. PR Aviation](https://www.pinsentmasons.com/out-law/news/website-operators-can-prohibit-screen-scraping-of-unprotected-data-via-terms-and-conditions-says-eu-court-in-ryanair-case) — CJEU ruling on ToS-based scraping

### Secondary (MEDIUM confidence)
- [LLM Financial Table Extraction Accuracy — MDPI](https://www.mdpi.com/2073-431X/13/10/257) — ~56% accuracy on financial document QA
- [Inngest Real-time Progress Updates](https://www.inngest.com/blog/background-jobs-realtime-nextjs) — Live status updates from background jobs
- [Zillow AI features 2025-2026](https://www.geekwire.com/2026/zillow-at-20-real-estate-giant-leans-on-ai-to-make-homebuying-hurt-less/) — International reference
- [Localize.city features](https://www.builtinnyc.com/articles/localize-raises-25m-series-c) — Neighborhood data reference
- [Railway Pricing](https://railway.com/pricing) — $5/mo Hobby plan (pricing may change)
- [Vercel Pricing](https://vercel.com/pricing) — Free tier limits (pricing may change)

### Tertiary (LOW confidence — needs validation during implementation)
- BRA API — data format and geographic mapping unverified beyond existence
- Skolverket API — same as BRA
- Allabrf as structured data source — website, not API; reliability and legal status unclear

---
*Research completed: 2026-02-24*
*Ready for roadmap: yes*
