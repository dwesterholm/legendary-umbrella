import { describe, it, expect } from "vitest";
import modelJson from "@/lib/discovery/__fixtures__/hedonic-model.fixture.json";
import {
  CENTRALITY_HUBS,
  buildFeatureRow,
  expectedOverbid,
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
