# Deferred Items — Phase 14 (holistic-analysis-brain)

Out-of-scope discoveries logged per the executor's SCOPE BOUNDARY rule (not fixed,
not part of any plan's acceptance criteria).

## 14-03: Pre-existing flaky timing-sensitive tests under full-suite parallel load

- **Found during:** Task 3 verification (`npm run test`, full suite)
- **Symptom:** `src/lib/brf-source/allabrf.test.ts`'s "enforces the size cap — an
  oversized body is bounded, not fully buffered" test (a 9 MB fixture body,
  `testTimeout` 5000ms) intermittently times out ONLY under the full-suite
  parallel run; passes reliably in isolation (`npx vitest run
  src/lib/brf-source/allabrf.test.ts` — 15/15 green, ~3s). A second run of the
  full suite surfaced a different pre-existing timing-assertion test failing
  instead (`elapsed).toBeLessThan(110)` in a concurrency test unrelated to this
  plan), confirming this is sandbox-load-dependent flakiness, not a regression
  from plan 14-03's changes.
- **Scope:** Neither failing test is in this plan's `files_modified`
  (`org-nr-resolver.ts`, `org-nr-resolver.test.ts`, `fetch-brf-auto.ts`,
  `brf-lookup.ts`, `brf-lookup.test.ts`). Pre-existing, unrelated to the
  genitive-kommun fix or the new BRF lookup orchestrator.
- **Action:** Not fixed (out of scope per the executor's SCOPE BOUNDARY rule).
  `npx tsc --noEmit` and `npm run lint` are clean; every test file this plan's
  `<verification>` block names individually (org-nr-resolver.test.ts,
  brf-lookup.test.ts, allabrf.test.ts in isolation, niche-score.test.ts) passes
  green. Recorded here for a future phase/operator to consider raising the
  `testTimeout` on CPU/IO-heavy fixtures or reducing parallel worker count in
  CI if this recurs.
