---
phase: 14-holistic-analysis-brain
reviewed: 2026-08-06T18:10:00Z
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
  critical: 4
  warning: 11
  info: 6
  total: 21
status: issues_found
---

# Phase 14: Code Review Report

**Reviewed:** 2026-08-06T18:10:00Z
**Depth:** standard
**Files Reviewed:** 25
**Status:** issues_found

## Summary

Phase 14 adds the "holistic analysis brain": a persisted holistic schema
(`holistic-schema.ts`), a pure confounder guard + brief builder
(`confounder-guard.ts`), a discovery-side BRF orchestrator (`brf-lookup.ts`),
two new spend-gated resolution passes in `job.ts`
(`resolveCompsForCandidates` / `lookupBrfForTopCandidates`), a shared
`CAP_VISION_SEK_MAX` pool seeded via `runVisionPass({ initialSpentSek })`,
genitive-tolerant kommun normalization, and a new warm-gray `HolisticDataBrief`
UI sub-block.

Mechanically the code is careful: `tsc --noEmit` is clean, all 324 tests across
the changed suites pass, the never-throw / never-wedge / GDPR-safe-logging
disciplines are consistently applied, and the PII allowlist and read-path Zod
guards were extended correctly (24 fields, counted and verified).

The defects are concentrated in the **semantics of the data being composed and
priced**, not in the plumbing:

1. The BRF summary is rendered with the **wrong unit** — `avgiftsniva` is
   SEK/m²/år but is printed to the user as "kr/mån".
2. The BRF extraction's **sanity-band confidence downgrade is discarded**, so
   an implausible `skuldPerKvm` is both shown to the buyer and silently folded
   into the debt-inclusive discount math that decides `deepDiscount`.
3. A raw snake_case enum token (`ej_nämnt`) is concatenated into Swedish
   user-facing prose.
4. The shared `CAP_VISION_SEK_MAX` pool can be exceeded by ~60% because a
   failed BRF extraction reports `costSek: 0` after 1–2 real Anthropic calls.

Additionally, the static-grep test that is the *sole* enforcement of the locked
structural-separation invariant — and which Phase 14 explicitly leans on — only
inspects lines that begin with `import`, so it is blind to multi-line named
imports (the exact form the new modules are imported with elsewhere).

No injection, SSRF, XSS, secret-leak or authz defect was found. The synthetic
`buildCompsQuery` URL is re-parsed with a digit-only regex before any outbound
request, and `buildSlutpriserUrl` uses `URLSearchParams`, so the areaId
round-trip is safe.

---

## Critical Issues

### CR-01: `avgiftsniva` rendered with the wrong unit — SEK/m²/år printed as "kr/mån"

**File:** `src/lib/discovery/confounder-guard.ts:381`
**Severity:** BLOCKER

**Issue:** `buildBrfItem` composes:

```ts
if (brf.avgiftsniva !== null) parts.push(`Avgiften ligger kring ${Math.round(brf.avgiftsniva)} kr/mån.`);
```

`avgiftsniva` is unambiguously **årsavgift per kvm, SEK/m² och ÅR** — see
`src/lib/brf/prompt.ts:26` ("avgiftsniva — årsavgift per kvm, SEK/m² och ÅR"),
`src/lib/brf/sanity.ts:26` (`avgiftsniva: { min: 300, max: 1200 }` documented as
"Årsavgift per kvm, SEK/m²/år"), and `src/lib/brf/score.ts:15`. The brief prints
it as a **total monthly fee**.

A real in-band value of 650 SEK/m²/år renders as "Avgiften ligger kring 650
kr/mån." For a 70 m² flat the true monthly fee is 650 × 70 / 12 ≈ 3 792 kr/mån —
the brief understates it by ~6×. This is a user-facing financial figure in a
buying decision, on a surface whose whole premise (`HOLISTIC_DATA_ONLY_MARKER`)
is "trust this, it's data not image interpretation."

The bug is entrenched by the test at
`src/lib/discovery/confounder-guard.test.ts:336`, which uses
`avgiftsniva: 4_200` — a plausible *monthly total*, ~3.5× outside the
`BRF_SANITY_BANDS.avgiftsniva` 300–1200 band, i.e. the test author read the
field as kr/mån too. Contrast `src/lib/discovery/brf-lookup.test.ts:39`, whose
fixture correctly uses `600`.

**Fix:** State the unit the field actually carries, or convert with the
candidate's `livingArea` (which `buildHolisticBrief` already has access to via
its unused `pricePerSqm` input — see WR-06):

```ts
// Option A — state the real unit (no extra inputs needed):
if (brf.avgiftsniva !== null) {
  parts.push(`Årsavgiften ligger kring ${Math.round(brf.avgiftsniva)} kr/kvm och år.`);
}

// Option B — derive the monthly total when livingArea is known (thread it into
// BuildHolisticBriefInput alongside the already-present-but-unused pricePerSqm):
if (brf.avgiftsniva !== null && livingArea !== null && livingArea > 0) {
  const perMonth = Math.round((brf.avgiftsniva * livingArea) / 12);
  parts.push(
    `Årsavgiften ligger kring ${Math.round(brf.avgiftsniva)} kr/kvm och år ` +
      `(motsvarar ca ${perMonth} kr/mån för ${Math.round(livingArea)} kvm).`,
  );
}
```

Also fix the `4_200` fixture in `confounder-guard.test.ts:336` so it stays
inside the sanity band.

---

### CR-02: BRF sanity-band confidence downgrade is discarded — an implausible `skuldPerKvm` is shown to the user *and* silently changes the deep-discount classification

**Files:** `src/lib/discovery/brf-lookup.ts:137-147`, `src/lib/discovery/confounder-guard.ts:145-155`, `src/lib/discovery/confounder-guard.ts:191-198`, `src/lib/discovery/confounder-guard.ts:382-385`
**Severity:** BLOCKER

**Issue:** `lookupBrfSummary` calls `scoreExtraction`, which returns
`{ normalized, grade, perFieldConfidence }`, and then throws away everything
except `normalized`:

```ts
const { normalized } = scoreExtraction(result.parsed);
```

`scoreExtraction` runs `applySanityChecks`, which — per
`src/lib/brf/sanity.ts:49-51` — deliberately **never drops or alters the
value**, only forces `confidence` to `DOWNGRADED_CONFIDENCE = 0.2` (below
`OSAKER_THRESHOLD = 0.5`) when the figure falls outside its plausible band
(`skuldPerKvm` 2 000–15 000, `avgiftsniva` 300–1 200). The single-listing UI
relies on that confidence to render the "Osäker — kontrollera själv" badge. The
discovery path has no such badge and no such gate: `BrfSummary` carries the
value with **no confidence field at all**, and the only downstream guard is
`Number.isFinite`.

Consequences, both real:

1. **Display.** `buildBrfItem` prints the raw figure — "Föreningens skuld per
   kvm verkar ligga kring 480000 kr/kvm (högre än vanligt)" — as if it were a
   normal reading. The classic misextraction the sanity band exists to catch is
   exactly this: total debt read as debt/m².

2. **Silent misclassification.** `normalizeForConfounders` rule 1 adds the
   unvetted figure straight into the comparison basis:

   ```ts
   effectivePricePerSqm = pricePerSqm + brf.skuldPerKvm;
   ```

   A 100× over-read pushes `effectivePricePerSqm` far above
   `renovatedMedianPerSqm`, making `discountVsRenovatedPct` strongly negative →
   `deepDiscount === false` → `conditionExplainedPct = Math.max(0, negative) = 0`.
   A genuinely deeply-discounted candidate is silently reclassified as
   not-discounted, *and* the SPEC §2.6 20% attribution cap never fires. The
   guard that exists to prevent over-attribution is disabled by garbage input.

   Rule 5's `brf_debt_high` threshold (`> HIGH_BRF_DEBT_PER_SQM = 15_000`) is
   *identical* to the sanity band's upper bound, so **every** value that trips
   the sanity downgrade also unconditionally lands in `residualDrivers` as a
   confirmed known confounder.

**Fix:** Carry the per-field confidence into `BrfSummary` and gate on
`OSAKER_THRESHOLD` before the value is displayed or used in arithmetic.

```ts
// brf-lookup.ts
import { OSAKER_THRESHOLD } from "@/lib/brf/sanity";

const { normalized, perFieldConfidence } = scoreExtraction(result.parsed);

/** Below OSAKER_THRESHOLD the figure failed the plausible-band check — do not
 *  present it as a fact and do not feed it into the discount math. */
const trusted = <T,>(key: string, value: T | null): T | null =>
  (perFieldConfidence[key] ?? 0) >= OSAKER_THRESHOLD ? value : null;

const summary: BrfSummary = {
  skuldPerKvm: trusted("skuldPerKvm", normalized.skuldPerKvm),
  avgiftsniva: trusted("avgiftsniva", normalized.avgiftsniva),
  kassaflode: trusted("kassaflode", normalized.kassaflode),
  // ...
};
```

If nulling is judged too lossy, the alternative is to add a
`confidence: Record<string, number>` field to `BrfSummary` +
`brfSummarySchema` and have `normalizeForConfounders` skip low-confidence
values in rule 1 / rule 5 while `buildBrfItem` renders them with an explicit
"osäker uppgift" hedge. Either way the downgrade signal must not be dropped on
the floor.

---

### CR-03: Raw snake_case enum token rendered into Swedish user-facing prose

**File:** `src/lib/discovery/confounder-guard.ts:387`
**Severity:** BLOCKER

**Issue:**

```ts
if (brf.stambytePlanerat !== null) parts.push(`Stambyte-läge: ${brf.stambytePlanerat}.`);
```

`stambytePlanerat` is a bounded enum — `"planerat" | "nyligen_genomfort" |
"ej_nämnt"` (`src/lib/schemas/brf.ts:63-64`) — not free prose. The rendered
output is literally `Stambyte-läge: nyligen_genomfort.` or
`Stambyte-läge: ej_nämnt.`: an internal identifier, underscore and all, shipped
into a buyer-facing Swedish sentence.

Worse, `"ej_nämnt"` is explicitly defined by the prompt
(`src/lib/brf/prompt.ts:40`) as *"the document does not mention stambyte at
all — use `ej_nämnt` (not null)"*. Because the guard is `!== null`, the
**absence of information is rendered as an information item on every BRF-bearing
candidate**, padding a brief whose entire purpose (ANL-01) is "≥1 *actionable*
item."

**Fix:** Map the enum to prose and suppress the not-mentioned case.

```ts
const STAMBYTE_LABEL: Record<StambyteStatus & string, string | null> = {
  planerat: "Föreningen har ett planerat stambyte.",
  nyligen_genomfort: "Föreningen har nyligen genomfört stambyte.",
  ej_nämnt: null, // absence of a mention is not an item
};

const stambyteText = brf.stambytePlanerat
  ? STAMBYTE_LABEL[brf.stambytePlanerat as keyof typeof STAMBYTE_LABEL]
  : null;
if (stambyteText) parts.push(stambyteText);
```

See also WR-09 — typing `BrfSummary.stambytePlanerat` as `StambyteStatus | null`
instead of `string | null` is what makes the exhaustive map above type-safe.

---

### CR-04: The shared `CAP_VISION_SEK_MAX` ceiling can be exceeded by ~60% — a failed BRF extraction reports `costSek: 0` after 1–2 billed Anthropic calls

**Files:** `src/lib/discovery/brf-lookup.ts:150-157`, `src/lib/discovery/job.ts:937-939`, `src/lib/discovery/job.ts:1022-1034`
**Severity:** BLOCKER

**Issue:** D-14-08's whole premise is that comps + BRF + vision share **one**
enforceable 10 SEK ceiling. `lookupBrfSummary`'s catch block breaks that:

```ts
} catch (error) {
  console.error("[discovery-brf-lookup]", { code: ... });
  return { summary: null, costSek: 0, outcome: "extract_failed" };
}
```

`extractBrfFinancials` throws **after** the Anthropic call has already been
billed (`src/lib/brf/extract.ts:296-313`): `CLAUDE_REFUSAL` = 1 billed call,
`CLAUDE_PARSE_EMPTY` = 1 billed call, `CLAUDE_MAX_TOKENS` = **2** billed calls
(it retries `runOnce()` before throwing). Every one of those reports 0 SEK.

`job.ts:938` even documents the wrong invariant:

```ts
// A failed extraction returns costSek: 0, so always adding is safe.
spentSek += result.costSek;
```

That is safe from `NaN`, not correct.

Concrete magnitude, using the repo's own rates (`USD_PER_MTOK.input = 1`,
`output = 5`, `USD_SEK_RATE = 11`) and this phase's own worst-case estimate
(60 000 in / 2 048 out): one call ≈ **0.77 SEK**. With `BRF_TOP_N = 4` all
failing on `CLAUDE_MAX_TOKENS`, ~**6.2 SEK** of real spend is recorded as 0.
`brf.spentSek` then contributes 0 to
`initialSpentSek: comps.spentSek + brf.spentSek`, so `runVisionPass` still gets
the full ~10 SEK pool. Total real spend ≈ 16.2 SEK against a 10 SEK cap.

A secondary leak in the same accounting: even on the **success-after-retry**
path, `extractBrfFinancials` returns `toClaudeUsage(message.usage)` for the
*last* message only, so the first (truncated, billed) call is invisible to
`costSek(result.usage)`.

**Fix:** Charge the estimated cost of any attempt that reached the model, and
prefer over-counting to under-counting in a spend gate.

```ts
// brf-lookup.ts
import { estimateBrfLookupSek } from "@/lib/discovery/cost";

const MODEL_REACHING_CODES = new Set([
  "CLAUDE_REFUSAL",
  "CLAUDE_MAX_TOKENS",
  "CLAUDE_PARSE_EMPTY",
]);

} catch (error) {
  const code = error instanceof Error ? error.message : "UNKNOWN";
  console.error("[discovery-brf-lookup]", { code });
  // The model was already billed before it threw — charge the worst-case
  // estimate rather than 0, or the shared CAP_VISION_SEK_MAX pool silently
  // over-spends (D-14-08).
  const billed = MODEL_REACHING_CODES.has(code) ? estimateBrfLookupSek() : 0;
  return { summary: null, costSek: billed, outcome: "extract_failed" };
}
```

Then delete the now-wrong comment at `job.ts:938` and replace it with the real
reason (`costSek` is always a finite non-negative number).

---

## Warnings

### WR-01: The structural-separation static-grep guard is blind to multi-line imports

**File:** `src/lib/discovery/niche-score.test.ts:323-331`
**Severity:** WARNING

**Issue:** This test is the *only* enforcement of the locked structural
separation constraint, and Phase 14 explicitly relies on it — three new
specifiers were registered "BEFORE any of them exist, since the guard is
silently inert for an unlisted module specifier"
(`niche-score.test.ts:305-308`). But the matcher only inspects lines that
*start* with `import`:

```ts
const importLines = source
  .split("\n")
  .filter((line) => /^\s*import\b/.test(line));
return importLines.some((line) =>
  VISION_MODULE_SPECIFIERS.some((specifier) => line.includes(specifier)),
);
```

A multi-line named import puts the module specifier on the `} from "..."` line,
which does not match `/^\s*import\b/` and is therefore never checked. That is
exactly the shape Prettier produces for >1 named import — and exactly how
`candidate.ts:6-13` and `confounder-guard.ts:24-31` import the new Phase 14
modules today. A future edit adding

```ts
import {
  normalizeForConfounders,
  buildHolisticBrief,
} from "@/lib/discovery/confounder-guard";
```

to `niche-score.ts` would pass this test silently. The guard being registered
early is worthless if the matcher can't see the import.

**Fix:** Match against the whole source with an import-statement regex rather
than line-by-line:

```ts
function importsVisionModule(sourcePath: string): boolean {
  const source = readFileSync(join(process.cwd(), sourcePath), "utf-8");
  // Match complete (possibly multi-line) import/export-from statements.
  const statements = source.match(/^\s*(?:import|export)\b[\s\S]*?from\s*["'][^"']+["']/gm) ?? [];
  const sideEffect = source.match(/^\s*import\s*["'][^"']+["']/gm) ?? [];
  return [...statements, ...sideEffect].some((stmt) =>
    VISION_MODULE_SPECIFIERS.some((specifier) => stmt.includes(specifier)),
  );
}
```

Add a regression test that a multi-line import of a listed specifier is
detected (feed the matcher a fixture string rather than a real file).

---

### WR-02: `estimateVisionCallSek()` ignores broker images — the "REAL, priced worst-case" claim is no longer true

**Files:** `src/lib/discovery/cost.ts:170-183`, `src/lib/discovery/vision.ts:241-246`
**Severity:** WARNING

**Issue:** `estimateVisionCallSek` prices exactly `CAP_IMAGES_PER_LISTING` (4)
images and documents itself as "a genuine upper bound on what the imminent call
can cost." But `runVisionForCandidate` sends **both** sets, each independently
capped:

```ts
const capped = imageUrls.slice(0, CAP_IMAGES_PER_LISTING);
const cappedBroker = brokerImages.slice(0, CAP_IMAGES_PER_LISTING);
const sentCount = capped.length + cappedBroker.length;   // up to 8
```

Using the repo's rates: 4 images → 0.461 SEK/candidate; 8 images →
0.737 SEK/candidate. The estimate under-counts by ~60%.

Impact is bounded (the running total accumulates *actual* `costSek`, so the
overshoot past the cap is at most one call's estimate error, ~0.28 SEK), but the
constant is now a false worst case and the comment asserting otherwise will
mislead the next reader — the same class of drift `estimateVisionCallSek` was
introduced (11-REVIEW CR-01) to eliminate.

**Fix:**

```ts
export function estimateVisionCallSek(): number {
  // Worst case sends BOTH image sets: Booli URLs AND broker bytes, each capped
  // at CAP_IMAGES_PER_LISTING independently (vision.ts's `capped`/`cappedBroker`).
  const MAX_IMAGES_PER_CALL = CAP_IMAGES_PER_LISTING * 2;
  const imageTokens = MAX_IMAGES_PER_CALL * IMAGE_TOKENS_STANDARD_TIER;
  // ...unchanged
}
```

---

### WR-03: Area-resolution probe renders are charged *after* the comps budget pre-gate

**File:** `src/lib/discovery/job.ts:699-702`, `src/lib/discovery/job.ts:738-741`
**Severity:** WARNING

**Issue:** The pre-gate prices only the comps fetch:

```ts
const allowedAreas = Math.max(0, Math.floor(opts.budgetSek / estimateCompsFetchSek()));
```

but a cache/seed miss makes `resolveArea` run a live Booli probe — a paid Apify
render — whose cost is added only afterwards:

```ts
if (resolution.source === "probe") {
  spentSek += renderSek(1);
}
```

So up to `MAX_AREAS_PER_SEARCH` (4) extra renders can be spent past a gate that
never accounted for them, violating the "check-before-spend, never after"
discipline the function's own doc comment claims. The SEK amount is small
(~0.24 SEK) but the *latency* is not — each probe is a full headless render
inside an already-loaded vision tick.

**Fix:** Price the worst case per area in the gate:

```ts
// A cache/seed miss costs one probe render on top of the comps fetch.
const perAreaWorstCase = estimateCompsFetchSek() + renderSek(1);
const allowedAreas = Math.max(0, Math.floor(opts.budgetSek / perAreaWorstCase));
```

---

### WR-04: `MAX_AREAS_PER_SEARCH` is repurposed as a distinct-`areaLabel` cap, silently starving candidates of comps with no signal

**File:** `src/lib/discovery/job.ts:689-702`
**Severity:** WARNING

**Issue:**

```ts
const allLabels = [...labelToIndices.keys()].slice(0, MAX_AREAS_PER_SEARCH);
// ...
areasSkippedForBudget = allLabels.length - labels.length;
```

`MAX_AREAS_PER_SEARCH = 4` was sized for **user-typed** area names in
`splitAreaQuery` ("Södermalm och Vasastan"). Here it caps **distinct scraped
`descriptiveAreaName` values across the whole candidate set** — a different and
much larger population, since Booli's `descriptiveAreaName` is per-listing and
frequently finer-grained than the searched area.

Two problems:

1. Candidates whose label falls outside the first 4 (first-seen order, i.e.
   effectively Booli's relevance order) get `areaComps: null` and therefore fall
   through to `buildHolisticBrief`'s `"insufficient-data"` fallback. In a
   25-candidate multi-neighbourhood job that can be the majority of results —
   directly undercutting ANL-01's "every surfaced candidate leaves analysis with
   ≥1 *actionable* item."
2. The loss is **invisible**. `areasSkippedForBudget` is computed from
   `allLabels` (already truncated), so labels dropped by the `MAX_AREAS_PER_SEARCH`
   cap are counted nowhere and logged nowhere.

**Fix:** Use a purpose-named constant, and report the truncation:

```ts
/** Max distinct scraped areaLabels a single vision pass will resolve comps for.
 *  Distinct from MAX_AREAS_PER_SEARCH (a user-typed-query cap). */
const MAX_COMPS_AREAS_PER_PASS = 8;

const distinctLabels = [...labelToIndices.keys()];
const allLabels = distinctLabels.slice(0, MAX_COMPS_AREAS_PER_PASS);
const areasSkippedForCap = distinctLabels.length - allLabels.length;
if (areasSkippedForCap > 0) {
  console.error("[discovery-job] comps area cap truncated label set", {
    jobId, distinct: distinctLabels.length, kept: allLabels.length,
  });
}
```

and surface `areasSkippedForCap` on `CompsResolution` alongside
`areasSkippedForBudget`.

---

### WR-05: Nested read-guards fail the *whole* candidate, contradicting the degrade-gracefully precedent in the same schema

**File:** `src/lib/discovery/candidate.ts:337-345`
**Severity:** WARNING

**Issue:** The three new sub-schemas are strict:

```ts
areaComps: areaCompsSummarySchema.nullable().default(null),
brfSummary: brfSummarySchema.nullable().default(null),
holisticBrief: holisticBriefSchema.nullable().default(null),
```

`holisticBriefSchema.confidence` is `z.enum(["low", "medium"])` and
`brfSummarySchema` uses `z.literal("allabrf")` / `z.literal(true).nullable()`.
`holistic-schema.ts:198-200` frames this as "a stored `"high"` … fails
`safeParse` rather than being silently trusted" — but the *actual* consumer is
`src/app/(app)/discover/[jobId]/page.tsx:77-79`:

```ts
.map((raw) => discoveryCandidateSchema.safeParse(raw))
.filter((parsed) => parsed.success)
```

A drifted `holisticBrief.confidence` therefore doesn't drop the *brief* — it
drops the **entire candidate** from the user's results page, silently. A
write-path bug affecting all candidates would present as "Inga träffar denna
gång" with a fully-populated `results` array in the DB.

This is also inconsistent with the `imageUrls` field two blocks above, which
deliberately uses `.transform()` to *filter* offending values rather than fail
the parse, with an explicit comment about degrading gracefully.

**Fix:** Degrade the sub-object to `null` instead of failing the candidate:

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

### WR-06: `BuildHolisticBriefInput.pricePerSqm` is dead, and the "comps-positioning" item never states the candidate's position

**Files:** `src/lib/discovery/confounder-guard.ts:285-290`, `src/lib/discovery/confounder-guard.ts:326-361`, `src/lib/discovery/job.ts:1069-1074`
**Severity:** WARNING

**Issue:** `BuildHolisticBriefInput` declares `pricePerSqm: number | null`, and
`job.ts` pays to compute it a second time to supply it:

```ts
const holisticBrief = buildHolisticBrief({
  guard,
  comps: c.areaComps,
  brf: c.brfSummary,
  pricePerSqm: pricePerSqm(c),   // never read by the callee
});
```

Neither `buildHolisticBrief` nor `buildCompsPositioningItem` ever reads it.

That dead parameter is the symptom of a functional gap: the item whose `kind` is
`"comps-positioning"` never positions the candidate. It emits the sample size
and the two medians, but not the candidate's own kr/m² and not
`guard.discountVsRenovatedPct` — both already computed. The opening sentence,
`"Priset per kvadratmeter ligger mot ett urval av N sålda jämförelseobjekt."`,
is also not idiomatic Swedish and conveys no comparison.

**Fix:** Either delete the field from the interface and the `job.ts` call site,
or use it:

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

### WR-07: `ConfounderGuardResult.effectivePricePerSqm` and `compsThin` are computed but consumed nowhere

**File:** `src/lib/discovery/confounder-guard.ts:96-115`, `src/lib/discovery/confounder-guard.ts:222`
**Severity:** WARNING

**Issue:** A repo-wide grep for `effectivePricePerSqm`, `compsThin` and
`debtIncluded` outside `confounder-guard.ts` (and its own test) returns nothing.
`compsThin` in particular duplicates information already available as
`comps.confident` / `comps.sampleSize` on the persisted `AreaCompsSummary`, and
`effectivePricePerSqm` — the single most decision-relevant derived number in the
module (CR-02) — is discarded rather than persisted, so the debt-inclusive basis
behind a `deepDiscount` verdict is not auditable after the fact.

**Fix:** Either drop the unused fields from `ConfounderGuardResult`, or (better
for CR-02's auditability) carry `effectivePricePerSqm` + `debtIncluded` into
`HolisticBrief.conditionAttribution` and its Zod guard so the persisted brief
records what basis produced the verdict.

---

### WR-08: `kommunFromBreadcrumbs`'s doc comment states the opposite of what the code in the same change set does

**File:** `src/lib/booli/client.ts:186-196`
**Severity:** WARNING

**Issue:**

```
 * NOTE: … `resolveOrgNr`'s `normalizeKommun` does an exact case-insensitive
 * comparison with no genitive normalization yet (plan 14-03's fix, not this
 * plan's). A format mismatch fails CLOSED to "low" confidence … accepted
 * limitation pending 14-03.
```

14-03 shipped in this same change set: `normalizeKommun`
(`org-nr-resolver.ts:168-178`) is now exported and does full genitive
normalization. `fetch-brf-auto.ts:90-97` documents the *correct* state
("is now HANDLED by `org-nr-resolver.ts`'s `normalizeKommun`"), so the codebase
carries two comments that directly contradict each other about the same
behaviour.

A reader following the `client.ts` comment would conclude discovery BRF lookups
can never reach `"high"` confidence — the exact false belief that motivated
14-03 — and might "fix" it a second time.

**Fix:** Replace the stale NOTE with a pointer to the live behaviour:

```
 * NOTE: Booli breadcrumb labels are in the Swedish genitive ("Stockholms
 * kommun" -> "Stockholms"); the registry carries the nominative ("Stockholm").
 * `resolveOrgNr` normalizes BOTH sides through `normalizeKommun`
 * (org-nr-resolver.ts, D-14-09), so this function may return the genitive stem
 * unchanged — no de-genitivization is needed or wanted here.
```

---

### WR-09: `BrfSummary.stambytePlanerat` is typed `string | null`, discarding the `StambyteStatus` enum contract

**File:** `src/lib/discovery/holistic-schema.ts:131`, `src/lib/discovery/holistic-schema.ts:146`
**Severity:** WARNING

**Issue:** `src/lib/schemas/brf.ts:78` exports
`StambyteStatus = "planerat" | "nyligen_genomfort" | "ej_nämnt"`, but
`BrfSummary` widens it to `string | null` and `brfSummarySchema` to
`z.string().nullable()`. That widening is what makes CR-03's fix unable to be an
exhaustive map, and it is already being exploited:
`confounder-guard.test.ts:381` feeds `stambytePlanerat: "Föreningen klassas som
ett renoveringsobjekt enligt senaste protokollet"` — a value the production
extraction schema can never produce. The banned-attribution enforcement branch
is therefore only proven against an impossible input.

**Fix:**

```ts
import type { StambyteStatus } from "@/lib/schemas/brf";

readonly stambytePlanerat: StambyteStatus | null;
// and in the Zod guard:
stambytePlanerat: z.enum(["planerat", "nyligen_genomfort", "ej_nämnt"]).nullable(),
```

Then re-point the banned-attribution test at an input the pipeline can actually
produce (e.g. a `confounderLabel` or a comps figure path), so the enforcement
branch is proven against a reachable input.

---

### WR-10: `conditionAttribution.explainedPct` asserts an attribution the same object says is impossible

**File:** `src/lib/discovery/confounder-guard.ts:172-184`, `src/lib/discovery/confounder-guard.ts:238-239`, `src/lib/discovery/confounder-guard.ts:446-451`
**Severity:** WARNING

**Issue:** `canAttributeToCondition` is hard-`false` for all of Phase 14 (rule 6
unconditionally pushes three `*_unknown` ids, so
`unknownConfounders.length === 0` never holds — documented at lines 104-111).
Yet rule 4 still produces a non-null, positive `conditionExplainedPct` — up to
the full 25% discount in the non-deep-discount branch — and persists it as
`conditionAttribution.explainedPct`.

The persisted brief therefore simultaneously says *"we cannot attribute this to
condition"* and *"here is the fraction attributable to condition."* Phase 15/16
consumers reading `explainedPct` off the JSONB have no reason to also check
`canAttributeToCondition`, and D-14-05's whole point is that "cannot attribute"
is the **default posture**, not a footnote.

**Fix:** Gate the value on the flag that governs it:

```ts
conditionAttribution: {
  // D-14-05: an explained fraction is only meaningful when the discount CAN be
  // attributed to condition at all. Otherwise it is null (unknown), never 0
  // (which would read as "condition explains nothing") and never a positive
  // number (which would read as an attribution we just said we cannot make).
  explainedPct: guard.canAttributeToCondition ? guard.conditionExplainedPct : null,
  capped: guard.conditionCapApplied,
  ...
}
```

---

### WR-11: `job.ts` attaches a brief for a candidate state `GalleryConditionVision` will not render

**Files:** `src/lib/discovery/job.ts:1050-1051`, `src/components/gallery-condition-vision.tsx:230-244`
**Severity:** WARNING

**Issue:** The attach predicate is broader than the render predicate.

`job.ts`:

```ts
const hasNoImageClaims = (c: DiscoveryCandidate) =>
  c.vision === null || c.vision.claims.length === 0;
```

`gallery-condition-vision.tsx` renders the brief in exactly two cells:

```tsx
{visionSkippedReason !== null && hasHolisticBrief && holisticBrief && <HolisticDataBrief … />}
{visionSkippedReason === null && visionRanButEmpty && hasHolisticBrief && holisticBrief && <HolisticDataBrief … />}
```

with `visionRanButEmpty = vision !== null && !hasClaims`. The cell
`vision === null && visionSkippedReason === null` gets a brief attached and
rendered **nowhere** — no dead-end line either, since that branch also requires
`visionRanButEmpty`. The component's own truth-table comment (lines 186-208)
enumerates the other cells but omits this one.

It is not reachable through today's `runVisionPass` (every `vision: null` push
sets a `visionSkippedReason`), but that is an invariant held only by convention
across two files, and it is exactly the kind of coupling a Phase 15/16 edit
breaks — with the failure mode being "the brief silently vanishes," not a crash.

**Fix:** Collapse the two render cells into one that does not depend on
`visionSkippedReason` at all — the analysis pass already guarantees a brief is
only attached when there are no image claims:

```tsx
{hasHolisticBrief && holisticBrief && <HolisticDataBrief brief={holisticBrief} />}

{visionSkippedReason === null && visionRanButEmpty && !hasHolisticBrief && (
  <p className="text-sm italic text-warm-gray-500">För osäkert för att visa …</p>
)}
```

---

## Info

### IN-01: `dataSources` claims sources that produced no item

**File:** `src/lib/discovery/confounder-guard.ts:405-408`
`"hedonic"` is pushed unconditionally — including on the `"insufficient-data"`
path, where no hedonic reasoning was emitted — and `"brf"` is pushed whenever
`brf !== null` even if `buildBrfItem` returned `null` (all fields null).
**Fix:** derive `dataSources` from the items actually produced.

### IN-02: `"medium"` confidence is effectively unreachable, undocumented

**File:** `src/lib/discovery/confounder-guard.ts:222-230`
`confidence === "medium"` requires `debtIncluded === true`, which requires a
non-null `brf.skuldPerKvm`. Only `BRF_TOP_N = 4` candidates per job ever get a
BRF summary, so for ~84% of a 25-candidate job the value is a constant `"low"`.
The `canAttributeToCondition` always-false case is explicitly documented
(lines 104-111); this one is not. **Fix:** document it with the same rigour, or
allow `"medium"` on confident comps alone.

### IN-03: `applyBannedAttributionGuard` can emit duplicate identical items

**File:** `src/lib/discovery/confounder-guard.ts:436-439`
If two items trip a banned pattern, both are replaced with the same
`RENO_ATTRIBUTION_FALLBACK_TEXT`, producing a brief with two identical bullets.
**Fix:** de-duplicate after the guard pass.

### IN-04: comps label grouping keys on the untrimmed `areaLabel`

**File:** `src/lib/discovery/job.ts:690-696`
`if (!label || !label.trim()) continue;` guards emptiness but the map is keyed
on the raw `label`, so `"Södermalm"` and `"Södermalm "` become two entries and
fire two concurrent `resolveArea` calls (both cache-miss, since they race).
**Fix:** key on `label.trim()`.

### IN-05: an empty-string `brfName` consumes a BRF top-N slot

**File:** `src/lib/discovery/job.ts:900-902`
`.filter((i) => candidates[i].brfName !== null)` lets `""` through.
`toCandidate`'s `str()` prevents that on the write path, but
`discoveryCandidateSchema.brfName` is `z.string().nullable()`, so a drifted
persisted row can carry `""` — burning one of only four slots on a guaranteed
`"no_name"`. **Fix:** `.filter((i) => (candidates[i].brfName ?? "").trim().length > 0)`.

### IN-06: comps-positioning opening sentence is not idiomatic Swedish

**File:** `src/lib/discovery/confounder-guard.ts:331-335`
`"Priset per kvadratmeter ligger mot ett urval av N sålda jämförelseobjekt."` —
"ligger mot ett urval" is not a natural construction. Suggest
`"Priset per kvadratmeter jämförs här mot N sålda jämförelseobjekt i området."`
(and see WR-06, which would give the sentence something to actually compare).

---

## Verification performed

- `npx tsc --noEmit` — clean.
- `npx vitest run` over all 12 changed/related suites — 324 tests, all passing.
  No test was found to be skipped, assertion-free, or self-mocking.
- Static traces: `discoveryCandidateSchema` consumers, `effectivePricePerSqm` /
  `compsThin` / `debtIncluded` consumers, `avgiftsniva` unit definition across
  `prompt.ts` / `sanity.ts` / `score.ts`, `stambytePlanerat` enum domain,
  `scoreExtraction` return shape, `extractBrfFinancials` throw-after-bill paths,
  `resolveAreaId`'s digit-only regex against `buildCompsQuery`'s synthetic URL.
- Live-network / live-DB verification deliberately out of scope per the phase
  brief (Supabase paused, operator IP Booli/Cloudflare-blocked) and not reported
  as a finding.

---

_Reviewed: 2026-08-06T18:10:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
