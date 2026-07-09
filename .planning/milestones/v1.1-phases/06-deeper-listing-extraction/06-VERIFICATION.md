---
phase: 06-deeper-listing-extraction
verified: 2026-07-06T19:08:36Z
status: human_needed
score: 9/9 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Live broker-CMS coverage + degradation + PII sample (operator checkpoint deferred from 06-03-PLAN.md Task 3)"
    expected: "Paste 3-5 real, currently-active Booli listing URLs into the running app with a real APIFY_API_TOKEN. Våning/Balkong/BRF populate from Booli with 'Källa: Booli'. Renoveringsstatus/Beskrivning either populate with 'Källa: Mäklarens annons' or show 'Ej tillgänglig'. No mäklare name/phone/email appears anywhere in the rendered report. A broker-page failure shows the soft terracotta banner while the rest of the analysis renders exactly as before. Server logs show `[broker]` lines on any fetch failure, never a silent failure or thrown error surfacing to the user."
    why_human: "Requires a running dev server, a real APIFY_API_TOKEN, and real currently-active third-party broker pages (Vitec/Mspecs/bespoke CMS) whose markup and coverage cannot be simulated by synthetic fixtures or unit tests. This is the informational-spike data point (RESEARCH Open Question 1) explicitly deferred to the operator, the same pattern used in Phase 5."
---

# Phase 6: Deeper Listing Extraction Verification Report

**Phase Goal:** Recover the per-listing fields Booli lacks — floor/våning, balcony, BRF name, renovation status, full description — by following through to the broker's own page, filling gaps without ever overwriting Booli data.
**Verified:** 2026-07-06T19:08:36Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

Must-haves merged from ROADMAP.md Success Criteria (4) + PLAN frontmatter across 06-01/06-02/06-03 (5 additional, non-overlapping detail-level truths).

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | (SC1) For a parseable broker page, the analysis shows floor, balcony, BRF name, renovation status, and full description that Booli alone didn't provide | VERIFIED | `src/lib/booli/client.ts` `amenityKeys`/`brfNameFromBreadcrumbs` extract floor/balcony/brfName from the Apollo entity with zero network call (tested against the real fixture: floor=3, balcony=true, brfName="HSB BRF Metern" — `src/lib/booli/client.test.ts:358-421`). `src/lib/broker/parse-broker-page.ts` extracts renovationStatus/description via JSON-LD-first/DOM-fallback (`parse-broker-page.test.ts`). `src/actions/analyze.ts` folds all 5 into `listingData`; `src/components/listing-summary.tsx` renders all 5 as MetricCards/prose block. |
| 2 | (SC2) Broker-sourced fields only fill gaps — never overwrite a Booli value — and each field's source is distinguishable | VERIFIED | `src/lib/broker/merge-listing-fields.ts` `fillGap`: booli non-null always wins, tagged `source:"booli"`; broker only fills when booli is null, tagged `source:"maklare"`. Explicit "never overwrites" test in `merge-listing-fields.test.ts:21-29` and integration-level test in `analyze.test.ts:107-124`. Provenance persisted via `fieldSources` on `listingDataSchema` and rendered as "Källa: Booli"/"Källa: Mäklarens annons" captions in `listing-summary.tsx`. |
| 3 | (SC3) When the broker page is unreachable/unparseable, the primary analysis still succeeds exactly as before, missing fields shown as unavailable, not fabricated | VERIFIED | `fetchBrokerListingPage` returns `null` on every failure path (guard rejection, non-2xx, redirect, network error, parse exception) — never throws (`fetch-broker-page.ts`, tests in `parse-broker-page.test.ts:86-131`). `analyze.ts`'s broker call is wrapped in its OWN try/catch that never `return`s `{error}` — verified by `analyze.test.ts:93-105` (broker mock REJECTS, `analyzeUrl` still returns `{data, partial:false}`). `listing-summary.tsx` shows "Ej tillganglig" for missing fields and a separate soft terracotta banner gated on `brokerFetchFailed` (independent of `partial`). |
| 4 | (SC4) No broker contact PII (name, phone, email) appears anywhere in stored data or report output | VERIFIED | `parse-broker-page.ts` reads only `description`/renovation section by explicit named access, never object-spread. Mandatory deep-search regression test (`parse-broker-page.test.ts:23-35`) proves a JSON-LD fixture's fake agent name/phone/email never appear in the parser's return value. A second deep-search test at the persistence boundary (`analyze.test.ts:139-159`) simulates a misbehaving broker payload carrying PII-shaped keys and proves they never reach `listingData`. |
| 5 | floor is recovered as a number from the Apollo Listing entity with no broker fetch (06-01) | VERIFIED | `reshapeListingEntity`'s existing `floor: entry.floor ?? undefined` passthrough + `normalizeScraperOutput`'s `num(raw.floor) ?? rawOf(raw.floor)` unwrap `{raw:3}` → `3`; test asserts `floor` = 3 against the real fixture via `fetchListing` (`client.test.ts`). |
| 6 | brfName is recovered from the final `/bostadsrattsforening/` breadcrumb with no broker fetch (06-01) | VERIFIED | `brfNameFromBreadcrumbs` in `client.ts:156-163`; tests confirm "HSB BRF Metern" from the real fixture, null for a non-matching/short/empty ladder (`client.test.ts:393-416`). |
| 7 | balcony is recovered as a boolean by strict-parsing the amenities ref key, never a substring match (06-01) | VERIFIED | `amenityKeys` in `client.ts:134-147` does `JSON.parse` + exact `.key` read, never `.includes()`. Test explicitly proves a `balconyView` ref does NOT produce a `balcony` false-positive (`client.test.ts:364-367`). |
| 8 | The broker-page fetch rejects any URL resolving to a private/loopback/link-local IP, and any non-http(s) protocol, BEFORE issuing a request (06-02) | VERIFIED | `src/lib/broker/url-guard.ts` `isSafeExternalUrl`: protocol check before DNS; `dns.promises.lookup` then classifies IPv4 (RFC1918/loopback/link-local incl. 169.254.169.254) and IPv6 (`::1`, `fe80:`) as unsafe; DNS failure → unsafe. All 5 behaviors covered in `url-guard.test.ts`, including "dns.lookup never called for bad protocol." |
| 9 | The merge fills a broker value into a field ONLY when Booli is null, tagging every populated field with its source (Sourced<T> contract, 06-01/06-02) | VERIFIED | `Sourced<T>`/`ListingSource` exported from `src/lib/schemas/listing.ts`; `fillGap`/`mergeListingFields` in `src/lib/broker/merge-listing-fields.ts` implement and test the contract exhaustively (4 tests in `merge-listing-fields.test.ts`). |

**Score:** 9/9 truths verified programmatically. 1 additional human-verification item (live broker-CMS sampling) intentionally deferred to the operator per the plan's own checkpoint design — does not represent a code gap.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/lib/schemas/listing.ts` | floor/balcony/renovationStatus/description nullable fields + `Sourced<T>`/`ListingSource` + `fieldSources`/`brokerFetchFailed` | VERIFIED | All present; additive only — diff against pre-phase HEAD shows zero changes to existing field definitions or `normalizeScraperOutput`'s existing coercion lines. |
| `src/lib/booli/client.ts` | `amenityKeys`/`brfNameFromBreadcrumbs` wired into `reshapeListingEntity` | VERIFIED | Both exported, both called; strict-parse discipline confirmed (no `.includes("balcony")` substring bypass). |
| `src/lib/broker/url-guard.ts` | `isSafeExternalUrl` — protocol allowlist + DNS-resolve-then-classify | VERIFIED | Exports `isSafeExternalUrl`; resolve-then-classify implementation matches RESEARCH spec exactly. |
| `src/lib/broker/fetch-broker-page.ts` | `fetchBrokerListingPage` — SSRF-guarded fetch + cheerio orchestration, redirects disabled | VERIFIED | Guards first, `redirect:"manual"`, never throws, `[broker]`-tagged logging. |
| `src/lib/broker/parse-broker-page.ts` | `parseBrokerPage` — JSON-LD-first/DOM-fallback, PII excluded | VERIFIED | Allow-list field access only; PII deep-search test passes; no-fabrication test for renovationStatus passes. |
| `src/lib/broker/merge-listing-fields.ts` | `fillGap`/`mergeListingFields` — gap-fill-only with provenance | VERIFIED | Imports `Sourced`/`ListingSource` from schema module (no duplicate type); never-overwrite test present and green. |
| `src/actions/analyze.ts` | broker-enrichment step (independent-degradation) + merge fold + `brokerFetchFailed` signal | VERIFIED | Non-rethrowing try/catch confirmed by inspection (no `return { error` inside the broker catch block); `fieldSources`/`brokerFetchFailed` persisted into JSONB `listing_data`. |
| `src/actions/analyze.test.ts` | integration test — broker failure never fails analyzeUrl; gap-fill provenance; no PII persisted | VERIFIED | 7 tests, all passing, covering every behavior the plan specifies. |
| `src/components/listing-summary.tsx` | Våning/Balkong/Renoveringsstatus MetricCards + Beskrivning prose + provenance captions + broker-fetch-failed banner | VERIFIED | All four labels present; `sourceCaption` prop wired; banner uses exact UI-SPEC copy; `npx tsc --noEmit` clean. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `client.ts reshapeListingEntity` | `__fixtures__/listing-detail.json` | floor.raw / amenities ref-key / final breadcrumb label | WIRED | Fixture contains `Amenity:{"key":"balcony"}` ref and final breadcrumb `{"label":"HSB BRF Metern","url":"/bostadsrattsforening/82768"}`; tests assert extraction against this exact fixture. |
| `schemas/listing.ts normalizeScraperOutput` | reshaped Apollo object keys | num/str/rawOf coercion | WIRED | `normalizeScraperOutput` reads `raw.floor`/`raw.balcony`/`raw.renovationStatus`/`raw.description`; tested directly. |
| `fetch-broker-page.ts` | `url-guard.ts isSafeExternalUrl` | guard-before-fetch | WIRED | `isSafeExternalUrl` awaited before any `fetch()` call; test proves `fetch` is never called when the guard returns false. |
| `fetch-broker-page.ts` | `parse-broker-page.ts parseBrokerPage` | `res.text()` then `parseBrokerPage(html)` | WIRED | Confirmed by direct read + integration test returning parsed fields on success. |
| `merge-listing-fields.ts` | `schemas/listing.ts Sourced<T>` | import, not duplicate definition | WIRED | `import type { Sourced, ListingSource } from "@/lib/schemas/listing"` — single source of truth. |
| `analyze.ts` | `broker/fetch-broker-page.ts fetchBrokerListingPage` | non-rethrowing try/catch after normalizeScraperOutput | WIRED | Confirmed by reading `analyze.ts:115-129`; catch sets `brokerFetchFailed=true`, never returns `{error}`. |
| `analyze.ts` | `broker/merge-listing-fields.ts mergeListingFields` | fold into listingData before `analyses.insert` | WIRED | `merged.*.value`/`merged.*.source` folded into `listingData` object literal before the DB insert / guest return. |
| `listing-summary.tsx` | listingData provenance fields | `MetricCard sourceCaption` prop + Beskrivning prose block | WIRED | `sourceCaptionFor(fieldSources?.floor/balcony/renovationStatus/description/brfName)` wired to every relevant MetricCard/prose block. |
| `url-input.tsx` / `page.tsx` (guest flow) | `brokerFetchFailed` from `analyzeUrl` result | `onResult` 4th argument | WIRED | Confirmed: `onResult?.(data, partial, missingFields, result.brokerFetchFailed)` → `page.tsx handleResult` → `ListingSummary brokerFetchFailed={result.brokerFetchFailed}`. |
| `analysis/[id]/page.tsx` (auth flow) | persisted `listing_data.brokerFetchFailed` | read off Zod-parsed `listingData` | WIRED | `brokerFetchFailed={listingData.brokerFetchFailed ?? false}` passed to `ListingSummary`. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| `listing-summary.tsx` Våning/Balkong MetricCards | `data.floor`/`data.balcony` | `analyze.ts` → `merged.floor.value`/`merged.balcony.value` ← `mergeListingFields` ← Apollo entity via `client.ts` | Yes — traced to a real Apollo `Listing:<id>` entity field (`entry.floor`, `entry.amenities`), not a static/empty fallback | FLOWING |
| `listing-summary.tsx` Renoveringsstatus MetricCard + Beskrivning block | `data.renovationStatus`/`data.description` | `analyze.ts` → `merged.*.value` ← `mergeListingFields` ← `fetchBrokerListingPage` → `parseBrokerPage` (cheerio JSON-LD/DOM extraction of real broker HTML) or Booli-side value | Yes when either source has data; degrades honestly to `null`/"Ej tillgänglig" only when BOTH Booli and broker lack the field (not a hardcoded stub) | FLOWING |
| `listing-summary.tsx` provenance captions | `fieldSources.*` | `analyze.ts` → `merged.*.source` ← `fillGap` (booli/maklare/null based on actual value presence) | Yes — tag reflects genuine merge decision, not a hardcoded label | FLOWING |

No hollow props or disconnected data sources found — every rendered field traces to either the live Apollo entity or the live broker-page parse, with honest null-degradation as the only fallback (never a fabricated default).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full test suite green (all Phase 6 + regression) | `npx vitest run` | 25 test files passed, 1 skipped; 262 tests passed, 1 skipped, 6 todo | PASS |
| Type-check clean across schema/broker/action/component | `npx tsc --noEmit` | No output (clean) | PASS |
| Lint clean on all Phase-6-touched files | `npx eslint src/lib/broker src/lib/schemas/listing.ts src/lib/booli/client.ts src/actions/analyze.ts src/components/listing-summary.tsx src/components/url-input.tsx "src/app/(app)/analysis/[id]/page.tsx"` | 1 pre-existing unrelated warning (`router` unused in `url-input.tsx`, present since Feb 2026, predates Phase 6) | PASS (no new issues) |
| Real fixture extraction (floor=3, balcony=true, brfName="HSB BRF Metern") | `npx vitest run src/lib/booli/client.test.ts` | Passing, asserted against `__fixtures__/listing-detail.json` | PASS |
| Amenity substring-bypass guard (`balconyView` ≠ `balcony`) | `npx vitest run src/lib/booli/client.test.ts -t "does NOT produce a false positive"` | Passing | PASS |
| SSRF guard rejects cloud-metadata IP (169.254.169.254) | `npx vitest run src/lib/broker/url-guard.test.ts` | Passing | PASS |
| PII deep-search (parser level + persistence level) | `npx vitest run src/lib/broker/parse-broker-page.test.ts src/actions/analyze.test.ts` | Both passing | PASS |
| Broker-failure-never-fails-primary (integration) | `npx vitest run src/actions/analyze.test.ts` | Passing (7/7) | PASS |
| No-overwrite merge contract | `npx vitest run src/lib/broker/merge-listing-fields.test.ts` | Passing (7/7) | PASS |

### Probe Execution

No `scripts/*/tests/probe-*.sh` probes found and none declared in the Phase 6 plans/summaries (this phase is not a migration/CLI-tooling phase). SKIPPED — not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| LSTG-03 | 06-01, 06-02, 06-03 | Recover floor/våning, balcony, BRF name, renovation status, full description via the broker's own page | SATISFIED | All 5 fields recovered and rendered end-to-end (Truths 1, 5-9 above). |
| LSTG-04 | 06-01, 06-02, 06-03 | Gap-fill-only, never overwrite Booli data, preserve provenance; broker failure never fails primary analysis | SATISFIED | `fillGap`/`mergeListingFields` never-overwrite contract tested at both unit and integration level (Truths 2-3, 9 above); independent-degradation try/catch confirmed by code inspection + test. |

No orphaned requirements found — REQUIREMENTS.md maps only LSTG-03/LSTG-04 to Phase 6, and both are claimed by all three plans' frontmatter.

### Anti-Patterns Found

None. Scanned all files modified in this phase (`src/lib/schemas/listing.ts`, `src/lib/booli/client.ts`, `src/lib/broker/*.ts`, `src/actions/analyze.ts`, `src/components/listing-summary.tsx`, `src/components/url-input.tsx`, `src/app/page.tsx`, `src/app/(app)/analysis/[id]/page.tsx`) for TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER markers, "not yet implemented"/"coming soon" strings, empty-return stubs, and hardcoded-empty-prop patterns. Zero matches. One pre-existing, unrelated ESLint warning (`router` unused in `url-input.tsx`, predates Phase 6 by ~4 months) — not a Phase 6 regression, not a blocker.

One minor pre-existing quirk noted but NOT a Phase-6 introduced issue: `listing-summary.tsx`'s brfName-missing conditional (`!isMissing("brfName") || (<p>...</p>)`) is an unusual short-circuit JSX idiom that predates this phase (introduced in the original `feat(01-02)` commit, unchanged by Phase 6's edits to the surrounding brfName block other than adding the `brfNameCaption` render). Functions correctly; flagged for awareness only.

### Human Verification Required

### 1. Live broker-CMS coverage + degradation + PII sample

**Test:** With `APIFY_API_TOKEN` set and `npm run dev` running, paste 3-5 real, currently-active Booli listing URLs (from different brokerages where distinguishable — Vitec Express, Mspecs, a bespoke agency site) into the analyze form.
**Expected:** Våning/Balkong/BRF populate from Booli with a "Källa: Booli" caption (near-100% hit rate expected, Apollo-sourced). Renoveringsstatus/Beskrivning either populate with "Källa: Mäklarens annons" or show "Ej tillgänglig" (a low hit rate here is informational, not a bug — RESEARCH Open Question 1). No mäklare name/phone/email appears anywhere in the rendered report. When a broker page fails to parse, the soft terracotta banner appears and the rest of the analysis (address/price/area/rooms/sold-comps) renders exactly as before. Server logs show `[broker]` lines on any fetch failure, never a silent failure or a thrown error surfacing to the user.
**Why human:** Requires a live `APIFY_API_TOKEN`, a running dev server, and real third-party broker-page markup/coverage across multiple CMS vendors — none of which can be simulated by synthetic HTML fixtures or unit/integration tests. This is the exact checkpoint the 06-03-PLAN.md `checkpoint:human-verify` task specifies, explicitly deferred to the operator by the executor (confirmed in 06-03-SUMMARY.md's "User Setup Required" section) — the same deferral pattern used at the end of Phase 5.

### Gaps Summary

No code-level gaps found. All 9 derived observable truths (4 ROADMAP Success Criteria + 5 plan-level implementation truths) are VERIFIED against the actual codebase: the schema/model extensions, Apollo extractors, SSRF guard, JSON-LD/DOM parser, PII exclusion, gap-fill-only merge, independent-degradation wiring, and UI provenance rendering are all present, substantive (not stubs), correctly wired, and covered by passing tests (262 passed, 1 skipped, 6 todo; `tsc --noEmit` clean; `eslint` clean aside from one unrelated pre-existing warning). The only unresolved item is the live end-to-end operator checkpoint (real Booli listings + real APIFY_API_TOKEN + real broker-CMS sampling), which was intentionally designed as a human checkpoint in 06-03-PLAN.md and is not achievable through static code verification — this routes the phase to `human_needed`, not `gaps_found`.

---

*Verified: 2026-07-06T19:08:36Z*
*Verifier: Claude (gsd-verifier)*
