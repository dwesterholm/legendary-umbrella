// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STAGE2_CAP_PCT } from "@/lib/discovery/hedonic-model";
import {
  buildValuationCompare,
  capDecision,
  capStepNeeded,
  fitReportJsonSchema,
  modelCoefficientsOf,
  onStage2Cap,
  renderValuationCompareMd,
  stage2CapOf,
  type CompareColumnInput,
  type FitReport,
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

// ---------------------------------------------------------------------------
// Task 2: coefficients with SE, stage 2 against each model's own cap, the fit-report schema, R-01
// ---------------------------------------------------------------------------

type BucketKey = "le1930" | "y1931to1960" | "y1961to1990" | "ge1991";

/** A lenient model file: only what the comparison reads. */
function modelFile(opts: {
  features?: { name: string; beta: number; se?: number | null }[];
  capPct?: number;
  balcony?: number;
  buckets?: Record<BucketKey, number>;
  version?: number;
}): Record<string, unknown> {
  const stage2: Record<string, unknown> = {};
  if (opts.capPct !== undefined) stage2.capPct = opts.capPct;
  if (opts.balcony !== undefined) stage2.balcony = { pct: opts.balcony, source: "fit" };
  if (opts.buckets !== undefined) stage2.buildYear = { pctByBucket: opts.buckets, source: "fit" };
  return {
    version: opts.version ?? 2,
    features: opts.features,
    stage2: opts.balcony === undefined && opts.buckets === undefined && opts.capPct === undefined ? undefined : stage2,
  };
}

function bucketsOf(le1930: number, a: number, b: number, ge1991: number): Record<BucketKey, number> {
  return { le1930, y1931to1960: a, y1961to1990: b, ge1991 };
}

function fitReportOf(opts: {
  cap: number;
  cv: { without: number; c8: number; c12: number };
  onCap?: string[];
  balconyRaw?: number;
  avgiftDebt?: number | null;
}): FitReport {
  const bucket = (pctRaw: number) => ({ n: 120, pctRaw, seApprox: 0.012, pct: Math.max(-opts.cap, Math.min(opts.cap, pctRaw)) });
  return fitReportJsonSchema.parse({
    version: 1,
    capPct: opts.cap,
    n: 5400,
    r2: 0.62,
    cvRmseLog: 0.114,
    enrichedRows: 4100,
    stage2: {
      n: 1395,
      capPct: opts.cap,
      balcony: {
        gamma: 0.07,
        se: 0.009,
        pctRaw: opts.balconyRaw ?? 0.077,
        pct: Math.min(opts.cap, opts.balconyRaw ?? 0.077),
        source: "fit",
      },
      buckets: {
        le1930: bucket(0.03),
        y1931to1960: bucket(-0.02),
        y1961to1990: bucket(-0.108),
        ge1991: bucket(-0.04),
      },
      onCap: opts.onCap ?? [],
      cv: { without: opts.cv.without, byCap: { "0.08": opts.cv.c8, "0.12": opts.cv.c12 } },
    },
    correlation: { avgiftDebt: opts.avgiftDebt === undefined ? 0.42 : opts.avgiftDebt, rows: 4100 },
    ceiling: { soldRowsWithHeight: 0, fitted: false, reason: "sålda sidor har ingen annonstext, R-03" },
  });
}

describe("modelCoefficientsOf and stage2CapOf", () => {
  it("reads features with SE and the stage-2 values of a model file", () => {
    const raw = modelFile({
      features: [
        { name: "nbLevel", beta: 1.0663, se: 0.0119 },
        { name: "floor", beta: 0.0151, se: null },
      ],
      capPct: 0.12,
      balcony: 0.1,
      buckets: bucketsOf(0.03, -0.02, -0.11, -0.04),
    });
    const m = modelCoefficientsOf(raw);
    expect(m.features).toEqual([
      { name: "nbLevel", beta: 1.0663, se: 0.0119 },
      { name: "floor", beta: 0.0151, se: null },
    ]);
    expect(m.stage2).toEqual({ capPct: 0.12, balcony: 0.1, buildYear: bucketsOf(0.03, -0.02, -0.11, -0.04) });
  });

  it("loads a version-1 file with no stage2 and a file with no features", () => {
    expect(modelCoefficientsOf({ version: 1, features: [{ name: "a", beta: 1, se: 0.1 }] }).stage2).toEqual({
      capPct: STAGE2_CAP_PCT,
      balcony: null,
      buildYear: null,
    });
    expect(modelCoefficientsOf({ version: 1 }).features).toEqual([]);
  });

  it("loads a file with stage2 but no capPct and reads the cap as 0,08", () => {
    const m = modelCoefficientsOf(modelFile({ balcony: 0.08 }));
    expect(m.stage2.capPct).toBe(0.08);
  });

  it("refuses a file whose features are not a list", () => {
    expect(() => modelCoefficientsOf({ features: "nej" })).toThrow();
  });

  it("stage2CapOf is capPct when it is a number, else the default", () => {
    expect(stage2CapOf({ stage2: { capPct: 0.12 } })).toBe(0.12);
    expect(stage2CapOf({ stage2: {} })).toBe(STAGE2_CAP_PCT);
    expect(stage2CapOf({ stage2: { capPct: "0.12" } })).toBe(STAGE2_CAP_PCT);
    expect(stage2CapOf({})).toBe(STAGE2_CAP_PCT);
    expect(stage2CapOf(null)).toBe(STAGE2_CAP_PCT);
  });
});

describe("onStage2Cap", () => {
  it("judges a value against the model's own cap", () => {
    expect(onStage2Cap(0.08, 0.08)).toBe(true);
    expect(onStage2Cap(-0.08, 0.08)).toBe(true);
    expect(onStage2Cap(0.08, 0.12)).toBe(false);
    expect(onStage2Cap(-0.12, 0.12)).toBe(true);
    expect(onStage2Cap(0.0799, 0.08)).toBe(false);
  });
});

describe("fitReportJsonSchema", () => {
  const good = (): Record<string, unknown> =>
    JSON.parse(JSON.stringify(fitReportOf({ cap: 0.08, cv: { without: 0.12, c8: 0.11, c12: 0.109 } }))) as Record<string, unknown>;

  it("accepts a full report, nullable SE and correlation included", () => {
    expect(fitReportJsonSchema.safeParse(good()).success).toBe(true);
    const g = good() as { stage2: { balcony: { se: number | null } }; correlation: { avgiftDebt: number | null } };
    g.stage2.balcony.se = null;
    g.correlation.avgiftDebt = null;
    expect(fitReportJsonSchema.safeParse(g).success).toBe(true);
  });

  it("rejects a report missing one of the two cap cross-validation numbers", () => {
    const g = good() as { stage2: { cv: { byCap: Record<string, number> } } };
    delete g.stage2.cv.byCap["0.12"];
    expect(fitReportJsonSchema.safeParse(g).success).toBe(false);
  });

  it("rejects a balcony source that is neither fit nor prior", () => {
    const g = good() as { stage2: { balcony: { source: string } } };
    g.stage2.balcony.source = "gissning";
    expect(fitReportJsonSchema.safeParse(g).success).toBe(false);
  });
});

describe("capStepNeeded and capDecision (D-03, R-01)", () => {
  it("is needed exactly when something sits on the +-8 % limit", () => {
    expect(capStepNeeded(fitReportOf({ cap: 0.08, cv: { without: 0.12, c8: 0.11, c12: 0.11 }, onCap: ["balkong +8,0 %"] }))).toBe(true);
    expect(capStepNeeded(fitReportOf({ cap: 0.08, cv: { without: 0.12, c8: 0.11, c12: 0.11 }, onCap: [] }))).toBe(false);
  });

  it("chooses +-12 % when its cross-validation error is lower", () => {
    const d = capDecision(0.11, 0.1);
    expect(d.chosen).toBe(0.12);
    expect(d).toMatchObject({ cv8: 0.11, cv12: 0.1 });
  });

  it("chooses +-12 % on an exact tie (R-01: not worse)", () => {
    expect(capDecision(0.11, 0.11).chosen).toBe(0.12);
  });

  it("keeps +-8 % when +-12 % is worse, however slightly", () => {
    expect(capDecision(0.11, 0.110001).chosen).toBe(0.08);
  });

  it("prints both numbers in the verdict", () => {
    const d = capDecision(0.11234, 0.10567);
    expect(d.verdict).toContain("0,11234");
    expect(d.verdict).toContain("0,10567");
    expect(d.verdict).toContain("±12 %");
  });
});

describe("the report with models and fit reports", () => {
  const rec = (v: number) =>
    recordOf(v, [
      { id: 1, address: "Aaa 1", rank: 1 },
      { id: FOLKUNGAGATAN_61_BOOLI_ID, address: "Folkungagatan 61", rank: 2, resale: 5_000_000 },
    ]);
  const feats = (beta: number) => [
    { name: "nbLevel", beta, se: 0.0119 },
    { name: "floor", beta: 0.0151, se: 0.0009 },
  ];

  it("lists every feature as beta +- SE per column, and '-' for a feature a model does not have", () => {
    const before = modelFile({ version: 1, features: feats(1.0663) });
    const after = modelFile({
      features: [...feats(1.07), { name: "debtPerSqm", beta: -0.002, se: 0.0004 }],
      balcony: 0.08,
      buckets: bucketsOf(0.03, -0.02, -0.08, -0.04),
    });
    const md = renderValuationCompareMd(
      buildValuationCompare({
        columns: [
          { label: "före", record: rec(1), model: before },
          { label: "efter", record: rec(2), model: after },
        ],
        trackId: FOLKUNGAGATAN_61_BOOLI_ID,
      }),
    );
    expect(md).toContain("## Koefficienter (steg 1)");
    expect(md).toMatch(/\| nbLevel \| 1,066 ± 0,01190 \| 1,070 ± 0,01190 \|/);
    expect(md).toMatch(/\| debtPerSqm \| - \| -0,002000 ± 0,0004000 \|/);
  });

  it("marks a value 'på taket' against the model's own cap: 8 % is on the cap for a 0,08 model, not for a 0,12 model", () => {
    const m8 = modelFile({ features: feats(1), balcony: 0.08, buckets: bucketsOf(0.03, -0.02, -0.08, -0.04) });
    const m12 = modelFile({ features: feats(1), capPct: 0.12, balcony: 0.08, buckets: bucketsOf(0.03, -0.02, -0.1, -0.12) });
    const c = buildValuationCompare({
      columns: [
        { label: "åtta", record: rec(2), model: m8 },
        { label: "tolv", record: rec(2), model: m12 },
      ],
      trackId: FOLKUNGAGATAN_61_BOOLI_ID,
    });
    const md = renderValuationCompareMd(c);
    expect(md).toContain("## Steg 2");
    const balcony = md.split("\n").find((l) => l.startsWith("| Balkong |"));
    expect(balcony).toContain("+8,0 % (på taket ±8 %)");
    expect(balcony?.split("|")[3]).not.toContain("på taket");
    const old = md.split("\n").find((l) => l.startsWith("| Byggår 1961–1990 |"));
    expect(old).toContain("-8,0 % (på taket ±8 %)");
    const newest = md.split("\n").find((l) => l.startsWith("| Byggår från 1991 |"));
    expect(newest).toContain("-12,0 % (på taket ±12 %)");
  });

  it("shows raw stage-2 values with SE for columns that have a fit report, '-' for the rest, and a footnote", () => {
    const m = modelFile({ features: feats(1), balcony: 0.08, buckets: bucketsOf(0.03, -0.02, -0.08, -0.04) });
    const report = fitReportOf({ cap: 0.08, cv: { without: 0.12, c8: 0.11, c12: 0.109 }, onCap: ["balkong +8,0 %"], balconyRaw: 0.103 });
    const md = renderValuationCompareMd(
      buildValuationCompare({
        columns: [
          { label: "före", record: rec(1), model: m },
          { label: "efter", record: rec(2), model: m, fitReport: report },
        ],
        trackId: FOLKUNGAGATAN_61_BOOLI_ID,
      }),
    );
    const raw = md.split("\n").find((l) => l.startsWith("| Balkong, rått värde |"));
    expect(raw).toBeDefined();
    expect(raw).toContain("| - |");
    expect(raw).toContain("+10,3 %");
    expect(raw).toContain("SE 0,9");
    expect(md).toContain("14.4 räknade ingen steg-2-SE");
  });

  it("adds the R-01 section with both cross-validation numbers, the stage-1 note, the correlation and the ceiling line", () => {
    const report = fitReportOf({ cap: 0.08, cv: { without: 0.12, c8: 0.1123, c12: 0.1101 }, onCap: ["balkong +8,0 %"] });
    const c = buildValuationCompare({
      columns: [
        { label: "före", record: rec(1) },
        { label: "efter", record: rec(2), fitReport: report },
      ],
      trackId: FOLKUNGAGATAN_61_BOOLI_ID,
    });
    expect(c.capDecision).toMatchObject({ chosen: 0.12, cv8: 0.1123, cv12: 0.1101 });
    expect(c.capStepNeeded).toBe(true);
    const md = renderValuationCompareMd(c);
    expect(md).toContain("## Takbeslut (R-01)");
    expect(md).toContain("0,11230");
    expect(md).toContain("0,11010");
    expect(md).toContain("0,12000");
    expect(md).toContain("kan inte skilja ±8 % från ±12 %");
    expect(md).toContain("Korrelation avgift/kvm och skuld/kvm: 0,42 (n = 4 100)");
    expect(md).toContain("Takhöjd: 0 sålda rader med angiven höjd; ej anpassad (sålda sidor har ingen annonstext, R-03)");
    expect(md).toContain("±8 %: balkong +8,0 %");
  });

  it("has no decision section and a null capDecision without a fit report", () => {
    const c = buildValuationCompare({
      columns: [
        { label: "före", record: rec(1), model: modelFile({ features: feats(1) }) },
        { label: "efter", record: rec(2), model: modelFile({ features: feats(1) }) },
      ],
      trackId: FOLKUNGAGATAN_61_BOOLI_ID,
    });
    expect(c.capDecision).toBeNull();
    expect(renderValuationCompareMd(c)).not.toContain("Takbeslut (R-01)");
  });

  it("states the resale difference between the two caps for the tracked flat", () => {
    const r8 = recordOf(2, [{ id: FOLKUNGAGATAN_61_BOOLI_ID, address: "Folkungagatan 61", rank: 1, resale: 5_503_113 }]);
    const r12 = recordOf(2, [{ id: FOLKUNGAGATAN_61_BOOLI_ID, address: "Folkungagatan 61", rank: 1, resale: 5_560_000 }]);
    const c = buildValuationCompare({
      columns: [
        { label: "före", record: rec(1) },
        { label: "åtta", record: r8, model: modelFile({ features: feats(1), balcony: 0.08 }) },
        { label: "tolv", record: r12, model: modelFile({ features: feats(1), capPct: 0.12, balcony: 0.095 }) },
      ],
      trackId: FOLKUNGAGATAN_61_BOOLI_ID,
    });
    expect(c.capResaleDiff).toEqual({ cap8Label: "åtta", cap12Label: "tolv", resale8: 5_503_113, resale12: 5_560_000, diffSek: 56_887 });
    expect(renderValuationCompareMd(c)).toContain("Taket ±8 % mot ±12 %: återförsäljning 5 503 113 kr mot 5 560 000 kr, skillnad +56 887 kr");
  });

  it("reads the committed model: balcony +8,0 % and 1961-1990 -8,0 % sit on its +-8 % cap", () => {
    const committed = JSON.parse(readFileSync("data/hedonic-model.json", "utf8")) as unknown;
    const md = renderValuationCompareMd(
      buildValuationCompare({
        columns: [
          { label: "a", record: rec(1), model: committed },
          { label: "b", record: rec(2), model: committed },
        ],
        trackId: FOLKUNGAGATAN_61_BOOLI_ID,
      }),
    );
    expect(md).toContain("på taket ±8");
    expect(md.split("\n").find((l) => l.startsWith("| Balkong |"))).toContain("(på taket ±8 %)");
    expect(md.split("\n").find((l) => l.startsWith("| Byggår 1961–1990 |"))).toContain("(på taket ±8 %)");
  });
});
