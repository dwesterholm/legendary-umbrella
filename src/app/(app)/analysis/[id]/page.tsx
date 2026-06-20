import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ListingSummary } from "@/components/listing-summary";
import { ComingSoonSection } from "@/components/coming-soon-section";
import { BrfSection } from "@/components/brf-section";
import { MarketContextSection } from "@/components/market-context-section";
import { UrlInput } from "@/components/url-input";
import type { ListingData } from "@/lib/schemas/listing";
import { safeParseBrfData } from "@/lib/schemas/brf";
import { safeParsePriceData } from "@/lib/market/sold-schema";
import { safeParseAreaData } from "@/lib/market/scb-schema";

interface AnalysisPageProps {
  params: Promise<{ id: string }>;
}

export default async function AnalysisPage({ params }: AnalysisPageProps) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: analysis, error } = await supabase
    .from("analyses")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !analysis) {
    notFound();
  }

  // Resolve the current user server-side to derive guest state (D-05). The teaser
  // is defence-in-depth — analyzeBrf enforces the authoritative hard gate.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const listingData = analysis.listing_data as unknown as ListingData;
  const isPartial = analysis.partial ?? false;
  // CR-01: re-validate the persisted JSONB against the Zod schema before it is
  // handed to the UI. A malformed/partial/shape-drifted row degrades to
  // "no analysis yet" (the upload affordance) rather than crashing the score card.
  const brfData = safeParseBrfData(analysis.brf_data);
  // CR-01 / T-03-20: re-validate the persisted market JSONB before handing it to
  // the client cards. Shape-drifted/malformed rows degrade to null (the fetch
  // affordance / honest marker) rather than crashing the page (Success Criterion 3).
  const priceData = safeParsePriceData(analysis.price_data);
  const areaData = safeParseAreaData(analysis.area_data);

  return (
    <div className="flex flex-col items-center gap-8">
      {/* New analysis input */}
      <div className="w-full max-w-2xl">
        <h2 className="mb-4 text-lg font-medium text-warm-gray-700">
          Ny analys
        </h2>
        <UrlInput />
      </div>

      {/* Listing summary */}
      <ListingSummary data={listingData} partial={isPartial} />

      {/* Coming soon sections */}
      <div className="w-full max-w-2xl space-y-3">
        <BrfSection
          analysisId={analysis.id}
          isGuest={!user}
          brfStatus={analysis.brf_status}
          brfData={brfData}
        />
        {/* Phase 3: price comparison + SCB demographics, owner-only, each panel
            degrades independently (no isGuest — the page is owner-only). */}
        <MarketContextSection
          analysisId={analysis.id}
          priceData={priceData}
          areaData={areaData}
          listingPrisPerKvm={listingData.prisPerKvm}
          marketStatus={analysis.market_status}
        />
        <ComingSoonSection title="AI Rapport" />
      </div>
    </div>
  );
}
