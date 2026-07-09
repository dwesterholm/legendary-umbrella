"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/client";

interface BrfProgressProps {
  analysisId: string;
  /** Fired once when the row reaches a terminal status. Stops the poll. */
  onComplete?: (status: string) => void;
  /** Server-resolved initial status so a reload resumes at the current step (D-13). */
  initialStatus?: string | null;
}

/** Poll cadence — light enough for status text, responsive enough for the UX (D-13). */
const POLL_MS = 1500;

/**
 * Hard safety ceiling on polling. One extraction is a single Haiku call (+ one
 * truncation retry) — comfortably under a minute. If no terminal status lands
 * within this window the run is wedged (a crashed action, a dropped terminal
 * write); stop spinning and surface a failure so the user can retry rather than
 * watching step 1 forever.
 */
const MAX_POLL_MS = 90_000;

/** D-13 step labels keyed by the persisted `brf_status` value. */
const STEPS: { status: string; label: string }[] = [
  { status: "reading", label: "Laser dokumentet..." },
  { status: "extracting", label: "Extraherar nyckeltal..." },
  { status: "scoring", label: "Beraknar betyg..." },
];

function stepIndex(status: string | null): number {
  // `auto_fetching` is a Phase 8 pre-step transient status that precedes this
  // component's 3-step sequence entirely (BrfAutoFetchProgress owns its own
  // separate step list for it) — treat it as "not yet reading" (index 0, no
  // steps done yet) rather than falling through the same -1 branch reading/
  // extracting/scoring would, keeping the two sequences visually distinct.
  if (status === "auto_fetching") return 0;
  const i = STEPS.findIndex((s) => s.status === status);
  return i === -1 ? 0 : i;
}

/**
 * `BrfProgress` — polls the analyses row's `brf_status` every ~1.5s under the
 * user's own RLS session and renders the D-13 step indicator. Because status is
 * server-persisted, a reload mid-run resumes at the current step. On `done` /
 * `failed` it fires `onComplete` and clears the interval (effect cleanup).
 */
export function BrfProgress({
  analysisId,
  onComplete,
  initialStatus,
}: BrfProgressProps) {
  const [status, setStatus] = useState<string | null>(initialStatus ?? "reading");
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    let active = true;

    async function poll() {
      const { data } = await supabase
        .from("analyses")
        .select("brf_status")
        .eq("id", analysisId)
        .single();

      if (!active) return;

      const next = (data?.brf_status as string | null) ?? null;
      if (next) setStatus(next);

      if (next === "done" || next === "failed") {
        active = false;
        clearInterval(interval);
        clearTimeout(timeout);
        onComplete?.(next);
      }
    }

    // Poll immediately, then on an interval until a terminal status.
    void poll();
    const interval = setInterval(poll, POLL_MS);

    // Safety ceiling: a wedged run never reaches done/failed, so the poll would
    // spin forever. After MAX_POLL_MS, stop and surface a failure (the parent
    // routes "failed" to a retry affordance).
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
  }, [analysisId, onComplete]);

  const current = stepIndex(status);

  return (
    <Card className="w-full max-w-2xl border-warm-gray-200">
      <CardHeader>
        <h3 className="text-lg font-medium text-warm-gray-700">
          Analyserar arsredovisningen
        </h3>
        {timedOut && (
          <p className="mt-1 text-sm text-terracotta-600">
            Det tar langre tid an vantat. Forsok igen.
          </p>
        )}
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {STEPS.map((step, i) => {
            const done = i < current;
            const isActive = i === current;
            return (
              <li key={step.status} className="flex items-center gap-3">
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${
                    done
                      ? "bg-sage-600 text-white"
                      : isActive
                        ? "bg-sage-100 text-sage-700"
                        : "bg-warm-gray-100 text-warm-gray-400"
                  }`}
                >
                  {done ? (
                    "✓"
                  ) : isActive ? (
                    <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-sage-600 border-t-transparent" />
                  ) : (
                    i + 1
                  )}
                </span>
                <span
                  className={`text-sm ${
                    done || isActive
                      ? "text-warm-gray-700"
                      : "text-warm-gray-400"
                  }`}
                >
                  {step.label}
                </span>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
