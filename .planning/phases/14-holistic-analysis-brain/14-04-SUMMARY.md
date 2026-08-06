---
phase: 14-holistic-analysis-brain
plan: 04
subsystem: discovery-ui
tags: [react, gallery-condition-vision, discovery-results, holistic-brief, ui-identity]

# Dependency graph
requires:
  - phase: 14-holistic-analysis-brain
    plan: 01
    provides: HOLISTIC_DATA_ONLY_MARKER, HolisticBrief/HolisticBriefItem types, DiscoveryCandidate.holisticBrief
  - phase: 14-holistic-analysis-brain
    plan: 02
    provides: buildHolisticBrief's non-empty-items guarantee (ANL-01) and the banned-attribution drop-and-replace this plan's independent component-level regex duplicates (D-14-06)
provides:
  - GalleryConditionVisionProps.holisticBrief (non-optional) — the D-14-04 rendering contract for a data-only brief
  - HolisticDataBrief module-local sub-component — warm-gray/Database third visual identity
  - holisticBrief={candidate.holisticBrief} threaded through discovery-results.tsx for display only
affects: [14-05, 14-06, 15, 16]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Third visual identity (warm-gray/Database) alongside the existing sage/verified and terracotta/Eye identities, following the Phase 11/12 identity-differentiation precedent"
    - "Truth-table-driven CardContent branch ladder addition that leaves the three pre-existing visionSkippedReason JSX blocks byte-identical (git-diff-verified)"
    - "Defence-in-depth component-level banned-copy regex, deliberately independent of confounder-guard.ts's construction-layer guard (D-14-06)"

key-files:
  created: []
  modified:
    - src/components/gallery-condition-vision.tsx
    - src/components/gallery-condition-vision.test.tsx
    - src/components/discovery-results.tsx
    - src/components/discovery-results.test.tsx

key-decisions:
  - "The visionSkippedReason !== null && hasHolisticBrief branch is written as ONE combined condition (not three near-duplicates) since only one visionSkippedReason value can be true at a time — it renders immediately below whichever of the three explanation paragraphs fired, matching the plan's truth table without duplicating logic"
  - "The pre-vision 'not yet run' state (vision === null && visionSkippedReason === null) is explicitly out of scope for the brief — it is not one of the six enumerated content states and correctly renders nothing new either way; the discovery-results.test.tsx threading test sets visionSkippedReason: 'no_images' on its fixture candidate specifically to land in a state where the brief is visible"

requirements-completed: [ANL-01, ANL-04]

# Metrics
duration: 20min
completed: 2026-08-06
---

# Phase 14 Plan 04: Holistic Brief UI Rendering Summary

**Replaced GalleryConditionVision's "För osäkert för att visa" dead end with the D-14-04 holistic-data-only brief (warm-gray/Database identity) whenever one exists, added it below all three vision-skipped explanations, threaded it from discovery-results.tsx for display only, and proved via an independent component-level regex that no rendered copy implies a low kr/m² means a renovation object.**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-08-06
- **Tasks:** 3
- **Files modified:** 4 (0 created, 4 modified)

## Accomplishments

- `GalleryConditionVision` now accepts a non-optional `holisticBrief: HolisticBrief | null` prop and renders a new `HolisticDataBrief` sub-component whenever `holisticBrief !== null && holisticBrief.items.length > 0`.
- The Ringvägen 122 dead end (`"För osäkert för att visa — inga bildbaserade slutsatser kunde dras med rimlig säkerhet."`) is now REPLACED by the brief when one exists, and only survives when `hasHolisticBrief` is false — the exact before/after difference is pinned by two complementary tests.
- The brief also renders BELOW each of the three `visionSkippedReason` explanations (`"no_images"`/`"cost_cap"`/`"vision_error"`) without touching their JSX (verified via `git diff` showing zero edits inside those three blocks).
- The brief never renders when image-cited claims already exist (`visionSkippedReason === null && hasClaims`) — that state is fully unchanged.
- 26 tests in `gallery-condition-vision.test.tsx` (12 new, 14 pre-existing all still green with `holisticBrief: null` added) and 2 new tests in `discovery-results.test.tsx` cover every truth-table branch plus an independent ANL-04 banned-copy guard.
- `discovery-results.tsx` threads `holisticBrief={candidate.holisticBrief}` alongside `vision`/`visionSkippedReason`/the four sun-path props — `git diff` confirms the ranking comparator is byte-identical and no analysis module (`confounder-guard`/`area-comps`/`flip-economics`/`holistic-schema`) was imported into the ranking surface.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add the holisticBrief prop and the data-only sub-block to GalleryConditionVision** - `9dac5da` (feat)
2. **Task 2: Component tests for all six states plus the banned-copy guard** - `17ca8f4` (test)
3. **Task 3: Thread holisticBrief from discovery-results.tsx without touching ranking** - `ca8ec10` (feat)

_No TDD tasks in this plan — Task 1 is a feat commit adding the rendering surface, Task 2 is the paired component-test commit, and Task 3 is a second feat commit threading the prop through the parent with its own test additions._

## Files Created/Modified

- `src/components/gallery-condition-vision.tsx` - Added `Database` import (alongside `Eye`), `HOLISTIC_DATA_ONLY_MARKER`/`HolisticBrief` import from `@/lib/discovery/holistic-schema`, the `holisticBrief` prop with its doc comment, the module-local `HolisticDataBrief` sub-component, the `hasHolisticBrief` derived flag, the truth-table code comment above the `CardContent` ladder, and the sixth-state addition to the file-level doc comment. The `visionRanButEmpty` dead-end paragraph's condition gained `&& !hasHolisticBrief`; a new combined branch renders `HolisticDataBrief` below whichever `visionSkippedReason` explanation fired; a new branch renders it in place of the dead end. The three `visionSkippedReason` JSX blocks and the `hasClaims` block are byte-identical to before.
- `src/components/gallery-condition-vision.test.tsx` - Added `makeHolisticBrief` fixture factory; added `holisticBrief={null}` to all 14 pre-existing `render(<GalleryConditionVision .../>)` calls; added two new `describe` blocks (`"GalleryConditionVision — holistic-data-only brief (ANL-01, D-14-04)"` with 10 tests, `"ANL-04 UI guard — never implies låg kr/m² ⇒ renoveringsobjekt"` with 2 tests) — 12 new tests total, 26 tests in the file overall.
- `src/components/discovery-results.tsx` - Added `holisticBrief={candidate.holisticBrief}` to the `GalleryConditionVision` render; extended the adjacent structural-separation comment block to name `holisticBrief` explicitly, noting the Phase 16 `valueGap()` ranking wiring is separate and future.
- `src/components/discovery-results.test.tsx` - Added `makeHolisticBrief` fixture factory; added a test proving a brief's distinctive item text reaches the rendered output (fixture candidate given `visionSkippedReason: "no_images"` so the brief is visible); added a test proving the rendered rank-badge order is identical with and without a `holisticBrief` attached to the last-ranked candidate.

## Decisions Made

- The `visionSkippedReason !== null && hasHolisticBrief` branch is written as one combined JSX expression rather than three near-duplicate conditionals — since exactly one `visionSkippedReason` value can be truthy at a time, this single branch always renders immediately below whichever of the three explanation paragraphs fired, satisfying the plan's truth table ("render the sub-block BELOW whichever one fired") without triplicating the same JSX.
- The pre-vision "not yet run" state (`vision === null && visionSkippedReason === null`, `makeCandidate`'s default) is NOT one of the six enumerated content states and deliberately renders nothing new regardless of `holisticBrief` — discovered during Task 3's threading test, whose fixture candidate needed an explicit `visionSkippedReason: "no_images"` override to land in a state where the brief is actually visible (see Deviations).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Threading test's fixture candidate needed a visionSkippedReason override to make the brief visible**
- **Found during:** Task 3, first test run (`npx vitest run src/components/discovery-results.test.tsx`)
- **Issue:** `variedCandidates`' `makeCandidate` factory defaults `vision: null` and `visionSkippedReason: null` — the "vision has not run yet" state, which is distinct from all six of `GalleryConditionVision`'s content states and correctly renders nothing new no matter what `holisticBrief` is set to. The threading test's first attempt only added `holisticBrief: makeHolisticBrief()` to a candidate left in that default state, so the brief's distinctive item text never appeared and `screen.getByText(...)` failed.
- **Fix:** Added `visionSkippedReason: "no_images" as const` to the same candidate override, landing it in the `visionSkippedReason !== null && hasHolisticBrief` branch where the brief actually renders — mirrors a realistic Ringvägen-122-style candidate (no gallery, but comps/hedonic data available).
- **Files modified:** `src/components/discovery-results.test.tsx`
- **Commit:** `ca8ec10`

Or: the rest of the plan executed exactly as written — no other deviations.

## Issues Encountered

None beyond the one auto-fixed issue documented above. `npx tsc --noEmit` reported the expected transient "Property 'holisticBrief' is missing" errors on `discovery-results.tsx` and the test files after Task 1 alone (before Tasks 2/3 updated their callers) — resolved once all three tasks landed, per the plan's own task sequencing.

## Verification (from the plan's `<verification>` block)

- `npx vitest run src/components/gallery-condition-vision.test.tsx src/components/discovery-results.test.tsx` — **28/28 passed** (26 in gallery-condition-vision, incl. 12 new; discovery-results contributes its own count within the combined 52-test run below).
- `npx vitest run src/components/discovery-results.test.tsx src/components/gallery-condition-vision.test.tsx src/lib/discovery/niche-score.test.ts` — **52/52 passed**.
- `npx vitest run src/components/discovery-candidate-card.test.tsx src/components/sun-path-exposure.test.tsx` (sibling component regression) — **9/9 passed**.
- `npx tsc --noEmit` — clean.
- `npm run lint` — clean.
- `npm run test` (full suite) — **829 passed | 3 skipped** (the 3 skips are pre-existing, unrelated to this plan).

### Acceptance-criteria greps (all confirmed directly, not assumed)

- `grep -c 'HOLISTIC_DATA_ONLY_MARKER' src/components/gallery-condition-vision.tsx` → `3` (import + doc comment mention + usage); `grep -c 'Baserat på områdesdata' src/components/gallery-condition-vision.tsx` → `0` (never duplicated, always imported).
- `grep -c 'Database' src/components/gallery-condition-vision.tsx` → `4` (import + doc comment + icon usage x2).
- `grep -n 'item.kind' src/components/gallery-condition-vision.tsx` → appears only in a doc comment and in the React `key` template — never rendered as visible text.
- `grep -c 'holisticBrief={candidate.holisticBrief}' src/components/discovery-results.tsx` → `1`.
- `grep -Ec 'confounder-guard|area-comps|flip-economics|holistic-schema' src/components/discovery-results.tsx` → `0` (no analysis-module import added to the ranking surface).
- `git diff src/components/discovery-results.tsx` → changes confined to the `GalleryConditionVision` props block and the adjacent comment; the ranking comparator (`scored.sort(...)`) is byte-identical.
- `git diff src/components/gallery-condition-vision.tsx` → the three `visionSkippedReason` JSX paragraph blocks show zero line changes (only surrounding context).

## Final Truth Table (six content states)

| State | Condition | Renders |
|---|---|---|
| 1 | `visionSkippedReason === "no_images"` | Existing explanation paragraph (unchanged) |
| 2 | `visionSkippedReason === "cost_cap"` | Existing explanation paragraph (unchanged) |
| 3 | `visionSkippedReason === "vision_error"` | Existing explanation paragraph (unchanged) |
| 1-3 + brief | `visionSkippedReason !== null && hasHolisticBrief` | `HolisticDataBrief` rendered BELOW whichever of 1-3 fired |
| 4 | `visionSkippedReason === null && hasClaims` | Existing claims list (unchanged); brief NEVER renders here |
| 5 | `visionSkippedReason === null && visionRanButEmpty && !hasHolisticBrief` | The "För osäkert för att visa" dead end (unchanged copy, narrowed condition) |
| 6 | `visionSkippedReason === null && visionRanButEmpty && hasHolisticBrief` | `HolisticDataBrief` REPLACES the dead end |
| (any) | `hasHolisticBrief === false` and none of 1-3/6 apply | Nothing new — byte-identical to pre-Phase-14 output |

`hasHolisticBrief` is defined as `holisticBrief !== null && holisticBrief.items.length > 0`.

## Exact Swedish Caption Copy (by confidence level)

- `confidence: "low"` → `"Låg säkerhet — bygger på områdesdata och uppgifter i annonsen, inte på en besiktning."`
- `confidence: "medium"` → `"Måttlig säkerhet — bygger på områdesdata och uppgifter i annonsen, inte på en besiktning."`
- No `"high"` branch exists — the `HolisticBrief.confidence` type forbids it (D-14-04).

## Visual-Identity Classes (HolisticDataBrief)

- Container: `rounded-lg border border-warm-gray-200 bg-warm-gray-50 p-3 space-y-2`
- Icon badge: `flex h-6 w-6 items-center justify-center rounded-full bg-warm-gray-100`, icon `Database` with `h-3.5 w-3.5 text-warm-gray-600`
- Marker text: `text-sm font-medium text-warm-gray-700`
- Confidence caption: `text-xs italic text-warm-gray-500`
- Item list: `<li className="text-sm text-warm-gray-700">`

No terracotta, `Eye`, sage, or `severityChip` styling appears anywhere in this sub-block — a third distinct identity alongside verified (sage/chips) and image-interpreted (terracotta/Eye), per the Phase 11/12 precedent.

## Known Stubs

None — the brief renders the full pre-composed `HolisticBrief.items[].text` set produced by `buildHolisticBrief` (14-02); no placeholder or empty-value UI path exists for this feature.

## Threat Flags

None beyond what the plan's own `<threat_model>` already disposes (T-14-14 through T-14-17, all `mitigate`): item text renders as a plain React text child (auto-escaped, no `dangerouslySetInnerHTML`), the D-14-04 marker is imported (never hardcoded) with a mandatory downgraded-confidence caption inside the third warm-gray/Database identity, an independent component-level banned-copy regex duplicates the confounder-guard.ts construction-layer guard (T-14-16), and `discovery-results.tsx` imports no analysis module while the ranking comparator stays byte-identical (T-14-17).

## User Setup Required

None — no external service configuration required, no DB migration, no live Supabase/Anthropic access needed for this plan.

## Operator Next Steps — DEFERRED-LIVE

- **[Phase 14 Plan 04 — DEFERRED-LIVE, does NOT block phase completion]** Visually confirm on a real `/discover/[jobId]` run that the warm-gray/`Database` data-only block is distinguishable at a glance from the Eye/terracotta image block and the Compass/warm-gray sun-path block, and that a real Ringvägen-122-style dated flat now shows at least one actionable item instead of the old dead end.
  - **Blocked by:** the Supabase project pause (`nsheegvczxjeeayngqrv`, per project memory `supabase-project-paused` — needs a manual dashboard Restore before any live discovery run) and the Booli/Cloudflare IP block noted in 14-VALIDATION.md.
  - **Verified instead via:** the full component-test suite above (26 tests in `gallery-condition-vision.test.tsx` covering all six content states + the visual-identity assertion; 2 tests in `discovery-results.test.tsx` covering the threading + ranking-separation invariant).
  - Report back "approved" once the live check has been run, or describe any visual issue.

## Next Phase Readiness

- `holisticBrief` now has a complete render path: `DiscoveryCandidate.holisticBrief` → `discovery-results.tsx` → `GalleryConditionVision` → `HolisticDataBrief`, ready for 14-05/14-06 (whatever wires `buildHolisticBrief`'s actual inputs into the job pipeline) to populate it end-to-end.
- No blockers for continuing Phase 14. The DEFERRED-LIVE visual check above is an operator step, not a phase-completion gate.

## Self-Check: PASSED

All claimed files exist on disk (`src/components/gallery-condition-vision.tsx`, `src/components/gallery-condition-vision.test.tsx`, `src/components/discovery-results.tsx`, `src/components/discovery-results.test.tsx`) and all three task commit hashes (`9dac5da`, `17ca8f4`, `ca8ec10`) are present in `git log`.

---
*Phase: 14-holistic-analysis-brain*
*Completed: 2026-08-06*
