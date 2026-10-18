import { describe, expect, it } from "vitest";
import {
  YEARS_CLASSES,
  addressesToAsk,
  buildJoinEvidence,
  buildJoinRows,
  casesOfBuilding,
  detailCandidates,
  groupCounts,
  joinEvidenceSchema,
  joinLine,
  planAddresses,
  renderJoinMarkdown,
  renderJoinReport,
  sampleOutcome,
  seededSample,
  soldAddressKey,
  summariseJoin,
  unidentifiedRows,
  yearsClass,
  type JoinDetail,
  parseJoinDetails,
  type LookupAnswer,
  type SoldInput,
} from "@/lib/discovery/sold-join";
import { buildCaseIndex, type IndexableCase } from "@/lib/discovery/stambyte-join";

const kase = (rec: string, beteckning: string, addresses: string[], startDate: string, kinds: string[] = ["stambyte"], archived = true): IndexableCase => ({
  rec,
  beteckning,
  addresses,
  startDate,
  kinds,
  archived,
});

const CASES: IndexableCase[] = [
  kase("1", "Skrovet 8", ["Slipgatan 11"], "1998-05-01"),
  kase("2", "Skrovet 8", ["Slipgatan 13"], "2021-03-01", ["stambyte"], false),
  kase("3", "Ormen 2", ["Bondegatan 1F"], "2001-01-01"),
  kase("4", "Hornen 4", ["Hornsgatan 40"], "1995-01-01"),
  kase("5", "Hornen 5", ["Hornsgatan 40"], "1996-01-01", ["annat"]),
  kase("6", "Linet 3", ["Zinkens väg 5"], "2005-01-01", ["relining"]),
  kase("7", "Planet 1", ["Skånegatan 76"], "2003-01-01", ["annat"]),
];
const index = buildCaseIndex(CASES);

const sold = (booliId: string, address: string, district = "Södermalm", soldDate = "2025-06-01"): SoldInput => ({ booliId, address, district, soldDate });

const SOLD: SoldInput[] = [
  sold("a", "Slipgatan 11"), // exact, one beteckning
  sold("b", "Slipgatan 11"), // same address, second flat
  sold("c", "Bondegatan 1"), // letter variant of Bondegatan 1F
  sold("d", "Hornsgatan 40"), // exact but two beteckningar
  sold("e", "Skånegatan 74"), // near Skånegatan 76
  sold("f", "Götgatan 94"), // none, has a number
  sold("g", "Lützengatan"), // no number
  sold("h", "Zinkens väg 5"), // relining only
  sold("i", "Slipgatan 13"), // exact, case started after sale date below
];

describe("soldAddressKey", () => {
  it("closes up the entrance letter and lower-cases", () => {
    expect(soldAddressKey("Valhallavägen 148 B")).toBe("valhallavägen 148b");
    expect(soldAddressKey("Torsgatan 48 A, lgh 1203")).toBe("torsgatan 48a");
  });
});

describe("planAddresses", () => {
  const plans = planAddresses(SOLD, index);

  it("counts sold rows per distinct address", () => {
    expect(plans.get("slipgatan 11")?.rows).toBe(2);
    expect(plans.size).toBe(8);
  });

  it("identifies an exact and a letter match free, when the cases name one beteckning", () => {
    expect(plans.get("slipgatan 11")).toMatchObject({ group: "exact", freeStage: "A", freeBeteckning: "Skrovet 8", asks: null });
    expect(plans.get("bondegatan 1")).toMatchObject({ group: "letter", freeStage: "A+", freeBeteckning: "Ormen 2" });
  });

  it("never links on a guess: two beteckningar under one address go to the address search", () => {
    expect(plans.get("hornsgatan 40")).toMatchObject({ group: "exact", freeStage: null, freeBeteckning: null, asks: "B" });
  });

  it("sends the near class to B, the rest with a number to C and never asks an address with no number", () => {
    expect(plans.get("skånegatan 74")).toMatchObject({ group: "near", asks: "B" });
    expect(plans.get("götgatan 94")).toMatchObject({ group: "none", asks: "C" });
    expect(plans.get("lützengatan")).toMatchObject({ group: "nonumber", asks: null });
    expect(addressesToAsk(plans, "B")).toEqual(["hornsgatan 40", "skånegatan 74"]);
    expect(addressesToAsk(plans, "C")).toEqual(["götgatan 94"]);
  });

  it("keeps the sold set's own spelling for the question", () => {
    expect(plans.get("götgatan 94")?.asked).toBe("Götgatan 94");
  });

  it("counts addresses and rows per group", () => {
    const g = groupCounts(plans);
    expect(g.addresses).toMatchObject({ exact: 4, letter: 1, near: 1, none: 1, nonumber: 1 });
    expect(g.rows.exact).toBe(5);
  });
});

describe("seededSample", () => {
  const items = Array.from({ length: 300 }, (_, i) => `adress ${i}`);

  it("is the same sample for the same seed, whatever order the input has", () => {
    expect(seededSample(items, 100, 14)).toEqual(seededSample([...items].reverse(), 100, 14));
  });

  it("draws without replacement and differs between seeds", () => {
    const a = seededSample(items, 100, 14);
    expect(new Set(a).size).toBe(100);
    expect(a).not.toEqual(seededSample(items, 100, 15));
  });

  it("returns everything when the population is smaller", () => {
    expect(seededSample(["x", "y"], 100, 14).sort()).toEqual(["x", "y"]);
  });
});

describe("buildJoinRows", () => {
  const plans = planAddresses(SOLD, index);
  const answers: Record<string, LookupAnswer> = {
    "skånegatan 74": { beteckning: "Planet 1", status: "resolved" },
    "hornsgatan 40": { beteckning: null, status: "ambiguous" },
    "götgatan 94": { beteckning: "Droskhästen 8", status: "resolved" },
  };
  const rows = buildJoinRows(SOLD, index, plans, (k) => answers[k], new Map());

  it("labels the stage that identified the building", () => {
    expect(rows.a).toMatchObject({ stage: "A", beteckning: "Skrovet 8", addressKey: "slipgatan 11" });
    expect(rows.c).toMatchObject({ stage: "A+", beteckning: "Ormen 2" });
    expect(rows.e).toMatchObject({ stage: "B", beteckning: "Planet 1" });
    expect(rows.f).toMatchObject({ stage: "C", beteckning: "Droskhästen 8" });
  });

  it("leaves an ambiguous answer, an unanswered address and an address with no number unidentified", () => {
    expect(rows.d).toMatchObject({ stage: null, beteckning: null, cases: [] });
    expect(rows.g.stage).toBeNull();
  });

  it("carries the stambyte and relining cases of the building, never the other kinds", () => {
    expect(rows.a.cases.map((c) => c.rec)).toEqual(["1", "2"]);
    expect(rows.e.cases).toEqual([]);
    expect(rows.h.cases.map((c) => c.kinds)).toEqual([["relining"]]);
  });

  it("an identified building with no stambyte case is joined, with an empty case list", () => {
    expect(rows.e.beteckning).not.toBeNull();
    expect(rows.f.cases).toEqual([]);
  });

  it("merges the detail dates onto the case", () => {
    const details = new Map<string, JoinDetail>([["2", { startbeskedDate: "2021-04-01", slutbeskedDate: "2022-01-10", latest: { type: "Slutbesked", code: null } }]]);
    const cases = casesOfBuilding("Skrovet 8", index, details);
    expect(cases.find((c) => c.rec === "2")).toMatchObject({ startbeskedDate: "2021-04-01", slutbeskedDate: "2022-01-10", latest: { type: "Slutbesked", code: null } });
    expect(cases.find((c) => c.rec === "1")).toMatchObject({ startbeskedDate: null, slutbeskedDate: null, latest: null });
  });
});

describe("yearsClass", () => {
  it("cuts at the plan's edges", () => {
    const at = (n: number) => yearsClass(n);
    expect([at(0), at(5), at(6), at(10), at(11), at(15), at(16), at(25), at(26), at(40), at(41)]).toEqual([
      "0-5",
      "0-5",
      "6-10",
      "6-10",
      "11-15",
      "11-15",
      "16-25",
      "16-25",
      "26-40",
      "26-40",
      "over 40",
    ]);
    expect(at(-1)).toBeNull();
  });
});

describe("summariseJoin", () => {
  const plans = planAddresses(SOLD, index);
  const rows = buildJoinRows(SOLD, index, plans, () => undefined, new Map());
  const s = summariseJoin(SOLD, rows);

  it("counts the join per district and in total", () => {
    expect(s.total.rows).toBe(9);
    expect(s.total.identified).toBe(5); // a, b, c, h (relining building), i
    expect(s.total.joinRatePct).toBe(55.6);
    expect(s.byDistrict["Södermalm"].rows).toBe(9);
    expect(s.total.stageA).toBe(4);
    expect(s.total.stageAplus).toBe(1);
    expect(s.total.addresses).toBe(8);
  });

  it("counts a stambyte recorded before the sale by years, from the sale date", () => {
    // a, b, i: Skrovet 8, latest case started 2021 (no slutbesked, 3 years passed) -> 4 years; c: Ormen 2, 2001 -> 24 years
    expect(s.total.recordedBeforeSale).toBe(4);
    expect(s.total.yearsBefore).toMatchObject({ "0-5": 3, "16-25": 1, "26-40": 0 });
  });

  it("shows a case that started after the sale as future, never as past", () => {
    const early = [sold("a", "Slipgatan 13", "Södermalm", "2020-01-01")];
    const r = buildJoinRows(early, index, planAddresses(early, index), () => undefined, new Map());
    const t = summariseJoin(early, r).total;
    expect(t.futureAtSale).toBe(1);
    expect(t.recordedBeforeSale).toBe(1); // Skrovet 8 also has the 1998 case
  });

  it("never counts relining as a stambyte", () => {
    expect(s.total.reliningOnly).toBe(1);
    expect(s.total.inStambyteBuilding).toBe(4);
    const only = [sold("h", "Zinkens väg 5")];
    const t = summariseJoin(only, buildJoinRows(only, index, planAddresses(only, index), () => undefined, new Map())).total;
    expect(t).toMatchObject({ identified: 1, reliningOnly: 1, inStambyteBuilding: 0, recordedBeforeSale: 0 });
  });
});

describe("sampleOutcome", () => {
  it("counts a hit only when the building has a stambyte case", () => {
    const answers: Record<string, LookupAnswer> = {
      a: { beteckning: "Skrovet 8", status: "resolved" },
      b: { beteckning: "Planet 1", status: "resolved" }, // only an "annat" case
      c: { beteckning: null, status: "no_candidates" },
    };
    expect(sampleOutcome(["a", "b", "c", "d"], (k) => answers[k], index)).toEqual({ asked: 4, answered: 3, resolved: 2, hits: 1 });
  });
});

describe("unidentifiedRows", () => {
  it("says why a row has no building", () => {
    const plans = planAddresses(SOLD, index);
    const answers: Record<string, LookupAnswer> = {
      "hornsgatan 40": { beteckning: null, status: "ambiguous" },
      "götgatan 94": { beteckning: null, status: "no_candidates" },
    };
    const lookup = (k: string) => answers[k];
    const rows = buildJoinRows(SOLD, index, plans, lookup, new Map());
    // d: ambiguous, e: not asked yet, f: no candidates, g: no number
    expect(unidentifiedRows(SOLD, rows, plans, lookup)).toEqual({ noNumber: 1, ambiguous: 1, noCandidates: 1, notAsked: 1 });
  });
});

describe("detailCandidates", () => {
  it("picks stambyte cases from the year on, once per case, oldest first, within the cap", () => {
    const plans = planAddresses(SOLD, index);
    const rows = buildJoinRows(SOLD, index, plans, () => undefined, new Map());
    const all = detailCandidates(rows, index, 2019, new Set(), 80);
    expect(all.wanted).toBe(1);
    expect(all.take).toEqual([{ rec: "2", archived: false }]);
    expect(detailCandidates(rows, index, 2019, new Set(["2"]), 80).take).toEqual([]);
    expect(detailCandidates(rows, index, 2019, new Set(), 0).take).toEqual([]);
    expect(detailCandidates(rows, index, 2022, new Set(), 80).wanted).toBe(0);
  });
});

describe("the evidence", () => {
  const plans = planAddresses(SOLD, index);
  const rows = buildJoinRows(SOLD, index, plans, () => undefined, new Map());
  const summary = summariseJoin(SOLD, rows);
  const input = {
    ranAt: "2026-10-18T20:00:00.000Z",
    soldAsOf: "2026-10-12",
    summary,
    groups: groupCounts(plans),
    requests: {
      perStage: { B: 2, "C-sample": 1, C: 0, detail: 1 },
      secondsPerStage: { B: 8, "C-sample": 4, C: 0, detail: 4 },
      medianSecondsPerRequest: 3.2,
    },
    sample: { ran: true, size: 100, seed: 14, answered: 100, resolved: 40, hits: 3, threshold: 5 },
    stageC: { run: false, decision: "Steg C kördes inte. Stickprovet gav 3 träffar av 100, gränsen är 5.", addressesTotal: 1, addressesAnswered: 0 },
    stageB: { addressesTotal: 2, addressesAnswered: 2, resolved: 1 },
    unidentified: { noNumber: 1, ambiguous: 1, noCandidates: 0, notAsked: 2 },
    detail: { wanted: 1, read: 1, cap: 80 },
    stop: null,
  };
  const evidence = buildJoinEvidence(input);

  it("passes its own strict schema and carries the years classes", () => {
    expect(joinEvidenceSchema.safeParse(evidence).success).toBe(true);
    for (const k of YEARS_CLASSES) expect(k in evidence.yearsBefore).toBe(true);
    expect(evidence.requests.total).toBe(4);
  });

  it("refuses a key that is not a count, so an address cannot be written", () => {
    expect(joinEvidenceSchema.safeParse({ ...evidence, address: "Slipgatan 11" }).success).toBe(false);
    expect(joinEvidenceSchema.safeParse({ ...evidence, total: { ...evidence.total, addresses: "Slipgatan 11" } }).success).toBe(false);
    expect(joinEvidenceSchema.safeParse({ ...evidence, districts: { Södermalm: { ...evidence.total, handler: "x" } } }).success).toBe(false);
  });

  it("prints the join line in the pinned shape and a line per district", () => {
    const lines = renderJoinReport(evidence);
    expect(lines[0]).toMatch(/^Kopplade sålda rader: [0-9 ]+ av [0-9 ]+ \([0-9]+,[0-9] %\)$/);
    expect(lines[0]).toBe("Kopplade sålda rader: 5 av 9 (55,6 %)");
    expect(lines.some((l) => l.includes("Södermalm"))).toBe(true);
    expect(joinLine({ identified: 3112, rows: 7431, joinRatePct: 41.9 })).toBe("Kopplade sålda rader: 3 112 av 7 431 (41,9 %)");
  });

  it("writes plain Swedish with the decision, the classes and what the join cannot see, and no address", () => {
    const md = renderJoinMarkdown(evidence);
    expect(md).toContain("Kopplade sålda rader: 5 av 9");
    expect(md).toContain("Stickprov ingen-klassen: 3 av 100 träffar");
    expect(md).toContain("Steg C kördes inte");
    expect(md).toContain("Vad kopplingen inte ser");
    expect(md).toContain("Rader som inte knöts till något hus: 4");
    expect(md).toContain("| över 40 |");
    expect(md).toContain("Klassen 0 till 5 år når inte 30 rader");
    expect(md).not.toMatch(/slipgatan|bondegatan/i);
    expect(JSON.stringify(evidence)).not.toMatch(/slipgatan|bondegatan|hornsgatan/i);
  });
});

describe("parseJoinDetails (WR-15: the detail file is validated like every other cache file)", () => {
  const good = { startbeskedDate: "2021-04-01", slutbeskedDate: null, latest: { type: "Startbesked", code: null } };

  it("keeps good entries and drops (and counts) bad ones: a wrong shape, an extra key, a bad date, a rec that is not digits", () => {
    const { details, dropped } = parseJoinDetails({
      schemaVersion: 1,
      details: {
        "100": good,
        "101": { ...good, startbeskedDate: "tomorrow" },
        "102": { ...good, officer: "Anna" },
        "103": "text",
        "../x": good,
        "104": { startbeskedDate: null, slutbeskedDate: "2022-01-10", latest: null },
      },
    });
    expect([...details.keys()]).toEqual(["100", "104"]);
    expect(dropped).toBe(4);
  });

  it("gives nothing for a file that is not an object with a details record", () => {
    for (const raw of [null, 5, "x", [], { details: [] }, { details: "x" }, {}]) {
      expect(parseJoinDetails(raw)).toEqual({ details: new Map(), dropped: 0 });
    }
  });
});
