import { z } from "zod/v4";

/**
 * The CLAUDE-FACING structured-filter schema (Phase 9 free-text → filter
 * intent parse — DISC-01/DISC-02). This mirrors the slim-schema discipline
 * established in `src/lib/brf/extract.ts`: ONLY the optional numeric fields
 * are `.nullable()` and there are NO `.min()/.max()/.int()` chains anywhere.
 * That discipline avoids the two documented Anthropic strict-output 400s
 * ("grammar too large" / "too many union-type params" — see this project's
 * own `anthropic-structured-output-limits` memory, a hard project rule, not
 * a style choice).
 */
export const intentFilterSchema = z.object({
  areaQuery: z
    .string()
    .describe("Free-text place/area name to resolve, e.g. 'Södermalm'"),
  priceMax: z.number().nullable().describe("Max price SEK, null if unspecified"),
  roomsMin: z.number().nullable().describe("Min rooms, null if unspecified"),
  sizeMin: z
    .number()
    .nullable()
    .describe("Min living area sqm, null if unspecified"),
  objectType: z
    .enum(["Lägenhet", "Villa", "Radhus", "Alla"])
    .describe("Property type, 'Alla' if unspecified"),
  confidence: z
    .number()
    .describe("0-1 confidence the parse captures user intent"),
});

/** The structured filter shape produced by a free-text intent parse. */
export type DiscoveryFilter = z.infer<typeof intentFilterSchema>;

/**
 * Hard cap on the number of candidates a single discovery job may return.
 * Locked to the 20-30 band (roadmap D decision): large enough to be useful,
 * small enough to keep per-search render/token spend bounded under the
 * <$100/mo budget posture (09-RESEARCH.md cost math).
 */
export const CAP_CANDIDATES_MAX = 25 as const;

/**
 * Hard per-search SEK spend ceiling. RESEARCH's cost math (Haiku intent
 * parse + CAP_CANDIDATES_MAX renders) lands comfortably under 1 SEK/search
 * in the typical case; this cap is the incremental-check ceiling a job must
 * never cross (checked BEFORE each render, not only at completion —
 * 09-PATTERNS.md "Anti-Patterns to Avoid").
 */
export const CAP_SEK_MAX = 5 as const;

/**
 * Per-listing image cap. Declared in Phase 9 for the DISC-07 contract as a
 * no-op placeholder (Phase 9 is retrieval-only and fetched no per-listing
 * images). Phase 11 (DISC-04, 11-01-PLAN.md Task 2) activates it: 1 floor
 * plan + up to 3 gallery photos per listing, matching CONTEXT.md's locked
 * "floor plan + 2-3 gallery" language (11-RESEARCH.md Recommended caps
 * table). Enforced at EXTRACTION time in `src/lib/booli/client.ts`'s
 * `extractImageUrls`, not at vision-call time, so the persisted PII-safe
 * allowlist itself never carries more than this budget (T-11-03).
 */
export const CAP_IMAGES_PER_LISTING = 4 as const;
