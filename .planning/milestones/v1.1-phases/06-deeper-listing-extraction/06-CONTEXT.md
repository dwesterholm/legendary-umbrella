# Phase 6: Deeper Listing Extraction - Context

**Gathered:** 2026-07-06
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped via workflow.skip_discuss)

<domain>
## Phase Boundary

Recover the per-listing fields Booli lacks — floor/våning, balcony, BRF name, renovation status, full description — by following through to the broker's own page, filling gaps without ever overwriting Booli data.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — discuss phase was skipped per user setting. Use the ROADMAP phase goal, success criteria, approach notes, and codebase conventions to guide decisions.

Key constraints carried from the ROADMAP phase description (binding):
- Second, optional enrichment step appended to `analyzeUrl`; Booli fields are the base, broker-page fields fill gaps only, provenance preserved.
- New listing fields are additive `.nullable().optional()` (no migration; JSONB column).
- Broker-fetch failure is caught in its own try/catch and never fails the primary listing analysis (independent-degradation pattern).
- Broker contact PII (mäklare name/phone/email) is deliberately excluded from extraction and output.
- Spike FIRST: check whether detail-page Apollo state from the Phase-5 owned fetch already yields brfName/floor before parsing broker pages.

</decisions>

<code_context>
## Existing Code Insights

Codebase context will be gathered during plan-phase research (informational spike on broker-CMS coverage + Apollo-state field availability).

</code_context>

<specifics>
## Specific Ideas

No specific requirements — discuss phase skipped. Refer to ROADMAP phase description, approach notes, and success criteria (LSTG-03, LSTG-04).

</specifics>

<deferred>
## Deferred Ideas

None — discuss phase skipped.

</deferred>
