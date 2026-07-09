---
phase: 11-gallery-condition-vision
reviewed: 2026-07-07T15:49:23Z
depth: standard
files_reviewed: 13
files_reviewed_list:
  - src/lib/discovery/vision.ts
  - src/lib/discovery/vision-schema.ts
  - src/lib/discovery/vision-prompt.ts
  - src/lib/discovery/candidate.ts
  - src/lib/discovery/cost.ts
  - src/lib/discovery/job.ts
  - src/lib/booli/client.ts
  - src/actions/tick-discovery.ts
  - src/app/api/discovery/sweep/route.ts
  - src/components/gallery-condition-vision.tsx
  - src/components/discovery-results.tsx
  - evals/vision.eval.ts
  - scripts/probe-booli-images.ts
findings:
  critical: 4
  warning: 4
  info: 1
  total: 9
status: issues_found
---

# Phase 11: Code Review Report

**Reviewed:** 2026-07-07T15:49:23Z
**Depth:** standard
**Files Reviewed:** 13
**Status:** issues_found

## Summary

Reviewed the two-pass (Haiku pre-filter → Sonnet deep pass) gallery-condition
vision pipeline, its cost accounting, its wiring into the discovery job/tick/
sweep lifecycle, the PII-safe candidate allowlist, the image-host SSRF
allowlist, and the presentational UI component. The structural-separation
invariant (vision must never reach `computeNicheScore`/`ReportFlags`) is
genuinely enforced — `niche-score.test.ts` statically greps `niche-score.ts`
and `flags.ts` for a vision import and fails if one appears, and manual
inspection confirms `computeNicheScore` and `flags.ts` import nothing from
`vision.ts`/`vision-schema.ts`. Prompt-injection/PII discipline is also solid:
both prompts carry the identical PII-ignore instruction, `whatWasSeen`'s
schema description steers away from personal content, and all vision-related
`console.error` calls are GDPR-safe (`{ id, code }` only).

However, the incremental vision-cost cap is NOT a genuine per-call worst-case
check — it divides the cap by candidate count to produce an arbitrary average,
which can let real spend overshoot `CAP_VISION_SEK_MAX` by an unbounded margin
whenever a single candidate's real cost differs from that average. A vision
pipeline error is also unhandled all the way up through `tickDiscovery`/the
sweep route, which can permanently strand a job's already-scraped results
behind a job stuck in a terminal `"done"` state with vision never applied and
no retry path (the job can never be re-claimed once `"done"`). The dedupe
map's fallback key (`sourceListingUrl ?? "unknown"`) can also collide across
distinct candidates with a missing/malformed URL, causing one candidate's
vision claims to be shown under another candidate's card. The verifier-flagged
UI spacing deviation (grid↔vision gap is 16px, not the UI-SPEC's required
24px) is confirmed by direct inspection of `discovery-results.tsx`.

## Critical Issues

### CR-01: Vision cost cap check uses a fabricated average, not a real per-call estimate — can overshoot CAP_VISION_SEK_MAX unboundedly

**File:** `src/lib/discovery/vision.ts:320-329`
**Issue:** The incremental pre-spend check is:
```ts
const estimate = CAP_VISION_SEK_MAX / Math.max(1, candidates.length);
if (runningVisionSek + estimate > CAP_VISION_SEK_MAX) {
  costCapHit = true;
  ...
}
```
`estimate` is `CAP_VISION_SEK_MAX` divided by the total candidate count — an
arbitrary fraction of the cap, completely disconnected from the actual
worst-case cost of the Haiku+Sonnet call about to be made (which depends on
real image token counts, output length, etc. — see `visionCostSek`/`costSek`/
`costSekSonnet` in `src/lib/brf/cost.ts`, the actual pricing model this module
otherwise correctly reuses for POST-hoc accounting). Because this "estimate"
shrinks as `candidates.length` grows (e.g. 0.4 SEK for a 25-candidate job) and
bears no relationship to what a given candidate's Sonnet deep-pass call will
actually cost, the gate can pass when `runningVisionSek` is low even though
the imminent real call could cost several times the phantom estimate (e.g. a
candidate with 4 large gallery images and a verbose Sonnet response). The
job's real vision spend is only checked and recorded AFTER each call
(`runningVisionSek += result.costSek`, line 337) — the doc comment's claim
that this "mirrors `runSlice`'s check-running-total-BEFORE-spend discipline"
is misleading: `runSlice`'s pre-check (`estimatedSliceCostSek`) is a real,
priced per-render cost; this one is not tied to any real cost model at all.
**Fix:** Use a real worst-case per-call estimate, e.g. a fixed constant
derived from max_tokens/max image count (mirrors `estimatedSliceCostSek`'s
approach in `job.ts`):
```ts
// Worst case: CAP_IMAGES_PER_LISTING images at ~1600 tokens each (Anthropic's
// standard-tier image token estimate) + max_tokens output, Haiku + Sonnet.
const WORST_CASE_VISION_CALL_SEK = /* computed from real token/price constants */;
if (runningVisionSek + WORST_CASE_VISION_CALL_SEK > CAP_VISION_SEK_MAX) { ... }
```

### CR-02: Uncaught vision-pipeline error strands already-scraped job results with no retry path

**File:** `src/lib/discovery/vision.ts:244-250`, `src/lib/discovery/job.ts:203-210`, `src/actions/tick-discovery.ts:91-97`, `src/app/api/discovery/sweep/route.ts:108-114`
**Issue:** `runVisionForCandidate`'s catch block rethrows after logging
(`throw new Error(code, { cause: error })`, vision.ts:249). This propagates
uncaught through `runVisionPass`'s `for...of` loop (no try/catch), through
`runVisionForJob` (no try/catch — `job.ts:203-210`), and out of both call
sites (`tickDiscovery`, `sweep/route.ts`), neither of which wraps the
`runVisionForJob` call. A single failing candidate (Claude refusal, transient
API error, malformed image URL causing an Anthropic-side fetch error) aborts
the entire vision pass — `updateJob(supabase, jobId, { results: withVision })`
is never reached, so NO candidates receive vision, not even ones already
processed successfully earlier in the loop. Because `claim_discovery_slice`
only claims jobs with `status in ('pending','processing')` (migration
`011_claim_slice_ownership.sql:45`), a job already flipped to `"done"` by
`runSlice` can never be re-claimed — there is no mechanism that will ever
retry `runVisionForJob` for this job again. In `tickDiscovery`, the uncaught
throw also propagates out of the Server Action into
`discovery-progress.tsx`'s `poll()` (which has a `try/finally` with no
`catch`), so the poll's own `setStatus`/`TERMINAL_STATUSES` handling never
runs for that round — the client is left relying solely on the `MAX_POLL_MS`
timeout fallback to eventually mark the job `"failed"`, even though the job's
scrape phase actually succeeded and its candidates are sitting in the DB with
`status: "done"`.
**Fix:** Wrap the vision pass so a per-candidate failure degrades that
candidate (e.g. to a new `visionSkippedReason: "error"`) instead of aborting
the whole job, and/or wrap `runVisionForJob`'s call site in a try/catch that
logs and returns rather than rethrowing:
```ts
// in runVisionForJob
try {
  const withVision = await runVisionPass(results);
  await updateJob(supabase, jobId, { results: withVision });
} catch (error) {
  console.error("[discovery-vision-job] pass failed", { jobId, code: error instanceof Error ? error.message : "UNKNOWN" });
  // job stays "done" with its pre-vision results intact — never re-throw here.
}
```

### CR-03: Dedupe-map fallback key collision cross-contaminates vision results between candidates with a missing sourceListingUrl

**File:** `src/lib/discovery/vision.ts:290-291, 313-318`
**Issue:**
```ts
const booliIdOf =
  opts.booliIdOf ?? ((c: DiscoveryCandidate) => c.sourceListingUrl ?? "unknown");
...
const booliId = booliIdOf(candidate);
const cached = dedupe.get(booliId);
if (cached) {
  out.push({ ...candidate, vision: cached, visionSkippedReason: null });
  continue;
}
```
`sourceListingUrl` is a nullable field (`candidate.ts:46`, populated via
`str(raw.url)` which returns `null` on a missing/malformed `url`). If TWO OR
MORE distinct candidates in the same job both have `sourceListingUrl: null`
(a realistic malformed-listing scenario, not hypothetical — `str()` degrades
silently rather than throwing), they collide on the literal dedupe key
`"unknown"`. The second such candidate is never sent to Claude at all —
it is served the FIRST candidate's `VisionResult` (someone else's kitchen/
bathroom claims and someone else's `imageUrlsUsed` thumbnails), silently
mislabeled as belonging to the second listing. This is a data-integrity bug
that produces confidently-wrong, uncited-in-reality claims shown to the user
under the wrong listing.
**Fix:** Use a key that is unique per candidate even when `sourceListingUrl`
is null, e.g. derive from `imageUrls` content hash, or fall back to the
candidate's array index (guaranteed unique within one pass) rather than a
shared sentinel string:
```ts
const booliIdOf =
  opts.booliIdOf ?? ((c: DiscoveryCandidate, i: number) => c.sourceListingUrl ?? `unknown-${i}`);
```
(and thread the index through the loop, or simply skip the dedupe map
entirely for candidates whose key resolves to the sentinel).

### CR-04: Concurrent tabs/sweep racing after runSlice completion can still double-invoke vision for the same job in a narrow window

**File:** `src/actions/tick-discovery.ts:86-97`, `src/app/api/discovery/sweep/route.ts:101-114`
**Issue:** The vision block is gated on a freshly-read `status === "done"`
check performed via a plain `SELECT ... .single()` with NO lock and no
"already vision-processed" guard — it is a plain check-then-act on a column
(`results`) that is not itself protected by the `claim_discovery_slice` CAS.
While a SECOND scrape claim on an already-`"done"` job is correctly blocked
by the RPC's `status in ('pending','processing')` filter, that filter only
protects the scrape/`runSlice` step. Nothing prevents two DIFFERENT ticks that
BOTH successfully claimed and ran the FINAL scrape slice in overlapping calls
(e.g. the client tab races the daily sweep resuming the same job in the same
window, or a retried/duplicated Server Action invocation client-side) from
both observing `status === "done"` immediately afterward and both calling
`runVisionForJob` — each running a full, un-coordinated `runVisionPass` over
the same `results` array. `runVisionPass`'s dedupe map is explicitly
documented and implemented as per-invocation-only (no cross-invocation cache),
so this doubles real Anthropic spend with no cap coordination between the two
concurrent passes (each tracks its own independent `runningVisionSek` against
the SAME `CAP_VISION_SEK_MAX`, so two concurrent invocations can each spend up
to the cap independently — up to 2x the intended ceiling for one job).
**Fix:** Make the vision pass idempotent/lockable — e.g. gate it behind an
atomic `UPDATE ... SET vision_started_at = now() WHERE id = $1 AND
vision_started_at IS NULL RETURNING id` claim (mirroring
`claim_discovery_slice`'s CAS pattern) before running `runVisionPass`, or
check per-candidate `vision !== null && visionSkippedReason === null` before
re-running vision on an already-processed candidate.

## Warnings

### WR-01: UI-SPEC-required 24px gap between the ranking grid and the vision section is actually 16px

**File:** `src/components/discovery-results.tsx:128, 168, 188`
**Issue:** 11-UI-SPEC.md (Component Inventory §1, Spacing table) locks a
**minimum `space-y-6` (24px)** gap between the deterministic
ranking/flags block and the vision section, explicitly calling this a
"REQUIRED minimum visual break reinforcing the structural-separation
constraint," not merely aesthetic. The code's own comment at line 180-186
claims this is honored ("spatially separate via `space-y-6`... on this
container"), but the `space-y-6` class is only applied to the vision
section's OWN wrapper `<div>` (line 188), which governs spacing BETWEEN each
`GalleryConditionVision` card inside that div — not the gap between the grid
and the vision section. The grid (line 168) and the vision wrapper (line 188)
are both direct children of the OUTER container at line 128
(`<div className="w-full max-w-4xl space-y-4">`), so the actual gap between
them is governed by that outer `space-y-4` (16px), not `space-y-6`. This
under-delivers the locked structural-separation visual requirement by 8px.
**Fix:** Either wrap the grid and the vision section in their own
`space-y-6` container, or add an explicit `mt-6` to the vision wrapper:
```tsx
<div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
  ...
</div>

<div className="mt-6 space-y-6">
  {ranked.map(({ candidate }, i) => (
    <GalleryConditionVision ... />
  ))}
</div>
```

### WR-02: `imageIndex` has no bounds validation — a hallucinated out-of-range citation silently passes the confidence/null filter

**File:** `src/lib/discovery/vision-schema.ts:48-52`, `src/lib/discovery/vision.ts:216-232`
**Issue:** `imageIndex` is declared as a bare `z.number()` with no
`.min()`/`.max()` (intentionally, to avoid the documented Anthropic
numeric-constraint 400 trap) and no post-parse validation is performed
against the actual sent image count (`capped.length`) before a claim is kept.
The only filter applied is `attr.claim !== null && attr.confidence >=
VISION_CONFIDENCE_THRESHOLD` (vision.ts:223-224) — a claim with a
non-null `claim`, high confidence, and an `imageIndex` of `0`, a negative
number, or a number larger than the number of images actually sent will
still be kept and persisted. The UI's `imageUrlsUsed[claim.imageIndex - 1]`
lookup (gallery-condition-vision.tsx:96) degrades gracefully to `undefined`
→ placeholder box, so this does not crash, but it silently violates the
documented "mandatory citation" contract (vision-schema.ts:37-39: "no uncited
claim can pass through this shape") — a claim with a citation that resolves
to nothing is functionally uncited while still being displayed as if cited.
**Fix:** Validate `imageIndex` against `capped.length` before keeping a
claim, dropping (not persisting) any claim whose `imageIndex` doesn't
resolve to a real sent image:
```ts
.filter(([, attr]) =>
  attr.claim !== null &&
  attr.confidence >= VISION_CONFIDENCE_THRESHOLD &&
  attr.imageIndex >= 1 &&
  attr.imageIndex <= capped.length,
)
```

### WR-03: `.bcdn.se` added to the image-host allowlist without the documented pinning discipline the rest of the file follows

**File:** `src/lib/booli/client.ts:197-209`
**Issue:** `isAllowedImageHost` allows `booli.se`, `*.booli.se`, AND
`*.bcdn.se`. The file's own doc comments repeatedly stress that Apollo shape
assumptions here are "GENUINELY UNVERIFIED" (client.ts:169-182) pending the
operator-run `scripts/probe-booli-images.ts`, and 11-RESEARCH.md's SSRF
discussion (line 614) and Assumption A1 (line 515) only ever reference
`booli.se`'s own CDN domain, never a distinct `bcdn.se` domain — there is no
probe finding or research citation pinning `bcdn.se` as a real, legitimate
Booli-owned host the way `LISTING_ENTITY_PREFIX = "Listing:"` is pinned via
`05-PROBE-FINDINGS.md`. Since this allowlist is the ONE place standing
between an Apollo-supplied URL and being included in the PII-safe persisted
`imageUrls` field (and subsequently sent to Anthropic's image fetcher),
adding an unverified extra host widens the SSRF surface speculatively ahead
of the live probe that is supposed to confirm the real shape.
**Fix:** Either cite the specific evidence for `bcdn.se` (a real Booli CDN
hostname confirmed some other way) in a doc comment, or remove it until the
deferred probe (`scripts/probe-booli-images.ts`) confirms the real image host
and update the allowlist to match exactly what the probe finds.

### WR-04: `runVisionForJob`'s `updateJob` failure is silently swallowed, leaving vision results computed-but-unpersisted with no signal to the caller

**File:** `src/lib/discovery/job.ts:203-210`, `src/lib/discovery/job.ts:71-80`
**Issue:** `runVisionForJob` calls `updateJob`, which only logs
(`console.error`) on a Supabase update error and does not throw or return a
success/failure indicator (`updateJob`'s return type is `Promise<void>`).
If the final `results: withVision` write fails (network blip, RLS/permission
drift, oversized payload), the vision spend has already been incurred
(Anthropic was billed for every candidate's Haiku/Sonnet calls inside
`runVisionPass`) but the results are never persisted — the job is left
`"done"` with NO vision data and no record that vision was even attempted,
and (per CR-02/CR-04) nothing will ever retry it, so the spend is a complete
loss with no observability beyond a server log line.
**Fix:** Have `updateJob` (or a vision-specific variant) surface failure to
the caller so `runVisionForJob` can at least log a distinguishable "vision
computed but not persisted, spend of X SEK lost" signal, and consider making
the write retryable independently of a fresh claim.

## Info

### IN-01: `estimatedSliceCostSek` / `runVisionForJob`'s vision estimate share no common naming convention despite both being pre-spend gates

**File:** `src/lib/discovery/job.ts:58-68`, `src/lib/discovery/vision.ts:320-329`
**Issue:** `job.ts`'s `estimatedSliceCostSek()` is a small, clearly-named,
reusable helper for the scrape pre-spend gate. The vision pre-spend gate
(CR-01) is an inline expression with no named helper, making it harder to
unit-test in isolation and easy to silently drift from the real cost model.
**Fix:** Once CR-01 is fixed with a real worst-case constant, extract it into
a named helper (e.g. `worstCaseVisionCallSek()`) in `cost.ts` alongside
`visionCostSek`/`CAP_VISION_SEK_MAX`, mirroring `estimatedSliceCostSek`'s
precedent.

---

_Reviewed: 2026-07-07T15:49:23Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
