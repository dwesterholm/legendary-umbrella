---
phase: 05-owned-booli-acquisition
verified: 2026-07-06T16:23:56Z
status: passed
score: 4/4 must-haves verified
overrides_applied: 0
---

# Phase 5: Owned Booli Acquisition Verification Report

**Phase Goal:** Own the Booli acquisition layer for both single listings and area searches, with an observable fallback tree — so the product no longer silently depends on the paid Apify actor and has the area-search foundation discovery needs.
**Verified:** 2026-07-06T16:23:56Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth (ROADMAP Success Criterion) | Status | Evidence |
|---|---------|--------|----------|
| 1 | A user pasting a Booli listing URL gets the same structured analysis as v1.0, now sourced through the owned client by default | ✓ VERIFIED | `src/actions/analyze.ts:6,49` imports and calls `fetchListing` (not `scrapeBooli`); downstream `scraperOutputSchema`/`normalizeScraperOutput` unchanged. `scrapeBooli` has zero remaining production call sites outside `client.ts`'s rung-3 wiring (`grep -rn scrapeBooli src/` confirms). Live operator e2e (05-05-SUMMARY.md): "Analysis renders the same fields as v1.0 ... no regression" + observed log `[booli-client] fetchListing served by rung 1 (own-playwright, health=ok)`. |
| 2 | The system can retrieve multiple active listings for an area through the same owned client | ✓ VERIFIED | `fetchAreaListings(areaId, objectType?)` in `src/lib/booli/client.ts:306-330` builds `/sok/till-salu?areaIds=<N>[&objectType=]` via `URLSearchParams`, extracts every `Listing:` Apollo entity via `extractListingEntities`, routed through `walkFallbackTree`. 6 tests in `client.test.ts` (`describe("fetchAreaListings")`) cover URL building (with/without objectType), multi-entity extraction (3 entities → 3-element array, non-Listing entities skipped), rung fallthrough, and HIGH-1 exhaustion throw. All green. |
| 3 | On primary transport failure, acquisition visibly walks the fallback tree (own → own-retry → paid actor) and surfaces which source/health served the data — no silent actor dependency | ✓ VERIFIED | `walkFallbackTree` (`src/lib/booli/fallback-tree.ts`) iterates rungs, returns `{data, source, rung, health}` (health="ok" only rung 1, else "degraded"), logs `[booli-client] rung N (<source>) failed` per failed rung, throws `/Alla Booli-kallor misslyckades/` when all rungs exhaust (never returns empty — HIGH-1). 5 tests in `fallback-tree.test.ts` cover rung-1 success, rung-2 fallthrough, rung-3 fallthrough, all-fail throw (multi-rung and single-rung), and per-rung `console.error` assertion. `fetchListing` wires rung3=`scrapeBooli` explicitly as last resort only (`client.ts:246-261`); `client.test.ts` asserts `scrapeBooli` is called only after both own-render rungs throw. Operator-observed log line confirms source/rung/health surfaced in practice. |
| 4 | Sold-comp acquisition (PRICE-01) continues unchanged, now served by the same unified client | ✓ VERIFIED | `fetchSoldComps`/`resolveAreaId`/`SoldSourceQuery`/`PriceTier`/`Breadcrumb` absorbed verbatim into `client.ts:341-490`, routed through `runPlaywrightRender`+`walkFallbackTree` instead of an inline `client.actor().call()`. `src/lib/market/sold-source.ts` reduced to a 19-line re-export shim. `enrich-market-context.ts` and `sold-source.test.ts` are byte-identical since Phase 3 (`git log` shows last touch `d7c25c7`/Phase 3, zero diff, zero uncommitted changes). `npx vitest run src/lib/market/sold-source.test.ts src/lib/market/sold-schema.test.ts` — all pass. |

**Score:** 4/4 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/lib/booli/client.ts` | `fetchListing`, `fetchAreaListings`, `fetchSoldComps` unified public API | ✓ VERIFIED | 491 lines. All three exported, all route through `walkFallbackTree`. Wired into `analyze.ts` and re-exported by `sold-source.ts`. |
| `src/lib/booli/transport.ts` | `runPlaywrightRender` — the one Apify actor-call core | ✓ VERIFIED | Reproduces `sold-source.ts`'s proven config verbatim (`apify/playwright-scraper`, RESIDENTIAL/SE, `maxRequestRetries: 3`, `waitSecs: 240`). Throws (never returns `[]`) on non-SUCCEEDED status, empty items, or all-`hasApollo:false`. Never logs the token. |
| `src/lib/booli/page-functions.ts` | `APOLLO_PAGE_FUNCTION` — shared extraction string | ✓ VERIFIED | Single exported string, identical extraction body to `sold-source.ts`'s proven `PAGE_FUNCTION`, used by both detail and area reads (differentiated only by `startUrls`). |
| `src/lib/booli/fallback-tree.ts` | `walkFallbackTree`, `FallbackResult<T>` | ✓ VERIFIED | Implements rung iteration, discriminated result, all-fail throw. Wired into all 3 `client.ts` entry points. |
| `src/lib/market/sold-source.ts` | Re-export shim (no-op migration) | ✓ VERIFIED | 19 lines, pure re-export of `fetchSoldComps`/`resolveAreaId`/types from `@/lib/booli/client`. |
| `src/actions/analyze.ts` | Call site swapped to `fetchListing` | ✓ VERIFIED | Line 6 imports `fetchListing` from `@/lib/booli/client`; line 49 calls it; `booli.se/` allowlist retained at line 23 (defense in depth alongside `fetchListing`'s own SSRF check). |
| `src/lib/booli/__mocks__/apify-client.ts` | Shared `ApifyClient` mock factory | ✓ VERIFIED | Exports `actorCall`, `listItems`, `resetApifyMock`, `apifyClientMockFactory`; constructor bug (arrow fn vs `function`) fixed during Plan 04 and confirmed working via all downstream tests. |
| `src/lib/booli/__fixtures__/listing-detail.json` | Redacted real Apollo `Listing:` entity | ✓ VERIFIED | 789 lines, captured from a live probe against `booli.se/bostad/305443`, PII-redacted, consumed by `client.test.ts`. |
| `src/lib/schemas/listing.test.ts` | No-op-migration regression guard | ✓ VERIFIED | 8 tests proving `normalizeScraperOutput` tolerates both actor-flat and detail-page-Apollo shapes identically; `listing.ts` confirmed untouched (`git log` last touch = Phase 3). |
| `.planning/phases/05-owned-booli-acquisition/05-PROBE-FINDINGS.md` | Pinned prefix + parity table + GO decision | ✓ VERIFIED | Records `Listing:` prefix pinned empirically, all 4 required display fields satisfied, GO decision, consumed by `client.ts`'s `LISTING_ENTITY_PREFIX` constant. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `analyze.ts` | `booli/client.ts` | `import { fetchListing }` | ✓ WIRED | Confirmed by direct read; no remaining `scrapeBooli` import in `analyze.ts`. |
| `booli/client.ts` | `booli/fallback-tree.ts` | `walkFallbackTree` with rung1/2 own + rung3 `scrapeBooli` | ✓ WIRED | All 3 client entry points (`fetchListing`, `fetchAreaListings`, `fetchSoldComps`) call `walkFallbackTree`; only `fetchListing` wires rung 3 (documented, intentional — the other two have no single-listing-shaped paid-actor equivalent). |
| `booli/client.ts` | `booli/transport.ts` | `runPlaywrightRender(url, APOLLO_PAGE_FUNCTION)` | ✓ WIRED | Used as the `attempt()` for own-playwright and own-playwright-retry rungs across all 3 entry points. |
| `booli/client.ts` | `apify/booli-scraper.ts` | `scrapeBooli` as rung 3 attempt | ✓ WIRED | `client.ts:259` — `attempt: () => scrapeBooli(url)`, asserted in `client.test.ts` ("falls to rung 2 then rung 3 ... only after BOTH own-render rungs throw"). |
| `market/sold-source.ts` | `booli/client.ts` | thin re-export | ✓ WIRED | `sold-source.ts` exports `fetchSoldComps`, `resolveAreaId`, `SoldSourceQuery`, `PriceTier`, `Breadcrumb` from `@/lib/booli/client`; `sold-source.test.ts` imports from `@/lib/market/sold-source` unchanged and passes. |
| `booli/client.test.ts` | `booli/client.ts` | mocked-ApifyClient unit tests | ✓ WIRED | 10 tests, all green, using shared mock + real fixture. |

### Data-Flow Trace (Level 4)

Not applicable in the standard "UI renders hardcoded/empty data" sense — this phase is a backend acquisition-layer swap, not a UI component. The equivalent trace (raw payload → normalization → persisted/returned `ListingData`) was verified directly:

| Artifact | Data Source | Produces Real Data | Status |
|----------|-------------|---------------------|--------|
| `fetchListing` → `analyze.ts` | Live Apify Playwright render → `extractListingEntity` reshape → `normalizeScraperOutput` | Operator-confirmed live run returned real field values (address, price, living area, rooms, pris/kvm) rendered without regression | ✓ FLOWING |
| `fetchSoldComps` → `enrich-market-context.ts` | Live Apify Playwright render of slutpriser page, same transport | Operator confirmed "sold-price comparison panel still populates" during the same live e2e check | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full test suite green | `npm run test` | 198 passed, 1 skipped, 6 todo, 0 failed | ✓ PASS |
| Zero TypeScript errors | `npx tsc --noEmit -p tsconfig.json` | No output (clean) | ✓ PASS |
| `booli/` + related unit tests | `npx vitest run src/lib/booli/ src/lib/schemas/listing.test.ts src/lib/market/sold-source.test.ts src/lib/market/sold-schema.test.ts` | 5 test files, 46 tests, all passed | ✓ PASS |
| No production call site bypasses `fetchListing`/`walkFallbackTree` | `grep -rn scrapeBooli src/ --include="*.ts" --include="*.tsx" \| grep -v test` | Only `client.ts` (rung-3 wiring + comments) — zero other call sites | ✓ PASS |
| `enrich-market-context.ts`/`sold-source.test.ts` truly unmodified | `git log --oneline -- <files>` + `git status --short` | Last touched Phase 3 (`d7c25c7`); zero uncommitted diff | ✓ PASS |

### Probe Execution

No conventional `scripts/*/tests/probe-*.sh` exist for this phase, and none were declared in the PLAN/SUMMARY files. The phase's "probe" is `scripts/booli-listing-probe.ts` — a one-off, non-repeatable live-transport confirmation script requiring a real `APIFY_API_TOKEN` and a live Booli listing. This was already executed once by the operator during Plan 02 (human checkpoint, not an automated CI-style probe) with results recorded in `05-PROBE-FINDINGS.md` (GO decision, pinned `Listing:` prefix, field-parity table). Re-running it here would incur real cost against a third-party live site and is not appropriate for a verifier to re-trigger; the recorded findings plus the independent Plan 05 live e2e checkpoint (also operator-executed, also recorded with concrete log evidence) are treated as sufficient evidence.

| Probe | Command | Result | Status |
|-------|---------|--------|--------|
| `scripts/booli-listing-probe.ts` (one-off, not `tests/probe-*.sh`) | Operator-run during Plan 02 (`npx tsx scripts/booli-listing-probe.ts <url>`) | SUCCEEDED, `hasApollo: true`, prefix `Listing:` pinned, GO recorded in `05-PROBE-FINDINGS.md` | PASS (human-executed, recorded) |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|--------------|------------|--------------|--------|----------|
| ACQ-01 | 05-01, 05-04, 05-05 | Single listing by URL via owned client + fallback tree | ✓ SATISFIED | `fetchListing` implemented, tested, wired into `analyze.ts`, live-verified. |
| ACQ-02 | 05-04 | Area/multi-listing search via same client | ✓ SATISFIED | `fetchAreaListings` implemented, tested (URL building, multi-entity extraction, rung fallthrough). |
| ACQ-03 | 05-03 | Graceful, observable degradation — surfaces source/health, no silent actor dependency | ✓ SATISFIED | `walkFallbackTree` implemented, tested (5 tests incl. HIGH-1 all-fail throw), wired into every client entry point, operator-observed log line confirms real-world observability. |

**Note (documentation staleness, non-blocking):** `.planning/REQUIREMENTS.md` line 13-15 correctly shows `[x]` for ACQ-01/02/03, but its separate status-tracking table (line 67-69) still reads "In Progress (Plan 1/5: Wave 0 test infra landed)" — stale since Plan 05-01. This is a documentation bookkeeping gap only; it does not reflect the actual (complete) implementation state and is not treated as a phase gap.

### Anti-Patterns Found

None. Scanned all Phase 5 production and test files (`client.ts`, `transport.ts`, `page-functions.ts`, `fallback-tree.ts`, `client.test.ts`, `fallback-tree.test.ts`, `__mocks__/apify-client.ts`, `sold-source.ts`, `analyze.ts`, `listing.test.ts`, `booli-listing-probe.ts`) for TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER markers, "not yet implemented" phrasing, empty-return stubs, and console.log-only implementations. Zero matches.

### Human Verification Required

None outstanding. The phase's single blocking human checkpoint (Plan 05-05 Task 3 — live end-to-end verification) was already executed by the operator and approved on 2026-07-06, with concrete evidence recorded in `05-05-SUMMARY.md`: analysis rendered with no regression, sold-price panel populated, and the observed log line `[booli-client] fetchListing served by rung 1 (own-playwright, health=ok)` confirms ACQ-03 observability in practice. No further human action is needed to close this phase.

### Gaps Summary

No gaps. All 4 ROADMAP success criteria and all 3 requirements (ACQ-01/02/03) are verified against the actual codebase — not just SUMMARY.md claims. Independently confirmed via direct code reading (`client.ts`, `transport.ts`, `page-functions.ts`, `fallback-tree.ts`, `sold-source.ts`, `analyze.ts`), a fresh test run (198/198 passing, 0 failures), a fresh typecheck (0 errors), git history checks proving `enrich-market-context.ts`/`sold-source.test.ts`/`listing.ts` are byte-identical to their Phase 3 state, and an anti-pattern scan (zero hits). The one deviation from a literal reading of the roadmap wording — `fetchAreaListings` and `fetchSoldComps` have only 2 rungs (no paid-actor rung 3), since `scrapeBooli` is single-listing-shaped and cannot serve an area or slutpriser query — is explicitly documented in the code, the plan, and the summary, and does not weaken ACQ-03: both functions still throw (never silently return empty) when their available rungs exhaust, preserving the HIGH-1 no-silent-failure discipline the requirement is actually protecting.

---

*Verified: 2026-07-06T16:23:56Z*
*Verifier: Claude (gsd-verifier)*
