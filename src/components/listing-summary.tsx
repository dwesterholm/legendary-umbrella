import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ListingData } from "@/lib/schemas/listing";
import { formatSEK } from "@/lib/utils";

interface ListingSummaryProps {
  data: ListingData;
  partial?: boolean;
  missingFields?: string[];
  // Phase 6 Plan 03 (LSTG-04) — soft, non-blocking signal that the broker-
  // page enrichment fetch failed. Separate from `partial` (which tracks the
  // primary Booli-sourced required fields) — a broker failure never affects
  // `partial`.
  brokerFetchFailed?: boolean;
}

// Phase 6 Plan 03 — "Källa: Booli" / "Källa: Mäklarens annons" per the
// field's provenance (report-flags.tsx's `Källa: {sourceLabel}` pattern).
const SOURCE_CAPTIONS: Record<"booli" | "maklare", string> = {
  booli: "Källa: Booli",
  maklare: "Källa: Mäklarens annons",
};

function sourceCaptionFor(source: "booli" | "maklare" | null | undefined) {
  return source ? SOURCE_CAPTIONS[source] : undefined;
}

function MetricCard({
  label,
  value,
  isMissing,
  sourceCaption,
}: {
  label: string;
  value: string;
  isMissing?: boolean;
  sourceCaption?: string;
}) {
  return (
    <div className="rounded-lg bg-warm-gray-50 p-4">
      <p className="text-xs font-medium uppercase tracking-wider text-warm-gray-500">
        {label}
      </p>
      {isMissing ? (
        <p className="mt-1 text-lg italic text-warm-gray-500">Ej tillganglig</p>
      ) : (
        <>
          <p className="mt-1 text-lg font-semibold text-warm-gray-900">{value}</p>
          {sourceCaption && (
            <p className="mt-1 text-xs text-warm-gray-500">{sourceCaption}</p>
          )}
        </>
      )}
    </div>
  );
}

export function ListingSummary({
  data,
  partial,
  missingFields,
  brokerFetchFailed,
}: ListingSummaryProps) {
  const isMissing = (field: string) =>
    missingFields?.includes(field) ?? false;

  const fieldSources = data.fieldSources;
  const brfNameCaption = sourceCaptionFor(fieldSources?.brfName);
  const floorMissing = data.floor === null || data.floor === undefined;
  const balconyMissing = data.balcony === null || data.balcony === undefined;
  const renovationStatusMissing =
    !data.renovationStatus || data.renovationStatus.length === 0;
  const descriptionMissing = !data.description || data.description.length === 0;

  return (
    <Card className="w-full max-w-2xl border-warm-gray-200">
      {partial && (
        <div className="rounded-t-xl bg-terracotta-50 px-6 py-3">
          <p className="text-sm text-terracotta-600">
            Vissa uppgifter kunde inte hamtas
          </p>
        </div>
      )}

      {/* Phase 6 Plan 03 (LSTG-04) — soft, non-blocking broker-fetch-failed
          banner. Separate conditional block from `partial` above: a broker
          failure must never look like a primary-analysis error. */}
      {brokerFetchFailed && (
        <div className="rounded-t-xl bg-terracotta-50 px-6 py-3">
          <p className="text-sm text-terracotta-600">
            Kunde inte hämta ytterligare uppgifter från mäklarens annons — de
            fält som saknas visas som ej tillgängliga.
          </p>
        </div>
      )}

      <CardHeader>
        <CardTitle className="text-2xl font-semibold text-warm-gray-900">
          {data.address}
        </CardTitle>
        {data.brfName ? (
          <>
            <p className="text-warm-gray-500">{data.brfName}</p>
            {brfNameCaption && (
              <p className="mt-1 text-xs text-warm-gray-500">{brfNameCaption}</p>
            )}
          </>
        ) : (
          <p className="italic text-warm-gray-500">BRF-namn ej tillgangligt</p>
        )}
      </CardHeader>

      <CardContent>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <MetricCard
            label="Pris"
            value={formatSEK(data.price)}
            isMissing={isMissing("price") || data.price === 0}
          />
          <MetricCard
            label="Pris/kvm"
            value={data.prisPerKvm > 0 ? `${formatSEK(data.prisPerKvm)}/kvm` : ""}
            isMissing={data.prisPerKvm === 0}
          />
          <MetricCard
            label="Storlek"
            value={`${data.livingArea} kvm`}
            isMissing={isMissing("livingArea") || data.livingArea === 0}
          />
          <MetricCard
            label="Rum"
            value={`${data.rooms} rum`}
            isMissing={isMissing("rooms") || data.rooms === 0}
          />
          <MetricCard
            label="Avgift"
            value={data.monthlyFee !== null ? `${formatSEK(data.monthlyFee)}/man` : ""}
            isMissing={data.monthlyFee === null}
          />
          <MetricCard
            label="Byggar"
            value={data.buildYear !== null ? String(data.buildYear) : ""}
            isMissing={data.buildYear === null}
          />
          {/* Phase 6 Plan 03 (LSTG-03/04) — three new recovered fields, same
              MetricCard treatment as the existing metrics above. */}
          <MetricCard
            label="Våning"
            value={!floorMissing ? String(data.floor) : ""}
            isMissing={floorMissing}
            sourceCaption={sourceCaptionFor(fieldSources?.floor)}
          />
          <MetricCard
            label="Balkong"
            value={!balconyMissing ? (data.balcony ? "Ja" : "Nej") : ""}
            isMissing={balconyMissing}
            sourceCaption={sourceCaptionFor(fieldSources?.balcony)}
          />
          <MetricCard
            label="Renoveringsstatus"
            value={!renovationStatusMissing ? (data.renovationStatus as string) : ""}
            isMissing={renovationStatusMissing}
            sourceCaption={sourceCaptionFor(fieldSources?.renovationStatus)}
          />
        </div>

        {/* Phase 6 Plan 03 (LSTG-03/04) — full-width Beskrivning prose block,
            not a MetricCard (long-form text, UI-SPEC Field behavior notes). */}
        <div className="mt-4 rounded-lg bg-warm-gray-50 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-warm-gray-500">
            Beskrivning
          </p>
          {descriptionMissing ? (
            <p className="mt-1 text-sm italic text-warm-gray-500">Ej tillganglig</p>
          ) : (
            <>
              <p className="mt-1 text-sm leading-relaxed text-warm-gray-700">
                {data.description}
              </p>
              {sourceCaptionFor(fieldSources?.description) && (
                <p className="mt-1 text-xs text-warm-gray-500">
                  {sourceCaptionFor(fieldSources?.description)}
                </p>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
