---
phase: 11-gallery-condition-vision
plan: 03
subsystem: discovery
tags: [react, ui, structural-separation, vision, lucide-icons]

# Dependency graph
requires:
  - phase: 11-gallery-condition-vision
    plan: 01
    provides: "DiscoveryCandidate.imageUrls/vision/visionSkippedReason, VisionResult/VisionConditionClaim shapes (vision-schema.ts)"
  - phase: 11-gallery-condition-vision
    plan: 02
    provides: "runVisionForCandidate/runVisionPass/runVisionForJob — the persisted VisionResult this component reads"
provides:
  - "GalleryConditionVision — the read-only 'AI-bedömning av bilder — kan vara fel' section component (src/components/gallery-condition-vision.tsx)"
  - "Structural-separation invariant test (niche-score.test.ts) proving niche-score.ts/flags.ts never import a vision module"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "First feature-level lucide-react icon usage in this codebase (Eye), reserved 1:1 for image-interpreted content per UI-SPEC"
    - "Deliberately divergent visual shell (border-warm-gray-200/bg-warm-white, no severityChip) from ReportFlags' border-warm-gray-100/bg-warm-gray-50 chip look, so a buyer can tell image-interpreted from verified at a glance"
    - "Static source-grep-as-test technique (mirrors job.integration.test.ts's invariant-as-a-test approach) to lock a structural-separation invariant that unit tests alone can't express"

key-files:
  created:
    - src/components/gallery-condition-vision.tsx
    - src/components/gallery-condition-vision.test.tsx
  modified:
    - src/components/discovery-results.tsx
    - src/lib/discovery/niche-score.test.ts

key-decisions:
  - "GalleryConditionVision reads DiscoveryCandidate.vision/visionSkippedReason directly as props (no transform layer) — mirrors ReportFlags' direct-props-read simplicity exactly, per 11-PATTERNS.md"
  - "The four UI-SPEC content states collapse to 3 mutually-exclusive render branches keyed off (visionSkippedReason, vision, claims.length) rather than a fourth explicit prop — 'vision ran but claims empty' is derived as vision !== null && claims.length === 0, avoiding an extra caller-supplied flag that could drift out of sync with the persisted shape"
  - "The vision section is rendered as its own space-y-6 block AFTER the entire ranking grid (not interleaved per-card inside the grid) — this satisfies the UI-SPEC's >=24px lg visual break and 'verified facts first' reading order using the exact same candidate ordering as the grid above it, without needing to touch DiscoveryCandidateCard's own layout"
  - "The structural-separation invariant is implemented as a static source-read + import-line grep (readFileSync + regex on import statements), not an actual module-graph/dependency-cruiser check — mirrors job.integration.test.ts's own 'prove it structurally, not just behaviorally' precedent, and needs no new dev dependency"
  - "'från bildtolkning' marker (UI-SPEC §4) was NOT implemented — confirmed dormant this phase per the plan's explicit instruction ('Do NOT add a marker call site'); there is no live surface where a vision signal appears outside its own card, so no call site exists to mark"

patterns-established:
  - "Static grep-based invariant tests for cross-module non-import constraints, reusable for any future 'module X must never import module Y' correctness requirement"

requirements-completed: [DISC-04]

# Metrics
duration: 24min
completed: 2026-07-07
---

# Phase 11 Plan 3: Gallery Condition Vision UI + Structural-Separation Invariant Summary

**Built the read-only "AI-bedömning av bilder — kan vara fel" vision section with its own Eye-icon/terracotta identity, image-cited hedged claim rows, and three distinct degraded states — wired it into the discovery results view spatially separate from and after the deterministic ranking grid, and locked a static test proving vision output can never leak into the deterministic scorer.**

## Performance

- **Duration:** 24 min
- **Started:** 2026-07-07T15:36:00Z (approx)
- **Completed:** 2026-07-07T15:38:43Z (code tasks) — checkpoint deferred per operator pre-approval
- **Tasks:** 2 auto (both complete) + 1 checkpoint:human-verify (auto-approved-but-deferred, not run)
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments

- `GalleryConditionVision` (`src/components/gallery-condition-vision.tsx`) renders its OWN `Card` with `border-warm-gray-200 bg-warm-white` (never `border-warm-gray-100`/`bg-warm-gray-50`, the `ReportFlags` chip look), a terracotta `Eye`-icon badge, and the locked title "AI-bedömning av bilder — kan vara fel" — the first feature-level `lucide-react` icon usage in this codebase.
- Each claim row cites its source image ("Bild {n}") with a 48×48 thumbnail resolved from `imageUrlsUsed[claim.imageIndex - 1]`; when that URL can't be resolved, the row falls back to a plain "Bild {n}" text label — the citation is never omitted, and no broken-image icon is ever shown.
- Three visually and textually distinct degraded states render inside the SAME section shell: `no_images` ("Inga bilder tillgängliga…"), `cost_cap` ("Bildbedömning kördes inte…"), and low-confidence-suppressed ("För osäkert för att visa…") — a user can tell "we didn't look" from "nothing to look at" from "too uncertain."
- Zero `severityChip`/sage/destructive vocabulary anywhere in the component (grep-asserted: `grep -c 'severityChip\|sage-\|destructive'` returns 0); a dedicated component test also asserts this against the rendered DOM.
- `GalleryConditionVision` is wired into `DiscoveryResults`, rendered once per candidate in a `space-y-6` block placed AFTER the entire ranking grid — satisfying the UI-SPEC's ≥24px `lg` visual break and "verified facts first, then hedged image interpretation" reading order. Neither `candidate.vision` nor `visionSkippedReason` is threaded into `computeNicheScore`/`rankPosition`/`nicheSignals`.
- A new structural-separation invariant test in `niche-score.test.ts` statically reads the source of `niche-score.ts` and `flags.ts`, greps their `import` lines for vision module specifiers, and asserts absence. Verified (manually, then reverted) that injecting a vision import into `niche-score.ts` makes the test fail — the invariant is provably load-bearing, not just present.

## Task Commits

Each task was committed atomically:

1. **Task 1: gallery-condition-vision.tsx section component + component tests** - `ea7276c` (feat)
2. **Task 2: Wire the vision section into discovery results + lock the structural-separation invariant** - `a9cb537` (feat)

## Files Created/Modified

- `src/components/gallery-condition-vision.tsx` - the read-only vision section: Eye/terracotta identity Card, per-attribute claim rows (KÖK/BADRUM/ALLMÄNT SKICK), thumbnail-or-text citation fallback, three distinct degraded states, closing disclaimer
- `src/components/gallery-condition-vision.test.tsx` - jsdom RTL tests: header/title always renders, claim row with resolved thumbnail, citation-fallback-without-broken-image, each of the three degraded states rendered distinctly, no severityChip/sage/destructive vocabulary
- `src/components/discovery-results.tsx` - imports and renders `GalleryConditionVision` per candidate in a `space-y-6` block after the ranking grid; no vision value passed into the scorer
- `src/lib/discovery/niche-score.test.ts` - new "Structural-separation invariant" describe block statically asserting `niche-score.ts`/`flags.ts` never import a vision module

## Decisions Made
See `key-decisions` in frontmatter above.

## Deviations from Plan

None - plan executed exactly as written. Both code tasks landed with zero auto-fixes required; the existing `discovery-results.test.tsx`/`niche-score.test.ts` fixtures (which already carry `vision: null, visionSkippedReason: null` from Plan 01's Rule-1 fixup) needed no changes since that shape is a legitimate "vision not yet run" state the component already degrades to gracefully (renders the header/sub-label only, no content rows, no crash).

## Issues Encountered

- Manually verified the structural-separation invariant test actually catches a violation: temporarily injected `import type { VisionResult } from "@/lib/discovery/vision-schema";` into `niche-score.ts`, confirmed the new test failed, then reverted via `git checkout -- src/lib/discovery/niche-score.ts` (the file had no other pending changes, so this was a safe, scoped revert of a self-introduced single-line diff — not a blanket destructive-git operation). Full suite re-confirmed green after the revert.

## User Setup Required

None for this plan's own scope.

**Operator Next Steps (deferred, per checkpoint pre-approval — Task 3 was NOT run):**

This plan's Task 3 (`checkpoint:human-verify`, gate="blocking") is the live-render + validation-gate checkpoint. Per the AUTO_MODE pre-approval instruction, it is treated as **auto-approved-but-deferred**: all automated verification (component tests, `npx tsc --noEmit`, `npm run build`, `npx vitest run` full suite, grep gates, and the structural-separation invariant test) is green, but no live vision call or flag flip was performed. The operator must still:

1. **Live-render check** (per 11-03-PLAN.md Task 3 `how-to-verify`, steps 1-6): set `APIFY_API_TOKEN` + `ANTHROPIC_API_KEY` + `DISCOVERY_ENABLED=true` + the vision flag ON, start the app, run one real discovery job, and confirm on a candidate with a gallery that the "AI-bedömning av bilder — kan vara fel" section renders hedged Swedish claims ("verkar"/"ser ut att", never "är"/verdicts), each with a "Bild {n}" citation + thumbnail, visually distinct from the ranking chips (terracotta Eye header, no severity chips) — and that the three degraded states are distinguishable, no claim references a person, and per-search vision cost stays under `CAP_VISION_SEK_MAX`.

2. **Kill-criterion validation gate (hard gate, operator-deferred):** run the full 20–30-listing accuracy gate — `RUN_LLM_EVALS=1 npx vitest run evals/vision.eval.ts` against 20–30 real, manually-labeled Booli listings (fixtures at `evals/fixtures/vision/*.json`, labels per `evals/vision-labels.example.json`). Decide CUT vs SHIP based on: directional accuracy ≥ 70%, citation validity ≥ 90%, zero-hallucination = 100% (hard gate, no tolerance), and measured per-search cost ≤ `CAP_VISION_SEK_MAX` (10 SEK). **Below threshold → CUT gallery vision entirely, ship discovery text-ranking-only** (this UI's `vision: null` / `visionSkippedReason: "no_images"` degraded states are already the common/expected case by construction, so a CUT decision requires no further UI rework — only the pipeline call sites (`runVisionForJob`) would need to stop being invoked).

3. (Recommended, cheaper, do first) the ONE live API smoke test — `RUN_LLM_EVALS=1 npx vitest run evals/vision.eval.ts` against a single real fixture — to confirm the slim vision schema doesn't 400 before spending on the full 20-30-listing gate (per project memory `anthropic-structured-output-limits`).

4. Still outstanding from prior phases (unrelated to this plan, listed for continuity): Phase 10 niche-ranking manual UAT, 07-03 macro-context live-render check, 08-04 BRF auto-fetch live smoke test, 05-05 owned-acquisition live smoke test, and the Plan 01/02-deferred live Apollo `images(` ref probe (`scripts/probe-booli-images.ts`) — until that probe runs, `imageUrls` remains `null` for every real candidate in production, so the vision section will render the `no_images` degraded state for all real listings until it is run.

## Next Phase Readiness

- Phase 11 (gallery-condition-vision, DISC-04) is now feature-complete on the code side: foundation contracts (Plan 01), the two-pass vision pipeline (Plan 02), and this plan's UI + structural-separation invariant (Plan 03) are all committed and green.
- Production readiness is gated behind three still-open operator actions (all deferred by design, not blockers to closing this plan): the live Apollo `images(` ref probe, the live-render checkpoint, and the 20–30-listing kill-criterion validation gate. A CUT decision at the kill-criterion gate would mean discarding the runtime pipeline's live calls (the UI, schemas, prompts, and eval harness remain valid engineering artifacts regardless) and shipping discovery with niche-ranking-only — this UI already degrades to that exact state by construction.
- No further Phase 11 plans are defined; this plan is the phase's terminal execute plan.

---
*Phase: 11-gallery-condition-vision*
*Completed: 2026-07-07*

## Self-Check: PASSED

All 2 created files (`src/components/gallery-condition-vision.tsx`, `src/components/gallery-condition-vision.test.tsx`) and 2 modified files confirmed present on disk with the expected content; both task commit hashes (`ea7276c`, `a9cb537`) confirmed in `git log`.
