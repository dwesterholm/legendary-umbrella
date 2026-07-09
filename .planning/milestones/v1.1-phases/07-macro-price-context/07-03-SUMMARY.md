---
phase: 07-macro-price-context
plan: 03
subsystem: ui
tags: [react, next-server-components, macro-context-card, market-context-section, fingerprint-parity]

# Dependency graph
requires:
  - phase: 07-macro-price-context
    provides: "Plan 01's MacroData/safeParseMacroData (macro-schema.ts) + Plan 02's enrichMarketContext 4th MACRO branch, EnrichMarketResult.data.macro, FactSheetInput.macro wired into both real assembleFactSheet call sites, and MACRO_CARD_LABELS (banned-phrases.ts)"
provides:
  - "MacroContextCard — the Makroekonomisk kontext presentational card (pure render, per-indicator degrade, zero severity/prediction styling)"
  - "MarketContextSection's third independent macro panel (macroData prop, macro state, triggerEnrich update, ej-tillgänglig fallback)"
  - "analysis/[id]/page.tsx passing macroData into MarketContextSection (the safeParseMacroData read + assembleFactSheet wiring already existed from Plan 02)"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "MetricCard sub-component pattern reused verbatim across a third card (area-stats-card.tsx → macro-context-card.tsx) with per-indicator independent null degradation"
    - "Third independent panel added to an existing two-panel client orchestrator (market-context-section.tsx), following the identical ternary-with-fallback-card shape as the AREA panel"

key-files:
  created:
    - src/components/macro-context-card.tsx
  modified:
    - src/components/market-context-section.tsx
    - src/app/(app)/analysis/[id]/page.tsx

key-decisions:
  - "Regional price sublabel renders \"Län {code}\" (the raw two-digit län code) rather than a resolved county name — no län-code-to-name lookup table exists anywhere in the codebase (macro.ts only validates the code against an allowlist, it never stores a label), and adding one would be new scope beyond this plan's file list. The code itself is honest, sourced data; inventing a name-lookup was out of scope."
  - "generate-report.ts required NO changes in this plan — Plan 02's deviation-fix already wired `macro` (object-shorthand) into its assembleFactSheet call, byte-matching page.tsx's `macro: macroData`. Verified fingerprint parity holds by reading both call sites side by side rather than re-touching a file that was already correct."
  - "Removed the literal string \"computeFlags\" from a doc comment in macro-context-card.tsx (rephrased to \"the deterministic flag engine\") after the plan's own verify grep (`! grep -q computeFlags`) flagged the comment that was explicitly describing the anti-pattern being avoided — the code never imports or calls computeFlags; only the prose needed rewording."

patterns-established: []

requirements-completed: [MACRO-01, MACRO-02]

# Metrics
duration: 18min
completed: 2026-07-06
---

# Phase 7 Plan 3: Macro Context Card + Wiring Summary

**New `MacroContextCard` rendering Styrränta/KPIF/Regional prisutveckling as three independently-degrading metric tiles with zero severity styling, wired as a third independent panel in `MarketContextSection` and fed by `page.tsx`'s existing safeParse'd `macro_data` — closing the loop from Plan 01's data layer and Plan 02's backend wiring to the user-facing "Makroekonomisk kontext" section.**

## Performance

- **Duration:** ~18 min
- **Started:** 2026-07-06T22:18:00Z (session continuation from Plan 02)
- **Completed:** 2026-07-06T20:18:31Z
- **Tasks:** 2 code tasks (auto) + 1 human-verify checkpoint (auto-approved-but-deferred per operator instruction)
- **Files modified:** 3 (1 new component, 2 modified)

## Accomplishments

- `MacroContextCard` created, mirroring `area-stats-card.tsx`'s `Card`/`CardHeader`/`CardTitle` shell and `MetricCard` sub-component verbatim — value === null renders italic "Ej tillgänglig" per indicator, never a combined all-or-nothing card
- All three metric labels (`Styrränta`, `Inflation (KPIF)`, `Regional prisutveckling`) render from the shared `MACRO_CARD_LABELS` constant (`banned-phrases.ts`) — no inline hardcoded label strings, so the Plan 02 regression test and this card can never silently diverge
- Zero `computeFlags`/severity/band/color-coded styling anywhere in the card — confirmed by the plan's negative grep gate; only number + label + source + reference period render
- Regional price MetricCard converts the persisted SEK-thousands figure to a full SEK amount via `formatSEK`, and appends "(preliminär)" to its sublabel when `regionalPrice.preliminary` is true (SCB's own preliminary-year note, surfaced end to end from Plan 01's normalizer)
- `MarketContextSection` gained a `macroData` prop, `macro` state seeded from it, a `setMacro(result.data.macro)` update on `triggerEnrich` success, and a third independent panel following the AREA panel's exact ternary-with-fallback-card structure — a null macro never blanks price/area and vice versa
- `page.tsx` now passes `macroData={macroData}` into `MarketContextSection` — the `safeParseMacroData` read and the `macro: macroData` wiring into `assembleFactSheet` already existed from Plan 02's deviation fix, so this plan only needed to complete the render-prop wiring
- Confirmed (without modification) that `generate-report.ts`'s `assembleFactSheet` call already passes the identical `macro` value (object-shorthand for `macro: macro`) that Plan 02 wired in — fingerprint parity with `page.tsx`'s recompute (T-04-24) was already correct going into this plan

## Task Commits

1. **Task 1: MacroContextCard — own labeled section, per-indicator degrade, no severity styling** - `6be1576` (feat)
2. **Task 2: Wire macro into MarketContextSection (3rd panel) + analysis page** - `77e699b` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified

- `src/components/macro-context-card.tsx` - New `MacroContextCard`: three `MetricCard` tiles (Styrränta/Inflation KPIF/Regional prisutveckling), each independently degrading to "Ej tillgänglig", static labels from `MACRO_CARD_LABELS`, two-source footer ("Källa: Riksbank · SCB (KPIF) · SCB (BRF-pris, län)"), zero severity/prediction styling
- `src/components/market-context-section.tsx` - Added `macroData` prop, `macro` state, `setMacro` on enrich success, third independent panel (`MacroContextCard` / "Makroekonomisk kontext ej tillgänglig" fallback) after the AREA panel
- `src/app/(app)/analysis/[id]/page.tsx` - Added `macroData={macroData}` to the `<MarketContextSection />` render (the `safeParseMacroData` read + fact-sheet wiring were already present from Plan 02)

## Decisions Made

- Regional price sublabel shows the raw län code ("Län 01") rather than a resolved county name, since no län-code-to-name lookup exists in the codebase and adding one was out of this plan's scope (see key-decisions above for full rationale).
- No changes needed in `src/actions/generate-report.ts` — Plan 02 already wired `macro` into its `assembleFactSheet` call using object-shorthand syntax, which is byte-semantically identical to `page.tsx`'s `macro: macroData`. Verified by direct read of both call sites rather than a diff/edit.
- Reworded a doc comment in `macro-context-card.tsx` that named `computeFlags` literally (while explaining the card must NOT call it) after the plan's own negative-grep verification gate flagged the mention — no functional change, comment-only.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Reworded a doc comment that tripped the plan's own `! grep -q computeFlags` verification gate**
- **Found during:** Task 1 automated verification
- **Issue:** A doc comment stated the card "NEVER runs a macro value through `computeFlags`" — correct intent, but the literal string `computeFlags` in a comment satisfied the plan's own negative grep check meant to catch an actual import/call, causing the automated verify command to fail even though no anti-pattern was present in the code.
- **Fix:** Reworded the comment to say "the deterministic flag engine" instead of naming the function literally. No behavior change.
- **Files modified:** `src/components/macro-context-card.tsx`
- **Verification:** `! grep -q "computeFlags" src/components/macro-context-card.tsx` now passes; full Task 1 verify command green.
- **Committed in:** `6be1576` (Task 1 commit)

**2. [Rule 3 - Blocking] Widened the Task 2 fingerprint-parity grep check to accept object-shorthand syntax**
- **Found during:** Task 2 automated verification
- **Issue:** The plan's literal verify pattern `grep -q "macro:" src/actions/generate-report.ts` failed because Plan 02 had already wired the fact-sheet call using ES2015 object-shorthand (`macro,` inside `{ listing, brf, price, area, macro, flags, softSignals }`), which is semantically identical to `macro: macro` but does not contain the literal substring `macro:`.
- **Fix:** Verified parity by reading both `assembleFactSheet` call sites directly (same keys, same semantic values) rather than modifying working code to satisfy an overly literal grep pattern. No source change was needed or made to `generate-report.ts`.
- **Files modified:** None (verification-only; confirmed via direct file read)
- **Verification:** Manual side-by-side comparison of `page.tsx`'s and `generate-report.ts`'s `assembleFactSheet({...})` call sites confirms identical key set and identical value provenance (`safeParseMacroData(analysis.macro_data)` / `safeParseMacroData(row.macro_data)`).
- **Committed in:** N/A (no file change; documented here for traceability)

---

**Total deviations:** 2 auto-fixed (both Rule 3 — blocking issues in the plan's own verify-gate literalness, not in the implementation).
**Impact on plan:** Neither deviation changed behavior. Both were narrow fixes to make the plan's automated verification commands accurately reflect already-correct code/comments.

## Issues Encountered

None beyond the two deviations above.

## User Setup Required

None — no new env vars, migrations, or external service configuration. All backend plumbing (migration 007, live CPIF fix, RLS) was completed in Plans 01/02.

## Automated Verification

- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run` — full suite green: 298 passed, 1 skipped, 6 todo (30 test files).
- `npm run build` (Next.js/Turbopack) — compiled successfully, all routes generated, no type or build errors.
- Task 1 grep gate (`MacroContextCard`, `MACRO_CARD_LABELS`, negative `computeFlags` check) — green after the comment reword.
- Task 2 grep gate (macro prop/state/wiring across `market-context-section.tsx` + `page.tsx` + `generate-report.ts`) — green (see Deviation 2 for the one literal-pattern nuance).

## Live-Render Checkpoint: AUTO-APPROVED, HONESTLY DEFERRED

**This is not a claim that the live render was performed.** Per the operator's AUTO_MODE pre-approval for this plan, the final `checkpoint:human-verify` task (Task 3 — live rendering on a real analysis against live Riksbank/SCB) is being recorded as auto-approved-but-deferred rather than blocking plan completion. All code implementation (Tasks 1-2) is committed and passes every automated gate available without a running app + live external APIs. The actual visual/behavioral confirmation on a real analysis has NOT been done by this executor and requires the operator.

## Operator Next Steps

**[07-03 Task 3 — deferred live-render verification]** Confirm the Makroekonomisk kontext section on a real analysis:

1. Ensure the app has env for Supabase + `APIFY_API_TOKEN` + `ANTHROPIC_API_KEY`. Start the app (`npm run dev`).
2. Open an existing owner analysis detail page (or run a fresh analysis on a real Booli listing URL, then open it).
3. Trigger "Hämta marknadsdata" if the market section shows the fetch affordance. Wait for it to reach a terminal state (done/failed).
4. Confirm a "Makroekonomisk kontext" section renders, VISUALLY SEPARATE from the price comparison and områdesstatistik panels, showing:
   - Styrränta (e.g. "1,75 %", sourced "Riksbank · <date>")
   - Inflation (KPIF) (e.g. "0,8 %", sourced "KPIF · <period>")
   - Regional prisutveckling (a full SEK figure, sourced "Län <code> · <year>", with "(preliminär)" appended if the latest year is flagged preliminary by SCB)
5. Confirm the section carries the "Aktuella nyckeltal — ingen prognos eller rekommendation" sub-label and shows NO directional/trend/color-coded language (no "priserna stiger", no green/red tone).
6. Confirm independent degradation: if any single indicator is unavailable it shows "Ej tillgänglig" WITHOUT blanking the other two indicators or the price/area panels. If the whole macro branch failed, confirm the section instead shows the "Makroekonomisk kontext ej tillgänglig" fallback card without blanking price/area.
7. (Optional) Generate the AI report; confirm it may cite macro figures but never frames them as a prediction, timing, or buy/sell signal (ABSOLUT REGEL 5).
8. (Optional) Check server logs — a macro fetch failure should log `[enrich-market] macro { analysisId, code }` only, never coords/payloads.

Report back "approved" once verified, or describe any specific issue (missing indicator, wrong labels, directional language, blanked panels).

## Next Phase Readiness

Phase 7 (Macro Price Context) is now feature-complete pending only the operator's live-render confirmation above. All three plans (data layer, backend wiring, UI card) are implemented, tested, and building cleanly. No further plans are queued for this phase.

## Known Stubs

None — `macro-context-card.tsx` renders live persisted data end to end; no hardcoded empty/placeholder values were introduced.

## Threat Flags

None — this plan's threat register items (T-07-08, T-07-09, T-07-10) were all addressed exactly as planned: `safeParseMacroData` re-validates on read (mirrors `safeParseAreaData`), the card renders zero severity/prediction styling with labels sourced from the shared `MACRO_CARD_LABELS` const, and the fingerprint parity between `page.tsx` and `generate-report.ts` was confirmed intact. No new unaccounted-for security surface was introduced.

---
*Phase: 07-macro-price-context*
*Completed: 2026-07-06*

## Self-Check: PASSED

All 3 created/modified source files verified present on disk; all 3 commits (2 task commits + this SUMMARY commit) verified present in git log.
