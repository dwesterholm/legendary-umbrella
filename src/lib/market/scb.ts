import {
  normalizeScbOutput,
  jsonStat2Schema,
  type AreaData,
  type NormalizedScb,
  type JsonStat2,
} from "@/lib/market/scb-schema";
import type { ResolvedGeo } from "@/lib/market/geo";

/**
 * SCB PxWebApi client for the AREA-01 four demographics metrics (D-07).
 *
 * SCB's PxWebApi is FREE and requires NO API key / NO auth header (03-SPIKE §3,
 * reconfirmed). All requests are server-side native `fetch` (Node 22). The
 * query body is built SERVER-SIDE from validated, lat/lng-derived region codes
 * + a whitelist of table ids — user free-text is NEVER interpolated into the
 * URL or body (T-03-06 SSRF mitigation, RESEARCH Security).
 *
 * CACHING (T-03-08): module-level memory is illusory on serverless cold starts,
 * so it is NOT the correctness mechanism. The DURABLE cache of record is the
 * persisted `area_data` column (Plan 05 writes it once; the page reads it
 * without re-calling SCB; a re-enrich is the only path that re-hits SCB). A
 * small fixed number of table calls per enrich respects the 30 calls/10s budget
 * (Pitfall 4). SCB is free → no monetary cost.
 *
 * `normalizeScbOutput` / `safeParseAreaData` / `areaDataSchema` are re-exported
 * from scb-schema.ts so callers (and scb.test.ts) import them from `@/lib/market/scb`.
 */
export {
  normalizeScbOutput,
  safeParseAreaData,
  areaDataSchema,
  type AreaData,
  type NormalizedScb,
} from "@/lib/market/scb-schema";

const SCB_BASE = "https://api.scb.se/OV0104/v1/doris/en/ssd";

// Whitelisted SCB tables (03-SPIKE §3 — all DeSO-available, each at its own
// latest year). Region codes are validated against the table's value list
// before querying (Pitfall 2); we never send arbitrary region strings.
const SCB_TABLES = {
  // Population + age + sex by DeSO. Latest year 2025 (verified live).
  // contentsCode "000007Y7" = "Number" (verified live against the table's value
  // list — the old "BE0101N1" is not a member of this table and yielded HTTP 400).
  population: {
    path: "BE/BE0101/BE0101Y/FolkmDesoAldKon",
    contentsCode: "000007Y7",
    year: "2025",
  },
  // Disposable income by DeSO/RegSO. Latest year 2024 (income LAGS one year).
  // The table is MANDATORY in InkomstTyp + Kon + ContentsCode — omitting them
  // yielded HTTP 400. We query net income (NeInk), both sexes (1+2) and the
  // headline "Median value, SEK thousands" content code "0000089U" (verified live).
  income: {
    path: "HE/HE0110/HE0110I/Tab1InkDesoRegso",
    incomeType: "NeInk",
    contentsCode: "0000089U",
    year: "2024",
  },
  // Tenure / upplåtelseform by DeSO. Latest year 2025.
  tenure: {
    path: "HE/HE0111/HE0111YDeSo/HushallT33Deso",
    year: "2025",
  },
} as const;

// The SCB BE0101 5-year age bands (excludes the "totalt" aggregate so the
// normalizer's sum-of-all-cells is the real population, not double-counted, and
// the age map carries real bands). Stable SCB coding (verified live).
const POPULATION_AGE_BANDS: readonly string[] = [
  "-4",
  "5-9",
  "10-14",
  "15-19",
  "20-24",
  "25-29",
  "30-34",
  "35-39",
  "40-44",
  "45-49",
  "50-54",
  "55-59",
  "60-64",
  "65-69",
  "70-74",
  "75-79",
  "80-",
] as const;

/**
 * The DeSO GEOGRAPHY vintage encoded in the SSD region value suffix, e.g.
 * "0180C3130_DeSO2025". This is the boundary set's vintage — it is DECOUPLED from
 * a table's data `Tid` year. All three whitelisted tables key region by the 2025
 * DeSO boundaries (verified live: income's `Tid` is 2024 but its region value is
 * still `..._DeSO2025`). The bundled artifact is the SCB DeSO_2025 set, so this
 * matches the codes resolveGeo emits. Coupling the suffix to the data year (the
 * old bug) produced `_DeSO2024` for income → HTTP 400 → income silently null.
 */
const DESO_VINTAGE = "2025";

/**
 * Build the exact SSD region string for a DeSO code (03-SPIKE §3, RESEARCH
 * Pitfall 2): the validated DeSO code + the geography vintage suffix. The DeSO
 * code itself is validated upstream (resolveGeo only emits codes present in the
 * bundled SCB DeSO_2025 set).
 */
function desoRegionValue(desoCode: string): string {
  return `${desoCode}_DeSO${DESO_VINTAGE}`;
}

/**
 * Validate that a resolved region code is well-formed before it is ever placed
 * into a query body (defence-in-depth against T-03-06). DeSO = 9 chars
 * `{4-digit kommun}{letter}{4-digit}`; kommun = 4 digits.
 */
function isValidRegionCode(code: string): boolean {
  return /^\d{4}[A-Z]\d{4}$/.test(code) || /^\d{4}$/.test(code);
}

interface ScbQueryBody {
  query: Array<{
    code: string;
    selection: { filter: string; values: string[] };
  }>;
  response: { format: "json-stat2" };
}

/**
 * POST a parameterized json-stat2 query for a single table. The body is
 * assembled entirely from constants + the validated region code — no user
 * free-text reaches the URL or body. Returns the parsed json-stat2 payload, or
 * null on any failure (the metric then normalizes to null — never crashes).
 */
async function fetchScbTable(
  tablePath: string,
  body: ScbQueryBody,
): Promise<JsonStat2 | null> {
  try {
    const res = await fetch(`${SCB_BASE}/${tablePath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error("[scb]", `table ${tablePath} → HTTP ${res.status}`);
      return null;
    }
    const json: unknown = await res.json();
    const parsed = jsonStat2Schema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch (error) {
    console.error("[scb]", error);
    return null;
  }
}

/**
 * Fetch the four AREA-01 demographics metrics for a resolved geography.
 *
 * Queries population/age, income, and tenure at the DeSO level when a DeSO code
 * is available (03-SPIKE §3 confirmed all three DeSO-available), each at its own
 * latest year. With no DeSO code (point fell outside all polygons) the geo
 * degrades to kommun-level (D-06) and metrics are returned null — the caller
 * renders the kommun-baseline label rather than crashing.
 *
 * Returns a fully-formed `AreaData` (the persisted-cache shape) so Plan 05 can
 * write it straight to the `area_data` column. On any per-table failure the
 * affected metric is null (D-08); the panel degrades, never throws.
 */
export async function fetchScbDemographics(
  geo: ResolvedGeo,
): Promise<AreaData> {
  const fetchedAt = new Date().toISOString();
  const level: "deso" | "kommun" = geo.desoCode ? "deso" : "kommun";

  const base: AreaData = {
    geo: {
      kommunCode: geo.kommunCode,
      desoCode: geo.desoCode,
      level,
    },
    metrics: { population: null, age: null, income: null, tenure: null },
    years: { population: null, income: null, tenure: null },
    source: "SCB PxWebApi",
    fetchedAt,
  };

  // Without a validated DeSO code there is no SCB region to query at the DeSO
  // tables — return the kommun-baseline AreaData (metrics null). DeSO is the
  // only level the spike confirmed for these tables.
  if (!geo.desoCode || !isValidRegionCode(geo.desoCode)) {
    return base;
  }

  const deso = geo.desoCode;

  // Build each query body server-side from validated constants + region code.
  const popBody: ScbQueryBody = {
    query: [
      {
        code: "Region",
        selection: {
          filter: "item",
          values: [desoRegionValue(deso)],
        },
      },
      // Alder + Kon are MANDATORY for this table; omitting them → HTTP 400. Select
      // every 5-year band (NOT the "totalt" aggregate) + both sexes total so the
      // normalizer sums real bands into population and keeps an age distribution.
      {
        code: "Alder",
        selection: { filter: "item", values: [...POPULATION_AGE_BANDS] },
      },
      {
        code: "Kon",
        selection: { filter: "item", values: ["1+2"] },
      },
      {
        code: "ContentsCode",
        selection: {
          filter: "item",
          values: [SCB_TABLES.population.contentsCode],
        },
      },
      {
        code: "Tid",
        selection: { filter: "item", values: [SCB_TABLES.population.year] },
      },
    ],
    response: { format: "json-stat2" },
  };

  const incomeBody: ScbQueryBody = {
    query: [
      {
        code: "Region",
        selection: {
          filter: "item",
          values: [desoRegionValue(deso)],
        },
      },
      // InkomstTyp + Kon + ContentsCode are MANDATORY; omitting them → HTTP 400.
      {
        code: "InkomstTyp",
        selection: { filter: "item", values: [SCB_TABLES.income.incomeType] },
      },
      {
        code: "Kon",
        selection: { filter: "item", values: ["1+2"] },
      },
      {
        code: "ContentsCode",
        selection: {
          filter: "item",
          values: [SCB_TABLES.income.contentsCode],
        },
      },
      {
        code: "Tid",
        selection: { filter: "item", values: [SCB_TABLES.income.year] },
      },
    ],
    response: { format: "json-stat2" },
  };

  const tenureBody: ScbQueryBody = {
    query: [
      {
        code: "Region",
        selection: {
          filter: "item",
          values: [desoRegionValue(deso)],
        },
      },
      {
        code: "Tid",
        selection: { filter: "item", values: [SCB_TABLES.tenure.year] },
      },
    ],
    response: { format: "json-stat2" },
  };

  // A small fixed number of table calls (3) per enrich → well inside 30/10s.
  const [popRaw, incomeRaw, tenureRaw] = await Promise.all([
    fetchScbTable(SCB_TABLES.population.path, popBody),
    fetchScbTable(SCB_TABLES.income.path, incomeBody),
    fetchScbTable(SCB_TABLES.tenure.path, tenureBody),
  ]);

  const pop: NormalizedScb | null = popRaw
    ? normalizeScbOutput(popRaw)
    : null;
  const income: NormalizedScb | null = incomeRaw
    ? normalizeScbOutput(incomeRaw)
    : null;
  const tenure: NormalizedScb | null = tenureRaw
    ? normalizeScbOutput(tenureRaw)
    : null;

  return {
    ...base,
    metrics: {
      population: pop?.population ?? null,
      age: pop?.age ?? null,
      income: income?.income ?? null,
      tenure: tenure?.tenure ?? null,
    },
    years: {
      population: pop?.population != null ? SCB_TABLES.population.year : null,
      income: income?.income != null ? SCB_TABLES.income.year : null,
      tenure: tenure?.tenure != null ? SCB_TABLES.tenure.year : null,
    },
  };
}
