---
phase: 06-deeper-listing-extraction
plan: 03
subsystem: api
tags: [server-actions, provenance, broker-page, degradation, react]

# Dependency graph
requires:
  - phase: 06-deeper-listing-extraction
    plan: 01
    provides: Sourced<T>/ListingSource provenance contract + floor/balcony/renovationStatus/description nullable schema fields
  - phase: 06-deeper-listing-extraction
    plan: 02
    provides: src/lib/broker/ module (fetchBrokerListingPage, mergeListingFields, SSRF guard, JSON-LD/DOM parse)
provides:
  - analyzeUrl's broker-enrichment step wired end-to-end (independent-degradation try/catch, never rethrows)
  - gap-fill-only merge persisted into listing_data with a new additive fieldSources provenance map + brokerFetchFailed flag (JSONB, no migration)
  - ListingSummary rendering all 5 recovered fields (Våning/Balkong/BRF/Renoveringsstatus/Beskrivning) with Källa provenance captions + honest Ej tillgänglig degradation + soft broker-fetch-failed banner
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Independent-degradation try/catch at the controller boundary (analyze.ts): a second, INVERTED try/catch beside the existing rethrowing fetchListing block — catch sets a flag and continues, never returns {error}"
    - "Provenance persisted as a parallel additive-nullable map (fieldSources) alongside the flat value fields, rather than wrapping every field in {value, source} — keeps ListingData's existing flat shape unchanged for all pre-Phase-6 consumers"
    - "sourceCaption as an optional MetricCard prop, omitted (not empty-string) when the field is missing — no caption for a null field"

key-files:
  created:
    - src/actions/analyze.test.ts
  modified:
    - src/actions/analyze.ts
    - src/lib/schemas/listing.ts
    - src/lib/schemas/listing.test.ts
    - src/components/listing-summary.tsx
    - src/components/url-input.tsx
    - src/app/page.tsx
    - src/app/(app)/analysis/[id]/page.tsx

key-decisions:
  - "Added fieldSources (a Record<field, 'booli'|'maklare'|null>) and brokerFetchFailed as new additive-nullable/optional fields on listingDataSchema — not explicitly named in the plan's Task 1 action text, but required by Task 2's own read_first note ('how provenance/source is carried on listingData') and the plan's objective line ('provenance-tagged fields persist into the existing JSONB listing_data column'). Both are additive JSONB keys, no migration."
  - "brokerFetchFailed threaded through UrlInput's onResult callback (guest flow) and read off the persisted listingData.brokerFetchFailed (authenticated flow) — required for the banner to ever render; not itemized in the plan's files_modified but implied by the plan's own success criteria."
  - "Only the merged .value + a 'booli'/'maklare'/null tag are ever persisted — never a raw brokerFields object — so fieldSources cannot become a second PII-leak vector."

patterns-established:
  - "A second banner block gated on a distinct boolean prop, reusing the exact same bg-terracotta-50/text-terracotta-600 classes as an existing banner, rather than merging two unrelated conditions into one flag"

requirements-completed: [LSTG-03, LSTG-04]

# Metrics
duration: 26min
completed: 2026-07-06
---

# Phase 6 Plan 3: Broker-Enrichment Wiring + Provenance UI Summary

**analyzeUrl gap-fills renovationStatus/description from a broker page in a non-rethrowing try/catch, and ListingSummary renders all 5 recovered fields with Källa: Booli/Mäklarens annons provenance captions and a soft degradation banner**

## Performance

- **Duration:** 26 min
- **Started:** 2026-07-06T20:56:00Z
- **Completed:** 2026-07-06T21:22:00Z
- **Tasks:** 2 completed (+ 1 checkpoint deferred to operator, see below)
- **Files modified:** 7 (1 created, 6 modified)

## Accomplishments
- Wired `fetchBrokerListingPage` + `mergeListingFields` into `analyzeUrl`, inserted between `normalizeScraperOutput` and the `listingData` assembly, exactly per RESEARCH Pattern 4 (INVERTED from the existing `fetchListing` rethrow above it) — a broker fetch rejection or `null` result sets `brokerFetchFailed` and continues; it can never surface as `{ error }`
- `mergeListingFields` gap-fills `renovationStatus`/`description` from the broker page only when Booli lacked them; `floor`/`balcony`/`brfName` stay unconditional on the Apollo/Booli side regardless of broker outcome (Pitfall 1)
- Extended `listingDataSchema` with two new additive fields — `fieldSources` (a per-field `booli`/`maklare`/`null` provenance map) and `brokerFetchFailed` — both nullable/optional so old persisted rows parse unchanged; only the tag (never a raw broker object) is persisted, closing off a second PII vector
- Wrote `src/actions/analyze.test.ts`, the first integration test for this server action: 7 tests covering broker-rejection-never-fails-primary, gap-fill-vs-never-overwrite provenance, Apollo-fields-unconditional, a deep-search no-PII assertion (including a simulated PII-shaped broker payload), the `brokerFetchFailed` signal on failure/success/skip
- `ListingSummary` now renders Våning/Balkong/Renoveringsstatus `MetricCard`s + a full-width Beskrivning prose block, each with a "Källa: Booli"/"Källa: Mäklarens annons" caption when populated (report-flags.tsx's exact `Källa: {sourceLabel}` pattern) and the existing "Ej tillganglig" treatment when absent; captions are omitted for missing fields per UI-SPEC's "only cite when there's something to cite" rule
- Added a second, independent soft terracotta banner gated on `brokerFetchFailed` (not `partial`) with the exact UI-SPEC copy, so a broker-page failure is visually distinct from a primary-analysis problem
- Threaded `brokerFetchFailed` through both render paths so the feature is actually reachable end-to-end: `UrlInput`'s `onResult` callback (guest flow, in-memory) and `analysis/[id]/page.tsx` reading it off the persisted `listing_data` JSONB (authenticated flow)

## Task Commits

Each task was committed atomically (RED→GREEN for the TDD task):

1. **Task 1 RED: failing integration test for analyzeUrl broker enrichment** - `f5aa3ea` (test)
2. **Task 1 GREEN: wire broker-enrichment into analyzeUrl** - `4368b0a` (feat)
3. **Task 2: render 5 recovered fields with provenance + broker-fetch banner** - `7c993fd` (feat)

_No separate plan-metadata commit yet — SUMMARY/STATE/ROADMAP updates follow in this same execution pass._

## Files Created/Modified
- `src/actions/analyze.ts` - Added the broker-enrichment try/catch (never rethrows), the `mergeListingFields` fold, `fieldSources`/`brokerFetchFailed` on the persisted `listingData`, and `brokerFetchFailed` on all three `AnalyzeResult` success/error variants
- `src/actions/analyze.test.ts` - NEW. 7 integration tests: broker-rejection-never-fails-primary, gap-fill provenance (never-overwrite), Apollo-fields-unconditional, no-PII-persisted (deep-search + simulated PII-shaped broker payload), brokerFetchFailed on failure, no-flag on success, skip-when-no-agencyListingUrl
- `src/lib/schemas/listing.ts` - Added `fieldSources` (nullable object of 5 `ListingSource` enums) and `brokerFetchFailed` (nullable boolean) to `listingDataSchema`, both additive/optional so pre-Phase-6 rows still parse
- `src/lib/schemas/listing.test.ts` - Added 4 tests for the new schema fields: fully-populated accept, null/omitted accept (backward compat), invalid-enum-value reject
- `src/components/listing-summary.tsx` - Extended `MetricCard` with `sourceCaption?`, added 3 new MetricCards + a Beskrivning prose block + a second broker-fetch-failed banner + a `brfName` provenance caption; new `brokerFetchFailed` prop on `ListingSummaryProps`
- `src/components/url-input.tsx` - `onResult` callback signature extended with a 4th `brokerFetchFailed` argument, forwarded from `analyzeUrl`'s result
- `src/app/page.tsx` - Guest-flow result state extended with `brokerFetchFailed`, passed through to `ListingSummary`
- `src/app/(app)/analysis/[id]/page.tsx` - Authenticated-flow `ListingSummary` now reads `brokerFetchFailed` off the persisted `listingData` JSONB

## Decisions Made
- `fieldSources`/`brokerFetchFailed` were not spelled out verbatim in Task 1's action text, but Task 2's own `read_first` note ("how provenance/source is carried on listingData") and the plan objective's line ("the merged, provenance-tagged fields persist into the existing JSONB listing_data column") make clear the UI cannot render `Källa:` captions without some persisted provenance signal. Both fields are additive-nullable/optional JSONB keys — no schema migration, no impact on existing rows.
- Threading `brokerFetchFailed` through `UrlInput`/`page.tsx`/`analysis/[id]/page.tsx` was necessary for the banner to ever actually render for either user path (guest or authenticated) — this wasn't itemized in the plan's `files_modified` (only `analyze.ts`/`analyze.test.ts`/`listing-summary.tsx` were listed) but is required by the plan's own success criteria ("a soft terracotta banner...never a blocking error").
- Kept the codebase's pre-existing ASCII-only "Ej tillganglig"/"BRF-namn ej tillgangligt" convention in the new Beskrivning block (matching the existing `MetricCard`'s exact copy) rather than switching to "Ej tillgänglig" with the diacritic, since that convention is already established in this same file and changing it would be an unrelated, out-of-scope rewrite of existing UI copy.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added fieldSources + brokerFetchFailed as new persisted schema fields**
- **Found during:** Task 1 implementation (before writing the GREEN code)
- **Issue:** The plan's Task 1 action text describes merging renovationStatus/description into `listingData` and surfacing `brokerFetchFailed` on `AnalyzeResult`, but Task 2 needs a way to know WHICH source populated each field (to render "Källa: Booli" vs "Källa: Mäklarens annons") and whether the broker fetch failed for the DB-persisted (authenticated) flow, where the in-memory `AnalyzeResult` from `analyzeUrl` is discarded after the redirect. Without a persisted provenance signal, Task 2's UI-SPEC contract ("every populated field shows its source caption") is unimplementable for logged-in users.
- **Fix:** Added `fieldSources` (a `{floor, balcony, brfName, renovationStatus, description}` map of `"booli"|"maklare"|null`) and `brokerFetchFailed` (boolean) as new additive-nullable/optional fields on `listingDataSchema`, populated in `analyze.ts` from the `mergeListingFields` result and persisted into the same JSONB `listing_data` column (no migration).
- **Files modified:** src/lib/schemas/listing.ts, src/lib/schemas/listing.test.ts, src/actions/analyze.ts
- **Verification:** New schema tests pass (fully-populated, null, omitted, invalid-enum-reject); full suite green; tsc clean.
- **Committed in:** 4368b0a (Task 1 GREEN commit)

**2. [Rule 2 - Missing Critical] Threaded brokerFetchFailed through both render paths**
- **Found during:** Task 2 implementation
- **Issue:** `ListingSummary` accepting a `brokerFetchFailed` prop is necessary but not sufficient — neither call site (`app/page.tsx`'s guest flow via `UrlInput`'s `onResult`, nor `analysis/[id]/page.tsx`'s authenticated flow) was passing it, so the banner could never actually render for either user.
- **Fix:** Extended `UrlInput`'s `onResult` callback signature with a 4th `brokerFetchFailed` argument (forwarded from `analyzeUrl`'s result), extended `app/page.tsx`'s result state to carry it through to `ListingSummary`, and read it directly off `listingData.brokerFetchFailed` in the authenticated page (the JSONB-persisted value survives the redirect).
- **Files modified:** src/components/url-input.tsx, src/app/page.tsx, src/app/(app)/analysis/[id]/page.tsx
- **Verification:** tsc clean across all four files; full suite green (no test regressions).
- **Committed in:** 7c993fd (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 2 — missing critical functionality implied by the plan's own success criteria but not itemized in `files_modified`)
**Impact on plan:** Both were necessary for the plan's own stated LSTG-03/04 success criteria to be reachable end-to-end (provenance captions rendering; the broker-fetch-failed banner actually firing). No scope creep — no new fields beyond the plan's five recovered fields plus their provenance/failure signal, no new routes, no UI beyond the additive `ListingSummary` extension the plan specified.

## Issues Encountered
None beyond the two deviations documented above. `npx vitest run` (262 passed, 1 skipped, 6 todo), `npx tsc --noEmit`, and `npx eslint` on all touched files were all clean throughout.

## User Setup Required

None for the automated portion — no new environment variables or external service configuration.

**However, this plan's final task is a blocking `checkpoint:human-verify` for LIVE end-to-end verification, which this executor run explicitly could NOT perform** (no running dev server, no real `APIFY_API_TOKEN` exercised against a live listing, per the orchestrator's pre-approval note). Per the run's checkpoint-preapproval instructions, this checkpoint is treated as auto-approved-but-honestly-deferred — it has NOT been performed, only its automatable prerequisites (unit + integration tests, tsc, eslint) have.

### Operator Next Steps (deferred live verification)

Before considering LSTG-03/04's real-world coverage genuinely proven, run:

1. Ensure `APIFY_API_TOKEN` is set; start the app (`npm run dev`).
2. Paste 3-5 real, currently-active Booli listing URLs (ideally from different brokerages — a Vitec Express, an Mspecs, and a bespoke agency site if distinguishable) into the analyze form and submit each.
3. For each: confirm Våning, Balkong, and BRF populate from Booli (Apollo-derived, no broker fetch needed) with a "Källa: Booli" caption.
4. Confirm Renoveringsstatus + Beskrivning either populate with "Källa: Mäklarens annons" (broker page parsed) OR show "Ej tillganglig" — record roughly what fraction of sampled brokers yielded a parseable description (informational-spike data point per RESEARCH Open Question 1; a low hit rate is expected and NOT a bug).
5. Confirm NO mäklare name/phone/email appears anywhere in the rendered report.
6. Deliberately test degradation: if any listing's broker page fails to parse, confirm the soft terracotta banner ("Kunde inte hämta ytterligare uppgifter...") shows AND the rest of the analysis (address/price/area/rooms/sold-comps) renders exactly as before — the broker failure must never break the primary analysis.
7. Check server logs for `[broker]` lines on any fetch failure (never a silent failure, never a thrown error surfacing to the user).

Resume signal for that checkpoint: "approved" (with the observed broker-parse hit rate noted), or a description of any regression/PII leak found.

## Next Phase Readiness
- All of Phase 6's LSTG-03/LSTG-04 automated success criteria are met: broker-enrichment independent degradation (integration-tested), gap-fill-only merge with UI-observable provenance, no-PII-persisted (deep-search tested), full suite + tsc + eslint green
- The one unverified item is the live broker-CMS coverage sample (Open Question 1 from RESEARCH) — this requires a human operator with a live `APIFY_API_TOKEN` and real, currently-active Booli listings, which cannot be simulated by this executor. See "Operator Next Steps" above.
- No code blockers for closing out Phase 6 once the operator completes the deferred live-verification checkpoint.

---
*Phase: 06-deeper-listing-extraction*
*Completed: 2026-07-06*

## Self-Check: PASSED

All created/modified files verified present on disk; all referenced commit hashes (f5aa3ea, 4368b0a, 7c993fd) verified present in git history.
