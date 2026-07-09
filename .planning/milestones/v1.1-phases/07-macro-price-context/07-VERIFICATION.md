---
phase: 07-macro-price-context
verified: 2026-07-06T22:30:00Z
status: human_needed
score: 9/9 must-haves verified (code-level); 1 item requires operator live-render confirmation
overrides_applied: 0
human_verification:
  - test: "Live render of Makroekonomisk kontext on a real analysis (07-03-PLAN.md Task 3 checkpoint:human-verify)"
    expected: "Section renders visually separate from price/area panels, shows Styrränta / Inflation (KPIF) / Regional prisutveckling each with source + period, carries the 'ingen prognos eller rekommendation' sub-label, shows no directional/color-coded language, and each indicator independently degrades to 'Ej tillgänglig' without blanking the other panels."
    why_human: "Requires a running app plus live Riksbank/SCB API responses and visual confirmation — the RESEARCH-flagged manual-only verification. Cannot be exercised by static grep/test analysis. The executor explicitly recorded this as 'AUTO-APPROVED, HONESTLY DEFERRED' in 07-03-SUMMARY.md, not as performed."
---

# Phase 7: Macro Price Context Verification Report

**Phase Goal:** Add current macro indicators (Riksbank policy rate, inflation, regional price-index trend) to the market-context layer as a strictly-descriptive, clearly-labeled section — never a prediction or verdict.
**Verified:** 2026-07-06T22:30:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (merged: ROADMAP Success Criteria + PLAN frontmatter must_haves)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Migration creates shared `macro_snapshots` table with explicit RLS letting any authenticated user read/upsert (no owner-scoped lockout) | VERIFIED | `supabase/migrations/006_macro_snapshots.sql` creates the table with `unique(scope,region_code)`; 3 explicit policies (SELECT/INSERT/UPDATE) each `using/with check (auth.uid() is not null)`. Confirmed **live** via `supabase migration list --linked` (local 006 = remote 006). |
| 2 | `macro-schema.ts` parses live-shaped Riksbank/SCB fixtures into policy rate, CPIF, regional-price figures; schema has NO direction/trend/magnitude/forecast field | VERIFIED | `macroDataSchema` (lines 183-208) has only `policyRate/inflation/regionalPrice` sub-objects, each `{value, date/period/year, source, ...}`. Dedicated test `macro-schema.test.ts` asserts `Object.keys(shape)` excludes `direction/trend/magnitude/forecast/outlook/deltaPct`. `npx vitest run` green (20/20 across the 3 phase-7 test files). |
| 3 | `fetchMacroSnapshot` returns cached row on fresh hit; fetches-live-then-upserts on miss/stale (read-through TTL cache) | VERIFIED | `readThroughMacroCache` in `macro.ts` (lines 243-275): freshness check `Date.now() - Date.parse(fetched_at) < ttlHours*3_600_000`; upsert on miss/stale with `onConflict: "scope,region_code"`. `macro.test.ts` covers cache hit/miss/stale (test names tagged "cache"). |
| 4 | Each of the three indicators degrades independently to null when its own source fails (one API 500 never blanks the others) | VERIFIED | `fetchMacroSnapshot` (macro.ts lines 297-323) wraps each of policyRate/inflation/regionalPrice in its own try/catch inside `Promise.all`; `macro.test.ts` "independent" tests assert one-throws-others-populate. |
| 5 | Region codes reaching the SCB query body are validated against a fixed län allowlist (SSRF mitigation) | VERIFIED | `isValidLanCode` (macro.ts lines 140-154) checks against `LAN_CODES`/`STORSTAD_AGGREGATES` before `fetchRegionalPriceTrend` builds any query body; region is always derived server-side from `geo.kommunCode.slice(0,2)` in `enrich-market-context.ts`, never client free-text. |
| 6 | `enrichMarketContext` runs a 4th independent MACRO branch (lanCode from `geo.kommunCode.slice(0,2)`, calls `fetchMacroSnapshot`, persists `macro_data`); macro failure never blanks price/area; macro presence/absence does NOT gate terminal status | VERIFIED | `enrich-market-context.ts` lines 470-527: MACRO branch has its own try/catch, `terminalStatus` computed from `priceUsable \|\| areaUsable` only (macro absent from the expression), single `.update()` persists all three columns. |
| 7 | `EnrichMarketResult.data` carries `macro: MacroData \| null` alongside price/area | VERIFIED | Type at lines 84-93 of `enrich-market-context.ts`; `return { ok: true, data: { price, area, macro } }` at line 527. |
| 8 | Fact-sheet has a macro slot wrapped in explicit-absence `SourceSlot` (`ej_tillgänglig` when null) | VERIFIED | `fact-sheet.ts`: `FactSheetInput.macro: unknown \| null` (line 42), `macro: slot(input.macro)` in the bundle (line 90) — `slot()` returns `{status:"ej_tillgänglig"}` on null. |
| 9 | Synthesis prompt carries ABSOLUT REGEL 5 forbidding predictive/timing/buy-sell framing of macro; `REPORT_SYNTHESIS_PROMPT_VERSION` bumped | VERIFIED | `prompt.ts` line 34: full "ABSOLUT REGEL 5 — MAKRODATA ÄR ENDAST BESKRIVANDE" rule in the identical format as REGEL 1-4. Version bumped to `"report-synth/v2 (2026-07-06)"` (line 22). |
| 10 | Deterministic banned-predictive-phrase regression test scans prompt + macro card labels, fails on direction/magnitude/timing/buy-sell phrases | VERIFIED | `banned-predictive-phrases.test.ts` (4 tests): scans `REPORT_SYNTHESIS_SYSTEM_PROMPT` (excluding the deliberately-quoted FÖRBJUDET example), scans `MACRO_CARD_LABELS`, and two gate-bites proofs confirm the scan is not a no-op. All 4 pass. |
| 11 | `MacroContextCard` renders the three indicators in its OWN clearly-labeled "Makroekonomisk kontext" section, visually separate from Price/Area cards, each with source + reference period | VERIFIED | `macro-context-card.tsx`: own `Card`/`CardHeader` titled `MACRO_CARD_LABELS.title` ("Makroekonomisk kontext"); three `MetricCard`s (Styrränta/Inflation KPIF/Regional prisutveckling) each with a sublabel carrying source + date/period; rendered as a separate, third `<Card>` block in `market-context-section.tsx` (not merged into Price/Area cards). |
| 12 | Each indicator degrades independently to "Ej tillgänglig"; one missing indicator never blanks the others; macro never blanks price/area | VERIFIED | `MetricCard`'s `value === null` branch renders `MACRO_CARD_LABELS.unavailable` independently per tile (macro-context-card.tsx lines 35-38). `market-context-section.tsx` renders Price/Area/Macro as three independent ternary blocks (lines 154-210) — a null `macro` only swaps in the macro fallback card, Price/Area render unaffected. |
| 13 | Card renders number + label + source + period ONLY — no computeFlags, no severity/band/color judgment, no direction/trend text | VERIFIED | `grep computeFlags/direction/trend/magnitude/forecast/outlook/deltaPct` in `macro-context-card.tsx` and `macro-schema.ts` returns only doc-comment mentions describing the absence — no actual import, call, or field. No conditional color/tone classes tied to value sign found. |
| 14 | `MarketContextSection` accepts `macroData` prop, seeds state, updates on `triggerEnrich` success (`result.data.macro`), renders macro panel as 3rd independent panel with its own fallback | VERIFIED | `market-context-section.tsx`: `macroData: MacroData \| null` prop (line 21), `useState(macroData)` seed (line 83), `setMacro(result.data.macro)` in the success branch (line 101), third independent panel block (lines 191-211) with "Makroekonomisk kontext ej tillgänglig" fallback. |
| 15 | Analysis page reads `analysis.macro_data`, `safeParseMacroData`'s it, passes into both `assembleFactSheet` and `MarketContextSection`; `generate-report.ts` passes the same value for fingerprint parity | VERIFIED | `page.tsx`: `const macroData = safeParseMacroData(analysis.macro_data)` (line 121), `macro: macroData` into `assembleFactSheet` (line 143), `macroData={macroData}` into `<MarketContextSection>` (line 206). `generate-report.ts`: `const macro = safeParseMacroData(row.macro_data)` (line 319), `macro` (shorthand) into `assembleFactSheet` (line 336) — both call sites derive from the same column via the same guard, keys match. |
| 16 (SC4/ROADMAP) | Live render on a real analysis confirms correct rendering + graceful degradation | **DEFERRED TO HUMAN** | Explicitly a `checkpoint:human-verify` blocking-human task in `07-03-PLAN.md` Task 3. 07-03-SUMMARY.md self-reports "AUTO-APPROVED, HONESTLY DEFERRED" — not performed by the executor. Per task instructions, this is routed to human_verification, not scored as a code-level gap. |

**Score:** 15/15 code-verifiable truths VERIFIED; 1 truth requires operator live confirmation (not a code gap).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `supabase/migrations/006_macro_snapshots.sql` | Shared cache table + RLS | VERIFIED | Exists, live (remote migration 006 confirmed), 3 policies present. |
| `supabase/migrations/007_macro_data_column.sql` | Additive `analyses.macro_data` jsonb column | VERIFIED | Exists, live (remote migration 007 confirmed). Not in original 07-01-PLAN artifact list but required and delivered in 07-02 per plan note "if not yet a column, add it." |
| `src/lib/market/macro-schema.ts` | Zod schemas + normalizers, no prediction field | VERIFIED | Exports `normalizeMacroOutput`-equivalent (3 separate normalizers as plan allowed), `macroDataSchema`, `safeParseMacroData`, `MacroData`. |
| `src/lib/market/macro.ts` | Fetchers + buildPxWebQuery + read-through cache | VERIFIED | Exports `fetchMacroSnapshot`, `fetchPolicyRate`, `fetchInflation`, `fetchRegionalPriceTrend`, `buildPxWebQuery` (internal), re-exports `MacroData`/`safeParseMacroData`. |
| `src/lib/market/macro.test.ts` / `macro-schema.test.ts` | Cache + degradation + shape tests | VERIFIED | 20 tests total across both files, all passing. |
| `src/actions/enrich-market-context.ts` | 4th MACRO branch + persistence + extended result | VERIFIED | Confirmed above. |
| `src/lib/report/fact-sheet.ts` | macro slot | VERIFIED | Confirmed above. |
| `src/lib/report/prompt.ts` | ABSOLUT REGEL 5 + version bump | VERIFIED | Confirmed above. |
| `src/lib/report/banned-phrases.ts` | `BANNED_PREDICTIVE_PHRASES` + `MACRO_CARD_LABELS` | VERIFIED | Both exported, both consumed (test + card). |
| `src/lib/report/banned-predictive-phrases.test.ts` | Regression scan | VERIFIED | 4 tests, all pass. |
| `src/components/macro-context-card.tsx` | Presentational card | VERIFIED | 143 lines, exceeds min_lines:40, no computeFlags/severity logic. |
| `src/components/market-context-section.tsx` | macroData prop + 3rd panel | VERIFIED | Confirmed above. |
| `src/app/(app)/analysis/[id]/page.tsx` | macro_data read + wiring | VERIFIED | Confirmed above. |
| `src/actions/generate-report.ts` | Fingerprint-parity macro wiring | VERIFIED | Confirmed above. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `macro.ts` | `macro_snapshots` table | `.from('macro_snapshots').select/.upsert onConflict scope,region_code` | WIRED | Confirmed in `readThroughMacroCache`. |
| `macro.ts` | `scb-schema.ts` | `import jsonStat2Schema` | WIRED | `macro-schema.ts` imports `jsonStat2Schema` from `@/lib/market/scb-schema`, not re-declared. |
| `enrich-market-context.ts` | `macro.ts fetchMacroSnapshot` | try/catch MACRO branch | WIRED | Confirmed above. |
| `prompt.ts` | `banned-phrases.ts` | shared reviewable phrase source | WIRED | `banned-predictive-phrases.test.ts` imports both `BANNED_PREDICTIVE_PHRASES` and `REPORT_SYNTHESIS_SYSTEM_PROMPT` and cross-scans them. |
| `page.tsx` | `market-context-section.tsx` | `macroData={macroData}` prop | WIRED | Confirmed above. |
| `page.tsx` | `fact-sheet.ts assembleFactSheet` | `macro: macroData` | WIRED | Confirmed above. |
| `macro-context-card.tsx` | `banned-phrases.ts MACRO_CARD_LABELS` | renders static labels from shared const | WIRED | Confirmed — no inline hardcoded label strings found in the card. |
| `generate-report.ts` | `page.tsx` | fingerprint parity (`macro` value identical) | WIRED | Both call `safeParseMacroData` against their respective row read and pass into `assembleFactSheet` with matching key. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| `MacroContextCard` (via `MarketContextSection`) | `macro` state | `enrichMarketContext` → `fetchMacroSnapshot` → live Riksbank/SCB fetch or `macro_snapshots` cache row | Yes — `fetchPolicyRate`/`fetchInflation`/`fetchRegionalPriceTrend` perform real `fetch`/POST calls against fixed external hosts, normalized via Zod, no static/empty fallback except the documented null-on-failure discipline | FLOWING |
| `assembleFactSheet` macro slot | `macro` param | `page.tsx`/`generate-report.ts` → `safeParseMacroData(analysis.macro_data)` | Yes — reads the persisted column written by the enrich action's real fetch, not a hardcoded value | FLOWING |

No hardcoded empty arrays/objects/static returns found feeding these paths (`grep` for `return.*json(\[\]|\{\})`-style stubs in the modified files returned nothing).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Migrations 006 + 007 applied to live remote DB | `supabase migration list --linked` | local/remote both show 001-007 aligned | PASS |
| Phase 7 unit/regression tests pass | `npx vitest run src/lib/market/macro-schema.test.ts src/lib/market/macro.test.ts src/lib/report/banned-predictive-phrases.test.ts` | 3 files, 20 tests, all passed | PASS |
| Full test suite has no regressions | `npx vitest run` | 298 passed, 1 skipped, 6 todo (30 files) | PASS |
| TypeScript compiles clean | `npx tsc --noEmit` | no output (clean) | PASS |
| Production build succeeds | `npm run build` | "Compiled successfully", all routes generated | PASS |
| No `computeFlags`/severity in macro card | `grep computeFlags src/components/macro-context-card.tsx` | no functional matches (comment-only mentions of absence) | PASS |
| Live render on a real analysis (Riksbank/SCB APIs) | N/A — requires running app + live external APIs | not run by verifier (per task instructions) | SKIP → routed to human_verification |

### Probe Execution

No `scripts/*/tests/probe-*.sh` files declared or found for this phase. Step 7c: N/A — no probes to run for this phase.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|--------------|--------|----------|
| MACRO-01 | 07-01, 07-02, 07-03 | Market-context layer includes current macro indicators (Riksbank policy rate, inflation, regional price-index trend) sourced from Riksbank SWEA + SCB | SATISFIED | Full data layer + backend wiring + UI card confirmed above; live migrations applied; card renders all three indicators with source + period. |
| MACRO-02 | 07-01, 07-02, 07-03 | Macro context is strictly descriptive — own clearly-labeled section, never framed as a prediction/forecast/verdict | SATISFIED | Three independent enforcement layers confirmed: (1) schema shape excludes direction/trend/magnitude fields, (2) prompt ABSOLUT REGEL 5 + version bump, (3) deterministic banned-phrase regression test scanning both prompt and card labels — all present and passing. Card itself has zero severity/color/directional logic. |

No orphaned requirements — REQUIREMENTS.md maps only MACRO-01/MACRO-02 to Phase 7 and both appear in every plan's `requirements:` frontmatter.

### Anti-Patterns Found

None. Scanned all phase-modified files (`macro.ts`, `macro-schema.ts`, `enrich-market-context.ts`, `fact-sheet.ts`, `prompt.ts`, `banned-phrases.ts`, `macro-context-card.tsx`, `market-context-section.tsx`, `page.tsx`, `generate-report.ts`) for `TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER/"not yet implemented"/"coming soon"` — zero matches. No hardcoded empty-array/object stubs feeding rendered output. `deferred-items.md` documents 3 pre-existing, unrelated eslint warnings from a prior commit, correctly out of scope for this phase (not a Phase 7 debt marker).

### Human Verification Required

### 1. Live render of Makroekonomisk kontext on a real analysis

**Test:** Start the app with live Supabase + Riksbank/SCB access, open or run a real analysis, trigger "Hämta marknadsdata," and observe the rendered market-context section.
**Expected:** A "Makroekonomisk kontext" section renders, visually separate from the price comparison and områdesstatistik panels, showing Styrränta (e.g. "1,75 %", Riksbank + date), Inflation KPIF (e.g. a %, period), and Regional prisutveckling (median price, län + year, with "(preliminär)" if applicable) — each with source + reference period. The "Aktuella nyckeltal — ingen prognos eller rekommendation" sub-label is visible; no directional/color-coded language appears anywhere. If any single indicator is unavailable it shows "Ej tillgänglig" without blanking the other two or the price/area panels.
**Why human:** Requires a running app instance plus live third-party API responses (Riksbank SWEA + SCB PxWebApi) and visual/UX judgment that cannot be exercised via static code analysis. This was explicitly scoped in `07-03-PLAN.md` as a `checkpoint:human-verify` blocking-human task and the phase's own SUMMARY records it as deferred, not performed ("AUTO-APPROVED, HONESTLY DEFERRED").

### Gaps Summary

No code-level gaps found. All 15 code-verifiable observable truths (derived from the merged ROADMAP success criteria and the three plans' `must_haves`) are VERIFIED against actual source, live migrations, and a green test suite (298 passing, 0 failing) plus a clean production build. The only outstanding item is the pre-planned, explicitly-deferred live-render human-verification checkpoint, which does not indicate incomplete implementation — it indicates a verification step that structurally requires a human + live external APIs and was correctly not self-approved by the executor.

---

_Verified: 2026-07-06T22:30:00Z_
_Verifier: Claude (gsd-verifier)_
