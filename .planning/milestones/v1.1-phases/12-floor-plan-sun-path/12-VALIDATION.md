---
phase: 12
slug: floor-plan-sun-path
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-07-07
---

# Phase 12 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing) + jsdom component tests + evals/ (RUN_LLM_EVALS-gated) |
| **Config file** | vitest.config.ts (existing) |
| **Quick run command** | `npx vitest run <changed-test-file>` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~45 seconds (excludes RUN_LLM_EVALS live eval) |

---

## Sampling Rate

- **After every task commit:** Run the quick command for the changed test file
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 45 seconds

---

## Per-Task Verification Map

*Populated by the planner from RESEARCH.md Validation Architecture. Every task addressing DISC-05/06 must carry an automated verify command or a Wave 0 dependency.*

| Task ID | Plan | Wave | Requirement | Behavior | Test Type | Automated Command | Status |
|---------|------|------|-------------|----------|-----------|-------------------|--------|
| 12-01-T1 | 01 | 1 | DISC-06 | npm install suncalc (pre-approved gate) + azimuth convention verified against installed version | smoke | `node -e "require('suncalc').getPosition(new Date(),59.33,18.06)"` | ⬜ pending |
| 12-01-T2 | 01 | 1 | DISC-06 | computeSunExposure pure/deterministic (suncalc); azimuth-convention smoke; null per each missing input; extractOrientationFromDescription stated-väderstreck-only, null-on-no-match | unit (pure, no mocking) | `npx vitest run src/lib/discovery/sun-path.test.ts` | ⬜ pending |
| 12-02-T1 | 02 | 1 | DISC-05 | visionDeepPassSchema 4th remodelPotential leaf; static nullable-leaf count 3→4; zero numeric constraints | unit (static shape) | `npx vitest run src/lib/discovery/vision-schema.test.ts` | ⬜ pending |
| 12-02-T2 | 02 | 1 | DISC-05 | deep-pass prompt floor-plan instruction + banned-verdict-word contract | unit | `npx vitest run src/lib/discovery/vision-prompt.test.ts` | ⬜ pending |
| 12-02-T3 | 02 | 1 | DISC-05 | remodelPotential mapped into claims; "kräver konstruktör / väggutredning" disclaimer enforced in code (proven with model-omit); banned words rejected; image-cited via inherited bounds | unit (mocked SDK) | `npx vitest run src/lib/discovery/vision.test.ts` | ⬜ pending |
| 12-03-T1 | 03 | 2 | DISC-06 | reshapeListingEntity emits description (read-only source for orientation, never persisted) | unit | `npx vitest run src/lib/booli/client.test.ts` | ⬜ pending |
| 12-03-T2 | 03 | 2 | DISC-06 | DiscoveryCandidate/toCandidate/schema + latitude/longitude/floor + DERIVED orientation; raw description never persisted; allowlist tripwire extended; pre-Phase-12 backward-compat | unit | `npx vitest run src/lib/discovery/candidate.test.ts` | ⬜ pending |
| 12-04-T1 | 04 | 3 | DISC-06 | SunPathExposure Compass/warm-gray computed sub-block; ej-tillgänglig on missing floor/orientation; no Eye/terracotta/Bild | component (jsdom/RTL) | `npx vitest run src/components/sun-path-exposure.test.tsx` | ⬜ pending |
| 12-04-T2 | 04 | 3 | DISC-05/06 | GalleryConditionVision PLANLÖSNING row + reinforcement line + embedded sun-path; discovery-results wiring | component (jsdom/RTL) | `npx vitest run src/components/gallery-condition-vision.test.tsx` | ⬜ pending |
| 12-04-T3 | 04 | 3 | DISC-05/06 | structural-separation invariant extended — niche-score.ts/flags.ts import neither vision NOR sun-path | unit (static grep) | `npx vitest run src/lib/discovery/niche-score.test.ts` | ⬜ pending |
| 12-04-T4 | 04 | 3 | DISC-05/06 | OPERATOR live floor-plan hedging (kill criterion) + live 4-leaf-schema smoke + live sun-path render | manual (operator checkpoint) | `RUN_LLM_EVALS=1 npx vitest run evals/vision.eval.ts` (operator) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `npm install suncalc` (v2.0.0 — pre-verified legit: 225k weekly downloads, zero deps, slopcheck OK; the package-legitimacy checkpoint is pre-approved)
- [ ] `computeSunExposure` pure deterministic sun-path (suncalc getPosition/getTimes; azimuth-convention smoke test — Pitfall 1) with facade/floor/season buckets, labeled theoretical/unobstructed — pure-function tests, no mocking
- [ ] `extractOrientationFromDescription` deterministic Swedish-keyword regex over the description (stated väderstreck ONLY; never address; never LLM); low-confidence/absent → null → "ej tillgänglig"
- [ ] `DiscoveryCandidate` additive-nullable extension: latitude/longitude/floor (+ derived orientation result) — `.nullable().default(null)`; raw description NOT persisted (PII); PII-safe allowlist test
- [ ] floor-plan `remodelPotential` as a 4th leaf in visionDeepPassSchema (3→4, under the 400 threshold); disclaimer enforced post-parse; banned-word/verdict rejection test; image-cited
- [ ] Structural separation preserved: floor-plan in the vision section, sun-path as computed sibling — neither fed into computeNicheScore/ReportFlags
- [ ] Degradation: no floor-plan image → no prompts; floor/orientation missing → sun-path "ej tillgänglig"

*Planner refines exact test file paths against RESEARCH.md.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live floor-plan vision run + hedging validation | DISC-05 | Real floor-plan images + flag ON + API spend | Run the vision pass on real planlösning images; confirm remodelPotential claims are hedged investigation-prompts with the "kräver konstruktör / väggutredning" disclaimer, image-cited, NEVER a wall-removal/load-bearing verdict. **Kill criterion:** if it repeats confidently-wrong load-bearing claims, OMIT the floor-plan claim type; ship sun-path alone or defer both. |
| One live structured-output API smoke (4-leaf schema) | DISC-05 | Real Anthropic call | Re-run one live output_config.format smoke now that visionDeepPassSchema has 4 leaves — mocked tests can't catch the 400 class of bug. |
| Live sun-path render on a real listing | DISC-06 | Running app + flag ON + a listing with known orientation/floor | Confirm theoretical sun exposure renders by facade/floor/season with the "teoretisk...tar inte hänsyn till skuggning" label; missing orientation/floor → "ej tillgänglig", never a guess. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 45s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
