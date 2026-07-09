# Deferred Items — Phase 09

## From Plan 09-03

- **`evals/extractor.eval.ts:83` — `prefer-const` eslint error** (`let cases: Case[] = []` should be `const`). Pre-existing from phase 08-01 (`9ada702`), unrelated to this plan's scope (parseIntent/runSlice/startDiscovery/tickDiscovery). Not fixed here per the scope-boundary rule (only auto-fix issues directly caused by the current task's changes). Trivial one-line fix for a future cleanup pass.
