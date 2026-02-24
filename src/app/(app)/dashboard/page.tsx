import { createClient } from "@/lib/supabase/server";
import { UrlInput } from "@/components/url-input";
import { AnalysisCard } from "@/components/analysis-card";
import type { ListingData } from "@/lib/schemas/listing";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Fetch user's analyses ordered by newest first
  const { data: analyses } = await supabase
    .from("analyses")
    .select("id, listing_data, created_at")
    .eq("user_id", user!.id)
    .order("created_at", { ascending: false });

  return (
    <div className="flex flex-col gap-8">
      {/* Page heading */}
      <div>
        <h1 className="text-2xl font-semibold text-warm-gray-900">
          Oversikt
        </h1>
        <p className="mt-1 text-warm-gray-500">
          Dina sparade bostadsanalyser
        </p>
      </div>

      {/* URL input for new analysis */}
      <div>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-warm-gray-500">
          Ny analys
        </h2>
        <UrlInput />
      </div>

      {/* Analysis card grid or empty state */}
      {analyses && analyses.length > 0 ? (
        <div>
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-warm-gray-500">
            Tidigare analyser
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {analyses.map((analysis) => (
              <AnalysisCard
                key={analysis.id}
                id={analysis.id}
                listingData={analysis.listing_data as unknown as ListingData}
                createdAt={analysis.created_at}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-warm-gray-200 bg-warm-gray-50 px-8 py-16 text-center">
          <svg
            className="mb-4 h-12 w-12 text-warm-gray-300"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M6.75 21v-3.375c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21M3 3h12m-.75 4.5H21m-3.75 7.5h.008v.008h-.008v-.008Zm0 3h.008v.008h-.008v-.008Zm0 3h.008v.008h-.008v-.008Z"
            />
          </svg>
          <p className="text-lg font-medium text-warm-gray-700">
            Inga analyser an
          </p>
          <p className="mt-2 max-w-sm text-sm text-warm-gray-500">
            Klistra in en Booli-lank ovan for att borja analysera din forsta bostad!
          </p>
        </div>
      )}
    </div>
  );
}
