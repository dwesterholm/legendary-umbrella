# Phase 14: Holistic Analysis Brain - Research

**Researched:** 2026-08-05
**Domain:** Wiring holistic data (area sold-comps, BRF financials, hedonic confounders) into an existing Next.js/Supabase discovery-analysis pipeline; no new libraries, no DB migration — pure additive wiring across four already-shipped modules (`job.ts`, `vision.ts`, `area-comps.ts`, `flip-economics.ts`) plus one existing but structurally-incompatible pipeline (`brf-source/`/`run-extraction.ts`).
**Confidence:** MEDIUM — the comps-wiring mechanics (Q1/Q2/Q3) are HIGH confidence (verified directly against `main`'s source); the BRF-per-candidate mechanics (Q4) surface a genuine structural incompatibility that materially changes feasibility and is MEDIUM/LOW confidence pending an operator decision.

## Summary

Phase 14 is pure wiring, not new capability — but two of the four wiring points hide real traps. The comps path (ANL-02) is straightforward: `fetchSoldComps` only needs a synthesized single-crumb `SoldSourceQuery` (lat/lng/booliId are declared-but-unused by the function body), and — critically — **candidates already carry a per-candidate area-identifying string** (`areaLabel`, Booli's own `descriptiveAreaName`, e.g. "Södermalm") that resolves through the exact same cached `resolveArea()` the job already uses for its query-level area. This means comps attribution does **not** need job-level areaId threading through `runVisionForJob`'s signature at all — re-resolving per-candidate from `candidate.areaLabel` sidesteps the multi-area attribution problem entirely and is simpler than every alternative in the original research prompt.

The BRF path (ANL-03) is where the real finding lives: the existing BRF auto-fetch pipeline (`fetch-brf-auto.ts` → `runBrfExtraction`) is **hard-wired to the `analyses` table via `analysisId`** — it reads/writes `analyses` rows at half a dozen points and its org.nr resolver (`resolveOrgNr`) requires a `kommun` string for geographic corroboration that only exists on `analyses.listing_data.breadcrumbs`, a field `DiscoveryCandidate` structurally does not carry (it was deliberately excluded from the PII-safe allowlist). Reusing this pipeline for discovery means calling four lower-level pure/network functions directly (`searchAllabrfByName` → `resolveOrgNr` → `fetchAllabrfDocument` → `extractBrfFinancials` → `scoreExtraction`) and bypassing `runBrfExtraction`/`fetch-brf-auto.ts` entirely — and, without a kommun signal, `resolveOrgNr` will essentially **never** return `"high"` confidence for a discovery candidate, even for an unambiguous single-name match. This is a locked-decision-shaped gap CONTEXT.md does not resolve (see Open Questions) and materially affects how "safe" the D-14-01 BRF fetch is.

The A.3 no-empty-fallback (ANL-01) and confounder guard (ANL-04) are clean, additive code changes that slot into `vision.ts` and a new pure module respectively, with no conflict against the LOCKED separation grep as long as the new module's specifier is added to `niche-score.test.ts`'s list.

**Primary recommendation:** Re-resolve `areaId` PER CANDIDATE from `candidate.areaLabel` via cached `resolveArea()` inside `runVisionForJob` (no signature change needed for comps); fetch `SoldComp[]` once per distinct resolved areaId (amortized) and re-run `computeAreaComps` per candidate against that cached array; for BRF, call the four underlying pure/network functions directly (never `runBrfExtraction`) against a `enrichmentVisitOrder`-ranked top-N subset that also has a non-null `brfName`, and treat the missing-kommun-corroboration gap as an explicit operator decision before wiring the fetch live.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Area comps fetch + aggregation (R_med/U_med) | API/Backend (`job.ts`/`vision.ts`, server-only) | Database (Supabase `area_cache` read) | Real Apify spend + Claude-adjacent read path; must stay server-side, never client |
| Per-candidate areaId resolution | API/Backend (`resolve-area.ts`, cached) | Database (`area_cache` table) | Same cached resolver the job already uses; a pure server function |
| BRF summary fetch + extraction | API/Backend (`brf-source/*`, `brf/extract.ts`) | — | SSRF-guarded network fetch + one Claude (Haiku) call; must stay server, GDPR analyze-only |
| No-empty fallback brief construction | API/Backend (`vision.ts`) | — | Pure code, needs comps/BRF data already fetched server-side; never client |
| Confounder-normalization guard | API/Backend (new pure module, vision/analysis read path) | — | Deterministic math over already-fetched fields; no I/O |
| Data-only marker + confidence-downgrade rendering | Frontend (`discovery-results.tsx` / `gallery-condition-vision.tsx`) | — | Display-only; the underlying computation is entirely server-side |
| Cost-cap gating (comps+BRF spend) | API/Backend (`vision.ts`/`cost.ts`) | — | In-memory running total, must stay colocated with the existing `runningVisionSek` check |

## User Constraints (from CONTEXT.md)

<user_constraints>

### Locked Decisions

- **D-14-01:** BRF fetch (Allabrf: org-nr resolve → fetch → iXBRL→text → LLM extract — network-expensive, per-candidate) runs **only** for a top-N subset by the already-merged `enrichmentPriority` prelim rank (below-market + aged-stock). N is a bounded constant (planner's call, ~3–5). Comps (`computeAreaComps`) run for **all enriched candidates** — comps are per-area/shared and comparatively cheap. The A.1 prelim rank is available *before* comps, so no circular dependency.
- **D-14-02:** ANL-03's BRF summary = `skuldPerKvm` (debt/m²), `avgiftsniva` (avgift), `kassaflode` (cash-flow), `stambytePlanerat` (stambyte funding state) from the existing `brfExtractionSchema`, **plus `tomträtt` read from the listing's `tenureForm`** (already backfilled in `enrichCandidateImages`). **`soliditet` is DEFERRED** — no field today, rarely cleanly extractable from iXBRL, and debt/m² already carries most of the balance-sheet signal.
- **D-14-03:** The holistic-data-only fallback brief contains **comps positioning (R_med/U_med) + hedonic confounders + BRF summary** (the latter only when that candidate is in the D-14-01 BRF top-N; candidates outside it get comps + hedonic).
- **D-14-04:** The fallback is framed with an **explicit marker — "Baserat på områdesdata — ingen bildtolkning" — plus a downgraded confidence** on the brief. Mirror image of the existing "från bildtolkning" marker.
- **D-14-05:** **Best-effort, no new scraping this phase.** Use confounders already backfilled (floor, balcony, orientation, `tenureForm`). Elevator (`hiss`) and micro-location/noise are NOT fetched — when unknown, treat as "cannot attribute to condition" and **downgrade confidence**, never silently assume.
- **D-14-06:** The SPEC §2.6 **discount-attribution guard lands in Phase 14**: >25% below R_med → do NOT assume condition, cap condition-explained at 20%, route residual to hidden-defect penalty (BRF debt, bottenvåning, odd BOA, tomträtt); require ≥5 comps in 12mo or widen band + downgrade confidence; normalize kr/m² inclusive of förening debt/m². The **UI guard** ("never render låg kr/m² ⇒ reno") also lands in 14. The **numeric `valueGap()` ranking wiring stays in Phase 16**.
- **D-14-07:** Phase 14's UI footprint is limited to the **data-only marker (D-14-04), confounder-safe framing (D-14-06), and the non-empty guarantee (D-14-03)**. The rich presentation (R_med/U_med positioning, avgift/debt cards, tiered cost/profit) is **Phase 15's `OpportunityBrief`**. Comps + BRF are threaded into the deep-pass payload and **persisted as additive-nullable fields in the JSONB `results` column** for Phase 15 to render.
- **D-14-08:** Fold comps + BRF spend into the **existing in-memory `runningVisionSek` vs `CAP_VISION_SEK_MAX=10`** (hold the cap at 10). When the budget is exhausted, skip further comps/BRF and **degrade gracefully**. **Comps are fetched once per AREA and reused across that area's candidates (amortized) — the cost model must NOT double-count comps per candidate**; only BRF is per-candidate.

### Claude's Discretion

- Exact N for the BRF top-N (D-14-01, ~3–5).
- The concrete mechanism for threading/re-resolving `areaId` into `runVisionForJob` (Grounding Corrections apply — see below).
- Comps cache/TTL reuse strategy within a run.
- The precise shape of the additive-nullable holistic fields on the persisted candidate.

### Deferred Ideas (OUT OF SCOPE)

- **`soliditet` (BRF equity ratio) extraction** — no field today, rarely cleanly extractable from iXBRL.
- **Elevator (`hiss`) + micro-location/noise fetching** — no data source exists; own phase if pursued.
- **Rich holistic UI** (R_med/U_med positioning cards, avgift/debt cards, tiered cost/profit) — Phase 15.
- **Numeric `valueGap()` wired into ranking** + "från bildtolkning" ranking marker — Phase 16.

### Grounding Corrections (verified against `main`, supersede RESUME.md — re-confirmed this session)

1. `runVisionForJob(supabase, jobId, results[])` receives NO areaId — **confirmed**; see Q1 below for the recommended fix (which does not require threading a job-level areaId at all).
2. Cost gate is `runningVisionSek` vs `CAP_VISION_SEK_MAX` in `runVisionPass` (`vision.ts:506`) — **confirmed**, fully separate from `cost_sek_total`.
3. No `OpportunityBrief` type exists anywhere yet — **confirmed**.
4. BRF schema lacks `tomträtt`/`soliditet` fields — **confirmed** (`src/lib/schemas/brf.ts:46-75`); tomträtt must come from `DiscoveryCandidate.tenureForm`, but see Open Question OQ-5 on whether `tenureForm` actually surfaces a `"Tomträtt"` value in practice (unverified this session — no fixture shows it).

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ANL-01 | Every surfaced candidate leaves analysis with ≥1 actionable opportunity — holistic-data-only brief when `claims: []` | Q5 below: exact insertion point in `vision.ts`, new additive-nullable `holisticBrief` field shape, condition-score.ts/schema-safety analysis |
| ANL-02 | Per-candidate value case folds R_med/U_med comps via re-resolved areaId, no migration | Q1+Q2 below: per-candidate `areaLabel` → cached `resolveArea` → synthesized `SoldSourceQuery` → `fetchSoldComps` → `normalizeSoldOutput` → `computeAreaComps` (amortized per area) |
| ANL-03 | Per-candidate BRF summary (avgift, debt/m², stambyte, tomträtt, soliditet) for top candidates within cost caps | Q4 below: structural incompatibility of `runBrfExtraction`/`fetch-brf-auto.ts` with discovery candidates; recommended direct-function-call path; kommun-corroboration gap flagged as Open Question |
| ANL-04 | Low kr/m² normalized against confounders before condition/reno attribution; UI never implies "low kr/m² ⇒ reno" | Q6 below: confirmed confounder inputs present on `DiscoveryCandidate` post-enrichment, recommended new pure module + §2.6 rule encoding, UI guard scope |

</phase_requirements>

## Standard Stack

No new external packages are required for this phase — every wiring point reuses libraries already installed and in production use on `main`: `zod` (v4, read-path guards), `@anthropic-ai/sdk` (the existing Haiku extraction call), `cheerio`/`undici` (the existing Allabrf fetch), and the project's own `booli/client.ts` transport. This phase is 100% internal wiring across already-shipped modules.

### Core (already installed, reused unchanged)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | v4 (project convention: `zod/v4` import) | Additive-nullable read-path guards for the new persisted fields | Matches every existing `discoveryCandidateSchema` field |
| @anthropic-ai/sdk | already pinned | Haiku call inside `extractBrfFinancials` (BRF) — reused, not re-invoked differently | Same client/model already used by `run-extraction.ts` |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Direct calls to `searchAllabrfByName`/`resolveOrgNr`/`fetchAllabrfDocument`/`extractBrfFinancials`/`scoreExtraction` | Reusing `runBrfExtraction`/`fetch-brf-auto.ts` as-is | Rejected — see Q4: those functions unconditionally read/write the `analyses` table by `analysisId`, which does not exist for a discovery candidate; calling them would require fabricating a fake `analyses` row, which is far worse than calling the four underlying functions directly |
| Per-candidate `resolveArea(candidate.areaLabel)` | Threading job-level `areaId[]` through `runVisionForJob`'s signature | Rejected as the primary mechanism (see Q1) — job-level areaIds don't solve multi-area attribution; per-candidate resolution does, at near-zero extra cost (cache-warm in nearly all cases) |

**Installation:** none — no `npm install` needed this phase.

## Package Legitimacy Audit

**Not applicable this phase.** No new external packages are introduced — every function this phase calls (`resolveArea`, `fetchSoldComps`, `normalizeSoldOutput`, `computeAreaComps`, `searchAllabrfByName`, `fetchAllabrfDocument`, `extractBrfFinancials`, `scoreExtraction`) already exists in the codebase and ships in the current `main` dependency tree. The Package Legitimacy Gate protocol is skipped; there is nothing to audit.

## Architecture Patterns

### System Architecture Diagram

```
                     runVisionForJob(supabase, jobId, results[])
                                    │
                                    ▼
                     enrichCandidateImages(results, VISION_ENRICH_LIMIT)
                     (unchanged — detail-fetch + broker-gallery loop)
                                    │
                                    ▼
                        enriched: DiscoveryCandidate[]
                                    │
              ┌─────────────────────┼─────────────────────────┐
              ▼                     ▼                         ▼
   [NEW] per-candidate      [NEW] BRF top-N select    (existing) runVisionPass
   areaId resolution        via enrichmentVisitOrder   (Haiku triage → Sonnet
   candidate.areaLabel      + non-null brfName filter   deep pass, per candidate)
     → resolveArea(cache)     .slice(0, BRF_TOP_N)
              │                     │                         │
              ▼                     ▼                         │
   [NEW] group candidates   [NEW] per top-N candidate:         │
   by resolved areaId       searchAllabrfByName(brfName)       │
              │              → resolveOrgNr(kommun:null)       │
              ▼              → fetchAllabrfDocument(orgNr)     │
   [NEW] fetchSoldComps      → extractBrfFinancials (Haiku)    │
   ONCE per distinct areaId  → scoreExtraction (pure)          │
   (single-crumb query)              │                         │
              │                     ▼                         │
              ▼              BrfSummary | null                │
   normalizeSoldOutput        (per candidate index)            │
   → SoldComp[] cached                │                         │
   per areaId                        │                         │
              │                     │                         │
              ▼                     │                         │
   [NEW] computeAreaComps    │                         │
   PER CANDIDATE (rooms/     │                         │
   livingArea/asOf filter    │                         │
   against the shared        │                         │
   per-area SoldComp[])      │                         │
              │                     │                         │
              └──────────┬──────────┴─────────────┬───────────┘
                         ▼                         ▼
              [NEW] cost-gate check:       withVision: DiscoveryCandidate[]
              running comps+BRF SEK        (vision.ts: claims possibly [])
              vs CAP_VISION_SEK_MAX,               │
              shared with vision spend             ▼
                         │              [NEW] vision.ts branch: when
                         │              claims.length === 0 AND (comps
                         └─────────────▶│ or BRF data available) →
                                         attach holisticBrief (ANL-01)
                                                    │
                                                    ▼
                                     updateJob({ results: withVision,
                                                 status: "done" })
                                                    │
                                                    ▼
                              discovery-results.tsx / gallery-condition-
                              vision.tsx render the "Baserat på områdesdata
                              — ingen bildtolkning" marker (D-14-04) and
                              never render "låg kr/m² ⇒ reno" (D-14-06)
```

### Q1 — Threading areaId into the vision path: recommendation

**Do NOT widen `runVisionForJob`'s signature to accept job-level areaIds.** Instead, re-resolve per candidate.

**Why job-level threading doesn't solve attribution:** a multi-area job (`splitAreaQuery` → up to `MAX_AREAS_PER_SEARCH=4` areaIds) merges all areas' candidates into one `results` array with **no per-candidate area tag** — `DiscoveryCandidate` (verified `candidate.ts:111-149`) has no `areaId` field. Threading `areaIds: string[]` down to `runVisionForJob` would tell you WHICH areas were searched, but not WHICH area a given candidate came from — you'd need a second cross-reference mechanism (e.g., re-running `fetchAreaListings` per area again just to build a URL→areaId map, which duplicates a real Apify render for no reason).

**What actually solves it — verified `candidate.ts:200`:** `toCandidate` already populates `areaLabel: str(raw.descriptiveAreaName)` from Booli's own per-listing field (fixture-confirmed value: `"Södermalm"` — a clean single stadsdel name, `booli/__fixtures__/listing-detail.json:117`). This is **exactly the same shape** `resolveArea(name, supabase)` already resolves for job-level `areaQuery` strings (`resolve-area.ts`), cached via the SAME `area_cache` table (migration 012). So: for each vision-enriched candidate, call `resolveArea(candidate.areaLabel, supabase)` directly. This requires **zero signature change to `runVisionForJob`** (it already has `supabase` in scope) — only new code INSIDE it, right after `enrichCandidateImages`.

**Cost/latency implication:** each distinct `areaLabel` value among the ≤8 enriched candidates triggers at most one `resolveArea` call; most will hit the DB cache (already warmed by the job's own `runSlice` area resolution, which resolves the SAME or a wider/narrower name) or the static seed list — a cache/seed hit is free (no Apify render). Only a genuine cache+seed miss falls through to the live probe (1 real Apify render, `runPlaywrightRender`) — this must be folded into the D-14-08 cost gate (see Q3). Group candidates by resolved `areaId` (not by `areaLabel` string — two labels can resolve to the same id) before calling `fetchSoldComps`, so a job whose candidates span 2 sub-areas but resolve to 1 shared areaId only fetches comps once.

**Blast radius:** zero changes to `runVisionForJob`'s public signature, zero changes to `claimAndRunVisionForJob`, `tickDiscovery`, or `sweep/route.ts` call sites. Existing tests for those call sites are unaffected. All new logic is internal to `runVisionForJob`'s body (or a new helper it calls).

### Q2 — Comps fetch shape + amortization

**Synthesizing a `SoldSourceQuery` from a bare areaId** (verified `booli/client.ts:812-821, 846-874, 924-962`):

```typescript
// SoldSourceQuery = { lat, lng, booliId, breadcrumbs, tier, objectType? }
// fetchSoldComps's body ONLY calls resolveAreaId(query) and
// buildSlutpriserUrl(areaId, query.objectType) — lat/lng/booliId are
// declared on the interface but NEVER read inside fetchSoldComps itself.
const query: SoldSourceQuery = {
  lat: 0,          // unused by fetchSoldComps; satisfies the type only
  lng: 0,          // unused by fetchSoldComps; satisfies the type only
  booliId: null,   // unused by fetchSoldComps; satisfies the type only
  breadcrumbs: [{ url: `https://www.booli.se/x?areaIds=${areaId}` }],
  tier: "building", // any tier works: resolveAreaId's switch clamps to
                     // ids[0]/ids[last]/ids[max(0,last-1)] — with exactly
                     // ONE id in the array, every branch resolves to ids[0].
  objectType: filters.objectType ?? null,
};
const { data, rendersUsed } = await fetchSoldComps(query);
const comps = normalizeSoldOutput(data); // SoldComp[]
```

This is a genuine, verified reading of the function body (not an assumption) — `resolveAreaId` (`client.ts:846-874`) extracts ids by regex from `breadcrumb.url` and picks by tier/position; with a single-element breadcrumbs array every tier branch degenerates to `ids[0]`.

**Caching structure — confirms the research prompt's framing exactly:** fetch the raw `SoldComp[]` ONCE per distinct resolved areaId (`fetchSoldComps` + `normalizeSoldOutput`, real Apify spend, 1-2 renders per `fetchSoldComps`'s own fallback-tree rungs), keep it in an in-memory `Map<areaId, SoldComp[]>` for the duration of `runVisionForJob`, then call the PURE `computeAreaComps(compsForThisArea, filter)` per candidate with that candidate's own `{ rooms, livingArea, asOf: today, objectType }` filter. `computeAreaComps` is cheap (pure array math, no I/O) — running it once per candidate against a shared array is free; only the `fetchSoldComps` call itself carries real cost, and D-14-08 explicitly requires that call to happen exactly once per area, never once per candidate.

### Q3 — Cost accounting for comps + BRF (D-14-08)

**Render→SEK conversion** already exists (`discovery/cost.ts:8,33-38`): `USD_PER_RENDER = 0.0055`, `USD_SEK_RATE = 11` (from `brf/cost.ts:34`). The exact same arithmetic `discoveryCostSek` already inlines (`renders * USD_PER_RENDER * USD_SEK_RATE`) should be factored into a small exported helper (e.g. `renderSek(renders: number): number`) so the new comps-cost accounting doesn't duplicate the formula. `fetchSoldComps` returns `rendersUsed` (1-2, from its own own-render fallback-tree rungs) — convert via this helper.

**BRF spend** is a single Haiku call inside `extractBrfFinancials` (`brf/extract.ts:22`, same `claude-haiku-4-5-20251001` model `vision.ts` already uses for its pre-filter) — its cost is `costSek(usage)` from `brf/cost.ts`, the exact function `run-extraction.ts` already calls (observed ~0.71 SEK per real call per that file's own comment). The two Allabrf network fetches (`searchAllabrfByName`, `fetchAllabrfDocument`) are plain `undici` fetches through the SSRF guard — **not** Apify renders, so they carry zero SEK cost, only latency.

**Where the check goes:** `runVisionPass`'s existing `runningVisionSek` variable is function-scoped and never returned — it currently only tracks vision spend across ONE call. To share the SAME budget pool across comps + BRF + vision:

1. Compute comps/BRF spend FIRST, inside `runVisionForJob`, before calling `runVisionPass` — because A.3's fallback brief needs comps/BRF data available at the moment vision's `claims: []` branch is evaluated, and because comps/BRF are cheap relative to Sonnet deep-pass calls (front-load the cheap, structurally-necessary spend; let vision degrade first under budget pressure, matching the existing philosophy that a job hitting the vision cap "just stops running vision" rather than losing everything).
2. Track a local `spentSek` accumulator across the areaId-grouped comps fetches (increment via the resolveArea-probe-render helper too — a live probe render is real spend) and the BRF top-N loop (increment via `costSek(usage)` per successful extraction) — check `spentSek + estimate > CAP_VISION_SEK_MAX` BEFORE each fetch/call, mirroring `runVisionPass`'s own check-before-spend discipline (never checked only after).
3. Add a new, additive `initialSpentSek: number = 0` parameter to `runVisionPass` (or an equivalent widening) so its own `runningVisionSek` starts from the comps/BRF total already spent, rather than resetting to 0 — this is the minimal-blast-radius way to share one pool across three spend sources without restructuring `runVisionPass`'s existing, already-tested loop.
4. On budget exhaustion mid-comps/BRF: stop fetching further comps/BRF for remaining candidates/areas (D-14-08 "degrade gracefully") — candidates that already got comps/BRF keep it; later ones get `null` for the un-fetched piece, still get vision (budget permitting) or the A.3 fallback with whatever holistic data IS available (even none, per the SPEC's ANL-01 requirement that ANY candidate — image-cited or not — must leave with ≥1 actionable item; if literally nothing is available for a candidate this phase's own guard rules must still degrade to an honest "insufficient data" state, never a fabricated claim).

**Expected side effect to flag for the planner/verifier:** because comps+BRF now share the SAME 10 SEK ceiling vision alone used to have, large candidate sets will see the vision pass hit `cost_cap` MORE often than pre-Phase-14 (less budget left for Sonnet calls). This is a direct, intended consequence of D-14-08 ("hold the cap at 10") — not a bug, but a behavior change worth a test assertion and a note in the phase's SUMMARY.

### Q5 — A.3 no-empty fallback insertion point

Both `claims: []` paths converge inside `runVisionForCandidate` (`vision.ts`):
- Haiku `worthDeepPass: false` → returns `{ claims: [], imageUrlsUsed: capped, model: HAIKU_MODEL, ... }` (`vision.ts:285-296`).
- Sonnet deep-pass confidence/imageIndex filter → `claims` computed via `.filter(...)` can legitimately end up `[]` (`vision.ts:332-366`).

**Recommended shape — do NOT touch `VisionResult.claims` or `visionResultSchema`.** Keep `claims: []` exactly as today (this preserves `condition-score.ts`'s existing `if (!vision || vision.claims.length === 0) return 0;` behavior unchanged — a holistic-data-only brief correctly contributes ZERO vision-derived condition signal, since it has no image claims to score). Instead:

1. Add a new, additive-nullable sibling field to `DiscoveryCandidate` (mirrors the `vision`/`visionSkippedReason` precedent exactly): `holisticBrief: HolisticBrief | null`, with a matching `.nullable().default(null)` entry on `discoveryCandidateSchema`. This is a plain TypeScript interface + `z.object(...)` guard — **never sent to Claude** (it is code-attached from comps/BRF data, not model output), so the Anthropic strict-output slim-schema discipline does not apply to it at all; only the READ-path guard needs the usual `.nullable().default(null)` treatment.
2. Populate it in `runVisionForJob` (or a small helper `vision.ts` exports) AFTER `runVisionPass` returns, by checking each resulting candidate: `if (candidate.vision && candidate.vision.claims.length === 0 && (comps || brf))` → attach `holisticBrief` built from that candidate's comps/BRF/confounder data, with `marker: "Baserat på områdesdata — ingen bildtolkning"` and a downgraded `confidence` (D-14-03/D-14-04). This is a single shared branch — it does not matter which of the two `claims: []` paths produced the empty array.
3. Because `holisticBrief` is populated OUTSIDE `runVisionForCandidate`/`runVisionPass` (which know nothing about comps/BRF), vision.ts's existing structural-separation posture (it may import `area-comps.ts`/`flip-economics.ts` freely — they're on the SAME vision/analysis read-path side of the LOCKED grep, which only forbids `niche-score.ts`/`flags.ts` from importing them) is respected either way; placing the fallback-construction helper in `vision.ts` itself, or in a new sibling module, are both structurally fine. A new sibling module (see Q6) is cleaner for testability and must be added to `VISION_MODULE_SPECIFIERS` in `niche-score.test.ts` regardless of where it lives.

### Q6 — Confounder normalization (ANL-04) as code

**Confirmed present on `DiscoveryCandidate` post-`enrichCandidateImages`** (verified `candidate.ts:111-149`, `job.ts:513-520`): `floor: number | null`, `balcony: boolean | null`, `orientation: {facades, confidence} | null`, `tenureForm: string | null`. **Confirmed absent:** no `elevator`/`hiss` field anywhere on `DiscoveryCandidate` (matches D-14-05's explicit deferral). No micro-location/noise field exists either (matches D-14-05).

**Recommended module placement:** a new pure module, e.g. `src/lib/discovery/confounder-guard.ts` (or `holistic-brief.ts` if it also owns the Q5 fallback-construction helper — either is defensible; keep it separate from `area-comps.ts`/`flip-economics.ts` since it composes their outputs rather than computing new aggregates). **This new module's specifier MUST be added to `VISION_MODULE_SPECIFIERS` in `niche-score.test.ts` (currently at line ~301-310)** — the CONTEXT.md-locked constraint explicitly requires this for any new holistic-analysis module.

**§2.6 rules to encode** (verified against the SPEC, `2026-07-10-ANALYSIS-REDESIGN-SPEC.md` §2.6):
- `>25%` below `R_med` → do NOT assume condition; cap `conditionExplainedPct` at 20%; route the residual to a `hiddenDefectPenalty` flag citing whichever of {BRF debt/m² > 15k, `floor === 0`/bottenvåning, tomträtt via `tenureForm`} actually applies to that candidate (never a generic "something's wrong" — cite the specific confounder(s) present).
- `sampleSize < MIN_COMPS_FOR_CONFIDENCE (5)` in the ≤12mo window → widen the band (increase `sizeBandPct` and/or `maxAgeMonths` on a second `computeAreaComps` call) or downgrade `confident: false` through to the final brief's confidence.
- Normalize kr/m² **inclusive of** förening debt/m² — i.e., before comparing a candidate's kr/m² against `R_med`/`U_med`, adjust for the BRF debt differential vs. the area's typical debt level (this requires the BRF summary; when unavailable for a candidate outside the BRF top-N, this normalization step is simply skipped and the confidence downgraded accordingly — never silently assume zero debt).
- The unknown-confounder rule (D-14-05): when elevator/micro-location data is absent (always, this phase), the guard must explicitly mark "cannot attribute to condition" rather than defaulting to attributing a low kr/m² to condition — i.e., the DEFAULT posture is "insufficient confounder data → downgrade confidence," not "confounders unknown → assume condition."

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Area name → Booli areaId resolution | A second free-text area matcher for `candidate.areaLabel` | The existing `resolveArea()` (cached via `area_cache`) | Same function already handles seed/probe/cache fallback; a second implementation would double-maintain the exact-match/typeRank logic |
| Render → SEK cost conversion | A second inline `renders * rate` formula for comps | Factor out `discoveryCostSek`'s existing inline arithmetic into a shared `renderSek()` helper | `USD_PER_RENDER`/`USD_SEK_RATE` already live in `discovery/cost.ts` / `brf/cost.ts`; a second copy risks the two drifting apart on a future rate change |
| BRF org.nr resolution / geo corroboration | A discovery-specific BRF name matcher | The existing pure `resolveOrgNr()` (`org-nr-resolver.ts`) | Already handles name normalization (Swedish accents, "Brf"/"Bostadsrättsföreningen" prefix stripping) and the Pitfall-4 collision-avoidance logic; only the CALLER (kommun availability) differs for discovery, not the resolution logic itself |
| Renovated/unrenovated comp classification | A new tercile/percentile aggregator | `computeAreaComps()` (already built, 9 tests, pure) | Exactly this phase's ANL-02 need; do not reimplement |

**Key insight:** every piece of math this phase needs (comps aggregation, cost conversion, BRF confidence gating, Haiku extraction) already exists as a tested pure function somewhere in the codebase. The actual work of Phase 14 is 100% wiring — the risk is in getting the WIRING points right (which data crosses which module boundary, in what order, sharing which budget), not in writing new algorithms.

## Common Pitfalls

### Pitfall 1: Reusing `runBrfExtraction`/`fetch-brf-auto.ts` for discovery (the Q4 trap)
**What goes wrong:** Calling `resolveOrgNrAction`/`confirmAndAnalyze`/`runBrfExtraction` for a discovery candidate either throws (no `analysisId` exists) or requires fabricating a fake `analyses` row purely to satisfy their internal `SELECT ... FROM analyses WHERE id = analysisId` calls — a much worse hack than writing ~30 lines of new orchestration code.
**Why it happens:** The function names ("BRF auto-fetch pipeline") suggest a generic, reusable BRF-fetching service; in reality every function from `resolveOrgNrAction` down through `runBrfExtraction`'s terminal persist is keyed to the single-listing `analyses` table (status writes: `auto_fetching`/`extracting`/`scoring`/`done`/`failed`, `brf_status`/`brf_data`/`brf_cost_sek`/`brf_pdf_hash` columns).
**How to avoid:** Call the four underlying pure/network functions directly (`searchAllabrfByName`, `resolveOrgNr`, `fetchAllabrfDocument`, `extractBrfFinancials`, `scoreExtraction`) from new discovery-specific orchestration code; never call `runBrfExtraction` or the `fetch-brf-auto.ts` actions for a discovery candidate.
**Warning signs:** any code path passing a discovery candidate's index/URL where an `analysisId` (uuid of an `analyses` row) is expected.

### Pitfall 2: `resolveOrgNr` structurally cannot return "high" confidence without a kommun signal
**What goes wrong:** Calling `resolveOrgNr({ brfName, kommun: null, candidates })` for every discovery candidate will produce `confidence: "low"` (never `"high"`) for essentially every single unambiguous name match, because `geoCorroborated` in `resolveOrgNr`'s logic (`org-nr-resolver.ts:161-166`) requires a non-null, non-empty `kommun` on BOTH sides. A team assuming this "just works" the way it does for the single-listing flow will silently get zero BRF fetches (if the planner gates on `confidence === "high"` only) — or, if the planner relaxes the gate to accept `"low"`, a materially different (weaker) wrong-BRF risk posture than the single-listing flow's DELIBERATELY conservative design.
**Why it happens:** `DiscoveryCandidate` has no kommun field (deliberately excluded from the PII-safe allowlist along with breadcrumbs) — this is a genuine data-availability gap, not a bug to fix in this phase.
**How to avoid:** This is an explicit product/risk decision the planner must make (see Open Questions OQ-1) — do not silently choose a confidence threshold without surfacing the tradeoff. A candidate mitigation: `resolveArea(candidate.areaLabel)`'s `AreaResolution.label` for a probe hit sometimes embeds a genitive-form kommun suffix (e.g. "Vasastan, Stockholms kommun" per `resolve-area.ts`'s own doc-comment example) that could be parsed with the SAME regex `fetch-brf-auto.ts`'s `kommunFromBreadcrumbs` already uses — but this is UNVERIFIED this session (no live area-cache read was possible; Supabase is paused) and must not be assumed to work without a live check.
**Warning signs:** a BRF top-N loop that always logs `confidence: "low"` / never fetches a document in a mocked test with a plausible unique BRF name.

### Pitfall 3: Sequential per-candidate BRF fetch inside the ~300s Server Action tick (the Phase 13 WR-02 lesson, recurring)
**What goes wrong:** A `for` loop awaiting `searchAllabrfByName` → `fetchAllabrfDocument` → `extractBrfFinancials` sequentially for N=3-5 top candidates, stacked ON TOP of the existing `enrichCandidateImages` detail-fetch loop (≤8 sequential Apify renders) and `runVisionPass`'s per-candidate Haiku+Sonnet calls, risks the same "sum of times, not max of times" trap RESUME.md's WR-02 documented for Phase 13's area scraping — except here it's compounding on an ALREADY slow tick.
**Why it happens:** Each BRF fetch chain is 2 network round-trips (search + document, each SSRF-guarded with its own DNS-pin/agent setup) + 1 Haiku call (~5-15s for a full årsredovisning text) — realistically 10-30s per candidate; N=5 sequential ≈ 50-150s added to an already-loaded tick.
**How to avoid:** Run the BRF top-N fetches CONCURRENTLY via `Promise.allSettled`, mirroring `runSlice`'s own `Promise.allSettled(areaIds.map(...))` pattern (`job.ts:186-188`) — never a sequential `for...await` loop over the top-N candidates.
**Warning signs:** a live-smoke run where total tick duration scales linearly with BRF top-N size.

### Pitfall 4: `tenureForm` may not actually carry a `"Tomträtt"` value
**What goes wrong:** D-14-02 assumes `tenureForm` (backfilled from Booli's `entry.tenureForm`, verified string values in fixtures/tests are exclusively `"Bostadsrätt"`) is the correct field to read tomträtt from. No committed fixture or test anywhere in the codebase shows a `"Tomträtt"` (or similar) value for `tenureForm` — this may be a distinct field on the underlying Apollo `Listing:` entity that was never surfaced through `reshapeListingEntity`/`toCandidate`.
**Why it happens:** `tenureForm` in Swedish real-estate contexts usually distinguishes "Bostadsrätt" (housing cooperative share) vs. "Äganderätt" (freehold) — tomträtt (leasehold LAND under the building) is a related but conceptually separate axis, more commonly surfaced as its own field or absent entirely from apartment listings (villas more commonly sit on tomträtt).
**How to avoid:** Before shipping the tomträtt confounder as "wired," verify live (or via a captured detail-page fixture) what `tenureForm` actually contains for a genuine tomträtt-encumbered BRF listing. If it's absent, degrade honestly (confounder unknown → downgrade confidence, matching D-14-05's own posture for elevator/micro-location) rather than silently treating every non-`"Bostadsrätt"` string as tomträtt.
**Warning signs:** the tomträtt discount in `computeAreaComps`/`confounder-guard.ts` never fires on any real candidate during a live smoke.

### Pitfall 5: GDPR / no-raw-persistence discipline extends to comps and BRF, not just images
**What goes wrong:** Persisting the raw `SoldComp[]` array (which can carry per-address-adjacent detail like floor/rooms/soldDate for individual sold units) or the raw Allabrf HTML/iXBRL text onto `discovery_jobs.results` would be a scope-creep GDPR risk beyond what CONTEXT.md authorizes.
**Why it happens:** It's tempting to cache "the whole comps response" per area for reuse across a later run, but `discovery_jobs.results` is a per-user, per-job JSONB blob — persisting raw comp records there is a different risk profile than the in-memory-only, per-run cache Q2 recommends.
**How to avoid:** Only the AGGREGATE `AreaComps` output (medians/percentiles/sampleSize/confident — no individual comp rows) and the AGGREGATE `BrfSummary` (financial figures, no raw scraped text) are ever persisted per candidate — mirrors `run-extraction.ts`'s own "v1 does not store raw HTML" precedent and `candidate.ts`'s no-spread-construction PII discipline.
**Warning signs:** a new persisted field on `DiscoveryCandidate` whose shape includes an array of individual sold-comp records rather than the pre-aggregated `AreaComps` shape.

## Code Examples

### Per-candidate area resolution + amortized comps fetch (Q1/Q2 composed)

```typescript
// Source: derived from resolve-area.ts:203-234, booli/client.ts:812-962,
// market/sold-schema.ts:177, area-comps.ts:105-148 (all verified on `main`).
const compsByAreaId = new Map<string, SoldComp[]>();
const areaIdByCandidateIndex = new Map<number, string>();

for (const [index, candidate] of enriched.entries()) {
  if (!candidate.areaLabel) continue; // no signal to resolve — comps skipped honestly
  const resolution = await resolveArea(candidate.areaLabel, supabase);
  if (!resolution) continue;
  areaIdByCandidateIndex.set(index, resolution.areaId);

  if (!compsByAreaId.has(resolution.areaId)) {
    // Cost-gate check BEFORE the fetch (D-14-08) — omitted here for brevity,
    // see Q3 for the exact accumulator pattern to mirror.
    const query: SoldSourceQuery = {
      lat: 0, lng: 0, booliId: null,
      breadcrumbs: [{ url: `https://www.booli.se/x?areaIds=${resolution.areaId}` }],
      tier: "building",
      objectType: null,
    };
    const { data } = await fetchSoldComps(query);
    compsByAreaId.set(resolution.areaId, normalizeSoldOutput(data));
  }
}

// Later, per candidate:
const areaId = areaIdByCandidateIndex.get(index);
const comps = areaId ? compsByAreaId.get(areaId) : undefined;
const areaComps = comps
  ? computeAreaComps(comps, {
      rooms: candidate.rooms,
      livingArea: candidate.livingArea,
      asOf: new Date().toISOString().slice(0, 10),
      objectType: null,
    })
  : null;
```

### BRF top-N selection reusing the already-merged prelim rank (Q4)

```typescript
// Source: derived from job.ts:433-462 (enrichmentPriority/enrichmentVisitOrder,
// already merged, unchanged here) — reused for BRF top-N, not re-derived.
const BRF_TOP_N = 4; // planner's call, per D-14-01's ~3-5 band

const brfEligible = enrichmentVisitOrder(enriched)
  .filter((i) => enriched[i].brfName !== null)
  .slice(0, BRF_TOP_N);

// Q4 Pitfall 3: concurrent, never sequential.
const brfResults = await Promise.allSettled(
  brfEligible.map(async (index) => {
    const candidate = enriched[index];
    const candidates = await searchAllabrfByName(candidate.brfName!);
    // kommun: null — see Open Question OQ-1; this is the load-bearing gap.
    const resolution = resolveOrgNr({ brfName: candidate.brfName!, kommun: null, candidates });
    if (resolution.confidence !== "high") return { index, summary: null };
    const doc = await fetchAllabrfDocument(resolution.orgNr);
    if (!doc) return { index, summary: null };
    const result = await extractBrfFinancials({
      kind: "ixbrl-text",
      text: doc.text,
      contentHash: "", // discovery has no D-06 cache row to key against — accept a fresh call each run
    });
    const { normalized } = scoreExtraction(result.parsed);
    return { index, summary: normalized, costSek: costSek(result.usage) };
  }),
);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Analysis is image-only (no BRF/comps in the discovery deep pass) | Holistic: comps + BRF folded into the deep-pass payload | This phase (SPEC Phase A.4) | ANL-02/ANL-03 |
| `claims: []` treated as "nothing to say" | Holistic-data-only fallback brief guarantees ≥1 actionable item | This phase (SPEC Phase A.3) | ANL-01 |
| Low kr/m² sorted-but-unexplained (no reno claim made) — already correct today | Low kr/m² explicitly normalized against confounders BEFORE any reno attribution is even attempted downstream | This phase (SPEC §2.6) | ANL-04 |

**Deprecated/outdated:** none — this phase does not remove or replace any existing behavior, it is purely additive.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `candidate.areaLabel`'s value ("Södermalm"-style clean stadsdel name) is representative across the FULL candidate population, not just the one committed fixture inspected this session | Q1 | If real-world `descriptiveAreaName` values are sometimes compound/noisy (e.g. "Hornstull, Södermalm"), `resolveArea`'s exact-match-first `pickBestSuggestion` logic may miss more often than assumed, falling through to a live probe render more frequently than the "usually cache-warm" claim in Q1 suggests — inflates comps-path cost, does not break correctness (probe still degrades to `null` safely) |
| A2 | `resolveArea`'s probe-hit `AreaResolution.label` reliably embeds a parseable "X kommun" suffix that could substitute for the missing breadcrumb-derived kommun signal (Pitfall 2's mitigation) | Q4 / Pitfall 2 | This was NOT live-verified this session (not exercised; note the original parenthetical "Supabase paused, Booli blocked from operator IP" was incorrect on both counts — corrected 2026-08-11) — if the label format varies or omits kommun for seed/cache hits (as opposed to only live probe hits), this mitigation doesn't actually raise `resolveOrgNr`'s confidence and the OQ-1 gap stands unmitigated |
| A3 | A single Haiku call for BRF extraction over a full årsredovisning iXBRL text takes roughly 5-15s (used to estimate the Pitfall-3 sequential-loop risk) | Pitfall 3 | Based on the existing manual-upload path's typical behavior (training-data inference, not measured this session) — if real latency is significantly higher, the concurrency recommendation becomes even more critical, not less; if lower, the risk is smaller than stated but the recommendation is still strictly safer |
| A4 | `tenureForm` never carries a `"Tomträtt"`-equivalent value based on absence from all inspected fixtures/tests | Pitfall 4 | If it turns out `tenureForm` DOES carry such a value in real listings just untested, D-14-02's design is actually fine as-is and Pitfall 4 is a non-issue — but this can only be confirmed with a live Booli detail-page fetch, which was unavailable this session |

**If this table is empty:** N/A — see rows above; every claim not directly backed by a `Read`/`grep` of `main`'s source this session is logged here.

## Open Questions

1. **Should discovery's BRF top-N fetch proceed on `resolveOrgNr` confidence `"low"` (not just `"high"`), given the missing kommun signal makes `"high"` nearly unreachable?**
   - What we know: `resolveOrgNr`'s `"high"` tier structurally requires geo corroboration that discovery candidates don't carry (Pitfall 2). The single-listing flow NEVER auto-fetches below `"high"`.
   - What's unclear: whether the operator accepts a materially weaker wrong-BRF risk for discovery (gating on `"low"` — i.e., exactly one name match, no geo check) versus effectively disabling the BRF top-N feature entirely (gating on `"high"`, which will almost never fire) versus building the Pitfall-2 kommun-from-`AreaResolution.label` mitigation (unverified, adds scope).
   - Recommendation: surface this explicitly to the operator before implementation — this is a locked-decision-shaped gap CONTEXT.md's D-14-01/D-14-02 did not anticipate. A middle path: gate on `"low"` ONLY when `nameMatches.length === 1` (i.e., accept an unambiguous single name match without geo corroboration, but still reject when Allabrf returns multiple BRFs of the same name) — this is a strictly safer relaxation than accepting any `"low"` result, and is expressible without touching `resolveOrgNr`'s own logic (just read the underlying `nameMatches`/`candidates` shape at the call site).

2. **What is the actual value shape of `tenureForm` for a tomträtt-encumbered listing?** (Pitfall 4 / A4) — needs a live Booli detail-page fetch or a captured real fixture to resolve; blocked by the same operator-IP-blocked-from-Booli constraint noted in the phase brief.

3. **Does `AreaResolution.label`'s kommun suffix reliably survive cache/seed hits (not just live probe hits)?** (A2) — needs a live Supabase read of `area_cache` + `area-seed.ts` inspection; Supabase is currently paused, deferring this to the live-verification gate alongside DXUX-01/A.4's other deferred live checks.

4. **Exact BRF_TOP_N value (3 vs 4 vs 5)?** — Claude's Discretion per CONTEXT.md; no strong signal either way from this research. Recommend 4 as a middle value, revisit after a live-smoke cost/latency measurement.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Supabase (live DB) | `resolveArea`'s `area_cache` read/write, `discovery_jobs` read/write | ✗ (paused per phase brief) | — | Unit/mocked tests unaffected; live verification of Q1/Q2/Q4 wiring deferred until restored (same posture as Phase 13's DXUX-01 deferred live gate) |
| Booli (live network) | Live comps fetch, live area probe | ✗ not exercised this session | — | **CORRECTED 2026-08-11:** this row previously read "403, Cloudflare-blocked from operator IP per phase brief" and recommended verifying "from a non-blocked IP/CI environment". No phase brief says this (14-CONTEXT.md / 14-DISCUSSION-LOG.md contain nothing about it); the claim was an unhedged restatement of 13-SMOKE-FINDINGS.md's *hedged* "likely partly environmental" note. Booli is never reached from the operator IP — every rung goes via `apify/playwright-scraper` on an Apify RESIDENTIAL/SE proxy, so a different IP/CI environment changes nothing. Mocked/fixture-based tests unaffected either way. |
| Allabrf (live network) | BRF search + document fetch | Unknown — not tested this session | — | Same SSRF-guarded fetch pattern already used by the single-listing flow; no new host, low incremental risk, but not verified live this session |
| Anthropic API | Haiku extraction call (BRF), existing vision Haiku/Sonnet calls | Unknown — not tested this session | — | Existing infra; no new model or endpoint introduced |

**Missing dependencies with no fallback:** none — every live-network dependency already has an existing fallback/mocked-test path; the phase's live end-to-end verification is deferred, matching the project's existing deferred-live-gate precedent (Phase 13 DXUX-01, Phase 11/12 kill-criterion checkpoints).

**Missing dependencies with fallback:** Supabase (paused) and Booli (IP-blocked) — both already flagged in the phase brief as known, pre-existing blockers, not new to this phase.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.8 |
| Config file | `vitest.config.ts` |
| Quick run command | `npx vitest run src/lib/discovery/job.test.ts src/lib/discovery/vision.test.ts src/lib/discovery/area-comps.test.ts` |
| Full suite command | `npm run test` (`vitest run`) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|---------------------|--------------|
| ANL-01 | A candidate whose `claims` end up `[]` (either Haiku-skip or confidence-filter path) receives a non-null `holisticBrief` with the D-14-04 marker | unit | `npx vitest run src/lib/discovery/vision.test.ts` | ✅ existing file, ❌ new test cases needed |
| ANL-02 | `computeAreaComps` output correctly attributed per resolved areaId, comps fetched ONCE per distinct areaId across a multi-area candidate set | unit + integration | `npx vitest run src/lib/discovery/job.test.ts src/lib/discovery/job.integration.test.ts` | ✅ existing files, ❌ new test cases needed |
| ANL-02 | Per-candidate `resolveArea(candidate.areaLabel)` resolution (mocked `resolveArea`) attaches the correct `AreaComps` shape | unit | `npx vitest run src/lib/discovery/job.test.ts` | ✅ existing file, ❌ new test cases needed |
| ANL-03 | BRF top-N selection reuses `enrichmentVisitOrder`, skips candidates with `brfName === null`, runs concurrently (Pitfall 3) | unit | `npx vitest run src/lib/discovery/job.test.ts` | ✅ existing file, ❌ new test cases needed |
| ANL-03 | `resolveOrgNr` confidence gate behavior with `kommun: null` (documents the OQ-1 tradeoff, whatever the planner decides) | unit | `npx vitest run src/lib/brf-source/org-nr-resolver.test.ts` | ✅ existing file, no changes needed (pure function, already covers `kommun: null` case) |
| ANL-04 | §2.6 discount-attribution guard rules (>25% cap, ≥5-comp confidence, debt-inclusive kr/m² normalization) | unit | `npx vitest run src/lib/discovery/confounder-guard.test.ts` (new file) | ❌ Wave 0 |
| ANL-04 | UI never renders "låg kr/m² ⇒ reno" — static-grep or snapshot test on the new marker/framing text | unit | `npx vitest run src/components/discovery-results.test.tsx` (or new component test) | ✅ file likely exists per Phase 10 precedent — verify exact name at plan time |
| D-14-08 | Cost-cap accounting: comps+BRF spend shares `CAP_VISION_SEK_MAX`, comps never double-counted per candidate | unit | `npx vitest run src/lib/discovery/cost.test.ts` | ✅ existing file, ❌ new test cases needed |
| Separation guard | New confounder/holistic module added to `VISION_MODULE_SPECIFIERS` | unit | `npx vitest run src/lib/discovery/niche-score.test.ts` | ✅ existing file — MUST be edited (add specifier), not just re-run |

### Sampling Rate

- **Per task commit:** the relevant single-file `npx vitest run <file>` from the table above.
- **Per wave merge:** `npm run test` (full suite) — this phase touches shared cost/schema code (`cost.ts`, `candidate.ts`, `discoveryCandidateSchema`) that many other modules depend on; a full-suite regression risk is real and cheap to catch here.
- **Phase gate:** full suite green before `/gsd-verify-work`, PLUS a live smoke deferred (per Environment Availability) once Supabase is restored and a non-blocked-IP test run is possible — mirrors Phase 13's DXUX-01 deferred-live-gate precedent exactly. Do NOT block phase completion on the live smoke; record it as an explicit deferred operator step in the phase SUMMARY, same as Phase 11/12/13's precedent.

### Wave 0 Gaps

- [ ] `src/lib/discovery/confounder-guard.test.ts` (or equivalent name) — covers ANL-04's §2.6 rule encoding; no existing file, net-new module and tests.
- [ ] New test cases (not new files) inside `job.test.ts` / `job.integration.test.ts` / `vision.test.ts` / `cost.test.ts` for the Q1/Q2/Q3/Q5 wiring — the files exist and already mock `resolveArea`/`fetchSoldComps`-adjacent dependencies from prior phases' work, so this is additive test-case authorship, not new infrastructure.
- [ ] Edit (not create) `niche-score.test.ts`'s `VISION_MODULE_SPECIFIERS` array to add the new module's specifier — a one-line addition, but easy to forget; the plan should make it an explicit task with its own verification step (the existing two `it(...)` blocks will start failing if the new module IS imported by niche-score/flags and the specifier is missing, so this is self-verifying once added — but must be added FIRST or the guard is silently inert for the new module).

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | no | This phase touches server-only job-processing code, not an auth surface |
| V3 Session Management | no | N/A |
| V4 Access Control | yes (indirectly) | No new access-control surface is introduced, but the new comps/BRF fetches run inside `runVisionForJob`, which is only ever invoked after the existing `claimVisionSlice`/`claim_discovery_slice` ownership-checked CAS — no new entry point bypasses that gate |
| V5 Input Validation | yes | The new persisted fields (`holisticBrief`, per-candidate `AreaComps`, `BrfSummary`) MUST get `.nullable().default(null)` Zod read-path guards on `discoveryCandidateSchema`, matching every existing additive field's discipline (CR-01 precedent, `candidate.ts`) |
| V6 Cryptography | no | N/A |
| V12 (SSRF) | yes | The BRF fetch reuses `allabrf.ts`'s already-guarded `resolveSafeExternalUrl` + host-allowlist + DNS-pin pattern unchanged — no new outbound fetch surface is introduced; the comps fetch reuses the existing `runPlaywrightRender`/Booli-host-allowlist transport unchanged |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| Org.nr-interpolation SSRF via a malformed/attacker-influenced `brfName`/org.nr | Tampering | Already mitigated — `isValidOrgNr` (Luhn-checked) runs BEFORE any URL construction in `allabrf.ts`; this phase does not change that call order |
| A tampered/corrupted persisted `holisticBrief`/`AreaComps`/`BrfSummary` field rendering untrusted content | Tampering / Information Disclosure | These are plain numeric/string aggregate fields (no URLs, no HTML) — no new `<img src>`-style injection surface is introduced (unlike `imageUrlsUsed`, which already has its own `isAllowedImageHost` re-check); still, apply the standard `.nullable().default(null)` Zod guard so a malformed row degrades gracefully rather than crashing the results page |
| Doubling real spend via a race between a client tick and the cron sweep both running comps/BRF fetches for the same job | Denial of Service (cost) | Already mitigated structurally — comps/BRF fetches this phase land INSIDE `runVisionForJob`, which only runs after `claimVisionSlice`'s atomic `"done"` → `"vision_processing"` CAS; the same race protection that already prevents double vision spend automatically covers the new comps/BRF spend with zero new code |

## Sources

### Primary (HIGH confidence — direct `Read`/`grep` of `main`'s source this session)

- `src/lib/discovery/job.ts` (full read) — `runVisionForJob`, `enrichCandidateImages`, `enrichmentPriority`/`enrichmentVisitOrder`, `claimVisionSlice`, `claimAndRunVisionForJob`, `runSlice`'s multi-area concurrency pattern
- `src/lib/discovery/vision.ts` (full read) — both `claims: []` paths, cost-gate placement, structural-separation doc comments
- `src/lib/discovery/candidate.ts` (full read) — `DiscoveryCandidate` shape (confirms no `areaId`, no `elevator`), `areaLabel` provenance, `discoveryCandidateSchema`
- `src/lib/discovery/area-comps.ts` (full read) — `computeAreaComps`, `AreaCompsFilter`, tercile-proxy logic
- `src/lib/discovery/resolve-area.ts` (full read) — `resolveArea`, cache/seed/probe fallback order, `AreaResolution.label` shape
- `src/lib/discovery/cost.ts` (full read) — `USD_PER_RENDER`, `CAP_VISION_SEK_MAX`, `estimateVisionCallSek`
- `src/lib/booli/client.ts` (targeted read, lines ~795-962) — `SoldSourceQuery`, `resolveAreaId`, `buildSlutpriserUrl`, `fetchSoldComps`
- `src/lib/market/sold-schema.ts` (full read) — `SoldComp`, `normalizeSoldOutput`
- `src/lib/discovery/vision-schema.ts` (full read) — `VisionResult`, slim-schema discipline, `VISION_CONFIDENCE_THRESHOLD`
- `src/lib/discovery/condition-score.ts` (full read) — confirms `claims.length === 0` early-return behavior
- `src/lib/discovery/niche-score.test.ts` (targeted read, lines 260-329) — `VISION_MODULE_SPECIFIERS` grep list, exact current contents
- `src/components/discovery-results.tsx` (targeted read) — ranking tiebreaker wiring, confirms no server-side comps reuse today
- `src/app/api/discovery/sweep/route.ts`, `src/actions/tick-discovery.ts` (full reads) — confirmed `claimedRow.filters` scope at both `claimAndRunVisionForJob` call sites; found the wedged-recovery branch's `.select("id")` would need widening to `.select("id, filters")` if job-level threading were chosen (moot given the Q1 recommendation, but confirmed as a fallback option)
- `supabase/migrations/010_discovery_jobs.sql`, `011_claim_slice_ownership.sql` (full reads) — confirmed `claim_discovery_slice` only claims `('pending','processing')`, never `'done'`, which determines when `claimedRow.filters` is/isn't in scope
- `src/actions/fetch-brf-auto.ts` (full read) — confirmed `analysisId`/`analyses`-table binding at every step
- `src/lib/brf-source/org-nr-resolver.ts` (full read) — `resolveOrgNr`'s geo-corroboration requirement, exact confidence-gating logic
- `src/lib/brf/run-extraction.ts` (full read) — confirmed `runBrfExtraction`'s unconditional `analyses`-table reads/writes; `scoreExtraction` confirmed pure/reusable
- `src/lib/brf-source/allabrf.ts` (full read) — `searchAllabrfByName`, `fetchAllabrfDocument`, SSRF-guard pattern, no-throw contract
- `src/lib/schemas/brf.ts` (targeted read) — confirmed `brfExtractionSchema` fields, absence of `tomträtt`/`soliditet`
- `src/lib/brf/cost.ts` (targeted read) — `USD_SEK_RATE=11`, `costSek`/`costSekSonnet`
- `src/lib/discovery/filter-schema.ts` (targeted grep) — `CAP_SEK_MAX=5`, `CAP_CANDIDATES_MAX=25`, `CAP_IMAGES_PER_LISTING=4`
- `.planning/phases/14-holistic-analysis-brain/14-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md`, `.planning/ROADMAP.md`, `.planning/research/2026-07-10-ANALYSIS-REDESIGN-SPEC.md`, `.planning/research/2026-07-10-what-makes-apartments-increase-in-price.md` — full reads, all as instructed
- `src/lib/booli/__fixtures__/listing-detail.json` (grep) — confirms real `descriptiveAreaName: "Södermalm"` value shape
- `src/lib/discovery/candidate.test.ts` (grep) — confirms `tenureForm` test fixtures are exclusively `"Bostadsrätt"`, never a tomträtt-style value

### Secondary (MEDIUM confidence)

- None this session beyond the primary sources above — no WebSearch/Context7 lookups were needed since this phase is 100% internal wiring against an already-fully-source-available codebase.

### Tertiary (LOW confidence)

- Latency estimates for a single Haiku BRF extraction call (5-15s, Assumption A3) — training-data inference, not measured; flagged in the Assumptions Log.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries, fully verified against `package.json` and existing imports
- Architecture (Q1/Q2/Q3/Q5/Q6): HIGH — every claim traced to a specific file:line read this session
- BRF feasibility (Q4): MEDIUM — the structural-incompatibility finding is HIGH confidence (directly verified), but the resolution (Open Question OQ-1) requires an operator decision this research cannot make unilaterally
- Pitfalls: HIGH for Pitfalls 1/2/3/5 (directly verified or directly derived from verified code); LOW for Pitfall 4 (tenureForm/tomträtt value, explicitly flagged as unverified)

**Research date:** 2026-08-05
**Valid until:** 30 days (stable — this phase's dependencies are all internal, already-shipped code; the only external-drift risk is if `main` moves significantly on `job.ts`/`vision.ts` before planning executes)
