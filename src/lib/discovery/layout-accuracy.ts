/**
 * layout-accuracy.ts - the measuring stick for the layout read (Phase 14.5 plan 02, LAYACC-01..03, D-09, D-11,
 * D-12 as amended by R-05).
 *
 * The question it answers: is the layout read (layout-read.ts, believed through layout-fact.ts) right often
 * enough to be allowed to move money? "Right" is checked against a truth file: flats whose floor plan and photos
 * a person judged by eye, with the judge's evidence, written down BEFORE any model read is compared.
 *
 * What the pieces output (counts, ids and enums only; never a URL, an address or a picture):
 *  - the truth-file format ({@link layoutTruthFileSchema}): one row per flat, digit-only Booli id, the truth for
 *    balcony side, living room on the balcony side, window sides and bedroom side ("undecidable" is a valid
 *    answer and is counted, never guessed), the judge's confidence, evidence words and a one-line note;
 *  - {@link rawFieldScores}: per field, how many truth rows are decided, how many of those have a read that
 *    answers the question, how many of those answers are right (no confidence gate: the raw accuracy);
 *  - {@link curveOf} and {@link gateFromCurve}: for each distinct confidence the read gave, how many answers
 *    that move money are believed at that confidence and how many of them are right (the PRECISION of the
 *    answer that moves money: korsdrag "ja", bedroom "courtyard", a street/courtyard balcony side), with Wilson
 *    95 % intervals; the gate is read off that curve on the development rows, never assumed;
 *  - {@link fieldVerdict} and {@link variantVerdict}: the switch rule as code. A field passes only when it is
 *    measurable (at least {@link MIN_DECIDED_TRUTH_ROWS} decided truth rows, else "ej mätbart (n = k)"), a dev
 *    gate exists, and the same gate holds {@link ACCURACY_TARGET} on the locked holdout rows and on dev + holdout
 *    pooled, each with enough believed calls. All-calls accuracy and the raw accuracy are printed beside it;
 *  - {@link accuracyReport} and {@link renderAccuracyMd}: the whole picture, counts only, in JSON and in Swedish
 *    markdown;
 *  - the truth-set tools: {@link worklistOf} (the Booli ids to judge, Folkungagatan 61 first, then a seeded
 *    order; ids and allowed picture URLs only, never a read), {@link selectTruthSet} and {@link assignSplit}
 *    (which judged flats form the measured set, the 50/50 stratified dev/holdout split with Folkungagatan 61
 *    forced into the holdout, and the seeded read order), {@link lockTruthFile} (fixes all of that plus a hash of
 *    the rows and of the written procedure BEFORE any paid run) and {@link validateTruthFile} (catches a
 *    malformed or edited file).
 *
 * The numbers are precision on flats a judge could decide, not accuracy on a random sample: selecting flats
 * whose pictures settle the question favours cases where the model also sees the evidence. The triage counts in
 * the truth file say how much of the population that is.
 *
 * Pure: no clock, no randomness (seeded hashing only), no file system, no network, no SDK. Reads arrive as a
 * `Map<booliId, LayoutFact>` so the module does not care whether they come from the production cache, an
 * experiment cache or a snapshot.
 *
 * STRUCTURAL SEPARATION (LOCKED): `niche-score.ts` and `report/flags.ts` must never import it (the
 * "discovery/layout-" specifier in niche-score.test.ts enforces that).
 */
import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { isAllowedImageHost } from "@/lib/booli/image-host";
import { booliIdOf } from "@/lib/discovery/fit-score";
import {
  LAYOUT_MIN_CONFIDENCE,
  STREET_EVIDENCE,
  believedLayout,
  type BelievedLayout,
  type LayoutFact,
  type LayoutGatePolicy,
} from "@/lib/discovery/layout-fact";

// ---------------------------------------------------------------------------
// The truth file
// ---------------------------------------------------------------------------

/** What a judge may name as evidence for street versus courtyard (RESEARCH Q5, procedure step 4). */
export const TRUTH_EVIDENCE = [
  "cars",
  "roadway",
  "streetLamps",
  "shopfronts",
  "tramWires",
  "facadeAcrossRoad",
  "bicycleRacks",
  "lawn",
  "playground",
  "pavedCourtyardPlanters",
  "ownRearFacade",
  "none",
] as const;

export type TruthEvidence = (typeof TRUTH_EVIDENCE)[number];

/** A URL or a host (T-14.5-07): the note never carries a link. */
const LINK_IN_NOTE = /http|www/i;
/** A street name ending glued to a name ("Folkungagatan", "Sveavägen", "Götgatan"); "mot gatan" alone is ordinary speech. */
const STREET_NAME_GLUED = /\p{L}+(?:gatan|vägen|gränd|torget)\b/iu;
/** A capitalised name followed by a street word ("Mårten Trotzigs gränd", "Stureplan torget"). Case-sensitive on purpose. */
const STREET_NAME_SPACED = /\p{Lu}\p{L}+\s+(?:gränd|torget|vägen)\b/u;

const noteSchema = z
  .string()
  .min(1)
  .max(160)
  .refine((s) => !LINK_IN_NOTE.test(s), "en notering får inte innehålla en länk")
  .refine((s) => !STREET_NAME_GLUED.test(s) && !STREET_NAME_SPACED.test(s), "en notering får inte innehålla ett gatunamn");

/**
 * One judged flat. `split` and `order` stay null until the file is locked (plan 02 task 3); `inSet` says whether
 * the flat belongs to the measured set. Strict: an extra key such as an address or a URL is an error.
 */
export const truthRowSchema = z.strictObject({
  booliId: z.number().int().positive(),
  position: z.number().int().min(1),
  source: z.enum(["known", "judged"]),
  inSet: z.boolean(),
  split: z.enum(["dev", "holdout"]).nullable(),
  order: z.number().int().min(1).nullable(),
  planPresent: z.boolean(),
  balconySide: z.enum(["street", "courtyard", "none", "undecidable"]),
  livingOnBalconySide: z.enum(["yes", "no", "undecidable"]),
  windowSides: z.enum(["one", "twoOpposite", "corner", "undecidable"]),
  bedroomSide: z.enum(["street", "courtyard", "undecidable"]),
  judgeConfidence: z.enum(["high", "medium", "low"]),
  evidence: z.array(z.enum(TRUTH_EVIDENCE)).min(1),
  note: noteSchema,
});

export type TruthRow = z.infer<typeof truthRowSchema>;

const triageSchema = z.strictObject({
  judged: z.number().int().min(0),
  unavailable: z.number().int().min(0),
  balconyDecided: z.number().int().min(0),
  windowsDecided: z.number().int().min(0),
  bedroomDecided: z.number().int().min(0),
  livingDecided: z.number().int().min(0),
});

/** The whole file: the lock fields are all null until `lockTruthFile` writes them. */
export const layoutTruthFileSchema = z.strictObject({
  version: z.literal(1),
  seed: z.string().min(1),
  lockedAt: z.string().nullable(),
  rowsHash: z.string().nullable(),
  procedureHash: z.string().nullable(),
  selectionRule: z.string().nullable(),
  triage: triageSchema.nullable(),
  unavailable: z.array(z.number().int().positive()),
  rows: z.array(truthRowSchema),
});

export type TruthFile = z.infer<typeof layoutTruthFileSchema>;

// ---------------------------------------------------------------------------
// Truth and read mapped onto the questions that move money
// ---------------------------------------------------------------------------

/**
 * Korsdrag (through-draught) from a window-sides value: twoOpposite is "ja", one and corner are "nej", anything
 * else is no answer. The same mapping as `korsdragWhen` in layout-fact.ts, applied to truth and to reads alike.
 */
export function korsdragFromSides(sides: string): boolean | null {
  if (sides === "twoOpposite") return true;
  if (sides === "one" || sides === "corner") return false;
  return null;
}

const isSide = (s: string): s is "street" | "courtyard" => s === "street" || s === "courtyard";

// ---------------------------------------------------------------------------
// Raw scores (no confidence gate)
// ---------------------------------------------------------------------------

export interface RawFieldScore {
  /** Truth rows in the set where the truth is decided for this field. */
  decided: number;
  /** Of those, rows whose read answers the question (a "none" or "unknown" read is no answer). */
  read: number;
  /** Of those, answers equal to the truth. */
  correct: number;
  /** Truth rows in the set marked undecidable for this field: left out of `decided`, counted here. */
  undecidable: number;
}

export interface RawFieldScores {
  /** The street/courtyard question only; a truth "none" is not counted in this field's raw score. */
  balcony: RawFieldScore;
  /** Korsdrag ja/nej from the window sides. */
  korsdrag: RawFieldScore;
  /** Bedroom street/courtyard. */
  bedroom: RawFieldScore;
  /** Rows in the set with no read at all. */
  noRead: number;
}

const zero = (): RawFieldScore => ({ decided: 0, read: 0, correct: 0, undecidable: 0 });

/**
 * Raw accuracy per field over the rows that are in the set. Pure: the reads map is the only place a model's
 * answer enters.
 */
export function rawFieldScores(rows: readonly TruthRow[], reads: ReadonlyMap<number, LayoutFact>): RawFieldScores {
  const balcony = zero();
  const korsdrag = zero();
  const bedroom = zero();
  let noRead = 0;

  for (const row of rows) {
    if (!row.inSet) continue;
    const read = reads.get(row.booliId) ?? null;
    if (read === null) noRead += 1;

    if (row.balconySide === "undecidable") balcony.undecidable += 1;
    else if (isSide(row.balconySide)) {
      balcony.decided += 1;
      if (read !== null && isSide(read.balconySide)) {
        balcony.read += 1;
        if (read.balconySide === row.balconySide) balcony.correct += 1;
      }
    }

    const truthKorsdrag = korsdragFromSides(row.windowSides);
    if (row.windowSides === "undecidable") korsdrag.undecidable += 1;
    else if (truthKorsdrag !== null) {
      korsdrag.decided += 1;
      const readKorsdrag = read === null ? null : korsdragFromSides(read.windowSides);
      if (readKorsdrag !== null) {
        korsdrag.read += 1;
        if (readKorsdrag === truthKorsdrag) korsdrag.correct += 1;
      }
    }

    if (row.bedroomSide === "undecidable") bedroom.undecidable += 1;
    else {
      bedroom.decided += 1;
      if (read !== null && isSide(read.bedroomSide)) {
        bedroom.read += 1;
        if (read.bedroomSide === row.bedroomSide) bedroom.correct += 1;
      }
    }
  }

  return { balcony, korsdrag, bedroom, noRead };
}

// ---------------------------------------------------------------------------
// The decision rule: constants
// ---------------------------------------------------------------------------

/** The bar: at least 75 % of the believed money-moving answers must be right (D-11, Daniel: "at least > 75 % reliable"). */
export const ACCURACY_TARGET = 0.75;
/** R-05: a field with fewer decided truth rows than this is "ej mätbart (n = k)" and can never pass. */
export const MIN_DECIDED_TRUTH_ROWS = 12;
/** Believed calls needed on the dev rows for a point of the curve to choose the gate (plan 02 assumption). */
export const MIN_BELIEVED_DEV = 5;
/** Believed calls needed on the holdout rows at the chosen gate. */
export const MIN_BELIEVED_HOLDOUT = 5;
/** Believed calls needed on dev + holdout pooled at the chosen gate. */
export const MIN_BELIEVED_TOTAL = 10;
/** D-12: the evidence that may settle street versus courtyard; oppositeFacade fits both sides and must earn its place. */
export const DEFAULT_SIDE_EVIDENCE: readonly SideEvidence[] = ["cars", "courtyardGreenery"];

export type SideEvidence = "cars" | "oppositeFacade" | "courtyardGreenery";
export type AccuracyField = "balcony" | "korsdrag" | "bedroom";
export const ACCURACY_FIELDS: readonly AccuracyField[] = ["balcony", "korsdrag", "bedroom"];
/** Which rows of the set a number is computed over: the development half, the locked holdout half, or every row in the set. */
export type SplitSelector = "dev" | "holdout" | "all";

// ---------------------------------------------------------------------------
// Wilson interval
// ---------------------------------------------------------------------------

/** Wilson score interval for k of n (95 % at z = 1.96). With n = 0 it is the whole range: nothing was measured. */
export function wilson(k: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const a = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, (c - a) / d), high: Math.min(1, (c + a) / d) };
}

/** k of n with its Wilson bounds; `precision` is null when nothing was believed. */
export interface Precision {
  k: number;
  n: number;
  precision: number | null;
  low: number;
  high: number;
}

const precisionOf = (k: number, n: number): Precision => ({ k, n, precision: n === 0 ? null : k / n, ...wilson(k, n) });

// ---------------------------------------------------------------------------
// Believed calls
// ---------------------------------------------------------------------------

const inSelection = (row: TruthRow, sel: SplitSelector): boolean => row.inSet && (sel === "all" || row.split === sel);

/** The confidence a fact has for a field: its own when it carries one, else the single confidence. */
function fieldConfidenceOf(fact: LayoutFact, field: AccuracyField): number {
  const own = fact.fieldConfidence;
  if (own === undefined) return fact.confidence;
  return field === "balcony" ? own.balcony : field === "korsdrag" ? own.windows : own.bedroom;
}

/**
 * The policy a believed call is computed under: the gate under test for the field, 0 for the other gates, the
 * production negative gate, any version trusted. The call itself is made by `believedLayout`, so the rule that is
 * measured here is the rule layout-fact.ts defines.
 */
function policyAt(field: AccuracyField, t: number, sideEvidence: readonly SideEvidence[]): LayoutGatePolicy {
  return {
    balconyGate: field === "balcony" ? t : 0,
    windowsGate: field === "korsdrag" ? t : 0,
    bedroomGate: field === "bedroom" ? t : 0,
    negativeGate: LAYOUT_MIN_CONFIDENCE,
    sideEvidence,
    trustedVersion: null,
  };
}

/**
 * The money-moving call of a field, or null when there is none or the truth cannot judge it: balcony street or
 * courtyard (wrong on a truth "none" flat), korsdrag "ja" (right only on twoOpposite), bedroom "courtyard" (right
 * only on a courtyard bedroom). An undecidable truth row is excluded, never counted.
 */
function moneyCall(row: TruthRow, believed: BelievedLayout, field: AccuracyField): boolean | null {
  if (field === "balcony") {
    if (believed.balconySide === null || row.balconySide === "undecidable") return null;
    return row.balconySide === believed.balconySide;
  }
  if (field === "korsdrag") {
    if (believed.korsdrag !== true || row.windowSides === "undecidable") return null;
    return row.windowSides === "twoOpposite";
  }
  if (believed.bedroomSide !== "courtyard" || row.bedroomSide === "undecidable") return null;
  return row.bedroomSide === "courtyard";
}

/** Every believed answer of a field, "nej", "street" and "ingen balkong" included; same exclusions as {@link moneyCall}. */
function anyCall(row: TruthRow, believed: BelievedLayout, field: AccuracyField): boolean | null {
  if (field === "balcony") {
    const answer = believed.balconySide ?? (believed.noBalcony ? "none" : null);
    if (answer === null || row.balconySide === "undecidable") return null;
    return row.balconySide === answer;
  }
  if (field === "korsdrag") {
    if (believed.korsdrag === null || row.windowSides === "undecidable") return null;
    return korsdragFromSides(row.windowSides) === believed.korsdrag;
  }
  if (believed.bedroomSide === null || row.bedroomSide === "undecidable") return null;
  return row.bedroomSide === believed.bedroomSide;
}

/** Believed calls and right calls of a field at gate `t` over the selected rows. */
function tally(
  rows: readonly TruthRow[],
  reads: ReadonlyMap<number, LayoutFact>,
  field: AccuracyField,
  t: number,
  sideEvidence: readonly SideEvidence[],
  sel: SplitSelector,
  kind: "money" | "all",
): { n: number; k: number } {
  const policy = policyAt(field, t, sideEvidence);
  let n = 0;
  let k = 0;
  for (const row of rows) {
    if (!inSelection(row, sel)) continue;
    const read = reads.get(row.booliId);
    if (read === undefined) continue;
    const believed = believedLayout(read, policy);
    const verdict = kind === "money" ? moneyCall(row, believed, field) : anyCall(row, believed, field);
    if (verdict === null) continue;
    n += 1;
    if (verdict) k += 1;
  }
  return { n, k };
}

// ---------------------------------------------------------------------------
// The curve and the gate
// ---------------------------------------------------------------------------

/** One point of the confidence curve: at threshold `t`, how many money-moving answers are believed and how many are right. */
export interface CurvePoint {
  t: number;
  nBelieved: number;
  nCorrect: number;
  /** 0 when nothing is believed (see `nBelieved`). */
  precision: number;
  low: number;
  high: number;
}

/**
 * The confidence curve of a field over the selected rows: one point per distinct field confidence the reads
 * carry, ascending, no interpolation (the model's confidence is coarse, a few distinct values).
 */
export function curveOf(
  rows: readonly TruthRow[],
  reads: ReadonlyMap<number, LayoutFact>,
  field: AccuracyField,
  sideEvidence: readonly SideEvidence[],
  sel: SplitSelector,
): CurvePoint[] {
  const thresholds = new Set<number>();
  for (const row of rows) {
    if (!inSelection(row, sel)) continue;
    const read = reads.get(row.booliId);
    if (read !== undefined) thresholds.add(fieldConfidenceOf(read, field));
  }
  return [...thresholds]
    .sort((a, b) => a - b)
    .map((t) => {
      const { n, k } = tally(rows, reads, field, t, sideEvidence, sel, "money");
      const w = wilson(k, n);
      return { t, nBelieved: n, nCorrect: k, precision: n === 0 ? 0 : k / n, low: w.low, high: w.high };
    });
}

/**
 * The gate read off a curve: walk from the strictest threshold down; every point with at least `minN` believed
 * calls and precision at or above `target` lowers the gate; the first supported point that fails ends the walk
 * (a lucky dip further down does not count). Points with fewer than `minN` believed calls are skipped. Null when
 * no point qualifies: the field has no gate.
 */
export function gateFromCurve(curve: readonly CurvePoint[], minN: number, target: number): number | null {
  const strictestFirst = [...curve].sort((a, b) => b.t - a.t);
  let gate: number | null = null;
  for (const point of strictestFirst) {
    if (point.nBelieved < minN) continue;
    if (point.precision >= target) gate = point.t;
    else break;
  }
  return gate;
}

// ---------------------------------------------------------------------------
// Evidence (D-12)
// ---------------------------------------------------------------------------

export interface EvidenceRow {
  evidence: (typeof STREET_EVIDENCE)[number];
  balcony: { n: number; correct: number };
  bedroom: { n: number; correct: number };
}

/**
 * Street/courtyard side calls tabulated by the model's own evidence word, ungated by confidence. A call is a read
 * that names street or courtyard for the balcony or the bedroom where the truth can judge it (a balcony call on a
 * truth "none" flat is wrong). A read from a picture set without a floor plan abstains.
 */
export function byEvidence(rows: readonly TruthRow[], reads: ReadonlyMap<number, LayoutFact>, sel: SplitSelector): EvidenceRow[] {
  const table: EvidenceRow[] = STREET_EVIDENCE.map((evidence) => ({
    evidence,
    balcony: { n: 0, correct: 0 },
    bedroom: { n: 0, correct: 0 },
  }));
  for (const row of rows) {
    if (!inSelection(row, sel)) continue;
    const read = reads.get(row.booliId);
    if (read === undefined || read.planPresent === false) continue;
    const entry = table.find((e) => e.evidence === read.streetEvidence);
    if (entry === undefined) continue;
    if (isSide(read.balconySide) && row.balconySide !== "undecidable") {
      entry.balcony.n += 1;
      if (row.balconySide === read.balconySide) entry.balcony.correct += 1;
    }
    if (isSide(read.bedroomSide) && row.bedroomSide !== "undecidable") {
      entry.bedroom.n += 1;
      if (row.bedroomSide === read.bedroomSide) entry.bedroom.correct += 1;
    }
  }
  return table;
}

/**
 * The evidence words that may settle a side: cars and courtyardGreenery, plus oppositeFacade only when its own
 * dev precision (balcony and bedroom calls pooled) is at least {@link ACCURACY_TARGET} over at least
 * {@link MIN_BELIEVED_DEV} calls (D-12).
 */
export function sideEvidenceAllowlist(devTable: readonly EvidenceRow[]): SideEvidence[] {
  const allowed: SideEvidence[] = [...DEFAULT_SIDE_EVIDENCE];
  const opposite = devTable.find((e) => e.evidence === "oppositeFacade");
  if (opposite !== undefined) {
    const n = opposite.balcony.n + opposite.bedroom.n;
    const correct = opposite.balcony.correct + opposite.bedroom.correct;
    if (n >= MIN_BELIEVED_DEV && correct / n >= ACCURACY_TARGET) allowed.push("oppositeFacade");
  }
  return allowed;
}

// ---------------------------------------------------------------------------
// Measurability
// ---------------------------------------------------------------------------

export interface FieldMeasurability {
  measurable: boolean;
  decided: number;
  /** "ej mätbart (n = k)" when below the minimum, else null. */
  reason: string | null;
}

/** Decided truth rows in the set per field (balcony street|courtyard, windows one|twoOpposite|corner, bedroom street|courtyard). */
export function measurability(rows: readonly TruthRow[]): Record<AccuracyField, FieldMeasurability> {
  const raw = rawFieldScores(rows, new Map());
  const of = (decided: number): FieldMeasurability =>
    decided >= MIN_DECIDED_TRUTH_ROWS
      ? { measurable: true, decided, reason: null }
      : { measurable: false, decided, reason: `ej mätbart (n = ${decided})` };
  return { balcony: of(raw.balcony.decided), korsdrag: of(raw.korsdrag.decided), bedroom: of(raw.bedroom.decided) };
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/** Everything a field verdict needs; the report fills it from the rows, a test can hand-write it. */
export interface FieldEvidence {
  measurable: boolean;
  decidedRows: number;
  /** A locked truth file with a holdout half exists. */
  locked: boolean;
  /** The gate chosen on the dev rows, or null. */
  gate: number | null;
  dev: Precision | null;
  holdout: Precision | null;
  pooled: Precision | null;
}

const pctInt = (x: number): string => `${Math.round(100 * x)}`;
const commaDecimals = (n: number): string => n.toFixed(2).replace(".", ",");

/** "12 av 15 (80 %, 95 %: 55–93 %)" with the Wilson interval; "0 av 0" when nothing was believed. */
export function formatPrecision(p: Precision | null): string {
  if (p === null) return "-";
  if (p.n === 0) return "0 av 0 (inga svar)";
  return `${p.k} av ${p.n} (${pctInt(p.k / p.n)} %, 95 %: ${pctInt(p.low)}–${pctInt(p.high)} %)`;
}

/**
 * Whether a field passes, and every reason it does not (Swedish). A field passes only when it is measurable, the
 * truth file is locked with a holdout, a dev gate exists, holdout precision at that gate is at least
 * {@link ACCURACY_TARGET} over at least {@link MIN_BELIEVED_HOLDOUT} believed calls, and dev + holdout pooled is
 * at least {@link ACCURACY_TARGET} over at least {@link MIN_BELIEVED_TOTAL}. Gate and holdout reasons are only
 * listed when a locked holdout exists: without one they are the same failure.
 */
export function fieldVerdict(e: FieldEvidence): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!e.measurable) reasons.push(`ej mätbart (n = ${e.decidedRows})`);
  if (!e.locked) reasons.push("ingen låst holdout");
  else if (e.gate === null) {
    reasons.push(`ingen spärr når ${pctInt(ACCURACY_TARGET)} % på dev med minst ${MIN_BELIEVED_DEV} spådda svar`);
  } else {
    const at = `spärren ${commaDecimals(e.gate)}`;
    const check = (label: string, p: Precision | null, minN: number) => {
      const n = p?.n ?? 0;
      if (n < minN) reasons.push(`${label} har ${n} spådda svar vid ${at}, minst ${minN} krävs`);
      if (p !== null && p.n > 0 && p.k / p.n < ACCURACY_TARGET) {
        reasons.push(`${label}-precisionen ${p.k} av ${p.n} (${pctInt(p.k / p.n)} %) vid ${at} är under ${pctInt(ACCURACY_TARGET)} %`);
      }
    };
    check("holdout", e.holdout, MIN_BELIEVED_HOLDOUT);
    check("poolat", e.pooled, MIN_BELIEVED_TOTAL);
  }
  return { pass: reasons.length === 0, reasons };
}

/** The variant passes only when all three fields pass. */
export function variantVerdict(fields: Record<AccuracyField, { pass: boolean }>): boolean {
  return ACCURACY_FIELDS.every((f) => fields[f].pass);
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface FieldReport {
  measurable: boolean;
  decidedRows: number;
  /** The confidence curve on the development rows. */
  curveDev: CurvePoint[];
  /** The gate read off the dev curve, or null. */
  gate: number | null;
  dev: Precision | null;
  holdout: Precision | null;
  pooled: Precision | null;
  /** Accuracy over every believed answer of the field (including "nej", "street", "ingen balkong") at the same gate, dev + holdout pooled. */
  allCalls: Precision | null;
  pass: boolean;
  /** Every failing reason joined by "; ", or null when the field passes. */
  reason: string | null;
}

export interface AccuracyReport {
  /** Where the reads came from: "production" for the stored cache, a variant name for an experiment. */
  source: string;
  /** The read version (prompt + model + schema + logic hash) the reads carry. */
  version: string;
  /** A lockedAt exists and a holdout half exists. */
  truthLocked: boolean;
  lockedAt: string | null;
  /** Rows in the set. */
  rows: number;
  /** Rows in the set with no stored read at all. */
  noRead: number;
  /** Raw accuracy per field, no confidence gate. */
  raw: Pick<RawFieldScores, "balcony" | "korsdrag" | "bedroom">;
  measurability: Record<AccuracyField, FieldMeasurability>;
  /** The evidence words allowed to settle a side (D-12). */
  sideEvidence: SideEvidence[];
  byEvidence: { dev: EvidenceRow[]; holdout: EvidenceRow[] };
  fields: Record<AccuracyField, FieldReport>;
  /** WR-04: the read's "living room on the balcony side" against the truth yes/no. */
  livingOnBalconySide: { decided: number; read: number; correct: number };
  /** All three fields pass. */
  pass: boolean;
}

/** Counts only: never a per-flat read (blind judging depends on it). */
export function accuracyReport(
  file: TruthFile,
  reads: ReadonlyMap<number, LayoutFact>,
  meta: { source: string; version: string },
): AccuracyReport {
  const rows = file.rows;
  const inSet = rows.filter((r) => r.inSet);
  const scores = rawFieldScores(rows, reads);
  const measurable = measurability(rows);
  const locked = file.lockedAt !== null && inSet.some((r) => r.split === "holdout");
  const sideTable = { dev: byEvidence(rows, reads, "dev"), holdout: byEvidence(rows, reads, "holdout") };
  const sideEvidence = sideEvidenceAllowlist(sideTable.dev);
  const splitRows = inSet.filter((r) => r.split !== null);

  const fieldReport = (field: AccuracyField): FieldReport => {
    const curveDev = curveOf(rows, reads, field, sideEvidence, "dev");
    const gate = locked ? gateFromCurve(curveDev, MIN_BELIEVED_DEV, ACCURACY_TARGET) : null;
    const at = (sel: SplitSelector, over: readonly TruthRow[], kind: "money" | "all"): Precision | null => {
      if (gate === null) return null;
      const { n, k } = tally(over, reads, field, gate, sideEvidence, sel, kind);
      return precisionOf(k, n);
    };
    const dev = at("dev", rows, "money");
    const holdout = at("holdout", rows, "money");
    const pooled = at("all", splitRows, "money");
    const allCalls = at("all", splitRows, "all");
    const verdict = fieldVerdict({
      measurable: measurable[field].measurable,
      decidedRows: measurable[field].decided,
      locked,
      gate,
      dev,
      holdout,
      pooled,
    });
    return {
      measurable: measurable[field].measurable,
      decidedRows: measurable[field].decided,
      curveDev,
      gate,
      dev,
      holdout,
      pooled,
      allCalls,
      pass: verdict.pass,
      reason: verdict.pass ? null : verdict.reasons.join("; "),
    };
  };

  const fields = { balcony: fieldReport("balcony"), korsdrag: fieldReport("korsdrag"), bedroom: fieldReport("bedroom") };

  const living = { decided: 0, read: 0, correct: 0 };
  for (const row of inSet) {
    if (row.livingOnBalconySide === "undecidable") continue;
    living.decided += 1;
    const read = reads.get(row.booliId);
    if (read === undefined) continue;
    living.read += 1;
    if (read.livingOnBalconySide === (row.livingOnBalconySide === "yes")) living.correct += 1;
  }

  return {
    source: meta.source,
    version: meta.version,
    truthLocked: locked,
    lockedAt: file.lockedAt,
    rows: inSet.length,
    noRead: scores.noRead,
    raw: { balcony: scores.balcony, korsdrag: scores.korsdrag, bedroom: scores.bedroom },
    measurability: measurable,
    sideEvidence,
    byEvidence: sideTable,
    fields,
    livingOnBalconySide: living,
    pass: variantVerdict(fields),
  };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const FIELD_TITLE: Record<AccuracyField, string> = {
  balcony: "Balkong: gata eller gård",
  korsdrag: "Korsdrag: svaret \"ja\"",
  bedroom: "Sovrum: svaret \"gård\"",
};

const FIELD_CALL: Record<AccuracyField, string> = {
  balcony: "varje trott svar gata eller gård (fel om lägenheten saknar balkong)",
  korsdrag: "varje trott \"ja\" (fönster åt två motsatta sidor)",
  bedroom: "varje trott \"gård\" (tyst sovrum)",
};

const rawAsPrecision = (s: RawFieldScore): Precision => precisionOf(s.correct, s.read);

/** The report as Swedish markdown: status line, one table per field, the curves and the by-evidence table. Pure. */
export function renderAccuracyMd(report: AccuracyReport): string {
  const out: string[] = [];
  out.push(report.truthLocked ? `Sanningsfil: låst ${report.lockedAt ?? "-"}` : "Sanningsfil: olåst (ingen låst holdout)");
  out.push("");
  out.push(`# Träffsäkerhet för layoutläsningen (${report.source}, läsversion ${report.version})`);
  out.push("");
  out.push(
    `Rader i urvalet: ${report.rows}, utan lagrad läsning: ${report.noRead}. Det som avgör är precisionen i svaren som flyttar pengar, ` +
      `alltså andelen rätt bland de svar som tros (säkerhet vid eller över spärren). Spärren väljs ur kurvan på dev-raderna ` +
      `och prövas sedan på holdout-raderna och på dev och holdout tillsammans. Siffrorna gäller lägenheter som en bedömare kunde avgöra, ` +
      `inte ett slumpmässigt urval.`,
  );
  out.push("");
  out.push(`Tillåtna bevisord för sida: ${report.sideEvidence.join(", ")}.`);
  for (const field of ACCURACY_FIELDS) {
    const f = report.fields[field];
    out.push("");
    out.push(`## ${FIELD_TITLE[field]}`);
    out.push("");
    out.push(`Precisionen räknar ${FIELD_CALL[field]}.`);
    out.push("");
    out.push("| Mått | Värde |");
    out.push("| --- | --- |");
    out.push(`| Avgjorda sanningsrader | ${f.decidedRows} (minst ${MIN_DECIDED_TRUTH_ROWS} krävs) |`);
    out.push(`| Spärr (vald på dev) | ${f.gate === null ? "ingen" : commaDecimals(f.gate)} |`);
    out.push(`| Precision på dev | ${formatPrecision(f.dev)} |`);
    out.push(`| Precision på holdout | ${formatPrecision(f.holdout)} |`);
    out.push(`| Precision dev + holdout | ${formatPrecision(f.pooled)} |`);
    out.push(`| Rå träffsäkerhet (utan spärr, alla läsningar som svarar) | ${formatPrecision(rawAsPrecision(report.raw[field]))} |`);
    out.push(`| Träffsäkerhet för alla svar vid spärren | ${formatPrecision(f.allCalls)} |`);
    out.push(`| Utslag | ${f.pass ? "Godkänd" : "Inte godkänd"} |`);
    out.push(`| Skäl | ${f.reason ?? "-"} |`);
    out.push("");
    out.push("Kurva på dev (en rad per observerad säkerhet):");
    out.push("");
    out.push("| Säkerhet | Svar som tros | Rätt | Precision (95 %) |");
    out.push("| --- | --- | --- | --- |");
    if (f.curveDev.length === 0) out.push("| - | 0 | 0 | inga dev-rader med läsning |");
    for (const p of f.curveDev) {
      out.push(`| ${commaDecimals(p.t)} | ${p.nBelieved} | ${p.nCorrect} | ${p.nBelieved === 0 ? "-" : `${pctInt(p.precision)} % (${pctInt(p.low)}–${pctInt(p.high)} %)`} |`);
    }
  }
  out.push("");
  out.push("## Bevis för sidan (alla sidsvar, utan spärr)");
  out.push("");
  out.push("| Bevisord | Balkong dev | Sovrum dev | Balkong holdout | Sovrum holdout |");
  out.push("| --- | --- | --- | --- | --- |");
  const cell = (c: { n: number; correct: number }) => `${c.correct} av ${c.n}`;
  for (const [i, dev] of report.byEvidence.dev.entries()) {
    const hold = report.byEvidence.holdout[i];
    out.push(`| ${dev.evidence} | ${cell(dev.balcony)} | ${cell(dev.bedroom)} | ${cell(hold.balcony)} | ${cell(hold.bedroom)} |`);
  }
  const l = report.livingOnBalconySide;
  out.push("");
  out.push(`Vardagsrum på balkongsidan: ${l.correct} av ${l.read} lästa rätt av ${l.decided} avgjorda.`);
  out.push("");
  out.push(`Helhet: ${report.pass ? "Godkänd" : "Inte godkänd"} (alla tre fälten måste godkännas).`);
  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// The truth-set tools (plan 02 task 3)
// ---------------------------------------------------------------------------

/** The seed of the worklist order, the selection order, the split and the read order. */
export const TRUTH_SEED = "14.5";
/** Fewer rows in the set than this and the file cannot be locked: the research asked for at least 25 judged flats (D-09). */
export const TRUTH_SET_MIN_ROWS = 25;
/** The cap keeps one Opus round under 40 kr at about 0,6 to 0,8 kr per flat (D-13). */
export const TRUTH_SET_MAX_ROWS = 45;
/** Folkungagatan 61: the one flat with a known truth (row 1 of the file, forced into the holdout). */
export const F61_BOOLI_ID = 150148;

/** The selection rule as it is stored in the locked file. */
export const SELECTION_RULE =
  `Urval: bedömda lägenheter vars bilder gick att hämta. Först Folkungagatan 61 och alla lägenheter där balkongens eller sovrummets sida ` +
  `(gata eller gård) kunde avgöras, sedan lägenheter där fönstersidorna kunde avgöras, i en ordning som bestäms av fröet, högst ${TRUTH_SET_MAX_ROWS} rader. ` +
  `Lägenheter där inget kunde avgöras ingår inte. Siffrorna gäller därför precision på lägenheter en bedömare kunde avgöra, inte ett slumpmässigt urval.`;

/** The seeded rank of a Booli id: sha256 of "seed:id" in hex. Smaller sorts first. Deterministic and pure. */
export function seededRank(seed: string, booliId: number): string {
  return createHash("sha256").update(`${seed}:${booliId}`).digest("hex");
}

/** Items sorted by seeded rank of their Booli id. Does not mutate the input. */
function sortSeeded<T extends { booliId: number }>(items: readonly T[], seed: string): T[] {
  return items
    .map((item) => ({ item, rank: seededRank(seed, item.booliId) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map((x) => x.item);
}

// -- the worklist ------------------------------------------------------------

export interface WorklistEntry {
  /** 1-based place in the list. */
  position: number;
  booliId: number;
  /** The picture URLs that pass the Booli image-host allowlist, in snapshot order. */
  imageUrls: string[];
}

/**
 * The flats to judge: Booli ids of snapshot rows with at least two allowed picture URLs. Folkungagatan 61 is
 * position 1 when present; the rest follow sha256(seed:id) order. The same input always gives the same list, in
 * any input order. It carries no layout read and takes none: the judge works blind.
 */
export function worklistOf(
  snapshotRows: ReadonlyArray<{ candidate: { sourceListingUrl: string | null; imageUrls: readonly string[] | null } }>,
  seed: string = TRUTH_SEED,
): WorklistEntry[] {
  const byId = new Map<number, string[]>();
  for (const row of snapshotRows) {
    const booliId = booliIdOf(row.candidate);
    if (booliId === null || byId.has(booliId)) continue;
    const imageUrls = (row.candidate.imageUrls ?? []).filter((url) => isAllowedImageHost(url));
    if (imageUrls.length >= 2) byId.set(booliId, imageUrls);
  }
  const entries = [...byId].map(([booliId, imageUrls]) => ({ booliId, imageUrls }));
  const f61 = entries.filter((e) => e.booliId === F61_BOOLI_ID);
  const rest = sortSeeded(
    entries.filter((e) => e.booliId !== F61_BOOLI_ID),
    seed,
  );
  return [...f61, ...rest].map((e, i) => ({ position: i + 1, booliId: e.booliId, imageUrls: e.imageUrls }));
}

// -- selection, split, hash, lock ----------------------------------------------

const sideDecidedRow = (r: TruthRow): boolean => isSide(r.balconySide) || isSide(r.bedroomSide);
const windowsDecidedRow = (r: TruthRow): boolean => r.windowSides !== "undecidable";

/**
 * Which rows form the measured set. Rows whose pictures were unavailable are out. In priority order: Folkungagatan
 * 61; every row with a decided balcony or bedroom side (street or courtyard), in seeded order; then rows with
 * decided window sides, in seeded order; at most {@link TRUTH_SET_MAX_ROWS}. A row where nothing is decided stays
 * out. Returns every row of the file in its place with `inSet` set and `split` and `order` cleared. Pure.
 */
export function selectTruthSet(file: TruthFile, seed: string = file.seed): TruthRow[] {
  const unavailable = new Set(file.unavailable);
  const candidates = file.rows.filter((r) => !unavailable.has(r.booliId));
  const f61 = candidates.filter((r) => r.booliId === F61_BOOLI_ID);
  const rest = candidates.filter((r) => r.booliId !== F61_BOOLI_ID);
  const core = sortSeeded(rest.filter(sideDecidedRow), seed);
  const windowsOnly = sortSeeded(
    rest.filter((r) => !sideDecidedRow(r) && windowsDecidedRow(r)),
    seed,
  );
  const chosen = new Set([...f61, ...core, ...windowsOnly].slice(0, TRUTH_SET_MAX_ROWS).map((r) => r.booliId));
  return file.rows.map((r) => ({ ...r, inSet: chosen.has(r.booliId), split: null, order: null }));
}

/**
 * The 50/50 split and the read order of the set rows. Folkungagatan 61 is the holdout (nothing is tuned to the one
 * flat with a known truth). The other set rows are grouped into strata by (balcony side decided, bedroom side
 * decided, window sides truth) and alternate dev, holdout, dev, ... within each stratum in seeded order, so the
 * halves differ by at most one row per stratum. `order` is the seeded rank across the whole set (1-based), the
 * order the paid reads will run in. Rows outside the set get no split and no order. Pure.
 */
export function assignSplit(rows: readonly TruthRow[], seed: string): TruthRow[] {
  const inSet = rows.filter((r) => r.inSet);
  const splitOf = new Map<number, "dev" | "holdout">();
  const strata = new Map<string, TruthRow[]>();
  for (const r of inSet) {
    if (r.booliId === F61_BOOLI_ID) {
      splitOf.set(r.booliId, "holdout");
      continue;
    }
    const key = `${isSide(r.balconySide)}|${isSide(r.bedroomSide)}|${r.windowSides}`;
    strata.set(key, [...(strata.get(key) ?? []), r]);
  }
  for (const key of [...strata.keys()].sort()) {
    sortSeeded(strata.get(key) ?? [], seed).forEach((r, i) => splitOf.set(r.booliId, i % 2 === 0 ? "dev" : "holdout"));
  }
  const orderOf = new Map(sortSeeded(inSet, seed).map((r, i) => [r.booliId, i + 1] as const));
  return rows.map((r) =>
    r.inSet ? { ...r, split: splitOf.get(r.booliId) ?? null, order: orderOf.get(r.booliId) ?? null } : { ...r, split: null, order: null },
  );
}

/** JSON with object keys sorted at every level: the same data gives the same text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha16 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The first 16 hex characters of the sha256 of the canonical JSON of the rows (key order does not matter). */
export function rowsHashOf(rows: readonly TruthRow[]): string {
  return sha16(canonicalJson(rows));
}

/**
 * Locks a truth file: selects the set, assigns split and order, and writes the lock fields (time, seed, rows hash,
 * procedure hash, the selection rule and the triage counts over all judged rows). Throws on an already locked file
 * (T-14.5-06: a goalpost is not moved twice). Returns a new file; the input is not changed. Pure: the clock and the
 * procedure text come from the caller.
 */
export function lockTruthFile(file: TruthFile, opts: { seed: string; procedureText: string; now: string }): TruthFile {
  if (file.lockedAt !== null) throw new Error("Sanningsfilen är redan låst");
  const rows = assignSplit(selectTruthSet(file, opts.seed), opts.seed);
  const judged = rows.filter((r) => r.source === "judged");
  return {
    ...file,
    seed: opts.seed,
    lockedAt: opts.now,
    rows,
    rowsHash: rowsHashOf(rows),
    procedureHash: sha16(opts.procedureText),
    selectionRule: SELECTION_RULE,
    triage: {
      judged: judged.length,
      unavailable: file.unavailable.length,
      balconyDecided: judged.filter((r) => isSide(r.balconySide)).length,
      windowsDecided: judged.filter(windowsDecidedRow).length,
      bedroomDecided: judged.filter((r) => isSide(r.bedroomSide)).length,
      livingDecided: judged.filter((r) => r.livingOnBalconySide !== "undecidable").length,
    },
  };
}

/**
 * Checks a truth file and names the first rule it breaks. Always: row 1 is Folkungagatan 61 with source "known",
 * Booli ids are unique, split and order are set only on rows in the set. When locked: the rows hash matches the
 * rows, the procedure hash and selection rule are present, the set holds {@link TRUTH_SET_MIN_ROWS} to
 * {@link TRUTH_SET_MAX_ROWS} rows, every set row has a split and a unique order, Folkungagatan 61 is in the
 * holdout and both halves are non-empty. With `requireLocked` an unlocked file fails. Pure.
 */
export function validateTruthFile(file: TruthFile, opts: { requireLocked: boolean }): { ok: boolean; error: string | null } {
  const fail = (error: string) => ({ ok: false, error });
  const first = file.rows[0];
  if (first === undefined || first.booliId !== F61_BOOLI_ID || first.source !== "known") {
    return fail(`rad 1 måste vara Folkungagatan 61 (${F61_BOOLI_ID}) med källan known`);
  }
  const seen = new Set<number>();
  for (const r of file.rows) {
    if (seen.has(r.booliId)) return fail(`Booli-id ${r.booliId} förekommer flera gånger; id:n måste vara unika`);
    seen.add(r.booliId);
    if (!r.inSet && (r.split !== null || r.order !== null)) return fail(`rad för ${r.booliId} har split eller order men ingår inte i urvalet`);
  }
  if (file.lockedAt === null) return opts.requireLocked ? fail("sanningsfilen är olåst; kör --select-and-lock först") : { ok: true, error: null };

  if (file.rowsHash === null) return fail("låst fil saknar rowsHash");
  if (file.procedureHash === null) return fail("låst fil saknar procedureHash (proceduren)");
  if (file.selectionRule === null) return fail("låst fil saknar urvalsregeln");
  if (rowsHashOf(file.rows) !== file.rowsHash) return fail("raderna stämmer inte med rowsHash; filen har ändrats efter låsningen");
  const inSet = file.rows.filter((r) => r.inSet);
  if (inSet.length < TRUTH_SET_MIN_ROWS || inSet.length > TRUTH_SET_MAX_ROWS) {
    return fail(`urvalet har ${inSet.length} rader; ${TRUTH_SET_MIN_ROWS} till ${TRUTH_SET_MAX_ROWS} krävs`);
  }
  if (inSet.some((r) => r.split === null || r.order === null)) return fail("en rad i urvalet saknar split eller order");
  if (new Set(inSet.map((r) => r.order)).size !== inSet.length) return fail("order är inte unik i urvalet");
  if (!inSet.some((r) => r.booliId === F61_BOOLI_ID && r.split === "holdout")) return fail(`Folkungagatan 61 (${F61_BOOLI_ID}) måste ingå i urvalet och ligga i holdout`);
  if (!inSet.some((r) => r.split === "dev")) return fail("dev-halvan är tom");
  if (!inSet.some((r) => r.split === "holdout")) return fail("holdout-halvan är tom");
  return { ok: true, error: null };
}
