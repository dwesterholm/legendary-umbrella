/**
 * hedonic-model.ts - the persisted hedonic price model (Phase 14.1, FIT-02/FIT-03):
 * its zod-validated JSON shape, the feature build for one candidate, the
 * prediction in kr/m2, the renovated-value cap and the expected overbid.
 *
 * PURE, synchronous - no clock, no randomness, no network, no async, no file or
 * environment access. The model arrives as an already-read JSON value and goes
 * through {@link parseHedonicModel}; the same input always yields the same
 * output. There is NO fitting code here: 14.1-05 adds `fitHedonicModel`, which
 * must emit exactly the shape {@link hedonicModelSchema} accepts.
 *
 * STRUCTURAL SEPARATION (LOCKED): this module lives on the analysis path next
 * to `flip-economics.ts`. `niche-score.ts` and `report/flags.ts` must NEVER
 * import it (a model price must not silently become a deterministic scored
 * signal). The static-grep invariant in `niche-score.test.ts` enforces that;
 * this module's specifier is registered there.
 *
 * HONESTY RULE: a null input (floor, coordinates, balcony, build year) is never
 * turned into a made-up value. It is marginalised at the training mean (or the
 * district median for location), which adds nothing to the prediction, and the
 * feature name is returned in `imputed` so the caller can show it.
 */

import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The four districts the model is fitted for (innerstan). */
export const INNERSTAN_DISTRICTS = ["Södermalm", "Kungsholmen", "Vasastan", "Östermalm"] as const;
export type InnerstanDistrict = (typeof INNERSTAN_DISTRICTS)[number];

/** The six regression features, in the order the model file lists them. */
export const HEDONIC_FEATURES = [
  "nbLevel",
  "floor",
  "groundOrBelow",
  "lnArea",
  "monthsAgo",
  "centralityKm",
] as const;
export type HedonicFeature = (typeof HEDONIC_FEATURES)[number];

/** Floors above this are treated as this floor (view/quiet saturates; thin data above). */
export const FLOOR_CLIP_MAX = 6;

/** Mean Earth radius in metres, for {@link haversineMeters}. */
const EARTH_RADIUS_M = 6_371_000;

/**
 * MARKET centrality hubs: where Stockholm buyers pay for being close, NOT the
 * hubs Daniel personally likes (those live in `taste.ts`; mixing the two would
 * double count taste inside the market price). Coordinates are approximate
 * [ASSUMED]: good to a few tens of metres, which is far inside the model's own
 * noise.
 */
export const CENTRALITY_HUBS: readonly { readonly name: string; readonly lat: number; readonly lng: number }[] = [
  { name: "Stureplan", lat: 59.3355, lng: 18.0739 },
  { name: "T-Centralen", lat: 59.3313, lng: 18.0598 },
  { name: "Medborgarplatsen", lat: 59.3143, lng: 18.0735 },
  { name: "Hornstull", lat: 59.3157, lng: 18.034 },
  { name: "Odenplan", lat: 59.3429, lng: 18.0497 },
  { name: "Fridhemsplan", lat: 59.3335, lng: 18.029 },
];

// ---------------------------------------------------------------------------
// Persisted model shape (zod v4)
// ---------------------------------------------------------------------------

const num = z.number().finite();

/** One value per district; every district is required so a lookup never misses. */
function perDistrict<T extends z.ZodType>(value: T) {
  return z.object({
    Södermalm: value,
    Kungsholmen: value,
    Vasastan: value,
    Östermalm: value,
  });
}

const featureSchema = z.object({
  name: z.enum(HEDONIC_FEATURES),
  /** Training mean of the feature (centred form: x enters as x - mean). */
  mean: num,
  beta: num,
  se: num.nullable(),
  source: z.enum(["fit", "prior", "zeroed"]),
  note: z.string().optional(),
});

/**
 * The persisted model. `lnKrPerSqm = intercept + sum(beta_j * (x_j - mean_j))`,
 * for a sale at `asOf` (monthsAgo = 0). Every number must be finite; the
 * refinements below reject a file that would produce nonsense downstream.
 */
export const hedonicModelSchema = z
  .object({
    version: z.literal(1),
    fittedAt: z.string().min(1),
    /** "YYYY-MM-DD"; predictions are for monthsAgo = 0 at this date. */
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    n: num.min(0),
    r2: num,
    cvRmseLog: num.min(0),
    residualSdLog: num.min(0),
    /** Retransformation (smearing) factor for exp(ln-prediction); at least 1. */
    smearing: num.min(1),
    residualP75Log: num.min(0),
    /** Living-area range (m2) of the rows the model was fitted on (R-12). */
    minLivingArea: num.positive(),
    maxLivingArea: num,
    intercept: num,
    features: z.array(featureSchema),
    kernel: z.object({
      bandwidthM: num.positive(),
      cutoffM: num.positive(),
      minWeight: num.min(0),
      /** [lat (3 dp), lng (3 dp), lnKrPerSqm] */
      points: z.array(z.tuple([num, num, num])),
    }),
    districtLnMedian: perDistrict(num),
    stage2: z.object({
      balcony: z.object({ pct: num, source: z.enum(["fit", "prior"]) }),
      buildYear: z
        .object({
          pctByBucket: z.object({
            le1930: num,
            y1931to1960: num,
            y1961to1990: num,
            ge1991: num,
          }),
          source: z.literal("fit"),
        })
        .nullable(),
    }),
    bidPremium: z.object({
      kind: z.enum(["flat", "slope"]),
      perDistrict: perDistrict(
        z.object({ a: num, n: num.min(0), source: z.enum(["fit", "fallback"]) }),
      ),
      b: num.nullable(),
      overallA: num,
      cvRmse: z.object({ flat: num, slope: num.nullable() }),
      nullLabelShare: num,
    }),
    fallbacks: z.array(
      z.object({
        item: z.string(),
        reason: z.enum(["wrong-sign", "unstable", "small-n", "absent"]),
        detail: z.string(),
      }),
    ),
    /** Free-text provenance, e.g. "synthetic test model, not fitted on real sales". */
    note: z.string().optional(),
  })
  .refine((m) => m.maxLivingArea >= m.minLivingArea, {
    message: "maxLivingArea must be >= minLivingArea",
    path: ["maxLivingArea"],
  })
  .refine(
    (m) =>
      HEDONIC_FEATURES.every((name) => m.features.filter((f) => f.name === name).length === 1),
    { message: "features must list each of the six features exactly once", path: ["features"] },
  );

export type HedonicModel = z.infer<typeof hedonicModelSchema>;

/** Parses an untrusted JSON value into a model, or throws one readable Error. */
export function parseHedonicModel(json: unknown): HedonicModel {
  const result = hedonicModelSchema.safeParse(json);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
  throw new Error(`Invalid hedonic model: ${issues}`);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Great-circle distance in metres between two lat/lng points (degrees). */
export function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Gaussian-kernel neighbourhood level at a point: the weighted mean ln(kr/m2)
 * of the training sales within `cutoffM`, with weight exp(-d^2 / (2 h^2)).
 * `weight` is the summed weight (how much evidence stands behind `level`);
 * zero weight means no neighbour in range and `level` is meaningless.
 */
export function kernelLevel(
  kernel: HedonicModel["kernel"],
  lat: number,
  lng: number,
): { readonly level: number; readonly weight: number } {
  const twoH2 = 2 * kernel.bandwidthM * kernel.bandwidthM;
  let weight = 0;
  let weighted = 0;
  for (const [pLat, pLng, y] of kernel.points) {
    const d = haversineMeters(lat, lng, pLat, pLng);
    if (d > kernel.cutoffM) continue;
    const w = Math.exp(-(d * d) / twoH2);
    weight += w;
    weighted += w * y;
  }
  return weight > 0 ? { level: weighted / weight, weight } : { level: 0, weight: 0 };
}

/** Distance in km from a point to the nearest {@link CENTRALITY_HUBS} entry. */
function nearestHubKm(lat: number, lng: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (const hub of CENTRALITY_HUBS) {
    best = Math.min(best, haversineMeters(lat, lng, hub.lat, hub.lng));
  }
  return best / 1000;
}

// ---------------------------------------------------------------------------
// Features and prediction
// ---------------------------------------------------------------------------

/** What the model needs to know about one candidate (nullable where the candidate is). */
export interface HedonicInput {
  readonly district: InnerstanDistrict;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly floor: number | null;
  /** m2; callers guarantee a finite value above zero (fit-score.ts checks first). */
  readonly livingArea: number;
  readonly balcony: boolean | null;
  readonly constructionYear: number | null;
}

export interface FeatureRow {
  readonly x: Readonly<Record<HedonicFeature, number>>;
  /** Names of inputs that were unknown and marginalised at the training mean. */
  readonly imputed: readonly string[];
}

function meanOf(model: HedonicModel, name: HedonicFeature): number {
  const f = model.features.find((feature) => feature.name === name);
  // The schema guarantees presence; the fallback only keeps the type honest.
  return f ? f.mean : 0;
}

/**
 * Builds the six feature values for one candidate. Unknown inputs take the
 * training mean (contributing exactly nothing) and are listed in `imputed`.
 * monthsAgo is always 0: the prediction is for a sale today.
 */
export function buildFeatureRow(model: HedonicModel, input: HedonicInput): FeatureRow {
  if (!Number.isFinite(input.livingArea) || input.livingArea <= 0) {
    throw new RangeError("buildFeatureRow needs a finite livingArea above zero");
  }
  const imputed: string[] = [];
  const hasCoords = input.latitude !== null && input.longitude !== null;

  let nbLevel = model.districtLnMedian[input.district];
  let nbFromKernel = false;
  if (hasCoords) {
    const { level, weight } = kernelLevel(model.kernel, input.latitude!, input.longitude!);
    if (weight > 0 && weight >= model.kernel.minWeight) {
      nbLevel = level;
      nbFromKernel = true;
    }
  }
  if (!nbFromKernel) imputed.push("nbLevel");

  let floor: number;
  let groundOrBelow: number;
  if (input.floor === null) {
    floor = meanOf(model, "floor");
    groundOrBelow = meanOf(model, "groundOrBelow");
    imputed.push("floor");
  } else {
    floor = Math.min(Math.max(input.floor, 0), FLOOR_CLIP_MAX);
    groundOrBelow = input.floor <= 0 ? 1 : 0;
  }

  let centralityKm: number;
  if (hasCoords) {
    centralityKm = nearestHubKm(input.latitude!, input.longitude!);
  } else {
    centralityKm = meanOf(model, "centralityKm");
    imputed.push("centralityKm");
  }

  return {
    x: {
      nbLevel,
      floor,
      groundOrBelow,
      lnArea: Math.log(input.livingArea),
      monthsAgo: 0,
      centralityKm,
    },
    imputed,
  };
}

/** ln(kr/m2) from the regression terms alone (no smearing, no stage-2 terms). */
export function predictLnKrPerSqm(
  model: HedonicModel,
  input: HedonicInput,
): { readonly lnKrPerSqm: number; readonly imputed: readonly string[] } {
  const { x, imputed } = buildFeatureRow(model, input);
  let ln = model.intercept;
  for (const f of model.features) ln += f.beta * (x[f.name] - f.mean);
  return { lnKrPerSqm: ln, imputed };
}

/** The stage-2 build-year bucket key for a construction year. */
function buildYearBucket(
  year: number,
): keyof NonNullable<HedonicModel["stage2"]["buildYear"]>["pctByBucket"] {
  if (year <= 1930) return "le1930";
  if (year <= 1960) return "y1931to1960";
  if (year <= 1990) return "y1961to1990";
  return "ge1991";
}

/**
 * Predicted market price per m2 today: exp(ln-prediction) x smearing x the
 * stage-2 multipliers. Balcony true multiplies by 1 + pct; false or unknown
 * leaves the price alone (unknown is also listed in `imputed`). The build-year
 * multiplier applies only when the model has that term AND the year is known.
 */
export function predictKrPerSqm(
  model: HedonicModel,
  input: HedonicInput,
): { readonly krPerSqm: number; readonly imputed: readonly string[] } {
  const { lnKrPerSqm, imputed } = predictLnKrPerSqm(model, input);
  const notes = [...imputed];
  let price = Math.exp(lnKrPerSqm) * model.smearing;

  if (input.balcony === true) price *= 1 + model.stage2.balcony.pct;
  else if (input.balcony === null) notes.push("balcony");

  const by = model.stage2.buildYear;
  if (by !== null) {
    if (input.constructionYear === null) notes.push("buildYear");
    else price *= 1 + by.pctByBucket[buildYearBucket(input.constructionYear)];
  }
  return { krPerSqm: price, imputed: notes };
}

/**
 * Upper bound on what a renovated flat of this kind fetches per m2: the point
 * prediction lifted by the model's 75th-percentile residual. Feeds valueGap's
 * `renovatedCapPerSqm` so condition can never explain more than the market has
 * actually paid at the top of its own scatter.
 */
export function renovatedCapKrPerSqm(model: HedonicModel, predKrPerSqm: number): number {
  return predKrPerSqm * Math.exp(model.residualP75Log);
}

/**
 * Expected overbid over asking, as a fraction (0.08 = pays 8 % over). "flat":
 * exp(a_district) - 1. "slope": exp(a_district + b x (ln asking - ln pred)) - 1,
 * so a flat asked below the model's price draws a larger bid. A slope model
 * without a `b` behaves as flat.
 */
export function expectedOverbid(
  model: HedonicModel,
  district: InnerstanDistrict,
  askingKrPerSqm: number,
  predKrPerSqm: number,
): number {
  const bid = model.bidPremium;
  const a = bid.perDistrict[district].a;
  if (bid.kind === "slope" && bid.b !== null) {
    return Math.exp(a + bid.b * (Math.log(askingKrPerSqm) - Math.log(predKrPerSqm))) - 1;
  }
  return Math.exp(a) - 1;
}

// ---------------------------------------------------------------------------
// Fitting: constants
// ---------------------------------------------------------------------------

/**
 * Ridge penalty on STANDARDISED features (each column centred and divided by its
 * own standard deviation), so one number means the same for every feature. The
 * intercept is never penalised. In plain words: a small leash that stops two
 * features which move together (for example "floor" and "ground floor") from
 * taking huge opposite values to explain the same thing.
 */
export const HEDONIC_RIDGE_LAMBDA = 1;

/**
 * Floor under the penalty. It is always added to the diagonal, so a duplicated
 * or all-zero column leaves a matrix the Cholesky routine can still factor
 * instead of a division by zero (FIT-02 singular-matrix probe).
 */
export const HEDONIC_MIN_LAMBDA = 1e-8;

/** |beta / se| below this means the coefficient is not distinguishable from noise. */
export const HEDONIC_MIN_T = 1;

/** Fewer rows than this in a district and its median / bid premium is borrowed (R-07). */
export const MIN_DISTRICT_N = 30;

/** Cross-validation folds; a row's fold is its index modulo this (deterministic). */
export const CV_FOLDS = 5;

/** Neighbour-level kernel (RESEARCH A6): 300 m bandwidth, 1 km cut-off, weight floor 0.5. */
export const KERNEL_BANDWIDTH_M = 300;
export const KERNEL_CUTOFF_M = 1000;
export const KERNEL_MIN_WEIGHT = 0.5;

/** Balcony and build-year effects are never allowed to exceed this (RESEARCH Pattern 1, item 5). */
export const STAGE2_CAP_PCT = 0.08;

/** A row is an outlier when |residual - median| exceeds this many robust standard deviations. */
export const OUTLIER_MAD_K = 3;

/** Fewest usable rows fitHedonicModel will work with; below this a fit says nothing. */
export const MIN_FIT_ROWS = 20;

// ---------------------------------------------------------------------------
// Fitting: linear algebra (no dependency, R-09)
// ---------------------------------------------------------------------------

/**
 * Solves A x = b for a symmetric positive-definite A by Cholesky factorisation
 * (A = L Lᵀ, then two triangular solves). Only the lower triangle of A is read.
 * Inputs are not modified. Throws when a pivot is not strictly positive, which
 * is how a singular or indefinite matrix announces itself; a NaN anywhere also
 * fails the pivot test, so NaN can never leak out as an answer.
 */
export function choleskySolve(A: number[][], b: number[]): number[] {
  const n = b.length;
  if (A.length !== n || A.some((row) => row.length !== n)) {
    throw new RangeError("Cholesky: matrisen och högerledet har olika storlek");
  }
  const L: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (!(sum > 0)) throw new Error("Cholesky: matrisen är inte positivt definit");
        L[i][i] = Math.sqrt(sum);
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }
  const z = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= L[i][k] * z[k];
    z[i] = sum / L[i][i];
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = z[i];
    for (let k = i + 1; k < n; k++) sum -= L[k][i] * x[k];
    x[i] = sum / L[i][i];
  }
  return x;
}

export interface RidgeFit {
  /** Slopes on the ORIGINAL feature scale. */
  readonly beta: number[];
  /** Intercept for un-centred use: y ≈ intercept + Σ beta_j · x_j. */
  readonly intercept: number;
  /** Standard errors on the original feature scale (ridge approximation, see fitRidge). */
  readonly se: number[];
  readonly r2: number;
  readonly rmse: number;
}

/**
 * Ridge-stabilised ordinary least squares with an unpenalised intercept.
 *
 * Steps: centre y and every column, divide each column by its standard deviation
 * (a zero-spread column keeps scale 1 and becomes all zeros, so it gets slope
 * exactly 0), solve (ZᵀZ + λI) β = Zᵀy by Cholesky with λ = max(lambda,
 * HEDONIC_MIN_LAMBDA), then undo the scaling.
 *
 * Standard errors use the usual ridge approximation se² = s² · diag((ZᵀZ + λI)⁻¹)
 * with s² = RSS / max(1, n - k - 1). With a small λ this is the ordinary OLS
 * standard error; with a large λ it is a little too small (the shrinkage bias is
 * not in it), which is why the sign guard asks for |t| >= 1 and not 2.
 */
export function fitRidge(X: number[][], y: number[], lambda: number): RidgeFit {
  const n = y.length;
  if (n === 0 || X.length !== n) {
    throw new RangeError("fitRidge: X och y måste ha samma antal rader och minst en rad");
  }
  const k = X[0].length;
  if (X.some((row) => row.length !== k)) {
    throw new RangeError("fitRidge: alla rader i X måste ha lika många kolumner");
  }
  if (!Number.isFinite(lambda) || y.some((v) => !Number.isFinite(v)) || X.some((row) => row.some((v) => !Number.isFinite(v)))) {
    throw new RangeError("fitRidge: indata måste vara ändliga tal");
  }

  const yMean = y.reduce((s, v) => s + v, 0) / n;
  const colMean = new Array<number>(k).fill(0);
  for (const row of X) for (let j = 0; j < k; j++) colMean[j] += row[j] / n;
  const scale = new Array<number>(k).fill(1);
  for (let j = 0; j < k; j++) {
    let ss = 0;
    for (const row of X) ss += (row[j] - colMean[j]) ** 2;
    const sd = Math.sqrt(ss / n);
    // A column that does not vary (or varies only by rounding noise) carries no information.
    scale[j] = sd > 1e-12 ? sd : 1;
  }
  const Z = X.map((row) =>
    row.map((v, j) => {
      const c = v - colMean[j];
      return scale[j] === 1 && Math.abs(c) <= 1e-12 ? 0 : c / scale[j];
    }),
  );

  const lam = Math.max(lambda, HEDONIC_MIN_LAMBDA);
  const A: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const rhs = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i++) {
    const yc = y[i] - yMean;
    for (let a = 0; a < k; a++) {
      rhs[a] += Z[i][a] * yc;
      for (let c = 0; c <= a; c++) A[a][c] += Z[i][a] * Z[i][c];
    }
  }
  for (let a = 0; a < k; a++) {
    for (let c = a + 1; c < k; c++) A[a][c] = A[c][a];
    A[a][a] += lam;
  }

  const betaScaled = choleskySolve(A, rhs);

  let rss = 0;
  let tss = 0;
  for (let i = 0; i < n; i++) {
    let fitted = 0;
    for (let j = 0; j < k; j++) fitted += betaScaled[j] * Z[i][j];
    rss += (y[i] - yMean - fitted) ** 2;
    tss += (y[i] - yMean) ** 2;
  }
  const s2 = rss / Math.max(1, n - k - 1);
  const se = new Array<number>(k).fill(0);
  for (let j = 0; j < k; j++) {
    const unit = new Array<number>(k).fill(0);
    unit[j] = 1;
    const inverseColumn = choleskySolve(A, unit);
    se[j] = Math.sqrt(s2 * inverseColumn[j]) / scale[j];
  }

  const beta = betaScaled.map((b, j) => b / scale[j]);
  let intercept = yMean;
  for (let j = 0; j < k; j++) intercept -= beta[j] * colMean[j];
  return {
    beta,
    intercept,
    se,
    r2: tss > 0 ? 1 - rss / tss : 0,
    rmse: Math.sqrt(rss / n),
  };
}
