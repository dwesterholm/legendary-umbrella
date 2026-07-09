---
phase: 02-brf-financial-analysis
plan: 03
subsystem: brf-deterministic-core
tags: [zod, deterministic-scorer, sanity-bands, cost, tdd, green, d-08, d-10]
requires:
  - "vitest@^4.1.8 + @ alias (Plan 01)"
  - "RED deterministic-core tests (Plan 01)"
  - "zod@^4.3.6 (Phase 1)"
provides:
  - "brfExtractionSchema + normalizeBrfExtraction (src/lib/schemas/brf.ts)"
  - "computeBrfGrade + BRF_SCORE_THRESHOLDS (src/lib/brf/score.ts)"
  - "applySanityChecks + BRF_SANITY_BANDS + OSAKER_THRESHOLD (src/lib/brf/sanity.ts)"
  - "costSek + USD_PER_MTOK + USD_SEK_RATE (src/lib/brf/cost.ts)"
affects:
  - "Plan 04 (analyze-brf server action consumes schema/normalizer/scorer/sanity/cost)"
  - "Plan 05 (methodology page imports BRF_SCORE_THRESHOLDS + BRF_SANITY_BANDS + OSAKER_THRESHOLD)"
tech-stack:
  added: []
  patterns:
    - "extractedField factory mirrors AI-SPEC §4b.1; value always .nullable() never .optional()"
    - "null-tolerant normalizer mirrors listing.ts normalizeScraperOutput"
    - "single-source-of-truth threshold/weight constants for the public methodology page (D-09)"
    - "pure deterministic scorer — no Claude, no async, no Date/Math.random (D-08)"
key-files:
  created:
    - "src/lib/schemas/brf.ts"
    - "src/lib/brf/score.ts"
    - "src/lib/brf/sanity.ts"
    - "src/lib/brf/cost.ts"
  modified: []
decisions:
  - "Locked grade weights: skuldPerKvm 0.35, kassaflode 0.30, avgiftsniva 0.20, underhallsplanStatus 0.15 (sum 1.0) — debt and cash-flow dominate, defensible against BFNAR/bank guidance for the public methodology page (D-09)"
  - "Locked grade bands on composite [0,1]: A≥0.85, B≥0.70, C≥0.50, D≥0.35, E≥0.20, else F"
  - "OSAKER_THRESHOLD = 0.5 exported from sanity.ts (aligns with Plan 01 test); sanity-failed fields forced to confidence 0.2 (strictly below it)"
  - "A null metric counts its weight but contributes 0 score — missing data lowers the grade, never silently scored good (D-08)"
metrics:
  duration: ~5min
  completed: 2026-06-07
---

# Phase 2 Plan 03: BRF Deterministic Core Summary

Implemented the four pure, provider-agnostic modules that turn a Claude extraction into an auditable A–F grade — Zod schema + null-tolerant normalizer, the rule-based deterministic scorer, the sanity-range confidence guardrail, and the Haiku cost calculator — turning all 29 of Plan 01's RED deterministic-core tests GREEN.

## What Was Built

- **`src/lib/schemas/brf.ts`** — `extractedField()` factory (value `.nullable()` + confidence 0–1 + sourceQuote + pageRef, with `.describe()` steering text from AI-SPEC §4b.1), `brfExtractionSchema` (the four named figures: skuldPerKvm, avgiftsniva, kassaflode, underhallsplanStatus). FM2 invariant holds: zero grade/score/rating/betyg keys (D-08). `normalizeBrfExtraction()` flattens each field to its primitive value, null-tolerant in the exact style of `normalizeScraperOutput`. Exports `BrfExtraction`, `NormalizedBrf`, `ExtractedField<T>`, `UnderhallsplanStatus`.
- **`src/lib/brf/score.ts`** — `computeBrfGrade()`: a pure deterministic function (no Claude, no async, no `Date`/`Math.random`) returning `{ grade, breakdown }`. Each breakdown row carries `key`, `value`, `rating`, `weight`, `contribution` (D-07). `BRF_SCORE_THRESHOLDS` is the single source of truth for every band and weight (Plan 05 imports it directly). A null value → `not_assessable` rating, 0 contribution, weight still counted.
- **`src/lib/brf/sanity.ts`** — `applySanityChecks()`: range-band guardrail (D-10) that downgrades out-of-band field confidence to 0.2 (strictly below `OSAKER_THRESHOLD = 0.5`) while never dropping the value (D-12 keeps it editable). `BRF_SANITY_BANDS` published (skuld 2000–15000, avgift 300–1200 SEK/m²/år). In-band high-confidence fields pass through untouched.
- **`src/lib/brf/cost.ts`** — `costSek()`: sums input/output/cache-write/cache-read tokens × verified Haiku 4.5 per-MTok rates × `USD_SEK_RATE`. `USD_PER_MTOK` ($1/$5/$1.25/$0.10) and `USD_SEK_RATE` (11) exported as named constants. Typical 80k/1k run ≈ 0.94 SEK, well under the 5 SEK cap; cache-read retry cheaper than a cold run.

## Threat Model Coverage

- **T-02-06 (tampering — extraction values feeding the grade):** mitigated by `applySanityChecks` forcing out-of-band values below the Osäker threshold before scoring.
- **T-02-07 (tampering — grade provenance):** mitigated by the pure/deterministic `computeBrfGrade` and the grade-field-free extraction schema (FM2). The model cannot produce or perturb the grade.
- **T-02-08 (DoS — Claude budget):** `costSek` supplies the per-analysis < 5 SEK computation the Plan 04 action enforces.

## Verification

- `npx vitest run src/lib/schemas/brf.test.ts src/lib/brf/score.test.ts` → 17 passed.
- `npx vitest run src/lib/brf/sanity.test.ts src/lib/brf/cost.test.ts` → 12 passed.
- `npx vitest run src/lib/brf src/lib/schemas/brf.test.ts` → **4 files, 29 tests passed** (Plan 01's RED suite is now fully GREEN).
- Provider-agnostic check: no `@anthropic-ai/sdk` import and no `async` keyword in score.ts/sanity.ts/cost.ts (the only "async" occurrences are in JSDoc prose).

## TDD Gate Compliance

This is the GREEN gate for the deterministic core. RED was established in Plan 01 (commit c4083c2). The test files were NOT modified — every implementation was written to satisfy the existing contracts. GREEN commits: e608d0b (schema), 6d9b1ed (scorer), ef161cd (sanity + cost). A REFACTOR gate was not needed; the first GREEN implementation is clean.

## Deviations from Plan

None — plan executed exactly as written. Concrete weights and grade bands were proposed and locked per the plan's instruction to pick defensible numbers (recorded under Decisions).

## Known Stubs

None. All four modules are fully implemented and consumed by the test suite without mocks or placeholders.

## Self-Check: PASSED

- src/lib/schemas/brf.ts — FOUND
- src/lib/brf/score.ts — FOUND
- src/lib/brf/sanity.ts — FOUND
- src/lib/brf/cost.ts — FOUND
- Commit e608d0b — FOUND
- Commit 6d9b1ed — FOUND
- Commit ef161cd — FOUND

## Commits

- `e608d0b` feat(02-03): add brfExtractionSchema + normalizeBrfExtraction
- `6d9b1ed` feat(02-03): add computeBrfGrade deterministic A-F scorer
- `ef161cd` feat(02-03): add applySanityChecks guardrail and costSek calculator
