# Phase 2: BRF Financial Analysis - Research

**Researched:** 2026-06-07
**Domain:** Swedish BRF årsredovisning PDF extraction (Anthropic SDK) + Supabase Storage upload + Next.js 16 background processing + deterministic scoring
**Confidence:** HIGH (stack, integration, limits/pricing all verified against current docs 2026-06-07)

## Summary

This research **complements** the locked `02-AI-SPEC.md` — it does NOT re-litigate the framework choice (Direct Anthropic TypeScript SDK `@anthropic-ai/sdk@^0.102.0` + Zod v4, locked). It answers the five gaps AI-SPEC flagged: (1) Supabase Storage upload patterns for *this* codebase, (2) the PDF-acquisition feasibility question (D-01/D-02), (3) current Anthropic PDF page/size limits, (4) current Haiku 4.5 pricing vs the <5 SEK budget, and (5) the Next.js 16 background-processing mechanism for the D-13 progress UI and how it slots into the existing Phase 1 analysis pipeline.

**Verified headlines:** `@anthropic-ai/sdk@0.102.0` is current (modified 2026-06-06, 24.8M weekly downloads, slopcheck OK). PDF limits are **32 MB max request size** and **600 pages** (100 for 200k-context models) — the CONTEXT.md ~20 MB cap (D-14) fits comfortably under 32 MB but **must use base64-inline or the Files API**; at 20 MB raw the base64 string is ~27 MB, still under 32 MB but close, so the **Files API (`file_id`) is the safer transport for large scans**. Haiku 4.5 is **$1/MTok input, $5/MTok output, $0.10/MTok cache-read, $1.25/MTok 5-min cache-write** — a typical 20-page extraction costs **~0.94 SEK**, worst-case 40-page scanned with one cached retry **~2.3 SEK**, both well inside the <5 SEK budget. For D-13, Next.js `after()` is bounded by the route `maxDuration` and is **NOT a durable queue** — but since a single Haiku extraction completes in seconds-to-low-tens-of-seconds and Vercel Fluid Compute allows up to 60s (free) / 800s (Pro), the **recommended mechanism is: run extraction inside a server action that writes progress to a DB status column, client polls Supabase (or subscribes to Realtime)** — no Inngest needed for this single-step phase.

**Primary recommendation:** Build a single server action `analyzeBrf` mirroring the existing `analyze.ts` shape (auth-gate → fetch bytes → call external service → normalize → persist). Store PDFs in a **private** Supabase Storage bucket with RLS keyed to `user_id` (no public URLs — GDPR). Extract via one Haiku call with `citations: enabled` + `cache_control: ephemeral`; normalize through a `normalizeBrfExtraction()` mirroring `normalizeScraperOutput()`; score deterministically in pure TS; surface progress via a status column the client polls. Do **guided manual upload** (D-01 option 2) for v1 — broker auto-fetch is not reliably feasible and carries legal risk (see Acquisition Feasibility).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| PDF upload (file select, drag-drop, validation) | Browser / Client | Frontend Server | File picked client-side; validated client + server before storage |
| PDF storage (private, RLS) | Database / Storage (Supabase Storage) | — | Bytes must never be public; RLS-protected bucket is the system of record |
| Claude extraction call (API key, base64/file_id, citations) | API / Backend (server action) | — | API key is server-only (D-05); leaking it client-side is a critical failure |
| Normalization (null-tolerant) | API / Backend | — | Pure TS; mirrors `normalizeScraperOutput()` |
| Sanity-range confidence downgrade | API / Backend | — | Deterministic guardrail before scoring |
| A–F grade computation | API / Backend | — | Deterministic, auditable, NO Claude (D-08) |
| Progress status (Läser → Extraherar → Beräknar) | Database / Storage (status column) | Browser (poll/subscribe) | Server writes status; client reads — survives page leave (D-13) |
| Score + breakdown display, confidence badges, source quotes | Browser / Client | Frontend Server (SSR initial) | Read from persisted analysis row |
| Inline field edit → re-score | Browser → API/Backend | — | Re-runs normalize+score (NOT extraction) — D-12 |
| Methodology page ("Så räknar vi") | Frontend Server (static/SSR) | — | Public, no auth, no Claude — pure content + the same thresholds the scorer uses |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@anthropic-ai/sdk` | `^0.102.0` | Messages API, structured outputs (`messages.parse`), PDF document blocks, citations, prompt caching | Official Anthropic vendor SDK; locked by AI-SPEC. `[VERIFIED: npm registry — 0.102.0 latest, modified 2026-06-06, 24.8M downloads/wk]` |
| `zod` (`zod/v4`) | `^4.3.6` (installed; latest `4.4.3`) | Extraction schema contract + `zodOutputFormat()` | Already the project's external-data validation standard (see `listing.ts`). `[VERIFIED: npm registry]` |
| `@supabase/supabase-js` + `@supabase/ssr` | `^2.97.0` / `^0.8.0` | Storage bucket ops + DB persistence + RLS + (optional) Realtime | Already installed and used (Phase 1). `[VERIFIED: package.json]` |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` + `@vitest/coverage-v8` | latest | Scorer golden tests + extractor eval harness | Eval layer (AI-SPEC §5). Not yet installed — Wave 0 gap. `[ASSUMED]` |
| `promptfoo` | latest | Prompt regression on a frozen PDF subset in CI | AI-SPEC §5 CI integration. Not yet installed. `[ASSUMED]` |

> No PDF-parsing library (pdf.js, pymupdf, etc.) is needed — Claude ingests the PDF natively (AI-SPEC + project SUMMARY explicitly eliminated the preprocessing pipeline). Do NOT add one.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| base64-inline PDF | **Files API (`file_id`)** | For ≤~5 MB digital PDFs base64 is simplest; for the D-14 ~20 MB scans, base64 inflates ~33% (≈27 MB) and crowds the 32 MB request cap — use the Files API (`anthropic-beta: files-api-2025-04-14`, `toFile()` helper) to keep the payload small. **Recommendation: Files API for any PDF over ~5 MB; base64 otherwise.** `[CITED: platform.claude.com/docs/en/build-with-claude/pdf-support]` |
| Server-action polling | Inngest + Supabase Realtime | Inngest is durable-queue machinery justified for the multi-step Phase 3/4 pipeline; for this single-step extraction it is over-engineering. Polling/Realtime over a status column meets D-13. (Project STATE notes Inngest "did not materialize in Phase 1".) |
| Supabase Realtime | Client polling (1–2s interval) | Realtime is push (nicer UX, no poll loop) but adds a subscription + RLS-on-channel wiring; polling is dead-simple and fine for a seconds-long job. Either satisfies D-13 — planner's discretion. |

**Installation:**
```bash
npm install @anthropic-ai/sdk        # ^0.102.0
npm install -D vitest @vitest/coverage-v8 promptfoo   # eval layer (Wave 0)
# zod@^4.3.6 already installed (import via "zod/v4")
# Env (server-only, never NEXT_PUBLIC_): ANTHROPIC_API_KEY=sk-ant-...
```

**Next.js bundling note:** AI-SPEC flags that if `@anthropic-ai/sdk` trips Turbopack with dynamic requires, add it to `serverExternalPackages` in `next.config.ts` (the `apify-client` precedent is already there). Verify during implementation — the SDK is a clean ESM/CJS package and may not need it, but the precedent is established.

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| `@anthropic-ai/sdk` | npm | first publish 2023-01-31 (~3.4 yrs) | 24,876,835 / wk | github.com/anthropics/anthropic-sdk-typescript | OK | Approved |
| `vitest` | npm | mature | very high | github.com/vitest-dev/vitest | not run | `[ASSUMED]` — verify at install |
| `promptfoo` | npm | mature | high | github.com/promptfoo/promptfoo | not run | `[ASSUMED]` — verify at install |

- `@anthropic-ai/sdk`: **no `postinstall` script** (verified `npm view scripts.postinstall` → empty). Repository confirmed official (`github.com/anthropics/...`). slopcheck `install` scan → **1 OK**.
- **Packages removed due to [SLOP]:** none.
- **Packages flagged [SUS]:** none.
- `vitest`/`promptfoo` were not individually slopchecked this session (dev-only eval tooling from AI-SPEC); planner should run `slopcheck install vitest promptfoo @vitest/coverage-v8` before the Wave 0 install task. They are well-known mature packages, low risk.

## Architecture Patterns

### System Architecture Diagram

```
[Browser: BRF section on /analysis/[id]]
   |  (1) user selects/drops årsredovisning PDF (D-04, login-gated D-05)
   |      client-side validate: type=application/pdf, size ≤ 20 MB (D-14)
   v
[Server Action: analyzeBrf(analysisId, file)]
   |  (2) auth gate (must own analysis row; guests blocked -> teaser D-05)
   |  (3) upload bytes -> Supabase Storage private bucket  brf-pdfs/{user_id}/{analysisId}.pdf
   |  (4) content-hash the bytes -> if hash unchanged from prior run, SKIP Claude (D-06 replace-identical cache)
   |  (5) write status='reading' to analyses row  -----------> [DB status column]
   v
[Background work via after()/awaited within maxDuration]
   |  (6) fetch bytes from Storage; base64 (<5MB) OR Files API file_id (>5MB / scans)
   |      detect scanned/image-only -> set scanned flag (D-14)
   |  (7) status='extracting' --------------------------------> [DB status column]
   |      extractBrfFinancials(): ONE Haiku call
   |        model claude-haiku-4-5, temp 0, max_tokens 2048
   |        document block: citations.enabled, cache_control.ephemeral
   |        output_config.format = zodOutputFormat(brfExtractionSchema)
   |  (8) normalizeBrfExtraction(parsed_output)  (null-tolerant, mirrors listing.ts)
   |  (9) applySanityChecks(): downgrade confidence on out-of-band values
   |      map response citations -> {sourceQuote, pageRef} per field
   |  (10) status='scoring' ----------------------------------> [DB status column]
   |       computeBrfGrade(normalized): deterministic A–F, NO Claude (D-08)
   |  (11) persist {extraction, grade, usage, cost_sek, scanned, status='done'} to analyses row
   v
[Browser polls DB status (or Supabase Realtime) -> renders]
   |  step progress (D-13) while status != 'done'
   |  on done: A–F grade + per-metric breakdown table (D-07)
   |           confidence badges + "Osäker" flags (D-10)
   |           source quote + page ref per figure (D-11)
   |           inline-edit affordance (D-12)
   v
[Inline edit -> re-run normalize+score ONLY (step 8–11), NOT Claude (step 7)]
```

### Recommended Project Structure
(Mirrors AI-SPEC §3, aligned to existing repo conventions)
```
src/
├── lib/
│   ├── brf/
│   │   ├── extract.ts          # extractBrfFinancials(): the single Anthropic call
│   │   ├── prompt.ts           # BRF_EXTRACTION_SYSTEM_PROMPT (versioned)
│   │   ├── score.ts            # computeBrfGrade() — deterministic, NO Claude (D-08)
│   │   ├── sanity.ts           # applySanityChecks() — range bands -> confidence downgrade
│   │   └── cost.ts             # usage -> SEK cost (Haiku rates)
│   ├── schemas/
│   │   ├── listing.ts          # EXISTING — the normalization pattern to mirror
│   │   └── brf.ts              # brfExtractionSchema + normalizeBrfExtraction()
│   └── supabase/               # EXISTING server/browser clients + a new storage helper
├── actions/
│   ├── analyze.ts              # EXISTING — copy its shape & guest-gate logic
│   └── analyze-brf.ts          # NEW server action
├── components/
│   ├── brf-section.tsx         # NEW — replaces <ComingSoonSection title="BRF Analys" />
│   ├── brf-upload.tsx          # NEW — dropzone (Claude's discretion on styling)
│   ├── brf-score-card.tsx      # NEW — A–F grade + breakdown (reuse MetricCard pattern)
│   └── brf-progress.tsx        # NEW — D-13 step indicator
└── app/(app)/
    ├── analysis/[id]/page.tsx  # EXISTING — swap ComingSoonSection -> BrfSection
    └── sa-raknar-vi/page.tsx   # NEW — public methodology page (D-09), no auth
supabase/migrations/
    └── 002_brf.sql             # NEW — storage bucket + RLS + analyses columns
```

### Pattern 1: Mirror `analyze.ts` server-action shape
**What:** The existing `analyzeUrl` action is the template: validate input → call external service → parse/normalize → persist → render. `analyzeBrf` follows the identical spine. Reuse the auth-gate pattern (`supabase.auth.getUser()`); BRF is login-only (D-05) so the guest branch becomes a hard block, not a cookie allowance.
**When to use:** The single BRF extraction server action.
**Example:**
```typescript
// src/actions/analyze-brf.ts — mirrors src/actions/analyze.ts
"use server";
import { createClient } from "@/lib/supabase/server";
import { extractBrfFinancials } from "@/lib/brf/extract";
import { normalizeBrfExtraction } from "@/lib/schemas/brf";
import { applySanityChecks } from "@/lib/brf/sanity";
import { computeBrfGrade } from "@/lib/brf/score";

export async function analyzeBrf(analysisId: string, formData: FormData) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Logga in för BRF-analys" }; // D-05 hard gate

  // ... upload to private bucket, set status, extract, normalize, sanity, score, persist
}
```

### Pattern 2: Null-tolerant normalization mirroring `normalizeScraperOutput()`
**What:** `listing.ts` defines a `normalizeScraperOutput(raw)` that maps external field names to the internal model with every field falling back to `null`. Replicate as `normalizeBrfExtraction(parsed_output)`. Because Anthropic structured outputs force every property as required (AI-SPEC pitfall #3), every field is already `.nullable()` in the schema — normalization mostly maps citation char-ranges to `{sourceQuote, pageRef}` and clamps confidence.
**When to use:** Between `messages.parse` and the scorer.
```typescript
// src/lib/schemas/brf.ts — mirrors normalizeScraperOutput in listing.ts
import { z } from "zod/v4";
const extractedField = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    value: value.nullable(),
    confidence: z.number().min(0).max(1),
    sourceQuote: z.string().nullable(),
    pageRef: z.number().int().positive().nullable(),
  });
export const brfExtractionSchema = z.object({
  skuldPerKvm: extractedField(z.number()),
  avgiftsniva: extractedField(z.number()),
  kassaflode: extractedField(z.number()),
  underhallsplanStatus: extractedField(
    z.enum(["finns_aktuell", "finns_inaktuell", "saknas", "oklart"])),
  // NO grade/score field — code grades (D-08)
});
```

### Pattern 3: Supabase Storage — private bucket, read bytes server-side
**What:** PDFs go in a **private** bucket (no public URL — GDPR per AI-SPEC). The server action uploads via the server client; extraction reads bytes via `download()`, never via a public link. RLS on `storage.objects` keys the path prefix to `auth.uid()`.
**When to use:** Upload (step 3) and read-back (step 6).
```typescript
// upload (server action)
await supabase.storage.from("brf-pdfs")
  .upload(`${user.id}/${analysisId}.pdf`, fileBytes, {
    contentType: "application/pdf", upsert: true /* D-06 replace */ });
// read back for extraction
const { data } = await supabase.storage.from("brf-pdfs")
  .download(`${user.id}/${analysisId}.pdf`);
const base64 = Buffer.from(await data.arrayBuffer()).toString("base64");
```
```sql
-- supabase/migrations/002_brf.sql — bucket + RLS (mirrors 001_analyses.sql RLS style)
insert into storage.buckets (id, name, public) values ('brf-pdfs','brf-pdfs', false);
create policy "Users manage own brf pdfs" on storage.objects
  for all using (bucket_id = 'brf-pdfs' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'brf-pdfs' and (storage.foldername(name))[1] = auth.uid()::text);
```

### Pattern 4: D-13 progress without a job queue
**What:** Run extraction inside the server action; write a `brf_status` column (`reading|extracting|scoring|done|failed`) at each step; client polls the analyses row every ~1.5s (or subscribes to Supabase Realtime). Because extraction completes in seconds-to-low-tens-of-seconds and is within the route `maxDuration`, no Inngest/durable queue is required. If you want the user to safely leave the page mid-run, kick the work off with `after()` (Next 16 stable) — but note `after()` is still bounded by `maxDuration` and is **not durable** across cold starts, so for a >60s job on the free tier you would need a real queue. Current cost/latency math (below) keeps the job well under that.
**When to use:** The whole extraction lifecycle.

### Anti-Patterns to Avoid
- **Letting Claude produce the grade.** The extraction schema must contain NO score/grade/rating field (D-08, AI-SPEC FM2). Add a CI invariant that fails if such a key appears.
- **Public Storage bucket / signed-URL-to-browser of the raw PDF.** GDPR: PDFs can contain styrelse personal data. Keep the bucket private; never log raw bytes or extracted financials (only content hash + usage).
- **Re-extracting on every inline edit (D-12).** Corrections re-run normalize+score only (steps 8–11), never the Claude call (step 7) — re-extraction wastes budget and is non-deterministic.
- **Re-billing the full PDF on retry.** Without `cache_control: ephemeral` on the document block, each retry re-bills the whole document. Always cache.
- **Trusting `messages.parse` value correctness.** It guarantees shape, not numbers (AI-SPEC pitfall #2). Layer sanity-range checks + confidence on top.
- **Hand-rolling PDF text extraction.** Claude ingests PDFs natively — adding pdf.js/pymupdf reintroduces the preprocessing pipeline the project deliberately eliminated.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PDF text/layout extraction | A pdf.js / OCR preprocessing pipeline | Claude native PDF document block | Claude handles Swedish K2/K3 layouts + scanned pages natively; preprocessing was explicitly removed in project research |
| Schema-constrained LLM output + validation | Hand-rolled tool-use / JSON-repair | `messages.parse({ output_config: { format: zodOutputFormat(schema) } })` | SDK does server-side constrained decode + Zod validation, returns typed `parsed_output` |
| Source quote + page reference | Prompting "tell me the page" and trusting prose | `citations: { enabled: true }` on the document block | Native char-range citations are grounded in the PDF (D-11); prose page claims hallucinate |
| Per-analysis cost computation | Guessing token counts | `message.usage` (input/output/`cache_creation_input_tokens`/`cache_read_input_tokens`) × Haiku rates | Exact accounting against the <5 SEK budget |
| File upload UI plumbing | Custom XHR multipart handler | `<input type=file>` / drag-drop → server action → `supabase.storage.upload()` | Supabase SDK handles multipart + RLS |
| Background job for a seconds-long task | A full Inngest/queue setup | Server action + DB status column + poll/Realtime | Single-step job within `maxDuration`; queue is Phase 3/4 territory |

**Key insight:** The entire phase is "one Claude call wrapped in deterministic TS + a storage round-trip." Every hard part (PDF parsing, structured output, citations, cost accounting) is a built-in SDK feature. The only genuinely custom code is the deterministic scorer and the normalization layer — both of which must be hand-written *because* they are the auditable, provider-agnostic core (D-08/D-09).

## Common Pitfalls

### Pitfall 1: base64 inflation pushes a large scan over the 32 MB request cap
**What goes wrong:** A 20 MB scanned PDF base64-encodes to ~27 MB; combined with the rest of the request it can approach or exceed the 32 MB max request size, causing an opaque API failure.
**Why it happens:** base64 adds ~33% overhead; D-14 explicitly allows ~20 MB uploads.
**How to avoid:** Use the **Files API** (`anthropic-beta: files-api-2025-04-14`, upload with `toFile()`, reference by `file_id`) for PDFs over ~5 MB. base64-inline only for small digital reports.
**Warning signs:** Requests failing only on large/scanned uploads; sizes near 32 MB.
`[CITED: platform.claude.com/docs/en/build-with-claude/pdf-support]`

### Pitfall 2: Dense PDF fills context before the page limit
**What goes wrong:** A dense årsredovisning (many small-font tables, heavy graphics) can exhaust the context window before hitting the page cap, failing even via the Files API.
**Why it happens:** Each page is processed as both text (~1,500–3,000 tokens) AND an image; dense pages cost more.
**How to avoid:** For oversized/scanned docs, split by page range, extract per range with `Promise.all`, merge field-by-field keeping the highest-confidence non-null per field (AI-SPEC §4 fallback). Haiku 4.5 is a 200k-context model → **100-page** per-request cap applies, not 600.
**Warning signs:** Failures on long/dense reports; `stop_reason` anomalies.
`[CITED: platform.claude.com/docs/en/build-with-claude/pdf-support — "100 for models with a 200k-token context window"]`

### Pitfall 3: `after()` mistaken for a durable queue
**What goes wrong:** Assuming `after()` lets a long extraction survive arbitrarily after the response. It does not — it runs within the route's `maxDuration` and is not durable across cold starts.
**Why it happens:** `after()` reads as "background job"; it's really "finish this promise before the serverless invocation is torn down, up to maxDuration."
**How to avoid:** For this phase the job is short (seconds), so `after()` + status-column polling is fine. Confirm `maxDuration` (Vercel Fluid Compute default 60s free / up to 800s Pro) comfortably exceeds p95 extraction latency. If a job ever exceeds the limit, escalate to a real queue — do not stretch `after()`.
**Warning signs:** 504 `FUNCTION_INVOCATION_TIMEOUT`; truncated background work on cold starts.
`[CITED: nextjs.org/docs/app/api-reference/functions/after — "after will run for the platform's default or configured max duration"; vercel.com/docs/functions/configuring-functions/duration]`

### Pitfall 4: Unit/denominator confusion (the highest-impact domain error)
**What goes wrong:** Total debt extracted as debt/kvm (off by apartment count), or debt ÷ total yta instead of ÷ upplåten bostadsrättsyta, or monthly avgift reported as annual (12×) — all pass schema validation while being badly wrong.
**Why it happens:** Swedish reports present several debt/area/fee figures; BFNAR 2023:1 mandates specific denominators (AI-SPEC §1b FM1).
**How to avoid:** Sanity-range bands (skuld/kvm ~2,000–15,000 SEK Stockholm; avgift ~300–1,200 SEK/m²/år) that downgrade confidence on out-of-band values; prompt few-shots that disambiguate denominators; cite BFNAR 2023:1 formulas on the methodology page.
**Warning signs:** Values exactly ~12× or ~apartment-count off; out-of-band values at high confidence.

### Pitfall 5: Supabase free tier pauses after 7 days inactivity
**What goes wrong:** The project's Supabase instance pauses after 7 days dormant; a prior project was permanently frozen after 90+ days (STATE.md). A paused DB breaks uploads/extraction.
**How to avoid:** Operational, not code — visit dashboard periodically or upgrade. Flagging for the planner because storage + DB are now load-bearing for this phase.

### Pitfall 6: Calling the SDK from a client component leaks the API key
**What goes wrong:** `new Anthropic()` in a browser bundle exposes `ANTHROPIC_API_KEY`.
**How to avoid:** Instantiate only inside server actions/route handlers; never set `dangerouslyAllowBrowser`; env var is server-only (no `NEXT_PUBLIC_` prefix). All BRF work is server-side (D-05).

## Code Examples

### The single extraction call (current SDK shape)
```typescript
// src/lib/brf/extract.ts
// Source: AI-SPEC §3 + github.com/anthropics/anthropic-sdk-typescript/blob/main/helpers.md
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { brfExtractionSchema } from "@/lib/schemas/brf";
import { BRF_EXTRACTION_SYSTEM_PROMPT } from "@/lib/brf/prompt";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY (server-only)

export async function extractBrfFinancials(pdfBase64: string) {
  const message = await client.messages.parse({
    model: "claude-haiku-4-5",
    max_tokens: 2048,
    temperature: 0,
    system: BRF_EXTRACTION_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: [
        { type: "document",
          source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
          citations: { enabled: true },
          cache_control: { type: "ephemeral" } },
        { type: "text", text: "Extrahera nyckeltalen enligt schemat. Lämna fält null om de inte finns." },
      ],
    }],
    output_config: { format: zodOutputFormat(brfExtractionSchema) },
  });
  if (message.stop_reason === "refusal") throw new Error("refusal"); // no retry
  return { parsed: message.parsed_output, usage: message.usage };
}
```

### Files API transport for large/scanned PDFs (>~5 MB)
```typescript
// Source: platform.claude.com/docs/en/build-with-claude/pdf-support (Option 3)
import Anthropic, { toFile } from "@anthropic-ai/sdk";
const fileUpload = await client.beta.files.upload({
  file: await toFile(Buffer.from(bytes), "arsredovisning.pdf", { type: "application/pdf" }),
});
// then in content: { type: "document", source: { type: "file", file_id: fileUpload.id } }
// call via client.beta.messages.* with betas: ["files-api-2025-04-14"]
```

### Cost computation from usage (Haiku 4.5 rates)
```typescript
// src/lib/brf/cost.ts — rates verified 2026-06-07
const USD_PER_MTOK = { input: 1.0, output: 5.0, cacheWrite5m: 1.25, cacheRead: 0.10 };
const USD_SEK = 11; // approximate; make configurable
export function costSek(u: {
  input_tokens: number; output_tokens: number;
  cache_creation_input_tokens?: number; cache_read_input_tokens?: number;
}) {
  const usd =
    (u.input_tokens / 1e6) * USD_PER_MTOK.input +
    (u.output_tokens / 1e6) * USD_PER_MTOK.output +
    ((u.cache_creation_input_tokens ?? 0) / 1e6) * USD_PER_MTOK.cacheWrite5m +
    ((u.cache_read_input_tokens ?? 0) / 1e6) * USD_PER_MTOK.cacheRead;
  return usd * USD_SEK;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `pdf.js`/`pymupdf` preprocessing then text→LLM | Native Claude PDF document block | — | No preprocessing pipeline; handles scans + tables |
| Hand-rolled tool-use JSON + manual validation | `messages.parse` + `zodOutputFormat` | SDK structured outputs | Server-side constrained decode, typed `parsed_output` |
| `unstable_after` | `after` (stable) | Next.js 15.1 | Stable background-after-response within maxDuration |
| Inngest assumed mandatory for progress (Feb research) | Server action + status column poll/Realtime for single-step jobs | This phase | Inngest deferred to multi-step Phase 3/4 |
| Sonnet for everything | Haiku 4.5 for extraction, Sonnet reserved for synthesis | AI-SPEC | ~3× cheaper for number-pulling |

**Deprecated/outdated:**
- BRF auto-fetch via Bolagsverket free API: **does not exist** for BRF årsredovisningar (D-02, verified). v2 path (ENRICH-01).
- Progressiv avskrivning: banned by BFN for BRFs — relevant to interpreting historical book losses (AI-SPEC §1b FM2).

## Acquisition Feasibility (D-01 / D-02 research directive)

**Directive:** assess broker-page auto-fetch vs guided manual upload before planning locks the approach.

**Finding — recommend guided manual upload (D-01 option 2) for v1. Broker auto-fetch is NOT reliably feasible and carries risk.** `[MEDIUM confidence — WebSearch + verified project constraints]`

Evidence:
1. **No free API covers BRF årsredovisningar today** (D-02, verified 2026-06-07): Bolagsverket's free dataset is iXBRL-only; BRFs cannot file iXBRL; mandatory BRF filing only from FY2025 and on paper (no API). Allabrf is 99 SEK/report consumer-side / enterprise-priced B2B — the user explicitly rejects paid per-report dependencies. `[CITED: bolagsverket.se; fastighetsagarna.se — both in CONTEXT canonical refs]`
2. **Broker pages do publish the PDF for free**, but acquisition is fragile and legally fraught:
   - The project stores `agencyListingUrl` (Vitec etc.), and **Hemnet/broker listings expose docs under "Dokument"/"Föreningen"** — confirming PDFs *exist* on broker pages. `[CITED: lusa.se/guide; general broker-page convention — MEDIUM]`
   - **But:** there is no standardized PDF link pattern across Vitec/Hemnet-connected/boutique platforms; document sections are often behind JS, login walls, or per-listing CDN URLs. Scraping them is the same category of fragile, ToS-sensitive scraping the project already constrains. **Hemnet scraping is explicitly Out-of-Scope (ToS prohibits)** per REQUIREMENTS — so any auto-fetch from Hemnet-connected pages is off the table. Booli (the allowed source) does not reliably expose the årsredovisning PDF itself.
   - Auto-fetch would also expand the "user-initiated, one-at-a-time" legal posture the project deliberately maintains (project research pitfall #3, EU Database Directive).
3. **Guided manual upload** (D-01 option 2) sidesteps all of this: the user fetches the free PDF themselves from the broker page (deep-link them there: "Hitta årsredovisningen på mäklarens sida"), with Bolagsverket paper-ordering as the documented fallback. This is BRF-03 read literally ("upload when auto-fetch is unavailable") and matches D-04/D-05/D-06.

**Recommendation for planner:** Build guided manual upload for v1. Optionally include a non-blocking "Öppna mäklarens sida" deep-link using the stored `agencyListingUrl` to reduce friction — but do NOT build a scraper for the PDF. Auto-fetch remains the v2 path (ENRICH-01) once BRF iXBRL filing exists (D-03). This is a discretion area CONTEXT explicitly left to research → it should be confirmed with the user in planning since it shapes the upload UX.

## Cost & Limits Verification (AI-SPEC "verify against current docs" items)

**PDF limits** `[CITED: platform.claude.com/docs/en/build-with-claude/pdf-support, verified 2026-06-07]`:
- Max request size: **32 MB** (entire payload). D-14's ~20 MB upload fits, but base64 inflation (~27 MB) makes the **Files API the safer transport for large scans**.
- Max pages: **600**, or **100 for 200k-context models** (Haiku 4.5 is 200k → 100-page cap). Typical årsredovisning 10–40 pages → fine.
- Tokenization: 1,500–3,000 text tokens/page + image tokens (each page rendered as image). Standard pricing, no PDF surcharge.
- All active models support PDF; standard PDF only (no password/encryption — validate/handle this in upload).
- Files API requires `anthropic-beta: files-api-2025-04-14`.

**Haiku 4.5 pricing** `[CITED: platform.claude.com/docs/en/about-claude/pricing, verified 2026-06-07]`: input **$1/MTok**, output **$5/MTok**, 5-min cache-write **$1.25/MTok**, cache-read **$0.10/MTok**. Model id `claude-haiku-4-5`.

**Budget check vs <5 SEK (USD/SEK ≈ 11):**
| Scenario | Input tok | Cost | vs 5 SEK |
|----------|-----------|------|----------|
| Typical 20-page digital, first run | ~80k | **~0.94 SEK** | ✅ 19% |
| Same with cache-write surcharge | ~80k | ~1.16 SEK | ✅ |
| Cached retry within 5 min | ~80k cached | ~0.14 SEK | ✅ |
| Worst case: cache-write + 1 retry | — | **~1.30 SEK** | ✅ |
| Heavy 40-page scanned, cache-write run | ~160k | **~2.26 SEK** | ✅ 45% |

**Conclusion:** AI-SPEC's "<1 SEK per first extraction" assertion is **verified** for typical reports; even the heavy scanned worst case stays under half the budget. The <5 SEK budget is comfortably safe with Haiku + caching. Set the hard cost-cap guardrail (AI-SPEC §6) at 5 SEK and a p95 warning at 3 SEK.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | USD/SEK ≈ 11 for budget math | Cost & Limits | FX drift; make the rate a config constant, not hardcoded in cost logic |
| A2 | Typical extraction token estimate ~80k input (20pg) | Cost & Limits | Underestimate inflates cost; mitigated by huge headroom + live `usage` tracking |
| A3 | Files API recommended over base64 above ~5 MB | Standard Stack / Pitfall 1 | Threshold is judgment; both work — Files API is strictly safer for large payloads |
| A4 | Polling/Realtime over status column is sufficient for D-13 (no Inngest) | Architecture Pattern 4 | If extraction p95 exceeds maxDuration, a queue is needed; current cost/latency math says it won't |
| A5 | Broker PDF auto-fetch is not reliably feasible for v1 | Acquisition Feasibility | If a stable Booli-side PDF link pattern exists, auto-fetch could be partially viable — confirm with user in planning |
| A6 | `vitest`/`promptfoo` legitimacy | Package Audit | Run slopcheck before installing (mature packages, low risk) |
| A7 | Sanity bands (skuld/kvm 2,000–15,000; avgift 300–1,200 SEK/m²/år) | Pitfall 4 | These are starting bands from AI-SPEC/project research; planner+user lock final thresholds for methodology page (D-09) |

## Open Questions

1. **Where do BRF results persist — new jsonb column on `analyses`, or a related `brf_analyses` table?**
   - What we know: `analyses` has a `listing_data` jsonb column + RLS; one PDF per analysis, replaceable (D-06).
   - What's unclear: jsonb column vs separate table (cleaner for the status/usage/cost fields + future multi-year v2).
   - Recommendation: Planner decides. A `brf_data` jsonb + `brf_status`/`brf_cost_sek` columns on `analyses` is the lowest-friction match to the existing pattern; a related table is cleaner if multi-year (ADV-02) is anticipated. Either way RLS must cover it (mirror 001).

2. **Final sanity-range thresholds and scoring weights (D-08/D-09).**
   - Recommendation: This is Claude's-discretion-with-user-sign-off. Research provides starting bands (Pitfall 4 / A7); planner proposes weights, user signs off because they go on the public methodology page.

3. **Polling vs Supabase Realtime for D-13.**
   - Recommendation: Either meets the locked UX; polling is simplest. Planner's discretion (CONTEXT explicitly leaves the mechanism open).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `@anthropic-ai/sdk` | extraction | ✗ (not installed) | target ^0.102.0 | none — must install |
| `ANTHROPIC_API_KEY` env | extraction | ✗ (first Claude integration) | — | none — must provision (server-only) |
| Supabase Storage bucket `brf-pdfs` | PDF upload | ✗ (Storage unused so far) | — | none — migration 002 creates it |
| `@supabase/supabase-js` / `ssr` | storage + DB | ✓ | 2.97.0 / 0.8.0 | — |
| `zod` (`zod/v4`) | schema | ✓ | 4.x | — |
| `vitest` / `promptfoo` | eval layer | ✗ | — | none — Wave 0 install |
| Supabase project (live, not paused) | all DB/storage | ⚠ pauses after 7d idle | — | visit dashboard / upgrade |

**Missing dependencies with no fallback (blocking — planner must add install/provision tasks):**
- `@anthropic-ai/sdk` install; `ANTHROPIC_API_KEY` provisioning; `brf-pdfs` bucket + RLS migration; vitest/promptfoo install (Wave 0).

## Validation Architecture

> nyquist_validation is enabled (config). This phase has a clean two-layer eval split (AI-SPEC §5): deterministic scorer tests (always-on, free) + cost-gated extractor evals.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (+ Promptfoo for prompt regression) — **not yet installed (Wave 0)** |
| Config file | none — create `vitest.config.ts` in Wave 0 |
| Quick run command | `npx vitest run evals/scorer.test.ts src/lib/brf` |
| Full suite command | `RUN_LLM_EVALS=1 npx vitest run evals/extractor.eval.ts` (cost-gated) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| BRF-01 | Extract + display skuld/kvm, avgift, kassaflöde, underhållsplan | unit (normalize contract) + extractor eval | `npx vitest run src/lib/schemas/brf.test.ts` | ❌ Wave 0 |
| BRF-01 | Low-confidence/out-of-band fields flagged not silently wrong | unit (sanity downgrade) | `npx vitest run src/lib/brf/sanity.test.ts` | ❌ Wave 0 |
| BRF-02 | Deterministic A–F grade, same input → same grade, NO grade field in extraction | unit/golden | `npx vitest run src/lib/brf/score.test.ts` | ❌ Wave 0 |
| BRF-02 | Transparent methodology page lists every threshold/weight | manual (content review) | — (human) | ❌ |
| BRF-03 | Upload accepted, stored privately, replaceable | integration (RLS + upsert) | `npx vitest run src/actions/analyze-brf.test.ts` | ❌ Wave 0 |
| (cross) | Per-analysis cost < 5 SEK, model = claude-haiku-4-5 | unit (cost fn) + extractor eval | `npx vitest run src/lib/brf/cost.test.ts` | ❌ Wave 0 |
| (cross) | Citation fidelity: sourceQuote present on pageRef | extractor eval + LLM judge | `RUN_LLM_EVALS=1 npx vitest run evals/extractor.eval.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run evals/scorer.test.ts src/lib/brf` (free, deterministic)
- **Per wave merge:** full deterministic suite + `npx promptfoo eval -c evals/promptfooconfig.yaml` on prompt changes
- **Phase gate:** deterministic suite green + at least one full `RUN_LLM_EVALS=1` run against the 12–20 reference PDFs before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] Framework install: `npm i -D vitest @vitest/coverage-v8 promptfoo` + `vitest.config.ts`
- [ ] `src/lib/brf/score.test.ts` — grade determinism + golden inputs (BRF-02)
- [ ] `src/lib/brf/sanity.test.ts` — range-band confidence downgrade (BRF-01)
- [ ] `src/lib/brf/cost.test.ts` — Haiku cost computation < 5 SEK assertion
- [ ] `src/lib/schemas/brf.test.ts` — normalization contract feeds scorer without throwing
- [ ] `src/actions/analyze-brf.test.ts` — auth gate + private-bucket RLS + D-06 replace
- [ ] `evals/` harness: fixtures dir (gitignored PDFs), `labels.json` keyed by content hash, `extractor.eval.ts`, `citation-judge.ts`, `promptfooconfig.yaml`
- [ ] Reference dataset: 12–20 real årsredovisningar (composition per AI-SPEC §5) — sourcing is a real-world dependency; flag for human

## Security Domain

> security_enforcement not present in config → treated as enabled.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Reuse Supabase auth (`getUser()`); BRF is login-only (D-05) — hard-block guests server-side, not just UI |
| V3 Session Management | yes | Supabase SSR cookie sessions (existing Phase 1 pattern) |
| V4 Access Control | yes | RLS on `analyses` + `storage.objects` keyed to `auth.uid()`; user can only read/write own PDFs and results |
| V5 Input Validation | yes | Validate file type=`application/pdf`, size ≤ 20 MB, reject encrypted/password PDFs; Zod-validate extraction output |
| V6 Cryptography | no | No custom crypto; rely on Supabase at-rest encryption + TLS |
| V8 Data Protection (GDPR) | yes | Private bucket (no public URLs); never log raw PDF bytes/financials/source quotes — only content hash + usage/cost; PDFs inherit RLS; honor project PDF deletion/retention policy (set in Phase 1) |
| V14 Configuration | yes | `ANTHROPIC_API_KEY` server-only (no `NEXT_PUBLIC_`); never `dangerouslyAllowBrowser` |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| API key leakage to browser | Information Disclosure | SDK only in server actions; key server-only env |
| Cross-user PDF/result access | Elevation of Privilege | Storage + table RLS keyed to `auth.uid()`; path-prefix = user id |
| Malicious / oversized / encrypted PDF upload | Denial of Service / Tampering | Type+size+encryption validation pre-storage; cost-cap guardrail aborts runaway spend |
| PII in logs (styrelse names, financials) | Information Disclosure | Log content hash + usage only; never raw bytes/financials/quotes |
| Cost-exhaustion abuse | DoS (budget) | Login-gate (D-05) + per-analysis 5 SEK hard cap + bounded retries + cache |
| Confident hallucinated figure | Tampering (data integrity) | Per-field confidence + mandatory citation + sanity bands + inline edit (D-10/D-11/D-12) |

## Sources

### Primary (HIGH confidence)
- platform.claude.com/docs/en/build-with-claude/pdf-support — PDF limits (32 MB, 600/100 pages), tokenization, Files API, caching (fetched 2026-06-07)
- platform.claude.com/docs/en/about-claude/pricing — Haiku 4.5 rates + cache multipliers (fetched 2026-06-07)
- nextjs.org/docs/app/api-reference/functions/after — `after()` semantics, maxDuration binding, stable since 15.1 (v16.2.7 docs, 2026-03-13)
- npm registry — `@anthropic-ai/sdk@0.102.0` (latest, modified 2026-06-06, 24.8M dl/wk, no postinstall, official repo); `zod@4.4.3`
- slopcheck 0.6.1 — `@anthropic-ai/sdk` → 1 OK
- Existing codebase: `src/actions/analyze.ts`, `src/lib/schemas/listing.ts`, `src/lib/supabase/*`, `src/components/listing-summary.tsx`, `supabase/migrations/001_analyses.sql`
- `02-AI-SPEC.md` (locked) + `02-CONTEXT.md` (decisions) + project SUMMARY/REQUIREMENTS/STATE

### Secondary (MEDIUM confidence)
- vercel.com/docs/functions/configuring-functions/duration + Fluid Compute (WebSearch) — maxDuration 60s free / up to 800s Pro
- lusa.se/guide + broker-page convention (WebSearch) — broker listings expose docs under "Dokument"/"Föreningen"

### Tertiary (LOW confidence)
- Broker PDF link-pattern fragility across Vitec/Hemnet/boutique platforms (WebSearch, inference) — drives the "no auto-fetch for v1" recommendation; confirm with user

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — SDK version, PDF limits, pricing all verified against current official docs 2026-06-07
- Architecture/integration: HIGH — grounded in actual repo files (analyze.ts, listing.ts, migration, supabase clients)
- Acquisition feasibility: MEDIUM — verified constraints (D-02) + reasoned scraping/legal assessment; broker-link specifics are LOW and flagged for user confirmation
- Pitfalls: HIGH — domain pitfalls from AI-SPEC; technical pitfalls verified against docs

**Research date:** 2026-06-07
**Valid until:** 2026-07-07 (pricing/limits/SDK move fast — re-verify Haiku rates and PDF limits before locking budget assertions in a plan written >30 days out)
