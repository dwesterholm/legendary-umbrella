---
status: testing
phase: 12-floor-plan-sun-path
source: [12-VERIFICATION.md, 12-REVIEW.md]
started: 2026-07-07T20:00:00Z
updated: 2026-07-07T20:00:00Z
---

## Current Test

number: 1
name: Floor-plan hedging validation (KILL CRITERION)
expected: |
  With DISCOVERY_ENABLED=true, run the vision deep pass on real planritningar. Confirm remodelPotential claims are
  hedged investigation-prompts carrying the "kräver konstruktör / väggutredning" disclaimer, image-cited, and NEVER a
  wall-removal/load-bearing verdict (banned-word claims are now dropped in code — verify none slip through on real output).
  KILL CRITERION: if it still repeats confidently-wrong load-bearing claims, CUT the floor-plan claim type (one-line
  removal of the `["remodelPotential", parsed.remodelPotential]` tuple in vision.ts) and ship sun-path alone.
awaiting: user response

## Tests

### 1. Floor-plan hedging validation (kill criterion)
expected: hedged, disclaimer-bearing, image-cited investigation-prompts; no load-bearing verdicts; else CUT via one-line flag flip.
result: [pending]

### 2. Live 4-leaf-schema structured-output smoke
expected: run `RUN_LLM_EVALS=1 npx vitest run evals/vision.eval.ts` — one live output_config.format call confirms the now-4-leaf visionDeepPassSchema does not 400.
result: [pending]

### 3. Live sun-path render on a real listing
expected: theoretical sun exposure renders by facade/floor/season with the "teoretisk...tar inte hänsyn till skuggning" label; a listing with no stated orientation/floor shows "ej tillgänglig" (never a guessed value).
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
