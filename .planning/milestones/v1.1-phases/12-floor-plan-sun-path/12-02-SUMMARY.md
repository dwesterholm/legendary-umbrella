---
phase: 12-floor-plan-sun-path
plan: 02
subsystem: discovery
tags: [vision, anthropic, zod, floor-plan, liability-safety, discovery]

# Dependency graph
requires:
  - phase: 11-gallery-condition-vision
    provides: "visionDeepPassSchema/conditionAttribute/runVisionForCandidate two-pass pipeline, claims-mapping tuple pattern, mandatory-citation bounds filter, VISION_CONFIDENCE_THRESHOLD, CAP_VISION_SEK_MAX cost cap — extended in-place, not reimplemented"
  - phase: 10-niche-ranking
    provides: "structural-separation invariant test convention (grep-based static import check) — reused unmodified; this plan's changes stay inside vision.ts/vision-schema.ts and never touch niche-score.ts/flags.ts"
provides:
  - "remodelPotential — 4th visionDeepPassSchema leaf (reuses conditionAttribute verbatim), zero new numeric constraints, zero new Anthropic call"
  - "Code-enforced 'kräver konstruktör/väggutredning' disclaimer suffix on every non-null remodelPotential claim (vision.ts map()), proven by a mocked-omit test"
  - "Floor-plan investigation-prompt instruction + banned-verdict-word contract in VISION_DEEPPASS_SYSTEM_PROMPT"
affects: [12-03-candidate-persistence, 12-04-sun-path-ui]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Belt-and-suspenders liability disclaimer: prompt asks for it, code appends it unconditionally regardless of model compliance — mirrors reportSchema's 'no verdict field' philosophy applied to a suffix instead of a missing field"
    - "Kill-criterion-as-code-shape: the new claim type is exactly one array literal entry (`[\"remodelPotential\", parsed.remodelPotential]`) in the claims tuple — removing that one line is the documented CUT path, no rewrite needed"

key-files:
  created: []
  modified:
    - src/lib/discovery/vision-schema.ts
    - src/lib/discovery/vision-schema.test.ts
    - src/lib/discovery/vision-prompt.ts
    - src/lib/discovery/vision-prompt.test.ts
    - src/lib/discovery/vision.ts
    - src/lib/discovery/vision.test.ts
    - src/components/gallery-condition-vision.tsx
    - evals/vision.eval.ts

key-decisions:
  - "Exact code-enforced disclaimer suffix string: \" Detta är endast ett underlag för vidare utredning — kräver konstruktör/väggutredning för att avgöra bärande väggar.\" — appended unconditionally in vision.ts's claims map() for attribute === \"remodelPotential\", regardless of whether the model's own text already included any disclaimer language. This exact string is what a mocked-omit test (vision.test.ts) asserts is present in the FINAL claim even when absent from the mocked model output."
  - "Banned-word list asserted by test (vision-prompt.test.ts + the prompt text itself): bärande, icke-bärande, garanterat, definitivt, \"kan enkelt rivas\" — these are PROMPT-level bans (belt); the CODE-level suspenders is the unconditional disclaimer suffix, not a strip/reject transform on the model's claim text itself (the plan's 'banned-word rejection' contract is satisfied by (1) the prompt instructing the model never to use these words, (2) a live-deferred smoke/eval to catch model non-compliance, and (3) the disclaimer ALWAYS being present regardless — a bare load-bearing verdict is never left standing alone without the disclaimer immediately appended)."
  - "The kill-criterion CUT remains a one-tuple-entry removal: deleting `[\"remodelPotential\", parsed.remodelPotential]` from vision.ts's claims tuple array fully removes the claim type from persistence with no other code change required (the schema leaf can stay defined and simply go unused, or be removed in a follow-up cleanup — either way the CUT is not a rewrite)."
  - "DEEPPASS_USER_INSTRUCTION (vision.ts) was intentionally left unchanged (\"Bedöm kök, badrum och allmänt skick enligt schemat.\") — the plan's Task 3 action explicitly scoped changes to the claims tuple + map() only (\"Change NOTHING else\"); the floor-plan instruction lives entirely in the system prompt (VISION_DEEPPASS_SYSTEM_PROMPT), which the model already receives on every deep-pass call."

requirements-completed: [DISC-05]

# Metrics
duration: 25min
completed: 2026-07-07
---

# Phase 12 Plan 2: Floor-Plan Remodel-Potential Vision Leaf Summary

**Shipped `remodelPotential` as a 4th `conditionAttribute` leaf on the existing Phase 11 two-pass vision pipeline — zero new Anthropic call, zero new cost — with the mandatory "kräver konstruktör / väggutredning" disclaimer enforced in code after parsing (proven by a mocked-omit test), not left to model prompt compliance alone.**

## Performance

- **Duration:** 25 min
- **Tasks:** 3 completed
- **Files modified:** 8 (6 plan-scoped + 2 Rule-3 type-fix consumers: `gallery-condition-vision.tsx`, `evals/vision.eval.ts`)

## Accomplishments

- `visionDeepPassSchema` extended 3→4 leaves (`remodelPotential: conditionAttribute`, reused verbatim — no new shape, no numeric constraints); `VisionConditionClaim["attribute"]` union and `visionResultSchema`'s `z.enum` both extended to match; static leaf-count guard test updated to assert exactly 4 nullable leaves and zero numeric-constraint chains
- `VISION_DEEPPASS_SYSTEM_PROMPT` gained a 4th instruction paragraph: assess the floor plan's remodel potential ONLY as a question-to-investigate (never a stated load-bearing fact), always end with "kräver konstruktör / väggutredning", never use bärande/icke-bärande/garanterat/definitivt/"kan enkelt rivas"; null if the floor plan isn't assessable
- `vision.ts`'s claims tuple extended with `["remodelPotential", parsed.remodelPotential]`; the SAME confidence + imageIndex-bounds filter applies uniformly (no special-casing); the map() appends the disclaimer suffix in code, unconditionally, for every non-null `remodelPotential` claim — a mocked test proves the model's own OMITTED-disclaimer text still yields a final claim containing "kräver konstruktör"
- `imageBlocks`/`visionCostSek`/`estimateVisionCallSek`/`runVisionPass`/the GDPR-safe catch-block logging are all byte-for-byte unchanged — the floor plan rides the existing capped image set and `CAP_VISION_SEK_MAX`, exactly as required
- 19/19 vision.ts tests green (5 new: code-enforced disclaimer on omit, non-remodel claims never receive the suffix, confidence/bounds filter inherited, disclaimer present even alongside an attempted banned word), 11/11 vision-schema tests green (4 new), 7/7 vision-prompt tests green (4 new)
- Full suite (596 passed, 3 skipped), `tsc --noEmit`, and `eslint` all clean

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend visionDeepPassSchema with remodelPotential 4th leaf** — `071a493` (test — RED test written and confirmed failing first, then schema implemented and committed together once green)
2. **Task 2: Floor-plan deep-pass prompt instruction + banned-verdict-word test** — `0a2e48b` (feat)
3. **Task 3: Map remodelPotential into claims with code-enforced disclaimer** — `1b68edb` (feat)

**Plan metadata:** pending — committed after this summary (final `docs(12-02)` commit).

## Files Created/Modified

- `src/lib/discovery/vision-schema.ts` — `remodelPotential: conditionAttribute` added as the 4th `visionDeepPassSchema` key; `VisionConditionClaim["attribute"]` union + `visionResultSchema`'s `z.enum` extended; file-level doc comment updated 3→4 leaves
- `src/lib/discovery/vision-schema.test.ts` — leaf-count guard extended 3→4; new parse-acceptance cases for `remodelPotential` on both schemas
- `src/lib/discovery/vision-prompt.ts` — `VISION_DEEPPASS_SYSTEM_PROMPT` gained the floor-plan/planlösning paragraph with the mandatory disclaimer phrase + banned-word contract
- `src/lib/discovery/vision-prompt.test.ts` — 4 new assertions: planlösning/planritning presence, disclaimer phrase presence, banned-word presence in the prompt text, question-only/ALDRIG/FAKTUM hedging language
- `src/lib/discovery/vision.ts` — claims tuple extended; map() appends the code-enforced disclaimer suffix for `remodelPotential` only
- `src/lib/discovery/vision.test.ts` — `deepPassOutput()` fixture extended with a default null `remodelPotential`; 5 new test cases (disclaimer-on-omit, no-cross-contamination onto other attributes, confidence/bounds filter inherited, disclaimer present alongside an attempted banned word)
- `src/components/gallery-condition-vision.tsx` — `ATTRIBUTE_LABELS` gained `remodelPotential: "PLANLÖSNING"` (Rule 3 minimal type fix — the compiler required every union member covered; the fuller floor-plan card UI treatment is Plan 04's scope)
- `evals/vision.eval.ts` — `citationsVerifiedTrue`'s key type widened to the 4-member attribute union (Rule 3 minimal type fix; the directional-accuracy scoreboard itself still iterates only `["kitchen","bathroom","overall"]`, unchanged — `remodelPotential`'s own eval ground truth is a separate, not-yet-built concern)

## Decisions Made

- Exact code-enforced disclaimer suffix string, banned-word list, and kill-criterion CUT mechanics are documented above under `key-decisions` (frontmatter) per this plan's `<output>` instruction.
- The live 4-leaf-schema `output_config.format` smoke test (`RUN_LLM_EVALS=1 npx vitest run evals/vision.eval.ts`) and the live floor-plan hedging validation remain **OPERATOR-DEFERRED** to Plan 04's checkpoints, per 12-VALIDATION.md's Manual-Only Verifications table. Mocked tests in this plan cannot catch the Anthropic strict-output 400 class of bug (project memory `anthropic-structured-output-limits`) — only the deferred live call can.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `tsc --noEmit` regressions in two consumers of `VisionConditionClaim["attribute"]`**
- **Found during:** Task 3, post-implementation `tsc --noEmit` verification
- **Issue:** Extending `VisionConditionClaim["attribute"]` to a 4-member union broke exhaustive-`Record` type-checking in two files outside this plan's `files_modified` list: `src/components/gallery-condition-vision.tsx`'s `ATTRIBUTE_LABELS` (missing the `remodelPotential` key) and `evals/vision.eval.ts`'s `citationsVerifiedTrue` field (typed against only the original 3-member union, but generically indexed by `claim.attribute` across all of `result.claims`).
- **Fix:** Added `remodelPotential: "PLANLÖSNING"` to `ATTRIBUTE_LABELS` (matches 12-PATTERNS.md's documented label for this exact case); widened `citationsVerifiedTrue`'s `Partial<Record<...>>` key type to include `remodelPotential`. Both fixes are additive-only, non-behavior-changing — no rendering logic or eval scoring logic was touched.
- **Files modified:** `src/components/gallery-condition-vision.tsx`, `evals/vision.eval.ts`
- **Commit:** `1b68edb`

### Deferred (Out of Scope)

**1. Pre-existing `eslint prefer-const` error in `evals/vision.eval.ts:147` (`cases` never reassigned)** — confirmed pre-existing via `git stash` (present before any 12-02 change, at line 140 pre-shift). Not caused by this plan's changes. Logged to `.planning/phases/12-floor-plan-sun-path/deferred-items.md`, left unfixed per the Scope Boundary rule.

## Stub Tracking

No stubs. `remodelPotential` is a fully wired leaf: schema → prompt → claims-mapping → code-enforced disclaimer, all implemented (not placeholders), all covered by passing tests. The floor-plan claim will render through `gallery-condition-vision.tsx`'s existing flat claims list today (via the new `ATTRIBUTE_LABELS` entry) even before Plan 04's dedicated section-level UI treatment lands — this is a functional minimum, not a stub, since the claim text (including the disclaimer) is real and correct.

## Threat Flags

None beyond what the plan's own `<threat_model>` already registered (T-12-03, T-12-04, T-12-05 — all addressed by this plan's code-enforced-disclaimer / zero-new-call / unchanged-logging implementation). No new network endpoint, auth path, or schema trust boundary was introduced — `remodelPotential` flows through the SAME Anthropic call, the SAME persisted `VisionResult` shape, and the SAME GDPR-safe catch-block logging as the pre-existing 3 attributes.

## Issues Encountered

None requiring iteration beyond the two Rule-3 type fixes documented above. Each task's RED test was confirmed genuinely failing before implementation (Task 1: 3 assertions failed on old 3-leaf shape; Task 2: 4 new assertions failed on the unmodified prompt; Task 3: 2 new assertions failed — the other 2 new Task-3 test cases happened to pass immediately since the confidence/bounds filter and cross-attribute isolation were already correctly generic, inherited "for free" as the plan predicted).

## User Setup Required

None. No new environment variable, API key, or external service — this plan extends an existing Anthropic call's schema/prompt/mapping with zero new infrastructure.

## Next Phase Readiness

Plan 03 (candidate persistence) can now:
- Persist `remodelPotential` claims through the SAME `DiscoveryCandidate.vision: VisionResult | null` field — no new persistence path needed, `visionResultSchema`'s read-guard already accepts the 4th attribute value.

Plan 04 (sun-path UI + validation gate) can now:
- Render `remodelPotential` claims with a dedicated section-level treatment (UI-SPEC's "PLANLÖSNING" card block + the section-level reinforcement disclaimer line below the claims list) — today's minimal `ATTRIBUTE_LABELS` entry already renders the claim correctly in the flat list as a functional baseline.
- Run the OPERATOR-DEFERRED live 4-leaf-schema smoke test (`RUN_LLM_EVALS=1 npx vitest run evals/vision.eval.ts`) and the live floor-plan hedging validation — this is the phase's named kill criterion. If the live model output requires ANY substantive change, the kill-criterion CUT (removing the `["remodelPotential", parsed.remodelPotential]` tuple entry from `vision.ts`) is a one-line change, not a rewrite, as designed.
- Extend the structural-separation invariant test (`niche-score.test.ts`) to also grep for `sun-path.ts` imports, per 12-PATTERNS.md — not yet done since it belongs to Plan 04/03's sun-path surface, not this plan's vision-file surface (this plan's own vision.ts/vision-schema.ts changes are ALREADY covered by the existing invariant test, confirmed green above).

No blockers. `remodelPotential` is fully isolated inside `vision-schema.ts`/`vision.ts`/`vision-prompt.ts` and their tests — it does not touch `candidate.ts`, `sun-path.ts`, or any Phase 12 Plan 1 surface, exactly as the phase's wave-1-parallel structure intended.

---
*Phase: 12-floor-plan-sun-path*
*Completed: 2026-07-07*

## Self-Check: PASSED

All 6 modified source/test files (`vision-schema.ts`, `vision-schema.test.ts`, `vision-prompt.ts`, `vision-prompt.test.ts`, `vision.ts`, `vision.test.ts`), `deferred-items.md`, and this SUMMARY.md confirmed present on disk; all 3 task commit hashes (`071a493`, `0a2e48b`, `1b68edb`) confirmed present in `git log`.
