/**
 * hedonic-model.ts - the persisted hedonic price model (Phase 14.1, FIT-02/FIT-03):
 * its zod-validated JSON shape, the feature build for one candidate, the
 * prediction in kr/m2, the renovated-value cap and the expected overbid.
 *
 * PURE, synchronous - no clock, no randomness, no network, no async, no file or
 * environment access. The model arrives as an already-read JSON value and goes
 * through {@link parseHedonicModel}; the same input always yields the same
 * output. The second half of the file (14.1-05) fits the model:
 * `fitHedonicModel` emits exactly the shape {@link hedonicModelSchema} accepts,
 * through the same feature code that prices a candidate.
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

/** Metres per degree of latitude on the sphere used by {@link haversineMeters}. */
const METERS_PER_DEG_LAT = (Math.PI / 180) * EARTH_RADIUS_M;

/**
 * Gaussian-kernel neighbourhood level at a point: the weighted mean ln(kr/m2)
 * of the training sales within `cutoffM`, with weight exp(-d^2 / (2 h^2)).
 * `weight` is the summed weight (how much evidence stands behind `level`);
 * zero weight means no neighbour in range and `level` is meaningless.
 *
 * `excludeIndex` skips one point of the cloud. The fit passes a training row's
 * own index so its price never feeds its own neighbour level (leave-one-out);
 * prediction never passes it.
 */
export function kernelLevel(
  kernel: HedonicModel["kernel"],
  lat: number,
  lng: number,
  excludeIndex?: number,
): { readonly level: number; readonly weight: number } {
  const twoH2 = 2 * kernel.bandwidthM * kernel.bandwidthM;
  // A great-circle distance is never shorter than the north-south gap, so points
  // further away than the cut-off in latitude alone can be skipped without trig.
  const maxDLat = (kernel.cutoffM / METERS_PER_DEG_LAT) * 1.001;
  let weight = 0;
  let weighted = 0;
  const points = kernel.points;
  for (let i = 0; i < points.length; i++) {
    if (i === excludeIndex) continue;
    const [pLat, pLng, y] = points[i];
    if (Math.abs(lat - pLat) > maxDLat) continue;
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
 * Everything the feature build needs besides the candidate. The persisted model
 * supplies one at prediction time; the fit builds one from the training rows, so
 * training and serving run the SAME feature code (no train/serve skew).
 */
export interface FeatureContext {
  readonly kernel: HedonicModel["kernel"];
  readonly districtLnMedian: Readonly<Record<InnerstanDistrict, number>>;
  /** Only floor, groundOrBelow and centralityKm are read (the imputable inputs). */
  readonly means: Readonly<Record<HedonicFeature, number>>;
}

/**
 * Builds the six feature values for one candidate. Unknown inputs take the
 * training mean (contributing exactly nothing) and are listed in `imputed`.
 * monthsAgo is always 0: the prediction is for a sale today. `excludeIndex` is
 * the leave-one-out hook for training rows (see {@link kernelLevel}).
 */
export function buildFeatureRowFromContext(
  ctx: FeatureContext,
  input: HedonicInput,
  excludeIndex?: number,
): FeatureRow {
  if (!Number.isFinite(input.livingArea) || input.livingArea <= 0) {
    throw new RangeError("buildFeatureRow needs a finite livingArea above zero");
  }
  const imputed: string[] = [];
  const hasCoords = input.latitude !== null && input.longitude !== null;

  let nbLevel = ctx.districtLnMedian[input.district];
  let nbFromKernel = false;
  if (hasCoords) {
    const { level, weight } = kernelLevel(ctx.kernel, input.latitude!, input.longitude!, excludeIndex);
    if (weight > 0 && weight >= ctx.kernel.minWeight) {
      nbLevel = level;
      nbFromKernel = true;
    }
  }
  if (!nbFromKernel) imputed.push("nbLevel");

  let floor: number;
  let groundOrBelow: number;
  if (input.floor === null) {
    floor = ctx.means.floor;
    groundOrBelow = ctx.means.groundOrBelow;
    imputed.push("floor");
  } else {
    floor = Math.min(Math.max(input.floor, 0), FLOOR_CLIP_MAX);
    groundOrBelow = input.floor <= 0 ? 1 : 0;
  }

  let centralityKm: number;
  if (hasCoords) {
    centralityKm = nearestHubKm(input.latitude!, input.longitude!);
  } else {
    centralityKm = ctx.means.centralityKm;
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

/** {@link buildFeatureRowFromContext} with the context taken from a persisted model. */
export function buildFeatureRow(model: HedonicModel, input: HedonicInput): FeatureRow {
  return buildFeatureRowFromContext(
    {
      kernel: model.kernel,
      districtLnMedian: model.districtLnMedian,
      means: {
        nbLevel: meanOf(model, "nbLevel"),
        floor: meanOf(model, "floor"),
        groundOrBelow: meanOf(model, "groundOrBelow"),
        lnArea: meanOf(model, "lnArea"),
        monthsAgo: meanOf(model, "monthsAgo"),
        centralityKm: meanOf(model, "centralityKm"),
      },
    },
    input,
  );
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

// ---------------------------------------------------------------------------
// Fitting: expected signs and documented priors (D-18)
// ---------------------------------------------------------------------------

/**
 * Which way each coefficient must point if the market behaves as expected:
 * a higher neighbour level, a higher floor, a bigger "ground floor or below"
 * penalty and distance from the hubs are checked. monthsAgo and size (lnArea)
 * carry no expectation and are never guarded. monthsAgo because prices can fall.
 * Size because the data show bigger innerstan flats cost MORE per m2 (t = 8.4 in
 * the 2026-10 fit), and the old rule (bigger costs less per m2) zeroed the most
 * certain coefficient in the model; dropped by decision D-10 on 2026-10-13
 * (14.1 review WR-06). Any other coefficient that points the wrong way, or is
 * too uncertain to tell, is not trusted (see fitHedonicModel, step 5).
 */
export const EXPECTED_SIGNS: Record<HedonicFeature, 1 | -1 | 0> = {
  nbLevel: 1,
  floor: 1,
  groundOrBelow: -1,
  lnArea: 0,
  centralityKm: -1,
  monthsAgo: 0,
};

/**
 * The study's medians, used when the data cannot support a coefficient (D-18:
 * "fall back to the study's medians and say so"). Source:
 * .planning/research/2026-07-10-what-makes-apartments-increase-in-price.md,
 * table rows "Floor level" (about +1 % per floor up to floor 5; bottenvåning
 * -10 %) and "Balcony" (+1.9 %); RESEARCH assumption A7. They are plausibility
 * values from Booli analyses, not Stockholm academic coefficients. A feature with
 * no entry here (neighbour level, size, centrality) is set to zero instead.
 */
export const HEDONIC_PRIORS: Partial<Record<HedonicFeature, number>> & { balconyPct: number } = {
  floor: Math.log(1.01),
  groundOrBelow: Math.log(0.9),
  balconyPct: 0.019,
};

/** Swedish names for the guarded features, for the fallback sentences. */
const FEATURE_LABEL_SV: Record<HedonicFeature, string> = {
  nbLevel: "områdesnivå",
  floor: "våning",
  groundOrBelow: "bottenvåning",
  lnArea: "storlek",
  monthsAgo: "tidstrend",
  centralityKm: "avstånd till centrum",
};

// ---------------------------------------------------------------------------
// Fitting: small numeric helpers
// ---------------------------------------------------------------------------

function sumOf(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

function meanOfValues(values: readonly number[]): number {
  return values.length === 0 ? 0 : sumOf(values) / values.length;
}

/** Linear-interpolation percentile of an already sorted array (p in 0..1). */
function percentileSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function medianOf(values: readonly number[]): number {
  return percentileSorted([...values].sort((a, b) => a - b), 0.5);
}

function byDistrict<T>(make: (district: InnerstanDistrict) => T): Record<InnerstanDistrict, T> {
  return {
    Södermalm: make("Södermalm"),
    Kungsholmen: make("Kungsholmen"),
    Vasastan: make("Vasastan"),
    Östermalm: make("Östermalm"),
  };
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})/;
/** Mean month length, so a part-month difference is a fraction of a month. */
const DAYS_PER_MONTH = 30.4375;

/**
 * Months from one ISO day to another, fractional. Parsed from the text, never
 * through a clock object: same strings in, same number out. Whole calendar
 * months come out exact ("2025-04-12" to "2026-10-12" is 18); a part month
 * counts its day difference over 30.4375. Negative when `fromIso` is later.
 */
export function monthsBetweenIso(fromIso: string, toIso: string): number {
  const a = ISO_DAY.exec(fromIso);
  const b = ISO_DAY.exec(toIso);
  if (!a || !b) {
    throw new RangeError(`monthsBetweenIso: datum måste vara YYYY-MM-DD (fick "${fromIso}" och "${toIso}")`);
  }
  const years = Number(b[1]) - Number(a[1]);
  const months = Number(b[2]) - Number(a[2]);
  const days = Number(b[3]) - Number(a[3]);
  return years * 12 + months + days / DAYS_PER_MONTH;
}

/** Signed t-value in the expected direction: negative means "wrong way". */
function signedT(sign: 1 | -1, beta: number, se: number): number {
  if (se > 0) return (sign * beta) / se;
  const signed = sign * beta;
  return signed > 0 ? Number.POSITIVE_INFINITY : signed < 0 ? Number.NEGATIVE_INFINITY : 0;
}

/**
 * The guard's decision for one coefficient. Null = trusted. Otherwise the reason
 * it is not, and a `score` (expected-direction t-value; lower = worse) used to
 * pick the worst offender first. "wrong-sign": the estimate points against
 * {@link EXPECTED_SIGNS}. "unstable": right direction but |beta / se| is below
 * {@link HEDONIC_MIN_T}. Features with no expected sign are never guarded.
 */
export function guardVerdict(
  name: HedonicFeature,
  beta: number,
  se: number,
): { reason: "wrong-sign" | "unstable"; score: number } | null {
  const sign = EXPECTED_SIGNS[name];
  if (sign === 0) return null;
  const score = signedT(sign, beta, se);
  if (score >= HEDONIC_MIN_T) return null;
  return { reason: sign * beta < 0 ? "wrong-sign" : "unstable", score };
}

/** Swedish number: decimal comma, fixed decimals, no "-0,0". */
function sv(x: number, decimals: number): string {
  const text = x.toFixed(decimals).replace(".", ",");
  return /^-0(,0+)?$/.test(text) ? text.slice(1) : text;
}

/** A fraction as a signed Swedish percent, e.g. 0.0091 -> "+0,9 %". */
function svPct(fraction: number, decimals = 1): string {
  const value = fraction * 100;
  const text = sv(Math.abs(value), decimals);
  return `${value < 0 && Number(text.replace(",", ".")) !== 0 ? "-" : "+"}${text} %`;
}

// ---------------------------------------------------------------------------
// Fitting: training rows, features and the stage-1 fit
// ---------------------------------------------------------------------------

/** One sold flat as the fit sees it (14.1-04's cache row, trimmed to what is used). */
export interface HedonicTrainingRow {
  district: InnerstanDistrict;
  lat: number;
  lng: number;
  floor: number | null;
  livingArea: number;
  soldPrice: number;
  /** "YYYY-MM-DD" */
  soldDate: string;
  /** Booli's sold-vs-asking label in percent; null = no label (NOT "sold at asking"). */
  soldVsAskPct: number | null;
  askingPrice: number | null;
  balcony: boolean | null;
  buildYear: number | null;
  /** True when balcony and build year came from the sold detail page. */
  enriched: boolean;
}

/** A row reduced to the numbers the stage-1 regression uses. lat/lng are already rounded. */
export interface TrainingPoint {
  readonly district: InnerstanDistrict;
  readonly lat: number;
  readonly lng: number;
  readonly floor: number | null;
  readonly livingArea: number;
  /** ln(soldPrice / livingArea) */
  readonly y: number;
  readonly monthsAgo: number;
}

function pointInput(p: TrainingPoint): HedonicInput {
  return {
    district: p.district,
    latitude: p.lat,
    longitude: p.lng,
    floor: p.floor,
    livingArea: p.livingArea,
    balcony: null,
    constructionYear: null,
  };
}

/**
 * The stage-1 design matrix: one row per training point, columns in
 * HEDONIC_FEATURES order. The neighbour level is LEAVE-ONE-OUT: each point's
 * kernel excludes the point itself, so a sale's own price never feeds its own
 * feature. Built through {@link buildFeatureRowFromContext}, the same code that
 * prices a candidate. A floor that is null is filled with the mean of the known
 * floors, which is exactly what prediction does for a candidate with no floor.
 */
export function trainingFeatureMatrix(
  points: readonly TrainingPoint[],
  districtLnMedian: Readonly<Record<InnerstanDistrict, number>>,
): { X: number[][]; kernel: HedonicModel["kernel"]; ctx: FeatureContext; colMeans: number[] } {
  const known = points.filter((p) => p.floor !== null);
  const floorMean = meanOfValues(known.map((p) => Math.min(Math.max(p.floor as number, 0), FLOOR_CLIP_MAX)));
  const groundMean = meanOfValues(known.map((p) => ((p.floor as number) <= 0 ? 1 : 0)));
  const centralityMean = meanOfValues(points.map((p) => nearestHubKm(p.lat, p.lng)));
  const kernel: HedonicModel["kernel"] = {
    bandwidthM: KERNEL_BANDWIDTH_M,
    cutoffM: KERNEL_CUTOFF_M,
    minWeight: KERNEL_MIN_WEIGHT,
    points: points.map((p): [number, number, number] => [p.lat, p.lng, p.y]),
  };
  const ctx: FeatureContext = {
    kernel,
    districtLnMedian,
    means: {
      nbLevel: 0,
      floor: floorMean,
      groundOrBelow: groundMean,
      lnArea: 0,
      monthsAgo: 0,
      centralityKm: centralityMean,
    },
  };
  const X = points.map((p, i) => {
    const row = buildFeatureRowFromContext(ctx, pointInput(p), i);
    return HEDONIC_FEATURES.map((name) => (name === "monthsAgo" ? p.monthsAgo : row.x[name]));
  });
  const colMeans = HEDONIC_FEATURES.map((_, j) => meanOfValues(X.map((row) => row[j])));
  return { X, kernel, ctx, colMeans };
}

/** Median ln(kr/m2) per district; a district under MIN_DISTRICT_N rows borrows the overall median. */
function districtMedians(points: readonly TrainingPoint[]): {
  medians: Record<InnerstanDistrict, number>;
  counts: Record<InnerstanDistrict, number>;
  overall: number;
} {
  const overall = medianOf(points.map((p) => p.y));
  const counts = byDistrict((d) => points.filter((p) => p.district === d).length);
  const medians = byDistrict((d) =>
    counts[d] >= MIN_DISTRICT_N ? medianOf(points.filter((p) => p.district === d).map((p) => p.y)) : overall,
  );
  return { medians, counts, overall };
}

interface Replacement {
  readonly beta: number;
  readonly source: "prior" | "zeroed";
  readonly reason: "wrong-sign" | "unstable";
  readonly detail: string;
}

interface Stage1Fit {
  readonly ctx: FeatureContext;
  readonly kernel: HedonicModel["kernel"];
  readonly medians: Record<InnerstanDistrict, number>;
  readonly counts: Record<InnerstanDistrict, number>;
  readonly overallMedian: number;
  readonly colMeans: number[];
  readonly beta: number[];
  readonly se: Array<number | null>;
  readonly replacements: Array<Replacement | null>;
  readonly intercept: number;
  /** y minus the model, per training point (mean zero by construction). */
  readonly residuals: number[];
  readonly r2: number;
}

/**
 * Stage-1 fit on a set of points: district medians, leave-one-out features,
 * ridge, and (when `guard`) the sign and stability guard.
 *
 * The guard works one feature at a time, worst first: the feature whose
 * expected-direction t-value is lowest and below HEDONIC_MIN_T is replaced by
 * its documented prior (or zero), and the remaining features are REFIT with the
 * replaced one held fixed. Refitting matters: if the "floor" coefficient is
 * overruled, "ground floor" (which moves with it) must be re-estimated against
 * the value actually used, not against the discarded one.
 */
function fitStage1(points: readonly TrainingPoint[], lambda: number, guard: boolean): Stage1Fit {
  const { medians, counts, overall } = districtMedians(points);
  const { X, kernel, ctx, colMeans } = trainingFeatureMatrix(points, medians);
  const y = points.map((p) => p.y);
  const k = HEDONIC_FEATURES.length;
  const replacements: Array<Replacement | null> = new Array<Replacement | null>(k).fill(null);

  let active: number[] = [];
  let fit: RidgeFit;
  for (;;) {
    active = HEDONIC_FEATURES.map((_, j) => j).filter((j) => replacements[j] === null);
    const adjusted = y.map((v, i) => {
      let a = v;
      for (let j = 0; j < k; j++) {
        const r = replacements[j];
        if (r !== null) a -= r.beta * X[i][j];
      }
      return a;
    });
    fit = fitRidge(
      X.map((row) => active.map((j) => row[j])),
      adjusted,
      lambda,
    );
    if (!guard) break;

    let worst: { pos: number; score: number; reason: "wrong-sign" | "unstable" } | null = null;
    for (let pos = 0; pos < active.length; pos++) {
      const verdict = guardVerdict(HEDONIC_FEATURES[active[pos]], fit.beta[pos], fit.se[pos]);
      if (verdict !== null && (worst === null || verdict.score < worst.score)) {
        worst = { pos, score: verdict.score, reason: verdict.reason };
      }
    }
    if (worst === null) break;

    const j = active[worst.pos];
    const name = HEDONIC_FEATURES[j];
    const beta = fit.beta[worst.pos];
    const se = fit.se[worst.pos];
    const reason = worst.reason;
    const prior = HEDONIC_PRIORS[name];
    const t = se > 0 ? beta / se : 0;
    replacements[j] = {
      beta: prior ?? 0,
      source: prior === undefined ? "zeroed" : "prior",
      reason,
      detail:
        `${FEATURE_LABEL_SV[name]}: ${reason === "wrong-sign" ? "koefficienten pekar åt fel håll" : "osäker uppskattning"} ` +
        `(koefficient ${sv(beta, 4)}, SE ${sv(se, 4)}, t = ${sv(t, 1)}); ` +
        `ersatt med ${prior === undefined ? "noll" : `studiens värde ${sv(prior, 4)} (${svPct(Math.exp(prior) - 1)})`}.`,
    };
  }

  const beta = new Array<number>(k).fill(0);
  const se: Array<number | null> = new Array<number | null>(k).fill(null);
  active.forEach((j, pos) => {
    beta[j] = fit.beta[pos];
    se[j] = fit.se[pos];
  });
  replacements.forEach((r, j) => {
    if (r !== null) beta[j] = r.beta;
  });

  // Centred form: the intercept is mean(y), so the residuals have mean zero.
  const yMean = meanOfValues(y);
  const residuals = y.map((v, i) => {
    let predicted = yMean;
    for (let j = 0; j < k; j++) predicted += beta[j] * (X[i][j] - colMeans[j]);
    return v - predicted;
  });
  const rss = sumOf(residuals.map((e) => e * e));
  const tss = sumOf(y.map((v) => (v - yMean) ** 2));
  return {
    ctx,
    kernel,
    medians,
    counts,
    overallMedian: overall,
    colMeans,
    beta,
    se,
    replacements,
    intercept: yMean,
    residuals,
    r2: tss > 0 ? 1 - rss / tss : 0,
  };
}

/** ln(kr/m2) for one held-out point from a stage-1 fit, at the point's OWN sale month. */
function predictLnStage1(fit: Stage1Fit, p: TrainingPoint): number {
  const row = buildFeatureRowFromContext(fit.ctx, pointInput(p));
  let ln = fit.intercept;
  HEDONIC_FEATURES.forEach((name, j) => {
    const x = name === "monthsAgo" ? p.monthsAgo : row.x[name];
    ln += fit.beta[j] * (x - fit.colMeans[j]);
  });
  return ln;
}

// ---------------------------------------------------------------------------
// Fitting: bid premium (R-07)
// ---------------------------------------------------------------------------

export interface BidPremiumRow {
  district: InnerstanDistrict;
  /** ln(1 + sold-vs-asking fraction); only rows that HAVE a label. */
  z: number;
  /** ln(asking kr/m2), or null when the asking price is unknown. */
  askLnKrm2: number | null;
  /** ln of the model's price per m2 for this flat (out-of-fold when fitted). */
  predLnKrm2: number;
}

type DistrictPremium = HedonicModel["bidPremium"]["perDistrict"][InnerstanDistrict];

function fitFlatPremium(rows: readonly BidPremiumRow[]): {
  overallA: number;
  perDistrict: Record<InnerstanDistrict, DistrictPremium>;
} {
  const overallA = rows.length === 0 ? 0 : medianOf(rows.map((r) => r.z));
  const perDistrict = byDistrict((d): DistrictPremium => {
    const own = rows.filter((r) => r.district === d);
    return own.length >= MIN_DISTRICT_N
      ? { a: medianOf(own.map((r) => r.z)), n: own.length, source: "fit" }
      : { a: overallA, n: own.length, source: "fallback" };
  });
  return { overallA, perDistrict };
}

interface SlopeItem {
  readonly district: InnerstanDistrict;
  readonly z: number;
  /** ln asking - ln predicted */
  readonly u: number;
}

/**
 * z = a_district + b · u. The slope b comes from the within-district variation
 * (least squares with district intercepts); each intercept is then the MEDIAN of
 * z - b·u in its district, exactly as the flat form uses the median of z. That
 * makes flat the special case b = 0 of slope, so the cross-validation contest
 * measures only whether the asking-price term helps, not mean-versus-median.
 * Null when there are too few rows with an asking price or no variation in u.
 */
function fitSlopePremium(items: readonly SlopeItem[]): {
  b: number;
  overallA: number;
  perDistrict: Record<InnerstanDistrict, DistrictPremium>;
} | null {
  if (items.length < MIN_DISTRICT_N) return null;
  let sxx = 0;
  let sxy = 0;
  const groups = byDistrict((d) => items.filter((it) => it.district === d));
  for (const d of INNERSTAN_DISTRICTS) {
    const g = groups[d];
    if (g.length < 2) continue;
    const uBar = meanOfValues(g.map((it) => it.u));
    const zBar = meanOfValues(g.map((it) => it.z));
    for (const it of g) {
      sxx += (it.u - uBar) ** 2;
      sxy += (it.u - uBar) * (it.z - zBar);
    }
  }
  if (!(sxx > 1e-9)) return null;
  const b = sxy / sxx;
  const overallA = medianOf(items.map((it) => it.z - b * it.u));
  const perDistrict = byDistrict((d): DistrictPremium => {
    const g = groups[d];
    if (g.length < MIN_DISTRICT_N) return { a: overallA, n: g.length, source: "fallback" };
    return { a: medianOf(g.map((it) => it.z - b * it.u)), n: g.length, source: "fit" };
  });
  return { b, overallA, perDistrict };
}

/**
 * Fits the bid premium two ways and keeps the better one (R-07): flat, the
 * median ln(1+premium) per district; slope, ln(1+premium) = a_district +
 * b · (ln asking kr/m2 - ln predicted kr/m2), with median-based intercepts. "Better" = strictly lower 5-fold
 * cross-validation error (folds by row index, deterministic). Both are scored on
 * the same held-out rows (those with an asking price) so the comparison is fair.
 * A district under MIN_DISTRICT_N rows borrows the overall figure and is marked
 * "fallback". Rows passed in must all carry a label; `nullLabelShare` is the
 * share of flats that did not, reported as given (a null label is not zero).
 */
export function fitBidPremium(
  rows: readonly BidPremiumRow[],
  opts: { nullLabelShare?: number } = {},
): HedonicModel["bidPremium"] {
  const nullLabelShare = opts.nullLabelShare ?? 0;
  const flat = fitFlatPremium(rows);
  const items = (subset: readonly BidPremiumRow[]): SlopeItem[] =>
    subset.flatMap((r) =>
      r.askLnKrm2 === null ? [] : [{ district: r.district, z: r.z, u: r.askLnKrm2 - r.predLnKrm2 }],
    );
  const slope = fitSlopePremium(items(rows));

  // Cross-validation. With a slope available both forms are scored on the rows
  // that have an asking price; otherwise flat alone is scored on everything.
  const scored = rows.map((_, i) => i).filter((i) => slope === null || rows[i].askLnKrm2 !== null);
  let sqFlat = 0;
  let sqSlope = 0;
  let slopeUsable = slope !== null;
  for (let f = 0; f < CV_FOLDS; f++) {
    const train = rows.filter((_, i) => i % CV_FOLDS !== f);
    const flatFold = fitFlatPremium(train);
    const slopeFold = slope === null ? null : fitSlopePremium(items(train));
    if (slope !== null && slopeFold === null) slopeUsable = false;
    for (const i of scored) {
      if (i % CV_FOLDS !== f) continue;
      const r = rows[i];
      sqFlat += (r.z - flatFold.perDistrict[r.district].a) ** 2;
      if (slopeFold !== null) {
        const u = (r.askLnKrm2 as number) - r.predLnKrm2;
        sqSlope += (r.z - (slopeFold.perDistrict[r.district].a + slopeFold.b * u)) ** 2;
      }
    }
  }
  const cvFlat = scored.length === 0 ? 0 : Math.sqrt(sqFlat / scored.length);
  const cvSlope = slope !== null && slopeUsable && scored.length > 0 ? Math.sqrt(sqSlope / scored.length) : null;

  if (slope !== null && cvSlope !== null && cvSlope < cvFlat) {
    return {
      kind: "slope",
      perDistrict: slope.perDistrict,
      b: slope.b,
      overallA: slope.overallA,
      cvRmse: { flat: cvFlat, slope: cvSlope },
      nullLabelShare,
    };
  }
  return {
    kind: "flat",
    perDistrict: flat.perDistrict,
    b: null,
    overallA: flat.overallA,
    cvRmse: { flat: cvFlat, slope: cvSlope },
    nullLabelShare,
  };
}

// ---------------------------------------------------------------------------
// Fitting: stage 2 (balcony, build year) on the detail-enriched rows
// ---------------------------------------------------------------------------

type BuildYearBuckets = NonNullable<HedonicModel["stage2"]["buildYear"]>["pctByBucket"];
const BUCKET_KEYS = ["le1930", "y1931to1960", "y1961to1990", "ge1991"] as const;

function bucketIndex(year: number): number {
  if (year <= 1930) return 0;
  if (year <= 1960) return 1;
  if (year <= 1990) return 2;
  return 3;
}

function clampPct(x: number): number {
  return Math.min(STAGE2_CAP_PCT, Math.max(-STAGE2_CAP_PCT, x));
}

function fitStage2(
  rows: readonly HedonicTrainingRow[],
  residuals: readonly number[],
  lambda: number,
): { stage2: HedonicModel["stage2"]; fallbacks: HedonicModel["fallbacks"]; usedN: number } {
  const eligible = rows
    .map((r, i) => i)
    .filter((i) => rows[i].enriched && rows[i].balcony !== null && rows[i].buildYear !== null);
  if (eligible.length < MIN_DISTRICT_N) {
    return {
      stage2: { balcony: { pct: HEDONIC_PRIORS.balconyPct, source: "prior" }, buildYear: null },
      fallbacks: [
        {
          item: "balcony",
          reason: "absent",
          detail: `balkong: bara ${eligible.length} säljningar med detaljuppgifter (kräver ${MIN_DISTRICT_N}); studiens värde ${svPct(HEDONIC_PRIORS.balconyPct)} används.`,
        },
        {
          item: "buildYear",
          reason: "absent",
          detail: `byggår: bara ${eligible.length} säljningar med detaljuppgifter (kräver ${MIN_DISTRICT_N}); ingen byggårsjustering görs.`,
        },
      ],
      usedN: eligible.length,
    };
  }

  const balcony = eligible.map((i) => (rows[i].balcony === true ? 1 : 0));
  const share = meanOfValues(balcony);
  const buckets = eligible.map((i) => {
    const row = new Array<number>(4).fill(0);
    row[bucketIndex(rows[i].buildYear as number)] = 1;
    return row;
  });
  const target = eligible.map((i) => residuals[i]);

  const withBalcony = fitRidge(
    balcony.map((b, r) => [b, ...buckets[r]]),
    target,
    lambda,
  );
  const gamma = withBalcony.beta[0];
  const score = signedT(1, gamma, withBalcony.se[0]);
  const fallbacks: HedonicModel["fallbacks"] = [];

  let pct: number;
  let source: "fit" | "prior";
  let bucketFit: RidgeFit;
  let gammaUsed: number;
  let bucketOffset: number;
  if (score < HEDONIC_MIN_T) {
    const reason = gamma < 0 ? "wrong-sign" : "unstable";
    pct = HEDONIC_PRIORS.balconyPct;
    source = "prior";
    gammaUsed = Math.log(1 + pct);
    // Refit the build-year buckets against the balcony value actually used.
    bucketFit = fitRidge(buckets, target.map((v, r) => v - gammaUsed * balcony[r]), lambda);
    bucketOffset = 0;
    fallbacks.push({
      item: "balcony",
      reason,
      detail:
        `balkong: ${reason === "wrong-sign" ? "koefficienten pekar åt fel håll" : "osäker uppskattning"} ` +
        `(koefficient ${sv(gamma, 4)}, SE ${sv(withBalcony.se[0], 4)}); ersatt med studiens värde ${svPct(pct)}.`,
    });
  } else {
    pct = clampPct(Math.exp(gamma) - 1);
    source = "fit";
    gammaUsed = gamma;
    bucketFit = withBalcony;
    bucketOffset = 1;
  }

  // Bucket level for a flat at the average balcony mix of the enriched sample, so
  // "balcony unknown" stays unbiased and a known balcony adds `pct` on top.
  const pctByBucket = {} as BuildYearBuckets;
  BUCKET_KEYS.forEach((key, b) => {
    const level = bucketFit.intercept + bucketFit.beta[bucketOffset + b] + gammaUsed * share;
    pctByBucket[key] = clampPct(Math.exp(level) - 1);
  });
  return {
    stage2: { balcony: { pct, source }, buildYear: { pctByBucket, source: "fit" } },
    fallbacks,
    usedN: eligible.length,
  };
}

// ---------------------------------------------------------------------------
// Fitting: the whole model
// ---------------------------------------------------------------------------

export interface HedonicFitReport {
  /** Rows removed by the one MAD outlier pass (Pitfall 8). */
  droppedOutliers: number;
  /** Kept rows that carried both a balcony flag and a build year (stage-2 evidence). */
  enrichedN: number;
  /** Out-of-fold RMSE (ln kr/m2) per fold. */
  cvByFold: number[];
}

/**
 * Fits the persisted model from sold flats (FIT-02, D-02, D-18, R-07, R-12).
 *
 * 1. y = ln(soldPrice / livingArea). Coordinates are rounded to 3 decimals
 *    before any kernel use, so the fit sees what the committed point cloud holds.
 * 2. Location: median ln(kr/m2) per district (overall median under MIN_DISTRICT_N
 *    rows, recorded as small-n). The neighbour level is leave-one-out.
 * 3. Features per HEDONIC_FEATURES; monthsAgo from the sale day to `asOf`; a null
 *    floor is filled with the mean of the known floors.
 * 4. Ridge fit, then ONE outlier pass: rows with |residual - median| above
 *    OUTLIER_MAD_K x 1.4826 x MAD are dropped and the model refitted.
 * 5. Sign and stability guard with documented priors (see {@link fitStage1}).
 * 6. 5-fold cross-validation, folds by row index, each fold repeating the whole
 *    procedure on its training rows; held-out rows only ever see training points.
 * 7. Intercept in centred form, Duan smearing, residual SD and 75th percentile.
 * 8. Stage 2: balcony and build year from the detail-enriched rows, each capped.
 * 9. Bid premium via {@link fitBidPremium} on out-of-fold predictions.
 * 10. kernel = kept rows as [lat, lng, ln kr/m2] and nothing else (T-14.1-04);
 *     minLivingArea / maxLivingArea = extremes of the kept rows (R-12).
 */
export function fitHedonicModel(
  rows: readonly HedonicTrainingRow[],
  opts: { asOf: string; fittedAt: string; lambda?: number },
): { model: HedonicModel; report: HedonicFitReport } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.asOf)) {
    throw new RangeError(`fitHedonicModel: asOf måste vara YYYY-MM-DD (fick "${opts.asOf}")`);
  }
  const lambda = opts.lambda ?? HEDONIC_RIDGE_LAMBDA;

  const prepared = rows.map((r, i): TrainingPoint => {
    const ok =
      (INNERSTAN_DISTRICTS as readonly string[]).includes(r.district) &&
      Number.isFinite(r.lat) &&
      Number.isFinite(r.lng) &&
      Number.isFinite(r.livingArea) &&
      r.livingArea > 0 &&
      Number.isFinite(r.soldPrice) &&
      r.soldPrice > 0 &&
      (r.floor === null || Number.isFinite(r.floor));
    if (!ok) throw new RangeError(`fitHedonicModel: rad ${i} är oanvändbar (område, koordinater, yta eller pris saknas eller är ogiltigt)`);
    let monthsAgo: number;
    try {
      monthsAgo = monthsBetweenIso(r.soldDate, opts.asOf);
    } catch (error) {
      throw new RangeError(`fitHedonicModel: rad ${i}: ${(error as Error).message}`);
    }
    return {
      district: r.district,
      lat: Math.round(r.lat * 1000) / 1000,
      lng: Math.round(r.lng * 1000) / 1000,
      floor: r.floor,
      livingArea: r.livingArea,
      y: Math.log(r.soldPrice / r.livingArea),
      monthsAgo,
    };
  });
  if (prepared.length < MIN_FIT_ROWS) {
    throw new RangeError(`fitHedonicModel: för få rader (${prepared.length}); minst ${MIN_FIT_ROWS} krävs`);
  }

  // Outlier pass: plain ridge on everything, drop what sits far from the scatter.
  const first = fitStage1(prepared, lambda, false);
  const centre = medianOf(first.residuals);
  const mad = medianOf(first.residuals.map((e) => Math.abs(e - centre)));
  const limit = OUTLIER_MAD_K * 1.4826 * mad;
  const keepIdx = prepared
    .map((_, i) => i)
    .filter((i) => !(mad > 1e-9) || Math.abs(first.residuals[i] - centre) <= limit);
  if (keepIdx.length < MIN_FIT_ROWS) {
    throw new RangeError(`fitHedonicModel: för få rader kvar efter uteslutning av avvikare (${keepIdx.length})`);
  }
  const keptRows = keepIdx.map((i) => rows[i]);
  const kept = keepIdx.map((i) => prepared[i]);
  const droppedOutliers = prepared.length - kept.length;

  const final = fitStage1(kept, lambda, true);

  // Cross-validation (deterministic folds by index; every fold refits everything).
  const oofLn = new Array<number>(kept.length).fill(0);
  const cvByFold: number[] = [];
  let sqAll = 0;
  for (let f = 0; f < CV_FOLDS; f++) {
    const trainIdx = kept.map((_, i) => i).filter((i) => i % CV_FOLDS !== f);
    const testIdx = kept.map((_, i) => i).filter((i) => i % CV_FOLDS === f);
    const fold = fitStage1(trainIdx.map((i) => kept[i]), lambda, true);
    let sq = 0;
    for (const i of testIdx) {
      oofLn[i] = predictLnStage1(fold, kept[i]);
      sq += (kept[i].y - oofLn[i]) ** 2;
    }
    cvByFold.push(testIdx.length === 0 ? 0 : Math.sqrt(sq / testIdx.length));
    sqAll += sq;
  }
  const cvRmseLog = Math.sqrt(sqAll / kept.length);

  // Residual summaries.
  const residuals = final.residuals;
  const smearing = Math.max(1, meanOfValues(residuals.map((e) => Math.exp(e))));
  const residualSdLog = Math.sqrt(meanOfValues(residuals.map((e) => e * e)));
  const residualP75Log = Math.max(0, percentileSorted([...residuals].sort((a, b) => a - b), 0.75));

  // Features, as persisted.
  const fallbacks: HedonicModel["fallbacks"] = [];
  const features = HEDONIC_FEATURES.map((name, j) => {
    const rep = final.replacements[j];
    if (rep !== null) {
      fallbacks.push({ item: name, reason: rep.reason, detail: rep.detail });
      return { name, mean: final.colMeans[j], beta: rep.beta, se: null, source: rep.source, note: rep.detail };
    }
    return { name, mean: final.colMeans[j], beta: final.beta[j], se: final.se[j], source: "fit" as const };
  });
  for (const d of INNERSTAN_DISTRICTS) {
    if (final.counts[d] < MIN_DISTRICT_N) {
      fallbacks.push({
        item: `districtLnMedian.${d}`,
        reason: "small-n",
        detail: `${d}: ${final.counts[d]} försäljningar (kräver ${MIN_DISTRICT_N}); områdets medianpris ersätts av medianen för alla områden.`,
      });
    }
  }

  // Stage 2.
  const stage2Result = fitStage2(keptRows, residuals, lambda);
  fallbacks.push(...stage2Result.fallbacks);

  // Bid premium on out-of-fold predictions (plus ln smearing, as at prediction time).
  const premiumRows: BidPremiumRow[] = [];
  let nullLabels = 0;
  keptRows.forEach((r, i) => {
    const pct = r.soldVsAskPct;
    if (pct === null || !Number.isFinite(pct) || pct <= -99) {
      nullLabels += 1;
      return;
    }
    premiumRows.push({
      district: r.district,
      z: Math.log(1 + pct / 100),
      askLnKrm2:
        r.askingPrice !== null && r.askingPrice > 0 ? Math.log(r.askingPrice / r.livingArea) : null,
      predLnKrm2: oofLn[i] + Math.log(smearing),
    });
  });
  const bidPremium = fitBidPremium(premiumRows, { nullLabelShare: nullLabels / kept.length });
  for (const d of INNERSTAN_DISTRICTS) {
    if (bidPremium.perDistrict[d].source === "fallback") {
      fallbacks.push({
        item: `bidPremium.${d}`,
        reason: "small-n",
        detail: `${d}: ${bidPremium.perDistrict[d].n} försäljningar med uppgift om slutpris mot utgångspris (kräver ${MIN_DISTRICT_N}); budpremien för alla områden används.`,
      });
    }
  }

  const areas = kept.map((p) => p.livingArea);
  const model: HedonicModel = {
    version: 1,
    fittedAt: opts.fittedAt,
    asOf: opts.asOf,
    n: kept.length,
    r2: final.r2,
    cvRmseLog,
    residualSdLog,
    smearing,
    residualP75Log,
    minLivingArea: Math.min(...areas),
    maxLivingArea: Math.max(...areas),
    intercept: final.intercept,
    features,
    kernel: final.kernel,
    districtLnMedian: final.medians,
    stage2: stage2Result.stage2,
    bidPremium,
    fallbacks,
  };
  return { model, report: { droppedOutliers, enrichedN: stage2Result.usedN, cvByFold } };
}

// ---------------------------------------------------------------------------
// Plain-language description (D-18)
// ---------------------------------------------------------------------------

function svSource(source: "fit" | "prior" | "zeroed"): string {
  if (source === "fit") return "data";
  if (source === "prior") return "studie (data gav inget pålitligt värde)";
  return "nollställd (data gav inget pålitligt värde och ingen studie finns)";
}

function svM2(x: number): string {
  const text = sv(Math.round(x * 10) / 10, 1);
  return text.endsWith(",0") ? text.slice(0, -2) : text;
}

const REASON_SV: Record<HedonicModel["fallbacks"][number]["reason"], string> = {
  "wrong-sign": "fel tecken",
  unstable: "osäker uppskattning",
  "small-n": "för få observationer",
  absent: "saknas i underlaget",
};

/**
 * What the fitted model says, in Swedish, one finding per line, decimal comma.
 * Effects are percent changes in price per m2: (exp(beta) - 1) x 100. SE is
 * shown as percent too (for small effects the log-scale SE is the same number).
 * Every fallback gets its own line naming the item.
 */
export function describeModel(model: HedonicModel): string[] {
  const feature = (name: HedonicFeature) => model.features.find((f) => f.name === name)!;
  /** `direction` -1 flips the sign of the coefficient (monthsAgo counts BACKWARDS in time). */
  const effect = (name: HedonicFeature, label: string, direction: 1 | -1 = 1): string => {
    const f = feature(name);
    const se = f.se === null ? "" : ` (SE ${sv(f.se * 100, 1)} %)`;
    return `${label} ≈ ${svPct(Math.exp(direction * f.beta) - 1)}${se}, källa: ${svSource(f.source)}`;
  };
  const lines: string[] = [];

  lines.push(
    `Underlag: ${model.n} försäljningar. Modellen förklarar ${sv(model.r2 * 100, 0)} % av prisskillnaderna (R², på samma data).`,
  );
  lines.push(
    `Modellen bygger på ${svM2(model.minLivingArea)}–${svM2(model.maxLivingArea)} kvm; lägenheter utanför intervallet prissätts inte av modellen utan flaggas.`,
  );
  lines.push(
    `Felmarginal på försäljningar modellen inte sett (korsvalidering): ungefär ±${sv((Math.exp(model.cvRmseLog) - 1) * 100, 1)} % på kvadratmeterpriset (CV-RMSE ${sv(model.cvRmseLog, 3)} i logskala).`,
  );
  const nb = feature("nbLevel");
  lines.push(
    `Områdesnivå: grannförsäljningarna inom ${sv(model.kernel.cutoffM / 1000, 1)} km väger ${sv(nb.beta, 2)} (1,00 = priset följer grannarna fullt ut), källa: ${svSource(nb.source)}.`,
  );
  lines.push(`${effect("floor", "En våning upp")}.`);
  lines.push(`${effect("groundOrBelow", "Bottenvåning eller lägre")}.`);
  const area = feature("lnArea");
  lines.push(
    `10 % större yta ≈ ${svPct(Math.exp(area.beta * Math.log(1.1)) - 1)} på kvadratmeterpriset${area.se === null ? "" : ` (SE ${sv(area.se * Math.log(1.1) * 100, 1)} %)`}, källa: ${svSource(area.source)}.`,
  );
  lines.push(`${effect("centralityKm", "Varje km längre från närmaste centrumpunkt")}.`);
  // monthsAgo is months BEFORE asOf: a negative coefficient means older sales were cheaper, i.e. rising prices.
  lines.push(`${effect("monthsAgo", "Prisutveckling per månad", -1)}; priset avser ${model.asOf}.`);

  const balcony = model.stage2.balcony;
  lines.push(`Balkong ≈ ${svPct(balcony.pct)}, källa: ${balcony.source === "fit" ? "data" : "studie"}.`);
  if (model.stage2.buildYear === null) {
    lines.push("Byggår: ingen uppskattning (för få försäljningar med detaljuppgifter); ingen byggårsjustering görs.");
  } else {
    const b = model.stage2.buildYear.pctByBucket;
    lines.push(
      `Byggår, jämfört med en genomsnittlig lägenhet: före 1931 ${svPct(b.le1930)}, 1931–1960 ${svPct(b.y1931to1960)}, 1961–1990 ${svPct(b.y1961to1990)}, 1991 och senare ${svPct(b.ge1991)}, källa: data.`,
    );
  }

  const bid = model.bidPremium;
  const perDistrict = INNERSTAN_DISTRICTS.map((d) => {
    const entry = bid.perDistrict[d];
    return `${d} ${svPct(Math.exp(entry.a) - 1)} (n ${entry.n}${entry.source === "fallback" ? ", reservvärde" : ""})`;
  }).join(", ");
  lines.push(
    `Budpremie (slutpris över utgångspris), ${
      bid.kind === "slope"
        ? `lutande (b = ${sv(bid.b ?? 0, 2)}: ju lägre utgångspris mot modellens pris, desto högre bud); siffrorna gäller när utgångspriset är lika med modellens pris`
        : "fast per område"
    }: ${perDistrict}.`,
  );
  lines.push(
    `Budpremiens korsvalidering (logskala): fast ${sv(bid.cvRmse.flat, 3)}, lutande ${bid.cvRmse.slope === null ? "ej beräknad" : sv(bid.cvRmse.slope, 3)}.`,
  );
  lines.push(
    `${sv(bid.nullLabelShare * 100, 1)} % av försäljningarna saknar uppgift om slutpris mot utgångspris och är utelämnade ur budpremien; de räknas inte som noll.`,
  );
  lines.push(
    `Smearing (omräkning från logskala) ${sv(model.smearing, 3)}. En renoverad lägenhet prissätts högst ${svPct(Math.exp(model.residualP75Log) - 1)} över modellens pris (75:e percentilen av avvikelserna).`,
  );

  if (model.fallbacks.length === 0) {
    lines.push("Inga reservvärden behövdes: alla koefficienter kom från data.");
  } else {
    for (const f of model.fallbacks) lines.push(`Reservvärde, ${f.item} (${REASON_SV[f.reason]}): ${f.detail}`);
  }
  return lines;
}
