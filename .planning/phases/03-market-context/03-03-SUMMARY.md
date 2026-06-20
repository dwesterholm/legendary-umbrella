---
phase: 03-market-context
plan: 03
subsystem: market
tags: [scb, deso, geo, turf, point-in-polygon, json-stat2, pxwebapi, zod, vitest, tdd, area-01]

# Dependency graph
requires:
  - phase: 03-market-context
    provides: "Plan 01 RED contracts geo.test.ts + scb.test.ts; scb-population.json json-stat2 fixture; 03-SPIKE.md SCB DeSO-availability probe; listing.ts latitude/longitude join key"
  - phase: 02-brf-analysis
    provides: "score.ts pure-function shape; brf.ts safeParseBrfData read-guard precedent; zod/v4 import path"
provides:
  - "resolveGeo(lat,lng): { kommunCode, desoCode } — pure @turf point-in-polygon against bundled SCB DeSO_2025 polygons; AREA-01 ships at DeSO (neighborhood) precision, the D-06 upgrade (NOT the kommun fallback)"
  - "fetchScbDemographics(geo): no-auth SSRF-safe SCB PxWebApi client querying population/income/tenure at DeSO, each at its own latest year (income 2024 lags population/tenure 2025)"
  - "normalizeScbOutput — null-tolerant json-stat2 → { population, age, income, tenure }; absent metric → null, never throws (D-08)"
  - "areaDataSchema + safeParseAreaData — persisted area_data shape (the durable cache of record) + defensive read guard"
  - "src/data/deso.geojson — 6160 SCB DeSO_2025 polygons (desokod+kommunkod, WGS84, 4.90 MB simplified)"
affects: [03-methodology (Plan 05 orchestrates + persists area_data), 03-wiring (Plan 06 area panel render), 04-area-stats]

# Tech tracking
tech-stack:
  added:
    - "@turf/boolean-point-in-polygon@7.3.5"
    - "@turf/helpers@7.3.5"
  patterns:
    - "Build-time GeoJSON artifact (SCB WFS → simplified WGS84) read once via fs at module init — server-side, kept out of any client bundle, deterministic"
    - "No-auth SSRF-safe external fetch: query body assembled server-side from validated region codes + whitelisted table ids, never user free-text"
    - "Persisted column as the durable cache of record (cold-start-proof), module memory is convenience-only"

key-files:
  created:
    - src/lib/market/geo.ts
    - src/lib/market/scb.ts
    - src/lib/market/scb-schema.ts
    - src/data/deso.geojson
  modified:
    - src/lib/market/geo.test.ts
    - package.json
    - package-lock.json

key-decisions:
  - "Sourced DeSO geometry from geodata.scb.se GeoServer WFS (stat:DeSO_2025) as GeoJSON reprojected to EPSG:4326 — GDAL/ogr2ogr absent on this machine, so no .gpkg reader path was needed"
  - "Simplified with mapshaper (installed to an isolated /tmp prefix, NOT added to package.json — it is a one-time build tool, not a runtime dep) at 8% keep-shapes + precision 0.00001 → 4.90 MB (under the ~5 MB budget)"
  - "AREA-01 ships at DeSO (neighborhood) precision — the D-06 upgrade, not the honest kommun fallback"
  - "Corrected geo.test.ts: the RED test guessed DeSO 0180C1010 for central Stockholm (59.3293,18.0686), but real SCB geometry places that point in 0180C4040; re-pinned the inside-polygon case to a verified-real coordinate (59.233,18.11 → 0180C1010) — behavior under test unchanged"
  - "area_data column is the durable cache of record (Plan 05 writes once; page reads without re-calling SCB); module memory is not the correctness mechanism (T-03-08)"

patterns-established:
  - "WFS-sourced + mapshaper-simplified GeoJSON artifact under a committed size budget, read via fs"
  - "Per-metric latest-year tracking (income lags population/tenure) carried in the persisted years map"

requirements-completed: [AREA-01]

# Metrics
duration: ~20min
completed: 2026-06-20
---

# Phase 3 Plan 03: AREA-01 Deterministic Core (geo + SCB) Summary

**resolveGeo resolves a listing's lat/lng to SCB DeSO + kommun via @turf point-in-polygon against a 4.90 MB build-time SCB DeSO_2025 artifact, and fetchScbDemographics pulls population/income/tenure from the free no-auth SCB PxWebApi with null-tolerant json-stat2 normalization — AREA-01 ships at DeSO (neighborhood) precision.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-06-20T19:18Z
- **Completed:** 2026-06-20T19:25Z
- **Tasks:** 3 completed
- **Files modified:** 7 (4 created, 3 modified)

## Accomplishments

### Task 1 — @turf legitimacy gate + DeSO geo artifact

- **Legitimacy gate (APPROVED):** `npm view` confirmed both `@turf/boolean-point-in-polygon` and `@turf/helpers` are genuine Turf.js v7.3.5 — repository `github.com/Turfjs/turf`, Turfjs maintainer org (rowanwins, tmcw, morganherlocker, …). Installed.
- **next.config.ts UNCHANGED** — @turf is pure JS; `serverExternalPackages` stays `["apify-client", "@anthropic-ai/sdk"]` (no dynamic-require dep introduced).
- **ogr2ogr/GDAL checked FIRST:** absent on this machine (`which ogr2ogr` → not found). Global mapshaper also not cached, and `npx --yes` auto-download is prohibited.
- **Geo artifact — DeSO precision (the D-06 upgrade, NOT the kommun fallback):**
  - **Source:** SCB GeoServer WFS at `https://geodata.scb.se/geoserver/stat/ows`, layer `stat:DeSO_2025`. WFS `GetFeature` with `outputFormat=application/json&srsName=EPSG:4326&propertyName=desokod,kommunkod,sp_geometry` returned the full 6160-feature DeSO set, reprojected to WGS84 server-side. Raw download ≈ **58 MB**.
  - **Conversion:** mapshaper 0.7.29 (installed to an isolated `/tmp` prefix — NOT added to `package.json`; it is a one-time build tool) with `-filter-fields desokod,kommunkod -simplify 8% keep-shapes -o precision=0.00001 format=geojson`. Result: **4.90 MB**, within the ~5 MB budget. 21 self-intersections auto-repaired.
  - **Verification:** valid GeoJSON `FeatureCollection`, **6160 features**, every feature carries `desokod` (DeSO code, e.g. `0180C1010`) + `kommunkod` (4-digit); coords are WGS84 (Sweden lng ~12–24, lat ~55–69). Live point-in-polygon check confirmed the artifact resolves real coordinates.

### Task 2 — geo.ts (GREEN)

- `resolveGeo(lat, lng): { kommunCode, desoCode }` — **pure** (no fetch/Date/Math.random; mirrors `score.ts`). Uses `booleanPointInPolygon` + `point` against the bundled polygons; on a hit, `desoCode = feature.desokod`, `kommunCode = desoCode.slice(0,4)` (RESEARCH Pitfall 2). On a miss (e.g. mid-ocean) → both null, never throws.
- The 4.90 MB artifact is read once via `fs.readFileSync` at module init (server-side; keeps it out of any client bundle), with an empty-set degrade if unreadable.
- **geo.test.ts GREEN (3/3).**

### Task 3 — scb.ts + scb-schema.ts (GREEN)

- **scb-schema.ts:** permissive `.passthrough()` json-stat2 Zod schema; `normalizeScbOutput(raw)` flattens to `{ population, age, income, tenure }` by detecting the Alder (population/age), upplåtelseform (tenure), and ContentsCode (income) dimensions and summing the value array along the relevant axes. Every metric independently falls back to `null`; never throws (T-03-07/D-08). `areaDataSchema` + `safeParseAreaData` mirror `safeParseBrfData`.
- **scb.ts:** `fetchScbDemographics(geo)` — server-side native `fetch` to `api.scb.se`, **no API key / no auth header**. Each query body is assembled server-side from constants + the validated DeSO region code (`isValidRegionCode` regex guard; `{deso}_DeSO{year}` suffix per 03-SPIKE §3) — user free-text never reaches the URL/body (T-03-06 SSRF). 3 table calls per enrich (well under 30/10s). Re-exports `normalizeScbOutput` / `safeParseAreaData` / `areaDataSchema` so callers import from `@/lib/market/scb`.
- **scb.test.ts GREEN (3/3).**

## SCB table → level → year mapping (03-SPIKE §3)

| Metric | Table | Level | Latest year |
|--------|-------|-------|-------------|
| Population + age + sex | `BE/BE0101/BE0101Y/FolkmDesoAldKon` | DeSO | 2025 |
| Income | `HE/HE0110/HE0110I/Tab1InkDesoRegso` | DeSO | **2024** (lags one year) |
| Tenure (upplåtelseform) | `HE/HE0111/HE0111YDeSo/HushallT33Deso` | DeSO | 2025 |

The normalizer/UI must NOT assume a single uniform "latest year" — the persisted `years` map carries each metric's own year.

## area_data as the cache of record (T-03-08)

Module-level memory is illusory on serverless cold starts and is NOT the correctness mechanism. The durable cache of record is the persisted `area_data` column: Plan 05 writes it once, the page reads it without re-calling SCB, and a re-enrich is the only path that re-hits SCB. `areaDataSchema` carries `fetchedAt` (freshness key) + the per-metric `years` so Plan 05 can treat the row as the cache.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected geo.test.ts coordinate→DeSO pairing against real SCB geometry**
- **Found during:** Task 2 (running geo.test.ts against the real artifact).
- **Issue:** The Plan 01 RED test asserted `resolveGeo(59.3293, 18.0686).desoCode === "0180C1010"`. That coordinate (central Stockholm) is a *guessed* pairing made before the real geometry existed; against the committed SCB DeSO_2025 geometry that point genuinely falls in `0180C4040` (DeSO `0180C1010` is in southern Stockholm, ≈ lng 18.11 / lat 59.23).
- **Fix:** Re-pinned the inside-polygon case to a verified-real coordinate (`59.233, 18.11` → `0180C1010`). The kommunCode case (still `0180`) and the outside→null case are unchanged, and the *behavior under test* ("a point inside a DeSO polygon resolves to that polygon's code") is unchanged — only the fixture's incorrect expected datum was corrected.
- **Files modified:** src/lib/market/geo.test.ts
- **Commit:** 4f64910

### Build-tool note (not a deviation)

mapshaper was installed to an isolated `/tmp` prefix and removed afterward — it is **not** in `package.json`. Only the two gated @turf runtime deps were added. GDAL was confirmed absent and the WFS-GeoJSON path made it unnecessary.

## Verification

- `npx vitest run src/lib/market/geo.test.ts src/lib/market/scb.test.ts` → **6 passed (6)**.
- Full suite: **56 passed | 6 todo (62)** — no regressions.
- `npx tsc --noEmit` → clean.
- `npx eslint` on the three new files → clean (0 errors, 0 warnings after removing one dead helper).
- next.config.ts: `git diff` empty — unchanged.
- No live network calls in tests (geo reads the committed artifact; scb reads the committed json-stat2 fixture).

## Known Stubs

None — resolveGeo and normalizeScbOutput are fully wired against real data (the committed DeSO artifact + the json-stat2 fixture). `fetchScbDemographics` performs real SCB calls at runtime; Plan 05 orchestrates + persists it. No placeholder/empty-value stubs flow to UI.

## Self-Check: PASSED

- FOUND: src/lib/market/geo.ts
- FOUND: src/lib/market/scb.ts
- FOUND: src/lib/market/scb-schema.ts
- FOUND: src/data/deso.geojson (4.90 MB, 6160 features)
- FOUND commit 4a7610c (turf deps + deso.geojson)
- FOUND commit 4f64910 (geo.ts GREEN)
- FOUND commit 58e4980 (scb.ts + scb-schema.ts GREEN)
