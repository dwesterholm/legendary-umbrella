---
phase: 04-ai-report-delivery
plan: 06
subsystem: ai-report-delivery
status: code-complete
tags: [report, ui, integration, d-00, pdf, staleness, guest-gate]
requires:
  - "src/actions/generate-report.ts (Plan 04)"
  - "src/actions/download-report-pdf.ts (Plan 05)"
  - "src/lib/report/fact-sheet.ts + flags.ts (fingerprint inputs)"
  - "src/lib/schemas/report.ts (safeParseReportData + ReportData)"
provides:
  - "AiReportSection — the on-page AI report anchor (trigger, guest teaser, stale/regenerate, PDF download)"
  - "ReportFlags — deterministic flags rendered in the shared sage/terracotta language"
  - "analysis page D-08 staleness recompute + placeholder removal"
affects:
  - "src/app/(app)/analysis/[id]/page.tsx"
  - "src/app/page.tsx"
tech-stack:
  added: []
  patterns:
    - "client trigger via useTransition + server action (mirrors brf-score-card.tsx)"
    - "page recomputes D-08 fingerprint from the SAME assembleFactSheet bytes the action hashed"
    - "URL.createObjectURL Blob download (RESEARCH Pitfall 6)"
key-files:
  created:
    - "src/components/ai-report-section.tsx"
    - "src/components/report-flags.tsx"
  modified:
    - "src/app/(app)/analysis/[id]/page.tsx"
    - "src/app/page.tsx"
decisions:
  - "AiReportSection placed as the page LEAD anchor (above the source cards) per D-00; ReportFlags surfaced inside the section, filtered by prioritizedFlagIds"
  - "Page replicates the action's toFlagBrf/toFlagPrice/toSoftSignals mapping locally so the recomputed fingerprint matches byte-for-byte (T-04-24); these helpers are not exported from generate-report.ts"
metrics:
  duration: ~12min
  completed: 2026-06-26
---

# Phase 4 Plan 6: On-Page Report Integration Summary

The four data sources become one cohesive second opinion: `AiReportSection` anchors the analysis page with the AI synthesis (lead/capstone, D-00/D-05), wires the manual Generera/Ladda ner PDF/regenerate triggers, gates it login-only with a guest teaser (D-09), and shows the D-08 staleness marker; `ReportFlags` renders the deterministic flags in the same sage/terracotta trust language; both AI Rapport placeholders are removed. Tasks 1–2 are complete and the plan is CODE-COMPLETE; Task 3 (human-verify) is DEFERRED-TO-PHASE-UAT — its 9 visual/end-to-end acceptance items are consolidated into the phase-level UAT run via `/gsd-verify-work` (overlaps the phase verifier's human checks, so no double-testing).

## What Was Built

### Task 1 — AiReportSection + ReportFlags (commit 51acf40)
- `src/components/ai-report-section.tsx` — `"use client"`, useTransition + server actions:
  - GUEST → "Logga in för AI-rapport" teaser only, never the report (D-09).
  - OWNER + no report → "Generera AI-rapport" button → `generateReport(analysisId)` with a "Genererar rapport…" pending state, disabled while `report_status === "generating"` or pending (D-07, no double-spend).
  - OWNER + report → `leadSynthesis` as the anchor (D-00/D-05); themed Ekonomi/Pris/Område sections, each rendering an honest "Ej tillgänglig" marker when `status === "ej_tillgänglig"` or no claims (D-07/D-12); each claim shows its `sourceRef` (D-06); woven `ReportFlags`; "Ladda ner PDF" → `downloadReportPdf(analysisId)` → `URL.createObjectURL` download then revoke (RPRT-03/D-10); "ej finansiell rådgivning" disclaimer + model/promptVersion provenance (D-12).
  - OWNER + stale → "Rapporten bygger på äldre data — uppdatera" marker + a regenerate button re-calling `generateReport` (D-08), no silent auto-refire.
- `src/components/report-flags.tsx` — `ReportFlags` renders the persisted `Flag[]` as red/green/neutral chips mapping severity onto the SAME vocabulary as `gradeColors` (green→sage, red→destructive, neutral→terracotta, D-00); each chip carries its `sourceRef` label, page ref, confidence, and (for cited soft signals) the verbatim quote (D-06/D-11). Supports an `only` allow-list so flags weave into / beside the relevant card.

### Task 2 — Analysis page wiring + placeholder removal (commit e49cb49)
- `src/app/(app)/analysis/[id]/page.tsx`:
  - `safeParseReportData(analysis.report_data)` added next to the existing safeParse guards (CR-01); null → "not generated yet".
  - D-08 fingerprint recompute: the page replicates the action's `toFlagBrf`/`toFlagPrice`/`toSoftSignals` mapping, runs `computeFlags(...)` then `assembleFactSheet({ listing, brf, price, area, flags, softSignals })`, then `createHash("sha256").update(factSheet).digest("hex")` — the SAME full stable fact sheet the action hashed, NOT a partial hash (T-04-24). `isStale` is true only when a report exists, a stored fingerprint exists, and it differs from the recomputed one.
  - `AiReportSection` rendered as the lead anchor above the BRF/market source cards (D-00); the AI Rapport `ComingSoonSection` removed.
- `src/app/page.tsx`: the AI Rapport `ComingSoonSection` removed; BRF/Pris/Område placeholders intact.

## Verification

- `npx tsc --noEmit` passes (exit 0) after both tasks.
- **`npm run build` SUCCEEDS** — no react-pdf bundling error; the `/analysis/[id]` route is dynamic, so NO `serverExternalPackages` change was needed (RESEARCH Pitfall 4 / A1 confirmed: react-pdf stays out of `serverExternalPackages`).
- **Full test suite: 171 passed / 1 skipped / 6 todo** (post-merge gate, operator-confirmed).
- Task 1 greps: `generateReport|downloadReportPdf|Logga in för AI-rapport|äldre data` = 9; guest teaser = 2; stale marker = 2; disclaimer = 2; report-flags `sage|terracotta|severity` = 10; `sourceRef` = 2. All ≥ thresholds.
- Task 2 greps: AI Rapport `ComingSoonSection` total across both files = 0; `AiReportSection|safeParseReportData` on page = 4 (≥2); `assembleFactSheet` = 3 (≥1); `fingerprint|createHash` = 11 (≥1).
- Home-page `ComingSoonSection` JSX usages = 3 (BRF/Pris/Område), plus the import line. The plan's `== 3` grep counts the import too (raw count 4); the intent — AI Rapport removed, the other three intact — is fully met. See Deviations.

## Deviations from Plan

### Acceptance grep vs. intent (home page ComingSoonSection)
- **Found during:** Task 2 verification.
- **Issue:** The plan's acceptance criterion `grep -c 'ComingSoonSection' src/app/page.tsx == 3` returns 4 because the `import { ComingSoonSection }` line still matches (the import is still needed for the three remaining placeholders).
- **Resolution:** No code change — the three intended JSX usages (BRF Analys / Prisjamforelse / Omradesstatistik) are present and the AI Rapport one is gone, which is the criterion's intent. The import stays because the component is still used.
- **Files:** src/app/page.tsx.

No auto-fixed bugs (Rules 1–3) were needed; both tasks compiled and verified on first pass.

## Authentication Gates

None during Tasks 1–2. The Task 3 checkpoint requires a real `ANTHROPIC_API_KEY` and the 004 migration — that is part of the human-verify gate, not an auth gate in this executor's path.

## Checkpoint Status

**Task 3 (checkpoint:human-verify, gate="blocking") — DEFERRED-TO-PHASE-UAT.** Per operator decision, the manual D-00/live-synthesis/PDF/guest-gate verification is consolidated into a single phase-level UAT pass via `/gsd-verify-work` (it overlaps the phase verifier's human checks — no double-testing). This is NOT a failure and NOT a silent skip: the 9 visual/end-to-end acceptance items below carry forward verbatim for the verifier/UAT to execute. The executor did NOT self-resolve the gate; the code is complete and the automated post-merge gate (tsc clean, suite 171 passed, build succeeds) has passed.

### Deferred acceptance items (run verbatim in phase UAT via /gsd-verify-work)

1. Ensure `ANTHROPIC_API_KEY` is set in `.env.local` and the 004 migration is applied (Plan 03 Task 3).
2. `npm run build` succeeds (confirm no react-pdf bundling error; if one appears, add `@react-pdf/renderer` to `serverExternalPackages` per RESEARCH Pitfall 4 and rebuild). **[Pre-confirmed: build succeeds, no change needed.]**
3. `npm run dev`, open an owned analysis that has BRF + price + area data. Confirm: the AI Rapport placeholder is gone; a "Generera AI-rapport" button shows (D-07).
4. Click Generera. Confirm the "Genererar rapport…" state, then the lead synthesis renders as the page anchor (D-00/D-05), themed sections add interpretation (not raw-number restatement), and every claim cites a data point (D-06). Confirm NO buy/sälj verdict (D-04).
5. Confirm red/green flags appear woven into the BRF/price/area cards in the sage/terracotta language (D-00), each with its source/citation.
6. Click "Ladda ner PDF" → a PDF downloads; open it and confirm å/ä/ö render correctly (no boxes), the section order mirrors the screen (D-11), and the "ej finansiell rådgivning" disclaimer + source/freshness labels are present (D-12).
7. Correct a BRF field (or otherwise change an input) → reload the page → confirm the "Rapporten bygger på äldre data — uppdatera" marker + regenerate button appear (D-08), with no silent auto-refire.
8. Log out, open the analysis URL → confirm the guest sees "Logga in för AI-rapport", not the report (D-09).
9. Generate a report on an analysis MISSING the BRF (or market) source → confirm that section is honestly "Ej tillgänglig" and nothing is fabricated (D-07/FM4).

**Acceptance dimensions for UAT sign-off:** the page reads as ONE integrated second opinion (summary anchors, flags woven in), not four bolt-on features (D-00); the report is opinionated, cites specific data, and issues no verdict (D-04/D-06); the PDF mirrors the screen with correct å/ä/ö + disclaimer (RPRT-03/D-11/D-12); the stale marker + regenerate work, the guest teaser gates login-only (D-09), and partial-data sections are honestly `ej_tillgänglig` (D-07).

## Threat Surface

No new surface beyond the plan's `<threat_model>`. The guest gate (T-04-21), read-path safeParse (T-04-22), no-auto-refire stale marker (T-04-23), and full-fact-sheet fingerprint (T-04-24) are all implemented as specified.

## Self-Check: PASSED

- FOUND: src/components/ai-report-section.tsx
- FOUND: src/components/report-flags.tsx
- FOUND commit 51acf40 (Task 1)
- FOUND commit e49cb49 (Task 2)
