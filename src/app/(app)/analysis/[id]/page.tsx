import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ListingSummary } from "@/components/listing-summary";
import { ComingSoonSection } from "@/components/coming-soon-section";
import { UrlInput } from "@/components/url-input";
import type { ListingData } from "@/lib/schemas/listing";

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

  const listingData = analysis.listing_data as unknown as ListingData;
  const isPartial = analysis.partial ?? false;

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
        <ComingSoonSection title="BRF Analys" />
        <ComingSoonSection title="Prisjamforelse" />
        <ComingSoonSection title="Omradesstatistik" />
        <ComingSoonSection title="AI Rapport" />
      </div>
    </div>
  );
}
