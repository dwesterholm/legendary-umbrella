# Phase 2: BRF Financial Analysis - Pattern Map

**Mapped:** 2026-06-07
**Files analyzed:** 16 (new + modified)
**Analogs found:** 13 / 16 (3 net-new with no analog)

> File list derived from AI-SPEC §3 (project structure), RESEARCH "Recommended Project Structure", and CONTEXT decisions D-04..D-14. Conventions: Swedish UI / English code; `zod/v4` import path; `@/...` path alias; warm palette (sage/terracotta/warm-gray); ASCII-only Swedish strings in existing files (e.g. "lank", "man", "tillganglig") — match the existing files' degraded-diacritics style when editing them, but new strings may use proper diacritics (planner's call — be consistent within a file).

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/actions/analyze-brf.ts` | action (server) | request-response + file-I/O | `src/actions/analyze.ts` | exact |
| `src/lib/brf/extract.ts` | service (LLM call) | request-response | `src/lib/apify/booli-scraper.ts` | role-match (external-service client) |
| `src/lib/brf/prompt.ts` | config (versioned prompt) | — | none (no prompt const exists) | no analog |
| `src/lib/brf/score.ts` | utility (pure fn) | transform | `src/lib/utils.ts` (`calculatePrisPerKvm`) | role-match (pure deterministic fn) |
| `src/lib/brf/sanity.ts` | utility (pure fn) | transform | `src/lib/utils.ts` | role-match |
| `src/lib/brf/cost.ts` | utility (pure fn) | transform | `src/lib/utils.ts` | role-match |
| `src/lib/schemas/brf.ts` | schema + normalizer | transform | `src/lib/schemas/listing.ts` | exact |
| `src/lib/supabase/storage.ts` (helper) | service (storage client) | file-I/O | `src/lib/supabase/server.ts` | role-match |
| `src/components/brf-section.tsx` | component (container) | request-response | `src/app/(app)/analysis/[id]/page.tsx` + `listing-summary.tsx` | role-match |
| `src/components/brf-upload.tsx` | component (form/client) | file-I/O | `src/components/url-input.tsx` | exact (client form -> server action) |
| `src/components/brf-score-card.tsx` | component (display) | request-response | `src/components/listing-summary.tsx` (MetricCard) | exact |
| `src/components/brf-progress.tsx` | component (poll/display) | event-driven (poll) | `src/components/listing-skeleton.tsx` | role-match (visual) |
| `src/app/(app)/analysis/[id]/page.tsx` | route (page) | request-response | itself (EXISTING — swap ComingSoonSection) | exact (in-place edit) |
| `src/app/(app)/sa-raknar-vi/page.tsx` | route (public page) | request-response | `src/app/(app)/analysis/[id]/page.tsx` | role-match |
| `supabase/migrations/002_brf.sql` | migration | — | `supabase/migrations/001_analyses.sql` | exact |
| `evals/` + `vitest.config.ts` (Wave 0) | test harness | — | none (no test infra yet) | no analog |

---

## Pattern Assignments

### `src/actions/analyze-brf.ts` (server action, request-response + file-I/O)

**Analog:** `src/actions/analyze.ts`

This is the spine. `analyzeUrl` is the exact template: `"use server"` -> auth gate -> call external service -> normalize -> compute -> persist. Differences for BRF: auth is a HARD gate (D-05, not the guest-cookie allowance), input is a `File` not a URL, the external call is Claude not Apify, and it writes a status column for D-13.

**Directive header + imports** (lines 1-12) — copy the `"use server"` + `@/...` import style:
```typescript
"use server";
import { createClient } from "@/lib/supabase/server";
// BRF additions:
import { extractBrfFinancials } from "@/lib/brf/extract";
import { normalizeBrfExtraction } from "@/lib/schemas/brf";
import { applySanityChecks } from "@/lib/brf/sanity";
import { computeBrfGrade } from "@/lib/brf/score";
```

**Discriminated-union return type** (lines 14-17) — mirror this exact shape for the BRF result (success | partial | error), so the client can `if (result.error)` like `url-input.tsx` does:
```typescript
export type AnalyzeResult =
  | { data: ListingData; partial: false; ... }
  | { data: ListingData; partial: true; missingFields: string[]; ... }
  | { error: string; ... };
```

**Auth gate** (lines 28-41) — REPLACE the guest-cookie branch with a hard block (D-05):
```typescript
const supabase = await createClient();
const { data: { user } } = await supabase.auth.getUser();
// analyze.ts allows a guest cookie here; BRF does NOT:
if (!user) return { error: "Logga in for BRF-analys" }; // D-05 hard gate
```

**External-service call wrapped in try/catch -> user-facing Swedish error** (lines 44-50) — copy this exact error-mapping discipline for the Claude call (log real error server-side, return a friendly Swedish string):
```typescript
let rawData: Record<string, unknown>;
try {
  rawData = await scrapeBooli(url);
} catch (error) {
  console.error("[analyze] scrapeBooli failed:", error);
  return { error: "Kunde inte hamta data fran Booli. Forsok igen." };
}
```

**Normalize -> derive -> persist** (lines 55-111) — the `parsed = schema.safeParse` then `normalize(...)` then build the typed object then `supabase.from("analyses").insert({...}).select().single()` flow is the template. For BRF: insert/update the BRF columns on the existing row (`.update().eq("id", analysisId)`) rather than a fresh insert, and write `brf_status` at each step (`reading` -> `extracting` -> `scoring` -> `done`).

> **Caution (do NOT inherit):** `analyze.ts` calls `redirect(...)` inside `try` and the client swallows the thrown `NEXT_REDIRECT` (see `url-input.tsx` lines 38-45). BRF stays on the same page (D-04) — no redirect. Use status-column + client poll instead.

---

### `src/lib/brf/extract.ts` (service: the single Anthropic call, request-response)

**Analog (structural):** `src/lib/apify/booli-scraper.ts` — the "instantiate a vendor client at module scope from a server-only env token, expose one async fn, try/catch -> log + descriptive throw" pattern. Claude shape itself comes from AI-SPEC §3 / RESEARCH (not in the codebase yet — first Claude integration).

**Module-scope client from server-only env** (booli-scraper lines 1-5) — mirror exactly, swapping token:
```typescript
import { ApifyClient } from "apify-client";
const client = new ApifyClient({ token: process.env.APIFY_API_TOKEN! });
```
BRF equivalent: `const client = new Anthropic();` (reads `ANTHROPIC_API_KEY`, server-only — never `NEXT_PUBLIC_`, never `dangerouslyAllowBrowser`; RESEARCH Pitfall 6 / AI-SPEC pitfall 1).

**try/catch -> server log + descriptive throw** (booli-scraper lines 35-44) — same discipline for refusal/truncation:
```typescript
} catch (error) {
  console.error("[booli-scraper]", error);
  ...
  throw new Error("Kunde inte hamta data ...");
}
```
BRF additions (AI-SPEC §3 + RESEARCH Code Examples): `messages.parse({ model: "claude-haiku-4-5", max_tokens: 2048, temperature: 0, system: BRF_EXTRACTION_SYSTEM_PROMPT, messages: [{ role: "user", content: [document block with citations.enabled + cache_control.ephemeral, text instruction] }], output_config: { format: zodOutputFormat(brfExtractionSchema) } })`. Check `message.stop_reason === "refusal"` -> throw, NO retry. Return `{ parsed: message.parsed_output, usage: message.usage }`. Files API transport for PDFs >~5 MB (RESEARCH Pitfall 1).

> **next.config.ts note:** `serverExternalPackages: ["apify-client"]` already exists. Add `@anthropic-ai/sdk` only if Turbopack trips on it (RESEARCH bundling note — verify, may not be needed).

---

### `src/lib/schemas/brf.ts` (schema + null-tolerant normalizer, transform)

**Analog:** `src/lib/schemas/listing.ts` — EXACT pattern. `listing.ts` has: a raw external schema (`scraperOutputSchema`, `.passthrough()`), an internal model schema (`listingDataSchema`), exported `z.infer` types, and `normalizeScraperOutput(raw)` that maps external -> internal with every field falling back to `null` via small `num`/`str` helpers.

**zod/v4 import + dual-schema + inferred types** (lines 1, 33-46):
```typescript
import { z } from "zod/v4";
export const listingDataSchema = z.object({ ... monthlyFee: z.number().nullable(), ... });
export type ListingData = z.infer<typeof listingDataSchema>;
```
BRF: build `brfExtractionSchema` from a reusable `extractedField(value)` factory (`{ value: value.nullable(), confidence, sourceQuote, pageRef }`) — see AI-SPEC §4b.1 / RESEARCH Pattern 2. Every field `.nullable()` NOT `.optional()` (AI-SPEC pitfall 3 — structured outputs force all keys required). NO grade/score field (D-08).

**Null-tolerant normalizer with primitive guards** (lines 60-86) — copy the `num`/`str` helper style and the "map source field names -> internal, fall back to null" body:
```typescript
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
export function normalizeScraperOutput(raw: Record<string, unknown>): NormalizedListing {
  return { address: str(raw.streetAddress), price: num(raw.price) ?? ..., ... };
}
```
BRF `normalizeBrfExtraction(parsed)`: mostly maps citation char-ranges -> `{ sourceQuote, pageRef }` per field and clamps confidence; output shape must be consumable by `computeBrfGrade` without throwing (AI-SPEC §5 FM4 / guardrail "schema/normalization gate").

---

### `src/lib/brf/score.ts`, `sanity.ts`, `cost.ts` (pure utility fns, transform)

**Analog:** `src/lib/utils.ts` — pure, exported, documented functions with guard clauses (`calculatePrisPerKvm` returns 0 on bad input; `formatSEK` uses `Intl.NumberFormat("sv-SE")`).

**Pure-fn style with JSDoc + guard clause** (utils.ts lines 8-26):
```typescript
/**
 * Calculates price per square meter, rounded to nearest integer.
 */
export function calculatePrisPerKvm(price: number, area: number): number {
  if (area <= 0) return 0;
  return Math.round(price / area);
}
```
- `score.ts` -> `computeBrfGrade(normalized)`: deterministic A-F, weighted threshold rules, NO Claude (D-08). Same input -> same grade. This is the golden-test target (AI-SPEC §5 grade-determinism).
- `sanity.ts` -> `applySanityChecks(normalized)`: range bands (skuld/kvm ~2,000-15,000; avgift ~300-1,200 SEK/m2/yr) that downgrade confidence on out-of-band values (RESEARCH Pitfall 4, A7 — bands are starting values, planner+user lock final).
- `cost.ts` -> `costSek(usage)`: Haiku rates × tokens × USD/SEK (make the FX rate a config constant per RESEARCH A1). Full impl in RESEARCH Code Examples.

**Reuse `formatSEK`/`cn` from utils.ts** in the display components — do not re-implement Swedish currency formatting.

---

### `src/lib/supabase/storage.ts` (storage helper, file-I/O)

**Analog:** `src/lib/supabase/server.ts` — the `createClient()`-from-env pattern. The storage ops themselves (`.storage.from("brf-pdfs").upload(...)` / `.download(...)`) come from RESEARCH Pattern 3. Reuse the EXISTING `createClient()` from `server.ts` inside the action rather than a new client; this helper (if created) just wraps upload/download path conventions (`${user.id}/${analysisId}.pdf`, `upsert: true` for D-06 replace).

Server client env style to follow (server.ts lines 4-9):
```typescript
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { cookies: { ... } }
  );
}
```

---

### `src/components/brf-upload.tsx` (client form -> server action, file-I/O)

**Analog:** `src/components/url-input.tsx` — EXACT pattern for a client component that calls a server action: `"use client"`, `useState` + `useTransition`, client-side validation before submit, build `FormData`, `startTransition(async () => await action(formData))`, map `result.error` to a Swedish `<p className="text-sm text-terracotta-600">`, sage submit button with inline spinner.

**Client form -> server action flow** (url-input.tsx lines 1-7, 21-58):
```typescript
"use client";
import { useState, useTransition } from "react";
const [isPending, startTransition] = useTransition();
// client-side validate, then:
startTransition(async () => {
  const formData = new FormData();
  formData.set("url", url);
  const result = await analyzeUrl(formData);
  if (result.error) { setError(result.error); return; }
  if (result.data) { onResult?.(...); }
});
```
BRF adaptations: `<input type="file" accept="application/pdf">` + drag-drop; client validation = type `application/pdf` + size <= 20 MB (D-14, ASVS V5); `formData.set("file", file)` + `formData.set("analysisId", id)`. Spinner/button styling copied verbatim:
```typescript
<Button className="bg-sage-600 text-white hover:bg-sage-700 h-11 px-6" disabled={isPending}>
  {isPending ? <span className="...animate-spin..." /> : "..."}
</Button>
```

---

### `src/components/brf-score-card.tsx` (display, request-response)

**Analog:** `src/components/listing-summary.tsx` — EXACT visual language. Reuse the `MetricCard` sub-component pattern and the "Ej tillganglig" missing-data treatment for the per-metric breakdown table (D-07).

**MetricCard + missing-data treatment** (listing-summary.tsx lines 11-32):
```typescript
function MetricCard({ label, value, isMissing }) {
  return (
    <div className="rounded-lg bg-warm-gray-50 p-4">
      <p className="text-xs font-medium uppercase tracking-wider text-warm-gray-500">{label}</p>
      {isMissing
        ? <p className="mt-1 text-lg italic text-warm-gray-500">Ej tillganglig</p>
        : <p className="mt-1 text-lg font-semibold text-warm-gray-900">{value}</p>}
    </div>
  );
}
```

**Card shell + partial banner** (lines 38-47) — reuse `Card/CardHeader/CardTitle/CardContent` and the `terracotta-50` warning banner; repurpose the banner for the D-14 "Skannad PDF" heads-up:
```typescript
<Card className="w-full max-w-2xl border-warm-gray-200">
  {partial && (
    <div className="rounded-t-xl bg-terracotta-50 px-6 py-3">
      <p className="text-sm text-terracotta-600">Vissa uppgifter kunde inte hamtas</p>
    </div>
  )}
```
BRF additions: prominent A-F grade (sage -> terracotta -> red, D-07); per-metric mini-rating + confidence badge (D-10) using the `Badge` component; source-quote + pageRef reveal (D-11). See Shared Patterns -> Confidence/Badge below. `formatSEK` from utils.ts for SEK values.

---

### `src/components/brf-progress.tsx` (poll + display, event-driven)

**Analog (visual):** `src/components/listing-skeleton.tsx` — the skeleton-card layout for the loading state. **Analog (poll mechanism):** browser Supabase client from `src/lib/supabase/client.ts` (`createBrowserClient`). No existing poll/realtime code — mechanism per RESEARCH Pattern 4 (poll `brf_status` every ~1.5s, or Supabase Realtime; planner's discretion, D-13).

**Skeleton card shell** (listing-skeleton.tsx lines 4-13):
```typescript
<Card className="w-full max-w-2xl border-warm-gray-200">
  <CardHeader className="space-y-3">
    <Skeleton className="h-8 w-3/4 bg-warm-gray-100" />
    ...
```
**Browser client for polling** (client.ts lines 1-8):
```typescript
import { createBrowserClient } from "@supabase/ssr";
export function createClient() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
}
```
BRF: step indicator "Laser dokumentet... -> Extraherar nyckeltal... -> Beraknar betyg..." driven by the polled `brf_status` value (D-13). `"use client"` + `useState`/`useEffect` poll loop.

---

### `src/components/brf-section.tsx` (container, request-response)

**Analog:** the BRF block in `src/app/(app)/analysis/[id]/page.tsx` (the `<ComingSoonSection title="BRF Analys" />` it replaces) + `listing-summary.tsx` for the read-from-row pattern. This is the orchestration component: shows teaser (guest, D-05), upload (no result), progress (status != done), or score-card (done). Reads BRF data off the analyses row the same way the page reads `listing_data`.

**Read typed data off the analyses row** (page.tsx lines 26-27):
```typescript
const listingData = analysis.listing_data as unknown as ListingData;
const isPartial = analysis.partial ?? false;
```

---

### `src/app/(app)/analysis/[id]/page.tsx` (route page — IN-PLACE EDIT)

**Analog:** itself. Single change: swap `<ComingSoonSection title="BRF Analys" />` (line 44) for `<BrfSection analysisId={analysis.id} brfData={analysis.brf_data} status={analysis.brf_status} />` (or equivalent). Leave the other three ComingSoonSection placeholders. Server-component data fetch already present (lines 15-24) — extend the `.select("*")` to include BRF columns (it already selects `*`).

---

### `src/app/(app)/sa-raknar-vi/page.tsx` (public methodology page — D-09)

**Analog:** `src/app/(app)/analysis/[id]/page.tsx` for the async server-component page shape and the warm-palette layout (`flex flex-col items-center gap-8`, `text-warm-gray-*`). This page is public (no auth, no Claude) — pure content listing every metric, threshold, weight. The thresholds it displays MUST be sourced from the same constants `score.ts`/`sanity.ts` use (single source of truth — don't hardcode twice).

---

### `supabase/migrations/002_brf.sql` (migration)

**Analog:** `supabase/migrations/001_analyses.sql` — EXACT RLS style. 001 shows: `create table` with `gen_random_uuid()` PK + `user_id references auth.users(id) on delete cascade`, an index, `enable row level security`, and per-operation policies `using (auth.uid() = user_id)` / `with check (auth.uid() = user_id)`.

**RLS policy style to mirror** (001 lines 16-26):
```sql
alter table public.analyses enable row level security;
create policy "Users can view own analyses"
  on public.analyses for select using (auth.uid() = user_id);
create policy "Users can insert own analyses"
  on public.analyses for insert with check (auth.uid() = user_id);
```
> **Gap in 001 to fix:** 001 has NO `update` policy. `analyze-brf.ts` writes status via `.update()` and D-12 re-scores via `.update()` — 002 MUST add an `update` policy (`using (auth.uid() = user_id) with check (auth.uid() = user_id)`).

BRF additions (RESEARCH Pattern 3 + Open Question 1): private storage bucket `brf-pdfs` (`public = false`) + `storage.objects` policy keyed to `(storage.foldername(name))[1] = auth.uid()::text`; and BRF columns on `analyses` (`brf_data jsonb`, `brf_status text`, `brf_cost_sek numeric`, `brf_pdf_hash text`) OR a related `brf_analyses` table — planner decides (jsonb columns are the lowest-friction match to the existing single-table pattern).

---

## Shared Patterns

### Auth gate (server-side, hard block for BRF)
**Source:** `src/actions/analyze.ts` lines 28-41 ; session refresh `src/lib/supabase/proxy.ts` line 35
**Apply to:** `analyze-brf.ts`, `brf-section.tsx` (teaser branch)
```typescript
const supabase = await createClient();
const { data: { user } } = await supabase.auth.getUser();
if (!user) return { error: "Logga in for BRF-analys" }; // D-05 — hard, not guest-cookie
```
ASVS V2/V4: never trust client gating — block server-side. RLS (migration) is the second layer.

### Null-tolerant external-data normalization
**Source:** `src/lib/schemas/listing.ts` lines 64-86
**Apply to:** `src/lib/schemas/brf.ts` (`normalizeBrfExtraction`)
The `num`/`str` primitive-guard helpers + "every field falls back to null" body. Critical because Claude structured outputs force all keys present (AI-SPEC pitfall 3) — `.nullable()` everywhere, never `.optional()`.

### External-service client + error mapping
**Source:** `src/lib/apify/booli-scraper.ts` lines 1-5, 35-44
**Apply to:** `src/lib/brf/extract.ts`
Module-scope vendor client from server-only env token; `try { ... } catch (error) { console.error("[tag]", error); throw new Error("<Swedish user message>"); }`. Log the real error server-side, return/throw a friendly Swedish string. GDPR (AI-SPEC §7): log only content hash + usage — NEVER raw PDF bytes, financials, or source quotes.

### Client form -> server action
**Source:** `src/components/url-input.tsx` lines 1-7, 21-58
**Apply to:** `src/components/brf-upload.tsx`
`"use client"` + `useTransition`; client-side validate; `FormData`; `startTransition(async () => await action(formData))`; `if (result.error) setError(...)`; sage button + inline spinner.

### Confidence / status badges
**Source:** `src/components/ui/badge.tsx` (variants: default/secondary/destructive/outline) ; usage example `coming-soon-section.tsx` lines 12-17
**Apply to:** `brf-score-card.tsx` (D-10 "Osaker" flags, "Manuellt angiven"), `brf-progress.tsx`
```typescript
<Badge variant="secondary" className="bg-warm-gray-100 text-warm-gray-500">Kommer snart</Badge>
```
Map low-confidence -> a terracotta/destructive variant for "Osaker - kontrollera sjalv"; corrected fields -> a sage/secondary variant for "Manuellt angiven".

### Card + MetricCard display shell
**Source:** `src/components/listing-summary.tsx` lines 11-32 (MetricCard), 38-47 (Card + banner)
**Apply to:** `brf-score-card.tsx`
Reuse `Card/CardHeader/CardTitle/CardContent`, the `warm-gray-50` metric tile, "Ej tillganglig" missing treatment, and the `terracotta-50` banner (repurposed for D-14 scanned-PDF notice).

### Swedish currency formatting
**Source:** `src/lib/utils.ts` lines 8-18 (`formatSEK`)
**Apply to:** all BRF display components — reuse, do not re-implement.

### Migration RLS pattern
**Source:** `supabase/migrations/001_analyses.sql` lines 16-26
**Apply to:** `supabase/migrations/002_brf.sql` — add the missing `update` policy; key storage RLS to `auth.uid()` path prefix.

---

## No Analog Found

Planner should use AI-SPEC §3/§4b and RESEARCH Code Examples for these (no codebase precedent — this is the first Claude integration and first test infra):

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src/lib/brf/prompt.ts` | config (versioned system prompt) | — | No prompt constant exists anywhere. New: `BRF_EXTRACTION_SYSTEM_PROMPT` (Swedish-doc context, "extract only — never grade", null-when-absent, confidence calibration, denominator-disambiguation few-shots). Source: AI-SPEC §4b "Prompt Engineering Discipline". |
| `evals/*` (`scorer.test.ts`, `extractor.eval.ts`, `citation-judge.ts`, `promptfooconfig.yaml`, `fixtures/`, `labels.json`) | test harness | — | No test framework installed (no vitest, no `evals/`, no `*.test.ts`). Wave 0 gap. Source: AI-SPEC §5 + RESEARCH Validation Architecture. |
| `vitest.config.ts` | config | — | Does not exist. Wave 0. |

> The Anthropic call SHAPE inside `extract.ts` has no codebase analog either (first Claude integration) — its structural analog (`booli-scraper.ts`) covers the client/error-handling skeleton only; the `messages.parse` / `zodOutputFormat` / document-block specifics come from AI-SPEC §3 and RESEARCH Code Examples.

## Metadata

**Analog search scope:** `src/actions`, `src/lib` (apify, schemas, supabase, utils), `src/components` (+ `ui`), `src/app/(app)` and `(auth)`, `supabase/migrations`
**Files scanned:** 17 source/migration files read in full
**Stack confirmed from package.json:** `@anthropic-ai/sdk@^0.102.0` (already installed), `zod@^4.3.6`, `@supabase/ssr@^0.8.0`, `@supabase/supabase-js@^2.97.0`, `next@16.1.6`, `react@19.2.3`, `radix-ui`, shadcn UI. NOT installed: vitest, promptfoo (Wave 0).
**Pattern extraction date:** 2026-06-07
