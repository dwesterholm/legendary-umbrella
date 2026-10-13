// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXTRACT_STATE_BROWSER_FN, APOLLO_PAGE_FUNCTION } from "@/lib/booli/page-functions";

/**
 * Runs the SAME browser-side string the Apify actor evaluates, against a jsdom
 * document seeded with trimmed copies of what Booli served on 2026-10-06
 * (live-captured in the browser pane; see page-functions.ts doc comment).
 */
type StateMap = Record<string, Record<string, unknown>> | null;
const extract = new Function(`return (${EXTRACT_STATE_BROWSER_FN})`)() as () => StateMap;

function addInlineScript(text: string, id?: string) {
  const s = document.createElement("script");
  if (id) s.id = id;
  // jsdom would otherwise EXECUTE the snippet on attach (and fail on
  // `self.__next_f`). The extractor reads `textContent` of every inline
  // script regardless of `type`, so a non-JS type keeps the test faithful.
  s.type = "text/x-booli-fixture";
  s.textContent = text;
  document.body.appendChild(s);
}

/** A search-page card (ListableProperty) as pushed through Apollo's SSR transport. */
const SERP_CARD = {
  __typename: "ListableProperty",
  position: { __typename: "Position", latitude: 59.319, longitude: 18.053 },
  listingId: "6257338",
  amenities: [{ __typename: "Amenity", key: "elevator", label: "Hiss" }],
  displayAttributes: {
    __typename: "DisplayAttributes",
    dataPoints: [
      { __typename: "DataPoint", key: "livingArea", value: { plainText: "46,5 m²" } },
      { __typename: "DataPoint", key: "rooms", value: { plainText: "1,5 rum" } },
      { __typename: "DataPoint", key: "floor", value: { plainText: "vån 5" } },
      { __typename: "DataPoint", key: "rentOrPlotAreaText", value: { plainText: "3 557 kr/mån" } },
    ],
  },
  displayDate: "Inkommet idag",
  displayPrice: "10 495 000 kr",
  images: [{ __typename: "Image", id: "55983400", primaryLabel: "balcony/view" }],
  objectType: "Lägenhet",
  saleType: "succession",
  subtitle: "Lägenhet · Södermalm · Stockholm",
  title: "Ludvigsbergsgatan 33",
  url: "/bostad/662772",
  tracking: {
    __typename: "TrackingData",
    properties: { type: "property_active", booli_id: 6257338, upcoming_sale: false, municipality: "Stockholm" },
  },
  presenter: { __typename: "Presenter", name: "BOSTHLM" },
  originId: "listing:6257338",
  queryContext: "SERP",
};

const SOLD_CARD = {
  __typename: "ListableProperty",
  listingId: "6279104",
  displayAttributes: {
    __typename: "DisplayAttributes",
    dataPoints: [
      { __typename: "DataPoint", key: "livingArea", value: { plainText: "34 m²" } },
      { __typename: "DataPoint", key: "rooms", value: { plainText: "2 rum" } },
      { __typename: "DataPoint", key: "floor", value: { plainText: "vån 3" } },
      { __typename: "DataPoint", key: "soldSqmPrice", value: { plainText: "123 500 kr/m²" } },
    ],
  },
  displayDate: "2026-10-06",
  displayPrice: "4 200 000 kr",
  objectType: "Lägenhet",
  saleType: "sold",
  priceRemark: { __typename: "PriceRemark", label: "+15,1%" },
  title: "Slipgatan 12",
  url: "/bostad/739445",
  originId: "sold:bid:6279104",
};

const PROJECT_CARD = {
  __typename: "ListableProperty",
  listingId: "7000001",
  displayPrice: "5 000 000 kr",
  displayAttributes: { __typename: "DisplayAttributes", dataPoints: [] },
  title: "Nybygget 1",
  url: "/projekt/1",
  originId: "project:7000001",
  tracking: { __typename: "TrackingData", properties: { type: "project" } },
};

function transportScript(cards: unknown[]): string {
  // Mirrors Booli's real push: a `data:undefined` member proves the extractor
  // never JSON.parses the whole push (that would throw on `undefined`).
  const rehydrate = {
    _R_a: { data: "__UNDEF__", loading: true },
    _R_b: { data: { listings: { __typename: "PropertySearchMeta", items: cards } } },
  };
  return `(window[Symbol.for("ApolloSSRDataTransport")] ??= []).push(${JSON.stringify({ rehydrate }).replace('"__UNDEF__"', "undefined")})`;
}

/** The detail page's RSC flight row carrying the full Listing entity. */
const DETAIL_LISTING = {
  __typename: "Listing",
  id: "6257338",
  booliId: "6257338",
  streetAddress: "Ludvigsbergsgatan 33",
  constructionYear: 1963,
  tenureForm: "Bostadsrätt",
  listPrice: { __typename: "FormattedValue", raw: 10495000 },
  breadcrumbs: [
    { __typename: "BreadcrumbItem", label: "Stockholms kommun", url: "/sok/till-salu?areaIds=1" },
    { __typename: "BreadcrumbItem", label: "BRF Skinnarviksberget nr 2", url: "/bostadsrattsforening/45550" },
  ],
  images: [{ __typename: "Image", id: "55983400", primaryLabel: "interior" }],
  amenities: [{ __typename: "Amenity", key: "elevator" }],
  agency: { __typename: "Agency", name: "BOSTHLM" },
  salesOfResidence: [{ __typename: "SoldProperty", id: "4912945", booliId: "4912945" }],
};

function flightScript(listing: unknown): string {
  const row6 = JSON.stringify([
    "$",
    "div",
    null,
    { children: ["$", "$L7", null, { listing }] },
  ]);
  const flight = `1:"$Sreact.fragment"\n6:${row6}\n`;
  return `self.__next_f.push(${JSON.stringify([1, flight])})`;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("EXTRACT_STATE_BROWSER_FN — Booli's 2026-10 page shapes", () => {
  it("returns null on a page with no recognisable data (a challenge/blocked page)", () => {
    addInlineScript("window.dataLayer = [];");
    expect(extract()).toBeNull();
  });

  it("still honours the legacy __NEXT_DATA__ payload", () => {
    addInlineScript(
      JSON.stringify({ props: { pageProps: { __APOLLO_STATE__: { "Listing:1": { id: "1" } } } } }),
      "__NEXT_DATA__",
    );
    expect(extract()).toEqual({ "Listing:1": { id: "1" } });
  });

  it("maps a search-page card onto the old Listing field names with numeric {raw} values", () => {
    addInlineScript(transportScript([SERP_CARD]));
    const state = extract();
    expect(state).not.toBeNull();
    const e = state!["Listing:6257338"];
    expect(e).toMatchObject({
      __typename: "Listing",
      id: "6257338",
      booliId: "6257338",
      url: "/bostad/662772",
      streetAddress: "Ludvigsbergsgatan 33",
      descriptiveAreaName: "Södermalm",
      objectType: "Lägenhet",
      listPrice: { raw: 10495000 },
      livingArea: { raw: 46.5 },
      rooms: { raw: 1.5 },
      floor: { raw: 5 },
      rent: { raw: 3557 },
      latitude: 59.319,
      longitude: 18.053,
      upcomingSale: false,
      isNewConstruction: false,
      agency: { name: "BOSTHLM" },
      kommun: "Stockholm",
    });
    expect(e.images).toEqual([{ __typename: "Image", id: "55983400", primaryLabel: "balcony/view" }]);
    expect(e.amenities).toEqual([{ __typename: "Amenity", key: "elevator", label: "Hiss" }]);
  });

  it("maps a sold card to SoldProperty with the fields sold-schema.ts reads", () => {
    addInlineScript(transportScript([SOLD_CARD, SERP_CARD]));
    const state = extract()!;
    expect(Object.keys(state).sort()).toEqual(["Listing:6257338", "SoldProperty:6279104"]);
    expect(state["SoldProperty:6279104"]).toMatchObject({
      __typename: "SoldProperty",
      soldDate: "2026-10-06",
      soldPrice: { raw: 4200000 },
      soldPricePercentageDiff: { raw: 15.1 },
      objectType: "Lägenhet",
    });
    const points = (state["SoldProperty:6279104"].displayAttributes as { dataPoints: { value: { plainText: string } }[] }).dataPoints;
    expect(points.map((p) => p.value.plainText)).toContain("123 500 kr/m²");
  });

  describe("sold-vs-asking percentage (R-04a: sign-correct premium label)", () => {
    // Booli writes a below-asking sale with an EN DASH (U+2013) or MINUS SIGN
    // (U+2212), neither of which the price parser's `-?` matches; reading the
    // label with it silently turned every below-asking sale into a positive
    // premium. These cases use escaped code points so the file stays ASCII.
    const soldWith = (priceRemark: unknown) => ({ ...SOLD_CARD, priceRemark });
    const diffFor = (priceRemark: unknown) => {
      document.body.innerHTML = "";
      addInlineScript(transportScript([soldWith(priceRemark)]));
      return extract()!["SoldProperty:6279104"].soldPricePercentageDiff;
    };

    it("keeps the existing +15,1% label at 15.1", () => {
      expect(diffFor({ __typename: "PriceRemark", label: "+15,1%" })).toMatchObject({ raw: 15.1 });
    });

    it("reads a regular space before % ('+12,5 %') as 12.5", () => {
      expect(diffFor({ label: "+12,5 %" })).toMatchObject({ raw: 12.5 });
    });

    it("reads a no-break space before % as 12.5", () => {
      expect(diffFor({ label: "+12,5 %" })).toMatchObject({ raw: 12.5 });
    });

    it("reads an EN DASH (U+2013) sign as negative", () => {
      expect(diffFor({ label: "–1,5 %" })).toMatchObject({ raw: -1.5 });
    });

    it("reads a MINUS SIGN (U+2212) as negative", () => {
      expect(diffFor({ label: "−0,4 %" })).toMatchObject({ raw: -0.4 });
    });

    it("reads an ASCII hyphen as negative", () => {
      expect(diffFor({ label: "-2,0%" })).toMatchObject({ raw: -2 });
    });

    it("reads '+0 %' as exactly 0 (a real zero, not null)", () => {
      const v = diffFor({ label: "+0 %" }) as { raw: number };
      expect(v).not.toBeNull();
      expect(Object.is(v.raw, 0)).toBe(true);
    });

    it("never produces negative zero from a signed zero label", () => {
      const v = diffFor({ label: "−0 %" }) as { raw: number };
      expect(Object.is(v.raw, 0)).toBe(true);
    });

    it("yields null (not 0) when priceRemark is null", () => {
      expect(diffFor(null)).toBeNull();
    });

    it("yields null when priceRemark carries no label", () => {
      expect(diffFor({ __typename: "PriceRemark", icon: "TrendDown" })).toBeNull();
    });

    it("yields null when the label is not a signed percentage (no guess)", () => {
      expect(diffFor({ label: "Budgivning" })).toBeNull();
    });

    it("passes the raw priceRemark through so node-side code can cross-check the icon", () => {
      document.body.innerHTML = "";
      const remark = { __typename: "PriceRemark", label: "–1,5 %", icon: "TrendDown" };
      addInlineScript(transportScript([soldWith(remark)]));
      expect(extract()!["SoldProperty:6279104"].priceRemark).toEqual(remark);
    });

    it("passes priceRemark null when the card has none", () => {
      document.body.innerHTML = "";
      const { priceRemark: _drop, ...noRemark } = SOLD_CARD;
      void _drop;
      addInlineScript(transportScript([noRemark]));
      expect(extract()!["SoldProperty:6279104"].priceRemark).toBeNull();
    });
  });

  describe("displayPrice parsing (FIT-01 precision probe)", () => {
    it("parses '3 695 000 kr' with regular spaces on a sold card", () => {
      addInlineScript(transportScript([{ ...SOLD_CARD, displayPrice: "3 695 000 kr" }]));
      expect(extract()!["SoldProperty:6279104"].soldPrice).toMatchObject({ raw: 3695000 });
    });

    it("parses '3 695 000 kr' with U+00A0 spaces on a sold card", () => {
      addInlineScript(transportScript([{ ...SOLD_CARD, displayPrice: "3 695 000 kr" }]));
      expect(extract()!["SoldProperty:6279104"].soldPrice).toMatchObject({ raw: 3695000 });
    });

    it("parses U+00A0-spaced displayPrice into listPrice on a for-sale card", () => {
      addInlineScript(transportScript([{ ...SERP_CARD, displayPrice: "3 695 000 kr" }]));
      expect(extract()!["Listing:6257338"].listPrice).toMatchObject({ raw: 3695000 });
    });
  });

  it("classifies a project card and a for-sale card on one transport by originId kind, as before", () => {
    addInlineScript(transportScript([PROJECT_CARD, SERP_CARD, SOLD_CARD]));
    const state = extract()!;
    expect(Object.keys(state).sort()).toEqual(["Listing:6257338", "Listing:7000001", "SoldProperty:6279104"]);
    expect(state["Listing:7000001"]).toMatchObject({ isNewConstruction: true });
    expect(state["Listing:6257338"]).toMatchObject({ isNewConstruction: false });
  });

  it("flags a project card as new construction", () => {
    addInlineScript(transportScript([PROJECT_CARD]));
    expect(extract()!["Listing:7000001"]).toMatchObject({ isNewConstruction: true });
  });

  it("reads the detail page's Listing out of the App Router flight payload", () => {
    addInlineScript(flightScript(DETAIL_LISTING));
    const state = extract()!;
    expect(state["Listing:6257338"]).toMatchObject({
      constructionYear: 1963,
      tenureForm: "Bostadsrätt",
      listPrice: { raw: 10495000 },
    });
    // Nested SoldProperty objects are surfaced too (harmless for the detail
    // reader, which only takes Listing: keys).
    expect(state["SoldProperty:4912945"]).toMatchObject({ id: "4912945" });
  });

  it("is embedded verbatim in the actor page function", () => {
    expect(APOLLO_PAGE_FUNCTION).toContain("page.evaluate(() => {");
    expect(APOLLO_PAGE_FUNCTION).toContain("ApolloSSRDataTransport");
    expect(APOLLO_PAGE_FUNCTION).toContain("self.__next_f.push(");
  });
});

// ---------------------------------------------------------------------------
// Phase 14.2 (WATCH-02, R-04, W6): Booli's own result count and the card status
// ---------------------------------------------------------------------------

/** A search result object the way Booli ships it: cards, then totalCount, then meta with the title. */
function resultScript(cards: unknown[], totalCount: number, title: string): string {
  const searchForSale = {
    __typename: "SearchResult",
    items: cards,
    totalCount,
    meta: {
      __typename: "SearchResultMeta",
      tilesQuery: "isNewConstruction=&objectType=Lägenhet",
      title: { __typename: "DisplayText", markdown: `**${title}**`, plainText: title },
    },
  };
  return `(window[Symbol.for("ApolloSSRDataTransport")] ??= []).push(${JSON.stringify({ rehydrate: { _R_c: { data: { searchForSale } } } })})`;
}

const META_FIXTURE = readFileSync(join(__dirname, "__fixtures__", "search-meta-local.fixture.txt"), "utf8");

/** Runs the actor page function string against the current document, as the Apify actor and the local browser do. */
async function runPageFunction(): Promise<unknown> {
  const run = new Function(`return (${APOLLO_PAGE_FUNCTION})`)() as (ctx: unknown) => Promise<unknown>;
  return run({ page: { evaluate: async (fn: () => unknown) => fn() }, request: { url: "https://www.booli.se/sok/till-salu" } });
}

describe("EXTRACT_STATE_BROWSER_FN - SearchMeta and card statusKey (Phase 14.2)", () => {
  it("reads the three result counts and the cards out of the real local search fixture", () => {
    addInlineScript(META_FIXTURE);
    const state = extract()!;
    const meta = Object.entries(state)
      .filter(([key]) => key.startsWith("SearchMeta:"))
      .map(([, value]) => value);
    expect(meta).toEqual([
      { __typename: "SearchMeta", totalCount: 551, title: "Lägenheter till salu på Södermalm" },
      { __typename: "SearchMeta", totalCount: 4, title: "Nyproduktion av lägenheter på Södermalm" },
      { __typename: "SearchMeta", totalCount: 37089, title: "Slutpriser för lägenheter på Södermalm" },
    ]);
    expect(Object.keys(state).filter((key) => key.startsWith("Listing:")).sort()).toEqual([
      "Listing:6220466",
      "Listing:6225820",
      "Listing:6294081",
    ]);
  });

  it("carries primaryStatus.key as statusKey: biddingOpen where Booli says so, null otherwise", () => {
    addInlineScript(META_FIXTURE);
    const state = extract()!;
    expect(state["Listing:6294081"]).toMatchObject({ streetAddress: "Fatburs Kvarngata 18", statusKey: "biddingOpen" });
    expect(state["Listing:6220466"]).toMatchObject({ streetAddress: "Pokalvägen 4", statusKey: null });
    expect(state["Listing:6225820"]).toMatchObject({ statusKey: null });
  });

  it("keeps Swedish letters in the count title and card address byte for byte", () => {
    addInlineScript(META_FIXTURE);
    const state = extract()!;
    expect(state["SearchMeta:0"].title).toBe("Lägenheter till salu på Södermalm");
    expect(state["Listing:6220466"].streetAddress).toBe("Pokalvägen 4");
  });

  it("the count rides along beside one real card (the count never replaces cards)", () => {
    addInlineScript(resultScript([SERP_CARD], 222, "Lägenheter till salu på Södermalm"));
    const state = extract()!;
    expect(Object.keys(state).sort()).toEqual(["Listing:6257338", "SearchMeta:0"]);
    expect(state["SearchMeta:0"]).toEqual({ __typename: "SearchMeta", totalCount: 222, title: "Lägenheter till salu på Södermalm" });
  });

  it("a card without primaryStatus has statusKey null, and a SERP card keeps every field it had", () => {
    addInlineScript(transportScript([SERP_CARD]));
    expect(extract()!["Listing:6257338"]).toMatchObject({ statusKey: null, displayDate: "Inkommet idag" });
  });

  describe("totalCount-only page (W6: a count with no cards stays a dead page)", () => {
    it.each([222, 0])("extracts to null when the page carries only a till-salu totalCount of %i", (total) => {
      addInlineScript(resultScript([], total, "Lägenheter till salu på Södermalm"));
      expect(extract()).toBeNull();
    });

    it.each([222, 0])("the page function says hasApollo false for a totalCount-only page (%i), like a page with no transport", async (total) => {
      addInlineScript(resultScript([], total, "Lägenheter till salu på Södermalm"));
      const countOnly = await runPageFunction();
      document.body.innerHTML = "";
      addInlineScript("window.dataLayer = [];");
      const empty = await runPageFunction();
      expect(countOnly).toEqual({ hasApollo: false, __APOLLO_STATE__: null });
      expect(countOnly).toEqual(empty);
    });
  });
});
