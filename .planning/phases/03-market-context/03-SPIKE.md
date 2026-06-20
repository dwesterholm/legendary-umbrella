# Phase 3 — Wave 0 Spike: Sold-source feasibility + SCB DeSO-availability

**Run:** 2026-06-20 (executor, Plan 03-01 Task 1)
**Gate:** `checkpoint:human-verify` — APPROVED 2026-06-20.

> **History:** an initial pass (commit 065a03b) recorded a Cloudflare *blocker* against the keyless `searchSold` **GraphQL** endpoint and shipped a MOCK fixture. Two follow-up validation spikes **overturned that conclusion**: Booli **server-renders** the full per-object slutpriser into the page HTML, so the GraphQL/Cloudflare-API wall is irrelevant. There **is** a working, validated, in-budget sold-price source (GO verdict). This document is the single canonical record — the A1 scratch notes have been folded in here and deleted.

---

## TL;DR / Decision

- **Sold-price source: GO.** Booli **server-renders** the full per-object slutpriser into the page HTML inside a `<script id="__NEXT_DATA__">` blob (Pages-Router/Apollo). We read SSR HTML, **not** the GraphQL API — so the `/graphql` Cloudflare managed-challenge wall (the original blocker) does **not** apply. Every probe this session returned HTTP 200 with full Apollo state: **0 CF challenges, 0 empty states** across ~12 distinct fetches.
- **Transport (KEY nuance): a real headless browser is mandatory.** A raw `fetch` — even routed through the Apify RESIDENTIAL/SE proxy — returns **403 `cf-mitigated: challenge`**. Only `apify/playwright-scraper` (chromium launcher) + RESIDENTIAL/SE proxy clears Cloudflare and returns 200 with full data. This is the same browser-transport posture the existing active-listing actor already uses. Keep `maxRequestRetries >= 1` (one transient proxy blip self-healed on retry 1 this session).
- **Cost: well under budget.** Actual Apify billing ~**$0.0055 / render**; worst realistic case ~**$18/mo at 800 analyses/mo** — comfortably under the <$100/month budget. Mitigate via per-area caching + page batching.
- **SCB (AREA-01): fully de-risked.** All three demographic metrics are **DeSO-available** (live-probed): population (2025), income (2024), tenure/upplåtelseform (2025). A3 [ASSUMED] is **RESOLVED — DeSO, not kommun-only** for every metric. Only caveat: income lags one year behind population/tenure.
- **Coordinates + breadcrumbs: confirmed available** at scrape time from the existing active-listing actor; the exact `breadcrumbs` shape and the `areaId` ladder are pinned below (drives Plan 04 D-01 tiering and Plan 03 Task 3 schema).
- **No new env vars. No new runtime dependency.** Only `APIFY_API_TOKEN` (already configured, Phase 1) is involved (as the Apify Playwright transport + RESIDENTIAL/SE proxy). No `next.config.ts serverExternalPackages` change needed (native fetch / existing apify-client).
- **PRICE-01 now ships in FULL** — no longer "INCOMPLETE"/`source_unavailable` as the default state. (The Plan 06 Task 3 live gate remains as a runtime safety net, but the in-budget working source means the panel ships real slutpriser, not a mock.)

---

## 1. Sold-source: the working source (SSR HTML, NOT GraphQL)

### 1.1 Why the original GraphQL blocker is moot

The official Booli API is dead (now "Booli Pro", institution-only) — not a candidate. The originally-planned path was the keyless `searchSold` **GraphQL** POST at `https://www.booli.se/graphql`. That endpoint sits behind a **separate, stricter Cloudflare managed-challenge zone** than the for-sale/slutpriser HTML pages: even a Playwright browser that has *cleared* CF for the page still gets a 403 "Just a moment…" on a same-origin `POST /graphql`. A non-browser POST cannot solve a JS/Turnstile managed challenge regardless of IP reputation.

**But we never needed the API.** Booli renders every comp on the page into the HTML server-side. A browser-grade transport that clears Cloudflare for the *page* (the same one the existing actor uses) gets a 200 HTML response whose embedded JSON already contains every comp — price, kr/m², area, rooms, sold date, list price, and the +/-% diff. **No GraphQL call needed.**

### 1.2 Working request recipe

| Item | Value |
|---|---|
| **URL** | `https://www.booli.se/sok/slutpriser?areaIds=<N>` |
| **`areaIds`** | the same integer used by the active for-sale search (resolved from a listing's breadcrumb ladder — see §2) |
| **Pagination** | `&page=N` — **35 SoldProperty objects per page**; page 1 = most-recent 35 sales |
| **Object-type filter** | optional `&objectType=Lägenhet` (bostadsrätt) / `Villa` (house) — CONFIRMED to narrow both the comps and the typed `totalCount` |
| **Depth probe** | `searchSold.totalCount` is exposed in the Apollo `ROOT_QUERY` (`searchSold({"input":{"areaId":"N",...}}).totalCount`) — measure depth before paginating |
| **Transport** | `apify/playwright-scraper` (launcher `chromium`) + Apify proxy `RESIDENTIAL` / country `SE`. **A raw fetch — even via the residential proxy — is 403-challenged; a real browser is mandatory.** Keep `maxRequestRetries >= 1`. |
| **Bonus single-fetch** | `/sok/till-salu?areaIds=<N>` embeds, in the same `__APOLLO_STATE__`: active `Listing` objects (each with `listSqmPrice`/pris-kvm) **+** an `Area_V3` area-context object **+** a batch of `SoldProperty` comps — listing pris/kvm, area context, and sold comps in one render |

**Transport probe matrix (what fails vs. works):**

| URL | Transport | HTTP | Result |
|---|---|---|---|
| `/sok/slutpriser?areaIds=<N>` | Direct `fetch`, browser headers, sv-SE | **403** | CF `cf-mitigated: challenge` |
| `/sok/slutpriser?areaIds=<N>` | Raw fetch via Apify RESIDENTIAL/SE proxy (undici `ProxyAgent`) | **403** | raw HTTP through proxy is NOT enough |
| `/sok/slutpriser?areaIds=<N>` | **`apify/playwright-scraper` chromium + RESIDENTIAL/SE** | **200** | CF cleared, real HTML, full `__NEXT_DATA__` |
| `/graphql` POST (from a CF-cleared Playwright page context) | Playwright + RESIDENTIAL/SE | **403** | `/graphql` is a stricter, separate CF zone — irrelevant, we use SSR HTML |

### 1.3 Data shape + Apollo paths (per-sale attributes)

**JSON path:** `__NEXT_DATA__ → props.pageProps.__APOLLO_STATE__ → SoldProperty:<booliId>`.

Per comp (the floor `soldDate` + `soldPrice` + pris/kvm is satisfied; the rest are bonus per D-03):

| Attribute | Apollo path | Type |
|---|---|---|
| Sold price (SEK) | `soldPrice.raw` | numeric |
| List price | `listPrice.formatted` (raw not always present) | string/numeric |
| Sold vs list % diff | `soldPricePercentageDiff.raw` | numeric % |
| Sold vs list abs diff | `soldPriceAbsoluteDiff.formatted` | string |
| Sold date (ISO) | `soldDate` | `"YYYY-MM-DD"` |
| Object type | `objectType` | `"Lägenhet" \| "Villa" \| "Radhus" \| …` |
| Days on market | `daysActive` | numeric |
| Living area (m²) | `displayAttributes(…).dataPoints[]` plainText e.g. `"99 m²"` | parseable string |
| Rooms | `displayAttributes(…).dataPoints[]` plainText e.g. `"4 rum"` | parseable string |
| **pris/kvm (kr/m²)** | `displayAttributes(…).dataPoints[]` plainText e.g. `"53 300 kr/m²"` | parseable string |

Numeric `.raw` values mean **no string parsing** for price/%; m²/rooms/kr-per-m² come from the `dataPoints` plainText (parseable, e.g. `"57 100 kr/m²"`). The for-sale page additionally carries `Area_V3:<areaId>` → `{ name, displayName, type:"municipality"|…, parent, parentDisplayName }` as the comparison's area-context object.

This is **full per-object comps** — strictly better than aggregate medians.

### 1.4 Robustness — coverage / freshness / reliability (GO evidence)

**Area-size sensitivity** (`searchSold.totalCount` from `ROOT_QUERY`; comps/page = 35 in every case):

| Area | areaId | type | totalCount (sold) | page-1 soldDate range | ≥5 comps? |
|---|---|---|---|---|---|
| Sweden (country) | 290/115 | country | 2,931,519 | 2026-06-20 → 06-19 | yes |
| Stockholm kommun (large) | 1 | municipality | dense | newest 2026-06-20 | yes |
| Nacka kommun (mid) | 76 | municipality | 37,255 | 2026-06-20 → 06-16 | yes |
| Blekinge län (region) | 145 | län | 40,722 | 2026-06-19 → 06-14 | yes |
| Fabrikörvägen (narrow urban street) | 99898 | userDefined | 330 | 2026-05-31 → 2025-11-26 (~6 mo) | yes |
| Hällesåker (sparse locality) | 260 | userDefined | 649 | 2026-06-11 → 2025-01-31 (~17 mo) | yes, but stale |

- A narrow urban street-level area (`99898`) returns a full 35-comp page — **direct narrow queries are viable in dense areas**.
- A genuinely sparse locality (`260`) still returns 35 comps but **page 1 reaches back ~17 months** to fill them. The constraint there is **freshness, not count** — thinness manifests as *stale* comps, not empty results. Trigger the D-01 walk-up on **recency + count**, NOT on `totalCount` alone.

**Object-type filter — CONFIRMED:** `?areaIds=76&objectType=Lägenhet` → all comps `Lägenhet`, totalCount 20,444; `…&objectType=Villa` → all `Villa`, totalCount 10,222. Filter also propagates to the embedded sold comps on the `/sok/till-salu` page.

**Freshness (Nacka `76`, pages 1→3):** continuous and recent — page 1 oldest = 2026-06-16 (same week vs today 2026-06-20); ~35 comps per ~3–4 days ⇒ last 12 months densely represented for kommun-level / typical urban-narrow areas.

**Reliability — 4/4 clean:** repeated `areaIds=76` as independent actor runs (fresh CF clearance each) all SUCCEEDED, `hasApollo === true`, 35 comps, ~20–35s/render. One transient crawler-layer `ERR_TUNNEL_CONNECTION_FAILED` auto-rotated and **self-healed on retry 1** (hence `maxRequestRetries >= 1`).

### 1.5 Per-query cost (actual Apify billing — `usageTotalUsd`)

Mean ~**$0.0055 / URL-render**; single-URL run incl. container startup ~$0.0074. Compute driver ≈ 0.034 CU/render. Dominant cost = chromium render time (~20–35s).

| Pattern | $/analysis | 200/mo | 800/mo | <$100/mo? |
|---|---|---|---|---|
| 1 page/analysis (batched) | $0.0055 | $1.11 | $4.44 | yes |
| 3 pages/analysis (batched in 1 run) | $0.0166 | $3.33 | $13.31 | yes |
| Worst: 1 run/analysis (own container) | $0.0074 | $1.48 | $5.94 | yes |
| Worst: 3 separate runs/analysis | $0.0223 | $4.45 | $17.82 | yes |

**Even the worst case (~$18/mo at 800 analyses/mo) is comfortably under $100.** Mitigate via (a) per-area + window caching (sales are append-only; a TTL of days is fine) and (b) batching pages into a single actor run.

---

## 2. areaId resolution + breadcrumbs shape (PINNED — drives Plan 04 D-01 tiering & Plan 03 Task 3 schema)

Captured live from the active-listing actor + a detail-page scrape. Per item the actor returns:
`latitude, longitude, booliId, breadcrumbs, descriptiveAreaName, streetAddress, infoPoints, amenities, listSqmPrice, objectType, rooms, livingArea, …` (full key list in §appendix).

### `breadcrumbs` shape — CONFIRMED

An **array** of `{ label: string; url: string }`, ordered **wide → narrow** (län → kommun → street/neighborhood → BRF):

```jsonc
[
  { "label": "Stockholms län",     "url": "https://www.booli.se/sok/till-salu?areaIds=2&objectType=Lägenhet" },
  { "label": "Nacka kommun",       "url": "https://www.booli.se/sok/till-salu?areaIds=76&objectType=Lägenhet" },
  { "label": "Fabrikörvägen",      "url": "https://www.booli.se/sok/till-salu?areaIds=99898&objectType=Lägenhet" },
  { "label": "BRF Gustafshög 1",   "url": "https://www.booli.se/bostadsrattsforening/269946" }
]
```

> Schema note (Plan 03 Task 3): model `breadcrumbs` as `{ label?: string; url?: string }[] | null` — the two keys are confirmed; keep them optional + the array nullable for partial-data tolerance.

### `areaId` resolution mechanism

- **areaId is embedded in the breadcrumb `url`** as the `areaIds=<N>` query param. Parse with `/areaIds=(\d+)/`.
- The **final** breadcrumb is the BRF, whose url is `/bostadsrattsforening/<brfId>` (no `areaIds` param) — gives a building/BRF identifier.
- Resulting **tier ladder** for D-01 (wide → narrow), verified end-to-end (slutpriser succeeds at the narrow tier `99898` → 35 comps/totalCount 330, and the kommun tier `76` → 35 comps):

  | tier | label | areaId | source |
  |---|---|---|---|
  | län (wide) | Stockholms län | 2 | `areaIds=2` |
  | kommun | Nacka kommun | 76 | `areaIds=76` |
  | neighborhood | Fabrikörvägen | 99898 | `areaIds=99898` |
  | building | BRF Gustafshög 1 | — | `/bostadsrattsforening/269946` |

- **NOTE — breadcrumbs come from the DETAIL page, not the SERP.** SERP (`/sok/till-salu` search-results) `Listing` objects do **not** carry the `breadcrumbs` array — the ladder must come from the listing **detail page** (`/annons/<id>`) or be reconstructed from the active-listing actor (which already returns `breadcrumbs`). The join from a listing → its area comps is mechanical: parse `breadcrumbs[i].url` → GET `/sok/slutpriser?areaIds=<that id>`.
- These are **Booli internal areaIds**, NOT SCB region codes (Booli kommun areaId `76` ≠ SCB kommun code). SCB geography is resolved independently from `latitude`/`longitude` (see §3).
- `latitude`/`longitude`/`booliId` are present per item — the join key for both panels and the input to `resolveGeo`.

---

## 3. SCB income/tenure DeSO-availability probe (A3 [ASSUMED] → RESOLVED)

SCB PxWebApi is free / no-auth (reconfirmed). Probed live this session against a real DeSO. **kommun code = DeSO prefix first 4 chars** (e.g. `0180`).

| Metric | Table | DeSO-available? | Latest year | Notes |
|--------|-------|-----------------|-------------|-------|
| Population (+ age/kön) | `BE/BE0101/BE0101Y/FolkmDesoAldKon` | **YES** | **2025** | Verified live (HTTP 200, json-stat2). Control case + Task 2 fixture source. |
| Income | `HE/HE0110/HE0110I/Tab1InkDesoRegso` | **YES** | **2024** | Region var includes DeSO codes; live query at a DeSO returned 200. Income **lags one year**. Tab2/Tab3 variants also DeSO. |
| Tenure (upplåtelseform) | `HE/HE0111/HE0111YDeSo/HushallT33Deso` | **YES** | **2025** | "Antal personer efter region och upplåtelseform" — `äganderätt, bostadsrätt, hyresrätt, uppgift saknas, totalt`. Live query at DeSO returned 200. |

### A3 resolution for AREA-01 (honest expectation)

- **All three metrics are DeSO-available** — Plans 03/05/06 treat DeSO four-metric data as the normal path. No metric is forced to a kommun-only fallback.
- **Caveat — income lags one year** (2024 vs population/tenure 2025). The normalizer/UI must NOT assume a single uniform "latest year" across metrics — query each metric's own latest year. The `scb.test.ts` metric-absent / year-mismatch case (Task 2) covers "income year ≠ population year".
- **Region-code pitfall (RESEARCH Pitfall 2):** the SSD DeSO region value carries a year suffix `_DeSO2025` (e.g. `0180C1010_DeSO2025`); the bare-DeSO form differs by table. `resolveGeo` must produce the exact region string the chosen table expects (validate against the table's `Region` value list before querying).

### Captured SCB fixture

The **population** json-stat2 capture is committed as `src/lib/market/__fixtures__/scb-population.json` (the `scb.test.ts` offline fixture) in Task 2.

---

## 4. Sold-comps fixture (REAL, redacted)

`src/lib/market/__fixtures__/sold-comps.json` — a **real** 35-comp payload captured from `/sok/slutpriser?areaIds=76` (Nacka) via the working transport, in the raw `__APOLLO_STATE__` `SoldProperty:<id>` shape + one `Area_V3:76` context object.

- **Retained:** `soldPrice.raw`, `listPrice`, `soldPriceAbsoluteDiff`, `soldPricePercentageDiff.raw`, `soldDate`, `objectType`, `daysActive`, `displayAttributes.dataPoints` (m²/rooms/tomt/kr-m²).
- **Redacted/scrubbed (T-03-01):** `streetAddress`, `location`, `latitude`, `longitude`, `url`, `images`, `descriptiveAreaName`; `screenReaderLabel` street name+number stripped. No PII, no exact addresses.
- One record carries a **null `soldPrice.raw`** to exercise the null-tolerant normalizer + the areaAvg-guard test cases (Plan 04 + the Plan 01 compare RED tests).

---

## 5. Monitored risks

1. **Sparse-locality freshness thinning (medium, mitigated).** Narrow `userDefined` localities (e.g. Hällesåker, totalCount 649) return a full page but reach back ~17 months. A recent-window comparison at that granularity uses stale comps unless **D-01 walks up to the kommun tier when recent-comp count is low**. Mitigation already designed — trigger on **recency + count**, not totalCount. (Worth a confirming probe on one named rural *kommun* before relying on street-level data in rural markets.)
2. **CF posture / transport fragility (low today, monitor).** The whole source depends on `apify/playwright-scraper` continuing to clear Cloudflare via RESIDENTIAL/SE. 100% reliable this session (one transient proxy tunnel error self-healed on retry). Risk is future-tense: Booli could tighten CF on the HTML pages as they did on `/graphql`. **Mitigation:** keep `maxRequestRetries >= 1`, **alert on `hasApollo === false` / non-200**, and cache aggressively so a transport outage degrades gracefully (kommun-baseline / "prisjämförelse ej tillgänglig") rather than failing every analysis.

### Documented (not-built) fallbacks

- **No-CSP browser bookmarklet** — when a real user has a sold page open, CF is already cleared and the served page carries **no CSP**, so injected JS can read `__NEXT_DATA__` from the DOM and POST the comps to our API (genuine-human read). An extension is not required.
- **Web Unlocker** (Bright Data / Scrapfly) — a paid CF-solving/anti-bot service as a transport swap if Apify Playwright stops clearing CF.
- **Asking-price complement** — `/sok/till-salu?areaIds=<N>` `listSqmPrice` ("utgångspris", clearly labelled) as a free interim/secondary signal alongside slutpriser.

---

## 6. Secrets / config posture

- No secret values are written into this file or any committed fixture (T-03-01). The SSR-HTML path is keyless.
- Only `APIFY_API_TOKEN` (already configured, Phase 1) is involved — as the Apify Playwright transport + RESIDENTIAL/SE proxy. The Apify proxy password (distinct from the API token) is fetched at runtime and **never** persisted.
- No new env var needed. No `next.config.ts serverExternalPackages` change needed (native fetch / existing apify-client).

---

## Appendix — full active-item key list (captured)

`agencyId, agencyListingUrl, agencyName, agencyThumbnail, agentId, amenities, booliId, breadcrumbs, constructionYear, descriptiveAreaName, estimate, id, images, infoPoints, isNewConstruction, latitude, listEstimatedPrice, listPrice, listRent, listSqmPrice, livingArea, longitude, objectType, price, primaryImageUrl, propertyType, published, rent, rooms, streetAddress, targeting, tenureForm, title, upcomingSale, url`

`infoPoints` includes floor (`"våning 5 av 5 med hiss"`), avgift (`"4 990 kr/mån"`), driftskostnad, energiklass — bonus attributes per D-03 if a sold source ever exposes equivalents.
