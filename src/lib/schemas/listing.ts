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
});

export type ScraperOutput = z.infer<typeof scraperOutputSchema>;
export type ListingData = z.infer<typeof listingDataSchema>;

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

  return {
    address: str(raw.streetAddress),
    price: num(raw.price) ?? rawOf(raw.listPrice),
    livingArea: rawOf(raw.livingArea) ?? num(raw.livingArea),
    rooms: num(raw.rooms),
    monthlyFee: num(raw.rent) ?? rawOf(raw.listRent),
    buildYear: num(raw.constructionYear),
    brfName: str(raw.brfName), // not provided by current actor -- kept for future sources
    prisPerKvm: rawOf(raw.listSqmPrice),
  };
}
