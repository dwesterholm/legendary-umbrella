/**
 * area-suggestion-page-function.ts — the area-name → Booli-`areaId` resolver's
 * browser-side interaction. Replaces the old `area-search-page-function.ts`
 * (which drove the search box via DOM clicks + `page.url()` capture and broke
 * when Booli's search page stopped SSRing Apollo state — live-confirmed
 * 2026-07-09: `hasApollo=false` for every name).
 *
 * How it works (live-reverse-engineered 2026-07-09): Booli's own search box
 * calls a Cloudflare-gated persisted-query GraphQL operation
 * `areaSuggestionSearch` (GET `/graphql?operationName=areaSuggestionSearch&
 * variables={"search":"<name>"}&extensions={persistedQuery:{sha256Hash:...}}`)
 * and renders the resulting suggestion dropdown. A bare server-side fetch of
 * that endpoint is 403'd by Cloudflare (even from inside the headless browser),
 * so this page-function does NOT fetch it directly. Instead it:
 *
 *   1. Reads the free-text query the caller embedded in the start URL
 *      (`?areaQuery=<name>` — a harmless param Booli's page ignores; read back
 *      out of `request.url` inside the browser, never sent as a real Booli
 *      search param).
 *   2. Registers a `page.on("response")` listener for `areaSuggestionSearch`
 *      BEFORE typing, so Booli's OWN Apollo client makes the request (with the
 *      correct headers + established Cloudflare clearance) and we simply read
 *      the JSON it already fetched.
 *   3. Injects the query into the `#area-search-field` input using React's
 *      native value setter + a bubbling `input` event — NOT pointer clicks —
 *      so the cookie-consent overlay (Didomi) that intercepts pointer events is
 *      irrelevant, and NO consent is recorded (privacy-preserving).
 *   4. Polls briefly for the intercepted response and returns its
 *      `suggestions` array.
 *
 * Contract: returns `{ hasApollo: true, suggestions }` (satisfying
 * `runPlaywrightRender`'s `hasApollo !== false` "usable item" filter). Never
 * throws inside the page function — a missing field, a consent wall that
 * changes shape, or a suggestion request that never fires all resolve to
 * `{ hasApollo: true, suggestions: [] }`, which the caller (`resolve-area.ts`)
 * treats as a probe miss and falls back to the static seed list.
 */

/** RESEARCH-observed selector for Booli's free-text area search input (live 2026-07-09). */
export const AREA_SEARCH_FIELD_SELECTOR = "#area-search-field";

/** One entry from `areaSuggestionSearch.suggestions` (fields we consume). */
export interface AreaSuggestion {
  /** The opaque Booli areaId — the value we ultimately resolve to. */
  id: string;
  /** Machine type, e.g. "SubAdministrativeArea" | "userDefined" | "Street". */
  type: string;
  /** Human type shown in the dropdown, e.g. "Stadsdel" | "Område" | "Gata". */
  typeDisplayName: string;
  /** The matched area's display name, e.g. "Vasastan". */
  displayName: string;
  /** The parent municipality name, e.g. "Stockholm". */
  parent: string;
  /** The parent municipality's areaId, e.g. "1" for Stockholm kommun. */
  parentId: string;
  /** The parent municipality's display name, e.g. "Stockholms kommun". */
  parentDisplayName: string;
}

/**
 * `AREA_SUGGESTION_PAGE_FUNCTION` — a serialized `async function
 * pageFunction(context)` string sent to `apify/playwright-scraper` via
 * `runPlaywrightRender` (same transport primitive as the Apollo extractor).
 * See the file-level doc comment for the full mechanism.
 */
export const AREA_SUGGESTION_PAGE_FUNCTION = `async function pageFunction(context){
  const { page, request } = context;

  let term = "";
  try { term = new URL(request.url).searchParams.get("areaQuery") || ""; } catch (e) {}
  if (!term) return { hasApollo: true, suggestions: [] };

  // Capture Booli's OWN areaSuggestionSearch responses (its Apollo client has
  // the correct headers + Cloudflare clearance — a bare fetch is 403'd).
  const captured = [];
  page.on('response', async (resp) => {
    try {
      const u = resp.url();
      if (u.indexOf('areaSuggestionSearch') === -1) return;
      const j = await resp.json();
      const res = j && j.data && j.data.areaSuggestionSearch;
      if (res && Array.isArray(res.suggestions)) {
        captured.push({ query: res.query || '', suggestions: res.suggestions });
      }
    } catch (e) {}
  });

  try {
    await page.waitForSelector('${AREA_SEARCH_FIELD_SELECTOR}', { timeout: 20000 });
    // Inject via React's native setter + input event (no pointer events → the
    // Didomi consent overlay is irrelevant and no consent is recorded).
    await page.evaluate((t) => {
      const el = document.querySelector('${AREA_SEARCH_FIELD_SELECTOR}');
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(el, t);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, term);
    // Poll for the debounced suggestion response (up to ~9s).
    for (let i = 0; i < 30 && captured.length === 0; i++) {
      await page.waitForTimeout(300);
    }
  } catch (e) {
    return { hasApollo: true, suggestions: [] };
  }

  // Prefer the response whose echoed query matches our term; else the last one.
  let suggestions = [];
  for (const c of captured) {
    if (c.query && c.query.toLowerCase() === term.toLowerCase()) suggestions = c.suggestions;
  }
  if (!suggestions.length && captured.length) suggestions = captured[captured.length - 1].suggestions;

  return { hasApollo: true, suggestions };
}`;
