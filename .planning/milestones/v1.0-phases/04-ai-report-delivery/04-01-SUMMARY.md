---
phase: 04-ai-report-delivery
plan: 01
subsystem: ai-report-deterministic-core
tags: [zod, flags, fact-sheet, cost, tdd, deterministic]
requires:
  - "src/lib/brf/score.ts (BRF_SCORE_THRESHOLDS)"
  - "src/lib/market/compare.ts (PRICE_COMPARISON_THRESHOLDS)"
  - "src/lib/brf/sanity.ts (OSAKER_THRESHOLD)"
  - "src/lib/schemas/brf.ts (extractedField analog, safeParseBrfData shape)"
provides:
  - "reportSchema / type AiReport / citedClaim / themedSection (src/lib/schemas/report.ts)"
  - "reportDataSchema / type ReportData / safeParseReportData (read-path guard, CR-01)"
  - "computeFlags / type Flag / type FlagSet / FLAG_IDS / PRICE_FLAG_BAND_PCT (src/lib/report/flags.ts)"
  - "assembleFactSheet / type FactSheetInput (src/lib/report/fact-sheet.ts)"
  - "SONNET_USD_PER_MTOK / costSekSonnet (src/lib/brf/cost.ts)"
affects:
  - "Plan 02 (extended BRF extraction soft-signal fields feed computeFlags input)"
  - "Plan 03 (synthesizeReport consumes reportSchema + assembleFactSheet output)"
  - "Plan 04 (generate-report action uses costSekSonnet for the 5 SEK guard + persists reportDataSchema shape)"
tech-stack:
  added: []
  patterns:
    - "zod/v4 structured-output contract shaped to make failure modes unrepresentable (no verdict/recommendation/free-form-flag field)"
    - "pure deterministic flag engine reusing existing thresholds (never redefining), null-tolerant"
    - "stable-key-order JSON fact-sheet via recursive key sort for prompt-cache hygiene"
    - "read-path safeParse guard mirroring safeParseBrfData (degrade-to-null)"
key-files:
  created:
    - "src/lib/schemas/report.ts"
    - "src/lib/schemas/report.test.ts"
    - "src/lib/report/flags.ts"
    - "evals/flags.test.ts"
    - "src/lib/report/fact-sheet.ts"
    - "evals/report.test.ts"
  modified:
    - "src/lib/brf/cost.ts"
decisions:
  - "Pricing-flag presentation band PRICE_FLAG_BAND_PCT=7 owned by flags.ts (the ±% magnitude worth surfacing); comparison math stays in compare.ts"
  - "kassaflode in [0, healthyMin) raises brf_kassaflode_weak; red when below warningMin, neutral when warningMin–healthyMin; <0 is brf_kassaflode_deficit (red)"
  - "stambyte red/green flag gated on citation-backed signal (sourceQuote present AND confidence ≥ OSAKER_THRESHOLD) per AI-SPEC §6"
  - "reportDataSchema validates own-code fields loosely (mirrors brfDataSchema); every field nullable, never optional"
metrics:
  duration: 4min
  completed: 2026-06-25
---

# Phase 4 Plan 1: AI Report Deterministic Core Summary

The LLM-free foundation of the AI report: the report Zod schema + CR-01 read-path guard, the pure deterministic flag engine (numeric + D-03 enum soft-signal), the stable-key-order fact-sheet assembler, and the Sonnet cost-rate extension — each built RED-first, defending the catastrophic failure modes (model-minted flags FM3, verdicts FM2, unit confusion FM1) by making them unrepresentable.

## What Was Built

- **`src/lib/schemas/report.ts`** — `reportSchema` (`citedClaim`, `themedSection`) copied verbatim from AI-SPEC §4b: a `leadSynthesis`, three themed sections each `{ status: bedömd|ej_tillgänglig, claims }`, and `prioritizedFlagIds` (string ids only). No `verdict`/`recommendation`/`betyg` field (D-04/FM2 unrepresentable); no free-form flag field (D-03/FM3 — model references ids). `reportDataSchema` wraps the persisted snapshot (report + flags + softSignals + dataFingerprint + costSek + model + promptVersion), validated loosely for own-code fields. `safeParseReportData` mirrors `safeParseBrfData` exactly (null guard → safeParse → `success ? data : null`).
- **`src/lib/report/flags.ts`** — pure `computeFlags(input)`: imports `BRF_SCORE_THRESHOLDS` and `PRICE_COMPARISON_THRESHOLDS` (never redefines numbers, T-04-01). Numeric flags for skuld (high/low), avgift (healthy/lean/elevated), kassaflode (deficit/weak). Pricing flag only when `reason === "ok"` AND `sampleSize > thinMaxComps`, beyond `±PRICE_FLAG_BAND_PCT`. D-03 enum soft signal `stambytePlanerat` → red (`planerat`) / green (`nyligen_genomfort`), citation-gated via `OSAKER_THRESHOLD`. Free-text soft signals are NEVER minted into flags. Null source → no flag. Stable `FLAG_IDS` constants exported.
- **`src/lib/report/fact-sheet.ts`** — `assembleFactSheet(input)`: builds a `JSON.stringify`'d bundle with recursively-sorted object keys (deterministic byte output for prompt-cache hits, §4b.4). Absent source → explicit `{ status: "ej_tillgänglig" }`; present → `{ status: "tillgänglig", data }` (D-07). Flags array order preserved.
- **`src/lib/brf/cost.ts`** (extended) — added `SONNET_USD_PER_MTOK` ($3/$15/$3.75/$0.30) and `costSekSonnet` (same arithmetic + `USD_SEK_RATE`, Sonnet rates). Haiku `USD_PER_MTOK` and `costSek` left untouched (T-04-03).

## How to Verify

```bash
npx vitest run src/lib/schemas/report.test.ts evals/flags.test.ts evals/report.test.ts src/lib/brf/cost.test.ts
npx tsc --noEmit
```

All 45 tests pass; `tsc --noEmit` exits 0. No package installed, no migration in this plan.

## TDD Gate Compliance

Tasks 1 and 2 followed RED → GREEN:
- Task 1: `test(04-01)` 02e2a60 (RED) → `feat(04-01)` 1945f61 (GREEN).
- Task 2: `test(04-01)` 6b5fc1e (RED) → `feat(04-01)` 9154e27 (GREEN).

Each RED commit was confirmed failing (module not found) before the GREEN implementation. Task 3 (`type="auto"`, no `tdd` flag) added its assertions alongside the implementation in a single `feat` commit (a40817e) — the cost.test.ts Haiku assertions remained green throughout, confirming the Haiku path was untouched.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Reworded a doc-comment to satisfy the purity grep**
- **Found during:** Task 2 acceptance check.
- **Issue:** The acceptance criterion `grep -c 'Date\|Math.random\|fetch\|await' src/lib/report/flags.ts` returned 0 must hold; the original doc-comment literally listed "no `Date`, no `Math.random`, no network, no `await`" — matching the grep even though no such construct exists in the code.
- **Fix:** Reworded the comment to "no clock read, no randomness, no network, no async". The function remains pure; the grep now returns 0.
- **Files modified:** `src/lib/report/flags.ts`
- **Commit:** 9154e27

## Self-Check: PASSED

Files (all FOUND): src/lib/schemas/report.ts, src/lib/schemas/report.test.ts, src/lib/report/flags.ts, evals/flags.test.ts, src/lib/report/fact-sheet.ts, src/lib/brf/cost.ts, evals/report.test.ts.

Commits (all FOUND): 02e2a60, 1945f61, 6b5fc1e, 9154e27, a40817e.
