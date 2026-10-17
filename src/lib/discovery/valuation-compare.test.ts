// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildValuationCompare,
  renderValuationCompareMd,
  type CompareColumnInput,
} from "@/lib/discovery/valuation-compare";
import { FOLKUNGAGATAN_61_BOOLI_ID, parseFitRunRecord, type FitRunRecord } from "@/lib/discovery/valuation-report";

/**
 * valuation-compare.test.ts - pins the 14.4 -> 14.5 comparison (Phase 14.5-03, R-02): records of model
 * version 1 and 2 both load, rows are joined by flat id (never by rank), the tracked flat leads the
 * report, and the known 14.4 movement (Folkungagatan 61, rank 29 -> 17) is reproduced from the two
 * committed run records.
 */

const BEFORE_14_4 = ".planning/phases/14.4-valuation-layout-livability/evidence/before/ranking.json";
const AFTER_14_4 = ".planning/phases/14.4-valuation-layout-livability/evidence/after/ranking.json";

function loadRecord(path: string): FitRunRecord {
  return parseFitRunRecord(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

interface RowSpec {
  readonly id: number | null;
  readonly address: string;
  readonly rank: number | null;
  readonly resale?: number | null;
  readonly profit?: number | null;
  readonly credit?: number | null;
}

/** One minimal, valid run-record row. */
function rowOf(spec: RowSpec): FitRunRecord["ranked"][number] {
  return {
    rank: spec.rank,
    key: `https://example.test/${spec.address.replace(/\s/g, "-")}`,
    booliId: spec.id,
    address: spec.address,
    district: "Södermalm",
    livingArea: 40,
    askingSek: 3_000_000,
    predKrPerSqm: null,
    askToPred: null,
    resaleSek: spec.resale === undefined ? 4_000_000 : spec.resale,
    purchaseSek: 3_500_000,
    overbidPct: null,
    gapSek: 100_000,
    creditSek: spec.credit === undefined ? 90_000 : spec.credit,
    profitSek: spec.profit === undefined ? 200_000 : spec.profit,
    renoSek: 0,
    tasteSek: 0,
    taxSek: 0,
    renoTier: "none",
    flags: [],
    featuresImputed: [],
    notComparableReason: spec.rank === null ? "saknar yta" : null,
  };
}

function recordOf(modelVersion: number, ranked: readonly RowSpec[], notComparable: readonly RowSpec[] = []): FitRunRecord {
  return parseFitRunRecord({
    version: 1,
    kind: "fit-replay",
    snapshotAsOf: "2026-10-13",
    snapshotFile: "snap.json",
    model: {
      version: modelVersion,
      asOf: "2026-10-12",
      n: 100,
      r2: 0.6,
      cvRmseLog: 0.115,
      residualSdLog: 0.115,
      bidPremiumKind: "slope",
    },
    sunLine: "Sol: test",
    ranked: ranked.map(rowOf),
    notComparable: notComparable.map(rowOf),
  });
}

function columns(...cols: [string, FitRunRecord][]): CompareColumnInput[] {
  return cols.map(([label, record]) => ({ label, record }));
}

describe("buildValuationCompare: the tracked flat", () => {
  it("joins rows by flat id, not by rank, and returns rank, resale, profit and credit per column", () => {
    const a = recordOf(1, [
      { id: 1, address: "Aaa 1", rank: 1 },
      { id: FOLKUNGAGATAN_61_BOOLI_ID, address: "Folkungagatan 61", rank: 2, resale: 5_000_000, profit: 700_000, credit: 650_000 },
    ]);
    const b = recordOf(2, [
      { id: FOLKUNGAGATAN_61_BOOLI_ID, address: "Folkungagatan 61", rank: 1, resale: 5_500_000, profit: 1_100_000, credit: 1_000_000 },
      { id: 1, address: "Aaa 1", rank: 2 },
    ]);
    const c = buildValuationCompare({ columns: columns(["a", a], ["b", b]), trackId: FOLKUNGAGATAN_61_BOOLI_ID });
    expect(c.tracked.map((t) => t.rank)).toEqual([2, 1]);
    expect(c.tracked[0]).toMatchObject({ label: "a", resaleSek: 5_000_000, profitSek: 700_000, creditSek: 650_000 });
    expect(c.tracked[1]).toMatchObject({ label: "b", resaleSek: 5_500_000, profitSek: 1_100_000, creditSek: 1_000_000 });
  });

  it("gives null for a flat that is missing from a column or not comparable in it", () => {
    const a = recordOf(1, [{ id: 1, address: "Aaa 1", rank: 1 }]);
    const b = recordOf(2, [{ id: 1, address: "Aaa 1", rank: 1 }], [
      { id: FOLKUNGAGATAN_61_BOOLI_ID, address: "Folkungagatan 61", rank: null, resale: null, profit: null, credit: null },
    ]);
    const c = buildValuationCompare({ columns: columns(["a", a], ["b", b]), trackId: FOLKUNGAGATAN_61_BOOLI_ID });
    expect(c.tracked).toEqual([
      { label: "a", rank: null, resaleSek: null, profitSek: null, creditSek: null },
      { label: "b", rank: null, resaleSek: null, profitSek: null, creditSek: null },
    ]);
  });

  it("falls back to the row key when a row has no Booli id", () => {
    const a = recordOf(1, [
      { id: null, address: "Utan id 1", rank: 1 },
      { id: null, address: "Utan id 2", rank: 2 },
    ]);
    const b = recordOf(2, [
      { id: null, address: "Utan id 2", rank: 1 },
      { id: null, address: "Utan id 1", rank: 2 },
    ]);
    const c = buildValuationCompare({ columns: columns(["a", a], ["b", b]), trackId: 1 });
    expect(c.moves.map((m) => [m.address, m.from, m.to, m.move])).toEqual([
      ["Utan id 2", 2, 1, 1],
      ["Utan id 1", 1, 2, -1],
    ]);
  });

  it("accepts records of model version 1 and version 2 in the same comparison", () => {
    const a = recordOf(1, [{ id: 1, address: "Aaa 1", rank: 1 }]);
    const b = recordOf(2, [{ id: 1, address: "Aaa 1", rank: 1 }]);
    expect(() => buildValuationCompare({ columns: columns(["a", a], ["b", b]), trackId: 1 })).not.toThrow();
  });

  it("refuses fewer than two columns", () => {
    const a = recordOf(1, [{ id: 1, address: "Aaa 1", rank: 1 }]);
    expect(() => buildValuationCompare({ columns: columns(["a", a]), trackId: 1 })).toThrow(/minst två/);
  });
});

describe("buildValuationCompare: top list and moves", () => {
  const many = (order: number[]): RowSpec[] => order.map((id, i) => ({ id, address: `Gata ${id}`, rank: i + 1 }));

  it("lists the top 15 of every column", () => {
    const ids = Array.from({ length: 20 }, (_, i) => i + 1);
    const a = recordOf(1, many(ids));
    const b = recordOf(2, many([...ids].reverse()));
    const c = buildValuationCompare({ columns: columns(["a", a], ["b", b]), trackId: 1 });
    expect(c.top).toHaveLength(2);
    expect(c.top[0].rows).toHaveLength(15);
    expect(c.top[0].rows[0]).toMatchObject({ rank: 1, address: "Gata 1" });
    expect(c.top[1].rows[0]).toMatchObject({ rank: 1, address: "Gata 20" });
  });

  it("returns the 10 largest absolute rank moves between the first and the last column, climbers positive", () => {
    const ids = Array.from({ length: 20 }, (_, i) => i + 1);
    const a = recordOf(1, many(ids));
    const b = recordOf(2, many([...ids].reverse()));
    const c = buildValuationCompare({ columns: columns(["a", a], ["b", b]), trackId: 1 });
    expect(c.moves).toHaveLength(10);
    // Equal size: the flat that ends higher up comes first.
    expect(c.moves[0]).toMatchObject({ from: 20, to: 1, move: 19 });
    expect(c.moves[1]).toMatchObject({ from: 1, to: 20, move: -19 });
    const abs = c.moves.map((m) => Math.abs(m.move));
    expect([...abs].sort((x, y) => y - x)).toEqual(abs);
  });

  it("ignores a middle column when measuring moves, and keeps its rank in each move", () => {
    const first = recordOf(1, many([1, 2, 3]));
    const mid = recordOf(2, many([3, 2, 1]));
    const last = recordOf(2, many([2, 3, 1]));
    const c = buildValuationCompare({ columns: columns(["a", first], ["m", mid], ["z", last]), trackId: 1 });
    const one = c.moves.find((m) => m.address === "Gata 1");
    expect(one).toMatchObject({ from: 1, to: 3, move: -2, ranks: [1, 3, 3] });
  });
});

describe("renderValuationCompareMd", () => {
  it("starts with the title, the offline line and then the tracked flat section with its rank line", () => {
    const a = recordOf(1, [
      { id: 1, address: "Aaa 1", rank: 1 },
      { id: FOLKUNGAGATAN_61_BOOLI_ID, address: "Folkungagatan 61", rank: 2, resale: 5_006_593.6, profit: 778_545.1, credit: 732_012.2 },
    ]);
    const b = recordOf(2, [
      { id: FOLKUNGAGATAN_61_BOOLI_ID, address: "Folkungagatan 61", rank: 1, resale: 5_503_112.9, profit: 1_123_047.1, credit: 1_061_486.2 },
      { id: 1, address: "Aaa 1", rank: 2 },
    ]);
    const md = renderValuationCompareMd(
      buildValuationCompare({ columns: columns(["14.4 (före)", a], ["14.4 (efter)", b]), trackId: FOLKUNGAGATAN_61_BOOLI_ID }),
    );
    const lines = md.split("\n").filter((l) => l.trim() !== "");
    expect(lines[0].startsWith("# ")).toBe(true);
    expect(lines[1]).toBe("Offline: inget nätverk, ingen API-nyckel, inget betalt anrop.");
    expect(lines[2]).toBe("## Folkungagatan 61 (150148)");
    expect(lines[3]).toBe("plats 2 → 1");
    expect(md).toContain("5 503 113 kr");
    expect(md).toContain("1 123 047 kr");
  });

  it("writes the rank line with an intermediate column as plats a → b → c", () => {
    const mk = (rank: number): FitRunRecord =>
      recordOf(2, [
        { id: 7, address: "Andra 7", rank: rank === 1 ? 2 : 1 },
        { id: FOLKUNGAGATAN_61_BOOLI_ID, address: "Folkungagatan 61", rank },
      ]);
    // rank 1 in the record means Folkungagatan sits first; the other flat takes the other place.
    const md = renderValuationCompareMd(
      buildValuationCompare({
        columns: columns(["a", mk(2)], ["b", mk(2)], ["c", mk(1)]),
        trackId: FOLKUNGAGATAN_61_BOOLI_ID,
      }),
    );
    expect(md).toContain("plats 2 → 2 → 1");
  });

  it("prints percentages with a decimal comma and money with a space as thousands separator", () => {
    const a = recordOf(1, [{ id: 1, address: "Aaa 1", rank: 1, profit: 1_234_567, resale: 12_345_678 }]);
    const b = recordOf(2, [{ id: 1, address: "Aaa 1", rank: 1, profit: -2_500, resale: 999 }]);
    const md = renderValuationCompareMd(buildValuationCompare({ columns: columns(["a", a], ["b", b]), trackId: 1 }));
    expect(md).toContain("1 234 567 kr");
    expect(md).toContain("12 345 678 kr");
    expect(md).toContain("-2 500 kr");
    expect(md).toContain("999 kr");
    expect(md).not.toMatch(/\d,\d{3} kr/);
  });
});

describe("tool check on the committed 14.4 records", () => {
  it("reproduces Folkungagatan 61 moving from rank 29 to 17", () => {
    const c = buildValuationCompare({
      columns: columns(["14.4 (före)", loadRecord(BEFORE_14_4)], ["14.4 (efter)", loadRecord(AFTER_14_4)]),
      trackId: FOLKUNGAGATAN_61_BOOLI_ID,
    });
    expect(c.tracked.map((t) => t.rank)).toEqual([29, 17]);
    expect(c.tracked[1].profitSek).toBeCloseTo(1_123_047, 0);
    expect(c.tracked[1].resaleSek).toBeCloseTo(5_503_113, 0);
    const md = renderValuationCompareMd(c);
    expect(md).toContain("plats 29 → 17");
    expect(md).toContain("Folkungagatan 61 (150148)");
  });
});
