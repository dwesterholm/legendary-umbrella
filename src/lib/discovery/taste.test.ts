import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  LOVED_HUBS,
  TASTE_WEIGHTS,
  hubProximityPct,
  inferredSunScore,
  nearestLovedHub,
  sunScore,
  tasteBonus,
  type InferredSunInput,
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
    expect(r).toEqual({
      sunPct: 0,
      hubPct: 0,
      korsdragPct: 0,
      quietBedroomPct: 0,
      pct: 0,
      nearestHub: null,
      hubMeters: null,
    });
  });

  it("a far-away north-facing flat gets zero, not a penalty", () => {
    const r = tasteBonus({ latitude: 59.4, longitude: 17.9, orientation: { facades: ["north"] }, sunPhrases: null });
    expect(r.pct).toBe(0);
    expect(r.nearestHub).not.toBeNull();
  });
});

describe("layout terms (14.4, D-10, LAY-03)", () => {
  const far = { latitude: 59.4 as number | null, longitude: 17.9 as number | null, orientation: null, sunPhrases: null };
  const todayPct = tasteBonus(far).pct;

  it("the weights are 1 % each", () => {
    expect(TASTE_WEIGHTS.korsdragPct).toBe(0.01);
    expect(TASTE_WEIGHTS.quietBedroomPct).toBe(0.01);
  });

  it("korsdrag and a quiet bedroom each add 1 % of resale", () => {
    const both = tasteBonus({ ...far, layout: { korsdrag: true, quietBedroom: true } });
    expect(both.korsdragPct).toBe(0.01);
    expect(both.quietBedroomPct).toBe(0.01);
    expect(both.pct).toBeCloseTo(todayPct + 0.02, 12);
    const one = tasteBonus({ ...far, layout: { korsdrag: true, quietBedroom: false } });
    expect(one.korsdragPct).toBe(0.01);
    expect(one.quietBedroomPct).toBe(0);
    expect(one.pct).toBeCloseTo(todayPct + 0.01, 12);
  });

  it("false, unknown (null), a null layout and no layout all add 0 and leave pct at today's value", () => {
    for (const layout of [
      { korsdrag: false, quietBedroom: false },
      { korsdrag: null, quietBedroom: null },
      null,
      undefined,
    ]) {
      const r = tasteBonus({ ...far, layout });
      expect(r.korsdragPct).toBe(0);
      expect(r.quietBedroomPct).toBe(0);
      expect(r.pct).toBe(todayPct);
    }
  });

  it("the layout terms are added on top; the cap is not applied here (the best sun and hub part plus both terms is 7 %)", () => {
    const r = tasteBonus({
      latitude: FOLKUNGAGATAN.lat,
      longitude: FOLKUNGAGATAN.lng,
      orientation: { facades: ["east"] },
      sunPhrases: null,
      layout: { korsdrag: true, quietBedroom: true },
    });
    expect(r.pct).toBeCloseTo(0.07, 12);
  });
});

describe("inferred sun (14.3-06: D-07, R-03, SUN-04)", () => {
  const none = { allDaySun: false, throughFlat: false };
  const side = (facade: "north" | "east" | "south" | "west", obstructionFactor = 1) => ({ facade, obstructionFactor });
  const inferred = (
    source: InferredSunInput["source"],
    confidence: number,
    sides: InferredSunInput["sides"],
  ): InferredSunInput => ({ source, confidence, sides });
  const base = { latitude: FOLKUNGAGATAN.lat as number | null, longitude: FOLKUNGAGATAN.lng as number | null };

  it("streetOnlyFactor is 0.5 and the 3 % and 5 % ceilings are unchanged", () => {
    expect(TASTE_WEIGHTS.streetOnlyFactor).toBe(0.5);
    expect(TASTE_WEIGHTS.sunMaxPct).toBe(0.03);
    expect(TASTE_WEIGHTS.sunMaxPct + TASTE_WEIGHTS.hubMaxPct).toBeCloseTo(0.05, 12);
  });

  it("absent, undefined and null inferredSun give today's output for the same input", () => {
    const today = tasteBonus({ ...base, orientation: { facades: ["south"] }, sunPhrases: none });
    expect(tasteBonus({ ...base, orientation: { facades: ["south"] }, sunPhrases: none, inferredSun: null })).toEqual(today);
    expect(tasteBonus({ ...base, orientation: { facades: ["south"] }, sunPhrases: none, inferredSun: undefined })).toEqual(today);
  });

  it("source okänd falls back to today's formula (phrase-only when no facade is known)", () => {
    const r = tasteBonus({
      ...base,
      orientation: null,
      sunPhrases: { allDaySun: true, throughFlat: false },
      inferredSun: inferred("okänd", 0, []),
    });
    expect(r.sunPct).toBeCloseTo(0.03 * 0.3, 12);
    const withOrientation = tasteBonus({
      ...base,
      orientation: { facades: ["east"] },
      sunPhrases: null,
      inferredSun: inferred("okänd", 0, []),
    });
    expect(withOrientation.sunPct).toBeCloseTo(0.03, 12);
  });

  it("Folkungagatan: footprint, street south 0.95 and courtyard north, confidence 1 -> sunPct 0.009975", () => {
    const r = tasteBonus({
      ...base,
      orientation: null,
      sunPhrases: null,
      inferredSun: inferred("fastighet/gata", 1, [side("south", 0.95), side("north", 1)]),
    });
    expect(r.sunPct).toBeCloseTo(0.009975, 9);
    expect(r.hubPct).toBeCloseTo(0.02, 12);
    expect(r.pct).toBeCloseTo(r.sunPct + r.hubPct, 12);
  });

  it("footprint-only east street side with no shade earns half the east weight: 0.015", () => {
    const r = tasteBonus({
      ...base,
      orientation: null,
      sunPhrases: null,
      inferredSun: inferred("fastighet/gata", 1, [side("east"), side("west")]),
    });
    expect(r.sunPct).toBeCloseTo(0.015, 12);
  });

  it("the best side counts, not the sum", () => {
    const r = tasteBonus({
      ...base,
      orientation: null,
      sunPhrases: null,
      inferredSun: inferred("fastighet/gata", 1, [side("east"), side("south")]),
    });
    expect(r.sunPct).toBeCloseTo(0.015, 12);
  });

  it("shade on the better side can make the other side the best one", () => {
    // east 1.0 x 0.2 = 0.2, south 0.7 x 1 = 0.7
    expect(inferredSunScore(inferred("angiven", 1, [side("east", 0.2), side("south", 1)]), null)).toBeCloseTo(0.7, 12);
  });

  it("stated east, confidence 1, no shade gives 0.03 and equals today's sunScore path", () => {
    const r = tasteBonus({
      ...base,
      orientation: { facades: ["east"] },
      sunPhrases: null,
      inferredSun: inferred("angiven", 1, [side("east")]),
    });
    const today = tasteBonus({ ...base, orientation: { facades: ["east"] }, sunPhrases: null });
    expect(r.sunPct).toBeCloseTo(0.03, 12);
    expect(r.sunPct).toBeCloseTo(today.sunPct, 12);
    expect(r.sunPct).toBeCloseTo(0.03 * sunScore({ facades: ["east"] }, null), 12);
  });

  it("stated east plus a stated all-day-sun phrase is capped at 1 and gives exactly 0.03", () => {
    const r = tasteBonus({
      ...base,
      orientation: { facades: ["east"] },
      sunPhrases: { allDaySun: true, throughFlat: false },
      inferredSun: inferred("angiven", 1, [side("east")]),
    });
    expect(r.sunPct).toBe(0.03);
  });

  it("a plan south side with confidence 0.8 gives 0.7 x 0.8 = 0.56 -> 0.0168 (planritning keeps 1.0)", () => {
    const r = tasteBonus({
      ...base,
      orientation: null,
      sunPhrases: null,
      inferredSun: inferred("planritning", 0.8, [side("south")]),
    });
    expect(r.sunPct).toBeCloseTo(0.0168, 12);
  });

  it("halving the obstruction factor halves the sun part", () => {
    const full = inferredSunScore(inferred("angiven", 1, [side("south", 1)]), null);
    const half = inferredSunScore(inferred("angiven", 1, [side("south", 0.5)]), null);
    expect(half).toBeCloseTo(full / 2, 12);
  });

  it("the phrase credit is added once, outside the confidence and street-only scaling", () => {
    const s = inferredSunScore(inferred("fastighet/gata", 0.5, [side("south")]), { allDaySun: true, throughFlat: true });
    expect(s).toBeCloseTo(0.7 * 0.5 * 0.5 + 0.3, 12);
  });

  it("confidence 0 or obstruction factor 0 removes the sun part (phrase credit stays)", () => {
    expect(inferredSunScore(inferred("angiven", 0, [side("east")]), null)).toBe(0);
    expect(inferredSunScore(inferred("angiven", 1, [side("east", 0)]), null)).toBe(0);
    expect(inferredSunScore(inferred("angiven", 0, [side("east")]), { allDaySun: true, throughFlat: false })).toBeCloseTo(0.3, 12);
  });

  it("north and west weigh 0 whatever the confidence", () => {
    expect(inferredSunScore(inferred("angiven", 1, [side("north"), side("west")]), null)).toBe(0);
  });

  it("non-finite and negative inputs count as 0, never NaN", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      const a = inferredSunScore(inferred("angiven", bad, [side("east")]), null);
      const b = inferredSunScore(inferred("angiven", 1, [side("east", bad)]), null);
      expect(a).toBe(0);
      expect(b).toBe(0);
    }
    const r = tasteBonus({
      ...base,
      orientation: null,
      sunPhrases: null,
      inferredSun: inferred("angiven", Number.NaN, [side("east", Number.POSITIVE_INFINITY)]),
    });
    expect(r.sunPct).toBe(0);
    expect(Number.isNaN(r.pct)).toBe(false);
  });

  it("no sides gives 0; confidence and factors above 1 are clamped so the score never passes 1", () => {
    expect(inferredSunScore(inferred("angiven", 1, []), null)).toBe(0);
    expect(inferredSunScore(inferred("angiven", 5, [side("east", 9)]), null)).toBe(1);
  });

  it("the sun part never exceeds 3 % over a grid of every source, facade, confidence, factor and phrase", () => {
    const sources: InferredSunInput["source"][] = ["angiven", "planritning", "fastighet/gata", "okänd"];
    const facades = ["north", "east", "south", "west"] as const;
    const phraseSets = [null, none, { allDaySun: true, throughFlat: false }, { allDaySun: true, throughFlat: true }];
    for (const source of sources) {
      for (const facade of facades) {
        for (let c = 0; c <= 1.0001; c += 0.25) {
          for (let f = 0; f <= 1.0001; f += 0.25) {
            for (const phrases of phraseSets) {
              const r = tasteBonus({
                ...base,
                orientation: null,
                sunPhrases: phrases,
                inferredSun: inferred(source, c, [side(facade, f)]),
              });
              expect(r.sunPct).toBeGreaterThanOrEqual(0);
              expect(r.sunPct).toBeLessThanOrEqual(0.03);
              expect(r.pct).toBeLessThanOrEqual(0.05 + 1e-12);
            }
          }
        }
      }
    }
  });

  it("the hub part is untouched by any sun input", () => {
    const a = tasteBonus({ ...base, orientation: null, sunPhrases: null });
    const b = tasteBonus({ ...base, orientation: null, sunPhrases: null, inferredSun: inferred("angiven", 1, [side("east")]) });
    expect(b.hubPct).toBe(a.hubPct);
    expect(b.nearestHub).toBe(a.nearestHub);
    expect(b.hubMeters).toBe(a.hubMeters);
  });

  it("taste.ts imports no runtime code from the sun or OSM modules", () => {
    const raw = readFileSync(join(process.cwd(), "src/lib/discovery/taste.ts"), "utf-8");
    const runtimeImports = raw
      .split("\n")
      .filter((l) => /^import\s/.test(l) && !/^import type\s/.test(l))
      .filter((l) => /discovery\/(sun-(facade|fact|hours|floorplan)|osm-)/.test(l));
    expect(runtimeImports).toEqual([]);
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
