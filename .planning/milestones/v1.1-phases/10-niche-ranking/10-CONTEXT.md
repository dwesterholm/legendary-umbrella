# Phase 10: Niche Ranking - Context

**Gathered:** 2026-07-06
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped via workflow.skip_discuss)

<domain>
## Phase Boundary

Rank discovery candidates against the user's free-text intent via configurable niches (renovation-upside, turnkey, imminent-stambyte-where-BRF-pays), so results are ordered by fit rather than just filtered.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion (within ROADMAP constraints)
Discuss skipped. Binding constraints from the ROADMAP phase description:
- **Deterministic scoring on top of AI-extracted structured attributes** — consistent with the codebase's "deterministic score, LLM narrates" philosophy (BRF grading, report flags). NOT an opaque LLM score.
- The stambyte niche leans on Phase 2 BRF signals.
- Ranking is a FINAL PASS over the discovery job's candidates (extends Phase 9's job/results — additive).
- **Text-only signals** here; gallery/floor-plan vision come in Phases 11–12. Do not add image/vision work.
- Each candidate's rank must show the concrete, CITED signals that drove it (e.g. BRF stambyte indicator), never an opaque score.
- At least the three named niches (renovation-upside, turnkey, imminent-stambyte-where-BRF-pays) must produce DISTINGUISHABLE rankings for the same candidate set; ordering visibly changes when the niche changes.

### Discovery surface constraints (carried from Phase 9)
- This is part of the discovery surface, gated behind the `DISCOVERY_ENABLED` feature flag (OFF by default).
- Additive-nullable persistence; no new legal posture (uses the already-persisted candidate set, no new scraping).

</decisions>

<code_context>
## Existing Code Insights

Reuse: Phase 9 discovery candidate set + `discovery_jobs.results` (the ranked pass reads/reorders these), the "deterministic score, LLM narrates" pattern from `src/lib/brf/score.ts` + report flags, Phase 2 BRF signals for the stambyte niche, and the cited-signal presentation vocabulary from report-flags. Gathered further during plan-phase research.

</code_context>

<specifics>
## Specific Ideas

Requirement DISC-03. Three named niches: renovation-upside, turnkey, imminent-stambyte-where-BRF-pays. Ranking is deterministic over structured attributes; cited signals per candidate; niche is user-selectable and reorders visibly.

</specifics>

<deferred>
## Deferred Ideas

- Gallery/vision condition signals feeding ranking → Phase 11.
- Floor-plan / sun-path signals → Phase 12.

</deferred>
