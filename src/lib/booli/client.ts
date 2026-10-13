import { runPlaywrightRender } from "./transport";
import { isAllowedImageHost } from "./image-host";
import { APOLLO_PAGE_FUNCTION } from "./page-functions";
import { walkFallbackTree } from "./fallback-tree";
// DISABLED 2026-07-14 (cost): the paid Lexis actor (lexis-solutions/booli-se-scraper)
// was only fetchListing's last-resort rung 3 and hadn't fired since 2026-07-02.
// Its ~$30/mo Apify rental ate most of the monthly credits, so the rung is
// commented out below and this import with it. The module
// (src/lib/apify/booli-scraper.ts) is intentionally KEPT so this is a clean
// uncomment-to-restore. See .planning/research/2026-07-14-DISABLED-lexis-paid-actor.md
// import { scrapeBooli } from "@/lib/apify/booli-scraper";
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
    .map((r) => {
      if (!r || typeof r !== "object") return "";
      // Inline Amenity object (Booli's 2026-10 denormalized payloads).
      if (!("__ref" in r)) {
        const key = (r as { key?: unknown }).key;
        return typeof key === "string" ? key : "";
      }
      const ref = (r as { __ref: unknown }).__ref;
      if (typeof ref !== "string" || !ref.startsWith("Amenity:")) return "";
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

/**
 * The BRF's Booli id: the digits of the LAST breadcrumb whose `.url` is
 * `/bostadsrattsforening/<digits>` (Phase 14.2, R-07/R-08: the key of the public
 * BRF page and of the facts record). Digits only, so the id can be put into a
 * URL later without escaping. Null for a non-array, an empty ladder, a last
 * crumb that is not a BRF crumb, or a non-numeric id - never throws.
 */
export function brfIdFromBreadcrumbs(breadcrumbs: unknown): string | null {
  if (!Array.isArray(breadcrumbs) || breadcrumbs.length === 0) return null;
  const last = breadcrumbs[breadcrumbs.length - 1] as { url?: unknown } | undefined;
  if (typeof last?.url !== "string") return null;
  const m = last.url.match(/\/bostadsrattsforening\/(\d+)(?:[/?#]|$)/);
  return m ? m[1] : null;
}

/**
 * Derives the listing's kommun for geographic corroboration (Pitfall 4) from
 * the breadcrumb wide->narrow area ladder (e.g. ["Stockholms län",
 * "Stockholms kommun", "Södermalm", ...]) — the entry whose label ends with
 * " kommun" (case-insensitive), stripped of that suffix. Returns null when no
 * such entry exists (honest degrade — resolveOrgNr's geo-corroboration check
 * then fails closed to "low"/"none", never a guess).
 *
 * Phase 14 (D-14-09): this is the SINGLE shared implementation for BOTH the
 * discovery scrape path (`reshapeListingEntity`, below — feeds
 * `DiscoveryCandidate.kommun`) and the single-listing BRF auto-fetch path
 * (`fetch-brf-auto.ts`'s `resolveOrgNrAction`) — previously a private
 * near-duplicate lived only in `fetch-brf-auto.ts`. Takes `unknown` (not
 * `Breadcrumb[] | null`), mirroring `brfNameFromBreadcrumbs`'s own signature,
 * so it accepts both the raw Apollo `entry.breadcrumbs` value AND
 * `fetch-brf-auto.ts`'s typed `Breadcrumb[] | null`.
 *
 * NOTE: Booli breadcrumb labels are in the Swedish genitive form ("Stockholms
 * kommun" -> "Stockholms"), which does NOT match a registry's nominative kommun
 * name ("Stockholm") textually. Returning the genitive stem here is
 * nevertheless intentional and correct: `resolveOrgNr`'s `normalizeKommun`
 * (`org-nr-resolver.ts`) strips the "kommun" suffix and the genitive "-s" (with
 * a >3-character stem guard) and applies that SAME transform to BOTH sides of
 * the comparison, so "Stockholms" and "Stockholm" both reduce to "stockholm"
 * and corroborate. WR-14 (14-REVIEW.md): this comment previously still said
 * `normalizeKommun` does "an exact case-insensitive comparison with no genitive
 * normalization yet (plan 14-03's fix, not this plan's) … accepted limitation
 * pending 14-03" — 14-03 shipped, and `fetch-brf-auto.ts:90-97` documents the
 * live behaviour, so the two comments contradicted each other and a reader
 * following this one would conclude discovery BRF lookups can never reach
 * "high" (the exact false belief 14-03 existed to remove).
 */
export function kommunFromBreadcrumbs(breadcrumbs: unknown): string | null {
  if (!Array.isArray(breadcrumbs)) return null;
  for (const crumb of breadcrumbs) {
    const label =
      crumb && typeof crumb === "object" && typeof (crumb as { label?: unknown }).label === "string"
        ? (crumb as { label: string }).label.trim()
        : null;
    if (label && /\skommun$/i.test(label)) {
      return label.replace(/\skommun$/i, "").trim();
    }
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
    if (!r || typeof r !== "object") continue;
    // Two packagings (page-functions.ts): a normalized-cache `{__ref:
    // "Image:<id>"}` link resolved through `state`, or — since Booli's
    // 2026-10 rebuild — the Image object inline `{id, primaryLabel}`.
    let img: { id?: unknown; primaryLabel?: unknown } | undefined;
    if ("__ref" in r) {
      const ref = (r as { __ref: unknown }).__ref;
      if (typeof ref !== "string" || !ref.startsWith("Image:")) continue;
      img = state[ref] as typeof img;
    } else {
      img = r as typeof img;
    }
    const id = img && (typeof img.id === "string" ? img.id : typeof img.id === "number" ? String(img.id) : null);
    if (!id) continue;
    out.push({
      url: bcdnImageUrl(id),
      type: typeof img?.primaryLabel === "string" ? img.primaryLabel : undefined,
    });
  }
  return out;
}

// `isAllowedImageHost` lives in the pure ./image-host module (see its header); re-exported
// here so existing importers of this file are unaffected.
export { isAllowedImageHost };

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
 *
 * Exported (Phase 14.2, additive) so `discovery/listing-facts.ts` tests can run
 * captured detail pages through exactly the reshape the weekly run uses. The
 * facts keys (displayDate, statusKey, published, listPriceChange,
 * listPricePercentageDiff, biddingOpen, operatingCost, brfId) ride on this flat
 * record only; `toCandidate` ignores them, so the persisted candidate is not
 * widened (R-08).
 */
export function reshapeListingEntity(entry: Record<string, unknown>): Record<string, unknown> {
  // Arg-keyed `agency(...)` in the legacy normalized cache; plain `agency`
  // in the denormalized payloads page-functions.ts emits since 2026-10.
  const agency = (argKeyedFieldOf(entry, "agency(") ?? entry.agency) as
    | { name?: string; thumbnail?: string }
    | null
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
    // wins) that other call sites depend on. balcony/brfName/kommun have no
    // existing passthrough key to collide with, so they're added directly.
    // normalizeScraperOutput reads these via `raw.floor`/`raw.balcony`. Do
    // NOT re-derive any of these from a broker page — Apollo is the
    // more reliable first-party source (RESEARCH Anti-Pattern).
    balcony: amenityKeys(entry.amenities).includes("balcony") || entry.balcony === true,
    brfName: brfNameFromBreadcrumbs(entry.breadcrumbs) ?? undefined,
    // Phase 14 (D-14-09): reads the SAME entry.breadcrumbs value already
    // passed to brfNameFromBreadcrumbs above — zero extra network cost.
    // Search-page cards (2026-10 shape) carry no breadcrumbs; page-functions.ts
    // sets a plain `kommun` from the card's tracking data instead.
    kommun: kommunFromBreadcrumbs(entry.breadcrumbs) ?? str(entry.kommun) ?? undefined,
    // Phase 14.2 (R-08): facts for the separate CandidateFacts record. Detail pages
    // carry published / listPriceChange / listPricePercentageDiff / biddingOpen /
    // operatingCost; search cards carry displayDate / statusKey. Each is read with the
    // null-tolerant helpers, so an absent field stays undefined and nothing is invented.
    displayDate: str(entry.displayDate) ?? undefined,
    statusKey: str(entry.statusKey) ?? undefined,
    published: str(entry.published) ?? undefined,
    // Raw numbers, unwrapped from the FormattedValue. The sign is Booli's: negative means
    // the asking price went DOWN (checked against a -15,6 % listing on 2026-10-13).
    listPriceChange: rawOf(entry.listPriceChange) ?? undefined,
    listPricePercentageDiff: rawOf(entry.listPricePercentageDiff) ?? undefined,
    biddingOpen: num(entry.biddingOpen) ?? undefined,
    operatingCost: rawOf(entry.operatingCost) ?? undefined,
    brfId: brfIdFromBreadcrumbs(entry.breadcrumbs) ?? undefined,
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
 *
 * @param opts - OPTIONAL, additive-only (13-04 Task 3, GAP-2): threaded
 *   verbatim into BOTH own-render rungs' `runPlaywrightRender` calls. No
 *   opts (the /analyze single-listing call site, `analyze.ts:70`) keeps the
 *   proven 240s/3-retry defaults byte-for-byte. `enrichCandidateImages`
 *   (job.ts) passes the bounded `DETAIL_ENRICH_WAIT_SECS`/
 *   `DETAIL_ENRICH_MAX_RETRIES` below so one blocked/slow detail page during
 *   vision enrichment cannot burn ~480s across both rungs.
 */
export async function fetchListing(
  url: string,
  opts?: { waitSecs?: number; maxRequestRetries?: number },
): Promise<Record<string, unknown>> {
  if (!url || !isBooliUrl(url)) {
    throw new Error("Ange en giltig Booli-lank");
  }

  const rungs = [
    {
      source: "own-playwright" as const,
      attempt: () =>
        runPlaywrightRender(url, APOLLO_PAGE_FUNCTION, opts).then(extractListingEntity),
    },
    {
      source: "own-playwright-retry" as const,
      attempt: () =>
        runPlaywrightRender(url, APOLLO_PAGE_FUNCTION, opts).then(extractListingEntity),
    },
    // DISABLED 2026-07-14 (cost): rung 3 = the paid Lexis actor
    // (lexis-solutions/booli-se-scraper), a last-resort fallback that hadn't
    // run since 2026-07-02 (Apify shows 21 runs ever, none in the 12 days
    // before disabling). own-playwright is the proven primary transport
    // (clears Cloudflare on retry), so with rung 3 gone fetchListing now
    // degrades to the two own-render rungs and throws (HIGH-1) if BOTH fail —
    // non-fatal in discovery enrichment, a hard fail on the /analyze single
    // listing path. To RESTORE: uncomment this block + the scrapeBooli import
    // above + the two client.test.ts rung-3 tests, and re-rent the actor on
    // Apify. See the DISABLED-lexis-paid-actor planning note.
    // {
    //   source: "paid-actor" as const,
    //   attempt: () => scrapeBooli(url),
    // },
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
function buildTillSaluUrl(
  areaId: string,
  objectType?: string | null,
  page: number = 1,
  minLivingArea?: number | null,
): string {
  const params = new URLSearchParams({ areaIds: areaId });
  if (objectType) params.set("objectType", objectType);
  // Phase 14.2 (A6, checked 2026-10-13): Booli applies minLivingArea on the server
  // (Sodermalm 551 -> 444 listings for 35 m2 and up), so the count and the paging
  // describe the filtered list. Absent unless the caller asks, so the in-app URL is unchanged.
  if (minLivingArea !== undefined && minLivingArea !== null) params.set("minLivingArea", String(minLivingArea));
  // Lowest kr/m² first — a useful FIRST-PASS surfacing order (cheap per m²,
  // not just cheap absolute), NOT a conclusion. A low kr/m² can mean a renovation
  // opportunity, but it can equally reflect confounders the sort cannot see:
  // ground/bottom floor, no elevator, no balcony, a traffic-/noise-exposed
  // micro-location, or simply a cheaper sub-area. Attributing low kr/m² to
  // "below-market / reno object" is the ANALYSIS layer's job (future iteration —
  // it must normalise kr/m² against those factors before concluding). Here we
  // only order the candidates so the cheapest-per-m² surface on page 1; the
  // parallel page-walk is a completeness backstop. Live-probed 2026-07-14:
  // `?sort=listSqmPrice&ascending=true` propagates into Booli's `searchForSale`
  // input (`{"sort":"listSqmPrice","ascending":true}`) and returns a distinct,
  // non-price-monotonic ordering. Applied to EVERY page so pagination slices one
  // coherent ordering.
  params.set("sort", "listSqmPrice");
  params.set("ascending", "true");
  if (page > 1) params.set("page", String(page));
  return `https://www.booli.se/sok/till-salu?${params.toString()}`;
}

/**
 * Booli's `/sok/till-salu` paginates at ~36 results/page (live-probed
 * 2026-07-14: page 2 carried 35 listings absent from page 1, 0 overlap). A
 * single render therefore captured only the first page and SILENTLY dropped the
 * rest — so `fetchAreaListings` walks `&page=N`. A page returning fewer than
 * this threshold is treated as the last (partial) page; only a full page of new
 * listings justifies paying for the next render. Well below the ~36 page size
 * so it never mistakes a full page for the last one, well above 0 so a small
 * area's single partial page stops immediately.
 */
const FULL_PAGE_THRESHOLD = 20;

/**
 * Hard cap on till-salu pages fetched per area. Page 1 is fetched first
 * (sequentially — it gates whether the area is even large enough to paginate);
 * if it comes back FULL, pages 2..`MAX_AREA_PAGES` are fetched IN PARALLEL (see
 * `fetchAreaListings`). Parallelism removes wall-clock as the binding
 * constraint — all remaining pages render concurrently, so total time is ≈ two
 * render-times (page 1, then the parallel batch) regardless of page count,
 * staying comfortably under the driving tick's ~300s ceiling. 5 pages ≈ 180
 * listings/area. The cap also bounds Apify concurrency (≤ MAX_AREA_PAGES-1
 * simultaneous renders per area) and the handful of wasted renders when the
 * real page count is below the cap (renders are ~0.06 SEK, so cost is not the
 * constraint). A genuinely huge area is bounded here rather than fetched to
 * exhaustion. (A price-sorted page 1 — cheapest-first — would make deep
 * pagination largely unnecessary for the below-market use case; a future
 * refinement.)
 */
export const MAX_AREA_PAGES = 5;

/**
 * Page cap for the HEADLESS run (Phase 14.2, R-04): `fetchAreaListings(..., { maxPages })`
 * pages until Booli's own count is reached but never beyond this many pages per district.
 * Local pages are free (about 5 s each, 0 USD), so the cap only guards against a runaway
 * count: 15 pages x ~36 cards = ~540 listings, above the largest filtered inner-city
 * district seen (Sodermalm 444 with 35 m2 and up on 2026-10-13). The in-app job keeps
 * `MAX_AREA_PAGES` (5); `cost.ts` mirrors that one, not this.
 */
export const HEADLESS_MAX_AREA_PAGES = 15;

/**
 * D-02 (13-CONTEXT.md, RESEARCH Open Question #1) — a scoped, materially
 * lower `waitSecs` ceiling for AREA-PAGE renders only. `runPlaywrightRender`'s
 * global default (240s) accounts for genuine detail-page Apify cold-start
 * latency; area pages attempt up to 2 rungs each, so an unbounded worst case
 * (~480s across up to 4 concurrent areas post-D-01) risks exceeding the
 * ~300s Vercel Server Action ceiling (`TICK_DISCOVERY_MAX_DURATION_SEC`).
 * 120s is a conservative first value, NOT re-proven against production
 * latency yet — instrument the existing `[booli-client] fetchAreaListings
 * page N served by rung...` log line (below) to observe real timing and
 * tighten later (13-03 live smoke). Exported for test assertions only.
 */
export const AREA_PAGE_WAIT_SECS = 120;

/**
 * 13-04 Task 3 (GAP-2, 13-SMOKE-FINDINGS.md fix item 3) — a scoped, materially
 * lower render envelope for VISION-ENRICHMENT detail-page fetches ONLY.
 * `fetchListing`'s own defaults (240s/3-retry) are the proven /analyze
 * single-listing budget and stay byte-for-byte unchanged for that call site.
 * But `enrichCandidateImages` (job.ts) calls `fetchListing` for up to
 * `VISION_ENRICH_LIMIT` candidates per job during a SINGLE client tick; the
 * unbounded 240s x up-to-3-retries x 2-rung worst case per candidate
 * (live-observed 13-03 smoke: a Booli 403 + 60s Cloudflare timeout looping
 * through the retry budget across both rungs) can burn the whole tick on one
 * blocked candidate. These two constants scope that one call site to the
 * 60-90s / 1-2-retry envelope 13-SMOKE-FINDINGS.md's fix item 3 recommends —
 * exported for test assertions only, mirroring `AREA_PAGE_WAIT_SECS`'s
 * precedent. Tunable; the 403 itself is environmental (local IP blocking),
 * NOT something these constants attempt to fix — `enrichCandidateImages`
 * already degrades gracefully on a failed/slow detail fetch.
 */
export const DETAIL_ENRICH_WAIT_SECS = 90;
export const DETAIL_ENRICH_MAX_RETRIES = 2;

/** Stable per-listing dedupe key across pages (booliId, else url). */
function listingKey(listing: Record<string, unknown>): string | null {
  const booliId = listing.booliId;
  if (typeof booliId === "string" && booliId) return `id:${booliId}`;
  const url = listing.url;
  if (typeof url === "string" && url) return `url:${url}`;
  return null;
}

/**
 * Fetches every active listing for `areaId` (+ optional `objectType` filter)
 * through the owned client.
 *
 * Pagination (05-RESEARCH.md Open Question 3, RESOLVED 2026-07-14): a live
 * probe confirmed `/sok/till-salu` truncates at ~36 listings/page (page 2 had
 * 35 listings absent from page 1, 0 overlap). This function therefore WALKS
 * `&page=N`: it fetches page 1, and if that page is FULL (≥ FULL_PAGE_THRESHOLD)
 * — i.e. the result set is large — it fetches pages 2..MAX_AREA_PAGES IN
 * PARALLEL and merges + de-dupes them (by booliId, else url). A short page 1 is
 * a small area returned in full — no extra fetch. Parallelism keeps wall-clock
 * ≈ two render-times regardless of page count.
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
 * empty `listings: []` for a sparse/new area instead of forcing it through the
 * `walkFallbackTree` exhaustion path and misreporting it as "source failed."
 *
 * Cost reporting (CR-01, 14-REVIEW.md): the returned `rendersUsed` is the REAL
 * paid-render count across every page and rung attempted (1..`MAX_AREA_PAGES` ×
 * `AREA_RENDER_RUNGS`), so `runSlice` can price its persisted ledger from what
 * actually happened instead of assuming one render per area.
 */
/**
 * The number of own-playwright rungs `fetchAreaPage` walks per page — i.e. the
 * maximum paid Apify renders ONE page can consume, and exactly the number
 * consumed when a page fails (all rungs attempted before `walkFallbackTree`
 * throws). CR-01 (14-REVIEW.md): `runSlice`'s cost ledger reads this so a
 * failed page is not silently accounted as 0 renders. Mirrored in
 * `discovery/cost.ts` as `AREA_RENDER_RUNGS_PER_PAGE`, with a drift guard in
 * `client.test.ts`.
 */
export const AREA_RENDER_RUNGS = 2;

/** ACQ-02 result: the merged listings PLUS the paid renders they cost (CR-01). */
export interface AreaListingsResult {
  listings: Record<string, unknown>[];
  /**
   * The real number of paid Apify renders this call consumed — every rung of
   * every page attempted, successful or not. `runSlice` prices the persisted
   * `cost_sek_total` from this rather than assuming one render per area, which
   * under-counted real spend by up to 10x and made `CAP_SEK_MAX`
   * unenforceable (CR-01, 14-REVIEW.md).
   */
  rendersUsed: number;
  /**
   * Booli's own till-salu count for this query, read from page 1 (Phase 14.2,
   * R-04); null when the page carried none. Additive: the in-app job ignores it.
   */
  totalCount: number | null;
  /** Booli's own Nyproduktion count for the same filter (page 1), or null. Part of `totalCount`. */
  newConstructionCount: number | null;
  /**
   * How many of the counted new-construction items Booli does not render as a card
   * (`newConstructionCount` minus the project cards actually collected). Measured
   * 2026-10-13: Sodermalm counts 4 and shows 1, Kungsholmen counts 8 and shows 3,
   * Vasastan counts 3 and shows 1. These are projects the pipeline drops anyway
   * (new construction has no renovation upside), so they count as "in hand" for
   * completeness. 0 when the Nyproduktion count is unknown.
   */
  unlistedProjects: number;
  /**
   * Whether every listing Booli counts is in hand:
   * `areaCompleteness(listings.length + unlistedProjects, totalCount)`. Null when Booli
   * printed no count; the caller reports null as incomplete (R-04). Use this, not a bare
   * `listings.length >= totalCount`, or three of the four inner-city districts would read
   * "ofullstandig" on every run because of the unlisted projects.
   */
  complete: boolean | null;
  /** Pages that came back with data (page 1 plus every later page that did not fail). */
  pagesFetched: number;
}

/** One page's outcome: its entities plus the renders that page consumed. */
interface AreaPageResult {
  listings: Record<string, unknown>[];
  /** Booli's till-salu count as printed on this page, or null. */
  totalCount: number | null;
  /** Booli's Nyproduktion count as printed on this page, or null. */
  newConstructionCount: number | null;
  rendersUsed: number;
}

/** The first `SearchMeta` count whose title satisfies `wanted`, or null. */
function searchMetaCount(items: unknown[], wanted: (title: string) => boolean): number | null {
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const state = (item as { __APOLLO_STATE__?: unknown }).__APOLLO_STATE__;
    if (!state || typeof state !== "object") continue;
    for (const [key, value] of Object.entries(state as Record<string, unknown>)) {
      if (!key.startsWith("SearchMeta:") || !value || typeof value !== "object") continue;
      const { totalCount, title } = value as { totalCount?: unknown; title?: unknown };
      if (typeof totalCount !== "number" || !Number.isInteger(totalCount) || totalCount < 0) continue;
      if (typeof title === "string" && wanted(title)) return totalCount;
    }
  }
  return null;
}

/**
 * Booli's own till-salu count out of the render items (Phase 14.2, R-04): the
 * `SearchMeta` entry whose title reads "till salu" and does not start with
 * "Nyproduktion". The same page also carries a Nyproduktion count and a
 * Slutpriser count (222 / 1 / 16 048 in the 2026-10-12 probe), which are not the
 * list being paged. Null when no such entry exists. Pure.
 */
export function totalCountFromItems(items: unknown[]): number | null {
  return searchMetaCount(items, (title) => /till salu/i.test(title) && !/^nyproduktion/i.test(title));
}

/**
 * Booli's Nyproduktion count for the same filter (title starts with
 * "Nyproduktion"). It is a subset of the till-salu count and is larger than the
 * number of project cards Booli renders (see `AreaListingsResult.unlistedProjects`).
 * Null when absent. Pure.
 */
export function newConstructionCountFromItems(items: unknown[]): number | null {
  return searchMetaCount(items, (title) => /^nyproduktion/i.test(title));
}

/**
 * Whether a district list is complete: every listing Booli counts is in hand
 * (`collected >= totalCount`). Null when Booli printed no count - an unknown
 * total is reported as incomplete by the caller, never as complete (R-04). Pure.
 */
export function areaCompleteness(collected: number, totalCount: number | null): boolean | null {
  if (totalCount === null) return null;
  return collected >= totalCount;
}

const isProject = (listing: Record<string, unknown>): boolean => listing.isNewConstruction === true;

/**
 * Lower bound on the pages the headless run walks, from page 1 alone (Phase 14.2,
 * R-04): `ceil(listings Booli renders / page-1 size)`, never above `maxPages`. With
 * no usable count it is the old full-page rule (a page 1 with `FULL_PAGE_THRESHOLD`
 * or more entries walks on up to `maxPages`). It is a LOWER bound because page 1 can
 * carry extra project cards (Kungsholmen: 38 cards against 35 on every later page), so
 * a result of 2 or more is then refined from page 2's real size (`pagesFromSizes`).
 * Pure.
 */
function pagesToFetch(page1Size: number, renderable: number | null, maxPages: number): number {
  if (maxPages <= 1) return 1;
  if (renderable !== null && renderable > 0 && page1Size > 0) {
    return Math.max(1, Math.min(Math.ceil(renderable / page1Size), maxPages));
  }
  return page1Size >= FULL_PAGE_THRESHOLD ? maxPages : 1;
}

/**
 * The exact page count once page 2's size is known: page 1, then enough pages of
 * `regularSize` for the rest, within `maxPages`. A page 2 shorter than
 * `FULL_PAGE_THRESHOLD` is the last page (the same rule the in-app path uses).
 * Pure.
 */
function pagesFromSizes(renderable: number, page1Size: number, regularSize: number, maxPages: number): number {
  if (regularSize < FULL_PAGE_THRESHOLD) return 2;
  const needed = 1 + Math.ceil(Math.max(0, renderable - page1Size) / regularSize);
  return Math.max(2, Math.min(needed, maxPages));
}

/**
 * Renders ONE till-salu page for `areaId` through the two own-playwright rungs
 * and returns its `Listing:` entities plus the renders consumed
 * (`result.rung` — the same `rendersUsed: result.rung` convention
 * `fetchSoldComps` already uses). Throws (HIGH-1) only when BOTH rungs fail —
 * the caller decides whether that's fatal (page 1) or skippable (a later page
 * in the parallel batch) — and a throw means all `AREA_RENDER_RUNGS` renders
 * were paid for.
 */
async function fetchAreaPage(
  areaId: string,
  objectType: string | null | undefined,
  page: number,
  minLivingArea?: number | null,
): Promise<AreaPageResult> {
  const url = buildTillSaluUrl(areaId, objectType, page, minLivingArea);
  const readPage = (items: unknown[]) => ({
    listings: extractListingEntities(items),
    totalCount: totalCountFromItems(items),
    newConstructionCount: newConstructionCountFromItems(items),
  });
  const rungs = [
    {
      source: "own-playwright" as const,
      attempt: () =>
        runPlaywrightRender(url, APOLLO_PAGE_FUNCTION, { waitSecs: AREA_PAGE_WAIT_SECS }).then(readPage),
    },
    {
      source: "own-playwright-retry" as const,
      attempt: () =>
        runPlaywrightRender(url, APOLLO_PAGE_FUNCTION, { waitSecs: AREA_PAGE_WAIT_SECS }).then(readPage),
    },
  ];
  const result = await walkFallbackTree(rungs);
  console.error(
    `[booli-client] fetchAreaListings page ${page} served by rung ${result.rung} (${result.source}, health=${result.health})`,
  );
  return { ...result.data, rendersUsed: result.rung };
}

/**
 * `opts.maxPages` (Phase 14.2, additive): the HEADLESS run's completeness mode.
 * The page count comes from Booli's own total, never more than `maxPages` (the
 * headless caller passes `HEADLESS_MAX_AREA_PAGES`):
 *  - page 1 gives the count and a lower bound (`ceil(renderable / page-1 size)`);
 *  - if more pages are needed, page 2 is fetched next and its size (the regular
 *    page size) fixes the exact page count, because page 1 can carry extra project
 *    cards (Kungsholmen 38 against 35, which left 32 listings unread when the count
 *    was divided by page 1's size); the remaining pages run in parallel;
 *  - "renderable" is the count minus the new-construction items Booli counts but
 *    does not render as cards (`AreaListingsResult.unlistedProjects`);
 *  - with no count it falls back to the old full-page rule up to `maxPages`.
 * `opts.minLivingArea` adds Booli's server-side minimum-area filter to every page URL.
 *
 * A call WITHOUT `opts` behaves exactly as in 14.1 (page 1, then pages
 * 2..`MAX_AREA_PAGES` when page 1 is full), so the in-app path is unchanged
 * (D-02). The result's `totalCount`, `newConstructionCount`, `unlistedProjects`,
 * `complete` and `pagesFetched` are additive.
 */
export async function fetchAreaListings(
  areaId: string,
  objectType?: string | null,
  opts?: { maxPages?: number; minLivingArea?: number },
): Promise<AreaListingsResult> {
  const seen = new Set<string>();
  const collected: Record<string, unknown>[] = [];
  // CR-01: accumulated from every page's real rung count, never assumed.
  let rendersUsed = 0;
  let pagesFetched = 0;
  const minLivingArea = opts?.minLivingArea ?? null;
  const addNew = (listings: Record<string, unknown>[]): void => {
    for (const listing of listings) {
      const key = listingKey(listing);
      if (key !== null && seen.has(key)) continue; // dedupe across pages
      if (key !== null) seen.add(key);
      collected.push(listing);
    }
  };

  // Fetches the given pages IN PARALLEL — each is an independent ~15-45s render, so
  // concurrency collapses the wall-clock to ~one render instead of N sequential ones.
  // `allSettled`: a later page failing (block/timeout) is NON-FATAL — keep every page
  // that did come back rather than discard a large partial result over one bad render.
  // Pages beyond the real last page return empty/duplicate and are absorbed by the dedupe.
  // Returns each page's outcome (null for a failed page), in the order asked.
  const fetchPages = async (pages: number[]): Promise<(AreaPageResult | null)[]> => {
    const settled = await Promise.allSettled(
      pages.map((page) => fetchAreaPage(areaId, objectType, page, minLivingArea)),
    );
    return settled.map((outcome, i) => {
      if (outcome.status === "fulfilled") {
        rendersUsed += outcome.value.rendersUsed;
        pagesFetched += 1;
        addNew(outcome.value.listings);
        return outcome.value;
      }
      // CR-01: a failed page still consumed EVERY rung's render — bill them.
      // Under-counting a spend gate is the dangerous direction.
      rendersUsed += AREA_RENDER_RUNGS;
      console.error(
        `[booli-client] fetchAreaListings page ${pages[i]} failed (non-fatal; keeping ${collected.length} listings)`,
        { code: outcome.reason instanceof Error ? outcome.reason.name : "UNKNOWN" },
      );
      return null;
    });
  };
  const range = (from: number, to: number): number[] =>
    Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

  // Page 1 first, sequentially. Its failure IS the kill-switch / dead-source
  // signal (HIGH-1, both own rungs failed) → propagate so the caller degrades,
  // exactly as the pre-pagination single-render path did. Its SIZE also decides
  // whether the area is large enough to paginate at all.
  const page1 = await fetchAreaPage(areaId, objectType, 1, minLivingArea);
  rendersUsed += page1.rendersUsed;
  pagesFetched += 1;
  addNew(page1.listings);

  if (opts?.maxPages === undefined) {
    // In-app (14.1 rule): only a FULL page 1 implies a large result set worth
    // paginating; a short page 1 is a small area already returned in full.
    if (page1.listings.length >= FULL_PAGE_THRESHOLD) await fetchPages(range(2, MAX_AREA_PAGES));
  } else {
    // Headless: Booli's own count decides. Items Booli counts but never renders as a
    // card are taken off first, estimated from page 1 (the project cards it shows).
    const maxPages = opts.maxPages;
    const unlistedOnPage1 =
      page1.newConstructionCount === null
        ? 0
        : Math.max(0, page1.newConstructionCount - page1.listings.filter(isProject).length);
    const renderable = page1.totalCount === null ? null : Math.max(0, page1.totalCount - unlistedOnPage1);
    const estimate = pagesToFetch(page1.listings.length, renderable, maxPages);
    if (estimate > 1 && renderable !== null && renderable > 0) {
      const [second] = await fetchPages([2]);
      const regular = second?.listings.length ?? 0;
      // A failed page 2 leaves the size unknown: keep the page-1 lower bound.
      const last = regular > 0 ? pagesFromSizes(renderable, page1.listings.length, regular, maxPages) : estimate;
      await fetchPages(range(3, last));
    } else if (estimate > 1) {
      await fetchPages(range(2, estimate));
    }
  }

  const unlistedProjects =
    page1.newConstructionCount === null
      ? 0
      : Math.max(0, page1.newConstructionCount - collected.filter(isProject).length);
  console.error(
    `[booli-client] fetchAreaListings collected ${collected.length} listings for area ${areaId} (${rendersUsed} renders)`,
  );
  return {
    listings: collected,
    rendersUsed,
    totalCount: page1.totalCount,
    newConstructionCount: page1.newConstructionCount,
    unlistedProjects,
    complete: areaCompleteness(collected.length + unlistedProjects, page1.totalCount),
    pagesFetched,
  };
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
