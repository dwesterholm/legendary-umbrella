---
phase: 12-floor-plan-sun-path
plan: 04
subsystem: ui
tags: [react, sun-path, floor-plan, vision, structural-separation, discovery]

# Dependency graph
requires:
  - phase: 12-floor-plan-sun-path (Plan 01)
    provides: "computeSunExposure(latitude, longitude, floor, orientation.facades) — pure, suncalc-backed theoretical sun-exposure grid; null sentinel on any missing input"
  - phase: 12-floor-plan-sun-path (Plan 02)
    provides: "remodelPotential 4th visionDeepPassSchema leaf + code-enforced disclaimer suffix, already rendering via ATTRIBUTE_LABELS.remodelPotential in the flat claims list"
  - phase: 12-floor-plan-sun-path (Plan 03)
    provides: "DiscoveryCandidate.latitude/longitude/floor/orientation (PII-safe, derived-only orientation)"
provides:
  - "SunPathExposure — Compass/warm-gray COMPUTED sub-block (src/components/sun-path-exposure.tsx), embedded inside GalleryConditionVision's CardContent"
  - "GalleryConditionVision floor-plan section-level reinforcement disclaimer (renders once when ≥1 remodelPotential claim exists)"
  - "discovery-results.tsx threading of candidate latitude/longitude/floor/orientation into GalleryConditionVision, never into the scorer"
  - "Structural-separation invariant (niche-score.test.ts) extended to also forbid a sun-path import in niche-score.ts/flags.ts"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Computed-vs-interpreted UI split materialized: Eye/terracotta (vision-derived, floor-plan included) vs Compass/warm-gray (sun-path, exact math) coexist inside ONE Card, per 12-UI-SPEC.md Color rationale"
    - "Sub-block-not-card component shape: SunPathExposure renders only inner markup (pt-4 border-t divider + sub-header + grid/degraded-line), no outer Card — embedded by its parent, mirrors the plan's recommended file-organization choice"

key-files:
  created:
    - src/components/sun-path-exposure.tsx
    - src/components/sun-path-exposure.test.tsx
  modified:
    - src/components/gallery-condition-vision.tsx
    - src/components/gallery-condition-vision.test.tsx
    - src/components/discovery-results.tsx
    - src/lib/discovery/niche-score.test.ts

key-decisions:
  - "SunPathExposure computes computeSunExposure in-component (client-safe pure function) rather than upstream, matching 12-PATTERNS.md's stated Claude's-discretion default — avoids threading a 5th computed prop through GalleryConditionVision/discovery-results when the 4 raw inputs are already threaded"
  - "Grid layout implemented as a plain CSS grid (CSS Grid via inline gridTemplateColumns, not a <table>) — season columns first (header row), then one row per KNOWN facade only, per UI-SPEC's 'never fabricate the other 3 facades as ej-tillgänglig rows' constraint"
  - "React.Fragment with an explicit key (not a bare <> shorthand) used for the per-facade grid-row group inside .map() — avoids a React key warning while keeping the grid a single flat CSS grid container (no nested <div> per facade row, which would break the column alignment)"

requirements-completed: [DISC-05, DISC-06]

# Metrics
duration: 6min
completed: 2026-07-07
---

# Phase 12 Plan 4: Frontend + Structural-Separation Invariant + Kill-Criterion Checkpoint Summary

**Shipped the PLANLÖSNING floor-plan row (Eye/terracotta, reinforcement-disclaimer-bearing) and the new `SunPathExposure` Compass/warm-gray computed sub-block inside the SAME `GalleryConditionVision` card, wired `discovery-results.tsx`'s candidate lat/lon/floor/orientation through to it, and extended the structural-separation invariant test to also forbid a `sun-path` import — closing DISC-05/06 in the UI. The phase's live kill-criterion validation (floor-plan hedging safety, the 4-leaf-schema API smoke, the live sun-path render) is auto-approved-but-deferred to the operator per this run's pre-approval.**

## Performance

- **Duration:** 6 min (code tasks 1-3; Task 4 is the deferred operator checkpoint)
- **Tasks:** 3 code tasks completed + 1 operator checkpoint deferred
- **Files modified:** 6 (2 created, 4 modified)

## Accomplishments

- `SunPathExposure` (`src/components/sun-path-exposure.tsx`) shipped as a `"use client"` sub-block component: Compass icon badge (`h-6 w-6`/`h-3.5 w-3.5`, warm-gray-500 on warm-gray-100 — never terracotta), "Solexponering" title, the LOCKED "Teoretisk solexponering, tar inte hänsyn till skuggning från omgivande byggnader." sub-label always visible, a plain-CSS-grid qualitative facade × season table (Vinter/Vår-Höst/Sommar columns, rendering ONLY the known facade row(s)), and the exact degraded line "Solexponering: ej tillgänglig — riktning eller våningsdata saknas för denna annons." whenever `computeSunExposure` returns `byFacadeAndSeason: null`. No thumbnail, no "Bild N" citation, no `Eye`, no terracotta anywhere in this component (asserted by test).
- `GalleryConditionVision` extended: `remodelPotential` claims already rendered via the existing `ATTRIBUTE_LABELS.remodelPotential = "PLANLÖSNING"` entry (Plan 02) in the SAME flat claims `<ul>`/row shell/citation pattern as kitchen/bathroom/overall — this plan added the floor-plan section-level reinforcement line ("Observationerna ovan är AI:ns tolkning av en 2D-planritning — inte en bedömning av bärande konstruktion. Kontakta alltid en konstruktör innan du river eller flyttar en vägg."), rendered once, only when ≥1 `remodelPotential` claim is present, distinct from and in addition to the existing "Kan vara fel" closing disclaimer. `SunPathExposure` is now embedded inside the SAME `CardContent`, after that disclaimer, always rendered (independent of `visionSkippedReason` — sun-path is not a vision output).
- `discovery-results.tsx`'s `mt-6 space-y-6` vision-wrapper map now passes `latitude`/`longitude`/`floor`/`orientation` from each candidate to `GalleryConditionVision` — the existing WR-01 structural-separation comment block was extended (not replaced) to document that these four values are likewise NEVER fed into `computeNicheScore`/`rankPosition`/`nicheSignals`.
- `niche-score.test.ts`'s existing grep-based structural-separation invariant (`importsVisionModule`/`VISION_MODULE_SPECIFIERS`) extended in place — no new test file — to also include `discovery/sun-path` (all 3 quoting variants). Both existing `it()` cases (`niche-score.ts`, `flags.ts`) now cover vision AND sun-path; the pre-existing vision assertions were not weakened.
- Component tests: `sun-path-exposure.test.tsx` (4 new cases: present-grid, degraded-on-null-orientation, degraded-on-null-floor, identity-exclusion) + `gallery-condition-vision.test.tsx` extended in place (6 new cases: PLANLÖSNING row + citation, reinforcement line present/absent, embedded sun-path present/degraded) — 13/13 green.
- Full suite (612 passed, 3 skipped), `tsc --noEmit`, `eslint` (scoped to modified files), and `npm run build` all green. All plan-declared grep gates (artifact `contains` + `key_links` `pattern`) confirmed present.

## Task Commits

Each code task was committed atomically:

1. **Task 1: SunPathExposure sub-block component + component test** — `a4a56c2` (feat, RED test written and confirmed failing first via `npx vitest run`, then implementation committed once green, matching this repo's established single-commit-per-TDD-cycle convention)
2. **Task 2: Extend GalleryConditionVision (PLANLÖSNING reinforcement + embedded SunPathExposure) + wire discovery-results** — `f4e11b2` (feat)
3. **Task 3: Extend the structural-separation invariant test to forbid a sun-path import** — `4e6bc63` (test)

**Task 4 (operator checkpoint):** NOT run this session — auto-approved-but-deferred per this run's explicit pre-approval instructions. See "Operator Next Steps" below.

**Plan metadata:** pending — committed after this summary (final `docs(12-04)` commit).

## Files Created/Modified

- `src/components/sun-path-exposure.tsx` — NEW: `SunPathExposure` component, Compass/warm-gray identity, calls `computeSunExposure` in-component
- `src/components/sun-path-exposure.test.tsx` — NEW: 4 test cases (present/degraded×2/identity-exclusion)
- `src/components/gallery-condition-vision.tsx` — floor-plan reinforcement line (conditional on ≥1 `remodelPotential` claim) + `SunPathExposure` embedded inside the same `CardContent`; props extended with `latitude`/`longitude`/`floor`/`orientation`; doc comments updated to describe the 6-state render surface
- `src/components/gallery-condition-vision.test.tsx` — `DEFAULT_SUN_PROPS` helper added to all existing render calls (props are now required, not optional); 6 new test cases
- `src/components/discovery-results.tsx` — the vision-wrapper map now threads `candidate.latitude`/`longitude`/`floor`/`orientation` into `GalleryConditionVision`; WR-01 comment extended
- `src/lib/discovery/niche-score.test.ts` — `VISION_MODULE_SPECIFIERS` extended with the 3 `discovery/sun-path` quoting variants; both `it()` cases' descriptions updated to mention sun-path

## Decisions Made

- Documented above under `key-decisions` (frontmatter) per this plan's `<output>` instruction: in-component `computeSunExposure` call, plain-CSS-grid (not `<table>`) layout rendering only known facades, `React.Fragment` with explicit `key` for the per-facade grid-row group.

## Deviations from Plan

None — plan executed exactly as written for Tasks 1-3. Task 4 was auto-approved-but-deferred per this execution run's explicit pre-approval instructions (operator territory: live API spend, real listing images, a running app) — this is expected checkpoint behavior, not a deviation.

## Stub Tracking

No stubs. `SunPathExposure` always computes a real result from `computeSunExposure` (never a hardcoded/empty fallback) and correctly renders either the real grid or the real degraded line depending on its inputs. `GalleryConditionVision`'s reinforcement line and embedded sun-path sub-block are both fully wired, not placeholders.

## Threat Flags

None new. This plan's threat register (T-12-09, T-12-10, T-12-11, T-12-SC) is fully addressed by the code shipped here:
- **T-12-09** (structural-separation integrity): mitigated by `discovery-results.tsx` passing sun-path props only into `GalleryConditionVision` (never into `rankPosition`/`nicheSignals`) + the extended invariant test (Task 3), confirmed green.
- **T-12-10** (confidently-wrong load-bearing verdict): mitigated by the code-enforced disclaimer (Plan 02, already in place) + the floor-plan reinforcement line (this plan) + the BLOCKING operator checkpoint (Task 4, deferred, not bypassed).
- **T-12-11** (fabricated sun figure/guessed orientation): mitigated by `SunPathExposure` rendering the exact "ej tillgänglig" line (never a number) whenever `byFacadeAndSeason` is `null`; component test asserts both degraded paths (missing orientation, missing floor).
- **T-12-SC** (live schema 400): the static leaf-count guard (Plan 02) is in place; the live smoke itself is part of the deferred Task 4 checkpoint below.

## Issues Encountered

None. Both RED test files failed for the expected reason (missing component / missing required props) before implementation, and both went GREEN on the first implementation attempt with no iteration needed. `tsc --noEmit`, `eslint`, the full 612-test suite, and `npm run build` were all clean on the first post-implementation run — no Rule 1-4 deviations were needed.

## User Setup Required

None for the code shipped in Tasks 1-3 — no new environment variable, API key, or infrastructure. Task 4 (below) requires the operator's existing env (Supabase, `APIFY_API_TOKEN`, `ANTHROPIC_API_KEY`) plus `DISCOVERY_ENABLED=true` and the vision flag ON, per the deferred checkpoint.

## Operator Next Steps (Task 4 — auto-approved-but-deferred, NOT run this session)

This is the phase's BLOCKING kill-criterion checkpoint. All Phase 12 code (Plans 01-03 + this plan's Tasks 1-3) is complete and green under mocked/pure tests. The following three live steps require API spend, real listing images, and a running app — operator-only, per this run's explicit pre-approval instructions (do not run live vision, do not flip `DISCOVERY_ENABLED`):

1. **Set env + start the app:** Supabase + `APIFY_API_TOKEN` + `ANTHROPIC_API_KEY` + `DISCOVERY_ENABLED=true` + the vision flag ON. `npm run dev`.
2. **(Cheapest first) Live 4-leaf-schema API smoke:** `RUN_LLM_EVALS=1 npx vitest run evals/vision.eval.ts` on one fixture — confirms the extended 4-leaf `visionDeepPassSchema` does NOT 400 under Anthropic's strict `output_config.format` before spending on a full run (project memory `anthropic-structured-output-limits` — mocked tests cannot catch this class of bug).
3. **Run one real discovery job** (free-text area search) through to completion on `/discover/[jobId]`.
4. **Live floor-plan hedging validation — the phase KILL CRITERION:** on a candidate whose image set included a planritning, confirm the PLANLÖSNING row renders hedged investigation-prompts (verbs "antyder"/"kan vara värt att undersöka"/"eventuellt"), cited to the floor-plan image, each ending with "kräver konstruktör / väggutredning", with the section-level reinforcement line below — and confirm NO claim ever states a wall is bärande/icke-bärande as fact or says "kan rivas"/"går att ta bort".
   - **HARD GATE — if floor-plan output repeats confidently-wrong load-bearing claims that cannot be hedged safely: CUT.** The CUT is a one-line flag flip by construction, not a rewrite: remove the `["remodelPotential", parsed.remodelPotential]` tuple entry in `vision.ts` (leaving the schema leaf + tests in place so it can be re-enabled later) and stop rendering the PLANLÖSNING row — ship sun-path alone. Record the decision (approved / CUT) when this step is actually run.
5. **Live sun-path render:** on a candidate with a stated orientation in its description (söderläge/västerläge etc.), confirm the sun-path sub-block renders the Compass/warm-gray grid with the locked theoretical label; on a candidate with no stated orientation, confirm the exact "ej tillgänglig" line (never a guessed orientation).
6. **Visual-identity check:** confirm sun-path is visually distinct from the floor-plan/gallery vision claims (Compass + warm-gray, never Eye + terracotta), and that neither floor-plan nor sun-path appears in any rank badge / niche chip.
7. Report back "approved" once all steps pass, or describe issues / the CUT decision. If CUT: confirm the floor-plan omission was applied as the one-line flag flip and sun-path (or neither) shipped.

## Next Phase Readiness

Phase 12 (Floor-Plan & Sun-Path, DISC-05/06) is code-complete: all four plans (01 deterministic core, 02 vision leaf, 03 candidate persistence, 04 this plan's UI + invariant) are shipped and green under the full mocked/pure test suite, `tsc`, `eslint`, and `npm run build`. The ONLY remaining work before this phase and the v1.1 milestone are the operator-only live validations listed above (this phase's Task 4) plus the already-outstanding Phase 9/10/11 operator checkpoints tracked in STATE.md's "Operator Next Steps."

No blockers to closing Phase 12 in STATE.md/ROADMAP.md as code-complete; the milestone itself remains gated on the accumulated operator live-validation backlog (Phases 9-12), unchanged by this plan.

---
*Phase: 12-floor-plan-sun-path*
*Completed: 2026-07-07*

## Self-Check: PASSED

All 6 created/modified source files and this SUMMARY.md confirmed present on disk; all 3 task commit hashes (`a4a56c2`, `f4e11b2`, `4e6bc63`) confirmed present in `git log`.
