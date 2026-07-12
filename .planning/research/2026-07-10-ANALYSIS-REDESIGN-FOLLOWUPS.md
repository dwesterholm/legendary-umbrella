# Discovery analysis redesign — follow-ups & resume point (2026-07-10)

**Read first on resume.** Companion to the research synthesis:
[2026-07-10-what-makes-apartments-increase-in-price.md](./2026-07-10-what-makes-apartments-increase-in-price.md).

## Where we are
- Discovery pipeline works E2E (merged to `main`, latest `2d43a0f`): area resolve (all-Sweden probe + cache) → active-only filter (coming-soon/new-production excluded) → top-8 detail-fetch (Booli bcdn.se images **+** SPA-broker headless) → two-pass vision (broadened remodelPotential prompt) → condition-tiebreaker ranking. 681 tests, tsc/eslint clean.
- Last E2E (Södermalm+Vasastan, 1-rok ≤4M): images + vision + broker images all working; top picks Norrbackagatan 17 (34m², −9%, loft build-out potential) and Roslagsgatan 59 (32m², −4%, dated kitchen).
- **The gap = ANALYSIS quality**, not data fetch. Operator feedback: analysis is too sloppy/generic, not actionable, not holistic, misses the best candidates.

## Operator's core critiques (drive the redesign)
1. **Act like an engineer/architect** — not "investigate the wall between X and Y"; give a concrete proposal + a **drawing (planritning)** of the new structure.
2. **Be holistic** — pull in BRF state, loans/avgift, imminent stambyte, energy, AND compare price to renovated vs unrenovated comparables. Stop being image-only.
3. **Interior-designer actionability** — not "inrett i nordisk stil"; say "repaint in [color] — small flats sell faster when…", "move sofa to X / table to Y for airiness". Evidence-based.
4. **Pre-filter is backwards** — it dropped Ringvägen 122 (ancient, elderly-owned original = a renovation gold mine). Dated/original must be HIGH-value, never skipped; every candidate must get actionable analysis (no `claims: []`).

## NEW follow-up research items (investigate BEFORE writing the spec)
1. **Bathroom surfaces — real materials vs våtmatta + microcement risk.**
   - Verify: real **parkettgolv** and real **tiles (klinker/kakel)** vs **våtmatta/plastmatta** materially affects perceived quality/price (aligns with "don't over-renovate the bath — just make it not-ugly").
   - Investigate: can microcement be applied **on top of an existing våtmatta** in SOME cases? Flagged as potentially **dangerous** (tätskikt/moisture/adhesion, may void våtrumsintyg/insurance) — research feasibility, when it's OK vs not, and the risk framing the AI must give.
   - Encode: **old/ugly tile (odd colors, blue patterns, dated) = a buyer turnoff** even if functionally fine → a cheap cosmetic-refresh opportunity (microcement/retile/paint-over-tile) distinct from a full wet-room reno. Quantify buyer aversion if possible.
2. **Buyer segmentation by apartment type (who buys, what they want, buying power).**
   - 1-rok: single, usually **first-time buyer**, wants light + move-in-ready (verify). Lower buying power / premium tolerance?
   - 2–3-rok: couple, ~early–mid 30s (verify), **more buying power** → can they absorb a higher premium / reward renovation more? 
   - Research what each segment values most and how premium-tolerance differs → the AI should tailor recommendations + value-gap to the target buyer of THAT apartment size.
3. **Renovation cost-vs-profit breakdown with tiered alternatives.**
   - The analysis should give rough **cost vs profit** per opportunity, across three execution tiers:
     - **Cheap** = DIY, fair/budget materials.
     - **Mid** = some premium + some budget materials, hire a builder for the advanced parts.
     - **High** = builder for almost everything + premium materials throughout.
   - Research per-tier cost multipliers + expected uplift so the AI can present a small matrix per opportunity.
4. **Tax handling in the profit breakdown (uppskov + loss carry).**
   - Swedish capital-gains tax (22% on vinst) can be **deferred (uppskov) repeatedly**; and a **prior loss** offsets future gains. Operator: owns one flat, selling at a LOSS soon → won't pay 22% on the first profitable flips.
   - The cost-vs-profit breakdown must show **both WITH and WITHOUT tax** (and note uppskov/loss-offset), not assume a flat 22%.

## Roadmap (agreed)
1. ~~**Do the 4 follow-up research items above**~~ ✅ DONE 2026-07-10 — all 4 completed, consolidated into synthesis **§8** (8.1 bathroom/microcement, 8.2 buyer-segmentation, 8.3 tiered cost/profit, 8.4 CGT). Resume from step 2.
2. ~~**Encode the research into a SPEC doc**~~ ✅ DONE 2026-07-10 → `2026-07-10-ANALYSIS-REDESIGN-SPEC.md` (same dir). Grounded in code map: pre-filter is `enrichCandidateImages` (`job.ts:354`, Booli-order bug = D1); `claims:[]` from `vision.ts:285/332` (D2); BRF/comps not wired + lat/lng blocker (D3); generic prompt (D4). Has full ruleset + Phase A/B/C task breakdown + **4 open questions for operator** (§6) that gate the build.
3. **Implement in 3 phases:**
   - **A. Analysis brain** — flip the pre-filter; make the vision/opportunity prompt holistic (BRF + comps) + ROI-aware + granular + buyer-segment-aware + tiered cost/profit (±tax); every candidate gets analysis.
   - **B. Value-gap scoring** — §5 formula as the headline opportunity metric + ranking input (kept off computeNicheScore per the locked structural-separation constraint — use a separate vision/analysis read path + "från bildtolkning" marker).
   - **C. Proposed-drawing generation** — planritning redraw (image-gen) for viable conversions, with daylight/bearing caveats.

## Key encodable facts already gathered (see synthesis for full + sources)
- Reframe: value = buy-below-market + room-count threshold + widen-pool/speed + defend-value. Reno ROI ~50–80%; mid-range beats luxury; never "för fin för området".
- Booli Stockholm: kitchen 1→5 +200–267k, bathroom +108k (mostly value-DEFENDING), balcony +105k (söder +125k), floor +~1000 kr/m² to floor 5 (bottenvåning −10%).
- Cosmetics don't command a premium (~2% pay for paint) but photos>10 = 48% faster/+50% budpremie; extra bidder ≈ 79,200 kr.
- Hedonic weights: tomträtt −10–30%; BRF debt >15k/m² red flag; avgift capitalization −0.5…−0.7; söder>väster>öster>norr; stambyte sign-flips on funding state; energy class ~0 for apartments.
- Architect: room premium huge (inner-city 3→4 >4M); daylight gate (window per part); bärande cost-cliff (30–150k vs 220–450k); loft by takhöjd (2.40/2.70/3.30–3.60m).
- Microcement is cosmetic-only (doesn't reset tätskikt/våtrumsintyg) — ties into follow-up #1.
- Structural-separation constraint is LOCKED + static-grep-tested: niche-score.ts/flags.ts must never import vision types. condition-score.ts is the compliant separate path.

## Constraints to respect on implementation
- `DISCOVERY_ENABLED` flag; discovery job cost caps; enrichment bounded to top-8 (VISION_ENRICH_LIMIT); broker images analyze-only (never rendered/persisted, GDPR); Apify + Anthropic real spend on every run.
- Migrations: additive new numbered file only (never edit a pushed one).
