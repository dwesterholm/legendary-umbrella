import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSweep, normaliseAddressKey, saveSweep, type SweepCase, type SweepQuery } from "@/lib/stockholm/bygglov-cache";
import { CityStop, makeCityClient } from "@/lib/stockholm/bygglov-client";
import { assertManualRunAllowed } from "@/lib/stockholm/host-gate";
import { makeFixtureFetch } from "@/lib/stockholm/fixture-fetch";
import {
  SWEEP_DISTRICTS,
  buildCaseIndex,
  buildSweepEvidence,
  classifySoldAddress,
  collectSweep,
  isStambyteCase,
  joinCounts,
  normaliseAddress,
  parseAddresses,
  planSweep,
  renderSweepMarkdown,
  runSweep,
  shiftYears,
  splitWindow,
  stambyteAtSale,
  summariseCases,
  sweepEvidenceSchema,
  sweepKeywords,
  sweepWindows,
  type CaseIndex,
  type IndexableCase,
  type StambyteCaseInput,
} from "@/lib/discovery/stambyte-join";

const FIXTURES = join(__dirname, "..", "stockholm", "__fixtures__");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stambyte-join-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The tracer: the saved Södermalm "stambyte" search goes through the client and the sweep cache and comes back as the 380 cases. */
async function sodermalmCases(): Promise<IndexableCase[]> {
  let t = Date.parse("2026-10-18T17:00:00.000Z");
  const fetchImpl = makeFixtureFetch(FIXTURES, [
    { path: "/byggochplantjansten/arendeochhandlingar", queryKey: "District", file: "ext-sodermalm-stambyte-1985.fixture.html" },
  ]);
  const client = makeCityClient({
    fetchImpl,
    sleep: async (ms) => {
      t += ms;
    },
    now: () => new Date(t),
    log: () => undefined,
    gatesPath: join(dir, "host-gates.json"),
    dataDir: dir,
  });
  const query = { district: "Södermalm", description: "stambyte", from: "1985-01-01", to: null } as const;
  const answer = await client.extendedSearch({ district: query.district, description: query.description, from: query.from });
  if (!answer.ok) throw new Error("the saved page must parse");
  saveSweep(query, answer, { dir, now: new Date(t) });
  const loaded = loadSweep(query, { dir });
  if (!loaded.ok) throw new Error("the saved sweep must read back");
  return [...loaded.entry.cases];
}

describe("the saved Södermalm search through the sweep cache and the case index (tracer)", () => {
  it("gives 380 cases, 347 buildings, all of them stambyte and none relining", async () => {
    const cases = await sodermalmCases();
    expect(summariseCases(cases)).toEqual({ cases: 380, beteckningar: 347, stambyte: 380, relining: 0 });
  });

  it("indexes every address of every case, split lists included, and every beteckning", async () => {
    const index = buildCaseIndex(await sodermalmCases());
    expect(index.cases.size).toBe(380);
    expect(index.byBeteckning.size).toBe(347);
    // "Brännkyrkagatan 64,Ludvigsbergsgatan 1,Gamla Lundagatan 1" is three addresses of one case.
    expect(index.byAddress.has("brännkyrkagatan 64")).toBe(true);
    expect(index.byAddress.has("ludvigsbergsgatan 1")).toBe(true);
    expect(index.byAddress.has("gamla lundagatan 1")).toBe(true);
    // "Bondegatan 1f,Bondegatan 1d,Bondegatan 1b": the bare "1d" style entrances stay separate keys.
    expect(index.byAddress.has("bondegatan 1f")).toBe(true);
    expect(index.byAddress.has("bondegatan 1b")).toBe(true);
    // "Krukmakarg 42 / RINGVÄGEN 14" lists two streets.
    expect(index.byAddress.has("krukmakarg 42")).toBe(true);
    expect(index.byAddress.has("ringvägen 14")).toBe(true);
    expect(index.byBeteckning.has("skrovet 8")).toBe(true);
  });

  describe("classifySoldAddress", () => {
    let index: CaseIndex;
    beforeEach(async () => {
      index = buildCaseIndex(await sodermalmCases());
    });

    it('is "exact" for "Slipgatan 11" and names its building', () => {
      const match = classifySoldAddress("Slipgatan 11", index);
      expect(match.class).toBe("exact");
      expect(match.beteckningar).toContain("Skrovet 8");
    });

    it('is "exact" for the same address written with a space before the letter', () => {
      expect(classifySoldAddress("Heleneborgsgatan 28 A", index).class).toBe("exact");
      expect(classifySoldAddress("Heleneborgsgatan 28A", index).class).toBe("exact");
    });

    it('is "letter" when only the entrance letter differs, either way round', () => {
      expect(classifySoldAddress("Heleneborgsgatan 28 B", index).class).toBe("letter");
      expect(classifySoldAddress("Bondegatan 1", index).class).toBe("letter");
    });

    it('is "near" for the same street within two house numbers and "none" beyond that', () => {
      expect(classifySoldAddress("Slipgatan 13", index).class).toBe("near");
      expect(classifySoldAddress("Slipgatan 9", index).class).toBe("near");
      expect(classifySoldAddress("Slipgatan 99", index).class).toBe("none");
    });

    it('is "none" for another street, for a street with no number and for "Adress saknas"', () => {
      expect(classifySoldAddress("Idungatan 5", index).class).toBe("none");
      expect(classifySoldAddress("Lützengatan", index).class).toBe("none");
      expect(classifySoldAddress("Adress saknas", index).class).toBe("none");
    });

    it("counts rows per class", () => {
      const counts = joinCounts(["Slipgatan 11", "Slipgatan 13", "Slipgatan 99", "Heleneborgsgatan 28 B", "Slipgatan 11"], index);
      expect(counts).toEqual({ rows: 5, exact: 2, letter: 1, near: 1, none: 1 });
    });
  });
});

describe("addresses", () => {
  it("reads a range of house numbers, a range of letters and a bare number after a street", () => {
    expect(parseAddresses("Siargatan 9-11").map((a) => `${a.street} ${a.number}`)).toEqual(["siargatan 9", "siargatan 11"]);
    expect(parseAddresses("Tengdahlsgatan 4-18")).toHaveLength(8);
    expect(parseAddresses("Heleneborgsgatan 13 A-D").map((a) => a.letter)).toEqual(["a", "b", "c", "d"]);
    expect(parseAddresses("41", "tavastgatan")).toEqual([{ street: "tavastgatan", number: 41, letter: null }]);
    expect(parseAddresses("41")).toEqual([]);
    expect(parseAddresses("Östgötagatan 87A O B +")).toEqual([{ street: "östgötagatan", number: 87, letter: "a" }]);
    expect(parseAddresses("Adress saknas")).toEqual([]);
  });

  it("uses the same key form as the address cache", () => {
    for (const a of ["Torsgatan 48 A", "  Slipgatan   11 ", "Heleneborgsgatan 28A", "Valhallavägen 148 B"]) {
      expect(normaliseAddress(a)).toBe(normaliseAddressKey(a));
    }
  });
});

describe("the sweep plan", () => {
  it("names 11 stadsdelar the way the city spells them, the four of the sold set first", () => {
    expect(SWEEP_DISTRICTS).toHaveLength(11);
    expect(SWEEP_DISTRICTS.slice(0, 4)).toEqual(["Södermalm", "Kungsholmen", "Vasastaden", "Östermalm"]);
    expect(SWEEP_DISTRICTS).toContain("Vasastaden");
    expect(SWEEP_DISTRICTS).not.toContain("Vasastan");
  });

  it("sends the stem words when the field matches inside words, the whole words otherwise, and never a bare VA", () => {
    expect(sweepKeywords(true)).toEqual(["stam", "avlopp", "vatten", "relin"]);
    for (const substring of [false, null] as const) {
      expect(sweepKeywords(substring)).toEqual(["stambyte", "stamrenovering", "avlopp", "vatten", "relining"]);
    }
    for (const substring of [true, false, null] as const) {
      expect(sweepKeywords(substring).map((k) => k.toLowerCase())).not.toContain("va");
    }
  });

  it("has two windows: 1985 to the end of 2009, and 2010 onwards", () => {
    expect(sweepWindows()).toEqual([
      { from: "1985-01-01", to: "2009-12-31" },
      { from: "2010-01-01", to: null },
    ]);
    expect(SWEEP_DISTRICTS.length * sweepKeywords(true).length * sweepWindows().length).toBe(88);
  });
});

// ---------------------------------------------------------------------------
// The state of a building on the sale date
// ---------------------------------------------------------------------------

const stambyte = (startDate: string, slutbeskedDate: string | null = null, extra: Partial<StambyteCaseInput> = {}): StambyteCaseInput => ({
  startDate,
  kinds: ["stambyte"],
  slutbeskedDate,
  ...extra,
});

describe("stambyteAtSale counts from the sale date", () => {
  // A building with an old list-only case and a recent one that was signed off in March 2023.
  const building = [stambyte("2001-03-12"), stambyte("2020-12-08", "2023-03-15")];

  it("2022-06-01: the 2001 case is past, the 2020 case is still going", () => {
    expect(stambyteAtSale(building, "2022-06-01")).toEqual({
      recorded: true,
      latestYear: 2001,
      source: "start",
      yearsBefore: 21,
      ongoingAtSale: true,
      futureAtSale: false,
    });
  });

  it("2024-01-10: the slutbesked of March 2023 is the latest year, one year before", () => {
    expect(stambyteAtSale(building, "2024-01-10")).toEqual({
      recorded: true,
      latestYear: 2023,
      source: "slutbesked",
      yearsBefore: 1,
      ongoingAtSale: false,
      futureAtSale: false,
    });
  });

  it("2000-05-01: both cases started after the sale, so futureAtSale is true and nothing is recorded", () => {
    expect(stambyteAtSale(building, "2000-05-01")).toEqual({
      recorded: false,
      latestYear: null,
      source: null,
      yearsBefore: null,
      ongoingAtSale: false,
      futureAtSale: true,
    });
  });

  it("a case started after the sale is never a past stambyte, also when it has a slutbesked", () => {
    const result = stambyteAtSale([stambyte("2021-01-01", "2022-01-01")], "2019-06-01");
    expect(result.recorded).toBe(false);
    expect(result.futureAtSale).toBe(true);
  });

  it("a slutbesked on the very day of the sale counts, the day after does not", () => {
    expect(stambyteAtSale([stambyte("2021-01-01", "2022-06-01")], "2022-06-01").recorded).toBe(true);
    expect(stambyteAtSale([stambyte("2021-01-01", "2022-06-02")], "2022-06-01").recorded).toBe(false);
  });

  it("a list-only case counts as done only when it started at least 3 years before the sale", () => {
    expect(stambyteAtSale([stambyte("2019-06-01")], "2022-06-01")).toMatchObject({ recorded: true, latestYear: 2019 });
    const young = stambyteAtSale([stambyte("2019-06-02")], "2022-06-01");
    expect(young.recorded).toBe(false);
    expect(young.ongoingAtSale).toBe(true);
  });

  it("a case that started more than 5 years before the sale and has no finish is neither past nor ongoing", () => {
    // Slutbesked after the sale, started 12 years earlier: nothing to say.
    const result = stambyteAtSale([stambyte("2010-01-01", "2023-01-01")], "2022-06-01");
    expect(result).toMatchObject({ recorded: false, ongoingAtSale: false, futureAtSale: false });
  });

  it("a relining-only building is not recorded and never future or ongoing", () => {
    const relining: StambyteCaseInput = { startDate: "2001-03-12", kinds: ["relining"], slutbeskedDate: null };
    expect(isStambyteCase(relining)).toBe(false);
    // WR-03: tagged both ways is a relining as well
    expect(isStambyteCase({ ...relining, kinds: ["relining", "stambyte"] })).toBe(false);
    expect(stambyteAtSale([{ ...relining, kinds: ["relining", "stambyte"] }], "2022-06-01").recorded).toBe(false);
    expect(stambyteAtSale([relining], "2022-06-01")).toEqual({
      recorded: false,
      latestYear: null,
      source: null,
      yearsBefore: null,
      ongoingAtSale: false,
      futureAtSale: false,
    });
    expect(stambyteAtSale([relining], "2000-01-01").futureAtSale).toBe(false);
  });

  it("WR-03: a case that carries both tags is a relining, not a stambyte", () => {
    const both: StambyteCaseInput = { startDate: "2001-03-12", kinds: ["relining", "stambyte"] };
    expect(stambyteAtSale([both], "2022-06-01").recorded).toBe(false);
  });

  it("a withdrawn or refused case is not a stambyte", () => {
    const withdrawn = stambyte("2001-03-12", null, { latest: { type: "Beslut", code: "Avskrivet" } });
    const refused = stambyte("2002-03-12", null, { latest: { type: "Beslut", code: "Avslag" } });
    expect(stambyteAtSale([withdrawn, refused], "2022-06-01").recorded).toBe(false);
    expect(stambyteAtSale([withdrawn, stambyte("1995-05-05")], "2022-06-01").latestYear).toBe(1995);
  });

  it("takes the latest year of several past cases", () => {
    const result = stambyteAtSale([stambyte("1996-01-01"), stambyte("2008-01-01"), stambyte("2001-01-01")], "2022-06-01");
    expect(result).toMatchObject({ latestYear: 2008, yearsBefore: 14 });
  });

  it("shiftYears keeps 29 February valid", () => {
    expect(shiftYears("2024-02-29", -3)).toBe("2021-02-28");
    expect(shiftYears("2024-02-29", -4)).toBe("2020-02-29");
    expect(shiftYears("2022-06-01", -5)).toBe("2017-06-01");
  });
});

// ---------------------------------------------------------------------------
// Task 2: window splitting, resuming and stopping
// ---------------------------------------------------------------------------

/** One Byggärende row of the city's embedded list, as the real pages carry it. */
function pageRow(rec: number, over: Record<string, unknown> = {}) {
  return {
    RecNo: String(rec),
    CaseTypeCode: "Byggärende",
    ObjectType: null,
    Description: "Stambyte i flerbostadshus",
    StartDate: "2001-03-12T00:00:00",
    RealEstateName: `Testen ${rec}`,
    RealEstateAddress: `Testgatan ${rec}`,
    Name: `2001-${rec}`,
    IsEarchive: true,
    ...over,
  };
}

/** A list page with `rows` rows whose own heading says `heading` (a number that differs from the rows is a hidden cap). */
function listPage(rows: number, heading: number = rows, firstRec = 1): string {
  const list = Array.from({ length: rows }, (_, i) => pageRow(firstRec + i));
  const model = {
    BuildCases: { CaseSearchDetails: list },
    OtherCases: { CaseSearchDetails: [] },
    RealEstateCases: { CaseSearchDetails: [] },
    HasSearched: true,
  };
  return `<html><body><button>Byggärenden (${heading} träffar)</button><script>var CaseSearchResultsViewModel = ${JSON.stringify(model)};</script></body></html>`;
}

const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

/** A fetch that answers by what the request asks for, and remembers what it was asked. */
function scriptedFetch(answer: (params: URLSearchParams, n: number) => Response) {
  const asked: Array<{ district: string; word: string; from: string; to: string | null }> = [];
  const fetchImpl = async (url: string) => {
    const params = new URL(url).searchParams;
    asked.push({
      district: params.get("District") ?? "",
      word: params.get("Description") ?? "",
      from: params.get("CaseStartDateFrom") ?? "",
      to: params.get("CaseStartDateTo"),
    });
    return answer(params, asked.length);
  };
  return Object.assign(fetchImpl, { asked });
}

function fakeClock(start: Date) {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

/** An in-memory stand-in for the sweep cache and the split list. */
function memoryStore() {
  const files = new Map<string, number>();
  const splits: Array<{ key: string; reason: string }> = [];
  const unsplittable: string[] = [];
  const key = (q: SweepQuery) => `${q.district}|${q.description}|${q.from}|${q.to ?? "open"}`;
  return {
    files,
    splits,
    unsplittable,
    key,
    isFresh: (q: SweepQuery) => files.has(key(q)),
    save: (q: SweepQuery, r: { cases: readonly unknown[] }) => {
      files.set(key(q), r.cases.length);
    },
    splitRecorded: (q: SweepQuery) => splits.some((s) => s.key === key(q)),
    recordSplit: (q: SweepQuery, reason: string) => {
      if (!splits.some((s) => s.key === key(q))) splits.push({ key: key(q), reason });
    },
    recordUnsplittable: (q: SweepQuery) => {
      unsplittable.push(key(q));
    },
  };
}

type Store = ReturnType<typeof memoryStore>;

/** A runSweep wired to the real city client over a scripted fetch, a fake clock and an in-memory cache. */
function sweepRig(opts: { start?: Date; answer: (params: URLSearchParams, n: number) => Response; store?: Store; budget?: number }) {
  const clock = fakeClock(opts.start ?? new Date(2026, 9, 18, 20, 0, 0));
  const fetchImpl = scriptedFetch(opts.answer);
  const store = opts.store ?? memoryStore();
  const client = makeCityClient({
    fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
    log: () => undefined,
    gatesPath: join(dir, "host-gates.json"),
    dataDir: dir,
    budget: opts.budget,
  });
  const logs: string[] = [];
  const run = (plan: SweepQuery[]) =>
    runSweep(plan, {
      search: (q) => client.extendedSearch({ district: q.district, description: q.description, from: q.from, to: q.to ?? undefined }),
      isFresh: store.isFresh,
      save: store.save,
      splitRecorded: store.splitRecorded,
      recordSplit: store.recordSplit,
      recordUnsplittable: store.recordUnsplittable,
      now: clock.now,
      allowed: assertManualRunAllowed,
      stopOf: (error) => (error instanceof CityStop ? error.label : null),
      log: (line) => logs.push(line),
      today: "2026-10-18",
    });
  return { run, fetchImpl, store, logs, clock };
}

const query = (district: string, description: string, from: string, to: string | null): SweepQuery => ({ district, description, from, to });

describe("splitWindow", () => {
  it("splits 1985 to 2009 into five 5-year spans with inclusive dates", () => {
    expect(splitWindow({ from: "1985-01-01", to: "2009-12-31" })).toEqual([
      { from: "1985-01-01", to: "1989-12-31" },
      { from: "1990-01-01", to: "1994-12-31" },
      { from: "1995-01-01", to: "1999-12-31" },
      { from: "2000-01-01", to: "2004-12-31" },
      { from: "2005-01-01", to: "2009-12-31" },
    ]);
  });

  it("splits a window that is 5 years long or shorter by year", () => {
    expect(splitWindow({ from: "2005-01-01", to: "2009-12-31" })).toEqual([
      { from: "2005-01-01", to: "2005-12-31" },
      { from: "2006-01-01", to: "2006-12-31" },
      { from: "2007-01-01", to: "2007-12-31" },
      { from: "2008-01-01", to: "2008-12-31" },
      { from: "2009-01-01", to: "2009-12-31" },
    ]);
    expect(splitWindow({ from: "2005-01-01", to: "2006-12-31" })).toHaveLength(2);
  });

  it("cannot split a single year", () => {
    expect(splitWindow({ from: "2007-01-01", to: "2007-12-31" })).toEqual([]);
  });

  it("keeps an open end open, so the last span still reaches today", () => {
    expect(splitWindow({ from: "2010-01-01", to: null }, "2026-10-18")).toEqual([
      { from: "2010-01-01", to: "2014-12-31" },
      { from: "2015-01-01", to: "2019-12-31" },
      { from: "2020-01-01", to: "2024-12-31" },
      { from: "2025-01-01", to: null },
    ]);
    expect(() => splitWindow({ from: "2010-01-01", to: null })).toThrow();
  });

  it("leaves no gap and no overlap, also for a window that starts and ends inside a year", () => {
    const windows = [
      { from: "1985-01-01", to: "2009-12-31" },
      { from: "1987-06-15", to: "1993-03-02" },
      { from: "2001-01-01", to: "2003-12-31" },
    ];
    for (const w of windows) {
      const spans = splitWindow(w);
      expect(spans[0].from).toBe(w.from);
      expect(spans[spans.length - 1].to).toBe(w.to);
      for (let i = 1; i < spans.length; i += 1) {
        const before = new Date(`${spans[i - 1].to}T00:00:00Z`).getTime() + 86_400_000;
        expect(new Date(`${spans[i].from}T00:00:00Z`).getTime()).toBe(before);
      }
    }
  });
});

describe("planSweep", () => {
  it("lists every query of the sweep when nothing is cached, in district, word, window order", () => {
    const plan = planSweep(SWEEP_DISTRICTS, sweepKeywords(true), sweepWindows(), () => false);
    expect(plan).toHaveLength(88);
    expect(plan[0]).toEqual(query("Södermalm", "stam", "1985-01-01", "2009-12-31"));
    expect(plan[1]).toEqual(query("Södermalm", "stam", "2010-01-01", null));
    expect(plan[2]).toEqual(query("Södermalm", "avlopp", "1985-01-01", "2009-12-31"));
  });

  it("lists only the queries whose file is missing or stale, and none when all are cached", () => {
    const cached = new Set(["Södermalm|stam|1985-01-01|2009-12-31"]);
    const isCached = (q: SweepQuery) => cached.has(`${q.district}|${q.description}|${q.from}|${q.to ?? "open"}`);
    expect(planSweep(["Södermalm"], ["stam", "avlopp"], sweepWindows(), isCached)).toHaveLength(3);
    expect(planSweep(["Södermalm"], ["stam"], sweepWindows(), () => true)).toEqual([]);
  });
});

describe("runSweep: a capped or oversized answer is split and never hidden", () => {
  const parent = query("Södermalm", "stam", "1985-01-01", "2009-12-31");

  it("asks the five spans instead of a window that answered 500 rows with a heading of 500", async () => {
    const rig = sweepRig({
      answer: (p) => (p.get("CaseStartDateTo") === "2009-12-31" && p.get("CaseStartDateFrom") === "1985-01-01" ? html(listPage(500)) : html(listPage(3))),
    });
    const result = await rig.run([parent]);

    expect(result.status).toBe("klar");
    expect(rig.fetchImpl.asked).toHaveLength(6);
    expect(rig.fetchImpl.asked.slice(1).map((a) => `${a.from}..${a.to}`)).toEqual([
      "1985-01-01..1989-12-31",
      "1990-01-01..1994-12-31",
      "1995-01-01..1999-12-31",
      "2000-01-01..2004-12-31",
      "2005-01-01..2009-12-31",
    ]);
    expect(rig.store.isFresh(parent)).toBe(false);
    expect(rig.store.splits).toEqual([{ key: rig.store.key(parent), reason: "antal" }]);
    expect(rig.store.files.size).toBe(5);
    expect(result.splits).toHaveLength(1);
    expect(result.saved).toBe(1);
  });

  it("splits a query the city answers with a page over the size cap (storlek)", async () => {
    const rig = sweepRig({
      answer: (p) =>
        p.get("CaseStartDateTo") === "2009-12-31" && p.get("CaseStartDateFrom") === "1985-01-01"
          ? html(listPage(2), 200, { "content-length": String(6 * 1024 * 1024) })
          : html(listPage(2)),
    });
    const result = await rig.run([parent]);
    expect(rig.fetchImpl.asked).toHaveLength(6);
    expect(rig.store.splits[0].reason).toBe("storlek");
    expect(result.status).toBe("klar");
  });

  it("splits a query whose own heading count differs from its rows", async () => {
    const rig = sweepRig({
      answer: (p) => (p.get("CaseStartDateTo") === "2009-12-31" && p.get("CaseStartDateFrom") === "1985-01-01" ? html(listPage(50, 97)) : html(listPage(2))),
    });
    await rig.run([parent]);
    expect(rig.fetchImpl.asked).toHaveLength(6);
    expect(rig.store.splits[0].reason).toBe("antal");
  });

  it("splits a short window by year, and reports a single year whose count cannot be trusted without stopping the run", async () => {
    const rig = sweepRig({
      // Every window answers 500 rows until it is one year long; Kungsholmen's single year has a count that does not fit.
      answer: (p) => {
        const from = p.get("CaseStartDateFrom") as string;
        const to = p.get("CaseStartDateTo");
        const oneYear = to !== null && from.slice(0, 4) === to.slice(0, 4);
        if (oneYear && p.get("District") === "Kungsholmen") return html(listPage(50, 97));
        return oneYear ? html(listPage(40)) : html(listPage(500));
      },
    });
    const result = await rig.run([query("Södermalm", "stam", "2005-01-01", "2009-12-31"), query("Kungsholmen", "stam", "2005-01-01", "2005-12-31")]);
    // 1 + 5 year spans for the first query; the second is one year long and cannot be split.
    expect(rig.fetchImpl.asked).toHaveLength(1 + 5 + 1);
    expect(result.status).toBe("klar");
    expect(result.unsplittable).toEqual([query("Kungsholmen", "stam", "2005-01-01", "2005-12-31")]);
    expect(rig.store.unsplittable).toHaveLength(1);
    expect(result.saved).toBe(1);
    expect(result.total).toBe(2);
  });

  it("keeps a single year of 500 consistent rows (nothing smaller exists to ask for)", async () => {
    const rig = sweepRig({ answer: () => html(listPage(500)) });
    const result = await rig.run([query("Södermalm", "vatten", "2005-01-01", "2005-12-31")]);
    expect(rig.fetchImpl.asked).toHaveLength(1);
    expect(rig.store.files.size).toBe(1);
    expect(result.unsplittable).toEqual([]);
    expect(result.saved).toBe(1);
  });

  it("does not ask a recorded split again on a second run, and never asks a cached query", async () => {
    const answer = (p: URLSearchParams) =>
      p.get("CaseStartDateTo") === "2009-12-31" && p.get("CaseStartDateFrom") === "1985-01-01" ? html(listPage(500)) : html(listPage(3));
    const rig = sweepRig({ answer });
    await rig.run([parent]);
    const before = rig.fetchImpl.asked.length;
    const again = await rig.run([parent]);
    expect(rig.fetchImpl.asked.length).toBe(before);
    expect(again.status).toBe("klar");
    expect(again.searches).toBe(0);
    expect(again.saved).toBe(1);
  });
});

describe("runSweep: a refusal leaves a usable partial cache", () => {
  const plan = ["Södermalm", "Kungsholmen"].flatMap((d) =>
    ["stam", "avlopp"].flatMap((w) => [query(d, w, "1985-01-01", "2009-12-31"), query(d, w, "2010-01-01", null)]),
  );

  it("stops on HTTP 429 at the 4th query with three files written, says so, and puts the host on the 24 hour list", async () => {
    const rig = sweepRig({ answer: (_p, n) => (n < 4 ? html(listPage(2)) : html("", 429)) });
    const result = await rig.run(plan);

    expect(result.status).toBe("stoppad");
    expect(result.stop).toMatchObject({ kind: "stad", label: "http-429" });
    expect(result.message).toBe("Svepet stoppat (http-429): 3 av 8 sökningar sparade");
    expect(rig.store.files.size).toBe(3);
    expect(rig.fetchImpl.asked).toHaveLength(4);
    expect(readFileSync(join(dir, "host-gates.json"), "utf8")).toContain("http-429");
  });

  it("makes no request at all the next time while the host is blocked", async () => {
    const store = memoryStore();
    const first = sweepRig({ answer: (_p, n) => (n < 2 ? html(listPage(2)) : html("", 429)), store });
    await first.run(plan);
    const second = sweepRig({ answer: () => html(listPage(2)), store });
    const result = await second.run(plan);
    expect(second.fetchImpl.asked).toHaveLength(0);
    expect(result.stop).toMatchObject({ kind: "stad", label: "pausad" });
    expect(store.files.size).toBe(1);
  });

  it("resumes where it stopped: the saved queries are skipped and the rest is asked", async () => {
    const store = memoryStore();
    const first = sweepRig({ answer: (_p, n) => (n < 4 ? html(listPage(2)) : html("", 500)), store });
    const stopped = await first.run(plan);
    expect(stopped.status).toBe("stoppad");
    expect(store.files.size).toBe(3);

    const resumed = sweepRig({ answer: () => html(listPage(2)), store });
    const done = await resumed.run(plan);
    expect(done.status).toBe("klar");
    expect(resumed.fetchImpl.asked).toHaveLength(5);
    expect(store.files.size).toBe(8);
    expect(done.message).toBeNull();
  });

  it("stops on the request budget without a block and says so", async () => {
    const rig = sweepRig({ answer: () => html(listPage(2)), budget: 2 });
    const result = await rig.run(plan);
    expect(result.stop).toMatchObject({ kind: "stad", label: "budget" });
    expect(result.message).toBe("Svepet stoppat (budget): 2 av 8 sökningar sparade");
    expect(existsSync(join(dir, "host-gates.json"))).toBe(false);
  });
});

describe("runSweep: the Monday window is checked before every request", () => {
  const plan = Array.from({ length: 8 }, (_, i) => query("Södermalm", `ord${i}`, "1985-01-01", "2009-12-31"));

  it("refuses a run that starts at Monday 06:31 before any request", async () => {
    // 2026-10-19 is a Monday.
    const rig = sweepRig({ start: new Date(2026, 9, 19, 6, 31, 0), answer: () => html(listPage(2)) });
    const result = await rig.run(plan);
    expect(rig.fetchImpl.asked).toHaveLength(0);
    expect(result.status).toBe("stoppad");
    expect(result.stop?.kind).toBe("fonster");
    expect(result.message).toContain("måndagar mellan 06:30 och 09:30");
  });

  it("stops before the next request when the clock reaches Monday 06:30 mid-run, and keeps what it has", async () => {
    const rig = sweepRig({ start: new Date(2026, 9, 19, 6, 29, 50), answer: () => html(listPage(2)) });
    const result = await rig.run(plan);
    expect(result.status).toBe("stoppad");
    expect(result.stop?.kind).toBe("fonster");
    // Requests start at 06:29:50, :53, :56 and :59. The fifth would start at 06:30:02, so the check, which counts the
    // 3 s gate in, refuses it.
    expect(rig.fetchImpl.asked).toHaveLength(4);
    expect(rig.store.files.size).toBe(4);
    expect(result.saved).toBe(4);
    const last = rig.clock.now();
    expect(last.getHours() * 60 + last.getMinutes()).toBeLessThan(6 * 60 + 30);
  });

  it("runs on a Monday at 09:30 and on a Sunday evening", async () => {
    for (const start of [new Date(2026, 9, 19, 9, 30, 0), new Date(2026, 9, 18, 20, 0, 0)]) {
      const rig = sweepRig({ start, answer: () => html(listPage(2)) });
      const result = await rig.run(plan.slice(0, 2));
      expect(result.status).toBe("klar");
    }
  });
});

describe("collectSweep reads the plan back from the cache", () => {
  const cases = [{ rec: "1", beteckning: "A 1", addresses: ["Testgatan 1"], startDate: "2001-01-01", kinds: ["stambyte"], primary: "stambyte", tillsyn: false, archived: true }] as const;
  const whole = query("Södermalm", "stam", "1985-01-01", "2009-12-31");

  it("takes a cached query as a leaf, a split query as its spans, and lists what is missing", () => {
    const cached = new Set<string>();
    const key = (q: SweepQuery) => `${q.district}|${q.from}|${q.to ?? "open"}`;
    for (const span of splitWindow({ from: whole.from, to: whole.to })) cached.add(key({ ...whole, from: span.from, to: span.to }));
    cached.delete(key({ ...whole, from: "1995-01-01", to: "1999-12-31" }));
    const open = query("Södermalm", "stam", "2010-01-01", null);
    cached.add(key(open));

    const result = collectSweep([whole, open, query("Kungsholmen", "stam", "2010-01-01", null)], {
      load: (q) => (cached.has(key(q)) ? { cases, headingCount: 1 } : null),
      splitRecorded: (q) => key(q) === key(whole),
      today: "2026-10-18",
    });

    expect(result.splitParents).toEqual([whole]);
    expect(result.leaves.map((l) => l.query.from)).toEqual(["1985-01-01", "1990-01-01", "2000-01-01", "2005-01-01", "2010-01-01"]);
    expect(result.missing).toEqual([query("Södermalm", "stam", "1995-01-01", "1999-12-31"), query("Kungsholmen", "stam", "2010-01-01", null)]);
  });
});

describe("the sweep evidence holds counts only", () => {
  const sweepCase = (rec: string, beteckning: string, startDate: string, kinds: Array<"stambyte" | "relining">, archived = true): SweepCase => ({
    rec,
    beteckning,
    addresses: ["Testgatan 1"],
    startDate,
    kinds,
    primary: kinds[0],
    tillsyn: false,
    archived,
  });

  const whole = query("Södermalm", "stam", "1985-01-01", "2009-12-31");
  const spans = splitWindow({ from: whole.from, to: whole.to }).map((w) => query("Södermalm", "stam", w.from, w.to));
  const open = query("Södermalm", "stam", "2010-01-01", null);
  const kungs = query("Kungsholmen", "stam", "2010-01-01", null);

  function evidence(stop: string | null = null) {
    const first = [sweepCase("1", "Skrovet 8", "1995-03-01", ["stambyte"]), sweepCase("2", "Skrovet 8", "2001-05-01", ["relining"])];
    const second = [sweepCase("3", "Slipen 41", "2015-05-01", ["stambyte", "relining"], false), sweepCase("1", "Skrovet 8", "1995-03-01", ["stambyte"])];
    return buildSweepEvidence({
      ranAt: "2026-10-18T20:00:00.000Z",
      keywords: ["stam"],
      substring: true,
      districts: ["Södermalm", "Kungsholmen"],
      windows: sweepWindows(),
      collection: {
        leaves: [
          { query: spans[0], cases: first, headingCount: 2 },
          { query: spans[1], cases: [], headingCount: 0 },
          { query: open, cases: second, headingCount: 2 },
        ],
        splitParents: [whole],
        missing: [kungs],
      },
      splits: [{ ...whole, reason: "antal" }],
      requests: 9,
      seconds: [1.2, 3.4, 2.1],
      stop,
    });
  }

  it("counts distinct cases and buildings, keeps relining apart from stambyte and is not complete while a query is missing", () => {
    const e = evidence("http-429");
    expect(e.complete).toBe(false);
    expect(e.stop).toBe("http-429");
    expect(e.totals).toMatchObject({
      searches: 3,
      cases: 3,
      distinctBeteckningar: 2,
      stambyteTagged: 1,
      stambyteBeteckningar: 1,
      reliningTagged: 2,
      active: 1,
      archived: 2,
    });
    expect(e.totals.stambytePerStartYear).toEqual({ "1995": 1 });
    expect(e.byDistrict.map((d) => [d.district, d.cases, d.complete])).toEqual([
      ["Södermalm", 3, true],
      ["Kungsholmen", 0, false],
    ]);
    expect(e.byDistrict[0].stambyteByDecade).toEqual({ "1990": 1 });
    expect(e.requests).toBe(9);
    expect(e.secondsMedian).toBe(2.1);
    expect(e.secondsMax).toBe(3.4);
  });

  it("lists the split parent as a split query and its spans with their own counts", () => {
    const e = evidence();
    const parent = e.queries.find((q) => q.split);
    expect(parent).toMatchObject({ district: "Södermalm", keyword: "stam", from: "1985-01-01", to: "2009-12-31", rows: null });
    const leaves = e.queries.filter((q) => !q.split);
    expect(leaves.every((q) => q.rows === q.headingCount)).toBe(true);
    expect(e.splits).toEqual([{ district: "Södermalm", keyword: "stam", from: "1985-01-01", to: "2009-12-31", reason: "antal" }]);
    expect(e.missing).toEqual([{ district: "Kungsholmen", keyword: "stam", from: "2010-01-01", to: null }]);
  });

  it("is complete only when nothing is missing and nothing stopped it", () => {
    const done = buildSweepEvidence({
      ranAt: "2026-10-18T20:00:00.000Z",
      keywords: ["stam"],
      substring: null,
      districts: ["Södermalm"],
      windows: [{ from: "1985-01-01", to: null }],
      collection: { leaves: [{ query: query("Södermalm", "stam", "1985-01-01", null), cases: [], headingCount: 0 }], splitParents: [], missing: [] },
      splits: [],
      requests: 1,
      seconds: [],
      stop: null,
    });
    expect(done.complete).toBe(true);
    expect(done.secondsMedian).toBeNull();
  });

  it("refuses a key that is not in the schema and carries no name, text or document key", () => {
    const e = evidence();
    expect(sweepEvidenceSchema.safeParse({ ...e, handler: "x" }).success).toBe(false);
    expect(sweepEvidenceSchema.safeParse({ ...e, totals: { ...e.totals, description: "x" } }).success).toBe(false);
    expect(JSON.stringify(e)).not.toMatch(/"(Handler|Documents|Description)"/);
  });

  it("renders plain Swedish with every stadsdel, the request count, the median and the sentence on the thin record", () => {
    const text = renderSweepMarkdown(evidence("http-429"));
    expect(text).toContain("Utfall: DELVIS, stoppat (http-429)");
    expect(text).toContain("| Södermalm |");
    expect(text).toContain("| Kungsholmen |");
    expect(text).toContain("9 anrop");
    expect(text).toContain("i median 2,1 sekunder");
    expect(text).toContain("okänd, inte utan stambyte");
    expect(text).toContain("Relining är 2 ärenden och räknas för sig");
    expect(text).toContain("Södermalm, \"stam\", 1985-01-01 till 2009-12-31 (antal)");
  });
});
