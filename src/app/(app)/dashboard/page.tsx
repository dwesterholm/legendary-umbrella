import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { UrlInput } from "@/components/url-input";
import { AnalysisCard } from "@/components/analysis-card";
import { listingDataSchema } from "@/lib/schemas/listing";

/**
 * The two-product picker (todo 002).
 *
 * This app has grown two distinct products behind one login — analyse ONE
 * pasted listing, and SEARCH an area for candidates — and until now the
 * second was effectively invisible: it sat below the URL input under a small
 * uppercase heading, with no nav entry and no visual parity. The operator
 * could not find `/discover` at all and had to be handed the URL, despite the
 * link technically rendering. Discoverability, not a missing link, was the
 * defect.
 *
 * Both options now get equal billing as cards, so the choice is explicit
 * rather than a default into whichever flow happens to be on top.
 *
 * The discovery card renders `null` — full absence, no disabled state, no
 * "coming soon" — when the flag is off (09-UI-SPEC.md Feature Flag Contract).
 * That is a UX nicety only; `startDiscovery`'s literal-first-line flag check
 * remains the real security boundary.
 */
function ProductPicker() {
  const discoveryEnabled = process.env.DISCOVERY_ENABLED === "true";

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div className="flex flex-col rounded-xl border border-warm-gray-200 bg-white p-6">
        <h2 className="text-base font-semibold text-warm-gray-900">
          Analysera en annons
        </h2>
        <p className="mt-1 mb-4 flex-1 text-sm text-warm-gray-500">
          Klistra in en Booli-lank sa far du en oberoende analys av just den
          bostaden — BRF-ekonomi, prisjamforelse och riskflaggor.
        </p>
        <UrlInput />
      </div>

      {discoveryEnabled && (
        <div className="flex flex-col rounded-xl border border-warm-gray-200 bg-white p-6">
          <h2 className="text-base font-semibold text-warm-gray-900">
            Sok efter bostader
          </h2>
          <p className="mt-1 mb-4 flex-1 text-sm text-warm-gray-500">
            Beskriv vad du letar efter, valj ett eller flera omraden, och lat
            AI:n ga igenom aktuella annonser och rangordna kandidaterna at dig.
          </p>
          <Link
            href="/discover"
            className="inline-flex h-11 w-fit items-center rounded-md bg-sage-600 px-6 text-sm font-medium text-white hover:bg-sage-700"
          >
            Starta ny sokning
          </Link>
        </div>
      )}
    </div>
  );
}

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
          Vad vill du gora?
        </h1>
        <p className="mt-1 text-warm-gray-500">
          Analysera en enskild annons, eller sok igenom ett helt omrade.
        </p>
      </div>

      {/* Two-product picker — equal billing for both flows (todo 002). */}
      <ProductPicker />

      {/* Analysis card grid or empty state */}
      {analyses && analyses.length > 0 ? (
        <div>
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-warm-gray-500">
            Tidigare analyser
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {analyses.map((analysis) => {
              // CR-01 read-path guard (LSTG-02): re-validate persisted JSONB
              // against the Zod schema — same discipline as the analysis page —
              // so a shape-drifted row is skipped rather than crashing the whole
              // dashboard on AnalysisCard's unguarded field dereferences.
              const parsed = listingDataSchema.safeParse(analysis.listing_data);
              if (!parsed.success) return null;
              return (
                <AnalysisCard
                  key={analysis.id}
                  id={analysis.id}
                  listingData={parsed.data}
                  createdAt={analysis.created_at}
                />
              );
            })}
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
