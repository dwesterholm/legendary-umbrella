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
  buildSlutprisSearchUrl,
  enrichSoldRows,
  newSlutprisCache,
  parseFloorLabel,
  parsePremiumLabel,
  pullSlutpriser,
  parseSoldDetailFacts,
  runPool,
  selectEnrichmentSample,
  slutprisCacheSchema,
  SOLD_DETAIL_PAGE_FUNCTION,
  soldDetailUrl,
  soldRowSchema,
  soldRowsFromItems,
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
    expect(parseSoldDetailFacts(FIXTURE)).toEqual({ buildYear: 1933, balcony: true, listPrice: 3_195_000 });
  });

  it("returns all null for an empty string and for text with no sold object", () => {
    expect(parseSoldDetailFacts("")).toEqual({ buildYear: null, balcony: null, listPrice: null });
    expect(parseSoldDetailFacts('1:"$Sreact.fragment"\n')).toEqual({ buildYear: null, balcony: null, listPrice: null });
    expect(parseSoldDetailFacts("19:[[{not json")).toEqual({ buildYear: null, balcony: null, listPrice: null });
  });

  it("reads an empty amenities list as 'balcony not listed' (false), the same way a for-sale card reads it", () => {
    const facts = parseSoldDetailFacts(flightWith({ constructionYear: 1908, amenities: [], listPrice: null }));
    expect(facts).toEqual({ buildYear: 1908, balcony: false, listPrice: null });
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
    expect(parseSoldDetailFacts([...lines].reverse().join("\n"))).toEqual({ buildYear: 1933, balcony: true, listPrice: 3_195_000 });
  });

  it("is not fooled by braces and quotes inside strings", () => {
    const facts = parseSoldDetailFacts(flightWith({ note: 'a "quoted } brace {', constructionYear: 1975, amenities: [] }));
    expect(facts.buildYear).toBe(1975);
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
    expect(res).toEqual({ enriched: 40, failed: 0, rendersUsed: 40 });
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
    expect(res).toEqual({ enriched: 4, failed: 2, rendersUsed: 6 });
    expect(rows[1].enriched).toBeUndefined();
    expect(rows[3].enriched).toBeUndefined();
    expect(rows[0].enriched).toBeTruthy();
    expect(persist).toHaveBeenCalledTimes(4);
  });

  it("counts a page that came back with no readable sold object as failed, not as 'no balcony'", async () => {
    const rows = [soldRow(500)];
    const render = async () => [{ hasApollo: true, flight: '1:"$Sreact.fragment"\n' }];
    const res = await enrichSoldRows({ rows, sample: rows, render, concurrency: 1, maxRenders: 10, persist: () => {} });
    expect(res).toEqual({ enriched: 0, failed: 1, rendersUsed: 1 });
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
    expect(rows[0].enriched).toEqual({ buildYear: 1999, balcony: false, listPrice: 3_000_000 });
  });

  it("a sample row that is not in `rows` is skipped without a render", async () => {
    const rows = [soldRow(900)];
    const render = vi.fn(async () => okItems());
    const res = await enrichSoldRows({ rows, sample: [soldRow(901)], render, concurrency: 1, maxRenders: 10, persist: () => {} });
    expect(render).not.toHaveBeenCalled();
    expect(res).toEqual({ enriched: 0, failed: 0, rendersUsed: 0 });
  });
});
