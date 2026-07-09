---
phase: 09-discovery-foundation
plan: 02
subsystem: discovery
tags: [booli, playwright, apify, area-resolution, fallback, discovery]

# Dependency graph
requires:
  - phase: 09-discovery-foundation
    provides: "Plan 01's filter-schema/cost/candidate contracts (DiscoveryFilter, DiscoveryCandidate shape) that Plan 03's scrape orchestration will compose with this plan's resolveArea"
provides:
  - "resolveArea(name) -> { areaId, source: 'probe'|'seed' } | null — the free-text area-name resolution Plan 03's scrape path depends on"
  - "AREA_SEARCH_PAGE_FUNCTION — implemented but NOT live-confirmed probe interaction (types Booli's search box, captures areaIds=)"
  - "AREA_SEED — small Stockholm-region-only launch seed list, shipping as the PRIMARY resolution path for v1"
affects: ["09-discovery-foundation Plan 03 (scrape orchestration)", "10-niche-ranking"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Probe-then-seed resolution: an unverified-live external-DOM probe is implemented as a best-effort first path, with a small static fallback guaranteeing the caller never hard-blocks — reusable for any future 'external free-text -> opaque ID' resolution need"
    - "Active (interaction-driving) page function as a sibling to a passive Apollo-state-scan page function, never a modification of the passive one (page-functions.ts stays untouched)"

key-files:
  created:
    - src/lib/booli/area-search-page-function.ts
    - src/lib/discovery/resolve-area.ts
    - src/lib/discovery/resolve-area.test.ts
    - src/lib/discovery/area-seed.ts
  modified: []

key-decisions:
  - "SHIPPING PATH FOR v1 IS SEED-PRIMARY, NOT PROBE-PRIMARY. The live search-box probe (Task 2) was NOT run this execution per explicit operator pre-approval to defer the live Apify spend. resolveArea still attempts the probe first in code (so it activates automatically the moment it's confirmed reliable), but until an operator runs the live confirmation, in practice every resolution in the current 3-entry AREA_SEED will resolve via the seed path (the probe will consistently miss against the unconfirmed selector) — the seed list IS what ships working today."
  - "Geographic coverage is LIMITED TO STOCKHOLM-REGION in v1 (Södermalm, Stockholm kommun, Nacka only — 3 entries). This is a deliberate, documented scope reduction, not an oversight. Broader coverage requires EITHER the live probe being confirmed reliable (unblocks all of Sweden) OR manually growing the seed list (each addition needs a human-verified areaId, not a guess)."
  - "AREA_SEARCH_PAGE_FUNCTION selector (#area-search-field) and the suggestion-list interaction flow are UNCONFIRMED against the live DOM (MEDIUM-confidence per 09-RESEARCH.md Assumptions Log A3). The probe code defensively returns a miss (never throws) on any selector/timing failure, so an incorrect selector today just means every probe call falls through to seed — it does not break resolveArea's contract."
  - "area-seed.ts is explicitly documented as a v1 scope-reduction, NOT a comprehensive AREA_ID_MAP (RESEARCH Pitfall 3) — the header comment states this plainly and grep confirms no AREA_ID_MAP constant exists anywhere in the diff."

patterns-established:
  - "Probe-then-seed resolution pattern: try an unverified live external interaction first, fall back to a small human-curated static list, never fabricate a result — reusable for any future opaque-ID resolution against an undocumented third-party UI."

requirements-completed: [DISC-01]

# Metrics
duration: 20min
completed: 2026-07-07
---

# Phase 9 Plan 2: Area-Name Resolution (Probe + Seed Fallback) Summary

**resolveArea(name) probe-then-seed resolver: live Booli search-box probe code implemented but NOT live-confirmed (operator-deferred per pre-approval); a 3-entry Stockholm-region-only AREA_SEED ships as the actual working v1 primary path.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-07-07T11:16Z (approx.)
- **Completed:** 2026-07-07T11:20Z (approx.)
- **Tasks:** 1 of 2 executed (Task 2 is a live-probe checkpoint, auto-approved-but-deferred per orchestrator instruction — see below)
- **Files modified:** 4 (all new)

## Accomplishments

- `AREA_SEARCH_PAGE_FUNCTION` written as a sibling to `APOLLO_PAGE_FUNCTION` — an ACTIVE page function that types a free-text query into Booli's observed `#area-search-field`, waits for a suggestion list, clicks the first suggestion, and captures the resulting `areaIds=` URL. Defensively returns a miss (never throws) on any selector/timing failure.
- `resolveArea(name)` implemented with the full probe-then-seed contract: tries the live probe via `isBooliUrl`-validated + `runPlaywrightRender`-driven render first, falls back to `seedResolve` on any probe miss/throw, returns `null` (never fabricates an id) if both miss.
- `AREA_SEED` — a small, explicitly-commented, human-verified 3-entry Stockholm-region seed list (Södermalm, Stockholm kommun, Nacka) with a header comment flagging it as a deliberate v1 scope reduction, not a comprehensive lookup table.
- `seedResolve` — case-insensitive, trimmed, EXACT match only (no `.includes()` fuzzy matching that could mis-map a near-miss name).
- Mocked-transport branching tests prove all three outcomes: probe-success → `source:"probe"`, probe-failure/no-match → falls to seed → `source:"seed"`, both-miss → `null`; plus `seedResolve`'s case-insensitivity and near-miss rejection.

## Task Commits

Each task was committed atomically:

1. **Task 1: Area-search page function + resolveArea (probe path) + static seed fallback** - `a623c42` (feat)

**Plan metadata:** (this commit)

_Task 2 ("[SPIKE] Live area-resolution probe") is a `checkpoint:human-verify` gate requiring operator-approved Apify spend. Per explicit orchestrator pre-approval for this execution, the live probe was NOT run — see "Operator Next Steps" below._

## Files Created/Modified

- `src/lib/booli/area-search-page-function.ts` - `AREA_SEARCH_PAGE_FUNCTION` + `AREA_SEARCH_FIELD_SELECTOR` constant; the browser-side search-box interaction, unconfirmed against the live DOM.
- `src/lib/discovery/resolve-area.ts` - `resolveArea(name)` (probe-then-seed) + `AreaResolution` type; `isBooliUrl` + `runPlaywrightRender` reused directly, no new URL-validation or Apify-client instantiation.
- `src/lib/discovery/area-seed.ts` - `AREA_SEED` (3-entry Stockholm-region map) + `seedResolve` exact matcher.
- `src/lib/discovery/resolve-area.test.ts` - mocked-transport branching tests (probe success/failure/both-miss) + `seedResolve` case-insensitivity/near-miss/empty-input tests.

## Decisions Made

See `key-decisions` in frontmatter. The most consequential decision for downstream planning: **the shipping v1 path is seed-primary, not probe-primary**, and geographic coverage is Stockholm-region-only until the live probe is confirmed. This is a direct, explicit consequence of the checkpoint pre-approval instruction for this execution (defer live Apify spend), not a silent scope cut — it is the plan's own documented fallback design working exactly as specified.

## Deviations from Plan

None - plan executed exactly as written for Task 1. Task 2 (the live-probe checkpoint) was handled per explicit orchestrator instruction: auto-approved-but-deferred rather than either run live or left as a hard blocker. This is not a Rule 1-4 deviation — it is the checkpoint's own documented resume path ("Either approval unblocks the phase — the seed fallback guarantees it never hard-blocks") exercised via the pre-approved deferred branch instead of an interactive operator response.

## Issues Encountered

None. All acceptance criteria for Task 1 verified:
- `resolve-area.ts` calls `isBooliUrl` before any render and uses `runPlaywrightRender` (grep-confirmed; no new `ApifyClient` instantiation anywhere in the new files).
- `area-seed.ts` contains a small explicitly-commented seed set (3 entries), not a comprehensive `AREA_ID_MAP` (grep confirms `AREA_ID_MAP` appears only inside a comment explaining what this file is NOT).
- Mocked-transport tests prove probe-success → `source:"probe"`, probe-failure → seed fallback → `source:"seed"`, both-miss → `null`.
- `seedResolve` matches case-insensitively/exactly and does not false-match "Söder", "Nack", or "Södermalmen" against "södermalm"/"nacka".
- `npx vitest run src/lib/discovery/resolve-area.test.ts` — 8/8 tests green.
- Full suite (`npx vitest run`) — 435 passed, 1 pre-existing skip, 0 failures.
- `npx tsc --noEmit` — clean, no errors.
- `npx eslint` on all 4 new files — clean, no warnings/errors.

## User Setup Required

**None required to use the shipping v1 path** (seed-list resolution needs no external service). However, per the checkpoint pre-approval, the following live-probe confirmation is DEFERRED and should be run by the operator before the probe path is trusted as primary:

### Operator Next Steps — Live Probe Confirmation (Task 2, deferred)

1. Ensure `APIFY_API_TOKEN` is set (already required since Phase 5 — Apify Console → Settings → Integrations).
2. Run a throwaway live invocation of `resolveArea("Södermalm")` — e.g. a scratch script:
   ```typescript
   import { resolveArea } from "@/lib/discovery/resolve-area";
   const result = await resolveArea("Södermalm");
   console.log(result); // expect { areaId: "115341", source: "probe" }
   ```
   This runs a SMALL operator-approved Apify spend (a handful of interactive renders) — same posture as the Phase 5/8 spikes.
3. Confirm the returned `areaId` matches the known Södermalm id (115341, same as `AREA_SEED`/`client.ts`'s doc comment) — cross-check against a manual visit to `https://www.booli.se/sok/till-salu?areaIds=115341`.
4. Inspect whether `#area-search-field` is the REAL selector on the live page. If the live DOM uses a different selector or interaction flow (debounced XHR-per-keystroke vs. a client-side pre-loaded dataset), update `AREA_SEARCH_FIELD_SELECTOR`/`AREA_SEARCH_PAGE_FUNCTION` in `src/lib/booli/area-search-page-function.ts` accordingly — `resolveArea`'s probe-then-seed contract does not need to change, only the selector/interaction body.
5. Try a second area (e.g. "Nacka") to confirm the probe generalizes beyond one hardcoded case.
6. **DECISION to record once run:** if the probe is reliable, flip the mental model to "probe ships as primary, seed is the safety net" (no code change needed — `resolveArea` already tries probe first); if it is flaky/unreliable, explicitly keep seed-primary and file broader probe reliability work as a post-launch improvement. Either outcome is a safe, non-blocking decision — `resolveArea` behaves correctly either way.

**Until this is run: treat all area resolution in v1 as SEED-PRIMARY and STOCKHOLM-REGION-LIMITED (Södermalm, Stockholm, Nacka only).** Any user typing an area name outside this 3-entry seed list will get a `null` resolution (probe will very likely also miss against the unconfirmed selector) and should be surfaced a "couldn't resolve area" message by the caller — this is expected v1 behavior, not a bug, and is the direct, deliberate tradeoff of deferring the live-probe checkpoint.

## Known Stubs

None. `resolveArea`, `AREA_SEED`, and `AREA_SEARCH_PAGE_FUNCTION` are all fully implemented, real code paths — nothing is hardcoded to return empty/placeholder values. The LIMITATION is scope (3 seed entries, unconfirmed probe selector), not a stub — every code path does real work and fails honestly (`null`) rather than faking success.

## Threat Flags

None. Both threat-register rows this plan owns (T-09-03 SSRF via `isBooliUrl` reuse, T-09-04 source-only logging) are implemented exactly as specified in the plan's threat model — no new surface introduced beyond what was already flagged.

## Next Phase Readiness

- `resolveArea` is fully wired and tested — Plan 03's scrape orchestration can call it directly and branch on `{ areaId, source }` without any further contract changes, regardless of whether the live probe is later confirmed.
- **BLOCKER FOR BROADER LAUNCH (not for Plan 03 itself):** v1 discovery only resolves Stockholm-region area names (3 seed entries) until the live probe (Task 2) is run and confirmed by the operator. Plan 03/04 and any UI copy should account for this — either by explicitly scoping the v1 UI to "Stockholm-region" language, or by treating `resolveArea` returning `null` as an expected, user-facing "we don't cover that area yet" state (not an error).
- No other blockers. Plan 03 (scrape orchestration/tick logic) and Plan 04 (UI) can proceed using `resolveArea` as specified.

---
*Phase: 09-discovery-foundation*
*Completed: 2026-07-07*

## Self-Check: PASSED

All 4 created files verified present on disk; task commit hash a623c42 verified present in git log.
