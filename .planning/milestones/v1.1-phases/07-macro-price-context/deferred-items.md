# Deferred Items — Phase 7

Out-of-scope issues discovered during execution but NOT fixed (pre-existing,
unrelated to this plan's file list — Scope Boundary rule).

## From Plan 07-02

- **`evals/extractor.eval.ts:83`** — `'cases' is never reassigned. Use 'const' instead` (eslint `prefer-const` error). Pre-existing, introduced in `7c993fd feat(06-03): render 5 recovered fields with provenance + broker-fetch banner`. Not touched by 07-02.
- **`src/components/url-input.tsx:24`** — `'router' is assigned a value but never used` (eslint warning). Pre-existing, same commit as above.
- **`src/lib/market/sold-schema.ts:37,49`** — `dataPointSchema`/`soldPropertyRawSchema` unused-var warnings. Pre-existing, same commit as above.
