import { ListingSkeleton } from "@/components/listing-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

export default function AnalysisLoading() {
  return (
    <div className="flex flex-col items-center gap-8">
      {/* New analysis input skeleton */}
      <div className="w-full max-w-2xl space-y-4">
        <Skeleton className="h-5 w-24 bg-warm-gray-100" />
        <div className="flex gap-3">
          <Skeleton className="h-11 flex-1 bg-warm-gray-100" />
          <Skeleton className="h-11 w-28 bg-warm-gray-100" />
        </div>
      </div>

      {/* Listing skeleton */}
      <ListingSkeleton />

      {/* Coming soon section skeletons */}
      <div className="w-full max-w-2xl space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="rounded-xl border-2 border-dashed border-warm-gray-200 p-6 opacity-60"
          >
            <div className="flex items-center justify-between">
              <Skeleton className="h-6 w-32 bg-warm-gray-100" />
              <Skeleton className="h-5 w-24 rounded-full bg-warm-gray-100" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
