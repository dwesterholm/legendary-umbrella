---
phase: 11-gallery-condition-vision
plan: 01
subsystem: discovery
tags: [zod, typescript, anthropic-vision-prep, ssrf-guard, discovery, cost-caps]

# Dependency graph
requires:
  - phase: 10-niche-ranking
    provides: "DiscoveryCandidate 10-field PII-safe allowlist (constructionYear/brfName/tenureForm), discoveryCandidateSchema .nullable().default(null) precedent"
provides:
  - "imageUrls extractor (extractImageUrls) in reshapeListingEntity — host-allowlisted, floor-plan-first, capped at CAP_IMAGES_PER_LISTING (4), never-throwing"
  - "DiscoveryCandidate extended to 13 PII-safe fields (imageUrls, vision, visionSkippedReason)"
  - "vision-schema.ts — slim Claude-facing preFilterSchema/visionDeepPassSchema + persisted VisionResult/VisionConditionClaim + visionResultSchema read-guard + VISION_CONFIDENCE_THRESHOLD"
  - "CAP_VISION_SEK_MAX (10, separate from CAP_SEK_MAX) + visionCostSek composed cost function"
  - "scripts/probe-booli-images.ts — operator-deferred live-render probe of the real Apollo images( ref shape"
affects: [11-02-vision-pipeline, 11-03-gallery-condition-ui]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "extractImageUrls mirrors reshapeListingEntity's existing agency( argKeyedFieldOf idiom for images(, with a graceful never-throwing fallback to undefined"
    - "isAllowedImageHost mirrors isBooliUrl's real-hostname-check SSRF discipline (never a substring match), applied as defense-in-depth even though Anthropic's servers perform the actual fetch"
    - "visionDeepPassSchema mirrors extract.ts's claudeField single-nullable-leaf discipline — 3 flat named top-level fields, never z.array(z.object(...)), to avoid the documented output_config.format 400 trap"
    - "visionCostSek composes costSek(Haiku)+costSekSonnet(Sonnet) without redefining rates, mirroring discoveryCostSek's composition pattern"
    - "CAP_VISION_SEK_MAX is a distinct, independently-tracked cap from CAP_SEK_MAX/DISCOVERY_COST_CAP_SEK (never blended, per 11-RESEARCH.md Pitfall 2)"

key-files:
  created:
    - src/lib/discovery/vision-schema.ts
    - src/lib/discovery/vision-schema.test.ts
    - scripts/probe-booli-images.ts
  modified:
    - src/lib/booli/client.ts
    - src/lib/booli/client.test.ts
    - src/lib/discovery/candidate.ts
    - src/lib/discovery/candidate.test.ts
    - src/lib/discovery/cost.ts
    - src/lib/discovery/cost.test.ts
    - src/lib/discovery/filter-schema.ts
    - src/lib/discovery/filter-schema.test.ts
    - src/lib/discovery/job.test.ts
    - src/lib/discovery/niche-score.test.ts
    - src/components/discovery-candidate-card.test.tsx
    - src/components/discovery-results.test.tsx

key-decisions:
  - "The live Apollo images( ref probe is written (scripts/probe-booli-images.ts) but deliberately NOT run this plan — a small operator-approved Apify spend is deferred per orchestrator instruction. extractImageUrls is implemented against RESEARCH's documented assumed shape (Array<{ url?: string; type?: string }>) with a graceful, never-throwing fallback so the rest of Phase 11 is fully fixture-testable regardless of probe outcome"
  - "CAP_IMAGES_PER_LISTING (filter-schema.ts) is activated from Phase 9's 0-placeholder to 4 (1 floor plan + up to 3 gallery), matching CONTEXT.md's locked 'floor plan + 2-3 gallery' language — its Phase-9 no-op test assertion is updated to reflect the new value"
  - "imageUrls/vision/visionSkippedReason use .nullable().default(null) (never .optional() alone), exactly matching this file's own CR-01 fix comment and Phase 10's precedent, so a pre-Phase-11 persisted row missing the keys entirely still safeParses and normalizes to null, not undefined"
  - "vision and visionSkippedReason are unconditionally set to null inside toCandidate — vision runs as a separate later pass (Plan 02/03), never at scrape time, and toCandidate never reads a raw vision/visionSkippedReason key even if one were present on the raw record (test-asserted)"
  - "isAllowedImageHost allows booli.se/*.booli.se plus *.bcdn.se (Booli's CDN host family) — a real hostname check via new URL(), never a substring match, mirroring isBooliUrl's WR-03 hardening"
  - "visionResultSchema is a read-path guard only (no LLM-facing numeric constraints) — it validates persisted VisionResult rows, distinct from the Claude-facing visionDeepPassSchema which enforces the slim-schema discipline"

patterns-established:
  - "Static Zod-def-tree shape assertion (collectLeaves/isNullable/hasNumericConstraint walking .def.shape) as a repeatable test technique for catching the anthropic-structured-output-limits 400 class of bug before a live call — first use of this technique in the codebase"

requirements-completed: [DISC-04]

# Metrics
duration: 34min
completed: 2026-07-07
---

# Phase 11 Plan 1: Vision Foundation Contracts Summary

**Established the Phase 11 foundation contracts before any vision call exists: a never-throwing, host-allowlisted, floor-plan-first imageUrls extractor against Booli's Apollo images( ref (probe deferred, assumed-shape fallback), DiscoveryCandidate extended additive-nullable to 13 fields, a slim single-nullable-leaf vision citation schema statically asserted to avoid the documented output_config.format 400, and a separate CAP_VISION_SEK_MAX=10 cost cap.**

## Performance

- **Duration:** 34 min
- **Started:** 2026-07-07T14:42:16Z (approx, per plan-file read timestamp)
- **Completed:** 2026-07-07T15:16:16Z
- **Tasks:** 3 (1 deferred-live-probe checkpoint auto-approved-but-deferred + 2 auto/tdd)
- **Files modified:** 14 (3 created, 11 modified)

## Accomplishments
- `extractImageUrls` in `reshapeListingEntity` (src/lib/booli/client.ts) reads the `images(`-prefixed Apollo ref via the same `argKeyedFieldOf` idiom as the existing `agency(` extraction, host-allowlists via `isAllowedImageHost` (real hostname check, never substring), orders a floor-plan item first when a `type` discriminator identifies it, and caps at `CAP_IMAGES_PER_LISTING` (4) at extraction time — never throws, degrades to `undefined` on any missing/malformed ref.
- `DiscoveryCandidate`/`toCandidate`/`discoveryCandidateSchema` extended to 13 PII-safe fields with `imageUrls`/`vision`/`visionSkippedReason`, using the `.nullable().default(null)` discipline (no migration) — a pre-Phase-11 legacy row missing all three keys safeParses and normalizes to `null`.
- `vision-schema.ts` ships the slim Claude-facing `preFilterSchema`/`visionDeepPassSchema` (3 nullable leaves total, zero numeric-constraint chains, statically asserted by a Zod-def-tree-walking test) plus the persisted `VisionResult`/`VisionConditionClaim` interfaces and `visionResultSchema` read-guard.
- `CAP_VISION_SEK_MAX` (10, distinct from `CAP_SEK_MAX`) and `visionCostSek` (composes `costSek`+`costSekSonnet`, no new rates) land in `cost.ts`.
- `scripts/probe-booli-images.ts` is written and ready for the operator to run against a real listing — deliberately not executed this plan.

## Task Commits

Each task was committed atomically:

1. **Task 1: [SPIKE] Live-render probe script (auto-approved-but-deferred)** - `c2bb3b2` (feat)
2. **Task 3 (schema half, landed first as a Task 2 dependency): Slim vision citation schema + persisted VisionResult** - `352961e` (feat)
3. **Task 2: imageUrls extractor + candidate additive-nullable extension** - `36f9cb2` (feat)
4. **Task 3 (cost half): CAP_VISION_SEK_MAX + visionCostSek** - `01e1d24` (feat)

_Note: vision-schema.ts (Task 3's schema half) was committed before Task 2's candidate.ts extension because candidate.ts imports VisionResult/visionResultSchema from it — a dependency-order deviation from the plan's task numbering, not a scope change. Both halves of Task 3 (schema + cost) are otherwise as specified._

## Files Created/Modified
- `scripts/probe-booli-images.ts` - operator-deferred one-off live probe of the real Apollo `images(` ref shape (dumps arg-keyed `images(` fields + resolves bare `images` → `Image:` ref fallback for diagnostic completeness)
- `src/lib/discovery/vision-schema.ts` - slim Claude-facing pre-filter/deep-pass schemas + persisted VisionResult/VisionConditionClaim + read-guard + confidence threshold
- `src/lib/discovery/vision-schema.test.ts` - static shape assertions (nullable-leaf count, no numeric constraints) + parse/reject tests
- `src/lib/booli/client.ts` - `extractImageUrls`/`isAllowedImageHost` + wired into `reshapeListingEntity`; imports `CAP_IMAGES_PER_LISTING`
- `src/lib/booli/client.test.ts` - new `imageUrls` extractor describe block (cap/floor-plan-first/malformed-skip/host-allowlist/toCandidate-wiring/legacy-safeParse)
- `src/lib/discovery/candidate.ts` - `arrOfStr` helper; `DiscoveryCandidate`/`toCandidate`/`discoveryCandidateSchema` extended with `imageUrls`/`vision`/`visionSkippedReason`
- `src/lib/discovery/candidate.test.ts` - allowlist key set + new-row/legacy-row/vision-never-read-from-raw tests
- `src/lib/discovery/cost.ts` - `CAP_VISION_SEK_MAX` + `visionCostSek`
- `src/lib/discovery/cost.test.ts` - cap-distinctness + composition tests
- `src/lib/discovery/filter-schema.ts` - `CAP_IMAGES_PER_LISTING` activated 0 → 4
- `src/lib/discovery/filter-schema.test.ts` - updated no-op assertion to the activated value
- `src/lib/discovery/job.test.ts` - allowlist assertion + object literal extended for the 3 new fields (Phase 10 precedent repeated)
- `src/lib/discovery/niche-score.test.ts` - `makeCandidate` factory extended
- `src/components/discovery-candidate-card.test.tsx` / `discovery-results.test.tsx` - `makeCandidate` factories extended

## Decisions Made
See `key-decisions` in frontmatter above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Activated the pre-existing CAP_IMAGES_PER_LISTING placeholder (0 → 4) instead of introducing a new constant**
- **Found during:** Task 2 (imageUrls extractor)
- **Issue:** `filter-schema.ts` already declared `CAP_IMAGES_PER_LISTING = 0 as const` as a Phase-9 forward-looking no-op placeholder, with a test explicitly asserting it equals 0. The plan's `must_haves` require the extractor to cap at `CAP_IMAGES_PER_LISTING` (4) — using the existing constant name at its placeholder value would silently cap all images at zero.
- **Fix:** Updated the constant to `4`, updated its doc comment to describe the Phase 11 activation, and updated the corresponding `filter-schema.test.ts` assertion from `toBe(0)` to `toBe(4)`.
- **Files modified:** src/lib/discovery/filter-schema.ts, src/lib/discovery/filter-schema.test.ts
- **Verification:** `npx vitest run src/lib/discovery/filter-schema.test.ts` green; extractor cap test in client.test.ts confirms exactly 4 images survive a 6-image fixture.
- **Committed in:** 36f9cb2 (Task 2 commit)

**2. [Rule 1 - Bug] Updated job.test.ts/niche-score.test.ts/component test fixtures for the extended DiscoveryCandidate shape**
- **Found during:** Task 2, post-implementation `npx vitest run` / `npx tsc --noEmit` sweep
- **Issue:** `job.test.ts`'s allowlist-key assertion and 5 other test files' `DiscoveryCandidate`/`makeCandidate` object literals did not carry the 3 new required fields, causing 1 test failure (job.test.ts) and 3 tsc errors (discovery-candidate-card.test.tsx, discovery-results.test.tsx, niche-score.test.ts) after the interface extension.
- **Fix:** Added `imageUrls: null, vision: null, visionSkippedReason: null` to every affected fixture/factory and updated job.test.ts's expected key list, mirroring the exact precedent the Phase 10 commit `8a5f87a` already set for this same class of update.
- **Files modified:** src/lib/discovery/job.test.ts, src/lib/discovery/niche-score.test.ts, src/components/discovery-candidate-card.test.tsx, src/components/discovery-results.test.tsx
- **Verification:** `npx vitest run` (529 passed, 2 pre-existing skips) + `npx tsc --noEmit` (clean) after the fix.
- **Committed in:** 36f9cb2 (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking-constant-activation, 1 bug/type-error fixup)
**Impact on plan:** Both were required for the plan's own stated must_haves (a real, non-zero image cap) and for the codebase to compile/test green after the additive extension. No scope creep — no new files or capabilities beyond what Tasks 2/3 specify.

## Issues Encountered
- The real Booli `Listing:` fixture (`src/lib/booli/__fixtures__/listing-detail.json`) carries a BARE `images` key (an array of `{ __ref: "Image:<id>" }` Apollo normalized refs), not an arg-keyed `images(...)` field with inline url/type data — confirming RESEARCH's Open Question 1 is genuinely unresolved without a live probe. The probe script (`scripts/probe-booli-images.ts`) explicitly checks for and dumps this bare-ref case too (resolving each `Image:<id>` entity from the same Apollo state), so the operator's run will surface which shape is real. `extractImageUrls` itself is unaffected either way — it degrades to `undefined` gracefully if neither an arg-keyed `images(` field nor a resolvable bare-ref array is usable.

## User Setup Required

None - no external service configuration required for this plan.

**Operator Next Steps (deferred live probe):** When ready to confirm the real Apollo `images(` ref shape (small Apify spend, requires explicit go-ahead):

```bash
APIFY_API_TOKEN=$APIFY_API_TOKEN npx tsx scripts/probe-booli-images.ts "https://www.booli.se/annons/<a-real-active-listing-id>"
```

Report back either:
- the confirmed shape (per-image URL field name + whether a floor-plan `type`/`category` discriminator exists + whether URLs are directly public/fetchable), so `extractImageUrls` in `src/lib/booli/client.ts` can be adjusted if it differs from the assumed `Array<{ url?: string; type?: string }>` shape, OR
- "defer" to continue building Plans 02/03 against the current assumed-shape extractor (its graceful `undefined`-on-mismatch fallback means nothing downstream breaks either way — only real gallery images would be missing until the extractor is corrected).

## Next Phase Readiness
- Plan 02 (vision pipeline: Haiku pre-filter → Sonnet deep pass) can now build directly against `vision-schema.ts`'s `preFilterSchema`/`visionDeepPassSchema`/`VisionResult` and `cost.ts`'s `CAP_VISION_SEK_MAX`/`visionCostSek` — all contracts are unit-tested and stable.
- Plan 03 (structural-separation UI) can read `DiscoveryCandidate.vision`/`visionSkippedReason`/`imageUrls` directly — the additive-nullable shape is final for this phase.
- Blocker/watch item: the live Apollo `images(` ref probe is still operator-deferred. Until run, `imageUrls` will be `undefined`/`null` for every real candidate in production (the fixture-based extractor logic is correct and tested, but has not been proven against real Booli data). This does not block Plan 02/03 development (both work against `vision: null, visionSkippedReason: "no_images"` fixtures either way) but DOES block any real end-to-end vision output until the probe is run and, if needed, the extractor is corrected.

---
*Phase: 11-gallery-condition-vision*
*Completed: 2026-07-07*

## Self-Check: PASSED

All created/modified files confirmed present on disk; all 4 task commit hashes (c2bb3b2, 352961e, 36f9cb2, 01e1d24) confirmed in `git log`.
