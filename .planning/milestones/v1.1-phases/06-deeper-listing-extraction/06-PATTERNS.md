# Phase 6: Deeper Listing Extraction - Pattern Map

**Mapped:** 2026-07-06
**Files analyzed:** 9 (2 extended, 7 new)
**Analogs found:** 9 / 9

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `src/lib/booli/client.ts` (extend `reshapeListingEntity`) | transform/utility | CRUD (reshape) | itself, `resolveAreaId`/breadcrumb parsing (same file, lines 397-447) | exact (same file, same convention) |
| `src/lib/schemas/listing.ts` (extend `listingDataSchema`/`NormalizedListing`) | model/schema | transform | itself (existing nullable-field pattern) | exact |
| `src/lib/broker/url-guard.ts` (NEW) | utility/security-guard | request-response (pre-flight check) | `isBooliUrl` in `src/lib/booli/client.ts` (lines 235-245) | role-match (SSRF guard, different threat model — no fixed hostname) |
| `src/lib/broker/fetch-broker-page.ts` (NEW) | service | request-response / file-I/O (HTTP GET) | `fetchScbTable` in `src/lib/market/scb.ts` (lines 144-165) | exact (native `fetch`, try/catch → null, no Playwright) |
| `src/lib/broker/parse-broker-page.ts` (NEW) | transform/utility | transform (HTML → typed fields) | `reshapeListingEntity` / `dataPointsOf` in `src/lib/booli/client.ts` (lines 62-166) | role-match (null-tolerant field extraction, deterministic, no fabrication) |
| `src/lib/broker/merge-listing-fields.ts` (NEW) | transform/utility | transform (gap-fill merge) | `normalizeScraperOutput` in `src/lib/schemas/listing.ts` (lines 85-122) — specifically the `??` fallback-chain idiom | partial (no existing gap-fill-with-provenance function; closest is the `??` null-coalescing convention) |
| `src/actions/analyze.ts` (extend `analyzeUrl`) | controller (Server Action) | request-response | itself — the existing `fetchListing` try/catch block (lines 48-54) | exact (independent-degradation shape to invert, per Pattern 4) |
| `src/components/listing-summary.tsx` (extend `ListingSummary`) | component | request-response (SSR render) | itself — `MetricCard` (lines 11-32) + `brfName` conditional block (lines 52-58) | exact |
| `src/lib/broker/*.test.ts` (NEW, x4) | test | — | `src/lib/booli/client.test.ts` (mocking/fixture style) + `src/lib/market/sold-source.test.ts` (try/catch degradation test style) | role-match |

## Pattern Assignments

### `src/lib/booli/client.ts` — extend `reshapeListingEntity` (transform, CRUD-reshape)

**Analog:** same file, `reshapeListingEntity` (lines 123-166) + `resolveAreaId`'s breadcrumb-ladder parsing (lines 419-447) + the SSRF-doc-comment discipline at `isBooliUrl`.

**Existing floor/amenities/breadcrumb passthrough** (lines 151-165 — this is the field surfacing the plan should FINISH, per RESEARCH's Pattern 1):
```typescript
breadcrumbs: crumbs(entry.breadcrumbs) ?? undefined,
// Phase 6 note (05-PROBE-FINDINGS.md): the broker link is present as
// `listingUrl` (inline string), not the actor's `agencyListingUrl` key —
// surfaced under both names so either call site works.
listingUrl: str(entry.listingUrl) ?? undefined,
agencyListingUrl: str(entry.listingUrl) ?? undefined,
agencyName: agency?.name ?? undefined,
// Bonus structured fields the paid actor never returned (05-PROBE-FINDINGS.md
// "Bonus" section) — passed through so future call sites can read them
// without another Apollo-shape reshape.
floor: entry.floor ?? undefined,
amenities: entry.amenities ?? undefined,
```

**Null-tolerant coercion helpers to reuse verbatim** (lines 43-60 — do NOT reinvent; import/mirror these exact helper shapes for the new `amenityKeys`/`brfNameFromBreadcrumbs` functions):
```typescript
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const rawOf = (v: unknown): number | null =>
  v && typeof v === "object" && "raw" in v
    ? num((v as { raw: unknown }).raw)
    : null;
```

**Arg-keyed / ref-key strict-parse discipline to copy for the amenity ref key** (Pitfall 3 mandates parsing, not `.includes()` — mirror `argKeyedFieldOf`, lines 100-109):
```typescript
function argKeyedFieldOf(
  entry: Record<string, unknown>,
  prefix: string,
): unknown {
  const keys = Object.keys(entry)
    .filter((k) => k.startsWith(prefix))
    .sort();
  return keys.length > 0 ? entry[keys[0]] : undefined;
}
```
Apply the SAME "parse the structured key, don't substring-match" discipline to `Amenity:{"key":"balcony"}` — RESEARCH's own Code Examples section (`amenityKeys`/`brfNameFromBreadcrumbs`) is the concrete implementation to add near `reshapeListingEntity`, returning `floorValue`, `balcony: boolean`, `brfName: string | null` as new keys on the same reshaped object.

**Breadcrumb-ladder walking precedent** (lines 419-447, `resolveAreaId`) — same array (`entry.breadcrumbs`), same "look at `.url` for a matching pattern" idiom; the new `brfNameFromBreadcrumbs` walks the LAST entry's `.url` against `/bostadsrattsforening/` instead of `areaIds=(\d+)`. Do not introduce a second breadcrumb-parsing convention — follow this file's existing regex-on-`.url` style.

---

### `src/lib/schemas/listing.ts` — extend `listingDataSchema` / `NormalizedListing` (model, transform)

**Analog:** same file — additive nullable field convention already established for `brfName`/`buildYear`/`monthlyFee` (lines 46-56) and the coercion-based normalize function (lines 85-122).

**Existing additive-nullable field style to copy verbatim for the 5 new fields** (lines 46-56):
```typescript
monthlyFee: z.number().nullable(),
buildYear: z.number().nullable(),
brfName: z.string().nullable(),
prisPerKvm: z.number(),
latitude: z.number().nullable(),
longitude: z.number().nullable(),
booliId: z.string().nullable(),
breadcrumbs: z.array(breadcrumbSchema).nullable(),
```
Add `floor: z.number().nullable()`, `balcony: z.boolean().nullable()`, `renovationStatus: z.string().nullable()`, `description: z.string().nullable()` in this same idiom. Per CONTEXT.md's binding constraint, EVERY new field is `.nullable()` (server-side model) — the `.optional()` half of "`.nullable().optional()`" applies at the `scraperOutputSchema`/raw-input boundary (line 15-30's `z.object({...}).optional()` fields), not at the internal `listingDataSchema` boundary, matching how `brfName`/`buildYear` are already handled (nullable-only on the internal model, optional-and-nullable upstream).

**Provenance companion shape** — no existing analog for a `{value, source}` pair in this file; RESEARCH's Pattern 3 `Sourced<T>` interface is new code, but should live either here (co-located with the other schema types) or in `merge-listing-fields.ts` — prefer here since `ListingData`/`NormalizedListing` are the types `analyze.ts` and `listing-summary.tsx` both import.

**`normalizeScraperOutput`'s `??` fallback-chain idiom to reuse for gap-fill** (lines 108-121 — this IS the existing "prefer A, fall back to B" pattern already in the codebase, the direct ancestor of Phase 6's `fillGap`):
```typescript
address: str(raw.streetAddress),
price: num(raw.price) ?? rawOf(raw.listPrice),
livingArea: rawOf(raw.livingArea) ?? num(raw.livingArea),
```

---

### `src/lib/broker/url-guard.ts` (NEW) — utility/security-guard, request-response

**Analog:** `isBooliUrl` in `src/lib/booli/client.ts` (lines 226-245) — SAME general shape (parse via `new URL`, return boolean, throw-safe), but Pitfall 2 is explicit that Phase 6's threat model differs (no fixed target domain) — do not copy the hostname-allowlist body, only the defensive coding STYLE:

```typescript
// The exact-hostname-check style to imitate (not the domain logic itself):
export function isBooliUrl(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    return (
      protocol === "https:" &&
      (hostname === "booli.se" || hostname.endsWith(".booli.se"))
    );
  } catch {
    return false;
  }
}
```

New implementation must instead follow RESEARCH's own Code Examples `isSafeExternalUrl` (protocol allowlist + `dns.promises.lookup` + private/loopback/link-local range check) — this is new code, not adapted from an existing file, because no DNS-resolution-based guard exists anywhere in the codebase yet. Doc-comment discipline: mirror `isBooliUrl`'s comment style explaining WHY a naive check is insufficient (WR-03 precedent) so a future reader understands this is a DIFFERENT, harder guard, not a copy-paste oversight.

---

### `src/lib/broker/fetch-broker-page.ts` (NEW) — service, request-response/file-I/O

**Analog:** `fetchScbTable` in `src/lib/market/scb.ts` (lines 144-165) — closest existing "plain native `fetch`, no Playwright, try/catch → null" pattern in the codebase (the RESEARCH doc explicitly calls `scb.ts` the house pattern for non-Cloudflare third-party HTTP).

**Core pattern to copy** (lines 144-165):
```typescript
async function fetchScbTable(
  tablePath: string,
  body: ScbQueryBody,
): Promise<JsonStat2 | null> {
  try {
    const res = await fetch(`${SCB_BASE}/${tablePath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error("[scb]", `table ${tablePath} → HTTP ${res.status}`);
      return null;
    }
    const json: unknown = await res.json();
    const parsed = jsonStat2Schema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch (error) {
    console.error("[scb]", error);
    return null;
  }
}
```
Adapt: GET instead of POST, no body, call `isSafeExternalUrl` FIRST (before `fetch`), pass `redirect: "manual"` or reject on 3xx per Pitfall 2's DNS-rebinding mitigation, return `null` on any failure (never throw) so the caller in `analyze.ts` never needs its own extra try/catch layer beyond the outer one.

**Logging tag convention** — every module in this codebase prefixes `console.error` with a bracketed module tag: `[scb]`, `[booli-client]`, `[sold-source]`, `[analyze]`. Use `[broker]` for this module's logs.

---

### `src/lib/broker/parse-broker-page.ts` (NEW) — transform/utility

**Analog:** `dataPointsOf`/`reshapeListingEntity` in `src/lib/booli/client.ts` (lines 69-166) — the null-tolerant, allow-list-style field extraction discipline (never spread/passthrough the raw object; pick named fields one at a time).

**Core discipline to copy — explicit field-by-field extraction, no object-spread** (contrast with what NOT to do, Pitfall 4): `reshapeListingEntity` returns a curated object with named keys (`url`, `streetAddress`, `price`, ...) built field-by-field from `entry`, never `{...entry}`. Apply the identical discipline to JSON-LD/DOM parsing: build the return object as `{ description: extractDescription($), renovationStatus: extractRenovationStatus($) }` — never `{...parsedJsonLd}`.

**JSON-LD-first pattern** — new code (RESEARCH's own Code Examples `extractJsonLd` using `cheerio`); no existing analog since no HTML-parsing code exists in this codebase yet. Follow the try/catch-per-block pattern shown in RESEARCH (malformed JSON-LD is skipped, not thrown).

**PII exclusion test discipline** — mirror the existing test file's fixture-driven assertion style (see `client.test.ts` below) — add an explicit fixture containing `agent.name`/`agent.telephone` and assert it never appears in the return value (Pitfall 4's mandated regression test).

---

### `src/lib/broker/merge-listing-fields.ts` (NEW) — transform, gap-fill merge

**Analog:** `normalizeScraperOutput`'s `??` fallback-chain idiom (`src/lib/schemas/listing.ts` lines 108-121) — the closest existing "prefer source A, else source B" convention, though it does not currently track provenance.

**Pattern to implement** (from RESEARCH, Pattern 3 — write for the actual Phase 6 field set):
```typescript
interface Sourced<T> {
  value: T | null;
  source: "booli" | "maklare" | null;
}

function fillGap<T>(booliValue: T | null, brokerValue: T | null): Sourced<T> {
  if (booliValue !== null) return { value: booliValue, source: "booli" };
  if (brokerValue !== null) return { value: brokerValue, source: "maklare" };
  return { value: null, source: null };
}
```
This is genuinely new code (no existing provenance-tagged merge function in the codebase) — the `??`-chain in `normalizeScraperOutput` is the nearest ancestor idiom but does not tag source, so this file cannot be a "copy + adapt," only "copy the null-first-wins philosophy."

---

### `src/actions/analyze.ts` — extend `analyzeUrl` (controller, request-response)

**Analog:** itself — the EXISTING `fetchListing` try/catch (lines 48-54) shows the codebase's rethrow-on-failure shape; `fetchSoldComps` (`client.ts` lines 521-534) shows the SAME shape used by a different, currently-rethrowing caller. Per RESEARCH Pattern 4, Phase 6 must INVERT this into a non-rethrowing degradation.

**Existing rethrow-style try/catch to invert** (lines 48-54):
```typescript
let rawData: Record<string, unknown>;
try {
  rawData = await fetchListing(url);
} catch (error) {
  console.error("[analyze] fetchListing failed:", error);
  return { error: "Kunde inte hamta data fran Booli. Forsok igen." };
}
```

**New broker-fetch call site — inverted shape (never `return { error }`, always continue)**:
```typescript
let brokerFields: BrokerFields | null = null;
if (agencyListingUrl) {
  try {
    brokerFields = await fetchBrokerListingPage(agencyListingUrl);
  } catch (error) {
    console.error("[analyze] broker enrichment failed (non-fatal):", error);
    brokerFields = null;
  }
}
```
Insert this AFTER the existing `normalizeScraperOutput` call (line 73) and BEFORE `listingData` is assembled (line 95), merging via `mergeListingFields` before the `analyses.insert` call (lines 118-133) so the merged, provenance-tagged shape is what gets persisted to the JSONB `listing_data` column — no migration needed (CONTEXT.md constraint).

**Existing field-collection pattern to extend** (lines 60-73) — the destructuring-from-`normalizeScraperOutput` call is where `floor`/`balcony`/`brfName` (Apollo-derived, no network) get pulled in; this is a SEPARATE, unconditional step from the broker-fetch try/catch (Pitfall 1 — do not gate Apollo-derived fields on broker-fetch success).

---

### `src/components/listing-summary.tsx` — extend `ListingSummary` (component, SSR render)

**Analog:** itself — `MetricCard` (lines 11-32) for the 3 new metric-style fields (Våning/Balkong/Renoveringsstatus), and the `brfName` conditional block (lines 52-58) for provenance-caption styling precedent.

**`MetricCard` to reuse verbatim (no new component needed)** (lines 11-32):
```typescript
function MetricCard({
  label,
  value,
  isMissing,
}: {
  label: string;
  value: string;
  isMissing?: boolean;
}) {
  return (
    <div className="rounded-lg bg-warm-gray-50 p-4">
      <p className="text-xs font-medium uppercase tracking-wider text-warm-gray-500">
        {label}
      </p>
      {isMissing ? (
        <p className="mt-1 text-lg italic text-warm-gray-500">Ej tillganglig</p>
      ) : (
        <p className="mt-1 text-lg font-semibold text-warm-gray-900">{value}</p>
      )}
    </div>
  );
}
```
Per UI-SPEC's Copywriting Contract, this component needs a NEW optional `sourceCaption` prop (e.g. `"Källa: Booli"` / `"Källa: Mäklarens annons"`) rendered beneath the value only when not missing — extend `MetricCard`'s props, don't fork a second component.

**`brfName` slot conditional to copy the "populated vs unavailable" shape from** (lines 52-58):
```typescript
{data.brfName ? (
  <p className="text-warm-gray-500">{data.brfName}</p>
) : (
  !isMissing("brfName") || (
    <p className="italic text-warm-gray-500">BRF-namn ej tillgangligt</p>
  )
)}
```

**Provenance-caption source-label convention to copy from `report-flags.tsx`** (lines 132-140, the `Källa: {sourceLabel}` pattern UI-SPEC explicitly says to match exactly):
```typescript
<span className="text-xs text-warm-gray-500">
  Källa: {sourceLabel}
  ...
</span>
```

**Partial/soft-warning banner to copy for the new "broker-fetch-failed" banner** (lines 40-46 — same terracotta treatment UI-SPEC specifies):
```typescript
{partial && (
  <div className="rounded-t-xl bg-terracotta-50 px-6 py-3">
    <p className="text-sm text-terracotta-600">
      Vissa uppgifter kunde inte hamtas
    </p>
  </div>
)}
```
New banner copy differs ("Kunde inte hämta ytterligare uppgifter från mäklarens annons...") but the JSX/class shape is identical — likely a second, separate conditional block using the same `bg-terracotta-50`/`text-terracotta-600` classes, gated on a new `brokerFetchFailed` prop rather than `partial`.

**Description prose block** — no existing full-width-prose analog in `listing-summary.tsx` itself; UI-SPEC points to `ai-report-section.tsx`'s `leading-relaxed` usage for long-form text. Read that file if the plan needs the exact class string (not read this session — UI-SPEC already quotes `text-sm leading-relaxed text-warm-gray-700`, which is sufficient to implement without a further Read).

---

### `src/lib/broker/*.test.ts` (NEW) — test

**Analog for mocking/fixture style:** `src/lib/booli/client.test.ts` (lines 1-41) — `vi.mock` at module top, named fixture import, `describe`/`it` per-behavior blocks with docstring-style test names describing the EXACT contract under test (e.g. `"rejects a substring-bypass URL where 'booli.se/' appears in the path..."`).

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import listingDetailFixture from "@/lib/booli/__fixtures__/listing-detail.json";
```

**Analog for degradation-path testing:** the `fetchListing` SSRF-rejection tests (lines 62-80) — the same "assert the function rejects AND assert the guarded side-effect (`actorCall`/`scrapeBooli`) was never invoked" double-assertion style should be used for `url-guard.test.ts` and the broker-fetch-never-fails-primary-flow test in `analyze.test.ts` (assert `analyzeUrl` still returns `{ data, partial: false }` even when the broker fetch mock rejects).

## Shared Patterns

### Null-tolerant coercion helpers
**Source:** `src/lib/booli/client.ts` lines 43-60, mirrored in `src/lib/schemas/listing.ts` lines 88-105
**Apply to:** `client.ts`'s new Apollo-field extraction, `parse-broker-page.ts`'s field extraction, `merge-listing-fields.ts` — every new coercion should return `null`/`undefined` on any malformed input, never throw.

### Independent-degradation try/catch (never rethrow into the primary flow)
**Source:** `src/lib/booli/client.ts` `fetchSoldComps` (lines 521-534) — INVERTED per Pattern 4
**Apply to:** `src/lib/broker/fetch-broker-page.ts` (catch internally, return null) AND `src/actions/analyze.ts`'s new broker call site (catch, log, continue — never `return { error }`).
```typescript
try {
  const result = await walkFallbackTree(rungs);
  console.error(`[booli-client] fetchSoldComps served by rung ${result.rung} ...`);
  return { data: result.data, rendersUsed: result.rung };
} catch (error) {
  console.error("[sold-source]", error);
  throw new Error("Kunde inte hamta saljdata fran Booli. ...");
}
```
Phase 6's version must NOT `throw` at the outermost boundary (`analyzeUrl`) — only `fetch-broker-page.ts` internals may throw/reject; `analyze.ts`'s call site swallows it.

### SSRF guard discipline (real URL parsing, never substring match)
**Source:** `src/lib/booli/client.ts` `isBooliUrl` (lines 226-245), doc comment explicitly warns against `.includes()` bypasses (WR-03)
**Apply to:** `src/lib/broker/url-guard.ts` — same `new URL()`-parse-then-check discipline, extended with DNS-resolve + private-IP-range rejection per RESEARCH's Security Domain section (this file cannot copy the body, only the discipline/doc-comment style).

### Bracketed module-tag console logging
**Source:** `[scb]` (`scb.ts`), `[booli-client]` (`client.ts`), `[sold-source]` (`client.ts`/`sold-source.ts`), `[analyze]` (`analyze.ts`)
**Apply to:** all new broker files — use `[broker]` consistently (e.g. `console.error("[broker]", error)`).

### Additive `.nullable()` schema fields, curated field-by-field object construction (never object-spread)
**Source:** `src/lib/schemas/listing.ts` lines 46-56 (schema), `src/lib/booli/client.ts` `reshapeListingEntity` lines 128-166 (never `{...entry}`)
**Apply to:** `listing.ts`'s 4 new fields, `client.ts`'s Apollo-field extraction, `parse-broker-page.ts`'s extraction (critical for the PII-exclusion requirement — Pitfall 4).

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src/lib/broker/merge-listing-fields.ts` provenance-tagging shape (`Sourced<T>`/`fillGap`) | transform | transform | No existing function in the codebase tracks per-field data provenance (`booli` vs `maklare`); nearest idiom is the untagged `??` fallback chain in `normalizeScraperOutput` — genuinely new code per RESEARCH Pattern 3 |
| `src/lib/broker/parse-broker-page.ts` JSON-LD/DOM extraction internals (cheerio usage) | transform | transform (HTML parse) | No HTML-parsing code exists anywhere in the codebase today (cheerio is a new dependency) — RESEARCH's own Code Examples section is the only available pattern source, not a codebase analog |
| `src/lib/broker/url-guard.ts` DNS-resolve + private-IP-range check | utility/security-guard | request-response | No existing code performs `dns.lookup`-based IP classification; `isBooliUrl` is a hostname-only check (role-match, not implementation-match) — the DNS+IP-range logic itself must come from RESEARCH's OWASP-cited Code Examples |

## Metadata

**Analog search scope:** `src/lib/booli/`, `src/lib/market/`, `src/lib/schemas/`, `src/actions/`, `src/components/` (listing-summary.tsx, report-flags.tsx)
**Files scanned:** `client.ts`, `client.test.ts`, `listing.ts`, `analyze.ts`, `scb.ts`, `listing-summary.tsx`, `report-flags.tsx`, `listing-detail.json` fixture
**Pattern extraction date:** 2026-07-06
