# Feature Research

**Domain:** AI-powered property analysis for Swedish residential market (bostadsratt focus)
**Researched:** 2026-02-24
**Confidence:** MEDIUM — based on competitor analysis of Allabrf.se, BRFrapport.se, AI BRF, Dokulys, Booli/Hemnet, and international references (Zillow, Redfin, Localize.city, OJO Labs, RealReports). Swedish AI-BRF competitors are new (2025 launches) so feature sets are still evolving.

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist. Missing these = product feels incomplete.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Paste-URL listing import | Core UX promise. Allabrf/Booli already show listing data. Users expect zero-friction input. | MEDIUM | Scraping Booli via Apify. Fragile — Booli DOM changes break it. Need graceful fallback to manual input. |
| Structured listing summary | Every competitor shows basic listing data (price, size, rooms, avgift, address, byggår). Without this, nothing else makes sense. | LOW | Parsed from scrape. Display clearly before analysis layers. |
| BRF financial overview | Allabrf does this as their core product. BRFrapport and AI BRF also do it. Users buying bostadsratt expect BRF data. Not having it is a dealbreaker. | MEDIUM | Parse arsredovisning (K2/K3 format). Key metrics: skuld/kvm, avgiftsniva, kassaflode, underhallsplan status. |
| BRF rating/score | Allabrf's A++ to C rating is the market standard — users will expect some form of grading. BRFrapport and AI BRF also score associations. | MEDIUM | Use A-F scale (per PROJECT.md). Must be transparent about methodology or users won't trust it. |
| Price comparison vs sold properties | Hemnet and Booli both show sold prices in area. Users compare listings to recent sales themselves today — tool should automate this. | MEDIUM | Scrape Booli "Salda" data. Show pris/kvm vs area average, trend direction, and sample size. |
| Shareable/downloadable report | BRFrapport generates reports. Allabrf sells PDF reports (99-149 SEK). Users want to share analysis with partner, save for later. | LOW | PDF generation from structured report. Not hard, but important for perceived value and justifying payment. |
| Mobile-responsive web | Hemnet has 60%+ mobile traffic. Property research happens on the go, at viewings, on the couch. | LOW | Web-first responsive design, not native app. Already scoped in PROJECT.md. |
| Payment/paywall | Users pay Allabrf 99-149 SEK per report. AI BRF charges 69 SEK. There's established willingness to pay. No payment = no business. | MEDIUM | Stripe integration with SEK pricing. Per-analysis (149 SEK) + subscription (349 SEK/month) per PROJECT.md. |

### Differentiators (Competitive Advantage)

Features that set the product apart. Not required, but valuable.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| AI-synthesized "vad du bor tanka pa" summary | No Swedish competitor does this. Allabrf shows raw numbers. BRFrapport shows AI-parsed data. Nobody combines listing + BRF + area into one opinionated AI assessment telling you what to watch out for. This is the core differentiator. | MEDIUM | Claude prompt engineering. Combine all data sources into coherent narrative. Quality depends on prompt design — invest here. |
| Red/green flag system | Visual, scannable risk indicators. Allabrf has ratings but no per-listing risk flags. International reference: Zillow tried climate risk scores (later removed due to agent pushback, but buyers loved them). Clear signal of "this is fine" vs "be careful". | LOW | Rule-based + AI hybrid. Rules: skuld/kvm > threshold = red flag, planned stambyte = yellow flag, etc. AI: identify unusual patterns. |
| Combined listing + BRF + area analysis in one report | Today, a buyer must visit Hemnet/Booli (listing), Allabrf (BRF), SCB (demographics), BRA (crime) separately. Nobody unifies this. International reference: Localize.city combines property + neighborhood data. This is the "second opinion" value prop. | HIGH | Multiple data sources, multiple scrapers/APIs. This is where the product earns its price. Dependencies on all other features working. |
| BRF arsredovisning auto-fetch | BRFrapport requires upload. Allabrf has this for some BRFs. Auto-fetching from Allabrf or Bolagsverket removes a friction step. | MEDIUM | Bolagsverket has public records but no clean API. May need scraping. Fallback: user upload (already scoped). |
| Area statistics (demographics, crime, schools) | SCB, BRA, Skolverket data adds context no Swedish competitor combines with BRF analysis. Localize.city does this for NYC. Zillow/Redfin show neighborhood stats. | MEDIUM | SCB has open APIs. BRA and Skolverket data is public but may need scraping. Not real-time critical — can cache. |
| Interest rate stress test | BRFrapport offers this: "what happens to your costs if rates rise 2%?". Powerful for buyer confidence. Directly addresses the #1 fear of Swedish apartment buyers post-2022 rate hikes. | LOW | Math on top of BRF loan data + listing avgift. Simple calculation, high perceived value. |
| Avgiftshojning prediction | Based on BRF financial trends (skuld, underhallsplan, kassaflode), predict likelihood of fee increases. No competitor does this with AI — BRFrapport shows trends but doesn't predict. | MEDIUM | Requires multi-year arsredovisning data. AI pattern recognition on financial trajectory. Flag confidence level clearly. |
| Partial reports with gap prompts | When data sources fail (scraper down, arsredovisning unavailable), show what you have and prompt user to fill gaps. Competitors either show nothing or show incomplete data silently. | LOW | Graceful degradation pattern. Each data source independent. UX: "We couldn't find the arsredovisning — upload it here to complete your analysis." |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem good but create problems.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Conversational AI chat about listing | OJO Labs does this. Users might expect ChatGPT-like Q&A about a property. | Massively increases scope (conversation memory, context management, edge cases). Claude API costs per conversation add up. Chat UX is hard to get right. BRFrapport added it but it's a gimmick — structured reports are more useful for this use case. | Structured report with clear sections. If users want to dig deeper, v2 could add "ask a follow-up question" on specific sections (constrained chat, not open-ended). |
| Custom valuation / price prediction | Zillow's Zestimate is their flagship. Users might expect "what is this apartment worth?". | Requires massive transaction datasets (Maklarstatistik, Lantmateriet) that are expensive/licensed. Solo dev can't compete with SBAB/Booli Pro on valuation accuracy. Liability if valuation is wrong. Already out of scope in PROJECT.md. | Show price comparison data (listing vs recent sales in area) and let the user draw their own conclusion. Frame as "market context", not "valuation". |
| Hemnet scraping | Hemnet is where 95% of Swedish buyers look first. Natural to want Hemnet URL support. | Hemnet ToS explicitly prohibit scraping. Legal risk is real — Hemnet has sued scrapers. Booli is safer and has Apify scrapers available. Already scoped out in PROJECT.md. | Booli only. Users paste Booli URL. Add note: "Find the listing on Booli.se first" — minor friction, major risk reduction. |
| Batch search / "find best listings" | Users want "show me all 2-room apartments in Sodermalm under 4M with good BRF". Proactive search is appealing. | Requires continuous Hemnet/Booli crawling, massive data pipeline, storage. Out of scope in PROJECT.md. This is a different product (search engine, not analysis tool). | Stick to on-demand analysis. User finds listing on Booli, pastes URL, gets report. One listing at a time. |
| B2B features (bank/agent integrations) | Banks and agents could use this data. B2B revenue potential. | Different buyer, different sales cycle, different compliance requirements. Premature for a solo side project. Already out of scope in PROJECT.md. | Validate consumer product first. B2B is a pivot option if consumer doesn't work, not a launch feature. |
| Norway/Denmark expansion | Scandinavian markets are similar. "Why not support Oslo too?" | Each country has different data sources, legal frameworks, terminology, BRF equivalents (borettslagsloven in Norway). Multiplies data integration work. Already out of scope in PROJECT.md. | Sweden only. Validate product-market fit in one market before expanding. |
| Real-time market alerts | "Notify me when a listing in my area drops in price" or "alert when a good BRF listing appears". | Requires continuous monitoring infrastructure, push notification system, user preference management. Different product category (monitoring vs analysis). | Stick to on-demand analysis. If users want monitoring, they use Hemnet/Booli's existing alert features. |

## Feature Dependencies

```
[Listing scraping (Booli URL parse)]
    |-- requires --> [Structured listing summary]
    |                    |-- enhances --> [Price comparison vs sold]
    |                    |-- enhances --> [AI summary report]
    |                    |-- enhances --> [Red/green flags]
    |
    |-- requires --> [BRF identification from listing]
                         |-- requires --> [BRF arsredovisning fetch/upload]
                         |                    |-- requires --> [BRF financial parsing]
                         |                    |                    |-- enhances --> [BRF rating/score]
                         |                    |                    |-- enhances --> [Interest rate stress test]
                         |                    |                    |-- enhances --> [Avgiftshojning prediction]
                         |                    |                    |-- enhances --> [AI summary report]
                         |                    |                    |-- enhances --> [Red/green flags]

[Area identification from address]
    |-- requires --> [SCB demographics fetch]
    |-- requires --> [BRA crime data fetch]
    |-- requires --> [Skolverket school data fetch]
    |                    |-- all enhance --> [AI summary report]

[AI summary report]
    |-- requires --> [Structured listing summary] (minimum)
    |-- enhanced by --> [BRF financial data] (optional, graceful degradation)
    |-- enhanced by --> [Area statistics] (optional, graceful degradation)
    |-- enhances --> [Shareable PDF report]

[Payment (Stripe)]
    |-- gates --> [Full report access]
    |-- independent of --> [All data features]
```

### Dependency Notes

- **Listing scraping is the foundation:** Everything starts with parsing the Booli URL. If this breaks, nothing works. Must be the most robust component.
- **BRF data is the highest-value optional layer:** Without arsredovisning data, the report loses its biggest differentiator vs Booli/Hemnet alone. Auto-fetch + upload fallback is critical.
- **AI summary requires at minimum listing data:** Can generate partial report with just listing data. Gets progressively better with BRF + area data. Graceful degradation is a feature, not a bug.
- **Area statistics are independent of BRF data:** Can fetch SCB/BRA/Skolverket data from address alone, even if BRF arsredovisning is unavailable.
- **Payment is architecturally independent:** Can be added/changed without touching data features. Build data pipeline first, add payment before launch.

## MVP Definition

### Launch With (v1)

Minimum viable product -- what's needed to validate willingness to pay.

- [ ] **Booli URL paste and listing data extraction** -- the core input mechanism, without this nothing works
- [ ] **BRF financial overview and A-F score** -- the #1 differentiator vs free Hemnet/Booli data, proven willingness to pay (Allabrf charges 99-149 SEK)
- [ ] **BRF arsredovisning upload** (auto-fetch can wait) -- manual upload is MVP; auto-fetch is optimization
- [ ] **Price comparison vs recent sold properties in area** -- high-value, low-incremental-cost since Booli scraper already fetches nearby data
- [ ] **Red/green flag system** -- rule-based flags for critical BRF metrics (high debt, planned stambyte, rising avgift)
- [ ] **AI-synthesized summary ("vad du bor tanka pa")** -- the "wow" feature that justifies the product existing. Combines listing + BRF data into opinionated narrative
- [ ] **Shareable PDF report** -- perceived value, shareable with partner, justifies payment
- [ ] **Stripe payment (per-analysis pricing)** -- SEK 149/analysis to validate willingness to pay. Subscription can come later
- [ ] **Partial reports when data incomplete** -- critical for real-world reliability. Don't fail silently when a data source is unavailable

### Add After Validation (v1.x)

Features to add once core is working and users are paying.

- [ ] **BRF arsredovisning auto-fetch** -- reduces friction, increases conversion. Add when manual upload flow is validated
- [ ] **Area statistics (SCB, BRA, Skolverket)** -- enriches report significantly. Add when core BRF + listing pipeline is stable
- [ ] **Interest rate stress test** -- low effort, high value. Add when BRF financial parsing is solid
- [ ] **Avgiftshojning prediction** -- needs multi-year data, higher confidence in AI analysis quality
- [ ] **Subscription pricing (349 SEK/month)** -- add when you see repeat buyers (buying multiple analyses)
- [ ] **Constrained follow-up questions per section** -- not open chat, but "tell me more about the BRF debt" on a specific section

### Future Consideration (v2+)

Features to defer until product-market fit is established.

- [ ] **Area comparison tool** -- "compare Sodermalm vs Vasastan" requires different UX and data aggregation
- [ ] **Historical BRF tracking** -- how has this BRF's score changed over years? Needs data accumulation over time
- [ ] **Buyer checklist / due diligence workflow** -- guide users through the buying process, not just analysis
- [ ] **Climate/environmental risk data** -- flooding, radon, noise levels (interesting but not core value prop for Swedish market yet)

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Booli URL paste + listing extraction | HIGH | MEDIUM | P1 |
| BRF financial overview + score | HIGH | MEDIUM | P1 |
| AI-synthesized summary | HIGH | MEDIUM | P1 |
| Red/green flags | HIGH | LOW | P1 |
| Price comparison vs sold | HIGH | MEDIUM | P1 |
| Shareable PDF report | MEDIUM | LOW | P1 |
| Arsredovisning upload (manual) | HIGH | LOW | P1 |
| Stripe payment | HIGH | MEDIUM | P1 |
| Partial reports / graceful degradation | MEDIUM | LOW | P1 |
| Arsredovisning auto-fetch | MEDIUM | MEDIUM | P2 |
| Area statistics (SCB/BRA/Skolverket) | MEDIUM | MEDIUM | P2 |
| Interest rate stress test | MEDIUM | LOW | P2 |
| Avgiftshojning prediction | MEDIUM | MEDIUM | P2 |
| Subscription pricing | MEDIUM | LOW | P2 |
| Constrained follow-up questions | LOW | MEDIUM | P3 |
| Area comparison tool | LOW | HIGH | P3 |
| Historical BRF tracking | LOW | HIGH | P3 |

**Priority key:**
- P1: Must have for launch
- P2: Should have, add when possible
- P3: Nice to have, future consideration

## Competitor Feature Analysis

| Feature | Allabrf.se | BRFrapport.se | AI BRF (aibrf.se) | Booli/Hemnet | Zillow (reference) | Bostad AI (our approach) |
|---------|-----------|---------------|-------------------|-------------|-------------------|------------------------|
| BRF financial data | Core product. 7-parameter index. A++ to C rating. 200K monthly users. | AI-parsed arsredovisning. Trend identification. Stress testing. Free. | 69 SEK per analysis. Basic key metrics. | Booli Pro (SBAB): 20K+ BRFs tracked. Not consumer-facing. | N/A (no BRF equivalent) | AI-parsed arsredovisning + A-F score + red/green flags. Opinionated, not just data. |
| Listing analysis | No. BRF-only, not listing-specific. | No. BRF-only. | No. BRF-only. | Shows listing data. No analysis layer. | Zestimate + listing details + climate risk. | Listing data + BRF + area combined. The "full picture" per listing. |
| Price comparison | No. | No. | No. | Booli shows sold prices in area. Hemnet shows price trends. Raw data, no per-listing comparison. | Zestimate vs listing price. Neighborhood comps. | Automated comparison: this listing vs recent sales in same area/building. Pris/kvm context. |
| Area/neighborhood data | No. | No. | No. | Hemnet: price trends by area. Booli: area statistics. | Neighborhood info, schools, walkability, climate risk. Localize.city: billions of data points per area. | SCB demographics, BRA crime, Skolverket schools — combined with listing + BRF analysis. |
| AI summary/narrative | No. Raw data and ratings. | AI identifies positives/negatives and trends. Some narrative. | Minimal. Key metrics focus. | No. | No narrative (data display). RealReports: AI property advisor. | Core differentiator. Synthesized, opinionated "second opinion" narrative. |
| Risk scoring | Rating implies risk (C = bad). No per-listing risk flags. | Trend identification + stress test hints at risk. | Basic. | None. | Climate risk scores (removed 2025 due to agent pushback). | Red/green flag system: high debt, stambyte, avgiftshojning, unusual patterns. |
| Report format | PDF report (99-149 SEK). | Web-based analysis. Free. | Web-based. 69 SEK. | No report product. | No report product (data on listing page). | Web report + downloadable PDF. |
| Pricing | 99-149 SEK per report. Premium subscriptions for BRF boards. | Free (donations). | 69 SEK per analysis. | Free (ad-supported). Booli Pro: professional subscription. | Free (ad-supported). Zillow Pro for agents. | 149 SEK per analysis. 349 SEK/month subscription. |

### Key Competitive Insights

1. **No Swedish competitor combines listing + BRF + area analysis.** Everyone does one piece. This is the gap.
2. **BRFrapport.se is the closest AI competitor** but focuses only on BRF data, not individual listings. It's free (donations model) which means it likely won't scale or improve rapidly.
3. **Allabrf is the incumbent** with 200K monthly users and established brand trust. Their weakness: no AI, no per-listing analysis, no area data. Their strength: comprehensive BRF database and established rating system.
4. **AI BRF (69 SEK) and Dokulys are emerging** but early-stage and narrow in scope.
5. **International reference points** (Zillow's climate risk, Localize.city's neighborhood data, RealReports' AI property advisor) show where the market is heading: combined, AI-synthesized analysis rather than raw data display.

## Sources

- [Allabrf.se](https://sv.allabrf.se/) — Sweden's largest BRF data platform, 200K+ monthly users, A++ to C rating system
- [Allabrf rating system explained](https://publik-support.allabrf.se/support/solutions/articles/103000261901-hur-fungerar-betygssystemet-)
- [Allabrf Premium pricing](https://sv.allabrf.se/premium)
- [BRFrapport.se](https://brfrapport.se/) — Free AI-powered BRF analysis, launched August 2025
- [AI BRF (aibrf.se)](https://aibrf.se/) — BRF analysis for 69 SEK
- [Dokulys.se](https://dokulys.se/analys/brf-arsredovisning/) — AI document analysis for BRF, house, rental agreements
- [BRF Index (brfindex.se)](https://brfindex.se/) — AI analysis of BRF annual reports
- [Bostadspolitik: AI platform for BRF analysis](https://www.bostadspolitik.se/2025/08/18/ny-ai-plattform-ska-gora-bostadsrattsforeningars-ekonomi-begriplig-for-fler/)
- [Ekonomifokus: AI for BRF economic review](https://www.ekonomifokus.se/nyheter/ai-ska-underlatta-granskning-av-ekonomin-hos-brfer)
- [Booli Pro / SBAB BRF analysis](https://www.sbab.se/1/brf/fastighetslan/booli_pro_brf-analys.html)
- [Hemnet bostadsmarknaden statistics](https://www.hemnet.se/bostadsmarknaden)
- [Zillow AI features 2025-2026](https://www.geekwire.com/2026/zillow-at-20-real-estate-giant-leans-on-ai-to-make-homebuying-hurt-less/)
- [Zillow climate risk scores removed](https://techcrunch.com/2025/12/01/zillow-drops-climate-risk-scores-after-agents-complained-of-lost-sales/)
- [Localize.city features](https://www.builtinnyc.com/articles/localize-raises-25m-series-c) — AI neighborhood analysis, billions of data points
- [OJO Labs AI real estate assistant](https://ojo.com/)
- [RealReports AI property reports](https://www.bhr.fyi/)
- [Proptech investment landscape 2025-2026](https://news.crunchbase.com/real-estate-property-tech/rebound-ai-fintech-data-eoy-2025/)

---
*Feature research for: AI-powered Swedish property analysis (Bostad AI)*
*Researched: 2026-02-24*
