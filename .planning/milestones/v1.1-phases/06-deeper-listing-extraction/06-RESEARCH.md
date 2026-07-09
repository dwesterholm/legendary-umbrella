# Phase 6: Deeper Listing Extraction - Research

**Researched:** 2026-07-06
**Domain:** Server-side HTML parsing / enrichment step appended to an existing Next.js Server Action; SSRF-hardened outbound fetch to third-party (broker) domains
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

None locked verbatim as "Decisions" — CONTEXT.md's discuss phase was auto-skipped (`workflow.skip_discuss`). Instead, CONTEXT.md carries these binding constraints inherited from the ROADMAP phase description (its own "Locked" equivalent for this phase):

- Second, optional enrichment step appended to `analyzeUrl`; Booli fields are the base, broker-page fields fill gaps only, provenance preserved.
- New listing fields are additive `.nullable().optional()` (no migration; JSONB column).
- Broker-fetch failure is caught in its own try/catch and never fails the primary listing analysis (independent-degradation pattern).
- Broker contact PII (mäklare name/phone/email) is deliberately excluded from extraction and output.
- Spike FIRST: check whether detail-page Apollo state from the Phase-5 owned fetch already yields brfName/floor before parsing broker pages.

### Claude's Discretion

All implementation choices are at Claude's discretion — discuss phase was skipped per user setting. Use the ROADMAP phase goal, success criteria, approach notes, and codebase conventions to guide decisions.

### Deferred Ideas (OUT OF SCOPE)

None — discuss phase skipped.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| LSTG-03 | System recovers listing fields Booli lacks (floor/våning, balcony, BRF name, renovation status, full description) by following through to the broker's own page (`agencyListingUrl`) | Standard Stack (cheerio + native fetch), Architecture Patterns (Pattern 1: Apollo-derived floor/balcony/brfName; Pattern 2: JSON-LD-first/DOM-fallback for renovation status + description), Code Examples (both the Apollo-extraction snippet and the broker-page fetch pattern) |
| LSTG-04 | Broker-sourced fields fill gaps only — never overwrite Booli data — and preserve provenance; a failed broker fetch never fails the primary listing analysis (graceful degradation) | Architecture Patterns (Pattern 3: gap-fill-only merge with provenance tagging; Pattern 4: independent-degradation try/catch reusing the `fetchSoldComps` shape), Security Domain (PII exclusion control), Common Pitfalls (Pitfall 4: PII leakage via wholesale JSON-LD capture) |
</phase_requirements>

## Summary

Phase 6 recovers five fields Booli's own SSR data doesn't fully cover — floor/våning, balcony, BRF name, renovation status, full description — by (a) reading more of what the Phase-5 owned client's Apollo-state entity already contains, and (b) following `listingUrl`/`agencyListingUrl` to the broker's own page and parsing it with `cheerio`. Direct inspection of the real, redacted Phase-5 fixture (`src/lib/booli/__fixtures__/listing-detail.json`) resolves the spike's central question decisively: **3 of the 5 fields are already inline in the Apollo entity and require zero broker fetch** — `floor` (`{raw: 3}`, a `FormattedValue`), `brfName` (the final breadcrumb's `label`, e.g. `"HSB BRF Metern"`), and `balcony` (detectable from the `amenities` array's ref key, `Amenity:{"key":"balcony"}` — no separate entity resolution needed, the ref key itself encodes the value). Only **renovation status** and **full description** have no representation anywhere in the detail-page Apollo entity (confirmed by exhaustively enumerating `infoSections`/`infoPoints`, which cover tenureForm/rent/operatingCost/floor/apartmentNumber/energyScore/pageviews/daysActive — no renovation or free-text description key exists). These two fields are the actual, narrowed broker-page dependency.

This materially changes the phase's shape from "always fetch the broker page for 5 fields" to "read 3 fields from data already on hand (a pure code change to `client.ts`/`listing.ts`/`analyze.ts`, no network dependency), then fetch the broker page ONLY for renovation status + description." The broker fetch itself is a plain `fetch()` + `cheerio` parse (no Playwright/Apify needed — broker sites are not behind Booli's Cloudflare wall) attempting JSON-LD (`schema.org/RealEstateListing` or similar) first, DOM selectors as fallback, wrapped in its own try/catch per the independent-degradation pattern already proven by `fetchSoldComps`'s try/catch → Swedish-message-throw shape. Because the broker URL is attacker-influenceable Booli-sourced data (not a fixed allowlisted domain like `booli.se`), this phase introduces a **genuine new SSRF surface** that Phase 5's exact-hostname-match pattern cannot reuse verbatim — a private/internal-IP + protocol check is required in addition to protocol allowlisting.

**Primary recommendation:** Extract `floor`/`brfName`/`balcony` from the existing Apollo entity in `client.ts`/`listing.ts` (no new network call, ships regardless of broker-CMS coverage); add a new `fetchBrokerListingPage(url)` in a new `src/lib/broker/` module using native `fetch` + `cheerio`, gated by an SSRF-hardened URL check (protocol allowlist + private-IP/loopback/link-local block, not just a booli.se-style hostname allowlist), called from `analyzeUrl` in its own try/catch that can only ADD fields, never remove or fail the primary flow.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Floor / balcony / BRF-name extraction from Apollo entity | API / Backend (`src/lib/booli/client.ts`, `src/lib/schemas/listing.ts`) | — | Already-fetched data; pure reshape/normalize logic, no new I/O |
| Broker-page fetch (HTTP GET) | API / Backend (`src/lib/broker/*`, server action only) | — | Must run server-side: SSRF risk, no client secrets, avoids CORS |
| Broker-page HTML parsing (JSON-LD / DOM) | API / Backend (`cheerio`, same module) | — | Parsing is a pure CPU-bound transform colocated with the fetch |
| Provenance tracking (Booli vs mäklare) | API / Backend (`analyze.ts` merge logic) | Database (JSONB `listing_data`) | Merge-and-tag logic belongs beside the data assembly, persisted with the row |
| Field display + "Ej tillgänglig" / source caption | Frontend Server (SSR) / Browser | — | `ListingSummary` is a server-rendered React component; no client JS required |
| SSRF allowlist / private-IP guard | API / Backend (`src/lib/broker/url-guard.ts` or similar) | — | Must execute before any outbound fetch; a browser/CDN tier cannot enforce this |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| cheerio | 1.2.0 [VERIFIED: npm registry, `npm view cheerio version`, 2026-07-06] | Parse broker HTML (JSON-LD extraction + DOM fallback) | jQuery-like server-side HTML parsing; the de facto Node.js standard for this exact task, has been for a decade; project already uses no alternative (no jsdom/htmlparser2 anywhere in the codebase) |
| zod | ^4.3.6 (already a dependency) | Validate/coerce broker-extracted fields into the same nullable shape as existing listing fields | Matches every existing schema in `src/lib/schemas/*` — consistency, not a new choice |

No other new runtime dependency is needed. Native `fetch` (Node 22, confirmed via `node --version`) is used for the broker HTTP GET — the codebase's own `scb.ts` already establishes "native fetch, no library" as the house pattern for non-Cloudflare-protected third-party HTTP calls (Booli is the ONLY target requiring the Playwright/Apify transport, because it alone sits behind Cloudflare's managed challenge; ordinary Swedish broker CMS sites do not).

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none) | — | — | No queue/cache/retry library is warranted — this is a single best-effort fetch per analysis, already covered by the existing try/catch + independent-degradation pattern |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| cheerio | jsdom | jsdom is heavier (full DOM + JS execution capability) and unnecessary — broker pages are static SSR HTML; cheerio is faster and already the ecosystem default for this exact "parse HTML server-side, no JS execution" use case |
| Native `fetch` for broker pages | Playwright/Apify (same transport as Booli) | Broker CMS sites (Vitec Express, Mspecs, Fasad) are NOT documented or observed to run Cloudflare managed challenges — a real browser is unnecessary overhead/cost for a page that a plain GET should resolve; only escalate to a headless-browser transport if a live spike shows a specific broker CMS blocking plain fetch |

**Installation:**
```bash
npm install cheerio
```

**Version verification:** `npm view cheerio version` → `1.2.0`, tarball at `registry.npmjs.org/cheerio/-/cheerio-1.2.0.tgz`, repository `github.com/cheeriojs/cheerio` — confirmed live 2026-07-06.

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| cheerio | npm | 10+ years (well-established, [ASSUMED] exact founding date not verified this session) | Very high (tens of millions/week, [ASSUMED] exact figure not re-verified this session) | github.com/cheeriojs/cheerio | [OK] | Approved |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

slopcheck 0.6.1 ran successfully against a scratch `package.json` containing `cheerio@^1.2.0` and returned `[OK]`. Registry existence + version were independently confirmed via `npm view cheerio version` (returned `1.2.0`) and `npm view cheerio repository.url` (returned the official `cheeriojs/cheerio` GitHub repo) — both corroborate the well-known package identity, not merely registry presence. Per the package-name-provenance rule, the exact age/downloads figures above are marked `[ASSUMED]` (training-data recall, not re-queried against npm's download-stats API this session) even though the package itself is `[VERIFIED]`.

## Architecture Patterns

### System Architecture Diagram

```
User submits Booli URL
        │
        ▼
analyzeUrl (Server Action, src/actions/analyze.ts)
        │
        ▼
fetchListing(url)  ──── existing Phase-5 owned client (client.ts)
        │                (Apollo-state entity, reshaped flat)
        ▼
normalizeScraperOutput(rawData)  ── EXTEND: pull floor/brfName/balcony
        │                            straight from the existing entity
        │                            (breadcrumbs already parsed;
        │                             floor/amenities keys already
        │                             surfaced by reshapeListingEntity)
        ▼
   [listingData: address, price, ..., floor, balcony, brfName]
        │
        │   IF agencyListingUrl (a.k.a. listingUrl) is present:
        ▼
   ┌─────────────────────────────────────────────┐
   │ try { fetchBrokerListingPage(agencyListingUrl) }│  ← NEW, own try/catch
   │   1. isSafeExternalUrl() SSRF guard            │     (independent-degradation
   │      (protocol allowlist + private/loopback/    │      pattern — never throws
   │       link-local IP block, THEN fetch)          │      into the primary flow)
   │   2. native fetch() the broker page              │
   │   3. cheerio.load(html)                          │
   │   4. try JSON-LD <script type="application/ld+json"> │
   │      (schema.org RealEstateListing/Product, if present) │
   │   5. fall back to DOM selectors (heading/prose blocks) │
   │   6. extract ONLY: renovationStatus, description │
   │      (floor/balcony/brfName come from Apollo —    │
   │       do NOT re-derive them from the broker page) │
   │   7. STRIP any name/phone/email pattern found      │
   │      (GDPR — never persisted, never in output)     │
   │ } catch { log; continue with brokerData = null }   │
   └─────────────────────────────────────────────┘
        │
        ▼
mergeListingFields(booliFields, brokerFields)
   — gap-fill ONLY: broker value used IFF booli value is null/absent
   — each filled field tagged { value, source: "booli" | "maklare" }
        │
        ▼
Persist to analyses.listing_data (JSONB, additive — no migration)
        │
        ▼
ListingSummary (React Server Component) renders 5 new fields +
   "Källa: Booli" / "Källa: Mäklarens annons" captions, or
   "Ej tillgänglig" when neither source has the field
```

### Recommended Project Structure
```
src/
├── lib/
│   ├── booli/
│   │   ├── client.ts              # EXTEND reshapeListingEntity: surface floor/balcony/brfName-from-breadcrumb into the flat shape (already has floor/amenities passthrough — finish the job)
│   ├── broker/                    # NEW module — broker-page enrichment
│   │   ├── fetch-broker-page.ts   # native fetch + SSRF guard + cheerio orchestration
│   │   ├── url-guard.ts           # isSafeExternalUrl(url): protocol + private-IP check
│   │   ├── parse-broker-page.ts   # JSON-LD-first / DOM-fallback field extraction
│   │   └── merge-listing-fields.ts # gap-fill-only merge + provenance tagging
│   └── schemas/
│       └── listing.ts             # EXTEND: floor, balcony, brfName (existing, wire through), renovationStatus, description — all .nullable().optional() with a `Source` companion field/shape
├── actions/
│   └── analyze.ts                 # EXTEND: call fetchBrokerListingPage in its own try/catch after fetchListing succeeds
└── components/
    └── listing-summary.tsx        # EXTEND: 3 new MetricCards (Våning/Balkong/Renoveringsstatus) + 1 prose block (Beskrivning) + provenance captions
```

### Pattern 1: Read-what's-already-there before fetching more
**What:** Before adding a new network dependency, exhaustively check whether the data is already present in a prior fetch's response shape.
**When to use:** Whenever "Booli lacks field X" is asserted in a roadmap/requirements doc written before the owned client existed — Phase 5's Apollo-entity extraction is materially richer than the old paid actor, and assumptions baked into STATE.md/REQUIREMENTS.md predate that fact.
**Example (from the real, redacted fixture):**
```json
{
  "floor": { "__typename": "FormattedValue", "raw": 3 },
  "amenities": [{ "__ref": "Amenity:{\"key\":\"balcony\"}" }],
  "breadcrumbs": [
    { "label": "Testgatan 1", "url": "/sok/till-salu?areaIds=102186&objectType=Lägenhet" },
    { "label": "HSB BRF Metern", "url": "/bostadsrattsforening/82768" }
  ]
}
```
`floor.raw` is the våning number directly (no `infoPoints` string-parsing needed, contradicting the ROADMAP's original assumption that floor lives in `infoPoints`'s `"våning 5 av 5 med hiss"` — that string DOES also exist in `infoSections[].content.infoPoints[key="floor"].displayText.markdown`, but the structured `floor.raw` field is simpler and already present). The final breadcrumb entry (`url` matching `/bostadsrattsforening/<id>`) is the BRF name (`label`) — exactly as the ROADMAP predicted, and this is the SAME `breadcrumbs` array `resolveAreaId` (Phase 5) already parses for a different purpose, so no new parsing infrastructure is needed. `amenities` entries are Apollo refs whose key STRING itself encodes the amenity (`Amenity:{"key":"balcony"}`) — checking for the presence of an entry whose ref matches `/"key":"balcony"/` is sufficient; there is no need to resolve a separate `Amenity:` entity out of `__APOLLO_STATE__` for a boolean presence check.

### Pattern 2: JSON-LD-first, DOM-fallback extraction
**What:** Attempt to parse `<script type="application/ld+json">` blocks matching `schema.org/RealEstateListing`, `Product`, or `Residence` types first; only fall back to DOM/CSS-selector scraping if no usable JSON-LD is found.
**When to use:** Any broker-page parse, because JSON-LD (when present) is structured, versioned by the CMS vendor, and far less brittle than DOM selectors that break on every broker theme update.
**Example:**
```typescript
// Source: schema.org/RealEstateListing (https://schema.org/RealEstateListing) —
// generic pattern; NOT verified against a live Vitec Express / Mspecs / Fasad
// page this session (see Open Questions — broker-CMS sampling still needed).
import * as cheerio from "cheerio";

function extractJsonLd($: cheerio.CheerioAPI): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).text());
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      blocks.push(...arr.filter((v) => v && typeof v === "object"));
    } catch {
      // Malformed JSON-LD is common (trailing commas, HTML entities) — skip, don't throw.
    }
  });
  return blocks;
}
```

### Pattern 3: Gap-fill-only merge with provenance tagging (LSTG-04's core contract)
**What:** A merge function that only writes a broker-sourced value into a field that is currently null/absent — never overwrites an existing Booli value — and tags every populated field with its source.
**When to use:** The single merge point between `booliFields` and `brokerFields` in `analyze.ts`.
**Example:**
```typescript
// Illustrative — write for THIS phase's actual field set, not copy-pasted verbatim.
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

### Pattern 4: Independent-degradation try/catch (already proven by `fetchSoldComps`)
**What:** A network call to an optional enrichment source is wrapped in its own try/catch; on failure, log server-side and continue with the primary flow producing `null`s for the enrichment fields — never rethrow into the caller.
**When to use:** The broker-page fetch call site in `analyze.ts`. This EXACT shape already exists in the codebase for `fetchSoldComps` (`client.ts` lines 521-534) — reuse the shape, not the Booli-specific Swedish error strings.
**Example (from the existing codebase, `src/lib/booli/client.ts`):**
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
Phase 6's broker fetch differs in ONE critical way: it must NOT rethrow. The call site in `analyzeUrl` must catch and continue (LSTG-04 success criterion 3 — "primary listing analysis still succeeds exactly as before"), whereas `fetchSoldComps` intentionally rethrows because sold-comps IS its own required feature. Model the broker call site after `analyze.ts`'s existing top-level `try { rawData = await fetchListing(url) } catch { return { error } }` shape, but INVERT the catch behavior: catch → log → `brokerFields = null` → keep going, never `return { error }`.

### Anti-Patterns to Avoid
- **Re-fetching Apollo-derivable fields from the broker page:** Do not have the broker-page parser also attempt to extract floor/balcony/BRF-name — those come from Apollo (Pattern 1) and are more reliable (structured, first-party Booli data). Parsing the broker page for a field Apollo already gave you doubles the maintenance surface and creates disagreement/overwrite risk that LSTG-04 explicitly forbids.
- **Treating `agencyListingUrl` as trusted just because it came from Booli:** Booli's own data can point anywhere (a compromised or malicious broker site, or a scraper-injected value if Booli's own pipeline is ever poisoned). Apply the SAME server-side outbound-fetch discipline as any other user-influenceable URL — see Security Domain below.
- **Persisting broker contact PII "just in case":** The ROADMAP explicitly excludes mäklare name/phone/email. Do not extract these fields "for completeness" even if visible in JSON-LD (`RealEstateAgent` schema commonly embeds `name`/`telephone`/`email`) — filter them out at extraction time, not at display time, so they never enter the JSONB column at all (success criterion 4 is about STORED data, not just rendered output).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| HTML parsing / CSS selector queries | A regex-based HTML scraper | `cheerio` | Regex-based HTML parsing is the textbook fragile-scraper anti-pattern — breaks on any whitespace/attribute-order change; cheerio gives real CSS selectors + a DOM-like API for ~zero extra weight |
| SSRF protection for the broker URL | A "does the string contain a bad word" blocklist | URL parsing (`new URL()`) + protocol allowlist (`http:`/`https:`) + DNS-resolve-then-classify the resulting IP against RFC1918/loopback/link-local ranges | Per OWASP's Node.js SSRF guidance [CITED: owasp.org/www-community/pages/controls/SSRF_Prevention_in_Nodejs], blocklists and hostname substring checks are proven-insufficient (Phase 5's own `isBooliUrl` doc comment already documents exactly this lesson for the `.includes()` bypass — the same discipline must extend to the broker-URL case, which is structurally harder because there is no fixed target domain to allowlist) |
| JSON-LD schema.org type detection | Manual string matching on raw JSON text | Parse each `<script type="application/ld+json">` block as JSON first, then inspect the parsed `@type` field | JSON-LD blocks can contain nested/arrayed types, `@graph` wrappers, or multiple objects per script tag — string-matching the raw text before parsing is unreliable and exactly the kind of "looks like it works on one sample" trap this codebase's Apollo-variant-merge code (`dataPointsOf`) already had to fix once (WR-05 non-determinism bug) |

**Key insight:** Every hand-rolled alternative in this table fails specifically on the long tail of real broker-CMS variation (Vitec Express vs Mspecs vs Fasad vs a bespoke agency site) — the whole point of the phase's own informational spike ("sample real `agencyListingUrl` domains ... so parser scope is set against reality") is that this variation is expected and must be handled by robust, standard tooling, not brittle one-off string matching that only survives against the single sample used to write it.

## Common Pitfalls

### Pitfall 1: Treating the ROADMAP's field-location assumptions as final
**What goes wrong:** Building a broker-page parser for floor/balcony/BRF-name because the ROADMAP phase description says "Booli lacks" them, when the actual Phase-5 fixture proves otherwise.
**Why it happens:** The ROADMAP/REQUIREMENTS text predates the Phase-5 probe; `03-SPIKE.md` (Phase 3, written before Phase 5 existed) only had SERP/actor-shaped data to reason from, not the richer detail-page Apollo entity.
**How to avoid:** Trust the live fixture (`listing-detail.json`) over the roadmap prose — already done in this research (see Summary). The plan MUST implement the Apollo-derived path for floor/balcony/brfName as a code-only change with NO conditional on broker-fetch success.
**Warning signs:** A plan that has a single task fetching the broker page for all 5 fields, rather than splitting "3 fields from Apollo (no network)" + "2 fields from broker page (best-effort network)".

### Pitfall 2: SSRF via the broker URL (new risk surface Phase 5 didn't have)
**What goes wrong:** Reusing Phase 5's `isBooliUrl`-style exact-hostname-allowlist pattern verbatim is impossible here (there is no fixed "broker.se" domain to allowlist — every Swedish brokerage runs its own domain), so a naive implementation either (a) fetches ANY URL Booli hands back with no validation, or (b) reintroduces the exact ".includes()" substring-bypass class of bug Phase 5's WR-03 fix already had to correct once for a DIFFERENT reason.
**Why it happens:** Copy-pasting Phase 5's SSRF pattern without recognizing that Phase 5's threat model (attacker controls the INPUT url) differs from Phase 6's (Booli's own data controls a THIRD-PARTY url which could itself be adversarial or, if Booli's pipeline is ever compromised, attacker-influenced).
**How to avoid:** Implement protocol allowlisting (`http:`/`https:` only) PLUS a private/internal-IP check: resolve the hostname via `dns.promises.lookup()` and reject loopback (127.0.0.0/8, ::1), link-local (169.254.0.0/16, fe80::/10 — this blocks cloud metadata endpoints like 169.254.169.254), and RFC1918 private ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) BEFORE issuing the fetch. Per OWASP guidance [CITED: owasp.org/www-community/pages/controls/SSRF_Prevention_in_Nodejs], resolve-then-classify must happen at request time, not cached from an earlier check, to avoid DNS-rebinding — for a single best-effort GET with no redirect-follow requirement, the simplest safe implementation is: resolve once, connect to the resolved IP directly (or immediately re-validate if using bare hostname fetch), and disable automatic redirect-following (`fetch(url, { redirect: "manual" })` or reject on any 3xx) so a redirect chain cannot smuggle the request to an internal target after the initial check passed.
**Warning signs:** Any code review comment approving "we already have isBooliUrl for SSRF" as sufficient justification for the broker fetch — it is a different threat model and needs its own guard.

### Pitfall 3: Amenity ref-key string matching that's too brittle or too loose
**What goes wrong:** `Amenity:{"key":"balcony"}` is a stringified-JSON Apollo ref key. Matching it with a plain `.includes("balcony")` could also match an unrelated future key like `"key":"balconyView"` (false positive) or fail on key-ordering changes if Apollo ever serializes it as `{"anotherField":"x","key":"balcony"}` (unlikely, but not something to hardcode an assumption about).
**Why it happens:** The temptation to treat the ref string as a stable, predictable format because it happened to work in the one captured fixture.
**How to avoid:** Parse the ref suffix as JSON (`JSON.parse(ref.replace(/^Amenity:/, ""))`) and compare the resulting object's `.key` field with strict equality (`=== "balcony"`), the same discipline `dataPointsOf`'s existing arg-keyed-field parsing already uses elsewhere in `client.ts` for `displayAttributes({...})` keys — don't introduce a second, looser string-matching convention alongside an existing stricter one in the same file.
**Warning signs:** A test that only covers the exact fixture string and would still pass if `.includes()` were substituted for exact parsing.

### Pitfall 4: Broker-page JSON-LD embeds the excluded PII (RealEstateAgent schema)
**What goes wrong:** The `schema.org/RealEstateListing` JSON-LD pattern commonly nests a `RealEstateAgent`/`Person` object with `name`, `telephone`, `email` directly alongside the listing description — a naive "grab the whole JSON-LD blob and store it" implementation would violate success criterion 4 (no broker PII in stored data) on the very first real broker page that includes it.
**Why it happens:** JSON-LD is convenient to consume wholesale; filtering it field-by-field feels like extra work until the PII requirement is remembered.
**How to avoid:** Extraction must be an explicit ALLOW-list of fields read out of the parsed JSON-LD/DOM (description text, renovation-related text), never a passthrough of the raw parsed object into storage. Add a unit test asserting that a JSON-LD fixture containing `agent.name`/`agent.telephone` never appears anywhere in the function's return value.
**Warning signs:** Any code path that does `...jsonLd` object-spread or stores the parsed JSON-LD blob verbatim "for future use."

### Pitfall 5: Renovation status has no standard vocabulary — risk of fabrication
**What goes wrong:** Unlike floor (a number) or balcony (boolean), "renovation status" is free text on broker pages with no fixed schema — a description might say "nyrenoverat kök 2020" in prose with no dedicated field. An LLM-based extraction (rather than deterministic parsing) could paraphrase/infer beyond what the source text actually says, which conflicts with this project's carried-forward no-fabrication principle (see STATE.md's DISC-04/05 constraints, which — while written for a different phase — establish the project's general "never fabricate, always cite" posture).
**Why it happens:** Renovation status is inherently a natural-language signal, tempting a "just ask an LLM to summarize it" shortcut.
**How to avoid:** Per the ROADMAP's own approach line ("parsed via cheerio, JSON-LD first / DOM fallback") — this is a DETERMINISTIC, code-based extraction phase, not an LLM/vision phase. If a broker page has no dedicated renovation-status field/section, the honest outcome is "Ej tillgänglig," not an LLM-inferred guess from the description prose. Only extract renovation status if the broker page/JSON-LD has an identifiable, dedicated field or clearly-labeled section for it (a small number of Vitec Express templates surface a "Renoveringar"/"Skick" heading in the DOM per common Swedish broker-site conventions [ASSUMED — not verified against a live sample this session, see Open Questions]); otherwise leave it null.
**Warning signs:** A plan task that calls out to Claude/an LLM to "extract renovation status from the description" — that belongs to a future vision/DISC-0x phase's design posture, not this deterministic phase's.

## Code Examples

### SSRF-safe broker URL validation (illustrative pattern)
```typescript
// Source: pattern synthesized from OWASP SSRF Prevention guidance
// [CITED: https://owasp.org/www-community/pages/controls/SSRF_Prevention_in_Nodejs]
// — NOT copied from an existing project file; this is new code for Phase 6.
import { promises as dns } from "node:dns";
import net from "node:net";

const PRIVATE_V4_RANGES: [string, number][] = [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local — also covers cloud metadata (169.254.169.254)
];

function isPrivateIPv4(ip: string): boolean {
  const ipNum = ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
  return PRIVATE_V4_RANGES.some(([base, bits]) => {
    const baseNum = base.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipNum & mask) === (baseNum & mask);
  });
}

export async function isSafeExternalUrl(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  try {
    const { address, family } = await dns.lookup(parsed.hostname);
    if (family === 4 && isPrivateIPv4(address)) return false;
    if (family === 6 && (address === "::1" || address.startsWith("fe80:"))) return false;
    return true;
  } catch {
    return false; // DNS resolution failure — treat as unsafe, not "assume public".
  }
}
```

### Reading floor/BRF-name/balcony from the existing Apollo entity (extends `client.ts`)
```typescript
// Source: derived directly from the real, redacted fixture at
// src/lib/booli/__fixtures__/listing-detail.json — NOT a new external API,
// this extends reshapeListingEntity's ALREADY-passthrough floor/amenities
// fields into normalizeScraperOutput's typed output.
function amenityKeys(refs: unknown): string[] {
  if (!Array.isArray(refs)) return [];
  return refs
    .map((r) => (r && typeof r === "object" && "__ref" in r ? (r as { __ref: string }).__ref : null))
    .filter((ref): ref is string => typeof ref === "string" && ref.startsWith("Amenity:"))
    .map((ref) => {
      try {
        return (JSON.parse(ref.slice("Amenity:".length)) as { key?: string }).key ?? "";
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

// brfName: the LAST breadcrumb whose url matches /bostadsrattsforening/<id> —
// the exact pattern resolveAreaId (client.ts) already parses for areaIds, just
// a different regex on the same array.
function brfNameFromBreadcrumbs(breadcrumbs: unknown): string | null {
  if (!Array.isArray(breadcrumbs)) return null;
  const last = breadcrumbs[breadcrumbs.length - 1] as { label?: string; url?: string } | undefined;
  if (last?.url && /\/bostadsrattsforening\//.test(last.url)) {
    return typeof last.label === "string" && last.label.length > 0 ? last.label : null;
  }
  return null;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Assume floor/BRF-name require broker-page parsing (ROADMAP/03-SPIKE.md framing, written before Phase 5's owned client existed) | Read floor/BRF-name/balcony straight from the Phase-5 Apollo detail-page entity, no network call | Phase 5 (05-PROBE-FINDINGS.md, 2026-07-06) | Cuts the phase's real broker-page dependency from 5 fields to 2 (renovation status, description); removes 3 fields' worth of broker-CMS-coverage risk entirely |
| Paid actor (`booli-scraper.ts`) as a possible source for these fields | Paid actor never returned floor/BRF-name either (confirmed by `scraperOutputSchema`'s own doc comment: "the actor does NOT return BRF name or floor") | Predates this phase | Confirms these fields were a genuine gap until Phase 5's richer Apollo extraction, not something regressed |

**Deprecated/outdated:**
- The `agencyListingUrl` key name from the ROADMAP's phrasing: the real Apollo field is `listingUrl` (Phase 5 already surfaces BOTH keys in `reshapeListingEntity` for compatibility — `listingUrl: str(entry.listingUrl)` and `agencyListingUrl: str(entry.listingUrl)`, so either name resolves in downstream code).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Broker CMS sites (Vitec Express, Mspecs, Fasad) do not run Cloudflare-class bot protection and are reachable via a plain `fetch()` | Standard Stack / Architecture | If wrong for even a meaningful fraction of brokers, those pages return 403s and degrade to "Ej tillgänglig" for renovation/description — not a correctness bug (independent-degradation still holds) but reduces the feature's real-world hit rate; the phase's own informational spike (sample real domains) should confirm/refute this before/during planning |
| A2 | A meaningful fraction of Swedish broker pages expose `schema.org/RealEstateListing`-style JSON-LD | Architecture Patterns / Code Examples | If most brokers have no JSON-LD, the DOM-fallback path carries more weight than expected and needs per-CMS selector tuning (Vitec Express vs Mspecs vs Fasad each render differently) — this is exactly what the ROADMAP's own "sample real domains" spike step is meant to resolve; not resolved in this research session (no live broker page was fetched) |
| A3 | A renovation-status field/section is identifiable via a dedicated DOM heading (e.g. "Renoveringar"/"Skick") on at least some broker CMS templates | Common Pitfalls (Pitfall 5) | If no broker CMS reliably labels this, the field may end up "Ej tillgänglig" far more often than the success criteria imply is achievable — success criterion 1 says "for a listing whose broker page is parseable," which already hedges for this, but the plan should not over-promise renovation-status recovery rate |
| A4 | cheerio's exact age/weekly-download figures cited in the Package Legitimacy Audit | Package Legitimacy Audit | Low risk — package identity itself is independently confirmed via npm registry + GitHub repo match; only the specific age/download numbers are unverified recall, not the legitimacy verdict |

**If this table is empty:** N/A — see rows above; all are broker-page-coverage uncertainties inherent to the phase's own "informational spike" framing, none affect the Apollo-derived (floor/balcony/BRF-name) or SSRF-guard portions of the research, which are HIGH confidence.

## Open Questions

1. **What fraction of real `agencyListingUrl` domains are Vitec Express vs Mspecs vs Fasad vs bespoke, and does each expose JSON-LD?**
   - What we know: These three platforms are the named major Swedish broker-CMS systems [MEDIUM confidence — WebSearch results named all three consistently across multiple independent listing/integration pages, but no authoritative market-share source was found this session].
   - What's unclear: Real-world JSON-LD coverage and DOM structure per platform — this requires fetching actual live broker pages, which is explicitly the ROADMAP's own "informational spike" (2) and was not performed in this research session (no live network fetch to a broker domain was made; only the existing Phase-5 fixture and public web search were used).
   - Recommendation: The plan should include a Wave-0-style live spike task (sample 5-10 real `agencyListingUrl`s surfaced by re-running `fetchListing` against real Booli listings, or reusing Phase 5's probe script pattern) BEFORE writing the DOM-fallback selector logic, mirroring how Phase 5 itself gated the owned-client decision on a live probe rather than assumption.

2. **Does `housingCoopInfo` (the lazy-loaded `InfoSection` with `key: "housingCoopInfo"`) ever populate with useful BRF-level renovation history (e.g. stambyte) in a live render, given it was empty (`infoPoints: []`) in the captured fixture?**
   - What we know: The fixture shows this section present but empty — likely a client-side-hydrated tab that the server-rendered Apollo snapshot doesn't populate.
   - What's unclear: Whether a different/live listing ever has this populated in the initial SSR payload, or whether it always requires a follow-up client-side fetch this project's Playwright transport doesn't trigger.
   - Recommendation: Treat as consistently empty (don't build extraction logic against it) unless a live re-probe shows otherwise; not worth blocking the phase on.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js `fetch`/`dns` (built-in) | Broker-page HTTP GET + SSRF IP resolution | ✓ | Node 22.20.0 (confirmed via `node --version`) | — |
| cheerio | HTML/JSON-LD parsing | ✗ (not yet installed) | 1.2.0 available on npm | `npm install cheerio` — no viable fallback needed, trivial install |
| APIFY_API_TOKEN / Apify actor | NOT required for this phase | n/a | n/a | Broker fetch deliberately does NOT use the Apify/Playwright transport (Standard Stack rationale above) |

**Missing dependencies with no fallback:** none — `cheerio` is a one-line `npm install` with no environment prerequisites.
**Missing dependencies with fallback:** none applicable.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (`vitest.config.ts` — `environment: "node"`, globals enabled) |
| Config file | `/Users/danielwesterholm/dev/legendary-umbrella/vitest.config.ts` |
| Quick run command | `npx vitest run src/lib/broker src/lib/booli src/lib/schemas/listing.test.ts` |
| Full suite command | `npm run test` (or `npx vitest run`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| LSTG-03 | floor/brfName/balcony extracted from Apollo entity without a broker fetch | unit | `npx vitest run src/lib/schemas/listing.test.ts` | ✅ (extend existing file) |
| LSTG-03 | Broker page JSON-LD parsed for description/renovation status | unit | `npx vitest run src/lib/broker/parse-broker-page.test.ts` | ❌ Wave 0 |
| LSTG-03 | Broker page DOM-fallback parsed when no JSON-LD present | unit | `npx vitest run src/lib/broker/parse-broker-page.test.ts` | ❌ Wave 0 |
| LSTG-04 | Broker-sourced field never overwrites an existing Booli value | unit | `npx vitest run src/lib/broker/merge-listing-fields.test.ts` | ❌ Wave 0 |
| LSTG-04 | Broker fetch failure (network error, non-200, malformed HTML) never fails `analyzeUrl` | integration | `npx vitest run src/actions/analyze.test.ts` | ❌ Wave 0 (no `analyze.test.ts` exists yet at all — a pre-existing gap, not phase-6-specific) |
| LSTG-04 | SSRF guard rejects private/loopback/link-local resolved IPs and non-http(s) protocols | unit | `npx vitest run src/lib/broker/url-guard.test.ts` | ❌ Wave 0 |
| LSTG-04 (success criterion 4) | No mäklare name/phone/email present anywhere in parsed broker fields or persisted `listing_data` | unit | `npx vitest run src/lib/broker/parse-broker-page.test.ts` (PII-exclusion assertion) | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run <touched test files>`
- **Per wave merge:** `npm run test` (full suite)
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/lib/broker/url-guard.test.ts` — SSRF guard unit tests (protocol allowlist, private-IP rejection, DNS-failure-is-unsafe)
- [ ] `src/lib/broker/parse-broker-page.test.ts` — JSON-LD-first/DOM-fallback extraction + PII-exclusion assertions, using synthetic HTML fixtures (no live broker page committed as a fixture — see Open Question 1; synthesize realistic fixtures based on schema.org/RealEstateListing shape until a real sample is captured)
- [ ] `src/lib/broker/merge-listing-fields.test.ts` — gap-fill-only merge + provenance tagging
- [ ] `src/actions/analyze.test.ts` — does not exist at all today (pre-existing gap); Phase 6 is a reasonable place to add the first integration test for `analyzeUrl`, at minimum covering the new broker-fetch-failure-never-fails-primary-flow behavior
- [ ] `src/lib/schemas/listing.test.ts` — extend existing file with floor/brfName/balcony extraction cases against both the real fixture and hand-built edge cases (breadcrumb array too short / last entry not a BRF url / amenities array without a balcony ref)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | no | Not touched by this phase — reuses existing `analyzeUrl` auth/guest gating unchanged |
| V3 Session Management | no | Not touched |
| V4 Access Control | no | Not touched — broker enrichment runs for both guest and authenticated flows identically, no new access boundary |
| V5 Input Validation | yes | Zod schemas (`.nullable().optional()` additive fields) for all broker-extracted values before persistence; reject/null anything that fails validation rather than coercing |
| V6 Cryptography | no | No secrets/crypto introduced |
| V10 (SSRF, ASVS 4.0 "Malicious Controls"/mapped to CWE-918) | yes | Protocol allowlist (`http:`/`https:`) + DNS-resolve-then-classify against private/loopback/link-local IP ranges before every broker-page fetch; disable automatic redirect-following or re-validate on each redirect hop — see Code Examples and Pitfall 2 |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| SSRF via Booli-sourced `agencyListingUrl` pointing at an internal/cloud-metadata address | Tampering / Information Disclosure | `isSafeExternalUrl()` guard (protocol + resolved-IP check) before every fetch — see Code Examples |
| DNS rebinding (URL passes the safety check, then re-resolves to an internal IP at fetch time) | Tampering | Resolve once and connect to the resolved IP directly, or re-validate immediately before the actual `fetch()` call with minimal time-of-check-to-time-of-use gap; disable redirects so a 3xx cannot re-trigger a fresh, unchecked resolution |
| PII leakage (broker mäklare name/phone/email persisted via a wholesale JSON-LD/DOM capture) | Information Disclosure | Explicit allow-list extraction (never object-spread/passthrough of parsed broker data) — see Pitfall 4; add a regression test asserting PII fields never appear in the merge output |
| Malformed/hostile HTML causing a parse-time crash or ReDoS | Denial of Service | cheerio (a maintained parser, not hand-rolled regex) handles malformed HTML gracefully by design; still wrap the whole broker-fetch-and-parse call in the independent-degradation try/catch so any unexpected throw degrades to "Ej tillgänglig" rather than failing `analyzeUrl` |

## Sources

### Primary (HIGH confidence)
- `src/lib/booli/__fixtures__/listing-detail.json` — the real, redacted Phase-5 Apollo detail-page entity fixture; directly inspected this session to confirm `floor`, `amenities`, `housingCoop`/breadcrumb, and the absence of any renovation/description field.
- `src/lib/booli/client.ts`, `src/lib/schemas/listing.ts`, `src/actions/analyze.ts` — existing project code read in full this session; establishes the exact extension points and existing conventions (SSRF allowlist pattern, independent-degradation try/catch, additive-nullable schema style).
- `.planning/phases/05-owned-booli-acquisition/05-PROBE-FINDINGS.md` — the canonical prior-art record explicitly informing this phase, confirming floor/balcony/BRF-name recoverability and the `listingUrl`/`agencyListingUrl` field-name reconciliation.
- npm registry (`npm view cheerio version`, `npm view cheerio repository.url`) — confirmed cheerio 1.2.0, official GitHub repo, run live this session.
- slopcheck 0.6.1 (`slopcheck scan`) — run live this session against a scratch `package.json`, returned `[OK]` for cheerio.
- OWASP "SSRF Prevention in Node.js" [CITED: https://owasp.org/www-community/pages/controls/SSRF_Prevention_in_Nodejs] — fetched this session; informs the Security Domain and Pitfall 2 guidance.

### Secondary (MEDIUM confidence)
- WebSearch: "svenska mäklarsystem ... Vitec Express Mspecs Fasad" — consistently names Vitec Express, Mspecs, and Fasad as the major Swedish broker-CMS platforms across multiple independent integration/vendor pages, but no authoritative market-share breakdown was found.

### Tertiary (LOW confidence)
- WebSearch: "Vitec Express ... JSON-LD schema.org RealEstateListing" — returned only generic schema.org guidance, no Vitec-specific confirmation of JSON-LD usage. Flagged as Open Question 1 / Assumption A2 — needs a live sample before the plan finalizes DOM-selector scope.
- The specific claim that some Vitec Express templates expose a "Renoveringar"/"Skick" DOM heading (Assumption A3) is unverified training-knowledge recall, not confirmed via WebSearch or a live fetch this session.

## Metadata

**Confidence breakdown:**
- Standard stack (cheerio + native fetch): HIGH — package verified via registry + slopcheck; native fetch/dns already the established in-codebase pattern for non-Cloudflare third-party HTTP.
- Architecture (Apollo-field extraction for floor/balcony/brfName): HIGH — directly confirmed against the real, redacted fixture, not inferred.
- Architecture (broker-page JSON-LD/DOM parsing): MEDIUM — the parsing pattern itself is standard, but real-world coverage against actual Swedish broker CMS output is unverified this session (informational spike still needed, as the ROADMAP itself anticipates).
- Security (SSRF guard): HIGH — grounded in official OWASP guidance, directly applicable, no ambiguity in the required control.
- Pitfalls: HIGH for Apollo-extraction and SSRF pitfalls (backed by direct fixture inspection / official docs); MEDIUM for renovation-status/broker-CMS-coverage pitfalls (inherently uncertain until live broker samples are captured).

**Research date:** 2026-07-06
**Valid until:** 30 days for the Apollo-field-extraction and SSRF-guard findings (stable, code-grounded); 7-14 days for the broker-CMS-coverage assumptions (WebSearch-only, no live verification — should be re-validated by the phase's own informational spike before/during Wave 0)
