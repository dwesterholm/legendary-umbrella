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
import type { FootprintResult } from "@/lib/discovery/sun-facade";
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
    footprint: {
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
    },
  };
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
