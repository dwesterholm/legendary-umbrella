import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSweep, normaliseAddressKey, saveSweep } from "@/lib/stockholm/bygglov-cache";
import { makeCityClient } from "@/lib/stockholm/bygglov-client";
import { makeFixtureFetch } from "@/lib/stockholm/fixture-fetch";
import {
  SWEEP_DISTRICTS,
  buildCaseIndex,
  classifySoldAddress,
  isStambyteCase,
  joinCounts,
  normaliseAddress,
  parseAddresses,
  shiftYears,
  stambyteAtSale,
  summariseCases,
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

  it("a case that carries both tags is a stambyte", () => {
    const both: StambyteCaseInput = { startDate: "2001-03-12", kinds: ["relining", "stambyte"] };
    expect(stambyteAtSale([both], "2022-06-01").recorded).toBe(true);
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
