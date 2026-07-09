# Phase 5: Owned Booli Acquisition - Research

**Researched:** 2026-07-06
**Domain:** Booli acquisition-layer consolidation (Playwright/Apollo-state transport generalization, fallback-tree observability)
**Confidence:** HIGH

## Summary

The hard research for this phase is already done and shipped. `src/lib/market/sold-source.ts` proves — in production, with real billing data — that Booli server-renders its Apollo state into every page (`__NEXT_DATA__ → props.pageProps.__APOLLO_STATE__`), that a raw fetch (even via the Apify RESIDENTIAL/SE proxy) is Cloudflare-403'd, and that only `apify/playwright-scraper` (chromium) + RESIDENTIAL/SE proxy reliably clears the challenge (4/4 clean runs, ~$0.0055/render, `maxRequestRetries: 3` after one 403 streak proved 1 retry insufficient). This phase does not re-investigate any of that. It generalizes the pattern into one client, closes the single remaining evidence gap (field parity on the detail-page `Listing:<booliId>` object), and adds fallback-tree observability that today's `sold-source.ts` and `booli-scraper.ts` do not have (each is a single-transport module with no rungs).

The one genuinely open question is narrow and mechanical: does `__APOLLO_STATE__` on a listing detail page (`/bostad/{id}` or `/annons/{id}`) contain a `Listing:<booliId>` entry with the same field set the paid actor returns (`streetAddress`, `price`/`listPrice`/`listSqmPrice`/`estimate`, `livingArea`, `rooms`, `objectType`, `tenureForm`, `latitude`/`longitude`/`booliId`, `breadcrumbs`, `infoPoints`, `rent`/`avgift`, `agencyListingUrl`, `constructionYear`)? `03-SPIKE.md` §2 already scraped a detail page and successfully read `breadcrumbs` from its Apollo state via this exact transport — that is direct evidence the detail page SSRs a `Listing` object through the same mechanism as sold pages SSR `SoldProperty` objects. What has NOT been directly confirmed is the *complete* field list on that specific object. This research pins the exact key format and the confirmation procedure; the confirmation itself is a single real-Apify probe the plan should run once, early, as a spike task (not exploratory research).

**Primary recommendation:** Build `src/lib/booli/client.ts` as three thin functions (`fetchListing`, `fetchAreaListings`, `fetchSoldComps`) sharing one `runPlaywrightRender(url, pageFunction)` core and one fallback-tree walker, all reusing the exact actor config (`apify/playwright-scraper`, chromium, RESIDENTIAL/SE, `maxRequestRetries: 3`, `waitSecs: 240`) already proven in `sold-source.ts`. Absorb `fetchSoldComps` verbatim (rename call sites only). Do NOT touch `normalizeScraperOutput` or `scraperOutputSchema` — the client's job is to produce the same raw shape `scrapeBooli()` produces today, so downstream normalization is a no-op migration.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Single-listing detail fetch (ACQ-01) | API/Backend (`src/lib/booli/client.ts`, server-only) | External: Apify Playwright actor (browser-tier render happens inside Apify's container, not ours) | Server Action (`analyzeUrl`) calls a server-only module; the actual page render is delegated to a third-party managed browser, but the *decision* of which rung to use and how to normalize lives in our backend tier |
| Area/multi-listing fetch (ACQ-02) | API/Backend (`src/lib/booli/client.ts`) | External: Apify Playwright actor | Same transport, different `startUrls`/`pageFunction`; foundation for Phase 9 discovery, which is itself backend (Cron + DB job queue) |
| Sold-comps fetch (absorbed, PRICE-01 continuity) | API/Backend (`src/lib/booli/client.ts`, migrated from `sold-source.ts`) | External: Apify Playwright actor | Already backend-owned; this phase only relocates/renames, no tier change |
| Fallback-tree walk + health/source surfacing (ACQ-03) | API/Backend | — | Decision logic (which rung served the request) is pure backend state; no client-tier involvement — the UI only ever sees the final result + a source/health label, never drives the retry logic itself |
| Paid-actor last resort (`bpf1JaYRBbia2nQU9`) | External (Apify-hosted actor) | API/Backend (thin wrapper, `booli-scraper.ts` logic reused as rung 3) | Unowned code we call as a service; our tier only decides *when* to fall back to it |
| Drop-in for `scrapeBooli()` call site (`analyze.ts`) | API/Backend (Server Action) | — | No tier change from today; `analyzeUrl` keeps calling one function, only the import target changes |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `apify-client` | `^2.22.2` (installed; latest `2.23.4` `[VERIFIED: npm registry]`) | Node SDK for calling the Apify Playwright actor and reading its dataset | Already the exclusive transport dependency in `sold-source.ts` and `booli-scraper.ts`; no new package needed |
| `apify/playwright-scraper` (hosted actor, not npm) | pinned by Apify, no local version | The ONLY transport proven to clear Booli's Cloudflare challenge on HTML pages | `03-SPIKE.md` §1.2 probe matrix: raw fetch and proxy-routed raw fetch both 403; only this actor returns 200 |
| `zod` (`zod/v4` import path) | already in use (`^4.x`, see `listing.ts`/`sold-schema.ts`) | Permissive `.passthrough()` raw-payload validation + coercion helpers | Matches the exact pattern `sold-schema.ts` and `listing.ts` already use; the client's parsers should mirror this, not introduce a new validation style |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `bpf1JaYRBbia2nQU9` (Apify hosted actor, `lexis-solutions/booli-se-scraper`) | pinned by Apify | Paid actor — becomes rung 3 (last resort) instead of the default path | Only when rungs 1–2 (own Playwright render) both fail |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Apify-hosted Playwright actor | Self-hosted Playwright (own container/Lambda) | Would remove per-render Apify billing but adds infra (proxy sourcing, IP reputation, container lifecycle) the project has zero appetite to own solo; explicitly out of scope per CONTEXT.md pre-decided direction |
| SSR `__APOLLO_STATE__` scrape | Booli `/graphql` keyless API | Dead end — `03-SPIKE.md` §1.1: `/graphql` sits behind a stricter, separate Cloudflare zone; even a CF-cleared Playwright page gets 403 on a same-origin POST to it. Do not pursue (explicitly pre-decided, not open for re-litigation) |
| One shared client module | Three separate modules (listing/area/sold) | Rejected per CONTEXT.md pre-decided direction — `src/lib/booli/client.ts` unifies all three; keeps the fallback-tree and actor-config logic in one place instead of triplicated |

**Installation:**
No new packages. `apify-client` is already a dependency; consider bumping `^2.22.2` → `^2.23.4` opportunistically (patch-level, low risk) but this is not required for the phase.

```bash
npm view apify-client version   # confirms 2.23.4 available as of this research
```

**Version verification:** `apify-client@2.23.4` confirmed live via `npm view apify-client version` during this research session `[VERIFIED: npm registry]`. The installed `^2.22.2` range is current and functional — no forced bump needed; this phase's scope is architecture, not dependency maintenance.

## Package Legitimacy Audit

No new external packages are introduced by this phase. `apify-client` is an existing, long-standing dependency already vetted and running in production (`src/lib/apify/booli-scraper.ts`, `src/lib/market/sold-source.ts`); the Apify-hosted actors (`apify/playwright-scraper`, `bpf1JaYRBbia2nQU9`) are not npm/PyPI/crates packages and are not subject to the slopcheck registry-verification protocol — they are third-party SaaS actors invoked via the existing `ApifyClient` SDK, already in live use.

**Packages removed due to slopcheck [SLOP] verdict:** none — no new packages proposed.
**Packages flagged as suspicious [SUS]:** none.

*Package Legitimacy Gate not run — not applicable, zero new package installs in this phase's scope.*

## Architecture Patterns

### System Architecture Diagram

```
                     ┌─────────────────────────────────────────┐
                     │   Server Action (analyzeUrl, area        │
                     │   search action — ACQ-01/02 entry points)│
                     └───────────────────┬───────────────────────┘
                                         │  calls
                                         ▼
                     ┌─────────────────────────────────────────┐
                     │  src/lib/booli/client.ts                │
                     │  fetchListing(url) | fetchAreaListings() │
                     │  | fetchSoldComps(query)  [absorbed]      │
                     │                                           │
                     │  each delegates to → walkFallbackTree()   │
                     └───────────────────┬───────────────────────┘
                                         │
                     ┌───────────────────┴───────────────────────┐
                     │         walkFallbackTree(rungs[])          │
                     │  tries rung 1 → on throw, rung 2 → on      │
                     │  throw, rung 3. Records { source, health,  │
                     │  rung } on every attempt (ACQ-03).         │
                     └──┬────────────────┬─────────────────┬─────┘
                        │ rung 1         │ rung 2           │ rung 3
                        ▼                ▼                  ▼
          ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────────┐
          │ Playwright render │ │ Playwright render │ │ Paid actor            │
          │ via Apify actor,  │ │ via Apify actor,  │ │ bpf1JaYRBbia2nQU9      │
          │ RESIDENTIAL/SE    │ │ different proxy   │ │ (lexis-solutions)      │
          │ proxy — THE       │ │ group/country OR  │ │ — last resort only     │
          │ "direct" rung in  │ │ retried config    │ │                        │
          │ practice (raw     │ │ (see Fallback     │ │                        │
          │ fetch is a dead   │ │ Tree section)      │ │                        │
          │ end — see below)  │ │                    │ │                        │
          └─────────┬─────────┘ └─────────┬──────────┘ └───────────┬────────────┘
                    │                     │                        │
                    └─────────────────────┴────────────────────────┘
                                         │
                                         ▼
                     ┌─────────────────────────────────────────┐
                     │  Raw payload (same shape as today's       │
                     │  scraperOutputSchema / SoldPayload)        │
                     │  → normalizeScraperOutput / normalizeSold  │
                     │    Output (UNCHANGED, no-op migration)     │
                     └─────────────────────────────────────────┘
                                         │
                                         ▼
                     ┌─────────────────────────────────────────┐
                     │  ListingData / SoldComp[] → DB / UI       │
                     └─────────────────────────────────────────┘
```

### Recommended Project Structure
```
src/lib/booli/
├── client.ts          # fetchListing, fetchAreaListings, fetchSoldComps (public API)
├── transport.ts        # runPlaywrightRender() — shared actor-call core (actor config, waitSecs, retries)
├── fallback-tree.ts     # walkFallbackTree() — rung iteration + { source, health, rung } result
├── page-functions.ts    # LISTING_PAGE_FUNCTION, AREA_PAGE_FUNCTION, SOLD_PAGE_FUNCTION (serialized strings sent to the actor)
└── client.test.ts       # unit tests (mocked ApifyClient) — see Validation Architecture
```
`src/lib/market/sold-source.ts` becomes a thin re-export (or is deleted with call sites updated) once `fetchSoldComps` moves into `client.ts` — keep `resolveAreaId` where it is or move it alongside; it is sold-comps-specific logic, not generic transport, so a `src/lib/market/` location remains defensible, but co-locating it in `src/lib/booli/` is equally reasonable since the client owns all three call shapes. Either is fine; do not create a third split location.

### Pattern 1: One transport core, three page functions
**What:** A single `runPlaywrightRender(url: string, pageFunction: string, options?)` function wraps the exact actor-call shape already proven in `sold-source.ts` (`client.actor("apify/playwright-scraper").call({...}, { waitSecs: 240 })`). Each of the three call shapes (single listing, area search, sold comps) supplies its own `pageFunction` string (browser-side JS serialized to the actor) but shares retry count, proxy config, and `waitSecs`.
**When to use:** Any time a new page-shape needs to be read from Booli's SSR Apollo state — this is the seam for future field additions (e.g. Phase 6's broker-page follow-through does NOT reuse this, since that's a different domain entirely, but any *Booli* page addition does).
**Example:**
```typescript
// Source: generalized from src/lib/market/sold-source.ts (proven, shipped 03-SPIKE.md)
const PLAYWRIGHT_SCRAPER_ACTOR = "apify/playwright-scraper";

export async function runPlaywrightRender(
  url: string,
  pageFunction: string,
): Promise<unknown[]> {
  const run = await client.actor(PLAYWRIGHT_SCRAPER_ACTOR).call(
    {
      startUrls: [{ url }],
      launcher: "chromium",
      proxyConfiguration: {
        useApifyProxy: true,
        apifyProxyGroups: ["RESIDENTIAL"],
        apifyProxyCountry: "SE",
      },
      maxRequestRetries: 3, // proven necessary — a single 403 streak returned 0 items on retry budget 1
      maxPagesPerCrawl: 1,
      pageFunction,
    },
    { waitSecs: 240 }, // cold-start headroom, proven necessary in booli-scraper.ts + sold-source.ts
  );
  if (run.status !== "SUCCEEDED") {
    throw new Error(`Booli-kallan blev inte klar i tid (status: ${run.status})`);
  }
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  if (!items.length) throw new Error("Inga resultat fran Booli-kallan");
  return items;
}
```

### Pattern 2: Apollo-state page function, parameterized by typename
**What:** The existing `PAGE_FUNCTION` in `sold-source.ts` reads `__NEXT_DATA__ → props.pageProps.__APOLLO_STATE__` and returns `{ hasApollo, __APOLLO_STATE__ }`. Generalize by keeping this exact extraction logic and letting the *caller* (client.ts) pick out the right typename prefix (`Listing:` vs `SoldProperty:`) during normalization, not inside the page function itself — the page function's job is only "get me the whole Apollo blob," never "get me this one key," because Apollo entity boundaries are the caller's business logic.
**When to use:** For both the detail-page single-listing fetch and the area-search fetch — both are SSR Apollo pages, just with different root query shapes.
**Example:**
```typescript
// Source: verbatim from src/lib/market/sold-source.ts PAGE_FUNCTION (shipped, proven)
const PAGE_FUNCTION = `async function pageFunction(context) {
  const { page } = context;
  const apollo = await page.evaluate(() => {
    const el = document.getElementById("__NEXT_DATA__");
    if (!el || !el.textContent) return null;
    try {
      const data = JSON.parse(el.textContent);
      return data?.props?.pageProps?.__APOLLO_STATE__ ?? null;
    } catch {
      return null;
    }
  });
  return { hasApollo: apollo !== null, __APOLLO_STATE__: apollo };
}`;
```
This SAME string works unmodified for the listing-detail page and the area-search page — only the `startUrls` differ. Do not write three different page functions unless a probe shows the Apollo extraction genuinely differs by page type (unlikely — Next.js Pages Router SSR hydration is uniform across page types on the same app).

### Pattern 3: Fallback-tree walker returns a discriminated result, never throws until every rung is exhausted
**What:** `walkFallbackTree(rungs: FallbackRung[]): Promise<{ data: unknown; source: string; rung: number; health: "ok" | "degraded" }>`. Each rung is `{ label: string; attempt: () => Promise<unknown> }`. The walker tries rung 1; on throw, logs + tries rung 2; on throw, tries rung 3 (paid actor); if rung 3 also throws, the walker itself throws (mirrors `fetchSoldComps`'s existing HIGH-1 discipline: a dead source must never silently return `[]`/empty — it must throw distinguishably).
**When to use:** Every one of the three client entry points (`fetchListing`, `fetchAreaListings`, `fetchSoldComps`) wraps its rungs in this walker so ACQ-03's "surfaces which rung/source/health served the data" requirement is met identically everywhere, not reimplemented three times.
**Example:**
```typescript
// Pattern to build — no existing code to cite verbatim (net-new for ACQ-03)
export interface FallbackResult<T> {
  data: T;
  source: "own-playwright" | "own-playwright-retry" | "paid-actor";
  rung: 1 | 2 | 3;
  health: "ok" | "degraded";
}

export async function walkFallbackTree<T>(
  rungs: Array<{ source: FallbackResult<T>["source"]; attempt: () => Promise<T> }>,
): Promise<FallbackResult<T>> {
  let lastError: unknown;
  for (let i = 0; i < rungs.length; i++) {
    try {
      const data = await rungs[i].attempt();
      return {
        data,
        source: rungs[i].source,
        rung: (i + 1) as 1 | 2 | 3,
        health: i === 0 ? "ok" : "degraded",
      };
    } catch (error) {
      console.error(`[booli-client] rung ${i + 1} (${rungs[i].source}) failed`, error);
      lastError = error;
    }
  }
  throw new Error(
    `Alla Booli-kallor misslyckades: ${lastError instanceof Error ? lastError.message : "okant fel"}`,
  );
}
```

### Anti-Patterns to Avoid
- **Building a keyless GraphQL client:** Pre-decided against — `/graphql` is a stricter, separate CF zone; both 03-SPIKE.md and the 999.6 brief independently confirm this is a dead end. Do not spend any task budget probing it.
- **Treating "direct" as a raw fetch:** The `sold-source.ts` probe matrix shows raw fetch (even proxy-routed) is 403 in every case tested. Naming a fallback rung "direct" in code/docs without the qualifier "via Playwright" will mislead future maintainers into thinking a cheap raw-fetch path exists. Always write "own Playwright render" for rung 1/2, reserving "direct" only in prose that clarifies it excludes the paid third-party actor.
- **Three separate `pageFunction` strings for three near-identical Apollo reads:** Wastes actor-config surface and triples the place a future Cloudflare-defense change has to be applied. One extraction function, differentiated by `startUrls` only, unless a probe proves otherwise.
- **Changing `normalizeScraperOutput`/`scraperOutputSchema`:** Out of scope. The client's contract is "produce the same raw object shape `scrapeBooli()` produces today." If field-parity confirmation (below) finds a genuinely missing field, the correct response is either (a) it doesn't block this phase — ship with the same partial-field tolerance the actor already has (`missingFields` array in `analyze.ts` already handles this), or (b) escalate per CONTEXT.md's own escalation clause, not silently reshape the normalizer.
- **Skipping `maxRequestRetries: 3`:** `sold-source.ts`'s comment is explicit: a single retry budget failed once (0 items on a 403 streak); 3 absorbed it. Do not "clean up" this number down to 1 for the new client without separately re-proving it — it looks arbitrary but is evidence-backed.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cloudflare challenge clearing | A custom browser-fingerprint spoofing layer, custom TLS/JA3 tricks, or a raw-fetch-with-clever-headers attempt | `apify/playwright-scraper` (real chromium) + RESIDENTIAL/SE proxy | Already proven the only working transport (4/4 clean, `03-SPIKE.md` §1.2); a custom solution would be strictly worse and re-open a settled question |
| Apollo cache key parsing / `displayAttributes(...)` variant selection | Naive first-match `Object.keys(...).find()` | The deterministic sort + SERP-variant-preference pattern already built in `sold-schema.ts`'s `dataPointsOf()` | That exact non-determinism bug (WR-05) was already found and fixed for sold comps; the listing-detail Apollo state can plausibly carry the same multi-variant `displayAttributes` shape — reuse the fixed pattern rather than rediscover the bug |
| Retry/backoff for actor calls | A custom exponential-backoff wrapper around `client.actor().call()` | The actor's own `maxRequestRetries` config param | Apify's actor already retries at the crawler layer; wrapping it again in application-level retry logic double-retries and multiplies cost/latency for no benefit |
| Detecting "dead source vs. genuinely empty area" | Returning `[]` and letting callers guess | The existing HIGH-1 discipline: throw distinguishably, never silently return an empty array | `sold-source.ts`'s own doc comment states this explicitly as a solved design problem — carry the same discipline into `fetchListing`/`fetchAreaListings` |

**Key insight:** Every "hand-roll trap" in this domain has already been hit and fixed once in `sold-source.ts`/`sold-schema.ts`. The main risk in this phase is *not* rediscovering a new pitfall — it's failing to carry forward a fix that was already earned (retry count, variant-selection determinism, throw-not-empty discipline) into the new unified client.

## Common Pitfalls

### Pitfall 1: Cloudflare fragility drift (the whole source could tighten CF posture)
**What goes wrong:** Booli could extend the stricter `/graphql`-style CF challenge to the HTML pages the client depends on, silently degrading all three call shapes at once.
**Why it happens:** The site owner controls CF configuration; nothing in this architecture can prevent a future tightening.
**How to avoid:** Alert on `hasApollo === false` / non-200 renders (already the pattern in `sold-source.ts`); the fallback tree's rung-3 paid actor is the genuine circuit breaker (`03-SPIKE.md` §5 risk #2 already names this as "low today, monitor").
**Warning signs:** A sudden spike in rung-2/rung-3 usage in the ACQ-03 observability surface; `hasApollo === false` rate climbing above the historical near-zero baseline.

### Pitfall 2: Cold-start `waitSecs` under-budgeting
**What goes wrong:** A tight wait ceiling (e.g. 60s) returns an empty dataset mid-run and is misread as "no results" — this exact bug is documented as already having happened once in `booli-scraper.ts`'s own comment.
**Why it happens:** Apify container cold-start (image pull + creation) can consume ~60s before crawling even begins; a warm run finishes fast, so the failure only shows up intermittently, making it easy to under-provision based on happy-path testing.
**How to avoid:** Keep `waitSecs: 240` for every rung that calls the Apify Playwright actor (both proven in `sold-source.ts` and `booli-scraper.ts`) — do not tighten it for the new client without separately re-proving a shorter ceiling is safe.
**Warning signs:** Intermittent "no results" errors that don't reproduce on retry — a strong signal of a wait-ceiling race, not a genuine empty result.

### Pitfall 3: Cost creep from ungoverned rung-3 (paid actor) fallback frequency
**What goes wrong:** If rungs 1–2 fail more often than expected (e.g. due to Pitfall 1), traffic silently shifts to the paid actor, which has its own subscription (~$29/mo + usage, per the 999.6 brief) — defeating the "no silent dependency on the paid actor" goal of ACQ-03 by making the fallback itself invisible.
**Why it happens:** Without the ACQ-03 observability layer, a fallback to rung 3 looks identical to a successful rung-1 call from the caller's perspective — same return shape, no health signal.
**How to avoid:** ACQ-03's `source`/`health`/`rung` result fields must be surfaced somewhere observable (logs at minimum; a dashboard/metric is a nice-to-have but out of this phase's minimum bar) — this is exactly what makes the dependency non-silent.
**Warning signs:** Apify billing dashboard shows an unexpected mix of actor runs (paid actor line items growing) with no corresponding alert fired from the application.

### Pitfall 4: Detail-page vs. SERP Apollo-state field mismatch (the narrow confirmation's actual risk)
**What goes wrong:** `03-SPIKE.md` §2 explicitly notes "breadcrumbs come from the DETAIL page, not the SERP" — SERP `Listing` objects lack `breadcrumbs`. This generalizes: a detail-page `Listing:<id>` entry and a SERP-page `Listing:<id>` entry are not guaranteed to carry an identical field set, because Next.js SSR only hydrates the fields the specific page's query actually requested (Apollo normalizes by typename+id, but the *fields present* on that cache entry depend on which query populated it).
**Why it happens:** Apollo Client's normalized cache stores whatever fields the page's GraphQL query selected — a detail page's query and a SERP page's query are different queries, so cache completeness for the same entity differs by page.
**How to avoid:** The field-parity confirmation (see Narrow Confirmation section below) must probe the DETAIL page specifically for `fetchListing`, and separately confirm the AREA/SERP page's `Listing:<id>` entries for `fetchAreaListings` — do not assume field parity found on one page type transfers to the other.
**Warning signs:** `fetchAreaListings` returning listings with fewer usable fields than `fetchListing` returns for the same booliId — expected given the different query origin, not a bug, but should be documented as a known asymmetry rather than "discovered" mid-implementation.

### Pitfall 5: `useApifyProxy`/`apifyProxyGroups` posture drift between rungs
**What goes wrong:** If "rung 2" is implemented as merely "retry the same config again" rather than a genuinely different proxy posture, it provides no additional resilience over rung 1's own internal `maxRequestRetries: 3` — making the three-rung tree effectively a two-rung tree (own-transport, paid-actor) with a no-op middle step.
**Why it happens:** It's tempting to satisfy "fallback tree: direct → Apify SE-residential proxy → paid actor" literally as three code paths without noticing rung 1 (own Playwright + RESIDENTIAL/SE) and rung 2 (also Apify SE-residential proxy) as described in ACQ-01's requirement text are the SAME transport.
**How to avoid:** Be precise about what actually differs between rung 1 and rung 2 (see Fallback Tree section below) — the honest options are: (a) collapse to a two-rung tree (own-Playwright-with-retries, paid-actor) and document why, or (b) make rung 2 genuinely different (e.g. a different Apify proxy group/country, or a fresh actor run with a clean session after rung 1's retries are exhausted). Do not silently duplicate rung 1 and call it rung 2 for the sake of matching the "three rungs" framing.
**Warning signs:** Code review finds rung 1 and rung 2 attempt functions are byte-identical.

## Code Examples

Verified patterns from the existing shipped codebase (the authoritative source for this phase — no external library docs needed since the entire transport is already implemented and proven):

### Actor-call skeleton (generalize this exact shape)
```typescript
// Source: src/lib/market/sold-source.ts fetchSoldComps() — shipped, proven 4/4
const run = await client.actor(PLAYWRIGHT_SCRAPER_ACTOR).call(
  {
    startUrls: [{ url }],
    launcher: "chromium",
    proxyConfiguration: {
      useApifyProxy: true,
      apifyProxyGroups: ["RESIDENTIAL"],
      apifyProxyCountry: "SE",
    },
    maxRequestRetries: 3,
    maxPagesPerCrawl: 1,
    pageFunction: PAGE_FUNCTION,
  },
  { waitSecs: 240 },
);
```

### Throw-not-empty discipline (HIGH-1, reuse verbatim as a design rule)
```typescript
// Source: src/lib/market/sold-source.ts — the pattern every new client function must copy
if (run.status !== "SUCCEEDED") {
  throw new Error(`Sold-kallan blev inte klar i tid (status: ${run.status})`);
}
const { items } = await client.dataset(run.defaultDatasetId).listItems();
if (!items.length) {
  throw new Error("Inga resultat fran sold-kallan");
}
const usable = items.filter((it) => (it as { hasApollo?: boolean }).hasApollo !== false);
if (!usable.length) {
  throw new Error("Sold-kallan returnerade ingen Apollo-data (hasApollo=false)");
}
```

### Apollo entity walk (generalize the SoldProperty: prefix scan into a generic prefix param)
```typescript
// Source: src/lib/market/sold-schema.ts normalizeSoldOutput() — the pattern for the
// new Listing: prefix walk (fetchListing / fetchAreaListings normalization)
for (const [key, value] of Object.entries(state)) {
  if (!key.startsWith("SoldProperty:")) continue; // generalize to "Listing:" for ACQ-01/02
  if (!value || typeof value !== "object") continue;
  const entry = value as Record<string, unknown>;
  // ... field extraction
}
```

## The Narrow Confirmation (field parity — the ONE open item)

### What to confirm
The detail-page `__APOLLO_STATE__` map contains a `Listing:<booliId>` key (exact prefix TBD-confirm — see below) whose fields cover, at minimum, everything `scraperOutputSchema` (`listing.ts`) validates today plus the appendix fields `03-SPIKE.md` lists from the actor's full key set:

`agencyId, agencyListingUrl, agencyName, booliId, breadcrumbs, constructionYear, descriptiveAreaName, estimate, id, infoPoints, isNewConstruction, latitude, listEstimatedPrice, listPrice, listRent, listSqmPrice, livingArea, longitude, objectType, price, propertyType, rent, rooms, streetAddress, tenureForm, title, url`

### Exact Apollo key/path to pin
Based on the sold-comps precedent (`SoldProperty:<id>` — a typename-colon-id composite key, standard Apollo InMemoryCache normalization), the listing entity almost certainly follows the identical convention: **`Listing:<booliId>`**. This is `[ASSUMED]` by direct analogy to the confirmed `SoldProperty:<id>` pattern — Apollo Client's default `dataIdFromObject` is `${__typename}:${id}` for every normalized entity in a cache, and `03-SPIKE.md`'s own Finding 1 table (999.6 brief) independently corroborates a `Listing` typename exists in Booli's GraphQL schema (the same schema whose types populate Apollo's normalized cache regardless of transport). High-confidence assumption, but it must be confirmed by the probe below before being written into shipped code as fact.

### How to run the confirmation (real-Apify probe)
This is a single, bounded, real-transport spike task — NOT exploratory research. Requires `APIFY_API_TOKEN` in the executor's environment (already configured per Phase 1/CONTEXT.md).

1. Pick one real, currently-active Booli listing URL (either `/bostad/{id}` or `/annons/{id}` — confirm which path form the current site actually serves; `03-SPIKE.md` §2's own detail-page scrape is the precedent to follow for the exact URL it used).
2. Run the EXACT `PAGE_FUNCTION` from `sold-source.ts` (unmodified) against that URL via one `client.actor("apify/playwright-scraper").call(...)` invocation with `maxRequestRetries: 3`, `waitSecs: 240`.
3. Inspect the returned `__APOLLO_STATE__` object's keys for one starting with `Listing:`. Confirm the exact prefix (it may be `Listing:` or something else entirely — pin it empirically, do not hardcode the assumed prefix without this check).
4. Diff that entity's own keys against the field list above. Record which fields are present, present-but-differently-shaped (e.g. `price` as a bare number vs. a `{raw,formatted}` object — note the shape, since `normalizeScraperOutput`'s coercion helpers already tolerate both via `rawOf()`), and genuinely absent.
5. Cross-check `infoPoints` specifically (floor/avgift source) and `breadcrumbs` (already proven present per `03-SPIKE.md` §2) and `agencyListingUrl` (Phase 6's hard dependency) — these three are the highest-value fields to confirm because they gate the most downstream work.

### Fallback plan if a field is missing
- **If `agencyListingUrl` is present:** No impact — Phase 6 proceeds as planned.
- **If `agencyListingUrl` is ABSENT from the detail-page Apollo state:** This is the single field whose absence would materially hurt Phase 6 (LSTG-03/04 needs it to reach the broker page). If missing, escalate per CONTEXT.md's own escalation clause — options in order of preference: (a) check whether the SERP/area-search page's `Listing` entry carries it instead (different query, may include different fields — see Pitfall 4), (b) fall back to rung 3 (paid actor) specifically for the `agencyListingUrl` field while using the owned client for everything else (a partial-field merge, more complex but avoids losing Phase 6's dependency entirely), (c) accept the paid actor as the permanent source for that one field only.
- **If a cosmetic/bonus field is missing (e.g. `title`, `propertyType`):** No escalation — `normalizeScraperOutput` already tolerates missing fields via its null-coalescing coercion helpers, and `analyze.ts` already has a `missingFields` UX path for exactly this case. Ship it; note the gap in the plan's completion doc.
- **If a REQUIRED display field is missing** (`streetAddress`, `price`/`listPrice`, `livingArea`, `rooms` — the same four `analyze.ts` already tracks as `requiredDisplayFields`): This is the actual escalation trigger described in CONTEXT.md ("escalate only if parity is incomplete"). Do not ship the owned client as the DEFAULT path for `fetchListing` if any of these four are absent from the detail page — fall back to keeping the paid actor as default for single-listing fetch specifically, while still shipping `fetchAreaListings`/`fetchSoldComps` on the owned transport (a partial rollout is legitimate; ACQ-01 failing does not have to block ACQ-02/ACQ-03).

## Fallback Tree — precise rung definitions

Per Pitfall 5 above, be exact about what each rung actually is. ACQ-01/02/03's requirement text says "direct → Apify SE-residential proxy → paid actor as last resort" and CONTEXT.md repeats this framing verbatim — but `03-SPIKE.md`'s own probe matrix proves "direct" (a raw fetch with no browser) is a 403 dead end for every URL tested. Reconciling the requirement's framing with the evidence:

| Rung | What it actually is | Distinct from other rungs how | Cost/latency |
|------|---------------------|-------------------------------|---------------|
| 1 — "direct" (in practice: own Playwright, first attempt) | `apify/playwright-scraper` (chromium) + Apify RESIDENTIAL/SE proxy, `maxRequestRetries: 3` internal crawler retries | The actor's OWN retry budget absorbs transient 403s/tunnel errors before this rung is considered "failed" — this consumes the "direct" framing's intent (our lowest-cost, first-choice transport) even though it is not literally fetch-without-a-browser | ~$0.0055–0.0074/render (`03-SPIKE.md` §1.5); ~20–60s incl. cold start |
| 2 — "Apify SE-residential proxy" (explicit second attempt) | A genuinely distinct second attempt AFTER rung 1's actor call has fully exhausted its `maxRequestRetries` and still failed — e.g. a fresh actor run (new container, new proxy session/IP rotation) rather than reusing the same exhausted run. This is what makes rung 2 non-duplicate of rung 1 (Pitfall 5) | A fresh Apify run gets a new proxy IP from the RESIDENTIAL/SE pool — genuinely different network identity than rung 1's exhausted run, which is the actual lever "try again via the proxy" pulls | Same per-render cost as rung 1, paid again — this rung should be rare (only fires when rung 1's own 3 retries all failed) |
| 3 — paid actor (`bpf1JaYRBbia2nQU9`) — genuine last resort | The existing `booli-scraper.ts` logic (unmodified actor ID, unmodified proxy config) called only when BOTH rungs 1 and 2 have thrown | Different actor entirely — third-party maintained scraper, not our Playwright render — genuinely the last resort, matching "no silent dependency" only because it is now visibly rung 3, not the default | Existing paid subscription (~$29/mo) + per-run usage; this rung firing at all should be a monitored/alerted event (Pitfall 3) |

**Recommendation for the plan:** Implement rung 1 and rung 2 as the SAME `runPlaywrightRender()` call but at two separate invocation SITES in `walkFallbackTree` (i.e., literally call the function twice on failure, which naturally gets a fresh Apify run/proxy session each time) rather than trying to parameterize a "different proxy config" that doesn't actually exist in the evidence. This satisfies both the requirement's three-rung framing AND Pitfall 5's demand that rung 2 not be a no-op — because a second independent Apify run genuinely does get new IP/session state, which is the real resilience lever, even though the code for rung 1 and rung 2 is nearly identical (which is fine and should be explicitly commented as intentional, not flagged as duplication in code review).

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Paid Apify actor (`bpf1JaYRBbia2nQU9`) as the DEFAULT path for single-listing fetch | Own Playwright + RESIDENTIAL/SE render as default; paid actor demoted to rung 3 | This phase (Phase 5) | Removes the silent default dependency on a third-party-maintained actor; ownership + observability, per ACQ-03 |
| Sold-comps acquisition isolated in its own module (`sold-source.ts`) | Unified into `src/lib/booli/client.ts` alongside listing/area fetch | This phase | One transport core, one fallback-tree implementation, one place to fix future CF-posture issues instead of three |
| No fallback-tree observability anywhere in the acquisition layer | `{ source, rung, health }` surfaced on every client call | This phase (net-new, ACQ-03) | Makes future paid-actor dependency visible/alertable instead of silent |

**Deprecated/outdated:**
- Treating `booli-scraper.ts`'s `scrapeBooli()` as the primary single-listing entry point: superseded by `client.ts`'s `fetchListing()`, with `scrapeBooli()`'s logic retained only as the rung-3 implementation detail inside the fallback tree.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The detail-page Apollo entity key for a listing is exactly `Listing:<booliId>` (by analogy to the confirmed `SoldProperty:<id>` pattern and Apollo's default `dataIdFromObject` convention) | The Narrow Confirmation | Low — the confirmation probe step 3 explicitly re-derives the true prefix empirically before any code hardcodes it; if wrong, the probe simply reveals the correct prefix (e.g. `Property:` or a different typename) with no wasted implementation, since this is checked BEFORE the client code is written |
| A2 | Rung 2 ("Apify SE-residential proxy") is best implemented as a second independent Playwright actor run (fresh container/proxy session) rather than a literally different proxy configuration, since no evidence in `03-SPIKE.md` shows a distinct second proxy posture that clears CF where the first didn't | Fallback Tree section | Medium — if a plan instead tries to invent a "more different" rung 2 (e.g. a different proxy group Apify doesn't actually offer for this use case, or a headers tweak already proven ineffective), it risks reproducing effort against a dead end `03-SPIKE.md` already closed. Flagged explicitly to prevent this |
| A3 | The current detail-page URL form is still `/bostad/{id}` or `/annons/{id}` matching `03-SPIKE.md`'s own scrape — Booli's URL scheme has not changed since that spike (2026-06-20, ~2 weeks before this research) | The Narrow Confirmation, step 1 | Low — trivially re-verified by attempting to load any current real listing URL in a browser before running the probe; a URL-scheme change would be immediately obvious and cheap to correct |

**If empty:** N/A — see table above.

## Open Questions

1. **Exact Apollo key prefix for the Listing entity**
   - What we know: `SoldProperty:<id>` is confirmed; Apollo's default normalization convention strongly implies `Listing:<booliId>` for the listing entity.
   - What's unclear: Whether Booli's specific Apollo Client cache config uses a custom `dataIdFromObject` that might not follow the `{typename}:{id}` default (unlikely, but not directly observed for `Listing` specifically — only for `SoldProperty`).
   - Recommendation: The narrow-confirmation probe (single real-Apify run) resolves this in one step before any client code hardcodes a prefix assumption.

2. **Whether `agencyListingUrl` and `infoPoints` are present on the DETAIL page specifically (vs. only on the actor's own richer extraction)**
   - What we know: The current paid actor returns both (per `03-SPIKE.md` appendix's full key list, which was captured "from the active-listing actor," i.e. the paid actor's own output — not yet directly observed in the detail-page Apollo state).
   - What's unclear: Whether the actor derives these fields from the SAME Apollo state we'd read, or does additional DOM-level extraction/API calls the actor's own scraping logic performs beyond a bare Apollo-state read.
   - Recommendation: This is exactly what the narrow-confirmation probe must check field-by-field (see fallback plan above) — do not assume actor-parity without the direct diff.

3. **Whether `fetchAreaListings` (ACQ-02, SERP-equivalent) needs its own distinct page function or can reuse the identical Apollo-extraction `PAGE_FUNCTION` string**
   - What we know: `03-SPIKE.md` §1.2 documents `/sok/till-salu?areaIds=<N>` embeds active `Listing` objects, an `Area_V3` context object, AND a batch of `SoldProperty` comps all in one render — the SAME `__NEXT_DATA__`/`__APOLLO_STATE__` mechanism.
   - What's unclear: Whether pagination for area search (equivalent to `&page=N` on slutpriser) works identically for `/sok/till-salu` — not directly tested in the cited spikes (only slutpriser pagination at 35/page was confirmed).
   - Recommendation: Treat as a small in-plan verification task (not a full spike) — the mechanism is proven for one page family (slutpriser) and the till-salu page's single-fetch bonus embedding is confirmed, but multi-page till-salu walking should get one live check during implementation, not assumed transitively.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `APIFY_API_TOKEN` env var | All three client functions + the narrow-confirmation probe | Assume ✓ (already configured per Phase 1/CONTEXT.md — server-only, never `NEXT_PUBLIC_`) | — | None needed; this is a hard requirement already satisfied per project history |
| `apify-client` npm package | Actor invocation | ✓ | `^2.22.2` installed, `2.23.4` latest `[VERIFIED: npm registry]` | — |
| Apify hosted actor `apify/playwright-scraper` | Rungs 1–2 | ✓ (proven live in production via `sold-source.ts`) | Apify-managed, no local version pin | — |
| Apify hosted actor `bpf1JaYRBbia2nQU9` | Rung 3 | ✓ (proven live in production via `booli-scraper.ts`, pre-existing subscription) | Apify-managed | — |

**Missing dependencies with no fallback:** none identified.
**Missing dependencies with fallback:** none identified — everything this phase needs is already configured and proven in production.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (config: `vitest.config.ts`, `environment: "node"`, `globals: true`) |
| Config file | `/Users/danielwesterholm/dev/legendary-umbrella/vitest.config.ts` |
| Quick run command | `npx vitest run src/lib/booli/ src/lib/market/sold-schema.test.ts` |
| Full suite command | `npm run test` (`vitest run`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ACQ-01 | `fetchListing(url)` builds the correct detail-page URL and returns a raw payload whose shape `scraperOutputSchema` still validates | unit (mocked `ApifyClient`) | `npx vitest run src/lib/booli/client.test.ts -t "fetchListing"` | ❌ Wave 0 — no existing test mocks `ApifyClient`'s actor-call path anywhere in the codebase (`sold-source.test.ts` only tests the pure `resolveAreaId` helper, never `fetchSoldComps` itself) |
| ACQ-01 | `Listing:<booliId>` Apollo-entity extraction correctly picks the entity by prefix, tolerating multiple `displayAttributes` variants (mirroring the fixed `dataPointsOf()` non-determinism pattern) | unit | `npx vitest run src/lib/booli/client.test.ts -t "Apollo"` | ❌ Wave 0 |
| ACQ-02 | `fetchAreaListings(areaId)` builds the correct `/sok/till-salu?areaIds=<N>` URL and extracts multiple `Listing:` entries from one Apollo blob | unit (mocked) | `npx vitest run src/lib/booli/client.test.ts -t "fetchAreaListings"` | ❌ Wave 0 |
| ACQ-03 | `walkFallbackTree` tries rung 1, falls to rung 2 on throw, falls to rung 3 on second throw, and returns the correct `{source, rung, health}` at each stopping point | unit (pure function, inject fake rung `attempt` functions — no ApifyClient mock needed) | `npx vitest run src/lib/booli/fallback-tree.test.ts` | ❌ Wave 0 |
| ACQ-03 | `walkFallbackTree` throws (never returns silently) when ALL rungs fail, mirroring the existing HIGH-1 discipline | unit | `npx vitest run src/lib/booli/fallback-tree.test.ts -t "all rungs fail"` | ❌ Wave 0 |
| ACQ-01/02/03 | `normalizeScraperOutput`/`scraperOutputSchema` remain untouched and still pass against a real detail-page-shaped fixture (regression guard proving the "no-op migration" claim) | unit (fixture-based, no live call) | `npx vitest run src/lib/schemas/listing.test.ts` | ❌ Wave 0 — no `listing.test.ts` currently exists (confirmed absent from the test-file listing); this is a genuine gap even independent of this phase |
| PRICE-01 (regression) | `fetchSoldComps` continues to work unchanged after relocating into `client.ts` | unit (existing tests) | `npx vitest run src/lib/market/sold-schema.test.ts src/lib/market/sold-source.test.ts` | ✅ (existing, must stay green through the refactor) |
| Field parity (Narrow Confirmation) | Detail-page Apollo `Listing:` entity carries the required-display-field set | MANUAL / live-only — not unit-testable without a real Apify call and a real Booli listing | Manual probe script (one-off `tsx` or `node` script invoking `runPlaywrightRender` against one real URL, output inspected by eye) | N/A — inherently a live-transport confirmation, cannot be mocked without defeating its purpose |

### Sampling Rate
- **Per task commit:** `npx vitest run src/lib/booli/` (or the specific new test file just touched)
- **Per wave merge:** `npm run test` (full suite — must stay green, especially the untouched `sold-schema.test.ts`/`sold-source.test.ts`/regression coverage)
- **Phase gate:** Full suite green before `/gsd-verify-work`, PLUS the narrow-confirmation manual probe run once and its findings recorded (pass/fail on required-display-fields) before ACQ-01 is marked complete.

### Wave 0 Gaps
- [ ] **`vi.mock("apify-client")` pattern — does not exist anywhere in the codebase today.** `sold-source.test.ts` tests only the pure `resolveAreaId()` helper and never mocks `ApifyClient`'s `.actor().call()` / `.dataset().listItems()` chain. This phase is the FIRST to need it (testing `runPlaywrightRender`, the fallback tree's rung-1/2 attempts, and `fetchListing`/`fetchAreaListings`). Build a shared mock helper (e.g. `src/lib/booli/__mocks__/apify-client.ts` or an in-test `vi.mock` factory returning a fake `{ actor: () => ({ call: vi.fn() }), dataset: () => ({ listItems: vi.fn() }) }`) as an explicit Wave 0 task — do not let each new test file invent its own ad hoc mock shape.
- [ ] **`src/lib/schemas/listing.test.ts` — does not exist.** `normalizeScraperOutput`/`scraperOutputSchema` currently have zero direct unit tests (only exercised indirectly through other tests). Given this phase's core claim is "the raw shape is unchanged, so normalization is a no-op migration," a regression-guard test file for `listing.ts` itself is the cheapest possible proof of that claim and should be added even though it is not strictly a new capability.
- [ ] **A committed detail-page Apollo-state fixture** (mirroring `sold-comps.json`'s redacted-real-payload pattern) — capture ONE real, PII-redacted `Listing:<booliId>` Apollo entity from the narrow-confirmation probe and commit it as `src/lib/booli/__fixtures__/listing-detail.json`, so `fetchListing`'s Apollo-extraction unit tests run against real shape data rather than a hand-typed guess. This fixture is a direct byproduct of running the narrow-confirmation probe — capture it while doing that anyway.
- [ ] Framework install: none — Vitest is already configured and sufficient; no new test dependency needed.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | No (this phase touches no auth surface — `analyzeUrl`'s existing Supabase auth check is unchanged) | — |
| V3 Session Management | No | — |
| V4 Access Control | No (server-only module, no new user-facing permission boundary) | — |
| V5 Input Validation | Yes | The client accepts a Booli URL as input (from `analyzeUrl`'s existing `url.includes("booli.se/")` check, unchanged) and an `areaId`/query object for area search — validate/sanitize before interpolating into the actor's `startUrls` to prevent SSRF-adjacent abuse (see Threat Patterns below) |
| V6 Cryptography | No new crypto surface — `APIFY_API_TOKEN` handling is unchanged from the existing `ApifyClient` pattern (server-only env var, never `NEXT_PUBLIC_`, never logged) |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| Server-side request forgery via unvalidated URL passed to the Playwright actor's `startUrls` | Tampering / Elevation of Privilege | `analyzeUrl` already restricts input to `url.includes("booli.se/")` before calling `scrapeBooli` — the new `fetchListing(url)` MUST preserve an equivalent domain allowlist check (or have the caller continue to enforce it) before constructing `startUrls`; do not let a caller pass an arbitrary attacker-controlled URL straight into the actor, since the actor runs a real headless browser that will fetch whatever URL it's given |
| `APIFY_API_TOKEN` leakage via logging | Information Disclosure | Existing pattern already correct — `console.error("[sold-source]", error)` / `console.error("[booli-scraper]", error)` log the error object, never the token; the client's own `new ApifyClient({ token: process.env.APIFY_API_TOKEN! })` never logs the token itself. Preserve this exactly; do not add a debug log that stringifies the client config |
| Malformed/adversarial Apollo-state payload causing a parse crash that takes down the whole analysis flow | Denial of Service | The existing `.passthrough()` + null-tolerant coercion-helper pattern (`num`/`str`/`rawOf` in both `listing.ts` and `sold-schema.ts`) already defends against this — a malformed entry yields nulls, never a throw. Any new Apollo-extraction code for `Listing:` entities must follow the identical pattern, never a bare `JSON.parse` or direct property access without a type guard |
| Area-search `areaId`/query parameter injection into the constructed URL | Tampering | `URLSearchParams` (already used in `buildSlutpriserUrl`) auto-encodes values — continue using `URLSearchParams` rather than manual string concatenation for any new URL-building helper (`fetchAreaListings`'s equivalent to `buildSlutpriserUrl`) |

## Sources

### Primary (HIGH confidence)
- `src/lib/market/sold-source.ts` (this repo) — the shipped, proven transport implementation this phase generalizes; every actor-config value (retries, waitSecs, proxy groups) cited above is read directly from this file.
- `src/lib/market/sold-schema.ts` (this repo) — the Apollo-entity-walk and coercion-helper pattern to mirror for the `Listing:` entity.
- `src/lib/apify/booli-scraper.ts` (this repo) — the current paid-actor wrapper, becomes rung 3.
- `src/lib/schemas/listing.ts` (this repo) — the target normalized shape (`normalizeScraperOutput`) that must remain untouched.
- `.planning/phases/03-market-context/03-SPIKE.md` (this repo) — canonical transport/field/cost evidence (GO verdict, probe matrix, $/render, breadcrumb shape).
- `.planning/spikes/booli-own-acquisition-SPIKE.md` (this repo) — the 999.6 brief establishing field-parity plausibility and the single-listing-by-URL open question this phase closes.
- `.planning/phases/05-owned-booli-acquisition/05-CONTEXT.md` (this repo) — authoritative pre-decided direction; not contradicted anywhere in this research.
- `npm view apify-client version` — live registry check run during this research session, confirmed `2.23.4` current, `^2.22.2` installed range still valid `[VERIFIED: npm registry]`.

### Secondary (MEDIUM confidence)
- None required — this phase's domain is fully covered by the primary (in-repo, already-verified) sources; no external web research was needed or appropriate given the CRITICAL SCOPING instruction not to re-investigate transport.

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero new dependencies, entire transport already shipped and billing-verified in production.
- Architecture: HIGH — the unification pattern (one transport core, three page functions, one fallback-tree walker) is a direct, low-risk generalization of code already proven at each of its three call shapes independently (sold comps proven; listing detail Apollo-read proven via breadcrumbs; area/SERP embedding proven via the till-salu single-fetch bonus finding).
- Pitfalls: HIGH — every pitfall listed is backed by a specific, already-documented incident or explicit design comment in the existing shipped code (retry count, wait ceiling, throw-not-empty discipline, Apollo variant non-determinism), not speculative.
- Field parity (the one open item): MEDIUM — strong analogical evidence (`SoldProperty:<id>` proven, `breadcrumbs` proven present on detail page) but the FULL field list on `Listing:<booliId>` specifically has not been directly observed; this is exactly why the phase carries a bounded, single-probe confirmation task rather than treating it as settled.

**Research date:** 2026-07-06
**Valid until:** 30 days (2026-08-05) for the architecture/stack guidance (stable, in-repo evidence); the field-parity assumption should be treated as valid only until the narrow-confirmation probe actually runs — do not let this research substitute for running it.
