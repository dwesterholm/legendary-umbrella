# Phase 4: AI Report + Delivery - Research

**Researched:** 2026-06-23
**Domain:** Serverless PDF generation (Next.js 16 / Vercel) + cross-source Claude synthesis on an existing direct-SDK + Zod pipeline
**Confidence:** HIGH (PDF mechanism, model tiering, cost, code-integration); MEDIUM (D-03 soft-flag raise — a design judgement, recommendation given)

## Summary

The AI layer for this phase is **already locked** by `04-AI-SPEC.md`: Direct Anthropic SDK + Zod v4, **Sonnet 4.6** for the one synthesis call, **Haiku 4.5** for the extended extraction, ~0.30 SEK/report, eval strategy via the existing Vitest + Promptfoo harness, and a fully-specified `reportSchema`/guardrail design. This research does **not** re-open any of that. It resolves the three open directives CONTEXT.md and AI-SPEC explicitly defer: (1) the PDF generation mechanism, (2) confirmation of model tiering + the cost guard reuse, and (3) the D-03 soft-signal raise mechanism — plus the deterministic-flag computation, the `analyses` table change, and the Nyquist validation architecture.

**PDF is the highest-value unknown, and it resolves cleanly.** The project runs **React 19.2.3 / Next 16.1.6 on Vercel serverless**. `@react-pdf/renderer@4.5.1` [VERIFIED: npm registry] generates PDFs in pure JS via its own Yoga + PDFKit layout engine — **no headless browser, no Chromium binary, no Vercel 250 MB bundle problem, no 15s cold-start**. It officially supports React 19 (peerDeps `^19.0.0`, since v4.1.0) [CITED: react-pdf.org/compatibility]. This is the recommendation. The headless-chrome route (`puppeteer-core` + `@sparticuz/chromium`) is viable but materially heavier (bundle size, ~10–15s cold start vs Vercel's default 10s timeout, a separately-hosted ~50 MB Chromium binary downloaded at runtime) and is not justified for one templated A4 report. A hosted PDF API adds a third-party dependency, per-render cost, and sends the user's financials off-platform (GDPR friction) — rejected. Print-CSS/browser-print cannot satisfy "download a file" as a server-produced artifact and is rejected.

**Primary recommendation:** Use `@react-pdf/renderer@^4.5.1`. Build the report as a **React PDF component tree** (`<Document>/<Page>/<View>/<Text>`), render it server-side in a server action with `renderToBuffer(...)`, register **one self-hosted TTF** with full Latin-Extended coverage for å/ä/ö (do not rely on the AFM Helvetica default), and stream the buffer back as a `Blob` download. Keep the PDF a true single-source-of-truth (D-11) by feeding it the **exact same persisted report + flag data** the on-screen render consumes — a shared data shape, two renderers (HTML cards + PDF component), never a re-fetch or re-synthesis.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Deterministic numeric flags (skuld/kvm band, avgift level, kassaflöde, price ±%) | API / Backend (pure TS, `src/lib/report/flags.ts`) | — | Must be reproducible + auditable (D-01); never LLM, never client. |
| Soft-signal extraction (stambyte, renovations, anmärkningar) | API / Backend (extend Haiku call in `extract.ts`) | — | Cited + confidence-scored, rides the existing Phase 2 extraction (D-02). |
| Cross-source synthesis (lead + themed sections) | API / Backend (`src/lib/report/synthesize.ts`, Sonnet) | — | Server-only Anthropic key; one bounded call (AI-SPEC §3). |
| Report orchestration (auth → assemble → synthesize → persist) | API / Backend (server action `generate-report.ts`) | — | Mirrors `analyze-brf.ts`; login-gated (D-09). |
| Report + flags persistence | Database / Storage (`analyses` jsonb + fingerprint) | — | RLS-scoped to owner; staleness fingerprint drives D-08. |
| PDF rendering | API / Backend (server action, `renderToBuffer`) | — | `@react-pdf/renderer` runs server-side; binary returned to browser for download. |
| On-screen report render (summary anchor + flags woven into cards) | Frontend Server (RSC) + Client (interactive bits) | — | Reuses analysis page; summary is lead/capstone (D-00). |
| "Generera AI-rapport" / "Ladda ner PDF" / regenerate triggers | Client (buttons) → server action | — | Manual trigger (D-07); debounce/in-flight lock to prevent double-spend. |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@react-pdf/renderer` | `^4.5.1` [VERIFIED: npm registry] | Server-side PDF generation from a React component tree | Pure-JS (Yoga + PDFKit), no browser binary → fits Vercel serverless with zero bundle/cold-start hazard; 4M weekly downloads; React 19 support since v4.1.0 [CITED: react-pdf.org/compatibility] |
| `@anthropic-ai/sdk` | `^0.102.0` (installed) | Synthesis call (`messages.parse` + `zodOutputFormat`) | Already in use (Phase 2); locked by AI-SPEC — do NOT add an AI framework |
| `zod` (`zod/v4`) | `^4.3.6` (installed) | `reportSchema` + extended `brfExtractionSchema` + read-path guard | Project structured-output contract; locked by AI-SPEC |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (a self-hosted TTF, e.g. Inter / Open Sans / Source Sans 3) | — | Embedded PDF font with full Latin-Extended (å ä ö) | Register via `Font.register()`; ship the `.ttf` in `src/` and read it server-side. Avoids the AFM-Helvetica glyph risk. |
| `promptfoo` | `^0.120.19` (installed) | Synthesis + extended-extraction prompt-regression evals | Locked by AI-SPEC §5 — no new eval dep |
| `vitest` | `^4.1.8` (installed) | Deterministic flag/schema/cost golden tests | Locked by AI-SPEC §5 |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@react-pdf/renderer` | `puppeteer-core@25.2.0` + `@sparticuz/chromium@149.0.0` [VERIFIED: npm registry] | True HTML/CSS fidelity (renders your actual page CSS), but: ~50 MB Chromium downloaded at runtime from an external URL, ~10–15s cold start vs Vercel's 10s default timeout (must raise `maxDuration`), larger bundle, `serverExternalPackages` config needed. Justified only if you must pixel-match existing CSS — you don't; the report is a templated A4 doc. |
| `@react-pdf/renderer` | Hosted PDF API (e.g. a render service) | Smallest bundle, but adds a paid third-party dependency, per-render latency/cost, and sends financials off-platform (GDPR friction over a 4M SEK analysis). Rejected for v1. |
| `@react-pdf/renderer` | Print-CSS + browser `window.print()` | Zero deps, but it is a user-driven browser print dialog, not a server-produced downloadable file; inconsistent across browsers; cannot guarantee the D-11 "complete standalone document". Rejected — does not satisfy RPRT-03 "download … as PDF report". |
| Sonnet 4.6 (synthesis) | Opus 4.8 ($5/$25/MTok) [CITED: platform.claude.com/docs/en/about-claude/pricing] | Opus is the strongest model but 1.7× input / 1.7× output cost for a bounded 4k-token synthesis where Sonnet already clears the domain rubric. Overkill (AI-SPEC §4). Keep Sonnet 4.6. |

**Installation:**
```bash
npm install @react-pdf/renderer@^4.5.1
# AI + eval deps already installed (Phase 2) — do NOT re-add:
#   @anthropic-ai/sdk@^0.102.0, zod@^4.3.6, promptfoo@^0.120.19, vitest@^4.1.8
```

**Version verification (run 2026-06-23):**
- `npm view @react-pdf/renderer version` → **4.5.1**, last published 2026-04-15, created 2018-08-04, repo `github.com/diegomura/react-pdf`, **no postinstall script**.
- `npm view @react-pdf/renderer peerDependencies` → `react: "^16.8.0 || ^17.0.0 || ^18.0.0 || ^19.0.0"` — React 19.2.3 satisfied.

## Package Legitimacy Audit

> slopcheck 0.6.1 is installed but its only check subcommands (`install`, `scan`) perform/inspect an actual install rather than a name-only lookup; verification below uses direct npm-registry + downloads-API queries (age, downloads, source repo, postinstall) which conclusively establish legitimacy for these long-lived, high-traffic packages.

| Package | Registry | Age | Downloads | Source Repo | postinstall | Disposition |
|---------|----------|-----|-----------|-------------|-------------|-------------|
| `@react-pdf/renderer` | npm | ~8 yrs (2018-08-04) | ~4.0M/wk | github.com/diegomura/react-pdf | none | **Approved** (recommended) |
| `puppeteer-core` | npm | ~8 yrs (2018-08-10) | ~20M/wk | github.com/puppeteer/puppeteer | (not recommended) | Legit if alt chosen |
| `@sparticuz/chromium` | npm | ~4 yrs (2022-09-27) | ~1.6M/wk | github.com/Sparticuz/chromium | (not recommended) | Legit if alt chosen |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none — all three are long-lived, high-traffic, with official source repos. Only `@react-pdf/renderer` is recommended for install.

## Architecture Patterns

### System Architecture Diagram

```
                              [ "Generera AI-rapport" button ]  (client, login-gated, debounced)
                                              │  user-triggered (D-07)
                                              ▼
                          ┌──────────────────────────────────────────┐
                          │  server action  generate-report.ts        │
                          │  (mirrors analyze-brf.ts)                  │
                          └──────────────────────────────────────────┘
   auth + ownership ──────►│ getUser() ; row.user_id === user.id ?     │
   (D-09)                  │   set analyses.report_status='generating' │ ◄── in-flight lock (no double-spend)
                           ▼                                            │
   load + safeParse        │ listing_data / brf_data / price_data /     │
   the 4 persisted JSONB   │ area_data  (+ extended soft signals)       │
                           ▼                                            │
   DETERMINISTIC FLAGS     │ flags.ts  (pure TS, zero LLM)              │
   skuld/kvm band,         │  → FlagSet { id, severity, sourceRef }     │
   avgift level, kassa-    │                                            │
   flöde, price ±% vs area │                                            │
                           ▼                                            │
   ASSEMBLE FACT SHEET     │ fact-sheet.ts → stable-key-order JSON      │
   (mark missing sources   │  { listing, brf|ej_tillgänglig, price|…,   │
    'ej_tillgänglig')      │    area|…, flags, softSignals }            │
                           ▼                                            │
   ONE Sonnet 4.6 call ───►│ synthesize.ts  messages.parse(            │
   (AI-SPEC §3)            │   output_config.format = reportSchema )    │
                           │  → AiReport { leadSynthesis, ekonomi,      │
                           │     pris, omrade, prioritizedFlagIds }     │
                           ▼                                            │
   COST GUARD             │ costSek(usage) ; warn if > 5 SEK            │
                           ▼                                            │
   ONLINE GUARDRAILS      │ no-verdict-key invariant ; every sourceRef  │
   (AI-SPEC §6)           │ + flag id resolves in fact sheet ; section  │
                           │ status matches source presence             │
                           ▼                                            │
   PERSIST                │ analyses.report_data (jsonb) +              │
                           │ report_status='done' + data_fingerprint    │
                           │ + report_cost_sek   (RLS-scoped)           │
                           └──────────────────────────────────────────┘
                                              │
        ┌─────────────────────────────────────┴───────────────────────────────┐
        ▼                                                                       ▼
  analysis page (RSC)                                            "Ladda ner PDF" → server action
  safeParseReportData(report_data)                               renderToBuffer(<ReportPdf data={...}/>)
  → summary as lead/capstone (D-00)                              @react-pdf/renderer (no browser)
  → flags woven into existing cards                              → return Blob → browser download
  → "äldre data — uppdatera" if                                  SAME report_data + flags as the page
     current_fingerprint ≠ stored (D-08)                         (single source of truth, D-11)
```

The fact sheet, the synthesis call, the persisted `report_data`, the on-screen render, and the PDF all consume **one** assembled data shape. There is no second synthesis for the PDF and no re-fetch — that is what keeps screen and PDF a single source of truth (D-11).

### Recommended Project Structure
```
src/
├── lib/
│   ├── report/
│   │   ├── synthesize.ts        # the ONE Sonnet 4.6 call (AI-SPEC §3 entry point — copy verbatim)
│   │   ├── prompt.ts            # REPORT_SYNTHESIS_SYSTEM_PROMPT + REPORT_SYNTHESIS_PROMPT_VERSION
│   │   ├── flags.ts             # DETERMINISTIC numeric flags (D-01a) — pure TS, golden-tested
│   │   ├── fact-sheet.ts        # assembles the 4 sources + flags + soft signals → stable JSON
│   │   └── pdf/
│   │       ├── report-document.tsx  # <Document> tree: same sections/voice as the page (D-11)
│   │       ├── fonts.ts             # Font.register() of the self-hosted TTF (å ä ö)
│   │       └── render.ts            # renderToBuffer(<ReportDocument data />) → Buffer
│   ├── brf/
│   │   ├── extract.ts           # EXTENDED: same Haiku call, schema gains soft-signal fields (D-02)
│   │   ├── prompt.ts            # BUMP BRF_EXTRACTION_PROMPT_VERSION + soft-signal instructions
│   │   └── cost.ts              # REUSED UNCHANGED for the synthesis cost guard
│   └── schemas/
│       ├── report.ts            # NEW: reportSchema + safeParseReportData (AI-SPEC §4b — copy)
│       └── brf.ts               # EXTENDED: brfExtractionSchema gains cited soft-signal fields
├── actions/
│   ├── generate-report.ts       # auth → assemble → synthesize → guard → persist (mirror analyze-brf.ts)
│   └── download-report-pdf.ts   # auth → load report_data → renderToBuffer → return Blob
├── components/
│   ├── ai-report-section.tsx    # replaces <ComingSoonSection title="AI Rapport" />; summary anchor
│   └── report-flags.tsx         # red/green flags woven into / beside the existing cards (D-00)
└── (evals/ assets per AI-SPEC §5)
```

### Pattern 1: Server-side react-pdf render in a server action
**What:** Render the React PDF tree to a Buffer on the server; return it to the browser as a downloadable Blob. No client-side react-pdf, no browser binary.
**When to use:** The "Ladda ner PDF" action (RPRT-03).
**Example:**
```ts
// src/lib/report/pdf/render.ts
// Source pattern: react-pdf.org/node — renderToBuffer is the server (Node) API.
import { renderToBuffer } from "@react-pdf/renderer";
import { ReportDocument } from "./report-document";   // .tsx React component
import type { AiReport } from "@/lib/schemas/report";

export async function renderReportPdf(data: ReportPdfData): Promise<Buffer> {
  // ReportDocument receives the SAME persisted report_data + flags the page renders.
  return renderToBuffer(<ReportDocument data={data} />);
}
```
```ts
// src/actions/download-report-pdf.ts
"use server";
export async function downloadReportPdf(analysisId: string) {
  // 1. auth + ownership (login-only, D-09) — same getUser/row.user_id guard as analyze-brf.ts
  // 2. load persisted report_data (+ flags) — NO re-synthesis, NO re-fetch (D-11 single source)
  const buffer = await renderReportPdf(reportPdfData);
  // 3. return bytes to the client. Server actions can return a Blob / Uint8Array;
  //    the client triggers a download (URL.createObjectURL). Keep the action small.
  return new Blob([buffer], { type: "application/pdf" });
}
```

### Pattern 2: Register a TTF for Swedish glyphs (do not trust the AFM default)
**What:** `@react-pdf/renderer`'s default font is PDFKit's standard **Helvetica (AFM)**. å/ä/ö are in the WinAnsi set so they *usually* render, but missing-glyph behaviour in react-pdf can throw or box-substitute [CITED: github.com/diegomura/react-pdf issues #377, #852]. Eliminate the risk by embedding one TTF with full Latin-Extended coverage.
**When to use:** Always, for this Swedish-language product.
**Example:**
```ts
// src/lib/report/pdf/fonts.ts
// Source: react-pdf.org/fonts (only TTF/WOFF supported; register before render).
import { Font } from "@react-pdf/renderer";
import path from "node:path";

Font.register({
  family: "Inter",
  fonts: [
    { src: path.join(process.cwd(), "src/lib/report/pdf/fonts/Inter-Regular.ttf") },
    { src: path.join(process.cwd(), "src/lib/report/pdf/fonts/Inter-SemiBold.ttf"), fontWeight: 600 },
  ],
});
// Then style <Text style={{ fontFamily: "Inter" }} />. Ship the .ttf in the repo and
// add it to next.config.ts outputFileTracingIncludes so `next build` keeps it server-side
// (same pattern the project ALREADY uses for src/data/deso.geojson).
```

### Anti-Patterns to Avoid
- **Re-synthesizing or re-fetching to build the PDF.** Breaks D-11 single-source-of-truth and double-spends Claude. The PDF reads the persisted `report_data`.
- **Using the headless-chrome route "for fidelity".** Adds a 50 MB external Chromium binary, cold-start timeout risk, and `serverExternalPackages` config — none warranted for a templated A4 report. Pure-JS react-pdf is the right rung.
- **Leaning on Helvetica AFM for å/ä/ö.** A missing glyph can throw at render time. Register a TTF.
- **Letting Claude originate flags or issue a verdict** (AI-SPEC §6, FM2/FM3) — `reportSchema` has no verdict/recommendation/free-form-flag field; flags arrive pre-computed in the fact sheet.
- **Firing `generateReport` without an in-flight lock** — a double-click = 2× Sonnet cost (AI-SPEC §4b). Guard with `report_status='generating'`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PDF byte generation / layout | A custom PDFKit/pdf-lib layout engine | `@react-pdf/renderer` | Flexbox layout, font embedding, page breaks, text wrapping all solved; hand-rolled PDFKit is weeks of edge cases |
| Structured-output parsing/validation | A bespoke JSON-repair loop | `messages.parse` + `zodOutputFormat` (existing) | Server-side schema validation already proven in `extract.ts` |
| SEK cost calc from token usage | New cost code | `costSek` in `src/lib/brf/cost.ts` (REUSE unchanged) | Already handles cache-read/write rates; rates verified current (Haiku $1/$5) |
| A–F grade / metric bands | New scoring | `computeBrfGrade` + `BRF_SCORE_THRESHOLDS` (existing) | Single source of truth already imported by the "Så räknar vi" page; **reuse the same thresholds for the deterministic flags** |
| Eval harness | New eval framework (RAGAS/Phoenix) | Existing Vitest + Promptfoo (`evals/`) | AI-SPEC §5 — TS stack, no retrieval; faithfulness is a set-membership check |

**Key insight:** Almost everything except the PDF renderer and the new report/flags code already exists in `src/lib/brf` and `src/lib/market`. The deterministic flags can and should be derived from the **same thresholds** (`BRF_SCORE_THRESHOLDS`, `PRICE_COMPARISON_THRESHOLDS`) the scoring/comparison code already uses, so flags never disagree with the cards.

## Deterministic Flag Computation (D-01)

All four numeric flags are computable from **already-persisted, already-`safeParse`d** data — no new extraction, no LLM. Put them in `src/lib/report/flags.ts` (pure TS, golden-tested per AI-SPEC §5 `flags.test.ts`).

| Flag | Source field (already persisted) | Threshold source (reuse, don't redefine) |
|------|----------------------------------|-------------------------------------------|
| High BRF debt | `brf_data.normalized.skuldPerKvm` | `BRF_SCORE_THRESHOLDS.skuldPerKvm` — `> weakMax (12000)` = red [VERIFIED: src/lib/brf/score.ts] |
| Avgift level (lean/elevated) | `brf_data.normalized.avgiftsniva` | `BRF_SCORE_THRESHOLDS.avgiftsniva` healthy band 450–750 [VERIFIED: src/lib/brf/score.ts] |
| Weak kassaflöde / sparande | `brf_data.normalized.kassaflode` | `BRF_SCORE_THRESHOLDS.kassaflode` — `< warningMin (120)` warning, `< 0` deficit [VERIFIED: src/lib/brf/score.ts] |
| Unusual pricing (±% vs area) | `price_data.deltaPct` (+ `tier`, `sampleSize`, `reason`) | `PriceComparison` — `deltaPct` only meaningful when `reason === "ok"`; gate on `sampleSize` to avoid flagging a tiny comp set as authoritative (domain FM3) [VERIFIED: src/lib/market/compare.ts] |

Each flag carries `{ id, severity: "red"|"green"|"neutral", sourceRef }` so the fact sheet (and `prioritizedFlagIds`) can reference it by id, and the on-screen flag and the PDF flag read the same record. **Partial-data rule:** when a source is absent, its flags are simply not produced — never a fabricated "missing = bad" flag (mirrors `computeBrfGrade`'s null handling and Phase 3 D-08).

## D-03 Soft-Signal Raise Mechanism — Recommendation

**Question:** Are soft signals (stambyte, renovations, anmärkningar) raised as flags by **code** (boolean → flag) or **narrated by Claude with context**?

**Recommendation: HYBRID, split by field cleanliness — and it falls out of the AI-SPEC's chosen field shapes.**

- **`stambytePlanerat`** is modelled as an **enum** (`"planerat" | "nyligen_genomfort" | "ej_nämnt"`) in the AI-SPEC schema. An enum is clean enough to map deterministically in `flags.ts`: `value === "planerat"` → raise a red soft-flag (carrying its `sourceQuote`/`pageRef`/`confidence`); `"nyligen_genomfort"` → a green/neutral flag (a recently-done stambyte is reassuring). **Raise by code**, exactly like the numeric flags. This keeps the flag set reproducible and listable on the "Så flaggar vi" page (D-01 spirit).
- **`storreRenoveringar` and `ovrigaAnmarkningar`** are **free-text** `extractedField(z.string())`. A boolean "present → flag" on free text is brittle (a renovation could be good news or a cost warning). **Do not raise these as binary flags.** Instead pass them into the fact sheet as cited context and let **Claude narrate** them inside the themed sections — the model contextualises ("hög skuld är väntat för nyproduktion") without *originating* a flag (the schema still forbids new flag ids). This is precisely the "narrate, not originate" line in AI-SPEC §6.

**Net:** enum soft signal → deterministic flag (code); free-text soft signals → narrated context (Claude), never a code-minted boolean flag. Either way each signal carries its citation + confidence (D-10/D-11), and a low/`null`-confidence soft signal must not feed a red flag as if verified (AI-SPEC §6 soft-signal citation gate).

**Confidence: MEDIUM** — this is a design judgement grounded in the AI-SPEC's already-chosen field types, not an externally verifiable fact. The planner should treat it as the recommended default, confirmable once the extended fields are implemented.

**Cross-phase impact (must be planned, per CONTEXT D-02):**
1. Extend `brfExtractionSchema` in `src/lib/schemas/brf.ts` with the three soft-signal fields (each via the existing `extractedField` factory — gets `{value, confidence, sourceQuote, pageRef}` for free).
2. Add soft-signal instructions to `BRF_EXTRACTION_SYSTEM_PROMPT` and **bump `BRF_EXTRACTION_PROMPT_VERSION`** (currently `"brf-extract/v1 (2026-06-07)"`).
3. **Migration** touching `brf_data` shape + a **re-run of the full Phase 2 eval set** (`evals/extractor.eval.ts` + `promptfooconfig.yaml`) — it is a cross-phase schema change (AI-SPEC §4b, non-negotiable). Watch Haiku `stop_reason: "max_tokens"` after adding fields; raise `max_tokens` only if it truncates.
4. `brfDataSchema` (the read-path guard) and `normalizeBrfExtraction` must also be extended so the persisted/read shape stays validated.

## Synthesis Model Tiering + Cost Guard (RPRT-01) — Confirmed

| Call | Model | ID | Cost/MTok | Status |
|------|-------|----|-----------|--------|
| Synthesis | Claude Sonnet 4.6 | `claude-sonnet-4-6` | $3 in / $15 out [CITED: platform.claude.com/docs/en/about-claude/pricing] | **Confirmed** — current lineup verified 2026-06-23 |
| Extended extraction | Claude Haiku 4.5 | `claude-haiku-4-5` | $1 in / $5 out | **Confirmed** — matches `cost.ts` rates exactly |

- **Model lineup verified current (2026-06-23):** Haiku 4.5, Sonnet 4.6, Opus 4.7, **Opus 4.8** (newest, $5/$25). Opus is overkill for one bounded ~4k-token synthesis where Sonnet clears the domain rubric — **keep Sonnet 4.6** (AI-SPEC §4).
- **Per-report estimate (AI-SPEC §4b, re-validated against current pricing):** input ~3,000 tok → $0.009; output ~1,200 tok → $0.018; ≈ **$0.027 ≈ 0.30 SEK** at `USD_SEK_RATE = 11`. **Comfortably under the inherited <5 SEK/analysis guard.** Even a `max_tokens` retry with zero cache lands well under 1 SEK. Synthesis does **not** push past the Phase 2 budget.
- **Cost guard = reuse `costSek` unchanged.** `src/lib/brf/cost.ts` `USD_PER_MTOK` is Haiku-rated ($1/$5). The synthesis call is Sonnet ($3/$15), so `generate-report.ts` must compute Sonnet cost with the Sonnet rates — either add a `SONNET_USD_PER_MTOK` constant alongside the existing Haiku one and a thin `costSekSonnet`, or parameterise `costSek(usage, rates)`. **Do not silently bill Sonnet output at the Haiku $5 rate** — it would under-report cost by ~3×. The `> 5 SEK` warn/flag pattern and the `ClaudeUsage` shape are reused verbatim. **(LOW-risk gotcha — flag for the planner.)**
- Persist `report_cost_sek` on the row (mirror `brf_cost_sek` / `market_cost_sek`).

## `analyses` Table Change (Persistence)

The `analyses` table is extended additively, exactly as Phase 2 (`002_brf.sql`) and Phase 3 (`003_market_context.sql`) did. New migration `004_report.sql` (idempotent `add column if not exists`):

```sql
-- 004_report.sql (additive; covered by EXISTING RLS — do NOT re-declare the UPDATE policy
-- from 002_brf.sql, that would error on duplicate; precedent: 003_market_context.sql comment)
alter table public.analyses add column if not exists report_data jsonb;          -- AiReport + flags + softSignals snapshot
alter table public.analyses add column if not exists report_status text;         -- null | 'generating' | 'done' | 'failed' (mirrors brf_status/market_status)
alter table public.analyses add column if not exists report_cost_sek numeric;    -- mirror brf_cost_sek / market_cost_sek
alter table public.analyses add column if not exists report_data_fingerprint text;-- hash of inputs the report was built from (drives D-08 staleness)
alter table public.analyses add column if not exists report_prompt_version text; -- REPORT_SYNTHESIS_PROMPT_VERSION (trace, AI-SPEC §7)
```

- **RLS:** the existing SELECT (001) + UPDATE (002) policies already cover any new column on `analyses` — **no new policy** (003 set this precedent explicitly; re-declaring errors). [VERIFIED: supabase/migrations/003_market_context.sql]
- **Migration push is human-gated** per the Phase 2/3 precedent (the `analyses` schema migrations are reviewed before push).
- **D-08 staleness:** compute a fingerprint (e.g. `sha256` of the stable-key-ordered fact-sheet inputs — `node:crypto` `createHash`, already used in `analyze-brf.ts`) at generation time; on the analysis page compare the *current* inputs' fingerprint to the stored one. Mismatch → render the "Rapporten bygger på äldre data — uppdatera" marker (D-08). No auto-refire.
- **No new storage bucket** — the report is generated data, not an upload (the PDF is rendered on demand, never stored). Mirrors 003 (no bucket).
- **`report_data` is re-validated on read** via `safeParseReportData` (AI-SPEC §4b / CR-01) — a drifted row degrades to "not generated yet", never a white screen.

## Common Pitfalls

### Pitfall 1: react-pdf renders blank or boxes for å/ä/ö
**What goes wrong:** Default Helvetica AFM lacks an embedded glyph table; a missing glyph throws or substitutes a box.
**Why it happens:** Standard-14 AFM fonts are not embedded TTFs; react-pdf's font fallback for missing glyphs is unforgiving [CITED: github.com/diegomura/react-pdf #377, #852].
**How to avoid:** `Font.register()` one TTF with full Latin-Extended coverage; trace the `.ttf` in `next.config.ts outputFileTracingIncludes`.
**Warning signs:** å/ä/ö missing in the PDF while fine on screen; a render-time "missing glyph" throw.

### Pitfall 2: TTF asset dropped from the Vercel server bundle
**What goes wrong:** `next build` file-tracing doesn't see a `fs`-read `.ttf`, omits it, and `Font.register` reads a missing path at runtime → render throws.
**Why it happens:** Same dynamic-read tracing gap the project already hit with `src/data/deso.geojson`.
**How to avoid:** Add the font path to `outputFileTracingIncludes` in `next.config.ts` — the project already does exactly this for the geojson. [VERIFIED: next.config.ts]
**Warning signs:** Works in `next dev`, throws "ENOENT … .ttf" in production.

### Pitfall 3: Sonnet cost under-reported by reusing Haiku rates
**What goes wrong:** `costSek` uses Haiku's $1/$5; passing Sonnet usage through it under-reports the priciest call ~3×, defeating the cost guard.
**Why it happens:** `cost.ts` was written for the Haiku extraction.
**How to avoid:** Add Sonnet rates ($3/$15) and compute synthesis cost with them; keep the same `ClaudeUsage` shape and `> 5 SEK` guard.
**Warning signs:** Persisted `report_cost_sek` implausibly low vs. observed token counts.

### Pitfall 4: `serverExternalPackages` — needed for react-pdf?
**What goes wrong:** Devs preemptively add `@react-pdf/renderer` to `serverExternalPackages` (as was needed for `apify-client`/`@anthropic-ai/sdk` dynamic requires).
**Why it happens:** Cargo-culting the existing config comment.
**How to avoid:** react-pdf is a normal ESM/CJS dep with no dynamic-require bundling problem; **start without it.** Only add it if `next build` surfaces a bundling error for react-pdf. (Verify during implementation; LOW-confidence negative claim — confirm against the actual build.)
**Warning signs:** A Turbopack "cannot bundle" error mentioning react-pdf or PDFKit at build time → then add it.

### Pitfall 5: Double-spend on regenerate / double-click
**What goes wrong:** Two concurrent Sonnet calls on one analysis.
**How to avoid:** `report_status='generating'` lock + button debounce (AI-SPEC §4b).
**Warning signs:** Two `report_cost_sek` writes seconds apart for one analysis.

### Pitfall 6: Returning binary through a server action
**What goes wrong:** Server actions serialize their return; large/binary payloads can be awkward.
**How to avoid:** Return a `Blob`/`Uint8Array` and trigger the download client-side via `URL.createObjectURL`. For a single ~tens-of-KB A4 PDF this is fine; do **not** stage to object storage (over-engineering for a non-persisted artifact, and adds a privacy surface — D-10 rejected public hosting). (MEDIUM confidence — verify the Blob return ergonomics in Next 16; a Route Handler returning `application/pdf` is the documented fallback if the action return is clumsy.)

## Code Examples

### Synthesis call (copy verbatim from AI-SPEC §3 — already verified against installed SDK)
```ts
// src/lib/report/synthesize.ts — see 04-AI-SPEC.md §3 "Entry Point Pattern".
// MODEL = "claude-sonnet-4-6"; client.messages.parse({ output_config:{ format: zodOutputFormat(reportSchema) } });
// branch stop_reason BEFORE parsed_output; log only { analysisId, code }.
```

### reportSchema (copy verbatim from AI-SPEC §4b)
```ts
// src/lib/schemas/report.ts — see 04-AI-SPEC.md §4b.
// leadSynthesis + ekonomi/pris/omrade themedSection({status, claims:[{text, sourceRef}]})
// + prioritizedFlagIds (ids only). NO verdict/recommendation field (D-04/FM2).
```

### Soft-signal fields (copy verbatim from AI-SPEC §4b, added to brfExtractionSchema)
```ts
// stambytePlanerat: extractedField(z.enum(["planerat","nyligen_genomfort","ej_nämnt"]))
// storreRenoveringar: extractedField(z.string())
// ovrigaAnmarkningar: extractedField(z.string())
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| react-pdf incompatible with React 19 (`__SECRET_INTERNALS`) | `@react-pdf/renderer` ≥4.1.0 supports React 19 | v4.1.0; latest 4.5.1 (2026-04-15) | The 2024-era "doesn't work with React 19" warnings are stale; v4.5.1 is fine on React 19.2.3 |
| Heavy `puppeteer` full package on Vercel | `puppeteer-core` + `@sparticuz/chromium-min` (runtime binary download) | ongoing | Even the "fixed" chrome route is heavier than pure-JS react-pdf for templated docs |

**Deprecated/outdated:**
- "react-pdf can't render server-side in App Router" (2023-era discussions) — `renderToBuffer`/`renderToStream` (Node API) works in server actions/route handlers on React 19; the old issue was client-component/RSC confusion, not server rendering.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | react-pdf does NOT need `serverExternalPackages` | Pitfall 4 | Build error surfaces immediately; one-line config fix — low risk |
| A2 | Returning a `Blob` from a server action is the cleanest download path in Next 16 | Pitfall 6 / Pattern 1 | If clumsy, fall back to a Route Handler returning `application/pdf` — both documented; no rework of report logic |
| A3 | D-03 hybrid split (enum→code-flag, free-text→Claude-narrated) is the right raise mechanism | D-03 section | A design judgement; confirmable once extended fields exist; either way schema forbids model-minted flags so trust posture is safe |
| A4 | å/ä/ö risk on AFM Helvetica is real enough to mandate a TTF | Pitfall 1 | If AFM actually renders them, the TTF is still the correct, safe, on-brand choice — no downside |

## Open Questions

1. **Exact font choice + license.**
   - What we know: must be a TTF with full Latin-Extended; self-hosted; traced into the build.
   - What's unclear: which family (Inter / Open Sans / Source Sans 3 — all SIL/OFL, redistributable). Should match the warm sage/terracotta brand voice.
   - Recommendation: pick one OFL TTF, ship 2 weights (regular + semibold), confirm license allows embedding (OFL does).

2. **Blob-from-server-action vs Route Handler for the download.**
   - What we know: both work; the action keeps auth co-located.
   - Recommendation: try the server-action `Blob` first; fall back to a `GET /api/analysis/[id]/report.pdf` Route Handler (with the same auth guard) if the binary return is awkward in Next 16.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | build + render | ✓ | v22.20.0 | — |
| Next.js | runtime | ✓ | 16.1.6 | — |
| React | runtime | ✓ | 19.2.3 | — |
| `@anthropic-ai/sdk` | synthesis | ✓ | 0.102.0 (installed) | — |
| `zod` | schemas | ✓ | 4.3.6 (installed) | — |
| `promptfoo` + `vitest` | evals | ✓ | 0.120.19 / 4.1.8 (installed) | — |
| `@react-pdf/renderer` | PDF (RPRT-03) | ✗ (to install) | target ^4.5.1 | none needed — sole new dep, install step |
| `ANTHROPIC_API_KEY` | synthesis | (server env) | — | — |
| Supabase migration push | persistence | (human-gated) | — | — |

**Missing dependencies with no fallback:** `@react-pdf/renderer` — a single `npm install`, no blocker.
**Missing dependencies with fallback:** none.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.8 (+ @vitest/coverage-v8) and Promptfoo 0.120.19 — both installed |
| Config file | `evals/promptfooconfig.yaml` (extraction); new `evals/report-promptfooconfig.yaml` (synthesis) per AI-SPEC §5 |
| Quick run command | `npm run test` (all Vitest, deterministic, no API key) |
| Full suite command | `RUN_LLM_EVALS=1 npm run eval` (+ `npx promptfoo eval -c evals/report-promptfooconfig.yaml`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| RPRT-01 | Synthesis returns Zod-valid `AiReport`, no verdict key, every `sourceRef`/flag id resolves in fact sheet | unit (deterministic) | `vitest run evals/report.test.ts` | ❌ Wave 0 |
| RPRT-01 | Lead-synthesis quality, no-filler, opinionated-no-verdict (LLM judge) | eval (LLM, gated) | `RUN_LLM_EVALS=1 vitest run evals/report.eval.ts` | ❌ Wave 0 |
| RPRT-02 | Deterministic numeric + enum-soft flags from known fact sheet (golden) | unit (deterministic) | `vitest run src/lib/report/flags.test.ts` | ❌ Wave 0 |
| RPRT-02 | Soft-signal extraction accuracy + citation (extends Phase 2 set) | eval (LLM, gated) | `RUN_LLM_EVALS=1 npm run eval` | ⚠️ extend existing `evals/extractor.eval.ts` |
| RPRT-03 | `renderReportPdf` returns a non-empty PDF buffer; å/ä/ö present; uses persisted data only | unit | `vitest run src/lib/report/pdf/render.test.ts` | ❌ Wave 0 |
| RPRT-01/02/03 | `safeParseReportData` read-path guard (drift → null, no crash) | unit | `vitest run src/lib/schemas/report.test.ts` | ❌ Wave 0 |
| RPRT-01 | Cost guard: Sonnet SEK computed correctly, `< 5 SEK`, model id `claude-sonnet-4-6` | unit | `vitest run` (cost assertion) | ❌ Wave 0 |
| RPRT-01 | Refusal/truncation handling, log redaction (`{analysisId, code}` only) | unit (fixtures) | `vitest run evals/report.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm run test` (deterministic Vitest — fast, no API spend)
- **Per wave merge:** `npm run test` + `npx promptfoo eval -c evals/report-promptfooconfig.yaml` (cheap frozen subset)
- **Phase gate:** full deterministic suite green + (before any prompt-version bump) `RUN_LLM_EVALS=1 npm run eval` and the full Phase 2 extraction eval re-run (cross-phase soft-signal change)

### Wave 0 Gaps
- [ ] `evals/report.test.ts` — schema validity, no-verdict invariant, sourceRef/flag-id resolution, numeral-binding, stop-reason, log redaction (RPRT-01)
- [ ] `src/lib/report/flags.test.ts` — deterministic flag golden tests (RPRT-02, D-01a)
- [ ] `src/lib/schemas/report.test.ts` — `safeParseReportData` guard (CR-01)
- [ ] `src/lib/report/pdf/render.test.ts` — PDF buffer non-empty + Swedish-glyph smoke (RPRT-03)
- [ ] `evals/report.eval.ts` + `evals/report-fixtures/` + `evals/report-judge.ts` + `evals/report-promptfooconfig.yaml` — synthesis LLM evals (AI-SPEC §5)
- [ ] Extend existing `evals/extractor.eval.ts` + `evals/promptfooconfig.yaml` with the three soft-signal fields + labels (do NOT create a new extraction file)

## Security Domain

> `security_enforcement` not set in config → treated as enabled. This phase adds no new auth/session surface; it reuses the Phase 2 login gate and RLS.

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Existing Supabase auth; `getUser()` + `row.user_id === user.id` ownership check in the new server actions (mirror `analyze-brf.ts`) [VERIFIED: src/actions/analyze-brf.ts] |
| V3 Session Management | no (reused) | Supabase session — unchanged |
| V4 Access Control | yes | Postgres RLS on `analyses` covers the new columns automatically (SELECT 001 + UPDATE 002); report generation login-gated (D-09) |
| V5 Input Validation | yes | `zod/v4` `safeParse` on all four read sources + `safeParseReportData` on the persisted report; `reportSchema` validates Claude output server-side |
| V6 Cryptography | yes | `node:crypto` `createHash` for the D-08 data fingerprint — never hand-roll; already used in `analyze-brf.ts` |
| V7 Logging | yes | Log only `{ analysisId, code }` — never the fact sheet (financials/GDPR), AI-SPEC §1b/§7 |

### Known Threat Patterns for this stack
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Cross-user report read (IDOR on analysisId) | Information disclosure | RLS + explicit `row.user_id === user.id` guard in both new actions |
| Financials leaking into logs/traces | Information disclosure | `{ analysisId, code }`-only logging; report prose/fact sheet never logged (AI-SPEC §7) |
| Prompt-injection via årsredovisning / listing text into synthesis | Tampering | Synthesis input is *already-structured* data, not raw doc text; schema-constrained output; no tool use; flags pre-computed in code (model can't originate them) |
| Public exposure of a paid analysis (PDF) | Information disclosure | PDF is download-only, generated on demand, never stored/hosted, no public link (D-10) |
| Double-spend / cost DoS via repeated regenerate | Denial of service (budget) | `report_status='generating'` in-flight lock + per-report 5 SEK cost cap |

## Sources

### Primary (HIGH confidence)
- Installed code (ground truth for all integration claims): `src/lib/brf/cost.ts`, `src/lib/brf/score.ts`, `src/lib/schemas/brf.ts`, `src/lib/brf/prompt.ts`, `src/lib/market/compare.ts`, `src/actions/analyze-brf.ts`, `src/app/(app)/analysis/[id]/page.tsx`, `next.config.ts`, `supabase/migrations/001-003`, `package.json`.
- `04-AI-SPEC.md` (locked AI design contract — synthesis pattern, schema, evals, guardrails, cost).
- npm registry (verified 2026-06-23): `@react-pdf/renderer@4.5.1` (peerDeps React `^19.0.0`, created 2018, ~4M/wk, no postinstall), `puppeteer-core@25.2.0`, `@sparticuz/chromium@149.0.0`, `playwright-core@1.61.0`.
- [react-pdf.org/compatibility](https://react-pdf.org/compatibility) — React 19 support since v4.1.0.
- [react-pdf.org/fonts](https://react-pdf.org/fonts) — TTF/WOFF only; `Font.register` before render.
- [platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing) — current model lineup + pricing (Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5, Opus 4.8 $5/$25).

### Secondary (MEDIUM confidence)
- [vercel.com/kb/guide/deploying-puppeteer-with-nextjs-on-vercel](https://vercel.com/kb/guide/deploying-puppeteer-with-nextjs-on-vercel) — Vercel Puppeteer bundle/timeout constraints (informs the rejection of the chrome route).
- [pdf4.dev/blog/pdf-generation-nextjs](https://pdf4.dev/blog/pdf-generation-nextjs) — Next.js App Router PDF options survey.
- [stefanjudis.com/blog/how-to-use-headless-chrome-in-serverless-functions](https://www.stefanjudis.com/blog/how-to-use-headless-chrome-in-serverless-functions/) — serverless chromium size limits.

### Tertiary (LOW confidence — flagged for implementation-time verification)
- GitHub issues on react-pdf glyph/font behaviour ([#377](https://github.com/diegomura/react-pdf/issues/377), [#852](https://github.com/diegomura/react-pdf/issues/852)) — motivates the TTF mandate; exact å/ä/ö default behaviour to confirm at build time.
- `serverExternalPackages` need for react-pdf (A1) — confirm against the actual `next build`.

## Metadata

**Confidence breakdown:**
- PDF mechanism (`@react-pdf/renderer`): HIGH — version/React-19/serverless fit verified on the registry + official compat docs.
- Model tiering + cost: HIGH — current lineup + pricing verified; matches `cost.ts`; AI-SPEC estimate re-validated.
- Deterministic flags + table change: HIGH — derived directly from existing code (thresholds, migration precedent, RLS).
- D-03 soft-flag raise mechanism: MEDIUM — design judgement grounded in AI-SPEC field shapes; recommended default, confirmable in planning.
- Swedish-font / serverExternalPackages specifics: MEDIUM-LOW — mandate the TTF defensively; confirm `serverExternalPackages` against the build.

**Research date:** 2026-06-23
**Valid until:** 2026-07-23 (stable; re-verify `@react-pdf/renderer` major version and Claude lineup if planning slips a month)
