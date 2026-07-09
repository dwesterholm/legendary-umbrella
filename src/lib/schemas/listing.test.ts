import { describe, it, expect } from "vitest";
import {
  normalizeScraperOutput,
  scraperOutputSchema,
  listingDataSchema,
  type Sourced,
} from "@/lib/schemas/listing";

/**
 * Regression guard for the Phase 5 "no-op migration" claim (05-RESEARCH.md,
 * 05-VALIDATION.md Wave 0): `normalizeScraperOutput`/`scraperOutputSchema`
 * currently have zero direct unit tests. This file proves the coercion
 * helpers (`num`/`str`/`rawOf`/`idStr`/`crumbs`) already tolerate BOTH the
 * flat paid-actor shape (today's `booli-scraper.ts`) and the detail-page
 * Apollo-entity shape the new owned client (Plan 05-0x) will produce —
 * without any change to `listing.ts` itself, which stays read-only this
 * phase.
 *
 * Style follows `src/lib/market/sold-source.test.ts`: plain describe/it/
 * expect, no mocks, inline literal fixtures (independent of the live-probe
 * fixture Plan 02 captures, so this test goes green immediately).
 */

// A paid-actor-shaped raw payload: flat `price` number, `livingArea` as a
// formatted-value `{ raw }` object, `booliId` as a string, breadcrumbs array.
// Mirrors the real shape documented in listing.ts's own field-name comment.
const actorShapedRaw = {
  url: "https://www.booli.se/bostad/305443",
  streetAddress: "Helgagatan 1",
  price: 4_200_000,
  rent: 3_800,
  constructionYear: 1929,
  rooms: 3,
  livingArea: { raw: 68, formatted: "68 m²" },
  listSqmPrice: { raw: 61_764, formatted: "61 764 kr/m²" },
  latitude: 59.3089341,
  longitude: 18.06933923,
  booliId: "305443",
  breadcrumbs: [
    { label: "Stockholms län", url: "https://www.booli.se/sok/slutpriser?areaIds=2" },
    { label: "Södermalm", url: "https://www.booli.se/sok/slutpriser?areaIds=115341" },
  ],
};

// The SAME logical listing, shaped as a detail-page Apollo entity would
// surface it: no bare `price` field at all — only `listPrice` as a `{ raw }`
// formatted-value object (normalizeScraperOutput's documented fallback:
// `num(raw.price) ?? rawOf(raw.listPrice)`) — plus `booliId` as a number
// rather than a string. These are the two shape divergences 05-RESEARCH.md
// calls out as tolerated by `rawOf()`/`idStr()`.
const detailPageShapedRaw = {
  url: "https://www.booli.se/bostad/305443",
  streetAddress: "Helgagatan 1",
  listPrice: { raw: 4_200_000, formatted: "4 200 000 kr" },
  rent: 3_800,
  constructionYear: 1929,
  rooms: 3,
  livingArea: { raw: 68, formatted: "68 m²" },
  listSqmPrice: { raw: 61_764, formatted: "61 764 kr/m²" },
  latitude: 59.3089341,
  longitude: 18.06933923,
  booliId: 305443,
  breadcrumbs: [
    { label: "Stockholms län", url: "https://www.booli.se/sok/slutpriser?areaIds=2" },
    { label: "Södermalm", url: "https://www.booli.se/sok/slutpriser?areaIds=115341" },
  ],
};

describe("normalizeScraperOutput — regression guard for the no-op migration claim", () => {
  it("maps a paid-actor-shaped raw payload to the expected NormalizedListing", () => {
    const result = normalizeScraperOutput(actorShapedRaw);
    expect(result).toEqual({
      address: "Helgagatan 1",
      price: 4_200_000,
      livingArea: 68,
      rooms: 3,
      monthlyFee: 3_800,
      buildYear: 1929,
      brfName: null,
      prisPerKvm: 61_764,
      latitude: 59.3089341,
      longitude: 18.06933923,
      booliId: "305443",
      breadcrumbs: actorShapedRaw.breadcrumbs,
      floor: null,
      balcony: null,
      renovationStatus: null,
      description: null,
    });
  });

  it("maps the SAME logical listing shaped as a detail-page Apollo entity (listPrice instead of price, numeric booliId) to the SAME NormalizedListing (no-op-migration proof)", () => {
    const result = normalizeScraperOutput(detailPageShapedRaw);
    expect(result).toEqual(normalizeScraperOutput(actorShapedRaw));
  });

  it("a { raw }-shaped listPrice (detail-page shape) and a bare-number price (actor shape) normalize to the same value — the concrete no-op-migration assertion", () => {
    const fromObjectShape = normalizeScraperOutput(detailPageShapedRaw).price;
    const fromBareNumber = normalizeScraperOutput(actorShapedRaw).price;
    expect(fromObjectShape).toBe(4_200_000);
    expect(fromObjectShape).toBe(fromBareNumber);
  });

  it("booliId as a number (detail-page shape) and booliId as a string (actor shape) coerce to the same string", () => {
    expect(normalizeScraperOutput(detailPageShapedRaw).booliId).toBe("305443");
    expect(normalizeScraperOutput(actorShapedRaw).booliId).toBe("305443");
  });

  it("scraperOutputSchema.safeParse succeeds on the actor-shaped payload and feeds normalizeScraperOutput unchanged", () => {
    const parsed = scraperOutputSchema.safeParse(actorShapedRaw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = normalizeScraperOutput(parsed.data);
    expect(result.address).toBe("Helgagatan 1");
    expect(result.price).toBe(4_200_000);
  });

  it("scraperOutputSchema tolerates extra/unknown keys via .passthrough()", () => {
    const withExtra = { ...actorShapedRaw, someBrandNewActorField: "unexpected" };
    const parsed = scraperOutputSchema.safeParse(withExtra);
    expect(parsed.success).toBe(true);
  });

  it("missing/absent optional fields coerce to null without throwing", () => {
    const sparse = {
      streetAddress: "Bar Street 2",
      // no price, no rooms, no livingArea, no rent, no brfName, no
      // breadcrumbs, no coordinates, no booliId.
    };
    expect(() => normalizeScraperOutput(sparse)).not.toThrow();
    const result = normalizeScraperOutput(sparse);
    expect(result).toEqual({
      address: "Bar Street 2",
      price: null,
      livingArea: null,
      rooms: null,
      monthlyFee: null,
      buildYear: null,
      brfName: null,
      prisPerKvm: null,
      latitude: null,
      longitude: null,
      booliId: null,
      breadcrumbs: null,
      floor: null,
      balcony: null,
      renovationStatus: null,
      description: null,
    });
  });

  it("coerces an entirely empty raw payload to an all-null NormalizedListing without throwing", () => {
    expect(() => normalizeScraperOutput({})).not.toThrow();
    const result = normalizeScraperOutput({});
    expect(result.address).toBeNull();
    expect(result.price).toBeNull();
    expect(result.breadcrumbs).toBeNull();
  });
});

/**
 * Phase 6 (06-01-PLAN.md Task 1, LSTG-03/04): the five "fields Booli lacks"
 * per the ROADMAP. Three (floor/balcony/brfName) are recovered from the
 * Apollo entity with zero broker fetch; the schema/normalize layer here
 * just needs to accept/coerce them. renovationStatus/description have no
 * Apollo representation and are pure broker-page gap-fill candidates
 * (Plan 02) — this layer only needs to accept them as nullable strings.
 */
describe("listingDataSchema — Phase 6 nullable field extensions (floor/balcony/renovationStatus/description)", () => {
  const baseValid = {
    url: "https://www.booli.se/bostad/305443",
    address: "Testgatan 1",
    price: 4_500_000,
    livingArea: 36,
    rooms: 1,
    monthlyFee: 3_329,
    buildYear: 1926,
    brfName: "HSB BRF Metern",
    prisPerKvm: 125_000,
    latitude: 59.31,
    longitude: 18.07,
    booliId: "4463691",
    breadcrumbs: null,
  };

  it("accepts floor/balcony/renovationStatus/description as populated values", () => {
    const parsed = listingDataSchema.safeParse({
      ...baseValid,
      floor: 3,
      balcony: true,
      renovationStatus: "nyrenoverat 2020",
      description: "Ljus och fin lägenhet med balkong.",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts floor/balcony/renovationStatus/description as null", () => {
    const parsed = listingDataSchema.safeParse({
      ...baseValid,
      floor: null,
      balcony: null,
      renovationStatus: null,
      description: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects floor as a string (must be number|null)", () => {
    const parsed = listingDataSchema.safeParse({
      ...baseValid,
      floor: "3",
      balcony: null,
      renovationStatus: null,
      description: null,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects balcony as a number (must be boolean|null)", () => {
    const parsed = listingDataSchema.safeParse({
      ...baseValid,
      floor: null,
      balcony: 1,
      renovationStatus: null,
      description: null,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("listingDataSchema — Phase 6 Plan 03 fieldSources provenance + brokerFetchFailed", () => {
  const baseValid = {
    url: "https://www.booli.se/bostad/305443",
    address: "Testgatan 1",
    price: 4_500_000,
    livingArea: 36,
    rooms: 1,
    monthlyFee: 3_329,
    buildYear: 1926,
    brfName: "HSB BRF Metern",
    prisPerKvm: 125_000,
    latitude: 59.31,
    longitude: 18.07,
    booliId: "4463691",
    breadcrumbs: null,
    floor: 3,
    balcony: true,
    renovationStatus: "nyrenoverat 2020",
    description: "Ljus och fin lägenhet med balkong.",
  };

  it("accepts a fully-populated fieldSources map tagging each field booli|maklare", () => {
    const parsed = listingDataSchema.safeParse({
      ...baseValid,
      fieldSources: {
        floor: "booli",
        balcony: "booli",
        brfName: "booli",
        renovationStatus: "maklare",
        description: "maklare",
      },
      brokerFetchFailed: false,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a null fieldSources value and a null/omitted brokerFetchFailed (old persisted rows lack these keys)", () => {
    const parsed = listingDataSchema.safeParse({
      ...baseValid,
      fieldSources: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("omits fieldSources/brokerFetchFailed entirely and still parses (additive-optional, no migration)", () => {
    const parsed = listingDataSchema.safeParse(baseValid);
    expect(parsed.success).toBe(true);
  });

  it("rejects a fieldSources entry with a source value outside booli|maklare|null", () => {
    const parsed = listingDataSchema.safeParse({
      ...baseValid,
      fieldSources: {
        floor: "scraped",
        balcony: null,
        brfName: null,
        renovationStatus: null,
        description: null,
      },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("Sourced<T> provenance type (LSTG-04 groundwork for Plan 02's gap-fill merge)", () => {
  it("a null-value / null-source Sourced<T> type-checks", () => {
    const sourced: Sourced<number> = { value: null, source: null };
    expect(sourced.value).toBeNull();
    expect(sourced.source).toBeNull();
  });

  it("a populated Sourced<T> with source constrained to booli|maklare|null type-checks", () => {
    const fromBooli: Sourced<number> = { value: 3, source: "booli" };
    const fromMaklare: Sourced<string> = { value: "nyrenoverat 2020", source: "maklare" };
    expect(fromBooli).toEqual({ value: 3, source: "booli" });
    expect(fromMaklare).toEqual({ value: "nyrenoverat 2020", source: "maklare" });
  });
});

describe("normalizeScraperOutput — Phase 6 floor/balcony/renovationStatus/description extraction", () => {
  it("reads floor/balcony/renovationStatus/description off a raw object, leaving existing fields unchanged", () => {
    const raw = {
      streetAddress: "Testgatan 1",
      price: 4_500_000,
      floor: 3,
      balcony: true,
      renovationStatus: "nyrenoverat 2020",
      description: "Ljus och fin lägenhet.",
    };
    const result = normalizeScraperOutput(raw);
    expect(result.floor).toBe(3);
    expect(result.balcony).toBe(true);
    expect(result.renovationStatus).toBe("nyrenoverat 2020");
    expect(result.description).toBe("Ljus och fin lägenhet.");
    // Existing fields unaffected by the new extraction.
    expect(result.address).toBe("Testgatan 1");
    expect(result.price).toBe(4_500_000);
  });

  it("returns null for floor/balcony/renovationStatus/description when absent from the raw object", () => {
    const result = normalizeScraperOutput({ streetAddress: "Bar Street 2" });
    expect(result.floor).toBeNull();
    expect(result.balcony).toBeNull();
    expect(result.renovationStatus).toBeNull();
    expect(result.description).toBeNull();
  });

  it("tolerates a { raw } formatted-value shape for floor (Apollo entity shape) as well as a bare number", () => {
    expect(normalizeScraperOutput({ floor: { raw: 3 } }).floor).toBe(3);
    expect(normalizeScraperOutput({ floor: 3 }).floor).toBe(3);
  });

  it("rejects a non-boolean balcony value (never coerces truthy/falsy) rather than fabricating a boolean", () => {
    expect(normalizeScraperOutput({ balcony: "yes" }).balcony).toBeNull();
    expect(normalizeScraperOutput({ balcony: 1 }).balcony).toBeNull();
  });
});
