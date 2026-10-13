/**
 * sun-fact.ts - the SunFact record (Phase 14.3, SUN-01): everything the spike
 * knows about one flat's sun, with where each piece came from. Plan 01 fills
 * the footprint half; the floor-plan source, the hours engine and the taste
 * rule (plans 04-08) fill the rest of the same record, so the contract is
 * complete here and later plans add values, never fields.
 *
 * The record rides on the snapshot row beside `facts`, never inside the
 * candidate (R-08): `fitRowSchema.sun` reads null when absent or when the
 * stored value does not match this schema, so an old or foreign record never
 * breaks a replay.
 *
 * PURE, synchronous - no file or environment access, no network, no clock, no
 * randomness. Unknown is "okänd" with a reason (or the dash for "this run did
 * not look"), never zero (D-02).
 *
 * STRUCTURAL SEPARATION (LOCKED): `niche-score.ts` and `report/flags.ts` must
 * NEVER import this module. The static-grep invariant in `niche-score.test.ts`
 * enforces that; the `discovery/sun-` prefix is registered there.
 */

import { z } from "zod/v4";
import { wallsNear, type OsmIndex } from "@/lib/discovery/osm-buildings";
import { angularDistance, bearingToFacade, inferStreetFacade, type FootprintOk, type FootprintResult } from "@/lib/discovery/sun-facade";
import { SUN_HOURS_PARAMS, flatHeightM, sideHours } from "@/lib/discovery/sun-hours";
import type { Facade } from "@/lib/discovery/sun-path";

/** D-01 labels, as printed in the Sol cell. */
export const SUN_SOURCES = ["angiven", "planritning", "fastighet/gata", "okänd"] as const;
export type SunSource = (typeof SUN_SOURCES)[number];

/** The letter a facade prints as (Swedish compass: Ö for east, V for west). */
export const FACADE_LETTER: Readonly<Record<Facade, string>> = { north: "N", east: "Ö", south: "S", west: "V" };

const facadeSchema = z.enum(["north", "east", "south", "west"]);

/** Least sun (neighbours +3 m), the nominal case and most sun (neighbours -3 m), in hours. */
const hoursRangeSchema = z.object({ low: z.number(), nominal: z.number(), high: z.number() });

const dateHoursSchema = z.object({
  theoreticalWindow: z.number(),
  theoreticalDay: z.number(),
  obstructedWindow: hoursRangeSchema.nullable(),
  obstructedDay: hoursRangeSchema.nullable(),
  floorBelowWindow: z.number().nullable(),
});

const sideHoursSchema = z.object({
  /** The flat's height above ground in metres, null when the floor is unknown. */
  z: z.number().nullable(),
  heightsEstimated: z.boolean(),
  mar: dateHoursSchema,
  jun: dateHoursSchema,
  sep: dateHoursSchema,
  dec: dateHoursSchema,
});

const sunSideSchema = z.object({
  side: z.enum(["angiven", "planritning", "gata", "gård"]),
  facade: facadeSchema,
  bearingDeg: z.number().nullable(),
  /** The share of the flat that looks this way, in [0, 1]. */
  share: z.number().min(0).max(1),
  point: z.object({ lat: z.number(), lng: z.number() }).nullable(),
  hours: sideHoursSchema.nullable(),
});

const footprintSchema = z.object({
  /** "way/<id>" or "relation/<id>". */
  osmId: z.string(),
  inside: z.boolean(),
  snapM: z.number(),
  streetBearingDeg: z.number(),
  streetFacade: facadeSchema,
  courtyardBearingDeg: z.number(),
  courtyardFacade: facadeSchema,
  confidence: z.number(),
  frontageM: z.number(),
  streetDistM: z.number(),
  ambiguous: z.boolean(),
  floorAboveLevels: z.boolean(),
});

export const sunFactSchema = z
  .object({
    source: z.enum(SUN_SOURCES),
    confidence: z.number().min(0).max(1),
    /** Set exactly when the source is "okänd". */
    unknownReason: z.string().nullable(),
    /** Two sources disagree by more than 90 degrees (D-05). */
    conflict: z.boolean(),
    conflictWith: z.object({ source: z.enum(["angiven", "planritning", "fastighet/gata"]), facade: facadeSchema }).nullable(),
    sides: z.array(sunSideSchema).max(4),
    footprint: footprintSchema.nullable(),
  })
  .refine((f) => (f.source === "okänd") === (f.unknownReason !== null), {
    message: "unknownReason is set exactly when source is okänd",
    path: ["unknownReason"],
  });

export type SunFact = z.infer<typeof sunFactSchema>;
export type SunSide = SunFact["sides"][number];
export type SideHours = z.infer<typeof sideHoursSchema>;
export type DateHours = z.infer<typeof dateHoursSchema>;
export type HoursRange = z.infer<typeof hoursRangeSchema>;

/** A flat the spike looked at and could not place: never scores, prints "okänd". */
export function unknownSunFact(reason: string): SunFact {
  return { source: "okänd", confidence: 0, unknownReason: reason, conflict: false, conflictWith: null, sides: [], footprint: null };
}

/** The footprint diagnostics kept on every fact whose footprint is known, whatever source won. */
function footprintDiagnostics(result: FootprintOk): NonNullable<SunFact["footprint"]> {
  return {
    osmId: result.osmId,
    inside: result.inside,
    snapM: result.snapM,
    streetBearingDeg: result.streetBearingDeg,
    streetFacade: result.streetFacade,
    courtyardBearingDeg: result.courtyardBearingDeg,
    courtyardFacade: result.courtyardFacade,
    confidence: result.confidence,
    frontageM: result.frontageM,
    streetDistM: result.streetDistM,
    ambiguous: result.ambiguous,
    floorAboveLevels: result.floorAboveLevels,
  };
}

/**
 * The footprint route as a SunFact: source "fastighet/gata", a street side and
 * a courtyard side with half the flat each (the footprint does not say which
 * side the windows face; RESEARCH Pattern 4). Hours stay null until plan 04.
 */
export function sunFactFromFootprint(result: FootprintResult): SunFact {
  if (result.status === "unknown") return unknownSunFact(result.reason);
  return {
    source: "fastighet/gata",
    confidence: result.confidence,
    unknownReason: null,
    conflict: false,
    conflictWith: null,
    sides: [
      { side: "gata", facade: result.streetFacade, bearingDeg: result.streetBearingDeg, share: 0.5, point: result.streetPoint, hours: null },
      { side: "gård", facade: result.courtyardFacade, bearingDeg: result.courtyardBearingDeg, share: 0.5, point: result.courtyardPoint, hours: null },
    ],
    footprint: footprintDiagnostics(result),
  };
}

// ---------------------------------------------------------------------------
// Precedence (SUN-02, D-05)
// ---------------------------------------------------------------------------

/**
 * Every number of the precedence rule, in one place. The functions own no
 * constants.
 */
export const SUN_PRECEDENCE_PARAMS = {
  /**
   * R-03: a stated facade is the broker's own word and counts in full. This is
   * NOT the 0,5 that `extractOrientationFromDescription` returns for
   * `computeSunExposure`; that number is a different thing and stays as it is.
   */
  statedConfidence: 1,
  /** D-05: two sources further apart than this many degrees (strictly) are a konflikt. */
  conflictDeg: 90,
  /** D-05: a konflikt multiplies the winner's confidence by this. */
  conflictFactor: 0.5,
  /**
   * A stated or plan facade takes the footprint's street or courtyard bearing
   * (and window point) when that bearing lies within this many degrees
   * (inclusive) of it. Otherwise only the theoretical hours are known.
   */
  matchFootprintDeg: 45,
  /** The bearing a stated facade starts at: the centre of its 90-degree sector. */
  sectorCentre: { north: 0, east: 90, south: 180, west: 270 },
} as const satisfies { statedConfidence: number; conflictDeg: number; conflictFactor: number; matchFootprintDeg: number; sectorCentre: Record<Facade, number> };

/** A compass bearing read off a floor plan; the same shape plan 03's `planBearingOf` returns. */
export type PlanBearing = { bearingDeg: number; confidence: number };

const FACADE_ORDER: readonly Facade[] = ["north", "east", "south", "west"];

/** The facades in the fixed order north, east, south, west, each once. */
function inFixedOrder(facades: readonly Facade[]): Facade[] {
  return FACADE_ORDER.filter((f) => facades.includes(f));
}

/**
 * The facades the broker's text names: the union of the candidate's
 * `orientation.facades` and the facts record's `orientationFacades`, once each,
 * in the fixed order north, east, south, west. Null when neither names one.
 * Plain inputs, so this module does not import fit-score.ts (no import cycle).
 */
export function statedFacadesOf(
  candidateOrientation: { facades: readonly Facade[] } | null,
  factsFacades: readonly Facade[] | null,
): Facade[] | null {
  const merged = inFixedOrder([...(candidateOrientation?.facades ?? []), ...(factsFacades ?? [])]);
  return merged.length > 0 ? merged : null;
}

const roundTo = (n: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(n * f) / f || 0; // `|| 0` turns -0 into 0
};

/** A bearing at its stored precision (1 decimal) inside [0, 360). */
const roundBearing = (deg: number): number => {
  const r = roundTo(((deg % 360) + 360) % 360, 1);
  return r >= 360 ? 0 : r;
};

/** The angle between two bearings at stored precision, so 90,0 never flips on float noise. */
const distanceDeg = (a: number, b: number): number => roundTo(angularDistance(a, b), 1);

/** The footprint side closer to a bearing; the street wins a tie. */
function nearerFootprintSide(
  footprint: FootprintOk,
  bearing: number,
): { side: "gata" | "gård"; bearingDeg: number; facade: Facade; point: { lat: number; lng: number } | null; distanceDeg: number } {
  const street = {
    side: "gata" as const,
    bearingDeg: footprint.streetBearingDeg,
    facade: footprint.streetFacade,
    point: footprint.streetPoint,
    distanceDeg: distanceDeg(bearing, footprint.streetBearingDeg),
  };
  const courtyard = {
    side: "gård" as const,
    bearingDeg: footprint.courtyardBearingDeg,
    facade: footprint.courtyardFacade,
    point: footprint.courtyardPoint,
    distanceDeg: distanceDeg(bearing, footprint.courtyardBearingDeg),
  };
  return courtyard.distanceDeg < street.distanceDeg ? courtyard : street;
}

/**
 * Where a stated or plan facade sits: the footprint's nearer side when it lies
 * within `matchFootprintDeg` of `bearing`, else `bearing` itself with no point.
 */
function snapToFootprint(
  footprint: FootprintOk | null,
  bearing: number,
): { bearingDeg: number; point: { lat: number; lng: number } | null } {
  if (footprint === null) return { bearingDeg: bearing, point: null };
  const near = nearerFootprintSide(footprint, bearing);
  if (near.distanceDeg > SUN_PRECEDENCE_PARAMS.matchFootprintDeg) return { bearingDeg: bearing, point: null };
  return { bearingDeg: roundBearing(near.bearingDeg), point: near.point };
}

/** The winner's sides, its source and its confidence before any konflikt. */
function winnerOf(
  stated: readonly Facade[],
  plan: PlanBearing | null,
  footprint: FootprintOk | null,
): SunFact | null {
  if (stated.length > 0) {
    return {
      source: "angiven",
      confidence: SUN_PRECEDENCE_PARAMS.statedConfidence,
      unknownReason: null,
      conflict: false,
      conflictWith: null,
      sides: stated.map((facade) => {
        const { bearingDeg, point } = snapToFootprint(footprint, SUN_PRECEDENCE_PARAMS.sectorCentre[facade]);
        return { side: "angiven" as const, facade, bearingDeg, share: 1 / stated.length, point, hours: null };
      }),
      footprint: null,
    };
  }
  if (plan !== null) {
    const bearing = roundBearing(plan.bearingDeg);
    return {
      source: "planritning",
      confidence: roundTo(Math.min(1, Math.max(0, plan.confidence)), 2),
      unknownReason: null,
      conflict: false,
      conflictWith: null,
      sides: [
        {
          side: "planritning",
          facade: bearingToFacade(bearing),
          bearingDeg: bearing,
          share: 1,
          point: snapToFootprint(footprint, bearing).point,
          hours: null,
        },
      ],
      footprint: null,
    };
  }
  return null;
}

/**
 * Decide which source of a flat's facing direction wins and say so when two
 * sources disagree (D-05):
 *
 * 1. stated text ("angiven") beats a floor-plan compass ("planritning"), which
 *    beats the building footprint ("fastighet/gata"). The plan bearing only
 *    exists when the caller passes one; plan 07 does so only while
 *    FLOORPLAN_ROUTE_ENABLED is true.
 * 2. Nothing known: "okänd", confidence 0, the footprint's own reason (D-02).
 * 3. The winner's first side bearing is compared with every lower source that
 *    is present (the footprint counts with the nearer of its street and
 *    courtyard bearing). A distance strictly above 90,0 degrees marks
 *    konflikt, names the first such source in precedence order with its
 *    facade, and halves the confidence. Both stay visible.
 * 4. The footprint diagnostics ride on every fact whose footprint is known.
 *
 * PURE: same input, same output; inputs are not mutated.
 */
export function resolveSunFact(input: {
  stated: readonly Facade[] | null;
  plan: PlanBearing | null;
  footprint: FootprintResult;
}): SunFact {
  const footprint = input.footprint.status === "ok" ? input.footprint : null;
  const plan = input.plan !== null && Number.isFinite(input.plan.bearingDeg) && Number.isFinite(input.plan.confidence) ? input.plan : null;
  const stated = inFixedOrder(input.stated ?? []);

  let fact = winnerOf(stated, plan, footprint);
  if (fact === null) return sunFactFromFootprint(input.footprint);

  // Lower sources than the winner, in precedence order.
  const lower: { source: "planritning" | "fastighet/gata"; bearingDeg: number; facade: Facade }[] = [];
  if (fact.source === "angiven" && plan !== null) {
    const bearing = roundBearing(plan.bearingDeg);
    lower.push({ source: "planritning", bearingDeg: bearing, facade: bearingToFacade(bearing) });
  }
  const winnerBearing = fact.sides[0]?.bearingDeg ?? null;
  if (fact.source !== "fastighet/gata" && footprint !== null && winnerBearing !== null) {
    const near = nearerFootprintSide(footprint, winnerBearing);
    lower.push({ source: "fastighet/gata", bearingDeg: near.bearingDeg, facade: near.facade });
  }

  const disagreeing = winnerBearing === null ? undefined : lower.find((l) => distanceDeg(winnerBearing, l.bearingDeg) > SUN_PRECEDENCE_PARAMS.conflictDeg);
  if (disagreeing !== undefined) {
    fact = {
      ...fact,
      conflict: true,
      conflictWith: { source: disagreeing.source, facade: disagreeing.facade },
      confidence: roundTo(fact.confidence * SUN_PRECEDENCE_PARAMS.conflictFactor, 2),
    };
  }

  return footprint === null ? fact : { ...fact, footprint: footprintDiagnostics(footprint) };
}

// ---------------------------------------------------------------------------
// The whole stage for one flat (SUN-01, SUN-03)
// ---------------------------------------------------------------------------

/** What the sun stage needs to know about one flat; plain values, so this module does not import fit-score.ts. */
export interface SunFactInput {
  readonly lat: number | null;
  readonly lng: number | null;
  readonly address: string | null;
  /** The Booli floor, null when unknown. */
  readonly floor: number | null;
  /** The candidate's stated orientation (`candidate.orientation`), if any. */
  readonly candidateOrientation: { readonly facades: readonly Facade[] } | null;
  /** The facts record's stated facades (`facts.orientationFacades`), if any. */
  readonly factsFacades: readonly Facade[] | null;
}

/**
 * One flat's whole sun fact from the cached map: the footprint (plan 01), the
 * stated facades (plan 05), the precedence between them (plan 05), then the
 * hours of every side that has a bearing (plan 04).
 *
 * A side with a window point and a known floor gets the walls within
 * {@link SUN_HOURS_PARAMS.radiusM} around that point and the flat's height, so
 * its hours come as a range with the neighbours in the way. A side without a
 * point (a stated facade that matches neither footprint side) or a flat without
 * a floor gets the theoretical hours only (no obstructed range). A flat that
 * could not be placed (okänd) gets no hours. `opts.plan` is a floor-plan
 * bearing, passed only while the floor-plan route is enabled.
 *
 * PURE: same input, same output; the index and the input are not changed.
 */
export function computeSunFact(index: OsmIndex, input: SunFactInput, opts: { plan: PlanBearing | null }): SunFact {
  const footprint = inferStreetFacade(index, { lat: input.lat, lng: input.lng, address: input.address, floor: input.floor });
  const fact = resolveSunFact({
    stated: statedFacadesOf(input.candidateOrientation, input.factsFacades),
    plan: opts.plan,
    footprint,
  });
  if (fact.source === "okänd") return fact;

  const z = flatHeightM(input.floor);
  const booli = input.lat !== null && input.lng !== null && Number.isFinite(input.lat) && Number.isFinite(input.lng) ? { lat: input.lat, lng: input.lng } : null;
  const sides = fact.sides.map((side): SunSide => {
    if (side.bearingDeg === null) return side;
    const origin = side.point ?? booli;
    if (origin === null) return side;
    const located = side.point !== null && z !== null;
    const walls = located ? wallsNear(index, origin.lat, origin.lng, SUN_HOURS_PARAMS.radiusM) : [];
    return { ...side, hours: sideHours({ lat: origin.lat, lng: origin.lng, bearingDeg: side.bearingDeg, z: located ? z : null, walls }) };
  });
  return { ...fact, sides };
}

/** Two decimals with a decimal comma: 0.9 prints "0,90". */
const commaDecimals = (n: number): string => n.toFixed(2).replace(".", ",");

/**
 * The "Sol" table cell (D-02, D-08). Null (this run did not look) prints "-";
 * a flat that could not be placed prints "okänd". Otherwise the sides, then
 * the source and confidence: "S gata/N gård (fastighet/gata, 0,95)". A corner
 * flat gets " hörn"; a disagreement between sources gets " konflikt: <source>
 * <letter>".
 */
export function formatSolCell(fact: SunFact | null): string {
  if (fact === null) return "-";
  if (fact.source === "okänd") return "okänd";
  const sides = fact.sides
    .map((s) => (s.side === "gata" || s.side === "gård" ? `${FACADE_LETTER[s.facade]} ${s.side}` : FACADE_LETTER[s.facade]))
    .join("/");
  let cell = `${sides} (${fact.source}, ${commaDecimals(fact.confidence)})`;
  if (fact.source === "fastighet/gata" && fact.footprint?.ambiguous === true) cell += " hörn";
  if (fact.conflict && fact.conflictWith !== null) {
    cell += ` konflikt: ${fact.conflictWith.source} ${FACADE_LETTER[fact.conflictWith.facade]}`;
  }
  return cell;
}
