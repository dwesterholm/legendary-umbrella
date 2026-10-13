# Requirements: Bostad AI — v1.2 Renovator-Grade Discovery Analysis

**Defined:** 2026-07-17
**Core Value:** Give Swedish home buyers an independent, data-driven analysis of any listing — the one thing their mäklare won't provide.
**Source:** `.planning/research/2026-07-10-ANALYSIS-REDESIGN-SPEC.md` (ruleset, Phase A/B/C, locked operator decisions §6).

> **Scope note:** The analysis *cores* are already built + merged on `main` (`flip-economics.ts`, `area-comps.ts`, pre-filter flip A.1, triage flip A.2). This milestone is the **wiring + integration + UX** work that makes them live. Requirements below cover only remaining work.

## v1.2 Requirements

### Discovery UX

- [ ] **DXUX-01**: A discovery job for a realistic multi-area query (e.g. 300+ listings + vision) completes and shows results without the user having to reload — the server-side run finishes within the client poll window (parallelize across areas / stream partial results / cap per-page render retries).
- [x] **DXUX-02**: Every discovery job state renders a Swedish status label in the progress UI — no raw enum string leaks (fixes missing `vision_processing` label in `STATUS_LABELS`).

### Holistic Analysis (Phase A)

- [x] **ANL-01**: Every surfaced candidate leaves analysis with ≥1 actionable opportunity — when deep-pass attributes are all filtered out, a holistic-data-only opportunity brief is produced instead of empty `claims: []`.
- [x] **ANL-02**: Per-candidate analysis folds renovated-vs-unrenovated area comps (R_med / U_med from `computeAreaComps`) into the value case, using the re-resolved areaId (no DB migration; rides in JSONB `results`).
- [x] **ANL-03**: Per-candidate analysis folds a BRF summary (avgift, debt/m², stambyte funding state, tomträtt) into the value case for top candidates, respecting cost caps. (`soliditet` deferred, not dropped: no field exists on `brfExtractionSchema`, it is rarely cleanly extractable from iXBRL, and debt/m² carries most of the balance-sheet signal — 14-CONTEXT.md D-14-02; accepted by the developer, recorded as the `overrides` entry in 14-VERIFICATION.md. Revisit under a later analysis-quality pass if BRF fidelity proves insufficient.)
- [x] **ANL-04**: A low kr/m² is normalized against confounders (floor, elevator, balcony, micro-location, sub-area, tomträtt, BRF debt) before any condition/reno attribution; the UI never renders text implying "low kr/m² ⇒ renovation object".

### Personal Fit Score (Phase 14.1, inserted 2026-10-12)

- [x] **FIT-01**: A cached, sign-correct slutpris dataset (4 innerstan districts, ≥35 m², 12–18 months; floor, sold price, asking price, sold date, lat/lng) is pulled by a script through the existing Apify transport with bounded concurrency (≤8) and can be refit offline without re-scraping.
- [x] **FIT-02**: A hedonic ridge-stabilised OLS on log(kr/m²) is fitted from that dataset; coefficients, standard errors, R², cross-validated error and sign checks are reported in plain language, with a documented neutral fallback for any wrong-signed or unstable coefficient.
- [x] **FIT-03**: A pure `fit-score` module returns estimated flip profit in kr (resale − expected final purchase − reno cost) plus a taste bonus ≤5 % of resale and explicit flags (expected final > 4.0 M, ej bildtolkad, hidden-defect risk), reusing `valueGap()`; `niche-score.ts`/`flags.ts` stay import-banned and the separation test is amended, not removed.
- [x] **FIT-04**: Renovation cost is chosen deterministically from the vision condition verdict (fresh / ok / dated / unknown per kitchen, bathroom, overall) as severity bundles at the mid price band of `RENO_COST_MATRIX`; unknown = mid bundle and flagged.
- [ ] **FIT-05**: A headless script ranks an innerstan run: deterministic pre-rank of all filtered candidates, detail + vision on the top ~20 (`FIT_VISION_WINDOW`, in-app `VISION_ENRICH_LIMIT` unchanged), then a profit re-sort, printing the table (address, kvm, floor, asking, expected final, resale, reno, profit, taste, flags, Booli link) and the real Apify/Anthropic spend.
- [ ] **FIT-06**: Ordering is proven by fixture tests (D-15), an offline replay of a cached for-sale snapshot, and one live innerstan run whose Folkungagatan 61 (Booli 150148) rank is recorded with a per-component decomposition — measured, not tuned.

### Trustworthy Weekly Table (Phase 14.2, inserted 2026-10-12, rescoped 2026-10-13)

- [x] **WATCH-01**: A local headed-Chromium rung renders Booli search, sold-price and detail pages from this Mac through the SAME page functions and parsers as the Apify rung (parity test on fixtures), is the default renderer for the headless scripts, detects a Cloudflare challenge and never falls back to Apify unless `--allow-apify`; the spend ledger shows 0 USD for local pages and the Apify headroom check is skipped in local mode.
- [x] **WATCH-02**: The headless run reads Booli's own total count per district and pages until complete (cap 15 pages/district, flagged `ofullständig` if short), then fetches detail (+ broker page) for EVERY filtered candidate and runs vision on all of them (cached by Booli id, 3 parallel chunks, ≤ 60 SEK logged); a separate `CandidateFacts` record carries tenure, avgift, build year, balcony, floor, listing age, price history, bidding status, BRF name, orientation and sun phrases without widening `DiscoveryCandidate`.
- [x] **WATCH-03**: Every `kredit-tak` / `dold-defekt-risk` row carries a deterministic plain-Swedish "varför här" reason (tenure, nyproduktion, days on market, price cuts, avgift/kvm vs district median, BRF debt/kvm from Booli's public BRF page, bidding, rooms-per-kvm) or the explicit `oförklarat fynd` marker.
- [x] **WATCH-04**: The hedonic model is refitted without the size sign rule (committed `data/hedonic-model.json`, Swedish description updated), the uncapped gap is printed beside the credited one, and the table is split into "Förväntat under 4 M" and "Över 4 M förväntat" sections with Folkungagatan 61 still tracked.
- [x] **WATCH-05**: A seen-listing store (Booli id, last asking, first seen) under `.planning/calibration/data/watch-state.json` makes the weekly run idempotent per day; the HTML email (nodemailer, SMTP URL + recipient from env, never printed) lists only new or price-changed rows with the full column set, reason and Booli link, falls back to writing the HTML file when SMTP env is absent, and sends nothing on a quiet week; first mail = top 15 per section.
- [x] **WATCH-06**: A documented LaunchAgent plist under `scripts/launchd/` runs the weekly job Monday 07:00 under `caffeinate -i` with `~/.zshenv` sourced and logs to a file; installing it is a one-line documented command, not done by the phase.
- [x] **WATCH-07**: One real local run (0 USD Apify) produces the phase-exit evidence under the phase directory: coverage numbers (completeness per district, sun/condition/balcony known %), the two sections with reasons, the mail/HTML, and the tracked listing's decomposition — measured, not tuned.

### Sun & Orientation (Phase 14.3, inserted 2026-10-12, executed 2026-10-13)

- [ ] **SUN-01**: A pure module resolves a candidate's street facade and courtyard facade (raw bearing + 4-sector facade + confidence + source "fastighet/gata") from a cached one-off OpenStreetMap download (buildings with geometry incl. relations, named roads), by snapping lat/lng to the nearest building polygon and matching the address street name to the nearest same-named road; Folkungagatan 61 (Booli 150148) resolves to a south street facade.
- [ ] **SUN-02**: Orientation precedence is stated text > floor-plan compass (only if the ≤ 2 kr probe shows ≥ 10 % compasses; otherwise the route is recorded as dropped) > footprint; conflicting sources (> 90°) are marked `konflikt` with halved confidence; unknown stays `okänd` and scores 0.
- [ ] **SUN-03**: Obstructed sun hours per facade for 21 Mar / Jun / Sep / Dec (morning + midday window and full day) are computed by ray-checking suncalc positions against neighbouring footprints within 250 m (R-08 supersedes the 150 m first written here; 150 m remains the radius for the local-median height estimate), heights from `building:levels`/`height` (fallback levels×3+2 m, local-median + `höjd uppskattad` flag), reported as a low–nominal–high range (±3 m neighbour heights), for all candidates in < 5 s total.
- [ ] **SUN-04**: The taste bonus's sun part uses the inferred facade × confidence × (street-only factor 0.5) × obstruction factor (nominal obstructed / theoretical over the morning+midday window), cap unchanged at 3 % of resale; `taste.ts` stays pure; `niche-score.ts`/`flags.ts`/`candidate.ts` untouched.
- [ ] **SUN-05**: The weekly table and HTML mail gain "Sol" columns: facade (source, confidence), theoretical hours Mar/Jun/Dec, obstructed range; the coverage line gains `sol härledd k av N (p %)`; the Overpass cache is refreshed only when older than 31 days and never during the weekly run otherwise.
- [ ] **SUN-06**: One real local evidence run over the current candidates records coverage per source, D-03 vs D-04 agreement where both exist, the Folkungagatan 61 row (facade, hours range, taste change), and the ±1 h share per season from the research method; sun coverage ≥ 80 % closes the D-17 sun clause of 14.2.

### Opportunity Brief (Phase A.5)

- [ ] **ROI-01**: Analysis produces a prioritized opportunity list — each item has cheap/mid/high cost band, expected uplift, confidence, and rationale; structural items retain the "kräver konstruktör / väggutredning" caveat.
- [ ] **ROI-02**: Recommendations and value framing are tailored to the derived buyer segment (etta vs par-2-3rok) — etta capped at MID ambition, luxury-kitchen recs penalized; par-2-3rok weighted toward extra room / open plan / scale-4 kitchen.
- [ ] **ROI-03**: Each opportunity shows profit **with and without tax** (flat 22% on vinst) plus static uppskov (interest-free) and same-year loss-offset notes; no per-session tax input.
- [ ] **ROI-04**: Bathroom refresh is scored on freshness/condition (not material tier), with a HIGH-RISK flag on microcement-over-våtmatta stating it is cosmetic ytskikt only and does not renew the tätskikt / våtrumsintyg.
- [ ] **ROI-05**: The brief includes interior-designer per-room specifics (named colors, named furniture moves) — never generic "inrett i nordisk stil". `OpportunityBrief` schema passes a live Anthropic strict-output smoke.

### Value-Gap Scoring (Phase B)

- [ ] **VGAP-01**: A value-gap headline metric is computed per candidate per the §2.6 formula (Resale_W capped at area 75th pct, Purchase_P with overbid bias, net uplift, HIGH/MED/LOW flag, confidence), including the >25%-below discount-attribution guard.
- [ ] **VGAP-02**: Value-gap re-orders discovery results as a ranking input, computed on the separate vision/analysis read path — `niche-score.ts` / `flags.ts` never import it (static-grep separation test extended to cover the value-gap module). (Overlap: Phase 14.1 FIT-03 re-orders the headless fit-score ranking by a value-gap-like profit; VGAP-02 for the in-app results stays open.)
- [ ] **VGAP-03**: Analysis-derived signals (condition, value-gap) carry a "från bildtolkning" marker in the discovery results UI, visually distinct from deterministic flags.

### Proposed Drawing (Phase C)

- [ ] **DRAW-01**: For HIGH value-gap candidates only, a proposed planritning is generated (image-gen) with daylight/bearing caveats stamped on it, bounded by the per-search cost caps; broker/gallery source images remain analyze-only and are never persisted (GDPR).

## v2 Requirements (deferred)

### Advanced Analysis

- **VGAP-04**: Personalized loss / uppskov input UI (per-session tax scenario), beyond the static notes shipped in ROI-03.
- **ANL-05**: Elevator + micro-location noise signals as first-class extracted fields (currently the two confounder gaps noted in SPEC §2.6).

## Out of Scope

| Feature | Reason |
|---------|--------|
| DB migration for analysis output | Not needed — `OpportunityBrief` + BRF summary ride in the existing JSONB `results` column; comps use re-resolved areaId (SPEC finding 2026-07-10). |
| Re-doing the pre-filter / triage flips (A.1/A.2) | Already built, tested, and merged on `main`. |
| Persisting broker/gallery source images | GDPR — analyze-only; only generated drawings (Phase C) persist. |
| Removing the `DISCOVERY_ENABLED` flag | Retained as runtime kill switch (defence-in-depth). |
| Buy/sell verdict from the LLM | Product invariant — no verdict, every claim cited, deterministic flags stay in code. |
| Custom valuation ML model | Claude reasoning + deterministic math (`flip-economics.ts`) substitute; no ML infra. |

## Traceability

Which phases cover which requirements. Populated during roadmap creation (2026-07-17). Phase numbering **continues** from v1.1 (which ended at Phase 12) — v1.2 spans Phases 13–17.

| Requirement | Phase | Status |
|-------------|-------|--------|
| DXUX-01 | Phase 13 — Discovery UX / Poll-Timeout Fix | Pending |
| DXUX-02 | Phase 13 — Discovery UX / Poll-Timeout Fix | Complete |
| ANL-01 | Phase 14 — Holistic Analysis Brain | Complete |
| ANL-02 | Phase 14 — Holistic Analysis Brain | Complete |
| ANL-03 | Phase 14 — Holistic Analysis Brain | Complete |
| ANL-04 | Phase 14 — Holistic Analysis Brain | Complete |
| FIT-01 | Phase 14.1 — Personal Fit Score | Complete |
| FIT-02 | Phase 14.1 — Personal Fit Score | Complete |
| FIT-03 | Phase 14.1 — Personal Fit Score | Complete |
| FIT-04 | Phase 14.1 — Personal Fit Score | Complete |
| FIT-05 | Phase 14.1 — Personal Fit Score | Pending |
| FIT-06 | Phase 14.1 — Personal Fit Score | Pending |
| WATCH-01 | Phase 14.2 — Trustworthy Weekly Table | Complete |
| WATCH-02 | Phase 14.2 — Trustworthy Weekly Table | Complete |
| WATCH-03 | Phase 14.2 — Trustworthy Weekly Table | Complete |
| WATCH-04 | Phase 14.2 — Trustworthy Weekly Table | Complete |
| WATCH-05 | Phase 14.2 — Trustworthy Weekly Table | Complete |
| WATCH-06 | Phase 14.2 — Trustworthy Weekly Table | Complete |
| WATCH-07 | Phase 14.2 — Trustworthy Weekly Table | Complete |
| SUN-01 | Phase 14.3 — Sun & Orientation | Pending |
| SUN-02 | Phase 14.3 — Sun & Orientation | Pending |
| SUN-03 | Phase 14.3 — Sun & Orientation | Pending |
| SUN-04 | Phase 14.3 — Sun & Orientation | Pending |
| SUN-05 | Phase 14.3 — Sun & Orientation | Pending |
| SUN-06 | Phase 14.3 — Sun & Orientation | Pending |
| ROI-01 | Phase 15 — ROI-Aware Opportunity Brief | Pending |
| ROI-02 | Phase 15 — ROI-Aware Opportunity Brief | Pending |
| ROI-03 | Phase 15 — ROI-Aware Opportunity Brief | Pending |
| ROI-04 | Phase 15 — ROI-Aware Opportunity Brief | Pending |
| ROI-05 | Phase 15 — ROI-Aware Opportunity Brief | Pending |
| VGAP-01 | Phase 16 — Value-Gap Scoring & Ranking | Pending |
| VGAP-02 | Phase 16 — Value-Gap Scoring & Ranking | Pending |
| VGAP-03 | Phase 16 — Value-Gap Scoring & Ranking | Pending |
| DRAW-01 | Phase 17 — Proposed Planritning Generation | Pending |

**Coverage:**

- v1.2 requirements: 15 total
- Mapped to phases: 15 ✓ (every requirement maps to exactly one phase; no orphans, no duplicates)
- Unmapped: 0 ✓

---
*Requirements defined: 2026-07-17*
*Last updated: 2026-07-17 — traceability populated by roadmapper (Phases 13–17)*
