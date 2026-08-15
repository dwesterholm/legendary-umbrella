import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { discoveryCandidateSchema } from "@/lib/discovery/candidate";
import { GalleryConditionVision } from "@/components/gallery-condition-vision";

interface DiscoverCandidatePageProps {
  params: Promise<{ jobId: string; candidateIndex: string }>;
}

function formatSek(n: number | null | undefined): string | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return `${Math.round(n).toLocaleString("sv-SE")} kr`;
}

/**
 * `/discover/[jobId]/[candidateIndex]` — the per-candidate detail page
 * (todo 007).
 *
 * Before this existed, a discovery result had nowhere to go. Clicking a card
 * sent the user to `/dashboard?url=…`, i.e. back to the paste-a-link input
 * they had just waited minutes to avoid; and every candidate's AI insight was
 * rendered in one long list BELOW the ranking grid, keyed by array position,
 * with no visual binding to the object it described. At 25 results the
 * operator's reaction was, verbatim, "for which object?".
 *
 * This page owns everything about ONE candidate, so the insight lives with its
 * object and the grid can go back to being a grid.
 *
 * Guards mirror `/discover/[jobId]` exactly — flag first, then auth, then the
 * `user_id` IDOR re-check behind RLS (T-09-06). The candidate index is the
 * array position in the job's persisted JSONB `results`, which is the only
 * stable identifier a candidate has (they carry no id of their own).
 *
 * Structural-separation note: this is a READ surface, so composing vision /
 * sun-path / holistic-brief here is allowed. The ranking path must stay clean —
 * none of these values may ever feed `computeNicheScore`, and `niche-score.ts`
 * / `flags.ts` still import none of them (statically enforced in
 * `niche-score.test.ts`).
 */
export default async function DiscoverCandidatePage({
  params,
}: DiscoverCandidatePageProps) {
  if (process.env.DISCOVERY_ENABLED !== "true") {
    notFound();
  }

  const { jobId, candidateIndex } = await params;

  // Reject anything that is not a plain non-negative integer before it reaches
  // the array — "1e3", "-1", "01x" and friends must 404, not index something.
  if (!/^\d+$/.test(candidateIndex)) {
    notFound();
  }
  const index = Number(candidateIndex);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    notFound();
  }

  const { data: job, error } = await supabase
    .from("discovery_jobs")
    .select("id, user_id, status, free_text, results")
    .eq("id", jobId)
    .maybeSingle();

  if (error || !job || job.user_id !== user.id) {
    notFound();
  }

  // Same read-path discipline as the job page: re-validate the persisted JSONB
  // through Zod so a shape-drifted row 404s instead of crashing on an
  // unguarded field dereference. Parse only the row we need.
  const rawResults = Array.isArray(job.results) ? job.results : [];
  const raw = rawResults[index];
  if (raw === undefined) {
    notFound();
  }
  const parsed = discoveryCandidateSchema.safeParse(raw);
  if (!parsed.success) {
    notFound();
  }
  const candidate = parsed.data;

  const price = formatSek(candidate.price);
  const perSqm =
    candidate.price && candidate.livingArea
      ? formatSek(candidate.price / candidate.livingArea)
      : null;

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="w-full max-w-2xl">
        <Link
          href={`/discover/${job.id}`}
          className="text-sm text-warm-gray-500 hover:text-sage-600 transition-colors"
        >
          ← Tillbaka till sökresultatet
        </Link>

        <h1 className="mt-3 text-2xl font-semibold text-warm-gray-900">
          {candidate.address ?? "Bostad"}
        </h1>
        <p className="mt-1 text-sm text-warm-gray-500">
          {[candidate.areaLabel, candidate.kommun].filter(Boolean).join(", ") ||
            "Okänt område"}
        </p>
      </div>

      {/* Verified facts first, hedged image interpretation after — the same
          ordering rule the results grid follows (11-UI-SPEC.md §1). */}
      <div className="w-full max-w-2xl rounded-xl border border-warm-gray-200 bg-white p-6">
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div>
            <dt className="text-xs uppercase tracking-wider text-warm-gray-500">Pris</dt>
            <dd className="mt-1 font-medium text-warm-gray-900">{price ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-warm-gray-500">Pris/kvm</dt>
            <dd className="mt-1 font-medium text-warm-gray-900">{perSqm ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-warm-gray-500">Storlek</dt>
            <dd className="mt-1 font-medium text-warm-gray-900">
              {candidate.livingArea ? `${candidate.livingArea} kvm` : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-warm-gray-500">Rum</dt>
            <dd className="mt-1 font-medium text-warm-gray-900">
              {candidate.rooms ? `${candidate.rooms} rum` : "—"}
            </dd>
          </div>
        </dl>

        {candidate.sourceListingUrl && (
          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href={`/dashboard?url=${encodeURIComponent(candidate.sourceListingUrl)}`}
              className="inline-flex h-10 items-center rounded-md bg-sage-600 px-5 text-sm font-medium text-white hover:bg-sage-700"
            >
              Gör en full analys
            </Link>
            <a
              href={candidate.sourceListingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-10 items-center rounded-md border border-warm-gray-200 px-5 text-sm font-medium text-warm-gray-600 hover:border-sage-200"
            >
              Visa annonsen på Booli
            </a>
          </div>
        )}
      </div>

      {/* The AI read for THIS object — previously stranded in a list below the
          grid with no indication of which candidate it belonged to. */}
      <div className="w-full max-w-2xl">
        <GalleryConditionVision
          vision={candidate.vision}
          visionSkippedReason={candidate.visionSkippedReason}
          latitude={candidate.latitude}
          longitude={candidate.longitude}
          floor={candidate.floor}
          orientation={candidate.orientation}
          holisticBrief={candidate.holisticBrief}
        />
      </div>
    </div>
  );
}
