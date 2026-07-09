# Roadmap: Bostad AI

Bostad AI — an AI-powered property analysis tool for the Swedish market.

## Milestones

- ✅ **v1.0 MVP** — Phases 1–4 (shipped 2026-07-06) — [archive](milestones/v1.0-ROADMAP.md) · [audit](milestones/v1.0-MILESTONE-AUDIT.md)
- ✅ **v1.1 Owned Data Layer & Intelligent Discovery** — Phases 5–12 (shipped code-complete 2026-07-07) — [archive](milestones/v1.1-ROADMAP.md) · [audit](milestones/v1.1-MILESTONE-AUDIT.md)
  - Discovery surface (Phases 9–12) ships behind `DISCOVERY_ENABLED` (OFF) pending operator legal go/no-go + live validation gates.

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1–4) — SHIPPED 2026-07-06</summary>

- [x] Phase 1: Foundation + Core Pipeline (3/3 plans) — completed 2026-06-06
- [x] Phase 2: BRF Financial Analysis (6/6 plans) — completed 2026-06-16
- [x] Phase 3: Market Context (6/6 plans) — completed 2026-06-22
- [x] Phase 4: AI Report + Delivery (6/6 plans) — completed 2026-07-06

Full phase details: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md).

</details>

<details>
<summary>✅ v1.1 Owned Data Layer & Intelligent Discovery (Phases 5–12) — SHIPPED (code-complete) 2026-07-07</summary>

- [x] Phase 5: Owned Booli Acquisition (5/5 plans) — completed 2026-07-06
- [x] Phase 6: Deeper Listing Extraction (3/3 plans) — completed 2026-07-06
- [x] Phase 7: Macro Price Context (3/3 plans) — completed 2026-07-06
- [x] Phase 8: BRF Auto-Fetch (4/4 plans + gap-closure) — completed 2026-07-07
- [x] Phase 9: Discovery Foundation (4/4 plans) — completed 2026-07-07
- [x] Phase 10: Niche Ranking (2/2 plans) — completed 2026-07-07
- [x] Phase 11: Gallery Condition Vision (3/3 plans) — completed 2026-07-07
- [x] Phase 12: Floor-Plan & Sun-Path (4/4 plans) — completed 2026-07-07

Full phase details, goals, and success criteria: [milestones/v1.1-ROADMAP.md](milestones/v1.1-ROADMAP.md).
Deferred operator verification (legal go/no-go, live validation gates, UAT): [milestones/v1.1-MILESTONE-AUDIT.md](milestones/v1.1-MILESTONE-AUDIT.md) and phase `*-UAT.md` files.

</details>

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation + Core Pipeline | v1.0 | 3/3 | Complete | 2026-06-06 |
| 2. BRF Financial Analysis | v1.0 | 6/6 | Complete | 2026-06-16 |
| 3. Market Context | v1.0 | 6/6 | Complete | 2026-06-22 |
| 4. AI Report + Delivery | v1.0 | 6/6 | Complete | 2026-07-06 |
| 5. Owned Booli Acquisition | v1.1 | 5/5 | Complete | 2026-07-06 |
| 6. Deeper Listing Extraction | v1.1 | 3/3 | Complete | 2026-07-06 |
| 7. Macro Price Context | v1.1 | 3/3 | Complete | 2026-07-06 |
| 8. BRF Auto-Fetch | v1.1 | 4/4 | Complete | 2026-07-07 |
| 9. Discovery Foundation | v1.1 | 4/4 | Complete | 2026-07-07 |
| 10. Niche Ranking | v1.1 | 2/2 | Complete | 2026-07-07 |
| 11. Gallery Condition Vision | v1.1 | 3/3 | Complete | 2026-07-07 |
| 12. Floor-Plan & Sun-Path | v1.1 | 4/4 | Complete | 2026-07-07 |

## Backlog

Items captured for future planning. Promote via `/gsd-review-backlog` when ready. Four former backlog items (999.6, 999.2, 999.3, 999.7) were promoted into v1.1 Phases 5–12.

- **999.6 → promoted to Phase 5** (Owned Booli Acquisition)
- **999.2 → promoted to Phase 6** (Deeper Listing Extraction)
- **999.3 → promoted to Phase 7** (Macro Price Context)
- **999.7 → promoted to Phases 9–12** (Discovery Foundation, Niche Ranking, Gallery Condition Vision, Floor-Plan & Sun-Path)

### Phase 999.1: Proprietary price estimator (BACKLOG)

**Goal:** [Captured for future planning] Build a price estimator that beats Booli's "value based price." Booli's dropdown exposes which reference objects drive their estimate — ours would weigh historical data, trends, floor level, balcony, BRF debt, and more. Prior art: a friend's hand-built scraper + estimator outperformed Booli's during his own apartment search. Synergy: actor already returns Booli's `estimate` and `listSqmPrice` for benchmarking.

**Sun exposure tracking:** Track how the sun hits the apartment from the address (friend did this via a mix of sun-tracking websites — feasibility unconfirmed but probably doable). The actor already returns `latitude`/`longitude`, so sun-path computation (e.g. suncalc-style libraries or APIs) is a candidate beyond scraping websites. Standalone value even outside the estimator: a UI where the user sees a map preview (Google Maps) and can visually drag the sun's position through the day — possibly via iframe embed of an existing sun-tracking site (e.g. ShadeMap/SunCalc.org-style tools), or built natively. Sun exposure is also a plausible estimator feature (sunny balconies price higher). *(Note: theoretical sun-path landed in v1.1 Phase 12; this backlog item is the richer interactive/map-based version.)*
**Requirements:** EST-01 (Future). MACRO-01 (Phase 7) lays groundwork.

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)

### Phase 999.4: Advanced BRF risk analysis — beyond hard-coded rules (BACKLOG)

**Goal:** [Captured for future planning] Evolve the Phase 2 BRF score from purely deterministic threshold rules (D-08) into forward-looking *risk* analysis that anticipates future debt/avgift pressure and feeds it back into the grade as explicit, explained risk factors. Experimental — to be prototyped (likely Claude-assisted reasoning over the extracted financials + årsredovisning narrative, kept auditable). Each risk factor must surface as a visible flag with its reasoning, not a black-box score nudge (preserves the D-09/D-11 transparency contract).

**Candidate risk signals to explore:**

- **Maintenance-cycle prediction (renovation timing).** Major works recur on rough cycles — e.g. *stambyte* (pipe replacement) roughly every ~30–60 years, façade/*fasad* renovation, roof, windows. If the last stambyte was ~30 years ago, another is likely imminent → large future debt → downgrade + "Kommande stambyte trolig" risk flag. If the façade hasn't been touched in a long time, flag likely upcoming cost. **TODO: verify the real required/typical intervals per work type (regulatory + practical) before encoding thresholds.**
- **New-build inversion.** For a newly built BRF, high debt is *expected and usually fine* — they won't need major renovations for ~20–30 years. The same high-debt figure that's a red flag for an old building should be contextualized (or even neutral/positive) for a new one. The maintenance-cycle signal runs in reverse here.
- **Loan maturity + rate-curve exposure.** Extract the BRF's loan book — amounts, per-loan interest rates, and expiry/refinancing dates — and compare against the current/forward rate curve (Riksbank/market). A BRF forced to refinance a large loan into a higher-rate environment will likely raise avgift and/or grow debt over time → quantify and flag refinancing risk. (Overlaps and should be unified with **ADV-01** interest-rate stress test and **ADV-02** avgiftshöjning prediction in the v2 requirements — promote together.)

**FIRST STEP — investigate data availability (gates everything else).** Before any modelling, spike what's actually extractable across a sample of real årsredovisningar (and broker loan data sheets where available): is the loan book present (amounts, per-loan rates, expiry/refinancing dates)? Is renovation history present (last stambyte / fasadrenovering / inglasning, planned maintenance / underhållsplan)? Each risk signal below is only as good as the data feeding it, and availability is the main unknown — confirm feasibility per signal before committing to build.

**Design constraints:** keep the deterministic core as the auditable baseline; advanced signals layer on top as explained adjustments/flags. Any rule of thumb (e.g. stambyte interval) must cite a verifiable source. Degrade gracefully when a signal's data is absent (don't fabricate risk from missing data — surface "uppgift saknas" instead).
**Requirements:** ADV-01, ADV-02 (v2 Advanced Analysis) — likely promote/merge with them

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)

### Phase 999.5: Buyer due-diligence checklist (BACKLOG)

**Goal:** [Captured for future planning] A guided "have I checked everything critical?" checklist that orchestrates the whole product into a calm, step-by-step due-diligence flow. Most buyers don't *know* what they should check (BRF debt, loan maturity, upcoming stambyte, etc.) — the checklist removes that anxiety by making the unknowns explicit and tracking what's still missing. More a "how the product feels and works" layer than a new data source: it pulls from everything we already do and frames it as progress toward a complete picture.

**Shape (illustrative step order):**

1. Get the object data (paste Booli link → listing summary) — Phase 1.
2. Upload the BRF årsredovisning → financial overview + A–F score — Phase 2.
3. Provide the loan data sheets → loan book / maturity / rates (feeds 999.4 refinancing risk).
4. Provide / point to the document highlighting upcoming renovations + when the last major works were done (stambyte, fasadrenovering, inglasning av balkonger, tak, fönster) — feeds 999.4 maintenance-cycle prediction.
5. Market context (comparable prices, area stats) — Phase 3.
6. Final synthesized AI report + risk flags + PDF — Phase 4.

**Behavior:** each step shows done / pending / not-applicable, explains *why it matters* in plain Swedish, and ends with a "nothing critical missed" confidence summary. Gracefully handles steps the buyer can't complete (data unavailable) — shows them as known gaps rather than silently dropping them, so the buyer understands the limits of the analysis. Cross-cutting across Phases 1–4 + 999.4; best built once those data sources exist, as the connective UX tissue over them.
**Requirements:** DUE-01 (Future; cross-cutting; spans LSTG/BRF/PRICE/AREA/RPRT + 999.4)

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)

### Phase 999.8: Walkable 3D model from listing images (BACKLOG)

**Goal:** [Captured for future planning] Generate a 3D model of an apartment that the user can walk around inside, reconstructed from the images in the listing gallery.

**Feasibility:** verified — the user has seen someone build exactly this using existing libraries, so it's a known-possible, not a research bet.

**Related:** companion to 999.7 (both are image/vision-driven enrichment of a listing); consumes the same gallery images 999.7's condition/floor-plan analysis uses (now Phases 11–12).
**Requirements:** VIZ-01 (Future; 3D reconstruction from photos; interactive viewer)

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)
