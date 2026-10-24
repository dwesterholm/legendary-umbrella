/**
 * The a-to-e comparison of the layout read variants (Phase 14.5, plan 09, R-05 and R-10): precision per field with its
 * Wilson interval, the gate, and what the variant costs per flat and in seconds, side by side.
 *
 * Two questions are answered separately, on purpose:
 *  - `strictWinner`: a variant that passes ALL THREE fields (the D-11 rule that plan 12 turns into the switch). A field
 *    that is not measurable cannot pass, so while bedroom side has fewer than 12 decided truth rows this stays null.
 *  - `productionCandidate`: among the variants that pass every MEASURABLE field, the cheapest per flat (R-10). It tells
 *    which variant to prefer when the measurable fields are enough, and does not move the switch.
 *
 * Pure: no file access, no network. The script feeds it the reports and the round logs.
 */
import {
  ACCURACY_FIELDS,
  ACCURACY_TARGET,
  formatPrecision,
  type AccuracyField,
  type AccuracyReport,
  type Precision,
} from "@/lib/discovery/layout-accuracy";
import { formatSek } from "@/lib/discovery/sun-floorplan";

/** The columns of the table, in the fixed order; d appears per tier, only for a tier that has a report. */
export const COMPARE_VARIANT_IDS = ["a", "b", "c", "d-sonnet", "d-opus", "e"] as const;

const FIELD_NAME: Record<AccuracyField, string> = { balcony: "Balkongsida", korsdrag: "Korsdrag", bedroom: "Sovrumssida" };

/** What a round cost and how long it took, read from its log (kr) and its timing file (seconds). */
export interface RoundStats {
  /** Live calls the round made (cache hits are not calls). */
  calls: number | null;
  /** Kronor of the round's own calls ("denna omgång"). */
  roundSek: number | null;
  /** Seconds the round took on the clock, or null when it was not timed. */
  seconds: number | null;
}

export interface CompareInput {
  variant: string;
  report: AccuracyReport | undefined;
  /** Everything the variant has paid in all runs and smokes (its cache's spentSekTotal). */
  variantSek: number;
  stats: RoundStats | null;
}

export interface FieldCell {
  measurable: boolean;
  decidedRows: number;
  gate: number | null;
  dev: Precision | null;
  holdout: Precision | null;
  pooled: Precision | null;
  pass: boolean;
  reason: string | null;
}

export interface CompareColumn {
  variant: string;
  ran: boolean;
  fields: Record<AccuracyField, FieldCell> | null;
  /** Raw read-right counts without any gate: "12 av 14", for context next to the believed answers. */
  raw: Record<AccuracyField, { correct: number; read: number; decided: number }> | null;
  /** Live calls, kronor of the round, kronor per flat (round / calls), seconds per flat. Null where not recorded. */
  calls: number | null;
  sekRound: number | null;
  sekPerFlat: number | null;
  sekVariantTotal: number;
  secondsRound: number | null;
  secondsPerFlat: number | null;
  /** True when every measurable field passes (and at least one is measurable). Null when the variant did not run. */
  passMeasurable: boolean | null;
  /** True when all three fields pass. Null when the variant did not run. */
  passAll: boolean | null;
  /** For each measurable field that fails: the rule and how far from the bar. */
  shortfalls: { field: AccuracyField; text: string }[];
}

export interface Comparison {
  columns: CompareColumn[];
  measurableFields: AccuracyField[];
  unmeasurableFields: AccuracyField[];
  /** Variants that pass every measurable field. */
  measurablePassing: string[];
  /**
   * The cheapest per flat among those that pass AND have a measured cost; null when none passes or none has a measured cost
   * (WR-05: a variant whose cost is unknown is never called cheapest).
   */
  productionCandidate: string | null;
  /** Variants that pass every measurable field but have no measured cost per flat; they are left out of the candidate choice. */
  costUnmeasuredPassing: string[];
  /** The first column passing all three fields; null when none does. */
  strictWinner: string | null;
  totalSpentSek: number;
}

/**
 * Calls and kronor of a round out of its log line: "Omgång c: 59 anrop, 1 från cache, 0 över taket, 0 misslyckade; 35,12 kr
 * denna omgång (tak 40,00 kr), ...". With `id` only the line of that variant counts (the d log holds d-sonnet or d-opus).
 * Null without such a line.
 */
export function parseRoundLog(text: string, id?: string): { calls: number; roundSek: number } | null {
  const who = id === undefined ? "[^:\\n]+" : id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^Omgång ${who}: (\\d+) anrop,[^\\n]*?; (\\d+(?:,\\d+)?) kr denna omgång`, "m").exec(text);
  if (m === null) return null;
  return { calls: Number(m[1]), roundSek: Number(m[2].replace(",", ".")) };
}

const pctInt = (x: number): number => Math.round(100 * x);

export interface ClosestPoint {
  t: number;
  k: number;
  n: number;
}

/**
 * The point of a dev curve nearest to the bar when no gate was found: among the points at or over the target precision,
 * the one with most believed answers; if none reaches it, the most precise one (ties: most believed answers). Null for an
 * empty curve or one with no believed answer. Pure.
 */
export function closestToGate(curve: readonly { t: number; nBelieved: number; nCorrect: number }[]): ClosestPoint | null {
  const live = curve.filter((p) => p.nBelieved > 0);
  if (live.length === 0) return null;
  const over = live.filter((p) => p.nCorrect / p.nBelieved >= ACCURACY_TARGET - 1e-9);
  const pool = over.length > 0 ? over : live;
  let best = pool[0];
  for (const p of pool) {
    const rate = p.nCorrect / p.nBelieved;
    const bestRate = best.nCorrect / best.nBelieved;
    const better = over.length > 0 ? p.nBelieved > best.nBelieved : rate > bestRate + 1e-9 || (Math.abs(rate - bestRate) <= 1e-9 && p.nBelieved > best.nBelieved);
    if (better) best = p;
  }
  return { t: best.t, k: best.nCorrect, n: best.nBelieved };
}

function shortfallText(field: AccuracyField, cell: FieldCell, closest: ClosestPoint | null): string {
  const base = cell.reason ?? "klarar inte kraven";
  if (cell.gate === null && closest !== null) {
    return `${FIELD_NAME[field]}: ${base}; närmast kravet på dev var ${closest.k} av ${closest.n} trodda svar vid spärren ${closest.t.toFixed(2).replace(".", ",")}`;
  }
  const h = cell.holdout;
  if (h !== null && h.n > 0 && h.k / h.n < ACCURACY_TARGET) {
    const gap = pctInt(ACCURACY_TARGET) - pctInt(h.k / h.n);
    return `${FIELD_NAME[field]}: ${base} (${gap} procentenheter under kravet)`;
  }
  return `${FIELD_NAME[field]}: ${base}`;
}

function columnOf(input: CompareInput): CompareColumn {
  const { report, stats } = input;
  const calls = stats?.calls ?? null;
  const sekRound = stats?.roundSek ?? null;
  const sekPerFlat = calls !== null && calls > 0 && sekRound !== null ? sekRound / calls : null;
  const secondsRound = stats?.seconds ?? null;
  const secondsPerFlat = calls !== null && calls > 0 && secondsRound !== null ? secondsRound / calls : null;
  const base = { variant: input.variant, calls, sekRound, sekPerFlat, sekVariantTotal: input.variantSek, secondsRound, secondsPerFlat };
  if (report === undefined) {
    return { ...base, ran: false, fields: null, raw: null, passMeasurable: null, passAll: null, shortfalls: [] };
  }
  const fields = Object.fromEntries(
    ACCURACY_FIELDS.map((f) => {
      const r = report.fields[f];
      const cell: FieldCell = {
        measurable: r.measurable,
        decidedRows: r.decidedRows,
        gate: r.gate,
        dev: r.dev,
        holdout: r.holdout,
        pooled: r.pooled,
        pass: r.pass,
        reason: r.reason,
      };
      return [f, cell];
    }),
  ) as Record<AccuracyField, FieldCell>;
  const raw = Object.fromEntries(
    ACCURACY_FIELDS.map((f) => [f, { correct: report.raw[f].correct, read: report.raw[f].read, decided: report.raw[f].decided }]),
  ) as Record<AccuracyField, { correct: number; read: number; decided: number }>;
  const measurable = ACCURACY_FIELDS.filter((f) => fields[f].measurable);
  const passMeasurable = measurable.length > 0 && measurable.every((f) => fields[f].pass);
  const passAll = ACCURACY_FIELDS.every((f) => fields[f].pass);
  const shortfalls = measurable
    .filter((f) => !fields[f].pass)
    .map((f) => ({ field: f, text: shortfallText(f, fields[f], closestToGate(report.fields[f].curveDev)) }));
  return { ...base, ran: true, fields, raw, passMeasurable, passAll, shortfalls };
}

/**
 * Builds the comparison of the variants that have a report, in the fixed column order. A tier of d without a report
 * is left out; a, b, c and e are always listed (as "inte körd" when they have no report). The production candidate is
 * the cheapest per flat among the variants passing every measurable field; a tie goes to the earlier column. Pure.
 */
export function compareVariants(inputs: readonly CompareInput[]): Comparison {
  const byId = new Map(inputs.map((i) => [i.variant, i]));
  const columns: CompareColumn[] = [];
  for (const id of COMPARE_VARIANT_IDS) {
    const input = byId.get(id);
    const isD = id === "d-sonnet" || id === "d-opus";
    if (isD && (input === undefined || input.report === undefined)) continue;
    columns.push(columnOf(input ?? { variant: id, report: undefined, variantSek: 0, stats: null }));
  }
  const firstRun = columns.find((c) => c.fields !== null);
  const measurableFields = firstRun?.fields ? ACCURACY_FIELDS.filter((f) => firstRun.fields?.[f].measurable) : [];
  const unmeasurableFields = firstRun?.fields ? ACCURACY_FIELDS.filter((f) => !firstRun.fields?.[f].measurable) : [];
  const passing = columns.filter((c) => c.passMeasurable === true);
  let candidate: CompareColumn | null = null;
  const costUnmeasuredPassing: string[] = [];
  for (const c of passing) {
    // WR-05: no parsed round log means no cost; such a column is not "cheapest" by default (it used to be priced as infinite
    // and still won when it was alone or first).
    if (c.sekPerFlat === null) {
      costUnmeasuredPassing.push(c.variant);
      continue;
    }
    if (candidate === null || c.sekPerFlat < (candidate.sekPerFlat as number)) candidate = c;
  }
  const strict = columns.find((c) => c.passAll === true) ?? null;
  const totalSpentSek = columns.reduce((sum, c) => sum + (Number.isFinite(c.sekVariantTotal) && c.sekVariantTotal > 0 ? c.sekVariantTotal : 0), 0);
  return {
    columns,
    measurableFields,
    unmeasurableFields,
    measurablePassing: passing.map((c) => c.variant),
    productionCandidate: candidate?.variant ?? null,
    costUnmeasuredPassing,
    strictWinner: strict?.variant ?? null,
    totalSpentSek,
  };
}

const kr = (n: number | null): string => (n === null ? "ej mätt" : formatSek(n));
const krFlat = (n: number | null): string => (n === null ? "ej mätt" : n.toFixed(3).replace(".", ","));
const sec = (n: number | null): string => (n === null ? "ej mätt" : n.toFixed(1).replace(".", ","));
const gateText = (g: number | null): string => (g === null ? "ingen" : g.toFixed(2).replace(".", ","));
const yes = (b: boolean | null): string => (b === null ? "-" : b ? "ja" : "nej");

function cellText(p: Precision | null, ran: boolean): string {
  if (!ran) return "-";
  return p === null ? "ingen spärr" : formatPrecision(p);
}

/**
 * The comparison as Swedish markdown: one column per variant, rows for gate, dev, holdout and pooled precision per field
 * (with the Wilson interval and the believed-call count), then kr per lägenhet, kr for the round, seconds per flat,
 * the two pass lines, and the verdict. Pure.
 */
export function renderComparisonMd(c: Comparison): string {
  const cols = c.columns;
  const head = ["Mått", ...cols.map((x) => x.variant)];
  const rows: string[][] = [];
  const add = (label: string, f: (x: CompareColumn) => string) => rows.push([label, ...cols.map(f)]);

  add("Körd", (x) => (x.ran ? "ja" : "nej"));
  for (const field of ACCURACY_FIELDS) {
    const name = FIELD_NAME[field];
    const measurable = !(cols.find((x) => x.fields !== null)?.fields?.[field].measurable === false);
    const nDecided = cols.find((x) => x.fields !== null)?.fields?.[field].decidedRows ?? 0;
    add(`${name}: avgjorda sanningsrader`, (x) => (x.ran ? `${nDecided}${measurable ? "" : " (ej mätbart)"}` : "-"));
    add(`${name}: rå, rätt av lästa`, (x) => (x.raw ? `${x.raw[field].correct} av ${x.raw[field].read}` : "-"));
    add(`${name}: spärr`, (x) => (!x.fields ? "-" : gateText(x.fields[field].gate)));
    add(`${name}: holdout, trodda svar rätt`, (x) => cellText(x.fields?.[field].holdout ?? null, x.ran));
    add(`${name}: poolat (dev + holdout)`, (x) => cellText(x.fields?.[field].pooled ?? null, x.ran));
    add(`${name}: klarar kraven`, (x) => yes(x.fields ? x.fields[field].pass : null));
  }
  add("kr per lägenhet", (x) => krFlat(x.sekPerFlat));
  add("kr för omgången", (x) => kr(x.sekRound));
  add("kr för varianten inklusive rökprov", (x) => (x.ran || x.sekVariantTotal > 0 ? formatSek(x.sekVariantTotal) : "-"));
  add("sekunder per lägenhet", (x) => sec(x.secondsPerFlat));
  add("Klarar alla mätbara fält", (x) => yes(x.passMeasurable));
  add("Klarar alla tre fälten", (x) => yes(x.passAll));

  const out: string[] = [];
  out.push("## Jämförelse a till e");
  out.push("");
  out.push(
    `Trodda svar är de vars säkerhet ligger på eller över spärren som valdes på dev-lägenheterna. Precision är andelen av dem som var rätt, med 95 % Wilson-intervall. Kravet är ${pctInt(ACCURACY_TARGET)} % på holdout med minst 5 trodda svar och minst 10 poolat.`,
  );
  out.push("");
  out.push(`| ${head.join(" | ")} |`);
  out.push(`| ${head.map(() => "---").join(" | ")} |`);
  for (const r of rows) out.push(`| ${r.join(" | ")} |`);
  out.push("");
  out.push("## Beslut");
  out.push("");
  const measurableNames = c.measurableFields.map((f) => FIELD_NAME[f].toLowerCase());
  const unmeasurableNames = c.unmeasurableFields.map((f) => FIELD_NAME[f].toLowerCase());
  out.push(`Mätbara fält: ${measurableNames.join(", ") || "inga"}. Ej mätbara fält: ${unmeasurableNames.join(", ") || "inga"}.`);
  out.push("");
  out.push(`Klarar alla tre fälten (kravet för brytaren, D-11): ${c.strictWinner ?? "ingen"}.`);
  if (c.measurablePassing.length === 0) {
    out.push(`Klarar alla mätbara fält: ingen.`);
  } else {
    if (c.productionCandidate === null) {
      out.push(
        `Klarar alla mätbara fält: ${c.measurablePassing.join(", ")}. Kostnad ej mätt för de som klarar kraven (${c.costUnmeasuredPassing.join(", ")}), så ingen produktionskandidat enligt R-10 kan väljas.`,
      );
    } else {
      out.push(
        `Klarar alla mätbara fält: ${c.measurablePassing.join(", ")}. Billigast per lägenhet av dem, och därmed produktionskandidat enligt R-10: ${c.productionCandidate}.`,
      );
      if (c.costUnmeasuredPassing.length > 0) {
        out.push(`Kostnad ej mätt för ${c.costUnmeasuredPassing.join(", ")}; de ingår inte i jämförelsen av kostnad.`);
      }
    }
  }
  out.push("");
  for (const col of cols) {
    if (!col.ran) {
      out.push(`- ${col.variant}: inte körd.`);
      continue;
    }
    if (col.shortfalls.length === 0) {
      out.push(`- ${col.variant}: alla mätbara fält klarar kraven.`);
      continue;
    }
    out.push(`- ${col.variant}: ${col.shortfalls.map((s) => s.text).join(" | ")}.`);
  }
  out.push("");
  out.push(`Total Anthropic- och Jev-kostnad för alla varianter: ${formatSek(c.totalSpentSek)} kr (Apify 0 USD).`);
  return `${out.join("\n")}\n`;
}
