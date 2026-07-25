# Phase 14: Holistic Analysis Brain - Context

**Gathered:** 2026-07-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Delivers **SPEC Phase A.3 + A.4** for every surfaced discovery candidate:
1. **No empty analysis (A.3 / ANL-01):** when all deep-pass image attributes are filtered out by the confidence/imageIndex gates (`vision.ts:340-366`), produce a holistic-data-only opportunity brief instead of `claims: []`. Every candidate leaves analysis with ≥1 actionable item (the Ringvägen 122 scenario).
2. **Holistic inputs (A.4 / ANL-02, ANL-03):** fold renovated-vs-unrenovated area comps (`computeAreaComps` → R_med/U_med) and a per-candidate BRF summary into the analysis, via the **re-resolved areaId** (no DB migration — rides in JSONB `results`).
3. **Confounder normalization (ANL-04):** normalize a low kr/m² against confounders (floor, elevator, balcony, micro-location, sub-area, tomträtt, BRF debt) **before** any condition/reno attribution, and never render UI implying "low kr/m² ⇒ renovation object".

A.1 (enrichment pre-rank flip) and A.2 (Haiku triage flip) are **already merged on `main`**. This phase wires holistic data into the analysis path — it does NOT build the ROI-aware `OpportunityBrief` prompt/schema (that is Phase 15 / A.5) or the numeric value-gap ranking (Phase 16 / B). NOT scope: new capabilities, DB migrations, drawing generation.

</domain>

<decisions>
## Implementation Decisions

### BRF depth & coverage (ANL-03)
- **D-14-01:** The BRF fetch (Allabrf: org-nr resolve → fetch → iXBRL→text → LLM extract — network-expensive, per-candidate) runs **only for a top-N subset by the already-merged `enrichmentPriority` prelim rank** (below-market + aged-stock). N is a bounded constant (planner's call, ~3–5). Comps (`computeAreaComps`) run for **all enriched candidates** — comps are per-area/shared and comparatively cheap. The A.1 prelim rank is available *before* comps, so no circular dependency.
- **D-14-02:** ANL-03's BRF summary = `skuldPerKvm` (debt/m²), `avgiftsniva` (avgift), `kassaflode` (cash-flow), `stambytePlanerat` (stambyte funding state) from the existing `brfExtractionSchema`, **plus `tomträtt` read from the listing's `tenureForm`** (already backfilled in `enrichCandidateImages`). **`soliditet` is DEFERRED** — it has no field today, is rarely cleanly extractable from iXBRL, and debt/m² already carries most of the balance-sheet signal. (See Deferred Ideas.)

### No-empty fallback brief (ANL-01)
- **D-14-03:** The holistic-data-only fallback brief contains **comps positioning (R_med/U_med) + hedonic confounders + BRF summary** (the latter only when that candidate is in the D-14-01 BRF top-N; candidates outside it get comps + hedonic). Maximizes the chance of a genuinely actionable item with no usable photos.
- **D-14-04:** The fallback is framed with an **explicit marker — "Baserat på områdesdata — ingen bildtolkning" — plus a downgraded confidence** on the brief. This is the mirror image of the existing **"från bildtolkning"** marker (which flags image-derived claims), so a data-only inference is never mistaken for an image-verified one.

### Confounder handling (ANL-04)
- **D-14-05:** **Best-effort, no new scraping this phase.** Use the confounders already backfilled (floor, balcony, orientation, `tenureForm`). Elevator (`hiss`) and micro-location/noise are NOT fetched — when unknown, treat as "cannot attribute to condition" and **downgrade confidence**, never silently assume. Rationale: protects Phase 13's in-window completion fix; micro-location/noise has no clean data source (fetching it would be scope creep → its own phase).
- **D-14-06:** The SPEC §2.6 **discount-attribution guard lands in Phase 14**: >25% below R_med → do NOT assume condition, cap condition-explained at 20%, route residual to hidden-defect penalty (BRF debt, bottenvåning, odd BOA, tomträtt); require ≥5 comps in 12mo or widen band + downgrade confidence; normalize kr/m² inclusive of förening debt/m². The **UI guard** ("never render låg kr/m² ⇒ reno") also lands in 14. The **numeric `valueGap()` ranking wiring stays in Phase 16** (B).

### Scope boundary & spend
- **D-14-07:** Phase 14's UI footprint is limited to the **data-only marker (D-14-04), confounder-safe framing (D-14-06), and the non-empty guarantee (D-14-03)**. The rich presentation (R_med/U_med positioning, avgift/debt cards, tiered cost/profit) is **Phase 15's `OpportunityBrief`**. Comps + BRF are threaded into the deep-pass payload and **persisted as additive-nullable fields in the JSONB `results` column** (the established `vision` pattern) for Phase 15 to render.
- **D-14-08:** Fold comps + BRF spend into the **existing in-memory `runningVisionSek` vs `CAP_VISION_SEK_MAX=10`** (hold the cap at 10). When the budget is exhausted, skip further comps/BRF and **degrade gracefully** to what's already available. **Comps are fetched once per AREA and reused across that area's candidates (amortized) — the cost model must NOT double-count comps per candidate**; only BRF is per-candidate.

### Claude's Discretion
- Exact N for the BRF top-N (D-14-01, ~3–5); the concrete mechanism for threading/re-resolving `areaId` into `runVisionForJob` (it currently receives only `supabase, jobId, results[]` — see Grounding Corrections); comps cache/TTL reuse strategy within a run; the precise shape of the additive-nullable holistic fields on the persisted candidate.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase spec / ruleset (READ FIRST)
- `.planning/research/2026-07-10-ANALYSIS-REDESIGN-SPEC.md` — the brain. §2.1 (pre-filter flip, A.1/A.2 done), §2.2 (holistic inputs: BRF + comps + hedonic), **§2.6 (value-gap formula + discount-attribution guard + the LOW kr/m² ≠ reno operator rule — drives D-14-06)**, §3 (output schema shape / slim discipline), §4 Phase A (implementation steps 3–4 = this phase; step 5 = Phase 15), §5 (constraints/caps), §6 (LOCKED operator decisions).
- `.planning/research/2026-07-10-what-makes-apartments-increase-in-price.md` §1–§8 — hedonic directions (floor, balcony, orientation, energy) behind the confounder normalization.
- `.planning/research/2026-07-10-ANALYSIS-REDESIGN-FOLLOWUPS.md` — supporting brief.
- `.planning/ROADMAP.md` (Phase 14 section) — goal + 4 success criteria.
- `.planning/REQUIREMENTS.md` — ANL-01, ANL-02, ANL-03, ANL-04.
- `RESUME.md` (P2 section) — narrative of the A.4 wiring. ⚠️ Two premises there are CORRECTED below (cost-gate location; tomträtt/soliditet availability) — trust this CONTEXT over RESUME on those.

### Code — wiring points (file:line current on `main`)
- `src/lib/discovery/job.ts` — `runVisionForJob` (:580, receives only `supabase, jobId, results[]`), `enrichCandidateImages` (:486, detail-fetch loop :498-553, backfills floor/constructionYear/orientation/balcony :513-520), `runSlice` areaId resolution (:148-155 via `splitAreaQuery` + `resolveArea`), `claimAndRunVisionForJob` (:650-661), `VISION_ENRICH_LIMIT=8` (:390).
- `src/lib/discovery/vision.ts` — D2(a) Haiku `worthDeepPass:false` → `claims:[]` (:285-296); D2(b) confidence/imageIndex filter → `claims:[]` (:340-366); cost gate `runningVisionSek + estimate > CAP_VISION_SEK_MAX` (:506); `runVisionPass` attaches `candidate.vision` (:457-538).
- `src/lib/discovery/area-comps.ts` — `computeAreaComps(comps: SoldComp[], filter: AreaCompsFilter): AreaComps` → `renovatedMedianPerSqm` (R_med), `unrenovatedMedianPerSqm` (U_med), `renovatedCapPerSqm` (75th pct), `sampleSize`, `confident`.
- `src/lib/discovery/flip-economics.ts` — `buyerSegment`, `RENO_COST_MATRIX`, `applyRot`, `taxLines`, `valueGap` (used in Phase 16, not here).
- `src/lib/booli/client.ts` — `fetchSoldComps(query: SoldSourceQuery): {data, rendersUsed}` (:924); `SoldSourceQuery = {lat,lng,booliId,breadcrumbs,tier,objectType?}` (:812-821); synthesize a single-crumb query with one `Breadcrumb.url` containing `areaIds=<id>` + a `PriceTier`.
- `src/lib/discovery/resolve-area.ts` — `resolveArea(name, supabase?)` (:203), cached via `area_cache` table (cache→seed→live probe); `AreaResolution = {areaId, source, label?}`.
- `src/lib/market/sold-schema.ts` — `SoldComp` (:63), `normalizeSoldOutput(raw): SoldComp[]` (:177).
- `src/lib/schemas/brf.ts` — `brfExtractionSchema` (:46-75): `skuldPerKvm`, `avgiftsniva`, `kassaflode`, `underhallsplanStatus`, `stambytePlanerat` (NO tomträtt, NO soliditet); `NormalizedBrf` (:106), `brfDataSchema` persisted (:162).
- `src/lib/brf-source/allabrf.ts` — Allabrf public-page fetch (SSRF-guarded) + `fetch-document.ts`, `org-nr-resolver.ts`, `ixbrl-to-text.ts`, `run-extraction.ts`; entry `src/actions/fetch-brf-auto.ts`. `src/lib/brf/score.ts` — `computeBrfGrade`.
- `src/lib/discovery/vision-schema.ts` — `visionResultSchema` (:146-167), `VisionResult.claims` (:127-137), `VISION_CONFIDENCE_THRESHOLD=0.6` (:175). **No `OpportunityBrief` type exists yet** (Phase 15 adds it).
- `src/lib/discovery/condition-score.ts` — `conditionScore(candidate)` (:36) reads `candidate.vision` directly (the separate vision read path).
- `src/components/discovery-results.tsx` — ranking (:112-116): primary = niche score desc (:113), tiebreaker only = `conditionScore` (:115).

### LOCKED separation (must not break — static-grep tested)
- `src/lib/discovery/niche-score.test.ts` (:281-329) — `VISION_MODULE_SPECIFIERS` forbids `niche-score.ts` / `report/flags.ts` from importing `vision-schema`, `vision`, `sun-path`, **`flip-economics`**, **`area-comps`**. Any new holistic-analysis module added this phase MUST be added to this grep list and stay out of niche-score/flags.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `computeAreaComps` (area-comps.ts) + `fetchSoldComps`/`normalizeSoldOutput` — the comps core is done + tested; A.4 wires them into `runVisionForJob`.
- `resolveArea` (resolve-area.ts) — cached; re-resolve the areaId cheaply at analysis time (the job already resolves it in `runSlice`, but `runVisionForJob` doesn't currently receive it).
- BRF extraction pipeline (`brf-source/allabrf.ts` + `run-extraction.ts`) already produces a `NormalizedBrf` — reuse per top-N candidate; add tomträtt from listing `tenureForm`.
- `enrichCandidateImages` already backfills floor/constructionYear/orientation/balcony — the confounder inputs for ANL-04 are largely present.
- The `candidate.vision` additive-nullable pattern is the template for persisting the holistic brief in JSONB `results`.

### Established Patterns
- Analysis reads go through the `condition-score.ts`-style separate path + "från bildtolkning" marker — NEVER through niche-score/flags (LOCKED, grep-tested).
- Slim single-nullable-leaf Zod schemas to avoid Anthropic strict-output 400s (memory `anthropic-structured-output-limits`) — relevant when Phase 15 adds `OpportunityBrief`, but any schema touched here follows it.
- Cost gating is in-memory `runningVisionSek` per run, checked in `runVisionPass`; new fetches fold into it (D-14-08).

### Integration Points
- `runVisionForJob` (job.ts) is the injection site: re-resolve areaId → `fetchSoldComps` (single-crumb `SoldSourceQuery`) → `normalizeSoldOutput` → `computeAreaComps` (per area, amortized) + BRF fetch (top-N) → inject into the deep-pass payload + persist additive-nullable fields on each candidate.
- `discovery-results.tsx` receives the new marker/framing (D-14-07) but NOT the rich brief UI (Phase 15).

### Grounding Corrections (verified against `main`, supersede RESUME.md)
1. **`runVisionForJob(supabase, jobId, results[])` receives NO areaId** — A.4 must thread it (via `claimAndRunVisionForJob`) or re-resolve it from the job's `areaQuery` using cached `resolveArea`.
2. **Cost gate is `runningVisionSek` vs `CAP_VISION_SEK_MAX` in `runVisionPass` (vision.ts:506)** — it is fully separate from the scrape `cost_sek_total`. `enrichCandidateImages` has NO cost gate (bounds only by `limit`).
3. **No `OpportunityBrief` type exists anywhere yet** — it is introduced in Phase 15. Phase 14 persists holistic data as additive-nullable candidate fields, not as an OpportunityBrief.
4. **BRF schema lacks `tomträtt` and `soliditet`** — tomträtt comes from the listing (`tenureForm`); soliditet is deferred.

</code_context>

<specifics>
## Specific Ideas

- Data-only fallback marker copy: **"Baserat på områdesdata — ingen bildtolkning"** (mirror of the existing "från bildtolkning").
- Acceptance anchor: the **Ringvägen 122 scenario** — a dated/original flat that previously produced `claims: []` must now surface with ≥1 actionable opportunity.
- Never render UI text implying "låg kr/m² ⇒ renoveringsobjekt" (operator principle, SPEC §2.6).

</specifics>

<deferred>
## Deferred Ideas

- **`soliditet` (BRF equity ratio) extraction** — no field today, rarely cleanly extractable from iXBRL; debt/m² carries most of the signal. Revisit if BRF fidelity proves insufficient (candidate for a later analysis-quality pass).
- **Elevator (`hiss`) + micro-location/noise fetching** — micro-location/noise needs a data source that doesn't exist (traffic/noise integration). Its own phase if pursued. Elevator backfill was considered but declined to keep Phase 14 free of new scraping (protects Phase 13's in-window fix).
- **Rich holistic UI (R_med/U_med positioning cards, avgift/debt cards, tiered cost/profit)** — Phase 15 (`OpportunityBrief`).
- **Numeric `valueGap()` wired into ranking + "från bildtolkning" ranking marker** — Phase 16 (B).

</deferred>

---

*Phase: 14-holistic-analysis-brain*
*Context gathered: 2026-07-25*
