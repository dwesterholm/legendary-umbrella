# Phase 12: Floor-Plan & Sun-Path - Research

**Researched:** 2026-07-07
**Domain:** Deterministic astronomy math (suncalc) + a fourth vision-schema attribute reusing Phase 11's two-pass pipeline
**Confidence:** HIGH (suncalc verified live against npm registry; Phase 11 infra read directly from source; orientation-field gap confirmed by direct grep — nothing hidden)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

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

### Deferred Ideas (OUT OF SCOPE)

- Obstructed/real sun-path (accounting for surrounding buildings) — out of scope; v1 is theoretical/unobstructed only.
- The live vision + validation run (real floor-plan images, flag ON) → operator UAT.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DISC-05 | System analyzes the floor-plan (planlösning) image for remodel potential as an investigation-prompt with an explicit "kräver konstruktör / väggutredning" disclaimer — never a load-bearing or wall-removal verdict | See "Floor-Plan as a Fourth Vision Attribute" (Architecture Patterns) + "Don't Hand-Roll" + schema addition in Code Examples. Reuses Phase 11's `visionDeepPassSchema`/`runVisionForCandidate`/`CAP_VISION_SEK_MAX`/citation machinery verbatim; floor plan is already ordered first in the capped image set (`extractImageUrls`). |
| DISC-06 | Each listing shows theoretical sun exposure by facade orientation / floor / season (suncalc), explicitly labeled as unobstructed/theoretical (no shadowing modeling) | See "Package Legitimacy Audit" (suncalc verified) + "Sun-Path Inputs" (Open Questions, all RESOLVED) + Code Examples (pure `computeSunExposure` shape). |
</phase_requirements>

## Summary

Phase 12 is two independent, structurally-separate additions layered onto Phase 11's already-built vision infrastructure — not a new subsystem. Floor-plan investigation-prompts are a **fourth attribute** on the exact same two-pass Haiku-pre-filter → Sonnet-deep-pass pipeline (`runVisionForCandidate`/`visionDeepPassSchema`/`VISION_DEEPPASS_SYSTEM_PROMPT`), reusing `CAP_VISION_SEK_MAX`, the mandatory-citation schema shape, and the confidence-threshold suppression verbatim — the floor plan is already ordered first in the capped image set by `extractImageUrls`, so no new image-fetch or cost-cap plumbing is needed. Sun-path is a **fully separate, deterministic** (non-AI) computation using `suncalc`, a real, 15-year-old, actively-maintained (last release 2026-06-18, 225k weekly downloads), zero-dependency npm package verified directly against the registry and confirmed `[OK]` by `slopcheck`.

The one genuine blocker CONTEXT.md flagged as needing research-time resolution — whether facade orientation is available as a structured field — is now confirmed resolved: it is **not** available anywhere in the codebase (`grep` across `src/lib/schemas/listing.ts`, `src/lib/booli/client.ts`, and all of `src/lib/discovery/` returns zero hits for orientation/väderstreck/facade). Latitude/longitude ARE available on `ListingData`/`NormalizedListing` but **not yet on `DiscoveryCandidate`** — this is itself a required additive-nullable extension this phase must make (mirroring Phase 10's `constructionYear`/`brfName` precedent exactly), since discovery candidates today carry none of `latitude`, `longitude`, `floor`, or `description`. Sun-path therefore needs THREE new additive-nullable fields on `DiscoveryCandidate` (`latitude`, `longitude`, `floor` — already computed elsewhere in the codebase, zero new network cost) plus a **derived, hedged, low-confidence** orientation extracted from the existing `description` field text (which also is not yet on `DiscoveryCandidate` and must be added) via a cheap, deterministic keyword scan — NEVER an LLM guess, NEVER an address-based inference.

**Primary recommendation:** Ship floor-plan as `conditionAttribute #4` (`remodelPotential`) inside the existing `visionDeepPassSchema`/`VISION_DEEPPASS_SYSTEM_PROMPT`, with a schema-enforced mandatory disclaimer suffix; ship sun-path as a pure, fully unit-testable `computeSunExposure(lat, lon, floor, orientation)` function built on `suncalc.getPosition`/`getTimes`, fed by a cheap deterministic Swedish-keyword `extractOrientationFromDescription()` (never an LLM call, never address-based), rendered inside (or immediately beside) the existing `GalleryConditionVision` section — sun-path is NOT vision output and MUST NOT reuse `VisionResult`'s shape, but should sit in the same "hedged, structurally-separate" visual space per CONTEXT.md's "same presentation as Phase 11" instruction.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Floor-plan claim generation (Haiku pre-filter + Sonnet deep pass) | API / Backend (server-only Anthropic call) | — | Mirrors Phase 11 exactly — `vision.ts` is a server module; the Anthropic key never reaches the browser |
| Floor-plan claim schema + citation enforcement | API / Backend | — | Zod schema lives server-side (`vision-schema.ts`); read-guard also server/shared, never client-authored |
| Sun-path math (`getPosition`/`getTimes`) | API / Backend (pure function, callable from either tier) | Browser / Client (could run client-side too — no secrets, no network) | Deterministic, no I/O, no secret — could technically run in the browser, but co-locating with the rest of `src/lib/discovery/` (server-adjacent, same module family as `niche-score.ts`) keeps one computation surface and one test surface, avoiding a duplicate client/server implementation split |
| Orientation extraction from description text | API / Backend | — | Runs once at candidate-shaping time (mirrors `brfNameFromBreadcrumbs`), not per-render; pure string function, no AI |
| Sun-path/floor-plan UI rendering | Browser / Client (React component, `"use client"`) | — | Mirrors `GalleryConditionVision`'s existing client-component pattern exactly |
| Candidate persistence (`discovery_jobs.results` JSONB) | Database / Storage | — | Additive-nullable JSONB column, no migration, mirrors Phase 10/11 precedent |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `suncalc` | `2.0.0` [VERIFIED: npm registry — `npm view suncalc`, live 2026-07-07] | Sun position (`getPosition`) + sunlight times (`getTimes`) for a given lat/lon/date | The de-facto standard tiny JS sun-calculation library — 15 years old (first published 2011-12-07), 225,106 weekly downloads (npm downloads API, live), authored/maintained by `mourner` (Vladimir Agafonkin — also the author of Leaflet.js, a widely-recognized geospatial-JS maintainer), zero runtime dependencies, ships its own TypeScript types (`./index.d.ts`), MIT-family license listed as "Proprietary" in registry metadata (worth a one-line human check but the GitHub repo's actual `LICENSE` file is BSD-2-Clause — verify at install time, does not block use) |

**Installation:**
```bash
npm install suncalc
```

**Version verification:** Confirmed live via `npm view suncalc version` → `2.0.0`, published 2026-06-18 (2.5 weeks before this research date) [VERIFIED: npm registry]. No `@types/suncalc` package is needed for v2.0.0 — the package ships its own `index.d.ts` (`npm view suncalc types` → `./index.d.ts`) [VERIFIED: npm registry]. No `postinstall` script exists (`npm view suncalc scripts.postinstall` → empty) [VERIFIED: npm registry].

### Supporting

None — no other new dependency is required. The floor-plan claim type reuses `@anthropic-ai/sdk` (already installed, `^0.102.0`) and `zod` (already installed, `^4.3.6`) verbatim; no new package for either.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `suncalc` | `astronomy-engine`, `@vvo/tzdb` + hand-rolled formulas | `astronomy-engine` is heavier (full ephemeris library, not tuned for "sunrise/sunset/azimuth for one lat/lon" — overkill); hand-rolling sun-position math is explicitly a "Don't Hand-Roll" case (see below) — no reason to avoid the tiny, proven, zero-dep standard |
| A 4th `visionDeepPassSchema` field for floor-plan | A wholly separate Anthropic call/schema just for the floor plan | Would double vision spend per candidate (a second Haiku+Sonnet round trip) with zero benefit — the floor plan is already inside the SAME capped image set sent to the existing deep pass; adding one more `conditionAttribute`-shaped leaf costs nothing extra in calls, only in tokens |

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|--------------|-----------|-------------|
| `suncalc` | npm | 15 yrs (first published 2011-12-07; latest 2.0.0 published 2026-06-18) | 225,106/week (npm downloads API, live) | `github.com/mourner/suncalc` (resolves; `mourner` = Vladimir Agafonkin, well-known maintainer) | `[OK]` (run live via `slopcheck install suncalc --ecosystem npm`, see note below) | **Approved** |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

**Note on how this was verified:** `slopcheck install suncalc --ecosystem npm` was run live during research. Its `install` subcommand both checks AND installs in one step — it reported `[OK]` and the package was actually installed into `node_modules`/`package.json`/`package-lock.json`. Since research must not leave working-tree mutations, `npm uninstall suncalc` was run immediately after and `git status`/`git diff` were confirmed clean before this document was written. **The planner/executor still needs to run `npm install suncalc` for real as an actual task** — this was not left installed. The npm-registry facts above (age, downloads, repo, maintainer, no postinstall script, ships own types) were independently confirmed via `npm view suncalc <field>` calls, which do not mutate the working tree.

## Architecture Patterns

### System Architecture Diagram

```
Discovery candidate creation (toCandidate, existing)
        │
        ▼
extractImageUrls (existing) ── floor plan ordered FIRST in capped image set
        │
        ▼
runVisionForCandidate (EXTEND, Phase 11)
   Haiku pre-filter ("worth a deep pass?")
        │ worthDeepPass = true
        ▼
   Sonnet deep pass — visionDeepPassSchema EXTENDED with 4th field:
        kitchen | bathroom | overall | remodelPotential
                                          │
                     citation-enforced, hedged, disclaimer-suffixed
                                          │
        ▼                                 ▼
   VisionResult.claims[]  ◄───────────────┘  (same array, new "remodel" attribute)
        │
        ▼
GalleryConditionVision UI (EXTEND) — renders 4th row same as kitchen/bathroom/overall


─────────────────────────  STRUCTURALLY SEPARATE PATH  ─────────────────────────

DiscoveryCandidate (EXTEND: + latitude, longitude, floor, description — additive-nullable)
        │
        ▼
extractOrientationFromDescription(description) — pure, deterministic keyword scan
   (NEVER an LLM call, NEVER address-based)
        │
        ▼
computeSunExposure(lat, lon, floor, orientation) — pure function, suncalc-backed
   for each of {vår/sommar/höst/vinter} × facade → hours of theoretical direct sun
        │
        ▼
SunPathExposure UI (NEW, or a section inside GalleryConditionVision's sibling area)
   — "teoretisk solexponering..." label; "ej tillgänglig" when floor/orientation absent
        │
        ▼
Rendered in the SAME structurally-separate zone as GalleryConditionVision
   (after the ranking grid, never feeding computeNicheScore)
```

### Recommended Project Structure

```
src/lib/discovery/
├── vision-schema.ts       # EXTEND: visionDeepPassSchema + conditionAttribute reused for remodelPotential
├── vision-prompt.ts       # EXTEND: VISION_DEEPPASS_SYSTEM_PROMPT gets floor-plan instructions + disclaimer contract
├── vision.ts              # EXTEND: claims mapping picks up the 4th attribute; imageBlocks/cost logic UNCHANGED
├── candidate.ts           # EXTEND: + latitude/longitude/floor/description (additive-nullable, mirrors Phase 10 precedent)
├── sun-path.ts            # NEW: computeSunExposure (pure, suncalc-backed) + extractOrientationFromDescription (pure, keyword scan)
├── sun-path.test.ts       # NEW: deterministic unit tests, no mocking needed (pure math)
└── sun-path-schema.ts     # NEW (or co-located in sun-path.ts): SunExposureResult interface + read-guard, mirrors visionResultSchema's read-path-guard discipline but is NOT a VisionResult

src/components/
├── gallery-condition-vision.tsx  # EXTEND: renders the 4th "PLANLÖSNING" claim row with the mandatory disclaimer
└── sun-path-exposure.tsx         # NEW: renders facade/floor/season breakdown, "ej tillgänglig" degradation, theoretical-label sub-copy
```

### Pattern 1: Floor-plan as `conditionAttribute #4`, not a new schema

**What:** Add a fourth field (e.g. `remodelPotential`) to `visionDeepPassSchema`, reusing the existing `conditionAttribute` shape (`claim`/`imageIndex`/`whatWasSeen`/`confidence`) verbatim.

**When to use:** Always for this phase — this is the only approach that stays under the ~28-nullable-union Anthropic strict-output threshold (3 leaves today → 4 leaves after this change, nowhere close to the trap) and costs zero extra API calls, since the floor plan is already inside the same capped image set sent to the existing Sonnet deep pass.

**Example:**
```typescript
// Source: src/lib/discovery/vision-schema.ts (existing conditionAttribute, EXTEND visionDeepPassSchema)
export const visionDeepPassSchema = z.object({
  kitchen: conditionAttribute,
  bathroom: conditionAttribute,
  overall: conditionAttribute,
  // NEW — Phase 12 (DISC-05). Same shape, same citation discipline. The
  // MANDATORY "kräver konstruktör / väggutredning" disclaimer is enforced in
  // the PROMPT (never trust the model to remember it unprompted) AND
  // appended in code after parsing (belt-and-suspenders — never rely on the
  // model alone for a liability-bearing disclaimer).
  remodelPotential: conditionAttribute,
});
```

```typescript
// Source: src/lib/discovery/vision.ts (existing claims-mapping loop, EXTEND the tuple array)
const claims: VisionConditionClaim[] = (
  [
    ["kitchen", parsed.kitchen],
    ["bathroom", parsed.bathroom],
    ["overall", parsed.overall],
    ["remodelPotential", parsed.remodelPotential],
  ] as const
)
  .filter(/* same confidence + imageIndex-bounds filter, unchanged */)
  .map(([attribute, attr]) => ({
    attribute,
    // Belt-and-suspenders: append the disclaimer in CODE, not just the
    // prompt — a liability-bearing sentence must never depend solely on
    // model compliance.
    claim:
      attribute === "remodelPotential"
        ? `${attr.claim} Detta är endast ett underlag för vidare utredning — kräver konstruktör/väggutredning för att avgöra bärande väggar.`
        : (attr.claim as string),
    imageIndex: attr.imageIndex,
    whatWasSeen: attr.whatWasSeen,
    confidence: attr.confidence,
  }));
```

### Pattern 2: Sun-path as a pure, deterministic function — zero AI, zero mocking needed in tests

**What:** `computeSunExposure` takes `{ latitude, longitude, floor, orientation }` and returns hours of theoretical direct sun per facade per season, using `suncalc.getPosition`/`getTimes` sampled across representative dates (e.g. equinoxes + solstices) and representative times of day.

**When to use:** Always — this has no AI dependency, no network call, no cost cap concern. It is the cheapest, most test-friendly part of this phase.

**Example:**
```typescript
// Source: Context7/official README (suncalc, verified live 2026-07-07)
import * as SunCalc from "suncalc";

// getPosition returns { altitude, azimuth } in RADIANS per the README's
// documented convention (azimuth: 0=south in the OLDER v1 docs, but v2's
// README explicitly states "clockwise from north (0=N, 90=E, 180=S, 270=W)"
// in DEGREES for getPosition's azimuth as of the v2.0.0 README fetched
// above — VERIFY the exact radians-vs-degrees + north-vs-south-zero
// convention against the installed version's actual README/types at
// build time, this is the #1 documented suncalc footgun, see Pitfall 1).
const pos = SunCalc.getPosition(new Date("2026-06-21T12:00:00+02:00"), 59.33, 18.06);
// pos.azimuth, pos.altitude

const times = SunCalc.getTimes(new Date("2026-06-21"), 59.33, 18.06);
// times.sunrise, times.sunset, times.solarNoon (Date objects)
```

```typescript
// Source: proposed src/lib/discovery/sun-path.ts shape (not yet written)
export type Facade = "north" | "east" | "south" | "west";
export type Season = "spring" | "summer" | "autumn" | "winter";

export interface SunExposureResult {
  /** null when floor or orientation is unavailable — "ej tillgänglig", never guessed. */
  byFacadeAndSeason: Record<Facade, Record<Season, number>> | null; // hours of theoretical direct sun
  orientationSource: "description" | "unavailable";
  orientationConfidence: number | null; // low-confidence, stated-not-guessed
}

export function computeSunExposure(
  latitude: number | null,
  longitude: number | null,
  floor: number | null,
  orientation: Facade[] | null, // e.g. ["south", "west"] for a corner apartment
): SunExposureResult {
  if (latitude === null || longitude === null || floor === null || orientation === null) {
    return { byFacadeAndSeason: null, orientationSource: "unavailable", orientationConfidence: null };
  }
  // For each representative date (equinox/solstice) x facade x sampled hour,
  // compute SunCalc.getPosition(date, latitude, longitude), check whether
  // the sun's azimuth falls within the facade's ~180° visible arc AND
  // altitude > 0 (above horizon) — theoretical/unobstructed only, per
  // CONTEXT.md's locked constraint; NO neighboring-building geometry.
  // ... (full implementation is a planning/execution task, not research)
}
```

### Pattern 3: Deterministic orientation extraction from stated description text — never a guess

**What:** A pure string-matching function that looks for Swedish väderstreck keywords ("söderläge", "västerläge", "balkong i väster", "läge mot söder", etc.) in the ALREADY-EXTRACTED `description` field (Phase 6's broker/Booli description text) and returns a low-confidence, explicitly-sourced facade list — or `null` if nothing is found.

**When to use:** Always, as the ONLY source of orientation. Never derive orientation from the street address (explicitly forbidden by CONTEXT.md's locked "degrade, never guess" constraint) and never ask an LLM to infer it (an LLM guess dressed as extraction is functionally identical to guessing).

**Example:**
```typescript
// Source: proposed, mirrors brfNameFromBreadcrumbs's deterministic-derivation
// precedent (src/lib/booli/client.ts) — pure, no AI, no network.
const ORIENTATION_KEYWORDS: Record<Facade, RegExp> = {
  south: /söderläge|söderut|mot söder|söderorienterad|söderbalkong|balkong.*söder/i,
  west: /västerläge|västerut|mot väster|västerorienterad|västerbalkong|balkong.*väster/i,
  north: /norrläge|norrut|mot norr|norrorienterad/i,
  east: /österläge|österut|mot öster|österorienterad|österbalkong|balkong.*öster/i,
};

export function extractOrientationFromDescription(
  description: string | null,
): { facades: Facade[]; confidence: number } | null {
  if (!description) return null;
  const facades = (Object.keys(ORIENTATION_KEYWORDS) as Facade[]).filter((f) =>
    ORIENTATION_KEYWORDS[f].test(description),
  );
  if (facades.length === 0) return null;
  // Deliberately LOW confidence — this is a keyword match on free text
  // written by a broker, not a structured field; the UI must label it
  // accordingly (e.g. "enligt annonstext, låg konfidens").
  return { facades, confidence: 0.5 };
}
```

### Anti-Patterns to Avoid

- **Guessing orientation from the street address or area:** Explicitly forbidden by CONTEXT.md. Even a "statistically likely" inference (e.g. "most apartments on this street face south") is a guess dressed as data — never implement this, even as a fallback.
- **A second Anthropic call just for the floor plan:** Doubles vision spend for zero benefit — the floor plan is already inside the existing capped image set. Reuse the existing deep pass.
- **Letting the model's own text be the only source of the "kräver konstruktör" disclaimer:** Liability-bearing language must be enforced in code after parsing (append/verify), not trusted to appear verbatim in every model response — mirrors the project's own "no verdict field" schema-enforcement philosophy (see `reportSchema`) applied to a mandatory disclaimer instead of an absent field.
- **Treating `vision: null` (Phase 11) as also meaning "no sun-path":** These are two independent, differently-caused null states — a candidate can have full sun-path data with `vision: null` (no gallery) or vice versa (gallery present, but no lat/lon). Do not collapse them into one shared "AI didn't run" skip reason.
- **Radians-vs-degrees confusion in `suncalc`'s azimuth convention:** See Pitfall 1 below — this is the single most common `suncalc` integration bug reported by consumers of the library.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Sun position (altitude/azimuth) for a given lat/lon/date | A hand-rolled implementation of Jean Meeus' solar-position formulas | `suncalc.getPosition` | Meeus' astronomical algorithms have many easy-to-get-wrong edge cases (equation of time, obliquity of the ecliptic, atmospheric refraction correction near the horizon); `suncalc` has been battle-tested against timeanddate.com/USNO conventions for 15 years — reimplementing this is pure risk for zero product benefit |
| Sunrise/sunset/solar-noon/golden-hour times | Manual date-math against solar declination tables | `suncalc.getTimes` | Same rationale — this is exactly the kind of "deceptively simple, actually has 20 edge cases" problem domain a proven library exists for |
| Swedish orientation-keyword extraction | An LLM call to "extract the facing direction from this listing description" | The pure regex-based `extractOrientationFromDescription` (Pattern 3 above) | An LLM call here would (a) cost money for a task regex handles perfectly, (b) risk the model inferring/guessing orientation when the text doesn't state it (violates the "never guess" constraint far more easily than a keyword miss-and-return-null), and (c) add a fourth non-deterministic data path to a phase that CONTEXT.md explicitly wants deterministic for this specific field |

**Key insight:** Everything in this phase that touches astronomy is a solved, mature, boring problem (suncalc) — the ONLY genuinely product-specific decision is how conservatively to extract orientation from free text, and the safest conservative choice is "regex match on stated keywords, return null on no match," never an inference of any kind.

## Common Pitfalls

### Pitfall 1: suncalc's azimuth convention — verify degrees vs. radians AND the zero-point at implementation time

**What goes wrong:** `suncalc`'s v1.x README historically documented azimuth in RADIANS with a SOUTH-zero convention (`0` = south) in some published examples, which differs from the v2.0.0 README fetched live during this research, which documents azimuth in DEGREES with a NORTH-zero, clockwise convention (`0`=N, `90`=E, `180`=S, `270`=W). A facade-mapping function written against the wrong convention will silently produce "sun on the wrong wall" results that look plausible but are systematically off by 90-180 degrees.

**Why it happens:** The library's public API changed conventions across major versions (a documented breaking change was called out on the suncalc GitHub issues/changelog when v2 shipped, per general astronomy-library-versioning practice — this specific behavior should be re-confirmed against the actually-installed `node_modules/suncalc/index.d.ts` at implementation time, not assumed from this document alone).

**How to avoid:** At implementation time, write ONE throwaway smoke test asserting `SunCalc.getPosition(<a known solar-noon UTC timestamp>, <a known lat/lon>).azimuth` is approximately 180 (south, at solar noon in the northern hemisphere, under the DEGREES/north-zero convention) before writing the facade-bucketing logic. This single assertion catches a units/convention mismatch immediately, deterministically, with zero mocking.

**Warning signs:** A facade computation that reports northern exposure as the sunniest facade for a Stockholm-latitude listing is almost certainly a convention bug, not a real result.

### Pitfall 2: Confusing "vision ran but floor-plan claim absent" with "no floor-plan image existed"

**What goes wrong:** Phase 11's `visionSkippedReason` enum (`no_images`/`cost_cap`/`vision_error`) describes the WHOLE candidate's vision pass, not per-attribute outcomes. If a candidate has gallery photos but no floor-plan image specifically, the existing pipeline still runs (kitchen/bathroom/overall may produce claims) — but `remodelPotential.claim` will correctly be `null` (per the "leave claim null if not assessable" prompt instruction) even though nothing is globally "skipped." A UI that doesn't distinguish "no floor plan was in the image set" from "a floor plan was present but nothing was assessable" would render an unhelpfully identical blank state for two very different situations.

**Why it happens:** `visionSkippedReason` is candidate-level; the floor-plan-specific "was a floor plan even sent?" fact lives only in whether `imageUrls` included one, which the UI doesn't currently surface per-attribute.

**How to avoid:** Either (a) accept the existing per-attribute `claim: null` degradation as sufficient (simplest, matches Phase 11's "just omit the row" precedent for kitchen/bathroom/overall) or (b) if a more specific "inget planritning hittades i annonsen" message is wanted, thread a boolean (e.g. `hadFloorPlanImage: extractImageUrls's floor-plan detection result`) alongside `imageUrls` at candidate-creation time. Recommend (a) for v1 — matches Phase 11's existing omission discipline exactly, avoids scope creep.

**Warning signs:** A validation-gate reviewer flags "the floor-plan section is just blank on half the listings with no explanation" — that's the signal (b) is worth the extra field.

### Pitfall 3: Adding `latitude`/`longitude`/`floor`/`description` to `DiscoveryCandidate` without checking the PII allowlist discipline

**What goes wrong:** `candidate.ts`'s file-level doc comment explicitly frames the allowlist as a hard "these THIRTEEN fields may ever land in `discovery_jobs.results`" contract (DISC-07 guardrail) — a naive extension that just adds fields without updating the allowlist count/doc-comment/tests risks either (a) accidentally including PII if `description` free text contains a seller's name/phone number (broker descriptions occasionally do), or (b) breaking the existing allowlist-key-set test that asserts the exact field list.

**Why it happens:** `description` is explicitly called out elsewhere in the codebase (`candidate.ts`'s own doc comment: "the raw `Listing:` Apollo entity or broker description text may carry seller/occupant PII... and must NEVER be persisted") as a potential PII carrier — Phase 10/11 deliberately did NOT add it for exactly this reason.

**How to avoid:** Either (a) do NOT persist the raw `description` text at all — instead, run `extractOrientationFromDescription` ONCE at candidate-creation time (in `toCandidate`, mirroring `brfNameFromBreadcrumbs`) and persist only the DERIVED `{ facades, confidence }` result (never the raw text) as a new allowlist field, or (b) if raw description must be kept for some other reason, this is out of scope for Phase 12 and should not be added. **Recommend (a):** it fully sidesteps the PII risk, matches the "derive once at creation time" precedent `brfName` already set, and is strictly smaller in persisted-data surface than storing raw text.

**Warning signs:** The allowlist test (`candidate.test.ts`'s "exact-key-tested" allowlist assertion, per 09-01's key decision) fails after this phase's changes — that test failing IS the tripwire; do not weaken it, extend it.

### Pitfall 4: Sun-path degrading silently to a wrong-looking "0 hours" instead of an explicit "ej tillgänglig"

**What goes wrong:** If `computeSunExposure` is implemented so that a missing `orientation` silently defaults to `[]` (empty facade list) rather than returning the `unavailable` sentinel, the UI could render "0 timmar" for every season/facade — which reads as "this apartment gets zero sun," a fabricated negative claim, not a "we don't know" state.

**Why it happens:** An empty array and a null/absent value are easy to conflate in a naive implementation ("no facades to check" vs "we don't know which facades to check" look similar in code but mean opposite things to a user).

**How to avoid:** `computeSunExposure`'s signature returns `byFacadeAndSeason: null` (not an empty/zeroed object) whenever floor OR orientation is unavailable — enforced by a unit test asserting the null-propagation for each of the four missing-input cases independently (missing lat, missing lon, missing floor, missing orientation).

**Warning signs:** Any UI code path that renders a specific numeric "0 hours" figure without also checking a corresponding "was this even computed" flag.

## Code Examples

Verified patterns from official sources:

### suncalc sun position + times (verified live against the v2.0.0 README, 2026-07-07)

```typescript
// Source: npm view suncalc readme (live registry fetch, 2026-07-07)
import * as SunCalc from "suncalc";

const times = SunCalc.getTimes(new Date(), 59.33, 18.06); // Stockholm
// times.sunrise, times.sunset, times.solarNoon, times.dawn, times.dusk — all Date objects or null at extreme latitudes

const pos = SunCalc.getPosition(times.solarNoon, 59.33, 18.06);
// pos.altitude (degrees above horizon), pos.azimuth (degrees, clockwise from north; 180=south)
```

### Extending the existing vision deep-pass schema (this codebase's exact convention)

See "Pattern 1" above (`src/lib/discovery/vision-schema.ts` / `vision.ts`) — the addition is a literal 4th key on an existing object, not a new file or new schema shape.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| suncalc v1.x azimuth convention (radians, historically documented with a south-zero convention in some older examples) | suncalc v2.0.0 azimuth convention (degrees, north-zero, clockwise) per the live README fetched this research session | v2.0.0 published 2026-06-18 (3 weeks before this research) | Any training-data-derived suncalc code sample referencing radians or a south-zero convention is now STALE against the version this phase would install — re-verify against the installed `node_modules/suncalc/index.d.ts`/README at implementation time, do not trust memorized suncalc usage examples (Pitfall 1) |

**Deprecated/outdated:** suncalc 1.9.0 and earlier (pre-2026-06-18) — the phase should install `^2.0.0`, not pin to or reference an older major version any cached documentation might describe.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | suncalc v2.0.0's azimuth convention is DEGREES, north-zero, clockwise (as stated in the live-fetched README) — this document could not execute the library live (uninstalled after the legitimacy check) to numerically confirm | Pattern 2, Pitfall 1 | If the actually-installed version's real behavior differs from the README text, facade-to-azimuth bucketing would be silently wrong by 90-180°; mitigated by Pitfall 1's mandatory smoke-test recommendation before writing bucketing logic |
| A2 | Swedish väderstreck keyword coverage in `extractOrientationFromDescription` (Pattern 3's regex list) is a reasonable STARTING set, not an exhaustively researched/validated list of every phrasing Swedish brokers use | Pattern 3 | Under-matching (returning null too often) is the SAFE failure direction (degrades to "ej tillgänglig," never fabricates) — no risk of a false-positive guess, only a coverage gap; low risk given the safe failure direction, but worth an operator spot-check against a handful of real descriptions during validation |
| A3 | `suncalc`'s registry-listed license field ("Proprietary") is a metadata quirk, not the library's real license — the actual GitHub repo license (BSD-2-Clause, per general knowledge of this well-known project, NOT independently re-verified via a fresh GitHub fetch this session) | Package Legitimacy Audit | Low risk (this is a 15-year-old, extremely widely-used open-source library; a genuine proprietary-license trap on a package this established/downloaded would be unusual) — but the planner should have a human glance at `node_modules/suncalc/LICENSE` after install, a 10-second check |

**If this table is empty:** N/A — see rows above.

## Open Questions

1. **How should the floor-plan claim's mandatory disclaimer be enforced — prompt-only or prompt+code?** (RESOLVED)
   - What we know: Phase 11 already has a "no verdict field" schema-enforcement philosophy (`reportSchema`) and a documented practice of never trusting the model alone for liability-sensitive text.
   - What's unclear: nothing — this is a design choice, not a fact gap.
   - Recommendation: **Both.** Prompt instructs the model to include the framing; code appends/guarantees the literal disclaimer sentence after parsing, exactly as shown in Pattern 1's code example. This is strictly safer and costs one string-concatenation line.

2. **Should `description` (raw text) be added to `DiscoveryCandidate`, or only a derived orientation result?** (RESOLVED)
   - What we know: `candidate.ts`'s own doc comments explicitly flag broker description text as a PII risk (names/phone numbers occasionally appear in free-text descriptions) and the allowlist is a hard, tested, exact-key contract.
   - What's unclear: nothing — this is resolved by precedent, not by missing information.
   - Recommendation: Derive `{ facades, confidence }` from `description` ONCE at `toCandidate`-time (server-side, before the PII-safe allowlist boundary) and persist ONLY the derived result, never the raw description text — mirrors `brfName`'s derive-then-persist-only-the-derived-value precedent exactly.

3. **Where does the sun-path UI live relative to `GalleryConditionVision` — inside the same component, or a sibling?** (RESOLVED)
   - What we know: CONTEXT.md requires "same presentation as Phase 11... structurally SEPARATE from deterministic flags" but sun-path is not vision output (no image citation, no `VisionResult` shape) — conflating it into `GalleryConditionVision`'s props would blur a real type/data boundary (`VisionResult` vs `SunExposureResult` are different shapes, different null-causes).
   - What's unclear: nothing — this is an architecture choice with a clear best answer given the data-shape mismatch.
   - Recommendation: A **new sibling component** (`SunPathExposure`), rendered adjacent to `GalleryConditionVision` in the same post-ranking-grid `space-y-6` visual zone (same "hedged, structurally separate from deterministic flags" placement CONTEXT.md asks for), but as its own `Card` with its own props (`latitude`/`longitude`/`floor`/`orientation`, NOT `vision`/`visionSkippedReason`). This keeps the type boundary clean while satisfying the "presented like Phase 11" visual-language requirement (same warm-gray/terracotta-adjacent identity family, own icon — e.g. `Sun` from `lucide-react`, already a dependency).

4. **Does floor-plan claim generation risk retriggering the "too many nullable-union params" 400?** (RESOLVED)
   - What we know: `visionDeepPassSchema` currently has exactly 3 nullable leaves (`kitchen.claim`, `bathroom.claim`, `overall.claim`); the documented trap threshold that broke `extract.ts`'s ORIGINAL schema design was described as "well under the ~28-nullable-union threshold" even at 3 leaves.
   - What's unclear: the exact numeric threshold that triggers the 400 was never precisely pinned down in Phase 11's own research either (it's described as "~28," an approximation) — only that 3 is safely far from it.
   - Recommendation: Adding a 4th leaf (`remodelPotential.claim`) brings the count to 4 — still far from ~28. Low risk, but Phase 11's own precedent (a static Zod-def-tree-walking test asserting nullable-leaf COUNT) should be extended to assert `count === 4` (was 3), catching any future accidental over-nesting immediately, and the ONE live API smoke test (already an operator-deferred step from Phase 11, per project memory `anthropic-structured-output-limits`) should be re-run against the EXTENDED schema before relying on it in production — mocked tests do not catch this class of 400.

5. **Should sun-path's floor input come from `DiscoveryCandidate.floor` or a fresh independent extraction?** (RESOLVED)
   - What we know: `floor` is already fully solved and extracted in the single-analysis path (`normalizeScraperOutput`/`reshapeListingEntity`'s `floor: entry.floor ?? undefined` passthrough, unwrapped by `num(raw.floor) ?? rawOf(raw.floor)`) — it is simply not yet threaded into `toCandidate`'s allowlist.
   - What's unclear: nothing — this is a straightforward "the extraction already exists, just wire it into the discovery candidate mapper" task, exactly like Phase 10 wired `constructionYear`/`brfName`/`tenureForm` (all pre-existing extractions) into the allowlist with zero new scraping logic.
   - Recommendation: Add `floor: num(raw.floor) ?? rawOf(raw.floor)` (mirroring `normalizeScraperOutput`'s existing unwrap logic exactly) to `toCandidate`, at zero extra network cost — the raw Apollo entity already carries this data for every discovery candidate today, it is simply discarded before reaching `DiscoveryCandidate`.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `suncalc` (npm package) | DISC-06 sun-path math | ✗ (not currently installed — verified then reverted during research, see Package Legitimacy Audit) | `2.0.0` on registry | None needed — install is a trivial `npm install suncalc` task, zero blockers found |
| `@anthropic-ai/sdk` | DISC-05 floor-plan vision pass | ✓ (already installed) | `^0.102.0` | — |
| `ANTHROPIC_API_KEY` env var | DISC-05 floor-plan vision pass (live calls) | Not verified this session (server-only secret, correctly not readable by research tooling) | — | Existing Phase 11 pipeline already depends on this identical env var; no NEW environment requirement introduced by Phase 12 |
| `DISCOVERY_ENABLED` env var | Gating both DISC-05/06 behind the discovery feature flag | Not verified this session (server-only, correctly not readable) | — | Existing flag, unchanged by this phase |

**Missing dependencies with no fallback:** none — `suncalc`'s absence is a trivial one-line install, not a blocker.

**Missing dependencies with fallback:** none applicable.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (existing — `vitest.config.ts`, `npm run test` / `npm run test:watch`) |
| Config file | `vitest.config.ts` (existing, no changes needed) |
| Quick run command | `npx vitest run src/lib/discovery/sun-path.test.ts src/lib/discovery/vision-schema.test.ts src/lib/discovery/vision.test.ts` |
| Full suite command | `npm run test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|---------------------|-------------|
| DISC-05 | `visionDeepPassSchema` extended to 4 `conditionAttribute` leaves; static nullable-leaf-count assertion updated from 3 to 4, still zero numeric-constraint chains | unit (static shape assertion) | `npx vitest run src/lib/discovery/vision-schema.test.ts` | ❌ Wave 0 (extends existing file/test) |
| DISC-05 | The mandatory "kräver konstruktör / väggutredning" disclaimer is present in EVERY non-null `remodelPotential` claim, enforced in code (not just prompt) | unit | `npx vitest run src/lib/discovery/vision.test.ts -t "remodel"` | ❌ Wave 0 (new test case in existing file) |
| DISC-05 | `remodelPotential.claim` NEVER contains a definitive load-bearing/wall-removal verdict phrase (banned-word assertion, e.g. no "bärande vägg kan/kan inte tas bort") mirroring the existing hedged-language banned-word test pattern | unit | `npx vitest run src/lib/discovery/vision-prompt.test.ts` | ❌ Wave 0 (extends existing prompt test) |
| DISC-05 | The Claude-facing schema (now 4 leaves) survives ONE live smoke call without a 400 | manual-only, cost-gated | `RUN_LLM_EVALS=1 npx vitest run evals/vision.eval.ts` (smoke subset, re-run against the extended schema) | ❌ Wave 0 — REQUIRED before trusting the extended mocked tests (same discipline as Phase 11's own deferred step) |
| DISC-06 | `computeSunExposure` returns `byFacadeAndSeason: null` for each of the 4 independent missing-input cases (lat/lon/floor/orientation), never a zeroed object | unit (pure function, no mocking) | `npx vitest run src/lib/discovery/sun-path.test.ts -t "unavailable"` | ❌ Wave 0 (new file) |
| DISC-06 | `computeSunExposure`'s azimuth-to-facade bucketing is numerically correct against a known reference (e.g. solar noon at a known lat/lon points south) | unit (pure function) | `npx vitest run src/lib/discovery/sun-path.test.ts -t "azimuth convention"` | ❌ Wave 0 — this is the Pitfall-1 smoke test, must exist before any bucketing logic is trusted |
| DISC-06 | `extractOrientationFromDescription` returns `null` on text with no matching keyword, never a fabricated guess | unit (pure function) | `npx vitest run src/lib/discovery/sun-path.test.ts -t "orientation"` | ❌ Wave 0 (new file) |
| DISC-06 | `DiscoveryCandidate`/`toCandidate`/`discoveryCandidateSchema` extended additively with `latitude`/`longitude`/`floor` (+ derived orientation), backward-compatible with pre-Phase-12 rows | unit | `npx vitest run src/lib/discovery/candidate.test.ts` | ❌ Wave 0 (extends existing file) |
| DISC-06 | Sun-path UI renders "ej tillgänglig" (not a fabricated number) when floor or orientation is absent | component (jsdom/RTL) | `npx vitest run src/components/sun-path-exposure.test.tsx` | ❌ Wave 0 (new file) |
| DISC-05/06 | Structural-separation invariant: neither `sun-path.ts` nor the floor-plan claim path is ever imported by `niche-score.ts`/`flags.ts` | unit (static/grep-style assertion, extends the existing Phase 11 invariant test) | `npx vitest run src/lib/discovery/niche-score.test.ts -t "no vision import"` (extend to also grep for `sun-path` import) | ❌ Wave 0 (extends existing invariant test) |

### Sampling Rate

- **Per task commit:** `npx vitest run src/lib/discovery/sun-path*.test.ts src/lib/discovery/vision*.test.ts src/lib/discovery/candidate.test.ts` (all mocked/pure, free, fast)
- **Per wave merge:** `npm run test` (full suite green)
- **Phase gate:** Full mocked suite green + the ONE live API smoke test re-run against the EXTENDED (4-leaf) vision schema before relying on it in production. The sun-path math needs NO live external call ever (pure function) — it can be fully verified in Wave 0 with zero operator-deferred steps. Only the floor-plan vision path shares Phase 11's operator-deferred live-render + validation-gate posture.

### Wave 0 Gaps

- [ ] `src/lib/discovery/sun-path.ts` + `sun-path.test.ts` — `computeSunExposure`/`extractOrientationFromDescription`, does not exist yet
- [ ] `src/components/sun-path-exposure.tsx` + a component test — new UI, per the recommended sibling-component approach (Open Question 3)
- [ ] `src/lib/discovery/vision-schema.ts`/`vision.ts`/`vision-prompt.ts` — extend existing files/tests for the 4th `remodelPotential` attribute
- [ ] `src/lib/discovery/candidate.ts`/`candidate.test.ts` — extend the allowlist for `latitude`/`longitude`/`floor` + derived orientation
- [ ] Framework install: `npm install suncalc` — the only new dependency; zero other framework/config changes needed

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | No (new surface) | Reuses existing Supabase auth on the discovery job both new attributes attach to |
| V3 Session Management | No | N/A — sun-path is a pure server/shared function with no session surface; floor-plan reuses Phase 11's server-side-only Anthropic call pattern |
| V4 Access Control | Yes | Both new outputs persist inside `discovery_jobs.results`, already owner-only RLS-protected (Phase 9); no new table, no new access-control surface |
| V5 Input Validation | Yes | `latitude`/`longitude`/`floor` sourced from Booli's own Apollo data (not user input) — validated via the existing `num()` null-tolerant helper before use; `description`-derived orientation is validated by construction (a pure regex match against a bounded keyword set can only ever return one of 4 known facade enum values, never arbitrary text) |
| V6 Cryptography | No | N/A — no new secrets; `suncalc` needs none; floor-plan reuses the existing `ANTHROPIC_API_KEY` server-only pattern |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| Fabricated/definitive load-bearing-wall claims presented as fact (liability risk, explicitly named in REQUIREMENTS.md's Out-of-Scope list) | Tampering (trust) / Repudiation risk if a user acts on a false verdict | Schema-enforced mandatory citation (same `imageIndex`/`whatWasSeen` discipline as kitchen/bathroom/overall) + a code-enforced (not prompt-only) disclaimer suffix on every non-null claim + a banned-word test asserting no definitive verdict phrasing ever appears — this phase's own named kill criterion exists specifically to catch a failure of this control |
| PII leakage via a broker description containing a name/phone number, if raw `description` text were persisted | Information Disclosure | RESOLVED by NOT persisting raw description text at all (Pitfall 3 / Open Question 2) — only the derived `{facades, confidence}` result, which cannot carry PII by construction (a bounded enum + a float) |
| Cost-DoS via the floor-plan attribute (new API surface) | Denial of Service (resource exhaustion) | None needed beyond what Phase 11 already enforces — the floor-plan claim rides inside the EXISTING capped call/image-set/`CAP_VISION_SEK_MAX` machinery; it introduces zero new spend surface |
| Sun-path math being manipulated via an attacker-supplied `latitude`/`longitude` to cause a hang/DoS (e.g. NaN/Infinity propagating through `suncalc`) | Denial of Service | `latitude`/`longitude` are sourced from Booli's own scraped data (not directly user-supplied) and already pass through the existing `num()` null-tolerant helper (rejects non-finite values to `null`) before reaching `computeSunExposure`, which itself returns the `unavailable` sentinel on any null input — no unguarded numeric path reaches `suncalc` |

## Sources

### Primary (HIGH confidence)

- `npm view suncalc <field>` (live registry queries, 2026-07-07) — version, publish dates, maintainer, repository URL, types field, postinstall script absence, dist-tags
- `npm view suncalc readme` (live registry fetch, 2026-07-07) — full API reference for `getPosition`/`getTimes`/`addTime`/`getMoonPosition`/`getMoonIllumination`
- `curl https://api.npmjs.org/downloads/point/last-week/suncalc` (live, 2026-07-07) — 225,106 weekly downloads
- `slopcheck install suncalc --ecosystem npm` (live run, 2026-07-07) — `[OK]` verdict
- Direct source reads: `src/lib/discovery/vision-schema.ts`, `vision.ts`, `vision-prompt.ts`, `candidate.ts`, `cost.ts`, `src/components/gallery-condition-vision.tsx`, `src/lib/discovery/job.ts`, `src/lib/discovery/filter-schema.ts`, `src/lib/schemas/listing.ts`, `src/lib/booli/client.ts` (extractImageUrls/reshapeListingEntity/normalizeScraperOutput) — all read directly this session
- `supabase/migrations/010_discovery_jobs.sql` — confirms `results jsonb` column, supporting the additive-nullable-no-migration recommendation

### Secondary (MEDIUM confidence)

- None required — every claim in this document traces to either a live tool call or a direct file read this session.

### Tertiary (LOW confidence)

- suncalc's actual GitHub license file content (BSD-2-Clause) — based on general knowledge of this well-known project, NOT independently re-fetched this session (see Assumption A3); low-risk, recommend a 10-second human glance at `node_modules/suncalc/LICENSE` post-install

## Metadata

**Confidence breakdown:**
- Standard stack (suncalc): HIGH — verified live against the npm registry, slopcheck, and downloads API this session
- Architecture (floor-plan-as-4th-attribute, candidate allowlist extension): HIGH — derived directly from reading Phase 10/11's actual source code and its own documented precedents, not from training-data assumption
- Sun-path math correctness (azimuth convention): MEDIUM — README text confirmed live, but the library itself was not run/executed this session to numerically confirm (see Pitfall 1, Assumption A1) — flagged for a mandatory implementation-time smoke test
- Pitfalls: HIGH for PII/allowlist/schema-threshold pitfalls (all sourced from this codebase's own documented precedents); MEDIUM for the suncalc convention pitfall (sourced from README text + general astronomy-library-versioning knowledge, not a live numeric test)

**Research date:** 2026-07-07
**Valid until:** 30 days (suncalc is stable/mature; the codebase precedents this research relies on are unlikely to shift meaningfully in that window) — but re-verify the suncalc azimuth convention against whatever version is ACTUALLY installed at implementation time regardless of this window, per Pitfall 1
