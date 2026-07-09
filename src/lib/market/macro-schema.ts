import { z } from "zod/v4";
import { jsonStat2Schema, type JsonStat2 } from "@/lib/market/scb-schema";

/**
 * Zod schemas + null-tolerant normalizers for the MACRO-01/MACRO-02 macro
 * price-context indicators (Riksbank policy rate, SCB CPIF inflation, SCB
 * regional/län tenant-owned-flat price), plus the persisted `macro_data`
 * shape and its defensive read-path guard (mirrors safeParseAreaData in
 * scb-schema.ts).
 *
 * Design rule (RESEARCH Pattern 3, Pitfall 3, T-07-03): both Riksbank and SCB
 * responses cross an untrusted boundary. Every normalizer `safeParse`s first,
 * every field independently degrades to `null` on a missing/malformed
 * payload, and none of them EVER throws — a dead source surfaces as
 * "ej tillgänglig" for that ONE indicator, never crashes the macro branch
 * (mirrors normalizeScbOutput's "kommun-correct beats neighborhood-wrong"
 * discipline, D-06/D-08, extended here to macro's three-way independence).
 *
 * CRITICAL (MACRO-02): `macroDataSchema` has NO field capable of representing
 * direction/trend/magnitude/forecast — see the trailing comment on the
 * schema below. This is the primary no-prediction enforcement layer,
 * mirroring `reportSchema`'s "NO verdict field can exist" comment
 * (src/lib/schemas/report.ts).
 */

// --- Riksbank flat {date, value} shape (NOT json-stat2) --------------------

const riksbankObservationSchema = z
  .object({
    date: z.string().optional(),
    value: z.number().optional(),
  })
  .passthrough();

// Null-tolerant primitive coercion (mirrors num() in scb-schema.ts).
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export interface NormalizedPolicyRate {
  value: number | null;
  date: string | null;
}

/**
 * Normalize a Riksbank `Observations/Latest/{series}` response into
 * `{ value, date }`. Never throws — malformed/empty input → all-null.
 */
export function normalizePolicyRate(raw: unknown): NormalizedPolicyRate {
  const result: NormalizedPolicyRate = { value: null, date: null };
  const parsed = riksbankObservationSchema.safeParse(raw);
  if (!parsed.success) return result;
  result.value = num(parsed.data.value);
  result.date =
    typeof parsed.data.date === "string" && parsed.data.date.length > 0
      ? parsed.data.date
      : null;
  return result;
}

// --- SCB json-stat2 helpers (mirrors scb-schema.ts's dimension walking) ----

/** Ordered category codes for a dimension (by its index map position). */
function categoryCodes(stat: JsonStat2, dimId: string): string[] {
  const idx = stat.dimension?.[dimId]?.category?.index;
  if (!idx) return [];
  return Object.entries(idx)
    .sort((a, b) => a[1] - b[1])
    .map(([code]) => code);
}

function findDimId(stat: JsonStat2, candidates: string[]): string | null {
  if (!stat.id) return null;
  const lc = candidates.map((c) => c.toLowerCase());
  for (const id of stat.id) {
    if (lc.includes(id.toLowerCase())) return id;
  }
  return null;
}

/**
 * Walk BACKWARD from the end of a json-stat2 `value` array to find the last
 * NON-null cell (CR-02). SCB pads a not-yet-published period with `null` at
 * its positionally-aligned index — naively taking `values[values.length-1]`
 * bails on the whole indicator exactly when the latest queried period is
 * mid-publication, discarding a perfectly good prior-period value. Returns
 * both the value and its index so the caller can look up the matching
 * period/year label at the SAME index (not just "the last label").
 */
function lastNonNull(
  values: readonly unknown[],
): { value: number; index: number } | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = num(values[i]);
    if (v !== null) return { value: v, index: i };
  }
  return null;
}

// --- CPIF inflation ----------------------------------------------------------

export interface NormalizedInflation {
  value: number | null;
  period: string | null;
}

/**
 * Normalize a CPIF (`PR0101G/KPIF2020`) json-stat2 response into
 * `{ value, period }` — the latest queried period's annual-change %.
 * Never throws — malformed/absent value → all-null (RESEARCH Pitfall 3:
 * CPIF, not plain CPI, is the headline inflation figure).
 */
export function normalizeInflation(raw: unknown): NormalizedInflation {
  const result: NormalizedInflation = { value: null, period: null };
  const parsed = jsonStat2Schema.safeParse(raw);
  if (!parsed.success) return result;
  const stat = parsed.data;

  const values = stat.value;
  if (!values || values.length === 0) return result;

  const found = lastNonNull(values);
  if (!found) return result;

  const timeDim = findDimId(stat, ["Tid"]);
  const periods = timeDim ? categoryCodes(stat, timeDim) : [];
  const period = periods[found.index] ?? null;

  result.value = found.value;
  result.period = period;
  return result;
}

// --- Regional (län) tenant-owned-flat price --------------------------------

export interface NormalizedRegionalPrice {
  value: number | null;
  year: string | null;
  preliminary: boolean | null;
}

const PRELIMINARY_NOTE_PATTERN = /preliminary/i;

/**
 * Normalize a `BO0501C/FastprisBRFRegionAr` json-stat2 response into
 * `{ value, year, preliminary }` — the latest queried year's median price
 * (SEK thousands) plus a `preliminary` flag derived from SCB's own `note`
 * array (RESEARCH Pitfall 5: "Most recent year's figures are preliminary").
 * Never throws — malformed/absent value → all-null.
 */
export function normalizeRegionalPrice(
  raw: unknown,
): NormalizedRegionalPrice {
  const result: NormalizedRegionalPrice = {
    value: null,
    year: null,
    preliminary: null,
  };
  const parsed = jsonStat2Schema.safeParse(raw);
  if (!parsed.success) return result;
  const stat = parsed.data;

  const values = stat.value;
  if (!values || values.length === 0) return result;

  const found = lastNonNull(values);
  if (!found) return result;
  const value = found.value;

  const timeDim = findDimId(stat, ["Tid"]);
  const years = timeDim ? categoryCodes(stat, timeDim) : [];
  const year = years[found.index] ?? null;

  // WR-04: read `note` off the safeParsed `stat`, not the unvalidated `raw`
  // arg — `jsonStat2Schema` is `.passthrough()` so `stat.note` carries the
  // identical value, but going through `stat` keeps this function inside the
  // schema boundary the rest of the file enforces.
  const notes = (stat as { note?: unknown }).note;
  // The preliminary flag only applies when the value actually resolved is the
  // LATEST period (found.index is the last index) — a fallback to an older,
  // already-final period (CR-02) must not inherit the "preliminary" caveat
  // meant for the not-yet-published latest period.
  //
  // WR-05 (shard-3 review): this is deliberately a COARSE, table-level caveat
  // gated on latest-period resolution, NOT a per-period guarantee. SCB's actual
  // note phrasing is period-relative ("Most recent year's figures are
  // preliminary"), so it carries no literal year to correlate against — trying
  // to require the resolved `year` string to appear in the note (as one might
  // for a positionally-bound note) would UNDER-flag genuinely-preliminary data
  // whose note never names the year. The latest-period gate is the correct
  // match for SCB's "most recent year" phrasing; over-flagging a final figure
  // is only reachable via a hypothetical note that names a non-latest period,
  // which SCB does not emit for these series.
  const isLatestPeriod = found.index === values.length - 1;
  const preliminary =
    isLatestPeriod &&
    Array.isArray(notes) &&
    notes.some(
      (n) => typeof n === "string" && PRELIMINARY_NOTE_PATTERN.test(n),
    );

  result.value = value;
  result.year = year;
  result.preliminary = preliminary;
  return result;
}

// --- persisted macro_data shape + read guard -------------------------------

/**
 * The persisted `macro_data` jsonb shape — the durable per-indicator figures
 * written by the read-through cache (macro.ts) and consumed by the fact
 * sheet / macro card (Plans 02/03). Each indicator is independently
 * nullable so one source's failure never blanks the other two (D-08
 * extended to macro's three-way independence).
 *
 * CRITICAL (MACRO-02): this schema has NO `trend`/`direction`/`magnitude`/
 * `forecast`/`outlook`/`deltaPct`/month-over-month field anywhere in its
 * shape — the schema shape is the PRIMARY no-prediction enforcement point,
 * mirroring reportSchema's "NO verdict field can exist" comment
 * (src/lib/schemas/report.ts). Only the latest value + its reference
 * period/year + source are representable; a comparison-derived directional
 * claim is structurally impossible to persist through this type.
 */
export const macroDataSchema = z.object({
  policyRate: z
    .object({
      value: z.number().nullable(),
      date: z.string().nullable(),
      source: z.string(),
    })
    .nullable(),
  inflation: z
    .object({
      value: z.number().nullable(),
      period: z.string().nullable(),
      source: z.string(),
      measure: z.literal("KPIF"),
    })
    .nullable(),
  regionalPrice: z
    .object({
      value: z.number().nullable(),
      year: z.string().nullable(),
      preliminary: z.boolean().nullable(),
      regionCode: z.string().nullable(),
      source: z.string(),
    })
    .nullable(),
});
// NO direction/trend/magnitude/forecast field — the schema shape is the
// primary no-prediction enforcement point (MACRO-02).

export type MacroData = z.infer<typeof macroDataSchema>;

// --- per-scope cache-row schemas (CR-01) -----------------------------------

/**
 * The NATIONAL `macro_snapshots` cache-row payload shape (policy rate +
 * CPIF only — WR-01 split). Re-exported so macro.ts's read-through cache can
 * structurally validate a cached row on every read (CR-01) rather than
 * trusting a bare type assertion, which would let a poisoned/garbage shared
 * cache row (any authenticated user can currently write arbitrary JSON here
 * — see migration 006/008) flow straight into the fact-sheet and UI.
 */
export const nationalMacroPayloadSchema = macroDataSchema.pick({
  policyRate: true,
  inflation: true,
});
export type NationalMacroPayload = z.infer<typeof nationalMacroPayloadSchema>;

/**
 * The REGIONAL `macro_snapshots` cache-row payload shape (regional price
 * only — WR-01 split). See `nationalMacroPayloadSchema` doc comment (CR-01).
 */
export const regionalMacroPayloadSchema = macroDataSchema.pick({
  regionalPrice: true,
});
export type RegionalMacroPayload = z.infer<typeof regionalMacroPayloadSchema>;

/**
 * Defensive read-path guard for persisted `macro_data` (mirrors
 * safeParseAreaData, scb-schema.ts). Malformed / shape-drifted stored JSON
 * → null, so callers degrade (re-fetch affordance) instead of crashing.
 */
export function safeParseMacroData(input: unknown): MacroData | null {
  if (!input || typeof input !== "object") return null;
  const parsed = macroDataSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
