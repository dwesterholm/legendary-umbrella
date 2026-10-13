// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import snapshotJson from "@/lib/discovery/__fixtures__/forsale-snapshot.fixture.json";
import modelJson from "@/lib/discovery/__fixtures__/hedonic-model.fixture.json";
import {
  EXPECTED_FINAL_CEILING_SEK,
  FIT_VISION_WINDOW,
  MAX_CREDIT_PCT,
  MODEL_HEALTH_BAND,
  NOT_COMPARABLE_ASK_TO_PRED,
  TASTE_CAP_PCT,
  booliIdOf,
  cappedTasteSek,
  clearlyWorseAbove,
  compareFinal,
  comparePreRank,
  fitScore,
  modelHealth,
  parseFitSnapshot,
  preRank,
  rankFit,
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
import { RENO_BAND, UNKNOWN_RENO_STATES, renoBundle } from "@/lib/discovery/reno-tier";
import { LOVED_HUBS, tasteBonus } from "@/lib/discovery/taste";
import type { VisionConditionClaim, VisionResult } from "@/lib/discovery/vision-schema";

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

  it("credit never exceeds MAX_CREDIT_PCT of the resale value, and equals the smaller of gap and cap", () => {
    for (const r of ranked) {
      const cap = MAX_CREDIT_PCT * (r.resaleSek as number);
      expect(r.creditSek as number).toBeLessThanOrEqual(cap + 1e-6);
      expect(r.creditSek).toBeCloseTo(Math.min(r.gapSek as number, cap), 6);
    }
  });

  it("flags creditCapped exactly when the cap binds", () => {
    for (const r of ranked) {
      const binds = (r.gapSek as number) > MAX_CREDIT_PCT * (r.resaleSek as number);
      expect(r.flags.includes("creditCapped")).toBe(binds);
    }
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
    expect(reno.flags).toContain("creditCapped");
    expect(reno.profitSek as number).toBeGreaterThan(bal.profitSek as number);
    expect(ranked.map((r) => r.booliId)).toEqual([101, 102]);
  });

  it("D-07 regression: the cap binds for the reno object, and its credit is the capped amount", () => {
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
    expect(r.creditSek).toBeCloseTo(MAX_CREDIT_PCT * (r.resaleSek as number), 6);
    expect(r.gapSek as number).toBeGreaterThan(r.creditSek as number);
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

  it("#6 a flat 40 % below the model gets hiddenDefectRisk and creditCapped; one 15 % below gets neither (D-15 #6)", () => {
    const deep = fitScore(flat({ id: 151, askShareOfModel: 0.6 }), model);
    const mild = fitScore(flat({ id: 152, askShareOfModel: 0.85 }), model);
    expect(deep.flags).toContain("hiddenDefectRisk");
    expect(deep.flags).toContain("creditCapped");
    expect(mild.flags).not.toContain("hiddenDefectRisk");
    expect(mild.flags).not.toContain("creditCapped");
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
