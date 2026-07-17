# Requirements: Bostad AI — v1.2 Renovator-Grade Discovery Analysis

**Defined:** 2026-07-17
**Core Value:** Give Swedish home buyers an independent, data-driven analysis of any listing — the one thing their mäklare won't provide.
**Source:** `.planning/research/2026-07-10-ANALYSIS-REDESIGN-SPEC.md` (ruleset, Phase A/B/C, locked operator decisions §6).

> **Scope note:** The analysis *cores* are already built + merged on `main` (`flip-economics.ts`, `area-comps.ts`, pre-filter flip A.1, triage flip A.2). This milestone is the **wiring + integration + UX** work that makes them live. Requirements below cover only remaining work.

## v1.2 Requirements

### Discovery UX

- [ ] **DXUX-01**: A discovery job for a realistic multi-area query (e.g. 300+ listings + vision) completes and shows results without the user having to reload — the server-side run finishes within the client poll window (parallelize across areas / stream partial results / cap per-page render retries).
- [ ] **DXUX-02**: Every discovery job state renders a Swedish status label in the progress UI — no raw enum string leaks (fixes missing `vision_processing` label in `STATUS_LABELS`).

### Holistic Analysis (Phase A)

- [ ] **ANL-01**: Every surfaced candidate leaves analysis with ≥1 actionable opportunity — when deep-pass attributes are all filtered out, a holistic-data-only opportunity brief is produced instead of empty `claims: []`.
- [ ] **ANL-02**: Per-candidate analysis folds renovated-vs-unrenovated area comps (R_med / U_med from `computeAreaComps`) into the value case, using the re-resolved areaId (no DB migration; rides in JSONB `results`).
- [ ] **ANL-03**: Per-candidate analysis folds a BRF summary (avgift, debt/m², stambyte funding state, tomträtt, soliditet) into the value case for top candidates, respecting cost caps.
- [ ] **ANL-04**: A low kr/m² is normalized against confounders (floor, elevator, balcony, micro-location, sub-area, tomträtt, BRF debt) before any condition/reno attribution; the UI never renders text implying "low kr/m² ⇒ renovation object".

### Opportunity Brief (Phase A.5)

- [ ] **ROI-01**: Analysis produces a prioritized opportunity list — each item has cheap/mid/high cost band, expected uplift, confidence, and rationale; structural items retain the "kräver konstruktör / väggutredning" caveat.
- [ ] **ROI-02**: Recommendations and value framing are tailored to the derived buyer segment (etta vs par-2-3rok) — etta capped at MID ambition, luxury-kitchen recs penalized; par-2-3rok weighted toward extra room / open plan / scale-4 kitchen.
- [ ] **ROI-03**: Each opportunity shows profit **with and without tax** (flat 22% on vinst) plus static uppskov (interest-free) and same-year loss-offset notes; no per-session tax input.
- [ ] **ROI-04**: Bathroom refresh is scored on freshness/condition (not material tier), with a HIGH-RISK flag on microcement-over-våtmatta stating it is cosmetic ytskikt only and does not renew the tätskikt / våtrumsintyg.
- [ ] **ROI-05**: The brief includes interior-designer per-room specifics (named colors, named furniture moves) — never generic "inrett i nordisk stil". `OpportunityBrief` schema passes a live Anthropic strict-output smoke.

### Value-Gap Scoring (Phase B)

- [ ] **VGAP-01**: A value-gap headline metric is computed per candidate per the §2.6 formula (Resale_W capped at area 75th pct, Purchase_P with overbid bias, net uplift, HIGH/MED/LOW flag, confidence), including the >25%-below discount-attribution guard.
- [ ] **VGAP-02**: Value-gap re-orders discovery results as a ranking input, computed on the separate vision/analysis read path — `niche-score.ts` / `flags.ts` never import it (static-grep separation test extended to cover the value-gap module).
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

Which phases cover which requirements. Populated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| DXUX-01 | TBD | Pending |
| DXUX-02 | TBD | Pending |
| ANL-01 | TBD | Pending |
| ANL-02 | TBD | Pending |
| ANL-03 | TBD | Pending |
| ANL-04 | TBD | Pending |
| ROI-01 | TBD | Pending |
| ROI-02 | TBD | Pending |
| ROI-03 | TBD | Pending |
| ROI-04 | TBD | Pending |
| ROI-05 | TBD | Pending |
| VGAP-01 | TBD | Pending |
| VGAP-02 | TBD | Pending |
| VGAP-03 | TBD | Pending |
| DRAW-01 | TBD | Pending |

**Coverage:**
- v1.2 requirements: 15 total
- Mapped to phases: 0 (roadmap pending)
- Unmapped: 15 ⚠️ (resolved by roadmapper)

---
*Requirements defined: 2026-07-17*
*Last updated: 2026-07-17 after milestone v1.2 initiation*
