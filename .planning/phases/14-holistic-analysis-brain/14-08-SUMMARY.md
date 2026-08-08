---
phase: 14-holistic-analysis-brain
plan: 08
subsystem: testing
tags: [vitest, static-analysis, regex, structural-separation, discovery]

# Dependency graph
requires:
  - phase: 14-holistic-analysis-brain
    provides: "holistic-schema.ts, confounder-guard.ts, brf-lookup.ts (registered specifiers whose multi-line import shape exposed the gap)"
provides:
  - "sourceImportsVisionModule(source) — a pure, fixture-testable, statement-level matcher that replaces the line-anchored one"
  - "WR-01 regression suite proving the guard is not silently inert against multi-line named imports, side-effect imports, and re-exports"
affects: ["16-value-gap-scoring"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Statement-level source-text matching via a narrow, whitespace-including-newlines character class instead of per-line filtering, for static-grep architectural guards"

key-files:
  created: []
  modified:
    - src/lib/discovery/niche-score.test.ts

key-decisions:
  - "sourceImportsVisionModule(source) is a pure text function decoupled from readFileSync so it is fixture-testable without touching disk; importsVisionModule(sourcePath) is now a thin wrapper delegating to it"
  - "VISION_MODULE_SPECIFIERS left byte-identical (still 11 entries, same order) — widening the registered specifier list is explicitly out of scope so Phase 16's value-gap extension stays a clean, separate edit"
  - "IMPORT_FROM_STATEMENT_RE's character class ([\\w*\\s{},$]*?) is deliberately narrow rather than [\\s\\S]*? — it can match a multi-line clause (whitespace includes newlines) but can never run past `(`, `;`, `/` or `=` into a comment or unrelated code, keeping the guard both statement-aware and comment/string-safe"

patterns-established:
  - "A locked static-grep architectural invariant gets both fixture-level unit tests (isolated source-text snippets) AND real-file positive controls (files that legitimately use the pattern), so a green result can't hide an accidentally-inert matcher"

requirements-completed: [ANL-04]

# Metrics
duration: 8min
completed: 2026-08-08
---

# Phase 14 Plan 08: Structural-Separation Guard Statement-Level Matcher (WR-01) Summary

**Replaced niche-score.test.ts's line-anchored `/^\s*import\b/` filter with a statement-level regex matcher that sees multi-line named imports, side-effect imports, and re-exports — closing the exact blind spot `candidate.ts` and `confounder-guard.ts` already exercise for Phase 14's registered specifiers.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-08-08T14:46:00Z
- **Completed:** 2026-08-08T14:48:40Z
- **Tasks:** 2 (combined into one atomic commit — both tasks edit the same describe block with no independently-passing intermediate state)
- **Files modified:** 1

## Accomplishments
- Replaced the per-line `source.split("\n").filter(/^\s*import\b/)` matcher — which never sees a module specifier sitting on a multi-line import's closing `} from "...";` line — with `sourceImportsVisionModule(source)`, a pure statement-level matcher.
- Two new regexes: `IMPORT_FROM_STATEMENT_RE` (`/^[ \t]*(?:import|export)\s+[\w*\s{},$]*?from\s*["'][^"']+["']/gm`) matches whole, possibly multi-line, import/export-from statements; `SIDE_EFFECT_IMPORT_RE` (`/^[ \t]*import\s*["'][^"']+["']/gm`) matches bare side-effect imports. Both are narrow (whitespace-including-newlines, but no `[\s\S]`) so they cannot run into a comment or unrelated code.
- Added a nested `describe("WR-01 — the matcher sees multi-line named imports")` with 12 new `it(...)` cases: multi-line named import, multi-line type import, single-line import (regression), side-effect import, re-export, comment-mention negative control, string-literal negative control, unrelated-import negative control, two real-file positive controls (`candidate.ts`, `confounder-guard.ts`), and two real-file negative re-assertions (`niche-score.ts`, `flags.ts`).
- `VISION_MODULE_SPECIFIERS` untouched — still exactly 11 entries, byte-identical.

## Task Commits

Both tasks were implemented as a single tightly-coupled edit to one describe block (no independently-passing intermediate state existed between them) and committed atomically:

1. **Task 1 + Task 2: Statement-level matcher + WR-01 regression suite** - `5aa5080` (test)

**Plan metadata:** (this commit, docs: complete plan)

## Files Created/Modified
- `src/lib/discovery/niche-score.test.ts` - Replaced line-anchored matcher with `sourceImportsVisionModule`/`IMPORT_FROM_STATEMENT_RE`/`SIDE_EFFECT_IMPORT_RE`; added WR-01 regression describe block with fixture and real-file positive/negative controls.

## Decisions Made
- Combined Task 1 and Task 2 into a single commit: both edit the same describe block in the same file, and task 1's matcher change alone would leave the WR-01 regression assertions (task 2) unwritten — there's no meaningful independent, test-passing checkpoint between them.
- Kept `importsVisionModule(sourcePath)` as a thin `readFileSync` wrapper per the plan, so the two pre-existing `niche-score.ts`/`flags.ts` assertions needed zero changes.

## Deviations from Plan

### Falsification result differs from the plan's stated expectation (documented, not a defect)

The plan's Task 2 acceptance criteria asserted: "Reverting `sourceImportsVisionModule`'s body to the old line filter ... makes the multi-line fixture case AND both real-file positive controls FAIL."

**Observed falsification result (recorded per the task's own instruction):** temporarily restoring the old line-anchored body and re-running the suite produced **3 failures**, not 5:
- FAILED (as expected): "detects a multi-line named import of a registered specifier"
- FAILED (as expected): "detects a multi-line named TYPE import of a registered specifier"
- FAILED (as expected): "detects a re-export of a registered specifier"
- **PASSED** (plan expected FAIL): `candidate.ts` real-file positive control
- **PASSED** (plan expected FAIL): `confounder-guard.ts` real-file positive control

**Root cause:** both `candidate.ts` and `confounder-guard.ts` contain an *additional*, unrelated **single-line** import of a different registered specifier elsewhere in the same file (`candidate.ts:3` imports `vision-schema` on one line; `confounder-guard.ts:23` imports `area-comps` on one line). The old line-anchored filter already matched those single-line imports independently of the multi-line `holistic-schema` import the plan targets, so `importsVisionModule` returned `true` for both real files even under the old, buggy implementation. This is a property of the current file contents, not of the test — the isolated fixture tests (which use single-purpose multi-line-only snippets with no accompanying single-line import) are the ones that directly and cleanly falsify the pre-WR-01 matcher, and they behave exactly as the plan specified.

This does not weaken the delivered guarantee: with the new implementation, all 30 tests (including both real-file controls) pass, correctly recognizing both the single-line and multi-line imports in each file. The real-file positive controls still serve their intended purpose (T-14-36: proving the matcher isn't an always-false stub) — they just aren't independently falsifying against this specific historical bug, because the files happen to also exercise the old matcher's one correct case. No code change was made in response to this finding; it is recorded here per the plan's explicit "Record the observed failure count in the SUMMARY" instruction.

**Total deviations:** 1 documented finding (falsification count differs from plan's stated expectation), no code changes required.
**Impact on plan:** None on the delivered guarantee — the core WR-01 invariant (multi-line/side-effect/re-export detection, comment/string safety) is fully proven by the fixture-level tests, which behave exactly as specified.

## Issues Encountered
None beyond the falsification-count finding documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The structural-separation guard is now statement-aware and verifiably non-inert; Phase 16's value-gap extension can add its module specifier to `VISION_MODULE_SPECIFIERS` with confidence that a multi-line import of it will actually be caught.
- No blockers.

---
*Phase: 14-holistic-analysis-brain*
*Completed: 2026-08-08*

## Self-Check: PASSED

- FOUND: src/lib/discovery/niche-score.test.ts
- FOUND: .planning/phases/14-holistic-analysis-brain/14-08-SUMMARY.md
- FOUND: commit 5aa5080
