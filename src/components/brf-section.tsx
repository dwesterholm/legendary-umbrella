"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { BrfUpload } from "@/components/brf-upload";
import { BrfProgress } from "@/components/brf-progress";
import { BrfScoreCard } from "@/components/brf-score-card";
import type { BrfData } from "@/actions/analyze-brf";

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
}

const IN_PROGRESS = new Set(["reading", "extracting", "scoring"]);

type View = "upload" | "progress" | "result" | "failed";

function initialView(status: string | null | undefined, data: BrfData | null | undefined): View {
  if (status === "done" && data) return "result";
  if (status === "failed") return "failed";
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
}: BrfSectionProps) {
  const [view, setView] = useState<View>(() => initialView(brfStatus, brfData));
  const [data, setData] = useState<BrfData | null>(brfData ?? null);
  // The actual server-action error (e.g. upload/persist failure). Owned here
  // because BrfUpload unmounts on the onStarted view switch (D-13 / WR-04).
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

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
