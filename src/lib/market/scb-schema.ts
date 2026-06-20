import { z } from "zod/v4";

/**
 * SCB PxWebApi (json-stat2) schemas + null-tolerant normalizer for the AREA-01
 * four demographics metrics (D-07), plus the persisted `area_data` shape and its
 * defensive read-path guard (D-08/D-09, mirrors safeParseBrfData in brf.ts).
 *
 * Design rule (RESEARCH Pattern 3, Pitfall 3, T-03-07): SCB responses cross an
 * untrusted boundary. The schema is permissive (`.passthrough()`, every field
 * optional) and `normalizeScbOutput` NEVER throws — a malformed or partial
 * payload, or an absent metric, surfaces as `null` rather than crashing the
 * area panel ("kommun-correct beats neighborhood-wrong", D-06).
 */

// --- json-stat2 response (permissive) --------------------------------------

// A json-stat2 dimension: a category with index (code → position) and labels.
const jsonStatDimensionSchema = z
  .object({
    label: z.string().optional(),
    category: z
      .object({
        index: z.record(z.string(), z.number()).optional(),
        label: z.record(z.string(), z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// The json-stat2 dataset envelope. All fields optional so a malformed/empty
// payload still parses (→ every metric normalizes to null).
export const jsonStat2Schema = z
  .object({
    class: z.string().optional(),
    id: z.array(z.string()).optional(),
    size: z.array(z.number()).optional(),
    dimension: z.record(z.string(), jsonStatDimensionSchema).optional(),
    value: z.array(z.number().nullable()).optional(),
  })
  .passthrough();

export type JsonStat2 = z.infer<typeof jsonStat2Schema>;

// --- normalized four-metric shape ------------------------------------------

// Age distribution: code (e.g. "0-19") → total persons across sexes.
export type AgeDistribution = Record<string, number>;

// Tenure / upplåtelseform mix: category (äganderätt | bostadsrätt | hyresrätt …)
// → persons. Kept as a code-keyed map for partial-data tolerance.
export type TenureMix = Record<string, number>;

export interface NormalizedScb {
  /** Total population at the queried region (sum over age × sex), or null. */
  population: number | null;
  /** Age-band → persons, or null when the Alder dimension is absent. */
  age: AgeDistribution | null;
  /** Median/mean disposable income (SEK), or null when the income table is absent. */
  income: number | null;
  /** Tenure-form → persons, or null when the tenure table is absent. */
  tenure: TenureMix | null;
}

// Null-tolerant primitive coercion (mirrors normalizeScraperOutput, listing.ts).
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Find a dimension id whose key matches one of `candidates` (case-insensitive),
 * returning the matched id or null. SCB names dimensions "Region", "Alder",
 * "Kon", "ContentsCode", "Tid", "Upplatelseform", etc.
 */
function findDimId(stat: JsonStat2, candidates: string[]): string | null {
  if (!stat.id) return null;
  const lc = candidates.map((c) => c.toLowerCase());
  for (const id of stat.id) {
    if (lc.includes(id.toLowerCase())) return id;
  }
  return null;
}

/** Ordered category codes for a dimension (by its index map position). */
function categoryCodes(stat: JsonStat2, dimId: string): string[] {
  const idx = stat.dimension?.[dimId]?.category?.index;
  if (!idx) return [];
  return Object.entries(idx)
    .sort((a, b) => a[1] - b[1])
    .map(([code]) => code);
}

/**
 * Normalize a json-stat2 payload into the four-metric shape. Detects which
 * metric the payload carries (population/age via Alder, tenure via an
 * upplåtelseform dimension, income via a contents code) and sums the value
 * array along the relevant axes. Every metric independently falls back to null;
 * never throws (D-06/D-08, T-03-07).
 */
export function normalizeScbOutput(raw: unknown): NormalizedScb {
  const result: NormalizedScb = {
    population: null,
    age: null,
    income: null,
    tenure: null,
  };

  const parsed = jsonStat2Schema.safeParse(raw);
  if (!parsed.success) return result;
  const stat = parsed.data;

  const size = stat.size;
  const values = stat.value;
  const ids = stat.id;
  if (!size || !values || !ids || size.length !== ids.length) {
    return result;
  }

  const ageDim = findDimId(stat, ["Alder", "Ålder", "age"]);
  const tenureDim = findDimId(stat, [
    "Upplatelseform",
    "Upplåtelseform",
    "tenure",
  ]);

  // --- population (sum of all values) + age distribution ---
  // A population/age table carries an Alder dimension. We sum the whole value
  // array for total population (over age × sex), and group by age band.
  if (ageDim) {
    const ageIdx = ids.indexOf(ageDim);
    const ageCodes = categoryCodes(stat, ageDim);

    let total = 0;
    let sawAny = false;
    const ageMap: AgeDistribution = {};

    // Iterate every cell of the value array via mixed-radix coordinates.
    const totalCells = size.reduce((a, b) => a * b, 1);
    for (let flat = 0; flat < totalCells; flat++) {
      const v = num(values[flat]);
      if (v === null) continue;
      sawAny = true;
      total += v;
      // Recover the age coordinate for this flat index.
      let rem = flat;
      const coord: number[] = new Array(size.length);
      for (let d = size.length - 1; d >= 0; d--) {
        coord[d] = rem % size[d];
        rem = Math.floor(rem / size[d]);
      }
      const ageCode = ageCodes[coord[ageIdx]];
      if (ageCode !== undefined) {
        ageMap[ageCode] = (ageMap[ageCode] ?? 0) + v;
      }
    }

    if (sawAny) {
      result.population = total;
      result.age = Object.keys(ageMap).length > 0 ? ageMap : null;
    }
  }

  // --- tenure / upplåtelseform mix ---
  if (tenureDim) {
    const tenureIdx = ids.indexOf(tenureDim);
    const tenureCodes = categoryCodes(stat, tenureDim);
    const tenureMap: TenureMix = {};
    let sawAny = false;

    const totalCells = size.reduce((a, b) => a * b, 1);
    for (let flat = 0; flat < totalCells; flat++) {
      const v = num(values[flat]);
      if (v === null) continue;
      let rem = flat;
      const coord: number[] = new Array(size.length);
      for (let d = size.length - 1; d >= 0; d--) {
        coord[d] = rem % size[d];
        rem = Math.floor(rem / size[d]);
      }
      const code = tenureCodes[coord[tenureIdx]];
      if (code !== undefined) {
        tenureMap[code] = (tenureMap[code] ?? 0) + v;
        sawAny = true;
      }
    }
    if (sawAny) result.tenure = tenureMap;
  }

  // --- income ---
  // An income table has neither an age nor a tenure dimension; its value array
  // is the income figure(s). We take the first finite value as the headline
  // income. Absent income table → income stays null (the population fixture
  // exercises this: no income dimension present, so income → null).
  if (!ageDim && !tenureDim) {
    const incomeContents = findDimId(stat, ["ContentsCode"]);
    if (incomeContents) {
      const first = values.find((v) => num(v) !== null);
      result.income = num(first);
    }
  }

  return result;
}

// --- persisted area_data shape + read guard --------------------------------

/**
 * The persisted `area_data` jsonb shape — the DURABLE cache of record (Plan 05
 * writes it once; the page reads it without re-calling SCB). Carries the four
 * metrics + the achieved geo level + source/freshness labels (D-09) and a
 * `fetchedAt` + per-metric year so Plan 05 can treat the row as the cache.
 */
export const areaDataSchema = z.object({
  geo: z.object({
    kommunCode: z.string().nullable(),
    desoCode: z.string().nullable(),
    // The precision actually achieved for this row (D-06).
    level: z.enum(["deso", "kommun"]),
  }),
  metrics: z.object({
    population: z.number().nullable(),
    age: z.record(z.string(), z.number()).nullable(),
    income: z.number().nullable(),
    tenure: z.record(z.string(), z.number()).nullable(),
  }),
  // Per-metric latest year (income lags population/tenure — 03-SPIKE §3).
  years: z.object({
    population: z.string().nullable(),
    income: z.string().nullable(),
    tenure: z.string().nullable(),
  }),
  source: z.string(), // e.g. "SCB PxWebApi"
  fetchedAt: z.string(), // ISO timestamp — freshness key for the cache
});

export type AreaData = z.infer<typeof areaDataSchema>;

/**
 * Defensive read-path guard for persisted `area_data` (mirrors safeParseBrfData,
 * brf.ts:165-169). Malformed / shape-drifted stored JSON → null, so the page
 * degrades (re-enrich affordance) instead of crashing (Success Criterion 3).
 */
export function safeParseAreaData(input: unknown): AreaData | null {
  if (!input || typeof input !== "object") return null;
  const parsed = areaDataSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
