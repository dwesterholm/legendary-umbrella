# Phase 8: BRF Auto-Fetch - Context

**Gathered:** 2026-07-06
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped via workflow.skip_discuss)

<domain>
## Phase Boundary

Auto-fetch a BRF's årsredovisning from Bolagsverket/Allabrf matched by organisationsnummer, surfacing org.nr + fiscal year for user confirmation — with manual PDF upload remaining the dependable fallback.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — discuss phase was skipped per user setting. Use the ROADMAP phase goal, success criteria, approach notes, and codebase conventions.

Binding constraints carried from the ROADMAP phase description:
- A new pre-step to `analyzeBrf`; both auto and manual paths call the SAME `runBrfExtraction()` helper (refactor the existing action's core out so the D-06 hash cache, cost-cap, and scoring pipeline aren't duplicated).
- Match by **organisationsnummer, not name-string** — if a high-confidence org.nr match isn't available, do NOT auto-fetch; fall through to manual upload rather than guessing.
- New transient `auto_fetching` status; additive nullable `brf_fetch_source` column.
- Prefer Bolagsverket's official API where coverage allows; treat Allabrf as a scraping-fragility fallback.
- Before the auto-fetched document is analyzed, the user confirms org.nr + fiscal year ("stämmer detta med din bostad?").
- Manual PDF upload path remains equally prominent and fully functional as the fallback.
- Additive-nullable migration only.

</decisions>

<code_context>
## Existing Code Insights

Codebase context gathered during plan-phase research. Reuses/refactors the existing `analyzeBrf` action + D-06 hash cache + cost-cap + BRF scoring pipeline; new Supabase migration for `auto_fetching` status + `brf_fetch_source` column. Depends on Phase 6's recovered `brfName`/organisationsnummer.

</code_context>

<specifics>
## Specific Ideas

No specific requirements — discuss skipped. Refer to ROADMAP phase description, approach notes, and success criteria (ENRICH-01, ENRICH-02). Spike: Bolagsverket access model + iXBRL format + Allabrf reliability + organisationsnummer resolution.

</specifics>

<deferred>
## Deferred Ideas

None — discuss phase skipped.

</deferred>
