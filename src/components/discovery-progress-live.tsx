"use client";

import { useRouter } from "next/navigation";
import { DiscoveryProgress } from "@/components/discovery-progress";

/**
 * Client boundary around `DiscoveryProgress` (WR-01, shard-5 review). The
 * `/discover/[jobId]` page is a server component: it decides `!isTerminal →
 * render progress` vs `render DiscoveryResults` at request time. When a job the
 * user is watching reaches a terminal status, `DiscoveryProgress`'s poller sees
 * it and stops — but the server component never re-runs, so the candidate list
 * never appears until a manual reload. This wrapper calls `router.refresh()` on
 * completion, which re-fetches the RSC payload; the server component then
 * re-evaluates and renders `DiscoveryResults` for the now-terminal row.
 */
export function DiscoveryProgressLive({
  jobId,
  initialStatus,
}: {
  jobId: string;
  initialStatus?: string | null;
}) {
  const router = useRouter();
  return (
    <DiscoveryProgress
      jobId={jobId}
      initialStatus={initialStatus}
      onComplete={() => router.refresh()}
    />
  );
}
