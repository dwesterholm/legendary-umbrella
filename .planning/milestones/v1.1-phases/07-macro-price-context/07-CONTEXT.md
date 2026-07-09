# Phase 7: Macro Price Context - Context

**Gathered:** 2026-07-06
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped via workflow.skip_discuss)

<domain>
## Phase Boundary

Add current macro indicators (Riksbank policy rate, inflation, regional price-index trend) to the market-context layer as a strictly-descriptive, clearly-labeled section — never a prediction or verdict.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — discuss phase was skipped per user setting. Use the ROADMAP phase goal, success criteria, approach notes, and codebase conventions.

Binding constraints carried from the ROADMAP phase description:
- New shared `macro_snapshots` table (time-keyed cache across ALL analyses, not per-analysis), lazy-fetch-with-TTL — a fourth independent branch in `enrichMarketContext`.
- Riksbank SWEA API is keyless; SCB PxWebApi v1 works but sunsets end-2026/early-2027 → put new macro tables behind a thin `buildPxWebQuery` abstraction.
- Bake the no-prediction constraint into the schema (no direction/magnitude field can exist), mirroring existing no-verdict enforcement; add an explicit negative constraint to the synthesis prompt; add a banned-predictive-phrase regression test.
- Independent-degradation: when a macro source is unavailable, that indicator degrades to "ej tillgänglig" without blanking price or area data.
- Additive-nullable / new-table migration only (no destructive changes).

</decisions>

<code_context>
## Existing Code Insights

Codebase context gathered during plan-phase research. Reuses `enrichMarketContext`'s independent-branch pattern; new Supabase migration for `macro_snapshots`.

</code_context>

<specifics>
## Specific Ideas

No specific requirements — discuss skipped. Refer to ROADMAP phase description, approach notes, and success criteria (MACRO-01, MACRO-02).

</specifics>

<deferred>
## Deferred Ideas

None — discuss phase skipped.

</deferred>
