import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ListingData } from "@/lib/schemas/listing";
import { formatSEK } from "@/lib/utils";

interface ListingSummaryProps {
  data: ListingData;
  partial?: boolean;
  missingFields?: string[];
}

function MetricCard({
  label,
  value,
  isMissing,
}: {
  label: string;
  value: string;
  isMissing?: boolean;
}) {
  return (
    <div className="rounded-lg bg-warm-gray-50 p-4">
      <p className="text-xs font-medium uppercase tracking-wider text-warm-gray-500">
        {label}
      </p>
      {isMissing ? (
        <p className="mt-1 text-lg italic text-warm-gray-500">Ej tillganglig</p>
      ) : (
        <p className="mt-1 text-lg font-semibold text-warm-gray-900">{value}</p>
      )}
    </div>
  );
}

export function ListingSummary({ data, partial, missingFields }: ListingSummaryProps) {
  const isMissing = (field: string) =>
    missingFields?.includes(field) ?? false;

  return (
    <Card className="w-full max-w-2xl border-warm-gray-200">
      {partial && (
        <div className="rounded-t-xl bg-terracotta-50 px-6 py-3">
          <p className="text-sm text-terracotta-600">
            Vissa uppgifter kunde inte hamtas
          </p>
        </div>
      )}

      <CardHeader>
        <CardTitle className="text-2xl font-semibold text-warm-gray-900">
          {data.address}
        </CardTitle>
        {data.brfName ? (
          <p className="text-warm-gray-500">{data.brfName}</p>
        ) : (
          !isMissing("brfName") || (
            <p className="italic text-warm-gray-500">BRF-namn ej tillgangligt</p>
          )
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
        </div>
      </CardContent>
    </Card>
  );
}
