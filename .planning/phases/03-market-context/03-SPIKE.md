# Phase 3 — Wave 0 Spike: Sold-source feasibility + SCB DeSO-availability

**Run:** 2026-06-20 (executor, Plan 03-01 Task 1)
**Gate:** `checkpoint:human-verify` — human must approve the sold-source posture before Plan 04 builds against it.

---

## TL;DR / Decision

- **Sold-price source: BLOCKED in-session.** Every keyless transport for Booli's `searchSold` GraphQL was rejected by Cloudflare's **managed challenge** (HTTP 403 "Just a moment…") — including via the Apify SE residential proxy and via an in-browser page-context fetch on Apify Playwright (where Cloudflare clearance for the *page* exists but does **not** extend to the `/graphql` endpoint). No maintained **Booli** sold-prices actor exists in the Apify store (only **Hemnet** actors, which are out-of-scope per PROJECT.md). **No working sold source was confirmed.**
- **Mock fixture captured** (`src/lib/market/__fixtures__/sold-comps.json`) matching the documented `searchSold` result shape so Plan 04 can build the source-isolated interface + `normalizeSoldOutput` + `computePriceComparison` offline. **Shipping on the mock = PRICE-01-INCOMPLETE** (Plan 06 Task 3 live gate enforces this).
- **SCB (AREA-01): fully de-risked.** All three demographic metrics are **DeSO-available** (live-probed): population (2025), income (2024), tenure/upplåtelseform (2025). A3 [ASSUMED] is **RESOLVED — DeSO, not kommun-only**, for every metric.
- **Coordinates + breadcrumbs: confirmed available** at scrape time from the existing active-listing actor; the exact `breadcrumbs` shape and the `areaId` ladder are pinned below (drives Plan 04 D-01 tiering and Plan 03 Task 3 schema).
- **No new env vars.** No new runtime dependency from this spike. Only `APIFY_API_TOKEN` (already configured) is involved.

---

## 1. Sold-source feasibility — full probe matrix

The official Booli API is dead (now "Booli Pro", institution-only) — not a candidate. The primary path was the keyless `searchSold` GraphQL at `https://www.booli.se/graphql`. Tested in order; **all failed**.

| # | Transport | Endpoint / mechanism | Result | Evidence |
|---|-----------|----------------------|--------|----------|
| 1 | Direct `fetch`, minimal headers (`Content-Type` only) | `POST https://www.booli.se/graphql` | **403** Cloudflare "Just a moment…" | `server: cloudflare`, `cf-ray ...-ARN` |
| 1b | Direct `fetch`, full browser headers (UA, Origin, Referer, Accept-Language sv-SE) | same | **403** Cloudflare managed challenge | identical challenge HTML |
| 1c | Alternate host | `POST https://api.booli.se/graphql` | **404** (Apache, not the GraphQL host) | wrong endpoint — `www` is canonical |
| 3 | Apify **RESIDENTIAL / country-SE** proxy (undici `ProxyAgent`, correct proxy password) | `POST https://www.booli.se/graphql` | **403** Cloudflare managed challenge | `cf-ray ...-ARN` (Stockholm egress confirmed) |
| 3b | Apify `auto` proxy group | same | **403** | `cf-ray ...-LAX` (egress IP rotated, still challenged) |
| 4-store | Apify store search (`booli`, `slutpriser sweden`, `swedish sold property`) | — | **No Booli sold actor exists**; only Hemnet actors (out-of-scope) | store API search results |
| 4-pw | Apify `apify/playwright-scraper`, navigate `/sok/slutpriser`, then in-page `fetch('/graphql')` | Playwright + RESIDENTIAL/SE | **403** — the slutpriser page itself is CF-blocked (`Request blocked - received 403`), and `/graphql` returns its own managed challenge | run `l7fMbcEx1y2y1xh4i` |
| 4-pw2 | Playwright: navigate an **active for-sale detail** page (passes CF, title rendered), then in-page `fetch('/graphql')` from the cleared context | Playwright + RESIDENTIAL/SE | **403** — page cleared CF (title = real listing), but `/graphql` POST is independently managed-challenged | run `qwX3mlOEjX0hHPMOS`, `pageTitle` = real listing, `gqlStatus` 403 |

### Why it fails (root cause)
Booli's `/graphql` endpoint sits behind a **separate, stricter Cloudflare managed-challenge zone** than the for-sale HTML pages. Two facts prove this:
1. The Apify Playwright actor *successfully renders* an active for-sale detail page (Cloudflare clearance cookie present, page title correct) — yet a same-origin `POST /graphql` from that cleared browser context still returns the 403 "Just a moment…" challenge.
2. The OSS tools (`huset-priser`, `booli-mcp-cc`) that the research cited as proof predate Booli's current Cloudflare posture; the bare-`fetch` recipe they document no longer works from a datacenter/proxy IP.

A non-browser `POST` cannot solve a JS/Turnstile managed challenge regardless of IP reputation. Solving it would require a real challenge-solving browser session (e.g. a stealth headful browser that executes the challenge JS, or a paid CF-solving service) — **out of scope for this spike and a meaningful cost/ToS escalation**.

### What still worked (reconfirmed)
- The existing active-listing actor `bpf1JaYRBbia2nQU9` (lexis-solutions/booli-se-scraper) **does** pass Cloudflare for `/sok/till-salu` + `/bostad/` via its Playwright+RESIDENTIAL/SE setup — it returned a full active listing (run `HWRYgEBUeqov2fDmX`).
- Reconfirmed RESEARCH Finding 1: the same actor on a `/sok/slutpriser` URL returns **0 sold items** (run `CDpMcEE6NTnySVF0C`, "Blocked by Cloudflare" on the slutpriser route; its detail parser only understands the active DOM).

### Per-query cost
- Not applicable — no working sold transport was found, so no per-query cost is recorded.
- For reference, the active-listing actor (the only working Booli transport) runs ~50–60 s on RESIDENTIAL/SE proxy per call; if a future sold path reuses that infra the cost profile is "one Apify Playwright actor run per analysis", cacheable per area. This stays well under the <$100/month budget at MVP volumes, **but only matters once a sold transport actually works.**

---

## 2. areaId resolution + breadcrumbs shape (PINNED — drives Plan 04 D-01 tiering & Plan 03 Task 3 schema)

Captured live from the active-listing actor (run `HWRYgEBUeqov2fDmX`). The actor returns, per item:
`latitude, longitude, booliId, breadcrumbs, descriptiveAreaName, streetAddress, infoPoints, amenities, listSqmPrice, objectType, rooms, livingArea, …` (full key list in §appendix).

### `breadcrumbs` shape — confirmed
An **array** of `{ label: string; url: string }`, ordered **wide → narrow** (län → kommun → street/neighborhood → BRF):

```jsonc
[
  { "label": "Skåne län",               "url": "https://www.booli.se/sok/till-salu?areaIds=64&objectType=Lägenhet" },
  { "label": "Helsingborgs kommun",     "url": "https://www.booli.se/sok/till-salu?areaIds=88&objectType=Lägenhet" },
  { "label": "Hjälmshultsgatan",        "url": "https://www.booli.se/sok/till-salu?areaIds=102385&objectType=Lägenhet" },
  { "label": "BRF Hjälmshultsgatan 15", "url": "https://www.booli.se/bostadsrattsforening/268273" }
]
```

### `areaId` resolution mechanism
- **areaId is embedded in the breadcrumb `url`** as the `areaIds=<N>` query param. Parse with `/areaIds=(\d+)/`.
- The **final** breadcrumb is the BRF, whose url is `/bostadsrattsforening/<brfId>` (not an `areaIds` param) — gives a building/BRF identifier.
- Resulting **tier ladder** for D-01 (wide → narrow):

  | tier | label | id | source |
  |------|-------|----|--------|
  | wide | Skåne län | `64` | `areaIds=64` |
  | (kommun) | Helsingborgs kommun | `88` | `areaIds=88` |
  | neighborhood | Hjälmshultsgatan | `102385` | `areaIds=102385` |
  | building | BRF Hjälmshultsgatan 15 | `268273` | `/bostadsrattsforening/268273` |

  > NOTE: these are **Booli internal areaIds**, NOT SCB region codes. They are only useful for *Booli* area queries (i.e. a future sold source). SCB geography is resolved independently from `latitude`/`longitude` (see §3). The kommun areaId `88` ≠ SCB kommun code `1283` (Helsingborg).
- `latitude`/`longitude`/`booliId` are present per item (`56.056168 / 12.696509 / 6173463`) — the join key for both panels and the input to `resolveGeo`.

---

## 3. SCB income/tenure DeSO-availability probe (A3 [ASSUMED] → RESOLVED)

SCB PxWebApi is free / no-auth (reconfirmed). All probes live this session against a real Stockholm DeSO `0180C1010_DeSO2025` (or a Helsingborg-area DeSO where noted). **kommun code = DeSO prefix first 4 chars** (`0180`).

| Metric | Table | DeSO-available? | Latest year | Notes |
|--------|-------|-----------------|-------------|-------|
| Population (+ age/kön) | `BE/BE0101/BE0101Y/FolkmDesoAldKon` | **YES** | **2025** | Verified live (HTTP 200, json-stat2). Control case. |
| Income | `HE/HE0110/HE0110I/Tab1InkDesoRegso` | **YES** | **2024** | Region var = 19,182 values incl. DeSO codes; live data query at a true DeSO returned 200. Income **lags one year** behind population. Tab2/Tab3 variants also DeSO. |
| Tenure (upplåtelseform) | `HE/HE0111/HE0111YDeSo/HushallT33Deso` | **YES** | **2025** | "Antal personer efter region och upplåtelseform". Upplåtelseform values: `äganderätt, bostadsrätt, hyresrätt, uppgift saknas, totalt`. Live query at DeSO returned 200. |

### A3 resolution for AREA-01 (honest expectation)
- **All three metrics are DeSO-available** — Plans 03/05/06 can treat DeSO four-metric data as the normal path. No metric is forced to a kommun-only fallback.
- The only caveat: **income lags one year** (2024 vs population/tenure 2025). The normalizer/UI should not assume a single uniform "latest year" across metrics — query each metric's own latest year, and the `scb.test.ts` metric-absent / year-mismatch case (Task 2) should cover "income year ≠ population year".
- Region-code pitfall confirmed (RESEARCH Pitfall 2): the SSD DeSO region value carries a year suffix `_DeSO2025` (e.g. `0180C1010_DeSO2025`); the bare-DeSO form differs by table. `resolveGeo` must produce the exact region string the chosen table expects (validate against the table's `Region` value list before querying).

### Captured SCB fixtures
- `/tmp/scb-pop.json`, `/tmp/scb-income.json`, `/tmp/scb-tenure.json` were captured this session. The **population** json-stat2 capture will be committed as `src/lib/market/__fixtures__/scb-population.json` in Task 2 (the scb.test.ts offline fixture).

---

## 4. Sold-comps fixture (mock)

`src/lib/market/__fixtures__/sold-comps.json` — **MOCK**, synthetic values (no PII), matching the documented `searchSold` result shape:
`data.searchSold.totalCount` + `result[]` with `soldPrice.raw`, `soldSqmPrice.raw`, `soldDate`, `livingArea.raw`, `rooms.raw`. Includes one record with `null` price/sqmPrice to exercise the null-tolerant normalizer and the areaAvg-guard test cases.

---

## 5. Secrets / config posture

- No secret values are written into this file or any committed fixture (T-03-01).
- The `searchSold` path is keyless; only `APIFY_API_TOKEN` (already configured, Phase 1) is involved for any Apify transport. The Apify **proxy password** (distinct from the API token) was fetched at runtime via the Apify API for the proxy probe and **not** persisted anywhere.
- No new env var needed. No `next.config.ts serverExternalPackages` change needed (native fetch / existing apify-client).

---

## 6. Recommendation to the human (resume options)

The sold transport is the one genuine blocker. Options, in rough order of effort:

1. **Proceed with the mock fixture (recommended to keep Phase 3 moving).** Plan 04 builds the source-isolated `sold-source.ts` interface + `normalizeSoldOutput` + `computePriceComparison` against the mock; live wiring waits until a transport works. **PRICE-01 ships as INCOMPLETE** (Plan 06 Task 3 live gate keeps it honest — the panel shows "prisjämförelse ej tillgänglig" rather than fake numbers). AREA-01 ships fully (SCB is unblocked).
2. **Escalate the sold transport** (separate spike/backlog): a CF-managed-challenge solver — e.g. a stealth headful browser session that executes the challenge JS and reuses the `cf_clearance` cookie against `/graphql`, or a paid CF-solving/anti-bot service. This is a cost + ToS escalation beyond this spike; revisit the backlog "own Booli acquisition layer (GraphQL)" item (999.6) with this finding.
3. **Re-scope PRICE-01** to a Booli-native surface that the active actor *can* reach (the for-sale tier already passes CF) — e.g. compare against active *asking* pris/kvm in the same areaId tier as an interim signal, clearly labelled "utropspris, ej slutpris". Product decision.

---

## Appendix — full active-item key list (captured)
`agencyId, agencyListingUrl, agencyName, agencyThumbnail, agentId, amenities, booliId, breadcrumbs, constructionYear, descriptiveAreaName, estimate, id, images, infoPoints, isNewConstruction, latitude, listEstimatedPrice, listPrice, listRent, listSqmPrice, livingArea, longitude, objectType, price, primaryImageUrl, propertyType, published, rent, rooms, streetAddress, targeting, tenureForm, title, upcomingSale, url`

`infoPoints` includes floor (`"våning 5 av 5 med hiss"`), avgift (`"4 990 kr/mån"`), driftskostnad, energiklass — bonus attributes per D-03 if a sold source ever exposes equivalents.
