import { runPlaywrightRender } from "./transport";
import { APOLLO_PAGE_FUNCTION } from "./page-functions";
import { walkFallbackTree } from "./fallback-tree";
import { scrapeBooli } from "@/lib/apify/booli-scraper";
import { CAP_IMAGES_PER_LISTING } from "@/lib/discovery/filter-schema";

/**
 * client.ts — the unified owned Booli client (ACQ-01 `fetchListing` + ACQ-02
 * `fetchAreaListings` + ACQ-03/PRICE-01 `fetchSoldComps`). All three entry
 * points compose Plan 03's transport (`runPlaywrightRender` +
 * `APOLLO_PAGE_FUNCTION`) and fallback tree (`walkFallbackTree`), with the
 * existing paid actor (`scrapeBooli`) wired in ONLY as the last-resort rung 3
 * for single-listing fetch — never the silent default it is today (T-05-14).
 *
 * Apollo entity prefix (05-PROBE-FINDINGS.md, empirically pinned via the live
 * narrow-confirmation probe against `https://www.booli.se/bostad/305443` →
 * `Listing:4463691`): `Listing:`. This generalizes `sold-schema.ts`'s
 * `SoldProperty:` prefix-scan to the detail/area-search entity type.
 *
 * Shape note (05-PROBE-FINDINGS.md "Shape note for Plan 04"): the raw
 * `Listing:` Apollo entity differs structurally from the paid actor's flat
 * object — arg-keyed fields (`displayAttributes({...})`, `agency({...})`),
 * Apollo refs (`housingCoop`, `images`, `areas`, `location`), and nested
 * `priceInfo`/`salesOfResidence`. `extractListingEntity`/`extractListingEntities`
 * below reshape the raw entity into the SAME flat `Record<string, unknown>`
 * shape `scrapeBooli()` returns today, so `normalizeScraperOutput` (which is
 * NOT modified by this phase) stays a no-op migration.
 *
 * Plan 05 absorption (PRICE-01 unification, success criterion 4): `fetchSoldComps`
 * (+ `resolveAreaId`, `buildSlutpriserUrl`, `SoldSourceQuery`, `PriceTier`,
 * `Breadcrumb`) moved here VERBATIM from `src/lib/market/sold-source.ts` —
 * internals unchanged, only the transport swapped from an inline
 * `client.actor(...).call(...)` to the shared `runPlaywrightRender` +
 * `walkFallbackTree`, so active + area + sold listings now share ONE
 * transport/fallback tree. `sold-source.ts` is reduced to a thin re-export
 * shim so `enrich-market-context.ts` and `sold-source.test.ts` keep resolving
 * their imports UNCHANGED (the true PRICE-01 no-op-migration guarantee).
 */

// ---------------------------------------------------------------------------
// Null-tolerant coercion helpers (mirror listing.ts:88-105 / sold-schema.ts:113-120)
// ---------------------------------------------------------------------------

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const rawOf = (v: unknown): number | null =>
  v && typeof v === "object" && "raw" in v
    ? num((v as { raw: unknown }).raw)
    : null;
// booliId may arrive as a number id or a string -- coerce to string, else null.
const idStr = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0
    ? v
    : typeof v === "number" && Number.isFinite(v)
      ? String(v)
      : null;
// breadcrumbs: retained as-is when the entity carries an array, else null.
const crumbs = (v: unknown): unknown[] | null =>
  Array.isArray(v) ? v : null;

// ---------------------------------------------------------------------------
// displayAttributes variant selection — reused verbatim from sold-schema.ts's
// dataPointsOf (WR-05 fix): multiple arg-keyed `displayAttributes(...)` variants
// can co-exist on one entity; a first-match walk is non-deterministic. Sort +
// prefer the richer PROPERTY_PAGE_LISTING/SERP_LIST_LISTING variant + merge.
// ---------------------------------------------------------------------------

interface DataPoint {
  key?: string;
  label?: string;
  value?: { plainText?: string; markdown?: string };
}

function dataPointsOf(entry: Record<string, unknown>): DataPoint[] {
  const attrKeys = Object.keys(entry)
    .filter((k) => k.startsWith("displayAttributes"))
    .sort();
  if (attrKeys.length === 0) return [];

  // Prefer the richer detail-page context when present, then whatever else
  // remains, in stable order — mirrors sold-schema.ts's SERP-preference merge.
  const preferred = attrKeys.filter(
    (k) => k.includes("PROPERTY_PAGE_LISTING") || k.includes("SERP_LIST_LISTING"),
  );
  const rest = attrKeys.filter(
    (k) => !k.includes("PROPERTY_PAGE_LISTING") && !k.includes("SERP_LIST_LISTING"),
  );
  const ordered = [...preferred, ...rest];

  const merged: DataPoint[] = [];
  for (const key of ordered) {
    const attr = entry[key] as { dataPoints?: unknown } | null | undefined;
    const points = attr?.dataPoints;
    if (Array.isArray(points)) merged.push(...(points as DataPoint[]));
  }
  return merged;
}

/** Picks the first arg-keyed field on `entry` whose key starts with `prefix` (e.g. "agency("). */
function argKeyedFieldOf(
  entry: Record<string, unknown>,
  prefix: string,
): unknown {
  const keys = Object.keys(entry)
    .filter((k) => k.startsWith(prefix))
    .sort();
  return keys.length > 0 ? entry[keys[0]] : undefined;
}

// ---------------------------------------------------------------------------
// Apollo entity prefix — PINNED by 05-PROBE-FINDINGS.md, not the assumed value
// ---------------------------------------------------------------------------

const LISTING_ENTITY_PREFIX = "Listing:";

// ---------------------------------------------------------------------------
// Phase 6 (LSTG-03, 06-01-PLAN.md Task 2) — floor/balcony/brfName extractors.
// All three are recoverable from the Apollo entity `reshapeListingEntity`
// already receives — no new network call. `amenityKeys` mirrors
// `argKeyedFieldOf`'s strict-parse discipline (Pitfall 3): the amenity ref
// key is stringified JSON (`Amenity:{"key":"balcony"}`), so it must be
// JSON.parse'd and compared by exact `.key` equality, NEVER `.includes()`
// substring-matched (a future `"key":"balconyView"` ref would otherwise
// false-positive). `brfNameFromBreadcrumbs` reuses `resolveAreaId`'s
// regex-on-`.url` breadcrumb-ladder idiom (same array, different pattern).
// ---------------------------------------------------------------------------

/**
 * Strict-parses the `Amenity:` ref keys on `refs` into their `.key` values.
 * Malformed refs (bad JSON, missing `.key`) are skipped, never thrown —
 * mirrors the null-tolerant coercion discipline used throughout this file.
 */
export function amenityKeys(refs: unknown): string[] {
  if (!Array.isArray(refs)) return [];
  return refs
    .map((r) => (r && typeof r === "object" && "__ref" in r ? (r as { __ref: string }).__ref : null))
    .filter((ref): ref is string => typeof ref === "string" && ref.startsWith("Amenity:"))
    .map((ref) => {
      try {
        return (JSON.parse(ref.slice("Amenity:".length)) as { key?: string }).key ?? "";
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

/**
 * The BRF name is the LAST breadcrumb entry whose `.url` matches
 * `/bostadsrattsforening/<id>` (the same breadcrumb array `resolveAreaId`
 * already parses for `areaIds=(\d+)`, just a different regex). Returns null
 * for a non-array/empty input, a too-short ladder, or a last entry that
 * isn't a BRF crumb — never throws.
 */
export function brfNameFromBreadcrumbs(breadcrumbs: unknown): string | null {
  if (!Array.isArray(breadcrumbs) || breadcrumbs.length === 0) return null;
  const last = breadcrumbs[breadcrumbs.length - 1] as { label?: string; url?: string } | undefined;
  if (last?.url && /\/bostadsrattsforening\//.test(last.url)) {
    return typeof last.label === "string" && last.label.length > 0 ? last.label : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase 11 (DISC-04, 11-01-PLAN.md Task 2) — imageUrls extractor.
//
// GENUINELY UNVERIFIED against a live Apollo blob (11-RESEARCH.md Open
// Question 1 / Assumption A1): the exact per-image field name and whether a
// floor-plan `type`/`category` discriminator exists is unconfirmed. This
// extractor is written against RESEARCH's ASSUMED shape
// (`Array<{ url?: string; type?: string }>`, mirroring the `agency(`
// arg-keyed-ref idiom at :172-174/:205) with a graceful, NEVER-THROWING
// fallback: any missing/malformed/absent ref yields `undefined` (→ `null` via
// `arrOfStr` in `candidate.ts`), so the rest of Phase 11 is fully testable
// via fixtures before the live probe (`scripts/probe-booli-images.ts`, run
// by the operator) confirms or corrects the assumed shape. If the real ref
// shape differs, only this extractor needs updating — every downstream
// consumer (candidate.ts, vision-schema.ts, the eventual vision.ts) already
// degrades on `imageUrls: null` regardless of WHY it's null.
// ---------------------------------------------------------------------------

/**
 * A resolved image: a real bcdn.se URL + its `primaryLabel` type ("interior",
 * "floorplan", "kitchen", …). Produced by `resolveImageRefs` from the Apollo
 * `images: [{__ref:"Image:ID"}]` refs (live shape confirmed 2026-07-09 —
 * the assumed inline-`{url}` shape never existed).
 */
interface ApolloImageRef {
  url?: string;
  type?: string;
}

/** Booli image CDN URL template — the Image entity carries only `id`, not a URL. */
const bcdnImageUrl = (id: string): string => `https://bcdn.se/images/cache/${id}_1440x0.webp`;

/**
 * Resolves a Listing entity's `images: [{__ref:"Image:<id>"}]` refs against the
 * FULL Apollo state (where the `Image:<id>` entities live) into `{url, type}`
 * items. The `Image` entity has no URL — only `id` + `primaryLabel` — so the
 * bcdn.se gallery URL is built from the id (`bcdnImageUrl`). Never throws: a
 * missing field, a non-array `images`, or an unresolvable ref degrades to
 * being skipped. Called from `collectListingEntities`, the one place that
 * still has the Apollo state; the resolved array is written back onto the
 * entity's `images` field so `reshapeListingEntity`/`extractImageUrls` (which
 * see only the flat entity) can consume it.
 */
function resolveImageRefs(
  entry: Record<string, unknown>,
  state: Record<string, unknown>,
): ApolloImageRef[] {
  const refs = entry.images;
  if (!Array.isArray(refs)) return [];
  const out: ApolloImageRef[] = [];
  for (const r of refs) {
    const ref =
      r && typeof r === "object" && "__ref" in r ? (r as { __ref: unknown }).__ref : null;
    if (typeof ref !== "string" || !ref.startsWith("Image:")) continue;
    const img = state[ref] as { id?: unknown; primaryLabel?: unknown } | undefined;
    const id = img && typeof img.id === "string" ? img.id : null;
    if (!id) continue;
    out.push({
      url: bcdnImageUrl(id),
      type: typeof img?.primaryLabel === "string" ? img.primaryLabel : undefined,
    });
  }
  return out;
}

/**
 * SSRF defense-in-depth (T-11-02, mirrors `isBooliUrl`'s real-hostname-check
 * discipline, NEVER a substring match): only Booli's own CDN host(s) are
 * allowed through. Even though Anthropic's servers (not this app) perform the
 * actual image fetch, this filter ensures the PII-safe persisted allowlist
 * itself never carries a non-Booli-CDN URL.
 *
 * WR-03 (11-REVIEW.md): this allowlist is intentionally restricted to
 * `booli.se`/`*.booli.se` — the ONLY hosts 11-RESEARCH.md's SSRF discussion
 * (line 614) and Assumption A1 (line 515) ever reference. A `*.bcdn.se`
 * entry was previously added here speculatively, without the probe-pinning
 * discipline the rest of this file follows (contrast
 * `LISTING_ENTITY_PREFIX`, pinned via `05-PROBE-FINDINGS.md`) — there is no
 * probe finding or research citation confirming `bcdn.se` as a real,
 * Booli-owned CDN host. Since this allowlist is the ONE place standing
 * between an Apollo-supplied URL and inclusion in the PII-safe persisted
 * `imageUrls` field (and subsequently sent to Anthropic's image fetcher),
 * widening it ahead of confirmation would speculatively expand the SSRF
 * surface.
 *
 * UAT FOLLOW-UP RESOLVED (2026-07-09): a live headless render of a real Booli
 * detail page (`/bostad/708259`) confirmed Booli serves ALL gallery/interior/
 * floor-plan images from `bcdn.se` (e.g. `https://bcdn.se/images/cache/
 * 54356971_1440x0.webp`), never from `booli.se`. `bcdn.se` is therefore added
 * here WITH that probe confirmation (not speculatively) — without it,
 * `extractImageUrls` filtered out every image and the vision pass could never
 * run (always `no_images`). `hm.bcdn.se` (broker-logo subdomain) is covered by
 * the `.bcdn.se` suffix match.
 *
 * WR-03 (12-REVIEW.md): exported (was module-private) so `candidate.ts`'s
 * READ-path Zod guard (`discoveryCandidateSchema`) can re-apply this SAME
 * check to a persisted/legacy row's `imageUrls` before it is trusted for
 * rendering — defense-in-depth so a write-path-only check is never the sole
 * thing standing between a tampered/corrupted row and an `<img src={...}>`.
 */
export function isAllowedImageHost(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== "https:") return false;
    return (
      hostname === "booli.se" ||
      hostname.endsWith(".booli.se") ||
      hostname === "bcdn.se" ||
      hostname.endsWith(".bcdn.se")
    );
  } catch {
    return false;
  }
}

/**
 * Extracts a flat, host-allowlisted, capped image-URL array from the raw
 * entity's `images(`-prefixed Apollo ref (same `argKeyedFieldOf` idiom as the
 * existing `agency(` extraction). Never throws: a missing ref, a
 * non-array value, or an item with a missing/non-string `url` all degrade to
 * being skipped rather than fabricated or crashing the reshape.
 *
 * Floor-plan-first ordering (RESEARCH Assumption A2): when a `type`/`category`
 * discriminator is present on an item and identifies it as a floor plan, that
 * item is sorted first. Absent a discriminator, the natural Apollo ref order
 * is preserved (degrade gracefully — never guess which image is the floor
 * plan without a discriminator).
 *
 * Capped to `CAP_IMAGES_PER_LISTING` (4) AT EXTRACTION TIME (not at
 * vision-call time) so the persisted PII-safe allowlist itself never carries
 * more than the phase's own image budget (T-11-03).
 *
 * @returns a capped, host-allowlisted image-URL array, or `undefined` when no
 *   usable images( ref exists — mirrors `agencyName`'s `?? undefined` idiom
 *   so `toCandidate`'s `arrOfStr` normalizes this to `null`.
 */
function extractImageUrls(entry: Record<string, unknown>): string[] | undefined {
  // `entry.images` is the RESOLVED `{url,type}[]` written back by
  // `resolveImageRefs` in collectListingEntities (the raw `[{__ref}]` refs
  // cannot be resolved here — the flat entity no longer has the Apollo state).
  const images = Array.isArray(entry.images) ? (entry.images as ApolloImageRef[]) : undefined;
  if (!Array.isArray(images)) return undefined;

  const isFloorPlan = (item: ApolloImageRef): boolean =>
    typeof item?.type === "string" &&
    /floor.?plan|planritning|planlösning|layout/i.test(item.type);

  const withUrls = images.filter(
    (item): item is ApolloImageRef & { url: string } =>
      !!item && typeof item.url === "string" && item.url.length > 0,
  );
  const allowed = withUrls.filter((item) => isAllowedImageHost(item.url));

  const floorPlans = allowed.filter(isFloorPlan);
  const gallery = allowed.filter((item) => !isFloorPlan(item));
  const ordered = [...floorPlans, ...gallery].map((item) => item.url);

  if (ordered.length === 0) return undefined;
  return ordered.slice(0, CAP_IMAGES_PER_LISTING);
}

/**
 * Reshapes one raw `Listing:<id>` Apollo entity into the flat
 * `Record<string, unknown>` shape `scrapeBooli()` / `scraperOutputSchema`
 * expect. Uses the null-tolerant coercion helpers throughout (T-05-12): a
 * malformed/partial entity yields undefined/null fields, never a throw.
 */
function reshapeListingEntity(entry: Record<string, unknown>): Record<string, unknown> {
  const agency = argKeyedFieldOf(entry, "agency(") as
    | { name?: string; thumbnail?: string }
    | undefined;

  return {
    imageUrls: extractImageUrls(entry),
    url: str(entry.url) ?? undefined,
    streetAddress: str(entry.streetAddress) ?? undefined,
    // Phase 12 (DISC-06) — read-only source for `toCandidate`'s DERIVED
    // orientation extraction (extractOrientationFromDescription). This is
    // ONLY a flat-record passthrough, identical to streetAddress above; the
    // raw text is NEVER itself persisted onto DiscoveryCandidate (PII risk,
    // RESEARCH.md Pitfall 3) — only the derived {facades, confidence} is.
    description: str(entry.description) ?? undefined,
    descriptiveAreaName: str(entry.descriptiveAreaName) ?? undefined,
    // `price` (realized sale price) is expected-absent for an active listing;
    // normalizeScraperOutput already falls back to `listPrice` (05-PROBE-FINDINGS.md).
    price: num(entry.price) ?? undefined,
    rent: rawOf(entry.rent) ?? undefined,
    estimate:
      rawOf((entry.estimate as { price?: unknown } | undefined)?.price) ??
      undefined,
    constructionYear: num(entry.constructionYear) ?? undefined,
    rooms: rawOf(entry.rooms) ?? undefined,
    livingArea: entry.livingArea ?? undefined,
    listPrice: entry.listPrice ?? undefined,
    listRent: entry.listRent ?? undefined,
    listSqmPrice: entry.listSqmPrice ?? undefined,
    objectType: str(entry.objectType) ?? undefined,
    tenureForm: str(entry.tenureForm) ?? undefined,
    // Listing status discriminators (live-confirmed 2026-07-09) — a "kommande"
    // (upcomingSale) listing has NO asking price yet, and new-production has no
    // renovation upside, so discovery filters both out. Passed through as-is
    // (booleans) for toCandidate to read.
    upcomingSale: typeof entry.upcomingSale === "boolean" ? entry.upcomingSale : undefined,
    isNewConstruction:
      typeof entry.isNewConstruction === "boolean" ? entry.isNewConstruction : undefined,
    // Join-key fields (03-SPIKE.md contract) — retained unchanged.
    latitude: num(entry.latitude) ?? undefined,
    longitude: num(entry.longitude) ?? undefined,
    booliId: idStr(entry.booliId) ?? idStr(entry.id) ?? undefined,
    breadcrumbs: crumbs(entry.breadcrumbs) ?? undefined,
    // Phase 6 note (05-PROBE-FINDINGS.md): the broker link is present as
    // `listingUrl` (inline string), not the actor's `agencyListingUrl` key —
    // surfaced under both names so either call site works.
    listingUrl: str(entry.listingUrl) ?? undefined,
    agencyListingUrl: str(entry.listingUrl) ?? undefined,
    agencyName: agency?.name ?? undefined,
    // Bonus structured fields the paid actor never returned (05-PROBE-FINDINGS.md
    // "Bonus" section) — passed through so future call sites can read them
    // without another Apollo-shape reshape.
    floor: entry.floor ?? undefined,
    amenities: entry.amenities ?? undefined,
    // Any multi-variant displayAttributes dataPoints, deterministically merged.
    displayDataPoints: dataPointsOf(entry),
    // Phase 6 (LSTG-03) — derived reshapes ADDITIVE to the raw floor/amenities/
    // breadcrumbs passthrough above (those feed other call sites unchanged).
    // `floor` is NOT re-keyed here: the existing `floor: entry.floor ??
    // undefined` passthrough above already carries the Apollo `{raw: 3}`
    // FormattedValue shape through unmodified, and normalizeScraperOutput
    // (06-01-PLAN.md Task 1) already unwraps it via `num(raw.floor) ??
    // rawOf(raw.floor)` — adding a second `floor:` key in this same object
    // literal would silently shadow the passthrough (duplicate keys, last
    // wins) that other call sites depend on. balcony/brfName have no existing
    // passthrough key to collide with, so they're added directly.
    // normalizeScraperOutput reads these via `raw.floor`/`raw.balcony`. Do
    // NOT re-derive any of these three from a broker page — Apollo is the
    // more reliable first-party source (RESEARCH Anti-Pattern).
    balcony: amenityKeys(entry.amenities).includes("balcony") || entry.balcony === true,
    brfName: brfNameFromBreadcrumbs(entry.breadcrumbs) ?? undefined,
  };
}

/**
 * Scans `__APOLLO_STATE__` for every `Listing:<id>` entry (the pinned prefix)
 * across the usable render items, skipping non-object values (T-05-12).
 * Returns the raw (un-reshaped) entities in Apollo key order.
 */
function collectListingEntities(items: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const state = (item as { __APOLLO_STATE__?: unknown }).__APOLLO_STATE__;
    if (!state || typeof state !== "object") continue;
    for (const [key, value] of Object.entries(state as Record<string, unknown>)) {
      if (!key.startsWith(LISTING_ENTITY_PREFIX)) continue;
      if (!value || typeof value !== "object") continue;
      const entity = value as Record<string, unknown>;
      // Resolve image refs HERE, the only place with the Apollo state — write
      // the resolved {url,type}[] back onto `images` so reshapeListingEntity /
      // extractImageUrls (which see only the flat entity) can read them.
      entity.images = resolveImageRefs(entity, state as Record<string, unknown>);
      out.push(entity);
    }
  }
  return out;
}

/**
 * Extracts the SINGLE `Listing:<id>` entity from a detail-page render and
 * reshapes it into the scrapeBooli-compatible flat shape. Throws (HIGH-1 —
 * never returns an empty/ambiguous shape) when no usable entity is found.
 */
function extractListingEntity(items: unknown[]): Record<string, unknown> {
  const entities = collectListingEntities(items);
  if (entities.length === 0) {
    throw new Error("Ingen Listing-post hittades i Booli-sidan");
  }
  return reshapeListingEntity(entities[0]);
}

/**
 * Extracts EVERY `Listing:<id>` entity from an area-search render (one Apollo
 * blob commonly embeds many listings), each reshaped into the scrapeBooli-
 * compatible flat shape.
 *
 * WR-01 fix: does NOT throw on zero entities. `runPlaywrightRender` already
 * owns the "dead source" signal (it throws on a non-SUCCEEDED run, an empty
 * dataset, or every item lacking usable Apollo data — see transport.ts) — by
 * the time `items` reaches this function, the render itself has already
 * SUCCEEDED. Zero `Listing:` entities in a successful render is therefore a
 * genuinely-empty area result, not a dead render, so this returns `[]`
 * honestly instead of throwing and forcing `fetchAreaListings` to misreport
 * a real empty area as "source failed" (the previous throw-on-zero behavior
 * contradicted this exact distinction, which the doc comment already claimed
 * existed but the code never implemented).
 */
function extractListingEntities(items: unknown[]): Record<string, unknown>[] {
  return collectListingEntities(items).map(reshapeListingEntity);
}

// ---------------------------------------------------------------------------
// ACQ-01 — fetchListing(url)
// ---------------------------------------------------------------------------

/**
 * SSRF allowlist (T-05-10, hardened per WR-03): parses `url` and requires an
 * `https:` hostname that is EXACTLY `booli.se` or ends with `.booli.se` — a
 * real hostname check, not a substring match. A naive `.includes("booli.se/")`
 * is bypassable by any attacker-controlled host that embeds that substring
 * anywhere in its path/query (e.g. `https://evil.example/booli.se/x` or
 * `https://evil.example/?x=booli.se/`), both of which would previously have
 * been sent straight into the Apify actor's `startUrls`. A malformed URL
 * (throws in `new URL`) is rejected, never treated as valid.
 */
export function isBooliUrl(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    return (
      protocol === "https:" &&
      (hostname === "booli.se" || hostname.endsWith(".booli.se"))
    );
  } catch {
    return false;
  }
}

/**
 * Fetches a single Booli listing by URL through the owned client, falling
 * back to the paid actor only as a last resort (T-05-14).
 *
 * Rungs:
 *  1. own-playwright       — `runPlaywrightRender` + `APOLLO_PAGE_FUNCTION`.
 *  2. own-playwright-retry — a SECOND independent call to the same transport.
 *     This is intentional, NOT duplicate code to clean up (fallback-tree.ts's
 *     doc comment + 05-RESEARCH.md Pitfall 5): a fresh Apify run gets a new
 *     container + a new RESIDENTIAL/SE proxy session, which is the actual
 *     resilience lever once rung 1's own internal `maxRequestRetries: 3` is
 *     exhausted.
 *  3. paid-actor           — `scrapeBooli`, the existing paid Apify actor.
 *
 * SSRF allowlist (T-05-10): throws BEFORE any actor call when `url` is not a
 * real `booli.se`/`*.booli.se` https URL (see `isBooliUrl`, WR-03).
 *
 * Return-shape contract: identical to `scrapeBooli()`'s `Record<string,
 * unknown>` — this is what keeps `normalizeScraperOutput` a no-op migration.
 */
export async function fetchListing(url: string): Promise<Record<string, unknown>> {
  if (!url || !isBooliUrl(url)) {
    throw new Error("Ange en giltig Booli-lank");
  }

  const rungs = [
    {
      source: "own-playwright" as const,
      attempt: () =>
        runPlaywrightRender(url, APOLLO_PAGE_FUNCTION).then(extractListingEntity),
    },
    {
      source: "own-playwright-retry" as const,
      attempt: () =>
        runPlaywrightRender(url, APOLLO_PAGE_FUNCTION).then(extractListingEntity),
    },
    {
      source: "paid-actor" as const,
      attempt: () => scrapeBooli(url),
    },
  ];

  const result = await walkFallbackTree(rungs);
  // ACQ-03 observability — never log the token or client instance.
  console.error(
    `[booli-client] fetchListing served by rung ${result.rung} (${result.source}, health=${result.health})`,
  );
  return result.data;
}

// ---------------------------------------------------------------------------
// ACQ-02 — fetchAreaListings(areaId, objectType?)
// ---------------------------------------------------------------------------

/**
 * Builds the till-salu (active listings) search URL for `areaId`, mirroring
 * `sold-source.ts`'s `buildSlutpriserUrl` — `URLSearchParams` only, never
 * manual string concatenation (T-05-11).
 */
function buildTillSaluUrl(areaId: string, objectType?: string | null): string {
  const params = new URLSearchParams({ areaIds: areaId });
  if (objectType) params.set("objectType", objectType);
  return `https://www.booli.se/sok/till-salu?${params.toString()}`;
}

/**
 * Fetches every active listing for `areaId` (+ optional `objectType` filter)
 * through the owned client.
 *
 * Pagination note (05-RESEARCH.md Open Question 3): `/sok/till-salu` embeds
 * multiple `Listing:` entities in ONE Apollo blob per page; whether results
 * span multiple pages for a given area is an in-plan LIVE verification, not
 * assumed transitively from the single-page probe — a future plan adds
 * `&page=N` walking if a live check shows truncation. This function extracts
 * every entity present in the render(s) it receives, but does not itself
 * paginate.
 *
 * Paid-actor-in-area-search decision (rung 3): `scrapeBooli` is shaped for a
 * SINGLE listing URL, not an area search — it cannot answer "list every
 * listing in area X." Per 05-RESEARCH.md, area search therefore degrades to
 * the two own-render rungs only; there is no rung 3 for `fetchAreaListings`.
 * A genuinely dead area search throws (HIGH-1) once both own renders fail,
 * rather than silently wrapping a single-listing actor result into `[x]`
 * (which would misrepresent an area result as one listing).
 *
 * Empty-area vs. dead-render distinction (WR-01): `extractListingEntities`
 * returns `[]` (not a throw) for a render that SUCCEEDED with zero `Listing:`
 * entities — a real empty area. A render that never produced usable Apollo
 * data at all is caught earlier, inside `runPlaywrightRender` itself (dead
 * source), so only a confirmed-successful-but-empty render ever reaches
 * `extractListingEntities`. This function therefore returns a genuinely
 * empty `[]` for a sparse/new area instead of forcing it through the
 * `walkFallbackTree` exhaustion path and misreporting it as "source failed."
 */
export async function fetchAreaListings(
  areaId: string,
  objectType?: string | null,
): Promise<Record<string, unknown>[]> {
  const url = buildTillSaluUrl(areaId, objectType);

  const rungs = [
    {
      source: "own-playwright" as const,
      attempt: () =>
        runPlaywrightRender(url, APOLLO_PAGE_FUNCTION).then(extractListingEntities),
    },
    {
      source: "own-playwright-retry" as const,
      attempt: () =>
        runPlaywrightRender(url, APOLLO_PAGE_FUNCTION).then(extractListingEntities),
    },
  ];

  const result = await walkFallbackTree(rungs);
  console.error(
    `[booli-client] fetchAreaListings served by rung ${result.rung} (${result.source}, health=${result.health})`,
  );
  return result.data;
}

// ---------------------------------------------------------------------------
// PRICE-01 — fetchSoldComps(query) — absorbed verbatim from sold-source.ts
// (Plan 05 unification, success criterion 4). Internals below are UNCHANGED
// from the original module except the transport: the inline
// `client.actor("apify/playwright-scraper").call(...)` is replaced by the
// shared `runPlaywrightRender` + `walkFallbackTree`, so sold comps now share
// the SAME transport/fallback tree as active listings and area search.
// ---------------------------------------------------------------------------

/** D-01 tier the comps were drawn from. */
export type PriceTier = "building" | "neighborhood" | "wide";

/** A breadcrumb entry as returned by the active-listing actor (03-SPIKE.md §2). */
export interface Breadcrumb {
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
 * The ladder is ordered wide→narrow (län → kommun → neighborhood → street → BRF).
 * The areaId lives in each breadcrumb `url` as the `areaIds=<N>` query param
 * (03-SPIKE.md §2). The final BRF crumb has no `areaIds` param. The extracted
 * id list is therefore also wide→narrow, e.g. [2(län), 1(kommun), 115341(Södermalm
 * neighborhood), 102186(Helgagatan street)]. We map the D-01 tiers by POSITION
 * from the narrow end so each tier hits a genuinely distinct area (the previous
 * mapping collapsed both building AND neighborhood onto the narrowest id — the
 * street — so the dense Södermalm neighborhood 115341 was never queried, a
 * primary cause of the false "thin"):
 *  - "building"     → the narrowest area (street/BRF-area level) = last id.
 *  - "neighborhood" → one level wider than building = second-from-narrowest,
 *    falling back to the narrowest when the ladder is too short to distinguish.
 *  - "wide"         → the kommun/län end: prefer kommun (second from the wide
 *    end) when present, else the widest id.
 *
 * Robust for ladders of varying length (a short [kommun, street] ladder still
 * resolves all three tiers without crashing).
 *
 * Returns null when no areaId can be resolved (caller throws — HIGH-1).
 */
export function resolveAreaId(query: SoldSourceQuery): string | null {
  const crumbs = query.breadcrumbs ?? [];
  const ids: string[] = [];
  for (const crumb of crumbs) {
    const match = crumb?.url?.match(/areaIds=(\d+)/);
    if (match) ids.push(match[1]);
  }
  if (ids.length === 0) return null;

  const last = ids.length - 1;
  // ids are wide→narrow (matches the breadcrumb order). Pick by tier.
  switch (query.tier) {
    case "wide":
      // Prefer the kommun level. In the full Booli ladder the widest crumb is the
      // LÄN, so kommun is the second id (skip län). For a short ladder with no län
      // crumb (≤2 ids, e.g. [kommun, street]) the kommun IS the widest id, so fall
      // back to ids[0] rather than picking the narrow street id (the old
      // `Math.min(1,last)` heuristic mis-picked the street for short ladders).
      return ids.length >= 3 ? ids[1] : ids[0];
    case "neighborhood":
      // One level wider than the building/street id (the neighborhood crumb, e.g.
      // Södermalm 115341), clamped to a real index for short ladders.
      return ids[Math.max(0, last - 1)];
    case "building":
    default:
      // The narrowest area that still carries an areaId (street/BRF-area level).
      return ids[last];
  }
}

/** Builds the slutpriser URL for an areaId (+ optional objectType filter). */
function buildSlutpriserUrl(areaId: string, objectType?: string | null): string {
  const params = new URLSearchParams({ areaIds: areaId });
  if (objectType) params.set("objectType", objectType);
  return `https://www.booli.se/sok/slutpriser?${params.toString()}`;
}

/**
 * Fetches the raw sold-comps payload for a listing's area, behind ONE interface.
 *
 * Resolves the Booli areaId from the breadcrumb ladder for the requested tier,
 * renders the slutpriser page through the shared `runPlaywrightRender` transport
 * (the same `apify/playwright-scraper` + RESIDENTIAL/SE proxy config — 03-SPIKE.md
 * §1.2 — now centralized in transport.ts), and returns the raw usable dataset
 * items (Plan 05's `normalizeSoldOutput` parses them).
 *
 * Rung design: sold comps use own-render rungs ONLY (own-playwright,
 * own-playwright-retry) — there is no rung 3 / paid-actor fallback here. The
 * paid actor (`scrapeBooli`) is single-listing-shaped (it scrapes one detail
 * page) and does NOT support the slutpriser search page, so it cannot serve as
 * a sold-comps fallback (mirrors `fetchAreaListings`'s same reasoning). A
 * genuinely dead sold source throws (HIGH-1) once both own-render rungs fail,
 * rather than fabricating a paid-actor call that cannot answer the query.
 * ACQ-03 observability via `walkFallbackTree` still applies (rung/source/health
 * logged on every call).
 *
 * HIGH-1: throws (Swedish user-facing message) on an unresolved areaId or once
 * every rung fails. It NEVER silently returns `[]` — a dead source must be
 * distinguishable from a thin area. The real error is logged server-side first
 * (by `runPlaywrightRender`/`walkFallbackTree`); the raw error is never leaked
 * to the user. The unresolved-areaId throw and the Swedish user-facing message
 * below are byte-identical to the original `sold-source.ts` so
 * `enrich-market-context.ts`'s `reason: "source_unavailable"` mapping is
 * unaffected.
 *
 * WR-02 cost-ledger fix: the shared fallback tree can burn up to 2 real Apify
 * renders per call (own-playwright + own-playwright-retry), not 1 like the
 * pre-migration inline actor call. `rendersUsed` (== `FallbackResult.rung` on
 * success) surfaces the ACTUAL render count consumed so `walkSoldTiers`
 * (`enrich-market-context.ts`) can sum real spend instead of assuming a flat
 * 1-per-tier — otherwise `market_cost_sek` silently under-reports by up to 2x
 * per tier. The happy (rung-1) path is unaffected: `rendersUsed` is 1, exactly
 * what the pre-migration cost accounting already assumed.
 *
 * @param query - resolved lat/lng + area ladder + tier (server-side only)
 * @returns `data` — the raw rendered payload(s) (`normalizeSoldOutput` parses
 *   them) — and `rendersUsed`, the real render count this call consumed.
 */
export async function fetchSoldComps(
  query: SoldSourceQuery,
): Promise<{ data: unknown[]; rendersUsed: number }> {
  const areaId = resolveAreaId(query);
  if (!areaId) {
    // No area to query — a structural gap, not a thin area. Surface it (HIGH-1).
    throw new Error(
      "Kunde inte hitta omradesinformation for bostaden. Prisjamforelse ar inte tillganglig.",
    );
  }

  const url = buildSlutpriserUrl(areaId, query.objectType);

  const rungs = [
    {
      source: "own-playwright" as const,
      attempt: () => runPlaywrightRender(url, APOLLO_PAGE_FUNCTION),
    },
    {
      source: "own-playwright-retry" as const,
      attempt: () => runPlaywrightRender(url, APOLLO_PAGE_FUNCTION),
    },
  ];

  try {
    const result = await walkFallbackTree(rungs);
    // ACQ-03 observability — never log the token or client instance.
    console.error(
      `[booli-client] fetchSoldComps served by rung ${result.rung} (${result.source}, health=${result.health})`,
    );
    return { data: result.data, rendersUsed: result.rung };
  } catch (error) {
    // Log the real error server-side before mapping to a user-facing message.
    console.error("[sold-source]", error);
    throw new Error(
      "Kunde inte hamta saljdata fran Booli. Prisjamforelse ar tillfalligt otillganglig.",
    );
  }
}
