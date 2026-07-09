# Phase 5: Owned Booli Acquisition - Pattern Map

**Mapped:** 2026-07-06
**Files analyzed:** 8 (5 new, 3 modified)
**Analogs found:** 6 / 8 (2 net-new with no analog — flagged, not blocking)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `src/lib/booli/transport.ts` (new) | service | request-response (external actor call) | `src/lib/market/sold-source.ts` (actor-call block, lines 172-227) | exact |
| `src/lib/booli/page-functions.ts` (new) | utility | transform (string template) | `src/lib/market/sold-source.ts` (`PAGE_FUNCTION`, lines 128-141) | exact |
| `src/lib/booli/fallback-tree.ts` (new) | service | event-driven (rung retry/fallback) | none in codebase — pattern is prescribed verbatim in RESEARCH.md Pattern 3 | no analog (spec provided) |
| `src/lib/booli/client.ts` (new) | service | CRUD (fetch + normalize) | `src/lib/market/sold-source.ts` (whole file, esp. `fetchSoldComps`, lines 159-228) + `src/lib/market/sold-schema.ts` (`normalizeSoldOutput`, lines 202-252) | exact |
| `src/lib/apify/booli-scraper.ts` (modified — becomes rung-3 wrapper, called from client.ts) | service | request-response | itself (unchanged internals; only call-site relationship changes) | exact |
| `src/lib/market/sold-source.ts` (modified — thin re-export or absorbed into client.ts) | service | CRUD | itself | exact |
| `src/lib/schemas/listing.ts` (unchanged; regression test added) | model/schema | transform | `src/lib/market/sold-schema.ts` (schema + coercion-helper style) | exact |
| `src/actions/analyze.ts` (modified — swap `scrapeBooli` import for `fetchListing`) | controller (server action) | request-response | itself (minimal diff — see Pattern Assignments) | exact |
| `src/lib/booli/client.test.ts` (new) | test | request-response (mocked) | **none** — no existing test mocks `ApifyClient.actor().call()` anywhere; `sold-source.test.ts` only tests the pure `resolveAreaId()` helper | no analog (net-new, see below) |
| `src/lib/booli/fallback-tree.test.ts` (new) | test | event-driven (pure function) | `src/actions/generate-report.test.ts` (`vi.mock` + chainable-fake style, lines 17-21) — style analog only, not a data-flow analog | partial (style only) |
| `src/lib/schemas/listing.test.ts` (new) | test | transform | `src/lib/market/sold-source.test.ts` (whole file — plain describe/it/expect, fixture-driven, no mocks needed) | exact |

## Pattern Assignments

### `src/lib/booli/transport.ts` (service, request-response)

**Analog:** `src/lib/market/sold-source.ts` lines 34-39, 172-227

**Imports pattern** (lines 1-1):
```typescript
import { ApifyClient } from "apify-client";
```

**Client init pattern** (lines 34-39):
```typescript
const client = new ApifyClient({
  token: process.env.APIFY_API_TOKEN!,
});

const PLAYWRIGHT_SCRAPER_ACTOR = "apify/playwright-scraper";
```

**Core actor-call pattern** (lines 172-197) — copy verbatim, parameterize `url` and `pageFunction`:
```typescript
const run = await client.actor(PLAYWRIGHT_SCRAPER_ACTOR).call(
  {
    startUrls: [{ url }],
    launcher: "chromium",
    proxyConfiguration: {
      useApifyProxy: true,
      apifyProxyGroups: ["RESIDENTIAL"],
      apifyProxyCountry: "SE",
    },
    maxRequestRetries: 3, // do NOT reduce — sold-source.ts comment documents a single-retry false-negative
    maxPagesPerCrawl: 1,
    pageFunction,
  },
  { waitSecs: 240 }, // cold-start headroom, proven in both sold-source.ts and booli-scraper.ts
);
```

**Throw-not-empty error handling pattern** (lines 199-227) — copy verbatim, this is HIGH-1 discipline and must carry forward unchanged:
```typescript
if (run.status !== "SUCCEEDED") {
  throw new Error(`Booli-kallan blev inte klar i tid (status: ${run.status})`);
}
const { items } = await client.dataset(run.defaultDatasetId).listItems();
if (!items.length) {
  throw new Error("Inga resultat fran Booli-kallan");
}
const usable = items.filter(
  (it) => (it as { hasApollo?: boolean }).hasApollo !== false,
);
if (!usable.length) {
  throw new Error("Sold-kallan returnerade ingen Apollo-data (hasApollo=false)");
}
return usable;
```
Note the outer `try/catch` in `sold-source.ts` (lines 172-227) logs the real error via `console.error("[sold-source]", error)` then re-throws a Swedish user-facing message — mirror this exactly with a `[booli-client]` or `[booli-transport]` log prefix, never leak the raw error.

---

### `src/lib/booli/page-functions.ts` (utility, transform)

**Analog:** `src/lib/market/sold-source.ts` lines 121-141

**Core pattern** — copy the extraction body verbatim; RESEARCH.md confirms this SAME string works unmodified for listing-detail and area-search pages (only `startUrls` differ, do not write three variants):
```typescript
const PAGE_FUNCTION = `async function pageFunction(context) {
  const { page } = context;
  const apollo = await page.evaluate(() => {
    const el = document.getElementById("__NEXT_DATA__");
    if (!el || !el.textContent) return null;
    try {
      const data = JSON.parse(el.textContent);
      return data?.props?.pageProps?.__APOLLO_STATE__ ?? null;
    } catch {
      return null;
    }
  });
  return { hasApollo: apollo !== null, __APOLLO_STATE__: apollo };
}`;
```

---

### `src/lib/booli/fallback-tree.ts` (service, event-driven)

**No codebase analog exists.** RESEARCH.md Pattern 3 (lines 189-224) is the closest thing to a spec and should be implemented near-verbatim — it was authored specifically for this phase and already encodes the "never throw until every rung exhausted" discipline that mirrors `sold-source.ts`'s HIGH-1 throw-not-empty philosophy at a higher level:
```typescript
export interface FallbackResult<T> {
  data: T;
  source: "own-playwright" | "own-playwright-retry" | "paid-actor";
  rung: 1 | 2 | 3;
  health: "ok" | "degraded";
}

export async function walkFallbackTree<T>(
  rungs: Array<{ source: FallbackResult<T>["source"]; attempt: () => Promise<T> }>,
): Promise<FallbackResult<T>> {
  let lastError: unknown;
  for (let i = 0; i < rungs.length; i++) {
    try {
      const data = await rungs[i].attempt();
      return {
        data,
        source: rungs[i].source,
        rung: (i + 1) as 1 | 2 | 3,
        health: i === 0 ? "ok" : "degraded",
      };
    } catch (error) {
      console.error(`[booli-client] rung ${i + 1} (${rungs[i].source}) failed`, error);
      lastError = error;
    }
  }
  throw new Error(
    `Alla Booli-kallor misslyckades: ${lastError instanceof Error ? lastError.message : "okant fel"}`,
  );
}
```
Error-logging style (`console.error("[prefix]", error)`, never log the token/full client config) matches `sold-source.ts`/`booli-scraper.ts` convention exactly — reuse the `[booli-client]` prefix consistently across `client.ts`, `transport.ts`, and `fallback-tree.ts`.

---

### `src/lib/booli/client.ts` (service, CRUD)

**Analogs:** `src/lib/market/sold-source.ts` (whole-file structure) + `src/lib/market/sold-schema.ts` (`normalizeSoldOutput`, lines 202-252, and `dataPointsOf`, lines 170-188)

**Imports pattern** — mirror `sold-source.ts` line 1 plus internal imports for the new sibling modules:
```typescript
import { ApifyClient } from "apify-client";
import { runPlaywrightRender } from "./transport";
import { PAGE_FUNCTION } from "./page-functions";
import { walkFallbackTree } from "./fallback-tree";
```

**Apollo entity-walk pattern to generalize** (`sold-schema.ts` lines 220-250) — the `SoldProperty:` prefix scan generalizes directly to `Listing:` (prefix TBD-confirmed by the narrow-confirmation probe per RESEARCH.md, likely `Listing:<booliId>`):
```typescript
for (const [key, value] of Object.entries(state)) {
  if (!key.startsWith("SoldProperty:")) continue; // generalize to "Listing:" prefix
  if (!value || typeof value !== "object") continue;
  const entry = value as Record<string, unknown>;
  // field extraction here
}
```

**Non-deterministic `displayAttributes` variant selection to reuse verbatim** (`sold-schema.ts` lines 170-188) — the sort + SERP-preference + merge pattern already fixed a real bug (WR-05); reuse it for the `Listing:` entity if it carries the same multi-variant `displayAttributes` shape rather than rediscovering the bug:
```typescript
function dataPointsOf(entry: Record<string, unknown>): DataPoint[] {
  const attrKeys = Object.keys(entry)
    .filter((k) => k.startsWith("displayAttributes"))
    .sort();
  if (attrKeys.length === 0) return [];
  const preferred = attrKeys.filter((k) => k.includes("SERP_LIST_LISTING"));
  const rest = attrKeys.filter((k) => !k.includes("SERP_LIST_LISTING"));
  const ordered = [...preferred, ...rest];
  const merged: DataPoint[] = [];
  for (const key of ordered) {
    const attr = entry[key] as { dataPoints?: unknown } | null | undefined;
    const points = attr?.dataPoints;
    if (Array.isArray(points)) merged.push(...(points as DataPoint[]));
  }
  return merged;
}
```

**Coercion helpers to mirror exactly** (`sold-schema.ts` lines 113-120, identical to `listing.ts` lines 88-95) — every new field extractor in `client.ts` should use these, never a bare property access:
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

**`resolveAreaId`-equivalent URL builder pattern** (`sold-source.ts` lines 115-119) — reuse `URLSearchParams`, never manual string concat, for the area-search URL builder (`fetchAreaListings`'s equivalent):
```typescript
function buildSlutpriserUrl(areaId: string, objectType?: string | null): string {
  const params = new URLSearchParams({ areaIds: areaId });
  if (objectType) params.set("objectType", objectType);
  return `https://www.booli.se/sok/slutpriser?${params.toString()}`;
}
```

**`fetchSoldComps` absorption:** RESEARCH.md directs absorbing `fetchSoldComps` (and `resolveAreaId`, `buildSlutpriserUrl`) verbatim into `client.ts`, renaming call sites only — do not rewrite its internals.

---

### `src/lib/apify/booli-scraper.ts` (service, request-response — becomes rung 3)

**Analog:** itself — no code change to the function body; only its role changes (called from inside `fallback-tree.ts`'s rung-3 `attempt`, no longer the default path). If any change is needed it is call-site only:
```typescript
// Before (analyze.ts, current):
import { scrapeBooli } from "@/lib/apify/booli-scraper";
...
rawData = await scrapeBooli(url);

// After (analyze.ts, this phase):
import { fetchListing } from "@/lib/booli/client";
...
rawData = await fetchListing(url);
```
`fetchListing`'s contract MUST return the same raw shape `scrapeBooli()` returns today (`Record<string, unknown>`) — this is what makes the `normalizeScraperOutput`/`scraperOutputSchema` migration a no-op per RESEARCH.md.

---

### `src/lib/schemas/listing.ts` (unchanged) + `src/lib/schemas/listing.test.ts` (new, regression guard)

**Analog for the test file:** `src/lib/market/sold-source.test.ts` (whole file) — plain `describe`/`it`/`expect`, no mocks, fixture/literal-driven:
```typescript
import { describe, it, expect } from "vitest";
import { normalizeScraperOutput, scraperOutputSchema } from "@/lib/schemas/listing";

describe("normalizeScraperOutput — regression guard for the no-op migration claim", () => {
  it("maps a detail-page-shaped raw payload to the same NormalizedListing shape the paid actor produced", () => {
    const raw = { /* real detail-page-shaped fixture, see __fixtures__ below */ };
    const result = normalizeScraperOutput(raw);
    expect(result.address).toBe(/* ... */);
  });
});
```
Do NOT modify `scraperOutputSchema`/`normalizeScraperOutput` themselves — this file is read-only for this phase; only its test coverage is new.

---

### `src/lib/booli/client.test.ts` (new — NO analog, Wave 0 gap)

**Confirmed by RESEARCH.md Wave 0 Gaps:** no file in this codebase currently mocks `ApifyClient`'s `.actor().call()` / `.dataset().listItems()` chain. `sold-source.test.ts` only tests the pure `resolveAreaId()` helper (no `vi.mock` at all). This is genuinely net-new.

**Style analog for the `vi.mock` mechanics (not the data flow):** `src/actions/generate-report.test.ts` lines 17-21 — the project's established `vi.mock(...)` factory-function style, to be reused for shape consistency even though the mocked module differs entirely:
```typescript
const synthesizeReport = vi.fn();
vi.mock("@/lib/report/synthesize", () => ({
  synthesizeReport: (...args: unknown[]) => synthesizeReport(...args),
}));
```

**Recommended net-new mock shape for `apify-client`** (per RESEARCH.md Wave 0 Gaps — build this ONCE as a shared helper, do not let each test file invent its own):
```typescript
import { vi } from "vitest";

const actorCall = vi.fn();
const listItems = vi.fn();

vi.mock("apify-client", () => ({
  ApifyClient: vi.fn().mockImplementation(() => ({
    actor: () => ({ call: actorCall }),
    dataset: () => ({ listItems }),
  })),
}));

// In each test:
// actorCall.mockResolvedValue({ status: "SUCCEEDED", defaultDatasetId: "x" });
// listItems.mockResolvedValue({ items: [{ hasApollo: true, __APOLLO_STATE__: {...} }] });
```
Place this as a shared factory (e.g. exported from a `src/lib/booli/__mocks__/apify-client.ts` helper or a local `vi.mock` block at the top of `client.test.ts`, reused by `transport.ts`'s own tests if any) so `fetchListing`, `fetchAreaListings`, and `fetchSoldComps` regression tests don't each hand-roll a different fake shape.

---

### `src/lib/booli/fallback-tree.test.ts` (new — partial analog, pure-function testing)

**Analog:** No `ApifyClient` mock needed at all — RESEARCH.md is explicit that `walkFallbackTree` tests should inject fake `attempt()` functions directly (pure function, no I/O mocking required). Style-wise this most resembles a plain Vitest unit test with `vi.fn()` for the injected rungs, closer to `sold-source.test.ts`'s directness than `generate-report.test.ts`'s heavier chainable-fake mocking:
```typescript
import { describe, it, expect, vi } from "vitest";
import { walkFallbackTree } from "@/lib/booli/fallback-tree";

describe("walkFallbackTree", () => {
  it("falls to rung 2 on rung 1 throw, returns degraded health", async () => {
    const rung1 = vi.fn().mockRejectedValue(new Error("rung1 fail"));
    const rung2 = vi.fn().mockResolvedValue("data");
    const result = await walkFallbackTree([
      { source: "own-playwright", attempt: rung1 },
      { source: "own-playwright-retry", attempt: rung2 },
    ]);
    expect(result).toEqual({ data: "data", source: "own-playwright-retry", rung: 2, health: "degraded" });
  });

  it("throws when all rungs fail (HIGH-1 discipline)", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("dead"));
    await expect(
      walkFallbackTree([{ source: "own-playwright", attempt: failing }]),
    ).rejects.toThrow(/Alla Booli-kallor misslyckades/);
  });
});
```

## Shared Patterns

### ApifyClient instantiation
**Source:** `src/lib/market/sold-source.ts` lines 34-36, `src/lib/apify/booli-scraper.ts` lines 3-5
**Apply to:** `src/lib/booli/transport.ts` (the only file that should now instantiate `ApifyClient` directly — `client.ts` should call through `transport.ts`, not re-instantiate)
```typescript
const client = new ApifyClient({
  token: process.env.APIFY_API_TOKEN!,
});
```

### Throw-not-empty / HIGH-1 discipline
**Source:** `src/lib/market/sold-source.ts` (doc comment lines 27-31, code lines 199-218)
**Apply to:** `transport.ts`, `client.ts`, `fallback-tree.ts` — every layer that could otherwise return an empty/ambiguous result must throw a distinguishable error instead. Never return `[]` or `null` to signal "source dead."

### Error logging without secret leakage
**Source:** `src/lib/market/sold-source.ts` lines 221-227, `src/lib/apify/booli-scraper.ts` lines 49-58
**Apply to:** All new files — log the real error via `console.error("[prefix]", error)` server-side, then throw a Swedish user-facing message. Never log `process.env.APIFY_API_TOKEN` or the `ApifyClient` instance itself.
```typescript
} catch (error) {
  console.error("[booli-client]", error);
  throw new Error("Kunde inte hamta data fran Booli. Forsok igen.");
}
```

### Null-tolerant coercion helpers
**Source:** `src/lib/schemas/listing.ts` lines 88-105 (original), duplicated in `src/lib/market/sold-schema.ts` lines 113-120
**Apply to:** Any new field-extraction code in `client.ts` for the `Listing:` Apollo entity — use `num`/`str`/`rawOf`/`idStr` style helpers, never a bare `JSON.parse` or direct property access without a type guard (also a V5/DoS mitigation per RESEARCH.md Security Domain).

### SSRF-adjacent input validation (domain allowlist)
**Source:** `src/actions/analyze.ts` line 23
**Apply to:** `client.ts`'s `fetchListing(url)` — preserve (or require the caller to preserve) the `url.includes("booli.se/")` check before constructing `startUrls`, since the actor runs a real headless browser that will fetch whatever URL it's given.
```typescript
if (!url?.includes("booli.se/")) {
  return { error: "Ange en giltig Booli-lank" };
}
```

### URL building via URLSearchParams (never manual concat)
**Source:** `src/lib/market/sold-source.ts` lines 115-119 (`buildSlutpriserUrl`)
**Apply to:** Any new URL-building helper in `client.ts`, e.g. the area-search equivalent for `fetchAreaListings`.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src/lib/booli/fallback-tree.ts` | service | event-driven (rung retry) | Nothing in the codebase implements multi-rung fallback with observability today; `sold-source.ts`/`booli-scraper.ts` are each single-transport with no rungs. RESEARCH.md Pattern 3 (verbatim code above) is the authoritative spec — use it directly rather than searching further. |
| `src/lib/booli/client.test.ts` (the `ApifyClient` mock specifically) | test | request-response (mocked) | Confirmed absent codebase-wide by RESEARCH.md's own Wave 0 Gaps analysis — `sold-source.test.ts` never mocks `ApifyClient`, testing only the pure `resolveAreaId()` helper. The mock factory shown above under "Shared Patterns"/client.test.ts section should be built once and treated as the new canonical pattern for future Apify-backed tests. |

## Metadata

**Analog search scope:** `src/lib/market/`, `src/lib/apify/`, `src/lib/schemas/`, `src/actions/` (server actions + their existing `.test.ts` files)
**Files scanned:** `sold-source.ts`, `sold-source.test.ts`, `sold-schema.ts`, `booli-scraper.ts`, `listing.ts`, `analyze.ts`, `generate-report.test.ts`, `download-report-pdf.test.ts` (grepped, not fully read — same `vi.mock` style confirmed via grep, no additional excerpt needed)
**Pattern extraction date:** 2026-07-06
