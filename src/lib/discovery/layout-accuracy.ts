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
 *  - later in this module (plan 02 tasks 2-3): the confidence curve, the gate read off it, Wilson intervals,
 *    the precision of the money-moving answers, the field and variant verdicts, and the truth-set tools
 *    (worklist, select-and-lock, validation).
 *
 * Pure: no clock, no randomness (seeded hashing only), no file system, no network, no SDK. Reads arrive as a
 * `Map<booliId, LayoutFact>` so the module does not care whether they come from the production cache, an
 * experiment cache or a snapshot.
 *
 * STRUCTURAL SEPARATION (LOCKED): `niche-score.ts` and `report/flags.ts` must never import it (the
 * "discovery/layout-" specifier in niche-score.test.ts enforces that).
 */
import { z } from "zod/v4";
import type { LayoutFact } from "@/lib/discovery/layout-fact";

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
// The report (grows in plan 02 task 2)
// ---------------------------------------------------------------------------

export interface AccuracyReport {
  /** Where the reads came from: "production" for the stored cache, a variant name for an experiment. */
  source: string;
  /** The read version (prompt + model + schema + logic hash) the reads carry. */
  version: string;
  /** Rows in the set. */
  rows: number;
  raw: Pick<RawFieldScores, "balcony" | "korsdrag" | "bedroom">;
  noRead: number;
}

/** Counts only: never a per-flat read (blind judging depends on it). */
export function accuracyReport(
  file: TruthFile,
  reads: ReadonlyMap<number, LayoutFact>,
  meta: { source: string; version: string },
): AccuracyReport {
  const scores = rawFieldScores(file.rows, reads);
  return {
    source: meta.source,
    version: meta.version,
    rows: file.rows.filter((r) => r.inSet).length,
    raw: { balcony: scores.balcony, korsdrag: scores.korsdrag, bedroom: scores.bedroom },
    noRead: scores.noRead,
  };
}
