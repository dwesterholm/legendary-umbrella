---
phase: 03-market-context
reviewed: 2026-06-22T00:00:00Z
depth: standard
files_reviewed: 24
files_reviewed_list:
  - next.config.ts
  - src/actions/analyze.ts
  - src/actions/enrich-market-context.ts
  - src/app/(app)/analysis/[id]/page.tsx
  - src/components/area-stats-card.tsx
  - src/components/market-context-section.tsx
  - src/components/price-comparison-card.tsx
  - src/lib/apify/booli-scraper.ts
  - src/lib/market/compare.test.ts
  - src/lib/market/compare.ts
  - src/lib/market/cost.test.ts
  - src/lib/market/cost.ts
  - src/lib/market/geo.test.ts
  - src/lib/market/geo.ts
  - src/lib/market/scb-schema.ts
  - src/lib/market/scb.test.ts
  - src/lib/market/scb.ts
  - src/lib/market/sold-schema.test.ts
  - src/lib/market/sold-schema.ts
  - src/lib/market/sold-source.test.ts
  - src/lib/market/sold-source.ts
  - src/lib/schemas/listing.ts
  - supabase/migrations/003_market_context.sql
findings:
  critical: 0
  warning: 6
  info: 5
  total: 11
warnings_resolved: 6
warnings_resolved_list:
  - WR-01  # 24-month window now enforced in compare.ts (usableCompsOf filters by windowDays)
  - WR-02  # billed renders recorded on the all-tier-fail path (typed SoldWalkError carries renders)
  - WR-03  # analysis page safe-parses listing_data (listingDataSchema.safeParse → notFound)
  - WR-04  # tenure body selects Upplatelseform component forms + ContentsCode (no TOTALT double-count); fixture+test added
  - WR-05  # deterministic SoldProperty displayAttributes variant pick (SERP-preferred, sorted, merged)
  - WR-06  # trend arrow thresholded via classifyTrend dead-band (negligible slope → "stabil")
status: resolved
---

# Phase 3: Code Review Report

**Reviewed:** 2026-06-22
**Depth:** standard
**Files Reviewed:** 24
**Status:** resolved (all 6 warnings fixed 2026-06-22; 5 INFO findings left as noted)

## Summary

Phase 3 adds the Booli sold-price comparison (PRICE-01) and SCB demographics
(AREA-01) to the analysis page. The security posture is strong: `APIFY_API_TOKEN`
is read server-only from `process.env` with no `NEXT_PUBLIC_` leak, the SCB query
bodies are assembled exclusively from constants + regex-validated region codes
(no user free-text reaches the URL/body), there is no `eval`/injection surface,
and the owner-only auth + ownership re-check in `enrich-market-context.ts` mirrors
the established `analyze-brf.ts` posture and is backed by RLS. The honest-state
contract (four distinct `PriceData.reason` states) is correctly wired through the
action, schema, and UI. Normalization is null-tolerant throughout.

No BLOCKER-class defects were found. The findings below are correctness and
robustness gaps, the most material being: (1) the documented 24-month comparison
window (`windowDays: 730`) is declared but never applied — `areaAvg`/`deltaPct`/
trend are computed over **all** usable comps regardless of age, so the "Pristrend
(24 mån)" UI label and the area average can silently include stale comps; (2) cost
under-reporting when every sold tier fails; and (3) an unvalidated `as`-cast of the
persisted `listing_data` that breaks the CR-01 safe-parse discipline used everywhere
else on the page.

## Warnings

### WR-01: 24-month comparison window (`windowDays: 730`) is declared but never applied — RESOLVED

**Resolution:** `usableCompsOf(comps, nowMs)` now filters comps to the last
`windowDays` (anchored on an explicit `nowMs` arg passed by the action; the fn
stays pure). Undated/unparseable-date comps are KEPT by documented policy (no
staleness signal); they still do not feed the trend regression. The action pins
one `nowMs` for both the walk-up recency gate and the comparison.
`compare.test.ts` covers in-window/out-of-window/undated cases.


**File:** `src/lib/market/compare.ts:36`, `src/lib/market/compare.ts:184-234`
**Issue:** `PRICE_COMPARISON_THRESHOLDS.windowDays = 730` is documented as "24-month
comparison window (D-02) — comps older are de-weighted", and the methodology page
imports this constant as the source of truth. But `windowDays` is never referenced
in any computation. `usableCompsOf` filters only on `prisPerKvm > 0` — it does NOT
filter by `soldDate`. As a result `areaAvg`, `deltaPct`, `min`, `max`, and the
least-squares trend are computed over **every** usable comp regardless of how old it
is. A tier whose comps are mostly years stale will still produce a confident `ok`
headline and a "Pristrend (24 mån)" label (`price-comparison-card.tsx:289-291`) even
though no 24-month windowing was performed. The label asserts a window the engine
does not enforce, and a stale comp set poisons the headline ±%. Note `walkSoldTiers`
uses a *separate* `RECENCY_WINDOW_DAYS = 365` only to pick a tier — it does not prune
the comps that compare.ts then averages.
**Fix:** Either apply the window in the comparison (drop/de-weight comps older than
`windowDays` before computing `areaAvg`/`deltaPct`/trend), or, if the window is
intentionally deferred, remove the misleading "(24 mån)" label and the
"comps older are de-weighted" doc claim:
```ts
function usableCompsOf(comps: SoldComp[], nowMs: number): SoldComp[] {
  const windowMs = PRICE_COMPARISON_THRESHOLDS.windowDays * 86_400_000;
  return comps.filter((c) => {
    if (typeof c.prisPerKvm !== "number" || !Number.isFinite(c.prisPerKvm) || c.prisPerKvm <= 0) return false;
    if (!c.soldDate) return true; // or false, per policy
    const t = Date.parse(c.soldDate);
    return !Number.isFinite(t) || nowMs - t <= windowMs;
  });
}
```
(This would require threading `nowMs` into `computePriceComparison`, which currently
takes no clock — a deliberate purity choice. Pass it as an explicit arg to keep the
function pure, as `walkSoldTiers`/`recencyOf` already do.)

### WR-02: Sold-source cost is under-reported to 0 when every tier fails — RESOLVED

**Resolution:** `walkSoldTiers` now throws a typed `SoldWalkError` carrying the
renders actually spent before all tiers failed; the price-branch catch sets
`renders` from it (falling back to `MAX_SOURCE_CALLS` for any non-typed error),
so `market_cost_sek` reflects real Apify spend on the failure path. The cost-cap
behavior is unchanged.


**File:** `src/actions/enrich-market-context.ts:331-360`, `159-195`
**Issue:** `renders` in `enrichMarketContext` is initialized to 0 and only assigned
`renders = walk.renders` *inside the try*, after `walkSoldTiers` returns successfully.
When every tier's `fetchSoldComps` throws, `walkSoldTiers` itself throws; the catch at
line 383 sets `price = sourceUnavailablePrice()` but leaves `renders === 0`. Yet
`walkSoldTiers` may have spent up to `MAX_SOURCE_CALLS` (3) actual billed Apify
playwright-scraper renders before throwing (each attempt increments its internal
`renders` and each call is billed by Apify regardless of failure). The downstream
`soldSourceCostSek({ renders })` therefore records `market_cost_sek = 0` for an
analysis that actually cost up to ~0.18 SEK. This corrupts the persisted cost ledger
and the cost gate's view of spend. It does not exceed the cap, so it is not a billing
runaway, but the accounting is wrong precisely on the failure path that the spend
guard exists to observe.
**Fix:** Have `walkSoldTiers` surface the render count even when it throws (e.g.
throw a typed error carrying `renders`, or return a result that flags total failure),
and account for the spent renders in the catch:
```ts
} catch (error) {
  renders = (error as { renders?: number }).renders ?? MAX_SOURCE_CALLS;
  // ...log + sourceUnavailablePrice()
}
```

### WR-03: `listing_data` handed to the UI without the CR-01 safe-parse guard — RESOLVED

**Resolution:** the analysis page now uses
`listingDataSchema.safeParse(analysis.listing_data).data` and calls `notFound()`
when the row does not validate, matching the sibling
`safeParseBrfData`/`safeParsePriceData`/`safeParseAreaData` discipline. The
`.prisPerKvm` dereference is reached only after the non-null narrowing.


**File:** `src/app/(app)/analysis/[id]/page.tsx:37`, `60`, `76`
**Issue:** `brf_data`, `price_data`, and `area_data` are all defensively re-validated
via `safeParseBrfData` / `safeParsePriceData` / `safeParseAreaData` before being handed
to the client (the CR-01 / T-03-20 discipline the file documents at lines 39-47). But
`listing_data` is cast straight through: `const listingData = analysis.listing_data as
unknown as ListingData`. It is then passed to `ListingSummary` (line 60) and dereferenced
as `listingData.prisPerKvm` (line 76). A null/malformed/shape-drifted `listing_data` row
(the exact scenario the other three guards exist for) will either crash on the property
access or feed garbage into the price card. `listingDataSchema` + a safe-parse helper
already exist and are used by `enrich-market-context.ts:308`; the page is the one place
that skips them.
**Fix:** Re-validate before use, consistent with the sibling columns:
```ts
const listingData = listingDataSchema.safeParse(analysis.listing_data).data ?? null;
if (!listingData) notFound(); // or render a degraded state
// pass listingData?.prisPerKvm ?? null to MarketContextSection
```

### WR-04: Tenure SCB query omits the table's mandatory dimensions — risks always-null tenure — RESOLVED

**Resolution:** verified the `HushallT33Deso` table's dimensions live — it
carries `Upplatelseform` (5 values incl. the `TOTALT` aggregate) +
`ContentsCode` (`000007DQ`). The old Region+Tid-only body did NOT 400, but
returned ALL forms INCLUDING `TOTALT`, which the normalizer summed into the
tenure mix (double-counting). `tenureBody` now selects the four COMPONENT forms
(`ÄG/ANDEL`, `BOSTADSRÄTT`, `HYRESRÄTT`, `ÖVRIGT`) + the content code
explicitly. Added a redacted-live `scb-tenure.json` fixture + `scb.test.ts`
cases (offline) guarding the per-form mix and suppressed-null-cell tolerance.


**File:** `src/lib/market/scb.ts:267-282`
**Issue:** The population and income query bodies each carry the comment "X + Y are
MANDATORY for this table; omitting them → HTTP 400" and dutifully send `Alder`/`Kon`/
`ContentsCode` (population) and `InkomstTyp`/`Kon`/`ContentsCode` (income). The tenure
body (`tenureForm`/`HushallT33Deso`) sends only `Region` + `Tid` — no
`ContentsCode`, no `Hushallstyp`/upplåtelseform selection. If this table is also
mandatory-dimension-gated like the other two (the pattern strongly suggests it is),
every tenure request returns HTTP 400 → `fetchScbTable` returns null → tenure is
silently null on every analysis, and the "Upplåtelseform" tile is permanently
"Ej tillganglig". There is no fixture or test for the tenure path
(`__fixtures__/` holds only `scb-population.json`), so this is unverified by the suite.
**Fix:** Verify the `HushallT33Deso` table's mandatory dimensions against the live SCB
value list and add them to `tenureBody` (mirroring the population/income bodies), and
add a tenure json-stat2 fixture + `normalizeScbOutput` tenure test so the path is
exercised offline.

### WR-05: `dataPointsOf` prefix match can pick the wrong Apollo key — RESOLVED

**Resolution:** `dataPointsOf` now collects every `displayAttributes(...)` key,
SORTS them for stable order, PREFERS the `SERP_LIST_LISTING` variant, and MERGES
all variants' dataPoints (SERP first so its values win in `findDataPoint`).
Array/wrapper/bare shape handling is unchanged. Added order-independence +
SERP-preference regression tests.


**File:** `src/lib/market/sold-schema.ts:152-161`
**Issue:** `dataPointsOf` selects the comp's data points via
`Object.keys(entry).find((k) => k.startsWith("displayAttributes"))` and takes the FIRST
match. Apollo cache keys are field+args-encoded (e.g.
`displayAttributes({"queryContext":"SERP_LIST_LISTING"})`); if a `SoldProperty` entry
carries more than one `displayAttributes(...)` variant (different `queryContext`), the
first-by-insertion-order key wins non-deterministically and may be the wrong variant
(e.g. a detail-page context lacking the SERP pris/kvm dataPoint). The pris/kvm parse
would then come back null, dropping an otherwise-usable comp and biasing toward "thin".
The fixture has a single variant so the test cannot catch this.
**Fix:** Match the intended variant explicitly rather than by prefix, e.g.
`Object.keys(entry).find((k) => k.includes("SERP_LIST_LISTING"))` with a documented
fallback, or iterate all `displayAttributes*` keys and merge their dataPoints.

### WR-06: Trend label asserts "24 mån" with no window or minimum-span guard — RESOLVED

**Resolution:** the slope now feeds the same `windowDays` filter as WR-01 (the
trend regresses only over the windowed usable set), and a pure `classifyTrend`
classifier in `compare.ts` applies a `trendStableEpsPerDay` dead-band so a
negligible slope renders "→ stabil" instead of a confident ↑/↓. The price card
classifies through it (hiding the line when the slope is null). `compare.ts`
stays pure. Added classifier tests.


**File:** `src/components/price-comparison-card.tsx:288-293`, `src/lib/market/compare.ts:120-148`
**Issue:** The UI renders "Pristrend (24 mån): ↑ stigande / ↓ fallande / → stabil"
whenever `trendSlope` is a finite number. `computeTrendSlope` returns a slope for as
few as two dated comps spanning any interval (e.g. two comps 3 weeks apart), and — per
WR-01 — applies no 24-month window. So a "24 mån" rising/falling claim can be made from
two near-adjacent sales, or from comps spanning several years. The directional arrow is
also unthresholded: any non-zero slope, however statistically meaningless, renders as a
confident ↑/↓ (→ stabil is only shown for an exactly-zero slope, which essentially never
occurs with real data).
**Fix:** Gate the trend on a minimum number of dated points and a minimum spanned
interval, apply the same `windowDays` filter as WR-01, and add a near-zero dead-band so
flat markets read "→ stabil":
```ts
const STABLE_EPS = /* kr/m² per day deemed flat */;
const dir = Math.abs(slope) < STABLE_EPS ? "stabil" : slope > 0 ? "stigande" : "fallande";
```

## Info

### IN-01: Non-null assertion on `APIFY_API_TOKEN` masks a missing-secret misconfig

**File:** `src/lib/apify/booli-scraper.ts:4`, `src/lib/market/sold-source.ts:35`
**Issue:** `new ApifyClient({ token: process.env.APIFY_API_TOKEN! })` uses `!` to assert
the secret is set. When unset, the token is `undefined` and the failure surfaces only
deep inside an Apify call as an opaque auth error, mapped to a generic Swedish "try
again" message — there is no fail-fast or clear operator signal. (No security issue: the
token is server-only and never logged.)
**Fix:** Validate at module load and throw a clear configuration error:
`if (!process.env.APIFY_API_TOKEN) throw new Error("APIFY_API_TOKEN is not set");`

### IN-02: `recentUsableCount` requires `soldDate` while `compare`'s usable set does not

**File:** `src/actions/enrich-market-context.ts:120-135` vs `src/lib/market/compare.ts:97-102`
**Issue:** The walk-up "sufficient" gate counts only comps with a parseable `soldDate`
within 365 days, but `computePriceComparison.usableCompsOf` counts any comp with
`prisPerKvm > 0` regardless of date. The two "usable" definitions diverge. In practice
the walk just walks wider (harmless), but the divergent semantics under one word
("usable") are a maintenance trap and interact with WR-01.
**Fix:** Centralize a single "usable comp" predicate and a single recency definition,
shared by the walk gate and the comparator, to keep the two in lockstep.

### IN-03: `formatAge` mislabels the middle cohort and assumes 65 boundary alignment

**File:** `src/components/area-stats-card.tsx:55-78`
**Issue:** `formatAge` buckets `start < 20` as young and `start >= 65` as old, summing
the rest into neither. With SCB's 5-year bands (`-4 … 80-`) this happens to align, but
the headline "{young}% under 20 · {old}% 65+" silently omits the 20–64 majority with no
indication, and the bucketing is brittle to any band-coding change (it relies on
`parseInt("80-")===80` and `parseInt("-4")===-4`). Not a correctness bug today; a
fragility note.
**Fix:** Comment the dependence on the exact band coding, or compute against the known
`POPULATION_AGE_BANDS` rather than re-parsing arbitrary code strings.

### IN-04: `next.config.ts` `outputFileTracingIncludes: "/**"` ships the 5 MB GeoJSON into every route bundle

**File:** `next.config.ts:13-15`
**Issue:** The DeSO artifact is traced into `"/**"` (all routes). Only the geo-resolving
server path needs it; tracing it everywhere bloats unrelated route bundles. Out of v1
scope as a performance item, noted as a maintainability/footprint observation.
**Fix:** Scope the include to the route(s) that transitively use `resolveGeo` if the
build supports a narrower glob.

### IN-05: `analyze.ts` `prisPerKvm` falls back to `0`, producing the `listing_pris_okand` path silently

**File:** `src/actions/analyze.ts:85-89`
**Issue:** When neither a scraped pris/kvm nor a computable one is available,
`prisPerKvm` is stored as `0`. That `0` later (correctly) drives the
`listing_pris_okand` honest state in enrich. The magic `0` sentinel is implicit — a
reader must trace to `enrich-market-context.ts:336-339` to learn that `0` means
"unknown", not "free". Consider documenting the `0`-as-unknown contract at the
write site, or storing `null` and adjusting the (non-nullable) schema. Behavior is
correct; the implicit sentinel is the note.
**Fix:** Add a comment at line 89 cross-referencing the `listing_pris_okand` guard, or
make `prisPerKvm` nullable end-to-end so "unknown" is explicit.

---

_Reviewed: 2026-06-22_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
