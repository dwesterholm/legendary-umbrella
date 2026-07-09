---
phase: 02-brf-financial-analysis
plan: 05
subsystem: ui
tags: [react, nextjs, client-component, server-action, supabase, polling, d-04, d-05, d-13, d-14]

requires:
  - phase: 02-04
    provides: "analyzeBrf(formData) + AnalyzeBrfResult/BrfData; brf_status status writes (reading→extracting→scoring→done/failed)"
  - phase: 02-02
    provides: "analyses.brf_* columns + brf-pdfs bucket + UPDATE RLS on LIVE Supabase"
provides:
  - "BrfUpload — login-gated PDF dropzone with client type+size validation, calls analyzeBrf (src/components/brf-upload.tsx)"
  - "BrfProgress — polls brf_status every ~1.5s, renders the three D-13 step labels, stops on terminal status (src/components/brf-progress.tsx)"
  - "BrfSection — orchestrates teaser | upload | progress | result branches off the analyses row (src/components/brf-section.tsx)"
  - "analysis/[id]/page.tsx renders BrfSection in place of the BRF ComingSoonSection (D-04), guest state resolved server-side (D-05)"
affects:
  - "Plan 06 (supplies <BrfScoreCard> to replace the minimal 'Analys klar' result slot in BrfSection; wires the eval harness)"

tech-stack:
  added: []
  patterns:
    - "client form → server action via useTransition + FormData (adapts url-input.tsx) with client-side fast-fail validation mirroring the server check"
    - "browser Supabase client poll loop in a useEffect with interval cleanup on terminal status (first poll/realtime pattern in the codebase)"
    - "client orchestrator that seeds initial view-state from server-passed row props so a mid-run reload resumes at the current step"
    - "guest-vs-loggedin decided server-side (page resolves user) and passed as an isGuest prop; UI teaser is defence-in-depth behind the server hard gate (D-05)"

key-files:
  created:
    - "src/components/brf-upload.tsx"
    - "src/components/brf-progress.tsx"
    - "src/components/brf-section.tsx"
  modified:
    - "src/app/(app)/analysis/[id]/page.tsx"

key-decisions:
  - "Polling (not Supabase Realtime) for D-13 progress — the planner explicitly allowed polling as the simplest path that meets the locked UX; ~1.5s interval, cleared on done/failed."
  - "Server-side user resolution in page.tsx (supabase.auth.getUser) drives the isGuest prop; the dropzone is never rendered for guests, and analyzeBrf still hard-gates server-side (T-02-15 defence-in-depth)."
  - "Result view is a minimal 'Analys klar' + grade badge confirmation by design — the full <BrfScoreCard> is Plan 06's scope; this keeps the flow verifiable end-to-end without pre-building Plan 06."
  - "Added an explicit 'failed' branch (not in the plan's four-way list) so the analyzeBrf failure path surfaces the Swedish retry message and re-renders the dropzone instead of a dead progress card (Rule 2 — missing critical UX path)."

patterns-established:
  - "Browser-side polling loop: useEffect creates a browser supabase client, polls a status column on an interval, clears on terminal state via an `active` flag + clearInterval in cleanup."
  - "View-state orchestration component seeded from server props, advancing via onStarted/onComplete callbacks without a full reload."

requirements-completed: []  # BRF-03 / BRF-01 are verified at PHASE END (per plan success criteria) — NOT marked here.

# Metrics
duration: ~10min
completed: 2026-06-14
---

# Phase 2 Plan 05: BRF Upload + Progress Flow Summary

**Turned the static "BRF Analys — Kommer snart" placeholder into a live, login-gated upload→progress→result flow: a guest sees a "Logga in for BRF-analys" teaser, a logged-in user gets a validating PDF dropzone that runs `analyzeBrf` and shows server-driven D-13 step progress that survives a page reload.**

## Performance

- **Duration:** ~10 min
- **Tasks:** 2 of 3 code/wiring tasks complete; Task 3 is a blocking human-verify checkpoint (browser flow with login + a real PDF — cannot be automated).
- **Files created:** 3 (`brf-upload.tsx`, `brf-progress.tsx`, `brf-section.tsx`)
- **Files modified:** 1 (`analysis/[id]/page.tsx`)

## Accomplishments

- **`src/components/brf-upload.tsx`** (`"use client"`) — adapts `url-input.tsx`: a drag-drop + click PDF dropzone (`accept="application/pdf"`), client validation before submit (`file.type !== "application/pdf"` → "Endast PDF-filer stods"; `file.size > 20 MB` → "Filen ar for stor - max 20 MB", D-14), then `startTransition(async () => analyzeBrf(fd))` with `fd` keys `file` + `analysisId`. Errors render in `text-sm text-terracotta-600`; the sage submit button + inline spinner are copied verbatim. Guided-acquisition guidance text ("Hitta arsredovisningen pa maklarens sida") plus an optional non-blocking `agencyListingUrl` deep-link (D-01/D-02 — no scrape, D-03). `onStarted?.()` fires so the parent can switch to progress.
- **`src/components/brf-progress.tsx`** (`"use client"`) — given `analysisId`, a `useEffect` poll loop uses the browser Supabase client to read `brf_status` every ~1.5s under the user's own RLS session (T-02-17: only the status text, never financials). Maps `reading`→"Laser dokumentet...", `extracting`→"Extraherar nyckeltal...", `scoring`→"Beraknar betyg..." in a Card step indicator. On `done`/`failed` it calls `onComplete?.(status)` and clears the interval (cleanup). Seeds from a server-passed `initialStatus` so a reload resumes at the current step (D-13).
- **`src/components/brf-section.tsx`** (`"use client"`) — orchestrator branching on `isGuest` + `brfStatus` + `brfData`: guest teaser linking to `/login` (D-05); upload (no status); progress (status in reading|extracting|scoring); result (status `done` — a minimal "Analys klar" + `Betyg {grade}` badge reading `brfData.grade.grade`); plus a `failed` branch that shows the retry banner and re-renders the dropzone. Seeds view-state from server props and advances via onStarted/onComplete without a full reload.
- **`src/app/(app)/analysis/[id]/page.tsx`** — imports `BrfSection`, resolves the user via `supabase.auth.getUser()` to derive guest state, and replaces ONLY `<ComingSoonSection title="BRF Analys" />` with `<BrfSection analysisId isGuest brfStatus brfData />`. The other three placeholders (Prisjamforelse, Omradesstatistik, AI Rapport) are untouched (D-04). `.select("*")` already returns the brf_* columns — no query change.

## Threat Model Coverage

- **T-02-15 (EoP — guest BRF access):** UI teaser (D-05) is defence-in-depth only; `isGuest` is resolved server-side and the dropzone is never rendered for guests, but the authoritative gate remains `analyzeBrf`'s server-side hard block (Plan 04). Client gating is never trusted alone.
- **T-02-16 (DoS/Tampering — file input):** Client type + size validation is a fast-fail UX layer mirroring the server-side `application/pdf` + 20 MB checks in `analyzeBrf`; the server re-validates identically before any storage/Claude work.
- **T-02-17 (Info disclosure — progress poll):** `accept` disposition — the browser client reads only `brf_status` (status text) under the user's own RLS session; no financials are read during polling.
- No new trust-boundary surface introduced beyond the plan's threat model (no new endpoints; the poll uses the existing RLS-scoped browser client).

## Verification

- `npx tsc --noEmit` — clean (0 errors) after both tasks.
- `npx vitest run` — 5 files, 31 passed + 6 todo (unchanged from the pre-plan baseline; this is UI wiring, no new unit tests in scope).
- Task 1 gate: `analyzeBrf` + `application/pdf` present in brf-upload.tsx; `brf_status` + Laser/Extraherar present in brf-progress.tsx — passed.
- Task 2 gate: `BrfSection` + `Prisjamforelse` present in page.tsx, `ComingSoonSection title="BRF Analys"` absent, `Logga in` present in brf-section.tsx — passed.
- **Task 3 (human-verify, blocking):** NOT yet exercised — requires a browser session with login state and a real arsredovisning PDF. See "Pending Checkpoint" below.

## Deviations from Plan

### Auto-added (Rule 2 — missing critical UX path)

**1. [Rule 2] Added an explicit `failed` branch in BrfSection**
- **Found during:** Task 2 (composing the orchestrator branches).
- **Issue:** The plan listed teaser | upload | progress | result. `analyzeBrf` can persist `brf_status = "failed"` (cost-cap, refusal, schema-invalid), and `BrfProgress` already reports `failed` via `onComplete`. With only the four planned branches, a failed run would leave a dead progress card with no recovery.
- **Fix:** Added a `failed` view that shows the Swedish retry banner ("Vi kunde inte lasa dokumentet automatiskt. Forsok igen.") and re-renders `<BrfUpload>` so the user can retry. No re-architecture; consistent with the existing terracotta-50 banner pattern.
- **Files modified:** `src/components/brf-section.tsx` (created this plan).
- **Commit:** a18cea8

Otherwise the plan was executed as written.

## Browser Verification — deferred to phase-end UAT (Task 3)

Code, type, and unit gates all pass; the remaining check is a browser walkthrough. This is **deferred to phase-end UAT** rather than run in isolation, because Plan 06 modifies the same `brf-section.tsx` to swap the minimal result view for the full `<BrfScoreCard>` — verifying the intermediate UI now and again after Plan 06 would be redundant. The orchestrator will record these as `human_verification` items to run via `/gsd-verify-work` once the complete BRF flow (upload → progress → score card → methodology page) is in place:

1. **Logged out:** open an analysis page → BRF section shows the "Logga in for BRF-analys" teaser, no upload control (D-05); the other three "Kommer snart" sections unchanged.
2. **Logged in:** a PDF dropzone appears. A non-PDF and a >20 MB file are both rejected client-side with a Swedish error (D-14).
3. **Upload a real arsredovisning:** step progress cycles Laser → Extraherar → Beraknar (D-13). Reload mid-run → resumes at the current step (server-persisted status).
4. **On completion:** the result view appears (full score card after Plan 06).

## Known Stubs

- **`BrfSection` result view** is an intentional minimal "Analys klar" + grade badge, NOT the full score card. This is by plan design — `<BrfScoreCard>` is Plan 06's deliverable, which will replace this slot. The flow is fully wired (upload → progress → result) so it is verifiable end-to-end; only the rich result rendering is deferred. The in-session result view notes "Ladda om sidan for att se hela betygskortet" because the freshly-persisted `brf_data` is not re-fetched without a reload (a deliberate scope line — live result hydration belongs with the score card in Plan 06).

## Self-Check: PASSED

- src/components/brf-upload.tsx — FOUND
- src/components/brf-progress.tsx — FOUND
- src/components/brf-section.tsx — FOUND
- src/app/(app)/analysis/[id]/page.tsx — FOUND (modified)
- Commit 37718ea — FOUND
- Commit a18cea8 — FOUND

## Commits

- `37718ea` feat(02-05): add BrfUpload dropzone and BrfProgress status poll
- `a18cea8` feat(02-05): add BrfSection orchestrator and wire into analysis page
