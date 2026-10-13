import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOsmIndex, parseOsmExtract } from "@/lib/discovery/osm-buildings";
import type { FootprintOk, FootprintResult } from "@/lib/discovery/sun-facade";
import {
  SUN_PRECEDENCE_PARAMS,
  SUN_FAILURE_REASON,
  SUN_SOURCES,
  computeSunFact,
  computeSunFactSafe,
  formatSolCell,
  formatSolHours,
  renderSunReport,
  resolveSunFact,
  statedFacadesOf,
  sunFactSchema,
  unknownSunFact,
  type DateHours,
  type SunFact,
} from "@/lib/discovery/sun-fact";
import type { Facade } from "@/lib/discovery/sun-path";

/** A resolved footprint: street side 166,2 (south), courtyard 346,2 (north), as on Folkungagatan 61. */
function footprintOk(over: Partial<FootprintOk> = {}): FootprintOk {
  return {
    status: "ok",
    osmId: "way/1372512603",
    inside: true,
    snapM: 0,
    streetBearingDeg: 166.2,
    streetFacade: "south",
    courtyardBearingDeg: 346.2,
    courtyardFacade: "north",
    confidence: 0.9,
    frontageM: 32.7,
    streetDistM: 2.1,
    ambiguous: false,
    floorAboveLevels: false,
    streetPoint: { lat: 59.3147, lng: 18.0768 },
    courtyardPoint: { lat: 59.3149, lng: 18.0769 },
    ...over,
  };
}

const NO_BUILDING: FootprintResult = { status: "unknown", reason: "ingen byggnad inom 25 m" };

/** A street 106 / courtyard 286 flat (the two stated-west flats of the research run). */
const EAST_WEST = footprintOk({
  streetBearingDeg: 106,
  streetFacade: "east",
  courtyardBearingDeg: 286,
  courtyardFacade: "west",
  streetPoint: { lat: 59.31, lng: 18.07 },
  courtyardPoint: { lat: 59.3101, lng: 18.0701 },
});

/** Every fact resolveSunFact returns must survive storage as JSON (the snapshot row). */
function roundTrips(fact: SunFact): void {
  const back = sunFactSchema.parse(JSON.parse(JSON.stringify(fact)));
  expect(back).toEqual(fact);
}

describe("SUN_PRECEDENCE_PARAMS", () => {
  it("holds the locked numbers", () => {
    expect(SUN_PRECEDENCE_PARAMS.statedConfidence).toBe(1);
    expect(SUN_PRECEDENCE_PARAMS.conflictDeg).toBe(90);
    expect(SUN_PRECEDENCE_PARAMS.conflictFactor).toBe(0.5);
    expect(SUN_PRECEDENCE_PARAMS.matchFootprintDeg).toBe(45);
    expect(SUN_PRECEDENCE_PARAMS.sectorCentre).toEqual({ north: 0, east: 90, south: 180, west: 270 });
  });
});

describe("resolveSunFact: precedence", () => {
  it("precedence: stated text beats a plan bearing and the footprint", () => {
    const fact = resolveSunFact({ stated: ["south"], plan: { bearingDeg: 0, confidence: 0.8 }, footprint: footprintOk() });
    expect(fact.source).toBe("angiven");
    expect(fact.sides).toHaveLength(1);
    expect(fact.sides[0]).toMatchObject({ side: "angiven", facade: "south", share: 1, bearingDeg: 166.2 });
    expect(fact.sides[0].point).toEqual({ lat: 59.3147, lng: 18.0768 });
    expect(fact.unknownReason).toBeNull();
    roundTrips(fact);
  });

  it("precedence: a stated south flat that agrees with a plan keeps confidence 1,00", () => {
    const fact = resolveSunFact({ stated: ["south"], plan: { bearingDeg: 170, confidence: 0.8 }, footprint: footprintOk() });
    expect(fact.source).toBe("angiven");
    expect(fact.confidence).toBe(1);
    expect(fact.conflict).toBe(false);
    expect(fact.conflictWith).toBeNull();
    roundTrips(fact);
  });

  it("precedence: the plan bearing beats the footprint, whatever its confidence", () => {
    const fact = resolveSunFact({ stated: null, plan: { bearingDeg: 200, confidence: 0.3 }, footprint: footprintOk({ streetBearingDeg: 20, streetFacade: "north", courtyardBearingDeg: 200, courtyardFacade: "south" }) });
    expect(fact.source).toBe("planritning");
    expect(fact.confidence).toBe(0.3);
    expect(fact.sides).toHaveLength(1);
    expect(fact.sides[0]).toMatchObject({ side: "planritning", facade: "south", bearingDeg: 200, share: 1 });
    roundTrips(fact);
  });

  it("precedence: a plan bearing takes the courtyard point when that side is within 45 degrees", () => {
    const fp = footprintOk({ streetBearingDeg: 20, streetFacade: "north", courtyardBearingDeg: 200, courtyardFacade: "south" });
    const fact = resolveSunFact({ stated: null, plan: { bearingDeg: 200, confidence: 0.8 }, footprint: fp });
    expect(fact.sides[0].point).toEqual(fp.courtyardPoint);
    expect(fact.conflict).toBe(false);
    expect(fact.confidence).toBe(0.8);
    roundTrips(fact);
  });

  it("precedence: a plan bearing far from both footprint sides gets no point", () => {
    // Plan 90 against street 166,2 / courtyard 346,2: 76,2 and 103,8 degrees away.
    const fact = resolveSunFact({ stated: null, plan: { bearingDeg: 90, confidence: 0.8 }, footprint: footprintOk() });
    expect(fact.sides[0].point).toBeNull();
    expect(fact.conflict).toBe(false);
    roundTrips(fact);
  });

  it("precedence: the footprint alone gives a street side and a courtyard side, half each", () => {
    const fact = resolveSunFact({ stated: null, plan: null, footprint: footprintOk() });
    expect(fact.source).toBe("fastighet/gata");
    expect(fact.sides.map((s) => s.side)).toEqual(["gata", "gård"]);
    expect(fact.sides.map((s) => s.share)).toEqual([0.5, 0.5]);
    expect(fact.confidence).toBe(0.9);
    expect(fact.conflict).toBe(false);
    expect(fact.footprint?.osmId).toBe("way/1372512603");
    roundTrips(fact);
  });

  it("precedence: stated text alone, with no footprint at all, uses the sector centre and no point", () => {
    const fact = resolveSunFact({ stated: ["east"], plan: null, footprint: NO_BUILDING });
    expect(fact.source).toBe("angiven");
    expect(fact.sides).toEqual([{ side: "angiven", facade: "east", bearingDeg: 90, share: 1, point: null, hours: null }]);
    expect(fact.footprint).toBeNull();
    expect(fact.confidence).toBe(1);
    roundTrips(fact);
  });

  it("precedence: an empty stated list counts as no stated text", () => {
    const fact = resolveSunFact({ stated: [], plan: null, footprint: footprintOk() });
    expect(fact.source).toBe("fastighet/gata");
  });

  it("precedence: a plan bearing that is not a finite number is ignored", () => {
    const fact = resolveSunFact({ stated: null, plan: { bearingDeg: Number.NaN, confidence: 0.8 }, footprint: footprintOk() });
    expect(fact.source).toBe("fastighet/gata");
  });

  it("precedence: plan confidence is clamped to [0, 1] and rounded to 2 decimals", () => {
    expect(resolveSunFact({ stated: null, plan: { bearingDeg: 10, confidence: 1.7 }, footprint: NO_BUILDING }).confidence).toBe(1);
    expect(resolveSunFact({ stated: null, plan: { bearingDeg: 10, confidence: -1 }, footprint: NO_BUILDING }).confidence).toBe(0);
    expect(resolveSunFact({ stated: null, plan: { bearingDeg: 10, confidence: 0.8449 }, footprint: NO_BUILDING }).confidence).toBe(0.84);
  });

  it("precedence: a plan bearing is stored at 1 decimal and the facade comes from the stored value", () => {
    const edge = resolveSunFact({ stated: null, plan: { bearingDeg: 44.96, confidence: 0.8 }, footprint: NO_BUILDING });
    expect(edge.sides[0]).toMatchObject({ bearingDeg: 45, facade: "east" });
    const wrap = resolveSunFact({ stated: null, plan: { bearingDeg: -10, confidence: 0.8 }, footprint: NO_BUILDING });
    expect(wrap.sides[0]).toMatchObject({ bearingDeg: 350, facade: "north" });
    const over = resolveSunFact({ stated: null, plan: { bearingDeg: 360.2, confidence: 0.8 }, footprint: NO_BUILDING });
    expect(over.sides[0]).toMatchObject({ bearingDeg: 0.2, facade: "north" });
  });
});

describe("resolveSunFact: empty", () => {
  it("empty: nothing stated, no plan bearing and an unknown footprint is okänd with the footprint's reason", () => {
    const fact = resolveSunFact({ stated: null, plan: null, footprint: NO_BUILDING });
    expect(fact.source).toBe("okänd");
    expect(fact.confidence).toBe(0);
    expect(fact.sides).toEqual([]);
    expect(fact.unknownReason).toBe("ingen byggnad inom 25 m");
    expect(fact.conflict).toBe(false);
    expect(fact.footprint).toBeNull();
    expect(formatSolCell(fact)).toBe("okänd");
    roundTrips(fact);
  });

  it("empty: every footprint reason is carried through unchanged", () => {
    for (const reason of ["koordinater saknas", "adress saknas", "utanför OSM-utdraget", "ingen gata med samma namn inom 35 m"] as const) {
      const fact = resolveSunFact({ stated: null, plan: null, footprint: { status: "unknown", reason } });
      expect(fact.unknownReason).toBe(reason);
      expect(fact.confidence).toBe(0);
    }
  });
});

describe("resolveSunFact: conflict", () => {
  it("conflict: stated north against a plan facing south is a konflikt, confidence halved, both shown", () => {
    const fact = resolveSunFact({ stated: ["north"], plan: { bearingDeg: 180, confidence: 0.8 }, footprint: NO_BUILDING });
    expect(fact.source).toBe("angiven");
    expect(fact.conflict).toBe(true);
    expect(fact.conflictWith).toEqual({ source: "planritning", facade: "south" });
    expect(fact.confidence).toBe(0.5);
    expect(formatSolCell(fact)).toBe("N (angiven, 0,50) konflikt: planritning S");
    roundTrips(fact);
  });

  it("conflict: exactly 90,0 degrees apart is not a konflikt", () => {
    const fact = resolveSunFact({ stated: ["east"], plan: { bearingDeg: 180, confidence: 0.8 }, footprint: NO_BUILDING });
    expect(fact.conflict).toBe(false);
    expect(fact.conflictWith).toBeNull();
    expect(fact.confidence).toBe(1);
  });

  it("conflict: 90,1 degrees apart is a konflikt", () => {
    const fact = resolveSunFact({ stated: ["east"], plan: { bearingDeg: 180.1, confidence: 0.8 }, footprint: NO_BUILDING });
    expect(fact.conflict).toBe(true);
    expect(fact.confidence).toBe(0.5);
  });

  it("conflict: the distance wraps round north (359,9 against north is 0,1)", () => {
    const fact = resolveSunFact({ stated: ["north"], plan: { bearingDeg: 359.9, confidence: 0.8 }, footprint: NO_BUILDING });
    expect(fact.conflict).toBe(false);
  });

  it("conflict: the distance is the smaller angle (270 against 0 is 90, not 270)", () => {
    expect(resolveSunFact({ stated: ["north"], plan: { bearingDeg: 270, confidence: 0.8 }, footprint: NO_BUILDING }).conflict).toBe(false);
    expect(resolveSunFact({ stated: ["north"], plan: { bearingDeg: 269.9, confidence: 0.8 }, footprint: NO_BUILDING }).conflict).toBe(true);
  });

  it("conflict: a plan winner halves its own confidence (0,8 becomes 0,4)", () => {
    const fp = footprintOk({ streetBearingDeg: 170, streetFacade: "south", courtyardBearingDeg: 190, courtyardFacade: "south" });
    const fact = resolveSunFact({ stated: null, plan: { bearingDeg: 0, confidence: 0.8 }, footprint: fp });
    expect(fact.source).toBe("planritning");
    expect(fact.conflict).toBe(true);
    expect(fact.conflictWith).toEqual({ source: "fastighet/gata", facade: "south" });
    expect(fact.confidence).toBe(0.4);
    expect(formatSolCell(fact)).toBe("N (planritning, 0,40) konflikt: fastighet/gata S");
    roundTrips(fact);
  });

  it("conflict: the halved confidence is rounded to 2 decimals", () => {
    const fact = resolveSunFact({ stated: null, plan: { bearingDeg: 0, confidence: 0.3333 }, footprint: footprintOk({ streetBearingDeg: 170, streetFacade: "south", courtyardBearingDeg: 190, courtyardFacade: "south" }) });
    expect(fact.confidence).toBe(0.17);
  });

  it("conflict: against the footprint the nearer of street and courtyard counts", () => {
    // Plan 0 is 14,2 degrees from the courtyard bearing 346,2: no konflikt.
    const fact = resolveSunFact({ stated: null, plan: { bearingDeg: 0, confidence: 0.8 }, footprint: footprintOk() });
    expect(fact.conflict).toBe(false);
    expect(fact.confidence).toBe(0.8);
  });

  it("conflict: with two lower sources in disagreement the first in precedence order is named", () => {
    const fp = footprintOk({ streetBearingDeg: 170, streetFacade: "south", courtyardBearingDeg: 190, courtyardFacade: "south" });
    const fact = resolveSunFact({ stated: ["north"], plan: { bearingDeg: 180, confidence: 0.8 }, footprint: fp });
    expect(fact.conflictWith).toEqual({ source: "planritning", facade: "south" });
    expect(fact.confidence).toBe(0.5);
  });

  it("conflict: when only the footprint disagrees with stated text, the footprint is named with the nearer side's facade", () => {
    const fp = footprintOk({ streetBearingDeg: 170, streetFacade: "south", courtyardBearingDeg: 200, courtyardFacade: "south" });
    const fact = resolveSunFact({ stated: ["north"], plan: { bearingDeg: 10, confidence: 0.8 }, footprint: fp });
    expect(fact.conflict).toBe(true);
    expect(fact.conflictWith).toEqual({ source: "fastighet/gata", facade: "south" });
    expect(fact.confidence).toBe(0.5);
  });

  it("conflict: the footprint's two sides are 180 degrees apart, so stated text is never more than 90 away from the nearer one", () => {
    for (const facade of ["north", "east", "south", "west"] as const) {
      const fact = resolveSunFact({ stated: [facade], plan: null, footprint: footprintOk() });
      expect(fact.conflict).toBe(false);
      expect(fact.confidence).toBe(1);
    }
  });

  it("conflict: exactly 90,0 against the footprint is not a konflikt, 90,1 is", () => {
    const at90 = footprintOk({ streetBearingDeg: 180, streetFacade: "south", courtyardBearingDeg: 180, courtyardFacade: "south" });
    expect(resolveSunFact({ stated: ["east"], plan: null, footprint: at90 }).conflict).toBe(false);
    const past90 = footprintOk({ streetBearingDeg: 180.1, streetFacade: "south", courtyardBearingDeg: 180.1, courtyardFacade: "south" });
    expect(resolveSunFact({ stated: ["east"], plan: null, footprint: past90 }).conflict).toBe(true);
  });

  it("conflict: only the stated winner's FIRST side is compared", () => {
    // East and west stated; the first side is east (90). A plan at 180 is 90 away: no konflikt.
    const fact = resolveSunFact({ stated: ["west", "east"], plan: { bearingDeg: 180, confidence: 0.8 }, footprint: NO_BUILDING });
    expect(fact.conflict).toBe(false);
  });

  it("conflict: the footprint alone never conflicts", () => {
    expect(resolveSunFact({ stated: null, plan: null, footprint: footprintOk() }).conflict).toBe(false);
  });
});

describe("resolveSunFact: stated bearing", () => {
  it("stated bearing: stated west on a street 106 / courtyard 286 flat takes the courtyard bearing and point", () => {
    const fact = resolveSunFact({ stated: ["west"], plan: null, footprint: EAST_WEST });
    expect(fact.sides).toHaveLength(1);
    expect(fact.sides[0]).toMatchObject({ side: "angiven", facade: "west", bearingDeg: 286, share: 1 });
    expect(fact.sides[0].point).toEqual({ lat: 59.3101, lng: 18.0701 });
    roundTrips(fact);
  });

  it("stated bearing: the second stated-west flat (street 94 / courtyard 274) takes 274", () => {
    const fp = footprintOk({ streetBearingDeg: 94, streetFacade: "east", courtyardBearingDeg: 274, courtyardFacade: "west" });
    const fact = resolveSunFact({ stated: ["west"], plan: null, footprint: fp });
    expect(fact.sides[0]).toMatchObject({ facade: "west", bearingDeg: 274 });
    expect(fact.sides[0].point).toEqual(fp.courtyardPoint);
  });

  it("stated bearing: stated north on that flat is more than 45 degrees from both sides, so the sector centre and no point", () => {
    const fact = resolveSunFact({ stated: ["north"], plan: null, footprint: EAST_WEST });
    expect(fact.sides[0]).toMatchObject({ facade: "north", bearingDeg: 0, point: null });
  });

  it("stated bearing: stated east on that flat takes the street bearing 106", () => {
    const fact = resolveSunFact({ stated: ["east"], plan: null, footprint: EAST_WEST });
    expect(fact.sides[0]).toMatchObject({ facade: "east", bearingDeg: 106 });
    expect(fact.sides[0].point).toEqual(EAST_WEST.streetPoint);
  });

  it("stated bearing: exactly 45,0 degrees away still matches; 45,1 does not", () => {
    const at45 = footprintOk({ streetBearingDeg: 135, streetFacade: "south", courtyardBearingDeg: 315, courtyardFacade: "north" });
    expect(resolveSunFact({ stated: ["east"], plan: null, footprint: at45 }).sides[0]).toMatchObject({ bearingDeg: 135 });
    const past45 = footprintOk({ streetBearingDeg: 135.1, streetFacade: "south", courtyardBearingDeg: 315.1, courtyardFacade: "north" });
    expect(resolveSunFact({ stated: ["east"], plan: null, footprint: past45 }).sides[0]).toMatchObject({ bearingDeg: 90, point: null });
  });

  it("stated bearing: a tie at exactly 45 from both sides goes to the street", () => {
    const tie = footprintOk({ streetBearingDeg: 135, streetFacade: "south", courtyardBearingDeg: 45, courtyardFacade: "east" });
    const fact = resolveSunFact({ stated: ["east"], plan: null, footprint: tie });
    expect(fact.sides[0].bearingDeg).toBe(135);
    expect(fact.sides[0].point).toEqual(tie.streetPoint);
  });

  it("stated bearing: the nearer side wins when both are within 45", () => {
    const both = footprintOk({ streetBearingDeg: 100, streetFacade: "east", courtyardBearingDeg: 70, courtyardFacade: "east" });
    expect(resolveSunFact({ stated: ["east"], plan: null, footprint: both }).sides[0].bearingDeg).toBe(100);
    const other = footprintOk({ streetBearingDeg: 120, streetFacade: "east", courtyardBearingDeg: 80, courtyardFacade: "east" });
    expect(resolveSunFact({ stated: ["east"], plan: null, footprint: other }).sides[0].bearingDeg).toBe(80);
  });

  it("stated bearing: a matched courtyard without a point keeps its bearing and has no point", () => {
    const fp = footprintOk({ courtyardPoint: null, streetBearingDeg: 106, streetFacade: "east", courtyardBearingDeg: 286, courtyardFacade: "west" });
    const fact = resolveSunFact({ stated: ["west"], plan: null, footprint: fp });
    expect(fact.sides[0]).toMatchObject({ bearingDeg: 286, point: null });
  });

  it("stated bearing: north wraps (street 350 is 10 degrees from north)", () => {
    const fp = footprintOk({ streetBearingDeg: 350, streetFacade: "north", courtyardBearingDeg: 170, courtyardFacade: "south" });
    expect(resolveSunFact({ stated: ["north"], plan: null, footprint: fp }).sides[0].bearingDeg).toBe(350);
  });

  it("stated bearing: several facades share the flat equally, in the fixed order and without duplicates", () => {
    const fact = resolveSunFact({ stated: ["west", "south", "west", "north"], plan: null, footprint: NO_BUILDING });
    expect(fact.sides.map((s) => s.facade)).toEqual(["north", "south", "west"]);
    expect(fact.sides.every((s) => s.share === 1 / 3)).toBe(true);
    roundTrips(fact);
  });

  it("stated bearing: the footprint diagnostics stay on a stated fact (street side visible)", () => {
    const fact = resolveSunFact({ stated: ["west"], plan: null, footprint: EAST_WEST });
    expect(fact.footprint).toMatchObject({
      osmId: "way/1372512603",
      streetBearingDeg: 106,
      streetFacade: "east",
      courtyardBearingDeg: 286,
      courtyardFacade: "west",
      ambiguous: false,
      floorAboveLevels: false,
    });
  });

  it("stated bearing: the diagnostics stay on a plan fact too", () => {
    const fact = resolveSunFact({ stated: null, plan: { bearingDeg: 100, confidence: 0.8 }, footprint: EAST_WEST });
    expect(fact.footprint?.streetBearingDeg).toBe(106);
  });
});

describe("resolveSunFact: round trip", () => {
  const facades: Facade[][] = [["north"], ["east", "west"], ["south"], ["north", "east", "south", "west"]];
  it("every combination of inputs parses with sunFactSchema and deep-equals itself after JSON", () => {
    const plans = [null, { bearingDeg: 0, confidence: 0.8 }, { bearingDeg: 200.04, confidence: 0.66 }];
    const footprints: FootprintResult[] = [NO_BUILDING, footprintOk(), EAST_WEST, footprintOk({ courtyardPoint: null, ambiguous: true })];
    let n = 0;
    for (const stated of [null, ...facades]) {
      for (const plan of plans) {
        for (const footprint of footprints) {
          roundTrips(resolveSunFact({ stated, plan, footprint }));
          n += 1;
        }
      }
    }
    expect(n).toBe(5 * 3 * 4);
  });

  it("is deterministic and does not mutate its inputs", () => {
    const stated: Facade[] = ["west", "east"];
    const plan = { bearingDeg: 12.34, confidence: 0.77 };
    const footprint = footprintOk();
    const snapshot = JSON.stringify({ stated, plan, footprint });
    const a = resolveSunFact({ stated, plan, footprint });
    const b = resolveSunFact({ stated, plan, footprint });
    expect(a).toEqual(b);
    expect(JSON.stringify({ stated, plan, footprint })).toBe(snapshot);
  });
});

describe("statedFacadesOf", () => {
  it("merges the candidate orientation and the facts record in the fixed order, without duplicates", () => {
    expect(statedFacadesOf({ facades: ["west"] }, ["west", "south"])).toEqual(["south", "west"]);
    expect(statedFacadesOf({ facades: ["west", "north"] }, ["east", "north"])).toEqual(["north", "east", "west"]);
  });

  it("reads either source alone", () => {
    expect(statedFacadesOf({ facades: ["east"] }, null)).toEqual(["east"]);
    expect(statedFacadesOf(null, ["south", "north"])).toEqual(["north", "south"]);
  });

  it("gives null when nothing is stated", () => {
    expect(statedFacadesOf(null, null)).toBeNull();
    expect(statedFacadesOf(null, [])).toBeNull();
    expect(statedFacadesOf({ facades: [] }, null)).toBeNull();
    expect(statedFacadesOf({ facades: [] }, [])).toBeNull();
  });

  it("does not mutate its inputs", () => {
    const facades: Facade[] = ["west", "east"];
    const fromFacts: Facade[] = ["south", "east"];
    statedFacadesOf({ facades }, fromFacts);
    expect(facades).toEqual(["west", "east"]);
    expect(fromFacts).toEqual(["south", "east"]);
  });

  it("feeds resolveSunFact: the merged list becomes one stated side per facade", () => {
    const fact = resolveSunFact({ stated: statedFacadesOf({ facades: ["west"] }, ["west", "south"]), plan: null, footprint: NO_BUILDING });
    expect(fact.sides.map((s) => s.facade)).toEqual(["south", "west"]);
  });
});

describe("formatSolCell: stated, plan and konflikt rows", () => {
  it("prints a stated east/west flat as Ö/V (angiven, 1,00)", () => {
    const fact = resolveSunFact({ stated: ["east", "west"], plan: null, footprint: NO_BUILDING });
    expect(formatSolCell(fact)).toBe("Ö/V (angiven, 1,00)");
  });

  it("prints a plan bearing as S (planritning, 0,80)", () => {
    const fact = resolveSunFact({ stated: null, plan: { bearingDeg: 180, confidence: 0.8 }, footprint: NO_BUILDING });
    expect(formatSolCell(fact)).toBe("S (planritning, 0,80)");
  });

  it("prints stated north against a plan facing south as N (angiven, 0,50) konflikt: planritning S", () => {
    const fact = resolveSunFact({ stated: ["north"], plan: { bearingDeg: 180, confidence: 0.8 }, footprint: NO_BUILDING });
    expect(formatSolCell(fact)).toBe("N (angiven, 0,50) konflikt: planritning S");
  });

  it("prints a stated flat that has a footprint with the stated letter only (no gata/gård label)", () => {
    const fact = resolveSunFact({ stated: ["west"], plan: null, footprint: EAST_WEST });
    expect(formatSolCell(fact)).toBe("V (angiven, 1,00)");
  });

  it("keeps the footprint cell and the dash and okänd forms as they were", () => {
    expect(formatSolCell(resolveSunFact({ stated: null, plan: null, footprint: footprintOk() }))).toBe("S gata/N gård (fastighet/gata, 0,90)");
    expect(formatSolCell(resolveSunFact({ stated: null, plan: null, footprint: footprintOk({ ambiguous: true }) }))).toBe(
      "S gata/N gård (fastighet/gata, 0,90) hörn",
    );
    expect(formatSolCell(null)).toBe("-");
    expect(formatSolCell(resolveSunFact({ stated: null, plan: null, footprint: NO_BUILDING }))).toBe("okänd");
  });

  it("does not print hörn on a stated or plan row, even when the footprint is a corner", () => {
    const fp = footprintOk({ ambiguous: true });
    expect(formatSolCell(resolveSunFact({ stated: ["south"], plan: null, footprint: fp }))).toBe("S (angiven, 1,00)");
  });

  it("names a footprint konflikt with its letter", () => {
    const fp = footprintOk({ streetBearingDeg: 170, streetFacade: "south", courtyardBearingDeg: 190, courtyardFacade: "south" });
    expect(formatSolCell(resolveSunFact({ stated: ["north"], plan: null, footprint: fp }))).toBe("N (angiven, 0,50) konflikt: fastighet/gata S");
  });
});

describe("SUN_SOURCES", () => {
  it("are NFC strings (so exact equality is safe)", () => {
    for (const source of SUN_SOURCES) expect(source).toBe(source.normalize("NFC"));
  });

  it("are exactly the four D-01 labels", () => {
    expect([...SUN_SOURCES]).toEqual(["angiven", "planritning", "fastighet/gata", "okänd"]);
  });
});

// ---------------------------------------------------------------------------
// computeSunFact (plan 07): footprint -> stated -> precedence -> hours
// ---------------------------------------------------------------------------

// Real OSM data (c) OpenStreetMap contributors, ODbL: a 220 m cut around Folkungagatan 61.
const OSM_FIXTURE = join(__dirname, "__fixtures__", "osm-folkungagatan-61.fixture.json");
const osmIndex = buildOsmIndex(parseOsmExtract(JSON.parse(readFileSync(OSM_FIXTURE, "utf8"))));
const FOLKUNGAGATAN_61 = { lat: 59.3147546, lng: 18.07681659, address: "Folkungagatan 61", floor: 5, candidateOrientation: null, factsFacades: null };

describe("computeSunFact: Folkungagatan 61 on the real fixture", () => {
  const fact = computeSunFact(osmIndex, FOLKUNGAGATAN_61, { plan: null });

  it("is the footprint route with a street side (south) and a courtyard side (north)", () => {
    expect(fact.source).toBe("fastighet/gata");
    expect(fact.sides.map((s) => `${s.side}:${s.facade}`)).toEqual(["gata:south", "gård:north"]);
    roundTrips(fact);
  });

  it("gives every side hours, with an obstructed range ordered low <= nominal <= high on the street side", () => {
    for (const side of fact.sides) expect(side.hours).not.toBeNull();
    const street = fact.sides[0].hours;
    if (street === null) throw new Error("street side must have hours");
    expect(street.z).toBe(16.5);
    expect(street.mar.theoreticalWindow).toBeGreaterThan(0);
    const range = street.mar.obstructedWindow;
    if (range === null) throw new Error("obstructed range expected with a floor and a point");
    expect(range.low).toBeLessThanOrEqual(range.nominal);
    expect(range.nominal).toBeLessThanOrEqual(range.high);
  });

  it("with the floor unknown keeps the theoretical hours and gives no obstructed range on either side", () => {
    const noFloor = computeSunFact(osmIndex, { ...FOLKUNGAGATAN_61, floor: null }, { plan: null });
    expect(noFloor.source).toBe("fastighet/gata");
    expect(noFloor.sides[0].hours?.mar.theoreticalWindow).toBeGreaterThan(0); // the south street side
    for (const side of noFloor.sides) {
      expect(side.hours).not.toBeNull();
      expect(side.hours?.z).toBeNull();
      expect(side.hours?.mar.theoreticalWindow).toBeGreaterThanOrEqual(0);
      for (const key of ["mar", "jun", "sep", "dec"] as const) {
        expect(side.hours?.[key].obstructedWindow).toBeNull();
        expect(side.hours?.[key].obstructedDay).toBeNull();
      }
    }
  });

  it("with latitude unknown is okänd 'koordinater saknas' and has no hours", () => {
    const none = computeSunFact(osmIndex, { ...FOLKUNGAGATAN_61, lat: null }, { plan: null });
    expect(none.source).toBe("okänd");
    expect(none.unknownReason).toBe("koordinater saknas");
    expect(none.sides).toEqual([]);
  });

  it("a stated west facade wins, is one side with a bearing and hours", () => {
    const stated = computeSunFact(osmIndex, { ...FOLKUNGAGATAN_61, candidateOrientation: { facades: ["west"] } }, { plan: null });
    expect(stated.source).toBe("angiven");
    expect(stated.sides).toHaveLength(1);
    expect(stated.sides[0].facade).toBe("west");
    expect(stated.sides[0].bearingDeg).not.toBeNull();
    expect(stated.sides[0].hours).not.toBeNull();
    roundTrips(stated);
  });

  it("a stated facade far from both footprint sides has no point, so only theoretical hours", () => {
    // street ~166 / courtyard ~346: east (90) is more than 45 degrees from both
    const stated = computeSunFact(osmIndex, { ...FOLKUNGAGATAN_61, factsFacades: ["east"] }, { plan: null });
    expect(stated.sides[0].point).toBeNull();
    expect(stated.sides[0].hours?.z).toBeNull();
    expect(stated.sides[0].hours?.mar.obstructedWindow).toBeNull();
    expect(stated.sides[0].hours?.mar.theoreticalWindow).toBeGreaterThan(0);
  });

  it("is deterministic and does not change its input", () => {
    const input = JSON.parse(JSON.stringify(FOLKUNGAGATAN_61));
    const before = JSON.stringify(input);
    expect(computeSunFact(osmIndex, input, { plan: null })).toEqual(fact);
    expect(JSON.stringify(input)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// formatSolHours (plan 07, D-08)
// ---------------------------------------------------------------------------

/** Window hours for one date: the theoretical figure and, optionally, the obstructed [nominal, low, high]. */
function dateHours(theoreticalWindow: number, obstructed: readonly [number, number, number] | null): DateHours {
  const range = obstructed === null ? null : { low: obstructed[1], nominal: obstructed[0], high: obstructed[2] };
  return { theoreticalWindow, theoreticalDay: theoreticalWindow + 1, obstructedWindow: range, obstructedDay: range, floorBelowWindow: range === null ? null : range.nominal };
}

/** A footprint fact whose first (street) side has the given hours for mar, jun and dec (sep is not printed). */
function factWithHours(
  mar: DateHours,
  jun: DateHours,
  dec: DateHours,
  over: { heightsEstimated?: boolean } = {},
): SunFact {
  const base = resolveSunFact({ stated: null, plan: null, footprint: footprintOk() });
  const hours = { z: 16.5, heightsEstimated: over.heightsEstimated ?? false, mar, jun, sep: mar, dec };
  return { ...base, sides: base.sides.map((side, i) => (i === 0 ? { ...side, hours } : side)) };
}

describe("computeSunFactSafe: one bad flat never aborts the run (14.3 review WR-03)", () => {
  it("returns exactly the computeSunFact answer, and no failure, when nothing throws", () => {
    const safe = computeSunFactSafe(osmIndex, FOLKUNGAGATAN_61, { plan: null });
    expect(safe.failure).toBeNull();
    expect(safe.fact).toEqual(computeSunFact(osmIndex, FOLKUNGAGATAN_61, { plan: null }));
  });

  it("turns an exception inside the computation into okänd with the reason 'fel' and the error NAME only", () => {
    const broken = {} as unknown as typeof osmIndex; // no bbox: inferStreetFacade throws a TypeError
    expect(() => computeSunFact(broken, FOLKUNGAGATAN_61, { plan: null })).toThrow();
    const safe = computeSunFactSafe(broken, FOLKUNGAGATAN_61, { plan: null });
    expect(safe.failure).toBe("TypeError");
    expect(safe.fact).toEqual(unknownSunFact(SUN_FAILURE_REASON));
    expect(SUN_FAILURE_REASON).toBe("fel");
    expect(safe.fact.source).toBe("okänd");
    expect(safe.fact.unknownReason).toBe("fel");
    roundTrips(safe.fact);
  });

  it("catches a throw while reading the floor-plan bearing (a function plan) as well", () => {
    const safe = computeSunFactSafe(osmIndex, FOLKUNGAGATAN_61, {
      plan: () => {
        throw new RangeError("secret path /tmp/x");
      },
    });
    expect(safe.failure).toBe("RangeError");
    expect(JSON.stringify(safe)).not.toContain("secret path");
    expect(safe.fact.unknownReason).toBe("fel");
  });

  it("reads a function plan like a value, and the run goes on with the next flat after a failure", () => {
    const withPlan = computeSunFactSafe(osmIndex, FOLKUNGAGATAN_61, { plan: () => ({ bearingDeg: 180, confidence: 0.9 }) });
    expect(withPlan.failure).toBeNull();
    expect(withPlan.fact.source).toBe("planritning");
    const flats = [FOLKUNGAGATAN_61, { ...FOLKUNGAGATAN_61, address: null }];
    const results = flats.map((f, i) => computeSunFactSafe(i === 0 ? ({} as unknown as typeof osmIndex) : osmIndex, f, { plan: null }));
    expect(results.map((r) => r.fact.source)).toEqual(["okänd", "okänd"]);
    expect(results.map((r) => r.fact.unknownReason)).toEqual(["fel", "adress saknas"]);
  });
});

describe("formatSolHours", () => {
  it("prints '-' for both cells when the run did not look, and for okänd", () => {
    expect(formatSolHours(null)).toEqual({ theoretical: "-", obstructed: "-" });
    expect(formatSolHours(resolveSunFact({ stated: null, plan: null, footprint: NO_BUILDING }))).toEqual({ theoretical: "-", obstructed: "-" });
  });

  it("prints '-' for both cells when the first side has no hours", () => {
    expect(formatSolHours(resolveSunFact({ stated: null, plan: null, footprint: footprintOk() }))).toEqual({ theoretical: "-", obstructed: "-" });
  });

  it("theoretical: mar/jun/dec of the first side's window with a decimal comma", () => {
    const fact = factWithHours(dateHours(6.0, [5.8, 5.1, 6.0]), dateHours(5.5, [5.5, 5.5, 5.5]), dateHours(4.1, [1.2, 0.0, 4.1]));
    expect(formatSolHours(fact).theoretical).toBe("6,0/5,5/4,1");
  });

  it("obstructed: nominal (low–high) per date joined by ' / ', then ' usäker' when any date is wider than 2,0 h", () => {
    const fact = factWithHours(dateHours(6.0, [5.8, 5.1, 6.0]), dateHours(5.5, [5.5, 5.5, 5.5]), dateHours(4.1, [1.2, 0.0, 4.1]));
    expect(formatSolHours(fact).obstructed).toBe("5,8 (5,1\u20136,0) / 5,5 (5,5\u20135,5) / 1,2 (0,0\u20134,1) usäker");
  });

  it("a width of exactly 2,0 h is not usäker, even when the subtraction has float noise (4,4 - 2,4 is 2,0000000000000004)", () => {
    const exact = factWithHours(dateHours(6, [3.4, 2.4, 4.4]), dateHours(6, [5, 4, 6]), dateHours(3, [2, 1, 3]));
    expect(formatSolHours(exact).obstructed).toBe("3,4 (2,4\u20134,4) / 5,0 (4,0\u20136,0) / 2,0 (1,0\u20133,0)");
  });

  it("a width of 2,1 h on any one date is usäker", () => {
    const wide = factWithHours(dateHours(6, [3.4, 2.4, 4.5]), dateHours(6, [5, 4, 6]), dateHours(3, [2, 1, 3]));
    expect(formatSolHours(wide).obstructed.endsWith(" usäker")).toBe(true);
  });

  it("heightsEstimated adds ' höjd uppskattad' last, after usäker", () => {
    const narrow = factWithHours(dateHours(6, [5, 4.5, 5.5]), dateHours(6, [5, 4.5, 5.5]), dateHours(3, [2, 1.5, 2.5]), { heightsEstimated: true });
    expect(formatSolHours(narrow).obstructed).toBe("5,0 (4,5\u20135,5) / 5,0 (4,5\u20135,5) / 2,0 (1,5\u20132,5) höjd uppskattad");
    const wide = factWithHours(dateHours(6, [5, 1, 6]), dateHours(6, [5, 4.5, 5.5]), dateHours(3, [2, 1.5, 2.5]), { heightsEstimated: true });
    expect(formatSolHours(wide).obstructed.endsWith(" usäker höjd uppskattad")).toBe(true);
  });

  it("hours without an obstructed range (floor unknown): theoretical shown, with-neighbours '-'", () => {
    const fact = factWithHours(dateHours(6.0, null), dateHours(5.5, null), dateHours(4.1, null));
    expect(formatSolHours(fact)).toEqual({ theoretical: "6,0/5,5/4,1", obstructed: "-" });
  });

  it("a range missing on one of the three dates prints '-' for the whole cell", () => {
    const fact = factWithHours(dateHours(6.0, [5, 4, 6]), dateHours(5.5, null), dateHours(4.1, [3, 2, 4]));
    expect(formatSolHours(fact).obstructed).toBe("-");
  });

  it("the cells contain only digits, commas, dashes, brackets, slashes and Swedish words (nothing to escape)", () => {
    const fact = factWithHours(dateHours(6.0, [5.8, 5.1, 6.0]), dateHours(5.5, [5.5, 5.5, 5.5]), dateHours(4.1, [1.2, 0.0, 4.1]), { heightsEstimated: true });
    const { theoretical, obstructed } = formatSolHours(fact);
    expect(`${theoretical} ${obstructed}`).not.toMatch(/[<>&"']/);
  });
});

// ---------------------------------------------------------------------------
// renderSunReport (plan 07)
// ---------------------------------------------------------------------------

/** Hours for one date with every figure spelled out: [nominal, low, high] ranges for the window and the full day. */
function dh(o: { win: number; day: number; w?: readonly [number, number, number] | null; d?: readonly [number, number, number] | null; below?: number | null }): DateHours {
  const range = (r: readonly [number, number, number] | null | undefined) => (r == null ? null : { nominal: r[0], low: r[1], high: r[2] });
  return { theoreticalWindow: o.win, theoreticalDay: o.day, obstructedWindow: range(o.w), obstructedDay: range(o.d), floorBelowWindow: o.below ?? null };
}

/** A footprint fact whose first side carries the same hours on every date (one flat's sun, built by hand). */
function reportFact(hours: DateHours, over: { confidence?: number; heightsEstimated?: boolean; ambiguous?: boolean } = {}): SunFact {
  const base = resolveSunFact({ stated: null, plan: null, footprint: footprintOk({ confidence: over.confidence ?? 0.95, ambiguous: over.ambiguous ?? false }) });
  const side = { z: 16.5, heightsEstimated: over.heightsEstimated ?? false, mar: hours, jun: hours, sep: hours, dec: hours };
  return { ...base, sides: base.sides.map((sd, i) => (i === 0 ? { ...sd, hours: side } : sd)) };
}

const REPORT_OPTS = { probeSummary: "0 av 11 planer med verklig kompass, väg stängd", routeEnabled: false } as const;
const reportLines = (rows: Parameters<typeof renderSunReport>[0], opts: Parameters<typeof renderSunReport>[1] = REPORT_OPTS): string[] => renderSunReport(rows, opts).split("\n");

describe("renderSunReport: the four synthetic rows", () => {
  const hours = dh({ win: 6, day: 10, w: [5, 4.5, 5.5], d: [9, 8, 9.5] });
  const rows = [
    { address: "Folkungagatan 61", sun: reportFact(hours) },
    { address: "Kungsholmsgatan 5", sun: resolveSunFact({ stated: ["west"], plan: null, footprint: EAST_WEST }) },
    { address: "Lugnetvägen 2", sun: unknownSunFact("ingen gata med samma namn inom 35 m") },
    { address: "Bortavägen 9", sun: unknownSunFact("ingen byggnad inom 25 m") },
  ];
  const lines = reportLines(rows);

  it("opens with the pinned line", () => {
    expect(lines[0]).toBe("Sol (4 annonser): fasad härledd 2 av 4 (50,0 %)");
  });

  it("counts the sources in the fixed order", () => {
    expect(lines).toContain("  källa: angiven 1, planritning 0, fastighet/gata 1, okänd 2");
  });

  it("lists the okänd reasons, count descending then reason ascending", () => {
    expect(lines).toContain("  okänd, anledningar: ingen byggnad inom 25 m 1, ingen gata med samma namn inom 35 m 1");
    const more = reportLines([...rows, { address: "Z", sun: unknownSunFact("ingen gata med samma namn inom 35 m") }]);
    expect(more).toContain("  okänd, anledningar: ingen gata med samma namn inom 35 m 2, ingen byggnad inom 25 m 1");
  });

  it("counts confidence >= 0,70, corners and konflikt", () => {
    expect(lines).toContain("  säkerhet >= 0,70: 2 av 2");
    expect(lines).toContain("  hörn: 0, konflikt: 0");
    const odd = reportLines([
      { address: "Hörnet 1", sun: reportFact(hours, { ambiguous: true, confidence: 0.69 }) },
      { address: "Konflikten 2", sun: resolveSunFact({ stated: ["north"], plan: { bearingDeg: 180, confidence: 0.8 }, footprint: { status: "unknown", reason: "adress saknas" } }) },
    ]);
    expect(odd).toContain("  säkerhet >= 0,70: 0 av 2"); // 0,69 and the halved 0,50
    expect(odd).toContain("  hörn: 1, konflikt: 1");
  });

  it("says how many rows have the shade calculated and how many of those use estimated heights", () => {
    expect(lines).toContain("  skugga beräknad 1 av 4 (höjd uppskattad: 0)");
    const estimated = reportLines([{ address: "A", sun: reportFact(hours, { heightsEstimated: true }) }, { address: "B", sun: reportFact(hours) }]);
    expect(estimated).toContain("  skugga beräknad 2 av 2 (höjd uppskattad: 1)");
  });

  it("lists each stated row with its street side and courtyard side", () => {
    expect(lines).toContain("  angiven mot gata: Kungsholmsgatan 5: angiven V, gata Ö 106,0°, gård V 286,0°");
  });

  it("states the floor-plan line, closed route: not computable", () => {
    expect(lines).toContain("  planritning: 0 av 11 planer med verklig kompass, väg stängd; överensstämmelse med fastighet/gata: ej beräkningsbar (väg stängd)");
  });

  it("ends with the OpenStreetMap attribution", () => {
    expect(lines[lines.length - 1]).toBe("  Kartdata: © OpenStreetMap contributors, ODbL");
  });
});

describe("renderSunReport: the +-1 h share and the one-floor sensitivity", () => {
  it("leaves out rows with less than 1,0 h of theoretical full-day sun; a width of exactly 2,0 h counts as within", () => {
    const rows = [
      { address: "Mörkt", sun: reportFact(dh({ win: 0.2, day: 0.5, w: [0, 0, 3], d: [0, 0, 3] })) },
      { address: "Exakt", sun: reportFact(dh({ win: 5, day: 8, w: [3.4, 2.4, 4.4], d: [3.4, 2.4, 4.4] })) },
      { address: "Bredare", sun: reportFact(dh({ win: 5, day: 8, w: [3.4, 2.4, 4.5], d: [3.4, 2.4, 4.5] })) },
    ];
    const line = reportLines(rows).find((l) => l.startsWith("  ±1 h"));
    expect(line).toBeDefined();
    expect(line).toContain("mar 1 av 2 (50,0 %)");
    expect(line).toContain("dec 1 av 2 (50,0 %)");
  });

  it("a row exactly 1,0 h of theoretical full-day sun is counted", () => {
    const rows = [{ address: "Ett", sun: reportFact(dh({ win: 1, day: 1, w: [1, 1, 1], d: [1, 1, 1] })) }];
    expect(reportLines(rows).find((l) => l.startsWith("  ±1 h"))).toContain("mar 1 av 1 (100,0 %)");
  });

  it("counts a row for the floor sensitivity when nominal minus one-floor-lower exceeds 1,0 h; exactly 1,0 does not", () => {
    const rows = [
      { address: "Skiljer", sun: reportFact(dh({ win: 5, day: 8, w: [4, 3.5, 4.5], d: [7, 6, 8], below: 2.9 })) },
      { address: "Skiljer inte", sun: reportFact(dh({ win: 5, day: 8, w: [4, 3.5, 4.5], d: [7, 6, 8], below: 3 })) },
    ];
    const line = reportLines(rows).find((l) => l.startsWith("  en våning lägre"));
    expect(line).toBe("  en våning lägre (> 1,0 h skillnad i fönstret): mar 1 av 2, jun 1 av 2, sep 1 av 2, dec 1 av 2");
  });

  it("rows without an obstructed range are left out of both counts", () => {
    const rows = [{ address: "Utan våning", sun: reportFact(dh({ win: 5, day: 8 })) }];
    const lines = reportLines(rows);
    expect(lines.find((l) => l.startsWith("  ±1 h"))).toContain("mar 0 av 0 (0,0 %)");
    expect(lines.find((l) => l.startsWith("  en våning lägre"))).toContain("mar 0 av 0");
  });
});

describe("renderSunReport: the floor-plan line with the route open", () => {
  const plan = (bearingDeg: number): SunFact => resolveSunFact({ stated: null, plan: { bearingDeg, confidence: 0.8 }, footprint: EAST_WEST });
  const open = { probeSummary: "6 av 11 planer med kompass", routeEnabled: true } as const;

  it("counts a plan bearing within 45,0 degrees of the street or courtyard bearing as agreeing", () => {
    const rows = [
      { address: "Passar", sun: plan(100) }, // 6 from the street side (106)
      { address: "Passar inte", sun: plan(0) }, // 106 from the street side (106), 74 from the courtyard side (286)
      { address: "Kant", sun: plan(331) }, // exactly 45,0 from 286
    ];
    expect(reportLines(rows, open)).toContain("  planritning: 6 av 11 planer med kompass; överensstämmelse med fastighet/gata: 2 av 3");
  });

  it("prints '0 av 0' when no row got its facade from a plan", () => {
    expect(reportLines([{ address: "X", sun: unknownSunFact("adress saknas") }], open)).toContain("  planritning: 6 av 11 planer med kompass; överensstämmelse med fastighet/gata: 0 av 0");
  });
});

describe("renderSunReport: edge cases", () => {
  it("zero rows: the pinned first line and no crash", () => {
    const lines = reportLines([]);
    expect(lines[0]).toBe("Sol (0 annonser): fasad härledd 0 av 0 (0,0 %)");
    expect(lines.join("\n")).not.toMatch(/NaN|Infinity|undefined/);
    expect(lines[lines.length - 1]).toBe("  Kartdata: © OpenStreetMap contributors, ODbL");
  });

  it("rows the run did not look at (sun null) count in N but in no source", () => {
    const lines = reportLines([{ address: "A", sun: null }, { address: "B", sun: unknownSunFact("adress saknas") }]);
    expect(lines[0]).toBe("Sol (2 annonser): fasad härledd 0 av 2 (0,0 %)");
    expect(lines).toContain("  källa: angiven 0, planritning 0, fastighet/gata 0, okänd 1, ej beräknad 1");
  });

  it("is pure: the same rows give the same text", () => {
    const rows = [{ address: "A", sun: reportFact(dh({ win: 5, day: 8, w: [4, 3.5, 4.5], d: [7, 6, 8] })) }];
    expect(renderSunReport(rows, REPORT_OPTS)).toBe(renderSunReport(rows, REPORT_OPTS));
  });
});
