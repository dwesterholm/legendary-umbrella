# Phase 7: Macro Price Context - Research

**Researched:** 2026-07-06
**Domain:** External macro-data integration (Riksbank SWEA + SCB PxWebApi) into an existing independent-branch market-context pipeline; no-prediction schema/prompt enforcement
**Confidence:** HIGH

## Summary

Phase 7 adds a fourth independent branch to `enrichMarketContext` (`src/actions/enrich-market-context.ts`) that fetches three descriptive macro indicators — Riksbank policy rate, CPI/CPIF inflation, and a regional (län-level) tenant-owned-flat price trend — and persists them through a NEW shared, time-keyed `macro_snapshots` table rather than a per-analysis column. This is architecturally different from the existing `price_data`/`area_data` columns: those live on the `analyses` row (one fetch per analysis), while macro data is identical for every analysis resolving to the same geography within a TTL window, so it belongs in its own cache table keyed by `(scope, region_code)` with a `fetched_at` timestamp.

Both source APIs were verified live during this research (curl against production endpoints, no key required): the Riksbank SWEA API (`api.riksbank.se/swea/v1`) returns the policy rate under series id `SECBREPOEFF` (currently 1.75%, `2026-07-06`), and the SCB PxWebApi v1 (`api.scb.se/OV0104/v1/doris/en/ssd`) serves CPI annual-change (`PR0101A/KPI2020M`, ContentsCode `00000804`) and CPIF (`PR0101G/KPIF2020`) tables, plus a **county-level, annual** tenant-owned-flat price series (`BO0501C/FastprisBRFRegionAr`) — there is no DeSO- or kommun-level bostadsrätt price series at SCB; län (county) is the finest available regional grain for this specific metric. The existing `resolveGeo()` only returns `kommunCode`/`desoCode`, but a län code is trivially derived as `kommunCode.slice(0, 2)` (verified Swedish administrative coding convention) — no changes to `geo.ts` are needed.

The no-prediction constraint is enforced exactly the way the codebase already enforces no-verdict for the AI report: by making the field UNREPRESENTABLE in the Zod schema (no `direction`/`trend`/`forecast` field can exist on the macro schema), by an explicit `ABSOLUT REGEL` addition to the synthesis system prompt, and by a new automated banned-phrase regression test. Because this data is deterministic and code-rendered (like `price_data`/`area_data`), the higher-value enforcement point is actually the **rendering layer and the synthesis prompt's fact-sheet slot**, not just the LLM — the macro card itself is a rendered table of numbers with source+period labels, never LLM-generated prose.

**Primary recommendation:** Add `macro_snapshots` as a new, globally-shared (non-RLS-owned) Supabase table with `(scope, region_code)` uniqueness and a `fetched_at` TTL column; add `src/lib/market/macro.ts` (Riksbank + SCB fetchers behind a thin `buildPxWebQuery` helper) and `src/lib/market/macro-schema.ts` (Zod schema with NO direction/magnitude field, mirroring `scb-schema.ts`'s permissive-parse-never-throw discipline); wire a 4th independent branch into `enrichMarketContext` that reads-through the cache table before hitting either API; render via a new `MacroContextCard` visually separate from `PriceComparisonCard`/`AreaStatsCard`; extend `fact-sheet.ts` with a `macro` slot and `prompt.ts` with an explicit negative constraint; add a `banned-predictive-phrases.test.ts` regression test.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Riksbank policy-rate fetch | API/Backend (server action / lib) | — | Keyless external HTTP call; must stay server-side (same posture as `scb.ts`) |
| SCB CPI/CPIF/regional-price fetch | API/Backend (server action / lib) | — | Same PxWebApi transport as existing `scb.ts`; server-only `fetch` |
| Shared macro cache (TTL) | Database/Storage | API/Backend | New `macro_snapshots` table is the durable cache of record; the backend reads through it before calling either API |
| No-prediction schema enforcement | API/Backend (Zod schema) | — | Schema shape is the primary enforcement point — mirrors `reportSchema`'s "no verdict field can exist" (D-04/FM2) |
| Banned-phrase enforcement | API/Backend (prompt + regression test) | — | Belongs beside `prompt.ts`/`report.ts`; a Vitest string-scan test, not a UI concern |
| Macro section rendering | Browser/Client (React component) | — | Pure presentational card, mirrors `AreaStatsCard`; renders persisted values only, no client-side fetch/compute |
| Independent-branch orchestration | API/Backend (`enrichMarketContext`) | — | The 4th branch lives in the existing server action, not a new endpoint |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Native `fetch` (Node 22, built into Next.js server runtime) | n/a (runtime built-in) | HTTP calls to Riksbank SWEA + SCB PxWebApi | Both `scb.ts` and `sold-source.ts` already use bare `fetch` — no HTTP client dependency exists in this codebase and none is warranted for two more keyless GET/POST JSON APIs |
| `zod` | `^4.3.6` (already a dependency — `[VERIFIED: package.json]`) | Schema + permissive parse for macro payloads | Matches `scb-schema.ts`/`sold-schema.ts`/`report.ts` exactly; project standard |

**No new npm packages are required for this phase.** Both external APIs are plain JSON-over-HTTP, keyless, and match the transport shape (`fetch` + `.json()` + Zod `.safeParse`) already proven in `src/lib/market/scb.ts`.

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Supabase Postgres (existing) | n/a | `macro_snapshots` shared cache table | Read-through cache keyed by `(scope, region_code)`, TTL via `fetched_at` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Bare `fetch` to Riksbank/SCB | A published npm wrapper (none found — `[ASSUMED]` no maintained SCB/Riksbank JS/TS client exists on npm as of this research) | Not investigated further; the existing codebase convention (raw fetch + Zod) is proven, lower-risk, and zero-dependency |
| `macro_snapshots` as a Postgres table | In-memory/module-level cache | Rejected — `scb.ts`'s own doc comment already establishes that module memory is illusory on serverless cold starts; the phase brief explicitly calls for a persisted shared table |

**Installation:** None — no new packages.

## Package Legitimacy Audit

**No external packages are installed by this phase.** Both data sources are consumed via native `fetch()` against public, keyless JSON APIs (Riksbank SWEA, SCB PxWebApi v1) using the same pattern already shipped in `src/lib/market/scb.ts`. The Package Legitimacy Gate does not apply — there is no `npm install` step to audit. `slopcheck` was confirmed installed and available (`/opt/homebrew/bin/slopcheck`) for use in any later phase that does add a dependency.

## Architecture Patterns

### System Architecture Diagram

```
                         enrichMarketContext(analysisId)
                                    |
        -----------------------------------------------------------
        |                |                  |                     |
   PRICE branch     AREA branch       MACRO branch (NEW)      (existing
   (Booli sold      (SCB DeSO         [4th independent         terminal
   comps, D-01      demographics,     branch]                  status /
   tier ladder)     D-06/D-07)             |                    persist)
                                            v
                                  resolveGeo() kommunCode
                                            |
                                  lanCode = kommunCode.slice(0,2)
                                            |
                        -----------------------------------
                        |                  |               |
                  fetchPolicyRate()  fetchInflation()  fetchRegionalPriceTrend()
                  (Riksbank SWEA)    (SCB PxWebApi)     (SCB PxWebApi, län-level)
                        |                  |               |
                        -----------------------------------
                                            |
                             read-through macro_snapshots cache
                             (scope + region_code, TTL via fetched_at)
                                            |
                              cache HIT -> return cached row
                              cache MISS/STALE -> fetch live -> upsert -> return
                                            |
                                  MacroData (each indicator independently
                                  null-tolerant -> "ej tillgänglig")
                                            |
                        persisted onto analyses.macro_data (jsonb)
                        alongside price_data / area_data (D-08 pattern)
                                            |
                                            v
                              MarketContextSection (client)
                                            |
                              MacroContextCard (NEW, own labeled
                              section, visually separate from
                              PriceComparisonCard/AreaStatsCard)
                                            |
                       (separately) fact-sheet.ts `macro` slot
                       -> synthesis prompt (explicit no-prediction
                          negative constraint) -> AI report narration
                          ONLY narrates pre-computed values, never
                          originates a trend/forecast claim
```

### Recommended Project Structure
```
src/lib/market/
├── macro-schema.ts        # Zod schema for macro_snapshots row + persisted macro_data (NO direction/magnitude field)
├── macro-schema.test.ts   # normalizer + safeParse tests (mirrors scb-schema.test.ts)
├── macro.ts               # fetchPolicyRate, fetchInflation, fetchRegionalPriceTrend + buildPxWebQuery abstraction
├── macro.ts (test)        # macro.test.ts — live-shape fixtures, cache-hit/miss/stale paths
└── __fixtures__/
    ├── riksbank-policy-rate.json
    ├── scb-cpi.json
    ├── scb-cpif.json
    └── scb-bo0501c-lan.json

src/actions/
└── enrich-market-context.ts   # add 4th independent branch (MACRO), read-through macro_snapshots

src/components/
└── macro-context-card.tsx     # NEW — "Marknadsläge"/"Makroekonomisk kontext" section

src/lib/report/
├── fact-sheet.ts           # add `macro` slot (6th key, alongside area/brf/flags/listing/price/softSignals)
├── prompt.ts                # add ABSOLUT REGEL 5 — macro is descriptive-only, never a signal
└── banned-predictive-phrases.test.ts  # NEW — regression test scanning report/macro rendering paths

supabase/migrations/
└── 006_macro_snapshots.sql  # NEW table (additive-only, new RLS policy required — see Pitfall below)
```

### Pattern 1: Independent-Branch Degradation (existing codebase pattern, extend to a 4th branch)
**What:** Each data source in `enrichMarketContext` fetches/fails/persists independently; one source's failure never blanks another's data.
**When to use:** Always, for every branch in this action — this IS the D-08 house style.
**Example:**
```typescript
// Source: src/actions/enrich-market-context.ts (existing PRICE/AREA branches, pattern to replicate)
// ====================================================================
// MACRO branch (independent — its failure never touches PRICE or AREA)
// ====================================================================
let macro: MacroData | null = null;
try {
  const lanCode = geo.kommunCode ? geo.kommunCode.slice(0, 2) : null;
  macro = await fetchMacroSnapshot(lanCode);
} catch (error) {
  console.error("[enrich-market] macro", {
    analysisId,
    code: error instanceof Error ? error.message : "UNKNOWN",
  });
  macro = null; // degrades to "ej tillgänglig" per-indicator, never blanks price/area
}
```

### Pattern 2: Read-Through Shared Cache with TTL (NEW for this codebase)
**What:** Before calling Riksbank/SCB, check `macro_snapshots` for a fresh row keyed by `(scope, region_code)`. On hit, return it. On miss/stale, fetch live, upsert, return.
**When to use:** Any indicator whose value is identical across all analyses in the same region/time window — the opposite of `price_data`/`area_data`, which are legitimately per-analysis (per-listing coords).
**Example:**
```typescript
// Illustrative — no direct Context7/official-docs source (project-internal pattern).
// Mirrors the persisted-column-as-cache philosophy already documented in scb.ts's
// header comment, generalized to a dedicated shared table.
async function readThroughMacroCache(
  supabase: SupabaseClient,
  scope: "national" | "regional",
  regionCode: string | null,
  ttlHours: number,
  fetchLive: () => Promise<unknown>,
): Promise<{ data: unknown; fetchedAt: string; stale: boolean }> {
  const key = regionCode ?? "SE";
  const { data: row } = await supabase
    .from("macro_snapshots")
    .select("payload, fetched_at")
    .eq("scope", scope)
    .eq("region_code", key)
    .maybeSingle();

  const isFresh =
    row && Date.now() - Date.parse(row.fetched_at) < ttlHours * 3_600_000;

  if (isFresh) {
    return { data: row.payload, fetchedAt: row.fetched_at, stale: false };
  }

  const fresh = await fetchLive();
  const fetchedAt = new Date().toISOString();
  await supabase
    .from("macro_snapshots")
    .upsert(
      { scope, region_code: key, payload: fresh, fetched_at: fetchedAt },
      { onConflict: "scope,region_code" },
    );
  return { data: fresh, fetchedAt, stale: false };
}
```

### Pattern 3: `buildPxWebQuery` Thin Abstraction (per phase brief — sunset mitigation)
**What:** A single function that assembles the PxWebApi v1 request body shape (`{ query: [...], response: { format: "json-stat2" } }`) so that when SCB sunsets v1, only this one function's internals (and the base URL) need to change, not every call site.
**When to use:** Every new SCB table query added in this phase (CPI, CPIF, regional price). The EXISTING `scb.ts` demographics queries were NOT written behind this abstraction (they inline `ScbQueryBody` object literals per-table) — do not retrofit them in this phase; only new macro queries need it, per the phase brief's explicit instruction.
**Example:**
```typescript
// Source: derived from the verified-live request shape (this research session,
// confirmed against api.scb.se/OV0104/v1/doris/en/ssd/PR/PR0101/PR0101A/KPI2020M)
interface PxWebQuerySpec {
  region?: { code: string; values: string[] };
  contentsCode: string[];
  time: string[];
  extraDimensions?: Array<{ code: string; values: string[] }>;
}

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
  query.push({ code: "Tid", selection: { filter: "item", values: spec.time } });
  return { query, response: { format: "json-stat2" } };
}
```

### Anti-Patterns to Avoid
- **Adding a `direction`/`trend`/`outlook` field "just for display":** Even a client-only enum like `"rising" | "falling" | "stable"` computed from two data points is a forecasting-adjacent signal once surfaced next to a price comparison. MACRO-02 requires the *comparison itself* be impossible to compute into a directional claim — do not add month-over-month delta fields to the schema; render only the latest value + its reference period + source.
- **Reusing `PRICE_COMPARISON_THRESHOLDS`-style "band" logic for macro:** The BRF/price flag engine (`flags.ts`) turns numeric bands into red/green/neutral severities. Do NOT run macro values through `computeFlags` or any severity classifier — that is inherently evaluative ("high rate = bad") and crosses into implied advice. Macro stays purely descriptive: number + label + source + period, no color-coded judgment.
- **Fetching macro data per-analysis without the cache table:** Would multiply Riksbank/SCB calls by every analysis view/re-enrich for no benefit (the value doesn't change per-listing) and risks the 30-calls/10s SCB budget (Pitfall 4 from Phase 3's own research) under concurrent load. The whole point of `macro_snapshots` is amortizing one fetch across all analyses in the TTL window.
- **Trying to get DeSO- or kommun-level bostadsrätt price trend from SCB:** Verified live — `BO0501C/FastprisBRFRegionAr` only offers `Region` values at national/storstadsområde/län granularity (see Pitfall 1 below). Do not build a `desoRegionValue`-style suffix for this table; it does not exist for BO0501C.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PxWebApi json-stat2 parsing | A second bespoke json-stat2 walker for macro tables | Reuse `jsonStat2Schema` + the flat-index/mixed-radix-coordinate walking pattern already in `scb-schema.ts`'s `normalizeScbOutput` (the CPI/CPIF/BO0501C payloads are simpler — 1–2 dimensions, no age/tenure grouping — so a lighter normalizer is fine, but parse through `jsonStat2Schema` first) | The existing schema is permissive/passthrough and already proven against SCB's real response shape; a second incompatible parser is duplicate surface area for the same untrusted-boundary problem (Pitfall 3 from Phase 3 research applies identically here) |
| Cache TTL / staleness logic | A generic caching library or Redis | A plain Postgres table + `fetched_at` timestamp comparison in application code | The codebase has zero caching infrastructure beyond "persist to the row you already have" — introducing Redis/a caching lib for 3 slow-changing indicators (policy rate changes ~8x/year, CPI monthly, regional price annually) is overkill; a `fetched_at` column and an `WHERE fetched_at > now() - interval` style read is sufficient and matches project simplicity bias |
| Banned-phrase detection | An LLM-based "does this text imply a prediction" classifier | A deterministic string/regex scan against a maintained banned-phrase list (Swedish: "kommer att", "förväntas stiga/sjunka", "bra läge att köpa/sälja", "priserna kommer", "väntas", English equivalents for any hardcoded UI strings) | Mirrors the existing house philosophy: `flags.ts`/`compare.ts` are pure deterministic code precisely because trust-critical checks must be reproducible and testable, not LLM-judged; a regex test is fast, free, deterministic, and CI-friendly — an LLM judge would be the ONLY non-deterministic gate on a trust-critical constraint in an otherwise fully-deterministic-except-synthesis codebase |
| Regional geo mapping (kommun -> län) | A new lookup table or API call to resolve län from kommun code | `kommunCode.slice(0, 2)` — verified Swedish SCB administrative coding convention (first 2 digits of a 4-digit kommunkod ARE the länskod) | No new data artifact or network call needed; this is a well-established, stable, government-published numbering scheme, not a heuristic |

**Key insight:** Every "don't hand-roll" item above already has a proven analog elsewhere in this exact codebase (`scb-schema.ts` for JSON parsing, `enrich-market-context.ts`'s persisted-column-as-cache philosophy, `flags.ts`'s pure-deterministic-computation discipline). This phase is lower-risk than Phase 3 (AREA-01) precisely because it is additive to a pattern the codebase has already proven twice (price, area) — the main net-new engineering surface is the shared cache table and its TTL read-through, not the API integration itself.

## Runtime State Inventory

Not applicable — this is a greenfield additive phase (new table, new columns, new files). No rename/refactor/migration of existing state.

## Common Pitfalls

### Pitfall 1: Assuming DeSO/kommun-level regional price data exists at SCB
**What goes wrong:** Planning a `macro_snapshots` schema keyed by `desoCode` (matching AREA-01's precedent) for the regional price-index indicator, then discovering at implementation time that the only available table (`BO0501C/FastprisBRFRegionAr`) has no DeSO or kommun dimension at all.
**Why it happens:** AREA-01 (Phase 3) trained the team to expect DeSO-level SCB tables; the natural instinct is to reuse that geo-resolution pattern for every new SCB indicator.
**How to avoid:** Verified live during this research: `BO0501C/FastprisBRFRegionAr`'s only `Region` values are `00` (Sweden), `0010`/`0020`/`0030`/`0060` (storstadsområden), and 21 two-digit län codes (`01`–`25`). Design `macro_snapshots.region_code` to store a **län code** (or `"SE"` for national scope), derived as `kommunCode.slice(0, 2)` from the already-resolved geo — do not attempt DeSO-level regional price granularity.
**Warning signs:** A `400 Bad Request` from SCB when querying `BO0501C` with a 9-character DeSO-shaped region value; the API's own value-list check (which the codebase already validates against per Pitfall 2 of the Phase 3 research) would catch this at the `isValidRegionCode`-equivalent stage if reused, but only if that validator is extended to accept 2-digit län codes too.

### Pitfall 2: RLS gap on the new shared `macro_snapshots` table
**What goes wrong:** Every existing table (`analyses`, and any BRF/report columns) is protected by per-user RLS (`auth.uid() = user_id`). `macro_snapshots` has NO `user_id` — it is a genuinely shared, cross-user cache. If migrated with RLS enabled but no policy (following the existing "additive, no new RLS policy" convention from `003_market_context.sql`/`005_report_lock.sql`), the table becomes completely inaccessible (RLS default-denies), and `enrichMarketContext` will silently fail every read/write to the cache (degrading to "always fetch live," defeating the purpose, or throwing if the client doesn't handle a permission-denied error explicitly).
**Why it happens:** The existing migration convention explicitly states "no new RLS policy — covered by existing per-user policy," which is TRUE for every prior migration (they only add columns to the already-RLS'd `analyses` table). `macro_snapshots` is the first NEW TABLE in this project's migration history that is not user-owned, so the "no new policy needed" convention does not transfer.
**How to avoid:** `macro_snapshots` needs its OWN explicit RLS policy: since there is no service-role client in this codebase (all writes currently go through the authenticated user's session client per `src/lib/supabase/server.ts`), the pragmatic policy is "any authenticated user can SELECT and UPSERT" (`using (auth.uid() is not null)` for both), since the data is non-sensitive, non-PII, publicly-sourced macro statistics — there is no confidentiality reason to restrict it further. Document this explicitly in the migration's SQL comments (mirroring the existing verbose migration-comment style) so a future reviewer understands why this table's policy differs from every other table's owner-only pattern.
**Warning signs:** `enrichMarketContext`'s macro branch silently returning null/failing in a way indistinguishable from a genuine API outage; check Supabase logs for `permission denied for table macro_snapshots` specifically, which would NOT show up in the `console.error` GDPR-safe logging pattern unless the Postgres error is surfaced.

### Pitfall 3: Confusing CPI with CPIF as "the inflation rate"
**What goes wrong:** Presenting plain CPI annual change as "inflation" when the Riksbank's actual policy target and the figure most commonly cited as "Swedish inflation" in financial media is CPIF (CPI with a fixed interest rate, stripping out the mechanical effect of policy-rate changes on mortgage interest costs within CPI itself).
**Why it happens:** CPI is the more discoverable/first table in SCB's PR0101A folder and has a shorter table name (`KPI2020M`); CPIF requires navigating one folder deeper (`PR0101G/KPIF2020`).
**How to avoid:** Use CPIF (`PR0101G/KPIF2020`, ContentsCode for annual change) as the primary "inflation" figure shown to users, since it is the measure the Riksbank itself targets and reports against when discussing policy-rate decisions — pairing "policy rate" + "CPI" (not CPIF) would present two indicators that are methodologically inconsistent with each other (CPI literally moves mechanically WITH the policy rate via mortgage interest costs, which is precisely why CPIF was created to exclude that effect). Label clearly ("KPIF" the Swedish standard abbreviation) so users familiar with Swedish financial reporting recognize it. `[ASSUMED — flagged in Assumptions Log]`: whether to show CPI, CPIF, or both is a product decision within Claude's discretion per CONTEXT.md; this pitfall documents the recommendation and its rationale.
**Warning signs:** A user or reviewer familiar with Swedish macro reporting asking "why does this inflation number not match what the Riksbank cites."

### Pitfall 4: SCB PxWebApi v1 rate limit (30 calls/10s) shared across THREE branches now
**What goes wrong:** Phase 3's AREA branch already makes 3 concurrent SCB calls per enrich (`Promise.all` in `fetchScbDemographics`). Adding 2 more SCB calls (CPI, CPIF — policy rate is Riksbank, separate host) for the MACRO branch without the read-through cache would push concurrent enrichment closer to the documented 30-calls/10s budget under load, especially since the AREA branch's calls are NOT cached today (each analysis re-fetches SCB demographics for its own DeSO on every re-enrich).
**Why it happens:** The macro indicators are national/regional (identical across most users), unlike AREA-01's DeSO-specific data, so it's tempting to assume "it's just 2 more calls, same as before" without recognizing the cache eliminates the repeat-call problem entirely if implemented correctly.
**How to avoid:** This is exactly why the phase brief mandates the shared cache — with a sane TTL (e.g., 6–24h for policy rate/CPI, since they update at most daily; weekly+ for the annual regional price table), the SCB/Riksbank calls happen at most once per TTL window system-wide, not once per analysis. Verify the TTL is generous enough that even a burst of many concurrent NEW analyses in the same hour causes at most 1 live fetch (the first one populates the cache; the rest hit the cache read).
**Warning signs:** SCB API calls succeeding for the first few analyses in a burst then failing with 429-style throttling for later ones in the same batch — would indicate the cache read-through isn't preventing duplicate concurrent fetches (a classic cache stampede — consider a simple "in-flight" guard or accepting the rare double-fetch as acceptable given the low volume, matching the codebase's existing risk tolerance for the AREA branch's per-analysis SCB calls).

### Pitfall 5: SCB "most recent year's figures are preliminary" note on BO0501C
**What goes wrong:** Presenting the latest available year's regional price figure without surfacing that SCB's own API response explicitly flags it as preliminary (`"Most recent year's figures are preliminary"` — verified live in the `BO0501C/FastprisBRFRegionAr` response `note` field), risking a stated number that later revises.
**Why it happens:** The `note` array in the json-stat2 response is easy to ignore when only extracting the `value` array.
**How to avoid:** Either surface the "preliminär" caveat in the UI label when rendering the latest year's regional price point, or deliberately use the second-most-recent year (which per the fetched fixture, e.g. 2024 vs 2025, is final) as the headline figure with the current year shown as a secondary/preliminary data point if desired. This is a minor polish item, not a correctness blocker, but ties into MACRO-02's "strictly descriptive, clearly labeled" success criterion — a caveat about data provisionality is itself part of being clearly labeled and honest about source/period.
**Warning signs:** None at build time — this is a labeling/trust nuance, not a functional bug.

## Code Examples

Verified patterns from live API responses captured during this research session (2026-07-06):

### Riksbank policy rate — latest value
```bash
# Source: https://api.riksbank.se/swea/v1/Observations/Latest/SECBREPOEFF (verified live, no key)
curl "https://api.riksbank.se/swea/v1/Observations/Latest/SECBREPOEFF"
# => {"date":"2026-07-06","value":1.75}
```

### Riksbank — batch latest by group (policy rate group = 2)
```bash
# Source: https://api.riksbank.se/swea/v1/Observations/Latest/ByGroup/2 (verified live)
curl "https://api.riksbank.se/swea/v1/Observations/Latest/ByGroup/2"
# => [
#   {"seriesId":"SECBDEPOEFF","date":"2026-07-06","value":1.65},
#   {"seriesId":"SECBLENDEFF","date":"2026-07-06","value":1.85},
#   {"seriesId":"SECBLIKVEFF","date":"2026-07-06","value":2.05},
#   {"seriesId":"SECBMARGEFF","date":"1994-05-31","value":7},
#   {"seriesId":"SECBREPOEFF","date":"2026-07-06","value":1.75}
# ]
```

### SCB CPIF/CPI annual change (json-stat2 POST)
```typescript
// Source: verified live against api.scb.se/OV0104/v1/doris/en/ssd/PR/PR0101/PR0101A/KPI2020M
// (mirrors the ScbQueryBody shape already defined in src/lib/market/scb.ts)
const body = {
  query: [
    { code: "ContentsCode", selection: { filter: "item", values: ["00000804"] } }, // "Annual changes"
    { code: "Tid", selection: { filter: "item", values: ["2026M05"] } },
  ],
  response: { format: "json-stat2" as const },
};
// POST to https://api.scb.se/OV0104/v1/doris/en/ssd/PR/PR0101/PR0101A/KPI2020M
// => { ..., "value": [0.8] }  (0.8% annual CPI change, May 2026)
```

### SCB regional tenant-owned-flat median price (län-level)
```typescript
// Source: verified live against api.scb.se/OV0104/v1/doris/en/ssd/BO/BO0501/BO0501C/FastprisBRFRegionAr
const body = {
  query: [
    { code: "Region", selection: { filter: "item", values: ["01"] } }, // "01" = Stockholm county
    { code: "ContentsCode", selection: { filter: "item", values: ["BO0501R8"] } }, // "Median price in SEK thousands"
    { code: "Tid", selection: { filter: "item", values: ["2024", "2025"] } },
  ],
  response: { format: "json-stat2" as const },
};
// => { ..., "value": [3400, 3500] }  (median 3.4M SEK 2024 -> 3.5M SEK 2025, Stockholm county)
// note field includes: "Most recent year's figures are preliminary." (Pitfall 5)
```

### Deriving län code from the existing resolveGeo() output
```typescript
// No new geo.ts function needed — kommunkod's first 2 digits ARE the länskod
// (verified Swedish SCB administrative numbering convention).
const geo = resolveGeo(lat, lng); // existing function, unchanged
const lanCode: string | null = geo.kommunCode ? geo.kommunCode.slice(0, 2) : null;
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| SCB PxWebApi v1 (`api.scb.se/OV0104/v1/doris`) | SCB PxWebApi 2.0 launched | October 2025 `[CITED: web search result summary of scb.se/en/services/open-data-api/pxwebapi/pxwebapi-2.0]` | v1 remains live and fully functional today (verified: all v1 endpoints used in this research responded normally on 2026-07-06); no publicly confirmed hard sunset date was found for v1 during this research — the phase brief's "sunsets end-2026/early-2027" framing could not be independently confirmed from an official SCB source in this session and should be treated as the trigger for the `buildPxWebQuery` abstraction regardless of the exact date, not as a verified fact |
| CPI 1980=100 base tables (`KPItotM`, etc.) | CPI 2020=100 base tables (`KPI2020M`, etc.) | SCB's own note: "From year 2026, the new reference year for the CPI will be 2020 instead of 1980... the CPI with reference year 1980 will continue to be published until 2030" `[VERIFIED: live SCB API response note field]` | Use the 2020-base tables (`KPI2020M`, `KPIF2020`) as the forward-looking standard; the 1980-base tables are maintained only for legacy index-linked contracts and will stop updating after 2025 for some variants (`KPItotM` already shows "no update after 2025M12" in its live table listing) |

**Deprecated/outdated:**
- `KPItotM` (1980=100, no monthly update after 2025M12) — do not use for new integrations; use `KPI2020M`.
- The phase brief's claim that "SCB PxWebApi v1... sunsets end-2026/early-2027" is `[ASSUMED]` from the roadmap/context, not independently verified against an official SCB decommission notice in this research session — see Assumptions Log A1.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|----------------|
| A1 | SCB PxWebApi v1 sunsets end-2026/early-2027 (carried from CONTEXT.md/phase brief, not independently confirmed against an official SCB decommission announcement — WebFetch to scb.se was blocked by network policy during this research session, and WebSearch results only confirmed PxWebApi 2.0 launched Oct 2025 with no explicit v1 shutdown date) | State of the Art, Summary | If the sunset date is wrong or v1 has no fixed retirement date, the `buildPxWebQuery` abstraction is still good practice (cheap insurance) but building it under artificial time pressure could over-engineer the abstraction; if the sunset is REAL and sooner than assumed, under-investing in the abstraction risks a breaking migration later. Recommendation stands either way: build the thin abstraction, but do not block the phase on confirming the exact date. |
| A2 | CPIF (not plain CPI) is the recommended "inflation" headline figure to show users | Pitfall 3 | If the product intent is "match what a layperson searches for" rather than "match what the Riksbank targets," CPI might be the more recognizable term to a non-financial user; this is a product/UX call within Claude's discretion per CONTEXT.md, not a technical fact |
| A3 | No maintained npm/PyPI wrapper exists for either Riksbank SWEA or SCB PxWebApi that would be preferable to raw `fetch` | Standard Stack (Alternatives Considered) | Low risk — even if such a package existed, the codebase's own `scb.ts` precedent (raw fetch + Zod) is the stronger convention-consistency argument regardless |
| A4 | "Any authenticated user can read/write `macro_snapshots`" is an acceptable RLS policy for this shared, non-PII cache table | Pitfall 2 | If a stricter policy is actually desired (e.g., service-role-only writes), this would require introducing a service-role Supabase client to the codebase for the first time — a larger architectural addition than a simple RLS policy; flagged for planner/user confirmation since it is a genuine new pattern, not just an extension of existing conventions |

**If this table is empty:** N/A — see entries above.

## Open Questions (RESOLVED)

> **Resolution (planning gate, 2026-07-06):** All three questions resolved for Phase 7 execution per the recommendations below. None gate this phase; each has a concrete decision.
>
> - **Q1 (SCB v1 sunset date) — RESOLVED:** Build the `buildPxWebQuery` abstraction regardless of the exact sunset date (good practice independent of timing). Confirming the precise decommission date is deferred to the eventual v1→v2 migration phase (out of scope for Phase 7).
> - **Q2 (TTL) — RESOLVED:** Use a single conservative **24h TTL** for all three indicators. Worst case is 24h staleness, immaterial for a strictly-descriptive "as of DATE"-labeled section. Per-indicator refinement is a future option, not required now.
> - **Q3 (regional scope) — RESOLVED:** Key `macro_snapshots` regional rows by the **21 län codes** (natural match for `kommunCode.slice(0,2)`), not the 4 storstadsområde aggregates — full geographic coverage, consistent granularity.

1. **Exact SCB PxWebApi v1 retirement date**
   - What we know: PxWebApi 2.0 launched October 2025 per search results; v1 (`api.scb.se/OV0104/v1/doris`) is fully live and responding normally as of 2026-07-06 (verified live in this session).
   - What's unclear: No official SCB decommission-date page was reachable in this research session (WebFetch to scb.se blocked by network/sandbox policy). The phase brief's "end-2026/early-2027" framing is unverified.
   - Recommendation: Build the `buildPxWebQuery` abstraction as instructed regardless of the exact date (it is good practice independent of timing); do not gate the phase on confirming the date. A human with unrestricted web access should spot-check `scb.se/en/services/open-data-api/pxwebapi/` directly before the eventual v1-to-v2 migration phase (out of scope for Phase 7).

2. **TTL duration for each of the three macro indicators**
   - What we know: Policy rate changes roughly 5–8 times/year (per Riksbank's typical meeting cadence); CPI/CPIF publish monthly (per SCB's `updated` timestamps, e.g. `2026-06-11` for May 2026 data); the regional price table publishes annually with the current year flagged preliminary.
   - What's unclear: The exact TTL hours the planner should hardcode — this is a product/ops tradeoff (freshness vs. call volume) not resolvable by research alone.
   - Recommendation: A single conservative TTL (e.g., 24h) for all three is simplest and safe (worst case: data is up to 24h stale, which is immaterial for a strictly-descriptive, "as of DATE" labeled section); a per-indicator TTL (24h for policy rate/CPI, 7 days for the annual regional table) is a reasonable refinement the planner can choose either way — both are compatible with the MACRO-01/02 success criteria as written.

3. **Whether "regional" scope in `macro_snapshots` should key by län code or by a small fixed set of storstadsområde codes**
   - What we know: `BO0501C` supports both 21 län codes AND 4 aggregate storstad codes (`0010` Greater Stockholm, `0020` Greater Gothenburg, `0030` Greater Malmö, `0060` rest-of-Sweden).
   - What's unclear: Whether showing "Stockholms län" vs. "Storstockholm" reads better to end users; both are valid SCB regional aggregates for the same table.
   - Recommendation: Use the 21 län codes (matching every kommun's derivable län) for full geographic coverage — the storstad aggregates only cover 3 metro areas + "rest of Sweden," which would produce an odd 4-bucket system alongside DeSO/kommun-level precision elsewhere in the product. Län-level is the natural match for `kommunCode.slice(0,2)`.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Riksbank SWEA API (`api.riksbank.se/swea/v1`) | Policy rate fetch | Yes — verified live, `SECBREPOEFF` returned `1.75` for `2026-07-06` | v1 (no version header found; stable public API) | Indicator degrades to "ej tillgänglig" per MACRO-02 success criterion 4 |
| SCB PxWebApi v1 (`api.scb.se/OV0104/v1/doris`) | CPI, CPIF, regional price fetch | Yes — verified live, all three tables (`PR0101A/KPI2020M`, `PR0101G/KPIF2020`, `BO0501C/FastprisBRFRegionAr`) responded correctly | v1 (v2.0 exists in parallel per SCB, not required for this phase) | Each indicator degrades independently to "ej tillgänglig"; existing `scb.ts` AREA branch is unaffected (different tables, same host) |
| Supabase Postgres (existing project infra) | `macro_snapshots` table | Yes — existing infra, already used by `analyses`/`brf`/`report` tables | Existing project version | None needed — this is already the project's database |
| `slopcheck` CLI | Package legitimacy gate | Yes — installed during this research session at `/opt/homebrew/bin/slopcheck` | Latest (installed via `pip install slopcheck --break-system-packages`) | N/A — not needed this phase (no new packages) |

**Missing dependencies with no fallback:** None.

**Missing dependencies with fallback:** None — both external APIs confirmed live and keyless; if either goes down at execution time, the existing per-indicator null-degradation pattern (mirroring `sourceUnavailablePrice()`/`fetchScbDemographics`'s try/catch) handles it without blocking the rest of the phase.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest `^4.1.8` (existing project standard, `vitest.config.ts` at repo root) |
| Config file | `vitest.config.ts` (node environment, globals on, `@/*` alias to `src/*`) |
| Quick run command | `npx vitest run src/lib/market/macro-schema.test.ts src/lib/market/macro.test.ts` |
| Full suite command | `npm run test` (= `vitest run`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|---------------------|--------------|
| MACRO-01 | `normalizeMacroOutput`-equivalent parses live-shaped Riksbank/SCB fixtures into policy rate / CPI(F) / regional price figures | unit | `npx vitest run src/lib/market/macro-schema.test.ts -t "normalize"` | ❌ Wave 0 |
| MACRO-01 | `fetchMacroSnapshot` returns cached row on fresh `macro_snapshots` hit, fetches live + upserts on miss/stale | unit (mocked Supabase client + mocked fetch) | `npx vitest run src/lib/market/macro.test.ts -t "cache"` | ❌ Wave 0 |
| MACRO-01 | Each of the three indicators degrades independently to null on its own source failure (one API 500 does not blank the other two) | unit | `npx vitest run src/lib/market/macro.test.ts -t "independent"` | ❌ Wave 0 |
| MACRO-01 | `enrichMarketContext`'s new 4th branch persists `macro_data` without blanking `price_data`/`area_data` on macro failure | integration (mocked externals, mirrors existing `enrich-market-context` test conventions if any exist — check for a co-located test file at plan time) | `npx vitest run src/actions/enrich-market-context.test.ts -t "macro"` | ❌ Wave 0 (confirm whether `enrich-market-context.test.ts` already exists — not found during this research; verify at plan time) |
| MACRO-02 | Macro Zod schema has NO field capable of representing direction/magnitude/forecast (schema-shape assertion) | unit | `npx vitest run src/lib/market/macro-schema.test.ts -t "schema shape"` | ❌ Wave 0 |
| MACRO-02 | Banned-predictive-phrase regression test scans rendered macro card strings + synthesis prompt fixture output for forbidden phrases | unit (string/regex scan, deterministic) | `npx vitest run src/lib/report/banned-predictive-phrases.test.ts` | ❌ Wave 0 |
| MACRO-02 | `MacroContextCard` renders in its own labeled section, visually distinct container from `PriceComparisonCard`/`AreaStatsCard` | component/snapshot (React Testing Library not currently in devDependencies — confirm at plan time whether this is tested via a lighter assertion, e.g. checking the component exports/props shape, matching the project's existing component-test coverage level, which appears LOW — no `.test.tsx` files were found for `area-stats-card.tsx` or `price-comparison-card.tsx`) | TBD at plan time | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run <touched-test-files>`
- **Per wave merge:** `npm run test` (full suite)
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/lib/market/macro-schema.ts` + `src/lib/market/macro-schema.test.ts` — new files, no existing test infra gap (Vitest already configured)
- [ ] `src/lib/market/macro.ts` + `src/lib/market/macro.test.ts` — new files; will need `__fixtures__/riksbank-policy-rate.json`, `__fixtures__/scb-cpi.json`, `__fixtures__/scb-cpif.json`, `__fixtures__/scb-bo0501c-lan.json` (capture real shapes from the live curl outputs in this research — see Code Examples section)
- [ ] `src/lib/report/banned-predictive-phrases.test.ts` — new file; needs a maintained banned-phrase list (Swedish + English) as a shared const, ideally co-located so both the prompt.ts negative-constraint text and the test's phrase list can be reviewed together
- [ ] Confirm whether `src/actions/enrich-market-context.test.ts` exists already (not found in this research pass — `find` located no test file for this action; verify at plan time since the action itself has substantial branch logic worth testing, though its ABSENCE today is a pre-existing gap, not one introduced by this phase)
- [ ] No React component test harness (React Testing Library / jsdom) currently installed — `AreaStatsCard`/`PriceComparisonCard` have no `.test.tsx` files; `MacroContextCard` should match the existing project convention (no component tests) rather than introducing a new test tooling dependency mid-phase; if component-level assertions of MACRO-02's "own labeled section" criterion are desired, prefer a lightweight non-DOM assertion (e.g., testing a pure `formatMacroSection`-style helper function that returns the section title/labels, verified via plain Vitest) over adding RTL/jsdom.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|----------------|---------|-------------------|
| V2 Authentication | No (new) | Reuses existing `enrichMarketContext` owner-only auth gate (`supabase.auth.getUser()`) — no new auth surface |
| V3 Session Management | No | No change |
| V4 Access Control | Yes | `macro_snapshots` RLS policy (Pitfall 2) — must explicitly allow authenticated read/write since it is NOT owner-scoped like every other table; absence of an explicit policy = total lockout (RLS default-deny), not an access-control leak, but still requires deliberate design |
| V5 Input Validation | Yes | Zod `.safeParse` on every Riksbank/SCB response (never trust the external payload) — mirrors `jsonStat2Schema`'s permissive/passthrough-but-typed discipline; region-code values passed INTO SCB queries must be validated against a fixed set (län codes `01`–`25` + aggregates), never accept free-text region input, mirroring `isValidRegionCode` in `scb.ts` (T-03-06 SSRF mitigation precedent) |
| V6 Cryptography | No | No secrets/crypto involved — both APIs are keyless |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| SSRF via unvalidated region code reaching the SCB query URL/body | Tampering | Reuse the `isValidRegionCode`-equivalent allowlist check (extended to accept 2-digit län codes) before any region value is interpolated into a PxWebApi query body — never accept a client-supplied region string; the region is always derived server-side from `resolveGeo()`'s output, never from user input directly (same discipline as the existing AREA-01 code) |
| Unbounded/duplicate concurrent fetches to Riksbank/SCB under load (cache stampede) | Denial of Service (self-inflicted, against the rate-limited upstream API) | The `macro_snapshots` read-through cache with TTL (Pitfall 4); optionally an in-flight-request guard if cache stampede under burst load proves material, though given current traffic volume (a solo-dev product) this is a "nice to have," not a blocker |
| Malformed/adversarial JSON response from either API crashing the enrich pipeline | Denial of Service | Every fetch wrapped in try/catch + Zod `.safeParse`, mirroring `fetchScbTable`'s existing `null`-on-any-failure discipline — never let a macro fetch throw uncaught into `enrichMarketContext` |
| Macro data silently misrepresented as a buy/sell signal via prompt injection through a future SCB/Riksbank field name change | Spoofing/Tampering (of intent, not data) | The schema itself (no direction/magnitude field can exist) is the primary control; the synthesis prompt's explicit negative constraint is the secondary control; the banned-phrase regression test is the tertiary/detective control — three independent layers, matching the existing no-verdict enforcement depth for `reportSchema` |

## Sources

### Primary (HIGH confidence)
- `https://api.riksbank.se/swea/v1/Groups` — verified live, confirmed group 2 = "Riksbank key interest rates"
- `https://api.riksbank.se/swea/v1/Series?groupid=2` — verified live, confirmed `SECBREPOEFF` = "Policy rate"
- `https://api.riksbank.se/swea/v1/Observations/Latest/SECBREPOEFF` — verified live, `1.75` on `2026-07-06`
- `https://api.riksbank.se/swea/v1/Observations/Latest/ByGroup/2` — verified live, batch shape confirmed
- `https://api.scb.se/OV0104/v1/doris/en/ssd/PR/PR0101` — verified live, confirmed CPI/CPIF folder structure
- `https://api.scb.se/OV0104/v1/doris/en/ssd/PR/PR0101/PR0101A/KPI2020M` (POST) — verified live, `0.8`% annual CPI change for `2026M05`
- `https://api.scb.se/OV0104/v1/doris/en/ssd/PR/PR0101/PR0101G` — verified live, confirmed `KPIF2020` table exists
- `https://api.scb.se/OV0104/v1/doris/en/ssd/BO/BO0501/BO0501C/FastprisBRFRegionAr` (POST) — verified live, confirmed län-only region grain + preliminary-year note
- Codebase: `src/actions/enrich-market-context.ts`, `src/lib/market/scb.ts`, `src/lib/market/scb-schema.ts`, `src/lib/market/geo.ts`, `src/lib/market/cost.ts`, `src/lib/report/{prompt,synthesize,fact-sheet,flags}.ts`, `src/lib/schemas/report.ts`, `src/components/{market-context-section,area-stats-card,price-comparison-card}.tsx`, `supabase/migrations/00{1,2,3,4,5}_*.sql`, `.planning/{REQUIREMENTS,STATE}.md`, `.planning/phases/07-macro-price-context/07-CONTEXT.md`

### Secondary (MEDIUM confidence)
- WebSearch: "Swedish kommunkod first two digits län code mapping convention" — cross-referenced against the observed `BO0501C` region-code list (`01`=Stockholm county matching kommun codes `0114`–`0192` all starting with `01`), confirming the convention via direct data cross-check, not just the search summary

### Tertiary (LOW confidence)
- WebSearch: SCB PxWebApi v1 sunset/decommission date — no official SCB source with a specific date was found or reachable (WebFetch blocked); flagged as Assumption A1, not stated as fact anywhere in this document
- WebSearch: existence/non-existence of npm/PyPI wrappers for Riksbank/SCB — not exhaustively searched; flagged as Assumption A3

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies; existing `fetch`+Zod pattern directly reused, verified against real API responses
- Architecture: HIGH — extends a proven, twice-shipped pattern (`enrichMarketContext`'s independent-branch model); the one genuinely new element (shared cache table + its RLS policy) is clearly flagged and reasoned through
- Pitfalls: HIGH — five pitfalls identified and verified against live API behavior (regional grain, RLS gap, CPI-vs-CPIF, rate-limit-under-cache, preliminary-year note), not speculative
- Sunset timeline for SCB PxWebApi v1: LOW — could not verify the phase brief's specific date claim; documented as Assumption A1, does not block the phase

**Research date:** 2026-07-06
**Valid until:** 2026-08-05 (30 days — both external APIs are stable government statistical services; the one time-sensitive fact, SCB PxWebApi v1's retirement timeline, is explicitly flagged as unverified and should be re-checked before any later v1-to-v2 migration work, not before this phase's execution)
