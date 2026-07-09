import { describe, it, expect } from "vitest";
// RED: implemented below in this same task (src/lib/discovery/filter-schema.ts).
import {
  intentFilterSchema,
  CAP_CANDIDATES_MAX,
  CAP_SEK_MAX,
  CAP_IMAGES_PER_LISTING,
} from "@/lib/discovery/filter-schema";

describe("intentFilterSchema — slim Claude-facing structured filter", () => {
  it("parses a fully-specified filter and yields those exact values", () => {
    const result = intentFilterSchema.parse({
      areaQuery: "Södermalm",
      priceMax: 4_000_000,
      roomsMin: 3,
      sizeMin: null,
      objectType: "Lägenhet",
      confidence: 0.8,
    });

    expect(result).toEqual({
      areaQuery: "Södermalm",
      priceMax: 4_000_000,
      roomsMin: 3,
      sizeMin: null,
      objectType: "Lägenhet",
      confidence: 0.8,
    });
  });

  it("accepts null for every optional numeric field", () => {
    const result = intentFilterSchema.parse({
      areaQuery: "Vasastan",
      priceMax: null,
      roomsMin: null,
      sizeMin: null,
      objectType: "Alla",
      confidence: 0.5,
    });

    expect(result.priceMax).toBeNull();
    expect(result.roomsMin).toBeNull();
    expect(result.sizeMin).toBeNull();
  });

  it("rejects a missing areaQuery (required string)", () => {
    expect(() =>
      intentFilterSchema.parse({
        priceMax: null,
        roomsMin: null,
        sizeMin: null,
        objectType: "Alla",
        confidence: 0.5,
      }),
    ).toThrow();
  });
});

describe("hard-cap constants", () => {
  it("CAP_CANDIDATES_MAX is within the locked 20-30 band", () => {
    expect(CAP_CANDIDATES_MAX).toBeGreaterThanOrEqual(20);
    expect(CAP_CANDIDATES_MAX).toBeLessThanOrEqual(30);
  });

  it("CAP_SEK_MAX is a positive number", () => {
    expect(typeof CAP_SEK_MAX).toBe("number");
    expect(CAP_SEK_MAX).toBeGreaterThan(0);
  });

  it("CAP_IMAGES_PER_LISTING is 4 (Phase 11 activation: 1 floor plan + up to 3 gallery photos)", () => {
    expect(CAP_IMAGES_PER_LISTING).toBe(4);
  });
});
