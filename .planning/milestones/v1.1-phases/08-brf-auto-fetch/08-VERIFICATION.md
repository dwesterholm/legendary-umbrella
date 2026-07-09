---
phase: 08-brf-auto-fetch
verified: 2026-07-07T10:20:00Z
status: human_needed
score: 8/9 must-haves verified (1 gap, 1 human-verification item)
overrides_applied: 0
gaps:
  - truth: "The fetched document's fiscal year is shown prominently in the report, flagged when it isn't the most recent available (ROADMAP Success Criterion 4 / 08-04-PLAN must-have)"
    status: partial
    reason: "The confirmation-time preview (BrfMatchConfirmation) correctly shows org.nr + fiscal year before analysis. But after analysis completes, fiscal year and the isMostRecent staleness flag are never persisted anywhere retrievable — page.tsx hardcodes fiscalYear:null and isMostRecent:null when rendering BrfScoreCard, because migration 009 only added brf_fetch_source (no fiscal-year/staleness column), FetchedDocument's fiscalYear/isMostRecent are discarded after fetchArsredovisning returns, confirmAndAnalyze's fiscalYear parameter is explicitly unused (_fiscalYear), and BrfData/brfExtractionSchema carry no fiscal-year field. The score card's fiscal-year line and staleness caption are wired (props + rendering logic exist and are correct) but structurally dormant on every real analysis — confirmed both by static analysis and by 08-04-SUMMARY.md's own "Next Phase Readiness" admission of this gap.
    artifacts:
      - path: "src/app/(app)/analysis/[id]/page.tsx"
        issue: "Passes fiscalYear={null} isMostRecent={null} to BrfSection unconditionally (lines 207-208) — no code path reads these from anywhere"
      - path: "src/lib/brf/run-extraction.ts"
        issue: "BrfData interface has no fiscalYear/isMostRecent field; the terminal persist (lines 337-347) never writes them"
      - path: "src/actions/fetch-brf-auto.ts"
        issue: "confirmAndAnalyze receives fiscalYear as a parameter but marks it _fiscalYear (intentionally unused) and never threads FetchedDocument.fiscalYear/isMostRecent into the persisted result"
      - path: "supabase/migrations/009_brf_auto_fetch.sql"
        issue: "Only adds brf_fetch_source; no column for fiscal year or most-recent-year staleness"
    missing:
      - "A migration adding fiscal-year + staleness (or most-recent-known-year) columns to analyses, OR extending BrfData/brfExtractionSchema with these fields"
      - "runBrfExtraction (or confirmAndAnalyze) persisting FetchedDocument.fiscalYear/isMostRecent at terminal write time"
      - "page.tsx reading the persisted values instead of hardcoding null"
deferred: []
human_verification:
  - test: "Live end-to-end auto-fetch smoke test against a real Booli listing with a resolvable BRF org.nr on live Allabrf"
    expected: "BrfMatchConfirmation shows org.nr + fiscal year (+ BRF name); confirm runs the auto-fetch pre-step progress then the identical extraction pipeline, landing on the same A-F score card as manual upload with 'Källa: Allabrf'; a low-confidence/no-match listing falls through to manual upload with no false error banner; a manual PDF upload still works unchanged; server logs show [brf-source] lines with no PII/HTML/financials on any rung failure"
    why_human: "Requires a running app instance, live network access to Allabrf, and a real Booli listing with a genuinely resolvable BRF — explicitly designated operator-only in 08-VALIDATION.md 'Manual-Only Verifications' and deferred by the executor in 08-04-SUMMARY.md's Task 4 (the [BLOCKING] checkpoint was never run; all automation up to that gate is green). Cannot be simulated by grep/unit tests since it depends on live Allabrf's actual HTML/data-attribute shape, which allabrf.test.ts only mocks against an assumed fixture shape."
---

# Phase 8: BRF Auto-Fetch Verification Report

**Phase Goal:** Auto-fetch a BRF's årsredovisning from Bolagsverket/Allabrf matched by organisationsnummer, surfacing org.nr + fiscal year for user confirmation — with manual PDF upload remaining the dependable fallback.
**Verified:** 2026-07-07T10:20:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `runBrfExtraction` is the sole shared extraction spine; `analyzeBrf` is a thin wrapper; no pipeline duplication | VERIFIED | `src/lib/brf/run-extraction.ts` contains the full D-06 cache/cost-cap/schema-gate/sanity/grade/terminal-persist pipeline; `src/actions/analyze-brf.ts` delegates via `runBrfExtraction(analysisId, user.id, { kind: "pdf", bytes }, "manual")` (line 73); `src/actions/fetch-brf-auto.ts`'s `confirmAndAnalyze` delegates via the identical call with `{ kind: "ixbrl-text" }` and `"auto_allabrf"` (line 215-220) |
| 2 | Manual-path regression stays green (no behavior change from the refactor) | VERIFIED | `npx vitest run src/actions/analyze-brf.test.ts` passes; all 6 former `it.todo` regressions (guest block, ownership, D-06 cache-skip, cost-cap, schema-invalid, correctBrfField-no-Claude) are real assertions; full suite 395 passed / 1 skipped, `npx tsc --noEmit` clean |
| 3 | iXBRL/HTML input is stripped to text (cheerio) and fed through the SAME Claude extraction call with zero schema change | VERIFIED | `ixbrl-to-text.ts` (cheerio-based, never-throws, tested); `extract.ts` documentSource gains a `{ type: "text", media_type: "text/plain" }` branch (line 248) with `claudeExtractionSchema`/`output_config.format` byte-identical (confirmed via targeted diff of extract.ts — schema/zodOutputFormat call unchanged) |
| 4 | org.nr resolver fails closed: high confidence ONLY on exactly-one geo-corroborated Luhn-valid match; name-only never promotes to high | VERIFIED | `org-nr-resolver.ts` `resolveOrgNr` requires `nameMatches.length === 1 && geoCorroborated && isValidOrgNr` for `high` (lines 159-173); 18 tests cover Luhn valid/invalid, ambiguous-match, kommun-mismatch → low, zero network I/O verified by source-scan test |
| 5 | Allabrf fetch is SSRF-guarded (shared `resolveSafeExternalUrl`, not forked), host-allowlisted, size-bounded | VERIFIED | `allabrf.ts` imports `resolveSafeExternalUrl` from `@/lib/broker/url-guard` (line 3), adds `ALLABRF_ALLOWED_HOSTS` allowlist (line 44) as defense-in-depth, caps body at `MAX_DOC_BYTES` = 8MB via streaming reader (lines 162-194); org.nr validated via `isValidOrgNr` before any URL construction (line 262) |
| 6 | `fetchArsredovisning` never silently returns empty — throws a distinguishable Swedish error when exhausted; local walker, Phase 5 untouched | VERIFIED | `fetch-document.ts`'s `walkBrfSources` throws `"Alla årsredovisningskällor misslyckades: ..."` on exhaustion (line 90); zero `walkFallbackTree` import (grep confirms 0 hits); `src/lib/booli/fallback-tree.test.ts` (Phase 5) still green and untouched |
| 7 | Both auto-fetch actions (`resolveOrgNrAction`, `confirmAndAnalyze`) open with the identical auth+ownership gate as `analyzeBrf`; redundant-work guard prevents re-scrape/re-bill; fall-through never produces a wrong-BRF analysis | VERIFIED | Both actions in `fetch-brf-auto.ts` open with `supabase.auth.getUser()` → `row.user_id === user.id` (lines 88-106, 165-183); redundant-work guard checks `brf_status === "auto_fetching" \| "done"` before any fetch (lines 200-206); fetch-failure path clears status and returns `fallThrough: true` without ever calling `runBrfExtraction` (lines 213-239); 14 tests cover all these paths including spy-uncalled assertions |
| 8 | Confirmation UI: high-confidence match shows org.nr + fiscal year + BRF name and requires explicit confirm before any analysis; reject/no-match falls through to manual with zero friction / no false banner | VERIFIED | `BrfMatchConfirmation` renders the locked heading + org.nr + fiscal-year detail block with equal-size confirm/reject buttons (component + 5 RTL tests, including an explicit equal-prominence assertion); `BrfSection`'s effect routes `low`/`none`/`fallThrough` straight to the `upload` view with no banner (6 RTL tests including a banner-absence assertion); reject routes to `upload` with zero intermediate screen |
| 9 | The fetched document's fiscal year is shown prominently **in the report**, flagged when not the most recent available (ROADMAP Success Criterion 4) | **FAILED** | See Gaps Summary — the confirmation-time preview shows fiscal year correctly, but nothing persists `fiscalYear`/`isMostRecent` past that point; `page.tsx` hardcodes both to `null` when rendering the score card, so the fiscal-year line and staleness caption never render on any completed analysis today |

**Score:** 8/9 truths verified (1 failed — see Gaps)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/lib/brf/run-extraction.ts` | Shared `runBrfExtraction` core + `BrfDocumentSource` union | VERIFIED | Exports both; ≥120 lines (359 lines); wired into both manual and auto paths |
| `src/lib/brf/ixbrl-to-text.ts` | cheerio iXBRL/HTML → plain text stripper, never throws | VERIFIED | `ixbrlToPlainText` exported; try/catch-never-throws confirmed; 5 tests |
| `supabase/migrations/009_brf_auto_fetch.sql` | Additive-nullable `brf_fetch_source` column | VERIFIED | Contains `add column if not exists brf_fetch_source text`; confirmed LIVE on the linked Supabase project via `supabase migration list --linked` (009 present in both Local and Remote columns) and a direct `select brf_fetch_source from analyses limit 1` query returning no column-not-found error |
| `src/actions/analyze-brf.ts` | Thin wrapper delegating to `runBrfExtraction` | VERIFIED | `runBrfExtraction(analysisId, user.id, { kind: "pdf", bytes }, "manual")` present; `correctBrfField` untouched |
| `src/lib/brf-source/org-nr-resolver.ts` | `resolveOrgNr`/`isValidOrgNr`/`OrgNrResolution` | VERIFIED | All exported; ≥60 lines (185 lines); zero network imports |
| `src/lib/brf-source/allabrf.ts` | SSRF-guarded Allabrf fetch + candidate lookup | VERIFIED | `fetchAllabrfDocument`/`searchAllabrfByName` exported; guard/allowlist/size-cap all present |
| `src/lib/brf-source/fetch-document.ts` | Phase-8-local fallback walker + `FetchedDocument` | VERIFIED | `fetchArsredovisning`/`FetchedDocument` exported; throws on exhaustion; local walker (no `walkFallbackTree` import) |
| `src/actions/fetch-brf-auto.ts` | `resolveOrgNrAction` + `confirmAndAnalyze` | VERIFIED | Both exported; ≥100 lines (241 lines); auth+ownership gated |
| `src/components/brf-confirm.tsx` | `BrfMatchConfirmation` | VERIFIED | Exported; locked heading verbatim; equal-size confirm/reject |
| `src/components/brf-auto-fetch-progress.tsx` | `BrfAutoFetchProgress` | VERIFIED | Exported; distinct 3-step pre-sequence; reuses `POLL_MS`/`MAX_POLL_MS` |
| `src/components/brf-section.tsx` | confirm/auto-fetching View orchestration | VERIFIED | `View` union extended; resolve → confirm → analyze → fall-through flow present and tested |
| `src/components/brf-score-card.tsx` | Fiscal-year + provenance header + staleness caption | ⚠️ PARTIAL (see gap) | Renders "Räkenskapsår {year}" + "Källa: X" caption + terracotta staleness caption — code is correct, but `fiscalYear`/`isMostRecent` are always `null` on real data (see Gaps Summary); "Källa: X" provenance caption is live and correct today |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `analyze-brf.ts` | `run-extraction.ts` | `runBrfExtraction(...)` | WIRED | Confirmed via grep + read; delegates PDF path |
| `run-extraction.ts` | `extract.ts` | `extractBrfFinancials(...)` | WIRED | Called with discriminated source in both branches |
| `allabrf.ts` | `url-guard.ts` | `resolveSafeExternalUrl` | WIRED | Imported directly, not forked |
| `fetch-document.ts` | `allabrf.ts` | `fetchAllabrfDocument` | WIRED | Sole v1 rung |
| `allabrf.ts` | `ixbrl-to-text.ts` | `ixbrlToPlainText` | WIRED | Used in `parseDocumentPage` |
| `fetch-brf-auto.ts` | `org-nr-resolver.ts` | `resolveOrgNr(...)` | WIRED | Confirmed in `resolveOrgNrAction` |
| `fetch-brf-auto.ts` | `fetch-document.ts` | `fetchArsredovisning(...)` | WIRED | Confirmed in `confirmAndAnalyze` |
| `fetch-brf-auto.ts` | `run-extraction.ts` | `runBrfExtraction(..., "auto_allabrf")` | WIRED | Confirmed, identical pipeline invoked |
| `brf-section.tsx` | `fetch-brf-auto.ts` | `resolveOrgNrAction`\|`confirmAndAnalyze` | WIRED | Effect + onConfirm handler both call through |
| `brf-section.tsx` | `brf-confirm.tsx` | `BrfMatchConfirmation` | WIRED | Rendered in `confirm` view |
| `page.tsx` | `brf-section.tsx` | `<BrfSection listingData=... brfFetchSource=.../>` | WIRED (partial data) | `brfName`/`brf_fetch_source` genuinely threaded; `fiscalYear`/`isMostRecent` are hardcoded `null` — the link exists but the payload is structurally empty (see Data-Flow Trace) |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| `BrfMatchConfirmation` (confirm-time) | `fiscalYear` | `resolveOrgNrAction` → `fetchAllabrfDocument(orgNr)` preview | Yes | FLOWING (pre-analysis preview only) |
| `BrfScoreCard` (post-analysis, via `page.tsx`) | `fiscalYear`/`isMostRecent` | `page.tsx` hardcoded literal `null` | No | ✗ DISCONNECTED — no query, no column, no BrfData field feeds these props post-analysis |
| `BrfScoreCard` | `fetchSource` | `analysis.brf_fetch_source` (real DB column, migration 009) | Yes | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full phase test suite (13 relevant files) | `npx vitest run src/lib/brf/ src/lib/brf-source/ src/actions/analyze-brf.test.ts src/actions/fetch-brf-auto.test.ts src/components/brf-confirm.test.tsx src/components/brf-section.test.tsx src/lib/booli/fallback-tree.test.ts` | 124/124 passed | PASS |
| Full repo suite (regression check) | `npx vitest run` | 395 passed / 1 skipped (37 files) | PASS |
| Type safety | `npx tsc --noEmit` | clean, no output | PASS |
| Migration 009 live on remote | `supabase migration list --linked` | 009 present in both Local and Remote columns | PASS |
| `brf_fetch_source` column readable | direct Supabase query `select brf_fetch_source from analyses limit 1` | no error, `data: []` | PASS |
| No debt markers in phase files | grep TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER across all 15 phase files | 2 benign hits (a doc-comment mentioning a prior "Kommer snart" placeholder it replaced; an HTML `placeholder` attribute) | PASS (no real debt markers) |

### Probe Execution

No `scripts/*/tests/probe-*.sh` probes exist for this phase; not a migration/tooling phase requiring probe execution. SKIPPED (no runnable probes declared or found).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|--------------|--------|----------|
| ENRICH-01 | 08-01, 08-02, 08-03 | Auto-fetches årsredovisning from Bolagsverket/Allabrf, matched by org.nr not name-string | SATISFIED | Allabrf-primary auto-fetch with Luhn+geo-corroborated org.nr matching fully implemented and tested; Bolagsverket bulk-feed is a documented, intentional v1 discretion-zone deferral (08-02-PLAN `<deferred_ideas>`, rung slot reserved) — not a gap per the task's explicit scope framing |
| ENRICH-02 | 08-02, 08-03, 08-04 | Auto-fetched documents surface org.nr + fiscal year for confirmation; manual upload remains dependable fallback | PARTIAL | Confirmation-time surfacing of org.nr + fiscal year works and is human-in-the-loop gated (VERIFIED); manual upload fallback fully functional and regression-tested (VERIFIED); BUT the roadmap's explicit "shown prominently in the report, flagged when not most recent" success criterion is NOT met post-analysis — see Truth #9 / Gaps Summary |

No orphaned requirements — REQUIREMENTS.md maps only ENRICH-01/02 to Phase 8, and both appear in plan frontmatter across 08-01 through 08-04.

### Anti-Patterns Found

None blocking. No `TBD`/`FIXME`/`XXX` debt markers in any phase-modified file. No stub returns, no empty handlers, no hardcoded-empty props flowing to render in the reviewed files (the `fiscalYear={null}`/`isMostRecent={null}` pass-through in `page.tsx` is not a stub in the anti-pattern sense — it's an honest, explicitly-documented fallback the score card gracefully handles — but it is the root cause of Truth #9's failure and is captured as a gap, not an anti-pattern).

### Human Verification Required

### 1. Live end-to-end auto-fetch smoke test

**Test:** Run the app against a real Booli listing whose BRF has a recoverable `brfName` and a resolvable organisationsnummer on live Allabrf. Walk through: confirmation step shows org.nr + fiscal year → confirm → auto-fetch pre-step progress → identical A–F score card with "Källa: Allabrf" → staleness caption if applicable. Then test a low-confidence/no-match listing falls through to manual upload with no false error banner, and that a manual PDF upload still produces the same score card unchanged. Check server logs for `[brf-source]` lines on any rung failure, confirming no PII/HTML/financials are logged.
**Expected:** All behaviors described in 08-04-PLAN.md Task 4 `<how-to-verify>` hold on a real listing and live Allabrf.
**Why human:** Requires a running app, live network access to Allabrf (whose exact HTML/data-attribute shape is only assumed in `allabrf.test.ts`'s mocked fixtures), and a real listing — explicitly designated operator-only per 08-VALIDATION.md "Manual-Only Verifications" and never executed by the phase's executor (08-04-SUMMARY.md explicitly defers this checkpoint to the operator; all automated verification up to that gate is green).

### Gaps Summary

One genuine gap against the phase's own success criteria, cleanly scoped:

**Fiscal year + staleness are not persisted, so they never render post-analysis (ROADMAP Success Criterion 4).** The confirmation-time flow is fully correct — a user sees the org.nr and fiscal year and must confirm before anything is analyzed (ENRICH-02's human-in-the-loop requirement is genuinely met). But `FetchedDocument.fiscalYear`/`isMostRecent`, computed correctly by `fetch-document.ts`, are discarded the moment `confirmAndAnalyze` calls `runBrfExtraction` — no column, no `BrfData` field, and no code path carries them from the fetch to the persisted row. `page.tsx` explicitly hardcodes `fiscalYear={null}` and `isMostRecent={null}` (with an honest inline comment acknowledging this), so `BrfScoreCard`'s otherwise-correct fiscal-year line and staleness caption never render on any real, completed analysis — only the "Källa: X" provenance caption is live. This is not a hidden defect: 08-04-SUMMARY.md's own "Next Phase Readiness" section names this exact gap and proposes the fix (extend `BrfData`/migration or derive at render time). Because no later phase in ROADMAP.md explicitly claims this work, it is reported here as a real, unaddressed gap rather than deferred.

The live-Allabrf smoke test (08-04-PLAN.md Task 4) was intentionally left to the operator per this phase's task design and 08-VALIDATION.md's Manual-Only classification — correctly a `human_needed` item, not a gap.

---

*Verified: 2026-07-07T10:20:00Z*
*Verifier: Claude (gsd-verifier)*
