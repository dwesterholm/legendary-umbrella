---
phase: 03-market-context
verified: 2026-06-22T20:10:00Z
status: passed
score: 14/14
overrides_applied: 0
re_verification: false
---

# Phase 3: Market Context — Verification Report

**Phase Goal:** Deliver the two market-context panels on the analysis page — PRICE-01 (deterministic sold-price comparison: listing pris/kvm vs recent area slutpriser, with ±%, tier, confidence, distribution, trend) and AREA-01 (SCB neighborhood demographics: population, age, income, tenure) — each rendering and degrading INDEPENDENTLY (D-08), with honest trust states (D-08/D-09) and deterministic compute (never an LLM).

**Verified:** 2026-06-22T20:10:00Z
**Status:** PASSED
**Re-verification:** No — initial verification
**Requirements verified:** PRICE-01, AREA-01

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | PRICE-01: sold-price panel renders ±% headline, comp list, sample/tier, distribution | VERIFIED | `price-comparison-card.tsx` reason "ok" branch: D-04 headline banner (sage/terracotta), `krPerKvm()`, D-05 sampleSize + tier label, min–max spread, trendSlope arrow |
| 2 | PRICE-01: backed by deterministic non-LLM compute | VERIFIED | `compare.ts:172-240` — pure function, no Date.now/Math.random/network; `computePriceComparison` exported with JSDoc "never an LLM (D-09 trust model)" |
| 3 | Four honest PriceData.reason states distinct (HIGH-1/HIGH-3) | VERIFIED | `price-comparison-card.tsx:159/178/203/230` — four explicit branches; `source_unavailable` ("Prisjämförelse ej tillgänglig") uses neutral bg-warm-gray-50; `thin` ("För få försäljningar") uses bg-terracotta-50 — distinct colour + copy. `listing_pris_okand` shows "pris/kvm saknas" never a ±% headline |
| 4 | HIGH-3 guard: listingPrisPerKvm 0/null never produces −100 % headline | VERIFIED | `compare.ts:190-206` guard returns `reason: "listing_pris_okand", deltaPct: null`; `enrich-market-context.ts:336-343` pre-guards before any fetch-walk; `compare.test.ts:123-150` two test cases both PASS |
| 5 | AREA-01: SCB panel renders four demographics metrics (income, population, age, tenure) | VERIFIED | `area-stats-card.tsx:153-178` — four MetricCard tiles; `AreaStatsCard` renders `metrics.income`, `metrics.population`, `metrics.age` (via `formatAge`), `metrics.tenure` (via `formatTenure`) |
| 6 | AREA-01: "Källa: SCB" label + year shown | VERIFIED | `area-stats-card.tsx:181` — `Källa: SCB{footerYear ? \` · ${footerYear}\` : ""}` |
| 7 | Each panel degrades INDEPENDENTLY (D-08 / Success Criterion 3) | VERIFIED | `market-context-section.tsx:147-183` — price always rendered (or synthesized source_unavailable); area rendered separately with its own null fallback card; one null source never blanks the other |
| 8 | Owner-only auth: no isGuest prop, hard auth gate server-side | VERIFIED | `enrich-market-context.ts:282-297` — auth.getUser() + user_id ownership check; `market-context-section.tsx` interface has no isGuest prop; `page.tsx` passes no isGuest to MarketContextSection |
| 9 | Deterministic core library files exist and are substantive | VERIFIED | `compare.ts` (pure, 241 lines), `cost.ts` (pure, 57 lines), `sold-source.ts` (source-isolated, 228 lines), `sold-schema.ts` (normalizeSoldOutput + safeParsePriceData, 290 lines), `geo.ts` (point-in-polygon, 127 lines), `scb.ts` (fetchScbDemographics, 316 lines), `scb-schema.ts` (normalizeScbOutput + safeParseAreaData, 247 lines) |
| 10 | deso.geojson committed and geo loads it at runtime (process.cwd path + next.config.ts trace) | VERIFIED | `src/data/deso.geojson` — 5.1 MB, 6160 features with `desokod`/`kommunkod`; `geo.ts:45` — `path.join(process.cwd(), "src/data/deso.geojson")`; `next.config.ts` — `outputFileTracingIncludes: { "/**": ["./src/data/deso.geojson"] }` |
| 11 | Migration 003_market_context.sql: all 5 columns declared | VERIFIED | `price_data jsonb`, `area_data jsonb`, `market_status text`, `market_source text`, `market_cost_sek numeric` — all 5 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` present |
| 12 | Listing schema retains latitude/longitude/booliId/breadcrumbs | VERIFIED | `listing.ts:53-57` — nullable Zod fields in `listingDataSchema`; `NormalizedListing:76-79`; `normalizeScraperOutput:119-121` maps them; `analyze.ts:65-68/103-106` writes them on new scrapes |
| 13 | Full vitest suite passes (67 tests) | VERIFIED | `npx vitest run` → 11 test files, 67 passed, 6 todo — 0 failures |
| 14 | TypeScript compiles clean; market panels wired into analysis page replacing the two placeholders | VERIFIED | `npx tsc --noEmit` — no output (clean); `page.tsx:6,10-11,46-47,72-78` — imports MarketContextSection, safeParsePriceData, safeParseAreaData; calls them; no ComingSoonSection for Prisjämförelse or Områdesstatistik; AI Rapport ComingSoonSection kept at line 79 |

**Score:** 14/14 truths verified

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/lib/market/compare.ts` | Pure deterministic comparison engine | VERIFIED | 241 lines; exports `computePriceComparison`, `PRICE_COMPARISON_THRESHOLDS`, `PriceComparison` type with `reason` |
| `src/lib/market/cost.ts` | Per-analysis cost guard | VERIFIED | 57 lines; exports `soldSourceCostSek`, `USD_SEK_RATE`, `SOLD_SOURCE_COST_CAP_SEK` |
| `src/lib/market/sold-source.ts` | Source-isolated sold fetch | VERIFIED | 228 lines; exports `fetchSoldComps` (throws HIGH-1, never silent []), `resolveAreaId`, `PriceTier` |
| `src/lib/market/sold-schema.ts` | Normalization + persisted read guard | VERIFIED | 290 lines; exports `normalizeSoldOutput`, `safeParsePriceData`, `priceDataSchema`, `PriceData` with all four reasons, `SoldComp` |
| `src/lib/market/geo.ts` | DeSO point-in-polygon resolver | VERIFIED | 127 lines; exports `resolveGeo`, `ResolvedGeo`; loads `deso.geojson` via `process.cwd()` with ESM fallback |
| `src/lib/market/scb.ts` | SCB PxWebApi client | VERIFIED | 316 lines; exports `fetchScbDemographics`; re-exports `normalizeScbOutput`, `safeParseAreaData`, `areaDataSchema`, `AreaData` |
| `src/lib/market/scb-schema.ts` | json-stat2 normalize + persisted read guard | VERIFIED | 247 lines; exports `normalizeScbOutput`, `safeParseAreaData`, `areaDataSchema`, `AreaData` |
| `src/data/deso.geojson` | SCB DeSO_2025 polygons | VERIFIED | 5.14 MB; FeatureCollection with 6160 features; each carries `desokod` and `kommunkod` properties |
| `supabase/migrations/003_market_context.sql` | Market context columns | VERIFIED | 5 columns: price_data, area_data, market_status, market_source, market_cost_sek; all `IF NOT EXISTS` |
| `src/actions/enrich-market-context.ts` | Owner-only, independent persist, cost cap | VERIFIED | 455 lines; auth gate (line 282), ownership check (line 296), D-01 tier walk, independent price/area branches, cost gate (line 398), terminal persist (line 435) |
| `src/components/price-comparison-card.tsx` | PRICE-01 panel | VERIFIED | 306 lines; four distinct reason branches; "ej värdering" disclaimer; `kr/m²`; source+freshness footer; confidence badge |
| `src/components/area-stats-card.tsx` | AREA-01 panel | VERIFIED | 187 lines; four MetricCard tiles; "Ej tillganglig" null fallback; "Källa: SCB" footer; geo-level label |
| `src/components/market-context-section.tsx` | Client orchestrator | VERIFIED | 185 lines; imports `enrichMarketContext`; independent per-panel degrade; no isGuest prop; status state machine (null/fetching/done/failed) |
| `src/app/(app)/analysis/[id]/page.tsx` | RSC wiring | VERIFIED | Imports and calls `safeParsePriceData`/`safeParseAreaData`; renders `MarketContextSection`; no Prisjämförelse/Områdesstatistik ComingSoonSection; AI Rapport kept |
| `src/lib/market/__fixtures__/sold-comps.json` | Live sold-comps fixture | VERIFIED | Array-of-items shape (`{ items: [{ hasApollo: true, __APOLLO_STATE__: {...} }] }`); 35 SoldProperty entries in first item |
| `src/lib/market/__fixtures__/scb-population.json` | SCB json-stat2 fixture | VERIFIED | json-stat2 class; has `id`, `version`, `class`, `label`, `source` keys |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `page.tsx` | `safeParsePriceData / safeParseAreaData` | RSC re-validates persisted jsonb | VERIFIED | `page.tsx:10-11,46-47` — imports both; calls both on `analysis.price_data`/`analysis.area_data` |
| `market-context-section.tsx` | `enrichMarketContext` | client trigger | VERIFIED | `market-context-section.tsx:8,85` — imports and calls `enrichMarketContext(analysisId)` in `startTransition` |
| `enrich-market-context.ts` | `fetchSoldComps` (sold-source.ts) | D-01 tier walk | VERIFIED | `enrich-market-context.ts:9,351-356` — imports and calls `fetchSoldComps` inside `walkSoldTiers` |
| `enrich-market-context.ts` | `computePriceComparison` (compare.ts) | deterministic compute | VERIFIED | `enrich-market-context.ts:18,362-366` — imports and calls with `{listingPrisPerKvm, comps, tier}` |
| `enrich-market-context.ts` | `fetchScbDemographics` (scb.ts) | AREA branch | VERIFIED | `enrich-market-context.ts:20,412` — imports and calls with resolved geo |
| `enrich-market-context.ts` | `resolveGeo` (geo.ts) | coord→DeSO | VERIFIED | `enrich-market-context.ts:4,325` — imports and calls `resolveGeo(lat, lng)` |
| `geo.ts` | `src/data/deso.geojson` | `readFileSync` at process.cwd() | VERIFIED | `geo.ts:45` — primary candidate `path.join(process.cwd(), "src/data/deso.geojson")`; `next.config.ts` traces it into server bundle |
| `analyze.ts` | `listing.ts normalizeScraperOutput` | writes extended ListingData | VERIFIED | `analyze.ts:65-68,103-106` — latitude/longitude/booliId/breadcrumbs flow through to the insert |

---

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|-------------------|--------|
| `price-comparison-card.tsx` | `priceData` prop | persisted `price_data` jsonb → `safeParsePriceData` → RSC → `MarketContextSection` state | Yes — `enrich-market-context.ts` populates from `fetchSoldComps` + `computePriceComparison`; live source confirmed by human gate | FLOWING |
| `area-stats-card.tsx` | `areaData` prop | persisted `area_data` jsonb → `safeParseAreaData` → RSC → `MarketContextSection` state | Yes — `enrich-market-context.ts` populates from `fetchScbDemographics`; live SCB metrics confirmed by human gate | FLOWING |
| `market-context-section.tsx` | `price` / `area` state | seeded from RSC props; updated by `enrichMarketContext` result | Yes — action returns `{ok: true, data: {price, area}}` | FLOWING |

---

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| All 67 unit tests pass | `npx vitest run` | 11 files, 67 passed, 6 todo, 0 fail | PASS |
| TypeScript compiles clean | `npx tsc --noEmit` | No output (clean) | PASS |
| HIGH-3 guard cases (0 and null listingPrisPerKvm) | vitest compare.test.ts lines 123-150 | `reason: "listing_pris_okand"`, `deltaPct: null`, no throw — 2/2 PASS | PASS |
| areaAvg-NaN guard (all comps null pris/kvm) | vitest compare.test.ts lines 152-175 | `reason: "thin"`, `areaAvg` is null or finite (never NaN) — PASS | PASS |
| sold-comps fixture parses correctly | `normalizeSoldOutput` on `sold-comps.json` | 35 SoldProperty entries; fixture in `{ items: [{hasApollo, __APOLLO_STATE__}] }` shape matching live source | PASS |

---

## Probe Execution

No conventional probe scripts (`scripts/*/tests/probe-*.sh`) are declared for this phase. The human-verify gate (Plan 06 Task 3) served as the live probe — PRICE-01 LIVE GATE APPROVED (genuine end-to-end comparison: 35 sold comps, reason "ok", ±% headline rendered). AREA-01 verified live for Södermalm DeSO `0180C3130`.

---

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| PRICE-01 | 03-01 through 03-06 | System compares listing price vs recently sold properties in same area/building (pris/kvm vs area average, trend direction, sample size) | COVERED | `compare.ts` deterministic engine + `sold-source.ts` Booli SSR source + `price-comparison-card.tsx` panel; live gate confirmed real comparison rendered |
| AREA-01 | 03-01 through 03-06 | System displays SCB demographics for the listing's neighborhood (income levels, population trends) | COVERED | `scb.ts` + `scb-schema.ts` + `area-stats-card.tsx`; live gate confirmed four metrics from SCB DeSO `0180C3130` |

---

## Anti-Patterns Found

No debt markers (TBD/FIXME/XXX), placeholder implementations, empty handlers, or stub returns found in the phase-03 files. Scanned: all files in `src/lib/market/`, `src/actions/enrich-market-context.ts`, `src/components/price-comparison-card.tsx`, `src/components/area-stats-card.tsx`, `src/components/market-context-section.tsx`.

One watch item noted in SUMMARY (not blocking): a transient HTTP 402 seen once on the Apify actor during the live gate, did not reproduce. Noted for a future transient-vs-permanent error-handling improvement (Phase 4 robustness). Not a code gap — the current implementation correctly maps all non-SUCCEEDED runs to `source_unavailable`.

---

## Human Verification Required

None — the Plan 06 Task 3 human-verify checkpoint was completed and APPROVED before this verification. The live gate confirmed:

1. PRICE-01 on a real listing: 35 sold comps returned (hasApollo true), reason "ok", ±% headline, comp-list receipt, sample size + tier, distribution range, confidence badge, source label, "ej värdering" disclaimer rendered.
2. AREA-01 on Södermalm DeSO 0180C3130: population 1616, median income 414.7k SEK, age distribution, tenure mix rendered with "Källa: SCB" + per-metric year.
3. Success Criterion 3 (independent degrade): each panel degrades independently; one null source never blanks the other.
4. HIGH-1: source_unavailable ("Prisjämförelse ej tillgänglig") is visually distinct from the thin-data "För få försäljningar" marker.
5. HIGH-3: a listing with missing pris/kvm shows "pris/kvm saknas för objektet", not −100 %.

---

## Gaps Summary

No gaps. All 14 must-have truths verified. Both requirements (PRICE-01, AREA-01) COVERED with code evidence at every level: artifact exists, is substantive, is wired, and data flows through to the rendered output.

---

_Verified: 2026-06-22T20:10:00Z_
_Verifier: Claude (gsd-verifier)_
