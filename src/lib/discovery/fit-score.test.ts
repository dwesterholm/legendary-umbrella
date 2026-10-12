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
  NOT_COMPARABLE_ASK_TO_PRED,
  booliIdOf,
  fitScore,
  parseFitSnapshot,
  rankFit,
  type FitInputRow,
} from "@/lib/discovery/fit-score";
import { parseHedonicModel } from "@/lib/discovery/hedonic-model";
import { CGT_EFFECTIVE_RATE, RENO_COST_MATRIX } from "@/lib/discovery/flip-economics";
import { RENO_BAND, UNKNOWN_RENO_STATES, renoBundle } from "@/lib/discovery/reno-tier";

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
