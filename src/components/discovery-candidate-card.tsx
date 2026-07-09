import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { pricePerSqm, type DiscoveryCandidate } from "@/lib/discovery/candidate";
import {
  NICHE_SIGNAL_LABELS,
  NICHE_SIGNAL_SOURCE_LABELS,
  type SignalContribution,
} from "@/lib/discovery/niche-score";
import { formatSEK } from "@/lib/utils";

interface DiscoveryCandidateCardProps {
  candidate: DiscoveryCandidate;
  /**
   * 1-indexed rank position within the currently active niche ordering.
   * Optional/nullable — omit or pass `null` to render the base Phase 9 card
   * (no badge). Only rendered when a niche other than "none" is active.
   */
  rankPosition?: number | null;
  /**
   * The cited signals that drove this candidate's rank under the active
   * niche (from `computeNicheScore`'s `breakdown`). Optional — the existing
   * Phase 9 call site passes neither this nor `rankPosition`, so the card
   * renders identically to before (additive extension).
   */
  nicheSignals?: SignalContribution[];
}

/**
 * `DiscoveryCandidateCard` — modeled on `AnalysisCard`, but for a PII-safe
 * discovery result. Renders ONLY the allowlisted `DiscoveryCandidate` fields
 * (09-UI-SPEC.md line 141 / T-09-05) plus, additively (Phase 10/DISC-03), an
 * optional ordinal rank badge and up to 3 cited-signal chips reusing
 * `ReportFlags`' exact chip vocabulary — NEVER an opaque numeric/percentage
 * score. Every candidate carries the "Källa: Booli" provenance caption since
 * candidates are scraped, never fabricated.
 *
 * `rankPosition`/`nicheSignals` are both OPTIONAL so the Phase 9 call site
 * (unranked, no niche selected) needs zero changes — this keeps the
 * extension additive rather than breaking.
 *
 * No analysis id exists yet for a raw discovery candidate (Phase 9 is
 * retrieval-only) — "Se full analys" routes to the single-URL flow
 * pre-filled with the candidate's source listing URL rather than fabricating
 * a link to a non-existent `/analysis/[id]`.
 */
export function DiscoveryCandidateCard({
  candidate,
  rankPosition,
  nicheSignals,
}: DiscoveryCandidateCardProps) {
  const href = candidate.sourceListingUrl
    ? `/dashboard?url=${encodeURIComponent(candidate.sourceListingUrl)}`
    : "/dashboard";

  const hasRank = typeof rankPosition === "number";
  const nicheActive = nicheSignals !== undefined;
  const assessableSignals = (nicheSignals ?? []).filter((s) => s.assessable);
  const shownSignals = assessableSignals.slice(0, 3);

  return (
    <Link href={href} className="group block">
      <Card className="h-full border-warm-gray-200 bg-warm-white transition-all duration-200 group-hover:shadow-md group-hover:border-sage-200">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            {hasRank && (
              <Badge className="bg-sage-600 text-white shrink-0">
                #{rankPosition}
              </Badge>
            )}
            <CardTitle className="text-base font-semibold text-warm-gray-900 line-clamp-2">
              {candidate.address ?? "---"}
            </CardTitle>
          </div>
          {candidate.areaLabel && (
            <p className="text-sm text-warm-gray-500">{candidate.areaLabel}</p>
          )}
        </CardHeader>

        <CardContent className="space-y-3">
          <p className="text-lg font-semibold text-warm-gray-900">
            {candidate.price !== null ? formatSEK(candidate.price) : "---"}
          </p>

          <div className="grid grid-cols-3 gap-2 text-sm">
            <div>
              <p className="text-warm-gray-500">Pris/kvm</p>
              <p className="font-medium text-warm-gray-700">
                {(() => {
                  const pps = pricePerSqm(candidate);
                  return pps !== null ? formatSEK(Math.round(pps)) : "---";
                })()}
              </p>
            </div>
            <div>
              <p className="text-warm-gray-500">Rum</p>
              <p className="font-medium text-warm-gray-700">
                {candidate.rooms !== null ? `${candidate.rooms} rum` : "---"}
              </p>
            </div>
            <div>
              <p className="text-warm-gray-500">Storlek</p>
              <p className="font-medium text-warm-gray-700">
                {candidate.livingArea !== null
                  ? `${candidate.livingArea} kvm`
                  : "---"}
              </p>
            </div>
          </div>

          {nicheActive && (
            <>
              {shownSignals.length > 0 ? (
                <ul className="space-y-2">
                  {shownSignals.map((signal) => {
                    const label = NICHE_SIGNAL_LABELS[signal.key] ?? signal.key;
                    const sourceLabel =
                      NICHE_SIGNAL_SOURCE_LABELS[signal.sourceRef] ?? signal.sourceRef;
                    return (
                      <li
                        key={signal.key}
                        className="flex flex-col gap-1.5 rounded-lg border border-warm-gray-100 bg-warm-gray-50 p-3"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="secondary">{label}</Badge>
                          <span className="text-xs text-warm-gray-500">
                            Källa: {sourceLabel}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-warm-gray-500 italic">
                  Inga tydliga signaler för denna sortering
                </p>
              )}
            </>
          )}

          <div className="flex items-center justify-between pt-1">
            <p className="text-xs text-warm-gray-500">Källa: Booli</p>
            <span className="text-xs font-medium text-sage-700">Se full analys</span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
