"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

interface BrfMatchConfirmationProps {
  /** The resolved organisationsnummer (e.g. "769600-1234"). */
  orgNr: string;
  /** The previewed fiscal year, or null when the preview fetch degraded. */
  fiscalYear: number | null;
  /** The matched BRF name, when available (Phase 6 listing data). */
  brfName: string | null;
  /** Invoked when the user confirms the match — triggers confirmAndAnalyze. */
  onConfirm: () => void;
  /** Invoked when the user rejects the match — routes to manual upload. */
  onReject: () => void;
  /** True while confirmAndAnalyze is in flight (disables the confirm button only). */
  pending?: boolean;
  /**
   * Optional ambiguous/failed-match banner (terracotta), rendered above the
   * detail block — reuses the codebase's single warning-banner convention
   * (rounded-t-xl bg-terracotta-50 / text-sm text-terracotta-600).
   */
  message?: string | null;
}

/**
 * `BrfMatchConfirmation` — the ENRICH-02 human-in-the-loop confirmation step
 * (T-08-15 mitigation). Shown even on a high-confidence org.nr match: the
 * user must see the org.nr + fiscal year (+ BRF name) and explicitly confirm
 * before any auto-fetched document is analyzed. Reject routes straight to
 * the existing manual `BrfUpload` view with zero intermediate friction —
 * manual upload stays a first-class, equally-prominent path (UI-SPEC §1/§3).
 */
export function BrfMatchConfirmation({
  orgNr,
  fiscalYear,
  brfName,
  onConfirm,
  onReject,
  pending,
  message,
}: BrfMatchConfirmationProps) {
  return (
    <Card className="w-full max-w-2xl border-warm-gray-200">
      {message && (
        <div className="rounded-t-xl bg-terracotta-50 px-6 py-3">
          <p className="text-sm text-terracotta-600">{message}</p>
        </div>
      )}

      <CardHeader>
        <h3 className="text-lg font-medium text-warm-gray-700">
          Stämmer detta med din bostad?
        </h3>
        <p className="mt-1 text-sm text-warm-gray-500">
          Vi hittade en årsredovisning som verkar matcha. Kontrollera att
          uppgifterna nedan stämmer innan vi analyserar den.
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {brfName && (
            <div className="rounded-lg bg-warm-gray-50 p-4 sm:col-span-2">
              <p className="text-xs font-medium uppercase tracking-wider text-warm-gray-500">
                Bostadsrättsförening
              </p>
              <p className="mt-1 text-lg font-semibold text-warm-gray-900">
                {brfName}
              </p>
            </div>
          )}
          <div className="rounded-lg bg-warm-gray-50 p-4">
            <p className="text-xs font-medium uppercase tracking-wider text-warm-gray-500">
              Organisationsnummer
            </p>
            <p className="mt-1 text-lg font-semibold text-warm-gray-900">
              {orgNr}
            </p>
          </div>
          <div className="rounded-lg bg-warm-gray-50 p-4">
            <p className="text-xs font-medium uppercase tracking-wider text-warm-gray-500">
              Räkenskapsår
            </p>
            {fiscalYear === null ? (
              <p className="mt-1 text-lg italic text-warm-gray-500">
                Ej tillganglig
              </p>
            ) : (
              <p className="mt-1 text-lg font-semibold text-warm-gray-900">
                {fiscalYear}
              </p>
            )}
          </div>
        </div>

        <div className="flex gap-3">
          <Button
            type="button"
            className="bg-sage-600 text-white hover:bg-sage-700 h-11 px-6"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? "Analyserar…" : "Ja, stämmer — analysera"}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11 px-6"
            onClick={onReject}
          >
            Nej, ladda upp manuellt
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
