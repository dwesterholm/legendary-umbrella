---
phase: 12-floor-plan-sun-path
plan: 03
subsystem: api
tags: [discovery-candidate, zod, pii-safety, sun-path, allowlist]

# Dependency graph
requires:
  - phase: 12-floor-plan-sun-path (Plan 01)
    provides: "computeSunExposure + extractOrientationFromDescription pure functions (src/lib/discovery/sun-path.ts)"
provides:
  - "DiscoveryCandidate/toCandidate/discoveryCandidateSchema extended with latitude, longitude, floor, and a DERIVED orientation ({facades, confidence} | null)"
  - "reshapeListingEntity surfaces description as a read-only local source for orientation derivation (never persisted)"
  - "Extended PII-safe allowlist tripwire (candidate.test.ts + job.test.ts exact-key assertions) covering the 4 new fields"
  - "Backward-compat: pre-Phase-12 persisted rows missing the 4 new keys still safeParse and normalize to null"
affects: [12-04-sun-path-ui]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Derive-once-persist-only-the-derived: raw.description is read ONLY as a local argument to extractOrientationFromDescription inside toCandidate, never added to the returned object literal (mirrors brfName's brfNameFromBreadcrumbs precedent)"
    - "rawOf() FormattedValue unwrap added to candidate.ts, mirroring normalizeScraperOutput's num(raw.floor) ?? rawOf(raw.floor) exactly — needed because toCandidate receives reshapeListingEntity's un-normalized output directly on the fetchAreaListings/job.ts path"

key-files:
  created: []
  modified:
    - src/lib/booli/client.ts
    - src/lib/booli/client.test.ts
    - src/lib/discovery/candidate.ts
    - src/lib/discovery/candidate.test.ts
    - src/lib/discovery/job.test.ts
    - src/lib/discovery/niche-score.test.ts
    - src/lib/discovery/vision.test.ts
    - src/components/discovery-candidate-card.test.tsx
    - src/components/discovery-results.test.tsx

key-decisions:
  - "floor uses num(raw.floor) ?? rawOf(raw.floor) (NOT num(raw.floor) alone) — confirmed via job.ts that toCandidate receives reshapeListingEntity's output directly (no normalizeScraperOutput unwrap step in that path), so floor still arrives as the raw Apollo {raw: 3} FormattedValue shape"
  - "description is read via str(raw.description) fed directly into extractOrientationFromDescription as a local expression — never assigned to a variable that could accidentally leak into the returned object literal"

patterns-established:
  - "Same additive-nullable .nullable().default(null) discipline extended a third consecutive phase (10, 11, 12) onto the same discovery_jobs.results JSONB blob — no migration"

requirements-completed: [DISC-06]

# Metrics
duration: 55min
completed: 2026-07-07
---

# Phase 12 Plan 03: Candidate Persistence for Sun-Path Inputs Summary

**DiscoveryCandidate gains latitude/longitude/floor + a PII-safe DERIVED orientation (never the raw description text), additive-nullable with zero new migration or network cost.**

## Performance

- **Duration:** 55 min
- **Started:** 2026-07-07T18:04:50Z
- **Completed:** 2026-07-07T18:57:07Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments

- `reshapeListingEntity` (src/lib/booli/client.ts) now surfaces `description` straight off the raw Apollo `Listing:` entity, mirroring the existing `streetAddress: str(entry.streetAddress) ?? undefined` passthrough exactly — a read-only flat-record field, not a persistence decision.
- `DiscoveryCandidate` / `toCandidate` / `discoveryCandidateSchema` extended with `latitude`, `longitude`, `floor`, and a DERIVED `orientation: { facades: Facade[]; confidence: number } | null` — the fourth and final field is computed ONCE at `toCandidate` time via Plan 01's `extractOrientationFromDescription(str(raw.description))`, then the raw text is discarded.
- `floor` correctly unwraps the raw Apollo `{raw: N}` FormattedValue shape via a new `rawOf()` helper in `candidate.ts` (`num(raw.floor) ?? rawOf(raw.floor)`), mirroring `normalizeScraperOutput`'s own unwrap exactly — this matters because `toCandidate` receives `reshapeListingEntity`'s output DIRECTLY on the `fetchAreaListings`/`job.ts` path, with no `normalizeScraperOutput` step in between, so `floor` is NOT pre-unwrapped there.
- The PII-safe allowlist tripwire was EXTENDED (never weakened) in both `candidate.test.ts` and the duplicate exact-key assertion in `job.test.ts` — both now assert the new 17-key set, and both include an explicit `hasOwnProperty(result, "description") === false` assertion proving the raw text never leaks even when it contains a seller name/phone number.
- Backward-compat proven: a pre-Phase-12 persisted row (Phase-11 shape, missing `latitude`/`longitude`/`floor`/`orientation` entirely) still `safeParse`s and normalizes all four to `null` (never `undefined`), per the file's own CR-01 discipline.

## Task Commits

Each task was committed atomically:

1. **Task 1: reshapeListingEntity emits description (read-only source for orientation, never persisted)** - `8599546` (feat, tdd RED→GREEN in one commit per this file's convention — RED test written and confirmed failing before the implementation edit, then committed together once green)
2. **Task 2: Extend DiscoveryCandidate / toCandidate / discoveryCandidateSchema with latitude/longitude/floor + derived orientation (PII-safe)** - `e37bd31` (feat)

_Note: both tasks are `tdd="true"`; for each, the RED test was written and run to confirm failure BEFORE the implementation edit, then a single commit was made once GREEN (this repo's established convention per prior Phase 10/11 plans — see 8a5f87a/b90f425 in git log for the same pattern) rather than separate RED/GREEN commits._

**Plan metadata:** (this commit, to follow)

## Files Created/Modified

- `src/lib/booli/client.ts` - `reshapeListingEntity` gains `description: str(entry.description) ?? undefined`, placed alongside the other `str(entry.*)` passthroughs
- `src/lib/booli/client.test.ts` - new describe block asserting description present-and-absent cases via `fetchListing`
- `src/lib/discovery/candidate.ts` - `DiscoveryCandidate` interface, `toCandidate`, and `discoveryCandidateSchema` extended with `latitude`/`longitude`/`floor`/`orientation`; new `rawOf()` coercion helper; imports `extractOrientationFromDescription`/`Facade` from `sun-path.ts`
- `src/lib/discovery/candidate.test.ts` - `ALLOWLIST_KEYS` extended; new PII-safety cases (orientation derived without persisting description; PII-in-description-without-keyword yields null orientation and no description key); new floor-FormattedValue-unwrap case; new pre-Phase-12 backward-compat describe block
- `src/lib/discovery/job.test.ts` - the duplicate exact-key allowlist assertion (independent of candidate.test.ts's) extended to the same 17-key set; `makeCandidate` factory updated with the 4 new fields
- `src/lib/discovery/niche-score.test.ts`, `src/lib/discovery/vision.test.ts`, `src/components/discovery-candidate-card.test.tsx`, `src/components/discovery-results.test.tsx` - out-of-scope `makeCandidate`/candidate-literal helpers updated with the 4 new required fields (Rule 3 blocking fix — `DiscoveryCandidate`'s widened type otherwise fails `tsc`)

## Decisions Made

- **floor unwrap:** Used `num(raw.floor) ?? rawOf(raw.floor)`, not the plan text's literal `num(raw.floor)` alone. Traced the actual call site (`job.ts:162`, `raw.map(toCandidate)` where `raw = fetchAreaListings(...)` returns `reshapeListingEntity`'s output directly, with no `normalizeScraperOutput` step) and confirmed against the real fixture (`listing-detail.json` floor: `{ __typename: "FormattedValue", raw: 3 }`) that `toCandidate` receives the un-normalized FormattedValue shape on this path. `num()` alone would silently null every floor value. This matches RESEARCH.md Open Question 5's own resolved recommendation exactly (`floor: num(raw.floor) ?? rawOf(raw.floor)`), which the plan's inline code snippet had abbreviated.
- **description read pattern:** `extractOrientationFromDescription(str(raw.description))` is called directly as an expression inside the returned object literal — `raw.description` is never assigned to an intermediate local variable, further reducing any chance of accidental capture/leakage.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] floor unwrap corrected from `num(raw.floor)` to `num(raw.floor) ?? rawOf(raw.floor)`**
- **Found during:** Task 2
- **Issue:** The plan's inline `toCandidate` code snippet (12-PATTERNS.md) showed `floor: num(raw.floor)`, but PATTERNS.md's own accompanying prose explicitly flagged this as needing confirmation: "confirm whichever raw record `toCandidate` actually receives already carries the UNWRAPPED numeric floor... before writing `floor: num(raw.floor)`." Tracing `job.ts`'s call site confirmed `toCandidate` receives `reshapeListingEntity`'s raw output directly — `floor` is still the Apollo `{raw: N}` FormattedValue shape there, not a bare number. `num()` alone would have silently nulled every floor value in production.
- **Fix:** Added a `rawOf()` helper to `candidate.ts` (mirroring the identical helper already in `client.ts` and `normalizeScraperOutput`) and used `num(raw.floor) ?? rawOf(raw.floor)`, matching RESEARCH.md's own resolved Open Question 5 recommendation.
- **Files modified:** src/lib/discovery/candidate.ts, src/lib/discovery/candidate.test.ts (added a dedicated unwrap test)
- **Commit:** e37bd31

**2. [Rule 3 - Blocking] Extended a second (independent) allowlist exact-key assertion in job.test.ts**
- **Found during:** Task 2, full-suite regression run
- **Issue:** `job.test.ts` carries its own independent exact-key allowlist assertion (not just candidate.test.ts's), which failed after widening `DiscoveryCandidate`. This is the same tripwire class the plan explicitly calls out — extending it (not weakening it) was mandatory to keep the PII guard intact.
- **Fix:** Extended the key list and full-object assertion to the new 17-key set with the 4 new fields all null.
- **Files modified:** src/lib/discovery/job.test.ts
- **Commit:** e37bd31

**3. [Rule 3 - Blocking] Updated 5 out-of-scope `makeCandidate`/candidate-literal test helpers**
- **Found during:** Task 2, `tsc --noEmit` full-project check
- **Issue:** `DiscoveryCandidate`'s widened required-field set broke type-checking in 5 test files outside this plan's declared `files_modified` list (niche-score.test.ts, vision.test.ts, job.test.ts, discovery-candidate-card.test.tsx, discovery-results.test.tsx) — each constructs full `DiscoveryCandidate` literals via a local `makeCandidate(overrides)` factory.
- **Fix:** Added `latitude: null, longitude: null, floor: null, orientation: null` to each factory's base object literal. No behavior change to any of these files' actual test assertions.
- **Files modified:** src/lib/discovery/niche-score.test.ts, src/lib/discovery/vision.test.ts, src/lib/discovery/job.test.ts, src/components/discovery-candidate-card.test.tsx, src/components/discovery-results.test.tsx
- **Commit:** e37bd31

---

**Total deviations:** 3 auto-fixed (1 bug, 2 blocking)
**Impact on plan:** All three necessary for correctness (floor unwrap) and to keep `tsc`/full test suite green. No scope creep — no new features added beyond what the plan specified.

## Issues Encountered

None beyond the deviations documented above.

## Confirmed Details (per plan's `<output>` requirement)

- **New exact allowlist key set** (17 keys, sorted): `address`, `areaLabel`, `brfName`, `constructionYear`, `floor`, `imageUrls`, `latitude`, `livingArea`, `longitude`, `orientation`, `price`, `rooms`, `sourceListingUrl`, `tenureForm`, `thumbnailUrl`, `vision`, `visionSkippedReason`.
- **Description is read-locally-and-discarded, confirmed:** `toCandidate` calls `extractOrientationFromDescription(str(raw.description))` as a direct expression inside the returned object literal — `raw.description` is never bound to a local variable and never appears as a key on the result. Tests assert `Object.prototype.hasOwnProperty.call(result, "description") === false` in three scenarios: (a) raw carries extra PII fields including `description`, (b) description contains a stated orientation (derives a real result), (c) description contains seller PII with no orientation keyword (derives null).
- **Confirmed floor unwrap shape actually reaching toCandidate:** `num(raw.floor) ?? rawOf(raw.floor)`. Traced end-to-end: `job.ts` → `fetchAreaListings()` → `extractListingEntities()` → `.map(reshapeListingEntity)` → `toCandidate` receives this array element directly, where `floor: entry.floor ?? undefined` (client.ts line ~315+7 after this plan's description addition) still carries the raw Apollo `{ __typename: "FormattedValue", raw: N }` shape, confirmed against the real fixture `listing-detail.json`.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 04 (sun-path UI) can now read `latitude`/`longitude`/`floor`/`orientation` directly off a persisted `DiscoveryCandidate` and pass them to Plan 01's `computeSunExposure` — the full input chain (scrape → allowlist → persist → read-back) is wired end-to-end for these four fields.
- No blockers. Full suite (603 tests, 3 skipped) + `tsc --noEmit` + `eslint` all green. No new migration file created (confirmed against `supabase/migrations/` directory listing).

---
*Phase: 12-floor-plan-sun-path*
*Completed: 2026-07-07*

## Self-Check: PASSED

All 9 modified source files and the SUMMARY.md itself verified present on disk; both task commits (8599546, e37bd31) verified present in git log.
