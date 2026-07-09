---
phase: 06-deeper-listing-extraction
reviewed: 2026-07-06T19:13:19Z
depth: standard
files_reviewed: 11
files_reviewed_list:
  - src/lib/schemas/listing.ts
  - src/lib/booli/client.ts
  - src/lib/broker/url-guard.ts
  - src/lib/broker/fetch-broker-page.ts
  - src/lib/broker/parse-broker-page.ts
  - src/lib/broker/merge-listing-fields.ts
  - src/actions/analyze.ts
  - src/components/listing-summary.tsx
  - src/components/url-input.tsx
  - src/app/page.tsx
  - src/app/(app)/analysis/[id]/page.tsx
findings:
  critical: 2
  warning: 4
  info: 2
  total: 8
status: issues_found
---

# Phase 6: Code Review Report

**Reviewed:** 2026-07-06T19:13:19Z
**Depth:** standard
**Files Reviewed:** 11
**Status:** issues_found

## Summary

Reviewed the Phase 6 "deeper listing extraction" changes with focus on three security/correctness cores: the SSRF guard (`url-guard.ts`), the PII-exclusion discipline in the broker-page parser (`parse-broker-page.ts`), and the gap-fill-only merge (`merge-listing-fields.ts`), plus the independent-degradation try/catch in `analyze.ts`.

The PII-exclusion allow-list in `parse-broker-page.ts` is sound — it never object-spreads a JSON-LD blob and only ever reads `description`/`renovationStatus` by explicit named access, so mäklare name/phone/email genuinely cannot leak through this path. The gap-fill-only merge in `merge-listing-fields.ts` is also correct: `fillGap` really does treat a non-null Booli value as final and unconditionally locks out the broker value, and `floor`/`balcony`/`brfName` are wired with a hardcoded `null` broker argument so they can never resolve to `"maklare"` even by future accident (barring a direct edit to the call site). The independent-degradation try/catch in `analyze.ts` around the broker fetch is correctly shaped: any throw from `fetchBrokerListingPage` is caught, downgrades to `brokerFetchFailed = true`, and never produces a returned `{ error }`.

However, the SSRF guard has a real, exploitable gap: it resolves DNS itself to classify safety, then calls `fetch()` separately, which re-resolves DNS independently with no pinning — a classic TOCTOU/DNS-rebinding hole that the file's own doc comment claims to close but does not. The private-IPv4 range table is also incomplete (missing `0.0.0.0` and the `100.64.0.0/10` CGNAT block). Additionally, `analyze.ts` silently discards the Supabase insert error, which can result in an authenticated user's analysis being silently un-persisted while still rendering as if it had succeeded (falls through to the guest cookie path). A JSX rendering bug in `listing-summary.tsx` causes the "BRF-namn ej tillgängligt" fallback to never render on the persisted `/analysis/[id]` page.

## Critical Issues

### CR-01: DNS-rebinding TOCTOU gap in the SSRF guard — resolved IP is never pinned for the actual fetch

**File:** `src/lib/broker/url-guard.ts:58-75` (consumed by `src/lib/broker/fetch-broker-page.ts:19-28`)

**Issue:** `isSafeExternalUrl` calls `dns.lookup(parsed.hostname)` and classifies *that* resolved address. But `fetch-broker-page.ts` then calls plain `fetch(url, { redirect: "manual" })` with no custom `dispatcher`/`lookup` override and no pinned IP — Node's `undici` performs its own, independent DNS resolution for the actual TCP connection. An attacker who controls the DNS record for the broker-page hostname (a realistic threat model here, since `agencyListingUrl` originates from Booli-scraped third-party data, exactly the "Booli's own data pipeline is itself a potential attacker-influence vector" scenario the file's doc comment calls out) can:
1. Resolve the hostname to a public IP when `isSafeExternalUrl` performs its check (passes the guard).
2. Immediately re-point the DNS record (TTL=0/short TTL) to `127.0.0.1`, `169.254.169.254` (cloud metadata), or an internal service IP.
3. By the time `fetch()` independently re-resolves the same hostname microseconds later, it connects to the attacker's chosen internal target.

The doc comment on lines 21-28 explicitly frames this as "resolve-then-classify, not a pre-resolution string check" and cites OWASP SSRF guidance, but OWASP's guidance for this exact pattern requires **pinning the resolved IP for the actual outbound connection** (e.g., via a custom `dns.lookup`/`Agent` that forces the connection to the already-validated address, or connecting directly to the IP with a `Host` header / SNI override). This implementation resolves once for validation and a second, unrelated time for the real request — the two resolutions are not guaranteed to agree. The `redirect: "manual"` mitigation in `fetch-broker-page.ts` only stops HTTP-redirect-based SSRF; it does nothing for DNS-rebinding on the initial request.

**Fix:** Pin the validated IP for the actual fetch, e.g. using Node's `http`/`https` agent `lookup` option (or undici's `Agent` with a custom `connect`) to force the connection to the address that was just classified as safe, rather than letting `fetch` re-resolve independently:

```typescript
// url-guard.ts — return the validated address alongside the boolean so the
// caller can pin it.
export async function resolveSafeExternalUrl(
  url: string,
): Promise<{ address: string; family: 4 | 6 } | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  try {
    const { address, family } = await dns.lookup(parsed.hostname);
    if (family === 4 && isPrivateIPv4(address)) return null;
    if (family === 6 && (address === "::1" || address.startsWith("fe80:"))) return null;
    return { address, family: family as 4 | 6 };
  } catch {
    return null;
  }
}

// fetch-broker-page.ts — pin the connection to the validated address via a
// custom lookup so the real TCP connection cannot diverge from what was
// classified as safe.
import { Agent } from "undici";

const resolved = await resolveSafeExternalUrl(url);
if (!resolved) return null;
const agent = new Agent({
  connect: { lookup: (_hostname, _opts, cb) => cb(null, [{ address: resolved.address, family: resolved.family }]) },
});
const res = await fetch(url, { redirect: "manual", dispatcher: agent });
```

(Exact API depends on the Node/undici version in use — the essential requirement is that the address validated by `isSafeExternalUrl` is the same address the socket connects to.)

## Warnings

### WR-01: Private-IPv4 range table is missing `0.0.0.0` and the CGNAT `100.64.0.0/10` block

**File:** `src/lib/broker/url-guard.ts:35-41`

**Issue:** `PRIVATE_V4_RANGES` covers RFC1918 (10/8, 172.16/12, 192.168/16), loopback (127/8), and link-local (169.254/16), but omits:
- `0.0.0.0/8` — the "this network" / unspecified address; many systems treat `0.0.0.0` as equivalent to `127.0.0.1` for local services.
- `100.64.0.0/10` — RFC 6598 carrier-grade NAT space, frequently used inside cloud VPCs and container networks for internal service addressing (in some environments, indistinguishable from a private target).

Verified directly: `isPrivateIPv4("0.0.0.0")` and `isPrivateIPv4("100.64.0.1")` both return `false` today, meaning a broker hostname that resolves to either address would pass the guard as "safe."

**Fix:** Add both ranges to the table:
```typescript
const PRIVATE_V4_RANGES: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
];
```

### WR-02: `listingData.brfName` fallback message never renders on the persisted `/analysis/[id]` page

**File:** `src/components/listing-summary.tsx:107-111`; consumed without `missingFields` by `src/app/(app)/analysis/[id]/page.tsx:149-153`

**Issue:** The JSX:
```tsx
!isMissing("brfName") || (
  <p className="italic text-warm-gray-500">BRF-namn ej tillgangligt</p>
)
```
only renders the fallback paragraph when `isMissing("brfName")` is `true`. `isMissing` is driven entirely by the `missingFields` prop (`missingFields?.includes(field) ?? false`). On the fresh-analysis flow (`app/page.tsx` → `UrlInput`), `missingFields` is populated from the server action and this works. But `app/(app)/analysis/[id]/page.tsx` (the persisted-analysis page, reached after every authenticated save/redirect) calls `<ListingSummary data={listingData} partial={isPartial} brokerFetchFailed={...} />` **without ever passing `missingFields`**. On that page, `isMissing("brfName")` is always `false`, so `!false || (<p>...)` evaluates to the literal `true` — React renders nothing, and a listing with a genuinely null `brfName` shows a blank header area instead of "BRF-namn ej tillgängligt." This is the primary landing page for every authenticated user's analysis, so the fallback message is effectively dead for that entire flow.

**Fix:** Derive the missing-state from the actual data value, not a caller-supplied side channel that isn't consistently threaded through:
```tsx
{data.brfName ? (
  <>
    <p className="text-warm-gray-500">{data.brfName}</p>
    {brfNameCaption && <p className="mt-1 text-xs text-warm-gray-500">{brfNameCaption}</p>}
  </>
) : (
  <p className="italic text-warm-gray-500">BRF-namn ej tillgangligt</p>
)}
```

### WR-03: Supabase insert error silently discarded — authenticated analysis can appear to succeed while never being persisted

**File:** `src/actions/analyze.ts:206-220`

**Issue:**
```typescript
const { data: analysis } = await supabase
  .from("analyses")
  .insert({ user_id: user.id, url, listing_data: listingData as unknown as Record<string, unknown>, partial: isPartial })
  .select()
  .single();

if (analysis) {
  redirect(`/analysis/${analysis.id}`);
}
```
The `error` field from the Supabase response is never destructured or checked. If the insert fails for any reason (RLS policy rejection, a NOT NULL/constraint violation, a transient DB error), `analysis` is `null` and `redirect` is skipped. Execution falls through to the guest-flow code below (`cookieStore.set("guest_analysis_done", ...)` and `return { data: listingData, partial, ... }`), which:
1. Sets a guest cookie on an authenticated user's session for no reason.
2. Returns the freshly-fetched `listingData` to the client as if the action succeeded, with no error surfaced to the user and no server-side alert that the row was never saved.

The user believes their analysis was saved (they see the summary render) but it silently vanished — a data-loss bug with no user-visible or logged signal beyond whatever Supabase's client swallows.

**Fix:**
```typescript
const { data: analysis, error: insertError } = await supabase
  .from("analyses")
  .insert({ ... })
  .select()
  .single();

if (insertError || !analysis) {
  console.error("[analyze] failed to persist analysis:", insertError);
  return { error: "Kunde inte spara analysen. Forsok igen." };
}

redirect(`/analysis/${analysis.id}`);
```

### WR-04: `agencyListingUrl` extraction accepts any non-empty string, including javascript:/data: schemes, before the guard runs

**File:** `src/actions/analyze.ts:110-113`

**Issue:**
```typescript
const agencyListingUrl =
  typeof rawData.agencyListingUrl === "string" && rawData.agencyListingUrl.length > 0
    ? rawData.agencyListingUrl
    : null;
```
This is not itself exploitable today because `isSafeExternalUrl` correctly rejects non-http(s) protocols (`url-guard.ts:65`) before any fetch happens. However, the check here does no protocol/shape validation at all — it accepts any non-empty string, deferring 100% of validation to `fetchBrokerListingPage`. This is fine as long as every call site of `agencyListingUrl` routes through the guard (it currently does), but it's a fragile invariant: a future refactor that logs, displays, or otherwise uses `agencyListingUrl` before/without calling `fetchBrokerListingPage` (e.g., rendering it as a "visit broker listing" link in the UI) would have zero protocol validation. Given this value is explicitly documented as attacker-influenceable (Booli-sourced third-party data), it deserves validation at the point of extraction, not solely at the point of use.

**Fix:** At minimum, add a defensive comment noting the invariant, or validate the protocol at extraction time so the guarantee doesn't depend on every future call site remembering to route through `fetchBrokerListingPage`:
```typescript
const agencyListingUrl = (() => {
  const raw = rawData.agencyListingUrl;
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const { protocol } = new URL(raw);
    return protocol === "http:" || protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
})();
```

## Info

### IN-01: `client.ts` reshapes `entry.listingUrl` into both `listingUrl` and `agencyListingUrl` keys with no validation at the source

**File:** `src/lib/booli/client.ts:200-204`

**Issue:** `str(entry.listingUrl) ?? undefined` is a plain string coercion with no URL-shape check. This is consistent with the rest of the file's null-tolerant coercion style and is fine given downstream validation, but combined with WR-04 it means there are currently zero checkpoints between the raw Apollo entity and the eventual SSRF guard call other than "is it a non-empty string." Worth a comment cross-reference to `url-guard.ts` so a future reader doesn't assume any validation already happened here.

**Fix:** Add a one-line comment: `// No protocol/shape validation here — isSafeExternalUrl (url-guard.ts) is the sole enforcement point.`

### IN-02: `mergeListingFields`'s `BooliRecoverableFields`/`MergedListingFields` interfaces always pass a literal `null` for three of five fields, making the "gap fill" concept unreachable but not statically enforced

**File:** `src/lib/broker/merge-listing-fields.ts:65-76`

**Issue:** The doc comment (lines 61-64) correctly explains that `floor`/`balcony`/`brfName` can never resolve to `"maklare"` because the broker argument is hardcoded to `null` at the call site (`fillGap(booliFields.floor, null)`). This is correct today, but it's an invariant enforced by convention/comment only — nothing in the type system prevents a future edit from accidentally passing a real broker value for `floor` (e.g., if `BrokerFields` is ever extended to include `floor`). Since this is exactly the kind of "must never overwrite" contract the phase explicitly calls out as security/correctness-critical, it would benefit from a structural guarantee rather than a comment.

**Fix:** Consider making the unreachability explicit in the type signature, e.g. by not accepting a `BrokerFields` value for those three keys at all:
```typescript
export function mergeListingFields(
  booliFields: BooliRecoverableFields,
  brokerFields: Pick<BrokerFields, "renovationStatus" | "description"> | null,
): MergedListingFields {
  return {
    floor: { value: booliFields.floor, source: booliFields.floor !== null ? "booli" : null },
    balcony: { value: booliFields.balcony, source: booliFields.balcony !== null ? "booli" : null },
    brfName: { value: booliFields.brfName, source: booliFields.brfName !== null ? "booli" : null },
    renovationStatus: fillGap(booliFields.renovationStatus, brokerFields?.renovationStatus ?? null),
    description: fillGap(booliFields.description, brokerFields?.description ?? null),
  };
}
```
This makes it impossible for a future edit to accidentally thread a broker value into the three Apollo-only fields, since the type no longer has a slot for it.

---

_Reviewed: 2026-07-06T19:13:19Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
