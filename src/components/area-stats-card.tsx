import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AreaData } from "@/lib/market/scb-schema";
import { formatSEK } from "@/lib/utils";

interface AreaStatsCardProps {
  /** The persisted SCB demographics payload (rendered as-is; never recomputed). */
  areaData: AreaData;
}

/** A single demographics metric tile (mirrors listing-summary.tsx MetricCard). */
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
        <p className="mt-1 text-lg italic text-warm-gray-500">Ej tillganglig</p>
      ) : (
        <p className="mt-1 text-lg font-semibold text-warm-gray-900">{value}</p>
      )}
      {sublabel && value !== null && (
        <p className="mt-0.5 text-xs text-warm-gray-500">{sublabel}</p>
      )}
    </div>
  );
}

/** Formats the population total with the Swedish thousands separator. */
function formatPopulation(population: number | null): string | null {
  if (typeof population !== "number" || !Number.isFinite(population)) return null;
  return `${new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 0 }).format(
    Math.round(population),
  )} invånare`;
}

/**
 * Reduces the age distribution map to a single readable headline: the share of
 * residents under 20 vs 65+ (a coarse "ung/äldre" read). Returns null when the
 * map is absent/empty (the metric degrades to "Ej tillganglig").
 */
function formatAge(age: Record<string, number> | null): string | null {
  if (!age) return null;
  const entries = Object.entries(age);
  if (entries.length === 0) return null;

  let total = 0;
  let young = 0;
  let old = 0;
  for (const [code, count] of entries) {
    if (typeof count !== "number" || !Number.isFinite(count)) continue;
    total += count;
    // SCB age codes look like "0-19", "20-64", "65+", "-19", "65-" etc — read the
    // leading band start to bucket. Null-tolerant: unparseable codes just sum.
    const start = parseInt(code, 10);
    if (Number.isFinite(start)) {
      if (start < 20) young += count;
      else if (start >= 65) old += count;
    }
  }
  if (total <= 0) return null;
  const youngPct = Math.round((young / total) * 100);
  const oldPct = Math.round((old / total) * 100);
  return `${youngPct}% under 20 · ${oldPct}% 65+`;
}

/**
 * Reduces the tenure mix to the dominant upplåtelseform + its share. Returns null
 * when the map is absent/empty.
 */
function formatTenure(
  tenure: Record<string, number> | null,
): { value: string; sub: string } | null {
  if (!tenure) return null;
  const entries = Object.entries(tenure).filter(
    ([, v]) => typeof v === "number" && Number.isFinite(v) && v > 0,
  );
  if (entries.length === 0) return null;

  let total = 0;
  for (const [, v] of entries) total += v;
  if (total <= 0) return null;

  entries.sort((a, b) => b[1] - a[1]);
  const [topCode, topCount] = entries[0];
  const pct = Math.round((topCount / total) * 100);
  return {
    value: `${TENURE_LABELS[topCode] ?? topCode}`,
    sub: `${pct}% av bostäderna`,
  };
}

/** Common SCB upplåtelseform codes → Swedish labels (null-tolerant fallback to raw code). */
const TENURE_LABELS: Record<string, string> = {
  aganderatt: "Äganderätt",
  "äganderätt": "Äganderätt",
  bostadsratt: "Bostadsrätt",
  "bostadsrätt": "Bostadsrätt",
  hyresratt: "Hyresrätt",
  "hyresrätt": "Hyresrätt",
};

/**
 * `AreaStatsCard` — the AREA-01 panel (D-07/D-08/D-09).
 *
 * Renders the four SCB demographics metrics as a metric-card grid, each degrading
 * to "Ej tillganglig" when its source value is null (D-08 — kommun-correct beats
 * neighborhood-wrong). Shows the achieved geo level (DeSO neighborhood vs kommun
 * baseline; D-06) and a "Källa: SCB" + year footer (D-09). Renders only persisted
 * values — no recomputation.
 */
export function AreaStatsCard({ areaData }: AreaStatsCardProps) {
  const { geo, metrics, years, source } = areaData;

  const isKommunBaseline = geo.level === "kommun";
  const incomeValue =
    typeof metrics.income === "number" && Number.isFinite(metrics.income)
      ? formatSEK(Math.round(metrics.income))
      : null;
  const tenure = formatTenure(metrics.tenure);

  // The freshest year we can cite for the footer (population/tenure lead income).
  const footerYear =
    years.population ?? years.tenure ?? years.income ?? null;

  return (
    <Card className="w-full max-w-2xl border-warm-gray-200">
      <CardHeader>
        <CardTitle className="text-2xl font-semibold text-warm-gray-900">
          Områdesstatistik
        </CardTitle>
        <p className="mt-1 text-sm text-warm-gray-500">
          {isKommunBaseline
            ? "Begränsad platsdata — siffrorna gäller hela kommunen, inte enbart närområdet."
            : "Demografi för närområdet (DeSO)."}
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <MetricCard
            label="Inkomst"
            value={incomeValue}
            sublabel={
              incomeValue && years.income
                ? `Median, ${years.income}`
                : "Disponibel medianinkomst"
            }
          />
          <MetricCard
            label="Befolkning"
            value={formatPopulation(metrics.population)}
            sublabel={years.population ? `${years.population}` : null}
          />
          <MetricCard
            label="Åldersfördelning"
            value={formatAge(metrics.age)}
            sublabel={years.population ? `${years.population}` : null}
          />
          <MetricCard
            label="Upplåtelseform"
            value={tenure?.value ?? null}
            sublabel={tenure?.sub ?? null}
          />
        </div>

        <p className="text-xs text-warm-gray-500">
          Källa: SCB{footerYear ? ` · ${footerYear}` : ""}
          {source && source !== "SCB" ? ` (${source})` : ""}
        </p>
      </CardContent>
    </Card>
  );
}
