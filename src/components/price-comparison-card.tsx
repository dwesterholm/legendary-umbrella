import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { PriceData, SoldComp } from "@/lib/market/sold-schema";
import { classifyTrend } from "@/lib/market/compare";
import { cn, formatSEK } from "@/lib/utils";

interface PriceComparisonCardProps {
  /** The persisted price comparison payload (the honest-state `reason` drives the render). */
  priceData: PriceData;
  /**
   * The listing's own pris/kvm read off the row (NOT recomputed here). Used only
   * for the "ok" headline ("Denna bostad: X kr/m²"). When `reason` is
   * `listing_pris_okand` this is missing/0 and we never render a ±% headline.
   */
  listingPrisPerKvm?: number | null;
}

/** The "ej värdering" disclaimer text (D-09 / legal caution). */
const EJ_VARDERING =
  "Detta är en statistisk jämförelse, inte en värdering eller finansiell rådgivning.";

/** D-01 tier → Swedish label for the "Baserat på N försäljningar i …" caption. */
const TIER_LABEL: Record<NonNullable<PriceData["tier"]>, string> = {
  building: "samma fastighet",
  neighborhood: "närområdet",
  wide: "ett vidare område",
};

/** Formats a kr/m² figure (rounded SEK + "/m²"). */
function krPerKvm(value: number): string {
  return `${formatSEK(Math.round(value))}/m²`;
}

/** Swedish source + freshness label for the footer (D-09). */
function SourceFooter({ priceData }: { priceData: PriceData }) {
  const sourceLabel =
    priceData.source && priceData.sourceLabel
      ? `Källa: ${priceData.source}, ${priceData.sourceLabel}`
      : priceData.source
        ? `Källa: ${priceData.source}`
        : null;

  return (
    <div className="space-y-1 pt-1">
      {sourceLabel && (
        <p className="text-xs text-warm-gray-500">
          {sourceLabel}
          {priceData.recency ? ` · senaste försäljning ${priceData.recency}` : ""}
        </p>
      )}
      <p className="text-xs italic text-warm-gray-500">{EJ_VARDERING}</p>
    </div>
  );
}

/** Renders a single comp row in the "receipt" reveal (D-05/D-03 — show only what exists). */
function CompRow({ comp }: { comp: SoldComp }) {
  const bits: string[] = [];
  if (comp.objectType) bits.push(comp.objectType);
  if (typeof comp.rooms === "number") bits.push(`${comp.rooms} rum`);
  if (typeof comp.livingArea === "number") bits.push(`${comp.livingArea} m²`);
  if (comp.floor) bits.push(comp.floor);

  return (
    <li className="flex items-baseline justify-between gap-3 border-b border-warm-gray-100 py-1.5 last:border-b-0">
      <span className="min-w-0 truncate text-warm-gray-700">
        {comp.soldDate ?? "okänt datum"}
        {bits.length > 0 ? (
          <span className="text-warm-gray-500"> · {bits.join(" · ")}</span>
        ) : null}
      </span>
      <span className="shrink-0 font-medium text-warm-gray-900">
        {typeof comp.prisPerKvm === "number" && comp.prisPerKvm > 0
          ? krPerKvm(comp.prisPerKvm)
          : "—"}
      </span>
    </li>
  );
}

/** The expandable comparable-sales "receipt" (D-05/D-09), native <details> — no JS. */
function CompReceipt({ comps }: { comps: SoldComp[] }) {
  if (comps.length === 0) return null;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-warm-gray-500 hover:text-warm-gray-700">
        Visa jämförda försäljningar ({comps.length})
      </summary>
      <ul className="mt-2 border-l-2 border-warm-gray-200 pl-3">
        {comps.map((comp, i) => (
          <CompRow key={i} comp={comp} />
        ))}
      </ul>
    </details>
  );
}

/** Confidence + tier → a warm-band Badge (D-09). Low confidence mirrors the BRF "Osäker" treatment. */
function ConfidenceBadge({ priceData }: { priceData: PriceData }) {
  const pct = Math.round(priceData.confidence * 100);
  if (priceData.confidence < 0.5) {
    return (
      <Badge variant="destructive">Osäker — få jämförelser ({pct}%)</Badge>
    );
  }
  if (priceData.confidence < 0.75) {
    return (
      <Badge className="bg-terracotta-100 text-terracotta-600">
        Måttlig säkerhet ({pct}%)
      </Badge>
    );
  }
  return (
    <Badge className="bg-sage-100 text-sage-700">God säkerhet ({pct}%)</Badge>
  );
}

/** Shared card chrome so every honest state shares the heading + footer. */
function PriceCard({ children }: { children: React.ReactNode }) {
  return (
    <Card className="w-full max-w-2xl border-warm-gray-200">
      <CardHeader>
        <CardTitle className="text-2xl font-semibold text-warm-gray-900">
          Prisjämförelse
        </CardTitle>
        <p className="mt-1 text-sm text-warm-gray-500">
          Statistisk jämförelse mot sålda bostäder i området.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

/**
 * `PriceComparisonCard` — the PRICE-01 panel (D-04/D-05/D-09).
 *
 * Branches on `priceData.reason` BEFORE any headline so the four honest states are
 * NEVER collapsed into one (HIGH-1 / HIGH-3):
 *  - `source_unavailable` → a DISTINCT neutral "ej tillgänglig" message (a dead
 *    source is never shown as merely sparse). No ±%, no fabricated areaAvg.
 *  - `listing_pris_okand` → "pris/kvm saknas för objektet"; never a false −100 %.
 *  - `thin`               → the genuinely-sparse "för få försäljningar" marker
 *    (distinct copy + treatment from source_unavailable) with low confidence.
 *  - `ok`                 → the ±% headline + supporting detail + comp receipt.
 *
 * Renders only persisted values — NO recomputation (the ±%/confidence/distribution
 * are already deterministic arithmetic from the core; D-08/D-09 trust model).
 */
export function PriceComparisonCard({
  priceData,
  listingPrisPerKvm,
}: PriceComparisonCardProps) {
  // ---- source_unavailable (HIGH-1): a dead source, NEVER the thin marker ----
  if (priceData.reason === "source_unavailable") {
    return (
      <PriceCard>
        <div className="rounded-lg bg-warm-gray-50 p-4">
          <p className="text-base font-medium text-warm-gray-700">
            Prisjämförelse ej tillgänglig
          </p>
          <p className="mt-1 text-sm text-warm-gray-500">
            Vi kunde inte hämta försäljningsdata för det här området just nu.
            Det här är inte detsamma som att det saknas försäljningar — källan
            gick inte att nå.
          </p>
        </div>
        <SourceFooter priceData={priceData} />
      </PriceCard>
    );
  }

  // ---- listing_pris_okand (HIGH-3): no listing pris/kvm → no ±% headline ----
  if (priceData.reason === "listing_pris_okand") {
    return (
      <PriceCard>
        <div className="rounded-lg bg-warm-gray-50 p-4">
          <p className="text-base font-medium text-warm-gray-700">
            Prisjämförelse kräver objektets pris/kvm
          </p>
          <p className="mt-1 text-sm text-warm-gray-500">
            pris/kvm saknas för objektet, så vi kan inte räkna ut hur det ligger
            mot områdets snitt.
          </p>
        </div>
        {/* We may still show the area average if comps existed, clearly framed. */}
        {typeof priceData.areaAvg === "number" && priceData.areaAvg > 0 && (
          <p className="text-sm text-warm-gray-700">
            Områdets snitt: {krPerKvm(priceData.areaAvg)}.
          </p>
        )}
        <CompReceipt comps={priceData.comps} />
        <SourceFooter priceData={priceData} />
      </PriceCard>
    );
  }

  // ---- thin: a REAL sparse area returned too few comps (distinct from dead source) ----
  if (priceData.reason === "thin") {
    return (
      <PriceCard>
        <div className="rounded-lg bg-terracotta-50 p-4">
          <p className="text-base font-medium text-terracotta-600">
            För få försäljningar för en tillförlitlig jämförelse
          </p>
          <p className="mt-1 text-sm text-warm-gray-700">
            Vi hittade bara {priceData.sampleSize}{" "}
            {priceData.sampleSize === 1 ? "försäljning" : "försäljningar"} i
            området — för litet underlag för en säker jämförelse.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ConfidenceBadge priceData={priceData} />
        </div>
        {typeof priceData.areaAvg === "number" && priceData.areaAvg > 0 && (
          <p className="text-sm text-warm-gray-700">
            Områdets snitt (osäkert): {krPerKvm(priceData.areaAvg)}.
          </p>
        )}
        <CompReceipt comps={priceData.comps} />
        <SourceFooter priceData={priceData} />
      </PriceCard>
    );
  }

  // ---- ok: the normal comparison (D-04 headline + D-05 supporting detail) ----
  const hasListingFigure =
    typeof listingPrisPerKvm === "number" && listingPrisPerKvm > 0;
  const delta = priceData.deltaPct;
  const isBelow = typeof delta === "number" && delta < 0;
  // Sage when below the area average (a cheaper buy), terracotta when above.
  const headlineColor = isBelow
    ? "bg-sage-600 text-white"
    : "bg-terracotta-500 text-white";
  const deltaAbs =
    typeof delta === "number" ? Math.abs(Math.round(delta)) : null;
  const direction = isBelow ? "under" : "över";

  return (
    <PriceCard>
      {/* D-04: colour-coded ±% headline, framed as a statistical comparison. */}
      <div className={cn("rounded-xl p-5 shadow-sm", headlineColor)}>
        {hasListingFigure && typeof priceData.areaAvg === "number" ? (
          <>
            <p className="text-sm/relaxed opacity-90">Denna bostad</p>
            <p className="mt-1 text-3xl font-bold">
              {krPerKvm(listingPrisPerKvm)}
            </p>
            {deltaAbs !== null && (
              <p className="mt-2 text-lg font-medium">
                {deltaAbs} % {direction} områdets snitt (
                {krPerKvm(priceData.areaAvg)})
              </p>
            )}
            <p className="mt-2 text-xs/relaxed opacity-90">
              Statistisk jämförelse mot sålda bostäder — inte en värdering.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm/relaxed opacity-90">Områdets snitt</p>
            <p className="mt-1 text-3xl font-bold">
              {typeof priceData.areaAvg === "number"
                ? krPerKvm(priceData.areaAvg)
                : "—"}
            </p>
          </>
        )}
      </div>

      {/* D-05: sample size + tier, distribution range, 24-mo trend. */}
      <div className="space-y-2">
        <p className="text-sm text-warm-gray-700">
          Baserat på {priceData.sampleSize}{" "}
          {priceData.sampleSize === 1 ? "försäljning" : "försäljningar"}
          {priceData.tier ? ` i ${TIER_LABEL[priceData.tier]}` : ""}.
        </p>
        {typeof priceData.min === "number" &&
          typeof priceData.max === "number" && (
            <p className="text-sm text-warm-gray-700">
              Spridning: {krPerKvm(priceData.min)} – {krPerKvm(priceData.max)}.
            </p>
          )}
        {(() => {
          // WR-06: classify the slope through the shared dead-band so a
          // negligible slope reads "→ stabil" instead of a confident ↑/↓.
          const dir = classifyTrend(priceData.trendSlope);
          if (!dir) return null;
          const label =
            dir === "stigande"
              ? "↑ stigande"
              : dir === "fallande"
                ? "↓ fallande"
                : "→ stabil";
          return (
            <p className="text-sm text-warm-gray-700">
              Pristrend (24 mån): {label}
            </p>
          );
        })()}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ConfidenceBadge priceData={priceData} />
      </div>

      {/* D-05/D-09: the comparable-sales "receipt". */}
      <CompReceipt comps={priceData.comps} />

      <SourceFooter priceData={priceData} />
    </PriceCard>
  );
}
