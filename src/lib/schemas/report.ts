import { z } from "zod/v4";

/**
 * The AI report contract (AI-SPEC §4b, verbatim). Shaped to make the critical
 * failure modes UNREPRESENTABLE:
 *  - there is NO `verdict`/`recommendation`/`betyg` field (D-04, FM2) — the
 *    report stays on the safe side of "ej finansiell rådgivning";
 *  - there is NO free-form flag the model can mint (D-03, FM3) — flags arrive
 *    pre-computed in the fact sheet and the model only references their ids;
 *  - every section field is `.nullable()` semantics via the explicit
 *    `ej_tillgänglig` status, never `.optional()`, so partial data (D-07)
 *    yields an explicit honest marker, not a silently-missing key (FM4).
 *
 * Mirrors the `brfExtractionSchema` mechanism in `src/lib/schemas/brf.ts`:
 * wrapped with `zodOutputFormat` and passed to `messages.parse`; the
 * `.describe()` text is emitted into the JSON schema handed to Claude.
 */

/** A single opinionated claim that MUST point back to a real datum (D-06). */
export const citedClaim = z.object({
  text: z
    .string()
    .describe("Påståendet, på svenska. Tolkning — inte upprepning av rådata."),
  sourceRef: z
    .string()
    .describe(
      "Vilken datapunkt påståendet bygger på, t.ex. 'brf.skuldPerKvm' eller 'flag:price_above_area'. MÅSTE finnas i faktaunderlaget.",
    ),
});

/** A single themed section (Ekonomi / Pris / Område). */
export const themedSection = z.object({
  // 'ej_tillgänglig' lets the model state a gap honestly instead of fabricating
  // (D-07/FM4).
  status: z.enum(["bedömd", "ej_tillgänglig"]),
  claims: z
    .array(citedClaim)
    .describe("Tolkningar för temat. Tom om ej_tillgänglig."),
});

export const reportSchema = z.object({
  // The cross-source thread no single card can state (D-05). 1–2 sentences.
  leadSynthesis: z
    .string()
    .describe(
      "Tvärgående syntes som kopplar ihop pris/BRF/område. Ej köp/sälj-råd (D-04).",
    ),
  ekonomi: themedSection,
  pris: themedSection,
  omrade: themedSection,
  // Flags the model chose to SURFACE/PRIORITIZE — by id only, from the fact
  // sheet. The model can reorder and contextualise; it can NEVER add an id not
  // present upstream.
  prioritizedFlagIds: z
    .array(z.string())
    .describe(
      "Id:n för flaggor som redan finns i faktaunderlaget, prioriterade. Hitta ALDRIG på nya.",
    ),
  // NO verdict / recommendation / buy-signal field — the line is
  // unrepresentable (D-04/FM2).
});

/** The Zod-validated report Claude returns. */
export type AiReport = z.infer<typeof reportSchema>;

/** A single themed-section payload, narrowed for downstream consumers. */
export type ThemedSection = z.infer<typeof themedSection>;

/** A single cited claim, narrowed for downstream consumers. */
export type CitedClaim = z.infer<typeof citedClaim>;

/**
 * The persisted `report_data` jsonb shape — validated on READ as well as write
 * (CR-01). `report_data` is a column the user's own RLS session can read, but
 * its integrity is never re-asserted by the DB. A stale row, schema drift, a
 * partially-written record, or a hand-edited row can therefore present a shape
 * that bypasses the write-path Zod gate. This schema is the read-path gate.
 *
 * The own-code fields (flags, soft-signal context, fingerprint, cost, model,
 * promptVersion) are validated loosely — they are produced by our own code, not
 * by Claude. The goal is to guarantee the fields the UI/PDF dereference exist
 * and are the right kind, mirroring `brfDataSchema`'s loose own-code validation
 * (brf.ts:135-157). Every field `.nullable()`, never `.optional()`.
 */
const persistedFlagSchema = z.object({
  id: z.string(),
  severity: z.enum(["red", "green", "neutral"]),
  sourceRef: z.string(),
  // `.nullish()` (= nullable + optional), NOT `.nullable()`: the write-side Flag
  // type (flags.ts) declares these three OPTIONAL, and the numeric BRF/price
  // flags omit them entirely. Persisted to JSONB, an omitted key is dropped, so
  // on read it is `undefined` — which `.nullable()` REJECTS ("expected string,
  // received undefined"), failing the whole safeParse → report_data reads back
  // null → the page shows the "Generera" trigger for a report that IS 'done'
  // (no error, no log). `.nullish()` accepts present-value, null, AND absent.
  sourceQuote: z.string().nullish(),
  pageRef: z.number().nullish(),
  confidence: z.number().nullish(),
});

export const reportDataSchema = z.object({
  /** The schema-validated synthesis output. */
  report: reportSchema,
  /** The deterministic flag set the synthesis narrated (by id). */
  flags: z.array(persistedFlagSchema),
  /**
   * The cited free-text soft signals carried into the report as narration
   * context (D-03). Validated loosely — the exact shape lives in the BRF
   * extraction schema; here we only guard the read path.
   */
  softSignals: z.record(z.string(), z.unknown()).nullable(),
  /** Hash of the inputs the report was generated from (drives D-08 staleness). */
  dataFingerprint: z.string().nullable(),
  /** Sonnet-rated cost of the synthesis call, SEK. */
  costSek: z.number().nullable(),
  /** The model id the report was generated with (trace, AI-SPEC §7). */
  model: z.string().nullable(),
  /** The synthesis prompt version (trace, AI-SPEC §7). */
  promptVersion: z.string().nullable(),
});

/** The persisted report snapshot, narrowed for downstream consumers. */
export type ReportData = z.infer<typeof reportDataSchema>;

/**
 * Defensive read-path guard for persisted `report_data` (CR-01). Returns the
 * validated payload on success, or `null` when the stored JSON is missing,
 * malformed, or shape-drifted — callers treat `null` as "not generated yet" and
 * degrade gracefully (re-generate affordance) instead of crashing the page.
 *
 * Mirrors `safeParseBrfData` (brf.ts:165-169) EXACTLY: null guard → safeParse →
 * success ? data : null. Never throws.
 */
export function safeParseReportData(
  input: unknown,
): z.infer<typeof reportDataSchema> | null {
  if (!input || typeof input !== "object") return null;
  const parsed = reportDataSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
