---
status: complete
phase: 04-ai-report-delivery
source: [04-VERIFICATION.md]
started: 2026-06-26
updated: 2026-07-06
---

## Current Test

[testing complete]

## Tests

### 1. Live synthesis quality
expected: Lead synthesis anchors the analysis page (D-00/D-05), synthesizes listing/BRF/price/area into an opinionated assessment, every claim cites a specific data point (D-06), no buy/sell verdict (D-04). Requires a live ANTHROPIC_API_KEY.
result: pass
note: |
  PASSED in-browser 2026-07-06 after FIVE stacked root causes were fixed across
  sessions (all in Gaps): (1) BRF strict-grammar schema, (2) Server Action body
  limit, (3) stuck report-lock terminal-status, (4) null-status CAS acquire trap
  (`.neq` excludes NULL rows), (5) read-path flag-schema mismatch (persisted 'done'
  but read back null → silent no-render). Grounded cross-source synthesis renders,
  claims cite data points, no buy/sell verdict. All 175 unit tests pass.

### 2. PDF visual quality (Swedish glyphs)
expected: "Ladda ner PDF" downloads an application/pdf; å/ä/ö/Å/Ä/Ö render correctly (no tofu boxes); section order mirrors the on-screen report (D-11); the "ej finansiell rådgivning" disclaimer + source/freshness labels are present (D-12).
result: pass

### 3. Stale / regenerate flow (D-08)
expected: After changing a BRF/price/area input and reloading, the "Rapporten bygger på äldre data — uppdatera" marker + a manual regenerate trigger appear; the report never silently auto-refires.
result: pass

### 4. Guest gate (D-09)
expected: Logged out, opening an analysis URL shows the "Logga in för AI-rapport" teaser only — the report content and the Generera/PDF actions are not exposed.
result: pass
note: |
  CODE/TEST-VERIFIED (not manual browser UAT — user opted to skip manual checks
  2026-07-06). analyses RLS SELECT policy is `auth.uid() = user_id` with NO anon
  read (001_analyses.sql:20-22): a logged-out visitor fetches zero rows → page
  notFound() BEFORE reportData is read, so report content + Generera/PDF actions
  are never serialized to a guest. Stronger than the teaser (ai-report-section
  isGuest branch is defence-in-depth). generate-report.test.ts covers the
  unauthenticated/non-owner rejection paths. Observation: real guest experience is
  a 404, not the literal teaser — security intent (no exposure) fully satisfied.

### 5. Partial-data honesty (D-07/FM4)
expected: Generating a report on an analysis missing a source (e.g. no BRF data) renders that section honestly as "Ej tillgänglig" with nothing fabricated; flags for the missing source are suppressed, not invented.
result: pass
note: |
  CODE/TEST-VERIFIED (not manual browser UAT — user opted to skip 2026-07-06).
  generate-report.ts safeParses the four sources independently → a missing source
  degrades to null (no flag fabricated, never throws — D-07); computeFlags handles
  null inputs; themedSection carries an explicit `ej_tillgänglig` status
  (report.test.ts) rendered on-screen and in the PDF (render.test.ts). No
  fabrication path for an absent source.

### 6. Live brf-extract/v2 extraction eval (DEFERRED — not a completion blocker)
expected: Once a labeled reference dataset exists (evals/fixtures/*.pdf + evals/labels.json per labels.example.json), `RUN_LLM_EVALS=1 ANTHROPIC_API_KEY=<key> npm run eval` is green — the four original BRF metrics do not regress against v2 and the three D-02 soft signals extract with supporting citations. Harness is committed (evals/extractor.eval.ts); building the dataset is tracked eval-infrastructure work (STATE.md Pending Todos). Explicitly deferred by operator decision — does not gate phase completion.
result: [deferred]

## Summary

total: 5
passed: 5
issues: 0
pending: 0
skipped: 0
blocked: 0

(Item 6 is a tracked deferral, excluded from the gating count.)

## Gaps

- truth: "Clicking 'Generera AI-rapport' on any owned analysis acquires the report lock and starts synthesis"
  status: failed
  reason: "User reported (re-test 2026-07-06): old analysis, restarted server, click → 'En AI-rapport genereras redan', no report, no synthesis. Diagnostic log proved observed_status=null / observed_started_at_kind=null — the row had NO lock at all."
  severity: blocker
  test: 1
  root_cause: "The atomic CAS acquire in generate-report.ts filtered with `.neq('report_status','generating')`. PostgREST compiles this to `report_status <> 'generating'`, and `NULL <> 'generating'` is NULL (unknown) — a WHERE filter treats unknown as false, so the UPDATE matches ZERO rows whenever report_status IS NULL. Every analysis whose report_status was never set (old rows created before the report columns were backfilled) is therefore PERMANENTLY refused with 'genereras redan': the button renders (null → not done/failed/generating), but no click can ever acquire the lock. Not a timing window — deterministic. Same three-valued-logic family as the earlier `.eq(col,null)` reclaim trap. Slipped past all 174 unit tests because the supabase mock resolves the CAS from the WRITE payload and never simulates PostgREST NULL/neq filter semantics, so no test exercised a null-status row against the real predicate."
  artifacts:
    - path: "src/actions/generate-report.ts"
      issue: "CAS acquire used `.neq('report_status','generating')` which excludes NULL rows → permanent 'genereras redan' for report_status=NULL analyses."
    - path: "src/actions/generate-report.test.ts"
      issue: "Mock CAS resolves from write payload, never models neq/NULL filter semantics → class of bug invisible to unit tests."
  missing:
    - "Change CAS filter to `.or('report_status.is.null,report_status.neq.generating')` so NULL rows are acquirable while a live 'generating' lock is still refused."
    - "Consider a migration to backfill report_status default (e.g. 'idle') + NOT NULL so no NULL rows exist going forward."
    - "Real guard: a live/integration test against Postgres (unit mocks structurally cannot catch PostgREST NULL semantics)."
  debug_session: ""
  fix: "FIXED in src/actions/generate-report.ts: CAS acquire now filters `.or('report_status.is.null,report_status.neq.generating')` — NULL and non-generating rows acquire the lock; a fresh 'generating' row is still refused (row-level UPDATE atomicity preserves the no-double-spend CAS). Added permanent console.warn observability to BOTH previously-silent refuse paths (fresh-lock guard + CAS-lost) — that silence was why this took a live click to diagnose. Test mock updated with `.or()`; full suite 174 passed + typecheck clean. Backfill migration + live integration test noted as follow-ups. Awaiting in-browser re-test to flip Test 1 → pass."
  fix_status: resolved-pending-retest

- truth: "A generated report (report_status='done') renders on the analysis page"
  status: failed
  reason: "User reported (re-test 2026-07-06, after the CAS fix): click succeeds, NO 'genereras redan', NO error in logs — but no report renders; the 'Generera AI-rapport' trigger button stays."
  severity: blocker
  test: 1
  root_cause: "Write/read schema mismatch on the persisted flag shape. generate-report.ts persists `report_data.flags` = computeFlags() output. The write-side Flag type (flags.ts:64-71) declares sourceQuote/pageRef/confidence OPTIONAL, and the numeric BRF/price flags set only { id, severity, sourceRef }. Serialized to Supabase JSONB, the undefined keys are DROPPED. The read-path guard safeParseReportData → persistedFlagSchema (report.ts:89-91) declared those three `.nullable()`, which in Zod requires the KEY TO BE PRESENT (accepts null, rejects undefined/absent). So any report containing a numeric flag fails the read parse → reportData=null → page.tsx passes report={null} → ai-report-section renders the '!report' trigger branch. report_status is 'done' (not 'failed', not 'generating') so NO error card, NO console log — a silent black hole. Confirmed deterministically: computeFlags({brf,price}) → first flag {id:'brf_high_debt',severity:'red',sourceRef:'brf.skuldPerKvm'} → reportDataSchema.flags.safeParse fails 'expected string, received undefined' at [0].sourceQuote. Slipped past unit tests because the safeParseReportData fixture hard-coded all flag keys present (with null), never exercising the real computeFlags producer through a JSONB round-trip."
  artifacts:
    - path: "src/lib/schemas/report.ts"
      issue: "persistedFlagSchema used .nullable() for sourceQuote/pageRef/confidence; write-side omits those keys for numeric flags → read parse fails → report_data reads back null."
    - path: "src/lib/schemas/report.test.ts"
      issue: "validSnapshot fixture always included all flag keys → never caught the omitted-key round-trip."
  missing:
    - "Change persistedFlagSchema sourceQuote/pageRef/confidence to .nullish() (nullable + optional) to accept absent keys."
    - "Regression test that round-trips real computeFlags() output through JSON (JSONB serialization) before safeParseReportData."
  debug_session: ""
  fix: "FIXED in src/lib/schemas/report.ts: sourceQuote/pageRef/confidence → .nullish(). Backward-compatible — already-persisted 'done' reports now read back and render without regeneration (no data migration needed). Added a regression test in report.test.ts that feeds real computeFlags() output through JSON.stringify/parse (mirrors JSONB dropping undefined) then safeParseReportData. Full suite 175 passed + typecheck clean. Awaiting in-browser confirmation that the report renders."
  fix_status: resolved-pending-retest

- truth: "Uploading a BRF PDF extracts the four figures + soft signals via one Haiku call (analyze-brf)"
  status: failed
  reason: "User reported: BRF upload fails with 'Vi kunde inte läsa dokumentet automatiskt'. Reproduced live: every PDF returns HTTP 400 → CLAUDE_CALL_FAILED."
  severity: blocker
  test: 1
  root_cause: "brfExtractionSchema is incompatible with Anthropic strict structured outputs (output_config.format / zodOutputFormat). Two stacked limits, both reproduced against the live API with the project's own extractBrfFinancials: (1) numeric constraints .min(0).max(1) + .int().positive() → 400 'The compiled grammar is too large'; (2) after stripping those, 28 nullable→union params (7 fields × {value,confidence,sourceQuote,pageRef}, all .nullable()) → 400 'Schemas contains too many parameters with union types'. Slimming to value-only nullables (7 unions) + plain number/string returns HTTP 200 and extracts correctly with citations. Slipped past tests because the Anthropic call is mocked in unit tests and the live extraction eval was deferred (no labeled dataset) — no live BRF extraction ever ran."
  artifacts:
    - path: "src/lib/schemas/brf.ts"
      issue: "extractedField() makes confidence/sourceQuote/pageRef .nullable() (→28 unions) and value carries numeric constraints; exceeds strict-grammar limits."
    - path: "src/lib/brf/extract.ts"
      issue: "Uses client.beta.messages.parse + zodOutputFormat(brfExtractionSchema) strict grammar; 400 is flattened to CLAUDE_CALL_FAILED."
  missing:
    - "Reduce union-typed params: make confidence/sourceQuote/pageRef non-nullable (sentinels: 0 / '' / 0) so only `value` stays nullable (28→7 unions)."
    - "Remove numeric range/int constraints from the Claude-facing schema; validate/clamp them in TS after parse (normalizeBrfExtraction)."
    - "Ripple the sentinel change through normalizeBrfExtraction, brfDataSchema (read-path), citations mapping, score, and the score-card UI."
    - "Add a thin live smoke test (RUN_LLM_EVALS) that actually calls the API with one tiny PDF so a strict-grammar regression fails CI, not the user."
  debug_session: ""
  fix: "FIXED in src/lib/brf/extract.ts: send Claude a slimmed `claudeExtractionSchema` (value-only nullables → 7 unions, no numeric constraints, .describe() steering preserved), then `toCanonicalExtraction` maps the result back to the exact canonical BrfExtraction shape (sentinels → null, confidence clamped to [0,1]). Canonical brfExtractionSchema + brf.ts + all downstream (normalize/score/citations/UI/report) UNCHANGED; analyze-brf still re-validates against the canonical schema. Verified live against the real API via extractBrfFinancials (HTTP 200, correct extraction with citations; absent field → all-null). Follow-up still open: live RUN_LLM_EVALS smoke guard."
  fix_status: resolved

- truth: "Manual 'Generera AI-rapport' generates a report and the UI reflects in-flight/completed state without leaving a stuck lock"
  status: failed
  reason: "User reported: 'En AI-rapport genereras redan' on the first click and again later, with no way to recover."
  severity: major
  test: 1
  root_cause: "The report synthesis path itself is healthy (reproduced live → valid report). 'genereras redan' is the in-flight lock (report_status='generating', fresh within STALE_LOCK_MS=5min) refusing a click. Likely trigger: an earlier generation was interrupted (page reload / dev-server restart mid-Sonnet, or the final persist at generate-report.ts:350-367 errored — that update sets report_data+status='done' atomically, so a persist failure leaves status pinned at 'generating' and it is never reset). Compounded by UX: ai-report-section.tsx does NOT poll or refresh, so reportStatus is a stale page-load prop — the user clicks an enabled button while the server row is 'generating' (TOCTOU), and on success the button still says 'Generera AI-rapport' until a manual reload, inviting re-clicks. The lock message offers no recovery and the row self-heals only after 5 min. UNCONFIRMED detail: the exact wedge trigger on the user's machine — server console '[generateReport] {analysisId, code}' lines or the DB row's report_status would confirm."
  artifacts:
    - path: "src/components/ai-report-section.tsx"
      issue: "No polling/refresh; reportStatus is a stale prop; success path does not re-fetch so the report never appears without manual reload."
    - path: "src/actions/generate-report.ts"
      issue: "Final persist (350-367) failing leaves report_status='generating' (no terminal reset on that path); 5-min wedge window with a non-actionable user message."
  missing:
    - "Poll report_status after triggerGenerate (or router.refresh on success) so the in-flight → done/failed transition is reflected without a manual reload."
    - "On persist failure after a successful synthesis, write a terminal status (failed) so the lock is always released."
    - "Give the 'genereras redan' state a recovery affordance (it self-heals after 5 min; surface that or allow reclaim)."
  debug_session: ""
  fix: "FIXED two ways: (1) generate-report.ts now calls writeFailedStatus on the terminal-persist-failure path, so a failed 'done' write no longer wedges report_status at 'generating' — the lock is released and the user can retry immediately. (2) ai-report-section.tsx now calls router.refresh() on a successful generation (generateReport runs synthesis to a terminal status before returning, so the report exists on success); the report renders without a manual reload and the trigger button stops re-inviting clicks. Any pre-existing wedged row self-heals via the existing 5-min stale-lock reclaim. Note: exact original wedge trigger on the user's machine was not confirmed from logs, but both known wedge paths are now closed. All 173 unit tests pass incl. the persist-failure case."
  fix_status: resolved

- truth: "A real BRF PDF (>1 MB) uploads and analyzes end-to-end"
  status: failed
  reason: "Server log on retest: 'Error: Body exceeded 1 MB limit' / statusCode 413, POST 500 — surfaced to the user as the generic 'Vi kunde inte läsa dokumentet' fallback, so it masqueraded as an extraction failure."
  severity: blocker
  test: 1
  root_cause: "PDFs are uploaded through the analyzeBrf Server Action as multipart FormData. Next.js Server Actions default to a 1 MB request-body cap, so any real årsredovisning (>1 MB) was rejected with a framework-level 413 BEFORE the action ran — making the app's own 20 MB MAX_PDF_BYTES check unreachable. The action threw (didn't return {ok:false}), so onFailed never fired and errorMsg stayed null → generic fallback message. Found only via the dev-server console (not reproducible with synthetic PDFs, which uploaded fine below 1 MB)."
  artifacts:
    - path: "next.config.ts"
      issue: "No experimental.serverActions.bodySizeLimit → 1 MB default."
    - path: "src/components/brf-upload.tsx"
      issue: "analyzeBrf call not wrapped in try/catch → a thrown 413 became an unhandled rejection + silent hang."
  missing:
    - "Set experimental.serverActions.bodySizeLimit above the 20 MB app cap (restart required)."
    - "try/catch the server-action call so a throw surfaces via onFailed."
    - "PROD FOLLOW-UP (not done): Vercel caps request body ~4.5 MB regardless — needs client-direct upload to Supabase Storage (signed URL) before deploying there."
  debug_session: ""
  fix: "FIXED (commit ce27f73): next.config.ts serverActions.bodySizeLimit='25mb' + try/catch in brf-upload.tsx. User-confirmed working end-to-end in browser 2026-07-05. Vercel platform-cap refactor remains an open follow-up."
  fix_status: resolved
