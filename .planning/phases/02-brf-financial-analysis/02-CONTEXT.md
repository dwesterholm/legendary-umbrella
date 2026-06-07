# Phase 2: BRF Financial Analysis - Context

**Gathered:** 2026-06-07
**Status:** Ready for planning

<domain>
## Phase Boundary

User can upload a BRF årsredovisning (PDF) and see a financial health assessment with a transparent A–F score. Includes: PDF upload UI, Claude-based extraction of key financials (skuld/kvm, avgiftsnivå, kassaflöde, underhållsplan status), rule-based scoring, confidence/uncertainty display, and manual correction. Price comparison, area statistics, and the synthesized AI report are out of scope (Phases 3–4). Multi-year trend analysis and auto-fetch from external registries are v2.

</domain>

<decisions>
## Implementation Decisions

### PDF acquisition strategy (RESEARCH DIRECTIVE)
- **D-01:** Researcher must do a feasibility pass on two acquisition approaches before planning decides:
  1. **Broker-page auto-fetch** — scrape the årsredovisning PDF from the broker's listing page. We already store `agencyListingUrl` per analysis (e.g. Vitec links). Assess PDF link patterns across major Swedish broker platforms (Vitec, Hemnet-connected agency sites, Historiska Hem-style boutiques).
  2. **Guided manual upload** — upload is the mechanism, UI actively guides the user to free sources: "Hitta årsredovisningen på mäklarens sida (vanligast)" with deep-link to the broker page; Bolagsverket ordering as fallback.
- **D-02:** Verified constraints the researcher must work within (checked 2026-06-07):
  - Bolagsverket's free "värdefulla datamängder" API serves only iXBRL filings — BRFs cannot file iXBRL yet, so NO free API covers BRF årsredovisningar today
  - BRF filing with Bolagsverket is mandatory only from fiscal year 2025, on paper (scanned archive, manual ordering, no API)
  - Allabrf: 99 SEK/report consumer-side; B2B/enterprise API exists but is priced for enterprises — do NOT build a dependency on paid per-report sources
  - Broker listing pages usually publish the latest årsredovisning PDF for free
- **D-03:** Monitor Bolagsverket digitalization — when BRF iXBRL filing arrives, auto-fetch via API becomes the v2 path (ENRICH-01)

### Upload placement & flow
- **D-04:** Upload lives inside the existing "BRF Analys — Kommer snart" placeholder section on the analysis page — it becomes the upload dropzone and, after parsing, the results display. No new navigation.
- **D-05:** BRF analysis is login-only. Guests see the BRF section as a teaser with "Logga in för BRF-analys". (Protects Claude API costs; BRF analysis is the premium differentiator and signup driver.)
- **D-06:** One PDF per analysis, replaceable — replacing re-runs the BRF analysis and overwrites the previous result. Multi-year trend analysis stays v2 (ADV-02).

### Score presentation
- **D-07:** Prominent color-coded A–F letter grade (sage → terracotta → red along the warm palette) with a per-metric breakdown table: each key metric (skuld/kvm, avgiftsnivå, kassaflöde, underhållsplan) shows its extracted value, its own mini-rating, and how it contributed to the overall grade.
- **D-08:** Scoring is rule-based and deterministic — weighted threshold rules computed in code. Claude ONLY extracts numbers; code computes the grade. Same PDF always produces the same grade. (Research-aligned: never let the LLM grade.)
- **D-09:** Full public methodology page/section — "Så räknar vi BRF-betyget" — listing every metric, threshold, and weight. Differentiator vs Allabrf's black box; fulfills "transparent methodology" (BRF-02) literally.

### Trust & uncertainty
- **D-10:** Every extracted figure gets a confidence indicator. Low-confidence fields are visibly flagged ("Osäker — kontrollera själv").
- **D-11:** Every figure shows its quoted source text + page reference from the uploaded PDF so the user can verify in seconds.
- **D-12:** All extracted fields are inline-editable. Corrections re-compute the score; corrected fields are marked "Manuellt angiven". Turns parsing failures into a 10-second user fix.

### Processing experience
- **D-13:** Live step progress inside the BRF section during parsing: "Läser dokumentet… → Extraherar nyckeltal… → Beräknar betyg…". User can leave the page; analysis continues server-side and results are there when they return. (February research suggested Inngest + Supabase Realtime for this — researcher validates the right mechanism; a simpler polling approach is acceptable if it meets the same UX.)
- **D-14:** Accept both digital and scanned PDFs, up to ~20 MB. Scanned documents get a heads-up ("Skannad PDF — utläsningen kan bli osäkrare") and lean harder on confidence flagging.

### Claude's Discretion
- Exact upload component design (dropzone style, file validation UX)
- Confidence indicator visual treatment (badges vs icons vs color)
- How source quotes are revealed (inline vs expandable)
- Scoring thresholds and weights (researcher provides sanity ranges; planner locks values — but they must be documented on the methodology page)
- Whether progress mechanism is Inngest+Realtime, polling, or streaming — UX requirement (D-13) is what's locked

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project planning
- `.planning/PROJECT.md` — Core value, constraints (solo dev, <$100/month, legal caution)
- `.planning/REQUIREMENTS.md` — BRF-01/02/03 definitions; ENRICH-01 (auto-fetch) is v2; ADV-02 (multi-year) is v2
- `.planning/research/SUMMARY.md` — Phase 2 risk flags: K2/K3 structured output, hallucination mitigation (separate extraction from analysis, sanity checks 2,000–15,000 SEK skuld/kvm Stockholm), PDF template diversity (50+ accounting firm layouts), cost budget (<5 SEK Claude cost per analysis), model tiering (Haiku extraction / Sonnet synthesis)
- `.planning/research/PITFALLS.md` — Full pitfall details for AI financial extraction
- `.planning/phases/01-foundation-core-pipeline/01-03-SUMMARY.md` — Actor output reality: NO brfName field; BRF must be resolved via address or from the uploaded PDF itself

### External (verified 2026-06-07)
- https://bolagsverket.se/apierochoppnadata/fragorochsvaromapierna.4611.html — BRFs cannot file iXBRL; free API does not cover BRF årsredovisningar
- https://www.fastighetsagarna.se/aktuellt/nyheter/2024/sverige/brfs-arsredovisning-for-2025-och-framat-ska-skickas-till-bolagsverket/ — Mandatory BRF filing from FY2025, paper form

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/components/coming-soon-section.tsx` — the "BRF Analys" placeholder this phase replaces with real UI
- `src/components/listing-skeleton.tsx` + metric card pattern in `listing-summary.tsx` — visual language for the breakdown table
- `src/lib/schemas/listing.ts` — `normalizeScraperOutput()` pattern: external-data normalization layer with null-tolerant extraction; replicate for Claude extraction output
- `src/actions/analyze.ts` — server action pattern (validate → call external service → parse → save); guest-gate cookie logic for the login-only check
- Supabase client setup in `src/lib/supabase/` (server + browser); `analyses` table with RLS and `listing_data` jsonb column

### Established Patterns
- Swedish UI / English code; partial-data tolerance ("Ej tillgänglig"); warm earthy palette (sage primary, terracotta accents)
- Zod v4 (`zod/v4` import path) for all external data validation
- `serverExternalPackages` in next.config.ts for packages with dynamic requires (apify-client precedent — check if needed for new deps)

### Integration Points
- Analysis page `src/app/(app)/analysis/[id]/page.tsx` — BRF section renders here
- `analyses` table — BRF results likely a new jsonb column or related table (planner decides); RLS must cover it
- Supabase Storage — not yet used; PDF uploads need a bucket + RLS policies
- **No Anthropic SDK installed yet** — this is the project's first Claude API integration; API key env var, cost tracking, and model selection all new
- **AI integration phase is enabled in config** — run `/gsd-ai-integration-phase 2` before planning to produce AI-SPEC.md (eval strategy for extraction accuracy)

</code_context>

<specifics>
## Specific Ideas

- Allabrf's A++ to C rating as the familiar reference — ours is A–F with full transparency as the differentiator
- "Så räknar vi" public methodology page as a trust/marketing asset, not just documentation
- Source quotes with page references as the trust mechanism: every number traceable to the PDF in seconds
- The user explicitly does not want users pushed toward paying Allabrf 99 SEK — free acquisition paths only

</specifics>

<deferred>
## Deferred Ideas

- Multi-year årsredovisning upload for trend analysis — v2 (ADV-02 avgiftshöjning prediction)
- Standalone BRF analysis without a listing analysis ("analyze any årsredovisning") — new entry point, own phase if wanted
- Auto-fetch from Bolagsverket API once BRF iXBRL filing exists — v2 (ENRICH-01)

</deferred>

---

*Phase: 02-brf-financial-analysis*
*Context gathered: 2026-06-07*
