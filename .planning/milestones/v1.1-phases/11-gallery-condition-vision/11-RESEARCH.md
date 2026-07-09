# Phase 11: Gallery Condition Vision - Research

**Researched:** 2026-07-07
**Domain:** Anthropic vision (multimodal structured output), cost-bounded AI pipelines, hedged/cited AI presentation
**Confidence:** HIGH (Anthropic mechanics + cost math, codebase precedent) / MEDIUM (gallery-URL availability, real-world accuracy) / LOW (live validation-gate outcome — cannot be resolved without operator-run data)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Locked design constraints (from ROADMAP — binding):**
- **Structural separation:** Vision output lives in its OWN clearly-labeled section ("AI-bedömning av bilder — kan vara fel"), NEVER styled like a deterministic flag and NEVER fed into the numeric score / deterministic flag system. If a vision signal ever informs anything scored, it must carry a visible "från bildtolkning" marker.
- **Image citation (mandatory):** the extraction schema FORCES each claim to cite which image + what specifically was seen (extends the Phase 2/4 structured-output + citation pattern). No uncited vision claim.
- **Hedged language:** claims are hedged evidence ("köket verkar renoverat"), never verdicts.
- **Cost discipline (hard):** Haiku pre-filter → Sonnet only on promising candidates; cap images/listing (floor plan + 2–3 gallery, NOT the full gallery); per-search SEK/image cap checked incrementally; cache per `booliId`. Must stay under the <$100/mo budget posture.
- **PII/GDPR:** vision prompt explicitly IGNORES people and personal documents; no vision claim references a person or personal document visible in photos.
- **Validation gate (kill criterion):** validate on 20–30 real listings with manually-checked ground truth BEFORE shipping. If accuracy is too low to present even as hedged evidence, or per-search vision cost can't stay under the cap → CUT gallery vision, ship discovery with text ranking only.

**Discovery-surface constraints (carried):**
- Part of the discovery surface, gated behind `DISCOVERY_ENABLED` (OFF by default).
- Additive-nullable persistence; reuse Phase 9 job infra + incremental cost caps; feed hedged signals alongside (not into) Phase 10 ranking.

**Anthropic API caveats (from project memory):**
- Strict `output_config.format` 400s on too many nullable→union params / numeric constraints — keep the vision schema slim; run ONE live API smoke before relying on mocked tests (see `[[anthropic-structured-output-limits]]`).
- Use current models; determine exact model IDs from the existing codebase (Haiku for pre-filter / Sonnet for the deep pass, mirroring `costSek`/`costSekSonnet`).

### Claude's Discretion
All other choices at Claude's discretion within these constraints and DISC-04 success criteria.

### Deferred Ideas (OUT OF SCOPE)
- Floor-plan remodel-potential + sun-path → Phase 12.
- The actual 20–30-listing live validation run (needs real images + labeled ground truth + flag ON) → operator UAT / validation gate.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DISC-04 | System derives soft condition attributes (e.g. kitchen/bathroom dated vs modern) from description + gallery images via vision — each claim cited to its source image, presented as hedged evidence, structurally separate from deterministic flags | Standard Stack (model IDs, message shape), Architecture Patterns (two-pass Haiku→Sonnet pipeline, citation schema), Cost Math (per-listing/per-search SEK, caps), Runtime gap analysis (gallery URLs not persisted — recommended v1 fetch path), Evaluation Strategy (20–30-listing gate) |
</phase_requirements>

## Summary

Phase 11 adds a two-pass vision pipeline (Haiku pre-filter → Sonnet deep pass) that derives hedged, image-cited condition attributes (kitchen/bathroom dated-vs-modern, overall condition) from a capped image set (floor plan + 2–3 gallery photos) per discovery candidate. The mechanics are well-documented and match this codebase's existing patterns closely: Anthropic image content blocks (`type: "image"`, `source: {type: "url"|"base64"|"file"}`) compose with `messages.parse` + `zodOutputFormat` exactly like `extract.ts`/`synthesize.ts` already do — no new SDK surface, no new client, no new library. The main technical risk is NOT vision mechanics; it is **gallery image availability**: Phase 9's `DiscoveryCandidate` allowlist and `reshapeListingEntity` do not currently extract or persist any gallery image URLs (`thumbnailUrl` is dead code — always `null` in practice), so this phase must add a first-class, cost-capped, PII-safe image-URL fetch/allowlist step before any vision call can run.

Cost math is favorable: at the current standard-tier token formula (`⌈w/28⌉×⌈h/28⌉` visual tokens, capped at 1568 tokens/image for Haiku 4.5 and Sonnet 4.6, both outside the high-resolution tier), a worst-case 4-image (1 floor plan + 3 gallery) Haiku pre-filter + Sonnet deep pass costs roughly 0.37 SEK/listing if EVERY candidate gets both passes, and realistically ~0.17 SEK/listing when Sonnet only runs on the ~30% of candidates the Haiku pre-filter flags as "promising." Against Phase 9's `CAP_CANDIDATES_MAX = 25`, worst-case per-search vision spend is ≈9.25 SEK; realistic per-search spend is ≈4.2 SEK. This is additive to Phase 9's existing `CAP_SEK_MAX = 5` (scrape+parse only) — the phase must introduce a SEPARATE, named vision cost cap (recommended: `CAP_VISION_SEK_MAX = 10` per search) rather than silently exceeding the existing discovery cap.

The validation gate (20–30 real listings, manual ground truth, accuracy threshold) is the swing factor for whether this phase ships at all. The harness, fixture format, and rubric can and should be built now (mirroring `evals/extractor.eval.ts`'s `RUN_LLM_EVALS`-gated, labels.json-keyed pattern); the actual run against real images requires the operator to gather ground truth and is explicitly deferred, exactly as CONTEXT.md specifies.

**Primary recommendation:** Build the full pipeline (image-URL extension to `DiscoveryCandidate`, Haiku pre-filter, Sonnet deep pass, citation schema, structural-separation UI shell per 11-UI-SPEC.md, caching by `booliId`, cost caps) and the eval harness now; gate the LIVE 20–30-listing accuracy run and the `DISCOVERY_ENABLED`+vision-flag production flip behind explicit operator sign-off, per CONTEXT.md's kill-criterion design.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Gallery image URL discovery/extraction | Backend (owned Booli client, `src/lib/booli/client.ts`) | — | Image URLs live in the same `Listing:` Apollo entity `reshapeListingEntity` already parses; extracting them is a scrape-time concern, not a vision-time concern |
| Image-set selection (floor plan + N gallery, cap enforcement) | Backend (`src/lib/discovery/job.ts` or new `src/lib/discovery/vision.ts`) | — | Must happen BEFORE any Anthropic call — this is where the hard image-count cap is enforced, mirroring `runSlice`'s incremental-cap-before-spend discipline |
| Haiku pre-filter call | Backend (Anthropic client, server-only) | — | API key must never reach the browser (existing T-02-09 constraint); mirrors `extract.ts`/`parse-intent.ts` |
| Sonnet deep-pass call | Backend (Anthropic client, server-only) | — | Same as above; gated on pre-filter output |
| Vision result persistence (additive-nullable) | Database (Supabase `discovery_jobs.results` JSONB, or new column) | — | Mirrors Phase 9/10's additive-nullable-JSONB-on-candidate convention; no migration needed if kept inside the existing `results` JSONB shape |
| Vision result caching by `booliId` | Backend (new cache table OR reuse of existing candidate persistence) | Database | Cross-job/cross-user reuse requires a `booliId`-keyed cache independent of any single `discovery_jobs` row (a candidate can appear in multiple users' searches) |
| Structural-separation rendering (own Card, terracotta marker, no severity badge) | Frontend (React component, `gallery-condition-vision.tsx`) | — | Fully specified in `11-UI-SPEC.md` — pure presentation, reads the persisted vision shape only |
| Cost cap enforcement (per-search vision SEK ceiling) | Backend (`src/lib/discovery/cost.ts` extension) | — | Must be checked incrementally BEFORE each Sonnet call, mirroring `runSlice`'s pre-check-before-scrape pattern (Phase 9 Pitfall/Anti-Pattern) |
| PII/GDPR prompt discipline (ignore people/documents) | Backend (system prompt text) | — | Enforced via prompt instruction + schema shape (no "person" field to fill), not a separate filter stage |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@anthropic-ai/sdk` | `^0.102.0` (already installed — `[VERIFIED: package.json]`) | Vision + structured-output calls | Already the sole LLM client in this codebase (`extract.ts`, `synthesize.ts`, `parse-intent.ts`); no new dependency |
| `zod/v4` (`zod`) | already installed | Claude-facing + persisted-shape schemas | Matches every existing schema module (`brf.ts`, `report.ts`, `filter-schema.ts`, `candidate.ts`) |

No new npm packages are required for this phase — vision is a capability of the already-installed Anthropic SDK, not a separate library. **Package Legitimacy Audit is not applicable** (no new packages installed).

### Model IDs (verified against current codebase constants + current Anthropic docs)

| Model | ID (as used in this codebase) | Role | Source |
|-------|-------------------------------|------|--------|
| Claude Haiku 4.5 | `"claude-haiku-4-5-20251001"` | Pre-filter pass (cheap triage: "is this image worth a deep look, and for which attribute?") | `[VERIFIED: src/lib/brf/extract.ts:22, src/lib/discovery/parse-intent.ts]` — dated snapshot id, matches existing extraction/intent-parse model |
| Claude Sonnet 4.6 | `"claude-sonnet-4-6"` | Deep pass (hedged, cited condition-attribute extraction) | `[VERIFIED: src/lib/report/synthesize.ts:24]` — bare id, NO date suffix, matches this codebase's synthesis model exactly |

Both IDs are read directly from live production code in this repository, not training-data guesses — `[VERIFIED: codebase]`. Do not introduce a third model id (e.g. Opus) for this phase; it is not used anywhere else in the codebase and is not needed for a triage+extraction pipeline (Opus 4.8's high-resolution tier would also change the cost formula materially — see Cost Math below).

**Pricing (per MTok, USD), confirmed current via official docs:**

| Model | Input | Output | Cache write (5m) | Cache read | Source |
|-------|-------|--------|-------------------|------------|--------|
| Haiku 4.5 | $1.00 | $5.00 | $1.25 | $0.10 | `[VERIFIED: src/lib/brf/cost.ts USD_PER_MTOK]`, cross-checked `[CITED: platform.claude.com/docs/en/about-claude/pricing]` |
| Sonnet 4.6 | $3.00 | $15.00 | $3.75 | $0.30 | `[VERIFIED: src/lib/brf/cost.ts SONNET_USD_PER_MTOK]`, cross-checked `[CITED: platform.claude.com/docs/en/about-claude/pricing]` |

These match the codebase's existing `USD_PER_MTOK`/`SONNET_USD_PER_MTOK` constants exactly — reuse `costSek`/`costSekSonnet` from `src/lib/brf/cost.ts` unchanged for vision-call cost accounting; do not redefine new rate constants.

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| none new | — | — | — |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Anthropic vision (Haiku+Sonnet) | A dedicated CV/classification model (e.g. a fine-tuned image classifier) | Massively more engineering for a solo dev; loses the hedged-natural-language + citation format the UI-SPEC requires; rejected |
| URL-based image source | Base64-inline images | URL source avoids an extra fetch+encode step server-side and keeps request payloads small, BUT requires the image URL to be publicly fetchable by Anthropic's servers (Booli CDN URLs are public — acceptable) and does not support caching via `cache_control` the same way document blocks do. Recommended: URL source for gallery images (simplest, matches Booli's already-public CDN URLs); base64 only as a fallback if a URL ever proves unfetchable server-side by Anthropic |
| Per-listing live fetch of images at vision time | Persisting gallery URLs at discovery-scrape time (Phase 9-style) | Both viable; recommended approach is to persist a small `imageUrls: string[]` array on `DiscoveryCandidate` at scrape time (near-zero marginal cost — the Apollo entity already contains this data) rather than a second live fetch per vision call (see "Where gallery image URLs come from" below) |

**Installation:** N/A — no new packages.

**Version verification:**
```bash
npm view @anthropic-ai/sdk version
# 0.x current; project already pinned to ^0.102.0, confirmed installed
```

## Package Legitimacy Audit

**Not applicable — this phase installs zero new external packages.** All required capability (vision content blocks, structured output) is provided by `@anthropic-ai/sdk`, already installed and already in production use in this codebase (`extract.ts`, `synthesize.ts`, `parse-intent.ts`). No slopcheck/registry verification is required.

## Architecture Patterns

### System Architecture Diagram

```
Discovery job (existing, Phase 9)
        │
        ▼
 DiscoveryCandidate[] (extended: + imageUrls: string[] | null)
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│  Vision slice (NEW — src/lib/discovery/vision.ts)          │
│                                                             │
│  1. Per candidate: check cache by booliId                  │
│     → cache hit: reuse persisted vision result, skip below │
│     → cache miss: continue                                 │
│                                                             │
│  2. Select image set: floor plan (1) + gallery (≤3)         │
│     → CAP_IMAGES_PER_LISTING enforced HERE (hard cap)       │
│     → no imageUrls at all → skip vision, "no gallery" state │
│                                                             │
│  3. Cost pre-check (incremental, BEFORE any call)           │
│     → running vision SEK spend + estimated call cost        │
│       > CAP_VISION_SEK_MAX → skip remaining candidates,     │
│       mark job "vision cap reached" (mirrors runSlice)      │
│                                                             │
│  4. Haiku pre-filter call (cheap triage)                    │
│     → images + slim schema: "which images show kitchen/     │
│       bathroom/overall condition, worth a deep look?"       │
│     → if nothing promising: persist empty vision result,    │
│       stop (no Sonnet call for this candidate)              │
│                                                             │
│  5. Sonnet deep pass (only for "promising" candidates)      │
│     → same image set (or the Haiku-flagged subset)          │
│     → slim schema: per-attribute {hedgedClaim, imageIndex,  │
│       whatWasSeen, confidence}                              │
│     → confidence < threshold → claim dropped (never shown)  │
│                                                             │
│  6. Persist result: booliId-keyed cache + candidate-level    │
│     vision field (additive-nullable JSONB)                  │
└───────────────────────────────────────────────────────────┘
        │
        ▼
 Candidate/analysis view (Frontend, per 11-UI-SPEC.md)
   → renders OWN Card, "AI-bedömning av bilder — kan vara fel"
   → NEVER read by computeNicheScore / ReportFlags
```

### Recommended Project Structure

```
src/lib/discovery/
├── vision.ts              # NEW: image-set selection, cache lookup, cost pre-check, orchestration
├── vision.test.ts         # NEW: unit tests (mocked Anthropic calls)
├── vision-schema.ts        # NEW: slim Claude-facing schemas (pre-filter + deep-pass) + persisted-shape Zod guard
├── vision-schema.test.ts
├── candidate.ts            # MODIFIED: add imageUrls: string[] | null to DiscoveryCandidate + toCandidate + discoveryCandidateSchema
├── candidate.test.ts        # MODIFIED: extend allowlist tests
├── cost.ts                  # MODIFIED: add visionCostSek (Haiku+Sonnet image-call cost), CAP_VISION_SEK_MAX
└── job.ts                   # MODIFIED (or left untouched if vision runs as a distinct slice/tick)

src/components/
└── gallery-condition-vision.tsx   # NEW: per 11-UI-SPEC.md component inventory §1-3

evals/
├── vision.eval.ts            # NEW: mirrors extractor.eval.ts — RUN_LLM_EVALS-gated, labels.json-keyed
├── vision-labels.example.json # NEW: label shape documentation (gitignored real labels.json)
└── fixtures/vision/           # NEW: gitignored real listing image sets + ground truth (operator-populated)
```

### Pattern 1: Two-Pass Haiku-Filter → Sonnet-Deep-Pass

**What:** A cheap, high-recall Haiku call screens all available images for "worth a deep look," then only the flagged subset (or flagged candidates) get the more expensive Sonnet call.
**When to use:** Any vision workload where most images/candidates will NOT yield an interesting signal, and the cost difference between tiers is meaningful (Sonnet input is 3× Haiku's rate here).
**Example:**
```typescript
// Source: mirrors src/lib/brf/extract.ts's runOnce() shape, extended with image content blocks (platform.claude.com/docs/en/build-with-claude/vision)
const client = new Anthropic();
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const SONNET_MODEL = "claude-sonnet-4-6";

async function preFilter(imageUrls: string[]): Promise<PreFilterResult> {
  const message = await client.beta.messages.parse({
    model: HAIKU_MODEL,
    max_tokens: 512,
    temperature: 0,
    system: VISION_PREFILTER_SYSTEM_PROMPT, // includes PII-ignore instruction
    messages: [
      {
        role: "user",
        content: [
          ...imageUrls.flatMap((url, i) => [
            { type: "text" as const, text: `Bild ${i + 1}:` },
            { type: "image" as const, source: { type: "url" as const, url } },
          ]),
          { type: "text", text: "Vilka bilder är värda en djupare granskning av skick?" },
        ],
      },
    ],
    output_config: { format: zodOutputFormat(preFilterSchema) },
  });
  if (!message.parsed_output) throw new Error("CLAUDE_PARSE_EMPTY");
  return message.parsed_output;
}
```

### Pattern 2: Image-Indexed Citation Schema (slim, avoids the 400 trap)

**What:** Each condition attribute is its own top-level field (not a nested array with per-field nullable unions), following `extract.ts`'s documented workaround for "too many nullable→union params."
**When to use:** Any structured-output schema that must cite one of several images.
**Example:**
```typescript
// Source: mirrors src/lib/brf/extract.ts's claudeField() pattern — ONLY `value`/`claim` nullable, NO .min()/.max()/.int() chains
const conditionAttribute = z.object({
  claim: z.string().nullable().describe(
    "Hedged Swedish claim, e.g. 'Köket verkar renoverat'. Null if not assessable from the images.",
  ),
  imageIndex: z.number().describe(
    "1-based index into the images sent (matches the 'Bild N:' label), or 0 if claim is null.",
  ),
  whatWasSeen: z.string().describe(
    "Specifically what visual detail supports the claim, e.g. 'nya vitvaror, kaklat stänkskydd'. Empty string if claim is null.",
  ),
  confidence: z.number().describe("0-1 confidence in this claim."),
});

const visionDeepPassSchema = z.object({
  kitchen: conditionAttribute,
  bathroom: conditionAttribute,
  overall: conditionAttribute,
});
// 3 fields × 4 sub-fields = 12 total leaf fields, only 3 nullable (`claim`) —
// well under the ~28-nullable-union threshold that tripped extract.ts's original schema.
```

### Pattern 3: booliId-Keyed Caching

**What:** Vision results are cached per `booliId`, independent of any single discovery job, so the same listing surfacing in multiple users' searches (or a re-run search) does not re-spend on vision.
**When to use:** Any per-entity AI call whose input (the listing's images) is stable across jobs.
**Recommendation:** Store the cache as a JSONB column keyed by `booliId` in a small new table (`vision_cache`, additive migration) OR — simpler for v1 — persist the vision result directly on each `discovery_jobs.results[]` candidate entry (already keyed by listing) and additionally maintain an in-memory/per-tick dedupe map so a single job never vision-processes the same `booliId` twice within one run. A dedicated cross-job cache table is the more complete solution but is NOT required for the phase to ship — see Open Questions.

### Anti-Patterns to Avoid

- **Sending the full gallery (10-20+ images) to any model:** blows both the cost cap and the `CAP_IMAGES_PER_LISTING` design constraint. Always cap at 4 (1 floor plan + ≤3 gallery) before any Anthropic call.
- **Re-checking cost only after the call completes:** mirrors Phase 9's documented anti-pattern (09-PATTERNS.md) — the vision cost pre-check must run BEFORE each Sonnet call, using the running total, not a fresh SELECT.
- **Nesting all attributes in one deeply-nullable array-of-objects schema:** directly reproduces the documented 400 "too many union-type params" trap (`anthropic-structured-output-limits` memory). Keep each attribute a flat top-level field.
- **Feeding the vision result into `computeNicheScore` or `ReportFlags`:** explicitly out-of-scope (REQUIREMENTS.md "Out of Scope" list, UI-SPEC §4). Vision output must remain in its own read path, never merged into the deterministic scorer's input shape.
- **Using `image` + `citations: {enabled: true}` together with `output_config.format`:** mutually exclusive on this API (documented in `extract.ts`'s own code comment) — the citation must be modeled as a schema field (`imageIndex`/`whatWasSeen`), not the native citations feature.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Image resizing to control token cost | A custom image-resize pipeline | Rely on Anthropic's automatic downscaling (images larger than the tier's long-edge limit are downscaled server-side) OR simply reference Booli's already-CDN-served images at their existing served resolution — Booli listing photos are typically well under the 1568px standard-tier cap already | Anthropic resizes automatically; building a client-side resize step adds complexity for marginal savings given the small (≤4) image count per listing |
| Structured-output validation | Manual JSON parsing / regex extraction from free text | `messages.parse` + `zodOutputFormat` (already the established pattern in this codebase) | Guarantees schema-valid output, matches 3 other call sites exactly |
| Cost accounting | A new ad-hoc cost formula for vision calls | `costSek`/`costSekSonnet` from `src/lib/brf/cost.ts`, applied to the `usage` object `messages.parse` already returns (image tokens are counted as ordinary input tokens by the API — no separate accounting needed) | Vision tokens are billed as standard input tokens; the existing per-MTok cost functions already handle this correctly with zero modification |

**Key insight:** Nothing about "vision" requires new cost/validation/schema infrastructure in this codebase — it is the SAME `messages.parse` + `zodOutputFormat` + `costSek` pipeline already proven in `extract.ts`, with `image` content blocks added alongside `text`/`document` blocks. The genuinely new work is (1) sourcing the image URLs at all, (2) the two-pass triage orchestration, and (3) the structural-separation UI.

## Cost Math (Hard Gate)

### Per-image token cost (verified formula)

Anthropic bills images as `⌈width/28⌉ × ⌈height/28⌉` visual tokens `[CITED: platform.claude.com/docs/en/build-with-claude/vision]`. Both Haiku 4.5 and Sonnet 4.6 are in the **Standard** resolution tier (max long edge 1568px, max visual tokens 1568/image) — the High-resolution tier (2576px / 4784 tokens) applies only to Fable 5, Mythos 5, Opus 4.8, Opus 4.7, and Sonnet 5, none of which this phase uses `[CITED: same doc, Resolution and token cost table]`. Booli listing photos (~1200×800 to 1600×1200 typical) will either fit under or be auto-downscaled to the 1568-token cap — **worst case, budget 1568 tokens/image for both models.**

### Per-listing cost (4 images: 1 floor plan + 3 gallery)

| Stage | Model | Images | Input tokens (4×1568 + prompt overhead) | Output tokens | USD | SEK |
|-------|-------|--------|------------------------------------------|----------------|-----|-----|
| Pre-filter | Haiku 4.5 | 4 | ~6,570 | ~150 (slim triage schema) | $0.0073 | 0.081 |
| Deep pass | Sonnet 4.6 | 4 | ~6,770 | ~400 (3-attribute citation schema) | $0.0263 | 0.290 |
| **Worst case (both stages, every candidate)** | — | — | — | — | **$0.0336** | **0.370 SEK/listing** |

`[VERIFIED: computed from cited per-MTok rates + cited token formula]`. Computation: `usd = (tokensIn × rateIn + tokensOut × rateOut) / 1e6`.

### Per-search cost (`CAP_CANDIDATES_MAX = 25`, from Phase 9)

| Scenario | Assumption | Total SEK/search |
|----------|------------|-------------------|
| **Worst case** | Every one of 25 candidates gets BOTH Haiku pre-filter AND Sonnet deep pass | **9.25 SEK** |
| **Realistic** | All 25 get Haiku pre-filter; only ~30% (≈7-8) are flagged "promising" and get Sonnet | **4.18 SEK** |

### Monthly budget fit

At even 100 discovery searches/month (a generous solo-dev-product estimate — Phase 9's own posture assumes far fewer in early usage), worst-case vision spend is ≈925 SEK (~$84) and realistic spend is ≈418 SEK (~$38). This is IN ADDITION to Phase 9's existing per-search scrape/parse cost (`CAP_SEK_MAX = 5` SEK/search → 500 SEK/month worst case at 100 searches) and all other AI spend (BRF extraction, report synthesis). **Combined worst case at 100 searches/month: ~1425 SEK (~$130) — this alone would breach the <$100/mo posture if discovery volume is high.** The mitigating facts: (1) discovery is currently `DISCOVERY_ENABLED=OFF` and gated behind a separate legal go/no-go the operator has not yet cleared; (2) realistic per-search costs (Haiku-pre-filter-dominant) land at ~4.2 SEK, well under a sustainable volume; (3) `booliId` caching means REPEAT candidates across searches cost nothing on a cache hit, which matters heavily once a user base explores overlapping areas.

### Recommended caps (concrete, to be locked in code)

| Constant | Recommended Value | Rationale |
|----------|--------------------|-----------|
| `CAP_IMAGES_PER_LISTING` | `4` (1 floor plan + 3 gallery) | Matches CONTEXT.md's locked "floor plan + 2-3 gallery" language; upper bound of the stated range |
| `CAP_VISION_SEK_MAX` | `10` (SEK, per search, NEW constant — separate from Phase 9's `CAP_SEK_MAX = 5`) | Roughly 1 SEK above the worst-case-all-25-candidates figure (9.25 SEK) computed above, giving a small safety margin while still being a real, enforceable ceiling; checked incrementally before each Sonnet call exactly as `runSlice` does for scrape cost |
| `HAIKU_PREFILTER_TO_SONNET_FRACTION` (soft target, not a hard cap) | ~30% | Used only for planning/monitoring — the ACTUAL fraction is whatever Haiku's triage naturally flags; do not hard-code a candidate-selection quota, let the pre-filter's own judgment decide |
| `VISION_CONFIDENCE_THRESHOLD` | `0.6` (mirrors `parseIntent`'s existing low-confidence fail-safe threshold) | A claim below this confidence is dropped entirely (per UI-SPEC's "low-confidence claims are simply omitted, never shown greyed out") |

**Recommendation:** Do NOT merge `CAP_VISION_SEK_MAX` into the existing `CAP_SEK_MAX`. Keep them as two separate, independently-checked caps (scrape+parse cap vs. vision cap), because vision is an optional, potentially-skippable second pass over an already-completed candidate set — a job that hits its scrape cap should still be able to report candidates with NO vision data, and a job that hits its vision cap should stop running vision (not stop the whole job). This mirrors Phase 9's own separation of `CAP_CANDIDATES_MAX`/`CAP_SEK_MAX`/`CAP_IMAGES_PER_LISTING` as three independent named constants rather than one blended number.

## Where Gallery Image URLs Come From (RESOLVED gap)

**Finding (verified against the live codebase, not assumed):** `[VERIFIED: src/lib/discovery/candidate.ts]` — `DiscoveryCandidate.thumbnailUrl` is read via `str(raw.thumbnailUrl)` in `toCandidate`, but `[VERIFIED: src/lib/booli/client.ts reshapeListingEntity]` — `reshapeListingEntity` **never sets a `thumbnailUrl` key on the object it returns**. `reshapeListingEntity` reads `agency(` (via `argKeyedFieldOf`) but never reads the `images(`-prefixed Apollo ref that the file's own top-of-file comment (`client.ts:22`) documents as existing on the raw entity ("Apollo refs (`housingCoop`, `images`, `areas`, `location`)"). **`thumbnailUrl` is therefore dead/aspirational code today — it always evaluates to `null` in production.** Phase 11 cannot assume any image URL is currently available on a `DiscoveryCandidate`.

**Recommendation (v1 subset, buildable now):**

1. Add an `imageUrls` extractor to `reshapeListingEntity`, mirroring the existing `argKeyedFieldOf(entry, "agency(")` pattern but for the `images(`-prefixed ref: `argKeyedFieldOf(entry, "images(")`, parsed into a flat array of `{ url: string }`-shaped Apollo image refs (the exact ref shape must be confirmed against a live Apollo blob — this is the one open item requiring a live scrape, see Open Questions).
2. The floor plan is very likely a distinguishable item within this same `images` collection (Booli typically tags a `type`/`category` field per image, e.g. `"floorplan"` vs `"image"`) — if a type discriminator exists, use it to deterministically pick the floor plan; if not, fall back to "no floor plan available, gallery-only" (degrade gracefully, never guess).
3. Extend `DiscoveryCandidate` with a new PII-safe field: `imageUrls: string[] | null` (already-public CDN URLs, not PII — same class as `thumbnailUrl`/`sourceListingUrl`). Cap the persisted array length to `CAP_IMAGES_PER_LISTING` (4) AT EXTRACTION TIME, not at vision-call time, so the PII-safe allowlist itself never carries more than the phase's own image budget.
4. `toCandidate` reads this the same no-spread way every other field is read: `imageUrls: arrOfStr(raw.imageUrls)` (a new small helper mirroring `num`/`str`).
5. `discoveryCandidateSchema` gets `.nullable().default(null)` treatment for `imageUrls` (matches Phase 10's `constructionYear`/`brfName`/`tenureForm` precedent exactly — no migration, backward-compatible with pre-Phase-11 persisted rows).

This is a **v1 acceptable subset**: it depends on Booli's Apollo `images(` ref actually containing directly-usable, publicly-fetchable image URLs (very likely, since these are the same images rendered on the public listing page) and a live-render confirmation of the ref's exact shape (see Open Questions — this is the one item that needs a live probe before the extractor can be written with full confidence, same as Phase 6/9's own "confirm ref shape against a live Apollo blob" precedent).

**Alternative (rejected for v1):** Fetching images live from the broker page (`agencyListingUrl`, Phase 6's broker-fetch) instead of Booli's own Apollo data. Rejected because it adds a second network fetch per candidate (cost + latency + a second SSRF-guard surface) for data Booli's own Apollo blob almost certainly already contains at zero marginal scrape cost.

## Structural Separation + Citation (Persisted Shape)

**Recommendation: additive-nullable, NO migration required.** Mirror Phase 10's own resolved pattern (`.nullable().optional()` extension of `DiscoveryCandidate`'s allowlist, no migration) rather than a new `discovery_jobs` column or a new table.

```typescript
// src/lib/discovery/vision-schema.ts (NEW)

/** One hedged, image-cited condition claim (persisted shape, mirrors flags.ts's SoftSignalField). */
export interface VisionConditionClaim {
  attribute: "kitchen" | "bathroom" | "overall";
  claim: string;          // hedged Swedish text, e.g. "Köket verkar renoverat"
  imageIndex: number;     // 1-based, matches "Bild N" in the image set sent
  whatWasSeen: string;    // supporting visual detail
  confidence: number;     // 0-1; UI-SPEC: claims < VISION_CONFIDENCE_THRESHOLD are dropped before persistence
}

/** The full per-candidate vision result — additive-nullable field on DiscoveryCandidate. */
export interface VisionResult {
  claims: VisionConditionClaim[];   // empty array = "ran, nothing assessable" (UI-SPEC "low-confidence suppressed" state)
  imageUrlsUsed: string[];          // the exact images sent, for thumbnail rendering (Bild N → imageUrlsUsed[N-1])
  model: string;                    // which model produced this (Sonnet id) — trace/audit, mirrors report.ts's `model` field
  costSek: number;                  // this candidate's vision spend — trace, feeds the incremental cost cap
  ranAt: string;                    // ISO timestamp — supports cache TTL decisions later if needed
}

// DiscoveryCandidate extension (additive, nullable — mirrors Phase 10's exact pattern):
//   vision: VisionResult | null;
// discoveryCandidateSchema extension:
//   vision: visionResultSchema.nullable().default(null),
```

Three distinct states must be representable and are already anticipated by `11-UI-SPEC.md`:
- `vision: null` → "no gallery available" OR "vision skipped due to cost cap" (distinguish via a second small flag, e.g. `visionSkippedReason: "no_images" | "cost_cap" | null`, also additive-nullable)
- `vision: { claims: [], ... }` → vision ran, nothing cleared the confidence bar ("För osäkert för att visa…")
- `vision: { claims: [...one or more], ... }` → normal render path, one row per claim

This shape is a direct extension of the Phase 2/4 citation pattern (`SoftSignalField<T>` in `flags.ts`, `citedClaim` in `report.ts`) — same "cite the source, hedge the language, omit rather than fabricate" discipline, applied to an image index instead of a page ref.

**Rendering:** `gallery-condition-vision.tsx` (per UI-SPEC) reads `candidate.vision`, resolves `imageUrlsUsed[claim.imageIndex - 1]` for the thumbnail, and NEVER passes `vision` into `computeNicheScore` or any `ReportFlags`-adjacent code path — enforced by simply not importing `vision-schema.ts` types anywhere inside `niche-score.ts`/`flags.ts` (a grep-able invariant worth a one-line test assertion, mirroring how `job.integration.test.ts` proves non-re-read via a throwing mock).

## Caching Per booliId + PII-Ignore Prompt Design

### Caching

**Recommendation (v1, buildable now):** Persist the `VisionResult` directly on each candidate row inside `discovery_jobs.results` (no new table). Within a SINGLE job's `runSlice`-equivalent vision pass, deduplicate by `booliId` using an in-memory `Map<string, VisionResult>` so a candidate appearing twice in one job's results (should not normally happen, but candidate lists could theoretically overlap across paginated scrapes) is never vision-processed twice. **Cross-job caching (the same listing surfacing in a DIFFERENT user's search) is a v2 concern** — it requires a `booliId`-keyed table independent of `discovery_jobs`, which is a real migration (012) but not required for DISC-04's success criteria to be met. Document this explicitly as a deferred optimization (see Open Questions) rather than silently building only the weaker per-job dedupe and calling it "caching."

**If cross-job caching is wanted in Phase 11 itself** (Claude's discretion — CONTEXT.md leaves this open): add `supabase/migrations/012_vision_cache.sql` with a simple `vision_cache(booli_id TEXT PRIMARY KEY, result JSONB, cost_sek NUMERIC, ran_at TIMESTAMPTZ)` table, no RLS needed if it's never queried by user session directly (only read/written server-side by the vision orchestrator via the service-role-equivalent path, mirroring `macro_snapshots`' any-authenticated-user RLS precedent if a client-side read is ever needed). This is additive and low-risk; recommend building it if time allows, but not blocking.

### PII-ignore prompt design

Mirror the existing coded-error + GDPR-safe-log discipline (`extract.ts`, `synthesize.ts`): the system prompt for BOTH Haiku pre-filter and Sonnet deep pass must include an explicit instruction, e.g.:

> "Ignorera helt eventuella människor eller personliga dokument (post, fakturor, ID-handlingar, foton av personer) som syns i bilderna. Kommentera ALDRIG på personer eller identifierbar information i bilderna — fokusera uteslutande på rummets skick (kök, badrum, allmänt skick)."

This is enforced structurally, not just by prompt text: the output schema (`conditionAttribute`) has NO field capable of referencing a person (no `peopleSeen`, no free-text field wide enough to smuggle in a physical description) — mirrors `reportSchema`'s "no verdict field" trick (D-04/FM2) applied to PII instead of verdicts. `whatWasSeen`'s `.describe()` text should explicitly steer toward physical fixtures/finishes ("t.ex. kakel, vitvaror, golv"), not people.

**Log discipline:** exactly like `extract.ts`/`synthesize.ts`, catch blocks log ONLY `{ booliId, code }` server-side — never the image URLs, the claim text, or any model output — on failure.

## Common Pitfalls

### Pitfall 1: Assuming `thumbnailUrl` already provides an image to show/vision

**What goes wrong:** A planner or implementer sees `thumbnailUrl: string | null` already on `DiscoveryCandidate` and assumes gallery images are "already there" — then discovers at implementation time that it's always `null`.
**Why it happens:** The field exists in the type and schema (Phase 9 declared it as a forward-looking contract placeholder) but no code path ever populates it.
**How to avoid:** Treat `imageUrls` as entirely new work — verify with a live-render probe (see Open Questions) before writing the extractor, exactly as Phase 5/6/9 each did for their own new Apollo-ref extractions.
**Warning signs:** Any test fixture where `thumbnailUrl`/`imageUrls` is hand-populated rather than derived from a real captured Apollo blob.

### Pitfall 2: Blending the vision cost cap into the existing discovery cost cap

**What goes wrong:** Reusing `CAP_SEK_MAX` (5 SEK) for both scrape+parse AND vision silently halves the effective budget for both, or causes a job to abort scraping because vision (which should be optional/skippable) consumed the shared budget.
**Why it happens:** `CAP_SEK_MAX` is already a familiar, imported constant; reusing it feels like the path of least resistance.
**How to avoid:** Introduce `CAP_VISION_SEK_MAX` as a distinct, separately-tracked running total (a new counter column or a derived sum over `results[].vision.costSek`), checked independently before each Sonnet call.
**Warning signs:** A single `cost_sek_total` column being incremented by both scrape and vision spend with no way to distinguish which cap was hit.

### Pitfall 3: Triggering the "too many nullable→union params" 400 by over-nesting the vision schema

**What goes wrong:** A tempting first design is `attributes: z.array(z.object({name, claim, imageIndex, whatWasSeen, confidence}))` — a variable-length array of a 5-field object with 2+ nullable fields. Depending on schema depth this can retrigger the exact class of 400 documented in project memory.
**Why it happens:** An array-of-attributes feels more "correct" than 3 flat named fields.
**How to avoid:** Follow `extract.ts`'s resolved pattern exactly — flat, named top-level fields (`kitchen`, `bathroom`, `overall`), each a small fixed-shape object with only ONE nullable leaf (`claim`). Run the ONE live API smoke test (per project memory) before assuming any schema shape is safe — mocked tests will NOT catch this.
**Warning signs:** More than ~10-15 nullable leaf fields anywhere in the Claude-facing schema; any `.min()/.max()/.int()` chain on a numeric field sent to `output_config.format`.

### Pitfall 4: Letting the Haiku pre-filter's own hallucination risk propagate silently

**What goes wrong:** If Haiku's pre-filter says "image 2 shows a renovated kitchen" but is wrong, and Sonnet's deep pass is only shown the Haiku-selected subset, a bad pre-filter decision can silently narrow what Sonnet ever sees.
**Why it happens:** Two-pass triage pipelines can compound errors if the first pass filters OUT relevant images rather than just prioritizing them.
**How to avoid:** Recommend Sonnet's deep pass always receives the FULL capped image set (all 4), not just Haiku's flagged subset — Haiku's role is candidate-level triage ("is this listing worth a Sonnet call at all"), not image-level filtering within a candidate. This keeps the pipeline's cost savings (skipping whole candidates) without adding a second failure mode (a bad per-image filter).
**Warning signs:** A design where Sonnet's `content` array only includes images Haiku individually flagged, rather than the full per-candidate set.

### Pitfall 5: Confusing "vision cost cap reached" with "no images available" in the UI

**What goes wrong:** Both states render as generic "unavailable" text, defeating the UI-SPEC's explicit requirement that a user can tell "we didn't look" from "there was nothing to look at."
**Why it happens:** Both collapse to `vision: null` if not carefully distinguished.
**How to avoid:** Persist the `visionSkippedReason: "no_images" | "cost_cap" | null` discriminator field alongside `vision: null`, exactly per UI-SPEC's Copywriting Contract (two distinct copy strings already specified).
**Warning signs:** A single boolean `visionAvailable: boolean` instead of a reason enum.

## Code Examples

### Full-pipeline call shape (illustrative, combining Patterns 1+2+3)

```typescript
// Source: composed from src/lib/brf/extract.ts (runOnce/parse shape) +
// platform.claude.com/docs/en/build-with-claude/vision (image content blocks)
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { costSek, costSekSonnet } from "@/lib/brf/cost";

const client = new Anthropic();
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const SONNET_MODEL = "claude-sonnet-4-6";
const VISION_CONFIDENCE_THRESHOLD = 0.6;

function imageBlocks(urls: string[]) {
  return urls.flatMap((url, i) => [
    { type: "text" as const, text: `Bild ${i + 1}:` },
    { type: "image" as const, source: { type: "url" as const, url } },
  ]);
}

export async function runVisionForCandidate(
  booliId: string,
  imageUrls: string[],
): Promise<{ result: VisionResult | null; skippedReason: "no_images" | null }> {
  if (imageUrls.length === 0) {
    return { result: null, skippedReason: "no_images" };
  }
  const capped = imageUrls.slice(0, 4); // CAP_IMAGES_PER_LISTING

  // 1. Haiku pre-filter (candidate-level triage)
  const preFilterMsg = await client.beta.messages.parse({
    model: HAIKU_MODEL,
    max_tokens: 300,
    temperature: 0,
    system: VISION_PREFILTER_SYSTEM_PROMPT,
    messages: [{ role: "user", content: [...imageBlocks(capped), { type: "text", text: "Är någon bild värd en djupare granskning?" }] }],
    output_config: { format: zodOutputFormat(preFilterSchema) },
  });
  const haikuCost = costSek(preFilterMsg.usage);
  if (!preFilterMsg.parsed_output?.worthDeepPass) {
    return { result: { claims: [], imageUrlsUsed: capped, model: HAIKU_MODEL, costSek: haikuCost, ranAt: new Date().toISOString() }, skippedReason: null };
  }

  // 2. Sonnet deep pass (full capped set, per Pitfall 4)
  const deepMsg = await client.messages.parse({
    model: SONNET_MODEL,
    max_tokens: 600,
    temperature: 0,
    system: VISION_DEEPPASS_SYSTEM_PROMPT,
    messages: [{ role: "user", content: [...imageBlocks(capped), { type: "text", text: "Bedöm kök, badrum och allmänt skick enligt schemat." }] }],
    output_config: { format: zodOutputFormat(visionDeepPassSchema) },
  });
  if (!deepMsg.parsed_output) throw new Error("CLAUDE_PARSE_EMPTY");
  const sonnetCost = costSekSonnet(deepMsg.usage);

  const claims: VisionConditionClaim[] = (["kitchen", "bathroom", "overall"] as const)
    .map((attribute) => ({ attribute, ...deepMsg.parsed_output![attribute] }))
    .filter((c) => c.claim !== null && c.confidence >= VISION_CONFIDENCE_THRESHOLD)
    .map((c) => ({ attribute: c.attribute, claim: c.claim!, imageIndex: c.imageIndex, whatWasSeen: c.whatWasSeen, confidence: c.confidence }));

  return {
    result: { claims, imageUrlsUsed: capped, model: SONNET_MODEL, costSek: haikuCost + sonnetCost, ranAt: new Date().toISOString() },
    skippedReason: null,
  };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Top-level `output_format` param | `output_config: { format: zodOutputFormat(schema) }` | Already reflected correctly in this codebase's `extract.ts`/`synthesize.ts` comments — no change needed for this phase | Confirms the pattern to copy is current, not stale |
| Pixel-based image token estimate (`w×h/750`) | Patch-based (`⌈w/28⌉×⌈h/28⌉` visual tokens), tiered by model resolution class | Current Anthropic docs (2026) | The cost math in this document uses the CURRENT patch-based formula, not the older approximate `/750` heuristic some third-party blog posts still cite — always compute from the official table, not the older shorthand |

**Deprecated/outdated:** None specific to this phase beyond the above — the vision API surface used here (image content blocks, `messages.parse`, `zodOutputFormat`) is the current, non-deprecated shape.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Booli's Apollo `images(`-prefixed ref contains directly-fetchable public CDN image URLs in a shape parseable by a new `argKeyedFieldOf(entry, "images(")` extractor, mirroring the `agency(` pattern | Where Gallery Image URLs Come From | If the ref shape differs (e.g. requires an additional per-image resolve call, or URLs are session-scoped/signed and not fetchable by Anthropic's servers), the URL-source vision approach fails and base64 fetch-then-inline becomes mandatory — more engineering, same core viability |
| A2 | A floor-plan image is distinguishable from gallery photos via a `type`/`category` discriminator inside the same `images` ref | Where Gallery Image URLs Come From | If no discriminator exists, floor plan cannot be reliably selected — degrade to gallery-only (3-4 gallery images, no floor plan) rather than guessing |
| A3 | Booli listing photos are typically ≤1568px on their long edge (or Anthropic's auto-downscale caps the cost regardless) | Cost Math | If photos are frequently much larger AND above the 1568-token cap in a way that increases actual billed tokens, the cost math changes — but the doc's worst-case number already assumes the 1568-token CAP per image, so this is self-correcting (the cap is the ceiling regardless of true photo resolution) |
| A4 | ~30% of candidates will be flagged "promising" by the Haiku pre-filter (used only as a planning/monitoring estimate, not a hard-coded quota) | Cost Math | If the real fraction is much higher (e.g. Haiku is too permissive), realistic per-search cost drifts toward the worst-case 9.25 SEK figure — still under the recommended `CAP_VISION_SEK_MAX = 10`, so the cap remains the actual safety net regardless of this assumption's accuracy |
| A5 | A 20-30% relative accuracy threshold framing (see Evaluation Strategy) is an appropriate bar for "hedged evidence" — this is a product/UX judgment call, not a technical fact | Evaluation Strategy | This is explicitly the operator's call at the validation gate, not something research can resolve; documented as a recommended STARTING rubric only |

**Note:** A1/A2 require a live-render probe against a real Booli area-search or single-listing render (the SAME technique Phase 5/6/9 already used to pin their own Apollo ref shapes) before the extractor code can be written with full confidence — this is buildable-now IF a live probe is run during planning/Wave 0, or can be the first implementation task with an inline fallback if the assumed shape doesn't match.

## Open Questions (RESOLVED)
1. **Exact shape of the Apollo `images(` ref** (RESOLVED — recommendation: probe first, then implement)
   - What we know: `client.ts`'s own top-of-file comment confirms an `images` Apollo ref exists on the raw entity; the `agency(` ref precedent shows arg-keyed refs are `argKeyedFieldOf`-retrievable.
   - What's unclear: the exact field names inside each image ref item (URL field name, whether a floor-plan discriminator exists, whether URLs are directly public or need a second resolve).
   - Recommendation: Wave 0 (or the first implementation task) should run a live `runPlaywrightRender` + `APOLLO_PAGE_FUNCTION` capture against one real listing URL and inspect the raw `images(...)` ref shape before finalizing `imageUrls`'s extractor — mirrors the exact "probe once against a live render, pin the shape in a doc comment" precedent set by `05-PROBE-FINDINGS.md`/Phase 6/Phase 9. This is buildable-now (does not require the operator; a live render is well within normal dev-time tooling, same as prior phases).

2. **Cross-job `booliId` caching: build now (migration 012) or defer to v2?** (RESOLVED — recommendation: defer, document explicitly)
   - What we know: per-job in-memory dedupe is trivial and sufficient for DISC-04's stated success criteria; cross-job caching requires a new table + migration.
   - What's unclear: how much real-world benefit cross-job caching provides before usage data exists (unknown search-overlap rate).
   - Recommendation: ship v1 with per-job dedupe only; document the `vision_cache` table (migration 012) as a fast-follow if operator usage data shows meaningful listing overlap across searches. Not a blocker for shipping DISC-04.

3. **What accuracy threshold triggers the CUT (validation gate)?** (RESOLVED — recommendation, not a hard fact)
   - What we know: CONTEXT.md specifies "if accuracy is too low to present even as hedged evidence... CUT gallery vision."
   - What's unclear: the exact numeric threshold — this is inherently a product judgment call about "how wrong can hedged AI evidence be before it's worse than nothing," not a technical fact research can derive.
   - Recommendation: see Evaluation Strategy below for a concrete starting rubric (per-attribute directional accuracy ≥ 70%, zero-hallucinated-citation rate = 100%) — the OPERATOR makes the final call at the gate using this rubric as a starting point, not a hard-coded pass/fail research can pre-decide.

4. **Does the Sonnet deep pass need `temperature: 0` or a small non-zero value?** (RESOLVED — recommendation: `temperature: 0`)
   - What we know: `synthesize.ts` uses `0.4` (deliberately, for "opinionated voice" in narrative prose); `extract.ts` and `parse-intent.ts` both use `0` (deterministic extraction).
   - Recommendation: vision condition extraction is closer to `extract.ts`'s "pull out a specific fact" task than `synthesize.ts`'s "write engaging prose" task — use `temperature: 0` for both pre-filter and deep pass, for reproducibility during the validation-gate eval run (a non-deterministic temperature would make the 20-30-listing ground-truth comparison noisier than necessary).

## Environment Availability

No new external tools/services/runtimes are introduced by this phase — it reuses the already-installed `@anthropic-ai/sdk` and the existing `ANTHROPIC_API_KEY` env var (already required and present for Phase 2/4's extraction/synthesis calls).

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `ANTHROPIC_API_KEY` | Vision calls (Haiku + Sonnet) | ✓ (already required by existing phases) | — | — |
| `@anthropic-ai/sdk` | Vision content-block support | ✓ | `^0.102.0` (installed) | — |
| Booli Apollo `images(` ref (live data) | Gallery image URL sourcing | ✗ (unconfirmed shape — needs one live probe) | — | Probe first (Open Question 1); if the ref proves unusable, v1 ships with "no gallery available" as the universal state until a working extractor lands |

**Missing dependencies with no fallback:** None — the one genuine unknown (Apollo `images(` ref shape) has a clean fallback (graceful "no gallery" degradation, per UI-SPEC §3) if the probe reveals an unusable shape.

**Missing dependencies with fallback:** Apollo `images(` ref (fallback: universal "no gallery available" state, matches an already-specified UI state).

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (existing — `vitest.config.ts`, `npm run test` / `npm run test:watch`) |
| Config file | `vitest.config.ts` (existing, no changes needed) |
| Quick run command | `npx vitest run src/lib/discovery/vision.test.ts src/lib/discovery/vision-schema.test.ts` |
| Full suite command | `npm run test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|---------------------|-------------|
| DISC-04 | `imageUrls` extractor correctly parses a captured Apollo `images(` ref fixture into a flat URL array, capped at 4 | unit | `npx vitest run src/lib/booli/client.test.ts -t "images"` | ❌ Wave 0 (new test + fixture needed once ref shape is probed) |
| DISC-04 | `DiscoveryCandidate`/`toCandidate`/`discoveryCandidateSchema` correctly carry `imageUrls` additively, backward-compatible with pre-Phase-11 rows | unit | `npx vitest run src/lib/discovery/candidate.test.ts` | ❌ Wave 0 (extends existing file) |
| DISC-04 | Haiku pre-filter is called with the capped image set + PII-ignore system prompt; Sonnet deep pass is called ONLY when pre-filter flags "worth a deep look" | unit (mocked Anthropic) | `npx vitest run src/lib/discovery/vision.test.ts` | ❌ Wave 0 (new file) |
| DISC-04 | Vision cost pre-check runs BEFORE each Sonnet call and halts remaining candidates when `CAP_VISION_SEK_MAX` would be exceeded | unit (mocked, asserts call-count) | `npx vitest run src/lib/discovery/vision.test.ts -t "cost cap"` | ❌ Wave 0 |
| DISC-04 | Every persisted claim has a non-null `imageIndex` resolvable against `imageUrlsUsed` (no uncited claim) | unit | `npx vitest run src/lib/discovery/vision-schema.test.ts -t "citation"` | ❌ Wave 0 |
| DISC-04 | A claim below `VISION_CONFIDENCE_THRESHOLD` is dropped before persistence, never rendered | unit | `npx vitest run src/lib/discovery/vision.test.ts -t "confidence"` | ❌ Wave 0 |
| DISC-04 | `vision-schema.ts` types are never imported by `niche-score.ts`/`flags.ts` (structural-separation invariant) | unit (static/grep-style assertion or lint rule) | `npx vitest run src/lib/discovery/niche-score.test.ts -t "no vision import"` | ❌ Wave 0 |
| DISC-04 | The Claude-facing vision schema survives ONE live smoke call without a 400 (per project memory: mocked tests hide the nullable-union/grammar-size trap) | manual-only, cost-gated | `RUN_LLM_EVALS=1 npx vitest run evals/vision.eval.ts` (smoke subset) | ❌ Wave 0 — REQUIRED before trusting any mocked vision test |
| DISC-04 (validation gate) | 20-30 real-listing accuracy vs. manual ground truth | manual-only, operator-deferred | `RUN_LLM_EVALS=1 npx vitest run evals/vision.eval.ts` (full gate) | ❌ Wave 0 harness; ✗ real fixtures (operator-deferred per CONTEXT.md) |

### Sampling Rate
- **Per task commit:** `npx vitest run src/lib/discovery/vision*.test.ts src/lib/discovery/candidate.test.ts` (mocked, free, fast)
- **Per wave merge:** `npm run test` (full suite green)
- **Phase gate:** Full mocked suite green + the ONE live API smoke test (per project memory, cost-gated but cheap — a single 4-image call, well under 1 SEK) run manually before relying on the schema in production; the FULL 20-30-listing validation-gate eval run is explicitly deferred to the operator (see Evaluation Strategy)

### Wave 0 Gaps
- [ ] `src/lib/discovery/vision.ts` + `vision.test.ts` — core orchestration, does not exist yet
- [ ] `src/lib/discovery/vision-schema.ts` + `vision-schema.test.ts` — schemas, does not exist yet
- [ ] `src/lib/booli/client.ts` `images(` ref extractor + a fixture-based test — requires the live-probe step (Open Question 1) before it can be written with confidence
- [ ] `evals/vision.eval.ts` + `evals/vision-labels.example.json` — harness skeleton, mirrors `evals/extractor.eval.ts` exactly (see Evaluation Strategy)
- [ ] `src/components/gallery-condition-vision.tsx` + a component test — per `11-UI-SPEC.md`'s full component inventory
- Framework install: none — Vitest already configured project-wide

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | No (new surface) | Reuses existing Supabase auth on the discovery job the vision pass attaches to |
| V3 Session Management | No | N/A — server-side-only Anthropic calls, no new session surface |
| V4 Access Control | Yes | Vision results persist inside `discovery_jobs.results`, already owner-only RLS-protected (Phase 9); no new access-control surface if no new table is added. If migration 012 (`vision_cache`) is built, it needs its own RLS review (recommend server-side-only access, no direct client read, mirroring `macro_snapshots`' precedent if a client read is ever needed) |
| V5 Input Validation | Yes | Image URLs sourced from Booli's own Apollo data (not user input) — still validate as strings via the existing `str()`/new `arrOfStr()` null-tolerant helpers before ever reaching an Anthropic content block; never interpolate an unvalidated URL into a template that could be reinterpreted |
| V6 Cryptography | No | N/A — no new secrets; reuses the existing `ANTHROPIC_API_KEY` server-only pattern |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| PII leakage via vision claims (people/personal documents visible in gallery photos) | Information Disclosure | Explicit system-prompt instruction (documented above) + a schema shape structurally incapable of referencing a person (mirrors `reportSchema`'s "no verdict field" trick) — this is the phase's OWN named locked constraint (CONTEXT.md), not a generic OWASP pattern |
| Cost-DoS via unbounded vision spend | Denial of Service (resource exhaustion) | `CAP_VISION_SEK_MAX` incremental pre-check (mirrors Phase 9's T-09-09 mitigation exactly) + `CAP_IMAGES_PER_LISTING` hard cap enforced at extraction time |
| Fabricated/hallucinated condition claims presented as fact | Tampering (trust) | Mandatory image citation (schema-enforced `imageIndex`), hedged-language-only copy (UI-SPEC banned-word list), confidence threshold suppression — the phase's own core design constraint |
| SSRF via a malicious/attacker-controlled image URL fed into an Anthropic `url` source | (theoretical — Anthropic's servers fetch the URL, not this app's server) | Low risk here since Anthropic's infrastructure (not this app's server) performs the URL fetch; still, only pass URLs sourced from Booli's own CDN domain (never user-supplied), matching the existing `assertAllowedHost`-style host-allowlist discipline used elsewhere in this codebase (Phase 8's broker-fetch SSRF guard) — recommend a lightweight host-allowlist check on `imageUrls` before ever including them in a vision call, as defense-in-depth even though the fetch itself happens on Anthropic's side |

## Evaluation Strategy

> This section addresses the kill-criterion validation gate (20-30 real listings, manual ground truth) distinctly from the Validation Architecture (Nyquist Wave 0 test gaps) above. The HARNESS and RUBRIC are buildable now; the ACTUAL RUN against real, manually-labeled listings is explicitly operator-deferred per CONTEXT.md.

### What to measure

Per CONTEXT.md's kill criterion, the gate must answer two independent questions:
1. **Is the vision output accurate enough to present even as hedged evidence?** (accuracy question)
2. **Can per-search vision cost stay under the cap on real data?** (cost question — already substantially answered by the Cost Math section above using the verified token formula, but should be RE-confirmed against real `message.usage` figures from the same 20-30-listing run, since the formula gives a theoretical ceiling, not a guarantee of actual per-listing token counts)

### Metrics (per-attribute, mirrors `extractor.eval.ts`'s "match expert label + require a citation" dual-check pattern)

For each of the 3 attributes (kitchen, bathroom, overall) across the 20-30 labeled listings:

| Metric | Definition | Why it matters |
|--------|-----------|------------------|
| **Directional accuracy** | Does the claim's DIRECTION (e.g. "renovated"/"dated"/no-claim) match the human labeler's independent judgment from the same images? | The core "is this useful hedged evidence" question — an exact-wording match is not required (and not meaningful for hedged natural language), only whether the AI's DIRECTION agrees with a human's |
| **Citation validity rate** | Of all NON-empty claims, what % cite an `imageIndex` that actually shows what `whatWasSeen` describes (human-verified)? | This is the "no hallucinated citation" gate — mirrors `extractor.eval.ts`'s T-04-05 "no invented signal without a citation" check exactly, but ALSO verifies the citation is TRUE (the extractor eval only checks presence, not correctness, because BRF PDFs don't have this failure mode the same way; vision citations can be present-but-wrong, so this eval must check both) |
| **Suppression correctness** | When the model suppresses a claim (confidence < threshold or "not assessable"), does a human labeler agree there wasn't enough visual evidence? | Prevents the opposite failure — an overly-cautious model that suppresses everything would "pass" citation/accuracy checks trivially while providing zero value |
| **Zero-hallucination rate** | % of listings where NO claim references a person, personal document, or fabricated detail not present in any sent image | Direct verification of the PII/no-fabrication locked constraint — this is a hard 100%-required metric, not a soft threshold |
| **Per-listing cost (SEK)** | Actual `costSek` summed across both stages for each of the 20-30 listings, from real `message.usage` | Confirms the Cost Math section's theoretical ceiling against real-world token counts |

### Recommended starting thresholds (a starting rubric — the OPERATOR makes the final call, per Open Question 3)

| Metric | Recommended threshold | If below |
|--------|--------------------------|----------|
| Directional accuracy (per attribute, avg across 20-30 listings) | ≥ 70% | Consider CUT — hedged evidence that's wrong 30%+ of the time may do more harm than good even with hedging language |
| Citation validity rate | ≥ 90% | Consider CUT immediately — a hallucinated citation directly violates the phase's core locked constraint (mandatory TRUE citation), not just a quality nice-to-have |
| Zero-hallucination rate (PII/fabrication) | 100% (hard gate, no tolerance) | CUT immediately — this is a GDPR/trust violation, not a quality tradeoff |
| Per-search cost (measured, 25-candidate equivalent) | ≤ `CAP_VISION_SEK_MAX` (10 SEK) | If real-world costs exceed this even after the cap enforcement works correctly (i.e. the cap itself is too generous for the realized accuracy/cost tradeoff), tighten the cap or CUT |

### Harness shape (buildable now, mirrors `evals/extractor.eval.ts` exactly)

```typescript
// evals/vision.eval.ts (NEW — skeleton, buildable now)
//
// COST-GATED — mirrors extractor.eval.ts's RUN_LLM_EVALS=1 discipline exactly.
// Inputs (gitignored, PII/real-listing-data per the same convention as
// evals/fixtures/*.pdf):
//   - evals/fixtures/vision/*.json — one file per listing: { booliId, imageUrls: string[] }
//   - evals/vision-labels.json — keyed by booliId:
//       { kitchen: {expectedDirection, expectedAssessable}, bathroom: {...},
//         overall: {...}, expectedNoHallucination: boolean }
//
// Exercises the REAL shipping runVisionForCandidate() — tests exactly what ships.

const RUN_LIVE = process.env.RUN_LLM_EVALS === "1" && !!process.env.ANTHROPIC_API_KEY;

describe("Vision condition eval (DISC-04 validation gate)", () => {
  if (!RUN_LIVE) {
    it.skip("skipped — set RUN_LLM_EVALS=1 with a live ANTHROPIC_API_KEY (incurs spend)", () => {});
    return;
  }
  // beforeAll: load fixtures + labels.json (mirrors extractor.eval.ts's setupNote pattern
  // for the "missing labels" case — reports cleanly, never throws at import time)

  it("has 20-30 labelled real listings wired (CONTEXT.md validation gate)", () => { /* ... */ });

  describe("per-listing accuracy vs human labels", () => {
    it("directional accuracy >= 70% per attribute, aggregated across all listings", async () => {
      // loop listings, call runVisionForCandidate, compare direction to label,
      // accumulate a scoreboard object (not per-listing pass/fail — this is an
      // AGGREGATE threshold gate, closer to report.eval.ts's judge-scoring shape
      // than extractor.eval.ts's per-fixture exact-match shape)
    });
    it("citation validity rate >= 90%", async () => { /* human-labels mark citation TRUE/FALSE per claim */ });
    it("zero-hallucination rate === 100% (hard gate)", async () => { /* any failure here is a release blocker */ });
    it("measured per-search cost projection stays under CAP_VISION_SEK_MAX", async () => { /* sum + extrapolate to 25-candidate search */ });
  });
});
```

This intentionally differs from `extractor.eval.ts`'s per-fixture hard-pass-or-fail shape (which suits EXACT numeric/enum labels from a structured PDF) and leans slightly toward `evals/report-judge.ts`'s aggregate-scoring shape (which already exists in this codebase for judging free-text synthesis quality) — **recommend reviewing `evals/report-judge.ts` as a second harness precedent** alongside `extractor.eval.ts` when implementing, since vision's "directional accuracy" metric is closer to a judged/graded quality than an exact match.

### What is buildable now vs. operator-deferred

| Item | Status |
|------|--------|
| `evals/vision.eval.ts` harness skeleton (RUN_LLM_EVALS-gated, self-skipping) | **Buildable now** |
| `evals/vision-labels.example.json` (label shape documentation) | **Buildable now** |
| The rubric/thresholds table above | **Buildable now** (as a recommendation; operator confirms/adjusts at the gate) |
| Gathering 20-30 REAL listings' images + manually labeling ground truth | **Operator-deferred** (per CONTEXT.md — needs real images + labeled ground truth + the vision pipeline flag ON) |
| Running the full gate and deciding CUT vs. SHIP | **Operator-deferred** (explicit kill-criterion decision point) |
| The ONE live API smoke test (schema doesn't 400) | **Buildable now, cheap, should run during implementation** — distinct from the full 20-30-listing gate; this only proves the schema/call shape works at all, not accuracy |

## Sources

### Primary (HIGH confidence)
- `src/lib/brf/extract.ts` — Haiku model id, `messages.parse`/`zodOutputFormat` shape, slim-schema discipline, Files API threshold, coded-error pattern
- `src/lib/report/synthesize.ts` — Sonnet model id (bare, no date suffix), `output_config.format` current-shape confirmation
- `src/lib/brf/cost.ts` — verified per-MTok USD rates for both models, `costSek`/`costSekSonnet` functions to reuse unchanged
- `src/lib/discovery/candidate.ts`, `filter-schema.ts`, `cost.ts`, `job.ts` — Phase 9/10 caps, allowlist pattern, incremental-cost-check discipline
- `src/lib/booli/client.ts` — confirms `images(` Apollo ref exists but is unparsed; confirms `thumbnailUrl` is dead code
- `.planning/phases/11-gallery-condition-vision/11-UI-SPEC.md` — locked structural-separation rendering contract, citation thumbnail shape, confidence-suppression behavior
- `evals/extractor.eval.ts` — the eval harness template (RUN_LLM_EVALS gating, labels.json shape, per-fixture citation-presence check)
- [Vision - Claude Platform Docs](https://platform.claude.com/docs/en/build-with-claude/vision) — image content-block shapes (base64/url/file), current token-cost formula (`⌈w/28⌉×⌈h/28⌉`), resolution tiers, request limits, multi-image labeling convention ("Image 1:", "Image 2:")

### Secondary (MEDIUM confidence)
- [Anthropic API Pricing 2026](https://platform.claude.com/docs/en/about-claude/pricing) — cross-check of per-MTok rates against the codebase's already-verified constants (agreement confirmed)

### Tertiary (LOW confidence)
- None relied upon for load-bearing claims — all cost/model/mechanics claims were cross-verified against either live codebase constants or the official current docs page.

## Metadata

**Confidence breakdown:**
- Standard stack (model IDs, message shape, cost formula): HIGH — verified against both live production code AND current official docs, in full agreement
- Architecture (two-pass pipeline, citation schema, structural separation): HIGH for the pattern (directly extends 3 existing proven patterns in this codebase); MEDIUM for the gallery-URL-sourcing step specifically (depends on one unconfirmed Apollo ref shape — Open Question 1)
- Pitfalls: HIGH — 4 of 5 are direct extensions of already-documented, already-hit pitfalls in this exact codebase (nullable-union 400s, cost-cap-after-not-before, structural-separation leakage); 1 (Haiku pre-filter compounding) is a reasoned architectural precaution, not a previously-hit bug
- Evaluation strategy / real-world accuracy: LOW-by-design — this is explicitly the thing the validation gate exists to determine; the harness and rubric are HIGH-confidence buildable, but the ACCURACY OUTCOME is fundamentally unknowable without the operator-deferred live run

**Research date:** 2026-07-07
**Valid until:** 30 days for the architecture/pattern guidance (stable, codebase-internal); pricing/model-id figures should be re-verified if this phase's implementation is delayed more than ~60 days, since Anthropic pricing/model lineups have shown a cadence of change within the observed 2026 search results (e.g. Opus 4.7→4.8, introductory pricing windows)
