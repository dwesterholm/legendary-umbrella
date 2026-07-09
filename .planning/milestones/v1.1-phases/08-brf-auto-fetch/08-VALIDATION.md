---
phase: 8
slug: brf-auto-fetch
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-06
---

# Phase 8 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing) |
| **Config file** | vitest.config.ts (existing) |
| **Quick run command** | `npx vitest run <changed-test-file>` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run the quick command for the changed test file
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

*Populated by the planner from RESEARCH.md Validation Architecture. Every task addressing ENRICH-01/02 must carry an automated verify command or a Wave 0 dependency.*

| Task ID | Plan | Wave | Requirement | Secure Behavior | Test Type | Automated Command | Status |
|---------|------|------|-------------|-----------------|-----------|-------------------|--------|
| TBD | TBD | TBD | ENRICH-01/02 | org.nr match requires geographic corroboration (no name-only match → no wrong-BRF); SSRF allowlist on Allabrf host | unit | `npx vitest run` | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `runBrfExtraction()` refactor: manual + auto paths converge on the same helper (D-06 hash cache, cost-cap, scoring pipeline unchanged) — regression tests for the existing manual path stay green
- [ ] org.nr resolver: name+geo → org.nr with confidence gate; below-threshold → no auto-fetch (fall through to manual), never a wrong-BRF match
- [ ] Allabrf fetch + iXBRL/HTML→text extraction feeding the SAME Claude extraction call (cheerio strip)
- [ ] Confirmation gate: user confirms org.nr + fiscal year before analysis
- [ ] Independent-degradation: auto-fetch failure → manual upload path fully functional (fall-through)
- [ ] `auto_fetching` transient status + `brf_fetch_source` additive-nullable column migration

*Planner refines exact test file paths against RESEARCH.md Wave 0 section.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live Allabrf auto-fetch on a real BRF | ENRICH-01 | Requires running app + live Allabrf + a real listing with resolvable org.nr | Run a real analysis on a listing whose BRF has an Allabrf årsredovisning; confirm org.nr + fiscal year prompt, then identical extraction/scoring to manual upload |
| Manual-fallback prominence + wrong-match fall-through | ENRICH-02 | Visual/UX judgement | Confirm manual upload equally prominent; a low-confidence org.nr match falls through to manual, never auto-analyzes the wrong BRF |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
