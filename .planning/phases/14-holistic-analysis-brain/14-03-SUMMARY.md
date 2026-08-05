---
phase: 14-holistic-analysis-brain
plan: 03
subsystem: discovery
tags: [brf, org-nr-resolver, allabrf, vitest, discovery-orchestrator]

# Dependency graph
requires:
  - phase: 14-01
    provides: "DiscoveryCandidate.kommun (populated at scrape time from breadcrumbs), holistic-schema.ts's BrfSummary type + tomtrattFromTenureForm, VISION_MODULE_SPECIFIERS pre-registered with discovery/brf-lookup"
  - phase: 08-brf-auto-fetch
    provides: "the reusable brf-source/brf primitives (searchAllabrfByName, resolveOrgNr, fetchAllabrfDocument, extractBrfFinancials, scoreExtraction) this plan composes without touching the analyses-bound action layer"
provides:
  - "normalizeKommun exported and genitive-tolerant — a Booli genitive kommun label now corroborates a registry nominative kommun inside resolveOrgNr's geoCorroborated check (D-14-09), unblocking ANL-03's confidence:'high' gate for discovery candidates"
  - "src/lib/discovery/brf-lookup.ts — the discovery-side BRF orchestrator: lookupBrfSummary(input) -> Promise<BrfLookupResult>, never throws, exports BRF_TOP_N = 4"
  - "A static source-grep test proving the discovery BRF path can never reach the single-listing analysis table or its analysis-bound actions/extraction spine (D-14-12)"
affects: [14-04, 14-05, 14-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Shared normalization helper extracted so two comparison functions (normalizeName/normalizeKommun) can never drift apart"
    - "Never-throwing orchestrator with a named BrfLookupOutcome per degrade path (mirrors allabrf.ts's never-throws contract, one layer up)"
    - "Static source-grep invariant test enforcing a reuse boundary (D-14-12), reworded to avoid literally containing the forbidden substrings it asserts against (14-01 precedent)"

key-files:
  created:
    - src/lib/discovery/brf-lookup.ts
    - src/lib/discovery/brf-lookup.test.ts
  modified:
    - src/lib/brf-source/org-nr-resolver.ts
    - src/lib/brf-source/org-nr-resolver.test.ts
    - src/actions/fetch-brf-auto.ts

key-decisions:
  - "normalizeKommun's genitive-stripping chain (lowercase/trim/transliterate -> strip ' kommun'/' stad' suffix -> strip a single trailing possessive 's' when the stem is >3 chars) is applied to BOTH sides of resolveOrgNr's comparison, so the transform is symmetric and cannot create a one-sided false match; the bounded residual risk (two distinct kommuns differing only by a trailing 's') has no real-world instance among Sweden's 290 kommuns"
  - "BRF_TOP_N = 4 (D-14-01 midpoint of 3-5) — two-deep coverage on both halves of the enrichmentPriority ranking while keeping worst-case spend (4 x ~0.8 SEK Haiku extraction) inside CAP_VISION_SEK_MAX=10"
  - "resolveOrgNr's confidence gate stays hard-pinned to 'high' in brf-lookup.ts — D-14-09 explicitly rejected relaxing it to 'low', since attributing the wrong BRF's avgift/debt to a real listing is a financial-correctness failure, not a UX inconvenience"
  - "Doc comments and the invariant test in brf-lookup.ts/.test.ts describe the D-14-12 reuse boundary WITHOUT literally spelling out the forbidden identifiers/substring 'analyses' — otherwise the plan's own acceptance-criteria grep (which checks for zero occurrences) would be tripped by the very comment explaining the boundary (same class of self-referential grep trap as 14-01's holistic-schema.ts deviation)"

requirements-completed: [ANL-03]

# Metrics
duration: 20min
completed: 2026-08-05
---

# Phase 14 Plan 03: BRF Genitive-Kommun Fix + Discovery BRF Orchestrator Summary

**Made `normalizeKommun` genitive-tolerant so `resolveOrgNr` can reach `confidence: "high"` for a discovery candidate, then built `src/lib/discovery/brf-lookup.ts` — a never-throwing BRF orchestrator composed purely from the reusable `brf-source`/`brf` primitives, structurally forbidden from ever touching the single-listing analysis table.**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-08-05T21:08:00+02:00
- **Tasks:** 3
- **Files modified:** 5 (2 created, 3 modified)

## Accomplishments

- `normalizeKommun` is now exported (Phase 08-02 precedent: `assertAllowedHost`) and genitive-tolerant: `normalizeKommun("Stockholms kommun") === normalizeKommun("Stockholm") === "stockholm"`, while genuinely different kommuns (`"Solna"`/`"Sollentuna"`, `"Vara"`/`"Varberg"`) still fail to collapse. `resolveOrgNr`'s own decision logic, confidence tiers, and fail-closed ambiguity guard are byte-for-byte unchanged — only `normalizeKommun`'s body changed (verified via `git diff` scope inspection).
- `resolveOrgNr` now reaches `confidence: "high"` for a single Luhn-valid name match where the listing kommun is Swedish genitive (`"Stockholms"`) and the registry candidate's kommun is nominative (`"Stockholm"`) — proven by a dedicated `describe` block in `org-nr-resolver.test.ts`, and again end-to-end through the real (unmocked) `resolveOrgNr` inside `brf-lookup.test.ts`'s `"ok"` case.
- `src/lib/discovery/brf-lookup.ts` exports `BRF_TOP_N = 4` and `lookupBrfSummary`, composing `searchAllabrfByName` → `resolveOrgNr` (high-only gate) → `fetchAllabrfDocument` → `extractBrfFinancials` → `scoreExtraction` into a `BrfLookupResult` that never throws — every failure mode (`no_name`, `no_candidates`, `low_confidence`, `no_document`, `extract_failed`) degrades to a named outcome with `summary: null`.
- A static source-grep test proves `brf-lookup.ts` contains zero references to the single-listing analysis table (`"analyses"`), its analysis-bound actions (`runBrfExtraction`, `resolveOrgNrAction`, `confirmAndAnalyze`), or `@/lib/supabase` — the D-14-12 reuse boundary is now structurally enforced, not just documented.
- 9 tests in `brf-lookup.test.ts` cover every `BrfLookupOutcome` (including both `low_confidence` variants — ambiguous name match and geo mismatch, each proving `fetchAllabrfDocument` is never called), the GDPR-safe `extract_failed` logging (coded error present, fixture document text absent from the log), the `tomtratt` derivation for both tenure forms, and the `BRF_TOP_N` pin.

## Task Commits

Each task was committed atomically:

1. **Task 1: Make normalizeKommun genitive-tolerant and export it** - `5f2583c` (fix)
2. **Task 2: Create brf-lookup.ts — the discovery-side BRF orchestrator** - `ec7ac74` (feat)
3. **Task 3: Unit-test every brf-lookup outcome plus the "never touches analyses" invariant** - `fc2a49b` (test)

_No TDD tasks in this plan — Task 1 is a targeted bugfix with same-commit tests (RED/GREEN not separated since the existing 20 tests already passed unmodified and only new assertions were added), Task 2/3 are a build-then-test pair mirroring the 14-01 precedent (schema/module additions with same-commit tests, not separate RED/GREEN cycles)._

## Files Created/Modified

- `src/lib/brf-source/org-nr-resolver.ts` - Extracted `normalizeSwedishText` (shared lowercase/trim/transliterate chain) out of `normalizeName`; `normalizeKommun` is now exported, genitive-tolerant (strips `" kommun"`/`" stad"` suffix, then a single trailing possessive `"s"` when the stem is >3 chars), with a doc comment recording the WHY / WHY-SAFE / bounded-residual-risk reasoning. `resolveOrgNr`'s body is unchanged.
- `src/lib/brf-source/org-nr-resolver.test.ts` - New `describe("normalizeKommun — Swedish genitive tolerance (D-14-09)")` (6 tests: genitive+suffix, bare genitive, another kommun, `" stad"` suffix, idempotence on an already-`s`-ending kommun, negative cases) and `describe("resolveOrgNr — genitive kommun now corroborates (D-14-09)")` (3 tests: genitive-vs-nominative reaches `"high"`, mismatched kommun still `"low"`, two-name-match still `"low"` regardless of kommun).
- `src/actions/fetch-brf-auto.ts` - Updated the `kommunFromBreadcrumbs` call-site doc comment: replaced the "accepted v1 limitation, not a bug" framing with a statement that the genitive mismatch is now handled by `normalizeKommun` (D-14-09, this plan).
- `src/lib/discovery/brf-lookup.ts` - NEW: `BRF_TOP_N = 4`, `BrfLookupOutcome`, `BrfLookupResult`, `BrfLookupInput`, `lookupBrfSummary` — the discovery-side BRF orchestrator, zero DB/Supabase access, zero references to the single-listing analysis table or its analysis-bound actions/spine.
- `src/lib/discovery/brf-lookup.test.ts` - NEW: 9 tests — one per `BrfLookupOutcome` value (7 outcomes including both `low_confidence` variants) plus a `BRF_TOP_N` pin test and the static D-14-12 invariant test.

## Decisions Made

- The genitive-stripping transform in `normalizeKommun` is deliberately lossy but symmetric: since `resolveOrgNr` normalizes BOTH the listing's kommun and the candidate's registered kommun through the exact same function, a symmetric transform cannot introduce a one-sided false match. The only theoretical failure mode (two distinct Swedish kommuns differing solely by a trailing "s") does not exist among Sweden's 290 kommuns.
- `brf-lookup.ts`'s file-level doc comment and its invariant test describe the D-14-12 reuse boundary using paraphrases ("the single-listing action layer's extraction spine", "the single-listing analysis table") instead of the literal identifiers `runBrfExtraction`/`resolveOrgNrAction`/`confirmAndAnalyze`/`analyses` — mirroring the 14-01 `holistic-schema.ts` precedent where the plan's own literal-substring acceptance-criteria grep would otherwise be tripped by the comment explaining the very thing it forbids.
- Task 1 and Tasks 2+3 were kept as separate commits (rather than one combined commit) since Task 1 is a standalone bugfix to an existing module fully independent of the new `brf-lookup.ts` orchestrator, giving a cleaner bisectable history.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Reworded brf-lookup.ts's doc comments to avoid tripping its own acceptance-criteria grep**
- **Found during:** Task 2, immediately after writing `brf-lookup.ts`'s first draft
- **Issue:** The plan's own action text instructs the file-level doc comment to literally name `runBrfExtraction`, `resolveOrgNrAction`, `confirmAndAnalyze`, and the `analyses` table — but the plan's acceptance criteria simultaneously require `grep -c 'analyses' ...` and `grep -c 'runBrfExtraction\|resolveOrgNrAction\|confirmAndAnalyze\|@/lib/supabase' ...` to both return 0. Following the action's literal wording would fail its own acceptance criteria.
- **Fix:** Reworded the two doc-comment passages to convey the identical meaning (never call the single-listing extraction spine or its two BRF auto-fetch actions; never touch the single-listing analysis table) without using the literal forbidden substrings. Re-ran both greps: both now return 0.
- **Files modified:** `src/lib/discovery/brf-lookup.ts`
- **Verification:** `grep -c 'analyses' src/lib/discovery/brf-lookup.ts` → 0; `grep -c 'runBrfExtraction\|resolveOrgNrAction\|confirmAndAnalyze\|@/lib/supabase' src/lib/discovery/brf-lookup.ts` → 0; the static invariant test in `brf-lookup.test.ts` (Task 3) independently re-asserts the same zero-occurrence guarantee.
- **Committed in:** `ec7ac74` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking — self-referential grep trap, same class as 14-01's precedent)
**Impact on plan:** No scope creep; the fix preserves 100% of the doc comment's intended meaning while satisfying the plan's own literal acceptance criteria.

## Issues Encountered

- A pre-existing, timing-sensitive test flake under full-suite parallel load surfaced during `npm run test` (two different runs failed two different unrelated tests: `allabrf.test.ts`'s 9 MB size-cap test timing out at its 5000ms `testTimeout`, and a separate concurrency-timing assertion elsewhere in the suite). Neither failing test is in this plan's `files_modified`; both pass reliably in isolation. Logged to `.planning/phases/14-holistic-analysis-brain/deferred-items.md` per the SCOPE BOUNDARY rule — not fixed, not a regression from this plan.

## Verification (from the plan's `<verification>` block)

- `npx vitest run src/lib/brf-source/org-nr-resolver.test.ts src/lib/discovery/brf-lookup.test.ts` — **36/36 passed** (27 org-nr-resolver + 9 brf-lookup).
- `npx vitest run src/lib/brf-source/allabrf.test.ts src/lib/brf-source/fetch-document.test.ts` (regression on the reused primitives) — **passed** (isolated run; see Issues Encountered for the full-suite flake).
- `npx vitest run src/lib/discovery/niche-score.test.ts` (separation guard, `discovery/brf-lookup` specifier already pre-registered by 14-01) — **18/18 passed**.
- `npx tsc --noEmit` — clean.
- `npm run lint` — clean.
- `npm run test` (full suite) — 814-817/818 passed depending on run, both non-reproducing failures unrelated to this plan's files (see Issues Encountered / deferred-items.md).
- Combined named-file run (`org-nr-resolver.test.ts` + `brf-lookup.test.ts` + `allabrf.test.ts` + `fetch-document.test.ts` + `niche-score.test.ts`) — **80/80 passed** in one process.
- DEFERRED-LIVE (per this plan's own instruction, and the environment note for this execution): a live Allabrf confirmation that a real single-name match with a genitive kommun actually returns `confidence: "high"` is unverifiable here — the operator IP is Booli/Cloudflare-blocked and the Supabase project is paused. Recorded as an operator gate per 14-VALIDATION.md's Manual-Only Verifications table, not a phase blocker.

## Known Stubs

None — `brf-lookup.ts` is a fully functional orchestrator over already-implemented primitives; no placeholder/mock data path exists in the shipped code (only in tests, which mock the network/LLM edges, not the module's own logic).

## Threat Flags

None — every trust boundary this plan touches (org.nr → Allabrf document URL; wrong-BRF financial attribution; document text → Anthropic call; discovery path writing to the analysis table) is already covered by the plan's own `<threat_model>` (T-14-09 through T-14-13), and this plan's implementation follows those mitigations exactly (SSRF guard reused unchanged, confidence gate preserved verbatim, GDPR-safe logging, static reuse-boundary test).

## User Setup Required

None - no external service configuration required. No DB migration (BRF summaries ride in the existing JSONB `results` column via `DiscoveryCandidate.brfSummary`, added in 14-01).

## Next Phase Readiness

- `lookupBrfSummary`/`BRF_TOP_N` are ready for plan 14-04's concurrency wiring (D-14-10's bounded `Promise.allSettled` over the top-N candidates) and plan 14-06's cost-gated caller.
- The genitive-kommun fix is load-bearing for ANY future discovery-side BRF work — without it, `resolveOrgNr` would never reach `"high"` for a real Booli-sourced candidate, silently making the whole BRF top-N a no-op in production.
- **Operator next step (unchanged from STATE.md, carried forward):** once the Supabase project is restored from its paused state and the operator IP is no longer Booli/Cloudflare-blocked, run a real discovery job through `lookupBrfSummary` against a live Allabrf-registered BRF with a genitive breadcrumb kommun to confirm the `"high"`-confidence path fires end-to-end outside of mocks (DEFERRED-LIVE, not a phase blocker).
- No blockers for 14-04/14-05/14-06 — this plan's exports (`BRF_TOP_N`, `lookupBrfSummary`, `BrfLookupResult`, `BrfLookupOutcome`, `BrfLookupInput`) are stable and fully unit-tested.

## Self-Check: PASSED

All claimed files exist on disk (`src/lib/brf-source/org-nr-resolver.ts`, `org-nr-resolver.test.ts`, `src/actions/fetch-brf-auto.ts`, `src/lib/discovery/brf-lookup.ts`, `brf-lookup.test.ts`, `.planning/phases/14-holistic-analysis-brain/deferred-items.md`, `14-03-SUMMARY.md`) and all four commit hashes (`5f2583c`, `ec7ac74`, `fc2a49b`, `a4463de`) are present in `git log --oneline --all`.

---
*Phase: 14-holistic-analysis-brain*
*Completed: 2026-08-05*
