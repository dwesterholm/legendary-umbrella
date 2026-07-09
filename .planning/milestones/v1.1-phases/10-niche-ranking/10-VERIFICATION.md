---
phase: 10-niche-ranking
verified: 2026-07-07T16:30:00Z
status: human_needed
score: 9/9 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Manual UAT kill-criterion check: run one real discovery job with DISCOVERY_ENABLED=true, switch between the 3 niches, confirm orderings visibly change and are defensible via cited signals on REAL scraped data."
    expected: "The 3 niches produce visibly different, defensible orderings on real candidate data (not just synthetic fixtures). If they produce near-identical orderings, the roadmap's own kill criterion says to ship filtering-only and defer ranking."
    why_human: "Requires a live DISCOVERY_ENABLED area search against real Booli data and subjective judgement of whether the cited signals are convincing/useful to a real user — cannot be programmatically asserted against synthetic fixtures. This is the phase's explicit, roadmap-defined kill criterion (10-02-PLAN.md <verification> section, STATE.md Operator Next Steps)."
---

# Phase 10: Niche Ranking Verification Report

**Phase Goal:** Rank discovery candidates against the user's free-text intent via configurable niches (renovation-upside, turnkey, imminent-stambyte-where-BRF-pays), so results are ordered by fit rather than just filtered.
**Verified:** 2026-07-07T16:30:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `toCandidate` maps `constructionYear`/`brfName`/`tenureForm` from the already-reshaped raw record, still an explicit no-spread allowlist (no PII added) | VERIFIED | `src/lib/discovery/candidate.ts:55-68` — explicit 10-key object literal, no `{...raw}` spread; `candidate.test.ts:25-47` proves extra raw fields (agencyName, breadcrumbs, housingCoop, brokerDescription) never leak into the result |
| 2 | `discoveryCandidateSchema` safeParses an OLD pre-Phase-10 persisted row missing the 3 new keys entirely | VERIFIED | `candidate.ts:91-93` uses `.nullable().optional()` (not bare `.nullable()`); `candidate.test.ts:99-116` asserts `safeParse` on a 7-key-only fixture succeeds |
| 3 | `computeNicheScore` is a pure, deterministic function returning a score plus a cited-signal breakdown for each of the 3 niches (DISC-03, mirrors `computeBrfGrade`) | VERIFIED | `niche-score.ts:118-229` — synchronous, no `Date`/`Math.random`/network/async; `niche-score.test.ts:37-44` asserts identical repeated-call output |
| 4 | A null/absent fact produces an `assessable:false` breakdown row contributing 0, never a fabricated positive/negative | VERIFIED | `niche-score.ts:132-133` (`push()` accumulator); `niche-score.test.ts:65-108` covers null constructionYear, null price/livingArea, and null areaBaseline, all yielding `assessable:false`/`contribution:0` |
| 5 | The 3 niches produce DISTINGUISHABLE orderings over the same fixed candidate set | VERIFIED | `niche-score.test.ts:141-207` cross-niche test on a 4-candidate fixture: asserts ≥2 of 3 pairwise orderings differ, and explicitly that turnkey's top pick (newest) ≠ imminent-stambyte's top pick (oldest); test passes |
| 6 | The imminent-stambyte niche v1 uses a DISTINCT hedged construction-year proxy signal key, never reusing `FLAG_IDS.STAMBYTE_PLANERAT` | VERIFIED | `niche-score.ts:210-223` keys the row `"stambyteProxyAge"`; grepped entire `src/lib/discovery/` — `FLAG_IDS.STAMBYTE_PLANERAT`/`"stambyte_planerat"` appear only in comments explaining the deliberate distinction, never as an actual key; `niche-score.test.ts:111-120` asserts this |
| 7 | Selecting a niche visibly reorders the candidate cards in place, client-side, with NO new Server Action and no job re-run | VERIFIED | `discovery-results.tsx:82-113` — `useState`/`useMemo` only, imports no Server Action; `discovery-results.test.tsx:93-109` renders, switches niche twice, asserts the first visible card's address changes AND `fetch` spy is never called |
| 8 | Each ranked card shows cited signals (sourceRef chips) plus a plain `#{n}` ordinal, never an opaque score | VERIFIED | `discovery-candidate-card.tsx:66-70` (sage `#{rankPosition}` badge, identical styling every rank) + `112-141` (chips via `NICHE_SIGNAL_LABELS`, capped at 3, filters `assessable:false`); `discovery-candidate-card.test.tsx:110-132` explicitly asserts no bare score/percentage renders |
| 9 | Degenerate (<3) and computation-error states degrade to original order + banner, never a crash; selector hidden when 0 candidates | VERIFIED | `discovery-results.tsx:87,100-113,119` — degenerate check, try/catch around scoring/sort, `candidates.length > 0` guard around the selector row; `discovery-results.test.tsx:111-159` covers both the degenerate banner and the forced-throw error-banner cases |

**Score:** 9/9 truths verified programmatically. One additional item (the roadmap's own kill-criterion UAT) requires human judgement on real data — see Human Verification below.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/lib/discovery/candidate.ts` | Extended `DiscoveryCandidate` (10 fields) + `toCandidate` + additive-optional schema | VERIFIED | Exactly 10 fields; explicit object literal; `.nullable().optional()` on the 3 new fields |
| `src/lib/discovery/niches.ts` | `NICHE_WEIGHTS` single-source-of-truth table + `NicheId` type | VERIFIED | 3 niche entries, each weight set sums to 1 (unit-tested); all thresholds named constants |
| `src/lib/discovery/niche-score.ts` | `computeNicheScore` pure scorer + interfaces | VERIFIED | Exports `computeNicheScore`, `SignalContribution`, `NicheScoreResult`, `AreaBaseline`, `NICHE_SIGNAL_LABELS`, `NICHE_SIGNAL_SOURCE_LABELS` |
| `src/lib/discovery/niche-score.test.ts` | Determinism, not_assessable, cross-niche distinguishability tests | VERIFIED | 12 test cases, all passing, non-tautological (real fixture math) |
| `src/components/discovery-niche-selector.tsx` | Controlled Select for 4 niche options | VERIFIED | `"use client"`, controlled via props (no internal `useState`), 4 fixed options with exact UI-SPEC Swedish labels, 55 lines |
| `src/components/discovery-results.tsx` | Client reorder owner + baseline + degenerate/error banners | VERIFIED | 167 lines; `useMemo` re-sort, `computeAreaBaseline` pure median helper, degenerate + error banner branches, stable `sourceListingUrl` keys |
| `src/components/discovery-candidate-card.tsx` | Extended card: rank badge + cited chips + no-signal caption | VERIFIED | Optional `rankPosition`/`nicheSignals` props (additive, Phase 9 call sites unaffected); contains `rankPosition` |
| `src/app/(app)/discover/[jobId]/page.tsx` | Wires `DiscoveryResults` into done+candidates branch | VERIFIED | `git diff` against pre-Phase-10 commit shows ONLY the done+candidates branch changed; auth guard, empty-state, failed/degraded branches byte-identical |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `niche-score.ts` | `niches.ts` | imports `NICHE_WEIGHTS` | WIRED | `niche-score.ts:2` imports `NICHE_WEIGHTS`/`NicheId`; no inline magic-number literals found in scoring branches |
| `niche-score.ts` | `candidate.ts` | consumes `DiscoveryCandidate` | WIRED | `niche-score.ts:1` imports the type; `computeNicheScore` signature takes it as first param |
| `discovery-results.tsx` | `niche-score.ts` | `computeNicheScore` in `useMemo` | WIRED | `discovery-results.tsx:8,103` — imported and called inside the sort `useMemo`, wrapped in try/catch |
| `page.tsx` | `discovery-results.tsx` | replaces inline grid with `<DiscoveryResults>` | WIRED | `page.tsx:6,92` — import + usage in the done+candidates branch; confirmed via git diff that this is the only change |
| `discovery-candidate-card.tsx` | `niche-score.ts` | renders `SignalContribution[]` as chips | WIRED | `discovery-candidate-card.tsx:6-9` imports `NICHE_SIGNAL_LABELS`/`NICHE_SIGNAL_SOURCE_LABELS`/`SignalContribution`; used at lines 117-119 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| `discovery-results.tsx` | `ranked` (candidate + score) | `computeNicheScore(candidate, niche, areaBaseline)` over `candidates` prop, which originates from `page.tsx`'s `discoveryCandidateSchema.safeParse`d, persisted `discovery_jobs.results` | Real deterministic computation from persisted candidate facts (not static/empty) | FLOWING |
| `discovery-candidate-card.tsx` | `nicheSignals` prop | `result?.breakdown` from `computeNicheScore` | Real per-candidate breakdown array, filtered to `assessable:true`, capped at 3 | FLOWING |
| `discovery-niche-selector.tsx` | `value`/`onChange` | Controlled by parent `DiscoveryResults`'s `useState` | Real controlled state, not hardcoded | FLOWING |

No hardcoded-empty props or static returns found on the data path from persisted candidates through to rendered chips/badges.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full phase-relevant unit/component test suite | `npx vitest run src/lib/discovery/candidate.test.ts src/lib/discovery/niche-score.test.ts src/components/discovery-candidate-card.test.tsx src/components/discovery-results.test.tsx` | 4 files, 31 tests, all passed | PASS |
| Full repo test suite (regression check) | `npx vitest run` | 51 files passed, 2 skipped, 501 tests passed | PASS |
| Type-check | `npx tsc --noEmit -p tsconfig.json` | No output (clean) | PASS |
| Production build | `npm run build` | Compiled successfully, all routes generated including `/discover/[jobId]` | PASS |
| `page.tsx` branch-isolation check | `git diff 334e944 HEAD -- "src/app/(app)/discover/[jobId]/page.tsx"` | Only the done+candidates branch changed; auth/empty/failed branches untouched | PASS |
| stambyte key discipline (no reuse of confirmed BRF signal key) | `grep -rn "STAMBYTE_PLANERAT\|stambyte_planerat" src/lib/discovery/` | Only appears in comments explaining the deliberate distinction, never as an actual object key | PASS |

### Probe Execution

No probe scripts declared or discovered for this phase (`scripts/*/tests/probe-*.sh` search returned none; no probe references in PLAN/SUMMARY). Step 7c: SKIPPED (no runnable probes for this phase).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|--------------|--------|----------|
| DISC-03 | 10-01-PLAN.md, 10-02-PLAN.md | Candidates are ranked against the free-text intent via configurable niches (renovation-upside, turnkey, imminent-stambyte-where-BRF-pays) | SATISFIED (automatable portion) | Data/scorer core (Plan 01) + UI reorder (Plan 02) both verified above; REQUIREMENTS.md already marks DISC-03 `[x]` mapped to "Phase 10 (Niche Ranking)" — consistent with codebase evidence. The remaining "defensible on real data" judgement is the human-verification item below. |

No orphaned requirements: REQUIREMENTS.md's Phase-10 mapping table lists only DISC-03, and both plans declare `requirements: [DISC-03]`.

### Anti-Patterns Found

None. Scanned all 12 phase-touched files (`candidate.ts`, `candidate.test.ts`, `niches.ts`, `niche-score.ts`, `niche-score.test.ts`, `discovery-niche-selector.tsx`, `discovery-results.tsx`, `discovery-results.test.tsx`, `discovery-candidate-card.tsx`, `discovery-candidate-card.test.tsx`, `job.test.ts`, `page.tsx`) for `TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER`, placeholder/coming-soon/not-implemented copy, and stub-shaped empty returns — zero matches.

### Human Verification Required

### 1. Manual UAT kill-criterion check (real-data niche defensibility)

**Test:** Run one real discovery job with `DISCOVERY_ENABLED=true` against a real Stockholm-area search, then switch between all 3 niches ("Renoveringspotential", "Inflyttningsklar", "Stambyte planerat — föreningen betalar") on the resulting candidate set.

**Expected:** The card ordering visibly changes between niches, and each ranked card's cited-signal chips are concrete and defensible (e.g. an old construction year, a below-baseline price/sqm) rather than near-identical/indistinguishable across niches on real listing data.

**Why human:** This is the phase's own roadmap-defined kill criterion ("If text-only ranking can't produce orderings a user finds more useful than plain filtering, ship discovery with filtering only and defer niche ranking" — ROADMAP.md Phase 10). It requires live `DISCOVERY_ENABLED` scraped data and a subjective judgement of real-world usefulness that cannot be asserted from synthetic unit-test fixtures. The unit/component tests already prove the mechanism works correctly and deterministically on constructed fixtures (Truths 5 and 7 above) — this check validates that the mechanism also produces *useful* results on messy real-world data (e.g. sparse `constructionYear`/`tenureForm` coverage from area search, per RESEARCH Assumption A3).

### Gaps Summary

No gaps. All 9 derived observable truths (roadmap's 3 Success Criteria plus PLAN-frontmatter must-haves) are verified in the codebase with passing, substantive, non-tautological tests; the full 501-test suite is green; `tsc --noEmit` and `npm run build` are clean; `page.tsx`'s render-branch surgery is confirmed minimal via git diff; the PII allowlist, additive-optional schema, distinguishable orderings, not_assessable discipline, hedged stambyte copy, and degenerate/error UI states are all directly evidenced in source and tests, not merely claimed in SUMMARY.md.

The phase is blocked from a clean `passed` status only by the outstanding operator-owned manual UAT kill-criterion check, which the plan itself scoped as a live/real-data judgement call outside automated test coverage. This does not indicate incomplete work — it is a deliberate escalation gate the plan built in from the start (10-02-PLAN.md `<verification>` section, STATE.md "Operator Next Steps").

---

*Verified: 2026-07-07T16:30:00Z*
*Verifier: Claude (gsd-verifier)*
