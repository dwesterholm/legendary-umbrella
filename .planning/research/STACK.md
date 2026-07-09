# Stack Research

**Domain:** Subsequent-milestone stack additions — Bostad AI v1.1 "Owned Data Layer & Intelligent Discovery"
**Researched:** 2026-07-06
**Confidence:** HIGH for (c) Riksbank/SCB access patterns and (d) Claude vision mechanics (official docs verified); MEDIUM for (a) Booli GraphQL detail-query shape and (f) Bolagsverket årsredovisning feasibility (best available secondary sources, not hands-on verified); HIGH for (b) and (e) library choice (mechanically simple, low ecosystem risk).

> **Superseding note:** This file previously contained pre-implementation v1.0 research (dated 2026-02-24) describing a Python/FastAPI backend that was never built — v1.0 shipped as a pure Next.js/TypeScript app (see `.planning/PROJECT.md`). That content is now inaccurate and has been replaced. This version is a **delta document** covering ONLY new packages/approaches needed for the five v1.1 features below. It does not re-litigate the validated, shipped v1.0 stack (Next.js 16, Supabase, Tailwind v4, `@anthropic-ai/sdk`, Apify, Zod v4, `@react-pdf/renderer`), which stays as-is.

---

## (a) Owned Booli acquisition layer — keyless GraphQL + HTML/`__NEXT_DATA__` extraction

### Critical prior-art finding — this is NOT a fresh design problem

The codebase already solved the *sold-price* half of this exact problem (`src/lib/market/sold-source.ts`, comment block lines 1–32) and the finding **directly overturns the spike's framing** for the *active-listing* half too:

> `www.booli.se/graphql` sits behind a **stricter, separate Cloudflare managed-challenge zone**. A non-browser POST (raw `fetch`, even routed through the Apify residential/SE proxy) is 403-rejected with `cf-mitigated: challenge`. **Only a real headless browser** (`apify/playwright-scraper`, `launcher: "chromium"`, RESIDENTIAL/SE proxy) clears it and gets a 200.

The working transport is: fetch the **server-rendered listing page** through Playwright, then in-browser `page.evaluate()` to read `document.getElementById("__NEXT_DATA__")` → `JSON.parse(...)` → `props.pageProps.__APOLLO_STATE__`. This is candidate 2 from the spike's three ("HTML `__NEXT_DATA__`/Apollo state extraction"), and it is **already proven working in this codebase for the sold-comps flow**. There is no evidence a raw keyless GraphQL POST from a server (candidate 1 or 3) will succeed where the sold-price spike explicitly found it does not — Cloudflare's managed challenge is JS-execution-based, not endpoint-based, so it very likely gates `/graphql` for active-listing queries the same way.

**Recommendation for 999.6:** treat "own the acquisition layer" as **generalizing the existing `sold-source.ts` pattern** to active listings and single-listing-by-URL, not as building a new keyless GraphQL HTTP client. Concretely:
- Reuse the same Apify actor (`apify/playwright-scraper`) + `PAGE_FUNCTION`-style in-browser extraction for the single-listing detail page (`/bostad/{id}` — matches a Booli-MCP-server secondary finding that `residenceId` is parsed from this URL segment, MEDIUM confidence, unverified hands-on).
- Reuse the same Apollo-state parsing approach for `searchForSale` (area-wide listings, needed for 999.7's area scrape) — the spike already confirmed field parity for this query shape.
- Keep a `booli-source.ts` (or extend `sold-source.ts`) as the SINGLE acquisition module — mirrors the "ONE source-isolating interface" pattern already in place, so the paid actor (`bpf1JaYRBbia2nQU9`) can be dropped once this proves reliable, with the actor kept as last-resort fallback per the milestone's stated fallback tree.
- **Build a tiny raw-`fetch` probe against `/graphql` first** (one-off spike script, not shipped code) to falsify/confirm the "always challenged" assumption for the *specific* queries 999.6 needs (detail-by-id, searchForSale) — the sold-price finding was for `searchSold` specifically; it is likely but not proven that the same challenge zone covers all query types uniformly.

### Libraries

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `apify-client` | `^2.22.2` (already installed) | Orchestrates the Playwright actor run + reads its dataset | Already the proven, working transport for Booli's Cloudflare-fronted pages — no new dependency needed |
| `apify/playwright-scraper` (Apify Actor, not an npm package) | latest | Headless-browser rendering that clears the Cloudflare managed challenge | The ONLY transport confirmed to work against `booli.se` server-rendered pages in this codebase; a raw HTTP client cannot solve a JS-challenge |

### What NOT to add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `graphql-request` / `graphql` / Apollo Client | Solves GraphQL client ergonomics (typed queries, caching) — not the actual blocker, which is Cloudflare's browser-execution challenge in front of `/graphql`. Adding a GraphQL client without solving the challenge just produces a nicer 403. | The existing Playwright-actor + `page.evaluate()` HTML/Apollo-state extraction pattern |
| `puppeteer` / `playwright` as a direct npm dependency in the Next.js app | Running a real Chromium instance from a Vercel serverless function is unsupported/fragile (cold-start size limits, no persistent browser binary) and duplicates infra Apify already provides on a residential IP | Keep browser automation entirely inside the Apify actor; the Next.js app only calls `apify-client` |
| Building a bespoke Cloudflare-challenge solver (e.g. `cloudscraper`-style header/TLS-fingerprint spoofing) | High effort, breaks silently on Cloudflare updates, and is the kind of fragile reverse-engineering the "scraping fragility" constraint explicitly warns against | Real browser via Apify (already paid for via existing subscription) |

---

## (b) Deeper listing extraction via broker/Vitec pages

### Vitec has a real B2B API — it is not usable here

**Vitec Express Connect** (`connect.maklare.vitec.net`) is a genuine partner-integration platform for the "Mäklarsystemet" broker software, exposing website/listing data feeds. However (MEDIUM confidence, official page confirmed): access requires registering in the Connect portal **and then a manual approval/contact step with Vitec** — this is a B2B partnership model, not a self-serve API key. It is not compatible with the "near-zero budget, solo dev" constraint (would need a business agreement, likely a paid tier, and per-broker onboarding since listings on Booli span many different agencies/systems, not just Vitec). **Do not pursue this integration path.**

The only remaining option is fetching and parsing the rendered broker page HTML that `agencyListingUrl` (already returned by the current Apify actor / Booli data) points to — e.g. `bjurfors.se`, `svenskfast.se`, `fastighetsbyran.se`, `maklarhuset.se`, each running Vitec Express (or a competing CMS) with **different HTML/JSON-LD structures per agency**. There is no single schema to target; this is genuinely a multi-target scraper problem.

### Recommended approach

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `cheerio` | `^1.2.0` | Parse fetched broker-page HTML with a jQuery-like selector API | Zero-dependency, fast, the de-facto standard for server-side HTML parsing in Node; verified current (Context7 `/cheeriojs/cheerio`, 249+ snippets, actively maintained) |
| Native `fetch` (Node 22, already used for SCB) | — | Fetch broker pages directly (no Cloudflare in front of most broker sites, unlike Booli) | Broker sites are typically NOT behind the same aggressive bot-protection as Booli — try direct `fetch` first per listing; only fall back to Apify+proxy if a specific agency blocks it |
| Apify residential/SE proxy (existing) | — | Fallback transport if a specific broker site blocks direct fetch | Already paid for; reuse rather than adding a second proxy vendor |

**Extraction strategy:** target `<script type="application/ld+json">` (schema.org `Product`/`RealEstateListing` blocks — common on modern Swedish real-estate sites for SEO) as the FIRST extraction attempt (structured, stable across redesigns), falling back to `cheerio` CSS-selector scraping of the visible DOM for fields JSON-LD omits (floor, balcony, BRF name, renovation status, full description are typically prose/DOM-only, not in structured data). Expect to write **one small per-agency selector map** (a lookup table keyed by hostname), since each broker's CMS differs — budget for ~5-8 broker domains covering the bulk of Booli listings (Bjurfors, Svensk Fastighetsförmedling, Fastighetsbyrån, Länsförsäkringar Fastighetsförmedling, Mäklarhuset, HusmanHagberg, Notar cover the large majority of the Swedish market).

### What NOT to add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `puppeteer`/`playwright` as first choice for broker pages | Most broker sites are plain server-rendered HTML with no bot-challenge — paying the Playwright/Apify cost by default is wasteful | Direct `fetch` + `cheerio` first; escalate to Apify only for sites that prove to need it |
| A generic "universal scraper" library (e.g. `extruct`-style multi-format metadata extractors, Python-only anyway) | Over-engineering for ~5-8 known target domains; adds a dependency for a problem better solved with explicit per-domain selectors that are easy to debug when a site redesigns | Hand-written per-hostname `cheerio` selector maps, colocated with tests fixture HTML snapshots |

---

## (c) Riksbank + SCB macro data (rates, inflation, regional price index)

### Riksbank SWEA API — keyless with generous free tier (HIGH confidence, official docs)

- **Base URL:** `https://api.riksbank.se/swea/v1/...` (production; developer portal at `developer.api.riksbank.se`)
- **Auth:** Fully keyless for light use — **without any registration**, the API allows 5 calls/minute and 1,000 calls/day per IP. Optional free registration (`developer.api.riksbank.se/signup`) raises this to 200 calls/minute, 30,000 calls/week, via an API key sent either as the `Ocp-Apim-Subscription-Key` header or a `?subscription-key=` query param.
- **Format:** REST, JSON response.
- **Example endpoints:** `GET /swea/v1/Observations/Latest/{seriesId}` (e.g. the repo-rate series ID — confirm exact ID via `/swea/v1/Series` listing endpoint, since exact IDs weren't verified hands-on in this research pass), `GET /swea/v1/Observations/Latest/ByGroup/{groupId}` for a whole group (e.g. exchange rates).
- **Recommendation:** given the light call volume this feature needs (a handful of macro series, refreshed at most daily and cached), the **unregistered 1,000 calls/day tier is sufficient** — skip registration entirely to avoid one more credential to manage, unless daily batch refresh across many listings pushes past that ceiling.
- No new npm package needed — same server-side native `fetch` pattern already used for SCB (`src/lib/market/scb.ts`).

### SCB PxWebApi — confirm existing v1 usage, but note the sunset clock (HIGH confidence)

The codebase already calls `https://api.scb.se/OV0104/v1/doris/en/ssd` (PxWebApi **v1**) keylessly via native `fetch` for demographics (AREA-01). For 999.3's macro tables you need:
- **KPI (inflation):** table under `PR/PR0101/PR0101A` (Konsumentprisindex) — same v1 base, same no-auth pattern.
- **Fastighetsprisindex (regional property price index):** table under `BO/BO0501/BO0501D` — also v1, no-auth.

**Important finding not previously flagged in this codebase:** SCB launched **PxWebApi v2** in October 2025; **v1 is scheduled to stop working by end of 2026 / early 2027** (SCB's own migration notice). Since v1.0 is dated 2026-07-06 and v1 already has a published end-of-life within the horizon of this very milestone, **this is a real, time-boxed risk** — not urgent enough to block 999.3 (v1 still works today), but:
- **Recommendation:** when adding the new macro tables in 999.3, write the query-building code against a thin abstraction (a `buildPxWebQuery(tableId, filters)` helper) so migrating the base URL/request shape to v2 later is a single-file change, not a re-scattered rewrite. v2 adds GET-with-URL-params (v1 requires POST-with-JSON-body) and more stable, structural-change-resistant URLs — worth adopting for NEW code (the macro tables) even while existing AREA-01 code stays on v1 for now, if the migration guide (linked below) makes v2 straightforward for a fresh integration.
- Do not attempt a full v1→v2 migration of the existing AREA-01 code as part of this milestone — out of scope, no functional benefit today, and risks regressing shipped v1.0 code for a deadline that is 6-18 months out.

### Libraries

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Native `fetch` (Node 22) | — | Both Riksbank SWEA and SCB PxWebApi calls | Both are plain keyless JSON REST APIs; matches the existing SCB integration pattern exactly, zero new dependencies |
| Zod v4 (already installed) | `^4.3.6` | Validate/parse SWEA + new SCB table responses | Same pattern as `scb-schema.ts` — schema-validate external data at the boundary |

### What NOT to add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| A dedicated Riksbank/SCB SDK wrapper package (e.g. `riksbank` PyPI-style wrappers, none well-maintained for Node/TS) | Thin wrappers around simple REST calls add a dependency for no real ergonomic gain, and TS-native community wrappers for these two APIs are sparse/unmaintained | Hand-rolled `fetch` client mirroring `scb.ts`, ~30-50 LOC per source |
| Migrating existing AREA-01 SCB code to PxWebApi v2 in this milestone | Scope creep; v1 still functions through this milestone's entire horizon | Build NEW macro-table code against v1 (consistency) or v2 (future-proofing) behind a thin query-builder; defer full migration to a dedicated future task tracked against the 2026/2027 sunset |

---

## (d) Claude vision (multi-image) for gallery + floor-plan analysis

### Model + mechanics (HIGH confidence — official docs, verified 2026-07)

- **Existing model already in use, `claude-sonnet-4-6`, supports vision** and is the right default for this feature — no new model integration needed, just a new call shape (image content blocks) added to an existing Sonnet call path, OR a dedicated new vision call if you want to isolate cost/latency from the text-synthesis call.
- **Resolution tier matters for cost:** `claude-sonnet-4-6` is on the **Standard tier** (max long edge 1568px, max 1568 visual tokens/image) per the current vision docs table — NOT the High-resolution tier (that's reserved for Fable 5 / Mythos 5 / Opus 4.7+ / Sonnet 5). This is a real cost/quality tradeoff: if floor-plan detail (small text, thin walls) matters, evaluate whether upgrading the vision call specifically to `claude-sonnet-5` (High-resolution tier, 2576px / 4784 tokens) is worth ~2-3x the visual-token cost for that one call type, while keeping `claude-sonnet-4-6` for the text-only report synthesis.
- **Multiple images in one request:** fully supported — up to 100 images per request for 200k-context models (which includes both Sonnet 4.6 and 5). Label each image with a preceding text block (`"Image 1:"`, `"Image 2 (floor plan):"`) so the model can refer back to them; **this labeling matters more than usual here** since you're mixing heterogeneous image types (gallery photos vs. floor plan) in one call and want the model's reasoning to distinguish them.
- **Image source options:** three mechanisms — `base64` (embed encoded bytes in the request), `url` (pass the listing's own image URL directly — Claude fetches it server-side), and Files API `file_id` (upload once, reference by id in later calls). **For this feature, `url` source type is almost certainly the best fit**: listing gallery/floor-plan images are already hosted (Booli or broker CDN URLs), so passing the URL directly avoids downloading+base64-encoding entirely — less code, less bandwidth through your own server, and no storage question. Only fall back to `base64` if a specific image host blocks Anthropic's fetcher (hotlink protection) — in that case, download server-side and base64-encode, or upload via Files API if the same image will be reused across multiple calls (e.g. re-analysis).
- **Cost estimate:** at Sonnet's ~$3/M input tokens, a 1000×1000px image (~1296 tokens, Standard tier) costs roughly $0.004; a typical listing gallery of 8-12 photos + 1 floor plan (~13 images) costs on the order of $0.05-0.07 in image tokens per analysis — trivial relative to the existing report-synthesis Sonnet call, but worth tracking since 999.7's area-wide scrape multiplies this by every candidate listing, not just one paste-a-URL analysis. **Recommendation:** run vision analysis only after niche-ranking has narrowed the candidate set (cheap text-only filtering first), not on every raw scraped listing — keeps the per-area-scan cost bounded.
- **`client.beta.messages.parse` + `zodOutputFormat`** (the existing structured-output pattern from BRF extraction) composes fine with image content blocks — images are just additional content-array entries alongside the existing text/schema-instruction content; no new SDK surface needed beyond adding `{ type: "image", source: {...} }` blocks to the user message content array.

### Libraries

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `@anthropic-ai/sdk` (already installed) | `^0.102.0` | Vision calls via existing `client.beta.messages.parse` | No version bump needed — image content blocks and `url` source type are part of the stable Messages API, not a beta feature requiring a new SDK version |

### What NOT to add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| A separate image-processing/resizing library (e.g. `sharp`) as a hard requirement | Not needed if using `url` source type (Claude fetches and resizes server-side per the documented resize rule) | Only add `sharp` if you hit the "many-image" 20-image-per-request stricter dimension limit and need to pre-resize — defer until proven necessary |
| Anthropic Files API for one-shot analysis | Adds upload-then-reference complexity for images analyzed once and discarded; Files API's value is amortizing re-use across multi-turn conversations, which this feature doesn't have | Direct `url` source type per call |
| A dedicated OCR library for floor-plan text (room labels, dimensions) | Claude's vision already reads in-image text reasonably well for this use case (floor plans have large, clear room labels) per general vision capability; a separate OCR pass adds a pipeline stage for marginal gain | Prompt Claude directly on the floor-plan image; only add OCR if evaluation shows Claude systematically misses printed dimensions |

---

## (e) Sun-path / solar-position computation

### Recommended: plain `suncalc`, not a map library

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `suncalc` | `2.0.0` (npm `latest`) | Compute sun azimuth/altitude for a given lat/lng/date-time, plus sunrise/sunset/solar-noon times | The original, most widely-used (79k+ weekly downloads), dependency-free, battle-tested library for exactly this calculation (Meeus astronomical algorithms) — this is a **pure computation problem** (given the listing's lat/lng from Booli data — already retained per the spike — compute sun exposure at various times/seasons), not a mapping/visualization problem |
| `@types/suncalc` | `1.9.2` | TypeScript types for `suncalc` (the package itself ships no types) | Matches this codebase's fully-typed TS conventions |

**Note on `suncalc3`** (the Context7-indexed fork, `/hypnos3/suncalc3`): it's an actively maintained TypeScript-native fork with a richer API (structured `ISunPosition` objects, more twilight phases). It's a reasonable alternative if you want native types without a separate `@types` package, but the original `suncalc` + `@types/suncalc` combo is more battle-tested/ubiquitous and sufficient for the azimuth/altitude computation this feature needs (compute sun position at, e.g., hourly intervals across the year for the listing's coordinates, cross-reference against building orientation/facade direction to estimate exposure). Either works; default to the original unless the richer typed API proves worth the swap during implementation.

### No new map/embed library needed

The feature need (per PROJECT.md: "sun-path/sun-exposure computation from listing latitude/longitude") is a **computed exposure metric** feeding into the AI report/ranking, not an interactive map UI. If a visual sun-path diagram is later desired for the report UI, a simple `<svg>` polar plot rendered from `suncalc` output (azimuth/altitude pairs across the day) is sufficient — no mapping library required at all. Should a literal embedded map become a requirement later (e.g., showing the listing pin), the existing `@turf/*` packages (`^7.3.5`, already installed for the geo-fencing DeSO logic) plus a lightweight static map (e.g., an `<img>` tag against a free-tier static-map provider, or plain Leaflet if interactivity is truly needed) would be the incremental add — but that is NOT required by the current 999.7 scope as described.

### What NOT to add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `react-leaflet` / `mapbox-gl` / any interactive map library | Not needed for a computed sun-exposure metric; adds SSR complexity (Leaflet needs `window`, forcing client components) and bundle weight for a feature that's fundamentally a numeric computation, not a map UI | `suncalc` computation + optional lightweight SVG diagram if visualization is wanted |
| A full astronomy library (e.g. `astronomy-engine`, NASA-grade ephemeris libraries) | Massive overkill — sun-position-for-a-building-facade needs arc-minute accuracy at most, not ephemeris-grade precision | `suncalc` — already matches USNO/timeanddate.com conventions to sufficient accuracy for this use case |

---

## (f) Auto-fetch BRF årsredovisning (Allabrf / Bolagsverket)

### Feasibility finding: Bolagsverket's API delivers a MACHINE FORMAT, not a PDF (MEDIUM confidence — official docs found, format detail not hands-on verified against a real BRF org number)

Bolagsverket's digital-filing infrastructure (`bolagsverket.se/apierochoppnadata`) does expose annual reports, but with two load-bearing caveats surfaced in this research:

1. **Format is iXBRL, not PDF.** Digitally-submitted annual reports (mandatory digital filing has applied broadly since 2020) are distributed as **iXBRL** (Inline XBRL — structured, machine-readable financial-statement XML/HTML hybrid), delivered via weekly bulk ZIP files or API, **not as a scanned/rendered PDF**. This is actually a GOOD fit for this project's existing pattern — Claude already parses BRF PDFs into structured financials (`src/lib/brf/extract.ts`); an iXBRL document is if anything MORE structured than a PDF and could be parsed more reliably (or even without Claude, via a proper iXBRL parser, for the fields it tags) — but it means the "auto-fetch" pipeline's output shape differs from today's PDF-upload pipeline and needs its own extraction path (or an iXBRL→text/markdown normalization step before feeding the existing Claude extraction prompt).
2. **Allabrf.se is not guaranteed current.** A secondary source found in this research states Allabrf "does not always have the most recent annual report" and recommends alternative retrieval when the shown report is older than ~18 months — meaning Allabrf cannot be the sole source; Bolagsverket (the primary registry) must be the fallback/source-of-truth, consistent with the milestone's own framing ("Allabrf/Bolagsverket... manual PDF upload as fallback").
3. **Access model is unclear from this research pass** — the Bolagsverket API portal page returned only a CAPTCHA wall to automated fetching (ironically making THIS research artifact hit the exact kind of bot-wall the product must navigate for Booli). Whether the annual-report API is fully open/keyless, requires a free registration, or requires a paid agreement was **not resolved** in this pass and needs a dedicated hands-on spike (register an account, attempt one real BRF org-number lookup) before 999.x work on this feature begins.

**Recommendation:** treat "auto-fetch BRF årsredovisning" as needing its OWN feasibility spike (mirroring how 999.6 got a dedicated spike before roadmapping) rather than assuming it's a simple new fetch client. Specifically de-risk: (a) actual access/auth requirements for Bolagsverket's annual-report API/bulk files, (b) whether iXBRL documents for BRFs (a specific K2/K3 filer category) are reliably present and how far back, (c) whether Allabrf exposes an easier-to-scrape rendered view as a pragmatic middle ground (their pricing model — SEK 149-499/report per PROJECT.md — suggests they've already solved this retrieval problem and may be scrape-able similarly to how Booli is, with the same legal/fragility tradeoffs).

### Libraries (provisional — pending the spike above)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Native `fetch` + `cheerio` (both already recommended above) | — | Whatever the eventual transport (Bolagsverket API JSON/iXBRL, or Allabrf HTML) | Same toolkit already covers this; no new dependency class anticipated |
| An iXBRL parser — TBD pending spike (candidates: dedicated `ixbrl`-parsing npm packages are sparse; may need a general XML parser like `fast-xml-parser` + hand-rolled tag extraction for the specific K2/K3 taxonomy tags BRFs use) | TBD | Extract structured financials from iXBRL if that turns out to be the real delivery format | Do not commit to a specific parser until the spike confirms the actual document shape retrieved for a real BRF org number |

### What NOT to add (yet)

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Committing to a specific iXBRL parsing library before the spike | The exact tag/taxonomy shape BRFs' filed reports use is unverified in this research pass; picking a parser now risks the same "actor thin wrapper" surprise the Booli spike caught | Spike first: pull one real BRF's filed report, inspect its actual shape, then choose |
| Assuming Allabrf can be scraped like Booli without checking its own bot-protection posture | Unverified in this pass — Allabrf may or may not have Cloudflare-grade protection; assuming it's easy could repeat the Booli surprise in reverse | Same spike-first discipline used for 999.6 |

---

## Installation

```bash
# New dependencies for v1.1 (only what's confirmed needed; (f)'s parser TBD post-spike)
npm install cheerio suncalc

# Dev dependency (types for suncalc)
npm install -D @types/suncalc

# NOT installed: graphql-request, playwright/puppeteer (direct), react-leaflet/mapbox-gl,
# any Riksbank/SCB SDK wrapper, any iXBRL parser (pending spike) — see "What NOT to add" per section
```

No `@anthropic-ai/sdk`, `apify-client`, or `zod` version bump is required — all vision, GraphQL-adjacent, and validation needs are served by the SDK/library versions already installed.

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|--------------------------|
| Playwright-in-Apify for Booli acquisition | Raw keyless `fetch` to `/graphql` | Only if a throwaway probe script proves the specific query shapes 999.6 needs (detail-by-id, searchForSale) are NOT behind the same managed-challenge zone the sold-price spike found — do this probe before committing to the Playwright-only path |
| `cheerio` for broker-page parsing | `playwright`/Apify for broker pages | If a specific broker agency's site proves to have bot-protection (test empirically per-domain; don't assume upfront) |
| `suncalc` (original) | `suncalc3` (`/hypnos3/suncalc3`) | If you want native TS types bundled (no separate `@types` package) and prefer its richer structured-object API; functionally equivalent for this use case |
| `claude-sonnet-4-6` (existing) for vision | `claude-sonnet-5` (High-resolution tier) | If evaluation shows floor-plan detail (small text/dimensions) is being missed at Standard-tier 1568px — worth the ~2-3x visual-token cost for that specific call type only |
| Image `url` source type for vision calls | `base64` embedded images | If a specific image host blocks Anthropic's server-side fetcher (hotlink protection) — download server-side and base64-encode as fallback |
| SCB PxWebApi v1 (existing pattern) for new macro tables | PxWebApi v2 | If starting the new macro-table integration cleanly and willing to absorb a slightly different query-building shape now rather than migrating later before the v1 2026/2027 sunset |

## What NOT to Use

(Consolidated from per-section tables above — see each section for full rationale.)

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `graphql-request` / Apollo Client / raw GraphQL POST as the PRIMARY Booli transport | Doesn't solve the actual blocker (Cloudflare managed challenge), which requires JS execution | Apify `playwright-scraper` + `__NEXT_DATA__`/Apollo-state extraction (already proven in `sold-source.ts`) |
| `puppeteer`/`playwright` as a direct Next.js app dependency | Unsupported/fragile in serverless; duplicates what Apify already provides | Keep all headless-browser work inside Apify actors |
| Vitec Express Connect integration | B2B partnership model, not self-serve; incompatible with solo-dev/no-budget constraints | Scrape rendered broker pages directly (JSON-LD + `cheerio`) |
| `react-leaflet`/`mapbox-gl`/any map library for sun-path | The feature is a numeric computation, not a map UI; adds SSR/bundle complexity for no requirement-driven reason | `suncalc` + optional SVG diagram |
| Full ephemeris-grade astronomy libraries | Overkill precision for building-facade sun exposure | `suncalc` |
| Committing to an iXBRL parser or scraping approach for (f) before a dedicated spike | Format/access-model unverified in this research pass; repeats the exact "assumed vs actual" trap the Booli spike was designed to avoid | Spike first (mirror 999.6's process), then choose tooling |

## Stack Patterns by Variant

**If the probe script confirms `/graphql` IS reachable without a browser for `searchForSale`/detail queries (999.6):**
- Use a minimal raw-`fetch` GraphQL client (no `graphql-request` needed — it's a single query type, hand-rolled `fetch` with a JSON body is simpler than adding a dependency)
- Because this would let 999.6 drop the Apify actor for active listings entirely, not just the paid third-party actor, further cutting cost and one moving part

**If a specific broker agency's page (999.2) proves to be behind bot-protection:**
- Escalate that ONE domain to the existing Apify residential/SE proxy transport (reuse the pattern, not a new vendor)
- Because most brokers won't need it, and paying the Apify-call cost only where proven necessary keeps the pipeline cheap

**If floor-plan analysis accuracy (999.7) proves insufficient at Standard vision-tier resolution:**
- Route floor-plan images specifically through `claude-sonnet-5` (High-resolution tier) while keeping gallery-photo analysis and report synthesis on `claude-sonnet-4-6`
- Because floor plans have small text/dimension labels that benefit disproportionately from the 2576px/4784-token ceiling, while gallery photos (rooms, exteriors) don't need that precision

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|------------------|-------|
| `cheerio@1.2.0` | Node 22 (already the runtime) | No native bindings, pure JS/WASM parser (parse5-based) — no platform-specific install concerns |
| `suncalc@2.0.0` + `@types/suncalc@1.9.2` | Any Node/TS version | Zero-dependency library; types package versioned independently but compatible across suncalc 1.x/2.x API surface |
| `@anthropic-ai/sdk@^0.102.0` (existing) | Vision `url`/`base64`/`file_id` source types | All three are part of the stable (non-beta) Messages API as of the current SDK — no `anthropic-beta` header needed for basic vision; Files API DOES need `anthropic-beta: files-api-2025-04-14` if that path is used |
| SCB PxWebApi v1 (existing) | New macro tables (KPI, Fastighetsprisindex) | Same base URL/auth pattern extends cleanly; v1 sunset is end of 2026/early 2027 — outside this milestone's immediate risk window but worth a query-builder abstraction now |
| Riksbank SWEA API | No existing project dependency | First integration of this data source — fully independent, no compatibility constraints with existing stack |

## Sources

- `.planning/spikes/booli-own-acquisition-SPIKE.md` — field parity + transport findings for Booli GraphQL (HIGH confidence, project-internal)
- `src/lib/market/sold-source.ts` (project code) — the ALREADY-WORKING Cloudflare-clearing transport pattern for Booli SSR data; the single most load-bearing source for section (a)'s recommendation
- `src/lib/market/scb.ts` (project code) — existing SCB PxWebApi v1 keyless-fetch pattern, directly informs section (c)
- [Vision - Claude Platform Docs](https://platform.claude.com/docs/en/build-with-claude/vision) — HIGH confidence, official, fetched 2026-07-06; source of all image-limit/token-cost/resolution-tier claims in section (d)
- Context7 `/anthropics/anthropic-sdk-typescript` — confirmed image content-block shape, Files API pattern, stable (non-beta) status
- [Retrieving interest rates and exchange rates via API | Sveriges Riksbank](https://www.riksbank.se/en-gb/statistics/interest-rates-and-exchange-rates/retrieving-interest-rates-and-exchange-rates-via-api/) — official page confirming API exists; specific base URL/auth/rate-limit details corroborated via WebSearch summary of `developer.api.riksbank.se` (MEDIUM — not independently hands-on verified with a live call in this pass)
- [SweaWS - Introducing the API](https://swea.riksbank.se/sweaWS/docs/api/index.htm) — referenced as the technical API docs entry point
- [Statistikdatabasens API (PxWebApi)](https://www.scb.se/vara-tjanster/oppna-data/pxwebapi/) and [PxWebApi v2](https://www.scb.se/en/services/open-data-api/pxwebapi/pxwebapi-2.0) — official SCB pages confirming the v1→v2 migration and end-of-2026/2027 v1 sunset (HIGH confidence, official source)
- [API:er och öppna data – Bolagsverket](https://bolagsverket.se/apierochoppnadata.2531.html) — official page exists confirming Bolagsverket API program; specific annual-report format/access details corroborated via WebSearch summary only (MEDIUM — the live page returned a CAPTCHA wall to automated fetch in this research pass, could not verify directly)
- Booli MCP server findings (`matt1as/booli-mcp-cc`, via WebSearch/LobeHub secondary summaries) — `residenceId`/`/bostad/{id}` URL-path parsing claim (MEDIUM confidence — secondary source, not the primary repo source code, which returned 404 on direct fetch)
- Context7 `/hypnos3/suncalc3` and npm registry (`npm view suncalc`, `npm view @types/suncalc`) — HIGH confidence, direct registry query, current versions as of 2026-07-06
- npm registry direct queries (`cheerio`, `graphql-request`, `undici` versions) — HIGH confidence, live registry data

---
*Stack research for: Bostad AI v1.1 (Owned Data Layer & Intelligent Discovery)*
*Researched: 2026-07-06*
