# Phase 8: BRF Auto-Fetch - Pattern Map

**Mapped:** 2026-07-06
**Files analyzed:** 13 (new + modified)
**Analogs found:** 13 / 13

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|---------------|
| `src/lib/brf/run-extraction.ts` (NEW — shared core extracted from `analyze-brf.ts`) | service | request-response | `src/actions/analyze-brf.ts` (its own body) | exact (refactor, not new pattern) |
| `src/actions/analyze-brf.ts` (MODIFIED — thin wrapper) | controller (server action) | request-response | itself (pre-refactor) | exact |
| `src/actions/fetch-brf-auto.ts` (NEW — `resolveOrgNr` + `fetchArsredovisning` actions) | controller (server action) | request-response | `src/actions/analyze-brf.ts` (auth/ownership gate shape) | role-match |
| `src/lib/brf/extract.ts` (MODIFIED — accept `{kind:"pdf"\|"ixbrl-text"}`) | service | transform | itself (pre-change) | exact |
| `src/lib/brf/ixbrl-to-text.ts` (NEW) | utility | transform | `src/lib/broker/parse-broker-page.ts` | exact (cheerio DOM→text) |
| `src/lib/brf-source/org-nr-resolver.ts` (NEW) | service | request-response | `src/lib/broker/fetch-broker-page.ts` + `url-guard.ts` | role-match (external lookup + validation gate) |
| `src/lib/brf-source/bolagsverket.ts` (NEW, optional Rung 0/deferred) | service | request-response | `src/lib/broker/fetch-broker-page.ts` | role-match |
| `src/lib/brf-source/allabrf.ts` (NEW) | service | request-response | `src/lib/broker/fetch-broker-page.ts` + `parse-broker-page.ts` | exact (SSRF-guarded fetch + cheerio parse) |
| `src/lib/brf-source/fetch-document.ts` (NEW — fallback tree walker) | service | event-driven (rung fallback) | `src/lib/booli/fallback-tree.ts` + `src/lib/booli/client.ts` (call sites) | role-match (needs generalization, see below) |
| `src/components/brf-confirm.tsx` (NEW — `BrfMatchConfirmation`) | component | request-response | `src/components/brf-section.tsx` (failed-view banner + Card patterns) | role-match |
| `src/components/brf-progress.tsx` (MODIFIED — add `auto_fetching` pre-steps / NEW `BrfAutoFetchProgress`) | component | streaming (poll) | itself (pre-change) | exact |
| `src/components/brf-section.tsx` (MODIFIED — new confirm branch) | component (orchestrator) | request-response | itself (pre-change) | exact |
| `src/components/brf-score-card.tsx` (MODIFIED — fiscal-year + provenance header) | component | request-response | `src/components/listing-summary.tsx` (`SOURCE_CAPTIONS`/`sourceCaptionFor`) | role-match |
| `supabase/migrations/009_brf_auto_fetch.sql` (NEW) | migration | batch (DDL) | `supabase/migrations/008_macro_snapshots_write_check.sql` + `002_brf.sql` | exact (additive-nullable convention) |

## Pattern Assignments

### `src/lib/brf/run-extraction.ts` (service, request-response)

**Analog:** `src/actions/analyze-brf.ts` (lines 155-328, the current `analyzeBrf` body)

**What moves verbatim into the new shared function** (do not re-derive — cut/paste + generalize the entry point):
- Hash cache check — lines 196-209 (`hashBytes`, D-06 skip-Claude cache via `row.brf_pdf_hash === contentHash` + `safeParseBrfData`)
- Status writes — lines 232-235 (`extracting` + `scanned`) and line 291-294 (`scoring`)
- `extractBrfFinancials` call + cost-cap gate + schema gate — lines 239-288
- Deterministic pipeline call — `scoreExtraction()` (lines 111-146, already a standalone helper — keep as-is, just also move/co-locate)
- Terminal persist (`done` + `brf_cost_sek` + `brf_pdf_hash` + `brf_scanned`) — lines 306-325
- `writeFailedStatus` helper — lines 82-100 (unchanged, reused by both PDF and iXBRL branches)

**What must branch on `source.kind`** (the ONLY new fork point, per RESEARCH Pattern 1):
- `detectScanned(bytes)` (line 57-64) only applies to `source.kind === "pdf"` — for `"ixbrl-text"`, `brf_scanned` should be hard-set `false` (iXBRL is always digitally native, never a scan).
- The `uploadBrfPdf` call (lines 212-225) is PDF-only — an iXBRL-sourced document has no bytes-to-store-as-PDF; storage of the auto-fetched source document (if desired for audit) needs a separate decision, or can be skipped for v1 (store only the extracted text hash, not the raw HTML).
- `hashBytes(bytes)` needs a text-hash equivalent for iXBRL: `createHash("sha256").update(text, "utf8").digest("hex")` — same D-06 cache semantics, different input type.

**Signature to build** (from RESEARCH Code Examples, cross-checked against the real file):
```typescript
// New source union — the ONLY discriminator threaded through extract.ts + run-extraction.ts
export type BrfDocumentSource =
  | { kind: "pdf"; bytes: Uint8Array }
  | { kind: "ixbrl-text"; text: string };

// analysisId + userId + source + fetchSource (for brf_fetch_source persistence)
export async function runBrfExtraction(
  analysisId: string,
  userId: string,
  source: BrfDocumentSource,
  fetchSource: "manual" | "auto_bolagsverket" | "auto_allabrf",
): Promise<AnalyzeBrfResult>
```

**Auth/ownership pattern to preserve exactly** (lines 174-193 — this stays in the THIN `analyzeBrf` wrapper AND must be duplicated/reused identically in `fetch-brf-auto.ts`'s actions, never skipped for the auto path):
```typescript
const supabase = await createClient();
const { data: { user } } = await supabase.auth.getUser();
if (!user) {
  return { ok: false, error: "Logga in för BRF-analys" };
}
const { data: row, error: rowError } = await supabase
  .from("analyses")
  .select("id, user_id, brf_pdf_hash, brf_data")
  .eq("id", analysisId)
  .single();
if (rowError || !row || row.user_id !== user.id) {
  return { ok: false, error: "Analysen hittades inte." };
}
```

**Error-code discipline to reuse** (lines 270-288): catch → log `{ analysisId, contentHash, code }` only (never bytes/financials) → `writeFailedStatus` → Swedish user message. Apply identically for iXBRL failures (extract.ts's coded errors are format-agnostic already).

---

### `src/actions/analyze-brf.ts` (MODIFIED — thin wrapper)

**Analog:** itself, pre-refactor

**Core pattern:** After refactor, `analyzeBrf(formData)` keeps ONLY: form parsing (lines 156-172), auth/ownership gate, PDF-specific validation (`file.type`, `MAX_PDF_BYTES`), `uploadBrfPdf` call, then delegates to `runBrfExtraction(analysisId, user.id, { kind: "pdf", bytes }, "manual")`. `correctBrfField` (lines 339-453) is UNCHANGED — it never touches extraction and has no auto-fetch equivalent.

---

### `src/actions/fetch-brf-auto.ts` (controller, request-response)

**Analog:** `src/actions/analyze-brf.ts` (auth/ownership block, lines 174-193) + RESEARCH Pattern 2

**Core pattern — confidence-gated discriminated result** (copy the shape, not the content):
```typescript
export type OrgNrResolution =
  | { confidence: "high"; orgNr: string; matchedName: string }
  | { confidence: "low"; candidates: Array<{ orgNr: string; name: string }> }
  | { confidence: "none" };
```
Every server action here must open with the SAME `"use server"` directive + auth gate + row ownership check as `analyzeBrf` (copy lines 174-193 verbatim, adjusted for whatever columns this action needs). Never expose an auto-fetch action reachable without `user.id === row.user_id`.

**Status write pattern to add:** write `brf_status: "auto_fetching"` before starting resolution/fetch, mirroring `analyzeBrf`'s `.update({ brf_status: "extracting", ... }).eq("id", analysisId)` shape (lines 232-235).

---

### `src/lib/brf/ixbrl-to-text.ts` (utility, transform)

**Analog:** `src/lib/broker/parse-broker-page.ts` (lines 1-31, 124-140)

**Imports pattern:**
```typescript
import * as cheerio from "cheerio";
```

**Core pattern** (mirrors `parseBrokerPage`'s try/catch-never-throws discipline, lines 124-140):
```typescript
export function ixbrlToPlainText(ixbrlHtml: string): string {
  const $ = cheerio.load(ixbrlHtml, { xmlMode: false });
  $("script, style").remove();
  return $("body").text().replace(/\s+/g, " ").trim();
}
```
Follow `parseBrokerPage`'s convention: wrap in try/catch, return an honest empty/null result rather than throwing, so a malformed iXBRL document degrades to "no text extracted" → falls through to manual upload, exactly like a broker-page parse failure falls through to "no broker fields" (never blocks the primary flow).

---

### `src/lib/brf-source/allabrf.ts` (service, request-response)

**Analog:** `src/lib/broker/fetch-broker-page.ts` (full file, lines 1-69) + `src/lib/broker/url-guard.ts` (full file)

**Imports pattern** (lines 1-3 of fetch-broker-page.ts):
```typescript
import { Agent } from "undici";
import { resolveSafeExternalUrl } from "@/lib/broker/url-guard"; // REUSE, don't fork
```

**SSRF-guard discipline to copy exactly** (fetch-broker-page.ts lines 29-68): resolve-then-pin pattern — `resolveSafeExternalUrl` resolves DNS exactly once, then a per-request `undici.Agent` with `connect.lookup` pins the actual TCP target to that resolved address (prevents DNS-rebinding TOCTOU). `redirect: "manual"` + treat any 3xx/opaqueredirect as failure. Every failure path returns `null`/throws a coded, non-silent result — **never** silently returns "not found" without a log line.

```typescript
const resolved = await resolveSafeExternalUrl(url);
if (!resolved) { console.error("[allabrf]", `rejected unsafe URL: ${url}`); return null; }
const pinnedAgent = new Agent({
  connect: { lookup: (_h, _o, cb) => cb(null, [{ address: resolved.address, family: resolved.family }]) },
});
const res = await fetch(url, { redirect: "manual", dispatcher: pinnedAgent } as RequestInit);
```

**Decision needed (flag for planner):** `url-guard.ts`'s `resolveSafeExternalUrl` is generic over any external hostname already (no Booli-specific coupling) — this file can `import` it directly from `@/lib/broker/url-guard` with ZERO modification. Do not fork/copy the guard logic; only `fetch-broker-page.ts`'s call-site orchestration is analog material to copy, not the guard itself.

**Parse layer:** reuse `src/lib/broker/parse-broker-page.ts`'s JSON-LD-first/DOM-fallback pattern (lines 41-63, 86-98) as the shape to follow when scraping Allabrf's HTML search-result pages — same `cheerio.load` + try/catch-per-block discipline, same "never throw on malformed input" contract.

---

### `src/lib/brf-source/org-nr-resolver.ts` (service, request-response)

**Analog:** `src/lib/broker/url-guard.ts` (validation-gate shape) + RESEARCH Pattern 2/Pitfall 4

**Core pattern:** a strict input-validation gate BEFORE any external call, mirroring `url-guard.ts`'s "fail closed, never assume safe" discipline (lines 66-70, 100-108) — applied here to org.nr format validation (10-digit Luhn-style checksum) instead of IP classification. Per RESEARCH's Security Domain (V5 Input Validation): validate org.nr format strictly before it is ever interpolated into an outbound Allabrf/Bolagsverket URL — same SSRF-adjacent discipline class as `resolveSafeExternalUrl`.

**Confidence gate result type:** see `OrgNrResolution` above (fetch-brf-auto.ts pattern) — this module RETURNS that type; the action layer just forwards it.

---

### `src/lib/brf-source/fetch-document.ts` (service, event-driven fallback)

**Analog:** `src/lib/booli/fallback-tree.ts` (full file, 69 lines) + call sites in `src/lib/booli/client.ts` (lines 352-357, 423-427)

**CRITICAL — do not reuse `walkFallbackTree` verbatim.** Its `FallbackResult<T>["source"]` field (line 29) is a **fixed literal union** `"own-playwright" | "own-playwright-retry" | "paid-actor"` — hardcoded to Booli's specific rungs, not generic. Phase 8 needs `"bolagsverket" | "allabrf"` (or just `"allabrf"` for v1, per RESEARCH's Open Question 2 recommendation to defer Bolagsverket bulk-feed ingestion).

**Two options** (RESEARCH Pattern 3 — planner must pick one, prefer (a) if trivial):
- (a) Generalize `walkFallbackTree<T>`'s `source` field to a generic string type parameter, updating `client.ts`'s call sites to pass their literal type as before (TypeScript narrows string literals passed to a generic param — safe, 1-line signature change). **Read `src/lib/booli/fallback-tree.test.ts` before committing to this** — it may assert on the literal union type directly.
- (b) Write a small phase-8-local rung walker in `fetch-document.ts` mirroring the exact same shape/logging convention (lines 42-68) without touching the Booli file, to avoid destabilizing Phase 5's tested code.

**Discipline to copy regardless of (a)/(b) choice** (lines 42-68):
```typescript
// Try each rung in order; log `[<namespace>] rung N (<source>) failed` on
// every throw; NEVER silently return empty/undefined when all rungs are
// exhausted — throw a distinguishable Swedish error instead.
if (rungs.length > 3) {
  throw new Error("<walker> supports at most 3 rungs");
}
let lastError: unknown;
for (let i = 0; i < rungs.length; i++) {
  try {
    const data = await rungs[i].attempt();
    return { data, source: rungs[i].source, rung: (i + 1), health: i === 0 ? "ok" : "degraded" };
  } catch (error) {
    console.error(`[brf-source] rung ${i + 1} (${rungs[i].source}) failed`, error);
    lastError = error;
  }
}
throw new Error(`Alla arsredovisningskallor misslyckades: ...`);
```
Given RESEARCH's v1-scope decision (defer Bolagsverket bulk-feed ingestion), the actual rung list for v1 is likely just `[{source:"allabrf", attempt: fetchFromAllabrf}]` — a single-rung "tree" that still uses the same discipline so a future Bolagsverket rung slots in without restructuring.

---

### `src/components/brf-confirm.tsx` (component, request-response) — NEW `BrfMatchConfirmation`

**Analog:** `src/components/brf-section.tsx` (failed-view Card/banner pattern, lines 134-158) + UI-SPEC Component Inventory §1

**Imports pattern** (mirrors brf-section.tsx lines 1-11):
```typescript
"use client";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
```

**Core layout pattern** (per UI-SPEC §1, styled like `listing-summary.tsx`'s `MetricCard`):
- `Card` (`w-full max-w-2xl border-warm-gray-200`) — identical container class to `BrfProgress`/`BrfSection`'s failed-view Card.
- Detail rows: `rounded-lg bg-warm-gray-50 p-4` blocks, uppercase label + semibold value (copy `listing-summary.tsx`'s `MetricCard` styling — read that file if the exact class string is needed at implementation time; not reproduced here since it's referenced but not opened in this pass).
- Two-button row: confirm = `bg-sage-600 text-white hover:bg-sage-700 h-11 px-6` (exact class string copied from `brf-section.tsx` line 80's CTA), reject = `variant="outline" h-11 px-6` (equally sized, per UI-SPEC — never `variant="ghost"` or smaller).

**Error/banner pattern to copy** (brf-section.tsx lines 137-141 — the terracotta banner convention referenced by UI-SPEC for the "ambiguous match" fallback banner):
```typescript
<div className="rounded-t-xl bg-terracotta-50 px-6 py-3">
  <p className="text-sm text-terracotta-600">{message}</p>
</div>
```

---

### `src/components/brf-progress.tsx` (MODIFIED) / new `BrfAutoFetchProgress`

**Analog:** itself (full file, 154 lines) — copy the ENTIRE poll/step-indicator pattern unchanged, just with a different `STEPS` array and status set.

**Reusable constants verbatim** (lines 16, 25):
```typescript
const POLL_MS = 1500;
const MAX_POLL_MS = 90_000;
```

**Step-dot rendering pattern to copy exactly** (lines 114-149) — `done`/`isActive`/pending three-state styling (`bg-sage-600 text-white` / `bg-sage-100 text-sage-700` + spinner / `bg-warm-gray-100 text-warm-gray-400`) is the UI-SPEC-mandated visual contract for `BrfAutoFetchProgress` too (UI-SPEC §2 says "copy the visual pattern, not the component" — i.e., duplicate this JSX block with new STEPS/labels, don't try to parametrize the existing component beyond what's needed).

**New STEPS array** (per UI-SPEC Copywriting Contract): `"Söker organisationsnummer…"` → `"Hämtar dokument…"` → `"Förbereder analys…"`, prepended/separate from the existing 3-step list (never merge into one 6-step list — two distinct sequences, per UI-SPEC).

**Poll target:** same `createClient()` + `.from("analyses").select("brf_status").eq("id", analysisId).single()` shape (lines 57-63), just also stops on `brf_status === "auto_fetching"` transitioning OUT (to `reading`/`failed`), not just `done`/`failed`.

---

### `src/components/brf-section.tsx` (MODIFIED — new confirm branch)

**Analog:** itself — the `View` union + `initialView()` dispatcher pattern (lines 27-34) is the exact shape to extend.

**Core pattern to extend:**
```typescript
type View = "upload" | "confirm" | "auto-fetching" | "progress" | "result" | "failed";
```
Insert a `"confirm"` branch following the SAME early-return-per-view structure already used for `"progress"`/`"result"`/`"failed"` (lines 88-158) — render `<BrfMatchConfirmation ... onConfirm={...} onReject={() => setView("upload")} />`. Reject must land on the exact same `"upload"` view with **zero** intermediate friction (UI-SPEC §1/§3), i.e. `setView("upload")` — nothing more, no confirmation dialog.

The guest-teaser early return (lines 59-86) stays first/unconditional — auto-fetch must never be attempted before the guest gate, same D-05 defense-in-depth posture.

---

### `src/components/brf-score-card.tsx` (MODIFIED — fiscal-year + provenance header)

**Analog:** `src/components/listing-summary.tsx`'s `SOURCE_CAPTIONS`/`sourceCaptionFor` convention (referenced in UI-SPEC lines 79, 107-109, 134 — not opened directly in this pass; the planner/executor should grep `sourceCaptionFor` in `listing-summary.tsx` for the exact caption-rendering helper signature before implementing, since UI-SPEC explicitly says to reuse its styling verbatim: `text-xs text-warm-gray-500`).

**Pattern to add:** a small header row using the existing `gradeCaption`-style caption class (`text-sm text-warm-gray-500`) for "Räkenskapsår {year}", plus a `text-xs text-warm-gray-500` provenance line beneath it ("Källa: Bolagsverket"/"Källa: Allabrf"/"Källa: Manuellt uppladdad") — and a conditional terracotta staleness caption (`text-terracotta-600`, same class family as `brf-section.tsx`'s failed-banner text) scoped inline to the fiscal-year field only, not a full-card banner (per UI-SPEC §4, distinguishing this from the existing `scanned` full-banner treatment).

---

### `supabase/migrations/009_brf_auto_fetch.sql` (migration, batch/DDL)

**Analog:** `supabase/migrations/002_brf.sql` (additive-column convention, lines 5-15) + `008_macro_snapshots_write_check.sql` (header-comment convention explaining WHY a new migration vs editing an existing one)

**Core pattern — additive-nullable columns, `if not exists` guards** (002_brf.sql lines 11-15):
```sql
-- 009_brf_auto_fetch.sql — Phase 8 additive columns (never edit 002_brf.sql —
-- already applied/pushed; see .claude memory "Supabase migration already
-- applied": db push won't re-run an already-applied migration).
alter table public.analyses add column if not exists brf_fetch_source text;
-- brf_status gains a new transient value 'auto_fetching' — brf_status is a
-- plain `text` column (no enum/check constraint in 002_brf.sql), so no DDL
-- is needed to add the new status value; only the application code
-- (brf-progress.tsx STEPS, brf-section.tsx View union) needs updating.
```
**IMPORTANT:** confirm there is no `check` constraint on `brf_status` before assuming this — `002_brf.sql` line 12 shows `brf_status text` with NO check constraint, so the new `'auto_fetching'` value requires zero DDL. If a later migration (003-008) added a check constraint on `brf_status` that this pass didn't scan, the planner must grep for `brf_status.*check` across all migrations before finalizing 009.

**Header-comment convention to copy** (008's lines 1-10 style): explain what changed, why a new file (not editing 002), and cross-reference the RESEARCH/CONTEXT decision driving it.

## Shared Patterns

### Auth + Ownership Gate
**Source:** `src/actions/analyze-brf.ts` lines 174-193 (also lines 356-373 in `correctBrfField`)
**Apply to:** `fetch-brf-auto.ts`'s `resolveOrgNr`/`fetchArsredovisning` actions, and the refactored `runBrfExtraction` entry point. Every new server action in this phase must open with the identical `supabase.auth.getUser()` → `if (!user) return {ok:false,...}` → row ownership `.eq("id", analysisId).single()` → `row.user_id !== user.id` check sequence. No auto-fetch path may skip this (RESEARCH Security Domain V4).

### SSRF-Guarded External Fetch
**Source:** `src/lib/broker/url-guard.ts` (full file — import `resolveSafeExternalUrl` directly, do not fork) + `src/lib/broker/fetch-broker-page.ts` lines 29-68 (pin-then-fetch orchestration)
**Apply to:** `src/lib/brf-source/allabrf.ts` and any Bolagsverket HTTP client. Resolve DNS once, pin the connection via `undici.Agent`, `redirect: "manual"`, treat every failure as a `null`/logged-and-continue result, never throw uncaught.

### Status-Write + Poll Cadence
**Source:** `src/actions/analyze-brf.ts` lines 232-235, 291-294 (server writes) + `src/components/brf-progress.tsx` lines 16, 25, 57-97 (client poll)
**Apply to:** the new `auto_fetching` status write in `fetch-brf-auto.ts` and its corresponding poll extension in `brf-progress.tsx`/`BrfAutoFetchProgress`. Reuse `POLL_MS = 1500` / `MAX_POLL_MS = 90_000` verbatim — do not invent new timing constants.

### Coded-Error / GDPR-Safe Logging
**Source:** `src/lib/brf/extract.ts` lines 309-334 (`KNOWN_EXTRACTION_CODES`, `isKnownExtractionCode`) + `src/actions/analyze-brf.ts` lines 270-288
**Apply to:** `org-nr-resolver.ts`, `allabrf.ts`, `fetch-document.ts` — log only stable codes/hashes/ids server-side, never raw scraped HTML, financial figures, or PII; rethrow coded errors so the action layer can produce distinct Swedish messages.

### Terracotta Failure Banner
**Source:** `src/components/brf-section.tsx` lines 137-141
**Apply to:** `BrfMatchConfirmation`'s ambiguous-match fallback banner and `BrfAutoFetchProgress`'s timeout message — `<div className="rounded-t-xl bg-terracotta-50 px-6 py-3"><p className="text-sm text-terracotta-600">...</p></div>` is the ONLY warning-banner convention in this codebase (UI-SPEC confirms: no `Alert` primitive exists, do not introduce one).

## No Analog Found

None — every file identified from CONTEXT/RESEARCH/UI-SPEC has at least a role-match analog in the existing codebase. The one open design decision (not a missing analog) is whether `fallback-tree.ts` is generalized in place or forked locally — see `fetch-document.ts` entry above; the planner must read `src/lib/booli/fallback-tree.test.ts` before deciding, per RESEARCH Pattern 3.

## Metadata

**Analog search scope:** `src/actions/`, `src/lib/brf/`, `src/lib/broker/`, `src/lib/booli/`, `src/components/`, `supabase/migrations/`
**Files scanned:** 11 read in full (analyze-brf.ts, extract.ts, fallback-tree.ts, fetch-broker-page.ts, url-guard.ts, parse-broker-page.ts, brf-progress.tsx, brf-section.tsx, 002_brf.sql, 008_macro_snapshots_write_check.sql, booli/client.ts excerpt)
**Pattern extraction date:** 2026-07-06
