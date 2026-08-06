---
phase: 14-holistic-analysis-brain
verified: 2026-08-06T19:00:00Z
status: gaps_found
score: 2/4 must-haves verified
overrides_applied: 0
gaps:
  - truth: "ANL-03: top candidates' value case folds in an accurate BRF summary (avgift, debt/m², stambyte funding state, tomträtt, soliditet)"
    status: failed
    reason: >
      Three of the four implemented BRF fields are rendered with confirmed
      correctness defects, and the fifth (soliditet) was never implemented.
      Verified directly against source, not just the code-review report.
    artifacts:
      - path: "src/lib/discovery/confounder-guard.ts"
        issue: >
          Line 381: `avgiftsniva` (SEK/m²/år per src/lib/brf/prompt.ts:29,
          src/lib/brf/sanity.ts:27 band 300-1200, src/lib/brf/score.ts:15) is
          printed to the user as "kr/mån" with no conversion — a real
          650 SEK/m²/år value renders as "Avgiften ligger kring 650 kr/mån"
          when the true monthly fee for a 70m² flat is ~3792 kr/mån (~6x
          understatement). Confirmed by reading prompt.ts/sanity.ts/score.ts
          directly. Line 387: `stambytePlanerat` (enum
          "planerat"|"nyligen_genomfort"|"ej_nämnt") is concatenated
          verbatim into Swedish prose — "Stambyte-läge: ej_nämnt." renders on
          every BRF-bearing candidate where stambyte was simply never
          mentioned in the document (per src/lib/brf/prompt.ts:40, "ej_nämnt"
          means absence-of-mention, not a real value) — an absence of
          information rendered as an information item, directly undermining
          ANL-01's "actionable item" bar for those candidates.
      - path: "src/lib/discovery/brf-lookup.ts"
        issue: >
          Line 137: `scoreExtraction(result.parsed)` returns `{ normalized,
          perFieldConfidence }` but only `normalized` is kept — the
          sanity-band confidence downgrade (src/lib/brf/sanity.ts, forces
          confidence to 0.2 when skuldPerKvm/avgiftsniva falls outside its
          plausible band) is discarded. An implausible skuldPerKvm (classic
          misextraction: total debt read as debt/m²) is displayed to the
          user as a normal reading AND flows uncapped into
          confounder-guard.ts's rule 1 (`effectivePricePerSqm = pricePerSqm +
          brf.skuldPerKvm`), which can flip `deepDiscount` from true to false
          and silently disable the §2.6 20%-attribution-cap guard exactly
          when it matters most. This is not a display-only bug — it corrupts
          the ANL-04 normalization this same phase is supposed to guarantee.
      - path: "src/lib/discovery/holistic-schema.ts"
        issue: >
          Line 124: soliditet is explicitly not implemented ("DEFERRED — no
          field exists on `brfExtractionSchema` today"). This was a
          documented, reasoned planning-time decision (14-CONTEXT.md D-14-02,
          14-DISCUSSION-LOG.md) — not a silent shortcut — but REQUIREMENTS.md
          ANL-03's literal text still lists soliditet as in-scope and the
          requirement is marked [x] Complete. Flagging for an explicit
          decision rather than failing on documentation grounds alone.
    missing:
      - "Fix avgiftsniva unit: state kr/kvm/år (or convert to kr/mån via candidate.livingArea) instead of mislabeling it kr/mån."
      - "Carry BrfSummary's per-field confidence (or the sanity-check downgrade) through from scoreExtraction and gate both display and the debt-inclusive discount math on OSAKER_THRESHOLD."
      - "Map stambytePlanerat's enum to Swedish prose and suppress the ej_nämnt case rather than concatenating the raw token."
      - "Either implement soliditet or get an explicit human sign-off that ANL-03 is accepted without it (update REQUIREMENTS.md wording to match)."
  - truth: "ANL-04: kr/m² is normalized against confounders — including BRF debt — before any condition/reno attribution"
    status: failed
    reason: >
      The confounder-guard.ts normalization pipeline is correctly designed
      and its UI-facing banned-attribution-text guard works (verified: the
      composed brief text never contains a banned pattern, confirmed by
      reading BANNED_RENO_ATTRIBUTION_PATTERNS + applyBannedAttributionGuard
      and the passing test suite). But the debt-inclusive normalization step
      itself is fed an unvetted BRF figure (see CR-02 above) — the exact
      "BRF debt" confounder this criterion names by name — so the
      normalization can silently misfire on real Allabrf extraction noise,
      not merely on a hypothetical.
    artifacts:
      - path: "src/lib/discovery/confounder-guard.ts"
        issue: "Lines 145-155 (rule 1, effectivePricePerSqm) trust brf.skuldPerKvm with only a Number.isFinite check, no confidence/sanity gate."
    missing:
      - "Same fix as ANL-03's CR-02 item — gate the debt figure on confidence before it enters the discount math."
deferred: []
human_verification:
  - test: "Live end-to-end discovery run: real comps + BRF fetched and folded into a real multi-area job, within the CAP_VISION_SEK_MAX cost cap and inside the tick window."
    expected: "Comps fetched once per distinct area, BRF attempted only for top-N, cost_sek_total stays within cap despite CR-04's accounting gap, no tick timeout, every candidate shows ≥1 actionable item."
    why_human: "Supabase project is paused (resolveArea reads area_cache) and the operator IP is Booli/Cloudflare-blocked (403 on detail pages) — no mocked test can observe real Apify/Allabrf latency or real spend. Recorded as a deferred-live operator gate per 14-VALIDATION.md, consistent with Phases 11-13 precedent."
  - test: "Confirm genitive kommun corroboration reaches resolveOrgNr confidence 'high' against the live Allabrf registry for unambiguous single-name matches."
    expected: "'high' confidence reached for real BRF names, unblocking the BRF top-N lookup in production (today gated to 'high' only, per D-14-09's explicit rejection of relaxing to 'low')."
    why_human: "Only fixture-level genitive forms have been tested; real registry spelling variance can only be confirmed live."
  - test: "Capture real tenureForm values across a wide live result set to determine whether a tomträtt-shaped value ever appears at all."
    expected: "Either at least one tomträtt-bearing tenureForm is observed (confirming the confounder is live), or confirmation that it is currently inert in production (should be recorded, not silently assumed working)."
    why_human: "Every committed tenureForm fixture is 'Bostadsrätt' — no tomträtt sample exists in the test suite to verify against (14-RESEARCH.md OQ-2)."
  - test: "Re-run the CR-01/CR-02/CR-03 fixes (once applied) against a real Allabrf-extracted BRF document to confirm the rendered avgift/debt/stambyte text is both unit-correct and confidence-gated on live extraction noise, not just synthetic test fixtures."
    expected: "Rendered avgift matches the true monthly fee order of magnitude; an out-of-band skuldPerKvm is suppressed or hedged rather than displayed as fact."
    why_human: "Requires a real Allabrf document — the confounder-guard.test.ts fixture at line 336 independently confirms the reviewer's finding by itself using an implausible avgiftsniva value (4200), showing the test author made the same unit mistake as the implementation."
---

# Phase 14: Holistic Analysis Brain — Verification Report

**Phase Goal:** Every surfaced candidate is analyzed against holistic context — renovated-vs-unrenovated area comps and its BRF's finances — always leaves analysis with ≥1 actionable opportunity, and never mistakes a low kr/m² for a renovation signal.
**Verified:** 2026-08-06T19:00:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth (ROADMAP SC) | Status | Evidence |
|---|---|---|---|
| 1 | Ringvägen 122 scenario: a dated flat with zero surviving image claims now surfaces ≥1 actionable opportunity via a holistic-data-only brief instead of `claims: []` | ✓ VERIFIED | `buildHolisticBrief` (`src/lib/discovery/confounder-guard.ts:402-453`) has an explicit post-composition non-empty guarantee (falls back to an `"insufficient-data"` item). Wired in `job.ts:1050-1075` via `hasNoImageClaims`. Rendered in `gallery-condition-vision.tsx:230-244` for both `visionSkippedReason !== null` and `visionRanButEmpty` states — exactly the reachable Ringvägen-122 shape. The one unreachable render cell (`vision === null && visionSkippedReason === null`, WR-11) cannot occur under today's `runVisionPass` (every `vision: null` push sets a skip reason) — noted as a coupling risk for a future edit, not a present defect. 135 tests across `confounder-guard.test.ts` / `gallery-condition-vision.test.tsx` pass. |
| 2 | Value case folds in R_med/U_med (`computeAreaComps`) via the re-resolved areaId; analysis references how kr/m² sits against renovated vs unrenovated comps | ✓ VERIFIED (with warning) | `resolveCompsForCandidates` (`job.ts:666-837`) resolves each candidate's own `areaLabel`, fetches once per distinct area, attaches `AreaCompsSummary` (both medians) via `holistic-schema.ts:83-95`. `buildCompsPositioningItem` (`confounder-guard.ts:326-361`) states both medians and, on deep discount, the 20% cap sentence. **Warning:** the item never states the candidate's *own* kr/m² or the actual discount percentage in the non-deep-discount case (`pricePerSqm` input is accepted but never read — WR-06) — comps are folded in and displayed, but the "how it sits" comparison is left largely for the reader to compute from the two medians rather than stated directly. Also: `MAX_AREAS_PER_SEARCH` is reused as a distinct-`areaLabel` cap (WR-04) that can silently starve comps for candidates beyond the first 4 labels in a large multi-neighbourhood job — invisible today (no counter), a scale-edge-case rather than a universal failure. |
| 3 | Top candidates' value case folds in the BRF summary — avgift, debt/m², stambyte funding state, tomträtt, soliditet | ✗ FAILED | Confirmed directly against source (not just trusting 14-REVIEW.md): **avgift** is mislabeled kr/mån when the underlying field is SEK/m²/år (~6x understatement) — `confounder-guard.ts:381` vs `src/lib/brf/prompt.ts:29`, `src/lib/brf/sanity.ts:27`, `src/lib/brf/score.ts:15`. **debt/m²** is shown and used in discount math with no confidence gate — `brf-lookup.ts:137` discards `scoreExtraction`'s sanity-downgrade signal entirely, so an implausible over-read is both displayed as fact and silently corrupts the ANL-04 discount classification. **stambyte** is rendered as a raw enum token (`confounder-guard.ts:387`), including `"ej_nämnt"` (absence of a mention) presented as an information item. **tomträtt** is correctly implemented (`tomtrattFromTenureForm`, boolean-only render). **soliditet** was never implemented — a documented, reasoned scope deferral (14-CONTEXT.md D-14-02) but REQUIREMENTS.md's literal ANL-03 wording still lists it and the requirement row is marked Complete. |
| 4 | Low kr/m² is normalized against confounders (incl. BRF debt) before any condition/reno attribution; UI never renders text implying "low kr/m² ⇒ renovation object" | ⚠️ PARTIAL (FAILED on normalization integrity; VERIFIED on the UI-facing text guard) | The UI-facing half is solid: `BANNED_RENO_ATTRIBUTION_PATTERNS` + `applyBannedAttributionGuard` (`confounder-guard.ts:268-324`) scrub every composed item, `HolisticDataBrief` (`gallery-condition-vision.tsx:60-88`) renders only the pre-cleared `item.text` strings verbatim — confirmed by reading the component and its passing tests; no path renders a raw number or raw enum through this guard. **But** the normalization step this criterion also requires — "before any condition/reno attribution," explicitly including BRF debt — is compromised by the same CR-02 defect as truth 3: `effectivePricePerSqm = pricePerSqm + brf.skuldPerKvm` (rule 1, `confounder-guard.ts:145-155`) trusts `skuldPerKvm` with only a `Number.isFinite` check, no sanity/confidence gate, so a garbage debt figure can flip `deepDiscount` and disable the very over-attribution guard this criterion exists to enforce. Separately (not user-visible today, WR-10): `conditionAttribution.explainedPct` is persisted as a positive number even when `canAttributeToCondition === false` says attribution is impossible — a downstream Phase 15/16 consumer reading the JSONB has no reason to also check the flag. |

**Score:** 2/4 truths fully verified; 2 truths (3 and 4) have confirmed, source-level correctness defects that undermine the criterion as literally stated. All four requirement IDs (ANL-01..04) are present in PLAN frontmatter across the six plans with no orphans (Step 6 check below).

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `src/lib/discovery/holistic-schema.ts` | HolisticBrief/AreaCompsSummary/BrfSummary types + Zod read guards + marker + tomträtt derivation | ✓ VERIFIED | Exists, 219 lines, all listed exports present and substantive. |
| `src/lib/discovery/confounder-guard.ts` | SPEC §2.6 discount-attribution guard + brief builder | ⚠️ VERIFIED but with confirmed defects (CR-01/02/03 above) | 454 lines, all exports present; logic structure matches SPEC §2.6 order, but three of the composed BRF sentences carry data-correctness bugs. |
| `src/lib/discovery/brf-lookup.ts` | Discovery-side BRF orchestrator, never-throws | ⚠️ VERIFIED but with confirmed defect (CR-02, CR-04) | 159 lines. Never-throw discipline holds (every branch returns a named outcome). Confidence-downgrade discarded (CR-02); failed-extraction cost misreported as 0 after billed calls (CR-04), undermining the "respecting cost caps" half of ANL-03. |
| `src/lib/discovery/job.ts` (resolveCompsForCandidates, lookupBrfForTopCandidates, brief-attachment step) | Wiring: comps + BRF resolution feeding into normalizeForConfounders → buildHolisticBrief → per-candidate attachment | ✓ VERIFIED (wiring intact); ⚠️ warnings on budget-gate ordering (WR-03) and area-cap semantics (WR-04) | All three functions exist, exported, called in sequence exactly as the plans describe; `initialSpentSek` correctly threads the shared pool into `runVisionPass`. |
| `src/components/gallery-condition-vision.tsx` (HolisticDataBrief) | Data-only sub-block with D-14-04 marker, distinct visual identity | ✓ VERIFIED | Renders `HOLISTIC_DATA_ONLY_MARKER`, confidence caption, item list; distinct warm-gray/Database identity from the terracotta/Eye vision block. |
| `src/components/discovery-results.tsx` | Threads `holisticBrief` prop | ✓ VERIFIED | `grep` confirms `holisticBrief={candidate.holisticBrief}` present. |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `confounder-guard.ts` | `area-comps.ts` | `MIN_COMPS_FOR_CONFIDENCE` import | ✓ WIRED | Line 23. |
| `confounder-guard.ts` | `holistic-schema.ts` | type imports + `HOLISTIC_DATA_ONLY_MARKER`/`tomtrattFromTenureForm` | ✓ WIRED | Lines 24-31. |
| `brf-lookup.ts` | `brf-source/allabrf.ts`, `org-nr-resolver.ts` | `searchAllabrfByName`/`fetchAllabrfDocument`/`resolveOrgNr` | ✓ WIRED | Lines 2-3, called in sequence. |
| `job.ts` | `brf-lookup.ts` | `lookupBrfSummary` under bounded concurrency | ✓ WIRED | Confirmed via grep + read of `lookupBrfForTopCandidates`. |
| `job.ts` | `confounder-guard.ts` | `normalizeForConfounders` + `buildHolisticBrief` post-vision | ✓ WIRED | Lines 1050-1082. |
| `discovery-results.tsx` | `gallery-condition-vision.tsx` | `holisticBrief` prop | ✓ WIRED | Confirmed via grep. |
| `niche-score.ts`/`flags.ts` | (must NOT import) `confounder-guard.ts`/`holistic-schema.ts`/`brf-lookup.ts` | static-grep structural-separation test | ✓ WIRED (passes today) — ⚠️ the matcher itself is line-anchored (WR-01) and blind to multi-line named imports, which is exactly how the new modules are imported elsewhere in the codebase today (`candidate.ts:6-13`, `confounder-guard.ts:24-31`). A future multi-line import into `niche-score.ts` would pass this guard silently. | Confirmed by reading `niche-score.test.ts:323-331`'s matcher against the actual import styles used. |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|---|---|---|---|---|
| ANL-01 | 14-01, 14-02, 14-04, 14-06 | Every candidate leaves analysis with ≥1 actionable opportunity | ✓ SATISFIED | Non-empty guarantee in `buildHolisticBrief`; wired and rendered end-to-end. |
| ANL-02 | 14-01, 14-05 | Value case folds in R_med/U_med via re-resolved areaId | ✓ SATISFIED (warnings noted) | Comps resolved once per area, attached, displayed; positioning prose is thin (WR-06) and the area-label cap is a scale-edge-case (WR-04). |
| ANL-03 | 14-01, 14-03, 14-06 | Value case folds in BRF summary for top candidates, respecting cost caps | ✗ BLOCKED | avgift unit bug, debt confidence-gate discarded, stambyte enum leak, soliditet unimplemented, cost-cap accounting can undercount real spend by ~60% (CR-04). |
| ANL-04 | 14-02, 14-04 | Normalize confounders before attribution; UI never implies low kr/m² ⇒ reno | ⚠️ PARTIAL | UI text guard solid; underlying debt-inclusive normalization step is fed unvetted data (CR-02), and a contradictory attribution value is persisted (WR-10, not yet user-visible). |

No orphaned requirements: all four ANL-0x IDs declared in PLAN frontmatter are present in REQUIREMENTS.md and vice versa.

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX` markers in any of the 25 phase-touched files (debt-marker gate: clean).

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| `src/lib/discovery/confounder-guard.ts` | 381 | Wrong unit rendered as fact (SEK/m²/år shown as kr/mån) | 🛑 Blocker | Materially wrong financial figure shown to a home buyer in a section framed as "trust this, it's data not interpretation." |
| `src/lib/discovery/brf-lookup.ts` / `confounder-guard.ts` | 137 / 145-155, 191-198, 382-385 | Sanity-check confidence downgrade discarded | 🛑 Blocker | Implausible debt value shown as fact and silently disables the §2.6 over-attribution guard. |
| `src/lib/discovery/confounder-guard.ts` | 387 | Raw snake_case enum concatenated into Swedish prose | 🛑 Blocker | Internal identifier leaked to users; "ej_nämnt" (no info) rendered as an information item. |
| `src/lib/discovery/brf-lookup.ts`, `src/lib/discovery/job.ts` | 150-157, 937-939 | Billed-then-failed calls reported as `costSek: 0` | 🛑 Blocker | Shared `CAP_VISION_SEK_MAX` pool can be exceeded by ~60% in the worst case; contradicts ANL-03's "respecting cost caps." |
| `src/lib/discovery/niche-score.test.ts` | 323-331 | Structural-separation guard is line-anchored, blind to multi-line imports | ⚠️ Warning | Sole enforcement of a locked invariant is silently inert for the exact import style used elsewhere in this phase's own new modules. |
| `src/lib/discovery/confounder-guard.ts` | 172-184, 238-239, 446-451 | `conditionAttribution.explainedPct` persisted despite `canAttributeToCondition === false` | ⚠️ Warning | Not user-visible in Phase 14 (only pre-cleared `item.text` strings render), but a Phase 15/16 consumer of the persisted JSONB would read a contradictory signal. |
| `src/lib/discovery/job.ts` | 689-702 | `MAX_AREAS_PER_SEARCH` repurposed as an invisible distinct-label comps cap | ⚠️ Warning | Can silently drop comps for candidates beyond the first 4 areas in a large job; loss is uncounted. |

### Human Verification Required

See frontmatter `human_verification` — four items, all environment-blocked (paused Supabase, IP-blocked Booli) per 14-VALIDATION.md's explicit deferred-live-gate precedent, plus one item (re-verify CR-01/02/03 fixes against a real BRF document) that depends on the code fixes above being applied first.

### Gaps Summary

The wiring and the "never empty" architecture (ANL-01, the phase's headline guarantee) are solid: every candidate leaves analysis with at least one item, comps are correctly resolved once per area and attached, and the UI-facing banned-text guard against "low kr/m² ⇒ reno object" phrasing works as designed and is well tested (135 tests green across the directly-relevant suites).

The gap is in the *semantics of the data being composed and priced* — exactly the class of defect the code review flagged as Critical, and independently confirmed here by reading `prompt.ts`/`sanity.ts`/`score.ts` against `confounder-guard.ts`, and `brf-lookup.ts`'s catch block against `extractBrfFinancials`'s throw-after-bill paths:

1. A real financial figure (avgift) is shown to the user ~6x too low due to a unit-labeling bug.
2. The one guard that exists to catch a garbage BRF-debt extraction (the sanity-band confidence downgrade) is computed and then thrown away, so bad data both misleads the user and corrupts the discount-attribution math ANL-04 depends on.
3. An internal enum token leaks into user-facing Swedish prose, and "not mentioned" is presented as if it were a finding.
4. The BRF-lookup cost accounting under-reports real spend after a failed-but-billed model call, undermining the shared cost-cap invariant ANL-03 promises.
5. `soliditet` — named explicitly in REQUIREMENTS.md's ANL-03 text — was never implemented. This was a disclosed, reasoned scope decision made during planning (14-CONTEXT.md D-14-02), not a silent shortcut, but the requirement's literal wording and its "Complete" status in REQUIREMENTS.md do not reflect that deferral.

None of these were fixed after the code review that found them (`5e27016` is the last commit touching this phase's files) — they are live in the code executor claims is "complete."

**This looks like a case where several deviations were deliberate scope calls but others are unaddressed correctness bugs.** Recommend the developer either fix CR-01/02/03/04 in a closure plan, or — for soliditet only, given its documented rationale — add an explicit override:

```yaml
overrides:
  - must_have: "ANL-03: BRF summary includes soliditet"
    reason: "No field exists on brfExtractionSchema; rarely cleanly extractable from iXBRL; debt/m² carries most of the balance-sheet signal (14-CONTEXT.md D-14-02)."
    accepted_by: "{name}"
    accepted_at: "{ISO timestamp}"
```

CR-01/02/03/04 are not good override candidates — they are not alternative-but-equivalent implementations, they are confirmed data-correctness bugs with a concrete, quantified user-facing impact.

---

_Verified: 2026-08-06T19:00:00Z_
_Verifier: Claude (gsd-verifier)_
