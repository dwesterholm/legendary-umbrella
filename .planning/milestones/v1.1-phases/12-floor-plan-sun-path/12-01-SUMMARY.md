---
phase: 12-floor-plan-sun-path
plan: 01
subsystem: discovery
tags: [suncalc, typescript, deterministic-math, discovery, sun-path]

# Dependency graph
requires:
  - phase: 10-niche-ranking
    provides: "computeNicheScore/niche-score.ts pure-scorer doc-comment + structural-separation conventions (analog for sun-path.ts's own doc header)"
  - phase: 06-deeper-listing-extraction
    provides: "brfNameFromBreadcrumbs's guard-clause-first / null-on-anything-unmatched deterministic-extraction skeleton (client.ts) — analog for extractOrientationFromDescription"
provides:
  - "computeSunExposure(latitude, longitude, floor, orientation): pure, suncalc-backed theoretical/unobstructed sun-exposure grid (4 facades x 3 seasons), null-sentinel on any missing input"
  - "extractOrientationFromDescription(description): pure Swedish väderstreck keyword scanner, never address-derived, never LLM-derived"
  - "suncalc npm dependency (^2.0.0), confirmed-live azimuth convention (degrees, north-zero, clockwise)"
affects: [12-02-vision-schema-remodel-potential, 12-03-candidate-persistence, 12-04-sun-path-ui]

# Tech tracking
tech-stack:
  added: ["suncalc@^2.0.0"]
  patterns:
    - "computeSunExposure mirrors niche-score.ts's pure/deterministic/no-I-O doc-comment discipline and its guard-clause-first null-sentinel contract (Pitfall 4)"
    - "extractOrientationFromDescription mirrors brfNameFromBreadcrumbs's guard-clause-first / null-on-no-match skeleton (client.ts)"
    - "Qualitative-only sun-exposure labels (no numeric hour counts) per UI-SPEC Copywriting Contract — avoids false precision"

key-files:
  created:
    - src/lib/discovery/sun-path.ts
    - src/lib/discovery/sun-path.test.ts
  modified:
    - package.json
    - package-lock.json

key-decisions:
  - "suncalc package-legitimacy gate: PRE-APPROVED per plan (research-verified live: 225k weekly downloads, maintainer mourner/Vladimir Agafonkin, zero deps, ships own types, no postinstall, slopcheck OK) — auto-approved, not stopped on, treated exactly like Phase 6's cheerio precedent"
  - "Installed suncalc v2.0.0's azimuth convention confirmed BOTH by reading node_modules/suncalc/index.d.ts AND by a live numeric check (getTimes().solarNoon -> getPosition -> azimuth ~180 at Stockholm lat/lon): degrees, north-zero, clockwise (0=N, 90=E, 180=S, 270=W) — matches the v2.0.0 README, NOT the stale v1.x radians/south-zero convention"
  - "node_modules/suncalc/LICENSE confirmed BSD-2-Clause-style (Copyright Volodymyr Agafonkin) — the npm registry's 'Proprietary' metadata field is a quirk, not the real license (Assumption A3 resolved)"
  - "Sun-exposure grid cells are QUALITATIVE Swedish descriptors only (Ingen direkt sol / Morgon-Kväll x låg-hög sol / Sol större delen av dagen) — never a numeric hour count, per UI-SPEC's explicit no-false-precision rule"
  - "3 season buckets (winter/springAutumn/summer) sampled at the winter solstice, an equinox (spring/autumn share one symmetric sun path), and the summer solstice — matches UI-SPEC's 3-season grid exactly"
  - "computeSunExposure accepts and requires a non-null floor parameter (kept in the signature per RESEARCH's forward-compat guidance for a future per-floor/obstructed-sun-path phase) even though v1's theoretical/unobstructed math does not vary the grid by floor height"
  - "extractOrientationFromDescription's own return does not depend on computeSunExposure's orientationConfidence; computeSunExposure reports a fixed 0.5 confidence on its own successful (non-null-input) path — callers needing the ORIGINAL extraction confidence read it from extractOrientationFromDescription's result directly, not from computeSunExposure"

patterns-established:
  - "First astronomy/geospatial-math dependency in the codebase (suncalc), isolated behind a mandatory azimuth-convention smoke test before any bucketing logic is trusted"
  - "Deterministic free-text keyword extraction with a hard 'never guess, never LLM, null on no match' contract — second instance after brfNameFromBreadcrumbs"

requirements-completed: [DISC-06]

# Metrics
duration: 14min
completed: 2026-07-07
---

# Phase 12 Plan 1: Sun-Path Deterministic Core Summary

**Shipped `computeSunExposure` (suncalc-backed, pure, theoretical/unobstructed sun-exposure grid) and `extractOrientationFromDescription` (Swedish väderstreck keyword scanner) — zero AI, zero network, azimuth convention numerically confirmed against the actually-installed suncalc v2.0.0 before any facade-bucketing logic was trusted.**

## Performance

- **Duration:** 14 min
- **Tasks:** 2 completed
- **Files modified:** 3 (2 created, 1 modified — package.json/package-lock.json counted as one dependency change)

## Accomplishments

- `suncalc` ^2.0.0 installed; package-legitimacy checkpoint auto-approved per plan pre-approval (see Package Legitimacy Audit below)
- Azimuth convention (degrees, north-zero, clockwise) confirmed via TWO independent checks: reading the installed `node_modules/suncalc/index.d.ts` comment, AND a live numeric check using `SunCalc.getTimes().solarNoon` -> `SunCalc.getPosition()` at Stockholm lat/lon, yielding azimuth ≈ 180.00 (south) — this matches the v2.0.0 README exactly and rules out the stale v1.x radians/south-zero convention some training data may reference
- `computeSunExposure(latitude, longitude, floor, orientation)` implemented: guard-clause-first, returns `byFacadeAndSeason: null` (never a zeroed/empty grid) whenever ANY of the 4 inputs is null; otherwise buckets 4 facades × 3 seasons into qualitative Swedish descriptors using each facade's ~180° visible azimuth arc + altitude-above-horizon check, sampled at the winter solstice / an equinox / the summer solstice
- `extractOrientationFromDescription(description)` implemented: guard-clause-first, null on no input or no keyword match, matches ONLY stated Swedish väderstreck phrases (söderläge/västerläge/norrläge/österläge + balkong/fönster variants), returns `{ facades, confidence: 0.5 }` on match — confirmed to NOT match a bare street-address substring (e.g. "Söderlångsgatan")
- 15/15 unit tests green, no mocking needed (pure functions); full suite (587 tests), `tsc --noEmit`, and `eslint` all clean

## Task Commits

Each task was committed atomically:

1. **Task 1: Install suncalc + verify azimuth convention** — `e5a5ab0` (feat)
2. **Task 2 (RED): Failing tests for computeSunExposure + extractOrientationFromDescription** — `eb72c89` (test)
3. **Task 2 (GREEN): Implement computeSunExposure + extractOrientationFromDescription** — `ab21523` (feat)

**Plan metadata:** pending — committed after this summary (final `docs(12-01)` commit).

## Files Created/Modified

- `package.json` / `package-lock.json` — `suncalc: ^2.0.0` added; no `@types/suncalc` (package ships its own `index.d.ts`)
- `src/lib/discovery/sun-path.ts` — NEW: `Facade`, `Season`, `SunQualityLabel`, `SunExposureResult` types; `computeSunExposure`; `extractOrientationFromDescription`; `ORIENTATION_KEYWORDS` regex table
- `src/lib/discovery/sun-path.test.ts` — NEW: azimuth-convention smoke test (run first), 4 independent null-propagation cases, facade/season bucketing correctness tests (all-facades non-null, north-never-sunniest, south-summer≥south-winter), 6 `extractOrientationFromDescription` cases

## Package Legitimacy Audit (suncalc)

| Check | Result |
|-------|--------|
| Gate disposition | **PRE-APPROVED** per plan instructions (research-verified: 225,106 weekly downloads, 15 yrs old, maintainer `mourner`/Vladimir Agafonkin, zero runtime deps, ships own TS types, no postinstall script, `slopcheck` `[OK]`) |
| Auto-approval action | Did NOT stop for a checkpoint; ran `npm install suncalc` directly, recorded the auto-approval here (mirrors STATE.md's "Phase 06 Plan 2: cheerio checkpoint auto-approved by orchestrator pre-verification" precedent) |
| Installed version | `2.0.0` (matches research's live registry check) |
| `@types/suncalc` | Not added — package ships its own `index.d.ts` |
| LICENSE glance | `node_modules/suncalc/LICENSE` — BSD-2-Clause-style text, "Copyright (c) 2026, Volodymyr Agafonkin" — confirms the npm registry's "Proprietary" metadata field is a quirk, not the real license (Assumption A3 resolved) |
| Azimuth convention (belt: docs) | `node_modules/suncalc/index.d.ts`: "All angles are in degrees; azimuth is north-based clockwise (0 = N, 90 = E, 180 = S, 270 = W)." |
| Azimuth convention (suspenders: live numeric check) | `SunCalc.getTimes(new Date('2026-03-20T12:00:00Z'), 59.33, 18.06).solarNoon` → `SunCalc.getPosition(solarNoon, 59.33, 18.06).azimuth` = `179.99999904613787` (≈180, south) — confirmed at both install time (Task 1, ad hoc) and in the committed test suite (Task 2, `sun-path.test.ts`'s first test, which must pass before any bucketing test is trusted) |

## Decisions Made

- Sun-exposure grid cells are strictly qualitative (6-value Swedish label enum) — never a numeric hour count, per UI-SPEC's Copywriting Contract; this was a design choice made during implementation (not pre-specified beyond "qualitative" in the plan) and documented as a key decision for Plan 04 (UI) to render verbatim
- 3 season buckets sampled at solstice/equinox/solstice (not a full monthly sweep) — the spring and autumn sun paths are astronomically symmetric at a given latitude, so one equinox reference date correctly represents both UI-SPEC season labels without duplicated computation
- `computeSunExposure`'s signature keeps a required (non-null) `floor` parameter even though v1's theoretical/unobstructed math doesn't vary by floor — matches the plan's exact signature and RESEARCH's explicit forward-compat rationale (a future obstructed/real sun-path phase, explicitly deferred, would need floor height); floor absence still correctly triggers the null sentinel like the other 3 inputs
- `computeSunExposure`'s own `orientationConfidence` field reports a fixed `0.5` on its success path (mirroring `extractOrientationFromDescription`'s own low-confidence convention) — this is NOT the same value as whatever confidence `extractOrientationFromDescription` originally computed for the orientation passed in; a future caller wiring both together (Plan 03) should read the original confidence from `extractOrientationFromDescription`'s own result if it needs to distinguish sources, not from `computeSunExposure`'s pass-through field

## Deviations from Plan

None — plan executed exactly as written. The plan's core acceptance criteria (guard-clause-first null sentinel, azimuth smoke test before bucketing logic, stated-orientation-only extraction, never-address/never-LLM, no `@types/suncalc`) were all met without needing any Rule 1-4 deviation.

## Stub Tracking

No stubs. Both exported functions are fully implemented (not placeholders) and covered by passing tests; `computeSunExposure`'s grid always contains real computed values (never a hardcoded/empty fallback) whenever its 4 inputs are non-null.

## Threat Flags

None beyond what the plan's own `<threat_model>` already registered (T-12-01, T-12-02, T-12-SC — all addressed by this plan's null-guard/keyword-only-extraction/pre-approved-install implementation, no new surface introduced).

## Issues Encountered

None. The azimuth convention matched the research document's primary hypothesis exactly (degrees/north-zero/clockwise) on the first live check — no convention-mismatch debugging was needed. All 15 tests passed on the first implementation attempt (single RED->GREEN cycle, no iteration needed).

## User Setup Required

None — no external service configuration required. `suncalc` needs no API key/secret; the module is pure/synchronous with zero network calls.

## Next Phase Readiness

Plan 03 (candidate persistence) can now:
- Add `latitude`/`longitude`/`floor`/`orientation` to `DiscoveryCandidate`'s PII-safe allowlist (mirroring Phase 10's `constructionYear`/`brfName`/`tenureForm` precedent)
- Call `extractOrientationFromDescription(raw.description)` ONCE at `toCandidate`-time and persist ONLY the derived `{ facades, confidence }` result — never the raw description text (PII risk, per RESEARCH Pitfall 3)
- Feed the persisted `latitude`/`longitude`/`floor`/`orientation` into `computeSunExposure` from Plan 04's UI component

Plan 04 (sun-path UI) can now:
- Render `computeSunExposure`'s `byFacadeAndSeason` grid directly — every cell is already a ready-to-display Swedish string, no further formatting/rounding needed
- Render the "ej tillgänglig" degraded state whenever `byFacadeAndSeason` is `null`

No blockers. `sun-path.ts` has zero dependency on any not-yet-built Phase 12 file (vision-schema.ts, candidate.ts extensions) — it was buildable and fully testable in complete isolation, exactly as the plan intended.

---
*Phase: 12-floor-plan-sun-path*
*Completed: 2026-07-07*

## Self-Check: PASSED

All 2 created source files (`src/lib/discovery/sun-path.ts`, `src/lib/discovery/sun-path.test.ts`) and this SUMMARY.md confirmed present on disk; all 3 task commit hashes (`e5a5ab0`, `eb72c89`, `ab21523`) confirmed present in `git log`.
