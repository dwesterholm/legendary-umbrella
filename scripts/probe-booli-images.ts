import { runPlaywrightRender } from "../src/lib/booli/transport";
import { APOLLO_PAGE_FUNCTION } from "../src/lib/booli/page-functions";

/**
 * probe-booli-images.ts — ONE-OFF live-render probe (11-01-PLAN.md Task 1).
 *
 * NOT wired into the app; NOT a vitest test (it incurs a real Apify render —
 * a small, operator-approved spend, mirrors `scripts/booli-listing-probe.ts`'s
 * "run manually, once" posture). Run by the operator against ONE real active
 * Booli listing URL:
 *
 *   APIFY_API_TOKEN=$APIFY_API_TOKEN npx tsx scripts/probe-booli-images.ts "https://www.booli.se/annons/<a-real-active-listing-id>"
 *
 * Purpose (11-RESEARCH.md Open Question 1 / Assumptions A1-A2): confirm the
 * exact shape of the Apollo `images(`-prefixed ref on a real `Listing:<id>`
 * entity — specifically:
 *   (a) the exact per-image URL field name,
 *   (b) whether a floor-plan discriminator (a `type`/`category` field) exists,
 *   (c) whether the URLs are directly public/fetchable (no signed/session-
 *       scoped query params).
 *
 * This mirrors the "probe once against a live render, pin the shape in a doc
 * comment" precedent already used by `05-PROBE-FINDINGS.md` and this same
 * file's sibling `scripts/booli-listing-probe.ts` — reuses the SAME
 * transport (`runPlaywrightRender` + `APOLLO_PAGE_FUNCTION`) the production
 * `fetchListing` rung 1/2 already use; this script does NOT reimplement the
 * transport.
 *
 * DEFERRED (11-01 checkpoint pre-approval): this script is written and ready
 * but NOT run as part of Plan 11-01's execution — the operator runs it when
 * ready (small Apify spend, requires explicit go-ahead). Until then, Task 2's
 * `imageUrls` extractor is implemented against RESEARCH's assumed shape
 * (`Array<{ url?: string; type?: string }>`, Assumption A1/A2) with a
 * graceful, never-throwing fallback — see `src/lib/booli/client.ts`.
 *
 * Never logs `process.env.APIFY_API_TOKEN` or an ApifyClient/token instance —
 * only the resolved images( ref shape is printed.
 */

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) {
    console.error(
      'Usage: npx tsx scripts/probe-booli-images.ts "https://www.booli.se/annons/<a-real-active-listing-id>"',
    );
    process.exitCode = 1;
    return;
  }
  if (!url.includes("booli.se/")) {
    console.error(`Refusing to probe a non-booli.se URL: ${url}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Starting owned-transport render against: ${url}`);
  console.log("(cold start can take ~60s; total run typically ~20-60s)");

  const items = await runPlaywrightRender(url, APOLLO_PAGE_FUNCTION);

  const first = items[0] as { __APOLLO_STATE__?: unknown } | undefined;
  const apollo = first?.__APOLLO_STATE__;
  if (!apollo || typeof apollo !== "object") {
    console.error("No usable __APOLLO_STATE__ in the render result. Aborting probe.");
    process.exitCode = 1;
    return;
  }

  const state = apollo as Record<string, unknown>;
  const listingKey = Object.keys(state)
    .filter((k) => k.startsWith("Listing:"))
    .sort()[0];

  if (!listingKey) {
    console.error('No "Listing:" entity found in __APOLLO_STATE__. Aborting probe.');
    process.exitCode = 1;
    return;
  }

  const entry = state[listingKey] as Record<string, unknown>;
  console.log(`\nMatched entity: ${listingKey}`);

  // Same idiom as client.ts's argKeyedFieldOf(entry, "agency(") — find every
  // arg-keyed key starting with "images(" (there may be zero, one, or more
  // query-context variants, mirroring the existing displayAttributes(/agency(
  // precedent).
  const imagesKeys = Object.keys(entry)
    .filter((k) => k.startsWith("images("))
    .sort();

  console.log(`\n=== Arg-keyed "images(" fields found (${imagesKeys.length}) ===`);
  for (const key of imagesKeys) {
    console.log(`  ${key}`);
  }

  // Also surface a bare, non-arg-keyed "images" key if present (the redacted
  // fixture used by client.test.ts today carries exactly this shape: an array
  // of `{ __ref: "Image:<id>" }` Apollo refs, which would require a SECOND
  // resolve step against separate `Image:<id>` entities in the same
  // __APOLLO_STATE__ blob — a materially different shape than an arg-keyed
  // `images(` ref carrying inline url/type fields).
  const hasBareImagesKey = Object.prototype.hasOwnProperty.call(entry, "images");

  if (imagesKeys.length === 0) {
    console.log('\nNo arg-keyed "images(" field found on this entity.');
    if (hasBareImagesKey) {
      console.log(
        'A bare "images" key IS present — dumping it below. If it is an array of' +
          ' `{ __ref: "Image:<id>" }` refs, a second resolve step against those' +
          " Image: entities in __APOLLO_STATE__ is required; report this back so" +
          " the extractor can be adjusted (RESEARCH Assumption A1 would be WRONG" +
          " in this case).",
      );
      console.log(JSON.stringify(entry.images, null, 2));
      const bareImages = entry.images;
      if (Array.isArray(bareImages)) {
        const refKeys = bareImages
          .map((i) =>
            i && typeof i === "object" && "__ref" in i
              ? (i as { __ref: unknown }).__ref
              : null,
          )
          .filter((r): r is string => typeof r === "string");
        console.log(`\n=== Resolving ${refKeys.length} "Image:" refs from __APOLLO_STATE__ ===`);
        for (const refKey of refKeys) {
          const imageEntity = state[refKey];
          console.log(`\n-- ${refKey} --`);
          console.log(JSON.stringify(imageEntity, null, 2));
        }
      }
    } else {
      console.log('No bare "images" key either. Inspect the full entity key list below.');
      console.log(JSON.stringify(Object.keys(entry), null, 2));
    }
    return;
  }

  for (const key of imagesKeys) {
    console.log(`\n=== Raw value for "${key}" ===`);
    console.log(JSON.stringify(entry[key], null, 2));
  }

  console.log(
    "\nReport back: (a) the per-image URL field name, (b) whether a" +
      " floor-plan type/category discriminator is present, (c) whether the" +
      " URLs look directly public/fetchable (no signed/session query params).",
  );
}

main().catch((error) => {
  // Log the real error server-side; never log the token or client instance.
  console.error("[probe-booli-images]", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
