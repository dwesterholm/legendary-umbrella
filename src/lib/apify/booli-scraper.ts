import { ApifyClient } from "apify-client";

const client = new ApifyClient({
  token: process.env.APIFY_API_TOKEN!,
});

/**
 * Calls the Apify Booli scraper actor for a single listing URL.
 * Returns the first dataset item or throws a descriptive error.
 */
export async function scrapeBooli(url: string): Promise<Record<string, unknown>> {
  try {
    // Actor ID bpf1JaYRBbia2nQU9 = lexis-solutions/booli-se-scraper
    const run = await client.actor("bpf1JaYRBbia2nQU9").call(
      {
        startUrls: [{ url }],
        sort: "newest",
        maxItems: 1,
        proxyConfiguration: {
          useApifyProxy: true,
          apifyProxyGroups: ["RESIDENTIAL"],
          apifyProxyCountry: "SE",
        },
      },
      // Apify cold-start (image pull + container creation) can take ~60s BEFORE
      // crawling even begins; a tight 60s budget returned an empty dataset
      // mid-run and was misread as "no results". Give cold-starts ample headroom
      // — a warm run still returns as soon as it finishes, so this only raises
      // the ceiling, it does not slow the common case.
      { waitSecs: 240 }
    );

    // A non-SUCCEEDED run (still RUNNING at the wait ceiling, TIMED-OUT, FAILED,
    // ABORTED) is NOT "listing not found" — surface a distinct transient error so
    // the user is told to try again rather than that the listing does not exist.
    if (run.status !== "SUCCEEDED") {
      throw new Error(
        `Booli-skraparen blev inte klar i tid (status: ${run.status})`
      );
    }

    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    if (!items.length) {
      throw new Error("Inga resultat fran Booli-skraparen");
    }

    return items[0] as Record<string, unknown>;
  } catch (error) {
    // Log the real error server-side before mapping to a user-facing message
    console.error("[booli-scraper]", error);
    if (error instanceof Error && error.message.includes("Inga resultat")) {
      throw error;
    }
    throw new Error(
      "Kunde inte hamta data fran Booli. Kontrollera att lanken ar korrekt och forsok igen."
    );
  }
}
