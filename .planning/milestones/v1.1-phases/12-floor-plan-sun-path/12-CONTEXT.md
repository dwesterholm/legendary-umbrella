# Phase 12: Floor-Plan & Sun-Path - Context

**Gathered:** 2026-07-07
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped via workflow.skip_discuss)

<domain>
## Phase Boundary

Analyze the floor-plan image for remodel potential as an explicitly-hedged investigation-prompt, and show theoretical sun exposure by facade orientation/floor/season — both clearly labeled as advisory, never as verdicts.

</domain>

<decisions>
## Implementation Decisions

### Locked design constraints (from ROADMAP — binding)
- **Floor-plan = investigation-prompt ONLY.** Framed strictly as an investigation-prompt with an explicit "kräver konstruktör / väggutredning" disclaimer — NEVER a load-bearing or wall-removal verdict (not determinable from a 2D plan even by professionals). Image-cited, hedged.
- **Sun-path = theoretical/unobstructed.** Use `suncalc` (unobstructed-only), labeled "teoretisk solexponering, tar inte hänsyn till skuggning från omgivande byggnader". Show by facade orientation / floor / season.
- **Degrade, never guess:** if floor or orientation is unavailable or low-confidence (Phase 6 field), sun-path shows "ej tillgänglig" — do NOT guess orientation from the address.
- **Same presentation as Phase 11:** hedged, image-cited (floor-plan), structurally SEPARATE from deterministic flags — reuse Phase 11's vision section identity + "från bildtolkning" discipline; never fed into a numeric score/deterministic flag.
- **Cost discipline:** floor-plan is another vision pass — reuse Phase 11's two-pass + CAP_VISION_SEK_MAX budget (floor plan is already within the capped image set); cache per booliId.

### New dependency
- `suncalc` (sun position/times) is a NEW npm dependency → the Package Legitimacy Gate applies (verify like Phase 6's cheerio). Sun-path math is deterministic, no AI.

### Discovery-surface constraints (carried)
- Part of the discovery surface, gated behind `DISCOVERY_ENABLED` (OFF by default).
- Additive-nullable persistence; no new migration unless strictly required.

### Kill criterion
- If floor-plan analysis can't be hedged safely (repeat confidently-wrong load-bearing claims in validation), OMIT the floor-plan claim type; ship sun-path alone or defer both.

### Claude's Discretion
All other choices at Claude's discretion within these constraints and DISC-05/06 success criteria.

</decisions>

<code_context>
## Existing Code Insights

Reuse: Phase 11 vision infra (two-pass pipeline, image content blocks, citation schema, CAP_VISION_SEK_MAX, GalleryConditionVision section identity + structural separation), Phase 6 floor field, v1.0 latitude/longitude (for suncalc position). Orientation may NOT be reliably available (Phase 6 recovered floor/balcony/brfName/renovation/description, not facade orientation) — research to confirm; if absent, sun-path degrades to "ej tillgänglig". Gathered further during plan-phase research.

</code_context>

<specifics>
## Specific Ideas

Requirements DISC-05 (floor-plan investigation-prompt), DISC-06 (theoretical sun-path). Floor-plan disclaimer: "kräver konstruktör / väggutredning". Sun-path label: "teoretisk solexponering, tar inte hänsyn till skuggning från omgivande byggnader". By facade/floor/season.

</specifics>

<deferred>
## Deferred Ideas

- Obstructed/real sun-path (accounting for surrounding buildings) — out of scope; v1 is theoretical/unobstructed only.
- The live vision + validation run (real floor-plan images, flag ON) → operator UAT.

</deferred>
