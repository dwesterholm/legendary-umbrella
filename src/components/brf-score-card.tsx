"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { correctBrfField, type BrfData } from "@/actions/analyze-brf";
import { OSAKER_THRESHOLD } from "@/lib/brf/sanity";
import type {
  BrfGrade,
  BrfMetricKey,
  MetricBreakdown,
  MetricRating,
} from "@/lib/brf/score";
import type { UnderhallsplanValue } from "@/lib/schemas/brf";
import { cn, formatSEK } from "@/lib/utils";

interface BrfScoreCardProps {
  analysisId: string;
  /** The persisted analysis payload (extraction + grade + provenance). */
  brfData: BrfData;
  /** Lifts a re-scored payload to the parent so the row data stays in sync. */
  onCorrected?: (data: BrfData) => void;
}

/** Swedish labels + units per metric for the breakdown table (D-07). */
const METRIC_META: Record<
  BrfMetricKey,
  { label: string; kind: "sek" | "enum"; unit?: string }
> = {
  skuldPerKvm: { label: "Skuld per kvm", kind: "sek", unit: "/m²" },
  avgiftsniva: { label: "Årsavgift per kvm", kind: "sek", unit: "/m²/år" },
  kassaflode: { label: "Sparande per kvm", kind: "sek", unit: "/m²" },
  underhallsplanStatus: { label: "Underhållsplan", kind: "enum" },
};

/** Human-readable Swedish labels for the underhållsplan enum. */
const UNDERHALL_LABELS: Record<UnderhallsplanValue, string> = {
  finns_aktuell: "Finns, aktuell",
  finns_inaktuell: "Finns, inaktuell",
  oklart: "Oklart",
  saknas: "Saknas",
};

const UNDERHALL_OPTIONS: UnderhallsplanValue[] = [
  "finns_aktuell",
  "finns_inaktuell",
  "oklart",
  "saknas",
];

/** Grade → warm-palette colour band (D-07): A/B sage, C/D terracotta, E/F red. */
function gradeColors(grade: BrfGrade): string {
  if (grade === "A" || grade === "B") {
    return "bg-sage-600 text-white";
  }
  if (grade === "C" || grade === "D") {
    return "bg-terracotta-500 text-white";
  }
  return "bg-destructive text-white";
}

/** Short Swedish caption for the grade banner. */
function gradeCaption(grade: BrfGrade): string {
  switch (grade) {
    case "A":
    case "B":
      return "Stark ekonomi";
    case "C":
    case "D":
      return "Blandad bild — läs detaljerna";
    default:
      return "Svaga nyckeltal — var försiktig";
  }
}

/** Mini-rating → Swedish label + badge styling for the breakdown rows. */
function ratingBadge(rating: MetricRating): {
  label: string;
  className: string;
} {
  switch (rating) {
    case "strong":
      return { label: "Stark", className: "bg-sage-600 text-white" };
    case "good":
      return { label: "Bra", className: "bg-sage-500 text-white" };
    case "mid":
      return {
        label: "Medel",
        className: "bg-terracotta-100 text-terracotta-600",
      };
    case "weak":
      return { label: "Svag", className: "bg-terracotta-500 text-white" };
    default:
      return {
        label: "Ej bedömbar",
        className: "bg-warm-gray-100 text-warm-gray-500",
      };
  }
}

/** Formats a breakdown value for display (SEK figure or enum label). */
function displayValue(metric: MetricBreakdown): string {
  if (metric.value === null) return "";
  if (metric.key === "underhallsplanStatus") {
    return UNDERHALL_LABELS[metric.value as UnderhallsplanValue] ?? String(metric.value);
  }
  const meta = METRIC_META[metric.key];
  return `${formatSEK(metric.value as number)}${meta.unit ?? ""}`;
}

/**
 * `BrfScoreCard` — the trust payload of the BRF analysis (D-07/D-10/D-11/D-12).
 *
 * Renders the deterministic A–F grade (computed in `score.ts`, never by Claude),
 * a per-metric breakdown with each metric's value, mini-rating and weight
 * contribution (D-07), a confidence badge per figure that flips to
 * "Osäker — kontrollera själv" when confidence is below `OSAKER_THRESHOLD` (D-10),
 * the verbatim source quote + page reference straight from
 * `extraction.<metric>.sourceQuote` / `.pageRef` (D-11), and an inline editor
 * that calls `correctBrfField` to re-score deterministically WITHOUT re-calling
 * Claude — corrected fields are marked "Manuellt angiven" (D-12).
 */
export function BrfScoreCard({
  analysisId,
  brfData,
  onCorrected,
}: BrfScoreCardProps) {
  // The card owns the current payload so an inline correction re-renders the
  // grade + breakdown immediately from the re-scored result (D-12).
  const [data, setData] = useState<BrfData>(brfData);
  const [editingKey, setEditingKey] = useState<BrfMetricKey | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const { grade, breakdown, perFieldConfidence, manualFields, scanned } = {
    grade: data.grade.grade,
    breakdown: data.grade.breakdown,
    perFieldConfidence: data.perFieldConfidence,
    manualFields: data.manualFields ?? [],
    // `scanned` lives on the row, not the payload; the section may pass it in
    // future, so read defensively off the payload shape.
    scanned: (data as BrfData & { scanned?: boolean }).scanned ?? false,
  };

  const gradeBadge = gradeColors(grade);

  const beginEdit = (metric: MetricBreakdown) => {
    setError(null);
    setEditingKey(metric.key);
    if (metric.key === "underhallsplanStatus") {
      setDraft((metric.value as string) ?? "oklart");
    } else {
      setDraft(metric.value === null ? "" : String(metric.value));
    }
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setDraft("");
    setError(null);
  };

  const saveEdit = (key: BrfMetricKey) => {
    setError(null);
    const form = new FormData();
    form.set("analysisId", analysisId);
    form.set("field", key);
    form.set("value", draft);

    startTransition(async () => {
      // D-12: inline correction re-runs the deterministic scorer only — this
      // calls correctBrfField, NEVER analyzeBrf, so no new Claude call/cost.
      const result = await correctBrfField(form);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setData(result.data);
      setEditingKey(null);
      setDraft("");
      onCorrected?.(result.data);
    });
  };

  return (
    <Card className="w-full max-w-2xl border-warm-gray-200">
      {/* D-14: scanned-PDF heads-up, repurposing the listing-summary banner. */}
      {scanned && (
        <div className="rounded-t-xl bg-terracotta-50 px-6 py-3">
          <p className="text-sm text-terracotta-600">
            Skannad PDF — utläsningen kan bli osäkrare. Kontrollera siffrorna.
          </p>
        </div>
      )}

      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <div>
          <CardTitle className="text-2xl font-semibold text-warm-gray-900">
            BRF-betyg
          </CardTitle>
          <p className="mt-1 text-sm text-warm-gray-500">{gradeCaption(grade)}</p>
        </div>
        {/* D-07: prominent colour-coded A–F grade. */}
        <div
          className={cn(
            "flex h-16 w-16 items-center justify-center rounded-2xl text-4xl font-bold shadow-sm",
            gradeBadge,
          )}
          aria-label={`Betyg ${grade}`}
        >
          {grade}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* D-07: per-metric breakdown — value, mini-rating, weight contribution. */}
        {breakdown.map((metric) => {
          const meta = METRIC_META[metric.key];
          const isMissing = metric.value === null;
          const confidence = perFieldConfidence[metric.key] ?? 1;
          const isUncertain = confidence < OSAKER_THRESHOLD;
          const isManual = manualFields.includes(metric.key);
          const rating = ratingBadge(metric.rating);
          // CR-01 defence-in-depth: a malformed/partial payload may be missing
          // this metric's extraction entry; skip the row rather than crashing
          // on `ext.sourceQuote` below.
          const ext = data.extraction[metric.key];
          if (!ext) return null;
          const isEditing = editingKey === metric.key;

          return (
            <div
              key={metric.key}
              className="rounded-lg bg-warm-gray-50 p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase tracking-wider text-warm-gray-500">
                    {meta.label}
                  </p>
                  {isMissing ? (
                    <p className="mt-1 text-lg italic text-warm-gray-500">
                      Ej tillganglig
                    </p>
                  ) : (
                    <p className="mt-1 text-lg font-semibold text-warm-gray-900">
                      {displayValue(metric)}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <Badge className={rating.className}>{rating.label}</Badge>
                  <span className="text-xs text-warm-gray-500">
                    Vikt {Math.round(metric.weight * 100)}%
                  </span>
                </div>
              </div>

              {/* D-10 / D-12: confidence + provenance badges. */}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {isManual ? (
                  <Badge
                    variant="secondary"
                    className="bg-sage-100 text-sage-700"
                  >
                    Manuellt angiven
                  </Badge>
                ) : isUncertain ? (
                  <Badge variant="destructive">
                    Osäker — kontrollera själv
                  </Badge>
                ) : (
                  !isMissing && (
                    <Badge
                      variant="secondary"
                      className="bg-warm-gray-100 text-warm-gray-500"
                    >
                      Säkerhet {Math.round(confidence * 100)}%
                    </Badge>
                  )
                )}
                {!isEditing && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="text-warm-gray-500 hover:text-warm-gray-700"
                    onClick={() => beginEdit(metric)}
                  >
                    Ändra
                  </Button>
                )}
              </div>

              {/* D-11: verbatim source quote + page reference from extraction. */}
              {!isManual && ext.sourceQuote && (
                <details className="mt-2 text-sm">
                  <summary className="cursor-pointer text-warm-gray-500 hover:text-warm-gray-700">
                    {ext.pageRef
                      ? `Visa källa (sid ${ext.pageRef})`
                      : "Visa källa"}
                  </summary>
                  <blockquote className="mt-1 border-l-2 border-warm-gray-200 pl-3 italic text-warm-gray-700">
                    {ext.sourceQuote}
                  </blockquote>
                </details>
              )}

              {/* D-12: inline editor — re-scores via correctBrfField. */}
              {isEditing && (
                <div className="mt-3 space-y-2">
                  {meta.kind === "enum" ? (
                    <select
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      disabled={isPending}
                      className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                    >
                      {UNDERHALL_OPTIONS.map((opt) => (
                        <option key={opt} value={opt}>
                          {UNDERHALL_LABELS[opt]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      type="number"
                      inputMode="decimal"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      disabled={isPending}
                      placeholder={`Nytt värde (SEK${meta.unit ?? ""})`}
                    />
                  )}
                  {error && (
                    <p className="text-sm text-terracotta-600">{error}</p>
                  )}
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      className="bg-sage-600 text-white hover:bg-sage-700"
                      disabled={isPending}
                      onClick={() => saveEdit(metric.key)}
                    >
                      {isPending ? "Sparar…" : "Spara"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={isPending}
                      onClick={cancelEdit}
                    >
                      Avbryt
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        <p className="pt-1 text-xs text-warm-gray-500">
          Betyget beräknas i kod från nyckeltalen ovan.{" "}
          <a
            href="/sa-raknar-vi"
            className="underline underline-offset-2 hover:text-warm-gray-700"
          >
            Så räknar vi BRF-betyget
          </a>
        </p>
      </CardContent>
    </Card>
  );
}
