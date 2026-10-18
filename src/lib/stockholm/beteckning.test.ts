import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAddressMap, loadCaseList } from "@/lib/stockholm/bygglov-cache";
import { CityStop, makeCityClient, type CaseListAnswer } from "@/lib/stockholm/bygglov-client";
import type { AddressOption } from "@/lib/stockholm/bygglov-parse";
import {
  matchAddressFragment,
  pickFromAddressFragment,
  resolveBeteckning,
  rungSummaryLine,
  type BeteckningDeps,
} from "@/lib/stockholm/beteckning";
import {
  beteckningFromText,
  beteckningGuessFromBrfName,
  cleanAddressForSearch,
  normaliseBeteckning,
} from "@/lib/stockholm/beteckning-text";
import { makeFixtureFetch, type FixtureRoute } from "@/lib/stockholm/fixture-fetch";

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
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "beteckning-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ADDRESS_PATH = "/Byggochplantjansten/CaseSearch/AddressSearch";
const folkungagatan: FixtureRoute = {
  path: ADDRESS_PATH,
  queryKey: "addressSearchField",
  queryValue: "Folkungagatan 61",
  file: "address-search-folkungagatan-61.fixture.html",
};

function setup(routes: readonly FixtureRoute[]) {
  const clock = fakeClock();
  const fetchImpl = makeFixtureFetch(FIXTURES, routes);
  const logs: string[] = [];
  const client = makeCityClient({
    fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
    log: (l) => logs.push(l),
    gatesPath: join(dir, "host-gates.json"),
    dataDir: dir,
  });
  const deps: BeteckningDeps = { client, cacheDir: dir, now: clock.now, log: (l) => logs.push(l) };
  return { clock, fetchImpl, logs, deps };
}

describe("CR-01: a damaged address-map entry never makes the map smaller", () => {
  it("keeps a 2-entry map with one damaged entry as 2 entries after the next lookup, and says why", async () => {
    const file = join(dir, "address-beteckning.json");
    const good = { beteckning: "Oljan 29", rung: "b", status: "resolved", at: "2026-10-01T00:00:00.000Z" };
    const text = JSON.stringify({ schemaVersion: 1, entries: { "oljan gatan 1": good, "torsgatan 48a": { ...good, status: "resolvd" } } });
    writeFileSync(file, text, "utf8");
    const s = setup([folkungagatan]);

    const result = await resolveBeteckning({ address: "Folkungagatan 61", brfName: null, text: null }, s.deps);
    expect(result).toMatchObject({ beteckning: "Droskhästen 8", status: "resolved" });
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(Object.keys((JSON.parse(readFileSync(file, "utf8")) as { entries: object }).entries)).toHaveLength(2);
    expect(s.logs.some((l) => l.includes("1 poster som inte går att läsa"))).toBe(true);
  });

  it("does not rewrite a file that is not JSON either", async () => {
    const file = join(dir, "address-beteckning.json");
    writeFileSync(file, "[1,", "utf8");
    const s = setup([folkungagatan]);
    await resolveBeteckning({ address: "Folkungagatan 61", brfName: null, text: null }, s.deps);
    expect(readFileSync(file, "utf8")).toBe("[1,");
  });
});

describe("Folkungagatan 61 -> Droskhästen 8 through the city's address search (tracer)", () => {
  it("resolves on rung b after exactly one request, remembers it, and the next ask makes none", async () => {
    const s = setup([folkungagatan]);

    const first = await resolveBeteckning({ address: "Folkungagatan 61", brfName: null, text: null }, s.deps);
    expect(first).toMatchObject({ beteckning: "Droskhästen 8", rung: "b", status: "resolved", fromCache: false });
    expect(s.fetchImpl.requests).toHaveLength(1);
    expect(s.fetchImpl.requests[0].url).toContain("addressSearchField=Folkungagatan%2061");

    const saved = loadAddressMap({ dir });
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      expect(saved.map["folkungagatan 61"]).toMatchObject({ beteckning: "Droskhästen 8", rung: "b", status: "resolved" });
    }

    const second = await resolveBeteckning({ address: "Folkungagatan  61", brfName: null, text: null }, s.deps);
    expect(second).toMatchObject({ beteckning: "Droskhästen 8", rung: "b", status: "resolved", fromCache: true });
    expect(s.fetchImpl.requests).toHaveLength(1);
  });

  it("prints the summary line for that one result", async () => {
    const s = setup([folkungagatan]);
    const result = await resolveBeteckning({ address: "Folkungagatan 61", brfName: null, text: null }, s.deps);
    expect(rungSummaryLine([result])).toBe("Fastighetsbeteckning: 1 av 1 hittade (a 0, a2 0, b 1, c 0), okänd 0");
  });

  it("saves only the designation, the rung, the status and a time in the address file", async () => {
    const s = setup([folkungagatan]);
    await resolveBeteckning({ address: "Folkungagatan 61", brfName: null, text: null }, s.deps);
    const file = JSON.parse(readFileSync(join(dir, "address-beteckning.json"), "utf8")) as {
      entries: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(file.entries["folkungagatan 61"]).sort()).toEqual(["at", "beteckning", "rung", "status"]);
  });
});

// ---------------------------------------------------------------------------
// Task 2: rungs (a) and (a2), the equal-address rule, street land, the negative cache
// ---------------------------------------------------------------------------

describe("rung (a): the broker text states the beteckning", () => {
  it("reads the designation after the word and drops a leading Stockholm", () => {
    expect(beteckningFromText("Bra läge. Fastighetsbeteckning: Stockholm Oljan 29. Avgift 4 100 kr.")).toBe("Oljan 29");
    expect(beteckningFromText("fastighetsbeteckning Ormen Mindre 2")).toBe("Ormen Mindre 2");
    expect(beteckningFromText("Fastighetsbeteckning – Södermalm 8:57 enligt köparen")).toBe("Södermalm 8:57");
    expect(beteckningFromText("Fastighetsbeteckning: STOCKHOLM OLJAN 29")).toBe("Oljan 29".toUpperCase());
  });

  it("gives null for a text without the word, or with the word and no designation", () => {
    expect(beteckningFromText("Fin trea på Södermalm, hiss finns.")).toBeNull();
    expect(beteckningFromText("Fastighetsbeteckning saknas i annonsen")).toBeNull();
    expect(beteckningFromText("Fastighetsbeteckning är Oljan 29")).toBeNull();
    expect(beteckningFromText("Fastighetsbeteckning: Stockholm 2012")).toBeNull();
    expect(beteckningFromText(null)).toBeNull();
    expect(beteckningFromText("")).toBeNull();
  });

  it("keeps only the designation, never the sentence", () => {
    const found = beteckningFromText("Hemligt telefonnummer 070-1234567. Fastighetsbeteckning: Oljan 29. Ring Anna.");
    expect(found).toBe("Oljan 29");
  });

  it("runs under 50 ms on 50 000 characters, also when the text is made to be slow", () => {
    const texts = [
      "Bostadsrätt med fin planlösning. ".repeat(1600),
      "fastighetsbeteckning ".repeat(2400),
      `Fastighetsbeteckning: ${"Aaaaaaaaaaaaaaaaaaaaaaaa ".repeat(2000)}`,
      "Fastighetsbeteckning    ".repeat(2200),
    ];
    for (const text of texts) {
      expect(text.length).toBeGreaterThanOrEqual(50_000);
      const started = performance.now();
      beteckningFromText(text);
      expect(performance.now() - started).toBeLessThan(50);
    }
  });

  it("normaliseBeteckning drops the kommun and collapses spaces", () => {
    expect(normaliseBeteckning("Stockholm Oljan 29")).toBe("Oljan 29");
    expect(normaliseBeteckning("  STOCKHOLM   SÖDERMALM  8:57 ")).toBe("SÖDERMALM 8:57");
    expect(normaliseBeteckning("Ormen   Mindre 2")).toBe("Ormen Mindre 2");
  });
});

describe("rung (a2): the BRF name read as a guess", () => {
  it("turns 'BRF <kvarter> <nr>' into '<kvarter> <nr>' and keeps the capitalisation", () => {
    expect(beteckningGuessFromBrfName("BRF Skalmejblåsaren 12")).toBe("Skalmejblåsaren 12");
    expect(beteckningGuessFromBrfName("BRF Ankaret 1")).toBe("Ankaret 1");
    expect(beteckningGuessFromBrfName("Bostadsrättsföreningen Oljan 18")).toBe("Oljan 18");
    expect(beteckningGuessFromBrfName("HSB BRF Oljan 18")).toBe("Oljan 18");
    expect(beteckningGuessFromBrfName("BRF Ormen Mindre 2")).toBe("Ormen Mindre 2");
  });

  it("gives null when there is no trailing number or the name is not a BRF name", () => {
    expect(beteckningGuessFromBrfName("HSB BRF Fredhäll i Stockholm")).toBeNull();
    expect(beteckningGuessFromBrfName("HSB BRF Kalkonen i Stockholm")).toBeNull();
    expect(beteckningGuessFromBrfName("Riksbyggen Oljan 18")).toBeNull();
    expect(beteckningGuessFromBrfName(null)).toBeNull();
    expect(beteckningGuessFromBrfName("BRF " + "Långt ".repeat(40) + "9")).toBeNull();
  });
});

describe("cleanAddressForSearch", () => {
  it("closes an entrance letter and strips a flat number and a floor", () => {
    expect(cleanAddressForSearch("Torsgatan 48 A")).toBe("Torsgatan 48A");
    expect(cleanAddressForSearch("Bondegatan 59 lgh 1201 3 tr")).toBe("Bondegatan 59");
    expect(cleanAddressForSearch("Ringvägen 151 lgh 1102")).toBe("Ringvägen 151");
    expect(cleanAddressForSearch("SIBYLLEGATAN 33  LGH 1501")).toBe("SIBYLLEGATAN 33");
    expect(cleanAddressForSearch("Hantverkargatan 5 C")).toBe("Hantverkargatan 5C");
    expect(cleanAddressForSearch("  Folkungagatan   61 ")).toBe("Folkungagatan 61");
  });
});

describe("the equal-address rule", () => {
  const hornsgatan: AddressOption[] = [
    { text: "Ormen Mindre 2, Hornsgatan 42B", value: "Ormen Mindre 2" },
    { text: "Ormen Mindre 2, Hornsgatan 42A", value: "Ormen Mindre 2" },
  ];

  it("resolves 'Hornsgatan 42' when both entrances share one designation", () => {
    expect(pickFromAddressFragment("Hornsgatan 42", hornsgatan)).toBe("Ormen Mindre 2");
  });

  it("'Hornsgatan 42A' matches only the 42A option", () => {
    const options = [...hornsgatan, { text: "Annat Kvarter 3, Hornsgatan 42C", value: "Annat Kvarter 3" }];
    expect(pickFromAddressFragment("Hornsgatan 42A", options)).toBe("Ormen Mindre 2");
    expect(pickFromAddressFragment("Hornsgatan 42C", options)).toBe("Annat Kvarter 3");
  });

  it("'Hornsgatan 4' is no match for a prefix match on 42A and 42B", () => {
    expect(pickFromAddressFragment("Hornsgatan 4", hornsgatan)).toBeNull();
    expect(matchAddressFragment("Hornsgatan 4", hornsgatan)).toEqual({ value: null, ambiguous: false });
  });

  it("two equal options with different designations are ambiguous", () => {
    const options = [
      { text: "Ormen Mindre 2, Hornsgatan 42A", value: "Ormen Mindre 2" },
      { text: "Ormen Större 3, Hornsgatan 42B", value: "Ormen Större 3" },
    ];
    expect(pickFromAddressFragment("Hornsgatan 42", options)).toBeNull();
    expect(matchAddressFragment("Hornsgatan 42", options)).toEqual({ value: null, ambiguous: true });
  });
});

/** A city client stand-in that answers from a script and counts its calls. */
function stubClient(script: {
  options?: AddressOption[];
  list?: Partial<CaseListAnswer>;
  addressStop?: boolean;
  listStop?: boolean;
}) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async addressSearch(address: string) {
        calls.push(`addressSearch:${address}`);
        if (script.addressStop) throw new CityStop("http-403", true);
        return script.options ?? [];
      },
      async caseList(beteckning: string) {
        calls.push(`caseList:${beteckning}`);
        if (script.listStop) throw new CityStop("http-403", true);
        return { cases: [], otherCases: [], headingCount: 0, termsLinks: [], addresses: [], ...script.list } satisfies CaseListAnswer;
      },
    },
  };
}

function stubDeps(client: ReturnType<typeof stubClient>["client"]) {
  const clock = fakeClock();
  const logs: string[] = [];
  const deps: BeteckningDeps = { client, cacheDir: dir, now: clock.now, log: (l) => logs.push(l) };
  return { clock, logs, deps };
}

describe("resolveBeteckning: the free rungs come first", () => {
  it("rung (a): a beteckning stated in the text is accepted without any request", async () => {
    const stub = stubClient({});
    const { deps } = stubDeps(stub.client);
    const result = await resolveBeteckning(
      { address: "Erstagatan 21", brfName: "BRF Oljan 18", text: "Fastighetsbeteckning: Stockholm Oljan 29. Fin lägenhet." },
      deps,
    );
    expect(result).toMatchObject({ beteckning: "Oljan 29", rung: "a", status: "resolved" });
    expect(stub.calls).toEqual([]);
  });

  it("a street-land designation in the text is refused as 'inte en byggnad' and the next rung runs", async () => {
    const stub = stubClient({ options: [{ text: "Oljan 29, Bondegatan 59", value: "Oljan 29" }] });
    const { deps } = stubDeps(stub.client);
    const result = await resolveBeteckning(
      { address: "Bondegatan 59", brfName: null, text: "Fastighetsbeteckning: Stockholm Södermalm 8:57" },
      deps,
    );
    expect(result).toMatchObject({ beteckning: "Oljan 29", rung: "b" });
    expect(result.notes.join(" ")).toContain("inte en byggnad");
  });

  it("street land answered by the city itself is also refused, and the address stays okänd", async () => {
    const stub = stubClient({ options: [{ text: "Södermalm 8:57, Bondegatan 59", value: "Södermalm 8:57" }] });
    const { deps } = stubDeps(stub.client);
    const result = await resolveBeteckning({ address: "Bondegatan 59", brfName: null, text: null }, deps);
    expect(result).toMatchObject({ beteckning: null, rung: null, status: "no_candidates" });
    expect(result.notes.join(" ")).toContain("inte en byggnad");
  });
});

describe("rung (a2): a BRF name is trusted only after the city confirms the street", () => {
  it("accepts the guess when a city row has the candidate's street and number, and hands the list back", async () => {
    const stub = stubClient({
      list: {
        addresses: ["Erstagatan 19", "Erstagatan 21"],
        cases: [{ rec: "1", diarie: "2020-1", startDate: "2020-01-01", kinds: ["annat"], primary: "annat", tillsyn: false, archived: false, detailRead: false, latest: null, startbeskedDate: null, slutbeskedDate: null, closedDate: null }] as never,
      },
    });
    const { deps } = stubDeps(stub.client);
    const result = await resolveBeteckning({ address: "Erstagatan 21", brfName: "BRF Oljan 18", text: null }, deps);

    expect(result).toMatchObject({ beteckning: "Oljan 18", rung: "a2", status: "resolved" });
    expect(result.list?.addresses).toContain("Erstagatan 21");
    expect(stub.calls).toEqual(["caseList:Oljan 18"]);
  });

  it("saves the confirmed list so a later case-list lookup makes no second request", async () => {
    const stub = stubClient({ list: { addresses: ["Erstagatan 21"] } });
    const { deps } = stubDeps(stub.client);
    await resolveBeteckning({ address: "Erstagatan 21", brfName: "BRF Oljan 18", text: null }, deps);
    const saved = loadCaseList("Oljan 18", { dir });
    expect(saved.ok).toBe(true);
  });

  it("an entrance letter and a combined 'A/B' address are matched on street and number", async () => {
    const stub = stubClient({ list: { addresses: ["Östgötagatan 33/Folkungagatan 61"] } });
    const { deps } = stubDeps(stub.client);
    const result = await resolveBeteckning({ address: "Folkungagatan 61 B", brfName: "BRF Droskhästen 8", text: null }, deps);
    expect(result).toMatchObject({ beteckning: "Droskhästen 8", rung: "a2" });
  });

  it("rejects the guess when the rows only have another number, and rung (b) runs next", async () => {
    const stub = stubClient({
      list: { addresses: ["Erstagatan 23"] },
      options: [{ text: "Verkligt Kvarter 4, Erstagatan 21", value: "Verkligt Kvarter 4" }],
    });
    const { deps } = stubDeps(stub.client);
    const result = await resolveBeteckning({ address: "Erstagatan 21", brfName: "BRF Oljan 18", text: null }, deps);

    expect(result).toMatchObject({ beteckning: "Verkligt Kvarter 4", rung: "b" });
    expect(result.list).toBeUndefined();
    expect(stub.calls).toEqual(["caseList:Oljan 18", "addressSearch:Erstagatan 21"]);
  });

  it("rejects a guess when the city lists nothing for it", async () => {
    const stub = stubClient({ list: { addresses: [] }, options: [] });
    const { deps } = stubDeps(stub.client);
    const result = await resolveBeteckning({ address: "Erstagatan 21", brfName: "BRF Oljan 18", text: null }, deps);
    expect(result).toMatchObject({ beteckning: null, status: "no_candidates" });
  });

  it("works against the real Droskhästen 8 page: Folkungagatan 61 is confirmed, Folkungagatan 63 is not", async () => {
    const listRoute: FixtureRoute = {
      path: "/byggochplantjansten/arendeochhandlingar",
      queryKey: "RealEstateName",
      queryValue: "Droskhästen 8",
      file: "list-droskhasten-8.fixture.html",
    };
    const unknownAddress: FixtureRoute = {
      path: ADDRESS_PATH,
      queryKey: "addressSearchField",
      queryValue: "Folkungagatan 63",
      body: "<div class=\"alert\">Adressen finns inte.</div>",
    };
    const s = setup([listRoute, unknownAddress]);
    const ok = await resolveBeteckning({ address: "Folkungagatan 61", brfName: "BRF Droskhästen 8", text: null }, s.deps);
    expect(ok).toMatchObject({ beteckning: "Droskhästen 8", rung: "a2" });
    expect(ok.list?.cases).toHaveLength(53);
    expect(s.fetchImpl.requests).toHaveLength(1);

    const no = await resolveBeteckning({ address: "Folkungagatan 63", brfName: "BRF Droskhästen 8", text: null }, s.deps);
    expect(no).toMatchObject({ beteckning: null, status: "no_candidates" });
    expect(s.fetchImpl.requests).toHaveLength(3);
  });
});

describe("resolveBeteckning: asking the city by the cleaned address", () => {
  it("asks 'Torsgatan 48 A' as 'Torsgatan 48A' and 'Ringvägen 151 lgh 1102' as 'Ringvägen 151'", async () => {
    const stub = stubClient({ options: [] });
    const { deps } = stubDeps(stub.client);
    await resolveBeteckning({ address: "Torsgatan 48 A", brfName: null, text: null }, deps);
    await resolveBeteckning({ address: "Ringvägen 151 lgh 1102", brfName: null, text: null }, deps);
    expect(stub.calls).toEqual(["addressSearch:Torsgatan 48A", "addressSearch:Ringvägen 151"]);
  });

  it("answers 'Hornsgatan 4' with null (no prefix match) and does not resolve an ambiguous pair", async () => {
    const hornsgatan: AddressOption[] = [
      { text: "Ormen Mindre 2, Hornsgatan 42B", value: "Ormen Mindre 2" },
      { text: "Ormen Mindre 2, Hornsgatan 42A", value: "Ormen Mindre 2" },
    ];
    const stub = stubClient({ options: hornsgatan });
    const { deps } = stubDeps(stub.client);
    const short = await resolveBeteckning({ address: "Hornsgatan 4", brfName: null, text: null }, deps);
    expect(short).toMatchObject({ beteckning: null, status: "no_candidates" });
    const full = await resolveBeteckning({ address: "Hornsgatan 42", brfName: null, text: null }, deps);
    expect(full).toMatchObject({ beteckning: "Ormen Mindre 2", rung: "b" });

    const two = stubClient({
      options: [
        { text: "Ormen Mindre 2, Hornsgatan 50A", value: "Ormen Mindre 2" },
        { text: "Ormen Större 3, Hornsgatan 50B", value: "Ormen Större 3" },
      ],
    });
    const second = stubDeps(two.client);
    const ambiguous = await resolveBeteckning({ address: "Hornsgatan 50", brfName: null, text: null }, second.deps);
    expect(ambiguous).toMatchObject({ beteckning: null, rung: null, status: "ambiguous" });
  });
});

describe("resolveBeteckning: the negative cache", () => {
  it("stores an empty answer as no_candidates and does not ask again for 30 days", async () => {
    const stub = stubClient({ options: [] });
    const { clock, deps } = stubDeps(stub.client);
    const first = await resolveBeteckning({ address: "Finnsinte 1", brfName: null, text: null }, deps);
    expect(first).toMatchObject({ beteckning: null, status: "no_candidates", fromCache: false });

    const saved = loadAddressMap({ dir });
    expect(saved.ok && saved.map["finnsinte 1"]).toMatchObject({ beteckning: null, rung: null, status: "no_candidates" });

    clock.advance(29 * 86_400_000);
    const again = await resolveBeteckning({ address: "Finnsinte 1", brfName: null, text: null }, deps);
    expect(again).toMatchObject({ beteckning: null, status: "no_candidates", fromCache: true });
    expect(stub.calls).toHaveLength(1);

    clock.advance(2 * 86_400_000);
    await resolveBeteckning({ address: "Finnsinte 1", brfName: null, text: null }, deps);
    expect(stub.calls).toHaveLength(2);
  });

  it("keeps a resolved answer for a year", async () => {
    const stub = stubClient({ options: [{ text: "Droskhästen 8, Folkungagatan 61", value: "Droskhästen 8" }] });
    const { clock, deps } = stubDeps(stub.client);
    await resolveBeteckning({ address: "Folkungagatan 61", brfName: null, text: null }, deps);
    clock.advance(364 * 86_400_000);
    const again = await resolveBeteckning({ address: "Folkungagatan 61", brfName: null, text: null }, deps);
    expect(again.fromCache).toBe(true);
    expect(stub.calls).toHaveLength(1);
    clock.advance(2 * 86_400_000);
    await resolveBeteckning({ address: "Folkungagatan 61", brfName: null, text: null }, deps);
    expect(stub.calls).toHaveLength(2);
  });

  it("a CityStop propagates and stores nothing", async () => {
    const stub = stubClient({ addressStop: true });
    const { deps } = stubDeps(stub.client);
    await expect(resolveBeteckning({ address: "Folkungagatan 61", brfName: null, text: null }, deps)).rejects.toBeInstanceOf(CityStop);
    expect(loadAddressMap({ dir })).toEqual({ ok: false, error: "saknas" });
  });

  it("a CityStop in the BRF-name rung propagates too", async () => {
    const stub = stubClient({ listStop: true });
    const { deps } = stubDeps(stub.client);
    await expect(resolveBeteckning({ address: "Erstagatan 21", brfName: "BRF Oljan 18", text: null }, deps)).rejects.toBeInstanceOf(CityStop);
    expect(loadAddressMap({ dir })).toEqual({ ok: false, error: "saknas" });
  });

  it("an address with nothing to ask is okänd and stores nothing", async () => {
    const stub = stubClient({});
    const { deps } = stubDeps(stub.client);
    const result = await resolveBeteckning({ address: "   ", brfName: null, text: null }, deps);
    expect(result).toMatchObject({ beteckning: null, status: "no_candidates" });
    expect(stub.calls).toEqual([]);
    expect(loadAddressMap({ dir })).toEqual({ ok: false, error: "saknas" });
  });
});

describe("rungSummaryLine", () => {
  it("counts each rung, the found total and the okända", () => {
    const line = rungSummaryLine([
      { beteckning: "A 1", rung: "a" },
      { beteckning: "B 2", rung: "a2" },
      { beteckning: "C 3", rung: "b" },
      { beteckning: "D 4", rung: "b" },
      { beteckning: "E 5", rung: "c" },
      { beteckning: null, rung: null },
      { beteckning: null, rung: null },
    ]);
    expect(line).toBe("Fastighetsbeteckning: 5 av 7 hittade (a 1, a2 1, b 2, c 1), okänd 2");
  });

  it("handles an empty list", () => {
    expect(rungSummaryLine([])).toBe("Fastighetsbeteckning: 0 av 0 hittade (a 0, a2 0, b 0, c 0), okänd 0");
  });
});
