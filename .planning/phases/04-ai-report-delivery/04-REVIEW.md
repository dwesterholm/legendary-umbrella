---
phase: 04-ai-report-delivery
reviewed: 2026-06-26T12:11:10Z
depth: standard
files_reviewed: 24
files_reviewed_list:
  - src/actions/generate-report.ts
  - src/actions/download-report-pdf.ts
  - src/lib/report/synthesize.ts
  - src/lib/report/prompt.ts
  - src/lib/report/flags.ts
  - src/lib/report/fact-sheet.ts
  - src/lib/report/pdf/render.ts
  - src/lib/report/pdf/report-document.tsx
  - src/lib/report/pdf/fonts.ts
  - src/lib/schemas/report.ts
  - src/lib/schemas/brf.ts
  - src/lib/brf/prompt.ts
  - src/lib/brf/cost.ts
  - src/components/ai-report-section.tsx
  - src/components/report-flags.tsx
  - src/app/(app)/analysis/[id]/page.tsx
  - src/app/page.tsx
  - supabase/migrations/004_report.sql
  - next.config.ts
  - vitest.config.ts
  - src/actions/generate-report.test.ts
  - src/actions/download-report-pdf.test.ts
  - src/lib/report/pdf/render.test.ts
  - evals/report.test.ts
findings:
  critical: 1
  warning: 6
  info: 4
  total: 11
status: issues_found
---

# Phase 4: Code Review Report

**Reviewed:** 2026-06-26T12:11:10Z
**Depth:** standard
**Files Reviewed:** 24
**Status:** issues_found

## Summary

Reviewed the AI report-generation + PDF-delivery phase against the five focus areas: the
auth/ownership gates, GDPR-safe logging, the Sonnet cost guard, the no-verdict/no-originated-flag
prompt discipline, and the read-path `safeParse` degradation.

The security posture is genuinely strong. The two server actions both enforce the D-09 auth gate
and a second-layer ownership check before any spend or any render — verified against the test
suites, which cover the no-user, wrong-user, and missing-row paths and assert that the expensive
downstream call is never reached. GDPR-safe logging is implemented and *tested* (the synthesis
redaction tests prove the fact sheet never reaches a log line). The cost guard is correctly
Sonnet-rated (`costSekSonnet`, $3/$15) and refuses to persist over cap. The report schema makes
the verdict field unrepresentable (D-04) and the prompt forbids minting flags.

However, the most important defect is a **persistence/state bug on the regenerate path**: an
over-cap or failed *regeneration* leaves the stale `report_data` persisted while only flipping
`report_status` to `failed`, and the page has no branch that surfaces this — the user keeps seeing
the old report with no failure signal, and the cost-cap "abort" is silently undone from the user's
perspective. There are also several robustness gaps around the in-flight lock (TOCTOU + unchecked
write), a hallucinated-`prioritizedFlagIds` path that can hide *real* deterministic flags from the
UI, and a dead import that will likely fail the project's lint/build.

No structural findings block was provided for this review.

## Critical Issues

### CR-01: Failed/over-cap regeneration leaves a stale report persisted with no user-visible failure signal

**File:** `src/actions/generate-report.ts:231-249`, `src/app/(app)/analysis/[id]/page.tsx:132-164`, `src/components/ai-report-section.tsx:158-216`

**Issue:** `generateReport` is the regenerate path for a stale report (the "Uppdatera rapporten"
button calls the same action — `ai-report-section.tsx:211`). On the over-cap branch
(`generate-report.ts:231-237`) and the synthesis-failure branch (`:241-249`), the action writes
`report_status: "failed"` (and, for over-cap, `report_cost_sek`) but **never clears the
previously-persisted `report_data`**. The DB row therefore ends with `report_status = "failed"`
*and* a fully-populated, now-stale `report_data`.

The analysis page then reads that row: `safeParseReportData(analysis.report_data)` returns the
*old* report (non-null), and the page passes it straight to `AiReportSection` together with
`reportStatus="failed"` (`page.tsx:106, 162`). `AiReportSection` has **no `failed` branch** — its
`isGenerating` is `false`, `report` is non-null, so it renders the OLD report as if nothing went
wrong (`ai-report-section.tsx:189-272`). The user sees a normal, healthy report after a
regeneration that actually failed or was killed by the cost cap. The whole point of the cost-cap
abort ("no silent overspend persisted as a usable report", per the doc comment at `:226-229`) is
defeated on the regenerate path, and a genuine synthesis failure is rendered as success.

This is a correctness/data-integrity defect: the persisted state (`failed` + a stale report) is
internally inconsistent, and the UI silently presents stale/failed output as a current result. It
also undermines the staleness contract — the stale marker that triggered the regenerate is still
based on the OLD fingerprint, so the user can be told "this is fresh" when the regeneration that
was supposed to refresh it failed.

**Fix:** Surface the failed status in the UI and/or keep the persisted state consistent. Minimal,
correct fix is a `failed` branch in the component plus passing the status through unambiguously:

```tsx
// ai-report-section.tsx — before the "report present" anchor render:
const isFailed = reportStatus === "failed";
if (isFailed) {
  return (
    <Card /* ... */>
      <CardContent>
        <p className="text-sm text-terracotta-600">
          Den senaste rapportgenereringen misslyckades. Försök igen.
        </p>
        <Button type="button" disabled={isGenerating} onClick={triggerGenerate}>
          {isGenerating ? "Genererar rapport…" : "Försök igen"}
        </Button>
        {report && /* optionally still show the prior report, but clearly labelled stale/old */ null}
      </CardContent>
    </Card>
  );
}
```

Alternatively (or additionally) make the persisted state consistent in the action — on the
over-cap / failure branches, do not leave a `done` snapshot masquerading: either keep the prior
`report_data` but ensure the page treats `report_status === "failed"` as authoritative (the UI
fix above), or, for a first generation, the current behaviour is already fine. The key invariant
to restore: **`report_status === "failed"` must never render as a clean, current report.**

## Warnings

### WR-01: In-flight lock has a TOCTOU race and ignores its own write error — double-spend still possible

**File:** `src/actions/generate-report.ts:180-191`

**Issue:** The "lock" is a read-then-write with no atomicity: `:180` checks
`row.report_status === "generating"` (read at `:166-172`), and `:188-191` later writes
`generating`. Two concurrent `generateReport(analysisId)` calls can both read a non-`generating`
status, both pass the guard, both write `generating`, and both fire the (priciest) Sonnet call —
exactly the double-spend the lock exists to prevent (RESEARCH Pitfall 5 / T-04-14). The comment at
`:178-179` claims the lock prevents this, but the implementation cannot, because the check and the
set are separate statements against a row with no compare-and-swap. Additionally, the lock-acquire
write at `:188-191` discards its result — if that update fails (RLS, transient DB error), the code
proceeds to spend on Sonnet anyway and the page's poller never sees `generating`.

**Fix:** Make the acquire atomic and conditional, and check its result. A conditional update that
only flips `null/done/failed → generating` and returns the affected row lets you detect "someone
else holds the lock":

```ts
const { data: locked, error: lockErr } = await supabase
  .from("analyses")
  .update({ report_status: "generating" })
  .eq("id", analysisId)
  .neq("report_status", "generating") // CAS: only when not already locked
  .select("id")
  .maybeSingle();
if (lockErr) { /* fail closed with a Swedish error */ }
if (!locked) {
  return { ok: false, error: "En AI-rapport genereras redan. Vänta ett ögonblick." };
}
```

### WR-02: Hallucinated `prioritizedFlagIds` can hide ALL real deterministic flags from the on-screen UI

**File:** `src/components/ai-report-section.tsx:235-245`, `src/components/report-flags.tsx:74-75`

**Issue:** The schema (`report.ts:54-58`) lets Claude return any string array for
`prioritizedFlagIds`; the prompt forbids minting ids but nothing *enforces* it. When the report is
rendered, the component passes `only={ai.prioritizedFlagIds}` to `ReportFlags`
(`ai-report-section.tsx:239-243`), and `ReportFlags` does
`flags.filter((f) => only.includes(f.id))` (`report-flags.tsx:74`). If the model returns a
non-empty `prioritizedFlagIds` that contains only ids NOT present in the deterministic `flags`
(e.g. a hallucinated `"brf_solid"`), the filter yields an empty set and `ReportFlags` returns
`null` (`report-flags.tsx:75`) — so **every real, code-raised flag (including red warning flags)
disappears from the screen**, even though correct flags exist. The PDF renderer handles this more
robustly (`report-document.tsx:185-191` appends the `remaining` flags), so screen and PDF can
disagree about which flags are shown — a D-11 "same experience" violation.

**Fix:** Mirror the PDF's robust ordering in the UI: render prioritized-then-remaining instead of
filtering to the priority list, and intersect the priority list with the real flag ids:

```tsx
// Only keep ids that actually resolve to a real flag, then show prioritized first + the rest.
const realIds = new Set(flags.map((f) => f.id));
const priority = ai.prioritizedFlagIds.filter((id) => realIds.has(id));
// pass an ordering hint to ReportFlags (or reorder here) — never let priority hide real flags.
```

### WR-03: Cost guard uses pre-validation usage — a malformed report that fails `reportSchema.parse` still charges, but cost is discarded

**File:** `src/actions/generate-report.ts:230-240`

**Issue:** The cost is computed and the cap is evaluated at `:230-237`, but `reportSchema.parse`
runs *after* at `:240`. If the parse throws (the Sonnet output drifted from the schema despite
structured output), control jumps to the `catch` at `:241`, which writes `failed` with **no
`report_cost_sek`** — so a real, billed Sonnet call that produced unparseable output records zero
cost against the analysis. The over-cap branch records `report_cost_sek` but the parse-failure
branch does not, so per-analysis cost accounting silently under-counts exactly the failure mode
most likely to be retried (and re-billed). For a budget-guard feature this is a correctness gap in
the accounting it exists to provide.

**Fix:** Persist the incurred cost on the parse-failure path too:

```ts
} catch (error) {
  const code = error instanceof Error ? error.message : "UNKNOWN";
  console.error("[generateReport]", { analysisId, code });
  // record the spend we actually incurred, if we got far enough to have it
  await writeFailedStatus(supabase, analysisId, sek != null ? { report_cost_sek: sek } : {});
  return { ok: false, error: messageForCode(code) };
}
```
(Compute `sek` before the `reportSchema.parse` call — it already is — and hoist it so the catch can see it.)

### WR-04: Dead `Badge` import in `ai-report-section.tsx` — will fail lint / strict build

**File:** `src/components/ai-report-section.tsx:4`

**Issue:** `import { Badge } from "@/components/ui/badge";` is never used anywhere in the file
(confirmed: the only occurrence is the import line). Next.js's default ESLint config
(`@typescript-eslint/no-unused-vars` / `next lint`) treats unused imports as an error in CI, so
this can break the production build, not just lint locally.

**Fix:** Remove the unused import line.

### WR-05: `report_status` can get stuck on `generating` forever if the process dies mid-synthesis

**File:** `src/actions/generate-report.ts:188-282`

**Issue:** The lock is acquired at `:188-191` (status → `generating`) before the Sonnet call. If
the server process crashes, times out, or the request is aborted between that write and the
terminal write (`:258` for success, or `writeFailedStatus` in the catch/over-cap branches), the
row is left in `generating` permanently. Every subsequent `generateReport` then short-circuits at
`:180-185` ("En AI-rapport genereras redan"), so the user can never regenerate — the report is
wedged with no recovery path. There is no timeout/heartbeat or stale-lock reclamation. (The page
polls `report_status` and also only stops on a terminal status, per the comment in
`writeFailedStatus`, so a wedged `generating` row also spins the client indefinitely.)

**Fix:** Add a stale-lock escape. Either persist a `report_started_at` timestamp with the lock and
treat a `generating` row older than N minutes as reclaimable (allow re-acquire), or scope the lock
release in a `finally` so an in-process throw always lands a terminal status. Minimal:

```ts
if (row.report_status === "generating" && !isStaleLock(row.report_generating_since)) {
  return { ok: false, error: "En AI-rapport genereras redan. Vänta ett ögonblick." };
}
```

### WR-06: PDF download filename uses unescaped `analysisId` in a `download` attribute

**File:** `src/components/ai-report-section.tsx:150`

**Issue:** `a.download = \`ai-rapport-${analysisId}.pdf\`` interpolates the raw `analysisId` into a
download filename. `analysisId` is server-sourced (`analysis.id`, a UUID) so in practice it is
safe, but the value flows from props with no constraint at this call site; if the id source ever
changes (e.g. a slug), path separators or control chars in the filename are an injection vector
for the saved-file name. Low likelihood given the current UUID source, but it is an unvalidated
value reaching a filesystem-facing attribute.

**Fix:** Sanitize defensively before using it as a filename, e.g.
`const safeId = analysisId.replace(/[^a-zA-Z0-9_-]/g, "");` and build the name from `safeId`.

## Info

### IN-01: Cost guard uses strict `>` so a report costing exactly 5 SEK is persisted

**File:** `src/actions/generate-report.ts:231`

**Issue:** `if (sek > COST_CAP_SEK)` admits a report costing exactly `5` SEK. Whether the cap is
inclusive is a product decision, but the boundary is undocumented and the test only exercises a
clearly-over value (~33 SEK) and a clearly-under value, never the boundary.

**Fix:** Decide the boundary explicitly (`>=` if the cap is a hard ceiling) and add a boundary test.

### IN-02: `slot()` treats `undefined` as absent but the type only admits `T | null`

**File:** `src/lib/report/fact-sheet.ts:47-51`

**Issue:** `slot<T>(value: T | null)` checks `value === null || value === undefined`, but the
declared parameter type never includes `undefined`. The runtime guard is harmless (defensive), but
the type and the implementation disagree — a reader can't tell whether `undefined` is expected.
Either widen the param to `T | null | undefined` or drop the `undefined` check.

### IN-03: Duplicated source-to-flag mapping between the action and the page (drift risk)

**File:** `src/actions/generate-report.ts:71-118` and `src/app/(app)/analysis/[id]/page.tsx:29-59`

**Issue:** `toFlagBrf`, `toFlagPrice`, and `toSoftSignals` are copy-pasted verbatim into both files.
The page's own comment (`page.tsx:22-28`) acknowledges they MUST stay byte-identical to keep the
D-08 fingerprint in sync, but nothing enforces it — a future edit to one copy silently breaks stale
detection. This is the kind of duplication that should be extracted to a shared module so the two
fingerprints provably use the same mapping.

**Fix:** Extract the three mappers (and the fact-sheet assembly) into a shared
`src/lib/report/fact-sheet-inputs.ts` and import from both the action and the page.

### IN-04: `report-document.tsx` `prioritizedFlagIds.includes` in a loop is O(n·m); fine here but note the duplicated label maps

**File:** `src/lib/report/pdf/report-document.tsx:129-141` and `src/components/report-flags.tsx:24-36`

**Issue:** The Swedish flag-label map is maintained twice — once for the PDF
(`report-document.tsx:129-141`) and once for the screen (`report-flags.tsx:24-36`) — with subtly
different wording (e.g. "Hög skuldsättning i föreningen" vs "Hög skuldsättning"). D-11 wants the
PDF to be "the same experience made portable"; two divergent label dictionaries are a drift hazard
and already differ. (Performance of the `.includes` lookup is out of v1 scope and not flagged.)

**Fix:** Centralize the `FLAG_LABELS` map in one module (e.g. alongside `FLAG_IDS` in `flags.ts`)
and import it into both the PDF document and the on-screen `ReportFlags`.

---

_Reviewed: 2026-06-26T12:11:10Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
