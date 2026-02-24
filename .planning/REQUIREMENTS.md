# Requirements: Bostad AI

**Defined:** 2026-02-24
**Core Value:** Give Swedish home buyers an independent, data-driven analysis of any listing — the one thing their mäklare won't provide.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Listing Analysis

- [ ] **LSTG-01**: User can paste a Booli URL and system extracts listing data (price, size, avgift, rooms, byggår, address, BRF name)
- [ ] **LSTG-02**: User can view structured listing summary with all key data points displayed clearly

### BRF Financial Analysis

- [ ] **BRF-01**: System parses BRF årsredovisning and displays financial overview (skuld/kvm, avgiftsnivå, kassaflöde, underhållsplan status)
- [ ] **BRF-02**: System generates BRF health score (A–F) based on financial metrics with transparent methodology
- [ ] **BRF-03**: User can upload BRF årsredovisning PDF when auto-fetch is unavailable

### Price Comparison

- [ ] **PRICE-01**: System compares listing price vs recently sold properties in same area/building (pris/kvm vs area average, trend direction, sample size)

### Area Statistics

- [ ] **AREA-01**: System displays SCB demographics for the listing's neighborhood (income levels, population trends)

### AI Report

- [ ] **RPRT-01**: Claude generates AI-synthesized "vad du bör tänka på" summary combining all available data into an opinionated assessment
- [ ] **RPRT-02**: System displays red/green flags for risk indicators (high BRF debt, planned stambyte, avgiftshöjning, unusual patterns)
- [ ] **RPRT-03**: User can download and share analysis as PDF report

## v1.1 Requirements

Added after beta validation with 20–50 free users.

### Payment

- **PAY-01**: User pays SEK 149 per analysis via Stripe
- **PAY-02**: User can subscribe at SEK 349/month for unlimited analyses

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Data Enrichment

- **ENRICH-01**: System auto-fetches BRF årsredovisning from Allabrf/Bolagsverket when available
- **ENRICH-02**: System displays BRÅ crime statistics for the neighborhood
- **ENRICH-03**: System displays Skolverket school quality metrics for nearby schools
- **ENRICH-04**: System shows partial reports with gap prompts when data sources fail

### Advanced Analysis

- **ADV-01**: Interest rate stress test — shows impact on costs if rates rise 1–3%
- **ADV-02**: Avgiftshöjning prediction based on BRF financial trends over multiple years
- **ADV-03**: AI-powered investment case / trend analysis — synthesizes area price trends, infrastructure/zoning changes, demographic shifts into an investment outlook for the area and property

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Conversational AI chat | Massively increases scope. Structured reports more useful for property analysis. |
| Custom valuation / price prediction (Zestimate-style) | Requires licensed transaction datasets (Mäklarstatistik, Lantmäteriet). Solo dev can't compete on accuracy. Liability risk. |
| Hemnet scraping | Hemnet ToS explicitly prohibit scraping. Legal risk. Booli only. |
| Batch search / "find best listings" | Different product (search engine vs analysis tool). Requires continuous crawling infrastructure. |
| B2B features (bank/agent integrations) | Different buyer, sales cycle, compliance. Validate consumer first. |
| Norway/Denmark expansion | Different data sources, legal frameworks, terminology. Validate Sweden first. |
| Real-time market alerts | Different product category (monitoring vs on-demand analysis). |
| Mobile native app | Web-first responsive design sufficient. |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| LSTG-01 | TBD | Pending |
| LSTG-02 | TBD | Pending |
| BRF-01 | TBD | Pending |
| BRF-02 | TBD | Pending |
| BRF-03 | TBD | Pending |
| PRICE-01 | TBD | Pending |
| AREA-01 | TBD | Pending |
| RPRT-01 | TBD | Pending |
| RPRT-02 | TBD | Pending |
| RPRT-03 | TBD | Pending |

**Coverage:**
- v1 requirements: 10 total
- Mapped to phases: 0
- Unmapped: 10 ⚠️

---
*Requirements defined: 2026-02-24*
*Last updated: 2026-02-24 after initial definition*
