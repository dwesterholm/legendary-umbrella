---
status: testing
phase: 04-ai-report-delivery
source: [04-VERIFICATION.md]
started: 2026-06-26
updated: 2026-06-26
---

## Current Test

number: 1
name: Live synthesis quality — generate a report on an owned analysis
expected: |
  On an owned analysis with listing + BRF + price + area data, clicking
  "Generera AI-rapport" produces a lead synthesis that anchors the page and
  cross-references all four sources; every claim cites a specific data point
  (sourceRef); there is NO buy/sell verdict and NO "rätt pris är X" valuation.
awaiting: user response

## Tests

### 1. Live synthesis quality
expected: Lead synthesis anchors the analysis page (D-00/D-05), synthesizes listing/BRF/price/area into an opinionated assessment, every claim cites a specific data point (D-06), no buy/sell verdict (D-04). Requires a live ANTHROPIC_API_KEY.
result: [pending]

### 2. PDF visual quality (Swedish glyphs)
expected: "Ladda ner PDF" downloads an application/pdf; å/ä/ö/Å/Ä/Ö render correctly (no tofu boxes); section order mirrors the on-screen report (D-11); the "ej finansiell rådgivning" disclaimer + source/freshness labels are present (D-12).
result: [pending]

### 3. Stale / regenerate flow (D-08)
expected: After changing a BRF/price/area input and reloading, the "Rapporten bygger på äldre data — uppdatera" marker + a manual regenerate trigger appear; the report never silently auto-refires.
result: [pending]

### 4. Guest gate (D-09)
expected: Logged out, opening an analysis URL shows the "Logga in för AI-rapport" teaser only — the report content and the Generera/PDF actions are not exposed.
result: [pending]

### 5. Partial-data honesty (D-07/FM4)
expected: Generating a report on an analysis missing a source (e.g. no BRF data) renders that section honestly as "Ej tillgänglig" with nothing fabricated; flags for the missing source are suppressed, not invented.
result: [pending]

### 6. Live brf-extract/v2 extraction eval (DEFERRED — not a completion blocker)
expected: Once a labeled reference dataset exists (evals/fixtures/*.pdf + evals/labels.json per labels.example.json), `RUN_LLM_EVALS=1 ANTHROPIC_API_KEY=<key> npm run eval` is green — the four original BRF metrics do not regress against v2 and the three D-02 soft signals extract with supporting citations. Harness is committed (evals/extractor.eval.ts); building the dataset is tracked eval-infrastructure work (STATE.md Pending Todos). Explicitly deferred by operator decision — does not gate phase completion.
result: [deferred]

## Summary

total: 5
passed: 0
issues: 0
pending: 5
skipped: 0
blocked: 0

(Item 6 is a tracked deferral, excluded from the gating count.)

## Gaps
