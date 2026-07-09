---
phase: 09-discovery-foundation
plan: 04
subsystem: ui
tags: [nextjs, react, server-actions, vercel-cron, shadcn, discovery]

# Dependency graph
requires:
  - phase: 09-discovery-foundation
    provides: "Plan 01's discovery_jobs table + claim_discovery_slice RPC + DiscoveryCandidate/filter-schema/cost contracts; Plan 03's startDiscovery/tickDiscovery Server Actions"
provides:
  - "DiscoveryInput — free-text + optional hard-filter form, low-confidence 'Stämmer detta?' confirm, kill-switch banner"
  - "DiscoveryProgress — poll-AND-tick client driver (the client-tick-drives-the-queue mechanism), single counter line, status Badge, cap-reached + degraded terracotta banners"
  - "DiscoveryCandidateCard — PII-safe candidate card, 'Källa: Booli' provenance, no match score"
  - "/discover + /discover/[jobId] — flag-gated (notFound when off) + ownership-gated (IDOR notFound) routes"
  - "Dashboard discovery entry point — fully absent when DISCOVERY_ENABLED is off"
  - "/api/discovery/sweep + vercel.json — once-daily Vercel Cron orphan-resume safety net (Hobby-valid)"
affects: ["10-niche-ranking (candidate card will need a ranking/score affordance added, currently absent by design)"]

# Tech tracking
tech-stack:
  added: ["shadcn select (official registry)", "shadcn textarea (official registry)"]
  patterns:
    - "Poll-AND-tick client driver: DiscoveryProgress's poll() calls tickDiscovery(jobId) BEFORE reading discovery_jobs status — the one divergence from BrfProgress's pure-read polling, making the client's own setInterval double as the job's work trigger"
    - "Route Handler maxDuration vs. Server Action maxDuration are NOT interchangeable: Next.js's Server Actions bundler only permits async-function exports from a \"use server\" file, while Route Handlers DO support a plain `export const maxDuration` — a real compiler-level distinction invisible to vitest, only surfaced by `npm run build`"
    - "Feature-flag defense-in-depth at three independent layers: action (Plan 03, literal first line), route (notFound() before auth), and UI entry point (returns null) — each layer fails closed independently"

key-files:
  created:
    - src/components/discovery-input.tsx
    - src/components/discovery-progress.tsx
    - src/components/discovery-progress.test.tsx
    - src/components/discovery-candidate-card.tsx
    - src/app/(app)/discover/page.tsx
    - src/app/(app)/discover/[jobId]/page.tsx
    - src/app/api/discovery/sweep/route.ts
    - src/lib/discovery/tick-config.ts
    - vercel.json
  modified:
    - src/app/(app)/dashboard/page.tsx
    - src/lib/discovery/candidate.ts
    - src/actions/tick-discovery.ts
    - src/actions/tick-discovery.test.ts

key-decisions:
  - "TICK_DISCOVERY_MAX_DURATION_SEC moved to a new src/lib/discovery/tick-config.ts module rather than staying as `export const maxDuration = 300` inside tick-discovery.ts — Next.js's Server Actions bundler rejects any non-async-function export from a \"use server\" file at build time ('Only async functions are allowed to be exported...'), a real compiler constraint that vitest's mocked unit tests never exercise. No runtime behavior changed (300s already matches the Vercel platform default on both Hobby/Pro); only the declaration's location moved."
  - "discoveryCandidateSchema (Zod) added additively to candidate.ts as the read-path guard for /discover/[jobId], mirroring the dashboard's listingDataSchema.safeParse CR-01 discipline — a shape-drifted persisted candidate is skipped, never crashes the results page"
  - "DiscoveryCandidateCard's 'Se full analys' link routes to /dashboard?url=<encoded source URL> (pre-fill affordance) rather than a nonexistent /analysis/[id] — Phase 9 is retrieval-only and a raw discovery candidate has no analysis id yet"
  - "The sweep route's stuck-job query uses .or('claimed_at.is.null,claimed_at.lt.<iso>') rather than a bare .lt() — covers the edge case of a job whose claimed_at write crashed before commit, staying NULL-safe per the project's own postgrest-eq-null memory"

patterns-established:
  - "Route Handler maxDuration vs Server Action file constraint — any future cron/webhook Route Handler in this codebase can declare export const maxDuration directly; any future Server Action needing to document a duration ceiling should use a sibling plain-module constant instead, per tick-config.ts's precedent"

requirements-completed: [DISC-01, DISC-02, DISC-07]

# Metrics
duration: 45min
completed: 2026-07-07
---

# Phase 9 Plan 4: Discovery Frontend + Orphan-Sweep Cron Summary

**The full discovery UI surface — free-text input with optional hard filters, a poll-AND-tick progress view that drives the backend queue from the client, PII-safe candidate result cards with zero prediction/ranking framing, flag-gated and ownership-gated `/discover` routes, an absent-when-off dashboard entry point, and a once-daily Vercel Cron safety net that resumes orphaned jobs via the same atomic RPC — plus a real Next.js Server-Actions bundler constraint (non-async exports forbidden) caught by `npm run build` and fixed in Plan 03's `tick-discovery.ts`.**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-07-07T11:28Z (approx.)
- **Completed:** 2026-07-07T12:13Z (approx.)
- **Tasks:** 3 completed (Task 4 auto-approved-but-deferred per operator pre-approval)
- **Files modified:** 13 (9 new, 4 modified)

## Accomplishments

- `DiscoveryProgress` implemented as the poll-AND-tick client driver: each `poll()` round-trip calls `tickDiscovery(jobId)` FIRST, then reads `discovery_jobs` status/counters — the one divergence from `BrfProgress`'s pure-read polling that makes the client's own `setInterval` double as the job's slice-advance trigger. Renders the LOCKED "{n} av {total} annonser analyserade" counter, a Swedish status `Badge` (I kö/Analyserar/Klar/Misslyckades/Avbruten), the orthogonal cap-reached terracotta banner ("Vi stannade vid {cap} annonser (sökgräns).") that composes with a still-running status, and the calm degraded/kill-switch terracotta banner with a working link back to `/dashboard`. `MAX_POLL_MS = 5*60_000` (raised from BrfProgress's 90s, per UI-SPEC). Component tests (5/5 green) assert tick-on-poll, the locked counter copy, terminal `onComplete` + polling stop, cap-reached composition, and the degraded banner + escape link.
- `DiscoveryCandidateCard` renders ONLY the allowlisted `DiscoveryCandidate` fields (address, price, rooms, livingArea, areaLabel) + the "Källa: Booli" provenance caption — no match score, no ranking badge, no star rating, honoring the no-prediction constraint that is explicitly Phase 10's scope, not this phase's.
- `DiscoveryInput` copies `UrlInput`'s `useTransition`/`FormData` shell: required `Textarea` ("Beskriv din drömbostad…"), optional 4-field hard-filter row (Område `Select` seeded from `AREA_SEED`, Prisintervall, Antal rum `Select`, Storlek kvm), a "Stämmer detta?" inline confirmation affordance on `needsConfirmation` (mirrors the `BrfMatchConfirmation` ENRICH-02 pattern), and a kill-switch banner slot above the form that disables submit.
- `/discover` and `/discover/[jobId]` both check `DISCOVERY_ENABLED !== "true"` as their literal first line → `notFound()` — defense-in-depth on top of Plan 03's action-layer flag-first check. `[jobId]` additionally re-checks `row.user_id !== user.id` → `notFound()` (IDOR guard, T-09-06, behind RLS), resolves `initialStatus` server-side to avoid a "queued" flash, and re-validates persisted `results` against a new `discoveryCandidateSchema` Zod guard before rendering (CR-01 discipline).
- The dashboard gained a "Sök efter drömbostad" entry-point section that returns `null` entirely (not a disabled/grayed state) when the flag is off — verified by direct grep + the existing analysis-card markup left untouched.
- `/api/discovery/sweep` — the first Route Handler cron target in the codebase — finds `discovery_jobs` stuck `processing` with a stale-or-null `claimed_at` via a NULL-safe `.or(...)` filter, reclaims each via the SAME `claim_discovery_slice` RPC's stale branch (never a hand-rolled check-then-act), and runs one bounded `runSlice` per reclaimed job, capped at 10/invocation. `vercel.json` declares the exact once-daily `0 3 * * *` cron — Hobby-valid, no tier upgrade.

## Task Commits

Each task was committed atomically:

1. **Task 1: DiscoveryProgress (poll+tick) + DiscoveryCandidateCard + DiscoveryInput** — `319ed36` (test, RED) → `eec01db` (feat, GREEN)
2. **Task 2: /discover routes (flag+ownership gated) + dashboard entry point** — `6145104` (feat, includes the Rule-1 tick-discovery.ts build fix)
3. **Task 3: Vercel Cron safety-net sweep route + vercel.json** — `8682241` (feat)

_Task 1 is `tdd="true"` — RED test commit followed by GREEN implementation commit. Tasks 2/3 are plain `auto` tasks (no TDD gate required by the plan)._

## Files Created/Modified

- `src/components/discovery-input.tsx` — free-text `Textarea` + optional hard-filter row + "Starta sökning" + "Stämmer detta?" confirm + kill-switch banner slot.
- `src/components/discovery-progress.tsx` — poll-AND-tick loop, single counter line, status `Badge`, cap-reached + degraded terracotta banners, failed/timeout retry banner.
- `src/components/discovery-progress.test.tsx` — 5 component tests (jsdom + RTL) covering tick-on-poll, locked counter copy, terminal onComplete/stop, cap-reached composition, degraded banner+link.
- `src/components/discovery-candidate-card.tsx` — PII-safe candidate card, "Källa: Booli" caption, no score.
- `src/app/(app)/discover/page.tsx` — flag-gated entry route, renders `DiscoveryInput`.
- `src/app/(app)/discover/[jobId]/page.tsx` — flag+ownership-gated progress/results route; candidate grid / empty state (`SearchX`) / terminal banners.
- `src/app/api/discovery/sweep/route.ts` — GET cron handler, reclaims stale-claimed jobs via `claim_discovery_slice`, `maxDuration=300`.
- `src/lib/discovery/tick-config.ts` — `TICK_DISCOVERY_MAX_DURATION_SEC` constant (see Deviations).
- `vercel.json` — once-daily `/api/discovery/sweep` cron config (new project-root file).
- `src/app/(app)/dashboard/page.tsx` — added the absent-when-off `DiscoveryEntryPoint` section; existing "Ny analys"/analysis-grid markup untouched.
- `src/lib/discovery/candidate.ts` — additive `discoveryCandidateSchema` Zod read-path guard.
- `src/actions/tick-discovery.ts` — removed the invalid `export const maxDuration` from the `"use server"` file (see Deviations); `tickDiscovery` itself unchanged.
- `src/actions/tick-discovery.test.ts` — updated to import/assert `TICK_DISCOVERY_MAX_DURATION_SEC` from `tick-config.ts` instead of a `maxDuration` export that no longer exists on the action module.

## Decisions Made

See `key-decisions` in frontmatter. The most consequential: moving the 300s duration constant out of the Server Action file entirely, because Next.js's "use server" bundler forbids non-async exports — a real production-build constraint that Plan 03's vitest-only verification never exercised.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `tick-discovery.ts`'s `export const maxDuration = 300` fails the real Next.js Server Actions bundler**
- **Found during:** Task 2, first `npm run build` pass (the plan's own Task 2 verification command).
- **Issue:** Plan 03 (a prior plan, already committed) added `export const maxDuration = 300;` directly inside `tick-discovery.ts`'s `"use server"` file. `npx tsc --noEmit` and `npx vitest run` both passed against this — neither tool runs Next.js's actual Server Actions compiler. `npm run build` failed with "Only async functions are allowed to be exported in a 'use server' file," because `maxDuration`/`runtime` are Route Handler/Page special exports, not Server Action ones.
- **Fix:** Created `src/lib/discovery/tick-config.ts` exporting `TICK_DISCOVERY_MAX_DURATION_SEC = 300` (a plain module, not bundler-constrained) and removed the export from `tick-discovery.ts` (kept as a doc-comment explaining the constraint and pointing to the new location). Updated `tick-discovery.test.ts` to import/assert the constant from `tick-config.ts` instead of the no-longer-existing `maxDuration` export on the action module. No runtime behavior changed — 300s already matches the Vercel platform default on both Hobby and Pro (09-RESEARCH.md).
- **Files modified:** `src/actions/tick-discovery.ts`, `src/actions/tick-discovery.test.ts`, `src/lib/discovery/tick-config.ts` (new).
- **Commit:** `6145104` (folded into Task 2's commit since discovering it required Task 2's `npm run build` verification step; Task 1's build was never run and would not have caught it).

### Rule 2 — Auto-added (plan-required, not a bug)

**2. [Rule 2 - Missing Critical] `discoveryCandidateSchema` Zod read-path guard**
- **Found during:** Task 2, building `/discover/[jobId]/page.tsx`.
- **Issue:** The plan's action block explicitly requires "Re-validate `row.results` against a Zod parse of the `DiscoveryCandidate` shape before rendering (read-path guard, mirrors dashboard's `listingDataSchema.safeParse` discipline)" — but `candidate.ts` (Plan 01) only exports a plain TS interface, no Zod schema.
- **Fix:** Added an additive `discoveryCandidateSchema` (mirroring the `DiscoveryCandidate` allowlist exactly, nullable fields, no numeric constraints) to `candidate.ts`, applied via `.safeParse` in the results route — a shape-drifted candidate is filtered out rather than crashing the page.
- **Files modified:** `src/lib/discovery/candidate.ts`.
- **Commit:** `6145104`.

---

**Total deviations:** 2 (1 Rule-1 bug fix, 1 Rule-2 plan-required addition).
**Impact on plan:** Both necessary for correctness (the build would not ship otherwise) and for the plan's own explicit read-path-guard requirement. No scope creep — no new UI surface, copy, or behavior beyond what the plan specified.

## Issues Encountered

None beyond the deviation above. Local Docker/Supabase was not verified running in this session (unrelated to this plan — Plan 03's `job.integration.test.ts` self-skips without it, unaffected by this plan's changes).

## User Setup Required

None for the code itself — `DISCOVERY_ENABLED` remains unset (OFF) in every environment, matching the locked "OFF by default until legal go/no-go" posture. See **Operator Next Steps** below for the full deferred live-verification checklist (Task 4).

## Known Stubs

None. Every component/route renders real, wired data: `DiscoveryProgress` reads live `discovery_jobs` columns and calls the real `tickDiscovery` Server Action; `DiscoveryCandidateCard` renders the real `DiscoveryCandidate` shape; the results route re-validates real persisted `results` JSONB; the sweep route calls the real `claim_discovery_slice` RPC and `runSlice`. Nothing returns hardcoded/placeholder data.

## Threat Flags

None beyond what the plan's own threat model already covers (T-09-05 PII, T-09-06 IDOR, T-09-08 flag bypass, T-09-10 kill-switch DoS, T-09-11 sweep tampering/DoS, T-09-SC shadcn registry) — every row's disposition was implemented exactly as specified:
- T-09-08 (flag bypass): both routes `notFound()` on `DISCOVERY_ENABLED !== "true"` as the literal first check; dashboard entry point returns `null`.
- T-09-06 (IDOR): `[jobId]` route re-checks `row.user_id !== user.id` → `notFound()`.
- T-09-05 (PII): `DiscoveryCandidateCard` renders only allowlisted fields; the new `discoveryCandidateSchema` guards the read path.
- T-09-11 (sweep tampering/DoS): reclaims ONLY via the atomic RPC's stale branch, `.or(...)` NULL-safe filter (never `.eq(col,null)`), bounded to 10 jobs/invocation, `maxDuration=300`.
- T-09-10 (kill-switch DoS): `degraded` status and the input's kill-switch prop both surface the calm escape-hatch banner and disable further spend-inviting actions.
- T-09-SC (shadcn registry): `select`/`textarea` added via the official registry only, no third-party source.

No NEW surface beyond the plan's threat model was introduced.

## Next Phase Readiness

- All Phase 9 backend + frontend contracts are now fully wired end-to-end: `startDiscovery` → `discovery_jobs` row → `DiscoveryInput` redirect → `/discover/[jobId]` → `DiscoveryProgress` poll+tick → `tickDiscovery` → `claim_discovery_slice` RPC → `runSlice` → persisted PII-safe `results` → `DiscoveryCandidateCard` grid.
- The feature remains OFF by default (`DISCOVERY_ENABLED` unset) until the operator completes Task 4's live smoke test AND the separate final legal go/no-go sign-off (see Operator Next Steps).
- `vercel.json`'s cron declaration is untested against an actual Vercel deployment in this session (no `vercel deploy` was run) — the grep/tsc/build gates confirm the config's shape and the route's compile-correctness, but a real deploy is the only way to confirm Vercel accepts the cron on the current tier (Task 4 step 9 covers this).
- Phase 10 (niche ranking) will need to add a ranking/score affordance to `DiscoveryCandidateCard` — deliberately absent in this phase per the no-prediction/no-verdict constraint; this is an intentional forward-compatible gap, not a stub.

---

## Operator Next Steps

**[09-04 Task 4 — BLOCKING checkpoint, deferred per pre-approval]** Live discovery end-to-end smoke test (flag ON, operator-only — auto-approved-but-deferred; NOT performed in this session, since it requires a running app + live Booli + Apify spend + the feature flag actually flipped on):

1. Ensure env: Supabase + `ANTHROPIC_API_KEY` + `APIFY_API_TOKEN`. Set `DISCOVERY_ENABLED=true` (operator action — this is the provisional-GO flag; final legal sign-off remains a SEPARATE operator gate, not part of this phase). Start the app (`npm run dev`).
2. Confirm BOTH flag states: with the flag unset/false, the dashboard shows NO discovery section and `/discover` + `/discover/[jobId]` both 404. With the flag `true`, the dashboard shows "Sök efter drömbostad" and `/discover` renders the input.
3. Enter a free-text description + a couple of hard filters; confirm the "Stämmer detta?" parse-confirmation appears when confidence is low, and that confirming it actually starts the job (no silent no-op).
4. Start the search → land on `/discover/[jobId]`; confirm the counter advances ("{n} av {total} annonser analyserade") as the client tick drives slices, and that leaving + returning to the URL resumes at the current state with no "queued" flash.
5. Broad popular-area query: confirm it STOPS at the candidate/SEK cap, shows the terracotta "Vi stannade vid {cap} annonser (sökgräns)" honesty banner, and never exceeds the per-search SEK cap (`cap_sek`) — check `cost_sek_total` on the row / server logs.
6. Inspect one persisted `discovery_jobs.results` row directly (e.g. via the Supabase dashboard) and confirm it contains ONLY the allowlisted candidate fields (address, price, rooms, livingArea, areaLabel, thumbnailUrl, sourceListingUrl) — no raw Apollo entity, no broker text, no PII.
7. Kill switch: simulate a Booli block (or force `fetchAreaListings` to throw) → confirm the job degrades to the calm terracotta "Områdessökning är tillfälligt otillgänglig..." banner + the working link back to `/dashboard`, and does NOT keep spending.
8. IDOR: try opening another user's `/discover/[jobId]` (a job you did not create) → confirm a 404 (`notFound`), never their results.
9. Concurrency (DISC-02): with a local Supabase running (`supabase start`) and `RUN_DB_INTEGRATION=1`, run `job.integration.test.ts` and confirm two concurrent claims → exactly one wins (this test was written in Plan 03 and self-skips without the env var; this is its first live run).
10. Confirm `vercel.json`'s cron deploys on the current (Hobby) tier without a deployment failure — actually push/deploy and check the Vercel dashboard's Cron Jobs tab shows `/api/discovery/sweep` scheduled at `0 3 * * *`.
11. **Acknowledge the orphan-recovery latency tradeoff (operator decision, required before flipping the flag on in production):** because slices are driven by the client tick and Vercel Cron is Hobby-capped to once/day, a job whose tab closes mid-run resumes only on the next daily sweep — worst case ~24h. This was NOT pre-approved in the original CONTEXT.md; the operator must explicitly decide here whether this is acceptable for v1 as-is, OR upgrade to Vercel Pro for more frequent cron before enabling the flag in production. **This acknowledgement is separate from, and does not substitute for, the final legal go/no-go sign-off** (re-reading Booli/Hemnet ToS, re-deriving proportionality) that STATE.md already tracks as a distinct, still-outstanding operator gate for Phase 9 as a whole.

Report back "approved" once all 11 steps are verified, or describe any specific issue. Full plan context: `.planning/phases/09-discovery-foundation/09-04-PLAN.md`.

---
*Phase: 09-discovery-foundation*
*Completed: 2026-07-07*

## Self-Check: PASSED

All 14 created/modified files verified present on disk; all 4 task commit hashes (319ed36, eec01db, 6145104, 8682241) verified present in git log.
