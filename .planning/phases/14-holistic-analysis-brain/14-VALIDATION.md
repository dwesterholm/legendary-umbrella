---
phase: 14
slug: holistic-analysis-brain
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-27
---

# Phase 14 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `14-RESEARCH.md` § Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.8 |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npx vitest run src/lib/discovery/job.test.ts src/lib/discovery/vision.test.ts src/lib/discovery/area-comps.test.ts` |
| **Full suite command** | `npm run test` (`vitest run`) |
| **Estimated runtime** | ~10s quick / ~60s full (748-test baseline as of Phase 13) |

---

## Sampling Rate

- **After every task commit:** the relevant single-file `npx vitest run <file>` from the map below
- **After every plan wave:** `npm run test` (full suite) — this phase touches shared `cost.ts` / `candidate.ts` / `discoveryCandidateSchema` that many modules depend on, so full-suite regression risk is real and cheap to catch here
- **Before `/gsd-verify-work`:** full suite must be green
- **Max feedback latency:** ~10 seconds (quick), ~60 seconds (full)

---

## Per-Task Verification Map

| Req | Behavior | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|-----|----------|------------|-----------------|-----------|-------------------|-------------|--------|
| ANL-01 | A candidate whose `claims` end up `[]` (BOTH the Haiku-skip and confidence-filter paths) receives a non-null `holisticBrief` carrying the D-14-04 marker | V5 | `.nullable().default(null)` Zod read guard on the new field | unit | `npx vitest run src/lib/discovery/vision.test.ts` | ✅ file / ❌ new cases | ⬜ pending |
| ANL-02 | `computeAreaComps` output correctly attributed per resolved areaId; comps fetched ONCE per distinct areaId across a multi-area candidate set (no double-count) | — | N/A | unit + integration | `npx vitest run src/lib/discovery/job.test.ts src/lib/discovery/job.integration.test.ts` | ✅ files / ❌ new cases | ⬜ pending |
| ANL-02 | Per-candidate `resolveArea(candidate.areaLabel)` (mocked) attaches the correct `AreaComps` shape (D-14-11) | — | N/A | unit | `npx vitest run src/lib/discovery/job.test.ts` | ✅ file / ❌ new cases | ⬜ pending |
| ANL-03 | `kommun` derived on the candidate from `entry.breadcrumbs` (D-14-09), incl. genitive normalization ("Stockholms kommun" → matches registry "Stockholm") | V5 | Zod-guarded additive-nullable field | unit | `npx vitest run src/lib/discovery/candidate.test.ts src/lib/brf-source/org-nr-resolver.test.ts` | ✅ files / ❌ new cases | ⬜ pending |
| ANL-03 | BRF top-N selection reuses `enrichmentVisitOrder`, skips `brfName === null`, runs under bounded `Promise.allSettled` (D-14-10); a rejected fetch degrades to comps+hedonic and never fails the tick | V12 | Reuses `allabrf.ts` host-allowlist + `isValidOrgNr` Luhn gate before URL construction — call order unchanged | unit | `npx vitest run src/lib/discovery/job.test.ts` | ✅ file / ❌ new cases | ⬜ pending |
| ANL-04 | §2.6 discount-attribution guard: >25% below R_med → cap condition-explained at 20%, residual → hidden-defect; ≥5 comps in 12mo else widen band + downgrade confidence; kr/m² normalized inclusive of förening debt/m² | — | N/A | unit | `npx vitest run src/lib/discovery/confounder-guard.test.ts` | ❌ **Wave 0** | ⬜ pending |
| ANL-04 | UI never renders text implying "låg kr/m² ⇒ renoveringsobjekt"; data-only brief shows the D-14-04 marker | — | N/A | unit | `npx vitest run src/components/gallery-condition-vision.test.tsx` | ✅ **resolved:** target is `gallery-condition-vision.tsx` (:90-208), NOT `discovery-results.tsx` | ⬜ pending |
| ANL-01 (UI) | The `visionRanButEmpty` branch (`gallery-condition-vision.tsx` ~:137-142) currently dead-ends with "För osäkert för att visa — inga bildbaserade slutsatser kunde dras med rimlig säkerhet." — **this is the Ringvägen 122 surface.** It must instead render the holistic-data-only brief with the D-14-04 marker. | — | N/A | unit | `npx vitest run src/components/gallery-condition-vision.test.tsx` | ✅ file / ❌ new cases | ⬜ pending |
| D-14-08 | Cost accounting: comps + BRF spend shares `CAP_VISION_SEK_MAX=10` via `runningVisionSek`; comps amortized per-area never double-counted per candidate; exhaustion → skip further fetches + degrade gracefully | Cost-DoS | Protected by existing `claimVisionSlice` CAS — no new race surface | unit | `npx vitest run src/lib/discovery/cost.test.ts` | ✅ file / ❌ new cases | ⬜ pending |
| LOCKED separation | Any new holistic/confounder module added to `VISION_MODULE_SPECIFIERS`; `niche-score.ts` / `report/flags.ts` still import none of it | — | N/A | unit | `npx vitest run src/lib/discovery/niche-score.test.ts` | ✅ file — **MUST be edited** (add specifier), not just re-run | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/lib/discovery/confounder-guard.test.ts` (or equivalent) — net-new module + tests for ANL-04's §2.6 rule encoding
- [ ] **Add the new module's specifier to `niche-score.test.ts`'s `VISION_MODULE_SPECIFIERS` FIRST** — the guard is silently inert for a new module until its specifier is listed. Self-verifying once added (the existing two `it(...)` blocks fail if niche-score/flags import it), but must be added before the module is written.
- [ ] Additive test cases (not new files) in `job.test.ts`, `job.integration.test.ts`, `vision.test.ts`, `cost.test.ts`, `candidate.test.ts` — these files exist and already mock `resolveArea`/`fetchSoldComps`-adjacent deps from prior phases, so this is test-case authorship, not new infrastructure.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| End-to-end live smoke: real comps + BRF fetched and folded into a real multi-area discovery run, within cost cap and inside the tick window | ANL-02, ANL-03, D-14-08 | **Two environment blockers:** (1) the Supabase project is **paused** — `resolveArea` reads the `area_cache` table; (2) the operator's local IP is Booli/Cloudflare-blocked (403 on detail pages). Mocked tests cannot observe real Apify/Allabrf latency, real spend accounting, or true wall-clock inside the ~300s ceiling. | **Prerequisite:** restore the Supabase project in the dashboard, then run from a non-blocked IP (deployed/staging) with `DISCOVERY_ENABLED=true`. Query: "Renoveringsobjekt i Södermalm och Vasastan under 4 miljoner". Confirm: comps fetched once per area (not per candidate), BRF attempted only for top-N, `cost_sek_total`/vision budget respected, no tick timeout, and every candidate has ≥1 actionable item. |
| Genitive kommun corroboration actually yields `confidence: "high"` against the live Allabrf registry | ANL-03 | Registry kommun spellings can only be confirmed against the live Allabrf response; fixtures may not reflect real nominative/genitive forms. | During the live smoke above, log `resolveOrgNr`'s returned confidence for each BRF top-N candidate; confirm `"high"` is reached for unambiguous single-name matches. |
| Whether `tenureForm` surfaces a tomträtt-equivalent value at all (research OQ-2, LOW confidence) | ANL-03, ANL-04 | All existing `tenureForm` test fixtures are exclusively `"Bostadsrätt"` — no tomträtt sample exists to verify against. | During the live smoke, capture `tenureForm` values across a wide result set; if no tomträtt value ever appears, tomträtt-as-confounder is inert and should be recorded as such (not silently assumed working). |

**Deferred-live-gate precedent:** Do NOT block phase completion on these. Record them as explicit deferred operator steps in the phase SUMMARY/VERIFICATION, exactly as Phases 11/12/13 did (Phase 13's DXUX-01 is the direct analog).

---

## Validation Sign-Off

- [ ] All tasks have automated verify or a Wave 0 dependency
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags (`vitest run`, never bare `vitest`)
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
