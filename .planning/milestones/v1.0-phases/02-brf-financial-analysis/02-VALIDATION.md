---
phase: 2
slug: brf-financial-analysis
status: ready
nyquist_compliant: true
wave_0_complete: false
created: 2026-06-07
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (installed in Wave 0 by Plan 02-01) + promptfoo (cost-gated LLM evals) |
| **Config file** | `vitest.config.ts` — none yet; Wave 0 installs |
| **Quick run command** | `npx vitest run src/lib/brf src/lib/schemas/brf.test.ts` |
| **Full suite command** | `npx tsc --noEmit && npx vitest run` |
| **Estimated runtime** | ~15 seconds (unit only; LLM evals gated behind `RUN_LLM_EVALS=1`, not in per-task loop) |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/lib/brf src/lib/schemas/brf.test.ts`
- **After every plan wave:** Run `npx tsc --noEmit && npx vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 02-01-02 | 01 | 0 | BRF-01 | — | N/A | infra | `npx vitest run 2>&1 \| grep -qE "(No test files found\|Test Files)"` | ❌ W0 | ⬜ pending |
| 02-01-03 | 01 | 0 | BRF-01/02/03 | T-02 (no-grade-field invariant) | Extraction schema contains no grade/score key | unit (RED) | `npx vitest run src/lib/brf src/lib/schemas/brf.test.ts src/actions/analyze-brf.test.ts` (expected RED) | ❌ W0 | ⬜ pending |
| 02-02-01 | 02 | 1 | BRF-03 | T-02 (RLS bypass) | Private bucket + RLS UPDATE policy | source | `grep` shape checks on `supabase/migrations/002_brf.sql` (brf-pdfs, FOR UPDATE, brf_status) | ✅ | ⬜ pending |
| 02-02-02 | 02 | 1 | BRF-03 | T-02-SC | Live schema matches types (no false-positive verify) | [BLOCKING] push | `supabase db push` (checkpoint, `SUPABASE_ACCESS_TOKEN` for non-TTY) | ✅ | ⬜ pending |
| 02-03-01 | 03 | 1 | BRF-01 | T-02 (schema drift) | All fields `.nullable()`, normalizer null-tolerant | tdd | `npx vitest run src/lib/schemas/brf.test.ts` | ❌ W0 | ⬜ pending |
| 02-03-02 | 03 | 1 | BRF-02 | T-02 (grade provenance) | Deterministic A–F, no LLM input | tdd | `npx vitest run src/lib/brf/score.test.ts` | ❌ W0 | ⬜ pending |
| 02-03-03 | 03 | 1 | BRF-01/02 | T-02 (silent wrongness) | Out-of-band values confidence-downgraded | tdd | `npx vitest run src/lib/brf/sanity.test.ts src/lib/brf/cost.test.ts` | ❌ W0 | ⬜ pending |
| 02-04-01 | 04 | 2 | BRF-01 | T-02 (API key exposure) | No `dangerouslyAllowBrowser`; server-only SDK | source+compile | `npx tsc --noEmit` + grep `messages.parse`/`cache_control`/no-`dangerouslyAllowBrowser` in `extract.ts` | ✅ | ⬜ pending |
| 02-04-02 | 04 | 2 | BRF-01/03 | T-02 (auth bypass, cost cap) | Hard login gate; correctBrfField never re-extracts | unit+source | `npx tsc --noEmit && npx vitest run src/actions/analyze-brf.test.ts` + grep gates | ✅ | ⬜ pending |
| 02-05-01 | 05 | 3 | BRF-03 | T-02 (upload abuse) | PDF-only, 20 MB client check, login gate | source+compile | `npx tsc --noEmit` + grep `analyzeBrf`/`application/pdf`/`brf_status` in upload/progress components | ✅ | ⬜ pending |
| 02-05-02 | 05 | 3 | BRF-03 | — | Guest sees teaser, not upload | source+compile | `npx tsc --noEmit` + grep `BrfSection` wired, ComingSoonSection removed, "Logga in" teaser | ✅ | ⬜ pending |
| 02-06-01 | 06 | 4 | BRF-02 | T-02 (trust contract) | Osäker badges, source quotes, manual-edit marking | source+compile | `npx tsc --noEmit` + grep `correctBrfField`/`Osäker`/`Manuellt angiven`/`pageRef` in score card | ✅ | ⬜ pending |
| 02-06-02 | 06 | 4 | BRF-02 | — | Public methodology imports live thresholds | source+compile | `npx tsc --noEmit` + grep `BRF_SCORE_THRESHOLDS`/`BRF_SANITY_BANDS` in `sa-raknar-vi/page.tsx` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `vitest` + `promptfoo` installed (Plan 02-01 Task 2 — no test framework exists yet)
- [ ] `src/lib/schemas/brf.test.ts` — RED stubs for schema/normalizer (BRF-01)
- [ ] `src/lib/brf/score.test.ts` — RED golden tests for deterministic A–F scorer (BRF-02)
- [ ] `src/lib/brf/sanity.test.ts` — RED stubs for sanity-band downgrade (BRF-01/02)
- [ ] `src/lib/brf/cost.test.ts` — RED stubs for SEK cost computation (<5 SEK budget)
- [ ] `src/actions/analyze-brf.test.ts` — RED stubs for server-action pipeline + no-grade-field invariant

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live extraction against real Claude API | BRF-01 | Requires `ANTHROPIC_API_KEY` + real spend | Plan 02-04 checkpoint: upload a real årsredovisning PDF, verify extraction + cost < 5 SEK |
| Schema push to live database | BRF-03 | Supabase CLI auth, possibly interactive | Plan 02-02 checkpoint: `supabase db push`, then verify columns/bucket exist |
| Upload UX + live progress | BRF-03 | Browser interaction | Plan 02-05 checkpoint: drag-drop PDF as logged-in user, watch D-13 progress steps |
| Trust UX (grade, badges, citations, inline edit) | BRF-02 | Visual/interaction judgment | Plan 02-06 checkpoint: verify A–F card, Osäker badges, source quotes, edit→re-score |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (5 test files + framework install in Plan 02-01)
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-06-07 (plan-checker Dimension 8 PASS)
