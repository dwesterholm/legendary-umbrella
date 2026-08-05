# Phase 14: Holistic Analysis Brain - Pattern Map

**Mapped:** 2026-08-05
**Files analyzed:** 8 (2 new, 6 modified)
**Analogs found:** 8 / 8

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/lib/discovery/confounder-guard.ts` (new, ANL-04) | service/utility (pure) | transform | `src/lib/discovery/area-comps.ts` + `src/lib/discovery/flip-economics.ts` | exact (module shape/export style) |
| `src/lib/discovery/brf-lookup.ts` (new, discovery-side BRF orchestrator, ANL-03) | service | event-driven (concurrent network+LLM) | `src/actions/fetch-brf-auto.ts` (structural analog ONLY) + `src/lib/discovery/job.ts`'s `runSlice` `Promise.allSettled` block | role-match (structural), NOT reusable as-is |
| `src/lib/discovery/candidate.ts` (modify — add `kommun`) | model/schema | CRUD (read/write allowlist) | itself, Phase-10 `constructionYear`/`brfName`/`tenureForm` addition (same file, lines 119-121/203-205/253-255) | exact (self-precedent) |
| `src/lib/booli/client.ts` (modify — derive `kommun` at :409) | transform | request-response (scrape-time derivation) | `brfNameFromBreadcrumbs` (same file, :163-170) + call site (:409) | exact |
| `src/lib/discovery/job.ts` (modify — `runVisionForJob` gains comps+BRF wiring) | controller/orchestrator | batch + event-driven | `runSlice`'s own `Promise.allSettled` area-concurrency block (:186-205) | exact (concurrency template) |
| `src/lib/discovery/vision.ts` (modify — both `claims: []` branches) | service | request-response | itself (Haiku-skip :285-296, confidence filter :332-366) + `gallery-condition-vision.tsx`'s `visionRanButEmpty` framing for the mirrored marker text | exact (insertion points), role-match (marker copy) |
| `src/lib/discovery/cost.ts` (modify — fold comps/BRF into spend) | utility | transform | itself, `discoveryCostSek`/`USD_PER_RENDER`/`USD_SEK_RATE` (:8,33-38) + `CAP_VISION_SEK_MAX`/vision cost accounting pattern (:54 + vision.ts :473-528) | exact |
| `src/lib/discovery/niche-score.test.ts` (modify — `VISION_MODULE_SPECIFIERS`) | test | static-grep invariant | itself (:301-329) | exact |
| `src/components/discovery-results.tsx` / `src/components/gallery-condition-vision.tsx` (modify — data-only marker) | component | request-response (display-only) | `gallery-condition-vision.tsx`'s existing `visionSkippedReason`/`visionRanButEmpty` branch structure (:114-140) and the "från bildtolkning"-style header framing (:104-111) | exact |

## Pattern Assignments

### `src/lib/discovery/candidate.ts` — add `kommun: string | null` (D-14-09)

**Analog:** the file's own Phase-10 `constructionYear`/`brfName`/`tenureForm` precedent — this is the EXACT template to repeat for `kommun`, at three touch points in the SAME file.

**1. Interface field** (lines 119-121):
```typescript
constructionYear: number | null;
brfName: string | null;
tenureForm: string | null;
```
Add a sibling `kommun: string | null;` right after `tenureForm` (or immediately after `brfName`, since kommun is derived alongside brfName at the client.ts call site — see below). Update the doc comment block above (lines 86-90) to note the new field and its zero-extra-network-cost provenance, mirroring the existing Phase-10 comment style exactly.

**2. Mapper line in `toCandidate`** (lines 203-205):
```typescript
constructionYear: num(raw.constructionYear),
brfName: str(raw.brfName),
tenureForm: str(raw.tenureForm),
```
Add `kommun: str(raw.kommun),` — reads a flat string field already placed on `raw` by `reshapeListingEntity` (client.ts), exactly like `brfName`/`tenureForm`.

**3. `discoveryCandidateSchema` nullable guard** (lines 253-255):
```typescript
constructionYear: z.number().nullable().default(null),
brfName: z.string().nullable().default(null),
tenureForm: z.string().nullable().default(null),
```
Add `kommun: z.string().nullable().default(null),` — same `.nullable().default(null)` discipline (NEVER `.optional()` alone — see the file's own CR-01 comment at lines 244-252 explaining why `.optional()` breaks `=== null` guards on legacy rows missing the key).

---

### `src/lib/booli/client.ts` — derive `kommun` at the `brfName` call site (:409)

**Analog:** `brfNameFromBreadcrumbs` (:163-170) as the exact template shape for a new `kommunFromBreadcrumbs`, and the call site at :409 as the exact injection point.

**Template function shape** (:163-170):
```typescript
export function brfNameFromBreadcrumbs(breadcrumbs: unknown): string | null {
  if (!Array.isArray(breadcrumbs) || breadcrumbs.length === 0) return null;
  const last = breadcrumbs[breadcrumbs.length - 1] as { label?: string; url?: string } | undefined;
  if (last?.url && /\/bostadsrattsforening\//.test(last.url)) {
    return typeof last.label === "string" && last.label.length > 0 ? last.label : null;
  }
  return null;
}
```

**Call site to extend** (:395-410, comment + object literal):
```typescript
    // ... balcony/brfName have no existing passthrough key to collide with,
    // so they're added directly.
    balcony: amenityKeys(entry.amenities).includes("balcony") || entry.balcony === true,
    brfName: brfNameFromBreadcrumbs(entry.breadcrumbs) ?? undefined,
```
Add a sibling `kommun: kommunFromBreadcrumbs(entry.breadcrumbs) ?? undefined,` on the SAME `entry.breadcrumbs` value already passed to `brfNameFromBreadcrumbs` — zero extra network cost, matches the doc comment's own framing ("Apollo is the more reliable first-party source").

**Logic to relocate/reuse — `kommunFromBreadcrumbs` from `src/actions/fetch-brf-auto.ts:64-73`:**
```typescript
function kommunFromBreadcrumbs(breadcrumbs: Breadcrumb[] | null): string | null {
  if (!Array.isArray(breadcrumbs)) return null;
  for (const crumb of breadcrumbs) {
    const label = crumb.label?.trim();
    if (label && /\skommun$/i.test(label)) {
      return label.replace(/\skommun$/i, "").trim();
    }
  }
  return null;
}
```
This is currently a private, non-exported helper in `fetch-brf-auto.ts`. **Relocate it** (export it) from `client.ts` (or a shared breadcrumb-util module `client.ts` already owns) so BOTH the discovery scrape path and the existing `fetch-brf-auto.ts` single-listing path call the SAME implementation — do not fork a second copy. `fetch-brf-auto.ts`'s own doc comment (lines 55-63) already documents the genitive-form caveat ("Stockholms kommun" → "Stockholms" vs a nominative "Stockholm") — D-14-09 also asks to improve `normalizeKommun` (in `org-nr-resolver.ts`) to handle this; that is a SEPARATE, smaller fix inside `org-nr-resolver.ts`, not this function.

---

### `src/lib/discovery/job.ts` — `runVisionForJob` gains comps + BRF wiring

**Analog for the BRF top-N concurrency:** `runSlice`'s own `Promise.allSettled` block (:186-205) — copy this pattern verbatim, including its fulfilled/rejected aggregation and per-index error-context logging:

```typescript
const settled = await Promise.allSettled(
  areaIds.map((areaId) => fetchAreaListings(areaId, filters.objectType)),
);
const raw: Record<string, unknown>[] = [];
let anyThrew = false;
let rendersUsed = 0;
for (let i = 0; i < settled.length; i++) {
  const outcome = settled[i];
  if (outcome.status === "fulfilled") {
    rendersUsed += 1;
    raw.push(...outcome.value);
  } else {
    anyThrew = true;
    console.error("[discovery-job] kill-switch degraded", {
      jobId,
      areaId: areaIds[i],
      code: outcome.reason instanceof Error ? outcome.reason.message : "UNKNOWN",
    });
  }
}
```
For BRF, the analogous shape (per RESEARCH.md's own Q4 code example, already grounded against this exact template) is:
```typescript
const brfResults = await Promise.allSettled(
  brfEligible.map(async (index) => {
    const candidate = enriched[index];
    // ... searchAllabrfByName -> resolveOrgNr -> fetchAllabrfDocument -> extractBrfFinancials -> scoreExtraction
    return { index, summary, costSek };
  }),
);
for (let i = 0; i < brfResults.length; i++) {
  const outcome = brfResults[i];
  if (outcome.status === "rejected") {
    console.error("[discovery-job] brf fetch degraded (non-fatal)", {
      jobId,
      candidateIndex: brfEligible[i],
      code: outcome.reason instanceof Error ? outcome.reason.message : "UNKNOWN",
    });
    continue; // degrades to comps + hedonic only, per D-14-10 — never fails the tick
  }
  // attach outcome.value.summary to enriched[outcome.value.index]
}
```

**Injection point:** inside `runVisionForJob` (:580-...), immediately after `enrichCandidateImages` returns (`:592-595`), BEFORE `runVisionPass` is called (:596) — mirrors `runVisionForJob`'s existing structure (enrich → vision → persist), inserting a new "enrich → [comps+BRF] → vision → persist" step. Per-candidate `areaId` resolution (via `resolveArea(candidate.areaLabel, supabase)`, already in scope) feeds a `Map<areaId, SoldComp[]>` amortized cache exactly as RESEARCH.md's Q1/Q2 code example shows — no signature change to `runVisionForJob` needed (it already receives `supabase`).

**BRF top-N selection — reuse the existing `enrichmentVisitOrder`/`enrichmentPriority`** (job.ts :433-462, already merged, unchanged):
```typescript
export function enrichmentPriority(
  candidate: DiscoveryCandidate,
  medianPricePerSqm: number | null,
): number { /* below-market + aged-stock weighting, already shipped */ }

export function enrichmentVisitOrder(candidates: DiscoveryCandidate[]): number[] { /* ... */ }
```
Filter `enrichmentVisitOrder(enriched)` to indices where `enriched[i].brfName !== null`, then `.slice(0, BRF_TOP_N)` — do NOT re-derive a new priority function.

---

### `src/lib/discovery/brf-lookup.ts` (NEW — discovery-side BRF orchestrator)

**Structural analog ONLY — `src/actions/fetch-brf-auto.ts`:** copy its SEQUENCING and error-handling shape (search → resolve → fetch → extract → score, each step degrading to a benign `null`/skip on failure rather than throwing), but strip everything `analyses`-bound.

**What to drop from the `fetch-brf-auto.ts` analog (do NOT reuse these calls for discovery):**
- `resolveOrgNrAction(analysisId)` and `confirmAndAnalyze(analysisId, ...)` — both read/write the `analyses` table by `analysisId` (`fetch-brf-auto.ts:83-99, ~172-293`). Discovery candidates have no `analysisId`.
- `runBrfExtraction` (`src/lib/brf/run-extraction.ts`) — unconditionally reads/writes `analyses` status columns (`auto_fetching`/`extracting`/`scoring`/`done`/`failed`, `brf_status`/`brf_data`/`brf_cost_sek`/`brf_pdf_hash`). Never call this from discovery.
- Any Supabase write to the `analyses` table — the discovery-side orchestrator must be a PURE composition of the underlying functions, writing nothing to `analyses`, only returning a value the caller attaches to `DiscoveryCandidate.holisticBrief`/a new BRF field.

**What IS reusable, called directly (pure/network primitives — verified reusable in RESEARCH.md Pitfall 1):**
- `searchAllabrfByName` (`src/lib/brf-source/allabrf.ts`)
- `resolveOrgNr` (`src/lib/brf-source/org-nr-resolver.ts`) — called with `kommun: candidate.kommun` (now available post D-14-09) instead of the single-listing flow's `kommun` from `analyses.listing_data.breadcrumbs`. Same function, different caller-supplied kommun source.
- `fetchAllabrfDocument`/`fetchArsredovisning` (`src/lib/brf-source/allabrf.ts` / `fetch-document.ts`)
- `extractBrfFinancials` (`src/lib/brf/extract.ts`)
- `scoreExtraction`/`normalizeBrfExtraction` (`src/lib/brf/run-extraction.ts` / `src/lib/schemas/brf.ts`)

**Error-handling pattern to copy from `fetch-brf-auto.ts`:** each step returns a discriminated result (`{ ok: true, ... } | { ok: false, error }`) rather than throwing — mirror that shape for the new orchestrator's return type so a failed step degrades gracefully (comps + hedonic only, per D-14-10) instead of rejecting the whole `Promise.allSettled` entry unexpectedly (though the `runSlice`-style wrapper above still catches a reject defensively).

**Module placement + LOCKED separation:** since this orchestrator composes BRF data for the analysis path, add its specifier to `VISION_MODULE_SPECIFIERS` in `niche-score.test.ts` (see below) — same discipline as `area-comps`/`flip-economics`.

---

### `src/lib/discovery/confounder-guard.ts` (NEW — ANL-04 discount-attribution guard)

**Analog module shape — `src/lib/discovery/area-comps.ts`** (full file header, lines 1-57):
```typescript
/**
 * area-comps.ts — PURE comp-set aggregation for the discovery value-gap (SPEC
 * §2.2/§2.6, synthesis §5/§7). ...
 *
 * STRUCTURAL SEPARATION: on the vision/analysis read path; like
 * `flip-economics.ts` it must never be imported by `niche-score.ts` /
 * `flags.ts` (enforced by the niche-score.test.ts static-grep invariant).
 * Pure — no I/O, no model calls.
 */

import type { SoldComp } from "@/lib/market/sold-schema";

export const MIN_COMPS_FOR_CONFIDENCE = 5;
export const DEFAULT_SIZE_BAND_PCT = 0.15;
export const DEFAULT_MAX_AGE_MONTHS = 12;

export interface AreaCompsFilter { /* ... readonly fields ... */ }
export interface AreaComps { /* ... readonly fields, null-tolerant ... */ }
```
Copy this EXACT shape for `confounder-guard.ts`: a file-level doc comment stating (a) which SPEC section it encodes (§2.6), (b) the STRUCTURAL SEPARATION doc-comment paragraph verbatim (swap in the new module's own name), (c) named exported constants for the SPEC-locked thresholds (`>25%` discount trigger, `20%` condition-explained cap, `MIN_COMPS_FOR_CONFIDENCE` reused from `area-comps.ts` — import it, don't redefine), (d) a pure exported function taking already-fetched data (comps `AreaComps`, `BrfSummary | null`, confounder fields off `DiscoveryCandidate`) and returning a result object — no I/O, no model calls, same as `area-comps.ts`/`flip-economics.ts`.

**Export style analog — `src/lib/discovery/flip-economics.ts`** (lines 1-50): named `export function`s + a narrow discriminated-union return type (`BuyerSegment`), no default export, no class — mirror this for the guard's main entry point (e.g. `export function normalizeForConfounders(input): ConfounderResult`).

**Test-file shape analog:** `area-comps.ts` has a sibling `area-comps.test.ts` (pure unit tests, no mocks needed since the module is pure) — create `confounder-guard.test.ts` in the same style: one `describe` block per rule (the `>25%` cap, the `<5`-comps confidence downgrade, the debt-inclusive kr/m² normalization, the "cannot attribute to condition" default posture), each a plain `expect(fn(input)).toEqual(expected)` with no mocking.

**Grep-list registration (MANDATORY, LOCKED constraint) — `niche-score.test.ts:301-310`:**
```typescript
const VISION_MODULE_SPECIFIERS = [
  "discovery/vision-schema",
  "discovery/vision\"",
  "discovery/vision'",
  "discovery/sun-path",
  "discovery/sun-path\"",
  "discovery/sun-path'",
  "discovery/flip-economics",
  "discovery/area-comps",
];
```
Add `"discovery/confounder-guard"` (and `"discovery/brf-lookup"` for the new BRF orchestrator module) as new entries in this array — copy the exact bare-specifier string style used for `discovery/flip-economics`/`discovery/area-comps` (no quote-suffix variants needed for a module with no single/double-quote ambiguity concern beyond what's already handled generically by `importsVisionModule`'s `.includes()` check). This edit must land BEFORE any code imports the new modules into `niche-score.ts`/`flags.ts`, per RESEARCH.md's Wave-0-gap note — otherwise the guard is silently inert.

---

### `src/lib/discovery/vision.ts` — branch at both `claims: []` paths

**Analog:** the file's own two existing `claims: []` return sites.

**Path 1 — Haiku skip** (:285-296):
```typescript
if (!preFilterMessage.parsed_output.worthDeepPass) {
  return {
    result: {
      claims: [],
      imageUrlsUsed: capped,
      model: HAIKU_MODEL,
      costSek: visionCostSek(haikuUsage, null),
      ranAt: new Date().toISOString(),
    },
    skippedReason: null,
  };
}
```

**Path 2 — confidence/imageIndex filter** (:332-366): `claims` is computed via `.filter(...)` and can legitimately end up `[]` — same `VisionResult` shape as Path 1's return.

**Recommended insertion (per RESEARCH.md Q5, do NOT touch `visionResultSchema`/`claims` itself):** add a NEW post-`runVisionPass` step in `runVisionForJob`/a small helper `vision.ts` exports, checking each candidate: `if (candidate.vision && candidate.vision.claims.length === 0 && (comps || brf))` → attach `holisticBrief` built from comps/BRF/confounder data. This is a single shared branch downstream of BOTH `claims: []` producers — it does not need to distinguish which path produced the empty array. Mirrors the file's existing per-candidate try/catch discipline (`runVisionPass`'s loop, :465-538) for degrading gracefully on missing data.

---

### `src/lib/discovery/cost.ts` — fold comps/BRF spend into `runningVisionSek`

**Analog — existing conversion helpers** (lines 1-54):
```typescript
export const USD_PER_RENDER = 0.0055 as const;

export function discoveryCostSek(usage: DiscoveryUsage): number {
  const renders = Number.isFinite(usage.renders) ? Math.max(0, usage.renders) : 0;
  const haikuSek = costSek(usage.haikuUsage);
  const renderSek = renders * USD_PER_RENDER * USD_SEK_RATE;
  return haikuSek + renderSek;
}

export const CAP_VISION_SEK_MAX = 10 as const;
```
Per RESEARCH.md Q3, factor the inline `renders * USD_PER_RENDER * USD_SEK_RATE` arithmetic (currently duplicated ad hoc) into a small exported helper, e.g.:
```typescript
export function renderSek(renders: number): number {
  return Math.max(0, renders) * USD_PER_RENDER * USD_SEK_RATE;
}
```
so comps' `fetchSoldComps` `rendersUsed` converts through the SAME helper `discoveryCostSek` already inlines, rather than a second copy drifting apart on a future rate change (`Don't Hand-Roll` table entry). BRF spend converts via the EXISTING `costSek(usage)` from `src/lib/brf/cost.ts` (same function `run-extraction.ts` already calls) — do not write a second BRF-cost formula.

**Shared-pool wiring pattern (vision.ts :473, `runningVisionSek`):** `runVisionPass`'s existing local accumulator (:473) currently starts at 0 each call; per RESEARCH.md Q3 item 3, widen it with an additive `initialSpentSek: number = 0` parameter so comps+BRF spend computed earlier in `runVisionForJob` seeds the SAME budget pool `runVisionPass` already checks BEFORE each Sonnet call (:506 `if (runningVisionSek + estimate > CAP_VISION_SEK_MAX)`) — copy that exact check-before-spend placement/ordering for the new comps/BRF spend checks.

---

### `src/lib/discovery/niche-score.test.ts` — `VISION_MODULE_SPECIFIERS` exact current shape (verbatim, lines 301-310)

```typescript
const VISION_MODULE_SPECIFIERS = [
  "discovery/vision-schema",
  "discovery/vision\"",
  "discovery/vision'",
  "discovery/sun-path",
  "discovery/sun-path\"",
  "discovery/sun-path'",
  "discovery/flip-economics",
  "discovery/area-comps",
];
```
Add two new entries: `"discovery/confounder-guard"` and `"discovery/brf-lookup"` (or whatever exact module basenames the planner assigns — keep them bare, matching the `flip-economics`/`area-comps` entries' style, since those two have no quote-variant siblings in the array either). This edit is one line each but MUST land in the SAME task/commit that introduces the new modules, per the phase's Wave-0-gap note — the two `it(...)` blocks below it (lines 322-328) are self-verifying once the specifiers are present.

---

### `src/components/discovery-results.tsx` / `src/components/gallery-condition-vision.tsx` — data-only marker + confounder-safe framing (D-14-07)

**Analog — the existing `visionSkippedReason`/`visionRanButEmpty` branch structure** (`gallery-condition-vision.tsx`, lines 114-140):
```tsx
<CardContent className="space-y-3">
  {visionSkippedReason === "no_images" && (
    <p className="text-sm italic text-warm-gray-500">
      Inga bilder tillgängliga för den här annonsen — ingen bildbedömning
      kunde göras.
    </p>
  )}

  {visionSkippedReason === "cost_cap" && (
    <p className="text-sm italic text-warm-gray-500">
      Bildbedömning kördes inte för den här annonsen (sökgränsen för
      bildanalys nåddes).
    </p>
  )}

  {visionSkippedReason === "vision_error" && (
    <p className="text-sm italic text-warm-gray-500">
      Bildbedömning kunde inte genomföras för den här annonsen just nu.
    </p>
  )}

  {visionSkippedReason === null && visionRanButEmpty && (
    <p className="text-sm italic text-warm-gray-500">
      För osäkert för att visa — inga bildbaserade slutsatser kunde dras
      med rimlig säkerhet.
    </p>
  )}

  {visionSkippedReason === null && hasClaims && (
    <>{/* claims list ... */}</>
  )}
</CardContent>
```
**Insertion for D-14-04's marker:** add a new branch alongside `visionRanButEmpty` — when `visionRanButEmpty && candidate.holisticBrief` (the new additive-nullable field), render the "Baserat på områdesdata — ingen bildtolkning" marker INSTEAD of (or above) the existing "För osäkert för att visa" line, with a visibly downgraded-confidence framing. This is the mirror image of the existing header framing at lines 104-111:
```tsx
<CardTitle className="text-base font-semibold text-warm-gray-900">
  AI-bedömning av bilder — kan vara fel
</CardTitle>
<p className="text-sm text-warm-gray-500">
  Tolkat från bilder i annonsen — inte en verifierad uppgift. Kontrollera
  själv innan du drar slutsatser.
</p>
```
The new marker should use analogous (but explicitly DATA-not-IMAGE) copy — e.g. a small `<p>` with `italic text-warm-gray-500` styling reading "Baserat på områdesdata — ingen bildtolkning" placed where D-14-04 specifies, never implying image-derived confidence.

**Confounder-safe framing (D-14-06 UI guard):** wherever the new holistic-brief text is composed (in `confounder-guard.ts`/the fallback-construction helper, NOT in the component itself — the component only renders pre-computed strings/fields), the generated text must never state or imply "low kr/m² ⇒ renoveringsobjekt" — this is enforced at the DATA-construction layer (confounder-guard.ts), and the component-level test (see below) should assert the rendered marker never contains banned phrasing, mirroring `vision.ts`'s own existing "banned-word REJECTION" discipline for claim text (referenced at vision.ts :367-369).

**Test file — resolved definitively:** `src/components/discovery-results.test.tsx` EXISTS (confirmed via `ls src/components/`) and there is ALSO a sibling `src/components/gallery-condition-vision.test.tsx` (confirmed) — since the actual "från bildtolkning"-style marker/empty-state rendering logic lives in `gallery-condition-vision.tsx`, NOT `discovery-results.tsx` (which only handles ranking/grid layout), the new data-only marker's component-level test cases belong primarily in `gallery-condition-vision.test.tsx`, with `discovery-results.test.tsx` covering only the ranking-level "never implies reno" static-copy check if the marker text is duplicated at the card-summary level too.

## Shared Patterns

### Additive-nullable persisted field (CR-01 discipline)
**Source:** `src/lib/discovery/candidate.ts` — the `constructionYear`/`brfName`/`tenureForm`/`imageUrls`/`vision`/`visionSkippedReason`/`latitude`/`longitude`/`floor`/`orientation`/`balcony` precedent (lines 244-303).
**Apply to:** `kommun` (D-14-09), `holisticBrief` (ANL-01), the per-candidate `AreaComps` aggregate (ANL-02), the per-candidate `BrfSummary` aggregate (ANL-03) — ALL new persisted candidate fields.
```typescript
someField: z.string().nullable().default(null),   // NEVER .optional() alone
```

### Concurrent-batch with graceful per-item degradation
**Source:** `src/lib/discovery/job.ts` `runSlice`'s `Promise.allSettled` block (:186-205).
**Apply to:** the BRF top-N fetch loop (D-14-10) and the per-areaId comps fetch loop — never a sequential `for...await`.

### Cost-gate check-before-spend
**Source:** `src/lib/discovery/vision.ts` `runVisionPass`'s `runningVisionSek + estimate > CAP_VISION_SEK_MAX` check (:506), and `src/lib/discovery/cost.ts`'s render→SEK conversion helpers.
**Apply to:** comps `fetchSoldComps` render spend and BRF `extractBrfFinancials` Haiku spend, both sharing the SAME `CAP_VISION_SEK_MAX` pool (D-14-08) — check BEFORE each fetch/call, never only after.

### Structural-separation grep registration
**Source:** `src/lib/discovery/niche-score.test.ts`'s `VISION_MODULE_SPECIFIERS` array (:301-310).
**Apply to:** any new module on the vision/analysis read path (`confounder-guard.ts`, `brf-lookup.ts`) — MUST be added to this array in the SAME task that introduces the module.

### Never-fabricate / fail-honest degradation
**Source:** `src/lib/discovery/candidate.ts`'s coercion helpers (`num`/`str`/`bool`, lines 9-13) — malformed/missing data yields `null`, never a throw or a fabricated value; `src/actions/fetch-brf-auto.ts`'s `kommunFromBreadcrumbs` fails CLOSED to `"low"` confidence rather than wrongly promoting to `"high"` on a format mismatch.
**Apply to:** the confounder guard's "cannot attribute to condition" default posture (D-14-05) and the BRF top-N loop's per-candidate degrade-to-null-summary on any failed step.

## No Analog Found

None — every file in this phase's scope has at least a role-match analog already identified above. The BRF orchestrator (`brf-lookup.ts`) has no DIRECT reusable analog (its nearest structural analog, `fetch-brf-auto.ts`, is explicitly NOT reusable as a black box — see Pattern Assignments above) but is not analog-less: its four constituent primitives are each individually reusable, tested, pure/network functions.

## Metadata

**Analog search scope:** `src/lib/discovery/*`, `src/lib/booli/client.ts`, `src/lib/brf-source/*`, `src/lib/brf/*`, `src/actions/fetch-brf-auto.ts`, `src/components/discovery-results.tsx`, `src/components/gallery-condition-vision.tsx`, `src/lib/discovery/niche-score.test.ts`
**Files scanned:** ~14 read directly (full or targeted), plus grep sweeps over `src/lib/discovery/`, `src/components/`
**Pattern extraction date:** 2026-08-05
