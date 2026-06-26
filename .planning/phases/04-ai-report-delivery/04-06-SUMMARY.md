---
phase: 04-ai-report-delivery
plan: 06
subsystem: ai-report-delivery
status: paused-at-checkpoint
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

The four data sources become one cohesive second opinion: `AiReportSection` anchors the analysis page with the AI synthesis (lead/capstone, D-00/D-05), wires the manual Generera/Ladda ner PDF/regenerate triggers, gates it login-only with a guest teaser (D-09), and shows the D-08 staleness marker; `ReportFlags` renders the deterministic flags in the same sage/terracotta trust language; both AI Rapport placeholders are removed. Tasks 1–2 are complete; Task 3 is a blocking human-verify checkpoint (live synthesis + PDF glyphs + cohesion need a real ANTHROPIC_API_KEY and a human eye) — NOT self-resolved.

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

**Task 3 (checkpoint:human-verify, gate="blocking") was NOT executed or self-resolved.** Live synthesis, PDF glyph rendering (å/ä/ö), D-00 cohesion as an acceptance dimension, the stale/regenerate flow, the guest gate, and partial-data honesty all require a running app with a real API key and a human eye. The structured checkpoint state is returned to the orchestrator.

## Threat Surface

No new surface beyond the plan's `<threat_model>`. The guest gate (T-04-21), read-path safeParse (T-04-22), no-auto-refire stale marker (T-04-23), and full-fact-sheet fingerprint (T-04-24) are all implemented as specified.

## Self-Check: PASSED

- FOUND: src/components/ai-report-section.tsx
- FOUND: src/components/report-flags.tsx
- FOUND commit 51acf40 (Task 1)
- FOUND commit e49cb49 (Task 2)
