// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AccuracyField, AccuracyReport, FieldReport, Precision } from "@/lib/discovery/layout-accuracy";
import { wilson } from "@/lib/discovery/layout-accuracy";
import { compareVariants, parseRoundLog, renderComparisonMd } from "@/lib/discovery/layout-compare";

const prec = (k: number, n: number): Precision => ({ k, n, precision: n === 0 ? null : k / n, ...wilson(k, n) });

function field(over: Partial<FieldReport>): FieldReport {
  return {
    measurable: true,
    decidedRows: 20,
    curveDev: [],
    gate: 0.5,
    dev: prec(6, 6),
    holdout: prec(5, 5),
    pooled: prec(11, 11),
    allCalls: null,
    pass: true,
    reason: null,
    ...over,
  };
}

const unmeasurableBedroom = field({ measurable: false, decidedRows: 9, gate: null, dev: null, holdout: null, pooled: null, pass: false, reason: "ej mätbart (n = 9)" });

function report(source: string, fields: Partial<Record<AccuracyField, FieldReport>>): AccuracyReport {
  const f = { balcony: field({}), korsdrag: field({}), bedroom: unmeasurableBedroom, ...fields };
  const raw = (c: number, r: number, d: number) => ({ correct: c, read: r, decided: d, undecidable: 0 });
  return {
    source,
    version: "v",
    truthLocked: true,
    lockedAt: "2026-10-24",
    rows: 60,
    noRead: 0,
    raw: { balcony: raw(12, 14, 14), korsdrag: raw(50, 59, 59), bedroom: raw(1, 2, 9) },
    measurability: {
      balcony: { measurable: f.balcony.measurable, decided: f.balcony.decidedRows, reason: null },
      korsdrag: { measurable: f.korsdrag.measurable, decided: f.korsdrag.decidedRows, reason: null },
      bedroom: { measurable: f.bedroom.measurable, decided: f.bedroom.decidedRows, reason: "ej mätbart (n = 9)" },
    },
    sideEvidence: ["cars", "courtyardGreenery"],
    byEvidence: { dev: [], holdout: [] },
    fields: f,
    livingOnBalconySide: { decided: 0, read: 0, correct: 0 },
    pass: f.balcony.pass && f.korsdrag.pass && f.bedroom.pass,
  };
}

const stats = (calls: number, roundSek: number, seconds: number | null = null) => ({ calls, roundSek, seconds });

describe("parseRoundLog", () => {
  it("reads calls and kronor from the round summary line", () => {
    const log = "ANTHROPIC_API_KEY: satt\n123 read 0,52 kr\nOmgång c: 59 anrop, 1 från cache, 0 över taket, 0 misslyckade; 35,12 kr denna omgång (tak 40,00 kr), totalt 35,76 kr för varianten\n";
    expect(parseRoundLog(log)).toEqual({ calls: 59, roundSek: 35.12 });
  });

  it("returns null for a log without the summary line", () => {
    expect(parseRoundLog("Omgång c: ej körd (HTTP 400 i röktestet)\n")).toBeNull();
    expect(parseRoundLog("")).toBeNull();
  });
});

describe("compareVariants", () => {
  it("passes a variant when every measurable field passes, and the strict winner needs all three", () => {
    const c = compareVariants([
      { variant: "e", report: report("variant:e", {}), variantSek: 0.5, stats: stats(60, 0.5, 90) },
    ]);
    const e = c.columns.find((x) => x.variant === "e");
    expect(e?.passMeasurable).toBe(true);
    expect(e?.passAll).toBe(false);
    expect(c.measurableFields).toEqual(["balcony", "korsdrag"]);
    expect(c.unmeasurableFields).toEqual(["bedroom"]);
    expect(c.strictWinner).toBeNull();
    expect(c.productionCandidate).toBe("e");
  });

  it("picks the cheapest per flat among the passing variants, whatever the column order", () => {
    const c = compareVariants([
      { variant: "a", report: report("variant:a", {}), variantSek: 15, stats: stats(60, 15) },
      { variant: "c", report: report("variant:c", {}), variantSek: 36, stats: stats(60, 36) },
      { variant: "e", report: report("variant:e", {}), variantSek: 0.5, stats: stats(60, 0.5) },
    ]);
    expect(c.measurablePassing).toEqual(["a", "c", "e"]);
    expect(c.productionCandidate).toBe("e");
  });

  it("a tie on cost goes to the earlier column", () => {
    const c = compareVariants([
      { variant: "a", report: report("variant:a", {}), variantSek: 1, stats: stats(10, 1) },
      { variant: "b", report: report("variant:b", {}), variantSek: 1, stats: stats(10, 1) },
    ]);
    expect(c.productionCandidate).toBe("a");
  });

  it("names the failing field and how far under 75 % it is", () => {
    const failing = field({ pass: false, holdout: prec(4, 6), reason: "holdout-precisionen 4 av 6 (67 %) vid spärren 0,20 är under 75 %" });
    const c = compareVariants([{ variant: "b", report: report("variant:b", { balcony: failing }), variantSek: 17, stats: stats(59, 16.79) }]);
    const b = c.columns.find((x) => x.variant === "b");
    expect(b?.passMeasurable).toBe(false);
    expect(b?.shortfalls).toHaveLength(1);
    expect(b?.shortfalls[0].field).toBe("balcony");
    expect(b?.shortfalls[0].text).toContain("8 procentenheter under kravet");
    expect(c.productionCandidate).toBeNull();
  });

  it("a variant with no measurable field never passes", () => {
    const none = (f: FieldReport) => ({ ...f, measurable: false, pass: false });
    const r = report("variant:a", { balcony: none(field({})), korsdrag: none(field({})) });
    const c = compareVariants([{ variant: "a", report: r, variantSek: 1, stats: stats(60, 1) }]);
    expect(c.columns[0].passMeasurable).toBe(false);
    expect(c.productionCandidate).toBeNull();
  });

  it("per-flat cost is the round's kronor over its live calls; a missing log gives null, never a guess", () => {
    const c = compareVariants([
      { variant: "a", report: report("variant:a", {}), variantSek: 15.45, stats: stats(60, 15.45, 600) },
      { variant: "b", report: report("variant:b", {}), variantSek: 17, stats: null },
    ]);
    expect(c.columns[0].sekPerFlat).toBeCloseTo(0.2575, 4);
    expect(c.columns[0].secondsPerFlat).toBe(10);
    expect(c.columns[1].sekPerFlat).toBeNull();
    expect(c.columns[1].secondsPerFlat).toBeNull();
  });

  it("leaves an unrun d tier out and lists a, b, c and e even without a report", () => {
    const c = compareVariants([{ variant: "a", report: report("variant:a", {}), variantSek: 1, stats: stats(60, 1) }]);
    expect(c.columns.map((x) => x.variant)).toEqual(["a", "b", "c", "e"]);
    expect(c.columns.filter((x) => !x.ran).map((x) => x.variant)).toEqual(["b", "c", "e"]);
  });
});

describe("renderComparisonMd", () => {
  it("has a column per variant, a kr per lägenhet row and a verdict section", () => {
    const c = compareVariants([
      { variant: "a", report: report("variant:a", {}), variantSek: 15.45, stats: stats(60, 15.45) },
      { variant: "e", report: report("variant:e", {}), variantSek: 0.52, stats: stats(60, 0.52, 120) },
    ]);
    const md = renderComparisonMd(c);
    expect(md).toContain("| Mått | a | b | c | e |");
    expect(md).toContain("| kr per lägenhet |");
    expect(md).toContain("| sekunder per lägenhet |");
    expect(md).toContain("Balkongsida: holdout");
    expect(md).toContain("Sovrumssida: avgjorda sanningsrader | 9 (ej mätbart)");
    expect(md).toContain("produktionskandidat enligt R-10: e");
    expect(md).toContain("Klarar alla tre fälten (kravet för brytaren, D-11): ingen.");
    expect(md).not.toMatch(/https?:|sk-ant/);
  });
});
