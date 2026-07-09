import { z } from "zod/v4";

/**
 * One reusable shape per extracted figure: value + confidence + citation.
 *
 * The `.describe()` text is emitted into the JSON schema handed to Claude and
 * steers extraction (AI-SPEC §4b.1). The `value` is always `.nullable()`,
 * NEVER `.optional()` — structured outputs force every key present, so a
 * missing figure must be expressed as an explicit `null` (AI-SPEC pitfall 3).
 *
 * Note: this shape carries numbers + provenance ONLY — no grade/score/rating.
 * Claude supplies figures; deterministic code grades them (D-08).
 *
 * @param value - the Zod schema for the underlying figure (e.g. `z.number()`)
 */
export const extractedField = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    value: value
      .nullable()
      .describe("Null if the figure is not present in the document"),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe("Model's confidence in this value, 0–1"),
    sourceQuote: z
      .string()
      .nullable()
      .describe("Verbatim text from the PDF this value came from"),
    pageRef: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe("1-based page number of the source quote"),
  });

/**
 * The Claude extraction contract: exactly four named figures, each shaped
 * `{ value, confidence, sourceQuote, pageRef }`.
 *
 * FM2 invariant (D-08): this schema contains NO grade/score/rating/betyg key.
 * The model returns figures + provenance; `computeBrfGrade` (pure TS) decides
 * the A–F grade. See `src/lib/brf/score.ts`.
 */
export const brfExtractionSchema = z.object({
  skuldPerKvm: extractedField(z.number()).describe(
    "Skuld per kvm bostadsrättsyta, SEK/m²",
  ),
  avgiftsniva: extractedField(z.number()).describe(
    "Årsavgift per kvm, SEK/m²/år",
  ),
  kassaflode: extractedField(z.number()).describe(
    "Kassaflöde från löpande verksamhet, SEK",
  ),
  underhallsplanStatus: extractedField(
    z.enum(["finns_aktuell", "finns_inaktuell", "saknas", "oklart"]),
  ).describe("Status för underhållsplan"),
  // Soft signals (D-02): each rides the SAME extractedField factory → gets
  // {value, confidence, sourceQuote, pageRef} for free, the same cited (D-11)
  // + confidence (D-10) trust pipeline as the four metrics. value stays
  // .nullable() (from extractedField), NEVER .optional().
  stambytePlanerat: extractedField(
    z.enum(["planerat", "nyligen_genomfort", "ej_nämnt"]),
  ).describe(
    "Planerat eller nyligen genomfört stambyte — citera årsredovisningen",
  ),
  storreRenoveringar: extractedField(z.string()).describe(
    "Planerade/genomförda större renoveringar (tak, fasad, hiss, fönster), ordagrant citat",
  ),
  ovrigaAnmarkningar: extractedField(z.string()).describe(
    "Övriga noterbara anmärkningar i förvaltningsberättelsen/revisionsberättelsen",
  ),
  // NO grade / score / rating field — code grades (D-08).
});

/** The stambyte soft-signal enum, narrowed for downstream consumers (nullable). */
export type StambyteStatus = BrfExtraction["stambytePlanerat"]["value"];

/** The Zod-validated extraction Claude returns (numbers + confidence + citation). */
export type BrfExtraction = z.infer<typeof brfExtractionSchema>;

/** The maintenance-plan status enum, narrowed for downstream consumers (nullable). */
export type UnderhallsplanStatus = BrfExtraction["underhallsplanStatus"]["value"];

/** The same enum with `null` excluded — usable as a `Record` key (scorer). */
export type UnderhallsplanValue = NonNullable<UnderhallsplanStatus>;

/**
 * A single extracted figure after normalization: the primitive value plus its
 * provenance. Confidence is clamped into [0, 1]; a null value carries
 * confidence 0 (a missing figure is not assessable — AI-SPEC §4b).
 */
export interface ExtractedField<T> {
  value: T | null;
  confidence: number;
  sourceQuote: string | null;
  pageRef: number | null;
}

/**
 * Normalized primitives the deterministic scorer consumes. Each field is the
 * flattened primitive value (or `null` when the figure was absent). This
 * mirrors `NormalizedListing` in `listing.ts` — null-tolerant by design.
 */
export interface NormalizedBrf {
  skuldPerKvm: number | null;
  avgiftsniva: number | null;
  kassaflode: number | null;
  underhallsplanStatus: UnderhallsplanStatus | null;
  // Soft signals (D-02): the enum feeds a deterministic flag (Plan 01); the two
  // free-text fields become narrated context for synthesis (Plan 03). Optional
  // on the type because the deterministic scorer (computeBrfGrade) consumes ONLY
  // the four metrics — `normalizeBrfExtraction` always populates these, so the
  // persist/read path carries them, while score fixtures that predate D-02 stay
  // valid (the scorer never reads them).
  stambytePlanerat?: StambyteStatus | null;
  storreRenoveringar?: string | null;
  ovrigaAnmarkningar?: string | null;
}

/**
 * The persisted `brf_data` JSONB shape — validated on READ as well as write.
 *
 * `brf_data` is a JSONB column the user's own RLS session can read, but its
 * integrity is never re-asserted by the DB. A stale row, schema drift, a
 * partially-written record, or a hand-edited row can therefore present a shape
 * that bypasses every Zod gate the write path enforces (CR-01). This schema is
 * the read-path gate: parse failure → treat the payload as "no analysis yet"
 * rather than dereferencing `undefined` and white-screening the score card.
 *
 * The grade/breakdown/confidence shapes are validated loosely (they are
 * produced by our own deterministic code, not by Claude) — the goal is to
 * guarantee the fields the UI dereferences exist and are the right kind, not to
 * re-derive the scoring contract.
 */
const metricRatingSchema = z.enum([
  "strong",
  "good",
  "mid",
  "weak",
  "not_assessable",
]);

const metricBreakdownSchema = z.object({
  key: z.enum([
    "skuldPerKvm",
    "avgiftsniva",
    "kassaflode",
    "underhallsplanStatus",
  ]),
  value: z.union([
    z.number(),
    z.enum(["finns_aktuell", "finns_inaktuell", "saknas", "oklart"]),
    z.null(),
  ]),
  rating: metricRatingSchema,
  weight: z.number(),
  contribution: z.number(),
});

export const brfDataSchema = z.object({
  extraction: brfExtractionSchema,
  normalized: z.object({
    skuldPerKvm: z.number().nullable(),
    avgiftsniva: z.number().nullable(),
    kassaflode: z.number().nullable(),
    underhallsplanStatus: z
      .enum(["finns_aktuell", "finns_inaktuell", "saknas", "oklart"])
      .nullable(),
    // Soft signals (D-02) carried through the persist/read path.
    stambytePlanerat: z
      .enum(["planerat", "nyligen_genomfort", "ej_nämnt"])
      .nullable(),
    storreRenoveringar: z.string().nullable(),
    ovrigaAnmarkningar: z.string().nullable(),
  }),
  grade: z.object({
    grade: z.enum(["A", "B", "C", "D", "E", "F"]),
    breakdown: z.array(metricBreakdownSchema),
  }),
  perFieldConfidence: z.record(z.string(), z.number()),
  citations: z.array(
    z.object({
      sourceQuote: z.string().nullable(),
      pageRef: z.number().nullable(),
    }),
  ),
  manualFields: z.array(z.string()).optional(),
  // ROADMAP Success Criterion 4 / ENRICH-02: additive-optional so rows
  // persisted before this field existed still parse (CR-01). Absent/undefined
  // on the manual-upload path (no auto-detected fiscal year).
  fiscalYear: z.number().nullable().optional(),
  isMostRecent: z.boolean().nullable().optional(),
});

/**
 * Defensive read-path guard for persisted `brf_data` (CR-01). Returns the
 * validated payload on success, or `null` when the stored JSON is missing,
 * malformed, or shape-drifted — callers treat `null` as "not analysed yet" and
 * degrade gracefully (re-analyse affordance) instead of crashing.
 */
export function safeParseBrfData(input: unknown): z.infer<typeof brfDataSchema> | null {
  if (!input || typeof input !== "object") return null;
  const parsed = brfDataSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/**
 * Flattens a parsed extraction into the primitive shape `computeBrfGrade`
 * consumes. Null-tolerant, mirroring `normalizeScraperOutput`: every field
 * falls back to `null` rather than throwing.
 *
 * The grade is computed from the primitive values only; confidence and
 * citations are carried separately into the UI/sanity layer.
 */
export function normalizeBrfExtraction(parsed: BrfExtraction): NormalizedBrf {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;

  return {
    skuldPerKvm: num(parsed.skuldPerKvm.value),
    avgiftsniva: num(parsed.avgiftsniva.value),
    kassaflode: num(parsed.kassaflode.value),
    underhallsplanStatus: str(
      parsed.underhallsplanStatus.value,
    ) as UnderhallsplanStatus | null,
    // Soft signals (D-02): null-tolerant, mirroring the metrics above.
    stambytePlanerat: str(
      parsed.stambytePlanerat.value,
    ) as StambyteStatus | null,
    storreRenoveringar: str(parsed.storreRenoveringar.value),
    ovrigaAnmarkningar: str(parsed.ovrigaAnmarkningar.value),
  };
}
