/**
 * area-search-page-function.ts — the Wave-0 area-name-resolution probe's
 * browser-side interaction, a SIBLING to `page-functions.ts`'s
 * `APOLLO_PAGE_FUNCTION` (09-PATTERNS.md line 164), NOT a modification of it.
 * `APOLLO_PAGE_FUNCTION` is a PASSIVE Apollo-state scan; this page function is
 * ACTIVE — it types into Booli's own search box and clicks a suggestion,
 * because 09-RESEARCH.md (Pitfall 3, Open Question 1/4) found no documented
 * free-text area-resolution endpoint: `?q=<name>` on `/sok/till-salu` is
 * silently ignored (live-verified 2026-07-07), so the ONLY way to turn a
 * free-text place name into Booli's opaque `areaId` is to drive the same
 * search-box interaction a human user would.
 *
 * MEDIUM-confidence / UNVERIFIED-live (09-RESEARCH.md Assumptions Log A3):
 * the selector below (`#area-search-field`) is RESEARCH's live-observed field
 * id, but the exact interaction flow (debounced XHR-per-keystroke vs.
 * client-side dataset, suggestion-list markup, timing) has NOT been confirmed
 * against the live DOM. This plan (09-02) ships the probe CODE but the live
 * confirmation run is the Task 2 checkpoint (operator-approved Apify spend) —
 * see 09-02-SUMMARY.md "Operator Next Steps" for the exact run steps. If the
 * live run shows a different selector/flow, only this file (and the selector
 * constant below) need updating — `resolve-area.ts`'s probe-then-seed
 * branching contract does not change.
 *
 * If this interaction proves unreliable even after selector confirmation, the
 * static `area-seed.ts` fallback is the path that ships (see resolve-area.ts)
 * — this probe is deliberately NOT the only way to resolve an area.
 */

/** RESEARCH-observed selector for Booli's free-text area search input. */
export const AREA_SEARCH_FIELD_SELECTOR = "#area-search-field";

/**
 * `AREA_SEARCH_PAGE_FUNCTION` — a serialized `async function pageFunction(context)`
 * string sent to the `apify/playwright-scraper` actor (same transport primitive
 * as `APOLLO_PAGE_FUNCTION`, via `runPlaywrightRender`).
 *
 * Contract: navigates the already-loaded `/sok/till-salu` page (the actor's
 * `startUrls` entry — set by the caller, `resolve-area.ts`), reads the
 * free-text query the caller embedded in the URL (`?areaQuery=<name>`, a
 * harmless extra query param Booli's own page ignores — it is read back out
 * of `page.url()` inside the browser context, never sent as a real Booli
 * search param), types it into the search field, waits for the suggestion
 * list, clicks the first suggestion, then captures the resulting
 * `page.url()` (which Booli's own client-side navigation rewrites to carry
 * `areaIds=<N>` once a suggestion is chosen). Returns `{ hasApollo: true,
 * resolvedUrl }` so `runPlaywrightRender`'s existing "usable item" contract
 * (`hasApollo !== false`) is satisfied without changes to the transport.
 *
 * Never throws inside the page function itself — an unmatched selector or a
 * suggestion list that never appears resolves to `resolvedUrl: null`, and the
 * caller (`resolve-area.ts`) treats that as a probe miss, falling back to the
 * seed list rather than propagating a browser-side exception.
 */
export const AREA_SEARCH_PAGE_FUNCTION = `async function pageFunction(context) {
  const { page, request } = context;
  const SELECTOR = "${AREA_SEARCH_FIELD_SELECTOR}";

  function readAreaQuery() {
    try {
      const url = new URL(request.url);
      return url.searchParams.get("areaQuery") || "";
    } catch {
      return "";
    }
  }

  const query = readAreaQuery();
  if (!query) {
    return { hasApollo: false, resolvedUrl: null };
  }

  try {
    await page.waitForSelector(SELECTOR, { timeout: 15000 });
    await page.click(SELECTOR);
    await page.fill(SELECTOR, query);

    // Wait for a suggestion list item to render (debounced autocomplete).
    const suggestionSelector = "[role=\\"option\\"], li[data-testid*=\\"suggestion\\"], ul li a";
    await page.waitForSelector(suggestionSelector, { timeout: 15000 });

    await Promise.all([
      page.waitForNavigation({ timeout: 15000 }).catch(() => null),
      page.click(suggestionSelector),
    ]);

    const resolvedUrl = page.url();
    return { hasApollo: true, resolvedUrl };
  } catch {
    // Selector not found / suggestion never appeared / navigation never
    // fired — a probe miss, not a transport failure. Let the caller fall
    // back to the seed list rather than throwing here.
    return { hasApollo: false, resolvedUrl: null };
  }
}`;
