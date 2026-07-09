"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { BrfUpload } from "@/components/brf-upload";
import { BrfProgress } from "@/components/brf-progress";
import { BrfAutoFetchProgress } from "@/components/brf-auto-fetch-progress";
import { BrfMatchConfirmation } from "@/components/brf-confirm";
import { BrfScoreCard } from "@/components/brf-score-card";
import type { BrfData } from "@/lib/brf/run-extraction";
import { resolveOrgNrAction, confirmAndAnalyze } from "@/actions/fetch-brf-auto";

interface BrfSectionListingData {
  brfName: string | null;
}

interface BrfSectionProps {
  analysisId: string;
  /** Server-resolved: guests get the teaser, never the upload affordance (D-05). */
  isGuest: boolean;
  /** Persisted `brf_status` off the analyses row (null before any upload). */
  brfStatus?: string | null;
  /** Persisted `brf_data` off the analyses row (present once status is `done`). */
  brfData?: BrfData | null;
  /** Optional broker listing URL forwarded to the dropzone deep-link (D-02). */
  agencyListingUrl?: string;
  /**
   * The listing fields needed to attempt org.nr resolution (ENRICH-01/02).
   * When `brfName` is absent/empty, resolution is skipped entirely and the
   * section goes straight to the manual upload view — a silent, honest
   * degrade (auto-fetch was never attempted, not a failure).
   */
  listingData?: BrfSectionListingData | null;
  /** Provenance of the persisted brf_data ("auto_allabrf" | "auto_bolagsverket" | "manual"). */
  brfFetchSource?: string | null;
  /** The persisted document's fiscal year, when known. */
  fiscalYear?: number | null;
  /** Whether the fetched fiscal year is the most recent available; null when unknown. */
  isMostRecent?: boolean | null;
}

const IN_PROGRESS = new Set(["reading", "extracting", "scoring"]);

type View = "upload" | "confirm" | "auto-fetching" | "progress" | "result" | "failed";

/** Preview data stashed from a high-confidence resolveOrgNrAction result. */
interface ConfirmState {
  orgNr: string;
  fiscalYear: number | null;
  brfName: string | null;
}

function initialView(status: string | null | undefined, data: BrfData | null | undefined): View {
  if (status === "done" && data) return "result";
  if (status === "failed") return "failed";
  if (status === "auto_fetching") return "auto-fetching";
  if (status && IN_PROGRESS.has(status)) return "progress";
  return "upload";
}

/**
 * `BrfSection` — orchestrates the BRF block (D-04 in-place replacement of the
 * "Kommer snart" placeholder). Branches: guest teaser (D-05) | upload | live
 * progress (D-13) | result. Seeds initial state from the server-passed props so
 * a reload resumes correctly, and reacts to onStarted/onComplete to move through
 * upload → progress → result without a full reload. The score card itself is
 * Plan 06 — here the `result` view is a minimal "Analys klar" confirmation that
 * reads the grade off `brfData`, so the end-to-end flow is verifiable.
 */
export function BrfSection({
  analysisId,
  isGuest,
  brfStatus,
  brfData,
  agencyListingUrl,
  listingData,
  brfFetchSource,
  fiscalYear,
  isMostRecent,
}: BrfSectionProps) {
  const [view, setView] = useState<View>(() => initialView(brfStatus, brfData));
  const [data, setData] = useState<BrfData | null>(brfData ?? null);
  // The actual server-action error (e.g. upload/persist failure). Owned here
  // because BrfUpload unmounts on the onStarted view switch (D-13 / WR-04).
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Preview stashed from a high-confidence resolveOrgNrAction result, feeding
  // the confirmation step (ENRICH-02) and the confirmAndAnalyze call.
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);

  // WR-04: tracks the analysisId resolution has already been attempted for,
  // so the effect below can safely list its full dependency set (brfStatus,
  // listingData) WITHOUT risking an infinite loop or a double-fire — a ref
  // update never triggers a re-render/re-run, unlike state. This closes the
  // stale-closure risk the previous `[analysisId, isGuest]`-only deps array
  // had (silenced via eslint-disable): if a future caller re-renders
  // `BrfSection` with an updated `brfStatus`/`listingData` (e.g. a parent
  // that lifts live state) rather than remounting it, this effect now
  // actually re-evaluates against the CURRENT props instead of the ones
  // captured at mount — while the ref guard still guarantees resolution is
  // attempted AT MOST ONCE per analysisId, exactly like before.
  const resolutionAttemptedForId = useRef<string | null>(null);

  // ENRICH-01/02: attempt org.nr resolution on mount (or on a genuine prop
  // change) for an authenticated owner with a listing brfName. Never
  // re-resolves an already-done/in-flight row (T-08-12-adjacent — the
  // existing result/progress view wins), and is never attempted for a guest
  // (T-08-16, D-05 defense-in-depth — this effect only runs past the isGuest
  // early return below, but the guard is repeated here for clarity/safety
  // since hooks must run unconditionally).
  useEffect(() => {
    if (isGuest) return;
    if (resolutionAttemptedForId.current === analysisId) return;
    const status = brfStatus ?? null;
    const alreadyResolved =
      status === "done" || status === "failed" || status === "auto_fetching" || (status && IN_PROGRESS.has(status));
    if (alreadyResolved) return;
    const brfName = listingData?.brfName?.trim();
    if (!brfName) return;

    resolutionAttemptedForId.current = analysisId;

    let active = true;
    void resolveOrgNrAction(analysisId).then((result) => {
      if (!active) return;
      if (result.ok && result.confidence === "high") {
        setConfirmState({
          orgNr: result.orgNr,
          fiscalYear: result.fiscalYear,
          brfName: result.brfName,
        });
        setView("confirm");
      }
      // low/none/fallThrough (or a resolve-level error) → stay on the default
      // "upload" view with no error banner — a silent, honest degrade since
      // auto-fetch was simply never attempted.
    });

    return () => {
      active = false;
    };
  }, [analysisId, isGuest, brfStatus, listingData]);

  // Guest teaser (D-05) — defence-in-depth UI; the hard gate is the server action.
  if (isGuest) {
    return (
      <div className="rounded-xl border-2 border-dashed border-warm-gray-200 p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-lg font-medium text-warm-gray-700">
              BRF Analys
            </h3>
            <p className="mt-1 text-sm text-warm-gray-500">
              Ladda upp arsredovisningen och fa ett betyg pa foreningens ekonomi.
            </p>
          </div>
          <Badge
            variant="secondary"
            className="bg-warm-gray-100 text-warm-gray-500"
          >
            Premium
          </Badge>
        </div>
        <Button
          asChild
          className="mt-4 bg-sage-600 text-white hover:bg-sage-700 h-11 px-6"
        >
          <Link href="/login">Logga in for BRF-analys</Link>
        </Button>
      </div>
    );
  }

  if (view === "confirm" && confirmState) {
    return (
      <BrfMatchConfirmation
        orgNr={confirmState.orgNr}
        fiscalYear={confirmState.fiscalYear}
        brfName={confirmState.brfName}
        pending={confirmPending}
        onReject={() => {
          // Zero intermediate friction (UI-SPEC §1/§3) — straight to upload,
          // manual stays a first-class, equally-prominent path.
          setConfirmState(null);
          setView("upload");
        }}
        onConfirm={() => {
          setConfirmPending(true);
          setView("auto-fetching");
          void confirmAndAnalyze(
            analysisId,
            confirmState.orgNr,
            confirmState.fiscalYear,
          ).then((result) => {
            setConfirmPending(false);
            if (!result.ok && "fallThrough" in result && result.fallThrough) {
              // Ambiguous/failed auto-fetch → the terracotta fallback banner +
              // manual upload (never a wrong-BRF analysis, T-08-13).
              setErrorMsg(result.error);
              setView("failed");
            }
            // A successful confirmAndAnalyze delegates to runBrfExtraction,
            // which the BrfAutoFetchProgress poller below observes via the
            // brf_status transition — no state change needed here on success.
          });
        }}
      />
    );
  }

  if (view === "auto-fetching") {
    return (
      <BrfAutoFetchProgress
        analysisId={analysisId}
        onComplete={() => setView("progress")}
        onTimeout={() => {
          setErrorMsg(
            "Vi kunde inte hämta årsredovisningen automatiskt. Ladda upp den manuellt istället.",
          );
          setView("failed");
        }}
      />
    );
  }

  if (view === "progress") {
    return (
      <BrfProgress
        analysisId={analysisId}
        initialStatus={brfStatus}
        onComplete={(status) => {
          if (status === "failed") {
            setView("failed");
          } else {
            // Status is done; the persisted brfData arrives on the next page load.
            // For an in-session completion we flip to result and let the row data
            // (seeded from props, or a reload) populate the grade.
            setView("result");
          }
        }}
      />
    );
  }

  if (view === "result") {
    // Persisted brfData present → render the full score card (D-07/D-10/D-11/D-12).
    if (data) {
      return (
        <BrfScoreCard
          analysisId={analysisId}
          brfData={data}
          onCorrected={setData}
          fiscalYear={fiscalYear}
          fetchSource={
            brfFetchSource as
              | "auto_allabrf"
              | "auto_bolagsverket"
              | "manual"
              | null
              | undefined
          }
          isMostRecent={isMostRecent}
        />
      );
    }
    // In-session completion without the row payload yet — prompt a reload so the
    // server-fetched brfData hydrates the score card.
    return (
      <Card className="w-full max-w-2xl border-warm-gray-200">
        <CardHeader>
          <h3 className="text-lg font-medium text-warm-gray-700">BRF Analys</h3>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-warm-gray-700">
            Analys klar. Ladda om sidan for att se betygskortet.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (view === "failed") {
    return (
      <Card className="w-full max-w-2xl border-warm-gray-200">
        <div className="rounded-t-xl bg-terracotta-50 px-6 py-3">
          <p className="text-sm text-terracotta-600">
            {errorMsg ?? "Vi kunde inte lasa dokumentet automatiskt. Forsok igen."}
          </p>
        </div>
        <CardContent className="pt-6">
          <BrfUpload
            analysisId={analysisId}
            agencyListingUrl={agencyListingUrl}
            onStarted={() => {
              setErrorMsg(null);
              setView("progress");
            }}
            onFailed={(msg) => {
              setErrorMsg(msg);
              setView("failed");
            }}
          />
        </CardContent>
      </Card>
    );
  }

  // Default: upload view.
  return (
    <div className="rounded-xl border-2 border-dashed border-warm-gray-200 p-6">
      <h3 className="mb-4 text-lg font-medium text-warm-gray-700">BRF Analys</h3>
      <BrfUpload
        analysisId={analysisId}
        agencyListingUrl={agencyListingUrl}
        onStarted={() => {
          setErrorMsg(null);
          setView("progress");
        }}
        onFailed={(msg) => {
          setErrorMsg(msg);
          setView("failed");
        }}
      />
    </div>
  );
}
