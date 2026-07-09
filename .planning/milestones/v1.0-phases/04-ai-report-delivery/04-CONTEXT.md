# Phase 4: AI Report + Delivery - Context

**Gathered:** 2026-06-23
**Status:** Ready for planning

<domain>
## Phase Boundary

User receives a complete, opinionated AI analysis that combines all four data sources — listing data (Phase 1), BRF financial health (Phase 2), price comparison (Phase 3, PRICE-01), and area statistics (Phase 3, AREA-01) — into one coherent "second opinion." This phase replaces the final `<ComingSoonSection title="AI Rapport" />` placeholder on the analysis page (`page.tsx:86`, and the home page `src/app/page.tsx:54`).

**In scope:**
- **RPRT-01** — AI-synthesized "vad du bör tänka på" summary: opinionated, cross-source, references specific data points.
- **RPRT-02** — red/green risk flags (high BRF debt, planned stambyte, avgiftshöjning, unusual pricing), surfaced as a hybrid of deterministic code rules + structured soft signals.
- **RPRT-03** — download the complete analysis as a PDF.
- The extension of the Phase 2 BRF extraction needed to capture structured soft signals (stambyte-planned, renovations, notable remarks) for flagging.
- The end-to-end **integration / cohesion** of summary + flags + PDF into the existing analysis page (this is a phase requirement, not a polish item — see overarching principle in `<decisions>`).

**Out of scope (other phases / v2 / backlog):**
- Public shareable report links (decided PDF-download-only for v1).
- Stripe payment / paid tiers (149/analys, 349/månad) — v1.1.
- Forward-looking BRF risk modelling (interest-rate stress, refinancing risk, maintenance-cycle prediction) — backlog 999.4 / ADV-01/02. Phase 4 flags only what is already extractable, not predictive risk.
- Custom valuation / price prediction — explicitly Out of Scope per PROJECT.md.
- BRÅ crime / Skolverket schools — v2 (ENRICH-02/03).

**Depends on:** Phase 2 (BRF) and Phase 3 (market context). The report degrades gracefully when either is absent (see D-07/D-08).

</domain>

<decisions>
## Implementation Decisions

### Overarching principle — ONE integrated experience (locked by user)
- **D-00 (cohesion is a requirement):** Phase 4 must NOT read as three bolt-on features stacked beneath the existing cards. It is the moment the whole analysis becomes one coherent second opinion. Concretely:
  - The **AI summary is connective tissue**, not just another card — its lead synthesis is the cross-source thread tying listing + BRF + price + area together. Placement should make it read as the lead or capstone of the page (exact placement is Claude's discretion, but cohesion is the goal).
  - **Flags are the visible surface of signals that already live in the BRF score / price / area cards** — same data speaking, same warm visual language (sage/terracotta) and the same D-09 trust treatment. Not a disconnected widget.
  - The **PDF is the same experience made portable** — one document, same voice and section ordering, not a re-skinned data dump.
  - **One consistent trust posture end-to-end:** same "ej finansiell rådgivning" disclaimer, same source/freshness labels, same "Osäker / Ej tillgänglig" honesty on screen and in the PDF.
  - Downstream agents should treat page cohesion as an acceptance dimension, not a nice-to-have.

### Risk flags — RPRT-02
- **D-01 (hybrid derivation):** Flags are a **hybrid** of (a) **deterministic numeric flags computed in code** from already-extracted data (skuld/kvm, avgiftsnivå, kassaflöde, price ±% vs area snitt, etc.) — fully reproducible, listable on a public "Så flaggar vi" page in the D-09 spirit — and (b) **soft signals** captured as structured fields (see D-02). Claude never invents flags from thin air.
- **D-02 (soft signals via extended Phase 2 extraction):** The soft textual signals (planned **stambyte**, recent/planned renovations, notable remarks) are captured by **extending the existing Phase 2 BRF extraction** (`src/lib/brf/extract.ts` + `src/lib/schemas/brf.ts` + `src/lib/brf/prompt.ts`) into new structured, **cited** fields — reusing the established extraction + per-field citation (D-11) + confidence (D-10) pipeline. They are NOT mined by a separate free-text pass at synthesis time. NOTE: this touches Phase 2 code/schema — planner must account for a schema/migration change and a prompt-version bump (`BRF_EXTRACTION_PROMPT_VERSION`) + promptfoo eval update per the Phase 2 AI-SPEC discipline.
- **D-03 (raise vs narrate — Claude's discretion):** Numeric flags are raised deterministically in code. Whether the **soft** structured signals are raised by code (boolean → flag) or by Claude with context (e.g. "high debt is expected for a new build") is **deferred to research/planning**, decided by how clean the extended-extraction fields turn out. Either way, soft flags must carry their citation and confidence, and the Claude summary narrates/prioritizes flags — it does not originate them.

### Report voice & structure — RPRT-01
- **D-04 (opinionated, no verdict):** The "vad du bör tänka på" summary takes a clear stance on what matters and how concerning each thing is, and prioritizes the buyer's attention — but stops short of a buy / don't-buy verdict. This keeps it genuinely useful (satisfies "opinionated assessment", Success Criterion 1) while staying inside the **"ej finansiell rådgivning"** line (PROJECT.md / D-09).
- **D-05 (structure = lead synthesis + themed sections):** Open with a 1–2 sentence **cross-source synthesis** that connects the dots the individual cards cannot (e.g. "Priset ligger 8 % över området och BRF:en har hög skuld — premien är svårare att motivera"). Then **themed sections (Ekonomi / Pris / Område)** that add the "vad det betyder för dig" interpretation per theme rather than restating the raw numbers already shown in the cards.
- **D-06 (cite specific data — Criterion 4):** Every claim references a specific data point from the analysis (a number, a flag, a comp) — not generic advice. This is what the lead-synthesis + interpretation structure is designed to guarantee.

### Trigger, partial data, staleness, gate — RPRT-01
- **D-07 (manual, partial-aware trigger):** A user-initiated **"Generera AI-rapport"** button (not auto-generation). It generates from **whatever data exists**, clearly stating which sources were missing and how that limits the assessment — consistent with the partial-data tolerance across Phases 1–3 (D-08 Phase 3). The user controls the expensive Claude synthesis call.
- **D-08 (mark-stale + regenerate):** When underlying data changes after a report is generated — a BRF field corrected (Phase 2 D-12), a PDF uploaded later, market data enriched — keep the existing report but show a **"Rapporten bygger på äldre data — uppdatera"** marker and let the user regenerate with one click. No silent auto-refire of the Claude call; honest about freshness (D-09 spirit).
- **D-09 (login-only gate):** Report generation is **login-only**, same as BRF analysis (Phase 2 D-05), to protect the priciest Claude call and drive signup. Guests see the AI Rapport section as a teaser ("Logga in för AI-rapport"). Paid tiers are v1.1; login is the v1 gate.

### Delivery / PDF — RPRT-03
- **D-10 (PDF download only):** "Download and share" = a **"Ladda ner PDF"** button producing a file the user saves/shares themselves. **No public shareable link** in v1 (no hosting, no RLS/token design, no privacy surface over a 4M SEK analysis).
- **D-11 (full-analysis content):** The PDF contains the **complete report** — listing summary, BRF score + breakdown, price comparison, area stats, all flags, and the AI summary — a standalone keepable document mirroring the on-screen experience (per D-00 cohesion).
- **D-12 (trust carried into PDF):** The PDF carries the same D-09 trust treatment — "ej finansiell rådgivning" disclaimer, source + freshness labels, and the same "Osäker / Ej tillgänglig" honest markers.

### Claude's Discretion
- **D-03** soft-flag raise mechanism (code vs AI-with-context) — pending field-cleanliness assessment in research/planning.
- Exact on-page placement of the summary (lead vs capstone) and the visual integration of flags into the existing cards — subject to the D-00 cohesion goal.
- **PDF generation mechanism** — no PDF dependency exists yet; print CSS vs a render library (e.g. react-pdf) vs serverless PDF, with Vercel/Next serverless + cost implications. A research directive.
- **Model tiering for synthesis** — Phase 2 AI-SPEC planned Haiku-extract / Sonnet-synthesize; the report is synthesis, so a more capable model is likely. Confirm in research alongside a per-report cost guard (reuse the Phase 2 cost-tracking pattern).
- Regeneration UX details (button states, stale-marker styling).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project planning
- `.planning/PROJECT.md` — Core value ("second opinion on a 4M SEK decision"); constraints (solo dev 5–10h/wk, <$100/month infra, legal caution / "ej finansiell rådgivning"); pricing is v1.1; custom valuation is Out of Scope.
- `.planning/REQUIREMENTS.md` — RPRT-01/02/03 definitions; ADV-01/02 (interest-rate stress, avgiftshöjning prediction) and ENRICH-02/03 (BRÅ/Skolverket) are v2.
- `.planning/ROADMAP.md` § Phase 4 — Goal + 4 success criteria (synthesized opinionated summary; labeled red/green flags; downloadable/shareable PDF; references specific data points). Also § Backlog 999.4 — confirms forward-looking BRF risk modelling is explicitly deferred, NOT this phase.
- `.planning/v1.0-MILESTONE-AUDIT.md` — confirms RPRT-01/02/03 currently unsatisfied (only the placeholder exists); notes a Phase-1 integration WARNING (dashboard `as unknown as ListingData` bypasses the Zod guard) and the in-session BRF reload-prompt warning — relevant context, not Phase 4 scope.

### AI integration discipline (reuse from Phase 2)
- `.planning/phases/02-brf-financial-analysis/02-AI-SPEC.md` — eval strategy, model tiering (Haiku extract / Sonnet synthesize), prompt-versioning + promptfoo discipline, cost budget (<5 SEK/analysis). The synthesis call and the extended-extraction change must follow this discipline. **Recommend running `/gsd-ai-integration-phase 4` before planning** to produce a Phase 4 AI-SPEC.md for the synthesis + extended-extraction evals (config `workflow.ai_integration` is currently unset — was used in Phase 2).
- `.planning/research/SUMMARY.md` + `.planning/research/PITFALLS.md` — hallucination mitigation (separate extraction from judgment), sanity checks, model tiering, cost discipline.

### Prior phase context (decisions this phase builds on)
- `.planning/phases/02-brf-financial-analysis/02-CONTEXT.md` — D-05 (login-only gate), D-08 (deterministic-in-code scoring), D-09 ("Så räknar vi" transparency page), D-10 (confidence), D-11 (source quotes / citations), D-12 (inline correction → recompute). The flag/trust/gate patterns Phase 4 inherits.
- `.planning/phases/03-market-context/03-CONTEXT.md` — D-08 (partial result, honest markers, never fabricate), D-09 (source+freshness labels, "ej värdering" disclaimer, confidence signal). The price/area data Phase 4 synthesizes.

### Code reality (what Phase 4 reads and extends)
- `src/app/(app)/analysis/[id]/page.tsx` — the analysis page; `safeParse` discipline for `listing_data`/`brf_data`/`price_data`/`area_data`; the `<ComingSoonSection title="AI Rapport" />` placeholder Phase 4 replaces; `isGuest`/`brf_status`/`market_status` already wired.
- `src/lib/brf/extract.ts`, `src/lib/brf/prompt.ts`, `src/lib/schemas/brf.ts` — the extraction call + versioned prompt + schema to **extend** for the soft signals (D-02).
- `src/lib/brf/score.ts`, `src/lib/brf/sanity.ts`, `src/lib/brf/cost.ts` — deterministic scoring, sanity bands, and the cost-tracking pattern to reuse for the synthesis call's cost guard.
- `src/lib/market/compare.ts`, `src/lib/market/scb-schema.ts`, `src/lib/market/sold-schema.ts` — the price/area structured data feeding flags + synthesis.
- `src/actions/analyze-brf.ts`, `src/actions/enrich-market-context.ts` — the server-action pattern (auth/ownership → fetch/compute → persist) to mirror for `generateReport`.
- `src/components/brf-score-card.tsx`, `src/components/price-comparison-card.tsx`, `src/components/area-stats-card.tsx`, `src/components/market-context-section.tsx`, `src/components/coming-soon-section.tsx` — the cards Phase 4 must integrate with (D-00) and the placeholder it replaces.

### External (verify in research)
- Anthropic SDK (`@anthropic-ai/sdk` ^0.102.0, already installed) — synthesis model selection + cost; structured-output helpers already used in `extract.ts`.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/components/coming-soon-section.tsx` — the "AI Rapport" placeholder Phase 4 replaces with the real summary + flags surface.
- `src/components/brf-score-card.tsx` — established visual language for value + mini-rating + confidence badge + expandable source reveal; the closest analog for flag presentation + D-09 trust treatment.
- `src/lib/brf/extract.ts` + `prompt.ts` + `schemas/brf.ts` — the extraction + citation + confidence pipeline to extend for soft signals (D-02); module-scope Anthropic client reading a server-only key, coded errors, versioned prompt.
- `src/lib/brf/cost.ts` (+ `market/cost.ts`) — `ClaudeUsage` cost-tracking pattern to reuse for the synthesis call's per-report cost guard.
- `src/actions/analyze-brf.ts` / `enrich-market-context.ts` — server-action shape (auth + ownership → external/compute → independent persist) for the new `generateReport` action.
- `src/lib/schemas/*` — Zod v4 (`zod/v4`) null-tolerant `safeParse` discipline; replicate for the report's persisted shape.

### Established Patterns
- Swedish UI / English code; partial-data tolerance ("Ej tillgänglig" / "Osäker"); warm sage/terracotta palette; light mode only.
- Deterministic-in-code where possible (Phase 2 D-08) — numeric flags are arithmetic, not LLM output.
- Persisted external/AI results re-validated via `safeParse` on the analysis page before render (degrade to a safe affordance, never crash).
- `serverExternalPackages` in `next.config.ts` for packages with dynamic requires — check if a PDF library needs it.
- Prompt-version bump + promptfoo eval on any prompt change (Phase 2 AI-SPEC) — applies to both the synthesis prompt and the extended-extraction prompt.

### Integration Points
- Analysis page `src/app/(app)/analysis/[id]/page.tsx` — the summary + flags render here; per D-00 the summary should anchor the page (lead/capstone), flags integrate into existing cards.
- `analyses` table — needs a new column for the persisted report (jsonb) + likely a `report_status` / staleness marker and a generated-from-data fingerprint to drive D-08; new soft-signal fields extend the BRF data shape (migration, human-gated push per Phase 2/3 precedent); RLS must cover any new column.
- BRF extraction change is cross-phase — extending `brfExtractionSchema` means a migration touching `brf_*` data and a re-run of the Phase 2 eval set.
- **No PDF generation exists yet** — new dependency + serverless/cost surface; the PDF must reflect the same data the page renders (single source of truth).
- Anthropic SDK already installed and used (Phase 2) — synthesis is a new, more capable model call + new prompt; reuse the cost guard and key-handling pattern.

</code_context>

<specifics>
## Specific Ideas

- "Everything should feel like an integrated experience, not 4 different features" — the user's explicit framing (D-00). This is the through-line for the whole phase: the report is the product *coming together*, not three additions.
- The lead cross-source synthesis is the differentiator vs. the individual cards and vs. Allabrf's black box — it says the thing no single card can ("the price premium is harder to justify given the BRF's debt").
- Opinionated-but-no-verdict mirrors the product's whole posture: a confident, data-grounded second opinion that respects the buyer's decision and the legal line.
- Soft signals (stambyte, renovations) belong in the same cited/structured pipeline as the existing BRF numbers — consistency of trust, not a second-class free-text source.

</specifics>

<deferred>
## Deferred Ideas

- **Public shareable report link** (hosted, anyone-with-link) — considered and deferred; v1 is PDF-download-only (D-10). Revisit if sharing demand appears.
- **Forward-looking / predictive BRF risk** (interest-rate stress, refinancing exposure, maintenance-cycle / stambyte timing prediction, new-build debt inversion) — backlog 999.4 + ADV-01/02. Phase 4 flags only what's already extractable, never fabricates predictive risk from missing data.
- **Auto-generation / always-fresh report** — considered and rejected in favor of manual + mark-stale (D-07/D-08) for cost control and user agency.
- **Themed-section-only (no lead synthesis)** and **verdict-style summary** — both considered; rejected in favor of lead-synthesis + opinionated-no-verdict (D-04/D-05).
- **Buyer due-diligence checklist** orchestrating the whole flow — backlog 999.5 (cross-cutting UX layer, post-v1).

None of the above were acted on — discussion stayed within the RPRT-01/02/03 boundary.

</deferred>

---

*Phase: 04-ai-report-delivery*
*Context gathered: 2026-06-23*
