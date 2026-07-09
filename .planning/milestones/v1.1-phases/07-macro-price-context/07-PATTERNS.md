# Phase 7: Macro Price Context - Pattern Map

**Mapped:** 2026-07-06
**Files analyzed:** 10 (7 new, 3 modified)
**Analogs found:** 10 / 10

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `src/lib/market/macro-schema.ts` | model/utility | transform | `src/lib/market/scb-schema.ts` | exact |
| `src/lib/market/macro-schema.test.ts` | test | transform | `src/lib/market/scb-schema.test.ts` | exact |
| `src/lib/market/macro.ts` | service | request-response + CRUD (cache read-through) | `src/lib/market/scb.ts` | exact |
| `src/lib/market/macro.test.ts` | test | request-response | `src/lib/market/scb.test.ts` (if present) / `scb-schema.test.ts` | role-match |
| `src/actions/enrich-market-context.ts` (modify — add 4th branch) | controller (server action) | event-driven / independent-branch orchestration | itself (PRICE/AREA branches) | exact |
| `src/components/macro-context-card.tsx` | component | request-response (pure render) | `src/components/area-stats-card.tsx` | exact |
| `src/components/market-context-section.tsx` (modify — wire 3rd panel) | component/provider | event-driven (client orchestrator) | itself (existing area-panel independent-render branch) | exact |
| `src/lib/report/fact-sheet.ts` (modify — add `macro` slot) | utility | transform | itself (existing `slot()` wrapper) | exact |
| `src/lib/report/prompt.ts` (modify — add ABSOLUT REGEL 5) | config (prompt) | transform | itself (existing REGEL 1–4 block) | exact |
| `src/lib/report/banned-predictive-phrases.test.ts` | test | transform (string scan) | `src/lib/schemas/report.ts`'s no-verdict discipline (no direct test analog exists — new pattern) | role-match |
| `supabase/migrations/006_macro_snapshots.sql` | migration | CRUD (new shared table + RLS) | `supabase/migrations/003_market_context.sql` (columns) / needs NEW RLS unlike any prior migration | partial (RLS is novel) |

## Pattern Assignments

### `src/lib/market/macro-schema.ts` (model, transform)

**Analog:** `src/lib/market/scb-schema.ts`

**Header/doc-comment pattern** (lines 1-13):
```typescript
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
```
Reuse this framing verbatim for `macro-schema.ts`, substituting AREA-01/D-06/D-08 refs for MACRO-01/MACRO-02, and add an explicit line stating **no `direction`/`trend`/`magnitude` field exists** (the no-prediction constraint baked into the type, mirroring `reportSchema`'s "NO verdict field" comment below).

**Permissive json-stat2 envelope** (`jsonStat2Schema`, lines 33-43) — reuse directly (import, do not re-declare):
```typescript
export const jsonStat2Schema = z
  .object({
    class: z.string().optional(),
    id: z.array(z.string()).optional(),
    size: z.array(z.number()).optional(),
    dimension: z.record(z.string(), jsonStatDimensionSchema).optional(),
    value: z.array(z.number().nullable()).optional(),
  })
  .passthrough();
```
Per RESEARCH "Don't Hand-Roll" table: import `jsonStat2Schema` from `scb-schema.ts` for the CPI/CPIF/BO0501C responses — do not re-declare it in `macro-schema.ts`. Only Riksbank's flat `{date, value}` / `[{seriesId,date,value}]` shape needs a NEW small schema (Riksbank is not json-stat2).

**Null-tolerant normalizer discipline** (lines 65-67, 99-116):
```typescript
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
...
export function normalizeScbOutput(raw: unknown): NormalizedScb {
  const result: NormalizedScb = { population: null, age: null, income: null, tenure: null };
  const parsed = jsonStat2Schema.safeParse(raw);
  if (!parsed.success) return result;
  ...
}
```
Mirror this exact shape for `normalizeMacroOutput`/`normalizePolicyRate`/`normalizeCpi`: always return a fully-typed null-default object, `safeParse` first, never throw, one field independently null-able per source (RESEARCH MACRO-01 test map: "Each of the three indicators degrades independently").

**No-prediction field ban** — mirror `src/lib/schemas/report.ts` lines 5-12 and 59-60:
```typescript
// there is NO `verdict`/`recommendation`/`betyg` field (D-04, FM2)
...
// NO verdict / recommendation / buy-signal field — the line is
// unrepresentable (D-04/FM2).
```
Add an equivalent trailing comment on the macro schema: "NO direction/trend/magnitude field — the schema shape is the primary no-prediction enforcement point (MACRO-02)."

---

### `src/lib/market/macro.ts` (service, request-response + cache read-through)

**Analog:** `src/lib/market/scb.ts`

**Module header / caching philosophy** (lines 10-28) — reuse the doc-comment framing, but correct the caching claim: `scb.ts` explicitly says module memory is illusory and the durable cache is the persisted column; `macro.ts` instead uses a REAL durable shared table (`macro_snapshots`), so the doc comment should state this contrast explicitly (RESEARCH Pattern 2 is genuinely new for this codebase — flag it as such in the file header, don't imply it's the same pattern).

**Whitelisted table config as `as const` object** (lines 42-75) — reuse this exact shape for the three SCB macro tables (CPI `PR0101A/KPI2020M`, CPIF `PR0101G/KPIF2020`, regional price `BO0501C/FastprisBRFRegionAr`), each with `path`, `contentsCode`, and region/time values pinned server-side (never client-supplied) — this is also the SSRF mitigation precedent (T-03-06) that RESEARCH's Security section requires reusing for the län-code allowlist.

**`buildPxWebQuery` abstraction** — NEW pattern per RESEARCH Pattern 3 (not in `scb.ts` — do not retrofit `scb.ts`'s inline `ScbQueryBody` literals). Use the RESEARCH-provided reference implementation directly:
```typescript
interface PxWebQuerySpec {
  region?: { code: string; values: string[] };
  contentsCode: string[];
  time: string[];
  extraDimensions?: Array<{ code: string; values: string[] }>;
}

function buildPxWebQuery(spec: PxWebQuerySpec): ScbQueryBody {
  const query: ScbQueryBody["query"] = [];
  if (spec.region) {
    query.push({ code: spec.region.code, selection: { filter: "item", values: spec.region.values } });
  }
  for (const dim of spec.extraDimensions ?? []) {
    query.push({ code: dim.code, selection: { filter: "item", values: dim.values } });
  }
  query.push({ code: "ContentsCode", selection: { filter: "item", values: spec.contentsCode } });
  query.push({ code: "Tid", selection: { filter: "item", values: spec.time } });
  return { query, response: { format: "json-stat2" as const } };
}
```

**Error handling** — mirror `scb.ts`'s bare `fetch` + `.json()` + try/catch-at-call-site discipline (see `enrich-market-context.ts`'s AREA branch below for the calling convention); `macro.ts`'s fetchers should never throw across the module boundary uncaught — return `null` on any failure, consistent with `fetchScbDemographics`.

**Read-through cache** — NEW pattern (RESEARCH Pattern 2), no existing codebase analog. Use RESEARCH's reference implementation verbatim as the starting point:
```typescript
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

  const isFresh = row && Date.now() - Date.parse(row.fetched_at) < ttlHours * 3_600_000;
  if (isFresh) return { data: row.payload, fetchedAt: row.fetched_at, stale: false };

  const fresh = await fetchLive();
  const fetchedAt = new Date().toISOString();
  await supabase
    .from("macro_snapshots")
    .upsert({ scope, region_code: key, payload: fresh, fetched_at: fetchedAt }, { onConflict: "scope,region_code" });
  return { data: fresh, fetchedAt, stale: false };
}
```

---

### `src/actions/enrich-market-context.ts` (modify — add 4th independent branch)

**Analog:** itself — the existing PRICE/AREA branch pattern in the same file.

**Independent-branch try/catch skeleton** (lines 450-460, the AREA branch — the more direct analog since MACRO, like AREA, is a single async call with no multi-tier walk):
```typescript
let area: AreaData | null = null;
try {
  area = await fetchScbDemographics(geo);
} catch (error) {
  // SCB failure → area null WITHOUT aborting the price branch (D-08). Log only.
  console.error("[enrich-market] area", {
    analysisId,
    code: error instanceof Error ? error.message : "UNKNOWN",
  });
  area = null;
}
```
Copy this exact shape for the MACRO branch, deriving `lanCode` first:
```typescript
let macro: MacroData | null = null;
try {
  const lanCode = geo.kommunCode ? geo.kommunCode.slice(0, 2) : null;
  macro = await fetchMacroSnapshot(supabase, lanCode);
} catch (error) {
  console.error("[enrich-market] macro", {
    analysisId,
    code: error instanceof Error ? error.message : "UNKNOWN",
  });
  macro = null;
}
```
Place it after the AREA branch, before the terminal-status computation. GDPR logging discipline (line 47-49 doc comment): log only `analysisId` + error code, never coords/payloads — identical rule applies to the new branch.

**Terminal status / persist block** (lines 462-484) — extend the `.update({...})` object with `macro_data: macro` alongside `price_data`/`area_data`; per RESEARCH, macro's presence/absence should NOT gate `terminalStatus` (`priceUsable || areaUsable` stays the trigger — macro is best-effort, independently degrading to "ej tillgänglig" without affecting the done/failed decision, per the phase's "independent-degradation" binding constraint).

**Return type** — extend `EnrichMarketResult`'s `data` shape with `macro: MacroData | null`, mirroring `price`/`area`.

---

### `src/components/macro-context-card.tsx` (component, pure render)

**Analog:** `src/components/area-stats-card.tsx`

**Card shell + degrade-to-"Ej tillgänglig" MetricCard pattern** (lines 1-40, 125-150):
```typescript
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function MetricCard({ label, value, sublabel }: { label: string; value: string | null; sublabel?: string | null }) {
  return (
    <div className="rounded-lg bg-warm-gray-50 p-4">
      <p className="text-xs font-medium uppercase tracking-wider text-warm-gray-500">{label}</p>
      {value === null ? (
        <p className="mt-1 text-lg italic text-warm-gray-500">Ej tillganglig</p>
      ) : (
        <p className="mt-1 text-lg font-semibold text-warm-gray-900">{value}</p>
      )}
      {sublabel && value !== null && (
        <p className="mt-0.5 text-xs text-warm-gray-500">{sublabel}</p>
      )}
    </div>
  );
}
```
Reuse verbatim for the three macro metric tiles (policy rate, CPIF, regional price trend). Each independently renders "Ej tillganglig" per its own null value — never a combined all-or-nothing card (D-08 pattern extended, per RESEARCH's "independent-degradation" constraint).

**Source + period footer** (lines 180-183):
```typescript
<p className="text-xs text-warm-gray-500">
  Källa: SCB{footerYear ? ` · ${footerYear}` : ""}
  {source && source !== "SCB" ? ` (${source})` : ""}
</p>
```
Reuse this footer shape but with per-indicator source+period since macro has TWO sources (Riksbank + SCB) unlike area's single SCB source — e.g. "Källa: Riksbank, 2026-07-06 · SCB (KPIF), maj 2026 · SCB (BRF-pris, län), 2024".

**Card title / section framing** (lines 140-150) — reuse the `Card`/`CardHeader`/`CardTitle` shell but title it "Makroekonomisk kontext" (per RESEARCH structure diagram), with a sub-label stating the section is descriptive-only, e.g. "Aktuella nyckeltal — ingen prognos eller rekommendation." This sub-label doubles as a defensive UI-level disclaimer alongside the schema-level enforcement.

**CRITICAL anti-pattern (RESEARCH):** do NOT run macro values through `computeFlags` or any severity/band classifier (no color-coded judgment) — unlike `PriceComparisonCard`'s delta-based tone, macro renders number + label + source + period ONLY.

---

### `src/components/market-context-section.tsx` (modify — wire 3rd independent panel)

**Analog:** itself — existing AREA panel's independent-render ternary (lines 161-182).

**Independent-panel-with-fallback-card pattern** (lines 161-182):
```typescript
{area ? (
  <AreaStatsCard areaData={area} />
) : (
  <Card className="w-full max-w-2xl border-warm-gray-200">
    <CardHeader>
      <CardTitle className="text-2xl font-semibold text-warm-gray-900">
        Områdesstatistik
      </CardTitle>
    </CardHeader>
    <CardContent>
      <div className="rounded-lg bg-warm-gray-50 p-4">
        <p className="text-base font-medium text-warm-gray-700">
          Områdesstatistik ej tillgänglig
        </p>
        <p className="mt-1 text-sm text-warm-gray-500">
          Vi kunde inte hämta SCB-data för det här området just nu.
        </p>
      </div>
    </CardContent>
  </Card>
)}
```
Add a third block after the AREA panel, following the identical structure, swapping in `macro`/`MacroContextCard`/"Makroekonomisk kontext ej tillgänglig". Also extend props (`macroData: MacroData | null`), local `useState` seeding (line 77 pattern: `const [macro, setMacro] = useState<MacroData | null>(macroData)`), and the `triggerEnrich` success branch (line 93-95: `setMacro(result.data.macro)`).

---

### `src/lib/report/fact-sheet.ts` (modify — add `macro` slot)

**Analog:** itself — the existing `slot()` wrapper + `FactSheetInput`/bundle shape.

**Explicit-absence slot wrapper** (lines 26-51):
```typescript
type SourceSlot<T> =
  | { status: "tillgänglig"; data: T }
  | { status: "ej_tillgänglig" };

function slot<T>(value: T | null): SourceSlot<T> {
  return value === null || value === undefined
    ? { status: "ej_tillgänglig" }
    : { status: "tillgänglig", data: value };
}
```
Extend `FactSheetInput` with `macro: unknown | null` and the bundle object (lines 84-91) with `macro: slot(input.macro)`, keeping the alphabetically-sorted key-order convention (`area, brf, flags, listing, macro, price, softSignals` — note `sortKeysDeep` re-sorts anyway, but the literal object should stay readable/alphabetical per existing style).

---

### `src/lib/report/prompt.ts` (modify — add ABSOLUT REGEL 5)

**Analog:** itself — the existing REGEL 1-4 block (lines 26-32).

**Hard-rule framing pattern**:
```
ABSOLUT REGEL 1 — INGEN VÄRDERING ELLER KÖP/SÄLJ-RÅD: ...
ABSOLUT REGEL 2 — HITTA ALDRIG PÅ EN FLAGGA: ...
ABSOLUT REGEL 3 — VARJE PÅSTÅENDE MÅSTE CITERA EN DATAPUNKT: ...
ABSOLUT REGEL 4 — VAR ÄRLIG OM SAKNAD DATA: ...
```
Append a 5th rule in the identical `ABSOLUT REGEL N — TITEL:` format, e.g.:
```
ABSOLUT REGEL 5 — MAKRODATA ÄR ENDAST BESKRIVANDE: Makrouppgifterna (styrränta, inflation, regional prisutveckling) i faktaunderlagets `macro`-fält är ENDAST beskrivande nyckeltal — de är ALDRIG en signal, prognos eller rekommendation. Du får citera dem (t.ex. "styrräntan är 1,75 %, Riksbank, 2026-07-06") men ALDRIG dra en slutsats av dem om vart priser eller räntor "är på väg" eller vad de "betyder för" köpbeslutet. Koppla dem ALDRIG till ett köp/sälj-råd (se REGEL 1).
```
**Bump the version constant** (`REPORT_SYNTHESIS_PROMPT_VERSION`, line 22) per the file's own doc comment ("prompt changes MUST bump it") — e.g. `"report-synth/v2 (2026-07-06)"`.

---

### `src/lib/report/banned-predictive-phrases.test.ts` (new test, string-scan)

**No direct analog** — new pattern per RESEARCH's "Don't Hand-Roll" table (deterministic regex scan, not an LLM judge). Structure as a plain Vitest file:
```typescript
import { describe, it, expect } from "vitest";

const BANNED_PHRASES = [
  "kommer att", "förväntas stiga", "förväntas sjunka", "väntas",
  "bra läge att köpa", "bra läge att sälja", "priserna kommer",
  // English equivalents for hardcoded UI strings, if any
];

describe("banned predictive phrases", () => {
  it("prompt.ts contains no banned phrase outside the explicit examples/forbidden markers", () => {
    // scan REPORT_SYNTHESIS_SYSTEM_PROMPT excluding the "FÖRBJUDET"-labeled example block
  });
  it("macro-context-card static labels contain no banned phrase", () => {
    // scan hardcoded Swedish UI strings in macro-context-card.tsx
  });
});
```
Co-locate the banned-phrase list as a shared const (RESEARCH Wave 0 Gap) so both `prompt.ts`'s negative constraint and this test's list stay reviewable together — consider exporting the list from a small shared module (e.g. `src/lib/report/banned-phrases.ts`) rather than duplicating the array.

---

### `supabase/migrations/006_macro_snapshots.sql` (new table + NEW RLS policy)

**Analog:** `supabase/migrations/003_market_context.sql` (structural/comment style) — **RLS approach is NOT reusable**, see Pitfall below.

**Verbose migration-comment + additive-only style** (003, lines 1-8, 38-42):
```sql
-- Market-context persistence layer.
-- Adds market_* / *_data columns to analyses. Additive only: the new columns
-- are covered by the EXISTING per-user RLS (SELECT from 001_analyses.sql,
-- UPDATE from 002_brf.sql), so this migration defines NO new RLS policy.
...
alter table public.analyses add column if not exists price_data jsonb;
```
Reuse the verbose top-of-file comment convention and `if not exists`/`if not exists` idempotency style, but this migration creates a NEW TABLE, not new columns on `analyses` — copy `005_report_lock.sql`'s "why this migration is separate/additive" framing (lines 1-6) for the intro paragraph, then diverge sharply for RLS:

**CRITICAL DEVIATION — explicit RLS policy required** (RESEARCH Pitfall 2): every prior migration (003, 004, 005) explicitly states "NO new RLS policy — covered by existing per-user policy." `macro_snapshots` is NOT user-owned (no `user_id` column — it's a shared cross-user cache), so RLS-enabled-with-no-policy = total lockout. Per RESEARCH's Assumption A4 recommendation, use:
```sql
-- macro_snapshots: a NEW SHARED (non-owner-scoped) cache table — UNLIKE every
-- prior migration in this project, this table has NO user_id and therefore
-- CANNOT rely on the existing per-user RLS policies (001/002). If RLS is
-- enabled with no explicit policy, Postgres default-denies ALL access and the
-- macro branch would silently fail every read/write (see 07-RESEARCH.md
-- Pitfall 2). This data is non-sensitive, publicly-sourced macro statistics
-- (Riksbank/SCB) — there is no confidentiality reason to restrict it beyond
-- "must be an authenticated app user."
create table if not exists public.macro_snapshots (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  region_code text not null,
  payload jsonb not null,
  fetched_at timestamptz not null default now(),
  unique (scope, region_code)
);

alter table public.macro_snapshots enable row level security;

create policy "Authenticated users can read macro snapshots"
  on public.macro_snapshots for select
  using (auth.uid() is not null);

create policy "Authenticated users can upsert macro snapshots"
  on public.macro_snapshots for insert
  with check (auth.uid() is not null);

create policy "Authenticated users can update macro snapshots"
  on public.macro_snapshots for update
  using (auth.uid() is not null);
```
Flag for planner confirmation: RESEARCH's Assumption A4 notes this "any authenticated user" policy is a genuine new pattern (first shared/non-owner-scoped table in the project), not just an extension of existing conventions — worth a one-line callout in the plan for user awareness, though it does not block implementation.

## Shared Patterns

### Independent-Branch Degradation (D-08 house style)
**Source:** `src/actions/enrich-market-context.ts` lines 360-460 (PRICE + AREA branches)
**Apply to:** the new MACRO branch in the same file, and `MacroContextCard`'s per-metric render (each of policy rate / CPIF / regional price independently null → "Ej tillgänglig", never blanking the other two or the price/area panels).

### No-Prediction Schema-Shape Enforcement (D-04/FM2 pattern)
**Source:** `src/lib/schemas/report.ts` lines 5-12, 59-60 (no verdict field can exist)
**Apply to:** `macro-schema.ts` (no direction/trend/magnitude field), `MacroContextCard` (no band/severity classifier, no `computeFlags` reuse), `prompt.ts` (new ABSOLUT REGEL 5), and the new `banned-predictive-phrases.test.ts` — four independent layers per RESEARCH's Security section threat table.

### Explicit-Absence Slot Wrapper (D-07)
**Source:** `src/lib/report/fact-sheet.ts` lines 26-51 (`SourceSlot<T>` + `slot()`)
**Apply to:** the new `macro` key in `FactSheetInput`/`assembleFactSheet` — identical wrapper, no new type needed.

### GDPR-Safe Error Logging
**Source:** `src/actions/enrich-market-context.ts` lines 47-49 (doc comment) + lines 427-430, 454-457 (call sites)
**Apply to:** all macro fetch failure paths — log only `analysisId` + `error.message`/code, never coords, payloads, or raw API responses.

### Whitelisted-Table + Server-Derived-Region SSRF Mitigation (T-03-06)
**Source:** `src/lib/market/scb.ts` lines 39-75 (`SCB_TABLES` const)
**Apply to:** `macro.ts`'s three SCB table configs — region codes (län `01`-`25`) must be validated against a fixed allowlist derived server-side from `resolveGeo()`, never accepted as free-text/client input.

## No Analog Found

None — every file has at least a role-match analog. The two genuinely novel elements (read-through cache with TTL in `macro.ts`, and the non-owner-scoped RLS policy in `006_macro_snapshots.sql`) have reference implementations directly from RESEARCH.md rather than a codebase analog; both are called out explicitly above.

## Metadata

**Analog search scope:** `src/lib/market/`, `src/actions/`, `src/components/`, `src/lib/report/`, `src/lib/schemas/`, `supabase/migrations/`
**Files scanned:** `scb.ts`, `scb-schema.ts`, `geo.ts`, `enrich-market-context.ts`, `area-stats-card.tsx`, `market-context-section.tsx`, `fact-sheet.ts`, `prompt.ts`, `report.ts`, `003_market_context.sql`, `005_report_lock.sql`
**Pattern extraction date:** 2026-07-06
