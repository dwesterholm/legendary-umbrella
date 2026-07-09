# Project Research Summary — Milestone v1.1

**Project:** Bostad AI — Owned Data Layer & Intelligent Discovery
**Domain:** Proptech / AI property analysis (scraping + LLM + vision + macro data)
**Researched:** 2026-07-06
**Confidence:** MEDIUM-HIGH

> Synthesizes `.planning/research/{STACK,FEATURES,ARCHITECTURE,PITFALLS}.md`. Dimension files hold the detail; this is the roadmap-facing digest.

## Executive Summary

v1.1 is a qualitative shift from **reactive single-listing analysis** to a **proactive, discovery-driven** product — while keeping v1.0's "deterministic trust, no fabrication, every claim cited, no verdict" philosophy intact. Three findings all four researchers converged on:

1. **999.6 (owned Booli acquisition) is the foundational gate.** Every other feature depends on it directly or indirectly. Critical correction to the backlog framing: Booli's `/graphql` sits behind a Cloudflare managed-challenge zone — a raw keyless GraphQL client will likely hit the same wall the sold-price path already did. The **proven** transport already lives in the codebase (`sold-source.ts`: Apify Playwright + `__NEXT_DATA__`/`__APOLLO_STATE__` extraction). Generalize that to active-listing + single-listing-by-URL; don't build a new GraphQL client. The one unresolved unknown — single-listing-by-URL retrieval — must be de-risked by a spike before build.

2. **999.7 (AI discovery + vision scraper) is the highest-risk, highest-complexity feature** — and the real architectural pivot. It's a fan-out batch job (N listings × k vision calls) that cannot run in one Server Action. It also **shifts the legal posture** from user-initiated single-URL to proactive area-wide scraping, and introduces **image-derived probabilistic judgment** — an input type v1.0's deterministic architecture has no slot for. Must be split into independently-shippable/killable sub-phases with its own spike.

3. **999.2 (broker extraction) and 999.3 (macro context) are lower-risk momentum builders** — both reuse proven v1.0 patterns (additive-nullable fields + independent-branch degradation; `area_data`-style caching), add no new legal surface, and have clear value. 999.3 is fully independent and can parallelize with 999.6.

## Stack Additions

- **Only two new npm deps:** `cheerio` (broker-page parsing, JSON-LD first / DOM fallback) and `suncalc` + `@types/suncalc` (sun-path geometry). No version bumps to existing packages.
- **999.6:** reuse existing `apify-client` + `apify/playwright-scraper` (only transport that clears Cloudflare) — generalize `sold-source.ts`.
- **999.3:** Riksbank **SWEA API is keyless** (1,000 calls/day unregistered; 30k/week free signup). SCB **PxWebApi v1** still works (already used for AREA-01) but **sunsets end-2026/early-2027** → put new macro tables behind a thin `buildPxWebQuery` abstraction now.
- **999.7 vision:** no new SDK/model — `claude-sonnet-4-6` (already used) supports vision at Standard tier; prefer `url` image source type (images already hosted). Consider a High-res tier / Sonnet-5 escalation for floor-plan detail only if eval shows missed dimensions.
- **Sun-path:** `suncalc` is unobstructed-only — frame all output as *theoretical* ("teoretisk solexponering, tar inte hänsyn till skuggning"); real obstruction needs 3D geometry the project has no source for.

## Feature Landscape

**Table stakes:** unchanged acquisition reliability; floor/balcony/BRF-name recovered; description preserved verbatim; every soft-attribute claim cited to its image source; BRF auto-fetch degrades gracefully; sun exposure explained in buyer language.

**Differentiators:** AI free-text discovery with configurable niches (renovation-upside / turnkey / imminent-stambyte) — no Swedish competitor offers this; vision-derived attributes as **evidence, not verdicts**; honestly-descriptive macro context; deeper extraction that follows through to the broker source; owned acquisition layer (removes recurring actor cost + third-party fragility).

**Anti-features (explicitly out):** definitive "this wall can be removed" structural claims (liability + fabrication); photorealistic "after renovation" visuals; unbounded area crawling; feeding vision output into the deterministic flag/score system as if equivalent.

## Architecture Integration

- **999.6:** new `src/lib/booli/client.ts`, three-rung fallback tree (direct → Apify proxy → paid actor), drop-in for `scrapeBooli()`; output shape unchanged, `normalizeScraperOutput` untouched; absorbs `sold-source.ts` to unify transport.
- **999.2:** second enrichment step; Booli is base, broker fields fill gaps only (never overwrite — preserves provenance); new fields `.nullable().optional()` → no migration; broker-fetch failure never fails the primary fetch.
- **999.3:** new shared `macro_snapshots` table (cache across all analyses, not per-analysis), lazy-fetch-with-TTL; fourth independent branch in `enrichMarketContext`.
- **999.7 — the pivot:** DB-row-as-job-queue (`discovery_jobs` table) + Vercel Cron poller processing small slices, using the atomic-CAS lock idiom already proven in `generateReport` (extended to `FOR UPDATE SKIP LOCKED`) — **zero new infra**, aligned with the near-zero-budget constraint. Vision output lives in its own clearly-labeled section ("AI-bedömning av bilder — kan vara fel"), structurally separate from deterministic flags.
- **BRF auto-fetch:** pre-step to `analyzeBrf`; both auto + manual paths call the **same** `runBrfExtraction()` helper; failure falls through to the existing upload UI; new `auto_fetching` status.
- **Build order:** 999.6 spike → 999.6 build → (999.3 parallel) → 999.2 → BRF auto-fetch → 999.7 spike → 999.7 sub-phases.

## Watch Out For (Pitfalls)

1. **Legal posture shift (999.7)** — bulk/systematic area-wide scraping is a different legal fact-pattern than v1.0's user-initiated single-URL. Treat legal review as a **named go/no-go gate**, not an in-phase task. Hard per-search caps (20–30 candidates), human-pace rate-limiting, kill switch.
2. **New PII/GDPR surfaces** — broker contact info (999.2), people/personal docs in gallery photos (999.7). Extract only structured product-need fields; vision prompt must ignore people/personal documents; extend retention/deletion policy.
3. **Vision hallucination vs. no-fabrication philosophy** — real-estate vision accuracy ~50%; wall-removal/renovation claims are exactly the confident-but-unverifiable output the product avoids. Structurally distinct UI, cite which image + what observation, hedge as investigation-prompts. Load-bearing status is **not** determinable from a 2D floor plan (even pros need a formal väggutredning). Validate on 20–30 real listings before shipping.
4. **Sun-path overstates accuracy** — scope honestly as theoretical/unobstructed by facade orientation; no obstruction modeling without real 3D data.
5. **Vision-over-N cost blowup** — 40 listings × 8 images = 320+ calls/search. Design a per-search hard SEK/listing/image cap **before** the vision loop; Haiku pre-filter, Sonnet only on promising; cache per listing.
6. **Macro drifting into prediction** — keep 999.3 strictly descriptive; add an explicit negative constraint to the synthesis prompt (mirror the no-verdict schema enforcement); test for predictive-language creep.
7. **BRF auto-fetch wrong doc/year/org** — match by **organisationsnummer**, not name-string; surface matched org.nr + fiscal year for user confirmation; monitor fallback rate.
8. **Solo-dev scope overrun** — five independently-large efforts at 5–10h/week. Sequence, don't parallelize; split 999.7; define kill criteria per sub-feature; mid-milestone checkpoint after 999.6/999.2.

## Roadmap Implications

Recommended sequencing (est. 7–10 weeks calendar at 5–10h/week, with tactical descoping possible mid-999.7):

1. **999.6 — Owned acquisition** (spike → build). Spike gate: single-listing-by-URL retrieval. Foundational.
2. **999.3 — Macro price context** (no spike; fully independent — good parallel/first win).
3. **999.2 — Deeper broker extraction** (short CMS-coverage spike; recovers `brfName`/floor/etc.).
4. **BRF auto-fetch** (spike: Bolagsverket/Allabrf access + org-nummer lookup; soft-depends on 999.2 for a reliable identifier).
5. **999.7 — AI discovery + vision** (own spike, then sub-phases: area-scrape+filter → text niche-ranking → gallery vision → floor-plan + sun-path). Legal go/no-go gate before implementation. Each sub-phase independently killable.

**Checkpoint** after 999.6 + a low-risk win land, before committing to 999.7.

### Spikes required before phase planning

| Feature | Spike | Blocking? |
|---------|-------|-----------|
| 999.6 | Single-listing-by-URL retrieval (detail query vs SSR/Apollo scrape vs filtered searchForSale) | **BLOCKING** build |
| 999.7 | Vercel Cron limits + free-text→filter reliability + `FOR UPDATE SKIP LOCKED` prototype + area-scrape cost smoke test | **BLOCKING** feasibility |
| 999.7 | Legal go/no-go on area-wide scraping (lightweight consult) | **GATE** before impl |
| 999.2 | Broker-CMS coverage (what fraction of `agencyListingUrl` is Vitec vs custom) | Informational |
| BRF auto-fetch | Bolagsverket API access model + iXBRL format + Allabrf reliability + org-nummer resolution | Informational (shapes source) |

### Proven patterns — no research needed
Independent-branch degradation; per-search cost-cap (scale the per-analysis pattern); atomic CAS lock (`FOR UPDATE SKIP LOCKED`, extends `generateReport`); status-polling progress (reuse `BrfProgress`); schema-level constraint enforcement (no-prediction field simply absent); additive nullable fields with graceful degradation.

## Top Unknowns (ranked by impact)

1. Single-listing-by-URL retrieval (999.6 spike) — sets cost/latency for the whole milestone.
2. Legal posture on area-wide scraping (999.7 gate) — go/no-go for the feature.
3. Vision cost & accuracy on real Swedish floor plans (999.7 validation) — ship-or-defer.
4. Free-text-intent → filter parsing reliability (999.7 spike) — UX viability.
5. Bolagsverket/Allabrf access model (BRF auto-fetch spike) — shapes source + effort.

---
*Synthesized 2026-07-06 for milestone v1.1 roadmap planning.*
