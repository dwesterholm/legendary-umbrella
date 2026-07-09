import { notFound } from "next/navigation";
import Link from "next/link";
import { SearchX } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { DiscoveryProgressLive } from "@/components/discovery-progress-live";
import { DiscoveryResults } from "@/components/discovery-results";
import { discoveryCandidateSchema } from "@/lib/discovery/candidate";
import type { DiscoveryFilter } from "@/lib/discovery/filter-schema";

interface DiscoverJobPageProps {
  params: Promise<{ jobId: string }>;
}

const TERMINAL_STATUSES = new Set(["done", "failed", "degraded"]);

function describeFilters(freeText: string, filters: DiscoveryFilter | null): string {
  if (!filters) return freeText;
  const parts: string[] = [];
  if (filters.areaQuery) parts.push(filters.areaQuery);
  if (filters.priceMax) parts.push(`max ${filters.priceMax} kr`);
  if (filters.roomsMin) parts.push(`min ${filters.roomsMin} rum`);
  if (filters.sizeMin) parts.push(`min ${filters.sizeMin} kvm`);
  return parts.length > 0 ? `"${freeText}" — ${parts.join(", ")}` : `"${freeText}"`;
}

/**
 * `/discover/[jobId]` — the ownership-gated, flag-gated progress/results
 * route (DISC-01/02/07).
 *
 * FIRST check: `DISCOVERY_ENABLED !== "true"` -> `notFound()` (same
 * defense-in-depth as `/discover`). Then auth + `row.user_id !== user.id` ->
 * `notFound()` — the IDOR guard (T-09-06), behind RLS but re-checked here so
 * another user's jobId resolves identically to a missing job, never a "not
 * yours" leak (mirrors `analysis/[id]/page.tsx`'s exact pattern).
 */
export default async function DiscoverJobPage({ params }: DiscoverJobPageProps) {
  if (process.env.DISCOVERY_ENABLED !== "true") {
    notFound();
  }

  const { jobId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    notFound();
  }

  const { data: job, error } = await supabase
    .from("discovery_jobs")
    .select(
      "id, user_id, status, free_text, filters, processed_count, candidate_count, cap_candidates, cost_sek_total, cap_reached, results",
    )
    .eq("id", jobId)
    .single();

  if (error || !job || job.user_id !== user.id) {
    notFound();
  }

  const isTerminal = TERMINAL_STATUSES.has(job.status);
  const filters = (job.filters ?? null) as DiscoveryFilter | null;
  const querySummary = describeFilters(job.free_text, filters);

  // CR-01 read-path guard: re-validate persisted JSONB against the Zod
  // schema (mirrors dashboard's listingDataSchema.safeParse discipline) so a
  // shape-drifted candidate is skipped rather than crashing the page.
  // Uses control-flow narrowing on `.success` (no hand-written type
  // predicate) so `parsed.data` after `.filter()` keeps the REAL
  // Zod-inferred type instead of being widened to the untyped JSONB row
  // shape (WR-02) — this is what lets `tsc` actually catch a structural
  // mismatch against `DiscoveryCandidate` (CR-01).
  const rawResults = Array.isArray(job.results) ? job.results : [];
  const candidates = rawResults
    .map((raw) => discoveryCandidateSchema.safeParse(raw))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data);

  return (
    <div className="flex flex-col items-center gap-8">
      <div className="w-full max-w-2xl">
        <h1 className="text-2xl font-semibold text-warm-gray-900">
          Sökresultat
        </h1>
        <p className="mt-1 text-sm text-warm-gray-500">{querySummary}</p>
      </div>

      {!isTerminal && (
        <DiscoveryProgressLive jobId={job.id} initialStatus={job.status} />
      )}

      {isTerminal && job.status === "done" && candidates.length > 0 && (
        <DiscoveryResults candidates={candidates} />
      )}

      {isTerminal && job.status === "done" && candidates.length === 0 && (
        <div className="flex w-full max-w-2xl flex-col items-center justify-center rounded-xl border-2 border-dashed border-warm-gray-200 bg-warm-gray-50 px-8 py-16 text-center">
          <SearchX className="mb-4 h-12 w-12 text-warm-gray-300" />
          <p className="text-lg font-medium text-warm-gray-700">
            Inga träffar denna gång
          </p>
          <p className="mt-2 max-w-sm text-sm text-warm-gray-500">
            Vi hittade inga annonser som matchade din beskrivning och dina
            filter. Prova att bredda sökningen eller ta bort ett filter.
          </p>
        </div>
      )}

      {isTerminal && (job.status === "failed" || job.status === "degraded") && (
        <div className="w-full max-w-2xl rounded-lg bg-terracotta-50 px-4 py-3">
          <p className="text-sm text-terracotta-600">
            {job.status === "degraded"
              ? "Områdessökning är tillfälligt otillgänglig. Prova att analysera en enskild annons via länk istället."
              : "Sökningen kunde inte slutföras. Inga kostnader utöver det som redan skannats har tillkommit. Försök igen om en stund."}
          </p>
          <Link
            href={job.status === "degraded" ? "/dashboard" : "/discover"}
            className="mt-2 inline-block text-sm font-medium text-terracotta-600 underline"
          >
            {job.status === "degraded" ? "Till enskild sökning" : "Försök igen"}
          </Link>
        </div>
      )}
    </div>
  );
}
