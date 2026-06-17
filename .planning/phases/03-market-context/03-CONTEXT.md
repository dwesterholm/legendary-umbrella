# Phase 3: Market Context - Context

**Gathered:** 2026-06-17
**Status:** Ready for planning

<domain>
## Phase Boundary

User can see how a listing's price compares to recent sales in the area (PRICE-01) and understand the neighborhood's demographics (AREA-01). This phase enriches the existing analysis page by replacing the "Prisjämförelse" and "Områdesstatistik" *Kommer snart* placeholders with two real data panels: (1) a comparable-sold-prices comparison, and (2) SCB-sourced area demographics.

**In scope:** comparable sold-price acquisition + comparison display; SCB demographics acquisition + display; partial-data / thin-data handling; sourcing, confidence, and disclaimer treatment.

**Out of scope:** the synthesized AI "vad du bör tänka på" report and cross-source red/green flags (Phase 4, RPRT-01/02); PDF export (Phase 4, RPRT-03); BRÅ crime and Skolverket school stats (v2, ENRICH-02/03); custom valuation / price prediction (explicitly out of scope per REQUIREMENTS.md). Depends on Phase 1 only — independent of Phase 2 (BRF).

</domain>

<decisions>
## Implementation Decisions

### Comparable definition (PRICE-01)
- **D-01:** "Comparable" uses a **tiered fallback**: prefer sales in the same building/BRF → fall back to the same neighborhood → fall back to a wider area. The UI must show **which tier** the comparison was drawn from, so the buyer knows how local the comparison really is.
- **D-02:** Recency window is **24 months**, which also powers a price **trend** over that period. Older sales within the window may need a market-adjustment caveat (planner/research decides treatment).
- **D-03:** **pris/kvm is the baseline normalization** — everything is compared per m² so size differences wash out. Richer matching on **floor level, balcony, avgift** (and size/rooms) layers on top *where the sold-data source exposes those attributes* — see RESEARCH DIRECTIVE D-09. Do not block the comparison on rich attributes being available.

### Price comparison display (PRICE-01)
- **D-04:** **Headline = ±% vs area pris/kvm** — e.g. "Denna bostad: 95 200 kr/m² — 8 % över områdets snitt (88 000 kr/m²)". A clear directional verdict plus the numbers behind it. Frame as a statistical comparison, NOT a valuation verdict (see D-08 disclaimer).
- **D-05:** Supporting detail (all four): a **24-month area price trend**; a **list of the comparable sales** used (address, date, pris/kvm, key attrs) as the verifiable receipt; **sample size + tier used** ("Baserat på N försäljningar i [område]"); and a **distribution/range** (min–max or spread) so a single average isn't read as precision.

### Demographics scope & level (AREA-01)
- **D-06:** Geographic granularity is **kommun as the guaranteed baseline** (always derivable), **upgrading to neighborhood-level (DeSO/RegSO) where geocoding proves reliable** — see RESEARCH DIRECTIVE D-10. A coarse-but-correct kommun figure beats a precise-but-wrong neighborhood figure.
- **D-07:** Metrics to surface (all four): **income level**, **population trend**, **age distribution**, and **housing/ownership mix**. Income + population trend are named in AREA-01; age distribution and ownership mix add buyer-relevant texture.

### Data-availability & trust
- **D-08:** **Thin/missing data → partial result with honest markers, never fabricate.** When a source is too thin to be reliable (new build with no comps, geocoding miss), show what we have and clearly mark the gap (e.g. "För få försäljningar för en tillförlitlig jämförelse"). Consistent with the Phase 1/2 partial-data tolerance and the Phase 2 "Osäker — kontrollera själv" pattern. Do NOT hide the section silently.
- **D-09 (trust):** Establish credibility via four mechanisms: **source + freshness labels** ("Källa: Booli, sålda bostäder" / "Källa: SCB", with how current the data is); **the comparable-sales list as the receipt** (D-05); an explicit **"ej värdering" disclaimer** ("Detta är en statistisk jämförelse, inte en värdering eller finansiell rådgivning" — the legal caution from PROJECT.md); and a **confidence signal driven by sample size + tier** (low confidence when e.g. only 2 comps from the wide-area fallback).

### Claude's Discretion
- Exact matching algorithm within the pris/kvm-first principle (D-03) — how floor/balcony/avgift weight in, once data availability is known.
- Visual treatment of the trend (sparkline vs arrow + %), the comp list, the distribution, and the confidence signal — reuse the Phase 2 visual language where it fits.
- How the kommun→neighborhood upgrade (D-06) is presented when both are available.
- Caching/staleness strategy for SCB and sold-price data (SCB updates infrequently; sold prices change over time).

</decisions>

<research_directives>
## Research Directives (data-availability unknowns — investigate BEFORE planning locks approach)

These are the "needs to investigate" gaps the user explicitly flagged. They mirror the Phase 2 D-01/D-02 pattern: surface the real constraints first, then let planning choose.

- **D-09-RD (sold-prices acquisition):** Determine the acquisition path for comparable **sold** prices.
  1. Does the existing Apify actor (`lexis-solutions/booli-se-scraper`, `bpf1JaYRBbia2nQU9`) return **sold listings** for an area, or only active listings? If not, which actor/endpoint does?
  2. Which **attributes** does the sold-data source actually expose per sale — pris/kvm, sale date, floor, balcony, avgift, rooms, size? This directly determines how rich D-03 matching can be.
  3. How is an **area query** expressed to the source (free-text area name, area id, geo bounds)? We currently store only `streetAddress` + `descriptiveAreaName` and **no coordinates / postal code / area id** — assess what extra location data must be captured at scrape time.
  4. Cost/rate implications of querying sold data per analysis (PROJECT.md budget: <$100/month, solo dev).

- **D-10-RD (SCB + geocoding):** Determine how to map a listing to SCB geography and which tables serve the four metrics.
  1. **Address → geographic code** mapping (geocoding): how reliably can we resolve `streetAddress` → kommun code (baseline) and → DeSO/RegSO (upgrade)? What free service/API (e.g. SCB's regional codes, a geocoder) is viable within budget?
  2. Which **SCB API tables/endpoints** provide income, population trend, age distribution, and housing/ownership mix — and at what geographic levels (kommun guaranteed; DeSO/RegSO if available)?
  3. SCB API shape, rate limits, auth (the SCB PxWeb/öppna data API is free) and update cadence (for caching/freshness labels per D-09).

</research_directives>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project planning
- `.planning/PROJECT.md` — Core value, constraints (solo dev, <$100/month infra, legal caution / "ej finansiell rådgivning"); data-access notes (SCB free; Booli scraping gray-zone, user-initiated); out-of-scope: custom valuation / Mäklarstatistik / Lantmäteriet.
- `.planning/REQUIREMENTS.md` — PRICE-01 and AREA-01 definitions; BRÅ/Skolverket (ENRICH-02/03) and avgiftshöjning prediction (ADV-02) are v2; custom valuation is Out of Scope.
- `.planning/ROADMAP.md` § Phase 3 — Goal + 2 success criteria (price comparison: pris/kvm, area average, trend, sample size; SCB demographics: income, population trends).

### Code reality (Phase 1 — sets the data we start from)
- `src/lib/schemas/listing.ts` — `scraperOutputSchema` (what the actor returns: `streetAddress`, `descriptiveAreaName`, `price`, `livingArea`, `listSqmPrice`, etc.) and `normalizeScraperOutput()`; note the internal model keeps only free-text `address` — **no coordinates / postal code / area id**.
- `src/lib/apify/booli-scraper.ts` — existing Apify integration (actor `bpf1JaYRBbia2nQU9`, SE residential proxy) — starting point for the sold-prices feasibility pass (D-09-RD).
- `.planning/phases/01-foundation-core-pipeline/01-03-SUMMARY.md` — actor output reality (confirmed field names; actor does NOT provide brfName or floor for active listings — re-check for sold listings).

### Phase 2 patterns to reuse (trust / confidence / partial data)
- `.planning/phases/02-brf-financial-analysis/02-CONTEXT.md` — D-10/D-11 confidence + source-quote pattern; D-08 deterministic-in-code principle; partial-data tolerance — the trust model this phase mirrors.

### External (to be verified by research — D-09-RD / D-10-RD)
- SCB öppna data / PxWeb API (https://www.scb.se/en/services/open-data-api/) — free demographics API; tables + geographic levels TBD.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/components/coming-soon-section.tsx` — the "Prisjämförelse" and "Områdesstatistik" *Kommer snart* placeholders this phase replaces with real panels.
- `src/components/brf-score-card.tsx` — Phase 2 visual language for value + mini-rating + confidence badge + expandable source reveal; the closest analog for the price/demographics panels' confidence + sourcing treatment (D-09).
- `src/components/listing-summary.tsx` / `listing-skeleton.tsx` — metric-card + loading-skeleton patterns; pris/kvm already computed here (`prisPerKvm`) — reuse for the listing's own pris/kvm in the comparison.
- `src/lib/schemas/listing.ts` — `normalizeScraperOutput()` null-tolerant external-data normalization pattern; replicate for sold-price and SCB responses.
- `src/lib/apify/booli-scraper.ts` + `src/actions/analyze.ts` — Apify call + server-action (validate → fetch external → parse → save) pattern to extend for sold prices.

### Established Patterns
- Swedish UI / English code; partial-data tolerance ("Ej tillgänglig" / "Osäker"); warm earthy palette (sage primary, terracotta accents); light mode only.
- Zod v4 (`zod/v4` import path) for all external-data validation.
- `serverExternalPackages` in `next.config.ts` for packages with dynamic requires (apify-client precedent — check for any new SCB/geocoding deps).
- Deterministic-in-code computation where possible (Phase 2 D-08) — the ±% comparison and confidence signal are arithmetic, not LLM output.

### Integration Points
- Analysis page `src/app/(app)/analysis/[id]/page.tsx` — the two new panels render here, replacing the placeholders.
- `analyses` table — market-context results likely a new jsonb column (or related table); RLS must cover it, mirroring how BRF results were stored in Phase 2.
- Scrape-time location capture — `normalizeScraperOutput()` / scraper may need to retain additional location fields (postal code / area id / coords) to drive D-09-RD and D-10-RD queries; assess during research.
- **No SCB or geocoding integration exists yet** — new external API(s); env vars / caching / cost tracking are new surface for this phase.

</code_context>

<specifics>
## Specific Ideas

- The comparable-sales list functions as the trust "receipt" — directly analogous to Phase 2's per-figure source quotes: the buyer can see the underlying sales rather than trust a black-box average (contrast with Allabrf).
- Floor level, balcony, and avgift are the attributes the user specifically named as what makes two same-area sales genuinely comparable — prioritize surfacing these in matching/display *if* the data source provides them.
- "Kommun-correct beats neighborhood-wrong" — the user accepted a coarser-but-reliable demographics baseline over a precise-but-fragile one.

</specifics>

<deferred>
## Deferred Ideas

- BRÅ crime statistics and Skolverket school quality for the area — v2 (ENRICH-02/03).
- Avgiftshöjning / interest-rate stress prediction from market + BRF trends — v2 (ADV-01/02); also overlaps backlog item 999.4 (advanced BRF risk analysis).
- Cross-source synthesis ("vad du bör tänka på") and red/green flags combining price + demographics + BRF — Phase 4 (RPRT-01/02).
- Custom valuation / Zestimate-style price prediction — explicitly Out of Scope (requires licensed transaction data; liability).

None of the above were acted on — discussion stayed within the PRICE-01 / AREA-01 boundary.

</deferred>

---

*Phase: 03-market-context*
*Context gathered: 2026-06-17*
