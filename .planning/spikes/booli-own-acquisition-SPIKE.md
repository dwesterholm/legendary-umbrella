# Spike: Own the Booli acquisition layer (replace the paid Apify actor)

**Date:** 2026-06-20
**Trigger:** While correcting the Phase 3 sold-price path (official Booli API is dead → keyless `searchSold` GraphQL + Apify-residential-proxy fallback), the question arose: if Booli's GraphQL serves *sold* data, does it also serve the *active-listing* data we currently pay the Apify actor for? If so, one acquisition layer + one fallback tree could power the whole product, owned end-to-end.

**Scope:** Brief feasibility read only — NO code changed, NO live calls from our runtime. Deeper de-risking is deferred to ROADMAP backlog **Phase 999.6**.

---

## Finding 1 — Field parity is essentially complete (HIGH confidence)

A real `searchForSale` GraphQL response (`truedarkdev/booli-mcp-cc` → `example/searc_proprety_response.json`) contains the **same field names** we currently normalize from the Apify actor in `src/lib/schemas/listing.ts`:

| We normalize today (from actor) | Present in Booli GraphQL response |
|---|---|
| `streetAddress`, `descriptiveAreaName` | ✅ (+ `location.region.municipalityName`) |
| `price`, `listPrice`, `listSqmPrice`, `estimate` | ✅ (`{ raw, value, formatted, unit }` shape — identical to our `formattedValueSchema`) |
| `livingArea`, `rooms`, `objectType`, `tenureForm` | ✅ |
| `latitude`, `longitude`, `booliId`, `url` | ✅ (the coords/booliId we just started retaining in Phase 3) |
| `constructionYear` | partial — `isNewConstruction` present; exact year TBD |
| `monthlyFee`/`rent`, `brfName`, floor | same gaps as today (actor also lacks brfName/floor — see listing.ts:13) |

**Implication:** The Apify actor appears to be a thin wrapper over Booli's own GraphQL (the `{raw,value,formatted,unit}` value objects are Booli's GraphQL shape, not an actor invention). Moving to our own GraphQL fetch would lose **no** fields we have today, and would let us add metadata / richer fields over time as Daniel sees fit.

## Finding 2 — The transport story is identical to the sold-price spike (HIGH confidence)

Same endpoint family (`www.booli.se/graphql` / `api.booli.se/graphql`), keyless, behind Cloudflare. Same fallback tree applies: **direct from server → same call via the Apify SE residential proxy (existing `APIFY_API_TOKEN`) → paid actor**. So Phase 3's sold-source transport work is directly reusable for the active-listing path — one `booli-graphql` client could serve both.

## Finding 3 — The ONE real unknown: single-listing-by-URL retrieval (MEDIUM)

Our product flow is *paste one listing URL → that listing's data*. The MCP server explicitly notes **direct property lookup by ID is NOT supported** by the GraphQL queries they tried ("the API requires location-based searches with additional filters"). Booli's own listing detail page obviously fetches one listing somehow, so the candidates to confirm in the deeper spike are:
1. A **detail GraphQL query** the site uses on `/bostad/{id}` (the MCP author only built `searchForSale`/`searchLocations`, may simply not have found it), or
2. The listing detail page's embedded **`__NEXT_DATA__` / Apollo state** (fetch HTML through the proxy, extract the JSON — still JSON, not DOM scraping), or
3. `searchForSale` with tight filters + match on `booliId` (clunky but works).

This is the gating question for replacing the actor on the single-listing flow — and the main thing the thorough investigation must answer.

## Cost / strategic note

The actor subscription is ~$29/month + usage. We'd likely **keep Apify for the residential proxy** even after dropping the actor, so the saving is partial — but the real win is **ownership**: one acquisition layer, one fallback tree, freedom to enrich the data shape, and no dependency on a third-party actor's maintenance/availability.

## Recommendation

**Do NOT do this now.** Phase 3 depends on the actor working for active listings; swapping the core acquisition layer mid-milestone adds risk for no Phase-3 benefit. De-risk it deliberately as **Phase 999.6** (added to backlog), ideally *after* the Phase 3 sold-source spike has already proven the GraphQL+proxy transport in our runtime — that evidence carries straight over.
