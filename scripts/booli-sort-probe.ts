import { ApifyClient } from "apify-client";

/**
 * booli-sort-probe.ts — ONE-OFF: discover Booli /sok/till-salu's SORT URL
 * parameter (so fetchAreaListings can request cheapest-first on page 1).
 *
 * Renders the area's till-salu page and dumps: (a) the sort control's options /
 * links (name + value/href) so we can read the exact param Booli uses, and (b)
 * the first listings' listPrice from __APOLLO_STATE__ so we can eyeball the
 * default order.
 *
 *   APIFY_API_TOKEN=... npx tsx scripts/booli-sort-probe.ts [areaId] [sortParam]
 *
 * Never logs the token. areaId defaults to 115341 (Södermalm). If a second arg
 * is given it is appended verbatim to the URL query (e.g. "sort=listPrice") to
 * TEST whether it re-orders the results.
 */

const client = new ApifyClient({ token: process.env.APIFY_API_TOKEN! });
const PLAYWRIGHT_SCRAPER_ACTOR = "apify/playwright-scraper";

// Extends the standard Apollo extractor with sort-UI + price-order capture.
const PAGE_FUNCTION = `async function pageFunction(context) {
  const { page } = context;
  const probe = await page.evaluate(() => {
    const el = document.getElementById("__NEXT_DATA__");
    let apollo = null;
    try { apollo = el && el.textContent ? JSON.parse(el.textContent)?.props?.pageProps?.__APOLLO_STATE__ ?? null : null; } catch {}

    // Sort UI: <select> options + any anchors whose text/href hints at sorting.
    const selects = [...document.querySelectorAll("select")].map((s) => ({
      name: s.name || s.id || null,
      options: [...s.options].map((o) => ({ text: (o.textContent || "").trim(), value: o.value })),
    }));
    const anchors = [...document.querySelectorAll("a")]
      .filter((a) => /sort|pris|billig|dyr/i.test(a.getAttribute("href") || "") || /pris|sortera/i.test((a.textContent || "")))
      .slice(0, 30)
      .map((a) => ({ text: (a.textContent || "").trim().slice(0, 40), href: a.getAttribute("href") }));

    // First listing prices, in DOM order, to eyeball the current ordering.
    const rawOf = (x) => (x && typeof x === "object" ? x.raw : (x ?? null)) ?? null;
    // Authoritative ordering: pull the ORDERED Listing refs out of the
    // searchForSale query result (not the mixed Apollo key order), then map each
    // to price + area + computed kr/m² so we can see the true sort.
    const prices = [];
    if (apollo && apollo.ROOT_QUERY) {
      const sfsKey = Object.keys(apollo.ROOT_QUERY).find(
        (k) => k.startsWith("searchForSale({") && k.indexOf("forceOnlyNewConstruction") === -1,
      );
      const refs = [];
      const walk = (x) => {
        if (!x || typeof x !== "object") return;
        if (Array.isArray(x)) { x.forEach(walk); return; }
        if (typeof x.__ref === "string" && x.__ref.startsWith("Listing:")) refs.push(x.__ref.slice(8));
        for (const k in x) walk(x[k]);
      };
      if (sfsKey) walk(apollo.ROOT_QUERY[sfsKey]);
      for (const id of refs.slice(0, 15)) {
        const e = apollo["Listing:" + id];
        const listPrice = e ? rawOf(e.listPrice) : null;
        const livingArea = e ? rawOf(e.livingArea) : null;
        const krPerSqm = listPrice && livingArea ? Math.round(listPrice / livingArea) : null;
        prices.push({ id, listPrice, livingArea, krPerSqm });
      }
    }
    // Apollo ROOT_QUERY field keys encode the search query's serialized args
    // (incl. any sort variable + its default value) — the reliable way to learn
    // the sort param without a client-side control in the DOM.
    const rootQueryFields = apollo && apollo.ROOT_QUERY ? Object.keys(apollo.ROOT_QUERY) : [];
    const topLevelKeys = apollo ? Object.keys(apollo).filter((k) => !k.startsWith("Listing:")).slice(0, 40) : [];

    return { url: location.href, selects, anchors, prices, rootQueryFields, topLevelKeys, listingCount: apollo ? Object.keys(apollo).filter((k)=>k.startsWith("Listing:")).length : 0 };
  });
  return probe;
}`;

async function main(): Promise<void> {
  const areaId = process.argv[2] ?? "115341";
  const sortParam = process.argv[3]; // optional, e.g. "sort=listPrice"
  let url = `https://www.booli.se/sok/till-salu?areaIds=${areaId}`;
  if (sortParam) url += `&${sortParam}`;

  console.log(`Probing sort UI for: ${url}\n(render ~20-60s)\n`);

  const run = await client.actor(PLAYWRIGHT_SCRAPER_ACTOR).call(
    {
      startUrls: [{ url }],
      launcher: "chromium",
      proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"], apifyProxyCountry: "SE" },
      maxRequestRetries: 3,
      maxPagesPerCrawl: 1,
      pageFunction: PAGE_FUNCTION,
    },
    { waitSecs: 240 },
  );
  if (run.status !== "SUCCEEDED") throw new Error(`run status ${run.status}`);
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  const p = items[0] as Record<string, unknown>;

  console.log("resolved url:", p.url);
  console.log("listingCount:", p.listingCount);
  console.log("\n=== Apollo ROOT_QUERY field signatures (look for a sort arg) ===");
  console.log(JSON.stringify(p.rootQueryFields, null, 2));
  console.log("\n=== other top-level Apollo keys ===");
  console.log(JSON.stringify(p.topLevelKeys, null, 2));
  console.log("\n=== SORT <select> controls ===");
  console.log(JSON.stringify(p.selects, null, 2));
  console.log("\n=== sort/price-ish anchors ===");
  console.log(JSON.stringify(p.anchors, null, 2));
  console.log("\n=== first listing prices (DOM/Apollo order) ===");
  console.log(JSON.stringify(p.prices, null, 2));
}

main().catch((error) => {
  console.error("[booli-sort-probe]", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
