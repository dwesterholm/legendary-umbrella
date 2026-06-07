---
phase: 02-brf-financial-analysis
plan: 04
subsystem: brf-extraction-and-action
tags: [anthropic, haiku-4-5, server-action, citations, prompt-caching, d-05, d-06, d-08, d-13, files-api]
requires:
  - "@anthropic-ai/sdk@^0.102.0 (Phase 1)"
  - "brfExtractionSchema + normalizeBrfExtraction (Plan 03)"
  - "computeBrfGrade + applySanityChecks + costSek (Plan 03)"
  - "migration 002_brf.sql on LIVE Supabase: brf_* columns, brf-pdfs bucket, UPDATE RLS (Plan 02)"
  - "RED analyze-brf contract test (Plan 01)"
provides:
  - "BRF_EXTRACTION_SYSTEM_PROMPT + BRF_EXTRACTION_PROMPT_VERSION (src/lib/brf/prompt.ts)"
  - "extractBrfFinancials — the single Haiku call with citations + caching (src/lib/brf/extract.ts)"
  - "uploadBrfPdf / downloadBrfPdf / brfPdfPath / BRF_BUCKET (src/lib/supabase/storage.ts)"
  - "analyzeBrf + correctBrfField + AnalyzeBrfResult + BrfData (src/actions/analyze-brf.ts)"
affects:
  - "Plan 05 (UI consumes AnalyzeBrfResult/BrfData, polls brf_status, renders citations + Osäker badges, calls correctBrfField)"
  - "Plan 06 (eval harness wires src/lib/brf/prompt.ts into promptfoo)"
tech-stack:
  added: []
  patterns:
    - "module-scope Anthropic client reading server-only ANTHROPIC_API_KEY (never browser-enabled) — mirrors booli-scraper"
    - "messages.parse + zodOutputFormat structured output; document block with citations.enabled + cache_control ephemeral"
    - "base64-inline transport <=5 MB, Files API (beta files-api-2025-04-14) for larger/scanned PDFs"
    - "server action spine: hard auth gate -> validate -> store -> status writes via .update().eq(id) -> deterministic pipeline -> persist (no redirect, D-04)"
    - "content-hash (sha256) skip-Claude cache for identical re-upload (D-06)"
key-files:
  created:
    - "src/lib/brf/prompt.ts"
    - "src/lib/brf/extract.ts"
    - "src/lib/supabase/storage.ts"
    - "src/actions/analyze-brf.ts"
  modified:
    - "next.config.ts"
    - ".env.local.example"
    - "src/lib/schemas/brf.ts"
    - "src/lib/brf/score.ts"
decisions:
  - "Used client.beta.messages.parse uniformly so the Files API file-source path and base64 path share one parse call; the files-api beta header is added only when the PDF exceeds ~5 MB"
  - "Model pinned to dated id claude-haiku-4-5-20251001 (reproducible) rather than the floating alias"
  - "Honored project gitignore convention: documented env vars in .env.local.example (the existing !.env.local.example negation) rather than .env.example, which is gitignored"
  - "Cost-cap guardrail marks brf_status=failed and refuses to persist a result when costSek > 5 SEK rather than silently billing (AI-SPEC §6)"
metrics:
  duration: ~12min
  completed: 2026-06-07
---

# Phase 2 Plan 04: BRF Extraction Layer + analyzeBrf Server Action Summary

Built the project's first Claude integration — a single Haiku 4.5 extraction call with citations and prompt caching — plus the `analyzeBrf`/`correctBrfField` server actions that wire auth-gating, private PDF storage, content-hash caching, the deterministic scoring pipeline, and status/cost persistence into one spine. All code type-checks and the full vitest suite is green; one real end-to-end extraction remains gated behind a human-provided `ANTHROPIC_API_KEY` (Task 3 checkpoint).

## What Was Built

- **`src/lib/brf/prompt.ts`** — `BRF_EXTRACTION_SYSTEM_PROMPT` (Swedish) plus `BRF_EXTRACTION_PROMPT_VERSION` (`brf-extract/v1`). Encodes the hard "extract numbers ONLY, never grade" rule (D-08), null-not-guess, confidence calibration down for scanned/ambiguous/inferred figures (D-10), and inline few-shots disambiguating the denominator/unit traps (räntebärande skuld ÷ upplåten bostadsrättsyta; monthly→annual avgift × 12).
- **`src/lib/brf/extract.ts`** — `extractBrfFinancials({ bytes, contentHash })`: module-scope `new Anthropic()` (server-only, never browser-enabled), one `client.beta.messages.parse` call on `claude-haiku-4-5-20251001` with `zodOutputFormat(brfExtractionSchema)`, a document block carrying `citations: { enabled: true }` (D-11) and `cache_control: { type: "ephemeral" }` (D-13 cost). Transport: base64-inline ≤5 MB, Files API (`toFile` → `beta.files.upload` → file-source, `betas: ["files-api-2025-04-14"]`) above. `stop_reason === "refusal"` throws with no retry; `"max_tokens"` retries once then throws. Returns `{ parsed, usage, citations }`, mapping page-location citations to `{ sourceQuote, pageRef }`. The catch logs ONLY `{ contentHash, error }` — never bytes/financials/quotes (T-02-12/GDPR) — then throws a Swedish user message.
- **`src/lib/supabase/storage.ts`** — `uploadBrfPdf`/`downloadBrfPdf` over the private `brf-pdfs` bucket using the single `{userId}/{analysisId}.pdf` path convention (`brfPdfPath`) that matches the storage RLS prefix; `upsert: true` implements D-06 replace. Reuses the request-scoped server client (typed as the awaited `createClient`).
- **`src/actions/analyze-brf.ts`** — `analyzeBrf(formData)`: validates `analysisId`+`file`, rejects non-PDF and >20 MB server-side (T-02-11/D-14), hard auth gate returning "Logga in för BRF-analys" (D-05 — no guest path), ownership check on the row (RLS second layer), sha256 content hash + scanned heuristic (D-14), D-06 skip-Claude when hash matches and `brf_data` exists, upload, `brf_status` reading→extracting→scoring→done via `.update().eq("id", ...)` (D-13), the single extract call, cost-cap guardrail (`costSek > 5` ⇒ status `failed`, refuse to persist), schema re-validation gate, `applySanityChecks` → `computeBrfGrade` (D-08), persist `brf_data`/`brf_cost_sek`/`brf_pdf_hash`/`brf_scanned`, no redirect (D-04). `correctBrfField(formData)`: auth-gated D-12 inline correction that overrides one field (number or underhållsplan enum) at confidence 1, marks it in `manualFields` ("Manuellt angiven"), re-runs ONLY normalize→sanity→`computeBrfGrade` and `.update()`s `brf_data` — it never calls `extractBrfFinancials` (no re-bill).
- **`next.config.ts`** — added `@anthropic-ai/sdk` to `serverExternalPackages` (apify-client precedent), keeping the SDK out of the client bundle.
- **`.env.local.example`** — documents `ANTHROPIC_API_KEY=` (server-only, no `NEXT_PUBLIC_`) alongside the existing Supabase + Apify vars.

## Threat Model Coverage

- **T-02-09 (API key disclosure):** Anthropic client lives only in server `extract.ts`; never browser-enabled; key read from server-only env; `@anthropic-ai/sdk` is a server-external package. (Live no-leak confirmation is the Task 3 smoke test.)
- **T-02-10 (privilege escalation):** hard auth gate + per-row ownership check + the Plan 02 UPDATE RLS policy.
- **T-02-11 (DoS/tampering via upload):** `application/pdf` MIME + ≤20 MB size validated before any storage/Claude work; Files API for large scans avoids the request-size cap.
- **T-02-12 (PII in logs):** only content hash + token usage are logged; never bytes/financials/quotes.
- **T-02-13 (Claude budget):** `cache_control` on the document block + bounded retries + per-analysis 5 SEK hard cap + login gate + content-hash skip on identical re-upload.
- **T-02-14 (model-produced grade):** extraction schema has no grade field; the action computes the grade only via `computeBrfGrade` (D-08).

## Verification

- `npx tsc --noEmit` — clean (0 errors).
- `npx vitest run` — 5 files, 31 passed + 6 todo. `src/actions/analyze-brf.test.ts` export-existence tests for `analyzeBrf`/`correctBrfField` are GREEN (previously RED on missing import).
- Task 1 gate: `extract.ts` uses `messages.parse` + `cache_control`, never `dangerouslyAllowBrowser`; prompt exports the const with the extract-only rule; `.env.local.example` has `ANTHROPIC_API_KEY=` with no `NEXT_PUBLIC_` prefix.
- Task 2 gate: auth "Logga in" present, `computeBrfGrade` present, `correctBrfField` contains no `extractBrfFinancials` call, no `redirect()`.

## TDD Gate Compliance

This plan completes the `analyze-brf` GREEN gate begun by Plan 01's RED contract test. The two export-existence tests now pass without modifying the test file. The 6 `it.todo` markers (auth-gate, RLS, D-06 replace, content-hash skip, correctBrfField no-re-extract, cost-cap) remain todo: promoting them to live integration tests requires mocking both the Supabase client and the Anthropic client (or a live key), which the plan scopes to the eval/integration follow-up rather than this wiring plan. The behaviors themselves are implemented and covered by the grep/type gates above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed pre-existing tsc errors in `score.ts` that blocked the verify gate**
- **Found during:** Task 1 (`npx tsc --noEmit` is the acceptance gate).
- **Issue:** `src/lib/brf/score.ts` failed to compile on HEAD — `UnderhallsplanStatus` is `enum | null`, which cannot be a `Record` key (TS2344/TS2538). The plan's `npx tsc --noEmit` acceptance criterion could not pass with these present, and `score.ts` is on the exact code path the action consumes.
- **Fix:** Added `UnderhallsplanValue = NonNullable<UnderhallsplanStatus>` to `src/lib/schemas/brf.ts` and used it for the `scores` Record key and `scoreUnderhall`'s parameter (the call site is already null-guarded).
- **Files modified:** `src/lib/schemas/brf.ts`, `src/lib/brf/score.ts`
- **Commit:** 496e698

### Convention adjustments

**2. [Rule 3 - Blocking] `.env.local.example` instead of `.env.example`**
- The plan/acceptance says append to `.env.example`, but `.gitignore` ignores `.env*` and negates only `!.env.local.example`. A literal `.env.example` is uncommittable. Created `.env.local.example` (the project's existing convention; also what the Task 3 smoke test references as `.env.local`) with the new `ANTHROPIC_API_KEY=` plus the previously-undocumented Supabase/Apify vars. No real secret committed — placeholders only.
- **Commit:** 496e698

## Deferred / Out-of-scope

- The 6 `it.todo` integration tests in `analyze-brf.test.ts` are left as todo (need Supabase + Anthropic mocking or a live key). Not regressions — they were todo in the RED baseline.

## Known Stubs

None. All four modules are fully implemented. No hardcoded empty values, placeholders, or unwired data sources. The only unexecuted path is the live Claude call, which is correctly gated behind the missing `ANTHROPIC_API_KEY` (Task 3 checkpoint) rather than stubbed.

## Checkpoint Pending (Task 3)

Task 3 is a `gate="blocking-human"` checkpoint: provisioning a real `ANTHROPIC_API_KEY` and running one real PDF extraction end-to-end (brf_status='done', cost < 5 SEK, no key leak). This cannot be automated and is NOT auto-approved (package/credential blocking gate). The code is complete and type-checks; the live smoke test awaits the user-supplied key. See the checkpoint message returned to the orchestrator.

## Self-Check: PASSED

- src/lib/brf/prompt.ts — FOUND
- src/lib/brf/extract.ts — FOUND
- src/lib/supabase/storage.ts — FOUND
- src/actions/analyze-brf.ts — FOUND
- .env.local.example — FOUND
- Commit 496e698 — FOUND
- Commit 5f4c6ba — FOUND

## Commits

- `496e698` feat(02-04): add BRF extraction layer — versioned prompt + single Haiku call
- `5f4c6ba` feat(02-04): add storage helper + analyzeBrf/correctBrfField server actions
