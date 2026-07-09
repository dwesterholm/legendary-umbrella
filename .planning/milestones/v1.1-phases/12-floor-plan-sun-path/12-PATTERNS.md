# Phase 12: Floor-Plan & Sun-Path - Pattern Map

**Mapped:** 2026-07-07
**Files analyzed:** 8 (2 new, 6 modified)
**Analogs found:** 8 / 8

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/lib/discovery/sun-path.ts` (NEW) | utility (pure deterministic math) | transform | `src/lib/discovery/niche-score.ts` (pure scorer) + `src/lib/booli/client.ts`'s `brfNameFromBreadcrumbs` (deterministic text extractor) | role-match (two distinct analogs, one per exported function) |
| `src/lib/discovery/sun-path.test.ts` (NEW) | test | transform | `src/lib/discovery/niche-score.test.ts` | role-match |
| `src/lib/discovery/vision-schema.ts` (MODIFY) | model/schema | request-response | itself, extending `conditionAttribute`/`visionDeepPassSchema` (exact, in-place pattern repetition) | exact |
| `src/lib/discovery/vision.ts` (MODIFY) | service | request-response | itself, extending the `claims` tuple-array mapping loop | exact |
| `src/lib/discovery/vision-prompt.ts` (MODIFY) | config (prompt text) | request-response | itself, extending `VISION_DEEPPASS_SYSTEM_PROMPT` | exact |
| `src/lib/discovery/candidate.ts` (MODIFY) | model | CRUD | itself, extending `DiscoveryCandidate`/`toCandidate`/`discoveryCandidateSchema` per Phase 10's `constructionYear`/`brfName`/`tenureForm` precedent | exact |
| `src/lib/booli/client.ts` (MODIFY, additive only) | service (extractor) | transform | itself — `floor: entry.floor ?? undefined` passthrough already exists (line 315); no new extraction code needed, just threading into `toCandidate` | exact (already solved) |
| `src/components/gallery-condition-vision.tsx` (MODIFY) | component | request-response (render) | itself, extending `ATTRIBUTE_LABELS` + adding a sibling sub-block inside the same `CardContent` | exact |
| `src/components/sun-path-exposure.tsx` (NEW, or sub-block inside gallery-condition-vision.tsx per UI-SPEC) | component | transform (render of computed data) | `gallery-condition-vision.tsx` (Card shell/CardHeader identity pattern), but props/data-shape diverge deliberately (no `VisionResult`) | role-match |
| `package.json` (`suncalc` dependency) | config | — | Phase 6's `cheerio` Package Legitimacy Gate precedent | exact (pre-verified this session, see Metadata) |

## Pattern Assignments

### `src/lib/discovery/sun-path.ts` (NEW — utility, transform)

**Analog 1 — pure deterministic scorer shape:** `src/lib/discovery/niche-score.ts` (read for file-level doc-comment conventions: pure function, typed result, no I/O, structural-separation discipline stated up top). Mirror its top-of-file doc-comment pattern: state explicitly that this module has NO Anthropic/network dependency and is NEVER imported by `niche-score.ts`/`flags.ts` (reciprocal of the invariant test below).

**Analog 2 — deterministic text-extraction shape:** `src/lib/booli/client.ts` lines 150-164 (`brfNameFromBreadcrumbs`):
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
**Pattern to copy:** guard-clause-first, never-throw, `null`-on-anything-unmatched shape. `extractOrientationFromDescription` should follow this exact skeleton: type-guard the input first (`if (!description) return null;`), then a single deterministic regex/keyword pass, returning `null` on zero matches — never a fallback guess. RESEARCH.md's Pattern 3 code example is the concrete regex table (`ORIENTATION_KEYWORDS`) — copy its structure verbatim rather than re-deriving it.

**Null-tolerant coercion helpers to reuse (not reinvent):** `src/lib/discovery/candidate.ts` lines 6-15 (`num`/`str`/`arrOfStr`) — if `sun-path.ts` needs to validate `latitude`/`longitude`/`floor` inputs defensively, reuse this exact `num()` shape (typeof-check + `Number.isFinite`) rather than writing a new coercion helper; RESEARCH.md's Security Domain section already establishes these values pass through `num()` before ever reaching `computeSunExposure`.

**suncalc usage (genuinely NEW mechanism — no prior in-repo analog):**
```typescript
// Source: RESEARCH.md Code Examples (verified live against v2.0.0 README)
import * as SunCalc from "suncalc";
const pos = SunCalc.getPosition(date, latitude, longitude);
// pos.altitude (degrees above horizon), pos.azimuth (degrees, clockwise from north; 180=south)
const times = SunCalc.getTimes(date, latitude, longitude);
```
**MANDATORY pre-implementation smoke test (RESEARCH.md Pitfall 1):** before writing any facade-bucketing logic, assert `SunCalc.getPosition(<known solar-noon UTC timestamp>, <known lat/lon>).azimuth ≈ 180`. This is the single highest-risk unverified assumption in this phase (Assumption A1) — treat it as a blocking first task, not an afterthought.

**Null-propagation contract (RESEARCH.md Pitfall 4 — copy this exact skeleton):**
```typescript
export function computeSunExposure(
  latitude: number | null,
  longitude: number | null,
  floor: number | null,
  orientation: Facade[] | null,
): SunExposureResult {
  if (latitude === null || longitude === null || floor === null || orientation === null) {
    return { byFacadeAndSeason: null, orientationSource: "unavailable", orientationConfidence: null };
  }
  // ...
}
```
Never default to an empty array/zeroed object on missing input — `byFacadeAndSeason: null` is the ONLY correct "we don't know" sentinel (UI reads this to render "ej tillgänglig", never a fabricated "0 timmar").

---

### `src/lib/discovery/sun-path.test.ts` (NEW — test)

**Analog:** `src/lib/discovery/niche-score.test.ts` — pure-function test file, no mocking needed. Copy its `describe`/`it` structure and its structural-separation invariant pattern (lines 274-304) for the reciprocal assertion:
```typescript
// Pattern to copy (adapted): grep-based static assertion that niche-score.ts
// and flags.ts import NEITHER vision-schema.ts NOR sun-path.ts.
function importsVisionModule(sourcePath: string): boolean { /* ...existing helper, EXTEND its module-specifier list... */ }
```
The existing test (`niche-score.test.ts` lines 298-304) checks only `vision-schema`/`vision.ts` specifiers — RESEARCH.md's Validation Architecture table explicitly requires extending this same test to also grep for a `sun-path` import. Do not write a new separate invariant test file; extend the existing one.

**Required test cases per RESEARCH.md Validation Architecture table:**
- `byFacadeAndSeason: null` for each of the 4 independent missing-input cases (lat/lon/floor/orientation) — one `it()` per case, not a single combined case.
- Azimuth-convention smoke test (Pitfall 1) — must exist and pass BEFORE any bucketing-logic test is trusted.
- `extractOrientationFromDescription` returns `null` on non-matching text (never a guess).

---

### `src/lib/discovery/vision-schema.ts` (MODIFY)

**Analog:** itself. This is a literal repetition of the existing pattern, not a new pattern.

**Exact diff shape** (file lines 68-72 today):
```typescript
export const visionDeepPassSchema = z.object({
  kitchen: conditionAttribute,
  bathroom: conditionAttribute,
  overall: conditionAttribute,
  remodelPotential: conditionAttribute, // NEW — reuses the SAME conditionAttribute shape verbatim
});
```
**Also update:**
- `VisionConditionClaim["attribute"]` union (line 98): add `"remodelPotential"`.
- `visionResultSchema`'s `z.enum(["kitchen", "bathroom", "overall"])` (line 134): add `"remodelPotential"`.
- The file's own top-of-file doc comment (lines 14-19) states "3 nullable leaves... well under the ~28 threshold" — update to "4 leaves" per RESEARCH.md Open Question 4, and extend whatever static nullable-leaf-count assertion test exists (`vision-schema.test.ts`, not yet read this session but referenced in RESEARCH.md's Validation Architecture table) from `count === 3` to `count === 4`.

**Live smoke-test discipline (project memory `anthropic-structured-output-limits`):** mocked tests do NOT catch a 400 from too many nullable-union params. RESEARCH.md explicitly calls for re-running the ONE live API smoke test against the extended (4-leaf) schema before trusting it in production — this is a REQUIRED manual/cost-gated step per the Validation Architecture table, not optional polish.

---

### `src/lib/discovery/vision.ts` (MODIFY)

**Analog:** itself, extending the existing claims-mapping tuple array (lines 216-245):
```typescript
const claims: VisionConditionClaim[] = (
  [
    ["kitchen", parsed.kitchen],
    ["bathroom", parsed.bathroom],
    ["overall", parsed.overall],
    ["remodelPotential", parsed.remodelPotential], // NEW
  ] as const
)
  .filter(/* SAME confidence + imageIndex-bounds filter, UNCHANGED */)
  .map(([attribute, attr]) => ({
    attribute,
    // Belt-and-suspenders code-enforced disclaimer — liability text must
    // never depend solely on model compliance (RESEARCH.md Pattern 1).
    claim:
      attribute === "remodelPotential"
        ? `${attr.claim} Detta är endast ett underlag för vidare utredning — kräver konstruktör/väggutredning för att avgöra bärande väggar.`
        : (attr.claim as string),
    imageIndex: attr.imageIndex,
    whatWasSeen: attr.whatWasSeen,
    confidence: attr.confidence,
  }));
```
No other change to `vision.ts` is needed — `imageBlocks`, cost logic, refusal/max_tokens handling, and the GDPR-safe catch-block logging (lines 257-263) are ALL unchanged; the floor plan rides inside the same capped image set already sent (`extractImageUrls` already orders floor-plan images first, `client.ts` lines 249-268 — zero new plumbing).

**Citation-target requirement (UI-SPEC Component Inventory §1):** the `imageIndex` a `remodelPotential` claim cites MUST resolve to the floor-plan image specifically. Since `extractImageUrls` already orders floor-plan images first in `capped`, and the deep-pass prompt will instruct the model to assess `remodelPotential` FROM the floor-plan image, no additional index-validation code is needed beyond the EXISTING `imageIndex >= 1 && imageIndex <= capped.length` bounds check (lines 236-237) — this is inherited for free, not a new pattern.

---

### `src/lib/discovery/vision-prompt.ts` (MODIFY)

**Analog:** itself, extending `VISION_DEEPPASS_SYSTEM_PROMPT` (lines 41-51). Follow the EXACT same hedged-language contract already documented in the file's own top-of-file doc comment (lines 14-18): verbs "verkar"/"ser ut att"/"tyder på", never "är"/a verdict.

**New instruction to add (mirrors the existing kitchen/bathroom/overall paragraph structure):**
```
- Bedöm planlösningens potential för framtida ombyggnad utifrån planritningen (om en sådan finns bland bilderna). Peka ALDRIG ut en vägg som bärande eller icke-bärande som ett FAKTUM — formulera ENDAST som en fråga att utreda vidare, t.ex. "kan eventuellt vara värt att undersöka". Avsluta ALLTID denna bedömning med frasen "kräver konstruktör / väggutredning". Använd ALDRIG orden "bärande", "icke-bärande", "garanterat", "definitivt", eller "kan enkelt rivas" i denna bedömning.
```
**Banned-word test (RESEARCH.md Validation Architecture table):** `vision-prompt.test.ts` (existing file, not yet read this session but referenced in the RESEARCH.md test map) needs a NEW assertion that the prompt text never contains a definitive load-bearing verdict phrase — mirror whatever existing banned-word assertion pattern that file already uses for kitchen/bathroom/overall's "verkar"/"är" distinction, applied to the new "bärande"/"icke-bärande"/"garanterat"/"definitivt" list from UI-SPEC's Copywriting Contract.

---

### `src/lib/discovery/candidate.ts` (MODIFY)

**Analog:** itself — this is Phase 10's `constructionYear`/`brfName`/`tenureForm` precedent, repeated a third time.

**`DiscoveryCandidate` interface extension** (after line 58, mirroring the Phase 10/11 comment-block style):
```typescript
// Phase 12 (DISC-06) additions — additive-nullable, no migration (matches
// Phase 10's constructionYear/brfName/tenureForm precedent exactly).
// latitude/longitude/floor are ALREADY extracted elsewhere in the codebase
// (client.ts's join-key latitude/longitude passthrough, line 302-303; the
// Phase 6 floor passthrough, line 315) — zero new scraping/network cost,
// simply threaded into the allowlist for the first time. `orientation` is
// NEVER the raw description text (PII risk, RESEARCH.md Pitfall 3) — only
// the DERIVED extractOrientationFromDescription() result is persisted.
latitude: number | null;
longitude: number | null;
floor: number | null;
orientation: { facades: Facade[]; confidence: number } | null;
```
**`toCandidate` extension** (after line 90, same `num()`/derive-once-at-creation-time pattern as `brfName: str(raw.brfName)` at line 88):
```typescript
latitude: num(raw.latitude),
longitude: num(raw.longitude),
floor: num(raw.floor),
orientation: extractOrientationFromDescription(str(raw.description)),
```
**CRITICAL — do NOT add `description` to the `DiscoveryCandidate` interface or the allowlist.** Only the DERIVED `orientation` result is persisted (RESEARCH.md Pitfall 3 / Open Question 2, resolved). `raw.description` is read ONLY as a local variable inside `toCandidate`, fed into `extractOrientationFromDescription`, and discarded — never stored on the returned object literal. This mirrors `brfName`'s "derive once, persist only the derived value" precedent (`brfNameFromBreadcrumbs(entry.breadcrumbs)` at `client.ts:333`) exactly.

**`discoveryCandidateSchema` extension** (after line 137, SAME `.nullable().default(null)` discipline — never `.optional()` alone, per this file's own CR-01 fix comment at lines 113-121):
```typescript
latitude: z.number().nullable().default(null),
longitude: z.number().nullable().default(null),
floor: z.number().nullable().default(null),
orientation: z
  .object({ facades: z.array(z.enum(["north", "east", "south", "west"])), confidence: z.number() })
  .nullable()
  .default(null),
```

**Allowlist test tripwire (RESEARCH.md Pitfall 3):** `candidate.test.ts`'s exact-key-tested allowlist assertion (09-01's key decision) WILL fail after this change — that failure IS the expected tripwire; extend the test's expected key list, do not weaken/remove it.

**Where `latitude`/`longitude`/`floor` come from on the raw record (`src/lib/booli/client.ts`):**
- `latitude`/`longitude`: already unwrapped at lines 302-303 (`num(entry.latitude) ?? undefined`) — no change needed in `client.ts` at all, they already flow through `reshapeListingEntity`'s output into whatever raw record reaches `toCandidate`.
- `floor`: already passed through raw at line 315 (`floor: entry.floor ?? undefined`, still the `{raw: 3}` FormattedValue shape) and already unwrapped downstream by `normalizeScraperOutput` via `num(raw.floor) ?? rawOf(raw.floor)` per RESEARCH.md Open Question 5 — confirm whichever raw record `toCandidate` actually receives already carries the UNWRAPPED numeric floor (post-`normalizeScraperOutput`), not the raw FormattedValue object, before writing `floor: num(raw.floor)` in `toCandidate`.

---

### `src/components/gallery-condition-vision.tsx` (MODIFY)

**Analog:** itself.

**`ATTRIBUTE_LABELS` extension** (line 20-24):
```typescript
const ATTRIBUTE_LABELS: Record<VisionConditionClaim["attribute"], string> = {
  kitchen: "KÖK",
  bathroom: "BADRUM",
  overall: "ALLMÄNT SKICK",
  remodelPotential: "PLANLÖSNING", // NEW — UI-SPEC Component Inventory §1
};
```
No other change to the claims-rendering `<ul>`/`.map()` loop (lines 105-142) — floor-plan claims render in the SAME flat list, same row shell, same `Eye`/terracotta identity (UI-SPEC: "floor-plan IS vision-derived, so it correctly inherits the Eye identity" — do not fork a separate rendering path).

**Section-level reinforcement line (UI-SPEC Copywriting Contract, renders ONLY when ≥1 `remodelPotential` claim exists):** add directly below the claims `<ul>`, before or alongside the existing "Kan vara fel..." disclaimer (line 144-147) — same `text-xs text-warm-gray-500` treatment, new copy: "Observationerna ovan är AI:ns tolkning av en 2D-planritning — inte en bedömning av bärande konstruktion. Kontakta alltid en konstruktör innan du river eller flyttar en vägg."

**Sun-path sub-block placement (UI-SPEC Component Inventory §2 — binding structural decision):** per UI-SPEC, the sun-path sub-block lives INSIDE this SAME `CardContent`, after the claims list and after the existing "Kan vara fel" disclaimer, separated by `pt-4 border-t border-warm-gray-100`. This means `sun-path-exposure.tsx` is most naturally NOT a fully separate top-level `Card` component but a sub-block rendered inside `GalleryConditionVision`'s `CardContent` OR a small sibling component imported and rendered there — either file-organization choice satisfies UI-SPEC as long as the RENDERED OUTPUT is one continuous `Card`. RESEARCH.md's Open Question 3 recommends a separate component file for prop/type-boundary cleanliness (`SunExposureResult` is not `VisionResult`); UI-SPEC section 2 confirms the render POSITION is inside the same card. Recommend: new file `src/components/sun-path-exposure.tsx` exporting a component that renders ONLY the inner sub-block markup (no outer `Card`), imported and placed inside `GalleryConditionVision`'s existing `CardContent` after the disclaimer paragraph.

**New icon import:** `Compass` from `lucide-react` (already a dependency, ^0.575.0) — NEW icon this phase, deliberately distinct from `Eye` (UI-SPEC Color section: terracotta = "AI interpreted a photo"; `Compass`/warm-gray = "computed, not interpreted").

---

### `src/components/sun-path-exposure.tsx` (NEW)

**Analog (shell/identity conventions only, NOT data shape):** `gallery-condition-vision.tsx`'s `CardHeader` icon-badge pattern (lines 60-68) — copy the STRUCTURE, not the terracotta/`Eye` styling:
```tsx
// Pattern to copy (badge structure), values to CHANGE (icon + color per UI-SPEC):
<div className="flex h-6 w-6 items-center justify-center rounded-full bg-warm-gray-100">
  <Compass className="h-3.5 w-3.5 text-warm-gray-500" />
</div>
```
Note the badge is deliberately SMALLER (`h-6 w-6`/`h-3.5 w-3.5`) than the vision card's own `h-8 w-8`/`h-4 w-4` `Eye` badge (UI-SPEC: "since this is a sub-heading within the card, not the card's primary identity").

**Props shape (deliberately NOT `VisionResult`/`VisionConditionClaim` — RESEARCH.md Open Question 3):**
```typescript
interface SunPathExposureProps {
  latitude: number | null;
  longitude: number | null;
  floor: number | null;
  orientation: { facades: Facade[]; confidence: number } | null;
}
```
Compute `computeSunExposure(...)` either inside this component (client-safe, pure function, per RESEARCH.md's Architectural Responsibility Map noting it's callable from either tier) or upstream and passed as a prop — Claude's discretion; RESEARCH.md notes co-locating computation in `src/lib/discovery/` (server-adjacent) avoids a duplicate client/server implementation, so computing it upstream (e.g. in the page/server component) and passing the RESULT down as a prop is the safer default, mirroring how `vision`/`visionSkippedReason` are already pre-computed props rather than computed inside `GalleryConditionVision` itself.

**Degraded-state copy (UI-SPEC, exact string, `italic text-warm-gray-500 text-sm`):**
```
Solexponering: ej tillgänglig — riktning eller våningsdata saknas för denna annons.
```
**No thumbnail, no "Bild N" citation, no `Eye`, no terracotta anywhere in this component** (UI-SPEC explicit exclusion list) — this is the one place where copying `gallery-condition-vision.tsx`'s row markup verbatim would be WRONG; only the outer badge/heading STRUCTURE transfers, not the citation-row content.

**Grid cells:** plain CSS grid, `rounded-md bg-warm-gray-50 border border-warm-gray-100 p-2 text-center` — no charting library, no color-coding (UI-SPEC binding constraint, extends CONTEXT.md's "no heavy new charting").

---

## Shared Patterns

### Additive-nullable persistence (no migration)
**Source:** `src/lib/discovery/candidate.ts` lines 105-138 (`discoveryCandidateSchema`'s `.nullable().default(null)` discipline) + `supabase/migrations/010_discovery_jobs.sql` (confirms `results jsonb` column already supports arbitrary additive fields).
**Apply to:** `candidate.ts`'s `latitude`/`longitude`/`floor`/`orientation` fields. **No new migration needed** — confirmed by RESEARCH.md directly against the existing JSONB column; this is the THIRD phase in a row (10, 11, 12) extending the same JSONB blob additively. Use `.nullable().default(null)`, never `.optional()` alone (see this file's own CR-01 comment for why `.optional()` breaks `=== null` guards on legacy rows).

### Never-throw, null-on-anything-unmatched deterministic extraction
**Source:** `src/lib/booli/client.ts` lines 157-164 (`brfNameFromBreadcrumbs`) and lines 135-148 (`amenityKeys`).
**Apply to:** `extractOrientationFromDescription` in `sun-path.ts`. Guard clause first, single deterministic pass, `null` on no match — never a fallback inference.

### Code-enforced (not prompt-only) liability disclaimers
**Source:** `src/lib/discovery/vision.ts` lines 205-217 (the `remodelPotential`-specific ternary appending the disclaimer AFTER parsing) — this is a NEW pattern instance this phase, but it directly mirrors the project's pre-existing "no verdict field" schema-enforcement philosophy (`reportSchema`, referenced in RESEARCH.md's Open Question 1).
**Apply to:** `vision.ts`'s claims-mapping loop. A liability-bearing sentence must never depend solely on model prompt-compliance — belt-and-suspenders, prompt AND code both carry it.

### Structural-separation invariant (vision/sun-path NEVER feed the deterministic scorer)
**Source:** `src/lib/discovery/niche-score.test.ts` lines 274-304 (the existing grep-based static import-check test).
**Apply to:** extend the SAME test (do not create a new file) to also assert neither `niche-score.ts` nor `flags.ts` imports from `sun-path.ts`. This is a reciprocal, not a new mechanism.

### `num()`/`str()`/`arrOfStr()` null-tolerant coercion
**Source:** `src/lib/discovery/candidate.ts` lines 6-15.
**Apply to:** any new field extraction in `toCandidate` (`latitude`/`longitude`/`floor`) and optionally inside `sun-path.ts` if raw numeric inputs need defensive validation before reaching `suncalc`.

## Genuinely New Mechanisms (no in-repo analog — first occurrence this phase)

| Mechanism | Why no analog exists | Risk mitigation already in RESEARCH.md |
|-----------|----------------------|------------------------------------------|
| `suncalc.getPosition`/`getTimes` usage | First astronomy/geospatial-math dependency in the codebase | Mandatory azimuth-convention smoke test (Pitfall 1) before any bucketing logic; Package Legitimacy Gate already run (see Metadata) |
| Swedish väderstreck keyword regex (`extractOrientationFromDescription`) | First "extract a fact from free text via regex, return null on no match, NEVER guess" pattern outside `brfNameFromBreadcrumbs`'s narrower breadcrumb-ladder case | Safe failure direction is under-matching → "ej tillgänglig", never a false positive (RESEARCH.md Assumption A2) |
| Computed-vs-interpreted UI split (`Eye`/terracotta vs `Compass`/warm-gray, same card) | First time two structurally distinct epistemic categories (AI-interpreted vs. exact-math) are deliberately co-presented inside ONE card rather than either merged or fully separated | UI-SPEC Color section states the rationale explicitly and reserves the `warm-gray-500`-on-`warm-gray-100` pairing exclusively for this pattern going forward |

## No Analog Found

None — every file to create/modify has at least a role-match or exact analog above. `suncalc`'s astronomy math and the orientation-regex are new MECHANISMS (see table above) but the FILES that will contain them (`sun-path.ts`) have clear structural analogs for doc-comment/test conventions even though the math itself is new.

## Migration Check

**No new database migration is needed.** `latitude`/`longitude`/`floor`/`orientation` are additive-nullable fields inside `discovery_jobs.results` (JSONB), confirmed against `supabase/migrations/010_discovery_jobs.sql` directly by RESEARCH.md. This is the third consecutive phase (10, 11, 12) extending the same JSONB blob without a migration — continue that precedent, do not introduce one now.

## Metadata

**Analog search scope:** `src/lib/discovery/`, `src/lib/booli/client.ts`, `src/components/gallery-condition-vision.tsx`, `src/lib/report/flags.ts` (referenced, not re-read), `supabase/migrations/`
**Files scanned:** 8 read directly this session (`vision-schema.ts`, `vision.ts`, `vision-prompt.ts`, `candidate.ts`, `niche-score.test.ts` [partial/grep], `gallery-condition-vision.tsx`, `client.ts` [partial, lines 100-340])
**Package Legitimacy Gate (`suncalc`):** already run during phase research — `slopcheck install suncalc --ecosystem npm` returned `[OK]`, package age/downloads/maintainer independently verified live against the npm registry, then uninstalled to keep the research working tree clean. The planner/executor still needs to run `npm install suncalc` for real as an actual task — this was NOT left installed.
**Pattern extraction date:** 2026-07-07
