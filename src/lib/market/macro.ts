import { type ZodType } from "zod/v4";
import {
  normalizePolicyRate,
  normalizeInflation,
  normalizeRegionalPrice,
  nationalMacroPayloadSchema,
  regionalMacroPayloadSchema,
  type MacroData,
  type NationalMacroPayload,
  type RegionalMacroPayload,
} from "@/lib/market/macro-schema";

/**
 * Riksbank SWEA + SCB PxWebApi client for the MACRO-01 macro price-context
 * indicators (policy rate, CPIF inflation, län-level regional BRF price).
 *
 * Both APIs are FREE and require NO API key / NO auth header (RESEARCH,
 * verified live 2026-07-06). All requests are server-side native `fetch`
 * (Node 22). Query bodies are built SERVER-SIDE from validated,
 * geo-derived region codes + a whitelist of table ids — user free-text is
 * NEVER interpolated into the URL or body (T-07-02 SSRF mitigation, mirrors
 * T-03-06 in scb.ts).
 *
 * CACHING (RESEARCH Pattern 2 — genuinely NEW for this codebase, unlike
 * scb.ts): scb.ts's own doc comment states module memory is illusory on
 * serverless cold starts, so its durable cache-of-record is a PERSISTED
 * PER-ANALYSIS COLUMN (`area_data`) — one fetch per analysis. macro.ts is
 * different: its indicators are identical for every analysis resolving to
 * the same (scope, region_code) within a TTL window, so it uses a REAL
 * DURABLE SHARED TABLE (`macro_snapshots`) as a genuine read-through cache
 * across ALL analyses/users, not a per-row cache. A single conservative 24h
 * TTL (RESEARCH Open Q2) bounds live calls to at most once per window
 * system-wide, honoring the SCB 30-calls/10s budget (Pitfall 4).
 *
 * CACHE-POISONING DEFENSE (CR-01): `macro_snapshots` is genuinely shared and
 * NOT owner-scoped — any authenticated user's session can upsert a row via
 * PostgREST directly. The RLS `WITH CHECK` (migration 008) is defense-in-
 * depth, but the mandatory guard is on READ: `readThroughMacroCache` always
 * `safeParse`s a cached row against its scope's schema
 * (`nationalMacroPayloadSchema` / `regionalMacroPayloadSchema`) before
 * trusting it. A parse failure is treated as a cache MISS (falls through to
 * a live re-fetch) — a poisoned or shape-drifted row can never reach the
 * fact-sheet or UI.
 *
 * `MacroData` / `safeParseMacroData` are re-exported from macro-schema.ts so
 * callers (and macro.test.ts) can import them from `@/lib/market/macro`
 * (mirrors scb.ts's re-export block).
 */
export { type MacroData, safeParseMacroData } from "@/lib/market/macro-schema";

// --- Supabase client shape (structural — avoids a hard dependency on the
// concrete @supabase/supabase-js type here; callers pass their real client) --

interface MacroCacheRow {
  payload: unknown;
  fetched_at: string;
}

interface SupabaseLike {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (col: string, val: string) => {
        eq: (
          col: string,
          val: string,
        ) => {
          maybeSingle: () => Promise<{
            data: MacroCacheRow | null;
            error: unknown;
          }>;
        };
      };
    };
    upsert: (
      row: Record<string, unknown>,
      opts: { onConflict: string },
    ) => Promise<{ data: unknown; error: unknown }>;
  };
}

// --- Riksbank -----------------------------------------------------------

const RIKSBANK_BASE = "https://api.riksbank.se/swea/v1";
// Verified live (RESEARCH Code Examples): SECBREPOEFF = "Policy rate".
const POLICY_RATE_SERIES = "SECBREPOEFF";

// --- SCB PxWebApi ---------------------------------------------------------

const SCB_BASE = "https://api.scb.se/OV0104/v1/doris/en/ssd";

// Whitelisted SCB tables for the macro branch (RESEARCH verified-live paths
// + contents codes). Region/time values are always pinned server-side —
// never client-supplied (T-07-02 SSRF mitigation, T-03-06 precedent).
const MACRO_SCB_TABLES = {
  inflation: {
    // CPIF (not plain CPI) is the headline "inflation" figure — RESEARCH
    // Pitfall 3: the Riksbank's own policy target measure.
    path: "PR/PR0101/PR0101G/KPIF2020",
    // Verified live against the table's own metadata (07-02 spot-check,
    // flagged as a risk in 07-01-SUMMARY.md): the inferred "PR0101G1" 400s.
    // The real code for "CPIF, annual changes, 2020=100" is "000007ZM".
    contentsCode: "000007ZM", // annual change, %
  },
  regionalPrice: {
    path: "BO/BO0501/BO0501C/FastprisBRFRegionAr",
    contentsCode: "BO0501R8", // median price, SEK thousands
  },
} as const;

interface ScbQueryBody {
  query: Array<{
    code: string;
    selection: { filter: string; values: string[] };
  }>;
  response: { format: "json-stat2" };
}

// WR-02: bound every external fetch so a hanging Riksbank/SCB endpoint fails
// fast into the existing independent-degradation path instead of stalling
// for as long as the platform's own outer request timeout allows.
const FETCH_TIMEOUT_MS = 8_000;

interface PxWebQuerySpec {
  region?: { code: string; values: string[] };
  contentsCode: string[];
  // BL-3: time selection is either explicit period item values, or — the
  // preferred form for "latest published figure" — PxWeb's `top` filter, which
  // selects the most-recent N periods dynamically. Hardcoded item literals
  // (e.g. `["2026M05"]`) rot as the calendar advances: the figure goes stale
  // and eventually the exact period stops being offered, silently blanking the
  // indicator with no code path that ever advances it. `top` is self-maintaining.
  time: { filter: "item"; values: string[] } | { filter: "top"; count: number };
  extraDimensions?: Array<{ code: string; values: string[] }>;
}

/**
 * Assemble a PxWebApi v1 request body from a typed spec. A single seam so
 * that when SCB sunsets v1 (RESEARCH Assumption A1, unconfirmed date), only
 * this function's internals + SCB_BASE need to change — NOT every call
 * site. Per RESEARCH Pattern 3: do NOT retrofit scb.ts's inline
 * `ScbQueryBody` literals; this abstraction is only for NEW macro queries.
 */
function buildPxWebQuery(spec: PxWebQuerySpec): ScbQueryBody {
  const query: ScbQueryBody["query"] = [];
  if (spec.region) {
    query.push({
      code: spec.region.code,
      selection: { filter: "item", values: spec.region.values },
    });
  }
  for (const dim of spec.extraDimensions ?? []) {
    query.push({ code: dim.code, selection: { filter: "item", values: dim.values } });
  }
  query.push({
    code: "ContentsCode",
    selection: { filter: "item", values: spec.contentsCode },
  });
  query.push({
    code: "Tid",
    selection:
      spec.time.filter === "top"
        ? { filter: "top", values: [String(spec.time.count)] }
        : { filter: "item", values: spec.time.values },
  });
  return { query, response: { format: "json-stat2" } };
}

// The 21 SCB län codes ("01"-"25", with gaps). RESEARCH Pitfall 1 + Q3
// (RESOLVED): län-only, NOT the 4 storstad aggregates — full geographic
// coverage via kommunCode.slice(0,2), consistent granularity, no untested
// 2-vs-4-digit aggregate branch (WR-03). Region is ALWAYS derived
// server-side, never client free-text (T-07-02 SSRF allowlist).
const LAN_CODES = new Set([
  "01", "03", "04", "05", "06", "07", "08", "09", "10", "12",
  "13", "14", "17", "18", "19", "20", "21", "22", "23", "24", "25",
]);

/**
 * Validate a region code against the fixed län allowlist BEFORE it can ever
 * reach an SCB query body (T-07-02 SSRF mitigation). Rejects any free-text /
 * malformed value. `LAN_CODES` is the single allowlist (WR-03) — no
 * storstad-aggregate branch, which was untested and unverified against
 * BO0501C's actual Region dimension values.
 */
function isValidLanCode(code: string | null | undefined): code is string {
  if (!code) return false;
  return LAN_CODES.has(code);
}

/**
 * POST a parameterized json-stat2 query to a single SCB table. Returns the
 * raw JSON on success, or null on any failure — the caller's normalizer
 * then degrades that ONE indicator to null (never throws across the module
 * boundary, mirrors fetchScbTable in scb.ts).
 */
async function postScbTable(
  tablePath: string,
  body: ScbQueryBody,
): Promise<unknown | null> {
  try {
    const res = await fetch(`${SCB_BASE}/${tablePath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      // WR-06 (shard-3 review): a 4xx here (e.g. a wrong ContentsCode 400) is a
      // PERMANENT misconfiguration, not a transient outage — tag it distinctly
      // so it isn't lost in transient-failure noise on every request forever.
      const kind = res.status >= 400 && res.status < 500 ? "CONFIG(4xx)" : "OUTAGE(5xx)";
      console.error("[macro]", `table ${tablePath} → HTTP ${res.status} ${kind}`);
      return null;
    }
    return await res.json();
  } catch (error) {
    // Distinguish a timeout/abort from a hard network error (WR-06).
    const kind = error instanceof Error && error.name === "TimeoutError" ? "TIMEOUT" : "NETWORK";
    console.error("[macro]", `table ${tablePath} → ${kind}`, error);
    return null;
  }
}

/**
 * Fetch the latest Riksbank policy rate. Never throws — any failure
 * degrades to `{ value: null, date: null }` (independent degradation).
 */
export async function fetchPolicyRate() {
  try {
    const res = await fetch(
      `${RIKSBANK_BASE}/Observations/Latest/${POLICY_RATE_SERIES}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) {
      console.error("[macro]", `riksbank → HTTP ${res.status}`);
      return normalizePolicyRate(null);
    }
    const json: unknown = await res.json();
    return normalizePolicyRate(json);
  } catch (error) {
    console.error("[macro]", error);
    return normalizePolicyRate(null);
  }
}

/**
 * Fetch the latest CPIF annual-change figure. Never throws — any failure
 * degrades to `{ value: null, period: null }`.
 */
export async function fetchInflation() {
  const body = buildPxWebQuery({
    contentsCode: [MACRO_SCB_TABLES.inflation.contentsCode],
    // BL-3: most-recent published month, resolved by SCB — never a fixed literal.
    time: { filter: "top", count: 1 },
  });
  const raw = await postScbTable(MACRO_SCB_TABLES.inflation.path, body);
  return normalizeInflation(raw);
}

/**
 * Fetch the latest regional (län-level) tenant-owned-flat median price.
 * `lanCode` MUST pass `isValidLanCode` before this is called — an invalid
 * code never reaches the query body (T-07-02). Never throws — any failure
 * or invalid region degrades to all-null.
 */
export async function fetchRegionalPriceTrend(lanCode: string | null) {
  if (!isValidLanCode(lanCode)) {
    return normalizeRegionalPrice(null);
  }
  const body = buildPxWebQuery({
    region: { code: "Region", values: [lanCode] },
    contentsCode: [MACRO_SCB_TABLES.regionalPrice.contentsCode],
    // BL-3: two most-recent years so `normalizeRegionalPrice`'s lastNonNull
    // fallback still has a prior year when the latest is preliminary/null.
    time: { filter: "top", count: 2 },
  });
  const raw = await postScbTable(MACRO_SCB_TABLES.regionalPrice.path, body);
  return normalizeRegionalPrice(raw);
}

// --- Read-through TTL cache (RESEARCH Pattern 2) ---------------------------

// Single conservative TTL for all three indicators (RESEARCH Open Q2):
// worst case 24h staleness is immaterial for a strictly-descriptive,
// "as of DATE"-labeled section.
const TTL_HOURS = 24;

// WR-01: the two NATIONAL indicators (policy rate, CPIF) are identical for
// every analysis regardless of region — they are cached under this single,
// region-independent key so they are live-fetched at most once system-wide
// per TTL window, not once per distinct län (the module's own header comment
// already promises this call-budget behavior).
const NATIONAL_CACHE_KEY = "SE";

/**
 * CR-01: re-validate a cached `macro_snapshots` row against its schema
 * before EVER trusting it — the shared, non-owner-scoped cache table's RLS
 * write policy is only as strict as `WITH CHECK` allows (see migration 008),
 * so the read path must independently guard against a poisoned or
 * shape-drifted row, never trust a bare type assertion. A parse failure is
 * treated as a cache MISS: fall through to a live re-fetch (`fetchLive` is
 * always the caller-supplied live path, so this never throws).
 */
async function readThroughMacroCache<T>(
  supabase: SupabaseLike,
  scope: "national" | "regional",
  regionCode: string,
  ttlHours: number,
  schema: ZodType<T>,
  fetchLive: () => Promise<T>,
): Promise<T> {
  const { data: row } = await supabase
    .from("macro_snapshots")
    .select("payload, fetched_at")
    .eq("scope", scope)
    .eq("region_code", regionCode)
    .maybeSingle();

  const isFresh =
    row != null &&
    Date.now() - Date.parse(row.fetched_at) < ttlHours * 3_600_000;

  if (isFresh) {
    const parsed = schema.safeParse(row.payload);
    if (parsed.success) {
      return parsed.data;
    }
    console.error(
      "[macro] cached row failed schema validation — treating as a cache miss",
      { scope, regionCode },
    );
    // Fall through to a live re-fetch below — a poisoned/shape-drifted row
    // is NEVER returned to the caller.
  }

  const fresh = await fetchLive();
  const fetchedAt = new Date().toISOString();
  // WR-02 (shard-3 review): capture the upsert error. A discarded write (RLS
  // denial, a future scope/region_code that fails migration 008's WITH CHECK)
  // silently fails OPEN — the cache never populates and every subsequent
  // request re-fetches live, defeating the 24h TTL that protects the SCB
  // 30-calls/10s budget, with zero observability. Log it (GDPR-safe: keys +
  // code only, never the payload).
  const { error: upsertError } = await supabase
    .from("macro_snapshots")
    .upsert(
      { scope, region_code: regionCode, payload: fresh, fetched_at: fetchedAt },
      { onConflict: "scope,region_code" },
    );
  if (upsertError) {
    console.error("[macro] cache upsert failed — serving live, cache not populated", {
      scope,
      regionCode,
      code: (upsertError as { code?: string }).code,
    });
  }
  return fresh;
}

/**
 * Read-through the NATIONAL cache scope (WR-01): policy rate + CPIF, keyed
 * by a single system-wide key independent of region. Each indicator keeps
 * its own try/catch so one source's failure never blanks the other
 * (independent degradation, mirrors the PRICE/AREA branch discipline in
 * enrich-market-context.ts).
 */
async function readThroughNationalCache(
  supabase: SupabaseLike,
): Promise<NationalMacroPayload> {
  return readThroughMacroCache(
    supabase,
    "national",
    NATIONAL_CACHE_KEY,
    TTL_HOURS,
    nationalMacroPayloadSchema,
    async (): Promise<NationalMacroPayload> => {
      const [policyRateResult, inflationResult] = await Promise.all([
        (async () => {
          try {
            return await fetchPolicyRate();
          } catch (error) {
            console.error("[macro] policyRate", error);
            return normalizePolicyRate(null);
          }
        })(),
        (async () => {
          try {
            return await fetchInflation();
          } catch (error) {
            console.error("[macro] inflation", error);
            return normalizeInflation(null);
          }
        })(),
      ]);

      return {
        policyRate:
          policyRateResult.value !== null
            ? {
                value: policyRateResult.value,
                date: policyRateResult.date,
                source: "Riksbank",
              }
            : null,
        inflation:
          inflationResult.value !== null
            ? {
                value: inflationResult.value,
                period: inflationResult.period,
                source: "SCB",
                measure: "KPIF" as const,
              }
            : null,
      };
    },
  );
}

/**
 * Read-through the REGIONAL cache scope (WR-01): the län-level regional
 * price index only, keyed by `lanCode` (or `"SE"` when no coords resolved a
 * län). Never throws — a fetch failure degrades to `{ regionalPrice: null }`.
 */
async function readThroughRegionalCache(
  supabase: SupabaseLike,
  lanCode: string | null,
): Promise<RegionalMacroPayload> {
  const key = lanCode ?? "SE";
  return readThroughMacroCache(
    supabase,
    "regional",
    key,
    TTL_HOURS,
    regionalMacroPayloadSchema,
    async (): Promise<RegionalMacroPayload> => {
      let regionalPriceResult;
      try {
        regionalPriceResult = await fetchRegionalPriceTrend(lanCode);
      } catch (error) {
        console.error("[macro] regionalPrice", error);
        regionalPriceResult = normalizeRegionalPrice(null);
      }

      return {
        regionalPrice:
          regionalPriceResult.value !== null
            ? {
                value: regionalPriceResult.value,
                year: regionalPriceResult.year,
                preliminary: regionalPriceResult.preliminary,
                regionCode: lanCode,
                source: "SCB",
              }
            : null,
      };
    },
  );
}

/**
 * The public read-through entry point: merges the NATIONAL cache scope
 * (policy rate + CPIF, single system-wide key) with the REGIONAL cache scope
 * (regional price, keyed by `lanCode`) — WR-01 split, so the two national
 * indicators are live-fetched at most once system-wide per TTL window
 * instead of once per distinct län. Each scope degrades independently:
 * a national-cache failure never blanks the regional price and vice versa.
 * `lanCode` is always server-derived (kommunCode.slice(0,2)) — never client
 * free-text.
 */
export async function fetchMacroSnapshot(
  supabase: SupabaseLike,
  lanCode: string | null,
): Promise<MacroData> {
  const [national, regional] = await Promise.all([
    readThroughNationalCache(supabase),
    readThroughRegionalCache(supabase, lanCode),
  ]);

  return {
    policyRate: national.policyRate,
    inflation: national.inflation,
    regionalPrice: regional.regionalPrice,
  };
}
