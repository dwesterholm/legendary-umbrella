---
phase: 08-brf-auto-fetch
reviewed: 2026-07-07T08:17:56Z
depth: standard
files_reviewed: 16
files_reviewed_list:
  - src/actions/analyze-brf.ts
  - src/actions/fetch-brf-auto.ts
  - src/app/(app)/analysis/[id]/page.tsx
  - src/components/brf-auto-fetch-progress.tsx
  - src/components/brf-confirm.tsx
  - src/components/brf-progress.tsx
  - src/components/brf-score-card.tsx
  - src/components/brf-section.tsx
  - src/lib/brf-source/allabrf.ts
  - src/lib/brf-source/fetch-document.ts
  - src/lib/brf-source/org-nr-resolver.ts
  - src/lib/brf/extract.ts
  - src/lib/brf/ixbrl-to-text.ts
  - src/lib/brf/run-extraction.ts
  - src/lib/schemas/brf.ts
  - supabase/migrations/009_brf_auto_fetch.sql
findings:
  critical: 2
  warning: 4
  info: 3
  total: 9
status: issues_found
---

# Phase 8: Code Review Report

**Reviewed:** 2026-07-07T08:17:56Z
**Depth:** standard
**Files Reviewed:** 16
**Status:** issues_found

## Summary

The SSRF guard (`allabrf.ts` + `url-guard.ts`) is genuinely solid: resolve-then-pin DNS handling, a host allowlist on top of the shared guard, `redirect: "manual"` with 3xx/opaqueredirect treated as failure, and org.nr Luhn validation strictly before any URL is constructed. The wrong-BRF confidence gate (`org-nr-resolver.ts`) is also correctly fail-closed: `high` confidence requires an exact-after-normalization single name match AND geographic corroboration AND Luhn validity; every other branch degrades to `low`/`none`. The `runBrfExtraction` refactor appears to preserve the manual path's D-06 hash-cache/cost-cap/terminal-persist semantics faithfully, and fiscal-year/staleness plumbing (`fetchMeta` → `BrfData.fiscalYear`/`isMostRecent` → page.tsx) is wired correctly with an honest `null` on the unknown case.

Two real gaps remain. First, `confirmAndAnalyze`'s "redundant-work guard" is a plain check-then-act (`SELECT` then unconditional `UPDATE`), not an atomic CAS — unlike `generateReport`, which the code comment explicitly (and incorrectly) claims to mirror. Two concurrent invocations (double-click, tab duplication, retry-on-timeout) can both pass the `brf_status` check and both scrape + bill Claude, and can also race the terminal write, leaving the row in an inconsistent state. Second, the iXBRL text pipeline has no upper bound between the 8 MB raw-HTML cap in `allabrf.ts` and the Claude call in `extract.ts` — a large but allowed HTML response can strip down to megabytes of "text" that get inlined as a single `text/plain` document block with no truncation and no Files-API fallback (unlike the PDF branch, which switches transport above 5 MB). This is a cost/DoS and possible hard-failure gap, not merely a performance nit, because it defeats the intended "single Haiku call, ~0.71 SEK" cost assumption the post-hoc `COST_CAP_SEK` check relies on.

## Critical Issues

### CR-01: `confirmAndAnalyze`'s redundant-work guard is check-then-act, not atomic — real double-scrape/double-bill race

**File:** `src/actions/fetch-brf-auto.ts:196-212`
**Issue:** The guard reads `row.brf_status` from an earlier `.select()` (line 176-180), branches on it in application code (lines 201-207), and only then issues an unconditional `.update({ brf_status: "auto_fetching" })` (lines 209-212) with no `.eq("brf_status", <previous value>)` / `.neq("brf_status", "auto_fetching")` condition and no `.select().maybeSingle()` to detect whether the write actually "won" the race. Two concurrent calls to `confirmAndAnalyze` for the same `analysisId` (e.g. a double-click on the confirm button, a duplicated tab, or a client retry after a false-timeout in `BrfAutoFetchProgress`) can both read `brf_status` as `null`/some non-blocking value before either write lands, both pass the guard, and both proceed to call `fetchArsredovisning` (a real outbound scrape) and `runBrfExtraction` (a real, billed Claude call). This is exactly the class of bug the module's own comment claims to have avoided: "Mirrors generateReport's CAS in-flight-lock idea" — but `generateReport` actually performs `update().eq().neq().select().maybeSingle()` (confirmed in `generate-report.test.ts`), an atomic conditional update whose result tells the caller whether the lock was acquired. This code does not use that pattern; it only mirrors the *intent*, not the mechanism. The last writer's terminal `runBrfExtraction` persist also wins over the other in-flight run, and the failure-handling `.update({ brf_status: null })` in the catch block of one call can stomp the success state the other call just wrote, or vice versa.
**Fix:**
```ts
// Replace the check-then-act guard with an atomic conditional update,
// mirroring generate-report.ts's CAS pattern:
const { data: acquired, error: casError } = await supabase
  .from("analyses")
  .update({ brf_status: "auto_fetching" })
  .eq("id", analysisId)
  .not("brf_status", "in", '("auto_fetching","done")') // or .is/.neq as appropriate
  .select("id")
  .maybeSingle();

if (casError || !acquired) {
  return {
    ok: false,
    fallThrough: true,
    error: "En hämtning pågår redan eller är redan klar.",
  };
}
// Only proceed to fetchArsredovisning/runBrfExtraction after the CAS succeeds.
```

### CR-02: iXBRL-derived text has no size cap before it reaches the Claude call — untruncated up to ~8 MB of text

**File:** `src/lib/brf/ixbrl-to-text.ts:34-46`, `src/lib/brf-source/allabrf.ts:47`, `src/lib/brf/extract.ts:247-248`
**Issue:** `allabrf.ts` bounds the *raw HTML* response at `MAX_DOC_BYTES = 8 * 1024 * 1024` (8 MB), but `ixbrlToPlainText` performs no truncation of its own — it strips markup and returns the full extracted text, which for an 8 MB HTML document could still be multiple megabytes of plain text (HTML markup overhead aside, financial-statement iXBRL is often mostly text/table content, so the stripped text can be a large fraction of the raw size). That text is threaded unmodified through `run-extraction.ts` (`hashText`, `{ kind: "ixbrl-text", text: source.text }`) into `extract.ts`, where it is inlined directly as a `type: "text", media_type: "text/plain"` document block (`extract.ts:247-248`) with **no size branch at all** — contrast the `pdf` branch, which explicitly switches to the Files API above `BASE64_MAX_BYTES` (5 MB) specifically to avoid a request-size failure. A large-but-allowed Allabrf response can therefore either blow the model's context window (causing an outright API failure rather than a graceful degrade) or, if accepted, generate an outsized token bill that the `COST_CAP_SEK` check only catches *after* the (uncapped) call has already been paid for. This also weakens the "untrusted text is bounded" prompt-injection mitigation implied by the module's own docs — an attacker-influenced Allabrf response (or a compromised/rebound host that slips past the SSRF guard in some future regression) has a much larger surface to work with than the PDF path allows.
**Fix:**
```ts
// ixbrl-to-text.ts: cap the returned text and let the caller/extract.ts
// know when truncation happened (or just hard-truncate defensively):
const MAX_TEXT_CHARS = 300_000; // ~tune to a safe token budget for Haiku's context

export function ixbrlToPlainText(ixbrlHtml: string): string {
  try {
    const $ = cheerio.load(ixbrlHtml, { xmlMode: false });
    $("script, style").remove();
    const body = $("body");
    const raw = body.length > 0 ? body.text() : $.root().text();
    const collapsed = raw.replace(/\s+/g, " ").trim();
    return collapsed.length > MAX_TEXT_CHARS
      ? collapsed.slice(0, MAX_TEXT_CHARS)
      : collapsed;
  } catch {
    return "";
  }
}
```

## Warnings

### WR-01: `resolveOrgNrAction` and `confirmAndAnalyze` independently fetch the same Allabrf document, doubling outbound calls and cost per auto-fetch flow

**File:** `src/actions/fetch-brf-auto.ts:129`, `src/actions/fetch-brf-auto.ts:215`
**Issue:** `resolveOrgNrAction` calls `fetchAllabrfDocument(resolution.orgNr)` purely to preview the fiscal year (line 129), then discards the fetched `text`. When the user confirms, `confirmAndAnalyze` calls `fetchArsredovisning(orgNr)` (line 215), which re-fetches the identical document from Allabrf from scratch. Every successful auto-fetch flow therefore performs two outbound scrapes of the same URL. This isn't flagged as a performance issue per se (out of scope), but it doubles the guard/DNS-resolution/parse work and the exposure window to Allabrf for no functional benefit, and there is no comment acknowledging this as an accepted tradeoff (the code around it argues the opposite — that `doc` from `fetchArsredovisning` is deliberately "the source of truth", which is correct, but doesn't explain why the preview fetch's result isn't reused/passed through).
**Fix:** Consider caching the preview fetch's result (e.g. keyed by analysisId, short TTL) and having `confirmAndAnalyze` reuse it if still fresh, or explicitly document why a double-fetch is acceptable (e.g. "resolution and confirm can be arbitrarily far apart in time, so re-fetching is intentional to get current data").

### WR-02: `confirmAndAnalyze`'s failure path can clobber a status the concurrent/retried request already advanced past

**File:** `src/actions/fetch-brf-auto.ts:226-244`
**Issue:** On any thrown error from `fetchArsredovisning`/`runBrfExtraction`, the catch block unconditionally writes `brf_status: null` (line 235-238). Combined with CR-01's missing CAS, if a second (racing) invocation has already progressed the row into `extracting`/`scoring`/`done` by the time the first invocation's catch block runs, this write silently regresses the status back to `null`, causing `BrfProgress`/`BrfAutoFetchProgress` pollers to stop believing any operation is in flight (or a completed `done` row to look like it needs upload again).
**Fix:** Once CR-01's CAS is in place, make this release conditional too: `.update({ brf_status: null }).eq("id", analysisId).eq("brf_status", "auto_fetching")` so a failure only clears the status if it's still the one this invocation set.

### WR-03: `walkBrfSources`'s `rungs.length > 3` guard throws synchronously outside any try/catch in `fetchArsredovisning`

**File:** `src/lib/brf-source/fetch-document.ts:67-70`, `123-141`
**Issue:** This is currently unreachable (the only caller passes exactly one rung), so it's not a live bug today, but the throw in `walkBrfSources` on `rungs.length > 3` will propagate directly out of `fetchArsredovisning` the same way an exhausted-rungs error does. `confirmAndAnalyze` catches both cases identically (`catch (error)` at line 226), so behaviorally this is fine today — but the "loud fail" comment describes it as a deliberate guardrail against a *future* 4th rung being added without verification. Worth flagging so a future contributor adding a Bolagsverket rung doesn't assume this path is exercised by any test today.
**Fix:** No code change required now; add a regression test when the second rung is introduced, or leave as documented technical debt.

### WR-04: `BrfSection`'s org.nr-resolution effect has a stale-closure risk on `brfStatus`/`listingData` (deps intentionally suppressed)

**File:** `src/components/brf-section.tsx:100-129`
**Issue:** The effect closes over `brfStatus` and `listingData` but its dependency array only lists `[analysisId, isGuest]`, with `eslint-disable-next-line react-hooks/exhaustive-deps` silencing the warning. In practice this is likely benign because `BrfSection`'s props are server-seeded on page load and the component isn't expected to receive a new `brfStatus`/`listingData` without a remount — but if a future caller ever re-renders `BrfSection` with updated `brfStatus`/`listingData` props (e.g. a parent that lifts live state), this effect will not re-run and will use the stale values captured on mount, potentially re-triggering `resolveOrgNrAction` for a row that has since moved to `done`/`failed`, or missing a `brfName` that only became available after mount.
**Fix:** Either add `brfStatus`/`listingData` to the dependency array (guarding against double-resolution with a ref-based "already attempted" flag), or add a one-line comment explaining why this is safe as-is (props are effectively immutable for this component's lifetime).

## Info

### IN-01: `AllabrfDocument.availableYears`/`fiscalYear` parsing relies on undocumented Allabrf markup contract (`[data-fiscal-year]`, `[data-available-year]`, `[data-orgnr]`)

**File:** `src/lib/brf-source/allabrf.ts:233-247, 291-307`
**Issue:** The HTML parsing throughout this file depends on `data-*` attributes (`data-orgnr`, `data-name`, `data-kommun`, `data-fiscal-year`, `data-available-year`) that appear to be assumed/invented rather than confirmed against Allabrf's actual markup (no fixture HTML or citation to real page structure is visible in this file). If Allabrf doesn't actually expose these attributes, `searchAllabrfByName`/`fetchAllabrfDocument` will silently return `[]`/degrade every fiscal-year field to `null` in production despite the guard/parsing code being "correct" against a wrong assumption. This is a data-correctness risk rather than a security/logic bug in the reviewed code itself.
**Fix:** Confirm against a real fetched Allabrf page (or a checked-in fixture) that these attributes exist; if Allabrf's real markup differs, adjust the CSS selectors accordingly. Add an integration/contract test using a saved real HTML fixture, not just synthetic `data-*` fixtures.

### IN-02: `resolveOrgNrAction`'s ownership check selects `listing_data` while `confirmAndAnalyze`'s selects `brf_status` — duplicated, slightly divergent auth/ownership boilerplate

**File:** `src/actions/fetch-brf-auto.ts:98-106`, `176-184`
**Issue:** Both actions repeat the identical `supabase.auth.getUser()` → ownership-row-fetch → `row.user_id !== user.id` pattern (as intended per the module doc comment), but each selects a different column set tailored to its own needs. This is fine functionally, but it means any future change to the auth/ownership gate (e.g. adding a suspended-user check) must be applied in at least four places across this codebase (`analyzeBrf`, `correctBrfField`, `resolveOrgNrAction`, `confirmAndAnalyze`) with no shared helper enforcing consistency.
**Fix:** Consider extracting a small `requireOwnedAnalysis(supabase, analysisId, extraColumns)` helper to reduce the four-way duplication and the risk of one call site drifting from the others during a future security fix.

### IN-03: `BrfScoreCard` reads `scanned` off `data as BrfData & { scanned?: boolean }` even though `BrfData` never declares a `scanned` field

**File:** `src/components/brf-score-card.tsx:165-173`
**Issue:** The comment acknowledges `scanned` "lives on the row, not the payload" and casts around the type system to read it defensively, but since `BrfData` (the actual persisted JSONB shape) has no `scanned` property, `data.scanned` will always be `undefined` in every real code path today (the row's `brf_scanned` column is never merged into `brfData` before it's passed down from `brf-section.tsx`/`page.tsx`). This means the "Skannad PDF" banner in this component can never actually render, silently defeating the D-14 scanned-PDF heads-up this card claims to implement.
**Fix:** Either thread the row's `brf_scanned` value through `BrfSection`/`page.tsx` as an explicit prop (matching the pattern already used for `fiscalYear`/`fetchSource`/`isMostRecent`), or remove the dead defensive-read code and banner if scanned-flag display was intentionally deferred elsewhere.

---

_Reviewed: 2026-07-07T08:17:56Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
