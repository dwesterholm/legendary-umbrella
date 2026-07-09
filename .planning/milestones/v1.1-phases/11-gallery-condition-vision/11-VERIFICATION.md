---
phase: 11-gallery-condition-vision
verified: 2026-07-07T15:44:05Z
status: human_needed
score: 10/11 must-haves verified (1 minor gap; 2 items intentionally operator-deferred, classified as human verification)
overrides_applied: 0
gaps:
  - truth: "The vision section is placed AFTER the deterministic sections with a >=24px (lg) visual break"
    status: partial
    reason: "GalleryConditionVision IS rendered after the ranking grid and never feeds computeNicheScore (structural separation itself is fully verified and test-locked) — but the actual CSS gap between the ranking grid and the vision block is 16px (space-y-4 on the shared outer container in discovery-results.tsx), not the required >=24px (space-y-6/lg token) that 11-UI-SPEC.md marks as a REQUIRED minimum visual break, not merely aesthetic."
    artifacts:
      - path: "src/components/discovery-results.tsx"
        issue: "Outer wrapper div (line 128) uses `space-y-4` (16px) to space its children, one of which is the ranking `.grid` and the next is the vision `<div className=\"space-y-6\">` block. `space-y-6` on the vision block only spaces its OWN children (the per-candidate vision cards) from each other — it does not add a 24px gap before the block itself. The actual measured gap between the grid and the first vision card is 16px."
    missing:
      - "Increase the gap between the ranking grid and the vision section to >=24px — e.g. wrap the grid and the vision block in a `space-y-6` (or add `mt-6`/`pt-6` to the vision wrapper) instead of relying on the outer `space-y-4`."
deferred: []
human_verification:
  - test: "Live Apollo `images(` ref probe (11-01-PLAN.md Task 1)"
    expected: "Running `APIFY_API_TOKEN=... npx tsx scripts/probe-booli-images.ts \"<real listing URL>\"` reveals the real per-image URL field name and whether a floor-plan type/category discriminator exists, confirming or correcting `extractImageUrls`'s assumed shape (`Array<{ url?: string; type?: string }>`)."
    why_human: "Requires a real Apify render against a live Booli listing (real spend) — cannot be run in an automated verification pass. The extractor's fixture-driven logic is unit-tested and gracefully degrades to `undefined`/null on any shape mismatch, so this does not block the phase's code-level correctness, but real gallery images will not flow into vision until this probe runs (SUMMARY.md explicitly flags this as an open blocker/watch item for production data)."
  - test: "Live vision render check + one live API schema smoke + the 20-30-listing accuracy validation gate (kill criterion) — 11-03-PLAN.md Task 3"
    expected: "(a) One live `RUN_LLM_EVALS=1 npx vitest run evals/vision.eval.ts` smoke against a single real fixture confirms the slim schema does not 400 (per project memory `anthropic-structured-output-limits`). (b) With `DISCOVERY_ENABLED=true` + real API keys, a real discovery job shows the 'AI-bedömning av bilder — kan vara fel' section rendering hedged Swedish claims, image citations, and distinguishable degraded states, with no PII references and spend under `CAP_VISION_SEK_MAX`. (c) The full 20-30-listing accuracy run (`evals/vision.eval.ts` against real labeled listings) meets directional accuracy >=70%, citation validity >=90%, zero-hallucination =100% (hard gate) — below threshold is an explicit kill criterion requiring CUT-to-text-only."
    why_human: "Requires real Anthropic + Apify spend, a live gallery of real listing images, and manually-labeled ground truth for the accuracy rubric — none of which can be produced or judged by static code inspection. This is the phase's own documented, intentional validation gate (CONTEXT.md kill criterion) and is explicitly gated behind the Phase 9 legal go/no-go and `DISCOVERY_ENABLED`."
---

# Phase 11: Gallery Condition Vision Verification Report

**Phase Goal:** Derive soft condition attributes from description + gallery images via vision — each claim cited to its source image, presented as hedged evidence, structurally separate from deterministic flags.
**Verified:** 2026-07-07T15:44:05Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | imageUrls extractor parses Apollo `images(` ref, caps at 4, host-allowlisted, floor-plan-first, never throws; degrades to null on no-images | ✓ VERIFIED | `src/lib/booli/client.ts:213-252` `extractImageUrls`/`isAllowedImageHost` (real hostname check via `new URL()`, never substring); capped via `CAP_IMAGES_PER_LISTING` (activated 0→4 in `filter-schema.ts`); `client.test.ts:476-598` 6 dedicated tests (cap+floor-plan-first, no-ref→undefined, malformed-url skip, non-allowlisted-host drop, toCandidate wiring, legacy safeParse) all pass |
| 2 | DiscoveryCandidate extended additive-nullable (imageUrls/vision/visionSkippedReason), no migration, PII-safe, legacy rows safeParse to null | ✓ VERIFIED | `src/lib/discovery/candidate.ts:25-68,79-99` uses `.nullable().default(null)` (never bare `.optional()`); `candidate.test.ts` legacy-row test passes; `toCandidate` never reads raw vision keys (vision/visionSkippedReason unconditionally null at scrape time) |
| 3 | Slim single-nullable-leaf Claude-facing vision schema avoids the output_config.format 400 trap (statically asserted) | ✓ VERIFIED | `src/lib/discovery/vision-schema.ts:34-81` `conditionAttribute`/`visionDeepPassSchema`/`preFilterSchema`; `vision-schema.test.ts` walks the Zod def tree asserting <=3 nullable leaves and zero numeric `.min()/.max()/.int()` chains — test passes |
| 4 | CAP_VISION_SEK_MAX (=10) is separate from CAP_SEK_MAX; visionCostSek composes costSek+costSekSonnet without redefining rates | ✓ VERIFIED | `src/lib/discovery/cost.ts:54,70-77`; `cost.test.ts:49-72` asserts distinctness and composition |
| 5 | Two-pass Haiku pre-filter -> conditional Sonnet deep pass; Sonnet receives the FULL capped image set, not a subset; temp 0 | ✓ VERIFIED | `src/lib/discovery/vision.ts:128-227` `runVisionForCandidate` — pre-filter gates `worthDeepPass`; deep pass always sent `capped` (full set); both calls `temperature: 0`; `vision.test.ts` asserts call counts + full-set content array |
| 6 | Vision cost cap checked incrementally BEFORE each Sonnet-eligible call; remaining candidates skipped with visionSkippedReason=cost_cap when cap would be exceeded | ✓ VERIFIED | `src/lib/discovery/vision.ts:280-325` `runVisionPass` checks `runningVisionSek + estimate > CAP_VISION_SEK_MAX` before calling, sets `costCapHit` and marks all remaining candidates; `vision.test.ts` early-stop test passes |
| 7 | Candidate with no imageUrls yields vision=null, visionSkippedReason=no_images, zero Anthropic calls; per-job booliId dedupe | ✓ VERIFIED | `vision.ts:117-120` (runVisionForCandidate) + `vision.ts:298-302` (runVisionPass no-images branch, no call); dedupe map at `vision.ts:270,306-311`; both test-asserted |
| 8 | Every persisted claim carries a non-null imageIndex resolvable against imageUrlsUsed; low-confidence/null claims dropped before persistence | ✓ VERIFIED | `vision.ts:212-226` filters `attr.claim !== null && attr.confidence >= VISION_CONFIDENCE_THRESHOLD`, maps kept claims with `imageIndex`; `vision.test.ts` asserts resolvability |
| 9 | Catch blocks log ONLY {booliId, code}, never image URLs/claim text/model output | ✓ VERIFIED | `vision.ts:229-234` `console.error("[discovery-vision]", { booliId, code })`; `vision.test.ts` asserts no URL substring in logged payload |
| 10 | Both prompts contain explicit PII/people-ignore instruction (Swedish); eval harness RUN_LLM_EVALS-gated, self-skips with zero spend | ✓ VERIFIED | `vision-prompt.ts:22-23` `PII_IGNORE_INSTRUCTION` verbatim in both `VISION_PREFILTER_SYSTEM_PROMPT`/`VISION_DEEPPASS_SYSTEM_PROMPT`; `evals/vision.eval.ts:49,144-145` `RUN_LIVE` gate; `npx vitest run evals/vision.eval.ts` (no flag) → 1 skipped, 0 Anthropic calls, confirmed live |
| 11 | Vision section renders in its own Eye/terracotta Card, image-cited hedged claims with thumbnail-or-text-fallback citation, 3-4 distinct degraded states, NEVER severityChip/sage/destructive, placed AFTER deterministic sections with >=24px break, never feeds computeNicheScore; structural-separation invariant test locks it | ⚠️ PARTIAL | `src/components/gallery-condition-vision.tsx` fully matches spec (Eye icon, locked title, thumbnail/text-fallback citation, 3 distinct skip-copy states, zero severityChip/sage/destructive — grep + test confirmed); wired into `discovery-results.tsx` AFTER the ranking grid, never threaded into `computeNicheScore`; `niche-score.test.ts` structural-separation invariant test passes and is provably load-bearing (SUMMARY.md documents a manual injection-then-revert proving the test catches a violation). **Gap:** the actual CSS gap between the grid and the vision block is 16px (`space-y-4` on the shared outer container), not the required >=24px (`space-y-6`/`lg` token) that 11-UI-SPEC.md calls a "REQUIRED minimum visual break," not merely aesthetic. |

**Score:** 10/11 truths fully verified; 1 truth (#11) partially verified — the structural/architectural half (own Card, never-feeds-scorer, distinct degraded states) is solid and test-locked; the visual-spacing half falls 8px short of the spec's explicit minimum.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/lib/discovery/vision-schema.ts` | Claude-facing pre-filter/deep-pass schemas + persisted VisionResult/VisionConditionClaim + read-guard | ✓ VERIFIED | 153 lines; exports `preFilterSchema`, `visionDeepPassSchema`, `visionResultSchema`, `VisionResult`, `VisionConditionClaim`, `VISION_CONFIDENCE_THRESHOLD` — all present, wired, tested |
| `src/lib/discovery/candidate.ts` | DiscoveryCandidate extended with imageUrls/vision/visionSkippedReason | ✓ VERIFIED | 190 lines; `visionSkippedReason` present; additive-nullable; wired into `toCandidate`/`discoveryCandidateSchema` |
| `src/lib/booli/client.ts` | imageUrls extractor in reshapeListingEntity | ✓ VERIFIED | 687 lines; `grep -c 'images('` = multiple hits; extractor wired into `reshapeListingEntity` |
| `src/lib/discovery/cost.ts` | CAP_VISION_SEK_MAX + visionCostSek | ✓ VERIFIED | 77 lines; both exported, tested |
| `src/lib/discovery/vision.ts` | runVisionForCandidate + runVisionPass orchestration | ✓ VERIFIED | 345 lines (>= 60 min); exports `runVisionForCandidate`, `runVisionPass`; wired into `job.ts`'s `runVisionForJob` |
| `src/lib/discovery/vision-prompt.ts` | PII-ignore prompts | ✓ VERIFIED | 51 lines; `grep -c 'Ignorera'` >= 1 (present twice, once per prompt) |
| `evals/vision.eval.ts` | RUN_LLM_EVALS-gated rubric harness | ✓ VERIFIED | 283 lines; gate confirmed; calls real `runVisionForCandidate` |
| `evals/vision-labels.example.json` | Label shape doc | ✓ VERIFIED | present, referenced by eval harness comments |
| `src/components/gallery-condition-vision.tsx` | Read-only vision section per UI-SPEC | ✓ VERIFIED | 142 lines (>= 60 min); exports `GalleryConditionVision`; matches spec verbatim (title, sub-label, states, styling) |
| `src/components/gallery-condition-vision.test.tsx` | Component tests | ✓ VERIFIED | 7 tests covering claim render, citation fallback, 3 degraded states, no-severity-vocab — all pass |
| `src/lib/discovery/niche-score.test.ts` | Structural-separation invariant | ✓ VERIFIED | Contains `vision-schema`; asserts neither `niche-score.ts` nor `flags.ts` imports a vision module; SUMMARY.md documents the test was manually proven load-bearing |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `candidate.ts toCandidate` | `reshapeListingEntity` imageUrls output | `arrOfStr(raw.imageUrls)` | ✓ WIRED | `candidate.ts` line with `imageUrls: arrOfStr(raw.imageUrls)` present |
| `cost.ts visionCostSek` | `brf/cost.ts costSek/costSekSonnet` | import + compose | ✓ WIRED | `visionCostSek` composes both, no new rates |
| `vision.ts` | `@anthropic-ai/sdk messages.parse` | image content blocks + zodOutputFormat | ✓ WIRED | `client.beta.messages.parse` called twice (pre-filter, deep-pass) with `imageBlocks()` + `zodOutputFormat` |
| `vision.ts` | `cost.ts CAP_VISION_SEK_MAX/visionCostSek` | incremental pre-check before each Sonnet call | ✓ WIRED | `runVisionPass` checks before calling `runVisionForCandidate` |
| `vision.ts` | `vision-prompt.ts` | system prompt import | ✓ WIRED | Both `VISION_PREFILTER_SYSTEM_PROMPT`/`VISION_DEEPPASS_SYSTEM_PROMPT` imported and used |
| `gallery-condition-vision.tsx` | `candidate.vision.imageUrlsUsed` | `imageUrlsUsed[claim.imageIndex - 1]` thumbnail resolve | ✓ WIRED | Line 96: `vision?.imageUrlsUsed[claim.imageIndex - 1]`, with text-label fallback when unresolved |
| `discovery-results.tsx` | `gallery-condition-vision.tsx` | render per candidate, spatially separate | ⚠️ PARTIAL | `GalleryConditionVision` rendered per candidate AFTER the grid — spatially separate in DOM order and its own Card, but the CSS gap (16px) undershoots the spec's explicit >=24px minimum |
| `job.ts runVisionForJob` | `tick-discovery.ts` / `sweep/route.ts` | conditional call after slice reaches "done" | ✓ WIRED | Both call sites confirmed (`grep -n "runVisionForJob"`) |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| `GalleryConditionVision` | `vision`/`visionSkippedReason` props | `candidate.vision`/`candidate.visionSkippedReason`, set by `runVisionPass`/`runVisionForCandidate` via a real (mocked-in-test, live-in-prod) Anthropic call chain | Real pipeline exists and is unit-tested end-to-end with mocks; NOT yet proven against a real listing (imageUrls remains `null` for all real candidates until the operator runs the deferred Apollo `images(` probe) | ⚠️ STATIC (pending operator probe) — architecture and wiring are correct and test-verified; the actual production data path (real gallery URLs -> real vision calls) has not yet been exercised, by design (operator-deferred) |
| `niche-score.ts computeNicheScore` | candidate fields (address/price/rooms/etc.) | `DiscoveryCandidate` — explicitly does NOT read `.vision` | Confirmed: `grep -n "vision" src/lib/discovery/niche-score.ts` returns zero matches | ✓ FLOWING (vision correctly absent from this path) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Targeted phase test files all pass | `npx vitest run src/lib/booli/client.test.ts src/lib/discovery/candidate.test.ts src/lib/discovery/vision-schema.test.ts src/lib/discovery/cost.test.ts src/lib/discovery/vision.test.ts src/lib/discovery/vision-prompt.test.ts src/lib/discovery/job.test.ts src/components/gallery-condition-vision.test.tsx src/lib/discovery/niche-score.test.ts src/components/discovery-results.test.tsx evals/vision.eval.ts` | 10 files passed, 1 skipped (evals); 123 passed, 1 skipped | ✓ PASS |
| Full suite regression check | `npx vitest run` | 55 files passed, 3 skipped; 558 passed, 3 skipped | ✓ PASS |
| Typecheck | `npx tsc --noEmit` | clean, no errors | ✓ PASS |
| Eval harness self-skips with zero spend | `npx vitest run evals/vision.eval.ts` (no RUN_LLM_EVALS) | 1 skipped, 0 network calls | ✓ PASS |
| No debt markers in phase files | `grep -n -E "TBD\|FIXME\|XXX\|TODO\|HACK\|PLACEHOLDER"` across all 14 phase-touched files | zero matches in every file | ✓ PASS |
| No severity/sage/destructive vocabulary in vision component | `grep -c 'severityChip\|sage-\|destructive' src/components/gallery-condition-vision.tsx` | 0 | ✓ PASS |

### Probe Execution

No conventional `scripts/*/tests/probe-*.sh` probes exist for this phase (the phase's probe is `scripts/probe-booli-images.ts`, a one-off Node script requiring a live Apify token and a real listing URL — not a `bash`-invocable test-harness probe). This script is correctly NOT run autonomously; it is documented under Human Verification below.

| Probe | Command | Result | Status |
|-------|---------|--------|--------|
| `scripts/probe-booli-images.ts` | `APIFY_API_TOKEN=... npx tsx scripts/probe-booli-images.ts "<url>"` | Not run (requires real API token + live listing + real spend) | MISSING_PROBE — correctly classified as human verification, not an automatable gap |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| DISC-04 | 11-01, 11-02, 11-03 | System derives soft condition attributes from description + gallery images via vision — each claim cited to its source image, presented as hedged evidence, structurally separate from deterministic flags | ✓ SATISFIED (code-complete; production validation gate pending) | All 4 roadmap success criteria are code-verifiable and met: (1) hedged, image-cited claims render — verified via component + pipeline tests; (2) visual/structural distinctness from deterministic flags — verified (Eye/terracotta identity, zero shared vocabulary, own Card) modulo the 16px-vs-24px gap gap noted above; (3) vision output never becomes a scored input without a "från bildtolkning" marker — verified via the structural-separation invariant test (marker correctly dormant, no call site exists since vision never reaches a scored surface); (4) per-search cost cap fires + no-PII — verified via unit tests (cost-cap early-stop, PII-ignore prompt assertions); the LIVE confirmation of (1) and (4) against real data is the explicitly operator-deferred validation gate. |

No orphaned requirements found — REQUIREMENTS.md maps only DISC-04 to Phase 11, and it is declared in all three plans' frontmatter.

### Anti-Patterns Found

None. Zero TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER markers, zero "not yet implemented"/"coming soon" strings, across all 14 phase-touched source files.

### Human Verification Required

### 1. Live Apollo `images(` ref probe

**Test:** Run `APIFY_API_TOKEN=$APIFY_API_TOKEN npx tsx scripts/probe-booli-images.ts "https://www.booli.se/annons/<a-real-active-listing-id>"` against one real active Booli listing.
**Expected:** The script prints the real per-image URL field name and confirms/denies a floor-plan `type`/`category` discriminator, so `extractImageUrls` in `src/lib/booli/client.ts` can be corrected if the real shape differs from the assumed `Array<{ url?: string; type?: string }>`.
**Why human:** Requires a real, operator-approved Apify render against a live listing (real spend) — cannot be executed in an automated verification pass. Until run, `imageUrls` will be `null`/`undefined` for every real production candidate (the extractor degrades gracefully either way, per its unit tests), so no real gallery images flow into vision until this is done.

### 2. Live vision render check + one live API schema smoke

**Test:** With `DISCOVERY_ENABLED=true`, real `ANTHROPIC_API_KEY`/`APIFY_API_TOKEN`, run one real discovery job to completion and confirm on a candidate with a gallery that the "AI-bedömning av bilder — kan vara fel" section renders hedged Swedish claims, each with a resolvable "Bild {n}" citation + thumbnail, visually distinct from the ranking chips, with the three degraded states distinguishable and no PII/person references, and per-search vision cost under `CAP_VISION_SEK_MAX`. Recommended first: `RUN_LLM_EVALS=1 npx vitest run evals/vision.eval.ts` against ONE real fixture to confirm the slim schema doesn't 400 (cheaper than the full run below).
**Expected:** Hedged, image-cited claims render correctly on real data; no schema 400; no PII leakage; cost within cap.
**Why human:** Requires real API spend, a live rendered gallery, and visual/qualitative judgment of hedge-language correctness and PII-safety that cannot be verified by static code inspection alone.

### 3. The 20-30-listing accuracy validation gate (kill criterion)

**Test:** Run `RUN_LLM_EVALS=1 npx vitest run evals/vision.eval.ts` against 20-30 real, manually-labeled Booli listings (fixtures + `evals/vision-labels.json` per `evals/vision-labels.example.json`'s shape).
**Expected:** Directional accuracy >= 70%, citation validity >= 90%, zero-hallucination = 100% (hard gate, no tolerance), measured per-search cost <= `CAP_VISION_SEK_MAX`. Below threshold is this phase's own documented kill criterion — CUT gallery vision, ship discovery text-ranking-only.
**Why human:** Requires real labeled ground truth (a human must judge "is this claim directionally correct" and "is this citation valid" for each of 20-30 real listings) and a go/no-go product decision that cannot be made by the verifier. This is an intentional, explicitly-scheduled operator gate per CONTEXT.md/ROADMAP.md, not an oversight.

### Gaps Summary

One minor, concretely-actionable gap was found: the vision section's placement satisfies the *architectural* half of Success Criterion 2 (own Card, distinct icon/vocabulary, DOM order after the ranking grid, never feeding the scorer — all test-locked) but falls short of the *visual* half by 8px — the outer container's `space-y-4` (16px) governs the actual gap between the ranking grid and the vision block, while the UI-SPEC explicitly requires >=24px (`space-y-6`/`lg` token) as a "REQUIRED minimum visual break," not merely aesthetic. This is a one-line CSS fix (e.g., wrap the grid+vision blocks in their own `space-y-6` container, or add `mt-6` to the vision wrapper) and does not undermine the structural-separation invariant itself, which is independently locked by a passing test.

All other in-code must-haves (extractor, schema, cost caps, two-pass pipeline, PII-ignore, structural separation, degraded states, eval harness) are verified against the actual codebase — full and targeted test suites are green, typecheck is clean, and no debt markers exist in any phase-touched file.

Two items are correctly and intentionally deferred to the operator per the phase's own design (not gaps): the live Apollo `images(` ref probe, and the live-render + 20-30-listing kill-criterion validation gate (plus the one live API schema smoke). These require real API spend, real scraped data, and human judgment of accuracy/citation validity that cannot be produced or judged by static verification — they are correctly classified as `human_verification` per the task instructions, driving the overall status to `human_needed` rather than `gaps_found` or `passed`.

---

*Verified: 2026-07-07T15:44:05Z*
*Verifier: Claude (gsd-verifier)*
