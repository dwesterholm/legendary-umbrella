import { describe, it, expect, vi } from "vitest";
import {
  SLUTPRIS_CONCURRENCY,
  SLUTPRIS_MAX_PAGES_PER_SLICE,
  SLUTPRIS_PAGE_ATTEMPTS,
  SLUTPRIS_SIZE_BANDS,
  SLUTPRIS_UPPER_BAND_MAX_PAGES,
  SLUTPRIS_UPPER_BAND_MIN_M2,
  buildSlutprisSearchUrl,
  newSlutprisCache,
  parseFloorLabel,
  parsePremiumLabel,
  pullSlutpriser,
  runPool,
  slutprisCacheSchema,
  soldRowSchema,
  soldRowsFromItems,
  subtractMonthsIso,
  type Slice,
  type SlutprisCache,
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

  it("stops a slice when a page returns no sold rows", async () => {
    const render = vi.fn(async (url: string) => (pageOf(url) === 1 ? [item(soldEntry("a"))] : [item()]));
    const out = await pullSlutpriser(baseOpts({ render, newestFirst: false, maxPagesPerSlice: 6 }));
    expect(render).toHaveBeenCalledTimes(2);
    expect(out.cache.pages["Södermalm|35-40|2"]).toMatchObject({ status: "ok", rowCount: 0 });
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
