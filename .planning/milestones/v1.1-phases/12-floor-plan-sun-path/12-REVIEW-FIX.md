---
phase: 12-floor-plan-sun-path
fixed_at: 2026-07-07T17:32:14Z
review_path: .planning/phases/12-floor-plan-sun-path/12-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 6
skipped: 0
status: all_fixed
---

# Phase 12: Code Review Fix Report

**Fixed at:** 2026-07-07T17:32:14Z
**Source review:** .planning/phases/12-floor-plan-sun-path/12-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 6 (2 Critical + 4 Warning; Info findings IN-01/02/03 explicitly out of scope for this pass)
- Fixed: 6
- Skipped: 0

## Fixed Issues

### CR-01: Banned load-bearing verdict words are never actually rejected/stripped from remodelPotential claims — only a disclaimer is appended

**Files modified:** `src/lib/discovery/vision.ts`, `src/lib/discovery/vision.test.ts`
**Commit:** `a3a5502`
**Applied fix:** Added `REMODEL_BANNED_PATTERN` (case-insensitive, `\b`-word-boundary-anchored check for bärande/icke-bärande/garanterat/definitivt/"kan enkelt rivas") and `REMODEL_FALLBACK_CLAIM`. The `.map()` that builds `VisionConditionClaim.claim` for `remodelPotential` now inspects the model's RAW `attr.claim` first — if it trips the banned pattern, the claim text is replaced with the generic hedged fallback before the disclaimer is appended; otherwise the model's clean text is preserved verbatim. Updated the existing test (previously named "...still carries the code-enforced disclaimer suffix", which only asserted `.toContain("kräver konstruktör")` and never checked the banned word was absent) to assert the banned-word claim is now dropped/replaced, and added a new test proving a clean claim survives verbatim + gets the disclaimer appended.

### CR-02: The mandatory disclaimer suffix itself contains the banned word "bärande"

**Files modified:** `src/lib/discovery/vision.ts` (same commit as CR-01 — the review explicitly calls out that both must be fixed together to avoid the disclaimer tripping its own filter)
**Commit:** `a3a5502`
**Applied fix:** Extracted the disclaimer into a `REMODEL_DISCLAIMER` constant and reworded it to avoid the literal word "bärande" entirely (`"...kräver konstruktör/väggutredning innan någon vägg berörs."` instead of `"...för att avgöra bärande väggar."`). The banned-word check (CR-01) runs against `attr.claim` BEFORE `REMODEL_DISCLAIMER` is concatenated, so the disclaimer's own wording can never trip the filter, and no future maintainer needs to special-case it.

### WR-01: extractOrientationFromDescription's keyword regexes false-positive on common Swedish place names via unbounded `.*` spans

**Files modified:** `src/lib/discovery/sun-path.ts`, `src/lib/discovery/sun-path.test.ts`
**Commit:** `4eb73ad`
**Applied fix:** Every facade pattern's directional token is now `\b`-word-boundary anchored, and the `balkong\w*...mot <direction>` / `fönster\w*...mot <direction>` alternatives bound their gap to `[^.,;!?]{0,20}` (a short, same-clause window) instead of an unbounded `.*` that could span sentence boundaries. Verified live against all four false-positive examples from the review (Norrköping, Söderort, Södertälje, Söderhamn) plus three additional place names (Västerås, Södermalm, Österåker) — all now correctly return `null`. Added `it.each` regression blocks for the place-name false positives and for genuine orientation phrases using the same words (to confirm no overcorrection).

### WR-02: computeSunExposure's orientation parameter does not scope which facades are computed

**Files modified:** `src/lib/discovery/sun-path.ts`, `src/lib/discovery/sun-path.test.ts`, `src/components/sun-path-exposure.tsx`
**Commit:** `1524f4e`
**Applied fix:** Chose option (b) from the review's fix suggestion — honored the parameter rather than renaming it. `byFacadeAndSeason`'s type is now `Partial<Record<Facade, Record<Season, SunQualityLabel>>>` and the computation loop iterates `for (const facade of orientation)` instead of the constant `FACADES` array, so a facade not in `orientation` is genuinely absent from the returned grid (no key), never computed and never fabricated. Updated the sole call site (`SunPathExposure`) to use optional chaining with a defensive fallback (`grid[facade]?.[season] ?? "—"` — never expected to render in practice since `knownFacades` IS `orientation.facades`). Updated existing test assertions for the new `Partial` contract and added a regression proving an unstated facade (e.g. `north`/`east`/`west` when only `["south"]` was passed) is `undefined`, not populated.

### WR-03: Read-path Zod guard for imageUrls does not re-validate the Booli-CDN host allowlist

**Files modified:** `src/lib/booli/client.ts`, `src/lib/discovery/candidate.ts`, `src/lib/discovery/candidate.test.ts`
**Commit:** `d01f4a2`
**Applied fix:** Exported `isAllowedImageHost` (was module-private) from `client.ts`. `candidate.ts`'s `discoveryCandidateSchema.imageUrls` field now applies a `.transform()` that re-runs `isAllowedImageHost` against every URL on read, filtering out (dropping) any URL that fails the check — a tampered/corrupted persisted row degrades to fewer rendered images rather than trusting an untrusted URL through to `gallery-condition-vision.tsx`'s `<img src={...}>`. Verified no circular import risk (`client.ts` has no import from `candidate.ts` or its dependents). Added regression tests: one proving a mixed allowlisted/non-allowlisted array drops only the offending URL, and one confirming `imageUrls: null` still passes through as `null`.

### WR-04: imageIndex is a bare (non-integer-constrained) z.number(), allowing a fractional index to slip through and render "Bild 1.5"

**Files modified:** `src/lib/discovery/vision.ts`, `src/lib/discovery/vision.test.ts`
**Commit:** `0c0edc5`
**Applied fix:** Added `Number.isInteger(attr.imageIndex)` to the existing bounds-check filter in `runVisionForCandidate`'s claims `.filter()` (the same filter that already drops null-claim/low-confidence/out-of-range claims), so a fractional `imageIndex` is dropped as consistently malformed/uncited, matching the "no uncited claim can pass through this shape" contract cited by the review. Added a regression test asserting a claim with `imageIndex: 1.5` is dropped while a sibling claim with an integer index in the same deep-pass response survives untouched.

## Skipped Issues

None — all 6 in-scope findings (CR-01, CR-02, WR-01, WR-02, WR-03, WR-04) were fixed. IN-01, IN-02, IN-03 were explicitly excluded from this pass's scope per the fix objective and were not attempted.

## Verification

- `npx vitest run` (full suite): 629 passed, 3 skipped, 0 failed (57 test files passed, 3 skipped)
- `npx tsc --noEmit`: clean, zero errors
- `npm run build` (Next.js/Turbopack production build): compiled successfully, all routes generated
- `npx eslint` on every touched file: clean, zero warnings/errors
- Feature flag: unchanged, stays OFF (no flag file touched)
- No new migration added; no `--no-verify` used
- `.planning/STATE.md` / `.planning/ROADMAP.md`: not modified

---

_Fixed: 2026-07-07T17:32:14Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
