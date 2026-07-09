---
phase: 08-brf-auto-fetch
plan: 02
subsystem: api
tags: [brf, auto-fetch, ssrf, org-nr, allabrf, fallback-tree, security]

requires:
  - phase: 08-brf-auto-fetch
    plan: 01
    provides: "runBrfExtraction shared core + ixbrlToPlainText — this plan's fetched document text flows into the same extraction spine"
provides:
  - "resolveOrgNr(input) → OrgNrResolution — pure, no-network, geo-corroborated confidence gate over an injected candidate list"
  - "isValidOrgNr(candidate) → boolean — Swedish org.nr 10-digit + Luhn format validator"
  - "searchAllabrfByName / fetchAllabrfDocument — SSRF-guarded, host-allowlisted, size-bounded Allabrf fetch"
  - "fetchArsredovisning(orgNr) → FetchedDocument — phase-8-local fallback walker with real fiscal-year staleness"
affects: [08-03-fetch-brf-auto-action, 08-04-confirmation-ui]

tech-stack:
  added: []
  patterns:
    - "Pure-decision-logic module with network I/O injected by the caller (org-nr-resolver.ts) — deterministic unit tests, no fetch/undici/http import"
    - "Host allowlist as defense-in-depth ON TOP OF the shared resolve-then-pin SSRF guard, never instead of it"
    - "Phase-8-local fallback walker copying Phase 5's per-rung-logging/throw-on-exhaustion discipline without forking or generalizing the tested Booli code"

key-files:
  created:
    - src/lib/brf-source/org-nr-resolver.ts
    - src/lib/brf-source/org-nr-resolver.test.ts
    - src/lib/brf-source/allabrf.ts
    - src/lib/brf-source/allabrf.test.ts
    - src/lib/brf-source/fetch-document.ts
    - src/lib/brf-source/fetch-document.test.ts
  modified: []

key-decisions:
  - "resolveOrgNr is 100% pure (no network) — candidates are injected by the Plan 03 action layer, which calls searchAllabrfByName separately. This keeps the wrong-BRF confidence decision deterministically testable and source-agnostic (a future Bolagsverket candidate list can feed the same function unchanged)."
  - "assertAllowedHost is exported from allabrf.ts specifically so the host-allowlist rejection path can be unit-tested directly — the public API (searchAllabrfByName/fetchAllabrfDocument) always constructs an allowed-host URL internally, so exercising the rejection end-to-end would require breaking that invariant."
  - "walkBrfSources and BrfRung are exported from fetch-document.ts for direct unit testing of the >3-rungs loud-fail and rung-fallthrough behavior, matching the plan's explicit instruction to 'test the local walker directly'."
  - "A null return from a rung's attempt() is logged identically to a thrown error (both produce a `[brf-source] rung N (<source>) failed` line) so the fallback trail is equally visible whichever failure mode occurred."

patterns-established:
  - "Any future BRF source (Bolagsverket bulk-feed) only needs to (1) supply candidates in the org-nr-resolver.OrgNrCandidate shape and (2) implement a BrfRung whose attempt() returns FetchedDocument | null — the confidence gate and the walker never change."

requirements-completed: [ENRICH-01, ENRICH-02]

duration: 14min
completed: 2026-07-07
---

# Phase 8 Plan 2: BRF Source-Acquisition Layer (org.nr resolver + Allabrf fetch + fallback walker) Summary

**Built the confidence-gated org.nr resolver, the SSRF-guarded/host-allowlisted Allabrf fetch, and the phase-8-local fallback-tree walker as three pure/testable modules — org.nr resolution fails closed to `low`/`none` on anything short of an exactly-one, geography-corroborated, Luhn-valid match, and the walker never returns a silent empty result.**

## Performance

- **Duration:** 14 min
- **Started:** 2026-07-07T07:28:00Z
- **Completed:** 2026-07-07T07:42:00Z
- **Tasks:** 3 (all auto/tdd)
- **Files modified:** 6 (6 created, 0 modified)

## Accomplishments
- `resolveOrgNr` is pure decision logic (zero network imports — verified by a dedicated test reading its own source) that only ever returns `confidence: "high"` when exactly one name-normalized candidate exists AND its kommun corroborates the listing's own kommun AND its org.nr passes Luhn — a name-only match (ambiguous or geographically uncorroborated) always falls to `low`, per the Pitfall 4 wrong-BRF guard
- `isValidOrgNr` implements the Swedish 10-digit + Luhn (mod-10) checksum, accepting both `NNNNNN-NNNN` and `NNNNNNNNNN` forms; verified against the plan's exact stated fixtures (`5560360793` valid, `5560360794` invalid)
- `allabrf.ts`'s fetch orchestration reuses `resolveSafeExternalUrl` (imported, not forked) plus its own `ALLABRF_ALLOWED_HOSTS` allowlist as defense-in-depth, pins the TCP connection via a per-request `undici.Agent`, treats 3xx/opaqueredirect as failure, and caps the response body at 8 MB via a streaming reader that stops buffering once the cap is exceeded rather than truncating an already-fully-read string
- An org.nr failing `isValidOrgNr` is rejected in `fetchAllabrfDocument` before any `URL`/fetch call is constructed — verified by a test asserting the fetch spy was never invoked
- `fetch-document.ts`'s `walkBrfSources` is a phase-8-local walker (zero occurrences of the Booli walker's identifier in the file, verified by grep) copying the exact per-rung-logging + `rungs.length > 3` loud-fail + throw-on-exhaustion discipline; `fetchArsredovisning` throws `/Alla årsredovisningskällor misslyckades/` when the single v1 Allabrf rung fails, never returning undefined/empty
- `computeIsMostRecent` has a real code path exercising all three staleness outcomes: `false` when a newer year is known, `true` when the fetched year is the newest known, `null` (never fabricated `true`) when `availableYears` is empty

## Task Commits

Each task was committed atomically:

1. **Task 1: org.nr resolver — confidence gate + Luhn validation** - `51184eb` (feat)
2. **Task 2: Allabrf SSRF-guarded fetch** - `16ce2d3` (feat)
3. **Task 3: Phase-8-local fallback walker + fiscal-year staleness** - `20f5fb7` (feat)

## Files Created/Modified
- `src/lib/brf-source/org-nr-resolver.ts` - `isValidOrgNr`, `resolveOrgNr`, `OrgNrResolution`, `OrgNrCandidate` — pure, no-network confidence gate
- `src/lib/brf-source/org-nr-resolver.test.ts` - 18 tests: Luhn valid/invalid/wrong-length/non-numeric/hyphenated, high/low/none confidence paths, name-normalization equivalence, no-network-I/O source-scan assertion
- `src/lib/brf-source/allabrf.ts` - `searchAllabrfByName`, `fetchAllabrfDocument`, `assertAllowedHost` (exported for testing), `ALLABRF_ALLOWED_HOSTS`, `MAX_DOC_BYTES` — SSRF-guarded + host-allowlisted + size-bounded fetch, cheerio parse, `ixbrlToPlainText` strip
- `src/lib/brf-source/allabrf.test.ts` - 15 tests: happy-path candidate/document parse, malformed HTML, disallowed host (allowlist unit tests), invalid-org.nr pre-fetch rejection, guard-rejected URL, 3xx/opaqueredirect-as-failure, size-cap enforcement, PII-safe-logging assertion
- `src/lib/brf-source/fetch-document.ts` - `FetchedDocument`, `BrfRung` (exported), `walkBrfSources` (exported), `fetchArsredovisning`, `computeIsMostRecent` — local fallback walker + staleness flag
- `src/lib/brf-source/fetch-document.test.ts` - 11 tests: all three `isMostRecent` cases, all-rungs-fail Swedish-message throw (both null-return and thrown-error failure modes), >3-rungs loud-fail, rung-fallthrough, no-walkFallbackTree-import source-scan assertion

## Decisions Made
- Kept `resolveOrgNr` fully network-free by design (candidates injected) rather than having it call `searchAllabrfByName` itself — this matches the plan's explicit instruction and keeps the confidence-gate logic reusable against a future Bolagsverket candidate source with zero changes
- Exported `assertAllowedHost` from `allabrf.ts` and `walkBrfSources`/`BrfRung` from `fetch-document.ts` purely for direct unit testability of security-critical branches that the public API's hardcoded URL construction would otherwise make unreachable in tests
- Treated a rung's `null` return identically to a thrown error in the walker's logging (both log a `[brf-source] rung N (<source>) failed` line) so the fallback trail is equally observable regardless of failure mode — the plan's `<behavior>` block specifies this for "every failed rung" without distinguishing throw vs. null

## Deviations from Plan

None - plan executed exactly as written. All three modules match their specified exports, behaviors, and acceptance criteria; no Rule 1-4 fixes were needed.

## Issues Encountered
- `gsd-tools` is not on `PATH` in this environment (consistent with Plan 01's note); state/commit steps in this execution were performed directly via `git`, matching the sequential-executor instructions for this plan (no orchestrator SDK calls were available or required for the per-task commit protocol).

## User Setup Required

None - no external service configuration required. All three modules are pure/self-contained; live Allabrf verification is explicitly operator-only per 08-VALIDATION.md and out of scope for this plan's automated tests (all network calls are mocked).

## Next Phase Readiness
- Plan 03's `fetch-brf-auto.ts` action layer can now: (1) call `searchAllabrfByName(brfName)` to get a candidate list, (2) pass it + listing geography into `resolveOrgNr` for the confidence gate, and (3) call `fetchArsredovisning(orgNr)` to get a `FetchedDocument` ready for Plan 01's `runBrfExtraction` (as an `{kind:'ixbrl-text'}` `BrfDocumentSource`)
- `FetchedDocument.source` (`"auto_allabrf" | "auto_bolagsverket"`) matches the `brf_fetch_source` column's expected value shape from Plan 01's migration 009
- The Bolagsverket bulk-feed rung slot is reserved but unbuilt — Plan 03 should treat Allabrf as the only v1 auto-fetch source and rely on `fetchArsredovisning`'s throw as the manual-upload fall-through trigger

---
*Phase: 08-brf-auto-fetch*
*Completed: 2026-07-07*

## Self-Check: PASSED

All six created files (org-nr-resolver.ts/.test.ts, allabrf.ts/.test.ts, fetch-document.ts/.test.ts) confirmed present on disk; all three task commits (`51184eb`, `16ce2d3`, `20f5fb7`) confirmed present in git history.
