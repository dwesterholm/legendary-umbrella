"use client";

import { Fragment } from "react";
import { Compass } from "lucide-react";
import { computeSunExposure, type Facade } from "@/lib/discovery/sun-path";

interface SunPathExposureProps {
  /** null when unknown — never guessed from an address (locked constraint). */
  latitude: number | null;
  longitude: number | null;
  floor: number | null;
  /** Derived (never raw-description) orientation, per candidate.ts's
   *  `extractOrientationFromDescription` result shape. */
  orientation: { facades: Facade[]; confidence: number } | null;
}

const FACADE_LABELS: Record<Facade, string> = {
  north: "Norr",
  east: "Öster",
  south: "Söder",
  west: "Väster",
};

const SEASON_LABELS: Record<"winter" | "springAutumn" | "summer", string> = {
  winter: "Vinter",
  springAutumn: "Vår-Höst",
  summer: "Sommar",
};

const SEASON_ORDER: Array<"winter" | "springAutumn" | "summer"> = [
  "winter",
  "springAutumn",
  "summer",
];

/**
 * `SunPathExposure` — the "computed, not interpreted" sub-block (DISC-06),
 * embedded inside `GalleryConditionVision`'s `CardContent` by Plan 04's
 * Task 2 (per 12-UI-SPEC.md Component Inventory §2).
 *
 * Deliberately DOES NOT reuse the vision-claim identity: no `Eye` icon, no
 * terracotta surface, no "Bild {n}" citation, no thumbnail. This content is
 * exact `suncalc` trigonometry (`computeSunExposure`, `src/lib/discovery/
 * sun-path.ts`) — zero LLM involvement, zero interpretation — so it gets its
 * own `Compass`/warm-gray-500-on-warm-gray-100 marker, one shade toward the
 * deterministic `ReportFlags` neutral rather than the vision-claim white.
 *
 * Renders ONLY the inner sub-block markup (the `pt-4 border-t` divider +
 * sub-header + grid/degraded-line) — no outer `Card`. The caller
 * (`GalleryConditionVision`) supplies the surrounding `CardContent`.
 *
 * Degrades to the exact locked "ej tillgänglig" line whenever
 * `computeSunExposure` returns `byFacadeAndSeason: null` (i.e. ANY of
 * latitude/longitude/floor/orientation is missing) — NEVER a fabricated
 * number, NEVER a guessed orientation (CONTEXT.md "degrade, never guess").
 * Renders ONLY the known facade(s) in the grid — never fabricates the other
 * facades as additional "ej tillgänglig" rows.
 */
export function SunPathExposure({
  latitude,
  longitude,
  floor,
  orientation,
}: SunPathExposureProps) {
  const result = computeSunExposure(
    latitude,
    longitude,
    floor,
    orientation?.facades ?? null,
  );
  const grid = result.byFacadeAndSeason;
  const knownFacades = orientation?.facades ?? [];

  return (
    <div className="space-y-2 pt-4 border-t border-warm-gray-100">
      <div className="flex items-center gap-2">
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-warm-gray-100">
          <Compass className="h-3.5 w-3.5 text-warm-gray-500" />
        </div>
        <p className="text-base font-semibold text-warm-gray-900">Solexponering</p>
      </div>
      <p className="text-sm italic text-warm-gray-500">
        Teoretisk solexponering, tar inte hänsyn till skuggning från omgivande
        byggnader.
      </p>

      {grid === null ? (
        <p className="text-sm italic text-warm-gray-500">
          Solexponering: ej tillgänglig — riktning eller våningsdata saknas för
          denna annons.
        </p>
      ) : (
        <div
          className="grid gap-1"
          style={{
            gridTemplateColumns: `repeat(${SEASON_ORDER.length + 1}, minmax(0, 1fr))`,
          }}
        >
          <div />
          {SEASON_ORDER.map((season) => (
            <div
              key={season}
              className="rounded-md bg-warm-gray-50 border border-warm-gray-100 p-2 text-center text-xs font-medium uppercase tracking-wider text-warm-gray-500"
            >
              {SEASON_LABELS[season]}
            </div>
          ))}
          {knownFacades.map((facade) => (
            <Fragment key={facade}>
              <div className="rounded-md bg-warm-gray-50 border border-warm-gray-100 p-2 text-center text-xs font-medium uppercase tracking-wider text-warm-gray-500">
                {FACADE_LABELS[facade]}
              </div>
              {SEASON_ORDER.map((season) => (
                <div
                  key={`${facade}-${season}`}
                  className="rounded-md bg-warm-gray-50 border border-warm-gray-100 p-2 text-center text-sm text-warm-gray-700"
                >
                  {/* WR-02 (12-REVIEW.md): `grid` is now a `Partial` scoped
                      to exactly `orientation.facades` — `knownFacades` IS
                      `orientation.facades`, so `grid[facade]` is always
                      defined here in practice; the `?.` + fallback is a
                      type-level safety net only, never expected to render. */}
                  {grid[facade]?.[season] ?? "—"}
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
