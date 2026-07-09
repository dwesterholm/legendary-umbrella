---
phase: 03-market-context
plan: 04
subsystem: api
tags: [booli, apify, playwright-scraper, zod, slutpriser, price-comparison, deterministic-core]

# Dependency graph
requires:
  - phase: 03-01
    provides: "Wave-0 spike (validated sold-price source + recipe) + the RED compare/cost contracts + the real redacted sold-comps.json fixture"
  - phase: 02-brf
    provides: "the trust-core pattern (score.ts pure config-const fn) + cost.ts shape + safeParse* read-path guard"
  - phase: 01-foundation
    provides: "ApifyClient + RESIDENTIAL/SE proxy pattern (booli-scraper.ts), APIFY_API_TOKEN, zod/v4 + null-tolerant normalize (listing.ts)"
provides:
  - "sold-schema.ts: normalizeSoldOutput (raw __APOLLO_STATE__ -> SoldComp[]), SoldComp type, priceDataSchema with the reason discriminator, PriceData type, safeParsePriceData"
  - "compare.ts: computePriceComparison (pure, zero/NaN-guarded, reason-tagged) + PRICE_COMPARISON_THRESHOLDS + PriceComparison type"
  - "cost.ts: soldSourceCostSek + USD_PER_RENDER + USD_SEK_RATE + SOLD_SOURCE_COST_CAP_SEK"
  - "sold-source.ts: fetchSoldComps(query) — source-isolating Booli SSR fetch via Apify playwright-scraper, throws on dead source (never silent [])"
affects: [03-05, 03-06, market-context-orchestration, price-comparison-card]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Source-isolating fetch interface (one module owns the source/transport identity — the SPIKE GATE)"
    - "Honest-state reason discriminator (ok|thin|source_unavailable|listing_pris_okand) so a dead source is never read as a thin area"
    - "Guards-first deterministic core (HIGH-3 listing-pris + areaAvg-NaN ordered before the headline computation)"

key-files:
  created:
    - src/lib/market/sold-schema.ts
    - src/lib/market/compare.ts
    - src/lib/market/cost.ts
    - src/lib/market/sold-source.ts
  modified: []

key-decisions:
  - "Transport = Booli SSR __NEXT_DATA__ via apify/playwright-scraper chromium + RESIDENTIAL/SE (per 03-SPIKE.md GO), NOT the keyless /graphql path the plan text still described — the GraphQL endpoint is a stricter, separate Cloudflare zone; a real browser is mandatory."
  - "thinMaxComps = 2 (compare RED tests pin 2 comps = thin, 5 = ok); confidence = sample-size band x tier factor (building 1.0 / neighborhood 0.85 / wide 0.65), clamped [0,1]."
  - "SOLD_SOURCE_COST_CAP_SEK = 1.0 SEK; USD_PER_RENDER = 0.0055 (spike actual billing); a 3-render paginated analysis ~0.18 SEK sits well under the cap."
  - "fetchSoldComps THROWS on unresolved area / actor failure / empty render / hasApollo=false — never silent [] (HIGH-1: dead source must be distinguishable from a thin area; Plan 05 maps the throw to source_unavailable)."

patterns-established:
  - "Pattern 1: source-isolating service — the ONLY module that knows the source/transport identity, so a swap touches one file"
  - "Pattern 2: reason-discriminated deterministic result — honest-state field set in code, never an LLM"

requirements-completed: [PRICE-01]

# Metrics
duration: 12min
completed: 2026-06-20
---

# Phase 3 Plan 4: PRICE-01 Deterministic Core Summary

**Pure-arithmetic price-comparison engine (±% headline, distribution, 24-mo least-squares trend, sample+tier confidence) over null-tolerant Booli slutpriser comps, with a reason discriminator that keeps a dead source distinct from a thin area — compare/cost RED tests GREEN (16/16).**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-06-20T20:45:00Z
- **Completed:** 2026-06-20T20:52:00Z
- **Tasks:** 3
- **Files modified:** 4 created

## Accomplishments
- `normalizeSoldOutput` parses the real redacted 35-comp fixture (all 35 comps, avg ~61 094 kr/m²): pris/kvm + m² + rooms + floor from `dataPoints` plainText, numeric `.raw` for price/% diff — null-tolerant, never throws.
- `computePriceComparison` is a pure, deterministic, guards-first trust core (mirrors brf/score.ts): deltaPct ≈ +8 case, distribution min/max, finite positive trend slope, sample+tier confidence, ≤2-comp thin marker — plus the HIGH-3 listing-pris-zero guard and the areaAvg-NaN guard.
- `soldSourceCostSek` mirrors brf/cost.ts: per-render Apify cost, FX const, documented per-analysis cap.
- `fetchSoldComps` isolates the Booli SSR source behind ONE interface (Apify playwright-scraper + RESIDENTIAL/SE), keeps the secret server-side, and throws (never silent []) on a dead source — HIGH-1.

## Task Commits

1. **Task 1: sold-schema.ts** - `d9e83a0` (feat)
2. **Task 2: compare.ts + cost.ts (TDD GREEN)** - `a8dbb44` (feat)
3. **Task 3: sold-source.ts** - `520a3eb` (feat)

_Task 2 RED was pre-committed in Plan 03-01 (the compare/cost test files); this plan supplied the single GREEN feat commit._

## Files Created/Modified
- `src/lib/market/sold-schema.ts` - permissive raw Apollo schema + null-tolerant `normalizeSoldOutput` -> `SoldComp[]`; `priceDataSchema` (with the `reason` enum) + `PriceData` + `safeParsePriceData` read-path guard.
- `src/lib/market/compare.ts` - `computePriceComparison` (pure, guards-first, reason-tagged) + `PRICE_COMPARISON_THRESHOLDS` + `PriceComparison` type; re-exports `SoldComp`.
- `src/lib/market/cost.ts` - `soldSourceCostSek` + `USD_PER_RENDER` + `USD_SEK_RATE` + `SOLD_SOURCE_COST_CAP_SEK`.
- `src/lib/market/sold-source.ts` - `fetchSoldComps(query)` source-isolating Booli SSR fetch via Apify playwright-scraper; `resolveAreaId` walks the breadcrumb `areaIds=<N>` ladder for the D-01 tier.

## SoldComp attributes available vs absent (per 03-SPIKE.md / fixture)
- **Present & parsed:** `prisPerKvm` (kr/m², the comparison axis), `soldDate` (ISO), `soldPrice` (`.raw`), `soldVsListPct` (`.raw`), `objectType`, `livingArea`, `rooms`, `floor` (e.g. "vån 2"), `daysActive`.
- **Absent / not modeled:** avgift, balcony/elevator amenity flags (present as `Amenity:` refs but not lifted — D-03 optional, comparison never blocks on them).

## reason discriminator — how it is set
- `ok` — a real comparison (usable comps > thinMaxComps, listing pris/kvm > 0). **Set here.**
- `thin` — 0 usable comps (all pris/kvm null → areaAvg null, not NaN) OR ≤ 2 usable comps. **Set here.**
- `listing_pris_okand` — listingPrisPerKvm null/≤0 → deltaPct null, NOT a false -100 %. **Set here (HIGH-3).**
- `source_unavailable` — **NOT set here.** Owned by Plan 05's catch around `fetchSoldComps` (which throws, never returns []).

## Confidence bands chosen
`confidence = sampleBand(usableCount) × tierFactor(tier)`, clamped [0,1]. sampleBands: ≥12→0.90, ≥8→0.80, ≥5→0.65, ≥3→0.45, ≥1→0.30, 0→0. tierFactor: building 1.0 / neighborhood 0.85 / wide 0.65. (5 building comps = 0.65 > 2 wide comps = 0.30 → satisfies the D-09 ordering test; 2-comp wide = 0.30 < 0.5 → satisfies the thin low-confidence test.)

## Cost cap value
`SOLD_SOURCE_COST_CAP_SEK = 1.0` SEK; `USD_PER_RENDER = 0.0055`, `USD_SEK_RATE = 11`. 1-render ≈ 0.0605 SEK, 3-render ≈ 0.18 SEK — both well under the cap (with headroom for retry overhead).

## next.config.ts serverExternalPackages
No change needed — `apify-client` is already present (Phase 1) and the SSR path introduces no new runtime dependency (03-SPIKE.md §6).

## Decisions Made
See frontmatter `key-decisions`. The load-bearing one: the working transport is the Booli SSR `__NEXT_DATA__` render via `apify/playwright-scraper`, NOT the keyless GraphQL path the plan's Task 3 prose still described (the spike overturned that — the `/graphql` endpoint is a separate stricter Cloudflare zone a non-browser POST cannot clear).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] sold-source transport implemented per the validated spike, not the plan's stale GraphQL-first prose**
- **Found during:** Task 3 (sold-source.ts)
- **Issue:** The plan's Task 3 `<action>` text still described a "keyless searchSold GraphQL POST to /graphql (native fetch), Apify-proxy fallback" path. 03-SPIKE.md (the canonical, human-approved source decision this plan depends on) explicitly OVERTURNS that: the `/graphql` endpoint is a stricter, separate Cloudflare managed-challenge zone — a raw fetch (even via the residential proxy) is 403; only `apify/playwright-scraper` reading the SSR `__NEXT_DATA__` HTML works. The cost.test.ts the plan must satisfy is also written around `{ renders }` (per-render billing), not GraphQL/token costs — confirming the Playwright-render transport.
- **Fix:** Implemented `fetchSoldComps` against the validated working recipe: Apify `apify/playwright-scraper` chromium + RESIDENTIAL/SE proxy, a `pageFunction` that reads `__NEXT_DATA__ → __APOLLO_STATE__` in-browser, `resolveAreaId` walking the breadcrumb `areaIds=<N>` ladder, `maxRequestRetries: 1`, and the HIGH-1 throw-never-silent-[] contract. `cost.ts` modeled per-render (`USD_PER_RENDER`) accordingly.
- **Files modified:** src/lib/market/sold-source.ts, src/lib/market/cost.ts
- **Verification:** compare+cost 16/16 GREEN; sold-source NO-CLIENT-SECRET gate passes; tsc clean for all four plan files.
- **Committed in:** 520a3eb (Task 3), a8dbb44 (Task 2 cost)

---

**Total deviations:** 1 auto-fixed (1 bug — stale plan prose corrected against the canonical spike).
**Impact on plan:** The deviation aligns the implementation with the plan's own dependency (03-SPIKE.md) and its own RED tests (cost.test.ts `{ renders }`). No scope creep — the source-isolation interface, secret posture, and HIGH-1 contract are exactly as the plan's acceptance criteria require.

## Issues Encountered
None. `npx tsc --noEmit` reports errors only in `src/lib/market/geo.test.ts` and `scb.test.ts` — pre-existing RED for plans 03-02/03-03 (geo.ts / scb.ts not yet implemented), outside this plan's scope (SCOPE BOUNDARY). Zero type errors in the four files this plan created; `npx vitest run src/lib/market/compare.test.ts src/lib/market/cost.test.ts` is fully GREEN.

## User Setup Required
None - no external service configuration required (APIFY_API_TOKEN already configured in Phase 1).

## Next Phase Readiness
- Plan 05 can orchestrate: call `fetchSoldComps` (catch → `reason: "source_unavailable"`), `normalizeSoldOutput`, `computePriceComparison`, gate persist on `soldSourceCostSek` vs `SOLD_SOURCE_COST_CAP_SEK`, and persist `PriceData` validated by `safeParsePriceData`.
- Concern (monitored, from spike): the source depends on `apify/playwright-scraper` continuing to clear Cloudflare; `fetchSoldComps` throws on `hasApollo === false` / empty so Plan 05 degrades to `source_unavailable` rather than false-thin.

## Self-Check: PASSED

All four created files exist on disk; all three task commits (d9e83a0, a8dbb44, 520a3eb) are present in git history.

---
*Phase: 03-market-context*
*Completed: 2026-06-20*
