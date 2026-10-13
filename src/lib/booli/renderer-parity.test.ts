// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  actorCall,
  listItems,
  resetApifyMock,
  apifyClientMockFactory,
} from "@/lib/booli/__mocks__/apify-client";
import listingDetailFixture from "@/lib/booli/__fixtures__/listing-detail.json";
import { APOLLO_PAGE_FUNCTION } from "@/lib/booli/page-functions";
import { toCandidate } from "@/lib/discovery/candidate";

vi.mock("apify-client", () => apifyClientMockFactory());
vi.mock("@/lib/apify/booli-scraper", () => ({ scrapeBooli: vi.fn() }));

// Imported AFTER the mocks above are registered.
import { fetchAreaListings, fetchListing } from "@/lib/booli/client";
import { installLocalRenderer, type LocalLauncher, type LocalRendererHandle } from "@/lib/booli/local-browser";
import { setRenderer } from "@/lib/booli/transport";

/**
 * D-05 (one parser, two transports): the SAME page-function string, run once
 * through the local renderer and once through the mocked Apify actor, must
 * give deep-equal candidate objects. The extractor itself is one string; what
 * this proves is the glue (renderer dispatch, the usable-item rule, the
 * `{ page, request }` argument shape, the compile step) is identical.
 *
 * The "browser" is jsdom: a fake page whose `evaluate` runs a function
 * argument directly in the jsdom global (what Playwright does in a real page)
 * and a string argument as an expression.
 */

const AREA_URL_ID = "115341";
const DETAIL_URL = "https://www.booli.se/bostad/305443";

function addInlineScript(text: string) {
  const s = document.createElement("script");
  // Non-JS type: jsdom must not execute the snippet (it would fail on `self.__next_f`);
  // the extractor reads textContent of every inline script regardless of type.
  s.type = "text/x-booli-fixture";
  s.textContent = text;
  document.body.appendChild(s);
}

function card(listingId: string, title: string, subtitle: string, price: string, url: string) {
  return {
    __typename: "ListableProperty",
    position: { __typename: "Position", latitude: 59.31, longitude: 18.07 },
    listingId,
    amenities: [{ __typename: "Amenity", key: "balcony", label: "Balkong" }],
    displayAttributes: {
      __typename: "DisplayAttributes",
      dataPoints: [
        { __typename: "DataPoint", key: "livingArea", value: { plainText: "46,5 m²" } },
        { __typename: "DataPoint", key: "rooms", value: { plainText: "2 rum" } },
        { __typename: "DataPoint", key: "floor", value: { plainText: "vån 3" } },
        { __typename: "DataPoint", key: "rentOrPlotAreaText", value: { plainText: "3 557 kr/mån" } },
      ],
    },
    displayDate: "Inkommet idag",
    displayPrice: price,
    images: [{ __typename: "Image", id: "55983400", primaryLabel: "interior" }],
    objectType: "Lägenhet",
    saleType: "succession",
    subtitle,
    title,
    url,
    tracking: {
      __typename: "TrackingData",
      properties: { type: "property_active", booli_id: Number(listingId), upcoming_sale: false, municipality: "Stockholm" },
    },
    presenter: { __typename: "Presenter", name: "BOSTHLM" },
    originId: `listing:${listingId}`,
    queryContext: "SERP",
  };
}

function transportScript(cards: unknown[]): string {
  const rehydrate = {
    _R_a: { data: "__UNDEF__", loading: true },
    _R_b: { data: { listings: { __typename: "PropertySearchMeta", items: cards } } },
  };
  return `(window[Symbol.for("ApolloSSRDataTransport")] ??= []).push(${JSON.stringify({ rehydrate }).replace('"__UNDEF__"', "undefined")})`;
}

function flightScript(listing: unknown): string {
  const row6 = JSON.stringify(["$", "div", null, { children: ["$", "$L7", null, { listing }] }]);
  const flight = `1:"$Sreact.fragment"\n6:${row6}\n`;
  return `self.__next_f.push(${JSON.stringify([1, flight])})`;
}

/** A page whose browser is the jsdom document. */
function jsdomPage() {
  return {
    goto: async () => ({ status: () => 200 }),
    evaluate: async (arg: unknown) =>
      typeof arg === "function" ? (arg as () => unknown)() : new Function(`return (${String(arg)})`)(),
    close: async () => undefined,
  };
}

const fakeLauncher: LocalLauncher = {
  launch: async () => ({
    newContext: async () => ({ newPage: async () => jsdomPage(), close: async () => undefined }),
    close: async () => undefined,
    version: () => "148.0.7778.96",
  }),
};

/** What the Apify actor would put in its dataset: the page function's output, JSON-serialised. */
async function apifyDatasetItem(url: string): Promise<unknown> {
  const fn = new Function(`return (${APOLLO_PAGE_FUNCTION})`)() as (ctx: unknown) => Promise<unknown>;
  const out = await fn({ page: jsdomPage(), request: { url } });
  return JSON.parse(JSON.stringify(out));
}

let handle: LocalRendererHandle | null = null;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetApifyMock();
  document.body.innerHTML = "";
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await handle?.close();
  handle = null;
  setRenderer(null);
  errorSpy.mockRestore();
});

describe("renderer parity (D-05): local renderer vs mocked Apify actor", () => {
  it("search page: fetchAreaListings + toCandidate give deep-equal candidates, Swedish letters intact", async () => {
    addInlineScript(
      transportScript([
        card("6257338", "Höganäsgatan 5", "Lägenhet · Södermalm · Stockholm", "3 495 000 kr", "/bostad/662772"),
        card("6257339", "Åsögatan 12", "Lägenhet · Södermalm · Stockholm", "3 950 000 kr", "/bostad/662773"),
      ]),
    );

    // Path A: local renderer. The actor must never be called.
    handle = installLocalRenderer({ launcher: fakeLauncher, window: "visible" });
    const local = await fetchAreaListings(AREA_URL_ID, "Lägenhet", { maxPages: 1 });
    const localCandidates = local.listings.map((raw) => toCandidate(raw));
    expect(actorCall).not.toHaveBeenCalled();
    expect(handle.stats().pages).toBe(1);
    await handle.close();
    handle = null;

    // Path B: Apify (mocked), fed the same page function's output.
    setRenderer(null);
    actorCall.mockResolvedValue({ status: "SUCCEEDED", defaultDatasetId: "ds-1" });
    listItems.mockResolvedValue({
      items: [await apifyDatasetItem(`https://www.booli.se/sok/till-salu?areaIds=${AREA_URL_ID}`)],
    });
    const apify = await fetchAreaListings(AREA_URL_ID, "Lägenhet", { maxPages: 1 });
    const apifyCandidates = apify.listings.map((raw) => toCandidate(raw));
    expect(actorCall).toHaveBeenCalledTimes(1);

    expect(localCandidates).toHaveLength(2);
    expect(localCandidates).toEqual(apifyCandidates);
    expect(localCandidates.map((c) => c.address)).toEqual(["Höganäsgatan 5", "Åsögatan 12"]);
    expect(localCandidates.map((c) => c.areaLabel)).toEqual(["Södermalm", "Södermalm"]);
  });

  it("detail page: fetchListing + toCandidate give deep-equal candidates from the flight payload", async () => {
    addInlineScript(flightScript(listingDetailFixture));

    handle = installLocalRenderer({ launcher: fakeLauncher, window: "visible" });
    const local = toCandidate(await fetchListing(DETAIL_URL));
    expect(actorCall).not.toHaveBeenCalled();
    await handle.close();
    handle = null;

    setRenderer(null);
    actorCall.mockResolvedValue({ status: "SUCCEEDED", defaultDatasetId: "ds-1" });
    listItems.mockResolvedValue({ items: [await apifyDatasetItem(DETAIL_URL)] });
    const apify = toCandidate(await fetchListing(DETAIL_URL));
    expect(actorCall).toHaveBeenCalledTimes(1);

    expect(local.address).toBe("Testgatan 1");
    expect(local).toEqual(apify);
  });
});
