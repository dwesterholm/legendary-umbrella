# Phase 11: Gallery Condition Vision - Pattern Map

**Mapped:** 2026-07-07
**Files analyzed:** 10 (create/modify)
**Analogs found:** 9 / 10 (1 genuinely new mechanism has no full analog — image content blocks + two-pass gate; partial analogs given)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/lib/discovery/vision.ts` (NEW) | service | request-response (two-pass AI orchestration) | `src/lib/brf/extract.ts` (structured-output call) + `src/lib/discovery/job.ts` `runSlice` (incremental cap-before-spend) | role-match (composite) |
| `src/lib/discovery/vision-schema.ts` (NEW) | model/schema | transform | `src/lib/brf/extract.ts`'s `claudeField`/`claudeExtractionSchema` (slim nullable-minimizing schema) | exact (schema-shape pattern) |
| `src/lib/discovery/cost.ts` (MODIFY: add `visionCostSek`, `CAP_VISION_SEK_MAX`) | utility/config | transform | `src/lib/discovery/cost.ts` itself (`discoveryCostSek`) + `src/lib/brf/cost.ts` (`costSek`/`costSekSonnet`) | exact |
| `src/lib/discovery/candidate.ts` (MODIFY: add `imageUrls`, `vision`, `visionSkippedReason`) | model | CRUD (additive-nullable persisted shape) | Phase 10's own extension of `DiscoveryCandidate` (`constructionYear`/`brfName`/`tenureForm`) in this same file | exact |
| `src/lib/booli/client.ts` (MODIFY: add `imageUrls`/floor-plan extractor to `reshapeListingEntity`) | service (scraper reshape) | transform (ref-parsing) | `reshapeListingEntity`'s existing `agency(` ref extraction (same file, lines 171-229) | exact |
| `src/lib/discovery/job.ts` (MODIFY or new vision slice call site) | service (job orchestration) | event-driven / batch (incremental tick) | `runSlice`'s incremental-cap-before-scrape discipline (same file) | exact |
| `src/components/gallery-condition-vision.tsx` (NEW) | component | request-response (read-only render) | `src/components/report-flags.tsx` (what to AVOID reusing — structural shell only) + `brf-score-card.tsx`'s "Ej tillgänglig"/closing-explainer idiom | role-match, deliberately divergent styling |
| `evals/vision.eval.ts` (NEW) | test | batch (live-gated eval) | `evals/extractor.eval.ts` (RUN_LLM_EVALS-gated, labels.json-keyed) | exact |
| `evals/vision-labels.example.json` (NEW) | config/fixture | — | `evals/labels.example.json` | exact |
| `src/lib/discovery/vision.test.ts` / `vision-schema.test.ts` (NEW) | test | — | `src/lib/discovery/job.test.ts` / `candidate.test.ts` (mocked-client allowlist assertions) | role-match |

## Pattern Assignments

### `src/lib/discovery/vision.ts` (service, two-pass request-response)

**Analogs:** `src/lib/brf/extract.ts` (structured-output call shape, coded errors) + `src/lib/report/synthesize.ts` (Sonnet call, simpler input) + `src/lib/discovery/job.ts`'s `runSlice` (incremental cap check).

**Imports pattern** (from `src/lib/brf/extract.ts:1-7`):
```typescript
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import type { ClaudeUsage } from "@/lib/brf/cost";
```
Vision-specific additions: import `costSek`, `costSekSonnet` from `@/lib/brf/cost` (NOT redefine rates); import `CAP_VISION_SEK_MAX` from `@/lib/discovery/cost`.

**Client + model constants pattern** (`extract.ts:19-22`, `synthesize.ts:18-24` — verified model IDs, reuse verbatim):
```typescript
const client = new Anthropic();
const HAIKU_MODEL = "claude-haiku-4-5-20251001"; // extract.ts:22
const SONNET_MODEL = "claude-sonnet-4-6";        // synthesize.ts:24 — bare id, NO date suffix
```

**Core two-pass pattern (GENUINELY NEW mechanism — no full analog in this codebase):** image content blocks composed with `messages.parse` + `zodOutputFormat`, exactly like `extract.ts`'s `document` block, but `type: "image"` instead of `type: "document"`. This is a mechanical extension of the SAME call shape, not a new SDK surface:
```typescript
// mirrors extract.ts:265-295 runOnce() shape — content array gets image blocks
const runOnce = () =>
  client.beta.messages.parse({
    model: HAIKU_MODEL,
    max_tokens: 300,
    temperature: 0, // extract.ts/parse-intent.ts precedent, NOT synthesize.ts's 0.4
    system: VISION_PREFILTER_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: [
        ...imageUrls.flatMap((url, i) => [
          { type: "text" as const, text: `Bild ${i + 1}:` },
          { type: "image" as const, source: { type: "url" as const, url } },
        ]),
        { type: "text", text: "..." },
      ],
    }],
    output_config: { format: zodOutputFormat(preFilterSchema) },
  });
```
Flag explicitly: **the two-pass pre-filter gate itself (Haiku triage → conditional Sonnet call) is a new orchestration pattern in this codebase** — Phase 9's Haiku intent-parse and Phase 2/4's single-call extraction/synthesis are each ONE call; this is the first two-stage cost-gated chain. Compose it from the `runOnce` retry/refusal precedent below, applied twice.

**Refusal/max_tokens/parse-empty branching** (`extract.ts:297-314`, `synthesize.ts:120-137` — copy verbatim, apply to BOTH the Haiku and Sonnet calls):
```typescript
let message = await runOnce();
if (message.stop_reason === "refusal") throw new Error("CLAUDE_REFUSAL");
if (message.stop_reason === "max_tokens") {
  message = await runOnce();
  if (message.stop_reason === "max_tokens") throw new Error("CLAUDE_MAX_TOKENS");
}
if (!message.parsed_output) throw new Error("CLAUDE_PARSE_EMPTY");
```

**Error handling / GDPR-safe logging pattern** (`extract.ts:326-338`, `synthesize.ts:143-154` — copy verbatim, log ONLY `{ booliId, code }`):
```typescript
} catch (error) {
  const code = isKnownVisionCode(error) ? (error as Error).message : "CLAUDE_CALL_FAILED";
  console.error("[discovery-vision]", { booliId, code }); // NEVER image URLs, claim text, model output
  throw new Error(code, { cause: error });
}
```

**Cost pre-check pattern (incremental, BEFORE each Sonnet call)** — analog is `runSlice`'s pre-check-before-scrape discipline in `src/lib/discovery/job.ts` (Phase 9's documented anti-pattern: never check cost only after the call). Read `job.ts`'s `runSlice` before implementing to copy the exact "running total + early-return with a skip reason" shape.

---

### `src/lib/discovery/vision-schema.ts` (model/schema, transform)

**Analog:** `src/lib/brf/extract.ts`'s `claudeField`/`claudeExtractionSchema` (lines 51-89) — THE pattern to copy for avoiding the "too many nullable→union params" 400.

**Schema-slimming pattern** (`extract.ts:51-65`, adapt field names per RESEARCH.md's already-drafted `conditionAttribute`):
```typescript
// mirrors claudeField()'s "only ONE nullable leaf" discipline
const conditionAttribute = z.object({
  claim: z.string().nullable().describe("Hedged Swedish claim... Null if not assessable."),
  imageIndex: z.number().describe("1-based index into images sent, or 0 if claim is null."),
  whatWasSeen: z.string().describe("Specific visual detail, e.g. 'nya vitvaror'. Empty if claim is null."),
  confidence: z.number().describe("0-1 confidence."),
});
const visionDeepPassSchema = z.object({
  kitchen: conditionAttribute,
  bathroom: conditionAttribute,
  overall: conditionAttribute,
});
// 3 nullable leaves total — well under extract.ts's documented ~28-union threshold.
```
**Do NOT** model this as `z.array(z.object({...}))` — this is `extract.ts`'s explicitly documented Pitfall 3 / project-memory `anthropic-structured-output-limits` trap. Flat named top-level fields only.

**Persisted-shape interfaces (NOT Claude-facing — plain TS, mirrors `flags.ts`'s `SoftSignalField<T>`)**:
```typescript
// src/lib/report/flags.ts:91 SoftSignalField<T> is the closest existing "cited claim" shape —
// VisionConditionClaim/VisionResult are its image-cited sibling (RESEARCH.md's already-drafted shape):
export interface VisionConditionClaim {
  attribute: "kitchen" | "bathroom" | "overall";
  claim: string;
  imageIndex: number;
  whatWasSeen: string;
  confidence: number;
}
export interface VisionResult {
  claims: VisionConditionClaim[];
  imageUrlsUsed: string[];
  model: string;   // mirrors report.ts's `model` trace field
  costSek: number;
  ranAt: string;
}
```

---

### `src/lib/discovery/cost.ts` (MODIFY — add `visionCostSek`, `CAP_VISION_SEK_MAX`)

**Analog:** the file's own existing `discoveryCostSek` (lines 24-38) + `src/lib/brf/cost.ts`'s `costSek`/`costSekSonnet`.

**Pattern** (compose, do not redefine rates):
```typescript
// mirrors discoveryCostSek's composition of costSek() + a render-cost term (cost.ts:33-38)
export const CAP_VISION_SEK_MAX = 10; // SEPARATE from CAP_SEK_MAX — see Anti-Pattern below

export function visionCostSek(haikuUsage: ClaudeUsage, sonnetUsage: ClaudeUsage | null): number {
  const haikuSek = costSek(haikuUsage);
  const sonnetSek = sonnetUsage ? costSekSonnet(sonnetUsage) : 0;
  return haikuSek + sonnetSek;
}
```
**Anti-pattern (explicit, from RESEARCH.md Pitfall 2):** do NOT merge into `CAP_SEK_MAX`/`DISCOVERY_COST_CAP_SEK` — keep `CAP_VISION_SEK_MAX` a distinct, independently-tracked running total, checked before each Sonnet call, mirroring `CAP_CANDIDATES_MAX`/`CAP_SEK_MAX`/`CAP_IMAGES_PER_LISTING` already being three independent named constants in this codebase (`filter-schema.ts`).

---

### `src/lib/discovery/candidate.ts` (MODIFY — additive-nullable extension)

**Analog:** this file's OWN Phase 10 precedent (lines 33-35, 96-98) — the exact pattern to repeat verbatim for `imageUrls`/`vision`/`visionSkippedReason`.

**`DiscoveryCandidate` interface extension** (mirrors lines 33-35):
```typescript
export interface DiscoveryCandidate {
  // ...existing 10 fields unchanged...
  imageUrls: string[] | null;
  vision: VisionResult | null;
  visionSkippedReason: "no_images" | "cost_cap" | null;
}
```

**`toCandidate` mapping** (mirrors lines 63-66's `str(raw.constructionYear)`-style plain reads — construct fresh, never spread `...raw`):
```typescript
imageUrls: arrOfStr(raw.imageUrls), // new small helper mirroring num()/str() at top of file (lines 6-9)
vision: null,           // vision runs as a SEPARATE later pass, not at scrape/toCandidate time
visionSkippedReason: null,
```

**`discoveryCandidateSchema` extension** (mirrors lines 96-98 EXACTLY — same `.nullable().default(null)`, NOT `.optional()`, per the file's own CR-01 fix comment about `undefined` vs `null` breaking `=== null` guards):
```typescript
imageUrls: z.array(z.string()).nullable().default(null),
vision: visionResultSchema.nullable().default(null),
visionSkippedReason: z.enum(["no_images", "cost_cap"]).nullable().default(null),
```
**Confirmed: no Supabase migration needed** — `discovery_jobs.results` is JSONB; this follows the exact zero-migration precedent Phase 10 already established in this same file for `constructionYear`/`brfName`/`tenureForm`.

---

### `src/lib/booli/client.ts` (MODIFY — `imageUrls` extractor in `reshapeListingEntity`)

**Analog:** the SAME function's existing `agency(` ref extraction (lines 172-174, 205) — the exact `argKeyedFieldOf` pattern to repeat for `images(`.

**Pattern** (mirrors lines 172-174 verbatim structure):
```typescript
// mirrors: const agency = argKeyedFieldOf(entry, "agency(") as {...} | undefined;
const images = argKeyedFieldOf(entry, "images(") as
  | Array<{ url?: string; type?: string }>
  | undefined;
```
Then inside the returned object literal (mirrors line 205's `agencyName: agency?.name ?? undefined`):
```typescript
imageUrls: Array.isArray(images)
  ? images.map((i) => i?.url).filter((u): u is string => typeof u === "string")
  : undefined,
```

**GENUINELY NEW / requires a live probe before finalizing:** RESEARCH.md's Open Question 1 — the exact Apollo `images(` ref shape (field names, floor-plan discriminator) is UNCONFIRMED. Mirror the "probe once against a live render, pin the shape in a doc comment" precedent already used by `05-PROBE-FINDINGS.md` and this same file's own `amenityKeys`/`brfNameFromBreadcrumbs` comment block (lines 118-127) documenting where a ref shape was pinned. Do not hand-write the extractor from an assumed shape without first running `runPlaywrightRender` + `APOLLO_PAGE_FUNCTION` (same file, `fetchListing`, lines 330-344) against one real listing.

**Live-render probe pattern to reuse** (from `sold-source.ts`'s re-export + `client.ts`'s `fetchListing`, lines 330-352): a thin one-off script/test calling `runPlaywrightRender(url, APOLLO_PAGE_FUNCTION)` and dumping the raw `images(...)`-keyed field, exactly the technique Phase 5/6/9 used to pin their own ref shapes (see doc comment at client.ts:111-127).

---

### `src/lib/discovery/job.ts` (MODIFY or new vision slice/tick)

**Analog:** the file's own `runSlice` incremental-cap-before-spend discipline (same pattern already governing `CAP_SEK_MAX`/`CAP_CANDIDATES_MAX`). Read the exact `runSlice` cost-check ordering before writing the vision cap check — the invariant is "check running total BEFORE the call, not after" (Phase 9 Pitfall, carried into RESEARCH.md Pitfall 2 for this phase).

**Structural separation invariant (cross-cutting, testable):** `vision-schema.ts` types must never be imported by `src/lib/discovery/niche-score.ts` (Phase 10's `computeNicheScore`) or `src/lib/report/flags.ts`. Analog for how to ENFORCE this as a test: `job.integration.test.ts`'s pattern of proving non-re-read via a throwing mock — write an equivalent one-line assertion/lint that fails if `niche-score.ts` or `flags.ts` ever import from `vision-schema.ts`.

---

### `src/components/gallery-condition-vision.tsx` (NEW component)

**Analog (what to COPY structurally):** `src/components/report-flags.tsx`'s overall shell conventions — `"use client"` directive, `Badge` import from `@/components/ui/badge`, `cn` from `@/lib/utils`, a props interface reading a persisted data shape directly (no extra transform layer).

**Analog (what to AVOID reusing — explicit per UI-SPEC):** `report-flags.tsx`'s `severityChip()` function (lines 62-71, sage/destructive/terracotta color-coded severity) and its list-item shell `rounded-lg border border-warm-gray-100 bg-warm-gray-50 p-3` (referenced in UI-SPEC, not literally in this file's excerpt but confirmed by UI-SPEC §Component Inventory). The vision card MUST use `border-warm-gray-200 bg-warm-white` (one step different) and NEVER call anything resembling `severityChip`.

**Analog for the "Ej tillgänglig" / closing-explainer degraded-state idiom:** `brf-score-card.tsx`'s pattern (not read in full this pass — UI-SPEC references it directly at multiple points: "Ej tillganglig" treatment, closing explainer line). Reuse the SAME `italic text-warm-gray-500` treatment for all three vision empty/degraded states (no-gallery, cost-cap-skipped, low-confidence-suppressed) per UI-SPEC Copywriting Contract.

**New icon usage (first feature-level lucide icon in the codebase per UI-SPEC):**
```typescript
import { Eye } from "lucide-react";
// <div className="flex h-8 w-8 items-center justify-center rounded-full bg-terracotta-50">
//   <Eye className="h-4 w-4 text-terracotta-600" />
// </div>
```

**Props shape** — reads `DiscoveryCandidate.vision`/`visionSkippedReason`/`imageUrls` directly (from `candidate.ts`), resolving `imageUrlsUsed[claim.imageIndex - 1]` for the thumbnail per RESEARCH.md's "Rendering" section — no separate transform module needed, mirrors `ReportFlags`' direct-props-read simplicity.

---

### `evals/vision.eval.ts` (NEW eval harness)

**Analog:** `evals/extractor.eval.ts` — copy its structure almost verbatim:
- `RUN_LIVE = process.env.RUN_LLM_EVALS === "1" && !!process.env.ANTHROPIC_API_KEY` gate (line 37)
- `describe(...) { if (!RUN_LIVE) { it.skip(...); return; } ... }` shape (lines 86-92)
- `beforeAll` resolving fixtures + `labels.json` with a `setupNote` for the missing-inputs case (lines 81-118)
- Content-hash-keyed labels (adapt: key by `booliId` instead of SHA-256 PDF hash, since vision fixtures are image-URL sets per listing, not a single PDF blob)
- Per-fixture loop with per-case assertion messages naming the fixture (lines 130-201)

**Adapt for vision's rubric (RESEARCH.md Evaluation Strategy, Open Question 3 starting point):** per-attribute directional accuracy ≥ 70%, zero-hallucinated-citation rate = 100% (every non-null claim's `imageIndex` must resolve to a real image in `imageUrlsUsed`, mirroring `extractor.eval.ts`'s T-04-05 "no invented signal without sourceQuote+pageRef" citation-backed assertion at lines 177-199 — same discipline, `imageIndex` instead of `pageRef`).

**Genuinely new: the eval rubric itself** (directional accuracy threshold for hedged image claims) has no numeric-tolerance analog as clean as `extractor.eval.ts`'s `numberMatches` (financial figures have an objective ground truth; "kitchen looks renovated" is a judgment call). Flag this as new: the harness structure copies directly, but the comparison function (`claimDirectionMatches` or similar) must be authored fresh — there is no existing "fuzzy directional match" helper in this codebase to copy.

**`evals/vision-labels.example.json`** — analog: `evals/labels.example.json` (label shape documentation, gitignored real file, `.example.json` committed as the schema reference).

---

### `src/lib/discovery/vision.test.ts` / `vision-schema.test.ts` (unit tests)

**Analog:** `src/lib/discovery/job.test.ts` (mocked Anthropic client, allowlist assertions) and `candidate.test.ts` (extended allowlist tests per the recent commit `8a5f87a test(10-01): update job.test.ts allowlist assertion for extended candidate shape` — same mocking + allowlist-assertion pattern applies directly to the new `imageUrls`/`vision`/`visionSkippedReason` fields).

## Shared Patterns

### Structured-output call shape (Haiku pre-filter + Sonnet deep pass)
**Source:** `src/lib/brf/extract.ts:265-338`, `src/lib/report/synthesize.ts:90-155`
**Apply to:** `vision.ts`'s both call sites.
```typescript
messages.parse({ model, max_tokens, temperature: 0, system, messages: [...], output_config: { format: zodOutputFormat(schema) } })
// then: refusal → throw immediately; max_tokens → retry once then throw; empty parsed_output → throw
```

### Cost accounting
**Source:** `src/lib/brf/cost.ts` (`costSek`, `costSekSonnet` — do not redefine rates), `src/lib/discovery/cost.ts` (composition pattern for a new named cap).
**Apply to:** `vision.ts` orchestration, `cost.ts`'s new `visionCostSek`/`CAP_VISION_SEK_MAX`.

### GDPR-safe error logging
**Source:** `src/lib/brf/extract.ts:326-338`, `src/lib/report/synthesize.ts:143-154`
**Apply to:** `vision.ts` catch blocks — log ONLY `{ booliId, code }`, never image URLs/claim text/model output.

### Additive-nullable persistence, no migration
**Source:** `src/lib/discovery/candidate.ts:33-35, 96-98` (Phase 10's own precedent, same file)
**Apply to:** `candidate.ts`'s `imageUrls`/`vision`/`visionSkippedReason` extension. `.nullable().default(null)`, NEVER `.optional()` alone (this file's own CR-01 fix comment explains why).

### Null-tolerant Apollo ref extraction
**Source:** `src/lib/booli/client.ts:100-109` (`argKeyedFieldOf`), `171-229` (`reshapeListingEntity`)
**Apply to:** the new `imageUrls` extractor — same `argKeyedFieldOf(entry, "images(")` idiom as the existing `agency(` extraction, same fresh-object-literal / no-throw-on-malformed discipline.

### Incremental cost-cap-before-spend
**Source:** `src/lib/discovery/job.ts`'s `runSlice` (Phase 9 documented anti-pattern: never check cost only after the call)
**Apply to:** `vision.ts`'s per-candidate loop — check running vision SEK total BEFORE each Sonnet call, not after.

### RUN_LLM_EVALS-gated live eval harness
**Source:** `evals/extractor.eval.ts:29-118`
**Apply to:** `evals/vision.eval.ts` — identical gate/skip/beforeAll structure.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| Two-pass Haiku-triage→Sonnet-deep-pass orchestration (the core control flow inside `vision.ts`) | service | event-driven (conditional chain) | No existing pipeline in this codebase has a conditional second AI call gated on a first AI call's output — Phase 9's intent-parse and Phase 2/4's extraction/synthesis are each single-call. Build from RESEARCH.md's Pattern 1 code example + the `runOnce`/cost-cap analogs above; this is new orchestration logic, not a new API pattern. |
| The vision eval's directional-accuracy comparison function (fuzzy "does this hedged claim match the label's direction" check) | test/utility | transform | `extractor.eval.ts`'s `numberMatches` only handles numeric tolerance; no existing helper does directional/categorical fuzzy matching for hedged natural-language claims. |
| Apollo `images(` ref exact shape | — | — | Genuinely unconfirmed (RESEARCH.md Open Question 1) — requires a live probe (reuse `fetchListing`'s `runPlaywrightRender` + `APOLLO_PAGE_FUNCTION` technique) before the extractor can be finalized. Not a "no analog" in method, but the DATA it will parse is unverified. |

## Metadata

**Analog search scope:** `src/lib/brf/`, `src/lib/report/`, `src/lib/discovery/`, `src/lib/booli/`, `src/lib/market/`, `src/components/`, `evals/`
**Files scanned:** `extract.ts`, `synthesize.ts`, `cost.ts` (brf + discovery), `candidate.ts`, `client.ts` (booli), `sold-source.ts`, `flags.ts`, `report-flags.tsx`, `extractor.eval.ts`, `labels.example.json`
**Pattern extraction date:** 2026-07-07
