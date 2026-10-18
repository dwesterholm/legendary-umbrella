// @vitest-environment node
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apifyClientMockFactory } from "@/lib/booli/__mocks__/apify-client";
import snapshotJson from "@/lib/discovery/__fixtures__/forsale-snapshot.fixture.json";
import type { DiscoveryCandidate } from "@/lib/discovery/candidate";
import { parseFitSnapshot } from "@/lib/discovery/fit-score";
import { candidateFactsSchema, emptyFacts, type CandidateFacts } from "@/lib/discovery/listing-facts";
import { enrichAllCandidates, type WatchEnrichDeps } from "@/lib/discovery/watch-enrich";
import { loadCaseList } from "@/lib/stockholm/bygglov-cache";
import { buildingFactsOf, type StoredCase } from "@/lib/stockholm/bygglov-classify";
import { CityStop, makeCityClient } from "@/lib/stockholm/bygglov-client";
import type { AddressOption, CaseDetail } from "@/lib/stockholm/bygglov-parse";
import {
  CITY_STAGE_DEADLINE_MS,
  CITY_STAGE_REQUEST_BUDGET,
  cityFactsFromCases,
  cityStageLine,
  runCityStage,
  type CityStageClient,
  type CityStageStats,
} from "@/lib/stockholm/city-stage";
import { makeFixtureFetch, type FixtureRoute } from "@/lib/stockholm/fixture-fetch";

vi.mock("apify-client", () => apifyClientMockFactory());

/**
 * city-stage.test.ts - the city's building facts on a candidate's facts record (Phase 14.6, plan 09).
 *
 * Task 1 (tracer): a broker text read in a fake enrichment and Folkungagatan 61's cached city record meet in ONE facts
 * record. The cache is the committed fixture `__fixtures__/city-cache/` (the address map and the case list of
 * Droskhästen 8, written by the real cache functions from the saved list page), so nothing here touches the network
 * or the real cache under .planning/calibration/data/.
 */

const AS_OF = "2026-10-13";
const CACHE = join(__dirname, "__fixtures__", "city-cache");
const base = parseFitSnapshot(snapshotJson).rows[0].candidate;

const candidate = (patch: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate => ({
  ...base,
  sourceListingUrl: "https://example.invalid/bostad/150148",
  address: "Folkungagatan 61",
  imageUrls: null,
  floor: null,
  constructionYear: null,
  orientation: null,
  balcony: null,
  vision: null,
  visionSkippedReason: null,
  ...patch,
});

/** A fake enrichment whose broker page says `description`; no network module is involved. */
function fakeDeps(description: string): WatchEnrichDeps {
  return {
    fetchListing: vi.fn(async () => ({
      imageUrls: [],
      floor: 5,
      constructionYear: 1912,
      balcony: true,
      amenities: [{ key: "elevator" }],
      rent: 2232,
      tenureForm: "Bostadsrätt",
      published: "2026-10-09 10:00:00",
      agencyListingUrl: "https://maklare.example/objekt/1",
    })) as unknown as WatchEnrichDeps["fetchListing"],
    fetchBrokerListingPage: vi.fn(async () => ({ renovationStatus: null, description, images: [] })) as unknown as WatchEnrichDeps["fetchBrokerListingPage"],
    fetchBrokerImageBytes: vi.fn(async () => []) as unknown as WatchEnrichDeps["fetchBrokerImageBytes"],
    fetchBrfFacts: vi.fn(async () => ({ loanSek: null, areaSqm: null, reportYear: null, debtPerSqm: null })) as unknown as WatchEnrichDeps["fetchBrfFacts"],
  };
}

const TEXT = "Stambyte planeras 2027. Areauppgift enligt föreningen. Fastighetsbeteckning: Stockholm Droskhästen 8.";

describe("tracer: a broker text and Folkungagatan 61's cached city record end up as one facts record", () => {
  it("the fake enrichment reads the text: planned 2027 from the maklartext, area from the forening, beteckning rung a, no sentence kept", async () => {
    const result = await enrichAllCandidates([candidate()], 1, { deadlineMs: 60_000, concurrency: 1, asOf: AS_OF, deps: fakeDeps(TEXT) });
    const facts = result.facts.get(0) as CandidateFacts;
    expect(facts.textStambyte).toEqual({ lastYear: null, plannedYear: 2027, ongoing: false, relining: false });
    expect(facts.plannedStambyteYear).toBe(2027);
    expect(facts.stambyteStatus).toBe("planerat");
    expect(facts.stambyteSource).toBe("maklartext");
    expect(facts.areaSource).toBe("forening");
    expect(facts.fastighetsbeteckning).toBe("Droskhästen 8");
    expect(facts.beteckningRung).toBe("a");
    // The city has not been asked yet: its keys are still "not read".
    expect(facts.cityStambyte).toBeNull();
    expect(facts.byggarenden).toBeNull();

    const stored = JSON.stringify({ facts: [...result.facts.values()], candidates: result.candidates });
    for (const piece of ["Stambyte planeras", "Areauppgift", "Stockholm Droskhästen", "planeras 2027."]) {
      expect(stored).not.toContain(piece);
    }
  });

  it("cache-only city stage over that row: 2006 from the city, 2027 from the text, status planerat, nothing requested", async () => {
    const enriched = await enrichAllCandidates([candidate()], 1, { deadlineMs: 60_000, concurrency: 1, asOf: AS_OF, deps: fakeDeps(TEXT) });
    const textFacts = enriched.facts.get(0) as CandidateFacts;

    const { facts, stats } = await runCityStage([{ address: "Folkungagatan 61", brfName: null, facts: textFacts }], {
      mode: "cache-only",
      asOf: AS_OF,
      cacheDir: CACHE,
    });
    const row = facts[0] as CandidateFacts;
    expect(row.cityStambyte).toEqual({ lastYear: 2006, basis: "ärendestart", ongoing: false, relining: false });
    expect(row.lastStambyteYear).toBe(2006);
    expect(row.plannedStambyteYear).toBe(2027);
    expect(row.stambyteStatus).toBe("planerat");
    expect(row.stambyteSource).toBe("maklartext");
    expect(row.balkongBeviljadEjByggd).toBe(false);
    expect(row.balkongInglasningAnsokt).toBe(false);
    expect(row.byggarenden?.slice(0, 2).map((c) => [c.kind, c.month])).toEqual([
      ["vind_inredning", "2023-10"],
      ["hiss", "2021-12"],
    ]);
    // The text's own readings survive the city merge (a later re-merge never loses a source).
    expect(row.textStambyte).toEqual({ lastYear: null, plannedYear: 2027, ongoing: false, relining: false });
    expect(row.areaSource).toBe("forening");
    expect(row.fastighetsbeteckning).toBe("Droskhästen 8");
    expect(row.beteckningRung).toBe("a");
    expect(stats).toMatchObject({ rows: 1, resolved: 1, listsRead: 1, requests: 0, detailsRead: 0, notReached: 0, stopped: null });
    expect(stats.byRung).toEqual({ a: 1, a2: 0, b: 0, c: 0 });
  });

  it("the same address with no text resolves through the cached address map (rung b) to the same city facts, status genomfort from bygglov_stockholm", async () => {
    const { facts, stats } = await runCityStage([{ address: "Folkungagatan 61", brfName: null, facts: emptyFacts() }], {
      mode: "cache-only",
      asOf: AS_OF,
      cacheDir: CACHE,
    });
    const row = facts[0] as CandidateFacts;
    expect(row.fastighetsbeteckning).toBe("Droskhästen 8");
    expect(row.beteckningRung).toBe("b");
    expect(row.lastStambyteYear).toBe(2006);
    expect(row.plannedStambyteYear).toBeNull();
    expect(row.stambyteStatus).toBe("genomfort");
    expect(row.stambyteSource).toBe("bygglov_stockholm");
    expect(stats.byRung).toEqual({ a: 0, a2: 0, b: 1, c: 0 });
  });

  it("a row with no facts yet (no detail read) still gets the city's facts, and the input row is not changed", async () => {
    const input = [{ address: "Folkungagatan 61", brfName: null, facts: null }];
    const { facts } = await runCityStage(input, { mode: "cache-only", asOf: AS_OF, cacheDir: CACHE });
    expect((facts[0] as CandidateFacts).lastStambyteYear).toBe(2006);
    expect(input[0].facts).toBeNull();
  });

  it("an address nobody cached stays exactly as it was, counts as no resolved row, and nothing throws", async () => {
    const own = emptyFacts();
    const { facts, stats } = await runCityStage([{ address: "Okänd gata 1", brfName: null, facts: own }], {
      mode: "cache-only",
      asOf: AS_OF,
      cacheDir: CACHE,
    });
    expect(facts[0]).toBe(own);
    expect(stats).toMatchObject({ rows: 1, resolved: 0, listsRead: 0, requests: 0 });
  });

  it("a missing cache directory is not an error in cache-only mode", async () => {
    const { facts, stats } = await runCityStage([{ address: "Folkungagatan 61", brfName: null, facts: null }], {
      mode: "cache-only",
      asOf: AS_OF,
      cacheDir: join(CACHE, "finns-inte"),
    });
    expect(facts[0]).toBeNull();
    expect(stats.resolved).toBe(0);
  });
});

describe("facts survive a round trip and an old snapshot", () => {
  it("every new key survives JSON and the schema unchanged", async () => {
    const enriched = await enrichAllCandidates([candidate()], 1, { deadlineMs: 60_000, concurrency: 1, asOf: AS_OF, deps: fakeDeps(TEXT) });
    const { facts } = await runCityStage([{ address: "Folkungagatan 61", brfName: null, facts: enriched.facts.get(0) as CandidateFacts }], {
      mode: "cache-only",
      asOf: AS_OF,
      cacheDir: CACHE,
    });
    const row = facts[0] as CandidateFacts;
    const back = candidateFactsSchema.parse(JSON.parse(JSON.stringify(row)));
    expect(back).toEqual(row);
    expect(row.byggarenden?.length).toBeGreaterThan(0);
    expect(row.textStambyte).not.toBeNull();
    expect(row.cityStambyte).not.toBeNull();
  });

  it("the stored facts of the 2026-10-13 snapshot parse with every new key null", () => {
    const stored = JSON.parse(readFileSync(join(__dirname, "..", "discovery", "__fixtures__", "forsale-snapshot-folkungagatan-61.fixture.json"), "utf8"));
    const facts = candidateFactsSchema.parse(stored.rows[0].facts);
    for (const key of NEW_KEYS) expect(facts[key], key).toBeNull();
  });
});

const NEW_KEYS = [
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
] as const satisfies readonly (keyof CandidateFacts)[];

describe("cityFactsFromCases", () => {
  const stored = JSON.parse(readFileSync(join(CACHE, "cases", "droskhasten-8.json"), "utf8")).cases as StoredCase[];

  it("its Byggärenden list is the same cases, in the same order, as buildingFactsOf().recent", () => {
    const facts = cityFactsFromCases(stored, AS_OF);
    const recent = buildingFactsOf(stored, AS_OF).recent;
    expect(facts.byggarenden.map((c) => [c.kind, c.month])).toEqual(recent.map((c) => [c.kind, c.month]));
  });

  it("a case whose page was not read is 'okant'; at most six are listed", () => {
    const facts = cityFactsFromCases(stored, AS_OF);
    expect(facts.byggarenden.length).toBeLessThanOrEqual(6);
    expect(facts.byggarenden.every((c) => c.decision === "okant")).toBe(true);
  });

  it("an empty case list is 'read and nothing of interest': an empty array, not null", () => {
    const facts = cityFactsFromCases([], AS_OF);
    expect(facts.byggarenden).toEqual([]);
    expect(facts.cityStambyte).toEqual({ lastYear: null, basis: null, ongoing: false, relining: false });
  });

  it("words a read case from its decisions and keeps only digits in the case number", () => {
    const granted: StoredCase = {
      rec: "9",
      diarie: "2025-00123 ÄÖ.",
      startDate: "2025-06-10",
      kinds: ["balkong_inglasning"],
      primary: "balkong_inglasning",
      tillsyn: false,
      archived: false,
      detailRead: true,
      latest: { type: "Startbesked", code: null, date: "2025-07-01" },
      startbeskedDate: "2025-07-01",
      slutbeskedDate: null,
      closedDate: null,
    };
    const [item] = cityFactsFromCases([granted], AS_OF).byggarenden;
    expect(item).toEqual({ kind: "balkong_inglasning", month: "2025-06", decision: "startbesked", slutbeskedMonth: null, diarie: "2025-00123" });
    const withFinal = cityFactsFromCases([{ ...granted, slutbeskedDate: "2025-12-02" }], AS_OF).byggarenden[0];
    expect(withFinal.decision).toBe("slutbesked");
    expect(withFinal.slutbeskedMonth).toBe("2025-12");
    const open = cityFactsFromCases([{ ...granted, latest: null, startbeskedDate: null }], AS_OF).byggarenden[0];
    expect(open.decision).toBe("ansokt");
  });
});

// ---------------------------------------------------------------------------
// Task 2: the live stage
// ---------------------------------------------------------------------------

const FIXTURES = join(__dirname, "__fixtures__");
const ADDRESS_ROUTE = "/Byggochplantjansten/CaseSearch/AddressSearch";
const LIST_ROUTE = "/byggochplantjansten/arendeochhandlingar";

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

/** The 2020 detail page (rec 1208902) with its record number swapped, so any case of the saved list can be "opened". */
const DETAIL_TEMPLATE = readFileSync(join(FIXTURES, "case-stambyte-2020-startbesked-slutbesked.fixture.html"), "utf8");
const detailPage = (rec: string): string => DETAIL_TEMPLATE.replaceAll("1208902", rec);

const fixtureRoutes = (): FixtureRoute[] => [
  { path: ADDRESS_ROUTE, queryKey: "addressSearchField", queryValue: "Folkungagatan 61", file: "address-search-folkungagatan-61.fixture.html" },
  { path: ADDRESS_ROUTE, queryKey: "addressSearchField", queryValue: "Hornsgatan 42", file: "address-search-hornsgatan-42.fixture.html" },
  // Any beteckning gets the Droskhästen 8 page; the client keeps only the exact matches, so "Ormen Mindre 2" gets none.
  { path: LIST_ROUTE, queryKey: "RealEstateName", file: "list-droskhasten-8.fixture.html" },
  { path: "/Byggochplantjansten/arende/arende/1266358", body: detailPage("1266358") },
  { path: "/Byggochplantjansten/arende/arende/1230634", body: detailPage("1230634") },
];

let cacheDir: string;
let workDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "city-stage-cache-"));
  workDir = mkdtempSync(join(tmpdir(), "city-stage-work-"));
});
afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

/** The real city client over saved pages. Every request it makes is recorded in `fetchImpl.requests`. */
function fixtureClient(routes: FixtureRoute[] = fixtureRoutes()) {
  const clock = fakeClock();
  const fetchImpl = makeFixtureFetch(FIXTURES, routes);
  const client = makeCityClient({
    fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
    log: () => undefined,
    gatesPath: join(workDir, "host-gates.json"),
    dataDir: workDir,
  });
  return { clock, fetchImpl, client };
}

const pathsOf = (fetchImpl: ReturnType<typeof makeFixtureFetch>) => fetchImpl.requests.map((r) => new URL(r.url).pathname.toLowerCase());
const countOf = (fetchImpl: ReturnType<typeof makeFixtureFetch>, path: string) => pathsOf(fetchImpl).filter((p) => p === path.toLowerCase()).length;

const row = (address: string, brfName: string | null = null, facts: CandidateFacts | null = emptyFacts()) => ({ address, brfName, facts });
const textRow = (address: string, beteckning: string) => row(address, null, { ...emptyFacts(), fastighetsbeteckning: beteckning, beteckningRung: "a" });

describe("live mode: rungs, one list per building, details only where they matter", () => {
  it("one address search, one list fetch and two detail fetches serve three rows of the same building", async () => {
    const { clock, fetchImpl, client } = fixtureClient();
    const rows = [row("Folkungagatan 61"), textRow("Östgötagatan 33", "Droskhästen 8"), row("Folkungagatan 61")];

    const { facts, stats } = await runCityStage(rows, { mode: "live", asOf: AS_OF, cacheDir, client, now: clock.now });

    expect(countOf(fetchImpl, ADDRESS_ROUTE)).toBe(1);
    expect(countOf(fetchImpl, LIST_ROUTE)).toBe(1);
    // Of the 12 cases of interest only the two that started within five years of the run date are opened.
    expect(pathsOf(fetchImpl).filter((p) => p.includes("/arende/arende/")).sort()).toEqual([
      "/byggochplantjansten/arende/arende/1230634",
      "/byggochplantjansten/arende/arende/1266358",
    ]);
    expect(fetchImpl.requests).toHaveLength(4);
    expect(stats).toMatchObject({ rows: 3, resolved: 3, listsRead: 1, detailsRead: 2, requests: 4, notReached: 0, stopped: null });
    expect(stats.byRung).toEqual({ a: 1, a2: 0, b: 2, c: 0 });

    // The detail pages changed the words: the newest case now has its final inspection.
    const first = facts[0] as CandidateFacts;
    expect(first.byggarenden?.slice(0, 2).map((c) => [c.kind, c.month, c.decision, c.slutbeskedMonth])).toEqual([
      ["vind_inredning", "2023-10", "slutbesked", "2023-03"],
      ["hiss", "2021-12", "slutbesked", "2023-03"],
    ]);
    expect(first.lastStambyteYear).toBe(2006);
    expect(first.stambyteStatus).toBe("genomfort");
    expect(first.stambyteSource).toBe("bygglov_stockholm");
    expect(first.beteckningRung).toBe("b");
    // Rows two and three share the building: same facts for the text row (rung kept) and for the repeated address.
    expect((facts[1] as CandidateFacts).byggarenden).toEqual(first.byggarenden);
    expect((facts[1] as CandidateFacts).beteckningRung).toBe("a");
    expect((facts[2] as CandidateFacts).byggarenden).toEqual(first.byggarenden);

    // The detail results were saved, so the next run needs no detail page.
    const saved = loadCaseList("Droskhästen 8", { dir: cacheDir });
    expect(saved.ok && saved.entry.cases.filter((c) => c.detailRead).map((c) => c.rec).sort()).toEqual(["1230634", "1266358"]);
  });

  it("a BRF name confirmed by its own list costs one list fetch, which the stage then reuses", async () => {
    const { clock, fetchImpl, client } = fixtureClient();
    const { facts, stats } = await runCityStage([row("Folkungagatan 61", "BRF Droskhästen 8")], {
      mode: "live",
      asOf: AS_OF,
      cacheDir,
      client,
      now: clock.now,
    });
    expect(countOf(fetchImpl, ADDRESS_ROUTE)).toBe(0);
    expect(countOf(fetchImpl, LIST_ROUTE)).toBe(1);
    expect(stats.byRung).toEqual({ a: 0, a2: 1, b: 0, c: 0 });
    expect(stats).toMatchObject({ resolved: 1, listsRead: 1, detailsRead: 2, requests: 3 });
    expect((facts[0] as CandidateFacts).beteckningRung).toBe("a2");
  });

  it("a building with no cases at all is 'read, nothing of interest' (an empty list), not 'not read'", async () => {
    const { clock, client } = fixtureClient();
    const { facts, stats } = await runCityStage([row("Hornsgatan 42")], { mode: "live", asOf: AS_OF, cacheDir, client, now: clock.now });
    const out = facts[0] as CandidateFacts;
    expect(out.fastighetsbeteckning).toBe("Ormen Mindre 2");
    expect(out.byggarenden).toEqual([]);
    expect(out.lastStambyteYear).toBeNull();
    expect(out.stambyteStatus).toBeNull();
    expect(stats).toMatchObject({ resolved: 1, listsRead: 1, detailsRead: 0, requests: 2 });
  });

  it("is cache-first: a cached address and list cost no request, only the two missing detail pages are fetched; the next run costs none", async () => {
    cpSync(CACHE, cacheDir, { recursive: true });
    const { clock, fetchImpl, client } = fixtureClient();
    const opts = { mode: "live", asOf: AS_OF, cacheDir, client, now: clock.now } as const;

    const first = await runCityStage([row("Folkungagatan 61")], opts);
    expect(countOf(fetchImpl, ADDRESS_ROUTE)).toBe(0);
    expect(countOf(fetchImpl, LIST_ROUTE)).toBe(0);
    expect(first.stats).toMatchObject({ requests: 2, detailsRead: 2, listsRead: 1 });

    const second = await runCityStage([row("Folkungagatan 61")], opts);
    expect(fetchImpl.requests).toHaveLength(2);
    expect(second.stats).toMatchObject({ requests: 0, detailsRead: 0, listsRead: 1 });
    expect(second.facts[0]).toEqual(first.facts[0]);
    // Reading details did not make the list look newer: it keeps the date it was fetched.
    const saved = loadCaseList("Droskhästen 8", { dir: cacheDir });
    expect(saved.ok && saved.entry.fetchedAt).toBe("2026-10-18T17:30:03.000Z");
  });
});

/** A scripted client that records every call, for the cases a saved page cannot show. */
function scriptedClient(script: Partial<CityStageClient> = {}) {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const track = async <T,>(label: string, work: () => Promise<T>): Promise<T> => {
    calls.push(label);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await Promise.resolve();
      return await work();
    } finally {
      inFlight -= 1;
    }
  };
  const client: CityStageClient = {
    addressSearch: (address) =>
      track(`addressSearch ${address}`, async () => (script.addressSearch ? script.addressSearch(address) : ([{ text: `Testen 1, ${address}`, value: "Testen 1" }] as AddressOption[]))),
    caseList: (beteckning) =>
      track(`caseList ${beteckning}`, async () =>
        script.caseList ? script.caseList(beteckning) : { cases: [], otherCases: [], headingCount: 0, termsLinks: [], addresses: [] },
      ),
    caseDetail: (rec, archived) => track(`caseDetail ${rec}`, async () => (script.caseDetail ? script.caseDetail(rec, archived) : emptyDetail(rec))),
  };
  return { client, calls, maxInFlight: () => maxInFlight };
}

const emptyDetail = (rec: string): CaseDetail => ({ rec, diarie: "", startDate: null, closedDate: null, estates: [], decisions: [] });

const hissCase = (rec: string, startDate: string): StoredCase => ({
  rec,
  diarie: `2025-${rec}`,
  startDate,
  kinds: ["hiss"],
  primary: "hiss",
  tillsyn: false,
  archived: false,
  detailRead: false,
  latest: null,
  startbeskedDate: null,
  slutbeskedDate: null,
  closedDate: null,
});

describe("live mode: limits and a clean stop", () => {
  it("opens at most three detail pages per building, the newest first", async () => {
    const cases = ["1", "2", "3", "4", "5"].map((n) => hissCase(n.padStart(3, "0"), `2025-0${n}-10`));
    const { client, calls } = scriptedClient({
      caseList: async () => ({ cases, otherCases: [], headingCount: 5, termsLinks: [], addresses: [] }),
    });
    const { stats } = await runCityStage([row("Testgatan 1")], { mode: "live", asOf: AS_OF, cacheDir, client, now: fakeClock().now });
    expect(calls.filter((c) => c.startsWith("caseDetail"))).toEqual(["caseDetail 005", "caseDetail 004", "caseDetail 003"]);
    expect(stats.detailsRead).toBe(3);
  });

  it("WR-11: 7:3 and 73 are two buildings in one run: the second does not receive the first one's cases", async () => {
    const { client, calls } = scriptedClient({
      caseList: async (beteckning) => ({
        cases: beteckning === "Tegelbruket 7:3" ? [hissCase("001", "2025-01-10")] : [],
        otherCases: [],
        headingCount: 0,
        termsLinks: [],
        addresses: [],
      }),
    });
    const { facts } = await runCityStage([textRow("Testgatan 1", "Tegelbruket 7:3"), textRow("Testgatan 2", "Tegelbruket 73")], {
      mode: "live",
      asOf: AS_OF,
      cacheDir,
      client,
      now: fakeClock().now,
    });
    expect(calls.filter((c) => c.startsWith("caseList")).sort()).toEqual(["caseList Tegelbruket 73", "caseList Tegelbruket 7:3"]);
    expect((facts[0] as CandidateFacts).byggarenden?.map((c) => c.kind)).toEqual(["hiss"]);
    expect((facts[1] as CandidateFacts).byggarenden).toEqual([]);
  });

  it("a case that is old, not interesting, or an enforcement case never gets a detail page", async () => {
    const old = hissCase("010", "2019-01-10");
    const notInteresting: StoredCase = { ...hissCase("011", "2025-03-10"), kinds: ["fasad"], primary: "fasad" };
    const enforcement: StoredCase = { ...hissCase("012", "2025-03-11"), tillsyn: true };
    const { client, calls } = scriptedClient({
      caseList: async () => ({ cases: [old, notInteresting, enforcement], otherCases: [], headingCount: 3, termsLinks: [], addresses: [] }),
    });
    await runCityStage([row("Testgatan 1")], { mode: "live", asOf: AS_OF, cacheDir, client, now: fakeClock().now });
    expect(calls.some((c) => c.startsWith("caseDetail"))).toBe(false);
  });

  it("a request budget of 2 ends network use: the row keeps what its list gave, the next row is untouched and counted in notReached", async () => {
    const { clock, fetchImpl, client } = fixtureClient();
    const second = row("Hornsgatan 42");
    const { facts, stats } = await runCityStage([row("Folkungagatan 61"), second], {
      mode: "live",
      asOf: AS_OF,
      cacheDir,
      client,
      now: clock.now,
      budget: 2,
    });
    expect(fetchImpl.requests).toHaveLength(2);
    expect(stats).toMatchObject({ requests: 2, listsRead: 1, detailsRead: 0, notReached: 1, stopped: "budget" });
    expect((facts[0] as CandidateFacts).lastStambyteYear).toBe(2006);
    expect(facts[1]).toBe(second.facts);
  });

  it("defaults: 300 requests and 20 minutes", () => {
    expect(CITY_STAGE_REQUEST_BUDGET).toBe(300);
    expect(CITY_STAGE_DEADLINE_MS).toBe(20 * 60 * 1000);
  });

  it("a CityStop 'http-429' on the second request ends the stage, leaves every row as before and resolves", async () => {
    const routes = fixtureRoutes();
    routes.splice(2, 1, { path: LIST_ROUTE, queryKey: "RealEstateName", status: 429, body: "" });
    const { clock, fetchImpl, client } = fixtureClient(routes);
    const rows = [row("Folkungagatan 61"), row("Hornsgatan 42"), row("Folkungagatan 61")];

    const result = await runCityStage(rows, { mode: "live", asOf: AS_OF, cacheDir, client, now: clock.now });

    expect(result.stats.stopped).toBe("http-429");
    expect(result.stats.notReached).toBe(3);
    expect(result.stats.requests).toBe(2);
    expect(fetchImpl.requests).toHaveLength(2);
    result.facts.forEach((f, i) => expect(f).toBe(rows[i].facts));
  });

  it("a CityStop in the middle of the detail pages keeps the list facts of that row and stops before the next row", async () => {
    const cases = [hissCase("001", "2025-01-10"), hissCase("002", "2025-02-10")];
    const { client, calls } = scriptedClient({
      caseList: async () => ({ cases, otherCases: [], headingCount: 2, termsLinks: [], addresses: [] }),
      caseDetail: async () => {
        throw new CityStop("http-403", true);
      },
    });
    const next = row("Annangatan 2");
    const { facts, stats } = await runCityStage([row("Testgatan 1"), next], { mode: "live", asOf: AS_OF, cacheDir, client, now: fakeClock().now });
    expect(stats).toMatchObject({ stopped: "http-403", notReached: 1, detailsRead: 0, listsRead: 1 });
    expect((facts[0] as CandidateFacts).byggarenden?.map((c) => c.month)).toEqual(["2025-02", "2025-01"]);
    expect(facts[1]).toBe(next.facts);
    expect(calls.filter((c) => c.startsWith("caseDetail"))).toHaveLength(1);
  });

  it("WR-07: a case without a detail page (null) is skipped; the next case is still read and the stage goes on", async () => {
    const cases = [hissCase("001", "2025-01-10"), hissCase("002", "2025-02-10")];
    const { client, calls } = scriptedClient({
      caseList: async () => ({ cases, otherCases: [], headingCount: 2, termsLinks: [], addresses: [] }),
      caseDetail: async (rec) => (rec === "002" ? null : emptyDetail(rec)),
    });
    const { stats } = await runCityStage([row("Testgatan 1"), row("Annangatan 2")], { mode: "live", asOf: AS_OF, cacheDir, client, now: fakeClock().now });
    expect(stats.stopped).toBeNull();
    expect(stats.notReached).toBe(0);
    expect(stats.detailsRead).toBeGreaterThanOrEqual(1);
    expect(calls.filter((c) => c.startsWith("caseDetail 001")).length).toBeGreaterThanOrEqual(1);
    expect(calls.filter((c) => c.startsWith("caseDetail 002")).length).toBeGreaterThanOrEqual(1);
  });

  it("a deadline reached before a row starts counts that row and all after it as notReached", async () => {
    const clock = fakeClock();
    const { client } = scriptedClient({
      addressSearch: async (address) => {
        clock.advance(5 * 60 * 1000);
        return [{ text: `Testen 1, ${address}`, value: "Testen 1" }];
      },
      caseList: async () => {
        clock.advance(5 * 60 * 1000);
        return { cases: [], otherCases: [], headingCount: 0, termsLinks: [], addresses: [] };
      },
    });
    const rows = [row("Testgatan 1"), row("Testgatan 2"), row("Testgatan 3")];
    const { facts, stats } = await runCityStage(rows, { mode: "live", asOf: AS_OF, cacheDir, client, now: clock.now, deadlineMs: 8 * 60 * 1000 });
    expect(stats).toMatchObject({ notReached: 2, stopped: "tidsgrans", requests: 2 });
    expect(facts[0]).not.toBe(rows[0].facts);
    expect(facts[1]).toBe(rows[1].facts);
    expect(facts[2]).toBe(rows[2].facts);
  });

  it("handles one row at a time (concurrency 1)", async () => {
    const { client, maxInFlight } = scriptedClient();
    await runCityStage([row("Testgatan 1"), row("Testgatan 2"), row("Testgatan 3")], { mode: "live", asOf: AS_OF, cacheDir, client, now: fakeClock().now });
    expect(maxInFlight()).toBe(1);
  });

  it("a plain error from the client leaves that row as it was and the stage goes on with the next one", async () => {
    let calls = 0;
    const { client } = scriptedClient({
      addressSearch: async (address) => {
        calls += 1;
        if (calls === 1) throw new Error("Ogiltigt värde för adress");
        return [{ text: `Testen 1, ${address}`, value: "Testen 1" }];
      },
    });
    const rows = [row("Testgatan 1"), row("Testgatan 2")];
    const { facts, stats } = await runCityStage(rows, { mode: "live", asOf: AS_OF, cacheDir, client, now: fakeClock().now });
    expect(facts[0]).toBe(rows[0].facts);
    expect((facts[1] as CandidateFacts).fastighetsbeteckning).toBe("Testen 1");
    expect(stats).toMatchObject({ resolved: 1, stopped: null, notReached: 0 });
  });

  it("an address the city cannot place stays unresolved; Min Karta (rung c) is the last resort and its calls count as requests", async () => {
    const { client } = scriptedClient({ addressSearch: async () => [] });
    const minkarta = vi.fn(async () => ({ status: "resolved" as const, beteckning: "Oljan 29", reason: "ok", calls: 3 }));
    const withC = await runCityStage([row("Testgatan 1")], { mode: "live", asOf: AS_OF, cacheDir, client, minkarta, now: fakeClock().now });
    expect((withC.facts[0] as CandidateFacts).beteckningRung).toBe("c");
    expect(withC.stats.byRung.c).toBe(1);
    expect(withC.stats.requests).toBe(1 + 3 + 1); // address search, Min Karta's three, the list

    const rows = [row("Testgatan 9")];
    const without = await runCityStage(rows, { mode: "live", asOf: AS_OF, cacheDir, client, now: fakeClock().now });
    expect(without.facts[0]).toBe(rows[0].facts);
    expect(without.stats).toMatchObject({ rows: 1, resolved: 0, notReached: 0 });
  });
});

describe("cityStageLine", () => {
  const stats: CityStageStats = {
    rows: 10,
    resolved: 7,
    byRung: { a: 1, a2: 2, b: 3, c: 1 },
    listsRead: 6,
    detailsRead: 9,
    requests: 31,
    notReached: 2,
    stopped: null,
  };

  it("prints the pinned shape", () => {
    expect(cityStageLine(stats)).toBe(
      "Stadens ärendelista: fastighetsbeteckning 7 av 10 (a 1, a2 2, b 3, c 1), ärendelista läst 6, detaljsidor 9, anrop 31, ej nådda 2",
    );
  });

  it("appends the reason when the stage was stopped", () => {
    expect(cityStageLine({ ...stats, stopped: "http-429" })).toBe(
      "Stadens ärendelista: fastighetsbeteckning 7 av 10 (a 1, a2 2, b 3, c 1), ärendelista läst 6, detaljsidor 9, anrop 31, ej nådda 2, stoppad (http-429)",
    );
  });
});
