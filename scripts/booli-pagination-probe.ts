import { ApifyClient } from "apify-client";

/**
 * booli-pagination-probe.ts — ONE-OFF confirmation: does /sok/till-salu
 * truncate results across pages, and does `&page=N` fetch a DIFFERENT set?
 *
 * Renders page 1 and page 2 of an area's till-salu SSR page through the SAME
 * transport fetchAreaListings uses (apify/playwright-scraper, RESIDENTIAL/SE,
 * the shared __APOLLO_STATE__ page function), counts the `Listing:` entities on
 * each, and reports the overlap. If page 2 carries listings absent from page 1,
 * the current single-render fetchAreaListings is silently missing them.
 *
 *   APIFY_API_TOKEN=... npx tsx scripts/booli-pagination-probe.ts [areaId]
 *
 * Never logs the token. areaId defaults to 115341 (Södermalm).
 */

const client = new ApifyClient({ token: process.env.APIFY_API_TOKEN! });
const PLAYWRIGHT_SCRAPER_ACTOR = "apify/playwright-scraper";

const PAGE_FUNCTION = `async function pageFunction(context) {
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

async function listingIdsFor(url: string): Promise<string[]> {
  const run = await client.actor(PLAYWRIGHT_SCRAPER_ACTOR).call(
    {
      startUrls: [{ url }],
      launcher: "chromium",
      proxyConfiguration: {
        useApifyProxy: true,
        apifyProxyGroups: ["RESIDENTIAL"],
        apifyProxyCountry: "SE",
      },
      maxRequestRetries: 3,
      maxPagesPerCrawl: 1,
      pageFunction: PAGE_FUNCTION,
    },
    { waitSecs: 240 },
  );
  if (run.status !== "SUCCEEDED") throw new Error(`run status ${run.status} for ${url}`);
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  const first = items[0] as { __APOLLO_STATE__?: Record<string, unknown> } | undefined;
  const apollo = first?.__APOLLO_STATE__;
  if (!apollo || typeof apollo !== "object") throw new Error(`no apollo for ${url}`);
  return Object.keys(apollo)
    .filter((k) => k.startsWith("Listing:"))
    .map((k) => k.slice("Listing:".length));
}

async function main(): Promise<void> {
  const areaId = process.argv[2] ?? "115341";
  const base = `https://www.booli.se/sok/till-salu?areaIds=${areaId}`;
  const p1Url = base;
  const p2Url = `${base}&page=2`;

  console.log(`Probing pagination for areaId=${areaId}`);
  console.log(`  page 1: ${p1Url}`);
  console.log(`  page 2: ${p2Url}`);
  console.log("(each render ~20-60s)\n");

  const page1 = await listingIdsFor(p1Url);
  console.log(`PAGE 1: ${page1.length} Listing entities`);
  const page2 = await listingIdsFor(p2Url);
  console.log(`PAGE 2: ${page2.length} Listing entities`);

  const set1 = new Set(page1);
  const newOnPage2 = page2.filter((id) => !set1.has(id));
  const overlap = page2.filter((id) => set1.has(id));

  console.log(`\n=== RESULT ===`);
  console.log(`page1 count:        ${page1.length}`);
  console.log(`page2 count:        ${page2.length}`);
  console.log(`page2 NEW (not p1): ${newOnPage2.length}`);
  console.log(`page2 overlap p1:   ${overlap.length}`);
  if (page2.length === 0) {
    console.log(`\nVERDICT: page 2 empty → page 1 holds the whole set for this area (no truncation).`);
  } else if (newOnPage2.length === 0) {
    console.log(`\nVERDICT: page 2 identical to page 1 (&page=N ignored) → single render already complete.`);
  } else {
    console.log(
      `\nVERDICT: TRUNCATION CONFIRMED — page 2 has ${newOnPage2.length} listings page 1 never returned.` +
        ` fetchAreaListings is missing them. Page size ≈ ${page1.length}.`,
    );
  }
}

main().catch((error) => {
  console.error("[booli-pagination-probe]", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
