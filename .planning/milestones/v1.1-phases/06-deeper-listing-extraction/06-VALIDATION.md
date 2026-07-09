---
phase: 6
slug: deeper-listing-extraction
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-06
---

# Phase 6 — Validation Strategy

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

*Populated by the planner from RESEARCH.md Validation Architecture / Wave 0 test gaps. Each task addressing LSTG-03 / LSTG-04 must carry an automated verify command or a Wave 0 dependency.*

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | TBD | TBD | LSTG-03/04 | SSRF guard | broker fetch rejects private/loopback/link-local targets | unit | `npx vitest run` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Apollo-state extraction tests for floor / brfName / balcony (fixture-backed, LSTG-03)
- [ ] Broker-page parse + gap-fill-only merge tests (LSTG-03, provenance distinguishable)
- [ ] SSRF-guard unit tests (reject private/loopback/link-local + non-http(s) protocols)
- [ ] PII-exclusion test (no mäklare name/phone/email in stored data or output, LSTG-04)
- [ ] Independent-degradation test (broker fetch failure never fails primary analysis)

*Planner refines exact test file paths against RESEARCH.md Wave 0 section.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real broker-CMS coverage (Vitec/Mspecs/Fasad JSON-LD prevalence) | LSTG-03 | Requires live sampling of real `agencyListingUrl` domains (informational spike) | Sample N real listings; record which broker fields parse vs fall back to "unavailable" |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
