/**
 * taste.ts - Daniel's personal taste bonus for the fit score (Phase 14.1, D-06):
 * a small percentage of the resale value for a sunny flat (up to 3 %) and for a
 * flat close to a street he likes (up to 2 %). It orders flats whose money
 * case is close; it is never large enough to rescue a bad deal (the 5 % cap,
 * TASTE_CAP_PCT, is applied in fit-score.ts, not here).
 *
 * PURE, synchronous - no clock, randomness, network, async, file or
 * environment access. Same input, same output.
 *
 * STRUCTURAL SEPARATION (LOCKED): like `reno-tier.ts` this module sits beside
 * the vision/analysis path. `niche-score.ts` and `report/flags.ts` must NEVER
 * import it; the static-grep invariant in `niche-score.test.ts` enforces that
 * and this module's specifier is registered there.
 *
 * LOVED_HUBS vs CENTRALITY_HUBS: the loved hubs are TASTE ONLY (D-06/D-09). The
 * hedonic model's distance feature uses `CENTRALITY_HUBS` in hedonic-model.ts
 * and never reads this list, so a personal preference cannot leak into the
 * market price estimate.
 *
 * ASSUMPTIONS (CONTEXT "Claude's Discretion"): the hub coordinates below are
 * approximate points typed from map knowledge, not surveyed. They are labelled
 * so and sanity-checked in `taste.test.ts` against Booli's own coordinates for
 * Folkungagatan 61 (Booli 150148), which sits about 150 m from the SoFo hub and
 * about 200 m from Medborgarplatsen. The decay shape (full within 300 m, linear
 * to zero at 800 m) is also a judgement call, not a measured preference.
 *
 * Every number lives in {@link TASTE_WEIGHTS}; the functions own no constants
 * (same discipline as NICHE_WEIGHTS in niches.ts).
 */

import { haversineMeters } from "@/lib/discovery/hedonic-model";
import type { Facade, SunPhrases } from "@/lib/discovery/sun-path";

/** Streets and squares Daniel wants to live near. Approximate coordinates (see module doc). */
export const LOVED_HUBS: ReadonlyArray<{ name: string; lat: number; lng: number }> = [
  { name: "SoFo/Folkungagatan", lat: 59.314, lng: 18.079 },
  { name: "Medborgarplatsen", lat: 59.3143, lng: 18.0735 },
  { name: "Mariatorget", lat: 59.3167, lng: 18.063 },
  { name: "Slussen", lat: 59.32, lng: 18.0718 },
  { name: "Katarina Bangata", lat: 59.3118, lng: 18.083 },
  { name: "Fridhemsplan", lat: 59.3335, lng: 18.029 },
  { name: "St Eriksgatan/Hantverkargatan", lat: 59.331, lng: 18.04 },
];

/** The one table of taste numbers. Percentages are fractions of the resale value. */
export const TASTE_WEIGHTS: {
  readonly sunMaxPct: 0.03;
  readonly hubMaxPct: 0.02;
  readonly facade: Readonly<Record<Facade, number>>;
  readonly phraseAdd: 0.3;
  readonly hubFullM: 300;
  readonly hubZeroM: 800;
} = {
  sunMaxPct: 0.03,
  hubMaxPct: 0.02,
  // East morning sun is the strongest taste signal, south next; west and north earn nothing.
  facade: { east: 1.0, south: 0.7, west: 0, north: 0 },
  // "sol hela dagen" / "genomgående": stated by the broker, credited once.
  phraseAdd: 0.3,
  hubFullM: 300,
  hubZeroM: 800,
};

/** The closest loved hub and the distance to it, or null when the flat has no coordinates. */
export function nearestLovedHub(
  lat: number | null,
  lng: number | null,
): { name: string; meters: number } | null {
  if (lat === null || lng === null) return null;
  let best: { name: string; meters: number } | null = null;
  for (const hub of LOVED_HUBS) {
    const meters = haversineMeters(lat, lng, hub.lat, hub.lng);
    if (best === null || meters < best.meters) best = { name: hub.name, meters };
  }
  return best;
}

/**
 * Hub part of the bonus as a fraction of resale: the full {@link TASTE_WEIGHTS.hubMaxPct}
 * up to `hubFullM`, falling in a straight line to 0 at `hubZeroM`. Unknown distance is 0.
 */
export function hubProximityPct(meters: number | null): number {
  if (meters === null) return 0;
  const { hubMaxPct, hubFullM, hubZeroM } = TASTE_WEIGHTS;
  if (meters <= hubFullM) return hubMaxPct;
  if (meters >= hubZeroM) return 0;
  return (hubMaxPct * (hubZeroM - meters)) / (hubZeroM - hubFullM);
}

/**
 * Sun score in [0, 1]: the best facade's weight (not the sum), plus
 * `phraseAdd` once if the broker stated all-day sun or a through-flat layout,
 * capped at 1. Unknown orientation and phrases score 0: no information is
 * never a penalty.
 */
export function sunScore(
  orientation: { facades: Facade[] } | null,
  phrases: SunPhrases | null,
): number {
  let best = 0;
  for (const facade of orientation?.facades ?? []) {
    best = Math.max(best, TASTE_WEIGHTS.facade[facade]);
  }
  const stated = phrases !== null && (phrases.allDaySun || phrases.throughFlat);
  return Math.min(1, best + (stated ? TASTE_WEIGHTS.phraseAdd : 0));
}

export interface TasteResult {
  /** Sun part, fraction of resale (0 to 0.03). */
  sunPct: number;
  /** Hub part, fraction of resale (0 to 0.02). */
  hubPct: number;
  /** sunPct + hubPct. Not capped here; fit-score.ts applies TASTE_CAP_PCT. */
  pct: number;
  nearestHub: string | null;
  hubMeters: number | null;
}

/** The taste bonus for one flat. */
export function tasteBonus(input: {
  latitude: number | null;
  longitude: number | null;
  orientation: { facades: Facade[] } | null;
  sunPhrases: SunPhrases | null;
}): TasteResult {
  const hub = nearestLovedHub(input.latitude, input.longitude);
  const sunPct = TASTE_WEIGHTS.sunMaxPct * sunScore(input.orientation, input.sunPhrases);
  const hubPct = hubProximityPct(hub ? hub.meters : null);
  return {
    sunPct,
    hubPct,
    pct: sunPct + hubPct,
    nearestHub: hub ? hub.name : null,
    hubMeters: hub ? hub.meters : null,
  };
}
