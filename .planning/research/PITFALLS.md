# Pitfalls Research

**Domain:** AI-powered Swedish real estate analysis (proptech, web scraping, BRF financial parsing)
**Researched:** 2026-02-24
**Confidence:** MEDIUM-HIGH (domain-specific risks well-documented; Swedish legal specifics require ongoing monitoring)

## Critical Pitfalls

### Pitfall 1: Scraping Fragility — Building a Product on HTML You Don't Control

**What goes wrong:**
Booli (or any listing source) changes their frontend — new React components, different class names, restructured DOM — and your Apify scraper silently returns empty or incorrect data. The product appears to work but delivers garbage reports. Worse: Booli could add Cloudflare bot protection or rate-limit aggressively, killing the entire data pipeline overnight.

**Why it happens:**
Developers treat scraping like an API. It's not. HTML structure is an implementation detail, not a contract. Sites redesign without notice. Apify community actors depend on individual maintainers who may abandon them. Booli is owned by Hemnet (acquired 2020), and Hemnet has zero incentive to make scraping easy — they sell data access commercially.

**How to avoid:**
- Treat every scraped field as "might be null tomorrow." Build the entire report pipeline around partial data from day one.
- Run a daily health-check scraper against 3-5 known listings. Alert immediately if field extraction rates drop below 95%.
- Abstract the data source behind an interface so you can swap Booli scraper for Hemnet scraper, or an official API, without rewriting report logic.
- Cache scraped data aggressively — if the scraper breaks, you can still serve reports for recently-scraped listings while you fix it.
- Build your own scraper rather than depending on a third-party Apify actor you cannot fix when it breaks.

**Warning signs:**
- Apify actor hasn't been updated in 60+ days
- Intermittent null fields in scraped data
- Scraper success rate drops from 100% to 90% (partial breakage precedes total breakage)
- Booli adds new URL patterns or redirects

**Phase to address:**
Phase 1 (MVP). The scraper IS the product. If it breaks, nothing works. Build with graceful degradation from the start.

---

### Pitfall 2: AI Hallucination in Financial Analysis — Confident Wrong Numbers

**What goes wrong:**
Claude generates a BRF health report that states skuld/kvm is 4,200 SEK when the actual figure from the årsredovisning is 42,000 SEK. Or it fabricates a planned stambyte that doesn't exist. The user makes a multi-million SEK purchase decision based on hallucinated financial data. Research shows LLMs achieve only ~56% accuracy on financial table extraction from PDFs — essentially a coin flip.

**Why it happens:**
LLMs are text prediction machines, not calculators. They confidently interpolate between patterns. Swedish financial terminology (e.g., "skuldsättning per kvadratmeter," "fond för yttre underhåll") has limited representation in training data. When Claude encounters an ambiguous PDF table, it guesses — and guesses confidently. Table headers like "Skulder" appear in multiple contexts (long-term, short-term, total), and LLMs frequently pull values from the wrong row.

**How to avoid:**
- Never let Claude both extract AND analyze numbers in a single step. Separate extraction (structured output with explicit field mapping) from analysis (reasoning over verified numbers).
- Use structured output / JSON mode for financial extraction. Force Claude to output `{"skuld_per_kvm": 42000, "source_page": 12, "source_text": "Skulder per kvm..."}` so you can audit.
- Implement sanity checks: skuld/kvm for Stockholm BRFs typically ranges 2,000-15,000 SEK. Flag anything outside 500-50,000 as likely extraction error.
- Show source quotes alongside every financial claim in the report. Users can verify.
- Add explicit disclaimer: "Siffrorna är AI-extraherade och kan innehålla fel. Verifiera alltid mot originalhandlingar."

**Warning signs:**
- Numbers in reports that are off by orders of magnitude (decimal point errors)
- Claude reporting financial metrics that don't exist in the source document
- Inconsistencies between related numbers (e.g., total skuld doesn't match skuld/kvm * total area)
- Users reporting inaccuracies in the first weeks

**Phase to address:**
Phase 1-2 (MVP and iteration). This is the single biggest reputational risk. A wrong BRF score on skuld could cause real financial harm.

---

### Pitfall 3: PDF Parsing Unreliability for BRF Arsredovisningar

**What goes wrong:**
BRF annual reports come as PDFs with wildly different layouts. Some are OCR scans of printed documents. Some use tables rendered as positioned text boxes (not actual HTML tables). Some embed financial data in images. Your parser works for the 5 test PDFs you tried, then fails on the 6th because a different accounting firm (Deloitte vs. Grant Thornton vs. local redovisningsbyrå) uses a completely different template.

**Why it happens:**
There is no enforced digital standard for BRF arsredovisningar today. While K2/K3 standardizes what information must be reported, it says nothing about PDF layout. Each of the ~50 redovisningsbyråer that serve BRFs uses their own template. From 2025, BRFs must submit to Bolagsverket, and K3 becomes mandatory for all BRFs from fiscal year 2026 — this will improve standardization over time, but historical reports (which buyers care about for trend analysis) remain a mess.

**How to avoid:**
- Accept that you cannot parse 100% of PDFs automatically. Design for "AI-assisted extraction with human verification" — not "fully automated."
- Use Claude's vision capabilities (send PDF pages as images) rather than text extraction for complex layouts. Vision handles positioned text better than text extraction for non-standard tables.
- Build a library of test PDFs from different accounting firms (SBC, Riksbyggen, HSB, Deloitte, Grant Thornton, local firms). Test against at least 20 diverse examples before launch.
- Implement a confidence score for each extracted field. If confidence is low, prompt the user: "Vi kunde inte säkert avläsa skuldsättningen. Kan du ange värdet manuellt?"
- Start with Allabrf as a structured data source for common BRF metrics, and only fall back to PDF parsing when Allabrf data is missing.

**Warning signs:**
- Parser works on test PDFs but fails on first real user upload
- Extraction accuracy varies dramatically between documents
- Text extraction returns garbled Swedish characters (encoding issues with å, ä, ö)
- Tables extracted as single long strings instead of structured data

**Phase to address:**
Phase 2 (BRF analysis feature). Don't try to solve this in MVP — start with Allabrf data or manual upload with AI-assisted extraction, not fully automated PDF parsing.

---

### Pitfall 4: Legal Exposure — EU Database Directive, ToS Violations, GDPR

**What goes wrong:**
Booli sends a cease-and-desist letter. Or worse: Hemnet (Booli's parent company) files a complaint under the EU Database Directive (96/9/EC), arguing that systematic extraction of their listing database infringes their sui generis database right. Your product is built entirely on their data, so compliance means shutting down.

**Why it happens:**
The EU Database Directive protects databases where "substantial investment" went into obtaining, verifying, or presenting data. Hemnet/Booli clearly qualifies. Extracting "the whole or a substantial part" of the database is prohibited — and even repeated extraction of "insubstantial parts" can violate the directive if it amounts to systematic extraction. Swedish courts have not tested this specifically for proptech scraping, but the Ryanair v. PR Aviation CJEU ruling (2015) confirmed that even ToS-based restrictions on scraping are enforceable.

**How to avoid:**
- User-initiated model only: never batch-scrape Booli. Each scrape is triggered by a user pasting a specific URL they're already viewing. This is your strongest legal defense.
- Never store or re-display raw Booli listing data. Transform it: your product shows AI analysis, not Booli's data.
- Respect robots.txt. Check Booli's actual robots.txt and comply.
- Rate-limit to human-like patterns: 1-2 requests per user session, not 100/minute.
- Build toward official data sources: Bolagsverket API for BRF data (free, legal, encouraged), SCB API for demographics (free, open data), Lantmäteriet for property data (paid but licensed).
- Keep a legal contingency plan: if Booli blocks you, can you switch to Hemnet? If both block you, what data can you still provide?

**Warning signs:**
- Receiving a robots.txt or ToS-related block from Booli
- Apify actors for Booli being taken down from their marketplace
- Hemnet/Booli adding CAPTCHA or bot detection
- Cease-and-desist email from Hemnet Group's legal team

**Phase to address:**
Phase 1 (architecture). The data access architecture must be legally defensible from day one. This isn't something you can fix later.

---

### Pitfall 5: API Cost Explosion — Claude Costs Scaling Faster Than Revenue

**What goes wrong:**
Each property analysis requires sending a full BRF arsredovisning (10-40 pages of PDF) plus listing data plus comparable sales plus area statistics to Claude. With Claude Sonnet at $3/$15 per million tokens (input/output), a single analysis could cost $0.50-2.00 in API calls. At SEK 149/analysis (~$14), that's 5-15% COGS just for Claude — before hosting, Apify, Stripe fees. If users request re-analysis or you add follow-up questions, costs compound.

**Why it happens:**
Developers prototype with small test inputs, then discover production inputs are 10-50x larger. BRF arsredovisningar are 20-40 pages. Comparable sales data for an area could be hundreds of records. Context windows fill up fast. Extended thinking (if used) burns tokens aggressively.

**How to avoid:**
- Budget per analysis: calculate maximum acceptable Claude cost per SEK 149 report (target: under SEK 5 / $0.50).
- Preprocess aggressively: extract only relevant pages/tables from PDFs before sending to Claude. Don't send the full 40-page PDF — send the 3 relevant financial tables.
- Use model tiering: Haiku for data extraction and formatting ($0.25/$1.25 per M tokens), Sonnet only for the final analysis synthesis.
- Cache common area statistics. SCB data for a given postnummer doesn't change daily — cache it for 30 days.
- Use Anthropic's batch API (50% discount) for non-urgent processing if applicable.
- Implement prompt caching for the system prompt and common instruction sets (90% read discount).
- Track cost per analysis from day one. Set up alerts if average cost exceeds budget.

**Warning signs:**
- Average cost per analysis creeping above $0.50
- Token counts growing as you add more context to prompts
- Users requesting multiple re-analyses of the same property
- Extended thinking enabled by default without budget caps

**Phase to address:**
Phase 1 (MVP architecture). Instrument cost tracking from the first deployed analysis. Optimize in Phase 2.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Hardcoding Booli HTML selectors | Ship faster | Every Booli redesign breaks everything | MVP only — abstract behind interface within 2 weeks |
| Sending full PDFs to Claude instead of extracting relevant pages | Skip PDF preprocessing | 5-10x higher token costs per analysis | MVP only — must optimize before scaling |
| Single LLM call for extract + analyze | Simpler code | Unverifiable financial data, hallucination risk | Never — always separate extraction from analysis |
| Storing scraped Booli data permanently | Enables trend analysis | Legal liability under EU Database Directive | Never — cache temporarily, delete after analysis delivery |
| No input validation on BRF org numbers | Less code | Users paste garbage, waste Claude API calls | MVP acceptable if you validate format (6-digit + hyphen + 4) |
| Skipping error handling for data source failures | Faster to build | Users see blank reports or cryptic errors | Never — partial reports with clear "data unavailable" messaging from day one |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Apify (Booli scraper) | Trusting the Apify community actor without reading its code | Fork the actor, understand the selectors, maintain your own version |
| Claude API | Sending unstructured "analyze this PDF" prompts | Use structured output mode, separate extraction from analysis, validate output schema |
| Bolagsverket API | Assuming all BRF arsredovisningar are available digitally | Mandatory digital submission only from 2025 fiscal year; older reports may only be available as scanned PDFs or not at all |
| SCB API | Making 10+ concurrent requests from same IP | SCB limits to 10 requests per 10 seconds per IP. Implement rate limiter. Cache responses aggressively (data updates quarterly at most) |
| Stripe (payments) | Hardcoding SEK pricing without handling currency/tax | Use Stripe's tax calculation for Swedish moms (25%). Handle both one-time and subscription in same checkout flow |
| Allabrf | Treating it as a reliable API | It's a website, not an API. Same scraping fragility as Booli. Could block you or change layout anytime |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Synchronous analysis pipeline (scrape -> parse -> analyze -> return) | 30-60 second page loads while waiting for Claude + scraping | Async pipeline: return immediately, show progress, deliver report when ready | Immediately at launch — no user waits 60 seconds |
| Re-scraping Booli for every analysis request | Slow responses, high Apify costs, rate-limiting risk | Cache scraped listing data for 24 hours (listings don't change hourly) | 10+ analyses/day |
| Loading full BRF arsredovisning PDFs into memory | Memory spikes, Lambda/Vercel function timeouts | Stream PDF processing, extract pages incrementally | PDFs over 5MB (~40+ pages) |
| No pagination for comparable sales data | Claude context window overflow for popular areas (100+ comps) | Limit to 10-20 most relevant comps, pre-filter by recency and proximity | Areas like Södermalm with hundreds of recent sales |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Storing uploaded BRF arsredovisning PDFs indefinitely | GDPR violation — arsredovisningar may contain personal names (styrelseledamöter), personnummer in some cases | Delete uploaded PDFs after extraction. Store only extracted metrics, not source documents. Privacy policy must state retention period |
| Exposing Claude API key in frontend | Anyone can use your API key, running up costs | API key server-side only. Frontend calls your backend, which calls Claude |
| Not sanitizing user-pasted URLs before scraping | SSRF vulnerability — user could paste internal network URLs | Validate URL matches `booli.se/bostad/*` pattern before passing to scraper |
| Logging full Claude responses with financial data | Data breach exposes users' financial analysis | Log metadata (tokens, latency, success/fail) not content. Redact financial figures in logs |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Showing "analysis failed" when one data source fails | User paid SEK 149 and got nothing | Deliver partial report with clear indication of what's missing and why. "BRF-data kunde inte hämtas automatiskt. Ladda upp årsredovisningen för komplett analys." |
| Presenting AI confidence as certainty | User trusts hallucinated BRF score | Show confidence indicators per section. "Hög säkerhet" / "Baserat på begränsad data" labels. Always link to source data |
| BRF health score (A-F) without explanation | Users don't understand why they got a "C" | Show the 3-5 factors that drove the score with actual numbers. "Skuld/kvm: 8,200 kr (medel för området: 5,100 kr) — drar ner betyget" |
| Report in English or mixed Swedish/English | Jarring for Swedish home buyers | All user-facing text in Swedish. Claude prompts must specify Swedish output. Watch for English leaking through in financial terms |
| No way to dispute or correct AI analysis | Users who spot errors feel powerless | Add "Stämmer inte? Rapportera" button. Builds feedback loop and trust |

## "Looks Done But Isn't" Checklist

- [ ] **Booli scraping:** Works for apartments (bostadsrätt) — verify it also handles radhus, villa, fritidshus URL patterns, or explicitly exclude them
- [ ] **BRF analysis:** Handles current year arsredovisning — verify it handles multi-year trend analysis (users want to see 3-year skuld trend, not just latest)
- [ ] **Price comparison:** Shows comparable sold prices — verify the comparables are actually comparable (same room count, similar size, same building vs. just same postort)
- [ ] **Swedish characters:** å, ä, ö display correctly in reports — verify they also work in URL parsing, PDF text extraction, database storage, and Claude prompt/response
- [ ] **Payment flow:** Stripe checkout works — verify webhook handles failed payments, subscription cancellation, and refund flow
- [ ] **Error states:** Happy path works — verify behavior when Booli is down, when BRF has no arsredovisning, when SCB API times out, when Claude returns malformed JSON
- [ ] **Mobile responsive:** Report looks good on desktop — verify it's readable on iPhone (most Swedish home buyers browse listings on mobile)
- [ ] **Edge cases:** Standard Stockholm BRF works — verify handling of nyproduktion (no historical data), ombildning (recent BRF with no track record), and tiny BRFs (<10 lägenheter)

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Booli blocks scraping | MEDIUM | Switch to Hemnet scraper as backup. Long-term: pursue official data partnerships or rely more heavily on user-provided URLs with manual data entry |
| Claude hallucinates financial data that reaches users | HIGH | Issue correction to affected users. Add verification layer. Implement automated sanity checks on all financial figures before delivery |
| PDF parser produces wrong numbers at scale | MEDIUM | Add manual review queue for reports with low-confidence extractions. Offer users ability to correct figures. Retrain extraction prompts |
| Legal cease-and-desist from Hemnet Group | HIGH | Comply immediately. Pivot to fully user-provided data (user uploads listing screenshot + arsredovisning PDF). Less automated but legally safe. Explore Bolagsverket API for BRF data as legal alternative |
| API costs exceed revenue per analysis | LOW | Immediate: switch to cheaper model tier (Haiku) for extraction steps. Medium-term: preprocess and reduce token usage. Long-term: raise prices or add premium tier |
| GDPR complaint about stored personal data | HIGH | Audit all data stores. Purge personal data. Implement automated deletion. Update privacy policy. Respond to DPA within required timeline |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Scraping fragility | Phase 1 (MVP) | Daily health-check scraper running. Data source abstracted behind interface. Partial reports working when sources fail |
| AI hallucination in financial data | Phase 1-2 (MVP + iteration) | Extraction and analysis separated. Sanity checks on all financial figures. Source quotes shown in reports. Manual verification of first 50 reports |
| PDF parsing unreliability | Phase 2 (BRF feature) | Tested against 20+ PDFs from different accounting firms. Confidence scores per field. User correction flow implemented |
| Legal exposure (EU Database Directive) | Phase 1 (architecture) | User-initiated model enforced. No batch scraping. No permanent storage of scraped data. robots.txt respected. Legal disclaimer in product |
| API cost explosion | Phase 1 (MVP) | Cost per analysis tracked from first deploy. Model tiering implemented. Budget alerts set. PDF preprocessing reduces token usage |
| GDPR / personal data handling | Phase 1 (infrastructure) | PDF deletion policy implemented. No personnummer storage. Privacy policy published. Data retention limits enforced |
| SCB API rate limiting | Phase 2 (area statistics) | Rate limiter in place. Response caching (30-day TTL for demographic data). Fallback for when API is down |
| Swedish language edge cases | Phase 1-2 (prompts) | Claude prompts specify Swedish output. å/ä/ö tested end-to-end. Financial terminology verified against real reports |
| Bolagsverket API transition risks | Phase 2-3 | Monitor Bolagsverket API availability. Historical data strategy defined (pre-2025 reports not in API). Fallback to Allabrf + manual upload |

## Sources

- [Apify Booli.se Scraper](https://apify.com/lexis-solutions/booli-se-scraper) — Community-maintained scraper for Booli listing data
- [EU Database Directive — IAPP Analysis](https://iapp.org/news/a/the-state-of-web-scraping-in-the-eu) — Legal landscape for web scraping in the EU
- [EU Database Directive — Wikipedia](https://en.wikipedia.org/wiki/Database_Directive) — Sui generis database right details
- [Ryanair v. PR Aviation — Pinsent Masons](https://www.pinsentmasons.com/out-law/news/website-operators-can-prohibit-screen-scraping-of-unprotected-data-via-terms-and-conditions-says-eu-court-in-ryanair-case) — CJEU ruling on ToS-based scraping restrictions
- [LLM Financial Table Extraction Accuracy — MDPI](https://www.mdpi.com/2073-431X/13/10/257) — ~56% accuracy on financial document QA
- [LLM PDF Financial Statement Extraction — Cognica](https://www.cognica.io/en/blog/posts/2025-11-18-llm-pdf-financial-statement-extraction) — Practical challenges in automated extraction
- [AI Hallucinations in Financial Services — BayTech](https://www.baytechconsulting.com/blog/hidden-dangers-of-ai-hallucinations-in-financial-services) — Domain-specific hallucination risks
- [RAG Hallucination Reduction — arXiv](https://arxiv.org/html/2512.03107) — 42% reduction in hallucination with RAG
- [Bolagsverket API](https://bolagsverket.se/apierochoppnadata.2531.html) — Official API for company data including arsredovisningar
- [BRF K3 Mandatory from 2026 — Fastighetsägarna](https://www.fastighetsagarna.se/aktuellt/nyheter/2024/sverige/brfs-arsredovisning-for-2025-och-framat-ska-skickas-till-bolagsverket/) — New law requiring BRF submission to Bolagsverket
- [K3 Mandatory for BRFs — SBC](https://www.sbc.se/fastighetsforvaltning/ekonomisk-forvaltning/k3-for-brf/) — K3 becomes mandatory for all BRFs from fiscal year 2026
- [SCB Open Data API](https://www.scb.se/en/services/open-data-api/) — Rate limits: max 10 requests per 10 seconds per IP
- [Anthropic API Pricing](https://platform.claude.com/docs/en/about-claude/pricing) — Token pricing for cost calculations
- [Claude Usage and Cost API](https://platform.claude.com/docs/en/build-with-claude/usage-cost-api) — Monitoring and budget control
- [Web Scraping Challenges 2025 — Apify/DEV](https://dev.to/apify/10-web-scraping-challenges-solutions-in-2025-5bhd) — Anti-bot detection, broken selectors, maintenance
- [Web Scraping Downtime Costs — ScrapeHero](https://www.scrapehero.com/web-scraping-downtime/) — Enterprise impact of scraper failures
- [Apify Review 2025 — BlackBearMedia](https://blackbearmedia.io/apify-review/) — Marketplace lock-in risks

---
*Pitfalls research for: AI-powered Swedish real estate analysis (Bostad AI)*
*Researched: 2026-02-24*
