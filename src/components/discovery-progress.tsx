"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { createClient } from "@/lib/supabase/client";
import { tickDiscovery } from "@/actions/tick-discovery";

interface DiscoveryProgressProps {
  jobId: string;
  /** Fired once when the row reaches a terminal status. Stops the poll+tick. */
  onComplete?: (status: string) => void;
  /** Server-resolved initial status so a reload doesn't flash "queued". */
  initialStatus?: string | null;
}

interface DiscoveryJobRow {
  status: string;
  candidate_count: number;
  cap_candidates: number;
  cost_sek_total: number;
  cap_reached: boolean;
}

/** Poll cadence — mirrors BrfProgress's light-but-responsive rhythm. */
export const POLL_MS = 1500;

/**
 * Soft, non-failing threshold (D-04). Once elapsed with the job still
 * running, the UI shows a calm "tar längre tid" notice — but polling AND
 * ticking continue uninterrupted; this is deliberately NOT a failure path.
 * Tunable; pending calibration by the 13-03 live smoke (RESEARCH Open
 * Question #2).
 */
export const SOFT_THRESHOLD_MS = 90_000;

/**
 * Generous absolute safety ceiling (D-05), well above the old single
 * 5-minute hard-fail. Only fires a real `onComplete("failed")` for a
 * genuinely stuck job — an area scrape + vision pass that's still running
 * at the soft threshold is expected, not an error. Tunable; pending
 * calibration by the 13-03 live smoke (RESEARCH Open Question #2).
 */
export const ABSOLUTE_CEILING_MS = 15 * 60_000;

const TERMINAL_STATUSES = new Set(["done", "failed", "degraded"]);

/**
 * The complete, closed set of statuses `discovery_jobs.status` can hold
 * (RESEARCH.md "Complete status vocabulary", D-07) — the column has no DB
 * check constraint, so this array is the canonical client-side vocabulary
 * a new status word must be added to. Exported so the exhaustiveness test
 * can enumerate it without duplicating the list.
 */
export const KNOWN_STATUSES = [
  "pending",
  "processing",
  "vision_processing",
  "done",
  "failed",
  "degraded",
] as const;

export const STATUS_LABELS: Record<string, string> = {
  pending: "I kö",
  processing: "Analyserar",
  vision_processing: "Analyserar bilder",
  done: "Klar",
  failed: "Misslyckades",
  degraded: "Avbruten",
};

function statusLabel(status: string | null): string {
  if (!status) return STATUS_LABELS.pending;
  return STATUS_LABELS[status] ?? status;
}

/**
 * `DiscoveryProgress` — the client-tick-drives-the-queue driver
 * (09-PATTERNS.md Pattern 1). Directly modeled on `BrfProgress`'s
 * polling skeleton, but each `poll()` round-trip ALSO invokes
 * `tickDiscovery(jobId)` BEFORE reading status — this is the ONE
 * divergence from `BrfProgress`'s pure read.
 *
 * Renders a single live counter line ("{n} av {total} annonser
 * analyserade") + a status Badge, rather than BrfProgress's step-dot list
 * (UI-SPEC line 132 — one meaningful progress axis, not discrete phases).
 * LOCKED operator decision (2026-07-22, 13-05): the counter means
 * "candidates analyzed / candidates found" — denominator = candidate_count
 * (candidates actually found/deduped, NEVER cap_candidates), numerator =
 * a monotonic non-decreasing "analyzed" count clamped to candidate_count,
 * reaching candidate_count (all found candidates scored) at status "done".
 * The server-side scanned-listings scrape/cost counter (written only by
 * runSlice) is NEVER read or displayed here — mixing that counter into
 * this one is exactly the "350 av 25" defect this plan fixes.
 *
 * `cap_reached` is an orthogonal boolean on the job row (not a status
 * value) — it can compose with a still-running OR done status, so the
 * honesty banner is rendered independently of the status Badge.
 */
export function DiscoveryProgress({
  jobId,
  onComplete,
  initialStatus,
}: DiscoveryProgressProps) {
  const [status, setStatus] = useState<string | null>(initialStatus ?? "pending");
  const [analyzed, setAnalyzed] = useState(0);
  const [candidateCount, setCandidateCount] = useState(0);
  const [capCandidates, setCapCandidates] = useState(0);
  const [capReached, setCapReached] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    let active = true;
    // In-flight guard (WR-03, 09-REVIEW.md): `claim_discovery_slice`'s
    // atomic claim already makes a redundant concurrent `tickDiscovery` call
    // a benign no-op (the second claim just returns zero rows), but without
    // this guard a slice that takes longer than POLL_MS lets `setInterval`
    // fire a SECOND overlapping tick DISPATCH while the first's
    // `await tickDiscovery(...)` is still in flight — needlessly doubling
    // Server Action invocations and claim RPC calls for zero benefit. This
    // flag makes an overlapping dispatch SKIP rather than queue.
    //
    // 13-04 Task 1 (GAP-1): the status READ below is deliberately NOT
    // gated by this flag. Before this fix, a single `poll()` awaited
    // `tickDiscovery(jobId)` BEFORE reading status, under this ONE guard —
    // so while a multi-minute tick (full area scrape + vision pass) was in
    // flight, the read never ran and the badge froze on its last-seen value
    // for the tick's entire duration (13-SMOKE-FINDINGS.md GAP-1). The read
    // must run on every interval tick regardless of a pending dispatch; only
    // the DISPATCH itself stays guarded.
    let inFlight = false;
    // WR-01: `readStatus()` was deliberately decoupled from the `inFlight`
    // guard above (GAP-1, 13-04) so a long-running tick doesn't freeze the
    // badge — but that decoupling left the read itself with NO ordering
    // protection. If a Supabase round-trip is ever slower than POLL_MS
    // (network latency spike, a backgrounded tab firing a burst of interval
    // ticks on resume, etc.), two reads can be in flight at once; if the
    // OLDER one resolves after the newer one, it would overwrite the fresher
    // state that was just committed. `latestRequestId` is bumped on every
    // call and a response is only applied if it's still the latest —
    // mirroring the discipline `inFlight` already applies to the dispatch.
    let latestRequestId = 0;

    async function readStatus() {
      if (!active) return;
      const requestId = ++latestRequestId;

      const { data } = await supabase
        .from("discovery_jobs")
        .select("status, candidate_count, cap_candidates, cost_sek_total, cap_reached")
        .eq("id", jobId)
        .single();

      if (!active || requestId !== latestRequestId) return;

      const row = data as DiscoveryJobRow | null;
      if (row) {
        setStatus(row.status);
        setCandidateCount(row.candidate_count);
        // LOCKED 2026-07-22 (13-05): analyzed = analyzed / found. Nothing is
        // committed as "analyzed" until the terminal write (status "done"),
        // at which point ALL found candidates have been scored — target is
        // candidate_count. Held monotonic (Math.max(prev, …)) AND clamped to
        // the denominator (Math.min(…, row.candidate_count)) so a stale or
        // tampered read can never render a backward jump or a numerator
        // exceeding the denominator.
        const nextAnalyzed = row.status === "done" ? row.candidate_count : 0;
        setAnalyzed((prev) => Math.max(prev, Math.min(nextAnalyzed, row.candidate_count)));
        setCapCandidates(row.cap_candidates);
        setCapReached(row.cap_reached);
      }

      const next = row?.status ?? null;
      // Terminal-status branch is the SINGLE source of truth (RESEARCH.md
      // Pitfall 5): it clears BOTH the soft and hard timers so neither can
      // fire after a terminal status is observed, regardless of race. This
      // stays true even with the read decoupled from the dispatch — once a
      // terminal status is observed here, no further read OR dispatch can
      // fire again (the interval itself is cleared).
      if (next && TERMINAL_STATUSES.has(next)) {
        active = false;
        clearInterval(interval);
        clearTimeout(softTimeout);
        clearTimeout(hardTimeout);
        setSlow(false);
        onComplete?.(next);
      }
    }

    async function dispatchTick() {
      if (inFlight) return;
      inFlight = true;
      try {
        // Poll-AND-tick: each round-trip claims+advances one bounded slice
        // (09-PATTERNS.md the client-tick divergence) — but no longer blocks
        // the status read above.
        await tickDiscovery(jobId);
      } finally {
        inFlight = false;
      }
    }

    function tick() {
      void readStatus();
      void dispatchTick();
    }

    void tick();
    const interval = setInterval(tick, POLL_MS);

    // Soft, non-failing notice (D-04): the job is still running, just taking
    // longer than expected. Deliberately does NOT clearInterval and does NOT
    // call onComplete — polling and ticking continue uninterrupted.
    const softTimeout = setTimeout(() => {
      if (!active) return;
      setSlow(true);
    }, SOFT_THRESHOLD_MS);

    // Absolute safety ceiling (D-05): the ONLY client-side path that
    // surfaces a real failure. Only fires for a genuinely stuck job.
    const hardTimeout = setTimeout(() => {
      if (!active) return;
      active = false;
      clearInterval(interval);
      setTimedOut(true);
      onComplete?.("failed");
    }, ABSOLUTE_CEILING_MS);

    return () => {
      active = false;
      clearInterval(interval);
      clearTimeout(softTimeout);
      clearTimeout(hardTimeout);
    };
  }, [jobId, onComplete]);

  const isFailed = status === "failed" || timedOut;
  const isDegraded = status === "degraded";

  return (
    <Card className="w-full max-w-2xl border-warm-gray-200">
      <CardHeader>
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-medium text-warm-gray-700">
            Söker bostäder
          </h3>
          <Badge variant={status === "done" ? "default" : "secondary"}>
            {statusLabel(status)}
          </Badge>
        </div>
        {!isFailed && !isDegraded && (
          <p className="mt-1 text-sm text-warm-gray-600">
            {status === "pending"
              ? "I kö — startar snart…"
              : // Math.min is defense-in-depth so a stale read can never
                // render numerator > denominator (LOCKED 2026-07-22).
                `${Math.min(analyzed, candidateCount)} av ${candidateCount} annonser analyserade`}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {slow && !isFailed && !isDegraded && status !== "done" && (
          <div className="rounded-lg bg-warm-gray-50 px-4 py-3">
            <p className="text-sm text-warm-gray-600">
              Det tar längre tid än väntat, fortsätter…
            </p>
          </div>
        )}

        {capReached && (
          <div className="rounded-lg bg-terracotta-50 px-4 py-3">
            <p className="text-sm text-terracotta-600">
              Vi stannade vid {capCandidates} annonser (sökgräns).
            </p>
          </div>
        )}

        {isDegraded && (
          <div className="rounded-lg bg-terracotta-50 px-4 py-3">
            <p className="text-sm text-terracotta-600">
              Områdessökning är tillfälligt otillgänglig. Prova att analysera
              en enskild annons via länk istället.
            </p>
            <Link
              href="/dashboard"
              className="mt-2 inline-block text-sm font-medium text-terracotta-600 underline"
            >
              Till enskild sökning
            </Link>
          </div>
        )}

        {isFailed && (
          <div className="rounded-lg bg-terracotta-50 px-4 py-3">
            <p className="text-sm text-terracotta-600">
              {timedOut
                ? "Det tar längre tid än väntat. Försök igen."
                : "Sökningen kunde inte slutföras. Inga kostnader utöver det som redan skannats har tillkommit. Försök igen om en stund."}
            </p>
            <Link
              href="/discover"
              className="mt-2 inline-block text-sm font-medium text-terracotta-600 underline"
            >
              Försök igen
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
