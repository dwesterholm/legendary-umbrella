import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export function ListingSkeleton() {
  return (
    <Card className="w-full max-w-2xl border-warm-gray-200">
      <CardHeader className="space-y-3">
        {/* Address */}
        <Skeleton className="h-8 w-3/4 bg-warm-gray-100" />
        {/* BRF name */}
        <Skeleton className="h-5 w-1/2 bg-warm-gray-100" />
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          {/* Price */}
          <div className="space-y-2 rounded-lg bg-warm-gray-50 p-4">
            <Skeleton className="h-4 w-12 bg-warm-gray-200" />
            <Skeleton className="h-7 w-28 bg-warm-gray-200" />
          </div>
          {/* Pris/kvm */}
          <div className="space-y-2 rounded-lg bg-warm-gray-50 p-4">
            <Skeleton className="h-4 w-16 bg-warm-gray-200" />
            <Skeleton className="h-7 w-24 bg-warm-gray-200" />
          </div>
          {/* Storlek */}
          <div className="space-y-2 rounded-lg bg-warm-gray-50 p-4">
            <Skeleton className="h-4 w-14 bg-warm-gray-200" />
            <Skeleton className="h-7 w-20 bg-warm-gray-200" />
          </div>
          {/* Rum */}
          <div className="space-y-2 rounded-lg bg-warm-gray-50 p-4">
            <Skeleton className="h-4 w-10 bg-warm-gray-200" />
            <Skeleton className="h-7 w-16 bg-warm-gray-200" />
          </div>
          {/* Avgift */}
          <div className="space-y-2 rounded-lg bg-warm-gray-50 p-4">
            <Skeleton className="h-4 w-14 bg-warm-gray-200" />
            <Skeleton className="h-7 w-24 bg-warm-gray-200" />
          </div>
          {/* Byggar */}
          <div className="space-y-2 rounded-lg bg-warm-gray-50 p-4">
            <Skeleton className="h-4 w-14 bg-warm-gray-200" />
            <Skeleton className="h-7 w-16 bg-warm-gray-200" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
