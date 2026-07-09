---
phase: 06-deeper-listing-extraction
plan: 01
subsystem: api
tags: [zod, apollo-state, booli, listing-schema, provenance]

# Dependency graph
requires:
  - phase: 05-owned-booli-acquisition
    provides: Owned client.ts (fetchListing/reshapeListingEntity) already fetching the full Apollo Listing:<id> entity, including floor/amenities/breadcrumbs
provides:
  - floor/balcony/renovationStatus/description as additive .nullable() fields on listingDataSchema + NormalizedListing (brfName already existed)
  - Sourced<T> + ListingSource provenance contract for Plan 02's gap-fill merge
  - amenityKeys()/brfNameFromBreadcrumbs() Apollo extractors, strict-parsed (no substring bypass)
  - floor/balcony/brfName wired end-to-end from Apollo entity through analyze.ts's persisted listingData, with zero new network call
affects: [06-02-broker-page-fetch, 06-03-ui-provenance-display]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Read-what's-already-there before fetching more: 3 of 5 'fields Booli lacks' were already inline in the Apollo entity from Phase 5's owned client"
    - "Strict ref-key JSON.parse + exact .key equality for Apollo Amenity: refs (never .includes substring match)"

key-files:
  created: []
  modified:
    - src/lib/schemas/listing.ts
    - src/lib/schemas/listing.test.ts
    - src/lib/booli/client.ts
    - src/lib/booli/client.test.ts
    - src/actions/analyze.ts

key-decisions:
  - "Sourced<T>/ListingSource co-located in listing.ts (not a broker-specific module) since analyze.ts and listing-summary.tsx both import from here"
  - "reshapeListingEntity keeps its existing floor:entry.floor passthrough unchanged rather than adding a duplicate floor: key — the plan's literal snippet would have silently shadowed it; normalizeScraperOutput's existing num()??rawOf() chain already unwraps the {raw:3} shape correctly"
  - "analyze.ts destructures and threads the four new normalizeScraperOutput fields through to listingData (Rule 3 fix: additive nullable schema fields otherwise fail ListingData's object-literal typecheck)"

patterns-established:
  - "Provenance types (Sourced<T>) live beside the schema/model types they annotate, not in the feature module that first needs them"

requirements-completed: [LSTG-03, LSTG-04]

# Metrics
duration: 25min
completed: 2026-07-06
---

# Phase 6 Plan 1: Apollo-Derived Field Extraction + Provenance Contract Summary

**floor/balcony/brfName recovered from the existing Booli Apollo entity with zero new network calls, plus the Sourced\<T\> provenance contract Plan 02's broker gap-fill will populate**

## Performance

- **Duration:** 25 min
- **Started:** 2026-07-06T18:35:00Z
- **Completed:** 2026-07-06T18:41:06Z
- **Tasks:** 2 completed
- **Files modified:** 5 (2 planned files extended per task, plus 1 Rule-3 wiring fix in analyze.ts)

## Accomplishments
- Confirmed and implemented RESEARCH's central finding: 3 of the 5 "fields Booli lacks" (floor, balcony, brfName) are already present in the Phase-5 owned client's Apollo entity — no broker-page fetch needed for them
- Extended `listingDataSchema`/`NormalizedListing` with all 5 recoverable fields as additive `.nullable()` fields (no migration, JSONB `listing_data` absorbs them)
- Defined and exported `Sourced<T>`/`ListingSource`, the provenance contract Plan 02's gap-fill merge will populate
- Added `amenityKeys()` and `brfNameFromBreadcrumbs()` Apollo extractors with strict-parse discipline (JSON.parse + exact `.key` equality, never `.includes()` substring match — closes the Pitfall 3 false-positive risk)
- Wired the new fields end-to-end through `analyze.ts` so floor/balcony/brfName actually reach persisted `listing_data`, not just the schema layer

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend listing schema with 5 nullable fields + Sourced\<T\> provenance type** - `35ff311` (feat)
2. **Task 2: Extract floor/balcony/brfName from the Apollo entity in reshapeListingEntity** - `dfd2bcb` (feat)

_No separate plan-metadata commit yet — SUMMARY/STATE/ROADMAP updates follow in this same execution pass._

## Files Created/Modified
- `src/lib/schemas/listing.ts` - Added `floor`/`balcony`/`renovationStatus`/`description` nullable fields to `listingDataSchema` + `NormalizedListing`; exported `ListingSource` + `Sourced<T>`; extended `normalizeScraperOutput` to read the four new raw fields
- `src/lib/schemas/listing.test.ts` - Extended with schema accept/reject tests, `Sourced<T>` type-check tests, and `normalizeScraperOutput` extraction tests for the four new fields; updated two pre-existing `toEqual` literals to include the new null-defaulted keys
- `src/lib/booli/client.ts` - Added `amenityKeys()` and `brfNameFromBreadcrumbs()` module-level extractors (both exported for direct unit testing); wired `balcony`/`brfName` as additive keys onto `reshapeListingEntity`'s returned object
- `src/lib/booli/client.test.ts` - Added fixture-backed + edge-case tests for both new helpers, plus reshape-level tests via `fetchListing` against the real redacted fixture
- `src/actions/analyze.ts` - Destructured and threaded the four new `normalizeScraperOutput` fields into the persisted `listingData` object (Rule 3 fix — see Deviations)

## Decisions Made
- `Sourced<T>`/`ListingSource` co-located in `listing.ts` rather than a new broker module, per RESEARCH's guidance that `analyze.ts` and `listing-summary.tsx` both import listing types from here
- Kept the existing `floor: entry.floor ?? undefined` passthrough in `reshapeListingEntity` unchanged instead of literally following the plan's `floor: rawOf(entry.floor) ?? num(entry.floor) ?? undefined` snippet, because adding a second `floor:` key in the same object literal would silently shadow the first (JS duplicate-key semantics, last wins) — and `normalizeScraperOutput`'s existing `num(raw.floor) ?? rawOf(raw.floor)` chain (Task 1) already correctly unwraps the passthrough's `{raw: 3}` shape into `3`. Verified with a standalone Node check before deciding.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Wired new schema fields through analyze.ts's listingData construction**
- **Found during:** Task 2 (post-implementation `tsc --noEmit` check)
- **Issue:** Adding four new required-but-nullable fields to `ListingData` (via `listingDataSchema`) broke `analyze.ts`'s `const listingData: ListingData = {...}` object literal — TS2739, missing `floor`/`balcony`/`renovationStatus`/`description` properties. This is the actual persistence call site the plan's own objective depends on ("floor/balcony/brfName populated from Apollo in client.ts" implies they reach the analysis record, not just the schema type).
- **Fix:** Destructured the four new fields from `normalizeScraperOutput`'s return value and added them to the `listingData` object literal alongside the existing fields.
- **Files modified:** src/actions/analyze.ts
- **Verification:** `npx tsc --noEmit` clean; full test suite green (230 passed, 1 skipped, 6 todo)
- **Committed in:** dfd2bcb (Task 2 commit)

**2. [Rule 1 - Bug] Avoided a duplicate-key shadow bug in reshapeListingEntity**
- **Found during:** Task 2 (implementation, before committing)
- **Issue:** The plan's action text specified adding a `floor: rawOf(entry.floor) ?? num(entry.floor) ?? undefined` key to `reshapeListingEntity`'s return object, but that file already has an earlier `floor: entry.floor ?? undefined` passthrough key in the SAME object literal. Two same-named keys in one JS object literal is not a TypeScript error — the second silently wins, which is a correctness bug the plan's own reviewer would likely have flagged, and its "keep the existing raw floor/amenities/breadcrumbs passthrough lines unchanged" instruction directly conflicts with also adding a second `floor:` key.
- **Fix:** Did not add a duplicate `floor:` key. Verified (via a standalone Node snippet mirroring the real coercion helpers) that the existing passthrough's `{raw: 3}` shape already flows correctly through Task 1's `normalizeScraperOutput` coercion (`num(raw.floor) ?? rawOf(raw.floor)` → `3`), so no behavior was lost — only `balcony`/`brfName`, which have no existing passthrough key to collide with, were added as new keys.
- **Files modified:** src/lib/booli/client.ts
- **Verification:** `reshapeListingEntity` (via `fetchListing`) test asserts `rawOf(result.floor) ?? result.floor === 3` against the real fixture; full suite green.
- **Committed in:** dfd2bcb (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking type-error fix, 1 bug avoidance during implementation)
**Impact on plan:** Both were necessary for correctness — the plan's literal instruction for the `floor` key would have introduced a silent duplicate-key bug, and the `analyze.ts` wiring was implied by the plan's own objective but not explicitly listed in `files_modified`. No scope creep — no broker-page work, no new fields beyond the plan's five, no UI changes.

## Issues Encountered
None beyond the two deviations documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 02 (broker-page fetch for renovationStatus/description) can now import `Sourced<T>`/`ListingSource` directly from `src/lib/schemas/listing.ts` rather than defining its own provenance shape
- `floor`/`balcony`/`brfName` are already populated end-to-end (Apollo → normalizeScraperOutput → analyze.ts → persisted `listing_data`) with zero broker dependency — Plan 02 only needs to gap-fill `renovationStatus`/`description`
- No blockers. Full test suite green (230 passed, 1 skipped, 6 todo, no regressions), `tsc --noEmit` clean, lint clean on all touched files

---
*Phase: 06-deeper-listing-extraction*
*Completed: 2026-07-06*

## Self-Check: PASSED

All created/modified files verified present on disk; all referenced commit hashes (35ff311, dfd2bcb) verified present in git history.
