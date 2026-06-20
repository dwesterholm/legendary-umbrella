"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PriceComparisonCard } from "@/components/price-comparison-card";
import { AreaStatsCard } from "@/components/area-stats-card";
import { enrichMarketContext } from "@/actions/enrich-market-context";
import type { PriceData } from "@/lib/market/sold-schema";
import type { AreaData } from "@/lib/market/scb-schema";

interface MarketContextSectionProps {
  analysisId: string;
  /** Persisted, re-validated price_data (null = absent on this row). */
  priceData: PriceData | null;
  /** Persisted, re-validated area_data (null = absent on this row). */
  areaData: AreaData | null;
  /**
   * The listing's own pris/kvm off the row — passed through to the price card so
   * the "ok" headline can show "Denna bostad: X kr/m²" without recomputation.
   */
  listingPrisPerKvm?: number | null;
  /**
   * Persisted `market_status`. null = never enriched (show the fetch affordance);
   * "fetching" = in progress; "done"/"failed" = terminal (Plan 05 semantics).
   */
  marketStatus?: string | null;
}

/**
 * A synthesized source_unavailable PriceData. When market_status is terminal
 * ("done"/"failed") but price_data persisted nothing, the price branch ran and
 * came up empty — that is a dead source, NOT "not yet fetched" (HIGH-1). We hand
 * the card a source_unavailable shape so it renders the DISTINCT honest message
 * rather than the "Hämta marknadsdata" affordance or a "för få försäljningar" lie.
 */
const SOURCE_UNAVAILABLE_PRICE: PriceData = {
  reason: "source_unavailable",
  areaAvg: null,
  deltaPct: null,
  min: null,
  max: null,
  trendSlope: null,
  sampleSize: 0,
  tier: null,
  confidence: 0,
  comps: [],
  source: "Booli",
  sourceLabel: "sålda bostäder",
  recency: null,
};

/**
 * `MarketContextSection` — the Phase 3 client orchestrator (mirrors brf-section.tsx).
 *
 * Owner-only by construction (HIGH-2): the analysis detail page only renders for a
 * persisted owner row, so there is NO guest viewing path — this section takes no
 * `isGuest` prop and adds no login wall. The enrich trigger calls
 * `enrichMarketContext`, which re-checks auth + ownership server-side (Plan 05,
 * T-03-15) as defence-in-depth.
 *
 * The two panels degrade INDEPENDENTLY (D-08 / Success Criterion 3): one null
 * source NEVER hides or blanks the other. Honest price states are delegated to
 * PriceComparisonCard via priceData.reason — the section only decides
 * present-vs-synthesize-source_unavailable-vs-fetch-affordance.
 */
export function MarketContextSection({
  analysisId,
  priceData,
  areaData,
  listingPrisPerKvm,
  marketStatus,
}: MarketContextSectionProps) {
  // Seed local state from the server props so an in-session enrich re-renders the
  // panels without a full reload (mirrors brf-section seeding).
  const [price, setPrice] = useState<PriceData | null>(priceData);
  const [area, setArea] = useState<AreaData | null>(areaData);
  const [status, setStatus] = useState<string | null>(marketStatus ?? null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const triggerEnrich = () => {
    setError(null);
    startTransition(async () => {
      const result = await enrichMarketContext(analysisId);
      if (!result.ok) {
        setError(result.error);
        // The action wrote a terminal status server-side; reflect "failed" so the
        // panels show their honest terminal states on the next interaction.
        setStatus("failed");
        return;
      }
      setPrice(result.data.price);
      setArea(result.data.area);
      setStatus("done");
    });
  };

  const isTerminal = status === "done" || status === "failed";

  // ---- never enriched (market_status null) → the fetch affordance ----
  // Do NOT label an un-run price branch as "för få försäljningar" (HIGH-1).
  if (status == null) {
    return (
      <Card className="w-full max-w-2xl border-warm-gray-200">
        <CardHeader>
          <CardTitle className="text-lg font-medium text-warm-gray-700">
            Marknadsdata
          </CardTitle>
          <p className="mt-1 text-sm text-warm-gray-500">
            Hämta prisjämförelse mot sålda bostäder och områdesstatistik från SCB.
          </p>
        </CardHeader>
        <CardContent>
          <Button
            type="button"
            className="h-11 bg-sage-600 px-6 text-white hover:bg-sage-700"
            disabled={isPending}
            onClick={triggerEnrich}
          >
            {isPending ? "Hämtar marknadsdata…" : "Hämta marknadsdata"}
          </Button>
          {error && (
            <p className="mt-3 text-sm text-terracotta-600">{error}</p>
          )}
        </CardContent>
      </Card>
    );
  }

  // ---- in progress ----
  if (status === "fetching" || (isPending && !isTerminal)) {
    return (
      <Card className="w-full max-w-2xl border-warm-gray-200">
        <CardContent className="py-6">
          <p className="text-sm text-warm-gray-500">Hämtar marknadsdata…</p>
        </CardContent>
      </Card>
    );
  }

  // ---- terminal (done/failed): render the two panels INDEPENDENTLY (D-08) ----
  // Price: present → pass through (the card renders the correct reason). Absent
  // but terminal (the only way to reach here) → the branch ran and persisted
  // nothing → synthesize source_unavailable so the card shows the DISTINCT
  // dead-source message (HIGH-1), never the fetch affordance, never a thin lie.
  const priceForCard: PriceData = price ?? SOURCE_UNAVAILABLE_PRICE;

  return (
    <div className="space-y-3">
      {error && (
        <p className="text-sm text-terracotta-600">{error}</p>
      )}

      {/* Price panel — always rendered once terminal; honest state from reason. */}
      <PriceComparisonCard
        priceData={priceForCard}
        listingPrisPerKvm={listingPrisPerKvm}
      />

      {/* Area panel — independent: a null area NEVER blanks the price panel above. */}
      {area ? (
        <AreaStatsCard areaData={area} />
      ) : (
        <Card className="w-full max-w-2xl border-warm-gray-200">
          <CardHeader>
            <CardTitle className="text-2xl font-semibold text-warm-gray-900">
              Områdesstatistik
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg bg-warm-gray-50 p-4">
              <p className="text-base font-medium text-warm-gray-700">
                Områdesstatistik ej tillgänglig
              </p>
              <p className="mt-1 text-sm text-warm-gray-500">
                Vi kunde inte hämta SCB-data för det här området just nu.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
