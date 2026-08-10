---
phase: 14-holistic-analysis-brain
fixed_at: 2026-08-10T13:55:00Z
review_path: .planning/phases/14-holistic-analysis-brain/14-REVIEW.md
iteration: 1
fix_scope: critical_warning
findings_in_scope: 18
fixed: 18
skipped: 0
status: all_fixed
verification:
  tsc: pass
  lint: pass
  test: pass (972 passed, 3 skipped, 975 total)
  build: pass
closes_verification_gap: "ANL-04 (14-VERIFICATION.md gaps[0]) — all three `missing` items"
---

# Phase 14: Code Review Fix Report

**Fixed at:** 2026-08-10T13:55:00Z
**Source review:** `.planning/phases/14-holistic-analysis-brain/14-REVIEW.md`
**Iteration:** 1

**Summary:**
- Findings in scope (Critical + Warning): 18
- Fixed: 18
- Skipped: 0
- Info findings (IN-01..IN-07): deliberately NOT fixed — out of the requested scope.

All work was done in an isolated git worktree (`gsd-reviewfix/14-*`, forked from
`gsd/phase-14-holistic-analysis-brain`) and fast-forwarded back onto the phase
branch, so the foreground session's working tree was never touched.

---

## Verification

Run on the final committed tree:

| Command | Result |
|---|---|
| `npx tsc --noEmit` | **pass** — no output, exit 0 |
| `npm run lint` | **pass** — 0 errors, 0 warnings |
| `npm run test` | **pass** — 64 files, 972 passed / 3 skipped (975) |
| `npm run build` | **pass** — compiled, TypeScript clean, 12/12 static pages |

Test count went from 928 (pre-fix baseline, 925 passing) to 975 (972 passing);
net +47 tests. No test was skipped, deleted, or weakened to make a fix pass.

### One pre-existing flaky test (NOT caused by these fixes, NOT modified)

`src/lib/discovery/job.test.ts:562` — *"scrapes both areas CONCURRENTLY —
elapsed is close to the slower area's delay, not the sum (Wave-0 concurrency
proof, D-01)"* asserts `expect(elapsed).toBeLessThan(110)` against REAL
`setTimeout` delays of 100 ms and 20 ms. That leaves ~10 ms of wall-clock
headroom, so it fails under machine load. It failed once in ~10 full-suite runs
here and I reproduced it deterministically by running three suites in parallel:

```
× scrapes both areas CONCURRENTLY ... (Wave-0 concurrency proof, D-01) 128ms
    562|     expect(elapsed).toBeLessThan(110);
```

It passes 6/6 in isolation and 5/5 on an unloaded machine. This is a
pre-existing timing-sensitive test unrelated to any finding in this pass — I
left it untouched rather than loosen its threshold, since loosening it would be
weakening an existing test. Flagging it for the developer: it is a latent CI
flake independent of Phase 14.

I DID make one incidental flake deterministic, because it surfaced during this
pass and its cause was mechanical rather than a threshold judgement — see the
WR-16 entry.

---

## Fixed Issues

### CR-02 (BLOCKER): the `brfFieldTrusted` gate made the SPEC §2.2 high-debt flag unreachable and removed real high debt from the debt-inclusive kr/m²

**Files modified:** `src/lib/discovery/confounder-guard.ts`,
`src/lib/discovery/confounder-guard.test.ts`,
`src/lib/discovery/brf-lookup.test.ts`
**Commit:** `b841563`

**Applied fix:** Added `IMPLAUSIBLE_BRF_DEBT_PER_SQM = 60_000` and
`brfDebtPerSqmUsable()`, and routed rule 1, rule 5 and `buildBrfItem`'s debt
sentence through it instead of `brfFieldTrusted`.

The gate branches on *why* the confidence is what it is, which is the part the
review's suggested one-liner does not capture:

- absent / non-finite, negative, or `> IMPLAUSIBLE_BRF_DEBT_PER_SQM` → unusable
  (the denominator/unit misextraction the sanity band exists to catch);
- no `fieldConfidence` map at all (legacy row) → unusable, failing closed
  exactly as `brfFieldTrusted` does;
- value **inside** `BRF_SANITY_BANDS.skuldPerKvm` → the stored confidence is the
  model's own judgement of legibility (the band never touched it), so the
  ordinary `OSAKER_THRESHOLD` gate still applies — a smudged-scan 0.2 on an
  in-band 8 000 stays suppressed;
- value **outside** the band but plausible (the 15k–60k alarm window, and the
  symmetric debt-light case below the 2 000 floor) → the confidence was pinned
  by the band and carries no information about legibility, so the figure is used.

`src/lib/brf/sanity.ts` was deliberately **not** widened. `BRF_SANITY_BANDS` is
shared with the single-listing "Osäker" badge and the published
`/sa-raknar-vi` methodology page, where "outside the plausible Stockholm band"
is the correct, narrower claim. The lower bound is untouched; the discovery path
now simply stops treating a band downgrade as a usability verdict.

**Closes 14-VERIFICATION.md `gaps[0]`, all three `missing` items:**

1. *Separate the implausibility ceiling from the alarm threshold* — done via
   `IMPLAUSIBLE_BRF_DEBT_PER_SQM` (60 000) vs `HIGH_BRF_DEBT_PER_SQM` (15 000).
   A high-but-real figure is TRUSTED, enters `effectivePricePerSqm`, and is
   flagged `brf_debt_high`; only an implausible reading is suppressed.
2. *A test asserting `brf_debt_high` is reachable from a value the REAL
   `scoreExtraction` → `applySanityChecks` pipeline can produce* — added in
   `brf-lookup.test.ts` ("CR-02 re-review — a REAL high-debt extraction reaches
   brf_debt_high, the debt-inclusive basis, and the flagged prose"). That suite
   mocks only the Allabrf/Claude edges, so `scoreExtraction` runs for real: the
   test asserts the pipeline output genuinely has
   `fieldConfidence.skuldPerKvm < OSAKER_THRESHOLD` and
   `brfFieldTrusted(...) === false`, then feeds that exact summary into
   `normalizeForConfounders` and `buildHolisticBrief`. No fixture bypasses
   `applySanityChecks`.
3. *`buildBrfItem` renders a real 20–40k debt as fact with "(högre än vanligt)"*
   — asserted both in that end-to-end test and in a `confounder-guard.test.ts`
   unit test, which also asserts neither hedge sentence appears.

**Test expectation changed (flagged as instructed):** the assertion at
`confounder-guard.test.ts:336`, *"an untrusted skuldPerKvm >
HIGH_BRF_DEBT_PER_SQM does NOT produce brf_debt_high"*, encoded the defect
itself — 14-VERIFICATION.md cites it as the proof of the gap. It is now inverted
for a 20 000 @ 0.2 fixture. The not-reachable case is retained against a
genuinely implausible 480 000, so the suppression branch keeps its coverage.
Added tests for the debt-light case, the in-band low-confidence case, and the
constants' ordering.

---

### CR-01 (BLOCKER): `runSlice` counted one render per area while `fetchAreaListings` performs up to ten

**Files modified:** `src/lib/booli/client.ts`, `src/lib/booli/client.test.ts`,
`src/lib/discovery/cost.ts`, `src/lib/discovery/cost.test.ts`,
`src/lib/discovery/job.ts`, `src/lib/discovery/job.test.ts`
**Commit:** `076dfb1`

**Applied fix:** As the review suggests, the render count now flows back from
the client instead of being assumed.

- `fetchAreaListings` returns `AreaListingsResult { listings, rendersUsed }`;
  `fetchAreaPage` returns its `walkFallbackTree` rung count (the same
  `rendersUsed: result.rung` convention `fetchSoldComps` already uses), and a
  failed later page bills `AREA_RENDER_RUNGS` — a failed page still paid for
  every rung it attempted.
- `cost.ts` gains `estimateAreaFetchSek()` / `AREA_MAX_RENDERS_PER_AREA`
  (`AREA_MAX_PAGES_PER_AREA × AREA_RENDER_RUNGS_PER_PAGE`), mirroring
  `estimateCompsFetchSek`'s named-worst-case precedent. The two client constants
  are hand-mirrored (as `COMPS_MAX_RENDERS_PER_AREA` already is, to keep this
  pure module free of the Apify transport import) with a drift guard in
  `client.test.ts`.
- `job.ts`'s step-3 pre-gate prices `estimateAreaFetchSek()` per area; the
  post-scrape ledger reads `outcome.value.rendersUsed`; a **thrown** area bills
  its exhausted rungs; and the fully-blocked `raw.length === 0` path now
  persists that spend instead of discarding it (previously repeated blocked
  slices could spend without ever advancing `cost_sek_total` toward `cap_sek`).

Per the instruction to be conservative: the pre-check can now only ever
over-state, never under-state, what a slice may spend. Four areas' worst case
(~2.4 SEK) still fits inside `CAP_SEK_MAX`, asserted in `cost.test.ts`, so a
normal search is not pre-gated away.

Both false doc comments are corrected: `job.ts`'s "conservative
(never-under-count)" claim on `estimatedSliceCostSek`, and the "one-shot (no
pagination — it renders a single till-salu page)" justification for treating a
sweep as terminal. The terminality conclusion is unchanged but now rests on the
real reason (the client walks to `MAX_AREA_PAGES` itself, so no page remains for
a later slice). The `job.test.ts` comment repeating the same false claim was
corrected too.

**Test expectations changed (flagged as instructed):** two cost assertions
encoded the under-count and were inverted, not relaxed —
(a) the partial-failure case's *"Only one render actually succeeded → billed for
one"* now bills the failed area's exhausted rungs as well; (b) the
fully-degraded case now asserts the spend is recorded at all. Everything else in
`client.test.ts` was a mechanical `result` → `result.listings` update, plus new
`rendersUsed` assertions.

---

### WR-01: the BRF pre-gate priced one extraction call while a single failure can be charged for two

**Files modified:** `src/lib/discovery/brf-lookup.ts`,
`src/lib/discovery/job.ts`, `src/lib/discovery/job.test.ts`
**Commit:** `fb356e1`

**Applied fix:** `MAX_BILLED_CALLS_PER_LOOKUP`, derived from
`BILLED_CALLS_BY_EXTRACTION_CODE` (so a future higher-cost code raises the gate
automatically) rather than restated, and the divisor is now
`estimateBrfLookupSek() * MAX_BILLED_CALLS_PER_LOOKUP`. With `BRF_TOP_N = 4` and
a ~10 SEK pool the gate still authorises the full top-N, so no coverage is lost.

**Test expectation changed:** the "budget for exactly 2 lookups" fixture used
`estimateBrfLookupSek() * 2`, i.e. it assumed the very single-call pricing WR-01
reports; it now expresses the budget in worst-case units. Added a test that a
budget covering only one billed call authorises zero lookups.

---

### WR-02: a successful extraction after a `max_tokens` retry reported one call's cost for two billed calls

**Files modified:** `src/lib/brf/cost.ts`, `src/lib/brf/cost.test.ts`,
`src/lib/brf/extract.ts`, **`src/lib/brf/extract.test.ts` (new)**,
`src/lib/discovery/brf-lookup.ts`
**Commit:** `8107593`

**Applied fix:** Added `sumClaudeUsage()` to `brf/cost.ts` and accumulated usage
across attempts in `extract.ts`, exactly as the review suggests.

`extract.ts` had **no test harness at all** (every consumer mocks the module
wholesale), which is why this leak survived the CR-04 pass. Created
`src/lib/brf/extract.test.ts`, mocking only the Anthropic SDK (mirroring
`vision.test.ts`), covering: single-call usage unchanged; retry-then-succeed
sums both calls and `costSek(sum)` equals the sum of the per-call costs;
retry-then-truncate still throws the coded `CLAUDE_MAX_TOKENS`; a refusal is not
retried; and the GDPR log never carries document text.

---

### WR-03: the vision pass discarded billed Haiku spend on a failed candidate

**Files modified:** `src/lib/discovery/vision.ts`,
`src/lib/discovery/vision.test.ts`
**Commits:** `f00b13a`, `7fa3c91` (lint follow-up)

**Applied fix:** Rather than the estimate the review suggests, this reports the
**exact** figure — the review's version charges 0 for `CLAUDE_CALL_FAILED`, which
under-counts a Sonnet transport failure that follows a fully billed Haiku call.

`runVisionForCandidate` now accumulates `billedSek` as each call *completes* and
throws a `VisionCallError` carrying it; `billedVisionSekOf()` reads it, falling
back to `estimateVisionCallSek()` (never 0) for an unexpected error shape. A
transport failure before any model answer therefore still reports 0, honestly.

The same accumulation also fixes vision's own copy of WR-02: the success path's
pre-filter/deep-pass truncation retries previously reported only the last
message's usage. `VisionResult.costSek` is now the accumulated figure (identical
whenever no retry happened).

---

### WR-04: `estimateVisionCallSek()` priced 4 images while up to 8 are sent

**Files modified:** `src/lib/discovery/cost.ts`, `src/lib/discovery/cost.test.ts`
**Commit:** `ac2ea95`

**Applied fix:** `VISION_MAX_IMAGES_PER_CALL = CAP_IMAGES_PER_LISTING × 2` (the
two independently-capped image sets `runVisionForCandidate` sends in one
message) is now what gets priced. Asserted strictly greater than the old
single-set figure, and that three candidates' worst case still fits inside
`CAP_VISION_SEK_MAX` so the corrected gate does not starve the pass.

---

### WR-05: `BRF_UNTRUSTED_FIGURE_TEXT` claimed a figure was "outside a reasonable range" even when no range was checked

**Files modified:** `src/lib/discovery/confounder-guard.ts`,
`src/lib/discovery/confounder-guard.test.ts`
**Commit:** `c6bbde3`

**Applied fix:** Split into `BRF_OUT_OF_BAND_FIGURE_TEXT` and
`BRF_LOW_CONFIDENCE_FIGURE_TEXT`, with the cause recorded per suppressed field
(out-of-band iff the field *has* a `BRF_SANITY_BANDS` entry and the value falls
outside it, via `brfFigureOutOfBand`). Both sentences can appear when both
causes occurred. `kassaflode` has no band, so a suppression there can now only
ever produce the low-confidence wording.

**Test expectations changed (flagged as instructed):** the two existing
assertions used an `avgiftsniva` of 900, which is *inside* the 300–1200 band —
they now expect the low-confidence wording, which is the correct reason for that
fixture. Added an out-of-band fixture (4 200) and a no-band `kassaflode` fixture
so all three branches are covered.

---

### WR-06: two object-literal lookups documented as fail-closed resolved `Object.prototype` members

**Files modified:** `src/lib/discovery/confounder-guard.ts`,
`src/lib/discovery/confounder-guard.test.ts`,
`src/lib/discovery/brf-lookup.ts`, `src/lib/discovery/brf-lookup.test.ts`,
`src/lib/discovery/job.ts`
**Commit:** `4ea3d4d`

**Applied fix:** As requested in the prompt, both claims now hold.

- `STAMBYTE_PROSE` is a `ReadonlyMap` read via `.get()`, so `"toString"` no
  longer resolves `Function.prototype.toString` — whose *source* would have been
  `join(" ")`-ed into buyer-facing Swedish prose.
- `BILLED_CALLS_BY_EXTRACTION_CODE` is read via `Object.hasOwn`, so
  `"constructor"` no longer yields `Object * number = NaN`. That NaN propagated
  into `BrfResolution.spentSek` and then tripped `runVisionPass`'s
  `Number.isFinite` guard, resetting the shared pool to 0 and discarding the
  comps spend too.
- `job.ts`'s "always a finite non-negative number" comment was a hope, not an
  invariant — now clamped so it is enforced:
  `spentSek += Number.isFinite(result.costSek) ? Math.max(0, result.costSek) : 0`.
- `brfFigureOutOfBand` (added by WR-05) uses `Object.hasOwn` rather than `in`
  for the same reason.

Tests iterate `toString` / `constructor` / `valueOf` / `hasOwnProperty` /
`__proto__` through both sites.

---

### WR-07: every brief listed the same unknown-confounder labels twice, verbatim

**Files modified:** `src/lib/discovery/confounder-guard.ts`,
`src/lib/discovery/confounder-guard.test.ts`
**Commit:** `0834e25`

**Applied fix:** `buildCompsPositioningItem` states the positioning and defers
naming with "(se nedan)"; `buildConfounderItems` remains the single place the
labels are named. Test asserts each label appears exactly once across the whole
brief.

---

### WR-08: `conditionAttribution.explainedPct` asserted an attribution the same object called impossible

**Files modified:** `src/lib/discovery/confounder-guard.ts`,
`src/lib/discovery/confounder-guard.test.ts`
**Commit:** `d885a39`

**Applied fix:** `explainedPct: guard.canAttributeToCondition ?
guard.conditionExplainedPct : null`. No information is lost — `capped` plus the
exported `MAX_CONDITION_EXPLAINED_PCT` recover the capped value, and the guard
result still carries the computed number in memory.

**Test expectation changed:** the *"capped at exactly 0.2"* assertion moved from
the persisted brief to the guard result, where the number legitimately lives.
Added an invariant test that `explainedPct === null` iff
`canAttributeToCondition === false`.

---

### WR-09: a nested read-guard failure dropped the whole candidate from the results page

**Files modified:** `src/lib/discovery/candidate.ts`,
`src/lib/discovery/candidate.test.ts`
**Commit:** `3b0160f`

**Applied fix:** `softNullable()` (the review's shape) applied to `areaComps`,
`brfSummary` and `holisticBrief`: accept anything, try the real schema, fall
back to `null`. It never yields an unvalidated value — only `null`. `.optional()`
before the transform preserves the `.default(null)` missing-key behaviour every
other additive field relies on. Six drifted-shape cases are covered (a second
BRF `source`, a forbidden `confidence: "high"`, a truncated comps aggregate, and
outright wrong types), plus valid-passthrough and missing-key cases.

---

### WR-10: `BuildHolisticBriefInput.pricePerSqm` was dead and the "comps-positioning" item never stated the candidate's position

**Files modified:** `src/lib/discovery/confounder-guard.ts`,
`src/lib/discovery/confounder-guard.test.ts`
**Commit:** `8d81373`

**Applied fix:** Consumed rather than deleted (the review offers both). The
opening sentence states the candidate's own kr/m², and a new sentence states its
distance from the renovated median. Because that distance derives from
`effectivePricePerSqm`, the ANL-04 debt-inclusive safeguard is now *visible to
the user*: a 55 000 asking price in a 30 000 kr/m²-debt förening reads as "ca
15% under medianen", not the 45% the raw asking price alone suggests — asserted
as a test. Above-median candidates read as "över", never clamped to a discount.
With `pricePerSqm` null the previous wording is retained, fabricating nothing.

Also dropped the now-false "WR-06 … stays OUT OF SCOPE" note on `livingArea`.
The review's `parts.unshift` ordering was replaced with a merged opening
sentence to avoid two consecutive sentences both starting "Priset".

---

### WR-11: `effectivePricePerSqm`, `debtIncluded` and `compsThin` were computed but consumed nowhere

**Files modified:** `src/lib/discovery/confounder-guard.ts`,
`src/lib/discovery/confounder-guard.test.ts`,
`src/lib/discovery/holistic-schema.ts`,
`src/lib/discovery/holistic-schema.test.ts`,
`src/components/discovery-results.test.tsx`,
`src/components/gallery-condition-vision.test.tsx`
**Commit:** `0c9cbf9`

**Applied fix:** `effectivePricePerSqm` + `debtIncluded` now ride on
`HolisticBrief.conditionAttribution` and `holisticBriefSchema`, with
`.default(null)` / `.default(false)` for the same load-bearing reason
`fieldConfidence.default(null)` has one — a required key would have degraded
every pre-existing persisted brief the moment it shipped (covered by a
legacy-row test). `compsThin` is deleted: it duplicated
`comps.confident` / `comps.sampleSize` on the persisted `AreaCompsSummary`.

**Test expectations changed:** the three `compsThin` assertions were **rewritten,
not deleted** — they now check the same facts through the fields a real consumer
reads, and `MIN_COMPS_FOR_CONFIDENCE` is still pinned at 5. Three `HolisticBrief`
fixtures gained the two new keys.

---

### WR-12: the comps budget pre-gate did not price the area-resolution probe renders it authorises

**Files modified:** `src/lib/discovery/job.ts`, `src/lib/discovery/job.test.ts`
**Commit:** `69f98c4`

**Applied fix:** `perAreaWorstCase = estimateCompsFetchSek() + renderSek(1)`,
exactly as suggested. Two tests: a budget covering only the comps fetch
authorises zero areas; a budget covering fetch + probe authorises exactly one and
the actual spend stays inside what the gate priced.

---

### WR-13: `MAX_AREAS_PER_SEARCH` was repurposed as a distinct-`areaLabel` cap, silently starving candidates of comps

**Files modified:** `src/lib/discovery/job.ts`, `src/lib/discovery/job.test.ts`
**Commit:** `5982b6c`

**Applied fix:** `MAX_COMPS_AREAS_PER_PASS = 8`, purpose-named and documented,
replaces the borrowed user-typed-query cap. `areasSkippedForCap` is computed from
the **pre-truncation** distinct-label list (the old counts came from the already
truncated list, which is why the loss was invisible), surfaced on
`CompsResolution`, and logged with a coded diagnostic when the cap actually drops
labels.

8 rather than something larger: the worst-case pass spend
(8 × (comps fetch + one probe render) ≈ 1.5 SEK) stays under half the shared
`CAP_VISION_SEK_MAX` pool so the BRF top-N and the vision pass keep their
headroom (asserted as a test), and it bounds Apify concurrency in line with the
area sweep's own `MAX_AREA_PAGES`. The budget pre-gate still binds first whenever
the pool is tighter.

---

### WR-14: `kommunFromBreadcrumbs`'s NOTE stated the opposite of what `normalizeKommun` now does

**Files modified:** `src/lib/booli/client.ts`
**Commit:** `d02c1b2`

**Applied fix:** Comment-only. Replaced the "accepted limitation pending 14-03"
text with a description of the live behaviour — both sides are normalized through
`normalizeKommun`, which strips the "kommun" suffix and the genitive "-s" behind a
>3-character stem guard, so returning the genitive stem here is intentional and
"high" confidence is reachable.

---

### WR-15: `BrfSummary.stambytePlanerat` was typed `string | null`, discarding the `StambyteStatus` enum contract

**Files modified:** `src/lib/discovery/holistic-schema.ts`,
`src/lib/discovery/holistic-schema.test.ts`,
`src/lib/discovery/confounder-guard.ts`,
`src/lib/discovery/confounder-guard.test.ts`
**Commit:** `044a1c0`

**Applied fix:** The interface now uses `StambyteStatus | null`, `STAMBYTE_PROSE`
is keyed on it, and `STAMBYTE_STATUSES` carries the values at runtime with a
`satisfies readonly NonNullable<StambyteStatus>[]` clause so drift from
`src/lib/schemas/brf.ts` is a compile error.

**Deviation from the review's suggested fix, deliberately:** the read guard
*normalizes* a drifted token to `null` instead of `z.enum(...)` rejecting it. A
bare enum would fail the whole `brfSummarySchema` parse, which — given WR-09's
soft guard one level up — would discard the far more valuable avgift/debt figures
alongside an unrecognised stambyte string. Covered by a test asserting the
figures survive while `stambytePlanerat` becomes `null`, plus a round-trip test
for each real enum value.

**Test change:** three fixtures that feed deliberately drifted strings now carry
an `as StambyteStatus` cast with an explanatory comment, so the runtime
defence-in-depth branch stays exercised even though the shape is now
unrepresentable on the write path.

---

### WR-16: `job.ts` attached a brief for a candidate state `GalleryConditionVision` will not render

**Files modified:** `src/components/gallery-condition-vision.tsx`,
`src/components/gallery-condition-vision.test.tsx`,
`src/lib/discovery/vision.test.ts`
**Commit:** `faba0b6`

**Applied fix:** The two brief cells collapse into one gated on
`hasHolisticBrief && !hasClaims`, so the previously unreachable
`vision === null && visionSkippedReason === null` cell now renders — added the
missing test for it, and corrected the truth-table comment.

**Deviation from the review's suggested fix, deliberately:** the review's snippet
drops the `hasClaims` guard entirely. I kept it, because
`gallery-condition-vision.test.tsx` documents "image-cited claims suppress the
data-only brief" as this component's own independent behaviour, and dropping the
guard would have broken that test — i.e. it would have weakened an existing
assertion rather than fixing the reachability defect. `!hasClaims` fixes the
defect while preserving the documented behaviour.

**Incidental flake made deterministic (not one of the findings):**
`vision.test.ts`'s *"initialSpentSek: 0 behaves identically to omitting the
option"* deep-compared two sequential `runVisionPass` results whose
`VisionResult.ranAt` is `new Date().toISOString()`, so it failed whenever the two
straddled a millisecond boundary. It failed once during this pass and is
reproducible on the pre-change tree. The clock is now frozen for that comparison
with `vi.useFakeTimers()`; the assertion itself is unchanged and no field is
excluded from it.

---

## Skipped Issues

None. All 18 in-scope findings were fixed, and none was judged a false positive.

Info findings **IN-01 … IN-07 were not attempted** — the requested scope was
Critical + Warning only. Note that IN-02 ("`medium`" confidence doubly
unreachable) is materially affected by the CR-02 fix: `debtIncluded === true` is
now reachable for a high-debt förening, so `"medium"` is less rare than the
review describes, though still bounded by `BRF_TOP_N`.

---

## Notes for the developer

1. **The ANL-04 verification gap should now close.** 14-VERIFICATION.md's
   `human_verification[3]` (*"Once the CR-02 fix lands, re-run against a real
   Allabrf-extracted BRF document with a genuinely high debt/m²…"*) remains a
   live operator gate — it cannot be discharged by a mocked test. The mocked
   equivalent is in place and passing.
2. **CR-01 raises the *pre-gate* cost estimate ~10×** (from 1 to 10 renders per
   area). That is intentional and conservative, but it does mean a job whose
   remaining `cap_sek` headroom is under ~0.6 SEK per area will now stop earlier
   than before. Four areas' worst case still fits comfortably inside
   `CAP_SEK_MAX = 5`.
3. **Two spend paths are now more expensive to authorise** (WR-01's BRF gate,
   WR-12's comps gate). Both were verified to still authorise the full top-N /
   the normal area count at the real pool sizes.
4. `job.test.ts:562`'s wall-clock concurrency assertion is a latent CI flake
   under load — see Verification above. Untouched by design.

---

_Fixed: 2026-08-10T13:55:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
