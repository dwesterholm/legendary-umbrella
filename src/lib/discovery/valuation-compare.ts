/**
 * valuation-compare.ts - the 14.4 -> 14.5 valuation comparison (Phase 14.5-03, ENR-02, R-02).
 *
 * Takes two to four fit run records (the 14.4 "after" record as the "before", an optional
 * intermediate, the 14.5 record, an optional record with the stage-2 limit widened to +-12 %)
 * and builds one comparison: the tracked flat first (rank, resale value, profit and credit in
 * every column), then the top 15 of every column side by side, then the largest rank moves
 * between the first and the last column. It renders the same thing as Swedish markdown.
 *
 * With model files (read leniently, so version 1 and version 2 both load) it adds every stage-1
 * coefficient with its standard error, and the stage-2 balcony and build-year values flagged "on
 * the cap" against EACH model's own cap (`stage2.capPct`, default 0,08). With the fit-report JSON
 * that `scripts/fit-hedonic.ts --report-json` writes (schema below) it adds the raw stage-2 values
 * with SE, the stage-2 cross-validation and the cap decision of R-01: widen to +-12 % only when its
 * stage-2 cross-validation error is not worse than at +-8 %.
 *
 * Why it is not `buildValuationReport`: that report is a 14.1 -> 14.4 waterfall and throws on
 * a "before" of model version 2. Here records of model version 1 and 2 are both accepted;
 * the record format itself is parsed by `parseFitRunRecord` in the caller.
 *
 * STRUCTURAL SEPARATION (LOCKED): `niche-score.ts` and `report/flags.ts` must NEVER import this
 * file (the prefix `discovery/valuation-` is registered in `niche-score.test.ts`).
 *
 * Offline: no network, no API key, no paid call. PURE: no file-system import, no clock, no
 * console. The script reads the files and writes the output.
 */

import { z } from "zod/v4";
import { STAGE2_CAP_PCT } from "@/lib/discovery/hedonic-model";
import { FOLKUNGAGATAN_61_BOOLI_ID, type FitRunRecord, type FitRunRow } from "@/lib/discovery/valuation-report";

/** How many rows each side-by-side list holds. */
const TOP_N = 15;

/** How many rank moves the report lists. */
const MOVES_N = 10;

export interface CompareColumnInput {
  /** The caller's label for the column, for example "14.4 (efter)". */
  readonly label: string;
  readonly record: FitRunRecord;
  /** The model file the record was replayed with, as untrusted JSON (read leniently). */
  readonly model?: unknown;
  /** The fit report (already parsed with `fitReportJsonSchema`) of the fit that made this column's model. */
  readonly fitReport?: FitReport;
  /** The stage-2 cap to assume when neither the model nor the fit report says (used to find the +-8 % and +-12 % columns). */
  readonly assumedCapPct?: number;
}

export interface CompareInput {
  /** Ordered by the caller: first = "before", last = the newest. At least two. */
  readonly columns: readonly CompareColumnInput[];
  /** The Booli id of the flat the report leads with. */
  readonly trackId: number;
}

export interface ColumnSummary {
  readonly label: string;
  readonly snapshotAsOf: string;
  readonly modelVersion: number;
  readonly modelAsOf: string;
  readonly modelN: number;
  readonly r2: number;
  readonly cvRmseLog: number;
  readonly ranked: number;
}

export interface TrackedColumn {
  readonly label: string;
  /** null when the flat is missing from the column or is not comparable in it. */
  readonly rank: number | null;
  readonly resaleSek: number | null;
  readonly profitSek: number | null;
  readonly creditSek: number | null;
}

export interface TopRow {
  readonly rank: number;
  readonly id: string;
  readonly address: string | null;
  readonly resaleSek: number | null;
  readonly profitSek: number | null;
  readonly tracked: boolean;
}

export interface RankMove {
  readonly id: string;
  readonly address: string | null;
  /** The rank in every column, in column order (null when the flat is not ranked there). */
  readonly ranks: readonly (number | null)[];
  /** Rank in the first column. */
  readonly from: number;
  /** Rank in the last column. */
  readonly to: number;
  /** from - to: positive means the flat climbed (a lower rank number is better). */
  readonly move: number;
}

export interface CoefficientRow {
  readonly name: string;
  /** Per column: beta and SE, or null when that column has no model or the model lacks the feature. */
  readonly cells: readonly ({ readonly beta: number; readonly se: number | null } | null)[];
}

export type Stage2Key = "balcony" | "le1930" | "y1931to1960" | "y1961to1990" | "ge1991";

export interface Stage2Row {
  readonly key: Stage2Key;
  readonly label: string;
  /** The value the model uses, with the cap that model has and whether the value sits on it. */
  readonly cells: readonly ({ readonly pct: number; readonly capPct: number; readonly onCap: boolean } | null)[];
  /** The value before clamping and its SE (log scale, read as approximate points), from the fit report. */
  readonly raw: readonly ({ readonly pctRaw: number; readonly se: number | null } | null)[];
}

export interface FitSummary {
  readonly label: string;
  readonly capPct: number;
  readonly n: number;
  readonly cvRmseLog: number;
  readonly enrichedRows: number;
  readonly stage2N: number;
  readonly onCap: readonly string[];
  readonly cv: { readonly without: number; readonly cap8: number; readonly cap12: number };
  readonly avgiftDebt: number | null;
  readonly correlationRows: number;
  readonly ceiling: { readonly soldRowsWithHeight: number; readonly fitted: boolean; readonly reason: string };
}

export interface CapResaleDiff {
  readonly cap8Label: string;
  readonly cap12Label: string;
  readonly resale8: number;
  readonly resale12: number;
  /** resale12 - resale8, in whole kronor. */
  readonly diffSek: number;
}

export interface ValuationCompare {
  readonly version: 1;
  readonly trackId: number;
  /** The tracked flat's address from the first record that has it, else null. */
  readonly trackedAddress: string | null;
  readonly columns: readonly ColumnSummary[];
  readonly tracked: readonly TrackedColumn[];
  readonly top: readonly { readonly label: string; readonly rows: readonly TopRow[] }[];
  readonly moves: readonly RankMove[];
  /** Null when no column carries a model file. */
  readonly coefficients: readonly CoefficientRow[] | null;
  /** Null when no column carries a model file or a fit report. */
  readonly stage2: readonly Stage2Row[] | null;
  readonly fitReports: readonly FitSummary[];
  /** Null without a fit report. */
  readonly capDecision: CapDecision | null;
  /** Null without a fit report; true when something sits on the +-8 % limit (D-03). */
  readonly capStepNeeded: boolean | null;
  /** Null unless the tracked flat is ranked in a +-8 % column and a +-12 % column. */
  readonly capResaleDiff: CapResaleDiff | null;
}


// ---------------------------------------------------------------------------
// The fit report that `scripts/fit-hedonic.ts --report-json` writes, and the cap decision (R-01)
// ---------------------------------------------------------------------------

const stage2BucketSchema = z.object({
  /** Rows in the bucket. */
  n: z.number(),
  /** exp(coefficient) - 1 before clamping. */
  pctRaw: z.number(),
  /** sd(residuals in the bucket) / sqrt(n in the bucket); null when it cannot be computed. */
  seApprox: z.number().nullable(),
  /** The value the model uses (clamped to the cap). */
  pct: z.number(),
});

/**
 * The shape of the fit report JSON. Exported so `scripts/fit-hedonic.ts` validates what it writes
 * against the same schema. Both stage-2 cross-validation numbers (+-8 % and +-12 %) are required
 * in every report: the cap decision needs both whichever cap the fit itself used.
 */
export const fitReportJsonSchema = z.looseObject({
  version: z.literal(1),
  capPct: z.number(),
  n: z.number(),
  r2: z.number(),
  /** Stage 1 only: computed before stage 2, so it cannot tell +-8 % from +-12 %. */
  cvRmseLog: z.number(),
  enrichedRows: z.number(),
  stage2: z.looseObject({
    n: z.number(),
    capPct: z.number(),
    balcony: z.object({
      gamma: z.number(),
      se: z.number().nullable(),
      pctRaw: z.number(),
      pct: z.number(),
      source: z.enum(["fit", "prior"]),
    }),
    buckets: z.object({
      le1930: stage2BucketSchema,
      y1931to1960: stage2BucketSchema,
      y1961to1990: stage2BucketSchema,
      ge1991: stage2BucketSchema,
    }),
    /** Labels of the stage-2 values that sit on the fit's own cap. */
    onCap: z.array(z.string()),
    cv: z.object({
      /** Held-out error with no stage 2 at all (residual only). */
      without: z.number(),
      byCap: z.object({ "0.08": z.number(), "0.12": z.number() }),
    }),
  }),
  correlation: z.object({ avgiftDebt: z.number().nullable(), rows: z.number() }),
  ceiling: z.object({ soldRowsWithHeight: z.number(), fitted: z.boolean(), reason: z.string() }),
});

export type FitReport = z.infer<typeof fitReportJsonSchema>;

/** D-03: widen the stage-2 limit once, and only if some value sits on +-8 %. */
export function capStepNeeded(report8: FitReport): boolean {
  return report8.stage2.onCap.length > 0;
}

export interface CapDecision {
  /** 0.12 when the +-12 % cross-validation error is not worse than +-8 %, else 0.08. */
  readonly chosen: 0.08 | 0.12;
  readonly cv8: number;
  readonly cv12: number;
  readonly verdict: string;
}

function decComma(n: number, digits: number): string {
  return n.toFixed(digits).replace(".", ",");
}

/** R-01, mechanically: +-12 % only if its stage-2 cross-validation error is not worse than +-8 %. */
export function capDecision(cv8: number, cv12: number): CapDecision {
  const chosen = cv12 <= cv8 ? 0.12 : 0.08;
  const numbers = `${decComma(cv12, 5)} vid ±12 % mot ${decComma(cv8, 5)} vid ±8 %`;
  const verdict =
    chosen === 0.12
      ? `Taket vidgas till ±12 %: steg-2-felet är ${numbers}, alltså inte sämre.`
      : `Taket stannar på ±8 %: steg-2-felet är ${numbers}, alltså sämre.`;
  return { chosen, cv8, cv12, verdict };
}

// ---------------------------------------------------------------------------
// Model files, read leniently (version 1 and version 2, with or without stage2.capPct)
// ---------------------------------------------------------------------------

const lenientModelSchema = z.looseObject({
  features: z.array(z.looseObject({ name: z.string(), beta: z.number(), se: z.number().nullish() })).optional(),
  stage2: z
    .looseObject({
      capPct: z.unknown().optional(),
      balcony: z.looseObject({ pct: z.number() }).nullish(),
      buildYear: z
        .looseObject({
          pctByBucket: z.looseObject({
            le1930: z.number(),
            y1931to1960: z.number(),
            y1961to1990: z.number(),
            ge1991: z.number(),
          }),
        })
        .nullish(),
    })
    .nullish(),
});

export interface ModelCoefficients {
  readonly features: readonly { readonly name: string; readonly beta: number; readonly se: number | null }[];
  readonly stage2: {
    readonly capPct: number;
    readonly balcony: number | null;
    readonly buildYear: Record<"le1930" | "y1931to1960" | "y1961to1990" | "ge1991", number> | null;
  };
}

/** The stage-2 cap a model file records, else the default (0,08). Never throws. */
export function stage2CapOf(rawJson: unknown): number {
  if (typeof rawJson !== "object" || rawJson === null) return STAGE2_CAP_PCT;
  const stage2 = (rawJson as { stage2?: unknown }).stage2;
  if (typeof stage2 !== "object" || stage2 === null) return STAGE2_CAP_PCT;
  const cap = (stage2 as { capPct?: unknown }).capPct;
  return typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? cap : STAGE2_CAP_PCT;
}

/**
 * Stage-1 coefficients with SE and the stage-2 values of a model file. Not `parseHedonicModel`: this
 * schema reads only what the comparison needs, so a version-1 file (no stage 2 detail) loads too.
 */
export function modelCoefficientsOf(rawJson: unknown): ModelCoefficients {
  const parsed = lenientModelSchema.safeParse(rawJson);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid model file: ${issues}`);
  }
  const m = parsed.data;
  return {
    features: (m.features ?? []).map((f) => ({ name: f.name, beta: f.beta, se: f.se ?? null })),
    stage2: {
      capPct: stage2CapOf(rawJson),
      balcony: m.stage2?.balcony?.pct ?? null,
      buildYear: m.stage2?.buildYear == null ? null : { ...m.stage2.buildYear.pctByBucket },
    },
  };
}

/** A stage-2 value sits "on the cap" when its size equals the model's own cap. */
export function onStage2Cap(value: number, capPct: number): boolean {
  return Math.abs(Math.abs(value) - capPct) < 1e-9;
}

const STAGE2_ROWS: readonly { readonly key: Stage2Key; readonly label: string }[] = [
  { key: "balcony", label: "Balkong" },
  { key: "le1930", label: "Byggår till 1930" },
  { key: "y1931to1960", label: "Byggår 1931–1960" },
  { key: "y1961to1990", label: "Byggår 1961–1990" },
  { key: "ge1991", label: "Byggår från 1991" },
];

function stage2ValueOf(key: Stage2Key, s: ModelCoefficients["stage2"]): number | null {
  return key === "balcony" ? s.balcony : (s.buildYear?.[key] ?? null);
}

/** The cap a column's numbers were made with: its model's own cap, else its fit report's, else the caller's assumption. */
function columnCapOf(c: CompareColumnInput): number | null {
  if (c.model !== undefined) return stage2CapOf(c.model);
  if (c.fitReport !== undefined) return c.fitReport.stage2.capPct;
  return c.assumedCapPct ?? null;
}

function fitSummaryOf(label: string, r: FitReport): FitSummary {
  return {
    label,
    capPct: r.capPct,
    n: r.n,
    cvRmseLog: r.cvRmseLog,
    enrichedRows: r.enrichedRows,
    stage2N: r.stage2.n,
    onCap: [...r.stage2.onCap],
    cv: { without: r.stage2.cv.without, cap8: r.stage2.cv.byCap["0.08"], cap12: r.stage2.cv.byCap["0.12"] },
    avgiftDebt: r.correlation.avgiftDebt,
    correlationRows: r.correlation.rows,
    ceiling: { ...r.ceiling },
  };
}

/** The join key of a row: the Booli id, else the row key (the listing URL). Never the rank. */
function rowIdOf(row: FitRunRow): string {
  return row.booliId !== null ? `booli:${row.booliId}` : `key:${row.key}`;
}

/** Ranked rows only, first occurrence of an id wins (the lowest rank). */
function rankedById(record: FitRunRecord): Map<string, FitRunRow> {
  const out = new Map<string, FitRunRow>();
  const sorted = [...record.ranked].filter((r) => r.rank !== null).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  for (const row of sorted) {
    const id = rowIdOf(row);
    if (!out.has(id)) out.set(id, row);
  }
  return out;
}

function findTracked(record: FitRunRecord, trackId: number): FitRunRow | null {
  for (const row of record.ranked) if (row.booliId === trackId && row.rank !== null) return row;
  return null;
}

/** Builds the comparison from two or more run records. Throws one readable Error on fewer than two. */
export function buildValuationCompare(input: CompareInput): ValuationCompare {
  const { columns, trackId } = input;
  if (columns.length < 2) throw new Error("En jämförelse behöver minst två körningsposter");

  const summaries: ColumnSummary[] = columns.map((c) => ({
    label: c.label,
    snapshotAsOf: c.record.snapshotAsOf,
    modelVersion: c.record.model.version,
    modelAsOf: c.record.model.asOf,
    modelN: c.record.model.n,
    r2: c.record.model.r2,
    cvRmseLog: c.record.model.cvRmseLog,
    ranked: c.record.ranked.length,
  }));

  let trackedAddress: string | null = null;
  const tracked: TrackedColumn[] = columns.map((c) => {
    const row = findTracked(c.record, trackId);
    if (row !== null && trackedAddress === null) trackedAddress = row.address;
    return {
      label: c.label,
      rank: row?.rank ?? null,
      resaleSek: row?.resaleSek ?? null,
      profitSek: row?.profitSek ?? null,
      creditSek: row?.creditSek ?? null,
    };
  });

  const maps = columns.map((c) => rankedById(c.record));
  const top = columns.map((c, i) => ({
    label: c.label,
    rows: [...maps[i].entries()]
      .map(([id, row]) => ({ id, row }))
      .sort((a, b) => (a.row.rank ?? 0) - (b.row.rank ?? 0))
      .slice(0, TOP_N)
      .map(({ id, row }) => ({
        rank: row.rank ?? 0,
        id,
        address: row.address,
        resaleSek: row.resaleSek,
        profitSek: row.profitSek,
        tracked: row.booliId === trackId,
      })),
  }));

  const firstMap = maps[0];
  const lastMap = maps[maps.length - 1];
  const moves: RankMove[] = [];
  for (const [id, firstRow] of firstMap) {
    const lastRow = lastMap.get(id);
    if (lastRow === undefined || firstRow.rank === null || lastRow.rank === null) continue;
    moves.push({
      id,
      address: lastRow.address ?? firstRow.address,
      ranks: maps.map((m) => m.get(id)?.rank ?? null),
      from: firstRow.rank,
      to: lastRow.rank,
      move: firstRow.rank - lastRow.rank,
    });
  }
  moves.sort((a, b) => Math.abs(b.move) - Math.abs(a.move) || a.to - b.to || a.from - b.from);

  // Models: coefficients with SE and the stage-2 values against each model's own cap.
  const models = columns.map((c) => (c.model === undefined ? null : modelCoefficientsOf(c.model)));
  const anyModel = models.some((m) => m !== null);
  const names: string[] = [];
  for (const m of models) for (const f of m?.features ?? []) if (!names.includes(f.name)) names.push(f.name);
  const coefficients: CoefficientRow[] | null = anyModel
    ? names.map((name) => ({
        name,
        cells: models.map((m) => {
          const f = m?.features.find((x) => x.name === name);
          return f === undefined ? null : { beta: f.beta, se: f.se };
        }),
      }))
    : null;

  const anyFit = columns.some((c) => c.fitReport !== undefined);
  const stage2: Stage2Row[] | null =
    anyModel || anyFit
      ? STAGE2_ROWS.map(({ key, label }) => ({
          key,
          label,
          cells: columns.map((c, i) => {
            const fromModel = models[i];
            if (fromModel !== null) {
              const pct = stage2ValueOf(key, fromModel.stage2);
              return pct === null ? null : { pct, capPct: fromModel.stage2.capPct, onCap: onStage2Cap(pct, fromModel.stage2.capPct) };
            }
            const r = c.fitReport;
            if (r === undefined) return null;
            const pct = key === "balcony" ? r.stage2.balcony.pct : r.stage2.buckets[key].pct;
            return { pct, capPct: r.stage2.capPct, onCap: onStage2Cap(pct, r.stage2.capPct) };
          }),
          raw: columns.map((c) => {
            const r = c.fitReport;
            if (r === undefined) return null;
            return key === "balcony"
              ? { pctRaw: r.stage2.balcony.pctRaw, se: r.stage2.balcony.se }
              : { pctRaw: r.stage2.buckets[key].pctRaw, se: r.stage2.buckets[key].seApprox };
          }),
        }))
      : null;

  const fitReports = columns.flatMap((c) => (c.fitReport === undefined ? [] : [fitSummaryOf(c.label, c.fitReport)]));
  // Both cross-validation numbers are in every fit report; the first report supplies them. The step is judged
  // on a report made at +-8 % (the question is whether something sits on that limit); without one it is unknown.
  const decisionSource = fitReports[0];
  const decision = decisionSource === undefined ? null : capDecision(decisionSource.cv.cap8, decisionSource.cv.cap12);
  const report8 = fitReports.find((r) => Math.abs(r.capPct - STAGE2_CAP_PCT) < 1e-9);
  const stepNeeded = report8 === undefined ? null : report8.onCap.length > 0;

  // The tracked flat's resale value under the +-8 % and the +-12 % column.
  const caps = columns.map(columnCapOf);
  const i8 = caps.findIndex((c) => c !== null && Math.abs(c - 0.08) < 1e-9);
  const i12 = caps.findIndex((c) => c !== null && Math.abs(c - 0.12) < 1e-9);
  const resale8 = i8 >= 0 ? tracked[i8].resaleSek : null;
  const resale12 = i12 >= 0 ? tracked[i12].resaleSek : null;
  const capResaleDiff: CapResaleDiff | null =
    resale8 !== null && resale12 !== null
      ? {
          cap8Label: columns[i8].label,
          cap12Label: columns[i12].label,
          resale8,
          resale12,
          diffSek: Math.round(resale12) - Math.round(resale8),
        }
      : null;

  return {
    version: 1,
    trackId,
    trackedAddress,
    columns: summaries,
    tracked,
    top,
    moves: moves.slice(0, MOVES_N),
    coefficients,
    stage2,
    fitReports,
    capDecision: decision,
    capStepNeeded: stepNeeded,
    capResaleDiff,
  };
}

// ---------------------------------------------------------------------------
// Swedish number formatting: whole kronor with a space between thousands, decimal comma
// ---------------------------------------------------------------------------

function groupThousands(n: number): string {
  return String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** "1 234 567 kr", "-2 500 kr", or "-" for null. */
function krText(n: number | null): string {
  if (n === null) return "-";
  const whole = Math.round(n);
  return `${whole < 0 ? "-" : ""}${groupThousands(whole)} kr`;
}

/** "+344 502 kr" or "-2 500 kr"; "-" when either end is unknown. */
function krDelta(from: number | null, to: number | null): string {
  if (from === null || to === null) return "-";
  const d = Math.round(to) - Math.round(from);
  return `${d > 0 ? "+" : d < 0 ? "-" : ""}${groupThousands(d)} kr`;
}

const FLAT_NAME_61 = "Folkungagatan 61";

function rankText(rank: number | null): string {
  return rank === null ? "saknas" : String(rank);
}

function trackedHeading(compare: ValuationCompare): string {
  const name = compare.trackId === FOLKUNGAGATAN_61_BOOLI_ID ? FLAT_NAME_61 : (compare.trackedAddress ?? "Spårad lägenhet");
  return `${name} (${compare.trackId})`;
}

/** A markdown table cell must not hold a pipe or a line break. */
function cell(text: string): string {
  return text.replace(/[|\r\n]+/g, " ");
}

/** "+8,0 %" / "-8,0 %" from a fraction. */
function pctSigned(x: number): string {
  const v = x * 100;
  const text = decComma(v, 1);
  return `${v > 0 && text !== "0,0" ? "+" : ""}${text === "-0,0" ? "0,0" : text} %`;
}

/** Four significant digits with a decimal comma: "1,066", "0,01513", "-0,002000". */
function sig4(x: number): string {
  return x.toPrecision(4).replace(".", ",");
}

/** "±8 %" / "±12 %" / "±7,5 %" from a fraction. */
function capText(cap: number): string {
  return `±${String(Number((cap * 100).toFixed(1))).replace(".", ",")} %`;
}

function movesWord(move: number): string {
  if (move > 0) return `upp ${move}`;
  if (move < 0) return `ned ${-move}`;
  return "oförändrad";
}

/** Renders the comparison as Swedish markdown. */
export function renderValuationCompareMd(compare: ValuationCompare): string {
  const lines: string[] = [];
  const first = compare.tracked[0];
  const last = compare.tracked[compare.tracked.length - 1];

  lines.push("# Jämförelse av värderingskörningar");
  lines.push("");
  lines.push("Offline: inget nätverk, ingen API-nyckel, inget betalt anrop.");
  lines.push("");

  lines.push(`## ${trackedHeading(compare)}`);
  lines.push("");
  lines.push(`plats ${compare.tracked.map((t) => rankText(t.rank)).join(" → ")}`);
  lines.push("");
  lines.push("| Körning | Plats | Återförsäljning | Vinst | Kredit |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const t of compare.tracked) {
    lines.push(`| ${cell(t.label)} | ${rankText(t.rank)} | ${krText(t.resaleSek)} | ${krText(t.profitSek)} | ${krText(t.creditSek)} |`);
  }
  lines.push("");
  const rankMove = first.rank !== null && last.rank !== null ? movesWord(first.rank - last.rank) : "går inte att mäta";
  lines.push(
    `Första mot sista körningen: plats ${rankMove}, återförsäljning ${krDelta(first.resaleSek, last.resaleSek)}, vinst ${krDelta(first.profitSek, last.profitSek)}, kredit ${krDelta(first.creditSek, last.creditSek)}.`,
  );
  if (compare.capResaleDiff !== null) {
    const d = compare.capResaleDiff;
    const diff = d.diffSek > 0 ? `+${groupThousands(d.diffSek)}` : d.diffSek < 0 ? `-${groupThousands(d.diffSek)}` : "0";
    lines.push("");
    lines.push(
      `Taket ±8 % mot ±12 %: återförsäljning ${krText(d.resale8)} mot ${krText(d.resale12)}, skillnad ${diff} kr (kolumnerna "${cell(d.cap8Label)}" och "${cell(d.cap12Label)}").`,
    );
  }
  lines.push("");

  lines.push("## Körningar");
  lines.push("");
  lines.push("| Körning | Snapshot | Modell | Modelldatum | Rader i modellen | R2 | cvRmseLog | Rankade rader |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const c of compare.columns) {
    lines.push(
      `| ${cell(c.label)} | ${c.snapshotAsOf} | v${c.modelVersion} | ${c.modelAsOf} | ${groupThousands(c.modelN)} | ${String(c.r2.toFixed(3)).replace(".", ",")} | ${String(c.cvRmseLog.toFixed(4)).replace(".", ",")} | ${c.ranked} |`,
    );
  }
  lines.push("");

  lines.push(`## Topp ${compare.top[0]?.rows.length ?? 0} bredvid varandra`);
  lines.push("");
  lines.push(`| Plats | ${compare.top.map((t) => cell(t.label)).join(" | ")} |`);
  lines.push(`| --- | ${compare.top.map(() => "---").join(" | ")} |`);
  const depth = Math.max(0, ...compare.top.map((t) => t.rows.length));
  for (let i = 0; i < depth; i++) {
    const cells = compare.top.map((t) => {
      const row = t.rows[i];
      if (row === undefined) return "";
      const name = cell(row.address ?? "okänd adress");
      return `${row.tracked ? `**${name}**` : name}, ${krText(row.profitSek)}`;
    });
    lines.push(`| ${i + 1} | ${cells.join(" | ")} |`);
  }
  lines.push("");

  lines.push("## Största platsförflyttningar");
  lines.push("");
  lines.push(
    `Mellan första ("${cell(compare.columns[0].label)}") och sista ("${cell(compare.columns[compare.columns.length - 1].label)}") körningen. Plus betyder att lägenheten steg.`,
  );
  lines.push("");
  lines.push(`| Adress | Platser | Förflyttning |`);
  lines.push("| --- | --- | --- |");
  for (const m of compare.moves) {
    const name = cell(m.address ?? "okänd adress");
    lines.push(`| ${name} | ${m.ranks.map(rankText).join(" → ")} | ${m.move > 0 ? "+" : ""}${m.move} |`);
  }
  lines.push("");

  if (compare.coefficients !== null) {
    lines.push("## Koefficienter (steg 1)");
    lines.push("");
    lines.push("Varje egenskap som beta ± SE. Ett streck betyder att kolumnen inte har någon modellfil eller att modellen saknar egenskapen.");
    lines.push("");
    lines.push(`| Egenskap | ${compare.columns.map((c) => cell(c.label)).join(" | ")} |`);
    lines.push(`| --- | ${compare.columns.map(() => "---").join(" | ")} |`);
    for (const row of compare.coefficients) {
      const cells = row.cells.map((c) => (c === null ? "-" : `${sig4(c.beta)} ± ${c.se === null ? "-" : sig4(c.se)}`));
      lines.push(`| ${cell(row.name)} | ${cells.join(" | ")} |`);
    }
    lines.push("");
  }

  if (compare.stage2 !== null) {
    lines.push("## Steg 2");
    lines.push("");
    lines.push("Värdet modellen använder, markerat när det ligger på den egna modellens tak.");
    lines.push("");
    lines.push(`| Värde | ${compare.columns.map((c) => cell(c.label)).join(" | ")} |`);
    lines.push(`| --- | ${compare.columns.map(() => "---").join(" | ")} |`);
    for (const row of compare.stage2) {
      const cells = row.cells.map((c) => (c === null ? "-" : `${pctSigned(c.pct)}${c.onCap ? ` (på taket ${capText(c.capPct)})` : ""}`));
      lines.push(`| ${row.label} | ${cells.join(" | ")} |`);
    }
    if (compare.fitReports.length > 0) {
      for (const row of compare.stage2) {
        const cells = row.raw.map((r) => (r === null ? "-" : `${pctSigned(r.pctRaw)} (SE ${r.se === null ? "-" : decComma(r.se * 100, 1)})`));
        lines.push(`| ${row.label}, rått värde | ${cells.join(" | ")} |`);
      }
    }
    lines.push("");
    if (compare.fitReports.length > 0) {
      lines.push(
        "Rått värde är värdet före begränsningen till taket. SE ligger på loggskala och läses som ungefärliga procentenheter. 14.4 räknade ingen steg-2-SE, så kolumner utan fit-rapport visar \"-\".",
      );
    } else {
      lines.push("Steg-2-SE saknas utan fit-rapport: 14.4 räknade ingen steg-2-SE, och den visas inte som en påhittad siffra.");
    }
    lines.push("");
  }

  const decision = compare.capDecision;
  if (decision !== null) {
    const fit = compare.fitReports[0];
    lines.push("## Takbeslut (R-01)");
    lines.push("");
    lines.push("Steg-2-korsvalidering: felet på hållna rader för steg 2, samma uppdelning av raderna för alla tre.");
    lines.push("");
    lines.push("| Steg 2 | Fel (log) |");
    lines.push("| --- | --- |");
    lines.push(`| Utan steg 2 | ${decComma(fit.cv.without, 5)} |`);
    lines.push(`| Tak ±8 % | ${decComma(decision.cv8, 5)} |`);
    lines.push(`| Tak ±12 % | ${decComma(decision.cv12, 5)} |`);
    lines.push("");
    lines.push(
      `Steg 1:s cvRmseLog (${decComma(fit.cvRmseLog, 5)}) räknas före steg 2 och kan inte skilja ±8 % från ±12 %, så den avgör ingenting här.`,
    );
    lines.push("");
    lines.push(decision.verdict);
    if (compare.capStepNeeded === false) {
      lines.push("");
      lines.push("Inget steg-2-värde ligger på ±8 %, så taket vidgas inte (D-03), vad korsvalideringen än visar.");
    } else if (compare.capStepNeeded === true) {
      const eight = compare.fitReports.find((r) => Math.abs(r.capPct - 0.08) < 1e-9);
      lines.push("");
      lines.push(`På taket vid ±8 %: ${eight === undefined ? "okänt" : eight.onCap.join(", ")}.`);
    }
    lines.push("");
    const corr =
      fit.avgiftDebt === null
        ? `saknas (för få rader, n = ${groupThousands(fit.correlationRows)})`
        : `${decComma(fit.avgiftDebt, 2)} (n = ${groupThousands(fit.correlationRows)})`;
    lines.push(`Korrelation avgift/kvm och skuld/kvm: ${corr}`);
    lines.push("");
    lines.push(
      `Takhöjd: ${fit.ceiling.soldRowsWithHeight} sålda rader med angiven höjd; ${fit.ceiling.fitted ? "anpassad" : "ej anpassad"} (${fit.ceiling.reason})`,
    );
    lines.push("");
  }

  return lines.join("\n");
}
