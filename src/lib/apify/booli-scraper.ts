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
    const run = await client.actor("lexis-solutions/booli-se-scraper").call(
      { startUrls: [{ url }] },
      { waitSecs: 30 }
    );

    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    if (!items.length) {
      throw new Error("Inga resultat fran Booli-skraparen");
    }

    return items[0] as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Inga resultat")) {
      throw error;
    }
    throw new Error(
      "Kunde inte hamta data fran Booli. Kontrollera att lanken ar korrekt och forsok igen."
    );
  }
}
