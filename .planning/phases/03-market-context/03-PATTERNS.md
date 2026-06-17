# Phase 3: Market Context - Pattern Map

**Mapped:** 2026-06-17
**Files analyzed:** 16 new/modified
**Analogs found:** 16 / 16 (every new file has a strong Phase 1/2 analog in-repo)

> The whole phase is *additive* and deliberately mirrors the Phase 2 BRF stack: deterministic-core (`compute*` pure TS) + null-tolerant Zod normalization + RSC server-render with a client interactivity split + new jsonb columns under the existing RLS pattern. There is **no new architectural shape** to invent — copy the BRF analogs.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/lib/market/sold-source.ts` | service (external client) | request-response (fetch) | `src/lib/apify/booli-scraper.ts` | exact |
| `src/lib/market/sold-schema.ts` | schema/model | transform (normalize) | `src/lib/schemas/listing.ts` | exact |
| `src/lib/market/compare.ts` | utility (deterministic core) | transform (pure compute) | `src/lib/brf/score.ts` | exact |
| `src/lib/market/compare.test.ts` | test | unit | `src/lib/brf/score.test.ts` / `cost.test.ts` | exact |
| `src/lib/market/geo.ts` | utility (deterministic core) | transform (point-in-polygon) | `src/lib/brf/score.ts` (pure-fn shape) | role-match |
| `src/lib/market/geo.test.ts` | test | unit | `src/lib/brf/cost.test.ts` | role-match |
| `src/lib/market/scb.ts` | service (external client) | request-response (fetch + cache) | `src/lib/apify/booli-scraper.ts` | role-match |
| `src/lib/market/scb-schema.ts` | schema/model | transform (normalize) | `src/lib/schemas/listing.ts` + `brf.ts` (`safeParse*`) | exact |
| `src/lib/market/scb.test.ts` | test | unit (fixtures) | `src/lib/brf/score.test.ts` | role-match |
| `src/lib/market/cost.ts` | utility (cost guard) | transform (pure compute) | `src/lib/brf/cost.ts` | exact |
| `src/data/deso.geojson` (or `kommun.geojson`) | config/data artifact | file-I/O (build-time) | *(none — see No Analog)* | none |
| `src/actions/enrich-market-context.ts` | controller (server action) | request-response (orchestration) | `src/actions/analyze-brf.ts` | exact |
| `src/components/price-comparison-card.tsx` | component | request-response (RSC render + client reveal) | `src/components/brf-score-card.tsx` | exact |
| `src/components/area-stats-card.tsx` | component | request-response (render) | `src/components/brf-score-card.tsx` / `listing-summary.tsx` | exact |
| `src/app/(app)/analysis/[id]/page.tsx` (MODIFY) | route (RSC) | request-response | itself (replace 2 `ComingSoonSection`) | exact |
| `supabase/migrations/003_market_context.sql` (NEW) | migration | — | `supabase/migrations/002_brf.sql` | exact |
| `src/lib/schemas/listing.ts` (MODIFY) | schema/model | transform | itself (retain lat/lng/booliId/breadcrumbs) | exact |
| `next.config.ts` (MODIFY, conditional) | config | — | itself (`serverExternalPackages`) | exact |

---

## Pattern Assignments

### `src/lib/market/compare.ts` (utility, deterministic core)

**Analog:** `src/lib/brf/score.ts` — the canonical "trust core" pattern. Copy its structure exactly: a single exported `THRESHOLDS`/config const, small per-input scoring helpers, one pure exported entry function, an auditable result interface. No `Date`/`Math.random`/network — same input → same output (the D-09 trust model = Phase 2 D-08).

**Config-const pattern** (`score.ts:25-57`): export one named const holding every weight/band so the methodology page can import the exact numbers — do NOT duplicate thresholds inline. Mirror for confidence bands (sample-size + tier → confidence).

**Pure-function + null-tolerant contribution pattern** (`score.ts:162-220`): a `null` metric is "not assessable" — its contribution is 0 but it is still represented in the breakdown, never silently dropped. Apply to thin-data: ≤2 comps → honest marker in the result, never a throw (D-08).

**Entry signature to build** (RESEARCH §Pattern 1, lines 161-166):
```typescript
export function computePriceComparison(input: {
  listingPrisPerKvm: number;
  comps: SoldComp[];                 // already filtered to a tier
  tier: "building" | "neighborhood" | "wide";
}): PriceComparison // { areaAvg, deltaPct, min, max, trendSlope, sampleSize, tier, confidence }
```
Headline = ±% vs area pris/kvm (D-04); 24-mo trend = least-squares slope in a few lines of pure TS, NOT a stats dependency (RESEARCH "Don't Hand-Roll"); confidence driven by sampleSize + tier (D-09).

---

### `src/lib/market/cost.ts` (utility, cost guard)

**Analog:** `src/lib/brf/cost.ts` (whole file, 1-57). Copy the shape: published-rate const (`USD_PER_MTOK`), an FX const (`USD_SEK_RATE = 11`), a pure `costSek(usage)` function. For the sold-source-actor path, replace token rates with per-query Apify cost; expose a pure function the server action calls before persisting (mirrors the `analyze-brf.ts` `COST_CAP_SEK` gate at lines 18-19, 250-256). Test alongside per `cost.test.ts`.

---

### `src/lib/market/sold-source.ts` (service, external client)

**Analog:** `src/lib/apify/booli-scraper.ts` (whole file, 1-45).

**Client + call pattern** (`booli-scraper.ts:1-34`): module-level `new ApifyClient({ token: process.env.APIFY_API_TOKEN! })`, `client.actor(ID).call({...input, proxyConfiguration: { useApifyProxy, apifyProxyGroups:["RESIDENTIAL"], apifyProxyCountry:"SE" }}, { waitSecs })`, then `client.dataset(run.defaultDatasetId).listItems()`.

**Error pattern** (`booli-scraper.ts:35-44`): `console.error("[tag]", error)` server-side first, then throw a **Swedish** user-facing message; never leak the raw error. Reuse verbatim tone.

> **SPIKE GATE (RESEARCH Open Q1 / Wave-0):** the existing actor `bpf1JaYRBbia2nQU9` CANNOT return sold listings (verified: 0 items). Isolate the sold fetch behind ONE interface here; the planner's Wave-0 spike decides Booli API vs a sold-prices actor before the display is locked. If Booli-API path wins → server-only secret `BOOLI_API_KEY`/`BOOLI_CALLER_ID` via native `fetch`, never `NEXT_PUBLIC_`.

---

### `src/lib/market/sold-schema.ts` & `src/lib/market/scb-schema.ts` (schema/model)

**Analog:** `src/lib/schemas/listing.ts` (1-87) + `src/lib/schemas/brf.ts` `safeParseBrfData` (165-169) and `normalizeBrfExtraction` (179-193).

**Import + version pattern** (`listing.ts:1`): `import { z } from "zod/v4";` (project convention — always the `zod/v4` path).

**Raw-actor schema pattern** (`listing.ts:15-30`): a permissive `.passthrough()` schema for the external payload so extra fields never break parsing; a strict internal model schema alongside.

**Null-tolerant normalize pattern** (`listing.ts:64-86`): local `num`/`str`/`rawOf` coercion helpers, every field falls back to `null`, never throws (RESEARCH Pattern 3). Replicate for `normalizeSoldOutput` and `normalizeScbOutput` (json-stat2 → four metrics).

**Read-path guard pattern** (`brf.ts:135-169`): define a `*DataSchema` for the persisted jsonb and a `safeParse*` returning `T | null` — malformed/shape-drifted row → `null` → UI degrades. Build `safeParsePriceData` / `safeParseAreaData` (RESEARCH Pattern 4; used by the RSC page below).

---

### `src/lib/market/geo.ts` (utility, point-in-polygon)

**Analog:** pure-function shape of `src/lib/brf/score.ts`. `resolveGeo(lat,lng): { kommunCode: string; desoCode: string | null }`. Kommun baseline = first 4 chars of the DeSO code (always derivable). DeSO upgrade via `@turf/boolean-point-in-polygon` against the bundled GeoJSON. Validate the resolved `Region` code exists in the SCB table's value list before querying (RESEARCH Pitfall 2). Keep it pure (no fetch) so it is unit-testable with fixtures. `@turf/*` install is gated behind a `checkpoint:human-verify` (RESEARCH audit).

---

### `src/lib/market/scb.ts` (service, external fetch + cache)

**Analog:** `booli-scraper.ts` error/tag pattern + native `fetch`. POST json-stat2 query to PxWebApi (RESEARCH Code Examples, lines 261-274). Build query objects **server-side from validated lat/lng + whitelisted table ids** — never string-concat user free-text into the URL (RESEARCH Security: SSRF). Cache by `(table, region, year)` — SCB updates yearly; warm cache → zero calls; respect 30 calls/10s (Pitfall 4). No API key, no auth.

---

### `src/actions/enrich-market-context.ts` (controller, server action)

**Analog:** `src/actions/analyze-brf.ts` (whole file is the template, esp. 155-319).

**Header + imports** (`analyze-brf.ts:1-16`): `"use server";`, `createClient` from `@/lib/supabase/server`, import the deterministic compute + schema modules.

**Discriminated result + cap const** (`analyze-brf.ts:18-19, 36-39`): `COST_CAP_SEK` const; `type Result = { ok:true; data } | { ok:false; error }`.

**Auth + ownership gate** (`analyze-brf.ts:175-193`): `supabase.auth.getUser()` → Swedish error if no user; then `select(...).eq("id", analysisId).single()` and check `row.user_id === user.id` (second layer behind RLS).

**Cost-gate-before-persist pattern** (`analyze-brf.ts:250-256`): compute cost via `market/cost.ts`, refuse to persist if over budget, write a terminal failed status.

**Persist pattern** (`analyze-brf.ts:303-318`): `.update({ price_data, area_data, market_status: "done", ... }).eq("id", analysisId)`; check `persistError`. Mirror the `writeFailedStatus` helper (82-100) for observable failure. Each panel (price / area) must persist independently so one source failing does not blank the other (D-08, Success Criterion 3).

**Deterministic-pipeline-only re-score precedent** (`analyze-brf.ts:330-444` `correctBrfField`): never re-call the expensive external source on a re-run — relevant if a "refresh" affordance is added.

---

### `src/components/price-comparison-card.tsx` & `area-stats-card.tsx` (components)

**Analog:** `src/components/brf-score-card.tsx` (visual language + confidence/source-reveal) and `src/components/listing-summary.tsx` (metric-card grid).

**Metric-card pattern** (`listing-summary.tsx:11-32`): `rounded-lg bg-warm-gray-50 p-4`, uppercase tracked label, value or italic "Ej tillganglig" when missing. Reuse for the four demographics metrics and the comp figures.

**Headline-banner + caption pattern** (`brf-score-card.tsx:204-221`): big colour-coded value box + a one-line Swedish caption. Reuse for the ±% headline (D-04): sage when below area avg, terracotta when above, framed as a statistical comparison not a verdict.

**Warm-palette rating colours** (`brf-score-card.tsx:59-106`): A/B sage, C/D terracotta, E/F destructive. Map confidence (low sample/wide tier) onto the same band language.

**Confidence + source-reveal pattern** (`brf-score-card.tsx:267-315`): a confidence `Badge` (`"Osäker — kontrollera själv"` below threshold) plus a `<details>`/`<summary>` "Visa källa" reveal with a `<blockquote>`. Reuse for: the source+freshness label ("Källa: SCB" / "Källa: Booli, sålda bostäder") and the comparable-sales list as the expandable "receipt" (D-05/D-09).

**Methodology link footer** (`brf-score-card.tsx:372-380`): "Beräknas i kod …" + link to `/sa-raknar-vi`. Add the **"ej värdering" disclaimer** here: "Detta är en statistisk jämförelse, inte en värdering eller finansiell rådgivning" (D-09).

> Server/client split (RESEARCH Responsibility Map): card renders in the RSC; only the expand/reveal needs `"use client"`. `brf-score-card.tsx` is fully client because of inline editing — these cards need far less interactivity, so prefer a server card with a small client reveal sub-component.

---

### `src/app/(app)/analysis/[id]/page.tsx` (MODIFY, route)

**Self-analog** (current 1-68). At line 39 it already does `safeParseBrfData(analysis.brf_data)` — the exact read-path-revalidation pattern (Pattern 4). Add `safeParsePriceData(analysis.price_data)` and `safeParseAreaData(analysis.area_data)`. Replace the two placeholders at **lines 62-63** (`<ComingSoonSection title="Prisjamforelse" />` and `title="Omradesstatistik"`) with the two new cards. Keep `AI Rapport` ComingSoon (Phase 4). Each card renders independently and degrades to its own "data unavailable / fetch" affordance on `null` (D-08).

---

### `supabase/migrations/003_market_context.sql` (NEW, migration)

**Analog:** `supabase/migrations/002_brf.sql` (whole file). Copy the additive-column idiom: `alter table public.analyses add column if not exists price_data jsonb;`, `area_data jsonb`, plus status/freshness columns (e.g. `market_status text`, `market_source text`, `market_cost_sek numeric`) mirroring `002_brf.sql:11-15`.

**RLS note (V4):** the `"Users can update own analyses"` UPDATE policy already exists from `002_brf.sql:20-23` — the new columns are covered by it and the existing SELECT policy (`001_analyses.sql:20-26`). Do NOT re-create the UPDATE policy (it will error on a second `create policy`). No new bucket needed (no file upload this phase).

---

### `src/lib/schemas/listing.ts` (MODIFY, schema/model)

**Self-analog.** The actor already returns `latitude`/`longitude`/`booliId`/`breadcrumbs` but `normalizeScraperOutput` (64-86) discards them. Extend `NormalizedListing` (49-58), `listingDataSchema` (33-43) and the normalize body to RETAIN these — they are the join key for both panels (RESEARCH Finding 1, Runtime State Inventory). This is a code edit affecting only NEW rows; existing rows lack coords → planner adds a graceful kommun-only / "begränsad platsdata" degrade path (no backfill migration).

---

## Shared Patterns

### Deterministic-in-code (NOT LLM)
**Source:** `src/lib/brf/score.ts:147-220` (pure fn, null-tolerant, config-const).
**Apply to:** `compare.ts`, `geo.ts`, `cost.ts`. The ±%, trend, distribution, tier label, and confidence are arithmetic — never Claude output (D-09 trust model; RESEARCH Anti-Pattern). `@anthropic-ai/sdk` is NOT used this phase.

### Null-tolerant external normalization
**Source:** `src/lib/schemas/listing.ts:64-86`; `import { z } from "zod/v4"` (line 1).
**Apply to:** `sold-schema.ts`, `scb-schema.ts`. Every field → `null` fallback; `.passthrough()` raw schemas; never throw on partial external data.

### Persisted-jsonb read-path revalidation
**Source:** `src/lib/schemas/brf.ts:135-169` (`brfDataSchema` + `safeParseBrfData`); consumed in `page.tsx:39`.
**Apply to:** `safeParsePriceData` / `safeParseAreaData` and the RSC page. Malformed/shape-drift → `null` → degrade, never crash (CR-01, Success Criterion 3).

### Server-action spine (auth → ownership → external → compute → persist)
**Source:** `src/actions/analyze-brf.ts:155-319` (`"use server"`, `getUser` gate 175-193, cost gate 250-256, persist 303-318, `writeFailedStatus` 82-100).
**Apply to:** `enrich-market-context.ts`.

### Cost guard
**Source:** `src/lib/brf/cost.ts` (pure `costSek`) + `analyze-brf.ts:18-19,250-256` (`COST_CAP_SEK`, refuse-to-persist-over-budget).
**Apply to:** `market/cost.ts` for the sold-source path (SSRF + cost-bomb mitigations, RESEARCH Security).

### Warm-palette + Swedish-UI / English-code + partial-data markers
**Source:** `brf-score-card.tsx:59-106` (sage/terracotta bands), `listing-summary.tsx:25-29` ("Ej tillganglig"), `brf-score-card.tsx:276-279` ("Osäker — kontrollera själv").
**Apply to:** both new cards. Light mode only.

### Vitest RED-first deterministic-core tests
**Source:** `src/lib/brf/score.test.ts` / `cost.test.ts:1-40` (`@/` alias, `describe/it/expect`, fixtures, no live calls).
**Apply to:** `compare.test.ts`, `geo.test.ts`, `scb.test.ts`. Run `npx vitest run src/lib/market`. Capture one SCB json-stat2 + one sold-comps fixture during the spike (RESEARCH Wave 0 Gaps).

### serverExternalPackages (dynamic-require guard)
**Source:** `next.config.ts:7` (`["apify-client", "@anthropic-ai/sdk"]`).
**Apply to:** add an entry ONLY if a runtime package with dynamic requires is introduced. RESEARCH explicitly recommends build-time gpkg→GeoJSON + pure-JS `@turf/*` to AVOID needing a new entry (don't add a runtime `.gpkg` reader).

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src/data/deso.geojson` (or `kommun.geojson`) | data artifact | build-time file-I/O | No bundled geodata / build-time conversion artifact exists in the repo yet. Planner: one-time `ogr2ogr` (or SCB GeoJSON export / online conversion) → commit the file. GDAL availability unverified on dev machine (RESEARCH Environment) — gate behind a checkpoint. Only needed if the DeSO upgrade (D-06) is built; kommun baseline needs no geometry. |

---

## Metadata

**Analog search scope:** `src/lib/`, `src/actions/`, `src/components/`, `src/app/(app)/analysis/`, `supabase/migrations/`, `next.config.ts`.
**Files scanned:** booli-scraper.ts, schemas/listing.ts, schemas/brf.ts, brf/score.ts, brf/cost.ts, brf/cost.test.ts, actions/analyze.ts, actions/analyze-brf.ts, components/brf-score-card.tsx, brf-section.tsx, listing-summary.tsx, coming-soon-section.tsx, analysis/[id]/page.tsx, migrations 001/002, next.config.ts.
**No `./CLAUDE.md` and no `.claude/skills` or `.agents/skills` present** — project conventions inferred from code + RESEARCH (Swedish UI / English code, `zod/v4`, warm palette, deterministic core, RLS-per-user jsonb).
**Pattern extraction date:** 2026-06-17
