# Phase 1: Foundation + Core Pipeline - Research

**Researched:** 2026-02-24
**Domain:** Next.js full-stack app with Supabase backend, Apify scraping pipeline, and Swedish property data display
**Confidence:** MEDIUM-HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Skeleton placeholder loading while scraping (3-10 seconds) — progressive reveal as data arrives
- When scraping fails or returns partial data, show whatever was extracted with clear markers on missing fields (e.g., "Ej tillganglig")
- App UI language is Swedish; all code (variables, comments, etc.) in English
- Try-once guest access: first analysis works without account, then login wall to save or run more
- Data only, no listing images in Phase 1
- Display required fields (price, size, avgift, rooms, byggar, address, BRF name) plus calculated pris/kvm
- Include grayed-out placeholder sections for future phases (BRF Analys, Prisjamforelse, Omradesstatistik, AI Rapport) with "Kommer snart" labels
- Card grid layout for dashboard showing address, price, key metrics, and analysis date per card
- No delete functionality in Phase 1
- Click card to re-open full analysis
- Email + password signup/login
- First analysis available without account (guest access), then login required to save or continue
- Warm & approachable visual style — soft grays, warm whites, earthy accents (sage/terracotta palette)
- Hemnet-inspired: familiar to Swedish property buyers, property-focused layout
- Light mode only
- Tool-first, minimal chrome — no landing page, minimal nav, just input/results/dashboard
- Friendly rounded typography direction (e.g., DM Sans)
- Comfortable, airy spacing

### Claude's Discretion
- Page flow pattern (same-page inline vs dedicated analysis page)
- Exact layout structure for listing summary (hero card + grid vs sectioned list)
- Loading skeleton design details
- Error state messaging and styling
- Typography and spacing specifics
- Navigation structure

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| LSTG-01 | User can paste a Booli URL and system extracts listing data (price, size, avgift, rooms, byggar, address, BRF name) | Apify `lexis-solutions/booli-se-scraper` actor provides all required fields. Call via `apify-client` from Next.js server action. Zod schema validates scraper output. |
| LSTG-02 | User can view structured listing summary with all key data points displayed clearly | shadcn/ui Card + data grid components. Skeleton loading via Suspense. Swedish UI labels. Calculated pris/kvm derived from price/size. |
</phase_requirements>

## Summary

Phase 1 builds the app shell (Next.js 16 + Supabase), the Booli scraping pipeline (Apify actor called from a server action), email/password auth with guest-first flow, and a dashboard of saved analyses. The tech stack is well-established with strong community patterns.

**Key finding:** Next.js 16 (stable since Oct 2025) replaces `middleware.ts` with `proxy.ts` and makes Turbopack the default bundler. Supabase SSR auth docs already reference `proxy.ts`. This is the correct version to target — not Next.js 15.

**Second key finding:** The Apify Booli scraper (`lexis-solutions/booli-se-scraper`) exists and extracts listing data including price, rooms, area, address, and property attributes. The scraper is called via the `apify-client` npm package with async polling. Typical runs take 3-10 seconds for a single listing URL, aligning with the skeleton loading requirement.

**Primary recommendation:** Use Next.js 16 + Supabase + shadcn/ui + Apify client. Server actions handle the scraping pipeline. Supabase handles auth and data persistence. Guest access uses a cookie-based session token before account creation.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Next.js | 16.x (latest 16.1.6) | Full-stack React framework | Default App Router, Turbopack, proxy.ts for auth token refresh |
| React | 19.2 | UI rendering | Ships with Next.js 16, includes View Transitions and Activity |
| @supabase/supabase-js | 2.97.x | Supabase client (auth + database) | Official SDK, TypeScript types, RLS support |
| @supabase/ssr | latest | Server-side auth with cookies | Official SSR package for Next.js, replaces deprecated auth-helpers |
| apify-client | latest | Call Apify actors from server | Smart polling, exponential backoff, typed responses |
| Tailwind CSS | 4.x | Utility-first styling | Ships with create-next-app, OKLCH color palette, @theme directive |
| shadcn/ui | latest | Component library (Card, Skeleton, Input, Button, Form) | Tailwind v4 + React 19 support, copy-paste components, data-slot attributes |
| TypeScript | 5.x | Type safety | Required by Next.js 16 (min 5.1.0) |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| zod | 3.x | Schema validation | Validate scraper output, form inputs, server action params |
| next/font | (built-in) | Font optimization (DM Sans) | Self-hosts Google Fonts at build time, zero layout shift |
| supabase CLI | latest | Type generation, local dev | `supabase gen types` for database TypeScript types |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Apify actor | Custom Playwright/Puppeteer scraper | Full control but must maintain scraper when Booli changes HTML. Apify actor is maintained by third party. Use Apify first; fall back to custom only if actor breaks or is too expensive. |
| shadcn/ui | Radix UI directly | shadcn adds pre-styled Tailwind components on top of Radix. No reason to go lower-level. |
| Supabase Auth | NextAuth/Auth.js | Supabase Auth integrates with the database (RLS policies, foreign keys to auth.users). Separate auth adds complexity for no benefit. |

**Installation:**
```bash
npx create-next-app@latest bostad-ai --typescript --tailwind --eslint --app --turbopack
cd bostad-ai
npm install @supabase/supabase-js @supabase/ssr apify-client zod
npx shadcn@latest init
npx shadcn@latest add card skeleton input button form label separator badge
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── app/
│   ├── (auth)/                 # Auth route group (login, signup, confirm)
│   │   ├── login/page.tsx
│   │   ├── signup/page.tsx
│   │   └── auth/confirm/route.ts   # Email confirmation handler
│   ├── (app)/                  # Authenticated app shell
│   │   ├── layout.tsx          # Nav + auth check
│   │   ├── page.tsx            # Dashboard (analysis history)
│   │   └── analysis/
│   │       └── [id]/
│   │           ├── page.tsx    # Analysis result view
│   │           └── loading.tsx # Skeleton placeholder
│   ├── layout.tsx              # Root layout (font, theme)
│   ├── page.tsx                # Landing/input (guest-accessible)
│   └── globals.css             # Tailwind + custom theme tokens
├── components/
│   ├── ui/                     # shadcn/ui components
│   ├── listing-summary.tsx     # Listing data display
│   ├── listing-skeleton.tsx    # Skeleton for loading state
│   ├── analysis-card.tsx       # Dashboard card
│   ├── url-input.tsx           # Booli URL input + submit
│   └── coming-soon-section.tsx # "Kommer snart" placeholder
├── lib/
│   ├── supabase/
│   │   ├── client.ts           # Browser client factory
│   │   └── server.ts           # Server client factory (cookies)
│   ├── apify/
│   │   └── booli-scraper.ts    # Apify actor caller + Zod validation
│   ├── schemas/
│   │   └── listing.ts          # Zod schemas for listing data
│   └── utils.ts                # Helpers (formatSEK, calculatePrisPerKvm)
├── actions/
│   └── analyze.ts              # Server action: scrape + save
├── types/
│   └── database.types.ts       # Generated Supabase types
└── proxy.ts                    # Auth token refresh (NOT middleware.ts)
```

### Pattern 1: Server Action Scraping Pipeline
**What:** User submits URL -> server action calls Apify -> validates response with Zod -> saves to Supabase -> returns result
**When to use:** Every new analysis request

```typescript
// actions/analyze.ts
"use server";

import { createClient } from "@/lib/supabase/server";
import { scrapeBooli } from "@/lib/apify/booli-scraper";
import { listingSchema } from "@/lib/schemas/listing";
import { redirect } from "next/navigation";

export async function analyzeUrl(formData: FormData) {
  const url = formData.get("url") as string;

  // Validate URL format
  if (!url?.includes("booli.se/")) {
    return { error: "Ange en giltig Booli-lank" };
  }

  // Call Apify scraper
  const rawData = await scrapeBooli(url);

  // Validate scraper output
  const parsed = listingSchema.safeParse(rawData);
  if (!parsed.success) {
    // Return partial data with missing field markers
    return { data: rawData, partial: true, missingFields: parsed.error.issues };
  }

  // Save to Supabase (if user is authenticated)
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (user) {
    const { data: analysis } = await supabase
      .from("analyses")
      .insert({ user_id: user.id, url, listing_data: parsed.data })
      .select()
      .single();
    redirect(`/analysis/${analysis.id}`);
  }

  // Guest: return data directly (no save)
  return { data: parsed.data, partial: false };
}
```

### Pattern 2: Apify Actor Invocation
**What:** Call the Booli scraper actor, wait for completion, retrieve dataset items
**When to use:** Inside the server action when a URL is submitted

```typescript
// lib/apify/booli-scraper.ts
import { ApifyClient } from "apify-client";

const client = new ApifyClient({
  token: process.env.APIFY_API_TOKEN!,
});

export async function scrapeBooli(url: string) {
  const run = await client.actor("lexis-solutions/booli-se-scraper").call(
    { startUrls: [{ url }] },
    { waitSecs: 30 }  // Max wait time
  );

  const { items } = await client.dataset(run.defaultDatasetId).listItems();

  if (!items.length) {
    throw new Error("Scraper returned no results");
  }

  return items[0]; // Single listing
}
```

### Pattern 3: Supabase Auth with proxy.ts (Next.js 16)
**What:** proxy.ts refreshes auth tokens on every request; server/client utilities use getAll/setAll cookie pattern
**When to use:** Every page load and navigation

```typescript
// proxy.ts (at project root — NOT middleware.ts)
import { type NextRequest, NextResponse } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export default async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
```

```typescript
// lib/supabase/server.ts
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // setAll can be called from Server Components where cookies are read-only.
            // This is fine — proxy.ts handles the write.
          }
        },
      },
    }
  );
}
```

### Pattern 4: Guest Access Flow
**What:** First analysis works without login. After that, gate behind auth.
**When to use:** URL input page checks guest status before requiring login

```typescript
// Use a cookie to track guest usage
// In the server action:
const guestCookie = cookies().get("guest_analysis_done");

if (!user && guestCookie) {
  // Guest already used their free analysis — redirect to login
  redirect("/login?reason=guest-limit");
}

if (!user) {
  // First-time guest — set cookie, allow analysis
  cookies().set("guest_analysis_done", "true", {
    maxAge: 60 * 60 * 24 * 30, // 30 days
    httpOnly: true,
  });
}
```

### Anti-Patterns to Avoid
- **Calling Apify from client-side:** API token would be exposed. Always use server actions.
- **Using `getSession()` for auth checks in server code:** Use `getClaims()` (Next.js 16 / Supabase SSR) which validates the JWT signature on every call.
- **Using `@supabase/auth-helpers-nextjs`:** Deprecated. Use `@supabase/ssr` with `getAll`/`setAll` cookie pattern only.
- **Using `middleware.ts`:** Deprecated in Next.js 16. Use `proxy.ts` instead (same logic, renamed export).
- **Storing scraper results only in client state:** Always persist to Supabase for the dashboard history feature.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Web scraping | Custom Puppeteer/Playwright scraper | Apify `lexis-solutions/booli-se-scraper` | Maintained by third party. Handles Booli's anti-scraping. Solo dev can't maintain custom scraper. |
| Authentication | Custom JWT/session system | Supabase Auth (@supabase/ssr) | Email confirm, password reset, session refresh, cookie management all built-in. |
| Form components | Custom input/button/card | shadcn/ui | Accessible (Radix), styled (Tailwind), keyboard support, ARIA labels. |
| Skeleton loading | Custom CSS animations | shadcn/ui Skeleton + Next.js Suspense | Matches the component library design system, works with streaming. |
| Data validation | Manual if/else checks | Zod schemas | Type inference, `.safeParse()` for graceful partial failures, `.flatten()` for form errors. |
| Font loading | `<link>` tag to Google Fonts | `next/font/google` (DM Sans) | Self-hosted at build time, zero layout shift, no external requests. |
| Type generation | Manual TypeScript interfaces for DB | `supabase gen types typescript` | Auto-generated from database schema, always in sync. |

**Key insight:** This phase has zero custom algorithms. Every piece (scraping, auth, UI, validation, data persistence) has a standard solution. The value is in wiring them together well and handling the edge cases (partial data, errors, guest flow).

## Common Pitfalls

### Pitfall 1: Apify Actor Timeout
**What goes wrong:** Apify scraper takes longer than expected or hangs, leaving user staring at a spinner
**Why it happens:** Network issues, Booli rate limiting, actor cold start
**How to avoid:** Set `waitSecs: 30` on the actor call. Implement a timeout in the server action (AbortController). Show skeleton immediately and progressively reveal any partial data received.
**Warning signs:** Scrape times exceeding 15 seconds consistently

### Pitfall 2: Scraper Output Schema Changes
**What goes wrong:** Apify actor updates its output format, breaking your Zod validation
**Why it happens:** Third-party actor maintained independently. Booli HTML changes force scraper updates.
**How to avoid:** Zod schema with `.passthrough()` on the base object so new fields don't break. Validate required fields explicitly. Log raw scraper output for debugging. Have graceful degradation — show what you can parse, mark rest as "Ej tillganglig".
**Warning signs:** Spike in partial results or validation errors

### Pitfall 3: Auth Token Refresh in proxy.ts
**What goes wrong:** Users get logged out unexpectedly, or server components see stale auth state
**Why it happens:** proxy.ts not properly passing refreshed cookies to both request and response
**How to avoid:** Follow the Supabase SSR guide exactly. Use `getClaims()` not `getSession()` in server code. Ensure proxy.ts matcher excludes static assets but catches all app routes.
**Warning signs:** Intermittent 401s, inconsistent auth state between pages

### Pitfall 4: Guest Access Cookie Bypass
**What goes wrong:** Users clear cookies or use incognito to get unlimited free analyses
**Why it happens:** Cookie-based guest tracking is inherently bypassable
**How to avoid:** Accept this for Phase 1. The goal is friction reduction, not bulletproof gating. If this becomes a real problem, move to IP-based rate limiting or require email before first analysis (worse UX).
**Warning signs:** Unusually high anonymous analysis volume

### Pitfall 5: Swedish Character Encoding
**What goes wrong:** Swedish characters (a, a, o) display incorrectly or break URL parsing
**Why it happens:** Incorrect encoding in scraper output, database, or rendering
**How to avoid:** Ensure Supabase database uses UTF-8 (default). Validate that Apify returns UTF-8. Use standard Next.js HTML charset meta tag (default). Test with real Swedish addresses early.
**Warning signs:** Garbled characters in listing data or dashboard cards

### Pitfall 6: Supabase RLS Performance
**What goes wrong:** Slow dashboard queries when analyses table grows
**Why it happens:** RLS policies adding per-row checks
**How to avoid:** Keep RLS policies simple: `auth.uid() = user_id` for reads. Add an index on `user_id`. For Phase 1 scale this is unlikely to matter, but design for it.
**Warning signs:** Dashboard load time > 1 second

## Code Examples

### DM Sans Font Setup
```typescript
// app/layout.tsx
import { DM_Sans } from "next/font/google";

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
  display: "swap",
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sv" className={dmSans.variable}>
      <body className="font-sans antialiased bg-warm-white text-warm-gray-900">
        {children}
      </body>
    </html>
  );
}
```

### Warm Earthy Theme (Tailwind v4)
```css
/* app/globals.css */
@import "tailwindcss";

@theme inline {
  --color-warm-white: oklch(0.98 0.005 80);
  --color-warm-gray-50: oklch(0.96 0.005 80);
  --color-warm-gray-100: oklch(0.93 0.008 80);
  --color-warm-gray-200: oklch(0.88 0.01 80);
  --color-warm-gray-500: oklch(0.55 0.015 80);
  --color-warm-gray-700: oklch(0.40 0.015 80);
  --color-warm-gray-900: oklch(0.25 0.015 80);
  --color-sage-50: oklch(0.96 0.02 150);
  --color-sage-100: oklch(0.92 0.03 150);
  --color-sage-200: oklch(0.85 0.05 150);
  --color-sage-500: oklch(0.60 0.08 150);
  --color-sage-600: oklch(0.50 0.08 150);
  --color-sage-700: oklch(0.42 0.07 150);
  --color-terracotta-50: oklch(0.96 0.03 50);
  --color-terracotta-100: oklch(0.90 0.06 45);
  --color-terracotta-200: oklch(0.82 0.09 40);
  --color-terracotta-500: oklch(0.58 0.14 35);
  --color-terracotta-600: oklch(0.50 0.14 35);
  --font-sans: var(--font-dm-sans), ui-sans-serif, system-ui, sans-serif;
}
```

### Zod Schema for Listing Data
```typescript
// lib/schemas/listing.ts
import { z } from "zod";

// What the Apify scraper returns (flexible — we don't control this)
export const scraperOutputSchema = z.object({
  url: z.string().url(),
  address: z.string().optional(),
  price: z.number().optional(),              // SEK
  livingArea: z.number().optional(),          // kvm
  rooms: z.number().optional(),
  monthlyFee: z.number().optional(),          // avgift SEK/month
  buildYear: z.number().optional(),           // byggar
  floor: z.string().optional(),
  brfName: z.string().optional(),
  propertyType: z.string().optional(),
  neighborhood: z.string().optional(),
}).passthrough(); // Allow additional fields without breaking

// What we display (our internal model)
export const listingDataSchema = z.object({
  url: z.string().url(),
  address: z.string(),
  price: z.number(),
  livingArea: z.number(),
  rooms: z.number(),
  monthlyFee: z.number().nullable(),
  buildYear: z.number().nullable(),
  brfName: z.string().nullable(),
  prisPerKvm: z.number(),                    // Calculated: price / livingArea
});

export type ScraperOutput = z.infer<typeof scraperOutputSchema>;
export type ListingData = z.infer<typeof listingDataSchema>;
```

### Listing Summary Component (Skeleton + Data)
```typescript
// components/listing-skeleton.tsx
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export function ListingSkeleton() {
  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <Skeleton className="h-8 w-3/4" />   {/* Address */}
        <Skeleton className="h-5 w-1/2" />   {/* BRF name */}
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4">
        <Skeleton className="h-16" />         {/* Price */}
        <Skeleton className="h-16" />         {/* Pris/kvm */}
        <Skeleton className="h-12" />         {/* Size */}
        <Skeleton className="h-12" />         {/* Rooms */}
        <Skeleton className="h-12" />         {/* Avgift */}
        <Skeleton className="h-12" />         {/* Byggar */}
      </CardContent>
    </Card>
  );
}
```

### Database Schema (Supabase SQL)
```sql
-- Analyses table: stores each scraping result
create table public.analyses (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  url text not null,
  listing_data jsonb not null,
  partial boolean default false,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

-- Index for dashboard queries
create index analyses_user_id_created_at_idx
  on public.analyses (user_id, created_at desc);

-- RLS: users can only see their own analyses
alter table public.analyses enable row level security;

create policy "Users can view own analyses"
  on public.analyses for select
  using (auth.uid() = user_id);

create policy "Users can insert own analyses"
  on public.analyses for insert
  with check (auth.uid() = user_id);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `middleware.ts` | `proxy.ts` | Next.js 16 (Oct 2025) | Rename file + export. Same logic, clearer naming. `middleware.ts` still works but deprecated. |
| `@supabase/auth-helpers-nextjs` | `@supabase/ssr` with `getAll`/`setAll` | 2024 | Must use new cookie pattern. Old helpers are deprecated and incompatible with Next.js 16. |
| `getSession()` in server code | `getClaims()` | 2025 (Supabase SSR update) | `getClaims()` validates JWT signature on every call. `getSession()` doesn't guarantee revalidation. |
| Webpack bundler | Turbopack (default) | Next.js 16 | Turbopack is now the default. 2-5x faster builds. Webpack available via `--webpack` flag. |
| `experimental.ppr` | `cacheComponents` config | Next.js 16 | Partial Pre-Rendering evolved into Cache Components. Different API. |
| Tailwind CSS v3 (config-based) | Tailwind CSS v4 (CSS `@theme`) | 2025 | `@theme inline` directive replaces `tailwind.config.js` for custom tokens. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | 2025 (Supabase) | Env var renamed. Check Supabase docs for current naming. |

**Deprecated/outdated:**
- `@supabase/auth-helpers-nextjs`: Replaced by `@supabase/ssr`. Do not use.
- `middleware.ts` filename: Renamed to `proxy.ts` in Next.js 16. Still works but deprecated.
- Individual cookie methods (`get`, `set`, `remove`): Use `getAll()`/`setAll()` only.
- `next lint` command: Removed in Next.js 16. Use ESLint directly.
- `experimental.dynamicIO`: Renamed to `cacheComponents`.

## Open Questions

1. **Exact Apify Booli scraper output field names**
   - What we know: The scraper returns JSON with property attributes including price, rooms, area, address, building features. Supports hundreds of attributes.
   - What's unclear: Exact field names in the JSON output (e.g., is it `price` or `listPrice` or `askingPrice`?). Could not fetch the detailed API docs page due to JS-rendered content.
   - Recommendation: Run the scraper once on a test URL during Phase 1 implementation to capture the exact output schema. Build the Zod schema from real data. Budget 1-2 hours for this discovery.

2. **Apify cost per single-URL scrape**
   - What we know: Free tier gives $5/month in credits. Typical actors charge $0.001-$0.01 per result. The Booli scraper may have its own per-result pricing.
   - What's unclear: Exact compute unit consumption for a single-listing scrape.
   - Recommendation: Test with free tier credits first. At $0.01/scrape, $5 covers 500 analyses/month — more than enough for Phase 1. Monitor usage.

3. **Supabase env var naming (`ANON_KEY` vs `PUBLISHABLE_KEY`)**
   - What we know: Recent Supabase docs reference `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Older guides use `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
   - What's unclear: Whether this is a rename or both are valid. The Supabase dashboard may still show `anon key`.
   - Recommendation: Check the Supabase project dashboard during setup. Use whatever name the dashboard shows. Both likely resolve to the same key.

## Sources

### Primary (HIGH confidence)
- [Next.js 16 blog post](https://nextjs.org/blog/next-16) - Full feature list, breaking changes, proxy.ts, Turbopack default, React 19.2
- [Supabase SSR Auth for Next.js](https://supabase.com/docs/guides/auth/server-side/nextjs) - proxy.ts setup, cookie pattern, getClaims()
- [Supabase AI Prompt: Next.js v16 + Auth](https://supabase.com/docs/guides/getting-started/ai-prompts/nextjs-supabase-auth) - Bootstrap guide confirming @supabase/ssr + getAll/setAll
- [Apify Client JS docs](https://docs.apify.com/api/client/js/docs/examples) - Actor call pattern, dataset retrieval
- [shadcn/ui Next.js installation](https://ui.shadcn.com/docs/installation/next) - Tailwind v4 + React 19 support confirmed
- [Next.js Streaming Handbook](https://www.freecodecamp.org/news/the-nextjs-15-streaming-handbook/) - Suspense, loading.tsx, skeleton patterns

### Secondary (MEDIUM confidence)
- [Apify Booli.se Scraper page](https://apify.com/lexis-solutions/booli-se-scraper) - Actor exists, extracts property data. Output field names unconfirmed (JS-rendered page).
- [Apify pricing docs](https://apify.com/pricing) - $5 free tier, $0.40/CU overage
- [Supabase pricing](https://supabase.com/pricing) - 500MB database, 50K MAU, free tier pauses after 1 week inactivity

### Tertiary (LOW confidence)
- Exact Booli scraper JSON field names — needs validation by running a test scrape
- Tailwind v4 OKLCH color values for warm palette — color tuning will need visual testing

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All libraries verified via official docs and current releases
- Architecture: HIGH - Patterns derived from official Next.js 16 + Supabase SSR guides
- Pitfalls: MEDIUM - Based on community patterns and common issues. Scraper-specific pitfalls need validation.
- Apify integration: MEDIUM - Actor exists and API pattern is clear, but exact output schema unverified

**Research date:** 2026-02-24
**Valid until:** 2026-03-24 (30 days — stable ecosystem, no major releases expected)
