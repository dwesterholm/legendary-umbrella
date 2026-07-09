import { z } from "zod/v4";

// Booli formatted-value objects, e.g. { formatted: "49 m²", value: "49", raw: 49, unit: "m²" }
const formattedValueSchema = z.object({
  raw: z.number().optional(),
  value: z.string().optional(),
  formatted: z.string().optional(),
  unit: z.string().optional(),
});

// What the Apify scraper (lexis-solutions/booli-se-scraper) actually returns.
// Field names confirmed against a real scrape 2026-06-06.
// Note: the actor does NOT return BRF name or floor -- brfName stays null until
// Phase 2 resolves it via address lookup.
export const scraperOutputSchema = z.object({
  url: z.string().optional(),
  streetAddress: z.string().optional(),
  descriptiveAreaName: z.string().optional(),
  price: z.number().optional(),
  rent: z.number().optional(),
  estimate: z.number().optional(),
  constructionYear: z.number().optional(),
  rooms: z.number().optional(),
  livingArea: formattedValueSchema.optional(),
  listPrice: formattedValueSchema.optional(),
  listRent: formattedValueSchema.optional(),
  listSqmPrice: formattedValueSchema.optional(),
  objectType: z.string().optional(),
  tenureForm: z.string().optional(),
}).passthrough(); // Allow additional fields from actor without breaking

// A single breadcrumb entry, confirmed live (03-SPIKE.md §2): wide→narrow area
// ladder, each carrying a label + a url whose `areaIds=<N>` param is the Booli
// areaId. Both keys are optional; the array is nullable for partial-data tolerance.
export const breadcrumbSchema = z.object({
  label: z.string().optional(),
  url: z.string().optional(),
});

// Our internal model for display
export const listingDataSchema = z.object({
  url: z.string().url(),
  address: z.string(),
  price: z.number(),
  livingArea: z.number(),
  rooms: z.number(),
  monthlyFee: z.number().nullable(),
  buildYear: z.number().nullable(),
  brfName: z.string().nullable(),
  prisPerKvm: z.number(),
  // Retained from raw actor output (03-SPIKE.md): the join key for both Phase 3
  // panels. Nullable — existing rows / partial scrapes degrade gracefully.
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  booliId: z.string().nullable(),
  breadcrumbs: z.array(breadcrumbSchema).nullable(),
  // Phase 6 (LSTG-03/04) — five "fields Booli lacks" per the ROADMAP; three
  // (floor/balcony/brfName) are recovered from the Apollo entity with no
  // broker fetch (client.ts reshapeListingEntity), the other two
  // (renovationStatus/description) are broker-page-sourced gap-fill
  // candidates (Plan 02). Additive .nullable() only — no migration, JSONB
  // `listing_data` column absorbs these directly (STATE.md additive-nullable
  // posture).
  floor: z.number().nullable(),
  balcony: z.boolean().nullable(),
  renovationStatus: z.string().nullable(),
  description: z.string().nullable(),
  // Phase 6 Plan 03 (LSTG-04) — per-field provenance for the five recovered
  // fields above, so the UI can render a "Källa: Booli" / "Källa: Mäklarens
  // annons" caption per populated field (UI-SPEC Copywriting Contract).
  // Additive + nullable/optional — old persisted rows simply lack this key
  // and the UI treats a missing entry the same as a null value (no caption).
  fieldSources: z
    .object({
      floor: z.enum(["booli", "maklare"]).nullable(),
      balcony: z.enum(["booli", "maklare"]).nullable(),
      brfName: z.enum(["booli", "maklare"]).nullable(),
      renovationStatus: z.enum(["booli", "maklare"]).nullable(),
      description: z.enum(["booli", "maklare"]).nullable(),
    })
    .nullable()
    .optional(),
  // Whether the broker-page enrichment fetch failed (T-06-08) — surfaced to
  // ListingSummary as a soft, non-blocking banner. Persisted inside the
  // existing JSONB listing_data blob (no new DB column/migration) so it
  // survives the authenticated redirect-to-DB-row path the same way
  // `partial` does today.
  brokerFetchFailed: z.boolean().nullable().optional(),
});

export type ScraperOutput = z.infer<typeof scraperOutputSchema>;
export type ListingData = z.infer<typeof listingDataSchema>;
export type Breadcrumb = z.infer<typeof breadcrumbSchema>;

// Normalized primitives extracted from raw scraper output
export interface NormalizedListing {
  address: string | null;
  price: number | null;
  livingArea: number | null;
  rooms: number | null;
  monthlyFee: number | null;
  buildYear: number | null;
  brfName: string | null;
  prisPerKvm: number | null;
  // Coordinates + area ladder retained from the actor (03-SPIKE.md §2) — the
  // join key for the price-comparison + area-stats panels. All nullable.
  latitude: number | null;
  longitude: number | null;
  booliId: string | null;
  breadcrumbs: Breadcrumb[] | null;
  // Phase 6 (LSTG-03/04) — see listingDataSchema comment above.
  floor: number | null;
  balcony: boolean | null;
  renovationStatus: string | null;
  description: string | null;
}

/**
 * Provenance tag for a Phase 6 gap-filled field (LSTG-04): which source, if
 * any, ultimately supplied the value. `null` means neither source had it.
 */
export type ListingSource = "booli" | "maklare" | null;

/**
 * A single gap-filled field paired with its provenance. Plan 02's
 * merge-listing-fields.ts populates these; analyze.ts and listing-summary.tsx
 * both consume the shape, so it's co-located here with the other schema
 * types rather than buried in a broker-specific module.
 */
export interface Sourced<T> {
  value: T | null;
  source: ListingSource;
}

/**
 * Maps the actor's field names to our internal model.
 * Tolerates partial/missing data -- every field falls back to null.
 */
export function normalizeScraperOutput(
  raw: Record<string, unknown>
): NormalizedListing {
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
  // breadcrumbs: retained as-is when the actor returns an array, else null.
  const crumbs = (v: unknown): Breadcrumb[] | null =>
    Array.isArray(v) ? (v as Breadcrumb[]) : null;

  return {
    address: str(raw.streetAddress),
    price: num(raw.price) ?? rawOf(raw.listPrice),
    livingArea: rawOf(raw.livingArea) ?? num(raw.livingArea),
    rooms: num(raw.rooms),
    monthlyFee: num(raw.rent) ?? rawOf(raw.listRent),
    buildYear: num(raw.constructionYear),
    brfName: str(raw.brfName), // not provided by current actor -- kept for future sources
    prisPerKvm: rawOf(raw.listSqmPrice),
    // Retained join-key fields (03-SPIKE.md): actor already returns these.
    latitude: num(raw.latitude),
    longitude: num(raw.longitude),
    booliId: idStr(raw.booliId),
    breadcrumbs: crumbs(raw.breadcrumbs),
    // Phase 6 (LSTG-03) — floor/balcony recovered from the Apollo entity via
    // client.ts's reshapeListingEntity (floor as a bare number after rawOf,
    // but tolerate a bare number here too in case a future source surfaces
    // it directly); renovationStatus/description are broker-page gap-fill
    // candidates (Plan 02) with no representation in the Apollo entity today.
    floor: num(raw.floor) ?? rawOf(raw.floor),
    balcony: typeof raw.balcony === "boolean" ? raw.balcony : null,
    renovationStatus: str(raw.renovationStatus),
    description: str(raw.description),
  };
}
