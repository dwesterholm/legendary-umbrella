---
phase: 14-holistic-analysis-brain
verified: 2026-08-08T18:00:00Z
status: gaps_found
score: 3/4 must-haves verified
overrides:
  - must_have: "ANL-03: BRF summary includes soliditet"
    reason: "No field exists on brfExtractionSchema; rarely cleanly extractable from iXBRL; debt/m² carries most of the balance-sheet signal (14-CONTEXT.md D-14-02, and the matching Deferred Ideas entry). Accepted as a scope deferral, not a defect — the remaining ANL-03 fields (avgift, debt/m², stambyte funding state, tomträtt) ship and are fixed by plans 14-07 and 14-10."
    accepted_by: "Daniel Westerholm"
    accepted_at: "2026-08-08T14:51:40Z"
overrides_applied: 1
re_verification:
  previous_status: gaps_found
  previous_score: 2/4
  gaps_closed:
    - "ANL-03: avgiftsniva unit mislabeling (CR-01) — now states kr/kvm och år, derives kr/mån from livingArea"
    - "ANL-03: sanity-band confidence downgrade discarded (original CR-02) — BrfSummary.fieldConfidence now carries the downgrade through scoreExtraction, and the single brfFieldTrusted gate is consumed by both normalizeForConfounders and buildBrfItem"
    - "ANL-03: raw stambytePlanerat enum token concatenated into prose (CR-03) — STAMBYTE_PROSE map now used, ej_nämnt correctly suppressed"
    - "ANL-03: BRF extraction failure reported as costSek: 0 after a billed call (CR-04) — throw path now charges BILLED_CALLS_BY_EXTRACTION_CODE × estimateBrfLookupSek(), partially (see gaps_remaining)"
    - "ANL-03: soliditet deferral now recorded as an explicit human-accepted override (plan 14-09) rather than a silent gap"
  gaps_remaining:
    - "ANL-04: the CR-02 trust gate (14-REVIEW.md's re-review Critical #2) makes the SPEC §2.2 >15k-debt red flag structurally unreachable through the real extraction pipeline, AND silently excludes genuinely high (but real) BRF debt from the debt-inclusive kr/m² basis — independently confirmed against source, not just the review claim."
  regressions: []
gaps:
  - truth: "ANL-04: kr/m² is normalized against confounders — including BRF debt — before any condition/reno attribution"
    status: failed
    reason: >
      Independently confirmed against source (not just trusting 14-REVIEW.md's
      CR-02 finding): `HIGH_BRF_DEBT_PER_SQM = 15_000`
      (confounder-guard.ts:45) is numerically IDENTICAL to
      `BRF_SANITY_BANDS.skuldPerKvm.max = 15000` (sanity.ts:24-25).
      `applySanityChecks` (sanity.ts:56-74) forces confidence to
      `DOWNGRADED_CONFIDENCE = 0.2` for ANY skuldPerKvm outside [2000, 15000]
      — strictly below `OSAKER_THRESHOLD = 0.5`. `brf-lookup.ts:155` calls
      `scoreExtraction(result.parsed)` with the default `manualFields = []`
      (run-extraction.ts:166-201) — the discovery path never supplies a
      manual override. Consequence, traced end to end: for EVERY real
      extraction-sourced skuldPerKvm > 15 000, `brfFieldTrusted` is
      structurally `false` (confidence forced to 0.2 < 0.5), so
      `debtUsable = false` (confounder-guard.ts:146) — the debt is dropped
      from `effectivePricePerSqm` (rule 1, treated exactly like no BRF at
      all) rather than "normalized against"; `brf_debt_high` cannot be
      pushed to `residualDrivers` (rule 5's `debtUsable &&
      skuldPerKvm > HIGH_BRF_DEBT_PER_SQM` is mutually exclusive by
      construction, since `debtUsable` can only be true when the value is
      IN-band, i.e. <= 15000); and the display flag `" (högre än vanligt)"`
      (:476) is unreachable for the same reason. A genuinely
      dangerously-indebted förening is therefore both hidden from the debt-
      inclusive price basis (making it read as a BIGGER discount than it
      is) and never named as a known confounder — the opposite of "before
      any condition/reno attribution, normalize against BRF debt."
      Independently re-derived the test-suite proof: `makeBrf()`'s default
      `fieldConfidence = { skuldPerKvm: 0.9, ... }`
      (confounder-guard.test.ts:56) is a fixed synthetic value that bypasses
      `applySanityChecks` entirely — the only test that reaches
      `brf_debt_high` (`confounder-guard.test.ts:346-349`, "a trusted
      skuldPerKvm > HIGH_BRF_DEBT_PER_SQM still produces brf_debt_high")
      constructs a shape (`skuldPerKvm: 20_000` at confidence `0.9`) that
      the real `scoreExtraction` → `applySanityChecks` chain can never
      produce, and `confounder-guard.test.ts:336-343` explicitly documents
      the real-pipeline-reachable case as "does NOT produce brf_debt_high."
      This is a confirmed, live, unresolved correctness defect, not a
      hypothetical — it was introduced by the SAME gap-closure work
      (plan 14-10 / commit `0e41637`-adjacent CR-02 fix) that closed the
      prior gap and replaced it with a different, equally severe one.
    artifacts:
      - path: "src/lib/discovery/confounder-guard.ts"
        issue: >
          Line 45 (`HIGH_BRF_DEBT_PER_SQM = 15_000`) collides with
          `sanity.ts:24`'s `skuldPerKvm.max = 15000`; line 146
          (`debtUsable = brfFieldTrusted(...)`) gates rule 1 (:160-166),
          rule 5 (:213-215) and the display flag (:476) all off the same
          collision, so all three fail together for every real high-debt
          reading.
      - path: "src/lib/brf/sanity.ts"
        issue: >
          `BRF_SANITY_BANDS.skuldPerKvm.max = 15000` conflates "implausible
          reading" (denominator/unit misextraction) with "alarming but
          plausible reading" (a real förening carrying >15k kr/m² of debt) —
          the two need materially different ceilings, since the former
          should be untrusted and the latter is exactly the SPEC §2.2 signal
          that must be surfaced.
    missing:
      - "Separate the implausibility ceiling (denominator/unit-confusion, e.g. ~60k+ per 14-REVIEW.md's suggested IMPLAUSIBLE_BRF_DEBT_PER_SQM) from the SPEC §2.2 alarm threshold (15k) so a genuinely high-but-real debt figure is trusted for arithmetic and named as brf_debt_high, while only a truly implausible reading is suppressed."
      - "Add a test asserting brf_debt_high is reachable from a value the real scoreExtraction → applySanityChecks pipeline can actually produce (not a fixture that bypasses applySanityChecks)."
      - "Re-verify buildBrfItem's debt sentence (confounder-guard.ts:474-481) displays a real 20-40k kr/m² debt figure as fact with the (högre än vanligt) flag, not as a suppressed 'outside a reasonable range' figure."
deferred: []
human_verification:
  - test: "Live end-to-end discovery run: real comps + BRF fetched and folded into a real multi-area job, within the CAP_VISION_SEK_MAX cost cap and inside the tick window."
    expected: "Comps fetched once per distinct area, BRF attempted only for top-N, cost_sek_total stays within cap, no tick timeout, every candidate shows ≥1 actionable item."
    why_human: "Supabase project is paused (resolveArea reads area_cache) and the operator IP is Booli/Cloudflare-blocked (403 on detail pages) — no mocked test can observe real Apify/Allabrf latency or real spend. Recorded as a deferred-live operator gate per 14-VALIDATION.md, consistent with Phases 11-13 precedent."
  - test: "Confirm genitive kommun corroboration reaches resolveOrgNr confidence 'high' against the live Allabrf registry for unambiguous single-name matches."
    expected: "'high' confidence reached for real BRF names, unblocking the BRF top-N lookup in production (today gated to 'high' only, per D-14-09's explicit rejection of relaxing to 'low')."
    why_human: "Only fixture-level genitive forms have been tested; real registry spelling variance can only be confirmed live."
  - test: "Capture real tenureForm values across a wide live result set to determine whether a tomträtt-shaped value ever appears at all."
    expected: "Either at least one tomträtt-bearing tenureForm is observed (confirming the confounder is live), or confirmation that it is currently inert in production (should be recorded, not silently assumed working)."
    why_human: "Every committed tenureForm fixture is 'Bostadsrätt' — no tomträtt sample exists in the test suite to verify against (14-RESEARCH.md OQ-2)."
  - test: "Once the CR-02 (re-review) fix lands, re-run against a real Allabrf-extracted BRF document with a genuinely high debt/m² to confirm the rendered figure is displayed as fact with the (högre än vanligt) flag rather than suppressed as an out-of-range reading."
    expected: "A real 20-40k kr/m² debt is shown, flagged, and included in effectivePricePerSqm — not hedged away as an untrusted figure."
    why_human: "Requires a real Allabrf document with genuinely high debt; no such fixture exists, and the synthetic test fixture that reaches brf_debt_high bypasses the real sanity-check pipeline (confirmed above)."
---

# Phase 14: Holistic Analysis Brain — Verification Report

**Phase Goal:** Every surfaced candidate is analyzed against holistic context — renovated-vs-unrenovated area comps and its BRF's finances — always leaves analysis with ≥1 actionable opportunity, and never mistakes a low kr/m² for a renovation signal.
**Verified:** 2026-08-08T18:00:00Z
**Status:** gaps_found
**Re-verification:** Yes — after gap-closure plans 14-07..14-10

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth (ROADMAP SC) | Status | Evidence |
|---|---|---|---|
| 1 | Ringvägen 122 scenario: a dated flat with zero surviving image claims now surfaces ≥1 actionable opportunity via a holistic-data-only brief instead of `claims: []` | ✓ VERIFIED | Unchanged from prior verification. `buildHolisticBrief` (`confounder-guard.ts:513-564`) has an explicit post-composition non-empty guarantee (`"insufficient-data"` fallback). Wired via `job.ts`, rendered in `gallery-condition-vision.tsx`. Confirmed still passing: `confounder-guard.test.ts` (46 tests) + `gallery-condition-vision.test.tsx` all green in this pass. |
| 2 | Value case folds in R_med/U_med (`computeAreaComps`) via the re-resolved areaId; analysis references how kr/m² sits against renovated vs unrenovated comps | ✓ VERIFIED (unchanged warnings) | `resolveCompsForCandidates` resolves + attaches `AreaCompsSummary`. `buildCompsPositioningItem` states both medians and the 20% cap sentence on deep discount. Not in scope of this gap-closure round; unchanged from prior pass (WR-10/WR-13 area-cap and positioning-thinness warnings still open, not blocking). |
| 3 | Top candidates' value case folds in the BRF summary — avgift, debt/m², stambyte funding state, tomträtt, soliditet | ✓ VERIFIED (override applied on soliditet; one cross-cutting warning) | Directly re-verified against current source: **avgift** now correctly states "kr/kvm och år" and derives a kr/mån figure from `livingArea` (`confounder-guard.ts:456-469`; `confounder-guard.test.ts:407-466` pins the unit invariant). **stambyte** is now mapped through `STAMBYTE_PROSE`, `ej_nämnt` correctly suppressed (`:332-336`, `:495-497`). **The sanity-band confidence downgrade is now carried through** — `BrfSummary.fieldConfidence` (`holistic-schema.ts:147-192`) + the single `brfFieldTrusted` gate (`:212-219`) is consumed by both `normalizeForConfounders` and `buildBrfItem`, closing the original "discard" defect. **debt/m²** is displayed for in-band, trusted readings — but see the cross-cutting warning below: a genuinely high (>15k, real) debt figure is now ALSO suppressed as "outside a reasonable range" (same root cause as the ANL-04 gap below), which is a display-honesty regression for exactly the candidates where the debt figure matters most, though not a fabricated/wrong figure as before. **tomträtt** unchanged, correctly implemented. **soliditet**: accepted deferral per human override (unchanged from prior verification, `accepted_at: 2026-08-08T14:51:40Z`) — carried forward, not re-raised. Cost-cap accounting (CR-04) is improved but not fully closed: the throw path now charges realistically (`brf-lookup.ts:69-73,197-201`), but a success-after-retry still under-reports cost by one billed call (`extract.ts:297-321`, WR-02 in 14-REVIEW.md) — bounded by `BRF_TOP_N=4`, treated as a WARNING not a blocker for this truth. |
| 4 | Low kr/m² is normalized against confounders (incl. BRF debt) before any condition/reno attribution; UI never renders text implying "low kr/m² ⇒ renovation object" | ✗ FAILED | The UI-facing text guard remains solid (`BANNED_RENO_ATTRIBUTION_PATTERNS` + `applyBannedAttributionGuard`, unchanged, still tested green). **But** the debt-normalization half of this criterion has a confirmed, currently-live defect, independently re-derived from source (not just 14-REVIEW.md's claim): `HIGH_BRF_DEBT_PER_SQM = 15_000` (`confounder-guard.ts:45`) is numerically identical to `BRF_SANITY_BANDS.skuldPerKvm.max` (`sanity.ts:24-25`), and the discovery path's `scoreExtraction` call (`brf-lookup.ts:155`) never supplies `manualFields`, so every out-of-band `skuldPerKvm` — including a genuinely real 20-40k kr/m² debt, not just a denominator-confused misextraction — gets its confidence forced to `0.2` (`sanity.ts:56-74`), below `OSAKER_THRESHOLD = 0.5`. `brfFieldTrusted` is therefore structurally `false` for every real high-debt reading, so (a) the debt is EXCLUDED from `effectivePricePerSqm` rather than normalized in — making a dangerously indebted förening read as a BIGGER discount, the opposite of the safeguard's purpose; (b) `brf_debt_high` can never be pushed to `residualDrivers` (`debtUsable && skuldPerKvm > HIGH_BRF_DEBT_PER_SQM` is mutually exclusive by construction); and (c) the SPEC §2.2 ">15k red flag" is structurally unreachable through the real extraction pipeline. Verified this is not reachable via any test that mirrors production: the one test that reaches `brf_debt_high` (`confounder-guard.test.ts:346-349`) relies on `makeBrf()`'s hardcoded `fieldConfidence: 0.9` default, which bypasses `applySanityChecks` — a shape `scoreExtraction` can never produce for an out-of-band value. |

**Score:** 3/4 truths verified (1 with override applied on a sub-item, 1 with a real cross-cutting warning); 1 truth (4) has a confirmed, unresolved, source-level correctness defect. All four requirement IDs (ANL-01..04) are present in PLAN frontmatter across all ten plans (14-01 through 14-10) with no orphans.

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `src/lib/discovery/holistic-schema.ts` | HolisticBrief/AreaCompsSummary/BrfSummary types + Zod read guards + `fieldConfidence`/`brfFieldTrusted` (new this round) | ✓ VERIFIED | 287 lines. `BrfSummary.fieldConfidence` + `brfFieldTrusted` (CR-02 fix) present and substantive; `.default(null)` on the nested schema key confirmed load-bearing for legacy-row backward compatibility. |
| `src/lib/discovery/confounder-guard.ts` | SPEC §2.6 discount-attribution guard + brief builder, with CR-01/02/03 fixes | ⚠️ VERIFIED but with one confirmed live defect (CR-02 re-review) | 565 lines. avgift unit (CR-01) and stambyte enum (CR-03) fixes confirmed correct. The CR-02 confidence-gate fix is correctly WIRED but miscalibrated — see gap above. |
| `src/lib/discovery/brf-lookup.ts` | Discovery-side BRF orchestrator, never-throws, cost-honest on failure | ⚠️ VERIFIED but with one open minor gap (WR-02) | 204 lines. `BILLED_CALLS_BY_EXTRACTION_CODE` throw-path charge confirmed correct and matches `extract.ts`'s coded throw points exactly. Success-after-retry cost undercounting (WR-02) confirmed still open by direct read of `extract.ts:297-321` — bounded, minor. |
| `src/lib/brf/sanity.ts` | `applySanityChecks` + `BRF_SANITY_BANDS` + `OSAKER_THRESHOLD` | ✓ VERIFIED (root cause of the ANL-04 gap, not itself broken) | Unchanged, correctly implements "downgrade, never drop" per its own contract — the defect is the *consumer's* threshold collision (`confounder-guard.ts:45`), not this module. |
| `src/lib/brf/run-extraction.ts` | `scoreExtraction` composing sanity + manual-confidence override | ✓ VERIFIED | `scoreExtraction(extraction, manualFields = [])` confirmed — discovery path (`brf-lookup.ts:155`) never supplies `manualFields`, confirming the gate is total for the discovery pipeline. |
| `src/components/gallery-condition-vision.tsx` / `discovery-results.tsx` | Threads `holisticBrief` prop, renders data-only brief | ✓ VERIFIED | Unchanged, still wired (`holisticBrief={candidate.holisticBrief}` confirmed present). |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `brf-lookup.ts` | `run-extraction.ts` (`scoreExtraction`) | function call, default `manualFields=[]` | ✓ WIRED (confirms the gap) | `brf-lookup.ts:155` — no manual override ever supplied on the discovery path, making the sanity-band collision total for every automated extraction. |
| `confounder-guard.ts` | `holistic-schema.ts` (`brfFieldTrusted`) | import + call in 3 sites (rule 1, rule 5, display) | ✓ WIRED | Lines 26, 146, 213, 455/475/483 — the gate is consistently applied everywhere it needs to be; the defect is in the threshold value shared with `sanity.ts`, not in the wiring. |
| `discovery-results.tsx` | `gallery-condition-vision.tsx` | `holisticBrief` prop | ✓ WIRED | Unchanged from prior pass. |
| `niche-score.test.ts` | structural-separation guard | multi-line-import-aware matcher (WR-01 fix, plan 14-08) | ✓ WIRED, FIXED | `niche-score.test.ts:337-354` now matches whole `import … from "…"` statements — closes the prior line-anchored blind spot. |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|---|---|---|---|---|
| ANL-01 | 14-01, 14-02, 14-04, 14-06, 14-10 | Every candidate leaves analysis with ≥1 actionable opportunity | ✓ SATISFIED | Unchanged, non-empty guarantee holds; not touched by any open gap. |
| ANL-02 | 14-01, 14-05 | Value case folds in R_med/U_med via re-resolved areaId | ✓ SATISFIED (warnings noted, unchanged) | Not in scope of this gap-closure round. |
| ANL-03 | 14-01, 14-03, 14-06, 14-07, 14-09, 14-10 | Value case folds in BRF summary for top candidates, respecting cost caps (soliditet deferred by override) | ✓ SATISFIED (override + 1 warning) | avgift/stambyte/confidence-discard defects fixed; soliditet deferral formally accepted; WR-02 cost leak and the debt-suppression-for-real-high-debt cross-cutting issue are warnings, not blockers, for this specific requirement's literal text. |
| ANL-04 | 14-02, 14-04, 14-07, 14-08, 14-10 | Normalize confounders before attribution; UI never implies low kr/m² ⇒ reno | ✗ BLOCKED | UI text guard solid and unchanged. Debt-inclusive normalization is fed a self-defeating trust gate (CR-02 re-review) — confirmed independently against source and the test suite's own fixture design — that excludes real high BRF debt from the math and makes the SPEC §2.2 red flag unreachable. |

No orphaned requirements: all four ANL-0x IDs declared in PLAN frontmatter (across all 10 plans) are present in REQUIREMENTS.md and vice versa.

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX` markers in any file touched by plans 14-07 through 14-10 (debt-marker gate: clean).

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| `src/lib/discovery/confounder-guard.ts` / `src/lib/brf/sanity.ts` | `confounder-guard.ts:45` / `sanity.ts:24-25` | Threshold collision: alarm threshold == sanity-band ceiling | 🛑 Blocker | Excludes real high BRF debt from the debt-inclusive price basis and makes the SPEC §2.2 red flag unreachable — inverts the intended safeguard for exactly the candidates it exists to protect against. |
| `src/lib/brf/extract.ts` | 297-321 | Success-after-retry returns only the second message's usage | ⚠️ Warning (carried forward, partially fixed elsewhere) | Under-reports BRF-lookup spend by one billed call on the retry-then-succeed path; bounded by `BRF_TOP_N=4`, not a runaway. |
| `src/lib/booli/client.ts` / `src/lib/discovery/job.ts` | `client.ts:790-825` / `job.ts:89-104,192,214-219,258-259` | `runSlice` counts one render per area while `fetchAreaListings` performs up to `MAX_AREA_PAGES=5` paginated renders | ℹ️ Info (out of phase-14 scope) | Confirmed real via `git log`: this pagination behavior predates phase 14 (commits `4562e21`/`c124856`, both authored before `184953b`/14-01). It concerns the general area-search `CAP_SEK_MAX` render cap, not the BRF/comps holistic-analysis feature this phase's ANL-0x requirements cover. Flagged for developer awareness, not scored against this phase's must-haves. |

### Human Verification Required

See frontmatter `human_verification` — four items, three carried forward unchanged (live comps/BRF/vision run, genitive-kommun corroboration, tomträtt-shaped tenureForm sighting — all environment-blocked per 14-VALIDATION.md's deferred-live-gate precedent), plus one updated item asking for a live re-check of the debt-display behavior once the ANL-04 gap below is fixed.

### Gaps Summary

The prior verification's four concrete correctness bugs under ANL-03 (avgift unit mislabeling, discarded confidence downgrade, raw enum leak, zero-cost-on-billed-failure) are now genuinely fixed by plans 14-07/14-08/14-10 — independently confirmed by reading the current source, not by trusting SUMMARY.md or even 14-REVIEW.md's resolution table at face value. The `soliditet` deferral is now a properly recorded human-accepted override rather than a silent gap (plan 14-09), and REQUIREMENTS.md's ANL-03 wording has been correspondingly updated. That override is carried forward unchanged in this report's frontmatter, per instruction.

However, the fix that closed the prior ANL-04 gap (an untrusted debt figure entering the discount math unchecked) introduced a new, equally severe defect in the same code path, and this was independently re-derived from source during this verification, not merely accepted from 14-REVIEW.md's CR-02 finding:

`HIGH_BRF_DEBT_PER_SQM` (the SPEC §2.2 alarm threshold, "flag debt above 15k/m²") is numerically identical to `BRF_SANITY_BANDS.skuldPerKvm.max` (the sanity band's implausibility ceiling). Because the discovery pipeline's `scoreExtraction` call never supplies a manual-confidence override, every real, non-misextracted skuldPerKvm above 15 000 gets its confidence forced below the trust threshold by the SAME mechanism meant to catch garbage data (denominator confusion, e.g. total debt read as debt/m²). The practical effect: a genuinely, dangerously indebted förening (say, 30 000 kr/m²) has its debt entirely excluded from the debt-inclusive price basis — making the candidate look like a BIGGER bargain than it is — and the `brf_debt_high` confounder, the SPEC §2.2 named red flag this phase exists to surface, can never fire through the real extraction pipeline. Traced this to the test suite too: the only test asserting `brf_debt_high` fires uses a hand-constructed fixture with a hardcoded high confidence that bypasses `applySanityChecks` — a shape the real pipeline structurally cannot produce — and a sibling test in the same file explicitly documents the real-pipeline-reachable behavior as NOT producing `brf_debt_high`.

This directly contradicts ROADMAP SC4's literal wording ("the analysis normalizes against confounders... including... BRF debt... before any condition/reno attribution") for exactly the highest-debt, highest-risk candidates — the debt confounder is not normalized against, it is silently dropped. It is a BLOCKER, not a warning: it is a decision-correctness defect with a concrete, quantified, adverse-direction impact (makes risky candidates look safer), exactly the class of bug this phase exists to prevent.

**Recommendation:** a further closure plan should separate the "implausible reading" ceiling (denominator/unit confusion — should stay well above 15k, e.g. 60k+) from the SPEC §2.2 alarm threshold (15k — should remain trusted for arithmetic and for naming `brf_debt_high`), per 14-REVIEW.md's suggested fix. This is a small, well-scoped change (new constant + one boolean split) but must not be waved through as an override — it is a confirmed correctness bug with a clear, safe fix, not an intentional scope trade like `soliditet`.

---

_Verified: 2026-08-08T18:00:00Z_
_Verifier: Claude (gsd-verifier)_
