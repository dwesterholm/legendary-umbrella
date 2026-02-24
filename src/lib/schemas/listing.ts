import { z } from "zod/v4";

// What the Apify scraper returns (flexible -- we don't control this)
// Field names are best-guess from RESEARCH.md -- first real scrape will confirm
export const scraperOutputSchema = z.object({
  url: z.string().url(),
  address: z.string().optional(),
  price: z.number().optional(),
  livingArea: z.number().optional(),
  rooms: z.number().optional(),
  monthlyFee: z.number().optional(),
  buildYear: z.number().optional(),
  floor: z.string().optional(),
  brfName: z.string().optional(),
  propertyType: z.string().optional(),
  neighborhood: z.string().optional(),
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
