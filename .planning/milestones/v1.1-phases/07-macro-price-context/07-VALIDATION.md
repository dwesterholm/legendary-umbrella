---
phase: 7
slug: macro-price-context
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-07-06
---

# Phase 7 — Validation Strategy

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

*Populated by the planner from RESEARCH.md Validation Architecture. Every task addressing MACRO-01/02 carries an automated verify command or a Wave 0 dependency.*

| Task ID | Plan | Wave | Requirement | Secure Behavior | Test Type | Automated Command | Status |
|---------|------|------|-------------|-----------------|-----------|-------------------|--------|
| P01-T1 | 07-01 | 1 | MACRO-01/02 | macro_snapshots RLS policy present (no default-deny lockout); migration pushed live | migration + grep | `grep -v '^--' supabase/migrations/006_macro_snapshots.sql \| grep -c "create policy"` == 3 + `supabase db push` | ⬜ pending |
| P01-T2 | 07-01 | 1 | MACRO-01/02 | normalizers parse live-shaped fixtures; schema shape has NO direction/magnitude field | unit | `npx vitest run src/lib/market/macro-schema.test.ts` | ⬜ pending |
| P01-T3 | 07-01 | 1 | MACRO-01 | read-through cache hit/miss/stale + independent per-indicator degradation; SSRF län allowlist | unit (mocked Supabase + fetch) | `npx vitest run src/lib/market/macro.test.ts` | ⬜ pending |
| P02-T1 | 07-02 | 2 | MACRO-01 | 4th enrich branch persists macro_data, never gates terminal status, GDPR-safe logging | grep + type-check | `grep -q "macro_data: macro" src/actions/enrich-market-context.ts` + `npx vitest run` | ⬜ pending |
| P02-T2 | 07-02 | 2 | MACRO-02 | fact-sheet macro slot (explicit ej_tillgänglig) + prompt ABSOLUT REGEL 5 + version bump | grep | `grep -q "ABSOLUT REGEL 5" src/lib/report/prompt.ts` | ⬜ pending |
| P02-T3 | 07-02 | 2 | MACRO-02 | banned-predictive-phrase regression scan (no direction/magnitude/timing/buy-sell) — gate bites | unit (string scan) | `npx vitest run src/lib/report/banned-predictive-phrases.test.ts` | ⬜ pending |
| P03-T1 | 07-03 | 3 | MACRO-01/02 | MacroContextCard own labeled section, per-indicator degrade, NO computeFlags/severity | grep + unit | `(! grep -q computeFlags src/components/macro-context-card.tsx)` + banned-phrase test | ⬜ pending |
| P03-T2 | 07-03 | 3 | MACRO-01 | macroData wired as 3rd independent panel + page read + fingerprint parity | grep + build | `grep -q "macro: macroData" page.tsx` + `npm run build` | ⬜ pending |
| P03-T3 | 07-03 | 3 | MACRO-01/02 | live render on a real analysis (visually separate, descriptive, degrading) | human-verify | operator checkpoint | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Riksbank SWEA parse tests (policy rate `SECBREPOEFF`), fixture-backed — `src/lib/market/macro-schema.test.ts` + `__fixtures__/riksbank-policy-rate.json`
- [ ] SCB PxWebApi parse tests for CPIF + regional BRF price index (fixture-backed, via `buildPxWebQuery`) — `macro-schema.test.ts` + `__fixtures__/scb-cpif.json` + `__fixtures__/scb-bo0501c-lan.json`
- [ ] macro_snapshots cache read/write + TTL expiry tests — `src/lib/market/macro.test.ts` (mocked Supabase)
- [ ] Banned-predictive-phrase regression test (no direction/magnitude/timing/buy-sell language) — `src/lib/report/banned-predictive-phrases.test.ts`
- [ ] Independent-degradation test (one macro source unavailable → "ej tillgänglig", price/area data intact) — `macro.test.ts` "independent" + section-level D-08 behavior

*Note: `src/actions/enrich-market-context.test.ts` does NOT exist today (pre-existing gap, not introduced by this phase). The 4th branch's independent-degradation is exercised at the unit level in `macro.test.ts` and confirmed at the integration level by the live checkpoint (P03-T3); a dedicated enrich integration test is out of scope for this additive phase.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live macro section renders on a real analysis | MACRO-01/02 | Requires running app + live Riksbank/SCB responses | Run a real analysis; confirm Makroekonomisk kontext section shows policy rate + KPIF + regional trend with source + reference period, clearly separated from listing comparison (P03-T3 checkpoint) |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies (P03-T3 is the one human-verify checkpoint, as designed)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** planner-approved (pending execution)
