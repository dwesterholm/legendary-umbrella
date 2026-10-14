import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  SLUTPRIS_CONCURRENCY,
  SLUTPRIS_MAX_PAGES_PER_SLICE,
  SLUTPRIS_PAGE_ATTEMPTS,
  SLUTPRIS_SIZE_BANDS,
  SLUTPRIS_UPPER_BAND_MAX_PAGES,
  SLUTPRIS_UPPER_BAND_MIN_M2,
  ENRICH_BATCH_MAX,
  ENRICH_MAX_ATTEMPTS,
  ENRICH_STOP_FAIL_RATE,
  ENRICH_STOP_MIN_ATTEMPTS,
  IMAGE_IDS_MAX,
  SOLD_DETAIL_VERSION,
  brfEntrySchema,
  buildSlutprisSearchUrl,
  enrichBrfs,
  enrichSoldRows,
  enrichStopReason,
  needsEnrichment,
  newSlutprisCache,
  parseFloorLabel,
  parsePremiumLabel,
  pullSlutpriser,
  parseSoldDetailFacts,
  runPool,
  selectEnrichmentSample,
  sizeBandIndex,
  slutprisCacheSchema,
  SOLD_DETAIL_PAGE_FUNCTION,
  soldDetailUrl,
  soldRowSchema,
  soldRowsFromItems,
  stratifiedHashSample,
  subtractMonthsIso,
  type Slice,
  type SlutprisCache,
  type SoldRow,
} from "./slutpriser";

// ---------------------------------------------------------------------------
// Fixtures: shaped like the SoldProperty entries page-functions.ts builds.
// ---------------------------------------------------------------------------
interface EntryOpts {
  date?: string | null;
  price?: number | null;
  area?: string | null;
  label?: string | null;
  iconKey?: string | null;
  pctRaw?: number | null;
  floor?: string | null;
  rooms?: string | null;
  lat?: number | null;
  lng?: number | null;
}

function soldEntry(id: string, o: EntryOpts = {}) {
  const dataPoints: { key: string; value: { plainText: string } }[] = [];
  const area = o.area === undefined ? "37 m²" : o.area;
  if (area !== null) dataPoints.push({ key: "livingArea", value: { plainText: area } });
  const rooms = o.rooms === undefined ? "2 rum" : o.rooms;
  if (rooms !== null) dataPoints.push({ key: "rooms", value: { plainText: rooms } });
  const floor = o.floor === undefined ? "vån 2,5" : o.floor;
  if (floor !== null) dataPoints.push({ key: "floor", value: { plainText: floor } });
  dataPoints.push({ key: "soldSqmPrice", value: { plainText: "159 500 kr/m²" } });
  const price = o.price === undefined ? 3_700_000 : o.price;
  return {
    __typename: "SoldProperty",
    id,
    booliId: id,
    url: `/annons/${id}`,
    streetAddress: `Gata ${id}`,
    objectType: "Lägenhet",
    soldDate: o.date === undefined ? "2026-05-01" : o.date,
    soldPrice: price === null ? null : { __typename: "FormattedValue", raw: price },
    soldPricePercentageDiff: o.pctRaw == null ? null : { __typename: "FormattedValue", raw: o.pctRaw },
    priceRemark:
      o.label == null ? null : { label: o.label, icon: o.iconKey ? { key: o.iconKey } : undefined },
    displayAttributes: { dataPoints },
    latitude: o.lat === undefined ? 59.31 : o.lat,
    longitude: o.lng === undefined ? 18.07 : o.lng,
  };
}

function item(...entries: ReturnType<typeof soldEntry>[]) {
  const state: Record<string, unknown> = {};
  for (const e of entries) state[`SoldProperty:${e.id}`] = e;
  return { hasApollo: true, __APOLLO_STATE__: state };
}

function pageOf(url: string): number {
  return Number(new URL(url).searchParams.get("page"));
}

const CUTOFF = "2025-04-12";

function slice(district: Slice["district"], band: readonly [number, number], maxPages?: number): Slice {
  return { district, areaId: "115341", band, ...(maxPages === undefined ? {} : { maxPages }) };
}

function baseOpts(over: Partial<Parameters<typeof pullSlutpriser>[0]> & Pick<Parameters<typeof pullSlutpriser>[0], "render">) {
  return {
    slices: [slice("Södermalm", [35, 40])],
    cache: newSlutprisCache("2026-10-12", CUTOFF),
    cutoffIso: CUTOFF,
    concurrency: 8,
    maxPagesPerSlice: 5,
    maxRenders: 1000,
    newestFirst: true,
    persist: () => {},
    ...over,
  };
}

// ---------------------------------------------------------------------------
describe("buildSlutprisSearchUrl", () => {
  it("builds a Booli slutpriser URL from numeric parts only", () => {
    const url = buildSlutprisSearchUrl({
      areaId: "115341",
      page: 3,
      minLivingArea: 35,
      maxLivingArea: 40,
      objectType: "Lägenhet",
    });
    expect(url.startsWith("https://www.booli.se/sok/slutpriser?")).toBe(true);
    const sp = new URL(url).searchParams;
    expect(sp.get("areaIds")).toBe("115341");
    expect(sp.get("objectType")).toBe("Lägenhet");
    expect(sp.get("minLivingArea")).toBe("35");
    expect(sp.get("maxLivingArea")).toBe("40");
    expect(sp.get("page")).toBe("3");
  });

  it("rejects injection attempts and bad pages (T-14.1-08)", () => {
    const ok = { page: 1, minLivingArea: 35, maxLivingArea: 40, objectType: "Lägenhet" as const };
    expect(() => buildSlutprisSearchUrl({ ...ok, areaId: "115341&x=1" })).toThrow();
    expect(() => buildSlutprisSearchUrl({ ...ok, areaId: "abc" })).toThrow();
    expect(() => buildSlutprisSearchUrl({ ...ok, areaId: "" })).toThrow();
    expect(() => buildSlutprisSearchUrl({ ...ok, areaId: "1", page: 0 })).toThrow();
    expect(() => buildSlutprisSearchUrl({ ...ok, areaId: "1", page: 1.5 })).toThrow();
    expect(() => buildSlutprisSearchUrl({ ...ok, areaId: "1", minLivingArea: Number.NaN })).toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("parsePremiumLabel (R-04a precision probe)", () => {
  it.each([
    ["+12,5 %", 12.5],
    ["+12,5 %", 12.5],
    ["+12,5 %", 12.5],
    ["+13%", 13],
    ["–1,5 %", -1.5], // en dash
    ["−0,4 %", -0.4], // minus sign
    ["-2%", -2],
    ["+0 %", 0],
  ])("%s -> %s", (label, expected) => {
    expect(parsePremiumLabel(label)).toBe(expected);
  });

  it("never returns negative zero", () => {
    expect(Object.is(parsePremiumLabel("−0 %"), -0)).toBe(false);
    expect(Object.is(parsePremiumLabel("+0 %", "TrendDown"), -0)).toBe(false);
  });

  it("returns null for missing or unreadable labels, never 0", () => {
    expect(parsePremiumLabel(null)).toBeNull();
    expect(parsePremiumLabel(undefined)).toBeNull();
    expect(parsePremiumLabel("")).toBeNull();
    expect(parsePremiumLabel("okänt")).toBeNull();
    expect(parsePremiumLabel("abc 5 % def")).toBeNull();
  });

  it("lets the icon decide when the sign is missing or contradicts it", () => {
    expect(parsePremiumLabel("+1,5 %", "TrendDown")).toBe(-1.5);
    expect(parsePremiumLabel("1,5 %", "TrendDown")).toBe(-1.5);
    expect(parsePremiumLabel("–1,5 %", "TrendUp")).toBe(1.5);
    expect(parsePremiumLabel("+1,5 %", "TrendUp")).toBe(1.5);
    expect(parsePremiumLabel("–1,5 %", "SomethingElse")).toBe(-1.5);
  });
});

describe("parseFloorLabel", () => {
  it.each([
    ["vån 3", 3],
    ["vån 2,5", 2.5],
    ["BV", 0],
    ["bv", 0],
    ["vån -1", -1],
  ])("%s -> %s", (text, expected) => {
    expect(parseFloorLabel(text)).toBe(expected);
  });
  it("returns null for empty or unreadable text", () => {
    expect(parseFloorLabel("")).toBeNull();
    expect(parseFloorLabel(null)).toBeNull();
    expect(parseFloorLabel(undefined)).toBeNull();
    expect(parseFloorLabel("37 m²")).toBeNull();
  });
});

describe("subtractMonthsIso", () => {
  it("steps back whole months", () => {
    expect(subtractMonthsIso("2026-10-12", 18)).toBe("2025-04-12");
  });
  it("clamps to the last day of a shorter month", () => {
    expect(subtractMonthsIso("2026-03-31", 1)).toBe("2026-02-28");
    expect(subtractMonthsIso("2024-03-31", 1)).toBe("2024-02-29");
  });
  it("crosses a year boundary", () => {
    expect(subtractMonthsIso("2026-01-15", 1)).toBe("2025-12-15");
  });
  it("rejects malformed input", () => {
    expect(() => subtractMonthsIso("12 okt 2026", 1)).toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("soldRowsFromItems", () => {
  const listing = {
    __typename: "Listing",
    id: "999",
    listPrice: { raw: 3_000_000 },
    latitude: 59.3,
    longitude: 18.0,
  };

  function fixtureItems() {
    const negative = soldEntry("1", { price: 3_940_000, label: "–1,5 %", iconKey: "TrendDown", pctRaw: -1.5 });
    const noLabel = soldEntry("2", { label: null, pctRaw: null });
    const noDate = soldEntry("3", { date: null });
    const it1 = item(negative, noLabel, noDate);
    (it1.__APOLLO_STATE__ as Record<string, unknown>)["Listing:999"] = listing;
    return [it1];
  }

  it("keeps two rows, counts the missing sold date and ignores the Listing", () => {
    const out = soldRowsFromItems(fixtureItems(), "Södermalm", "Södermalm|35-40");
    expect(out.rows).toHaveLength(2);
    expect(out.missingSoldDate).toBe(1);
    expect(out.missingCoords).toBe(0);
    expect(out.missingPriceOrArea).toBe(0);
    expect(out.rows.map((r) => r.booliId).sort()).toEqual(["1", "2"]);
  });

  it("derives asking price only from a sign-correct label, and keeps kr/m2 a float", () => {
    const out = soldRowsFromItems(fixtureItems(), "Södermalm", "Södermalm|35-40");
    const neg = out.rows.find((r) => r.booliId === "1")!;
    const none = out.rows.find((r) => r.booliId === "2")!;
    expect(neg.soldVsAskPct).toBe(-1.5);
    expect(neg.askingPrice).toBeCloseTo(3_940_000 / 0.985, 6);
    expect(none.soldVsAskPct).toBeNull();
    expect(none.askingPrice).toBeNull();
    // exact division, not the card's rounded "159 500 kr/m²" text
    expect(none.krPerSqm).toBe(3_700_000 / 37);
    expect(none.krPerSqm).not.toBe(159_500);
    expect(neg.district).toBe("Södermalm");
    expect(neg.sliceKey).toBe("Södermalm|35-40");
    expect(neg.floor).toBe(2.5);
    expect(neg.rooms).toBe(2);
    expect(neg.soldDate).toBe("2026-05-01");
  });

  it("maps BV to floor 0 and a missing floor to null", () => {
    const out = soldRowsFromItems(
      [item(soldEntry("1", { floor: "BV" }), soldEntry("2", { floor: null }))],
      "Vasastan",
      "k",
    );
    expect(out.rows.find((r) => r.booliId === "1")!.floor).toBe(0);
    expect(out.rows.find((r) => r.booliId === "2")!.floor).toBeNull();
  });

  it("falls back to the page-function percentage when there is no priceRemark", () => {
    const out = soldRowsFromItems([item(soldEntry("1", { label: null, pctRaw: 4 }))], "Södermalm", "k");
    expect(out.rows[0].soldVsAskPct).toBe(4);
    expect(out.rows[0].askingPrice).toBeCloseTo(3_700_000 / 1.04, 6);
  });

  it("counts a sign disagreement and trusts the node-side parse", () => {
    const out = soldRowsFromItems(
      [item(soldEntry("1", { label: "+12,5 %", iconKey: "TrendUp", pctRaw: -12.5 }))],
      "Södermalm",
      "k",
    );
    expect(out.rows[0].soldVsAskPct).toBe(12.5);
    expect(out.signDisagreements).toBe(1);
  });

  it("excludes and counts entries without coordinates", () => {
    const out = soldRowsFromItems(
      [item(soldEntry("1", { lat: null, lng: null }), soldEntry("2", { lat: 59.3, lng: null }), soldEntry("3"))],
      "Södermalm",
      "k",
    );
    expect(out.rows.map((r) => r.booliId)).toEqual(["3"]);
    expect(out.missingCoords).toBe(2);
  });

  it("excludes and counts entries without price or area, never coercing to 0", () => {
    const out = soldRowsFromItems(
      [item(soldEntry("1", { price: null }), soldEntry("2", { area: null }), soldEntry("3", { price: 0 }), soldEntry("4"))],
      "Södermalm",
      "k",
    );
    expect(out.rows.map((r) => r.booliId)).toEqual(["4"]);
    expect(out.missingPriceOrArea).toBe(3);
  });

  it("treats an unreadable sold date as missing", () => {
    const out = soldRowsFromItems([item(soldEntry("1", { date: "12 okt. 2026" }))], "Södermalm", "k");
    expect(out.rows).toHaveLength(0);
    expect(out.missingSoldDate).toBe(1);
  });

  it("tolerates garbage input", () => {
    expect(soldRowsFromItems([null, 3, "x", {}, { __APOLLO_STATE__: null }], "Södermalm", "k").rows).toEqual([]);
    expect(soldRowsFromItems([], "Södermalm", "k").rows).toEqual([]);
  });

  it("produces rows that pass the row schema", () => {
    const out = soldRowsFromItems(fixtureItems(), "Södermalm", "k");
    for (const r of out.rows) expect(soldRowSchema.safeParse(r).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("runPool", () => {
  it("never runs more than `limit` tasks at once (20 tasks, limit 8 -> exactly 8)", async () => {
    let inFlight = 0;
    let max = 0;
    const tasks = Array.from({ length: 20 }, (_, i) => async () => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return i;
    });
    const results = await runPool(tasks, 8);
    expect(max).toBe(8);
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : -1))).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it("returns results in task order and keeps going after a rejection", async () => {
    const tasks = [
      async () => "a",
      async () => {
        throw new Error("boom");
      },
      async () => "c",
      () => {
        throw new Error("sync boom");
      },
      async () => "e",
    ];
    const results = await runPool(tasks as Array<() => Promise<string>>, 2);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled", "rejected", "fulfilled"]);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect((results[4] as PromiseFulfilledResult<string>).value).toBe("e");
  });

  it("handles no tasks and rejects a non-positive limit", async () => {
    expect(await runPool([], 8)).toEqual([]);
    await expect(runPool([async () => 1], 0)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("constants (R-12)", () => {
  it("has exactly the six R-12 size bands, contiguous from 35 to 120", () => {
    expect(SLUTPRIS_SIZE_BANDS).toEqual([
      [35, 40],
      [40, 45],
      [45, 50],
      [50, 60],
      [60, 80],
      [80, 120],
    ]);
    for (let i = 1; i < SLUTPRIS_SIZE_BANDS.length; i++) {
      expect(SLUTPRIS_SIZE_BANDS[i][0]).toBe(SLUTPRIS_SIZE_BANDS[i - 1][1]);
    }
    expect(SLUTPRIS_SIZE_BANDS[0][0]).toBe(35);
    expect(SLUTPRIS_SIZE_BANDS[SLUTPRIS_SIZE_BANDS.length - 1][1]).toBe(120);
  });

  it("caps the upper bands at 4 pages from 60 m2 up, and concurrency at 8", () => {
    expect(SLUTPRIS_UPPER_BAND_MIN_M2).toBe(60);
    expect(SLUTPRIS_UPPER_BAND_MAX_PAGES).toBe(4);
    expect(SLUTPRIS_CONCURRENCY).toBe(8);
    expect(SLUTPRIS_PAGE_ATTEMPTS).toBe(3);
    expect(SLUTPRIS_MAX_PAGES_PER_SLICE).toBe(30); // min(40, SLUTPRIS_PAGE_DEPTH 30)
  });
});

// ---------------------------------------------------------------------------
describe("pullSlutpriser", () => {
  it("keeps a row sold exactly on the cutoff and drops one a day older (FIT-01 boundary)", async () => {
    const render = vi.fn(async (url: string) => {
      const p = pageOf(url);
      if (p === 1) {
        return [item(soldEntry("a", { date: "2025-05-01" }), soldEntry("b", { date: "2025-04-12" }), soldEntry("c", { date: "2025-04-11" }))];
      }
      return [item(soldEntry("d", { date: "2025-04-10" }))];
    });
    const out = await pullSlutpriser(baseOpts({ render }));
    const ids = out.cache.rows.map((r) => r.booliId).sort();
    expect(ids).toEqual(["a", "b"]);
    expect(out.stoppedBy).toBe("done");
  });

  it("newestFirst: stops after the first page whose newest sold date is before the cutoff", async () => {
    const render = vi.fn(async (url: string) => {
      const p = pageOf(url);
      if (p === 1) return [item(soldEntry("a", { date: "2025-05-01" }))];
      if (p === 2) return [item(soldEntry("b", { date: "2025-04-10" }))];
      return [item(soldEntry("c", { date: "2025-04-09" }))];
    });
    const out = await pullSlutpriser(baseOpts({ render, newestFirst: true }));
    expect(render.mock.calls.map((c) => pageOf(c[0] as string))).toEqual([1, 2]);
    expect(out.rendersUsed).toBe(2);
  });

  it("not newestFirst: walks to maxPagesPerSlice and filters by date", async () => {
    const render = vi.fn(async (url: string) => {
      const p = pageOf(url);
      return [item(soldEntry(`p${p}`, { date: p === 2 ? "2025-04-01" : "2025-06-01" }))];
    });
    const out = await pullSlutpriser(baseOpts({ render, newestFirst: false, maxPagesPerSlice: 4 }));
    expect(render).toHaveBeenCalledTimes(4);
    expect(out.cache.rows.map((r) => r.booliId).sort()).toEqual(["p1", "p3", "p4"]);
  });

  it("stops a slice when a page stays empty after every attempt (end of results)", async () => {
    const render = vi.fn(async (url: string) => (pageOf(url) === 1 ? [item(soldEntry("a"))] : [item()]));
    const out = await pullSlutpriser(baseOpts({ render, newestFirst: false, maxPagesPerSlice: 6 }));
    // page 1 once, page 2 three times (an empty page is looked at again), then the slice ends
    expect(render).toHaveBeenCalledTimes(1 + SLUTPRIS_PAGE_ATTEMPTS);
    expect(out.cache.pages["Södermalm|35-40|2"]).toMatchObject({ status: "ok", rowCount: 0, attempts: SLUTPRIS_PAGE_ATTEMPTS });
    expect(out.cache.pages["Södermalm|35-40|3"]).toBeUndefined();
  });

  it("an empty first look is retried: a half-loaded page that fills in on attempt 2 is kept", async () => {
    let calls = 0;
    const render = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? [item()] : [item(soldEntry("a"), soldEntry("b"))];
    });
    const out = await pullSlutpriser(baseOpts({ render, newestFirst: false, maxPagesPerSlice: 1 }));
    expect(render).toHaveBeenCalledTimes(2);
    expect(out.cache.pages["Södermalm|35-40|1"]).toMatchObject({ status: "ok", rowCount: 2, attempts: 2 });
    expect(out.cache.rows).toHaveLength(2);
  });

  it("resume: an ok page with 0 entries and fewer than 3 attempts is looked at again; one with 3 stays final", async () => {
    const cache = newSlutprisCache("2026-10-12", CUTOFF);
    cache.pages["Södermalm|35-40|1"] = { status: "ok", attempts: 1, rowCount: 0, newestSoldDate: null, oldestSoldDate: null };
    cache.pages["Vasastan|35-40|1"] = { status: "ok", attempts: 3, rowCount: 0, newestSoldDate: null, oldestSoldDate: null };
    const urls: string[] = [];
    const render = vi.fn(async (u: string) => {
      urls.push(u);
      return [item(soldEntry("a"))];
    });
    await pullSlutpriser(
      baseOpts({
        render,
        cache,
        slices: [slice("Södermalm", [35, 40]), { district: "Vasastan", areaId: "115349", band: [35, 40] }],
        maxPagesPerSlice: 1,
        newestFirst: false,
      }),
    );
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]).searchParams.get("areaIds")).toBe("115341");
    expect(cache.pages["Södermalm|35-40|1"]).toMatchObject({ rowCount: 1 });
  });

  it("never has more than 8 renders in flight with 20 slices (FIT-01 boundary)", async () => {
    let inFlight = 0;
    let max = 0;
    const render = vi.fn(async (url: string) => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      const id = new URL(url).search;
      return [item(soldEntry(id))];
    });
    const districts = ["Södermalm", "Kungsholmen", "Vasastan", "Östermalm"] as const;
    const slices: Slice[] = [];
    for (const d of districts) for (const b of SLUTPRIS_SIZE_BANDS) slices.push(slice(d, b));
    const out = await pullSlutpriser(
      baseOpts({ render, slices: slices.slice(0, 20), concurrency: 8, maxPagesPerSlice: 1, newestFirst: false }),
    );
    expect(max).toBe(8);
    expect(out.rendersUsed).toBe(20);
  });

  it("clamps a larger requested concurrency down to 8", async () => {
    let inFlight = 0;
    let max = 0;
    const render = async (url: string) => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return [item(soldEntry(new URL(url).search))];
    };
    const slices: Slice[] = SLUTPRIS_SIZE_BANDS.flatMap((b) => [slice("Södermalm", b), slice("Vasastan", b)]);
    await pullSlutpriser(baseOpts({ render, slices, concurrency: 50, maxPagesPerSlice: 1, newestFirst: false }));
    expect(max).toBeLessThanOrEqual(SLUTPRIS_CONCURRENCY);
    expect(max).toBe(8);
  });

  it("resumes: an ok page in the cache is not rendered again and the slice continues at page 2", async () => {
    const cache = newSlutprisCache("2026-10-12", CUTOFF);
    cache.pages["Södermalm|35-40|1"] = {
      status: "ok",
      attempts: 1,
      rowCount: 3,
      newestSoldDate: "2026-09-01",
      oldestSoldDate: "2026-08-01",
    };
    const render = vi.fn(async (url: string) => [item(soldEntry(`p${pageOf(url)}`, { date: "2026-07-01" }))]);
    const out = await pullSlutpriser(baseOpts({ render, cache, maxPagesPerSlice: 3, newestFirst: false }));
    const pages = render.mock.calls.map((c) => pageOf(c[0] as string));
    expect(pages).toEqual([2, 3]);
    expect(out.rendersUsed).toBe(2);
  });

  it("resume uses stored dates for the stop rule: a cached page older than the cutoff ends the slice with no render", async () => {
    const cache = newSlutprisCache("2026-10-12", CUTOFF);
    cache.pages["Södermalm|35-40|1"] = {
      status: "ok",
      attempts: 1,
      rowCount: 5,
      newestSoldDate: "2025-04-01",
      oldestSoldDate: "2025-03-01",
    };
    const render = vi.fn(async () => [item(soldEntry("x"))]);
    const out = await pullSlutpriser(baseOpts({ render, cache, newestFirst: true }));
    expect(render).not.toHaveBeenCalled();
    expect(out.stoppedBy).toBe("done");
  });

  it("retries a failed page on resume", async () => {
    const cache = newSlutprisCache("2026-10-12", CUTOFF);
    cache.pages["Södermalm|35-40|1"] = { status: "failed", attempts: 3, rowCount: 0, newestSoldDate: null, oldestSoldDate: null };
    const render = vi.fn(async () => [item(soldEntry("a"))]);
    const out = await pullSlutpriser(baseOpts({ render, cache, maxPagesPerSlice: 1, newestFirst: false }));
    expect(render).toHaveBeenCalledTimes(1);
    expect(out.cache.pages["Södermalm|35-40|1"].status).toBe("ok");
  });

  it("attempts: rejects twice then resolves -> ok with attempts 3", async () => {
    let calls = 0;
    const render = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) throw new Error("timeout");
      return [item(soldEntry("a"))];
    });
    const out = await pullSlutpriser(baseOpts({ render, maxPagesPerSlice: 1, newestFirst: false }));
    expect(out.cache.pages["Södermalm|35-40|1"]).toMatchObject({ status: "ok", attempts: 3 });
    expect(out.rendersUsed).toBe(3);
  });

  it("attempts: three rejections -> failed, and the slice stops", async () => {
    const render = vi.fn(async () => {
      throw new Error("timeout");
    });
    const persist = vi.fn();
    const out = await pullSlutpriser(baseOpts({ render, persist, maxPagesPerSlice: 5, newestFirst: false }));
    expect(out.cache.pages["Södermalm|35-40|1"]).toMatchObject({ status: "failed", attempts: 3 });
    expect(out.cache.pages["Södermalm|35-40|2"]).toBeUndefined();
    expect(render).toHaveBeenCalledTimes(3);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  // 14.1 review WR-04, fixed in 14.2-03 (D-07): only a page that came back empty on
  // EVERY attempt is a genuine end of results. Any mix with an error is a failure,
  // so the slice stays resumable and a gap cannot skew the time coverage.
  describe("attempt sequences (WR-04)", () => {
    type Step = "empty" | "throw" | "data";
    /** A render that plays one step per call, in order. */
    function scripted(steps: Step[]) {
      let call = 0;
      return vi.fn(async () => {
        const step = steps[call++] ?? "data";
        if (step === "throw") throw new Error("proxy 403");
        return step === "empty" ? [item()] : [item(soldEntry("a"), soldEntry("b"))];
      });
    }

    it("empty, throw, throw -> failed with 3 attempts; the slice does not end as if results ran out", async () => {
      const render = scripted(["empty", "throw", "throw"]);
      const persist = vi.fn();
      const out = await pullSlutpriser(baseOpts({ render, persist, maxPagesPerSlice: 5, newestFirst: false }));
      expect(out.cache.pages["Södermalm|35-40|1"]).toMatchObject({ status: "failed", attempts: 3, rowCount: 0 });
      expect(out.cache.pages["Södermalm|35-40|2"]).toBeUndefined();
      expect(render).toHaveBeenCalledTimes(3);
      expect(persist).toHaveBeenCalledTimes(1);
    });

    it("empty, throw, throw -> a resume renders the page again and keeps the rows", async () => {
      const first = await pullSlutpriser(
        baseOpts({ render: scripted(["empty", "throw", "throw"]), maxPagesPerSlice: 1, newestFirst: false }),
      );
      expect(first.cache.pages["Södermalm|35-40|1"].status).toBe("failed");
      const resumeRender = scripted(["data"]);
      const second = await pullSlutpriser(
        baseOpts({ render: resumeRender, cache: first.cache, maxPagesPerSlice: 1, newestFirst: false }),
      );
      expect(resumeRender).toHaveBeenCalledTimes(1);
      expect(second.cache.pages["Södermalm|35-40|1"]).toMatchObject({ status: "ok", rowCount: 2 });
      expect(second.cache.rows).toHaveLength(2);
    });

    it("throw, empty, throw -> failed too (any mix with an error is not an end of results)", async () => {
      const out = await pullSlutpriser(
        baseOpts({ render: scripted(["throw", "empty", "throw"]), maxPagesPerSlice: 5, newestFirst: false }),
      );
      expect(out.cache.pages["Södermalm|35-40|1"]).toMatchObject({ status: "failed", attempts: 3 });
    });

    it("empty, empty, empty -> ok with 0 rows (a genuine end, as before)", async () => {
      const out = await pullSlutpriser(
        baseOpts({ render: scripted(["empty", "empty", "empty"]), maxPagesPerSlice: 5, newestFirst: false }),
      );
      expect(out.cache.pages["Södermalm|35-40|1"]).toMatchObject({ status: "ok", attempts: 3, rowCount: 0 });
    });

    it("throw, data -> ok with the rows (unchanged)", async () => {
      const out = await pullSlutpriser(
        baseOpts({ render: scripted(["throw", "data"]), maxPagesPerSlice: 1, newestFirst: false }),
      );
      expect(out.cache.pages["Södermalm|35-40|1"]).toMatchObject({ status: "ok", attempts: 2, rowCount: 2 });
    });

    it("throw, throw, throw -> failed (unchanged)", async () => {
      const out = await pullSlutpriser(
        baseOpts({ render: scripted(["throw", "throw", "throw"]), maxPagesPerSlice: 1, newestFirst: false }),
      );
      expect(out.cache.pages["Södermalm|35-40|1"]).toMatchObject({ status: "failed", attempts: 3 });
    });

    it("empty, data -> ok with the rows (unchanged)", async () => {
      const out = await pullSlutpriser(
        baseOpts({ render: scripted(["empty", "data"]), maxPagesPerSlice: 1, newestFirst: false }),
      );
      expect(out.cache.pages["Södermalm|35-40|1"]).toMatchObject({ status: "ok", attempts: 2, rowCount: 2 });
    });
  });

  it("persists after every page outcome", async () => {
    const render = vi.fn(async (url: string) => [item(soldEntry(`p${pageOf(url)}`, { date: "2026-07-01" }))]);
    const persist = vi.fn();
    await pullSlutpriser(baseOpts({ render, persist, maxPagesPerSlice: 3, newestFirst: false }));
    expect(persist).toHaveBeenCalledTimes(3);
    const last = persist.mock.calls[2][0] as SlutprisCache;
    expect(last.rows).toHaveLength(3);
    expect(Object.keys(last.pages)).toHaveLength(3);
  });

  it("stores a Booli id seen in two slices once and counts the duplicate", async () => {
    const render = vi.fn(async () => [item(soldEntry("same"))]);
    const out = await pullSlutpriser(
      baseOpts({
        render,
        slices: [slice("Södermalm", [35, 40]), slice("Kungsholmen", [35, 40])],
        maxPagesPerSlice: 1,
        newestFirst: false,
      }),
    );
    expect(out.cache.rows).toHaveLength(1);
    expect(out.cache.counts.duplicates).toBe(1);
  });

  it("maxRenders 5 stops scheduling after 5 render calls", async () => {
    const render = vi.fn(async (url: string) => [item(soldEntry(new URL(url).search))]);
    const slices: Slice[] = SLUTPRIS_SIZE_BANDS.flatMap((b) => [slice("Södermalm", b), slice("Vasastan", b)]);
    const out = await pullSlutpriser(baseOpts({ render, slices, maxRenders: 5, maxPagesPerSlice: 2, newestFirst: false }));
    expect(render).toHaveBeenCalledTimes(5);
    expect(out.rendersUsed).toBe(5);
    expect(out.stoppedBy).toBe("max-renders");
  });

  it("stops when the caller's budget guard trips and reports it", async () => {
    let n = 0;
    const render = vi.fn(async () => {
      n += 1;
      return [item(soldEntry(`p${n}`, { date: "2026-07-01" }))];
    });
    const out = await pullSlutpriser(
      baseOpts({ render, maxPagesPerSlice: 10, newestFirst: false, budgetExceeded: () => n >= 3 }),
    );
    expect(render).toHaveBeenCalledTimes(3);
    expect(out.stoppedBy).toBe("budget");
  });

  it("shouldStop (a shutdown signal) stops new renders at once, reports aborted, and keeps what was recorded (WR-11)", async () => {
    let n = 0;
    let stop = false;
    const render = vi.fn(async () => {
      n += 1;
      if (n === 3) stop = true; // the signal arrives while the third page is in flight
      return [item(soldEntry(`p${n}`, { date: "2026-07-01" }))];
    });
    const persisted: number[] = [];
    const out = await pullSlutpriser(
      baseOpts({ render, maxPagesPerSlice: 10, newestFirst: false, concurrency: 1, shouldStop: () => stop, persist: (c) => void persisted.push(Object.keys(c.pages).length) }),
    );
    expect(render).toHaveBeenCalledTimes(3);
    expect(out.stoppedBy).toBe("aborted");
    // the in-flight third page was still recorded and persisted
    expect(persisted.at(-1)).toBe(3);
  });

  it("per-slice page cap: maxPages 2 gets exactly 2 renders, an uncapped slice gets 9", async () => {
    const calls: Record<string, number> = {};
    const render = vi.fn(async (url: string) => {
      const sp = new URL(url).searchParams;
      const k = `${sp.get("minLivingArea")}-${sp.get("maxLivingArea")}`;
      calls[k] = (calls[k] ?? 0) + 1;
      return [item(soldEntry(`${k}-${sp.get("page")}`, { date: "2026-07-01" }))];
    });
    await pullSlutpriser(
      baseOpts({
        render,
        slices: [slice("Södermalm", [60, 80], 2), slice("Södermalm", [35, 40])],
        maxPagesPerSlice: 9,
        newestFirst: false,
      }),
    );
    expect(calls["60-80"]).toBe(2);
    expect(calls["35-40"]).toBe(9);
  });

  it("a slice's maxPages never raises the global cap", async () => {
    const render = vi.fn(async (url: string) => [item(soldEntry(`p${pageOf(url)}`, { date: "2026-07-01" }))]);
    await pullSlutpriser(
      baseOpts({ render, slices: [slice("Södermalm", [60, 80], 50)], maxPagesPerSlice: 3, newestFirst: false }),
    );
    expect(render).toHaveBeenCalledTimes(3);
  });

  it("accumulates the exclusion counts into the cache", async () => {
    const render = vi.fn(async () => [
      item(soldEntry("a"), soldEntry("b", { date: null }), soldEntry("c", { lat: null }), soldEntry("d", { price: null })),
    ]);
    const out = await pullSlutpriser(baseOpts({ render, maxPagesPerSlice: 1, newestFirst: false }));
    expect(out.cache.counts).toMatchObject({ missingSoldDate: 1, missingCoords: 1, missingPriceOrArea: 1, duplicates: 0 });
    expect(out.cache.rows.map((r) => r.booliId)).toEqual(["a"]);
  });

  it("builds only Booli slutpriser URLs for the slice's numeric area id and band", async () => {
    const urls: string[] = [];
    const render = vi.fn(async (u: string) => {
      urls.push(u);
      return [item(soldEntry("a"))];
    });
    await pullSlutpriser(
      baseOpts({ render, slices: [{ district: "Östermalm", areaId: "115348", band: [80, 120] }], maxPagesPerSlice: 1, newestFirst: false }),
    );
    const url = urls[0];
    expect(url.startsWith("https://www.booli.se/sok/slutpriser?")).toBe(true);
    const sp = new URL(url).searchParams;
    expect(sp.get("areaIds")).toBe("115348");
    expect(sp.get("minLivingArea")).toBe("80");
    expect(sp.get("maxLivingArea")).toBe("120");
  });
});

// ---------------------------------------------------------------------------
describe("slutprisCacheSchema / soldRowSchema (T-14.1-02)", () => {
  const goodRow = {
    booliId: "1",
    url: "/annons/1",
    address: "Gata 1",
    district: "Södermalm",
    soldDate: "2026-05-01",
    soldPrice: 3_700_000,
    soldVsAskPct: null,
    askingPrice: null,
    livingArea: 37,
    rooms: 2,
    floor: 2.5,
    krPerSqm: 100_000,
    lat: 59.31,
    lng: 18.07,
    sliceKey: "Södermalm|35-40",
  };

  it("accepts a good cache and round-trips an empty one", () => {
    const empty = newSlutprisCache("2026-10-12", CUTOFF);
    expect(slutprisCacheSchema.safeParse(empty).success).toBe(true);
    expect(slutprisCacheSchema.safeParse({ ...empty, rows: [goodRow] }).success).toBe(true);
  });

  it("rejects a row with a non-finite soldPrice", () => {
    const empty = newSlutprisCache("2026-10-12", CUTOFF);
    for (const bad of [Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(slutprisCacheSchema.safeParse({ ...empty, rows: [{ ...goodRow, soldPrice: bad }] }).success).toBe(false);
    }
    expect(soldRowSchema.safeParse({ ...goodRow, soldPrice: "3700000" }).success).toBe(false);
  });

  it("rejects a district outside the four", () => {
    const empty = newSlutprisCache("2026-10-12", CUTOFF);
    expect(slutprisCacheSchema.safeParse({ ...empty, rows: [{ ...goodRow, district: "Nacka" }] }).success).toBe(false);
  });

  it("rejects a wrong version and a malformed page entry", () => {
    const empty = newSlutprisCache("2026-10-12", CUTOFF);
    expect(slutprisCacheSchema.safeParse({ ...empty, version: 2 }).success).toBe(false);
    expect(
      slutprisCacheSchema.safeParse({ ...empty, pages: { k: { status: "maybe", attempts: 1, rowCount: 0, newestSoldDate: null, oldestSoldDate: null } } }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sold-detail enrichment (14.1-08, R-05 Path A: PROBES SOLD_DETAIL_BUILD_YEAR /
// SOLD_DETAIL_BALCONY / SOLD_DETAIL_LIST_PRICE are all `present`).
// ---------------------------------------------------------------------------
const FIXTURE = readFileSync(join(__dirname, "__fixtures__", "sold-detail-flight.fixture.txt"), "utf8");

/** A minimal flight line carrying one SoldProperty object, for the cases the fixture does not cover. */
function flightWith(object: Record<string, unknown>): string {
  return `19:${JSON.stringify([["$", "$L4a", null, { id: 1, object: { __typename: "SoldProperty", id: "1", ...object } }]])}\n`;
}

describe("parseSoldDetailFacts", () => {
  it("reads build year, balcony and list price from the committed fixture", () => {
    // Values recorded in 14.1-PROBES.md for this page: constructionYear 1933, amenities elevator + balcony, listPrice.raw 3195000.
    expect(parseSoldDetailFacts(FIXTURE)).toEqual({ buildYear: 1933, balcony: true, listPrice: 3_195_000, rentSek: null, brfId: null, tenureForm: null, daysActive: null, firstPrice: 3_195_000, imageIds: [] });
  });

  it("returns all null for an empty string and for text with no sold object", () => {
    expect(parseSoldDetailFacts("")).toEqual({ buildYear: null, balcony: null, listPrice: null, rentSek: null, brfId: null, tenureForm: null, daysActive: null, firstPrice: null, imageIds: [] });
    expect(parseSoldDetailFacts('1:"$Sreact.fragment"\n')).toEqual({ buildYear: null, balcony: null, listPrice: null, rentSek: null, brfId: null, tenureForm: null, daysActive: null, firstPrice: null, imageIds: [] });
    expect(parseSoldDetailFacts("19:[[{not json")).toEqual({ buildYear: null, balcony: null, listPrice: null, rentSek: null, brfId: null, tenureForm: null, daysActive: null, firstPrice: null, imageIds: [] });
  });

  it("reads an empty amenities list as 'balcony not listed' (false), the same way a for-sale card reads it", () => {
    const facts = parseSoldDetailFacts(flightWith({ constructionYear: 1908, amenities: [], listPrice: null }));
    expect(facts).toMatchObject({ buildYear: 1908, balcony: false, listPrice: null });
  });

  it("leaves balcony null when the page has no amenities field at all", () => {
    expect(parseSoldDetailFacts(flightWith({ constructionYear: 1950 })).balcony).toBeNull();
    expect(parseSoldDetailFacts(flightWith({ constructionYear: 1950, amenities: null })).balcony).toBeNull();
  });

  it("a balcony label with a negative value is false, not true", () => {
    const dp = (value: string) => ({
      displayAttributes: { dataPoints: [{ key: "balcony", label: "Balkong", value: { plainText: value } }] },
    });
    expect(parseSoldDetailFacts(flightWith(dp("Nej"))).balcony).toBe(false);
    expect(parseSoldDetailFacts(flightWith(dp("Ja"))).balcony).toBe(true);
  });

  it("an amenity whose key or label mentions balcony/balkong counts, others do not", () => {
    const amen = (key: string, label: string) => ({ __typename: "Amenity", key, label });
    expect(parseSoldDetailFacts(flightWith({ amenities: [amen("elevator", "Hiss"), amen("balcony", "Balkong")] })).balcony).toBe(true);
    expect(parseSoldDetailFacts(flightWith({ amenities: [amen("x", "Balkong")] })).balcony).toBe(true);
    expect(parseSoldDetailFacts(flightWith({ amenities: [amen("elevator", "Hiss"), amen("fireplace", "Öppen spis")] })).balcony).toBe(false);
  });

  it("takes the build year from the 'Byggår' data point when the field is missing, and rejects implausible years", () => {
    const dp = (year: string) => ({
      displayAttributes: { dataPoints: [{ key: "constructionYear", label: "Byggår", value: { plainText: year } }] },
    });
    expect(parseSoldDetailFacts(flightWith(dp("1962"))).buildYear).toBe(1962);
    expect(parseSoldDetailFacts(flightWith({ constructionYear: 1500 })).buildYear).toBeNull();
    expect(parseSoldDetailFacts(flightWith({ constructionYear: 2031 })).buildYear).toBeNull();
    expect(parseSoldDetailFacts(flightWith({ constructionYear: null })).buildYear).toBeNull();
    expect(parseSoldDetailFacts(flightWith({ constructionYear: "1933" })).buildYear).toBeNull();
    expect(parseSoldDetailFacts(flightWith({ constructionYear: 1700 })).buildYear).toBe(1700);
    expect(parseSoldDetailFacts(flightWith({ constructionYear: 2030 })).buildYear).toBe(2030);
  });

  it("list price must be a positive number", () => {
    const lp = (raw: unknown) => flightWith({ listPrice: { __typename: "FormattedValue", raw } });
    expect(parseSoldDetailFacts(lp(2_950_000)).listPrice).toBe(2_950_000);
    expect(parseSoldDetailFacts(lp(0)).listPrice).toBeNull();
    expect(parseSoldDetailFacts(lp(-5)).listPrice).toBeNull();
    expect(parseSoldDetailFacts(lp("3 000 000")).listPrice).toBeNull();
  });

  it("reads the sold object, not the one-line reference stub that follows it", () => {
    // The fixture ends with a stub: {"__typename":"SoldProperty","id":..,"booliId":..}. Reversing the order must not change the answer.
    const lines = FIXTURE.trim().split("\n");
    expect(parseSoldDetailFacts([...lines].reverse().join("\n"))).toMatchObject({ buildYear: 1933, balcony: true, listPrice: 3_195_000 });
  });

  it("is not fooled by braces and quotes inside strings", () => {
    const facts = parseSoldDetailFacts(flightWith({ note: 'a "quoted } brace {', constructionYear: 1975, amenities: [] }));
    expect(facts.buildYear).toBe(1975);
  });
});

// ---------------------------------------------------------------------------
// 14.4-02: the v2 read (avgift, BRF id, tenure, days on market, first price, photo ids).
// The three fixtures are trimmed real sold pages (no address, no coordinates).
// ---------------------------------------------------------------------------
const fixtureV2 = (k: "a" | "b" | "c"): string => readFileSync(join(__dirname, "__fixtures__", `sold-detail-flight-v2-${k}.fixture.txt`), "utf8");

describe("parseSoldDetailFacts v2 (14.4-02, R-01)", () => {
  it("fixture a (probe 6082254): avgift, BRF id, tenure, 6 days on market, the 5 photo ids in page order", () => {
    expect(parseSoldDetailFacts(fixtureV2("a"))).toEqual({
      buildYear: 1908,
      balcony: false,
      listPrice: null,
      rentSek: 1549,
      brfId: "268247",
      tenureForm: "Bostadsrätt",
      daysActive: 6,
      firstPrice: null,
      imageIds: ["52555065", "52555066", "52555067", "52555068", "52555069"],
    });
  });

  it("fixture b (probe 6197601): first price 3 700 000, list price 3 595 000, no photos, 41 days", () => {
    const f = parseSoldDetailFacts(fixtureV2("b"));
    expect(f).toMatchObject({ firstPrice: 3_700_000, listPrice: 3_595_000, imageIds: [], rentSek: 2783, brfId: "50166", daysActive: 41, buildYear: null });
  });

  it("fixture c (probe 6241048): build year 1933 and the days on market as printed on that page (26)", () => {
    expect(parseSoldDetailFacts(fixtureV2("c"))).toMatchObject({ buildYear: 1933, daysActive: 26, rentSek: 3449, brfId: "47604", tenureForm: "Bostadsrätt" });
  });

  it("the fixtures hold no street address and no coordinates", () => {
    for (const k of ["a", "b", "c"] as const) {
      const t = fixtureV2(k);
      expect(t.length).toBeLessThan(12_000);
      expect(t).not.toMatch(/"latitude"|"longitude"|streetAddress|"agentId"|Skeppargatan/);
    }
  });

  it("brfId falls back to the last breadcrumb when housingCoop is missing; a non-digit id gives null", () => {
    const crumb = (url: string) => ({ breadcrumbs: [{ label: "x", url: "/sok/x" }, { label: "BRF", url }] });
    expect(parseSoldDetailFacts(flightWith(crumb("/bostadsrattsforening/777?x=1"))).brfId).toBe("777");
    expect(parseSoldDetailFacts(flightWith(crumb("/bostadsrattsforening/777"))).brfId).toBe("777");
    expect(parseSoldDetailFacts(flightWith(crumb("/bostadsrattsforening/abc"))).brfId).toBeNull();
    expect(parseSoldDetailFacts(flightWith({ housingCoop: { id: "12x" }, ...crumb("/bostadsrattsforening/abc") })).brfId).toBeNull();
    expect(parseSoldDetailFacts(flightWith({ housingCoop: { id: "123" } })).brfId).toBe("123");
    expect(parseSoldDetailFacts(flightWith({ breadcrumbs: [] })).brfId).toBeNull();
  });

  it("daysActive: singular 'dag' counts, a missing info point or a non-number gives null", () => {
    const sec = (md: string, key = "daysActive") => ({ infoSections: [{ key: "propertyInfo", content: { infoPoints: [{ key, displayText: { markdown: md } }] } }] });
    expect(parseSoldDetailFacts(flightWith(sec("Bostaden var till salu i **1** dag"))).daysActive).toBe(1);
    expect(parseSoldDetailFacts(flightWith(sec("Bostaden var till salu i **0** dagar"))).daysActive).toBe(0);
    expect(parseSoldDetailFacts(flightWith(sec("Bostaden var till salu i **många** dagar"))).daysActive).toBeNull();
    expect(parseSoldDetailFacts(flightWith(sec("Bostaden var till salu i **6** dagar", "other"))).daysActive).toBeNull();
    expect(parseSoldDetailFacts(flightWith({ constructionYear: 1950 })).daysActive).toBeNull();
  });

  it("rentSek and firstPrice must be positive numbers", () => {
    const money = (raw: unknown) => ({ rent: { raw }, firstPrice: { raw } });
    expect(parseSoldDetailFacts(flightWith(money(2000))) ).toMatchObject({ rentSek: 2000, firstPrice: 2000 });
    for (const bad of [0, -1, "2 000", null]) {
      expect(parseSoldDetailFacts(flightWith(money(bad)))).toMatchObject({ rentSek: null, firstPrice: null });
    }
  });

  it("tenureForm is the page's own word or null", () => {
    expect(parseSoldDetailFacts(flightWith({ tenureForm: "Äganderätt" })).tenureForm).toBe("Äganderätt");
    expect(parseSoldDetailFacts(flightWith({ tenureForm: "" })).tenureForm).toBeNull();
    expect(parseSoldDetailFacts(flightWith({ tenureForm: 4 })).tenureForm).toBeNull();
  });

  it("imageIds keeps only digit-only string ids and at most IMAGE_IDS_MAX", () => {
    expect(IMAGE_IDS_MAX).toBe(8);
    const imgs = [{ id: "1" }, { id: "x2" }, { id: 3 }, { id: "../4" }, { id: "5" }, null, "6"];
    expect(parseSoldDetailFacts(flightWith({ images: imgs })).imageIds).toEqual(["1", "5"]);
    const many = Array.from({ length: 12 }, (_, i) => ({ id: String(100 + i) }));
    expect(parseSoldDetailFacts(flightWith({ images: many })).imageIds).toEqual(many.slice(0, 8).map((i) => i.id));
  });
});

describe("needsEnrichment and the v2 schema (14.4-02, R-03a)", () => {
  const old = { buildYear: 1900, balcony: false, listPrice: null };
  const v2 = { ...old, detailVersion: 2 as const, rentSek: 1500, brfId: "9", tenureForm: "Bostadsrätt", daysActive: 12, firstPrice: 3_000_000, imageIds: ["1", "2"] };

  it("an unenriched row needs it; an old-shape row needs it only for --re-enrich; a v2 row never", () => {
    expect(SOLD_DETAIL_VERSION).toBe(2);
    expect(needsEnrichment(soldRow(1))).toBe(true);
    expect(needsEnrichment(soldRow(1, { enriched: null }))).toBe(true);
    expect(needsEnrichment(soldRow(1, { enriched: old }))).toBe(false);
    expect(needsEnrichment(soldRow(1, { enriched: old }), { reEnrich: true })).toBe(true);
    expect(needsEnrichment(soldRow(1, { enriched: v2 }))).toBe(false);
    expect(needsEnrichment(soldRow(1, { enriched: v2 }), { reEnrich: true })).toBe(false);
  });

  it("a cache with one v2 row survives a JSON round trip with every new key intact (Pitfall 1)", () => {
    const cache: SlutprisCache = { ...newSlutprisCache("2026-10-13", CUTOFF), rows: [soldRow(1, { enriched: v2 }), soldRow(2, { enriched: old })] };
    const back = slutprisCacheSchema.parse(JSON.parse(JSON.stringify(cache)));
    expect(back.rows[0].enriched).toEqual(v2);
    expect(back.rows[1].enriched).toEqual(old);
  });

  it("rejects an id that is not digits, more than 8 photos, a negative day count", () => {
    const bad = (o: Record<string, unknown>) => soldRowSchema.safeParse(soldRow(1, { enriched: { ...v2, ...o } as SoldRow["enriched"] })).success;
    expect(bad({})).toBe(true);
    expect(bad({ brfId: "12a" })).toBe(false);
    expect(bad({ imageIds: ["1", "x"] })).toBe(false);
    expect(bad({ imageIds: Array.from({ length: 9 }, (_, i) => String(i)) })).toBe(false);
    expect(bad({ daysActive: -1 })).toBe(false);
    expect(bad({ daysActive: 1.5 })).toBe(false);
    expect(bad({ detailVersion: 3 })).toBe(false);
  });

  it("ENRICH_BATCH_MAX is 1500", () => {
    expect(ENRICH_BATCH_MAX).toBe(1500);
  });
});

describe("SOLD_DETAIL_PAGE_FUNCTION", () => {
  it("is a self-contained page function that returns the flight text and flags a blank page", () => {
    expect(SOLD_DETAIL_PAGE_FUNCTION.startsWith("async function pageFunction(context)")).toBe(true);
    expect(SOLD_DETAIL_PAGE_FUNCTION).toContain("hasApollo");
    expect(SOLD_DETAIL_PAGE_FUNCTION).toContain("flight");
  });
});

describe("soldDetailUrl (T-14.1-08)", () => {
  it("builds the URL from the digits of the Booli id on the fixed origin", () => {
    expect(soldDetailUrl("6241048")).toBe("https://www.booli.se/annons/6241048");
  });
  it("rejects anything that is not all digits", () => {
    for (const bad of ["", "12a", "../x", "1/2", "1?x=2", " 1", "https://evil.example/1"]) {
      expect(() => soldDetailUrl(bad)).toThrow();
    }
  });
});

function soldRow(id: number, over: Partial<SoldRow> = {}): SoldRow {
  return {
    booliId: String(id),
    url: `/annons/${id}`,
    address: null,
    district: "Södermalm",
    soldDate: "2026-05-01",
    soldPrice: 3_700_000,
    soldVsAskPct: null,
    askingPrice: null,
    livingArea: 37,
    rooms: 2,
    floor: 2,
    krPerSqm: 100_000,
    lat: 59.31,
    lng: 18.07,
    sliceKey: "Södermalm|35-40",
    ...over,
  };
}

describe("selectEnrichmentSample", () => {
  const rows = Array.from({ length: 1000 }, (_, i) => soldRow(6_000_000 + i));

  it("returns n distinct rows, the same ones on a second call, different ones for another seed", () => {
    const a = selectEnrichmentSample(rows, 200, "14.1");
    const b = selectEnrichmentSample(rows, 200, "14.1");
    const c = selectEnrichmentSample(rows, 200, "other");
    expect(a).toHaveLength(200);
    expect(new Set(a.map((r) => r.booliId)).size).toBe(200);
    expect(a.map((r) => r.booliId)).toEqual(b.map((r) => r.booliId));
    expect(a.map((r) => r.booliId)).not.toEqual(c.map((r) => r.booliId));
  });

  it("returns all rows when fewer than n exist, and nothing for n <= 0", () => {
    expect(selectEnrichmentSample(rows.slice(0, 7), 200, "14.1")).toHaveLength(7);
    expect(selectEnrichmentSample(rows, 0, "14.1")).toEqual([]);
    expect(selectEnrichmentSample(rows, -3, "14.1")).toEqual([]);
  });

  it("does not depend on the order the rows arrive in", () => {
    const fwd = selectEnrichmentSample(rows, 50, "14.1").map((r) => r.booliId).sort();
    const rev = selectEnrichmentSample([...rows].reverse(), 50, "14.1").map((r) => r.booliId).sort();
    expect(fwd).toEqual(rev);
  });

  it("does not modify the input array", () => {
    const copy = rows.map((r) => r.booliId);
    selectEnrichmentSample(rows, 100, "14.1");
    expect(rows.map((r) => r.booliId)).toEqual(copy);
  });

  it("keeps only rows sold on or after soldSince (boundary day included)", () => {
    const dated = [
      soldRow(1, { soldDate: "2025-09-30" }),
      soldRow(2, { soldDate: "2025-10-01" }),
      soldRow(3, { soldDate: "2026-01-15" }),
    ];
    const s = selectEnrichmentSample(dated, 10, "14.1", { soldSince: "2025-10-01" });
    expect(s.map((r) => r.booliId).sort()).toEqual(["2", "3"]);
    expect(selectEnrichmentSample(dated, 10, "14.1")).toHaveLength(3);
  });

  it("skips rows already enriched so that a re-run does not pay twice", () => {
    const mixed = rows.slice(0, 20).map((r, i) => (i < 5 ? { ...r, enriched: { buildYear: 1900, balcony: false, listPrice: null } } : r));
    const s = selectEnrichmentSample(mixed, 20, "14.1");
    expect(s).toHaveLength(15);
    expect(s.every((r) => !r.enriched)).toBe(true);
  });
});

describe("enrichSoldRows", () => {
  const flight = (year: number, balcony: boolean) =>
    flightWith({ constructionYear: year, amenities: balcony ? [{ key: "balcony", label: "Balkong" }] : [], listPrice: { raw: 3_000_000 } });
  const okItems = (year = 1950, balcony = true) => [{ hasApollo: true, flight: flight(year, balcony) }];

  it("never has more than `concurrency` renders in flight and enriches every row", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => soldRow(100 + i));
    let inFlight = 0;
    let peak = 0;
    const render = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return okItems();
    });
    const persist = vi.fn();
    const res = await enrichSoldRows({ rows, sample: rows, render, concurrency: 5, maxRenders: 1000, persist });
    expect(peak).toBe(5);
    expect(res).toEqual({ enriched: 40, failed: 0, noData: 0, rendersUsed: 40 });
    expect(rows.every((r) => r.enriched?.buildYear === 1950 && r.enriched.balcony === true && r.enriched.listPrice === 3_000_000)).toBe(true);
    expect(persist).toHaveBeenCalledTimes(40);
  });

  it("clamps a request for more than SLUTPRIS_CONCURRENCY to 8", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => soldRow(200 + i));
    let inFlight = 0;
    let peak = 0;
    const render = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return okItems();
    };
    await enrichSoldRows({ rows, sample: rows, render, concurrency: 50, maxRenders: 1000, persist: () => {} });
    expect(peak).toBe(SLUTPRIS_CONCURRENCY);
  });

  it("stops at maxRenders and leaves the rest unenriched", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => soldRow(300 + i));
    const render = vi.fn(async () => okItems());
    const res = await enrichSoldRows({ rows, sample: rows, render, concurrency: 4, maxRenders: 12, persist: () => {} });
    expect(render).toHaveBeenCalledTimes(12);
    expect(res.rendersUsed).toBe(12);
    expect(res.enriched).toBe(12);
    expect(rows.filter((r) => r.enriched).length).toBe(12);
  });

  it("stops when the budget check trips", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => soldRow(350 + i));
    let calls = 0;
    const render = async () => {
      calls += 1;
      return okItems();
    };
    const res = await enrichSoldRows({ rows, sample: rows, render, concurrency: 1, maxRenders: 1000, budgetExceeded: () => calls >= 5, persist: () => {} });
    expect(res.rendersUsed).toBe(5);
  });

  it("leaves `enriched` unset on a failed render, counts it, and carries on", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => soldRow(400 + i));
    const render = async (url: string) => {
      if (url.endsWith("/401") || url.endsWith("/403")) throw new Error("Kunde inte hämta");
      return okItems();
    };
    const persist = vi.fn();
    const res = await enrichSoldRows({ rows, sample: rows, render, concurrency: 3, maxRenders: 100, persist });
    expect(res).toEqual({ enriched: 4, failed: 2, noData: 0, rendersUsed: 6 });
    expect(rows[1].enriched).toBeUndefined();
    expect(rows[3].enriched).toBeUndefined();
    expect(rows[0].enriched).toBeTruthy();
    expect(persist).toHaveBeenCalledTimes(4);
  });

  it("counts a page that came back with no readable sold object as failed, not as 'no balcony'", async () => {
    const rows = [soldRow(500)];
    const render = async () => [{ hasApollo: true, flight: '1:"$Sreact.fragment"\n' }];
    const res = await enrichSoldRows({ rows, sample: rows, render, concurrency: 1, maxRenders: 10, persist: () => {} });
    expect(res).toEqual({ enriched: 0, failed: 0, noData: 1, rendersUsed: 1 });
    expect(rows[0].enriched).toBeUndefined();
  });

  it("renders the /annons/<booliId> page on the fixed origin, even when the row's own url is a /bostad/ page", async () => {
    const rows = [soldRow(600, { url: "/bostad/782543" })];
    const urls: string[] = [];
    await enrichSoldRows({
      rows,
      sample: rows,
      render: async (u) => {
        urls.push(u);
        return okItems();
      },
      concurrency: 1,
      maxRenders: 10,
      persist: () => {},
    });
    expect(urls).toEqual(["https://www.booli.se/annons/600"]);
  });

  it("does not render a row that is already enriched", async () => {
    const rows = [soldRow(700, { enriched: { buildYear: 1900, balcony: false, listPrice: null } }), soldRow(701)];
    const render = vi.fn(async () => okItems());
    const res = await enrichSoldRows({ rows, sample: rows, render, concurrency: 2, maxRenders: 10, persist: () => {} });
    expect(render).toHaveBeenCalledTimes(1);
    expect(res.enriched).toBe(1);
    expect(rows[0].enriched).toEqual({ buildYear: 1900, balcony: false, listPrice: null });
  });

  it("writes into the canonical row when the sample holds a copy", async () => {
    const rows = [soldRow(800)];
    const copy = { ...rows[0] };
    await enrichSoldRows({ rows, sample: [copy], render: async () => okItems(1999, false), concurrency: 1, maxRenders: 10, persist: () => {} });
    expect(rows[0].enriched).toMatchObject({ buildYear: 1999, balcony: false, listPrice: 3_000_000, detailVersion: 2 });
  });

  it("a sample row that is not in `rows` is skipped without a render", async () => {
    const rows = [soldRow(900)];
    const render = vi.fn(async () => okItems());
    const res = await enrichSoldRows({ rows, sample: [soldRow(901)], render, concurrency: 1, maxRenders: 10, persist: () => {} });
    expect(render).not.toHaveBeenCalled();
    expect(res).toEqual({ enriched: 0, failed: 0, noData: 0, rendersUsed: 0 });
  });
});

describe("selectEnrichmentSample and enrichSoldRows with reEnrich (14.4-02, R-03c)", () => {
  const oldShape = { buildYear: 1900, balcony: false, listPrice: 2_000_000 };
  const flight = flightWith({
    constructionYear: 1950,
    amenities: [],
    listPrice: { raw: 3_000_000 },
    rent: { raw: 2100 },
    tenureForm: "Bostadsrätt",
    housingCoop: { id: "55" },
    images: [{ id: "9" }],
    infoSections: [{ content: { infoPoints: [{ key: "daysActive", displayText: { markdown: "Bostaden var till salu i **8** dagar" } }] } }],
  });
  const ok = async () => [{ hasApollo: true, flight }];

  it("selects old-shape rows only with reEnrich", () => {
    const rows = [soldRow(1, { enriched: oldShape }), soldRow(2), soldRow(3, { enriched: { ...oldShape, detailVersion: 2 } })];
    expect(selectEnrichmentSample(rows, 10, "s").map((r) => r.booliId)).toEqual(["2"]);
    expect(selectEnrichmentSample(rows, 10, "s", { reEnrich: true }).map((r) => r.booliId).sort()).toEqual(["1", "2"]);
  });

  it("a successful re-read replaces the old record with detailVersion 2", async () => {
    const rows = [soldRow(1, { enriched: oldShape })];
    const res = await enrichSoldRows({ rows, sample: rows, render: ok, concurrency: 1, maxRenders: 5, persist: () => {}, reEnrich: true });
    expect(res.enriched).toBe(1);
    expect(rows[0].enriched).toEqual({
      buildYear: 1950,
      balcony: false,
      listPrice: 3_000_000,
      detailVersion: 2,
      rentSek: 2100,
      brfId: "55",
      tenureForm: "Bostadsrätt",
      daysActive: 8,
      firstPrice: null,
      imageIds: ["9"],
    });
  });

  it("a failed re-read keeps the old enriched record untouched (render throws, or no sold object)", async () => {
    const rows = [soldRow(1, { enriched: oldShape }), soldRow(2, { enriched: oldShape })];
    const render = async (url: string) => {
      if (url.endsWith("/1")) throw new Error("boom");
      return [{ hasApollo: true, flight: '1:"$Sreact.fragment"\n' }];
    };
    const res = await enrichSoldRows({ rows, sample: rows, render, concurrency: 1, maxRenders: 5, persist: () => {}, reEnrich: true });
    expect(res).toEqual({ enriched: 0, failed: 1, noData: 1, rendersUsed: 2 });
    expect(rows[0].enriched).toEqual(oldShape);
    expect(rows[1].enriched).toEqual(oldShape);
  });

  it("without reEnrich an old-shape row is not rendered", async () => {
    const rows = [soldRow(1, { enriched: oldShape })];
    const render = vi.fn(ok);
    await enrichSoldRows({ rows, sample: rows, render, concurrency: 1, maxRenders: 5, persist: () => {} });
    expect(render).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 14.4-02 task 2: making the long run safe.
// ---------------------------------------------------------------------------
describe("sizeBandIndex (14.4-02)", () => {
  it("lower edge inclusive, upper edge exclusive, last band upper edge inclusive, outside gives -1", () => {
    for (let i = 0; i < SLUTPRIS_SIZE_BANDS.length; i++) {
      const [lo, hi] = SLUTPRIS_SIZE_BANDS[i];
      const last = i === SLUTPRIS_SIZE_BANDS.length - 1;
      expect(sizeBandIndex(lo)).toBe(i);
      expect(sizeBandIndex(hi)).toBe(last ? i : i + 1);
      expect(sizeBandIndex(hi - 0.01)).toBe(i);
    }
    expect(sizeBandIndex(34.99)).toBe(-1);
    expect(sizeBandIndex(120.01)).toBe(-1);
    expect(sizeBandIndex(120)).toBe(SLUTPRIS_SIZE_BANDS.length - 1);
  });
});

describe("stratifiedHashSample and selectEnrichmentSample with stratify/ledger (14.4-02, D-04)", () => {
  // 4 strata (district x band) of 50 / 30 / 15 / 5 rows.
  const stratum = (start: number, count: number, district: SoldRow["district"], area: number): SoldRow[] =>
    Array.from({ length: count }, (_, i) => soldRow(start + i, { district, livingArea: area }));
  const rows = [
    ...stratum(1000, 50, "Södermalm", 37),
    ...stratum(2000, 30, "Södermalm", 55),
    ...stratum(3000, 15, "Kungsholmen", 37),
    ...stratum(4000, 5, "Kungsholmen", 70),
  ];
  const countBy = (picked: SoldRow[]) => {
    const m = new Map<string, number>();
    for (const r of picked) m.set(`${r.district}|${sizeBandIndex(r.livingArea)}`, (m.get(`${r.district}|${sizeBandIndex(r.livingArea)}`) ?? 0) + 1);
    return [m.get("Södermalm|0"), m.get("Södermalm|3"), m.get("Kungsholmen|0"), m.get("Kungsholmen|4")];
  };

  it("allocates n proportionally: 10 / 6 / 3 / 1 for n = 20 over 50 / 30 / 15 / 5", () => {
    expect(countBy(stratifiedHashSample(rows, 20, "14.1"))).toEqual([10, 6, 3, 1]);
  });

  it("the leftover seat goes to the largest remainder: n = 7 gives 4 / 2 / 1 / 0", () => {
    // exact quotas 3.5 / 2.1 / 1.05 / 0.35: floors 3 / 2 / 1 / 0 = 6, one seat left for the largest remainder (3.5)
    const picked = stratifiedHashSample(rows, 7, "14.1");
    expect(picked).toHaveLength(7);
    expect(countBy(picked)).toEqual([4, 2, 1, undefined]);
  });

  it("is deterministic, independent of input order, and picks each stratum in hash order", () => {
    const a = stratifiedHashSample(rows, 20, "14.1").map((r) => r.booliId);
    const b = stratifiedHashSample([...rows].reverse(), 20, "14.1").map((r) => r.booliId);
    expect(a).toEqual(b);
    // the first 10 of the big stratum are exactly its first 10 in plain hash order
    const plain = selectEnrichmentSample(rows.filter((r) => r.booliId.startsWith("1")), 10, "14.1").map((r) => r.booliId);
    expect(a.filter((id) => id.startsWith("1")).sort()).toEqual([...plain].sort());
  });

  it("n larger than the rows returns all of them; n <= 0 returns none; the input is untouched", () => {
    const copy = rows.map((r) => r.booliId);
    expect(stratifiedHashSample(rows, 500, "14.1")).toHaveLength(100);
    expect(stratifiedHashSample(rows, 0, "14.1")).toEqual([]);
    expect(rows.map((r) => r.booliId)).toEqual(copy);
  });

  it("stratify draws a FIXED sample: rows already read still count toward it, so a resume does not extend it", () => {
    const fresh = selectEnrichmentSample(rows, 20, "14.1", { stratify: true });
    expect(fresh).toHaveLength(20);
    const done = fresh.slice(0, 8).map((r) => r.booliId);
    const partly = rows.map((r) => (done.includes(r.booliId) ? { ...r, enriched: { buildYear: 1900, balcony: false, listPrice: null, detailVersion: 2 as const } } : r));
    const resumed = selectEnrichmentSample(partly, 20, "14.1", { stratify: true });
    expect(resumed.map((r) => r.booliId).sort()).toEqual(fresh.slice(8).map((r) => r.booliId).sort());
  });

  it("a row with two failed attempts in the ledger is never selected, a row with one still is", () => {
    const ledger = { "sold:1000": { attempts: ENRICH_MAX_ATTEMPTS }, "sold:1001": { attempts: 1 } };
    expect(ENRICH_MAX_ATTEMPTS).toBe(2);
    const plain = selectEnrichmentSample(rows, 500, "14.1", { ledger }).map((r) => r.booliId);
    expect(plain).not.toContain("1000");
    expect(plain).toContain("1001");
    const strat = selectEnrichmentSample(rows, 500, "14.1", { ledger, stratify: true }).map((r) => r.booliId);
    expect(strat).not.toContain("1000");
    expect(strat).toContain("1001");
  });
});

describe("failure ledger in enrichSoldRows (14.4-02, Pitfall 4)", () => {
  const goodFlight = flightWith({ constructionYear: 1950, amenities: [], rent: { raw: 2000 } });
  const ok = async () => [{ hasApollo: true, flight: goodFlight }];

  it("a failed read increments attempts, sets lastAt and a short reason; a later success deletes the entry", async () => {
    const rows = [soldRow(1), soldRow(2)];
    const ledger: Record<string, { attempts: number; lastAt: string; reason: string }> = {};
    class Boom extends Error {
      constructor() {
        super("https://www.booli.se/annons/1 gave 500 with a long message");
        this.name = "BoomError";
      }
    }
    const render = async (url: string) => {
      if (url.endsWith("/1")) throw new Boom();
      return [{ hasApollo: true, flight: '1:"$Sreact.fragment"\n' }];
    };
    const persist = vi.fn();
    await enrichSoldRows({ rows, sample: rows, render, concurrency: 1, maxRenders: 5, persist, ledger, today: "2026-10-13" });
    expect(ledger["sold:1"]).toEqual({ attempts: 1, lastAt: "2026-10-13", reason: "BoomError" });
    expect(ledger["sold:2"]).toEqual({ attempts: ENRICH_MAX_ATTEMPTS, lastAt: "2026-10-13", reason: "no_data" });
    expect(JSON.stringify(ledger)).not.toContain("booli.se");
    expect(persist).toHaveBeenCalled(); // the ledger change is written too

    await enrichSoldRows({ rows, sample: rows, render, concurrency: 1, maxRenders: 5, persist, ledger, today: "2026-10-14" });
    expect(ledger["sold:1"].attempts).toBe(2);
    expect(ledger["sold:1"].lastAt).toBe("2026-10-14");

    await enrichSoldRows({ rows, sample: rows, render: ok, concurrency: 2, maxRenders: 5, persist, ledger, today: "2026-10-15" });
    expect(ledger).toEqual({});
    expect(rows.every((r) => r.enriched?.detailVersion === 2)).toBe(true);
  });

  describe("a block is not the page's fault (WR-06)", () => {
    class ChallengeError extends Error {
      constructor() {
        super("HTTP 403");
        this.name = "ChallengeError";
      }
    }
    class NonRetryableRenderError extends Error {
      constructor() {
        super("Kunde inte hamta data fran Booli (lokal webblasare). Forsok igen.");
        this.name = "NonRetryableRenderError";
      }
    }

    it("a ChallengeError leaves no ledger entry, so two blocked days cannot kill the page", async () => {
      const rows = [soldRow(1), soldRow(2)];
      const ledger: Record<string, { attempts: number; lastAt: string; reason: string }> = {};
      const render = async () => {
        throw new ChallengeError();
      };
      const messages: string[] = [];
      for (const today of ["2026-10-13", "2026-10-14", "2026-10-15"]) {
        const res = await enrichSoldRows({ rows, sample: rows, render, concurrency: 1, maxRenders: 5, persist: () => {}, ledger, today, onProgress: (m) => messages.push(m) });
        expect(res.enriched).toBe(0);
      }
      expect(ledger).toEqual({});
      // Still due, and still picked by the sampler with the ledger in force.
      expect(selectEnrichmentSample(rows, 10, "seed", { ledger })).toHaveLength(2);
      expect(messages.every((m) => m.includes("blockerad"))).toBe(true);
    });

    it("the renderer's challenge counter rising during the call is enough, even when the thrown error has another class", async () => {
      const rows = [soldRow(1)];
      const ledger: Record<string, { attempts: number; lastAt: string; reason: string }> = {};
      let challenged = 0;
      const render = async () => {
        challenged += 1; // what the local browser does before it gives up with a NonRetryableRenderError
        throw new NonRetryableRenderError();
      };
      await enrichSoldRows({ rows, sample: rows, render, concurrency: 1, maxRenders: 5, persist: () => {}, ledger, today: "2026-10-13", challengedCount: () => challenged });
      expect(ledger).toEqual({});
    });

    it("an ordinary failure with a flat counter still costs an attempt", async () => {
      const rows = [soldRow(1)];
      const ledger: Record<string, { attempts: number; lastAt: string; reason: string }> = {};
      const render = async () => {
        throw new NonRetryableRenderError();
      };
      await enrichSoldRows({ rows, sample: rows, render, concurrency: 1, maxRenders: 5, persist: () => {}, ledger, today: "2026-10-13", challengedCount: () => 0 });
      expect(ledger["sold:1"]).toEqual({ attempts: 1, lastAt: "2026-10-13", reason: "NonRetryableRenderError" });
    });

    it("the block still counts as a failed render for the run (the stop rule sees it)", async () => {
      const rows = [soldRow(1)];
      const res = await enrichSoldRows({ rows, sample: rows, render: async () => { throw new ChallengeError(); }, concurrency: 1, maxRenders: 5, persist: () => {} });
      expect(res).toEqual({ enriched: 0, failed: 1, noData: 0, rendersUsed: 1 });
    });

    it("BRF pages are treated the same way", async () => {
      const cache = { ...newSlutprisCache("2026-10-13", CUTOFF) };
      const fetchBrf = async () => {
        throw new ChallengeError();
      };
      await enrichBrfs({ cache, ids: ["1", "2"], fetchBrf, persist: () => {}, today: "2026-10-13", concurrency: 1, maxFetches: 10 });
      expect(cache.enrichFailures ?? {}).toEqual({});
    });
  });

  describe("progress and rejection paths print no message and no URL (WR-07)", () => {
    class Leaky extends Error {
      status = 502;
      constructor() {
        super("GET https://www.booli.se/annons/1?token=SECRET via proxy user:pw@10.0.0.1 failed");
        this.name = "LeakyError";
      }
    }

    it("onProgress carries the class name and the HTTP status only", async () => {
      const rows = [soldRow(1)];
      const messages: string[] = [];
      await enrichSoldRows({ rows, sample: rows, render: async () => { throw new Leaky(); }, concurrency: 1, maxRenders: 5, persist: () => {}, onProgress: (m) => messages.push(m) });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("LeakyError");
      expect(messages[0]).toContain("HTTP 502");
      expect(messages[0]).not.toMatch(/booli\.se|SECRET|proxy|10\.0\.0\.1|https?:/i);
    });

    it("the aggregate error of an unexpected rejection names the class, not the message", async () => {
      const rows = [soldRow(1)];
      let calls = 0;
      const persist = () => {
        calls += 1;
        if (calls <= 1) throw new Leaky(); // the persist after the enrichment; the one before rethrowing succeeds
      };
      const render = async () => [{ hasApollo: true, flight: flightWith({ constructionYear: 1950, amenities: [], rent: { raw: 2000 } }) }];
      const err = await enrichSoldRows({ rows, sample: rows, render, concurrency: 1, maxRenders: 5, persist }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain("LeakyError");
      expect(err!.message).not.toMatch(/booli\.se|SECRET|proxy|10\.0\.0\.1|https?:/i);
    });

    it("the BRF pass prints the class name only too", async () => {
      const cache = { ...newSlutprisCache("2026-10-13", CUTOFF) };
      const messages: string[] = [];
      await enrichBrfs({ cache, ids: ["1"], fetchBrf: async () => { throw new Leaky(); }, persist: () => {}, today: "2026-10-13", concurrency: 1, maxFetches: 10, onProgress: (m) => messages.push(m) });
      expect(messages[0]).toContain("LeakyError");
      expect(messages[0]).not.toMatch(/booli\.se|SECRET|proxy|10\.0\.0\.1|https?:/i);
    });
  });

  it("passes the running attempted/failed counts to budgetExceeded", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => soldRow(10 + i));
    const seen: Array<{ attempted: number; failed: number }> = [];
    const render = async () => {
      throw new Error("x");
    };
    await enrichSoldRows({
      rows,
      sample: rows,
      render,
      concurrency: 1,
      maxRenders: 99,
      persist: () => {},
      budgetExceeded: (p) => {
        seen.push({ ...p });
        return p.attempted >= 3;
      },
    });
    expect(seen.map((x) => x.attempted)).toEqual([0, 1, 2, 3]);
    expect(seen[3]).toEqual({ attempted: 3, failed: 3 });
  });

  it("requires `today` when a ledger is given", async () => {
    const rows = [soldRow(1)];
    await expect(enrichSoldRows({ rows, sample: rows, render: ok, concurrency: 1, maxRenders: 5, persist: () => {}, ledger: {} })).rejects.toThrow(/today/);
  });
});

describe("enrichStopReason (14.4-02, D-04 stop rule)", () => {
  it("stops at the first challenge, whatever the attempt count", () => {
    expect(enrichStopReason({ challenged: 1, attempted: 3, failed: 0 })).toBe("utmaning");
    expect(enrichStopReason({ challenged: 2, attempted: 500, failed: 400 })).toBe("utmaning");
  });
  it("stops at 5 % true failures only after 100 attempts", () => {
    expect([ENRICH_STOP_FAIL_RATE, ENRICH_STOP_MIN_ATTEMPTS]).toEqual([0.05, 100]);
    expect(enrichStopReason({ challenged: 0, attempted: 99, failed: 10 })).toBeNull();
    expect(enrichStopReason({ challenged: 0, attempted: 100, failed: 4 })).toBeNull();
    expect(enrichStopReason({ challenged: 0, attempted: 100, failed: 5 })).toBe("felkvot");
    expect(enrichStopReason({ challenged: 0, attempted: 200, failed: 9 })).toBeNull();
    expect(enrichStopReason({ challenged: 0, attempted: 200, failed: 10 })).toBe("felkvot");
  });
  it("is quiet for a clean run", () => {
    expect(enrichStopReason({ challenged: 0, attempted: 0, failed: 0 })).toBeNull();
    expect(enrichStopReason({ challenged: 0, attempted: 1200, failed: 0 })).toBeNull();
  });
});

describe("enrichBrfs (14.4-02, D-03 second pass)", () => {
  const facts = { loanSek: 14_800_000, areaSqm: 3000, reportYear: 2025, debtPerSqm: 4933 };
  const cacheWith = (over: Partial<SlutprisCache> = {}): SlutprisCache => ({ ...newSlutprisCache("2026-10-13", CUTOFF), ...over });
  const base = { today: "2026-10-13", concurrency: 2, maxFetches: 100 };

  it("skips ids already in cache.brf and stores the rest with readAt = today, persisting after each", async () => {
    const cache = cacheWith({ brf: { "1": { ...facts, readAt: "2026-10-01" } } });
    const fetchBrf = vi.fn(async () => facts);
    const persist = vi.fn();
    const res = await enrichBrfs({ ...base, cache, ids: ["1", "2", "3"], fetchBrf, persist });
    expect(fetchBrf).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ fetched: 2, failed: 0, skipped: 1, attempted: 2 });
    expect(cache.brf?.["1"].readAt).toBe("2026-10-01");
    expect(cache.brf?.["2"]).toEqual({ ...facts, readAt: "2026-10-13" });
    expect(persist).toHaveBeenCalledTimes(2);
    expect(slutprisCacheSchema.safeParse(JSON.parse(JSON.stringify(cache))).success).toBe(true);
  });

  it("a throwing fetch records the ledger entry brf:<id> (class name only) and the run continues", async () => {
    const cache = cacheWith();
    const fetchBrf = async (id: string) => {
      if (id === "2") throw new TypeError("https://www.booli.se/bostadsrattsforening/2 failed");
      return facts;
    };
    const res = await enrichBrfs({ ...base, cache, ids: ["1", "2", "3"], fetchBrf, persist: () => {} });
    expect(res).toEqual({ fetched: 2, failed: 1, skipped: 0, attempted: 3 });
    expect(cache.enrichFailures?.["brf:2"]).toEqual({ attempts: 1, lastAt: "2026-10-13", reason: "TypeError" });
    expect(cache.brf?.["2"]).toBeUndefined();
    expect(JSON.stringify(cache.enrichFailures)).not.toContain("booli.se");
  });

  it("an id with two failed attempts is skipped; a later success clears the ledger entry", async () => {
    const cache = cacheWith({ enrichFailures: { "brf:5": { attempts: 2, lastAt: "2026-10-12", reason: "Error" }, "brf:6": { attempts: 1, lastAt: "2026-10-12", reason: "Error" } } });
    const fetchBrf = vi.fn(async () => facts);
    const res = await enrichBrfs({ ...base, cache, ids: ["5", "6"], fetchBrf, persist: () => {} });
    expect(res).toEqual({ fetched: 1, failed: 0, skipped: 1, attempted: 1 });
    expect(fetchBrf).toHaveBeenCalledWith("6");
    expect(cache.enrichFailures?.["brf:6"]).toBeUndefined();
    expect(cache.enrichFailures?.["brf:5"]?.attempts).toBe(2);
  });

  it("a page that rendered without the labels is stored (null fields), not counted as failed", async () => {
    const cache = cacheWith();
    const empty = { loanSek: null, areaSqm: null, reportYear: null, debtPerSqm: null };
    const res = await enrichBrfs({ ...base, cache, ids: ["9"], fetchBrf: async () => empty, persist: () => {} });
    expect(res.fetched).toBe(1);
    expect(cache.brf?.["9"]).toEqual({ ...empty, readAt: "2026-10-13" });
    expect(brfEntrySchema.safeParse(cache.brf?.["9"]).success).toBe(true);
  });

  it("budgetExceeded stops scheduling, maxFetches caps the attempts, concurrency never exceeds 2", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return facts;
    };
    const ids = Array.from({ length: 20 }, (_, i) => String(100 + i));
    const c1 = cacheWith();
    const r1 = await enrichBrfs({ ...base, concurrency: 50, cache: c1, ids, fetchBrf: slow, persist: () => {} });
    expect(peak).toBe(2);
    expect(r1.attempted).toBe(20);

    const c2 = cacheWith();
    let calls = 0;
    const r2 = await enrichBrfs({
      ...base,
      concurrency: 1,
      cache: c2,
      ids,
      fetchBrf: async () => {
        calls += 1;
        return facts;
      },
      persist: () => {},
      budgetExceeded: (p) => p.attempted >= 4,
    });
    expect(calls).toBe(4);
    expect(r2.attempted).toBe(4);

    const c3 = cacheWith();
    const r3 = await enrichBrfs({ ...base, maxFetches: 6, cache: c3, ids, fetchBrf: slow, persist: () => {} });
    expect(r3.attempted).toBe(6);
  });
});

describe("cache additions (14.4-02): brf and enrichFailures stay optional, version stays 1", () => {
  it("an old cache without them parses; the new keys round trip", () => {
    const empty = newSlutprisCache("2026-10-13", CUTOFF);
    expect(slutprisCacheSchema.safeParse(empty).success).toBe(true);
    const full = {
      ...empty,
      brf: { "268247": { loanSek: 1, areaSqm: 2, reportYear: 2025, debtPerSqm: 0, readAt: "2026-10-13" } },
      enrichFailures: { "sold:1": { attempts: 2, lastAt: "2026-10-13", reason: "Error" } },
    };
    expect(slutprisCacheSchema.parse(JSON.parse(JSON.stringify(full)))).toEqual(full);
    expect(slutprisCacheSchema.safeParse({ ...full, brf: { "12x": full.brf["268247"] } }).success).toBe(false);
    expect(slutprisCacheSchema.safeParse({ ...full, enrichFailures: { k: { attempts: -1, lastAt: "2026-10-13", reason: "x" } } }).success).toBe(false);
  });
});

describe("no_data pages are not block signals (14.4-02, R-10)", () => {
  const empty = async () => [{ hasApollo: true, flight: '1:"$Sreact.fragment"\n' }];

  it("60 pages that render without a sold payload never trip the stop rule and never reach the failure count", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => soldRow(5000 + i));
    const ledger: Record<string, { attempts: number; lastAt: string; reason: string }> = {};
    const seen: Array<{ attempted: number; failed: number }> = [];
    let challenged = 0;
    const res = await enrichSoldRows({
      rows,
      sample: rows,
      render: empty,
      concurrency: 1,
      maxRenders: 100,
      persist: () => {},
      ledger,
      today: "2026-10-13",
      budgetExceeded: (p) => {
        seen.push({ ...p });
        return enrichStopReason({ challenged, ...p }) !== null;
      },
    });
    expect(res).toEqual({ enriched: 0, failed: 0, noData: 60, rendersUsed: 60 });
    expect(seen.every((p) => p.failed === 0)).toBe(true);
    expect(Object.values(ledger).every((e) => e.reason === "no_data" && e.attempts >= ENRICH_MAX_ATTEMPTS)).toBe(true);
    challenged = 1;
    expect(enrichStopReason({ challenged, attempted: 60, failed: 0 })).toBe("utmaning");
  });

  it("a no_data row is never selected again, a once-failed row still is", () => {
    const rows = [soldRow(1), soldRow(2), soldRow(3)];
    const ledger = {
      "sold:1": { attempts: ENRICH_MAX_ATTEMPTS, reason: "no_data" },
      "sold:2": { attempts: 1, reason: "BoomError" },
    };
    expect(selectEnrichmentSample(rows, 10, "s", { ledger }).map((r) => r.booliId).sort()).toEqual(["2", "3"]);
  });

  it("true render failures still count: 5 of 100 stops, and they are ledgered by class name", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => soldRow(7000 + i));
    const ledger: Record<string, { attempts: number; lastAt: string; reason: string }> = {};
    const flight = flightWith({ constructionYear: 1950, amenities: [], rent: { raw: 2000 } });
    const render = async (url: string) => {
      if (Number(url.split("/").pop()) % 20 === 0) throw new TypeError("x");
      return [{ hasApollo: true, flight }];
    };
    const res = await enrichSoldRows({ rows, sample: rows, render, concurrency: 1, maxRenders: 200, persist: () => {}, ledger, today: "2026-10-13" });
    expect(res.failed).toBe(5);
    expect(res.noData).toBe(0);
    expect(enrichStopReason({ challenged: 0, attempted: res.rendersUsed, failed: res.failed })).toBe("felkvot");
    expect(Object.values(ledger).every((e) => e.reason === "TypeError")).toBe(true);
  });
});
