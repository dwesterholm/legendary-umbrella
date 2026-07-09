# Pitfalls Research

**Domain:** Adding an owned scraping layer, agentic area-wide discovery, vision analysis, and macro-data context to an existing, shipped Swedish property-analysis product (Bostad AI v1.1)
**Researched:** 2026-07-06
**Confidence:** MEDIUM-HIGH (legal/GDPR and cost-control findings verified against multiple sources; vision-hallucination and sun-path findings verified against academic/technical sources; Booli-specific transport findings inherited from prior spike with HIGH confidence)

This is a **subsequent-milestone** pitfalls file. It supersedes the v1.0-era PITFALLS.md in scope (that file's scraping-fragility, PDF-parsing, and cost-tiering findings are still valid and are carried forward where relevant, but the center of gravity here is what changes when v1.0's "user pastes one URL" model expands into v1.1's owned GraphQL client + area-wide agentic vision scraping).

## Critical Pitfalls

### Pitfall 1: Area-Wide Proactive Scraping Silently Crosses the Legal Line the v1.0 Model Was Built to Avoid

**What goes wrong:**
v1.0's legal safety argument ("Legal: Scraping Booli carries some risk but user-initiated model minimizes exposure" — PROJECT.md) rests entirely on the scrape being triggered by a specific user pasting a specific URL they are already viewing: one request, one object, human-paced, non-repetitive. Feature 999.7 (AI free-text discovery + area-wide vision scraper) inverts this: the system proactively enumerates and scrapes *every* listing in an area on the system's own initiative, not in direct response to one URL a user is looking at. This is systematic, repeated, bulk extraction — the exact fact pattern the Database Directive's sui generis right and Booli/Hemnet's ToS are designed to stop, and the exact fact pattern legal commentary explicitly distinguishes from the "limited, targeted, non-mass, occasional, non-repetitive" access that may fall within an exception. Ship this without re-deriving the legal posture and you've quietly rebuilt the exact risk profile v1.0 deliberately engineered away — for a UX feature, not a data-access necessity.

**Why it happens:**
The distinction between "user-initiated" and "proactive/agentic" feels like a UX framing detail (the user still typed a free-text query that *triggers* the scrape), but legally it is not the same thing. A user pasting one URL they are looking at is functionally equivalent to a human manually visiting that page — no different in kind from normal browsing. A user typing "3 rum i Vasastan med balkong" that triggers the system to autonomously crawl and scrape 40-200 listings is the system deciding what to scrape, at what volume, on what cadence — proportionality and scale, not user intent, are what the law weighs. Developers under solo-dev time pressure tend to treat "the user asked for it" as sufficient legal cover; it is necessary but not sufficient.

**How to avoid:**
- Treat 999.7 as requiring an explicit **go/no-go legal review before any implementation**, not an implementation detail folded into the phase. This is large enough (and different enough from v1.0's posture) that PROJECT.md's "Legal" line must be rewritten for v1.1, not inherited silently.
- Cap the blast radius per search: hard-limit the number of listings fetched per user query (e.g. 20-30, not "all matching listings in the region"). Smaller, bounded, user-triggered batches are far more defensible than open-ended area crawls.
- Rate-limit and pace requests to resemble a human browsing session, not a crawler — this was already a v1.0 principle (PITFALLS.md v1.0 Pitfall 4) and must carry forward with equal or greater discipline now that volume is higher.
- Do not cache/store raw scraped listing fields beyond the time needed to produce the ranked result — same "transform, don't redisplay" principle as v1.0, now applied to N listings instead of 1.
- Add a kill switch: if Booli/Hemnet signal displeasure (CAPTCHA, blocking, legal contact), the feature must degrade to "search only what the user explicitly pastes," not silently retry harder.
- Consider explicitly bounding scrape scope to areas/quantities that a genuinely interested buyer could plausibly have viewed manually in one session — this keeps the "looks like a human" argument credible.

**Warning signs:**
- Phase 999.7 spec allows unbounded "scrape all listings in [postnummer/kommun]" without a per-query cap
- No documented rationale for why the new access pattern is still defensible under the same "user-initiated" framing as v1.0
- Booli/Hemnet ToS not re-read specifically for this feature (ToS may prohibit "systematic" or "automated" retrieval regardless of trigger)
- No kill switch / feature flag to disable proactive scraping independently of the single-URL flow

**Phase to address:**
Must be resolved **before** 999.7 implementation begins — treat as a go/no-go gate at the start of that phase, informed by a short legal-risk spike (read Booli/Hemnet ToS verbatim, re-derive the proportionality argument, set explicit per-query and per-day scrape caps). Do not fold into 999.6 (which stays within v1.0's single-listing legal posture) or ship silently as part of "discovery UX."

---

### Pitfall 2: Scraped Broker/Vitec Pages and Gallery Images Can Carry Personal Data the Product Was Never Designed to Handle

**What goes wrong:**
v1.0's GDPR posture is scoped to BRF årsredovisning PDFs (which may contain styrelseledamöter names) — handled by not persisting the source PDF. Features 999.2 (broker/Vitec page extraction) and 999.7 (gallery image vision analysis) introduce new personal-data surfaces: broker pages routinely include the **mäklare's name, photo, phone number, email**; listing description text sometimes names the seller or mentions "kontakta [name]"; gallery photos of interiors can incidentally capture people, family photos on walls, mail with names/addresses, or other identifiable content the vision model then "sees" and could echo into output. None of this is BRF-report personal data, so the existing GDPR mitigation (delete-the-PDF) doesn't cover it — it's a new category of PII the v1.0 privacy policy and retention logic were never built to handle.
Public availability does not exempt this from GDPR — broker names/photos are personal data regardless of where they're published, and processing them still requires a lawful basis.

**Why it happens:**
Developers scope GDPR thinking to "the obviously sensitive document" (the årsredovisning) and don't re-run the same analysis for new, seemingly-innocuous data sources like a broker's public contact card or a listing gallery photo. Vision models describing an interior photo have no concept of "don't mention the family portrait on the wall" unless explicitly instructed.

**How to avoid:**
- Extend the retention/deletion policy from 999.2/999.7's outputs: extract only the structured fields the product needs (address, price, floor, balcony, condition signals) and discard broker contact info, raw description text beyond what's needed, and raw images after vision analysis completes — don't persist them "just in case."
- Add an explicit vision-prompt instruction to never mention or describe people, faces, personal documents, or identifiable non-property content visible in a photo — scope the vision task strictly to architectural/condition attributes.
- Do not surface the broker's personal contact details in the product UI/report — the product's value proposition is independent analysis, not a broker directory; carrying broker names through adds legal surface for zero product value.
- Revisit and version the privacy policy for v1.1 specifically calling out the new data sources (broker pages, gallery images) and their retention/deletion behavior.

**Warning signs:**
- Broker name/phone/email fields flow into the database or report output unfiltered
- Vision analysis prompts don't explicitly exclude people/personal-document description
- No retention-limit test exists for the new 999.2/999.7 data paths (only the original PDF-deletion path is tested)

**Phase to address:**
999.2 (broker extraction) — scope the extraction schema to exclude/discard broker PII at design time. 999.7 (vision scraper) — add explicit "ignore people/personal content" instruction to the vision prompt and confirm no raw gallery images are persisted post-analysis.

---

### Pitfall 3: Vision-Derived "Soft Attributes" Violate the No-Fabrication, Every-Claim-Cited Product Philosophy

**What goes wrong:**
The entire v1.0 product philosophy is "deterministic in code, no fabrication, every claim cited" (PROJECT.md) — enforced today by keeping flags/scores in code and using structured extraction with source citations for financial data. Feature 999.7 asks a vision model to infer soft, subjective attributes from photos and floor plans: "kitchen is modern," "bathroom needs renovation," "floor plan allows removing this wall for a 3-room conversion." These are precisely the kind of confident-but-unverifiable outputs LLM vision systems are known to get wrong — general LLM accuracy on real-estate-domain visual/textual tasks has been benchmarked at roughly 50%, and multimodal hallucination (describing objects/conditions that aren't actually there, or missing ones that are) is a well-documented, unsolved failure mode, worsened by the low image resolutions vision APIs typically process at. A user reading "renovation potential: high — remove this wall" is receiving something that looks like the same class of trustworthy, cited claim as a BRF debt figure, but was produced by a fundamentally less reliable process with no equivalent audit trail.

**Why it happens:**
Vision-model outputs feel like "just another Claude call" to integrate the same way the report-synthesis call already works, so it's tempting to slot soft-attribute claims into the report with the same confident phrasing as deterministic, code-computed flags — eroding the trust boundary that differentiates this product ("no buy/sell verdict... every claim cited") from a generic AI real-estate chatbot.
Floor-plan-specific research also flags this: dedicated floor-plan-parsing systems still struggle to eliminate unsupported statements, and there's no standardized accuracy benchmark yet for this exact task — this is genuinely unsolved ground, not a "prompt it better" problem.

**How to avoid:**
- Every vision-derived claim must be visibly and structurally distinct from deterministic/financial claims in the UI: label as "AI-tolkning av bilder — kan vara fel," never presented with the same visual confidence as a BRF score.
- Never let vision output silently become an input to a numeric score or ranking without a human-visible flag that it originated from image interpretation, not from a verified source.
- Force structured output that must cite *which image* and *what specifically* was seen (e.g. "floor plan image, non-load-bearing wall between kitchen and living room per visible dashed line") rather than free-text conclusions — this preserves the "cited claim" pattern even for soft attributes, and gives users something concrete to verify against the actual photo.
- Treat renovation-potential/wall-removal claims as the highest-risk category (load-bearing vs non-load-bearing walls are NOT reliably determinable from a 2D floor-plan image without structural drawings) — either omit this specific claim entirely or hedge it extremely explicitly ("baserat på planlösningen verkar denna vägg vara icke-bärande, men bekräfta alltid med en konstruktör innan rivning").
- Run a small held-out validation set (20-30 real listings with known ground truth you check manually) before shipping the vision-derived attributes, mirroring the v1.0 PDF-parsing validation discipline (test against 20+ real documents before trusting extraction).
- Keep vision analysis strictly advisory/ranking-input, never a standalone "fact" in the final report the way BRF numbers are.

**Warning signs:**
- Vision-derived claims rendered in the same typography/placement as deterministic flags
- No per-claim image citation in the vision extraction schema
- "Remove this wall" or similar structural claims shipped without a disclaimer about load-bearing uncertainty
- No manual validation set checked before launch

**Phase to address:**
999.7 — bake citation-per-image-region into the vision extraction schema from the first implementation plan, not retrofitted. Should reuse and extend the existing structured-output + source-citation pattern from Phase 2 (BRF extraction) and Phase 4 (report synthesis) rather than inventing a new, less rigorous pattern for vision.

---

### Pitfall 4: Sun-Path Exposure Presented as Fact When It's Actually Unobstructed-Only Geometry

**What goes wrong:**
999.7 (and its sibling backlog idea 999.1) proposes sun-path/sun-exposure as a feature, using latitude/longitude already available from the acquisition layer. Tools in the SunCalc family compute sun altitude/azimuth for a given lat/lon/time — accurate for the theoretical, unobstructed sun position — but do **not** account for neighboring buildings, trees, terrain, or the apartment's own facade orientation/floor height without genuine 3D building-geometry data. Achieving real obstruction-aware accuracy requires 3D building footprints and often voxel/point-cloud ray-tracing to get anywhere near reliable (>90%) results. Shipping "this apartment gets sun until 4pm" from lat/lon alone will be wrong for any listing with a taller building, tree, or hill to its south/west — which is common in dense Swedish cities (Stockholm innerstad especially) — and it is exactly the kind of confident-sounding, unverifiable claim Pitfall 3 warns against, applied to a new domain.

**Why it happens:**
"We have lat/lon, sun-path math is a solved problem (SunCalc, suncalc.org)" is true for the open-sky case and creates false confidence that the whole feature is a solved problem. The hard part — obstruction — is exactly the part not solved by the free/simple libraries developers reach for first, and 3D building-footprint data for Sweden is not something this project currently has an acquisition path for.

**How to avoid:**
- Scope the v1.1 sun feature honestly: theoretical/unobstructed sun exposure by facade orientation and time of year, labeled explicitly as such ("teoretisk solexponering baserad på lägenhetens riktning — tar inte hänsyn till skuggning från omgivande byggnader"), not "how much sun you'll actually get."
- Do not claim obstruction-aware accuracy unless a genuine 3D-geometry data source is identified and integrated (Lantmäteriet 3D building data, if accessible, or an existing service like Shadowmap — evaluate cost/licensing before committing, given the near-zero-budget constraint).
- If floor/facade orientation itself is uncertain (999.2 is explicitly trying to recover "floor" as a currently-missing field), sun-path output inherits that uncertainty — don't compute and display sun-path for listings where floor/orientation data is unavailable or low-confidence; degrade gracefully (same "Ej tillgänglig" pattern as other missing data in v1.0) rather than guessing orientation from address alone.
- Consider deferring true obstruction modeling to a later milestone and shipping only the unobstructed baseline in v1.1, clearly labeled — matches the "deterministic, no fabrication" philosophy better than a fake-precise obstruction estimate.

**Warning signs:**
- Sun-exposure feature ships without a disclaimer distinguishing theoretical vs obstruction-aware
- No 3D building-geometry data source identified before committing to "accurate" sun-exposure claims
- Facade orientation inferred from address geocoding alone (unreliable for exact building-facing direction) rather than from actual building/floor-plan data

**Phase to address:**
999.7 — scope decision needed at requirements time (before implementation): ship "theoretical sun-path by orientation, clearly labeled" as v1.1 MVP for this sub-feature; explicitly defer obstruction modeling as a documented gap, not a silent omission.

---

### Pitfall 5: Vision-Over-N-Listings Cost Scales Multiplicatively and Can Blow the Near-Zero Budget Fast

**What goes wrong:**
v1.0's cost discipline (see `src/lib/brf/cost.ts`, `src/lib/market/cost.ts`) is built around **one Haiku extraction + one Sonnet synthesis per single-listing analysis**, with a hard SEK cost-cap gate before persisting (per the existing `costSekSonnet`/budget-guard pattern and the project memory note on structured-output limits). Feature 999.7 changes the unit of work from "1 listing" to "1 search = N listings," and for each of those N listings proposes running a vision model over multiple gallery images **plus** the floor-plan image **plus** description text — potentially 5-10+ images per listing. If a search returns 40 listings and each needs ~8 vision calls (or one multi-image call with a large payload), that's 320+ image-bearing model calls for a single user search, at vision-input token costs that are meaningfully higher than pure text. Without a hard per-search budget cap analogous to the existing per-analysis cap, one broad free-text search in a popular area (Södermalm, Vasastan) could cost multiple dollars in Claude spend for a single user interaction that may not even convert to a paying report — a direct threat to the "<$100/month infra" constraint at any meaningful usage volume, and a much easier way to blow budget than the existing single-listing flow.

**Why it happens:**
The existing cost-cap pattern was designed and tested for a 1-Haiku + 1-Sonnet-call shape; extending it to "N listings × M images" is not automatic — it requires deliberately generalizing the budget-guard abstraction, and it's easy to ship the vision-analysis loop first ("does it work for one listing") and only notice the multiplicative cost when it's already live and being hit by real area-wide searches.

**How to avoid:**
- Design the per-search budget cap **before** writing the vision loop, not after: hard cap on (a) number of listings scanned per search, (b) number of images analyzed per listing (e.g. floor plan + 2-3 gallery images, not the full gallery), and (c) total SEK cost per search — reuse and generalize the existing `costSekSonnet`/`costSek` budget-guard pattern rather than inventing a parallel one.
- Use the cheapest model tier that can do the job for the coarse per-listing pass (Haiku first, only escalate to Sonnet for listings that pass an initial cheap filter or for the final ranked shortlist) — mirrors the existing Haiku-extract/Sonnet-synthesize tiering discipline already proven in this codebase.
- Pre-filter with deterministic/free signals (price, size, rooms, area) before spending any vision budget — only run vision analysis on listings that already pass the user's hard filters, not the full raw area scrape.
- Cache vision-analysis results per listing (keyed by listing ID + image hash) so a popular listing analyzed for one user's search isn't re-analyzed from scratch for the next user's overlapping search — turns per-search cost into largely one-time-per-listing cost.
- Track and surface cost-per-search in the same way cost-per-analysis is already tracked; set an alert threshold specific to this feature since its cost profile is structurally different from the existing single-listing flow.
- Consider a rate-limit or paywall/quota on the discovery feature itself (e.g. limited free searches per day) independent of the existing per-analysis paywall, since this feature's cost is incurred before any purchase decision.

**Warning signs:**
- No documented per-search SEK cap before 999.7 implementation begins
- Vision loop implemented as "call vision model per listing per image" with no listing-count or image-count ceiling
- No caching layer for vision-analysis-per-listing results
- Cost tracking dashboard doesn't distinguish discovery-search cost from report-generation cost

**Phase to address:**
999.7 — the budget-guard generalization is foundational and should be one of the first implementation plans in this phase (before the vision-analysis loop itself), not a retrofit. Should explicitly reuse/extend `src/lib/brf/cost.ts` / `src/lib/market/cost.ts` patterns rather than building parallel cost logic.

---

### Pitfall 6: Macro Data (SCB/Riksbank) Gets Used to Imply a Valuation the Product Deliberately Refuses to Give

**What goes wrong:**
The product's core trust mechanic is explicitly **no buy/sell verdict** and **no proprietary valuation** (999.1's price estimator is deliberately deferred/out of scope for a reason — see Key Decisions: "Claude's reasoning substitutes for statistical models," deterministic flags only). Feature 999.3 (macro-driven price context — Riksbank rates, SCB price indices) is easy to implement in a way that quietly reintroduces a valuation signal through the back door: "given current rates and area trend, this price is likely to rise/fall X%" is a prediction, not context, and crosses a line the product has so far carefully avoided. Even phrasing like "given rising rates, this BRF's avgift may become harder to afford" edges toward advice/prediction if not scoped carefully.

**Why it happens:**
Macro indicators are inherently forward-looking and correlate with future price movement — the whole reason they're being added is to make the price-comparison context "smarter." The line between "here is the macro context, make of it what you will" (allowed) and "here is what the macro context implies for this property's future value" (the exact verdict the product avoids) is subtle and easy to cross in a synthesis prompt without noticing, especially since the LLM naturally wants to draw the connecting inference.

**How to avoid:**
- Scope 999.3 output as **descriptive context only**: "Riksbordsräntan är X%, ned/upp Y punkter sedan förra året. Prisindex för [område] har [rört sig Z%] under samma period." Never "detta innebär att priset troligen kommer..."
- Add an explicit negative constraint to the synthesis prompt (mirroring the existing "no buy/sell verdict" schema enforcement — PROJECT.md notes this is enforced by schema, not just prompt instruction) that macro data must not be used to predict future price direction for the specific listing.
- Keep macro data as a separate, clearly-labeled report section ("Marknadsläge" / "Makroekonomisk kontext") rather than interleaving it into the price-comparison verdict language, so it reads as background, not analysis-of-this-property.
- Reuse the same schema-level enforcement pattern that currently prevents a verdict field from existing at all (per Key Decisions: "enforced by schema (no verdict field)") — extend that schema discipline to prevent a "predicted price direction" field from being introduced via 999.3.
- Test the synthesis output specifically for predictive language creep ("kommer att," "förväntas stiga/sjunka," "bra tidpunkt att köpa") as part of this phase's QA, not just financial-figure accuracy.

**Warning signs:**
- Report synthesis prompt for 999.3 includes any instruction resembling "explain what this means for the property's value going forward"
- New schema field that expresses direction/magnitude of expected future price change
- User-facing copy that reads as timing advice ("nu är ett bra läge" / "vänta med att köpa")

**Phase to address:**
999.3 — schema and prompt design must bake in the same verdict-free constraint the report schema already enforces elsewhere. This is a design-time decision, not a QA afterthought — define the allowed output shape (context-only) before writing the synthesis prompt.

---

### Pitfall 7: BRF Auto-Fetch Retrieves the Wrong Document, Wrong Year, or Wrong Organization

**What goes wrong:**
The manual-upload flow (v1.0, BRF-03) is safe because the user supplies the exact document for the exact BRF they're evaluating — there's no matching ambiguity. Auto-fetching from Allabrf/Bolagsverket introduces a **matching problem**: BRF names are not unique or standardized (many BRFs share generic names like "Brf Solängen" across different municipalities), Bolagsverket's registry is keyed by organisationsnummer which the acquisition layer may not reliably have for a given listing (999.2 is explicitly trying to recover "BRF name" as a currently-missing field — meaning the input to this matching problem is itself uncertain), and even with a correct BRF match, fetching "the latest report" risks grabbing a stale year if the most recent filing lags, or the wrong report if a BRF underwent a name change, split, or ombildning. Silently analyzing the wrong BRF's finances and presenting it as this listing's BRF health score is a severe trust failure — arguably worse than "data unavailable," because it's confidently wrong rather than honestly missing.

**Why it happens:**
Automated matching pipelines optimize for "found a plausible match" rather than "found a certain match," especially under solo-dev time pressure to make the auto-fetch feel magical/complete. The failure is invisible at build time (the demo BRF matches correctly) and only surfaces in production against real listings with ambiguous names — the same "works on my 5 test cases, breaks on the 6th" pattern the v1.0 PITFALLS.md already flagged for PDF parsing, now one layer upstream at the *document identification* step rather than the *document parsing* step.

**How to avoid:**
- Require a high-confidence match key before auto-fetching — ideally organisationsnummer, not just BRF name string-matching. If 999.2 can't reliably recover organisationsnummer or an unambiguous BRF identifier from the listing/broker page, auto-fetch should not proceed for that listing; fall back to manual upload rather than guessing.
- Surface the matched document's identifying metadata to the user before treating it as ground truth: "Vi hittade årsredovisning för [BRF-namn, orgnr, år X] — stämmer detta med din bostad?" — a lightweight confirmation step, not silent substitution, especially for the first several months of this feature's life.
- Always show the fetched document's fiscal year prominently in the report, and flag explicitly if it's not the most recent year available ("Årsredovisning avser räkenskapsår 2024 — nyare rapport kan finnas").
- Log and monitor match-confidence/fallback-to-manual-upload rate as a launch metric — a high fallback rate is a signal the matching heuristic needs work, not that the feature is "basically done."
- Never let a low-confidence auto-fetch silently replace the option to manually upload — manual upload must remain the equally-visible primary path, with auto-fetch as an assist, not a replacement, at least until match accuracy is proven over real usage (mirrors the v1.0 PDF-parsing lesson: "design for AI-assisted extraction with human verification, not fully automated").

**Warning signs:**
- Auto-fetch matches by BRF name string similarity alone, with no organisationsnummer verification
- No UI moment where the user confirms the fetched document is theirs before it's used
- Fiscal year of the fetched report not surfaced prominently in the output
- No metric tracking auto-fetch match-confidence or fallback rate post-launch

**Phase to address:**
The BRF auto-fetch phase (unscoped/TBD in current backlog — should be its own explicit phase or clearly bounded within 999.2/BRF-adjacent work) — the confirmation-step UX and organisationsnummer-based matching requirement should be defined at requirements time, before the fetch pipeline is built, not bolted on after a wrong-document incident.

---

### Pitfall 8: Solo-Dev Scope Overrun — This Milestone Is Five Separate Large Efforts Wearing One Milestone Name

**What goes wrong:**
At 5-10h/week, each of the five v1.1 features (999.6 owned GraphQL client, 999.2 broker extraction, 999.3 macro context, 999.7 agentic vision discovery, BRF auto-fetch) is independently substantial — 999.7 alone bundles agentic area-wide scraping, multi-image vision analysis, configurable niche ranking, AND sun-path computation, any one of which could be its own milestone. Treating "v1.1" as a single scoped unit of work risks the classic solo-dev failure mode: months pass with all five features half-built, none shippable, momentum lost, and (per the v1.0 experience already logged in Key Decisions) no user validation happening in the meantime because there's nothing new to show users.

**Why it happens:**
Ambitious feature lists get written in one excited planning burst ("describe what you want and let AI find it" is a genuinely compelling pitch) without weighing each item against the 5-10h/week constraint that shipped v1.0 successfully in four disciplined phases. The backlog phase descriptions (999.1-999.8) already read as "captured for future planning" rather than "scoped and estimated," which is appropriate for a backlog but dangerous if promoted into an active milestone without re-scoping each one individually.

**How to avoid:**
- Sequence, don't parallelize: 999.6 (owned GraphQL client) should ship and stabilize *before* 999.7 depends on it for area-wide scraping — this is already implied by the roadmap's "AFTER the Phase 3 sold-source spike" sequencing logic in the 999.6 backlog entry, and should be made an explicit hard dependency, not a soft suggestion.
- Split 999.7 into its own sub-phases rather than one phase: (1) area-wide scrape + deterministic filtering, (2) vision analysis of description/gallery, (3) floor-plan renovation-potential analysis, (4) sun-path — each independently shippable and independently killable if it proves too costly/inaccurate/risky (per Pitfalls 1, 3, 4, 5 above). Ship (1) alone as a checkpoint before committing to (2)-(4).
- Apply the same "kill criteria" discipline already used for the product overall (Context: "need paying users within first months") to each sub-feature: define what "not worth continuing" looks like for vision-discovery specifically (e.g. if vision cost-per-search exceeds a threshold, or match-quality is poor) before investing further weeks.
- Re-derive a per-phase time budget consistent with v1.0's actual phase durations (Phase 1: ~1 week wall-clock at this cadence per ROADMAP.md dates, Phase 2: ~10 days, Phase 3: ~6 days, Phase 4: ~15 days) — if a 999.x phase's estimate is wildly larger than any v1.0 phase, that's a signal to split it further before starting.
- Prioritize by risk-adjusted value: 999.6 (owned acquisition) and 999.2 (deeper extraction) are comparatively low-risk, high-clarity engineering tasks with an existing spike de-risking them — sequence these first. 999.7 carries the legal (Pitfall 1), cost (Pitfall 5), and hallucination (Pitfall 3) risks identified above — sequence it last, and only after 999.6 is stable, so the riskiest, least-proven feature isn't also the one the whole milestone's timeline depends on.

**Warning signs:**
- 999.7 has a single phase entry with no internal plan breakdown by the time implementation starts
- No explicit dependency ordering enforced between 999.6 and 999.7 in the roadmap
- Weeks pass with commits across multiple 999.x features simultaneously rather than one at a time to completion
- No mid-milestone checkpoint to reassess scope (unlike v1.0's phase-by-phase transitions, which forced regular reassessment)

**Phase to address:**
Roadmap-creation time (immediately, before phase plans are written) — sequence 999.6 → 999.2 → 999.3 → [999.7 split into sub-phases] → BRF auto-fetch, or similar, with explicit dependency gates and a mid-milestone go/no-go checkpoint after 999.6/999.2 land, before committing further weeks to 999.7.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Reusing v1.0's single-listing cost-guard pattern unmodified for 999.7's N-listing vision loop | Ship discovery faster | Multiplicative cost blowup goes undetected until a real area search runs (Pitfall 5) | Never — generalize the budget guard before the vision loop, not after |
| Matching BRF auto-fetch by name string similarity instead of organisationsnummer | Faster to implement, no need to solve the org-number recovery problem first | Wrong-BRF matches presented with false confidence (Pitfall 7) | Never for production; acceptable only behind a "low confidence — please confirm" gate |
| Treating 999.7's vision-derived claims with the same UI weight as deterministic BRF/financial claims | Simpler report template, less UI work | Erodes the product's core "no fabrication, every claim cited" trust differentiator (Pitfall 3) | Never |
| Shipping sun-path exposure without disclaiming obstruction is unmodeled | Feature "looks done" faster | Confidently wrong claims for any listing near taller buildings/trees — common in Swedish cities (Pitfall 4) | Only with an explicit, prominent "theoretical, unobstructed" disclaimer; never silently |
| Folding 999.3 macro context directly into the existing price-comparison prose without a schema-level no-prediction constraint | Less schema work | Synthesis prompt drifts into implied price predictions over time as prompts are iterated (Pitfall 6) | Never — bake the constraint into the schema at design time |
| Promoting 999.7 into the active milestone as one phase instead of splitting into sub-phases | Simpler roadmap, feels like "one feature" | No checkpoint to kill/descope the riskiest sub-parts (vision, sun-path) independently if they prove infeasible (Pitfall 8) | Never for a feature this size at 5-10h/week |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|-------------------|
| Own `booli-graphql` client (999.6) | Assuming the direct-fetch path will keep working indefinitely once the spike confirms it once | Keep the Apify-proxy and paid-actor tiers as live fallbacks, not just documentation — Cloudflare posture can change without notice; the fallback tree must be exercised (tested), not just designed |
| Broker/Vitec pages (999.2) | Treating every broker's page template as uniform because the first few tested ones matched | Vitec is common but not universal — mäklarfirmor use varied CMS/templates; build the same "partial data, graceful degradation" posture used for Booli itself, per-broker-template |
| Allabrf/Bolagsverket auto-fetch | Treating Allabrf as a stable API (it's a scraped website, same fragility class as Booli — already flagged in v1.0 PITFALLS.md) | Prefer Bolagsverket's official API where coverage allows; treat Allabrf as a fallback with the same scraping-fragility caveats as Booli, not as a primary trusted source |
| Riksbank/SCB macro APIs (999.3) | Assuming update cadence matches listing-analysis cadence (real-time) | Riksbank rate decisions and SCB indices update on fixed schedules (monthly/quarterly) — cache aggressively and don't imply macro data is "live" when it's necessarily lagged |
| Claude vision API for gallery/floor-plan images (999.7) | Sending full-resolution multi-image galleries per listing without a per-listing image-count/size cap | Cap images per listing (floor plan + 2-3 representative gallery images), resize/compress before sending, and gate vision calls behind the deterministic pre-filter (Pitfall 5) |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|-----------------|
| Area-wide scrape fetches all listings before any filtering | Slow search response, high scrape volume even for narrow user intent, elevated legal exposure (Pitfall 1) | Apply deterministic filters (price/size/rooms/area) server-side against the acquisition layer's own query capability before fetching full listing detail for vision analysis | Any area with 50+ active listings — common for central Stockholm/Gothenburg postnummer |
| Vision analysis run synchronously per listing in a loop during the user's search request | User-facing search takes minutes instead of seconds; user abandons before results return | Run discovery as an async job (matches the existing async-report pattern from v1.0's report-generation flow) — return progressively, don't block the request on all N vision calls | Any search returning more than a handful of listings |
| No caching of vision-analysis-per-listing results across different users' overlapping searches | Same popular listing analyzed by vision N times for N different users' searches in the same area/timeframe | Cache by listing ID + image-set hash; treat vision analysis as a per-listing enrichment step, not a per-search one | As soon as two users search overlapping areas — will happen quickly with even modest usage |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Persisting broker contact PII or raw gallery images from 999.2/999.7 beyond the analysis step | GDPR exposure distinct from and additional to the existing BRF-PDF retention risk (Pitfall 2) | Extend the existing "delete source after extraction" discipline to these new data types explicitly; don't assume the existing PDF-deletion policy covers them |
| Vision prompts with no instruction to ignore/redact people or personal documents visible in photos | Product output could describe or reference identifiable third parties captured incidentally in listing photos | Explicit "ignore/do not describe people or personal documents" instruction in every vision prompt touching gallery images |
| Auto-fetched BRF documents matched and displayed without provenance metadata | User can't verify which BRF/year the report is actually about if the match is wrong — makes the wrong-document failure (Pitfall 7) invisible to the user too | Always display org.nr + fiscal year of the source document prominently, with a lightweight user-facing confirmation step for auto-fetched (not manually uploaded) documents |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-------------------|
| Vision-derived "renovation potential" claims styled identically to deterministic BRF flags | User can't tell which claims are reliably sourced vs. AI-guessed from a photo, undermining trust in the whole report | Visually and structurally separate AI-image-interpretation claims (own section, own disclaimer, own citation-to-image pattern) from deterministic/financial claims |
| Sun-exposure shown as a single confident number/graphic with no caveat | User believes the apartment's actual sun exposure is known, then experiences a mismatch after moving in | Explicit "teoretisk, baserad på riktning — tar inte hänsyn till skuggning" label wherever sun data is shown |
| Auto-fetched BRF report silently replaces the manual-upload option | User with a better/more current document than what was auto-fetched has no way to override it, and may not even notice a mismatch occurred | Keep manual upload equally prominent; let the user override/replace an auto-fetched document at any time, with the fetched one shown as a suggestion, not a fait accompli |
| Area-wide discovery search returns results with no indication of how many listings were actually scanned/skipped due to the per-search cost/scope cap | User assumes "found 5 great matches" means "these are the 5 best of everything available," when really only a capped subset was ever scanned | Surface scan scope honestly: "Genomsökte de 30 senaste annonserna i [område] — visar 5 som matchar" |

## "Looks Done But Isn't" Checklist

- [ ] **Owned `booli-graphql` client (999.6):** Works against the spike's known test listings — verify it also handles the single-listing-by-URL retrieval path in production (the spike's explicitly flagged open question), not just search-based queries
- [ ] **Broker/Vitec extraction (999.2):** Works for the broker templates tested during development — verify graceful degradation (not silent wrong-data) for the broker CMS templates not tested, and confirm broker PII is excluded from output (Pitfall 2)
- [ ] **Macro price context (999.3):** Numbers display correctly — verify the synthesis prompt/schema structurally prevents predictive/verdict language, not just that it "didn't happen to generate any" in testing (Pitfall 6)
- [ ] **AI discovery search (999.7):** Returns plausible-looking ranked results for a demo query — verify a hard per-search cost cap actually fires under a broad, popular-area query before this ships, not just under the narrow queries used in development (Pitfall 5)
- [ ] **Vision floor-plan analysis (999.7):** Correctly identifies renovation potential on a few test floor plans — verify against a held-out validation set of 20-30 real, diverse floor plans with manually-checked ground truth, specifically checking for confidently-wrong load-bearing-wall claims (Pitfall 3)
- [ ] **Sun-path exposure (999.7):** Computes a plausible sun-hours number from lat/lon — verify it's explicitly labeled as unobstructed/theoretical and does not claim obstruction accuracy it cannot deliver (Pitfall 4)
- [ ] **BRF auto-fetch:** Successfully fetches a document for test BRFs with well-known, unique names — verify behavior against BRFs with common/ambiguous names, and confirm a confirmation/override step exists before the fetched document is treated as ground truth (Pitfall 7)
- [ ] **Legal posture (999.7):** Feature works end-to-end technically — verify the go/no-go legal review (Pitfall 1) actually happened and is documented, with explicit per-query/per-day scrape caps, before this reaches any real users, not just before it reaches code review

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|------------------|
| Legal complaint/blocking triggered by area-wide scraping (Pitfall 1) | HIGH | Immediately disable 999.7's proactive scraping (kill switch), revert to single-URL-only discovery, review with legal counsel before any re-enable; consider whether the feature can survive at all under a much smaller scope (e.g. only within listings a user has already individually pasted) |
| Vision-derived claim reaches users and turns out fabricated/wrong (Pitfall 3) | MEDIUM-HIGH | Same posture as v1.0's hallucination recovery: issue correction to affected users, tighten the vision prompt's citation requirement, consider removing the specific claim type (e.g. wall-removal potential) entirely if repeat offender |
| Vision/discovery cost spike blows monthly budget (Pitfall 5) | LOW-MEDIUM | Immediate: drop per-search listing/image caps further, disable the feature above a daily spend threshold (circuit breaker); medium-term: add caching, pre-filtering, cheaper-model-first tiering before re-enabling at prior limits |
| Wrong BRF auto-fetched and analyzed for a real listing (Pitfall 7) | MEDIUM | Add/tighten the confirmation-step UX immediately, audit recent auto-fetches for other mismatches, notify any affected users, fall back to manual-upload-only until organisationsnummer-based matching is verified reliable |
| Macro context drifts into implied price prediction after prompt iteration (Pitfall 6) | LOW | Add automated regression test checking synthesis output against a banned-phrase list (predictive language) as part of the report-generation test suite; retighten schema constraint |
| Milestone stalls with multiple 999.x features half-built (Pitfall 8) | MEDIUM | Apply the same instinct that shipped v1.0: pick the single most complete/lowest-risk feature (likely 999.6 or 999.2), finish and ship it alone, explicitly re-scope or defer the rest rather than continuing to split attention |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|-------------------|----------------|
| Area-wide scraping crosses legal line (Pitfall 1) | Go/no-go gate before 999.7 | Documented legal-risk re-derivation; per-query/per-day scrape caps in code, not just policy; kill switch implemented and tested |
| New PII surfaces from broker pages/gallery images (Pitfall 2) | 999.2, 999.7 | Extraction schema excludes broker PII; vision prompts explicitly instructed to ignore people/personal documents; retention/deletion tested for new data paths |
| Vision hallucination on soft attributes/floor plans (Pitfall 3) | 999.7 | Per-claim image citation enforced in schema; held-out validation set (20-30 listings) checked before launch; UI visually distinguishes vision claims from deterministic claims |
| Sun-path obstruction accuracy overstated (Pitfall 4) | 999.7 | Explicit "theoretical/unobstructed" disclaimer shipped; no obstruction-accuracy claim without genuine 3D-geometry data source integrated |
| Vision-over-N-listings cost blowup (Pitfall 5) | 999.7 (first implementation plan, before vision loop) | Per-search SEK cap enforced in code (generalized from `costSek`/`costSekSonnet`); tested against a broad/popular-area query, not just narrow demo queries |
| Macro data implies valuation/prediction (Pitfall 6) | 999.3 | Schema has no direction/magnitude prediction field; automated banned-phrase regression test on synthesis output |
| BRF auto-fetch wrong-document/year/BRF (Pitfall 7) | BRF auto-fetch phase (define explicitly at requirements time) | Organisationsnummer-based matching (not name-only); user confirmation step for auto-fetched documents; fiscal year always surfaced |
| Solo-dev scope overrun across 5 large features (Pitfall 8) | Roadmap-creation time, before phase plans are written | Explicit dependency sequencing (999.6 before 999.7); 999.7 split into independently-shippable sub-phases; mid-milestone go/no-go checkpoint documented in ROADMAP.md |
| (Carried forward) Scraping fragility of owned GraphQL client | 999.6 | Direct→proxy→actor fallback tree actually exercised in tests, not just designed; single-listing-by-URL path confirmed in production, not just spiked |

## Sources

- [The state of web scraping in the EU — IAPP](https://iapp.org/news/a/the-state-of-web-scraping-in-the-eu) — Database Directive proportionality and "limited, targeted, non-mass, occasional, non-repetitive" exception framing; directly supports the user-initiated-vs-proactive distinction in Pitfall 1
- [What Does It Mean to Be GDPR Compliant? — Octoparse](https://www.octoparse.com/blog/gdpr-compliance-in-web-scraping) — Personal data in scraped web content requires lawful basis regardless of public availability; supports Pitfall 2
- [GDPR and web scraping: a legal practice? — Dastra](https://www.dastra.eu/en/guide/gdpr-and-web-scraping-a-legal-practice/56357) — Legal-basis and balancing-of-interests requirements for scraped PII; supports Pitfall 2
- [Web Data Extraction — Legal Aspects and Best Practices — ESKOM.AI](https://eskom.ai/en/blog/web-data-extraction-legal-compliance/) — Practical compliance steps for scraping projects touching personal data
- [AI's legal frontier: what Europe's privacy regulators say about scraping personal data — Zyte](https://www.zyte.com/blog/ai-personal-data-scraping-europe-guidance/) — Regulator guidance on scraping and personal data, supports Pitfall 2
- [Web Scraping Legal Guide 2026 — dataresearchtools](https://dataresearchtools.com/web-scraping-legal-2026/) — Scale/proportionality as the legal distinguishing factor between bulk and targeted scraping; supports Pitfall 1
- [REAL: Benchmarking Abilities of LLMs for Housing Transactions and Services — arXiv](https://arxiv.org/pdf/2507.03477) — ~50% average accuracy of LLMs on real-estate-domain field applications; supports Pitfall 3
- [LLM-Guided Agentic Floor Plan Parsing — arXiv](https://arxiv.org/html/2604.23970) — RAG improves but does not eliminate unsupported statements in floor-plan LLM analysis; no standardized accuracy benchmark exists yet; supports Pitfall 3
- [Survey of Hallucinations in Multimodal Models — Galileo AI](https://galileo.ai/blog/survey-of-hallucinations-in-multimodal-models) — Lower image resolution correlates with more hallucination in vision-language models; supports Pitfall 3
- [Shadow Analysis Tools Compared — Shadowmap](https://shadowmap.org/learn/shadow-analysis-tools-comparison) — Basic sun-path calculators (SunCalc-class) do not account for terrain/building obstruction; accurate obstruction analysis requires 3D geometry data; supports Pitfall 4
- [Voxel Shader shadow calculation for urban building energy modeling — ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0378778826001957) — 3D point-cloud/voxel ray-tracing needed for >90% obstruction-aware shadow accuracy; supports Pitfall 4
- `.planning/spikes/booli-own-acquisition-SPIKE.md` — Prior internal spike confirming field parity, transport posture, and the single-listing-by-URL open question for 999.6 (HIGH confidence, primary source)
- `.planning/research/PITFALLS.md` (v1.0, dated 2026-02-24, superseded by this file) — carried-forward findings on scraping fragility, PDF parsing, legal exposure baseline, and API cost discipline that remain valid context for v1.1
- `.planning/PROJECT.md` — v1.1 milestone scope, constraints (solo dev, budget, legal posture), and product philosophy (no fabrication, no verdict, deterministic-in-code) that ground every pitfall above
- `.planning/ROADMAP.md` — backlog phase descriptions (999.1-999.8) defining the scope and stated unknowns for each new feature
- `src/lib/brf/cost.ts`, `src/lib/market/cost.ts` — existing cost-guard implementation pattern referenced in Pitfall 5's prevention strategy

---
*Pitfalls research for: Bostad AI v1.1 (Owned Data Layer & Intelligent Discovery)*
*Researched: 2026-07-06*
