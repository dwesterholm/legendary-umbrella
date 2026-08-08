---
phase: 14-holistic-analysis-brain
reviewed: 2026-08-08T17:40:00Z
depth: standard
files_reviewed: 25
files_reviewed_list:
  - src/actions/fetch-brf-auto.ts
  - src/components/discovery-candidate-card.test.tsx
  - src/components/discovery-results.test.tsx
  - src/components/discovery-results.tsx
  - src/components/gallery-condition-vision.test.tsx
  - src/components/gallery-condition-vision.tsx
  - src/lib/booli/client.test.ts
  - src/lib/booli/client.ts
  - src/lib/brf-source/org-nr-resolver.test.ts
  - src/lib/brf-source/org-nr-resolver.ts
  - src/lib/discovery/brf-lookup.test.ts
  - src/lib/discovery/brf-lookup.ts
  - src/lib/discovery/candidate.test.ts
  - src/lib/discovery/candidate.ts
  - src/lib/discovery/confounder-guard.test.ts
  - src/lib/discovery/confounder-guard.ts
  - src/lib/discovery/cost.test.ts
  - src/lib/discovery/cost.ts
  - src/lib/discovery/holistic-schema.test.ts
  - src/lib/discovery/holistic-schema.ts
  - src/lib/discovery/job.test.ts
  - src/lib/discovery/job.ts
  - src/lib/discovery/niche-score.test.ts
  - src/lib/discovery/vision.test.ts
  - src/lib/discovery/vision.ts
findings:
  critical: 2
  warning: 16
  info: 7
  total: 25
status: issues_found
---

# Phase 14: Code Review Report

**Reviewed:** 2026-08-08T17:40:00Z
**Depth:** standard
**Files Reviewed:** 25
**Status:** issues_found

## Summary

This is a **re-review** of the same file set after gap-closure plans 14-07..14-10
landed. Verification first, then new findings.

### Prior findings that ARE now resolved

| Prior ID | Status | Evidence |
|---|---|---|
| CR-01 (`avgiftsniva` printed as "kr/mån") | **FIXED** | `confounder-guard.ts:454-473` now emits `"… kr/kvm och år"` and only derives a per-month figure as `avgiftsniva * livingArea / 12`, guarded on `Number.isFinite(livingArea) && livingArea > 0`. The misleading `4_200` fixture is gone; `confounder-guard.test.ts:407-466` pins both the unit string and the "never a bare kr/mån" invariant across a fixture table. |
| CR-02 (sanity downgrade discarded) | **FIXED** | `BrfSummary.fieldConfidence` (`holistic-schema.ts:147-192`) + the single fail-closed gate `brfFieldTrusted` (`holistic-schema.ts:212-219`), consumed by both `normalizeForConfounders` (`confounder-guard.ts:146`) and `buildBrfItem` (`:455/:475/:483`). `fieldConfidence.default(null)` correctly prevents legacy rows from being dropped by the nested read guard. |
| CR-03 (raw `ej_nämnt` in prose) | **FIXED** | `STAMBYTE_PROSE` (`confounder-guard.ts:332-336`) maps the enum and returns `null` for `ej_nämnt`; `:495-497` no longer concatenates the token. |
| CR-04 (failed BRF extraction reports 0 SEK) | **PARTIALLY FIXED** | `BILLED_CALLS_BY_EXTRACTION_CODE` (`brf-lookup.ts:69-73`) now charges 1–2 × `estimateBrfLookupSek()` on the throw path, and the codes match `extract.ts:301/308/313` exactly. The **success-after-retry** leak is still open (see WR-02), and the fix introduced a new gate/charge asymmetry (WR-01). |
| WR-01 (static-grep guard blind to multi-line imports) | **FIXED** | `niche-score.test.ts:337-354` now matches whole `import … from "…"` statements with a deliberately narrow character class. |

### Prior findings still open

WR-02..WR-11 and IN-01..IN-06 from the previous pass are **all still present**,
re-verified line by line below (renumbered here as WR-04, WR-08..WR-16 and
IN-01..IN-06).

### New findings

Two new **BLOCKER**s, both in spend/decision correctness rather than plumbing:

1. **`runSlice`'s render accounting is now wrong by up to 10×.**
   `fetchAreaListings` was rewritten to walk up to `MAX_AREA_PAGES = 5` pages
   (page 1 sequential + 4 in parallel), each page attempting two own-render
   rungs — but `runSlice` still counts **one render per area** and the pre-gate
   still prices one render per area. `CAP_SEK_MAX` is therefore not enforceable,
   and two doc comments in `job.ts` assert the opposite of what the code does.

2. **The CR-02 trust gate made the SPEC §2.2 "> 15 000 kr/m² debt" red flag
   structurally unreachable — and, worse, now makes a genuinely high-debt
   förening look *cheaper*.** `HIGH_BRF_DEBT_PER_SQM` is numerically identical
   to `BRF_SANITY_BANDS.skuldPerKvm.max`, so every real high-debt reading is
   confidence-downgraded, excluded from the debt-inclusive kr/m² normalization
   (SPEC §2.6 rule 1), never named as `brf_debt_high`, and surfaced to the user
   as "a figure was outside a reasonable range" rather than "this förening
   carries dangerous debt."

Mechanics remain careful otherwise: `npx tsc --noEmit` is clean, all 374 tests
across the 13 changed/related suites pass, `searchAllabrfByName` /
`fetchAllabrfDocument` `encodeURIComponent` their inputs (`allabrf.ts:69,73`),
`buildSlutpriserUrl`/`buildTillSaluUrl` use `URLSearchParams`, no secrets, no
`eval`/`innerHTML`, no debug artifacts, and the GDPR-safe coded-logging
discipline holds in every new catch block.

---

## Structural Findings (fallow)

No `<structural_findings>` block was supplied for this run. The cross-module
facts below were derived directly and are cited inline: `effectivePricePerSqm`
/ `compsThin` / `debtIncluded` have no consumer outside
`confounder-guard.ts` + its test (WR-11); `BRF_CONFIDENCE_FIELDS` is exported
but referenced only inside its own module; `BuildHolisticBriefInput.pricePerSqm`
is written by `job.ts:1078` and read by nobody (WR-10).

---

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: `runSlice` counts one render per area while `fetchAreaListings` now renders up to ten — the `CAP_SEK_MAX` gate and the persisted cost ledger are both under-counted by up to 10×

**Files:** `src/lib/discovery/job.ts:89-104`, `src/lib/discovery/job.ts:192`, `src/lib/discovery/job.ts:214-219`, `src/lib/discovery/job.ts:258-259`, `src/lib/booli/client.ts:669`, `src/lib/booli/client.ts:798-825`
**Severity:** BLOCKER

**Issue:** `fetchAreaListings` no longer performs a single render. It fetches
page 1, and when that page is full fetches pages 2..`MAX_AREA_PAGES` **in
parallel** (`client.ts:798-825`, `MAX_AREA_PAGES = 5`), each page going through
`walkFallbackTree` over two own-playwright rungs — so one call is 1..10 paid
Apify renders.

`runSlice` still models it as one:

```ts
// job.ts:192 — pre-gate
const projectedCost = cost_sek_total + estimatedSliceCostSek(areaIds.length);
...
// job.ts:214-219 — post-scrape accounting
let rendersUsed = 0;
for (...) {
  if (outcome.status === "fulfilled") {
    rendersUsed += 1;          // ONE per AREA, not per PAGE/rung
    raw.push(...outcome.value);
  }
```

Three concrete consequences:

1. **The cost cap is not enforceable.** With 4 areas × 5 pages the real spend is
   up to ~20 renders (~1.21 SEK) against a gate that authorised 4 (~0.24 SEK).
   `cost_sek_total` is persisted from the same under-count, so the error
   compounds across slices and `cap_reached` fires far too late — or never.
2. **Two doc comments now state the opposite of the code.**
   `job.ts:89-93`: *"This estimate assumes one render (the `fetchAreaListings`
   call this slice is about to make) … so it is a conservative
   (never-under-count) pre-check."* It is now a systematic under-count.
   `job.ts:258-259`: *"`fetchAreaListings` is one-shot (no pagination — it
   renders a single till-salu page)"* — directly contradicted by
   `client.ts:790-825`. This is load-bearing prose: it is the stated
   justification for treating a successful sweep as terminal.
3. **Concurrency is unbounded by the ledger.** Up to `(MAX_AREA_PAGES - 1) ×
   areaIds.length` = 16 simultaneous Apify renders can be in flight with no
   spend gate having priced them.

**Fix:** Make the render count flow back from the client instead of being
assumed, and price the worst case in the pre-gate.

```ts
// client.ts — return the real render count alongside the listings
export interface AreaListingsResult {
  listings: Record<string, unknown>[];
  rendersUsed: number;          // incremented inside fetchAreaPage per rung attempted
}

// cost.ts — a named worst case, mirroring estimateCompsFetchSek's precedent
export const AREA_MAX_RENDERS_PER_AREA = MAX_AREA_PAGES * 2;
export function estimateAreaFetchSek(): number {
  return renderSek(AREA_MAX_RENDERS_PER_AREA);
}

// job.ts:192
const projectedCost = cost_sek_total + estimateAreaFetchSek() * areaIds.length;

// job.ts:218
rendersUsed += outcome.value.rendersUsed;   // never a hardcoded 1
```

Then delete the `job.ts:89-93` "never-under-count" claim and the
`job.ts:258-259` "one-shot (no pagination)" sentence and replace them with the
real justification for terminality (`fetchAreaListings` walks to
`MAX_AREA_PAGES` itself, so no further page remains for a later slice).

---

### CR-02: the new `brfFieldTrusted` gate makes the SPEC §2.2 high-debt red flag unreachable *and* removes real high debt from the debt-inclusive kr/m² — a dangerously indebted förening now reads as a bigger bargain

**Files:** `src/lib/discovery/confounder-guard.ts:45`, `src/lib/discovery/confounder-guard.ts:146`, `src/lib/discovery/confounder-guard.ts:155-166`, `src/lib/discovery/confounder-guard.ts:202-215`, `src/lib/discovery/confounder-guard.ts:474-481`, `src/lib/brf/sanity.ts:24-25`
**Severity:** BLOCKER

**Issue:** `HIGH_BRF_DEBT_PER_SQM = 15_000` (`confounder-guard.ts:45`) is
numerically **identical** to `BRF_SANITY_BANDS.skuldPerKvm.max = 15000`
(`sanity.ts:24`). `applySanityChecks` forces any value outside the band to
`DOWNGRADED_CONFIDENCE = 0.2`, which is below `OSAKER_THRESHOLD`, so
`brfFieldTrusted(brf, "skuldPerKvm")` is `false` for **every** extraction-sourced
debt figure above 15 000 kr/m². `scoreExtraction` is called from
`brf-lookup.ts:155` with the default `manualFields = []`, so the discovery path
has no other confidence source. The gate is therefore total.

The code acknowledges half of this at `:202-212` ("This is the INTENDED trade")
but the trade as implemented is not conservative — it is the wrong direction on
the decision that matters:

1. **The debt-inclusive normalization silently drops the debt.**
   `:155-166` treats an untrusted figure "exactly like no BRF at all", so
   `effectivePricePerSqm = pricePerSqm` for exactly the föreningar whose debt
   SPEC §2.6 rule 1 exists to add in. A candidate at 55 000 kr/m² in a förening
   at 30 000 kr/m² debt should be compared at 85 000; it is compared at 55 000.
   `discountVsRenovatedPct` comes out **larger**, `deepDiscount` is **more**
   likely to fire, and the candidate is surfaced as a bigger bargain than it is.
   That is the exact failure mode the previous CR-02 fix was meant to prevent,
   inverted.
2. **`brf_debt_high` is dead code.** `:213` requires `debtUsable && skuldPerKvm >
   15_000` — mutually exclusive by construction. The only test that reaches it
   (`confounder-guard.test.ts:346-349`) uses a synthetic trusted-out-of-band
   fixture the pipeline cannot produce, and the test at `:120-140` documents
   that explicitly. So the SPEC §2.2 ">15k red flag" never appears in a real
   brief.
3. **The display flag is dead too.** `:476`
   `brf.skuldPerKvm > HIGH_BRF_DEBT_PER_SQM ? " (högre än vanligt)" : ""` sits
   inside the `brfFieldTrusted` branch, so the ternary's true arm is unreachable.
4. **The symmetric low-debt case is also wrong.** The band's *lower* bound is
   2 000 kr/m², so a debt-light or debt-free förening — the most attractive
   possible signal — is likewise suppressed and reported to the user as a figure
   that "låg utanför ett rimligt intervall" (see WR-05).

**Fix:** Separate "implausible reading" from "alarming but plausible reading".
The sanity band's job is to catch unit/denominator confusion (total debt read as
debt/m², i.e. six figures), not to reject a real 30 000 kr/m². Give the
discovery path an explicit implausibility ceiling well above the red-flag
threshold, and treat the band between them as *trusted-and-alarming*:

```ts
// confounder-guard.ts
/** Above this a skuldPerKvm reading is a denominator/unit misextraction, not a
 *  fact about the förening (a real Swedish BRF does not carry 100k+ kr/m²). */
export const IMPLAUSIBLE_BRF_DEBT_PER_SQM = 60_000;

const debtValue = brf?.skuldPerKvm ?? null;
const debtImplausible =
  debtValue !== null && (!Number.isFinite(debtValue) || debtValue > IMPLAUSIBLE_BRF_DEBT_PER_SQM);
// Trust the figure for arithmetic when it is present and plausible, regardless
// of the >15k sanity downgrade — a high-but-real debt MUST enter the
// debt-inclusive basis and MUST be named as brf_debt_high.
const debtUsable = debtValue !== null && !debtImplausible;
```

and keep `brfFieldTrusted` as the *display* gate only for the fields whose
downgrade genuinely means "we can't read this" (see WR-05 for splitting the
hedge text). If the band boundary must stay shared, at minimum raise
`BRF_SANITY_BANDS.skuldPerKvm.max` above `HIGH_BRF_DEBT_PER_SQM` so the two
thresholds stop cancelling each other, and add a test asserting
`brf_debt_high` is reachable from a value the extraction pipeline can actually
produce.

---

## Warnings

### WR-01: the BRF budget pre-gate prices one extraction call, but a single failure can now be charged for two

**Files:** `src/lib/discovery/job.ts:905`, `src/lib/discovery/brf-lookup.ts:69-73`, `src/lib/discovery/brf-lookup.ts:197-201`
**Severity:** WARNING

**Issue:** The CR-04 gap-closure made a `CLAUDE_MAX_TOKENS` failure cost
`2 × estimateBrfLookupSek()`, but the pre-gate that authorises the attempt still
divides by one call:

```ts
const allowed = Math.max(0, Math.floor(opts.budgetSek / estimateBrfLookupSek()));
```

With ~0.3 SEK of pool left, `allowed === 0` — fine. With ~0.8 SEK left,
`allowed === 1` and the single authorised attempt can charge ~1.54 SEK, a ~90%
overshoot of the remaining pool. `BRF_TOP_N = 4` bounds the absolute damage
(4 × 2 × 0.77 ≈ 6.2 SEK < 10), so this is not a runaway — but the gate no longer
means what its doc comment says ("check-before-spend").

**Fix:** Price the same worst case the charge path can produce.

```ts
const MAX_BILLED_CALLS_PER_LOOKUP = Math.max(...Object.values(BILLED_CALLS_BY_EXTRACTION_CODE));
const allowed = Math.max(
  0,
  Math.floor(opts.budgetSek / (estimateBrfLookupSek() * MAX_BILLED_CALLS_PER_LOOKUP)),
);
```

---

### WR-02: CR-04 only fixed the throw path — a *successful* extraction after a `max_tokens` retry still reports one call's cost for two billed calls

**Files:** `src/lib/brf/extract.ts:305-322`, `src/lib/discovery/brf-lookup.ts:184`
**Severity:** WARNING

**Issue:** `extract.ts:306` retries `runOnce()` on truncation; when the second
attempt succeeds it returns `usage: toClaudeUsage(message.usage)` for the
**second message only**. `brf-lookup.ts:184` then records
`costSek(result.usage)` — half the real spend. The gap-closure comment at
`brf-lookup.ts:190-196` claims the shared pool is now "honest", which is only
true for the failure path.

**Fix:** Accumulate usage across attempts inside `extract.ts` and return the sum:

```ts
let message = await runOnce();
const usageParts: ClaudeUsage[] = [toClaudeUsage(message.usage)];
if (message.stop_reason === "max_tokens") {
  message = await runOnce();
  usageParts.push(toClaudeUsage(message.usage));
  if (message.stop_reason === "max_tokens") throw new Error("CLAUDE_MAX_TOKENS");
}
...
return { parsed: ..., usage: sumClaudeUsage(usageParts), citations: ... };
```

---

### WR-03: the vision pass discards billed Haiku spend on a failed candidate — the same leak CR-04 closed for BRF

**Files:** `src/lib/discovery/vision.ts:268-281`, `src/lib/discovery/vision.ts:556-563`
**Severity:** WARNING

**Issue:** `runVisionForCandidate` throws `CLAUDE_REFUSAL` / `CLAUDE_MAX_TOKENS`
/ `CLAUDE_PARSE_EMPTY` *after* the Haiku pre-filter has completed and been
billed (`vision.ts:268-281`), and a Sonnet failure occurs after a fully billed
Haiku call. `runVisionPass`'s catch records nothing:

```ts
// vision.ts:557-559
// Degrade this candidate and continue; the
// running cost total is untouched since no cost was returned.
```

"No cost was returned" is not "no cost was incurred". With D-14-08 now routing
comps + BRF + vision through one pool, this is the same class of defect the
phase treated as a BLOCKER on the BRF side, left unfixed on the larger spender.

**Fix:** Mirror `BILLED_CALLS_BY_EXTRACTION_CODE`:

```ts
} catch (error) {
  const code = error instanceof Error ? error.message : "CLAUDE_CALL_FAILED";
  // The pre-filter (and possibly the deep pass) was already billed before the
  // throw — charge the worst-case estimate rather than 0 (D-14-08).
  if (code !== "CLAUDE_CALL_FAILED") runningVisionSek += estimateVisionCallSek();
  out.push({ ...candidate, vision: null, visionSkippedReason: "vision_error" });
}
```

---

### WR-04: `estimateVisionCallSek()` still prices 4 images while up to 8 are sent

**Files:** `src/lib/discovery/cost.ts:160-183`, `src/lib/discovery/vision.ts:241-246`
**Severity:** WARNING (carried forward, unfixed)

**Issue:** `runVisionForCandidate` caps Booli URLs and broker bytes
*independently* (`vision.ts:241-242`), so `sentCount` reaches
`2 × CAP_IMAGES_PER_LISTING`. `estimateVisionCallSek` prices
`CAP_IMAGES_PER_LISTING` while its doc comment at `cost.ts:164-166` claims "a
genuine upper bound on what the imminent call can cost" — ~60% low.

**Fix:**

```ts
export function estimateVisionCallSek(): number {
  // Worst case sends BOTH image sets, each capped independently (vision.ts:241-242).
  const imageTokens = CAP_IMAGES_PER_LISTING * 2 * IMAGE_TOKENS_STANDARD_TIER;
  ...
}
```

---

### WR-05: `BRF_UNTRUSTED_FIGURE_TEXT` tells the user a figure was "outside a reasonable range" even when no range was ever checked

**Files:** `src/lib/discovery/confounder-guard.ts:319-320`, `src/lib/discovery/confounder-guard.ts:482-488`, `src/lib/brf/run-extraction.ts:186-191`
**Severity:** WARNING

**Issue:** The hedge asserts a specific fact:

> "Någon av föreningens siffror **låg utanför ett rimligt intervall** och visas
> därför inte här…"

But `anyFigureSuppressed` is set by *any* sub-threshold confidence, and only two
of the three gated fields have a band at all. `run-extraction.ts:189` passes
`kassaflode: extraction.kassaflode.confidence` through **untouched** — there is
no `BRF_SANITY_BANDS.kassaflode`. So a kassaflöde the model merely read off a
smudged scan at confidence 0.4 produces a sentence claiming it was out of range.
The same applies to a low-confidence-but-in-band `skuldPerKvm`/`avgiftsniva`
(scanned document, derived figure — `prompt.ts` explicitly instructs the model to
lower confidence for those). On a surface whose whole premise is
`HOLISTIC_DATA_ONLY_MARKER` ("trust this, it's data"), stating an unsupported
reason is exactly the discipline violation this phase is built around.

**Fix:** Distinguish the two causes and word each honestly.

```ts
export const BRF_OUT_OF_BAND_FIGURE_TEXT =
  "En av föreningens siffror låg utanför ett rimligt intervall och visas därför inte här — kontrollera avgift och skuld per kvm i föreningens årsredovisning.";
export const BRF_LOW_CONFIDENCE_FIGURE_TEXT =
  "En av föreningens siffror kunde inte läsas med tillräcklig säkerhet och visas därför inte här — kontrollera den i föreningens årsredovisning.";

// buildBrfItem: track WHY each field was suppressed
const outOfBand = (field: BrfConfidenceField, value: number) =>
  field in BRF_SANITY_BANDS &&
  (value < BRF_SANITY_BANDS[field].min || value > BRF_SANITY_BANDS[field].max);
```

---

### WR-06: two object-literal lookups keyed by an untrusted string are documented as fail-closed but resolve `Object.prototype` members

**Files:** `src/lib/discovery/confounder-guard.ts:489-497`, `src/lib/discovery/brf-lookup.ts:197-201`
**Severity:** WARNING

**Issue:** Both new lookups index a plain object literal with a string whose
domain is not statically constrained, and both rely on `?? null` / `?? 0` as the
guard. Neither `??` fires for an inherited property.

1. `confounder-guard.ts:495-496`:
   ```ts
   const stambyteProse =
     brf.stambytePlanerat === null ? null : STAMBYTE_PROSE[brf.stambytePlanerat] ?? null;
   ```
   `BrfSummary.stambytePlanerat` is typed `string | null` and
   `brfSummarySchema` accepts **any** string (`holistic-schema.ts:180`), so
   `"toString"` yields `Function.prototype.toString`, `"constructor"` yields
   `Object` — neither is nullish, so `parts.push(<function>)` succeeds and
   `parts.join(" ")` stringifies the function source **into buyer-facing Swedish
   prose**. The comment at `:489-494` explicitly claims "no unmapped token can
   ever reach user-facing prose"; that claim is false.
2. `brf-lookup.ts:199`:
   ```ts
   costSek: (BILLED_CALLS_BY_EXTRACTION_CODE[code] ?? 0) * estimateBrfLookupSek(),
   ```
   `code` is `error.message` — arbitrary. `"constructor"` gives
   `Object * number = NaN`. That `NaN` propagates to `BrfResolution.spentSek`
   (`job.ts:944`, whose comment asserts "always a finite non-negative number"),
   then to `initialSpentSek: comps.spentSek + brf.spentSek` — and
   `runVisionPass`'s `Number.isFinite` guard silently resets the pool to **0**,
   discarding the comps spend too.

Neither is reachable through today's write path (`normalized.stambytePlanerat`
comes from a Zod-validated enum; `extract.ts` throws only its four coded
strings), so this is latent — but both sites are *specifically* the
defence-in-depth guards the gap closure added.

**Fix:** Use own-property lookups or a `Map`.

```ts
const STAMBYTE_PROSE = new Map<string, string | null>([
  ["planerat", "Föreningen har ett planerat stambyte."],
  ["nyligen_genomfort", "Föreningen har nyligen genomfört stambyte."],
  ["ej_nämnt", null],
]);
const stambyteProse =
  brf.stambytePlanerat === null ? null : STAMBYTE_PROSE.get(brf.stambytePlanerat) ?? null;

const billedCalls = Object.hasOwn(BILLED_CALLS_BY_EXTRACTION_CODE, code)
  ? BILLED_CALLS_BY_EXTRACTION_CODE[code]
  : 0;
```

Also fix the false claim in the `job.ts:938-943` comment (it is a hope, not an
invariant) by clamping: `spentSek += Number.isFinite(result.costSek) ? Math.max(0, result.costSek) : 0;`.

---

### WR-07: every brief lists the same unknown-confounder labels twice, verbatim

**Files:** `src/lib/discovery/confounder-guard.ts:413-418`, `src/lib/discovery/confounder-guard.ts:429-442`
**Severity:** WARNING

**Issue:** `buildCompsPositioningItem` emits, when
`canAttributeToCondition === false` (which is *always*, by design — `:256-263`):

```ts
const named = [...guard.residualDrivers, ...guard.unknownConfounders].map(confounderLabel).join(", ");
parts.push(`Skillnaden kan bero på skick, men kan lika gärna bero på faktorer … : ${named}.`);
```

and `buildConfounderItems` then emits the *same* two lists again as separate
items (`:431-440`). Any brief with comps therefore repeats
"hiss (okänt), mikroläge (okänt), delområde (okänt), …" word for word in
adjacent bullets. ANL-01's success criterion is ≥1 **actionable** item; padding
the list with a duplicate degrades exactly that.

**Fix:** Let the comps item state the positioning and defer naming to the
confounder items:

```ts
if (guard.canAttributeToCondition === false) {
  parts.push(
    "Skillnaden kan bero på skick, men kan lika gärna bero på faktorer som priset ensamt inte kan skilja ut (se nedan).",
  );
}
```

---

### WR-08: `conditionAttribution.explainedPct` asserts an attribution the same object says is impossible

**Files:** `src/lib/discovery/confounder-guard.ts:183-195`, `src/lib/discovery/confounder-guard.ts:556-562`
**Severity:** WARNING (carried forward, unfixed)

**Issue:** `canAttributeToCondition` is unconditionally `false` this phase
(`:226-230` always pushes three `*_unknown` ids), yet `:558` persists
`explainedPct: guard.conditionExplainedPct` — a positive number up to 25%. The
JSONB record simultaneously says "cannot attribute to condition" and "here is
the fraction attributable to condition". Phase 15/16 consumers reading
`explainedPct` have no reason to also check the flag.

**Fix:**

```ts
explainedPct: guard.canAttributeToCondition ? guard.conditionExplainedPct : null,
```

---

### WR-09: a nested read-guard failure drops the *whole candidate* from the results page

**Files:** `src/lib/discovery/candidate.ts:337-345`, `src/app/(app)/discover/[jobId]/page.tsx:75-79`
**Severity:** WARNING (carried forward, unfixed — surface area increased)

**Issue:** `page.tsx:77-79` does
`.map(safeParse).filter((p) => p.success)`, so any nested failure removes the
candidate entirely. Phase 14 tripled the nested-schema surface:
`brfSummarySchema.source: z.literal("allabrf")` (`holistic-schema.ts:183`),
`holisticBriefSchema.confidence: z.enum(["low","medium"])` (`:272`),
`areaCompsSummarySchema`'s nine required keys (`:103-113`). A write-path bug or
a second BRF source would present as "Inga träffar denna gång" with a fully
populated `results` array. This contradicts the `imageUrls` field two blocks
above, which deliberately `.transform()`s away offending values rather than
failing (`candidate.ts:306-310`).

**Fix:**

```ts
const softNullable = <S extends z.ZodTypeAny>(schema: S) =>
  z.unknown().transform((v) => {
    if (v === null || v === undefined) return null;
    const parsed = schema.safeParse(v);
    return parsed.success ? parsed.data : null;
  });

areaComps: softNullable(areaCompsSummarySchema),
brfSummary: softNullable(brfSummarySchema),
holisticBrief: softNullable(holisticBriefSchema),
```

---

### WR-10: `BuildHolisticBriefInput.pricePerSqm` is dead, and the "comps-positioning" item never states the candidate's position

**Files:** `src/lib/discovery/confounder-guard.ts:338-350`, `src/lib/discovery/confounder-guard.ts:392-427`, `src/lib/discovery/job.ts:1074-1080`
**Severity:** WARNING (carried forward, unfixed)

**Issue:** `buildHolisticBrief` destructures `{ guard, comps, brf, livingArea }`
(`:514`) and `buildCompsPositioningItem` destructures `{ guard, comps }`
(`:393`) — `pricePerSqm` is read nowhere, yet `job.ts:1078` pays to compute it a
second time to supply it. The interface even documents `livingArea` as "used
ONLY to derive a monthly avgift … WR-06 stays OUT OF SCOPE", i.e. the dead field
was knowingly left in place. Functionally, the item emits the sample size and
the two medians but never the candidate's own kr/m² and never
`guard.discountVsRenovatedPct` — so a "positioning" item does not position.

**Fix:** Delete the field from `BuildHolisticBriefInput` and from the `job.ts`
call site, or consume it:

```ts
if (input.pricePerSqm !== null) {
  parts.unshift(`Priset ligger på ca ${Math.round(input.pricePerSqm)} kr/kvm.`);
}
if (guard.discountVsRenovatedPct !== null) {
  const pct = Math.round(Math.abs(guard.discountVsRenovatedPct) * 100);
  parts.push(
    guard.discountVsRenovatedPct >= 0
      ? `Det är ca ${pct}% under medianen för nyare/renoverade objekt.`
      : `Det är ca ${pct}% över medianen för nyare/renoverade objekt.`,
  );
}
```

---

### WR-11: `effectivePricePerSqm`, `debtIncluded` and `compsThin` are computed but consumed nowhere

**Files:** `src/lib/discovery/confounder-guard.ts:96-116`, `src/lib/discovery/confounder-guard.ts:246`
**Severity:** WARNING (carried forward, unfixed)

**Issue:** A repo-wide grep finds these three symbols only inside
`confounder-guard.ts` and its own test (the `effectivePricePerSqm` hit in
`brf-lookup.ts` is a prose mention in a comment, `:172`). `compsThin` duplicates
`comps.confident` / `comps.sampleSize` on the persisted summary, and
`effectivePricePerSqm` — the single most decision-relevant derived number in the
module, and the one CR-02 above turns on — is discarded rather than persisted,
so a `deepDiscount` verdict is not auditable after the fact.

**Fix:** Drop `compsThin`, and carry `effectivePricePerSqm` + `debtIncluded`
into `HolisticBrief.conditionAttribution` (and `holisticBriefSchema`) so the
persisted brief records the basis that produced the verdict.

---

### WR-12: the comps budget pre-gate does not price the area-resolution probe renders it authorises

**Files:** `src/lib/discovery/job.ts:699-702`, `src/lib/discovery/job.ts:738-741`
**Severity:** WARNING (carried forward, unfixed)

**Issue:** `allowedAreas = floor(budgetSek / estimateCompsFetchSek())` prices
only the comps fetch, but a cache/seed miss makes `resolveArea` run a live Booli
probe whose cost is added *after* the fact (`spentSek += renderSek(1)`),
violating the function's own stated check-before-spend discipline. Small in SEK
(~0.24), material in latency (a full headless render inside an already-loaded
vision tick).

**Fix:**

```ts
const perAreaWorstCase = estimateCompsFetchSek() + renderSek(1);
const allowedAreas = Math.max(0, Math.floor(opts.budgetSek / perAreaWorstCase));
```

---

### WR-13: `MAX_AREAS_PER_SEARCH` is repurposed as a distinct-`areaLabel` cap, silently starving candidates of comps

**File:** `src/lib/discovery/job.ts:689-702`
**Severity:** WARNING (carried forward, unfixed)

**Issue:** `MAX_AREAS_PER_SEARCH = 4` (`resolve-area.ts:48`) was sized for
*user-typed* area names in `splitAreaQuery`. At `job.ts:697` it caps **distinct
scraped `descriptiveAreaName` values across the whole candidate set** — a much
larger population. Candidates outside the first 4 labels get `areaComps: null`
and fall through to the `"insufficient-data"` brief. The loss is invisible:
`areasSkippedForBudget` is computed from the already-truncated `allLabels`
(`:702`), so cap-dropped labels are counted and logged nowhere.

**Fix:** Introduce `MAX_COMPS_AREAS_PER_PASS` (purpose-named, larger), compute
`areasSkippedForCap = distinctLabels.length - allLabels.length`, log it, and
surface it on `CompsResolution`.

---

### WR-14: `kommunFromBreadcrumbs`'s NOTE states the opposite of what `normalizeKommun` now does

**File:** `src/lib/booli/client.ts:186-196`
**Severity:** WARNING (carried forward, unfixed)

**Issue:** The comment still reads *"`resolveOrgNr`'s `normalizeKommun` does an
exact case-insensitive comparison with no genitive normalization yet (plan
14-03's fix, not this plan's) … accepted limitation pending 14-03."* 14-03
shipped: `org-nr-resolver.ts:168-178` does full genitive normalization, and
`fetch-brf-auto.ts:90-97` documents the correct state. Two comments in the tree
now contradict each other about the same behaviour; a reader following this one
concludes discovery BRF lookups can never reach `"high"` — the exact false
belief 14-03 existed to remove.

**Fix:** Replace with a description of the live behaviour (both sides normalized
through `normalizeKommun`, so returning the genitive stem here is intentional).

---

### WR-15: `BrfSummary.stambytePlanerat` is typed `string | null`, discarding the `StambyteStatus` enum contract

**Files:** `src/lib/discovery/holistic-schema.ts:151`, `src/lib/discovery/holistic-schema.ts:180`
**Severity:** WARNING (carried forward, unfixed)

**Issue:** `src/lib/schemas/brf.ts:78` exports
`StambyteStatus = "planerat" | "nyligen_genomfort" | "ej_nämnt"`, and
`brfExtractionSchema` / `brfDataSchema` both constrain it as a Zod enum
(`:63-64`, `:172-174`). `BrfSummary` widens it to `string`, which is what forces
`STAMBYTE_PROSE` to be an unsafe `Record<string, …>` lookup (WR-06) instead of
an exhaustive map. The gap-closure comment at `confounder-guard.ts:491-493`
explicitly defers this.

**Fix:**

```ts
import type { StambyteStatus } from "@/lib/schemas/brf";
readonly stambytePlanerat: StambyteStatus | null;
// and in the read guard:
stambytePlanerat: z.enum(["planerat", "nyligen_genomfort", "ej_nämnt"]).nullable(),
```

---

### WR-16: `job.ts` attaches a brief for a candidate state `GalleryConditionVision` will not render

**Files:** `src/lib/discovery/job.ts:1055-1056`, `src/components/gallery-condition-vision.tsx:230-244`
**Severity:** WARNING (carried forward, unfixed)

**Issue:** The attach predicate is `c.vision === null || c.vision.claims.length === 0`.
The render predicates are `visionSkippedReason !== null && hasHolisticBrief`
(`:230`) and `visionSkippedReason === null && visionRanButEmpty && hasHolisticBrief`
(`:241-244`), where `visionRanButEmpty = vision !== null && !hasClaims`. The cell
`vision === null && visionSkippedReason === null` therefore gets a brief attached
and rendered **nowhere** — and `discovery-results.test.tsx:270-274` now documents
that state as "correctly renders nothing new", entrenching the mismatch. No test
covers it in `gallery-condition-vision.test.tsx`. The invariant that keeps it
unreachable is held by convention across two files.

**Fix:** Collapse the two render cells into one that does not consult
`visionSkippedReason` — the analysis pass already guarantees a brief is only
attached when there are no image claims:

```tsx
{hasHolisticBrief && holisticBrief && <HolisticDataBrief brief={holisticBrief} />}

{visionSkippedReason === null && visionRanButEmpty && !hasHolisticBrief && (
  <p className="text-sm italic text-warm-gray-500">För osäkert för att visa …</p>
)}
```

---

## Info

### IN-01: `dataSources` claims sources that produced no item

**File:** `src/lib/discovery/confounder-guard.ts:516-519`
`"hedonic"` is pushed unconditionally — including on the `"insufficient-data"`
path where no hedonic reasoning was emitted — and `"brf"` is pushed whenever
`brf !== null` even if `buildBrfItem` returned `null`.
**Fix:** derive `dataSources` from the items actually produced.

### IN-02: `"medium"` confidence is now doubly unreachable and still undocumented

**File:** `src/lib/discovery/confounder-guard.ts:247-254`
`"medium"` requires `debtIncluded === true`, which after CR-02's gate requires a
*trusted* `skuldPerKvm` on one of only `BRF_TOP_N = 4` candidates. For a
25-candidate job the value is a constant `"low"` for ≥84% of results, and the
`brfFieldTrusted` gate shrinks the remainder further. The always-false
`canAttributeToCondition` case is documented with care (`:105-112`); this one is
not.
**Fix:** document it with equal rigour, or allow `"medium"` on confident comps alone.

### IN-03: `applyBannedAttributionGuard` can emit duplicate identical items

**File:** `src/lib/discovery/confounder-guard.ts:547-550`
Two items tripping a banned pattern are both replaced with the same
`RENO_ATTRIBUTION_FALLBACK_TEXT`, producing a brief with two identical bullets.
**Fix:** de-duplicate after the guard pass.

### IN-04: comps label grouping keys on the untrimmed `areaLabel`

**File:** `src/lib/discovery/job.ts:690-696`
`if (!label || !label.trim()) continue;` guards emptiness but the map is keyed on
the raw `label`, so `"Södermalm"` and `"Södermalm "` become two entries and fire
two concurrent `resolveArea` calls (both cache-miss, since they race) — also
consuming two of the four `MAX_AREAS_PER_SEARCH` slots (WR-13).
**Fix:** key on `label.trim()`.

### IN-05: an empty-string `brfName` consumes a BRF top-N slot

**File:** `src/lib/discovery/job.ts:900-902`
`.filter((i) => candidates[i].brfName !== null)` lets `""` through.
`toCandidate`'s `str()` prevents that on the write path, but
`discoveryCandidateSchema.brfName` is `z.string().nullable()` and
`claimVisionSlice` (`job.ts:341-347`) casts the raw JSONB **without** running the
schema at all — so a drifted row can burn one of only four slots on a guaranteed
`"no_name"`.
**Fix:** `.filter((i) => (candidates[i].brfName ?? "").trim().length > 0)`.

### IN-06: comps-positioning opening sentence is not idiomatic Swedish

**File:** `src/lib/discovery/confounder-guard.ts:397-401`
`"Priset per kvadratmeter ligger mot ett urval av N sålda jämförelseobjekt."` —
"ligger mot ett urval" is not a natural construction. Suggest
`"Priset per kvadratmeter jämförs här mot N sålda jämförelseobjekt i området."`
(and see WR-10, which would give the sentence something to compare).

### IN-07: `VISION_ENRICH_LIMIT` detail renders are still outside the cost ledger

**File:** `src/lib/discovery/job.ts:419-429`
Up to 8 paid Apify detail renders per job are acknowledged in the comment as "not
yet folded into the persisted cost ledger". Combined with CR-01 this is the
second unpriced render source in the same pass.
**Fix:** fold `enrichCandidateImages`'s fetch count into `renderSek` and the
shared pool, or record it as an explicit deferred item with a ticket rather than
a prose aside.

---

## Verification performed

- `npx tsc --noEmit` — clean.
- `npx vitest run` over all 13 changed/related suites — 374 tests, all passing.
  No skipped, assertion-free or self-mocking test found.
- Re-verified each prior finding against current source (resolution table in the
  Summary), including reading `sanity.ts`, `run-extraction.ts:166-201`,
  `extract.ts:265-340` and `schemas/brf.ts:55-120` to confirm the
  `perFieldConfidence` key set, the exact thrown error strings, the
  `kassaflode`-has-no-band fact, and the `usage`-of-last-message behaviour.
- Traced `discoveryCandidateSchema` consumers (`page.tsx:75-79`) and the
  unparsed `claimVisionSlice` cast (`job.ts:341-347`).
- Injection/SSRF spot-check: `allabrf.ts:69,73` `encodeURIComponent`s both the
  BRF name and the org.nr; `resolveOrgNr` gates on Luhn before any URL is built;
  `buildTillSaluUrl`/`buildSlutpriserUrl` use `URLSearchParams`;
  `claimVisionSlice` re-applies `isAllowedImageHost`. No injection, XSS,
  secret-leak or authz defect found.
- Live-network / live-DB verification deliberately out of scope (Supabase paused,
  operator IP Booli/Cloudflare-blocked) and not reported as a finding.

---

_Reviewed: 2026-08-08T17:40:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
