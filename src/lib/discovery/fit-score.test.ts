// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import snapshotJson from "@/lib/discovery/__fixtures__/forsale-snapshot.fixture.json";
import folkungagatanFixtureJson from "@/lib/discovery/__fixtures__/forsale-snapshot-folkungagatan-61.fixture.json";
import modelJson from "@/lib/discovery/__fixtures__/hedonic-model.fixture.json";
import {
  EXPECTED_FINAL_CEILING_SEK,
  FIT_VISION_WINDOW,
  MODEL_HEALTH_BAND,
  NOT_COMPARABLE_ASK_TO_PRED,
  RESIDUAL_FLAG_BASIS,
  RESIDUAL_FLAG_SD,
  TASTE_CAP_PCT,
  TASTE_SUN_OBSTRUCTION_DATE,
  booliIdOf,
  cappedTasteSek,
  rowsAtTasteCap,
  clearlyWorseAbove,
  compareFinal,
  comparePreRank,
  conditionIndexOf,
  fitScore,
  hedonicInputOf,
  inferredSunForTaste,
  inferredSunWithLayout,
  modelHealth,
  parseFitSnapshot,
  preRank,
  rankFit,
  residualFlagCounts,
  residualFlagFires,
  selectVisionWindow,
  type FitInputRow,
  type FitScoreResult,
  type PreRankedRow,
} from "@/lib/discovery/fit-score";
import { computeNicheScore } from "@/lib/discovery/niche-score";
import {
  parseHedonicModel,
  predictKrPerSqm,
  type HedonicModel,
  type InnerstanDistrict,
} from "@/lib/discovery/hedonic-model";
import { CGT_EFFECTIVE_RATE, RENO_COST_MATRIX } from "@/lib/discovery/flip-economics";
import { candidateFactsSchema } from "@/lib/discovery/listing-facts";
import { RENO_BAND, UNKNOWN_RENO_STATES, renoBundle, type RenoState } from "@/lib/discovery/reno-tier";
import { type LayoutFact } from "@/lib/discovery/layout-fact";
import { unknownSunFact, type DateHours, type SideHours, type SunFact } from "@/lib/discovery/sun-fact";
import { LOVED_HUBS, tasteBonus } from "@/lib/discovery/taste";
import type { VisionConditionClaim, VisionResult } from "@/lib/discovery/vision-schema";

// The 14.4 layout tests below exercise the layout WHEN IT INFLUENCES the score; the switch is off in production
// (LAYOUT_INFLUENCE_ENABLED, Daniel 2026-10-17), so this file runs the module with the switch on. The off
// behaviour is covered in layout-influence-off.test.ts and layout-fact.test.ts.
vi.mock("@/lib/discovery/layout-fact", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/discovery/layout-fact")>();
  return {
    ...orig,
    LAYOUT_INFLUENCE_ENABLED: true,
    usableSide: (f: Parameters<typeof orig.usableSide>[0], w: Parameters<typeof orig.usableSide>[1]) => orig.usableSideWhen(f, w, true),
    usablyNoBalcony: (f: Parameters<typeof orig.usablyNoBalcony>[0]) => orig.usablyNoBalconyWhen(f, true),
    korsdragOf: (f: Parameters<typeof orig.korsdragOf>[0]) => orig.korsdragWhen(f, true),
    quietBedroomOf: (f: Parameters<typeof orig.quietBedroomOf>[0]) => orig.quietBedroomWhen(f, true),
    formatSolCellWithLayout: (...a: [Parameters<typeof orig.formatSolCellWithLayout>[0], Parameters<typeof orig.formatSolCellWithLayout>[1], boolean]) =>
      orig.formatSolCellWithLayoutWhen(a[0], a[1], a[2], true),
  };
});

/**
 * fit-score.test.ts - locks the Phase 14.1 tracer: the offline replay, the
 * profit decomposition (D-01, D-05, R-02), the unknown reno bundle (D-10,
 * R-01), deterministic ordering and the purity of the three scoring modules
 * (FIT-06, T-14.1-07). The model is a SYNTHETIC stub: these tests prove the
 * mechanics, not any real price.
 */

const snapshot = parseFitSnapshot(snapshotJson);
const model = parseHedonicModel(modelJson);
const FOLKUNGAGATAN_ID = 150148;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A copy of a real row with chosen candidate fields replaced. */
function rowWith(
  base: FitInputRow,
  candidate: Partial<FitInputRow["candidate"]>,
  rest: Partial<Omit<FitInputRow, "candidate">> = {},
): FitInputRow {
  return { ...base, ...rest, candidate: { ...base.candidate, ...candidate } };
}

describe("replay is offline and complete (FIT-06)", () => {
  it("never calls fetch, and every snapshot row lands in exactly one list", () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network forbidden in replay");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { ranked, notComparable } = rankFit(snapshot.rows, model);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ranked.length + notComparable.length).toBe(snapshot.rows.length);
    const folk = [...ranked, ...notComparable].filter((r) => r.booliId === FOLKUNGAGATAN_ID);
    expect(folk).toHaveLength(1);
  });

  it("is deterministic: the same inputs rank identically twice", () => {
    expect(rankFit(snapshot.rows, model)).toEqual(rankFit(snapshot.rows, model));
  });

  it("the script statically imports no network, job or vision module", () => {
    const source = readFileSync(join(process.cwd(), "scripts/fit-score.ts"), "utf-8");
    const bad = source
      .split("\n")
      .filter((l) => /^import .*from "@\/lib\/(booli\/|discovery\/job"|discovery\/vision")/.test(l));
    expect(bad).toEqual([]);
  });
});

describe("profit decomposition (D-01, D-05, R-02)", () => {
  const { ranked } = rankFit(snapshot.rows, model);

  it("profit = credit - reno - sales - holding - tax + taste for every comparable row", () => {
    for (const r of ranked) {
      const rebuilt =
        (r.creditSek as number) - r.renoSek - r.salesCostsSek - r.holdingCostsSek - r.taxSek + r.tasteSek;
      expect(Math.abs((r.profitSek as number) - rebuilt)).toBeLessThan(1e-6);
    }
  });

  it("creditSek equals resaleSek - purchaseSek and profit rebuilds from it for every comparable row (D-05, 14.4)", () => {
    expect(ranked.length).toBeGreaterThan(0);
    for (const r of ranked) {
      const gap = (r.resaleSek as number) - (r.purchaseSek as number);
      expect(r.creditSek as number).toBeCloseTo(gap, 6);
      expect(r.gapSek as number).toBeCloseTo(gap, 6);
      const rebuilt =
        gap - r.renoSek - r.salesCostsSek - r.holdingCostsSek - r.taxSek + r.tasteSek;
      expect(Math.abs((r.profitSek as number) - rebuilt)).toBeLessThan(1e-6);
    }
  });

  it("a row whose gap is more than 20 % of the resale value keeps the whole gap and carries no cap flag", () => {
    const deep = fitScore(flat({ id: 171, askShareOfModel: 0.6 }), model);
    expect((deep.gapSek as number) / (deep.resaleSek as number)).toBeGreaterThan(0.2);
    expect(deep.creditSek).toBeCloseTo(deep.gapSek as number, 6);
    expect(deep.flags.map(String).filter((f) => /cap|tak/i.test(f))).toEqual([]);
  });

  it("sales, holding and tax default to zero (D-05)", () => {
    for (const r of ranked) {
      expect(r.salesCostsSek).toBe(0);
      expect(r.holdingCostsSek).toBe(0);
      expect(r.taxSek).toBe(0);
    }
  });

  it("sales costs of 50 000 lower every profit by exactly 50 000", () => {
    const withCosts = rankFit(snapshot.rows, model, { salesCostsSek: 50_000 });
    const byId = new Map(withCosts.ranked.map((r) => [r.booliId, r]));
    for (const r of ranked) {
      expect((r.profitSek as number) - (byId.get(r.booliId)!.profitSek as number)).toBeCloseTo(50_000, 6);
    }
  });

  it("holding costs subtract the same way", () => {
    const base = fitScore(snapshot.rows[0], model);
    const held = fitScore(snapshot.rows[0], model, { holdingCostsSek: 12_345 });
    expect((base.profitSek as number) - (held.profitSek as number)).toBeCloseTo(12_345, 6);
  });

  it("applyTax takes the flat capital-gains rate off a positive gain", () => {
    const row = snapshot.rows.find((r) => booliIdOf(r.candidate) === FOLKUNGAGATAN_ID)!;
    const gross = fitScore(row, model);
    const taxed = fitScore(row, model, { applyTax: true });
    const gain = (gross.profitSek as number) - gross.tasteSek;
    expect(gain).toBeGreaterThan(0);
    expect(taxed.taxSek).toBeCloseTo(gain * CGT_EFFECTIVE_RATE, 6);
    expect((gross.profitSek as number) - (taxed.profitSek as number)).toBeCloseTo(taxed.taxSek, 6);
  });
});

describe("reno estimate outside the vision window (D-10, R-01)", () => {
  const { ranked } = rankFit(snapshot.rows, model);
  const mid = (item: keyof typeof RENO_COST_MATRIX) => {
    const [lo, hi] = RENO_COST_MATRIX[item][RENO_BAND];
    return (lo + hi) / 2;
  };

  it("every fixture row is outside the window, so it carries ejBildtolkad", () => {
    expect(snapshot.rows.every((r) => !r.inVisionWindow)).toBe(true);
    for (const r of ranked) expect(r.flags).toContain("ejBildtolkad");
  });

  it("the unknown bundle is 105 000 kr: kitchen-cosmetic + bathroom-cosmetic + paint-apartment at the mid band", () => {
    const expected = mid("kitchen-cosmetic") + mid("bathroom-cosmetic") + mid("paint-apartment");
    expect(expected).toBe(105_000);
    for (const r of ranked) expect(r.renoSek).toBe(expected);
  });

  it("the bundle totals match R-01: fresh 10 000, unknown 105 000, dated 427 500", () => {
    const all = (s: "fresh" | "unknown" | "dated") => renoBundle({ kitchen: s, bathroom: s, overall: s });
    expect(all("fresh").midSek).toBe(10_000);
    expect(all("unknown").midSek).toBe(105_000);
    expect(all("dated").midSek).toBe(427_500);
    expect(renoBundle(UNKNOWN_RENO_STATES).anyUnknown).toBe(true);
  });

  it("a row inside the window with no picture read is renoUnknown, not ejBildtolkad", () => {
    const row = rowWith(snapshot.rows[0], {}, { inVisionWindow: true });
    const r = fitScore(row, model);
    expect(r.flags).toContain("renoUnknown");
    expect(r.flags).not.toContain("ejBildtolkad");
  });

  it("a reno override replaces the bundle", () => {
    const fresh = renoBundle({ kitchen: "fresh", bathroom: "fresh", overall: "fresh" });
    const r = fitScore(snapshot.rows[0], model, { renoOverride: fresh });
    expect(r.renoSek).toBe(10_000);
    expect(r.renoTier).toBe("low");
  });
});

describe("condition index from the existing picture verdict (BID-02, D-13)", () => {
  const vision = (kitchen: RenoState, bathroom: RenoState, overall: RenoState) =>
    renoBundle({ kitchen, bathroom, overall }, undefined, "vision");

  it("any dated attribute is -1, all fresh is +1, everything else is 0", () => {
    expect(conditionIndexOf(vision("dated", "fresh", "ok"))).toBe(-1);
    expect(conditionIndexOf(vision("fresh", "fresh", "dated"))).toBe(-1);
    expect(conditionIndexOf(vision("fresh", "fresh", "fresh"))).toBe(1);
    expect(conditionIndexOf(vision("fresh", "fresh", "ok"))).toBe(0);
    expect(conditionIndexOf(vision("unknown", "unknown", "unknown"))).toBe(0);
    expect(conditionIndexOf(vision("fresh", "fresh", "unknown"))).toBe(0);
  });

  it("a row with no picture read (source none) is 0 even when its states say dated or fresh", () => {
    expect(conditionIndexOf(renoBundle({ kitchen: "dated", bathroom: "dated", overall: "dated" }))).toBe(0);
    expect(conditionIndexOf(renoBundle({ kitchen: "fresh", bathroom: "fresh", overall: "fresh" }))).toBe(0);
    expect(conditionIndexOf(renoBundle(UNKNOWN_RENO_STATES))).toBe(0);
  });

  it("fitScore stores the index; a fitted and kept term then moves the expected final price, a missing term does not", () => {
    const row = rowWith(snapshot.rows[0], {}, { inVisionWindow: true });
    const dated = vision("dated", "ok", "ok");
    const fresh = vision("fresh", "fresh", "fresh");
    const none = fitScore(row, model, { renoOverride: renoBundle(UNKNOWN_RENO_STATES) });
    const withoutTerm = fitScore(row, model, { renoOverride: dated });
    expect(withoutTerm.conditionIndex).toBe(-1);
    expect(fitScore(row, model, { renoOverride: fresh }).conditionIndex).toBe(1);
    expect(none.conditionIndex).toBe(0);
    // No fitted term in the fixture model: the premium is the same for every index, and it says so.
    expect(withoutTerm.overbidPct).toBe(none.overbidPct);
    expect(withoutTerm.overbidDetail?.label.endsWith(", skick ej mätt")).toBe(true);

    const fitted = structuredClone(model);
    fitted.bidPremium.terms.condition = { beta: 0.02, source: "fit", kept: true, n: 250, cvRmse: { without: 0.1, with: 0.09 }, note: "test" };
    const d = fitScore(row, fitted, { renoOverride: dated });
    const f = fitScore(row, fitted, { renoOverride: fresh });
    expect(d.overbidDetail?.conditionUsed).toBe(true);
    expect(Math.log(1 + (d.overbidPct as number))).toBeCloseTo(Math.log(1 + (none.overbidPct as number)) - 0.02, 10);
    expect(Math.log(1 + (f.overbidPct as number))).toBeCloseTo(Math.log(1 + (none.overbidPct as number)) + 0.02, 10);
    expect(d.purchaseSek as number).toBeLessThan(none.purchaseSek as number);
  });

  it("a row that is not comparable carries index 0", () => {
    const r = fitScore(rowWith(snapshot.rows[0], { price: null }), model, { renoOverride: vision("dated", "dated", "dated") });
    expect(r.comparable).toBe(false);
    expect(r.conditionIndex).toBe(0);
  });
});

describe("rows that cannot be compared", () => {
  const base = snapshot.rows[0];

  it("a missing price is listed as not comparable with a null profit", () => {
    const r = fitScore(rowWith(base, { price: null }), model);
    expect(r.comparable).toBe(false);
    expect(r.profitSek).toBeNull();
    expect(r.notComparableReason).toBe("pris saknas");
    expect(r.flags).toContain("notComparable");
  });

  it("a missing or zero living area is listed as not comparable", () => {
    expect(fitScore(rowWith(base, { livingArea: null }), model).comparable).toBe(false);
    expect(fitScore(rowWith(base, { livingArea: 0 }), model).comparable).toBe(false);
  });

  it("an asking price far below the model price is not comparable", () => {
    const r = fitScore(rowWith(base, { price: 500_000 }), model);
    expect(r.askToPred as number).toBeLessThan(NOT_COMPARABLE_ASK_TO_PRED);
    expect(r.comparable).toBe(false);
    expect(r.profitSek).toBeNull();
    expect(rankFit([rowWith(base, { price: 500_000 })], model).notComparable).toHaveLength(1);
  });

  it("flags an expected final price above the ceiling", () => {
    const r = fitScore(rowWith(base, { price: 3_995_000 }, { district: "Södermalm" }), model);
    expect(r.purchaseSek as number).toBeGreaterThan(EXPECTED_FINAL_CEILING_SEK);
    expect(r.flags).toContain("expectedFinalOver4M");
  });

  it("lists unknown inputs instead of fabricating them", () => {
    const r = fitScore(rowWith(base, { floor: null, balcony: null }), model);
    expect(r.featuresImputed).toEqual(expect.arrayContaining(["floor", "balcony"]));
  });
});

describe("ordering", () => {
  it("equal profit: the lower Booli id comes first", () => {
    const base = snapshot.rows[0];
    const a = rowWith(base, { sourceListingUrl: "https://www.booli.se/bostad/200" });
    const b = rowWith(base, { sourceListingUrl: "https://www.booli.se/bostad/100" });
    const { ranked } = rankFit([a, b], model);
    expect(ranked.map((r) => r.booliId)).toEqual([100, 200]);
    expect(rankFit([b, a], model).ranked.map((r) => r.booliId)).toEqual([100, 200]);
  });

  it("rows without a Booli id sort after rows with one", () => {
    const base = snapshot.rows[0];
    const none = rowWith(base, { sourceListingUrl: null });
    const some = rowWith(base, { sourceListingUrl: "https://www.booli.se/bostad/5" });
    expect(rankFit([none, some], model).ranked.map((r) => r.booliId)).toEqual([5, null]);
  });

  it("ranks by profit, highest first", () => {
    const { ranked } = rankFit(snapshot.rows, model);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].profitSek as number).toBeGreaterThanOrEqual(ranked[i].profitSek as number);
    }
  });
});

// ---------------------------------------------------------------------------
// Flat builders for the D-15 suite. Asking prices are computed from the model
// itself (never hard-coded kr/m2), so the fixtures stay valid when the fixture
// model is regenerated.
// ---------------------------------------------------------------------------

interface FlatSpec {
  district?: InnerstanDistrict;
  /** Inside the Södermalm kernel cluster of the fixture model. */
  latitude?: number;
  longitude?: number;
  livingArea?: number;
  floor?: number | null;
  balcony?: boolean | null;
  facades?: ("north" | "east" | "south" | "west")[] | null;
  vision?: VisionResult | null;
  inVisionWindow?: boolean;
  id?: number;
  /** Absolute asking price, or a share of the model's price for this very flat. */
  askSek?: number;
  askShareOfModel?: number;
}

const SOFO_SPOT = { latitude: 59.314, longitude: 18.075 };

function modelPriceSek(spec: FlatSpec, m: HedonicModel = model): number {
  const area = spec.livingArea ?? 40;
  const { krPerSqm } = predictKrPerSqm(m, {
    district: spec.district ?? "Södermalm",
    latitude: spec.latitude ?? SOFO_SPOT.latitude,
    longitude: spec.longitude ?? SOFO_SPOT.longitude,
    floor: spec.floor === undefined ? 3 : spec.floor,
    livingArea: area,
    balcony: spec.balcony === undefined ? false : spec.balcony,
    constructionYear: null,
    avgiftPerSqmMonth: null,
    brfDebtPerSqm: null,
    tomtratt: null,
  });
  return krPerSqm * area;
}

function flat(spec: FlatSpec = {}): FitInputRow {
  const base = snapshot.rows[0];
  const askSek = spec.askSek ?? Math.round(modelPriceSek(spec) * (spec.askShareOfModel ?? 1));
  const id = spec.id ?? 900_001;
  return {
    ...base,
    district: spec.district ?? "Södermalm",
    detailFetched: true,
    inVisionWindow: spec.inVisionWindow ?? false,
    sunPhrases: null,
    candidate: {
      ...base.candidate,
      address: `Testgatan ${id}`,
      price: askSek,
      livingArea: spec.livingArea ?? 40,
      latitude: spec.latitude ?? SOFO_SPOT.latitude,
      longitude: spec.longitude ?? SOFO_SPOT.longitude,
      floor: spec.floor === undefined ? 3 : spec.floor,
      balcony: spec.balcony === undefined ? false : spec.balcony,
      orientation:
        spec.facades === undefined || spec.facades === null
          ? null
          : { facades: spec.facades, confidence: 0.9 },
      vision: spec.vision === undefined ? null : spec.vision,
      sourceListingUrl: `https://www.booli.se/bostad/${id}`,
    },
  };
}

function claim(attribute: VisionConditionClaim["attribute"], text: string): VisionConditionClaim {
  return { attribute, claim: text, imageIndex: 1, whatWasSeen: text, confidence: 0.8 };
}

function visionOf(kitchen: string, bathroom: string, overall: string): VisionResult {
  return {
    claims: [claim("kitchen", kitchen), claim("bathroom", bathroom), claim("overall", overall)],
    imageUrlsUsed: [],
    model: "test",
    costSek: 0,
    ranAt: "2026-10-12T00:00:00Z",
  };
}

const ALL_FRESH = visionOf("Köket är nyrenoverat", "Badrummet är helrenoverat", "Helhetsintryck fräscht");
const ALL_DATED = visionOf("Köket är ursprungligt", "Badrummet har äldre standard", "Slitna golv");

/** profit = credit - reno - sales - holding - tax + taste, to the last float. */
function decompositionGap(r: ReturnType<typeof fitScore>): number {
  const rebuilt =
    (r.creditSek as number) - r.renoSek - r.salesCostsSek - r.holdingCostsSek - r.taxSek + r.tasteSek;
  return Math.abs((r.profitSek as number) - rebuilt);
}

describe("cappedTasteSek (D-06, FIT-03 boundary probe)", () => {
  const RESALE = 4_000_000;

  it("a share of exactly the cap gives exactly cap x resale", () => {
    expect(TASTE_CAP_PCT).toBe(0.05);
    expect(cappedTasteSek(0.05, RESALE)).toBe(0.05 * RESALE);
  });

  it("a share above the cap is clamped to it", () => {
    expect(cappedTasteSek(0.07, RESALE)).toBe(0.05 * RESALE);
    expect(cappedTasteSek(5, RESALE)).toBe(0.05 * RESALE);
  });

  it("a share below the cap passes through, and a negative or non-finite share is zero", () => {
    expect(cappedTasteSek(0.03, RESALE)).toBeCloseTo(0.03 * RESALE, 6);
    expect(cappedTasteSek(-0.01, RESALE)).toBe(0);
    expect(cappedTasteSek(Number.NaN, RESALE)).toBe(0);
    expect(cappedTasteSek(0.02, 0)).toBe(0);
  });
});

describe("taste inside fitScore (D-06)", () => {
  it("tasteSek is the capped taste share of resale, with the parts reported from tasteBonus", () => {
    const row = flat({ facades: ["east"], livingArea: 40 });
    const r = fitScore(row, model);
    const t = tasteBonus({
      latitude: row.candidate.latitude,
      longitude: row.candidate.longitude,
      orientation: row.candidate.orientation,
      sunPhrases: row.sunPhrases,
    });
    expect(r.tasteSek).toBe(cappedTasteSek(t.pct, r.resaleSek as number));
    expect(r.tasteSunPct).toBe(t.sunPct);
    expect(r.tasteHubPct).toBe(t.hubPct);
    expect(r.nearestHub).toBe(t.nearestHub);
    expect(r.hubMeters).toBe(t.hubMeters);
    expect(r.tasteSek).toBeGreaterThan(0);
    expect(r.tasteSek).toBeLessThanOrEqual(TASTE_CAP_PCT * (r.resaleSek as number) + 1e-6);
  });

  it("broker sun phrases reach the taste bonus", () => {
    const plain = fitScore(flat({ facades: null }), model);
    const phrased = fitScore({ ...flat({ facades: null }), sunPhrases: { allDaySun: true, throughFlat: false } }, model);
    expect(phrased.tasteSek).toBeGreaterThan(plain.tasteSek);
  });
});

/** Hours for one date: theoretical morning-and-midday window and the obstructed nominal (null = not computed). */
function dateHours(theoretical: number, nominal: number | null): DateHours {
  return {
    theoreticalWindow: theoretical,
    theoreticalDay: theoretical,
    obstructedWindow: nominal === null ? null : { low: nominal, nominal, high: nominal },
    obstructedDay: null,
    floorBelowWindow: null,
  };
}

function sideHoursOf(mar: DateHours): SideHours {
  return { z: 9, heightsEstimated: false, mar, jun: mar, sep: mar, dec: mar };
}

/** A footprint fact like Folkungagatan 61: street side south, courtyard side north. */
function footprintFact(streetHours: SideHours | null, courtyardHours: SideHours | null, confidence = 1): SunFact {
  return {
    source: "fastighet/gata",
    confidence,
    unknownReason: null,
    conflict: false,
    conflictWith: null,
    sides: [
      { side: "gata", facade: "south", bearingDeg: 170, share: 0.5, point: null, hours: streetHours },
      { side: "gård", facade: "north", bearingDeg: 350, share: 0.5, point: null, hours: courtyardHours },
    ],
    footprint: null,
  };
}

describe("inferredSunForTaste (14.3-06: D-07, R-03)", () => {
  it("reads the obstruction from the March window", () => {
    expect(TASTE_SUN_OBSTRUCTION_DATE).toBe("mar");
  });

  it("null gives null; an okänd fact gives source okänd, confidence 0 and no sides", () => {
    expect(inferredSunForTaste(null)).toBeNull();
    expect(inferredSunForTaste(unknownSunFact("adress saknas"))).toEqual({ source: "okänd", confidence: 0, sides: [] });
  });

  it("obstruction factor is obstructed nominal / theoretical on 21 March: 5.7 / 6.0 = 0.95", () => {
    const fact = footprintFact(sideHoursOf(dateHours(6.0, 5.7)), null);
    const input = inferredSunForTaste(fact)!;
    expect(input.source).toBe("fastighet/gata");
    expect(input.confidence).toBe(1);
    expect(input.sides).toHaveLength(2);
    expect(input.sides[0].facade).toBe("south");
    expect(input.sides[0].obstructionFactor).toBeCloseTo(0.95, 12);
  });

  it("is 1 when the side has no hours, no obstructed range or no theoretical sun, and clamped to 1 above", () => {
    const f = (side: SideHours | null) => inferredSunForTaste(footprintFact(side, null))!.sides[0].obstructionFactor;
    expect(f(null)).toBe(1);
    expect(f(sideHoursOf(dateHours(6.0, null)))).toBe(1);
    expect(f(sideHoursOf(dateHours(0, 0)))).toBe(1);
    expect(f(sideHoursOf(dateHours(6.0, 6.3)))).toBe(1);
  });

  it("is 0 when the neighbours take all of the sun and never negative", () => {
    const f = (nominal: number) => inferredSunForTaste(footprintFact(sideHoursOf(dateHours(6, nominal)), null))!.sides[0].obstructionFactor;
    expect(f(0)).toBe(0);
    expect(f(-1)).toBe(0);
  });

  it("copies the stored confidence without rounding", () => {
    expect(inferredSunForTaste(footprintFact(null, null, 0.35))!.confidence).toBe(0.35);
  });

  it("uses only March: a different obstruction in June does not move the factor", () => {
    const mar = dateHours(6, 3);
    const side: SideHours = { z: 9, heightsEstimated: false, mar, jun: dateHours(6, 6), sep: dateHours(6, 6), dec: dateHours(6, 6) };
    expect(inferredSunForTaste(footprintFact(side, null))!.sides[0].obstructionFactor).toBeCloseTo(0.5, 12);
  });
});

describe("a sun fact inside fitScore (14.3-06, SUN-04)", () => {
  /** street south, courtyard north, factor 0.95 on the street side, confidence 1, footprint only */
  const folk = footprintFact(sideHoursOf(dateHours(6.0, 5.7)), sideHoursOf(dateHours(0, 0)), 1);

  it("a Folkungagatan-like row gets tasteSunPct 0.009975 and tasteSek = cappedTasteSek(sun + hub, resale)", () => {
    const row = { ...flat({ facades: null }), sun: folk };
    const r = fitScore(row, model);
    expect(r.tasteSunPct).toBeCloseTo(0.009975, 9);
    expect(r.tasteSek).toBe(cappedTasteSek((r.tasteSunPct as number) + (r.tasteHubPct as number), r.resaleSek as number));
  });

  it("the same row with sun null scores exactly as before: tasteSek, profit and flags", () => {
    const row = flat({ facades: null });
    const withNull = fitScore({ ...row, sun: null }, model);
    const without = fitScore(row, model);
    expect(withNull.tasteSek).toBe(without.tasteSek);
    expect(withNull.profitSek).toBe(without.profitSek);
    expect(withNull.flags).toEqual(without.flags);
    expect(withNull.tasteSunPct).toBe(0);
    const withSun = fitScore({ ...row, sun: folk }, model);
    expect(withSun.profitSek as number).toBeGreaterThan(without.profitSek as number);
    expect(withSun.flags).toEqual(without.flags);
    expect(withSun.tasteSek - without.tasteSek).toBeCloseTo(0.009975 * (withSun.resaleSek as number), 4);
  });

  it("an okänd fact scores exactly as no fact", () => {
    const row = flat({ facades: ["east"] });
    expect(fitScore({ ...row, sun: unknownSunFact("x") }, model).profitSek).toBe(fitScore(row, model).profitSek);
  });

  it("a stated east fact with no shade equals the candidate.orientation east path", () => {
    const stated: SunFact = {
      source: "angiven",
      confidence: 1,
      unknownReason: null,
      conflict: false,
      conflictWith: null,
      sides: [{ side: "angiven", facade: "east", bearingDeg: 90, share: 1, point: null, hours: null }],
      footprint: null,
    };
    const row = flat({ facades: ["east"] });
    const viaFact = fitScore({ ...row, sun: stated }, model);
    const viaText = fitScore(row, model);
    expect(viaFact.tasteSunPct).toBeCloseTo(viaText.tasteSunPct as number, 12);
    expect(viaFact.tasteSek).toBeCloseTo(viaText.tasteSek, 6);
  });

  it("the sun part never passes 3 % of resale, whatever the fact", () => {
    const best: SunFact = { ...footprintFact(null, null, 1), source: "angiven" };
    best.sides = [{ side: "angiven", facade: "east", bearingDeg: 90, share: 1, point: null, hours: null }];
    const r = fitScore({ ...flat({ facades: null }), sunPhrases: { allDaySun: true, throughFlat: true }, sun: best }, model);
    expect(r.tasteSunPct).toBe(0.03);
    expect(r.tasteSek).toBeLessThanOrEqual(TASTE_CAP_PCT * (r.resaleSek as number) + 1e-6);
  });
});

describe("reno choice by vision window (D-10, R-01)", () => {
  it("an in-window row with vision claims uses the vision reno and is not flagged unknown", () => {
    const r = fitScore(flat({ inVisionWindow: true, vision: ALL_FRESH }), model);
    expect(r.renoSek).toBe(10_000);
    expect(r.flags).not.toContain("renoUnknown");
    expect(r.flags).not.toContain("ejBildtolkad");
  });

  it("an out-of-window row uses the unknown bundle and ejBildtolkad, never renoUnknown", () => {
    const r = fitScore(flat({ inVisionWindow: false, vision: ALL_FRESH }), model);
    expect(r.renoSek).toBe(105_000);
    expect(r.flags).toContain("ejBildtolkad");
    expect(r.flags).not.toContain("renoUnknown");
  });

  it("an in-window row with no vision, or a partly unknown read, is renoUnknown", () => {
    expect(fitScore(flat({ inVisionWindow: true, vision: null }), model).flags).toContain("renoUnknown");
    const partial: VisionResult = { ...ALL_FRESH, claims: [claim("kitchen", "Köket är nyrenoverat")] };
    const r = fitScore(flat({ inVisionWindow: true, vision: partial }), model);
    expect(r.flags).toContain("renoUnknown");
    expect(r.renoStates.bathroom).toBe("unknown");
  });
});

describe("expected final price boundary at 4 000 000 kr (D-03, FIT-03 boundary probe)", () => {
  // Vasastan has an overbid of exactly 0 in the fixture model, so asking = final.
  const vasastan = { district: "Vasastan" as const, latitude: 59.345, longitude: 18.045, livingArea: 40 };

  it("exactly 4 000 000 is not flagged; 4 000 001 is flagged; both stay in the ranking", () => {
    const at = flat({ ...vasastan, askSek: 4_000_000, id: 1 });
    const over = flat({ ...vasastan, askSek: 4_000_001, id: 2 });
    const { ranked } = rankFit([at, over], model);
    const rAt = ranked.find((r) => r.booliId === 1)!;
    const rOver = ranked.find((r) => r.booliId === 2)!;
    expect(rAt.purchaseSek).toBe(4_000_000);
    expect(rAt.flags).not.toContain("expectedFinalOver4M");
    expect(rOver.purchaseSek).toBe(4_000_001);
    expect(rOver.flags).toContain("expectedFinalOver4M");
    expect(ranked).toHaveLength(2);
  });
});

describe("negative profit is reported, not clamped or dropped (FIT-03 boundary probe)", () => {
  it("a flat asked 30 % above the model has negative profit and stays in the ranking", () => {
    const row = flat({ askShareOfModel: 1.3, id: 3 });
    const { ranked } = rankFit([row], model);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].profitSek as number).toBeLessThan(0);
    expect(ranked[0].creditSek as number).toBeLessThan(0);
    expect(decompositionGap(ranked[0])).toBeLessThan(1e-6);
  });
});

describe("size outside the fitted range is flagged, never silent (R-12)", () => {
  it("the fixture model is fitted on 35-80 m2", () => {
    expect(model.minLivingArea).toBe(35);
    expect(model.maxLivingArea).toBe(80);
  });

  it("95 m2 carries utanförModellensStorlek, stays ranked with a finite profit; 45, 35 and 80 m2 do not carry it", () => {
    const areas = [95, 45, 35, 80];
    const rows = areas.map((a, i) => flat({ livingArea: a, id: 10 + i }));
    const { ranked } = rankFit(rows, model);
    expect(ranked).toHaveLength(4);
    const byArea = new Map(ranked.map((r) => [r.livingArea, r]));
    const big = byArea.get(95)!;
    expect(big.flags).toContain("utanförModellensStorlek");
    expect(Number.isFinite(big.profitSek as number)).toBe(true);
    expect(byArea.get(45)!.flags).not.toContain("utanförModellensStorlek");
    expect(byArea.get(35)!.flags).not.toContain("utanförModellensStorlek");
    expect(byArea.get(80)!.flags).not.toContain("utanförModellensStorlek");
  });

  it("below the range is flagged too (34.9 m2) and the flag changes no number", () => {
    const small = fitScore(flat({ livingArea: 34.9 }), model);
    expect(small.flags).toContain("utanförModellensStorlek");
    const inside = fitScore(flat({ livingArea: 35 }), model);
    expect(inside.flags).not.toContain("utanförModellensStorlek");
    expect(decompositionGap(small)).toBeLessThan(1e-6);
  });
});

describe("D-15 fixture suite: Daniel's ordering rules", () => {
  // Shared locations. Medborgarplatsen is a loved hub inside the kernel cluster.
  it("#1 reno object without balcony outranks a 3rd-floor balcony flat with poor sun (D-15 #1)", () => {
    const renoObject = flat({
      id: 101,
      livingArea: 45,
      floor: 2,
      balcony: false,
      inVisionWindow: true,
      vision: ALL_DATED,
      askShareOfModel: 0.7,
    });
    const balcony3 = flat({
      id: 102,
      livingArea: 35,
      floor: 3,
      balcony: true,
      facades: ["north"],
      inVisionWindow: true,
      vision: ALL_FRESH,
      askShareOfModel: 1.0,
    });
    const { ranked } = rankFit([balcony3, renoObject], model);
    const reno = ranked.find((r) => r.booliId === 101)!;
    const bal = ranked.find((r) => r.booliId === 102)!;
    expect(reno.creditSek).toBeCloseTo(reno.gapSek as number, 6);
    expect(reno.profitSek as number).toBeGreaterThan(bal.profitSek as number);
    expect(ranked.map((r) => r.booliId)).toEqual([101, 102]);
  });

  it("D-07 regression: the reno object is credited with its whole gap, uncapped", () => {
    const renoObject = flat({
      id: 103,
      livingArea: 45,
      floor: 2,
      inVisionWindow: true,
      vision: ALL_DATED,
      askShareOfModel: 0.7,
    });
    const r = fitScore(renoObject, model);
    expect(r.renoSek).toBe(427_500);
    expect(r.creditSek).toBeCloseTo(r.gapSek as number, 6);
    expect((r.gapSek as number) / (r.resaleSek as number)).toBeGreaterThan(0.2);
    // The profit stays positive even after paying for the full reno bundle.
    expect(r.profitSek as number).toBeGreaterThan(0);
  });

  it("#2 the same flat on floor 5 earns strictly more than on floor 1 (D-15 #2)", () => {
    const ask = Math.round(modelPriceSek({ livingArea: 40, floor: 3 }));
    const high = fitScore(flat({ id: 111, floor: 5, askSek: ask }), model);
    const low = fitScore(flat({ id: 112, floor: 1, askSek: ask }), model);
    expect(high.profitSek as number).toBeGreaterThan(low.profitSek as number);
  });

  it("#3 asking 3.9 M in Södermalm is flagged over 4.0 M and kept (D-15 #3)", () => {
    const row = flat({ id: 121, livingArea: 36, askSek: 3_900_000 });
    const { ranked } = rankFit([row], model);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].purchaseSek).toBeCloseTo(4_212_000, 6);
    expect(ranked[0].flags).toContain("expectedFinalOver4M");
  });

  it("#4 all-fresh claims give 10 000 kr reno, all-dated 427 500 kr (D-15 #4)", () => {
    const fresh = fitScore(flat({ id: 131, inVisionWindow: true, vision: ALL_FRESH }), model);
    const dated = fitScore(flat({ id: 132, inVisionWindow: true, vision: ALL_DATED }), model);
    expect(fresh.renoSek).toBe(10_000);
    expect(fresh.renoTier).toBe("low");
    expect(dated.renoSek).toBe(427_500);
    expect(dated.renoTier).toBe("high");
  });

  it("#5 one adverse attribute never raises profit (D-15 #5)", () => {
    const base: FlatSpec = {
      id: 141,
      livingArea: 40,
      floor: 4,
      balcony: true,
      facades: ["east"],
    };
    const ask = Math.round(modelPriceSek(base) * 0.9);
    const profit = (spec: FlatSpec, m: HedonicModel = model) =>
      fitScore(flat({ ...spec, askSek: ask }), m).profitSek as number;
    const baseProfit = profit(base);

    expect(profit({ ...base, floor: 2 })).toBeLessThan(baseProfit);
    expect(profit({ ...base, balcony: false })).toBeLessThan(baseProfit);
    expect(profit({ ...base, facades: ["north"] })).toBeLessThan(baseProfit);
  });

  it("#5 farther from the loved hubs never raises profit (distance toggle isolated from the price level)", () => {
    // With the location betas at zero the model price is the same at both spots,
    // so only the taste hub part can differ.
    const flatModel: HedonicModel = {
      ...model,
      features: model.features.map((f) =>
        f.name === "nbLevel" || f.name === "centralityKm" ? { ...f, beta: 0 } : f,
      ),
    };
    const fridhemsplan = LOVED_HUBS.find((h) => h.name === "Fridhemsplan")!;
    const metersPerDegLat = (Math.PI / 180) * 6_371_000;
    const spot = (northMeters: number) => ({
      latitude: fridhemsplan.lat + northMeters / metersPerDegLat,
      longitude: fridhemsplan.lng,
    });
    const near = { ...spot(150), district: "Kungsholmen" as const };
    const far = { ...spot(-900), district: "Kungsholmen" as const };
    const hubAt = (p: { latitude: number; longitude: number }) =>
      tasteBonus({ ...p, orientation: null, sunPhrases: null });
    expect(hubAt(near).hubMeters as number).toBeCloseTo(150, 0);
    expect(hubAt(far).hubMeters as number).toBeGreaterThanOrEqual(800);

    const common = { id: 142, livingArea: 40, floor: 4, balcony: true, facades: ["east" as const] };
    expect(modelPriceSek({ ...common, ...near }, flatModel)).toBeCloseTo(modelPriceSek({ ...common, ...far }, flatModel), 6);
    const ask = Math.round(modelPriceSek({ ...common, ...near }, flatModel) * 0.9);
    const nearResult = fitScore(flat({ ...common, ...near, askSek: ask }), flatModel);
    const farResult = fitScore(flat({ ...common, ...far, askSek: ask }), flatModel);
    expect(nearResult.tasteHubPct).toBeGreaterThan(farResult.tasteHubPct);
    expect(farResult.profitSek as number).toBeLessThan(nearResult.profitSek as number);
  });

  it("#6 a flat 40 % below the model gets hiddenDefectRisk and residualFlag; one 15 % below gets neither (D-15 #6)", () => {
    const deep = fitScore(flat({ id: 151, askShareOfModel: 0.6 }), model);
    const mild = fitScore(flat({ id: 152, askShareOfModel: 0.85 }), model);
    expect(deep.flags).toContain("hiddenDefectRisk");
    expect(deep.flags).toContain("residualFlag");
    expect(mild.flags).not.toContain("hiddenDefectRisk");
    expect(mild.flags).not.toContain("residualFlag");
  });

  it("the decomposition invariant and the zero cost defaults hold for every fixture flat above", () => {
    const rows = [
      flat({ id: 161, livingArea: 45, floor: 2, inVisionWindow: true, vision: ALL_DATED, askShareOfModel: 0.7 }),
      flat({ id: 162, livingArea: 35, floor: 3, balcony: true, facades: ["north"], inVisionWindow: true, vision: ALL_FRESH }),
      flat({ id: 163, floor: 5 }),
      flat({ id: 164, livingArea: 36, askSek: 3_900_000 }),
      flat({ id: 165, askShareOfModel: 0.6 }),
      flat({ id: 166, askShareOfModel: 1.3 }),
      flat({ id: 167, livingArea: 95 }),
    ];
    for (const row of rows) {
      const r = fitScore(row, model);
      expect(decompositionGap(r), `row ${r.booliId}`).toBeLessThan(1e-6);
      expect(r.salesCostsSek).toBe(0);
      expect(r.holdingCostsSek).toBe(0);
      expect(r.taxSek).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Task 2: pre-rank, vision window, final ranking, dominance, model health
// ---------------------------------------------------------------------------

/** A hand-built pre-ranked row with chosen sort keys (everything else is real). */
function preRow(id: number | null, profitSek: number, nicheScore: number, address = `Adress ${id}`): PreRankedRow {
  const row = flat({ id: id ?? 1 });
  const real = fitScore(row, model);
  return {
    row,
    pre: { ...real, booliId: id, profitSek, address },
    nicheScore,
    position: 0,
  };
}

describe("comparePreRank (D-10)", () => {
  it("higher pre-profit first", () => {
    expect(comparePreRank(preRow(2, 200, 0.1), preRow(1, 100, 0.9))).toBeLessThan(0);
    expect(comparePreRank(preRow(1, 100, 0.9), preRow(2, 200, 0.1))).toBeGreaterThan(0);
  });

  it("equal pre-profit: higher niche score first", () => {
    expect(comparePreRank(preRow(9, 100, 0.8), preRow(1, 100, 0.2))).toBeLessThan(0);
  });

  it("equal profit and niche score: lower Booli id first; a null id sorts after any id", () => {
    expect(comparePreRank(preRow(100, 100, 0.5), preRow(200, 100, 0.5))).toBeLessThan(0);
    expect(comparePreRank(preRow(null, 100, 0.5), preRow(999_999, 100, 0.5))).toBeGreaterThan(0);
    expect(comparePreRank(preRow(999_999, 100, 0.5), preRow(null, 100, 0.5))).toBeLessThan(0);
  });

  it("two rows without an id fall back to address, then to equal", () => {
    expect(comparePreRank(preRow(null, 100, 0.5, "A-gatan"), preRow(null, 100, 0.5, "B-gatan"))).toBeLessThan(0);
    expect(comparePreRank(preRow(null, 100, 0.5, "A-gatan"), preRow(null, 100, 0.5, "A-gatan"))).toBe(0);
  });
});

describe("compareFinal (FIT-05 adjacency probe)", () => {
  it("two rows with identical profit: the /bostad/100 row comes before /bostad/200", () => {
    const a = { ...fitScore(flat({ id: 200 }), model), profitSek: 500 };
    const b = { ...fitScore(flat({ id: 100 }), model), profitSek: 500 };
    expect(compareFinal(a, b)).toBeGreaterThan(0);
    expect(compareFinal(b, a)).toBeLessThan(0);
    const { ranked } = rankFit([flat({ id: 200 }), flat({ id: 100 })], model);
    expect(ranked.map((r) => r.booliId)).toEqual([100, 200]);
  });

  it("higher profit first, including negative profits", () => {
    const hi = { ...fitScore(flat({ id: 2 }), model), profitSek: -10 };
    const lo = { ...fitScore(flat({ id: 1 }), model), profitSek: -20 };
    expect(compareFinal(hi, lo)).toBeLessThan(0);
  });
});

describe("preRank (D-10, FIT-05)", () => {
  it("ignores vision: every pre-ranked row carries the unknown reno bundle, 1-based positions", () => {
    const rows = [
      flat({ id: 1, inVisionWindow: true, vision: ALL_DATED, askShareOfModel: 0.9 }),
      flat({ id: 2, inVisionWindow: true, vision: ALL_FRESH, askShareOfModel: 0.95 }),
      flat({ id: 3, askShareOfModel: 1.0 }),
    ];
    const { ranked, notComparable } = preRank(rows, model);
    expect(notComparable).toEqual([]);
    expect(ranked.map((r) => r.position)).toEqual([1, 2, 3]);
    for (const r of ranked) expect(r.pre.renoSek).toBe(105_000);
  });

  it("orders by pre-profit, and the niche baseline is the median kr/m2 of the comparable rows", () => {
    const rows = [
      flat({ id: 1, askShareOfModel: 1.0 }),
      flat({ id: 2, askShareOfModel: 0.8 }),
      flat({ id: 3, askShareOfModel: 0.9 }),
      flat({ id: 4, askShareOfModel: 0.4 }), // not comparable: far below the model
    ];
    const { ranked, notComparable } = preRank(rows, model);
    expect(ranked.map((r) => r.pre.booliId)).toEqual([2, 3, 1]);
    expect(notComparable.map((r) => r.booliId)).toEqual([4]);

    const perSqm = ranked
      .map((r) => (r.row.candidate.price as number) / (r.row.candidate.livingArea as number))
      .sort((a, b) => a - b);
    const median = perSqm[1];
    for (const r of ranked) {
      const expected = computeNicheScore(r.row.candidate, "renovation-upside", { medianPricePerSqm: median }).score;
      expect(r.nicheScore).toBe(expected);
    }
  });

  it("rows with equal pre-profit are ordered by niche score, then Booli id", () => {
    const a = flat({ id: 300, askSek: 3_000_000 });
    const b = flat({ id: 200, askSek: 3_000_000 });
    const { ranked } = preRank([a, b], model);
    expect(ranked.map((r) => r.pre.booliId)).toEqual([200, 300]);
  });

  it("not-comparable rows (no price, no area, ask far below the model) never enter the ranking or the window", () => {
    const rows = [
      flat({ id: 1, askShareOfModel: 0.9 }),
      rowWith(flat({ id: 2 }), { price: null }),
      rowWith(flat({ id: 3 }), { livingArea: null }),
      flat({ id: 4, askShareOfModel: 0.3 }),
    ];
    const { ranked, notComparable } = preRank(rows, model);
    expect(ranked.map((r) => r.pre.booliId)).toEqual([1]);
    expect(notComparable.map((r) => r.booliId).sort()).toEqual([2, 3, 4]);
    const { inWindow, outside } = selectVisionWindow(ranked);
    expect([...inWindow, ...outside].map((r) => r.pre.booliId)).toEqual([1]);
  });

  it("empty input gives an empty pre-rank (FIT-05 empty probe)", () => {
    expect(preRank([], model)).toEqual({ ranked: [], notComparable: [] });
  });
});

describe("selectVisionWindow (FIT-05 ordering probe)", () => {
  /** 25 pre-ranked rows with strictly falling profit, ids 1..25, shuffled on input. */
  function twentyFive(): PreRankedRow[] {
    return Array.from({ length: 25 }, (_, i) => preRow(i + 1, 1_000_000 - i * 1000, 0.5));
  }

  it("exactly 20 of 25 are inside, the first 20 by the comparator, 5 outside", () => {
    const shuffled = [...twentyFive()].reverse();
    const { inWindow, outside } = selectVisionWindow(shuffled, 20);
    expect(inWindow).toHaveLength(20);
    expect(outside).toHaveLength(5);
    expect(inWindow.map((r) => r.pre.booliId)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(outside.map((r) => r.pre.booliId)).toEqual([21, 22, 23, 24, 25]);
  });

  it("the default size is FIT_VISION_WINDOW", () => {
    expect(selectVisionWindow(twentyFive()).inWindow).toHaveLength(FIT_VISION_WINDOW);
  });

  it("a tie in pre-profit and niche score at positions 20 and 21 puts the lower Booli id inside", () => {
    const rows = twentyFive().map((r, i) =>
      i === 19 ? preRow(500, 900_000, 0.5) : i === 20 ? preRow(400, 900_000, 0.5) : r,
    );
    // Rows 20 and 21 now both have 900 000; make sure nothing else sits between them.
    const lowered = rows.map((r, i) => (i > 20 ? { ...r, pre: { ...r.pre, profitSek: 800_000 - i } } : r));
    const { inWindow, outside } = selectVisionWindow([...lowered].reverse(), 20);
    expect(inWindow.map((r) => r.pre.booliId)).toContain(400);
    expect(outside.map((r) => r.pre.booliId)).toContain(500);
    expect(inWindow).toHaveLength(20);
  });

  it("fewer rows than the window: all inside, none outside", () => {
    const some = twentyFive().slice(0, 7);
    const { inWindow, outside } = selectVisionWindow(some, 20);
    expect(inWindow).toHaveLength(7);
    expect(outside).toEqual([]);
  });

  it("empty input gives an empty window (FIT-05 empty probe)", () => {
    expect(selectVisionWindow([])).toEqual({ inWindow: [], outside: [] });
  });

  it("a zero or negative size puts everything outside", () => {
    expect(selectVisionWindow(twentyFive(), 0).inWindow).toEqual([]);
    expect(selectVisionWindow(twentyFive(), -3).inWindow).toEqual([]);
  });
});

describe("rankFit with the picture read applied (D-10)", () => {
  it("a dated flat ranks below an otherwise identical fresh flat: vision re-orders", () => {
    const dated = flat({ id: 1, inVisionWindow: true, vision: ALL_DATED, askShareOfModel: 0.9 });
    const fresh = flat({ id: 2, inVisionWindow: true, vision: ALL_FRESH, askShareOfModel: 0.9 });
    // Pre-rank cannot tell them apart (id 1 wins the tie); the picture read can.
    const pre = preRank([dated, fresh], model).ranked;
    expect(pre.map((r) => r.pre.booliId)).toEqual([1, 2]);
    const { ranked } = rankFit([dated, fresh], model);
    expect(ranked.map((r) => r.booliId)).toEqual([2, 1]);
    expect((ranked[0].profitSek as number) - (ranked[1].profitSek as number)).toBeCloseTo(427_500 - 10_000, 6);
  });

  it("empty input gives empty lists and a neutral health (FIT-05 empty probe)", () => {
    const out = rankFit([], model);
    expect(out.ranked).toEqual([]);
    expect(out.notComparable).toEqual([]);
    expect(out.health).toMatchObject({ medianFinalToPred: null, outOfBand: false, n: 0 });
  });

  it("health is reported alongside the ranking", () => {
    const { health } = rankFit(snapshot.rows, model);
    expect(health.n).toBe(46);
    expect(health.band).toEqual(MODEL_HEALTH_BAND);
    expect(typeof health.medianFinalToPred).toBe("number");
  });
});

describe("modelHealth", () => {
  /** A result whose final price is `ratio` x the model value of the flat (area 1, pred 1000). */
  function withRatio(ratio: number): FitScoreResult {
    return { ...fitScore(flat(), model), purchaseSek: ratio * 1000, predKrPerSqm: 1000, livingArea: 1 };
  }

  it("the band is 0.85 to 1.15, inclusive", () => {
    expect(MODEL_HEALTH_BAND).toEqual([0.85, 1.15]);
    expect(modelHealth([withRatio(0.85)]).outOfBand).toBe(false);
    expect(modelHealth([withRatio(1.15)]).outOfBand).toBe(false);
    expect(modelHealth([withRatio(1)]).outOfBand).toBe(false);
  });

  it("outside the band is flagged, on either side", () => {
    expect(modelHealth([withRatio(0.849)]).outOfBand).toBe(true);
    expect(modelHealth([withRatio(1.151)]).outOfBand).toBe(true);
  });

  it("uses the median of purchase / (pred x area): odd and even counts, outliers do not move it", () => {
    expect(modelHealth([withRatio(1.0), withRatio(1.1), withRatio(5)]).medianFinalToPred).toBeCloseTo(1.1, 9);
    expect(modelHealth([withRatio(1.0), withRatio(1.2)]).medianFinalToPred).toBeCloseTo(1.1, 9);
    expect(modelHealth([withRatio(1.0), withRatio(1.1), withRatio(5)]).n).toBe(3);
  });

  it("ignores rows that are not comparable", () => {
    const bad = fitScore(rowWith(flat(), { price: null }), model);
    const h = modelHealth([withRatio(1), bad]);
    expect(h.n).toBe(1);
  });

  it("no comparable rows: null median, not out of band, n 0", () => {
    expect(modelHealth([])).toMatchObject({ medianFinalToPred: null, outOfBand: false, n: 0 });
  });
});

describe("clearlyWorseAbove (D-14 second clause, measured)", () => {
  /** A comparable result with explicit comparison keys. */
  function result(id: number, over: Partial<FitScoreResult>): FitScoreResult {
    const base = fitScore(flat({ id }), model);
    return {
      ...base,
      predKrPerSqm: 100_000,
      livingArea: 40,
      purchaseSek: 4_000_000, // 100 000 kr/m2
      resaleSek: 4_400_000,
      tasteSek: 44_000, // 1 % of resale
      renoSek: 105_000,
      ...over,
    };
  }

  it("returns a row above the target that is no better on anything and worse on something", () => {
    const target = result(1, {});
    const worse = result(2, { predKrPerSqm: 90_000 }); // worse location
    const ranked = [worse, target];
    expect(clearlyWorseAbove(ranked, 1)).toEqual([worse]);
  });

  it("equal on every key is not 'clearly worse' (needs strictly worse on at least one)", () => {
    const target = result(1, {});
    const twin = result(2, {});
    expect(clearlyWorseAbove([twin, target], 1)).toEqual([]);
  });

  it("a row better on any one key is not returned", () => {
    const target = result(1, {});
    const biggerFlat = result(2, { predKrPerSqm: 90_000, livingArea: 41 });
    const moreTaste = result(3, { predKrPerSqm: 90_000, tasteSek: 88_000 });
    const lessReno = result(4, { predKrPerSqm: 90_000, renoSek: 10_000 });
    const cheaperPerSqm = result(5, { predKrPerSqm: 90_000, purchaseSek: 3_900_000 });
    const betterLocation = result(6, { predKrPerSqm: 110_000, renoSek: 427_500 });
    const ranked = [biggerFlat, moreTaste, lessReno, cheaperPerSqm, betterLocation, target];
    expect(clearlyWorseAbove(ranked, 1)).toEqual([]);
  });

  it("each key can be the one that makes a row worse", () => {
    const target = result(1, {});
    const smaller = result(2, { livingArea: 38 });
    const lessTaste = result(3, { tasteSek: 0 });
    const moreReno = result(4, { renoSek: 427_500 });
    const dearerPerSqm = result(5, { purchaseSek: 4_200_000 });
    expect(clearlyWorseAbove([smaller, lessTaste, moreReno, dearerPerSqm, target], 1)).toEqual([
      smaller,
      lessTaste,
      moreReno,
      dearerPerSqm,
    ]);
  });

  it("only rows ranked above the target count", () => {
    const target = result(1, {});
    const worseButBelow = result(2, { predKrPerSqm: 90_000 });
    expect(clearlyWorseAbove([target, worseButBelow], 1)).toEqual([]);
  });

  it("target absent gives an empty list", () => {
    expect(clearlyWorseAbove([result(2, {})], 99)).toEqual([]);
    expect(clearlyWorseAbove([], 1)).toEqual([]);
  });
});

describe("booliIdOf", () => {
  it("reads /bostad/ and /annons/ ids, with or without a query string", () => {
    expect(booliIdOf({ sourceListingUrl: "https://www.booli.se/bostad/150148" })).toBe(150148);
    expect(booliIdOf({ sourceListingUrl: "https://www.booli.se/annons/6295311" })).toBe(6295311);
    expect(booliIdOf({ sourceListingUrl: "https://www.booli.se/annons/6295311?x=1" })).toBe(6295311);
  });

  it("returns null for a missing or unrelated URL", () => {
    expect(booliIdOf({ sourceListingUrl: null })).toBeNull();
    expect(booliIdOf({ sourceListingUrl: "https://www.booli.se/sok/till-salu" })).toBeNull();
  });
});

describe("parseFitSnapshot (T-14.1-06)", () => {
  it("parses the committed snapshot", () => {
    expect(snapshot.rows.length).toBe(47);
    expect(FIT_VISION_WINDOW).toBe(20);
  });

  it("rejects a row with an unknown district", () => {
    const bad = structuredClone(snapshotJson) as unknown as { rows: { district: string }[] };
    bad.rows[0].district = "Lidingö";
    expect(() => parseFitSnapshot(bad)).toThrow(/Invalid fit snapshot/);
  });

  it("rejects the wrong version", () => {
    expect(() => parseFitSnapshot({ ...snapshotJson, version: 2 })).toThrow();
  });
});

describe("purity of the scoring modules (item P)", () => {
  const FORBIDDEN: readonly RegExp[] = [
    /\bDate\b/,
    /Math\.random/,
    /\bfetch\s*\(/,
    /\bawait\b/,
    /\basync\b/,
    /process\.env/,
    /\breadFileSync\b/,
    /\bconsole\./,
  ];

  /** Source with block and line comments removed, so prose cannot trip a pattern. */
  function code(path: string): string {
    const source = readFileSync(join(process.cwd(), path), "utf-8");
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1");
  }

  for (const path of [
    "src/lib/discovery/fit-score.ts",
    "src/lib/discovery/hedonic-model.ts",
    "src/lib/discovery/reno-tier.ts",
  ]) {
    it(`${path} has no clock, randomness, network, async, env, file I/O or console`, () => {
      const source = code(path);
      for (const re of FORBIDDEN) expect(source, `${path} matches ${re}`).not.toMatch(re);
    });
  }

  it("fit-score.ts has no fixed-decimal string formatting", () => {
    expect(code("src/lib/discovery/fit-score.ts")).not.toMatch(/\.toFixed\(/);
  });
});

describe("snapshot row facts (R-08, Phase 14.2)", () => {
  it("the committed pre-14.2 fixture parses unchanged: every row reads as 'no facts'", () => {
    expect(snapshot.rows.length).toBeGreaterThan(0);
    for (const row of snapshot.rows) expect(row.facts).toBeNull();
  });

  it("a row with a facts record round-trips through JSON and keeps its values", () => {
    const facts = candidateFactsSchema.parse({
      tenureForm: "Bostadsrätt",
      avgiftMonthlySek: 4100,
      balcony: true,
      sunPhrases: ["kvällssol"],
      descriptionRead: true,
      detailFetched: true,
    });
    const withFacts = { ...snapshot, rows: snapshot.rows.map((r, i) => (i === 0 ? { ...r, facts } : r)) };
    const reparsed = parseFitSnapshot(JSON.parse(JSON.stringify(withFacts)));
    expect(reparsed.rows[0].facts).toEqual(facts);
    expect(reparsed.rows[1].facts).toBeNull();
  });

  it("a facts record with a missing key parses, the key reads null, and free text cannot ride along", () => {
    const raw = JSON.parse(JSON.stringify(snapshot));
    raw.rows[0].facts = { tenureForm: "Bostadsrätt", description: "Ring säljaren på 070-123 45 67" };
    const parsed = parseFitSnapshot(raw);
    expect(parsed.rows[0].facts?.tenureForm).toBe("Bostadsrätt");
    expect(parsed.rows[0].facts?.avgiftMonthlySek).toBeNull();
    expect(parsed.rows[0].facts?.detailFetched).toBe(false);
    expect(JSON.stringify(parsed.rows[0].facts)).not.toContain("070-123");
  });

  it("scoring ignores facts: the same ranking with and without them", () => {
    const facts = candidateFactsSchema.parse({ tenureForm: "Bostadsrätt", detailFetched: true });
    const a = rankFit(snapshot.rows, model);
    const b = rankFit(snapshot.rows.map((r) => ({ ...r, facts })), model);
    expect(b.ranked.map((r) => [r.booliId, r.profitSek])).toEqual(a.ranked.map((r) => [r.booliId, r.profitSek]));
  });
});

describe("snapshot row sun (R-08, Phase 14.3)", () => {
  const sun = unknownSunFact("adress saknas");

  it("the committed fixture has no sun record: every row reads null", () => {
    for (const row of snapshot.rows) expect(row.sun).toBeNull();
  });

  it("a stored value that does not match the current schema reads null and the snapshot still parses", () => {
    const raw = JSON.parse(JSON.stringify(snapshot));
    raw.rows[0].sun = { junk: 1 };
    raw.rows[1].sun = "okänd";
    raw.rows[2].sun = { ...sun, source: "gissning" };
    const parsed = parseFitSnapshot(raw);
    expect(parsed.rows.slice(0, 3).map((r) => r.sun)).toEqual([null, null, null]);
    expect(parsed.rows).toHaveLength(snapshot.rows.length);
  });

  it("a valid record round-trips through JSON", () => {
    const withSun = { ...snapshot, rows: snapshot.rows.map((r, i) => (i === 0 ? { ...r, sun } : r)) };
    const reparsed = parseFitSnapshot(JSON.parse(JSON.stringify(withSun)));
    expect(reparsed.rows[0].sun).toEqual(sun);
    expect(reparsed.rows[1].sun).toBeNull();
  });

  it("the result carries the row's record through unchanged on both return paths, and scoring ignores it", () => {
    const row = snapshot.rows.find((r) => fitScore(r, model).comparable) as FitInputRow;
    expect(fitScore({ ...row, sun }, model).sun).toEqual(sun);
    expect(fitScore(row, model).sun).toBeNull();
    const noPrice = { ...row, sun, candidate: { ...row.candidate, price: null } };
    const notComparable = fitScore(noPrice, model);
    expect(notComparable.comparable).toBe(false);
    expect(notComparable.sun).toEqual(sun);
    const a = rankFit(snapshot.rows, model);
    const b = rankFit(snapshot.rows.map((r) => ({ ...r, sun })), model);
    expect(b.ranked.map((r) => [r.booliId, r.profitSek])).toEqual(a.ranked.map((r) => [r.booliId, r.profitSek]));
  });
});

describe("hedonicInputOf: the candidate-side inputs of the 14.4 features (D-01)", () => {
  const base = snapshot.rows[0];

  it("fills avgift per m2, the association's debt per m2 and tomträtt from the row's facts", () => {
    const facts = candidateFactsSchema.parse({
      avgiftMonthlySek: 2232,
      brf: { loanSek: 1_000_000, areaSqm: 200, reportYear: 2025, debtPerSqm: 5000 },
      landLease: true,
      detailFetched: true,
    });
    const input = hedonicInputOf({ ...base, facts }, 35);
    expect(input.avgiftPerSqmMonth).toBeCloseTo(2232 / 35, 12);
    expect(input.brfDebtPerSqm).toBe(5000);
    expect(input.tomtratt).toBe(true);
    expect(input.livingArea).toBe(35);
  });

  it("a row without facts gives null for all three: nothing is made up", () => {
    const input = hedonicInputOf({ ...base, facts: null }, 35);
    expect(input.avgiftPerSqmMonth).toBeNull();
    expect(input.brfDebtPerSqm).toBeNull();
    expect(input.tomtratt).toBeNull();
  });

  it("an avgift of zero, a negative debt and an unstated land lease stay unknown; a debt of zero is a real value", () => {
    const zeroAvgift = candidateFactsSchema.parse({ avgiftMonthlySek: 0, brf: { debtPerSqm: -5 } });
    const a = hedonicInputOf({ ...base, facts: zeroAvgift }, 40);
    expect(a.avgiftPerSqmMonth).toBeNull();
    expect(a.brfDebtPerSqm).toBeNull();
    const debtFree = candidateFactsSchema.parse({ brf: { debtPerSqm: 0 }, landLease: false });
    const b = hedonicInputOf({ ...base, facts: debtFree }, 40);
    expect(b.brfDebtPerSqm).toBe(0);
    expect(b.tomtratt).toBe(false);
  });

  it("a flat's known avgift and debt reach its predicted price; unknown ones are named in featuresImputed", () => {
    const priced = structuredClone(model);
    for (const f of priced.features) {
      if (f.name === "avgiftPerSqmMonth") {
        f.mean = 70;
        f.beta = -0.004;
        f.source = "fit";
      }
      if (f.name === "brfDebtPerSqm") {
        f.mean = 6000;
        f.beta = -0.00002;
        f.source = "fit";
      }
    }
    const known = candidateFactsSchema.parse({
      avgiftMonthlySek: 40 * 90,
      brf: { debtPerSqm: 10_000 },
      detailFetched: true,
    });
    const withFacts = { ...base, facts: known, candidate: { ...base.candidate, livingArea: 40, price: 4_000_000 } };
    const without = { ...withFacts, facts: null };
    const a = fitScore(withFacts, priced);
    const b = fitScore(without, priced);
    // 20 kr more avgift per m2 and 4 000 kr more debt per m2 than the mean: exp(-0.08 - 0.08) lower.
    expect(a.predKrPerSqm! / b.predKrPerSqm!).toBeCloseTo(Math.exp(-0.004 * 20 - 0.00002 * 4000), 9);
    expect(a.featuresImputed).not.toContain("avgiftPerSqmMonth");
    expect(a.featuresImputed).not.toContain("brfDebtPerSqm");
    expect(b.featuresImputed).toEqual(expect.arrayContaining(["avgiftPerSqmMonth", "brfDebtPerSqm"]));
  });
});

describe("days on market move the expected final price, never the resale value (VAL-03, D-02)", () => {
  const base = snapshot.rows[0];
  const domModel = structuredClone(model);
  domModel.bidPremium.terms.dom = {
    beta: -0.04,
    mean: 2.7,
    lnLo: 0,
    lnHi: 6,
    n: 800,
    kept: true,
    cvRmse: { without: 0.074, with: 0.073 },
    note: "med: korsvalidering 0,0740 -> 0,0730",
  };
  const withDays = (days: number | null): FitInputRow => ({
    ...base,
    facts: candidateFactsSchema.parse({ daysOnMarket: days, detailFetched: true }),
  });

  it("stores the overbid makeup and overbidPct is its pct for every comparable row", () => {
    for (const r of rankFit(snapshot.rows, model).ranked) {
      expect(r.overbidDetail).not.toBeNull();
      expect(r.overbidPct).toBe(r.overbidDetail!.pct);
    }
  });

  it("a not-comparable row has no overbid makeup", () => {
    const r = fitScore(rowWith(base, { price: null }), model);
    expect(r.overbidPct).toBeNull();
    expect(r.overbidDetail).toBeNull();
  });

  it("a longer listing lowers the expected final price when the term is kept, and leaves the resale value alone", () => {
    const fresh = fitScore(withDays(5), domModel);
    const stale = fitScore(withDays(90), domModel);
    expect(stale.overbidPct as number).toBeLessThan(fresh.overbidPct as number);
    expect(stale.purchaseSek as number).toBeLessThan(fresh.purchaseSek as number);
    expect(stale.overbidDetail!.domUsed).toBe(true);
    expect(stale.overbidDetail!.domDays).toBe(90);
    expect(stale.resaleSek).toBe(fresh.resaleSek);
    expect(stale.predKrPerSqm).toBe(fresh.predKrPerSqm);
  });

  it("unknown days change nothing against a model without the term", () => {
    const unknown = fitScore(withDays(null), domModel);
    const plain = fitScore(withDays(null), model);
    expect(unknown.overbidPct).toBeCloseTo(plain.overbidPct as number, 12);
    expect(unknown.overbidDetail!.label).toContain("dagar okända");
    expect(unknown.overbidDetail!.domUsed).toBe(false);
  });

  it("with the term absent from the model, days change nothing", () => {
    expect(fitScore(withDays(5), model).overbidPct).toBe(fitScore(withDays(90), model).overbidPct);
  });
});

describe("residual flag: further below the model than the features explain (R-04, VAL-04)", () => {
  const sd = model.residualSdLog;
  const limit = Math.exp(-RESIDUAL_FLAG_SD * sd);

  it("the default basis is the like-for-like one and the limit is two residual deviations", () => {
    expect(RESIDUAL_FLAG_BASIS).toBe("expectedFinal");
    expect(RESIDUAL_FLAG_SD).toBe(2);
  });

  it("residualFlagFires is strict on the expected-final basis: exactly on the limit does not fire, just below does", () => {
    const sdLog = 0.115;
    const onLimit = Math.exp(-2 * sdLog);
    expect(residualFlagFires("expectedFinal", { askToPred: 0.9, expectedFinalToPred: onLimit }, sdLog)).toBe(false);
    expect(residualFlagFires("expectedFinal", { askToPred: 0.9, expectedFinalToPred: onLimit * 0.999 }, sdLog)).toBe(true);
    // The asking ratio is ignored on this basis.
    expect(residualFlagFires("expectedFinal", { askToPred: 0.1, expectedFinalToPred: 1 }, sdLog)).toBe(false);
  });

  it("residualFlagFires is strict on the asking basis and ignores the expected-final ratio", () => {
    const sdLog = 0.115;
    const onLimit = Math.exp(-2 * sdLog);
    expect(residualFlagFires("asking", { askToPred: onLimit, expectedFinalToPred: 0.1 }, sdLog)).toBe(false);
    expect(residualFlagFires("asking", { askToPred: onLimit * 0.999, expectedFinalToPred: 1 }, sdLog)).toBe(true);
  });

  it("a flat asked at the model price is not flagged on either basis", () => {
    for (const basis of ["expectedFinal", "asking"] as const) {
      const r = fitScore(flat({ id: 181 }), model, { residualFlagBasis: basis });
      expect(r.flags).not.toContain("residualFlag");
    }
  });

  it("the two bases flag different rows: asked 22 % below the model fires on the asking basis only, 40 % below on both", () => {
    const mid = flat({ id: 182, askShareOfModel: 0.78 });
    const deep = flat({ id: 183, askShareOfModel: 0.6 });
    const midAsking = fitScore(mid, model, { residualFlagBasis: "asking" });
    const midFinal = fitScore(mid, model);
    expect(midAsking.askToPred as number).toBeLessThan(limit);
    expect(midAsking.flags).toContain("residualFlag");
    expect(midFinal.expectedFinalToPred as number).toBeGreaterThan(limit);
    expect(midFinal.flags).not.toContain("residualFlag");
    for (const basis of ["asking", "expectedFinal"] as const) {
      expect(fitScore(deep, model, { residualFlagBasis: basis }).flags).toContain("residualFlag");
    }
  });

  it("carries expectedFinalToPred and residualPct of the chosen basis; the flag changes no number", () => {
    const row = flat({ id: 184, askShareOfModel: 0.78 });
    const finalBasis = fitScore(row, model);
    const askingBasis = fitScore(row, model, { residualFlagBasis: "asking" });
    const perSqm = (finalBasis.purchaseSek as number) / (finalBasis.livingArea as number);
    expect(finalBasis.expectedFinalToPred).toBeCloseTo(perSqm / (finalBasis.predKrPerSqm as number), 9);
    expect(finalBasis.residualPct).toBeCloseTo((finalBasis.expectedFinalToPred as number) - 1, 9);
    expect(askingBasis.residualPct).toBeCloseTo((askingBasis.askToPred as number) - 1, 9);
    expect({ ...askingBasis, flags: [], residualPct: 0 }).toEqual({ ...finalBasis, flags: [], residualPct: 0 });
    expect(askingBasis.profitSek).toBe(finalBasis.profitSek);
  });

  it("a row that is not comparable for a missing price has no residual numbers", () => {
    const r = fitScore(rowWith(snapshot.rows[0], { price: null }), model);
    expect(r.expectedFinalToPred).toBeNull();
    expect(r.residualPct).toBeNull();
    expect(r.flags).not.toContain("residualFlag");
  });

  it("notComparable still fires below 0.5 of the model price and not at 0.5", () => {
    const half = modelPriceSek({}) * NOT_COMPARABLE_ASK_TO_PRED;
    const below = fitScore(flat({ id: 185, askSek: Math.floor(half * 0.98) }), model);
    const atLimit = fitScore(flat({ id: 186, askSek: Math.ceil(half) }), model);
    expect(NOT_COMPARABLE_ASK_TO_PRED).toBe(0.5);
    expect(below.comparable).toBe(false);
    expect(below.flags).toContain("notComparable");
    expect(atLimit.askToPred as number).toBeGreaterThanOrEqual(0.5);
    expect(atLimit.comparable).toBe(true);
    expect(atLimit.flags).not.toContain("notComparable");
  });

  it("residualFlagCounts counts both bases over the ranked rows and agrees with the flags", () => {
    const { ranked } = rankFit(snapshot.rows, model);
    const counts = residualFlagCounts(ranked, sd);
    expect(counts.n).toBe(ranked.length);
    expect(counts.primaryBasis).toBe(RESIDUAL_FLAG_BASIS);
    expect(counts.primary).toBe(ranked.filter((r) => r.flags.includes("residualFlag")).length);
    const asking = rankFit(snapshot.rows, model, { residualFlagBasis: "asking" }).ranked;
    expect(counts.other).toBe(asking.filter((r) => r.flags.includes("residualFlag")).length);
    // Asking prices sit below sold prices, so the asking basis never flags fewer rows.
    expect(counts.other).toBeGreaterThanOrEqual(counts.primary);
  });
});

// ---------------------------------------------------------------------------
// Phase 14.4 (LAY-01, LAY-02): the layout picks the facade of the sun
// ---------------------------------------------------------------------------

const streetLayout = (over: Partial<LayoutFact> = {}): LayoutFact => ({
  balconySide: "street",
  livingOnBalconySide: true,
  kitchenOnBalconySide: true,
  bedroomOnBalconySide: true,
  windowSides: "one",
  bedroomSide: "street",
  streetEvidence: "oppositeFacade",
  confidence: 0.9,
  source: "planritning+foto",
  version: "test-version",
  images: { booli: 4, broker: 0 },
  ...over,
});

describe("inferredSunWithLayout (14.4 LAY-02, D-09)", () => {
  // street south (best side, factor 0.95), courtyard north (no sun)
  const folk = footprintFact(sideHoursOf(dateHours(6.0, 5.7)), sideHoursOf(dateHours(0, 0)), 1);

  it("a usable street balcony keeps only the street side and becomes 'planritning'", () => {
    const r = inferredSunWithLayout(folk, streetLayout());
    expect(r.applied).toBe(true);
    expect(r.input?.source).toBe("planritning");
    expect(r.input?.sides).toHaveLength(1);
    expect(r.input?.sides[0].facade).toBe("south");
    expect(r.input?.confidence).toBe(1);
  });

  it("a usable courtyard balcony keeps the courtyard side", () => {
    const r = inferredSunWithLayout(folk, streetLayout({ balconySide: "courtyard", streetEvidence: "courtyardGreenery" }));
    expect(r.applied).toBe(true);
    expect(r.input?.sides.map((s) => s.facade)).toEqual(["north"]);
  });

  it("a stated facade, an unknown sun, no sun and an unusable layout return exactly inferredSunForTaste", () => {
    const stated: SunFact = {
      ...folk,
      source: "angiven",
      sides: [{ side: "angiven", facade: "west", bearingDeg: null, share: 1, point: null, hours: null }],
    };
    for (const sun of [stated, unknownSunFact("x"), null]) {
      const r = inferredSunWithLayout(sun, streetLayout());
      expect(r.applied).toBe(false);
      expect(r.input).toEqual(inferredSunForTaste(sun));
    }
    for (const layout of [null, streetLayout({ confidence: 0.59 }), streetLayout({ streetEvidence: "none" }), streetLayout({ balconySide: "none" }), streetLayout({ balconySide: "unknown" })]) {
      const r = inferredSunWithLayout(folk, layout);
      expect(r.applied).toBe(false);
      expect(r.input).toEqual(inferredSunForTaste(folk));
    }
  });

  it("a footprint fact without the matching side is left as 14.3 had it", () => {
    const streetOnly: SunFact = { ...folk, sides: [folk.sides[0]] };
    const r = inferredSunWithLayout(streetOnly, streetLayout({ balconySide: "courtyard", streetEvidence: "courtyardGreenery" }));
    expect(r.applied).toBe(false);
    expect(r.input).toEqual(inferredSunForTaste(streetOnly));
  });
});

describe("a layout fact inside fitScore (14.4 LAY-02)", () => {
  const folk = footprintFact(sideHoursOf(dateHours(6.0, 5.7)), sideHoursOf(dateHours(0, 0)), 1);

  it("the sun part of taste doubles (the 0,5 street-only factor becomes 1); everything else is equal", () => {
    const row = { ...flat({ facades: null }), sun: folk };
    const without = fitScore(row, model);
    const withLayout = fitScore({ ...row, layout: streetLayout() }, model);
    expect(without.layoutAppliedToSun).toBe(false);
    expect(withLayout.layoutAppliedToSun).toBe(true);
    expect(withLayout.tasteSunPct).toBeCloseTo(2 * without.tasteSunPct, 12);
    expect(withLayout.tasteSunPct).toBeGreaterThan(0);
    // The same price, resale, flags and hub part; the profit differs by the taste part only.
    expect(withLayout.resaleSek).toBe(without.resaleSek);
    expect(withLayout.purchaseSek).toBe(without.purchaseSek);
    expect(withLayout.tasteHubPct).toBe(without.tasteHubPct);
    expect(withLayout.flags).toEqual(without.flags);
    expect(withLayout.layout).toEqual(streetLayout());
  });

  it("an unusable layout scores exactly as a row without one", () => {
    const row = { ...flat({ facades: null }), sun: folk };
    const base = fitScore(row, model);
    const weak = fitScore({ ...row, layout: streetLayout({ confidence: 0.59 }) }, model);
    expect(weak.tasteSek).toBe(base.tasteSek);
    expect(weak.profitSek).toBe(base.profitSek);
    expect(weak.layoutAppliedToSun).toBe(false);
  });

  it("the result carries the layout and the applied flag on the not-comparable path too", () => {
    const row = { ...flat({ facades: null }), sun: folk, layout: streetLayout() };
    const noPrice = fitScore({ ...row, candidate: { ...row.candidate, price: null } }, model);
    expect(noPrice.comparable).toBe(false);
    expect(noPrice.layout).toEqual(streetLayout());
    expect(noPrice.layoutAppliedToSun).toBe(true);
  });
});

describe("korsdrag and a quiet bedroom in taste (14.4 LAY-03, D-10)", () => {
  const both = (over: Partial<LayoutFact> = {}) =>
    streetLayout({ windowSides: "twoOpposite", bedroomSide: "courtyard", ...over });

  it("TASTE_CAP_PCT is still 5 %", () => {
    expect(TASTE_CAP_PCT).toBe(0.05);
  });

  it("below the cap, both terms add exactly 2 % of the resale value", () => {
    const row = flat({ facades: null });
    const without = fitScore(row, model);
    const withBoth = fitScore({ ...row, layout: both() }, model);
    expect(withBoth.tasteKorsdragPct).toBe(0.01);
    expect(withBoth.tasteQuietBedroomPct).toBe(0.01);
    expect(without.tasteKorsdragPct).toBe(0);
    expect(without.tasteQuietBedroomPct).toBe(0);
    expect(without.tasteSek).toBeLessThan(0.05 * (without.resaleSek as number) - 0.02 * (without.resaleSek as number));
    expect((withBoth.tasteSek as number) - (without.tasteSek as number)).toBeCloseTo(0.02 * (withBoth.resaleSek as number), 4);
  });

  it("a street bedroom and one window side add nothing (this is the Folkungagatan 61 layout)", () => {
    const row = flat({ facades: null });
    const r = fitScore({ ...row, layout: streetLayout() }, model);
    expect(r.tasteKorsdragPct).toBe(0);
    expect(r.tasteQuietBedroomPct).toBe(0);
    expect(r.tasteSek).toBe(fitScore(row, model).tasteSek);
  });

  it("an unusable layout (confidence 0,59) adds nothing", () => {
    const row = flat({ facades: null });
    const r = fitScore({ ...row, layout: both({ confidence: 0.59 }) }, model);
    expect(r.tasteKorsdragPct).toBe(0);
    expect(r.tasteQuietBedroomPct).toBe(0);
    expect(r.tasteSek).toBe(fitScore(row, model).tasteSek);
  });

  it("a row whose taste would pass 5 % still gets exactly 5 % of resale (the cap binds)", () => {
    // east (full sun part 3 %) + a hub within 300 m (2 %) = 5 % already; the two terms would make it 7 %.
    const row = { ...flat({ facades: ["east"] }), layout: both() };
    const r = fitScore(row, model);
    expect(r.tasteSunPct + r.tasteHubPct + r.tasteKorsdragPct + r.tasteQuietBedroomPct).toBeGreaterThan(0.05);
    expect(r.tasteSek).toBeCloseTo(TASTE_CAP_PCT * (r.resaleSek as number), 4);
  });

  it("the not-comparable branch carries 0 for both", () => {
    const row = { ...flat({ facades: null }), layout: both() };
    const noPrice = fitScore({ ...row, candidate: { ...row.candidate, price: null } }, model);
    expect(noPrice.tasteKorsdragPct).toBe(0);
    expect(noPrice.tasteQuietBedroomPct).toBe(0);
  });
});

describe("rowsAtTasteCap (14.4 R-09)", () => {
  it("counts the rows whose uncapped taste share reaches 5 %, out of the rows looked at", () => {
    const east = fitScore({ ...flat({ facades: ["east"] }), layout: null }, model); // 3 % sun + 2 % hub = 5 %
    const plain = fitScore(flat({ facades: null }), model); // hub only
    const boosted = fitScore(
      { ...flat({ facades: null }), layout: streetLayout({ windowSides: "twoOpposite", bedroomSide: "courtyard" }) },
      model,
    ); // hub 2 % + 2 % = 4 %: below the cap
    expect(rowsAtTasteCap([east, plain, boosted])).toEqual({ reached: 1, of: 3 });
    expect(rowsAtTasteCap([])).toEqual({ reached: 0, of: 0 });
  });
});

describe("snapshot row layout (R-08, Phase 14.4)", () => {
  it("the committed fixture has no layout record: every row reads null", () => {
    for (const row of snapshot.rows) expect(row.layout).toBeNull();
  });

  it("a stored value that does not match the current schema reads null and the snapshot still parses", () => {
    const raw = JSON.parse(JSON.stringify(snapshot));
    raw.rows[0].layout = { junk: 1 };
    raw.rows[1].layout = "street";
    raw.rows[2].layout = { ...streetLayout(), source: "gissning" };
    delete raw.rows[3].layout;
    const parsed = parseFitSnapshot(raw);
    expect(parsed.rows.slice(0, 4).map((r) => r.layout)).toEqual([null, null, null, null]);
    expect(parsed.rows).toHaveLength(snapshot.rows.length);
  });

  it("a valid record round-trips through JSON", () => {
    const withLayout = { ...snapshot, rows: snapshot.rows.map((r, i) => (i === 0 ? { ...r, layout: streetLayout() } : r)) };
    const reparsed = parseFitSnapshot(JSON.parse(JSON.stringify(withLayout)));
    expect(reparsed.rows[0].layout).toEqual(streetLayout());
    expect(reparsed.rows[1].layout).toBeNull();
  });
});

describe("Folkungagatan 61 layout fixture (LAY-04 plumbing, D-11)", () => {
  const fixture = parseFitSnapshot(folkungagatanFixtureJson);

  it("is one real row with the hand-written truth: balcony street, windows one side, bedroom street", () => {
    expect(fixture.rows).toHaveLength(1);
    const row = fixture.rows[0];
    expect(booliIdOf(row.candidate)).toBe(FOLKUNGAGATAN_ID);
    expect(row.sun).toBeNull();
    expect(row.layout).not.toBeNull();
    expect(row.layout?.balconySide).toBe("street");
    expect(row.layout?.windowSides).toBe("one");
    expect(row.layout?.bedroomSide).toBe("street");
    expect(row.layout?.streetEvidence).toBe("oppositeFacade");
    expect(row.layout?.confidence).toBe(0.9);
  });
});

describe("ceiling height facts reach the result (14.5 CEIL-01)", () => {
  it("a snapshot row whose facts lack the three keys parses with all three null (old snapshots still load)", () => {
    const raw = JSON.parse(JSON.stringify(snapshot));
    raw.rows[0].facts = { tenureForm: "Bostadsrätt" };
    const parsed = parseFitSnapshot(raw);
    expect(parsed.rows[0].facts?.ceilingHeightM).toBeNull();
    expect(parsed.rows[0].facts?.ceilingSource).toBeNull();
    expect(parsed.rows[0].facts?.tallCeilingPhrase).toBeNull();
  });

  it("the result copies ceilingHeightM and tallCeilingPhrase from row.facts, and reads null/null without facts", () => {
    const row = flat({ facades: null });
    const facts = candidateFactsSchema.parse({ ceilingHeightM: 3.2, ceilingSource: "angiven", tallCeilingPhrase: false });
    const withFacts = fitScore({ ...row, facts }, model);
    expect(withFacts.comparable).toBe(true);
    expect(withFacts.ceilingHeightM).toBe(3.2);
    expect(withFacts.tallCeilingPhrase).toBe(false);
    const without = fitScore({ ...row, facts: null }, model);
    expect(without.ceilingHeightM).toBeNull();
    expect(without.tallCeilingPhrase).toBeNull();
  });

  it("the not-comparable branch carries the same two values", () => {
    const row = flat({ facades: null });
    const facts = candidateFactsSchema.parse({ ceilingHeightM: 3.2, ceilingSource: "angiven", tallCeilingPhrase: true });
    const noPrice = fitScore({ ...row, facts, candidate: { ...row.candidate, price: null } }, model);
    expect(noPrice.comparable).toBe(false);
    expect(noPrice.ceilingHeightM).toBe(3.2);
    expect(noPrice.tallCeilingPhrase).toBe(true);
  });

  it("a stored ceiling fact changes taste and profit only; price, resale, credit and flags are the same", () => {
    const row = flat({ facades: null });
    const facts = candidateFactsSchema.parse({ ceilingHeightM: 3.6, ceilingSource: "angiven", tallCeilingPhrase: false });
    const a = fitScore(row, model);
    const b = fitScore({ ...row, facts }, model);
    expect(b.resaleSek).toBe(a.resaleSek);
    expect(b.purchaseSek).toBe(a.purchaseSek);
    expect(b.creditSek).toBe(a.creditSek);
    expect(b.flags).toEqual(a.flags);
    expect(b.tasteSek).toBeGreaterThan(a.tasteSek);
  });
});

describe("ceiling height in taste (14.5 D-07, CEIL-02)", () => {
  const factsOf = (ceilingHeightM: number | null, tallCeilingPhrase: boolean | null = null) =>
    candidateFactsSchema.parse({ ceilingHeightM, ceilingSource: ceilingHeightM === null ? null : "angiven", tallCeilingPhrase });

  it("TASTE_CAP_PCT is still 5 %", () => {
    expect(TASTE_CAP_PCT).toBe(0.05);
  });

  it("a stated 3,2 m adds 1 % of resale below the cap (hub 2 % + ceiling 1 %)", () => {
    const row = flat({ facades: null });
    const without = fitScore(row, model);
    const tall = fitScore({ ...row, facts: factsOf(3.2) }, model);
    expect(tall.tasteCeilingPct).toBe(0.01);
    expect(without.tasteCeilingPct).toBe(0);
    expect((tall.tasteSek as number) - (without.tasteSek as number)).toBeCloseTo(0.01 * (tall.resaleSek as number), 4);
  });

  it("a stated 3,6 m adds 2 % of resale below the cap", () => {
    const row = flat({ facades: null });
    const without = fitScore(row, model);
    const tall = fitScore({ ...row, facts: factsOf(3.6) }, model);
    expect(tall.tasteCeilingPct).toBe(0.02);
    expect((tall.tasteSek as number) - (without.tasteSek as number)).toBeCloseTo(0.02 * (tall.resaleSek as number), 4);
    expect((tall.profitSek as number) - (without.profitSek as number)).toBeCloseTo(0.02 * (tall.resaleSek as number), 4);
  });

  it("unknown, a 'högt i tak' flag without a number, and a low height add nothing", () => {
    const row = flat({ facades: null });
    const base = fitScore(row, model);
    for (const facts of [null, factsOf(null, null), factsOf(null, true), factsOf(null, false), factsOf(2.7)]) {
      const r = fitScore({ ...row, facts }, model);
      expect(r.tasteCeilingPct).toBe(0);
      expect(r.tasteSek).toBe(base.tasteSek);
    }
  });

  it("a row already at 4,5 % taste with 3,6 m is clamped to exactly 5 % of resale", () => {
    // hub within 300 m (2 %) + east sun (3 %) = 5 % already; the ceiling would make it 7 %.
    const row = { ...flat({ facades: ["east"] }), facts: factsOf(3.6) };
    const r = fitScore(row, model);
    expect(r.tasteSunPct + r.tasteHubPct + r.tasteKorsdragPct + r.tasteQuietBedroomPct + r.tasteCeilingPct).toBeGreaterThan(0.05);
    expect(r.tasteSek).toBeCloseTo(TASTE_CAP_PCT * (r.resaleSek as number), 4);
  });

  it("a row at 4 % taste is lifted to the 5 % cap by 1 % of ceiling, not past it", () => {
    const row = {
      ...flat({ facades: null }),
      layout: streetLayout({ windowSides: "twoOpposite", bedroomSide: "courtyard" }), // hub 2 % + 2 % = 4 %
      facts: factsOf(3.0),
    };
    const r = fitScore(row, model);
    expect(r.tasteCeilingPct).toBe(0.01);
    expect(r.tasteSek).toBeCloseTo(0.05 * (r.resaleSek as number), 4);
  });

  it("the not-comparable branch carries 0", () => {
    const row = { ...flat({ facades: null }), facts: factsOf(3.6) };
    const noPrice = fitScore({ ...row, candidate: { ...row.candidate, price: null } }, model);
    expect(noPrice.comparable).toBe(false);
    expect(noPrice.tasteCeilingPct).toBe(0);
    expect(noPrice.ceilingHeightM).toBe(3.6);
  });

  it("rowsAtTasteCap counts a row that reaches 5 % only because of the ceiling term", () => {
    const layout = streetLayout({ windowSides: "twoOpposite", bedroomSide: "courtyard" }); // hub 2 % + 2 % = 4 %
    const below = fitScore({ ...flat({ facades: null }), layout }, model);
    const lifted = fitScore({ ...flat({ facades: null }), layout, facts: factsOf(3.2) }, model);
    expect(rowsAtTasteCap([below])).toEqual({ reached: 0, of: 1 });
    expect(rowsAtTasteCap([lifted])).toEqual({ reached: 1, of: 1 });
  });
});

describe("building facts reach the result and the stambyte input (14.6 STAM-03, FLAG-01, FLAG-02, D-07)", () => {
  const cityFacts = candidateFactsSchema.parse({
    stambyteStatus: "genomfort",
    lastStambyteYear: 2006,
    plannedStambyteYear: 2027,
    stambyteSource: "bygglov_stockholm",
    cityStambyte: { lastYear: 2006, basis: "slutbesked", ongoing: false, relining: false },
    byggarenden: [{ kind: "vind_inredning", month: "2023-10", decision: "slutbesked", slutbeskedMonth: "2024-02", diarie: null }],
    balkongBeviljadEjByggd: true,
    balkongInglasningAnsokt: false,
    areaSource: "forening",
    areaMeasuredYear: null,
  });

  it("WR-04: the basis travels with the city's year, and is null when the shown year is not the city's", () => {
    const unopened = candidateFactsSchema.parse({ ...cityFacts, cityStambyte: { lastYear: 2006, basis: "ärendestart", ongoing: false, relining: false } });
    expect(fitScore({ ...flat({ facades: null }), facts: unopened }, model).lastStambyteBasis).toBe("ärendestart");
    const textYear = candidateFactsSchema.parse({ ...unopened, lastStambyteYear: 2012 });
    expect(fitScore({ ...flat({ facades: null }), facts: textYear }, model).lastStambyteBasis).toBeNull();
    expect(fitScore(flat({ facades: null }), model).lastStambyteBasis).toBeNull();
  });

  it("the result copies the stambyte, byggärenden, balcony and area facts from row.facts, and the construction year from the candidate", () => {
    const row = { ...flat({ facades: null }), facts: cityFacts };
    const r = fitScore(row, model);
    expect(r.stambyteStatus).toBe("genomfort");
    expect(r.lastStambyteYear).toBe(2006);
    expect(r.lastStambyteBasis).toBe("slutbesked");
    expect(r.plannedStambyteYear).toBe(2027);
    expect(r.stambyteSource).toBe("bygglov_stockholm");
    expect(r.byggarenden).toEqual(cityFacts.byggarenden);
    expect(r.balkongBeviljadEjByggd).toBe(true);
    expect(r.balkongInglasningAnsokt).toBe(false);
    expect(r.areaSource).toBe("forening");
    expect(r.areaMeasuredYear).toBeNull();
    expect(r.constructionYear).toBe(row.candidate.constructionYear);
  });

  it("without facts every new field is null and the not-comparable branch carries the same values", () => {
    const row = flat({ facades: null });
    const none = fitScore({ ...row, facts: null }, model);
    for (const key of [
      "stambyteStatus",
      "lastStambyteYear",
      "plannedStambyteYear",
      "stambyteSource",
      "byggarenden",
      "balkongBeviljadEjByggd",
      "balkongInglasningAnsokt",
      "areaSource",
      "areaMeasuredYear",
    ] as const) {
      expect(none[key], key).toBeNull();
    }
    const noPrice = fitScore({ ...row, facts: cityFacts, candidate: { ...row.candidate, price: null } }, model);
    expect(noPrice.comparable).toBe(false);
    expect(noPrice.lastStambyteYear).toBe(2006);
    expect(noPrice.areaSource).toBe("forening");
  });

  it("hedonicInputOf passes the stambyte input: identified = the city list was read, years since the city's latest stambyte, ongoing", () => {
    const row = { ...flat({ facades: null }), facts: cityFacts };
    expect(hedonicInputOf(row, 40, 2026).stambyte).toEqual({ identified: true, yearsSince: 20, ongoing: false });
    // No run year given: a recorded stambyte has no age, never a guessed one.
    expect(hedonicInputOf(row, 40).stambyte).toEqual({ identified: true, yearsSince: null, ongoing: false });
    // A stambyte year after the run year reads as zero years, never negative.
    expect(hedonicInputOf(row, 40, 2005).stambyte?.yearsSince).toBe(0);
    // A list that was read and showed nothing: the building is known, it has no stambyte on record.
    const emptyList = candidateFactsSchema.parse({ byggarenden: [], cityStambyte: { lastYear: null, basis: null, ongoing: false, relining: false } });
    expect(hedonicInputOf({ ...row, facts: emptyList }, 40, 2026).stambyte).toEqual({ identified: true, yearsSince: null, ongoing: false });
    // The city list was never read (broker text only): the building is unknown to the model.
    const textOnly = candidateFactsSchema.parse({ stambyteStatus: "genomfort", lastStambyteYear: 2019, textStambyte: { lastYear: 2019, plannedYear: null, ongoing: false, relining: false } });
    expect(hedonicInputOf({ ...row, facts: textOnly }, 40, 2026).stambyte).toEqual({ identified: false, yearsSince: null, ongoing: null });
    expect(hedonicInputOf({ ...row, facts: null }, 40, 2026).stambyte).toBeNull();
  });
});

describe("no number changes: the building facts are information only (14.6 D-08, D-09, D-07)", () => {
  const folkungagatan = parseFitSnapshot(folkungagatanFixtureJson);
  const row = folkungagatan.rows[0];
  const committed = parseHedonicModel(JSON.parse(readFileSync(join(process.cwd(), "data/hedonic-model.json"), "utf-8")));

  /** Every new fact set, as a broker text and the city's list would leave it. */
  const loud = candidateFactsSchema.parse({
    ...(row.facts ?? {}),
    stambyteStatus: "planerat",
    lastStambyteYear: 2006,
    plannedStambyteYear: 2027,
    stambyteSource: "bygglov_stockholm",
    cityStambyte: { lastYear: 2006, basis: "slutbesked", ongoing: false, relining: true },
    byggarenden: [
      { kind: "balkong_ny", month: "2026-03", decision: "beviljad", slutbeskedMonth: null, diarie: "2026-001" },
      { kind: "balkong_inglasning", month: "2026-09", decision: "ansokt", slutbeskedMonth: null, diarie: null },
    ],
    balkongBeviljadEjByggd: true,
    balkongInglasningAnsokt: true,
    areaSource: "forening",
    areaMeasuredYear: null,
    areaMeasuredFirm: null,
  });
  /** The same facts with every one of those fields null. */
  const quiet = candidateFactsSchema.parse({
    ...(row.facts ?? {}),
    stambyteStatus: null,
    lastStambyteYear: null,
    plannedStambyteYear: null,
    stambyteSource: null,
    cityStambyte: null,
    byggarenden: null,
    balkongBeviljadEjByggd: null,
    balkongInglasningAnsokt: null,
    areaSource: null,
    areaMeasuredYear: null,
    areaMeasuredFirm: null,
  });
  const numbers = (r: FitScoreResult) => ({
    predKrPerSqm: r.predKrPerSqm,
    resaleSek: r.resaleSek,
    purchaseSek: r.purchaseSek,
    overbidPct: r.overbidPct,
    gapSek: r.gapSek,
    creditSek: r.creditSek,
    renoSek: r.renoSek,
    tasteSek: r.tasteSek,
    tasteSunPct: r.tasteSunPct,
    tasteHubPct: r.tasteHubPct,
    tasteCeilingPct: r.tasteCeilingPct,
    profitSek: r.profitSek,
    residualPct: r.residualPct,
    flags: r.flags,
    featuresImputed: r.featuresImputed,
  });

  it("no number changes with balcony flags, byggärenden, area source and the upside: profit, taste, resale, purchase, flags and rank are identical", () => {
    for (const m of [model, committed]) {
      const a = fitScore({ ...row, facts: loud }, m, { asOfYear: 2026 });
      const b = fitScore({ ...row, facts: quiet }, m, { asOfYear: 2026 });
      expect(a.comparable).toBe(true);
      expect(numbers(a)).toEqual(numbers(b));
      // The facts themselves do arrive in the result.
      expect(a.areaSource).toBe("forening");
      expect(b.areaSource).toBeNull();
    }
    // Rank: the same two flats come out in the same order with and without the facts.
    const other = flat({ id: 777_001, askShareOfModel: 0.8 });
    const withFacts = rankFit([{ ...row, facts: loud }, other], committed, { asOfYear: 2026 }).ranked.map((r) => r.address);
    const without = rankFit([{ ...row, facts: quiet }, other], committed, { asOfYear: 2026 }).ranked.map((r) => r.address);
    expect(withFacts).toEqual(without);
    // The free pre-rank reads the same numbers.
    expect(preRank([{ ...row, facts: loud }], committed, { asOfYear: 2026 }).ranked[0].pre.profitSek).toBe(
      preRank([{ ...row, facts: quiet }], committed, { asOfYear: 2026 }).ranked[0].pre.profitSek,
    );
  });

  it("no number changes under the committed model (it has no stambyte term): the stambyte input is read and ignored", () => {
    expect(committed.stambyteTerm).toBeUndefined();
    const a = fitScore({ ...row, facts: loud }, committed, { asOfYear: 2026 });
    const b = fitScore({ ...row, facts: quiet }, committed, { asOfYear: 2026 });
    expect(a.predKrPerSqm).toBe(b.predKrPerSqm);
    expect(a.featuresImputed).toEqual(b.featuresImputed);
    expect(a.featuresImputed).not.toContain("stambyte");
  });

  describe("with a model whose stambyte term is kept", () => {
    const buckets = [
      { fromYears: 0, toYears: 10, pct: 0.024, se: 0.013, n: 83 },
      { fromYears: 11, toYears: 15, pct: -0.018, se: 0.01, n: 145 },
      { fromYears: 16, toYears: 25, pct: 0.012, se: 0.004, n: 850 },
      { fromYears: 26, toYears: 40, pct: 0.01, se: 0.003, n: 1316 },
    ];
    const termOf = (kept: boolean) => ({
      kept,
      edges: [10, 15, 25, 40],
      nominalEdges: [5, 15, 40],
      buckets,
      reference: { pct: -0.003, se: 0.002, n: 4927 },
      ongoing: null,
      nominalCounts: [5, 223, 2166],
      cvRmse: { without: 0.1078, with: 0.1077 },
      note: "testmodell",
    });
    const keptModel = parseHedonicModel({ ...JSON.parse(JSON.stringify(committed)), stambyteTerm: termOf(true) });
    const droppedModel = parseHedonicModel({ ...JSON.parse(JSON.stringify(committed)), stambyteTerm: termOf(false) });
    const plain = fitScore({ ...row, facts: loud }, committed, { asOfYear: 2026 });

    it("a row in a fitted bucket changes predKrPerSqm by that bucket's pct (20 years since 2006: the 16-25 bucket)", () => {
      const r = fitScore({ ...row, facts: loud }, keptModel, { asOfYear: 2026 });
      expect((r.predKrPerSqm as number) / (plain.predKrPerSqm as number)).toBeCloseTo(1.012, 12);
      expect(r.featuresImputed).not.toContain("stambyte");
      // Another year, another bucket: 4 years since is the first bucket.
      const young = fitScore({ ...row, facts: loud }, keptModel, { asOfYear: 2010 });
      expect((young.predKrPerSqm as number) / (plain.predKrPerSqm as number)).toBeCloseTo(1.024, 12);
    });

    it("a building with no stambyte on record gets the reference group's value; a building whose list was never read gets no change and says so", () => {
      const none = candidateFactsSchema.parse({ ...(row.facts ?? {}), byggarenden: [], cityStambyte: { lastYear: null, basis: null, ongoing: false, relining: false } });
      const known = fitScore({ ...row, facts: none }, keptModel, { asOfYear: 2026 });
      expect((known.predKrPerSqm as number) / (plain.predKrPerSqm as number)).toBeCloseTo(0.997, 12);
      const unknown = fitScore({ ...row, facts: quiet }, keptModel, { asOfYear: 2026 });
      expect(unknown.predKrPerSqm).toBe(plain.predKrPerSqm);
      expect(unknown.featuresImputed).toContain("stambyte");
    });

    it("a term that is not kept moves nothing", () => {
      const r = fitScore({ ...row, facts: loud }, droppedModel, { asOfYear: 2026 });
      expect(r.predKrPerSqm).toBe(plain.predKrPerSqm);
      expect(r.featuresImputed).toEqual(plain.featuresImputed);
    });

    it("the balcony flags, byggärenden and area still change no number under the kept term", () => {
      const a = fitScore({ ...row, facts: loud }, keptModel, { asOfYear: 2026 });
      // Same stambyte history, none of the flag/area facts.
      const onlyStambyte = candidateFactsSchema.parse({
        ...loud,
        byggarenden: [],
        balkongBeviljadEjByggd: null,
        balkongInglasningAnsokt: null,
        areaSource: null,
      });
      const b = fitScore({ ...row, facts: onlyStambyte }, keptModel, { asOfYear: 2026 });
      expect(numbers(a)).toEqual(numbers(b));
    });
  });
});

describe("the script keeps the replay offline while it gains the city columns (14.6 R-01, FIT-06)", () => {
  const script = readFileSync(join(process.cwd(), "scripts/fit-score.ts"), "utf-8");
  const staticImports = script.split("\n").filter((l) => /^import /.test(l));

  it("loads the city client, Min Karta and the city stage only by dynamic import", () => {
    expect(staticImports.filter((l) => /stockholm\/(bygglov-client|minkarta|city-stage|host-gate)/.test(l))).toEqual([]);
    expect(script).toContain('await import("@/lib/stockholm/city-stage")');
    expect(script).toContain('await import("@/lib/stockholm/bygglov-client")');
    expect(script).toContain('await import("@/lib/stockholm/minkarta")');
  });

  it("knows the three new flags, and the live-only ones are refused together with --replay", () => {
    for (const flag of ["--city-cache", "--no-city", "--area-audit"]) expect(script).toContain(`"${flag}"`);
    expect(script).toMatch(/--no-city"\) \{ out\.noCity = true; liveOnly = true; \}/);
    expect(script).toMatch(/--area-audit"\) \{ out\.areaAudit = true; liveOnly = true; \}/);
    // --city-cache is allowed with both modes: it is not a live-only flag.
    expect(script).toMatch(/--city-cache" && value !== undefined && value !== ""\) \{ out\.cityCache = value; i\+\+; \}/);
  });
});
