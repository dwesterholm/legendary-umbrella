# Phase 11: Gallery Condition Vision - Context

**Gathered:** 2026-07-07
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped via workflow.skip_discuss)

<domain>
## Phase Boundary

Derive soft condition attributes (e.g. kitchen/bathroom dated vs modern, overall condition) from description + gallery images via vision — each claim cited to its source image, presented as hedged evidence, structurally separate from deterministic flags.

</domain>

<decisions>
## Implementation Decisions

### Locked design constraints (from ROADMAP — binding)
- **Structural separation:** Vision output lives in its OWN clearly-labeled section ("AI-bedömning av bilder — kan vara fel"), NEVER styled like a deterministic flag and NEVER fed into the numeric score / deterministic flag system. If a vision signal ever informs anything scored, it must carry a visible "från bildtolkning" marker.
- **Image citation (mandatory):** the extraction schema FORCES each claim to cite which image + what specifically was seen (extends the Phase 2/4 structured-output + citation pattern). No uncited vision claim.
- **Hedged language:** claims are hedged evidence ("köket verkar renoverat"), never verdicts.
- **Cost discipline (hard):** Haiku pre-filter → Sonnet only on promising candidates; cap images/listing (floor plan + 2–3 gallery, NOT the full gallery); per-search SEK/image cap checked incrementally; cache per `booliId`. Must stay under the <$100/mo budget posture.
- **PII/GDPR:** vision prompt explicitly IGNORES people and personal documents; no vision claim references a person or personal document visible in photos.
- **Validation gate (kill criterion):** validate on 20–30 real listings with manually-checked ground truth BEFORE shipping. If accuracy is too low to present even as hedged evidence, or per-search vision cost can't stay under the cap → CUT gallery vision, ship discovery with text ranking only.

### Discovery-surface constraints (carried)
- Part of the discovery surface, gated behind `DISCOVERY_ENABLED` (OFF by default).
- Additive-nullable persistence; reuse Phase 9 job infra + incremental cost caps; feed hedged signals alongside (not into) Phase 10 ranking.

### Anthropic API caveats (from project memory)
- Strict `output_config.format` 400s on too many nullable→union params / numeric constraints — keep the vision schema slim; run ONE live API smoke before relying on mocked tests (see [[anthropic-structured-output-limits]]).
- Use current models; determine exact model IDs from the existing codebase (Haiku for pre-filter / Sonnet for the deep pass, mirroring costSek/costSekSonnet).

### Claude's Discretion
All other choices at Claude's discretion within these constraints and DISC-04 success criteria.

</decisions>

<code_context>
## Existing Code Insights

Reuse: the Phase 2/4 structured-output + citation pattern (src/lib/brf/extract.ts, report flags citation shape), the Anthropic client + costSek/costSekSonnet cost gates, Phase 9 job infra + incremental per-slice caps, Phase 6 gallery data (image URLs), the "deterministic vs interpreted" separation already used to keep report sections distinct. Gathered further during plan-phase research.

</code_context>

<specifics>
## Specific Ideas

Requirement DISC-04. Attributes: kitchen/bathroom dated-vs-modern, overall condition. Images: floor plan + 2–3 gallery (not full gallery). Cache per booliId. Section label: "AI-bedömning av bilder — kan vara fel".

</specifics>

<deferred>
## Deferred Ideas

- Floor-plan remodel-potential + sun-path → Phase 12.
- The actual 20–30-listing live validation run (needs real images + labeled ground truth + flag ON) → operator UAT / validation gate.

</deferred>
