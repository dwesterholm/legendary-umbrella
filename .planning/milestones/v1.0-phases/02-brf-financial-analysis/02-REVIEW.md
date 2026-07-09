---
phase: 02-brf-financial-analysis
reviewed: 2026-06-14T00:00:00Z
depth: standard
files_reviewed: 14
files_reviewed_list:
  - src/lib/schemas/brf.ts
  - src/lib/brf/score.ts
  - src/lib/brf/sanity.ts
  - src/lib/brf/cost.ts
  - src/lib/brf/prompt.ts
  - src/lib/brf/extract.ts
  - src/lib/supabase/storage.ts
  - src/actions/analyze-brf.ts
  - src/components/brf-upload.tsx
  - src/components/brf-progress.tsx
  - src/components/brf-section.tsx
  - src/components/brf-score-card.tsx
  - src/app/(app)/analysis/[id]/page.tsx
  - src/app/sa-raknar-vi/page.tsx
  - next.config.ts
findings:
  critical: 2
  warning: 6
  info: 4
  total: 12
status: issues_found
---

# Phase 02: Code Review Report

**Reviewed:** 2026-06-14T00:00:00Z
**Depth:** standard
**Files Reviewed:** 14
**Status:** issues_found

## Summary

This is a well-structured implementation. The trust-core requirements are largely met: `score.ts`, `sanity.ts`, and `cost.ts` are genuinely pure and provider-agnostic; the methodology page renders entirely from the shared `BRF_SCORE_THRESHOLDS` / `BRF_SANITY_BANDS` constants (no drift); the Anthropic client lives only in the server module `extract.ts` and is correctly listed in `serverExternalPackages`; `correctBrfField` re-scores deterministically and never re-calls Claude (D-12 satisfied); storage paths are RLS-prefixed with no public URLs (GDPR satisfied); the server action is auth-gated with a defence-in-depth ownership check behind RLS.

The defects below cluster in two areas: (1) **untrusted DB JSON is cast to `BrfData` and dereferenced without validation**, which can crash the score card or be persisted as a forged authoritative payload; and (2) **the "5 SEK cost cap" does not actually cap spend** — it only blocks persistence after the model has already been billed. Several robustness and input-validation gaps round out the list.

## Critical Issues

### CR-01: Persisted/cached `brf_data` is cast without re-validation and dereferenced — crash + integrity risk

**File:** `src/app/(app)/analysis/[id]/page.tsx:36`, `src/actions/analyze-brf.ts:158,307`, `src/components/brf-score-card.tsx:232,300`
**Issue:** The analysis row's `brf_data` JSON is trusted as authoritative on three read paths with no schema check:

- `page.tsx:36` — `analysis.brf_data as unknown as BrfData | null` is passed straight into `BrfScoreCard`.
- `analyze-brf.ts:158` — the D-06 cache path returns `row.brf_data as BrfData` after only checking `typeof === "object"`.
- `analyze-brf.ts:307` — `correctBrfField` does `const current = row.brf_data as BrfData` then `{ ...current.extraction }`.

`BrfScoreCard` then iterates `breakdown` and reads `data.extraction[metric.key]` (line 232) and `ext.sourceQuote` (line 300). If a stored payload is missing a metric key in `extraction` (schema drift, an older row, a partially written record, or a manually edited DB row), `ext` is `undefined` and `ext.sourceQuote` throws a client-side `TypeError`, white-screening the result view. Because `brf_data` is a JSONB column the user's own RLS session can read but the integrity of which is never re-asserted on read, a stale or partial shape silently bypasses every Zod gate the write path enforces.

**Fix:** Re-validate on read with a dedicated `BrfData` Zod schema (extraction via the existing `brfExtractionSchema`, grade/breakdown/confidence shapes added) before handing the payload to the UI, and treat a parse failure as "no analysis yet" rather than crashing:
```ts
// analyze-brf.ts cache path
const parsed = brfDataSchema.safeParse(row.brf_data);
if (parsed.success) {
  return { ok: true, data: parsed.data, cached: true };
}
// fall through to a fresh extraction instead of returning malformed JSON
```
At minimum, guard the dereference in `brf-score-card.tsx`:
```ts
const ext = data.extraction[metric.key];
if (!ext) return null; // skip malformed rows rather than crashing
```

### CR-02: The 5 SEK cost cap does not cap spend — the model is always billed in full before the check

**File:** `src/actions/analyze-brf.ts:188-202`
**Issue:** `extractBrfFinancials` (including its internal `max_tokens` retry, so potentially two full Haiku calls) completes and bills before `cost = costSek(result.usage)` is computed and compared to `COST_CAP_SEK`. The guardrail only prevents *persisting* an over-budget run; it cannot prevent the spend it is named for. With `max_tokens: 2048` plus a one-shot retry and a 20 MB PDF input, a single invocation's input-token cost can dominate and there is no pre-flight estimate, no per-user/day call ceiling, and no rate limit. A user (or a script hitting the authenticated action) can submit large PDFs repeatedly; each one bills fully regardless of the "cap." The spec frames this as a hard per-analysis budget guardrail (AI-SPEC §6), and the implementation does not enforce it as such.

**Fix:** Add a *pre-call* bound that the cap can actually enforce: cap input by document size before the call (the existing `MAX_PDF_BYTES` helps but is 20 MB, well above 5 SEK of input tokens), and add a per-user call/cost rate limit (e.g. a `brf_cost_sek` running-sum check per user per window) before invoking `extractBrfFinancials`. Keep the post-call check as a second line, but rename/comment it honestly — it is a "do not persist over-budget result" check, not a spend cap.

**Resolution (documented, not code-fixed):** A true *pre-call* spend cap is not feasible — token count (and therefore cost) is unknown until after the Claude call returns. Per-request spend is already inherently bounded by the single Haiku call at `max_tokens: 2048` (plus one truncation retry), observed at ~0.71 SEK, well under the 5 SEK cap. An honest clarifying comment was added at the cost-check site in `analyze-brf.ts` stating that the check gates **persistence** of an over-budget result (not the spend), and that per-request cost is bounded by `max_tokens`. **Deferred follow-up:** per-user rate limiting / DoS guard (a running per-user/window `brf_cost_sek` ceiling before invoking `extractBrfFinancials`) is the real protection against repeated authenticated calls, and is out of scope for this phase.

## Warnings

### WR-01: `correctBrfField` accepts an empty numeric submission as `0`

**File:** `src/actions/analyze-brf.ts:329-330`
**Issue:** `const num = Number(rawValue)` followed by `Number.isFinite(num)`. `Number("")` is `0` (finite), so if the user clears the inline editor and presses Spara, the correction is silently accepted as `0` rather than rejected. For `kassaflode` that even flips the metric to a deficit (sub-score 0.0); for `skuldPerKvm`/`avgiftsniva` it writes a meaningless 0 marked "Manuellt angiven" with confidence 1. Whitespace-only strings behave the same (`Number("  ")` is `0`).
**Fix:**
```ts
const raw = typeof rawValue === "string" ? rawValue.trim() : "";
if (raw === "") return { ok: false, error: "Ogiltigt numeriskt värde." };
const num = Number(raw);
if (!Number.isFinite(num)) return { ok: false, error: "Ogiltigt numeriskt värde." };
```

### WR-02: A manual correction can be silently confidence-downgraded by the sanity check, contradicting "human-sourced, high-confidence"

**File:** `src/actions/analyze-brf.ts:328-339,77-93`
**Issue:** `correctBrfField` sets a corrected numeric field to `confidence: 1`, but then `scoreExtraction` runs `applySanityChecks`, which forces `confidence` to `0.2` for any out-of-band value (e.g. a user deliberately entering `skuldPerKvm = 18000`, above the 15000 band). The resulting `perFieldConfidence` is 0.2. The UI happens to hide this because `isManual` takes precedence over `isUncertain` in `brf-score-card.tsx:265-285`, so the contradiction is invisible today — but the persisted `perFieldConfidence` for a human-entered value is wrong, and any future consumer reading that map will mis-treat an explicit user input as "Osäker." Intent (manual = authoritative) and stored state disagree.
**Fix:** Skip the sanity downgrade for fields in `manualFields`, or set the corrected field's confidence after `scoreExtraction` so the manual override wins:
```ts
perFieldConfidence[field] = 1; // manual entry is authoritative regardless of band
```

### WR-03: Two back-to-back status UPDATEs (`reading` then `extracting`) — the first is a wasted round-trip and a visible flicker

**File:** `src/actions/analyze-brf.ts:173-180`
**Issue:** The action writes `brf_status: "reading"` and immediately overwrites it with `brf_status: "extracting"` in a second awaited query, with no work in between. The poller (1.5s cadence) will almost never observe `reading`, so the first step is effectively dead, and the two serial network round-trips add latency to every analysis. Neither update's error is checked, so a failed status write is silently ignored.
**Fix:** Collapse to the meaningful states only and write `reading` before the actual extraction begins, `extracting` is redundant given the single call — or keep both but set `reading` once, do the upload, then `extracting`. Remove the immediate double-write.

### WR-04: Status UPDATE / failure UPDATE error results are discarded

**File:** `src/actions/analyze-brf.ts:173-180,193-202,211-221,224-227`
**Issue:** Every `brf_status` update (`reading`, `extracting`, `scoring`, and the two `failed` writes) ignores the returned `{ error }`. If a status write fails (RLS, transient), the poller can hang on a stale status with no terminal signal — `BrfProgress` only stops on `done`/`failed`, so a dropped `failed` write leaves the client polling indefinitely.
**Fix:** Check the error on at least the terminal (`failed`/`done`) writes and return a user-facing failure if they don't land; consider a `finally` that guarantees a terminal status is written.

### WR-05: `detectScanned` heuristic only inspects the first 2 MB as latin1 and will misclassify compressed PDFs

**File:** `src/actions/analyze-brf.ts:56-63`
**Issue:** Born-digital PDFs routinely store text operators inside `FlateDecode`-compressed content streams; `/Font` and the `Tj`/`TJ` operators then do not appear as literal ASCII anywhere in the raw bytes, so a normal text PDF can be flagged `scanned`. Conversely the regex `/\bTj\b|\bTJ\b/` matches those two-letter sequences anywhere in arbitrary binary interpreted as latin1, producing false negatives. The 2 MB head cap also misses text on later objects. The `scanned` flag drives a user-facing warning banner and is persisted, so misclassification is user-visible.
**Fix:** This is a heuristic by design, but tighten it: scan the whole buffer (or document it as best-effort), and prefer a structural signal (e.g. presence of `/Type /Font` object definitions, or `BT`/`ET` text-block markers) over loose `\bTj\b`. If accuracy matters, decode the first content stream. At minimum, soften the copy so a false positive does not erode trust.

### WR-06: Refusal / max-tokens / parse-empty error markers are swallowed by the bare `catch {}` in the action, collapsing all failure modes to one generic message

**File:** `src/lib/brf/extract.ts:194-200`, `src/actions/analyze-brf.ts:211`
**Issue:** `extract.ts` deliberately distinguishes `CLAUDE_REFUSAL`, `CLAUDE_MAX_TOKENS`, `CLAUDE_PARSE_EMPTY` — but then its own `catch` rewrites *all* of them (and any network error) into one Swedish string, and `analyze-brf.ts:211` uses `catch {}` with no binding, discarding even that. The differentiated stop-reason handling is therefore unobservable: a refusal and a network timeout are indistinguishable in logs at the action layer, and the inner `console.error` in `extract.ts` is the only trace. This hurts diagnosability of a paid, user-facing path.
**Fix:** Let `extract.ts` rethrow a typed/coded error (or return a discriminated result) instead of flattening to a string, and have the action log the caught error server-side (content hash only, per GDPR) before returning the user message:
```ts
} catch (e) {
  console.error("[analyzeBrf]", { analysisId, code: (e as Error)?.message });
  await supabase.from("analyses").update({ brf_status: "failed" }).eq("id", analysisId);
  return { ok: false, error: "Vi kunde inte läsa dokumentet automatiskt — fyll i uppgifterna manuellt." };
}
```

## Info

### IN-01: `scanned` is read off the wrong object in `BrfScoreCard` and is always `false`

**File:** `src/components/brf-score-card.tsx:148-151`
**Issue:** The comment concedes `scanned` lives on the row, not the payload, and reads `(data as BrfData & { scanned?: boolean }).scanned ?? false`. `BrfData` never carries `scanned` (it is a separate `brf_scanned` column), and `page.tsx` never forwards it, so the scanned-PDF warning banner (lines 196-202) is dead code that never renders. The D-14 "skannad PDF" heads-up the user is promised never shows.
**Fix:** Thread `analysis.brf_scanned` from `page.tsx` → `BrfSection` → `BrfScoreCard` as an explicit prop and drop the cast.

### IN-02: `formatSEK` appends "kr" to SEK/m² threshold values on the methodology page

**File:** `src/app/sa-raknar-vi/page.tsx:70-83,103-116,134-143`
**Issue:** `formatSEK(5000)` returns `"5 000 kr"`, rendered as `"Under 5 000 kr/m²"`. The unit reads "kr/m²" which is acceptable for a debt-per-area figure, but for `kassaflode` the list renders `"0–120 kr/m²"` and `"Minst 250 kr/m²"` — fine — while a plain `formatSEK` was chosen over a unit-aware formatter. Cosmetic, but the doubled unit semantics ("kr" then "/m²") are slightly redundant.
**Fix:** Optionally introduce a `formatSEKPerKvm`/raw-number helper so the page controls the unit suffix explicitly rather than relying on `formatSEK`'s baked-in " kr".

### IN-03: `BrfScoreCard` keeps its own `data` state seeded once from props and can desync from the parent

**File:** `src/components/brf-score-card.tsx:137`, `src/components/brf-section.tsx:106-113`
**Issue:** `BrfScoreCard` initializes `useState<BrfData>(brfData)` and only updates on its own `saveEdit`. `BrfSection` also holds `data` and passes it down. If the parent's `data` changes (e.g. a future onComplete hydration), the child will not pick it up because `useState(initial)` ignores subsequent prop changes. Today the flows don't trigger this, so it's latent.
**Fix:** Either lift the single source of truth fully to the parent (pass `data` + `onCorrected` and don't duplicate child state), or key the component on `analysisId` so it remounts when the payload identity changes.

### IN-04: `collectCitations` is permanently dead by design — `citations` array is always empty

**File:** `src/lib/brf/extract.ts:71-87,190-192`
**Issue:** The comment at lines 151-158 explains API-level citations are mutually exclusive with structured outputs, so `collectCitations` always returns `[]` and `BrfData.citations` is always empty (provenance is carried in `sourceQuote`/`pageRef` instead). The function and the `citations` field are then unused payload. Not a bug, but dead code that implies a feature that isn't wired.
**Fix:** Either remove `collectCitations` and the `citations` field (the schema-level `sourceQuote`/`pageRef` already deliver D-11), or leave a single comment at the field declaration so a future reader doesn't try to populate it.

---

_Reviewed: 2026-06-14T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
