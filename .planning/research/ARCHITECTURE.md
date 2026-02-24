# Architecture Research

**Domain:** AI-powered Swedish real estate analysis (scraping + PDF parsing + public APIs + LLM analysis + payments)
**Researched:** 2026-02-24
**Confidence:** MEDIUM-HIGH

## Standard Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     PRESENTATION LAYER                          │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              Next.js App (Vercel)                         │  │
│  │  Pages: Landing, Analysis Report, Dashboard, Payment     │  │
│  │  Server Components + Server Actions                      │  │
│  └────────────────────────┬──────────────────────────────────┘  │
├───────────────────────────┼─────────────────────────────────────┤
│                     ORCHESTRATION LAYER                         │
│  ┌────────────────────────┴──────────────────────────────────┐  │
│  │           Inngest (Event-Driven Pipeline)                 │  │
│  │                                                           │  │
│  │  1. scrape-listing  ──► 2. fetch-brf-report               │  │
│  │  3. parse-brf-pdf   ──► 4. fetch-area-stats               │  │
│  │  5. scrape-comps    ──► 6. run-ai-analysis                │  │
│  └──┬─────────┬─────────┬─────────┬─────────┬───────────────┘  │
│     │         │         │         │         │                   │
├─────┼─────────┼─────────┼─────────┼─────────┼───────────────────┤
│     │    DATA COLLECTION LAYER    │         │                   │
│  ┌──┴──┐  ┌──┴──┐  ┌──┴──┐  ┌──┴──┐  ┌──┴──┐                │
│  │Apify│  │ PDF │  │ SCB │  │ BRA │  │Skol-│                │
│  │Booli│  │Parse│  │ API │  │ API │  │ verk│                │
│  └──┬──┘  └──┬──┘  └──┬──┘  └──┬──┘  └──┬──┘                │
│     │        │        │        │        │                     │
├─────┼────────┼────────┼────────┼────────┼─────────────────────┤
│     │     AI ANALYSIS LAYER     │        │                     │
│  ┌──┴────────┴────────┴────────┴────────┴──┐                  │
│  │        Claude API (Structured Output)    │                  │
│  │  - BRF financial health scoring (A-F)    │                  │
│  │  - Price comparison analysis             │                  │
│  │  - Risk/opportunity flag generation      │                  │
│  │  - Swedish-language summary              │                  │
│  └──────────────────┬──────────────────────┘                  │
├─────────────────────┼───────────────────────────────────────────┤
│              STORAGE LAYER                                      │
│  ┌──────────────────┴──────────────────────┐                   │
│  │              Supabase                    │                   │
│  │  - Postgres (analyses, users, payments) │                   │
│  │  - Storage (uploaded PDFs)              │                   │
│  │  - Realtime (progress updates)          │                   │
│  │  - Auth (email/password)                │                   │
│  └─────────────────────────────────────────┘                   │
├─────────────────────────────────────────────────────────────────┤
│              PAYMENT LAYER                                      │
│  ┌─────────────────────────────────────────┐                   │
│  │              Stripe                      │                   │
│  │  - Checkout (SEK 149/analysis)          │                   │
│  │  - Subscriptions (SEK 349/month)        │                   │
│  │  - Webhooks → Supabase                  │                   │
│  └─────────────────────────────────────────┘                   │
└─────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| Next.js App | UI, form handling, report display, auth flows, payment initiation | App Router, Server Components, Server Actions on Vercel |
| Inngest | Orchestrate multi-step analysis pipeline, retry failed steps, progress tracking | Event-driven functions, each step is an independent HTTP call |
| Apify (Booli scraper) | Scrape listing data and comparable sold prices from Booli.se | Existing Apify Actor (`lexis-solutions/booli-se-scraper`), triggered via API |
| PDF Parser | Extract financial data from BRF arsredovisningar | Claude API with PDF support (direct PDF input) |
| Public API Integrators | Fetch area statistics from SCB, BRA, Skolverket | Server-side fetch calls within Inngest steps |
| Claude API | Generate structured analysis, BRF scoring, risk flags, summary | Structured outputs with JSON schema, PDF analysis |
| Supabase | Store all data, auth, file storage, realtime progress | Postgres + Storage + Realtime + Auth |
| Stripe | Handle payments and entitlements | Checkout Sessions + Customer Portal + Webhooks |

## Recommended Project Structure

```
src/
├── app/                    # Next.js App Router pages
│   ├── (marketing)/        # Landing page, pricing
│   ├── (auth)/             # Login, signup
│   ├── dashboard/          # User's analysis history
│   ├── analysis/
│   │   ├── new/            # Paste URL form + payment
│   │   └── [id]/           # Analysis report view
│   ├── api/
│   │   ├── inngest/        # Inngest webhook endpoint
│   │   ├── stripe/         # Stripe webhook endpoint
│   │   └── apify/          # Apify webhook callback
│   └── layout.tsx
├── lib/
│   ├── supabase/           # Supabase client + server helpers
│   ├── stripe/             # Stripe helpers, price IDs
│   ├── claude/             # Claude API client, prompts, schemas
│   │   ├── client.ts       # API wrapper
│   │   ├── prompts/        # Prompt templates per analysis type
│   │   └── schemas/        # Zod schemas for structured output
│   ├── scrapers/
│   │   ├── apify.ts        # Apify API client (trigger + fetch results)
│   │   └── transforms.ts   # Normalize scraped data
│   ├── apis/
│   │   ├── scb.ts          # SCB PxWebApi v2 client
│   │   ├── bra.ts          # BRA API client
│   │   └── skolverket.ts   # Skolverket API client
│   └── utils/              # Shared utilities
├── inngest/
│   ├── client.ts           # Inngest client setup
│   └── functions/
│       ├── analyze-listing.ts    # Main orchestration function
│       ├── scrape-listing.ts     # Step: scrape Booli listing
│       ├── scrape-comps.ts       # Step: scrape comparable sales
│       ├── fetch-brf-report.ts   # Step: fetch/parse BRF PDF
│       ├── fetch-area-stats.ts   # Step: aggregate public API data
│       └── generate-report.ts    # Step: Claude analysis + scoring
├── types/
│   ├── analysis.ts         # Analysis report types
│   ├── listing.ts          # Scraped listing data types
│   ├── brf.ts              # BRF financial data types
│   └── area.ts             # Area statistics types
└── components/
    ├── report/             # Report display components
    ├── forms/              # URL input, PDF upload
    └── ui/                 # Shared UI components
```

### Structure Rationale

- **`inngest/functions/`:** Separated from API routes because Inngest functions are the core business logic. Each file = one pipeline step. Easy to test, retry, and monitor independently.
- **`lib/claude/prompts/`:** Prompts are version-controlled and separate from logic. Each analysis type (BRF scoring, price comparison, summary) gets its own prompt template.
- **`lib/apis/`:** Each public API gets its own client. They change independently (SCB just migrated to PxWebApi v2 in October 2025) and have different auth/rate-limit patterns.
- **`lib/scrapers/`:** Scraping is fragile. Isolating scraper code makes it replaceable when Booli changes their frontend.

## Architectural Patterns

### Pattern 1: Event-Driven Pipeline with Inngest

**What:** Instead of a single long-running function that scrapes, parses, fetches, and analyzes, each step is an independent function triggered by events. Inngest orchestrates the sequence, handles retries, and tracks progress.

**When to use:** When the full analysis pipeline takes 30-90 seconds and involves multiple external services that can fail independently.

**Trade-offs:**
- Pro: Each step retries independently (Apify failure does not re-run Claude analysis)
- Pro: Steps can run in parallel where no dependency exists (area stats + comparable sales)
- Pro: Built-in observability (see which step failed and why)
- Con: Adds a dependency (Inngest service)
- Con: Slightly more complex than a single function for trivial cases

**Example:**
```typescript
// inngest/functions/analyze-listing.ts
import { inngest } from "../client";

export const analyzeListing = inngest.createFunction(
  { id: "analyze-listing", retries: 2 },
  { event: "analysis/requested" },
  async ({ event, step }) => {
    // Step 1: Scrape listing data from Booli
    const listing = await step.run("scrape-listing", async () => {
      return await scrapeBoliListing(event.data.booliUrl);
    });

    // Step 2 & 3: Run in parallel (no dependency between them)
    const [brfData, areaStats, comps] = await Promise.all([
      step.run("fetch-brf-report", () => fetchAndParseBrfReport(listing.brfName)),
      step.run("fetch-area-stats", () => fetchAreaStats(listing.address)),
      step.run("scrape-comps", () => scrapeComparableSales(listing.area)),
    ]);

    // Step 4: AI analysis (depends on all data)
    const report = await step.run("generate-report", async () => {
      return await generateAnalysis({ listing, brfData, areaStats, comps });
    });

    // Step 5: Save completed report
    await step.run("save-report", () => saveReport(event.data.analysisId, report));
  }
);
```

### Pattern 2: Claude PDF-Native Parsing (No OCR Needed)

**What:** Send BRF arsredovisning PDFs directly to Claude API rather than using a separate OCR/parsing pipeline. Claude supports native PDF input and handles Swedish K2/K3 format financial statements well.

**When to use:** For BRF arsredovisningar which follow standardized accounting formats. The structured output feature ensures you get consistent JSON back.

**Trade-offs:**
- Pro: No OCR pipeline to maintain, no Tesseract/pdf-parse dependencies
- Pro: Claude handles tables, charts, and Swedish accounting terminology natively
- Pro: Structured outputs guarantee valid JSON matching your Zod schema
- Con: Higher per-call cost than traditional OCR (but simpler overall)
- Con: 100-page PDFs may need chunking (most arsredovisningar are 20-40 pages, fine)

**Example:**
```typescript
// lib/claude/parse-brf-report.ts
import Anthropic from "@anthropic-ai/sdk";
import { brfFinancialsSchema } from "./schemas/brf";

export async function parseBrfReport(pdfBuffer: Buffer) {
  const client = new Anthropic();

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    output_format: {
      type: "json_schema",
      json_schema: brfFinancialsSchema,
    },
    messages: [{
      role: "user",
      content: [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: pdfBuffer.toString("base64") },
        },
        {
          type: "text",
          text: `Extract key financial metrics from this BRF årsredovisning.
                 Focus on: skuld per kvm, årsavgift trend, underhållsplan,
                 kassaflöde, resultat, and any planned stambyten or renoveringar.`,
        },
      ],
    }],
  });

  return JSON.parse(response.content[0].text);
}
```

### Pattern 3: Graceful Degradation with Partial Reports

**What:** When some data sources fail (Booli changes markup, SCB API is down, BRF report unavailable), generate a partial report with clear indicators of what is missing, rather than failing entirely.

**When to use:** Always. Every external dependency will fail at some point. The core value (AI analysis of available data) should always be delivered.

**Trade-offs:**
- Pro: Users always get something valuable
- Pro: Missing data becomes an upsell (upload your own PDF)
- Con: More complex report rendering (conditional sections)

## Data Flow

### Primary Analysis Flow

```
User pastes Booli URL
    |
    v
Next.js Server Action
    |-- Validate URL
    |-- Check payment/entitlement (Supabase)
    |-- Create analysis record (status: "pending") in Supabase
    |-- Send event to Inngest: "analysis/requested"
    |-- Redirect to /analysis/[id] (shows progress UI)
    |
    v
Inngest Pipeline (background)
    |
    |-- Step 1: Apify API call → scrape Booli listing
    |      |-- Trigger Apify Actor run
    |      |-- Poll for completion (or use webhook)
    |      |-- Fetch dataset → normalize listing data
    |      |-- Update Supabase: status = "listing_scraped"
    |
    |-- Step 2 (parallel):
    |   |-- Fetch BRF årsredovisning
    |   |   |-- Try Allabrf.se or Bolagsverket
    |   |   |-- If found: send PDF to Claude for parsing
    |   |   |-- If not found: mark as "needs_upload"
    |   |
    |   |-- Scrape comparable sold prices from Booli
    |   |   |-- Apify Actor: same area, similar property type
    |   |   |-- Normalize and compute pris/kvm statistics
    |   |
    |   |-- Fetch area statistics
    |       |-- SCB PxWebApi v2: demographics, income
    |       |-- BRÅ: crime statistics for area
    |       |-- Skolverket: nearby school ratings
    |
    |-- Step 3: Claude AI Analysis
    |      |-- Input: listing + BRF data + comps + area stats
    |      |-- Structured output: BRF score (A-F), price assessment,
    |      |   red/green flags, "vad du bör tänka på" summary
    |      |-- Update Supabase: status = "completed", store report
    |
    v
Supabase Realtime → Next.js Client
    |-- Progress bar updates via Supabase Realtime subscription
    |-- Final report renders when status = "completed"
```

### Payment Flow

```
User submits Booli URL
    |
    v
Check entitlement (Supabase: active subscription or unused credit?)
    |-- YES → Start analysis pipeline
    |-- NO  → Redirect to Stripe Checkout
              |-- Success webhook → Create entitlement in Supabase
              |-- Redirect back → Start analysis pipeline
```

### Key Data Flows

1. **Scraping flow:** Next.js triggers Apify via REST API. Apify runs actor, stores results in its dataset. Inngest step polls Apify API for completion, then fetches the dataset. Alternatively, Apify sends a webhook to `/api/apify` on completion, which emits an Inngest event.

2. **PDF flow:** BRF PDF is either auto-fetched from a public source or uploaded by user to Supabase Storage. Inngest step retrieves the PDF, sends it as base64 to Claude API with structured output schema, and stores the parsed financials in Supabase.

3. **Realtime progress flow:** Each Inngest step updates the analysis record's `status` field in Supabase. The report page subscribes to Supabase Realtime on that row. UI shows a progress indicator (e.g., "Hämtar listningsdata... Analyserar BRF-ekonomi... Genererar rapport...").

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 0-1k users | Monolith on Vercel + Supabase free/pro tier. Inngest free tier (25k events). Budget stays under $100/month. |
| 1k-10k users | Supabase Pro. Inngest paid tier. Cache SCB/BRA/Skolverket responses (they change infrequently). Consider caching Apify results for same listing URL within 24h. |
| 10k+ users | Pre-compute area statistics nightly via cron. Cache popular BRF reports. Rate-limit Claude API calls with queue prioritization. Consider Apify proxy rotation if scraping volume triggers blocks. |

### Scaling Priorities

1. **First bottleneck: Claude API cost.** Each analysis involves 2-3 Claude calls (PDF parse + main analysis + potential retry). At SEK 149/analysis, Claude costs must stay well under that. Use Claude Sonnet (not Opus) for cost efficiency. Cache BRF parses so repeat analyses of same BRF reuse data.
2. **Second bottleneck: Apify cost/rate limits.** Each analysis triggers 1-2 Apify runs. The Booli scraper has per-run costs. Batch comparable sales queries and cache results for the same area within a time window.

## Anti-Patterns

### Anti-Pattern 1: Synchronous Analysis Pipeline

**What people do:** Run the entire scraping + parsing + API + Claude pipeline in a single API route or serverless function.
**Why it's wrong:** Vercel has a 60-second timeout (300s on Pro). The full pipeline takes 30-90 seconds. One slow Apify run = timeout = lost work and wasted Claude credits. No retry granularity.
**Do this instead:** Use Inngest (or similar) to break the pipeline into independent steps. Each step is its own HTTP invocation with its own timeout and retry policy.

### Anti-Pattern 2: Building Custom OCR for PDFs

**What people do:** Set up Tesseract, pdf-parse, or similar tooling to extract text from BRF arsredovisningar before sending to Claude.
**Why it's wrong:** BRF reports have tables, footnotes, and Swedish accounting terms. OCR introduces errors. You then need to clean the text before LLM processing. Two failure points instead of one.
**Do this instead:** Send PDFs directly to Claude API which has native PDF support. It reads tables, charts, and text natively. One API call replaces an entire parsing pipeline.

### Anti-Pattern 3: Storing Analysis Results Only in Claude's Response Format

**What people do:** Save the raw Claude API response and parse it on the frontend each time.
**Why it's wrong:** Claude's output format may change, re-rendering is fragile, and you cannot query or filter reports efficiently.
**Do this instead:** Use Claude's structured output (JSON schema) to get a typed response, then store the structured data in dedicated Supabase columns. The report is a database record, not a blob.

### Anti-Pattern 4: Tight Coupling to Booli's HTML Structure

**What people do:** Write custom scraping code that depends on specific CSS classes or DOM structure of Booli's pages.
**Why it's wrong:** Booli redesigns break the scraper instantly. You spend more time maintaining the scraper than building features.
**Do this instead:** Use the Apify Booli scraper maintained by Lexis Solutions (a certified Apify partner). When it breaks, they fix it. Your integration is via Apify's stable API, not Booli's DOM.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Apify | REST API: trigger actor run, poll/webhook for completion, fetch dataset | Existing Booli scraper by Lexis Solutions. ~$5/1000 results on pay-per-result. |
| Claude API | REST API via official SDK. PDF input + structured JSON output. | Use Sonnet for cost efficiency. Structured outputs guarantee valid JSON. |
| SCB (PxWebApi v2) | REST API: GET requests with table IDs and query parameters | Free, CC0 license. New v2 API as of Oct 2025. Base: `statistikdatabasen.scb.se/api/v2/` |
| BRA | REST API or data download | Crime statistics by area. May need to map kommun/stadsdel codes. |
| Skolverket | REST API or data download | School quality metrics. Map to geographic area. |
| Stripe | Checkout Sessions for one-time, Billing Portal for subscriptions, webhooks for fulfillment | Use Stripe's hosted checkout — never build custom payment forms for MVP. |
| Supabase | Client SDK (frontend), Server SDK (API routes/Inngest), Realtime subscriptions | Auth, Postgres, Storage (PDFs), Realtime (progress). |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Next.js <-> Inngest | Events (Next.js emits, Inngest consumes) + Inngest serves via `/api/inngest` | Inngest SDK handles the wiring. One API route serves all functions. |
| Inngest <-> Supabase | Direct DB writes from Inngest steps (server-side Supabase client) | Each step updates analysis status for realtime progress. |
| Next.js <-> Supabase | Client SDK for auth + realtime, Server SDK for data fetching in Server Components | Use `@supabase/ssr` for cookie-based auth in App Router. |
| Next.js <-> Stripe | Server Actions create Checkout Sessions, webhooks update Supabase | Never trust client-side payment confirmation. Always verify via webhook. |

## Build Order (Dependencies Between Components)

The pipeline has clear dependency chains that dictate build order:

```
Phase 1: Foundation
  Supabase setup (DB schema, auth) ──► Next.js app shell (pages, auth)
  These are prerequisites for everything else.

Phase 2: Core Pipeline (the product)
  Apify integration (scrape listing) ──► Claude analysis (basic report from listing data)
  This delivers the minimum "paste URL → get report" flow.

Phase 3: Data Enrichment
  BRF PDF parsing (Claude PDF) ──► BRF scoring
  Public APIs (SCB, BRA, Skolverket) ──► Area statistics in report
  Comparable sales scraping ──► Price comparison in report
  These can be built in parallel; each adds a section to the report.

Phase 4: Monetization
  Stripe integration ──► Payment gating
  Requires auth (Phase 1) and a working report (Phase 2).

Phase 5: Polish
  Realtime progress (Supabase Realtime) ──► Better UX
  Partial report handling ──► Graceful degradation
  Caching ──► Cost optimization
```

**Key dependency insight:** Phase 2 is the proof-of-concept. If "paste URL, get AI analysis" does not feel valuable with just listing data, adding BRF scoring and area stats will not save it. Build Phase 2 first and validate.

## Sources

- [Apify Booli.se Scraper](https://apify.com/lexis-solutions/booli-se-scraper) - Existing scraper by certified Apify partner
- [Apify Webhook Documentation](https://docs.apify.com/platform/integrations/webhooks) - Actor webhook callback pattern
- [SCB PxWebApi v2](https://www.scb.se/en/services/open-data-api/pxwebapi/) - New API released October 2025
- [Claude PDF Support](https://platform.claude.com/docs/en/build-with-claude/pdf-support) - Native PDF input for analysis
- [Claude Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) - JSON schema-guaranteed responses
- [Inngest Background Jobs for Next.js](https://www.inngest.com/blog/run-nextjs-functions-in-the-background) - Event-driven pipeline pattern
- [Inngest Real-time Progress Updates](https://www.inngest.com/blog/background-jobs-realtime-nextjs) - Live status updates from background jobs
- [Supabase Background Tasks](https://supabase.com/docs/guides/functions/background-tasks) - Edge function background processing
- [Supabase Queues + Edge Functions](https://supabase.com/blog/processing-large-jobs-with-edge-functions) - Queue-based processing pattern
- [Real-time Scraping Dashboard (Apify + Supabase + Next.js)](https://github.com/dudic/scraper-web-ui) - Reference architecture
- [Supabase + Next.js Quickstart](https://supabase.com/docs/guides/getting-started/quickstarts/nextjs) - Official integration guide
- [LLMs for Structured Data Extraction from PDFs](https://unstract.com/blog/comparing-approaches-for-using-llms-for-structured-data-extraction-from-pdfs/) - PDF parsing approaches 2026

---
*Architecture research for: Bostad AI - Swedish real estate analysis*
*Researched: 2026-02-24*
