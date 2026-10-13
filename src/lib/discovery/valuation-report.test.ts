// @vitest-environment node
import { describe, expect, it } from "vitest";
import snapshotJson from "@/lib/discovery/__fixtures__/forsale-snapshot.fixture.json";
import modelJson from "@/lib/discovery/__fixtures__/hedonic-model.fixture.json";
import { parseFitSnapshot, rankFit, residualFlagFires, type FitInputRow } from "@/lib/discovery/fit-score";
import { parseHedonicModel, type HedonicModel } from "@/lib/discovery/hedonic-model";
import { emptyFacts } from "@/lib/discovery/listing-facts";
import {
  FIT_RUN_RECORD_VERSION,
  FOLKUNGAGATAN_61_BOOLI_ID,
  OLD_CAP_FLAG,
  avgiftDebtCorrelation,
  buildValuationReport,
  counterfactualGaps,
  explainedKr,
  fitRunRecordOf,
  parseFitRunRecord,
  renderValuationReportMd,
  type FitRunRecord,
} from "@/lib/discovery/valuation-report";

/**
 * valuation-report.test.ts - pins the run-record contract (Phase 14.4-01, R-05): a frozen
 * ranking survives a JSON round trip, keeps a flag the current code no longer knows and any
 * extra row key a later plan adds, and a bad record is refused with one readable error.
 * The model is the SYNTHETIC fixture: these tests prove the shape, not any real price.
 */

const model = parseHedonicModel(modelJson);
const snapshot = parseFitSnapshot(snapshotJson);

/** A two-row ranking from the shared fixtures. */
function twoRowRecord(): FitRunRecord {
  const ranking = rankFit(snapshot.rows.slice(0, 2), model);
  return fitRunRecordOf({
    snapshotAsOf: snapshot.asOf,
    snapshotFile: "src/lib/discovery/__fixtures__/forsale-snapshot.fixture.json",
    model,
    sunLine: "Sol: test",
    ranking,
  });
}

/** The record as it would be read back from disk. */
function throughJson(record: unknown): unknown {
  return JSON.parse(JSON.stringify(record)) as unknown;
}

describe("fitRunRecordOf", () => {
  it("names the model and the snapshot the numbers came from", () => {
    const record = twoRowRecord();
    expect(record.version).toBe(FIT_RUN_RECORD_VERSION);
    expect(record.kind).toBe("fit-replay");
    expect(record.snapshotAsOf).toBe(snapshot.asOf);
    expect(record.model).toEqual({
      version: model.version,
      asOf: model.asOf,
      n: model.n,
      r2: model.r2,
      cvRmseLog: model.cvRmseLog,
      residualSdLog: model.residualSdLog,
      bidPremiumKind: model.bidPremium.kind,
    });
    expect(record.sunLine).toBe("Sol: test");
  });

  it("ranks the rows from 1 and gives a not-comparable row a null rank", () => {
    const record = twoRowRecord();
    expect(record.ranked.map((r) => r.rank)).toEqual(record.ranked.map((_, i) => i + 1));
    expect(record.notComparable.every((r) => r.rank === null)).toBe(true);
    expect(record.ranked.length + record.notComparable.length).toBe(2);
  });

  it("keeps the uncapped gap, the credit and the profit on every ranked row", () => {
    const record = twoRowRecord();
    expect(record.ranked.length).toBeGreaterThan(0);
    for (const row of record.ranked) {
      expect(typeof row.gapSek).toBe("number");
      expect(typeof row.creditSek).toBe("number");
      expect(typeof row.profitSek).toBe("number");
      expect(Array.isArray(row.flags)).toBe(true);
    }
  });

  it("survives a JSON round trip unchanged", () => {
    const record = twoRowRecord();
    expect(parseFitRunRecord(throughJson(record))).toEqual(record);
  });

  it("keeps money unrounded", () => {
    const record = twoRowRecord();
    record.ranked[0] = { ...record.ranked[0], gapSek: 1234.56 };
    const back = parseFitRunRecord(throughJson(record));
    expect(back.ranked[0].gapSek).toBe(1234.56);
  });
});

describe("parseFitRunRecord", () => {
  it("accepts a flag string that is not a current FitFlag and keeps it unchanged", () => {
    const record = twoRowRecord();
    record.ranked[0] = { ...record.ranked[0], flags: ["creditCapped", "aFlagALaterPlanInvents"] };
    const back = parseFitRunRecord(throughJson(record));
    expect(back.ranked[0].flags).toEqual(["creditCapped", "aFlagALaterPlanInvents"]);
  });

  it("keeps an unknown extra row key unchanged", () => {
    const record = twoRowRecord();
    record.ranked[0] = { ...record.ranked[0], residualPct: -0.12 };
    const back = parseFitRunRecord(throughJson(record));
    expect((back.ranked[0] as Record<string, unknown>).residualPct).toBe(-0.12);
  });

  it("rejects version 2 with the readable prefix", () => {
    const bad = { ...(throughJson(twoRowRecord()) as object), version: 2 };
    expect(() => parseFitRunRecord(bad)).toThrow(/^Invalid fit run record:/);
  });

  it("rejects a record without a ranked array", () => {
    const bad = { ...(throughJson(twoRowRecord()) as Record<string, unknown>) };
    delete bad.ranked;
    expect(() => parseFitRunRecord(bad)).toThrow(/^Invalid fit run record:/);
  });

  it("rejects a snapshotAsOf that is not YYYY-MM-DD", () => {
    const bad = { ...(throughJson(twoRowRecord()) as object), snapshotAsOf: "13-10-2026" };
    expect(() => parseFitRunRecord(bad)).toThrow(/^Invalid fit run record:/);
  });

  it("reports at most five issues in one error", () => {
    let message = "";
    try {
      parseFitRunRecord({});
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message.startsWith("Invalid fit run record:")).toBe(true);
    expect(message.split(";").length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// The before/after report (VAL-05). Synthetic model and rows: these tests prove the
// arithmetic and the refusals, not any real price.
// ---------------------------------------------------------------------------

/** The fixture model with avgift and BRF debt switched on, so a flat with a high avgift is priced lower. */
function modelWithFeatures(avgiftBeta: number, source: "fit" | "zeroed" = "fit"): HedonicModel {
  return parseHedonicModel({
    ...modelJson,
    features: modelJson.features.map((f) => {
      if (f.name === "avgiftPerSqmMonth") return { ...f, mean: 60, beta: source === "zeroed" ? 0 : avgiftBeta, se: 0.001, source };
      if (f.name === "brfDebtPerSqm") return { ...f, mean: 5000, beta: -0.000002, se: 0.000001, source: "fit" };
      return f;
    }),
  });
}

/** Fixture rows with facts: a high avgift (100 kr/kvm/mån), a debt above the mean, and a land lease flag. */
function rowsWithFacts(): FitInputRow[] {
  return snapshot.rows.slice(0, 6).map((row, i) => {
    const area = row.candidate.livingArea ?? 40;
    return {
      ...row,
      facts: {
        ...emptyFacts(),
        avgiftMonthlySek: i === 5 ? null : area * (i % 2 === 0 ? 100 : 40),
        brf: i === 5 ? null : { loanSek: null, areaSqm: null, reportYear: null, debtPerSqm: i % 2 === 0 ? 9000 : 2000 },
        landLease: i === 4 ? true : null,
        daysOnMarket: i === 3 ? 30 : null,
      },
    };
  });
}

const keyOfRow = (row: FitInputRow): string => row.candidate.sourceListingUrl ?? `${row.candidate.address}|${row.candidate.price}`;

describe("counterfactualGaps", () => {
  const featured = modelWithFeatures(-0.004);

  it("blanking a high avgift raises the gap, and the explained kr is that difference (positive)", () => {
    const rows = rowsWithFacts();
    const cf = counterfactualGaps(rows, featured);
    const highAvgift = cf.get(keyOfRow(rows[0]));
    expect(highAvgift).toBeDefined();
    expect(highAvgift!.avgiftAtMean).toBeGreaterThan(highAvgift!.gap);
    expect(explainedKr(highAvgift!).avgift).toBeCloseTo(highAvgift!.avgiftAtMean - highAvgift!.gap, 6);
    expect(explainedKr(highAvgift!).avgift).toBeGreaterThan(0);
  });

  it("a low avgift (below the training mean) explains a negative amount: it raised the value", () => {
    const rows = rowsWithFacts();
    const cf = counterfactualGaps(rows, featured);
    expect(explainedKr(cf.get(keyOfRow(rows[1]))!).avgift).toBeLessThan(0);
  });

  it("a zeroed avgift feature explains exactly 0 kr", () => {
    const rows = rowsWithFacts();
    const cf = counterfactualGaps(rows, modelWithFeatures(-0.004, "zeroed"));
    expect(explainedKr(cf.get(keyOfRow(rows[0]))!).avgift).toBe(0);
  });

  it("a zeroed tomträtt explains 0 kr even for a flat with a land lease", () => {
    const rows = rowsWithFacts();
    const cf = counterfactualGaps(rows, featured);
    expect(explainedKr(cf.get(keyOfRow(rows[4]))!).tomtratt).toBe(0);
  });

  it("a row with no facts explains 0 kr for every feature", () => {
    const rows = rowsWithFacts();
    const cf = counterfactualGaps(rows, featured);
    const noFacts = cf.get(keyOfRow(rows[5]))!;
    expect(explainedKr(noFacts)).toEqual({ avgift: 0, debt: 0, tomtratt: 0, days: 0 });
  });

  it("its gap equals the gap fitScore gives the row as is", () => {
    const rows = rowsWithFacts();
    const cf = counterfactualGaps(rows, featured);
    const ranking = rankFit(rows, featured);
    for (const r of [...ranking.ranked, ...ranking.notComparable]) {
      const key = r.sourceListingUrl ?? `${r.address}|${r.askingSek}`;
      expect(cf.get(key)?.gap).toBe(r.gapSek);
    }
  });
});

/** Three records for the same rows: the old model (version 1 with a pretend ceiling), the intermediate and the new one. */
function threeRecords(
  rows: FitInputRow[],
  model: HedonicModel,
  intermediateModel: HedonicModel = parseHedonicModel(modelJson),
  isCapped: (index: number) => boolean = (i) => i < 2,
) {
  const mk = (m: HedonicModel) =>
    fitRunRecordOf({ snapshotAsOf: snapshot.asOf, snapshotFile: "x.json", model: m, sunLine: "Sol: test", ranking: rankFit(rows, m) });
  const after = mk(model);
  const intermediate = mk(intermediateModel);
  const before = mk(parseHedonicModel(modelJson));
  before.model = { ...before.model, version: 1 };
  // Pretend the old run capped the first two ranked rows at 80 % of their gap.
  before.ranked = before.ranked.map((r, i) =>
    isCapped(i) ? { ...r, creditSek: (r.gapSek as number) * 0.8, flags: [...r.flags, OLD_CAP_FLAG] } : r,
  );
  return {
    before,
    intermediate,
    after,
    counterfactual: counterfactualGaps(rows, model),
    intermediateCounterfactual: counterfactualGaps(rows, intermediateModel),
    afterModel: model,
  };
}

describe("buildValuationReport: the formerly capped rows", () => {
  const rows = rowsWithFacts();
  const featured = modelWithFeatures(-0.004);

  it("lists exactly the before rows that carry the old flag, in old rank order", () => {
    const input = threeRecords(rows, featured);
    const report = buildValuationReport(input);
    const expected = input.before.ranked.filter((r) => r.flags.includes(OLD_CAP_FLAG)).map((r) => r.key);
    expect(report.cappedRows.map((r) => r.key)).toEqual(expected);
    expect(report.cappedRows.map((r) => r.oldRank)).toEqual([...report.cappedRows.map((r) => r.oldRank)].sort((a, b) => a - b));
  });

  it("splits each row into ceiling, refit, avgift, debt, tomträtt and the rest, adding up exactly", () => {
    const report = buildValuationReport(threeRecords(rows, featured));
    expect(report.cappedRows.length).toBe(2);
    for (const r of report.cappedRows) {
      expect(r.refitKr).toBeCloseTo(r.intermediateGap - r.oldGap, 6);
      expect(r.refitExclDaysKr + r.daysKr).toBeCloseTo(r.refitKr, 6);
      expect(r.capRemovedKr).toBeCloseTo(r.oldGap - r.oldCredit, 6);
      expect(r.avgiftKr + r.debtKr + r.tomtrattKr + r.ovrigtKr).toBeCloseTo(r.newGap - r.intermediateGap, 6);
      expect(r.capRemovedKr + r.refitKr + r.avgiftKr + r.debtKr + r.tomtrattKr + r.ovrigtKr).toBeCloseTo(r.newGap - r.oldCredit, 6);
    }
  });

  it("avgift and debt both take kr off the credit of a flat with a high avgift and a high debt", () => {
    const report = buildValuationReport(threeRecords(rows, featured));
    const first = report.cappedRows.find((r) => r.key === keyOfRow(rows[0]));
    expect(first).toBeDefined();
    expect(first!.avgiftKr).toBeLessThan(0);
    expect(first!.debtKr).toBeLessThan(0);
    expect(first!.tomtrattKr).toBe(0);
  });

  it("carries the residual and both flag answers from the after model's spread", () => {
    const report = buildValuationReport(threeRecords(rows, featured));
    for (const r of report.cappedRows) {
      expect(typeof r.residualPct).toBe("number");
      expect(typeof r.flagExpectedFinal).toBe("boolean");
      expect(typeof r.flagAsking).toBe("boolean");
    }
  });

  it("measures the days term in the intermediate model: nothing without a days term, kr for a flat with known days with one", () => {
    const none = buildValuationReport(threeRecords(rows, featured, parseHedonicModel(modelJson), () => true));
    for (const r of none.cappedRows) expect(r.daysKr).toBe(0);

    const withDom = parseHedonicModel({
      ...modelJson,
      bidPremium: {
        ...modelJson.bidPremium,
        terms: { dom: { beta: -0.035, mean: 2.68, n: 800, kept: true, cvRmse: { without: 0.074, with: 0.073 }, note: "test" }, condition: null },
      },
    });
    const report = buildValuationReport(threeRecords(rows, featured, withDom, () => true));
    const known = report.cappedRows.find((r) => r.key === keyOfRow(rows[3]));
    const unknown = report.cappedRows.find((r) => r.key === keyOfRow(rows[0]));
    // 30 days is longer than the training mean (about 14 days): a lower premium, a larger gap.
    expect(known!.daysKr).toBeGreaterThan(0);
    expect(unknown!.daysKr).toBe(0);
    expect(known!.refitExclDaysKr + known!.daysKr).toBeCloseTo(known!.refitKr, 6);
  });

  it("stops when the intermediate record does not match the intermediate model", () => {
    const input = threeRecords(rows, featured);
    const victim = input.intermediate.ranked[0];
    input.intermediate.ranked[0] = { ...victim, gapSek: (victim.gapSek as number) + 50 };
    expect(() => buildValuationReport(input)).toThrow("mellan-posten");
  });

  it("refuses a before record that is not from model version 1", () => {
    const input = threeRecords(rows, featured);
    input.before.model = { ...input.before.model, version: 2 };
    expect(() => buildValuationReport(input)).toThrow("Före-posten är inte från modell version 1");
  });

  it("stops and names the row when the recomputed gap differs from the after record by more than 1 kr", () => {
    const input = threeRecords(rows, featured);
    const victim = input.after.ranked[0];
    input.after.ranked[0] = { ...victim, gapSek: (victim.gapSek as number) + 5 };
    expect(() => buildValuationReport(input)).toThrow(new RegExp(victim.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("accepts a difference of less than 1 kr", () => {
    const input = threeRecords(rows, featured);
    const victim = input.after.ranked[0];
    input.after.ranked[0] = { ...victim, gapSek: (victim.gapSek as number) + 0.5 };
    expect(() => buildValuationReport(input)).not.toThrow();
  });
});

describe("renderValuationReportMd: the formerly capped table", () => {
  it("has the heading, the column labels and one line per formerly capped row", () => {
    const report = buildValuationReport(threeRecords(rowsWithFacts(), modelWithFeatures(-0.004)));
    const md = renderValuationReportMd(report);
    expect(md).toContain("Rows that hit the 20 % ceiling before");
    for (const label of ["Adress", "Plats före -> efter", "Kredit före", "Skillnad efter", "Ny anpassning", "Avgift", "BRF-skuld", "Tomträtt", "Övrigt", "Residual"]) {
      expect(md).toContain(label);
    }
    for (const r of report.cappedRows) expect(md).toContain(r.address ?? "");
  });

  it("writes money with space thousands and the decimal comma for percentages", () => {
    const report = buildValuationReport(threeRecords(rowsWithFacts(), modelWithFeatures(-0.004)));
    const md = renderValuationReportMd(report);
    expect(md).toMatch(/\d \d{3}/);
    expect(md).toMatch(/[+-]\d+,\d %/);
  });
});

// ---------------------------------------------------------------------------
// The rest of the report (task 2): top 15, Folkungagatan 61, flag counts, bid premium, model
// ---------------------------------------------------------------------------

describe("buildValuationReport: top 15", () => {
  const rows = rowsWithFacts();
  const featured = modelWithFeatures(-0.004);

  it("lists the first 15 ranked rows of before and of after with rank, address and profit", () => {
    const input = threeRecords(rows, featured);
    const report = buildValuationReport({ ...input, snapshotRows: rows });
    expect(report.top15.before.map((r) => r.rank)).toEqual(input.before.ranked.slice(0, 15).map((_, i) => i + 1));
    expect(report.top15.after.map((r) => r.key)).toEqual(input.after.ranked.slice(0, 15).map((r) => r.key));
    for (const r of report.top15.after) {
      expect(typeof r.profitSek).toBe("number");
      expect(r.address).not.toBeNull();
    }
  });

  it("shows the rank in the other list, and null where the row is missing from it", () => {
    const input = threeRecords(rows, featured);
    const dropped = input.after.ranked[0];
    input.after.ranked = input.after.ranked.slice(1).map((r, i) => ({ ...r, rank: i + 1 }));
    input.after.notComparable = [...input.after.notComparable, { ...dropped, rank: null }];
    const report = buildValuationReport({ ...input, snapshotRows: rows });
    const left = report.top15.before.find((r) => r.key === dropped.key);
    expect(left?.otherTop15Rank).toBeNull();
    expect(left?.otherRank).toBeNull();
    const kept = report.top15.before.find((r) => r.key !== dropped.key);
    expect(typeof kept?.otherTop15Rank).toBe("number");
    const md = renderValuationReportMd(report);
    expect(md).toContain("Top 15 before and after");
  });
});

describe("buildValuationReport: Folkungagatan 61", () => {
  const rows = rowsWithFacts();
  const featured = modelWithFeatures(-0.004);

  it("finds the listing by its Booli id in each record and decomposes its credit", () => {
    expect(FOLKUNGAGATAN_61_BOOLI_ID).toBe(150148);
    const input = threeRecords(rows, featured);
    const report = buildValuationReport({ ...input, snapshotRows: rows });
    const f = report.folkungagatan61;
    expect(f.before?.rank).toBe(input.before.ranked.find((r) => r.booliId === 150148)?.rank);
    expect(f.after?.rank).toBe(input.after.ranked.find((r) => r.booliId === 150148)?.rank);
    expect(f.after?.profitSek).toBe(input.after.ranked.find((r) => r.booliId === 150148)?.profitSek);
    expect(f.decomposition).not.toBeNull();
    const d = f.decomposition!;
    expect(d.avgiftKr + d.debtKr + d.tomtrattKr + d.ovrigtKr).toBeCloseTo(d.newGap - d.intermediateGap, 6);
  });

  it("says 'saknas i körningen' when the listing is absent from a record", () => {
    const input = threeRecords(rows, featured);
    input.before.ranked = input.before.ranked.filter((r) => r.booliId !== 150148);
    const report = buildValuationReport({ ...input, snapshotRows: rows });
    expect(report.folkungagatan61.before).toBeNull();
    const md = renderValuationReportMd(report);
    expect(md).toContain("Folkungagatan 61");
    expect(md).toContain("saknas i körningen");
  });
});

describe("buildValuationReport: credit removed, flag counts, bid premium", () => {
  const rows = rowsWithFacts();
  const featured = modelWithFeatures(-0.004);

  it("creditRemoved sums gap minus credit over the before rows, and over the before top 15", () => {
    const input = threeRecords(rows, featured);
    const report = buildValuationReport({ ...input, snapshotRows: rows });
    const hidden = input.before.ranked.map((r) => (r.gapSek as number) - (r.creditSek as number));
    expect(report.creditRemoved.total).toBeCloseTo(hidden.reduce((a, b) => a + b, 0), 6);
    expect(report.creditRemoved.top15).toBeCloseTo(hidden.slice(0, 15).reduce((a, b) => a + b, 0), 6);
    expect(report.creditRemoved.total).toBeGreaterThan(0);
  });

  it("counts the residual flag on both bases from the after rows and the after model's spread", () => {
    const input = threeRecords(rows, featured);
    const report = buildValuationReport({ ...input, snapshotRows: rows });
    let expectedFinal = 0;
    let asking = 0;
    for (const r of input.after.ranked) {
      const ratios = { askToPred: r.askToPred as number, expectedFinalToPred: (r as Record<string, unknown>).expectedFinalToPred as number };
      if (residualFlagFires("expectedFinal", ratios, featured.residualSdLog)) expectedFinal += 1;
      if (residualFlagFires("asking", ratios, featured.residualSdLog)) asking += 1;
    }
    expect(report.residualCounts.expectedFinal).toBe(expectedFinal);
    expect(report.residualCounts.asking).toBe(asking);
    expect(report.residualCounts.n).toBe(input.after.ranked.length);
    expect(["expectedFinal", "asking"]).toContain(report.residualCounts.basisInForce);
  });

  it("bidPremium compares overbid before and after for the after top 15 and averages the change over rows in both", () => {
    const input = threeRecords(rows, featured);
    const report = buildValuationReport({ ...input, snapshotRows: rows });
    expect(report.bidPremium.top15.length).toBe(Math.min(15, input.after.ranked.length));
    const first = report.bidPremium.top15[0];
    const afterRow = input.after.ranked[0];
    const beforeRow = input.before.ranked.find((r) => r.key === afterRow.key);
    expect(first.overbidAfter).toBe(afterRow.overbidPct);
    expect(first.overbidBefore).toBe(beforeRow?.overbidPct ?? null);
    const diffs = input.after.ranked.flatMap((a) => {
      const b = input.before.ranked.find((r) => r.key === a.key);
      return b && a.overbidPct !== null && b.overbidPct !== null ? [a.overbidPct - b.overbidPct] : [];
    });
    expect(report.bidPremium.meanChange).toBeCloseTo(diffs.reduce((x, y) => x + y, 0) / diffs.length, 9);
    expect(report.bidPremium.rowsInBoth).toBe(diffs.length);
  });
});

describe("avgiftDebtCorrelation", () => {
  const base = snapshot.rows[0];
  const withFacts = (avgift: number | null, debt: number | null): FitInputRow => ({
    ...base,
    candidate: { ...base.candidate, livingArea: 40 },
    facts: {
      ...emptyFacts(),
      avgiftMonthlySek: avgift,
      brf: debt === null ? null : { loanSek: null, areaSqm: null, reportYear: null, debtPerSqm: debt },
    },
  });

  it("is 1 for a perfect line over the rows that have both, and counts only those rows", () => {
    const result = avgiftDebtCorrelation([
      withFacts(40 * 50, 1000),
      withFacts(40 * 60, 2000),
      withFacts(40 * 70, 3000),
      withFacts(null, 9000),
      withFacts(40 * 99, null),
    ]);
    expect(result.n).toBe(3);
    expect(result.r).toBeCloseTo(1, 9);
  });

  it("is null with fewer than three rows or no spread", () => {
    expect(avgiftDebtCorrelation([withFacts(2000, 1000), withFacts(2400, 2000)]).r).toBeNull();
    expect(avgiftDebtCorrelation([withFacts(2000, 1000), withFacts(2000, 2000), withFacts(2000, 3000)]).r).toBeNull();
  });
});

describe("renderValuationReportMd: all sections", () => {
  it("has every section heading, the model block and a findings list", () => {
    const rows = rowsWithFacts();
    const featured = modelWithFeatures(-0.004);
    const report = buildValuationReport({ ...threeRecords(rows, featured), snapshotRows: rows });
    const md = renderValuationReportMd(report);
    for (const heading of ["Top 15 before and after", "Folkungagatan 61", "Residual flag", "Bid premium", "Model", "Findings"]) {
      expect(md).toContain(`## ${heading}`);
    }
    expect(md).toContain("R²");
    expect(report.findings.length).toBeGreaterThan(3);
    for (const f of report.findings) expect(md).toContain(f);
  });

  it("never recommends changing a setting", () => {
    const rows = rowsWithFacts();
    const report = buildValuationReport({ ...threeRecords(rows, modelWithFeatures(-0.004)), snapshotRows: rows });
    expect(renderValuationReportMd(report)).not.toMatch(/\b(should|recommend|bör|rekommendera)/i);
  });
});
