# Feature Research — v1.1 "Owned Data Layer & Intelligent Discovery"

**Domain:** AI-powered property analysis for Swedish residential market — v1.1 adds owned data acquisition, deeper listing extraction, macro price context, AI free-text discovery + vision scraping, and BRF auto-fetch
**Researched:** 2026-07-06
**Confidence:** MEDIUM-HIGH — infra features (999.6) verified against existing project memory (Booli GraphQL/Apollo findings) and v1.0 architecture; vision/discovery features (999.7) grounded in general AI real-estate product patterns + documented hallucination failure modes (MEDIUM, few Swedish-specific comparables exist); BRF auto-fetch (Bolagsverket/Allabrf) verified via official sources (HIGH for coverage facts, MEDIUM for reliability projection).

> This is a **milestone-scoped** research file — it covers only the 5 NEW v1.1 feature areas. v1.0 features (BRF scoring, price comparison, AI report synthesis, PDF export) are already built; see git history and `.planning/milestones/` for that research. Every recommendation below is checked against the existing philosophy: deterministic flags/score in code, LLM for synthesis/reasoning only, no fabrication, no buy/sell verdict, every claim cited.

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist once a category ships. Missing these makes the new capability feel broken or half-built.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Booli acquisition reliability unchanged or better (999.6) | Users never see this layer — but if listing import gets *slower or flakier* after the Apify→owned migration, v1.0's core promise breaks. Table stakes is invisibility. | MEDIUM | Must preserve the existing fallback tree (Apify Playwright already added after Cloudflare blocked the API — see project memory). Any owned client needs its own multi-tier fallback (GraphQL → SSR/Apollo-state scrape → Apify as last-resort) or reliability regresses. |
| Floor, balcony, BRF name recovered when present on the listing (999.2) | Booli's own listing page already shows floor and balcony when the broker provided them. Users who compare your report to the Booli page directly will notice missing fields as a regression, not a bonus. | MEDIUM | These are usually already in Booli's structured data (Apollo state) or the broker's own listing page schema.org markup — not necessarily a new "AI extraction," often just an unmapped field discovered during the 999.6 migration. |
| Renovation/description text surfaced (not summarized away) (999.2) | Buyers read the mäklare's free-text description themselves today; if the app extracts structured data but drops the narrative, it feels like it removed information they had before. | LOW | Store and display full description verbatim, cited as "från annonsen" — do not paraphrase it into the AI report without attribution. |
| Free-text search returns *something* useful even with sparse filters (999.7) | Every "AI search" product (Roof AI, Zillow's natural-language search, etc.) sets the expectation that vague queries like "sunny 2-room with renovation potential in Söder" return a ranked, explained list — not an empty state or a rigid form fallback. | HIGH | This is the single biggest complexity item in the milestone. Requires: area-wide scrape (depends on 999.6), vision analysis pipeline, ranking logic, and an explanation layer per result (why it ranked here). |
| Every soft-attribute claim cited to a specific image or text source (999.7) | Consistent with the existing "every claim cited" philosophy (RPRT-01) and increasingly a *legal* expectation — NAR and NY State have flagged undisclosed AI-generated/inferred property claims as deceptive-advertising risk in 2025-2026. | MEDIUM | Every soft attribute (e.g., "kitchen appears dated") must link back to the specific photo(s) analyzed, with a confidence qualifier ("appears", "may be") — never asserted as fact. |
| BRF auto-fetch falls back to manual upload cleanly, not silently (BRF auto-fetch) | v1.0 already ships "Ej tillgänglig" honesty for missing data (D-07). Auto-fetch must slot into that existing pattern, not introduce a new failure mode. | LOW | If auto-fetch fails or the BRF isn't yet in Bolagsverket's register (most BRFs won't be until fiscal-year-2025 reports are filed, i.e., through 2026), immediately show the existing upload UI — do not leave the user in a loading/dead-end state. |
| Sun exposure shown as a simple, understandable signal, not a raw data dump (999.7) | Buyers already intuitively evaluate "does this balcony get sun" when viewing in person; a tool that shows this needs to answer that question directly (e.g., "sydvänd balkong, sol eftermiddag/kväll"), not expose azimuth degrees. | MEDIUM | Compute from listing address + floor + building orientation (via geocoding + building footprint/heightmap, similar to Shadowmap's approach) — deterministic geometry calculation, not an LLM guess. |

### Differentiators (Competitive Advantage)

Features that set the product apart from Booli/Hemnet/Allabrf and align with the "second opinion" positioning.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| AI free-text listing discovery with niche presets (999.7) | Flips the product from reactive ("analyze this one listing I found") to proactive ("find me listings matching this intent"). No Swedish competitor does this — Booli/Hemnet offer filter-based search only (rooms, price, area), never soft-attribute or renovation-potential search. This is the single biggest differentiator in the milestone. | HIGH | Configurable niches (renovation-upside, turnkey, imminent-stambyte-where-BRF-pays) let the same pipeline serve very different buyer intents. Each niche is really a ranking-weight preset over the same underlying vision-derived soft attributes plus deterministic BRF/financial signals — keep the niche logic in code (weights, thresholds), let the LLM only describe *why* a specific listing matched. |
| Vision-derived soft attributes (kitchen dated/modern, bathroom needs reno) surfaced as *evidence*, not verdicts (999.7) | International real-estate AI increasingly uses vision models to flag renovation-worthy rooms (ChatGPT/GPT-4V "fixer-upper" analysis is already a documented 2025-2026 use case). Doing this *honestly* — hedged, cited to specific photos, never asserted as fact — is the differentiator vs. generic "AI slop" products that fabricate features (documented 2025-2026 backlash, see Pitfalls). | HIGH | Frame every output as "på bilderna verkar köket vara från [decade estimate]" not "köket är omodernt." Never claim structural facts (load-bearing walls, whether a wall *can* be removed) — that requires an engineer, and Swedish sources confirm even professionals need a proper utredning to determine load-bearing status from a wall's appearance. State remodel *ideas* as speculative ("skulle kunna undersökas") never as fact. |
| Imminent-stambyte-where-BRF-pays niche (999.7) | Directly monetizes existing BRF-analysis differentiator (v1.0's biggest asset) by turning it into a *search filter*: since Swedish law and BRF practice place stambyte cost on the association (not the individual bostadsrätt owner), a listing where stambyte is imminent-but-not-yet-billed is a genuine "hidden value" case financially savvy buyers seek — a niche literally invented by combining your v1.0 BRF signals with v1.1 search. | MEDIUM | Reuses existing deterministic stambyte-flag logic from v1.0 (RPRT-02) as a *ranking input*, not new logic. Low incremental engineering cost, high narrative value — a genuinely novel Swedish product angle. |
| Sun-position map preview, standalone and draggable (999.7) | Comparable to Shadowmap Home's UX (interactive time/date sun-path exploration) — no Swedish listing site offers this at all today. Even as a lightweight version (compass + hours-of-sun-per-season for the specific unit/floor/orientation) it is new information buyers currently have to estimate by visiting in person or squinting at Google Maps satellite view. | MEDIUM-HIGH | Full Shadowmap-style 3D exploration is out of scope for a solo dev; a simpler deterministic calc (orientation + floor + season → hours of direct sun, using building footprint data or even just compass bearing + latitude) delivers most of the value at a fraction of the engineering cost. Treat "draggable map preview" as a stretch/differentiator-within-differentiator, not core to shipping sun exposure. |
| Macro-driven price context — rate environment, inflation, regional price-index trend (999.3) | No Swedish consumer tool integrates Riksbank policy-rate trajectory + SCB Fastighetsprisindex trend into a *per-listing* market-context narrative. This upgrades the existing static "vs area avg" comparison (v1.0 PRICE-01) into a forward-looking read ("prices in this region rose X% last quarter, mortgage rates are Y%, trending Z") without becoming a valuation estimator (explicitly deferred per PROJECT.md 999.1). | MEDIUM | Pure data enrichment: pull Riksbank repo-rate series + SCB Fastighetsprisindex regional series, compute trend deltas in code, feed as *additional cited context* to the existing Sonnet report-synthesis step. No new "prediction" logic — stay descriptive ("rates have been at 1.75% since [date], regional prices rose 1.3% q/q"), never predictive ("prices will rise"). |
| Deeper listing extraction via broker page (999.2) | Booli's own page is often the *thin* version of a listing; the broker's own site (Fastighetsbyrån, Svensk Fastighetsförmedling, etc.) typically has fuller descriptions, more photos, and sometimes floor plans Booli doesn't mirror. Following through to the source gives a genuinely richer report than Booli itself shows, which is a differentiator vs. just re-displaying Booli data. | MEDIUM-HIGH | Each broker site has its own HTML structure — this is N one-off scrapers, not one integration. Prioritize the 3-5 largest brokers by Stockholm/Gothenburg volume; treat "supports every broker" as unrealistic and degrade gracefully (fall back to Booli-only data) for unsupported brokers. |
| Owned Booli GraphQL client with fallback tree (999.6) | Removes a recurring Apify cost and a third-party dependency that has already broken once (Cloudflare blocking direct API access, per project memory — Apify Playwright was the workaround). Owning the client with your own fallback logic (GraphQL → HTML/Apollo-state parse → last-resort headless-browser) gives you control over reliability and removes a per-analysis marginal cost, which matters once payment (deferred) ships. | HIGH | This is *infrastructure*, not a user-facing feature — but it's the dependency every other 999.x item in this milestone sits on top of (see Dependencies section). Treat as Phase 1 of the milestone regardless of roadmap phase-naming; nothing else in this list should be scheduled ahead of a working owned client + fallback. |

### Anti-Features (Commonly Requested, Often Problematic)

Features that look good on paper for this milestone but conflict with the product's honesty/determinism philosophy or its solo-dev constraints.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Definitive "this wall can be removed" structural claims (999.7) | Users doing renovation-upside search want a clear yes/no on remodel feasibility — it's the single most valuable-sounding output of vision + floor-plan analysis. | Load-bearing status cannot be reliably determined from photos or a floor plan alone — Swedish sources confirm even professionals need a formal utredning (wall investigation) to establish this; a vision model asserting it is fabrication with real liability exposure (structural advice, not "ej finansiell rådgivning" territory — this is safety-adjacent). Directly violates the no-fabrication philosophy. | Frame purely as a discovery/idea prompt: "denna vägg skulle kunna vara intressant att undersöka för öppen planlösning — kontakta en konstruktör för att avgöra om den är bärande." Never a verdict. |
| Photorealistic "after renovation" image generation (999.7) | Extremely popular in the broader AI-real-estate space (RoomGPT, Rendair, ReimagineHome-style tools) — visually compelling, "wow" factor, directly requested by users who see it elsewhere. | Generates a specific, non-cited visual claim about what a space *could* look like that is easily mistaken by users (and possibly by Swedish/EU digital-content-disclosure rules, cf. California AB 723 precedent) for a real depiction of the property. High fabrication risk, high scope, and orthogonal to the "second opinion / analysis" positioning — this is a design tool, not a due-diligence tool. | Stick to text-based, hedged renovation-potential notes tied to cited photos. If visual output is ever wanted, it must be clearly watermarked as speculative AI-generated concept art, not attached to the analysis report core. |
| Fully autonomous, unbounded area-wide crawling as a background job (999.7) | "Just let the AI search everything and notify me" is the natural end-state of an agentic scraper and mirrors what users already get from Hemnet/Booli's own saved-search alerts. | This is explicitly the "Real-time market alerts" / "batch search" anti-feature already ruled out in the v1.0 PROJECT.md (continuous crawling infra, storage, notification system — a different product). It also multiplies Booli scraping load/legal exposure exactly when 999.6 is trying to reduce fragility, not increase it. | Keep discovery *user-initiated and bounded*: user submits a free-text query + filters, agent runs one bounded area scrape, returns ranked results once. No standing background jobs, no push notifications, in this milestone. |
| Treating vision-derived attributes as inputs to the deterministic BRF/price flag system (999.7) | Tempting for engineering simplicity — one flag pipeline instead of two, and it would make soft attributes feel as "trustworthy" as the existing red/green flags. | Violates the core architectural decision (deterministic flags/score in code, LLM for synthesis only) — vision-derived "kitchen looks dated" is inherently a probabilistic judgment call, not a deterministic computation from structured data like skuld/kvm. Mixing them would blur the trust boundary that v1.0 explicitly built (schema enforces no verdict field, pure computeFlags). | Keep vision-derived soft attributes in their own clearly-labeled "AI-bedömning av bilder" section, visually and architecturally separate from the deterministic flag system. Ranking logic (niche weights) can *use* both, but the report must never present a vision guess with the same visual authority as a computed red flag. |
| A full valuation/price-prediction model bolted onto the macro-context feature (999.3) | Once you're pulling Riksbank rates + SCB indices anyway, it's a small step conceptually to "just predict where this specific listing's price will go" — tempting scope creep from a data-availability standpoint. | Already explicitly deferred in PROJECT.md (999.1, "Proprietary price estimator that beats Booli's estimate"). Solo dev cannot realistically beat Booli/SBAB's Mäklarstatistik-backed models, and a wrong prediction is a liability magnet inconsistent with "no buy/sell verdict." | Stay strictly descriptive: report the trend and current environment as *context* ("regional prices +1.3% q/q, rates stable at 1.75%"), and let the user draw conclusions — identical posture to the existing v1.0 price-comparison layer. |
| Building a bespoke Bolagsverket scraper for BRF auto-fetch (BRF auto-fetch) | Bolagsverket doesn't yet have a clean self-serve digital API for BRF annual reports (submission is still largely paper-based as of the new 2025 filing mandate), so a scraper feels like the only path to "auto." | High effort for currently-low coverage: because the requirement to file with Bolagsverket only started for fiscal year 2025 (reports filed through 2026), the vast majority of existing BRFs' historical årsredovisningar simply are **not yet** in that register — you'd be building significant scraping infrastructure against a mostly-empty dataset today. | Treat Bolagsverket as a *slowly-improving future source*, not this milestone's primary path. Prioritize Allabrf (or similar aggregators with ~25-33k BRFs already catalogued) as the auto-fetch source now, and keep manual upload as the dependable fallback for the (currently large) gap. |

## Feature Dependencies

```
[999.6 Owned Booli GraphQL client + fallback tree]
    └──requires──> [Booli acquisition reliability parity with Apify]
                       ├──enables──> [999.2 Deeper listing extraction via broker pages]
                       │                  └──enhances──> [999.7 Vision scraper input quality (more/better photos, floor plans)]
                       ├──enables──> [999.7 Area-wide scrape for free-text discovery]
                       │                  └──requires──> [Bounded, user-initiated scrape scope (not background crawling)]
                       └──enables──> [Cost reduction that matters once payment ships (deferred)]

[999.2 Deeper listing extraction: floor, balcony, BRF name, renovation status, description]
    ├──enhances──> [999.7 Vision analysis: richer description text improves free-text↔listing matching]
    └──enhances──> [BRF auto-fetch: BRF name/org-nr extraction feeds the lookup key]

[999.7 AI free-text discovery + vision scraper]
    ├──requires──> [999.6 owned acquisition layer for area-wide scrape at reasonable cost/reliability]
    ├──requires──> [Vision model access (Claude vision) for gallery + floor-plan image analysis]
    ├──requires──> [Deterministic ranking logic in code: niche weights over vision-derived + BRF + financial signals]
    ├──enhances──> [Existing v1.0 BRF stambyte flag (RPRT-02) — reused as ranking input for "imminent-stambyte" niche]
    └──produces──> [Cited, hedged soft-attribute report per candidate listing — NOT a verdict]

[Sun exposure calculation]
    ├──requires──> [Listing address + floor + building orientation/geocoding]
    ├──independent-of──> [999.7 vision analysis] (pure geometry, not vision-derived)
    └──enhances──> [999.7 ranking: "sunny balcony" as a rankable, deterministic attribute]

[999.3 Macro-driven price context]
    ├──requires──> [Riksbank repo-rate data feed]
    ├──requires──> [SCB Fastighetsprisindex regional series]
    ├──independent-of──> [999.6, 999.2, 999.7] (can ship standalone, enriches existing v1.0 Phase 3 layer)
    └──enhances──> [Existing v1.0 AI report synthesis — new cited context, not new logic]

[BRF auto-fetch: Allabrf/Bolagsverket]
    ├──requires──> [BRF name/org-nr — already available from v1.0 listing scrape, improved by 999.2]
    ├──degrades-to──> [Existing v1.0 manual PDF upload flow (BRF-03)] on fetch failure or BRF not yet in register
    └──independent-of──> [999.7] (orthogonal feature, no shared pipeline)
```

### Dependency Notes

- **999.6 is the milestone's true Phase 1, regardless of numbering.** Every other new feature either directly requires the owned acquisition layer (999.7's area-wide scrape, 999.2's richer per-listing data) or is made cheaper/more reliable by it. Sequencing 999.7 or 999.2 ahead of a working 999.6 risks building on the fragile, paid Apify path you're trying to replace — wasted rework.
- **999.7 is the highest-complexity, highest-dependency item.** It needs 999.6 (acquisition), benefits from 999.2 (richer extraction improves match quality), and needs new deterministic ranking code plus a new "AI vision assessment" report section that must be architecturally separated from the existing deterministic-flag system. Treat as its own multi-step phase, not a single task.
- **Sun exposure is deliberately decoupled from vision analysis.** It's pure geometry (orientation, floor, latitude, season) computable in code from data already in hand after 999.2 — do not route it through the LLM/vision pipeline. This keeps it cheap, fast, deterministic, and trustworthy, and it can ship independently of 999.7's harder vision-matching work.
- **999.3 (macro context) is fully independent** of the acquisition-layer work and can be built/shipped in parallel by reusing the existing Phase 3 market-context code path — lowest-risk, lowest-dependency item in the milestone. Good candidate for an early or parallel-track phase.
- **BRF auto-fetch is independent of 999.7** but shares an input (BRF name/org-nr) with 999.2. It should degrade to the *already-shipped* v1.0 manual upload flow — no new UI paradigm needed, just a "try auto-fetch first" step in front of the existing upload.
- **The deterministic/LLM boundary must be re-drawn, not just reused, for 999.7.** v1.0's boundary was listing-data-in/BRF-numbers-in → code computes flags → LLM synthesizes prose. v1.0's boundary doesn't have a "vision produces a probabilistic judgment" input type. This needs new architecture (not just new prompts) to keep vision output visually and structurally distinct from computed flags — flag this for the architecture research file.

## MVP Definition (This Milestone)

### Launch With (v1.1 core)

- [ ] **999.6 Owned Booli GraphQL client + fallback tree** — foundation; nothing else in the milestone is reliable or cheap without it. Feasibility spike gates the go/no-go per PROJECT.md.
- [ ] **999.2 Deeper listing extraction (floor, balcony, BRF name, renovation status, description) for the top broker sites** — direct, immediately visible value-add on every existing report; low risk since it slots into the existing report structure.
- [ ] **999.3 Macro-driven price context (rate environment, inflation, regional index trend)** — independent, low-risk, high narrative value; a natural upgrade to the existing v1.0 price-comparison layer with no new architecture needed.
- [ ] **BRF auto-fetch (Allabrf primary source) with manual-upload fallback** — reduces friction on an already-loved v1.0 feature; fallback path already exists, so this is additive, not risky.

### Add After Validation of the Above (still v1.1, sequenced later)

- [ ] **999.7 AI free-text listing discovery + vision scraper (description/gallery/floor-plan analysis, niche ranking)** — the biggest bet in the milestone; validate 999.6 reliability and 999.2 extraction quality first, since this feature's output quality is bounded by both.
- [ ] **Sun-exposure signal (deterministic, per listing)** — ship as part of or shortly after 999.7 since it's a ranking input for the "sunny balcony" case, but keep it architecturally independent (pure geometry) so it can ship even if 999.7's harder vision-matching work slips.

### Future Consideration (beyond this milestone)

- [ ] **Standalone draggable sun-position map preview (Shadowmap-style 3D exploration)** — genuinely novel and differentiated, but full 3D sun-path exploration is a significant standalone engineering investment; ship the simple "hours of sun, this floor/orientation, this season" number first and revisit the interactive map only if users specifically ask for it.
- [ ] **Bolagsverket as a BRF auto-fetch source** — revisit once the fiscal-year-2025 mandatory filing requirement has had 1-2 years to populate the register; today's coverage is too sparse to justify scraper investment.
- [ ] **Photorealistic AI-generated "after renovation" visuals** — explicitly an anti-feature for this milestone (see above); could be revisited later as a clearly-labeled, separate speculative-design tool, not part of the due-diligence report.
- [ ] **Additional broker-site scrapers beyond the top 3-5** — 999.2 should prioritize by listing volume; long-tail brokers can be added incrementally without blocking launch.

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| 999.6 Owned Booli GraphQL client + fallback tree | LOW (invisible) / HIGH (enabling) | HIGH | P1 |
| 999.2 Deeper listing extraction (top brokers) | HIGH | MEDIUM-HIGH | P1 |
| 999.3 Macro-driven price context | MEDIUM | LOW-MEDIUM | P1 |
| BRF auto-fetch (Allabrf) + upload fallback | MEDIUM | LOW-MEDIUM | P1 |
| 999.7 AI free-text discovery + vision scraper (core ranking + soft attributes) | HIGH | HIGH | P2 |
| 999.7 Configurable niches (renovation-upside, turnkey, imminent-stambyte) | HIGH | MEDIUM (reuses 999.7 core) | P2 |
| Sun-exposure signal (deterministic calc) | MEDIUM | MEDIUM | P2 |
| Standalone draggable sun-position map preview | MEDIUM | HIGH | P3 |
| Bolagsverket as auto-fetch source | LOW (today) | HIGH | P3 |
| Photorealistic renovation visualization | LOW (conflicts with philosophy) | HIGH | Not planned (anti-feature) |

**Priority key:**
- P1: Ship first in this milestone — low-risk, high-confidence, independent or foundational
- P2: Ship after P1 validates — highest-value but highest-complexity/dependency bets
- P3: Defer beyond this milestone — genuinely valuable but disproportionate cost or premature given current data coverage

## Competitor Feature Analysis

| Feature | Booli/Hemnet | Allabrf.se | International refs (Zillow, Roof AI, Shadowmap) | Bostad AI v1.1 approach |
|---------|--------------|------------|--------------------------------------------------|--------------------------|
| Free-text / natural-language search | No — structured filters only (price, rooms, area) | N/A (not listing search) | Roof AI, Zillow-style NL search: understands conversational queries, ranks by relevance | Free-text intent + filters, vision-grounded soft-attribute matching, explained ranking per result, configurable niches |
| Vision analysis of listing photos | No | No | GPT-4V/ChatGPT used informally by agents for "fixer-upper" staging concepts, not structured buyer-facing scoring | Structured, cited, hedged soft-attribute extraction (kitchen/bathroom condition, remodel ideas) — explicitly not a verdict, never asserts structural facts |
| Floor-plan renovation-potential analysis | No | No | RoomGPT/ReimagineHome/Rendair generate *visualizations*, not honest assessments; no product does cited, hedged textual analysis | Text-only, cited-to-image, hedged remodel *ideas* ("could be worth investigating") — never a load-bearing/structural verdict |
| Sun exposure | No | No | Shadowmap Home: full interactive 3D sun-path/shadow simulation with time/date sliders | Deterministic hours-of-sun calc from orientation+floor+season as MVP; interactive map deferred |
| Macro/rate-aware price context | Hemnet shows raw price trend charts; no rate integration | No | N/A — no direct international listing-analysis parallel found | Riksbank rate + SCB Fastighetsprisindex trend woven into existing cited market-context report, strictly descriptive not predictive |
| BRF report auto-fetch | N/A | Has full BRF database (~25-33k associations) but as their own product, not an auto-fetch API for third parties in v1.0 scope | N/A | Allabrf as primary auto-fetch attempt (best current coverage), Bolagsverket as future source (sparse today), manual upload as guaranteed fallback |
| Owned data acquisition (vs. third-party scraper) | N/A (they're the source) | N/A | N/A | Owned GraphQL client + fallback tree replacing paid Apify actor, preserving the existing Playwright fallback discovered necessary in v1.0 |

## Key Insights for This Milestone

1. **999.6 is not a "feature" in the user-facing sense — it's the gate.** Every complexity estimate and every differentiator in this milestone (999.2, 999.7's area scrape) assumes a working owned acquisition layer. Sequence and resource it first.
2. **999.7 is where the philosophy gets its hardest test.** Vision-derived judgments ("looks dated," "could remove this wall") are inherently probabilistic in a product built on deterministic trust. The architecture must visually and structurally separate "AI's read of the photos" from "computed facts" — reusing v1.0's flag-vs-synthesis boundary pattern, but extended to cover a genuinely new input type (image-derived opinion). This is the top research flag for the roadmap.
3. **Never let vision analysis assert structural/safety facts.** Confirmed via Swedish sources: even professionals need a formal wall investigation (väggutredning) to determine load-bearing status. Any "this wall could be removed" output must be phrased as a prompt to investigate, never a conclusion — this is a hard product-safety line, not just a nice-to-have hedge.
4. **The 2025-2026 "AI slop in real estate listings" backlash is directly relevant.** Fabricated pools, invented windows, misrepresented school districts — all documented industry failure modes from generative description/image tools — are exactly the failure mode this product's "no fabrication" philosophy already guards against for BRF/price data. Extending that same discipline to vision-derived attributes is not optional; it's the differentiator vs. the sloppy end of the market.
5. **Sun exposure is a cheap, deterministic win — don't over-engineer it into the vision pipeline.** It's pure geometry and can ship independently, faster, and more cheaply than 999.7's harder matching problem, while still directly enhancing 999.7's ranking once both exist.
6. **BRF auto-fetch coverage will be genuinely low via Bolagsverket in 2026** — the fiscal-year-2025 mandatory filing requirement means most historical reports simply aren't there yet. Allabrf (private aggregator, ~25-33k BRFs) is the more realistic near-term source; either way, manual upload must remain the dependable fallback, not a "legacy" path being phased out.
7. **Macro price context is the lowest-risk, highest-ROI item in the milestone.** It reuses existing architecture, adds no new failure modes, and directly strengthens the existing (already-validated) price-comparison differentiator. Good candidate to ship first/fastest to build momentum before tackling 999.7.

## Sources

- Project memory: Booli sold-price source finding (`booli-sold-price-source.md`) — confirms Booli API/GraphQL direct access is dead, Apify Playwright/Apollo-state parsing is the current working fallback. Directly informs 999.6 fallback-tree design.
- [Bolagsverket: Annual reports for tenant-owner associations](https://bolagsverket.se/en/forening/bostadsrattsforening/arsredovisningforbostadsrattsforening.1469.html) — confirms fiscal-year-2025-onward mandatory filing, paper-based submission still standard, historical reports largely absent from the register today.
- [Bolagsverket API för att hämta företagsinformation](https://bolagsverket.se/apierochoppnadata/hamtaforetagsinformation/apiforatthamtaforetagsinformation.3988.html) — company-info API exists but is not an annual-report retrieval API.
- [Allabrf BRF-Data](https://sv.allabrf.se/brfdata) / [Brfdata.se](https://brfdata.se/) — confirms ~25-33k BRF coverage, API/integration access exists for institutional customers, continuously updated.
- [Lusa: Årsredovisning BRF guide 2026](https://lusa.se/guide/arsredovisning-brf-var-hitta) — corroborates Bolagsverket coverage gap and points to aggregator databases as the practical near-term source.
- [Frakka: Stambyte i bostadsrätt – vem betalar?](https://frakka.se/stambyte-i-bostadsratt-vem-betalar/) — confirms BRF (not individual owner) bears stambyte cost, financed via fees/loans — validates the "imminent-stambyte-where-BRF-pays" niche concept.
- [SBC: Vad innebär ett stambyte i en brf?](https://www.sbc.se/lar-dig-mer/styrelse/kunskapsartiklar/stambyte-i-bostadsrattsforening/) — corroborates financing mechanics.
- [Bobattre: Öppen planlösning — då gäller det att se upp!](https://www.bobattre.se/TemaRenovera2011Planlosning.asp) / [Sveabygg väggutredningar](https://sveabygg.se/vaggutredning/) — confirms load-bearing-wall determination requires a formal professional investigation, not visual inspection — critical honesty constraint for 999.7.
- [Coffee in the Sun: Sun Exposure in Real Estate](https://coffeeinthesun.app/blog/sun-exposure-real-estate-guide/) and [Balcony Sun Exposure guide](https://coffeeinthesun.app/blog/balcony-sun-exposure-tips/) — corroborates buyer value of sun exposure/orientation, 3-20% price premium claims for well-exposed units (MEDIUM confidence, single-source pricing figures).
- [Shadowmap Home](https://shadowmap.org/solutions/shadowmap-home/home-seeker) — reference UX pattern for interactive sun-path/shadow visualization; informs the "future consideration" scoping of the standalone map preview vs. the MVP deterministic calc.
- [The AI Consulting Network: AI Hallucinations Hit Record Sanctions](https://www.theaiconsultingnetwork.com/blog/ai-hallucinations-legal-sanctions-record-cre-investors-2026), [Nila June: Why Your AI Listing Description Might Be a Liability](https://nilajune.com/ai-listing-descriptions), [Cybernews: Home seekers frustrated with AI slop](https://cybernews.com/ai-news/ai-slop-real-estate/), [NAR: Using AI to Enhance Listing Photos Can Be Legally Risky](https://www.nar.realtor/news/real-estate-news/law-and-ethics/using-ai-to-enhance-listing-photos-can-be-legally-risky) — document the 2025-2026 industry failure mode (fabricated features, undisclosed AI content, regulatory pushback in NY/CA) that 999.7's hedged/cited design must explicitly avoid.
- [Riksbank policy rate context / boio.se bostadsmarknaden 2027 prognos](https://boio.se/guide/bostadspriser-prognos-2027), [SCB Fastighetsprisindex](https://www.scb.se/hitta-statistik/statistik-efter-amne/boende-bebyggelse-och-mark/fastigheter/fastighetspriser-och-lagfarter/pong/tabell-och-diagram/fastighetsprisindex-arsforandring/) — confirm live rate (1.75% repo rate as of mid-2026) and regional price-index series availability for the 999.3 macro-context feature.
- [Superlinked: Building an Agentic NLQ System for Real Estate Search](https://superlinked.com/blog/real-estate-nlq-agent) and [Roof AI natural-language search](https://www.roofai.com/ai-search) — reference patterns for free-text-to-ranked-results architecture informing 999.7's search/ranking design (MEDIUM confidence — general pattern, not Swedish-market-specific).
- [Claude5 Hub: Multimodal AI Face-Off 2026](https://claude5.com/news/multimodal-ai-face-off-claude-gpt-4v-and-gemini-in-2026) and [The Paperless Agent: Which LLM is Best for Real Estate](https://thepaperlessagent.com/blog/chatgpt-gemini-or-claude-which-llm-is-best-for-real-estate) — general vision-model capability context for 999.7 (LOW-MEDIUM confidence, marketing-adjacent sources — recommend a live smoke test on real Swedish listing photos before committing to a specific model/prompt design, consistent with the project's existing "Anthropic structured-output limits" memory lesson about always running a live smoke test).

---
*Feature research for: Bostad AI v1.1 (Owned Data Layer & Intelligent Discovery)*
*Researched: 2026-07-06*
