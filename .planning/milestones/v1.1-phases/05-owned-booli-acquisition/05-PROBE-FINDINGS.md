# 05-02 Narrow-Confirmation Probe — Findings

**Run:** 2026-07-06 (operator live probe via `scripts/booli-listing-probe.ts`)
**Listing probed:** `https://www.booli.se/bostad/305443` → Apollo entity `Listing:4463691`
**Transport:** `apify/playwright-scraper` (chromium) + RESIDENTIAL/SE — the proven `sold-source.ts` recipe, verbatim
**Result:** Run `SUCCEEDED`, `hasApollo: true`, ~17s. Cloudflare cleared on the **detail page** exactly as on the slutpriser page. 73 top-level `__APOLLO_STATE__` keys.

## Pinned fact — Apollo key prefix

**`Listing:` — CONFIRMED.** Exactly one matching entity (`Listing:4463691`), matching the assumed prefix (by analogy to the confirmed `SoldProperty:<id>`). Plan 04's `fetchListing` prefix scan uses `Listing:`.

## GO / NO-GO — **GO** (ship owned `fetchListing` as the default ACQ-01 path)

The probe script's first pass mechanically flagged NO-GO because the literal key `price` is absent. **That is a false trigger.** The required "price" field is a **`price` OR `listPrice`** requirement:
- `listPrice` **is present** (the asking price / utgångspris — the correct price for an *active, unsold* listing).
- `price` (the realized sale price) is **expected to be absent** for an unsold listing — it only appears on sold objects.
- `normalizeScraperOutput` already resolves `num(raw.price) ?? rawOf(raw.listPrice)`, so the normalized listing takes its price from `listPrice` with zero code change (the "no-op migration" contract holds).

The probe script was corrected (commit `c3d71db`) to treat price/listPrice as an OR; a re-run now reports GO.

### Required display requirements

| Requirement | Satisfied by | Status |
|-------------|--------------|--------|
| streetAddress | `streetAddress` | ✅ SATISFIED |
| price / listPrice | `listPrice` (present; `price` expected-absent for active listing) | ✅ SATISFIED |
| livingArea | `livingArea` | ✅ SATISFIED |
| rooms | `rooms` | ✅ SATISFIED |

→ **All four satisfied → GO.**

## Field-parity vs the paid actor (05-RESEARCH.md list)

**PRESENT** on the detail-page `Listing:` entity: `agencyId, booliId, breadcrumbs, constructionYear, descriptiveAreaName, estimate, id, isNewConstruction, latitude, listPrice, listSqmPrice, livingArea, longitude, objectType, propertyType, rent, rooms, streetAddress, tenureForm, url`.

**ABSENT** (actor-synthesized conveniences or not-applicable to an active listing — none block us):
- `price` — realized sale price; absent for unsold listing (resolved via `listPrice`, see above).
- `title` — actor-synthesized; composable from `streetAddress` if needed.
- `listEstimatedPrice`, `listRent` — actor-derived; `estimate` and `rent` present instead.
- `agencyName`, `agencyListingUrl` — see Phase 6 note below.
- `infoPoints` — the actor's flattened string array; **superseded by richer structured fields** (see below).

## Bonus — the detail-page entity is RICHER than the paid actor

Several fields STATE.md recorded as *actor gaps* are present here as **structured fields** — better than the actor's flattened strings:
- **`floor`** — a real structured field (no more parsing "våning 5 av 5 med hiss" from an `infoPoints` string).
- **`amenities`** + top-level `Amenity:{"key":"balcony"}` → **balcony is detectable**.
- **`housingCoop`** (ref → `HousingCoop:82768`) + **`breadcrumbs`** → **BRF name recoverable**.
- **`rent`** (avgift), `operatingCost`, `constructionYear`, `buildingFloors`, `heating`, `images`, `estimate`, `listSqmPrice`, `priceInfo`, `salesOfResidence`, `displayAttributes({"queryContext":"PROPERTY_PAGE_LISTING"})`.

→ **This materially de-risks Phase 6 (999.2).** floor / balcony / BRF-name / avgift may be recoverable straight from the Phase-5 owned fetch, reducing (possibly eliminating) the need to follow through to broker pages for those fields.

## Phase 6 — broker link CONFIRMED present (better than the flag suggested)

The exact key `agencyListingUrl` is absent, but the broker link is present under a different name — and it's **inline, not a ref**:
- **`listingUrl`** = `https://www.husmanhagberg.se/objekt/annons/<objId>` — the **broker's own listing page URL**. This IS Phase 6's (999.2) hard dependency, just under a different key. Phase 6 uses `listingUrl` as the follow-through target.
- **`agency({"queryContext":"PROPERTY_PAGE_LISTING"})`** is inline and carries `{ name, thumbnail }` (the broker company + logo) — no extra fetch needed for broker identity.
- Also present: `agencyId`, `agentId`, `url` (Booli path), `relatedSearchUrl`.

→ **Phase 6's broker-page dependency is satisfied by `listingUrl`.** Combined with the structured `floor`/`amenities`/`housingCoop`/`rent` fields above, Phase 6 may reduce to: (a) read floor/balcony/BRF-name/avgift straight from the owned fetch, (b) follow `listingUrl` only for the fields still missing (renovation status, full description). Not a Phase-5 blocker; recorded for Phase 6 planning.

## Shape note for Plan 04 (`fetchListing`)

The detail-page `Listing:` entity's shape differs from the paid actor's flat object in places: arg-keyed fields (`displayAttributes({...})`, `agency({...})`), Apollo references (`housingCoop`, `images`, `areas`, `location`), and nested `priceInfo`/`salesOfResidence`. Plan 04's `fetchListing` is responsible for extracting/reshaping the `Listing:` entity into the actor-compatible flat shape **before** handing to `normalizeScraperOutput` (which stays unchanged — the no-op-migration claim is about `normalizeScraperOutput`, not about the raw source shape). Reuse the `dataPointsOf` deterministic-variant pattern for the arg-keyed fields.

## Fixture

Raw matched entity captured via the corrected probe (writes git-ignored `listing-detail.raw.json`); orchestrator redacts PII → commits `src/lib/booli/__fixtures__/listing-detail.json` for Plan 04's Apollo-extraction unit tests.
