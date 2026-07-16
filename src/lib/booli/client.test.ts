import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  actorCall,
  listItems,
  resetApifyMock,
  apifyClientMockFactory,
} from "@/lib/booli/__mocks__/apify-client";
import listingDetailFixture from "@/lib/booli/__fixtures__/listing-detail.json";
import { scraperOutputSchema } from "@/lib/schemas/listing";
import { toCandidate, discoveryCandidateSchema } from "@/lib/discovery/candidate";

vi.mock("apify-client", () => apifyClientMockFactory());

const scrapeBooli = vi.fn();
vi.mock("@/lib/apify/booli-scraper", () => ({
  scrapeBooli: (...args: unknown[]) => scrapeBooli(...args),
}));

// Imported AFTER the mocks above are registered.
import {
  fetchListing,
  fetchAreaListings,
  fetchSoldComps,
  amenityKeys,
  brfNameFromBreadcrumbs,
  isAllowedImageHost,
  type SoldSourceQuery,
} from "@/lib/booli/client";

const DETAIL_URL = "https://www.booli.se/bostad/305443";

/** Wraps the real redacted fixture in the live Apify item shape. */
function apolloItem(entities: Record<string, Record<string, unknown>>) {
  return { hasApollo: true, __APOLLO_STATE__: entities };
}

function succeedRun() {
  actorCall.mockResolvedValue({ status: "SUCCEEDED", defaultDatasetId: "ds-1" });
}

beforeEach(() => {
  resetApifyMock();
  scrapeBooli.mockReset();
});

describe("fetchListing", () => {
  it("resolves a raw Record carrying the four requiredDisplayFields from a Listing: Apollo entity (SUCCEEDED run)", async () => {
    succeedRun();
    listItems.mockResolvedValue({
      items: [apolloItem({ "Listing:4463691": listingDetailFixture })],
    });

    const result = await fetchListing(DETAIL_URL);

    expect(result.streetAddress).toBe("Testgatan 1");
    expect(result.livingArea).toEqual(listingDetailFixture.livingArea);
    expect(result.rooms).toEqual(rawOf(listingDetailFixture.rooms));
    expect(result.listPrice).toEqual(listingDetailFixture.listPrice);

    // Same-shape contract: passes scraperOutputSchema for the four required
    // display fields (address/price/livingArea/rooms — via listPrice fallback).
    const parsed = scraperOutputSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("rejects a non-booli.se URL BEFORE any actor call (SSRF allowlist, T-05-10)", async () => {
    await expect(fetchListing("https://evil.example.com/bostad/1")).rejects.toThrow();
    expect(actorCall).not.toHaveBeenCalled();
    expect(scrapeBooli).not.toHaveBeenCalled();
  });

  it("rejects a substring-bypass URL where 'booli.se/' appears in the path of an attacker-controlled host (WR-03 hardening — real hostname check, not .includes())", async () => {
    await expect(
      fetchListing("https://evil.example/booli.se/bostad/1"),
    ).rejects.toThrow();
    expect(actorCall).not.toHaveBeenCalled();
    expect(scrapeBooli).not.toHaveBeenCalled();
  });

  it("rejects a substring-bypass URL where 'booli.se/' appears in the query string of an attacker-controlled host", async () => {
    await expect(
      fetchListing("https://evil.example/?x=booli.se/"),
    ).rejects.toThrow();
    expect(actorCall).not.toHaveBeenCalled();
    expect(scrapeBooli).not.toHaveBeenCalled();
  });

  it("accepts a real www.booli.se detail URL (SSRF allowlist positive case)", async () => {
    succeedRun();
    listItems.mockResolvedValue({
      items: [apolloItem({ "Listing:4463691": listingDetailFixture })],
    });

    await expect(fetchListing(DETAIL_URL)).resolves.toBeDefined();
  });

  it("rejects a malformed URL instead of throwing from new URL() unguarded", async () => {
    await expect(fetchListing("not a url")).rejects.toThrow();
    expect(actorCall).not.toHaveBeenCalled();
    expect(scrapeBooli).not.toHaveBeenCalled();
  });

  it("uses the pinned Listing: prefix and reuses the dataPointsOf deterministic variant-selection pattern for multi-variant displayAttributes", async () => {
    succeedRun();
    const entity = {
      ...listingDetailFixture,
      // Two variants, inserted in an order that would trip a naive
      // first-match walk (WR-05 regression guard).
      'displayAttributes({"queryContext":"SERP_LIST_LISTING"})': {
        __typename: "DisplayAttributes",
        dataPoints: [{ key: "rooms", value: { plainText: "1 rum" } }],
      },
      'displayAttributes({"queryContext":"PROPERTY_PAGE_LISTING"})': {
        __typename: "DisplayAttributes",
        dataPoints: [{ key: "livingArea", value: { plainText: "36 m²" } }],
      },
    };
    listItems.mockResolvedValue({
      items: [apolloItem({ "Listing:4463691": entity })],
    });

    const result = await fetchListing(DETAIL_URL);

    // Deterministic merge — both variants' dataPoints present, PROPERTY_PAGE
    // preferred first (matches client.ts's ordering rule).
    const points = result.displayDataPoints as Array<{ key?: string }>;
    expect(points.map((p) => p.key)).toEqual(["livingArea", "rooms"]);
  });

  // Rung 3 (the paid Lexis actor) is DISABLED for cost (2026-07-14). While it
  // is disabled, fetchListing degrades to the two own-render rungs and throws
  // when both fail (no paid fallback):
  it("throws when both own-render rungs fail — rung 3 (paid Lexis actor) is disabled", async () => {
    actorCall.mockRejectedValue(new Error("own-playwright render failed"));

    await expect(fetchListing(DETAIL_URL)).rejects.toThrow();
    expect(scrapeBooli).not.toHaveBeenCalled();
  });

  // ── RESTORE the paid-actor rung 3 by re-enabling these two tests (and the
  //    rung + import in client.ts, and re-renting the actor), then delete the
  //    disabled-state test above. ──────────────────────────────────────────
  // it("falls to rung 2 then rung 3 (scrapeBooli) only after BOTH own-render rungs throw", async () => {
  //   actorCall.mockRejectedValue(new Error("own-playwright render failed"));
  //   scrapeBooli.mockResolvedValue({ streetAddress: "Fallback 1", price: 100 });
  //   const result = await fetchListing(DETAIL_URL);
  //   expect(actorCall).toHaveBeenCalledTimes(2); // rung 1 + rung 2, both own renders
  //   expect(scrapeBooli).toHaveBeenCalledTimes(1); // rung 3, only after both threw
  //   expect(scrapeBooli).toHaveBeenCalledWith(DETAIL_URL);
  //   expect(result).toEqual({ streetAddress: "Fallback 1", price: 100 });
  // });
  // it("returns scrapeBooli's output UNCHANGED when rung 3 serves the request", async () => {
  //   actorCall.mockRejectedValue(new Error("own-playwright render failed"));
  //   const rawActorShape = {
  //     streetAddress: "Actor St 5", price: 3_000_000, livingArea: { raw: 50 }, rooms: 2, booliId: "999",
  //   };
  //   scrapeBooli.mockResolvedValue(rawActorShape);
  //   const result = await fetchListing(DETAIL_URL);
  //   expect(result).toBe(rawActorShape); // identity — no reshape applied to rung 3's output
  // });
});

describe("fetchAreaListings", () => {
  it("builds the till-salu URL via URLSearchParams (areaId only)", async () => {
    succeedRun();
    listItems.mockResolvedValue({
      items: [apolloItem({ "Listing:1": { ...listingDetailFixture, id: "1" } })],
    });

    await fetchAreaListings("115341");

    expect(actorCall).toHaveBeenCalledWith(
      expect.objectContaining({
        startUrls: [{ url: "https://www.booli.se/sok/till-salu?areaIds=115341" }],
      }),
      expect.anything(),
    );
  });

  it("appends &objectType=Lägenhet, URL-encoded via URLSearchParams", async () => {
    succeedRun();
    listItems.mockResolvedValue({
      items: [apolloItem({ "Listing:1": { ...listingDetailFixture, id: "1" } })],
    });

    await fetchAreaListings("115341", "Lägenhet");

    expect(actorCall).toHaveBeenCalledWith(
      expect.objectContaining({
        startUrls: [
          {
            url: "https://www.booli.se/sok/till-salu?areaIds=115341&objectType=L%C3%A4genhet",
          },
        ],
      }),
      expect.anything(),
    );
  });

  it("extracts multiple Listing: entities from one Apollo blob into multiple array elements", async () => {
    succeedRun();
    listItems.mockResolvedValue({
      items: [
        apolloItem({
          "Listing:1": { ...listingDetailFixture, id: "1", booliId: "1" },
          "Listing:2": { ...listingDetailFixture, id: "2", booliId: "2" },
          "Listing:3": { ...listingDetailFixture, id: "3", booliId: "3" },
          // Non-Listing entities must be skipped, not counted.
          "Area_V3:115341": { __typename: "Area_V3", name: "Södermalm" },
        }),
      ],
    });

    const result = await fetchAreaListings("115341");

    expect(result).toHaveLength(3);
    expect(result.map((r) => r.booliId)).toEqual(["1", "2", "3"]);
  });

  it("returns an honest empty [] for a SUCCEEDED render with zero Listing: entities (WR-01 — a genuinely empty area is NOT a dead source)", async () => {
    succeedRun();
    // A successful render whose Apollo blob carries no Listing: entities at
    // all (only unrelated entity types) — a real sparse/new area, not a
    // render failure. runPlaywrightRender already owns the dead-source throw
    // (empty dataset / hasApollo=false); this item clears that bar.
    listItems.mockResolvedValue({
      items: [apolloItem({ "Area_V3:999999": { __typename: "Area_V3", name: "Nowhere" } })],
    });

    const result = await fetchAreaListings("999999");

    expect(result).toEqual([]);
    // Rung 1 alone served the (honest, empty) result — no fallthrough to
    // rung 2, since an empty-but-successful render is not a rung failure.
    expect(actorCall).toHaveBeenCalledTimes(1);
  });

  it("falls to rung 2 (own-playwright-retry) when rung 1 throws — rung fallthrough mirrors fetchListing", async () => {
    actorCall
      .mockRejectedValueOnce(new Error("rung 1 failed"))
      .mockResolvedValueOnce({ status: "SUCCEEDED", defaultDatasetId: "ds-2" });
    listItems.mockResolvedValue({
      items: [apolloItem({ "Listing:1": { ...listingDetailFixture, id: "1" } })],
    });

    const result = await fetchAreaListings("115341");

    expect(actorCall).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
  });

  it("throws (HIGH-1) when both own-render rungs fail — no paid-actor rung 3 for area search (scrapeBooli is single-listing shaped)", async () => {
    actorCall.mockRejectedValue(new Error("own-playwright render failed"));

    await expect(fetchAreaListings("115341")).rejects.toThrow();
    expect(scrapeBooli).not.toHaveBeenCalled();
  });

  // Pagination (&page=N walk) — Booli truncates at ~36/page (live-probed
  // 2026-07-14: page 2 had 35 listings absent from page 1). A FULL page 1 (>=
  // FULL_PAGE_THRESHOLD 20) triggers a PARALLEL fetch of pages 2..MAX_AREA_PAGES.
  // Because those renders are parallel, their await order is non-deterministic —
  // so these tests key each page's data off the &page=N in the request URL
  // (via the dataset-id the mock threads to listItems), NOT call order.
  const fullPage = (startId: number, count: number) => {
    const entities: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < count; i++) {
      const id = String(startId + i);
      entities[`Listing:${id}`] = { ...listingDetailFixture, id, booliId: id };
    }
    return apolloItem(entities);
  };
  const pageOfUrl = (url: string) => {
    const m = url.match(/[?&]page=(\d+)/);
    return m ? Number(m[1]) : 1;
  };
  /**
   * Wires actorCall+listItems so page N's Apollo blob is `pages[N]` regardless
   * of concurrency order. `failPages` throw on BOTH rungs (a dead page).
   */
  const wirePages = (
    pages: Record<number, ReturnType<typeof fullPage>>,
    failPages: number[] = [],
  ) => {
    actorCall.mockImplementation(async (input: { startUrls: { url: string }[] }) => {
      const page = pageOfUrl(input.startUrls[0].url);
      if (failPages.includes(page)) throw new Error(`page ${page} blocked`);
      return { status: "SUCCEEDED", defaultDatasetId: `ds-${page}` };
    });
    listItems.mockImplementation(async (datasetId: string) => {
      const page = Number(String(datasetId).replace("ds-", ""));
      return { items: [pages[page] ?? apolloItem({})] }; // absent page → empty blob
    });
  };

  it("fetches pages 2..MAX in PARALLEL when page 1 is full, merging all distinct listings", async () => {
    wirePages({
      1: fullPage(1, 20),
      2: fullPage(21, 20),
      3: fullPage(41, 20),
      4: fullPage(61, 20),
      5: fullPage(81, 20),
    });

    const result = await fetchAreaListings("115341");

    expect(result).toHaveLength(100); // page 1 + the 4 parallel pages, all distinct
    expect(actorCall).toHaveBeenCalledTimes(5); // 1 sequential + 4 parallel
    // Every later page's &page=N URL was requested.
    const requestedPages = actorCall.mock.calls.map((c) => pageOfUrl(c[0].startUrls[0].url)).sort();
    expect(requestedPages).toEqual([1, 2, 3, 4, 5]);
  });

  it("does NOT paginate when page 1 is short (small area returned in full)", async () => {
    wirePages({ 1: fullPage(1, 5) }); // 5 < FULL_PAGE_THRESHOLD

    const result = await fetchAreaListings("115341");

    expect(result).toHaveLength(5);
    expect(actorCall).toHaveBeenCalledTimes(1); // page 1 only — no parallel batch
  });

  it("de-dupes listings that repeat across pages (by booliId)", async () => {
    wirePages({
      1: fullPage(1, 20),
      2: fullPage(1, 20), // same ids as page 1
      3: fullPage(1, 20), // same again
      4: apolloItem({}),
      5: apolloItem({}),
    });

    const result = await fetchAreaListings("115341");

    expect(result).toHaveLength(20); // deduped, not 60
  });

  it("keeps every page that succeeds when a LATER parallel page fails (non-fatal)", async () => {
    wirePages(
      {
        1: fullPage(1, 20),
        2: fullPage(21, 20),
        4: fullPage(61, 20),
        5: fullPage(81, 20),
        // page 3 has no data — it's in failPages
      },
      [3], // page 3 fails both rungs
    );

    const result = await fetchAreaListings("115341");

    expect(result).toHaveLength(80); // pages 1,2,4,5 — page 3's failure dropped, not fatal
  });
});

describe("fetchSoldComps", () => {
  // The live Södermalm breadcrumb ladder (wide→narrow) — mirrors
  // sold-source.test.ts's fixture so areaId resolution is exercised
  // end-to-end against a realistic ladder.
  const sodermalmCrumbs = [
    { label: "Stockholms län", url: "https://www.booli.se/sok/slutpriser?areaIds=2" },
    { label: "Stockholms kommun", url: "https://www.booli.se/sok/slutpriser?areaIds=1" },
    { label: "Södermalm", url: "https://www.booli.se/sok/slutpriser?areaIds=115341" },
    { label: "Helgagatan", url: "https://www.booli.se/sok/slutpriser?areaIds=102186" },
    { label: "BRF Helga", url: "https://www.booli.se/bostad/305443" },
  ];

  const query = (tier: SoldSourceQuery["tier"]): SoldSourceQuery => ({
    lat: 59.3089341,
    lng: 18.06933923,
    booliId: "305443",
    breadcrumbs: sodermalmCrumbs,
    tier,
  });

  /** A minimal, schema-shaped sold-comps render item (see __fixtures__/sold-comps.json). */
  function soldItem() {
    return {
      hasApollo: true,
      __APOLLO_STATE__: {
        "SoldProperty:1": { __typename: "SoldProperty", id: "1", booliId: "1" },
      },
    };
  }

  it("resolves the building-tier areaId from the breadcrumb ladder and calls the actor with the matching slutpriser URL", async () => {
    succeedRun();
    listItems.mockResolvedValue({ items: [soldItem()] });

    const { data, rendersUsed } = await fetchSoldComps(query("building"));

    expect(actorCall).toHaveBeenCalledWith(
      expect.objectContaining({
        startUrls: [
          { url: "https://www.booli.se/sok/slutpriser?areaIds=102186" },
        ],
      }),
      expect.anything(),
    );
    expect(data).toEqual([soldItem()]);
    // Happy (rung-1) path: exactly 1 real render, matching the pre-migration
    // one-actor-call-per-invocation cost assumption (WR-02).
    expect(rendersUsed).toBe(1);
  });

  it("falls to rung 2 (own-playwright-retry) when rung 1 throws, and reports rendersUsed=2 (WR-02 — the cost ledger must see the real degraded render count)", async () => {
    actorCall
      .mockRejectedValueOnce(new Error("rung 1 failed"))
      .mockResolvedValueOnce({ status: "SUCCEEDED", defaultDatasetId: "ds-2" });
    listItems.mockResolvedValue({ items: [soldItem()] });

    const { data, rendersUsed } = await fetchSoldComps(query("wide"));

    expect(actorCall).toHaveBeenCalledTimes(2);
    expect(data).toEqual([soldItem()]);
    expect(rendersUsed).toBe(2);
  });

  it("throws the Swedish user-facing HIGH-1 message when the areaId cannot be resolved (no breadcrumb carries an areaId) — never calls the actor", async () => {
    const unresolvable: SoldSourceQuery = {
      lat: 59.3,
      lng: 18.0,
      booliId: null,
      breadcrumbs: [{ label: "BRF only", url: "https://www.booli.se/bostad/1" }],
      tier: "building",
    };

    await expect(fetchSoldComps(unresolvable)).rejects.toThrow(
      /Prisjamforelse ar inte tillganglig/,
    );
    expect(actorCall).not.toHaveBeenCalled();
  });

  it("throws the Swedish user-facing HIGH-1 message once both own-render rungs fail — no paid-actor rung 3 for sold comps", async () => {
    actorCall.mockRejectedValue(new Error("own-playwright render failed"));

    await expect(fetchSoldComps(query("neighborhood"))).rejects.toThrow(
      /Prisjamforelse ar tillfalligt otillganglig/,
    );
    expect(actorCall).toHaveBeenCalledTimes(2);
    expect(scrapeBooli).not.toHaveBeenCalled();
  });
});

/** Local mirror of the `rawOf` coercion helper, for asserting against the fixture. */
function rawOf(v: unknown): number | null {
  return v && typeof v === "object" && "raw" in v
    ? ((v as { raw: unknown }).raw as number)
    : null;
}

/**
 * Phase 6 (06-01-PLAN.md Task 2, LSTG-03): floor/balcony/brfName recovered
 * from the existing Apollo entity — zero new network call. `amenityKeys`/
 * `brfNameFromBreadcrumbs` are unit-tested directly; `reshapeListingEntity`
 * itself (not exported) is exercised indirectly through `fetchListing`
 * against the real redacted fixture, matching this file's existing
 * convention (see `fetchListing` describe block above).
 */
describe("amenityKeys — strict ref-key parsing (Pitfall 3: never a substring match)", () => {
  it("strict-parses Amenity:{\"key\":\"balcony\"} to include \"balcony\"", () => {
    const refs = [{ __ref: 'Amenity:{"key":"balcony"}' }];
    expect(amenityKeys(refs)).toContain("balcony");
  });

  it("does NOT produce a false positive for a ref keyed balconyView (no substring bypass)", () => {
    const refs = [{ __ref: 'Amenity:{"key":"balconyView"}' }];
    expect(amenityKeys(refs)).not.toContain("balcony");
    expect(amenityKeys(refs)).toEqual(["balconyView"]);
  });

  it("skips a malformed ref (bad JSON suffix) instead of throwing", () => {
    const refs = [{ __ref: "Amenity:{not valid json" }, { __ref: 'Amenity:{"key":"balcony"}' }];
    expect(() => amenityKeys(refs)).not.toThrow();
    expect(amenityKeys(refs)).toEqual(["balcony"]);
  });

  it("returns [] for a non-array or empty input", () => {
    expect(amenityKeys(undefined)).toEqual([]);
    expect(amenityKeys(null)).toEqual([]);
    expect(amenityKeys([])).toEqual([]);
    expect(amenityKeys("not an array")).toEqual([]);
  });

  it("ignores non-Amenity refs and refs without a __ref string", () => {
    const refs = [
      { __ref: "Image:123" },
      { notARef: true },
      { __ref: 'Amenity:{"key":"balcony"}' },
    ];
    expect(amenityKeys(refs)).toEqual(["balcony"]);
  });
});

describe("brfNameFromBreadcrumbs — final /bostadsrattsforening/ crumb label", () => {
  it("returns the real fixture's BRF name from the last breadcrumb", () => {
    expect(brfNameFromBreadcrumbs(listingDetailFixture.breadcrumbs)).toBe("HSB BRF Metern");
  });

  it("returns null when the last entry's url does not match /bostadsrattsforening/", () => {
    const breadcrumbs = [
      { label: "Stockholm", url: "/sok/till-salu?areaIds=1" },
      { label: "Not a BRF crumb", url: "/sok/till-salu?areaIds=2" },
    ];
    expect(brfNameFromBreadcrumbs(breadcrumbs)).toBeNull();
  });

  it("returns null for a non-array or empty input", () => {
    expect(brfNameFromBreadcrumbs(undefined)).toBeNull();
    expect(brfNameFromBreadcrumbs(null)).toBeNull();
    expect(brfNameFromBreadcrumbs([])).toBeNull();
    expect(brfNameFromBreadcrumbs("not an array")).toBeNull();
  });

  it("returns null when the last breadcrumb has no label even if the url matches", () => {
    const breadcrumbs = [{ url: "/bostadsrattsforening/1" }];
    expect(brfNameFromBreadcrumbs(breadcrumbs)).toBeNull();
  });
});

describe("reshapeListingEntity (via fetchListing) — floor/balcony/brfName surfaced from Apollo", () => {
  it("surfaces floor as a number (3), balcony as true, brfName as HSB BRF Metern on the real fixture", async () => {
    succeedRun();
    listItems.mockResolvedValue({
      items: [apolloItem({ "Listing:4463691": listingDetailFixture })],
    });

    const result = await fetchListing(DETAIL_URL);

    expect(rawOf(result.floor) ?? result.floor).toBe(3);
    expect(result.balcony).toBe(true);
    expect(result.brfName).toBe("HSB BRF Metern");
  });

  it("yields balcony:false and brfName:null without throwing when amenities/breadcrumbs are absent", async () => {
    succeedRun();
    const entity = {
      ...listingDetailFixture,
      amenities: undefined,
      breadcrumbs: [{ label: "Too short", url: "/sok/till-salu?areaIds=1" }],
    };
    listItems.mockResolvedValue({
      items: [apolloItem({ "Listing:4463691": entity })],
    });

    const result = await fetchListing(DETAIL_URL);

    expect(result.balcony).toBe(false);
    expect(result.brfName).toBeUndefined();
  });

  it("yields floor:undefined without throwing when the entity has no floor field", async () => {
    succeedRun();
    const entity = { ...listingDetailFixture, floor: undefined };
    listItems.mockResolvedValue({
      items: [apolloItem({ "Listing:4463691": entity })],
    });

    const result = await fetchListing(DETAIL_URL);

    expect(result.floor).toBeUndefined();
  });
});

/**
 * Phase 12 (DISC-06, 12-03-PLAN.md Task 1): `description` is surfaced
 * read-only off the raw Apollo `Listing:` entity, mirroring the existing
 * `streetAddress: str(entry.streetAddress) ?? undefined` passthrough exactly
 * (client.ts line 284). This is ONLY a flat-record passthrough — NOT a
 * persistence decision. `toCandidate` (candidate.ts, Task 2) reads this
 * field locally to derive `orientation` via `extractOrientationFromDescription`
 * and discards the raw text; it is never itself added to the PII-safe
 * `DiscoveryCandidate` allowlist (RESEARCH.md Pitfall 3).
 */
describe("reshapeListingEntity (via fetchListing) — description surfaced from Apollo (Phase 12, DISC-06)", () => {
  it("surfaces description as a string when the raw Apollo entity carries one", async () => {
    succeedRun();
    const entity = {
      ...listingDetailFixture,
      description: "Ljus lägenhet i söderläge med balkong.",
    };
    listItems.mockResolvedValue({
      items: [apolloItem({ "Listing:4463691": entity })],
    });

    const result = await fetchListing(DETAIL_URL);

    expect(result.description).toBe("Ljus lägenhet i söderläge med balkong.");
  });

  it("yields description:undefined without throwing when the entity has no description field", async () => {
    succeedRun();
    // The real fixture's description is `null` (line 534) — str() must
    // coerce both a null value and an absent key to undefined, never throw.
    listItems.mockResolvedValue({
      items: [apolloItem({ "Listing:4463691": listingDetailFixture })],
    });

    const result = await fetchListing(DETAIL_URL);

    expect(result.description).toBeUndefined();
  });
});

/**
 * Phase 11 (DISC-04, 11-01-PLAN.md Task 2): the `imageUrls` extractor.
 *
 * GENUINELY UNVERIFIED against a live Apollo blob (11-RESEARCH.md Open
 * Question 1) — this fixture is shaped from RESEARCH's ASSUMED
 * `Array<{ url?: string; type?: string }>` ref shape (Assumption A1/A2), NOT
 * hand-invented from nothing (Pitfall 1 warning sign). The live probe
 * (`scripts/probe-booli-images.ts`) is operator-deferred; if it reveals a
 * different real shape, only `extractImageUrls` (client.ts) needs updating —
 * these tests pin the CONTRACT (capped, host-allowlisted, floor-plan-first,
 * never-throwing), not the unconfirmed field names themselves.
 */
describe("reshapeListingEntity imageUrls extractor (via fetchListing) — Phase 11 DISC-04", () => {
  // REAL shape (live-confirmed 2026-07-09, replacing the earlier ASSUMED
  // inline-`{url}` shape): the Listing entity holds `images: [{__ref:"Image:<id>"}]`;
  // each `Image:<id>` entity carries only {id, primaryLabel}; the gallery URL is
  // BUILT as https://bcdn.se/images/cache/<id>_1440x0.webp and resolved by
  // collectListingEntities against the Apollo state.
  const bcdn = (id: string) => `https://bcdn.se/images/cache/${id}_1440x0.webp`;
  const stateWith = (imgs: Array<{ id: string; primaryLabel?: string }>) => {
    const entities: Record<string, Record<string, unknown>> = {
      "Listing:4463691": {
        ...listingDetailFixture,
        images: imgs.map((im) => ({ __ref: `Image:${im.id}` })),
      },
    };
    for (const im of imgs) {
      entities[`Image:${im.id}`] = { __typename: "Image", id: im.id, primaryLabel: im.primaryLabel };
    }
    return entities;
  };

  it("resolves image refs to bcdn.se URLs, caps at CAP_IMAGES_PER_LISTING (4), floor plan (primaryLabel) first", async () => {
    succeedRun();
    listItems.mockResolvedValue({
      items: [
        apolloItem(
          stateWith([
            { id: "1", primaryLabel: "interior" },
            { id: "2", primaryLabel: "floorplan" },
            { id: "3" },
            { id: "4" },
            { id: "5" },
            { id: "6" },
          ]),
        ),
      ],
    });

    const result = await fetchListing(DETAIL_URL);

    const urls = result.imageUrls as string[];
    expect(urls).toHaveLength(4);
    expect(urls[0]).toBe(bcdn("2")); // floor plan first
    expect(urls.every((u) => u.startsWith("https://bcdn.se/"))).toBe(true);
  });

  it("yields imageUrls:undefined (never a throw) when the entity has no image refs — degrades via toCandidate to null", async () => {
    succeedRun();
    listItems.mockResolvedValue({
      items: [apolloItem({ "Listing:4463691": { ...listingDetailFixture } })],
    });

    const result = await fetchListing(DETAIL_URL);

    expect(result.imageUrls).toBeUndefined();
    expect(toCandidate(result).imageUrls).toBeNull();
  });

  it("skips a ref that doesn't resolve to an Image entity with an id, never fabricating a URL", async () => {
    succeedRun();
    const entities = stateWith([{ id: "1", primaryLabel: "interior" }]);
    (entities["Listing:4463691"].images as unknown[]).push(
      { __ref: "Image:missing" }, // no matching entity
      { __ref: "Image:noid" }, // entity present but no id
    );
    entities["Image:noid"] = { __typename: "Image" };
    listItems.mockResolvedValue({ items: [apolloItem(entities)] });

    const result = await fetchListing(DETAIL_URL);

    expect(result.imageUrls).toEqual([bcdn("1")]);
  });

  it("allows bcdn.se — Booli's real image CDN (probe-confirmed 2026-07-09)", async () => {
    succeedRun();
    listItems.mockResolvedValue({
      items: [apolloItem(stateWith([{ id: "42", primaryLabel: "kitchen" }]))],
    });

    const result = await fetchListing(DETAIL_URL);

    expect(result.imageUrls).toEqual([bcdn("42")]);
  });

  it("toCandidate maps imageUrls; vision and visionSkippedReason default to null", async () => {
    succeedRun();
    listItems.mockResolvedValue({
      items: [apolloItem(stateWith([{ id: "1" }, { id: "2" }]))],
    });

    const raw = await fetchListing(DETAIL_URL);
    const candidate = toCandidate(raw);

    expect(candidate.imageUrls).toEqual([bcdn("1"), bcdn("2")]);
    expect(candidate.vision).toBeNull();
    expect(candidate.visionSkippedReason).toBeNull();
  });

  it("isAllowedImageHost: allows booli.se + bcdn.se (https only), rejects other hosts + substring-bypass attempts", () => {
    expect(isAllowedImageHost("https://booli.se/x.jpg")).toBe(true);
    expect(isAllowedImageHost("https://img.booli.se/x.jpg")).toBe(true);
    expect(isAllowedImageHost("https://bcdn.se/images/cache/1_1440x0.webp")).toBe(true);
    expect(isAllowedImageHost("https://hm.bcdn.se/logo.png")).toBe(true);
    // rejected
    expect(isAllowedImageHost("http://bcdn.se/x.jpg")).toBe(false); // not https
    expect(isAllowedImageHost("https://evil.example/x.jpg")).toBe(false);
    expect(isAllowedImageHost("https://bcdn.se.evil.example/x.jpg")).toBe(false); // substring bypass
    expect(isAllowedImageHost("https://booli.se.evil.example/x.jpg")).toBe(false);
    expect(isAllowedImageHost("not a url")).toBe(false);
  });

  it("discoveryCandidateSchema.safeParse succeeds on a legacy row with NO imageUrls/vision/visionSkippedReason keys, normalizing all three to null", () => {
    const legacyRow = {
      address: "Testgatan 1",
      price: 3_500_000,
      rooms: 2,
      livingArea: 55,
      areaLabel: "Norrmalm",
      thumbnailUrl: null,
      sourceListingUrl: "https://www.booli.se/annons/123",
    };

    const result = discoveryCandidateSchema.safeParse(legacyRow);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.imageUrls).toBeNull();
      expect(result.data.vision).toBeNull();
      expect(result.data.visionSkippedReason).toBeNull();
    }
  });
});
