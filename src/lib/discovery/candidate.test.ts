import { describe, it, expect } from "vitest";
// RED: implemented below in this same task (src/lib/discovery/candidate.ts).
import {
  toCandidate,
  filterCandidates,
  discoveryCandidateSchema,
  type DiscoveryCandidate,
} from "@/lib/discovery/candidate";
import { CAP_CANDIDATES_MAX, type DiscoveryFilter } from "@/lib/discovery/filter-schema";

const ALLOWLIST_KEYS = [
  "address",
  "price",
  "rooms",
  "livingArea",
  "areaLabel",
  "thumbnailUrl",
  "sourceListingUrl",
  "constructionYear",
  "brfName",
  "tenureForm",
  "imageUrls",
  "vision",
  "visionSkippedReason",
  // Phase 12 (DISC-06) additions — latitude/longitude/floor + DERIVED
  // orientation (never the raw description text — RESEARCH.md Pitfall 3).
  "latitude",
  "longitude",
  "floor",
  "orientation",
  // Ranking/status factors — balcony + coming-soon/new-production discriminators.
  "balcony",
  "upcomingSale",
  "isNewConstruction",
].sort();

describe("toCandidate — PII-safe allowlist mapper", () => {
  it("returns ONLY the allowlisted fields, even when raw carries extra PII-bearing fields", () => {
    const raw = {
      streetAddress: "Sveavägen 1",
      descriptiveAreaName: "Norrmalm",
      price: 3_500_000,
      rooms: 2,
      livingArea: 55,
      url: "https://www.booli.se/annons/123",
      thumbnailUrl: "https://img.example/thumb.jpg",
      constructionYear: 1962,
      brfName: "Brf Björken 3",
      tenureForm: "Bostadsrätt",
      // Extra fields a raw Apollo/broker entity might carry — must NOT leak.
      agencyName: "Fastighetsbyrån",
      breadcrumbs: [{ label: "Stockholm" }],
      housingCoop: { orgNr: "769600-1234", boardMembers: ["Anna", "Björn"] },
      brokerDescription: "Kontakta säljaren Kalle Karlsson på 070-1234567",
      // Phase 12: description itself must NOT leak — only the derived
      // orientation (via extractOrientationFromDescription) is allowlisted.
      description: "Kontakta säljaren Kalle Karlsson på 070-1234567 för visning.",
    };

    const result = toCandidate(raw);

    expect(Object.keys(result).sort()).toEqual(ALLOWLIST_KEYS);
    expect(Object.prototype.hasOwnProperty.call(result, "description")).toBe(false);
  });

  it("maps the flat reshapeListingEntity field names onto the allowlist", () => {
    const raw = {
      streetAddress: "Sveavägen 1",
      descriptiveAreaName: "Norrmalm",
      price: 3_500_000,
      rooms: 2,
      livingArea: 55,
      url: "https://www.booli.se/annons/123",
      thumbnailUrl: "https://img.example/thumb.jpg",
      constructionYear: 1962,
      brfName: "Brf Björken 3",
      tenureForm: "Bostadsrätt",
      imageUrls: ["https://bcdn.booli.se/img/1.jpg", "https://bcdn.booli.se/img/2.jpg"],
      latitude: 59.33,
      longitude: 18.06,
      floor: 3,
    };

    const result = toCandidate(raw);

    expect(result).toEqual<DiscoveryCandidate>({
      address: "Sveavägen 1",
      price: 3_500_000,
      rooms: 2,
      livingArea: 55,
      areaLabel: "Norrmalm",
      thumbnailUrl: "https://img.example/thumb.jpg",
      sourceListingUrl: "https://www.booli.se/annons/123",
      constructionYear: 1962,
      brfName: "Brf Björken 3",
      tenureForm: "Bostadsrätt",
      imageUrls: ["https://bcdn.booli.se/img/1.jpg", "https://bcdn.booli.se/img/2.jpg"],
      vision: null,
      visionSkippedReason: null,
      latitude: 59.33,
      longitude: 18.06,
      floor: 3,
      orientation: null,
      balcony: null,
      upcomingSale: null,
      isNewConstruction: null,
    });
  });

  it("absolutizes a RELATIVE area-search url so the Booli link + detail enrichment work", () => {
    // Area-search entities carry a root-relative url; a relative sourceListingUrl
    // breaks both the UI link and fetchListing (isBooliUrl rejects it).
    expect(toCandidate({ url: "/bostad/3914794" }).sourceListingUrl).toBe(
      "https://www.booli.se/bostad/3914794",
    );
    // An already-absolute url (detail entity) passes through unchanged.
    expect(toCandidate({ url: "https://www.booli.se/annons/1" }).sourceListingUrl).toBe(
      "https://www.booli.se/annons/1",
    );
    // A non-URL / garbage value never fabricates a link.
    expect(toCandidate({ url: "not a url" }).sourceListingUrl).toBeNull();
  });

  it("yields null (never throws, never fabricates) for missing rooms/livingArea/imageUrls/latitude/longitude/floor/orientation", () => {
    const raw = {
      streetAddress: "Sveavägen 1",
      descriptiveAreaName: "Norrmalm",
      price: 3_500_000,
      url: "https://www.booli.se/annons/123",
    };

    const result = toCandidate(raw);

    expect(result.rooms).toBeNull();
    expect(result.livingArea).toBeNull();
    expect(result.thumbnailUrl).toBeNull();
    expect(result.constructionYear).toBeNull();
    expect(result.brfName).toBeNull();
    expect(result.tenureForm).toBeNull();
    expect(result.imageUrls).toBeNull();
    expect(result.vision).toBeNull();
    expect(result.visionSkippedReason).toBeNull();
    expect(result.latitude).toBeNull();
    expect(result.longitude).toBeNull();
    expect(result.floor).toBeNull();
    expect(result.orientation).toBeNull();
  });

  it("recovers rooms/livingArea/floor from displayDataPoints + asking price from listPrice (area-search shape)", () => {
    // Booli's AREA-search entity carries no flat rooms/livingArea/floor and no
    // realized `price` — rooms/area/floor live only in displayDataPoints, and
    // the asking price is `listPrice`. Without the fallbacks every discovery
    // candidate ranked with null size/rooms/price.
    const raw = {
      streetAddress: "Torkel Knutssonsgatan 35",
      listPrice: 4_250_000,
      displayDataPoints: [
        { value: { plainText: "72+8 m²" } }, // primary area 72 (biarea ignored)
        { value: { plainText: "2,5 rum" } },
        { value: { plainText: "vån 2" } },
        { value: { plainText: "3 731 kr/mån" } }, // fee — must NOT be read as price
      ],
    };

    const result = toCandidate(raw);

    expect(result.livingArea).toBe(72);
    expect(result.rooms).toBe(2.5);
    expect(result.floor).toBe(2);
    expect(result.price).toBe(4_250_000);
  });

  it("prefers flat detail-entity fields over displayDataPoints when both exist (detail path unaffected)", () => {
    const raw = {
      streetAddress: "Helgagatan 36N",
      price: 4_500_000,
      rooms: 1,
      livingArea: 36,
      displayDataPoints: [{ value: { plainText: "99 m²" } }, { value: { plainText: "9 rum" } }],
    };

    const result = toCandidate(raw);

    expect(result.price).toBe(4_500_000);
    expect(result.rooms).toBe(1);
    expect(result.livingArea).toBe(36);
  });

  it("unwraps floor from the raw {raw: N} FormattedValue shape (reshapeListingEntity's un-normalized passthrough, RESEARCH.md Open Question 5)", () => {
    // toCandidate receives reshapeListingEntity's output DIRECTLY on the
    // fetchAreaListings/job.ts path (no normalizeScraperOutput step) — floor
    // is still the raw Apollo FormattedValue `{raw: 3}` shape there, not a
    // bare number. num(raw.floor) alone would silently yield null.
    const raw = {
      streetAddress: "Sveavägen 1",
      floor: { raw: 3 },
    };

    const result = toCandidate(raw);

    expect(result.floor).toBe(3);
  });

  it("derives orientation from a description containing a väderstreck keyword WITHOUT persisting the raw description text (PII-safe, DISC-07)", () => {
    const raw = {
      streetAddress: "Sveavägen 1",
      description: "Ljus lägenhet i söderläge med stor balkong.",
    };

    const result = toCandidate(raw);

    expect(result.orientation).toEqual({ facades: ["south"], confidence: 0.5 });
    expect(Object.prototype.hasOwnProperty.call(result, "description")).toBe(false);
  });

  it("yields orientation:null (never fabricated) AND never persists description when the text contains seller PII but no väderstreck keyword", () => {
    const raw = {
      streetAddress: "Sveavägen 1",
      description: "Kontakta säljaren Kalle Karlsson på 070-1234567 för visning.",
    };

    const result = toCandidate(raw);

    expect(result.orientation).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(result, "description")).toBe(false);
  });

  it("vision and visionSkippedReason are ALWAYS null at toCandidate time, even when raw carries stray keys with those names", () => {
    // vision is a SEPARATE later pass — toCandidate must never read/trust a
    // raw `vision`/`visionSkippedReason` key even if one were present.
    const raw = {
      streetAddress: "Sveavägen 1",
      vision: { claims: [{ attribute: "kitchen", claim: "fake" }] },
      visionSkippedReason: "cost_cap",
    };

    const result = toCandidate(raw);

    expect(result.vision).toBeNull();
    expect(result.visionSkippedReason).toBeNull();
  });
});

describe("discoveryCandidateSchema — additive-optional backward compatibility (RESEARCH Open Q2)", () => {
  it("still safeParses an OLD pre-Phase-10 persisted row missing the 3 new keys entirely", () => {
    // Exactly the pre-Phase-10 7-key shape — constructionYear/brfName/tenureForm
    // are absent as KEYS, not just null-valued, proving `.optional()` (not just
    // `.nullable()`) is required for old `discovery_jobs.results` rows to parse.
    const oldShapeRow = {
      address: "Sveavägen 1",
      price: 3_500_000,
      rooms: 2,
      livingArea: 55,
      areaLabel: "Norrmalm",
      thumbnailUrl: "https://img.example/thumb.jpg",
      sourceListingUrl: "https://www.booli.se/annons/123",
    };

    const result = discoveryCandidateSchema.safeParse(oldShapeRow);

    expect(result.success).toBe(true);
  });

  it("still parses a NEW row that carries the 3 additions with real values", () => {
    const newShapeRow = {
      address: "Sveavägen 1",
      price: 3_500_000,
      rooms: 2,
      livingArea: 55,
      areaLabel: "Norrmalm",
      thumbnailUrl: "https://img.example/thumb.jpg",
      sourceListingUrl: "https://www.booli.se/annons/123",
      constructionYear: 1962,
      brfName: "Brf Björken 3",
      tenureForm: "Bostadsrätt",
    };

    const result = discoveryCandidateSchema.safeParse(newShapeRow);

    expect(result.success).toBe(true);
  });

  it("CR-01 regression: an OLD row missing the 3 new keys parses them to null, never undefined", () => {
    // The exact legacy scenario CR-01 identified: `.nullable().optional()`
    // let a missing key parse to `undefined`, which niche-score.ts's
    // `=== null` guards did not catch, silently corrupting scores with NaN.
    // `.nullable().default(null)` must normalize the missing key to `null`.
    const oldShapeRow = {
      address: "Sveavägen 1",
      price: 3_500_000,
      rooms: 2,
      livingArea: 55,
      areaLabel: "Norrmalm",
      thumbnailUrl: "https://img.example/thumb.jpg",
      sourceListingUrl: "https://www.booli.se/annons/123",
    };

    const result = discoveryCandidateSchema.safeParse(oldShapeRow);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.constructionYear).toBeNull();
      expect(result.data.brfName).toBeNull();
      expect(result.data.tenureForm).toBeNull();
      // Explicitly not undefined — `toBeNull()` alone would also pass for a
      // key that's simply absent from the object; assert presence too.
      expect(Object.prototype.hasOwnProperty.call(result.data, "constructionYear")).toBe(
        true,
      );
      expect(result.data.constructionYear).not.toBeUndefined();
    }
  });
});

describe("discoveryCandidateSchema — Phase 11 (DISC-04) additive-nullable extension", () => {
  it("still safeParses a pre-Phase-11 row missing imageUrls/vision/visionSkippedReason entirely, normalizing all three to null", () => {
    // A Phase-10-shaped row (constructionYear/brfName/tenureForm present) but
    // with NO imageUrls/vision/visionSkippedReason keys at all — the exact
    // legacy scenario this task's must_haves require.
    const phase10ShapeRow = {
      address: "Sveavägen 1",
      price: 3_500_000,
      rooms: 2,
      livingArea: 55,
      areaLabel: "Norrmalm",
      thumbnailUrl: "https://img.example/thumb.jpg",
      sourceListingUrl: "https://www.booli.se/annons/123",
      constructionYear: 1962,
      brfName: "Brf Björken 3",
      tenureForm: "Bostadsrätt",
    };

    const result = discoveryCandidateSchema.safeParse(phase10ShapeRow);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.imageUrls).toBeNull();
      expect(result.data.vision).toBeNull();
      expect(result.data.visionSkippedReason).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(result.data, "imageUrls")).toBe(true);
      expect(result.data.imageUrls).not.toBeUndefined();
    }
  });

  it("parses a NEW row carrying real imageUrls + a vision result", () => {
    const newShapeRow = {
      address: "Sveavägen 1",
      price: 3_500_000,
      rooms: 2,
      livingArea: 55,
      areaLabel: "Norrmalm",
      thumbnailUrl: "https://img.example/thumb.jpg",
      sourceListingUrl: "https://www.booli.se/annons/123",
      constructionYear: 1962,
      brfName: "Brf Björken 3",
      tenureForm: "Bostadsrätt",
      imageUrls: ["https://bcdn.booli.se/img/1.jpg"],
      vision: {
        claims: [
          {
            attribute: "kitchen",
            claim: "Köket verkar renoverat",
            imageIndex: 1,
            whatWasSeen: "nya vitvaror",
            confidence: 0.8,
          },
        ],
        imageUrlsUsed: ["https://bcdn.booli.se/img/1.jpg"],
        model: "claude-sonnet-4-6",
        costSek: 0.29,
        ranAt: "2026-07-07T12:00:00.000Z",
      },
      visionSkippedReason: null,
    };

    const result = discoveryCandidateSchema.safeParse(newShapeRow);

    expect(result.success).toBe(true);
  });

  // WR-03 (12-REVIEW.md): the write-path host-allowlist (`isAllowedImageHost`,
  // client.ts) must ALSO be re-enforced on this read-path guard — a
  // tampered/corrupted persisted row carrying a non-Booli-CDN URL must have
  // that URL dropped, not trusted through to rendering.
  it("drops a non-allowlisted (non-booli.se) URL from a persisted row's imageUrls, keeping the allowlisted ones", () => {
    const tamperedRow = {
      address: "Sveavägen 1",
      price: 3_500_000,
      rooms: 2,
      livingArea: 55,
      areaLabel: "Norrmalm",
      thumbnailUrl: null,
      sourceListingUrl: "https://www.booli.se/annons/123",
      imageUrls: [
        "https://bcdn.booli.se/img/1.jpg",
        "https://evil.example/phish.jpg",
        "https://booli.se/img/2.jpg",
      ],
      vision: null,
      visionSkippedReason: null,
    };

    const result = discoveryCandidateSchema.safeParse(tamperedRow);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.imageUrls).toEqual([
        "https://bcdn.booli.se/img/1.jpg",
        "https://booli.se/img/2.jpg",
      ]);
    }
  });

  it("still safeParses (imageUrls: null) when imageUrls is null on a persisted row", () => {
    const row = {
      address: "Sveavägen 1",
      price: 3_500_000,
      rooms: 2,
      livingArea: 55,
      areaLabel: "Norrmalm",
      thumbnailUrl: null,
      sourceListingUrl: "https://www.booli.se/annons/123",
      imageUrls: null,
      vision: null,
      visionSkippedReason: null,
    };

    const result = discoveryCandidateSchema.safeParse(row);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.imageUrls).toBeNull();
    }
  });

  it("parses a row with no images (visionSkippedReason: 'no_images')", () => {
    const noImagesRow = {
      address: "Sveavägen 1",
      price: 3_500_000,
      rooms: 2,
      livingArea: 55,
      areaLabel: "Norrmalm",
      thumbnailUrl: null,
      sourceListingUrl: "https://www.booli.se/annons/123",
      imageUrls: null,
      vision: null,
      visionSkippedReason: "no_images",
    };

    const result = discoveryCandidateSchema.safeParse(noImagesRow);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.visionSkippedReason).toBe("no_images");
    }
  });
});

describe("discoveryCandidateSchema — Phase 12 (DISC-06) additive-nullable extension", () => {
  it("still safeParses a pre-Phase-12 row missing latitude/longitude/floor/orientation entirely, normalizing all four to null", () => {
    // A Phase-11-shaped row (imageUrls/vision/visionSkippedReason present)
    // but with NO latitude/longitude/floor/orientation keys at all — the
    // exact legacy scenario this task's must_haves require.
    const phase11ShapeRow = {
      address: "Sveavägen 1",
      price: 3_500_000,
      rooms: 2,
      livingArea: 55,
      areaLabel: "Norrmalm",
      thumbnailUrl: "https://img.example/thumb.jpg",
      sourceListingUrl: "https://www.booli.se/annons/123",
      constructionYear: 1962,
      brfName: "Brf Björken 3",
      tenureForm: "Bostadsrätt",
      imageUrls: ["https://bcdn.booli.se/img/1.jpg"],
      vision: null,
      visionSkippedReason: null,
    };

    const result = discoveryCandidateSchema.safeParse(phase11ShapeRow);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.latitude).toBeNull();
      expect(result.data.longitude).toBeNull();
      expect(result.data.floor).toBeNull();
      expect(result.data.orientation).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(result.data, "latitude")).toBe(true);
      expect(result.data.latitude).not.toBeUndefined();
    }
  });

  it("parses a NEW row carrying real latitude/longitude/floor + a derived orientation", () => {
    const newShapeRow = {
      address: "Sveavägen 1",
      price: 3_500_000,
      rooms: 2,
      livingArea: 55,
      areaLabel: "Norrmalm",
      thumbnailUrl: "https://img.example/thumb.jpg",
      sourceListingUrl: "https://www.booli.se/annons/123",
      constructionYear: 1962,
      brfName: "Brf Björken 3",
      tenureForm: "Bostadsrätt",
      imageUrls: null,
      vision: null,
      visionSkippedReason: null,
      latitude: 59.33,
      longitude: 18.06,
      floor: 3,
      orientation: { facades: ["south"], confidence: 0.5 },
    };

    const result = discoveryCandidateSchema.safeParse(newShapeRow);

    expect(result.success).toBe(true);
  });
});

describe("filterCandidates — deterministic in-code AND filter", () => {
  const candidates: DiscoveryCandidate[] = [
    {
      address: "A",
      price: 3_000_000,
      rooms: 3,
      livingArea: 70,
      areaLabel: "Södermalm",
      thumbnailUrl: null,
      sourceListingUrl: "https://www.booli.se/annons/1",
      constructionYear: null,
      brfName: null,
      tenureForm: null,
      imageUrls: null,
      vision: null,
      visionSkippedReason: null,
      latitude: null,
      longitude: null,
      floor: null,
      orientation: null,
      balcony: null,
      upcomingSale: null,
      isNewConstruction: null,
    },
    {
      address: "B",
      price: 5_000_000,
      rooms: 2,
      livingArea: 40,
      areaLabel: "Södermalm",
      thumbnailUrl: null,
      sourceListingUrl: "https://www.booli.se/annons/2",
      constructionYear: null,
      brfName: null,
      tenureForm: null,
      imageUrls: null,
      vision: null,
      visionSkippedReason: null,
      latitude: null,
      longitude: null,
      floor: null,
      orientation: null,
      balcony: null,
      upcomingSale: null,
      isNewConstruction: null,
    },
  ];

  const filter: DiscoveryFilter = {
    areaQuery: "Södermalm",
    priceMax: 4_000_000,
    roomsMin: 3,
    sizeMin: null,
    objectType: "Alla",
    confidence: 0.9,
  };

  it("applies every non-null filter clause as a deterministic AND", () => {
    const result = filterCandidates(candidates, filter);

    expect(result.shown).toHaveLength(1);
    expect(result.shown[0]?.address).toBe("A");
    expect(result.scanned).toBe(2);
  });

  it("always excludes upcomingSale (kommande) and new-production listings, regardless of the numeric filter", () => {
    const mixed: DiscoveryCandidate[] = [
      { ...candidates[0], address: "active", upcomingSale: false, isNewConstruction: false },
      { ...candidates[0], address: "kommande", upcomingSale: true },
      { ...candidates[0], address: "nyproduktion", isNewConstruction: true },
    ];
    const noopFilter: DiscoveryFilter = {
      areaQuery: "Södermalm",
      priceMax: null,
      roomsMin: null,
      sizeMin: null,
      objectType: "Alla",
      confidence: 0.9,
    };

    const result = filterCandidates(mixed, noopFilter);

    expect(result.shown.map((c) => c.address)).toEqual(["active"]);
    expect(result.scanned).toBe(3);
  });

  it("ignores null filter fields (never treats null as a match-nothing constraint)", () => {
    const allNullFilter: DiscoveryFilter = {
      areaQuery: "Södermalm",
      priceMax: null,
      roomsMin: null,
      sizeMin: null,
      objectType: "Alla",
      confidence: 0.9,
    };

    const result = filterCandidates(candidates, allNullFilter);

    expect(result.shown).toHaveLength(2);
    expect(result.scanned).toBe(2);
  });

  it("truncates shown to the cap even when more candidates match, but reports the true scanned count", () => {
    const many: DiscoveryCandidate[] = Array.from({ length: CAP_CANDIDATES_MAX + 5 }, (_, i) => ({
      address: `Address ${i}`,
      price: 1_000_000,
      rooms: 2,
      livingArea: 50,
      areaLabel: "Södermalm",
      thumbnailUrl: null,
      sourceListingUrl: `https://www.booli.se/annons/${i}`,
      constructionYear: null,
      brfName: null,
      tenureForm: null,
      imageUrls: null,
      vision: null,
      visionSkippedReason: null,
      latitude: null,
      longitude: null,
      floor: null,
      orientation: null,
      balcony: null,
      upcomingSale: null,
      isNewConstruction: null,
    }));

    const noopFilter: DiscoveryFilter = {
      areaQuery: "Södermalm",
      priceMax: null,
      roomsMin: null,
      sizeMin: null,
      objectType: "Alla",
      confidence: 0.9,
    };

    const result = filterCandidates(many, noopFilter);

    expect(result.shown).toHaveLength(CAP_CANDIDATES_MAX);
    expect(result.scanned).toBe(CAP_CANDIDATES_MAX + 5);
  });
});
