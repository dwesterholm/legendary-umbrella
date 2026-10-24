# Roadmap: Bostad AI

Bostad AI — an AI-powered property analysis tool for the Swedish market.

## Milestones

- ✅ **v1.0 MVP** — Phases 1–4 (shipped 2026-07-06) — [archive](milestones/v1.0-ROADMAP.md) · [audit](milestones/v1.0-MILESTONE-AUDIT.md)
- ✅ **v1.1 Owned Data Layer & Intelligent Discovery** — Phases 5–12 (shipped code-complete 2026-07-07) — [archive](milestones/v1.1-ROADMAP.md) · [audit](milestones/v1.1-MILESTONE-AUDIT.md)
  - Discovery surface (Phases 9–12) ships behind `DISCOVERY_ENABLED` (now ON; retained as kill switch) — legal go/no-go = GO (operator 2026-07-08).
- 🔨 **v1.2 Renovator-Grade Discovery Analysis** — Phases 13–17 (started 2026-07-17) — wiring the already-merged analysis cores (`flip-economics.ts`, `area-comps.ts`, pre-filter/triage flips) into a holistic, ROI-aware, buyer-tailored opportunity brief per candidate + fixing the poll-timeout UX. Spec: [`research/2026-07-10-ANALYSIS-REDESIGN-SPEC.md`](research/2026-07-10-ANALYSIS-REDESIGN-SPEC.md).

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

### 🔨 v1.2 Renovator-Grade Discovery Analysis (Phases 13–17) — IN PROGRESS

- [ ] **Phase 13: Discovery UX / Poll-Timeout Fix** — the live discovery flow finishes inside the client poll window (no forced reload) and every job state shows a Swedish status label.
- [x] **Phase 14: Holistic Analysis Brain** — fold re-resolved area comps (R_med/U_med) + per-candidate BRF into the value case; no candidate leaves analysis with empty `claims: []`; low kr/m² normalized against confounders before any reno attribution. (6 plans executed 2026-08-06, verification `gaps_found` 2/4 → gap-closure plans 14-07..14-10 executed 2026-08-08, re-verification `gaps_found` 3/4 → code-review fix pass closed the last ANL-04 defect by splitting `IMPLAUSIBLE_BRF_DEBT_PER_SQM` from the SPEC §2.2 alarm threshold; final verification 4/4 with the four live-operator items deferred to `14-UAT.md`) (completed 2026-08-10)
- [ ] **Phase 14.1: Personal Fit Score** (INSERTED 2026-10-12) — rank by estimated flip profit (resale from hedonic slutpris model − purchase − reno cost via vision), ~5 % taste bonus; Folkungagatan 61 5tr in the top quarter.
- [x] **Phase 14.2: Trustworthy Weekly Table** (INSERTED 2026-10-12, rescoped 2026-10-13) — local browser rung first, every candidate read, problem-listing vs reno separation, model decisions applied, seen-memory + weekly email. (completed 2026-10-13)
- [ ] **Phase 14.3: Sun & Orientation Spike** (INSERTED 2026-10-12) — infer facade bearing when unstated + obstructed sun hours from 3D building data; go/no-go.
- [ ] **Phase 15: ROI-Aware Opportunity Brief** (DEFERRED 2026-10-12 behind 14.1–14.3) — prioritized, buyer-segment-tailored opportunities with tiered cost/uplift, profit ±22% tax, freshness-based bathroom scoring, interior-designer specifics; `OpportunityBrief` schema passes a live Anthropic strict-output smoke.
- [ ] **Phase 16: Value-Gap Scoring & Ranking** (DEFERRED 2026-10-12) — §2.6 value-gap headline metric that re-orders results on the separate read path, with a "från bildtolkning" UI marker; separation static-grep test extended.
- [ ] **Phase 17: Proposed Planritning Generation** (DEFERRED 2026-10-12; nice-to-have) — image-gen proposed floor plan for HIGH value-gap candidates only, daylight/bearing caveats stamped, bounded by cost caps; source images analyze-only (GDPR).

## Phase Details

> v1.2 phases only. v1.0/v1.1 phase details live in their milestone archives (linked above). Numbering **continues** from v1.1's Phase 12 — no reset. Phases 1–12 are untouched.

### Phase 13: Discovery UX / Poll-Timeout Fix

**Goal**: The now-live discovery flow finishes within the user's patience window and every job state shows a human-readable Swedish label — no forced reload, no raw enum leak. (Independent, unblocks confidence in the live discovery surface; can go first.)
**Depends on**: Nothing new (the discovery surface is already live on `main`); independent of the analysis phases.
**Requirements**: DXUX-01, DXUX-02
**Success Criteria** (what must be TRUE):

  1. A realistic multi-area query (e.g. "1:a i Södermalm och Vasastan under 4 miljoner", 300+ listings + vision) reaches and displays results without the user reloading the page — the server-side run finishes inside the client poll window.
  2. While a job runs, every state (including vision processing) shows a Swedish status label in the progress UI — no raw enum string (e.g. `vision_processing`) ever appears on screen.
  3. A long run visibly progresses within the window (area work parallelized / partial results surfaced / per-page render retries capped) rather than appearing to hang until a manual refresh.

**Notes**: Respect `DISCOVERY_ENABLED` fail-closed + cost caps (`CAP_VISION_SEK_MAX=10`, `VISION_ENRICH_LIMIT=8`, `CAP_CANDIDATES_MAX=25`) — every run is real Apify + Anthropic spend. Client tick is the primary job driver; the sweep cron is only an orphan-resume net.
**Plans**: 5/5 plans executed

- [x] 13-01-PLAN.md — Parallelize area scrapes in runSlice + scoped area-page waitSecs override (DXUX-01 backend throughput; D-01/D-02/D-03)
- [x] 13-02-PLAN.md — Two-tier poll timeout (calm soft-notice, keep polling) + complete Swedish STATUS_LABELS (DXUX-01 client UX + DXUX-02; D-04/D-05/D-06/D-07)
- [x] 13-03-PLAN.md — Live-smoke checkpoint: large multi-area run completes in-window; calibrate timing constants (DXUX-01 phase gate)
- [x] 13-04-PLAN.md — Close live-smoke gaps: decouple status read from tick, incremental processed_count writes, bound vision detail-fetch render (DXUX-01 visible in-window progress)
- [x] 13-05-PLAN.md — Fix the "annonser analyserade" counter (analyzed/found = candidate_count denominator, monotonic numerator, N av N at done) + revert the 13-04 processed_count overwrite regression (DXUX-01 counter correctness; gap from the 13-03 re-smoke)

**UI hint**: yes

### Phase 14: Holistic Analysis Brain

**Goal**: Every surfaced candidate is analyzed against holistic context — renovated-vs-unrenovated area comps and its BRF's finances — always leaves analysis with ≥1 actionable opportunity, and never mistakes a low kr/m² for a renovation signal. (SPEC Phase A: A.3 no-empty fallback + A.4 comps/BRF wiring; A.1/A.2 flips already merged.)
**Depends on**: Analysis cores already merged on `main` (`area-comps.ts` `computeAreaComps`, `flip-economics.ts`, pre-filter flip A.1, Haiku triage flip A.2). Independent of Phase 13.
**Requirements**: ANL-01, ANL-02, ANL-03, ANL-04
**Success Criteria** (what must be TRUE):

  1. A dated/original flat that previously produced `claims: []` (the Ringvägen 122 scenario) now surfaces with ≥1 actionable opportunity — when no image attributes survive the confidence/imageIndex gates, a holistic-data-only brief is produced instead of an empty one.
  2. A candidate's value case folds in renovated-vs-unrenovated area comps (R_med / U_med from `computeAreaComps`), resolved via the re-resolved areaId — the analysis references how its kr/m² sits against renovated vs unrenovated sales nearby.
  3. For top candidates (within cost caps), the value case folds in the BRF summary — avgift, debt/m², stambyte funding state, tomträtt, soliditet.
  4. Where a listing's kr/m² is low, the analysis normalizes against confounders (floor, elevator, balcony, micro-location, sub-area, tomträtt, BRF debt) before any condition/reno attribution, and the UI never renders text implying "low kr/m² ⇒ renovation object".

**Notes**: No DB migration — `OpportunityBrief` + BRF summary ride in the existing JSONB `results` column; comps use the re-resolved `areaId` (cached `resolveArea`), not lat/lng. Broker/gallery/BRF source data is analyze-only, never persisted. Real Apify/Anthropic spend — fold comps + BRF fetches into the vision cost gate. **A.4 must land before Phase 16** (VGAP needs R_med/U_med from here).
**Plans**: 6 plans (4 waves) + 4 gap-closure plans (2 waves), from the `gaps_found` verification

Plans:

- [x] 14-01-PLAN.md — Register the 3 new analysis modules in the LOCKED separation grep + holistic-schema types/read-guards + the 4 additive-nullable candidate fields + `kommun` derivation (wave 1; ANL-01/02/03; D-14-09)
- [x] 14-02-PLAN.md — `confounder-guard.ts`: SPEC §2.6 discount-attribution guard (25%/20% cap, ≥5-comp gate, debt-inclusive kr/m², unknown-confounder posture) + `buildHolisticBrief` with the banned-reno-attribution guard (wave 2; ANL-01/ANL-04; D-14-05/06)
- [x] 14-03-PLAN.md — Genitive-tolerant `normalizeKommun` (makes `confidence: "high"` reachable) + `brf-lookup.ts` discovery-side orchestrator, `BRF_TOP_N=4`, never touches the `analyses` table (wave 2; ANL-03; D-14-09/12)
- [x] 14-04-PLAN.md — UI: data-only marker "Baserat på områdesdata — ingen bildtolkning" replacing the `visionRanButEmpty` dead end + the never-imply-reno render guard (wave 2; ANL-01/ANL-04; D-14-04/07)
- [x] 14-05-PLAN.md — `renderSek`/comps+BRF spend estimators, `runVisionPass` `initialSpentSek`, `resolveCompsForCandidates` amortized per-area comps fetch (wave 3; ANL-02; D-14-08/11)
- [x] 14-06-PLAN.md — Concurrent BRF top-N (`Promise.allSettled`) + the post-vision holistic-brief attachment across all four no-image-claims states (wave 4; ANL-01/ANL-03; D-14-01/10)

Gap closure (from 14-VERIFICATION.md `gaps_found` 2/4 — run with `/gsd-execute-phase 14 --gaps-only`):

- [x] 14-07-PLAN.md — Carry `scoreExtraction`'s per-field confidence onto `BrfSummary` + `brfFieldTrusted` fail-closed gate + charge billed-but-failed BRF extractions against the shared cap (gap wave 1; ANL-03/ANL-04; CR-02 part 1, CR-04)
- [x] 14-08-PLAN.md — Make the LOCKED structural-separation grep see multi-line named imports, with real-file positive controls (gap wave 1; ANL-04; WR-01)
- [x] 14-09-PLAN.md — Record the accepted `soliditet` deferral as a named override + reword REQUIREMENTS.md's ANL-03 to match what shipped (gap wave 1; ANL-03; D-14-02)
- [x] 14-10-PLAN.md — Gate the debt-inclusive discount math and BRF display on confidence, state avgift as kr/kvm och år with a derived kr/mån, map stambyte to prose and suppress `ej_nämnt` (gap wave 2; ANL-01/ANL-03/ANL-04; CR-01/CR-02/CR-03)

**UI hint**: yes

### Phase 14.4: Valuation Gaps, Layout & Livability (INSERTED 2026-10-13)

**Why (Daniel, 2026-10-13):** "Why not cover the gaps instead of slapping on a hardcoded ceiling of 20 %? All those things (high avgift, BRF debt etc.) should go into the valuation." And: the valuation ignores the photos entirely today — they only set the renovation cost and the sun/taste part. The floor plan + photos can give, with high confidence, where the balcony is, which rooms are on the street side, whether windows sit on one or two sides (korsdrag), and whether the bedroom faces a busy street. For Daniel korsdrag (not boiling in summer) and a bedroom he can keep open at night matter a lot, and buyers price them too (long-term resale).

**Goal, three parts in this order:**

1. **Valuation covers the gaps (replaces the 20 % credit cap).** Enrich the sold-price training set with avgift/kvm, BRF debt/kvm (Booli public BRF page, parser from 14.2), tenure/tomträtt and listing age via the free local rung (≈7 400 sales → ≈1 500 BRF pages; sold-detail pages only serve sales from Oct 2025 on, so tenure is partial — say so). Refit `data/hedonic-model.json` with those features; remove the 20 % credit cap; keep only a soft residual flag ("ovanligt långt under modellpris") for gaps no feature explains. Measure how much of the old `kredit-tak` gaps the new features explain, and how the top 15 moves.
2. **Layout & livability from floor plan + photos.** One extra cached vision call per flat (≈0,5 kr; slim strict schema; never the compass): balcony side relative to the plan, rooms on the balcony side (living/kitchen/bedroom), windows on one side or two opposite sides (korsdrag ja/nej), bedroom on street or courtyard side, street-vs-courtyard confirmed from the photos (cars, opposite facade). Combine with 14.3's footprint bearing (street side known) → room-level sun hours, the 0.5 street-only factor goes away where the layout is known, korsdrag and quiet-bedroom become explicit taste terms AND mail flags. Calibration row: Folkungagatan 61 (balcony + living + glass-walled bedroom on the south street side, no courtyard windows → sun yes, korsdrag no, bedroom on Folkungagatan).
3. **Condition-aware bidding.** The expected final price (asking × district premium) ignores that bidders see the same photos; let the picture-read condition adjust the premium (dated bids up less), fitted where the sold data allows, otherwise a documented prior.

**Requirements**: VAL-01, VAL-02, VAL-03, VAL-04, VAL-05, LAY-01, LAY-02, LAY-03, LAY-04, BID-01, BID-02
**Depends on:** 14.1 (model), 14.2 (local rung, BRF parser, vision lanes/cache), 14.3 (footprint bearing, sun hours)
**Plans:** 10/10 plans executed (sequential, waves 1-10)

Plans:
**Wave 1**

- [x] 14.4-01-PLAN.md — Freeze today's ranking (before the cap goes) + separation guard for the new modules (VAL-05, R-05)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 14.4-02-PLAN.md — Sold-detail enrichment v2 (avgift, BRF id, tenure, days on market, photo ids), stop rule, BRF pass; 1 200-row local run (VAL-01)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 14.4-03-PLAN.md — Avgift/kvm, BRF debt/kvm, tomträtt (zeroed) in the hedonic model, version 2, refit + R-06 decision (VAL-02)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 14.4-04-PLAN.md — Days on market in the bid premium, kept only by CV (VAL-03)

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 14.4-05-PLAN.md — Remove the 20 % credit cap; soft residual flag; reasons; Skillnad + Budpremie columns (VAL-04)

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 14.4-06-PLAN.md — Offline before/after report: capped rows, top 15, Folkungagatan 61 (VAL-05)

**Wave 7** *(blocked on Wave 6 completion)*

- [x] 14.4-07-PLAN.md — Separate layout read (schema, cache, caps), balcony side picks the sun facade, F61 fixture, live smoke (LAY-01, LAY-02, LAY-04)

**Wave 8** *(blocked on Wave 7 completion)*

- [x] 14.4-08-PLAN.md — Korsdrag + quiet bedroom taste and columns, live wiring, real run with coverage and by-eye check (LAY-03, LAY-04)

**Wave 9** *(blocked on Wave 8 completion)*

- [x] 14.4-09-PLAN.md — Condition index in the expected final price; sold-photo condition module; smoke and fit/prior branch (BID-02, BID-01)

**Wave 10** *(blocked on Wave 9 completion)*

- [x] 14.4-10-PLAN.md — Fit (or 0 prior) the condition term, final report and phase gate (BID-01, BID-02, VAL-05)

### Phase 14.5: Full Enrichment, Layout Accuracy, Ceiling Height (INSERTED 2026-10-17)

**Why (Daniel, 2026-10-17, answering the 14.4 UAT):** (1) "Enrich the other 4 500 sales first" — the balcony and 1961–1990 coefficients sit on the ±8 % fitting cap and decide Folkungagatan 61's rank; four times the data before touching the cap. (2) "Find the ceiling height according to your judgement" — rooms of 3–4 m are priced by buyers and matter to him; today it is nowhere in the model, the facts or the taste. (3) "No, fix the issue with the layout misreads, don't continue until it's at least > 75 % reliable" — the 14.4 layout read put Folkungagatan 61's balcony on the courtyard (truth: street) and got 2 of 3 "korsdrag ja" wrong by eye; its influence on the score is OFF (`LAYOUT_INFLUENCE_ENABLED = false`) until proven.

**Goal, three parts:**

1. **Full enrichment + refit (ENR-).** Enrich the remaining ≈ 4 300 sold rows in the 2025-10-20+ window and their new BRFs through the free local rung (started 2026-10-17 in the background: `.planning/calibration/data/enrich-14.5-full.log`); refit `data/hedonic-model.json` (version bump only if the shape changes); report every coefficient with SE before/after, the avgift–debt correlation, and whether balcony / 1961–1990 still sit on the ±8 % cap at n ≈ 5 500. If they do, widen the cap in one documented step (e.g. ±12 %) and report what moves, Folkungagatan 61 first. Measured, not tuned.
2. **Ceiling height (CEIL-).** Read stated ceiling height from broker text ("takhöjd 3,2 m" and variants) on for-sale detail pages (free, text already read for sun phrases) and on sold-detail pages if the probe shows they carry the description; store it as a fact (metres, source "angiven"); coverage measured and printed. If ≥ 300 sold rows carry it, fit it as a hedonic feature (null → mean, imputed) and report; otherwise, or in addition, a taste term inside the 5 % cap (e.g. +1 % at ≥ 3,0 m, +2 % at ≥ 3,5 m; unknown adds 0) and a "Takhöjd" column in table and mail. Build year stays the implicit proxy; no photo-based guessing of height into the valuation.
3. **Layout read accuracy (LAYACC-).** Build a hand-judged truth set of ≥ 25 flats (balcony side, window sides, bedroom side, street evidence) from floor plans + photos, stored as data only (never photos). Rework the read against it: model tier comparison (Sonnet vs Opus on the plan), explicit evidence rules (cars/street lamps/shopfronts = street; bicycle racks/lawns/own back facade = courtyard; artificial balcony grass is NOT courtyard greenery; the plan's entrance arrow is not a side), per-field confidence calibration; measure accuracy per field and set the gate from the measured curve. Exit: ≥ 75 % per-field accuracy on the truth set (balcony side, korsdrag, bedroom side), then and only then flip `LAYOUT_INFLUENCE_ENABLED` back on. Below 75 %: stays off, report why. Spend ≤ 40 kr per experiment round, 0 USD Apify.

**Requirements**: ENR-01, ENR-02, CEIL-01, CEIL-02, LAYACC-01, LAYACC-02, LAYACC-03
**Depends on:** 14.4 (enrichment path, model v2, layout modules, UAT items 1, 4, 5)
**Plans:** 9/13 plans executed

Plans:

**Wave 1** *(group A: runs while the enrichment writes; no frozen file touched)*

- [x] 14.5-01-PLAN.md — Ceiling height read from broker text into the facts and a Takhöjd table column; separation prefix registered first (CEIL-01, CEIL-02)
- [x] 14.5-02-PLAN.md — Layout accuracy measuring stick: truth format, per-field precision, curve, gate, Wilson, verdict; worklist and select-and-lock tools (LAYACC-01, LAYACC-02, LAYACC-03)
- [x] 14.5-03-PLAN.md — valuation-compare: 14.4 -> 14.5 report with coefficients, SE, cap flags and the R-01 cap rule, Folkungagatan 61 first (ENR-02)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 14.5-04-PLAN.md — Ceiling taste (+1 % / +2 % inside the 5 % cap), mail column, coverage line, no-change replay (CEIL-02, CEIL-01)
- [x] 14.5-05-PLAN.md — Layout variants a-d with true per-model prices, own caches, Opus call shape, two-step read; ledger fix (LAYACC-02)

**Wave 3** *(group B; blocked on Wave 2 completion)*

- [x] 14.5-06-PLAN.md — Judging procedure and blind truth rows 1-37, Folkungagatan 61 as row 1; picture downloads not before 2026-10-18 13:15 UTC (LAYACC-01)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 14.5-07-PLAN.md — Blind truth rows 38-end; select, split and lock before any paid call (LAYACC-01)

**Wave 5** *(blocked on Wave 4 completion)*

- [ ] 14.5-08-PLAN.md — Live schema smoke; paid rounds a (baseline) and b (evidence rules), each at most 40 kr (LAYACC-02)

**Wave 6** *(blocked on Wave 5 completion)*

- [ ] 14.5-09-PLAN.md — Opus smoke; rounds c (Opus) and d (two-step) under the stop rule; final layout decision (LAYACC-02)

**Wave 7** *(group C; the one R-07 restart, then its === END line gates the rest)*

- [x] 14.5-10-PLAN.md — R-07 restart (once, after 2026-10-18 13:15 UTC, concurrency 1, at least 2 s between pages) and run evidence; stage-2 cap as a parameter (±8 % / ±12 % only), stage-2 SE and CV, ceiling line (ENR-01, ENR-02, CEIL-02)

**Wave 8** *(blocked on Wave 7 completion)*

- [x] 14.5-11-PLAN.md — Refit on the full enriched set, one widening if needed, R-01 decision, model commit, 14.4 -> 14.5 comparison (ENR-02)

**Wave 9** *(blocked on Wave 8 completion)*

- [ ] 14.5-12-PLAN.md — Layout switch decision: on with the measured gate and read only if a variant passed, else off with the reason (LAYACC-03)

**Wave 10** *(blocked on Wave 9 completion)*

- [ ] 14.5-13-PLAN.md — First live run for ceiling coverage (0 kr), phase exit, plain-words summary for Daniel (CEIL-01, CEIL-02, all)

### Phase 14.6: Bygglov & Stambyte from the City's Case List, Uppmätning Flags (INSERTED 2026-10-18)

**Why (Daniel, 2026-10-18, from a discussion with a friend + research `.planning/research/2026-10-18-uppmatning-bygglov-stambyte.md`):** Stockholm's building-permit e-service (Bygg- och plantjänsten) lists every case per property without a login, back to 1929: balcony permits granted but not built add value; a stambyte must be reported to the city, so the same list gives a dated stambyte history per building — which can be joined to the 7 379 sold flats and MEASURED in the price model instead of the unsourced "−8–15 % before / +5–12 % after" folklore. Old flats are often under-measured (walls and wardrobes left out of pre-standard figures); the broker text states where the area figure comes from. Daniel on terms: "If there are no stated terms, it means they don't say we can't do it. So let's do it." — polite rate, no login-gated content, no email gate.

**Goal, in order:**

1. **City case-list fetcher (CASE-).** Resolve the fastighetsbeteckning from an address (the city's own search; the rental repo's Lantmäteriet route as fallback, read-only), fetch the case list per property, parse case type / description / dates / decisions (Bifall, slutbesked), classify: balcony permits (granted / built / pending, glazing), stambyte years (done, ongoing, planned), other value-relevant cases (hiss, vind, takterrass). Polite: ≤ 1 request/s, cached per property under `.planning/calibration/data/`, refreshed monthly; test on 10 known buildings incl. Folkungagatan 61's; coverage measured.
2. **Stambyte into the valuation (STAM-).** Join the dated history to the sold rows by address → `yearsSinceStambyte` / `stambyteWithin3y` features; fit with the honesty rule; keep only if CV improves; report the measured effect vs the folklore; either way an "stambyte planerat/pågående" reason line and a table/mail column with the year(s).
3. **Balcony-permit and uppmätning flags (FLAG-).** "Balkong beviljad, ej byggd" flag + mail column; area-source parsing from broker text (`uppmätt YYYY`, `ej uppmätt`, `enligt säljaren/ritning`) → `areaSourceKind`, `measuredYear`, a soft "troligen ej uppmätt" flag with the kr upside shown separately (≈ 100–115 kkr per kvm at this price level), never in the score; coverage measured on the first live run.
4. **Floor-plan under-measurement signals** — deferred until the layout read passes its 75 % gate (Phase 14.5).

**Requirements**: CASE-01, CASE-02, CASE-03, STAM-01, STAM-02, STAM-03, FLAG-01, FLAG-02
**Depends on:** 14.4 (model v2, reasons), 14.5 parts 1–2 (refit, text-parsing pattern for takhöjd)
**Plans:** 12/12 plans executed

Plans:
**Wave 1**

- [x] 14.6-01-PLAN.md — separation specifiers first; city page parsers and keyword tag set from the saved pages (CASE-02)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 14.6-02-PLAN.md — host gate, gated city client, caches (CASE-02)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 14.6-03-PLAN.md — address to fastighetsbeteckning: text, BRF-name guess, city search, Min Karta (CASE-01)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 14.6-04-PLAN.md — live 10-building spike + robots/substring/Min Karta probes; GO or STOP for the phase (CASE-03)

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 14.6-05-PLAN.md — one-off stambyte sweep per innerstan stadsdel since 1985 (STAM-01)

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 14.6-06-PLAN.md — sweep joined to the sold rows, join rate printed (STAM-01)

**Wave 7** *(blocked on Wave 6 completion)*

- [x] 14.6-07-PLAN.md — optional stambyteTerm, CV keep rule, fits to scratch, verdict beside the folklore (STAM-02)

**Wave 8** *(blocked on Wave 7 completion)*

- [x] 14.6-08-PLAN.md — broker-text readers: stambyte and area source; source precedence (STAM-03, FLAG-02)

**Wave 9** *(blocked on Wave 8 completion)*

- [x] 14.6-09-PLAN.md — new CandidateFacts, enrichment wiring, city stage live/cache-only (STAM-03, FLAG-01, FLAG-02, CASE-01)

**Wave 10** *(blocked on Wave 9 completion)*

- [x] 14.6-10-PLAN.md — Stambyte / Byggärenden / Area columns in table and mail, coverage lines, live wiring (STAM-03, FLAG-01, FLAG-02)
- [x] 14.6-11-PLAN.md — "stambyte pågår/planerat" reason and confounder entries (STAM-03)

**Wave 11** *(blocked on Wave 10 completion)*

- [x] 14.6-12-PLAN.md — today's candidates at the city, with/without comparison, model swap last, area audit deferred to next live run (STAM-02, STAM-03, FLAG-01, FLAG-02)

### Phase 15: ROI-Aware Opportunity Brief

**Goal**: Each analyzed candidate produces a prioritized, buyer-tailored opportunity brief — tiered cost/uplift, profit with and without tax, freshness-based bathroom scoring, and concrete interior-designer specifics — delivered through a slim schema that survives Anthropic strict-output. (SPEC Phase A.5.)
**Depends on**: Phase 14 (needs comps/BRF folded into the deep-pass payload so `valueGap` / `taxLines` / `buyerSegment` / `RENO_COST_MATRIX` can be code-attached to the brief).
**Requirements**: ROI-01, ROI-02, ROI-03, ROI-04, ROI-05
**Success Criteria** (what must be TRUE):

  1. A candidate shows a prioritized opportunity list — each item has a cheap/mid/high cost band, an expected uplift, a confidence, and a hedged plain-Swedish rationale; structural items keep the "kräver konstruktör / väggutredning" caveat.
  2. Recommendations are visibly tailored to the derived buyer segment — an etta never gets luxury-kitchen recs (capped at MID), while a 2–3:a is weighted toward an extra room / open plan / a scale-4 kitchen.
  3. Every opportunity shows profit both with and without tax (flat 22% on vinst) plus the static uppskov (interest-free) and same-year loss-offset notes — no per-session tax input required.
  4. A dated bathroom yields a cosmetic-refresh opportunity scored on freshness (not material tier), and any microcement-over-våtmatta suggestion carries the HIGH-RISK caveat that it is cosmetic ytskikt only and does not renew the tätskikt / våtrumsintyg.
  5. The brief includes concrete per-room interior-designer specifics (named colors, named furniture moves) — never generic "inrett i nordisk stil" — and the `OpportunityBrief` schema passes a **live** Anthropic strict-output smoke (no 400).

**Notes**: The model does the QUALITATIVE read only (opportunities, rationale, designer tips, architect note); `flip-economics.ts` + `area-comps.ts` compute all money deterministically in code and attach it — no hallucinated numbers. Keep the schema SLIM (single-nullable-leaf, numbers unconstrained) — mocked tests hide 400s, so the live smoke (`RUN_LLM_EVALS=1`, ~2 frozen fixtures) is mandatory; if it 400s, slim further before touching UI. No verdict, every claim cited/hedged.
**Plans**: TBD

### Phase 16: Value-Gap Scoring & Ranking

**Goal**: Each candidate carries a value-gap headline metric that re-orders discovery results — computed on the separate analysis read path and clearly marked "från bildtolkning" so buyers can tell interpreted signals from verified deterministic flags. (SPEC Phase B.)
**Depends on**: Phase 14 (R_med/U_med comps) and Phase 15 (the brief that carries the value-gap object). Primary blocker is Phase 14's A.4 comps.
**Requirements**: VGAP-01, VGAP-02, VGAP-03
**Success Criteria** (what must be TRUE):

  1. Each candidate shows a value-gap headline (net uplift + HIGH/MED/LOW flag + confidence) per the §2.6 formula — Resale_W capped at the area renovated 75th percentile, Purchase_P with overbid bias — including the >25%-below discount-attribution guard (condition-explained gap capped at 20%, residual routed to hidden-defect penalty).
  2. Discovery results are re-ordered by value-gap as a ranking input, and the static-grep separation test — **extended to cover the value-gap module** — stays green, proving `niche-score.ts` / `flags.ts` never import it.
  3. Analysis-derived signals (condition and value-gap) render with a "från bildtolkning" marker in the discovery results UI, visually distinct from the deterministic verified flags.

**Notes**: Value-gap is a ranking input **and** display (operator decision #1), computed on the separate vision/analysis read path (extend `condition-score.ts` or a sibling), NOT `computeNicheScore`. Structural separation is LOCKED + tested — extend `niche-score.test.ts` grep list. "Low kr/m² ≠ reno object" invariant from Phase 14 carries through the ranking. 2026-10-12: Phase 14.1 lifted the 'vision never re-orders' rule for the headless fit score only, through `fit-score.ts`; niche-score.ts/flags.ts stay pure.
**Plans**: TBD
**UI hint**: yes

### Phase 17: Proposed Planritning Generation

**Goal**: HIGH value-gap candidates get a generated proposed floor plan illustrating the suggested conversion, with daylight/bearing caveats stamped on it, bounded by cost caps — while source images stay analyze-only and are never persisted. (SPEC Phase C.)
**Depends on**: Phase 16 (the HIGH value-gap flag gates which candidates get a drawing).
**Requirements**: DRAW-01
**Success Criteria** (what must be TRUE):

  1. A candidate flagged HIGH value-gap shows a generated proposed planritning illustrating the suggested conversion; candidates without a HIGH flag show none (bounding image-gen spend).
  2. The generated drawing has daylight and bearing-wall caveats stamped on it — never asserting a wall's bärande status as fact.
  3. Drawing generation stays within the per-search cost caps, and broker/gallery source images used for analysis are never rendered or persisted — only generated drawings persist (GDPR).

**Notes**: Image-gen provider TBD at phase start (`nano-banana` skill / `higgsfield` / other). HIGH-only gate bounds spend. This is the one place persistence is allowed — generated drawings only, never source images.
**Plans**: TBD

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
| 13. Discovery UX / Poll-Timeout Fix | v1.2 | 5/5 | In Progress|  |
| 14. Holistic Analysis Brain | v1.2 | 10/10 | Complete    | 2026-08-10 |
| 15. ROI-Aware Opportunity Brief | v1.2 | 0/TBD | Not started | - |
| 16. Value-Gap Scoring & Ranking | v1.2 | 0/TBD | Not started | - |
| 17. Proposed Planritning Generation | v1.2 | 0/TBD | Not started | - |

## Backlog

Items captured for future planning. Promote via `/gsd-review-backlog` when ready. Four former backlog items (999.6, 999.2, 999.3, 999.7) were promoted into v1.1 Phases 5–12.

**First live discovery run, 2026-08-11 — ALL FIXED** (write-ups now in `.planning/todos/completed/`). The run completed and produced good results, but surfaced one cost-critical defect and a cluster of discovery-UX gaps. All six were fixed the same day:

- **`005` — P0, COST — FIXED** (`bcaee7b`). A query scoped to "innerstan (innanför tullarna)" silently returned listings from all over Sweden. Root cause was NOT a missing fail-fast (`runSlice` already fails when all areas miss) — resolution was *succeeding* with something far too wide: `pickBestSuggestion` fell back to ranking EVERY suggestion, where any tier that is not Stadsdel/Område/Gata scores 2, so a Kommun/Län suggestion outranked a street. Fixed with a specificity guard (a non-exact match may only resolve to a neighborhood tier; unknown tiers fail closed), umbrella-term expansion to constituent district names, parenthetical stripping, a `parse-intent` prompt that no longer licenses guessing, and a `startDiscovery` gate that refuses an empty area *before* the job row exists.
- **`006` — FIXED** (`5861eb7`). Bounded multi-select of areas, joined into the existing `areaQuery` string — no schema change, so none of the documented Anthropic strict-output risk. Scope is shown before spending.
- **`007` — FIXED** (`b3fd99d`). New `/discover/[jobId]/[candidateIndex]` detail page; cards link there by *original* index (not rank); the unattached insight list below the grid is gone.
- **`008` — FIXED** (`5261392`). Pipeline stepper alongside the existing counter axis. Supersedes 09-UI-SPEC.md line 132's "one axis, not discrete phases" at operator instruction.
- **`002` — FIXED** (`ccdcd90`). Two-card picker with equal billing plus a permanent "Sok omrade" nav entry. Note the discovery link *was* rendering — the defect was discoverability, not a missing link.
- **`003` — FIXED** (`7c18445`). Signup no longer claims success unconditionally, detects Supabase's already-registered anti-enumeration response, and sends `emailRedirectTo`.

**Still open:** `001` (keepalive write — the Supabase *restore* is done, the fix that stops it re-pausing is not) and `004` (the two dashboard checks that settle whether the signup mail was ever sent). Both need operator/dashboard access.

**Deferred deliberately:** moving the paste-a-link flow off `/dashboard` to a dedicated route, and incrementally-persisted per-candidate progress (which is what a true "analyzed 7/25" counter needs — the LOCKED 13-05 semantics keep `analyzed` at 0 until the terminal write). Both are better decided in a UI phase than bolted on.

**Open UX/auth defects captured 2026-08-11** (both P1, found while setting up the Phase 14 live smoke):

- **Feature picker / landing page** (`002`) — after login you land on the paste-a-Booli-link surface and **nothing in the UI links to `/discover`**; the operator had to paste the URL by hand. Every v1.1/v1.2 discovery investment is currently unreachable to a real user. Likely wants `/gsd-ui-phase` (navigation/IA decision, not a mechanical change) and should land before or alongside Phase 15, which otherwise adds more capability to an unreachable surface.
- **Signup confirmation silently fails** (`003`) — `signup/page.tsx` shows "Kolla din e-post" unconditionally without inspecting `signUp`'s response (Supabase returns success with `identities: []` for an already-registered email), and sends no `emailRedirectTo` despite `/auth/confirm` existing. Also needs custom SMTP; the built-in sender is rate-limited (~2/hr) and not production-grade.

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
