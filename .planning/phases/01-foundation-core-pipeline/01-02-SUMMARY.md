---
phase: 01-foundation-core-pipeline
plan: 02
subsystem: api
tags: [apify, zod, scraping, listing-ui, server-actions, supabase]

# Dependency graph
requires:
  - phase: 01-01
    provides: "Next.js 16 app shell, Supabase clients, shadcn/ui components, analyses table"
provides:
  - "Apify Booli scraper integration with 30s timeout"
  - "Zod schemas for flexible scraper output and typed listing data"
  - "Server action: URL validation, scraping, partial data handling, guest cookie flow, DB save"
  - "URL input component with client-side validation and loading state"
  - "Listing summary component with all 8 data fields"
  - "Skeleton loading component matching summary layout"
  - "Coming-soon placeholder sections for future phases"
  - "Analysis result page fetching from Supabase with RLS"
  - "App layout with auth check and minimal navigation"
  - "Signout API route handler"
  - "formatSEK and calculatePrisPerKvm utility helpers"
affects: [01-03, 02-01, 03-01, 04-01]

# Tech tracking
tech-stack:
  added: []
  patterns: [server-action-scraping-pipeline, guest-cookie-access-gate, partial-data-graceful-display, zod-passthrough-flexible-schema]

key-files:
  created:
    - src/lib/schemas/listing.ts
    - src/lib/apify/booli-scraper.ts
    - src/actions/analyze.ts
    - src/components/url-input.tsx
    - src/components/listing-summary.tsx
    - src/components/listing-skeleton.tsx
    - src/components/coming-soon-section.tsx
    - src/app/(app)/layout.tsx
    - src/app/(app)/analysis/[id]/page.tsx
    - src/app/(app)/analysis/[id]/loading.tsx
    - src/app/api/auth/signout/route.ts
  modified:
    - src/lib/utils.ts
    - src/app/page.tsx

key-decisions:
  - "Used zod/v4 import path since project uses Zod 4.x"
  - "Root page is a client component for inline guest result display (no redirect)"
  - "Server action handles both auth and guest flows in single function"
  - "Signout via API route handler (/api/auth/signout) used by app layout form"

patterns-established:
  - "Server action pattern: validate URL -> call scraper -> parse with Zod -> save or return"
  - "Guest access pattern: cookie-based one-shot gate (guest_analysis_done cookie, 30 day expiry)"
  - "Partial data display: show what was extracted, mark missing fields as 'Ej tillganglig'"
  - "Coming-soon pattern: dashed border card with reduced opacity and badge"
  - "Metric card pattern: label + value in warm-gray-50 rounded box"

requirements-completed: [LSTG-01, LSTG-02]

# Metrics
duration: 4min
completed: 2026-02-24
---

# Phase 1 Plan 2: Core Scraping Pipeline Summary

**Apify Booli scraper with Zod validation, server action pipeline (URL -> scrape -> display), listing summary UI with 8 data fields, skeleton loading, and coming-soon placeholders**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-24T18:42:39Z
- **Completed:** 2026-02-24T18:46:54Z
- **Tasks:** 2
- **Files modified:** 13

## Accomplishments
- End-to-end scraping pipeline: Apify actor invocation with 30s timeout, Zod validation with passthrough for unknown fields, server action orchestrating the full flow
- Listing summary UI displaying all 8 required fields (price, pris/kvm, storlek, rum, avgift, byggar, address, BRF name) with graceful "Ej tillganglig" for missing data
- Guest access flow: first analysis works without account (inline on root page), cookie gate blocks subsequent analyses
- Four "Kommer snart" placeholder sections for future phases (BRF Analys, Prisjamforelse, Omradesstatistik, AI Rapport)
- App layout with auth check, minimal navigation bar, and signout functionality

## Task Commits

Each task was committed atomically:

1. **Task 1: Apify scraper integration, Zod schemas, and server action** - `78f7144` (feat)
2. **Task 2: Listing analysis page with URL input, skeleton loading, summary display, and coming-soon sections** - `1fd30a4` (feat)

## Files Created/Modified
- `src/lib/schemas/listing.ts` - Zod schemas: scraperOutputSchema (flexible) and listingDataSchema (typed internal model)
- `src/lib/apify/booli-scraper.ts` - Apify actor invocation with 30s timeout and Swedish error messages
- `src/actions/analyze.ts` - Server action: URL validation, scraping, Zod parsing, guest/auth flow, DB save
- `src/lib/utils.ts` - Added formatSEK and calculatePrisPerKvm helpers
- `src/components/url-input.tsx` - Client component with input, validation, loading spinner, error display
- `src/components/listing-summary.tsx` - Listing data display with 6 metric cards and partial data banner
- `src/components/listing-skeleton.tsx` - Animated skeleton matching summary layout in warm-gray
- `src/components/coming-soon-section.tsx` - Dashed border placeholder with "Kommer snart" badge
- `src/app/page.tsx` - Guest-accessible landing with URL input and inline results
- `src/app/(app)/layout.tsx` - Auth-gated layout with nav bar and signout
- `src/app/(app)/analysis/[id]/page.tsx` - Analysis result page fetching from Supabase
- `src/app/(app)/analysis/[id]/loading.tsx` - Full skeleton loading state
- `src/app/api/auth/signout/route.ts` - POST handler for sign out

## Decisions Made
- Used `zod/v4` import path (project is on Zod 4.3.6, v4 is the canonical import)
- Root page is a "use client" component to support inline guest result display without redirect
- Server action handles both authenticated (DB save + redirect) and guest (cookie + inline return) flows in a single function
- Created `/api/auth/signout` route handler for the app layout's sign-out form action
- Signout route was not in the plan but is required for the app layout nav (Rule 2: missing critical functionality)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added signout API route**
- **Found during:** Task 2 (app layout creation)
- **Issue:** App layout references `/api/auth/signout` for the logout form, but no route handler existed
- **Fix:** Created `src/app/api/auth/signout/route.ts` with POST handler that calls supabase.auth.signOut() and redirects to /login
- **Files modified:** `src/app/api/auth/signout/route.ts`
- **Verification:** `npm run build` completes, route appears in build output
- **Committed in:** `1fd30a4` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 missing critical functionality)
**Impact on plan:** Essential for logout functionality. No scope creep.

## Issues Encountered
None -- both tasks executed cleanly. Build and TypeScript checks passed on first attempt.

## User Setup Required

**External services require manual configuration.** The following must be set up before the scraping pipeline can be tested end-to-end:

1. `APIFY_API_TOKEN` - From Apify Console > Settings > Integrations > API Tokens (needed for scraping)
2. Supabase project must be created and env vars configured (from Plan 01 setup)
3. The SQL migration `supabase/migrations/001_analyses.sql` must be run against the Supabase database

## Next Phase Readiness
- Core scraping pipeline is complete and ready for end-to-end testing with Apify credentials
- All UI components for listing display are in place
- Plan 03 (dashboard with analysis history) can build on the analyses table and app layout established here
- Exact Apify scraper field names still unconfirmed (RESEARCH open question #1) -- first real scrape will reveal actual mapping

## Self-Check: PASSED

All 11 created files verified present. Both commit hashes (78f7144, 1fd30a4) confirmed. Build passes. TypeScript passes. All must-have artifacts checked (scrapeBooli export, scraperOutputSchema/listingDataSchema exports, analyzeUrl export, formatSEK/calculatePrisPerKvm exports, min line counts met).

---
*Phase: 01-foundation-core-pipeline*
*Completed: 2026-02-24*
