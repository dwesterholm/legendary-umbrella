---
phase: 04-ai-report-delivery
verified: 2026-06-26T22:15:00Z
status: human_needed
score: 4/4 must-haves verified
overrides_applied: 0
deferred:
  - truth: "Live brf-extract/v2 extraction eval (Plan 04-02 Task 3): labeled PDF fixtures + labels.json populated and eval run green"
    addressed_in: "Phase 4 UAT / ongoing eval infrastructure"
    evidence: "04-02-SUMMARY.md explicitly defers this; harness evals/extractor.eval.ts is committed and self-skips without fixtures; no labeled reference dataset yet (gitignored by design)"
human_verification:
  - test: "Generate a real AI report on an owned analysis with BRF + price + area data"
    expected: "leadSynthesis anchors the page as the capstone (D-00/D-05), themed Ekonomi/Pris/Område sections each cite specific data points and add interpretation beyond raw-number restatement (D-06), NO köp/sälj verdict present (D-04), red/green flags appear woven in the sage/terracotta language with citations"
    why_human: "Live ANTHROPIC_API_KEY required; synthesis quality, citation specificity, and no-verdict discipline require a human reader; cannot be grep-verified"
  - test: "Click 'Ladda ner PDF' on a generated report"
    expected: "PDF downloads; å/ä/ö glyphs render correctly (no boxes); section order mirrors the screen (lead → Ekonomi → Pris → Område → flags); 'ej finansiell rådgivning' disclaimer and source/freshness labels are present (D-12)"
    why_human: "PDF visual rendering, glyph correctness, and section layout require a human eye; cannot be verified without a real render"
  - test: "Change an input field (e.g. BRF data) then reload the analysis page"
    expected: "'Rapporten bygger på äldre data — uppdatera' marker appears with a regenerate button; no silent auto-refire; clicking Uppdatera re-runs generate (D-08)"
    why_human: "Staleness marker relies on the fingerprint comparison at runtime, and the visual/flow behavior requires a running dev server"
  - test: "Log out and open an analysis URL directly"
    expected: "Guest sees 'Logga in för AI-rapport' teaser only — NEVER the report content (D-09)"
    why_human: "Auth/session state behavior in a live browser; server-side isGuest logic verified in code but guest UX flow needs a human check"
  - test: "Generate a report on an analysis missing the BRF source (no årsredovisning uploaded)"
    expected: "Ekonomi section shows honest 'Ej tillgänglig' marker, nothing fabricated; report still generates for the available sources (D-07/FM4)"
    why_human: "Partial-data honesty under real synthesis conditions requires a live LLM call + a human reading the output"
  - test: "Run the live brf-extract/v2 extraction eval (Plan 04-02 Task 3)"
    expected: "Populate evals/fixtures/*.pdf + evals/labels.json (with expectedStambyte/expectedStorreRenovering/expectedAnmarkning keys), then run: RUN_LLM_EVALS=1 ANTHROPIC_API_KEY=<live-key> npm run eval — all assertions pass: four original metrics do not regress, three new soft signals extract with supporting citations"
    why_human: "Requires gitignored labeled PDF fixtures + a live ANTHROPIC_API_KEY; harness is committed but data is not"
---

# Phase 4: AI Report + Delivery — Verification Report

**Phase Goal:** Synthesize listing + BRF + price + area data into a polished, opinionated AI report ("vad du bör tänka på") with clearly labeled red/green risk flags and PDF export — the AI summary must reference specific data points (not generic advice), never give a buy/sell verdict, and be login-gated.

**Verified:** 2026-06-26T22:15:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

All four ROADMAP success criteria are met at the structural/code level. Automated tests (173 passed / 1 skipped / 6 todo) and TypeScript clean (`npx tsc --noEmit` exit 0). The 6 human verification items above require a live ANTHROPIC_API_KEY + a human reader for runtime quality, visual PDF rendering, and end-to-end flow checks. The 04-02 Task 3 extraction eval is explicitly deferred (not failed).

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User sees an AI-generated "vad du bör tänka på" summary synthesizing listing, BRF, price, and area data into an opinionated assessment | VERIFIED (structural) | `synthesizeReport` (synthesize.ts) calls claude-sonnet-4-6 with `zodOutputFormat(reportSchema)`, `assembleFactSheet` bundles all four sources, `generateReport` orchestrates the pipeline end-to-end. Live synthesis quality is HUMAN NEEDED. |
| 2 | User sees clearly labeled red and green flags for risk indicators | VERIFIED | `computeFlags` (flags.ts) is a pure deterministic function covering BRF debt/avgift/kassaflode, pricing delta, and stambytePlanerat soft signal. `ReportFlags` renders severity→sage/terracotta chips with sourceRef. 173 passing tests cover all flag golden cases. |
| 3 | User can download and share the complete analysis as a PDF report | VERIFIED (structural) | `downloadReportPdf` is login-gated + ownership-checked, returns an `application/pdf` Blob. `renderReportPdf` renders the persisted snapshot via `renderToBuffer` with Open Sans TTF for å/ä/ö. TTF traced into server bundle via `outputFileTracingIncludes`. PDF visual quality is HUMAN NEEDED. |
| 4 | The AI summary references specific data points from the analysis (not generic advice) | VERIFIED (structural) | `reportSchema` requires every `citedClaim.text` to carry a `sourceRef`; REPORT_SYNTHESIS_SYSTEM_PROMPT ABSOLUT REGEL 3 and 4 forbid generic filler; ABSOLUT REGEL 1 forbids verdicts. Schema makes verdict field unrepresentable. Live output specificity is HUMAN NEEDED. |

**Score:** 4/4 structural truths verified. Runtime/visual quality requires human sign-off (6 items above).

### Deferred Items

Items not yet met but explicitly tracked as deferred — not failures.

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | Live brf-extract/v2 extraction eval run (Plan 04-02 Task 3) | Phase 4 UAT / eval infrastructure | 04-02-SUMMARY.md §Task 3: harness `evals/extractor.eval.ts` committed, labeled dataset (`evals/fixtures/*.pdf` + `evals/labels.json`) gitignored and not yet populated; explicitly deferred by operator at the checkpoint |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/lib/schemas/report.ts` | reportSchema + reportDataSchema + safeParseReportData | VERIFIED | File exists, substantive (134 lines), imported by generate-report.ts and analysis page. No verdict/recommendation field in non-comment lines. |
| `src/lib/report/flags.ts` | computeFlags + FLAG_IDS + FlagSet | VERIFIED | Imports BRF_SCORE_THRESHOLDS and PRICE_COMPARISON_THRESHOLDS; zero Date/Math.random/fetch/await; handles null sources with no flags. |
| `src/lib/report/fact-sheet.ts` | assembleFactSheet with stable-key-order JSON | VERIFIED | Recursive sortKeysDeep produces deterministic byte output; absent sources → `{ status: "ej_tillgänglig" }`. |
| `src/lib/brf/cost.ts` | SONNET_USD_PER_MTOK + costSekSonnet | VERIFIED | `SONNET_USD_PER_MTOK = { input: 3.0, output: 15.0, cacheWrite5m: 3.75, cacheRead: 0.3 }`; Haiku rates untouched. |
| `src/lib/report/prompt.ts` | REPORT_SYNTHESIS_SYSTEM_PROMPT + version | VERIFIED | Version "report-synth/v1 (2026-06-23)"; four ABSOLUT REGEL including no-verdict and no-originated-flag; two inline examples (good vs bad lead synthesis). |
| `src/lib/report/synthesize.ts` | One Sonnet synthesis call with stop_reason handling | VERIFIED | `claude-sonnet-4-6` bare id (no date suffix); `output_config.format` (not deprecated top-level); stop_reason branched before parsed_output; GDPR-safe logging (only `{analysisId, code}`); no factSheet in any log. |
| `supabase/migrations/004_report.sql` | 5 additive report_* columns, no new RLS | VERIFIED | grep returns 5 `add column if not exists report_*` statements; zero `create policy`/`enable row level security`. Applied to live DB per 04-03-SUMMARY.md operator push. |
| `supabase/migrations/005_report_lock.sql` | report_generating_started_at column for stale-lock reclamation (WR-05) | VERIFIED | Additive, idempotent; no new RLS. |
| `src/actions/generate-report.ts` | Login-gated orchestrator with cost guard + fingerprint | VERIFIED | `"Logga in för AI-rapport"` string present; `generating` lock set before Sonnet call; `costSekSonnet` (not `costSek`); `createHash` fingerprint; atomic CAS acquire (`.neq("report_status","generating")`); sek hoisted before try (WR-03 fix); `report_generating_started_at` timestamp (WR-05 fix); CR-01 failed branch in AiReportSection. |
| `src/actions/download-report-pdf.ts` | Login-gated PDF download, no re-synthesis | VERIFIED | `getUser()` + `row.user_id` ownership check; `safeParseReportData` read guard; `synthesizeReport` import count = 0; `application/pdf` Blob returned. |
| `src/lib/report/pdf/fonts.ts` | Font.register with Open Sans TTF via process.cwd() | VERIFIED | Registers Regular + SemiBold; absolute path via `path.join(process.cwd(), ...)`. |
| `src/lib/report/pdf/report-document.tsx` | PDF Document tree with D-12 trust treatment | VERIFIED | Section order mirrors screen (lead → Ekonomi → Pris → Område → flags); "ej finansiell rådgivning" disclaimer in footer; "Ej tillgänglig" honest markers; sage/terracotta severity colours. |
| `src/lib/report/pdf/render.ts` | renderReportPdf returning Buffer, no Anthropic/DB import | VERIFIED | `grep -c '@anthropic-ai/sdk\|createClient\|synthesizeReport\|supabase'` = 0. |
| `src/components/ai-report-section.tsx` | AiReportSection with all branches | VERIFIED | Guest teaser "Logga in för AI-rapport"; owner trigger "Generera AI-rapport"; failed branch (CR-01 fix — renders error + retry, never stale report as fresh); stale marker "äldre data"; "Ladda ner PDF"; disclaimer; `priority=` (not `only=`) prevents WR-02 flag hiding; WR-06 safeId sanitization. |
| `src/components/report-flags.tsx` | ReportFlags with priority-then-remaining ordering | VERIFIED | WR-02 fix: `priority` prop reorders/emphasises, never filters; `shown = [...prioritized, ...remaining]`; sage/terracotta severity mapping; `sourceRef` + citation quote rendered. |
| `src/app/(app)/analysis/[id]/page.tsx` | Analysis page with D-08 fingerprint + AiReportSection | VERIFIED | `safeParseReportData` called; `assembleFactSheet` + `createHash` fingerprint recomputed from full stable fact sheet; `AiReportSection` rendered as page lead; AI Rapport ComingSoonSection removed (grep = 0). |
| `src/app/page.tsx` | AI Rapport placeholder removed | VERIFIED | AI Rapport ComingSoonSection absent; 3 remaining placeholders (BRF/Prisjamforelse/Omradesstatistik) intact. |
| `src/lib/schemas/brf.ts` | Extended with stambytePlanerat + storreRenoveringar + ovrigaAnmarkningar | VERIFIED | grep = 14 occurrences across extraction schema, data schema, and normalize. |
| `src/lib/brf/prompt.ts` | Bumped to brf-extract/v2 + soft-signal instructions | VERIFIED | `brf-extract/v2` count = 1; stambyte count = 8. |
| `evals/extractor.eval.ts` | Eval harness scaffold | VERIFIED (scaffold) | File exists; gated behind `RUN_LLM_EVALS=1`; self-skips without fixtures; live run is deferred. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/lib/report/flags.ts` | `src/lib/brf/score.ts` | `import BRF_SCORE_THRESHOLDS` | WIRED | Line 1 of flags.ts; no threshold literals redefined in flags.ts |
| `src/lib/report/flags.ts` | `src/lib/market/compare.ts` | `import PRICE_COMPARISON_THRESHOLDS` | WIRED | Line 2 of flags.ts; price flag gated on `reason === "ok"` AND `sampleSize > thinMaxComps` |
| `src/lib/report/synthesize.ts` | `src/lib/schemas/report.ts` | `zodOutputFormat(reportSchema)` in `output_config.format` | WIRED | Line 117 of synthesize.ts |
| `src/lib/report/synthesize.ts` | `src/lib/report/prompt.ts` | `system: REPORT_SYNTHESIS_SYSTEM_PROMPT` | WIRED | Line 101 of synthesize.ts |
| `src/actions/generate-report.ts` | `src/lib/report/synthesize.ts` | `await synthesizeReport(...)` | WIRED | Line 309 of generate-report.ts |
| `src/actions/generate-report.ts` | `src/lib/report/flags.ts` | `computeFlags(...)` | WIRED | Line 283 of generate-report.ts |
| `src/actions/generate-report.ts` | `analyses table` | `.update({ report_data, report_status, report_cost_sek, report_data_fingerprint, report_prompt_version })` | WIRED | Lines 353–366 |
| `src/lib/report/pdf/render.ts` | `src/lib/report/pdf/report-document.tsx` | `renderToBuffer(createElement(ReportDocument, { data }))` | WIRED | Lines 48–51 of render.ts |
| `src/lib/report/pdf/report-document.tsx` | `src/lib/report/pdf/fonts.ts` | `import { REPORT_FONT_FAMILY } from "./fonts"` (Font.register side effect) | WIRED | Lines 15–16 of report-document.tsx |
| `next.config.ts` | `src/lib/report/pdf/fonts/*.ttf` | `outputFileTracingIncludes` | WIRED | TTF entry present; `deso.geojson` entry preserved |
| `src/app/(app)/analysis/[id]/page.tsx` | `src/lib/schemas/report.ts` | `safeParseReportData(analysis.report_data)` | WIRED | Line 106 of page.tsx |
| `src/app/(app)/analysis/[id]/page.tsx` | `src/lib/report/fact-sheet.ts` | `assembleFactSheet(...)` for D-08 fingerprint | WIRED | Line 119 of page.tsx |
| `src/components/ai-report-section.tsx` | `src/actions/generate-report.ts` | `generateReport(analysisId)` via useTransition | WIRED | Lines 128, 216 of ai-report-section.tsx |
| `src/components/ai-report-section.tsx` | `src/actions/download-report-pdf.ts` | `downloadReportPdf(analysisId)` via useTransition | WIRED | Line 140 of ai-report-section.tsx |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| `AiReportSection` | `report` (ReportData \| null) | `safeParseReportData(analysis.report_data)` in page.tsx; report_data written by `generateReport` via `synthesizeReport` | Yes — Sonnet synthesis populates report_data in analyses table | FLOWING (structurally verified; live synthesis quality is HUMAN NEEDED) |
| `ReportFlags` | `flags` (Flag[]) | `computeFlags(...)` in generate-report.ts, persisted in report_data.flags | Yes — deterministic pure function, 173 tests pass | FLOWING |
| `ReportDocument` | `report + flags` from `ReportPdfData` | `safeParseReportData` in downloadReportPdf, same persisted report_data | Yes — same snapshot as on-screen | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full test suite passes | `npm run test` | 173 passed / 1 skipped / 6 todo | PASS |
| TypeScript compiles clean | `npx tsc --noEmit` | exit 0 | PASS |
| reportSchema excludes verdict fields | `grep -v '^\s*//' src/lib/schemas/report.ts \| grep -c 'verdict\|recommendation'` | 1 (comment reference only, not a field definition) | PASS |
| flags.ts is pure (no clock/random/fetch/await) | `grep -c 'Date\|Math.random\|fetch\|await' src/lib/report/flags.ts` | 0 | PASS |
| SONNET_USD_PER_MTOK present at correct rates | grep in cost.ts | input=3.0, output=15.0 confirmed | PASS |
| 004_report.sql has 5 additive columns, no RLS | grep | 5 matches / 0 create-policy | PASS |
| AI Rapport ComingSoonSection removed from both pages | grep | 0 occurrences in both files | PASS |
| render.ts has no Anthropic/DB import (D-11) | grep | 0 | PASS |
| WR-02 fix: ReportFlags uses priority not filter | code inspection | `shown = [...prioritized, ...remaining]` — all real flags always rendered | PASS |
| CR-01 fix: failed branch in AiReportSection | code inspection | `if (reportStatus === "failed" && !isGenerating)` branch renders error + retry | PASS |
| WR-01+WR-05 fix: atomic CAS + stale lock | code inspection | `.neq("report_status","generating")` CAS + `report_generating_started_at` timestamp + `STALE_LOCK_MS` reclamation | PASS |
| WR-03 fix: sek hoisted before try | code inspection | `let sek: number \| null = null` before try; catch uses `sek != null` | PASS |
| WR-04 fix: no unused Badge import in ai-report-section.tsx | grep | 0 Badge occurrences in ai-report-section.tsx | PASS |
| WR-06 fix: filename sanitized in download | code inspection | `const safeId = analysisId.replace(/[^a-zA-Z0-9_-]/g, "")` | PASS |

### Probe Execution

Step 7c: SKIPPED — no probe-*.sh files; probes were not declared in any PLAN.md for this phase. Behavioral verification covered by the deterministic test suite (npm run test) above.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| RPRT-01 | Plans 01, 03, 04, 06 | Claude generates AI-synthesized "vad du bör tänka på" summary combining all available data into an opinionated assessment | SATISFIED (structural) | synthesizeReport → Sonnet call with schema-constrained output; generateReport orchestrates; AiReportSection renders on analysis page |
| RPRT-02 | Plans 01, 02, 06 | System displays red/green flags for risk indicators (high BRF debt, planned stambyte, avgiftshöjning, unusual patterns) | SATISFIED | computeFlags covers all required categories; ReportFlags renders severity chips; deterministic tests cover every flag golden case |
| RPRT-03 | Plans 05, 06 | User can download and share analysis as PDF report | SATISFIED (structural) | downloadReportPdf login-gated action; renderReportPdf returns %PDF Buffer; Open Sans TTF for å/ä/ö; "Ladda ner PDF" button wired to URL.createObjectURL download |

### Anti-Patterns Found

No TBD / FIXME / XXX markers found in any phase-04 files. No unresolved stubs. 

The following items from 04-REVIEW.md Info findings remain (not blockers, not warnings; acknowledged as known tech debt for future cleanup):

| File | Item | Severity | Impact |
|------|------|----------|--------|
| `generate-report.ts` + `page.tsx` | IN-03: toFlagBrf/toFlagPrice/toSoftSignals duplicated in both files | Info | Future drift risk for D-08 staleness — commented to stay byte-identical; extracting to a shared module is the clean fix |
| `report-document.tsx` + `report-flags.tsx` | IN-04: FLAG_LABELS map duplicated with slightly different wording | Info | Screen and PDF labels already differ subtly ("Hög skuldsättning" vs "Hög skuldsättning i föreningen"); D-11 vocabulary drift risk |
| `generate-report.ts` | IN-01: cost guard uses `>` not `>=` at 5 SEK boundary | Info | A report costing exactly 5 SEK is persisted; boundary semantics undocumented |
| `fact-sheet.ts` | IN-02: `slot<T>` checks `=== undefined` but type only admits `T \| null` | Info | Defensive runtime check; type and implementation disagree slightly |

These four items are tracked in 04-REVIEW.md and do not affect phase goal achievement.

### Human Verification Required

Six items require human sign-off (detailed above in frontmatter). These overlap with the Plan 04-06 Task 3 checkpoint items that were explicitly deferred to phase UAT.

**1. Live synthesis quality (D-00 cohesion, D-04, D-05, D-06)**

**Test:** Open an owned analysis with BRF + price + area data, click "Generera AI-rapport"
**Expected:** leadSynthesis anchors the page (D-00/D-05), every claim cites a specific data point (D-06), no köp/sälj verdict (D-04), red/green flags woven in sage/terracotta (D-00)
**Why human:** ANTHROPIC_API_KEY required; synthesis quality and no-verdict discipline require a human reader

**2. PDF visual quality (RPRT-03, D-11, D-12)**

**Test:** Click "Ladda ner PDF" on a generated report
**Expected:** PDF downloads; å/ä/ö render correctly (no boxes); section order mirrors screen; disclaimer present
**Why human:** PDF glyph correctness and visual layout require a human eye

**3. Stale/regenerate flow (D-08)**

**Test:** Change an input, reload page
**Expected:** "Rapporten bygger på äldre data — uppdatera" marker + regenerate button appear; no auto-refire
**Why human:** Requires a running dev server and observing the fingerprint comparison at runtime

**4. Guest gate (D-09)**

**Test:** Log out, open analysis URL
**Expected:** Guest sees "Logga in för AI-rapport" teaser only
**Why human:** Auth/session state in a live browser

**5. Partial-data honesty (D-07/FM4)**

**Test:** Generate a report missing the BRF source
**Expected:** Ekonomi section shows "Ej tillgänglig", nothing fabricated
**Why human:** Live LLM call + human reading of partial-data output

**6. Live brf-extract/v2 eval (Plan 04-02 Task 3 — deferred)**

**Test:** Populate `evals/fixtures/*.pdf` + `evals/labels.json`, run `RUN_LLM_EVALS=1 ANTHROPIC_API_KEY=<live-key> npm run eval`
**Expected:** All assertions pass (four original BRF metrics not regressed, three D-02 soft signals extract with supporting citations)
**Why human:** Gitignored labeled dataset not yet built; live API call required

### Gaps Summary

No structural gaps. All code artifacts exist, are substantive, and are wired. All ROADMAP success criteria are satisfied at the code level. All 6 code-review findings (CR-01 + WR-01..WR-06) confirmed fixed in the current codebase. 

Phase status is `human_needed` because 5 runtime/visual/live-LLM acceptance items and 1 deferred eval item require human execution and sign-off before the phase can be declared fully complete.

---

_Verified: 2026-06-26T22:15:00Z_
_Verifier: Claude (gsd-verifier)_
