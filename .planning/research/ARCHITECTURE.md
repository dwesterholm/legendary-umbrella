# Architecture Research

**Domain:** Integration architecture for v1.1 "Owned Data Layer & Intelligent Discovery" — new capabilities bolted onto a shipped Next.js 16 + Supabase property-analysis app (Bostad AI)
**Researched:** 2026-07-06
**Confidence:** HIGH for (a)/(b)/(c)/(e) — directly derived from reading the existing v1.0 code and its established patterns. MEDIUM for (d) — the execution-model recommendation is a synthesis of current Vercel/Next.js platform constraints (verified via web search, dated 2026) applied to this app's existing conventions; no code precedent exists in this repo for multi-item background work, so it is a design proposal, not an extraction of what's already there.

**Note on prior ARCHITECTURE.md:** This file replaces a v1.0-era research doc (dated 2026-02-24) that proposed an Inngest event-driven pipeline. That pipeline was never built — v1.0 shipped with plain Server Actions + status-column polling instead (confirmed by reading the actual codebase). This document reflects what was *actually built* and focuses exclusively on how v1.1's new features integrate with it, per this milestone's scope.

## Existing Architecture Recap (context only — not re-researched)

v1.0 is a single-listing, synchronous-ish pipeline: `analyzeUrl` (Server Action) → Apify actor scrape → `normalizeScraperOutput` → `listing_data` JSONB column → three independent, user-triggered enrichment actions (`analyzeBrf`, `enrichMarketContext`, `generateReport`), each following the **same five-step spine**:

1. Auth gate (owner-only, RLS + explicit ownership re-check)
2. Status write to an in-flight state (`brf_status`/`market_status`/`report_status` = `"extracting"`/`"fetching"`/`"generating"`)
3. External call(s) (Apify / Claude / SCB) — failures degrade to a null/`"source_unavailable"` branch, never thrown to the user as raw error
4. Cost-cap check as a **post-call persistence gate** (spend already happened; this decides whether to persist/show the result)
5. Terminal status write (`"done"`/`"failed"`) — a client-side `setInterval` poller (1.5s cadence, ~90s ceiling, `BrfProgress`-style) watches the status column and stops on a terminal value

There is **no job queue, no Realtime, no cron, no background worker** anywhere in the stack today. "Async" = a Server Action that runs synchronously inside one HTTP request/response, with the *page* polling a status column for progress. `generateReport` additionally has an **atomic CAS lock** (`report_status`/`report_generating_started_at`) to prevent double-spending the Sonnet call, with stale-lock reclamation after 5 minutes. This lock pattern is the most sophisticated concurrency primitive in the codebase and is the template for any new expensive/lockable operation.

This recap exists only to ground the integration decisions below — it is not new research.

---

## (a) Unified `booli-graphql` client + fallback tree (999.6)

### Shape

One new module, `src/lib/booli/client.ts` (suggest `src/lib/booli/` as a new top-level lib directory — it now serves BOTH active listings and sold comps, so it should not live under `apify/` or `market/`), exporting a single function per capability:

```typescript
// src/lib/booli/client.ts
export async function fetchListingByUrl(url: string): Promise<Record<string, unknown>>
export async function fetchSoldComps(query: SoldSourceQuery): Promise<unknown[]>
```

Internally, each function runs the **same three-rung fallback tree** the spike identified:

1. Direct server-side `fetch` to `booli.se/graphql` / `api.booli.se/graphql` (keyless) — cheapest, fastest, most fragile (Cloudflare).
2. Same call routed through the Apify **SE residential proxy** (no actor, just proxy egress) — recovers from IP-based blocking without paying for actor compute.
3. Fall back to the existing paid actor (`lexis-solutions/booli-se-scraper` for active, `apify/playwright-scraper` reading `__APOLLO_STATE__` for sold) — the current v1.0 behavior, kept as the last-resort safety net.

This mirrors the fallback-tree shape already proven in `sold-source.ts` (rungs 1–2 already partially exist there for sold comps) — 999.6 generalizes and unifies it to cover active listings too, and formalizes rung 3 as an explicit fallback rather than the only path.

**Where it slots relative to `normalizeScraperOutput` / the listing schema:** it slots in **exactly where `scrapeBooli()` sits today** — as a drop-in replacement for `src/lib/apify/booli-scraper.ts`'s `scrapeBooli(url)`. It must return the same raw shape (or a superset) that `scraperOutputSchema` / `normalizeScraperOutput` already parse. Concretely:

- `src/actions/analyze.ts` line 46 (`rawData = await scrapeBooli(url)`) becomes `rawData = await fetchListingByUrl(url)`.
- `normalizeScraperOutput()` in `src/lib/schemas/listing.ts` is **untouched** for the base fields — the spike's Finding 1 (HIGH confidence) is that Booli's GraphQL uses the *same* field names/shapes (`{raw, value, formatted, unit}`) the actor already emits, because the actor is itself a thin GraphQL wrapper. `scraperOutputSchema`'s `.passthrough()` already tolerates a superset of fields from the new source without a schema change.
- The sold-price path: `sold-source.ts`'s `fetchSoldComps` is **absorbed into** `booli/client.ts` rather than duplicated — its Cloudflare/Apollo-SSR logic becomes rung 1/2 of the sold branch, and the `apify/playwright-scraper` call becomes rung 3. `enrich-market-context.ts` continues to import `fetchSoldComps` but now from `@/lib/booli/client` instead of `@/lib/market/sold-source` (a one-line import change; the function signature/contract stays identical so the tiered-walk caller logic in `enrich-market-context.ts` needs zero changes).

**New vs modified:**
- **New:** `src/lib/booli/client.ts` (the unified client + fallback tree), `src/lib/booli/detail-query.ts` or similar (whatever solves the single-listing lookup — see Open Question below).
- **Modified:** `src/actions/analyze.ts` (swap `scrapeBooli` import), `src/actions/enrich-market-context.ts` (swap `sold-source` import to `booli/client`).
- **Deprecated/removed after cutover:** `src/lib/apify/booli-scraper.ts`, `src/lib/market/sold-source.ts` (logic moves into `booli/client.ts`; keep `apify-client` package dependency for rungs 2–3).
- **Untouched:** `listing.ts` schema/normalizer, `sold-schema.ts` normalizer, the entire market/report/brf pipeline downstream — this is a pure acquisition-layer swap, which is the whole point of "own the acquisition layer."

### Gating unknown (flagged for a spike, per the downstream_consumer instruction)

The spike explicitly left **single-listing-by-URL retrieval** as the one open unknown (Finding 3, MEDIUM confidence): Booli's `searchForSale` GraphQL query does not support direct-by-ID lookup per third-party MCP research; the candidates are (1) an undiscovered detail query on `/bostad/{id}`, (2) reading `__NEXT_DATA__`/Apollo state off the listing detail page HTML (same SSR-scraping technique already proven for sold comps), or (3) a filtered `searchForSale` call matched by `booliId`. **This must be resolved by a dedicated technical spike before 999.6 is planned/built** — it determines whether rung 1 of the active-listing fallback tree is a clean GraphQL call or another headless-browser SSR-state scrape (which would mean 999.6's "direct" rung looks more like sold-comps' rung 2, changing the cost/latency profile of the primary path). Recommend the spike explicitly test candidate (2) first, since it reuses proven infrastructure (`apify/playwright-scraper` + `__APOLLO_STATE__` parsing) from the sold-price work — lowest new-risk path to a working rung 1/2.

---

## (b) Broker-page extraction merges into the listing model (999.2)

### Integration shape

This is a **second, optional enrichment step appended to the existing `analyzeUrl` flow**, not a new pipeline. The existing flow already tolerates partial data (`missingFields`, `partial: boolean`) — 999.2 fills in exactly the fields the actor/GraphQL can't provide today: floor, balcony, BRF name, renovation status, full description.

**Flow:**
1. `fetchListingByUrl` (999.6, or today's `scrapeBooli`) returns the Booli-side fields as it does now.
2. The normalized listing's `agencyListingUrl` (a field Booli exposes linking to the broker's own site — Vitec-powered sites are the majority of Swedish mäklare backends) is followed with a second fetch.
3. A new normalizer, `normalizeBrokerPageOutput()`, maps broker-page HTML/JSON-LD fields onto the **same `NormalizedListing` shape**, additively.
4. The two normalized objects are merged with **Booli fields as the base, broker fields filling gaps only** (never overwriting a Booli-sourced value that's already present) — this preserves the existing trust/provenance model (D-07 "no fabrication," honest partial states) since broker data is a supplement, not a replacement.

### Schema change

**Additive, nullable, no backfill** — matches the exact posture the codebase already used for `latitude`/`longitude`/`booliId`/`breadcrumbs` (see `listing.ts` comments: "existing rows lack them (null)"). New fields on `listingDataSchema`/`NormalizedListing`:

```typescript
floor: z.number().nullable(),
hasBalcony: z.boolean().nullable(),
renovationStatus: z.string().nullable(), // free text or small enum, TBD
fullDescription: z.string().nullable(),
// brfName already exists on the schema (currently always null from the actor) --
// 999.2 is likely the FIRST source that actually populates it.
```

No migration needed for the JSONB `listing_data` column itself (schemaless at the DB layer — Postgres JSONB doesn't need a column-add migration for new keys, unlike the flat columns like `report_generating_started_at`). Zod schema fields are added as `.nullable()` optional-safe, and `normalizeScraperOutput`/new `normalizeBrokerPageOutput` both default missing fields to `null`, so **existing rows deserialize fine** — `listingDataSchema.safeParse` on an old row simply yields `floor: null` etc. (Zod requires the key to exist for a non-optional-nullable field, so verify: either mark new fields `.optional().nullable()` for maximum backward compatibility with rows written before this schema change, or run a lightweight one-time backfill-on-read shim in the normalizer. **Recommend `.nullable().optional()`** to avoid any migration/backfill entirely, consistent with the "additive, no-backfill" preference.)

### Failure handling

Broker-page fetch failure must **never fail the primary listing fetch** — same independent-degradation pattern as the price/area branches in `enrich-market-context.ts`. Wrap step 2 in its own try/catch; on failure, the merged listing is just the Booli-only listing (current v1.0 behavior), with the new fields staying null. This keeps 999.2 strictly additive and low-risk — it can literally ship as a try/catch appendage to `analyzeUrl` with zero risk of regressing the existing flow.

**New vs modified:**
- **New:** `src/lib/booli/broker-extract.ts` (fetch + parse broker page), a `normalizeBrokerPageOutput()` function (co-located with `normalizeScraperOutput` in `listing.ts` or a sibling file), broker-site-specific parsers (start with Vitec, the dominant Swedish broker CMS — verify this assumption in the 999.2 spike/plan since "most brokers use Vitec" is a claim worth confirming against a sample of real `agencyListingUrl`s before committing to a single-CMS parser).
- **Modified:** `src/lib/schemas/listing.ts` (new nullable fields + merge function), `src/actions/analyze.ts` (call the broker-extract step after the Booli fetch, merge, persist).
- **Risk to flag for a spike:** broker sites are heterogeneous (not all brokers run Vitec; some run custom CMSs). A single hard-coded parser strategy may only cover a subset of listings — worth a quick spike sampling real `agencyListingUrl` domains from recent analyses before committing to parser scope.

---

## (c) Macro price context — where it lives, cache/refresh strategy (999.3)

### Mirrors `area_data` almost exactly

The existing `area_data` column is the direct precedent: SCB demographics fetched once per analysis via `enrichMarketContext`, persisted as a durable JSONB cache, never re-fetched unless the user explicitly re-enriches. **Macro data is a better fit for a *shared*, time-keyed cache than a *per-analysis* cache**, though, because macro indicators (Riksbank policy rate, SCB house-price index, inflation) are **not listing-specific** — every analysis run in the same month sees the same macro snapshot. Caching it per-`analyses`-row (like `area_data`) would mean re-fetching identical Riksbank/SCB data on every single analysis, which is wasteful and, more importantly, means older analyses silently go stale with no refresh path.

**Recommendation: a new small shared table, not a column on `analyses`.**

```sql
-- supabase/migrations/006_macro_context.sql
create table public.macro_snapshots (
  id uuid default gen_random_uuid() primary key,
  period text not null, -- e.g. "2026-06" (year-month) or ISO date of fetch
  source text not null, -- "SCB" | "Riksbank"
  metrics jsonb not null, -- { policyRate, housePriceIndex, inflation, ... }
  fetched_at timestamptz default now() not null
);

create unique index macro_snapshots_period_source_idx
  on public.macro_snapshots (period, source);
```

Then `analyses` gets one new **additive, nullable** column referencing the snapshot used at report-generation time (for provenance/reproducibility, mirroring how `report_data_fingerprint`/`report_prompt_version` pin the report to its inputs):

```sql
alter table public.analyses add column if not exists macro_snapshot_id uuid references public.macro_snapshots(id);
```

This is additive and requires no backfill — existing rows simply have `macro_snapshot_id = null`, and the report/market-context layer treats a null macro reference exactly like a null `area_data`/`price_data` branch today (degrade gracefully, show "ej tillgänglig", never fabricate).

**Refresh strategy:** macro indicators change monthly at most (Riksbank meets ~5–6x/year; SCB house-price index is monthly). A **lazy-fetch-with-TTL** pattern fits: on each `enrichMarketContext` call, check for a `macro_snapshots` row for the current period; if absent, fetch and insert (this is a cheap, free-API call — SCB is free, Riksbank's public API is free — so no cost-cap concern like the Claude/Apify paths). No cron needed for v1.1; a lazy check-on-read is simpler and matches the "near-zero infra budget, solo dev" constraint better than scheduling a job. (If macro data usage volume grows, a Vercel Cron hitting a `/api/cron/refresh-macro` route monthly is the natural upgrade — see (d) for why cron is viable here but not for 999.7.)

**New vs modified:**
- **New:** `supabase/migrations/006_macro_context.sql`, `src/lib/market/macro.ts` (SCB house-price-index + Riksbank client, mirrors `scb.ts`'s structure: whitelisted table/series IDs, no user input in the query, `fetchMacroSnapshot(period): Promise<MacroData>`), a `macro_snapshots` lookup-or-fetch helper.
- **Modified:** `src/actions/enrich-market-context.ts` (add a third independent branch — lookup-or-fetch macro, same try/catch-degrade-to-null shape as the price/area branches), `src/lib/report/fact-sheet.ts` (include macro context in the Sonnet input when present), `supabase/migrations/` (new file, additive only).
- **Independent-degradation discipline carries over:** a macro-fetch failure must not blank price_data or area_data, and vice versa — this is now a **three-way** independent branch instead of two, same pattern, no new complexity class.

---

## (d) 999.7 — AI free-text discovery + vision scraper: THE architectural pivot

This is the one feature that does not fit the existing request/response-with-polling model, and needs the most deliberate design.

### Why the current model breaks

Every existing "long-running" operation (`analyzeBrf`, `enrichMarketContext`, `generateReport`) is **one row, one bounded external call (or a small bounded fan-out — 3 SCB tables, ≤3 sold-source renders), inside one Server Action invocation**, finishing in seconds to at most ~90s (the client's own poll ceiling assumes this). 999.7 is qualitatively different:

- **Area-wide scrape** = N listings discovered from one free-text query, N unbounded until a cap is chosen.
- **Per-listing vision analysis** = N separate Claude vision calls (description + gallery + floor-plan images), each with its own cost and latency.
- **Ranking/synthesis** = a final pass over all N results.

This is fundamentally a **fan-out batch job**, not a single request/response. Running N listings × (1 scrape + k vision calls) inside a single Server Action risks:
- **Vercel function duration limits.** Current platform ceiling (verified 2026): Hobby/Pro default 300s (5 min), extendable to 800s on Pro/Enterprise with explicit `maxDuration` config; Fluid Compute raises this further (up to 14 min on paid plans) but this is still a **hard ceiling**, not "run as long as needed." A discovery query returning, say, 20–40 candidate listings, each needing a scrape + 2–3 vision calls, will not reliably fit in one invocation once N grows — and Sonnet vision calls are not fast.
- **No queue infrastructure exists.** No Redis, no BullMQ, no Inngest/Trigger.dev today. Introducing one is a real infra decision, not a config tweak.
- **Cost blowup risk.** Today's cost caps (`COST_CAP_SEK`) gate a *single* Claude call per action. A fan-out of N listings × k images needs a **budget that gates the whole batch**, checked incrementally (per-listing), not just once at the end — otherwise a 50-listing query with no early exit could run up real spend before the cap is even checked.

### Recommended execution model: **DB-row-as-job-queue + Vercel Cron poller** (no new infra dependency)

Given the constraints (solo dev, near-zero budget, existing Supabase Postgres, no appetite for a new managed queue service), the pragmatic fit is a **lightweight polling-worker pattern using Postgres as the queue**, which is a well-established, boring, low-dependency approach (validated by 2026 practitioner writeups — e.g. "I Removed Redis From My Stack and Used PostgreSQL for Job Queues Instead") and mirrors this codebase's existing preference for "durable Postgres row = the state machine" (see: `brf_status`/`market_status`/`report_status` as literal state machines already).

**Shape:**

1. **New table**, e.g. `discovery_jobs`:
   ```sql
   create table public.discovery_jobs (
     id uuid default gen_random_uuid() primary key,
     user_id uuid references auth.users(id) on delete cascade not null,
     query_text text not null,          -- the free-text intent
     status text not null default 'pending', -- pending | scraping | analyzing | done | failed
     candidate_count int,
     processed_count int default 0,
     results jsonb,                     -- array of {listing, visionAnalysis, rankScore}
     cost_sek numeric default 0,
     created_at timestamptz default now() not null,
     updated_at timestamptz default now() not null
   );
   ```
   RLS mirrors `analyses` exactly (owner-only select/insert).

2. **The triggering Server Action** (`startDiscovery`) does the *cheap, bounded* part synchronously — validate the free-text query, run the area-wide listing search (999.6's `booli-graphql` client, `searchForSale` with filters derived from the free-text intent — this itself may need a small Claude call to translate free text → structured filters, which is fast/cheap and fits in one request), cap candidates at a fixed ceiling (e.g. `MAX_CANDIDATES = 25`), insert the `discovery_jobs` row with `status: 'pending'` and the candidate list in `results` (unscored), and return immediately. This step alone is a normal Server Action, same shape as `analyzeUrl` today.

3. **The expensive part (N × vision calls) runs OUTSIDE the request/response cycle**, driven by a **Vercel Cron job** (already platform-native, zero new dependency — confirmed viable via `vercel.json` cron config) hitting a Route Handler, e.g. `app/api/cron/process-discovery/route.ts`, every 1 minute. Each invocation:
   - Selects the oldest `pending`/`scraping`/`analyzing` job (or a small batch), using the **same atomic CAS lock pattern already proven in `generateReport`** (`update ... where status = 'pending' returning *`) to claim exclusive ownership of a job/listing-batch and avoid double-processing if two cron ticks overlap.
   - Processes a **small, bounded slice** of that job's candidates per invocation (e.g. 3–5 listings' worth of vision calls) — this respects the cron route's own duration ceiling, and turns the "N listings" problem into "N/slice_size cron ticks," each individually cheap and safely inside limits.
   - Updates `processed_count`, appends results to `results`, checks the running `cost_sek` against a **batch-level cost cap** after every slice (not just at the end) — if exceeded, sets `status: 'failed'` (or `'done'` with a partial-results flag) and stops claiming further slices for that job. This generalizes the existing "post-call persistence gate" pattern to a "post-slice persistence gate, checked incrementally."
   - When `processed_count >= candidate_count`, runs the final ranking pass and sets `status: 'done'`.

4. **The client polls `discovery_jobs.status`/`processed_count`** exactly like `BrfProgress` does today — same `setInterval`, same terminal-status stop condition — except progress is now meaningful ("12 of 25 listings analyzed") rather than a fixed 3-step ladder, which is a strictly better UX fit for a fan-out job anyway.

**Why this over a real queue service (Inngest/Trigger.dev/QStash):** those are legitimate alternatives and worth a one-line mention for the roadmapper to weigh — they remove the "cron polls a table" indirection and give built-in retries/observability, at the cost of a new paid dependency and a new mental model (webhooks, step functions) for a solo dev on a tight budget. Given the project's explicit "near-zero budget" and "solo developer, 5-10h/week" constraints, **Postgres-row-as-job-queue + Vercel Cron is the lower-risk, zero-new-dependency choice for v1.1**, with a managed queue as a documented future escalation if job volume/complexity grows past what a 1-minute cron tick comfortably handles.

### Cost control across N listings

Three layers, compounding:
1. **Hard candidate cap** at discovery time (`MAX_CANDIDATES`) — bounds N before any spend happens.
2. **Per-slice incremental cost check** during cron processing — stops a runaway job mid-way rather than only auditing after full completion (unlike today's single-call cost caps, which can afford to check post-call because the call is already bounded; a 25-listing batch cannot wait until listing 25 to notice it's over budget).
3. **Cheap-model triage before expensive vision calls** — worth flagging as a design lever for the roadmap: not every candidate needs full vision analysis. A cheap text-only pass (Haiku, like the BRF extraction tier) over the scraped listing text/metadata could pre-filter to the top-K most promising candidates before spending Sonnet-vision calls on gallery/floor-plan images, mirroring the existing Haiku(cheap)/Sonnet(expensive) tiering already in the codebase (`extract.ts` uses Haiku, `synthesize.ts` uses Sonnet).

### Persistence + progress UX

Already covered above — `discovery_jobs` table, status-column polling, no Realtime needed (consistent with the rest of the app deliberately avoiding Supabase Realtime in favor of polling). One UX note for the roadmap: a 25-listing job at even a modest per-listing latency will run for **minutes**, not seconds — this needs its own progress page/route (not squeezed into the existing single-analysis detail page), likely `/discover/[jobId]`, distinct from `/analysis/[id]`.

### Flag for a spike before planning

**Yes — explicitly flag per the downstream_consumer note.** Before 999.7 is roadmapped in detail, a spike should resolve:
- Confirm Vercel Cron is available/acceptable on the current hosting tier (Hobby plan cron has stricter limits — fewer cron jobs, coarser schedule granularity — verify against the actual deployment plan).
- Confirm the free-text-intent → structured-search-filter translation step's reliability (this is itself a small AI-parsing problem that could silently under/over-constrain the candidate set).
- Prototype the atomic-claim SQL for the cron worker against concurrent ticks (extending the `generateReport` CAS pattern to a multi-row claim, e.g. `UPDATE ... WHERE id = (SELECT id FROM discovery_jobs WHERE status='pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *` — Postgres `FOR UPDATE SKIP LOCKED` is the standard primitive for this and hasn't been used in this codebase yet).

**New components (999.7):**
- `supabase/migrations/007_discovery_jobs.sql` (new table + RLS)
- `src/actions/start-discovery.ts` (the bounded, synchronous trigger action)
- `app/api/cron/process-discovery/route.ts` (the cron-driven batch worker)
- `src/lib/discovery/intent-parse.ts` (free-text → structured filter, cheap Claude call)
- `src/lib/discovery/vision-analyze.ts` (per-listing vision call: description + gallery + floor-plan, sun-path exposure heuristic)
- `src/lib/discovery/rank.ts` (deterministic or LLM-assisted ranking pass — recommend deterministic scoring on top of AI-extracted structured attributes, consistent with the codebase's existing "deterministic score, LLM narrates" philosophy already enforced for BRF grading and report flags)
- `vercel.json` (new — cron schedule config; doesn't exist today)
- New page/route `app/discover/[jobId]/page.tsx` + a `DiscoveryProgress` client component (parallel to `BrfProgress`)

**Modified:** none of the existing single-listing flow needs to change — 999.7 is additive, parallel functionality, not a replacement.

---

## (e) BRF auto-fetch inserts ahead of manual upload

### Integration shape

This slots in as a **new pre-step, additive to the existing `analyzeBrf` flow**, not a replacement. Today's flow starts with a user manually uploading a PDF via a form (`analyzeBrf(formData)` expects a `file: File`). The auto-fetch feature (Allabrf/Bolagsverket lookup by BRF name/org-nummer) should attempt to **locate and fetch the PDF automatically**, then **feed it into the exact same `analyzeBrf` pipeline** by constructing an equivalent `File`/`Uint8Array` — the extraction/scoring/persistence logic downstream of "we have PDF bytes" is completely reused, untouched.

**Flow:**
1. New step, triggered automatically once a listing has a `brfName` (which itself depends on 999.2 or 999.6 actually populating that field — today it's always null from the actor, per the `listing.ts` comment) — attempt lookup via Allabrf/Bolagsverket by BRF name (and org-nummer if resolvable).
2. On success: fetch the PDF bytes server-side, then call the **same internal logic `analyzeBrf` already runs from byte 195 onward** (hash → scanned-detection → upload-to-storage → extract → score → persist) — ideally by factoring that shared logic into an internal helper `runBrfExtraction(analysisId, bytes, source: "auto"|"manual")` that both the auto-fetch path and the existing manual-upload action call into. This avoids duplicating the D-06 replace-identical-hash cache, the cost-cap gate, and the sanity/scoring pipeline.
3. On failure (BRF not found in either source, ambiguous match, or fetch error): **fall through to the existing manual-upload UI** — this is explicitly a fallback relationship per the milestone brief, so the failure path is just "do nothing different," i.e., today's `BrfUpload` component renders as it does now.

### Status/UX integration

Add one new transient status value to the existing `brf_status` state machine — e.g. `"auto_fetching"` — inserted before `"reading"`/`"extracting"` in the `BrfProgress` component's `STEPS` array (or shown as a distinct "Söker efter årsredovisning automatiskt..." message that either resolves into the existing step ladder on success or dismisses in favor of the manual upload form on failure/not-found). No new polling mechanism needed — same column, same client component, one more state.

### Schema/data changes

**Additive, nullable, no backfill:**
```sql
alter table public.analyses add column if not exists brf_fetch_source text; -- 'auto' | 'manual' | null
```
This single nullable text column records provenance (useful for later analytics on auto-fetch hit rate) without disturbing any existing row (`null` = pre-999.7-analyses or manual-only). No changes needed to `brf_data`'s JSONB shape — the extraction/grade/citations structure is identical regardless of source.

**New vs modified:**
- **New:** `src/lib/brf/auto-fetch.ts` (Allabrf/Bolagsverket lookup-by-name client, PDF fetch), `supabase/migrations/00N_brf_fetch_source.sql`.
- **Modified:** `src/actions/analyze-brf.ts` — refactor to extract the "given bytes, do extraction" core into a shared internal function callable from both a new `autoFetchBrf(analysisId)` action and the existing `analyzeBrf(formData)` action; add a trigger point (likely fired right after `analyzeUrl` succeeds and `brfName` is known, or as an explicit user-visible "Sök automatiskt" affordance before falling back to upload).
- **Order-of-operations dependency worth flagging:** auto-fetch is only useful once `brfName` is reliably populated — which today it is **not** (actor never returns it). This creates a soft dependency: 999.2 (broker extraction, which may recover `brfName`) or a Bolagsverket/Allabrf **name-free** lookup path (e.g. by address instead of BRF name) should be considered before/alongside BRF auto-fetch, or the auto-fetch trigger condition needs its own address-based BRF-name resolution step. Flag this for the roadmapper: BRF auto-fetch has a soft data dependency on 999.2, even though the milestone brief lists it as "more independent."

---

## Build Order (dependency-aware)

Honoring the milestone's stated dependency chain (999.6 → 999.2 → 999.7; 999.3 and BRF-auto-fetch more independent) and the integration analysis above:

1. **999.6 spike: single-listing-by-URL retrieval** (blocking — must resolve before any 999.6 build work; see (a) Open Question). Cheap, code-free investigation.
2. **999.6 build** — unified `booli-graphql` client + fallback tree, replacing `booli-scraper.ts` and absorbing `sold-source.ts`. This is the foundation everything else (999.2's broker-URL source, 999.7's area-wide search) sits on top of.
3. **999.3 (macro context)** — fully independent of 999.6/999.2/999.7; can be built in parallel with 999.6 by a solo dev context-switching, or slotted in whenever convenient. Only true prerequisite: none (SCB/Riksbank are separate free APIs, `enrich-market-context.ts`'s existing independent-branch pattern absorbs a third branch trivially).
4. **999.2 (broker-page extraction)** — depends on 999.6 shipping (needs the `agencyListingUrl` field reliably present from the listing fetch, and ideally reuses 999.6's fallback-tree conventions for its own broker-fetch step). Low risk, purely additive.
5. **BRF auto-fetch** — nominally independent, but *effectively* soft-depends on 999.2 (or an alternate address-based lookup) for a reliable `brfName`. Recommend sequencing **after 999.2**, not fully parallel, despite the milestone brief's "more independent" framing — flag this discrepancy to the roadmapper explicitly.
6. **999.7 (AI discovery + vision scraper)** — depends on 999.6 (needs the area-wide search capability from the unified Booli client) and benefits from 999.2 (richer per-listing data improves ranking quality) though could ship with a v1 subset of fields. This is also the largest net-new architecture (job table, cron worker, new page) and should be scoped last, with its own pre-planning spike (see (d)) covering Vercel Cron availability/limits and the `FOR UPDATE SKIP LOCKED` claim pattern.

**Summary dependency graph:**
```
999.6 spike -> 999.6 build --+--> 999.2 --> BRF auto-fetch
                              +--> 999.7 (spike -> build)

999.3 -- independent, parallelizable at any point
```

---

## Integration Points Summary

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Booli GraphQL (direct) | Server-side `fetch`, keyless, behind Cloudflare | Rung 1 of 999.6's fallback tree; single-listing lookup mechanism is the open spike question |
| Apify residential proxy (SE) | Routed fetch via existing `APIFY_API_TOKEN`, no actor | Rung 2 — reuses existing Apify client/token, drops per-actor billing |
| Apify actor (`lexis-solutions/booli-se-scraper`, `apify/playwright-scraper`) | `ApifyClient.actor().call()` | Rung 3 — kept as last-resort safety net, not removed |
| Broker/Vitec pages (999.2) | Server-side `fetch` + HTML/JSON-LD parse | Independent per-broker-CMS risk; verify CMS coverage before committing |
| SCB PxWebApi (existing + 999.3) | POST json-stat2, free, keyless, whitelisted tables/codes | 999.3 adds house-price-index table(s) to the same client pattern |
| Riksbank API (999.3, new) | Public REST, free, keyless (verify exact API surface in 999.3 planning) | New client module, mirrors `scb.ts` conventions |
| Allabrf / Bolagsverket (BRF auto-fetch, new) | Lookup-by-name/org-nummer + PDF fetch | Soft-depends on reliable `brfName`; needs its own spike on match precision |
| Anthropic Claude (existing + 999.7 vision) | `messages.parse` + `zodOutputFormat`, coded-error pipeline | 999.7 adds vision content blocks (images) to the message; same cost-cap discipline, now checked per-slice not per-call |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| `booli/client.ts` <-> `analyze.ts` / `enrich-market-context.ts` | Direct function import, same contract as today's `scrapeBooli`/`fetchSoldComps` | Zero-diff swap point by design |
| `analyze.ts` <-> new broker-extract step (999.2) | In-process, same action, sequential await + merge | No new module boundary — an appendage to the existing action |
| `enrich-market-context.ts` <-> macro branch (999.3) | New independent try/catch branch, same file | Extends the existing 2-branch (price/area) pattern to 3 |
| `startDiscovery` action <-> `discovery_jobs` table <-> cron worker route | Postgres row as queue; atomic `UPDATE ... RETURNING` claim (CAS, extending `generateReport`'s lock pattern to `FOR UPDATE SKIP LOCKED`) | The one genuinely new internal boundary — request/response process handoff to a separately-invoked cron process, coordinated only through the DB row |
| `analyze-brf.ts` core logic <-> new `autoFetchBrf` action | Shared internal helper function (`runBrfExtraction`), two callers | Refactor existing action to extract reusable core rather than duplicating the D-06 cache/cost-cap logic |

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Running 999.7's fan-out inside a single Server Action

**What people do:** Try to keep the "no new infra" simplicity by looping over all N candidate listings' vision calls inside one `startDiscovery` action, relying on a generous `maxDuration`.
**Why it's wrong:** Hits Vercel function duration ceilings unpredictably as N grows or vision-call latency varies; a mid-batch failure loses all progress (no partial persistence); cost-cap can only be checked at the very end, after the spend already happened.
**Do this instead:** Split into a cheap synchronous "create job + cap candidates" action and a cron-driven incremental worker that persists progress after every slice (Section (d)).

### Anti-Pattern 2: Duplicating the sold-comps fallback logic instead of absorbing it into `booli/client.ts`

**What people do:** Build the new unified active-listing client as a parallel module and leave `sold-source.ts`'s Cloudflare/Apollo-SSR logic where it is, resulting in two near-identical fallback trees maintained separately.
**Why it's wrong:** The whole point of 999.6 (per the spike) is "one acquisition layer, one fallback tree" — two trees defeats the ownership/maintenance win and doubles the surface area for Booli frontend-change breakage.
**Do this instead:** Migrate `sold-source.ts`'s logic into `booli/client.ts` as the sold-branch implementation, sharing the transport/fallback primitives with the active-listing branch.

### Anti-Pattern 3: Backfilling old rows when adding nullable columns

**What people do:** Write a migration that also UPDATEs existing rows to populate new columns/fields with computed or default values.
**Why it's wrong:** Explicitly against this codebase's established posture (`latitude`/`longitude`/`booliId`/`breadcrumbs`, `report_generating_started_at` were all added additive-nullable, no backfill) — a backfill on a shipped product also risks expensive/rate-limited re-fetching of external data for old rows for no immediate value.
**Do this instead:** Every new column/field for 999.2/999.3/999.7/BRF-auto-fetch is nullable, defaults to null for existing rows, and only populates on the next fresh run of the relevant flow — consistent with the "PostgREST NULL filter trap" lesson already learned in this codebase (use `.is(col, null)`, never `.eq(col, null)`, when querying these new nullable columns).

---

## Scaling Considerations

| Concern | Now (v1.1, low volume) | If discovery-query volume grows | If truly high volume |
|---------|------------------------|----------------------------------|----------------------|
| 999.7 job processing | 1-minute Vercel Cron polling `discovery_jobs`, small slice per tick | Increase slice size / cron frequency; add a `priority`/`queue_position` column | Migrate to a managed queue (Inngest/Trigger.dev/QStash) — the DB-row shape ports over as the job's persisted state, so this is not a rewrite |
| Vision-call cost | Hard candidate cap + per-slice cost check | Add cheap-model (Haiku) triage pass before vision calls | Consider caching vision analyses per-listing (keyed by `booliId`) since the same listing may recur across multiple users' discovery queries |
| Macro snapshot cache | Lazy fetch-or-reuse on each enrich call | Add a monthly Vercel Cron refresh instead of lazy-on-read | Unlikely to matter — macro data volume is inherently tiny |

---

## Sources

- Direct code reading: `src/actions/analyze.ts`, `src/actions/analyze-brf.ts`, `src/actions/generate-report.ts`, `src/actions/enrich-market-context.ts`, `src/lib/apify/booli-scraper.ts`, `src/lib/market/sold-source.ts`, `src/lib/market/scb.ts`, `src/lib/schemas/listing.ts`, `src/components/brf-progress.tsx`, `supabase/migrations/001_analyses.sql` through `005_report_lock.sql`, `next.config.ts` (HIGH confidence — these are the ground truth for "how this app already does things")
- `.planning/spikes/booli-own-acquisition-SPIKE.md` (HIGH confidence on field parity/transport, MEDIUM confidence flagged by the spike itself on single-listing retrieval)
- [Configuring Maximum Duration for Vercel Functions](https://vercel.com/docs/functions/configuring-functions/duration) — MEDIUM-HIGH confidence, official docs, current duration ceilings (300s default, 800s extended, Fluid Compute up to 14 min paid)
- [Long-running background functions on Vercel — Inngest Blog](https://www.inngest.com/blog/vercel-long-running-background-functions) — MEDIUM confidence, vendor blog but technically substantive on the "split into steps" pattern
- [Vercel Cron Jobs docs](https://vercel.com/docs/cron-jobs) and [Managing Cron Jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs) — HIGH confidence, official docs, confirms native `vercel.json`-driven cron with no new dependency
- [I Removed Redis From My Stack and Used PostgreSQL for Job Queues Instead — DEV Community](https://dev.to/aws-builders/i-removed-redis-from-my-stack-and-used-postgresql-for-job-queues-instead-2lp5) — LOW-MEDIUM confidence (community post, not authoritative), used only to corroborate that Postgres-as-queue is an established, not exotic, pattern for a solo-dev/no-Redis context
- [Running background jobs · vercel/next.js Discussion #33989](https://github.com/vercel/next.js/discussions/33989) — MEDIUM confidence, official repo discussion thread, corroborates the general "no always-running process on serverless" constraint driving the cron-poller design

---
*Architecture research for: v1.1 Owned Data Layer & Intelligent Discovery — integration architecture*
*Researched: 2026-07-06*
