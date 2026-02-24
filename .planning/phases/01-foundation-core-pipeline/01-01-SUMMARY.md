---
phase: 01-foundation-core-pipeline
plan: 01
subsystem: infra
tags: [nextjs, tailwind, supabase, auth, database, shadcn]

# Dependency graph
requires: []
provides:
  - "Next.js 16 app shell with Turbopack and App Router"
  - "Warm earthy Tailwind v4 theme (warm-gray, sage, terracotta in OKLCH)"
  - "DM Sans font via next/font/google"
  - "Supabase browser + server + proxy client utilities"
  - "proxy.ts auth token refresh on every navigation"
  - "Email/password login and signup pages (Swedish UI)"
  - "Email confirmation route handler"
  - "Analyses table with RLS (users own data only)"
  - "shadcn/ui component library (card, skeleton, input, button, form, label, separator, badge)"
affects: [01-02, 01-03, 02-01, 03-01, 04-01]

# Tech tracking
tech-stack:
  added: [next@16.1.6, react@19.2.3, @supabase/supabase-js@2.97, @supabase/ssr@0.8, apify-client@2.22, zod@4.3, shadcn/ui, tailwindcss@4, DM_Sans]
  patterns: [proxy.ts-auth-refresh, supabase-ssr-getAll-setAll, tailwind-v4-theme-inline-oklch]

key-files:
  created:
    - src/app/layout.tsx
    - src/app/globals.css
    - src/app/page.tsx
    - src/proxy.ts
    - src/lib/supabase/client.ts
    - src/lib/supabase/server.ts
    - src/lib/supabase/proxy.ts
    - src/app/(auth)/layout.tsx
    - src/app/(auth)/login/page.tsx
    - src/app/(auth)/signup/page.tsx
    - src/app/(auth)/auth/confirm/route.ts
    - supabase/migrations/001_analyses.sql
    - .env.local.example
  modified: []

key-decisions:
  - "Used NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY env var name per latest Supabase docs"
  - "Moved Supabase client creation inside form handlers to prevent SSR prerender errors"
  - "Light mode only -- no dark theme variant (per context: light mode only)"
  - "Warm earthy shadcn base theme using sage for primary and terracotta for destructive/charts"

patterns-established:
  - "proxy.ts pattern: auth token refresh via updateSession on every request"
  - "Supabase server client: async createClient() with getAll/setAll cookie pattern"
  - "Supabase browser client: createClient() via createBrowserClient, instantiated inside handlers"
  - "Auth pages as client components in (auth) route group with centered card layout"
  - "Swedish UI text, English code/variables/comments"

requirements-completed: [LSTG-01, LSTG-02]

# Metrics
duration: 6min
completed: 2026-02-24
---

# Phase 1 Plan 1: Project Setup Summary

**Next.js 16 app with DM Sans + sage/terracotta Tailwind v4 theme, Supabase auth (email/password), proxy.ts token refresh, and analyses table with RLS**

## Performance

- **Duration:** 6 min
- **Started:** 2026-02-24T18:31:31Z
- **Completed:** 2026-02-24T18:37:34Z
- **Tasks:** 2
- **Files modified:** 36

## Accomplishments
- Next.js 16.1.6 app bootstrapped with Turbopack, TypeScript, and App Router
- Warm earthy Tailwind v4 theme with OKLCH colors (warm-gray, sage, terracotta) and DM Sans font
- Supabase SSR auth plumbing: browser client, server client (getAll/setAll), proxy.ts for token refresh
- Swedish-language login and signup pages with sage-themed shadcn/ui components
- Analyses table SQL migration with composite index and RLS policies

## Task Commits

Each task was committed atomically:

1. **Task 1: Bootstrap Next.js 16 app with Tailwind v4 theme and Supabase plumbing** - `ce283c7` (feat)
2. **Task 2: Database schema, auth pages, and email confirmation handler** - `88daefb` (feat)

## Files Created/Modified
- `package.json` - Project config with Next.js 16, Supabase, Apify, Zod, shadcn/ui
- `src/app/layout.tsx` - Root layout with DM Sans font, lang="sv", warm-white background
- `src/app/globals.css` - Tailwind v4 @theme inline with warm-gray/sage/terracotta OKLCH palette
- `src/app/page.tsx` - Minimal placeholder page
- `src/proxy.ts` - Auth token refresh proxy (Next.js 16 pattern)
- `src/lib/supabase/client.ts` - Browser Supabase client factory
- `src/lib/supabase/server.ts` - Server Supabase client with cookies getAll/setAll
- `src/lib/supabase/proxy.ts` - updateSession function for proxy.ts
- `src/app/(auth)/layout.tsx` - Centered auth card layout
- `src/app/(auth)/login/page.tsx` - Swedish login form with sage-themed button
- `src/app/(auth)/signup/page.tsx` - Swedish signup form with email confirmation flow
- `src/app/(auth)/auth/confirm/route.ts` - Email OTP verification route handler
- `supabase/migrations/001_analyses.sql` - Analyses table with indexes and RLS
- `.env.local.example` - Required environment variables template
- `src/components/ui/*.tsx` - shadcn/ui components (card, skeleton, input, button, form, label, separator, badge)

## Decisions Made
- Used `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` env var name (latest Supabase convention, may also work as ANON_KEY)
- Moved Supabase browser client creation inside event handlers instead of component body to prevent SSR prerendering errors during `npm run build`
- Used stone-based neutral for shadcn init, then overwrote with custom warm palette in globals.css
- Light mode only (no .dark variant) per CONTEXT.md direction

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed Supabase client SSR prerender crash**
- **Found during:** Task 2 (auth pages)
- **Issue:** `createClient()` called at component body level caused `@supabase/ssr` to throw during static page generation because env vars aren't available at build time
- **Fix:** Moved `createClient()` inside `handleSubmit` event handlers so it only runs client-side
- **Files modified:** `src/app/(auth)/login/page.tsx`, `src/app/(auth)/signup/page.tsx`
- **Verification:** `npm run build` completes successfully, all routes generated
- **Committed in:** `88daefb` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug fix)
**Impact on plan:** Essential fix for build correctness. No scope creep.

## Issues Encountered
- Initial `cp` from temp directory to project root failed silently in zsh (no `shopt -s dotglob`), requiring recreation of the Next.js app in /tmp and explicit file copy. Resolved by using explicit file glob and separate dotfile copy commands.

## User Setup Required

**External services require manual configuration.** The following environment variables must be set in `.env.local`:

1. `NEXT_PUBLIC_SUPABASE_URL` - From Supabase project dashboard > Settings > API
2. `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` - From Supabase project dashboard > Settings > API (the "anon" / "public" key)
3. `APIFY_API_TOKEN` - From Apify account settings (needed for Plan 02)

The SQL migration in `supabase/migrations/001_analyses.sql` must be run against the Supabase database (via Supabase CLI or dashboard SQL editor).

## Next Phase Readiness
- App shell, theme, auth, and database are in place for Plan 02 (core scraping pipeline)
- Supabase project must be created and env vars configured before auth can be tested end-to-end
- All shadcn/ui components needed for listing display are installed

## Self-Check: PASSED

All 14 files verified present. Both commit hashes (ce283c7, 88daefb) confirmed. All 11 must-have artifact checks passed (lang="sv", @theme inline, updateSession, createClient exports, signInWithPassword, create table, auth.users reference, min line counts, import pattern).

---
*Phase: 01-foundation-core-pipeline*
*Completed: 2026-02-24*
