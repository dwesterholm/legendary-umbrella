---
phase: 04-ai-report-delivery
plan: 02
subsystem: brf-extraction
tags: [schema, prompt, soft-signals, eval, cross-phase]
status: code-complete-eval-deferred
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
  - "Task 3 live v2 extraction eval DEFERRED (not failed): the labeled reference dataset (evals/fixtures/*.pdf + evals/labels.json) does not exist yet; building it is separate eval-infrastructure work. Harness is committed and green; downstream Plan 04-03 depends only on the committed schema/prompt, not the eval run. Naturally revisited at the 04-06 end-to-end human-verify checkpoint."
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

## Task 3 — Live v2 Extraction Eval: DEFERRED (not failed, not silently skipped)

**Resolution:** the plan is CODE-COMPLETE. Tasks 1–2 (schema + prompt-v2) and the eval harness (Task 3 scaffold) are committed and green. The Task 3 *live* extraction eval re-run is **DEFERRED** because the labeled reference dataset it requires (`evals/fixtures/*.pdf` + `evals/labels.json`) does not exist yet — building a frozen, expert-labeled subset of 4–6 årsredovisningar is separate eval-infrastructure work. Downstream Plan 04-03 depends only on the committed schema/prompt, not on the eval run, so it is unblocked.

### Deferred / Follow-up

- **Build the labeled BRF extraction eval dataset** — 4–6 diverse årsredovisningar under `evals/fixtures/*.pdf` (gitignored, PII/GDPR) + `evals/labels.json` (gitignored) keyed by each PDF's SHA-256, following `evals/labels.example.json` (includes the new `expectedStambyte` / `expectedStorreRenovering` / `expectedAnmarkning` keys).
- **Then run the `brf-extract/v2` regression eval** — the harness is ready at `evals/extractor.eval.ts`:
  ```
  RUN_LLM_EVALS=1 ANTHROPIC_API_KEY=<live-key> npm run eval
  ```
  Green = all assertions pass: the four metrics within tolerance vs labels (no regression), each D-02 soft signal matches its label, and every surfaced (non-`ej_nämnt`, non-null) soft signal carries a `sourceQuote` + `pageRef`.
- This will **naturally be revisited at the Plan 04-06 end-to-end human-verify checkpoint** (which likewise needs a live key + the applied migration). Tracked in STATE.md "Pending Todos" so it persists across sessions.

### Pre-deferral state surfaced to the operator

- `npm run test` (deterministic, no spend): **GREEN — 140 passed | 6 todo (146)**.
- `ANTHROPIC_API_KEY`: a key line IS present in `.env.local` (operator should confirm it is a live key — relates to the STATE blocker "02-04 Task 3").
- `npx promptfoo eval -c evals/promptfooconfig.yaml`: NOT run here (requires `RUN_LLM_EVALS`/live key + the gitignored `evals/labels.json` + `evals/fixtures/*.pdf`; the committed config is still a stub with placeholder assertions extended for the soft signals).
- **HARNESS GAP — NOW SCAFFOLDED (commit `0f8a20f`):** the `npm run eval` target `evals/extractor.eval.ts` was missing. It has been created: it calls the real `extractBrfFinancials` (the shipping `brf-extract/v2` path) over `evals/fixtures/*.pdf`, with labels keyed by SHA-256 content hash from the gitignored `evals/labels.json` (shape = `labels.example.json`). It asserts (a) the four metrics do NOT regress vs labels (2% tolerance / null-exact) and (b) the three D-02 soft signals extract as labelled AND each non-null soft signal carries a `sourceQuote` + `pageRef` (T-04-05 invented-signal guard; `ej_nämnt` needs no citation). The live body is gated behind `RUN_LLM_EVALS=1` AND a present `ANTHROPIC_API_KEY` → it skips with no spend otherwise. `vitest.config.ts` `include` was extended to match `evals/**/*.eval.ts` so the explicit path resolves; this adds one self-skipping test to `npm run test` (140 passed | 1 skipped | 6 todo, still green) and `npx tsc --noEmit` stays clean.
- **STILL A HUMAN GATE:** the harness is scaffolded but the actual live eval re-run has NOT been performed (no spend was incurred). The operator must run it and confirm green. Required inputs that are gitignored and not yet present in the working tree: `evals/fixtures/*.pdf` (the frozen reference årsredovisningar) and `evals/labels.json` (expert labels keyed by each PDF's SHA-256, including the new `expectedStambyte`/`expectedStorreRenovering`/`expectedAnmarkning` keys).

**Awaiting from the human:** populate `evals/fixtures/*.pdf` + `evals/labels.json`, then run the live eval against `brf-extract/v2` and confirm the four original metrics do NOT regress AND the three new soft signals extract with supporting citations. Exact command:

```
RUN_LLM_EVALS=1 ANTHROPIC_API_KEY=<live-key> npm run eval
```

Green result = all assertions pass (no `expect` failures): every labelled fixture extracts its four metrics within tolerance, each soft signal matches its label, and every surfaced (non-`ej_nämnt`, non-null) soft signal has a `sourceQuote` + `pageRef`. Resume signal: type "approved" once the live eval is green, or describe the regression/blocker. Task 3 remains OPEN; the plan is NOT finalized.

## Known Stubs

- `evals/promptfooconfig.yaml` remains a cost-gated stub with placeholder `value: "true"` assertions (existing Phase 2 posture). The soft-signal test rows were added but carry the same stub assertion. The REAL regression assertions now live in the committed `evals/extractor.eval.ts` (commit `0f8a20f`) which exercises the shipping `extractBrfFinancials` path directly; the promptfoo config stays a thin parallel skeleton. The remaining "stub" is data, not code: `evals/fixtures/*.pdf` + `evals/labels.json` are gitignored (PII/GDPR) and must be populated by the operator before the live eval (Task 3) can run.

## Threat Flags

None. No new network endpoints, auth paths, or trust-boundary surface introduced beyond the threat register already in the plan (`T-04-05`/`T-04-06`/`T-04-07`). The soft-signal citation requirement in the system prompt directly mitigates `T-04-05` (invented stambyte/renovation).

## Self-Check: PASSED

All modified files exist on disk and both per-task commits (`f0198b6`, `b1ec075`) are present in git history.
