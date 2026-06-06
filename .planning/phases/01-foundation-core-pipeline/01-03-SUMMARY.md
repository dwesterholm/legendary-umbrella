---
phase: 01-foundation-core-pipeline
plan: 03
subsystem: ui
tags: [dashboard, analysis-history, card-grid, uat, apify, supabase]

# Dependency graph
requires:
  - phase: 01-01
    provides: "Next.js 16 app shell, Supabase clients, auth pages, analyses table"
  - phase: 01-02
    provides: "Scraping pipeline, server action, listing UI, app layout"
provides:
  - "Dashboard page with analysis history card grid (responsive 1/2/3 columns)"
  - "Analysis card component linking to full analysis view"
  - "Verified end-to-end Phase 1 user flow (human UAT)"
  - "Confirmed Apify actor output field mapping (real scrape)"
  - "Working production environment: new Supabase project + Apify paid plan"
affects: [02-01, 03-01, 04-01]

# Tech tracking
tech-stack:
  added: []
  patterns: [actor-field-normalization, server-external-packages-for-dynamic-requires]

key-files:
  created:
    - src/app/(app)/page.tsx
    - src/components/analysis-card.tsx
  modified:
    - src/lib/schemas/listing.ts
    - src/lib/apify/booli-scraper.ts
    - src/actions/analyze.ts
    - next.config.ts

key-decisions:
  - "Actor referenced by ID bpf1JaYRBbia2nQU9 (= lexis-solutions/booli-se-scraper)"
  - "SE residential Apify proxy required -- no-proxy configuration fails"
  - "serverExternalPackages: ['apify-client'] -- dynamic requires break Turbopack bundling"
  - "brfName not provided by actor; stays null until Phase 2 address lookup"
  - "Prefer actor's listSqmPrice.raw over computed pris/kvm"

patterns-established:
  - "Normalization layer (normalizeScraperOutput) between external actor output and internal model"
  - "External packages with dynamic requires must be listed in serverExternalPackages"

requirements-completed: [LSTG-02]

# Metrics
duration: 2 sessions (build 2026-02-24, verification + fixes 2026-06-06)
completed: 2026-06-06
---

# Phase 1 Plan 3: Dashboard + End-to-End Verification Summary

**Analysis history dashboard with card grid, plus human-verified end-to-end Phase 1 flow -- including infrastructure recovery (new Supabase project) and scraper field-mapping fixes discovered during UAT**

## Performance

- **Duration:** 2 sessions -- Task 1 built 2026-02-24, Task 2 (UAT) completed 2026-06-06 after a 3-month pause
- **Tasks:** 2
- **Files modified:** 6 (2 created in Task 1, 4 fixed during verification)

## Accomplishments
- Dashboard page with responsive card grid (1/2/3 columns), empty state, URL input
- Analysis cards showing address, price, key metrics, Swedish-locale date, linking to `/analysis/[id]`
- **Full Phase 1 UAT passed**: URL input → real Apify scrape (~20s) → listing summary → signup → email confirm → login → analyze → dashboard → card re-open
- Resolved RESEARCH open question #1: confirmed real actor output field names via live scrape
- Infrastructure recovered after dormancy: new Supabase project (bostad-ai, Paris), migration history repaired, Apify paid plan + actor trial activated

## Task Commits

1. **Task 1: Dashboard page with analysis history card grid** - `fcf2e45` (feat, 2026-02-24)
2. **Task 2 fixes: Scraper alignment + Turbopack config** - `6ab826c` (fix, 2026-06-06)

## Files Created/Modified
- `src/app/(app)/page.tsx` - Dashboard fetching user's analyses, card grid, empty state
- `src/components/analysis-card.tsx` - Clickable analysis summary card
- `src/lib/schemas/listing.ts` - Schema rewritten to real actor shape + normalizeScraperOutput()
- `src/lib/apify/booli-scraper.ts` - SE residential proxy config, real error logging
- `src/actions/analyze.ts` - Uses normalizer; actor's exact pris/kvm preferred
- `next.config.ts` - serverExternalPackages for apify-client

## Decisions Made
- Actor `bpf1JaYRBbia2nQU9` confirmed identical to `lexis-solutions/booli-se-scraper` (verified via Apify API)
- SE residential proxy is required (actor-recommended config)
- `serverExternalPackages: ["apify-client"]` needed -- Turbopack cannot bundle its dynamic requires
- brfName is NOT in actor output -- Phase 2 must resolve BRF via address lookup (Allabrf)
- Actor provides bonus fields for later phases: `estimate` (Booli valuation), `listSqmPrice`, `images`, `agencyName`

## Deviations from Plan

### Verification-driven fixes (Task 2)

**1. [Rule 1 - Bug] Field mapping mismatch between schema and real actor output**
- **Found during:** Task 2 UAT preparation (CLI smoke test)
- **Issue:** Schema used best-guess names (address, monthlyFee, buildYear); actor returns streetAddress, rent, constructionYear, livingArea as object
- **Fix:** Schema rewritten, normalizeScraperOutput() added, analyze.ts updated
- **Committed in:** `6ab826c`

**2. [Rule 1 - Bug] Turbopack cannot bundle apify-client**
- **Found during:** Task 2 UAT (instant "Kunde inte hamta data" failure)
- **Issue:** `Cannot find module as expression is too dynamic` (MODULE_NOT_FOUND) -- apify-client's dynamic requires break Turbopack server-action bundling
- **Fix:** `serverExternalPackages: ["apify-client"]` in next.config.ts
- **Committed in:** `6ab826c`

**3. [Infrastructure] Supabase project frozen after 90+ day dormancy**
- **Found during:** Session resume
- **Fix:** New project created (nsheegvczxjeeayngqrv, Paris), migration applied + history repaired via CLI, .env.local updated. RLS verified live (2 policies).

**Total deviations:** 2 auto-fixed bugs + 1 infrastructure recovery
**Impact on plan:** All within plan scope -- UAT existed precisely to surface these.

## UAT Results (Task 2)

| Step | Result |
|------|--------|
| URL input page renders | ✓ |
| Real Booli URL → listing summary | ✓ (20s scrape, all fields except BRF) |
| Four "Kommer snart" sections | ✓ |
| Invalid URL → Swedish error | ✓ |
| Guest gate (2nd analysis → login) | ⚠ code-verified only, not UAT-tested (user signed up before testing) |
| Signup → email confirm → login | ✓ "flawless" |
| Authenticated analyze → /analysis/[id] | ✓ |
| Dashboard card grid + re-open | ✓ |
| Visual direction | ✓ UX approved; deeper design pass wanted later |

## Issues Encountered
- Apify actor requires one-time account permission approval (console URL prompt)
- Old `.env.local` token worked; user activated paid plan + actor trial

## Pending Todos (carried forward)
- Customize Supabase auth email templates (currently "powered by Supabase" boilerplate) -- Dashboard → Authentication → Email Templates
- UAT-test guest gate redirect explicitly (log out, paste URL, expect /login redirect)
- README.md has uncommitted create-next-app boilerplate -- decide keep/revert
- Design polish pass (user: "a lot of design work to do but the overall UX is there")

## Next Phase Readiness
- Phase 1 complete: all 5 success criteria verified (guest gate code-verified)
- Phase 2 (BRF Analysis) can start: needs BRF resolution via address since actor provides no brfName
- Phase 3 (Market Context) unblocked too -- depends only on Phase 1; actor's `estimate` + `listSqmPrice` fields useful
- Supabase CLI + Apify CLI now installed and authenticated for future dev/debug

## Self-Check: PASSED

Dashboard files present, UAT approved by user 2026-06-06, build passes, commits confirmed (fcf2e45, 6ab826c), live scrape verified through the app (runId QOSyCNKrl8C1eBURI: 1 succeeded, 0 failed).

---
*Phase: 01-foundation-core-pipeline*
*Completed: 2026-06-06*
