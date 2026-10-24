// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import truthJson from "@/lib/discovery/__fixtures__/layout-truth-3row.fixture.json";
import type { LayoutFact } from "@/lib/discovery/layout-fact";
import {
  ACCURACY_TARGET,
  F61_BOOLI_ID,
  MIN_DECIDED_TRUTH_ROWS,
  TRUTH_SEED,
  TRUTH_SET_MAX_ROWS,
  TRUTH_SET_MIN_ROWS,
  accuracyReport,
  assignSplit,
  byEvidence,
  curveOf,
  fieldVerdict,
  gateFromCurve,
  layoutTruthFileSchema,
  lockTruthFile,
  measurability,
  rawFieldScores,
  renderAccuracyMd,
  rowsHashOf,
  seededRank,
  selectTruthSet,
  sideEvidenceAllowlist,
  truthRowSchema,
  validateTruthFile,
  variantVerdict,
  wilson,
  worklistOf,
  type FieldEvidence,
  type TruthFile,
  type TruthRow,
} from "@/lib/discovery/layout-accuracy";

/**
 * layout-accuracy.test.ts - the truth-file format and the scoring of stored layout reads against it
 * (Phase 14.5 plan 02). Pure: hand-made rows, no model, no network.
 */

const file = layoutTruthFileSchema.parse(truthJson);

const fact = (over: Partial<LayoutFact> = {}): LayoutFact => ({
  balconySide: "street",
  livingOnBalconySide: true,
  kitchenOnBalconySide: true,
  bedroomOnBalconySide: true,
  windowSides: "one",
  bedroomSide: "street",
  streetEvidence: "cars",
  confidence: 0.9,
  source: "planritning+foto",
  version: "test-version",
  images: { booli: 4, broker: 0 },
  ...over,
});

/** Folkungagatan 61's stored 14.4 read: wrong on balcony and bedroom (courtyard, truth street), right on windows. */
const f61Read = fact({
  balconySide: "courtyard",
  windowSides: "one",
  bedroomSide: "courtyard",
  streetEvidence: "courtyardGreenery",
  confidence: 0.55,
});

const rowOf = (over: Record<string, unknown> = {}) => ({ ...file.rows[0], ...over });

describe("layoutTruthFileSchema", () => {
  it("parses the three-row fixture", () => {
    expect(file.rows).toHaveLength(3);
    expect(file.rows[0].booliId).toBe(150148);
    expect(file.lockedAt).toBeNull();
    expect(file.seed).toBe("14.5");
  });

  it("rejects a non-integer Booli id", () => {
    expect(truthRowSchema.safeParse(rowOf({ booliId: 150148.5 })).success).toBe(false);
    expect(truthRowSchema.safeParse(rowOf({ booliId: "150148" })).success).toBe(false);
    expect(truthRowSchema.safeParse(rowOf({ booliId: 0 })).success).toBe(false);
  });

  it("rejects a note holding a URL, a host or a street name", () => {
    for (const note of [
      "se https://example.test/x",
      "se http://example.test",
      "se www.example.test",
      "Folkungagatan balkong mot gården",
      "ligger vid Sveavägen",
      "Mårten Trotzigs gränd",
      "Götgatan 61",
      "Stureplan torget",
    ]) {
      expect(truthRowSchema.safeParse(rowOf({ note })).success, note).toBe(false);
    }
  });

  it("accepts a note that says 'gatan' as an ordinary word", () => {
    expect(truthRowSchema.safeParse(rowOf({ note: "balkong mot gatan, bilar syns" })).success).toBe(true);
  });

  it("rejects an empty note and one longer than 160 characters", () => {
    expect(truthRowSchema.safeParse(rowOf({ note: "" })).success).toBe(false);
    expect(truthRowSchema.safeParse(rowOf({ note: "a".repeat(160) })).success).toBe(true);
    expect(truthRowSchema.safeParse(rowOf({ note: "a".repeat(161) })).success).toBe(false);
  });

  it("rejects an extra key such as an address or a URL field", () => {
    expect(truthRowSchema.safeParse(rowOf({ address: "Någon väg 1" })).success).toBe(false);
    expect(truthRowSchema.safeParse(rowOf({ url: "x" })).success).toBe(false);
  });

  it("rejects an empty evidence list and an unknown evidence word", () => {
    expect(truthRowSchema.safeParse(rowOf({ evidence: [] })).success).toBe(false);
    expect(truthRowSchema.safeParse(rowOf({ evidence: ["unicorn"] })).success).toBe(false);
  });
});

describe("rawFieldScores", () => {
  it("scores Folkungagatan 61's stored read: wrong balcony and bedroom, right windows, two flats without a read", () => {
    const reads = new Map<number, LayoutFact>([[150148, f61Read]]);
    const s = rawFieldScores(file.rows, reads);
    expect(s.balcony).toEqual({ decided: 2, read: 1, correct: 0, undecidable: 0 });
    expect(s.korsdrag).toEqual({ decided: 3, read: 1, correct: 1, undecidable: 0 });
    expect(s.bedroom).toEqual({ decided: 2, read: 1, correct: 0, undecidable: 1 });
    expect(s.noRead).toBe(2);
  });

  it("maps korsdrag like korsdragWhen: twoOpposite is ja, one and corner are nej, unknown is no answer", () => {
    const truth = [
      rowOf({ booliId: 1, windowSides: "twoOpposite" }),
      rowOf({ booliId: 2, windowSides: "one" }),
      rowOf({ booliId: 3, windowSides: "corner" }),
      rowOf({ booliId: 4, windowSides: "twoOpposite" }),
    ].map((r) => truthRowSchema.parse(r));
    const reads = new Map<number, LayoutFact>([
      [1, fact({ windowSides: "twoOpposite" })], // ja, truth ja: right
      [2, fact({ windowSides: "corner" })], // nej, truth nej: right
      [3, fact({ windowSides: "twoOpposite" })], // ja, truth nej: wrong
      [4, fact({ windowSides: "unknown" })], // no answer
    ]);
    const s = rawFieldScores(truth, reads);
    expect(s.korsdrag).toEqual({ decided: 4, read: 3, correct: 2, undecidable: 0 });
  });

  it("leaves an undecidable truth row out of the denominator and counts it apart", () => {
    const truth = [
      rowOf({ booliId: 1, balconySide: "street", windowSides: "undecidable", bedroomSide: "undecidable" }),
      rowOf({ booliId: 2, balconySide: "undecidable", windowSides: "one", bedroomSide: "street" }),
    ].map((r) => truthRowSchema.parse(r));
    const reads = new Map<number, LayoutFact>([
      [1, fact()],
      [2, fact()],
    ]);
    const s = rawFieldScores(truth, reads);
    expect(s.balcony).toEqual({ decided: 1, read: 1, correct: 1, undecidable: 1 });
    expect(s.korsdrag).toEqual({ decided: 1, read: 1, correct: 1, undecidable: 1 });
    expect(s.bedroom).toEqual({ decided: 1, read: 1, correct: 1, undecidable: 1 });
  });

  it("does not count a truth 'none' balcony in the balcony score, and treats a 'none' or 'unknown' read as no answer", () => {
    const truth = [
      rowOf({ booliId: 1, balconySide: "none" }),
      rowOf({ booliId: 2, balconySide: "courtyard" }),
    ].map((r) => truthRowSchema.parse(r));
    const reads = new Map<number, LayoutFact>([
      [1, fact({ balconySide: "street" })],
      [2, fact({ balconySide: "unknown" })],
    ]);
    const s = rawFieldScores(truth, reads);
    expect(s.balcony).toEqual({ decided: 1, read: 0, correct: 0, undecidable: 0 });
  });

  it("scores only rows that are in the set", () => {
    const truth = [rowOf({ booliId: 1, inSet: false }), rowOf({ booliId: 2 })].map((r) => truthRowSchema.parse(r));
    const reads = new Map<number, LayoutFact>([[1, fact()]]);
    const s = rawFieldScores(truth, reads);
    expect(s.balcony.decided).toBe(1);
    expect(s.balcony.read).toBe(0);
    expect(s.noRead).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Task 2: the decision rule
// ---------------------------------------------------------------------------

const row = (booliId: number, over: Record<string, unknown> = {}): TruthRow =>
  truthRowSchema.parse({ ...file.rows[1], booliId, position: booliId, split: null, order: null, ...over });

describe("wilson", () => {
  it("15 of 20 has a lower bound of about 0,53", () => {
    const w = wilson(15, 20);
    expect(w.low).toBeCloseTo(0.53, 2);
    expect(w.high).toBeCloseTo(0.89, 2);
  });
  it("12 of 12 has a lower bound of about 0,76", () => {
    const w = wilson(12, 12);
    expect(w.low).toBeCloseTo(0.76, 2);
    expect(w.high).toBeCloseTo(1, 5);
  });
  it("0 of 0 is the whole range", () => {
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe("constants", () => {
  it("fix the bar and the minimum number of decided rows", () => {
    expect(ACCURACY_TARGET).toBe(0.75);
    expect(MIN_DECIDED_TRUTH_ROWS).toBe(12);
  });
});

describe("gateFromCurve", () => {
  const pt = (t: number, nBelieved: number, precision: number) => ({ t, nBelieved, nCorrect: Math.round(nBelieved * precision), precision, low: 0, high: 1 });
  it("returns the lowest threshold that still holds the target with enough support", () => {
    const curve = [pt(0.4, 20, 0.5), pt(0.55, 12, 0.7), pt(0.6, 10, 0.8), pt(0.7, 8, 0.875), pt(0.9, 3, 1)];
    expect(gateFromCurve(curve, 5, 0.75)).toBe(0.6);
  });
  it("stops at the first supported point that fails, so a lucky dip lower down does not count", () => {
    const curve = [pt(0.6, 10, 0.8), pt(0.7, 8, 0.6), pt(0.9, 6, 1)];
    expect(gateFromCurve(curve, 5, 0.75)).toBe(0.9);
  });
  it("ignores unsupported points and returns null when nothing qualifies", () => {
    expect(gateFromCurve([pt(0.9, 3, 1), pt(0.7, 4, 1)], 5, 0.75)).toBeNull();
    expect(gateFromCurve([pt(0.9, 6, 0.5)], 5, 0.75)).toBeNull();
    expect(gateFromCurve([], 5, 0.75)).toBeNull();
  });
});

describe("curveOf: believed precision of the money-moving answer", () => {
  it("korsdrag counts believed 'ja' calls, correct only on truth twoOpposite; one point per distinct confidence", () => {
    const rows: TruthRow[] = [];
    const reads = new Map<number, LayoutFact>();
    for (let i = 1; i <= 6; i++) {
      rows.push(row(i, { inSet: true, split: "dev", windowSides: "twoOpposite" }));
      reads.set(i, fact({ windowSides: "twoOpposite", confidence: 0.9 }));
    }
    for (let i = 7; i <= 10; i++) {
      rows.push(row(i, { inSet: true, split: "dev", windowSides: "one" }));
      reads.set(i, fact({ windowSides: "twoOpposite", confidence: 0.6 }));
    }
    // a "nej" read is no money-moving call and must not enter the curve
    rows.push(row(11, { inSet: true, split: "dev", windowSides: "one" }));
    reads.set(11, fact({ windowSides: "one", confidence: 0.9 }));
    const curve = curveOf(rows, reads, "korsdrag", ["cars", "courtyardGreenery"], "dev");
    expect(curve.map((p) => p.t)).toEqual([0.6, 0.9]);
    expect(curve[0]).toMatchObject({ nBelieved: 10, nCorrect: 6, precision: 0.6 });
    expect(curve[1]).toMatchObject({ nBelieved: 6, nCorrect: 6, precision: 1 });
    expect(curve[1].low).toBeCloseTo(wilson(6, 6).low, 10);
    expect(gateFromCurve(curve, 5, ACCURACY_TARGET)).toBe(0.9);
  });

  it("balcony: a believed street call on a truth 'none' flat is wrong, an undecidable truth row is excluded", () => {
    const rows = [
      row(1, { inSet: true, split: "dev", balconySide: "street" }),
      row(2, { inSet: true, split: "dev", balconySide: "none" }),
      row(3, { inSet: true, split: "dev", balconySide: "undecidable" }),
    ];
    const reads = new Map<number, LayoutFact>([1, 2, 3].map((i) => [i, fact({ balconySide: "street", confidence: 0.9 })]));
    const [p] = curveOf(rows, reads, "balcony", ["cars", "courtyardGreenery"], "dev");
    expect(p).toMatchObject({ t: 0.9, nBelieved: 2, nCorrect: 1 });
  });

  it("bedroom counts believed 'courtyard' calls only, correct only on truth courtyard", () => {
    const rows = [
      row(1, { inSet: true, split: "dev", bedroomSide: "courtyard" }),
      row(2, { inSet: true, split: "dev", bedroomSide: "street" }),
      row(3, { inSet: true, split: "dev", bedroomSide: "street" }),
    ];
    const reads = new Map<number, LayoutFact>([
      [1, fact({ bedroomSide: "courtyard", streetEvidence: "courtyardGreenery", confidence: 0.7 })],
      [2, fact({ bedroomSide: "courtyard", streetEvidence: "courtyardGreenery", confidence: 0.7 })],
      [3, fact({ bedroomSide: "street", streetEvidence: "cars", confidence: 0.7 })],
    ]);
    const [p] = curveOf(rows, reads, "bedroom", ["cars", "courtyardGreenery"], "dev");
    expect(p).toMatchObject({ t: 0.7, nBelieved: 2, nCorrect: 1 });
  });

  it("respects the evidence allowlist and the split", () => {
    const rows = [
      row(1, { inSet: true, split: "dev", balconySide: "street" }),
      row(2, { inSet: true, split: "holdout", balconySide: "street" }),
    ];
    const reads = new Map<number, LayoutFact>([
      [1, fact({ streetEvidence: "oppositeFacade", confidence: 0.9 })],
      [2, fact({ streetEvidence: "cars", confidence: 0.9 })],
    ]);
    expect(curveOf(rows, reads, "balcony", ["cars", "courtyardGreenery"], "dev")[0]?.nBelieved ?? 0).toBe(0);
    expect(curveOf(rows, reads, "balcony", ["cars", "oppositeFacade"], "dev")[0]?.nBelieved).toBe(1);
    expect(curveOf(rows, reads, "balcony", ["cars", "courtyardGreenery"], "holdout")[0]?.nBelieved).toBe(1);
    expect(curveOf(rows, reads, "balcony", ["cars", "courtyardGreenery"], "all")[0]?.nBelieved).toBe(1);
  });

  it("uses the field's own confidence when the fact has one", () => {
    const rows = [row(1, { inSet: true, split: "dev", balconySide: "street" })];
    const reads = new Map<number, LayoutFact>([[1, fact({ confidence: 0.9, fieldConfidence: { balcony: 0.5, windows: 0.9, bedroom: 0.9 } })]]);
    expect(curveOf(rows, reads, "balcony", ["cars"], "dev").map((p) => p.t)).toEqual([0.5]);
  });
});

describe("byEvidence and sideEvidenceAllowlist (D-12)", () => {
  const build = (calls: number, correct: number) => {
    const rows: TruthRow[] = [];
    const reads = new Map<number, LayoutFact>();
    for (let i = 1; i <= calls; i++) {
      rows.push(row(i, { inSet: true, split: "dev", balconySide: "street" }));
      reads.set(i, fact({ balconySide: i <= correct ? "street" : "courtyard", bedroomSide: "unknown", streetEvidence: "oppositeFacade", confidence: 0.9 }));
    }
    return byEvidence(rows, reads, "dev");
  };

  it("tabulates side calls by the model's evidence word", () => {
    const t = build(5, 4);
    const opp = t.find((r) => r.evidence === "oppositeFacade");
    expect(opp?.balcony).toEqual({ n: 5, correct: 4 });
    expect(t.map((r) => r.evidence)).toEqual(["cars", "oppositeFacade", "courtyardGreenery", "none"]);
  });

  it("starts from cars and courtyardGreenery", () => {
    expect(sideEvidenceAllowlist(build(0, 0))).toEqual(["cars", "courtyardGreenery"]);
  });

  it("adds oppositeFacade only at 75 % or better over at least 5 calls", () => {
    expect(sideEvidenceAllowlist(build(5, 4))).toContain("oppositeFacade"); // 80 % over 5
    expect(sideEvidenceAllowlist(build(5, 3))).not.toContain("oppositeFacade"); // 60 %
    expect(sideEvidenceAllowlist(build(4, 4))).not.toContain("oppositeFacade"); // 100 % over only 4
  });
});

describe("measurability", () => {
  const decidedRows = (n: number) => Array.from({ length: n }, (_, i) => row(i + 1, { inSet: true, balconySide: "street", windowSides: "one", bedroomSide: "street" }));
  it("fewer than 12 decided rows is 'ej mätbart (n = k)'", () => {
    const m = measurability(decidedRows(11));
    expect(m.balcony).toEqual({ measurable: false, decided: 11, reason: "ej mätbart (n = 11)" });
    expect(m.korsdrag.measurable).toBe(false);
    expect(m.bedroom.reason).toBe("ej mätbart (n = 11)");
  });
  it("12 decided rows is measurable", () => {
    const m = measurability(decidedRows(12));
    expect(m.balcony).toEqual({ measurable: true, decided: 12, reason: null });
  });
  it("counts only decided rows that are in the set", () => {
    const rows = [...decidedRows(11), row(99, { inSet: false }), row(100, { inSet: true, balconySide: "undecidable" })];
    expect(measurability(rows).balcony.decided).toBe(11);
  });
});

describe("fieldVerdict", () => {
  const prec = (k: number, n: number) => ({ k, n, precision: n === 0 ? null : k / n, low: 0, high: 1 });
  const good = (over: Partial<FieldEvidence> = {}): FieldEvidence => ({
    measurable: true,
    decidedRows: 20,
    locked: true,
    gate: 0.7,
    dev: prec(9, 10),
    holdout: prec(6, 7),
    pooled: prec(15, 17),
    ...over,
  });

  it("passes when measurable, gated on dev, and holdout and pooled hold 75 % with enough calls", () => {
    expect(fieldVerdict(good())).toEqual({ pass: true, reasons: [] });
  });
  it("holdout exactly 75 % over exactly 5 calls is not a fail; pooled exactly 10 calls is not a fail", () => {
    // 3 of 4 is 75 % but only 4 calls; use 6 of 8 (75 %) over 8 calls plus pooled 10
    expect(fieldVerdict(good({ holdout: prec(6, 8), pooled: prec(8, 10) })).pass).toBe(true);
  });
  it("not measurable can never pass, and says so", () => {
    const v = fieldVerdict(good({ measurable: false, decidedRows: 7 }));
    expect(v.pass).toBe(false);
    expect(v.reasons).toContain("ej mätbart (n = 7)");
  });
  it("an unlocked file passes nothing and says 'ingen låst holdout'", () => {
    const v = fieldVerdict(good({ locked: false, gate: null, dev: null, holdout: null, pooled: null }));
    expect(v.pass).toBe(false);
    expect(v.reasons).toContain("ingen låst holdout");
  });
  it("no dev gate fails", () => {
    const v = fieldVerdict(good({ gate: null, dev: null, holdout: null, pooled: null }));
    expect(v.pass).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/spärr/);
  });
  it("holdout precision under 75 % fails; so do too few believed calls on the holdout or pooled", () => {
    expect(fieldVerdict(good({ holdout: prec(5, 8) })).pass).toBe(false);
    expect(fieldVerdict(good({ holdout: prec(4, 4) })).pass).toBe(false);
    expect(fieldVerdict(good({ pooled: prec(9, 9) })).pass).toBe(false);
    expect(fieldVerdict(good({ pooled: prec(7, 12) })).pass).toBe(false);
  });
  it("lists every failing reason, joined by '; ' by the report", () => {
    const v = fieldVerdict(good({ measurable: false, decidedRows: 4, holdout: prec(1, 3), pooled: prec(5, 9) }));
    expect(v.reasons.length).toBeGreaterThanOrEqual(4);
    expect(v.reasons[0]).toBe("ej mätbart (n = 4)");
  });
});

describe("variantVerdict", () => {
  const pass = { pass: true, reasons: [] as string[] };
  const fail = { pass: false, reasons: ["x"] };
  it("passes only when all three fields pass", () => {
    expect(variantVerdict({ balcony: pass, korsdrag: pass, bedroom: pass })).toBe(true);
    expect(variantVerdict({ balcony: pass, korsdrag: fail, bedroom: pass })).toBe(false);
    expect(variantVerdict({ balcony: fail, korsdrag: fail, bedroom: fail })).toBe(false);
  });
});

/** 24 decided rows, half dev and half holdout, every read equal to the truth at confidence 0,9. */
function lockedFile(over: { wrongKorsdragOnHoldout?: boolean; rows?: number } = {}): { file: TruthFile; reads: Map<number, LayoutFact> } {
  const n = over.rows ?? 24;
  const rows: TruthRow[] = [];
  const reads = new Map<number, LayoutFact>();
  for (let i = 0; i < n; i++) {
    const even = i % 2 === 0;
    const split = Math.floor(i / 2) % 2 === 0 ? "dev" : "holdout";
    const r = row(1000 + i, {
      inSet: true,
      split,
      order: i + 1,
      balconySide: even ? "street" : "courtyard",
      windowSides: even ? "twoOpposite" : "one",
      bedroomSide: even ? "street" : "courtyard",
      livingOnBalconySide: even ? "yes" : "no",
    });
    rows.push(r);
    let windowSides: LayoutFact["windowSides"] = even ? "twoOpposite" : "one";
    if (over.wrongKorsdragOnHoldout && split === "holdout") windowSides = even ? "one" : "twoOpposite";
    reads.set(
      r.booliId,
      fact({
        balconySide: even ? "street" : "courtyard",
        bedroomSide: even ? "street" : "courtyard",
        windowSides,
        livingOnBalconySide: even,
        streetEvidence: even ? "cars" : "courtyardGreenery",
        confidence: 0.9,
      }),
    );
  }
  return {
    file: { ...file, lockedAt: "2026-10-17T16:00:00.000Z", rowsHash: "x", procedureHash: "y", selectionRule: "test", rows },
    reads,
  };
}

describe("accuracyReport on a locked file", () => {
  it("passes all three fields when the reads are right", () => {
    const { file: f, reads } = lockedFile();
    const r = accuracyReport(f, reads, { source: "test", version: "v" });
    expect(r.truthLocked).toBe(true);
    expect(r.rows).toBe(24);
    expect(r.fields.balcony.gate).toBe(0.9);
    expect(r.fields.balcony.holdout).toMatchObject({ k: 12, n: 12 });
    expect(r.fields.korsdrag.pooled).toMatchObject({ k: 12, n: 12 });
    expect(r.fields.bedroom.dev).toMatchObject({ k: 6, n: 6 });
    expect(r.fields.balcony.allCalls).toMatchObject({ k: 24, n: 24 });
    expect(r.fields.balcony.pass).toBe(true);
    expect(r.fields.korsdrag.pass).toBe(true);
    expect(r.fields.bedroom.pass).toBe(true);
    expect(r.pass).toBe(true);
    expect(r.livingOnBalconySide).toEqual({ decided: 24, read: 24, correct: 24 });
    expect(r.sideEvidence).toEqual(["cars", "courtyardGreenery"]);
  });

  it("fails the variant when one field is wrong on the holdout, naming the field's reason", () => {
    const { file: f, reads } = lockedFile({ wrongKorsdragOnHoldout: true });
    const r = accuracyReport(f, reads, { source: "test", version: "v" });
    expect(r.fields.korsdrag.holdout?.k).toBe(0);
    expect(r.fields.korsdrag.pass).toBe(false);
    expect(r.fields.korsdrag.reason).toMatch(/holdout/);
    expect(r.fields.balcony.pass).toBe(true);
    expect(r.pass).toBe(false);
  });

  it("is not measurable below 12 decided rows even when every read is right", () => {
    const { file: f, reads } = lockedFile({ rows: 11 });
    const r = accuracyReport(f, reads, { source: "test", version: "v" });
    expect(r.measurability.balcony).toEqual({ measurable: false, decided: 11, reason: "ej mätbart (n = 11)" });
    expect(r.fields.balcony.pass).toBe(false);
    expect(r.fields.balcony.reason).toContain("ej mätbart (n = 11)");
    expect(r.pass).toBe(false);
  });

  it("reports counts only: no per-flat read and no URL", () => {
    const { file: f, reads } = lockedFile();
    const text = JSON.stringify(accuracyReport(f, reads, { source: "test", version: "v" }));
    expect(text).not.toContain("http");
    expect(text).not.toContain("1000"); // no Booli id of a judged flat appears in the report
  });
});

describe("accuracyReport on the unlocked fixture", () => {
  const reads = new Map<number, LayoutFact>([[150148, f61Read]]);
  const r = accuracyReport(file, reads, { source: "production", version: "v" });

  it("passes nothing, with 'ingen låst holdout' and 'ej mätbart' among the reasons", () => {
    expect(r.truthLocked).toBe(false);
    expect(r.pass).toBe(false);
    for (const field of ["balcony", "korsdrag", "bedroom"] as const) {
      expect(r.fields[field].pass).toBe(false);
      expect(r.fields[field].reason).toContain("ingen låst holdout");
      expect(r.fields[field].reason).toContain("ej mätbart");
      expect(r.fields[field].gate).toBeNull();
    }
    expect(r.fields.balcony.reason).toContain("; ");
  });

  it("renders the status line and the verdicts in Swedish markdown", () => {
    const md = renderAccuracyMd(r);
    expect(md.startsWith("Sanningsfil: olåst (ingen låst holdout)")).toBe(true);
    expect(md).toContain("ej mätbart");
    expect(md).toContain("ingen låst holdout");
    expect(md).not.toContain("http");
  });
});

describe("renderAccuracyMd on a locked file", () => {
  it("starts with the lock time and prints intervals, gate, curve and the by-evidence table", () => {
    const { file: f, reads } = lockedFile();
    const md = renderAccuracyMd(accuracyReport(f, reads, { source: "test", version: "v" }));
    expect(md.startsWith("Sanningsfil: låst 2026-10-17T16:00:00.000Z")).toBe(true);
    expect(md).toContain("12 av 12 (100 %, 95 %: 76–100 %)");
    expect(md).toContain("0,90");
    expect(md).toMatch(/courtyardGreenery/);
    expect(md).toMatch(/Godkänd/);
  });
});

// ---------------------------------------------------------------------------
// Task 3: the truth-set tools
// ---------------------------------------------------------------------------

describe("constants of the truth set", () => {
  it("fix the seed, the F61 id and the size window", () => {
    expect(TRUTH_SEED).toBe("14.5");
    expect(F61_BOOLI_ID).toBe(150148);
    expect(TRUTH_SET_MIN_ROWS).toBe(25);
    expect(TRUTH_SET_MAX_ROWS).toBe(60);
  });
});

describe("worklistOf", () => {
  const ok = (id: number, n = 4) => Array.from({ length: n }, (_, i) => `https://bcdn.se/images/cache/${id}${i}_1440x0.webp`);
  const snap = (id: number | null, imageUrls: string[]) => ({
    candidate: { sourceListingUrl: id === null ? null : `https://www.booli.se/bostad/${id}`, imageUrls },
  });
  const ids = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 150148];
  const rows = ids.map((id) => snap(id, ok(id)));

  it("puts Folkungagatan 61 first and the rest in sha256(seed:id) order", () => {
    const list = worklistOf(rows, "14.5");
    expect(list[0]).toMatchObject({ position: 1, booliId: 150148 });
    const expectedRest = ids
      .filter((id) => id !== 150148)
      .sort((a, b) => (createHash("sha256").update(`14.5:${a}`).digest("hex") < createHash("sha256").update(`14.5:${b}`).digest("hex") ? -1 : 1));
    expect(list.slice(1).map((e) => e.booliId)).toEqual(expectedRest);
    expect(list.map((e) => e.position)).toEqual(list.map((_, i) => i + 1));
  });

  it("is stable: the same input in any order gives the same list", () => {
    const a = worklistOf(rows, "14.5");
    const b = worklistOf([...rows].reverse(), "14.5");
    expect(b).toEqual(a);
    expect(worklistOf(rows, "other-seed").map((e) => e.booliId)).not.toEqual(a.map((e) => e.booliId));
  });

  it("keeps only flats with at least two allowed image URLs, and only the allowed URLs", () => {
    const list = worklistOf(
      [
        snap(1, ok(1, 1)), // one picture: out
        snap(2, [...ok(2, 2), "https://evil.example/x.jpg"]), // two allowed, one not
        snap(3, ["https://evil.example/a.jpg", "https://evil.example/b.jpg"]), // none allowed: out
        snap(null, ok(4)), // no Booli id: out
      ],
      "14.5",
    );
    expect(list).toHaveLength(1);
    expect(list[0].booliId).toBe(2);
    expect(list[0].imageUrls).toEqual(ok(2, 2));
  });

  it("lists a Booli id once", () => {
    expect(worklistOf([snap(5, ok(5)), snap(5, ok(5))], "14.5")).toHaveLength(1);
  });

  it("carries no layout read: an entry has only a position, an id and URLs", () => {
    expect(Object.keys(worklistOf(rows, "14.5")[0]).sort()).toEqual(["booliId", "imageUrls", "position"]);
  });
});

/** A judged row with the given truths; everything else fixed. */
const judged = (booliId: number, over: Record<string, unknown> = {}): TruthRow =>
  truthRowSchema.parse({
    ...file.rows[1],
    booliId,
    position: booliId,
    source: "judged",
    inSet: true,
    split: null,
    order: null,
    balconySide: "undecidable",
    livingOnBalconySide: "undecidable",
    windowSides: "undecidable",
    bedroomSide: "undecidable",
    ...over,
  });

const f61Row = (over: Record<string, unknown> = {}): TruthRow => truthRowSchema.parse({ ...file.rows[0], ...over });

const fileOf = (rows: TruthRow[], over: Partial<TruthFile> = {}): TruthFile => ({ ...file, rows, ...over });

/** F61 plus `n` judged rows with truths cycling through every combination, ids 1..n. */
function bigFile(n: number): TruthFile {
  const balcony = ["street", "courtyard", "none", "undecidable"] as const;
  const windows = ["one", "twoOpposite", "corner", "undecidable", "one"] as const;
  const bedroom = ["street", "courtyard", "undecidable"] as const;
  const rows = [f61Row({ position: 1 })];
  for (let i = 1; i <= n; i++) {
    rows.push(judged(i, { position: i + 1, balconySide: balcony[i % 4], windowSides: windows[i % 5], bedroomSide: bedroom[i % 3], livingOnBalconySide: i % 2 ? "yes" : "no" }));
  }
  return fileOf(rows);
}

describe("selectTruthSet", () => {
  it("takes decided balcony or bedroom rows and Folkungagatan 61, then window-only rows, and leaves out rows with nothing decided", () => {
    const rows = [
      f61Row({ windowSides: "undecidable" }),
      judged(1, { balconySide: "street" }),
      judged(2, { bedroomSide: "courtyard" }),
      judged(3, { balconySide: "none", windowSides: "one" }), // window-only
      judged(4, { windowSides: "corner" }), // window-only
      judged(5), // nothing decided
      judged(6, { balconySide: "none" }), // none is not a decided side: nothing decided
    ];
    const out = selectTruthSet(fileOf(rows), "14.5");
    expect(out.map((r) => [r.booliId, r.inSet])).toEqual([
      [150148, true],
      [1, true],
      [2, true],
      [3, true],
      [4, true],
      [5, false],
      [6, false],
    ]);
  });

  it("excludes rows whose pictures were unavailable", () => {
    const rows = [f61Row(), judged(1, { balconySide: "street" }), judged(2, { balconySide: "courtyard" })];
    const out = selectTruthSet(fileOf(rows, { unavailable: [2] }), "14.5");
    expect(out.find((r) => r.booliId === 2)?.inSet).toBe(false);
    expect(out.find((r) => r.booliId === 1)?.inSet).toBe(true);
  });

  it("caps the set at 60 rows, keeping Folkungagatan 61 and the decided-side rows before window-only rows", () => {
    const out = selectTruthSet(bigFile(120), "14.5");
    const inSet = out.filter((r) => r.inSet);
    expect(inSet).toHaveLength(TRUTH_SET_MAX_ROWS);
    expect(inSet.some((r) => r.booliId === 150148)).toBe(true);
    // 120 judged rows hold more than 59 side-decided rows, so no window-only row can be in the set
    expect(inSet.every((r) => r.booliId === 150148 || r.balconySide === "street" || r.balconySide === "courtyard" || r.bedroomSide !== "undecidable")).toBe(true);
  });

  it("fills with window-only rows in seeded order until the pool is empty", () => {
    const rows = [f61Row(), judged(1, { balconySide: "street" })];
    for (let i = 10; i < 20; i++) rows.push(judged(i, { windowSides: "one" }));
    const out = selectTruthSet(fileOf(rows), "14.5");
    expect(out.filter((r) => r.inSet)).toHaveLength(12);
    const small = selectTruthSet(fileOf(rows.slice(0, 5)), "14.5");
    expect(small.filter((r) => r.inSet)).toHaveLength(5);
  });

  it("is deterministic and does not touch split or order", () => {
    const a = selectTruthSet(bigFile(60), "14.5");
    expect(selectTruthSet(bigFile(60), "14.5")).toEqual(a);
    expect(a.every((r) => r.split === null && r.order === null)).toBe(true);
  });
});

describe("assignSplit", () => {
  const selected = selectTruthSet(bigFile(70), "14.5");
  const out = assignSplit(selected, "14.5");
  const inSet = out.filter((r) => r.inSet);
  const stratumOf = (r: TruthRow) => `${r.balconySide === "street" || r.balconySide === "courtyard"}|${r.bedroomSide !== "undecidable"}|${r.windowSides}`;

  it("puts Folkungagatan 61 in the holdout", () => {
    expect(out.find((r) => r.booliId === 150148)?.split).toBe("holdout");
  });

  it("gives every set row a split and a unique read order 1..n, and no one else", () => {
    expect(inSet.every((r) => r.split !== null && r.order !== null)).toBe(true);
    expect(inSet.map((r) => r.order).sort((a, b) => (a as number) - (b as number))).toEqual(inSet.map((_, i) => i + 1));
    expect(out.filter((r) => !r.inSet).every((r) => r.split === null && r.order === null)).toBe(true);
  });

  it("keeps the two halves within one row of each other in every stratum", () => {
    const strata = new Map<string, { dev: number; holdout: number }>();
    for (const r of inSet) {
      const c = strata.get(stratumOf(r)) ?? { dev: 0, holdout: 0 };
      c[r.split as "dev" | "holdout"] += 1;
      strata.set(stratumOf(r), c);
    }
    expect(strata.size).toBeGreaterThan(1);
    for (const c of strata.values()) expect(Math.abs(c.dev - c.holdout)).toBeLessThanOrEqual(1);
  });

  it("orders the read by seeded rank across the whole set", () => {
    const byOrder = [...inSet].sort((a, b) => (a.order as number) - (b.order as number));
    const ranks = byOrder.map((r) => seededRank("14.5", r.booliId));
    expect(ranks).toEqual([...ranks].sort());
  });

  it("is deterministic", () => {
    expect(assignSplit(selected, "14.5")).toEqual(out);
  });
});

describe("rowsHashOf", () => {
  it("is 16 hex characters, stable, and changes when any field of a row changes", () => {
    const rows = bigFile(5).rows;
    const h = rowsHashOf(rows);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(rowsHashOf(rows)).toBe(h);
    expect(rowsHashOf([{ ...rows[0], note: "annan notering" }, ...rows.slice(1)])).not.toBe(h);
    expect(rowsHashOf([{ ...rows[0], split: "dev" }, ...rows.slice(1)])).not.toBe(h);
  });
  it("does not depend on key order", () => {
    const rows = bigFile(3).rows;
    const reordered = rows.map((r) => Object.fromEntries(Object.entries(r).reverse())) as TruthRow[];
    expect(rowsHashOf(reordered)).toBe(rowsHashOf(rows));
  });
});

describe("lockTruthFile", () => {
  const NOW = "2026-10-17T16:30:00.000Z";
  const procedure = "Så bedöms en lägenhet.";
  const locked = lockTruthFile(bigFile(90), { seed: "14.5", procedureText: procedure, now: NOW });

  it("writes the lock fields, the split, the order and the triage counts", () => {
    expect(locked.lockedAt).toBe(NOW);
    expect(locked.seed).toBe("14.5");
    expect(locked.rowsHash).toBe(rowsHashOf(locked.rows));
    expect(locked.procedureHash).toBe(createHash("sha256").update(procedure).digest("hex").slice(0, 16));
    expect(locked.selectionRule).toMatch(/\S/);
    expect(locked.triage).toMatchObject({ judged: 90, unavailable: 0 });
    // over all judged rows, not only the set: i % 4 in {0,1} are street/courtyard of 90 -> 45
    expect(locked.triage?.balconyDecided).toBe(45);
    expect(locked.rows.filter((r) => r.inSet)).toHaveLength(TRUTH_SET_MAX_ROWS);
    expect(locked.rows.find((r) => r.booliId === 150148)?.split).toBe("holdout");
  });

  it("passes validation as locked", () => {
    expect(validateTruthFile(locked, { requireLocked: true })).toEqual({ ok: true, error: null });
  });

  it("refuses to lock an already locked file", () => {
    expect(() => lockTruthFile(locked, { seed: "14.5", procedureText: procedure, now: NOW })).toThrow(/redan låst/);
  });

  it("does not change the input file", () => {
    const input = bigFile(60);
    const copy = JSON.stringify(input);
    lockTruthFile(input, { seed: "14.5", procedureText: procedure, now: NOW });
    expect(JSON.stringify(input)).toBe(copy);
  });
});

describe("validateTruthFile", () => {
  const NOW = "2026-10-17T16:30:00.000Z";
  const locked = () => lockTruthFile(bigFile(90), { seed: "14.5", procedureText: "p", now: NOW });
  const err = (f: TruthFile, requireLocked = false) => validateTruthFile(f, { requireLocked }).error;

  it("accepts the unlocked fixture, and refuses it with requireLocked", () => {
    expect(validateTruthFile(file, { requireLocked: false })).toEqual({ ok: true, error: null });
    const v = validateTruthFile(file, { requireLocked: true });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/olåst|låst/);
  });

  it("row 1 must be Folkungagatan 61 with source known", () => {
    expect(err(fileOf([{ ...file.rows[1] }, { ...file.rows[0] }]))).toMatch(/rad 1/);
    expect(err(fileOf([{ ...file.rows[0], source: "judged" }, ...file.rows.slice(1)]))).toMatch(/rad 1/);
  });

  it("Booli ids must be unique", () => {
    expect(err(fileOf([file.rows[0], file.rows[1], { ...file.rows[1] }]))).toMatch(/unik|dubblett|flera gånger/);
  });

  it("split and order may only be set on rows in the set", () => {
    const rows = [...file.rows.slice(0, 2), { ...file.rows[2], inSet: false, split: "dev" as const }];
    expect(err(fileOf(rows))).toMatch(/urval/);
    const rows2 = [...file.rows.slice(0, 2), { ...file.rows[2], inSet: false, order: 3 }];
    expect(err(fileOf(rows2))).toMatch(/urval/);
  });

  it("a locked file whose row was edited fails the hash check", () => {
    const f = locked();
    const tampered = { ...f, rows: f.rows.map((r, i) => (i === 3 ? { ...r, balconySide: r.balconySide === "street" ? ("courtyard" as const) : ("street" as const) } : r)) };
    expect(err(tampered)).toMatch(/hash/i);
    const victim = f.rows.find((r) => r.inSet && r.booliId !== 150148);
    expect(victim).toBeDefined();
    const moved = { ...f, rows: f.rows.map((r) => (r.booliId === victim?.booliId ? { ...r, split: r.split === "dev" ? ("holdout" as const) : ("dev" as const) } : r)) };
    expect(err(moved)).toMatch(/hash/i);
  });

  it("a locked file needs 25 to 60 rows in the set, Folkungagatan 61 in the holdout and both halves non-empty", () => {
    const f = locked();
    // hash recomputed so only the rule under test fails
    const rehash = (rows: TruthRow[]): TruthFile => ({ ...f, rows, rowsHash: rowsHashOf(rows) });
    const fewer = rehash(f.rows.map((r, i) => (r.inSet && i > 10 ? { ...r, inSet: false, split: null, order: null } : r)));
    expect(err(fewer)).toMatch(/25/);
    const f61Dev = rehash(f.rows.map((r) => (r.booliId === 150148 ? { ...r, split: "dev" as const } : r)));
    expect(err(f61Dev)).toMatch(/holdout/);
    const allHoldout = rehash(f.rows.map((r) => (r.inSet ? { ...r, split: "holdout" as const } : r)));
    expect(err(allHoldout)).toMatch(/dev/);
    const missing = rehash(f.rows.map((r, i) => (r.inSet && i === 5 ? { ...r, split: null } : r)));
    expect(err(missing)).toMatch(/split|order|saknar/);
  });

  it("a locked file must carry all lock fields", () => {
    const f = locked();
    expect(err({ ...f, procedureHash: null })).toMatch(/procedur/);
    expect(err({ ...f, rowsHash: null })).toMatch(/hash/i);
  });
});
