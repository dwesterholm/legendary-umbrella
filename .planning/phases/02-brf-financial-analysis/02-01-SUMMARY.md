---
phase: 02-brf-financial-analysis
plan: 01
subsystem: brf-test-harness
tags: [vitest, promptfoo, tdd, red, deterministic-scorer, eval-harness]
requires:
  - "@anthropic-ai/sdk@^0.102.0 (already installed, Phase 1)"
  - "zod@^4.3.6 (already installed, Phase 1)"
provides:
  - "vitest test runner configured with @ alias"
  - "RED test scaffolds for src/lib/brf/{score,sanity,cost} and src/lib/schemas/brf"
  - "RED test scaffold for src/actions/analyze-brf"
  - "promptfoo eval-harness skeleton (cost-gated, not run in CI)"
affects:
  - "Plan 03 (implements score.ts/sanity.ts/cost.ts/schemas/brf.ts against these tests)"
  - "Plan 04 (implements analyze-brf.ts; promotes it.todo markers to integration tests)"
  - "Plan 05 (methodology page reuses BRF_SCORE_THRESHOLDS source of truth)"
tech-stack:
  added:
    - "vitest@^4.1.8 (dev)"
    - "@vitest/coverage-v8@^4.1.8 (dev)"
    - "promptfoo@^0.120.19 (dev)"
  patterns:
    - "vitest config mirrors tsconfig @/* -> ./src alias via path.resolve"
    - "RED-first: tests import not-yet-existing modules so the suite fails on missing import"
    - "null-tolerant contract mirrors src/lib/schemas/listing.ts"
key-files:
  created:
    - "vitest.config.ts"
    - "src/lib/brf/score.test.ts"
    - "src/lib/brf/sanity.test.ts"
    - "src/lib/brf/cost.test.ts"
    - "src/lib/schemas/brf.test.ts"
    - "src/actions/analyze-brf.test.ts"
    - "evals/promptfooconfig.yaml"
    - "evals/labels.example.json"
  modified:
    - "package.json"
    - "package-lock.json"
    - ".gitignore"
decisions:
  - "Confirmed vitest [SUS] slopcheck flag as a false positive (official vitest-dev/vitest); installed with human approval"
  - "USD/SEK rate exposed as USD_SEK_RATE config constant in cost contract (assumption A1, not hardcoded in logic)"
  - "Osäker threshold encoded as 0.5 in sanity tests — Plan 03 must align BRF_SANITY_BANDS downgrade to land below it"
metrics:
  duration: ~6min
  completed: 2026-06-07
---

# Phase 2 Plan 01: BRF Test Harness + RED Deterministic-Core Tests Summary

Installed Vitest + Promptfoo and wrote five RED test files plus the eval-harness skeleton, encoding the deterministic scorer/sanity/cost/normalization spec test-first before any `src/lib/brf/` production code exists (Wave 0 Nyquist gap-closure).

## What Was Built

- **Test runner:** `vitest.config.ts` with `test.environment="node"`, `test.globals=true`, and the `@` alias resolved to `./src` via `path.resolve(__dirname, "./src")` so test imports resolve identically to production code. npm scripts added: `test` (`vitest run`), `test:watch` (`vitest`), `eval` (`RUN_LLM_EVALS=1 vitest run evals/extractor.eval.ts`).
- **RED deterministic-core tests:**
  - `score.test.ts` — grade determinism (same input → identical result + breakdown), strong→A/B and weak→D/E/F mapping, per-metric breakdown (key/value/rating/weight, weights sum to 1), null treated as `not_assessable` not silently good, `BRF_SCORE_THRESHOLDS` shared source of truth (D-07/D-08).
  - `sanity.test.ts` — out-of-band skuldPerKvm/avgiftsniva forced below the Osäker threshold regardless of model confidence, in-band high-confidence left unchanged, value never dropped (D-10/D-12), `BRF_SANITY_BANDS` exposed.
  - `cost.test.ts` — verified Haiku rates ($1/$5/$1.25/$0.10 per MTok), typical 80k/1k run < 5 SEK (~0.94), heavy scanned + retry < 5 SEK, reads `cache_creation_input_tokens`/`cache_read_input_tokens`, cached retry cheaper than cold run.
  - `schemas/brf.test.ts` — well-formed 4-field parse, FM2 invariant (walks schema shape, fails on any `/grade|score|rating|betyg/i` key), `normalizeBrfExtraction` produces a shape `computeBrfGrade` consumes without throwing, null-tolerant propagation.
  - `actions/analyze-brf.test.ts` — export-existence check for `analyzeBrf`/`correctBrfField` (currently RED) + `it.todo` markers for auth-gate/RLS/replace/content-hash/cost-cap (Plan 04 integration).
- **Eval harness skeleton:** `evals/promptfooconfig.yaml` (cost-gated stub referencing `src/lib/brf/prompt.ts` system prompt and a frozen fixture subset) and `evals/labels.example.json` (synthetic manifest documenting the content-hash-keyed label shape with `expectedOsaker`).
- **GDPR/PII gitignore (threat T-02-01 mitigated):** `evals/fixtures/`, `evals/labels.json`, and `coverage/` appended to `.gitignore`; verified via `git check-ignore` that only `labels.example.json` + `promptfooconfig.yaml` are tracked.

## Verification

- `npx vitest run` (no tests yet): "No test files found" — config resolves cleanly, no resolution error.
- Task 2 plan verify: `vitest runs` ✅
- Task 3 plan verify: `RED as expected` ✅ — all 5 test files fail with "Cannot find package '@/lib/...'" because the production modules do not exist yet. This is the correct Wave 0 state.

## TDD Gate Compliance

This is the RED phase of the phase-wide TDD cycle. The GREEN gate (production modules in `src/lib/brf/` + `src/lib/schemas/brf.ts` making these tests pass) is Plan 03's responsibility; the `analyze-brf` GREEN gate is Plan 04's. The `test(02-01): ...` commit (c4083c2) establishes the RED baseline.

## Deviations from Plan

### Resolved Checkpoint (not a deviation)

**Task 1 (blocking-human package-legitimacy gate)** was resolved out-of-band before this run: a prior session ran `slopcheck install vitest @vitest/coverage-v8 promptfoo`. `promptfoo` and `@vitest/coverage-v8` returned [OK]; `vitest` returned [SUS] ("suspiciously close to 'vite'"), a confirmed false positive — `vitest` is the official vitest-dev/vitest framework. The human explicitly approved the install. Installed all three with `npm install -D vitest @vitest/coverage-v8 promptfoo`. No package was substituted or renamed.

### Auto-fixed Issues

None — plan executed as written.

## Known Stubs

- `evals/promptfooconfig.yaml` is an intentional cost-gated stub (assertion returns `true`); it references `src/lib/brf/prompt.ts` which is created in Plan 04. Documented as not-run-in-CI per AI-SPEC §5. Will be wired to `evals/labels.json` in Plan 04. This is intentional and does not block this plan's goal (RED test scaffolds).
- `evals/labels.example.json` is intentionally synthetic example data (zero-hash keys); the real `evals/labels.json` is gitignored and human-sourced.

## Commits

- `e05a364` chore(02-01): install vitest + promptfoo, add test scripts and eval gitignore
- `c4083c2` test(02-01): add RED deterministic-core + contract tests and eval skeleton

## Self-Check: PASSED

All 8 created files verified present on disk; both commits (e05a364, c4083c2) verified in git log.
