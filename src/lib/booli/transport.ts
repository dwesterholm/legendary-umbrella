import { ApifyClient } from "apify-client";

/**
 * transport.ts — the ONE owned Apify actor-call core shared by every
 * `booli/` fallback rung and future page-shape read (05-RESEARCH.md Pattern
 * 1). This is now the ONLY module that instantiates `ApifyClient` for the
 * owned transport (05-PATTERNS.md Shared Patterns) — `client.ts` and
 * `fallback-tree.ts` call through `runPlaywrightRender`, they never
 * re-instantiate `ApifyClient` themselves.
 *
 * The actor config below reproduces `src/lib/market/sold-source.ts`'s
 * `fetchSoldComps()` actor-call block VERBATIM — every value (proxy group,
 * retry count, wait ceiling) is evidence-backed in production, not arbitrary:
 *  - `apify/playwright-scraper` (chromium) + RESIDENTIAL/SE proxy is the ONLY
 *    transport that clears Booli's Cloudflare challenge (a raw fetch, even
 *    proxy-routed, is 403'd — 03-SPIKE.md §1.2).
 *  - `maxRequestRetries: 3` — a single retry budget once produced a false
 *    negative (a 403 streak returned 0 items on retry budget 1; 3 absorbed
 *    it). Do NOT "clean up" this back down to 1 without separately
 *    re-proving a lower budget is safe (05-RESEARCH.md Anti-Patterns).
 *  - `waitSecs: 240` — Apify container cold-start (image pull + creation) can
 *    eat ~60s before crawling even begins; a warm run finishes fast, so this
 *    only raises the ceiling, it never slows a warm run down.
 *
 * HIGH-1 discipline (carried forward verbatim from sold-source.ts): a dead
 * source must be distinguishable from a genuinely-empty result. This function
 * NEVER returns `[]` to signal "the source is dead" — it throws instead, on
 * non-SUCCEEDED status, on an empty dataset, or when every item comes back
 * with `hasApollo === false`.
 *
 * Secret posture: `APIFY_API_TOKEN` is read from `process.env` only (never
 * `NEXT_PUBLIC_`) and is never logged or stringified. The catch block below
 * logs only the error object via `console.error("[booli-transport]", error)`,
 * then re-throws a Swedish, user-facing message — the raw error (and
 * certainly never the token or the `ApifyClient` instance) is never leaked.
 */

const client = new ApifyClient({
  token: process.env.APIFY_API_TOKEN!,
});

/** The Apify browser actor that clears Cloudflare on Booli's HTML pages. */
const PLAYWRIGHT_SCRAPER_ACTOR = "apify/playwright-scraper";

/**
 * Renders `url` through the owned Playwright transport and returns the usable
 * dataset items (each `{ hasApollo, __APOLLO_STATE__ }`, per `pageFunction`'s
 * contract). Throws — never returns an empty array — when the render fails,
 * the dataset is empty, or every item lacks a usable Apollo blob.
 *
 * @param url - the pre-validated Booli URL to render (the domain allowlist
 *   check is the CALLER's responsibility — see T-05-09 in 05-03-PLAN.md's
 *   threat model; this transport treats `url` as already validated).
 * @param pageFunction - the serialized browser-side extraction function sent
 *   to the actor (see `page-functions.ts` for the shared Apollo extractor).
 */
export async function runPlaywrightRender(
  url: string,
  pageFunction: string,
): Promise<unknown[]> {
  try {
    const run = await client.actor(PLAYWRIGHT_SCRAPER_ACTOR).call(
      {
        startUrls: [{ url }],
        launcher: "chromium",
        proxyConfiguration: {
          useApifyProxy: true,
          apifyProxyGroups: ["RESIDENTIAL"],
          apifyProxyCountry: "SE",
        },
        // proven necessary — a single 403 streak returned 0 items on retry
        // budget 1; sold-source.ts absorbed it with 3. Do not reduce.
        maxRequestRetries: 3,
        maxPagesPerCrawl: 1,
        pageFunction,
      },
      // cold-start headroom, proven necessary in booli-scraper.ts and
      // sold-source.ts — a warm run returns as soon as it finishes.
      { waitSecs: 240 },
    );

    // A non-SUCCEEDED run (still RUNNING at the wait ceiling, TIMED-OUT,
    // FAILED) is a TRANSIENT source failure, not a genuinely-empty result —
    // don't read a partial dataset and mislabel it. Throw distinguishably.
    if (run.status !== "SUCCEEDED") {
      throw new Error(`Booli-kallan blev inte klar i tid (status: ${run.status})`);
    }

    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    // A non-200 / blocked render yields no item or hasApollo=false. Either is
    // a SOURCE failure (HIGH-1) — throw, never return [] (which would be
    // indistinguishable from a genuinely empty result).
    if (!items.length) {
      throw new Error("Inga resultat fran Booli-kallan");
    }
    const usable = items.filter(
      (it) => (it as { hasApollo?: boolean }).hasApollo !== false,
    );
    if (!usable.length) {
      throw new Error("Booli-kallan returnerade ingen Apollo-data (hasApollo=false)");
    }

    return usable;
  } catch (error) {
    // Log the real error server-side before mapping to a user-facing message.
    // Never log process.env.APIFY_API_TOKEN or the ApifyClient instance.
    console.error("[booli-transport]", error);
    throw new Error(
      "Kunde inte hamta data fran Booli. Forsok igen.",
    );
  }
}
