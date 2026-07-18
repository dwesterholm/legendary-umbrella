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
  processed_count: number;
  candidate_count: number;
  cap_candidates: number;
  cost_sek_total: number;
  cap_reached: boolean;
}

/** Poll cadence — mirrors BrfProgress's light-but-responsive rhythm. */
const POLL_MS = 1500;

/**
 * Hard safety ceiling on polling. An area scrape of 20-30 listings runs
 * longer than a single Haiku BRF extraction (BrfProgress's 90s ceiling) — 5
 * minutes gives the scrape room to complete a full slice without the client
 * giving up prematurely.
 */
const MAX_POLL_MS = 5 * 60_000;

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
  const [processedCount, setProcessedCount] = useState(0);
  const [capCandidates, setCapCandidates] = useState(0);
  const [capReached, setCapReached] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    let active = true;
    // In-flight guard (WR-03, 09-REVIEW.md): `claim_discovery_slice`'s
    // atomic claim already makes a redundant concurrent `tickDiscovery` call
    // a benign no-op (the second claim just returns zero rows), but without
    // this guard a slice that takes longer than POLL_MS lets `setInterval`
    // fire a SECOND overlapping `poll()` while the first's
    // `await tickDiscovery(...)` is still in flight — needlessly doubling
    // Server Action invocations and claim RPC calls for zero benefit. This
    // flag makes an overlapping tick SKIP rather than queue.
    let inFlight = false;

    async function poll() {
      if (inFlight) return;
      inFlight = true;
      try {
        // Poll-AND-tick: each round-trip claims+advances one bounded slice
        // BEFORE reading the row (09-PATTERNS.md the client-tick divergence).
        await tickDiscovery(jobId);

        const { data } = await supabase
          .from("discovery_jobs")
          .select(
            "status, processed_count, candidate_count, cap_candidates, cost_sek_total, cap_reached",
          )
          .eq("id", jobId)
          .single();

        if (!active) return;

        const row = data as DiscoveryJobRow | null;
        if (row) {
          setStatus(row.status);
          setProcessedCount(row.processed_count);
          setCapCandidates(row.cap_candidates);
          setCapReached(row.cap_reached);
        }

        const next = row?.status ?? null;
        if (next && TERMINAL_STATUSES.has(next)) {
          active = false;
          clearInterval(interval);
          clearTimeout(timeout);
          onComplete?.(next);
        }
      } finally {
        inFlight = false;
      }
    }

    void poll();
    const interval = setInterval(poll, POLL_MS);

    const timeout = setTimeout(() => {
      if (!active) return;
      active = false;
      clearInterval(interval);
      setTimedOut(true);
      onComplete?.("failed");
    }, MAX_POLL_MS);

    return () => {
      active = false;
      clearInterval(interval);
      clearTimeout(timeout);
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
              : `${processedCount} av ${capCandidates} annonser analyserade`}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
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
