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
  RESIDUAL_FLAG_SD,
  fitScore,
  residualFlagFires,
  type FitInputRow,
  type FitScoreResult,
} from "@/lib/discovery/fit-score";
import { STAGE2_CAP_PCT, type HedonicModel } from "@/lib/discovery/hedonic-model";

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

/** How many rows each side-by-side list holds. */
const TOP_N = 15;

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
  /**
   * intermediateGap - oldGap: everything that changed between the frozen run and the model refitted with
   * the old six features: the balcony and build-year switch (stage 2), the refitted coefficients, and the
   * days-on-market term in the bid premium (`daysKr` below is that last part).
   */
  readonly refitKr: number;
  /** refitKr without the days term: the balcony and build-year switch and the refitted coefficients. */
  readonly refitExclDaysKr: number;
  /** Change in the credit caused by the avgift fact (negative = the avgift lowers the value). */
  readonly avgiftKr: number;
  readonly debtKr: number;
  readonly tomtrattKr: number;
  /** The remainder: (newGap - intermediateGap) - avgift - debt - tomträtt (refitted floor, location and size terms, interaction). */
  readonly ovrigtKr: number;
  /** The days-on-market term in the bid premium, measured in the intermediate model; it is a part of `refitKr`. */
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
  /** The same counterfactuals under the intermediate model; they separate the days term from the rest of the refit. */
  readonly intermediateCounterfactual: ReadonlyMap<string, CounterfactualGap>;
  readonly afterModel: HedonicModel;
  /** The snapshot rows all three records replayed; only the avgift/debt correlation reads them. */
  readonly snapshotRows?: readonly FitInputRow[];
}

/** The Booli id of the tracked listing, Folkungagatan 61. */
export const FOLKUNGAGATAN_61_BOOLI_ID = 150148;

/** One line of a top-15 list. */
export interface Top15Row {
  readonly rank: number;
  readonly key: string;
  readonly booliId: number | null;
  readonly address: string | null;
  readonly profitSek: number | null;
  /** The row's place among the OTHER record's first 15; null when it is not in that list. */
  readonly otherTop15Rank: number | null;
  /** The row's place in the other record's whole ranking; null when it is not ranked there. */
  readonly otherRank: number | null;
}

/** The numbers of one listing in one run. */
export interface ListingNumbers {
  readonly rank: number | null;
  readonly profitSek: number | null;
  readonly resaleSek: number | null;
  readonly expectedFinalSek: number | null;
  readonly overbidPct: number | null;
  readonly gapSek: number | null;
  readonly creditSek: number | null;
  readonly renoSek: number;
  readonly tasteSek: number;
}

export interface BidPremiumRow {
  readonly key: string;
  readonly address: string | null;
  readonly rank: number;
  readonly overbidBefore: number | null;
  readonly overbidAfter: number | null;
  /** The premium's makeup in the after run, e.g. "distrikt+pris+dagar"; null in a record that lacks it. */
  readonly labelAfter: string | null;
}

export interface ValuationReport {
  readonly snapshotAsOf: string;
  readonly beforeModel: FitRunRecord["model"];
  readonly intermediateModel: FitRunRecord["model"];
  readonly afterModelSummary: FitRunRecord["model"];
  readonly residualBasis: typeof RESIDUAL_FLAG_BASIS;
  readonly cappedRows: CappedRow[];
  readonly top15: { readonly before: Top15Row[]; readonly after: Top15Row[] };
  readonly folkungagatan61: {
    readonly before: ListingNumbers | null;
    readonly after: ListingNumbers | null;
    /** Old credit -> new gap, split by cause, for the listing whether or not it was ever capped. */
    readonly decomposition: CappedRow | null;
  };
  readonly creditRemoved: { readonly total: number; readonly top15: number; readonly rows: number };
  readonly residualCounts: {
    readonly n: number;
    readonly expectedFinal: number;
    readonly asking: number;
    readonly basisInForce: typeof RESIDUAL_FLAG_BASIS;
    readonly limitPct: number;
  };
  readonly bidPremium: {
    readonly top15: BidPremiumRow[];
    /** Mean of (after - before) overbid, as a fraction, over rows ranked in both with a premium in both. */
    readonly meanChange: number | null;
    readonly rowsInBoth: number;
    /** What the after model says about condition in the premium (BID-01, R-08): fitted and kept, or not measured. */
    readonly conditionLine: string;
  };
  readonly model: {
    readonly features: readonly {
      readonly name: string;
      readonly beta: number;
      readonly se: number | null;
      readonly source: string;
    }[];
    readonly balconyPct: number;
    readonly buildYearPct: { readonly le1930: number; readonly y1931to1960: number; readonly y1961to1990: number; readonly ge1991: number } | null;
    /** Stage-2 coefficients that sit exactly on the +-8 % limit the fit allows. */
    readonly onStage2Cap: string[];
    readonly daysTerm: { readonly beta: number; readonly kept: boolean } | null;
    readonly fallbacks: readonly string[];
    readonly n: { readonly before: number; readonly after: number };
    readonly r2: { readonly before: number; readonly after: number };
    readonly cvRmseLog: { readonly before: number; readonly after: number };
  };
  readonly avgiftDebtCorrelation: { readonly r: number | null; readonly n: number };
  readonly findings: string[];
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
  const { before, intermediate, after, counterfactual, intermediateCounterfactual, afterModel } = input;
  if (before.model.version !== 1) throw new Error("Före-posten är inte från modell version 1");

  const afterByKey = indexByKey(after);
  const intermediateByKey = indexByKey(intermediate);
  const beforeByKey = indexByKey(before);

  // The records and the models must belong together: check every row each run has a gap for.
  const checkGaps = (label: string, byKey: ReadonlyMap<string, RunRow>, cfs: ReadonlyMap<string, CounterfactualGap>): void => {
    for (const [key, row] of byKey) {
      if (row.gapSek === null) continue;
      const cf = cfs.get(key);
      if (cf === undefined) throw new Error(`Raden ${key} finns i ${label}-posten men inte i snapshoten`);
      if (Math.abs(cf.gap - row.gapSek) > GAP_MATCH_TOLERANCE_SEK) {
        throw new Error(
          `Raden ${key}: skillnaden räknad från snapshot och modell (${cf.gap}) avviker från ${label}-posten (${row.gapSek}) med mer än ${GAP_MATCH_TOLERANCE_SEK} kr`,
        );
      }
    }
  };
  checkGaps("efter", afterByKey, counterfactual);
  checkGaps("mellan", intermediateByKey, intermediateCounterfactual);

  const sd = afterModel.residualSdLog;

  /** Follows one before row from its old credit to the new gap; every part is a signed change in the credit. */
  const decompose = (old: RunRow): CappedRow => {
    const key = old.key;
    const nowRow = afterByKey.get(key);
    const midRow = intermediateByKey.get(key);
    const cf = counterfactual.get(key);
    const icf = intermediateCounterfactual.get(key);
    if (nowRow === undefined) throw new Error(`Raden ${key} finns i före-posten men inte i efter-posten`);
    if (midRow === undefined) throw new Error(`Raden ${key} finns i före-posten men inte i mellanposten`);
    if (cf === undefined || icf === undefined) throw new Error(`Raden ${key} finns i före-posten men inte i snapshoten`);

    const oldCredit = numberOf(old.creditSek, "krediterad del", key);
    const oldGap = numberOf(old.gapSek, "skillnad", key);
    const intermediateGap = numberOf(midRow.gapSek, "skillnad (mellanposten)", key);
    const newGap = numberOf(nowRow.gapSek, "skillnad (efter-posten)", key);
    // Change in the credit caused by each fact = the gap as it is minus the gap with the fact unknown
    // (written this way round so an unused feature gives +0, not -0).
    const avgiftKr = cf.gap - cf.avgiftAtMean;
    const debtKr = cf.gap - cf.debtAtMean;
    const tomtrattKr = cf.gap - cf.tomtrattAtMean;
    // The days term as the intermediate model has it: the gap as it is minus the gap with the days unknown.
    const daysKr = icf.gap - icf.daysAtMean;
    const ratios = ratiosOf(nowRow);
    return {
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
      refitExclDaysKr: intermediateGap - oldGap - daysKr,
      avgiftKr,
      debtKr,
      tomtrattKr,
      ovrigtKr: newGap - intermediateGap - avgiftKr - debtKr - tomtrattKr,
      daysKr,
      residualPct: ratios === null ? null : (RESIDUAL_FLAG_BASIS === "asking" ? ratios.askToPred : ratios.expectedFinalToPred) - 1,
      flagExpectedFinal: ratios !== null && residualFlagFires("expectedFinal", ratios, sd),
      flagAsking: ratios !== null && residualFlagFires("asking", ratios, sd),
    };
  };

  const cappedRows = before.ranked
    .filter((r) => r.flags.includes(OLD_CAP_FLAG))
    .map(decompose)
    .sort((a, b) => a.oldRank - b.oldRank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // Top 15, side by side. A row's place in the other record is its place in that record's whole ranking.
  const top15Of = (record: FitRunRecord, other: FitRunRecord): Top15Row[] => {
    const otherTop = new Map(other.ranked.slice(0, TOP_N).map((r, i) => [r.key, i + 1]));
    const otherAll = new Map(other.ranked.map((r) => [r.key, r.rank as number]));
    return record.ranked.slice(0, TOP_N).map((r, i) => ({
      rank: i + 1,
      key: r.key,
      booliId: r.booliId,
      address: r.address,
      profitSek: r.profitSek,
      otherTop15Rank: otherTop.get(r.key) ?? null,
      otherRank: otherAll.get(r.key) ?? null,
    }));
  };

  // Folkungagatan 61, wherever it sits in each record.
  const numbersOf = (row: RunRow | undefined): ListingNumbers | null =>
    row === undefined
      ? null
      : {
          rank: row.rank,
          profitSek: row.profitSek,
          resaleSek: row.resaleSek,
          expectedFinalSek: row.purchaseSek,
          overbidPct: row.overbidPct,
          gapSek: row.gapSek,
          creditSek: row.creditSek,
          renoSek: row.renoSek,
          tasteSek: row.tasteSek,
        };
  const findFolk = (record: FitRunRecord): RunRow | undefined =>
    [...record.ranked, ...record.notComparable].find((r) => r.booliId === FOLKUNGAGATAN_61_BOOLI_ID);
  const folkBefore = findFolk(before);
  const folkAfter = findFolk(after);
  const folkDecomposition =
    folkBefore !== undefined && folkAfter !== undefined && folkBefore.rank !== null && folkBefore.gapSek !== null && folkBefore.creditSek !== null
      ? decompose(folkBefore)
      : null;

  // Credit the ceiling hid: gap minus credit over the before rows.
  const hiddenOf = (r: RunRow): number => (r.gapSek !== null && r.creditSek !== null ? r.gapSek - r.creditSek : 0);
  const creditRemoved = {
    total: before.ranked.reduce((acc, r) => acc + hiddenOf(r), 0),
    top15: before.ranked.slice(0, TOP_N).reduce((acc, r) => acc + hiddenOf(r), 0),
    rows: before.ranked.filter((r) => hiddenOf(r) > 0).length,
  };

  // The residual flag on both bases, over the after rows.
  let flaggedExpectedFinal = 0;
  let flaggedAsking = 0;
  let counted = 0;
  for (const r of after.ranked) {
    const ratios = ratiosOf(r);
    if (ratios === null) continue;
    counted += 1;
    if (residualFlagFires("expectedFinal", ratios, sd)) flaggedExpectedFinal += 1;
    if (residualFlagFires("asking", ratios, sd)) flaggedAsking += 1;
  }

  // Bid premium: the after top 15 against the same rows before, and the mean change over rows in both.
  const bidTop15: BidPremiumRow[] = after.ranked.slice(0, TOP_N).map((r, i) => ({
    key: r.key,
    address: r.address,
    rank: i + 1,
    overbidBefore: beforeByKey.get(r.key)?.overbidPct ?? null,
    overbidAfter: r.overbidPct,
    labelAfter: typeof (r as Record<string, unknown>).overbidLabel === "string" ? ((r as Record<string, unknown>).overbidLabel as string) : null,
  }));
  const changes: number[] = [];
  for (const r of after.ranked) {
    const b = beforeByKey.get(r.key);
    if (b !== undefined && b.rank !== null && b.overbidPct !== null && r.overbidPct !== null) changes.push(r.overbidPct - b.overbidPct);
  }

  // The model block.
  const by = afterModel.stage2.buildYear;
  const onStage2Cap: string[] = [];
  const onCap = (x: number): boolean => Math.abs(Math.abs(x) - STAGE2_CAP_PCT) < 1e-9;
  if (onCap(afterModel.stage2.balcony.pct)) onStage2Cap.push(`balkong ${pctSigned(afterModel.stage2.balcony.pct)}`);
  if (by !== null) {
    const labels = { le1930: "byggår till 1930", y1931to1960: "byggår 1931–1960", y1961to1990: "byggår 1961–1990", ge1991: "byggår från 1991" } as const;
    for (const k of Object.keys(labels) as (keyof typeof labels)[]) {
      if (onCap(by.pctByBucket[k])) onStage2Cap.push(`${labels[k]} ${pctSigned(by.pctByBucket[k])}`);
    }
  }
  const dom = afterModel.bidPremium.terms.dom;
  const model: ValuationReport["model"] = {
    features: afterModel.features.map((f) => ({ name: f.name, beta: f.beta, se: f.se, source: f.source })),
    balconyPct: afterModel.stage2.balcony.pct,
    buildYearPct: by === null ? null : { ...by.pctByBucket },
    onStage2Cap,
    daysTerm: dom === null ? null : { beta: dom.beta, kept: dom.kept },
    fallbacks: afterModel.fallbacks.map((f) => `${f.item} (${f.reason}): ${f.detail}`),
    n: { before: before.model.n, after: after.model.n },
    r2: { before: before.model.r2, after: after.model.r2 },
    cvRmseLog: { before: before.model.cvRmseLog, after: after.model.cvRmseLog },
  };

  const base = {
    snapshotAsOf: after.snapshotAsOf,
    beforeModel: before.model,
    intermediateModel: intermediate.model,
    afterModelSummary: after.model,
    residualBasis: RESIDUAL_FLAG_BASIS,
    cappedRows,
    top15: { before: top15Of(before, after), after: top15Of(after, before) },
    folkungagatan61: { before: numbersOf(folkBefore), after: numbersOf(folkAfter), decomposition: folkDecomposition },
    creditRemoved,
    residualCounts: {
      n: counted,
      expectedFinal: flaggedExpectedFinal,
      asking: flaggedAsking,
      basisInForce: RESIDUAL_FLAG_BASIS,
      limitPct: Math.exp(-RESIDUAL_FLAG_SD * sd) - 1,
    },
    bidPremium: {
      top15: bidTop15,
      meanChange: changes.length === 0 ? null : changes.reduce((a, b) => a + b, 0) / changes.length,
      rowsInBoth: changes.length,
      conditionLine: conditionLineOfModel(afterModel),
    },
    model,
    avgiftDebtCorrelation: avgiftDebtCorrelation(input.snapshotRows ?? []),
  };
  return { ...base, findings: findingsOf(base) };
}

/**
 * One plain sentence on the condition term of the premium: the fitted coefficient when cross-validation kept it, otherwise
 * that condition is not measured, the premium adds 0, and why (the model's own reason). Pure.
 */
export function conditionLineOfModel(model: Pick<HedonicModel, "bidPremium">): string {
  const term = model.bidPremium.terms.condition;
  if (term === null) return "The bid premium has no condition term: condition is not measured (\"skick ej mätt\") and the premium adds 0.";
  if (term.source === "fit" && term.kept) {
    return `Condition in the bid premium: ${sv(term.beta, 4)} per step (dated -1, ordinary 0, fresh +1), fitted on ${kr(term.n)} sold flats with a photo read and kept by cross-validation.`;
  }
  const reason = term.note.replace(/^budpremie: skick ej mätt: /, "");
  return `Condition in the bid premium: not measured ("skick ej mätt"), the premium adds 0 for every flat. Reason: ${reason}`;
}

/** Pearson correlation of avgift per m2 and BRF debt per m2 over the rows that have both. */
export function avgiftDebtCorrelation(rows: readonly FitInputRow[]): { r: number | null; n: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const row of rows) {
    const avgift = row.facts?.avgiftMonthlySek ?? null;
    const debt = row.facts?.brf?.debtPerSqm ?? null;
    const area = row.candidate.livingArea;
    if (avgift === null || debt === null || area === null || !(area > 0) || !(avgift > 0) || !Number.isFinite(debt)) continue;
    xs.push(avgift / area);
    ys.push(debt);
  }
  const n = xs.length;
  if (n < 3) return { r: null, n };
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (!(sxx > 0) || !(syy > 0)) return { r: null, n };
  return { r: sxy / Math.sqrt(sxx * syy), n };
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
    "| Adress | Plats före -> efter | Kredit före | Tak borttaget | Ny anpassning | Dagar | Avgift | BRF-skuld | Tomträtt | Övrigt | Skillnad efter | Residual | Flagga (förv. slutpris / utgångspris) |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const r of report.cappedRows) {
    lines.push(
      `| ${cell(r.address)} | ${r.oldRank} -> ${r.newRank ?? "-"} | ${kr(r.oldCredit)} | ${krSigned(r.capRemovedKr)} | ${krSigned(r.refitExclDaysKr)} | ${krSigned(r.daysKr)} | ${krSigned(r.avgiftKr)} | ${krSigned(r.debtKr)} | ${krSigned(r.tomtrattKr)} | ${krSigned(r.ovrigtKr)} | ${kr(r.newGap)} | ${r.residualPct === null ? "-" : pctSigned(r.residualPct)} | ${yesNo(r.flagExpectedFinal)} / ${yesNo(r.flagAsking)} |`,
    );
  }
  const sum = (pick: (r: CappedRow) => number): number => report.cappedRows.reduce((acc, r) => acc + pick(r), 0);
  lines.push(
    `| **Summa** | | ${kr(sum((r) => r.oldCredit))} | ${krSigned(sum((r) => r.capRemovedKr))} | ${krSigned(sum((r) => r.refitExclDaysKr))} | ${krSigned(sum((r) => r.daysKr))} | ${krSigned(sum((r) => r.avgiftKr))} | ${krSigned(sum((r) => r.debtKr))} | ${krSigned(sum((r) => r.tomtrattKr))} | ${krSigned(sum((r) => r.ovrigtKr))} | ${kr(sum((r) => r.newGap))} | | ${report.cappedRows.filter((r) => r.flagExpectedFinal).length} / ${report.cappedRows.filter((r) => r.flagAsking).length} rader |`,
    "",
    '"Ny anpassning" is what changed between the frozen run and the model refitted on today\'s data with the old six features: the balcony and build-year effects (stage 2) and the refitted coefficients. "Dagar" is the days-on-market term that now sits in the bid premium, measured in that same refitted model. "Avgift", "BRF-skuld" and "Tomträtt" are what each fact takes off (-) or adds to (+) the credit in the new model, measured by scoring the flat again with that one fact set to unknown. "Övrigt" is what is left of the move from the refitted model to the new one: the other coefficients shifting when avgift and debt entered, and the way the effects combine. Tomträtt is 0 because the model could not estimate it (no leasehold sales in the data).',
  );
  return lines;
}

const sv = (x: number, decimals: number): string => {
  const text = x.toFixed(decimals).replace(".", ",");
  return /^-0(,0+)?$/.test(text) ? text.slice(1) : text;
};

/** Percentage points with a sign: 0.0123 -> "+1,2 procentenheter". */
function ppSigned(fraction: number): string {
  const text = sv(Math.abs(fraction) * 100, 1);
  return `${fraction < 0 && !/^0(,0+)?$/.test(text) ? "-" : "+"}${text} procentenheter`;
}

const profitCell = (v: number | null): string => (v === null ? "-" : kr(v));
const rankCell = (v: number | null): string => (v === null ? "-" : String(v));

/** The sentences at the end of the report, written from the computed numbers only. */
function findingsOf(r: Omit<ValuationReport, "findings">): string[] {
  const out: string[] = [];
  const n = r.cappedRows.length;
  const sum = (pick: (row: CappedRow) => number): number => r.cappedRows.reduce((acc, row) => acc + pick(row), 0);

  out.push(
    `The old ceiling hid ${kr(r.creditRemoved.total)} kr of credit across ${r.creditRemoved.rows} rows, ${kr(r.creditRemoved.top15)} kr of it inside the old top 15.`,
  );

  const kept = r.top15.after.filter((row) => row.otherTop15Rank !== null).length;
  const left = r.top15.before.filter((row) => row.otherTop15Rank === null);
  const entered = r.top15.after.filter((row) => row.otherTop15Rank === null);
  const nameOf = (row: Top15Row, place: number | null): string => `${row.address ?? row.key} (${place ?? "-"})`;
  out.push(
    `${kept} of the ${r.top15.after.length} listings in the new top 15 were also in the old top 15. Left: ${left.length === 0 ? "none" : left.map((row) => `${nameOf(row, row.rank)} -> ${rankCell(row.otherRank)}`).join(", ")}. Entered: ${entered.length === 0 ? "none" : entered.map((row) => `${nameOf(row, row.rank)} from ${rankCell(row.otherRank)}`).join(", ")}.`,
  );

  const profitSum = (rows: readonly Top15Row[]): number => rows.reduce((acc, row) => acc + (row.profitSek ?? 0), 0);
  out.push(`The profits of the top 15 add up to ${kr(profitSum(r.top15.before))} kr before and ${kr(profitSum(r.top15.after))} kr after.`);

  if (n > 0) {
    const down = r.cappedRows.filter((row) => row.newRank === null || row.newRank > row.oldRank).length;
    const up = r.cappedRows.filter((row) => row.newRank !== null && row.newRank < row.oldRank).length;
    const same = r.cappedRows.filter((row) => row.newRank === row.oldRank).length;
    out.push(
      `Across the ${n} formerly capped rows the credit moved by ${krSigned(sum((row) => row.newGap - row.oldCredit))} kr in total: ceiling removal ${krSigned(sum((row) => row.capRemovedKr))}, refit ${krSigned(sum((row) => row.refitExclDaysKr))}, days term ${krSigned(sum((row) => row.daysKr))}, avgift ${krSigned(sum((row) => row.avgiftKr))}, BRF debt ${krSigned(sum((row) => row.debtKr))}, tomträtt ${krSigned(sum((row) => row.tomtrattKr))}, rest ${krSigned(sum((row) => row.ovrigtKr))}. ${up} of them rank higher now, ${same} keep their place, ${down} rank lower or are no longer ranked.`,
    );
    out.push(
      `${r.cappedRows.filter((row) => row.flagExpectedFinal).length} of the ${n} formerly capped rows carry the residual flag on the expected-final basis, ${r.cappedRows.filter((row) => row.flagAsking).length} on the asking basis.`,
    );
  }
  out.push(
    `Over all ${r.residualCounts.n} comparable rows the residual flag marks ${r.residualCounts.expectedFinal} on the expected-final basis and ${r.residualCounts.asking} on the asking basis (limit ${pctSigned(r.residualCounts.limitPct)} against the model; basis in force: ${r.residualCounts.basisInForce}).`,
  );

  const f = r.folkungagatan61;
  if (f.before !== null && f.after !== null) {
    out.push(
      `Folkungagatan 61 moved from rank ${rankCell(f.before.rank)} to ${rankCell(f.after.rank)}; profit ${profitCell(f.before.profitSek)} -> ${profitCell(f.after.profitSek)} kr.` +
        (f.decomposition === null
          ? ""
          : ` Its credit moved ${krSigned(f.decomposition.newGap - f.decomposition.oldCredit)} kr: ceiling ${krSigned(f.decomposition.capRemovedKr)}, refit ${krSigned(f.decomposition.refitExclDaysKr)}, days term ${krSigned(f.decomposition.daysKr)}, avgift ${krSigned(f.decomposition.avgiftKr)}, BRF debt ${krSigned(f.decomposition.debtKr)}, tomträtt ${krSigned(f.decomposition.tomtrattKr)}, rest ${krSigned(f.decomposition.ovrigtKr)}.`),
    );
  } else {
    out.push("Folkungagatan 61 saknas i körningen (before or after), so no move could be measured.");
  }

  if (r.bidPremium.meanChange !== null) {
    out.push(
      `Over the ${r.bidPremium.rowsInBoth} rows ranked in both runs the expected overbid changed by ${ppSigned(r.bidPremium.meanChange)} on average.`,
    );
  }
  if (r.avgiftDebtCorrelation.r !== null) {
    out.push(`Avgift per kvm and BRF debt per kvm correlate at r = ${sv(r.avgiftDebtCorrelation.r, 2)} over ${r.avgiftDebtCorrelation.n} listings that have both.`);
  }
  if (r.model.onStage2Cap.length > 0) {
    out.push(
      `These stage-2 coefficients sit exactly on the +-${sv(STAGE2_CAP_PCT * 100, 0)} % limit the fit allows: ${r.model.onStage2Cap.join(", ")}. The fit clamps stage-2 effects at this limit, so the unclamped estimate may be larger than shown. Open point; nothing was changed.`,
    );
  }
  return out;
}

function top15Md(report: ValuationReport): string[] {
  const lines: string[] = [
    "## Top 15 before and after",
    "",
    "Left: the first 15 of the frozen run. Right: the first 15 of the new run. \"Plats efter\" is the listing's place in the new ranking, \"Plats före\" its place in the old one; \"-\" means it is not ranked in that run.",
    "",
    "| # | Före: adress | Vinst före (kr) | Plats efter | Efter: adress | Vinst efter (kr) | Plats före |",
    "|---:|---|---:|---:|---|---:|---:|",
  ];
  const rows = Math.max(report.top15.before.length, report.top15.after.length);
  for (let i = 0; i < rows; i++) {
    const b = report.top15.before[i];
    const a = report.top15.after[i];
    lines.push(
      `| ${i + 1} | ${cell(b?.address ?? null)} | ${profitCell(b?.profitSek ?? null)} | ${rankCell(b?.otherRank ?? null)} | ${cell(a?.address ?? null)} | ${profitCell(a?.profitSek ?? null)} | ${rankCell(a?.otherRank ?? null)} |`,
    );
  }
  return lines;
}

function folkMd(report: ValuationReport): string[] {
  const f = report.folkungagatan61;
  const lines: string[] = ["## Folkungagatan 61", "", `Booli ${FOLKUNGAGATAN_61_BOOLI_ID}, the tracked listing.`, ""];
  if (f.before === null || f.after === null) {
    lines.push(
      `Folkungagatan 61 saknas i körningen: ${f.before === null ? "before" : ""}${f.before === null && f.after === null ? " and " : ""}${f.after === null ? "after" : ""} record has no row for it.`,
    );
    if (f.before === null && f.after === null) return lines;
    lines.push("");
  }
  const pair = (label: string, pick: (n: ListingNumbers) => string): string =>
    `| ${label} | ${f.before === null ? "saknas" : pick(f.before)} | ${f.after === null ? "saknas" : pick(f.after)} |`;
  lines.push(
    "| | Före | Efter |",
    "|---|---:|---:|",
    pair("Plats", (n) => rankCell(n.rank)),
    pair("Vinst (kr)", (n) => profitCell(n.profitSek)),
    pair("Framtida värde, renoverad (kr)", (n) => profitCell(n.resaleSek)),
    pair("Förväntat slutpris (kr)", (n) => profitCell(n.expectedFinalSek)),
    pair("Budpremie", (n) => (n.overbidPct === null ? "-" : pctSigned(n.overbidPct))),
    pair("Skillnad (kr)", (n) => profitCell(n.gapSek)),
    pair("Krediterad del (kr)", (n) => profitCell(n.creditSek)),
    pair("Renovering (kr)", (n) => kr(n.renoSek)),
    pair("Smak (kr)", (n) => kr(n.tasteSek)),
  );
  const d = f.decomposition;
  if (d !== null) {
    lines.push(
      "",
      `Where its credit moved (kr, + raises it, - lowers it): old credit ${kr(d.oldCredit)}; ceiling ${krSigned(d.capRemovedKr)}; refit (balcony, build year, coefficients) ${krSigned(d.refitExclDaysKr)}; days term ${krSigned(d.daysKr)}; avgift ${krSigned(d.avgiftKr)}; BRF debt ${krSigned(d.debtKr)}; tomträtt ${krSigned(d.tomtrattKr)}; rest ${krSigned(d.ovrigtKr)}; new credit ${kr(d.newGap)}. Residual ${d.residualPct === null ? "-" : pctSigned(d.residualPct)} against the model, flag ${yesNo(d.flagExpectedFinal)} (expected final) / ${yesNo(d.flagAsking)} (asking). The parts add up to the move from old credit to new credit.`,
    );
  }
  return lines;
}

function residualMd(report: ValuationReport): string[] {
  const c = report.residualCounts;
  return [
    "## Residual flag",
    "",
    `The flag "ovanligt långt under modellpris" fires when a flat is further below the model's price than ${pctSigned(c.limitPct)} (two residual spreads). Counted over the ${c.n} comparable rows of the new run:`,
    "",
    "| Basis | Rows flagged |",
    "|---|---:|",
    `| Expected final price against the model${c.basisInForce === "expectedFinal" ? " (in force)" : ""} | ${c.expectedFinal} |`,
    `| Asking price against the model${c.basisInForce === "asking" ? " (in force)" : ""} | ${c.asking} |`,
    "",
    `Switching the basis (\`RESIDUAL_FLAG_BASIS\` in fit-score.ts) would change only which rows carry the flag: ${c.basisInForce === "expectedFinal" ? c.asking : c.expectedFinal} rows instead of ${c.basisInForce === "expectedFinal" ? c.expectedFinal : c.asking}. No profit figure changes either way.`,
    "",
    `The credit the ceiling removed: ${kr(report.creditRemoved.total)} kr over ${report.creditRemoved.rows} rows (${kr(report.creditRemoved.top15)} kr inside the old top 15).`,
  ];
}

function bidMd(report: ValuationReport): string[] {
  const b = report.bidPremium;
  const lines: string[] = [
    "## Bid premium",
    "",
    'The expected overbid on the asking price, for the new top 15. "Före" is the same listing in the frozen run (version-1 model, no days term).',
    "",
    "| Plats efter | Adress | Budpremie före | Budpremie efter | Hur den räknades |",
    "|---:|---|---:|---:|---|",
  ];
  for (const r of b.top15) {
    lines.push(
      `| ${r.rank} | ${cell(r.address)} | ${r.overbidBefore === null ? "-" : pctSigned(r.overbidBefore)} | ${r.overbidAfter === null ? "-" : pctSigned(r.overbidAfter)} | ${cell(r.labelAfter)} |`,
    );
  }
  lines.push(
    "",
    b.meanChange === null
      ? "No row is ranked in both runs with a premium in both."
      : `Mean change over the ${b.rowsInBoth} rows ranked in both runs: ${ppSigned(b.meanChange)}.`,
    "",
    b.conditionLine,
  );
  return lines;
}

const FEATURE_LABELS: Record<string, string> = {
  nbLevel: "områdesnivå",
  floor: "våning",
  groundOrBelow: "bottenvåning",
  lnArea: "storlek",
  monthsAgo: "tidstrend",
  centralityKm: "avstånd till centrum",
  avgiftPerSqmMonth: "avgift kr/kvm/mån",
  brfDebtPerSqm: "föreningsskuld kr/kvm",
  tomtratt: "tomträtt",
};

/** The effect of one unit of a feature on the price per kvm, for the two new ones; "-" for the rest. */
function effectOf(name: string, beta: number): string {
  if (name === "avgiftPerSqmMonth") return `${pctSigned(Math.exp(10 * beta) - 1, 2)} per 10 kr/kvm/mån`;
  if (name === "brfDebtPerSqm") return `${pctSigned(Math.exp(1000 * beta) - 1, 2)} per 1 000 kr/kvm`;
  return "-";
}

function modelMd(report: ValuationReport): string[] {
  const m = report.model;
  const lines: string[] = [
    "## Model",
    "",
    "Coefficients of the committed model (ln price per kvm; standard error = how much the estimate could move):",
    "",
    "| Egenskap | Koefficient | SE | t | Källa | Effekt |",
    "|---|---:|---:|---:|---|---|",
  ];
  for (const f of m.features) {
    const t = f.se !== null && f.se > 0 ? sv(f.beta / f.se, 1) : "-";
    lines.push(
      `| ${FEATURE_LABELS[f.name] ?? f.name} | ${f.source === "zeroed" ? "0" : f.beta.toPrecision(3).replace(".", ",")} | ${f.se === null ? "-" : f.se.toPrecision(3).replace(".", ",")} | ${t} | ${f.source} | ${effectOf(f.name, f.beta)} |`,
    );
  }
  lines.push(
    "",
    `Stage 2 (balcony and build year, taken as percentages after the fit): balcony ${pctSigned(m.balconyPct)}` +
      (m.buildYearPct === null
        ? "."
        : `; build year to 1930 ${pctSigned(m.buildYearPct.le1930)}, 1931–1960 ${pctSigned(m.buildYearPct.y1931to1960)}, 1961–1990 ${pctSigned(m.buildYearPct.y1961to1990)}, from 1991 ${pctSigned(m.buildYearPct.ge1991)}.`),
    m.daysTerm === null
      ? "The bid premium has no days-on-market term."
      : `Days on market in the bid premium: coefficient ${m.daysTerm.beta.toPrecision(3).replace(".", ",")} per ln(1 + days), ${m.daysTerm.kept ? "kept" : "dropped"}.`,
    "",
    "| | Före (version " + report.beforeModel.version + ") | Efter (version " + report.afterModelSummary.version + ") |",
    "|---|---:|---:|",
    `| Försäljningar i anpassningen | ${kr(m.n.before)} | ${kr(m.n.after)} |`,
    `| R² | ${sv(m.r2.before, 3)} | ${sv(m.r2.after, 3)} |`,
    `| Korsvalideringsfel (logskala) | ${sv(m.cvRmseLog.before, 4)} | ${sv(m.cvRmseLog.after, 4)} |`,
    "",
    r2Note(),
  );
  if (m.fallbacks.length > 0) lines.push("", "Fallbacks in the model file:", ...m.fallbacks.map((x) => `- ${x}`));
  const c = report.avgiftDebtCorrelation;
  lines.push(
    "",
    c.r === null
      ? "Correlation of avgift and BRF debt per kvm: not computed (fewer than three listings with both)."
      : `Correlation of avgift per kvm and BRF debt per kvm over the snapshot's listings that have both: r = ${sv(c.r, 2)} (n = ${c.n}).`,
  );
  return lines;
}

function r2Note(): string {
  return 'R² is the share of the variation in sold prices per kvm the model explains; the cross-validation error is the typical miss, in log units (0,1 is about 10 %), on sales the fit had not seen.';
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
    ...top15Md(report),
    "",
    ...folkMd(report),
    "",
    ...residualMd(report),
    "",
    ...bidMd(report),
    "",
    ...modelMd(report),
    "",
    "## Findings",
    "",
    ...report.findings.map((x) => `- ${x}`),
    "",
  ];
  return lines.join("\n");
}
