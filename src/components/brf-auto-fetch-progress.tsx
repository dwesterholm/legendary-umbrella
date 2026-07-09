"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/client";

interface BrfAutoFetchProgressProps {
  analysisId: string;
  /** Fired once the row's brf_status transitions OUT of `auto_fetching` into
   *  reading/extracting/scoring — hand-off to the existing BrfProgress. */
  onComplete?: () => void;
  /** Fired on `failed` status or the poll safety-ceiling timeout. */
  onTimeout?: () => void;
}

/**
 * Poll cadence + safety ceiling — reused verbatim from BrfProgress
 * (08-PATTERNS.md Status-Write + Poll Cadence shared pattern). Do not invent
 * new timing constants.
 */
const POLL_MS = 1500;
const MAX_POLL_MS = 90_000;

/**
 * UI-SPEC Copywriting Contract — the auto-fetch pre-step sequence, distinct
 * from and prepended to BrfProgress's existing 3-step reading/extracting/
 * scoring list. Never merged into one 6-step list.
 */
const STEPS: { label: string }[] = [
  { label: "Söker organisationsnummer…" },
  { label: "Hämtar dokument…" },
  { label: "Förbereder analys…" },
];

const TERMINAL_HANDOFF = new Set(["reading", "extracting", "scoring", "done"]);

/**
 * `BrfAutoFetchProgress` — the transient `auto_fetching` pre-step poller
 * (UI-SPEC §2). Mirrors `BrfProgress`'s exact visual pattern (Card, step-dot
 * done/active/pending styling, poll cadence) but owns its own short STEPS
 * list and its own completion semantics: the sequence completes as soon as
 * `brf_status` transitions OUT of `auto_fetching` into the existing
 * reading/extracting/scoring/done pipeline (hand-off to BrfProgress), and
 * treats `failed` or a stalled poll as `onTimeout` — never a bare retry, per
 * UI-SPEC the terminal failure path routes to the fallback banner + manual
 * upload.
 */
export function BrfAutoFetchProgress({
  analysisId,
  onComplete,
  onTimeout,
}: BrfAutoFetchProgressProps) {
  const [current, setCurrent] = useState(0);
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

      if (next === "failed") {
        active = false;
        clearInterval(interval);
        clearTimeout(timeout);
        onTimeout?.();
        return;
      }

      if (next && TERMINAL_HANDOFF.has(next)) {
        active = false;
        clearInterval(interval);
        clearTimeout(timeout);
        onComplete?.();
        return;
      }

      // Still auto_fetching (or transiently null right after the write) —
      // advance the visual pre-step indicator so the user sees progress
      // even though the underlying signal is coarse (a single status value).
      setCurrent((c) => Math.min(c + 1, STEPS.length - 1));
    }

    void poll();
    const interval = setInterval(poll, POLL_MS);

    const timeout = setTimeout(() => {
      if (!active) return;
      active = false;
      clearInterval(interval);
      setTimedOut(true);
      onTimeout?.();
    }, MAX_POLL_MS);

    return () => {
      active = false;
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [analysisId, onComplete, onTimeout]);

  return (
    <Card className="w-full max-w-2xl border-warm-gray-200">
      <CardHeader>
        <h3 className="text-lg font-medium text-warm-gray-700">
          Hämtar årsredovisningen automatiskt…
        </h3>
        {timedOut && (
          <p className="mt-1 text-sm text-terracotta-600">
            Det tar längre tid än väntat. Försök igen.
          </p>
        )}
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {STEPS.map((step, i) => {
            const done = i < current;
            const isActive = i === current;
            return (
              <li key={step.label} className="flex items-center gap-3">
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
