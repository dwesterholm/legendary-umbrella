---
phase: 03-market-context
status: secured
audited: 2026-06-22
asvs_level: 2
block_on: high
register_authored_at_plan_time: true
threats_total: 27
threats_closed: 27
threats_open: 0
accepted_risks: 2
unregistered_flags: 0
---

# SECURITY.md — Phase 03: Market Context

**Audit date:** 2026-06-22
**ASVS Level:** 2
**Block-on:** high
**Result:** SECURED — 27/27 threats closed (25 mitigations verified in code, 2 accepted risks documented)
**Register provenance:** authored at plan time (`register_authored_at_plan_time: true`); each declared mitigation verified present in the implementation by grep + file read. No retroactive STRIDE scan performed.

**File-naming-drift note:** the prompt warned that `geo.ts → src/lib/geo/resolve-geo.ts` and `scb.ts → src/lib/market/scb-client.ts` during the Plan-06 live-gate. On disk the functions actually live at the ORIGINAL paths (`src/lib/market/geo.ts` → `resolveGeo`; `src/lib/market/scb.ts` → `fetchScbDemographics`). The 03-06-SUMMARY frontmatter `key-files.modified` lists the drifted names, but the real modules were never renamed (the live-gate fixes edited the originals in place). Evidence below cites the verified real paths.

---

## Threat Verification

| Threat ID | Category | Disposition | Status | Evidence (file:line) |
|-----------|----------|-------------|--------|----------------------|
| T-03-01 | Info Disclosure | mitigate | CLOSED | `src/lib/market/__fixtures__/sold-comps.json` — every PII field redacted: `streetAddress`/`latitude`/`longitude`/`url`/`location`/`images`/`primaryImage` = `<REDACTED>` (245 occurrences), `descriptiveAreaName` = `<REDACTED_AREA>` (35); remaining `screenReaderLabel` values are only m²/rum/kr-m² statistics + the municipality "Nacka kommun" (no street name+number). No `http(s)` urls, no `apify_api_`/token/secret literals in the fixture. Repo-wide `git grep`: no committed `APIFY_API_TOKEN` value, no `apify_api_` literal. `scb-tenure.json` is pure json-stat2 (no coords/PII). |
| T-03-02 | Tampering | mitigate | CLOSED | `src/lib/schemas/listing.ts:88-121` — new coord fields go through null-tolerant coercion: `num()` (88-89) → null on non-finite, `idStr()` (97-102) coerces booliId else null, `crumbs()` (104-105) → null for non-arrays. `latitude`/`longitude`/`booliId`/`breadcrumbs` mapped at 117-120; malformed values fall back to null, never crash. |
| T-03-02b | Spoofing / ToS | mitigate | CLOSED | `src/lib/market/sold-source.ts:1-228` — the ONE source-isolating interface (transport identity confined to this module). No `"use client"` (imports `apify-client`, server-only); imported ONLY by the `"use server"` action `src/actions/enrich-market-context.ts:6-9` and a test (grep confirmed — no client component imports it). User-initiated + server-side; rate-bounded by the per-tier walk (`MAX_SOURCE_CALLS=3`) and durable `price_data` cache. |
| T-03-03 | Info Disclosure | mitigate | CLOSED | `supabase/migrations/003_market_context.sql:38-42` — `add column if not exists` only; no new RLS policy. New `price_data`/`area_data` columns inherit per-user SELECT (`001_analyses.sql:20-22` `auth.uid()=user_id`) + UPDATE (`002_brf.sql:20-23`). No access broadening. |
| T-03-04 | Tampering | mitigate | CLOSED | `supabase/migrations/003_market_context.sql` — `grep -i "create policy"` returns NOTHING; only `alter table … add column if not exists`. A duplicate UPDATE policy (which would error + half-apply) is omitted. 03-02-SUMMARY confirms the live `supabase db push` landed with no RLS error. |
| T-03-05 | Denial of Service | accept | CLOSED (accepted) | Free-tier 7-day pause is a known infra risk; a human wakes the project. No code mitigation expected. Acceptance rationale still holds — documented in the Accepted Risks log below. |
| T-03-06 | Tampering (SSRF) | mitigate | CLOSED | `src/lib/market/scb.ts:126-128` `isValidRegionCode` regex guard `/^\d{4}[A-Z]\d{4}$/ \|\| /^\d{4}$/`, enforced at L201 before any query. Region value built via `desoRegionValue()` (L117-119) from the validated code; all query bodies (L207-303) assembled server-side from the `SCB_TABLES` constant whitelist + `Region` validated code. No user free-text reaches the URL or body. |
| T-03-07 | Tampering | mitigate | CLOSED | `src/lib/market/scb-schema.ts:33-202` — `jsonStat2Schema` is `.passthrough()` with every field optional (33-41); `normalizeScbOutput` uses `safeParse` and returns the all-null result on failure (107-108), guards missing size/value/ids (114-116); every metric independently falls back to null. Never throws on malformed/partial SCB JSON. |
| T-03-08 | DoS (rate) | mitigate | CLOSED | `src/lib/market/scb.ts:305-310` — exactly 3 `fetchScbTable` calls per enrich via `Promise.all` (well under SCB's 30/10s). Persisted `area_data` is the durable cache of record (documented L19-24); module memory explicitly NOT the mechanism. Page reads from `area_data` without re-calling (`page.tsx:54`). |
| T-03-09 | Info Disclosure | mitigate | CLOSED | `src/lib/market/scb-schema.ts:242-246` `safeParseAreaData` re-validates on read; used on the read path at `src/app/(app)/analysis/[id]/page.tsx:11,54`. `area_data` is read under per-user RLS via the server Supabase client. |
| T-03-10 | Info Disclosure | mitigate | CLOSED | `src/lib/market/sold-source.ts:35` reads only `process.env.APIFY_API_TOKEN` server-side; documented never-`NEXT_PUBLIC_` (L23-25). Repo-wide grep: no `NEXT_PUBLIC_*(APIFY\|TOKEN)`. The keyless SSR-HTML path needs no other secret. |
| T-03-11 | Tampering | mitigate | CLOSED | `src/lib/market/sold-schema.ts:202-252` — `soldPayloadSchema`/`soldPropertyRawSchema` are `.passthrough()` (49-74); `normalizeSoldOutput` guards every entry with typeof/null checks (203,219,224) and uses null-tolerant `num`/`str`/`rawOf`/`parsePlainNumber`; returns `[]` on non-object input. Never throws on malformed sold JSON. |
| T-03-12 | Tampering (SSRF) | mitigate | CLOSED | `src/lib/market/sold-source.ts:84-119` — `resolveAreaId` extracts the areaId ONLY via `/areaIds=(\d+)/` digit capture from breadcrumb urls (L88); `buildSlutpriserUrl` (115-119) uses `URLSearchParams` with that numeric areaId + a constant `https://www.booli.se` host. No raw user free-text interpolated into the source URL. |
| T-03-13 | DoS / Financial | mitigate | CLOSED | `src/lib/market/cost.ts:36` `SOLD_SOURCE_COST_CAP_SEK = 1.0`; `soldSourceCostSek` (54-57). `src/actions/enrich-market-context.ts:72` `MAX_SOURCE_CALLS = 3` bounds the SPEND itself (walk hard-break L188); cost gate refuses persist over cap (L424-431). Spend bounded independently of the persist gate. |
| T-03-14 | Spoofing / Misrep | mitigate | CLOSED | `src/lib/market/compare.ts:223-293` — `computePriceComparison` surfaces `sampleSize` (91), distribution `min`/`max` (84-87), and the reason discriminator. Guards ordered first: `listing_pris_okand` for null/≤0 listing price (242-259, no false −100%), `thin` for 0/≤2 usable comps with null-areaAvg guard (261-275, never NaN). Dead source tagged `source_unavailable` by the action (not here), never shown as thin. |
| T-03-15 | EoP / IDOR | mitigate | CLOSED | `src/actions/enrich-market-context.ts:300-316` — `supabase.auth.getUser()` gate (300-305) + ownership check `row.user_id !== user.id` as second layer behind RLS (314-316), rejecting other-user analysisId with Swedish "Analysen hittades inte." |
| T-03-16 | Info Disclosure | mitigate | CLOSED | `src/actions/enrich-market-context.ts` — all reads/writes scoped `.eq("id", analysisId)` (L311, 322, 104, 470) under per-user RLS; the ownership check (T-03-15) is defence-in-depth. |
| T-03-17 | DoS / Financial | mitigate | CLOSED | `src/actions/enrich-market-context.ts:72` `MAX_SOURCE_CALLS = 3`; `walkSoldTiers` (178-213) enforces `if (renders >= MAX_SOURCE_CALLS) break` (188) and short-circuits at the first sufficient tier `recentUsableCount(comps,nowMs) > thin` (195-197). Cost gate sits before persist (424-431). SPEND bounded, not just persist. |
| T-03-18 | Info Disclosure | mitigate | CLOSED | `src/actions/enrich-market-context.ts` — every `console.error` logs only `{ analysisId, code/message }` (L106-110, 413-416, 441-444, 473-476). Never coords/financials/comp payloads. `sold-source.ts:222-223` and `scb.ts:155,162` log error/status only. |
| T-03-19 | Availability | mitigate | CLOSED | `src/actions/enrich-market-context.ts` — two independent try/catch blocks: PRICE branch (371-419) + AREA branch (437-446). Single `.update` writes BOTH `price_data` + `area_data` (461-470); each persists even when the other is null/source_unavailable. |
| T-03-20 | Tampering | mitigate | CLOSED | `src/app/(app)/analysis/[id]/page.tsx:41-54` — re-validates ALL persisted jsonb: `listingDataSchema.safeParse` → `notFound()` on drift (41-44), `safeParsePriceData` (53), `safeParseAreaData` (54). Shape drift → null → degrade, never crash. |
| T-03-21 | Info Disclosure | accept | CLOSED (accepted) | `src/app/(app)/analysis/[id]/page.tsx:79-85` renders `MarketContextSection` with NO `isGuest` prop; row read under per-user RLS so only the owner's row returns. `src/components/market-context-section.tsx:56-60,82-97` — no guest read path, no anonymous trigger surface; enrich re-checks auth+ownership server-side. Non-PII statistical/demographic data the owner already sees. Acceptance rationale holds — documented below. |
| T-03-22 | Spoofing / Misrep | mitigate | CLOSED | `src/components/price-comparison-card.tsx:155-318` — branches on `priceData.reason` BEFORE any headline: `source_unavailable` (160-176, distinct "ej tillgänglig / källan gick inte att nå"), `listing_pris_okand` (179-201, "pris/kvm saknas", never −100%), `thin` (204-229, distinct "för få försäljningar"), `ok` (231-318). Surfaces sampleSize, distribution, tier, confidence badge (104-121), "ej värdering" disclaimer (24-25,56). Renders persisted values only — no recomputation. |
| T-03-23 | EoP | mitigate | CLOSED | `src/actions/enrich-market-context.ts:1` `"use server"`; re-checks auth+ownership server-side (300-316) regardless of the client trigger in `market-context-section.tsx:82-97`. Page owner-only by construction (links to T-03-15). |
| T-03-24 | Spoofing / Misrep | mitigate | CLOSED | `src/actions/enrich-market-context.ts:405-418` — the catch around `walkSoldTiers` sets `sourceUnavailablePrice()` (reason `source_unavailable`, L216-232), DISTINCT from the `thin` reason compare.ts sets from real fetched comps. A fetch FAILURE persists `source_unavailable`, never mislabeled as thin. |
| T-03-SC | Tampering (supply chain) | mitigate | CLOSED | `package.json` — `@turf/boolean-point-in-polygon@^7.3.5` + `@turf/helpers@^7.3.5` (Turfjs v7.x, resolved 7.3.5 in `package-lock.json`). `mapshaper` ABSENT from both `package.json` and `package-lock.json` (0 occurrences) — one-time /tmp build tool. Legitimacy gate (`npm view` → Turfjs org) was a human checkpoint per 03-03-SUMMARY. |

**Summary:** 27/27 threats CLOSED — 25 mitigations verified present in code, 2 accepted risks documented.

---

## Accepted Risks Log

### T-03-05 — Paused free-tier Supabase project (Denial of Service)
**Disposition:** ACCEPT (no code mitigation expected).
**Rationale (still valid):** The Supabase free tier pauses a project after ~7 days of inactivity. This is an operational/infra risk, not an application vulnerability — a human wakes the project from the dashboard before use. 03-02-SUMMARY confirms the risk did not materialise during the live migration push (project was awake). No code change is the correct disposition; revisit only on a paid-tier upgrade or an SLA requirement.
**Residual exposure:** A first request after a pause window may fail until the project is woken. Acceptable for the current single-operator stage.

### T-03-21 — Client-rendered market data (Information Disclosure)
**Disposition:** ACCEPT (owner-only-by-construction verified; no additional code mitigation expected).
**Rationale (still valid):** The market panels render non-PII statistical (Booli aggregate sold-comp stats, fully redacted of per-object PII) and demographic (SCB DeSO public statistics) data that the row's owner already sees. The analysis detail page renders only for a persisted analyses row, which exists only for the authenticated owner under per-user RLS; `MarketContextSection` takes no `isGuest` prop and exposes no guest read path or anonymous enrich trigger (verified `src/components/market-context-section.tsx:56-60,82-97` + `page.tsx:79-85`). The enrich server action re-checks auth + ownership server-side (T-03-15/T-03-23) as defence-in-depth.
**Residual exposure:** None beyond what the owner is already entitled to see. The data is owner-scoped persisted values; no other-user data is reachable.

---

## Unregistered Flags

**None.** No 03-* SUMMARY contains a `## Threat Flags` section. The only adjacent note — 03-02-SUMMARY `## Threat Surface` (L92-97) — explicitly states "No new threat surface beyond the plan's threat_model." The Plan-06 live-gate produced five Rule-1 bug fixes (Apify cold-start, deso.geojson bundling, SCB query bodies, Apollo array shape, 403 retries) but introduced no new attack surface: no new external input, no new secret, no new auth/data-flow path. The re-captured `sold-comps.json` fixture (commit d7c25c7) retains the live Apollo key shape but every PII value is `<REDACTED>` (verified under T-03-01), so the re-capture did not re-introduce the original PII risk.

---

## Notes for Downstream Phases (informational, non-blocking)

- **CF/transport fragility (monitored, not a threat):** the sold source depends on `apify/playwright-scraper` continuing to clear Cloudflare. `fetchSoldComps` throws on `hasApollo===false`/non-200 (`sold-source.ts:202-218`) so a transport outage degrades to `source_unavailable` (honest), never a false thin. Spike-documented; alert on `hasApollo===false`.
- **Transient-vs-permanent Apify error handling (carry-forward):** 03-06-SUMMARY flags a one-off HTTP 402 that did not reproduce. Currently any walk failure maps to `source_unavailable`; a transient quota blip could surface as `source_unavailable` where a retry would have succeeded. Cost-safe (the cost gate + `MAX_SOURCE_CALLS` still bound spend) — a UX/robustness refinement for Phase 4, not a security gap.
