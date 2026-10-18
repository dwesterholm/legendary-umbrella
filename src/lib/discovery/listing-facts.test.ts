// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { apifyClientMockFactory } from "@/lib/booli/__mocks__/apify-client";
import { EXTRACT_STATE_BROWSER_FN } from "@/lib/booli/page-functions";

// client.ts loads transport.ts, which constructs an ApifyClient at import time.
vi.mock("apify-client", () => apifyClientMockFactory());

// Imported AFTER the mock above is registered.
import { reshapeListingEntity } from "@/lib/booli/client";
import {
  FACTS_CONSTANTS,
  candidateFactsSchema,
  daysOnMarketFromText,
  emptyFacts,
  factsFromCard,
  factsFromDetail,
  landLeaseFromText,
  mergeFacts,
  type CandidateFacts,
} from "@/lib/discovery/listing-facts";

const FIXTURE_DIR = join(__dirname, "..", "booli", "__fixtures__");
const AS_OF = "2026-10-13";

/** Real detail pages captured through the local rung on 2026-10-13 (sanitized). */
function detailRaw(n: 1 | 2 | 3): Record<string, unknown> {
  const entity = JSON.parse(readFileSync(join(FIXTURE_DIR, `listing-detail-local-${n}.fixture.json`), "utf8"));
  return reshapeListingEntity(entity);
}

/** Real search cards from the captured search page, run through the page function and the reshape. */
function cardRaw(listingId: string): Record<string, unknown> {
  const text = readFileSync(join(FIXTURE_DIR, "search-meta-local.fixture.txt"), "utf8");
  document.body.innerHTML = "";
  const script = document.createElement("script");
  script.type = "text/x-booli-fixture"; // jsdom must not execute it
  script.textContent = text;
  document.body.appendChild(script);
  const extract = new Function(`return (${EXTRACT_STATE_BROWSER_FN})`)() as () => Record<string, Record<string, unknown>> | null;
  const state = extract();
  const entity = state?.[`Listing:${listingId}`];
  if (!entity) throw new Error(`card ${listingId} not in the fixture`);
  return reshapeListingEntity(entity);
}

describe("candidateFactsSchema", () => {
  it("parses {} to every field null and detailFetched false", () => {
    const facts = candidateFactsSchema.parse({});
    const { detailFetched, ...rest } = facts;
    expect(detailFetched).toBe(false);
    for (const [key, value] of Object.entries(rest)) {
      expect(value, key).toBeNull();
    }
    expect(Object.keys(rest).sort()).toEqual(
      [
        "areaMeasuredFirm",
        "areaMeasuredYear",
        "areaSource",
        "avgiftMonthlySek",
        "balcony",
        "balkongBeviljadEjByggd",
        "balkongInglasningAnsokt",
        "beteckningRung",
        "biddingOpen",
        "brf",
        "brfId",
        "brfName",
        "byggarenden",
        "ceilingHeightM",
        "ceilingSource",
        "cityStambyte",
        "constructionYear",
        "daysOnMarket",
        "daysOnMarketSource",
        "descriptionRead",
        "elevatorListed",
        "fastighetsbeteckning",
        "floor",
        "isNewConstruction",
        "landLease",
        "lastStambyteYear",
        "listPricePercentageDiff",
        "operatingCostMonthlySek",
        "orientationFacades",
        "plannedStambyteYear",
        "priceCutSek",
        "publishedAt",
        "reliningMentioned",
        "stambyteOngoing",
        "stambyteSource",
        "stambyteStatus",
        "statusKey",
        "sunPhrases",
        "tallCeilingPhrase",
        "tenureForm",
        "textStambyte",
      ].sort(),
    );
  });

  it("strips unknown keys, so free text cannot ride along", () => {
    const parsed = candidateFactsSchema.parse({ tenureForm: "Bostadsrätt", description: "Ring Anna 070-123 45 67", agentName: "Anna" });
    expect(parsed.tenureForm).toBe("Bostadsrätt");
    expect(JSON.stringify(parsed)).not.toMatch(/Anna|070/);
  });

  it("Phase 14.6: each of the 16 new keys is part of the schema and is null on an empty record", () => {
    const newKeys = [
      "fastighetsbeteckning",
      "beteckningRung",
      "lastStambyteYear",
      "plannedStambyteYear",
      "stambyteOngoing",
      "stambyteSource",
      "stambyteStatus",
      "reliningMentioned",
      "textStambyte",
      "cityStambyte",
      "balkongBeviljadEjByggd",
      "balkongInglasningAnsokt",
      "byggarenden",
      "areaSource",
      "areaMeasuredYear",
      "areaMeasuredFirm",
    ] as const;
    expect(newKeys).toHaveLength(16);
    const empty = emptyFacts();
    for (const key of newKeys) {
      expect(Object.keys(candidateFactsSchema.shape), key).toContain(key);
      expect(empty[key], key).toBeNull();
    }
  });

  it("Phase 14.6: a record with every new key set survives JSON and the schema, and a bad month or case number is refused", () => {
    const full = candidateFactsSchema.parse({
      fastighetsbeteckning: "Droskhästen 8",
      beteckningRung: "b",
      lastStambyteYear: 2006,
      plannedStambyteYear: 2027,
      stambyteOngoing: false,
      stambyteSource: "bygglov_stockholm",
      stambyteStatus: "planerat",
      reliningMentioned: false,
      textStambyte: { lastYear: null, plannedYear: 2027, ongoing: false, relining: false },
      cityStambyte: { lastYear: 2006, basis: "start", ongoing: false, relining: false },
      balkongBeviljadEjByggd: true,
      balkongInglasningAnsokt: false,
      byggarenden: [{ kind: "hiss", month: "2021-12", decision: "slutbesked", slutbeskedMonth: "2022-03", diarie: "2021-19876" }],
      areaSource: "uppmatt",
      areaMeasuredYear: 2019,
      areaMeasuredFirm: true,
    });
    expect(candidateFactsSchema.parse(JSON.parse(JSON.stringify(full)))).toEqual(full);
    expect(full.byggarenden?.[0].diarie).toBe("2021-19876");
    expect(() => candidateFactsSchema.parse({ byggarenden: [{ kind: "hiss", month: "dec 2021", decision: "okant" }] })).toThrow();
    expect(() => candidateFactsSchema.parse({ byggarenden: [{ kind: "hiss", month: "2021-12", decision: "okant", diarie: "Anna, 070.123 45 67 mail@x" }] })).toThrow();
    expect(() => candidateFactsSchema.parse({ byggarenden: Array.from({ length: 7 }, () => ({ kind: "hiss", month: "2021-12", decision: "okant" })) })).toThrow();
  });

  it("emptyFacts() equals the parse of {}", () => {
    expect(emptyFacts()).toEqual(candidateFactsSchema.parse({}));
  });

  it("a facts record round-trips through JSON and the schema unchanged", () => {
    const facts = mergeFacts(factsFromCard(cardRaw("6220466")), factsFromDetail(detailRaw(1), { asOf: AS_OF }));
    expect(candidateFactsSchema.parse(JSON.parse(JSON.stringify(facts)))).toEqual(facts);
  });
});

describe("daysOnMarketFromText", () => {
  it.each([
    ["Inkommet idag", 0],
    ["Inkommet igår", 1],
    ["3 dagar på Booli", 3],
    ["11 dagar på Booli", 11],
    ["En månad på Booli", FACTS_CONSTANTS.DAYS_PER_MONTH],
    ["2 månader på Booli", 60],
    ["11 månader på Booli", 330],
    ["2 år på Booli", 730],
    ["En år på Booli", 365],
    ["", null],
    [null, null],
    ["snart till salu", null],
    ["Budgivning pågår", null],
  ] as const)("%j -> %j", (text, expected) => {
    expect(daysOnMarketFromText(text)).toBe(expected);
  });

  it("owns no constants: the conversion factors live in FACTS_CONSTANTS", () => {
    expect(FACTS_CONSTANTS.DAYS_PER_MONTH).toBe(30);
    expect(FACTS_CONSTANTS.DAYS_PER_YEAR).toBe(365);
  });
});

describe("landLeaseFromText", () => {
  it.each([
    ["Föreningen innehar fastigheten med tomträtt", true],
    ["Fastigheten är tomträtt med avgäld fram till 2030", true],
    ["Marken är friköpt", false],
    ["Föreningen äger marken", false],
    ["Föreningen äger både marken och byggnaden", false],
    ["ej tomträtt", false],
    ["Det är inte tomträtt", false],
    ["Föreningen har friköpt tomträtten", false],
    // WR-10: a buy-out that is possible or planned does not rule tomträtt out
    ["Föreningen har tomträtt, möjlighet att friköpa finns", true],
    ["Tomträtten ska avlösas 2028", true],
    ["Fastigheten är upplåten med tomträtt. Avlösen kan ske tidigast 2030.", true],
    // ...nor does a buy-out in another sentence (a neighbour's, a later one)
    ["Föreningen innehar tomträtt. Grannfastigheten har friköpt marken.", true],
    // "utan" is a conjunction unless it stands right before the noun
    ["Ljus lägenhet, utan tomträttsavgäld att tänka på, med tomträtt till 2040", true],
    ["Lägenhet, utan tomträttsavgäld att tänka på", true],
    ["Fastigheten är utan tomträtt", false],
    // a past-tense buy-out in the SAME sentence as the mention still rules it out
    ["Tomträtten är avlöst sedan 2019", false],
    ["Fin utsikt", null],
    ["", null],
    [null, null],
  ] as const)("%j -> %j", (text, expected) => {
    expect(landLeaseFromText(text)).toBe(expected);
  });
});

describe("factsFromCard (real search cards, 2026-10-13)", () => {
  it("reads avgift, floor, days on market from the card text and the elevator and balcony the card lists", () => {
    const facts = factsFromCard(cardRaw("6294081")); // Fatburs Kvarngata 18, Budgivning pågår
    expect(facts).toMatchObject({
      avgiftMonthlySek: 4043,
      floor: 3,
      statusKey: "biddingOpen",
      biddingOpen: true,
      daysOnMarket: 11,
      daysOnMarketSource: "card-text",
      elevatorListed: true,
      balcony: true,
      isNewConstruction: false,
      detailFetched: false,
    });
  });

  it("a card that omits the elevator says null, never false (R-04b)", () => {
    const facts = factsFromCard(cardRaw("6225820")); // Norra Hammarbyhamnen: balcony and patio, no elevator listed
    expect(facts.elevatorListed).toBeNull();
    expect(facts.balcony).toBe(true);
  });

  it("a card without any balcony says null, not false", () => {
    const raw = { ...cardRaw("6225820"), amenities: [{ __typename: "Amenity", key: "patio" }], balcony: false };
    expect(factsFromCard(raw).balcony).toBeNull();
  });

  it("a card with no status has statusKey null and biddingOpen null", () => {
    const facts = factsFromCard(cardRaw("6220466")); // Pokalvägen 4
    expect(facts.statusKey).toBeNull();
    expect(facts.biddingOpen).toBeNull();
    expect(facts.daysOnMarket).toBe(30); // "En månad på Booli"
  });

  it("knows nothing a card cannot say: tenure, build year, price cut, BRF stay null", () => {
    const facts = factsFromCard(cardRaw("6220466"));
    expect(facts.tenureForm).toBeNull();
    expect(facts.constructionYear).toBeNull();
    expect(facts.priceCutSek).toBeNull();
    expect(facts.brfId).toBeNull();
  });

  it("an empty record gives the empty facts", () => {
    expect(factsFromCard({})).toEqual(emptyFacts());
  });
});

describe("factsFromDetail (real detail pages, 2026-10-13)", () => {
  it("reads a price-cut listing: Pokalvägen 4", () => {
    const facts = factsFromDetail(detailRaw(1), { asOf: AS_OF });
    expect(facts).toMatchObject({
      tenureForm: "Bostadsrätt",
      avgiftMonthlySek: 2843,
      operatingCostMonthlySek: 1082,
      constructionYear: 1944,
      floor: 0.5,
      elevatorListed: true,
      balcony: true,
      publishedAt: "2026-08-21",
      daysOnMarket: 53,
      daysOnMarketSource: "published",
      priceCutSek: 600000,
      listPricePercentageDiff: -15.6,
      biddingOpen: false,
      brfName: "HSB BRF Reimer",
      brfId: "79301",
      isNewConstruction: false,
      detailFetched: true,
    });
  });

  it("a price RISE is a negative cut: Tobaksspinnargatan 10 asked 305 000 kr more", () => {
    const facts = factsFromDetail(detailRaw(2), { asOf: AS_OF });
    expect(facts.priceCutSek).toBe(-305000);
    expect(facts.listPricePercentageDiff).toBe(7.3);
    // Detail read: an amenity list without a balcony means no balcony, and one with an elevator lists it.
    expect(facts.balcony).toBe(false);
    expect(facts.elevatorListed).toBe(true);
  });

  it("no price change at all is null, and a bidding listing reads true: Fatburs Kvarngata 18", () => {
    const facts = factsFromDetail(detailRaw(3), { asOf: AS_OF });
    expect(facts.priceCutSek).toBeNull();
    expect(facts.listPricePercentageDiff).toBeNull();
    expect(facts.biddingOpen).toBe(true);
    expect(facts.daysOnMarket).toBe(11);
  });

  it("a detail page without an elevator in its amenities says false (detail read)", () => {
    const raw = { ...detailRaw(1), amenities: [{ __typename: "Amenity", key: "balcony" }] };
    expect(factsFromDetail(raw, { asOf: AS_OF }).elevatorListed).toBe(false);
  });

  it("days on market: published 2026-08-14 with asOf 2026-10-13 is 60 days", () => {
    const facts = factsFromDetail({ published: "2026-08-14 09:00:00" }, { asOf: AS_OF });
    expect(facts.publishedAt).toBe("2026-08-14");
    expect(facts.daysOnMarket).toBe(60);
    expect(facts.daysOnMarketSource).toBe("published");
  });

  it("published today is 0 days, published tomorrow is unknown", () => {
    expect(factsFromDetail({ published: "2026-10-13 00:05:00" }, { asOf: AS_OF }).daysOnMarket).toBe(0);
    expect(factsFromDetail({ published: "2026-10-14 08:00:00" }, { asOf: AS_OF }).daysOnMarket).toBeNull();
  });

  it("published missing: the card text is used and says so", () => {
    const facts = factsFromDetail({ displayDate: "3 dagar på Booli" }, { asOf: AS_OF });
    expect(facts.daysOnMarket).toBe(3);
    expect(facts.daysOnMarketSource).toBe("card-text");
    expect(facts.publishedAt).toBeNull();
  });

  it("a published value that is not a date is ignored", () => {
    const facts = factsFromDetail({ published: "snart" }, { asOf: AS_OF });
    expect(facts.publishedAt).toBeNull();
    expect(facts.daysOnMarket).toBeNull();
  });

  it("biddingOpen 0 is false and 1 is true", () => {
    expect(factsFromDetail({ biddingOpen: 0 }, { asOf: AS_OF }).biddingOpen).toBe(false);
    expect(factsFromDetail({ biddingOpen: 1 }, { asOf: AS_OF }).biddingOpen).toBe(true);
  });

  it("priceCutSek: a positive number always means the asking price went down", () => {
    expect(factsFromDetail({ listPriceChange: -600000 }, { asOf: AS_OF }).priceCutSek).toBe(600000);
    expect(factsFromDetail({ listPriceChange: 250000 }, { asOf: AS_OF }).priceCutSek).toBe(-250000);
    expect(Object.is(factsFromDetail({ listPriceChange: 0 }, { asOf: AS_OF }).priceCutSek, 0)).toBe(true);
  });

  it("keeps Swedish letters in the BRF name byte for byte through a JSON round trip", () => {
    const raw = { ...detailRaw(1), brfName: "BRF Ängsö Åkerbär Östra", streetAddress: "Pokalvägen 4" };
    const facts = factsFromDetail(raw, { asOf: AS_OF });
    expect(facts.brfName).toBe("BRF Ängsö Åkerbär Östra");
    const again = candidateFactsSchema.parse(JSON.parse(JSON.stringify(facts)));
    expect(again.brfName).toBe("BRF Ängsö Åkerbär Östra");
    // The captured fixture itself keeps its å/ä/ö through the reshape and a round trip.
    const reshaped = detailRaw(1);
    expect(JSON.parse(JSON.stringify(reshaped)).streetAddress).toBe("Pokalvägen 4");
  });

  it("leaves enrichment fields null: orientation, sun phrases, description, land lease, BRF debt", () => {
    const facts = factsFromDetail(detailRaw(1), { asOf: AS_OF });
    expect(facts.orientationFacades).toBeNull();
    expect(facts.sunPhrases).toBeNull();
    expect(facts.descriptionRead).toBeNull();
    expect(facts.landLease).toBeNull();
    expect(facts.brf).toBeNull();
  });
});

describe("mergeFacts", () => {
  it("detail wins where it has a value, the card fills the rest, detailFetched comes from the detail", () => {
    const card = factsFromCard(cardRaw("6220466")); // Pokalvägen 4: card text 30 days, statusKey null
    const detail = factsFromDetail(detailRaw(1), { asOf: AS_OF });
    const merged = mergeFacts(card, detail);
    expect(merged.daysOnMarket).toBe(53);
    expect(merged.daysOnMarketSource).toBe("published");
    expect(merged.tenureForm).toBe("Bostadsrätt");
    expect(merged.priceCutSek).toBe(600000);
    expect(merged.detailFetched).toBe(true);
  });

  it("keeps the card's days on market and its source together when the detail has none", () => {
    const card = factsFromCard(cardRaw("6220466"));
    const merged = mergeFacts(card, factsFromDetail({}, { asOf: AS_OF }));
    expect(merged.daysOnMarket).toBe(30);
    expect(merged.daysOnMarketSource).toBe("card-text");
  });

  it("a card's value survives a detail null (status from the card)", () => {
    const card = factsFromCard(cardRaw("6294081")); // statusKey biddingOpen, from the card only
    const merged = mergeFacts(card, factsFromDetail({ tenureForm: "Bostadsrätt" }, { asOf: AS_OF }));
    expect(merged.statusKey).toBe("biddingOpen");
    expect(merged.avgiftMonthlySek).toBe(4043);
  });

  it("a detail false beats a card null (elevator read on the detail page)", () => {
    const card = factsFromCard({ amenities: [] });
    expect(card.elevatorListed).toBeNull();
    const detail = factsFromDetail({ amenities: [{ key: "balcony" }] }, { asOf: AS_OF });
    expect(mergeFacts(card, detail).elevatorListed).toBe(false);
  });

  it("merging two empty records gives the empty facts", () => {
    expect(mergeFacts(emptyFacts(), emptyFacts())).toEqual(emptyFacts());
  });

  it("does not touch the inputs", () => {
    const card: CandidateFacts = factsFromCard(cardRaw("6220466"));
    const before = JSON.stringify(card);
    mergeFacts(card, factsFromDetail(detailRaw(1), { asOf: AS_OF }));
    expect(JSON.stringify(card)).toBe(before);
  });
});

describe("no personal data", () => {
  it("the facts carry only derived values: no description text, no names, no phone numbers", () => {
    const raw = {
      ...detailRaw(1),
      description: "Kontakta mäklare Anna Svensson på 070-123 45 67 eller anna@example.com för visning.",
      agentName: "Anna Svensson",
      contactPhone: "070-123 45 67",
    };
    const facts = factsFromDetail(raw, { asOf: AS_OF });
    const json = JSON.stringify(facts);
    expect(json).not.toMatch(/Anna|Svensson|070|example\.com|Kontakta|visning/);
    expect(facts.descriptionRead).toBeNull();
  });

  it("no schema key is named like free text or a person, and strings appear only in the short fields", () => {
    for (const key of Object.keys(candidateFactsSchema.shape)) {
      expect(key).not.toMatch(/agent|person|contact|phone|e-?mail|seller|^description$|^text$/i);
    }
    const facts = mergeFacts(factsFromCard(cardRaw("6294081")), factsFromDetail(detailRaw(3), { asOf: AS_OF }));
    const stringFields = new Set(["tenureForm", "publishedAt", "daysOnMarketSource", "statusKey", "brfName", "brfId"]);
    for (const [key, value] of Object.entries(facts)) {
      if (typeof value === "string") expect(stringFields.has(key), key).toBe(true);
    }
  });

  it("the committed fixtures contain no phone number or e-mail value", () => {
    const files = [
      "search-meta-local.fixture.txt",
      "listing-detail-local-1.fixture.json",
      "listing-detail-local-2.fixture.json",
      "listing-detail-local-3.fixture.json",
    ];
    for (const file of files) {
      const text = readFileSync(join(FIXTURE_DIR, file), "utf8");
      expect(text, file).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
      expect(text, file).not.toMatch(/(?:\+46|0046)[\s\d-]{7,}/);
      expect(text, file).not.toMatch(/(?<!\d)07\d[-\s]?\d{3}[-\s]?\d{2}[-\s]?\d{2}(?!\d)/);
      expect(text, file).not.toMatch(/"(?:phone|phoneNumber|email|mobile)"\s*:\s*"[^"]+"/i);
    }
  });
});
