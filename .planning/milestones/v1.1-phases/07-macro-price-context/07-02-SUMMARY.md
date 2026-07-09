---
phase: 07-macro-price-context
plan: 02
subsystem: api
tags: [supabase, next-server-actions, zod, riksbank, scb, ai-prompt, vitest]

# Dependency graph
requires:
  - phase: 07-macro-price-context
    provides: "Plan 01's fetchMacroSnapshot/MacroData/safeParseMacroData (macro.ts, macro-schema.ts) + live macro_snapshots cache table (migration 006)"
provides:
  - "enrichMarketContext's 4th independent MACRO branch, persisting analyses.macro_data (migration 007) without gating terminal status"
  - "FactSheetInput.macro slot wired into both assembleFactSheet call sites (generate-report.ts synthesis input, page.tsx D-08 fingerprint recompute)"
  - "prompt.ts ABSOLUT REGEL 5 (macro descriptive-only) + REPORT_SYNTHESIS_PROMPT_VERSION v2"
  - "banned-phrases.ts (BANNED_PREDICTIVE_PHRASES, MACRO_CARD_LABELS) + banned-predictive-phrases.test.ts — the tertiary MACRO-02 enforcement layer"
  - "Live CPIF ContentsCode fix (PR0101G1 → 000007ZM) — corrects a Wave-1-flagged risk that was actually broken"
affects: [07-03-macro-card]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "4th independent-branch degradation added to enrichMarketContext, mirroring the existing PRICE/AREA branch shape exactly"
    - "Shared banned-phrase const co-located with the labels it guards (single source of truth for a prompt rule + its regression test + a future UI component)"
    - "Deterministic string-scan regression test (no LLM judge) as a tertiary enforcement layer alongside schema-shape + prompt-rule"

key-files:
  created:
    - supabase/migrations/007_macro_data_column.sql
    - src/lib/report/banned-phrases.ts
    - src/lib/report/banned-predictive-phrases.test.ts
    - .planning/phases/07-macro-price-context/deferred-items.md
  modified:
    - src/actions/enrich-market-context.ts
    - src/actions/generate-report.ts
    - src/app/(app)/analysis/[id]/page.tsx
    - src/lib/report/fact-sheet.ts
    - src/lib/report/prompt.ts
    - src/lib/market/macro.ts
    - src/lib/market/__fixtures__/scb-cpif.json
    - evals/report.test.ts

key-decisions:
  - "Added migration 007 (analyses.macro_data jsonb, additive-nullable) since Plan 01 confirmed the column did not yet exist — pushed live via supabase db push --linked, verified applied"
  - "Cast the real SupabaseClient with `as never` when calling fetchMacroSnapshot from enrichMarketContext, mirroring macro.test.ts's existing convention — the concrete client's deeply generic builder chain triggers TS2589 against the minimal SupabaseLike structural interface"
  - "Wired FactSheetInput.macro through BOTH assembleFactSheet call sites (generate-report.ts's real synthesis input AND page.tsx's D-08 fingerprint recompute), not just the type — the plan's stated purpose (macro reaches the AI narration path) requires both, and page.tsx's recompute must byte-match generate-report.ts or stale detection silently desyncs (T-04-24)"
  - "Excluded bare words 'prognos'/'forecast' from BANNED_PREDICTIVE_PHRASES — ABSOLUT REGEL 5's own disclaimer and the macro card subtitle legitimately use the word to NEGATE prediction; banning it would make the disclaimer text itself untestable. Concrete directional/timing/buy-sell phrases carry the enforcement weight instead"
  - "Fixed the CPIF ContentsCode live (PR0101G1 → 000007ZM) after a live curl against SCB's own table metadata confirmed the Wave-1-flagged risk was a real 400, not a hypothetical one"

patterns-established:
  - "MACRO_CARD_LABELS exported from banned-phrases.ts (not macro-context-card.tsx) so the regression test and Plan 03's card render from one shared constant"

requirements-completed: [MACRO-01, MACRO-02]

# Metrics
duration: 20min
completed: 2026-07-06
---

# Phase 7 Plan 2: Backend Wiring + No-Prediction Enforcement Summary

**4th independent MACRO branch in enrichMarketContext persisting macro_data via a new migration, a fact-sheet macro slot wired into both the AI synthesis path and the D-08 fingerprint recompute, prompt.ts's ABSOLUT REGEL 5 (v2), and a deterministic banned-predictive-phrase regression test — plus a live-verified fix to a previously-inferred, actually-broken SCB ContentsCode.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-07-06T21:53:00Z (session start; see 07-01-SUMMARY.md for wave boundary)
- **Completed:** 2026-07-06
- **Tasks:** 3 (Task 3 ran as a RED→GREEN TDD pair)
- **Files modified:** 12 (2 new source files, 1 new test file, 1 new migration, 1 new deferred-items log, 7 modified)

## Accomplishments
- `enrichMarketContext` gained a 4th independent MACRO branch: derives `lanCode` from `geo.kommunCode.slice(0,2)`, calls `fetchMacroSnapshot` in its own try/catch, persists `macro_data` in the same single `.update()` write as `price_data`/`area_data`, and never touches `terminalStatus` (still `priceUsable || areaUsable` only) — a macro outage degrades to null with zero blast radius on price/area
- `analyses.macro_data` jsonb column added via migration 007 (additive-nullable, existing per-user RLS) and pushed live — confirmed the column genuinely did not exist yet (Plan 01's SUMMARY correctly flagged this as Plan 02's responsibility)
- `FactSheetInput`/`assembleFactSheet` gained a `macro` slot via the existing `slot()` explicit-absence wrapper, and it is actually WIRED (not just typed) into both places a fact sheet is assembled: `generate-report.ts` (the real Sonnet synthesis input, reading `analyses.macro_data` via `safeParseMacroData`) and `page.tsx`'s D-08 fingerprint recompute (which must byte-match the action's fact sheet or stale-report detection silently desyncs)
- `prompt.ts` gained `ABSOLUT REGEL 5 — MAKRODATA ÄR ENDAST BESKRIVANDE` in the identical rule format as REGEL 1-4, forbidding any predictive/timing/buy-sell framing of macro figures; `REPORT_SYNTHESIS_PROMPT_VERSION` bumped to `report-synth/v2 (2026-07-06)`
- `banned-phrases.ts` (new) exports `BANNED_PREDICTIVE_PHRASES` and `MACRO_CARD_LABELS` as one shared, reviewable source; `banned-predictive-phrases.test.ts` (new, TDD RED→GREEN) scans the prompt's instructive text (excluding the deliberately-quoted FÖRBJUDET example) and the macro card labels, plus two gate-bites proofs that the scan is not a no-op — the tertiary MACRO-02 enforcement layer alongside the Plan 01 schema shape and this plan's prompt rule
- Live-verified and fixed a real defect: the CPIF `ContentsCode` inferred in Plan 01 (`PR0101G1`) returns HTTP 400 against the live SCB table; the correct code (`000007ZM`, confirmed via the table's own metadata + a live 200 response) is now wired in `macro.ts`

## Task Commits

1. **Task 1: 4th MACRO branch in enrichMarketContext** (+ migration 007) - `fc8dc20` (feat)
2. **Task 2: fact-sheet macro slot + prompt ABSOLUT REGEL 5** (+ wiring both call sites + evals fix) - `67a240b` (feat)
3. **Task 3 RED: failing banned-predictive-phrase test** - `22c25d5` (test)
3. **Task 3 GREEN: banned-phrases.ts implementation** - `4ae0b26` (feat)
4. **Deviation fix: live CPIF ContentsCode correction** - `c21979b` (fix)

**Plan metadata:** (this commit)

## Files Created/Modified
- `supabase/migrations/007_macro_data_column.sql` - New additive-nullable `analyses.macro_data` jsonb column, pushed live and confirmed applied
- `src/actions/enrich-market-context.ts` - 4th MACRO branch, extended `EnrichMarketResult`, extended persist + return
- `src/actions/generate-report.ts` - reads `macro_data`, `safeParseMacroData`, wires `macro` into `assembleFactSheet`
- `src/app/(app)/analysis/[id]/page.tsx` - same macro wiring for the D-08 fingerprint recompute (must byte-match the action)
- `src/lib/report/fact-sheet.ts` - `FactSheetInput.macro`, bundle `macro: slot(input.macro)`
- `src/lib/report/prompt.ts` - `ABSOLUT REGEL 5`, version bumped to v2
- `src/lib/report/banned-phrases.ts` - `BANNED_PREDICTIVE_PHRASES`, `MACRO_CARD_LABELS`
- `src/lib/report/banned-predictive-phrases.test.ts` - the tertiary MACRO-02 regression scan
- `src/lib/market/macro.ts` - corrected CPIF `ContentsCode`
- `src/lib/market/__fixtures__/scb-cpif.json` - fixture dimension code updated to match the corrected live code
- `evals/report.test.ts` - added `macro: null` to 5 pre-existing `assembleFactSheet` call sites (required-field addition)
- `.planning/phases/07-macro-price-context/deferred-items.md` - logs 3 pre-existing, out-of-scope eslint issues from an unrelated prior commit

## Decisions Made
- Migration 007 was needed and pushed live non-interactively (`supabase db push --linked < /dev/null`), same pattern as Plan 01's migration 006 — verified via `supabase migration list --linked` (local 007 = remote 007) before any code depended on the column.
- The real `SupabaseClient` requires an `as never` cast at the `fetchMacroSnapshot` call site (TS2589 against the minimal `SupabaseLike` interface) — this mirrors the exact convention already established in `macro.test.ts`, not a new pattern.
- Wiring `macro` into `assembleFactSheet`'s two real call sites (beyond the type extension itself) was treated as in-scope for this plan (Rule 2 — the plan's own `key_links`/purpose explicitly states the fact-sheet slot must "reach... the AI narration path," which is inert without the caller wiring).
- Deliberately did NOT ban the bare words "prognos"/"forecast" — see key-decisions above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Wired `macro` into `evals/report.test.ts`'s 5 existing `assembleFactSheet` call sites**
- **Found during:** Task 2 (`npx tsc --noEmit` after the `FactSheetInput` extension)
- **Issue:** `FactSheetInput.macro` is a required field; the 5 pre-existing test call sites in `evals/report.test.ts` did not supply it, breaking compilation.
- **Fix:** Added `macro: null` to each call site; added an explicit `expect(parsed.macro).toEqual({ status: "ej_tillgänglig" })` assertion to the existing absent-source test for direct coverage.
- **Files modified:** `evals/report.test.ts`
- **Verification:** `npx tsc --noEmit` clean; `npx vitest run evals/report.test.ts` green (22/22).
- **Committed in:** `67a240b` (Task 2 commit)

**2. [Rule 2 - Missing Critical] Wired the `macro` fact-sheet slot into both real `assembleFactSheet` call sites, not just the type**
- **Found during:** Task 2
- **Issue:** The plan's `key_links`/purpose state the macro slot must "reach... the AI narration path" — extending `FactSheetInput`'s type alone leaves it permanently `undefined`/unset at both real call sites (`generate-report.ts`, `page.tsx`), which is silent dead functionality, not a completed slot.
- **Fix:** `generate-report.ts` now reads `row.macro_data` (added to its `select`), guards it with `safeParseMacroData`, and passes it to `assembleFactSheet`. `page.tsx`'s D-08 fingerprint recompute does the identical thing (it already selects `*`) — required so the recomputed fingerprint byte-matches the action's stored one (T-04-24).
- **Files modified:** `src/actions/generate-report.ts`, `src/app/(app)/analysis/[id]/page.tsx`
- **Verification:** `npx tsc --noEmit` clean; full `npx vitest run` green (298 passed).
- **Committed in:** `67a240b` (Task 2 commit)

**3. [Rule 1 - Bug] Corrected the CPIF `ContentsCode` — the Plan 01-inferred value 400s live**
- **Found during:** post-Task-3 spot-check (explicitly flagged as a risk to verify in the wave-1 handoff note and in 07-01-SUMMARY.md)
- **Issue:** `PR0101G1` (inferred, not verbatim-captured in RESEARCH) returns HTTP 400 against the live SCB `PR0101G/KPIF2020` table.
- **Fix:** Live `curl` against the table's own metadata endpoint (no body) revealed the real code (`000007ZM`, label "CPIF, annual changes, 2020=100"); verified a full 200 response with real data (`value: 1.5`) using the corrected code. Updated `macro.ts`'s `MACRO_SCB_TABLES.inflation.contentsCode` and the `__fixtures__/scb-cpif.json` fixture's dimension key to match.
- **Files modified:** `src/lib/market/macro.ts`, `src/lib/market/__fixtures__/scb-cpif.json`
- **Verification:** `npx vitest run src/lib/market/macro-schema.test.ts src/lib/market/macro.test.ts` green (16/16, fixture only exercises dimension-shape walking so no assertions changed); `npx tsc --noEmit` clean.
- **Committed in:** `c21979b` (separate fix commit — discovered after the task-scoped work, applied as a standalone deviation fix)

---

**Total deviations:** 3 auto-fixed (1 blocking, 1 missing-critical, 1 bug)
**Impact on plan:** All three were necessary for the plan's stated goal to actually function (a fact-sheet slot no caller populates is inert; a broken inflation fetch silently under-reports "ej tillgänglig" forever until fixed) or to keep the build green. No scope creep — the macro-card UI itself (Plan 03) was not touched.

## Issues Encountered
None beyond the deviations above.

## User Setup Required

None - migration 007 is already live; no new env vars or external service configuration needed (Riksbank/SCB remain keyless, per Plan 01).

## Next Phase Readiness

Plan 03 can now:
- Read `result.data.macro` (`MacroData | null`) from `enrichMarketContext`'s return to wire the 3rd independent panel in `market-context-section.tsx` (not touched by this plan — `EnrichMarketResult.macro` is additive so the existing `result.data.price`/`result.data.area` destructuring in that component is unaffected and still compiles).
- Build `macro-context-card.tsx` rendering from `MACRO_CARD_LABELS` (exported from `src/lib/report/banned-phrases.ts`) so the card's labels and this plan's regression test share one source of truth, per the plan's key_links.
- Rely on the now-corrected live CPIF fetch — Plan 03's card will show a real inflation figure instead of a permanent "ej tillgänglig" from the stale ContentsCode.

## Known Stubs

None — no hardcoded empty/placeholder UI values were introduced. `macro-context-card.tsx` itself is Plan 03's deliverable, not this plan's.

## Threat Flags

None — this plan's threat register items (T-07-05, T-07-06, T-07-07) were all addressed as planned (three independent no-prediction layers; independent-branch degradation; GDPR-safe logging); no new unaccounted-for surface was introduced. The migration 007 addition is additive-nullable on an existing per-user-RLS'd table, matching the `analyses.macro_data → analyses row` trust boundary already documented in the plan's threat model.

---
*Phase: 07-macro-price-context*
*Completed: 2026-07-06*

## Self-Check: PASSED

All 13 created/modified files verified present on disk; all 6 commits (5 task/fix commits + this SUMMARY commit) verified present in git log.
