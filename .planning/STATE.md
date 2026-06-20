---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
current_plan: 1
status: paused
stopped_at: "Phase 3 paused at 03-01 human-verify — sold-source (Booli searchSold GraphQL) blocked by Cloudflare managed-challenge; no working transport in-session"
last_updated: "2026-06-20T11:22:00.067Z"
last_activity: 2026-06-20
progress:
  total_phases: 10
  completed_phases: 2
  total_plans: 15
  completed_plans: 9
  percent: 20
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-24)

**Core value:** Give Swedish home buyers an independent, data-driven analysis of any listing -- the one thing their maklare won't provide.
**Current focus:** Phase 03 — market-context

## Current Position

Phase: 03 (market-context) — EXECUTING
Plan: 1 of 6
**Phase:** 3 of 4 (market context)
**Current Plan:** 1
**Status:** Executing Phase 03
**Last activity:** 2026-06-20

Progress: [██████████] 100% of Phase 1 (3/3 plans)

## Performance Metrics

**Velocity:**

- Total plans completed: 9
- Average duration: 5min (excl. 01-03 verification session)
- Total execution time: 0.25 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-P01 | 6min | 2 tasks | 36 files |
| 01-P02 | 4min | 2 tasks | 13 files |
| 01-P03 | 2 sessions | 2 tasks | 6 files |
| 02 | 6 | - | - |

*Updated after each plan completion*
| Phase 02 P01 | 6min | 3 tasks | 11 files |
| Phase 02 P03 | ~5min | 3 tasks | 4 files |
| Phase 02 P04 | 12min | 2 tasks | 8 files |
| Phase 02-brf-financial-analysis P06 | 12min | 2 tasks | 3 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap]: 4-phase structure derived from 10 v1 requirements. Phase 3 (Market Context) depends on Phase 1 only (not Phase 2), enabling parallel work with Phase 2 if desired.
- [Roadmap]: Payment (PAY-01, PAY-02) is v1.1 scope -- not in current roadmap. Ship free, validate with 20-50 users, then add Stripe.
- [Phase 01]: Used NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY env var name per latest Supabase docs
- [Phase 01]: Supabase browser client created inside handlers to prevent SSR prerender crashes
- [Phase 01]: Warm earthy shadcn base theme: sage for primary, terracotta for accents, light mode only
- [Phase 01]: Used zod/v4 import path for Zod 4.x compatibility
- [Phase 01]: Root page is client component for inline guest result display
- [Phase 01]: Server action handles both auth and guest flows in single analyzeUrl function
- [Phase 01-03]: Apify actor field names confirmed via real scrape (streetAddress, rent, constructionYear, livingArea.raw); normalizeScraperOutput() maps to internal model
- [Phase 01-03]: Actor does NOT provide brfName or floor -- Phase 2 must resolve BRF via address lookup (e.g. Allabrf)
- [Phase 01-03]: serverExternalPackages: ["apify-client"] required -- dynamic requires break Turbopack
- [Phase 01-03]: SE residential Apify proxy required for Booli scraping
- [Infra]: New Supabase project bostad-ai (nsheegvczxjeeayngqrv, Paris) after old project froze from 90+ day dormancy. Free tier pauses after 7 days inactivity -- recurring risk at current dev pace.
- [Infra]: Supabase CLI + Apify CLI installed and authenticated. Apify paid plan active.
- [Phase 02]: vitest [SUS] slopcheck flag confirmed false positive (official vitest-dev/vitest); installed with human approval
- [Phase 02]: USD/SEK exposed as USD_SEK_RATE config constant in cost contract (not hardcoded), per assumption A1
- [Phase 02]: Wave 0 RED-first: deterministic-core tests written before src/lib/brf/ production code (Plan 03 implements GREEN)
- [Phase ?]: Locked BRF grade weights (skuld 0.35, kassaflode 0.30, avgift 0.20, underhall 0.15) and composite bands (A>=0.85..F) as single source of truth in BRF_SCORE_THRESHOLDS for Plan 05 methodology page (D-08/D-09)
- [Phase ?]: OSAKER_THRESHOLD=0.5 exported from sanity.ts; out-of-band values downgraded to confidence 0.2, value never dropped (D-10/D-12)
- [Phase ?]: Plan 02-04: single client.beta.messages.parse for base64 + Files API transports; model pinned to claude-haiku-4-5-20251001; cost-cap refuses to persist over 5 SEK
- [Phase ?]: Plan 05: polling (not Realtime) for D-13 progress, ~1.5s interval cleared on terminal status
- [Phase ?]: Plan 05: isGuest resolved server-side; UI teaser is defence-in-depth behind analyzeBrf hard gate (D-05)
- [Phase ?]: Public /sa-raknar-vi placed outside the auth-gated (app) route group so it renders for logged-out visitors (D-09)
- [Phase ?]: BrfScoreCard inline edit re-scores via correctBrfField only — never re-calls Claude (D-12)

### Pending Todos

- Customize Supabase auth email templates (currently "powered by Supabase" boilerplate) -- Dashboard → Authentication → Email Templates
- UAT-test guest gate redirect explicitly (log out, paste URL, expect /login redirect)
- README.md has uncommitted create-next-app boilerplate -- decide keep/revert
- Design polish pass (overall UX approved, deeper design work wanted)

### Blockers/Concerns

- Research flags Phase 2 (BRF Analysis) as highest-risk: Claude structured output for Swedish K2/K3 formats needs deeper research during planning.
- Research flags Inngest + Supabase Realtime wiring in Phase 1 as non-trivial -- may need research spike. (Did not materialize in Phase 1; revisit if async jobs needed.)
- Supabase free tier pauses after 7 days inactivity -- old project was permanently frozen after 90+ days. Visit dashboard periodically or upgrade.
- Apify actor trial is 1 day (started 2026-06-06); ongoing scrapes need the paid actor rental.
- 02-04 Task 3: needs real ANTHROPIC_API_KEY in .env.local for live extraction smoke test (blocking-human checkpoint)
- **[PHASE 3 PAUSED] Sold-price source dead:** Booli `searchSold` GraphQL (`www.booli.se/graphql`) sits behind a stricter Cloudflare managed-challenge zone than the for-sale HTML pages. Direct fetch (minimal + full browser headers), Apify RESIDENTIAL/SE proxy (Stockholm egress confirmed), and Apify Playwright in-browser fetch from a CF-cleared page ALL return 403. No Booli sold actor exists in the Apify store (only Hemnet, out of scope). A non-browser POST cannot solve a JS/Turnstile managed challenge regardless of IP. PRICE-01 is blocked until a CF-managed-challenge solver, a paid data provider, or a re-scope to asking-price (utgångspris) is decided out-of-band. Full matrix + options in 03-SPIKE.md §6.
- AREA-01 is NOT blocked: SCB DeSO availability fully de-risked (population 2025, income 2024, tenure 2025 all at DeSO level). Breadcrumbs shape pinned: `{label,url}[]`, wide→narrow, areaId in `?areaIds=<N>`.

## Session Continuity

Last session: 2026-06-20 (execute-phase 3)
Stopped at: Phase 3 PAUSED at 03-01 Task 1 human-verify (user chose to pause) — sold-source blocker
Resume file: .planning/phases/03-market-context/03-SPIKE.md (§6 decision options)
Completed this session: 03-01 Task 1 spike committed (065a03b: 03-SPIKE.md + mock sold-comps.json). Tasks 2–3 (RED tests, schema) NOT started. Plans 03-02→03-06 NOT started.
Next step: Resolve the sold-source blocker out-of-band, then re-run `/gsd-execute-phase 3` (the 03-01 spike artifact is already committed; re-dispatch continues from Task 2). If re-scoping PRICE-01 to asking-price, replan Phase 3 first.
