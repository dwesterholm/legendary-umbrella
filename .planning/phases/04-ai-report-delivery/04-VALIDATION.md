---
phase: 4
slug: ai-report-delivery
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-06-23
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.8 (deterministic unit, no API key) + Promptfoo 0.120.19 (LLM evals) — both already installed |
| **Config file** | `vitest.config.ts` (node env, `@/*` → `./src/*` alias); `evals/promptfooconfig.yaml` (extraction); new `evals/report-promptfooconfig.yaml` (synthesis, Plan 03) |
| **Quick run command** | `npm run test` (= `vitest run` — all deterministic Vitest, no API spend) |
| **Full suite command** | `RUN_LLM_EVALS=1 npm run eval` (= `RUN_LLM_EVALS=1 vitest run evals/extractor.eval.ts`) + `npx promptfoo eval -c evals/promptfooconfig.yaml` + `npx promptfoo eval -c evals/report-promptfooconfig.yaml` |
| **Estimated runtime** | Deterministic suite ~5–15s; gated LLM eval suite minutes + API spend (run only at wave/phase gates and before any prompt-version bump) |

Notes:
- Per-file quick runs use `npx vitest run <path>` (the exact form the plans emit) — equivalent to a scoped `npm run test`.
- `npm run eval` points at `evals/extractor.eval.ts` (committed-status unconfirmed — see Wave 0 / Manual-Only: the Phase 2 harness file may be missing; Plan 02 Task 3 surfaces this to the operator).

---

## Sampling Rate

- **After every task commit:** Run `npm run test` (or the task's scoped `npx vitest run <file>`) — deterministic, no API key, fast feedback.
- **After every plan wave:** Run `npm run test` + `npx promptfoo eval -c evals/report-promptfooconfig.yaml` (cheap frozen fact-sheet subset) once Plan 03 lands.
- **Before `/gsd-verify-work`:** Full deterministic suite green; AND before any prompt-version bump (Plan 02 `brf-extract/v2`, Plan 03 `report-synth/v1`) run `RUN_LLM_EVALS=1 npm run eval` + the full Phase 2 extraction eval re-run (cross-phase soft-signal change).
- **Max feedback latency:** ~15s for the deterministic suite (the per-commit signal). LLM eval latency is gate-only, not per-commit.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 04-01-01 | 01 | 1 | RPRT-01 | T-04-02 / T-04-04 | safeParseReportData drift → null (no half-parsed leak); no verdict/minted-flag key representable | unit | `npx vitest run src/lib/schemas/report.test.ts` | ❌ W0 | ⬜ pending |
| 04-01-02 | 01 | 1 | RPRT-02 | T-04-01 / T-04-04 | flags reuse existing thresholds (no drift); null source → no flag; pure function (no Date/random/fetch) | unit | `npx vitest run evals/flags.test.ts` | ❌ W0 | ⬜ pending |
| 04-01-03 | 01 | 1 | RPRT-01 | T-04-03 | Sonnet cost rated $3/$15; assembleFactSheet stable-key-order + explicit ej_tillgänglig | unit | `npx vitest run evals/report.test.ts src/lib/brf/cost.test.ts` | ❌ W0 (evals/report.test.ts) / ✅ (cost.test.ts) | ⬜ pending |
| 04-02-01 | 02 | 1 | RPRT-02 | T-04-05 | three soft-signal fields ride existing extractedField (cited/confidence); enum constrained; .nullable not .optional | unit | `npx vitest run src/lib/schemas/brf.test.ts` | ✅ (extend existing) | ⬜ pending |
| 04-02-02 | 02 | 1 | RPRT-02 | T-04-05 | prompt version bumped once; soft-signal extraction requires sourceQuote+pageRef (never invent) | unit + grep | `npx vitest run src/lib/schemas/brf.test.ts src/actions/analyze-brf.test.ts && grep -c 'brf-extract/v2' src/lib/brf/prompt.ts` | ✅ (extend existing) | ⬜ pending |
| 04-02-03 | 02 | 1 | RPRT-02 | T-04-07 | cross-phase regression gate — original four metrics must not drop; soft signals extract with citation | eval (LLM, gated) + manual | `npm run test` then `npx promptfoo eval -c evals/promptfooconfig.yaml` then `RUN_LLM_EVALS=1 npm run eval` | ⚠️ harness may be missing | ⬜ pending (human-verify) |
| 04-03-01 | 03 | 2 | RPRT-01 | T-04-08 / T-04-09 / T-04-11 | stop_reason branched before parsed_output; only {analysisId,code} logged; no verdict/originated flag | unit + tsc | `npx vitest run evals/report.test.ts && npx tsc --noEmit` | ❌ W0 (extended by Plan 01 T3) | ⬜ pending |
| 04-03-02 | 03 | 2 | RPRT-01 | T-04-10 | five additive report_* columns; zero new RLS (mirrors migration 003) | static (grep) | `grep -c 'add column if not exists report_data\|...report_status\|...report_cost_sek\|...report_data_fingerprint\|...report_prompt_version' supabase/migrations/004_report.sql` (== 5) | ❌ W0 (migration file) | ⬜ pending |
| 04-03-03 | 03 | 2 | RPRT-01 | T-04-10 | migration applied to live DB without RLS/duplicate-policy error (false-positive verify guard) | manual | `supabase db push` (operator-gated) + confirm 5 columns on public.analyses | n/a (live DB) | ⬜ pending (human-action) |
| 04-04-01 | 04 | 3 | RPRT-01 | T-04-12..16 | auth+ownership (IDOR → hittades inte); in-flight lock (no double-spend); Sonnet-rated 5 SEK cap; sha256 fingerprint; {analysisId,code}-only logs | unit + tsc | `npx vitest run src/actions/generate-report.test.ts && npx tsc --noEmit` | ❌ W0 | ⬜ pending |
| 04-05-01 | 05 | 3 | RPRT-03 | T-04-19 | TTF traced into server bundle alongside geojson; not added to serverExternalPackages yet | static (node + ls) | `node -e "...@react-pdf/renderer present..." && ls src/lib/report/pdf/fonts/*.ttf` | ❌ W0 (fonts asset) | ⬜ pending |
| 04-05-02 | 05 | 3 | RPRT-03 | T-04-19 / T-04-20 | non-empty %PDF buffer; å/ä/ö glyph smoke; render.ts has no Anthropic/DB import (no re-synthesis) | unit | `npx vitest run src/lib/report/pdf/render.test.ts` | ❌ W0 | ⬜ pending |
| 04-05-03 | 05 | 3 | RPRT-03 | T-04-17 / T-04-20 | unauthenticated → Swedish login error; IDOR → hittades inte; null report_data → affordance (no crash); NO synthesizeReport invocation | unit + tsc + grep | `npx vitest run src/actions/download-report-pdf.test.ts && npx tsc --noEmit && grep -c 'getUser\|row.user_id\|renderReportPdf' src/actions/download-report-pdf.ts` | ❌ W0 | ⬜ pending |
| 04-06-01 | 06 | 4 | RPRT-01/02/03 | T-04-21 | guest teaser (no report); generateReport + downloadReportPdf wired; stale marker; sage/terracotta flags | static (tsc + grep) | `npx tsc --noEmit && grep -c 'generateReport\|downloadReportPdf\|Logga in för AI-rapport\|äldre data' src/components/ai-report-section.tsx` | ❌ W0 (new component) | ⬜ pending |
| 04-06-02 | 06 | 4 | RPRT-01/02/03 | T-04-22 / T-04-24 | placeholders removed both files; safeParseReportData + isStale wired; D-08 fingerprint recomputed from FULL assembleFactSheet | static (tsc + grep) | `npx tsc --noEmit && test "$(grep -c 'ComingSoonSection title=\"AI Rapport\"' '...page.tsx' src/app/page.tsx)" = "0"` + `grep -c 'assembleFactSheet' '...page.tsx'` >= 1 | ❌ W0 (page edit) | ⬜ pending |
| 04-06-03 | 06 | 4 | RPRT-01/02/03 | T-04-21..23 | D-00 cohesion; opinionated-no-verdict; PDF å/ä/ö + order + disclaimer; stale/regenerate; guest gate; partial-data honesty | manual (live API key + applied migration) | human-verify checklist (build + dev walkthrough) | n/a (visual/E2E) | ⬜ pending (human-verify) |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*
*"File Exists" ❌ W0 = the test/asset is a RED-first Wave 0 deliverable created at execution time (not yet on disk during planning); ✅ = the file already exists and is extended.*

---

## Wave 0 Requirements

RED-first test/scaffold files the plans create before (or alongside) their implementation. These do not exist on disk during planning — they are written first in each task's RED step:

- [ ] `src/lib/schemas/report.test.ts` — reportSchema validity, no-verdict invariant, safeParseReportData drift→null guard (CR-01) — **Plan 01 Task 1** (RPRT-01)
- [ ] `evals/flags.test.ts` — deterministic numeric + enum-soft-signal flag golden tests (D-01a/D-03) — **Plan 01 Task 2** (RPRT-02)
- [ ] `evals/report.test.ts` — Sonnet-rate + stable-fact-sheet assertions (**Plan 01 Task 3**), extended with stop-reason fixtures (refusal/max_tokens/empty → codes) + log-redaction assertion (**Plan 03 Task 1**) (RPRT-01)
- [ ] `src/lib/report/pdf/render.test.ts` — non-empty %PDF buffer + å/ä/ö glyph smoke + no-re-synthesis static check — **Plan 05 Task 2** (RPRT-03)
- [ ] `src/actions/download-report-pdf.test.ts` — auth (login error), IDOR (hittades inte), null report_data → affordance, NO synthesizeReport invocation — **Plan 05 Task 3** (RPRT-03; added per checker Warning 3)
- [ ] `src/actions/generate-report.test.ts` — auth/IDOR, status flow (generating→done/failed), Sonnet cost cap, partial-data assembly, sha256 fingerprint — **Plan 04 Task 1** (RPRT-01)
- [ ] Synthesis LLM-eval scaffolds: `evals/report-promptfooconfig.yaml` + `evals/report-judge.ts` (verdict-line / generic-filler / synthesis-quality judge dimensions) — **Plan 03 Task 2** (RPRT-01; nightly flywheel, not blocking CI)
- [ ] Extend (do NOT recreate) `evals/promptfooconfig.yaml` + `evals/labels.example.json` with the three soft-signal expectations — **Plan 02 Task 2** (RPRT-02)

Files extended (already exist — not Wave 0 net-new): `src/lib/schemas/brf.test.ts`, `src/actions/analyze-brf.test.ts`, `src/lib/brf/cost.test.ts`.

*Aligns with RESEARCH § Validation Architecture → Wave 0 Gaps.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Phase 2 extraction eval re-run (no regression on the original four metrics; soft signals extract with citation) | RPRT-02 | Cross-phase prompt-version bump (`brf-extract/v2`) needs a live LLM eval + API key; the `npm run eval` harness (`evals/extractor.eval.ts`) may not be committed | Plan 02 Task 3: set `ANTHROPIC_API_KEY`, run `npm run test` (green), `npx promptfoo eval -c evals/promptfooconfig.yaml`, then `RUN_LLM_EVALS=1 npm run eval`; if the harness file is missing, report the gap and agree a scaffold path before approving |
| Apply `004_report.sql` to the live Supabase DB | RPRT-01 | Migration push is operator-gated (Phase 2/3 precedent); build/tsc pass WITHOUT it, so skipping creates a false-positive verify state — the report cannot persist/load until the columns exist | Plan 03 Task 3: review the five additive columns + zero RLS, `supabase db push` (un-pause project if dormant), confirm the five `report_*` columns on `public.analyses`, no duplicate-policy error |
| D-00 cohesion + PDF glyphs + stale/regenerate + guest gate + partial-data honesty (end-to-end) | RPRT-01/02/03 | Visual/UX cohesion is an explicit acceptance dimension; PDF å/ä/ö rendering and live synthesis need a human eye + real API key + applied migration | Plan 06 Task 3: `npm run build`, `npm run dev`, walk the owned-analysis generate → flags-in-cards → Ladda ner PDF (å/ä/ö, order, disclaimer) → change-input stale marker → guest teaser → missing-source ej_tillgänglig checklist |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or a Wave 0 dependency (every auto task maps to a deterministic command; the three checkpoints are documented manual-only verifications)
- [x] Sampling continuity: no 3 consecutive auto tasks without an automated verify (each auto task carries a `<verify><automated>` command)
- [x] Wave 0 covers all MISSING (`❌ W0`) test references in the Per-Task Verification Map
- [x] No watch-mode flags (`npm run test` = `vitest run`; per-file uses `npx vitest run` — never `vitest`/`test:watch`)
- [x] Feedback latency < ~15s for the deterministic per-commit signal
- [x] `nyquist_compliant: true` set in frontmatter
- [ ] `wave_0_complete` — set to `true` at execution once the RED-first Wave 0 test files above exist and fail/pass as expected (false at planning time by design)

**Approval:** pending (auto tasks Nyquist-compliant; the three manual-only verifications are the documented exceptions, gated at execution)
</content>
