import { z } from "zod/v4";
import { CAP_CANDIDATES_MAX, type DiscoveryFilter } from "@/lib/discovery/filter-schema";
import { visionResultSchema, type VisionResult } from "@/lib/discovery/vision-schema";
import { extractOrientationFromDescription, type Facade } from "@/lib/discovery/sun-path";
import { isAllowedImageHost } from "@/lib/booli/client";

// Null-tolerant coercion helpers (mirror src/lib/booli/client.ts:43-46) — a
// malformed/partial raw record yields null fields, never a throw.
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
/** Non-empty string array or null — mirrors num()/str()'s null-tolerant discipline. */
const arrOfStr = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((item) => typeof item === "string" && item.length > 0)
    ? (v as string[])
    : null;
/**
 * Unwraps a raw Apollo `FormattedValue` (`{raw: N}`) OR a bare number to a
 * plain number, else null — mirrors `normalizeScraperOutput`'s existing
 * `num(raw.floor) ?? rawOf(raw.floor)` unwrap exactly (src/lib/schemas/listing.ts,
 * RESEARCH.md Open Question 5). `toCandidate` receives `reshapeListingEntity`'s
 * output DIRECTLY on the fetchAreaListings/job.ts path (no
 * `normalizeScraperOutput` step in between), so `floor` still carries the
 * un-normalized `{raw: 3}` shape there — `num()` alone would silently null it.
 */
const rawOf = (v: unknown): number | null =>
  v && typeof v === "object" && "raw" in v
    ? num((v as { raw: unknown }).raw)
    : null;

/**
 * The PII-safe, persisted candidate shape (DISC-07 guardrail). This is a
 * documented explicit allowlist — it mirrors Phase 8's "v1 auto-fetch stores
 * no raw HTML for audit" convention (STATE.md). The raw `Listing:` Apollo
 * entity or broker description text may carry seller/occupant PII (names,
 * phone numbers, org.nr, board member lists) and must NEVER be persisted;
 * only these SEVENTEEN fields may ever land in `discovery_jobs.results`.
 *
 * Phase 10 (DISC-03) adds `constructionYear`, `brfName`, and `tenureForm` —
 * all three are already computed by `reshapeListingEntity`
 * (src/lib/booli/client.ts) at zero extra network cost. `brfName` is a BRF's
 * registered name (e.g. "Brf Björken 3"), which is public-registry data, the
 * same class as `areaLabel` — not occupant/seller PII (RESEARCH Assumption A1).
 *
 * Phase 11 (DISC-04) adds `imageUrls`, `vision`, and `visionSkippedReason`.
 * `imageUrls` is already-public Booli CDN URLs (same PII class as
 * `thumbnailUrl`/`sourceListingUrl`), host-allowlisted and capped at
 * `CAP_IMAGES_PER_LISTING` extraction-time in `client.ts`'s
 * `extractImageUrls`. `vision`/`visionSkippedReason` are a later pass's
 * output (11-RESEARCH.md "Structural Separation + Citation") — always `null`
 * at `toCandidate` time.
 *
 * Phase 12 (DISC-06) adds `latitude`, `longitude`, `floor`, and `orientation`.
 * `latitude`/`longitude`/`floor` are already extracted by
 * `reshapeListingEntity` at zero extra network cost (join-key/Phase-6
 * passthroughs). `orientation` is NEVER the raw `description` text — it is
 * the DERIVED `extractOrientationFromDescription()` result ({facades,
 * confidence} | null), computed ONCE at `toCandidate` time. `description`
 * itself is deliberately excluded from this interface and the allowlist — it
 * is a documented PII carrier (broker free text occasionally contains
 * seller names/phone numbers, 12-RESEARCH.md Pitfall 3) and is read ONLY as
 * a local argument inside `toCandidate`, never stored.
 */
export interface DiscoveryCandidate {
  address: string | null;
  price: number | null;
  rooms: number | null;
  livingArea: number | null;
  areaLabel: string | null;
  thumbnailUrl: string | null;
  sourceListingUrl: string | null;
  constructionYear: number | null;
  brfName: string | null;
  tenureForm: string | null;
  // Phase 11 (DISC-04) additions — additive-nullable, no migration (matches
  // Phase 10's constructionYear/brfName/tenureForm precedent exactly).
  // `imageUrls` is scraped at candidate-creation time (near-zero marginal
  // cost, already in the Apollo entity); `vision`/`visionSkippedReason` are
  // ALWAYS null here — vision runs as a SEPARATE later pass (Plan 02/03),
  // never at scrape/toCandidate time.
  imageUrls: string[] | null;
  vision: VisionResult | null;
  visionSkippedReason: "no_images" | "cost_cap" | "vision_error" | null;
  // Phase 12 (DISC-06) additions — additive-nullable, no migration (matches
  // Phase 10's constructionYear/brfName/tenureForm precedent exactly).
  // latitude/longitude/floor are ALREADY extracted elsewhere in the codebase
  // (client.ts's join-key latitude/longitude passthrough; the Phase 6 floor
  // passthrough) — zero new scraping/network cost, simply threaded into the
  // allowlist for the first time. `orientation` is NEVER the raw description
  // text (PII risk, RESEARCH.md Pitfall 3) — only the DERIVED
  // extractOrientationFromDescription() result is persisted.
  latitude: number | null;
  longitude: number | null;
  floor: number | null;
  orientation: { facades: Facade[]; confidence: number } | null;
}

/**
 * Price per square metre for a candidate, or `null` when it can't be computed
 * honestly (missing price/area, or a non-positive area that would produce
 * Infinity/NaN). WR-06 (shard-5 review): SINGLE source of this guard — the
 * discovery-results baseline reducer and the per-card "Pris/kvm" both use it,
 * so the `price/livingArea` null+positive-area guard can never drift between
 * the two and silently feed Infinity/NaN into the niche median.
 */
export function pricePerSqm(
  candidate: Pick<DiscoveryCandidate, "price" | "livingArea">,
): number | null {
  const { price, livingArea } = candidate;
  if (price === null || livingArea === null || livingArea <= 0) return null;
  return price / livingArea;
}

/**
 * Maps a flat `reshapeListingEntity`-shaped record (src/lib/booli/client.ts)
 * onto the PII-safe `DiscoveryCandidate` allowlist.
 *
 * This function CONSTRUCTS a fresh object literal containing exactly the
 * allowlist keys — it never spreads `...raw` — so any extra field on the raw
 * record (agencyName, breadcrumbs, a nested housingCoop, broker description
 * text, etc.) structurally cannot leak into the returned shape. Missing or
 * malformed fields yield `null`, never a throw and never a fabricated value.
 *
 * `raw.brfName` is ALREADY computed by `reshapeListingEntity`
 * (client.ts:227) via `brfNameFromBreadcrumbs` — this mapper reads it as a
 * plain string field and does NOT re-derive it from `raw.breadcrumbs`.
 *
 * @param raw - a flat listing record, e.g. the output of `reshapeListingEntity`
 * @returns the PII-safe candidate shape
 */
export function toCandidate(raw: Record<string, unknown>): DiscoveryCandidate {
  return {
    address: str(raw.streetAddress),
    price: num(raw.price),
    rooms: num(raw.rooms),
    livingArea: num(raw.livingArea),
    areaLabel: str(raw.descriptiveAreaName),
    thumbnailUrl: str(raw.thumbnailUrl),
    sourceListingUrl: str(raw.url),
    constructionYear: num(raw.constructionYear),
    brfName: str(raw.brfName),
    tenureForm: str(raw.tenureForm),
    imageUrls: arrOfStr(raw.imageUrls),
    vision: null,
    visionSkippedReason: null,
    latitude: num(raw.latitude),
    longitude: num(raw.longitude),
    // Mirrors normalizeScraperOutput's own unwrap (RESEARCH.md Open Question
    // 5): toCandidate receives reshapeListingEntity's output DIRECTLY on the
    // fetchAreaListings/job.ts path, where floor is still the raw Apollo
    // `{raw: N}` FormattedValue shape, not a bare number.
    floor: num(raw.floor) ?? rawOf(raw.floor),
    // `raw.description` is read ONLY as a local argument here, fed into the
    // deterministic extractor, and discarded — it is NEVER added as a key on
    // this returned object literal (no-spread construction + explicit
    // omission keeps the derived-only PII contract structurally enforced).
    orientation: extractOrientationFromDescription(str(raw.description)),
  };
}

/**
 * Read-path Zod guard for `discovery_jobs.results` (mirrors the dashboard's
 * `listingDataSchema.safeParse` discipline — CR-01). A malformed/shape-drifted
 * row degrades to a skipped candidate rather than crashing the results page
 * on an unguarded field dereference. Intentionally mirrors the
 * `DiscoveryCandidate` allowlist shape exactly (nullable fields only, no
 * `.min()/.max()` chains needed since this is a read-path guard, not an
 * LLM-facing schema).
 */
export const discoveryCandidateSchema = z.object({
  address: z.string().nullable(),
  price: z.number().nullable(),
  rooms: z.number().nullable(),
  livingArea: z.number().nullable(),
  areaLabel: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  sourceListingUrl: z.string().nullable(),
  // Phase 10 (DISC-03) additions — `.nullable().default(null)` (NOT
  // `.nullable().optional()`) so a pre-Phase-10 persisted row that is missing
  // these keys entirely still `safeParse`s AND the parsed value is
  // normalized to `null` (never `undefined`), matching `DiscoveryCandidate`'s
  // non-optional nullable field types exactly (RESEARCH Open Question 2,
  // resolved: no migration, no backfill, additive-nullable-default per
  // project convention — CR-01 fix: `.optional()` alone let a missing key
  // parse to `undefined`, which `niche-score.ts`'s `=== null` guards do not
  // catch, silently producing `NaN` scores for legacy rows).
  constructionYear: z.number().nullable().default(null),
  brfName: z.string().nullable().default(null),
  tenureForm: z.string().nullable().default(null),
  // Phase 11 (DISC-04) additions — SAME `.nullable().default(null)` discipline
  // (NEVER `.optional()` alone) so a pre-Phase-11 persisted row missing these
  // 3 keys entirely still safeParses AND normalizes to `null` (not
  // `undefined`) — this file's own CR-01 fix comment above explains why an
  // `undefined` would silently break `=== null` guards downstream.
  //
  // WR-03 (12-REVIEW.md): `isAllowedImageHost` (src/lib/booli/client.ts) is
  // enforced at WRITE time (`extractImageUrls`) but was NOT re-checked on
  // this READ-path guard — any string passed the write-time check. Since
  // `gallery-condition-vision.tsx` renders these directly in an
  // `<img src={...}>`, a tampered/corrupted persisted row (future migration
  // bug, manual DB edit, or a later write-path bug) could inject a
  // non-Booli URL that gets rendered with no read-path defense-in-depth.
  // `.transform()` re-applies the SAME allowlist check here and drops any
  // offending URL rather than trusting it unconditionally on read — this
  // degrades gracefully (fewer images shown) instead of failing the whole
  // candidate parse or rendering an untrusted URL.
  imageUrls: z
    .array(z.string())
    .nullable()
    .default(null)
    .transform((urls) => (urls === null ? null : urls.filter(isAllowedImageHost))),
  vision: visionResultSchema.nullable().default(null),
  // CR-02 (11-REVIEW.md) adds "vision_error" — a per-candidate Claude call
  // failure (refusal, transient API error, malformed image fetch) degrades
  // ONLY that candidate to this reason; it never aborts the whole vision
  // pass or strands the job's already-scraped results (see runVisionPass's
  // per-candidate try/catch, vision.ts).
  visionSkippedReason: z.enum(["no_images", "cost_cap", "vision_error"]).nullable().default(null),
  // Phase 12 (DISC-06) additions — SAME `.nullable().default(null)` discipline
  // (NEVER `.optional()` alone) so a pre-Phase-12 persisted row missing these
  // 4 keys entirely still safeParses AND normalizes to `null` (not
  // `undefined`) — this file's own CR-01 fix comment above explains why an
  // `undefined` would silently break `=== null` guards downstream.
  // `orientation`'s bounded enum + float shape cannot itself carry PII.
  latitude: z.number().nullable().default(null),
  longitude: z.number().nullable().default(null),
  floor: z.number().nullable().default(null),
  orientation: z
    .object({
      facades: z.array(z.enum(["north", "east", "south", "west"])),
      confidence: z.number(),
    })
    .nullable()
    .default(null),
});

/** Result of filtering a candidate array: what's shown vs. how many matched. */
export interface FilterCandidatesResult {
  shown: DiscoveryCandidate[];
  scanned: number;
}

/**
 * Deterministically narrows a candidate array against the structured
 * `DiscoveryFilter` (DISC-01). This is 100% in-code logic — NEVER
 * Claude-driven; the Haiku intent parse only produces the filter values fed
 * in here.
 *
 * Applies the AND of every NON-null filter clause:
 *   - priceMax  → candidate.price <= priceMax
 *   - roomsMin  → candidate.rooms >= roomsMin
 *   - sizeMin   → candidate.livingArea >= sizeMin
 *
 * `objectType` filtering happens upstream via `fetchAreaListings`'s
 * objectType param and is intentionally NOT re-applied here. A null filter
 * field is skipped entirely (never treated as a match-nothing constraint —
 * avoids the PostgREST-NULL-trap-style logic error in pure code). A
 * candidate with a null value for a field the filter constrains is treated
 * as non-matching for that clause (fails closed: we cannot verify the
 * constraint, so we do not claim it matches).
 *
 * Truncates the matched list to `cap` (default `CAP_CANDIDATES_MAX`) while
 * still reporting the true `scanned` count (input length) for
 * scanned-vs-shown honesty in the UI.
 *
 * @param candidates - PII-safe candidates to filter
 * @param filter - the structured filter (nullable numeric fields ignored when null)
 * @param cap - max candidates to return in `shown`
 */
export function filterCandidates(
  candidates: DiscoveryCandidate[],
  filter: DiscoveryFilter,
  cap: number = CAP_CANDIDATES_MAX,
): FilterCandidatesResult {
  const matched = candidates.filter((candidate) => {
    if (filter.priceMax !== null) {
      if (candidate.price === null || candidate.price > filter.priceMax) return false;
    }
    if (filter.roomsMin !== null) {
      if (candidate.rooms === null || candidate.rooms < filter.roomsMin) return false;
    }
    if (filter.sizeMin !== null) {
      if (candidate.livingArea === null || candidate.livingArea < filter.sizeMin) return false;
    }
    return true;
  });

  return {
    shown: matched.slice(0, cap),
    scanned: candidates.length,
  };
}
