"use client";

import { useMemo, useState } from "react";
import { DiscoveryNicheSelector } from "@/components/discovery-niche-selector";
import { DiscoveryCandidateCard } from "@/components/discovery-candidate-card";
import { GalleryConditionVision } from "@/components/gallery-condition-vision";
import { pricePerSqm, type DiscoveryCandidate } from "@/lib/discovery/candidate";
import { conditionScore } from "@/lib/discovery/condition-score";
import {
  computeNicheScore,
  type NicheScoreResult,
} from "@/lib/discovery/niche-score";
import { NICHE_IDS, type NicheId } from "@/lib/discovery/niches";

interface DiscoveryResultsProps {
  candidates: DiscoveryCandidate[];
}

/** Minimum candidate-set size for a ranking to be considered meaningful. */
const MIN_RANKABLE_CANDIDATES = 3;
/** Minimum usable (price + livingArea>0) candidates for a median baseline. */
const MIN_BASELINE_SAMPLE = 3;

const NICHE_LABELS: Record<NicheId, string> = {
  "renovation-upside": "Renoveringspotential",
  turnkey: "Inflyttningsklar",
  "imminent-stambyte": "Stambyte planerat — föreningen betalar",
};

interface RankedEntry {
  candidate: DiscoveryCandidate;
  result: NicheScoreResult | null;
}

/**
 * Computes a pure, client-side median price/sqm over the candidate set
 * itself.
 *
 * DEVIATION from RESEARCH.md Open Question 4 / 10-PATTERNS.md's page.tsx
 * plan (server-side `compare.ts`/`fetchSoldComps` reuse): a discovery job
 * persists NO lat/lng or breadcrumbs — only `filters` + the PII-safe
 * `results` allowlist (confirmed in migration 010 + job.ts) — so
 * `compare.ts`'s `computePriceComparison`/`fetchSoldComps` CANNOT be fed a
 * `SoldSourceQuery` from a stored job. RESEARCH Assumption A4 ("baseline
 * computed once server-side/at render, passed as a prop") does not hold.
 * Instead, the "area" baseline here is a pure median over the CANDIDATE SET
 * ITSELF — zero new network, zero new geo persistence, strictly honoring
 * the "no new Server Action, no re-run, zero new scrape cost" constraint
 * MORE strictly than the originally-planned route would have.
 *
 * Returns `null` when fewer than `MIN_BASELINE_SAMPLE` candidates have a
 * usable price+livingArea pair (thin-sample honesty, mirrors compare.ts's
 * own null-on-insufficient-sample discipline).
 */
function computeAreaBaseline(candidates: DiscoveryCandidate[]): {
  medianPricePerSqm: number | null;
} {
  const perSqm = candidates
    .map((c) => pricePerSqm(c))
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);

  if (perSqm.length < MIN_BASELINE_SAMPLE) {
    return { medianPricePerSqm: null };
  }

  const mid = Math.floor(perSqm.length / 2);
  const median =
    perSqm.length % 2 === 0 ? (perSqm[mid - 1] + perSqm[mid]) / 2 : perSqm[mid];

  return { medianPricePerSqm: median };
}

/**
 * `DiscoveryResults` — the client-side reorder owner for DISC-03. Owns the
 * selected niche, re-sorts the ALREADY-PERSISTED candidates in a `useMemo`
 * on niche change (zero network, no new Server Action, no job re-run), and
 * renders the degenerate/error banners per the UI-SPEC.
 *
 * Card `key` is the stable `candidate.sourceListingUrl` (never the post-sort
 * array index) so React actually re-orders the visible DOM (UI-SPEC
 * "visible reorder requirement").
 */
export function DiscoveryResults({ candidates }: DiscoveryResultsProps) {
  const [niche, setNiche] = useState<NicheId | "none">("none");

  const areaBaseline = useMemo(() => computeAreaBaseline(candidates), [candidates]);

  const isDegenerate = candidates.length < MIN_RANKABLE_CANDIDATES;

  const { ranked, hasError } = useMemo((): {
    ranked: RankedEntry[];
    hasError: boolean;
  } => {
    if (niche === "none" || isDegenerate) {
      return {
        ranked: candidates.map((candidate) => ({ candidate, result: null })),
        hasError: false,
      };
    }

    try {
      const scored = candidates.map((candidate) => ({
        candidate,
        result: computeNicheScore(candidate, niche, areaBaseline),
      }));
      // Primary: the deterministic niche score. Secondary (TIEBREAKER ONLY):
      // the vision-derived conditionScore, so genuine renovation objects rise
      // above turnkey flats with the same niche score. Kept OFF the
      // computeNicheScore path (locked structural-separation constraint) —
      // vision only breaks ties for display ordering here.
      scored.sort((a, b) => {
        const nicheDiff = (b.result?.score ?? 0) - (a.result?.score ?? 0);
        if (nicheDiff !== 0) return nicheDiff;
        return conditionScore(b.candidate) - conditionScore(a.candidate);
      });
      return { ranked: scored, hasError: false };
    } catch {
      return {
        ranked: candidates.map((candidate) => ({ candidate, result: null })),
        hasError: true,
      };
    }
  }, [candidates, niche, areaBaseline, isDegenerate]);

  const rankable = niche !== "none" && !isDegenerate && !hasError;

  // WR-01: `isDegenerate` (total candidate count) and `MIN_BASELINE_SAMPLE`
  // (usable price+livingArea pairs) measure different populations — a
  // ranking can proceed (isDegenerate is false) while the price/sqm
  // baseline is still unavailable, silently collapsing renovation-upside to
  // its constructionYearAge-only signal. Surface that honestly rather than
  // only inferring it from the per-card chip list.
  const baselineThinForActiveNiche =
    rankable && niche === "renovation-upside" && areaBaseline.medianPricePerSqm === null;

  return (
    <div className="w-full max-w-4xl space-y-4">
      {candidates.length > 0 && (
        <div className="space-y-2">
          <DiscoveryNicheSelector value={niche} onChange={setNiche} />

          {hasError && (
            <div className="rounded-lg bg-terracotta-50 px-4 py-3">
              <p className="text-sm text-terracotta-600">
                Rangordningen kunde inte beräknas just nu. Kandidaterna visas i
                ursprunglig ordning.
              </p>
            </div>
          )}

          {!hasError && niche !== "none" && isDegenerate && (
            <div className="rounded-lg bg-terracotta-50 px-4 py-3">
              <p className="text-sm text-terracotta-600">
                För få träffar för att rangordna meningsfullt — visar dem i
                ursprunglig ordning.
              </p>
            </div>
          )}

          {!hasError && rankable && (
            <p className="text-sm text-warm-gray-500">
              Rangordnat efter: {NICHE_LABELS[niche]}. Ordningen baseras på
              tecken i annonsen — ingen förutsägelse.
            </p>
          )}

          {!hasError && baselineThinForActiveNiche && (
            <p className="text-sm text-warm-gray-500">
              Prisjämförelse saknas för denna sökning — för få annonser med
              pris och boarea för att beräkna ett områdesgenomsnitt.
              Rangordningen baseras enbart på byggår.
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {ranked.map(({ candidate, result }, i) => (
          <DiscoveryCandidateCard
            key={candidate.sourceListingUrl ?? i}
            candidate={candidate}
            rankPosition={rankable ? i + 1 : null}
            nicheSignals={rankable ? (result?.breakdown ?? []) : undefined}
          />
        ))}
      </div>

      {/*
        WR-01 (11-REVIEW.md) fix: the grid (line 168) and this vision wrapper
        are both direct children of the OUTER `space-y-4` container (the top
        of this component) — `space-y-6` alone only governs spacing BETWEEN
        each GalleryConditionVision card inside THIS div, not the gap ABOVE
        it. `mt-6` is the required minimum 24px visual break BETWEEN the
        ranking grid and the vision section itself (11-UI-SPEC.md Component
        Inventory §1 — "verified/ranked facts first, then hedged image
        interpretation," explicitly a REQUIRED minimum reinforcing the
        structural-separation constraint, not merely aesthetic). `vision`/
        `visionSkippedReason` are read directly off each candidate; NEITHER
        value is threaded into `computeNicheScore`/`rankPosition`/
        `nicheSignals` above (structural-separation invariant, T-11-11).

        Phase 12 (DISC-06) additionally threads `latitude`/`longitude`/
        `floor`/`orientation` from each candidate into `GalleryConditionVision`
        for its embedded `SunPathExposure` sub-block ONLY — these four values
        are likewise NEVER fed into `computeNicheScore`/`rankPosition`/
        `nicheSignals` above (T-12-09, the structural-separation invariant
        extended in niche-score.test.ts to also forbid a `sun-path` import).
      */}
      <div className="mt-6 space-y-6">
        {ranked.map(({ candidate }, i) => (
          <GalleryConditionVision
            key={candidate.sourceListingUrl ?? `vision-${i}`}
            vision={candidate.vision}
            visionSkippedReason={candidate.visionSkippedReason}
            latitude={candidate.latitude}
            longitude={candidate.longitude}
            floor={candidate.floor}
            orientation={candidate.orientation}
          />
        ))}
      </div>
    </div>
  );
}

// Re-exported for tests / potential future reuse without changing NICHE_IDS's
// own export surface in niches.ts.
export { NICHE_IDS };
