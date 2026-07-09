# Phase 10: Niche Ranking - Research

**Researched:** 2026-07-07
**Domain:** Deterministic scoring/ranking over persisted discovery candidates (Next.js/Supabase/Zod codebase)
**Confidence:** HIGH (architecture, data-availability findings — read directly from code) / MEDIUM (niche-signal weighting design — reasoned from codebase precedent, needs UAT tuning)

## Summary

Phase 9 shipped a deliberately thin, PII-safe `DiscoveryCandidate` shape (7 fields: address, price, rooms, livingArea, areaLabel, thumbnailUrl, sourceListingUrl) persisted into `discovery_jobs.results`. This was a conscious allowlist decision (`toCandidate`, no-spread, exact-key-tested) to keep seller/occupant PII out of storage — but it also means **none of the three named niches can be computed from what is persisted today.** Renovation-upside needs price/sqm-vs-area-baseline plus a "dated" text signal; turnkey needs a renovation/newproduction text signal; the stambyte niche needs a full BRF org.nr-resolved financial extraction. None of these exist in the current 7-field record.

The raw Apollo entity (`reshapeListingEntity`, already fetched once per candidate inside `runSlice`, before `toCandidate` narrows it) DOES carry `constructionYear`, `tenureForm`, and a `breadcrumbs` array `brfNameFromBreadcrumbs` can already parse into a BRF name — all discarded today. This is the cheapest enrichment path: capture 2-3 more allowlisted, PII-safe fields (`constructionYear`, `brfName`, `tenureForm`) at zero extra network cost, since the entity is already in memory during the existing scrape.

The stambyte niche is categorically different in cost: computing it for real requires the full ENRICH-01 pipeline (Allabrf search + org.nr resolution + document fetch + Haiku extraction) per candidate — a multi-SEK, multi-second operation per listing that cannot run inside the existing sub-1-SEK/search discovery cost cap for 25 candidates. The recommended v1 scope (matching the ROADMAP's explicit permission for "a v1 subset") is a **text-derived proxy signal only** — construction year age + a lightweight keyword scan of anything already in hand (address/area text has none; the description text is BLOCKED from persistence by the PII allowlist) — with the full BRF-backed version explicitly deferred and the UI copy saying so. See Open Question 1 (RESOLVED) for the concrete recommendation and kill-criterion framing.

Architecturally, ranking should be a **client-side, zero-network reorder** over the already-persisted `discovery_jobs.results`: compute all per-signal facts once (at persist time, additively, inside the existing `toCandidate`/`runSlice` pipeline), then let niche selection just re-sort and re-weight in the browser. This mirrors `computeBrfGrade`/`computeFlags`'s "pure function, deterministic, no I/O" pattern exactly, and avoids a second job/cost-cap system for what the CONTEXT.md constraint frames as "a FINAL PASS."

**Primary recommendation:** Extend `DiscoveryCandidate` additively (migration 012, backward-compatible/nullable) with 2-3 cheap allowlisted facts already available in the raw entity (`constructionYear`, `brfName`, `tenureForm`); compute a `NicheScore` per niche as a pure function of those facts (mirroring `score.ts`/`flags.ts`); render cited-signal chips (mirroring `Flag`'s `sourceRef`/`sourceQuote` shape) instead of an opaque number; reorder client-side on niche change with zero re-fetch. Ship the stambyte niche as a construction-year-only proxy with an explicit "kräver BRF-analys för att bekräfta" hedge, and treat the richer BRF-backed version as a stretch goal gated by real per-listing enrichment cost, not a Phase 10 blocker.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Per-candidate signal extraction (facts: constructionYear, brfName, tenureForm, price/sqm) | API/Backend (`runSlice`/`toCandidate`, server-only) | Database (persisted in `discovery_jobs.results` JSONB) | Facts must be computed once, at scrape time, from the raw Apollo entity that only exists server-side during the scrape — never re-fetched client-side |
| Area price/sqm baseline (for renovation-upside signal) | API/Backend | Database (could reuse existing sold-comps infra) | Needs an area-level aggregate; the existing `fetchSoldComps`/`compare.ts` machinery already computes an area price baseline for PRICE-01 — reuse, don't reinvent |
| Niche score computation (weighted signal → score + cited breakdown) | Browser/Client (pure TS function, no I/O) | — | Mirrors `computeBrfGrade`/`computeFlags`: deterministic, reorderable without a round-trip; must run client-side so switching niches is instant (CONTEXT.md: "ordering visibly changes when the niche changes") |
| Niche selection UI (dropdown/tabs + reorder) | Browser/Client | Frontend Server (SSR renders the initial default-niche order) | Purely presentational; no server round-trip needed after initial page load |
| Cited-signal display (chips per candidate) | Browser/Client | — | Same tier as the score computation; both consume the same per-candidate fact object |
| BRF stambyte full-signal enrichment (deferred/stretch) | API/Backend | Database (`brf_data` reuse) | If ever implemented, must reuse the existing ENRICH-01 `runBrfExtraction`/`resolveOrgNr` pipeline — never a second implementation |

## Standard Stack

### Core
This phase adds no new runtime dependencies. It is 100% additive logic in the existing stack:

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod (v4) | already in use (`zod/v4`) | Schema for the extended `DiscoveryCandidate` + read-path guard | Matches every existing schema in the codebase (`filter-schema.ts`, `candidate.ts`, `schemas/brf.ts`) |
| TypeScript (existing) | project version | Pure scoring functions | `score.ts`/`flags.ts` precedent — no framework needed for deterministic scoring |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| React `useState`/`useMemo` (already in use via Next.js 15/React) | project version | Client-side niche selector + reorder | For the reorderable results grid — no new state library needed for a single enum + derived sort |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Client-side pure-function scoring | A `/api/rank` server route recomputing scores per niche change | Adds latency + a network round-trip for a computation that requires zero new data per niche switch; only justified if scoring needs data NOT safe to ship to the client (not the case here — same PII-safe candidate fields already rendered) |
| Weighted-sum deterministic score | An LLM-scored "fit rating" per niche | Directly violates the binding CONTEXT.md constraint ("deterministic score, LLM narrates," "NOT an opaque LLM score") and the Out-of-Scope register ("Vision output feeding the deterministic flag/score system — architecture + trust violation") |
| construction-year proxy for stambyte | Full BRF org.nr resolution per candidate | ~Multiper-candidate SEK/latency cost that blows the existing `CAP_SEK_MAX=5`/job; only viable as an opt-in, explicitly-triggered secondary fetch, not baked into every discovery job |

**Installation:** none — no new packages.

**Version verification:** N/A (no new packages; zod/v4 and the existing toolchain are already pinned and verified in Phase 9).

## Package Legitimacy Audit

**No external packages are introduced by this phase.** The Package Legitimacy Gate is not applicable — skipping per the protocol's scope (audit is required only "whenever this phase installs external packages").

## Architecture Patterns

### System Architecture Diagram

```
                     ┌─────────────────────────────────────────┐
                     │  EXISTING Phase 9 pipeline (unchanged)   │
                     │                                          │
  fetchAreaListings()│  raw Apollo entities (per listing)       │
        │            │  constructionYear, tenureForm,           │
        │            │  breadcrumbs, price, rooms, livingArea…  │
        ▼            │                                          │
  reshapeListingEntity└──────────────────┬───────────────────────┘
        │                                │ (Phase 10: EXTEND toCandidate,
        ▼                                │  not replace — additive fields)
  ┌─────────────────────────────────────▼─────────────────────────┐
  │ toCandidate(raw) → DiscoveryCandidate + NEW facts:             │
  │   constructionYear | null, brfName | null, tenureForm | null   │
  │ (still an explicit allowlist, still no free-text/PII fields)   │
  └───────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
                     filterCandidates() [UNCHANGED — DISC-01 filter]
                                │
                                ▼
                discovery_jobs.results (JSONB, persisted ONCE per slice)
                                │
                ┌───────────────┴────────────────┐
                │   Server render (page.tsx)      │
                │   discoveryCandidateSchema       │
                │   .safeParse() read-path guard   │
                └───────────────┬────────────────┘
                                │  candidates[] (extended shape)
                                ▼
                ┌───────────────────────────────────────────┐
                │  NEW Phase 10: Client component            │
                │                                             │
                │  NicheSelector (renovation-upside |        │
                │    turnkey | imminent-stambyte)             │
                │        │                                    │
                │        ▼                                    │
                │  computeNicheScore(candidate, niche,        │
                │    areaBaseline) — PURE fn, mirrors          │
                │    computeBrfGrade/computeFlags              │
                │        │                                    │
                │        ▼                                    │
                │  sortedCandidates = candidates               │
                │    .map(c => ({c, score: computeNicheScore}))│
                │    .sort(by score desc)                      │
                │        │                                    │
                │        ▼                                    │
                │  DiscoveryCandidateCard + cited signal chips │
                │  (sourceRef-style, mirrors Flag shape)       │
                └───────────────────────────────────────────┘

   Area baseline (renovation-upside "low price/sqm vs area" signal):
   reuse existing sold-comps aggregate (src/lib/market/compare.ts) —
   computed ONCE server-side per discovery job's areaId, passed down
   as a prop, NOT recomputed per candidate.
```

Trace the primary use case: a discovery job finishes -> `page.tsx` server-renders the extended candidates -> the client `NicheSelector` defaults to one niche -> `computeNicheScore` runs once per candidate (pure, synchronous) -> cards render in score order with cited chips -> user switches niche -> the SAME candidate array is re-scored/re-sorted client-side with zero network call.

### Recommended Project Structure
```
src/lib/discovery/
├── candidate.ts          # EXTEND: add constructionYear/brfName/tenureForm to
│                          #   DiscoveryCandidate + toCandidate + discoveryCandidateSchema
├── niche-score.ts         # NEW: computeNicheScore(candidate, niche, areaBaseline)
│                          #   pure function, mirrors score.ts/flags.ts exactly
├── niche-score.test.ts    # NEW: unit tests per niche, boundary values
├── niches.ts              # NEW: the 3 niche IDs + weight tables (mirrors
│                          #   BRF_SCORE_THRESHOLDS as the single source of truth)
└── job.ts                 # touch only if area-baseline is threaded through runSlice

src/components/
├── discovery-niche-selector.tsx   # NEW: client component, niche dropdown/tabs
├── discovery-candidate-card.tsx   # EXTEND: render cited signal chips + rank position
└── discovery-results.tsx          # NEW: client component owning sort state,
                                    #   wraps NicheSelector + the candidate grid
                                    #   (page.tsx stays a server component)

supabase/migrations/
└── 012_discovery_candidate_fields.sql   # if the JSONB shape needs a comment/doc
                                          # migration (see Open Question 5 — likely NOT needed,
                                          # see resolution)
```

### Pattern 1: Deterministic score, LLM narrates (mirror `computeBrfGrade`)
**What:** A pure TypeScript function takes structured facts and a fixed threshold/weight table, returns a score plus an auditable per-signal breakdown. No Claude call, no randomness, no I/O.
**When to use:** For every niche's ranking computation.
**Example:**
```typescript
// Source: src/lib/brf/score.ts (existing codebase pattern, read directly)
export function computeBrfGrade(normalized: NormalizedBrf): BrfScoreResult {
  const breakdown: MetricBreakdown[] = [];
  const push = (key, value, weight, subScore) => {
    const isNull = subScore === null;
    const effective = isNull ? 0 : subScore;
    breakdown.push({ key, value, rating: isNull ? "not_assessable" : rate(effective), weight, contribution: weight * effective });
  };
  // ... four metrics pushed, weights sum to 1 ...
  const composite = breakdown.reduce((sum, m) => sum + m.contribution, 0);
  const grade = GRADE_BANDS.find((b) => composite >= b.min)?.grade ?? "F";
  return { grade, breakdown };
}
```
Phase 10's `computeNicheScore` should follow this EXACT shape: `{ score: number, breakdown: NicheSignalBreakdown[] }`, where each breakdown row carries `{ key, value, contribution, cited: boolean }` — never just a bare number.

### Pattern 2: Cited signal, never opaque (mirror `Flag`/`computeFlags`)
**What:** Every flag/signal carries `sourceRef` (a data-path string) plus, where the signal is text-derived, `sourceQuote`/`pageRef`/`confidence`. A null/absent source produces NO flag/signal — never a fabricated "missing = bad."
**When to use:** For every niche-score contribution the UI shows as a chip.
**Example:**
```typescript
// Source: src/lib/report/flags.ts (existing codebase pattern, read directly)
export interface Flag {
  id: string;
  severity: FlagSeverity;
  sourceRef: string;             // e.g. "candidate.constructionYear"
  sourceQuote?: string | null;   // only for text-derived signals
  pageRef?: number | null;
  confidence?: number | null;
}
```
Phase 10's per-candidate cited signal should reuse this exact interface shape (rename `FlagSeverity` usage to a niche-neutral concept, e.g. `SignalDirection: "positive" | "negative" | "neutral"`), so the UI's existing chip-rendering vocabulary (`report-flags.tsx`) can be extended rather than reinvented.

### Pattern 3: Additive-nullable persistence, no backfill
**What:** New fields on an existing JSONB/schema are always `.nullable()`/optional so pre-existing rows parse without a migration or backfill.
**When to use:** Extending `DiscoveryCandidate` with `constructionYear`/`brfName`/`tenureForm`.
**Example:**
```typescript
// Source: src/lib/discovery/candidate.ts (existing codebase pattern to extend)
export const discoveryCandidateSchema = z.object({
  address: z.string().nullable(),
  price: z.number().nullable(),
  // ... existing 7 fields unchanged ...
  constructionYear: z.number().nullable(),   // NEW, additive
  brfName: z.string().nullable(),            // NEW, additive — BRF NAME is not
                                              // occupant/seller PII (it's public
                                              // registry data, same class as
                                              // areaLabel) — safe to persist
  tenureForm: z.string().nullable(),         // NEW, additive
});
```

### Anti-Patterns to Avoid
- **Re-fetching per-candidate data on niche switch:** Defeats the entire "final pass over already-persisted candidates" framing in CONTEXT.md and reintroduces cost/latency the discovery job's cost caps were designed to bound once. Compute facts ONCE at persist time; niche switching is pure re-sort.
- **A single opaque `matchScore: number` field:** Directly violates the binding constraint ("never an opaque score") and the Phase 9 UI-SPEC's explicit "no match score, no ranking badge" line (which was deferring exactly this problem to Phase 10, not permitting an opaque version of it).
- **Minting a red/green flag from an unconfirmed proxy signal (e.g. treating "old construction year" as equivalent to "confirmed stambyte needed"):** `flags.ts`'s own `isCitationBacked` discipline shows the precedent — a signal without enough backing evidence should present as a hedged/neutral chip, not a confident verdict. The stambyte niche's construction-year proxy must be labeled as a proxy, not presented as equivalent to the BRF-confirmed signal Phase 8 produces for a single analyzed listing.
- **Running the full ENRICH-01 BRF pipeline (Allabrf search + fetch + extraction) inside `runSlice` for every candidate:** This is a per-candidate multi-second, non-trivial-SEK operation; running it ×25 per discovery job blows `CAP_SEK_MAX` by orders of magnitude and turns a sub-minute job into a multi-minute one. If ever added, it must be a separate, explicitly user-triggered, separately-capped enrichment action — not folded into the base discovery slice loop.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Area price/sqm baseline for the renovation-upside signal | A new area-average query against Booli/scraped data | The existing `fetchSoldComps` / `computePriceComparison` (`src/lib/market/compare.ts`) machinery already computes an area-level price baseline for PRICE-01 | Avoids maintaining two separate "what's normal for this area" computations that could silently disagree (mirrors `flags.ts`'s own "Threshold REUSE, never redefine" discipline for `BRF_SCORE_THRESHOLDS`) |
| Weighted composite scoring | A hand-rolled ad-hoc if/else scoring cascade per niche | The `computeBrfGrade`/`computeFlags` weighted-sum + threshold-table pattern (single source-of-truth constant object, `rate()` sub-score mapper, `push()` breakdown accumulator) | Proven, tested pattern already in the codebase; a second bespoke scoring shape increases audit surface for no benefit |
| Client-side reordering | A new state-management library (Redux/Zustand) for the niche selector | Plain `useState` + `useMemo` in a single client component (`discovery-results.tsx`) | The state is one enum (selected niche) plus a derived sort — no cross-component shared state need exists |

**Key insight:** Every "don't hand-roll" item in this phase is really the same instruction: reuse the deterministic-scoring skeleton this codebase already built twice (BRF grade, report flags). Phase 10 is the third instance of the identical pattern, not a new architecture.

## Common Pitfalls

### Pitfall 1: Assuming the persisted `DiscoveryCandidate` already has enough data
**What goes wrong:** A planner reads "rank candidates" and assumes `price`, `rooms`, `livingArea` (already persisted) are sufficient signals, then discovers mid-implementation that "renovation-upside," "turnkey," and "stambyte" all need data that was deliberately excluded (PII-safe allowlist).
**Why it happens:** The Phase 9 candidate shape looks complete for filtering (DISC-01) but was never designed for ranking (DISC-03 was explicitly deferred).
**How to avoid:** Confirmed by reading `candidate.ts`/`client.ts` directly in this research — plan Task 1 as "extend `toCandidate`'s allowlist with `constructionYear`/`brfName`/`tenureForm` from the already-fetched raw entity" BEFORE any scoring logic is written.
**Warning signs:** A plan that writes `computeNicheScore` against the CURRENT `DiscoveryCandidate` type without first touching `candidate.ts` will type-check but silently score everything as "no signal available."

### Pitfall 2: Conflating "text-only signals" with "free-text description available"
**What goes wrong:** CONTEXT.md says "TEXT-ONLY signals (no vision)" — this could be misread as "we have rich listing description text to mine for renovation keywords." In reality, the description text is explicitly EXCLUDED from `DiscoveryCandidate` (PII-safe allowlist; broker descriptions can carry seller/occupant PII per `candidate.ts`'s own doc comment).
**Why it happens:** "Text-only" in the CONTEXT.md constraint means "not vision/image-based," not "we have a text corpus to mine." The only text fields actually persisted are `address` and `areaLabel` — neither contains renovation/condition language.
**How to avoid:** Treat "text-only signals" as: numeric/enum facts (`constructionYear`, `tenureForm`, `price/livingArea` ratio) plus structured BRF facts (Phase 2/8's `stambytePlanerat` enum) — NOT free-text keyword mining over a description field that doesn't exist in the persisted shape.
**Warning signs:** A plan task that says "grep the listing description for renovation keywords" — there is no listing description in `DiscoveryCandidate` to grep.

### Pitfall 3: Treating the stambyte niche as free
**What goes wrong:** The stambyte niche sounds like "just read `stambytePlanerat` off the BRF data" — but BRF data does not exist for a raw discovery candidate. It exists only for a listing the user has fully ANALYZED (Phase 8's `runBrfExtraction`, gated behind org.nr resolution, itself gated behind a confirmed BRF name + kommun match).
**Why it happens:** The CONTEXT.md phrase "leans on Phase 2 BRF signals" reads as if the signal is already computed and just needs surfacing.
**How to avoid:** Recognize the stambyte niche requires NEW per-candidate enrichment work (org.nr resolution + document fetch + extraction) that costs real SEK/latency per candidate — not a free re-read of existing data. See Open Question 1 (RESOLVED) for the scoped v1 answer.
**Warning signs:** A plan estimate for the stambyte niche that doesn't mention Allabrf, org.nr resolution, or a new cost cap.

### Pitfall 4: Recomputing scores server-side on every niche switch
**What goes wrong:** Building a server action (`rankCandidates(jobId, niche)`) that re-reads `discovery_jobs`, recomputes, and returns a re-sorted list — adding latency and complexity for a computation with zero new data dependencies per switch.
**Why it happens:** Following the `startDiscovery`/`tickDiscovery` Server Action precedent from Phase 9 without noticing ranking has fundamentally different data-freshness requirements (facts are static once persisted; only the WEIGHTING changes per niche).
**How to avoid:** Confirm all facts needed by all three niches are present in the client-rendered candidate array (after Pitfall 1's fix) at page-load time; then niche switching is a pure `Array.prototype.sort` in a client component, no Server Action needed.
**Warning signs:** A new `src/actions/rank-discovery.ts` file — this is very likely unnecessary for the deterministic-facts-are-already-present design this research recommends.

### Pitfall 5: Silent "no signal" scoring as if it were a negative signal
**What goes wrong:** A candidate missing `constructionYear` (raw entity sometimes lacks it) scores as if "not renovation-upside" (0 contribution) rather than "not assessable," making the ranking look confident on that candidate when it shouldn't.
**Why it happens:** Weighted-sum scoring naturally treats missing=0 as good/bad.
**How to avoid:** Mirror `computeBrfGrade`'s exact discipline: a null value contributes 0 to the weighted sum with its weight still counted, AND the breakdown row is tagged `not_assessable` (not silently folded into "weak") so the UI can render "okänt" instead of implying a confirmed negative.
**Warning signs:** A `computeNicheScore` implementation with no `not_assessable`/null-handling branch mirrored from `score.ts`'s `push()` helper.

## Code Examples

### Extending `toCandidate` with the newly-captured fields (additive, zero new network calls)
```typescript
// Source: src/lib/discovery/candidate.ts (pattern to extend — this project's own code)
export interface DiscoveryCandidate {
  address: string | null;
  price: number | null;
  rooms: number | null;
  livingArea: number | null;
  areaLabel: string | null;
  thumbnailUrl: string | null;
  sourceListingUrl: string | null;
  // NEW (Phase 10) — already present on the raw Apollo entity
  // (reshapeListingEntity), captured here at zero extra cost:
  constructionYear: number | null;
  brfName: string | null;      // via brfNameFromBreadcrumbs(raw.breadcrumbs)
  tenureForm: string | null;   // "Bostadsrätt" | "Äganderätt" etc.
}

export function toCandidate(raw: Record<string, unknown>): DiscoveryCandidate {
  return {
    address: str(raw.streetAddress),
    price: num(raw.price),
    rooms: num(raw.rooms),
    livingArea: num(raw.livingArea),
    areaLabel: str(raw.descriptiveAreaName),
    thumbnailUrl: str(raw.thumbnailUrl),
    sourceListingUrl: str(raw.url),
    constructionYear: num(raw.constructionYear),
    brfName: brfNameFromBreadcrumbs(raw.breadcrumbs), // reuse client.ts's existing exported helper
    tenureForm: str(raw.tenureForm),
  };
}
```

### `computeNicheScore` skeleton (mirrors `computeBrfGrade`'s shape exactly)
```typescript
// Illustrative — new file src/lib/discovery/niche-score.ts, following the
// score.ts/flags.ts precedent read directly from this codebase.
export type NicheId = "renovation-upside" | "turnkey" | "imminent-stambyte";

export interface SignalContribution {
  key: string;                 // e.g. "pricePerSqmVsArea", "constructionYearAge"
  value: number | string | null;
  weight: number;
  contribution: number;        // weight * normalized sub-score, or 0 if not_assessable
  assessable: boolean;
  sourceRef: string;           // e.g. "candidate.constructionYear"
}

export interface NicheScoreResult {
  niche: NicheId;
  score: number;                       // [0,1] weighted composite — NEVER shown bare in UI
  breakdown: SignalContribution[];      // ALWAYS shown as cited chips instead
}

export function computeNicheScore(
  candidate: DiscoveryCandidate,
  niche: NicheId,
  areaBaseline: { medianPricePerSqm: number | null },
): NicheScoreResult {
  // Pure, synchronous, no I/O — mirrors computeBrfGrade's contract exactly.
  // Implementation detail for the planner: one weight table per niche,
  // structured identically to BRF_SCORE_THRESHOLDS.
  throw new Error("not implemented — planning stub");
}
```

### Client-side reorder on niche change (no Server Action)
```typescript
// Illustrative — new file src/components/discovery-results.tsx
"use client";
import { useMemo, useState } from "react";
import { computeNicheScore, type NicheId } from "@/lib/discovery/niche-score";
import type { DiscoveryCandidate } from "@/lib/discovery/candidate";

export function DiscoveryResults({
  candidates,
  areaBaseline,
}: {
  candidates: DiscoveryCandidate[];
  areaBaseline: { medianPricePerSqm: number | null };
}) {
  const [niche, setNiche] = useState<NicheId>("renovation-upside");

  const ranked = useMemo(
    () =>
      candidates
        .map((c) => ({ candidate: c, result: computeNicheScore(c, niche, areaBaseline) }))
        .sort((a, b) => b.result.score - a.result.score),
    [candidates, niche, areaBaseline],
  );

  // NicheSelector + ranked.map(({candidate, result}) => <DiscoveryCandidateCard
  //   candidate={candidate} nicheSignals={result.breakdown} />) …
  return null; // planning illustration only
}
```

## State of the Art

| Old Approach (Phase 9) | Current Approach (Phase 10) | When Changed | Impact |
|--------------------|------------------|---------------|--------|
| Candidates rendered in scrape order, filtered only (DISC-01) | Candidates rendered in niche-fit order, filtered AND ranked (DISC-03) | This phase | UI-SPEC's Phase 9 "no match score, no ranking badge" constraint is explicitly lifted, replaced by "cited signals, never opaque score" |
| `DiscoveryCandidate` = 7 PII-safe fields | `DiscoveryCandidate` = 10 PII-safe fields (adds constructionYear/brfName/tenureForm) | This phase | Still a documented explicit allowlist; the exact-key test in `candidate.test.ts` must be updated to the new key set, not loosened |

**Deprecated/outdated:** None — this is the first ranking implementation in the codebase; nothing is being replaced, only the Phase 9 "ranking is out of scope" note is being closed out.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `brfName` (a BRF's registered name, e.g. "Brf Björken 3") is not itself PII and is safe to add to the PII-safe allowlist, distinct from occupant/seller names | Code Examples, Standard Stack | If wrong, this would need the same no-spread/explicit-allowlist scrutiny as the other 7 fields before shipping — low risk since Phase 8 already persists `brfName` in `brf_data` for analyzed listings without treating it as PII, but this is a judgment call, not verified against a legal/GDPR source |
| A2 | `constructionYear` alone is a reasonable PROXY for "may need stambyte soon" (buildings built before ~1970 disproportionately have original stamrör) | Common Pitfalls, Summary | If the actual causal threshold differs meaningfully from common Swedish-BRF domain knowledge, the proxy signal could mis-rank; mitigated by hedging copy ("kräver BRF-analys för att bekräfta") rather than presenting as confirmed |
| A3 | The raw Apollo `constructionYear`/`tenureForm` fields are populated with useful frequency across area-search results (not just single-listing detail fetches) | Architecture Patterns, Summary | Unverified — Phase 9's `fetchAreaListings` return coverage for these two fields was not empirically measured in this research session; if sparse, the renovation-upside and turnkey niches may show many "not assessable" candidates in v1 |
| A4 | Reusing `src/lib/market/compare.ts`'s existing area price-baseline machinery for the renovation-upside "low price/sqm vs area" signal is a drop-in fit without further adaptation | Don't Hand-Roll | **[PLANNING — A4 DID NOT HOLD]** `fetchSoldComps`/`compare.ts` require a full `SoldSourceQuery` (lat/lng + breadcrumbs ladder + tier), but a `discovery_jobs` row persists NO geo query — only `filters` + the PII-safe `results` (confirmed: migration 010 + `job.ts`). So the sold-comps baseline cannot be fed from a stored job. Plan 10-02 instead computes the renovation-upside baseline as a PURE client-side `medianPricePerSqm` over the candidate set itself — this keeps the phase 100% client-side / zero-new-network / zero-new-persistence (honoring the locked "no new Server Action, no re-run, zero new scrape cost" constraint MORE strictly than the sold-comps route would have). |

**If this table is empty:** N/A — see rows above; all are flagged for confirmation during planning/discuss-phase, none block starting the phase since each has a stated safe-fallback direction.

## Open Questions

1. **How should the imminent-stambyte-where-BRF-pays niche be scoped for v1, given the full BRF-org.nr-resolution pipeline is too expensive to run per-candidate at discovery time? (RESOLVED)**
   - What we know: The full pipeline (ENRICH-01: Allabrf search by name+kommun → org.nr resolution → confidence-gated document fetch → Haiku extraction) costs real SEK + multi-second latency per candidate (confirmed by reading `fetch-brf-auto.ts`/`org-nr-resolver.ts`). Running it for 25 candidates per discovery job would push cost/latency far past the existing `CAP_SEK_MAX=5` design.
   - What's unclear: Whether users would tolerate a slower/costlier "deep rank" mode as an opt-in.
   - **Recommendation:** Ship v1 as a construction-year-based PROXY signal only (older buildings score higher on this niche), explicitly labeled in the UI as a proxy — e.g. a chip reading "Byggår {year} — kan innebära stambytesbehov, bekräfta med BRF-analys" (never "BRF betalar stambyte" as a confirmed claim). Do NOT attempt per-candidate live BRF resolution in this phase. If a later milestone wants the real signal, it should be a separate, explicitly-triggered, separately-cost-capped "deep-analyze this candidate's BRF" action reusing the exact ENRICH-01 pipeline — not baked into the base ranking pass. This keeps DISC-03 shippable within Phase 9's existing cost envelope and matches the ROADMAP's explicit permission for "a v1 subset."

2. **Is the `discoveryCandidateSchema`/`DiscoveryCandidate` shape change additive-safe against already-persisted `discovery_jobs.results` rows? (RESOLVED)**
   - What we know: `discoveryCandidateSchema.safeParse` is the read-path guard (`page.tsx`); Zod's `.nullable()` fields on a NEW key that's simply absent on an old row will fail parse only if the field is required (non-optional). A `.nullable()` (not `.optional()`) Zod field still requires the KEY to be present, even if the value can be null — an old row missing the key entirely would fail `safeParse` and the candidate would be silently dropped from view (mirroring the existing "shape-drifted row → skipped, not crashed" contract, so failure mode is safe but data-losing for old jobs).
   - What's unclear: Whether losing visibility into a handful of pre-Phase-10 discovery job candidates (already a small, ephemeral dataset — discovery jobs are user-triggered, non-critical, and the feature is still behind `DISCOVERY_ENABLED=false` in every environment per STATE.md) is an acceptable cost.
   - **Recommendation:** Make the three new fields `.nullable().optional()` (not just `.nullable()`) in `discoveryCandidateSchema`, so old rows lacking the keys still parse (`optional()` tolerates a missing key; the mapper then defaults to `null`). No backfill migration needed. This is the same additive-nullable-no-backfill posture STATE.md documents as load-bearing project convention.

3. **Does ranking need a new migration (012) at all? (RESOLVED)**
   - What we know: `discovery_jobs.results` is a JSONB column (migration 010) with no per-key DDL constraints — new keys in the candidate object require zero schema/migration change, exactly like Phase 6's `fieldSources`/`brokerFetchFailed` additive JSONB fields required no migration (STATE.md Phase 06-03 decision).
   - What's unclear: Nothing — this is a direct precedent match.
   - **Recommendation:** No migration 012 is needed for the candidate shape extension. A migration would only be needed if ranking required a NEW top-level column on `discovery_jobs` (e.g. persisting a `selected_niche` per job) — which the recommended client-side-only reorder design explicitly avoids needing. If a future decision wants to persist the user's last-selected niche per job (nice-to-have, not required by DISC-03's letter), that would be the one legitimate case for an additive nullable `discovery_jobs.selected_niche text` column — deferred as out-of-scope unless explicitly requested.

4. **Is a job-time (server) or view-time (client) ranking pass cheaper and more flexible, per the CONTEXT.md/objective's own framing? (RESOLVED)**
   - What we know: All three niches' v1-scoped signals (construction year, tenure form, brfName presence, price/sqm-vs-area-baseline) are computable from data already present in the extended `DiscoveryCandidate` object once persisted, EXCEPT the area price/sqm baseline, which needs one aggregate lookup (reusing existing sold-comps infra) per discovery job's area — not per candidate, not per niche-switch.
   - What's unclear: Whether the area baseline should be computed once at `runSlice` persist time (stored alongside `discovery_jobs`) or once at page-render time (server component, before handing to the client).
   - **Recommendation:** Compute the area baseline server-side, ONCE, at page-render time (in `page.tsx`, alongside the existing `discoveryCandidateSchema.safeParse` read-path guard) — not inside `runSlice`. This avoids a migration (no new `discovery_jobs` column) and avoids staleness (a baseline computed at job-creation time could go stale if the job runs across multiple ticks/days). Pass the baseline down as a prop to the client `DiscoveryResults` component. All niche-switch reordering after that point is 100% client-side with zero network calls — confirming the "compute facts once, reorder cheaply" design this research recommends throughout.

5. **What if text-only ranking (even with the proxy signals) doesn't visibly beat plain filtering — is there a kill criterion? (RESOLVED — explicit requirement from the research task scope)**
   - What we know: The ROADMAP frames Phases 9-12 as each carrying "an explicit kill criterion" (STATE.md). Phase 10's binding CONTEXT.md constraint requires the three niches to produce "DISTINGUISHABLE rankings for the same candidate set" — this is externally testable.
   - What's unclear: What the actual pass/fail bar looks like in practice, since it depends on real Booli area-search data coverage for `constructionYear`/`tenureForm` (Assumption A3).
   - **Recommendation (kill criterion, to be run as a UAT/validation gate before considering DISC-03 done):** Run all three niches against one real discovery job's candidate set (≥10 candidates with non-null `price`/`livingArea`). If the three niche orderings are IDENTICAL (or near-identical, e.g. same top-3) across all three niches — meaning the proxy signals aren't differentiating anything in practice — that is a signal the v1 text-only signal set is too thin to be useful, and the phase should ship FILTERING-ONLY (revert to Phase 9's unranked card grid) rather than presenting a fake sense of differentiated ranking. This must be checked manually against real data during `/gsd-verify-work`, since it depends on live-scrape field coverage this research could not empirically measure (A3).

## Environment Availability

No new external dependencies (services, CLIs, runtimes) are introduced by this phase — it is pure application code (TypeScript, React, the existing Supabase JSONB column). Skipping this section per the protocol's stated skip condition.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (existing — `vitest.config.ts`) |
| Config file | `/Users/danielwesterholm/dev/legendary-umbrella/vitest.config.ts` |
| Quick run command | `npx vitest run src/lib/discovery/niche-score.test.ts` |
| Full suite command | `npm run test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DISC-03 | `toCandidate` maps `constructionYear`/`brfName`/`tenureForm` from the raw entity, still no-spread/exact-key-safe | unit | `npx vitest run src/lib/discovery/candidate.test.ts` | ❌ Wave 0 — extend existing file |
| DISC-03 | `computeNicheScore` returns a deterministic score + breakdown for each of the 3 niches given fixed candidate fixtures | unit | `npx vitest run src/lib/discovery/niche-score.test.ts` | ❌ Wave 0 — new file |
| DISC-03 | A null/missing fact produces a `not_assessable` breakdown row, not a fabricated negative/positive contribution | unit | `npx vitest run src/lib/discovery/niche-score.test.ts` | ❌ Wave 0 — covered by above file, specific test case |
| DISC-03 | The 3 niches produce DISTINGUISHABLE orderings over the same fixed candidate fixture set (the binding CONTEXT.md constraint) | unit | `npx vitest run src/lib/discovery/niche-score.test.ts` | ❌ Wave 0 — new file, cross-niche comparison test |
| DISC-03 | `discoveryCandidateSchema` still `safeParse`s an OLD (pre-Phase-10) persisted row missing the 3 new keys (additive-optional proof) | unit | `npx vitest run src/lib/discovery/candidate.test.ts` | ❌ Wave 0 — extend existing file with an old-shape fixture |
| DISC-03 | Cited signal chips render `sourceRef`/hedge copy for the stambyte proxy, never presented as a confirmed BRF-pays claim | component (jsdom) | `npx vitest run src/components/discovery-candidate-card.test.tsx` | ❌ Wave 0 — new file (mirrors existing `discovery-progress.test.tsx` jsdom pattern) |
| DISC-03 | Niche switch reorders the client-rendered grid with no network call (no new Server Action invoked) | component (jsdom) | `npx vitest run src/components/discovery-results.test.tsx` | ❌ Wave 0 — new file |

### Sampling Rate
- **Per task commit:** `npx vitest run <touched-file>.test.ts` (quick, existing project convention per Phase 9 SUMMARY commits)
- **Per wave merge:** `npm run test` (full suite)
- **Phase gate:** Full suite green before `/gsd-verify-work`, PLUS the manual UAT kill-criterion check (Open Question 5) against one real discovery job before signing off DISC-03 as met

### Wave 0 Gaps
- [ ] `src/lib/discovery/niche-score.ts` + `src/lib/discovery/niche-score.test.ts` — new files, core scoring logic, covers DISC-03's central requirement
- [ ] `src/lib/discovery/niches.ts` — new file, the 3 niche weight tables (mirrors `BRF_SCORE_THRESHOLDS` as single source of truth)
- [ ] Extend `src/lib/discovery/candidate.ts` + `candidate.test.ts` — additive fields, additive-optional schema, exact-key test update
- [ ] `src/components/discovery-results.tsx` + `.test.tsx` — new client component owning niche state + reorder
- [ ] `src/components/discovery-candidate-card.tsx` — extend existing component + its test file for cited-signal-chip rendering
- [ ] Area price/sqm baseline threading — confirm `src/lib/market/compare.ts`'s existing baseline function signature (Assumption A4) before writing `niche-score.test.ts` fixtures that assume its shape

*(No test framework install needed — Vitest + jsdom + RTL infra already exists per Phase 8's "Component-test infra added, scoped per-file via `@vitest-environment` docblocks" decision, STATE.md.)*

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No (new) | Already enforced by the existing `/discover/[jobId]` auth+ownership gate (`page.tsx`); Phase 10 adds no new auth surface |
| V3 Session Management | No | Unchanged |
| V4 Access Control | No (new) | IDOR guard already covers `discovery_jobs` row ownership; ranking reads the same already-authorized row, no new access path |
| V5 Input Validation | Yes | `discoveryCandidateSchema.safeParse` (Zod, existing pattern) must be extended to cover the 3 new fields, with the additive-optional discipline from Open Question 2's resolution |
| V6 Cryptography | No | Not applicable — no new secrets/crypto |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| PII re-introduction via an overly-broad allowlist extension (e.g. accidentally adding a free-text description field while extending `toCandidate`) | Information Disclosure | Keep the EXACT no-spread, explicit-object-literal-construction discipline `toCandidate` already uses; extend the exact-key unit test in `candidate.test.ts` to assert the new key set is precisely `{...7 old keys, constructionYear, brfName, tenureForm}` — no more, no less |
| Presenting an unverified proxy signal (construction year) as a confirmed financial/legal claim ("BRF betalar stambyte") | Repudiation / trust violation (project-specific, not classic STRIDE) | Mirror `flags.ts`'s `isCitationBacked` discipline: an uncited/unconfirmed signal must render as hedged copy, never a confident verdict — matches the project's own MACRO-02/DISC-05 "never framed as a prediction/verdict" precedent |
| Shape-drifted old `discovery_jobs.results` rows crashing the results page after the schema extension | Denial of Service (self-inflicted) | The additive-optional Zod schema change (Open Question 2) plus the existing `safeParse`-then-skip read-path guard already covers this — verify with an explicit "old-shape fixture" unit test |

## Sources

### Primary (HIGH confidence — read directly from this codebase in this session)
- `/Users/danielwesterholm/dev/legendary-umbrella/src/lib/discovery/candidate.ts` — the current `DiscoveryCandidate` allowlist shape, `toCandidate`, `filterCandidates`
- `/Users/danielwesterholm/dev/legendary-umbrella/src/lib/discovery/job.ts` — `runSlice`'s orchestration order, incremental cap gate discipline
- `/Users/danielwesterholm/dev/legendary-umbrella/src/lib/discovery/filter-schema.ts` — `intentFilterSchema`, cost/candidate caps
- `/Users/danielwesterholm/dev/legendary-umbrella/src/lib/discovery/resolve-area.ts` — area resolution precedent (probe/seed/null pattern)
- `/Users/danielwesterholm/dev/legendary-umbrella/src/lib/booli/client.ts` — `reshapeListingEntity`, `brfNameFromBreadcrumbs`, `amenityKeys`, `fetchAreaListings` (raw entity field availability)
- `/Users/danielwesterholm/dev/legendary-umbrella/src/lib/brf/score.ts` — `computeBrfGrade`, the deterministic-score-with-breakdown pattern to mirror
- `/Users/danielwesterholm/dev/legendary-umbrella/src/lib/report/flags.ts` — `computeFlags`, `Flag`, the cited-signal pattern to mirror, `isCitationBacked`
- `/Users/danielwesterholm/dev/legendary-umbrella/src/lib/schemas/brf.ts` — `brfExtractionSchema`, `NormalizedBrf`, the Claude-supplies-facts/code-supplies-grade contract
- `/Users/danielwesterholm/dev/legendary-umbrella/src/actions/fetch-brf-auto.ts` + `src/lib/brf-source/org-nr-resolver.ts` — the real cost/complexity of BRF org.nr resolution (why per-candidate stambyte resolution is too expensive for v1)
- `/Users/danielwesterholm/dev/legendary-umbrella/src/lib/broker/fetch-broker-page.ts` + `src/lib/schemas/listing.ts` — confirms `renovationStatus`/`description` are broker-page-sourced only, not on the Apollo entity, not in `DiscoveryCandidate`
- `/Users/danielwesterholm/dev/legendary-umbrella/src/app/(app)/discover/[jobId]/page.tsx` — current results rendering, `discoveryCandidateSchema.safeParse` read-path guard
- `/Users/danielwesterholm/dev/legendary-umbrella/src/components/discovery-candidate-card.tsx` — current card, explicit "no match score, Phase 10 scope" comment
- `/Users/danielwesterholm/dev/legendary-umbrella/supabase/migrations/010_discovery_jobs.sql` — `discovery_jobs` JSONB `results` column, confirms no per-key DDL constraint
- `/Users/danielwesterholm/dev/legendary-umbrella/.planning/phases/09-discovery-foundation/09-RESEARCH.md` line 35 — "Niche ranking of candidates → Phase 10" (explicit deferral)
- `/Users/danielwesterholm/dev/legendary-umbrella/.planning/phases/09-discovery-foundation/09-PATTERNS.md` line 382 — "No match score/ranking badge (Phase 10 scope)"
- `/Users/danielwesterholm/dev/legendary-umbrella/.planning/phases/09-discovery-foundation/09-UI-SPEC.md` lines 104, 141 — explicit no-prediction/no-verdict framing carried into Phase 10
- `/Users/danielwesterholm/dev/legendary-umbrella/.planning/STATE.md` — project decisions, additive-nullable convention, cost-cap precedents, DISCOVERY_ENABLED flag status
- `/Users/danielwesterholm/dev/legendary-umbrella/.planning/REQUIREMENTS.md` — DISC-03 definition and traceability
- `/Users/danielwesterholm/dev/legendary-umbrella/.planning/phases/10-niche-ranking/10-CONTEXT.md` — binding constraints for this phase
- `/Users/danielwesterholm/dev/legendary-umbrella/vitest.config.ts` — existing test framework config

### Secondary (MEDIUM confidence)
None — no WebSearch/Context7 lookups were needed; this phase is 100% internal architecture/data-availability research with no new external library or API surface.

### Tertiary (LOW confidence)
None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages; entirely existing, already-verified toolchain
- Architecture: HIGH — read the actual persisted-candidate shape, the actual raw-entity shape, and the actual BRF-resolution cost/complexity directly from code; the "client-side reorder over server-computed facts" recommendation is a direct application of already-proven codebase patterns (`computeBrfGrade`/`computeFlags`)
- Pitfalls: HIGH for data-availability pitfalls (verified by reading code); MEDIUM for the specific niche-signal weighting/tuning (reasoned from domain conventions, not empirically validated against real Swedish BRF/listing data — flagged in the Assumptions Log and the Open Question 5 kill criterion)

**Research date:** 2026-07-07
**Valid until:** 30 days (stable — no external API/library surface to go stale; the main risk is upstream Phase 9 code changing the raw entity shape before Phase 10 executes)
