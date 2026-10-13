import { describe, expect, it } from "vitest";
import type { FootprintOk, FootprintResult } from "@/lib/discovery/sun-facade";
import {
  SUN_PRECEDENCE_PARAMS,
  SUN_SOURCES,
  formatSolCell,
  resolveSunFact,
  statedFacadesOf,
  sunFactSchema,
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
