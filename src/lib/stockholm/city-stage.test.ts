// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { apifyClientMockFactory } from "@/lib/booli/__mocks__/apify-client";
import snapshotJson from "@/lib/discovery/__fixtures__/forsale-snapshot.fixture.json";
import type { DiscoveryCandidate } from "@/lib/discovery/candidate";
import { parseFitSnapshot } from "@/lib/discovery/fit-score";
import { candidateFactsSchema, emptyFacts, type CandidateFacts } from "@/lib/discovery/listing-facts";
import { enrichAllCandidates, type WatchEnrichDeps } from "@/lib/discovery/watch-enrich";
import { buildingFactsOf, type StoredCase } from "@/lib/stockholm/bygglov-classify";
import { cityFactsFromCases, runCityStage } from "@/lib/stockholm/city-stage";

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
  sourceListingUrl: "https://www.booli.se/bostad/150148",
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
    expect(row.cityStambyte).toEqual({ lastYear: 2006, basis: "start", ongoing: false, relining: false });
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
