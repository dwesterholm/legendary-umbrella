---
phase: 14-holistic-analysis-brain
plan: 02
subsystem: discovery
tags: [confounder-guard, value-gap, spec-2.6, holistic-brief, banned-attribution-guard]

# Dependency graph
requires:
  - phase: 14-holistic-analysis-brain
    plan: 01
    provides: holistic-schema.ts's AreaCompsSummary/BrfSummary/HolisticBrief types, HOLISTIC_DATA_ONLY_MARKER, tomtrattFromTenureForm — this plan's confounder-guard.ts imports all of them
  - phase: 14-holistic-analysis-brain (pre-existing, on main)
    provides: area-comps.ts's MIN_COMPS_FOR_CONFIDENCE (imported, never redefined) and vision.ts's banned-word drop-and-replace ordering discipline (the pattern this plan's BANNED_RENO_ATTRIBUTION_PATTERNS mirrors)
provides:
  - normalizeForConfounders(input) — SPEC §2.6's discount-attribution guard as a pure function (debt-inclusive kr/m², 25%/20% cap + specific-confounder residual routing, >=5-comp confidence gate, never-"high" confidence, D-14-05 always-false canAttributeToCondition)
  - buildHolisticBrief(input) — the ANL-01 non-empty-brief builder with a code-enforced "never imply låg kr/m² ⇒ renoveringsobjekt" guard
  - Seven SPEC-locked exported constants (DISCOUNT_ATTRIBUTION_TRIGGER_PCT, MAX_CONDITION_EXPLAINED_PCT, HIGH_BRF_DEBT_PER_SQM, ODD_BOA_MIN_SQM, ODD_BOA_MAX_SQM, WIDENED_SIZE_BAND_PCT, WIDENED_MAX_AGE_MONTHS) for job.ts (later plans) to consume by name, never a literal
affects: [14-03, 14-04, 14-05, 14-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure discount-attribution guard module (no I/O, no model calls) mirroring area-comps.ts/flip-economics.ts's exact file-header + export-style discipline"
    - "Code-enforced banned-phrase drop-and-replace on RAW composed text before return, mirroring vision.ts's banned-word REJECTION ordering for the remodelPotential claim"
    - "Confounder items gated on comps/BRF presence so the non-empty-brief guarantee correctly degrades to a single honest insufficient-data item, never a confounder item about nothing"

key-files:
  created:
    - src/lib/discovery/confounder-guard.ts
    - src/lib/discovery/confounder-guard.test.ts

key-decisions:
  - "canAttributeToCondition is structurally ALWAYS false in Phase 14 (D-14-05) — rule 6 unconditionally records elevator/micro-location/sub-area as unknown every run, so the `unknownConfounders.length === 0` term in the expression never holds; the expression is written so a later phase that supplies those inputs flips the value with zero shape change, rather than hardcoding `false` as a literal."
  - "The debt-inclusive kr/m² normalization (rule 1) forces confidence to 'low' whenever debtIncluded is true, because the comp side's debt is structurally unknowable from computeAreaComps' output — comparing a debt-adjusted candidate against un-adjusted comps is a known asymmetry, documented inline, never presented as a precise figure."
  - "The confounder items in buildHolisticBrief are gated on `comps !== null || brf !== null` (not unconditional, despite the plan action text's literal wording) — an all-null input has nothing for the hedonic reasoning to attach to, so it correctly falls through to the single insufficient-data item rather than a confounder item naming unknowns about nothing. This was discovered as a test failure during Task 3 (see Deviations)."
  - "BANNED_RENO_ATTRIBUTION_PATTERNS includes a bare, unconditional /renoveringsobjekt/i catch-all — deliberately absolute, because the reno CONCLUSION is deferred to Phase 15/16 and this phase's briefs must never use the word at all, not even in a hedged sentence."

requirements-completed: [ANL-01, ANL-04]

# Metrics
duration: 40min
completed: 2026-08-05
---

# Phase 14 Plan 02: Confounder Guard + Holistic Brief Summary

**Encoded SPEC §2.6's discount-attribution guard (`normalizeForConfounders`) and the "LOW kr/m² ≠ RENO OBJECT" holistic-data-only brief builder (`buildHolisticBrief`) as a pure, fully-unit-tested module with a code-enforced banned-attribution guard.**

## Performance

- **Duration:** ~40 min
- **Completed:** 2026-08-05T21:00:00Z
- **Tasks:** 3
- **Files modified:** 2 (both created)

## Accomplishments

- `src/lib/discovery/confounder-guard.ts` (247 lines) implements all eight §2.6 rules in the exact stated order: debt-inclusive kr/m² normalization, discount-vs-renovated-median, the >25% deep-discount trigger, the 20% condition-explained cap, specific-confounder residual routing (never a generic driver), the always-on unknown-confounder list (elevator/micro-location/sub-area), the ≥5-comp confidence gate, and the D-14-05 default `canAttributeToCondition: false` posture.
- The module is provably pure: it imports `MIN_COMPS_FOR_CONFIDENCE` from `area-comps.ts` (never redefines it), imports types from `holistic-schema.ts`, and has zero imports from `job.ts`, `vision.ts`, `booli/client.ts`, Supabase or the Anthropic SDK.
- `buildHolisticBrief` guarantees `items.length >= 1` for every possible input (ANL-01) — proven by an explicit post-composition check plus a mock-free test on the all-null input.
- `BANNED_RENO_ATTRIBUTION_PATTERNS` + `RENO_ATTRIBUTION_FALLBACK_TEXT` enforce SPEC §2.6's closing sentence ("Never render UI text implying 'low kr/m² ⇒ renovation object'") at the data-construction layer, mirroring `vision.ts`'s existing banned-word drop-and-replace ordering discipline — the RAW composed text is inspected first, then fully replaced (never appended to) on any match, applied to every item kind including `insufficient-data`.
- 28 mock-free unit tests across 12 `describe` blocks cover every §2.6 rule plus the ANL-01/banned-attribution guard, including a test that exercises the actual drop-and-replace branch through a real composed BRF item (not a synthetic call to a private helper).

## Task Commits

Each task was committed atomically:

1. **Task 1: Create confounder-guard.ts with normalizeForConfounders (SPEC §2.6 rules)** - `1980e72` (feat)
2. **Task 2: Unit-test every §2.6 rule in confounder-guard.test.ts** - `386b259` (test)
3. **Task 3: Add buildHolisticBrief with the banned-attribution guard (ANL-01 content)** - `322fac0` (feat)

_No TDD tasks in this plan — Task 1 is a pure-module feat commit, Task 2 is the paired unit-test commit for that module (not a RED/GREEN cycle since the module already existed), and Task 3 is a second feat commit extending the same file plus its test file in one atomic unit._

## Files Created/Modified

- `src/lib/discovery/confounder-guard.ts` - NEW (453 lines): `DISCOUNT_ATTRIBUTION_TRIGGER_PCT` (0.25), `MAX_CONDITION_EXPLAINED_PCT` (0.2), `HIGH_BRF_DEBT_PER_SQM` (15000), `ODD_BOA_MIN_SQM`/`ODD_BOA_MAX_SQM` (20/160), `WIDENED_SIZE_BAND_PCT`/`WIDENED_MAX_AGE_MONTHS` (0.3/24), `ConfounderId`, `ConfounderGuardInput`/`ConfounderGuardResult`, `normalizeForConfounders`, `BANNED_RENO_ATTRIBUTION_PATTERNS`, `RENO_ATTRIBUTION_FALLBACK_TEXT`, `BuildHolisticBriefInput`, `buildHolisticBrief`.
- `src/lib/discovery/confounder-guard.test.ts` - NEW (388 lines): 28 tests across 12 `describe` blocks — one per §2.6 rule plus the ANL-01/banned-attribution guard block, using local `makeComps`/`makeBrf`/`makeInput` factories, no `vi.mock`, no async.

## Decisions Made

- `canAttributeToCondition` is structurally always `false` this phase (D-14-05) — the expression `!deepDiscount && unknownConfounders.length === 0 && comps !== null && comps.confident === true` never has its second term hold because elevator/micro-location/sub-area are unconditionally pushed to `unknownConfounders` every run. Written this way (not hardcoded `false`) so a later phase supplying those inputs flips the value with zero shape change.
- Debt-inclusive normalization (rule 1) forces `confidence: "low"` whenever `debtIncluded === true`, because the comp side's debt is structurally unknowable from `computeAreaComps`'s output — a debt-adjusted candidate is compared against un-adjusted comps, a known asymmetry documented inline rather than presented as a precise figure.
- `buildHolisticBrief`'s confounder items (`kind: "confounder"`) are gated on `comps !== null || brf !== null`, not unconditional. See Deviations below — this was required to satisfy the ANL-01 acceptance criterion that an all-null input's single item has `kind: "insufficient-data"`.
- `BANNED_RENO_ATTRIBUTION_PATTERNS`'s bare `/renoveringsobjekt/i` catch-all is deliberately absolute — this phase's briefs must never use the word at all (not even hedged), because the reno CONCLUSION is deferred to Phase 15/16.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Confounder items were unconditional, breaking the ANL-01 all-null → insufficient-data guarantee**
- **Found during:** Task 3, first test run (`npx vitest run src/lib/discovery/confounder-guard.test.ts`)
- **Issue:** The plan's action text for `buildHolisticBrief` describes the `"confounder"` item summarizing `guard.unknownConfounders` without an explicit gating condition, and `unknownConfounders` is NEVER empty (it always contains `elevator_unknown`/`micro_location_unknown`/`sub_area_unknown` per rule 6). Implemented literally, this meant `items` could never be empty, so the plan's own acceptance criterion — "the single item on the all-null input has `kind: 'insufficient-data'`" — could never be satisfied; the test failed with `expected 'confounder' to be 'insufficient-data'`.
- **Fix:** Gated both confounder items (`buildConfounderItems(guard)`) on `comps !== null || brf !== null` — the confounder/unknown-confounder reasoning only makes sense attached to some other data source; with neither comps nor a BRF summary there is nothing to relate it to, so the module correctly falls through to the single `insufficient-data` item instead.
- **Files modified:** `src/lib/discovery/confounder-guard.ts`
- **Commit:** `322fac0`

Or: the rest of the plan executed exactly as written — no other deviations.

## Issues Encountered

None beyond the one auto-fixed issue documented above.

## Verification (from the plan's `<verification>` block)

- `npx vitest run src/lib/discovery/confounder-guard.test.ts` — **28/28 passed** (12 `describe` blocks, exceeding the required 9/18 minimum).
- `npx vitest run src/lib/discovery/area-comps.test.ts src/lib/discovery/niche-score.test.ts` — **27/27 passed** (the structural-separation grep guard is unaffected; `confounder-guard` was already registered in `VISION_MODULE_SPECIFIERS` by 14-01).
- `npx tsc --noEmit` — clean.
- `npm run lint` — clean.
- `npm run test` (full suite) — **797 passed | 3 skipped** (the 3 skips are pre-existing, unrelated to this plan).

### Acceptance-criteria greps (all confirmed directly, not assumed)

- `grep -c 'MIN_COMPS_FOR_CONFIDENCE' src/lib/discovery/confounder-guard.ts` → `3` (import + 2 uses).
- `grep -E 'from "@/lib/(discovery/(job|vision)|booli/client|supabase)' src/lib/discovery/confounder-guard.ts` → no match (module is pure).
- `grep -c '@anthropic-ai/sdk' src/lib/discovery/confounder-guard.ts` → `0`.
- `grep -c 'HOLISTIC_DATA_ONLY_MARKER' src/lib/discovery/confounder-guard.ts` → `2` (import + use); `grep -c 'Baserat på områdesdata'` → `0` (never duplicated, always imported).
- `grep -c 'vi.mock' src/lib/discovery/confounder-guard.test.ts` → `0`.
- All seven SPEC-locked constants exported with exact values 0.25 / 0.2 / 15000 / 20 / 160 / 0.3 / 24, asserted directly in a dedicated "SPEC-locked constants sanity" test block.

## Final Constant Values (for downstream plans)

| Constant | Value |
|---|---|
| `DISCOUNT_ATTRIBUTION_TRIGGER_PCT` | `0.25` |
| `MAX_CONDITION_EXPLAINED_PCT` | `0.2` |
| `HIGH_BRF_DEBT_PER_SQM` | `15_000` |
| `ODD_BOA_MIN_SQM` | `20` |
| `ODD_BOA_MAX_SQM` | `160` |
| `WIDENED_SIZE_BAND_PCT` | `0.3` |
| `WIDENED_MAX_AGE_MONTHS` | `24` |

## BANNED_RENO_ATTRIBUTION_PATTERNS (exact list)

```
/l[åa]gt?\s*(kr|pris)[\s/]*kv?m[\s\S]{0,60}renoverings(objekt|behov)/i
/renoverings(objekt|behov)[\s\S]{0,60}l[åa]gt?\s*(kr|pris)[\s/]*kv?m/i
/under\s+snittet[\s\S]{0,60}renoverings(objekt|behov)/i
/renoverings(objekt|behov)[\s\S]{0,60}under\s+snittet/i
/renoveringsobjekt/i
```

The final entry is an unconditional bare catch-all — this phase's briefs must never use the word `renoveringsobjekt` at all, hedged or otherwise, since the reno conclusion is deferred to Phase 15/16.

## canAttributeToCondition — always false this phase, and why

`canAttributeToCondition` is defined as `!deepDiscount && unknownConfounders.length === 0 && comps !== null && comps.confident === true`. Because rule 6 unconditionally pushes `"elevator_unknown"`, `"micro_location_unknown"`, and `"sub_area_unknown"` onto `unknownConfounders` on every single call (D-14-05: no new scraping this phase, no data source exists for elevator/micro-location), the `unknownConfounders.length === 0` term can never be true, so the whole expression is structurally always `false`. This is the intended default posture — "cannot attribute to condition" rather than a silent assumption — and the expression is deliberately written as a real boolean formula (not a hardcoded literal) so that a future phase which supplies elevator/micro-location data flips the value automatically, with zero shape change to this module.

## OQ-2 Tomträtt-Inertness Test

`tomtrattFromTenureForm` (from 14-01) never returns `false` — only `true | null` — because `tenureForm` structurally cannot disprove tomträtt (the BRF, not the unit, holds it). This plan's "tomträtt is handled defensively (research OQ-2)" describe block makes that inertness OBSERVABLE: it asserts `tenureForm: "Tomträtt"` correctly routes to `residualDrivers` (never `unknownConfounders`), `tenureForm: "Bostadsrätt"` — the ONLY value any committed fixture in the repo has ever carried — correctly routes to `unknownConfounders` (`"tomtratt_unknown"`), never `residualDrivers`, and `tenureForm: null` behaves identically to `"Bostadsrätt"`. Without this test, the `"Bostadsrätt"`-is-unknown branch would be logically present but never exercised against real fixture data — the test is what proves the branch is live, not just written.

## Known Stubs

None — this plan is a pure, fully-implemented module with no UI wiring yet (that lands in a later 14-* plan per 14-CONTEXT.md's scope boundary: D-14-07 limits Phase 14's UI footprint to the data-only marker/confounder-safe framing, wired in a subsequent plan). `buildHolisticBrief`'s output is not yet called from `job.ts`/`vision.ts` — this plan only builds and unit-tests the pure function; wiring it into the live analysis path is a separate wave-2/3 plan's responsibility per the roadmap.

## Threat Flags

None beyond what the plan's own `<threat_model>` already disposes (T-14-05 through T-14-08, all `mitigate`, all directly implemented: the banned-attribution drop-and-replace, the numeric/enum-only input surface with no PII read, the structurally-capped confidence, and the pre-existing `VISION_MODULE_SPECIFIERS` registration from 14-01). No new network endpoint, auth path, or trust-boundary schema was introduced.

## User Setup Required

None — no external service configuration required, no DB migration, no live Supabase/Anthropic access needed for this plan (fully covered by the current PAUSED-Supabase environment note; this plan performed zero live work by design).

## Next Phase Readiness

- `normalizeForConfounders` and `buildHolisticBrief` are ready for the next Phase-14 plan to wire into `job.ts`'s `runVisionForJob` (per 14-PATTERNS.md's injection-point analysis: after `enrichCandidateImages`, before `runVisionPass`) — this plan deliberately does not touch `job.ts`/`vision.ts`.
- The seven exported constants (`WIDENED_SIZE_BAND_PCT`/`WIDENED_MAX_AGE_MONTHS` in particular) are ready for `job.ts`'s second `computeAreaComps` call on a thin tight-segment sample.
- No blockers. The Supabase project pause does not affect this plan — no live DB work was performed or required, per the environment note.

## Self-Check: PASSED

All claimed files exist on disk (`src/lib/discovery/confounder-guard.ts`, `src/lib/discovery/confounder-guard.test.ts`) and all three task commit hashes (`1980e72`, `386b259`, `322fac0`) are present in `git log`.

---
*Phase: 14-holistic-analysis-brain*
*Completed: 2026-08-05*
