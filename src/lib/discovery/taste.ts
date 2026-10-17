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
 * INFERRED SUN (Phase 14.3, D-07, R-03, SUN-04): fit-score.ts may pass an
 * `inferredSun` input (the resolved sun fact reduced to plain numbers). The sun
 * part is then, per side, the facade weight times that side's obstruction
 * factor (the March morning-and-midday sun the neighbours leave), best side
 * wins, times the source factor times the confidence, plus the stated-phrase
 * credit, capped at 1. The source factor is `streetOnlyFactor` (0.5) when only
 * the footprint is known (we do not know whether the living room or the
 * balcony faces the street or the yard) and 1 for stated text and a floor
 * plan. A stated fact with confidence 1 and no shade keeps today's numbers.
 * The sun part stays at most `sunMaxPct` (3 % of resale) and the total taste
 * cap is untouched. With no `inferredSun` (or source "okänd") the output is
 * exactly what it was before. The input is already rounded where it is stored
 * (confidence 2 decimals, hours 1 decimal); this module does no rounding.
 *
 * LAYOUT TERMS (Phase 14.4, D-10, LAY-03): two small terms of Daniel's own
 * preference, each 1 % of the resale value: windows on two opposite sides
 * (korsdrag, so the flat does not boil in summer) and a bedroom on the quiet
 * courtyard side (so he can sleep with the window open). Unknown adds nothing,
 * and "no korsdrag" or "street bedroom" subtracts nothing (taste never
 * subtracts). The market value of either is NOT modelled: sold flats carry no
 * layout data, so these enter only as taste, inside the unchanged 5 % cap that
 * fit-score.ts applies to the sum.
 *
 * CEILING HEIGHT (Phase 14.5, D-07, CEIL-02): a stated ceiling height of 3,0 m or more adds 1 % of the
 * resale value and 3,5 m or more adds 2 % (the higher step replaces the lower, it does not stack). Daniel
 * values rooms of 3 to 4 metres; buyers pay for them too, but sold flats carry no text (R-03), so the market
 * value cannot be modelled and the height enters only as taste. An unknown height, and a "högt i tak" flag
 * without a number, add nothing (taste never subtracts). The highest possible uncapped sum is now 9 %
 * (sun 3 + hub 2 + korsdrag 1 + quiet bedroom 1 + ceiling 2) against the unchanged 5 % cap, so the cap line
 * the run prints matters more.
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
  /**
   * R-03 / research assumption A4, to be confirmed by Daniel: when only the
   * footprint is known, the best side counts half (the rooms may face the other
   * side). Stated text and a floor plan use 1.
   */
  readonly streetOnlyFactor: 0.5;
  /** D-10: windows on two opposite sides (korsdrag), Daniel's own preference, 1 % of resale; not modelled market value. */
  readonly korsdragPct: 0.01;
  /** D-10: a bedroom on the quiet courtyard side, Daniel's own preference, 1 % of resale; not modelled market value. */
  readonly quietBedroomPct: 0.01;
  /** D-07: stated ceiling height of at least ceilingMidM, Daniel's own preference, not modelled market value (sold pages carry no text, R-03); 1 % of resale. */
  readonly ceilingMidPct: 0.01;
  /** D-07: stated ceiling height of at least ceilingHighM, Daniel's own preference, not modelled market value (sold pages carry no text, R-03); 2 % of resale, replaces the mid step. */
  readonly ceilingHighPct: 0.02;
  /** D-07: the lower height threshold in metres (inclusive). */
  readonly ceilingMidM: 3.0;
  /** D-07: the higher height threshold in metres (inclusive). */
  readonly ceilingHighM: 3.5;
  readonly hubFullM: 300;
  readonly hubZeroM: 800;
} = {
  sunMaxPct: 0.03,
  hubMaxPct: 0.02,
  // East morning sun is the strongest taste signal, south next; west and north earn nothing.
  facade: { east: 1.0, south: 0.7, west: 0, north: 0 },
  // "sol hela dagen" / "genomgående": stated by the broker, credited once.
  phraseAdd: 0.3,
  streetOnlyFactor: 0.5,
  korsdragPct: 0.01,
  quietBedroomPct: 0.01,
  ceilingMidPct: 0.01,
  ceilingHighPct: 0.02,
  ceilingMidM: 3.0,
  ceilingHighM: 3.5,
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
 * Ceiling part of the bonus as a fraction of resale: {@link TASTE_WEIGHTS.ceilingHighPct} from `ceilingHighM`,
 * {@link TASTE_WEIGHTS.ceilingMidPct} from `ceilingMidM`, else 0. Unknown (null, undefined, NaN, infinite) is 0:
 * no information is never a penalty, and a "högt i tak" flag without a number never reaches this function.
 */
export function ceilingTastePct(ceilingHeightM: number | null | undefined): number {
  if (ceilingHeightM === null || ceilingHeightM === undefined || !Number.isFinite(ceilingHeightM)) return 0;
  const { ceilingMidPct, ceilingHighPct, ceilingMidM, ceilingHighM } = TASTE_WEIGHTS;
  if (ceilingHeightM >= ceilingHighM) return ceilingHighPct;
  if (ceilingHeightM >= ceilingMidM) return ceilingMidPct;
  return 0;
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

/**
 * The resolved sun fact as plain numbers (built in fit-score.ts from the stored
 * SunFact). `obstructionFactor` per side is obstructed / theoretical morning and
 * midday hours in [0, 1], 1 when unknown. The source union is a local literal
 * so this module imports nothing from the sun modules.
 */
export interface InferredSunInput {
  source: "angiven" | "planritning" | "fastighet/gata" | "okänd";
  confidence: number;
  sides: ReadonlyArray<{ facade: Facade; obstructionFactor: number }>;
}

/** A finite number clamped to [0, 1]; NaN, infinity and negatives count as 0. */
function unit(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  return Math.min(1, x);
}

/**
 * Sun score in [0, 1] from an inferred fact: the best side's facade weight x
 * obstruction factor (not the sum), x the source factor (`streetOnlyFactor` for
 * "fastighet/gata", else 1) x confidence, plus `phraseAdd` once for a stated
 * all-day-sun / through-flat phrase, capped at 1. An "okänd" source has no
 * facade and scores only the phrase credit.
 */
export function inferredSunScore(inferred: InferredSunInput, phrases: SunPhrases | null): number {
  let best = 0;
  if (inferred.source !== "okänd") {
    for (const side of inferred.sides) {
      const weight = TASTE_WEIGHTS.facade[side.facade] ?? 0;
      best = Math.max(best, weight * unit(side.obstructionFactor));
    }
  }
  const sourceFactor = inferred.source === "fastighet/gata" ? TASTE_WEIGHTS.streetOnlyFactor : 1;
  const stated = phrases !== null && (phrases.allDaySun || phrases.throughFlat);
  const score = best * sourceFactor * unit(inferred.confidence) + (stated ? TASTE_WEIGHTS.phraseAdd : 0);
  return Math.min(1, score);
}

export interface TasteResult {
  /** Sun part, fraction of resale (0 to 0.03). */
  sunPct: number;
  /** Hub part, fraction of resale (0 to 0.02). */
  hubPct: number;
  /** Korsdrag part, fraction of resale: {@link TASTE_WEIGHTS.korsdragPct} when the flat has windows on two opposite sides, else 0. */
  korsdragPct: number;
  /** Quiet-bedroom part, fraction of resale: {@link TASTE_WEIGHTS.quietBedroomPct} for a courtyard bedroom, else 0. */
  quietBedroomPct: number;
  /** Ceiling part, fraction of resale: 0.01 from 3,0 m, 0.02 from 3,5 m, 0 when unknown (see {@link ceilingTastePct}). */
  ceilingPct: number;
  /** sunPct + hubPct + korsdragPct + quietBedroomPct + ceilingPct. Not capped here; fit-score.ts applies TASTE_CAP_PCT. */
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
  /** Phase 14.3: the resolved sun fact; absent, null or source "okänd" means today's formula. */
  inferredSun?: InferredSunInput | null;
  /**
   * Phase 14.4 (D-10): the believed layout answers (see layout-fact.ts). true adds the weight, false and
   * null (unknown) add 0; absent or null means no layout.
   */
  layout?: { korsdrag: boolean | null; quietBedroom: boolean | null } | null;
  /** Phase 14.5 (D-07): the stated ceiling height in metres; absent, null or below 3,0 m adds 0. */
  ceilingHeightM?: number | null;
}): TasteResult {
  const hub = nearestLovedHub(input.latitude, input.longitude);
  const inferred = input.inferredSun ?? null;
  const score =
    inferred !== null && inferred.source !== "okänd"
      ? inferredSunScore(inferred, input.sunPhrases)
      : sunScore(input.orientation, input.sunPhrases);
  const sunPct = TASTE_WEIGHTS.sunMaxPct * score;
  const hubPct = hubProximityPct(hub ? hub.meters : null);
  // IN-07: a broker's "genomgående" (throughFlat) is already credited inside the sun score. The same fact read from the
  // plan must not be paid a second time, so the korsdrag term is skipped when the phrase is there.
  const throughFlatStated = input.sunPhrases?.throughFlat === true;
  const korsdragPct = input.layout?.korsdrag === true && !throughFlatStated ? TASTE_WEIGHTS.korsdragPct : 0;
  const quietBedroomPct = input.layout?.quietBedroom === true ? TASTE_WEIGHTS.quietBedroomPct : 0;
  const ceilingPct = ceilingTastePct(input.ceilingHeightM);
  return {
    sunPct,
    hubPct,
    korsdragPct,
    quietBedroomPct,
    ceilingPct,
    pct: sunPct + hubPct + korsdragPct + quietBedroomPct + ceilingPct,
    nearestHub: hub ? hub.name : null,
    hubMeters: hub ? hub.meters : null,
  };
}
