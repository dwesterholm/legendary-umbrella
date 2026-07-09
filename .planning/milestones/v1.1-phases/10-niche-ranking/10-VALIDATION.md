---
phase: 10
slug: niche-ranking
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-06
---

# Phase 10 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing) + jsdom component tests |
| **Config file** | vitest.config.ts (existing) |
| **Quick run command** | `npx vitest run <changed-test-file>` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~40 seconds |

---

## Sampling Rate

- **After every task commit:** Run the quick command for the changed test file
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 40 seconds

---

## Per-Task Verification Map

*Populated by the planner from RESEARCH.md Validation Architecture. Every task addressing DISC-03 must carry an automated verify command or a Wave 0 dependency.*

| Task ID | Plan | Wave | Requirement | Behavior | Test Type | Automated Command | Status |
|---------|------|------|-------------|----------|-----------|-------------------|--------|
| TBD | TBD | TBD | DISC-03 | extended toCandidate stays PII-safe (constructionYear/tenureForm/brfName only, no PII, no spread) | unit | `npx vitest run` | ⬜ pending |
| TBD | TBD | TBD | DISC-03 | 3 niches produce DISTINGUISHABLE orderings on the same candidate set; deterministic scorer is pure + cited | unit | `npx vitest run` | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Extend `toCandidate` to capture constructionYear + tenureForm + brfName (from breadcrumbs) — PII-safe allowlist test (no PII, no object-spread) stays green
- [ ] Area-baseline lookup (reuse sold-comps infra) for the price/kvm-vs-area signal — fixture-backed
- [ ] Deterministic niche scorer (pure function, like computeBrfGrade/computeFlags): 3 niches → distinguishable orderings on a fixture candidate set; cited signals per candidate; no opaque numeric score
- [ ] Stambyte niche v1 = hedged construction-year proxy (copy hedged; real BRF-backed signal deferred to opt-in)
- [ ] Niche selector reorders in place (client-side); degenerate/too-few-candidates → original order + banner
- [ ] Flag-gated (DISCOVERY_ENABLED) — inherited from Phase 9

*Planner refines exact test file paths against RESEARCH.md Wave 0 section.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Niches produce useful orderings on REAL candidates | DISC-03 | Requires a real discovery run (flag ON) + human judgement of "more useful than filtering" | Run discovery, switch niches, confirm orderings visibly change and are defensible via cited signals. **Kill criterion:** if the 3 niches produce near-identical orderings on real data, ship filtering-only and defer niche ranking. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 40s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
