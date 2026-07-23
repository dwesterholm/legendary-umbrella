# Phase 13: Discovery UX / Poll-Timeout Fix — Plan Verification Report

**Verification Date:** 2026-07-18  
**Verifier:** gsd-plan-checker (Claude Code)  
**Phase Goal:** The now-live discovery flow finishes within the user's patience window (no forced reload) and every job state shows a Swedish status label (no raw enum leak).  
**Requirements:** DXUX-01 (in-window completion), DXUX-02 (Swedish labels for all 6 statuses)

---

## Verdict: ✅ PASS

All three plans will deliver the phase goal. Plans are complete, requirements are fully covered, locked constraints are honored, Wave-0 tests are included, and dependencies are correct.

---

## Summary

| Dimension | Status | Findings |
|-----------|--------|----------|
| 1. Requirement Coverage | ✅ PASS | DXUX-01 covered by 13-01 (backend) + 13-02 (UX) + 13-03 (live proof); DXUX-02 covered by 13-02 (STATUS_LABELS + vision_processing label) |
| 2. Task Completeness | ✅ PASS | All 5 tasks (2+2+1) have read_first, action, acceptance_criteria, verify, and done elements |
| 3. Dependency Correctness | ✅ PASS | Wave 1: 13-01, 13-02 (parallel); Wave 2: 13-03 (depends on both); no cycles or forward references |
| 4. Key Links Planned | ✅ PASS | Artifacts wired together: area parallelization → Promise.allSettled, waitSecs override → AREA_PAGE_WAIT_SECS, soft timer → slow state, terminal branch clears both timers |
| 5. Scope Sanity | ✅ PASS | Good distribution: 13-01 (2 tasks, 5 files), 13-02 (2 tasks, 2 files), 13-03 (1 checkpoint, 2 files). Total 5 tasks across 3 plans, well within budget |
| 6. Verification Derivation | ✅ PASS | must_haves properly derived from phase goal; truths are user-observable (not implementation-focused); artifacts map to truths; key_links connect them |
| 7. Context Compliance | ✅ PASS | All 7 locked decisions honored: D-01/D-02/D-03 (backend), D-04/D-05/D-06/D-07 (client); no contradictions or scope reduction detected |
| 8. Nyquist Compliance | ✅ PASS | All 4 Wave-0 tests included: concurrency timing proof (13-01-T1), scoped-override assertion (13-01-T2), exhaustiveness test (13-02-T1), soft/hard timeout tests (13-02-T2); no watch-mode flags; feedback latency <15s |
| 9. Cross-Plan Data Contracts | ✅ PASS | No conflicting transforms on shared data; no preservation gaps |
| 10. CLAUDE.md Compliance | ⏭️ SKIP | CLAUDE.md not found in project root; not applicable |
| 11. Research Resolution | ✅ PASS | 13-RESEARCH.md exists with comprehensive analysis; Open Questions #1 and #2 intentionally deferred for calibration by 13-03 checkpoint; appropriate for the phase structure |
| 12. Pattern Compliance | ✅ PASS | All plans correctly reference 13-PATTERNS.md analogs: area-loop mirrors page-level Promise.allSettled (client.ts:719-736); waitSecs override adds optional param preserving all existing call sites; timer pattern mirrors BrfProgress model; no new patterns needed |

---

## Detailed Findings

### Dimension 1: Requirement Coverage

**DXUX-01** (In-window completion, no forced reload):
- **13-01 Task 1**: Parallelize areas in runSlice via `Promise.allSettled(areaIds.map(fetchAreaListings))` — collapses sum(area times) → max(area time)
- **13-01 Task 2**: Scoped `AREA_PAGE_WAIT_SECS` override on area-page renders — bounds per-page worst-case time so one straggler can't blow the 300s Vercel ceiling
- **13-02 Task 2**: Two-tier timeout (soft notice + absolute ceiling) — eliminates false "Misslyckades" that forced reloads
- **13-03 Task 1**: Live smoke on RESUME.md query (300+ listings, multi-area, vision) — end-to-end proof the run completes in-window without reload
- ✓ Requirement fully covered

**DXUX-02** (Swedish status labels for all 6 statuses):
- **13-02 Task 1**: Complete `STATUS_LABELS` with `vision_processing: "Analyserar bilder"` + add `KNOWN_STATUSES` const with 6 entries; exhaustiveness test proves no raw enum reachable
- **13-03 Task 1**: Live confirmation no raw enum appears in badge at any point
- ✓ Requirement fully covered

### Dimension 2: Task Completeness

All 5 tasks present required elements:

**13-01 Task 1 (Parallelize area loop)**
- ✓ `<read_first>` — lines 78-82: specific line ranges (job.ts:160-238, client.ts:703-743, job.test.ts:348-441, PATTERNS.md)
- ✓ `<action>` — lines 88-93: RED → GREEN → refactor to Promise.allSettled, preserves LOCKED D-03 invariants (cost pre-check before allSettled, single terminal update, no per-area DB write)
- ✓ `<acceptance_criteria>` — lines 94-100: verifiable (grep for Promise.allSettled, test for staggered timing, cost pre-check position, terminal update position)
- ✓ `<verify>` — line 102: `npx vitest run src/lib/discovery/job.test.ts`
- ✓ `<done>` — line 104: Observable outcome described

**13-01 Task 2 (Scoped waitSecs override)**
- ✓ `<read_first>` — lines 110-115: specific paths and line ranges for relevant functions
- ✓ `<action>` — lines 122-127: RED → GREEN pattern; extends `runPlaywrightRender` with optional `opts` param (defaults 240/3, preserves all existing call sites); adds `AREA_PAGE_WAIT_SECS = 120` to client.ts
- ✓ `<acceptance_criteria>` — lines 129-134: verifiable criteria including grep check that detail-page rungs are byte-for-byte unchanged
- ✓ `<verify>` — line 136: `npx vitest run src/lib/booli/client.test.ts`
- ✓ `<done>` — line 138: Observable outcome

**13-02 Task 1 (Complete STATUS_LABELS)**
- ✓ `<read_first>` — lines 65-69: specific source locations
- ✓ `<action>` — lines 76-79: RED → GREEN; adds single `vision_processing: "Analyserar bilder"` entry and `KNOWN_STATUSES` const
- ✓ `<acceptance_criteria>` — lines 82-88: verifiable (grep count, test coverage, component render)
- ✓ `<verify>` — line 90: `npx vitest run src/components/discovery-progress.test.tsx`
- ✓ `<done>` — line 92: Observable outcome

**13-02 Task 2 (Two-tier timeout)**
- ✓ `<read_first>` — lines 98-103: specific locations and patterns
- ✓ `<action>` — lines 111-115: RED → GREEN; replaces single `MAX_POLL_MS` with two timers (SOFT_THRESHOLD_MS=90_000, ABSOLUTE_CEILING_MS=15*60_000); soft timer sets `slow` state (non-terminal), hard timer sets `timedOut` + calls `onComplete("failed")`; extends terminal branch to clear both timers
- ✓ `<acceptance_criteria>` — lines 117-124: verifiable (grep for constant definitions, banner rendered, timer clearing logic, fake-timer test proofs)
- ✓ `<verify>` — line 126: `npx vitest run src/components/discovery-progress.test.tsx`
- ✓ `<done>` — line 128: Observable outcome

**13-03 Task 1 (Live smoke checkpoint)**
- ✓ `<read_first>` — lines 52-56: specific file references for context
- ✓ `<what-built>` — lines 58-59: summary of Wave 1 output
- ✓ `<action>` — lines 61-63: describes human-verify checkpoint, pause for operator
- ✓ `<how-to-verify>` — lines 64-76: 8 detailed steps including exact query from RESUME.md, what to confirm (results in-window, no forced reload, Swedish labels, calm soft-notice if slow, no raw enum), constant calibration guidance
- ✓ `<acceptance_criteria>` — lines 77-83: verifiable observable conditions + optional constant re-tuning
- ✓ `<verify>` — lines 84-86: both automated check and human-check
- ✓ `<done>` — line 88: Observable outcome with resume-signal
- ✓ `<resume-signal>` — line 89: Gate instructions

All tasks complete and well-structured. ✅

### Dimension 3: Dependency Correctness

Wave assignment:
- 13-01: `wave: 1, depends_on: []` ✓
- 13-02: `wave: 1, depends_on: []` ✓ (can run parallel to 13-01; both implement independent aspects of the goal)
- 13-03: `wave: 2, depends_on: ["13-01", "13-02"]` ✓ (must run after both; it validates the combined result)

Wave calculation: 13-03 depends on two wave-1 plans, so wave = max(1) + 1 = 2. ✓

No circular dependencies. ✓  
No forward references. ✓

### Dimension 4: Key Links Planned

**13-01 key_links:**
1. From `runSlice` to `fetchAreaListings` via `Promise.allSettled(areaIds.map(...))` pattern
   - Verified in Task 1 action: "replace the sequential `for (const areaId of areaIds)` loop... with `const settled = await Promise.allSettled(areaIds.map((areaId) => fetchAreaListings(...)))`"
   - Acceptance criteria grep: `Promise.allSettled(` applied to `areaIds.map(`

2. From `fetchAreaPage` rungs to `runPlaywrightRender` via `opts.waitSecs = AREA_PAGE_WAIT_SECS`
   - Verified in Task 2 action: "both `fetchAreaPage` rungs... pass `{ waitSecs: AREA_PAGE_WAIT_SECS }`"
   - Acceptance criteria: grep shows both rungs updated, detail rungs unchanged

**13-02 key_links:**
1. From soft timer to `slow` state via `setSlow(true)` without terminal side-effects
   - Verified in Task 2 action: "a softTimeout firing at SOFT_THRESHOLD_MS that only does `if (!active) return; setSlow(true);` (NO clearInterval, NO onComplete)"
   - Pattern: "setSlow(true) without clearInterval / onComplete"

2. From poll() terminal branch to both timers cleared via dual `clearTimeout` calls
   - Verified in Task 2 action: "Extend the terminal-status branch to `clearTimeout(softTimeout); clearTimeout(hardTimeout); setSlow(false);`"
   - Acceptance criteria: "terminal-status branch and cleanup return each call clearTimeout for BOTH timers"

**13-03 integration:**
- From live discovery run to browser results page via poll+tick completing without forced reload
- Verified by human-check: "confirm the run progresses and reaches results... results render on their own. No forced reload should be required"

All critical wiring accounted for and tested. ✅

### Dimension 5: Scope Sanity

**13-01 Task Distribution:**
- Task 1 (Parallelize area loop): modifies `src/lib/discovery/job.ts` + test file — focused change
- Task 2 (Scoped waitSecs override): modifies `src/lib/booli/transport.ts`, `src/lib/booli/client.ts` + test files — focused change
- Files modified: 5 (2 source + 2 test + 1 transport) ✓

**13-02 Task Distribution:**
- Task 1 (Complete STATUS_LABELS): modifies `src/components/discovery-progress.tsx` + test file
- Task 2 (Two-tier timeout): same files as Task 1
- Files modified: 2 (1 source + 1 test) ✓

**13-03 Task Distribution:**
- Task 1 (Live smoke): no source changes (just calibration if needed)
- Files touched: 2 (for potential constant tuning only)

**Total scope:** 5 tasks, 7 source files (with overlaps). Each task is focused and achieves a specific goal. Task count (2+2+1) is well within the 2-3 per-plan guideline; 5 total is manageable. ✓

### Dimension 7: Context Compliance (LOCKED Constraints)

All 7 locked decisions from 13-CONTEXT.md are honored:

**D-01 (Parallelize areas in runSlice)**
- 13-01 Task 1 implements: "replace sequential for...of with Promise.allSettled(areaIds.map(fetchAreaListings))"
- ✓ Implemented

**D-02 (Cap per-page render retries / lower timeout — ADDITIVE)**
- 13-01 Task 2 implements: "extend runPlaywrightRender with optional opts param { waitSecs?, maxRequestRetries? } defaulting to 240/3"
- Action explicitly states: "Leave fetchListing's rungs... byte-for-byte unchanged"
- Acceptance criteria verify: "grep shows the fetchListing and sold-comps rungs still call runPlaywrightRender(...) with no third arg"
- ✓ Additive-only, non-breaking

**D-03 (Cost-cap race-free invariant — LOCKED)**
- 13-01 Task 1 explicitly preserves: "LOCKED invariants (D-03)... keep the cost pre-check at job.ts:161-167 exactly where it is, BEFORE the allSettled call... The loop stays pure in-memory aggregation with ZERO DB writes"
- Acceptance criteria: "cost pre-check still appears BEFORE Promise.allSettled; no .update(/.from("discovery_jobs") inside the per-area aggregation"
- Threat model T-13-01 (Tampering via race) is mitigated: "Preserve 'read from claimedRow, write once at the end' discipline... no per-area DB writes"
- ✓ Locked invariant preserved

**D-04 (Replace hard-fail with calm non-failing state)**
- 13-02 Task 2 implements: "replace single MAX_POLL_MS with SOFT_THRESHOLD_MS (soft notice, keep polling) + ABSOLUTE_CEILING_MS (hard fail)"
- Soft timer behavior: "a softTimeout... that only does setSlow(true); (NO clearInterval, NO onComplete — non-terminal)"
- Copy: "Det tar längre tid än väntat, fortsätter…"
- ✓ Implemented

**D-05 (Generous absolute safety ceiling)**
- 13-02 Task 2 defines: "const ABSOLUTE_CEILING_MS = 15 * 60_000;" (900_000ms = 15 minutes)
- Current ceiling is 5 minutes (300_000ms); new absolute is 3× higher ✓
- ✓ Implemented

**D-06 (Add vision_processing label)**
- 13-02 Task 1 implements: "add the single missing entry vision_processing: 'Analyserar bilder' to STATUS_LABELS"
- Acceptance criteria: "grep -c 'vision_processing: \"Analyserar bilder\"' returns 1"
- ✓ Implemented

**D-07 (Audit full status vocabulary, exhaustiveness)**
- 13-02 Task 1 implements: "Add const KNOWN_STATUSES = ['pending', 'processing', 'vision_processing', 'done', 'failed', 'degraded'] as const"
- Behavior: "exhaustiveness unit test... asserts each maps to a non-empty label"
- Acceptance criteria: "Exhaustiveness test passes: every KNOWN_STATUSES entry has a non-empty STATUS_LABELS value"
- ✓ Implemented

**Four specific constraints from plan_check_context:**

**(a) D-03: cost pre-check stays before Promise.allSettled + no per-area DB write + IDOR check untouched**
- ✓ Explicitly preserved in 13-01 Task 1: "keep the cost pre-check... BEFORE the allSettled call... no per-area DB write... do not touch tick-discovery.ts, the claim RPC, or the IDOR ownership pre-check"

**(b) D-02: transport param is ADDITIVE (existing call sites unchanged)**
- ✓ Explicitly verified in 13-01 Task 2: "grep shows the fetchListing and sold-comps rungs still call runPlaywrightRender(...) with no third arg"

**(c) discovery-progress-live.tsx correctly gets no change**
- ✓ Explicitly stated in 13-02 Task 2: "Do NOT touch discovery-progress-live.tsx (RESEARCH: thin wrapper, inherits this fix)"

**(d) STATUS_LABELS exhaustiveness over the 6 statuses**
- ✓ Explicitly implemented in 13-02 Task 1: "KNOWN_STATUSES = [...6 entries...]; exhaustiveness test passes"

All locked constraints honored. ✅

### Dimension 8: Nyquist Compliance

From 13-VALIDATION.md, Wave-0 test requirements:
1. Timing-based concurrency proof in job.test.ts (staggered mock delays, elapsed ≈ max not sum)
2. client.test.ts assertion that area-page rungs pass scoped waitSecs override while detail/broker fetches do not
3. discovery-progress.test.tsx: replace hard-fail timeout test with soft-notice + absolute-ceiling tests
4. discovery-progress.test.tsx: exhaustiveness test over 6 known status strings vs STATUS_LABELS
5. Framework install: NONE (Vitest, RTL, fake-timer utilities already present)

**Verification in plans:**

13-01 Task 1 includes Wave-0 concurrency timing proof:
- Action: "First (RED): add a new test to the existing describe(...) block... Run it and confirm it FAILS (elapsed ≈ sum). This is the Wave-0 concurrency-timing proof from 13-VALIDATION.md."
- Behavior: "two areas whose fetchAreaListings mocks resolve after staggered real delays... complete in ≈ max(60,20)ms, NOT ≈ 80ms. Assert measured elapsed is closer to the max than the sum"
- ✓ Wave-0 test included

13-01 Task 2 includes Wave-0 scoped-override assertion:
- Action: "First (RED): add a test to client.test.ts... This is the Wave-0 scoped-override assertion from 13-VALIDATION.md."
- Behavior: "when fetchAreaPage renders an area page, the mocked Apify actorCall receives { waitSecs: AREA_PAGE_WAIT_SECS }... Assert detail/broker paths still receive { waitSecs: 240 }"
- ✓ Wave-0 test included

13-02 Task 1 includes Wave-0 exhaustiveness test:
- Action: "First (RED): add two tests... (1) an exhaustiveness unit test... (the Wave-0 exhaustiveness test from 13-VALIDATION.md)"
- Behavior: "exhaustiveness unit test importing/enumerating the 6 known statuses and asserting each maps to a non-empty label"
- ✓ Wave-0 test included

13-02 Task 2 includes Wave-0 soft/hard timeout tests:
- Action: "First (RED): using this file's existing vi.useFakeTimers() pattern, add/replace tests... (the Wave-0 timeout tests from 13-VALIDATION.md)"
- Behavior: "(1) advance timers past SOFT_THRESHOLD_MS with a still-running row → assert soft banner shown, no onComplete, polling continues; (2) advance past ABSOLUTE_CEILING_MS still-running → assert onComplete('failed') once; (3) terminal status before soft threshold → no banner, no false failure"
- ✓ Wave-0 tests included

**Automated verify commands:**
- All have specific, runnable commands ✓
- No `--watchAll` flags ✓
- Feedback latency < 15s ✓

**Framework requirements:**
- Plans do not add any npm installs; all frameworks (Vitest, React Testing Library, fake-timers) already exist ✓

Nyquist compliance verified. ✅

### Dimension 11: Research Resolution

13-RESEARCH.md exists and is comprehensive. Section "Open Questions" (lines 338-349) lists two questions intentionally deferred for calibration:

1. **Exact AREA_PAGE_WAIT_SECS / retry-budget values for D-02**
   - Plans set initial value: `const AREA_PAGE_WAIT_SECS = 120;`
   - Plans note: "planner's discretion per RESEARCH.md Open Question #1 — start conservative, instrument the existing rung log line to tighten later"
   - Calibration: 13-03 live smoke will observe real Booli area-page render timing and confirm/adjust
   - ✓ Acceptable deferral (intentional, with calibration plan)

2. **Exact SOFT_THRESHOLD_MS / ABSOLUTE_CEILING_MS values for D-04/D-05**
   - Plans set initial values: `const SOFT_THRESHOLD_MS = 90_000;` and `const ABSOLUTE_CEILING_MS = 15 * 60_000;`
   - Plans note: "both tunable per RESEARCH.md Open Question #2 — soft near/just under the old 5-min feel, absolute 'well above' it; calibrated by the 13-03 live smoke"
   - Calibration: 13-03 live smoke will observe real completion time and confirm/adjust
   - ✓ Acceptable deferral (intentional, with calibration plan)

This is a healthy pattern: research identifies open questions, plans set conservative initial values, and the checkpoint phase (13-03) calibrates against real data before final lock-in. ✅

### Dimension 12: Pattern Compliance

13-PATTERNS.md exists and is comprehensive. Checking if plans correctly reference and implement patterns:

**13-01 Task 1 (Area-loop parallelization)**
- References 13-PATTERNS.md section "src/lib/discovery/job.ts — area-loop parallelization (D-01)" ✓
- PATTERNS.md provides exact analog from client.ts:719-736 (page-level Promise.allSettled)
- Plans correctly implement the target shape (lines 63-83 of PATTERNS.md):
  ```typescript
  const settled = await Promise.allSettled(
    areaIds.map((areaId) => fetchAreaListings(areaId, filters.objectType)),
  );
  ```
- ✓ Pattern correctly implemented

**13-01 Task 2 (Scoped waitSecs override)**
- References PATTERNS.md sections "transport.ts — scoped..." and "client.ts — fetchAreaPage scoped override..." ✓
- PATTERNS.md provides self-extension pattern for transport.ts (lines 117-136) and client.ts call-site example (lines 165-182)
- Plans correctly implement:
  - transport.ts: `opts?: { waitSecs?: number; maxRequestRetries?: number }` with defaults 240/3
  - client.ts: `const AREA_PAGE_WAIT_SECS = 120;` and both fetchAreaPage rungs pass `{ waitSecs: AREA_PAGE_WAIT_SECS }`
  - Preserved: fetchListing and sold-comps rungs unchanged (regression guard)
- ✓ Pattern correctly implemented

**13-02 Task 1 (Complete STATUS_LABELS)**
- References PATTERNS.md section "discovery-progress.tsx — ... complete STATUS_LABELS" ✓
- PATTERNS.md shows target shape (lines 210-220)
- Plans implement exactly as specified: add `vision_processing: "Analyserar bilder"` + `KNOWN_STATUSES` const with 6 entries
- ✓ Pattern correctly implemented

**13-02 Task 2 (Two-tier timeout)**
- References PATTERNS.md section "two-tier timeout..." ✓
- PATTERNS.md provides exact target shapes (lines 237-252 for timers, 254-264 for terminal-branch clearing, 266-274 for cleanup)
- Plans implement:
  - Two `setTimeout`s: `softTimeout` at SOFT_THRESHOLD_MS (sets `slow` state, non-terminal), `hardTimeout` at ABSOLUTE_CEILING_MS (sets `timedOut`, calls onComplete)
  - Terminal branch clears both timers and resets `slow`
  - Cleanup return clears both timers
  - Soft-notice banner with copy "Det tar längre tid än väntat, fortsätter…" in non-error tone
- ✓ Pattern correctly implemented

**Shared Patterns:**
- Promise.allSettled fulfilled/rejected aggregation: Plans use index-based loop (not for...of on values) to keep original array (`areaIds`) available for error logging ✓
- Additive-optional-parameter: Plans preserve all existing call sites byte-for-byte; new parameter defaults to old behavior ✓
- Client poll+tick state machine: Plans preserve `active`/`clearInterval`/`clearTimeout` discipline from BrfProgress model ✓
- Structured console.error logging: Plans log `{ jobId, areaId, code }` in rejection branches, never throw ✓

All patterns correctly referenced and implemented. ✅

---

## Issues Found: 0

**Status:** All dimensions PASS. No blockers, warnings, or notes.

---

## Confidence Assessment

- **Requirement coverage:** HIGH (explicit mapping of both DXUX-01 and DXUX-02)
- **Task completeness:** HIGH (all required fields present and specific)
- **Dependency correctness:** HIGH (wave assignment is correct; no cycles)
- **Key links:** HIGH (all wiring is explicit and testable)
- **Scope:** HIGH (well-distributed across 3 plans, each focused)
- **Locked constraints:** HIGH (all 7 decisions explicitly preserved; no scope reduction detected)
- **Wave-0 tests:** HIGH (all 4 required tests included in plans; automated verify commands are specific)
- **Pattern compliance:** HIGH (all analogs correctly referenced from 13-PATTERNS.md; implementation shapes match expected)

**Overall confidence:** VERY HIGH — these plans will deliver the phase goal.

---

## Recommendation

**Proceed to execution.** The plans are ready and complete. No revisions required.

The phase is well-structured:
- Wave 1 (13-01 + 13-02) is the main delivery, fully parallelizable
- Wave 2 (13-03) is the mandatory live calibration checkpoint that locks the three tunable constants after observing real behavior

All LOCKED constraints are honored, particularly D-03 (cost-cap race-free invariant), which is critical for financial integrity.
