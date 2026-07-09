---
phase: 05-owned-booli-acquisition
reviewed: 2026-07-06T00:00:00Z
depth: standard
files_reviewed: 12
files_reviewed_list:
  - src/lib/booli/client.ts
  - src/lib/booli/transport.ts
  - src/lib/booli/page-functions.ts
  - src/lib/booli/fallback-tree.ts
  - src/lib/booli/__mocks__/apify-client.ts
  - src/lib/market/sold-source.ts
  - src/actions/analyze.ts
  - scripts/booli-listing-probe.ts
  - src/lib/booli/client.test.ts
  - src/lib/booli/fallback-tree.test.ts
  - src/lib/schemas/listing.test.ts
  - src/actions/enrich-market-context.ts
findings:
  critical: 0
  warning: 4
  info: 4
  total: 8
status: resolved
fixed_at: 2026-07-06T18:40:00Z
fix_summary:
  fixed: 5
  skipped: 0
  requires_human_verification: 1
---

# Phase 5: Code Review Report — Owned Booli Acquisition

**Reviewed:** 2026-07-06
**Depth:** standard
**Files Reviewed:** 12 (10 in the stated scope + `enrich-market-context.ts` + `booli-scraper.ts` pulled in for cross-file verification of the `fetchSoldComps` call site)
**Status:** resolved — all 4 Warning findings + the optional IN-04 fixed (see Resolution below). `npx tsc --noEmit` clean; `npx vitest run` 208 passed | 1 skipped | 6 todo (up from the 198-passing baseline, +10 new tests, zero regressions).

## Summary

The core transport/fallback-tree/reshape design is sound and the "verbatim absorption" claim for `resolveAreaId`/`buildSlutpriserUrl`/the page function holds up byte-for-byte against the pre-migration `sold-source.ts` (diffed directly against `git show b961aab:src/lib/market/sold-source.ts`). Secret handling (`APIFY_API_TOKEN`) is clean everywhere checked — no log statement, test mock, or probe script touches or stringifies the token or the `ApifyClient` instance. `tsc --noEmit` and the full `booli`/`sold-source`/`listing` test suite (29 tests) pass.

However, two real behavioral defects survived the migration:

1. **`fetchAreaListings`'s HIGH-1 discipline is broken by its own building block.** `extractListingEntities` throws on zero entities, but no caller-level logic exists to let a genuinely-empty (but successfully rendered) area return `[]` instead of being folded into "source failed" — directly contradicting the function's own doc comment, which claims this distinction is "handled by walkFallbackTree/caller-level checks" elsewhere. It isn't. (Currently latent — `fetchAreaListings` has no production call site yet — but it is fully implemented and tested as if correct.)

2. **`fetchSoldComps`'s absorption into the shared fallback tree silently doubles potential billing without the caller's cost ledger knowing.** The pre-migration `fetchSoldComps` made exactly one Apify actor call per invocation, which is what `enrich-market-context.ts`'s `walkSoldTiers` render-counting (and therefore `soldSourceCostSek`/`SOLD_SOURCE_COST_CAP_SEK`) was written against. Post-migration, each `fetchSoldComps` call can now internally burn up to 2 real Apify renders (own-playwright + own-playwright-retry) while `client.ts` discards the `rung`/`health` info before returning, so the caller still only counts 1. This directly contradicts the WR-02 invariant documented in `enrich-market-context.ts` itself ("under-reporting cost to 0 corrupts the ledger").

Additionally, the SSRF allowlist this phase relies on (and elevates to an explicit named security control, T-05-10) is a naive substring check that is bypassable, and the newly-absorbed `fetchSoldComps` has zero test coverage after the migration (only the pure `resolveAreaId` helper is tested).

## Warnings

### WR-01: `fetchAreaListings` cannot distinguish a genuinely-empty area from a dead source, contradicting its own documented invariant

**File:** `src/lib/booli/client.ts:201-215`, `306-330`
**Issue:** `extractListingEntities` throws `"Inga Listing-poster hittades i Booli-sidan"` whenever zero `Listing:` entities are found in a *successful* render (line 211-213). Its doc comment (lines 204-207) asserts: "a dead render must be distinguishable from a genuinely-empty area (which `walkFallbackTree`/caller-level checks handle, not this function inventing a silent `[]`)". But neither `walkFallbackTree` (`fallback-tree.ts:42-63`) nor `fetchAreaListings` (`client.ts:306-330`) contains any logic that treats "render succeeded, zero listings" differently from "render failed." Both paths throw inside the rung's `attempt()`, get caught and logged identically by `walkFallbackTree`, and — once both rungs are exhausted — surface as the generic `"Alla Booli-kallor misslyckades: ..."` error. A real area with zero active listings (e.g., a brand-new/tiny areaId) will therefore incorrectly report "source failed" to any future caller instead of "no listings in this area."
**Fix:** Either (a) have `runPlaywrightRender`/`extractListingEntities` return a tri-state (render-failed vs. render-ok-zero-entities) that `fetchAreaListings` can special-case before invoking `walkFallbackTree` a second time, or (b) drop the throw-on-zero behavior for the *area* extractor specifically and let `fetchAreaListings` return `[]` for a confirmed-successful render, reserving the throw for `runPlaywrightRender`'s own `hasApollo`/empty-dataset checks (which already own the "dead source" signal). At minimum, update the doc comment to stop claiming a distinction that does not exist, or add the missing distinguishing logic — currently the comment and the code disagree.
```typescript
// Example fix sketch: extractListingEntities stops throwing on empty;
// runPlaywrightRender already throws for a genuinely dead render (empty
// dataset / hasApollo=false), so a render that SUCCEEDED with zero Listing:
// entities is a real empty-area result, not a dead source.
function extractListingEntities(items: unknown[]): Record<string, unknown>[] {
  return collectListingEntities(items).map(reshapeListingEntity);
}
```

### WR-02: `fetchSoldComps` absorption can silently double real Apify spend without the cost ledger seeing it

**File:** `src/lib/booli/client.ts:452-490`, `src/actions/enrich-market-context.ts:178-213, 424`
**Issue:** Before this phase, `fetchSoldComps` in `sold-source.ts` made exactly one `client.actor().call()` per invocation — this is the assumption `walkSoldTiers` bakes in via `renders += 1` per tier attempt (`enrich-market-context.ts:189`), which then feeds `soldSourceCostSek({ renders })` and the `SOLD_SOURCE_COST_CAP_SEK` persistence gate. After the Phase 5 absorption, `fetchSoldComps` now runs through `walkFallbackTree` with two own-render rungs (`client.ts:465-474`); a degraded tier consumes 2 real Apify actor calls, not 1, but `fetchSoldComps` returns only `result.data` (`client.ts:482`) — the `rung`/`health` fields that would reveal this are discarded before the caller ever sees them. `walkSoldTiers` therefore continues to record only 1 render per tier regardless of how many the shared transport actually burned, meaning `market_cost_sek` can under-report real spend by up to 2x per tier (up to 6 real renders across 3 tiers, recorded as 3). `enrich-market-context.ts`'s own doc comment for the `SoldWalkError` class calls this exact failure mode out by name: "each Apify render is billed regardless of failure; under-reporting cost to 0 corrupts the ledger" (line 152-153) — the phase reintroduces a milder version of the same class of bug for the success/degraded path.
**Fix:** Have `fetchSoldComps` (or a thin wrapper around it) surface the actual render count consumed — e.g., change its return type to include `{ data: unknown[]; rendersUsed: number }`, or expose `FallbackResult`'s `rung` directly — and have `walkSoldTiers` sum the real count instead of assuming 1 per tier.
```typescript
// client.ts
export async function fetchSoldComps(
  query: SoldSourceQuery,
): Promise<{ data: unknown[]; rendersUsed: number }> {
  // ...
  const result = await walkFallbackTree(rungs);
  return { data: result.data, rendersUsed: result.rung };
}

// enrich-market-context.ts
const { data: raw, rendersUsed } = await fetchSoldComps({ ...base, tier });
renders += rendersUsed; // instead of a flat += 1
```

### WR-03: SSRF allowlist on `fetchListing` is a naive substring check, bypassable by URL construction

**File:** `src/lib/booli/client.ts:242-244`, `src/actions/analyze.ts:23`
**Issue:** Both the pre-existing `analyze.ts` check and the newly-added, explicitly-named "SSRF allowlist (T-05-10)" in `fetchListing` use `url.includes("booli.se/")`. This is not a hostname check — it matches anywhere in the string, including query strings and paths on an attacker-controlled host: `https://evil.example/?x=booli.se/` and `https://evil.example/booli.se/anything` both satisfy `.includes("booli.se/")` and would be sent straight into `startUrls` for the Apify actor (or to `scrapeBooli`, which has no domain check of its own — see `src/lib/apify/booli-scraper.ts:11-14`). This phase promotes the check to an explicit, named security control (the doc comment literally calls it "SSRF allowlist") while keeping the same flawed implementation, so it is now something a reviewer/consumer is likely to trust as a real allowlist.
**Fix:** Parse the URL and check the hostname exactly (with an explicit subdomain allowance if needed), not a substring:
```typescript
function isBooliUrl(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    return (
      protocol === "https:" &&
      (hostname === "booli.se" || hostname === "www.booli.se")
    );
  } catch {
    return false;
  }
}
// fetchListing:
if (!isBooliUrl(url)) {
  throw new Error("Ange en giltig Booli-lank");
}
```

### WR-04: `fetchSoldComps` has zero test coverage after being absorbed into `client.ts`

**File:** `src/lib/booli/client.ts:452-490`, `src/lib/booli/client.test.ts`, `src/lib/market/sold-source.test.ts`
**Issue:** `client.test.ts` (the new shared-mock-based test file) covers `fetchListing` and `fetchAreaListings` thoroughly (rung fallthrough, SSRF rejection, entity extraction, dedup of non-`Listing:` entities). It does not contain a single test for `fetchSoldComps`. `sold-source.test.ts` (unchanged by this phase) only ever tested the pure `resolveAreaId` helper — it never exercised the actor-call path even before the migration. The phase's stated goal (PRICE-01 success criterion 4 — "verbatim... no-op migration") for the one actually-wired-into-production function (`enrichMarketContext` → `fetchSoldComps`) is therefore asserted only by code comment, not by any test, despite the transport underneath it having materially changed (inline actor call → shared `runPlaywrightRender` + `walkFallbackTree`, i.e. exactly the change WR-02 above shows has a real behavioral consequence).
**Fix:** Add a `fetchSoldComps`-specific suite to `client.test.ts` using the existing `apifyClientMockFactory`, at minimum covering: areaId resolution → actor call happens with the right URL, rung 1 → rung 2 fallthrough (mirrors the `fetchListing`/`fetchAreaListings` tests already present), and the HIGH-1 throw on an unresolved areaId / both-rungs-fail path.

## Info

### IN-01: `fetchAreaListings` is fully implemented, tested, and exported but has zero production call sites

**File:** `src/lib/booli/client.ts:306-330`
**Issue:** `grep` across `src/` shows `fetchAreaListings` is imported only by `client.test.ts`; no server action or route calls it. This is presumably intentional groundwork for a future phase, but combined with WR-01 it means the latent area-search-empty-result bug will not be caught by any real traffic until a caller is wired up — at which point it will look like a regression in whichever phase adds the caller, rather than a pre-existing gap from Phase 5.
**Fix:** No action required now; flag in the phase handoff / next-phase plan that `fetchAreaListings`'s HIGH-1 distinction (WR-01) must be fixed before a caller is added, not discovered after.

### IN-02: Duplicate, independently-maintained `Breadcrumb` type definitions

**File:** `src/lib/booli/client.ts:345-348`, `src/lib/schemas/listing.ts:35-38, 61`
**Issue:** `client.ts` defines its own `export interface Breadcrumb { label?: string; url?: string }`, structurally identical (today) to `listing.ts`'s zod-inferred `export type Breadcrumb = z.infer<typeof breadcrumbSchema>`. They happen to line up now, but nothing enforces that — a future field added to one (e.g., an `areaId` field) won't propagate to the other, and callers importing `Breadcrumb` from `@/lib/market/sold-source` (re-exported from `client.ts`) get a structurally-different type object than callers importing from `@/lib/schemas/listing`, even though both represent "the same breadcrumb."
**Fix:** Have `client.ts` import and reuse `Breadcrumb` from `@/lib/schemas/listing` instead of redeclaring it, or explicitly document why the duplication is intentional (e.g., to avoid a schemas→booli dependency direction) if that's the actual constraint.

### IN-03: `displayDataPoints` and several "bonus" fields are computed on every reshape but have no current consumer

**File:** `src/lib/booli/client.ts:158-165`
**Issue:** `reshapeListingEntity` always computes `dataPointsOf(entry)` (a non-trivial multi-key merge/sort) and attaches `floor`/`amenities`/`displayDataPoints` to the returned object. `normalizeScraperOutput` (`listing.ts`) does not read any of these three fields, and no test in `client.test.ts` beyond the dedicated "multi-variant" test exercises them meaningfully. This is explicitly called out as forward-looking ("Bonus... passed through so future call sites can read them"), which is a reasonable choice, but it means this code path is currently dead weight from the consumer's perspective and its correctness (e.g., the variant-merge ordering) is unverified against any real downstream use.
**Fix:** No change required now; when a Phase 6+ consumer starts reading `floor`/`amenities`/`displayDataPoints`, add a schema-level test asserting the shape those call sites actually need — the current test only asserts internal ordering, not fitness for an unknown future consumer.

### IN-04: `walkFallbackTree`'s `rung` cast silently mis-labels a 4th+ rung instead of failing loudly

**File:** `src/lib/booli/fallback-tree.ts:52`
**Issue:** `rung: (i + 1) as 1 | 2 | 3` is a type assertion, not a runtime check. If any future caller passes a 4-element `rungs` array (nothing in the type signature prevents it — `Array<{...}>` has no length constraint), a rung-4 success would be reported as `rung: 4` at runtime while the type system still claims `1 | 2 | 3`, silently violating the type contract for any downstream code that pattern-matches on `rung`.
**Fix:** Either constrain the input type to a tuple of at most 3 rungs (`[RungA] | [RungA, RungB] | [RungA, RungB, RungC]`), or clamp/assert at runtime, e.g. `if (rungs.length > 3) throw new Error("walkFallbackTree supports at most 3 rungs")` at the top of the function.

## Resolution

All 4 Warning findings and the optional IN-04 were fixed and committed atomically. IN-01, IN-02, IN-03 were left as-is per scope (no action required now, per their own Fix guidance).

### WR-03: fixed
**Commit:** `2a4c3d6`
Replaced the substring `url.includes("booli.se/")` check with `isBooliUrl()` (exported from `client.ts`) — parses via `new URL(url)`, requires `protocol === "https:"` and `hostname === "booli.se" || hostname.endsWith(".booli.se")`, rejects on parse failure. Applied to both `fetchListing` (client.ts) and `analyze.ts`'s pre-check. Added regression tests for the path-substring bypass (`https://evil.example/booli.se/x`), the query-substring bypass (`https://evil.example/?x=booli.se/`), a malformed-URL input, and the positive `www.booli.se` case.

### WR-02: fixed — requires human verification
**Commit:** `be8e9f0`
`fetchSoldComps` now returns `{ data: unknown[]; rendersUsed: number }` instead of discarding the fallback tree's `rung`. `walkSoldTiers` (`enrich-market-context.ts`) sums the real `rendersUsed` per tier (1 on the happy rung-1 path, up to 2 on degraded fallthrough, and a conservative 2 on a tier that failed entirely — both own-render rungs necessarily ran) instead of assuming a flat 1-per-tier. The tier-attempt loop bound (`MAX_SOURCE_CALLS`) is now tracked by a separate `tiersAttempted` counter so the ≤3-tiers-attempted invariant is unchanged from before.
Flagged **requires human verification**: this is a cost-accounting logic change with no direct unit test on `walkSoldTiers` itself (it is a private, unexported function, and `enrich-market-context.ts` has no existing test file — the module's few sibling action tests are `.todo`-only pending full Supabase-mocked integration tests). `tsc`/`vitest` confirm no syntax/type regressions and the new `fetchSoldComps` contract is covered (WR-04), but the render-summation arithmetic inside `walkSoldTiers` itself is unverified by an automated assertion. Recommend a follow-up test (mocking `fetchSoldComps`) asserting `market_cost_sek` reflects a summed, not flat, render count across degraded tiers before this ships.

### WR-01: fixed
**Commit:** `3f5fbce`
`extractListingEntities` no longer throws on zero `Listing:` entities — it returns `[]`. `runPlaywrightRender` already owns the dead-source signal (throws on non-SUCCEEDED status, empty dataset, or all-items-`hasApollo=false`), so a render that reaches `extractListingEntities` has already succeeded; zero entities there is a genuine empty-area result. Updated `fetchAreaListings`'s doc comment to state the now-implemented distinction. Added a regression test asserting `[]` on a successful-but-empty render with no unnecessary rung-2 fallthrough (`actorCall` called exactly once).

### WR-04: fixed
**Commit:** `a870ce3`
Added a `fetchSoldComps` describe block to `client.test.ts` using the shared `apifyClientMockFactory`: areaId resolution → the actor is called with the matching `slutpriser` URL + `rendersUsed: 1` on the happy path; rung-1→rung-2 fallthrough asserting `rendersUsed: 2` (directly exercises the WR-02 fix); the HIGH-1 throw on an unresolved areaId (actor never called); and the HIGH-1 throw once both own-render rungs are exhausted.

### IN-04 (optional): fixed
**Commit:** `73c7448`
Added a runtime guard (`if (rungs.length > 3) throw ...`) in `walkFallbackTree` before the `rung: (i + 1) as 1 | 2 | 3` cast is ever reached, so a future 4+-rung array fails loudly instead of silently mis-labeling `rung` at runtime. Added a regression test asserting the throw and that no rung's `attempt()` is invoked.

**Verification:** `npx tsc --noEmit` — 0 errors. `npx vitest run` — 208 passed | 1 skipped | 6 todo (baseline was 198 passed | 1 skipped | 6 todo; +10 new tests, 0 regressions). PRICE-01's byte-identical Swedish user-facing error messages and `sold-source.ts` re-export shim are unchanged.

---

_Reviewed: 2026-07-06_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
_Fixed: 2026-07-06_
_Fixer: Claude (gsd-code-fixer)_
