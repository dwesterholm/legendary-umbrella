import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as SunCalc from "suncalc";
import { describe, expect, it } from "vitest";
import { buildOsmIndex, parseOsmExtract, wallsNear, type OsmWall } from "@/lib/discovery/osm-buildings";
import { inferStreetFacade } from "@/lib/discovery/sun-facade";
import type { DateHours, SideHours } from "@/lib/discovery/sun-fact";
import { SUN_HOURS_PARAMS, crossings, flatHeightM, isBlocked, sideHours, stockholmLocalHour } from "@/lib/discovery/sun-hours";

// Real OSM data (c) OpenStreetMap contributors, ODbL: a 220 m cut around Folkungagatan 61, downloaded 2026-10-13.
const FIXTURE = join(__dirname, "__fixtures__", "osm-folkungagatan-61.fixture.json");
const FOLKUNGAGATAN = { lat: 59.3147546, lng: 18.07681659 };

const DATE_KEYS = ["mar", "jun", "sep", "dec"] as const;
type DateKey = (typeof DATE_KEYS)[number];

const wall = (x1: number, y1: number, x2: number, y2: number, heightM = 20, estimated = false): OsmWall => ({ x1, y1, x2, y2, heightM, estimated });

/** A closed rectangle of four walls. */
const box = (x0: number, y0: number, x1: number, y1: number, heightM: number, estimated = false): OsmWall[] => [
  wall(x0, y0, x1, y0, heightM, estimated),
  wall(x1, y0, x1, y1, heightM, estimated),
  wall(x1, y1, x0, y1, heightM, estimated),
  wall(x0, y1, x0, y0, heightM, estimated),
];

const here = { lat: FOLKUNGAGATAN.lat, lng: FOLKUNGAGATAN.lng };

/** A deterministic shuffle (no randomness in tests). */
function shuffled<T>(list: readonly T[]): T[] {
  const out = list.slice();
  let seed = 12345;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const hoursOf = (side: SideHours, key: DateKey): DateHours => side[key];

describe("DST: Stockholm local time, never the machine's clock", () => {
  it("06:00 local is 05:00 UTC on 21 Mar and 21 Dec (CET) and 04:00 UTC on 21 Jun and 21 Sep (CEST)", () => {
    expect(stockholmLocalHour(new Date("2026-03-21T05:00:00Z"))).toBe(6);
    expect(stockholmLocalHour(new Date("2026-06-21T04:00:00Z"))).toBe(6);
    expect(stockholmLocalHour(new Date("2026-09-21T04:00:00Z"))).toBe(6);
    expect(stockholmLocalHour(new Date("2026-12-21T05:00:00Z"))).toBe(6);
  });

  it("15:00 local is 13:00 UTC in June, and minutes count as a fraction of an hour", () => {
    expect(stockholmLocalHour(new Date("2026-06-21T13:00:00Z"))).toBe(15);
    expect(stockholmLocalHour(new Date("2026-06-21T04:30:00Z"))).toBe(6.5);
    expect(stockholmLocalHour(new Date("2026-12-21T05:54:00Z"))).toBeCloseTo(6.9, 10);
    expect(stockholmLocalHour(new Date("2026-06-21T22:00:00Z"))).toBe(0);
  });

  it("matches a by-hand window count with the UTC offsets 1, 2, 2, 1 hours (06:00 <= local < 15:00)", () => {
    const offsets: Record<DateKey, number> = { mar: 1, jun: 2, sep: 2, dec: 1 };
    const days = SUN_HOURS_PARAMS.dates;
    for (const bearing of [90, 166.2, 270]) {
      const side = sideHours({ ...here, bearingDeg: bearing, z: null, walls: [] });
      for (const key of DATE_KEYS) {
        let window = 0;
        let day = 0;
        const base = Date.parse(`${days[key]}T00:00:00Z`);
        for (let i = 0; i < 240; i++) {
          const p = SunCalc.getPosition(new Date(base + i * 6 * 60_000), here.lat, here.lng);
          if (p.altitude <= 0.5 || Math.cos(((p.azimuth - bearing) * Math.PI) / 180) <= 0.05) continue;
          day++;
          const localMinutes = i * 6 + offsets[key] * 60;
          if (localMinutes >= 360 && localMinutes < 900) window++;
        }
        expect(side[key].theoreticalDay).toBe(day / 10);
        expect(side[key].theoreticalWindow).toBe(window / 10);
      }
    }
  });

  it("reads 06:00 and 15:00 the same in a UTC test runner and under TZ=America/New_York (the code never calls Date#getHours)", () => {
    expect(stockholmLocalHour(new Date("2026-03-21T05:00:00Z"))).toBe(6);
    expect(stockholmLocalHour(new Date("2026-12-21T14:00:00Z"))).toBe(15);
    expect(stockholmLocalHour(new Date("2026-09-21T13:00:00Z"))).toBe(15);
  });
});

describe("flatHeightM (D-06: floor x 3 + 1,5 m)", () => {
  it("gives 16,5 m for floor 5, 1,5 m for the ground floor and 4,5 m for floor 1", () => {
    expect(flatHeightM(5)).toBe(16.5);
    expect(flatHeightM(0)).toBe(1.5);
    expect(flatHeightM(1)).toBe(4.5);
  });

  it("gives null for an unknown or negative floor", () => {
    expect(flatHeightM(null)).toBeNull();
    expect(flatHeightM(-1)).toBeNull();
  });
});

describe("crossings: radius, own wall and endpoints (R-08)", () => {
  it("counts a wall across the ray at exactly 250,0 m and not at 250,5 m (radius inclusive)", () => {
    expect(SUN_HOURS_PARAMS.radiusM).toBe(250);
    const at250 = crossings(0, [wall(-10, 250, 10, 250)], 250);
    expect(at250).toHaveLength(1);
    expect(at250[0].t).toBeCloseTo(250, 9);
    expect(crossings(0, [wall(-10, 250.5, 10, 250.5)], 250)).toEqual([]);
  });

  it("ignores a crossing 0,04 m away (the wall the ray starts from) and counts one 0,06 m away", () => {
    expect(crossings(0, [wall(-10, 0.04, 10, 0.04)], 250)).toEqual([]);
    expect(crossings(0, [wall(-10, 0.05, 10, 0.05)], 250)).toEqual([]);
    expect(crossings(0, [wall(-10, 0.06, 10, 0.06)], 250)).toHaveLength(1);
  });

  it("counts a ray that hits a wall exactly at its start (u = 0) or its end (u = 1)", () => {
    expect(crossings(0, [wall(0, 100, 10, 100)], 250)).toHaveLength(1);
    expect(crossings(0, [wall(-10, 100, 0, 100)], 250)).toHaveLength(1);
    expect(crossings(0, [wall(0.01, 100, 10, 100)], 250)).toEqual([]);
  });

  it("ignores walls behind the ray, parallel to it, or beside it", () => {
    expect(crossings(0, [wall(-10, -100, 10, -100)], 250)).toEqual([]);
    expect(crossings(0, [wall(5, 10, 5, 90)], 250)).toEqual([]);
    expect(crossings(0, [wall(20, 100, 40, 100)], 250)).toEqual([]);
  });

  it("follows the sun azimuth clockwise from north: 90 degrees looks east, 180 south, 270 west", () => {
    expect(crossings(90, [wall(30, -5, 30, 5)], 250)[0].t).toBeCloseTo(30, 9);
    expect(crossings(180, [wall(-5, -40, 5, -40)], 250)[0].t).toBeCloseTo(40, 9);
    expect(crossings(270, [wall(-50, -5, -50, 5)], 250)[0].t).toBeCloseTo(50, 9);
  });

  it("reports every crossing with its wall height and estimated flag, in any wall order", () => {
    const list = [wall(-5, 40, 5, 40, 12, true), wall(-5, 90, 5, 90, 30, false)];
    const found = crossings(0, list, 250);
    expect(found).toHaveLength(2);
    expect(found.map((c) => [Math.round(c.t), c.heightM, c.estimated]).sort()).toEqual([
      [40, 12, true],
      [90, 30, false],
    ]);
  });
});

describe("isBlocked (strict: equal height does not block)", () => {
  it("does not block when the wall top is exactly on the ray (H = 12, z = 10, t = 20, tan 0,1) and blocks 0,000001 m above", () => {
    expect(isBlocked([{ t: 20, heightM: 12, estimated: false }], 10, 0.1, 0)).toBe(false);
    expect(isBlocked([{ t: 20, heightM: 12.000001, estimated: false }], 10, 0.1, 0)).toBe(true);
  });

  it("tests every crossing, not only the nearest: a low wall in front of a high one still blocks", () => {
    const list = [
      { t: 10, heightM: 5, estimated: false },
      { t: 80, heightM: 40, estimated: false },
    ];
    expect(isBlocked(list, 10, 0.1, 0)).toBe(true);
    expect(isBlocked(list.slice().reverse(), 10, 0.1, 0)).toBe(true);
    expect(isBlocked([], 10, 0.1, 0)).toBe(false);
  });

  it("raises or lowers the wall by delta, and never lowers it below ground", () => {
    const c = [{ t: 20, heightM: 12, estimated: false }];
    expect(isBlocked(c, 10, 0.1, 3)).toBe(true);
    expect(isBlocked(c, 10, 0.1, -3)).toBe(false);
    expect(isBlocked([{ t: 10, heightM: 2, estimated: false }], -0.5, 0, -3)).toBe(true);
  });
});

describe("sideHours: facing away and no walls", () => {
  it("facing away: a north facade at Folkungagatan 61 gets no sun on 21 Dec (a real 0,0, not null)", () => {
    const side = sideHours({ ...here, bearingDeg: 0, z: 16.5, walls: [] });
    expect(side.dec.theoreticalDay).toBe(0);
    expect(side.dec.theoreticalWindow).toBe(0);
    expect(side.dec.obstructedDay).toEqual({ low: 0, nominal: 0, high: 0 });
    expect(side.dec.obstructedWindow).toEqual({ low: 0, nominal: 0, high: 0 });
    expect(side.dec.floorBelowWindow).toBe(0);
    expect(side.jun.theoreticalDay).toBeGreaterThan(3);
  });

  it("no walls: obstructed low = nominal = high = the theoretical figures, on all four dates", () => {
    for (const bearing of [0, 75, 166.2, 250]) {
      const side = sideHours({ ...here, bearingDeg: bearing, z: 10, walls: [] });
      for (const key of DATE_KEYS) {
        const h = hoursOf(side, key);
        expect(h.obstructedWindow).toEqual({ low: h.theoreticalWindow, nominal: h.theoreticalWindow, high: h.theoreticalWindow });
        expect(h.obstructedDay).toEqual({ low: h.theoreticalDay, nominal: h.theoreticalDay, high: h.theoreticalDay });
        expect(h.floorBelowWindow).toBe(h.theoreticalWindow);
      }
      expect(side.heightsEstimated).toBe(false);
    }
  });

  it("a south facade at 59 N gets the daylight the research measured: about 10,7 h on 21 Mar and 5,7 h on 21 Dec (+-0,3)", () => {
    const side = sideHours({ ...here, bearingDeg: 166.2, z: null, walls: [] });
    expect(side.mar.theoreticalDay).toBeGreaterThan(10.4);
    expect(side.mar.theoreticalDay).toBeLessThan(11.0);
    expect(side.dec.theoreticalDay).toBeGreaterThan(5.4);
    expect(side.dec.theoreticalDay).toBeLessThan(6.0);
    expect(side.jun.theoreticalDay).toBeGreaterThan(9.0);
  });

  it("the window is part of the day: theoreticalWindow <= theoreticalDay", () => {
    for (const bearing of [10, 100, 190, 280]) {
      const side = sideHours({ ...here, bearingDeg: bearing, z: null, walls: [] });
      for (const key of DATE_KEYS) expect(side[key].theoreticalWindow).toBeLessThanOrEqual(side[key].theoreticalDay);
    }
  });
});

describe("sideHours: a tall wall due south", () => {
  // 30 m high, 100 m long, 20 m south of the facade; the flat sits at z = 10 m.
  const south = [wall(-50, -20, 50, -20, 30)];
  const side = sideHours({ ...here, bearingDeg: 180, z: 10, walls: south });

  it("wall: blocks the whole December day (the sun never gets above 7 degrees) while the facade has more than 4 h of theoretical sun", () => {
    expect(side.dec.theoreticalDay).toBeGreaterThan(4);
    expect(side.dec.obstructedDay?.nominal).toBe(0);
    expect(side.dec.obstructedWindow?.nominal).toBe(0);
  });

  it("wall: does not block June midday - the 13:00 local (11:00 UTC) sample is lit in the nominal scenario", () => {
    const p = SunCalc.getPosition(new Date("2026-06-21T11:00:00Z"), here.lat, here.lng);
    expect(p.altitude).toBeGreaterThan(45);
    const found = crossings(p.azimuth, south, 250);
    expect(found.length).toBeGreaterThan(0);
    expect(isBlocked(found, 10, Math.tan((p.altitude * Math.PI) / 180), 0)).toBe(false);
    expect(side.jun.obstructedWindow?.nominal).toBeGreaterThan(0);
    expect(side.jun.obstructedWindow?.nominal).toBeLessThan(side.jun.theoreticalWindow);
  });

  it("wall: the same wall that blocks all of December leaves some June sun, so the season changes the answer", () => {
    expect(side.jun.obstructedDay?.nominal).toBeGreaterThan(0);
    expect(side.dec.obstructedDay?.nominal).toBe(0);
  });

  it("wall: a wall a quarter of the height blocks nothing at midday in June but still shades the winter sun", () => {
    const low = sideHours({ ...here, bearingDeg: 180, z: 10, walls: [wall(-50, -20, 50, -20, 12)] });
    expect(low.jun.obstructedWindow?.nominal).toBe(low.jun.theoreticalWindow);
    expect(low.dec.obstructedDay?.nominal).toBeLessThan(low.dec.theoreticalDay);
  });

  it("a flat above the wall sees the sun: z = 40 m clears a 30 m wall on every date", () => {
    const above = sideHours({ ...here, bearingDeg: 180, z: 40, walls: south });
    for (const key of DATE_KEYS) expect(above[key].obstructedDay?.nominal).toBe(above[key].theoreticalDay);
  });
});

describe("sideHours: courtyard side", () => {
  // A 20 x 30 m yard with 25 m walls; the flat sits at its south end at z = 10 m, facing north into the yard.
  const yard = box(-10, -5, 10, 25, 25);
  const yardSide = sideHours({ ...here, bearingDeg: 0, z: 10, walls: yard });

  it("courtyard: a north-facing yard side has summer morning and evening sun in theory and none behind four 25 m walls", () => {
    expect(yardSide.jun.theoreticalDay).toBeGreaterThan(3);
    for (const key of DATE_KEYS) {
      expect(yardSide[key].obstructedDay).toEqual({ low: 0, nominal: 0, high: 0 });
      expect(yardSide[key].obstructedWindow).toEqual({ low: 0, nominal: 0, high: 0 });
    }
  });

  it("courtyard: the ring closes - a ray from inside the yard in every direction meets a wall", () => {
    for (const az of [10, 100, 190, 280, 355]) {
      expect(crossings(az, box(-30, -30, 30, 30, 15), 250).length).toBeGreaterThan(0);
    }
  });
});

describe("sideHours: floor unknown (SUN-03 empty)", () => {
  it("z null: obstructed fields and floorBelowWindow are null, the theoretical hours are still given", () => {
    const side = sideHours({ ...here, bearingDeg: 166.2, z: null, walls: box(-10, -30, 10, -20, 25) });
    expect(side.z).toBeNull();
    expect(side.heightsEstimated).toBe(false);
    for (const key of DATE_KEYS) {
      expect(side[key].obstructedWindow).toBeNull();
      expect(side[key].obstructedDay).toBeNull();
      expect(side[key].floorBelowWindow).toBeNull();
    }
    expect(side.mar.theoreticalDay).toBeGreaterThan(10);
  });

  it("z is passed through when known", () => {
    expect(sideHours({ ...here, bearingDeg: 166.2, z: 16.5, walls: [] }).z).toBe(16.5);
  });
});

describe("sideHours: heightsEstimated", () => {
  const blocking = (estimated: boolean) => [wall(-50, -20, 50, -20, 30, estimated)];

  it("heights estimated: true when the only wall that blocks has an estimated height", () => {
    expect(sideHours({ ...here, bearingDeg: 180, z: 10, walls: blocking(true) }).heightsEstimated).toBe(true);
  });

  it("the same wall tagged: false", () => {
    expect(sideHours({ ...here, bearingDeg: 180, z: 10, walls: blocking(false) }).heightsEstimated).toBe(false);
  });

  it("an estimated wall that never blocks (2 m, below the flat) does not raise the flag", () => {
    expect(sideHours({ ...here, bearingDeg: 180, z: 10, walls: [wall(-50, -20, 50, -20, 2, true)] }).heightsEstimated).toBe(false);
  });

  it("an estimated wall behind the facade, out of reach of every ray, does not raise the flag", () => {
    expect(sideHours({ ...here, bearingDeg: 180, z: 10, walls: [wall(-50, 20, 50, 20, 30, true)] }).heightsEstimated).toBe(false);
  });
});

describe("sideHours: envelope", () => {
  const scenes: Record<string, OsmWall[]> = {
    wall: [wall(-50, -20, 50, -20, 30)],
    "two walls": [...box(-40, -35, -10, -25, 22), ...box(15, -60, 60, -45, 26, true)],
    "staircase of walls": [wall(-40, -30, 40, -30, 14), wall(-60, -70, 60, -70, 21, true), wall(-80, -120, 80, -120, 33), wall(-200, 60, 200, 60, 25)],
    courtyard: [...box(-30, -25, 30, 25, 20), ...box(-8, -8, 8, 8, 16, true)],
  };

  it.each(Object.entries(scenes))("envelope: low <= nominal <= high on every date and both windows (%s)", (_name, walls) => {
    for (const bearing of [0, 90, 166.2, 270]) {
      for (const z of [4.5, 10, 16.5]) {
        const side = sideHours({ ...here, bearingDeg: bearing, z, walls });
        for (const key of DATE_KEYS) {
          const h = side[key];
          for (const range of [h.obstructedWindow, h.obstructedDay]) {
            if (range === null) throw new Error("expected a range");
            expect(range.low).toBeLessThanOrEqual(range.nominal);
            expect(range.nominal).toBeLessThanOrEqual(range.high);
          }
          expect(h.obstructedWindow?.high).toBeLessThanOrEqual(h.theoreticalWindow);
          expect(h.obstructedDay?.high).toBeLessThanOrEqual(h.theoreticalDay);
          expect(h.obstructedWindow?.nominal).toBeLessThanOrEqual(h.obstructedDay?.nominal ?? -1);
          expect(h.floorBelowWindow).toBeLessThanOrEqual(h.obstructedWindow?.nominal ?? -1);
          expect(h.floorBelowWindow).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it.each(Object.entries(scenes))("envelope: shuffling or reversing the wall list gives identical output (%s)", (_name, walls) => {
    const reference = sideHours({ ...here, bearingDeg: 166.2, z: 10, walls });
    expect(sideHours({ ...here, bearingDeg: 166.2, z: 10, walls: walls.slice().reverse() })).toEqual(reference);
    expect(sideHours({ ...here, bearingDeg: 166.2, z: 10, walls: shuffled(walls) })).toEqual(reference);
  });

  it("envelope: +-3 m on the neighbours really moves the answer for a wall near the ray's height", () => {
    // Wall top 12 m at 20 m: the ray equals it at tan 0,1; a 3 m taller wall blocks higher sun, a 3 m lower one lets more through.
    const side = sideHours({ ...here, bearingDeg: 180, z: 10, walls: [wall(-50, -20, 50, -20, 12)] });
    expect(side.dec.obstructedDay?.low).toBeLessThan(side.dec.obstructedDay?.high ?? 0);
    expect(side.mar.obstructedDay?.low).toBeLessThan(side.mar.obstructedDay?.high ?? 0);
  });

  it("floor below: the same flat one storey (3 m) lower gets no more window sun than the nominal flat, and the clamp stops at 1,5 m", () => {
    const walls = [wall(-50, -20, 50, -20, 14)];
    const upper = sideHours({ ...here, bearingDeg: 180, z: 10, walls });
    const ground = sideHours({ ...here, bearingDeg: 180, z: 1.5, walls });
    for (const key of DATE_KEYS) {
      expect(upper[key].floorBelowWindow).toBeLessThanOrEqual(upper[key].obstructedWindow?.nominal ?? -1);
      // z 1,5 m minus 3 m is clamped to 1,5 m, so a ground-floor flat's "floor below" equals its own nominal window.
      expect(ground[key].floorBelowWindow).toBe(ground[key].obstructedWindow?.nominal);
    }
    expect(SUN_HOURS_PARAMS.minZ).toBe(1.5);
    expect(SUN_HOURS_PARAMS.floorBelowM).toBe(3);
  });
});

describe("sideHours: output", () => {
  it("every hour figure is an exact one-decimal number (counted in 6-minute steps, divided by 10 once)", () => {
    const walls = [...box(-40, -35, -10, -25, 22), ...box(15, -60, 60, -45, 26, true)];
    const side = sideHours({ ...here, bearingDeg: 166.2, z: 10, walls });
    const figures: number[] = [];
    for (const key of DATE_KEYS) {
      const h = side[key];
      figures.push(h.theoreticalWindow, h.theoreticalDay, h.floorBelowWindow ?? 0);
      for (const range of [h.obstructedWindow, h.obstructedDay]) figures.push(range?.low ?? 0, range?.nominal ?? 0, range?.high ?? 0);
    }
    expect(figures.length).toBe(36);
    for (const f of figures) {
      expect(Number(f.toFixed(1))).toBe(f);
      expect(Math.abs(f * 10 - Math.round(f * 10))).toBeLessThan(1e-9);
    }
  });

  it("uses 240 samples at 6-minute steps and the four fixed dates", () => {
    expect(SUN_HOURS_PARAMS.stepMinutes).toBe(6);
    expect((24 * 60) / SUN_HOURS_PARAMS.stepMinutes).toBe(240);
    expect(SUN_HOURS_PARAMS.dates).toEqual({ mar: "2026-03-21", jun: "2026-06-21", sep: "2026-09-21", dec: "2026-12-21" });
    expect(SUN_HOURS_PARAMS.windowStartLocal).toBe(6);
    expect(SUN_HOURS_PARAMS.windowEndLocal).toBe(15);
    expect(SUN_HOURS_PARAMS.envelopeM).toBe(3);
  });
});

describe("sideHours: Folkungagatan 61 on the real fixture", () => {
  const index = buildOsmIndex(parseOsmExtract(JSON.parse(readFileSync(FIXTURE, "utf8"))));
  const facade = inferStreetFacade(index, { ...FOLKUNGAGATAN, address: "Folkungagatan 61", floor: 5 });
  if (facade.status !== "ok") throw new Error("Folkungagatan 61 must resolve on the fixture");
  const point = facade.streetPoint;
  const walls = wallsNear(index, point.lat, point.lng, SUN_HOURS_PARAMS.radiusM);
  const input = { lat: point.lat, lng: point.lng, bearingDeg: facade.streetBearingDeg, z: flatHeightM(5), walls };
  const side = sideHours(input);

  it("has the research's theoretical hours (21 Mar 10,7 h and 21 Dec 5,7 h, +-0,3) for the street facade", () => {
    expect(facade.streetBearingDeg).toBeGreaterThan(161);
    expect(facade.streetBearingDeg).toBeLessThan(172);
    expect(walls.length).toBeGreaterThan(500);
    expect(side.z).toBe(16.5);
    expect(Math.abs(side.mar.theoreticalDay - 10.7)).toBeLessThanOrEqual(0.3);
    expect(Math.abs(side.dec.theoreticalDay - 5.7)).toBeLessThanOrEqual(0.3);
  });

  it("keeps every obstructed nominal inside [0, theoretical] and the ranges ordered", () => {
    for (const key of DATE_KEYS) {
      const h = side[key];
      for (const [range, theoretical] of [
        [h.obstructedWindow, h.theoreticalWindow],
        [h.obstructedDay, h.theoreticalDay],
      ] as const) {
        if (range === null) throw new Error("expected a range");
        expect(range.nominal).toBeGreaterThanOrEqual(0);
        expect(range.nominal).toBeLessThanOrEqual(theoretical);
        expect(range.low).toBeLessThanOrEqual(range.nominal);
        expect(range.nominal).toBeLessThanOrEqual(range.high);
        expect(range.high).toBeLessThanOrEqual(theoretical);
      }
    }
  });

  it("flags the heights as estimated when an untagged neighbour is in the way", () => {
    expect(typeof side.heightsEstimated).toBe("boolean");
  });

  it("performance: 100 sideHours calls on the fixture walls finish in under 5 000 ms", () => {
    const start = performance.now();
    for (let i = 0; i < 100; i++) sideHours(input);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("sun-hours is pure", () => {
  it("gives the same answer twice", () => {
    const walls = [wall(-50, -20, 50, -20, 30)];
    expect(sideHours({ ...here, bearingDeg: 180, z: 10, walls })).toEqual(sideHours({ ...here, bearingDeg: 180, z: 10, walls }));
  });
});
