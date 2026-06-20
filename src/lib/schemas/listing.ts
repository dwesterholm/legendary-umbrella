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
  };
}
