"use client";

import { useState } from "react";
import { UrlInput } from "@/components/url-input";
import { ListingSummary } from "@/components/listing-summary";
import { ListingSkeleton } from "@/components/listing-skeleton";
import { ComingSoonSection } from "@/components/coming-soon-section";
import type { ListingData } from "@/lib/schemas/listing";

export default function Home() {
  const [result, setResult] = useState<{
    data: ListingData;
    partial: boolean;
    missingFields?: string[];
    brokerFetchFailed?: boolean;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  function handleResult(
    data: ListingData,
    partial: boolean,
    missingFields?: string[],
    brokerFetchFailed?: boolean
  ) {
    setResult({ data, partial, missingFields, brokerFetchFailed });
  }

  return (
    <div className="flex min-h-screen flex-col items-center px-4 py-16 md:py-24">
      <main className="flex w-full max-w-2xl flex-col items-center gap-8">
        {/* Hero section */}
        <div className="text-center space-y-3">
          <h1 className="text-4xl font-semibold tracking-tight text-warm-gray-900">
            Analysera din bostad
          </h1>
          <p className="text-lg text-warm-gray-500 max-w-md mx-auto">
            Klistra in en Booli-lank och fa en detaljerad analys av bostaden.
          </p>
        </div>

        {/* URL Input */}
        <UrlInput onResult={handleResult} onLoadingChange={setIsLoading} />

        {/* Results area */}
        {isLoading && <ListingSkeleton />}

        {!isLoading && result && (
          <div className="w-full space-y-4">
            <ListingSummary
              data={result.data}
              partial={result.partial}
              missingFields={result.missingFields}
              brokerFetchFailed={result.brokerFetchFailed}
            />

            {/* Coming soon sections */}
            <div className="space-y-3 pt-4">
              <ComingSoonSection title="BRF Analys" />
              <ComingSoonSection title="Prisjamforelse" />
              <ComingSoonSection title="Omradesstatistik" />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
