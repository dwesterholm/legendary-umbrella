/**
 * valuation-report.ts - the run-record contract that freezes a fit ranking so the
 * before/after valuation report (Phase 14.4, VAL-05) has a real "before".
 *
 * Why it exists (R-05): once the 20 % credit cap is deleted and the hedonic model
 * is refitted, today's numbers cannot be recomputed without checking out an old
 * commit. The replay therefore writes one record per run (`--json <fil>`): every
 * ranked row with its uncapped gap, its credited gap, its profit and its flag
 * strings, plus the model and snapshot the numbers came from, so a later report
 * can refuse a "before" that was not taken with the version-1 model.
 *
 * PURE: no file-system import, no clock, no network, no console. The script does the
 * writing; this file only defines the shape, builds it from a ranking and parses it
 * back from untrusted JSON.
 *
 * Flags are PLAIN STRINGS here, not the `FitFlag` union. A later plan deletes the
 * `creditCapped` flag from that union; a frozen record that still carries it must
 * keep parsing. Row objects are loose for the same reason: later plans add fields
 * (expected final price against the model, residual, overbid source) without a
 * version bump.
 *
 * STRUCTURAL SEPARATION (D-16): `niche-score.ts` and `report/flags.ts` must NEVER
 * import this file. The static-grep invariant in `niche-score.test.ts` registers the
 * prefix `discovery/valuation-` for that.
 */

import { z } from "zod/v4";
import {
  RESIDUAL_FLAG_BASIS,
  fitScore,
  residualFlagFires,
  type FitInputRow,
  type FitScoreResult,
} from "@/lib/discovery/fit-score";
import type { HedonicModel } from "@/lib/discovery/hedonic-model";

/** Bumped only when a field the report reads changes meaning or is removed. */
export const FIT_RUN_RECORD_VERSION = 1;

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const numOrNull = z.number().nullable();

/** One ranked or not-comparable row, money unrounded. Unknown extra keys are kept. */
const fitRunRowSchema = z.looseObject({
  /** 1-based position among the ranked rows; null for a row that is not comparable. */
  rank: z.number().int().min(1).nullable(),
  /** The pre-rank key: the listing URL, else `address|asking price`. */
  key: z.string(),
  booliId: numOrNull,
  address: z.string().nullable(),
  district: z.string(),
  livingArea: numOrNull,
  askingSek: numOrNull,
  predKrPerSqm: numOrNull,
  askToPred: numOrNull,
  resaleSek: numOrNull,
  purchaseSek: numOrNull,
  overbidPct: numOrNull,
  /** Resale minus expected final price, before any cap. */
  gapSek: numOrNull,
  /** The part of the gap the profit took credit for. */
  creditSek: numOrNull,
  profitSek: numOrNull,
  renoSek: z.number(),
  tasteSek: z.number(),
  taxSek: z.number(),
  renoTier: z.string(),
  /** Plain strings: a flag a later plan deletes from the FitFlag union must still parse. */
  flags: z.array(z.string()),
  featuresImputed: z.array(z.string()),
  notComparableReason: z.string().nullable(),
});

export type FitRunRow = z.infer<typeof fitRunRowSchema>;

export const fitRunRecordSchema = z.object({
  version: z.literal(FIT_RUN_RECORD_VERSION),
  kind: z.literal("fit-replay"),
  /** The snapshot's own date (YYYY-MM-DD). */
  snapshotAsOf: dateString,
  /** Repo-relative path of the snapshot file the replay read. */
  snapshotFile: z.string(),
  /** Which model produced the numbers. */
  model: z.object({
    version: z.number(),
    asOf: dateString,
    n: z.number(),
    r2: z.number(),
    cvRmseLog: z.number(),
    residualSdLog: z.number(),
    bidPremiumKind: z.string(),
  }),
  /** The first "Sol:" line of the run, i.e. which sun source the numbers used. */
  sunLine: z.string(),
  ranked: z.array(fitRunRowSchema),
  notComparable: z.array(fitRunRowSchema),
});

export type FitRunRecord = z.infer<typeof fitRunRecordSchema>;

/** The same key rule the pre-rank map uses (`fitRowKey` in fit-pipeline), kept inline so this file stays pure. */
function rowKeyOf(r: FitScoreResult): string {
  return r.sourceListingUrl ?? `${r.address}|${r.askingSek}`;
}

function rowOf(r: FitScoreResult, rank: number | null): FitRunRow {
  return {
    rank,
    key: rowKeyOf(r),
    booliId: r.booliId,
    address: r.address,
    district: r.district,
    livingArea: r.livingArea,
    askingSek: r.askingSek,
    predKrPerSqm: r.predKrPerSqm,
    askToPred: r.askToPred,
    resaleSek: r.resaleSek,
    purchaseSek: r.purchaseSek,
    overbidPct: r.overbidPct,
    gapSek: r.gapSek,
    creditSek: r.creditSek,
    profitSek: r.profitSek,
    renoSek: r.renoSek,
    tasteSek: r.tasteSek,
    taxSek: r.taxSek,
    renoTier: r.renoTier,
    flags: [...r.flags],
    featuresImputed: [...r.featuresImputed],
    notComparableReason: r.notComparableReason,
    // Extra keys (kept by the loose row schema, absent from a pre-14.4 record): what the
    // before/after report needs about the expected final price and the bid premium.
    expectedFinalToPred: r.expectedFinalToPred,
    residualPct: r.residualPct,
    overbidLabel: r.overbidDetail?.label ?? null,
    overbidPctDetail: r.overbidDetail?.pct ?? null,
  };
}

/** Builds the record for one replay. Money is passed through unrounded. */
export function fitRunRecordOf(input: {
  readonly snapshotAsOf: string;
  readonly snapshotFile: string;
  readonly model: HedonicModel;
  readonly sunLine: string;
  readonly ranking: {
    readonly ranked: readonly FitScoreResult[];
    readonly notComparable: readonly FitScoreResult[];
  };
}): FitRunRecord {
  const { model } = input;
  return {
    version: FIT_RUN_RECORD_VERSION,
    kind: "fit-replay",
    snapshotAsOf: input.snapshotAsOf,
    snapshotFile: input.snapshotFile,
    model: {
      version: model.version,
      asOf: model.asOf,
      n: model.n,
      r2: model.r2,
      cvRmseLog: model.cvRmseLog,
      residualSdLog: model.residualSdLog,
      bidPremiumKind: model.bidPremium.kind,
    },
    sunLine: input.sunLine,
    ranked: input.ranking.ranked.map((r, i) => rowOf(r, i + 1)),
    notComparable: input.ranking.notComparable.map((r) => rowOf(r, null)),
  };
}

/** Parses an untrusted run record, or throws one readable Error. */
export function parseFitRunRecord(json: unknown): FitRunRecord {
  const result = fitRunRecordSchema.safeParse(json);
  if (result.success) return result.data;
  const issues = result.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
  throw new Error(`Invalid fit run record: ${issues}`);
}

// ---------------------------------------------------------------------------
// The before/after report (Phase 14.4, VAL-05, D-06, R-04, R-05)
// ---------------------------------------------------------------------------

/**
 * The flag string the frozen version-1 record carries on a row whose credit was limited
 * to 20 % of resale. HISTORICAL: the scorer no longer produces it (14.4 removed the
 * ceiling); this file keeps the spelling so the frozen record can still be read.
 */
export const OLD_CAP_FLAG = "creditCapped";

/** The gap tolerance, in kr, between the recomputed new gap and the after record. */
const GAP_MATCH_TOLERANCE_SEK = 1;

/** What one flat's gap is with each fact left as it is, and with one fact set to unknown. */
export interface CounterfactualGap {
  /** Resale minus expected final price, the row scored as it is. */
  readonly gap: number;
  /** The gap with the monthly avgift set to unknown (the model then uses the training mean). */
  readonly avgiftAtMean: number;
  /** The gap with the association's debt set to unknown. */
  readonly debtAtMean: number;
  /** The gap with the land-lease fact set to unknown. */
  readonly tomtrattAtMean: number;
  /** The gap with the days on market set to unknown (the bid premium then uses the training mean). */
  readonly daysAtMean: number;
}

/** The same key rule as the run record's rows (`fitRowKey`): the listing URL, else `address|asking price`. */
export function inputRowKey(row: FitInputRow): string {
  const c = row.candidate;
  return c.sourceListingUrl ?? `${c.address}|${c.price}`;
}

/**
 * For every row that has a gap, the gap as is and with one fact at a time set to
 * unknown, scored by the real scorer on copies of the snapshot row. The sun is left
 * as stored: it moves taste, never the gap.
 */
export function counterfactualGaps(
  rows: readonly FitInputRow[],
  model: HedonicModel,
): Map<string, CounterfactualGap> {
  const out = new Map<string, CounterfactualGap>();
  for (const row of rows) {
    const base = fitScore(row, model);
    if (base.gapSek === null) continue;
    const facts = row.facts;
    const gapOf = (changed: FitInputRow): number => fitScore(changed, model).gapSek ?? base.gapSek ?? 0;
    const withFacts = (patch: Partial<NonNullable<FitInputRow["facts"]>>): FitInputRow =>
      facts === null ? row : { ...row, facts: { ...facts, ...patch } };
    out.set(inputRowKey(row), {
      gap: base.gapSek,
      avgiftAtMean: gapOf(withFacts({ avgiftMonthlySek: null })),
      debtAtMean: gapOf(withFacts({ brf: facts?.brf == null ? null : { ...facts.brf, debtPerSqm: null } })),
      tomtrattAtMean: gapOf(withFacts({ landLease: null })),
      daysAtMean: gapOf(withFacts({ daysOnMarket: null })),
    });
  }
  return out;
}

/**
 * Kr "explained" by each fact: the gap with that fact unknown minus the gap as it is.
 * Positive means the fact LOWERS the flat's value, i.e. it explains part of why the
 * flat looks cheap against the model; negative means it raises the value.
 * For days on market the number is the same difference for the bid premium.
 */
export function explainedKr(cf: CounterfactualGap): { avgift: number; debt: number; tomtratt: number; days: number } {
  return {
    avgift: cf.avgiftAtMean - cf.gap,
    debt: cf.debtAtMean - cf.gap,
    tomtratt: cf.tomtrattAtMean - cf.gap,
    days: cf.daysAtMean - cf.gap,
  };
}

/**
 * One row that was limited by the old ceiling, followed through four steps:
 * old credit -> old gap (ceiling removed) -> intermediate gap (old features, refitted on today's
 * data, same bid premium) -> new gap (with avgift, debt, tomträtt). Every `...Kr` below is a signed
 * change in the credit; the six parts add up to `newGap - oldCredit` exactly.
 */
export interface CappedRow {
  readonly key: string;
  readonly booliId: number | null;
  readonly address: string | null;
  readonly oldRank: number;
  /** Rank in the after record; null when the row is no longer ranked. */
  readonly newRank: number | null;
  readonly oldCredit: number;
  readonly oldGap: number;
  readonly intermediateGap: number;
  /** The new credit: the full new gap. */
  readonly newGap: number;
  /** oldGap - oldCredit: what the ceiling used to hide. */
  readonly capRemovedKr: number;
  /** intermediateGap - oldGap: the refit (balcony and build-year switch, new coefficients, new bid premium). */
  readonly refitKr: number;
  /** Change in the credit caused by the avgift fact (negative = the avgift lowers the value). */
  readonly avgiftKr: number;
  readonly debtKr: number;
  readonly tomtrattKr: number;
  /** The remainder: (newGap - intermediateGap) - avgift - debt - tomträtt (refitted floor, location and size terms, interaction). */
  readonly ovrigtKr: number;
  /** Memo, not an extra part: how much the days-on-market term moved the new gap (sits inside the refit and rest). */
  readonly daysKr: number;
  /** The after row's distance from the model on the basis in force (negative = below the model). */
  readonly residualPct: number | null;
  readonly flagExpectedFinal: boolean;
  readonly flagAsking: boolean;
}

export interface ValuationReportInputs {
  readonly before: FitRunRecord;
  readonly intermediate: FitRunRecord;
  readonly after: FitRunRecord;
  readonly counterfactual: ReadonlyMap<string, CounterfactualGap>;
  readonly afterModel: HedonicModel;
}

export interface ValuationReport {
  readonly snapshotAsOf: string;
  readonly beforeModel: FitRunRecord["model"];
  readonly intermediateModel: FitRunRecord["model"];
  readonly afterModelSummary: FitRunRecord["model"];
  readonly residualBasis: typeof RESIDUAL_FLAG_BASIS;
  readonly cappedRows: CappedRow[];
}

type RunRow = FitRunRecord["ranked"][number];

function indexByKey(record: FitRunRecord): Map<string, RunRow> {
  const m = new Map<string, RunRow>();
  for (const r of record.ranked) m.set(r.key, r);
  for (const r of record.notComparable) if (!m.has(r.key)) m.set(r.key, r);
  return m;
}

function numberOf(value: number | null | undefined, what: string, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Raden ${key} saknar ${what} i körningsposten`);
  }
  return value;
}

/** A number kept as an extra key on a record row, or null. */
function extraNumber(row: RunRow, name: string): number | null {
  const v = (row as Record<string, unknown>)[name];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The after row's two ratios to the model: asking and expected final, each as price per m2 over the model's. */
function ratiosOf(row: RunRow): { askToPred: number; expectedFinalToPred: number } | null {
  const ask = row.askToPred;
  const stored = extraNumber(row, "expectedFinalToPred");
  const derived =
    row.purchaseSek !== null && row.livingArea !== null && row.predKrPerSqm !== null && row.livingArea > 0 && row.predKrPerSqm > 0
      ? row.purchaseSek / row.livingArea / row.predKrPerSqm
      : null;
  const expectedFinalToPred = stored ?? derived;
  if (ask === null || expectedFinalToPred === null) return null;
  return { askToPred: ask, expectedFinalToPred };
}

/**
 * Combines the frozen before record, the intermediate record and the after record into the
 * report. Refuses a before record that is not from the version-1 model, and stops when the
 * gap recomputed from the snapshot and the committed model differs from the after record by
 * more than 1 kr for any row (the three records and the model must belong together).
 */
export function buildValuationReport(input: ValuationReportInputs): ValuationReport {
  const { before, intermediate, after, counterfactual, afterModel } = input;
  if (before.model.version !== 1) throw new Error("Före-posten är inte från modell version 1");

  const afterByKey = indexByKey(after);
  const intermediateByKey = indexByKey(intermediate);

  // The records and the model must belong together: check every row the after record has a gap for.
  for (const [key, row] of afterByKey) {
    if (row.gapSek === null) continue;
    const cf = counterfactual.get(key);
    if (cf === undefined) throw new Error(`Raden ${key} finns i efter-posten men inte i snapshoten`);
    if (Math.abs(cf.gap - row.gapSek) > GAP_MATCH_TOLERANCE_SEK) {
      throw new Error(
        `Raden ${key}: skillnaden räknad från snapshot och modell (${cf.gap}) avviker från efter-posten (${row.gapSek}) med mer än ${GAP_MATCH_TOLERANCE_SEK} kr`,
      );
    }
  }

  const cappedRows: CappedRow[] = [];
  for (const old of before.ranked) {
    if (!old.flags.includes(OLD_CAP_FLAG)) continue;
    const key = old.key;
    const nowRow = afterByKey.get(key);
    const midRow = intermediateByKey.get(key);
    const cf = counterfactual.get(key);
    if (nowRow === undefined) throw new Error(`Raden ${key} finns i före-posten men inte i efter-posten`);
    if (midRow === undefined) throw new Error(`Raden ${key} finns i före-posten men inte i mellanposten`);
    if (cf === undefined) throw new Error(`Raden ${key} finns i före-posten men inte i snapshoten`);

    const oldCredit = numberOf(old.creditSek, "krediterad del", key);
    const oldGap = numberOf(old.gapSek, "skillnad", key);
    const intermediateGap = numberOf(midRow.gapSek, "skillnad (mellanposten)", key);
    const newGap = numberOf(nowRow.gapSek, "skillnad (efter-posten)", key);
    // Change in the credit caused by each fact = the gap as it is minus the gap with the fact unknown
    // (written this way round so an unused feature gives +0, not -0).
    const avgiftKr = cf.gap - cf.avgiftAtMean;
    const debtKr = cf.gap - cf.debtAtMean;
    const tomtrattKr = cf.gap - cf.tomtrattAtMean;
    const ratios = ratiosOf(nowRow);
    const residualBasis = RESIDUAL_FLAG_BASIS;
    const sd = afterModel.residualSdLog;

    cappedRows.push({
      key,
      booliId: old.booliId,
      address: old.address,
      oldRank: numberOf(old.rank, "plats", key),
      newRank: nowRow.rank,
      oldCredit,
      oldGap,
      intermediateGap,
      newGap,
      capRemovedKr: oldGap - oldCredit,
      refitKr: intermediateGap - oldGap,
      avgiftKr,
      debtKr,
      tomtrattKr,
      ovrigtKr: newGap - intermediateGap - avgiftKr - debtKr - tomtrattKr,
      daysKr: cf.gap - cf.daysAtMean,
      residualPct: ratios === null ? null : (residualBasis === "asking" ? ratios.askToPred : ratios.expectedFinalToPred) - 1,
      flagExpectedFinal: ratios !== null && residualFlagFires("expectedFinal", ratios, sd),
      flagAsking: ratios !== null && residualFlagFires("asking", ratios, sd),
    });
  }
  cappedRows.sort((a, b) => a.oldRank - b.oldRank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return {
    snapshotAsOf: after.snapshotAsOf,
    beforeModel: before.model,
    intermediateModel: intermediate.model,
    afterModelSummary: after.model,
    residualBasis: RESIDUAL_FLAG_BASIS,
    cappedRows,
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering (Swedish labels, decimal comma, space thousands)
// ---------------------------------------------------------------------------

/** Whole kronor with a space between thousands and a plain minus sign. */
function kr(value: number): string {
  const rounded = Math.round(value);
  const digits = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return rounded < 0 ? `-${digits}` : digits;
}

/** A signed whole-kronor change: "+1 234" / "-1 234" / "0". */
function krSigned(value: number): string {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${kr(rounded)}` : kr(rounded);
}

/** A signed percentage with a decimal comma: 0.123 -> "+12,3 %". */
function pctSigned(fraction: number, decimals = 1): string {
  const text = (Math.abs(fraction) * 100).toFixed(decimals).replace(".", ",");
  const zero = /^0(,0+)?$/.test(text);
  return `${fraction < 0 && !zero ? "-" : "+"}${text} %`;
}

const yesNo = (flag: boolean): string => (flag ? "ja" : "nej");

/** A Markdown table cell: a pipe or newline in a name must not break the table. */
function cell(text: string | null): string {
  return (text ?? "-").replace(/\|/g, "/").replace(/\r?\n/g, " ");
}

function cappedTableMd(report: ValuationReport): string[] {
  const lines: string[] = [
    "## Rows that hit the 20 % ceiling before",
    "",
    `${report.cappedRows.length} rows carried the old ceiling flag in the frozen record. Each row is followed from the old credit to the new one. Every kr column is a change in the credit (+ raises it, - lowers it), and from "Tak borttaget" onwards they add up to "Skillnad efter" minus "Kredit före".`,
    "",
    "| Adress | Plats före -> efter | Kredit före | Tak borttaget | Ny anpassning | Avgift | BRF-skuld | Tomträtt | Övrigt | Skillnad efter | Residual | Flagga (förv. slutpris / utgångspris) |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const r of report.cappedRows) {
    lines.push(
      `| ${cell(r.address)} | ${r.oldRank} -> ${r.newRank ?? "-"} | ${kr(r.oldCredit)} | ${krSigned(r.capRemovedKr)} | ${krSigned(r.refitKr)} | ${krSigned(r.avgiftKr)} | ${krSigned(r.debtKr)} | ${krSigned(r.tomtrattKr)} | ${krSigned(r.ovrigtKr)} | ${kr(r.newGap)} | ${r.residualPct === null ? "-" : pctSigned(r.residualPct)} | ${yesNo(r.flagExpectedFinal)} / ${yesNo(r.flagAsking)} |`,
    );
  }
  const sum = (pick: (r: CappedRow) => number): number => report.cappedRows.reduce((acc, r) => acc + pick(r), 0);
  lines.push(
    `| **Summa** | | ${kr(sum((r) => r.oldCredit))} | ${krSigned(sum((r) => r.capRemovedKr))} | ${krSigned(sum((r) => r.refitKr))} | ${krSigned(sum((r) => r.avgiftKr))} | ${krSigned(sum((r) => r.debtKr))} | ${krSigned(sum((r) => r.tomtrattKr))} | ${krSigned(sum((r) => r.ovrigtKr))} | ${kr(sum((r) => r.newGap))} | | ${report.cappedRows.filter((r) => r.flagExpectedFinal).length} / ${report.cappedRows.filter((r) => r.flagAsking).length} rader |`,
    "",
    '"Ny anpassning" is the model refitted on today\'s data with the old six features and the same bid premium: the balcony and build-year effects, the other coefficients and the days-on-market term. "Övrigt" is what is left of the move from that model to the new one after avgift, debt and tomträtt are taken out: the refitted floor, location and size terms and the way the effects combine. Tomträtt is 0 because the model could not estimate it (no leasehold sales in the data).',
  );
  return lines;
}

/** The report as Markdown. English prose, Swedish labels, decimal comma and space thousands. */
export function renderValuationReportMd(report: ValuationReport): string {
  const lines: string[] = [
    "# Valuation report: what replacing the 20 % ceiling with real features did (VAL-05)",
    "",
    `Snapshot ${report.snapshotAsOf}. Before = the frozen run with the version-${report.beforeModel.version} model and the ceiling on. After = the committed model (version ${report.afterModelSummary.version}) with no ceiling. Offline replay of stored data: nothing was fetched and no setting was changed.`,
    "",
    'How to read this: "Kredit" is the part of a flat\'s gap (renovated resale value minus expected final price) that the profit counts. The old ceiling cut it at 20 % of resale; now it is the whole gap. Every row below shows where its credit moved and which cause moved it, in kronor.',
    "",
    ...cappedTableMd(report),
    "",
  ];
  return lines.join("\n");
}
