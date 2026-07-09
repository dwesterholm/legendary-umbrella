import { ApifyClient } from "apify-client";

/**
 * booli-listing-probe.ts — ONE-OFF narrow-confirmation script (05-02-PLAN.md Task 1).
 *
 * NOT wired into the app. Run manually, once, by the operator at the Task 2
 * checkpoint against a single real, currently-active Booli listing URL:
 *
 *   APIFY_API_TOKEN=$APIFY_API_TOKEN npx tsx scripts/booli-listing-probe.ts "https://www.booli.se/bostad/<id>"
 *
 * Purpose (05-RESEARCH.md "The Narrow Confirmation"): the sold-comps transport
 * (src/lib/market/sold-source.ts) is already proven in production against the
 * slutpriser SSR page. This script reproduces that EXACT transport verbatim
 * against a listing DETAIL page instead, to answer the one open question:
 * does the detail-page __APOLLO_STATE__ carry a `Listing:<booliId>`-shaped
 * entity (prefix assumed by analogy to the confirmed `SoldProperty:<id>`, but
 * NOT hardcoded here — this script pins the real prefix empirically) with the
 * same field set the paid actor (src/lib/apify/booli-scraper.ts) returns?
 *
 * T-05-03 (Information Disclosure — mitigate): this script NEVER logs
 * `process.env.APIFY_API_TOKEN` or the `ApifyClient` instance. Only run
 * status, dataset keys, and Apollo entity keys/values are logged.
 */

const client = new ApifyClient({
  token: process.env.APIFY_API_TOKEN!,
});

/** Same actor as sold-source.ts — the only transport proven to clear Cloudflare. */
const PLAYWRIGHT_SCRAPER_ACTOR = "apify/playwright-scraper";

/**
 * Verbatim copy of sold-source.ts's PAGE_FUNCTION (byte-for-byte — do not
 * modify). Reads the SSR __NEXT_DATA__ blob and returns its __APOLLO_STATE__
 * plus a hasApollo health flag.
 */
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

/**
 * The parity field list from 05-RESEARCH.md's "The Narrow Confirmation"
 * section — the paid actor's field set to diff the detail-page Apollo entity
 * against, field-by-field.
 */
const PARITY_FIELDS = [
  "agencyId",
  "agencyListingUrl",
  "agencyName",
  "booliId",
  "breadcrumbs",
  "constructionYear",
  "descriptiveAreaName",
  "estimate",
  "id",
  "infoPoints",
  "isNewConstruction",
  "latitude",
  "listEstimatedPrice",
  "listPrice",
  "listRent",
  "listSqmPrice",
  "livingArea",
  "longitude",
  "objectType",
  "price",
  "propertyType",
  "rent",
  "rooms",
  "streetAddress",
  "tenureForm",
  "title",
  "url",
] as const;

/**
 * The required-display fields analyze.ts tracks (the escalation trigger).
 * Each ENTRY is a requirement; an entry with multiple field names is satisfied
 * if ANY of them is present (price/listPrice is an OR — `normalizeScraperOutput`
 * resolves `num(price) ?? rawOf(listPrice)`, so for an active/unsold listing the
 * asking price legitimately comes from listPrice and `price` is expected absent).
 */
const REQUIRED_DISPLAY_FIELDS: readonly (readonly string[])[] = [
  ["streetAddress"],
  ["price", "listPrice"],
  ["livingArea"],
  ["rooms"],
] as const;

type ApolloState = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Prints every top-level Apollo key that STARTS WITH "Listing:" (the assumed
 * prefix by analogy to the confirmed SoldProperty:<id> pattern) so the
 * operator can visually confirm — or correct — the real prefix. Does not
 * assume the prefix is right; it just highlights the candidates alongside
 * the FULL key list so a different real prefix (e.g. "Property:") is
 * immediately visible too.
 */
function reportTopLevelKeys(apollo: ApolloState): string[] {
  const allKeys = Object.keys(apollo);
  console.log(`\n=== All __APOLLO_STATE__ top-level keys (${allKeys.length} total) ===`);
  for (const key of allKeys) {
    console.log(`  ${key}`);
  }

  const candidatePrefix = "Listing:";
  const candidates = allKeys.filter((k) => k.startsWith(candidatePrefix));
  console.log(
    `\n=== Keys starting with candidate prefix "${candidatePrefix}" (${candidates.length} found) ===`,
  );
  if (candidates.length === 0) {
    console.log(
      `  NONE. The assumed "${candidatePrefix}" prefix does NOT match any key above.`,
    );
    console.log(
      "  Inspect the full key list above to identify the real entity typename for this listing.",
    );
  } else {
    for (const key of candidates) {
      console.log(`  ${key}`);
    }
  }
  return candidates;
}

/** Prints the matched entity's own key set. */
function reportEntityKeys(entity: Record<string, unknown>, entityKey: string): string[] {
  const keys = Object.keys(entity);
  console.log(`\n=== Key set for matched entity "${entityKey}" (${keys.length} keys) ===`);
  for (const key of keys) {
    console.log(`  ${key}`);
  }
  return keys;
}

/**
 * Field-by-field parity diff against PARITY_FIELDS. Classifies each field as
 * present / present-but-differently-shaped / absent. "Differently shaped"
 * covers null values and empty-string/empty-array placeholders that are
 * technically present as keys but carry no usable data.
 */
function reportParityDiff(entity: Record<string, unknown>): void {
  console.log(`\n=== Field-parity diff vs 05-RESEARCH.md parity field list ===`);
  const rows: { field: string; status: string; note: string }[] = [];

  for (const field of PARITY_FIELDS) {
    const hasKey = Object.prototype.hasOwnProperty.call(entity, field);
    if (!hasKey) {
      rows.push({ field, status: "ABSENT", note: "key not present on entity" });
      continue;
    }
    const value = entity[field];
    if (value === null || value === undefined) {
      rows.push({ field, status: "DIFFERENT", note: "key present but value is null/undefined" });
    } else if (typeof value === "string" && value.trim() === "") {
      rows.push({ field, status: "DIFFERENT", note: "key present but empty string" });
    } else if (Array.isArray(value) && value.length === 0) {
      rows.push({ field, status: "DIFFERENT", note: "key present but empty array" });
    } else if (isPlainObject(value) && Object.keys(value).length === 0) {
      rows.push({ field, status: "DIFFERENT", note: "key present but empty object" });
    } else {
      rows.push({ field, status: "PRESENT", note: typeof value });
    }
  }

  const width = Math.max(...PARITY_FIELDS.map((f) => f.length));
  for (const row of rows) {
    console.log(`  ${row.field.padEnd(width)}  ${row.status.padEnd(9)}  ${row.note}`);
  }

  console.log(`\n=== Required display fields (escalation trigger — price/listPrice is an OR) ===`);
  const satisfied = (names: readonly string[]) =>
    names.some((n) => rows.find((r) => r.field === n)?.status === "PRESENT");
  for (const group of REQUIRED_DISPLAY_FIELDS) {
    const label = group.join("/");
    console.log(`  ${label.padEnd(width)}  ${satisfied(group) ? "SATISFIED" : "MISSING"}`);
  }
  const missingRequired = REQUIRED_DISPLAY_FIELDS.filter((g) => !satisfied(g)).map((g) => g.join("/"));
  if (missingRequired.length > 0) {
    console.log(
      `\n  ESCALATION TRIGGER: required display requirement(s) unmet: ${missingRequired.join(", ")}`,
    );
    console.log(
      "  Per 05-RESEARCH.md: do NOT ship owned fetchListing as the DEFAULT ACQ-01 path.",
    );
  } else {
    console.log(`\n  GO: all required display requirements satisfied (price via price OR listPrice).`);
  }
}

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) {
    console.error(
      'Usage: npx tsx scripts/booli-listing-probe.ts "https://www.booli.se/bostad/<id>"',
    );
    process.exitCode = 1;
    return;
  }
  if (!url.includes("booli.se/")) {
    console.error(`Refusing to probe a non-booli.se URL: ${url}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Starting playwright-scraper run against: ${url}`);
  console.log("(cold start can take ~60s; total run typically ~20-60s)");

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

  console.log(`\nRun status: ${run.status}`);
  if (run.status !== "SUCCEEDED") {
    console.error(`Run did not succeed (status: ${run.status}). Aborting probe.`);
    process.exitCode = 1;
    return;
  }

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  if (!items.length) {
    console.error("No dataset items returned. Aborting probe.");
    process.exitCode = 1;
    return;
  }

  const first = items[0] as { hasApollo?: boolean; __APOLLO_STATE__?: unknown };
  console.log(`hasApollo: ${first.hasApollo}`);
  if (!first.hasApollo || !isPlainObject(first.__APOLLO_STATE__)) {
    console.error("hasApollo is false or __APOLLO_STATE__ is not an object. Aborting probe.");
    process.exitCode = 1;
    return;
  }

  const apollo = first.__APOLLO_STATE__;
  const candidates = reportTopLevelKeys(apollo);

  if (candidates.length === 0) {
    console.log(
      "\nNo entity matched the candidate prefix — inspect the full key list above manually" +
        " to find the real listing entity, then re-run analysis on it by hand.",
    );
    return;
  }

  // Use the first matching candidate as the entity to diff. If there are
  // multiple (unexpected), print all of them so the operator can decide.
  if (candidates.length > 1) {
    console.log(
      `\nNOTE: ${candidates.length} entities matched the candidate prefix. Diffing the first` +
        " one; inspect the others manually if needed.",
    );
  }
  const entityKey = candidates[0];
  const entity = apollo[entityKey];
  if (!isPlainObject(entity)) {
    console.error(`Entity "${entityKey}" is not an object; cannot diff. Aborting.`);
    process.exitCode = 1;
    return;
  }

  reportEntityKeys(entity, entityKey);
  reportParityDiff(entity);

  // 05-02-PLAN.md Task 1: "Write the matched raw entity to a temp path the
  // checkpoint task will redact." Write the raw matched Listing entity to a
  // git-ignored temp path so the orchestrator can redact PII and commit the
  // clean fixture at src/lib/booli/__fixtures__/listing-detail.json.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const rawPath = path.resolve("src/lib/booli/__fixtures__/listing-detail.raw.json");
  fs.mkdirSync(path.dirname(rawPath), { recursive: true });
  fs.writeFileSync(rawPath, JSON.stringify(entity, null, 2) + "\n");
  console.log(
    `\nRaw matched entity written to (git-ignored, redact before committing):\n  ${rawPath}\n` +
      "The orchestrator will redact PII and commit src/lib/booli/__fixtures__/listing-detail.json.",
  );
}

main().catch((error) => {
  // Log the real error server-side; never log the token or the client instance.
  console.error("[booli-listing-probe]", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
