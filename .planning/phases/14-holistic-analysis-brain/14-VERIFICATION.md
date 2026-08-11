---
phase: 14-holistic-analysis-brain
verified: 2026-08-10T14:10:00Z
status: passed
verifier_status: human_needed
score: 4/4 must-haves verified
overrides:
  - must_have: "ANL-03: BRF summary includes soliditet"
    reason: "No field exists on brfExtractionSchema; rarely cleanly extractable from iXBRL; debt/m² carries most of the balance-sheet signal (14-CONTEXT.md D-14-02, and the matching Deferred Ideas entry). Accepted as a scope deferral, not a defect — the remaining ANL-03 fields (avgift, debt/m², stambyte funding state, tomträtt) ship and are fixed by plans 14-07 and 14-10."
    accepted_by: "Daniel Westerholm"
    accepted_at: "2026-08-08T14:51:40Z"
  - must_have: "The four live-operator human_verification items below"
    reason: >
      All 4/4 automated must-haves verified against source, and the verifier found
      no regressions across the 20 fix(14) commits. The verifier returned
      human_needed solely because of the four live-operator items in
      human_verification, none of which a mocked test can substitute for (real
      Apify/Allabrf latency, real spend accounting, real Allabrf extraction
      quality). None are new — all four are carried forward unchanged from prior
      passes. Items persisted to 14-UAT.md so they remain discoverable via
      /gsd-progress and /gsd-audit-uat; work them with /gsd-verify-work 14.
      CORRECTED 2026-08-11 — this override originally justified the deferral with
      two environment blockers, BOTH incorrect: (1) the Supabase project was
      already restored (verified live 2026-08-11, area_cache HTTP 200 in 0.14s,
      table empty so resolveArea does live probes on a first run); (2) "operator IP
      is Booli/Cloudflare-blocked" is structurally incoherent here — no
      direct-fetch rung to Booli exists, every rung runs through
      apify/playwright-scraper on an Apify RESIDENTIAL/SE proxy
      (src/lib/booli/transport.ts:75), so the operator's IP never contacts Booli.
      The items are UNRUN, not blocked, and are runnable today.
    accepted_by: "Daniel Westerholm"
    accepted_at: "2026-08-10T14:20:00Z"
    corrected_at: "2026-08-11T00:00:00Z"
    tracked_in: ".planning/phases/14-holistic-analysis-brain/14-UAT.md"
overrides_applied: 2
re_verification:
  previous_status: gaps_found
  previous_score: 3/4
  gaps_closed:
    - "ANL-04: HIGH_BRF_DEBT_PER_SQM (15k, SPEC §2.2 alarm) no longer shares a value with BRF_SANITY_BANDS.skuldPerKvm.max (the implausibility ceiling). A new IMPLAUSIBLE_BRF_DEBT_PER_SQM = 60_000 and brfDebtPerSqmUsable() split 'is this even a debt/m² figure' (misextraction, suppressed) from 'is this förening dangerously indebted' (real signal, trusted for arithmetic AND named brf_debt_high). Independently re-derived against source: confounder-guard.ts:47/78/112-126, sanity.ts left deliberately unmodified (confirmed still shared with the single-listing Osäker badge / /sa-raknar-vi)."
    - "ANL-04: a real-pipeline-reachable test now exists — brf-lookup.test.ts:334 runs lookupBrfSummary end-to-end (mocking only the Allabrf/Claude edges, so scoreExtraction -> applySanityChecks executes for real) with a genuinely high 30_000 skuldPerKvm, asserts the real pipeline band-downgrades its confidence below OSAKER_THRESHOLD, and then asserts brfDebtPerSqmUsable() still returns true, debtIncluded/effectivePricePerSqm fold the debt in, brf_debt_high fires, and buildHolisticBrief renders it with the '(högre än vanligt)' flag. This is not a fixture that bypasses applySanityChecks — traced brf-lookup.ts:174 (scoreExtraction call, no manualFields) end to end."
    - "ANL-04: buildBrfItem (confounder-guard.ts:626-642) now gates the debt sentence on brfDebtPerSqmUsable, not brfFieldTrusted — a real 20-40k debt renders as fact with the flag; only a >60k implausible misextraction is withheld. Confirmed by direct read plus confounder-guard.test.ts:430-443 and brf-lookup.test.ts:396-406."
  gaps_remaining: []
  regressions: []
deferred: []
human_verification:
  - test: "Live end-to-end discovery run: real comps + BRF fetched and folded into a real multi-area job, within the CAP_VISION_SEK_MAX cost cap and inside the tick window."
    expected: "Comps fetched once per distinct area, BRF attempted only for top-N, cost_sek_total stays within cap, no tick timeout, every candidate shows ≥1 actionable item."
    why_human: "No mocked test can observe real Apify/Allabrf latency, real spend accounting, or true end-to-end wall-clock inside the ~300s ceiling. CORRECTED 2026-08-11: previously cited a paused Supabase project and a Booli-blocked operator IP — both incorrect (Supabase is live; all Booli traffic goes via the Apify RESIDENTIAL/SE proxy, never the operator IP). Runnable now; see 14-UAT.md."
  - test: "Confirm genitive kommun corroboration reaches resolveOrgNr confidence 'high' against the live Allabrf registry for unambiguous single-name matches."
    expected: "'high' confidence reached for real BRF names, unblocking the BRF top-N lookup in production (today gated to 'high' only, per D-14-09's explicit rejection of relaxing to 'low')."
    why_human: "Only fixture-level genitive forms have been tested; real registry spelling variance can only be confirmed live."
  - test: "Capture real tenureForm values across a wide live result set to determine whether a tomträtt-shaped value ever appears at all."
    expected: "Either at least one tomträtt-bearing tenureForm is observed (confirming the confounder is live), or confirmation that it is currently inert in production (should be recorded, not silently assumed working)."
    why_human: "Every committed tenureForm fixture is 'Bostadsrätt' — no tomträtt sample exists in the test suite to verify against (14-RESEARCH.md OQ-2)."
  - test: "Now that the CR-02 fix has landed (commit b841563), re-run against a real Allabrf-extracted BRF document with a genuinely high debt/m² to confirm the rendered figure is displayed as fact with the '(högre än vanligt)' flag and included in effectivePricePerSqm, exactly as the mocked brf-lookup.test.ts:334 test predicts."
    expected: "A real 20-40k kr/m² debt is shown, flagged, folded into the debt-inclusive price basis, and named brf_debt_high — matching the mocked test's assertions against real production data, not just a fixture."
    why_human: "Requires a real Allabrf document with genuinely high debt; the mocked pipeline test proves the code path is now reachable and correct, but a live document is needed to confirm Allabrf's real extraction quality at this debt level (OCR legibility, table layout variance) matches the fixture's assumed shape."
---

# Phase 14: Holistic Analysis Brain — Verification Report

**Phase Goal:** Every surfaced candidate is analyzed against holistic context — renovated-vs-unrenovated area comps and its BRF's finances — always leaves analysis with ≥1 actionable opportunity, and never mistakes a low kr/m² for a renovation signal.
**Verified:** 2026-08-10T14:10:00Z
**Status:** human_needed
**Re-verification:** Yes — third pass, after the `/gsd-code-review 14 --fix` pass (commits `b841563`..`7fa3c91`, 20 atomic fixes) that specifically targeted the ANL-04 gap this verifier identified in the previous pass.

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth (ROADMAP SC) | Status | Evidence |
|---|---|---|---|
| 1 | Ringvägen 122 scenario: a dated flat with zero surviving image claims now surfaces ≥1 actionable opportunity via a holistic-data-only brief instead of `claims: []` | ✓ VERIFIED | Unchanged mechanism (`buildHolisticBrief`'s non-empty post-composition guarantee, `confounder-guard.ts:701-709`). **Regression-checked**: WR-16 (commit `faba0b6`) fixed a genuine reachability bug in `gallery-condition-vision.tsx` where the state `vision === null && visionSkippedReason === null` got a brief attached by `job.ts` but rendered in neither of the two old cells — a real gap in this exact truth's UI wiring, now closed and covered by a new test. This *strengthens* truth 1 rather than regressing it. Full suite green (972/975, 3 pre-existing skips, 0 failures) including `gallery-condition-vision.test.tsx` and `confounder-guard.test.ts` (independently re-run: 89/89 pass in isolation). |
| 2 | Value case folds in R_med/U_med (`computeAreaComps`) via the re-resolved areaId; analysis references how kr/m² sits against renovated vs unrenovated comps | ✓ VERIFIED | Unchanged core mechanism. **Regression-checked**: WR-10 (`8d81373`) made `buildCompsPositioningItem` actually state the candidate's own kr/m² and its distance from the renovated median (previously computed but unconsumed) — this is an improvement to this exact truth, not a regression, and it makes the ANL-04 debt-inclusive fix *visible* to the user (a debt-inclusive price reads correctly against the median instead of the raw asking price). WR-13 fixed a comps-starvation cap (`MAX_AREAS_PER_SEARCH` reuse bug) unrelated to this truth's correctness but improving its reach. All comps-path tests green. |
| 3 | Top candidates' value case folds in the BRF summary — avgift, debt/m², stambyte funding state, tomträtt, soliditet | ✓ VERIFIED (override applied on soliditet) | Unchanged from prior pass on avgift/stambyte/tomträtt. **The cross-cutting warning from the previous pass — a genuinely high (>15k, real) debt figure being suppressed as "outside a reasonable range" — is now resolved as part of the ANL-04 fix** (see truth 4): `buildBrfItem` (`confounder-guard.ts:626-642`) now displays a real 20-60k debt as fact with the flag. `soliditet` deferral carried forward unchanged via the human-accepted override below. WR-02 (extraction retry cost undercounting) is now fixed too (commit `8107593`, new `extract.test.ts`), closing the previous pass's remaining cost-accounting warning for this truth. |
| 4 | Low kr/m² is normalized against confounders (incl. BRF debt) before any condition/reno attribution; UI never renders text implying "low kr/m² ⇒ renovation object" | ✓ VERIFIED — previously confirmed BLOCKER now closed | The UI-facing text guard (`BANNED_RENO_ATTRIBUTION_PATTERNS`) remains solid, unchanged, still green. **The debt-normalization defect this verifier identified in the previous pass is independently confirmed fixed against current source** (not taken on the fix report's word): `HIGH_BRF_DEBT_PER_SQM = 15_000` (`confounder-guard.ts:47`, the SPEC §2.2 alarm) is now a materially distinct constant from the new `IMPLAUSIBLE_BRF_DEBT_PER_SQM = 60_000` (`:78`, the misextraction ceiling). `brfDebtPerSqmUsable()` (`:112-126`) branches on WHY `applySanityChecks` downgraded confidence: a value inside `BRF_SANITY_BANDS.skuldPerKvm` [2000,15000] still respects the ordinary `OSAKER_THRESHOLD` gate (a genuinely illegible in-band reading stays suppressed); a value outside the band but ≤60k is admitted, because the band-forced 0.2 confidence carries no legibility information for that case; a value >60k or negative is suppressed as a likely denominator/unit misextraction. `sanity.ts` was verified deliberately unmodified (confirmed still shared with the single-listing "Osäker" badge and `/sa-raknar-vi`, per its own doc comments — no scope creep). Traced the gate's three consumers: rule 1 (`:239-245`, debt now folds into `effectivePricePerSqm`), rule 5 (`:292-294`, `brf_debt_high` now reachable), and `buildBrfItem`'s display flag (`:633-635`, "(högre än vanligt)" now reachable). |

**Score:** 4/4 truths verified. All four requirement IDs (ANL-01..04) remain present in PLAN frontmatter across all ten plans with no orphans (unchanged from prior pass; no PLAN/SUMMARY/REQUIREMENTS files were touched by the fix pass — confirmed via `git diff --stat` against `.planning/`).

### Deep-Dive: the ANL-04 fix, verified against source (not the fix report's narrative)

**Missing item 1 — separate the implausibility ceiling from the alarm threshold.** CONFIRMED. `confounder-guard.ts:46-78` defines both constants with an extensive doc comment explaining why they must never share a value, and a dedicated test (`confounder-guard.test.ts:445-451`) pins `IMPLAUSIBLE_BRF_DEBT_PER_SQM > HIGH_BRF_DEBT_PER_SQM > 0` and `HIGH_BRF_DEBT_PER_SQM === BRF_SANITY_BANDS.skuldPerKvm.max` (the alarm threshold intentionally still equals the shared band — the fix is that the band alone no longer decides usability).

**Missing item 2 — a test reachable through the real `scoreExtraction` → `applySanityChecks` pipeline.** CONFIRMED. `brf-lookup.test.ts:334-406` ("CR-02 re-review — a REAL high-debt extraction reaches brf_debt_high...") mocks only `searchAllabrfByName`/`fetchAllabrfDocument`/`extractBrfFinancials` — the Allabrf/Claude I/O edges — and calls the real `lookupBrfSummary`, which calls the real `scoreExtraction(result.parsed)` (`brf-lookup.ts:174`, confirmed no `manualFields` override is ever supplied on this path, matching the original gap's root cause). The test asserts the real pipeline DOES band-downgrade `skuldPerKvm: 30_000`'s confidence below `OSAKER_THRESHOLD` (`fieldConfidence.skuldPerKvm < OSAKER_THRESHOLD`, `brfFieldTrusted(...) === false`) — i.e. it deliberately reproduces the exact shape that was previously unreachable in a non-bypassing test — and then asserts `brfDebtPerSqmUsable(...) === true`, that the debt folds into `effectivePricePerSqm`, that `brf_debt_high` fires, and that `buildHolisticBrief` renders the flagged sentence. Ran this test file directly (`npx vitest run src/lib/discovery/brf-lookup.test.ts`): passes.

**Missing item 3 — `buildBrfItem` displays a real 20-40k debt as fact with the flag.** CONFIRMED by direct source read: `confounder-guard.ts:626-642` gates the debt sentence on `brfDebtPerSqmUsable(brf)` (not `brfFieldTrusted`), and on the true branch appends `" (högre än vanligt)"` when `skuldPerKvm > HIGH_BRF_DEBT_PER_SQM`. Two independent tests exercise this: `confounder-guard.test.ts:430-443` (unit-level, asserts the text contains the flag and neither hedge sentence) and `brf-lookup.test.ts:395-406` (end-to-end, same assertion against the real-pipeline-derived summary).

**Scrutiny of the "plausible but out-of-band → trust it" branch (the requested adversarial check).** This is a genuine, deliberate risk tradeoff, not a new hidden defect of the same class as before. Reasoning independently verified: `applySanityChecks` (`sanity.ts:56-74`) pins confidence to exactly `0.2` for ANY out-of-band value regardless of how legibly the model actually read it — so once a value is out-of-band, the stored confidence carries zero information distinguishing "real high debt, clearly stated in the document" from "garbled OCR that happens to land outside the band." Given that ambiguity is structural (the confidence signal is destroyed by the band mechanism itself, not just noisy), the fix's choice to trust the entire 15k-60k window is a bounded, explicit, well-documented tradeoff — it converts a previous *guaranteed* false negative (every real high-debt reading was invisible) into a *bounded-probability* false positive (a misextraction that happens to land in a ~4x-the-sanity-ceiling window is now trusted). The 60k ceiling is reasoned from real Stockholm BRF debt distributions (doc comment `confounder-guard.ts:71-76`) and is deliberately not applied to `sanity.ts`'s shared band (verified unmodified), so the single-listing "Osäker" badge and the published methodology page are unaffected — the risk is scoped to the discovery/confounder-guard path only. Judged sound: this is the correct direction for SPEC §2.2's purpose (surfacing risk, not hiding it), it is the same shape of tradeoff 14-REVIEW.md itself suggested, and no test or code path was found where this branch produces the OPPOSITE of the SPEC's intent (a debt-light förening is helped, a genuinely indebted one is flagged; only a coincidental misextraction landing in-window is a possible mispricing, not a fabricated absence of risk). Not scored as a gap.

**Scrutiny of the five changed test expectations.** Read the full diff of the six commits that changed pre-existing test assertions (`b841563`, `076dfb1`, `fb356e1`, `c6bbde3`, `d885a39`, `0c9cbf9`). Every change was independently re-derived, not taken on the commit message's word:
- `confounder-guard.test.ts:336` (the exact assertion this verifier's previous report cited as proof of the gap, *"an untrusted skuldPerKvm > HIGH_BRF_DEBT_PER_SQM does NOT produce brf_debt_high"*) is inverted to a new test using `skuldPerKvm: 30_000` at the realistic band-downgraded confidence `0.2` → now asserts `brf_debt_high` IS produced. Confirmed via `git show b841563` diff: the OLD test used the identical fixture shape (`skuldPerKvm: 20_000` @ `0.2`) that encoded the defect; the new test is the direct correction, and the implausible-misextraction case (`480_000`) is RETAINED under a renamed test, so no coverage was dropped, only corrected.
- `client.test.ts`'s two CR-01 assertions (partial-failure and fully-degraded render counts) were inverted from under-counting to correct accounting — confirmed via diff, mechanical `result` → `result.listings` changes plus new `rendersUsed` assertions that match the corrected accounting model exactly (`4 + AREA_RENDER_RUNGS` for a page that exhausts both fallback rungs before failing).
- WR-01's budget fixture (`"budget for exactly 2 lookups"`) changed its divisor from the old single-call price to `MAX_BILLED_CALLS_PER_LOOKUP`-derived worst-case units — a correction, not a relaxation (a new test asserting a budget covering only one billed call authorises zero lookups was added alongside it).
- WR-05's two `avgiftsniva: 900` assertions moved from "out of range" wording to "low confidence" wording because 900 is INSIDE the 300-1200 band — genuinely the correct reason for that fixture; new out-of-band (4200) and no-band (`kassaflode`) fixtures were added to keep all three branches covered.
- WR-08's "capped at exactly 0.2" assertion moved from the persisted brief (`explainedPct`) to the guard result, because the persisted field is now correctly `null` when `canAttributeToCondition` is false — no information lost (the capped value is recoverable from `capped` + the exported `MAX_CONDITION_EXPLAINED_PCT`), and a new invariant test (`explainedPct === null` iff `canAttributeToCondition === false`) was added.

None of the five were weakened to force a pass — each replaces an assertion that encoded either the defect itself or a stale accounting model with an assertion matching the corrected, documented behavior, and in every case new coverage was added alongside the change rather than removed.

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `src/lib/discovery/confounder-guard.ts` | SPEC §2.6 discount-attribution guard + brief builder | ✓ VERIFIED | 743 lines (was 565). `brfDebtPerSqmUsable()`, `IMPLAUSIBLE_BRF_DEBT_PER_SQM`, `brfFigureOutOfBand()`, and the WR-05/07/08/10 fixes all present and correctly wired. |
| `src/lib/discovery/brf-lookup.ts` | Discovery-side BRF orchestrator, never-throws, cost-honest | ✓ VERIFIED | 239 lines. `scoreExtraction` call confirmed still supplies no `manualFields` — this is what makes the new reachability test's shape identical to production. WR-01/WR-02/WR-06 fixes present. |
| `src/lib/brf/sanity.ts` | `applySanityChecks` + `BRF_SANITY_BANDS` + `OSAKER_THRESHOLD` | ✓ VERIFIED, deliberately unmodified | Confirmed byte-for-byte unchanged in this pass (`git diff` against the touched-files list shows no edits) — matches the fix report's stated intent to keep the shared single-listing/methodology-page module untouched. |
| `src/lib/brf/extract.ts` / `src/lib/brf/cost.ts` | Honest cost accounting on retry | ✓ VERIFIED (WR-02, WR-03) | New `sumClaudeUsage()`; new `extract.test.ts` created (previously no test harness existed for this module at all). |
| `src/lib/booli/client.ts` / `src/lib/discovery/cost.ts` / `src/lib/discovery/job.ts` | Render-count-honest area cost accounting (CR-01, out of ANL-0x scope) | ✓ VERIFIED, did not break the cost gate | `fetchAreaListings` now returns `{ listings, rendersUsed }`; `estimateAreaFetchSek()` added; four areas' worst case (~2.4 SEK) confirmed to still fit inside `CAP_SEK_MAX` via `cost.test.ts`. Confirmed via full suite run: no cost-gate test regressed. Continues to be treated as pre-existing/out-of-phase-scope for ANL-0x scoring per the previous verification's finding (predates Phase 14, commits `4562e21`/`c124856`). |
| `src/components/gallery-condition-vision.tsx` | Renders holisticBrief in every state job.ts attaches one to | ✓ VERIFIED, one reachability bug fixed | WR-16: the previously-unreachable `vision === null && visionSkippedReason === null` cell now renders; new test added. |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `brf-lookup.ts` | `run-extraction.ts` (`scoreExtraction`) | function call, default `manualFields=[]` | ✓ WIRED | `brf-lookup.ts:174` — unchanged, no manual override on the discovery path; this is what makes the new reachability test production-faithful. |
| `normalizeForConfounders` / `buildBrfItem` | `brfDebtPerSqmUsable` | single shared gate | ✓ WIRED, corrected | `confounder-guard.ts:225` (rule 1+5 both read `debtUsable` computed once), `:633` (`buildBrfItem`'s display gate). All three consumers use the SAME function — math, naming, and display can no longer disagree about the same figure, closing the previous pass's display-honesty warning too. |
| `job.ts` | `gallery-condition-vision.tsx` | `holisticBrief` prop, `hasHolisticBrief && !hasClaims` render gate | ✓ WIRED, fixed | WR-16 closed the previously-unreachable cell; `!hasClaims` deliberately retained per the component's own documented independent behavior. |
| `niche-score.test.ts` | structural-separation guard | multi-line-import-aware matcher | ✓ WIRED | Unchanged from prior pass; re-confirmed green in full suite run. |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|---|---|---|---|---|
| ANL-01 | 14-01, 14-02, 14-04, 14-06, 14-10 | Every candidate leaves analysis with ≥1 actionable opportunity | ✓ SATISFIED | Non-empty guarantee holds; WR-16 fixed a genuine reachability regression risk in the render path, strengthening this requirement. |
| ANL-02 | 14-01, 14-05 | Value case folds in R_med/U_med via re-resolved areaId | ✓ SATISFIED | WR-10 improved the positioning statement's usefulness; no regression. |
| ANL-03 | 14-01, 14-03, 14-06, 14-07, 14-09, 14-10 | Value case folds in BRF summary for top candidates, respecting cost caps (soliditet deferred by override) | ✓ SATISFIED (override) | The previous pass's cross-cutting debt-display warning is resolved as part of the ANL-04 fix; WR-02's cost undercounting closed. |
| ANL-04 | 14-02, 14-04, 14-07, 14-08, 14-10 | Normalize confounders before attribution; UI never implies low kr/m² ⇒ reno | ✓ SATISFIED | Previously BLOCKED. The threshold collision is resolved with a distinct, documented, tested implausibility ceiling; `brf_debt_high` is now reachable through the real pipeline; display and math are unified on one gate. |

No orphaned requirements: all four ANL-0x IDs declared in PLAN frontmatter are present in REQUIREMENTS.md (all marked `[x]` Complete) and vice versa. No REQUIREMENTS.md, PLAN.md, or SUMMARY.md files were modified by the code-review fix pass — confirmed via `git diff --stat` against `.planning/` for the fix commit range.

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX` markers in any of the 24 source/test files touched by the fix pass (debt-marker gate: clean, independently grepped).

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| `src/lib/booli/client.ts` / `src/lib/discovery/job.ts` | various | `runSlice`/`fetchAreaListings` render-count accounting (CR-01) | ℹ️ Info — now fixed, out of ANL-0x scope | Was flagged in the previous pass as pre-Phase-14, out-of-scope for ANL-0x scoring. The fix pass corrected it anyway (not required by ANL-0x, but does not conflict with or destabilize the ANL-0x-scoped fixes — confirmed via full suite pass and the dedicated cost-cap-still-fits assertion). |

### Behavioral Spot-Checks / Test Execution (run directly by this verifier, not taken from the fix report)

| Check | Command | Result | Status |
|---|---|---|---|
| Targeted ANL-04 test files | `npx vitest run src/lib/discovery/confounder-guard.test.ts src/lib/discovery/brf-lookup.test.ts src/lib/brf/sanity.test.ts` | 3 files, 89/89 tests passed | ✓ PASS |
| Full test suite (regression check across all 20 fix commits) | `npx vitest run` | 64 files, 972/975 passed, 3 skipped, 0 failed | ✓ PASS — matches 14-REVIEW-FIX.md's claimed count exactly |
| Type check | `npx tsc --noEmit` | exit 0, no output | ✓ PASS |
| Lint | `npm run lint` | 0 errors, 0 warnings | ✓ PASS |

The one pre-existing flaky test (`job.test.ts:562`, wall-clock concurrency assertion with ~10ms headroom) did not fail during this verifier's run — consistent with it being a known intermittent flake under parallel load, not a regression, per the explicit instruction not to score it.

### Human Verification Required

See frontmatter `human_verification` — four items, all requiring a live run (no mocked test can observe real Apify/Allabrf latency, spend, or extraction quality), carried forward from the prior pass. **Corrected 2026-08-11:** these were previously recorded as environment-blocked (Supabase paused, operator IP Booli-blocked); both blockers were incorrect — Supabase is live, and all Booli traffic goes via the Apify RESIDENTIAL/SE proxy rather than the operator's IP. The items are unrun, not blocked. Item 4 is updated to reflect that the CR-02 mocked-pipeline fix has now landed and passed; it still requires a real Allabrf document with genuinely high debt to confirm real-world OCR/extraction quality matches the fixture's assumed shape — this is a live-data confirmation, not a code-correctness gap.

### Gaps Summary

None. The single BLOCKER this verifier identified in the previous pass — `HIGH_BRF_DEBT_PER_SQM` colliding numerically with `BRF_SANITY_BANDS.skuldPerKvm.max`, making the SPEC §2.2 red flag structurally unreachable and causing a dangerously indebted förening to read as a bigger bargain — is independently confirmed closed against current source, not merely accepted from the fix report's narrative. All three `missing` items from the previous gap are individually verified: the implausibility ceiling is now a distinct, documented constant; a test reaches `brf_debt_high` through the real `scoreExtraction` → `applySanityChecks` pipeline (not a bypassing fixture); and `buildBrfItem` displays a real high debt as fact with the flag.

The "plausible but out-of-band → trust it" branch this task specifically asked to be scrutinized for a new hidden hole was examined and judged a sound, explicit, bounded, and well-documented risk tradeoff rather than a defect of the same class as the one it replaced — it trades a previously *guaranteed* false negative for a *bounded-probability* false positive in a narrow (15k-60k) window, in the direction SPEC §2.2 requires (surfacing risk rather than hiding it), and does not touch the shared `sanity.ts` module used elsewhere.

The five changed pre-existing test expectations were each individually traced via `git show` diffs: all correct defect-encoding or stale-accounting assertions into assertions matching the corrected, documented behavior, with new coverage added alongside every change — none were weakened or had coverage silently dropped to force a pass.

Full regression sweep (972/975 tests, tsc clean, lint clean) run directly by this verifier confirms no regression across the 20-commit fix pass, including in the comps (ANL-02) and BRF-summary (ANL-03) paths that were also touched. The `soliditet` deferral override is carried forward unchanged, per instruction, and is not re-raised as a gap.

Status is `human_needed`, not `passed`, solely because of pre-existing live-operator verification items that were already flagged in the prior two passes and are unrelated to this round's code changes. (Corrected 2026-08-11: these are unrun, not environment-blocked — see the frontmatter override.)

---

_Verified: 2026-08-10T14:10:00Z_
_Verifier: Claude (gsd-verifier)_
