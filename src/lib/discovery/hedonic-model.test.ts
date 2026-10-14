import { describe, it, expect } from "vitest";
import modelJson from "@/lib/discovery/__fixtures__/hedonic-model.fixture.json";
import {
  CENTRALITY_HUBS,
  CV_FOLDS,
  EXPECTED_SIGNS,
  HEDONIC_FEATURES,
  HEDONIC_MIN_T,
  HEDONIC_PRIORS,
  KERNEL_CUTOFF_M,
  MIN_DISTRICT_N,
  MIN_FIT_ROWS,
  OPTIONAL_14_4_FEATURES,
  STAGE2_CAP_PCT,
  buildFeatureRow,
  choleskySolve,
  describeModel,
  expectedOverbid,
  expectedOverbidDetail,
  fitBidPremium,
  fitHedonicModel,
  fitRidge,
  guardVerdict,
  monthsBetweenIso,
  trainingFeatureMatrix,
  type HedonicTrainingRow,
  type TrainingPoint,
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
  avgiftPerSqmMonth: null,
  brfDebtPerSqm: null,
  tomtratt: null,
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

  it("rejects a model that leaves out one of the nine features", () => {
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

  it("the synthetic fixture is version 2 with all nine features and empty bid-premium term slots (D-01)", () => {
    expect(model.version).toBe(2);
    expect(model.features.map((f) => f.name)).toEqual([...HEDONIC_FEATURES]);
    expect(model.features).toHaveLength(9);
    expect(model.bidPremium.terms).toEqual({ dom: null, condition: null });
  });

  it("rejects a version-1 file with an error that names the version, never mis-reads it (T-14.4-11)", () => {
    const v1 = broken((m) => {
      m.version = 1;
      m.features = (m.features as { name: string }[]).slice(0, 6);
      delete (m.bidPremium as Record<string, unknown>).terms;
    });
    expect(() => parseHedonicModel(v1)).toThrow(/version/);
    expect(() => parseHedonicModel(v1)).toThrow(/Invalid hedonic model/);
    // Even a v1 file that otherwise happens to list nine features is refused on its version alone.
    expect(() => parseHedonicModel(broken((m) => (m.version = 1)))).toThrow(/version/);
  });

  it("accepts the term slots when filled and refuses a malformed term", () => {
    const filled = broken((m) => {
      (m.bidPremium as Record<string, unknown>).terms = {
        dom: { beta: -0.05, mean: 2.5, n: 900, kept: true, cvRmse: { without: 0.075, with: 0.073 }, note: "x" },
        condition: { beta: 0.02, source: "prior", kept: true, n: 0, cvRmse: null, note: "antagen" },
      };
    });
    expect(parseHedonicModel(filled).bidPremium.terms.dom?.beta).toBe(-0.05);
    const bad = broken((m) => {
      (m.bidPremium as Record<string, unknown>).terms = { dom: { beta: "x" }, condition: null };
    });
    expect(() => parseHedonicModel(bad)).toThrow();
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

// ---------------------------------------------------------------------------
// Task 2 (14.1-05): fitHedonicModel on data with known answers
// ---------------------------------------------------------------------------

type District = HedonicTrainingRow["district"];

/**
 * Four districts, centres > 3 km apart, each spread over about 1.8 km so that distance to the
 * nearest hub varies INSIDE a district (otherwise centrality cannot be told apart from the
 * neighbour level in a test city this small).
 */
const CENTRES: Record<District, { lat: number; lng: number; level: number }> = {
  Södermalm: { lat: 59.305, lng: 18.075, level: Math.log(110_000) },
  Kungsholmen: { lat: 59.335, lng: 18.015, level: Math.log(105_000) },
  Vasastan: { lat: 59.355, lng: 18.06, level: Math.log(112_000) },
  Östermalm: { lat: 59.34, lng: 18.12, level: Math.log(125_000) },
};

const AS_OF = "2026-10-12";
const FITTED_AT = "2026-10-13T00:00:00Z";

interface GenOptions {
  seed: number;
  perDistrict?: Partial<Record<District, number>>;
  floorEffect?: number;
  groundEffect?: number;
  areaEffect?: number;
  centralityEffect?: number;
  noise?: number;
  /** Share of rows that are detail-enriched (balcony and build year known). */
  enrichedShare?: number;
  balconyEffect?: number;
  /** Share of rows with no sold-vs-asking label. */
  nullLabelShare?: number;
  /** Probability that a labelled row also carries an asking price (default 1). */
  askingShare?: number;
  /**
   * 14.4 features. Absent = every row has avgift, debt and tomträtt unknown (null), which also
   * leaves the random sequence of the older tests untouched. `knownShare` of the rows carry
   * avgift kr/m2/month (uniform 40..120) and debt kr/m2 (uniform 0..15 000), never tomträtt;
   * the effects are ln price per unit.
   */
  newFeatures?: { knownShare: number; avgiftEffect?: number; debtEffect?: number };
}

function nearestHubKm(lat: number, lng: number): number {
  return Math.min(...CENTRALITY_HUBS.map((h) => haversineMeters(lat, lng, h.lat, h.lng))) / 1000;
}

const DISTRICT_A: Record<District, number> = {
  Södermalm: Math.log(1.12),
  Kungsholmen: Math.log(1.06),
  Vasastan: Math.log(1.08),
  Östermalm: Math.log(1.05),
};

/** The noise-free ln(kr/m2) each generated row was drawn around (balcony effect excluded). */
const TRUTH = new WeakMap<HedonicTrainingRow, number>();

/** Sold flats generated from known coefficients plus small seeded noise. */
function generateRows(opts: GenOptions): HedonicTrainingRow[] {
  const g = lcg(opts.seed);
  const counts = { Södermalm: 150, Kungsholmen: 150, Vasastan: 150, Östermalm: 150, ...opts.perDistrict };
  const floorEffect = opts.floorEffect ?? Math.log(1.01);
  const groundEffect = opts.groundEffect ?? Math.log(0.9);
  const areaEffect = opts.areaEffect ?? -0.08;
  const centralityEffect = opts.centralityEffect ?? -0.04;
  const noise = opts.noise ?? 0.05;
  const rows: HedonicTrainingRow[] = [];
  for (const district of Object.keys(CENTRES) as District[]) {
    const c = CENTRES[district];
    for (let i = 0; i < counts[district]; i++) {
      let avgiftPerSqmMonth: number | null = null;
      let brfDebtPerSqm: number | null = null;
      let tomtratt: boolean | null = null;
      if (opts.newFeatures) {
        const known = g.uniform() < opts.newFeatures.knownShare;
        const a = 40 + g.uniform() * 80;
        const d = g.uniform() * 15_000;
        if (known) {
          avgiftPerSqmMonth = Math.round(a * 10) / 10;
          brfDebtPerSqm = Math.round(d);
          tomtratt = false;
        }
      }
      const lat = Math.round((c.lat + (g.uniform() - 0.5) * 0.016) * 1000) / 1000;
      const lng = Math.round((c.lng + (g.uniform() - 0.5) * 0.028) * 1000) / 1000;
      const floor = Math.floor(g.uniform() * 7);
      const livingArea = Math.round((35 + g.uniform() * 75) * 10) / 10;
      const monthsBack = Math.floor(g.uniform() * 18);
      const monthIndex = 2026 * 12 + 9 - monthsBack; // 0-based month number
      const year = Math.floor(monthIndex / 12);
      const month = (monthIndex % 12) + 1;
      const soldDate = `${year}-${String(month).padStart(2, "0")}-12`;
      const enriched = g.uniform() < (opts.enrichedShare ?? 0);
      const balcony = g.uniform() < 0.5;
      const buildYear = Math.round(1880 + g.uniform() * 140);
      const truth =
        c.level +
        floorEffect * floor +
        (floor === 0 ? groundEffect : 0) +
        areaEffect * (Math.log(livingArea) - Math.log(60)) +
        centralityEffect * (nearestHubKm(lat, lng) - 0.5);
      const y =
        truth +
        (opts.balconyEffect ?? 0) * (balcony ? 1 : 0) +
        (opts.newFeatures?.avgiftEffect ?? 0) * ((avgiftPerSqmMonth ?? 80) - 80) +
        (opts.newFeatures?.debtEffect ?? 0) * ((brfDebtPerSqm ?? 7500) - 7500) +
        noise * g.normal();
      const soldPrice = Math.round(Math.exp(y) * livingArea);
      const hasLabel = g.uniform() >= (opts.nullLabelShare ?? 0);
      const z = DISTRICT_A[district] + 0.03 * g.normal();
      const pct = hasLabel ? 100 * (Math.exp(z) - 1) : null;
      const hasAsking = g.uniform() < (opts.askingShare ?? 1);
      const row: HedonicTrainingRow = {
        district,
        lat,
        lng,
        floor,
        livingArea,
        soldPrice,
        soldDate,
        soldVsAskPct: pct,
        askingPrice: pct === null || !hasAsking ? null : Math.round(soldPrice / (1 + pct / 100)),
        balcony: enriched ? balcony : null,
        buildYear: enriched ? buildYear : null,
        enriched,
        avgiftPerSqmMonth,
        brfDebtPerSqm,
        tomtratt,
      };
      TRUTH.set(row, truth);
      rows.push(row);
    }
  }
  return rows;
}

const OPTS = { asOf: AS_OF, fittedAt: FITTED_AT };
const featureOf = (m: HedonicModel, name: (typeof HEDONIC_FEATURES)[number]) =>
  m.features.find((f) => f.name === name)!;

describe("monthsBetweenIso", () => {
  it("whole months are exact", () => {
    expect(Math.abs(monthsBetweenIso("2025-04-12", "2026-10-12") - 18)).toBeLessThan(1e-9);
    expect(monthsBetweenIso("2026-10-12", "2026-10-12")).toBe(0);
  });

  it("half a month is about 0.5", () => {
    expect(Math.abs(monthsBetweenIso("2026-09-27", "2026-10-12") - 0.5)).toBeLessThan(0.05);
  });

  it("a sale after the reference date is negative, a malformed date throws", () => {
    expect(monthsBetweenIso("2026-11-12", "2026-10-12")).toBeLessThan(0);
    expect(() => monthsBetweenIso("12/10/2026", "2026-10-12")).toThrow(/YYYY-MM-DD/);
  });
});

describe("constants and priors", () => {
  it("expected signs follow D-02, minus size (D-10): monthsAgo and lnArea have no expectation; the 14.4 features are all expected to lower the price (D-01)", () => {
    expect(EXPECTED_SIGNS).toEqual({
      nbLevel: 1,
      floor: 1,
      groundOrBelow: -1,
      lnArea: 0,
      centralityKm: -1,
      monthsAgo: 0,
      avgiftPerSqmMonth: -1,
      brfDebtPerSqm: -1,
      tomtratt: -1,
    });
  });

  it("priors are floor +1 %, ground floor -10 %, balcony +1.9 %", () => {
    expect(HEDONIC_PRIORS.floor).toBeCloseTo(Math.log(1.01), 12);
    expect(HEDONIC_PRIORS.groundOrBelow).toBeCloseTo(Math.log(0.9), 12);
    expect(HEDONIC_PRIORS.balconyPct).toBe(0.019);
  });
});

describe("trainingFeatureMatrix: leave-one-out neighbour level (FIT-02)", () => {
  const district: District = "Södermalm";
  const medians = { Södermalm: 11.5, Kungsholmen: 11.5, Vasastan: 11.5, Östermalm: 11.5 };
  const point = (lat: number, lng: number, y: number): TrainingPoint => ({
    district,
    lat,
    lng,
    floor: 2,
    livingArea: 50,
    y,
    monthsAgo: 0,
    avgiftPerSqmMonth: null,
    brfDebtPerSqm: null,
    tomtratt: null,
  });

  it("a row never sees its own price: with two co-located sales each gets the other's", () => {
    const { X } = trainingFeatureMatrix([point(59.31, 18.07, 1), point(59.31, 18.07, 2)], medians);
    expect(X[0][0]).toBeCloseTo(2, 12);
    expect(X[1][0]).toBeCloseTo(1, 12);
  });

  it("a row with no other sale within the cut-off gets the district median", () => {
    const far = point(59.41, 18.07, 9); // > 10 km away
    const { X } = trainingFeatureMatrix([point(59.31, 18.07, 1), point(59.3105, 18.07, 2), far], medians);
    expect(X[2][0]).toBe(11.5);
    expect(X[0][0]).toBeCloseTo(2, 12);
  });

  it("a lone neighbour at 500 m is too little evidence (weight < 0.5) and falls back too", () => {
    const { X } = trainingFeatureMatrix([point(59.31, 18.07, 1), point(59.3145, 18.07, 2)], medians);
    expect(X[0][0]).toBe(11.5);
    expect(X[1][0]).toBe(11.5);
  });

  it("uses the same cut-off the persisted kernel carries", () => {
    const { kernel } = trainingFeatureMatrix([point(59.31, 18.07, 1)], medians);
    expect(kernel.cutoffM).toBe(KERNEL_CUTOFF_M);
    expect(kernel.points).toEqual([[59.31, 18.07, 1]]);
  });
});

describe("fitHedonicModel: recovers known coefficients (FIT-02, D-02, D-18)", () => {
  // No true hub effect: the neighbour level already carries any smooth location effect, so
  // "distance to hub" is expected to be redundant here (and may be replaced; see its own test).
  const rows = generateRows({ seed: 2026, centralityEffect: 0 });
  const { model, report } = fitHedonicModel(rows, OPTS);

  it("produces a model the persisted schema accepts, with provenance passed through", () => {
    expect(hedonicModelSchema.safeParse(model).success).toBe(true);
    expect(model.fittedAt).toBe(FITTED_AT);
    expect(model.asOf).toBe(AS_OF);
    expect(model.n).toBe(rows.length - report.droppedOutliers);
    expect(report.cvByFold).toHaveLength(CV_FOLDS);
  });

  it("floor is within 0.004 of ln(1.01) and came from the data, not a fallback", () => {
    const floor = featureOf(model, "floor");
    expect(Math.abs(floor.beta - Math.log(1.01))).toBeLessThan(0.004);
    expect(floor.source).toBe("fit");
    const guarded = model.fallbacks.filter((f) => f.reason === "wrong-sign" || f.reason === "unstable");
    expect(guarded.filter((f) => f.item !== "centralityKm")).toEqual([]);
  });

  it("ground floor, size and the neighbour level are also close to what generated the data", () => {
    expect(Math.abs(featureOf(model, "groundOrBelow").beta - Math.log(0.9))).toBeLessThan(0.03);
    expect(Math.abs(featureOf(model, "lnArea").beta + 0.08)).toBeLessThan(0.02);
    // The test city is four tight clusters, so the neighbour level is close to a district label
    // and its coefficient is only loosely pinned down; what matters is sign and strength.
    const nb = featureOf(model, "nbLevel");
    expect(nb.beta).toBeGreaterThan(0.5);
    expect(nb.beta).toBeLessThan(1.6);
    expect(nb.beta / nb.se!).toBeGreaterThan(3);
  });

  it("smearing is at least 1, the P75 residual is not negative, and the fit is honest about error", () => {
    expect(model.smearing).toBeGreaterThanOrEqual(1);
    expect(model.residualP75Log).toBeGreaterThanOrEqual(0);
    expect(model.residualSdLog).toBeGreaterThan(0.03);
    expect(model.residualSdLog).toBeLessThan(0.08);
    expect(model.cvRmseLog).toBeGreaterThanOrEqual(model.residualSdLog * 0.95);
    expect(model.cvRmseLog).toBeLessThan(0.09);
    expect(model.r2).toBeGreaterThan(0.5);
  });

  it("is deterministic: two runs give deep-equal models and reports", () => {
    expect(fitHedonicModel(rows, OPTS)).toEqual({ model, report });
  });

  it("does not depend on the order of the input rows", () => {
    const shuffled = [...rows].reverse();
    const again = fitHedonicModel(shuffled, OPTS).model;
    // Folds follow the row index, so only the in-sample parts are order-free.
    expect(again.n).toBe(model.n);
    expect(featureOf(again, "floor").beta).toBeCloseTo(featureOf(model, "floor").beta, 9);
    expect(again.intercept).toBeCloseTo(model.intercept, 9);
  });

  it("the point cloud holds only rounded coordinates and ln(kr/m2): no addresses, dates or prices (T-14.1-04)", () => {
    expect(model.kernel.points).toHaveLength(model.n);
    for (const [lat, lng, y] of model.kernel.points) {
      expect(Math.round(lat * 1000) / 1000).toBe(lat);
      expect(Math.round(lng * 1000) / 1000).toBe(lng);
      expect(y).toBeGreaterThan(10);
      expect(y).toBeLessThan(13);
    }
    expect(JSON.stringify(model)).not.toMatch(/soldDate|soldPrice|address|gata/i);
  });

  it("predicting a training row through predictKrPerSqm stays within 5 % of its generated level (train/serve)", () => {
    const sample = rows.filter((r) => r.floor === 3).slice(0, 40);
    expect(sample.length).toBeGreaterThan(20);
    for (const r of sample) {
      const { krPerSqm } = predictKrPerSqm(model, {
        district: r.district,
        latitude: r.lat,
        longitude: r.lng,
        floor: r.floor,
        livingArea: r.livingArea,
        balcony: null,
        constructionYear: null,
        avgiftPerSqmMonth: r.avgiftPerSqmMonth,
        brfDebtPerSqm: r.brfDebtPerSqm,
        tomtratt: r.tomtratt,
      });
      expect(Math.abs(krPerSqm / Math.exp(TRUTH.get(r)!) - 1)).toBeLessThan(0.05);
    }
  });
});

describe("fitHedonicModel: size range (R-12)", () => {
  it("minLivingArea / maxLivingArea are the extremes of the KEPT rows; a dropped outlier does not widen them", () => {
    const base = generateRows({ seed: 5, perDistrict: { Södermalm: 60, Kungsholmen: 60, Vasastan: 60, Östermalm: 60 } });
    // A 300 m2 "flat" sold for a tenth of the going price: far outside the scatter.
    const outlier: HedonicTrainingRow = {
      ...base[0],
      livingArea: 300,
      soldPrice: Math.round(11_000 * 300),
      soldVsAskPct: null,
      askingPrice: null,
      balcony: null,
      buildYear: null,
      enriched: false,
      avgiftPerSqmMonth: null,
      brfDebtPerSqm: null,
      tomtratt: null,
    };
    const { model, report } = fitHedonicModel([...base, outlier], OPTS);
    expect(report.droppedOutliers).toBeGreaterThanOrEqual(1);
    const areas = base.map((r) => r.livingArea);
    expect(model.maxLivingArea).toBeLessThan(300);
    expect(model.minLivingArea).toBe(Math.min(...areas));
    expect(model.maxLivingArea).toBeLessThanOrEqual(Math.max(...areas));
    expect(model.maxLivingArea).toBeGreaterThan(100);
    expect(model.n).toBe(base.length + 1 - report.droppedOutliers);
  });
});

describe("guardVerdict (D-18)", () => {
  it("trusts a coefficient with the expected sign and |t| at or above the limit", () => {
    expect(guardVerdict("floor", 0.02, 0.005)).toBeNull();
    expect(guardVerdict("floor", 0.01 * HEDONIC_MIN_T, 0.01)).toBeNull(); // t exactly HEDONIC_MIN_T
    expect(guardVerdict("floor", 0.0099 * HEDONIC_MIN_T, 0.01)?.reason).toBe("unstable"); // just under
    expect(guardVerdict("groundOrBelow", -0.1, 0.03)).toBeNull();
  });

  it("calls a coefficient pointing the wrong way wrong-sign, however sure the data is", () => {
    expect(guardVerdict("floor", -0.02, 0.0001)?.reason).toBe("wrong-sign");
    expect(guardVerdict("centralityKm", 0.05, 0.01)?.reason).toBe("wrong-sign");
    expect(guardVerdict("groundOrBelow", 0.3, 0.02)?.reason).toBe("wrong-sign");
  });

  it("calls a right-direction coefficient with |t| below the limit unstable", () => {
    expect(guardVerdict("floor", 0.004, 0.01)?.reason).toBe("unstable");
    expect(guardVerdict("floor", -0.001, 0.02)?.reason).toBe("wrong-sign");
    expect(guardVerdict("nbLevel", 0.001, 0.02)?.reason).toBe("unstable");
    expect(guardVerdict("floor", 0, 0.01)?.reason).toBe("unstable");
  });

  it("never guards size (D-10, WR-06): either sign, sure or unsure", () => {
    expect(guardVerdict("lnArea", -0.001, 0.02)).toBeNull();
    expect(guardVerdict("lnArea", 0.05, 0.005)).toBeNull();
    expect(guardVerdict("lnArea", 0.15, 0.0001)).toBeNull();
  });

  it("never guards monthsAgo, and survives a zero standard error", () => {
    expect(guardVerdict("monthsAgo", -5, 0.0001)).toBeNull();
    expect(guardVerdict("floor", 0.01, 0)).toBeNull();
    expect(guardVerdict("floor", -0.01, 0)?.reason).toBe("wrong-sign");
  });

  it("scores the worst offender lowest", () => {
    const wrong = guardVerdict("floor", -0.02, 0.005)!;
    const shaky = guardVerdict("floor", 0.002, 0.005)!;
    expect(wrong.score).toBeLessThan(shaky.score);
  });
});

describe("fitHedonicModel: sign and stability guard (D-18, T-14.1-13)", () => {
  it("wrong sign WITH a documented prior: floor is replaced by exactly ln(1.01), source prior, recorded", () => {
    const { model } = fitHedonicModel(generateRows({ seed: 31, floorEffect: -0.02 }), OPTS);
    const floor = featureOf(model, "floor");
    expect(floor.beta).toBe(HEDONIC_PRIORS.floor);
    expect(floor.source).toBe("prior");
    expect(floor.se).toBeNull();
    expect(model.fallbacks).toContainEqual(expect.objectContaining({ item: "floor", reason: "wrong-sign" }));
    expect(hedonicModelSchema.safeParse(model).success).toBe(true);
  });

  it("a positive size coefficient is kept (D-10): bigger flats costing more per m2 stays source fit, no fallback", () => {
    // Bigger flats costing MORE per m2 used to be zeroed; the data are sure about it, so the fit now keeps it.
    const { model } = fitHedonicModel(generateRows({ seed: 32, centralityEffect: 0, areaEffect: 0.15 }), OPTS);
    const size = featureOf(model, "lnArea");
    expect(size.beta).toBeGreaterThan(0.05);
    expect(size.source).toBe("fit");
    expect(size.se).not.toBeNull();
    expect(model.fallbacks.some((f) => f.item === "lnArea")).toBe(false);
    expect(hedonicModelSchema.safeParse(model).success).toBe(true);
  });

  it("wrong sign WITHOUT a prior: centralityKm is set to zero, source zeroed, recorded (zeroing path)", () => {
    // Prices RISING with distance from a hub contradicts the expected sign; there is no study value for it.
    const { model } = fitHedonicModel(generateRows({ seed: 33, centralityEffect: 0.12 }), OPTS);
    const centrality = featureOf(model, "centralityKm");
    expect(centrality.beta).toBe(0);
    expect(centrality.source).toBe("zeroed");
    expect(centrality.se).toBeNull();
    expect(model.fallbacks).toContainEqual(expect.objectContaining({ item: "centralityKm", reason: "wrong-sign" }));
    expect(hedonicModelSchema.safeParse(model).success).toBe(true);
  });

  it("unstable (right direction, |t| below the limit) is labelled unstable and uses the prior: pinned seed", () => {
    // Pinned to seed 3, where the floor estimate comes out with the right sign but |t| < 1
    // (true floor effect 0, heavy noise, 40 flats per district). Deterministic: same seed, same rows.
    const rows = generateRows({
      seed: 3,
      floorEffect: 0,
      centralityEffect: 0,
      noise: 0.15,
      perDistrict: { Södermalm: 40, Kungsholmen: 40, Vasastan: 40, Östermalm: 40 },
    });
    const { model } = fitHedonicModel(rows, OPTS);
    const hit = model.fallbacks.find((f) => f.item === "floor");
    expect(hit).toBeDefined();
    expect(hit!.reason).toBe("unstable");
    expect(hit!.detail).toMatch(/osäker/);
    expect(featureOf(model, "floor").beta).toBe(HEDONIC_PRIORS.floor);
    expect(featureOf(model, "floor").source).toBe("prior");
  });

  it("clean data triggers no guard on anything but the redundant hub distance", () => {
    const { model } = fitHedonicModel(generateRows({ seed: 2026, centralityEffect: 0 }), OPTS);
    for (const f of model.features) {
      // The three 14.4 columns have no known value in this data: "absent", not guarded (see their own tests).
      if (f.name !== "centralityKm" && !(OPTIONAL_14_4_FEATURES as readonly string[]).includes(f.name)) {
        expect(f.source, f.name).toBe("fit");
      }
    }
    const guarded = model.fallbacks.filter((f) => f.reason === "wrong-sign" || f.reason === "unstable");
    expect(guarded.filter((f) => f.item !== "centralityKm")).toEqual([]);
  });

  it("a smooth location effect is carried by the neighbour level, so predictions stay right even if hub distance is zeroed", () => {
    const rows = generateRows({ seed: 2027, centralityEffect: -0.08 });
    const { model } = fitHedonicModel(rows, OPTS);
    expect(model.cvRmseLog).toBeLessThan(0.08);
    for (const r of rows.filter((x) => x.floor === 3).slice(0, 40)) {
      const { krPerSqm } = predictKrPerSqm(model, {
        district: r.district,
        latitude: r.lat,
        longitude: r.lng,
        floor: r.floor,
        livingArea: r.livingArea,
        balcony: null,
        constructionYear: null,
        avgiftPerSqmMonth: r.avgiftPerSqmMonth,
        brfDebtPerSqm: r.brfDebtPerSqm,
        tomtratt: r.tomtratt,
      });
      expect(Math.abs(krPerSqm / Math.exp(TRUTH.get(r)!) - 1)).toBeLessThan(0.06);
    }
  });

  it("monthsAgo is never guarded", () => {
    const { model } = fitHedonicModel(generateRows({ seed: 2026, centralityEffect: 0 }), OPTS);
    expect(featureOf(model, "monthsAgo").source).toBe("fit");
    expect(model.fallbacks.some((f) => f.item === "monthsAgo")).toBe(false);
  });
});

describe("fitHedonicModel: small districts (R-07)", () => {
  const rows = generateRows({ seed: 77, perDistrict: { Östermalm: 20 } });
  const { model } = fitHedonicModel(rows, OPTS);

  it("a district below MIN_DISTRICT_N borrows the overall median, and says so", () => {
    expect(20).toBeLessThan(MIN_DISTRICT_N);
    const others = model.kernel.points.map((p) => p[2]).sort((a, b) => a - b);
    const mid = others.length / 2;
    const overall = others.length % 2 === 0 ? (others[mid - 1] + others[mid]) / 2 : others[(others.length - 1) / 2];
    expect(model.districtLnMedian.Östermalm).toBeCloseTo(overall, 12);
    expect(model.fallbacks).toContainEqual(
      expect.objectContaining({ item: "districtLnMedian.Östermalm", reason: "small-n" }),
    );
  });

  it("its bid premium is the overall one, marked fallback, with the real n kept", () => {
    const o = model.bidPremium.perDistrict.Östermalm;
    expect(o.source).toBe("fallback");
    expect(o.n).toBeLessThan(MIN_DISTRICT_N);
    expect(o.a).toBeCloseTo(model.bidPremium.overallA, 12);
    expect(model.fallbacks).toContainEqual(expect.objectContaining({ item: "bidPremium.Östermalm", reason: "small-n" }));
    expect(model.bidPremium.perDistrict.Södermalm.source).toBe("fit");
  });

  it("a district with no rows at all still gets all four entries", () => {
    const empty = fitHedonicModel(generateRows({ seed: 78, perDistrict: { Östermalm: 0 } }), OPTS).model;
    expect(hedonicModelSchema.safeParse(empty).success).toBe(true);
    expect(empty.bidPremium.perDistrict.Östermalm.n).toBe(0);
  });
});

describe("fitHedonicModel: stage 2, balcony and build year (D-02, R-05)", () => {
  it("absent: with no enriched rows balcony is the prior, build year is null, and both are recorded", () => {
    const { model, report } = fitHedonicModel(generateRows({ seed: 90 }), OPTS);
    expect(model.stage2.balcony).toEqual({ pct: 0.019, source: "prior" });
    expect(model.stage2.buildYear).toBeNull();
    expect(model.fallbacks).toContainEqual(expect.objectContaining({ item: "buildYear", reason: "absent" }));
    expect(model.fallbacks).toContainEqual(expect.objectContaining({ item: "balcony", reason: "absent" }));
    expect(report.enrichedN).toBe(0);
  });

  it("capped: a +20 % balcony effect in the data is limited to STAGE2_CAP_PCT and still marked fit", () => {
    const rows = generateRows({ seed: 91, enrichedShare: 0.5, balconyEffect: Math.log(1.2) });
    const { model, report } = fitHedonicModel(rows, OPTS);
    expect(STAGE2_CAP_PCT).toBe(0.08);
    expect(report.enrichedN).toBeGreaterThanOrEqual(MIN_DISTRICT_N);
    expect(model.stage2.balcony.pct).toBe(STAGE2_CAP_PCT);
    expect(model.stage2.balcony.source).toBe("fit");
    expect(model.stage2.buildYear).not.toBeNull();
    for (const v of Object.values(model.stage2.buildYear!.pctByBucket)) {
      expect(Math.abs(v)).toBeLessThanOrEqual(STAGE2_CAP_PCT);
    }
  });

  it("a modest balcony effect (+4 %) is recovered inside the cap", () => {
    const rows = generateRows({ seed: 92, enrichedShare: 0.8, balconyEffect: Math.log(1.04) });
    const { model } = fitHedonicModel(rows, OPTS);
    expect(model.stage2.balcony.source).toBe("fit");
    expect(Math.abs(model.stage2.balcony.pct - 0.04)).toBeLessThan(0.02);
  });

  it("a balcony effect that comes out the wrong way falls back to the prior 1.9 %", () => {
    const rows = generateRows({ seed: 93, enrichedShare: 0.8, balconyEffect: Math.log(0.9) });
    const { model } = fitHedonicModel(rows, OPTS);
    expect(model.stage2.balcony).toEqual({ pct: HEDONIC_PRIORS.balconyPct, source: "prior" });
    expect(model.fallbacks).toContainEqual(expect.objectContaining({ item: "balcony", reason: "wrong-sign" }));
  });

  it("too few enriched rows (below MIN_DISTRICT_N) is treated as absent", () => {
    const rows = generateRows({ seed: 94, enrichedShare: 0.03 });
    const { model } = fitHedonicModel(rows, OPTS);
    expect(model.stage2.buildYear).toBeNull();
  });
});

describe("fitBidPremium (R-07)", () => {
  /** Rows with ln(1+p) = a_d - 0.2 (ln ask - ln pred) + noise. */
  function slopeRows(seed: number, perDistrict = 120) {
    const g = lcg(seed);
    const out: Array<{ district: District; z: number; askLnKrm2: number | null; predLnKrm2: number }> = [];
    for (const district of Object.keys(CENTRES) as District[]) {
      for (let i = 0; i < perDistrict; i++) {
        const predLnKrm2 = CENTRES[district].level;
        const u = -0.1 + 0.12 * g.normal(); // ask relative to model
        out.push({
          district,
          z: DISTRICT_A[district] - 0.2 * u + 0.02 * g.normal(),
          askLnKrm2: predLnKrm2 + u,
          predLnKrm2,
        });
      }
    }
    return out;
  }

  it("picks the slope form when the premium really falls as asking rises, and recovers b within 0.05", () => {
    const fit = fitBidPremium(slopeRows(1));
    expect(fit.kind).toBe("slope");
    expect(Math.abs(fit.b! + 0.2)).toBeLessThan(0.05);
    expect(fit.cvRmse.slope).not.toBeNull();
    expect(fit.cvRmse.slope!).toBeLessThan(fit.cvRmse.flat);
    // The intercept is the bid when asking equals the model price (u = 0), which is the generated a_d.
    for (const d of Object.keys(CENTRES) as District[]) {
      expect(Math.abs(fit.perDistrict[d].a - DISTRICT_A[d])).toBeLessThan(0.01);
      expect(fit.perDistrict[d].source).toBe("fit");
    }
  });

  it("keeps the flat median when the premium is constant per district and a few bids are wild", () => {
    const g = lcg(2);
    const rows = (Object.keys(CENTRES) as District[]).flatMap((district) =>
      Array.from({ length: 100 }, () => {
        const predLnKrm2 = CENTRES[district].level;
        // 6 % of flats draw a wild bid; the typical bid sits at the district figure.
        const wild = g.uniform() < 0.06 ? 0.25 : 0;
        return {
          district,
          z: DISTRICT_A[district] + 0.02 * g.normal() + wild,
          askLnKrm2: predLnKrm2 - 0.1 + 0.12 * g.normal(),
          predLnKrm2,
        };
      }),
    );
    const fit = fitBidPremium(rows);
    expect(fit.kind).toBe("flat");
    expect(fit.b).toBeNull();
    expect(fit.cvRmse.slope === null || fit.cvRmse.flat <= fit.cvRmse.slope).toBe(true);
    // The median ignores the wild bids; the per-district figure stays at the typical bid.
    expect(Math.abs(fit.perDistrict.Södermalm.a - DISTRICT_A.Södermalm)).toBeLessThan(0.01);
  });

  it("with no asking prices there is no slope to try", () => {
    const rows = slopeRows(3).map((r) => ({ ...r, askLnKrm2: null }));
    const fit = fitBidPremium(rows);
    expect(fit.kind).toBe("flat");
    expect(fit.cvRmse.slope).toBeNull();
    expect(fit.b).toBeNull();
  });

  it("reports the null-label share it is given and never invents rows for them", () => {
    const fit = fitBidPremium(slopeRows(4), { nullLabelShare: 0.273 });
    expect(fit.nullLabelShare).toBe(0.273);
    const total = Object.values(fit.perDistrict).reduce((s, d) => s + d.n, 0);
    expect(total).toBe(480);
  });

  it("is deterministic and survives zero rows", () => {
    expect(fitBidPremium(slopeRows(5))).toEqual(fitBidPremium(slopeRows(5)));
    const empty = fitBidPremium([]);
    expect(empty.kind).toBe("flat");
    expect(Number.isFinite(empty.overallA)).toBe(true);
    expect(empty.perDistrict.Södermalm.source).toBe("fallback");
  });
});

describe("expectedOverbidDetail (VAL-03)", () => {
  /** The fixture with a days term attached (fixture a for Södermalm is ln 1.08). */
  function withDom(kept: boolean, kind: "flat" | "slope" = "flat"): HedonicModel {
    const m = structuredClone(modelJson) as unknown as HedonicModel;
    m.bidPremium.kind = kind;
    m.bidPremium.b = kind === "slope" ? -0.5 : null;
    m.bidPremium.terms.dom = {
      beta: -0.05,
      mean: 2.5,
      n: 400,
      kept,
      cvRmse: { without: 0.1, with: 0.09 },
      note: kept ? "med: korsvalidering 0,1000 -> 0,0900" : "prövad, förkastad: korsvalidering",
    };
    return m;
  }

  it("a longer listing draws a smaller premium when the term is kept", () => {
    const m = withDom(true);
    const fresh = expectedOverbidDetail(m, "Södermalm", 100_000, 110_000, { daysOnMarket: 0 });
    const old = expectedOverbidDetail(m, "Södermalm", 100_000, 110_000, { daysOnMarket: 60 });
    expect(old.pct).toBeLessThan(fresh.pct);
    expect(old.pct).toBeCloseTo(Math.exp(m.bidPremium.perDistrict.Södermalm.a - 0.05 * (Math.log(61) - 2.5)) - 1, 12);
    expect(old.domUsed).toBe(true);
    expect(old.domDays).toBe(60);
    expect(old.label).toBe("distrikt+dagar, skick ej mätt");
  });

  it("unknown days add exactly nothing (the training mean) and the label says so", () => {
    const m = withDom(true);
    const unknown = expectedOverbidDetail(m, "Södermalm", 100_000, 110_000, { daysOnMarket: null });
    const atMean = expectedOverbidDetail(m, "Södermalm", 100_000, 110_000, { daysOnMarket: Math.exp(2.5) - 1 });
    expect(unknown.pct).toBeCloseTo(atMean.pct, 12);
    expect(unknown.pct).toBeCloseTo(0.08, 12);
    expect(unknown.domUsed).toBe(false);
    expect(unknown.domDays).toBeNull();
    expect(unknown.label).toContain("dagar okända");
  });

  it("a rejected term changes nothing, whatever the days, and the label does not mention days", () => {
    const m = withDom(false);
    const a = expectedOverbidDetail(m, "Södermalm", 100_000, 110_000, { daysOnMarket: 3 });
    const b = expectedOverbidDetail(m, "Södermalm", 100_000, 110_000, { daysOnMarket: 200 });
    expect(a.pct).toBe(b.pct);
    expect(a.domUsed).toBe(false);
    expect(a.label).toBe("distrikt, skick ej mätt");
    expect(a.label).not.toContain("dagar");
  });

  it("with no days term the detail equals the old expectedOverbid for flat and slope", () => {
    const flat = model;
    const slope = structuredClone(modelJson) as unknown as HedonicModel;
    slope.bidPremium.kind = "slope";
    slope.bidPremium.b = -0.5;
    for (const m of [flat, slope]) {
      for (const [ask, pred] of [[80_000, 100_000], [100_000, 100_000], [120_000, 100_000]]) {
        const d = expectedOverbidDetail(m, "Södermalm", ask, pred, { daysOnMarket: 45 });
        expect(d.pct).toBe(expectedOverbid(m, "Södermalm", ask, pred));
        expect(d.domUsed).toBe(false);
        expect(d.conditionIndex).toBe(0);
        expect(d.conditionUsed).toBe(false);
        expect(d.conditionSource).toBe("prior");
      }
    }
    expect(expectedOverbidDetail(flat, "Södermalm", 100_000, 110_000, { daysOnMarket: null }).label).toBe("distrikt, skick ej mätt");
    expect(expectedOverbidDetail(slope, "Södermalm", 100_000, 110_000, { daysOnMarket: null }).label).toBe("distrikt+pris, skick ej mätt");
  });

  it("expectedOverbid is the detail's pct with days unknown", () => {
    for (const kept of [true, false]) {
      for (const kind of ["flat", "slope"] as const) {
        const m = withDom(kept, kind);
        expect(expectedOverbid(m, "Södermalm", 90_000, 100_000)).toBe(
          expectedOverbidDetail(m, "Södermalm", 90_000, 100_000, { daysOnMarket: null, conditionIndex: 0 }).pct,
        );
      }
    }
  });

  it("slope base: the label carries both the price slope and the days", () => {
    const m = withDom(true, "slope");
    expect(expectedOverbidDetail(m, "Södermalm", 90_000, 100_000, { daysOnMarket: 10 }).label).toBe("distrikt+pris+dagar, skick ej mätt");
    expect(expectedOverbidDetail(m, "Södermalm", 90_000, 100_000, { daysOnMarket: null }).label).toBe("distrikt+pris, dagar okända, skick ej mätt");
  });
});

describe("expectedOverbidDetail: condition index (BID-02, R-08)", () => {
  type Term = NonNullable<HedonicModel["bidPremium"]["terms"]["condition"]>;
  function withCondition(term: Term | null): HedonicModel {
    const m = structuredClone(modelJson) as unknown as HedonicModel;
    m.bidPremium.terms.condition = term;
    return m;
  }
  const fitted = (kept: boolean, source: "fit" | "prior" = "fit", beta = 0.02): Term => ({
    beta,
    source,
    kept,
    n: 250,
    cvRmse: source === "fit" ? { without: 0.1, with: 0.09 } : null,
    note: "test",
  });
  const at = (m: HedonicModel, conditionIndex: -1 | 0 | 1) =>
    expectedOverbidDetail(m, "Södermalm", 100_000, 110_000, { daysOnMarket: null, conditionIndex });

  it("a fitted and kept term moves ln(premium) by exactly beta x index", () => {
    const m = withCondition(fitted(true));
    const zero = at(m, 0);
    expect(Math.log(1 + at(m, -1).pct)).toBeCloseTo(Math.log(1 + zero.pct) - 0.02, 12);
    expect(Math.log(1 + at(m, 1).pct)).toBeCloseTo(Math.log(1 + zero.pct) + 0.02, 12);
    expect(at(m, -1).conditionUsed).toBe(true);
    expect(at(m, 1).conditionSource).toBe("fit");
  });

  it("index 0 adds exactly nothing and the label gets +skick only for a non-zero index", () => {
    const m = withCondition(fitted(true));
    expect(at(m, 0).pct).toBe(expectedOverbid(m, "Södermalm", 100_000, 110_000));
    expect(at(m, 0).conditionUsed).toBe(false);
    expect(at(m, 0).label).toBe("distrikt");
    expect(at(m, -1).label).toBe("distrikt+skick");
    expect(at(m, 1).label).toBe("distrikt+skick");
  });

  it("the +skick part sits after +dagar and before the unknown-days note", () => {
    const m = withCondition(fitted(true));
    m.bidPremium.terms.dom = { beta: -0.05, mean: 2.5, n: 400, kept: true, cvRmse: { without: 0.1, with: 0.09 }, note: "med" };
    expect(expectedOverbidDetail(m, "Södermalm", 100_000, 110_000, { daysOnMarket: 20, conditionIndex: -1 }).label).toBe("distrikt+dagar+skick");
    expect(expectedOverbidDetail(m, "Södermalm", 100_000, 110_000, { daysOnMarket: null, conditionIndex: -1 }).label).toBe("distrikt+skick, dagar okända");
  });

  it("no term, a prior term and a rejected term all behave as index 0 and say 'skick ej mätt' (R-08: no invented number)", () => {
    const baseline = at(withCondition(null), 0);
    const cases: Array<[string, Term | null]> = [
      ["absent", null],
      ["prior 0", fitted(true, "prior", 0)],
      ["prior with a non-zero beta must still not move the premium", fitted(true, "prior", 0.5)],
      ["rejected", fitted(false)],
    ];
    for (const [, term] of cases) {
      const m = withCondition(term);
      for (const index of [-1, 0, 1] as const) {
        const d = at(m, index);
        expect(d.pct).toBe(baseline.pct);
        expect(d.conditionUsed).toBe(false);
        expect(d.conditionSource).toBe("prior");
        expect(d.label.endsWith(", skick ej mätt")).toBe(true);
      }
    }
  });
});

describe("fitBidPremium: days on market (VAL-03)", () => {
  /** ln(1 + days) for days 1..90, plus rows with ln(1+p) = a_d + slopeB u + domBeta domLn + noise. */
  function domRows(opts: {
    seed: number;
    domBeta: number;
    slopeB?: number;
    withAsk?: boolean;
    perDistrict?: number;
    knownDaysShare?: number;
  }) {
    const g = lcg(opts.seed);
    const out: BidRow[] = [];
    for (const district of Object.keys(CENTRES) as District[]) {
      for (let i = 0; i < (opts.perDistrict ?? 120); i++) {
        const predLnKrm2 = CENTRES[district].level;
        const u = -0.1 + 0.12 * g.normal();
        const days = 1 + Math.floor(90 * g.uniform());
        const dl = Math.log(1 + days);
        const known = g.uniform() < (opts.knownDaysShare ?? 1);
        out.push({
          district,
          z: DISTRICT_A[district] + (opts.slopeB ?? 0) * u + opts.domBeta * dl + 0.02 * g.normal(),
          askLnKrm2: opts.withAsk === false ? null : predLnKrm2 + u,
          predLnKrm2,
          domLn: known ? dl : null,
        });
      }
    }
    return out;
  }
  type BidRow = { district: District; z: number; askLnKrm2: number | null; predLnKrm2: number; domLn: number | null };

  it("flat base: a real days effect is kept, recovered within 0.005, and lowers the CV error", () => {
    const fit = fitBidPremium(domRows({ seed: 11, domBeta: -0.02, withAsk: false }));
    expect(fit.kind).toBe("flat");
    const dom = fit.terms.dom;
    expect(dom).not.toBeNull();
    expect(dom!.kept).toBe(true);
    expect(Math.abs(dom!.beta + 0.02)).toBeLessThan(0.005);
    expect(dom!.cvRmse.with).toBeLessThan(dom!.cvRmse.without);
    expect(dom!.note).toMatch(/^med: korsvalidering \d,\d{4} -> \d,\d{4}$/);
    expect(dom!.n).toBe(480);
    expect(fit.terms.condition).toBeNull();
  });

  it("slope base: the days effect is found next to the asking-price slope", () => {
    const fit = fitBidPremium(domRows({ seed: 12, domBeta: -0.02, slopeB: -0.2 }));
    expect(fit.kind).toBe("slope");
    expect(fit.terms.dom!.kept).toBe(true);
    expect(Math.abs(fit.terms.dom!.beta + 0.02)).toBeLessThan(0.005);
    expect(Math.abs(fit.b! + 0.2)).toBeLessThan(0.05);
    expect(fit.terms.dom!.cvRmse.with).toBeLessThan(fit.terms.dom!.cvRmse.without);
  });

  const stripDays = (rows: readonly BidRow[]): BidRow[] => rows.map((r) => ({ ...r, domLn: null }));

  it("a days effect with the WRONG sign is rejected even though the CV error improves", () => {
    const rows = domRows({ seed: 13, domBeta: 0.03, withAsk: false });
    const fit = fitBidPremium(rows);
    const dom = fit.terms.dom!;
    expect(dom.beta).toBeGreaterThan(0);
    expect(dom.cvRmse.with).toBeLessThan(dom.cvRmse.without);
    expect(dom.kept).toBe(false);
    expect(dom.note).toBe("prövad, förkastad: fel tecken");
    // Rejected: kind, b and every intercept are exactly what they were without the term.
    const plain = fitBidPremium(stripDays(rows));
    expect(fit.kind).toBe(plain.kind);
    expect(fit.b).toBe(plain.b);
    expect(fit.overallA).toBe(plain.overallA);
    expect(fit.perDistrict).toEqual(plain.perDistrict);
  });

  it("pure-noise days are rejected on cross-validation and leave the base untouched", () => {
    for (const seed of [21, 22, 23, 24]) {
      const rows = domRows({ seed, domBeta: 0, withAsk: false });
      const fit = fitBidPremium(rows);
      const dom = fit.terms.dom!;
      expect(dom.kept, `seed ${seed}`).toBe(false);
      expect(dom.cvRmse.with, `seed ${seed}`).toBeGreaterThanOrEqual(dom.cvRmse.without);
      expect(dom.note, `seed ${seed}`).toBe("prövad, förkastad: korsvalidering");
      expect(fit.perDistrict).toEqual(fitBidPremium(stripDays(rows)).perDistrict);
    }
  });

  it("base and base-plus-days are scored on the same held-out rows: the 'without' error is the base form's own CV error", () => {
    // Flat base, no asking prices: every row is held out once.
    const flat = fitBidPremium(domRows({ seed: 31, domBeta: -0.02, withAsk: false }));
    expect(flat.terms.dom!.cvRmse.without).toBe(flat.cvRmse.flat);
    // Slope base: held-out rows are the ones with an asking price.
    const slope = fitBidPremium(domRows({ seed: 32, domBeta: -0.02, slopeB: -0.2 }));
    expect(slope.kind).toBe("slope");
    expect(slope.terms.dom!.cvRmse.without).toBe(slope.cvRmse.slope);
    // Mixed: a third of the rows lack an asking price and are never held out when a slope exists.
    const g = lcg(33);
    const mixed = domRows({ seed: 33, domBeta: -0.02, slopeB: 0 }).map((r) => (g.uniform() < 0.33 ? { ...r, askLnKrm2: null } : r));
    const m = fitBidPremium(mixed);
    expect(m.kind).toBe("flat");
    expect(m.terms.dom!.cvRmse.without).toBe(m.cvRmse.flat);
    const mixedSlope = domRows({ seed: 34, domBeta: -0.02, slopeB: -0.3 }).map((r) => (g.uniform() < 0.33 ? { ...r, askLnKrm2: null } : r));
    const ms = fitBidPremium(mixedSlope);
    expect(ms.kind).toBe("slope");
    expect(ms.terms.dom!.cvRmse.without).toBe(ms.cvRmse.slope);
  });

  it("fewer than MIN_DISTRICT_N rows with days (and an asking price) give no days term and an unchanged base", () => {
    const rows = domRows({ seed: 41, domBeta: -0.02, slopeB: -0.2, knownDaysShare: 0.04 });
    const withDays = rows.filter((r) => r.domLn !== null && r.askLnKrm2 !== null).length;
    expect(withDays).toBeLessThan(MIN_DISTRICT_N);
    expect(withDays).toBeGreaterThan(0);
    const fit = fitBidPremium(rows);
    expect(fit.terms.dom).toBeNull();
    expect(fit).toEqual(fitBidPremium(stripDays(rows)));
    // Rows with days but no asking price do not count towards a slope base's term.
    const noAsk = rows.map((r, i) => (i % 2 === 0 ? { ...r, domLn: Math.log(1 + (i % 60)) } : r));
    expect(fitBidPremium(noAsk).kind).toBe("slope");
  });

  it("no days at all gives no days term", () => {
    expect(fitBidPremium(stripDays(domRows({ seed: 42, domBeta: -0.02 }))).terms.dom).toBeNull();
    expect(fitBidPremium([]).terms.dom).toBeNull();
  });

  it("a flat base still tries the days term on days alone, even when asking prices exist", () => {
    // Asking prices are present but carry no information about the premium, so flat wins the base contest
    // (the seed is a fixed piece of test data; the test is about the days path on a flat base).
    const fit = fitBidPremium(domRows({ seed: 55, domBeta: -0.03, slopeB: 0 }));
    expect(fit.kind).toBe("flat");
    expect(fit.b).toBeNull();
    expect(fit.terms.dom!.kept).toBe(true);
    expect(Math.abs(fit.terms.dom!.beta + 0.03)).toBeLessThan(0.006);
  });

  it("is deterministic with the days term", () => {
    const rows = domRows({ seed: 61, domBeta: -0.02, slopeB: -0.2 });
    expect(fitBidPremium(rows)).toEqual(fitBidPremium(rows));
  });
});

describe("fitHedonicModel: bid premium and null labels (R-07)", () => {
  it("null labels are left out of the premium fit and their share is reported", () => {
    const rows = generateRows({ seed: 101, nullLabelShare: 0.3, askingShare: 0 });
    const { model, report } = fitHedonicModel(rows, OPTS);
    const kept = rows.length - report.droppedOutliers;
    const labelled = Object.values(model.bidPremium.perDistrict).reduce((s, d) => s + d.n, 0);
    expect(model.bidPremium.nullLabelShare).toBeCloseTo((kept - labelled) / kept, 12);
    expect(model.bidPremium.nullLabelShare).toBeGreaterThan(0.2);
    expect(model.bidPremium.nullLabelShare).toBeLessThan(0.4);
    // A null label is not "sold at asking": the fitted premium stays at the labelled level.
    expect(model.bidPremium.kind).toBe("flat");
    expect(Math.abs(model.bidPremium.perDistrict.Södermalm.a - DISTRICT_A.Södermalm)).toBeLessThan(0.02);
  });

  it("recovers the per-district premium from labelled rows", () => {
    const { model } = fitHedonicModel(generateRows({ seed: 102, askingShare: 0 }), OPTS);
    expect(model.bidPremium.kind).toBe("flat");
    for (const d of Object.keys(CENTRES) as District[]) {
      expect(Math.abs(model.bidPremium.perDistrict[d].a - DISTRICT_A[d])).toBeLessThan(0.02);
    }
    expect(model.bidPremium.cvRmse.flat).toBeGreaterThan(0.01);
    expect(model.bidPremium.cvRmse.slope).toBeNull();
  });

  it("with asking prices that are the label's own inverse, the slope form is tried and the result stays sane", () => {
    // Here ask = sold / (1 + premium), so the final price does not depend on the ask at all: the
    // honest slope is strongly negative. The point is that the fit handles it and stays valid.
    const { model } = fitHedonicModel(generateRows({ seed: 103 }), OPTS);
    expect(hedonicModelSchema.safeParse(model).success).toBe(true);
    expect(model.bidPremium.cvRmse.slope).not.toBeNull();
    if (model.bidPremium.kind === "slope") {
      expect(model.bidPremium.b!).toBeLessThan(0);
      expect(model.bidPremium.b!).toBeGreaterThan(-1.2);
      expect(model.bidPremium.cvRmse.slope!).toBeLessThan(model.bidPremium.cvRmse.flat);
    }
  });
});

describe("fitHedonicModel: cross-validation does not leak (T-14.1-13)", () => {
  it("rows whose twin sits in the same fold cannot be predicted from the twin", () => {
    // 100 isolated places (> 2 km apart), each sold twice with the same price. The twin of
    // row i is row i + 100, and 100 is a multiple of CV_FOLDS, so both always share a fold.
    const g = lcg(404);
    const first: HedonicTrainingRow[] = [];
    for (let i = 0; i < 100; i++) {
      const lat = Math.round((59.2 + (i % 10) * 0.02) * 1000) / 1000;
      const lng = Math.round((17.9 + Math.floor(i / 10) * 0.04) * 1000) / 1000;
      const price = Math.exp(11.6 + 0.2 * g.normal());
      first.push({
        district: "Södermalm",
        lat,
        lng,
        floor: 2,
        livingArea: 50,
        soldPrice: Math.round(price * 50),
        soldDate: "2026-04-12",
        soldVsAskPct: null,
        askingPrice: null,
        balcony: null,
        buildYear: null,
        enriched: false,
        avgiftPerSqmMonth: null,
        brfDebtPerSqm: null,
        tomtratt: null,
      });
    }
    const rows = [...first, ...first.map((r) => ({ ...r }))];
    expect(100 % CV_FOLDS).toBe(0);
    const { model } = fitHedonicModel(rows, OPTS);
    // Honest CV cannot see the twin, so it cannot beat the spread of the prices (about 0.2).
    expect(model.cvRmseLog).toBeGreaterThan(0.15);
  });
});

describe("fitHedonicModel: inputs", () => {
  it("refuses too few rows and unusable rows", () => {
    expect(() => fitHedonicModel(generateRows({ seed: 1, perDistrict: { Södermalm: 3, Kungsholmen: 3, Vasastan: 3, Östermalm: 3 } }), OPTS)).toThrow(/för få/i);
    const bad = generateRows({ seed: 2 });
    bad[0] = { ...bad[0], livingArea: 0 };
    expect(() => fitHedonicModel(bad, OPTS)).toThrow(/rad 0/);
    expect(() => fitHedonicModel(generateRows({ seed: 2 }), { ...OPTS, asOf: "12/10/2026" })).toThrow(/asOf/);
  });

  it("degenerate data (no floors at all, every flat at one spot) gives finite numbers and a valid model", () => {
    const rows = generateRows({ seed: 6 }).map((r) => ({ ...r, floor: null, lat: 59.315, lng: 18.07 }));
    const { model } = fitHedonicModel(rows, OPTS);
    expect(hedonicModelSchema.safeParse(model).success).toBe(true);
    const numbers = [
      model.intercept,
      model.r2,
      model.cvRmseLog,
      model.smearing,
      model.residualP75Log,
      ...model.features.flatMap((f) => [f.beta, f.mean, f.se ?? 0]),
    ];
    for (const v of numbers) expect(Number.isFinite(v)).toBe(true);
    const { krPerSqm } = predictKrPerSqm(model, {
      district: "Södermalm",
      latitude: 59.315,
      longitude: 18.07,
      floor: null,
      livingArea: 50,
      balcony: null,
      constructionYear: null,
      avgiftPerSqmMonth: null,
      brfDebtPerSqm: null,
      tomtratt: null,
    });
    expect(Number.isFinite(krPerSqm)).toBe(true);
    expect(krPerSqm).toBeGreaterThan(50_000);
    expect(krPerSqm).toBeLessThan(250_000);
  });

  it("a null floor is imputed at the mean and does not break the fit", () => {
    const rows = generateRows({ seed: 3 }).map((r, i) => (i % 10 === 0 ? { ...r, floor: null } : r));
    const { model } = fitHedonicModel(rows, OPTS);
    expect(hedonicModelSchema.safeParse(model).success).toBe(true);
    expect(Math.abs(featureOf(model, "floor").beta - Math.log(1.01))).toBeLessThan(0.006);
  });
});

describe("describeModel (D-18 plain language)", () => {
  const rows = generateRows({ seed: 2026, enrichedShare: 0.5, balconyEffect: Math.log(1.04), perDistrict: { Östermalm: 20 } });
  const { model } = fitHedonicModel(rows, OPTS);
  const lines = describeModel(model);

  it("gives at least six Swedish lines, none containing NaN or undefined", () => {
    expect(lines.length).toBeGreaterThanOrEqual(6);
    for (const line of lines) expect(line).not.toMatch(/NaN|undefined|Infinity/);
  });

  it("states the effect of one floor as a percent with a decimal comma", () => {
    const line = lines.find((l) => /våning upp/i.test(l));
    expect(line).toBeDefined();
    expect(line).toMatch(/[+-]\d+,\d %/);
    expect(line).toMatch(/källa: data/);
  });

  it("states the fitted size range", () => {
    const line = lines.find((l) => /Modellen bygger på/.test(l) && /kvm/.test(l));
    expect(line).toBeDefined();
    expect(line).toMatch(/\d+(,\d)?–\d+(,\d)?\s*kvm/);
  });

  it("names every fallback", () => {
    expect(model.fallbacks.length).toBeGreaterThan(0);
    for (const f of model.fallbacks) {
      expect(lines.some((l) => l.includes(f.item)), `no line names ${f.item}`).toBe(true);
    }
  });

  it("says when a coefficient came from the study instead of the data", () => {
    const flipped = fitHedonicModel(generateRows({ seed: 31, floorEffect: -0.02 }), OPTS).model;
    const floorLine = describeModel(flipped).find((l) => /våning upp/i.test(l));
    expect(floorLine).toMatch(/studie/);
  });

  it("reports the bid premium kind, the null-label share and the build-year buckets", () => {
    expect(lines.some((l) => /Budpremie/.test(l) && /Södermalm/.test(l))).toBe(true);
    expect(lines.some((l) => /saknar uppgift/.test(l))).toBe(true);
    expect(lines.some((l) => /Byggår/.test(l))).toBe(true);
  });

  it("rising prices read as a positive monthly change (monthsAgo counts backwards)", () => {
    const rising = structuredClone(model);
    const months = rising.features.find((f) => f.name === "monthsAgo")!;
    months.beta = -0.0085;
    months.se = 0.0003;
    months.source = "fit";
    const line = describeModel(rising).find((l) => /Prisutveckling per månad/.test(l))!;
    expect(line).toMatch(/≈ \+0,9 %/);
    expect(line).toMatch(/SE 0,0 %/);
    months.beta = 0.01;
    expect(describeModel(rising).find((l) => /Prisutveckling per månad/.test(l))).toMatch(/≈ -1,0 %/);
  });

  it("explains what the premium figures mean under the slope form", () => {
    const slope = structuredClone(model);
    slope.bidPremium.kind = "slope";
    slope.bidPremium.b = -0.19;
    const line = describeModel(slope).find((l) => /Budpremie/.test(l))!;
    expect(line).toMatch(/b = -0,19/);
    expect(line).toMatch(/lika med modellens pris/);
  });

  it("works on the synthetic fixture model too", () => {
    expect(describeModel(model).length).toBeGreaterThanOrEqual(6);
    expect(describeModel(parseHedonicModel(modelJson)).length).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// 14.4-03: avgift, BRF debt and tomträtt through the one feature seam (D-01, R-02)
// ---------------------------------------------------------------------------

describe("buildFeatureRow: the three 14.4 inputs (D-01 honesty rule)", () => {
  /** A copy of the fixture whose three new features have non-zero training means. */
  const withMeans = structuredClone(modelJson) as unknown as HedonicModel;
  for (const f of withMeans.features) {
    if (f.name === "avgiftPerSqmMonth") f.mean = 77;
    if (f.name === "brfDebtPerSqm") f.mean = 6300;
    if (f.name === "tomtratt") f.mean = 0;
  }

  it("known values enter as they are; a tomträtt flag becomes 0 or 1; nothing new is imputed", () => {
    const row = buildFeatureRow(withMeans, {
      ...FOLKUNGAGATAN,
      avgiftPerSqmMonth: 80,
      brfDebtPerSqm: 5000,
      tomtratt: false,
    });
    expect(row.x.avgiftPerSqmMonth).toBe(80);
    expect(row.x.brfDebtPerSqm).toBe(5000);
    expect(row.x.tomtratt).toBe(0);
    expect(row.imputed).not.toContain("avgiftPerSqmMonth");
    expect(row.imputed).not.toContain("brfDebtPerSqm");
    expect(row.imputed).not.toContain("tomtratt");
    expect(buildFeatureRow(withMeans, { ...FOLKUNGAGATAN, tomtratt: true }).x.tomtratt).toBe(1);
  });

  it("null values take the training mean and are named in imputed", () => {
    const row = buildFeatureRow(withMeans, {
      ...FOLKUNGAGATAN,
      avgiftPerSqmMonth: null,
      brfDebtPerSqm: null,
      tomtratt: null,
    });
    expect(row.x.avgiftPerSqmMonth).toBe(77);
    expect(row.x.brfDebtPerSqm).toBe(6300);
    expect(row.x.tomtratt).toBe(0);
    expect(row.imputed).toEqual(expect.arrayContaining(["avgiftPerSqmMonth", "brfDebtPerSqm", "tomtratt"]));
  });

  it("a null input adds exactly nothing to the prediction, a known one adds beta x (x - mean)", () => {
    const m = structuredClone(withMeans);
    for (const f of m.features) {
      if (f.name === "avgiftPerSqmMonth") f.beta = -0.004;
      if (f.name === "brfDebtPerSqm") f.beta = -0.00002;
    }
    const base = predictLnKrPerSqm(m, FOLKUNGAGATAN).lnKrPerSqm;
    const known = predictLnKrPerSqm(m, { ...FOLKUNGAGATAN, avgiftPerSqmMonth: 97, brfDebtPerSqm: 10300 }).lnKrPerSqm;
    expect(known - base).toBeCloseTo(-0.004 * 20 + -0.00002 * 4000, 9);
  });
});

describe("trainingFeatureMatrix: the 14.4 columns (D-01)", () => {
  const medians = { Södermalm: 11.5, Kungsholmen: 11.5, Vasastan: 11.5, Östermalm: 11.5 };
  const point = (i: number, extra: Partial<TrainingPoint>): TrainingPoint => ({
    district: "Södermalm",
    lat: 59.3 + i * 0.01,
    lng: 18.07,
    floor: 2,
    livingArea: 50,
    y: 11.5,
    monthsAgo: 0,
    avgiftPerSqmMonth: null,
    brfDebtPerSqm: null,
    tomtratt: null,
    ...extra,
  });
  const col = (name: (typeof HEDONIC_FEATURES)[number]) => HEDONIC_FEATURES.indexOf(name);

  it("means are over the KNOWN values: 30 rows with avgift 60 and 70 rows with none give mean 60", () => {
    const points = [
      ...Array.from({ length: 30 }, (_, i) => point(i, { avgiftPerSqmMonth: 60 })),
      ...Array.from({ length: 70 }, (_, i) => point(30 + i, {})),
    ];
    const { ctx, X, colMeans } = trainingFeatureMatrix(points, medians);
    expect(ctx.means.avgiftPerSqmMonth).toBe(60);
    expect(X[99][col("avgiftPerSqmMonth")]).toBe(60);
    expect(colMeans[col("avgiftPerSqmMonth")]).toBeCloseTo(60, 9);
  });

  it("tomträtt: known true/false give a 0/1 column whose mean is over the known values only", () => {
    const points = [
      point(0, { tomtratt: true }),
      point(1, { tomtratt: false }),
      point(2, { tomtratt: false }),
      point(3, { tomtratt: false }),
      point(4, {}),
    ];
    const { ctx, X } = trainingFeatureMatrix(points, medians);
    expect(ctx.means.tomtratt).toBeCloseTo(0.25, 12);
    expect(X.map((r) => r[col("tomtratt")])).toEqual([1, 0, 0, 0, 0.25]);
  });

  it("train/serve parity: the same input gives the same new feature values on both sides", () => {
    const g = lcg(77);
    const points = Array.from({ length: 60 }, (_, i) =>
      point(i, {
        avgiftPerSqmMonth: i % 3 === 0 ? null : 50 + g.uniform() * 60,
        brfDebtPerSqm: i % 4 === 0 ? null : Math.round(g.uniform() * 12_000),
        tomtratt: i % 5 === 0 ? null : i % 7 === 0,
      }),
    );
    const { X, colMeans, kernel, ctx } = trainingFeatureMatrix(points, medians);
    const served = structuredClone(modelJson) as unknown as HedonicModel;
    served.kernel = kernel;
    served.features.forEach((f) => {
      f.mean = colMeans[HEDONIC_FEATURES.indexOf(f.name)];
      // The persisted model carries the clamp bounds; serving reads them from there (task 2).
      const b = ctx.bounds?.[f.name];
      if (b !== undefined) {
        f.lo = b.lo;
        f.hi = b.hi;
      }
    });
    points.forEach((p, i) => {
      const row = buildFeatureRow(served, {
        district: p.district,
        latitude: p.lat,
        longitude: p.lng,
        floor: p.floor,
        livingArea: p.livingArea,
        balcony: null,
        constructionYear: null,
        avgiftPerSqmMonth: p.avgiftPerSqmMonth,
        brfDebtPerSqm: p.brfDebtPerSqm,
        tomtratt: p.tomtratt,
      });
      for (const name of ["avgiftPerSqmMonth", "brfDebtPerSqm", "tomtratt"] as const) {
        expect(row.x[name], `${name} row ${i}`).toBeCloseTo(X[i][col(name)], 9);
      }
    });
  });
});

describe("fitHedonicModel: avgift and BRF debt as fitted features (D-01)", () => {
  const rows = generateRows({
    seed: 14_4,
    centralityEffect: 0,
    newFeatures: { knownShare: 0.5, avgiftEffect: -0.004, debtEffect: -0.00002 },
  });
  const { model } = fitHedonicModel(rows, OPTS);

  it("lists exactly nine features, version 2, in the shared order", () => {
    expect(model.version).toBe(2);
    expect(model.features.map((f) => f.name)).toEqual([...HEDONIC_FEATURES]);
    expect(hedonicModelSchema.safeParse(model).success).toBe(true);
    expect(model.bidPremium.terms).toEqual({ dom: null, condition: null });
  });

  it("recovers a negative avgift coefficient with a finite standard error", () => {
    const f = featureOf(model, "avgiftPerSqmMonth");
    expect(f.source).toBe("fit");
    expect(Math.abs(f.beta - -0.004)).toBeLessThan(0.001);
    expect(f.se).not.toBeNull();
    expect(Number.isFinite(f.se!)).toBe(true);
    expect(f.se!).toBeGreaterThan(0);
  });

  it("recovers a negative BRF-debt coefficient", () => {
    const f = featureOf(model, "brfDebtPerSqm");
    expect(f.source).toBe("fit");
    expect(Math.abs(f.beta - -0.00002)).toBeLessThan(0.000005);
  });

  it("the stored mean of each new feature is the mean of the KNOWN values", () => {
    const known = rows.filter((r) => r.avgiftPerSqmMonth !== null).map((r) => r.avgiftPerSqmMonth as number);
    const knownMean = known.reduce((a, b) => a + b, 0) / known.length;
    expect(Math.abs(featureOf(model, "avgiftPerSqmMonth").mean - knownMean)).toBeLessThan(1.5);
  });

  it("a flat with a higher avgift is predicted cheaper, one with an unknown avgift sits in between and is flagged", () => {
    const at = (avgift: number | null) =>
      predictKrPerSqm(model, { ...FOLKUNGAGATAN, floor: 3, livingArea: 50, avgiftPerSqmMonth: avgift, brfDebtPerSqm: null, tomtratt: null });
    expect(at(110).krPerSqm).toBeLessThan(at(null).krPerSqm);
    expect(at(null).krPerSqm).toBeLessThan(at(45).krPerSqm);
    expect(at(null).imputed).toContain("avgiftPerSqmMonth");
    expect(at(80).imputed).not.toContain("avgiftPerSqmMonth");
  });

  it("the older coefficients do not move when the new columns are all unknown", () => {
    const plain = generateRows({ seed: 2026, centralityEffect: 0 });
    const { model: m } = fitHedonicModel(plain, OPTS);
    expect(featureOf(m, "avgiftPerSqmMonth").beta).toBe(0);
    expect(featureOf(m, "brfDebtPerSqm").beta).toBe(0);
    expect(featureOf(m, "tomtratt").beta).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 14.4-03 task 2: honest outcomes (R-02 zero spread, clamps, raw estimates)
// ---------------------------------------------------------------------------

describe("fitHedonicModel: a feature the data cannot estimate is recorded as absent (R-02)", () => {
  const withKnown = generateRows({
    seed: 902,
    centralityEffect: 0,
    newFeatures: { knownShare: 0.5, avgiftEffect: -0.004, debtEffect: -0.00002 },
  });

  it("tomträtt with only 'false' among the known values: beta 0, no SE, zeroed, with the true reason", () => {
    const { model } = fitHedonicModel(withKnown, OPTS);
    const f = featureOf(model, "tomtratt");
    expect(f.beta).toBe(0);
    expect(f.se).toBeNull();
    expect(f.source).toBe("zeroed");
    const hit = model.fallbacks.find((x) => x.item === "tomtratt");
    expect(hit).toEqual({
      item: "tomtratt",
      reason: "absent",
      detail: "tomträtt: inga tomträttsförsäljningar i underlaget (upplåtelseform är Bostadsrätt på alla sålda sidor)",
    });
    expect(model.fallbacks.filter((x) => x.item === "tomtratt")).toHaveLength(1);
    expect(JSON.stringify(model.fallbacks.filter((x) => x.item === "tomtratt"))).not.toMatch(/osäker uppskattning/);
  });

  it("fewer than MIN_FIT_ROWS known avgift values also gives 'absent', naming the known count", () => {
    const rows = withKnown.map((r, i) => (i < 12 ? r : { ...r, avgiftPerSqmMonth: null }));
    const knownAvgift = rows.filter((r) => r.avgiftPerSqmMonth !== null).length;
    expect(knownAvgift).toBeLessThan(MIN_FIT_ROWS);
    const { model } = fitHedonicModel(rows, OPTS);
    const f = featureOf(model, "avgiftPerSqmMonth");
    expect(f.beta).toBe(0);
    expect(f.source).toBe("zeroed");
    const hit = model.fallbacks.find((x) => x.item === "avgiftPerSqmMonth")!;
    expect(hit.reason).toBe("absent");
    expect(hit.detail).toContain(`(${knownAvgift};`);
    expect(hit.detail).toMatch(/för få kända värden/);
  });

  it("a zero-spread column does not move any other coefficient (within 1e-9)", () => {
    const allNull = withKnown.map((r) => ({ ...r, tomtratt: null }));
    const a = fitHedonicModel(withKnown, OPTS).model;
    const b = fitHedonicModel(allNull, OPTS).model;
    for (const name of HEDONIC_FEATURES) {
      expect(Math.abs(featureOf(a, name).beta - featureOf(b, name).beta), name).toBeLessThan(1e-9);
    }
  });

  it("describeModel says tomträtt cannot be estimated and that the effect is zero", () => {
    const { model } = fitHedonicModel(withKnown, OPTS);
    const line = describeModel(model).find((l) => /^Tomträtt/.test(l))!;
    expect(line).toMatch(/kan inte skattas/);
    expect(line).not.toMatch(/osäker/);
  });
});

describe("percentile clamps of the continuous 14.4 features", () => {
  const medians = { Södermalm: 11.5, Kungsholmen: 11.5, Vasastan: 11.5, Östermalm: 11.5 };
  const point = (i: number, avgift: number | null): TrainingPoint => ({
    district: "Södermalm",
    lat: 59.3 + i * 0.001,
    lng: 18.07,
    floor: 2,
    livingArea: 50,
    y: 11.5,
    monthsAgo: 0,
    avgiftPerSqmMonth: avgift,
    brfDebtPerSqm: null,
    tomtratt: null,
  });
  // avgift 1..100, one each, in order.
  const points = Array.from({ length: 100 }, (_, i) => point(i, i + 1));
  const { ctx, X } = trainingFeatureMatrix(points, medians);
  const col = HEDONIC_FEATURES.indexOf("avgiftPerSqmMonth");

  it("the bounds are the 1st and 99th percentile of the sorted known values", () => {
    expect(ctx.bounds?.avgiftPerSqmMonth?.lo).toBeCloseTo(1.99, 9);
    expect(ctx.bounds?.avgiftPerSqmMonth?.hi).toBeCloseTo(99.01, 9);
  });

  it("training values are clamped to the bounds and the mean is computed after clamping", () => {
    expect(X[0][col]).toBeCloseTo(1.99, 9);
    expect(X[99][col]).toBeCloseTo(99.01, 9);
    // 98 untouched values 2..99 plus 1.99 and 99.01: the clamped mean is still 50.5.
    expect(ctx.means.avgiftPerSqmMonth).toBeCloseTo(50.5, 9);
    // One absurd value among 200 would drag an unclamped mean to about 5 000; clamped it barely moves.
    const skewed = [...Array.from({ length: 199 }, (_, i) => point(i, i + 1)), point(199, 1_000_000)];
    const clamped = trainingFeatureMatrix(skewed, medians).ctx.means.avgiftPerSqmMonth;
    expect(clamped).toBeLessThan(120);
  });

  it("a prediction input of 500 is clamped to hi and -5 to lo, through the model's stored bounds", () => {
    const m = structuredClone(modelJson) as unknown as HedonicModel;
    const f = m.features.find((x) => x.name === "avgiftPerSqmMonth")!;
    f.lo = ctx.bounds!.avgiftPerSqmMonth!.lo;
    f.hi = ctx.bounds!.avgiftPerSqmMonth!.hi;
    f.mean = ctx.means.avgiftPerSqmMonth;
    expect(buildFeatureRow(m, { ...FOLKUNGAGATAN, avgiftPerSqmMonth: 500 }).x.avgiftPerSqmMonth).toBeCloseTo(99.01, 9);
    expect(buildFeatureRow(m, { ...FOLKUNGAGATAN, avgiftPerSqmMonth: -5 }).x.avgiftPerSqmMonth).toBeCloseTo(1.99, 9);
    expect(buildFeatureRow(m, { ...FOLKUNGAGATAN, avgiftPerSqmMonth: 50 }).x.avgiftPerSqmMonth).toBe(50);
  });

  it("a fitted model stores lo and hi on the two continuous features, never on the others", () => {
    const { model } = fitHedonicModel(
      generateRows({ seed: 903, centralityEffect: 0, newFeatures: { knownShare: 0.5, avgiftEffect: -0.004, debtEffect: -0.00002 } }),
      OPTS,
    );
    for (const name of ["avgiftPerSqmMonth", "brfDebtPerSqm"] as const) {
      const f = featureOf(model, name);
      expect(f.lo, name).toBeDefined();
      expect(f.hi, name).toBeDefined();
      expect(f.hi!).toBeGreaterThan(f.lo!);
      expect(f.mean).toBeGreaterThanOrEqual(f.lo!);
      expect(f.mean).toBeLessThanOrEqual(f.hi!);
    }
    expect(featureOf(model, "floor").lo).toBeUndefined();
    expect(featureOf(model, "tomtratt").lo).toBeUndefined();
  });

  it("an extreme avgift cannot pull a prediction outside the training range", () => {
    const { model } = fitHedonicModel(
      generateRows({ seed: 904, centralityEffect: 0, newFeatures: { knownShare: 0.5, avgiftEffect: -0.004, debtEffect: -0.00002 } }),
      OPTS,
    );
    const at = (a: number) => predictKrPerSqm(model, { ...FOLKUNGAGATAN, avgiftPerSqmMonth: a, brfDebtPerSqm: null, tomtratt: null }).krPerSqm;
    expect(at(10_000)).toBeCloseTo(at(featureOf(model, "avgiftPerSqmMonth").hi!), 9);
  });
});

describe("fitHedonicModel report: raw estimates before the guard (VAL-02)", () => {
  it("carries beta, se and t of the new features from the stage-1 fit, and the known-value counts", () => {
    const rows = generateRows({ seed: 905, centralityEffect: 0, newFeatures: { knownShare: 0.5, avgiftEffect: -0.004, debtEffect: -0.00002 } });
    const { model, report } = fitHedonicModel(rows, OPTS);
    const raw = report.rawEstimates.avgiftPerSqmMonth!;
    // The raw estimate is the first fit; the final one is refitted if the guard replaced another feature.
    expect(raw.beta).toBeCloseTo(featureOf(model, "avgiftPerSqmMonth").beta, 3);
    expect(raw.se).toBeGreaterThan(0);
    expect(raw.t).toBeCloseTo(raw.beta / raw.se!, 9);
    expect(report.rawEstimates.brfDebtPerSqm).toBeDefined();
    // The absent feature has no estimate to show.
    expect(report.rawEstimates.tomtratt).toBeUndefined();
    const knownAvgift = rows.filter((r) => r.avgiftPerSqmMonth !== null).length;
    expect(Math.abs(report.knownCounts.avgiftPerSqmMonth! - knownAvgift)).toBeLessThanOrEqual(5);
    expect(report.knownCounts.tomtratt).toBe(report.knownCounts.avgiftPerSqmMonth);
  });

  it("keeps the raw estimate of a coefficient the guard then zeroed (wrong sign is visible)", () => {
    // A positive true avgift effect points the wrong way against the expected sign.
    const rows = generateRows({ seed: 906, centralityEffect: 0, newFeatures: { knownShare: 0.6, avgiftEffect: 0.006 } });
    const { model, report } = fitHedonicModel(rows, OPTS);
    expect(report.rawEstimates.avgiftPerSqmMonth!.beta).toBeGreaterThan(0.003);
    expect(featureOf(model, "avgiftPerSqmMonth").beta).toBe(0);
    expect(featureOf(model, "avgiftPerSqmMonth").source).toBe("zeroed");
    expect(model.fallbacks.find((f) => f.item === "avgiftPerSqmMonth")!.reason).toBe("wrong-sign");
  });
});
