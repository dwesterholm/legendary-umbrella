import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSweep, refreshCaseListIfStale, saveSweep } from "@/lib/stockholm/bygglov-cache";
import { CITY_HOST, CITY_LIMITS, CITY_USER_AGENT, CityStop, makeCityClient } from "@/lib/stockholm/bygglov-client";
import { makeFixtureFetch } from "@/lib/stockholm/fixture-fetch";

const FIXTURES = join(__dirname, "__fixtures__");

/** A fake clock: sleep(ms) advances it, so no test waits in real time. */
function fakeClock(startIso = "2026-10-20T12:00:00.000Z") {
  let t = Date.parse(startIso);
  return {
    now: () => new Date(t),
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    ms: () => t,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bygglov-client-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const LIST_ROUTE = { path: "/byggochplantjansten/arendeochhandlingar", queryKey: "RealEstateName", file: "list-droskhasten-8.fixture.html" };

describe("Droskhästen 8: one gated GET from a fake server, parsed, classified and cached (tracer)", () => {
  it("makes exactly one request, saves the case list and returns 53 stored build cases", async () => {
    const clock = fakeClock();
    const fetchImpl = makeFixtureFetch(FIXTURES, [LIST_ROUTE]);
    const logs: string[] = [];
    const client = makeCityClient({ fetchImpl, sleep: clock.sleep, now: clock.now, log: (l) => logs.push(l), gatesPath: join(dir, "host-gates.json"), dataDir: dir });

    const result = await refreshCaseListIfStale("Droskhästen 8", { dir, now: clock.now, client });

    expect(fetchImpl.requests).toHaveLength(1);
    expect(result.source).toBe("city");
    expect(result.cases).toHaveLength(53);
    expect(result.termsLinks).toEqual([]);

    const request = fetchImpl.requests[0];
    expect(request.url).toBe(
      "https://etjanster.stockholm.se/byggochplantjansten/arendeochhandlingar?ExtendedAddress=false&RealEstateName=Droskh%C3%A4sten%208",
    );
    expect(request.method).toBe("GET");
    expect(request.headers["user-agent"]).toBe(CITY_USER_AGENT);
    expect(request.headers.accept).toBe("text/html");
    expect(Object.keys(request.headers).some((k) => k.toLowerCase() === "cookie")).toBe(false);
    expect(request.redirect).toBe("error");
    expect(new URL(request.url).host).toBe(CITY_HOST);
    expect(CITY_LIMITS.maxBytes).toBe(5 * 1024 * 1024);
  });

  it("answers a second ask within 30 days from the cache with zero requests and the same 53 cases", async () => {
    const clock = fakeClock();
    const fetchImpl = makeFixtureFetch(FIXTURES, [LIST_ROUTE]);
    const client = makeCityClient({ fetchImpl, sleep: clock.sleep, now: clock.now, log: () => undefined, gatesPath: join(dir, "host-gates.json"), dataDir: dir });

    const first = await refreshCaseListIfStale("Droskhästen 8", { dir, now: clock.now, client });
    clock.advance(10 * 86_400_000);
    const second = await refreshCaseListIfStale("Droskhästen 8", { dir, now: clock.now, client });

    expect(fetchImpl.requests).toHaveLength(1);
    expect(second.source).toBe("cache");
    expect(second.cases).toHaveLength(53);
    expect(second.cases).toEqual(first.cases);
  });

  it("saves tags, digits and dates only: no Description, Handler or Documents key in the file", async () => {
    const clock = fakeClock();
    const fetchImpl = makeFixtureFetch(FIXTURES, [LIST_ROUTE]);
    const client = makeCityClient({ fetchImpl, sleep: clock.sleep, now: clock.now, log: () => undefined, gatesPath: join(dir, "host-gates.json"), dataDir: dir });
    await refreshCaseListIfStale("Droskhästen 8", { dir, now: clock.now, client });

    const text = readFileSync(join(dir, "cases", "droskhasten-8.json"), "utf8");
    expect(text).not.toMatch(/"(Description|Handler|Documents)"/);
    const file = JSON.parse(text) as { cases: unknown[]; beteckning: string; rulesVersion: number };
    expect(file.beteckning).toBe("Droskhästen 8");
    expect(file.cases).toHaveLength(53);
  });

  it("starts two back-to-back case-list calls at least 3000 ms apart on the fake clock", async () => {
    const clock = fakeClock();
    const starts: number[] = [];
    const inner = makeFixtureFetch(FIXTURES, [LIST_ROUTE]);
    const fetchImpl = Object.assign(
      async (url: string, init?: RequestInit) => {
        starts.push(clock.ms());
        return inner(url, init);
      },
      { requests: inner.requests },
    );
    const client = makeCityClient({ fetchImpl, sleep: clock.sleep, now: clock.now, log: () => undefined, gatesPath: join(dir, "host-gates.json"), dataDir: dir });

    await client.caseList("Droskhästen 8");
    await client.caseList("Droskhästen 8");
    await client.caseList("Droskhästen 8");

    expect(starts).toHaveLength(3);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(3000);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(3000);
  });
});

// ---------------------------------------------------------------------------
// Task 2: saying no is final
// ---------------------------------------------------------------------------

const SEARCH_PATH = "/byggochplantjansten/arendeochhandlingar";
const NOTHING_TO_LEAK = "SECRET-BODY-TEXT-0451";

function setup(routes: Parameters<typeof makeFixtureFetch>[1], extra: { budget?: number } = {}) {
  const clock = fakeClock();
  const fetchImpl = makeFixtureFetch(FIXTURES, routes);
  const logs: string[] = [];
  const gatesPath = join(dir, "host-gates.json");
  const client = makeCityClient({
    fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
    log: (l) => logs.push(l),
    gatesPath,
    dataDir: dir,
    ...extra,
  });
  const gates = () => JSON.parse(readFileSync(gatesPath, "utf8")) as Record<string, { blockedUntil: string; reason: string }>;
  const gatesExist = () => existsSync(gatesPath);
  return { clock, fetchImpl, logs, client, gates, gatesExist, gatesPath };
}

const stopOf = async (promise: Promise<unknown>): Promise<CityStop> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CityStop) return error;
    throw error;
  }
  throw new Error("expected a CityStop");
};

describe("a refusal ends the run and keeps us away for 24 hours", () => {
  for (const [status, label] of [
    [403, "http-403"],
    [429, "http-429"],
  ] as const) {
    it(`HTTP ${status}: one fetch, a 24 h block with the label ${label}, a CityStop, no retry`, async () => {
      const s = setup([{ path: SEARCH_PATH, status, body: NOTHING_TO_LEAK }]);
      const stop = await stopOf(s.client.caseList("Droskhästen 8"));
      expect(stop.label).toBe(label);
      expect(stop.blocked).toBe(true);
      expect(s.fetchImpl.requests).toHaveLength(1);
      expect(s.gates()).toEqual({
        [CITY_HOST]: { blockedUntil: new Date(s.clock.ms() + 24 * 3_600_000).toISOString(), reason: label },
      });
    });
  }

  it("a 200 page that is a BankID login form blocks with 'inloggning'", async () => {
    const s = setup([{ path: SEARCH_PATH, body: '<html><body><form action="/inloggning"><h1>Logga in med BankID</h1></form></body></html>' }]);
    const stop = await stopOf(s.client.caseList("Droskhästen 8"));
    expect(stop.label).toBe("inloggning");
    expect(s.gates()[CITY_HOST].reason).toBe("inloggning");
    expect(s.fetchImpl.requests).toHaveLength(1);
  });

  it("a 200 terms page blocks with 'villkor'", async () => {
    const s = setup([{ path: SEARCH_PATH, body: "<html><body><main><p>Godkänn Användarvillkor för att fortsätta</p></main></body></html>" }]);
    const stop = await stopOf(s.client.caseList("Droskhästen 8"));
    expect(stop.label).toBe("villkor");
    expect(s.gates()[CITY_HOST].reason).toBe("villkor");
  });

  it("a 200 page with a changed shape blocks with 'andrad-sida'", async () => {
    const s = setup([{ path: SEARCH_PATH, body: "<html><body><p>Underhåll pågår</p></body></html>" }]);
    const stop = await stopOf(s.client.caseList("Droskhästen 8"));
    expect(stop.label).toBe("andrad-sida");
    expect(s.gates()[CITY_HOST].reason).toBe("andrad-sida");
  });

  it("a beteckning page whose heading count differs from its rows is a changed page and blocks", async () => {
    const wrong = readFileSync(join(FIXTURES, "list-droskhasten-8.fixture.html"), "utf8").replace("av 53)", "av 60)");
    const s = setup([{ path: SEARCH_PATH, body: wrong }]);
    const stop = await stopOf(s.client.caseList("Droskhästen 8"));
    expect(stop.label).toBe("andrad-sida");
    expect(s.gates()[CITY_HOST].reason).toBe("andrad-sida");
  });

  it("a 200 answer that is not HTML blocks with 'fel-innehallstyp'", async () => {
    const s = setup([{ path: SEARCH_PATH, contentType: "application/json", body: "{}" }]);
    const stop = await stopOf(s.client.caseList("Droskhästen 8"));
    expect(stop.label).toBe("fel-innehallstyp");
    expect(s.gates()[CITY_HOST].reason).toBe("fel-innehallstyp");
  });

  it("an answer with no content-type at all blocks as well", async () => {
    const s = setup([{ path: SEARCH_PATH, contentType: null, body: "<html></html>" }]);
    const stop = await stopOf(s.client.caseList("Droskhästen 8"));
    expect(stop.label).toBe("fel-innehallstyp");
  });
});

describe("failures that are not a refusal do not block the host", () => {
  const BIG = "x".repeat(CITY_LIMITS.maxBytes + 1);

  it("a body above the cap makes extendedSearch return storlek (the caller splits the window) and does not block", async () => {
    const s = setup([{ path: SEARCH_PATH, body: BIG }]);
    const result = await s.client.extendedSearch({ district: "Södermalm", description: "stambyte", from: "1985-01-01" });
    expect(result).toEqual({ ok: false, reason: "storlek" });
    expect(s.gatesExist()).toBe(false);
  });

  it("a declared length above the cap is refused before reading, also without blocking", async () => {
    const s = setup([{ path: SEARCH_PATH, body: "<html></html>", headers: { "content-length": String(CITY_LIMITS.maxBytes + 1) } }]);
    const result = await s.client.extendedSearch({ district: "Södermalm", description: "stambyte", from: "1985-01-01" });
    expect(result).toEqual({ ok: false, reason: "storlek" });
    expect(s.gatesExist()).toBe(false);
  });

  it("a body above the cap makes caseList throw storlek without blocking", async () => {
    const s = setup([{ path: SEARCH_PATH, body: BIG }]);
    const stop = await stopOf(s.client.caseList("Droskhästen 8"));
    expect(stop.label).toBe("storlek");
    expect(stop.blocked).toBe(false);
    expect(s.gatesExist()).toBe(false);
  });

  it("a fetch that rejects throws natverksfel, with no retry and no block", async () => {
    const s = setup([{ path: SEARCH_PATH, rejectWith: new TypeError("fetch failed") }]);
    const stop = await stopOf(s.client.caseList("Droskhästen 8"));
    expect(stop.label).toBe("natverksfel");
    expect(stop.blocked).toBe(false);
    expect(s.fetchImpl.requests).toHaveLength(1);
    expect(s.gatesExist()).toBe(false);
  });

  it("an HTTP 500 stops the run with http-500, once, without blocking", async () => {
    const s = setup([{ path: SEARCH_PATH, status: 500, body: "boom" }]);
    const stop = await stopOf(s.client.caseList("Droskhästen 8"));
    expect(stop.label).toBe("http-500");
    expect(stop.blocked).toBe(false);
    expect(s.fetchImpl.requests).toHaveLength(1);
    expect(s.gatesExist()).toBe(false);
  });

  it("an extended search whose heading count differs from its rows returns antal for the caller to split, without blocking", async () => {
    const wrong = readFileSync(join(FIXTURES, "ext-sodermalm-balkong-2025-06.fixture.html"), "utf8").replace("(97 tr&#228;ffar)", "(500 tr&#228;ffar)");
    const s = setup([{ path: SEARCH_PATH, body: wrong }]);
    const result = await s.client.extendedSearch({ district: "Södermalm", description: "balkong", from: "2025-06-01", to: "2025-06-30" });
    expect(result).toEqual({ ok: false, reason: "antal" });
    expect(s.gatesExist()).toBe(false);
  });
});

describe("while the host is blocked, no request is made", () => {
  it("throws pausad before calling fetch and says until when; after the block has passed the call goes through", async () => {
    const s = setup([{ path: SEARCH_PATH, queryKey: "RealEstateName", file: "list-droskhasten-8.fixture.html" }]);
    const until = new Date(s.clock.ms() + 10 * 3_600_000).toISOString();
    writeFileSync(s.gatesPath, JSON.stringify({ [CITY_HOST]: { blockedUntil: until, reason: "http-403" } }), "utf8");

    const stop = await stopOf(s.client.caseList("Droskhästen 8"));
    expect(stop.label).toBe("pausad");
    expect(stop.blocked).toBe(true);
    expect(s.fetchImpl.requests).toHaveLength(0);
    expect(s.logs).toContain(`[stockholm] Stadens e-tjänst pausad till ${until} (http-403)`);

    s.clock.advance(10 * 3_600_000 + 1);
    const ok = await s.client.caseList("Droskhästen 8");
    expect(ok.cases).toHaveLength(53);
    expect(s.fetchImpl.requests).toHaveLength(1);
  });

  it("every public call checks the block first", async () => {
    const s = setup([]);
    writeFileSync(
      s.gatesPath,
      JSON.stringify({ [CITY_HOST]: { blockedUntil: new Date(s.clock.ms() + 3_600_000).toISOString(), reason: "inloggning" } }),
      "utf8",
    );
    const calls = [
      () => s.client.caseList("Droskhästen 8"),
      () => s.client.caseDetail("1208902", false),
      () => s.client.addressSearch("Folkungagatan 61"),
      () => s.client.extendedSearch({ district: "Södermalm", description: "stambyte", from: "1985-01-01" }),
      () => s.client.robots(),
    ];
    for (const call of calls) expect((await stopOf(call())).label).toBe("pausad");
    expect(s.fetchImpl.requests).toHaveLength(0);
  });

  it("a host marked disabled stays paused with no end date", async () => {
    const s = setup([]);
    writeFileSync(
      s.gatesPath,
      JSON.stringify({ [CITY_HOST]: { blockedUntil: new Date(s.clock.ms() - 1000).toISOString(), reason: "user-agent", disabled: true } }),
      "utf8",
    );
    expect((await stopOf(s.client.caseList("Droskhästen 8"))).label).toBe("pausad");
    expect(s.fetchImpl.requests).toHaveLength(0);
  });
});

describe("the other calls build their URLs from digits and encoded values only", () => {
  it("extendedSearch uses District, Description, CaseStartDateFrom, CaseStartDateTo (never the SearchParameters. prefix) and percent-encodes", async () => {
    const s = setup([{ path: SEARCH_PATH, queryKey: "District", file: "ext-sodermalm-stambyte-1985.fixture.html" }]);
    const result = await s.client.extendedSearch({ district: "Södermalm", description: "stambyte", from: "1985-01-01" });
    expect(s.fetchImpl.requests[0].url).toBe(
      `https://${CITY_HOST}${SEARCH_PATH}?District=S%C3%B6dermalm&Description=stambyte&CaseStartDateFrom=1985-01-01`,
    );
    if (!result.ok) throw new Error(`unexpected ${result.reason}`);
    expect(result.cases).toHaveLength(380);
    expect(result.headingCount).toBe(380);

    // The real 380-row sweep saves as a sweep file and loads back unchanged.
    const query = { district: "Södermalm", description: "stambyte", from: "1985-01-01", to: null };
    saveSweep(query, { cases: result.cases, headingCount: result.headingCount }, { dir, now: s.clock.now() });
    const loaded = loadSweep(query, { dir });
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.entry.cases).toEqual(result.cases);
    expect(Object.keys(result.cases[0]).sort()).toEqual(
      ["addresses", "archived", "beteckning", "kinds", "primary", "rec", "startDate", "tillsyn"].sort(),
    );

    const t = setup([{ path: SEARCH_PATH, queryKey: "District", file: "ext-sodermalm-balkong-2025-06.fixture.html" }]);
    await t.client.extendedSearch({ district: "Södermalm", description: "balkong", from: "2025-06-01", to: "2025-06-30" });
    expect(t.fetchImpl.requests[0].url).toContain("&CaseStartDateFrom=2025-06-01&CaseStartDateTo=2025-06-30");
  });

  it("no recorded request URL ever contains SearchParameters", async () => {
    const s = setup([
      { path: SEARCH_PATH, queryKey: "District", file: "ext-sodermalm-stambyte-1985.fixture.html" },
      { path: SEARCH_PATH, queryKey: "RealEstateName", file: "list-droskhasten-8.fixture.html" },
    ]);
    await s.client.extendedSearch({ district: "Södermalm", description: "stambyte", from: "1985-01-01" });
    await s.client.caseList("Droskhästen 8");
    expect(s.fetchImpl.requests.length).toBeGreaterThan(0);
    for (const r of s.fetchImpl.requests) expect(r.url).not.toContain("SearchParameters");
  });

  it("extendedSearch refuses a date that is not YYYY-MM-DD before any request", async () => {
    const s = setup([]);
    await expect(s.client.extendedSearch({ district: "Södermalm", description: "stambyte", from: "1985-1-1" })).rejects.toThrow();
    await expect(s.client.extendedSearch({ district: "Södermalm", description: "stambyte", from: "1985-01-01", to: "x" })).rejects.toThrow();
    expect(s.fetchImpl.requests).toHaveLength(0);
  });

  it("caseDetail builds /Byggochplantjansten/arende/arende/<digits>?dataSource=Active, or Archived", async () => {
    const s = setup([{ path: "/Byggochplantjansten/arende/arende/1208902", file: "case-stambyte-2020-startbesked-slutbesked.fixture.html" }]);
    const detail = await s.client.caseDetail("1208902", false);
    expect(s.fetchImpl.requests[0].url).toBe(`https://${CITY_HOST}/Byggochplantjansten/arende/arende/1208902?dataSource=Active`);
    expect(detail.decisions.length).toBeGreaterThan(0);

    const t = setup([{ path: "/Byggochplantjansten/arende/arende/1208902", file: "case-stambyte-2006-archived.fixture.html" }]);
    await t.client.caseDetail("1208902", true);
    expect(t.fetchImpl.requests[0].url).toBe(`https://${CITY_HOST}/Byggochplantjansten/arende/arende/1208902?dataSource=Archived`);
  });

  it("a rec that is not digits throws before any request", async () => {
    const s = setup([]);
    for (const bad of ["12x", "", "../../etc", "1208902?x=1", "1".repeat(13), " 12"]) {
      await expect(s.client.caseDetail(bad, false), bad).rejects.toThrow(/rec/);
    }
    expect(s.fetchImpl.requests).toHaveLength(0);
  });

  it("a detail page with a login form blocks, like a list page does", async () => {
    const s = setup([{ path: "/Byggochplantjansten/arende/arende/1208902", body: '<html><body><form><h1>Logga in med BankID</h1></form></body></html>' }]);
    expect((await stopOf(s.client.caseDetail("1208902", false))).label).toBe("inloggning");
    expect(s.gates()[CITY_HOST].reason).toBe("inloggning");
  });

  it("addressSearch builds /Byggochplantjansten/CaseSearch/AddressSearch?addressSearchField=Folkungagatan%2061 and returns the options", async () => {
    const s = setup([{ path: "/Byggochplantjansten/CaseSearch/AddressSearch", queryKey: "addressSearchField", file: "address-search-folkungagatan-61.fixture.html" }]);
    const options = await s.client.addressSearch("Folkungagatan 61");
    expect(s.fetchImpl.requests[0].url).toBe(`https://${CITY_HOST}/Byggochplantjansten/CaseSearch/AddressSearch?addressSearchField=Folkungagatan%2061`);
    expect(options).toEqual([{ text: "Droskhästen 8, Folkungagatan 61", value: "Droskhästen 8" }]);
  });

  it("an address with no select list (unknown address) is an empty answer, not a block", async () => {
    const s = setup([{ path: "/Byggochplantjansten/CaseSearch/AddressSearch", body: "<div class='alert'>Adressen finns inte.</div>" }]);
    expect(await s.client.addressSearch("Finnsinte 1")).toEqual([]);
    expect(s.gatesExist()).toBe(false);
  });

  it("robots() GETs /robots.txt and returns status and text; a 404 is a normal answer, no block", async () => {
    const s = setup([{ path: "/robots.txt", status: 404, contentType: "text/plain", body: "Not found" }]);
    expect(await s.client.robots()).toEqual({ status: 404, text: "Not found" });
    expect(s.fetchImpl.requests[0].url).toBe(`https://${CITY_HOST}/robots.txt`);
    expect(s.gatesExist()).toBe(false);
  });

  it("robots() caps the text at 64 KB", async () => {
    const s = setup([{ path: "/robots.txt", contentType: "text/plain", body: "a".repeat(100_000) }]);
    const result = await s.client.robots();
    expect(result.status).toBe(200);
    expect(result.text.length).toBe(64 * 1024);
  });

  it("robots() answered with 403 blocks the host like any refusal", async () => {
    const s = setup([{ path: "/robots.txt", status: 403, body: "no" }]);
    expect((await stopOf(s.client.robots())).label).toBe("http-403");
    expect(s.gates()[CITY_HOST].reason).toBe("http-403");
  });
});

describe("a request budget", () => {
  it("with a budget of 2 the third call throws budget, makes no request and does not block the host", async () => {
    const s = setup([{ path: SEARCH_PATH, queryKey: "RealEstateName", file: "list-droskhasten-8.fixture.html" }], { budget: 2 });
    await s.client.caseList("Droskhästen 8");
    await s.client.caseList("Droskhästen 8");
    const stop = await stopOf(s.client.caseList("Droskhästen 8"));
    expect(stop.label).toBe("budget");
    expect(stop.blocked).toBe(false);
    expect(s.fetchImpl.requests).toHaveLength(2);
    expect(s.gatesExist()).toBe(false);
  });
});

describe("logs and cookies (V8)", () => {
  it("never sends a Cookie header and never logs a query, a body, a header or a cookie", async () => {
    const s = setup([
      { path: SEARCH_PATH, queryKey: "RealEstateName", file: "list-droskhasten-8.fixture.html", headers: { "set-cookie": "SMIDENTITY=abc123" } },
      { path: SEARCH_PATH, queryKey: "District", status: 403, body: NOTHING_TO_LEAK, headers: { "set-cookie": "SMIDENTITY=zzz999" } },
    ]);
    await s.client.caseList("Droskhästen 8");
    await stopOf(s.client.extendedSearch({ district: "Södermalm", description: "stambyte", from: "1985-01-01" }));
    await stopOf(s.client.caseList("Droskhästen 8"));

    expect(s.logs.length).toBeGreaterThan(0);
    for (const l of s.logs) {
      expect(l).toMatch(/^\[stockholm\] /);
      expect(l).not.toContain("?");
      expect(l).not.toContain(NOTHING_TO_LEAK);
      expect(l).not.toMatch(/SMIDENTITY|abc123|zzz999|cookie|User-Agent|RealEstateName|District=/i);
    }
    for (const r of s.fetchImpl.requests) {
      expect(Object.keys(r.headers).map((k) => k.toLowerCase())).not.toContain("cookie");
    }
  });
});
