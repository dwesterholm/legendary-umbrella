---
phase: 08-brf-auto-fetch
plan: 04
subsystem: ui
tags: [brf, auto-fetch, react, confirmation-ui, provenance, vitest, testing-library]

requires:
  - phase: 08-brf-auto-fetch
    plan: 03
    provides: "resolveOrgNrAction/confirmAndAnalyze — this plan's UI orchestration seam calling both"
  - phase: 08-brf-auto-fetch
    plan: 02
    provides: "brf_fetch_source provenance values (auto_allabrf/auto_bolagsverket/manual) this plan's score-card caption renders"
provides:
  - "BrfMatchConfirmation (brf-confirm.tsx) — the ENRICH-02 mandatory human-in-the-loop confirmation step"
  - "BrfAutoFetchProgress (brf-auto-fetch-progress.tsx) — the auto_fetching pre-step poller, visually distinct from BrfProgress"
  - "BrfSection confirm/auto-fetching View branches orchestrating resolve -> confirm -> analyze -> fall-through"
  - "BrfScoreCard fiscal-year + provenance header row + inline staleness caption"
  - "The first React-component test infrastructure in this repo (jsdom + @testing-library/react + jest-dom, scoped per-file, node stays default)"
affects: [08-05-live-validation]

tech-stack:
  added:
    - "@testing-library/react ^16.3.2"
    - "@testing-library/jest-dom ^6.9.1"
    - "jsdom ^29.1.1"
  patterns:
    - "Per-file jsdom opt-in via `// @vitest-environment jsdom` docblock (environmentMatchGlobs does not exist in vitest 4) — keeps the existing 384-test node-environment suite untouched while enabling RTL component tests"
    - "Component tests mock the server-action module boundary (@/actions/fetch-brf-auto, @/actions/analyze-brf) and @/lib/supabase/client rather than reaching into their internals — isolates the component under test from the Anthropic-client-at-module-scope import chain"

key-files:
  created:
    - src/components/brf-confirm.tsx
    - src/components/brf-confirm.test.tsx
    - src/components/brf-auto-fetch-progress.tsx
    - src/components/brf-section.test.tsx
    - vitest.setup.ts
  modified:
    - src/components/brf-progress.tsx
    - src/components/brf-section.tsx
    - src/components/brf-score-card.tsx
    - src/app/(app)/analysis/[id]/page.tsx
    - vitest.config.ts
    - package.json / package-lock.json

key-decisions:
  - "environmentMatchGlobs (the option 08-PATTERNS/plan assumed for scoping jsdom) does not exist in vitest 4's config type surface — switched to Vitest's per-file `// @vitest-environment jsdom` docblock instead, added to both new *.tsx test files. Global default stays \"node\" for every other test (Rule 3 blocking-issue auto-fix)."
  - "@testing-library/jest-dom was not installed even after @testing-library/react — the RTL smoke assertions (toBeInTheDocument/toBeVisible/toBeDisabled) needed it. Installed and wired via a new vitest.setup.ts importing \"@testing-library/jest-dom/vitest\" globally — inert no-op for the existing node-environment tests since they never call DOM matchers (Rule 3 blocking-issue auto-fix)."
  - "brf-section.test.tsx additionally mocks @/actions/analyze-brf (not just @/actions/fetch-brf-auto) — BrfUpload (rendered unchanged in the upload view) imports analyzeBrf, which transitively imports run-extraction.ts -> extract.ts, which constructs `new Anthropic()` at module scope and throws under jsdom (dangerouslyAllowBrowser guard). Mocking the module boundary isolates the component test without touching BrfUpload's own behavior (Rule 3 blocking-issue auto-fix)."
  - "fiscalYear and isMostRecent are threaded through BrfSection -> BrfScoreCard as full prop plumbing, but page.tsx passes them as `null` (per the plan's own explicit fallback) — migration 009 only persisted brf_fetch_source; no column/derivation for fiscal year or most-recent-year staleness exists yet on the analyses row or in BrfData. brf_fetch_source (guaranteed present) is threaded live, so the provenance caption renders correctly today; the fiscal-year line and staleness caption will light up once a future plan persists those values."
  - "BrfAutoFetchProgress's step advancement is a coarse visual heuristic (advance one step per poll tick while brf_status stays 'auto_fetching') rather than a precise per-sub-step signal, since the persisted status only has one transient value covering all three pre-steps (org.nr search -> document fetch -> hand-off prep). This matches 08-UI-SPEC's poll-cadence contract (reuse brf_status polling, not a finer-grained status column) — an accepted v1 approximation, not a bug."

patterns-established:
  - "Pattern: any future auto-fetch source confirmation UI reuses BrfMatchConfirmation's confirm(filled)/reject(equal-size outline) button pair and the terracotta single-banner convention for ambiguous/failed states."

requirements-completed: [ENRICH-02]

duration: 52min
completed: 2026-07-07
---

# Phase 8 Plan 4: BRF Auto-Fetch UI Wiring (Confirmation, Progress, Score-Card Provenance) Summary

**Wired the ENRICH-02 human-in-the-loop confirmation flow into the BRF UI — a mandatory "Stämmer detta med din bostad?" org.nr/fiscal-year confirmation step with an equally-prominent manual-upload reject path, a distinct auto-fetch pre-step progress sequence, and fiscal-year/provenance/staleness reporting on the score card — while introducing this repo's first React-component test infrastructure (jsdom + RTL) to verify it.**

## Performance

- **Duration:** 52 min
- **Started:** 2026-07-07T07:52:00Z (approx, prior session context)
- **Completed:** 2026-07-07T08:00:00Z
- **Tasks:** 3 code tasks (all auto/tdd) + 1 deferred live-smoke checkpoint
- **Files modified:** 10 (5 created, 5 modified) + package.json/lock + vitest config/setup

## Accomplishments
- `BrfMatchConfirmation` (`brf-confirm.tsx`) renders the LOCKED heading "Stämmer detta med din bostad?", an org.nr/räkenskapsår/BRF-name detail block, and two `h-11 px-6` buttons — a filled-sage confirm ("Ja, stämmer — analysera") and an equally-sized outline reject ("Nej, ladda upp manuellt", never ghost/smaller) — plus an optional terracotta ambiguous-match banner
- `BrfAutoFetchProgress` (`brf-auto-fetch-progress.tsx`) duplicates `BrfProgress`'s exact step-dot visual pattern and `POLL_MS`/`MAX_POLL_MS` constants with its OWN 3-step pre-sequence ("Söker organisationsnummer…" → "Hämtar dokument…" → "Förbereder analys…"), completing on a `brf_status` transition into reading/extracting/scoring/done and timing out to the fallback banner on `failed`/stall — `brf-progress.tsx`'s existing 3-step STEPS array is untouched (verified via `git diff`), only a new `auto_fetching`-aware branch in `stepIndex` was added
- `BrfSection`'s `View` union gained `"confirm"`/`"auto-fetching"`; an effect (skipped for guests and any already-done/in-progress/auto_fetching row) calls `resolveOrgNrAction` on mount when a listing `brfName` exists — `high` confidence renders `BrfMatchConfirmation`, `low`/`none`/`fallThrough` silently degrade to the existing `upload` view with **no** error banner. Confirm calls `confirmAndAnalyze` and transitions to `BrfAutoFetchProgress`; a fall-through result routes to the `failed` view's terracotta banner + manual upload (never a wrong-BRF analysis). Reject is `setView("upload")` with zero intermediate friction. The guest teaser stays the unconditional first branch (D-05/T-08-16)
- `BrfScoreCard` now accepts `fiscalYear`/`fetchSource`/`isMostRecent` and renders "Räkenskapsår {year}" + a "Källa: Allabrf"/"Källa: Bolagsverket"/"Källa: Manuellt uppladdad" caption, plus an inline (not full-card) terracotta staleness caption when `isMostRecent === false` — distinct from the existing full-banner `scanned` treatment
- `page.tsx` threads `listingData.brfName` into `BrfSection` and reads `brf_fetch_source` off the already-`select("*")`'d analysis row through to the score card; `fiscalYear`/`isMostRecent` are passed `null` per the plan's own explicit fallback (no column persists them yet) — the `assembleFactSheet`/`currentFingerprint` (D-08) block is byte-identical, confirmed via `git diff`
- Installed this repo's first React-component test stack (`@testing-library/react`, `@testing-library/jest-dom`, `jsdom`) scoped via per-file `// @vitest-environment jsdom` docblocks — the existing 384-test `node`-environment suite is untouched and still green; 11 new component tests added (5 in `brf-confirm.test.tsx`, 6 in `brf-section.test.tsx`), full suite now 395 passed / 1 skipped

## Task Commits

Each code task followed RED -> GREEN (TDD):

1. **Task 1: BrfMatchConfirmation + BrfAutoFetchProgress** —
   - `f169c9d` (test): failing brf-confirm.test.tsx + jsdom/RTL infra install
   - `7cbbe15` (feat): brf-confirm.tsx + brf-auto-fetch-progress.tsx + brf-progress.tsx auto_fetching awareness
   - `57aa197` (test): wired @testing-library/jest-dom matchers (discovered missing mid-GREEN)
2. **Task 2: BrfSection orchestration + BrfScoreCard provenance** —
   - `7dc83bf` (test): failing brf-section.test.tsx
   - `f7922a9` (feat): brf-section.tsx confirm/auto-fetching branches + brf-score-card.tsx fiscal-year/provenance/staleness
3. **Task 3: Page wiring** —
   - `fc450d9` (feat): page.tsx threads listingData + brf_fetch_source into BrfSection

**Plan metadata:** (this commit, docs: complete plan)

## Files Created/Modified
- `src/components/brf-confirm.tsx` - `BrfMatchConfirmation` — confirmation card, equal-prominence confirm/reject buttons
- `src/components/brf-confirm.test.tsx` - 5 RTL tests: heading/org.nr/fiscal-year render, confirm/reject callbacks, equal-sizing, no-banner-when-no-message
- `src/components/brf-auto-fetch-progress.tsx` - `BrfAutoFetchProgress` — auto_fetching pre-step poller, distinct 3-step sequence
- `src/components/brf-progress.tsx` - `auto_fetching` now indexes to pre-step 0 in `stepIndex` instead of falling through; existing STEPS array unchanged
- `src/components/brf-section.tsx` - `View` union extended with `"confirm"`/`"auto-fetching"`; resolution effect + confirm/reject/confirm-and-analyze orchestration
- `src/components/brf-section.test.tsx` - 6 RTL tests: guest-never-resolves, no-brfName-skips, low-confidence-falls-through, high-confidence-shows-confirm, reject-routes-to-upload, confirm-calls-confirmAndAnalyze
- `src/components/brf-score-card.tsx` - fiscal-year + provenance header row + inline staleness caption (new optional props, backward-compatible)
- `src/app/(app)/analysis/[id]/page.tsx` - passes `listingData`/`brf_fetch_source` (fiscalYear/isMostRecent as null) to `BrfSection`; fingerprint block untouched
- `vitest.config.ts` - added `setupFiles: ["./vitest.setup.ts"]` (jest-dom matchers); jsdom scoping moved to per-file docblocks, not global config
- `vitest.setup.ts` (new) - imports `@testing-library/jest-dom/vitest` globally (inert for node-environment tests)
- `package.json` / `package-lock.json` - added `@testing-library/react`, `@testing-library/jest-dom`, `jsdom` as devDependencies

## Decisions Made
See `key-decisions` in frontmatter: the `environmentMatchGlobs`-does-not-exist-in-v4 fix, the missing `@testing-library/jest-dom` fix, the `@/actions/analyze-brf` mock addition to isolate from the Anthropic-client-at-module-scope chain, the `fiscalYear`/`isMostRecent`-as-null threading (explicit plan fallback), and the coarse per-poll-tick step-advancement heuristic in `BrfAutoFetchProgress`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `environmentMatchGlobs` does not exist in vitest 4**
- **Found during:** Task 1, setting up jsdom scoping for the first component test
- **Issue:** The intended approach (a single `environmentMatchGlobs` config entry scoping jsdom to `src/components/**/*.test.tsx`) is not part of Vitest 4's config type surface — using it silently had no effect, leaving `document is not defined` errors.
- **Fix:** Switched to Vitest's documented per-file `// @vitest-environment jsdom` docblock, added to the top of both new `*.test.tsx` files. Global default (`environment: "node"`) is unchanged for every other test file.
- **Files modified:** `vitest.config.ts`, `src/components/brf-confirm.test.tsx`, `src/components/brf-section.test.tsx`
- **Commit:** `f169c9d`, `7dc83bf`

**2. [Rule 3 - Blocking] `@testing-library/jest-dom` was missing**
- **Found during:** Task 1 GREEN — RTL's `render`/`screen` worked once jsdom was active, but `toBeInTheDocument`/`toBeVisible`/`toBeDisabled` assertions failed with `Invalid Chai property`.
- **Fix:** Installed `@testing-library/jest-dom` (official Testing Library matcher package, verified on the npm registry before install) and added `vitest.setup.ts` importing `@testing-library/jest-dom/vitest` globally via `setupFiles` — a no-op for the existing node-environment tests.
- **Files modified:** `package.json`, `package-lock.json`, `vitest.config.ts`, `vitest.setup.ts` (new)
- **Commit:** `57aa197`

**3. [Rule 3 - Blocking] `BrfSection`'s test import chain hit the Anthropic client guard**
- **Found during:** Task 2 RED/GREEN — rendering `BrfSection` under jsdom (even with `@/actions/fetch-brf-auto` mocked) threw `It looks like you're running in a browser-like environment` because `BrfUpload` imports `analyzeBrf` from `@/actions/analyze-brf`, which transitively constructs `new Anthropic()` at module scope in `extract.ts`.
- **Fix:** Added a `vi.mock("@/actions/analyze-brf", ...)` alongside the `fetch-brf-auto` mock in `brf-section.test.tsx`, isolating the component test from that chain. `BrfUpload`'s own behavior is untouched and out of scope for this test file (it renders unchanged in the `upload` view, verified by other existing coverage).
- **Files modified:** `src/components/brf-section.test.tsx`
- **Commit:** `7dc83bf`

None of these required Rule 4 (architectural) escalation — all three were local, blocking-issue fixes needed to get the plan's own specified TDD tests running, with zero production-code behavior implications.

---
**Total deviations:** 3 (all Rule 3, auto-fixed)
**Impact on plan:** None on scope/behavior — all three were test-infrastructure gaps discovered while implementing the plan's own required component tests; every specified UI behavior, copy string, and acceptance criterion is implemented as written.

## Issues Encountered
- `gsd-tools` was not on `PATH` in this environment (consistent with Plans 01-03's notes) — state/commit steps in this execution were performed directly via `git`, per the sequential-executor instructions provided for this plan.
- `npm audit` reports 35 pre-existing vulnerabilities (2 low/14 moderate/18 high/1 critical) unrelated to this plan's 3 new devDependencies (`@testing-library/react`, `@testing-library/jest-dom`, `jsdom` — all official/well-known test tooling, verified via npm registry lookups before install); out of scope to remediate here (not touched/introduced by this plan's dependency additions per `npm install`'s own diff).

## User Setup Required

None for the code tasks — all three (BrfMatchConfirmation/BrfAutoFetchProgress rendering, BrfSection orchestration, page wiring) are fully verified by the mocked component/unit test suite, `npx tsc --noEmit`, and `npm run build`, all green with zero live credentials needed.

**Operator Next Steps (Task 4 — live smoke test, AUTO-APPROVED BUT DEFERRED, not performed):**

Per this execution's explicit instructions, live Allabrf/Claude calls are operator-only (not run in CI, per 08-VALIDATION.md Manual-Only) and Allabrf's live access/ToS posture was LOW-confidence in research — this session did NOT attempt to hit live Allabrf. All automated verification (component tests, `npx tsc --noEmit`, `npm run build`, acceptance-criteria greps) is green; the following manual steps remain for the operator before this UI flow is considered production-verified:

1. **Environment:** Supabase + `ANTHROPIC_API_KEY` (+ any Allabrf access if configured). Start the app (`npm run dev`).
2. **Real listing → org.nr resolves:** Open (or run) an analysis for a real Booli listing whose BRF has a recoverable `brfName` (Phase 6) and an Allabrf årsredovisning with a resolvable org.nr.
3. **Confirmation surfaces correctly:** Confirm the BRF section shows "Stämmer detta med din bostad?" with the org.nr + räkenskapsår (+ BRF name); confirm the reject button ("Nej, ladda upp manuellt") is equally prominent (not ghost/smaller).
4. **Confirm runs identical extraction/scoring:** Click "Ja, stämmer — analysera"; confirm the auto-fetch pre-step progress ("Söker organisationsnummer…" → "Hämtar dokument…" → "Förbereder analys…") then the existing extraction steps, ending in the SAME A–F score card the manual upload produces, now with "Räkenskapsår {year}" + "Källa: Allabrf".
5. **Staleness:** If the fetched year is not the latest Allabrf has, confirm the terracotta staleness caption renders inline under the fiscal-year label. (Note: this requires a future plan to actually persist `isMostRecent`/`fiscalYear` on the row — currently `page.tsx` passes them as `null`, so this specific check will not yet be exercisable end-to-end until that plan lands; verify the *component-level* behavior instead by temporarily wiring a real value, or defer this specific check to that future plan's smoke test.)
6. **Fall-through, zero-friction, no false errors:** On a listing with no resolvable org.nr (or a low-confidence/ambiguous match), confirm you land directly on the manual upload view — NO error banner when nothing was attempted; the ambiguous/failed banner + manual upload when a fetch was attempted and failed. Never a wrong-BRF analysis.
7. **Manual regression:** Upload a PDF manually and confirm the A–F score card renders exactly as before (no regression from the `runBrfExtraction` refactor), now with "Källa: Manuellt uppladdad".
8. **Logging hygiene:** Check server logs for `[brf-source]` lines on any rung failure (never silent) and confirm no scraped HTML / financials / PII are logged.
9. **ToS/robots posture:** Before enabling this flow in production against live Allabrf traffic, verify Allabrf's current ToS/robots.txt posture — research flagged this as LOW-confidence; do not treat this plan's automated-green status as license to scrape Allabrf at scale without that check.

## Next Phase Readiness
- All four UI surfaces named in the plan objective (`BrfMatchConfirmation`, `BrfAutoFetchProgress`, modified `BrfProgress`/`BrfSection`/`BrfScoreCard`, wired `page.tsx`) are implemented, unit/component-tested, type-checked, and build-clean.
- The one still-open gap for a fully realized ENRICH-02 experience is persisting `fiscalYear`/`isMostRecent` somewhere readable at page-render time (today only `brf_fetch_source` survives past `runBrfExtraction`'s terminal persist) — a follow-up plan should either extend `BrfData`/migration 009 or derive `isMostRecent` from a live Allabrf lookup at render time. Until then, the provenance caption ("Källa: X") is live and correct; the fiscal-year line and staleness caption are wired but dormant (rendering nothing, per the score card's graceful null handling) on real analyses.
- Task 4 (live smoke test) is the phase's blocking gate before this flow can be considered end-to-end verified against live Allabrf — see Operator Next Steps above.

---
*Phase: 08-brf-auto-fetch*
*Completed: 2026-07-07*

## Self-Check: PASSED

All 10 created/modified files confirmed present on disk (`brf-confirm.tsx`, `brf-confirm.test.tsx`, `brf-auto-fetch-progress.tsx`, `brf-section.test.tsx`, `vitest.setup.ts`, `brf-progress.tsx`, `brf-section.tsx`, `brf-score-card.tsx`, `page.tsx`, this SUMMARY). All 6 task commits (`f169c9d`, `7cbbe15`, `57aa197`, `7dc83bf`, `f7922a9`, `fc450d9`) confirmed present in git history.
