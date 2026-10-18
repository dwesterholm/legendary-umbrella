import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBeteckning, type BeteckningDeps } from "@/lib/stockholm/beteckning";
import { loadAddressMap } from "@/lib/stockholm/bygglov-cache";
import { CITY_HOST, makeCityClient } from "@/lib/stockholm/bygglov-client";
import { makeFixtureFetch, type FixtureRoute } from "@/lib/stockholm/fixture-fetch";
import { blockHost, readHostGates } from "@/lib/stockholm/host-gate";
import {
  BUFFER_LADDER,
  MINKARTA_HOST,
  MINKARTA_MAX_CALLS_PER_ADDRESS,
  MINKARTA_USER_AGENT,
  cleanSearchAddress,
  makeMinKartaResolver,
  parseFastighetsinfo,
  parseSearchHits,
  pickBestHit,
  pointInParcel,
  resolveViaMinKarta,
  type MinKartaFetch,
  type Polygon,
} from "@/lib/stockholm/minkarta";

const FIXTURES = join(__dirname, "__fixtures__");
const json = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, `minkarta-${name}.fixture.json`), "utf8"));

/** The point of Bondegatan 59 in the search fixture. */
const EAST = 675916.8;
const NORTH = 6579070.5;

const ID_OLJAN_29 = "909a6a41-e7b3-90ec-e040-ed8f66444c3f";
const ID_OLJAN_17 = "909a6a41-e7a7-90ec-e040-ed8f66444c3f";
const ID_SODERMALM_8_57 = "909a6a47-02df-90ec-e040-ed8f66444c3f";

/** A fake clock: sleep(ms) advances it, so no test waits in real time. */
function fakeClock(startIso = "2026-10-20T12:00:00.000Z") {
  let t = Date.parse(startIso);
  return {
    now: () => new Date(t),
    sleep: async (ms: number) => {
      t += ms;
    },
    ms: () => t,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "minkarta-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const JSON_TYPE = "application/json";
const SEARCH_PATH = "/api/searchservice/searchinput";
const BUFFER_PATH = "/api/positionsinformation/positionsinformation/registerenhetermedbuffer/v1";
const INFO_PATH = "/api/searchservice/fastighetsinfo/v1";
const NOTHING = '{"fastigheter":[],"registerenheter":[],"transactionId":"x"}';

const searchRoute: FixtureRoute = {
  path: SEARCH_PATH,
  queryKey: "searchtext",
  queryValue: "Bondegatan 59",
  file: "minkarta-search-bondegatan-59.fixture.json",
  contentType: JSON_TYPE,
};
const bufferRoute = (buffer: number, source: { file?: string; body?: string }): FixtureRoute => ({
  path: BUFFER_PATH,
  queryKey: "buffer",
  queryValue: String(buffer),
  contentType: JSON_TYPE,
  ...source,
});
const infoRoute = (id: string, source: { file?: string; body?: string }): FixtureRoute => ({
  path: INFO_PATH,
  queryKey: "objektidentitet",
  queryValue: id,
  contentType: JSON_TYPE,
  ...source,
});

/** The scripted Bondegatan 59 session: buffer 0 and 5 empty, buffer 10 gives the four candidates. */
const bondegatanRoutes: FixtureRoute[] = [
  searchRoute,
  bufferRoute(0, { body: NOTHING }),
  bufferRoute(5, { body: NOTHING }),
  bufferRoute(10, { file: "minkarta-registerenheter-bondegatan-59-b10.fixture.json" }),
  infoRoute(ID_OLJAN_29, { file: "minkarta-fastighetsinfo-oljan-29.fixture.json" }),
  infoRoute(ID_SODERMALM_8_57, { file: "minkarta-fastighetsinfo-sodermalm-8-57-street-land.fixture.json" }),
  // the other two candidates have no saved answer: an empty boundary
  infoRoute(ID_OLJAN_17, { body: '{"beteckningtext":"Stockholm Oljan 17","enhetsutbredning":[]}' }),
  infoRoute("909a6a47-d632-90ec-e040-ed8f66444c3f", { body: '{"beteckningtext":"Stockholm Södermalm 10:35","enhetsutbredning":[]}' }),
];

function setup(routes: readonly FixtureRoute[]) {
  const clock = fakeClock();
  const inner = makeFixtureFetch(FIXTURES, routes);
  const starts: number[] = [];
  const fetchImpl = Object.assign(
    async (url: string, init?: RequestInit) => {
      starts.push(clock.ms());
      return inner(url, init);
    },
    { requests: inner.requests },
  );
  const logs: string[] = [];
  const gatesPath = join(dir, "host-gates.json");
  const resolver = makeMinKartaResolver({
    fetchImpl: fetchImpl as MinKartaFetch,
    sleep: clock.sleep,
    now: clock.now,
    log: (l) => logs.push(l),
    gatesPath,
    dataDir: dir,
    transactionId: () => "0123456789abcdef0123456789abcdef",
  });
  return { clock, fetchImpl, starts, logs, gatesPath, resolver };
}

describe("cleanSearchAddress", () => {
  it("closes an entrance letter and strips a flat number and a floor", () => {
    expect(cleanSearchAddress("Torsgatan 48 A")).toBe("Torsgatan 48A");
    expect(cleanSearchAddress("Bondegatan 59 lgh 1201 3 tr")).toBe("Bondegatan 59");
  });
});

describe("pickBestHit: Stockholm only, the same address only, no fallback", () => {
  const hits = parseSearchHits(json("search-bondegatan-59"));

  it("reads the five hits of the saved search", () => {
    expect(hits).toHaveLength(5);
  });

  it("picks the 'Stockholm | Södermalm' hit and nothing else", () => {
    const hit = pickBestHit(hits, "Bondegatan 59");
    expect(hit).toMatchObject({ subtext: "Stockholm | Södermalm", east: EAST, north: NORTH });
  });

  it("gives null when the only equal hit is in Umeå", () => {
    const onlyUmea = hits.filter((h) => h.subtext !== "Stockholm | Södermalm" && h.subtext !== "Bollnäs | Arbrå");
    expect(onlyUmea.some((h) => h.subtext === "Umeå")).toBe(true);
    expect(pickBestHit(onlyUmea, "Bondegatan 59")).toBeNull();
  });

  it("never falls back to the first hit for an address that has no equal hit", () => {
    expect(pickBestHit(hits, "Bondegatan 5")).toBeNull();
    expect(pickBestHit(hits, "Bondegatan 60")).toBeNull();
  });

  it("compares with the entrance letter closed up and ignoring case", () => {
    const lettered = [{ headertext: "Torsgatan 48A", subtext: "Stockholm | Vasastaden", east: 1, north: 2 }];
    expect(pickBestHit(lettered, "Torsgatan 48 A")).not.toBeNull();
    expect(pickBestHit(lettered, "TORSGATAN 48A")).not.toBeNull();
  });
});

describe("pointInParcel: outer ring in, holes out, any piece of a multi-part parcel", () => {
  const oljan = parseFastighetsinfo(json("fastighetsinfo-oljan-29"));
  const streetLand = parseFastighetsinfo(json("fastighetsinfo-sodermalm-8-57-street-land"));

  it("Oljan 29 (one simple ring) contains the Bondegatan 59 point", () => {
    expect(oljan.beteckningtext).toBe("Stockholm Oljan 29");
    expect(oljan.polygons).toHaveLength(1);
    expect(pointInParcel(EAST, NORTH, oljan.polygons)).toBe(true);
  });

  it("Södermalm 8:57 (one outer ring, 15 holes) does not contain it", () => {
    expect(streetLand.polygons).toHaveLength(1);
    expect(streetLand.polygons[0]).toHaveLength(16);
    expect(pointInParcel(EAST, NORTH, streetLand.polygons)).toBe(false);
  });

  it("a point inside one of the 15 holes (a building standing on the street land) is not contained", () => {
    const [outer, ...holes] = streetLand.polygons[0];
    const hole = holes[0];
    const east = hole.reduce((sum, p) => sum + p[0], 0) / hole.length;
    const north = hole.reduce((sum, p) => sum + p[1], 0) / hole.length;
    // inside the outer ring alone, so the hole is the only thing that keeps the point out
    expect(pointInParcel(east, north, [[outer]])).toBe(true);
    expect(pointInParcel(east, north, streetLand.polygons)).toBe(false);
  });

  it("a point far away is outside both", () => {
    expect(pointInParcel(EAST + 5000, NORTH, oljan.polygons)).toBe(false);
    expect(pointInParcel(EAST + 5000, NORTH, streetLand.polygons)).toBe(false);
  });

  it("any polygon of a multi-part parcel counts, and a hole punches the point out", () => {
    const square = (x: number, y: number, size: number) =>
      [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]] as const;
    const twoPieces: Polygon[] = [[square(0, 0, 10)], [square(100, 100, 10)]];
    expect(pointInParcel(105, 105, twoPieces)).toBe(true);
    expect(pointInParcel(50, 50, twoPieces)).toBe(false);
    const withHole: Polygon[] = [[square(0, 0, 10), square(4, 4, 2)]];
    expect(pointInParcel(5, 5, withHole)).toBe(false);
    expect(pointInParcel(1, 1, withHole)).toBe(true);
  });

  it("reads a flat coordinate list as well as a list of pairs", () => {
    const flat = parseFastighetsinfo({
      beteckningtext: "Stockholm Flat 1",
      enhetsutbredning: [{ yta: [{ coordinates: [[0, 0, 10, 0, 10, 10, 0, 10, 0, 0]] }] }],
    });
    expect(pointInParcel(5, 5, flat.polygons)).toBe(true);
  });
});

describe("resolveViaMinKarta: Bondegatan 59 from saved answers", () => {
  it("walks search, buffer 0, 5, 10 and finds Oljan 29 on the fifth and last call", async () => {
    const s = setup(bondegatanRoutes);
    const result = await s.resolver("Bondegatan 59");

    expect(result).toMatchObject({ status: "resolved", beteckning: "Oljan 29", calls: 5 });
    const urls = s.fetchImpl.requests.map((r) => new URL(r.url));
    expect(urls.map((u) => u.pathname)).toEqual([SEARCH_PATH, BUFFER_PATH, BUFFER_PATH, BUFFER_PATH, INFO_PATH]);
    expect(urls.slice(1, 4).map((u) => u.searchParams.get("buffer"))).toEqual(BUFFER_LADDER.map(String));
    expect(urls[4].searchParams.get("objektidentitet")).toBe(ID_OLJAN_29);
    expect(s.fetchImpl.requests).toHaveLength(MINKARTA_MAX_CALLS_PER_ADDRESS);
  });

  it("builds the search and buffer URLs from the fixed host, the saved point and the transaction id", async () => {
    const s = setup(bondegatanRoutes);
    await s.resolver("Bondegatan 59 lgh 1201");
    expect(s.fetchImpl.requests[0].url).toBe("https://minkarta.lantmateriet.se/api/searchservice/searchinput?searchtext=Bondegatan%2059");
    expect(s.fetchImpl.requests[1].url).toBe(
      `https://minkarta.lantmateriet.se${BUFFER_PATH}?east=675916.8&north=6579070.5&buffer=0&transactionId=0123456789abcdef0123456789abcdef`,
    );
    for (const request of s.fetchImpl.requests) expect(new URL(request.url).host).toBe(MINKARTA_HOST);
  });

  it("sends the honest User-Agent, the Referer and Accept, no cookie, redirect error", async () => {
    const s = setup(bondegatanRoutes);
    await s.resolver("Bondegatan 59");
    expect(MINKARTA_USER_AGENT).toContain("bostadai-bygglov/1.0");
    expect(MINKARTA_USER_AGENT).not.toMatch(/mozilla|chrome|safari|applewebkit|gecko/i);
    for (const request of s.fetchImpl.requests) {
      expect(request.method).toBe("GET");
      expect(request.headers["user-agent"]).toBe(MINKARTA_USER_AGENT);
      expect(request.headers.referer).toBe("https://minkarta.lantmateriet.se/");
      expect(request.headers.accept).toBe("application/json");
      expect(Object.keys(request.headers).some((k) => k.toLowerCase() === "cookie")).toBe(false);
      expect(request.redirect).toBe("error");
    }
  });

  it("starts every request at least 3000 ms after the previous one, across addresses too", async () => {
    const s = setup(bondegatanRoutes);
    await s.resolver("Bondegatan 59");
    await s.resolver("Bondegatan 59");
    expect(s.starts).toHaveLength(10);
    for (let i = 1; i < s.starts.length; i += 1) expect(s.starts[i] - s.starts[i - 1]).toBeGreaterThanOrEqual(3000);
  });

  it("spends at most 5 calls: when the budget ends before a containing parcel, the answer is ambiguous", async () => {
    const ID_OTHER = "909a6a41-0000-90ec-e040-ed8f66444c3f";
    const manyCandidates = JSON.stringify({
      registerenheter: [
        { objectText: "STOCKHOLM OLJAN 17", objectId: ID_OLJAN_17, registerenhetstyp: "fastighet" },
        { objectText: "STOCKHOLM OLJAN 18", objectId: ID_OTHER, registerenhetstyp: "fastighet" },
        { objectText: "STOCKHOLM OLJAN 29", objectId: ID_OLJAN_29, registerenhetstyp: "fastighet" },
      ],
    });
    const s = setup([
      searchRoute,
      bufferRoute(0, { body: NOTHING }),
      bufferRoute(5, { body: NOTHING }),
      bufferRoute(10, { body: manyCandidates }),
      infoRoute(ID_OLJAN_17, { body: '{"beteckningtext":"Stockholm Oljan 17","enhetsutbredning":[]}' }),
      infoRoute(ID_OLJAN_29, { file: "minkarta-fastighetsinfo-oljan-29.fixture.json" }),
    ]);
    const result = await s.resolver("Bondegatan 59");
    expect(result.status).toBe("ambiguous");
    expect(result.beteckning).toBeNull();
    expect(s.fetchImpl.requests).toHaveLength(5);
  });

  it("a single candidate at buffer 0 is the answer after two calls, in the city's capitalisation", async () => {
    const s = setup([
      searchRoute,
      bufferRoute(0, { body: JSON.stringify({ registerenheter: [{ objectText: "STOCKHOLM ORMEN MINDRE 2", objectId: ID_OLJAN_29 }] }) }),
    ]);
    const result = await s.resolver("Bondegatan 59");
    expect(result).toMatchObject({ status: "resolved", beteckning: "Ormen Mindre 2", calls: 2 });
  });

  describe("WR-09: a single candidate from a widened buffer still has to contain the address point", () => {
    const oneAt10 = (id: string, text: string) =>
      bufferRoute(10, { body: JSON.stringify({ registerenheter: [{ objectText: text, objectId: id }] }) });

    it("resolves when the boundary contains the point (five calls: search, three buffers, one boundary)", async () => {
      const s = setup([
        searchRoute,
        bufferRoute(0, { body: NOTHING }),
        bufferRoute(5, { body: NOTHING }),
        oneAt10(ID_OLJAN_29, "STOCKHOLM OLJAN 29"),
        infoRoute(ID_OLJAN_29, { file: "minkarta-fastighetsinfo-oljan-29.fixture.json" }),
      ]);
      expect(await s.resolver("Bondegatan 59")).toMatchObject({ status: "resolved", beteckning: "Oljan 29", calls: 5 });
    });

    it("is ambiguous when the one candidate is a neighbour whose boundary does not contain the point", async () => {
      const s = setup([
        searchRoute,
        bufferRoute(0, { body: NOTHING }),
        bufferRoute(5, { body: NOTHING }),
        oneAt10(ID_OLJAN_17, "STOCKHOLM OLJAN 17"),
        infoRoute(ID_OLJAN_17, { body: '{"beteckningtext":"Stockholm Oljan 17","enhetsutbredning":[]}' }),
      ]);
      expect(await s.resolver("Bondegatan 59")).toMatchObject({ status: "ambiguous", beteckning: null });
    });

    it("is ambiguous when the one candidate has no usable object id (nothing to test it with)", async () => {
      const s = setup([
        searchRoute,
        bufferRoute(0, { body: NOTHING }),
        bufferRoute(5, { body: JSON.stringify({ registerenheter: [{ objectText: "STOCKHOLM OLJAN 17" }] }) }),
      ]);
      const result = await s.resolver("Bondegatan 59");
      expect(result).toMatchObject({ status: "ambiguous", beteckning: null });
      expect(result.calls).toBe(3);
    });
  });

  it("a plot in another kommun is never mapped to a Stockholm designation", async () => {
    const s = setup([
      searchRoute,
      bufferRoute(0, { body: JSON.stringify({ registerenheter: [{ objectText: "SOLNA OLJAN 29", objectId: ID_OLJAN_29 }] }) }),
      bufferRoute(5, { body: NOTHING }),
      bufferRoute(10, { body: NOTHING }),
    ]);
    const result = await s.resolver("Bondegatan 59");
    expect(result).toMatchObject({ status: "no_candidates", beteckning: null });
  });

  it("an address with no equal Stockholm hit stops after the search with no_candidates", async () => {
    const s = setup([{ ...searchRoute, queryValue: "Bondegatan 60" }]);
    const result = await s.resolver("Bondegatan 60");
    expect(result).toMatchObject({ status: "no_candidates", calls: 1 });
    expect(s.fetchImpl.requests).toHaveLength(1);
  });

  it("empty buffers all the way down give no_candidates after four calls", async () => {
    const s = setup([searchRoute, bufferRoute(0, { body: NOTHING }), bufferRoute(5, { body: NOTHING }), bufferRoute(10, { body: NOTHING })]);
    const result = await s.resolver("Bondegatan 59");
    expect(result).toMatchObject({ status: "no_candidates", calls: 4 });
  });
});

describe("refusals and failures", () => {
  it("a 403 blocks minkarta.lantmateriet.se only, ends the lookup as fetch_failed and the city stays open", async () => {
    const s = setup([{ path: SEARCH_PATH, status: 403, contentType: JSON_TYPE, body: "{}" }]);
    const result = await s.resolver("Bondegatan 59");

    expect(result).toMatchObject({ status: "fetch_failed", beteckning: null, reason: "http-403" });
    expect(s.fetchImpl.requests).toHaveLength(1);
    const gates = readHostGates(s.gatesPath);
    expect(Object.keys(gates)).toEqual([MINKARTA_HOST]);
    expect(gates[MINKARTA_HOST].reason).toBe("http-403");

    // the city client sharing the same block file is not affected
    const cityFetch = makeFixtureFetch(FIXTURES, [
      { path: "/Byggochplantjansten/CaseSearch/AddressSearch", file: "address-search-folkungagatan-61.fixture.html" },
    ]);
    const city = makeCityClient({ fetchImpl: cityFetch, sleep: s.clock.sleep, now: s.clock.now, log: () => undefined, gatesPath: s.gatesPath, dataDir: dir });
    expect(await city.addressSearch("Folkungagatan 61")).toHaveLength(1);
    expect(CITY_HOST in readHostGates(s.gatesPath)).toBe(false);
  });

  it("while the host is blocked no request is made, and a second address gets fetch_failed at once", async () => {
    const s = setup([{ path: SEARCH_PATH, status: 429, contentType: JSON_TYPE, body: "{}" }]);
    await s.resolver("Bondegatan 59");
    const before = s.fetchImpl.requests.length;
    const again = await s.resolver("Bondegatan 59");
    expect(again).toMatchObject({ status: "fetch_failed", reason: "pausad", calls: 0 });
    expect(s.fetchImpl.requests).toHaveLength(before);
  });

  it("a host entry with disabled true makes the lookup fetch_failed without any request", async () => {
    const s = setup(bondegatanRoutes);
    blockHost(s.gatesPath, MINKARTA_HOST, "ua-refused", s.clock.now(), { dir, disabled: true });
    await s.clock.sleep(400 * 86_400_000);
    const result = await s.resolver("Bondegatan 59");
    expect(result).toMatchObject({ status: "fetch_failed", reason: "pausad", calls: 0 });
    expect(s.fetchImpl.requests).toHaveLength(0);
  });

  it("an answer that is not JSON is a refusal: blocked, fetch_failed", async () => {
    const s = setup([{ path: SEARCH_PATH, body: "<html>Just a moment</html>" }]);
    const result = await s.resolver("Bondegatan 59");
    expect(result).toMatchObject({ status: "fetch_failed", reason: "fel-innehallstyp" });
    expect(readHostGates(s.gatesPath)[MINKARTA_HOST]?.reason).toBe("fel-innehallstyp");
  });

  it("WR-01: a refused redirect blocks minkarta.lantmateriet.se for 24 h and ends the lookup as fetch_failed", async () => {
    const redirected = Object.assign(new TypeError("fetch failed"), { cause: new Error("unexpected redirect") });
    const s = setup([{ path: SEARCH_PATH, rejectWith: redirected }]);
    expect(await s.resolver("Bondegatan 59")).toMatchObject({ status: "fetch_failed", reason: "omdirigering" });
    expect(readHostGates(s.gatesPath)[MINKARTA_HOST]?.reason).toBe("omdirigering");
    expect(s.fetchImpl.requests).toHaveLength(1);
    expect(await s.resolver("Bondegatan 59")).toMatchObject({ status: "fetch_failed", reason: "pausad" });
    expect(s.fetchImpl.requests).toHaveLength(1);
  });

  it("a server error or a network failure is fetch_failed after ONE attempt and does not block", async () => {
    const server = setup([{ path: SEARCH_PATH, status: 500, contentType: JSON_TYPE, body: "{}" }]);
    expect(await server.resolver("Bondegatan 59")).toMatchObject({ status: "fetch_failed", reason: "http-500" });
    expect(server.fetchImpl.requests).toHaveLength(1);
    expect(readHostGates(server.gatesPath)).toEqual({});

    const network = setup([{ path: SEARCH_PATH, rejectWith: new TypeError("fetch failed") }]);
    expect(await network.resolver("Bondegatan 59")).toMatchObject({ status: "fetch_failed", reason: "natverksfel" });
    expect(network.fetchImpl.requests).toHaveLength(1);
    expect(readHostGates(network.gatesPath)).toEqual({});
  });

  it("WR-08: a body without a declared length is cut off at the cap while reading (storlek), not buffered whole", async () => {
    const clock = fakeClock();
    let pulled = 0;
    const chunk = new Uint8Array(512 * 1024).fill(32);
    const fetchImpl: MinKartaFetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1;
            if (pulled > 100) controller.close();
            else controller.enqueue(chunk);
          },
        }),
        { status: 200, headers: { "content-type": JSON_TYPE } },
      );
    const result = await resolveViaMinKarta("Bondegatan 59", {
      fetchImpl,
      now: clock.now,
      log: () => undefined,
      gatesPath: join(dir, "host-gates.json"),
      dataDir: dir,
      pace: async () => undefined,
    });
    expect(result).toMatchObject({ status: "fetch_failed", reason: "storlek" });
    expect(pulled).toBeLessThan(10);
  });

  it("WR-08: a body that breaks off while reading is fetch_failed natverksfel, never a thrown error, and does not block", async () => {
    const clock = fakeClock();
    const fetchImpl: MinKartaFetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
            controller.error(new TypeError("terminated"));
          },
        }),
        { status: 200, headers: { "content-type": JSON_TYPE } },
      );
    const gatesPath = join(dir, "host-gates.json");
    const result = await resolveViaMinKarta("Bondegatan 59", {
      fetchImpl,
      now: clock.now,
      log: () => undefined,
      gatesPath,
      dataDir: dir,
      pace: async () => undefined,
    });
    expect(result).toMatchObject({ status: "fetch_failed", reason: "natverksfel" });
    expect(readHostGates(gatesPath)).toEqual({});
  });

  it("a failure in the middle of the ladder is fetch_failed, not a guess from what came before", async () => {
    const s = setup([searchRoute, bufferRoute(0, { body: "this is not json" })]);
    // the fixture default content type is JSON for bufferRoute, so the body fails to parse
    const result = await s.resolver("Bondegatan 59");
    expect(result).toMatchObject({ status: "fetch_failed", reason: "ogiltig-json" });
  });

  it("logs host, path, status and size only: never the query", async () => {
    const s = setup(bondegatanRoutes);
    await s.resolver("Bondegatan 59");
    const text = s.logs.join("\n");
    expect(text).toContain(MINKARTA_HOST);
    expect(text).not.toContain("searchtext");
    expect(text).not.toContain("east=");
    expect(text).not.toContain("transactionId");
    for (const log of s.logs) expect(log.startsWith("[stockholm] ")).toBe(true);
  });

  it("resolveViaMinKarta alone needs the pacer from the caller", async () => {
    const clock = fakeClock();
    const inner = makeFixtureFetch(FIXTURES, [{ ...searchRoute, queryValue: "Bondegatan 60" }]);
    let paced = 0;
    const result = await resolveViaMinKarta("Bondegatan 60", {
      fetchImpl: inner as MinKartaFetch,
      now: clock.now,
      log: () => undefined,
      gatesPath: join(dir, "host-gates.json"),
      dataDir: dir,
      pace: async () => {
        paced += 1;
      },
    });
    expect(result.status).toBe("no_candidates");
    expect(paced).toBe(1);
  });
});

describe("rung (c) inside resolveBeteckning", () => {
  /** A city client that knows no address, so the ladder reaches rung (c). */
  const emptyCity = (calls: string[]) => ({
    async addressSearch(address: string) {
      calls.push(`addressSearch:${address}`);
      return [];
    },
    async caseList(beteckning: string) {
      calls.push(`caseList:${beteckning}`);
      return { cases: [], otherCases: [], headingCount: 0, termsLinks: [], addresses: [] };
    },
  });

  function ladder(routes: readonly FixtureRoute[]) {
    const s = setup(routes);
    const cityCalls: string[] = [];
    const deps: BeteckningDeps = { client: emptyCity(cityCalls), minkarta: s.resolver, cacheDir: dir, now: s.clock.now, log: (l) => s.logs.push(l) };
    return { ...s, cityCalls, deps };
  }

  it("Bondegatan 59 is found on rung c as Oljan 29, remembered, and not asked again", async () => {
    const s = ladder(bondegatanRoutes);
    const first = await resolveBeteckning({ address: "Bondegatan 59", brfName: null, text: null }, s.deps);
    expect(first).toMatchObject({ beteckning: "Oljan 29", rung: "c", status: "resolved", fromCache: false });
    expect(s.cityCalls).toEqual(["addressSearch:Bondegatan 59"]);

    const saved = loadAddressMap({ dir });
    expect(saved.ok && saved.map["bondegatan 59"]).toMatchObject({ beteckning: "Oljan 29", rung: "c", status: "resolved" });

    const requests = s.fetchImpl.requests.length;
    const second = await resolveBeteckning({ address: "Bondegatan 59", brfName: null, text: null }, s.deps);
    expect(second).toMatchObject({ beteckning: "Oljan 29", rung: "c", fromCache: true });
    expect(s.fetchImpl.requests).toHaveLength(requests);
    expect(s.cityCalls).toHaveLength(1);
  });

  it("an ambiguous Min Karta answer is stored as ambiguous for 30 days", async () => {
    const ID_OTHER = "909a6a41-0000-90ec-e040-ed8f66444c3f";
    const s = ladder([
      searchRoute,
      bufferRoute(0, { body: NOTHING }),
      bufferRoute(5, { body: NOTHING }),
      bufferRoute(10, {
        body: JSON.stringify({
          registerenheter: [
            { objectText: "STOCKHOLM OLJAN 17", objectId: ID_OLJAN_17 },
            { objectText: "STOCKHOLM OLJAN 29", objectId: ID_OTHER },
          ],
        }),
      }),
      infoRoute(ID_OLJAN_17, { body: '{"beteckningtext":"Stockholm Oljan 17","enhetsutbredning":[]}' }),
    ]);
    const result = await resolveBeteckning({ address: "Bondegatan 59", brfName: null, text: null }, s.deps);
    expect(result).toMatchObject({ beteckning: null, rung: null, status: "ambiguous" });
    const saved = loadAddressMap({ dir });
    expect(saved.ok && saved.map["bondegatan 59"]).toMatchObject({ beteckning: null, status: "ambiguous" });
  });

  it("a sole street-land candidate is refused as inte en byggnad", async () => {
    const s = ladder([
      searchRoute,
      bufferRoute(0, { body: JSON.stringify({ registerenheter: [{ objectText: "STOCKHOLM SÖDERMALM 8:57", objectId: ID_SODERMALM_8_57 }] }) }),
    ]);
    const result = await resolveBeteckning({ address: "Bondegatan 59", brfName: null, text: null }, s.deps);
    expect(result).toMatchObject({ beteckning: null, status: "no_candidates" });
    expect(result.notes.join(" ")).toContain("inte en byggnad");
  });

  it("a Min Karta refusal makes rung c unavailable: the address is okänd and nothing is stored", async () => {
    const s = ladder([{ path: SEARCH_PATH, status: 403, contentType: JSON_TYPE, body: "{}" }]);
    const result = await resolveBeteckning({ address: "Bondegatan 59", brfName: null, text: null }, s.deps);
    expect(result).toMatchObject({ beteckning: null, rung: null, status: "fetch_failed" });
    expect(result.notes.join(" ")).toContain("Min Karta");
    expect(loadAddressMap({ dir })).toEqual({ ok: false, error: "saknas" });
    expect(Object.keys(readHostGates(s.gatesPath))).toEqual([MINKARTA_HOST]);
  });

  it("without a resolver the ladder ends at rung b", async () => {
    const s = ladder(bondegatanRoutes);
    const result = await resolveBeteckning({ address: "Bondegatan 59", brfName: null, text: null }, { ...s.deps, minkarta: null });
    expect(result).toMatchObject({ beteckning: null, status: "no_candidates" });
    expect(s.fetchImpl.requests).toHaveLength(0);
  });
});
