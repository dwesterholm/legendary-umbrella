---
phase: 08-brf-auto-fetch
plan: 01
subsystem: api
tags: [brf, extraction, refactor, cheerio, anthropic, supabase, migration]

requires:
  - phase: 04-brf-analysis
    provides: the original analyzeBrf action (D-06 hash cache, cost-cap, sanity, A–F scoring pipeline) that this plan extracts into a shared core
provides:
  - "runBrfExtraction(analysisId, userId, source, fetchSource) — shared BRF extraction/scoring spine consumed by both the manual-upload path (this plan) and the auto-fetch path (Plans 02–04)"
  - "BrfDocumentSource discriminated union ({kind:'pdf'} | {kind:'ixbrl-text'})"
  - "ixbrlToPlainText — cheerio-based iXBRL/HTML → plain text stripper, never throws"
  - "extractBrfFinancials accepting a discriminated ExtractBrfInput union, with a text/plain document-block branch for iXBRL text (zero schema change)"
  - "brf_fetch_source column (migration 009), pushed live"
affects: [08-02-auto-document-source, 08-03-fetch-brf-auto-action, 08-04-confirmation-ui]

tech-stack:
  added: []
  patterns:
    - "Shared extraction core behind a discriminated source union — analyzeBrf and the future auto-fetch action both call runBrfExtraction, never duplicating the D-06 cache/cost-cap/scoring pipeline"
    - "iXBRL-to-text via cheerio, mirroring parse-broker-page.ts's degrade-not-throw discipline"
    - "Anthropic document content block text/plain source as a sibling to base64/file, with no output_config.format change"

key-files:
  created:
    - src/lib/brf/run-extraction.ts
    - src/lib/brf/run-extraction.test.ts
    - src/lib/brf/ixbrl-to-text.ts
    - src/lib/brf/ixbrl-to-text.test.ts
    - supabase/migrations/009_brf_auto_fetch.sql
  modified:
    - src/lib/brf/extract.ts
    - src/actions/analyze-brf.ts
    - src/actions/analyze-brf.test.ts
    - evals/extractor.eval.ts

key-decisions:
  - "runBrfExtraction owns auth-adjacent row lookup (ownership re-check) internally, while analyze-brf.ts keeps its own fast-fail ownership check before reading the file into memory — belt-and-suspenders per T-08-03, not a duplication of trust, since runBrfExtraction is documented as never trusting its caller"
  - "iXBRL source hashes UTF-8 text directly (not converted to bytes) for the D-06 cache — content-identity semantics extend naturally without reusing the PDF byte-hash path"
  - "v1 auto-fetch stores no raw HTML for audit — only the extracted result + text content hash — per 08-PATTERNS.md; uploadBrfPdf is skipped entirely for ixbrl-text sources"

patterns-established:
  - "Pattern: any new BRF document source only needs to satisfy BrfDocumentSource + a documentSource branch in extract.ts — the scoring/cache/cost pipeline never changes"

requirements-completed: [ENRICH-01]

duration: 10min
completed: 2026-07-06
---

# Phase 8 Plan 1: Shared BRF Extraction Core + iXBRL Text Ingress Summary

**Extracted `analyzeBrf`'s D-06 cache/cost-cap/scoring pipeline into a shared `runBrfExtraction` core consumed by a thin manual-upload wrapper, added a cheerio-based iXBRL→text stripper, extended `extractBrfFinancials` with a zero-schema-change `text/plain` document source, and pushed the additive-nullable `brf_fetch_source` migration live.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-07-06T23:11:00Z
- **Completed:** 2026-07-06T23:21:00Z
- **Tasks:** 4 (3 auto + 1 checkpoint)
- **Files modified:** 9 (5 created, 4 modified)

## Accomplishments
- `runBrfExtraction(analysisId, userId, source, fetchSource)` is now the single extraction/scoring spine — hash cache, cost-cap gate, schema gate, sanity, A–F grade, and terminal persist all live in one module, branching only on `source.kind` (pdf vs ixbrl-text)
- `analyzeBrf` is a thin wrapper (form parsing + PDF validation + auth/ownership fast-fail) that delegates to `runBrfExtraction`; `correctBrfField` is untouched; the public import surface (`BrfData`, `AnalyzeBrfResult`, `analyzeBrf`, `correctBrfField`) is preserved exactly for `brf-section.tsx`/`brf-score-card.tsx`/`brf-upload.tsx`/`page.tsx`
- `ixbrlToPlainText` strips iXBRL/HTML to normalized plain text via cheerio, degrading to `""` on any malformed input, never throwing
- `extract.ts`'s `ExtractBrfInput` is now a discriminated union; iXBRL text is sent to Claude as a `{ type: "text", media_type: "text/plain" }` document block — `claudeExtractionSchema`/`output_config.format` are byte-identical to before (verified via `git diff` showing no edit to either)
- Manual-path regression suite fully green: all six former `it.todo` behaviors (guest block, RLS ownership, D-06 replace/overwrite, content-hash skip no-rebill, correctBrfField no-Claude, cost-cap abort) are real, passing assertions, plus two additional regression tests (schema-invalid failure path, `brf_fetch_source: 'manual'` persistence)
- Migration 009 (`brf_fetch_source text`, additive-nullable) written and pushed live to the linked Supabase project non-interactively; confirmed via a follow-up dry-run reporting "Remote database is up to date"

## Task Commits

Each task was committed atomically:

1. **Task 1: iXBRL→text stripper + Wave 0 test scaffolds** - `d06a53e` (feat)
2. **Task 2: Extract runBrfExtraction shared core + iXBRL source union** - `9ada702` (feat)
3. **Task 3: Manual-path regression coverage + migration 009 write** - `e8de756` (test)
4. **Task 4: Push migration 009 to Supabase** - checkpoint, resolved via automation (no new commit — verification-only against the migration file committed in Task 3)

## Files Created/Modified
- `src/lib/brf/run-extraction.ts` - shared `runBrfExtraction` core, `BrfDocumentSource`/`BrfFetchSource` types, `writeFailedStatus`/`scoreExtraction`/`METRIC_KEYS`/`COST_CAP_SEK` (moved from analyze-brf.ts)
- `src/lib/brf/run-extraction.test.ts` - module-surface + two-source-equivalence + brf_fetch_source-persistence + iXBRL-scanned=false + D-06-cache-over-text tests (8 tests, mocked Supabase + extractBrfFinancials)
- `src/lib/brf/ixbrl-to-text.ts` - `ixbrlToPlainText`, cheerio-based, never throws
- `src/lib/brf/ixbrl-to-text.test.ts` - 5 tests covering script-stripping, malformed-input safety, whitespace collapse, bare-fragment fallback
- `src/lib/brf/extract.ts` - `ExtractBrfInput` discriminated union; `documentSource` gains a `text/plain` branch for `ixbrl-text`; Files API switch is now pdf-only
- `src/actions/analyze-brf.ts` - `analyzeBrf` rewritten as a thin wrapper delegating to `runBrfExtraction`; `BrfData`/`AnalyzeBrfResult` re-exported; `correctBrfField` unchanged
- `src/actions/analyze-brf.test.ts` - six `it.todo` placeholders converted to real regression tests, plus two new tests (schema-invalid path, manual fetch_source persistence)
- `evals/extractor.eval.ts` - updated its direct `extractBrfFinancials` call site to the new `{ kind: "pdf", ... }` input shape (blocking type error caused by this refactor)
- `supabase/migrations/009_brf_auto_fetch.sql` - additive-nullable `brf_fetch_source text` column; documents that `auto_fetching` needs no DDL (no check constraint on `brf_status` anywhere in 001–008)

## Decisions Made
- Kept a lightweight ownership fast-fail in `analyzeBrf` (before reading the uploaded file into memory) in addition to `runBrfExtraction`'s own ownership re-check — avoids buffering a large PDF for a request that can never succeed, without weakening `runBrfExtraction`'s "never trust the caller" contract (T-08-03)
- iXBRL content hash is computed directly over UTF-8 text (`createHash("sha256").update(text, "utf8")`), not by converting to bytes first — matches 08-PATTERNS.md guidance and keeps the D-06 cache semantics identical in spirit (same-content-skip) across both source kinds
- No raw HTML/iXBRL storage in v1 for the auto-fetch path (`uploadBrfPdf` is skipped entirely for `ixbrl-text` sources) — only the extracted result and text hash are persisted, per the phase's stated scope

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed evals/extractor.eval.ts's direct extractBrfFinancials call**
- **Found during:** Task 2 (`npx tsc --noEmit` after the `ExtractBrfInput` discriminated-union change)
- **Issue:** `evals/extractor.eval.ts` called `extractBrfFinancials({ bytes, contentHash })` — the old flat shape, now missing the required `kind` discriminant, producing a TS2345 compile error
- **Fix:** Added `kind: "pdf"` to the eval harness's call site
- **Files modified:** `evals/extractor.eval.ts`
- **Verification:** `npx tsc --noEmit` clean afterward
- **Committed in:** `9ada702` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary to keep the codebase compiling after the discriminated-union refactor; zero scope creep — no eval logic changed, only the call-site shape.

## Issues Encountered
- `gsd-tools` was not directly resolvable on `PATH`; invoked via its absolute path (`node ~/.claude/gsd-core/bin/gsd-tools.cjs`) is available but state/commit-verb calls were done manually via `git`/direct file edits in this execution since the CLI path required extra resolution — no impact on task correctness, all commits and file writes completed as required.
- `supabase migration list --linked` and `supabase db dump --linked` both hung waiting on interactive prompts (a DB password / local Docker dependency) even with `< /dev/null` piped in; `supabase db push --linked` and `supabase db push --linked --dry-run` both completed non-interactively and were used instead. The dry-run's "Remote database is up to date" result, following the push's "Applying migration 009_brf_auto_fetch.sql... Finished supabase db push." output, is treated as sufficient confirmation that the column landed live (equivalent evidence to an `information_schema.columns` query, since a stale/failed apply would leave the migration pending and the dry-run would report it as such).

## User Setup Required

None - no external service configuration required. Migration 009 is already pushed live (see Task 4 above); no operator action remains for this plan.

## Next Phase Readiness
- `runBrfExtraction` and `BrfDocumentSource` are the stable foundation Plans 02–04 build on (org.nr resolution, Allabrf fetch, confirmation UI) — no further refactor of the extraction spine should be needed
- `brf_fetch_source` is live on `public.analyses`; Plan 03's `fetch-brf-auto.ts` can persist `'auto_bolagsverket'`/`'auto_allabrf'` values immediately
- The manual-upload path is fully regression-proven; any future change to the shared core should re-run `npx vitest run src/actions/analyze-brf.test.ts src/lib/brf/run-extraction.test.ts` as the fast regression gate

---
*Phase: 08-brf-auto-fetch*
*Completed: 2026-07-06*

## Self-Check: PASSED

All created/modified files confirmed present on disk; all three task commits (`d06a53e`, `9ada702`, `e8de756`) confirmed present in git history.
