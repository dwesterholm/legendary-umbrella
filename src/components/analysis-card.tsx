import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ListingData } from "@/lib/schemas/listing";
import { formatSEK } from "@/lib/utils";

interface AnalysisCardProps {
  id: string;
  listingData: ListingData;
  createdAt: string;
}

function formatSwedishDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString("sv-SE", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function AnalysisCard({ id, listingData, createdAt }: AnalysisCardProps) {
  return (
    <Link href={`/analysis/${id}`} className="group block">
      <Card className="h-full border-warm-gray-200 bg-warm-white transition-all duration-200 group-hover:shadow-md group-hover:border-sage-200">
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold text-warm-gray-900 line-clamp-2">
            {listingData.address}
          </CardTitle>
          {listingData.brfName && (
            <p className="text-sm text-warm-gray-500">{listingData.brfName}</p>
          )}
        </CardHeader>

        <CardContent className="space-y-3">
          {/* Price prominent */}
          <p className="text-lg font-semibold text-warm-gray-900">
            {formatSEK(listingData.price)}
          </p>

          {/* Compact metrics grid */}
          <div className="grid grid-cols-3 gap-2 text-sm">
            <div>
              <p className="text-warm-gray-500">Pris/kvm</p>
              <p className="font-medium text-warm-gray-700">
                {listingData.prisPerKvm > 0
                  ? formatSEK(listingData.prisPerKvm)
                  : "---"}
              </p>
            </div>
            <div>
              <p className="text-warm-gray-500">Rum</p>
              <p className="font-medium text-warm-gray-700">
                {listingData.rooms > 0 ? `${listingData.rooms} rum` : "---"}
              </p>
            </div>
            <div>
              <p className="text-warm-gray-500">Storlek</p>
              <p className="font-medium text-warm-gray-700">
                {listingData.livingArea > 0
                  ? `${listingData.livingArea} kvm`
                  : "---"}
              </p>
            </div>
          </div>

          {/* Date */}
          <p className="text-xs text-warm-gray-500 pt-1">
            {formatSwedishDate(createdAt)}
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}
