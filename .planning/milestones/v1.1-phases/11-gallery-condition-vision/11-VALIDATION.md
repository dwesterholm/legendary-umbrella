---
phase: 11
slug: gallery-condition-vision
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-07
---

# Phase 11 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing) + jsdom component tests + evals/ (RUN_LLM_EVALS-gated) |
| **Config file** | vitest.config.ts (existing) |
| **Quick run command** | `npx vitest run <changed-test-file>` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~45 seconds (excludes RUN_LLM_EVALS live eval) |

---

## Sampling Rate

- **After every task commit:** Run the quick command for the changed test file
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 45 seconds

---

## Per-Task Verification Map

*Populated by the planner from RESEARCH.md Validation Architecture. Every task addressing DISC-04 must carry an automated verify command or a Wave 0 dependency.*

| Task ID | Plan | Wave | Requirement | Behavior | Test Type | Automated Command | Status |
|---------|------|------|-------------|----------|-----------|-------------------|--------|
| TBD | TBD | 0 | DISC-04 | [SPIKE] Apollo `images(` ref shape probe (live render) → imageUrls extractor | manual/probe | operator-approved live-render probe + fixture test | ⬜ pending |
| TBD | TBD | TBD | DISC-04 | vision result stored + rendered SEPARATE from deterministic flags; every claim image-cited; hedged | unit/component | `npx vitest run` | ⬜ pending |
| TBD | TBD | TBD | DISC-04 | Haiku pre-filter → Sonnet deep pass; CAP_VISION_SEK_MAX=10 fires incrementally; PII ignored | unit (mocked SDK) | `npx vitest run` | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] **[SPIKE]** Live Apollo-ref probe to pin the `images(` shape → build `imageUrls` extractor (small operator-approved Apify spend; same technique as Phase 5/6/9). `thumbnailUrl` is currently dead — this unblocks the whole vision path.
- [ ] Vision two-pass pipeline (Haiku pre-filter → Sonnet deep pass), image content blocks + messages.parse + slim zodOutputFormat citation schema (avoid the output_config.format 400 trap) — mocked-SDK unit tests + ONE live API smoke
- [ ] Image-citation schema: every claim cites image index + what was seen; no uncited claim; hedged language enforced
- [ ] `CAP_VISION_SEK_MAX=10` separate from Phase 9 `CAP_SEK_MAX`; incremental per-slice enforcement; per-listing image cap (floor plan + 2–3 gallery)
- [ ] Structural separation: vision result persisted (additive-nullable, no migration) + rendered in its own section, never fed into numeric score/deterministic flags without a "från bildtolkning" marker
- [ ] PII-ignore vision prompt (ignore people/personal documents) — assertion test on the prompt + schema
- [ ] Eval harness (RUN_LLM_EVALS-gated, mirrors evals/extractor.eval.ts) with the accuracy/citation/hallucination rubric — buildable now; the 20–30-listing RUN is operator-deferred

*Planner refines exact test file paths against RESEARCH.md Wave 0 + Evaluation Strategy sections.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| **20–30-listing accuracy validation gate (KILL CRITERION)** | DISC-04 | Requires real listings + real vision API spend + manually-checked ground truth (flag ON) | Run the eval harness on 20–30 real listings with labeled ground truth. Rubric: directional accuracy ≥70%, citation validity ≥90%, **zero hallucination = 100% hard gate**. If accuracy too low to present even as hedged evidence, or per-search vision cost can't stay under CAP_VISION_SEK_MAX → CUT gallery vision, ship discovery with text ranking only. |
| Live vision render on a real candidate | DISC-04 | Running app + flag ON + real gallery | Confirm the "AI-bedömning av bilder — kan vara fel" section renders hedged, image-cited claims, visually distinct from deterministic flags, no PII references, cost cap honored |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (incl. the Apollo-images probe)
- [ ] No watch-mode flags
- [ ] Feedback latency < 45s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
