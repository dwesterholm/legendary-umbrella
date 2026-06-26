"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { generateReport } from "@/actions/generate-report";
import { downloadReportPdf } from "@/actions/download-report-pdf";
import { ReportFlags } from "@/components/report-flags";
import type { ReportData, ThemedSection } from "@/lib/schemas/report";

interface AiReportSectionProps {
  analysisId: string;
  /** Persisted, re-validated report_data (null = not generated yet — CR-01). */
  report: ReportData | null;
  /** Server-resolved guest state. Guests NEVER see report content (D-09). */
  isGuest: boolean;
  /** Persisted report_status — drives the in-flight ("generating") affordance. */
  reportStatus?: string | null;
  /**
   * Whether the current input fingerprint differs from the stored one (D-08).
   * Computed on the page from the SAME assembleFactSheet bytes the action hashed.
   */
  isStale: boolean;
}

/** A themed section's Swedish heading. */
const SECTION_TITLES = {
  ekonomi: "Ekonomi",
  pris: "Pris",
  omrade: "Område",
} as const;

/** Renders one themed section: honest "Ej tillgänglig" marker or its cited claims. */
function ThemedSectionBlock({
  title,
  section,
}: {
  title: string;
  section: ThemedSection;
}) {
  return (
    <div className="rounded-lg bg-warm-gray-50 p-4">
      <p className="text-xs font-medium uppercase tracking-wider text-warm-gray-500">
        {title}
      </p>
      {section.status === "ej_tillgänglig" || section.claims.length === 0 ? (
        // D-07/D-12: honest absence — never a fabricated interpretation.
        <p className="mt-1 text-base italic text-warm-gray-500">
          Ej tillgänglig
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {section.claims.map((claim, i) => (
            <li key={i} className="text-sm text-warm-gray-700">
              <span>{claim.text}</span>
              {/* D-06: every claim points back to a real datum. */}
              <span className="ml-1 text-xs text-warm-gray-400">
                ({claim.sourceRef})
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * `AiReportSection` — the AI report anchor for the analysis page (RPRT-01/03,
 * D-00/D-04/D-05/D-07/D-08/D-09/D-12). Mirrors the brf-score-card.tsx trigger
 * pattern (`"use client"` + useTransition + server action).
 *
 * Render branches:
 *  - GUEST → a "Logga in för AI-rapport" teaser only — NEVER the report (D-09).
 *  - OWNER + no report → a manual "Generera AI-rapport" button (D-07); the
 *    in-flight lock + a pending-disabled button prevent a double-spend.
 *  - OWNER + report → the leadSynthesis renders as the page ANCHOR (D-00/D-05),
 *    the themed Ekonomi/Pris/Område sections (each honest "Ej tillgänglig" when
 *    absent, D-07/D-12), the woven flags, the "ej finansiell rådgivning"
 *    disclaimer + source/freshness labels (D-12), and a "Ladda ner PDF" button
 *    that downloads the persisted snapshot via URL.createObjectURL (RPRT-03/D-10).
 *  - OWNER + stale → a "Rapporten bygger på äldre data — uppdatera" marker + a
 *    regenerate button (re-calls generateReport, D-08) — no silent auto-refire.
 */
export function AiReportSection({
  analysisId,
  report,
  isGuest,
  reportStatus,
  isStale,
}: AiReportSectionProps) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isDownloading, startDownload] = useTransition();

  // ---- GUEST: teaser only, never the report content (D-09) ----
  if (isGuest) {
    return (
      <Card className="w-full max-w-2xl border-warm-gray-200">
        <CardHeader>
          <CardTitle className="text-2xl font-semibold text-warm-gray-900">
            AI-rapport
          </CardTitle>
          <p className="mt-1 text-sm text-warm-gray-500">
            Få en sammanvägd andrabedömning av pris, BRF och område.
          </p>
        </CardHeader>
        <CardContent>
          <Button
            asChild
            className="h-11 bg-sage-600 px-6 text-white hover:bg-sage-700"
          >
            <a href="/login">Logga in för AI-rapport</a>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const triggerGenerate = () => {
    setError(null);
    startTransition(async () => {
      const result = await generateReport(analysisId);
      if (!result.ok) {
        setError(result.error);
      }
      // On success the page is re-fetched on the next navigation/refresh; the
      // server is the source of truth for the persisted report (D-11).
    });
  };

  const triggerDownload = () => {
    setError(null);
    startDownload(async () => {
      const result = await downloadReportPdf(analysisId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // RESEARCH Pitfall 6: object-URL download, then revoke to free memory.
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ai-rapport-${analysisId}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  };

  const isGenerating = reportStatus === "generating" || isPending;

  // ---- OWNER + no report yet → the manual trigger (D-07) ----
  if (!report) {
    return (
      <Card className="w-full max-w-2xl border-warm-gray-200">
        <CardHeader>
          <CardTitle className="text-2xl font-semibold text-warm-gray-900">
            AI-rapport
          </CardTitle>
          <p className="mt-1 text-sm text-warm-gray-500">
            En sammanvägd andrabedömning som kopplar ihop pris, BRF och område.
          </p>
        </CardHeader>
        <CardContent>
          <Button
            type="button"
            className="h-11 bg-sage-600 px-6 text-white hover:bg-sage-700"
            disabled={isGenerating}
            onClick={triggerGenerate}
          >
            {isGenerating ? "Genererar rapport…" : "Generera AI-rapport"}
          </Button>
          {error && (
            <p className="mt-3 text-sm text-terracotta-600">{error}</p>
          )}
        </CardContent>
      </Card>
    );
  }

  // ---- OWNER + report present → the anchor render ----
  const { report: ai, flags } = report;

  return (
    <Card className="w-full max-w-2xl border-warm-gray-200">
      <CardHeader>
        <CardTitle className="text-2xl font-semibold text-warm-gray-900">
          AI-rapport
        </CardTitle>
        {/* D-08: stale marker + manual regenerate — no silent auto-refire. */}
        {isStale && (
          <div className="mt-2 rounded-lg bg-terracotta-50 px-4 py-3">
            <p className="text-sm text-terracotta-600">
              Rapporten bygger på äldre data — uppdatera för att ta med de
              senaste ändringarna.
            </p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="mt-2 text-terracotta-600 hover:text-terracotta-700"
              disabled={isGenerating}
              onClick={triggerGenerate}
            >
              {isGenerating ? "Genererar rapport…" : "Uppdatera rapporten"}
            </Button>
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {/* D-00/D-05: the cross-source synthesis is the page anchor. */}
        <div className="rounded-xl bg-sage-50 p-5">
          <p className="text-base leading-relaxed text-warm-gray-900">
            {ai.leadSynthesis}
          </p>
        </div>

        {/* Themed interpretations — each honest "Ej tillgänglig" when absent. */}
        <div className="space-y-3">
          <ThemedSectionBlock title={SECTION_TITLES.ekonomi} section={ai.ekonomi} />
          <ThemedSectionBlock title={SECTION_TITLES.pris} section={ai.pris} />
          <ThemedSectionBlock title={SECTION_TITLES.omrade} section={ai.omrade} />
        </div>

        {/* D-00: the prioritized flags, in the shared sage/terracotta language. */}
        {flags.length > 0 && (
          <ReportFlags
            flags={flags}
            title="Flaggor"
            only={
              ai.prioritizedFlagIds.length > 0
                ? ai.prioritizedFlagIds
                : undefined
            }
          />
        )}

        {/* RPRT-03/D-10: portable snapshot — same experience, downloadable. */}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button
            type="button"
            className="h-11 bg-sage-600 px-6 text-white hover:bg-sage-700"
            disabled={isDownloading}
            onClick={triggerDownload}
          >
            {isDownloading ? "Skapar PDF…" : "Ladda ner PDF"}
          </Button>
          {error && <p className="text-sm text-terracotta-600">{error}</p>}
        </div>

        {/* D-12: trust treatment — disclaimer + source/model provenance. */}
        <div className="space-y-1 border-t border-warm-gray-100 pt-3">
          <p className="text-xs italic text-warm-gray-500">
            Detta är ej finansiell rådgivning. AI-rapporten är en sammanvägd
            tolkning av tillgänglig data — kontrollera alltid själv.
          </p>
          {(report.model || report.promptVersion) && (
            <p className="text-xs text-warm-gray-400">
              Genererad av {report.model ?? "AI-modell"}
              {report.promptVersion ? ` · ${report.promptVersion}` : ""}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
