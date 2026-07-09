/**
 * page-functions.ts — the ONE shared Apollo-state extraction page function used
 * by every owned-transport Booli read (detail-page single-listing AND
 * area-search), per 05-RESEARCH.md Pattern 2.
 *
 * Booli server-renders its Apollo cache into every page's `__NEXT_DATA__`
 * script (`data.props.pageProps.__APOLLO_STATE__`) — this is the exact,
 * already-proven extraction body from `src/lib/market/sold-source.ts`'s
 * `PAGE_FUNCTION` (shipped, billing-verified in production). The extraction
 * logic itself never differs by page type: Next.js Pages Router SSR hydration
 * is uniform across page shapes on the same app, so the SAME string is sent to
 * the Apify actor for both the listing-detail page and the area/SERP page —
 * only the `startUrls` passed to `runPlaywrightRender` differ. Do NOT write
 * per-page-type variants of this string unless a probe proves the extraction
 * genuinely differs (05-RESEARCH.md Anti-Patterns).
 *
 * The caller (client.ts, Plan 04) is responsible for picking the right Apollo
 * entity typename prefix (`Listing:` vs `SoldProperty:`) out of the returned
 * `__APOLLO_STATE__` blob during normalization — this page function's only job
 * is "get me the whole Apollo blob," never "get me this one key."
 */
export const APOLLO_PAGE_FUNCTION = `async function pageFunction(context) {
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
