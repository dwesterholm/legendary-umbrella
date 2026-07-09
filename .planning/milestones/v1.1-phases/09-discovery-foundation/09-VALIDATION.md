---
phase: 9
slug: discovery-foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-06
---

# Phase 9 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing) + jsdom component tests (added Phase 8) |
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

*Populated by the planner from RESEARCH.md Validation Architecture. Every task addressing DISC-01/02/07 must carry an automated verify command or a Wave 0 dependency.*

| Task ID | Plan | Wave | Requirement | Secure Behavior | Test Type | Automated Command | Status |
|---------|------|------|-------------|-----------------|-----------|-------------------|--------|
| TBD | TBD | 0 | DISC-01 | Booli area-name→areaId probe (spike) OR static seed fallback | manual/probe | operator-approved Apify probe + fallback test | ⬜ pending |
| TBD | TBD | TBD | DISC-02 | claim_discovery_slice RPC is atomic (concurrent ticks never double-process a slice) | unit/integration | `npx vitest run` + live RPC concurrency check (operator) | ⬜ pending |
| TBD | TBD | TBD | DISC-07 | per-query + per-day caps + per-search SEK/candidate/image caps enforced INCREMENTALLY; feature flag OFF by default; kill switch; PII not persisted | unit | `npx vitest run` | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] **[SPIKE]** Booli area-name→areaId resolution: exploratory Playwright probe of Booli's search box via the owned transport (small operator-approved Apify spend); static seed-list fallback if unreliable. Blocks the scrape path — do first.
- [ ] `discovery_jobs` table + `claim_discovery_slice` RPC (FOR UPDATE SKIP LOCKED) migration (010) — atomic-claim tests (two concurrent claims never get the same slice)
- [ ] Free-text→filter parse (Haiku, extract.ts messages.parse + zodOutputFormat pattern) — fixture tests + low-confidence fail-safe (surface parse for user confirmation)
- [ ] Incremental cap enforcement: candidate count (20–30), images/listing, total SEK — checked per slice, not only at end; scanned-vs-shown honesty
- [ ] Feature flag OFF by default (entry point absent when off) + kill-switch degrade-to-single-URL
- [ ] PII/GDPR guardrail: raw scraped fields not persisted beyond the ranked result
- [ ] Client tick-driven slice advancement (Server Action) + polling (mirror BrfProgress); Vercel Cron once-daily orphan recovery

*Planner refines exact test file paths against RESEARCH.md Wave 0 section.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live area-search discovery end-to-end | DISC-01/02 | Running app + live Booli + Apify spend + feature flag ON | With flag ON: free-text + filters → background job → progress ("12 av 25") → persisted results at /discover/[jobId]; leave & return works |
| Cap + kill-switch under real load | DISC-07 | Requires live broad-area query | Broad popular-area query stops at candidate/SEK cap, honestly reports scanned-vs-shown; simulate Booli block → kill switch degrades to single-URL |
| claim_discovery_slice concurrency | DISC-02 | Requires live Postgres w/ concurrent ticks | Two concurrent ticks never process the same slice (FOR UPDATE SKIP LOCKED) |
| **Legal go/no-go FINAL sign-off + flag enable** | DISC-07 | Operator/legal decision | Re-read Booli/Hemnet ToS, re-derive proportionality, then (and only then) flip the feature flag ON in production |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (incl. the area-resolution spike)
- [ ] No watch-mode flags
- [ ] Feedback latency < 40s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
