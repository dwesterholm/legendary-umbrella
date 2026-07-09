# Phase 10: Niche Ranking - Pattern Map

**Mapped:** 2026-07-07
**Files analyzed:** 7 (2 extend, 5 new)
**Analogs found:** 7 / 7

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/lib/discovery/candidate.ts` (extend) | model/mapper | transform (allowlist mapping) | itself (existing `toCandidate`/`discoveryCandidateSchema`) | exact — extend in place |
| `src/lib/discovery/candidate.test.ts` (extend) | test | transform | itself (existing tests) | exact — extend in place |
| `src/lib/discovery/niches.ts` | config | transform (constants) | `src/lib/brf/score.ts` `BRF_SCORE_THRESHOLDS` | exact |
| `src/lib/discovery/niche-score.ts` | service (pure scorer) | transform | `src/lib/brf/score.ts` `computeBrfGrade` + `src/lib/report/flags.ts` `computeFlags`/`Flag` | exact |
| `src/lib/discovery/niche-score.test.ts` | test | transform | `src/lib/brf/score.test.ts` (score-table pattern), `candidate.test.ts` (fixture style) | role-match |
| `src/components/discovery-niche-selector.tsx` | component | request-response (client state) | Phase 9 filter `Select` usage (area/rooms filter row) | role-match |
| `src/components/discovery-candidate-card.tsx` (extend) | component | request-response | itself + `src/components/report-flags.tsx` `ReportFlags` (chip rendering) | exact (self) / exact (chip pattern) |
| `src/components/discovery-results.tsx` | component (client, stateful) | transform (client-side reorder) | none direct — composition of `discovery-niche-selector.tsx` + `discovery-candidate-card.tsx`; state-shape mirrors CONTEXT/RESEARCH illustrative skeleton | new pattern (composition only) |
| `src/app/(app)/discover/[jobId]/page.tsx` (extend) | route (server component) | request-response | itself (existing read-path guard + render) | exact — extend in place |
| Area baseline lookup (used inside `page.tsx`, threaded as prop) | service (reused) | CRUD/aggregate | `src/lib/market/compare.ts` `computePriceComparison`/`PRICE_COMPARISON_THRESHOLDS` | role-match (reuse, do not reinvent) |

**No migration required** — confirmed: `discovery_jobs.results` is JSONB (migration 010), no per-key DDL. New `DiscoveryCandidate` fields are additive/optional keys inside that JSONB blob; Zod schema change only (see Pitfall/Open-Question 2/3 in RESEARCH.md — resolved: `.nullable().optional()`, no migration 012, no backfill).

---

## Pattern Assignments

### `src/lib/discovery/candidate.ts` (extend) — model/mapper

**Analog:** itself, existing `toCandidate` (lines 42-52) + `discoveryCandidateSchema` (lines 63-71); source data already computed by `src/lib/booli/client.ts` `reshapeListingEntity` (lines 171-228).

**Current interface + mapper to extend** (`candidate.ts:19-52`):
```typescript
export interface DiscoveryCandidate {
  address: string | null;
  price: number | null;
  rooms: number | null;
  livingArea: number | null;
  areaLabel: string | null;
  thumbnailUrl: string | null;
  sourceListingUrl: string | null;
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
  };
}
```

**Extend to** (still no-spread, explicit object literal — the `toCandidate` doc comment at lines 29-41 is load-bearing and must be updated, not just the code):
```typescript
export interface DiscoveryCandidate {
  // ...existing 7 fields unchanged...
  constructionYear: number | null;
  brfName: string | null;
  tenureForm: string | null;
}

export function toCandidate(raw: Record<string, unknown>): DiscoveryCandidate {
  return {
    // ...existing 7 fields unchanged...
    constructionYear: num(raw.constructionYear),
    brfName: str(raw.brfName),   // raw.brfName is ALREADY computed by
                                  // reshapeListingEntity (client.ts:227) via
                                  // brfNameFromBreadcrumbs — do NOT re-derive
                                  // from raw.breadcrumbs here; toCandidate's
                                  // input is the post-reshape flat record,
                                  // which already has `brfName` as a plain
                                  // string field (client.ts:227). Only import
                                  // brfNameFromBreadcrumbs directly if a call
                                  // site ever passes a pre-reshape entity.
    tenureForm: str(raw.tenureForm),
  };
}
```

**Read-path Zod schema to extend** (`candidate.ts:63-71`) — use `.nullable().optional()` per RESEARCH.md Open Question 2 (resolved), NOT bare `.nullable()`, so old persisted rows missing the keys still `safeParse`:
```typescript
export const discoveryCandidateSchema = z.object({
  // ...existing 7 fields unchanged (still bare .nullable())...
  constructionYear: z.number().nullable().optional(),
  brfName: z.string().nullable().optional(),
  tenureForm: z.string().nullable().optional(),
});
```

**Doc comment update required:** the class doc at lines 11-18 says "only these seven fields may ever land in `discovery_jobs.results`" — update the count/enumeration to ten and add one sentence justifying `brfName` as public-registry data, not occupant/seller PII (mirrors RESEARCH.md Assumption A1).

---

### `src/lib/discovery/candidate.test.ts` (extend) — test

**Analog:** itself.

**Exact-key allowlist test to update** (`candidate.test.ts:6-14, 35`):
```typescript
const ALLOWLIST_KEYS = [
  "address", "price", "rooms", "livingArea", "areaLabel",
  "thumbnailUrl", "sourceListingUrl",
  // ADD:
  "constructionYear", "brfName", "tenureForm",
].sort();
// ... expect(Object.keys(result).sort()).toEqual(ALLOWLIST_KEYS);
```
Also extend the "maps the flat reshapeListingEntity field names" test (lines 38-60) with the 3 new raw keys, and add a NEW test case per Open Question 2: an old-shape fixture object missing the 3 new keys entirely must still `discoveryCandidateSchema.safeParse` successfully (proves the `.optional()` choice, not just `.nullable()`).

---

### `src/lib/discovery/niches.ts` (new) — config

**Analog:** `src/lib/brf/score.ts` `BRF_SCORE_THRESHOLDS` (lines 25-57) — single source-of-truth weight/threshold table pattern.

**Pattern to copy** (structure, not values):
```typescript
// Source: src/lib/brf/score.ts:25-57
export const BRF_SCORE_THRESHOLDS = {
  skuldPerKvm: {
    weight: 0.35,
    strongMax: 5000,
    midMax: 8500,
    weakMax: 12000,
  },
  // ...three more metrics, weights sum to 1...
} as const;
```
Apply the same shape for `NICHE_WEIGHTS`: one entry per `NicheId` ("renovation-upside" | "turnkey" | "imminent-stambyte"), each a small object of per-signal weights that sum to 1, with named threshold constants (e.g. `stambyteProxyYearCutoff: 1970`) — never a magic number inline in `niche-score.ts`. This is the file the public methodology copy (if any, mirrors D-09 "Så räknar vi" precedent) would cite.

---

### `src/lib/discovery/niche-score.ts` (new) — service (pure scorer)

**Analog 1 (score+breakdown shape):** `src/lib/brf/score.ts` `computeBrfGrade` (lines 162-220), specifically the `push()` accumulator pattern (lines 165-180) and the null→`not_assessable` discipline (lines 171-172, 176).

**Core pattern to copy — `push()` accumulator + null-safe scoring**:
```typescript
// Source: src/lib/brf/score.ts:162-180
export function computeBrfGrade(normalized: NormalizedBrf): BrfScoreResult {
  const breakdown: MetricBreakdown[] = [];

  const push = (
    key: BrfMetricKey,
    value: number | UnderhallsplanStatus | null,
    weight: number,
    subScore: number | null,
  ): void => {
    const isNull = subScore === null;
    const effective = isNull ? 0 : subScore;
    breakdown.push({
      key,
      value,
      rating: isNull ? "not_assessable" : rate(effective),
      weight,
      contribution: weight * effective,
    });
  };
  // ...call push() once per metric...
  const composite = breakdown.reduce((sum, m) => sum + m.contribution, 0);
  return { grade: /* band lookup */, breakdown };
}
```

**Analog 2 (cited-signal shape):** `src/lib/report/flags.ts` `Flag` interface (lines 64-71) + `computeFlags` (lines 138-263) — the `sourceRef`/`sourceQuote`/`confidence` shape and the "null source → no flag, never a fabricated negative" discipline (module doc lines 21-23; `isCitationBacked` lines 116-129).

**Interface to mirror**:
```typescript
// Source: src/lib/report/flags.ts:64-71
export interface Flag {
  id: string;
  severity: FlagSeverity;      // "red" | "green" | "neutral"
  sourceRef: string;
  sourceQuote?: string | null;
  pageRef?: number | null;
  confidence?: number | null;
}
```
Per RESEARCH.md's `SignalContribution`/`NicheScoreResult` skeleton (already drafted — copy verbatim as the target shape):
```typescript
export interface SignalContribution {
  key: string;
  value: number | string | null;
  weight: number;
  contribution: number;
  assessable: boolean;         // mirrors "not_assessable" rating from score.ts
  sourceRef: string;           // e.g. "candidate.constructionYear" — mirrors Flag.sourceRef
}

export interface NicheScoreResult {
  niche: NicheId;
  score: number;                       // internal only — NEVER rendered bare (UI-SPEC binding constraint)
  breakdown: SignalContribution[];      // ALWAYS what the UI renders, as cited chips
}
```

**Hedged proxy discipline (stambyte niche)** — mirror `flags.ts`'s `isCitationBacked` gate (lines 122-129) and the module's own warning about not minting an unconfirmed signal into a confident verdict (flags.ts module doc lines 25-29, `STAMBYTE_PLANERAT` vs the raw BRF-confirmed enum at lines 230-257). The construction-year proxy in `niche-score.ts` must produce a `SignalContribution` whose downstream chip copy is explicitly hedged ("kan innebära stambytesbehov, bekräfta med BRF-analys" — see 10-UI-SPEC.md Copywriting Contract), never the confirmed `STAMBYTE_PLANERAT` label/severity `flags.ts` uses for an actual BRF-extracted signal. Do not reuse `FLAG_IDS.STAMBYTE_PLANERAT` for the proxy — mint a distinct niche-signal key (e.g. `"stambyteProxyAge"`) so the two are never conflated in code or on screen.

**Area-baseline dependency:** `computeNicheScore`'s third parameter (`areaBaseline: { medianPricePerSqm: number | null }`) is produced by reusing `src/lib/market/compare.ts`'s existing aggregate machinery (`PRICE_COMPARISON_THRESHOLDS`, `computePriceComparison` — see `compare.ts:32-61` for the threshold-table pattern already used for the analogous "is this price normal for the area" computation in PRICE-01). Do not hand-roll a second area-average query — reuse `compare.ts`'s comp-fetch path, computed once per job at page-render time (RESEARCH.md Open Question 4, resolved: server-side, in `page.tsx`, not in `runSlice`).

---

### `src/lib/discovery/niche-score.test.ts` (new) — test

**Analog:** `candidate.test.ts`'s fixture-array + `describe`/`it` structure (lines 1-158); assertion style for deterministic pure functions mirrors `src/lib/brf/score.ts`'s implied test contract (same-input-same-output, boundary values at threshold edges — see `BRF_SCORE_THRESHOLDS` boundary comments at score.ts:29-31 for the boundary-testing convention: `< strongMax` vs `<= weakMax` inclusive/exclusive edges must each get a test case).

Required test cases (from RESEARCH.md Validation Architecture, Wave 0 Gaps):
1. Deterministic score+breakdown per niche given fixed candidate fixtures.
2. A null/missing fact (e.g. `constructionYear: null`) produces `assessable: false`, contribution `0`, NOT a fabricated positive/negative — mirrors `score.ts`'s `not_assessable` test discipline.
3. The 3 niches produce DISTINGUISHABLE orderings over the same fixed candidate set (binding CONTEXT.md constraint) — a cross-niche comparison test, e.g. assert `sortByNiche(candidates, "turnkey")` !== `sortByNiche(candidates, "imminent-stambyte")` order for a fixture set with varied `constructionYear`/`tenureForm`.

---

### `src/components/discovery-niche-selector.tsx` (new) — component

**Analog:** the existing Phase 9 filter-row `Select` usage pattern (area/rooms filter, per 10-UI-SPEC.md's explicit citation "same contract as Phase 9's 'Antal rum' filter"). Reuse `src/components/ui/select.tsx` (already installed, no new shadcn add).

Structure per UI-SPEC Component Inventory §1: `flex items-center gap-3` row, label (`text-xs font-medium uppercase tracking-wider text-warm-gray-500`) + `Select` (`w-64`). Options fixed order: `"none" | "renovation-upside" | "turnkey" | "imminent-stambyte"`, Swedish labels from the Copywriting Contract table. `"use client"` component; lifts selected niche via a controlled prop/callback (owned by `discovery-results.tsx`, not internal state — mirrors the RESEARCH.md illustrative skeleton where `useState` for `niche` lives in the parent).

---

### `src/components/discovery-candidate-card.tsx` (extend) — component

**Analog (self, base shell):** itself, unchanged `Card`/`Link` shell (lines 28-80) — do not restyle existing metrics row, footer, or hover treatment.

**Analog (cited-signal chip block to graft in):** `src/components/report-flags.tsx` `ReportFlags` — specifically the `<li>` chip markup (lines 121-148) and the `Badge`+"Källa: {sourceLabel}" caption pattern (lines 125-140):
```typescript
// Source: src/components/report-flags.tsx:121-148
<li
  key={flag.id}
  className="flex flex-col gap-1.5 rounded-lg border border-warm-gray-100 bg-warm-gray-50 p-3"
>
  <div className="flex flex-wrap items-center gap-2">
    <Badge variant="secondary" className={cn("border", severityChip(flag.severity))}>
      {label}
    </Badge>
    <span className="text-xs text-warm-gray-500">
      Källa: {sourceLabel}
      {typeof flag.pageRef === "number" && flag.pageRef ? ` (sid ${flag.pageRef})` : ""}
      {typeof flag.confidence === "number" ? ` · Säkerhet ${Math.round(flag.confidence * 100)}%` : ""}
    </span>
  </div>
  {hasCitation && (
    <blockquote className="border-l-2 border-warm-gray-200 pl-3 text-sm italic text-warm-gray-700">
      {flag.sourceQuote}
    </blockquote>
  )}
</li>
```
Per UI-SPEC §Color/Component Inventory §2: niche-signal chips are ALWAYS `bg-warm-gray-50`/severity-neutral (never the sage/red/terracotta `severityChip()` mapping `report-flags.tsx` uses for BRF flags — niche signals are explanatory facts, not verdicts). Cap shown chips at ~3 per card (UI-SPEC §Component Inventory §2). No-signal state renders the italic `"Inga tydliga signaler för denna sortering"` caption in the same position (mirrors `BrfScoreCard`'s "Ej tillgänglig" treatment, not read directly in this pass but cited identically in UI-SPEC).

**New rank badge** (only when niche !== "none"), sage `Badge` in `CardHeader`, `flex items-center gap-2` beside the address `CardTitle` (existing `CardHeader` block at lines 31-38) — plain ordinal "#{n}", never a color gradient by rank (UI-SPEC §Component Inventory §2, binding "no color-coded good/bad" constraint).

**Props to add:** `rankPosition?: number | null` and `nicheSignals?: SignalContribution[]` (from `niche-score.ts`), both optional so the existing Phase 9 call site (unranked, no niche selected) needs zero changes — this is what makes the extension additive rather than breaking.

---

### `src/components/discovery-results.tsx` (new) — component (client, stateful)

**Analog:** no direct existing analog (first client-side-reorder component in the codebase) — closest structural precedent is the RESEARCH.md-drafted skeleton itself (already vetted against `computeBrfGrade`'s pure-function contract) plus the existing `DiscoveryProgress` client component for "how a client component receives server-fetched data as props and owns local UI state" (polling pattern differs, but the props-in/local-state-out shape is the same family).

**Skeleton to implement from** (RESEARCH.md Code Examples, already drafted, copy this shape):
```typescript
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
  const [niche, setNiche] = useState<NicheId | "none">("none");

  const ranked = useMemo(
    () =>
      niche === "none"
        ? candidates.map((c) => ({ candidate: c, result: null }))
        : candidates
            .map((c) => ({ candidate: c, result: computeNicheScore(c, niche, areaBaseline) }))
            .sort((a, b) => (b.result?.score ?? 0) - (a.result?.score ?? 0)),
    [candidates, niche, areaBaseline],
  );

  // Degenerate-set check (UI-SPEC §Component Inventory §3): candidates.length < 3
  // -> render the terracotta soft-warning banner instead of the normal sub-line,
  // keep original (unranked) order, no rank badges.

  return (
    <div className="w-full max-w-4xl">
      {/* DiscoveryNicheSelector + ranking sub-line/banner */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {ranked.map(({ candidate, result }, i) => (
          <DiscoveryCandidateCard
            key={candidate.sourceListingUrl ?? i}
            candidate={candidate}
            rankPosition={niche !== "none" ? i + 1 : null}
            nicheSignals={result?.breakdown.slice(0, 3) ?? []}
          />
        ))}
      </div>
    </div>
  );
}
```
Owns: selected niche, the degenerate-set banner logic (UI-SPEC §Component Inventory §3), and the ranking-error fallback (wrap the `computeNicheScore` map in a try/catch per UI-SPEC's "Ranking computation error" state — degrade to the Phase 9 unranked grid, never block rendering entirely). `key` MUST be a stable candidate identity (`sourceListingUrl`), not array index post-sort, so React actually re-renders the visible DOM order (UI-SPEC §Cross-cutting "Visible reorder requirement").

---

### `src/app/(app)/discover/[jobId]/page.tsx` (extend) — route (server component)

**Analog:** itself — the existing read-path guard (lines 67-76) and results-grid render block (lines 91-98) are what gets extended/replaced.

**Current block to replace** (`page.tsx:91-98`):
```typescript
{isTerminal && job.status === "done" && candidates.length > 0 && (
  <div className="w-full max-w-4xl">
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {candidates.map((candidate, i) => (
        <DiscoveryCandidateCard key={i} candidate={candidate} />
      ))}
    </div>
  </div>
)}
```
Replace with `<DiscoveryResults candidates={candidates} areaBaseline={areaBaseline} />`, where `areaBaseline` is computed server-side once (RESEARCH.md Open Question 4, resolved) by calling into the reused `src/lib/market/compare.ts` aggregate machinery keyed on the job's resolved area — added as a new `const areaBaseline = ...` line alongside the existing `discoveryCandidateSchema.safeParse` guard block (lines 67-76), NOT inside `runSlice`/`job.ts`. The existing `discoveryCandidateSchema.safeParse` mapping (lines 71-76) needs zero structural change — it already produces `DiscoveryCandidate[]` and will pick up the 3 new nullable/optional fields automatically once `candidate.ts`'s schema is extended.

**Everything else in `page.tsx` (auth/ownership guard lines 36-61, empty-state lines 101-112, error-state lines 114-128) is unchanged** — Phase 10 only touches the "done + candidates.length > 0" render branch.

---

## Shared Patterns

### Deterministic score + auditable breakdown
**Source:** `src/lib/brf/score.ts:162-220` (`computeBrfGrade`)
**Apply to:** `src/lib/discovery/niche-score.ts` — the `push()`-accumulator, null→`not_assessable` (never silently negative), weight-sums-to-1 discipline.

### Cited signal, never opaque
**Source:** `src/lib/report/flags.ts:64-71` (`Flag`), `:116-129` (`isCitationBacked`)
**Apply to:** `niche-score.ts`'s `SignalContribution` shape and `discovery-candidate-card.tsx`'s chip rendering — every displayed signal carries a `sourceRef`; an absent/null fact yields no chip, never a fabricated negative.

### Single source-of-truth threshold table
**Source:** `src/lib/brf/score.ts:25-57` (`BRF_SCORE_THRESHOLDS`), `src/lib/market/compare.ts:32-61` (`PRICE_COMPARISON_THRESHOLDS`)
**Apply to:** `src/lib/discovery/niches.ts` (`NICHE_WEIGHTS`) — one exported const object, no magic numbers duplicated in `niche-score.ts` or the UI layer.

### PII-safe explicit allowlist, no-spread construction
**Source:** `src/lib/discovery/candidate.ts:11-18, 33-37` (doc comments), `:42-52` (`toCandidate`)
**Apply to:** extending `toCandidate` — always an explicit object literal, never `{...raw}`; update the exact-key test in `candidate.test.ts` in lockstep.

### Additive-nullable-optional JSONB extension, no migration/backfill
**Source:** `src/lib/discovery/candidate.ts:63-71` (existing bare `.nullable()` fields), STATE.md Phase 06-03 precedent (`fieldSources`/`brokerFetchFailed`)
**Apply to:** the 3 new `discoveryCandidateSchema` fields — use `.nullable().optional()` (not bare `.nullable()`) so pre-Phase-10 persisted rows still parse without a migration.

### Independent-degradation on computation failure
**Source:** UI-SPEC's cited precedent "LSTG-04's broker-fetch-never-fails-primary-analysis"; structurally mirrors `page.tsx`'s existing `safeParse`-then-skip guard (lines 71-76)
**Apply to:** `discovery-results.tsx` — a thrown/malformed `computeNicheScore` result degrades to the Phase 9 unranked grid plus an error banner, never a crashed results page.

### Cost-cap discipline / no new Server Action
**Source:** RESEARCH.md Pitfall 4, Anti-Patterns section; contrasted with Phase 9's `startDiscovery`/`tickDiscovery` Server Action precedent
**Apply to:** confirm NO new file under `src/actions/` is created for ranking — niche switching is 100% client-side `useMemo`/`sort`, zero network round-trip.

---

## No Analog Found

None — every file to create/modify has at least a role-match analog above. The only genuinely novel piece is `discovery-results.tsx`'s composition-and-state-ownership role, which is new to the codebase but is explicitly speced in RESEARCH.md's Code Examples section (already vetted, not left to invention).

## Metadata

**Analog search scope:** `src/lib/discovery/`, `src/lib/brf/`, `src/lib/report/`, `src/lib/market/`, `src/lib/booli/`, `src/components/`, `src/app/(app)/discover/`
**Files scanned:** `candidate.ts`, `candidate.test.ts`, `job.ts` (name only), `score.ts`, `flags.ts`, `compare.ts` (partial), `client.ts` (partial), `discovery-candidate-card.tsx`, `report-flags.tsx`, `page.tsx` (discover/[jobId])
**Pattern extraction date:** 2026-07-07
