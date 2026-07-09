import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { MacroData } from "@/lib/market/macro-schema";
import { MACRO_CARD_LABELS } from "@/lib/report/banned-phrases";
import { formatSEK } from "@/lib/utils";

interface MacroContextCardProps {
  /** The persisted, safeParse'd macro_data payload (rendered as-is; never recomputed). */
  macroData: MacroData;
}

/**
 * A single macro metric tile (mirrors area-stats-card.tsx's MetricCard
 * verbatim). Each indicator degrades to "Ej tillgänglig" independently on
 * its own null value — never a combined all-or-nothing card (D-08 extended).
 */
function MetricCard({
  label,
  value,
  sublabel,
}: {
  label: string;
  value: string | null;
  sublabel?: string | null;
}) {
  return (
    <div className="rounded-lg bg-warm-gray-50 p-4">
      <p className="text-xs font-medium uppercase tracking-wider text-warm-gray-500">
        {label}
      </p>
      {value === null ? (
        <p className="mt-1 text-lg italic text-warm-gray-500">
          {MACRO_CARD_LABELS.unavailable}
        </p>
      ) : (
        <p className="mt-1 text-lg font-semibold text-warm-gray-900">
          {value}
        </p>
      )}
      {sublabel && value !== null && (
        <p className="mt-0.5 text-xs text-warm-gray-500">{sublabel}</p>
      )}
    </div>
  );
}

/** Formats a rate/percentage value with Swedish decimal comma, e.g. "1,75 %". */
function formatPercent(value: number | null): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `${new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 2 }).format(
    value,
  )} %`;
}

/**
 * `MacroContextCard` — the MACRO-01/MACRO-02 "Makroekonomisk kontext" panel.
 *
 * Renders the three macro indicators (Styrränta, Inflation KPIF, Regional
 * prisutveckling) as metric tiles, each independently degrading to
 * "Ej tillgänglig" on its own null value (D-08 extended to macro's
 * three-way independence). Labels render from the SHARED `MACRO_CARD_LABELS`
 * constant (banned-phrases.ts) — the same source the no-prediction
 * regression test scans — never hardcoded inline.
 *
 * CRITICAL (MACRO-02): this card renders number + label + source + period
 * ONLY. It NEVER runs a macro value through the deterministic flag engine or
 * any severity/band/color classifier, and NEVER renders directional/trend
 * text — unlike PriceComparisonCard's delta-based tone, macro is strictly
 * descriptive. The "ingen prognos eller rekommendation" sub-label doubles
 * as a defensive UI-level disclaimer alongside the schema/prompt/test
 * enforcement layers (Plans 01/02).
 */
export function MacroContextCard({ macroData }: MacroContextCardProps) {
  const { policyRate, inflation, regionalPrice } = macroData;

  const policyRateValue = formatPercent(policyRate?.value ?? null);
  const policyRateSublabel =
    policyRateValue && policyRate
      ? `${policyRate.source}${policyRate.date ? ` · ${policyRate.date}` : ""}`
      : null;

  const inflationValue = formatPercent(inflation?.value ?? null);
  const inflationSublabel =
    inflationValue && inflation
      ? `${inflation.measure}${inflation.period ? ` · ${inflation.period}` : ""}`
      : null;

  const regionalPriceValue =
    regionalPrice && typeof regionalPrice.value === "number" && Number.isFinite(regionalPrice.value)
      ? formatSEK(Math.round(regionalPrice.value * 1000))
      : null;
  const regionalPriceSublabel =
    regionalPriceValue && regionalPrice
      ? `${regionalPrice.regionCode ? `Län ${regionalPrice.regionCode}` : "Riket"}${
          regionalPrice.year ? ` · ${regionalPrice.year}` : ""
        }${regionalPrice.preliminary ? " (preliminär)" : ""}`
      : null;

  // Two independent sources feed this card (Riksbank + SCB) — cite both in the
  // footer regardless of which individual indicators are available, so the
  // provenance is always visible even under partial degradation.
  const sourceFooter = "Källa: Riksbank · SCB (KPIF) · SCB (BRF-pris, län)";

  return (
    <Card className="w-full max-w-2xl border-warm-gray-200">
      <CardHeader>
        <CardTitle className="text-2xl font-semibold text-warm-gray-900">
          {MACRO_CARD_LABELS.title}
        </CardTitle>
        <p className="mt-1 text-sm text-warm-gray-500">
          {MACRO_CARD_LABELS.subtitle}
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <MetricCard
            label={MACRO_CARD_LABELS.policyRate}
            value={policyRateValue}
            sublabel={policyRateSublabel}
          />
          <MetricCard
            label={MACRO_CARD_LABELS.inflation}
            value={inflationValue}
            sublabel={inflationSublabel}
          />
          <MetricCard
            label={MACRO_CARD_LABELS.regionalPrice}
            value={regionalPriceValue}
            sublabel={regionalPriceSublabel}
          />
        </div>

        <p className="text-xs text-warm-gray-500">{sourceFooter}</p>
      </CardContent>
    </Card>
  );
}
