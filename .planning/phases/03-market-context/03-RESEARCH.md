# Phase 3: Market Context - Research

**Researched:** 2026-06-17
**Domain:** Swedish real-estate sold-price acquisition (Booli) + SCB open demographics API + lat/lng→geographic-code resolution
**Confidence:** HIGH on the two negative/positive feasibility findings (live-tested); MEDIUM on the recommended sold-price path (one viable path requires a manual application step that can't be completed in-session)

## Summary

This phase replaces two "Kommer snart" placeholders with real data panels: a comparable sold-prices comparison (PRICE-01) and SCB area demographics (AREA-01). The whole phase hinges on the two flagged data-availability unknowns, and both were resolved with live tests this session.

**Finding 1 (D-09-RD — sold prices):** The existing Apify actor `lexis-solutions/booli-se-scraper` (`bpf1JaYRBbia2nQU9`) **CANNOT** return sold listings. Verified live: I ran it against a Booli `/sok/slutpriser?areaIds=…` URL — the run *succeeded* but returned **0 items** (`WARN No items on page 1`), because the actor's Playwright parser only understands the active for-sale listing DOM. Its input schema has **no** sold/active toggle. A control run against an active area search returned rich items. So a *different* sold-price source is required. The good news: the same actor returns `latitude`/`longitude` + `breadcrumbs` (area hierarchy) + `booliId` for the listing itself, so we already have precise coordinates and area identity at scrape time — **no geocoding service is needed for AREA-01**, and area-matching for PRICE-01 can be coordinate-based.

**Finding 2 (D-10-RD — SCB + geocoding):** The SCB PxWebApi 2.0 (live as of Oct 2025) is **free, CC0, no auth, no API key**. Verified live: `maxDataCells: 150000`, `30 calls / 10 s` per IP, formats `json-stat2`/`csv`/`px`/`xlsx`. All four required metrics exist at **DeSO level** with confirmed table IDs (population-by-age, income, housing tenure). Because the actor already gives us lat/lng, geocoding collapses to a **point-in-polygon lookup against SCB's free DeSO GeoPackage** (lat/lng → DeSO code → kommun code is the DeSO prefix). Kommun baseline is trivially derivable; DeSO upgrade (D-06) is feasible and free.

**Primary recommendation:** For AREA-01, build the SCB integration now — it is fully de-risked (free, tested, all tables exist). For PRICE-01, the sold-price source is the one real unknown: **plan a Wave-0 feasibility spike** to pick between (a) the **official Booli API** (`booli.se/api/`, requires a free caller-ID + key applied for by email) which historically exposes slutpriser, and (b) a **dedicated sold-prices scraper actor**. Do not assume either works until the spike confirms it. Capture `latitude`, `longitude`, `booliId`, and `breadcrumbs` at scrape time regardless — they are the join key for both panels.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Capture lat/lng + area identity at scrape | API / Backend (server action) | — | Already happens in `analyzeUrl`; just stop discarding the fields the actor returns |
| Fetch comparable sold prices | API / Backend (server-side fetch) | External (Booli API / Apify) | Secrets + cost control + ToS posture must stay server-side |
| Compute ±% vs area, tier, trend, distribution | API / Backend (pure TS, deterministic) | — | D-08-style arithmetic-in-code; never an LLM (mirrors Phase 2 D-08) |
| Resolve lat/lng → DeSO/kommun | API / Backend | — | Point-in-polygon against a bundled GeoPackage; pure compute |
| Fetch SCB demographics | API / Backend (server-side fetch + cache) | External (SCB PxWebApi) | SCB updates yearly → cache aggressively; free but rate-limited |
| Render price + demographics panels | Frontend Server (RSC) | Browser (expand/reveal) | Mirrors `BrfScoreCard`/`BrfSection` server-render + client interactivity split |
| Persist results | Database (Supabase, RLS) | — | New jsonb columns on `analyses`, same RLS pattern as `brf_data` |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `apify-client` | ^2.22.2 (installed) | Booli scraping (active + potentially the sold spike) | Already in repo; `serverExternalPackages` already configured |
| `zod` (via `zod/v4`) | ^4.3.6 (installed) | Validate Booli sold + SCB responses | Project convention; mirror `normalizeScraperOutput` |
| `@anthropic-ai/sdk` | ^0.102.0 (installed) | NOT used this phase | Comparison + confidence are deterministic (D-09 trust model); no LLM |
| Native `fetch` | Node 22 built-in | Call SCB PxWebApi 2.0 | No client lib needed; SCB is plain REST/JSON-stat2 |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@turf/boolean-point-in-polygon` + `@turf/helpers` | latest (see audit) | lat/lng → DeSO polygon lookup | Only if DeSO *upgrade* (D-06) is built; kommun baseline needs no geometry |
| `@ngageoint/geopackage` OR pre-converted GeoJSON | — | Read SCB's DeSO `.gpkg` | Alternative: convert the gpkg → GeoJSON once at build time with `ogr2ogr`/`tippecanoe` and ship JSON, avoiding a runtime gpkg dep entirely (recommended — simpler, no dynamic-require risk) |

**Recommendation on geometry:** Prefer the **build-time conversion** approach — download the DeSO GeoPackage once, convert to a compact GeoJSON (or a kommun-only GeoJSON for the baseline), commit it, and do point-in-polygon with `@turf/boolean-point-in-polygon` (pure JS, no native deps, no `serverExternalPackages` entry). This sidesteps the dynamic-require bundling class of bug that already bit this project twice (apify-client, anthropic-sdk).

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `lexis-solutions/booli-se-scraper` for sold | Official Booli API (`booli.se/api/`) | Legitimate, structured, historically exposes slutpriser — but requires a free key applied for by email + ToU acceptance; status uncertain `[ASSUMED]` |
| Official Booli API | A dedicated "Booli sold prices" Apify actor | No application step, but another paid actor rental (+$/month) and same scraping-grey-zone posture as today |
| Geocoding service (Geoapify/maps.co) | Use actor's `latitude`/`longitude` directly | **No external geocoder needed** — actor already returns coords; only DeSO polygon lookup remains |
| Runtime `.gpkg` reader | Build-time gpkg→GeoJSON conversion | GeoJSON is simpler, no native dep, slightly larger repo file |

**Installation (only if DeSO upgrade is built):**
```bash
npm install @turf/boolean-point-in-polygon @turf/helpers
```
For AREA-01 kommun baseline + SCB fetch + sold-price fetch via existing actor: **no new runtime dependencies** (native fetch + installed apify-client/zod).

**Version verification:** `apify-client@2.22.2`, `zod@4.3.6`, `@anthropic-ai/sdk@0.102.0` confirmed in `package.json`. `@turf/*` to be verified at install time (see audit).

## Package Legitimacy Audit

> slopcheck could not be installed/run in this session (no network pip install attempted to avoid unverified execution). New packages below are therefore tagged `[ASSUMED]` and the planner MUST gate each install behind a `checkpoint:human-verify` task before `npm install`.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| `@turf/boolean-point-in-polygon` | npm | mature (Turf.js, 8+ yrs) | very high | github.com/Turfjs/turf | not run | `[ASSUMED]` — verify before install (only if DeSO upgrade built) |
| `@turf/helpers` | npm | mature | very high | github.com/Turfjs/turf | not run | `[ASSUMED]` — verify before install |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

*Turf.js is a widely-used, well-known geospatial library; the `[ASSUMED]` tag reflects that slopcheck was not run this session, not a suspicion signal. Planner: add a `checkpoint:human-verify` confirming `npm view @turf/boolean-point-in-polygon` shows the Turfjs org before install.*

## Architecture Patterns

### System Architecture Diagram

```
User opens /analysis/[id]
        │
        ▼
  RSC page load ──► read analyses row (listing_data + NEW price_data + area_data jsonb)
        │                                   │
        │                                   ├─ if present → render panels
        │                                   └─ if absent  → render "fetch market context" trigger
        ▼
  Server action: enrichMarketContext(analysisId)   [server-only, deterministic]
        │
        ├──(A) PRICE-01 ─────────────────────────────────────────────┐
        │     listing lat/lng + booliId/breadcrumbs (from scrape)     │
        │             │                                                │
        │             ▼                                                │
        │     Sold-price source (SPIKE: Booli API or sold actor)      │
        │       query by area tier:  building/BRF → neighborhood → wide│
        │             │                                                │
        │             ▼                                                │
        │     normalizeSoldOutput() (Zod, null-tolerant)              │
        │             │                                                │
        │             ▼                                                │
        │     computePriceComparison() PURE TS:                        │
        │       pris/kvm vs area avg → ±% headline (D-04)             │
        │       24-mo trend (D-02), distribution/range, sample size    │
        │       tier used + confidence(sample,tier) (D-09)            │
        │             └──────────────► price_data jsonb               │
        │                                                              │
        └──(B) AREA-01 ──────────────────────────────────────────────┤
              listing lat/lng                                          │
                    │                                                  │
                    ▼                                                  │
              resolveGeo(lat,lng):                                     │
                point-in-polygon → DeSO code (upgrade)                │
                DeSO[0:4] → kommun code (baseline, always)            │
                    │                                                  │
                    ▼                                                  │
              SCB PxWebApi 2.0 (free, cached):                        │
                BE0101Y/FolkmDesoAldKon  (population + age)           │
                HE0110I/Tab*InkDesoRegso (income)                     │
                HE0111YDeSo/HushallT33Deso (tenure mix)              │
                    │                                                  │
                    ▼                                                  │
              normalizeScbOutput() (Zod) → area_data jsonb           │
                                                                       │
        ┌──────────────────────────────────────────────────────────┘
        ▼
  Persist to analyses (RLS), with source+freshness labels (D-09)
        │
        ▼
  Panels re-render: PriceComparisonCard + AreaStatsCard
  (partial-data tolerant: each renders independently — D-08/Success Criterion 3)
```

### Recommended Project Structure
```
src/lib/market/
├── sold-source.ts        # the sold-price fetch (Booli API or actor) — isolate behind one interface
├── sold-schema.ts        # Zod schema + normalizeSoldOutput (mirror listing.ts pattern)
├── compare.ts            # computePriceComparison() — PURE, deterministic (D-04/D-05/D-09)
├── compare.test.ts       # Wave 0 RED tests (mirror brf/score.test.ts)
├── geo.ts                # resolveGeo(lat,lng) → { kommunCode, desoCode|null }
├── geo.test.ts           # point-in-polygon + kommun-prefix tests
├── scb.ts                # SCB PxWebApi client + table query builders
├── scb-schema.ts         # Zod for json-stat2 + normalizeScbOutput
├── scb.test.ts           # parse fixtures, no live calls in CI
└── cost.ts               # per-analysis sold-source cost guard (mirror brf/cost.ts)
src/data/
└── deso.geojson          # build-time converted SCB DeSO polygons (or kommun.geojson for baseline)
src/components/
├── price-comparison-card.tsx   # mirror brf-score-card.tsx visual language
└── area-stats-card.tsx
```

### Pattern 1: Deterministic comparison in code (NOT LLM)
**What:** ±% headline, trend, distribution, tier, confidence are all arithmetic over the sold dataset.
**When to use:** Always — this is the Phase 2 D-08 principle applied to PRICE-01 (CONTEXT D-09 trust model).
```typescript
// Source: mirrors src/lib/brf/score.ts (deterministic core, Wave-0 RED-tested)
// confidence is driven by sample size + tier, NOT model output (CONTEXT D-09)
export function computePriceComparison(input: {
  listingPrisPerKvm: number;
  comps: SoldComp[];      // already filtered to a tier
  tier: "building" | "neighborhood" | "wide";
}): PriceComparison { /* avg, ±%, min–max, trend slope, sampleSize, confidence */ }
```

### Pattern 2: Tiered fallback with explicit tier label (D-01)
**What:** Try building/BRF comps → neighborhood → wide area; record which tier produced the result and show it.
**When to use:** PRICE-01 area matching. Coordinates + `breadcrumbs` from the actor give the area hierarchy to drive tiers.

### Pattern 3: Null-tolerant external normalization (project-established)
**What:** Replicate `normalizeScraperOutput()` for sold-price and SCB responses — every field falls back to null, never throws.
**Source:** `src/lib/schemas/listing.ts`.

### Pattern 4: Persisted-JSONB re-validation before render
**What:** Re-`safeParse` the persisted `price_data`/`area_data` in the RSC before handing to the card; malformed/partial → degrade to "data unavailable" affordance, never crash.
**Source:** `src/app/(app)/analysis/[id]/page.tsx` does exactly this for `brf_data` via `safeParseBrfData`.

### Anti-Patterns to Avoid
- **Letting Claude produce the ±% or the verdict** — violates D-09 trust model; comparison is statistics, not opinion.
- **Calling an external geocoder** — unnecessary; the actor already returns lat/lng. Adds cost + a failure mode.
- **Adding a runtime `.gpkg` reader with dynamic requires** — repeats the Turbopack bundling bug class. Convert to GeoJSON at build time.
- **Blocking the whole panel on rich attributes (floor/balcony/avgift)** — D-03 says pris/kvm is the baseline; rich attrs layer on *if* the source exposes them.
- **Hiding a thin/empty section silently** — D-08 requires an honest "för få försäljningar" marker.
- **Querying SCB per page-view** — SCB data updates yearly; cache by (table, region, year) effectively forever.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Address → coordinates | A geocoder / address parser | Actor's `latitude`/`longitude` (already returned) | Free, exact, no extra API |
| lat/lng → DeSO area | Manual bounding-box math | `@turf/boolean-point-in-polygon` + SCB DeSO GeoPackage | Polygons are irregular; turf is battle-tested |
| Parsing SCB output | Custom px/CSV parser | Request `json-stat2` (or `csv`) from PxWebApi | SCB serves structured formats natively |
| Sold-price acquisition | A from-scratch Booli scraper | Official Booli API or an existing/maintained actor | ToS posture, anti-bot, maintenance burden |
| Trend/regression | A stats library import | A few lines of pure TS (least-squares slope over ≤dozens of points) | Sample is tiny; a dependency is overkill |

**Key insight:** The two hardest-looking sub-problems (geocoding, demographics access) are nearly free here — the actor already hands us coordinates, and SCB is an open no-auth API. The genuine risk concentrates entirely in *sold-price acquisition*, which is why it gets a feasibility spike and everything else can be built straight.

## Runtime State Inventory

> This phase is additive (new panels, new columns) — not a rename/refactor. Inventory included only for the scrape-time capture change.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `analyses.listing_data` jsonb currently **discards** the actor's `latitude`/`longitude`/`booliId`/`breadcrumbs` (only the normalized 8 fields are kept). Existing rows have NO coords. | Code edit: extend `normalizeScraperOutput`/`ListingData` to retain lat/lng + booliId + breadcrumbs going forward. Existing analyses lack coords → must fall back to re-deriving from address or kommun-only, OR re-scrape. Plan a graceful "older analysis, location data limited" path. |
| Live service config | None — no external service stores the renamed/changed string. | None — verified by code read. |
| OS-registered state | None. | None. |
| Secrets/env vars | New: possibly `BOOLI_CALLER_ID` + `BOOLI_API_KEY` (if Booli-API spike wins). `APIFY_API_TOKEN` already present. SCB needs **no** key. | Add env vars only after spike decides the source. |
| Build artifacts | New committed data file: `src/data/deso.geojson` (or `kommun.geojson`) from the one-time gpkg conversion. | Build-time conversion step + commit the artifact. |

**The migration nuance:** retaining lat/lng is a *code edit* (changes how new rows are written). Backfilling coords for *existing* analyses is a separate *data* concern — likely not worth a migration; degrade older rows to kommun-baseline or prompt re-analysis.

## Common Pitfalls

### Pitfall 1: Assuming the existing actor can be coaxed into sold listings
**What goes wrong:** Plan assumes a flag/URL gets slutpriser; build stalls when it returns 0 items.
**Why it happens:** The actor *accepts* a slutpriser URL without erroring — it just yields nothing (verified: `WARN No items on page 1`).
**How to avoid:** Treat sold-price source as an unsolved spike, not a config tweak. Decide source in Wave 0.
**Warning signs:** A run that "succeeds" with an empty dataset.

### Pitfall 2: SCB region codes are not just kommun codes at DeSO level
**What goes wrong:** Querying a DeSO table with a 4-digit kommun code returns nothing/aggregate only.
**Why it happens:** DeSO codes are `{4-digit kommun}{letter}{4-digit}` (e.g. `0180C1010`); the `Region` variable in `BE0101Y/FolkmDesoAldKon` has 19,182 values mixing kommun and DeSO.
**How to avoid:** Resolve the exact DeSO code via polygon lookup; derive kommun as the 4-char prefix. Validate the code exists in the table's `Region` value list before querying.
**Warning signs:** Empty `data` array or HTTP 400 "Bad Request" from PxWebApi (seen this session when a guessed code/variable name was wrong).

### Pitfall 3: Income may not exist at every geography/year you want
**What goes wrong:** Code assumes uniform availability of all four metrics at DeSO for the latest year.
**Why it happens:** Income tables (`HE0110I/Tab*InkDesoRegso`) and tenure (`HE0111YDeSo`) have their own period coverage, distinct from population (2010–2025).
**How to avoid:** Per-metric availability check; fall back to kommun level or omit that metric with an honest marker (D-08). "Kommun-correct beats neighborhood-wrong" (CONTEXT specifics).

### Pitfall 4: SCB rate limit (30 calls / 10 s per IP)
**What goes wrong:** Burst of per-metric, per-region calls trips the limit under concurrent users.
**How to avoid:** Cache by (table, region, year) — SCB updates yearly. Batch metrics into as few queries as the 150k-cell limit allows. A warm cache makes most analyses zero SCB calls.
**Warning signs:** HTTP 429.

### Pitfall 5: Stale/older sales within the 24-mo window read as current
**What goes wrong:** A sale 22 months ago is averaged in flat, distorting the headline in a moving market (D-02).
**How to avoid:** Use the trend slope to caveat older comps, or weight by recency; surface the date range so the user sees it (D-05 distribution + comp list as receipt).

## Code Examples

### SCB PxWebApi 2.0 — config probe (verified live this session)
```bash
# Source: https://api.scb.se/OV0104/v2beta/api/v2/config (no auth)
# Returns: {"apiVersion":"2.2.0","maxDataCells":150000,
#           "maxCallsPerTimeWindow":30,"timeWindow":10,
#           "license":"...cc0...","dataFormats":["json-stat2","csv","px","xlsx","html","json-px"]}
curl -s "https://api.scb.se/OV0104/v2beta/api/v2/config"
```

### SCB v1 table metadata — DeSO population (verified: variables + 19,182 regions)
```bash
# Source: live call this session
# variables: ['Region','Alder','Kon','ContentsCode','Tid']
curl -s "https://api.scb.se/OV0104/v1/doris/en/ssd/START/BE/BE0101/BE0101Y/FolkmDesoAldKon"
```

### SCB data query (POST JSON) — shape to use in scb.ts
```typescript
// Source: PxWebApi query body convention (v1 path shown; v2 has stable TABxxxx ids)
// outputs json-stat2 → normalizeScbOutput parses with Zod
await fetch(
  "https://api.scb.se/OV0104/v1/doris/en/ssd/START/BE/BE0101/BE0101Y/FolkmDesoAldKon",
  { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: [
        { code: "Region", selection: { filter: "item", values: ["0180C1010"] } }, // a DeSO
        { code: "Tid",    selection: { filter: "item", values: ["2025"] } },
      ],
      response: { format: "json-stat2" },
    }) });
```

### Actor returns coordinates + area hierarchy (verified live — active area search)
```jsonc
// Source: live run of bpf1JaYRBbia2nQU9 (lexis-solutions/booli-se-scraper) this session.
// Keys present per item include:
// latitude, longitude, booliId, breadcrumbs, descriptiveAreaName, streetAddress,
// estimate, listSqmPrice, rooms, livingArea, infoPoints, isNewConstruction, propertyType
{ "latitude": 59.3181048, "longitude": 18.04603693,
  "descriptiveAreaName": "Södermalm", "streetAddress": "Ansgariegatan 1",
  "propertyType": "active" }   // NOTE: only "active" — never "sold"
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| SCB PxWebApi 1.0 (v1 path) | PxWebApi 2.0 (`/v2beta/api/v2`, stable TABxxxx ids) | Oct 2025 | Use v2 for stable ids; v1 still works and has the doris SSD paths used above |
| Geocode address via 3rd-party | Use actor's lat/lng directly | n/a (already in actor output) | Removes a whole external dependency from AREA-01 |

**Deprecated/outdated:**
- The assumption (from CONTEXT D-09-RD) that we store "NO coordinates" — **outdated**: the actor *returns* lat/lng; we simply discard them today. The fix is to retain, not to geocode.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The **official Booli API** (`booli.se/api/`, caller-ID+key by application) still exists and exposes slutpriser with sale date/price/area | Standard Stack / Alternatives | HIGH — it's the cleanest sold-price path; if dead or key not granted, must fall to a paid sold-prices actor. **De-risk in Wave-0 spike.** |
| A2 | A dedicated "Booli sold-prices" Apify actor exists and works as a fallback | Alternatives | MEDIUM — fallback for A1; cost (+monthly rental) and ToS posture to confirm in spike |
| A3 | SCB DeSO income table `HE0110I/Tab*InkDesoRegso` and tenure `HE0111YDeSo/HushallT33Deso` are queryable at DeSO for a recent year | SCB tables | MEDIUM — table *existence* confirmed via SCB docs; exact DeSO availability/year per table needs a live query during build (population table fully verified live) |
| A4 | SCB ships a free DeSO GeoPackage suitable for build-time GeoJSON conversion | Geometry | LOW — confirmed via SCB open-geodata + a community repo; format details to confirm at conversion time |
| A5 | Turf.js point-in-polygon is accurate enough for DeSO assignment | Geometry | LOW — standard use; edge cases only at polygon borders (rare, and kommun baseline covers it) |
| A6 | Sold-price source exposes enough per-sale attrs (date, pris/kvm at minimum) for the comp list "receipt" (D-05) | PRICE-01 | MEDIUM — date + price + area is the minimum; floor/balcony/avgift are bonus per D-03. Confirm in spike. |

## Open Questions (RESOLVED)

> All three are operationally resolved in the Phase 3 plans: Q1 → Wave-0 spike in 03-01 T1 gates PRICE-01 display (Plan 04 `depends_on: 03-01`); Q2 → D-03 pris/kvm-first matching with rich attrs optional (Plan 04); Q3 → no backfill, degrade old rows to kommun-baseline (Plan 05 T1).

1. **Which sold-price source wins?**
   - Known: existing actor cannot do it (verified). Official Booli API and a sold-prices actor are the two candidates.
   - Unclear: Booli API key-grant status/turnaround; exact slutpris fields; per-query cost of the actor option.
   - Recommendation: **Wave-0 feasibility spike** — attempt Booli API key registration AND test one sold-prices actor run; pick based on what returns real slutpriser within budget. Gate planning of PRICE-01 display on the spike result.

2. **Per-sale attribute richness (D-03 floor/balcony/avgift)?**
   - Known: pris/kvm + date + area is the floor; the actor's active items expose `infoPoints` (floor) and `amenities` (balcony/elevator) — a sold source *may* too.
   - Recommendation: build matching on pris/kvm first; layer richer attrs only where the chosen source provides them. Don't block (D-03).

3. **Backfill coords for existing analyses?**
   - Known: existing rows lack lat/lng.
   - Recommendation: don't migrate; degrade old analyses to kommun-baseline demographics + "begränsad platsdata" note, or offer re-analysis.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Apify (actor `bpf1JaYRBbia2nQU9`) | listing scrape + sold spike | ✓ (verified live, paid plan active) | actor build `latest` | — |
| `APIFY_API_TOKEN` | Apify calls | ✓ (in `.env.local`, 46 chars) | — | — |
| SCB PxWebApi 2.0 | AREA-01 | ✓ (verified live, no auth) | apiVersion 2.2.0 | v1 doris SSD paths also live |
| SCB DeSO GeoPackage | DeSO upgrade only | ✓ (free download per SCB open-geodata) `[ASSUMED format]` | — | kommun-baseline needs no geometry |
| `ogr2ogr` / GDAL (build-time gpkg→GeoJSON) | one-time conversion | ✗ (not checked on dev machine) | — | Use SCB's GeoJSON export if offered, or convert via an online tool once |
| Official Booli API | sold spike (path A) | ? unknown (application required) | — | sold-prices Apify actor (path B) |
| `@turf/*` | DeSO point-in-polygon | ✗ (not installed) | — | install after human-verify (audit) |

**Missing dependencies with no fallback:** none that block the phase — AREA-01 is fully unblocked; PRICE-01's only blocker (sold source) has two candidate paths.
**Missing dependencies with fallback:** sold source (Booli API → sold actor); GDAL (→ SCB GeoJSON export or one-time online conversion); turf (→ kommun baseline without DeSO upgrade).

## Validation Architecture

> nyquist_validation is enabled (config `workflow.nyquist_validation: true`). Mirror Phase 2's Wave-0 RED-first deterministic-core testing.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.8 (installed, configured) |
| Config file | `vitest.config.ts` (node env, `globals: true`, `@`→`./src` alias) |
| Quick run command | `npx vitest run src/lib/market` |
| Full suite command | `npm test` (`vitest run`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PRICE-01 | ±% vs area pris/kvm headline correct (D-04) | unit | `npx vitest run src/lib/market/compare.test.ts` | ❌ Wave 0 |
| PRICE-01 | tiered fallback picks correct tier + labels it (D-01) | unit | `npx vitest run src/lib/market/compare.test.ts` | ❌ Wave 0 |
| PRICE-01 | confidence driven by sample size + tier (D-09) | unit | `npx vitest run src/lib/market/compare.test.ts` | ❌ Wave 0 |
| PRICE-01 | 24-mo trend slope + distribution/range (D-02/D-05) | unit | `npx vitest run src/lib/market/compare.test.ts` | ❌ Wave 0 |
| PRICE-01 | thin data (≤2 comps) → honest marker, never crash (D-08) | unit | `npx vitest run src/lib/market/compare.test.ts` | ❌ Wave 0 |
| AREA-01 | lat/lng → correct DeSO code; kommun = prefix | unit | `npx vitest run src/lib/market/geo.test.ts` | ❌ Wave 0 |
| AREA-01 | json-stat2 → normalized four metrics (fixture) | unit | `npx vitest run src/lib/market/scb.test.ts` | ❌ Wave 0 |
| AREA-01 | metric absent at DeSO → kommun fallback / omit (D-06/D-08) | unit | `npx vitest run src/lib/market/scb.test.ts` | ❌ Wave 0 |
| Both | malformed persisted jsonb → degrade, not crash (Success Criterion 3) | unit | `npx vitest run src/lib/market` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run src/lib/market`
- **Per wave merge:** `npm test`
- **Phase gate:** full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/lib/market/compare.test.ts` — PRICE-01 deterministic core (RED first)
- [ ] `src/lib/market/geo.test.ts` — point-in-polygon + kommun-prefix
- [ ] `src/lib/market/scb.test.ts` — json-stat2 parsing fixtures (no live calls in CI)
- [ ] Test fixtures: a captured SCB json-stat2 response + a captured sold-comps payload (record once from the spike)
- [ ] **Feasibility spike (not a test, but Wave-0 gate):** confirm a working sold-price source before PRICE-01 display is planned

## Security Domain

> `security_enforcement` not set in config → treat as enabled.

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no (panels readable; reuse existing auth) | existing Supabase auth |
| V3 Session Management | no | existing |
| V4 Access Control | yes | `analyses` RLS must cover new `price_data`/`area_data` columns (same pattern as `brf_data`); the existing UPDATE policy from `002_brf.sql` already enables server-action writes |
| V5 Input Validation | yes | Zod (`zod/v4`) on Booli sold + SCB responses; validate DeSO `Region` code against the table's value list before query |
| V6 Cryptography | no (no new secrets crypto) | secrets in env only |

### Known Threat Patterns for this stack
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SSRF via attacker-influenced area/URL into Apify/SCB | Tampering | Build SCB/Booli queries server-side from validated lat/lng + whitelisted table ids; never pass user free-text into the URL |
| Cost-bomb (per-analysis sold-source spend) | DoS / financial | `cost.ts` guard mirroring `brf/cost.ts`; cap + refuse to persist over budget; cache SCB |
| Leaking another user's market data | Info disclosure | RLS on new columns (V4); re-validate persisted jsonb before render |
| Secret leakage (`BOOLI_API_KEY`) | Info disclosure | server-only (`serverExternalPackages`/server action); never `NEXT_PUBLIC_` |
| Injection into SCB query body | Tampering | parameterized query objects (not string concat); validate region/year against metadata |

## Sources

### Primary (HIGH confidence — live-tested this session)
- Apify run `2aDExm5qkLZ3pBZEP` (actor `bpf1JaYRBbia2nQU9` vs slutpriser URL) → **0 items**, log `WARN No items on page 1` — proves actor cannot scrape sold.
- Apify run `WuqfWgT2Tdjb6STZT` (control, active area search) → 2 items with `latitude`/`longitude`/`booliId`/`breadcrumbs` — proves coords available.
- Actor input schema via `api.apify.com/v2/acts/bpf1JaYRBbia2nQU9/builds/default` → no sold/active toggle.
- `https://api.scb.se/OV0104/v2beta/api/v2/config` → free CC0, 30/10s, 150k cells, json-stat2/csv/xlsx (live).
- `https://api.scb.se/OV0104/v1/doris/en/ssd/START/BE/BE0101/BE0101Y/FolkmDesoAldKon` → variables + 19,182 regions (live).
- `https://api.scb.se/OV0104/v1/doris/en/ssd/START/HE/HE0110/HE0110A/SamForvInk1` → kommun region codes (live).
- Codebase: `src/lib/schemas/listing.ts`, `src/actions/analyze.ts`, `src/lib/apify/booli-scraper.ts`, `src/lib/brf/*`, `src/app/(app)/analysis/[id]/page.tsx`, `supabase/migrations/002_brf.sql`, `next.config.ts`, `package.json`, `.planning/config.json`.

### Secondary (MEDIUM confidence)
- SCB DeSO tables doc (`scb.se/.../deso-tabellerna-i-ssd...`) → income `HE0110I/Tab*InkDesoRegso`, tenure `HE0111YDeSo/HushallT33Deso`, population `BE0101Y/FolkmDesoAldKon`.
- `apify.com/lexis-solutions/booli-se-scraper` (+ input-schema) → fields, pricing `$29/month + usage`.
- SCB PxWebApi page (`scb.se/en/services/open-data-api/pxwebapi/`) → v2.0 launched Oct 2025.

### Tertiary (LOW confidence — flagged for spike)
- Official Booli API existence/slutpris support (`booli.se/api/`, caller-ID+key) — multiple community wrappers reference it; current status unverified.
- `github.com/olif/bopriskartan`, `github.com/filipsalo/booliapi` — Booli API returns sold data historically (auth required).
- SCB DeSO GeoPackage availability (community repo `adamstj/scb-api-examples`).

## Metadata

**Confidence breakdown:**
- Sold-price feasibility (negative finding on existing actor): **HIGH** — live-tested, reproducible.
- Sold-price *recommended path*: **MEDIUM** — two viable candidates, neither fully confirmed in-session; spike required.
- SCB demographics (AREA-01): **HIGH** — free API + all four metrics' tables confirmed, population verified live.
- Geocoding (lat/lng available, DeSO via polygon): **HIGH** that coords exist; **MEDIUM** on gpkg conversion mechanics.
- Architecture/patterns: **HIGH** — directly mirror established Phase 2 deterministic-core + RSC + RLS patterns.

**Research date:** 2026-06-17
**Valid until:** ~2026-07-17 (SCB stable; Booli/Apify scraping surface is fast-moving — re-verify the sold-price spike findings if execution slips past a month)

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PRICE-01 | Compare listing price vs recently sold properties in same area/building (pris/kvm vs area avg, trend, sample size) | Existing actor CANNOT supply sold data (verified) → sold-source spike (Booli API or sold actor). Coordinates + breadcrumbs from scrape drive tiered area matching (D-01). Comparison is deterministic TS (compare.ts), Wave-0 RED-tested, mirroring brf/score.ts. |
| AREA-01 | SCB demographics for the listing's neighborhood (income, population trends) | Fully de-risked: SCB PxWebApi 2.0 free/no-auth (verified live). DeSO tables confirmed — population `BE0101Y/FolkmDesoAldKon` (verified), income `HE0110I/Tab*InkDesoRegso`, tenure `HE0111YDeSo`. lat/lng from actor → DeSO via turf point-in-polygon; kommun baseline = DeSO prefix (D-06). |
</phase_requirements>
