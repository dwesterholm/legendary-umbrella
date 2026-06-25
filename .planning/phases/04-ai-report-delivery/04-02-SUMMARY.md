---
phase: 04-ai-report-delivery
plan: 02
subsystem: brf-extraction
tags: [schema, prompt, soft-signals, eval, cross-phase]
status: paused-at-checkpoint
requires:
  - "src/lib/schemas/brf.ts extractedField factory (Phase 2)"
  - "src/lib/brf/prompt.ts BRF_EXTRACTION_SYSTEM_PROMPT (Phase 2)"
provides:
  - "brfExtractionSchema.stambytePlanerat | storreRenoveringar | ovrigaAnmarkningar (cited soft signals, D-02)"
  - "normalizeBrfExtraction carries the three soft signals (Plan 01 flag + Plan 03 narration)"
  - "BRF_EXTRACTION_PROMPT_VERSION = brf-extract/v2"
affects:
  - "Plan 04-01 computeFlags (consumes stambytePlanerat enum)"
  - "Plan 04-03 synthesis (consumes storreRenoveringar/ovrigaAnmarkningar free-text)"
tech-stack:
  added: []
  patterns:
    - "Soft signals reuse the existing extractedField factory — same {value,confidence,sourceQuote,pageRef} cited (D-11) + confidence (D-10) pipeline"
    - "Prompt-version bump + eval re-run discipline (cross-phase schema change)"
key-files:
  created: []
  modified:
    - "src/lib/schemas/brf.ts"
    - "src/lib/schemas/brf.test.ts"
    - "src/lib/brf/prompt.ts"
    - "evals/promptfooconfig.yaml"
    - "evals/labels.example.json"
decisions:
  - "Soft-signal fields are OPTIONAL on the NormalizedBrf TYPE (scorer reads only the 4 metrics); normalizeBrfExtraction always populates them so the persist/read path carries them while pre-D-02 score fixtures stay valid"
  - "extract.ts max_tokens left at 2048 — no live truncation observed; pre-emptive bump avoided per plan; live confirmation deferred to the Task 3 human-gated eval"
metrics:
  duration: ~4min
  tasks_completed: 2
  tasks_total: 3
  completed: 2026-06-25
---

# Phase 4 Plan 02: BRF Extraction Soft Signals (D-02) Summary

Extended the Phase 2 Haiku BRF extraction with three structured, cited soft signals (planned/recent stambyte, larger renovations, notable remarks) riding the existing `extractedField` cited+confidence pipeline, and bumped the extraction prompt to `brf-extract/v2`. **PAUSED at the Task 3 blocking checkpoint** (cross-phase extraction eval re-run) — a human gate that this executor does not self-resolve.

## What Was Built

### Task 1 — Extend brfExtractionSchema with three cited soft-signal fields (commit `f0198b6`)
- Added `stambytePlanerat` (enum `planerat | nyligen_genomfort | ej_nämnt`), `storreRenoveringar` (text), `ovrigaAnmarkningar` (text) to `brfExtractionSchema`, each via the existing `extractedField(...)` factory → each gets `{value, confidence, sourceQuote, pageRef}` for free (same cited D-11 / confidence D-10 pipeline as the four metrics). `value` stays `.nullable()`, never `.optional()`.
- Carried the soft signals through `brfDataSchema.normalized` and `normalizeBrfExtraction` so the persist/read path stays validated.
- Added a new `describe("soft signals (D-02)")` block in `src/lib/schemas/brf.test.ts` (TDD: RED → GREEN). Tests cover: full parse with citations, enum rejection of out-of-enum values, all enum members accepted, nullable values, required key presence (omitting a key fails — structured outputs force every key), and normalize carry-through.
- New exported type `StambyteStatus`.

### Task 2 — Bump prompt version + soft-signal instructions + eval labels (commit `b1ec075`)
- `BRF_EXTRACTION_PROMPT_VERSION`: `brf-extract/v1 (2026-06-07)` → `brf-extract/v2 (2026-06-25)` (bumped exactly once).
- Appended soft-signal extraction rules to `BRF_EXTRACTION_SYSTEM_PROMPT` in the same hard-rule + citation style: extract stambyte status, larger renovations (tak/fasad/hiss/fönster), and övriga anmärkningar — EACH with a verbatim `sourceQuote` + `pageRef`, using `"ej_nämnt"`/null when the document does not state it (never invent — FM5/D-11/T-04-05). Added worked few-shot examples for the soft signals.
- Extended `evals/promptfooconfig.yaml` + `evals/labels.example.json` with soft-signal expectations (`expectedStambyte`, `expectedStorreRenovering`, `expectedAnmarkning`) — extended the existing extractor eval set, did NOT create a new eval file (per RESEARCH).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Soft-signal fields broke pre-D-02 `score.test.ts` fixtures**
- **Found during:** Task 1 (after extending `NormalizedBrf`).
- **Issue:** Adding required `stambytePlanerat`/`storreRenoveringar`/`ovrigaAnmarkningar` to the `NormalizedBrf` interface made the three `score.test.ts` fixtures (which predate D-02 and only set the four metrics) fail `tsc --noEmit` with TS2739.
- **Fix:** Marked the three soft-signal fields **optional** (`?`) on the `NormalizedBrf` TYPE. The deterministic scorer (`computeBrfGrade`) consumes ONLY the four metrics, and `normalizeBrfExtraction` always populates the soft fields with real values — so the persist/read path still carries them, the plan's normalize-carry-through test still passes (the function sets them), and the pre-D-02 score fixtures stay valid without edits. Minimal blast radius vs. editing unrelated fixtures.
- **Files modified:** `src/lib/schemas/brf.ts`
- **Commit:** `f0198b6`

### Plan-anticipated note (not a deviation)

- **`extract.ts max_tokens` left unchanged at 2048.** The plan instructs confirming sufficiency and raising ONLY if a real truncation (`stop_reason: "max_tokens"`) is observed — never pre-emptively. No live extraction runs in Tasks 1–2 (the live run is the Task 3 human gate), so no truncation was observed and `extract.ts` was not modified. Live confirmation is part of the Task 3 eval.

## TDD Gate Compliance

- Task 1 was `tdd="true"`: tests written first and confirmed RED (4 soft-signal assertions failing — `undefined`/`true` mismatches), then GREEN after implementing the schema/normalize fields (12/12 pass). Committed as a single `feat` (test + impl together) because the schema extension is the smallest meaningful unit; the RED state is documented above and in the commit body.

## Checkpoint Reached (Task 3 — blocking human gate)

Task 3 is `checkpoint:human-verify gate="blocking"` (cross-phase extraction eval re-run). Auto-advance is OFF, so execution STOPPED here and the gate was NOT self-resolved. State surfaced to the operator:

- `npm run test` (deterministic, no spend): **GREEN — 140 passed | 6 todo (146)**.
- `ANTHROPIC_API_KEY`: a key line IS present in `.env.local` (operator should confirm it is a live key — relates to the STATE blocker "02-04 Task 3").
- `npx promptfoo eval -c evals/promptfooconfig.yaml`: NOT run here (requires `RUN_LLM_EVALS`/live key + the gitignored `evals/labels.json` + `evals/fixtures/*.pdf`; the committed config is still a stub with placeholder assertions extended for the soft signals).
- **HARNESS GAP (anticipated by the checkpoint):** `npm run eval` → `RUN_LLM_EVALS=1 vitest run evals/extractor.eval.ts`, but **`evals/extractor.eval.ts` is NOT committed in the repo**. The full Phase 2 extraction eval harness file is absent. Before approval, either the executor must scaffold `evals/extractor.eval.ts` (wiring `promptfooconfig.yaml` + `labels.json` against the fixtures) or the operator must locate it.

**Awaiting from the human:** re-run the Phase 2 extraction eval against `brf-extract/v2` (confirm the four original metrics do NOT regress AND the three new soft signals extract with supporting citations), OR resolve the missing-harness gap and agree a scaffold path. Resume signal: type "approved", or describe the regression/blocker.

## Known Stubs

- `evals/promptfooconfig.yaml` remains a cost-gated stub with placeholder `value: "true"` assertions (existing Phase 2 posture). The soft-signal test rows were added but carry the same stub assertion pending the real harness wiring (`evals/extractor.eval.ts`) — resolved as part of the Task 3 checkpoint / a future eval-wiring step. This is the pre-existing eval-stub posture, not new stub debt introduced for the report goal.

## Threat Flags

None. No new network endpoints, auth paths, or trust-boundary surface introduced beyond the threat register already in the plan (`T-04-05`/`T-04-06`/`T-04-07`). The soft-signal citation requirement in the system prompt directly mitigates `T-04-05` (invented stambyte/renovation).

## Self-Check: PASSED

All modified files exist on disk and both per-task commits (`f0198b6`, `b1ec075`) are present in git history.
