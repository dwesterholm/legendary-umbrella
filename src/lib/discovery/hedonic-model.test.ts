import { describe, it, expect } from "vitest";
import modelJson from "@/lib/discovery/__fixtures__/hedonic-model.fixture.json";
import {
  CENTRALITY_HUBS,
  buildFeatureRow,
  choleskySolve,
  expectedOverbid,
  fitRidge,
  haversineMeters,
  hedonicModelSchema,
  kernelLevel,
  parseHedonicModel,
  predictKrPerSqm,
  predictLnKrPerSqm,
  renovatedCapKrPerSqm,
  type HedonicInput,
  type HedonicModel,
} from "@/lib/discovery/hedonic-model";

/**
 * hedonic-model.test.ts - the persisted model shape and its prediction
 * (Phase 14.1, T-14.1-06, R-12). The fixture is a SYNTHETIC stub, so these
 * tests prove the mechanics, not any real price.
 */

const model = parseHedonicModel(modelJson);

/** A plain mutable copy of the fixture to break one field at a time. */
function broken(mutate: (m: Record<string, unknown>) => void): unknown {
  const copy = structuredClone(modelJson) as unknown as Record<string, unknown>;
  mutate(copy);
  return copy;
}

const FOLKUNGAGATAN: HedonicInput = {
  district: "Södermalm",
  latitude: 59.3148,
  longitude: 18.0768,
  floor: 5,
  livingArea: 35,
  balcony: false,
  constructionYear: null,
};

describe("hedonicModelSchema / parseHedonicModel (T-14.1-06)", () => {
  it("parses the synthetic fixture", () => {
    expect(hedonicModelSchema.safeParse(modelJson).success).toBe(true);
    expect(model.minLivingArea).toBe(35);
    expect(model.maxLivingArea).toBe(80);
    expect(model.kernel.points.length).toBeGreaterThanOrEqual(40);
  });

  it("rejects a model with the intercept deleted", () => {
    expect(() => parseHedonicModel(broken((m) => delete m.intercept))).toThrow(/intercept/);
  });

  it("rejects a model with a NaN coefficient", () => {
    const bad = broken((m) => {
      (m.features as { beta: number }[])[0].beta = Number.NaN;
    });
    expect(() => parseHedonicModel(bad)).toThrow(/features/);
  });

  it("rejects a model with an infinite coefficient", () => {
    const bad = broken((m) => {
      (m.features as { beta: number }[])[1].beta = Number.POSITIVE_INFINITY;
    });
    expect(() => parseHedonicModel(bad)).toThrow();
  });

  it("rejects smearing below 1", () => {
    expect(() => parseHedonicModel(broken((m) => (m.smearing = 0.9)))).toThrow(/smearing/);
  });

  it("rejects a model with minLivingArea deleted (R-12)", () => {
    expect(() => parseHedonicModel(broken((m) => delete m.minLivingArea))).toThrow(/minLivingArea/);
  });

  it("rejects maxLivingArea below minLivingArea (R-12)", () => {
    expect(() => parseHedonicModel(broken((m) => (m.maxLivingArea = 30)))).toThrow(/maxLivingArea/);
  });

  it("rejects a model that leaves out one of the six features", () => {
    const bad = broken((m) => {
      m.features = (m.features as { name: string }[]).filter((f) => f.name !== "lnArea");
    });
    expect(() => parseHedonicModel(bad)).toThrow(/features/);
  });

  it("rejects a model missing one district's bid premium", () => {
    const bad = broken((m) => {
      delete ((m.bidPremium as { perDistrict: Record<string, unknown> }).perDistrict)["Östermalm"];
    });
    expect(() => parseHedonicModel(bad)).toThrow();
  });

  it("rejects something that is not an object", () => {
    expect(() => parseHedonicModel(null)).toThrow(/Invalid hedonic model/);
  });
});

describe("haversineMeters", () => {
  it("Slussen to Medborgarplatsen is about 640 m", () => {
    const d = haversineMeters(59.32, 18.0718, 59.3143, 18.0735);
    expect(d).toBeGreaterThan(600);
    expect(d).toBeLessThan(700);
  });

  it("a point is zero metres from itself", () => {
    expect(haversineMeters(59.3, 18.0, 59.3, 18.0)).toBe(0);
  });
});

describe("kernelLevel / buildFeatureRow", () => {
  it("uses the kernel where the training sales are dense (no nbLevel imputation)", () => {
    const row = buildFeatureRow(model, FOLKUNGAGATAN);
    expect(row.imputed).not.toContain("nbLevel");
    const { level, weight } = kernelLevel(model.kernel, 59.3148, 18.0768);
    expect(weight).toBeGreaterThanOrEqual(model.kernel.minWeight);
    expect(row.x.nbLevel).toBe(level);
  });

  it("falls back to the district median far from every training sale, and says so", () => {
    const row = buildFeatureRow(model, { ...FOLKUNGAGATAN, latitude: 59.5, longitude: 18.5 });
    expect(row.x.nbLevel).toBe(model.districtLnMedian.Södermalm);
    expect(row.imputed).toContain("nbLevel");
  });

  it("null coordinates use districtLnMedian and the mean centrality, listing both", () => {
    const input: HedonicInput = {
      ...FOLKUNGAGATAN,
      district: "Vasastan",
      latitude: null,
      longitude: null,
      floor: 2.5,
      livingArea: 45,
    };
    const row = buildFeatureRow(model, input);
    expect(row.x.nbLevel).toBe(model.districtLnMedian.Vasastan);
    expect(row.imputed).toEqual(expect.arrayContaining(["nbLevel", "centralityKm"]));
    // Only the ground-floor term moves: floor 2.5 is not ground, the mean is 0.1.
    const { lnKrPerSqm } = predictLnKrPerSqm(model, input);
    // 6 digits: the fixture stores ln values rounded to 6 decimals.
    expect(lnKrPerSqm).toBeCloseTo(model.districtLnMedian.Vasastan + 0.1 * 0.1, 6);
  });

  it("null floor is marginalised at the mean: same price as any floor once the floor terms are zeroed", () => {
    const flat = structuredClone(modelJson) as unknown as HedonicModel;
    for (const f of flat.features) {
      if (f.name === "floor" || f.name === "groundOrBelow") f.beta = 0;
    }
    const withNull = predictKrPerSqm(flat, { ...FOLKUNGAGATAN, floor: null });
    const withFloor = predictKrPerSqm(flat, { ...FOLKUNGAGATAN, floor: 3 });
    expect(withNull.krPerSqm).toBeCloseTo(withFloor.krPerSqm, 9);
    expect(withNull.imputed).toContain("floor");
    expect(withFloor.imputed).not.toContain("floor");
  });

  it("null floor on the real fixture lists floor and does not change the other terms", () => {
    const { imputed } = predictKrPerSqm(model, { ...FOLKUNGAGATAN, floor: null });
    expect(imputed).toContain("floor");
  });

  it("clips floors above the maximum", () => {
    const high = buildFeatureRow(model, { ...FOLKUNGAGATAN, floor: 12 });
    expect(high.x.floor).toBe(6);
    expect(high.x.groundOrBelow).toBe(0);
  });

  it("flags a basement or ground floor", () => {
    expect(buildFeatureRow(model, { ...FOLKUNGAGATAN, floor: 0 }).x.groundOrBelow).toBe(1);
    expect(buildFeatureRow(model, { ...FOLKUNGAGATAN, floor: -1 }).x.groundOrBelow).toBe(1);
  });

  it("centrality is the distance to the nearest market hub", () => {
    const medborgar = CENTRALITY_HUBS.find((h) => h.name === "Medborgarplatsen")!;
    const row = buildFeatureRow(model, { ...FOLKUNGAGATAN, latitude: medborgar.lat, longitude: medborgar.lng });
    expect(row.x.centralityKm).toBeCloseTo(0, 9);
  });

  it("refuses a non-positive living area", () => {
    expect(() => buildFeatureRow(model, { ...FOLKUNGAGATAN, livingArea: 0 })).toThrow(RangeError);
  });
});

describe("predictKrPerSqm", () => {
  it("is deterministic", () => {
    expect(predictKrPerSqm(model, FOLKUNGAGATAN)).toEqual(predictKrPerSqm(model, FOLKUNGAGATAN));
  });

  it("applies smearing to the exponentiated prediction", () => {
    const { lnKrPerSqm } = predictLnKrPerSqm(model, FOLKUNGAGATAN);
    const { krPerSqm } = predictKrPerSqm(model, { ...FOLKUNGAGATAN, balcony: false });
    expect(krPerSqm).toBeCloseTo(Math.exp(lnKrPerSqm) * model.smearing, 6);
  });

  it("a balcony multiplies by 1 + pct; unknown balcony is listed, not priced", () => {
    const none = predictKrPerSqm(model, { ...FOLKUNGAGATAN, balcony: false });
    const yes = predictKrPerSqm(model, { ...FOLKUNGAGATAN, balcony: true });
    const unknown = predictKrPerSqm(model, { ...FOLKUNGAGATAN, balcony: null });
    expect(yes.krPerSqm / none.krPerSqm).toBeCloseTo(1 + model.stage2.balcony.pct, 12);
    expect(unknown.krPerSqm).toBe(none.krPerSqm);
    expect(unknown.imputed).toContain("balcony");
    expect(none.imputed).not.toContain("balcony");
  });

  it("applies the build-year bucket only when the model has the term and the year is known", () => {
    const withTerm = structuredClone(modelJson) as unknown as HedonicModel;
    withTerm.stage2.buildYear = {
      pctByBucket: { le1930: 0.05, y1931to1960: 0, y1961to1990: -0.02, ge1991: 0.03 },
      source: "fit",
    };
    const base = predictKrPerSqm(withTerm, { ...FOLKUNGAGATAN, constructionYear: 1960 });
    const old = predictKrPerSqm(withTerm, { ...FOLKUNGAGATAN, constructionYear: 1900 });
    const unknown = predictKrPerSqm(withTerm, { ...FOLKUNGAGATAN, constructionYear: null });
    expect(old.krPerSqm / base.krPerSqm).toBeCloseTo(1.05, 12);
    expect(unknown.imputed).toContain("buildYear");
    // The fixture itself has no build-year term, so a null year is not imputed there.
    expect(predictKrPerSqm(model, FOLKUNGAGATAN).imputed).not.toContain("buildYear");
  });

  it("renovated cap is the prediction lifted by the P75 residual", () => {
    expect(renovatedCapKrPerSqm(model, 100_000)).toBeCloseTo(100_000 * Math.exp(0.074), 9);
  });
});

describe("expectedOverbid", () => {
  it("flat: Vasastan is exactly 0, Södermalm is 8 %", () => {
    expect(expectedOverbid(model, "Vasastan", 100_000, 110_000)).toBe(0);
    expect(expectedOverbid(model, "Södermalm", 100_000, 110_000)).toBeCloseTo(0.08, 12);
  });

  it("slope: a flat asked below the model price draws a larger bid", () => {
    const slope = structuredClone(modelJson) as unknown as HedonicModel;
    slope.bidPremium.kind = "slope";
    slope.bidPremium.b = -0.5;
    const cheap = expectedOverbid(slope, "Södermalm", 80_000, 100_000);
    const atModel = expectedOverbid(slope, "Södermalm", 100_000, 100_000);
    expect(atModel).toBeCloseTo(0.08, 12);
    expect(cheap).toBeGreaterThan(atModel);
    expect(cheap).toBeCloseTo(
      Math.exp(slope.bidPremium.perDistrict.Södermalm.a - 0.5 * Math.log(0.8)) - 1,
      12,
    );
  });

  it("slope without a b behaves as flat", () => {
    const slope = structuredClone(modelJson) as unknown as HedonicModel;
    slope.bidPremium.kind = "slope";
    slope.bidPremium.b = null;
    expect(expectedOverbid(slope, "Södermalm", 80_000, 100_000)).toBeCloseTo(0.08, 12);
  });
});

// ---------------------------------------------------------------------------
// Task 1 (14.1-05): Cholesky solver and ridge fit, closed-form checks
// ---------------------------------------------------------------------------

/** Seeded linear congruential generator: same seed, same numbers, every run. */
function lcg(seed: number): { uniform: () => number; normal: () => number } {
  let state = seed >>> 0;
  const uniform = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state + 0.5) / 4294967296;
  };
  const normal = (): number => {
    // Box-Muller: two uniforms in, one standard normal out.
    return Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
  };
  return { uniform, normal };
}

describe("choleskySolve (FIT-02)", () => {
  const A = [
    [4, 12, -16],
    [12, 37, -43],
    [-16, -43, 98],
  ];

  it("solves the textbook 3x3 system to 1e-9", () => {
    const truth = [1, 2, 3];
    const b = A.map((row) => row[0] * truth[0] + row[1] * truth[1] + row[2] * truth[2]);
    const x = choleskySolve(A, b);
    for (let i = 0; i < 3; i++) expect(Math.abs(x[i] - truth[i])).toBeLessThan(1e-9);
  });

  it("does not modify its inputs", () => {
    const copy = structuredClone(A);
    const b = [1, 2, 3];
    choleskySolve(A, b);
    expect(A).toEqual(copy);
    expect(b).toEqual([1, 2, 3]);
  });

  it("throws on a matrix with a non-positive pivot", () => {
    expect(() => choleskySolve([[1, 2], [2, 1]], [1, 1])).toThrow(/positivt definit/);
    expect(() => choleskySolve([[0, 0], [0, 0]], [1, 1])).toThrow(/positivt definit/);
  });

  it("throws on NaN input instead of returning NaN", () => {
    expect(() => choleskySolve([[Number.NaN]], [1])).toThrow();
  });

  it("throws when the sizes do not match", () => {
    expect(() => choleskySolve([[1, 0], [0, 1]], [1])).toThrow(RangeError);
  });
});

describe("fitRidge (FIT-02, D-18)", () => {
  /** n rows of two uniform columns on [0, 10) and [-5, 5). */
  function design(n: number, seed: number): number[][] {
    const g = lcg(seed);
    return Array.from({ length: n }, () => [g.uniform() * 10, g.uniform() * 10 - 5]);
  }

  it("recovers a noiseless line exactly (1e-6) with r2 = 1", () => {
    const X = design(50, 7);
    const y = X.map(([a, b]) => 2 + 0.5 * a - 0.3 * b);
    const fit = fitRidge(X, y, 1e-9);
    expect(Math.abs(fit.intercept - 2)).toBeLessThan(1e-6);
    expect(Math.abs(fit.beta[0] - 0.5)).toBeLessThan(1e-6);
    expect(Math.abs(fit.beta[1] + 0.3)).toBeLessThan(1e-6);
    expect(Math.abs(fit.r2 - 1)).toBeLessThan(1e-9);
    expect(fit.rmse).toBeLessThan(1e-6);
  });

  it("with noise (sd 0.1, 400 rows) every coefficient lands within 3 standard errors", () => {
    const X = design(400, 11);
    const g = lcg(99);
    const y = X.map(([a, b]) => 2 + 0.5 * a - 0.3 * b + 0.1 * g.normal());
    const fit = fitRidge(X, y, 1e-9);
    expect(Math.abs(fit.beta[0] - 0.5)).toBeLessThan(3 * fit.se[0]);
    expect(Math.abs(fit.beta[1] + 0.3)).toBeLessThan(3 * fit.se[1]);
    // The standard error itself should be about sd / (sd_x * sqrt(n)).
    expect(fit.se[0]).toBeGreaterThan(0.0005);
    expect(fit.se[0]).toBeLessThan(0.003);
    expect(fit.rmse).toBeGreaterThan(0.08);
    expect(fit.rmse).toBeLessThan(0.12);
  });

  it("a duplicated column never produces NaN or Infinity, and the pair still carries the true effect", () => {
    const base = design(80, 5);
    const X = base.map(([a, b]) => [a, a, b]);
    const y = base.map(([a, b]) => 1 + 0.4 * a - 0.2 * b);
    const fit = fitRidge(X, y, 1e-6);
    for (const v of [...fit.beta, ...fit.se, fit.intercept, fit.r2, fit.rmse]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    for (const row of X) {
      const fitted = fit.intercept + row[0] * fit.beta[0] + row[1] * fit.beta[1] + row[2] * fit.beta[2];
      expect(Number.isFinite(fitted)).toBe(true);
    }
    expect(Math.abs(fit.beta[0] + fit.beta[1] - 0.4)).toBeLessThan(1e-3);
    expect(Math.abs(fit.beta[2] + 0.2)).toBeLessThan(1e-3);
  });

  it("an all-zero column stays finite and gets coefficient 0", () => {
    const base = design(60, 3);
    const X = base.map(([a, b]) => [a, 0, b]);
    const y = base.map(([a, b]) => 3 + 0.25 * a + 0.1 * b);
    const fit = fitRidge(X, y, 1e-6);
    for (const v of [...fit.beta, ...fit.se, fit.intercept, fit.r2, fit.rmse]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(Math.abs(fit.beta[1])).toBeLessThan(1e-9);
    expect(Math.abs(fit.beta[0] - 0.25)).toBeLessThan(1e-3);
  });

  it("a huge penalty flattens every slope but leaves the intercept at mean(y)", () => {
    const X = design(60, 21);
    const g = lcg(5);
    const y = X.map(([a, b]) => 4 + 0.3 * a - 0.2 * b + 0.05 * g.normal());
    const fit = fitRidge(X, y, 1e6);
    for (const b of fit.beta) expect(Math.abs(b)).toBeLessThan(1e-3);
    const mean = y.reduce((s, v) => s + v, 0) / y.length;
    // Unpenalised intercept: the line always passes through the point of means,
    // so with the columns centred the intercept IS mean(y).
    const colMean = [0, 1].map((j) => X.reduce((s, row) => s + row[j], 0) / X.length);
    const atMeans = fit.intercept + fit.beta[0] * colMean[0] + fit.beta[1] * colMean[1];
    expect(Math.abs(atMeans - mean)).toBeLessThan(1e-9);
    const centred = fitRidge(X.map((row) => [row[0] - colMean[0], row[1] - colMean[1]]), y, 1e6);
    expect(Math.abs(centred.intercept - mean)).toBeLessThan(1e-9);
  });

  it("returns coefficients and standard errors on the original feature scale", () => {
    const X = design(200, 31);
    const g = lcg(8);
    const y = X.map(([a, b]) => 1 + 0.5 * a - 0.3 * b + 0.1 * g.normal());
    const small = fitRidge(X, y, 1e-9);
    const scaled = fitRidge(X.map(([a, b]) => [a * 1000, b]), y, 1e-9);
    // Measuring the first column in units 1000 times smaller makes its slope 1000 times smaller.
    expect(scaled.beta[0] * 1000).toBeCloseTo(small.beta[0], 6);
    expect(scaled.se[0] * 1000).toBeCloseTo(small.se[0], 6);
    expect(scaled.beta[1]).toBeCloseTo(small.beta[1], 8);
    expect(scaled.intercept).toBeCloseTo(small.intercept, 8);
  });

  it("refuses non-finite input and empty input", () => {
    expect(() => fitRidge([[1], [Number.NaN]], [1, 2], 1)).toThrow(RangeError);
    expect(() => fitRidge([[1], [2]], [1, Number.POSITIVE_INFINITY], 1)).toThrow(RangeError);
    expect(() => fitRidge([], [], 1)).toThrow(RangeError);
    expect(() => fitRidge([[1], [2]], [1], 1)).toThrow(RangeError);
  });
});
