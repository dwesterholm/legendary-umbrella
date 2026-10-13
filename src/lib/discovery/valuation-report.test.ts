// @vitest-environment node
import { describe, expect, it } from "vitest";
import snapshotJson from "@/lib/discovery/__fixtures__/forsale-snapshot.fixture.json";
import modelJson from "@/lib/discovery/__fixtures__/hedonic-model.fixture.json";
import { parseFitSnapshot, rankFit } from "@/lib/discovery/fit-score";
import { parseHedonicModel } from "@/lib/discovery/hedonic-model";
import {
  FIT_RUN_RECORD_VERSION,
  fitRunRecordOf,
  parseFitRunRecord,
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
