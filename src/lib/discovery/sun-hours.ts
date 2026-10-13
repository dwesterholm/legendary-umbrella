/**
 * sun-hours.ts - hours of direct sun on one facade, theoretical and with the
 * neighbouring buildings in the way (Phase 14.3, SUN-03).
 *
 * For each of four dates (21 March, June, September and December) the day is
 * sampled every 6 minutes (240 samples from 00:00 UTC). A sample counts when
 * the sun is above 0,5 degrees and in front of the facade (the cosine of the
 * angle between the sun's azimuth and the facade's outward bearing is above
 * 0,05). Every counted sample is 0,1 h, so the figures are counted as whole
 * steps and divided by 10 once: 10,7 is exactly 10,7. "Window" is the morning
 * and midday part, 06:00 <= Stockholm local time < 15:00, read through
 * `Intl.DateTimeFormat` with the Europe/Stockholm zone, so daylight saving and
 * the machine's own time zone never move it.
 *
 * Obstructed hours: from the facade point at the flat's height, a horizontal
 * ray is cast along the sun's azimuth against every wall within 250 m (R-08:
 * the research found 150 m changed 3 of 74 flats by more than half an hour;
 * this supersedes D-06's 150 m). The sun is blocked when ANY crossing has a wall
 * top above the ray at that distance (`H > z + t x tan(altitude)`, strict:
 * equal height is not blocked). Every crossing is tested, not only the first,
 * which keeps concave blocks and courtyard holes right. The result does not
 * depend on the order of the walls.
 *
 * ASSUMPTIONS (each one is a number a reader can challenge):
 * - A flat's height is floor x 3 m + 1,5 m eye height (D-06 literal). Booli's
 *   floor 1 is read as the first floor above ground; whether it is ground
 *   floor + 1 is not proven, which is a 3 m ambiguity, so `floorBelowWindow`
 *   reports the window hours with the flat one storey lower.
 * - Neighbour heights are uncertain by about one storey (R-04), so every
 *   obstructed figure is a range: low (every neighbour +3 m, least sun),
 *   nominal (derived heights) and high (every neighbour -3 m, floored at 0 m,
 *   most sun). low <= nominal <= high always.
 * - Trees, terrain and the shape of roofs are ignored (deferred); a wall is a
 *   vertical plane up to its building's height.
 * - Unknown is not zero: with no flat height there is no obstructed figure
 *   (null), while a facade that never faces the sun that date gets a real 0,0.
 *
 * PURE and synchronous: no clock (the dates are fixed constants, not "now"),
 * no file, no network, no environment. The module-level formatter and the
 * window table are caches of constants.
 *
 * STRUCTURAL SEPARATION (LOCKED): `niche-score.ts` and `report/flags.ts` must
 * NEVER import this module. The static-grep invariant in `niche-score.test.ts`
 * enforces that; the `discovery/sun-` prefix is registered there. `sun-path.ts`
 * (qualitative labels) stays as it is.
 */

import * as SunCalc from "suncalc";
import type { OsmWall } from "@/lib/discovery/osm-buildings";
import type { DateHours, HoursRange, SideHours } from "@/lib/discovery/sun-fact";

/** Every tunable number of the engine in one table; functions own no constants. */
export const SUN_HOURS_PARAMS = {
  /** One sample every 6 minutes: 240 per date, 0,1 h each. */
  stepMinutes: 6,
  /** The sun must be higher than this, in degrees. */
  minAltitudeDeg: 0.5,
  /** The sun must be in front of the facade: cos(azimuth - bearing) above this. */
  facingCosMin: 0.05,
  /** Ray-check radius in metres, inclusive (R-08). */
  radiusM: 250,
  /** Crossings this close (or closer) are the wall the ray starts from. */
  ownWallSkipM: 0.05,
  storeyM: 3,
  eyeM: 1.5,
  /** Neighbour height uncertainty: +-3 m (R-04). */
  envelopeM: 3,
  /** The floor-numbering sensitivity: the flat one storey lower. */
  floorBelowM: 3,
  /** The lowest flat height the sensitivity readout goes to. */
  minZ: 1.5,
  windowStartLocal: 6,
  windowEndLocal: 15,
  dates: { mar: "2026-03-21", jun: "2026-06-21", sep: "2026-09-21", dec: "2026-12-21" },
} as const;

type DateKey = keyof typeof SUN_HOURS_PARAMS.dates;
const DATE_KEYS: readonly DateKey[] = ["mar", "jun", "sep", "dec"];

const DEG = Math.PI / 180;
/** Tolerance for "exactly on the edge" comparisons (an endpoint of a wall, the 250 m radius). */
const EDGE_EPS = 1e-9;

// ---------------------------------------------------------------------------
// Stockholm local time
// ---------------------------------------------------------------------------

const STOCKHOLM_CLOCK = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Stockholm",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function stockholmLocalMinutes(date: Date): number {
  let hour = 0;
  let minute = 0;
  for (const part of STOCKHOLM_CLOCK.formatToParts(date)) {
    if (part.type === "hour") hour = Number(part.value) % 24;
    else if (part.type === "minute") minute = Number(part.value);
  }
  return hour * 60 + minute;
}

/** Stockholm wall-clock time of an instant as hours + minutes / 60 (06:30 is 6,5), whatever the machine's zone. */
export function stockholmLocalHour(date: Date): number {
  return stockholmLocalMinutes(date) / 60;
}

const windowTable = new Map<DateKey, Uint8Array>();

/** For each sample of a date: 1 when its Stockholm local time lies in [windowStartLocal, windowEndLocal). */
function windowFlags(key: DateKey): Uint8Array {
  const cached = windowTable.get(key);
  if (cached !== undefined) return cached;
  const P = SUN_HOURS_PARAMS;
  const samples = Math.round(1440 / P.stepMinutes);
  const base = Date.parse(`${P.dates[key]}T00:00:00Z`);
  const flags = new Uint8Array(samples);
  for (let i = 0; i < samples; i++) {
    const minutes = stockholmLocalMinutes(new Date(base + i * P.stepMinutes * 60_000));
    flags[i] = minutes >= P.windowStartLocal * 60 && minutes < P.windowEndLocal * 60 ? 1 : 0;
  }
  windowTable.set(key, flags);
  return flags;
}

// ---------------------------------------------------------------------------
// Flat height and rays
// ---------------------------------------------------------------------------

/** D-06: floor x 3 m + 1,5 m. Null for an unknown or negative floor. */
export function flatHeightM(floor: number | null): number | null {
  if (floor === null || !Number.isFinite(floor) || floor < 0) return null;
  return floor * SUN_HOURS_PARAMS.storeyM + SUN_HOURS_PARAMS.eyeM;
}

/** One place where a ray meets a wall: the distance along the ray and that wall's height. */
export interface Crossing {
  readonly t: number;
  readonly heightM: number;
  readonly estimated: boolean;
}

/**
 * Every wall the horizontal ray from the origin meets along `azimuthDeg`
 * (north-zero, clockwise; the walls are in metres east/north of the origin).
 * A crossing counts when its distance t is above 0,05 m (the own wall the ray
 * starts from is skipped) and at most `radiusM` (inclusive), and the ray hits
 * the wall between its ends (an endpoint counts).
 */
export function crossings(azimuthDeg: number, walls: readonly OsmWall[], radiusM: number): Crossing[] {
  const dx = Math.sin(azimuthDeg * DEG);
  const dy = Math.cos(azimuthDeg * DEG);
  const found: Crossing[] = [];
  for (const w of walls) {
    const ex = w.x2 - w.x1;
    const ey = w.y2 - w.y1;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < EDGE_EPS) continue; // parallel
    const t = (w.x1 * ey - w.y1 * ex) / den; // metres along the ray
    if (t <= SUN_HOURS_PARAMS.ownWallSkipM || t > radiusM + EDGE_EPS) continue;
    const u = (w.x1 * dy - w.y1 * dx) / den; // 0..1 along the wall
    if (u < -EDGE_EPS || u > 1 + EDGE_EPS) continue;
    found.push({ t, heightM: w.heightM, estimated: w.estimated });
  }
  return found;
}

/** The wall height after the envelope shift; never below ground. */
const shifted = (heightM: number, deltaM: number): number => Math.max(0, heightM + deltaM);

/**
 * True when ANY crossing's wall (its height + `deltaM`, not below 0) is
 * strictly higher than the ray at that distance, `z + t x tanAlt`.
 */
export function isBlocked(found: readonly Crossing[], z: number, tanAlt: number, deltaM: number): boolean {
  for (const c of found) {
    if (shifted(c.heightM, deltaM) > z + c.t * tanAlt) return true;
  }
  return false;
}

/** The nominal-scenario test restricted to walls whose height is our estimate. */
function isBlockedByEstimate(found: readonly Crossing[], z: number, tanAlt: number): boolean {
  for (const c of found) {
    if (c.estimated && c.heightM > z + c.t * tanAlt) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Hours
// ---------------------------------------------------------------------------

export interface SideHoursInput {
  /** The facade point (for the sun's position). */
  readonly lat: number;
  readonly lng: number;
  /** Outward bearing of the facade, degrees clockwise from north. */
  readonly bearingDeg: number;
  /** The flat's height above ground in metres, null when the floor is unknown. */
  readonly z: number | null;
  /** The walls within reach, in metres east/north of (lat, lng). */
  readonly walls: readonly OsmWall[];
}

/** Hours of direct sun on one facade for the four dates; see the module doc for every assumption. */
export function sideHours(input: SideHoursInput): SideHours {
  const P = SUN_HOURS_PARAMS;
  const { lat, lng, bearingDeg, z, walls } = input;
  const zBelow = z === null ? null : Math.max(P.minZ, z - P.floorBelowM);
  const stepMs = P.stepMinutes * 60_000;
  const samples = Math.round(1440 / P.stepMinutes);
  const stepsPerHour = 60 / P.stepMinutes; // 10: a counted step is 0,1 h
  let estimatedBlocked = false;

  const byDate = {} as Record<DateKey, DateHours>;
  for (const key of DATE_KEYS) {
    const flags = windowFlags(key);
    const base = Date.parse(`${P.dates[key]}T00:00:00Z`);
    let theoreticalWindow = 0;
    let theoreticalDay = 0;
    let lowWindow = 0;
    let lowDay = 0;
    let nominalWindow = 0;
    let nominalDay = 0;
    let highWindow = 0;
    let highDay = 0;
    let belowWindow = 0;

    for (let i = 0; i < samples; i++) {
      const pos = SunCalc.getPosition(new Date(base + i * stepMs), lat, lng);
      if (pos.altitude <= P.minAltitudeDeg) continue;
      if (Math.cos((pos.azimuth - bearingDeg) * DEG) <= P.facingCosMin) continue;
      const inWindow = flags[i] === 1;
      theoreticalDay += 1;
      if (inWindow) theoreticalWindow += 1;
      if (z === null || zBelow === null) continue;

      const found = crossings(pos.azimuth, walls, P.radiusM);
      const tanAlt = Math.tan(pos.altitude * DEG);
      if (!isBlocked(found, z, tanAlt, P.envelopeM)) {
        lowDay += 1;
        if (inWindow) lowWindow += 1;
      }
      if (!isBlocked(found, z, tanAlt, 0)) {
        nominalDay += 1;
        if (inWindow) nominalWindow += 1;
      } else if (!estimatedBlocked && isBlockedByEstimate(found, z, tanAlt)) {
        estimatedBlocked = true;
      }
      if (!isBlocked(found, z, tanAlt, -P.envelopeM)) {
        highDay += 1;
        if (inWindow) highWindow += 1;
      }
      if (inWindow && !isBlocked(found, zBelow, tanAlt, 0)) belowWindow += 1;
    }

    const range = (low: number, nominal: number, high: number): HoursRange => ({ low: low / stepsPerHour, nominal: nominal / stepsPerHour, high: high / stepsPerHour });
    byDate[key] = {
      theoreticalWindow: theoreticalWindow / stepsPerHour,
      theoreticalDay: theoreticalDay / stepsPerHour,
      obstructedWindow: z === null ? null : range(lowWindow, nominalWindow, highWindow),
      obstructedDay: z === null ? null : range(lowDay, nominalDay, highDay),
      floorBelowWindow: z === null ? null : belowWindow / stepsPerHour,
    };
  }

  return { z, heightsEstimated: estimatedBlocked, mar: byDate.mar, jun: byDate.jun, sep: byDate.sep, dec: byDate.dec };
}
