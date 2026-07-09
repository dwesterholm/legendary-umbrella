---
phase: 12-floor-plan-sun-path
reviewed: 2026-07-07T00:00:00Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - src/lib/discovery/sun-path.ts
  - src/lib/discovery/vision-schema.ts
  - src/lib/discovery/vision.ts
  - src/lib/discovery/vision-prompt.ts
  - src/lib/discovery/candidate.ts
  - src/lib/booli/client.ts
  - src/components/sun-path-exposure.tsx
  - src/components/gallery-condition-vision.tsx
  - src/components/discovery-results.tsx
findings:
  critical: 2
  warning: 4
  info: 3
  total: 9
status: issues_found
---

# Phase 12: Code Review Report

**Reviewed:** 2026-07-07T00:00:00Z
**Depth:** standard
**Files Reviewed:** 9
**Status:** issues_found

## Summary

Phase 12 adds a floor-plan remodel-potential vision leaf (DISC-05) and a deterministic sun-path exposure grid (DISC-06). The sun-path math (`sun-path.ts`) is genuinely pure, null-guards correctly on all four inputs, and its azimuth-convention smoke test is well-designed. Structural separation from `niche-score.ts`/`flags.ts` is real and verified both by grep-based test and by manual import/field-access inspection — no vision or sun-path value reaches the deterministic scorer. The "no new Anthropic call" cost claim holds (only 2 `messages.parse` call sites total, both pre-existing).

However, the phase's **headline safety claim is false as shipped**: the documentation, tests, and doc-comments repeatedly assert that "banned load-bearing verdict words are rejected by test" / "belt-and-suspenders" enforcement exists in code for the floor-plan disclaimer. In reality, the code only **appends** a disclaimer suffix — it never inspects, strips, or rejects a `remodelPotential` claim that itself states a definitive load-bearing verdict (e.g., containing the literal word "bärande"). The project's own test (`vision.test.ts:300-334`) proves this: a claim reading *"Väggen mellan kök och hall verkar vara bärande."* passes straight through into the persisted/rendered claim text, disclaimer merely tacked onto the end. This is the exact DISC-05 liability risk the phase exists to mitigate, and it is unmitigated.

Separately, `extractOrientationFromDescription`'s keyword regexes use unbounded `.*` spans (`balkong.*söder`, `fönster.*norr`, etc.) with no word-boundary anchoring, causing real false-positive orientation extraction whenever a description mentions a balcony/window anywhere alongside any of Sweden's extremely common söder-/norr-/väster-/öster- place names (Söderköping, Norrköping, Södertälje, Västerås, Österåker, ...). This directly violates the "never address/place-name-derived" locked constraint the module's own doc comments claim to enforce, and the existing test suite's single-keyword-only fixtures did not catch it.

## Critical Issues

### CR-01: Banned load-bearing verdict words are never actually rejected/stripped from remodelPotential claims — only a disclaimer is appended

**File:** `src/lib/discovery/vision.ts:242-260`
**Issue:** The doc comments (vision.ts:76-79, vision-schema.ts:76-79, vision-prompt.ts:23-27) and the phase's own planning/verification artifacts (12-02-PLAN.md, 12-VERIFICATION.md) repeatedly describe this as "belt-and-suspenders": the prompt bans stating a wall's bärande/icke-bärande status as fact, and this is additionally "enforced in code after parsing." In the actual implementation, the only code-level effect for `remodelPotential` is string concatenation — appending `" Detta är endast ett underlag för vidare utredning — kräver konstruktör/väggutredning för att avgöra bärande väggar."` to whatever `attr.claim` the model returned. There is no check anywhere in this file (or any other file in the codebase — verified via repo-wide grep) that inspects `attr.claim` for the banned words ("bärande", "icke-bärande", "garanterat", "definitivt", "kan enkelt rivas") and drops/redacts/rewrites the claim if found.

The project's own test proves the gap: `vision.test.ts:300-334` ("a remodelPotential claim attempting a banned load-bearing verdict word still carries the code-enforced disclaimer suffix") feeds in `claim: "Väggen mellan kök och hall verkar vara bärande."` and asserts only that the FINAL string `.toContain("kräver konstruktör")` — it never asserts the banned word "bärande" is absent from the final claim. The resulting `VisionConditionClaim.claim` therefore reads (persisted and rendered verbatim in `gallery-condition-vision.tsx:177`):

> "Väggen mellan kök och hall verkar vara bärande. Detta är endast ett underlag för vidare utredning — kräver konstruktör/väggutredning för att avgöra bärande väggar."

This is precisely the "confident, definitive load-bearing verdict presented as fact" that 12-02-PLAN.md's own threat model (T-12-03) names as the risk to mitigate — a disclaimer trailing after the verdict does not un-say the verdict. A buyer skimming the first sentence reads a stated fact ("verkar vara bärande" — hedged verb, but still names the wall's status), not an investigation prompt.

**Fix:** Add an actual banned-word check before/instead of the append, e.g.:
```typescript
const REMODEL_BANNED_PATTERN =
  /\bbärande\b|\bicke-bärande\b|\bgaranterat\b|\bdefinitivt\b|kan enkelt rivas/i;

// ...in the .map(...):
claim:
  attribute === "remodelPotential"
    ? (REMODEL_BANNED_PATTERN.test(attr.claim as string)
        ? "Planlösningen antyder att en vägg eventuellt kan vara värt att undersöka. Detta är endast ett underlag för vidare utredning — kräver konstruktör/väggutredning för att avgöra bärande väggar."
        : `${attr.claim} Detta är endast ett underlag för vidare utredning — kräver konstruktör/väggutredning för att avgöra bärande väggar.`)
    : (attr.claim as string),
```
This replaces (not merely appends to) a non-compliant claim with a generic hedged fallback, so a banned-word verdict can never reach the UI verbatim. Update `vision.test.ts:300-334` to assert the word "bärande"/"icke-bärande" etc. does NOT appear anywhere in the final claim text except inside the mandatory disclaimer's own fixed suffix (which itself currently contains the literal word "bärande" — see CR-02).

### CR-02: The mandatory disclaimer suffix itself contains the banned word "bärande", so even a "fixed" banned-word filter would need to exempt the suffix — and any naive substring check would false-positive on its own output

**File:** `src/lib/discovery/vision.ts:255`
**Issue:** The code-appended disclaimer suffix is: `"Detta är endast ett underlag för vidare utredning — kräver konstruktör/väggutredning för att avgöra bärande väggar."` — this sentence itself contains "bärande". `vision-prompt.ts:63` explicitly instructs the MODEL never to use this word, yet the CODE's own hardcoded disclaimer uses it. This isn't a security hole by itself (the disclaimer's usage of "bärande" is in a hedged, investigation-framing context: "avgöra bärande väggar" = "determine [which walls are] load-bearing", not a verdict) — but it means:
1. Any future banned-word enforcement (see CR-01) must be careful to check the MODEL's claim text before the disclaimer is appended, not the final concatenated string, or every claim will trivially "fail" the check due to the disclaimer's own wording.
2. The current test's assertion style (`.toContain("kräver konstruktör")`) combined with this fact means no simple `.not.toContain("bärande")` assertion can be added to the final string without first fixing CR-01's ordering — worth calling out explicitly so the CR-01 fix doesn't get implemented in a way that also breaks on the disclaimer's own text.

**Fix:** When implementing the CR-01 fix, rewrite the disclaimer suffix to avoid the banned word entirely, e.g. `"...kräver konstruktör/väggutredning för att avgöra vilka väggar som är bärande respektive icke-bärande."` still contains it — better: `"...kräver konstruktör/väggutredning innan någon vägg berörs."` (avoids the word "bärande" altogether), and apply the banned-word check to `attr.claim` ONLY, before concatenation, as shown in CR-01's fix.

## Warnings

### WR-01: `extractOrientationFromDescription`'s keyword regexes false-positive on common Swedish place names via unbounded `.*` spans

**File:** `src/lib/discovery/sun-path.ts:207-212`
**Issue:** Every facade pattern includes an alternative like `balkong.*söder` / `fönster.*norr` with no length bound and no word-boundary anchor on the directional word. `.*` matches across the ENTIRE remaining string (including sentence/clause boundaries), and the directional fragment (`söder`, `norr`, `väster`, `öster`) matches as a case-insensitive substring of any longer word — including extremely common Swedish place names. Verified live:
```
"Fin balkong. Bostaden ligger i ett soligt söderläge i Norrköping."
  → matches BOTH south (correct, via "söderläge") AND north (FALSE POSITIVE, via "balkong...Norr[köping]")
"Balkong i bottenplan, mysigt kvarter nära Söderort."
  → matches south (FALSE POSITIVE — "Söderort" is a place name, no stated orientation)
"Stor balkong. Utsikt mot Södertälje."
  → matches south (FALSE POSITIVE)
"fönster ut mot Söderhamn"
  → matches south (FALSE POSITIVE)
```
This directly contradicts the module's own doc comment (sun-path.ts:29-34): "NEVER derives orientation from an address... a bare address string with no stated väderstreck phrase correctly returns null even if it happens to contain a directional word as a substring of a place name (e.g. 'Söderlångsgatan')." The existing test (`sun-path.test.ts:169-173`) only checks an ISOLATED address string with no other orientation-adjacent word (balkong/fönster) present, so it never exercises the `.*`-span false-positive path. A real Booli listing description mentioning both a balcony AND a place name like Norrköping/Södertälje/Västerås/Österåker (all common Swedish municipalities) will silently fabricate a facade orientation that then feeds a real (if hedged) sun-exposure grid to the buyer.

**Fix:** Anchor the directional word with `\b` and remove the unbounded cross-clause span, or restrict the `.*` to a short, same-clause window:
```typescript
south: /söderläge|söderut|mot\s+söder\b|söderorienterad|söderbalkong|balkong\w*\s+mot\s+söder|fönster\w*\s+mot\s+söder/i,
```
More robustly, require the directional word to be immediately adjacent (within ~2 words) to "balkong"/"fönster"/"mot", e.g. `/balkong[^.,;]{0,15}\bsöder\b/i`, and add regression tests for descriptions that combine a balcony/window mention with a söder-/norr-/väster-/öster- place name in the SAME string.

### WR-02: `computeSunExposure`'s `orientation` parameter does not scope which facades are computed — it is only a null-check gate, contrary to its apparent purpose

**File:** `src/lib/discovery/sun-path.ts:169-204`
**Issue:** The function signature takes `orientation: Facade[] | null` and the doc comment frames it as resolving "GIVEN a resolved facade list" (line 198), but the implementation's `for (const facade of FACADES)` loop (line 180) iterates over the constant `FACADES` array (all 4 compass directions), completely ignoring the CONTENT of the `orientation` parameter — it is used solely to decide null vs. non-null (line 175). The full 4-facade × 3-season grid is always computed once inputs are non-null, and it is left to the CALLER (`SunPathExposure`'s `knownFacades.map(...)`) to filter down to the facades actually stated. This works correctly today because the sole call site filters properly, but it is a latent trap: a future caller reading the signature/doc comment could reasonably assume passing `["south"]` limits computation/output to south, and would be surprised that `result.byFacadeAndSeason.north` etc. are also populated with real (if unused) data.
**Fix:** Either (a) rename the parameter to reflect its true role (e.g., `orientationGate: Facade[] | null` or just check `orientation !== null` without threading the array through), or (b) honor the parameter and only populate `grid[facade]` for facades present in `orientation`, setting others to a clearly-unavailable sentinel — whichever matches the intended contract, and update the doc comment to match reality.

### WR-03: Read-path Zod guard for `imageUrls` does not re-validate the Booli-CDN host allowlist

**File:** `src/lib/discovery/candidate.ts:179`
**Issue:** `extractImageUrls` (client.ts:249-268) enforces `isAllowedImageHost` at write time, but the read-path guard `discoveryCandidateSchema.imageUrls: z.array(z.string()).nullable().default(null)` accepts ANY string on read — no host re-validation. Since `gallery-condition-vision.tsx:155-156` renders these URLs directly in an `<img src={...}>`, a tampered/corrupted `discovery_jobs.results` row (e.g., a future migration bug, a manual DB edit, or a bug in a different write path added later) could inject a non-Booli URL that gets rendered as an `<img>` src with no defense-in-depth check on the read path. This is a pre-existing Phase 11 pattern, but Phase 12's `SunPathExposure`/`GalleryConditionVision` changes read from and render the same allowlist, so it's in-scope for this review.
**Fix:** Add the same `isAllowedImageHost`-style check to the read-path schema (or a `.refine()` on the array) so a malformed/tampered persisted row degrades to dropping the offending URL rather than trusting it unconditionally on read.

### WR-04: `imageIndex` is a bare (non-integer-constrained) `z.number()` at both the Claude-facing and persisted-read schemas, allowing a fractional index to pass the bounds filter and render a nonsensical "Bild 1.5" label

**File:** `src/lib/discovery/vision-schema.ts:52-56`, `src/lib/discovery/vision.ts:239-240`, `src/components/gallery-condition-vision.tsx:157,163`
**Issue:** `conditionAttribute.imageIndex` and `visionResultSchema`'s `imageIndex` are both `z.number()` with no `.int()` constraint (documented as deliberate, to avoid the Anthropic numeric-constraint 400 trap). The filter in `vision.ts:239-240` (`attr.imageIndex >= 1 && attr.imageIndex <= capped.length`) accepts a fractional value like `1.5`, which then indexes `imageUrlsUsed[0.5]` → `undefined` (degrades gracefully to the no-thumbnail branch), but the placeholder text still renders the raw fractional value verbatim: `Bild {claim.imageIndex}` → "Bild 1.5", a confusing citation label visible to end users.
**Fix:** Either floor/round `imageIndex` before use (`Math.trunc(attr.imageIndex)`) when mapping claims in vision.ts, or add a `Number.isInteger(attr.imageIndex)` check to the existing bounds filter so a fractional index is dropped like any other malformed citation, consistent with the "no uncited claim can pass through this shape" contract.

## Info

### IN-01: `orientationConfidence` returned by `computeSunExposure` is a hardcoded, unused constant

**File:** `src/lib/discovery/sun-path.ts:202`
**Issue:** `computeSunExposure` always returns `orientationConfidence: 0.5` when the grid is computed, regardless of the actual confidence the caller's `extractOrientationFromDescription` call produced. The doc comment (lines 196-201) acknowledges this and tells callers to read the ORIGINAL confidence from `extractOrientationFromDescription` directly — and indeed no caller in this codebase reads `result.orientationConfidence` from `computeSunExposure` (`SunPathExposure`/`GalleryConditionVision` never reference it). This field is effectively dead/unused output.
**Fix:** Either remove `orientationConfidence` from `SunExposureResult` entirely (since it's never consumed and is actively misleading — it looks like real per-call confidence but is a constant), or have `computeSunExposure` accept the real confidence value as an input parameter instead of a facades-only array, so the field means what it appears to mean.

### IN-02: `isFloorPlan`'s regex has a redundant/overly broad alternative that matches the bare substring "plan"

**File:** `src/lib/booli/client.ts:253-255`
**Issue:** `/floor.?plan|planritning|plan(ritning)?/i` — the third alternative `plan(ritning)?` makes "ritning" optional, so the whole pattern also matches any `item.type` value containing the bare substring "plan" (e.g. a hypothetical `type: "floor_plan_v2"` is intentional, but also `type: "planerad"` or any other unrelated string containing "plan" would incorrectly sort as a floor plan first). This is low-risk (worst case: gallery photo ordering is slightly wrong) but the pattern is redundant with itself — `planritning` is already listed as its own alternative before the redundant `plan(ritning)?`.
**Fix:** Simplify to `/floor.?plan|planritning/i` (drop the redundant, overly-broad third alternative) unless there's a real Apollo `type` value that requires matching bare "plan" — if so, document why with a citation, mirroring this file's own probe-pinning discipline used elsewhere (e.g. `LISTING_ENTITY_PREFIX`).

### IN-03: "ej tillgänglig" message names only "riktning eller våningsdata" as the missing cause, omitting the latitude/longitude null-guard case

**File:** `src/components/sun-path-exposure.tsx:88-91`
**Issue:** `computeSunExposure` degrades on ANY of latitude/longitude/floor/orientation being null, but the degraded UI copy only mentions "riktning eller våningsdata saknas" (direction or floor data missing) — a listing missing latitude/longitude (rare but possible per `reshapeListingEntity`'s `num(entry.latitude) ?? undefined` passthrough, which can legitimately be `undefined`/null for a malformed Apollo entity) would show this same message, incorrectly implying the direction/floor is the specific gap.
**Fix:** Either broaden the copy to a generic "platsdata saknas för denna annons" (location data missing) that doesn't name a specific field, or thread through which specific input(s) were null so the message can be precise.

---

_Reviewed: 2026-07-07T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
