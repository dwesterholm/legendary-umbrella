---
phase: 13
slug: discovery-ux-poll-timeout-fix
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-18
---

# Phase 13 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Derived from 13-RESEARCH.md §Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (existing) + React Testing Library + fake timers |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npx vitest run src/lib/discovery/job.test.ts src/components/discovery-progress.test.tsx src/lib/booli/client.test.ts` |
| **Full suite command** | `npm run test` |
| **Estimated runtime** | ~quick <15s; full suite ~1–2 min (DB integration test self-skips without `RUN_DB_INTEGRATION=1`) |

---

## Sampling Rate

- **After every task commit:** Run the quick run command
- **After every plan wave:** Run `npm run test`
- **Before `/gsd-verify-work`:** Full suite green PLUS one live manual smoke on a real large multi-area query (the RESUME.md query) to observe real completion timing and sanity-check the threshold constants
- **Max feedback latency:** ~15 seconds (quick)

---

## Per-Task Verification Map

| Req | Behavior | Test Type | Automated Command | File Exists |
|-----|----------|-----------|-------------------|-------------|
| DXUX-01 | Areas fetched concurrently, not sequentially (timing proof: elapsed ≈ max, not sum) | unit (staggered fake timers) | `npx vitest run src/lib/discovery/job.test.ts -t "multi-area"` | ❌ W0 (extend existing `describe("runSlice — multi-area search")`) |
| DXUX-01 | Existing multi-area aggregation / partial-failure / degrade-on-all-throw semantics unchanged after loop→allSettled refactor | unit | `npx vitest run src/lib/discovery/job.test.ts` | ✅ (job.test.ts:348–441, should pass unmodified) |
| DXUX-01 | `claim_discovery_slice` still serializes concurrent claims (D-03 race-free invariant regression) | integration (real PG, gated) | `RUN_DB_INTEGRATION=1 SUPABASE_SERVICE_ROLE_KEY=<key> npx vitest run src/lib/discovery/job.integration.test.ts` | ✅ (exists, no code change expected) |
| DXUX-01 | Area-page render respects scoped lower `waitSecs` override WITHOUT regressing detail/broker fetches | unit | `npx vitest run src/lib/booli/client.test.ts` | ❌ W0 (assert `fetchAreaPage` passes override, `fetchListing` passes defaults) |
| DXUX-01 | Soft-notice shows without `onComplete("failed")`; polling continues past old 5-min mark | component (RTL + fake timers) | `npx vitest run src/components/discovery-progress.test.tsx` | ❌ W0 (replace old hard-fail timeout test) |
| DXUX-01 | Absolute ceiling still surfaces a real failure for a genuinely stuck job | component (RTL + fake timers) | `npx vitest run src/components/discovery-progress.test.tsx` | ❌ W0 |
| DXUX-02 | Every known status has a `STATUS_LABELS` entry (no raw-string fallback reachable) | unit | `npx vitest run src/components/discovery-progress.test.tsx` | ❌ W0 (exhaustiveness test over the 6 statuses) |
| DXUX-02 | `vision_processing` renders "Analyserar bilder" | component (RTL) | `npx vitest run src/components/discovery-progress.test.tsx` | ❌ W0 |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Timing-based concurrency proof in `job.test.ts` (staggered mock delays, assert elapsed ≈ max not sum) — DXUX-01
- [ ] `client.test.ts` assertion that area-page rungs pass a scoped `waitSecs` override while detail/broker fetches do not — DXUX-01
- [ ] `discovery-progress.test.tsx`: replace hard-fail timeout test with soft-notice (non-failing, keeps polling) + absolute-ceiling (real fail) tests — DXUX-01
- [ ] `discovery-progress.test.tsx`: exhaustiveness test over the 6 known status strings vs `STATUS_LABELS` — DXUX-02
- [ ] Framework install: NONE — Vitest, RTL, and fake-timer utilities already present.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real completion timing of a 300+ listing multi-area run finishes in-window; no forced reload | DXUX-01 | Only a live run against real Booli exercises actual render timing; mocked timers can't observe real latency (project's "run one live smoke" discipline) | Run the RESUME.md query ("Renoveringsobjekt i Södermalm och Vasastan under 4 miljoner") with `DISCOVERY_ENABLED=true`; confirm results render without reload and the soft-notice (not a failure) shows if it runs long. Calibrate `SOFT_THRESHOLD_MS` / `ABSOLUTE_CEILING_MS` / `AREA_PAGE_WAIT_SECS` from observed timing. |

---

## Security Sign-Off (from RESEARCH §Security Domain)

- [ ] V4 Access Control (regression-only): the existing IDOR ownership pre-check (`tickDiscovery`, `row.user_id !== user.id`) + `discovery_jobs` RLS remain untouched — the area-fetch refactor must not move logic to a path that bypasses this check.
- [ ] Cost double-spend (Tampering-via-race): no new per-area DB write reopens the check-then-act window; `runSlice` keeps its "read from claimedRow, write once" discipline.
- [ ] Cost-DoS: the synchronous cost pre-check (job.ts:161–167 estimates ALL area renders' cost) stays BEFORE `Promise.allSettled`, not reordered per-area after fetches begin.

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s (quick)
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
