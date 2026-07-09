---
phase: 06-deeper-listing-extraction
fixed_at: 2026-07-06T21:25:00Z
review_path: .planning/phases/06-deeper-listing-extraction/06-REVIEW.md
iteration: 1
findings_in_scope: 5
fixed: 5
skipped: 0
status: all_fixed
---

# Phase 6: Code Review Fix Report

**Fixed at:** 2026-07-06T21:25:00Z
**Source review:** .planning/phases/06-deeper-listing-extraction/06-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 5 (2 critical-tier + 3 warning; scope excludes IN-01/IN-02 per instruction)
- Fixed: 5
- Skipped: 0

Note: the review's frontmatter labels CR-01 as the sole "critical" finding (`critical: 2` in
frontmatter appears to be a documentation count mismatch — only one `### CR-` heading exists in
the body). All 4 Warning findings (WR-01 through WR-04) plus CR-01 were fixed; IN-01/IN-02 were
explicitly excluded from this pass per instruction and left untouched.

## Fixed Issues

### CR-01: DNS-rebinding TOCTOU gap in the SSRF guard — resolved IP is never pinned for the actual fetch

**Files modified:** `src/lib/broker/url-guard.ts`, `src/lib/broker/fetch-broker-page.ts`, `src/lib/broker/url-guard.test.ts`, `src/lib/broker/parse-broker-page.test.ts`, `src/lib/broker/fetch-broker-page.dns-pinning.test.ts` (new), `src/actions/analyze.ts` (comment only), `package.json`, `package-lock.json`
**Commit:** `db9666d`
**Applied fix:** Added `resolveSafeExternalUrl` to `url-guard.ts`, which resolves the hostname exactly once and returns the validated `{ address, family }` instead of a bare boolean (`isSafeExternalUrl` is now a thin boolean wrapper around it, preserving its existing contract for any other caller). `fetch-broker-page.ts` now uses `resolveSafeExternalUrl` and pins the actual outbound connection to that validated address via a per-request `undici.Agent` with a custom `connect.lookup` override, so `fetch()` can no longer independently re-resolve the hostname — the address validated by the guard is guaranteed to be the address the socket connects to. `redirect: "manual"` is retained unchanged (it mitigates a different vector — redirect-based SSRF — and remains necessary). `undici` was promoted from a transitive to a direct dependency (already locked at `7.27.2` via `apify-client`/`promptfoo`, so no version change) since the fix imports its `Agent` directly. Added a real end-to-end regression test (`fetch-broker-page.dns-pinning.test.ts`) using an RFC 2606 `.invalid` hostname (guaranteed to never resolve via real DNS) against a local HTTP server — the request only succeeds because the connection is pinned to the guard-validated address; confirmed this test fails against the pre-fix code (verified via `git stash`).

### WR-01: Private-IPv4 range table is missing `0.0.0.0` and the CGNAT `100.64.0.0/10` block

**Files modified:** `src/lib/broker/url-guard.ts`, `src/lib/broker/url-guard.test.ts`
**Commit:** `5813b04`
**Applied fix:** Added `["0.0.0.0", 8]` and `["100.64.0.0", 10]` to `PRIVATE_V4_RANGES`, matching the review's suggested fix exactly. Added regression tests proving both new ranges (including their exact boundaries: `100.64.0.0`–`100.127.255.255`) are now rejected, plus a boundary test proving addresses just outside the CGNAT range (`100.63.255.255`, `100.128.0.1`) still correctly pass.

### WR-02: `listingData.brfName` fallback message never renders on the persisted `/analysis/[id]` page

**Files modified:** `src/components/listing-summary.tsx`, `src/app/(app)/analysis/[id]/page.tsx`
**Commit:** `d6e4299`
**Applied fix:** Replaced the dead `!isMissing("brfName") || (<p>...</p>)` expression (which evaluated to a bare `true`, rendering nothing, whenever `missingFields` wasn't populated) with a fallback derived directly from `data.brfName`'s truthiness — matching the review's suggested fix. Additionally investigated why `missingFields` was never passed on the persisted page: it turns out `missingFields` is computed at analyze-time in `analyze.ts` but never persisted into the `listing_data` JSONB column, so the authenticated page cannot simply "thread it through" — it must be re-derived from the persisted row. Added that re-derivation to `src/app/(app)/analysis/[id]/page.tsx` using the same required-display-field rules `analyze.ts` uses (address/price/livingArea/rooms/monthlyFee/buildYear/brfName), and passed the result as `missingFields` to `ListingSummary`. No new test infrastructure exists for `.tsx` components in this project (no React Testing Library / jsdom environment configured in `vitest.config.ts`); verified via Tier 1 (re-read) + Tier 2 (tsc/eslint clean) instead, consistent with the project's existing test-coverage boundary.

### WR-03: Supabase insert error silently discarded — authenticated analysis can appear to succeed while never being persisted

**Files modified:** `src/actions/analyze.ts`, `src/actions/analyze.test.ts`
**Commit:** `c41bcc5`
**Applied fix:** Destructured `error: insertError` from the Supabase insert response and added an `if (insertError || !analysis)` check that returns `{ error: "Kunde inte spara analysen. Forsok igen." }` instead of falling through to the guest-cookie path, matching the review's suggested fix. Refactored the test file's static Supabase mock into a mutable-state mock (`mockUser`/`mockInsertResult`) so the previously guest-only test harness could also exercise the authenticated path. Added 3 new tests: insert failure surfaces the error and never calls `cookieStore.set` (proving no silent fall-through to the guest path), a defensive null-data-with-no-error case, and a successful-insert case that still redirects.

### WR-04: `agencyListingUrl` extraction accepts any non-empty string, including javascript:/data: schemes, before the guard runs

**Files modified:** `src/actions/analyze.ts`, `src/actions/analyze.test.ts`
**Commit:** `62c5a6c`
**Applied fix:** Replaced the plain non-empty-string check with an IIFE that parses the value as a `URL` and only accepts `http:`/`https:` protocols, matching the review's suggested fix. Added 2 new tests: a `javascript:` scheme is rejected at extraction (never reaches `fetchBrokerListingPage`), and a malformed URL string is likewise rejected at extraction.

## Skipped Issues

None — all 5 in-scope findings (CR-01, WR-01 through WR-04) were fixed. IN-01 and IN-02 were explicitly excluded from this pass per instruction and are untouched.

## Verification

- `npx vitest run` (full suite): **278 passed, 1 skipped, 6 todo** — 0 failures (up from the pre-fix baseline of 262 passed; all new tests are additions, no pre-existing test was weakened or removed).
- `npx tsc --noEmit`: **0 errors**, project-wide.
- `npx eslint .`: clean on every file touched by this fix pass. 4 pre-existing lint issues remain in files outside the fix scope (`evals/extractor.eval.ts`, `src/components/url-input.tsx`, `src/lib/market/sold-schema.ts`) — confirmed via `git stash`/re-run to predate this fix pass and unrelated to any of the 5 findings fixed here.

---

_Fixed: 2026-07-06T21:25:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
