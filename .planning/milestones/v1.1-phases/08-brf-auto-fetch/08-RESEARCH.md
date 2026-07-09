# Phase 8: BRF Auto-Fetch - Research

**Researched:** 2026-07-06
**Domain:** Swedish company-registry integration (Bolagsverket/Allabrf) + refactor of an existing AI-extraction pipeline
**Confidence:** MEDIUM (stack/architecture) / LOW (Bolagsverket access model — registration-gated, could not verify live)

## Summary

Phase 8 adds an auto-fetch pre-step in front of the existing `analyzeBrf` action, but the single highest-risk finding of this research is that **there is no free, on-demand, name-searchable Bolagsverket API that returns an årsredovisning PDF/iXBRL for a single BRF**. Bolagsverket exposes three distinct, non-overlapping products: (1) a paid, registration-gated "Företagsinformation" API (WSO2 devportal, OAuth, connection fee + per-transaction pricing) that takes an **organisationsnummer as input** and returns company metadata — not the annual report document itself; (2) a free "öppna data / värdefulla datamängder" bulk feed that ships **weekly zip files of ALL companies' iXBRL reports** — not queryable per-company on demand; (3) the "hämta årsredovisningsinformation/-händelser" APIs, which return **filing-event metadata**, not the document. None of the three lets you search by BRF name to resolve an organisationsnummer — org.nr must already be known before you can query anything. This directly contradicts the phase's implicit assumption that Bolagsverket alone can close the loop from `brfName` (all Phase 6 currently recovers) to a fetched document.

Given this, the phase's own approach note — "if a high-confidence org.nr match isn't available, do NOT auto-fetch; fall through to manual upload" — is not just a safety rail, it is the **expected default outcome** for most listings until a name→org.nr resolver is built. The pragmatic path: use a free, scrapeable public directory (allabolag.se) or Allabrf's BRF-Data product to resolve `brfName` → organisationsnummer with a confidence gate, then attempt Bolagsverket's weekly bulk iXBRL feed or Allabrf's document access as the document source, falling through to manual upload whenever any step is ambiguous. No mature npm iXBRL parser exists for the Swedish (BFN K2/K3) taxonomy, so rather than hand-rolling a taxonomy parser, iXBRL should be stripped to plain text (cheerio, already a project dependency) and routed through the **same Claude extraction call** via Anthropic's `document` content block `text/plain` source type — which sits alongside the existing PDF `base64`/`file` sources with no schema changes.

**Primary recommendation:** Build a `resolveOrgNr(brfName, breadcrumbs)` step with an explicit confidence threshold (auto-fetch only above it), then a `fetchArsredovisning(orgNr)` step with a documented rung order (Bolagsverket bulk-feed lookup → Allabrf fallback → give up), and refactor `analyzeBrf`'s core into `runBrfExtraction(input: { source: "pdf"; bytes: Uint8Array } | { source: "ixbrl-text"; text: string; })` so both manual upload and auto-fetch share the D-06 hash cache, cost-cap, and scoring pipeline unchanged. Treat the whole auto-fetch path as a best-effort enrichment that fails open to the existing, fully-functional manual upload — never a hard dependency.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Org.nr resolution from brfName | API/Backend (Server Action) | — | Needs server-side scraping/API calls with secrets; must never run in the browser |
| Årsredovisning document fetch (Bolagsverket/Allabrf) | API/Backend (Server Action) | — | External network calls, potential API keys, same trust boundary as existing `uploadBrfPdf`/`extractBrfFinancials` |
| iXBRL → plain text normalization | API/Backend | — | Pure server-side transform before handing to Claude; no reason to ever touch the client |
| Shared extraction/scoring (`runBrfExtraction`) | API/Backend | — | Existing `analyzeBrf` core already lives here; auto and manual paths must converge on this same tier/function |
| User confirmation UI ("stämmer detta med din bostad?") | Browser/Client (React Server Component + Client Component) | — | New confirmation step before analysis begins, mirrors existing `BrfSection`/`BrfUpload` client boundary |
| Progress polling (`auto_fetching` status) | Browser/Client (polls) + API/Backend (writes) | Database | Extends the existing `BrfProgress` poll pattern — `brf_status` already server-written, client-polled |
| `brf_fetch_source` provenance | Database (Postgres/Supabase) | API/Backend (writer) | Additive-nullable column, same convention as `brf_pdf_hash`/`brf_scanned` |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@anthropic-ai/sdk` | ^0.102.0 (already installed) | Same Haiku extraction call, now fed either PDF bytes or iXBRL-derived text | Already the project's sole AI vendor; `document` content blocks support both `base64`/`file` (PDF) and `text/plain` sources — no new package needed [CITED: platform.claude.com/docs/en/build-with-claude/citations] |
| `cheerio` | ^1.2.0 (already installed) | Strip iXBRL's inline-HTML wrapper to plain readable text; parse Allabrf HTML search-result pages | Already used for broker-page parsing (`parse-broker-page.ts`) — same DOM-to-text pattern applies to iXBRL (which is valid XHTML) [VERIFIED: package.json] |
| `undici` | ^7.27.2 (already installed) | HTTP fetch to Bolagsverket API / Allabrf pages, with timeout/SSRF-guard patterns already established | Already a dependency; Node's global `fetch` uses undici under the hood, but the project has it explicit for the broker-fetch SSRF guard pattern [VERIFIED: package.json] |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| none new required | — | — | This phase should NOT add a dependency for iXBRL parsing (see Don't Hand-Roll) — the text-extraction approach needs no new library |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| cheerio text-stripping of iXBRL | `xbrl-parser` / `parse-xbrl` npm packages | Both target Danish/US-GAAP taxonomies, not Swedish BFN K2/K3 — would require writing a custom taxonomy mapping anyway, with none of the benefit (still hand-rolled, now with an unmaintained/unfamiliar dependency in the trust chain) [MEDIUM confidence, WebSearch cross-checked against npm package descriptions] |
| Allabrf scraping | Allabrf "BRF-Data" paid API/data product | If a budget exists, this is more reliable than scraping their site and gives structured org.nr + name mapping directly; keep as a documented upgrade path, not required for this phase [LOW confidence — pricing/terms not verified live] |
| Bolagsverket weekly bulk zip ingestion | Bolagsverket paid "Företagsinformation" API | The paid API is lower-latency (per-request) but has a connection fee + per-transaction cost and does not return the actual document — only metadata — so it does not remove the need for a document-fetch step regardless [MEDIUM confidence, cross-verified across 2 WebSearch queries] |

**Installation:**
No new packages required — `@anthropic-ai/sdk`, `cheerio`, `undici` are already dependencies.

**Version verification:**
```bash
npm view cheerio version   # confirms current major still 1.x
npm view undici version    # confirms current major still 7.x
```
Both already pinned in `package.json`; no upgrade needed for this phase's scope.

## Package Legitimacy Audit

No new external packages are recommended for this phase (see Don't Hand-Roll and Alternatives Considered — the iXBRL problem is solved by reusing existing `cheerio` + the Anthropic SDK's text-document source type, not a new dependency). `slopcheck` was installed successfully in this research session but there is nothing to audit: zero new packages are being introduced.

**Packages removed due to slopcheck [SLOP] verdict:** none — no new packages proposed.
**Packages flagged as suspicious [SUS]:** none.

If a future implementer decides an iXBRL parser package IS needed after all (e.g., if the plain-text approach proves insufficient for extraction quality), re-run this gate against the specific candidate (`xbrl-parser`, `parse-xbrl`) before installing — both are called out above as targeting the wrong taxonomy and should be treated with elevated scrutiny.

## Architecture Patterns

### System Architecture Diagram

```
[User opens analysis page]
        |
        v
[BrfSection: brfName + org.nr known?] --no org.nr candidate--> [existing upload UI] --(unchanged path)--> [runBrfExtraction(pdf)]
        |
   yes (brfName from Phase 6 breadcrumb)
        v
[resolveOrgNr(brfName, breadcrumbs)]  <-- NEW server action
        |
        +--(low confidence / no match)--> [fall through to manual upload UI, unchanged]
        |
   high confidence match
        v
[status: auto_fetching] (NEW transient status, polled by existing BrfProgress pattern)
        v
[fetchArsredovisning(orgNr)]  <-- NEW server action, fallback tree:
        |   rung 1: Bolagsverket weekly-bulk-feed lookup (free, latest available fiscal year)
        |   rung 2: Allabrf scrape/API (fragile fallback)
        |   rung 3 (implicit): throw -> caller falls through to manual upload
        v
[document found: PDF bytes OR iXBRL text, + resolved org.nr + fiscal year]
        v
[Confirmation UI: "Stämmer detta med din bostad?" -- org.nr + fiscal year shown,
 flagged if not most-recent-available fiscal year]  <-- NEW, blocks auto-continuation
        |
   user confirms                      user rejects / times out
        v                                     v
[runBrfExtraction({source, bytes|text})]   [fall through to manual upload UI]
        v
[SAME D-06 hash cache -> extractBrfFinancials -> schema gate -> cost cap
 -> sanity -> computeBrfGrade -> persist]   (identical to existing analyzeBrf body)
        v
[brf_status: done, brf_data, brf_fetch_source: 'auto_bolagsverket' | 'auto_allabrf' | 'manual']
```

### Recommended Project Structure
```
src/
├── actions/
│   ├── analyze-brf.ts          # REFACTORED: analyzeBrf() becomes a thin wrapper
│   │                            # around runBrfExtraction(); correctBrfField unchanged
│   └── fetch-brf-auto.ts       # NEW: resolveOrgNr + fetchArsredovisning server actions,
│                                # returns a discriminated result for the confirmation UI
├── lib/
│   ├── brf/
│   │   ├── run-extraction.ts   # NEW: extracted shared core (hash cache, cost cap,
│   │   │                        # scoring pipeline) — called by BOTH manual and auto paths
│   │   ├── extract.ts          # MODIFIED: accept { source: "pdf" | "ixbrl-text" } union
│   │   ├── ixbrl-to-text.ts    # NEW: cheerio-based iXBRL -> plain text stripper
│   │   ├── sanity.ts           # unchanged
│   │   ├── score.ts            # unchanged
│   │   └── cost.ts             # unchanged
│   └── brf-source/
│       ├── org-nr-resolver.ts  # NEW: brfName -> org.nr candidate + confidence
│       ├── bolagsverket.ts     # NEW: bulk-feed lookup / paid-API client (behind a flag)
│       └── allabrf.ts          # NEW: scraping fallback, isolated (mirrors broker-page pattern)
├── components/
│   ├── brf-section.tsx         # MODIFIED: new "confirm" view between upload and progress
│   ├── brf-progress.tsx        # MODIFIED: STEPS array gains "auto_fetching" label
│   └── brf-confirm.tsx         # NEW: "Stämmer detta med din bostad?" org.nr/fiscal-year UI
└── lib/schemas/
    └── brf.ts                  # unchanged (extraction schema itself doesn't change)
```

### Pattern 1: Shared extraction core behind a discriminated source union
**What:** Extract `analyzeBrf`'s body (hash check → upload/store → status writes → `extractBrfFinancials` → schema gate → cost cap → sanity → grade → persist) into `runBrfExtraction(analysisId, source)` where `source` is `{ kind: "pdf"; bytes: Uint8Array } | { kind: "ixbrl-text"; text: string }`.
**When to use:** Any time a document — regardless of where it came from — needs the identical pipeline the manual upload already exercises (ENRICH-01 success criterion 1: "runs the IDENTICAL extraction/scoring pipeline").
**Example:**
```typescript
// Source: existing analyze-brf.ts pattern (this file), generalized
export type BrfDocumentSource =
  | { kind: "pdf"; bytes: Uint8Array }
  | { kind: "ixbrl-text"; text: string };

export async function runBrfExtraction(
  analysisId: string,
  userId: string,
  source: BrfDocumentSource,
  fetchSource: "manual" | "auto_bolagsverket" | "auto_allabrf",
): Promise<AnalyzeBrfResult> {
  // ... identical hash-cache / status-write / cost-cap / sanity / grade logic,
  // branching ONLY at the extractBrfFinancials call site on `source.kind`,
  // and persisting brf_fetch_source alongside the existing brf_* columns.
}
```

### Pattern 2: Confidence-gated org.nr resolution — fail closed, never guess
**What:** `resolveOrgNr` returns a discriminated result, never a bare string, so the caller cannot accidentally auto-fetch on a weak match.
**When to use:** Every auto-fetch attempt, per the binding constraint "if a high-confidence org.nr match isn't available, do NOT auto-fetch."
**Example:**
```typescript
export type OrgNrResolution =
  | { confidence: "high"; orgNr: string; matchedName: string }
  | { confidence: "low"; candidates: Array<{ orgNr: string; name: string }> }
  | { confidence: "none" };

// Only "high" confidence may proceed to fetchArsredovisning(). "low"/"none"
// both fall through to manual upload — treat them identically at the call site.
```

### Pattern 3: Generalized fallback tree (do not reuse `walkFallbackTree` as-is)
**What:** The existing `walkFallbackTree<T>` in `src/lib/booli/fallback-tree.ts` is generic over `T` but its `FallbackResult<T>["source"]` field is a **fixed literal union** (`"own-playwright" | "own-playwright-retry" | "paid-actor"`) tied to Booli's rungs. Phase 8 needs its own rung vocabulary (`"bolagsverket" | "allabrf"`).
**When to use:** When building `fetchArsredovisning`'s fallback logic.
**Example:**
```typescript
// Either (a) generalize walkFallbackTree to accept `source: string` generically,
// updating booli/client.ts's call sites to pass their literal type as before
// (safe, since TS narrows string literals passed to a generic string param), OR
// (b) write a small phase-8-local rung walker mirroring the same shape/logging
// convention without touching the Booli-specific file. Prefer (a) if the
// refactor is a 1-line generic-signature change; prefer (b) if it risks
// destabilizing Phase 5's tested code. Planner should read fallback-tree.test.ts
// before deciding.
```

### Anti-Patterns to Avoid
- **Building a second extraction pipeline for auto-fetched documents:** defeats the phase's entire purpose (ENRICH-01 explicitly requires the identical pipeline) and would double the D-06 cache/cost-cap/scoring maintenance surface.
- **Treating a Bolagsverket API 200 response as "found the document":** the paid Företagsinformation API returns company *metadata*, not the annual report file — a naive implementation could persist "found" without ever having the actual financial document to extract from.
- **Auto-fetching on a fuzzy/partial name match:** BRF names are highly non-unique ("Brf Solen", "Brf Björken" recur across many municipalities) — a name-only match without org.nr-level confirmation risks silently analyzing the WRONG building's finances. Always require org.nr-level confidence, never brfName string similarity alone, before treating a match as "high confidence."
- **Skipping the user-confirmation step "just this once" for a high-confidence match:** ENRICH-02 requires confirmation unconditionally — even a 100%-confidence match must be confirmed, because fiscal year currency (not just identity) needs the user's eyes.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| iXBRL taxonomy parsing (extracting structured skuldPerKvm/avgiftsniva/etc. fields directly from XBRL tags) | A custom Swedish BFN K2/K3 taxonomy walker | Strip iXBRL's HTML wrapper to plain text (cheerio) and feed the SAME Claude extraction prompt that already reads PDFs | No mature npm package targets the Swedish taxonomy (existing packages target Danish/US-GAAP); building one is a multi-week taxonomy-mapping project for a phase whose stated approach is reuse, not new pipelines. Claude already reliably extracts these figures from unstructured PDF text — plain iXBRL text is easier, not harder, since it's already digitally native (no OCR/scan risk) |
| Name → organisationsnummer fuzzy matching | A custom string-similarity/Levenshtein matcher against a self-scraped BRF name database | A real registry lookup (allabolag.se search, or Allabrf's BRF-Data) that returns org.nr directly for a name query, gated by an exact/near-exact confidence check | Hand-rolled fuzzy matching on BRF names is a correctness trap — Swedish BRF names collide constantly across municipalities (there are dozens of "Brf Björken"); a real registry's disambiguation (address, kommun) is safer than a bespoke similarity score |
| PDF/document rendering of iXBRL for visual fidelity | A custom iXBRL-to-PDF renderer (e.g., via a headless browser print-to-PDF) | Plain-text extraction (see above) — no rendering fidelity is needed since Claude only needs the numbers, not a visual document | Adds a Playwright/headless-browser dependency and cost for zero benefit — the existing scanned-PDF heuristic (`detectScanned`) and citation/pageRef fields are designed around real PDFs; an iXBRL "PDF" would need pageRef semantics invented from nothing |

**Key insight:** The entire iXBRL problem is a text-extraction problem the project has already effectively solved (Claude structured-output extraction from unstructured Swedish financial-document text) — the only genuinely new work is org.nr resolution and document *location*, not document *parsing*.

## Common Pitfalls

### Pitfall 1: Assuming "Bolagsverket API" is one API
**What goes wrong:** Planning a single `fetchFromBolagsverket(orgNr)` call that both resolves identity and returns a document.
**Why it happens:** Bolagsverket's own marketing page groups "API:er och öppna data" together; the distinction between the paid per-company metadata API, the free bulk-zip feed, and the digital-filing-status APIs is easy to miss without reading each product page individually.
**How to avoid:** Treat "Bolagsverket" in the plan as at minimum two integration points: (a) a possible identity/metadata confirmation call (paid, optional), (b) a document-acquisition path via the free weekly bulk feed (requires ingesting/indexing the feed by org.nr since it's not queryable on demand).
**Warning signs:** A task titled "call Bolagsverket API for org.nr X and get the PDF" without specifying which of the three products.

### Pitfall 2: The free bulk feed is not a live lookup
**What goes wrong:** Code assumes `fetchArsredovisning(orgNr)` can hit a URL and get back this specific company's latest report synchronously.
**Why it happens:** Every other integration in this codebase (Booli, Riksbank, SCB) is a live request/response API; the mental model transfers incorrectly.
**How to avoid:** The weekly zip feed must be either (a) downloaded and indexed by org.nr as a batch/background job ahead of time (adds real infra), or (b) treated as effectively unavailable for a same-request auto-fetch and immediately fall through to Allabrf/manual. Given the phase's "informational spike" framing and solo-dev scope, **recommend (b) for v1**: do not build a bulk-feed ingestion pipeline in this phase — document it as a known gap and rely on Allabrf + manual upload as the practical v1 sources. Revisit bulk-feed ingestion only if Allabrf coverage proves insufficient.
**Warning signs:** A task estimate that doesn't include "stand up a scheduled job + storage for the weekly zip" but still promises live Bolagsverket document fetch.

### Pitfall 3: Cross-ecosystem/registry-gated access blocking automated verification
**What goes wrong:** Bolagsverket's own website (bolagsverket.se) is behind an F5/TSPD bot-detection challenge that returned a JS challenge page to a plain `curl` in this research session — confirming that scripted access to the marketing/docs site is blocked, though the actual REST API subdomains (`portal.api.bolagsverket.se`, `media.bolagsverket.se`) are separate infrastructure designed for programmatic use and were not similarly blocked when fetched.
**Why it happens:** Government/registry sites commonly bot-wall their public-facing HTML while keeping API infrastructure open (since API access is intentionally gated by registration instead).
**How to avoid:** Do not attempt to scrape bolagsverket.se's own pages for anything — always go through the documented API subdomains, and expect a manual registration/sign-up step (WSO2 devportal + OAuth) before any live test is possible.
**Warning signs:** A task that says "scrape Bolagsverket's site for X" — should never appear; only "register for Bolagsverket devportal" or "call the documented REST endpoint" are valid.

### Pitfall 4: BRF name collisions producing wrong-building financial analysis
**What goes wrong:** Two BRFs named identically (or near-identically) in different municipalities get conflated, and a user is shown financial figures for the WRONG building's annual report — the single worst possible failure mode for a trust-sensitive feature.
**Why it happens:** Swedish BRF names are drawn from a small, recurring vocabulary (trees, streets, historical figures) and are not unique nationally.
**How to avoid:** Confidence gating must incorporate more than name string match — cross-reference kommun/address (available from the Booli breadcrumb ladder / listing address) against the candidate org.nr's registered address before calling it "high confidence." A name-only match, even exact, should be "low" confidence without an address/kommun cross-check.
**Warning signs:** `resolveOrgNr` implementation that only does `name.toLowerCase() === candidate.name.toLowerCase()` with no geographic disambiguation.

### Pitfall 5: Fiscal year silently stale
**What goes wrong:** Auto-fetch returns a real, correctly-matched document — but it's 2-3 fiscal years old, and the user isn't told, so they make a decision on outdated BRF finances.
**Why it happens:** Bolagsverket's iXBRL submission lag (some associations file late; the weekly feed only has what's been digitally submitted) means "the document we found" and "the most recent available" can differ.
**How to avoid:** Success criterion 4 already requires this be flagged — implement it as a real check: if a fetch source can enumerate available fiscal years (even just "is there a newer one on Allabrf/Bolagsverket we didn't fetch"), compare and flag. If no such enumeration is possible for a given source, default to explicitly labeling the fiscal year with its filing/submission date so the user can judge recency themselves.
**Warning signs:** A confirmation UI that shows a fiscal year but has no code path that could ever render the "not most recent" flag — i.e., the flag exists in the type but no logic sets it to true.

## Runtime State Inventory

> Skipped — this is a net-new feature phase (auto-fetch pre-step + new column + new status), not a rename/refactor/migration phase. No existing runtime state carries an old name/identifier that needs updating.

## Code Examples

### Extending the Anthropic document source to accept iXBRL-derived plain text
```typescript
// Source: pattern derived from src/lib/brf/extract.ts (existing PDF path) +
// Anthropic Citations docs (platform.claude.com/docs/en/build-with-claude/citations)
// confirming `source: { type: "text", media_type: "text/plain", data }` is a
// valid sibling to the existing base64/file document sources.
type DocumentSource =
  | { type: "base64"; media_type: "application/pdf"; data: string }
  | { type: "file"; file_id: string }
  | { type: "text"; media_type: "text/plain"; data: string }; // NEW for iXBRL

function buildDocumentSource(
  input: BrfDocumentSource,
): DocumentSource | Promise<DocumentSource> {
  if (input.kind === "ixbrl-text") {
    return { type: "text", media_type: "text/plain", data: input.text };
  }
  // existing base64/Files-API branching for input.kind === "pdf", unchanged
  return buildPdfDocumentSource(input.bytes);
}
```

### iXBRL-to-text stripping via cheerio (mirrors existing broker-page pattern)
```typescript
// Source: pattern mirrors src/lib/broker/parse-broker-page.ts's cheerio usage
import * as cheerio from "cheerio";

export function ixbrlToPlainText(ixbrlHtml: string): string {
  const $ = cheerio.load(ixbrlHtml, { xmlMode: false });
  // iXBRL documents are valid (X)HTML with inline ix: tags carrying the
  // machine-readable values; the human-readable rendered text (which already
  // contains the same figures in prose/table form) is what Claude needs —
  // strip script/style, keep visible text content.
  $("script, style").remove();
  return $("body").text().replace(/\s+/g, " ").trim();
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Paper/PDF-only annual report filing | Mandatory digital iXBRL filing for many Swedish entities | iXBRL submissions begin 2020 per Bolagsverket's own downloadable-files documentation | Bolagsverket's free bulk feed only has iXBRL-format reports from 2020 onward — older BRFs' historical reports may not be in this feed at all, reinforcing manual upload as the durable fallback for older filings |

**Deprecated/outdated:**
- None identified as deprecated within this domain during this research window — Bolagsverket's API landscape (WSO2 devportal, `gw.api.bolagsverket.se`) appears to be their current, actively-linked infrastructure as of this research date.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Bolagsverket's "Företagsinformation" API returns company metadata, not the annual report document itself | Summary, Pitfall 1 | If wrong (i.e., it DOES bundle document access), the phase could skip the bulk-feed/Allabrf complexity entirely and use one paid API call — planner should have the operator confirm via devportal registration before committing to the multi-source fallback design |
| A2 | The free "öppna data" annual-report feed is bulk-only (weekly zips), with no per-company on-demand query endpoint | Pitfall 2 | If a per-company free query DOES exist (undiscovered in this research pass), the recommended "skip bulk-feed ingestion for v1" simplification would be unnecessarily conservative, and Bolagsverket could become the primary rung instead of a documented gap |
| A3 | Allabrf's public site (sv.allabrf.se / allabrf.se) can serve as a scraping fallback with acceptable ToS posture, similar to the project's existing Booli scraping posture | Summary, Architecture Patterns | If Allabrf's ToS or robots.txt (robots.txt disallows `/api` but not general pages) is more restrictive than assumed, or if their BRF-Data product is the ONLY sanctioned access path, the "scraping-fragility fallback" framing from the phase description could be a legal/ToS risk that needs a human check before implementation |
| A4 | No mature npm package correctly parses Swedish BFN K2/K3-taxonomy iXBRL into structured financial fields | Don't Hand-Roll, Alternatives Considered | If a Swedish-specific package exists that this research missed, the plain-text-to-Claude approach, while still valid, may be leaving extraction-quality/cost improvements on the table |
| A5 | The Bolagsverket devportal (`portal.api.bolagsverket.se`) requires registration/sign-in and is not a keyless public API | Summary, Pitfall 3 | If registration turns out to be instant/free/self-serve (vs. a sales-gated paid contract), the phase's risk profile drops significantly and the paid-API rung could be promoted from "optional" to "primary" |

**If this table is empty:** N/A — see entries above; all are flagged for confirmation per the "(RESOLVED)" recommendations in Open Questions below, which are not blocked on these assumptions.

## Open Questions

### 1. Does Bolagsverket's paid Företagsinformation API return the actual årsredovisning document, or only metadata? (RESOLVED)
- What we know: Search-derived summaries consistently describe this API as returning "basic information about companies," "engagements," and org.nr/name lookups — never mentioning document retrieval. The separate "hämta årsredovisningsinformation/-händelser" APIs explicitly return event/status metadata, not documents, per direct fetch of their English doc page.
- What's unclear: Whether a newer API version (the devportal listed a "NordicInformation" API alongside "Företagsinformation" — possibly broader) bundles document access.
- Recommendation: **Treat the paid API as identity/metadata-only for planning purposes.** Do not plan a task that expects a PDF/iXBRL byte stream from this API. If the operator registers on the devportal during implementation and discovers document access IS available, that's a pleasant simplification, not a blocker — the planner should scope the paid-API integration as an optional Rung 0 (fastest, cheapest — SEK cost negligible per lookup for identity confirmation only) ahead of the free bulk-feed/Allabrf rungs, not as a required document source.

### 2. Is the Bolagsverket weekly bulk-zip feed a realistic v1 document source, or should it be deferred? (RESOLVED)
- What we know: It's free, requires no contract, and covers digitally-submitted reports since 2020. It is NOT queryable per-company on demand — it requires downloading and indexing weekly archives.
- What's unclear: The exact zip file size/volume (all Swedish companies' weekly filings) and whether a lightweight subset filter (e.g., by SNI code for BRFs) exists to avoid ingesting irrelevant company types.
- Recommendation: **Defer bulk-feed ingestion out of this phase's v1 scope.** Building a scheduled ingestion+index pipeline is a meaningfully larger, separate piece of infrastructure than "add an auto-fetch pre-step," and conflicts with the phase's stated lightweight approach. Plan the phase around Allabrf (rung 1, since it's queryable on-demand by name/org.nr) with manual upload as rung 2, and log Bolagsverket bulk-feed ingestion as a documented future enhancement (similar to how EST-01/ADV-01 are deferred requirements) rather than a Phase 8 task. This inverts the phase description's stated preference ("prefer Bolagsverket... treat Allabrf as fallback") — call this out explicitly to the user/planner as a deviation with its rationale, since it's a discretion-zone judgment call, not a locked decision.

### 3. What confidence signal should gate "high confidence" org.nr match? (RESOLVED)
- What we know: Booli breadcrumbs provide `brfName` + a Booli-internal BRF id (not org.nr) + the listing's address/kommun (from the wider breadcrumb ladder). A registry search (allabolag.se or Allabrf) by name can return zero, one, or multiple org.nr candidates.
- What's unclear: No existing fuzzy-matching precedent in this codebase to reuse.
- Recommendation: **High confidence = exactly one registry candidate whose registered name matches brfName (case/whitespace-insensitive exact or near-exact match, e.g. ignoring "Bostadsrättsföreningen" vs "Brf" prefix variants) AND whose registered address/kommun matches the listing's breadcrumb kommun.** Any of: zero candidates, multiple candidates, name-only match without geographic corroboration, or a geographic mismatch → "low"/"none" → fall through to manual upload. This is deliberately conservative per the binding constraint ("do NOT auto-fetch" on anything less than high confidence) and mirrors Pitfall 4's guidance.

### 4. Should `brf_status = 'auto_fetching'` cover org.nr resolution, document fetch, or both? (RESOLVED)
- What we know: The phase description specifies "a new transient `auto_fetching` status." The existing `brf_status` progression is `reading → extracting → scoring → done/failed`, each mapped 1:1 to a UI step label in `BrfProgress`'s `STEPS` array.
- What's unclear: Whether org.nr resolution and document fetching need distinguishable sub-states.
- Recommendation: **Use a single `auto_fetching` status covering both org.nr resolution AND document fetch** (they're both fast, sub-second-to-few-seconds operations unlikely to need granular progress UI, unlike the multi-second Claude extraction call). Insert it BEFORE `reading` in the `BrfProgress` STEPS array with its own label (e.g., "Söker årsredovisning..."). Once a document is found, transition through the EXISTING `reading`/`extracting`/`scoring` states unchanged — `runBrfExtraction` doesn't need to know or care whether its input came from auto-fetch or manual upload once it has bytes/text in hand.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `ANTHROPIC_API_KEY` | `extractBrfFinancials` (unchanged from existing pipeline) | Assumed ✓ (already required by shipped Phase 4/BRF-03) | — | none needed — already a hard project dependency |
| Bolagsverket devportal registration/API key | Optional identity-confirmation rung, deferred document rung | ✗ (not registered; registration-gated per Pitfall 3) | — | Skip Bolagsverket entirely for v1; use Allabrf + manual upload (see Open Question 2) |
| Allabrf API key / BRF-Data contract | Org.nr resolution + document fallback rung | ✗ (not verified/contracted) | — | Fall back to scraping allabrf.se's public pages (cheerio), or allabolag.se for org.nr-only resolution if Allabrf access proves unavailable |
| `cheerio` | iXBRL text stripping, Allabrf/allabolag HTML parsing | ✓ | ^1.2.0 | none needed |
| `undici` | HTTP fetch to external registries | ✓ | ^7.27.2 | none needed |
| Supabase migration 009 slot | `auto_fetching` status + `brf_fetch_source` column | ✓ (008 is latest; 009 is free) | — | none needed |

**Missing dependencies with no fallback:**
- None — every missing dependency (Bolagsverket registration, Allabrf contract) has a documented fallback (manual upload remains fully functional per the phase's own success criterion 3).

**Missing dependencies with fallback:**
- Bolagsverket API access — fallback: defer to bulk-feed-as-future-work; use Allabrf/allabolag.se for v1.
- Allabrf contracted API access — fallback: public-page scraping (cheerio), same trust posture as existing Booli/broker scraping.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.8 |
| Config file | `vitest.config.ts` (project root) |
| Quick run command | `npm test -- src/lib/brf-source src/lib/brf/run-extraction.test.ts src/actions/fetch-brf-auto.test.ts` |
| Full suite command | `npm test` (== `vitest run`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ENRICH-01 | `resolveOrgNr` returns "high" only on exact-name + kommun-address match, "low"/"none" otherwise | unit | `npx vitest run src/lib/brf-source/org-nr-resolver.test.ts` | ❌ Wave 0 |
| ENRICH-01 | `fetchArsredovisning` walks Allabrf → (no Bolagsverket rung in v1) → throws when both exhausted, never silently returns undefined | unit | `npx vitest run src/lib/brf-source/fetch-document.test.ts` | ❌ Wave 0 |
| ENRICH-01 | `runBrfExtraction` produces byte-identical `BrfData` shape regardless of `source.kind` ("pdf" vs "ixbrl-text") for equivalent content | unit (regression against existing `analyze-brf.test.ts` fixtures) | `npx vitest run src/lib/brf/run-extraction.test.ts` | ❌ Wave 0 |
| ENRICH-01 | Manual upload path (`analyzeBrf`) still behaves identically post-refactor (no regression) | unit | `npx vitest run src/actions/analyze-brf.test.ts` | ✅ (existing file — extend, don't replace) |
| ENRICH-02 | Confirmation UI blocks `runBrfExtraction` from firing until user confirms org.nr + fiscal year | integration/component | `npx vitest run src/components/brf-confirm.test.tsx` | ❌ Wave 0 |
| ENRICH-02 | Fiscal-year-not-most-recent flag renders when a newer year is knowably available | unit | `npx vitest run src/lib/brf-source/fetch-document.test.ts` (co-located with fetch tests) | ❌ Wave 0 |
| ENRICH-02 | Ambiguous/failed auto-fetch surfaces the EXISTING manual upload UI, unchanged and equally prominent | component (regression) | `npx vitest run src/components/brf-section.test.tsx` | ❌ Wave 0 (no existing test file for `brf-section.tsx` found — verify during Wave 0) |
| — | New `auto_fetching` status renders correct step label without breaking existing `reading`/`extracting`/`scoring` step indices | component | `npx vitest run src/components/brf-progress.test.tsx` | ❌ Wave 0 (no existing test file found — verify during Wave 0) |

### Sampling Rate
- **Per task commit:** `npx vitest run <touched-test-files>` (fast, scoped)
- **Per wave merge:** `npm test` (full suite)
- **Phase gate:** Full suite green before `/gsd-verify-work`; additionally, a live manual smoke test against a real BRF (operator-run, since Allabrf/Bolagsverket live calls should not run in CI) is recommended before considering ENRICH-01/02 verified end-to-end — mirrors the existing pattern of deferred live-render checkpoints for Phase 5/7.

### Wave 0 Gaps
- [ ] `src/lib/brf-source/org-nr-resolver.test.ts` — covers ENRICH-01 confidence gating
- [ ] `src/lib/brf-source/fetch-document.test.ts` — covers ENRICH-01 fallback tree + fiscal-year-currency flag
- [ ] `src/lib/brf/run-extraction.test.ts` — covers ENRICH-01 shared-pipeline equivalence (pdf vs ixbrl-text)
- [ ] `src/components/brf-confirm.test.tsx` — covers ENRICH-02 confirmation gate
- [ ] Verify whether `src/components/brf-section.tsx` and `brf-progress.tsx` have existing test files before assuming Wave 0 must create them from scratch — this research did not find test files for either during the codebase scan; the planner should `ls src/components/*.test.tsx` first
- [ ] No new test framework/config install needed — Vitest is already fully configured and covers the existing `analyze-brf.test.ts` (unit + "Plan 04 integration tests" describe block)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No (new) | Reuses existing Supabase auth gate (`analyzeBrf`'s hard D-05 auth check) — auto-fetch must sit BEHIND the same `supabase.auth.getUser()` gate, never a guest-accessible path |
| V3 Session Management | No (new) | Unchanged — no new session concepts introduced |
| V4 Access Control | Yes | Row-level: `resolveOrgNr`/`fetchArsredovisning` must verify `row.user_id === user.id` identically to the existing ownership check in `analyzeBrf`, before writing `auto_fetching` status or any fetched document to the analysis row |
| V5 Input Validation | Yes | `brfName` and any resolved `orgNr` used in outbound URLs (Allabrf search, Bolagsverket API path param) must be validated/sanitized before interpolation into a URL — org.nr should be checked against the Swedish org.nr format (10 digits, valid Luhn-style checksum per Skatteverket's rules) before being used in any external request, both for correctness and as an SSRF-adjacent hardening measure (never pass unsanitized user/scraped-derived strings into a fetch URL path) |
| V6 Cryptography | No (new) | No new crypto — the existing `hashBytes`/SHA-256 D-06 cache reuses unchanged |

### Known Threat Patterns for {stack}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SSRF via unsanitized org.nr/brfName interpolated into an outbound fetch URL to Bolagsverket/Allabrf | Tampering / Elevation of Privilege | Validate org.nr format strictly (10-digit numeric, checksum) before use in any URL; validate/encode brfName before it reaches a query string (mirrors the SSRF-guard pattern already established for `fetchBrokerListingPage` per Phase 6's LSTG-03 work — reuse that guard's design, don't invent a new one) |
| Wrong-BRF financial data disclosure (showing User A the financials of a different, similarly-named BRF as if it were theirs) | Information Disclosure / Spoofing | Confidence-gated matching (Pitfall 4/Open Question 3) — geographic cross-check, never name-only; mandatory user confirmation step (ENRICH-02) as a human-in-the-loop final check regardless of match confidence |
| Cost/abuse via repeated auto-fetch triggering redundant external scraping + Claude calls | Denial of Service (cost) | Same D-06 content-hash cache applies once a document is fetched — but the RESOLUTION step itself (org.nr lookup, document fetch attempt) has no existing cache; consider a short-lived per-analysis-id lock/cache on `resolveOrgNr`/`fetchArsredovisning` results so a user re-triggering auto-fetch (e.g., via page reload during the `auto_fetching` status) doesn't re-scrape Allabrf on every reload — mirrors the existing `generateReport` CAS in-flight lock pattern referenced in STATE.md |
| GDPR-adjacent: persisting a fetched document/org.nr for the wrong user's analysis row | Information Disclosure | Ownership check (`row.user_id === user.id`) before any write, identical to existing `analyzeBrf`/`correctBrfField` pattern — no new risk surface if this convention is followed exactly |

## Sources

### Primary (HIGH confidence)
- Codebase: `src/actions/analyze-brf.ts`, `src/lib/brf/extract.ts`, `src/lib/brf/cost.ts`, `src/lib/schemas/brf.ts`, `src/lib/booli/client.ts`, `src/lib/booli/fallback-tree.ts`, `src/components/brf-section.tsx`, `src/components/brf-progress.tsx`, `supabase/migrations/002_brf.sql` — read directly, ground truth for the refactor target
- `.planning/STATE.md`, `.planning/REQUIREMENTS.md`, `.planning/phases/08-brf-auto-fetch/08-CONTEXT.md` — project decision history and locked constraints

### Secondary (MEDIUM confidence)
- Bolagsverket API product structure (paid Företagsinformation API vs free öppna-data bulk feed vs metadata-only årsredovisningsinformation APIs) — cross-verified across 3 independent WebSearch queries returning consistent descriptions of connection-fee pricing and metadata-only scope
- `media.bolagsverket.se/diar/services/1.1/hamtaArsredovisningsinformation-1.1-en.html` — fetched directly, confirmed metadata-only (`arendestatus`/`grunduppgifter` endpoints), no auth details disclosed
- Anthropic `document` content block `text/plain` source type — [CITED: platform.claude.com/docs/en/build-with-claude/citations], corroborated by a second independent source (Simon Willison's Citations API writeup)
- Bolagsverket devportal existence (`portal.api.bolagsverket.se/devportal`, WSO2 APIM, OAuth via `gw.api.bolagsverket.se/authorize`) — found via WebSearch, page fetch itself returned no usable content (JS-rendered SPA), so the OAuth/registration claim is WebSearch-summary-only

### Tertiary (LOW confidence)
- Allabrf.se ToS/legal posture and BRF-Data pricing — not independently verified beyond a WebSearch summary of their own marketing page; robots.txt only confirmed `Disallow: /api` (general page scraping not technically blocked, but ToS posture unverified)
- allabolag.se as a free, scrapeable org.nr-by-name resolver — WebSearch-derived; a direct WebFetch of a specific BRF's allabolag.se page failed to return usable content (empty/blocked), so the actual page structure/search mechanics were NOT verified live
- Whether Bolagsverket's website bot-wall (F5/TSPD) also protects the actual API subdomains (`portal.api.bolagsverket.se`, `gw.api.bolagsverket.se`) — only the marketing site (`bolagsverket.se`) was confirmed blocked; the API subdomains were not directly probed with curl in this session

## Metadata

**Confidence breakdown:**
- Standard stack: MEDIUM — no new packages needed is HIGH confidence (verified against package.json + Anthropic docs), but the org.nr-resolution source choice (allabolag.se vs Allabrf) is LOW confidence pending live verification
- Architecture: MEDIUM — the shared `runBrfExtraction` refactor pattern is directly derived from reading the actual `analyze-brf.ts` file (HIGH), but the fallback-tree generalization decision (Pattern 3) needs the planner to read `fallback-tree.test.ts` before committing
- Pitfalls: MEDIUM-HIGH — Pitfalls 1/2/3 are grounded in directly-fetched/cross-verified source material about Bolagsverket's actual product boundaries; Pitfalls 4/5 are domain-reasoning (BRF name collisions, fiscal year lag) consistent with the phase's own stated success criteria

**Research date:** 2026-07-06
**Valid until:** 30 days (Bolagsverket API/pricing pages) — registry API terms change infrequently, but the LOW-confidence live-access details (Open Questions 1-2, Assumptions A1-A5) should be re-verified by the operator via actual devportal registration before or during Wave 0, rather than trusted as-is from this research pass.
