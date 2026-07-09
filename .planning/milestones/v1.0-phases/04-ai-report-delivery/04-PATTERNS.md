# Phase 4: AI Report + Delivery - Pattern Map

**Mapped:** 2026-06-23
**Files analyzed:** 13 new/modified
**Analogs found:** 12 / 13 (one new pattern — the PDF component tree — has no in-repo analog)

> AI layer locked by `04-AI-SPEC.md`; PDF mechanism + flags + persistence resolved by `04-RESEARCH.md`. This map binds each new/modified file to a concrete existing analog with copyable excerpts. Where AI-SPEC already gives verbatim code (synthesize.ts, report.ts, soft-signal fields), the planner should copy from AI-SPEC §3/§4b and use the analogs below only for *conventions* (error codes, logging, cost, persistence).

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/lib/report/synthesize.ts` | service (AI call) | request-response | `src/lib/brf/extract.ts` | exact (same SDK `messages.parse` + `zodOutputFormat` + coded-error pipeline) |
| `src/lib/report/prompt.ts` | config (versioned prompt) | — | `src/lib/brf/prompt.ts` | exact |
| `src/lib/report/flags.ts` | service (deterministic) | transform | `src/lib/brf/score.ts` (+ `src/lib/market/compare.ts`) | exact (pure-TS, threshold-const, null-tolerant) |
| `src/lib/report/fact-sheet.ts` | utility (assembler) | transform | `src/lib/brf/score.ts` `computeBrfGrade` (pure, stable shape) | role-match |
| `src/lib/report/pdf/report-document.tsx` | component (PDF tree) | transform | — | **NO ANALOG** (new `@react-pdf/renderer` pattern) |
| `src/lib/report/pdf/fonts.ts` | config (font register) | file-I/O | `next.config.ts` outputFileTracingIncludes (geojson) | partial (same fs-asset-tracing concern) |
| `src/lib/report/pdf/render.ts` | service (render) | transform | — | **NO ANALOG** (new render-to-buffer) |
| `src/lib/schemas/report.ts` | model (Zod schema + read guard) | — | `src/lib/schemas/brf.ts` (`safeParseBrfData`) | exact |
| `src/lib/schemas/brf.ts` (EXTEND) | model | — | itself (`extractedField` factory) | exact (extend in place) |
| `src/lib/brf/extract.ts` + `prompt.ts` (EXTEND) | service + config | request-response | itself | exact (extend in place; bump version) |
| `src/actions/generate-report.ts` | controller (server action) | request-response | `src/actions/analyze-brf.ts` (+ `enrich-market-context.ts`) | exact |
| `src/actions/download-report-pdf.ts` | controller (server action) | streaming (binary) | `src/actions/analyze-brf.ts` (auth/ownership guard only) | role-match (binary return is new) |
| `src/lib/brf/cost.ts` (EXTEND) | utility | — | itself (`USD_PER_MTOK`/`costSek`) | exact (add Sonnet rates) |
| `supabase/migrations/004_report.sql` | migration | — | `supabase/migrations/003_market_context.sql` | exact |
| `src/app/(app)/analysis/[id]/page.tsx` (MODIFY) | route (RSC) | request-response | itself (safeParse discipline) | exact |
| `src/components/ai-report-section.tsx` + `report-flags.tsx` | component | request-response | `src/components/brf-score-card.tsx`, `market-context-section.tsx` | role-match |

## Pattern Assignments

### `src/lib/report/synthesize.ts` (service, request-response)

**Analog:** `src/lib/brf/extract.ts`. **Verbatim entry-point code:** `04-AI-SPEC.md §3`. Use the analog for the *conventions* below — they are not in the AI-SPEC snippet.

**Module-scope server-only client + bare model id** (`extract.ts:18-21`):
```typescript
// Anthropic client instantiated ONLY in this server module; reads ANTHROPIC_API_KEY,
// never browser-configured (T-02-09).
const client = new Anthropic();
const MODEL = "claude-sonnet-4-6"; // bare id, NO date suffix (AI-SPEC §4 note)
```
> Note: `extract.ts` uses `client.beta.messages.parse` (it needs the Files API beta). Synthesis has no document/Files-API need → plain `client.messages.parse` (AI-SPEC §3 note).

**stop_reason branching BEFORE parsed_output** (`extract.ts:174-191`) — copy exactly, same codes:
```typescript
let message = await runOnce();
if (message.stop_reason === "refusal") throw new Error("CLAUDE_REFUSAL"); // NO retry
if (message.stop_reason === "max_tokens") {
  message = await runOnce();                                              // retry once
  if (message.stop_reason === "max_tokens") throw new Error("CLAUDE_MAX_TOKENS");
}
if (!message.parsed_output) throw new Error("CLAUDE_PARSE_EMPTY");
```

**Coded-error + GDPR-safe logging** (`extract.ts:200-225`) — log only `{ analysisId, code }`, NEVER the factSheet (financials). Mirror the `KNOWN_*_CODES` set + `isKnown*` guard + rethrow `new Error(code, { cause })`.

**usage → ClaudeUsage mapping** (`extract.ts:57-70`) — copy `toClaudeUsage` (defaults cache fields to 0).

---

### `src/lib/report/prompt.ts` (config)

**Analog:** `src/lib/brf/prompt.ts` (verbatim structure).

**Versioned tag + doc-comment discipline** (`prompt.ts:20-23`):
```typescript
/** Bump on every prompt change; ties eval runs to a reviewable revision. */
export const REPORT_SYNTHESIS_PROMPT_VERSION = "report-synth/v1 (2026-06-23)";
export const REPORT_SYNTHESIS_SYSTEM_PROMPT = `Du är ...`;
```
Carry the same hard-rule framing the BRF prompt uses ("ABSOLUT REGEL: ... ALDRIG betyg/rekommendation") — for synthesis the analogous rule is: narrate/prioritize flags, never originate a flag, never a köp/sälj-verdict (AI-SPEC §6 FM2/FM3, D-04).

---

### `src/lib/report/flags.ts` (service, transform — deterministic, NO LLM)

**Analog:** `src/lib/brf/score.ts` (pure-function + single threshold const) and `src/lib/market/compare.ts` (nullable honest result, reason discriminator).

**REUSE existing thresholds — do not redefine** (`score.ts:25-57`, `compare.ts:32-61`). Per RESEARCH §Deterministic Flag Computation:

| Flag | Source field (persisted) | Threshold (import, don't redefine) |
|------|--------------------------|-------------------------------------|
| High BRF debt | `brf_data.normalized.skuldPerKvm` | `BRF_SCORE_THRESHOLDS.skuldPerKvm.weakMax` (12000) — `>` = red |
| Avgift level | `brf_data.normalized.avgiftsniva` | `BRF_SCORE_THRESHOLDS.avgiftsniva` healthy 450–750 |
| Weak kassaflöde | `brf_data.normalized.kassaflode` | `BRF_SCORE_THRESHOLDS.kassaflode.warningMin` (120); `<0` deficit |
| Unusual pricing | `price_data.deltaPct` | `PriceComparison` — only when `reason === "ok"`; gate on `sampleSize` (compare.ts thinMaxComps) |

**Pure-function + null-tolerant contract** (`score.ts:147-162`): no `Date`/`Math.random`/network; a null source value produces NO flag (never a fabricated "missing = bad"), mirroring `computeBrfGrade`'s null handling and compare.ts GUARD ordering (`compare.ts:242-275`).

**Honest-state discriminator shape** (`compare.ts:72-98`): each flag carries `{ id, severity: "red"|"green"|"neutral", sourceRef }` so the fact sheet references it by id and the on-screen + PDF flag read the same record.

**Soft-signal raise split (D-03, RESEARCH recommendation):** `stambytePlanerat` enum → deterministic flag in code; `storreRenoveringar`/`ovrigaAnmarkningar` free-text → passed as cited context, narrated by Claude, never a code-minted boolean flag. A low/null-confidence soft signal must not feed a red flag (AI-SPEC §6 citation gate).

---

### `src/lib/report/fact-sheet.ts` (utility, transform)

**Analog:** the pure-assembly discipline of `score.ts` `computeBrfGrade`. Combine the four `safeParse`d sources + flags + soft signals into ONE **stable-key-order** JSON string (AI-SPEC §4 step 2, prompt-cache hygiene §4b.4). Mark each missing source explicitly (`brf: { status: "ej_tillgänglig" }`) so D-07 partial-awareness is in the input, not inferred by the model.

---

### `src/lib/report/pdf/report-document.tsx` (component, PDF tree) — **NO IN-REPO ANALOG**

**This is a new pattern.** No `@react-pdf/renderer` usage exists anywhere in the repo. The planner must build it from RESEARCH §Pattern 1/§Structure, not by copying an analog. Key constraints from RESEARCH:
- `<Document>/<Page>/<View>/<Text>` tree; same section ordering + voice as the on-screen render (D-11 single source of truth).
- Consumes the SAME persisted `report_data` + flags the page renders — never re-fetch, never re-synthesize (RESEARCH Anti-Pattern).
- Carry the D-12 trust treatment (disclaimer, source/freshness labels, "Osäker/Ej tillgänglig").
- The only *style* analog is the warm sage/terracotta palette and Swedish-label conventions visible in `brf-score-card.tsx:58-67` (`gradeColors`) and `METRIC_META` (`brf-score-card.tsx:33-49`) — reuse the label/colour vocabulary, not the JSX.

### `src/lib/report/pdf/fonts.ts` (config, file-I/O)

**Analog:** the fs-asset-tracing concern in `next.config.ts:13-15` (geojson). RESEARCH Pitfall 2: a `Font.register()` TTF read via `fs` must be added to `outputFileTracingIncludes` or `next build` drops it. Register before render (RESEARCH §Pattern 2). Embed a TTF with full Latin-Extended (å/ä/ö) — do not trust AFM Helvetica.

```typescript
// next.config.ts — EXTEND the existing outputFileTracingIncludes (currently geojson only):
outputFileTracingIncludes: {
  "/**": ["./src/data/deso.geojson", "./src/lib/report/pdf/fonts/*.ttf"],
},
```

### `src/lib/report/pdf/render.ts` (service) — **NO IN-REPO ANALOG**

New. `renderToBuffer(<ReportDocument data />)` server-side (RESEARCH §Pattern 1). Confirm `serverExternalPackages` need against the actual `next build` (RESEARCH Pitfall 4 / A1 — start WITHOUT adding react-pdf to it).

---

### `src/lib/schemas/report.ts` (model + read guard)

**Analog:** `src/lib/schemas/brf.ts`. **Verbatim schema:** `04-AI-SPEC.md §4b` (`reportSchema`, `citedClaim`, `themedSection`). No verdict/recommendation field; flags by id only; every field `.nullable()` never `.optional()`.

**Read-path guard pattern** (`brf.ts:135-169`) — copy `safeParseBrfData` shape exactly:
```typescript
export function safeParseReportData(input: unknown): z.infer<typeof reportDataSchema> | null {
  if (!input || typeof input !== "object") return null;
  const parsed = reportDataSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
```
`reportDataSchema` wraps the persisted snapshot (the `AiReport` + flags + softSignals + fingerprint), validated loosely for our own-code fields the same way `brfDataSchema` validates grade/breakdown loosely (`brf.ts:135-157`).

### `src/lib/schemas/brf.ts` (EXTEND) + `src/lib/brf/prompt.ts` (EXTEND)

**Extend in place.** Add three soft-signal fields via the existing `extractedField` factory (`brf.ts:16-36`) — verbatim from `04-AI-SPEC.md §4b`:
```typescript
stambytePlanerat: extractedField(z.enum(["planerat","nyligen_genomfort","ej_nämnt"]))...
storreRenoveringar: extractedField(z.string())...
ovrigaAnmarkningar: extractedField(z.string())...
```
Each gets `{value, confidence, sourceQuote, pageRef}` for free. Also extend `brfDataSchema` (`brf.ts:135-157`) and `normalizeBrfExtraction` (`brf.ts:179-193`) so the read/persist shape stays validated. **BUMP** `BRF_EXTRACTION_PROMPT_VERSION` (`prompt.ts:21`, currently `"brf-extract/v1 (2026-06-07)"`) and add soft-signal instructions to the system prompt. Cross-phase: re-run the full Phase 2 extraction eval (RESEARCH §Cross-phase impact; watch Haiku `max_tokens`).

---

### `src/actions/generate-report.ts` (controller, server action)

**Analog:** `src/actions/analyze-brf.ts` (spine) + `enrich-market-context.ts` (independent-degrade + status writes). **Skeleton:** `04-AI-SPEC.md §4`.

**Auth + ownership guard** (`analyze-brf.ts:174-193`, identical posture in `enrich-market-context.ts:298-316`):
```typescript
const supabase = await createClient();
const { data: { user } } = await supabase.auth.getUser();
if (!user) return { ok: false, error: "Logga in för AI-rapport" };   // D-09
const { data: row, error: rowError } = await supabase
  .from("analyses").select("id, user_id, ...").eq("id", analysisId).single();
if (rowError || !row || row.user_id !== user.id) return { ok: false, error: "Analysen hittades inte." };
```

**In-flight lock + status writes** (`enrich-market-context.ts:318-322`, `analyze-brf.ts:227-230`): set `report_status = 'generating'` before the Sonnet call (RESEARCH Pitfall 5 — no double-spend), terminal `'done'`/`'failed'` after. Mirror `writeFailedStatus` (`analyze-brf.ts:82-100`).

**safeParse the four sources before assembling** — same discipline as `enrich-market-context.ts:326-329` (`listingDataSchema.safeParse(...).success ? ... : null`).

**Cost guard (post-call, persistence gate)** (`analyze-brf.ts:238-256`) — RESEARCH Pitfall 3: compute Sonnet cost with **Sonnet rates**, not Haiku. The `COST_CAP_SEK = 5` + `if (cost > CAP) writeFailedStatus(...)` pattern is reused verbatim; only the rate constant changes (see cost.ts extension).

**Data fingerprint for D-08 staleness** — `createHash("sha256")` over stable-key-ordered fact-sheet inputs; `analyze-brf.ts:3,67-69` already imports `node:crypto createHash`. Persist `report_data_fingerprint`; the page compares current-vs-stored.

**Persist** (`analyze-brf.ts:303-312` / `enrich-market-context.ts:461-470`): single `.update({...}).eq("id", analysisId)` writing `report_data`, `report_status`, `report_cost_sek`, `report_data_fingerprint`, `report_prompt_version`.

### `src/actions/download-report-pdf.ts` (controller, streaming binary)

**Analog:** the auth/ownership guard from `analyze-brf.ts:174-193` only. The binary return is new (RESEARCH §Pattern 1): load persisted `report_data` (NO re-synthesis/re-fetch), `renderReportPdf(...)`, return `new Blob([buffer], { type: "application/pdf" })`. Fallback to a Route Handler if the action Blob return is awkward in Next 16 (RESEARCH Open Q2 / A2).

### `src/lib/brf/cost.ts` (EXTEND)

**Extend in place.** Add Sonnet rates alongside the Haiku `USD_PER_MTOK` (`cost.ts:7-12`) and a Sonnet-rated cost path (RESEARCH Pitfall 3). Keep the `ClaudeUsage` shape (`cost.ts:21-29`) and the `costSek` arithmetic (`cost.ts:45-57`) unchanged; either add `SONNET_USD_PER_MTOK` ($3/$15) + a thin `costSekSonnet`, or parameterize `costSek(usage, rates)`.

---

### `supabase/migrations/004_report.sql` (migration)

**Analog:** `supabase/migrations/003_market_context.sql` (additive, idempotent, NO new RLS). **Verbatim columns:** `04-RESEARCH.md §analyses Table Change`:
```sql
alter table public.analyses add column if not exists report_data jsonb;
alter table public.analyses add column if not exists report_status text;
alter table public.analyses add column if not exists report_cost_sek numeric;
alter table public.analyses add column if not exists report_data_fingerprint text;
alter table public.analyses add column if not exists report_prompt_version text;
```
**Do NOT re-declare any RLS policy** — existing SELECT (001) + UPDATE (002) cover new columns; re-declaring errors (the explicit precedent comment is `003_market_context.sql:1-8`). Migration push is human-gated.

---

### `src/app/(app)/analysis/[id]/page.tsx` (MODIFY, RSC)

**Analog:** itself. The `select("*")` already loads the new columns. Add `safeParseReportData(analysis.report_data)` next to the existing guards (`page.tsx:49-54`) — same CR-01 discipline; null → "not generated yet". **Replace** `<ComingSoonSection title="AI Rapport" />` (`page.tsx:86`) with the new `<AiReportSection>`. Per D-00 the summary anchors as lead/capstone; recompute the current-input fingerprint here to drive the D-08 stale marker. Also remove the home-page placeholder `src/app/page.tsx:54` (per CONTEXT phase boundary).

### `src/components/ai-report-section.tsx` + `report-flags.tsx` (component)

**Analog:** `src/components/brf-score-card.tsx` (Card + Badge + warm-palette + confidence treatment) and `market-context-section.tsx` (section wrapper, status-driven affordance). Reuse:
- `gradeColors` colour vocabulary (`brf-score-card.tsx:58-67`): A/B sage, C/D terracotta, E/F red — map red/green flag severity onto the same sage/terracotta language (D-00).
- The `"use client" + useState/useTransition + server-action` trigger pattern (`brf-score-card.tsx:1-13`) for the "Generera AI-rapport"/"Ladda ner PDF"/regenerate buttons (manual trigger D-07, debounce/in-flight lock).
- `cn`, `formatSEK` from `@/lib/utils` (`brf-score-card.tsx:22`).

## Shared Patterns

### Authentication / Ownership
**Source:** `src/actions/analyze-brf.ts:174-193` (mirrored in `enrich-market-context.ts:298-316`).
**Apply to:** `generate-report.ts`, `download-report-pdf.ts`.
`getUser()` → `!user` Swedish login message (D-09) → ownership `row.user_id === user.id` (second layer behind RLS). No guest path.

### GDPR-safe logging
**Source:** `extract.ts:201-206`, `analyze-brf.ts:272-276`.
**Apply to:** all new actions + `synthesize.ts`.
Log only `{ analysisId, code }` (or `contentHash, code`) — NEVER the fact sheet, financials, comps, or report prose (AI-SPEC §7).

### Coded-error pipeline
**Source:** `extract.ts:215-225` (`KNOWN_*_CODES` set, `isKnown*`, rethrow `new Error(code, { cause })`).
**Apply to:** `synthesize.ts`. Codes: `CLAUDE_REFUSAL` / `CLAUDE_MAX_TOKENS` / `CLAUDE_PARSE_EMPTY` / `CLAUDE_CALL_FAILED`. User-facing Swedish message produced at the action layer, not in the lib.

### Read-path safeParse guard (CR-01)
**Source:** `brf.ts:165-169` `safeParseBrfData`; consumed at `page.tsx:49-54`.
**Apply to:** `report.ts` `safeParseReportData`, the page. Drift/malformed → null → degrade, never white-screen.

### Cost guard (post-call persistence gate)
**Source:** `analyze-brf.ts:18-19,238-256`; `cost.ts:45-57`.
**Apply to:** `generate-report.ts`. `COST_CAP_SEK = 5`; over-cap → `writeFailedStatus` + Swedish abort message. NOT a pre-call cap (honest scope, CR-02). Use Sonnet rates.

### Additive migration, no new RLS
**Source:** `003_market_context.sql:1-8`.
**Apply to:** `004_report.sql`. Idempotent `add column if not exists`; existing SELECT/UPDATE policies cover new columns; human-gated push.

### Prompt-versioning + eval re-run
**Source:** `prompt.ts:20-21`.
**Apply to:** NEW `REPORT_SYNTHESIS_PROMPT_VERSION` and BUMPED `BRF_EXTRACTION_PROMPT_VERSION`. Each change bumps its tag + re-runs its promptfoo set; the extraction change additionally re-runs the full Phase 2 eval (cross-phase schema/migration).

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src/lib/report/pdf/report-document.tsx` | component (PDF tree) | transform | No `@react-pdf/renderer` usage exists in the repo. New pattern — build from RESEARCH §Pattern 1/§Structure; reuse only the warm-palette/label vocabulary from `brf-score-card.tsx`. |
| `src/lib/report/pdf/render.ts` | service | transform | `renderToBuffer` server-side render is new. RESEARCH §Pattern 1. |
| `src/actions/download-report-pdf.ts` (binary return) | controller | streaming | Auth guard has an analog (analyze-brf.ts); returning a Blob from a server action is new (RESEARCH §Pattern 1 / A2). |

## Metadata

**Analog search scope:** `src/lib/brf/`, `src/lib/market/`, `src/lib/schemas/`, `src/actions/`, `src/components/`, `src/app/(app)/analysis/`, `supabase/migrations/`, `next.config.ts`.
**Files read in depth:** extract.ts, cost.ts, analyze-brf.ts, prompt.ts (brf), schemas/brf.ts, score.ts, 003_market_context.sql, compare.ts, enrich-market-context.ts, analysis page.tsx, brf-score-card.tsx, next.config.ts.
**Pattern extraction date:** 2026-06-23
