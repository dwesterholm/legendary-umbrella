import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  LOVED_HUBS,
  TASTE_WEIGHTS,
  hubProximityPct,
  nearestLovedHub,
  sunScore,
  tasteBonus,
} from "@/lib/discovery/taste";
import { haversineMeters } from "@/lib/discovery/hedonic-model";

/** Booli 150148, Folkungagatan 61: the calibration listing (forsale-snapshot fixture coordinates). */
const FOLKUNGAGATAN = { lat: 59.3147546, lng: 18.07681659 };

describe("LOVED_HUBS (D-06)", () => {
  it("has the seven agreed hubs", () => {
    expect(LOVED_HUBS.map((h) => h.name)).toEqual([
      "SoFo/Folkungagatan",
      "Medborgarplatsen",
      "Mariatorget",
      "Slussen",
      "Katarina Bangata",
      "Fridhemsplan",
      "St Eriksgatan/Hantverkargatan",
    ]);
    for (const h of LOVED_HUBS) {
      expect(h.lat).toBeGreaterThan(59.3);
      expect(h.lat).toBeLessThan(59.34);
      expect(h.lng).toBeGreaterThan(18.02);
      expect(h.lng).toBeLessThan(18.09);
    }
  });
});

describe("nearestLovedHub", () => {
  it("Folkungagatan 61 (Booli 150148) is within 300 m of SoFo or Medborgarplatsen", () => {
    const hub = nearestLovedHub(FOLKUNGAGATAN.lat, FOLKUNGAGATAN.lng);
    expect(hub).not.toBeNull();
    expect(["SoFo/Folkungagatan", "Medborgarplatsen"]).toContain(hub!.name);
    expect(hub!.meters).toBeLessThanOrEqual(TASTE_WEIGHTS.hubFullM);
    // Both of the named hubs are inside the full-bonus radius, so either could be nearest.
    for (const name of ["SoFo/Folkungagatan", "Medborgarplatsen"]) {
      const h = LOVED_HUBS.find((x) => x.name === name)!;
      expect(haversineMeters(FOLKUNGAGATAN.lat, FOLKUNGAGATAN.lng, h.lat, h.lng)).toBeLessThanOrEqual(300);
    }
  });

  it("a point on Kungsholmen has Fridhemsplan as nearest hub", () => {
    expect(nearestLovedHub(59.3336, 18.0292)!.name).toBe("Fridhemsplan");
  });

  it("is null when either coordinate is missing", () => {
    expect(nearestLovedHub(null, 18.07)).toBeNull();
    expect(nearestLovedHub(59.31, null)).toBeNull();
    expect(nearestLovedHub(null, null)).toBeNull();
  });
});

describe("hubProximityPct: full to 300 m, linear to zero at 800 m", () => {
  it("pins the boundary points", () => {
    expect(hubProximityPct(0)).toBeCloseTo(0.02, 12);
    expect(hubProximityPct(300)).toBeCloseTo(0.02, 12);
    expect(hubProximityPct(550)).toBeCloseTo(0.01, 12);
    expect(hubProximityPct(800)).toBe(0);
    expect(hubProximityPct(801)).toBe(0);
    expect(hubProximityPct(5000)).toBe(0);
    expect(hubProximityPct(null)).toBe(0);
  });

  it("never rises as distance grows (0 to 1000 m in 10 m steps) and stays within [0, 0.02]", () => {
    let previous = Infinity;
    for (let m = 0; m <= 1000; m += 10) {
      const v = hubProximityPct(m);
      expect(v).toBeLessThanOrEqual(previous);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(TASTE_WEIGHTS.hubMaxPct);
      previous = v;
    }
  });
});

describe("sunScore", () => {
  const f = (...facades: Array<"north" | "east" | "south" | "west">) => ({ facades });
  const none = { allDaySun: false, throughFlat: false };

  it("unknown orientation and unknown phrases give zero, never a penalty", () => {
    expect(sunScore(null, null)).toBe(0);
    expect(sunScore({ facades: [] }, null)).toBe(0);
    expect(sunScore(null, none)).toBe(0);
  });

  it("scores each facade", () => {
    expect(sunScore(f("east"), null)).toBe(1);
    expect(sunScore(f("south"), null)).toBeCloseTo(0.7, 12);
    expect(sunScore(f("west"), null)).toBe(0);
    expect(sunScore(f("north"), null)).toBe(0);
  });

  it("takes the best facade, not the sum", () => {
    expect(sunScore(f("east", "south"), null)).toBe(1);
    expect(sunScore(f("south", "west"), null)).toBeCloseTo(0.7, 12);
  });

  it("phrases add 0.3 and the total is capped at 1", () => {
    expect(sunScore(f("south"), { allDaySun: true, throughFlat: false })).toBeCloseTo(1, 12);
    expect(sunScore(f("east"), { allDaySun: false, throughFlat: true })).toBe(1);
    expect(sunScore(null, { allDaySun: true, throughFlat: false })).toBeCloseTo(0.3, 12);
    expect(sunScore(null, { allDaySun: false, throughFlat: true })).toBeCloseTo(0.3, 12);
    expect(sunScore(f("south"), { allDaySun: true, throughFlat: true })).toBeLessThanOrEqual(1);
  });

  it("a west or north flat with a stated phrase gets the phrase credit only", () => {
    expect(sunScore(f("north"), { allDaySun: true, throughFlat: false })).toBeCloseTo(0.3, 12);
  });
});

describe("tasteBonus (D-06)", () => {
  const input = {
    latitude: FOLKUNGAGATAN.lat as number | null,
    longitude: FOLKUNGAGATAN.lng as number | null,
    orientation: null as { facades: Array<"north" | "east" | "south" | "west"> } | null,
    sunPhrases: null as { allDaySun: boolean; throughFlat: boolean } | null,
  };

  it("pct is the sun part plus the hub part", () => {
    const r = tasteBonus({ ...input, orientation: { facades: ["south"] } });
    expect(r.sunPct).toBeCloseTo(0.03 * 0.7, 12);
    expect(r.hubPct).toBeCloseTo(0.02, 12);
    expect(r.pct).toBeCloseTo(r.sunPct + r.hubPct, 12);
    expect(r.nearestHub).not.toBeNull();
    expect(r.hubMeters).toBeLessThanOrEqual(300);
  });

  it("Folkungagatan 61 with a stated south facade and all-day-sun balcony gets the full hub part", () => {
    const r = tasteBonus({
      ...input,
      orientation: { facades: ["south"] },
      sunPhrases: { allDaySun: true, throughFlat: false },
    });
    expect(r.hubPct).toBeCloseTo(TASTE_WEIGHTS.hubMaxPct, 12);
    expect(r.sunPct).toBeCloseTo(TASTE_WEIGHTS.sunMaxPct, 12);
  });

  it("the maximum possible bonus is exactly 5 % (east and within 300 m)", () => {
    const r = tasteBonus({ ...input, orientation: { facades: ["east"] } });
    expect(r.pct).toBeCloseTo(0.05, 12);
    expect(r.pct).toBeLessThanOrEqual(0.05 + 1e-12);
  });

  it("unknown orientation and no coordinates give zero, never negative", () => {
    const r = tasteBonus({ latitude: null, longitude: null, orientation: null, sunPhrases: null });
    expect(r).toEqual({ sunPct: 0, hubPct: 0, pct: 0, nearestHub: null, hubMeters: null });
  });

  it("a far-away north-facing flat gets zero, not a penalty", () => {
    const r = tasteBonus({ latitude: 59.4, longitude: 17.9, orientation: { facades: ["north"] }, sunPhrases: null });
    expect(r.pct).toBe(0);
    expect(r.nearestHub).not.toBeNull();
  });
});

describe("purity of taste.ts", () => {
  const FORBIDDEN: readonly RegExp[] = [
    /\bDate\b/,
    /Math\.random/,
    /\bfetch\s*\(/,
    /\bawait\b/,
    /\basync\b/,
    /process\.env/,
    /\bconsole\./,
  ];
  const source = readFileSync(join(process.cwd(), "src/lib/discovery/taste.ts"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1");

  for (const pattern of FORBIDDEN) {
    it(`has no ${pattern}`, () => {
      expect(source).not.toMatch(pattern);
    });
  }

  it("reads distance from hedonic-model's haversineMeters, not its own trigonometry", () => {
    expect(source).toContain("haversineMeters");
  });
});
