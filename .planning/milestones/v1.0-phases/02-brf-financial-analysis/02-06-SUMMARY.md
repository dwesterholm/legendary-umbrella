---
phase: 02-brf-financial-analysis
plan: 06
subsystem: ui
tags: [react, nextjs, tailwind, shadcn, brf, trust-ux, server-actions]

# Dependency graph
requires:
  - phase: 02-brf-financial-analysis (plan 03)
    provides: computeBrfGrade + BRF_SCORE_THRESHOLDS (deterministic scorer, single source of truth)
  - phase: 02-brf-financial-analysis (plan 04)
    provides: analyzeBrf + correctBrfField server actions; BrfData payload shape; extraction.<metric>.sourceQuote/.pageRef provenance
  - phase: 02-brf-financial-analysis (plan 05)
    provides: brf-section.tsx result slot (minimal "Analys klar" placeholder) replaced here
provides:
  - BrfScoreCard component (A–F grade + per-metric breakdown + confidence flags + source quotes + inline edit)
  - BrfSection done-branch now renders the full score card, hydrated from persisted brf_data
  - Public /sa-raknar-vi methodology page publishing every threshold/weight from the shared scorer constants
affects: [phase-end-uat, future-brf-ui, marketing-trust-page]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Inline-edit-then-re-score via server action (correctBrfField), never re-extracting/re-billing Claude (D-12)"
    - "Public marketing/trust page placed OUTSIDE the auth-gated (app) route group so it renders for logged-out visitors"
    - "Methodology page renders scorer constants directly (BRF_SCORE_THRESHOLDS / BRF_SANITY_BANDS) — zero hardcoded threshold duplication"

key-files:
  created:
    - src/components/brf-score-card.tsx
    - src/app/sa-raknar-vi/page.tsx
  modified:
    - src/components/brf-section.tsx

key-decisions:
  - "Placed sa-raknar-vi at src/app/sa-raknar-vi (root) instead of the planned src/app/(app)/sa-raknar-vi — the (app) layout hard-redirects guests to /login, which would break D-09's public requirement"
  - "Confidence badge shows 'Säkerhet N%' when in-band, flips to destructive 'Osäker — kontrollera själv' below OSAKER_THRESHOLD (imported, never duplicated)"
  - "Source quote rendered as an expandable <details> 'Visa källa (sid N)' reveal to keep the breakdown compact"

patterns-established:
  - "Trust-UX card: grade banner + per-metric tile with rating/weight/confidence/provenance/edit affordance"
  - "Single-source-of-truth public methodology: import scorer constants, render, never re-state numbers"

requirements-completed: []  # BRF-01/BRF-02 verified at phase end per orchestrator instruction — NOT marked here

# Metrics
duration: ~12min
completed: 2026-06-14
---

# Phase 2 Plan 6: BRF Result Display + Public Methodology Page Summary

**BrfScoreCard renders the deterministic A–F grade with a per-metric breakdown, "Osäker" confidence flags, per-field source quotes/page refs, and inline corrections that re-score via `correctBrfField` without re-calling Claude; the public `/sa-raknar-vi` page publishes every threshold and weight straight from the shared scorer constants.**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-06-14T12:40:00Z (approx)
- **Completed:** 2026-06-14T12:53:00Z
- **Tasks:** 2 implementation tasks complete (Task 3 is a browser-verify checkpoint deferred to phase-end UAT)
- **Files modified:** 3 (2 created, 1 modified)

## Accomplishments
- `BrfScoreCard` shows a prominent colour-coded A–F grade (A/B sage, C/D terracotta, E/F destructive-red) and a per-metric breakdown with each metric's value, mini-rating, and weight contribution (D-07).
- Per-field confidence indicator that flips to a destructive "Osäker — kontrollera själv" badge below the imported `OSAKER_THRESHOLD`; corrected fields show a sage "Manuellt angiven" badge (D-10/D-12).
- Verbatim source quote + page reference per figure, read directly from `extraction.<metric>.sourceQuote` / `.pageRef` (D-11) — NOT from the empty `citations` array (per 02-04 guidance).
- Inline editor calls `correctBrfField` via `useTransition` (never `analyzeBrf`), re-renders the re-scored grade/breakdown from the returned payload, and lifts it to `BrfSection` via `onCorrected` (D-12, no Claude re-bill).
- Public `/sa-raknar-vi` methodology page rendering every metric definition, threshold band, and weight from `BRF_SCORE_THRESHOLDS` + `BRF_SANITY_BANDS` (D-09, fulfills BRF-02) — no DB query, no auth, no Claude.

## Task Commits

Each task was committed atomically:

1. **Task 1: BrfScoreCard** - `004dc1b` (feat)
2. **Task 2: Wire BrfScoreCard into BrfSection + public methodology page** - `1dc9d41` (feat)

_Task 3 is a `checkpoint:human-verify` browser walkthrough — no code commit; deferred to phase-end UAT by the orchestrator._

## Files Created/Modified
- `src/components/brf-score-card.tsx` (created) - Client component: grade banner, breakdown tiles, confidence/provenance/manual badges, expandable source-quote reveal, inline numeric/enum editor wired to `correctBrfField`.
- `src/app/sa-raknar-vi/page.tsx` (created) - Public async server component (no auth/DB/Claude) rendering the full methodology from the imported scorer + sanity constants.
- `src/components/brf-section.tsx` (modified) - `done` branch now renders `<BrfScoreCard>` hydrated from persisted `brf_data`, with a reload-prompt fallback when an in-session completion has no payload yet.

## Decisions Made
- **Methodology page location:** placed at `src/app/sa-raknar-vi/page.tsx` (root, public) rather than the plan's `src/app/(app)/sa-raknar-vi/page.tsx`. The `(app)` route-group layout calls `redirect("/login")` for unauthenticated users, which would make the page auth-gated and break D-09 ("loads while logged OUT") and threat T-02-19 ("unauthenticated read"). See Deviations.
- **Provenance source:** rendered from `extraction.<metric>.sourceQuote/.pageRef` (schema fields), honoring 02-04's note that the API-level `citations` array is empty by design.
- **Confidence display:** in-band fields show a neutral "Säkerhet N%" badge; only sub-threshold fields show the destructive "Osäker" flag, matching the D-10 contract without over-flagging.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Public methodology page moved out of the auth-gated (app) route group**
- **Found during:** Task 2 (methodology page creation)
- **Issue:** The plan's `files_modified` and verify step specify `src/app/(app)/sa-raknar-vi/page.tsx`. The `(app)` route group's `layout.tsx` performs a hard `redirect("/login")` for any guest. Putting the page there would make it impossible to satisfy the D-09 acceptance criterion ("Visit /sa-raknar-vi while logged OUT; confirm it loads (public)") and the T-02-19 mitigation ("Unauthenticated read").
- **Fix:** Created the page at `src/app/sa-raknar-vi/page.tsx` (sibling to the root public `page.tsx`, outside any auth-gated group). The route URL `/sa-raknar-vi` is unchanged; the warm-palette layout from the analysis page is mirrored inline. No DB query, no auth call, no Claude import — verified by grep.
- **Files modified:** src/app/sa-raknar-vi/page.tsx
- **Verification:** `npx tsc --noEmit` clean; grep confirms `BRF_SCORE_THRESHOLDS` + `BRF_SANITY_BANDS` imported and no `getUser`/`createClient`/`redirect`/Claude imports present.
- **Committed in:** `1dc9d41` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** The single deviation was required to satisfy the plan's own public-page acceptance criterion; the route URL and content are exactly as specified. No scope creep.

## Issues Encountered
None — both implementation tasks completed cleanly. `npx tsc --noEmit` passes and the full vitest suite stays green (5 files, 31 passed, 6 todo).

## Known Stubs
None — the score card and methodology page render live data (`brf_data` payload and the imported scorer constants respectively). No hardcoded empty values or placeholder data sources.

## Checkpoint Deferred to UAT
Task 3 (`checkpoint:human-verify`, `gate="blocking"`) is a browser walkthrough confirming the grade/breakdown render, the Osäker flag, source quotes, inline re-score (no Claude call), and the public methodology page while logged out. Per the executor's checkpoint note this pure browser-verify gate is folded into phase-end UAT by the orchestrator. All implementation is complete and type/test-verified.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 2 implementation is complete: the full BRF trust payload (grade, breakdown, confidence, provenance, inline edit) and the public methodology page are wired end to end.
- Requirements BRF-01/BRF-02/BRF-03 are intentionally NOT marked complete here — they are verified at phase end (orchestrator instruction).
- Ready for phase-end UAT (which absorbs Task 3's browser verification).

---
*Phase: 02-brf-financial-analysis*
*Completed: 2026-06-14*

## Self-Check: PASSED
- FOUND: src/components/brf-score-card.tsx
- FOUND: src/app/sa-raknar-vi/page.tsx
- FOUND: src/components/brf-section.tsx (modified)
- FOUND commit: 004dc1b (Task 1)
- FOUND commit: 1dc9d41 (Task 2)
- tsc --noEmit clean; vitest 5 files / 31 passed / 6 todo
