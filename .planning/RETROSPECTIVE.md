# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — MVP

**Shipped:** 2026-07-06
**Phases:** 4 | **Plans:** 21 | **Tasks:** 36 | **LOC:** ~11.5k TS/TSX | **Timeline:** 2026-02-24 → 2026-07-06

### What Was Built
- Paste-a-Booli-URL → structured listing analysis (Apify scrape + Zod validation), auth + dashboard (Phase 1).
- BRF årsredovisning PDF upload → Haiku extraction → deterministic A–F health score with transparent, published methodology (Phase 2).
- Market context: Booli slutpriser price comparison (via Apify Playwright, after clearing a Cloudflare blocker) + SCB DeSO demographics, with honest dead/thin/missing states (Phase 3).
- Sonnet cross-source AI report ("vad du bör tänka på") with deterministic red/green flags, no buy/sell verdict, every claim cited, plus å/ä/ö-correct PDF export (Phase 4).

### What Worked
- **Deterministic-core / LLM-synthesis split.** Flags and the A–F score live in pure TS with golden tests; the LLM only narrates. No model-minted flags, no verdict (schema-unrepresentable), reproducible output. This held up cleanly across the audit.
- **Read-path Zod guards (CR-01).** `safeParse` on every persisted JSONB read meant most shape drift degraded gracefully instead of crashing — and made the retroactive verification straightforward.
- **Honest degrade states.** Explicit source_unavailable / thin / partial discriminators (not silent nulls) paid off in the partial-data UAT.

### What Was Inefficient
- **Deferring live verification bit back hard.** Phase 4's synthesis/extraction were unit-tested with the Anthropic call **mocked**, and the live UAT + extraction eval were deferred. Three real blockers (BRF strict-grammar schema, report-lock PostgREST NULL trap, read-path flag schema) only surfaced during the eventual browser UAT — long after "code complete."
- **Phase 1 shipped without VERIFICATION.md/VALIDATION.md**, leaving a verification gap the milestone audit had to reconcile retroactively.
- **Milestone-close tooling fought the backlog.** `milestone.complete` counts 999.x backlog phases as "unstarted" and its `--force` misparsed the version arg — worked around by temporarily stripping the Backlog section, archiving, then re-appending.

### Patterns Established
- **PostgREST NULL is a recurring landmine.** `.eq(col, null)` AND `.neq(col, 'x')` both silently match ZERO rows when the column is NULL — use `.is(null)` / `.or(col.is.null,...)`. Bit the report lock twice.
- **Anthropic strict structured output has hard limits** — too many nullable→union params or numeric constraints 400 with "grammar too large" / "too many union types." Send a slimmed Claude-facing schema, map back to canonical in TS.
- **Mocked-LLM unit tests cannot catch provider-shape or DB-semantics bugs.** Every LLM/DB-boundary feature needs at least one live smoke or integration test.
- **Next.js Server Actions default to a 1 MB body cap** — real PDFs 413 before the action runs; raise `serverActions.bodySizeLimit` (Vercel still caps ~4.5 MB → needs client-direct upload before deploy).

### Key Lessons
1. Run the live UAT (and one live API smoke) at phase end, not "later" — deferral turns small schema bugs into end-of-milestone blockers.
2. Write VERIFICATION.md + VALIDATION.md as the phase completes; retroactive reconstruction is more expensive and leaves audit gaps.
3. Encode "no verdict / cited claims / deterministic flags" as schema + pure functions, not prompt instructions — it survives audits and model drift.

### Cost Observations
- Model mix (this milestone's tooling): planning heavy on Opus, execution/verification on Sonnet, integration checker on Haiku (adaptive profile adopted late in the milestone).
- Notable: the three Phase 4 blockers were each ~1 targeted fix + regression test once reproduced live — cheap to fix, expensive to *find* late.

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Phases | Plans | Key Change |
|-----------|--------|-------|------------|
| v1.0 | 4 | 21 | Baseline: GSD phase chain established; adopted adaptive model profile + per-phase branching at milestone close |

### Cumulative Quality

| Milestone | Tests | Phases Verified | Notable Debt |
|-----------|-------|-----------------|--------------|
| v1.0 | 175 passing | 4/4 | Phase 1/3 Nyquist partial; Phase 4 live extraction eval deferred; no live LLM/DB smoke tests yet |

### Top Lessons (Verified Across Milestones)

1. (v1.0) Live-boundary bugs (LLM provider shape, PostgREST NULL semantics) escape mocked unit tests — verify live at phase end.
