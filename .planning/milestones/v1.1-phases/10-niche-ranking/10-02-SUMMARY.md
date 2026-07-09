---
phase: 10-niche-ranking
plan: 02
subsystem: discovery
tags: [react, client-component, discovery, niche-ranking, ui]

# Dependency graph
requires:
  - phase: 10-niche-ranking
    plan: 01
    provides: "DiscoveryCandidate 10-field PII-safe allowlist, computeNicheScore pure deterministic scorer, NICHE_WEIGHTS/NICHE_IDS"
provides:
  - "DiscoveryNicheSelector — controlled shadcn Select for the 4 fixed niche options"
  - "DiscoveryResults — client-side reorder owner (niche state, median-of-candidates area baseline, degenerate/error banners)"
  - "DiscoveryCandidateCard extended with optional rank badge + cited-signal chips"
  - "NICHE_SIGNAL_LABELS/NICHE_SIGNAL_SOURCE_LABELS hedged Swedish chip-label map"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "DiscoveryCandidateCard's additive optional props (rankPosition/nicheSignals) keep the Phase 9 call site unchanged — the extension pattern for grafting Phase 10 UI onto Phase 9 components"
    - "DiscoveryResults mirrors report-flags.tsx's chip vocabulary verbatim (rounded-lg border bg-warm-gray-50 + Badge + Källa caption) but strips severityChip() — niche signals are explanatory facts, never verdicts"
    - "Client-side useMemo re-sort over already-persisted data, zero network — the pattern for any future 'final pass over already-fetched results' UI"

key-files:
  created:
    - src/components/discovery-niche-selector.tsx
    - src/components/discovery-results.tsx
    - src/components/discovery-results.test.tsx
    - src/components/discovery-candidate-card.test.tsx
  modified:
    - src/lib/discovery/niche-score.ts
    - src/lib/discovery/niche-score.test.ts
    - src/components/discovery-candidate-card.tsx
    - src/app/(app)/discover/[jobId]/page.tsx

key-decisions:
  - "Area baseline computed as a PURE client-side median price/sqm over the candidate set itself, NOT via server-side compare.ts/fetchSoldComps reuse as RESEARCH.md Open Question 4 / 10-PATTERNS.md originally planned — discovery jobs persist no lat/lng or breadcrumbs (only filters + the PII-safe results allowlist), so compare.ts's SoldSourceQuery cannot be constructed from a stored job. This keeps the phase 100% client-side / zero-new-network, honoring the 'no new Server Action, no re-run' constraint even more strictly than the originally-planned route."
  - "Radix Select's scroll/pointer-capture APIs (scrollIntoView, hasPointerCapture, setPointerCapture, releasePointerCapture) are missing in jsdom — polyfilled locally inside discovery-results.test.tsx (this is the first Select-driven RTL test in the codebase; Phase 9's filter Select has no component test), not added to the shared vitest.setup.ts"
  - "NICHE_SIGNAL_LABELS/NICHE_SIGNAL_SOURCE_LABELS live in niche-score.ts (not a new file) — mirrors report-flags.tsx's co-located FLAG_LABELS/SOURCE_LABELS pattern, keeping the chip vocabulary next to the scorer that produces the keys it labels"

patterns-established:
  - "Client-side reorder over already-fetched data (DiscoveryResults) as the template for any future in-place ranking/sort UI that must not re-enter the backend"

requirements-completed: [DISC-03]

# Metrics
duration: 18min
completed: 2026-07-07
---

# Phase 10 Plan 2: Niche Ranking Frontend Summary

**Shipped the user-visible half of DISC-03: a controlled niche Select, a client-side `DiscoveryResults` component that re-sorts already-persisted candidates in place via `useMemo` (zero network, no new Server Action, no job re-run), an extended `DiscoveryCandidateCard` with a plain ordinal rank badge and up to 3 cited-signal chips (never an opaque score), and the `page.tsx` wiring — with degenerate, no-signal, and computation-error states all degrading gracefully per the UI-SPEC.**

## Performance

- **Duration:** 18 min
- **Started:** 2026-07-07T16:16:00Z
- **Completed:** 2026-07-07T16:20:30Z
- **Tasks:** 3 completed
- **Files modified:** 8 (4 created, 4 modified)

## Accomplishments
- `NICHE_SIGNAL_LABELS`/`NICHE_SIGNAL_SOURCE_LABELS` added to `niche-score.ts` — the single Swedish chip-label vocabulary the UI reads, mirroring `report-flags.tsx`'s `FLAG_LABELS`/`SOURCE_LABELS` lookup pattern; `stambyteProxyAge`'s label is explicitly hedged ("Byggår tyder på möjligt stambytesbehov — bekräfta med BRF-analys"), asserted by unit test to contain hedge wording and never a confirmed "betalar" claim
- `DiscoveryNicheSelector` — a controlled `"use client"` Select with the 4 fixed Swedish-labeled options in locked order, no internal state (selection owned by the parent), reusing the existing shadcn `Select` primitive with zero new registry surface
- `DiscoveryCandidateCard` extended additively: optional `rankPosition`/`nicheSignals` props, a sage `#{n}` badge (identical styling across every rank, no color gradient), up to 3 severity-neutral cited-signal chips reusing `ReportFlags`' exact markup, and the italic no-signal caption when a niche is active but a candidate has zero assessable signals — the Phase 9 call site (neither prop passed) renders byte-identically to before
- `DiscoveryResults` — the client-side reorder owner: `useState` niche selection, `useMemo` re-sort wrapped in try/catch (error → unranked fallback + terracotta banner), a pure client-side median-price/sqm area baseline computed from the candidate set itself, a `< 3 candidates` degenerate check (original order + terracotta banner, no rank badges), and stable `sourceListingUrl` card keys so React actually re-orders the visible DOM
- `page.tsx`'s done+candidates branch now delegates to `<DiscoveryResults candidates={candidates} />` — every other branch (auth/ownership guard, empty-state, failed/degraded) is byte-unchanged

## Task Commits

Each task was committed atomically:

1. **Task 1: Chip-label + hedged-copy map, and the niche selector component** - `082bed7` (feat)
2. **Task 2: Extend DiscoveryCandidateCard with rank badge + cited-signal chips** - `c0800fe` (feat)
3. **Task 3: DiscoveryResults client reorder and page.tsx wiring** - `e2661e0` (feat)

**Plan metadata:** _pending_ (docs: complete plan — committed after this summary)

## Files Created/Modified
- `src/lib/discovery/niche-score.ts` - Added `NICHE_SIGNAL_LABELS`/`NICHE_SIGNAL_SOURCE_LABELS` hedged Swedish chip-label maps
- `src/lib/discovery/niche-score.test.ts` - New test: `stambyteProxyAge` label is hedged, never contains "betalar"
- `src/components/discovery-niche-selector.tsx` - NEW: controlled Select, 4 fixed options, no internal state
- `src/components/discovery-candidate-card.tsx` - Extended with optional `rankPosition`/`nicheSignals` props, rank badge, cited-signal chip block, no-signal caption; updated doc comment
- `src/components/discovery-candidate-card.test.tsx` - NEW: 5 test cases (base-card-unchanged, rank+chips, hedged stambyte chip, no-signal caption, no-opaque-score)
- `src/components/discovery-results.tsx` - NEW: client reorder owner, area-baseline helper, degenerate/error states
- `src/components/discovery-results.test.tsx` - NEW: 4 test cases (initial order, visible reorder with no fetch call, degenerate banner, error fallback); includes local jsdom Radix-Select polyfills
- `src/app/(app)/discover/[jobId]/page.tsx` - `DiscoveryCandidateCard` import replaced with `DiscoveryResults`; done+candidates branch swapped to `<DiscoveryResults candidates={candidates} />`

## Decisions Made
- Area baseline: pure client-side median price/sqm over the candidate array itself, NOT a server-side `compare.ts`/`fetchSoldComps` call — RESEARCH.md Assumption A4 did not hold because discovery jobs persist no lat/lng/breadcrumbs. See Deviations below.
- Radix Select's jsdom gaps (`scrollIntoView`, pointer-capture methods) polyfilled locally in the new test file rather than the shared `vitest.setup.ts`, since this is the first Select-driven component test in the repo and the blast radius should stay scoped to this file until a second consumer needs it.
- Chip-label maps co-located in `niche-score.ts` (not a new file) — keeps the Swedish vocabulary next to the scorer that mints the keys it labels, mirroring `report-flags.tsx`'s own co-location of `FLAG_LABELS` beside the component that renders them.

## Deviations from Plan

### Auto-fixed Issues

None — no bugs, missing functionality, or blocking issues required a Rule 1/2/3 fix beyond what the plan already anticipated.

### Planned Deviation (called out by the plan itself)

**1. Area-baseline computation is pure client-side median-of-candidates, not server-side `compare.ts` reuse**
- **Found during:** Task 3 (plan's `<action>` text pre-flagged this as an expected deviation from RESEARCH.md Open Question 4 / 10-PATTERNS.md's originally-sketched `page.tsx` extension)
- **Issue:** RESEARCH.md Assumption A4 assumed the area baseline would be computed once server-side (in `page.tsx`) by reusing `src/lib/market/compare.ts`'s `computePriceComparison`/`fetchSoldComps` aggregate machinery, keyed on the job's resolved area (lat/lng or breadcrumbs). Discovery jobs, however, persist only `filters` (the structured `DiscoveryFilter`) and the PII-safe `results` allowlist (migration 010) — no lat/lng, no breadcrumbs, no geo query is ever stored. `compare.ts`'s `SoldSourceQuery` shape cannot be constructed from a stored job without adding new persistence.
- **Fix:** `discovery-results.tsx` computes a pure, synchronous `computeAreaBaseline(candidates)` helper: median of `price/livingArea` across candidates with usable (non-null, `livingArea > 0`) values, returning `null` below a `MIN_BASELINE_SAMPLE` floor of 3 (mirrors `compare.ts`'s own thin-sample-honesty discipline). Zero new network calls, zero new schema, zero new Server Action.
- **Files modified:** `src/components/discovery-results.tsx` (documented in a load-bearing doc comment above `computeAreaBaseline`)
- **Verification:** `npx vitest run src/components/discovery-results.test.tsx` — all 4 cases green; full suite green; `tsc --noEmit` clean.
- **Committed in:** `e2661e0`

---

**Total deviations:** 1 (a plan-anticipated, documented architecture choice — not a bug fix; no Rule 4 architectural-change checkpoint was needed because the plan's own `<action>` text pre-authorized this exact fallback).
**Impact on plan:** None on scope or user-visible behavior — the ranking still reorders correctly using price/sqm-vs-baseline; the baseline source is just narrower (candidate-set median vs area-wide sold comps), which is honestly the more conservative/defensible number for a first-pass ranking signal anyway.

## Issues Encountered
- jsdom does not implement `Element.prototype.scrollIntoView`/`hasPointerCapture`/`setPointerCapture`/`releasePointerCapture`, which Radix UI's `Select` internals call on open/select. This is the first Select-driven RTL test in the codebase (Phase 9's filter `Select` has no component test), so the gap hadn't surfaced before. Resolved with a local `beforeAll` polyfill block in `discovery-results.test.tsx` — no production code change, test-infrastructure-only.
- The initial test plan used `getAllByRole("heading", { level: 3 })` to distinguish card titles, but shadcn's `CardTitle` renders a `<div>`, not a semantic heading element — switched all three affected assertions to `getAllByText(/gatan/i)` (matching the fixture addresses), which is both more robust and closer to what a user actually sees reorder.

## User Setup Required

None — no external service configuration required. No migration, no new package, no new shadcn/registry component (Select and Badge were already installed in Phase 9).

## Next Phase Readiness

Phase 10 (Niche Ranking) is now feature-complete per its two-plan scope:
- Plan 10-01 shipped the data extension + deterministic scorer core.
- Plan 10-02 (this plan) shipped the user-visible selector, ranked cards, and client-side reorder.

**Outstanding per the plan's `<verification>` section — a manual UAT kill-criterion check is still required before Phase 10 is considered validated end-to-end:**
Run one real discovery job with `DISCOVERY_ENABLED=true`, switch niches, and confirm orderings visibly change and are defensible via cited signals. If the 3 niches produce near-identical orderings on real data, the recommendation is to ship filtering-only and defer ranking. This is a human/live-data verification step outside the scope of automated test coverage — see Operator Next Steps in STATE.md.

No blockers for Phase 11 (Gallery Condition Vision) — it does not depend on this plan's UI surface.

---
*Phase: 10-niche-ranking*
*Completed: 2026-07-07*

## Self-Check: PASSED

All 8 created/modified source files confirmed present on disk; all 3 task commit hashes (`082bed7`, `c0800fe`, `e2661e0`) confirmed present in `git log`. Full test suite (501 passed, 2 skipped), `tsc --noEmit` clean, and `npm run build` all verified green.
