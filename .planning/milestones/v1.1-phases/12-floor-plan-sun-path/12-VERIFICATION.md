---
phase: 12-floor-plan-sun-path
verified: 2026-07-07T19:15:00Z
status: human_needed
score: 12/12 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Live floor-plan hedging validation — the phase KILL CRITERION"
    expected: "On a candidate whose image set includes a planritning, the PLANLÖSNING row renders hedged investigation-prompts (verbs 'antyder'/'kan vara värt att undersöka'/'eventuellt'), cited to the floor-plan image, each ending with 'kräver konstruktör / väggutredning', and NEVER states a wall is bärande/icke-bärande as fact or says 'kan rivas'/'går att ta bort'. If the model repeats confidently-wrong load-bearing claims that cannot be hedged safely, the operator must record a CUT decision (remove the remodelPotential tuple entry in vision.ts + stop rendering PLANLÖSNING)."
    why_human: "Requires a running app, DISCOVERY_ENABLED=true, a live Anthropic API call against real listing images with a real planritning, and human judgment on whether the model's live output is safely hedged. Mocked tests can prove the code-enforced disclaimer and prompt contract exist, but cannot prove real model behavior on real images."
  - test: "Live 4-leaf-schema output_config.format API smoke"
    expected: "RUN_LLM_EVALS=1 npx vitest run evals/vision.eval.ts completes without a 400 from Anthropic's strict output_config.format now that visionDeepPassSchema has 4 nullable leaves (was 3)."
    why_human: "Requires real Anthropic API spend. Per project memory (anthropic-structured-output-limits), mocked tests cannot catch this class of 400 — only a live call can. This is explicitly operator-deferred per 12-02-PLAN.md/12-04-PLAN.md and 12-VALIDATION.md's Manual-Only Verifications table."
  - test: "Live sun-path render on a real listing"
    expected: "On a candidate with a stated orientation in its description (e.g. söderläge), the sun-path sub-block renders the Compass/warm-gray grid with the locked 'Teoretisk solexponering, tar inte hänsyn till skuggning från omgivande byggnader.' label. On a candidate with no stated orientation, the exact 'Solexponering: ej tillgänglig — riktning eller våningsdata saknas för denna annons.' line renders (never a guessed orientation)."
    why_human: "Requires a running app with DISCOVERY_ENABLED=true and a real discovery job against real Booli listings to visually confirm rendering, distinct from the jsdom/RTL component tests which only prove the code path exists with synthetic props."
---

# Phase 12: Floor-Plan & Sun-Path Verification Report

**Phase Goal:** Analyze the floor-plan image for remodel potential as an explicitly-hedged investigation-prompt, and show theoretical sun exposure by facade orientation/floor/season — both clearly labeled as advisory, never as verdicts.
**Verified:** 2026-07-07T19:15:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

Sourced from ROADMAP.md Success Criteria (SC1–SC4) merged with the four plans' `must_haves.truths` frontmatter.

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | For a listing with a planlösning image, remodel-potential observations render as investigation-prompts, each carrying the "kräver konstruktör / väggutredning" disclaimer — never a definitive wall-removal claim (ROADMAP SC1 / DISC-05) | VERIFIED (code) / human_needed (live model output) | `vision.ts:242-260` appends the disclaimer suffix in code unconditionally for every non-null `remodelPotential` claim, proven by a mocked-omit test (`vision.test.ts:207-243`) and a mocked-banned-word-attempt test (`vision.test.ts:300-334`) that both pass. `vision-prompt.ts:60-64` bans bärande/icke-bärande/garanterat/definitivt/"kan enkelt rivas" and mandates question-only hedging. `gallery-condition-vision.tsx:183-189` renders the section-level reinforcement line. Static code is fully wired and tested; the live model's actual real-world compliance is operator-deferred (kill criterion) |
| 2 | computeSunExposure returns byFacadeAndSeason:null (never a zeroed object) when latitude, longitude, floor, OR orientation is missing (DISC-06) | VERIFIED | `sun-path.ts:175-177` guard-clause-first returns the unavailable sentinel; 4 independent test cases (`sun-path.test.ts:43-69`) each assert null for exactly one missing input; a 5th test (`:71-77`) explicitly asserts never-zeroed. All pass. |
| 3 | computeSunExposure's azimuth-to-facade bucketing is numerically correct — solar noon at a northern-hemisphere lat/lon buckets to the south facade (DISC-06) | VERIFIED | `sun-path.test.ts:14-34` — mandatory smoke test using `SunCalc.getTimes().solarNoon` at Stockholm lat/lon, asserts azimuth in (170,190). Passes (measured ≈179.9999... per SUMMARY). Bucketing tests (`:97-134`) confirm north-only facade never sunniest and south-summer ≥ south-winter. |
| 4 | extractOrientationFromDescription returns null on text with no väderstreck keyword — never a fabricated or address-derived guess (DISC-06) | VERIFIED | `sun-path.ts:227-239` guard-clause-first, null on no input/no match. Tests (`:137-172`) cover null-input, no-keyword-text, address-substring-false-positive ("Söderlångsgatan" does not match), single/multi-facade match. Independently re-verified the regex against "Söderlångsgatan" — confirmed `false`. |
| 5 | Each listing with known orientation/floor shows theoretical sun exposure by facade/floor/season, explicitly labeled unobstructed/theoretical (ROADMAP SC2 / DISC-06) | VERIFIED (code) / human_needed (live render) | `sun-path-exposure.tsx:82-85` renders the exact locked label; grid renders qualitative (non-numeric) Swedish descriptors per facade/season (`sun-path.ts` SunQualityLabel enum). Component test (`sun-path-exposure.test.tsx:11-51`) asserts label + grid render. Live visual confirmation on a real listing is operator-deferred. |
| 6 | When floor or orientation data is missing, sun-path shows "ej tillgänglig" instead of a guessed value (ROADMAP SC3 / DISC-06) | VERIFIED | `sun-path-exposure.tsx:87-91` renders the exact degraded line when `byFacadeAndSeason` is null. Component tests (`:53-98`) cover both null-orientation and null-floor cases, asserting section identity (Compass/title/sub-label) still renders. Note: `extractOrientationFromDescription` produces only a single fixed confidence (0.5) — there is no variable "low-confidence" tier to distinguish from "missing," so the roadmap's "or low-confidence" phrasing is degenerate in this implementation (binary match/no-match only); this is a deliberate, documented design choice (12-01-SUMMARY.md), not a gap. |
| 7 | Sun-path is a fourth `remodelPotential` leaf, zero new Anthropic call, rides existing capped image set (DISC-05) | VERIFIED | `vision-schema.ts:81-86` — `remodelPotential: conditionAttribute` reused verbatim, no new shape. `vision.ts` — `imageBlocks`/`visionCostSek`/`estimateVisionCallSek`/`runVisionPass` confirmed byte-for-byte unchanged per SUMMARY diff description; no new API call added (single deep-pass call already includes all 4 leaves in one schema). |
| 8 | visionDeepPassSchema has exactly 4 nullable leaves (was 3) — still far under the ~28 Anthropic strict-output threshold (DISC-05) | VERIFIED | `vision-schema.test.ts:60-70` — static leaf-count guard asserts exactly 4 (`bathroom.claim`, `kitchen.claim`, `overall.claim`, `remodelPotential.claim`); zero numeric-constraint chains asserted separately (`:72-76`). Test passes. |
| 9 | Every remodelPotential claim is image-cited (imageIndex resolving into the capped set) — inherits the existing mandatory-citation bounds check (DISC-05) | VERIFIED | `vision.ts:224-241` — the SAME `.filter()` (confidence + imageIndex bounds) applies uniformly across all 4 attributes, no special-casing for remodelPotential. Test (`vision.test.ts:273-298`) confirms a remodelPotential claim below-threshold or out-of-bounds is dropped identically to the other 3. |
| 10 | DiscoveryCandidate carries latitude/longitude/floor + a DERIVED orientation — additive-nullable, no migration, backward-compatible (DISC-06) | VERIFIED | `candidate.ts:64-96` interface extension; `discoveryCandidateSchema:187-202` uses `.nullable().default(null)` (never `.optional()` alone) for all 4 new fields. No new file under `supabase/migrations/` (confirmed via `ls`, latest migration is `011_claim_slice_ownership.sql`, unrelated). Backward-compat test present in `candidate.test.ts` per SUMMARY. |
| 11 | Raw description text is NEVER persisted on the candidate — orientation is derived ONCE at toCandidate time (DISC-06/DISC-07) | VERIFIED | `candidate.ts:141` — `extractOrientationFromDescription(str(raw.description))` called as a direct expression, never bound to a local var or added as an object-literal key. `candidate.test.ts:58-59,152,164` assert `Object.prototype.hasOwnProperty.call(result, "description") === false` in 3 scenarios including a PII-bearing description. All pass. |
| 12 | Neither floor-plan claims nor sun-path is EVER fed into computeNicheScore/ReportFlags — structural-separation invariant extended to forbid a sun-path import (DISC-05/06, ROADMAP SC4) | VERIFIED | `niche-score.test.ts:278-319` — `VISION_MODULE_SPECIFIERS` extended with 3 `discovery/sun-path` quoting variants; both `niche-score.ts` and `flags.ts` asserted to import neither vision nor sun-path modules. Independently re-verified via direct `grep "^import"` on both files — confirmed no vision/sun-path import exists in either. `discovery-results.tsx:202-209` threads latitude/longitude/floor/orientation only into `GalleryConditionVision`, never into `computeNicheScore`/`rankPosition`/`nicheSignals` (verified by reading the file). |

**Score:** 12/12 truths verified at the code level. 3 of these truths (1, 5, and part of 6) have a live/model-behavior dimension that is explicitly operator-deferred and classified as human_verification below — this is intentional per the plan's own kill-criterion design, not a code gap.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/lib/discovery/sun-path.ts` | computeSunExposure + extractOrientationFromDescription, pure/deterministic | VERIFIED | Exists, 240 lines, exports both functions, imports only `suncalc`, zero Anthropic/network import |
| `src/lib/discovery/sun-path.test.ts` | Azimuth smoke + 4 null-propagation cases + orientation null-on-no-match | VERIFIED | 174 lines, 16 test cases, all pass |
| `package.json` | suncalc runtime dependency | VERIFIED | `"suncalc": "^2.0.0"` present, no `@types/suncalc` added |
| `src/lib/discovery/vision-schema.ts` | remodelPotential 4th leaf | VERIFIED | `visionDeepPassSchema` has exactly 4 keys (kitchen/bathroom/overall/remodelPotential); `VisionConditionClaim["attribute"]` union + `visionResultSchema` enum both extended |
| `src/lib/discovery/vision.ts` | Claims tuple + code-enforced disclaimer | VERIFIED | `["remodelPotential", parsed.remodelPotential]` in tuple; disclaimer ternary at map() |
| `src/lib/discovery/vision-prompt.ts` | Floor-plan instruction with banned-word contract | VERIFIED | 4th paragraph added, contains "kräver konstruktör / väggutredning", bans bärande/icke-bärande/garanterat/definitivt/"kan enkelt rivas" |
| `src/lib/discovery/candidate.ts` | latitude/longitude/floor/orientation extension | VERIFIED | Interface + toCandidate + schema all extended; no `description` field/key anywhere |
| `src/lib/booli/client.ts` | reshapeListingEntity emits description | VERIFIED | Line 290: `description: str(entry.description) ?? undefined` |
| `src/components/sun-path-exposure.tsx` | Compass/warm-gray computed sub-block | VERIFIED | 127 lines, "use client", calls computeSunExposure in-component, renders grid or degraded line, no Eye/terracotta/Bild |
| `src/components/gallery-condition-vision.tsx` | PLANLÖSNING label + reinforcement line + embedded sun-path | VERIFIED | ATTRIBUTE_LABELS includes remodelPotential: "PLANLÖSNING"; reinforcement line conditional on ≥1 claim; SunPathExposure embedded unconditionally at end of CardContent |
| `src/lib/discovery/niche-score.test.ts` | Structural-separation invariant extended | VERIFIED | VISION_MODULE_SPECIFIERS includes 3 sun-path quoting variants; both it() cases cover niche-score.ts and flags.ts |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `sun-path.ts` | `suncalc` | `SunCalc.getPosition`/`SunCalc.getTimes` | WIRED | Confirmed at lines 111, and via `SunCalc.getTimes` in the smoke test |
| `vision.ts` | `vision-schema.ts` | `parsed.remodelPotential` mapped into claims tuple | WIRED | Line 221, confirmed in code read |
| `candidate.ts` | `sun-path.ts` | `extractOrientationFromDescription(str(raw.description))` at toCandidate time | WIRED | Line 141, confirmed |
| `candidate.ts` | `discovery_jobs.results` (JSONB) | `.nullable().default(null)` additive fields | WIRED | Confirmed no migration created; schema uses correct discipline |
| `sun-path-exposure.tsx` | `sun-path.ts` | `computeSunExposure(latitude, longitude, floor, orientation)` | WIRED | Line 65-70, confirmed |
| `discovery-results.tsx` | `gallery-condition-vision.tsx` | candidate latitude/longitude/floor/orientation passed | WIRED | Lines 206-209, confirmed feeding ONLY GalleryConditionVision, not the scorer |
| `niche-score.test.ts` | `sun-path.ts` | extended structural-separation invariant grep | WIRED | Confirmed via direct grep of niche-score.ts/flags.ts imports — neither imports vision or sun-path |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| `sun-path-exposure.tsx` | `latitude`/`longitude`/`floor`/`orientation` props | `discovery-results.tsx` → `candidate.latitude` etc. | Yes — `client.ts:308-309` reads `num(entry.latitude)`/`num(entry.longitude)` off the raw Apollo entity (not hardcoded); `candidate.ts:130-136` passes through via `num()`/`rawOf()` unwrap | FLOWING |
| `gallery-condition-vision.tsx` PLANLÖSNING row | `claim.claim` (remodelPotential) | `vision.ts` deep-pass Anthropic call → `parsed.remodelPotential` | Yes at the code level (real Anthropic call, not a static return) — but the ACTUAL live model output content is unverified without the operator's live smoke test | FLOWING (code) / UNVERIFIED (live content) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Azimuth convention (solar noon → south) | `npx vitest run src/lib/discovery/sun-path.test.ts` | 16/16 tests pass | PASS |
| Address false-positive guard | `node -e` regex test against "Söderlångsgatan" | `false` (no match) | PASS |
| Full phase test suite (10 files) | `npx vitest run <10 phase-relevant test files>` | 163/163 tests pass | PASS |
| Full project suite regression | `npx vitest run` | 612 passed, 3 skipped (pre-existing, unrelated) | PASS |
| Type-check | `npx tsc --noEmit` | Clean, no errors | PASS |
| Lint | `npx eslint <11 phase-relevant files>` | Clean, no errors | PASS |
| No new migration | `ls supabase/migrations/` | Latest is `011_claim_slice_ownership.sql` (pre-Phase-12) | PASS |
| Structural separation (direct import check) | `grep "^import" niche-score.ts flags.ts` | Neither imports vision or sun-path | PASS |
| Git commit integrity | `git log --oneline -20` | All 12 commit hashes claimed across the 4 SUMMARY files present | PASS |

### Probe Execution

Not applicable — this phase has no `scripts/*/tests/probe-*.sh` files and no PLAN/SUMMARY declared probes. SKIPPED (no probe-based verification declared for this phase).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|--------------|--------|----------|
| DISC-05 | 12-02-PLAN.md, 12-04-PLAN.md | System analyzes the floor-plan image for remodel potential as an investigation-prompt with an explicit disclaimer — never a load-bearing/wall-removal verdict | SATISFIED (code) / human_needed (live model compliance — kill criterion) | 4th vision leaf, code-enforced disclaimer, banned-word-hedged prompt, PLANLÖSNING UI row all implemented and tested; live real-model hedging behavior is the phase's own named kill criterion, explicitly operator-deferred |
| DISC-06 | 12-01-PLAN.md, 12-03-PLAN.md, 12-04-PLAN.md | Each listing shows theoretical sun exposure by facade orientation/floor/season, labeled unobstructed/theoretical | SATISFIED (code) / human_needed (live render confirmation) | computeSunExposure + extractOrientationFromDescription + candidate persistence + SunPathExposure UI all implemented and tested; live visual render on a real listing is operator-deferred |

No orphaned requirements — REQUIREMENTS.md maps only DISC-05 and DISC-06 to Phase 12, both are declared in plan frontmatter (12-01/12-03 declare DISC-06; 12-02 declares DISC-05; 12-04 declares both).

### Anti-Patterns Found

None. Scanned all 11 phase-modified/created source files for TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER/placeholder-language/empty-implementations/hardcoded-empty-data. Zero blocker-class or warning-class markers found. The single "placeholder" string match (`vision.ts:236`) is inside a code comment explaining why a placeholder box is deliberately NOT used — this is anti-stub reasoning, not a stub marker.

The one pre-existing, out-of-scope `eslint prefer-const` issue in `evals/vision.eval.ts:147` (logged in `deferred-items.md`, confirmed pre-existing via `git stash` per 12-02-SUMMARY.md) is correctly excluded from this phase's scope per the Scope Boundary rule and does not affect Phase 12's own files.

### Human Verification Required

These three items are the phase's own explicitly-designed operator checkpoint (12-04-PLAN.md Task 4, gate="blocking") and 12-VALIDATION.md's Manual-Only Verifications table. All Phase 12 code is complete, tested, and green under mocked/pure tests — these three items require live API spend, a running app, and human judgment that cannot be automated.

#### 1. Live floor-plan hedging validation — PHASE KILL CRITERION

**Test:** Set env (Supabase + APIFY_API_TOKEN + ANTHROPIC_API_KEY + DISCOVERY_ENABLED=true + vision flag ON), run a real discovery job, and on a candidate whose image set includes a planritning, inspect the rendered PLANLÖSNING row.
**Expected:** Hedged investigation-prompt language only (verbs "antyder"/"kan vara värt att undersöka"/"eventuellt"), cited to the floor-plan image, always ending with "kräver konstruktör / väggutredning", and NEVER a stated-as-fact bärande/icke-bärande verdict or "kan rivas"/"går att ta bort". If the live model output repeats confidently-wrong load-bearing claims that cannot be hedged safely, the operator must record a CUT decision (remove the `["remodelPotential", parsed.remodelPotential]` tuple entry in vision.ts, stop rendering PLANLÖSNING, ship sun-path alone).
**Why human:** Requires real Anthropic API spend against real listing images and human judgment on whether live model output is safely hedged — the entire premise of the kill criterion is that mocked tests cannot prove real-world model compliance.

#### 2. Live 4-leaf-schema output_config.format API smoke

**Test:** `RUN_LLM_EVALS=1 npx vitest run evals/vision.eval.ts` against a real fixture.
**Expected:** No 400 error from Anthropic's strict output_config.format now that visionDeepPassSchema carries 4 nullable leaves (previously 3).
**Why human:** Requires real API spend; per project memory (`anthropic-structured-output-limits`), this specific class of 400 is only observable via a live call — mocked tests structurally cannot catch it.

#### 3. Live sun-path render on a real listing

**Test:** On a running app with a real discovery job, inspect a candidate with a stated orientation in its description (e.g. söderläge) and a candidate with no stated orientation.
**Expected:** The former renders the Compass/warm-gray grid with the locked "Teoretisk solexponering, tar inte hänsyn till skuggning från omgivande byggnader." label; the latter renders the exact "Solexponering: ej tillgänglig — riktning eller våningsdata saknas för denna annons." line.
**Why human:** Requires a running app and real Booli listing data to visually confirm the rendering matches the design intent — component tests prove the code path with synthetic props but not real-world visual/data correctness.

### Gaps Summary

No code-level gaps found. All 12 derived observable truths are verified against the actual codebase (not SUMMARY claims): every artifact exists, is substantive (no stubs/placeholders), is wired correctly, and — where dynamic data is involved — the data genuinely flows from Booli's scraped Apollo data through to the UI without fabrication. The full test suite (612 tests), tsc, and eslint are all clean. Git history confirms every commit hash claimed across the four SUMMARY files.

The three items requiring human verification are not gaps — they are the phase's own explicitly-designed, blocking operator checkpoint (the named kill criterion), correctly deferred per the task instructions accompanying this verification request. Status is `human_needed` rather than `passed` per Step 9 of the verification process (any identified human-verification item forces this status regardless of code-level score).

One design nuance is noted but not treated as a gap: ROADMAP SC3's "missing or low-confidence" phrasing does not have a distinct low-confidence code path — `extractOrientationFromDescription` produces a single fixed confidence (0.5) on any match, so orientation is effectively binary (matched-or-null). This was a documented, deliberate design decision in 12-01-SUMMARY.md and does not block the phase goal, since the "ej tillgänglig" degrade path correctly fires whenever orientation is null.

---

*Verified: 2026-07-07T19:15:00Z*
*Verifier: Claude (gsd-verifier)*
