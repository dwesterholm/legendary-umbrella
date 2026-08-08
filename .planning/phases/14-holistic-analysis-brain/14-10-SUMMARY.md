---
phase: 14-holistic-analysis-brain
plan: 10
subsystem: discovery-analysis
tags: [confounder-guard, brf, confidence-gating, swedish-prose, gap-closure]

# Dependency graph
requires:
  - phase: 14-holistic-analysis-brain
    provides: "brfFieldTrusted / BRF_CONFIDENCE_FIELDS / BrfSummary.fieldConfidence (plan 14-07's data spine)"
provides:
  - "normalizeForConfounders' debtUsable gate — a single brfFieldTrusted(brf, \"skuldPerKvm\") decision reused by rules 1/5/6, so an out-of-band debt figure can no longer enter effectivePricePerSqm or brf_debt_high"
  - "buildBrfItem confidence-gated per numeric field (avgiftsniva/skuldPerKvm/kassaflode), suppressing an untrusted figure and appending BRF_UNTRUSTED_FIGURE_TEXT instead of asserting it as fact"
  - "The avgift sentence in its real unit (kr/kvm och år), with a derived kr/mån clause only when livingArea is known and positive"
  - "STAMBYTE_PROSE — enum-to-Swedish-prose map with \"ej_nämnt\" -> null (no item) and a fail-closed unmapped-value guard"
  - "applyBannedAttributionGuard exported and directly tested"
affects: [14-VERIFICATION, 15, 16]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Single trust-decision-computed-once-and-reused (debtUsable) pattern, mirroring 14-07's brfFieldTrusted discipline of one gate function called from every consumer"
    - "Suppress-and-hedge display pattern: a withheld NON-NULL figure appends a named hedge sentence (BRF_UNTRUSTED_FIGURE_TEXT), distinct from simply-absent data which appends nothing"
    - "Enum-to-prose lookup map with an explicit null entry for the 'absence of information' sentinel, plus a `?? null` fail-closed branch for any value outside the map"

key-files:
  created: []
  modified:
    - src/lib/discovery/confounder-guard.ts
    - src/lib/discovery/confounder-guard.test.ts
    - src/lib/discovery/job.ts

key-decisions:
  - "brf_debt_high is now effectively extraction-unreachable: HIGH_BRF_DEBT_PER_SQM (15_000) === BRF_SANITY_BANDS.skuldPerKvm.max, so any raw-extraction value that would trip the >15_000 rule is exactly the set sanity.ts downgrades to untrusted. Routing an untrusted-but-high debt figure to brf_unknown instead of brf_debt_high was chosen over asserting a fact from a sanity-rejected figure — brf_unknown is true either way and strictly more conservative for attribution (D-14-05). brf_debt_high now only fires for a confidence sourced from something other than raw extraction (e.g. a future applyManualConfidence path or a band-widening change)."
  - "The avgift sentence states the field's REAL unit (kr/kvm och år) as its primary claim unconditionally, and appends a derived kr/mån clause ONLY when livingArea is known and > 0 — never relabels the raw SEK/m²/år figure as monthly, and never silently omits a monthly-equivalent when the data to compute one exists."
  - "STAMBYTE_PROSE's WR-09 boundary: BrfSummary.stambytePlanerat stays typed string | null and brfSummarySchema stays z.string().nullable() (holistic-schema.ts untouched) — the enum lookup fails closed via `?? null` for any value outside the three known keys, so narrowing to StambyteStatus remains deferred without weakening safety."

patterns-established: []

requirements-completed: [ANL-01, ANL-03, ANL-04]

# Metrics
duration: 20min
completed: 2026-08-08
---

# Phase 14 Plan 10: BRF Confidence-Gated Confounder Guard + Unit-Correct Avgift + Stambyte Prose Summary

**Closed the three source-level data-correctness defects (CR-01/CR-02/CR-03) that 14-VERIFICATION.md's ANL-03/ANL-04 re-check surfaced: an out-of-band `skuldPerKvm` can no longer poison `effectivePricePerSqm` or disable the SPEC §2.6 20% attribution cap, the avgift sentence now states its real SEK/m²/år unit with a correctly-derived kr/mån clause, and `stambytePlanerat` renders as real Swedish prose with the "not mentioned" sentinel producing no item at all.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-08-08T17:00:00+02:00 (approx)
- **Completed:** 2026-08-08T17:16:57+02:00
- **Tasks:** 3/3 completed
- **Files modified:** 3

## Accomplishments

- **CR-02 (the ANL-04 keystone fix):** `normalizeForConfounders` now computes a single `debtUsable = brfFieldTrusted(brf, "skuldPerKvm")` decision before rule 1, reused by rules 1 (debt-inclusive normalization), 5 (`brf_debt_high` residual driver) and 6 (`brf_unknown`). A classic misextraction — 480 000 kr/kvm at confidence 0.2 — is proven to leave `debtIncluded === false`, `effectivePricePerSqm === pricePerSqm` (unchanged), `deepDiscount === true`, and, critically, `conditionCapApplied === true` with `conditionExplainedPct === MAX_CONDITION_EXPLAINED_PCT` — exactly the SPEC §2.6 20% cap the fix exists to protect. Before this fix the same input pushed `effectivePricePerSqm` to 540 000 (far above the 100 000 renovated median), making `discountVsRenovatedPct` strongly negative and `deepDiscount === false`, silently disabling the cap.
- `buildBrfItem` gates each numeric sentence (avgiftsniva/skuldPerKvm/kassaflode) on `brfFieldTrusted`; a NON-NULL value suppressed for low confidence appends `BRF_UNTRUSTED_FIGURE_TEXT` ("Någon av föreningens siffror låg utanför ett rimligt intervall och visas därför inte här — kontrollera avgift och skuld per kvm i föreningens årsredovisning."), keeping the item actionable instead of either asserting a sanity-rejected number as fact or silently shrinking the brief. A simply-null field (absent data, never extracted) does not trigger the hedge.
- **CR-01:** the avgift sentence now reads `"Årsavgiften ligger kring N kr/kvm och år."` and, only when `livingArea` is a known positive number, appends `" (motsvarar ca M kr/mån för X kvm)."` where `M = round(avgiftsniva * livingArea / 12)`. Worked example: `avgiftsniva: 650`, `livingArea: 70` → `"Årsavgiften ligger kring 650 kr/kvm och år (motsvarar ca 3792 kr/mån för 70 kvm)."` (650 × 70 / 12 = 3791.67 → 3792). With `livingArea: null` the sentence is exactly `"Årsavgiften ligger kring 650 kr/kvm och år."` with no `"kr/mån"` substring at all. `livingArea: 0` also produces no `kr/mån` clause (no divide-by-zero, no absurd figure). `livingArea` was threaded through `BuildHolisticBriefInput`, `buildBrfItem`'s new second parameter, and `job.ts`'s `buildHolisticBrief` call site (`livingArea: c.livingArea` — the second occurrence alongside the pre-existing one on `normalizeForConfounders`'s call).
- **CR-03:** `STAMBYTE_PROSE` maps the bounded `stambytePlanerat` enum to real Swedish sentences — `"planerat"` → `"Föreningen har ett planerat stambyte."`, `"nyligen_genomfort"` → `"Föreningen har nyligen genomfört stambyte."`, `"ej_nämnt"` → `null` (no sentence at all, since per `prompt.ts:40` it means the document does not mention stambyte). An unmapped string fails closed via `?? null` — never reaches user-facing prose. A test proves a candidate whose only BRF signals are `"ej_nämnt"` plus every other field null produces NO `"brf"` item while `buildHolisticBrief`'s `items.length >= 1` guarantee still holds (the ANL-01 fallback item fires instead). `applyBannedAttributionGuard` is now exported and directly tested (banned input → `RENO_ATTRIBUTION_FALLBACK_TEXT`, clean input → unchanged), since no pipeline field carries free-form prose into a brief item anymore — the free-form `stambytePlanerat` fixture that used to exercise this branch through the pipeline is now unreachable by construction.
- Every test fixture's `avgiftsniva` literal that encoded CR-01's unit mistake was corrected to sit inside `BRF_SANITY_BANDS.avgiftsniva` (300–1200): `makeBrf`'s default `3_500 → 650`, and the two other test-table literals `3_800 → 700`. Two new task-1 tests intentionally use an in-band-but-untrusted value (`900` at confidence `0.2`) to test the suppression path without reintroducing a banned literal — `grep -c "4_200\|3_500\|3_800"` on the test file returns 0.
- Confirmed unchanged, per the plan's explicit out-of-scope list: `ConditionAttribution.explainedPct` persistence (WR-10), the comps-positioning item / `pricePerSqm` usage (WR-06), the area cap (WR-04), `BrfSummary.stambytePlanerat` / `brfSummarySchema` staying `string | null` / `z.string().nullable()` (WR-09), and `gallery-condition-vision.tsx` (WR-11). No DB migration — `git diff --stat` across all three commits touches exactly the three files the plan named.

## Task Commits

Each task was committed atomically:

1. **Task 1: Gate the debt-inclusive normalization AND the BRF display on brfFieldTrusted (CR-02)** - `a81a9e9` (fix)
2. **Task 2: State the avgift in the unit it actually carries, with a derived monthly figure (CR-01)** - `0e41637` (fix)
3. **Task 3: Map stambytePlanerat to Swedish prose and suppress the ej_nämnt case (CR-03)** - `ee357e9` (fix)

_No TDD RED/GREEN split — each task's behavior table was implemented and tested together within a single commit, consistent with how prior Phase 14 plans (e.g. 14-07) committed under the same `tdd="true"` marking._

## Files Created/Modified

- `src/lib/discovery/confounder-guard.ts` - Added `debtUsable` gate to `normalizeForConfounders` (rules 1/5/6); confidence-gated `buildBrfItem`'s three numeric sentences with `BRF_UNTRUSTED_FIGURE_TEXT` suppression hedge; rewrote the avgift sentence to state kr/kvm och år with a derived kr/mån clause; added `STAMBYTE_PROSE` enum-to-prose map; exported `applyBannedAttributionGuard`; added `readonly livingArea: number | null` to `BuildHolisticBriefInput`.
- `src/lib/discovery/confounder-guard.test.ts` - Added `describe("CR-02 ...")`, `describe("CR-01 ...")`, and `describe("CR-03 ...")` blocks covering every behavior-table row; corrected `avgiftsniva` fixtures to sit inside the real sanity band; replaced the now-unreachable free-form-`stambytePlanerat` enforcement test with a direct `applyBannedAttributionGuard` test plus a suppression test; added the no-raw-snake_case invariant to the existing eight-input banned-pattern table; added inline comments marking the pre-existing trusted-`20_000`-debt fixtures as synthetic (a shape the raw extraction pipeline cannot itself produce, since 20_000 is outside `BRF_SANITY_BANDS.skuldPerKvm`).
- `src/lib/discovery/job.ts` - Added `livingArea: c.livingArea` to the `buildHolisticBrief` call site (the `normalizeForConfounders` call already had it from an earlier plan).

## Decisions Made

See `key-decisions` in frontmatter for the three load-bearing decisions (brf_debt_high's extraction-unreachability trade-off, the avgift sentence's unconditional-real-unit-plus-conditional-derived-clause shape, and STAMBYTE_PROSE's WR-09 boundary).

## Deviations from Plan

None - plan executed exactly as written. All acceptance-criteria greps (`Number.isFinite(brf.skuldPerKvm)` count 0, `brfFieldTrusted` count ≥5, `debtUsable` declared exactly once before rule 1, `kr/mån` count exactly 1 in the derived clause, `kr/kvm och år` count ≥1, `livingArea` threaded through both files, `Stambyte-läge` count 0, `STAMBYTE_PROSE` exported with `"ej_nämnt": null`, `applyBannedAttributionGuard` exported exactly once, `stambytePlanerat` still `string | null` / `z.string().nullable()` in `holistic-schema.ts`) matched on first implementation, requiring no rework.

One minor self-correction during implementation: the first draft of the CR-01 source comment used the literal string `"kr/mån"` twice in a doc comment, which broke the `grep -c "kr/mån"` === 1 acceptance criterion (grep counts matching *lines*, not occurrences, and comment lines counted too). Reworded the comment to describe the concept without repeating the literal token — the derived clause itself remains the single source occurrence. Not logged as a plan deviation (no behavior change, no rule triggered) — noted here for completeness.

## Existing Test Assertions That Changed

- `confounder-guard.test.ts`'s single `'"exercises the drop-and-replace enforcement branch"'` test (previously fed a free-form banned string through `stambytePlanerat`) was replaced by two tests: a direct `applyBannedAttributionGuard` unit test, and a suppression test proving the same free-form string is now dropped entirely (never reaches any item text) since `stambytePlanerat` is a bounded-enum lookup as of this plan.
- The `"a brf-present input produces a brf item..."` test's assertion changed from `toContain("4200")` to `toContain("650 kr/kvm och år")`, reflecting both the corrected fixture value and CR-01's new sentence shape.
- `makeBrf`'s default `avgiftsniva` changed from `3_500` to `650` (in-band per `BRF_SANITY_BANDS.avgiftsniva`); every test relying on the default's absolute value (there were none asserting `"3500"` verbatim) is unaffected.

## Issues Encountered

None. `npx tsc --noEmit`, `npm run lint`, `npm run test` (919 passed, 3 skipped), and `npm run build` were all green after task 3. The plan's full verification list — `confounder-guard.test.ts`, `job.test.ts`, `holistic-schema.test.ts`, `brf-lookup.test.ts`, `gallery-condition-vision.test.tsx`, `discovery-results.test.tsx` — was run together and passed (188 tests) to confirm no snapshot/assertion elsewhere depended on the old, incorrect sentences.

## User Setup Required

None - no external service configuration required. No DB migration.

## Deferred / Out of Scope (by decision, not oversight)

- **WR-04** (the area cap) — untouched.
- **WR-06** (using `pricePerSqm` in the comps-positioning item) — `BuildHolisticBriefInput.pricePerSqm` remains declared and unread.
- **WR-09** (narrowing `BrfSummary.stambytePlanerat` to `StambyteStatus`) — `holistic-schema.ts` untouched; `STAMBYTE_PROSE`'s lookup handles an arbitrary string safely via its fail-closed `?? null` branch, so the narrowing remains a pure type-safety improvement for a future plan, not a correctness gap today.
- **WR-10** (`conditionAttribution.explainedPct` persistence) — untouched.
- **WR-11** (`gallery-condition-vision.tsx`) — untouched; confirmed by `gallery-condition-vision.test.tsx` passing unmodified.
- **DEFERRED-LIVE** (14-VERIFICATION.md `human_verification` item 4, carried forward verbatim) — re-running the CR-01/CR-02/CR-03 fixes against a real Allabrf-extracted document once Supabase is restored and the operator IP is unblocked remains outstanding and does not block this plan.

## Next Phase Readiness

- ANL-01/ANL-03/ANL-04's re-verification gap (recorded in `14-VERIFICATION.md` as `gaps_found`) should now close on re-run — the two source-level defects that failure targeted (CR-02's debt-poisoning path and its interaction with the §2.6 cap) are fixed and keystone-tested.
- `confounder-guard.ts`'s public surface grew by three exports (`BRF_UNTRUSTED_FIGURE_TEXT`, `STAMBYTE_PROSE`, `applyBannedAttributionGuard`) and one interface field (`BuildHolisticBriefInput.livingArea`) — `ConfounderGuardResult`'s shape, `HolisticBrief`'s shape, `BANNED_RENO_ATTRIBUTION_PATTERNS` and `RENO_ATTRIBUTION_FALLBACK_TEXT` are unchanged, so Phase 15/16 consumers of this module's existing exports need no rework.
- Phase 16's value-gap ranking (which depends on Phase 14's comps/BRF wiring) now inherits a debt figure that can no longer be silently poisoned — no additional guard needed on that path.

## Self-Check: PASSED

All 3 modified files confirmed present on disk with the expected content (`grep` acceptance-criteria checks re-run above all passed). All 3 task commit hashes (`a81a9e9`, `0e41637`, `ee357e9`) confirmed present in `git log --oneline --all`.

---
*Phase: 14-holistic-analysis-brain*
*Completed: 2026-08-08*
