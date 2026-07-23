---
phase: 13-discovery-ux-poll-timeout-fix
verified: 2026-07-22T09:50:00Z
status: human_needed
score: 2/3 roadmap success criteria code-verified; 1/3 requires a live operator re-smoke
overrides_applied: 0
human_verification:
  - test: "Live-smoke re-run of the RESUME.md multi-area query from a non-Booli/Cloudflare-blocked IP (e.g. a deployed/staging environment, not the operator's local dev IP)"
    expected: "Job reaches a terminal status (done/failed/degraded) and DiscoveryResults renders WITHOUT the user reloading the page — badge visibly advances I kö -> Analyserar -> Analyserar bilder -> Klar; counter shows '0 av N' while running and snaps cleanly to 'N av N' only at done (never '350 av 25', never a backward jump); if the run is slow, the calm 'Det tar längre tid än väntat, fortsätter...' notice appears without a false Misslyckades/reload."
    why_human: "The 2026-07-19 live smoke (13-SMOKE-FINDINGS.md) ran against the pre-13-04/13-05 code and hit a local-IP Booli 403 block that prevented observing full in-window completion; the 13-04 (decoupled read, bounded detail-fetch) and 13-05 (counter fix) changes have only been unit/component-tested with mocked timers and mocked fetches since — no live re-run exists on the current code. Mocked tests cannot observe real Apify/Booli network latency, Cloudflare blocking, or true end-to-end wall-clock duration."
  - test: "Decide and close WR-02 (src/lib/discovery/job.ts:486-555, enrichCandidateImages) — the vision-enrichment detail-fetch loop is still a plain sequential for...of over up to VISION_ENRICH_LIMIT=8 candidates, each up to DETAIL_ENRICH_WAIT_SECS=90s x DETAIL_ENRICH_MAX_RETRIES=2 rungs (~180s worst case), i.e. up to ~1440s (24min) worst case for one tick — well past the ~300s TICK_DISCOVERY_MAX_DURATION_SEC Server Action ceiling this phase exists to respect. runVisionForJob's own doc comment already warns a Server Action timeout mid-write leaves the job stuck forever at vision_processing."
    expected: "Either a wall-clock budget inside enrichCandidateImages that stops enriching further candidates once a ceiling is hit (degrading gracefully, as the function already does for other failure modes), or bounded concurrency (Promise.allSettled in batches, mirroring runSlice's own area-level fix from this same phase) — operator decision on which, then implement + verify."
    why_human: "This is a design/scope decision (accept a bounded-degrade fallback vs. add concurrency) that code review (13-REVIEW.md WR-02) flagged but the phase's own plans (13-01 through 13-05) did not schedule a fix for — an explicit operator call on scope is needed before a plan can close it."
  - test: "Decide and close WR-03 (src/lib/discovery/job.ts:186-232) — Apify spend from an area whose Promise.allSettled outcome is 'rejected' (both own-render rungs exhausted) is never added to cost_sek_total; only fulfilled areas increment rendersUsed. Parallelizing areas (this phase's own D-01 change) means more areas can be attempted concurrently per tick than the old sequential loop allowed, so more silently-uncounted failed-rung spend can accumulate per job as multi-area queries get wider."
    expected: "At minimum, a distinguishable console.error log when anyThrew is true and raw.length > 0 so the true spend is auditable from logs even if not folded into cost_sek_total; ideally, attribute failed-rung renders to rendersUsed regardless of the area's overall fulfilled/rejected outcome."
    why_human: "Cost-cap fidelity is a real-money invariant (D-03 LOCKED) that predates this phase structurally but whose blast radius this phase's own concurrency change widens — an operator call on whether to fix now or accept the pre-existing gap is needed, not a code-inspection verdict."
---

# Phase 13: Discovery UX / Poll-Timeout Fix Verification Report

**Phase Goal:** The now-live discovery flow finishes within the user's patience window (no forced reload) and every job state shows a human-readable Swedish label — no forced reload, no raw enum leak.
**Verified:** 2026-07-22T09:50:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (Roadmap Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A realistic multi-area query (300+ listings + vision) reaches and displays results without a reload — server-side run finishes inside the client poll window | ? UNCERTAIN (human_needed) | Code delivers all the mechanisms (D-01 area parallelism, D-02 scoped area-page render, D-04/D-05 soft-notice+absolute-ceiling, 13-04 decoupled read, 13-04 bounded detail render, 13-05 counter fix) and the 2026-07-19 live smoke confirmed the soft-notice/no-forced-reload UX on the PRE-13-04/13-05 code. But (a) the smoke's own detail-page fetches were blocked by Booli/Cloudflare on the operator's local IP so full in-window COMPLETION was never actually observed end-to-end, and (b) 13-REVIEW.md WR-02 shows a real, unfixed worst-case path (sequential 8-candidate enrichment loop, up to ~24min) that can still exceed the ~300s Server Action ceiling this phase exists to respect. DXUX-01 is correctly still "Pending" in REQUIREMENTS.md — the phase's own artifacts self-report this is not yet closed. |
| 2 | Every job state (incl. `vision_processing`) shows a Swedish status label — no raw enum string ever appears on screen | ✓ VERIFIED | `STATUS_LABELS` (discovery-progress.tsx:65-72) has all 6 entries incl. `vision_processing: "Analyserar bilder"`; `KNOWN_STATUSES` exported (56-63) and an exhaustiveness test in discovery-progress.test.tsx enumerates it against `STATUS_LABELS` so a 7th status word fails loudly. `statusLabel()` (74-77) falls back to the raw string ONLY if a status is outside the known set — none currently is. Live-confirmed in the 2026-07-19 smoke (badge showed "Analyserar" / advancing labels, no raw enum). REQUIREMENTS.md marks DXUX-02 Complete. |
| 3 | A long run visibly progresses within the window (area work parallelized / partial results surfaced / per-page retries capped) rather than appearing to hang until a manual refresh | ✓ VERIFIED (code) / needs live re-confirmation | `runSlice`'s area loop is now `Promise.allSettled` (job.ts:186-188, D-01); `readStatus()` is decoupled from the guarded `dispatchTick()` (discovery-progress.tsx:163-236, 13-04) so the badge advances during a long tick instead of freezing (13-SMOKE-FINDINGS.md GAP-1, closed); `processed_count`-during-vision was tried (13-04) then correctly reverted (13-05) in favor of a monotonic clamped analyzed/found counter (candidate_count denominator) that cannot show "350 av 25" or jump backward — proven by dedicated regression tests. This closes both gaps the live smoke surfaced, but the closing code has ONLY been verified against mocked timers/fetches, never against a real run (see human-verification item 1). |

**Score:** 2/3 truths code-verified; 1/3 (the in-window completion claim itself) requires a live operator re-smoke that has not yet been run on the current code.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/lib/discovery/job.ts` (`runSlice`) | Areas scraped concurrently via `Promise.allSettled`, cost pre-check before the loop, single terminal write | ✓ VERIFIED | Confirmed at job.ts:178-232: `Promise.allSettled` at 186; cost pre-check documented as staying before it (per 13-REVIEW.md direct trace); one `updateJob` at the end. |
| `src/lib/booli/client.ts` (`AREA_PAGE_WAIT_SECS`, `DETAIL_ENRICH_WAIT_SECS`/`MAX_RETRIES`) | Scoped renders for area pages (120s) and vision-enrichment detail pages (90s/2 retries), distinct from the 240s/3-retry default | ✓ VERIFIED | Both constants exported and used at their respective call sites; `client.test.ts` asserts forwarding; `/analyze`'s `fetchListing` call site (`analyze.ts:70`) confirmed untouched (240s/3 default) by direct grep. |
| `src/components/discovery-progress.tsx` | Two-tier soft/hard timeout, complete `STATUS_LABELS`, decoupled read/dispatch, monotonic clamped counter, ordering guard on stale reads, `onComplete` survives re-renders | ✓ VERIFIED | All present and read directly: `SOFT_THRESHOLD_MS`/`ABSOLUTE_CEILING_MS` (36-45), `STATUS_LABELS`/`KNOWN_STATUSES` (56-72), `readStatus()`/`dispatchTick()` split (163-236) with `latestRequestId` staleness guard (161,165,173) and a `.catch`-equivalent try/catch around `tickDiscovery` (212-230), `onCompleteRef` pattern (115-128) decoupling timer identity from `onComplete` reference equality. |
| `src/lib/discovery/job.ts` (`enrichCandidateImages`) | Vision-enrichment detail fetch bounded so it cannot stall a job past the Server Action ceiling | ⚠️ PARTIAL | `fetchListing` calls are bounded per-attempt (90s/2 retries, ~180s worst case per candidate) but the loop over up to 8 candidates is still a plain sequential `for...of` (job.ts:497) with no total wall-clock budget or batched concurrency — worst case ~24min, still exceeding the ~300s ceiling this phase targets (13-REVIEW.md WR-02, unaddressed). |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `discovery-progress.tsx` poll loop | `discovery_jobs` table | Supabase `.select(...).eq("id", jobId).single()` in `readStatus()` | WIRED | Runs unconditionally every `POLL_MS`, independent of the tick dispatch; drives `status`/`candidateCount`/`capReached`/`analyzed` state. |
| `discovery-progress.tsx` dispatch | `tickDiscovery` Server Action | `await tickDiscovery(jobId)` inside `dispatchTick()`, `inFlight`-guarded | WIRED | Guard prevents overlapping dispatches; failure path now logs (WR-04 fix) rather than silently rejecting. |
| `runSlice` | `fetchAreaListings` (per area) | `Promise.allSettled(areaIds.map(...))` | WIRED | Fulfilled results aggregated into candidates + `rendersUsed`; rejected results logged and folded into `anyThrew`. |
| `enrichCandidateImages` | `fetchListing` (detail page) | direct `await fetchListing(url, { waitSecs, maxRequestRetries })` | WIRED (bounded) | Bounded per-call, but the caller loop itself is unbounded in aggregate (see WR-02 above). |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|--------------|--------|----------|
| DXUX-01 | 13-01, 13-02, 13-04, 13-05 | Multi-area discovery job completes in-window, no forced reload | ? NEEDS HUMAN | Correctly still "Pending" in REQUIREMENTS.md. Code delivers the mechanisms; the live-smoke evidence predates the latest fixes and the operator's own local IP was Booli-blocked, so end-to-end in-window completion is unconfirmed on current code. WR-02's unbounded worst case is a real, currently-unmitigated risk to this exact requirement. |
| DXUX-02 | 13-02 | Swedish label for every job state, no raw enum leak | ✓ SATISFIED | `STATUS_LABELS` complete + exhaustiveness test + live-confirmed in the smoke. REQUIREMENTS.md marks Complete — consistent with code and live evidence. |

No orphaned requirements — DXUX-01/DXUX-02 are the only two mapped to Phase 13 in REQUIREMENTS.md and both appear in plan frontmatter.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` markers found in any of the 6 phase-modified files (`job.ts`, `job.test.ts`, `transport.ts`, `client.ts`, `client.test.ts`, `discovery-progress.tsx`) | — | none | Clean. |
| `src/lib/discovery/job.ts` | 486-555 | Sequential loop with an unbounded aggregate worst-case duration (WR-02, code-review-identified, not a debt marker) | ⚠️ Warning | Real reliability risk to DXUX-01's own success criterion; not blocking (typical case with a healthy IP completes well within bounds per the smoke), but the pathological case is real and currently unmitigated. |
| `src/lib/discovery/job.ts` | 186-232 | Failed-rung Apify spend never folded into `cost_sek_total` (WR-03, pre-existing pattern, blast radius widened by this phase's own area-parallelism change) | ⚠️ Warning | Cost-cap invariant fidelity gap, real-money implication under the D-03 LOCKED invariant — not a correctness regression introduced by this phase, but this phase's own change (more concurrent areas) makes it worse. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full test suite green | `npm run test` | 748 passed, 3 skipped (60 files) | ✓ PASS (matches SUMMARY claim) |
| Typecheck clean | `npx tsc --noEmit` | No output, exit clean | ✓ PASS (matches SUMMARY claim) |
| Lint clean | `npm run lint` | No output, exit clean | ✓ PASS (matches SUMMARY claim) |
| Targeted phase-13 suite | `npx vitest run src/lib/discovery/job.test.ts src/components/discovery-progress.test.tsx src/lib/booli/client.test.ts` | 111 passed (3 files) | ✓ PASS |
| Live end-to-end completion (real Apify/Booli/Anthropic, current code) | — | Not run by this verifier (would incur real spend + requires a non-Booli-blocked IP) | ? SKIP — routed to Human Verification |

### Human Verification Required

See frontmatter `human_verification` for the full detail. Summary:

1. **Operator live-smoke re-run** of the RESUME.md multi-area query ("Renoveringsobjekt i Södermalm och Vasastan under 4 miljoner") from an IP not blocked by Booli/Cloudflare, on the CURRENT code (post-13-04/13-05), to confirm true in-window completion, correct badge advancement, and the fixed counter semantics. This is the load-bearing gate for DXUX-01.
2. **WR-02 scope decision**: the vision-enrichment detail-fetch loop's worst case (~24min for 8 sequential candidates) still exceeds the ~300s Server Action ceiling. Needs an operator call on wall-clock-budget vs. bounded-concurrency, then a follow-up plan.
3. **WR-03 scope decision**: failed-rung Apify spend is silently under-counted against `cost_sek_total`; blast radius widened by this phase's own area-parallelism change. Needs an operator call on whether to log-only or fully attribute.

### Gaps Summary

No code artifact is missing, stubbed, or unwired — every mechanism the phase's plans (13-01, 13-02, 13-04, 13-05) committed to is present, tested, and grep-verified in the source, and the DXUX-02 half of the phase goal is fully closed (code + live-confirmed). The gap is specifically that DXUX-01's own success criterion ("finishes within the client poll window") cannot be honestly marked passed from static/mocked evidence alone: the only live evidence available predates the fixes meant to close it, was itself compromised by an environmental IP block before reaching full completion, and code review (13-REVIEW.md) found a real, currently-unpatched worst-case path (WR-02) that can still blow the window. This is a live-validation gap, not a code gap — consistent with REQUIREMENTS.md and STATE.md both independently already marking DXUX-01 "Pending" and calling for an operator re-smoke before this phase can be considered fully proven. Per the escalation-gate pattern, this is surfaced as `human_needed`, not fabricated as a pass and not misclassified as a code `gaps_found` blocker.

---

_Verified: 2026-07-22T09:50:00Z_
_Verifier: Claude (gsd-verifier)_
