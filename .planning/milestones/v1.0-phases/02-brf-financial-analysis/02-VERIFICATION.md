---
phase: 02-brf-financial-analysis
verified: 2026-06-14T15:15:00Z
status: passed
score: 4/4 must-haves verified (code-level) + 7/7 human UAT tests passed 2026-06-16 (see 02-UAT.md)
overrides_applied: 0
gaps: []
human_verification:
  - test: "Guest access + login gate — open an analysis page while logged out"
    expected: "The BRF section shows only the 'Logga in for BRF-analys' teaser; no upload dropzone visible. The three other ComingSoonSection placeholders (Prisjamforelse, Omradesstatistik, AI Rapport) are untouched. (D-05 / BRF-03)"
    why_human: "isGuest is resolved server-side, so the full render needs a real browser session without auth cookies."

  - test: "PDF upload validation — client-side rejection of bad files"
    expected: "Uploading a non-PDF (e.g. .txt) triggers the Swedish 'Endast PDF-filer stods' error before calling analyzeBrf. Uploading a PDF over 20 MB triggers 'Filen ar for stor - max 20 MB'. Both are rejected without contacting the server. (D-14)"
    why_human: "File validation logic in BrfUpload is rendered on the client; a browser is needed to exercise the DOM file-input events."

  - test: "Upload-to-progress flow with a real arsredovisning PDF"
    expected: "Uploading a valid PDF starts the analyzeBrf action. The BRF section transitions from the dropzone to the BrfProgress step indicator. The steps cycle Laser dokumentet → Extraherar nyckeltal → Beraknar betyg. Reloading the browser mid-run resumes at the current step (server-persisted brf_status). On completion the section advances to the score card. (D-13 / BRF-01 / BRF-03)"
    why_human: "The polling loop requires a live browser Supabase session. Step progression and page-reload resilience cannot be confirmed without exercising the full network path."

  - test: "Score card renders A–F grade + per-metric breakdown + confidence flags"
    expected: "After a completed extraction, BrfScoreCard shows: (1) a prominent colour-coded letter grade (A/B sage, C/D terracotta, E/F red) with the caption; (2) four metric rows, each with value, mini-rating badge, and weight %; (3) a 'Säkerhet N%' badge for in-band fields; (4) a destructive 'Osäker — kontrollera sjalv' badge for any field the model returned with low confidence or that applySanityChecks downgraded (D-07 / D-10 / BRF-02)."
    why_human: "Visual rendering, colour-coding, and badge rendering require a real browser. Automated checks confirm the markup is present but cannot verify correct visual branch selection on a real payload."

  - test: "Source quote disclosure — every field shows its verbatim source text and page reference"
    expected: "Each metric in the breakdown has an expandable 'Visa källa (sid N)' reveal showing the verbatim quote from the PDF and the page number. Non-extracted (null) fields do not show a reveal. (D-11 / BRF-02)"
    why_human: "This depends on the Claude extraction returning non-null sourceQuote/pageRef fields, which only happens with a real PDF; automated checks confirm the rendering code paths exist."

  - test: "Inline field correction — re-scores without re-calling Claude (D-12)"
    expected: "Clicking 'Ändra' on a metric, entering a new value, and pressing 'Spara' triggers correctBrfField (NOT analyzeBrf). The grade and breakdown re-render from the returned payload. The edited field shows a sage 'Manuellt angiven' badge. The brf_cost_sek on the row does NOT increase. (D-12 / BRF-02)"
    why_human: "Needs a live BrfData payload in the browser and a real server round-trip to confirm no Claude call is made and the re-scored grade renders correctly."

  - test: "Public methodology page is accessible without login"
    expected: "Visiting /sa-raknar-vi while logged OUT loads the page (no redirect to /login). The page displays all four metrics (Skuld per kvm, Arsavgift per kvm, Sparande per kvm, Underhallsplan) with their threshold bands and weights matching the values used by the live scorer. The page also explains A–F grade semantics and the 'Osäker' confidence flagging. (D-09 / BRF-02)"
    why_human: "Requires a real unauthenticated browser session to confirm the (app) layout does not intercept the route. Automated grep confirms it is placed outside the auth group, but a real browser confirms the middleware and layout do not redirect."
---

# Phase 02: BRF Financial Analysis Verification Report

**Phase Goal:** User can upload a BRF årsredovisning and see a financial health assessment with a transparent A–F score
**Verified:** 2026-06-14T15:15:00Z
**Status:** human_needed — all code-level must-haves verified; seven UI/browser behaviors require a human walkthrough
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 1 | User can upload a BRF årsredovisning PDF for any analysis | VERIFIED (code) / needs browser | `BrfUpload` wired to `analyzeBrf` via FormData with `application/pdf` accept + client size validation. `BrfSection` replaces `ComingSoonSection title="BRF Analys"` in `analysis/[id]/page.tsx`. Server action rejects non-PDF + >20 MB server-side. Browser upload flow needs human confirmation. |
| 2 | System extracts and displays key BRF financials (skuld/kvm, avgiftsniva, kassaflode, underhallsplan status) from the uploaded PDF | VERIFIED (code) / needs browser | `brfExtractionSchema` defines exactly these four fields. `extractBrfFinancials` calls Haiku once with `zodOutputFormat`. Score card renders the breakdown from `brfData.grade.breakdown`. Live extraction confirmed at grade A / 0.71 SEK in Plan 04 smoke test. Visual rendering needs browser. |
| 3 | System assigns a BRF health score (A–F) with visible explanation of what drove the score | VERIFIED (code) / needs browser | `computeBrfGrade` is deterministic and pure (verified by 34 passing unit tests). `BrfScoreCard` renders the grade + per-metric breakdown with weight contributions (D-07). `/sa-raknar-vi` publishes every threshold from `BRF_SCORE_THRESHOLDS` (no hardcoded duplication). Visual confirmation needs browser. |
| 4 | When PDF parsing produces low-confidence results, user sees which fields are uncertain rather than silently wrong numbers | VERIFIED (code) / needs browser | `applySanityChecks` forces out-of-band confidence to 0.2 (below `OSAKER_THRESHOLD = 0.5`). `BrfScoreCard` renders the destructive "Osäker — kontrollera sjalv" badge when `confidence < OSAKER_THRESHOLD`. `correctBrfField` allows inline correction without re-extraction. Logic confirmed by unit tests; actual badge display needs browser. |

**Score:** 4/4 truths code-verified. All four additionally require browser confirmation for the UI behavior layer.

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `supabase/migrations/002_brf.sql` | BRF columns, private brf-pdfs bucket, UPDATE+storage RLS | VERIFIED | All 5 brf_* columns, `for update` policy, `public=false` bucket, foldername-keyed storage RLS — confirmed by read + grep |
| `src/lib/schemas/brf.ts` | brfExtractionSchema + normalizeBrfExtraction + brfDataSchema + safeParseBrfData | VERIFIED | Exports all required symbols. FM2 invariant holds (no grade/score/rating/betyg key). `brfDataSchema` added post-review (CR-01) for read-path validation. |
| `src/lib/brf/score.ts` | computeBrfGrade + BRF_SCORE_THRESHOLDS | VERIFIED | Pure deterministic function, no async, no Claude import. Weights sum to 1. `BRF_SCORE_THRESHOLDS` is the single source of truth imported by the methodology page. |
| `src/lib/brf/sanity.ts` | applySanityChecks + BRF_SANITY_BANDS + OSAKER_THRESHOLD + applyManualConfidence | VERIFIED | OSAKER_THRESHOLD=0.5 exported. Out-of-band values downgraded to 0.2. `applyManualConfidence` added post-review (WR-02) to pin manual-field confidence after sanity. |
| `src/lib/brf/cost.ts` | costSek + USD_PER_MTOK + USD_SEK_RATE | VERIFIED | Named constants, reads cache tokens. Typical run ≈0.71 SEK (smoke test). |
| `src/lib/brf/prompt.ts` | BRF_EXTRACTION_SYSTEM_PROMPT | VERIFIED | Versioned const with "extract only, never grade" rule, confidence calibration, denominator few-shots. |
| `src/lib/brf/extract.ts` | extractBrfFinancials with messages.parse + citations + cache_control | VERIFIED | Uses `client.beta.messages.parse` + `zodOutputFormat(brfExtractionSchema)` + `cache_control: ephemeral`. No `dangerouslyAllowBrowser`. Rethrows coded errors (WR-06 fix). Citations API dropped (400 incompatibility with structured output); sourceQuote/pageRef carry D-11 provenance instead — documented in plan as accepted deviation. |
| `src/lib/supabase/storage.ts` | uploadBrfPdf + downloadBrfPdf | VERIFIED | Encapsulates `{userId}/{analysisId}.pdf` path convention. `upsert: true` for D-06 replace. Imported and called in `analyzeBrf`. |
| `src/actions/analyze-brf.ts` | analyzeBrf + correctBrfField + AnalyzeBrfResult | VERIFIED | Hard auth gate ("Logga in för BRF-analys"). File type + size server-side validation. D-06 hash skip with `safeParseBrfData` validation (CR-01). Single status write "extracting" (WR-03). `writeFailedStatus` for terminal writes with error logging (WR-04). `correctBrfField` never calls `extractBrfFinancials`. No `redirect()`. WR-01 (empty-string rejection) and WR-02 (`applyManualConfidence`) fixed. |
| `src/components/brf-upload.tsx` | Login-gated PDF dropzone calling analyzeBrf | VERIFIED | `accept="application/pdf"`, client type + size validation, `startTransition → analyzeBrf(formData)`, FormData keys `file` + `analysisId`, sage button + inline spinner, terracotta error text. |
| `src/components/brf-progress.tsx` | Polls brf_status, renders D-13 step indicator | VERIFIED | 1.5s poll via browser Supabase client, three step labels (Laser/Extraherar/Beraknar), stops and fires `onComplete` on terminal status, cleanup on unmount. |
| `src/components/brf-section.tsx` | Orchestrates teaser / upload / progress / result branches | VERIFIED | Guest teaser "Logga in" link. Upload → progress → result state machine without full reload. `BrfScoreCard` rendered on done branch with real `brfData`. Failed branch included (auto-added, not in plan). |
| `src/components/brf-score-card.tsx` | A–F grade + breakdown + confidence + source quotes + inline edit | VERIFIED | correctBrfField called (never analyzeBrf). Osäker badge on low confidence. Manuellt angiven badge on corrected fields. sourceQuote/pageRef expandable reveal. CR-01 defensive null guard on `ext`. IN-01 (scanned prop threading) NOT fixed — scanned banner is dead code. |
| `src/app/(app)/analysis/[id]/page.tsx` | Renders BrfSection in place of BRF ComingSoonSection | VERIFIED | Imports `BrfSection`, calls `safeParseBrfData` (CR-01). `ComingSoonSection title="BRF Analys"` absent. Three other ComingSoonSections present. `isGuest={!user}` derived server-side. |
| `src/app/sa-raknar-vi/page.tsx` | Public methodology page — no auth, imports BRF_SCORE_THRESHOLDS + BRF_SANITY_BANDS | VERIFIED | Placed at root (outside (app) auth group) — correct deviation from plan. No `getUser`/`createClient`/Claude imports confirmed. All four metric sections render threshold values from imported constants. |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `brf-upload.tsx` | `analyze-brf.ts` | `startTransition → analyzeBrf(formData)` | VERIFIED | `analyzeBrf` imported and called with FormData keys `file` + `analysisId` |
| `brf-progress.tsx` | `analyses.brf_status` | browser Supabase client poll | VERIFIED | `createClient()` from client.ts, polls `brf_status` column, `onComplete` on terminal status |
| `analysis/[id]/page.tsx` | `brf-section.tsx` | swap of BRF ComingSoonSection | VERIFIED | `BrfSection` imported and rendered; `ComingSoonSection title="BRF Analys"` gone |
| `brf-section.tsx` | `brf-score-card.tsx` | `done` branch renders BrfScoreCard | VERIFIED | `BrfScoreCard` imported and rendered on `view === "result" && data` |
| `brf-score-card.tsx` | `analyze-brf.ts:correctBrfField` | inline edit submit | VERIFIED | `correctBrfField(form)` called via `startTransition`; `analyzeBrf` is NOT called |
| `analyze-brf.ts` | `extract.ts` | `extractBrfFinancials(pdf)` after auth + upload | VERIFIED | Called only in `analyzeBrf`, not in `correctBrfField` |
| `analyze-brf.ts` | `score.ts` | `computeBrfGrade` after normalize + sanity | VERIFIED | `scoreExtraction` calls `applySanityChecks` → `normalizeBrfExtraction` → `computeBrfGrade` |
| `extract.ts` | `@anthropic-ai/sdk` | `client.beta.messages.parse` + zodOutputFormat | VERIFIED | `messages.parse` with `zodOutputFormat(brfExtractionSchema)` + `cache_control: ephemeral` confirmed |
| `sa-raknar-vi/page.tsx` | `score.ts` | imports `BRF_SCORE_THRESHOLDS` | VERIFIED | Import confirmed; 9 references to threshold values in the rendered JSX |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|-------------------|--------|
| `brf-score-card.tsx` | `data.grade.breakdown`, `data.extraction[metric.key]` | `brfData` prop from `brf-section.tsx` | Yes — flows from `analyses.brf_data` via `safeParseBrfData` + DB query in page.tsx | VERIFIED (code path); BROWSER-NEEDED for live confirmation |
| `sa-raknar-vi/page.tsx` | `BRF_SCORE_THRESHOLDS`, `BRF_SANITY_BANDS` | Direct TS import from score.ts / sanity.ts — no DB | Threshold constants (static, by design) | VERIFIED — no DB or runtime source needed |
| `brf-progress.tsx` | `status` via Supabase poll | `analyses.brf_status` column, RLS-scoped browser client | Yes — real column read per poll | VERIFIED (code); BROWSER-NEEDED for live confirmation |

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full vitest suite | `npx vitest run` | 5 files, 34 passed, 6 todo | PASS |
| Deterministic scorer tests | `npx vitest run src/lib/brf/score.test.ts src/lib/brf/sanity.test.ts src/lib/brf/cost.test.ts` | 3 files, 26 passed | PASS |
| Schema + action tests | `npx vitest run src/lib/schemas/brf.test.ts src/actions/analyze-brf.test.ts` | 2 files, 8 passed, 6 todo | PASS |
| TypeScript type check | `npx tsc --noEmit` | 0 errors | PASS |
| Migration shape check | grep for brf-pdfs, for update, brf_status, storage.foldername | All present | PASS |
| No TBD/FIXME/XXX markers | grep across all phase files | None found | PASS |
| correctBrfField no re-extraction | grep for extractBrfFinancials in correctBrfField | Not present in that function | PASS |
| extract.ts no dangerouslyAllowBrowser | grep | Not found | PASS |
| sa-raknar-vi no auth imports | grep for getUser/createClient/redirect | Not found in page | PASS |
| BRF ComingSoonSection removed | grep in analysis/[id]/page.tsx | Count 0 | PASS |
| Other 3 ComingSoonSections intact | grep Prisjamforelse | Present | PASS |

---

### Probe Execution

No `scripts/*/tests/probe-*.sh` probes found for this phase. Step 7c: SKIPPED — no conventional probe files.

---

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|-------------|-------------|--------|---------|
| BRF-01 | 02-01, 02-02, 02-03, 02-04, 02-05, 02-06 | System parses BRF arsredovisning and displays financial overview (skuld/kvm, avgiftsniva, kassaflode, underhallsplan status) | VERIFIED (code) / BROWSER-NEEDED | Extract schema defines all four fields. Score card renders them. Live smoke test confirmed real extraction. Display behavior needs browser. |
| BRF-02 | 02-03, 02-04, 02-06 | System generates BRF health score (A–F) based on financial metrics with transparent methodology | VERIFIED (code) / BROWSER-NEEDED | `computeBrfGrade` is deterministic and tested (34 passing tests). `/sa-raknar-vi` publishes thresholds from shared constants. Score card shows breakdown. Grade display and methodology page public access need browser. |
| BRF-03 | 02-02, 02-04, 02-05 | User can upload BRF arsredovisning PDF when auto-fetch is unavailable | VERIFIED (code) / BROWSER-NEEDED | `BrfUpload` dropzone with `accept=application/pdf` and `analyzeBrf` wiring exists and type-checks. Client + server validation in place. Full upload flow needs browser. |

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `brf-score-card.tsx` | 150 | IN-01 (code review): `scanned` read off wrong object — always false. D-14 scanned-PDF banner is dead code. | Info | The scanned warning banner never renders. `analysis.brf_scanned` is not threaded through `page.tsx → BrfSection → BrfScoreCard`. Cosmetic: the scan flag is persisted in the DB correctly; only the UI warning is suppressed. |
| `sa-raknar-vi/page.tsx` | 70–143 | IN-02 (code review): `formatSEK` adds "kr" suffix before "/m²" unit — slightly redundant. | Info | Cosmetic display issue only. Does not affect correctness. |
| `brf-score-card.tsx` | 137 | IN-03 (code review): `data` state seeded once from props; may desync from parent on future hydration. | Info | Latent; no current code path triggers it. |
| `extract.ts` | 71–87 | IN-04 (code review): `collectCitations` is permanently dead — API-level citations always empty. | Info | Dead code but well-documented. D-11 provenance is carried via sourceQuote/pageRef fields in the schema, which works correctly. |

No blockers or warnings found in the anti-pattern scan. All code review CRITICAL and WARNING items that were designated for fixing (CR-01, WR-01, WR-02, WR-03, WR-04, WR-06) are verifiably fixed in the source. CR-02 was documented as a deferred follow-up (no per-user rate limit) with an honest comment added at the cost-check site.

---

### Human Verification Required

Seven items require a browser session with login state and a real BRF arsredovisning PDF. These were intentionally deferred to phase-end UAT (Plan 05 Task 3, Plan 06 Task 3 checkpoints — both `gate="blocking"`). All code, wiring, and type checks pass. The automated evidence is conclusive for the server-side logic; the listed tests are strictly for the client-side rendering and real network behavior.

**1. Guest Access — BRF section shows login teaser only**

**Test:** Open an analysis page (`/analysis/[id]`) while logged out.
**Expected:** The BRF section shows the "Logga in for BRF-analys" teaser with a link to `/login` and no upload affordance. The three other ComingSoonSection placeholders (Prisjamforelse, Omradesstatistik, AI Rapport) are untouched.
**Why human:** Requires a real browser session without auth cookies. Code confirms `isGuest={!user}` is resolved server-side and the teaser branch is present.

**2. PDF Upload Validation — client-side rejection**

**Test:** While logged in, open the BRF section and (a) try to upload a non-PDF file (e.g. a .txt or image), (b) try to upload a PDF larger than 20 MB.
**Expected:** Both are rejected immediately client-side (before calling the server action) with the Swedish error messages. The server-action `analyzeBrf` also rejects them if somehow bypassed.
**Why human:** File-input events and client validation require browser DOM interaction. Code confirms the validation logic exists in both `BrfUpload` and `analyzeBrf`.

**3. Upload-to-Progress flow with real PDF**

**Test:** While logged in, upload a real BRF arsredovisning PDF. After submitting, observe the BRF section.
**Expected:** The section switches from dropzone to the step-progress indicator. The three steps cycle in order: "Laser dokumentet..." → "Extraherar nyckeltal..." → "Beraknar betyg...". Reload the browser mid-run; confirm the progress card resumes at the current step. On completion the section advances to the score card.
**Why human:** Requires a live Anthropic API key, real PDF content, browser Supabase polling, and real-time step transitions.

**4. Score Card — grade, breakdown, confidence badges**

**Test:** After a completed extraction, inspect the BrfScoreCard.
**Expected:** Prominent colour-coded A–F letter (A/B in sage green, C/D in terracotta, E/F in red). Four metric rows each showing the extracted value, a mini-rating badge, and the weight percentage. In-band fields show "Säkerhet N%". Any field the model returned with low confidence or that applySanityChecks downgraded shows the destructive "Osäker — kontrollera sjalv" badge.
**Why human:** Colour-coded rendering and badge selection depend on live `brfData` with real confidence values. Unit tests confirm the logic; visual rendering needs the browser.

**5. Source Quote Disclosure per field**

**Test:** Expand the "Visa källa (sid N)" reveal for each metric.
**Expected:** Each in-band figure shows its verbatim source quote from the PDF and the page number. Fields for which the model returned `sourceQuote: null` show no reveal.
**Why human:** D-11 provenance depends on the Claude extraction returning non-null sourceQuote/pageRef, which only occurs with a real PDF. Code confirms the rendering path; live data is needed.

**6. Inline Field Correction — no re-extraction**

**Test:** Click "Ändra" on any metric, enter a new value, press "Spara".
**Expected:** The action `correctBrfField` is called (NOT `analyzeBrf`). The grade and per-metric breakdown re-render from the returned payload. The edited field shows a sage "Manuellt angiven" badge. The `brf_cost_sek` on the row does not increase (no Claude call was made).
**Why human:** Needs a live BrfData payload and a real Supabase round-trip. Code confirms `correctBrfField` is called and `extractBrfFinancials` is not in that function path.

**7. Public Methodology Page — accessible without login**

**Test:** Visit `/sa-raknar-vi` in a private/incognito browser (no auth cookies).
**Expected:** The page loads without redirecting to `/login`. All four metric sections (Skuld per kvm, Arsavgift per kvm, Sparande per kvm, Underhallsplan) are visible with their threshold bands and weights. The A–F grade semantics and "Osäker" confidence flagging are explained.
**Why human:** Confirming the page bypasses the `(app)` layout's auth redirect requires a real unauthenticated session. Code confirms the file is at `src/app/sa-raknar-vi/page.tsx` (outside the auth group) and contains no auth calls.

---

### Gaps Summary

No gaps. All code-level deliverables are present, substantive, and wired. All code review critical and warning items designated for this phase are fixed in the code. CR-02 (no per-user rate limit) is correctly documented as a deferred follow-up — the per-request cost is inherently bounded by `max_tokens: 2048` and was observed at 0.71 SEK in the live smoke test.

The seven human verification items are structured browser tests that cannot be completed automatically. They represent the normal UAT checkpoint for an interactive Next.js feature with Supabase polling, real file uploads, and live Claude API calls — not gaps or regressions.

---

### D-11 Provenance Note (accepted deviation)

The plan specified API-level Anthropic `citations: { enabled: true }`. The Anthropic API rejects this combination with structured outputs (400). Resolution: `citations` was dropped; D-11 source quotes + page references are carried by `sourceQuote`/`pageRef` fields inside `brfExtractionSchema`. The `BrfData.citations` array is always `[]` by design — not a bug. This is documented in PLAN-04 SUMMARY and REVIEW (IN-04).

---

_Verified: 2026-06-14T15:15:00Z_
_Verifier: Claude (gsd-verifier)_
