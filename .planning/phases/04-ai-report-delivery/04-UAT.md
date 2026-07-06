---
status: testing
phase: 04-ai-report-delivery
source: [04-VERIFICATION.md]
started: 2026-06-26
updated: 2026-07-05
---

## Current Test

number: 1
name: Live synthesis quality — generate a report on an owned analysis
expected: |
  BRF upload → extract → grade works end-to-end in the browser (user-confirmed
  2026-07-05). AI-report generation was blocked by a permanently-wedged report
  lock (report_status='generating' + NULL start-time; PostgREST .eq(null) reclaim
  bug) — FIXED in commit fbfa135 (self-heals on next click, no restart needed).
awaiting: |
  ⏳ VERIFY LATER — user could not run the dev server on 2026-07-06 (port taken by
  another project). When free: click "Generera AI-rapport" on an owned analysis
  that has BRF data and confirm (a) it no longer says "genereras redan" (the lock
  self-heals), (b) a grounded cross-source lead synthesis renders, (c) every claim
  cites a data point (D-06), (d) NO buy/sell verdict and NO "rätt pris är X" (D-04).
  This is the last step to flip Test 1 from `issue` → `pass`.

## Tests

### 1. Live synthesis quality
expected: Lead synthesis anchors the analysis page (D-00/D-05), synthesizes listing/BRF/price/area into an opinionated assessment, every claim cites a specific data point (D-06), no buy/sell verdict (D-04). Requires a live ANTHROPIC_API_KEY.
result: issue
reported: "Clicked 'Generera AI-rapport' before uploading a BRF doc → 'En AI-rapport genereras redan'. Tried to upload a BRF PDF → failed with 'Vi kunde inte läsa dokumentet automatiskt. Försök igen.' Clicked AI report again → same 'genereras redan' error."
severity: blocker
note: |
  Two distinct, confirmed root causes (see Gaps) — BOTH FIXED + verified live.
  The report SYNTHESIS itself was always healthy (reproduced live: valid grounded
  leadSynthesis + themed sections, no buy/sell verdict). Awaiting in-browser
  re-test to flip this to pass.
status_after_fix: fixed-pending-retest

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
issues: 1
pending: 4
skipped: 0
blocked: 0

(Item 6 is a tracked deferral, excluded from the gating count.)

## Gaps

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
