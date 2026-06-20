import { ApifyClient } from "apify-client";

/**
 * sold-source.ts — the ONE source-isolating interface for sold-price (slutpriser)
 * comps. Nothing outside this file knows which source/transport is used, so a
 * future swap touches only this module (the SPIKE GATE — 03-PATTERNS.md §62-70).
 *
 * Chosen source (03-SPIKE.md, validated GO — this OVERTURNS the plan's original
 * "keyless GraphQL first" text):
 *  - Booli SERVER-RENDERS every comp into the page HTML as
 *    `__NEXT_DATA__ → props.pageProps.__APOLLO_STATE__ → SoldProperty:<id>`.
 *    We read that SSR Apollo blob, NOT the `/graphql` API — the `/graphql`
 *    endpoint sits behind a stricter, separate Cloudflare managed-challenge zone
 *    and a non-browser POST cannot solve it (03-SPIKE.md §1.1).
 *  - URL: `https://www.booli.se/sok/slutpriser?areaIds=<N>` (paginate `&page=N`,
 *    ~35 comps/page; optional `&objectType=Lägenhet|Villa`).
 *  - Transport (KEY nuance): a real headless browser is MANDATORY. A raw fetch —
 *    even via the Apify RESIDENTIAL/SE proxy — returns 403 `cf-mitigated:
 *    challenge`. Only `apify/playwright-scraper` (chromium) + RESIDENTIAL/SE
 *    proxy clears Cloudflare and returns 200 with full data. Keep
 *    `maxRequestRetries >= 1` (one transient proxy blip self-healed on retry 1).
 *
 * Secret posture (T-03-10): the SSR-HTML path is keyless. The only secret is
 * `APIFY_API_TOKEN` (Phase 1, server-only) — read from `process.env`, NEVER
 * `NEXT_PUBLIC_`. Mirrors the existing apify-client server-only pattern.
 *
 * HIGH-1 — a dead source must be distinguishable from a genuinely-thin area:
 * a fetch/parse failure or an unreachable source THROWS; it NEVER silently
 * returns `[]` (an empty array would be indistinguishable from a real sparse
 * area). Plan 05 catches the throw and sets `reason: "source_unavailable"`;
 * a real (possibly small) result is returned and Plan 05 sets `reason: "thin"`.
 */

const client = new ApifyClient({
  token: process.env.APIFY_API_TOKEN!,
});

/** The Apify browser actor that clears Cloudflare on the slutpriser HTML pages. */
const PLAYWRIGHT_SCRAPER_ACTOR = "apify/playwright-scraper";

/** D-01 tier the comps were drawn from. */
export type PriceTier = "building" | "neighborhood" | "wide";

/** A breadcrumb entry as returned by the active-listing actor (03-SPIKE.md §2). */
interface Breadcrumb {
  label?: string;
  url?: string;
}

export interface SoldSourceQuery {
  lat: number;
  lng: number;
  booliId: string | null;
  /** wide→narrow area ladder; each `url` carries `areaIds=<N>` (03-SPIKE.md §2). */
  breadcrumbs: Breadcrumb[] | null;
  tier: PriceTier;
  /** Optional Booli objectType filter ("Lägenhet" | "Villa" | …). */
  objectType?: string | null;
}

/**
 * Resolves the Booli `areaId` for the requested tier from the breadcrumb ladder.
 *
 * The ladder is ordered wide→narrow (län → kommun → neighborhood → BRF). The
 * areaId lives in each breadcrumb `url` as the `areaIds=<N>` query param
 * (03-SPIKE.md §2). The final BRF crumb has no `areaIds` param. We map:
 *  - "building"/"neighborhood" → the narrowest crumb that still carries an
 *    `areaIds` (a slutpriser query needs an areaId; the BRF id is not one).
 *  - "wide" → a broader crumb (the län/kommun end of the ladder).
 *
 * Returns null when no areaId can be resolved (caller throws — HIGH-1).
 */
function resolveAreaId(query: SoldSourceQuery): string | null {
  const crumbs = query.breadcrumbs ?? [];
  const ids: string[] = [];
  for (const crumb of crumbs) {
    const match = crumb?.url?.match(/areaIds=(\d+)/);
    if (match) ids.push(match[1]);
  }
  if (ids.length === 0) return null;

  // ids are wide→narrow (matches the breadcrumb order). Pick by tier.
  if (query.tier === "wide") {
    // Prefer the kommun-level id (second from the wide end) when present, else
    // the widest available.
    return ids[Math.min(1, ids.length - 1)] ?? ids[0];
  }
  // building / neighborhood → the narrowest area that still has an areaId.
  return ids[ids.length - 1];
}

/** Builds the slutpriser URL for an areaId (+ optional objectType filter). */
function buildSlutpriserUrl(areaId: string, objectType?: string | null): string {
  const params = new URLSearchParams({ areaIds: areaId });
  if (objectType) params.set("objectType", objectType);
  return `https://www.booli.se/sok/slutpriser?${params.toString()}`;
}

/**
 * The page function the Apify playwright-scraper runs IN the cleared browser
 * context: it reads the server-rendered `__NEXT_DATA__` script and returns the
 * embedded `__APOLLO_STATE__` (the SoldProperty:<id> map normalizeSoldOutput
 * parses) plus a `hasApollo` health flag (03-SPIKE.md monitored-risk: alert on
 * `hasApollo === false`). Serialized to the actor as a string.
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
 * Fetches the raw sold-comps payload for a listing's area, behind ONE interface.
 *
 * Resolves the Booli areaId from the breadcrumb ladder for the requested tier,
 * renders the slutpriser page through `apify/playwright-scraper` + RESIDENTIAL/SE
 * proxy (the only transport that clears Cloudflare — 03-SPIKE.md §1.2), and
 * returns the raw `__APOLLO_STATE__` payload (Plan 05 runs `normalizeSoldOutput`).
 *
 * HIGH-1: throws (Swedish user-facing message) on an unresolved areaId, an actor
 * failure, a non-200/empty render, or `hasApollo === false`. It NEVER silently
 * returns `[]` — a dead source must be distinguishable from a thin area. The real
 * error is logged server-side first; the raw error is never leaked to the user.
 *
 * @param query - resolved lat/lng + area ladder + tier (server-side only)
 * @returns the raw rendered payload(s) — `normalizeSoldOutput` parses them
 */
export async function fetchSoldComps(
  query: SoldSourceQuery,
): Promise<unknown[]> {
  const areaId = resolveAreaId(query);
  if (!areaId) {
    // No area to query — a structural gap, not a thin area. Surface it (HIGH-1).
    throw new Error(
      "Kunde inte hitta omradesinformation for bostaden. Prisjamforelse ar inte tillganglig.",
    );
  }

  const url = buildSlutpriserUrl(areaId, query.objectType);

  try {
    const run = await client.actor(PLAYWRIGHT_SCRAPER_ACTOR).call(
      {
        startUrls: [{ url }],
        launcher: "chromium",
        // A real browser is mandatory; the residential SE proxy alone is not
        // enough (a raw fetch through it is 403-challenged — 03-SPIKE.md §1.2).
        proxyConfiguration: {
          useApifyProxy: true,
          apifyProxyGroups: ["RESIDENTIAL"],
          apifyProxyCountry: "SE",
        },
        // One transient proxy/tunnel blip self-healed on retry 1 this session.
        maxRequestRetries: 1,
        maxPagesPerCrawl: 1,
        pageFunction: PAGE_FUNCTION,
      },
      { waitSecs: 90 },
    );

    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    // A non-200 / blocked render yields no item or hasApollo=false. Either is a
    // SOURCE failure (HIGH-1) — throw, never return [] (which would read as thin).
    if (!items.length) {
      throw new Error("Inga resultat fran sold-kallan");
    }
    const usable = items.filter(
      (it) => (it as { hasApollo?: boolean }).hasApollo !== false,
    );
    if (!usable.length) {
      throw new Error("Sold-kallan returnerade ingen Apollo-data (hasApollo=false)");
    }

    return usable;
  } catch (error) {
    // Log the real error server-side before mapping to a user-facing message.
    console.error("[sold-source]", error);
    throw new Error(
      "Kunde inte hamta saljdata fran Booli. Prisjamforelse ar tillfalligt otillganglig.",
    );
  }
}
