---
phase: 04-ai-report-delivery
plan: 04
subsystem: ai-report
tags: [server-action, ai-synthesis, cost-guard, idempotency, fingerprint, rprt-01]
requires:
  - "src/lib/report/synthesize.ts (synthesizeReport — one Sonnet call)"
  - "src/lib/report/flags.ts (computeFlags — deterministic)"
  - "src/lib/report/fact-sheet.ts (assembleFactSheet — stable-key)"
  - "src/lib/schemas/report.ts (reportSchema)"
  - "src/lib/brf/cost.ts (costSekSonnet, Sonnet rates)"
  - "src/lib/report/prompt.ts (REPORT_SYNTHESIS_PROMPT_VERSION)"
  - "supabase/migrations/004_report.sql (report_* columns)"
provides:
  - "generateReport(analysisId): login-gated manual-trigger report orchestrator (RPRT-01, D-07/D-08/D-09)"
affects:
  - "src/app/(app)/analysis/[id]/page.tsx (the page will call generateReport + read report_data/report_status — Plan 05/06)"
tech-stack:
  added: []
  patterns:
    - "Auth → ownership → in-flight lock → assemble → synthesize → cost-guard → fingerprint → persist (mirrors analyze-brf.ts)"
    - "Sonnet-rated cost cap (costSekSonnet) as a post-call persistence gate, not a pre-call spend cap"
    - "report_status='generating' in-flight lock short-circuits a concurrent run (no double-spend)"
    - "sha256(factSheet) report_data_fingerprint drives D-08 staleness"
key-files:
  created:
    - "src/actions/generate-report.ts"
    - "src/actions/generate-report.test.ts"
  modified: []
decisions:
  - "price_data reason 'source_unavailable' maps to 'thin' for the flag engine (FlagPriceInput has no source_unavailable; the price flag is suppressed either way)"
  - "report_data persists report+flags+softSignals+dataFingerprint+costSek+model+promptVersion (matches reportDataSchema read-guard exactly)"
  - "In-flight lock reads row.report_status from the same ownership SELECT — no extra round-trip"
metrics:
  duration: ~6min
  completed: 2026-06-26
  tasks: 1
  files: 2
---

# Phase 4 Plan 4: generateReport Server Action Summary

The login-gated `generateReport(analysisId)` server action wires Plans 01–03 together behind the manual "Generera AI-rapport" trigger: auth + ownership → in-flight lock → safeParse the four sources → deterministic flags + cited soft signals → stable-key fact sheet → one Sonnet synthesis call → Sonnet-rated 5 SEK cost cap → sha256 staleness fingerprint → single persist of report_data/status/cost/fingerprint/prompt-version. Mirrors `analyze-brf.ts` exactly and adds the double-spend guard on the priciest call.

## What Was Built

- **`src/actions/generate-report.ts`** — the controller. `"use server"` action mirroring `analyze-brf.ts`:
  1. Auth gate (D-09): `getUser()` → `{ ok:false, error:"Logga in för AI-rapport" }`, no guest path.
  2. Ownership (T-04-13): single SELECT of `report_status` + the four source columns; missing or `user_id` mismatch → "Analysen hittades inte."
  3. In-flight lock (T-04-14 / RESEARCH Pitfall 5): an already-`generating` row short-circuits; otherwise set `report_status='generating'` BEFORE the Sonnet call.
  4. Independent `safeParse` of listing/brf/price/area (null on failure — D-07, no fabricated flag).
  5. `computeFlags(...)` + soft signals lifted off the BRF extraction → `assembleFactSheet(...)`.
  6. One `synthesizeReport({ factSheet, analysisId })` call.
  7. Cost guard: `costSekSonnet(usage)` (Sonnet $3/$15 — T-04-16); `> 5 SEK` → `writeFailedStatus` + abort, no persist.
  8. `reportSchema.parse` validate-on-write.
  9. `createHash("sha256").update(factSheet).digest("hex")` fingerprint (D-08).
  10. Single `.update(...)` persisting `report_data` (matching `reportDataSchema`), `report_status:"done"`, `report_cost_sek`, `report_data_fingerprint`, `report_prompt_version`.
  Coded synthesis errors → `writeFailedStatus` + a Swedish action-layer message; logs only `{ analysisId, code }`.

- **`src/actions/generate-report.test.ts`** — deterministic test (no live key): mocks `@/lib/supabase/server` (chainable fake) and `@/lib/report/synthesize`; the pure flag/fact-sheet primitives run for real. 11 tests covering login gate, IDOR (mismatch + missing row), status flow (generating-first/done-after), in-flight short-circuit, failed-on-throw, Sonnet cost cap abort-without-persist, partial-data assembly (`ej_tillgänglig` in the fact sheet), sha256 fingerprint persist, and persist-failure.

## How It Was Verified

- `npx vitest run src/actions/generate-report.test.ts` → 11 passed.
- `npx tsc --noEmit` → exit 0.
- Acceptance greps: `Logga in för AI-rapport`=1, `generating`≥1, `costSekSonnet`≥1 (Haiku `costSek` never imported/called), `createHash|report_data_fingerprint`=3, console lines carry only `{ analysisId, code }`.
- TDD gates in git log: `test(04-04)` (RED, 3c6c83f) before `feat(04-04)` (GREEN, c6df615).

## Deviations from Plan

None — plan executed as written. One implementation choice worth noting (not a deviation): `price_data.reason === "source_unavailable"` is not part of `FlagPriceInput.reason`, so it is mapped to `"thin"` before `computeFlags`. The price flag only fires on `reason === "ok"`, so both states correctly suppress the flag; this keeps the type contract satisfied without widening the flag engine.

## Known Stubs

None. The action fully wires the four sources, synthesis, cost guard, fingerprint, and persist. (The analysis page that calls `generateReport` and renders `report_data` is Plan 05/06 scope, per the phase boundary.)

## TDD Gate Compliance

RED gate (`test(04-04)`, 3c6c83f) committed with a failing import; GREEN gate (`feat(04-04)`, c6df615) makes all 11 tests pass. No unexpected pass during RED. No refactor commit needed.

## Self-Check: PASSED

- FOUND: src/actions/generate-report.ts
- FOUND: src/actions/generate-report.test.ts
- FOUND commit: 3c6c83f (RED test)
- FOUND commit: c6df615 (GREEN implementation)
