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

/**
 * The nine regression features, in the order the model file lists them. The first
 * six are Phase 14.1's; the last three (14.4, D-01) are avgift in kr per m2 and
 * month, the association's debt in kr per m2, and tomträtt (0/1).
 */
export const HEDONIC_FEATURES = [
  "nbLevel",
  "floor",
  "groundOrBelow",
  "lnArea",
  "monthsAgo",
  "centralityKm",
  "avgiftPerSqmMonth",
  "brfDebtPerSqm",
  "tomtratt",
] as const;
export type HedonicFeature = (typeof HEDONIC_FEATURES)[number];

/** Continuous 14.4 features are clamped to the training percentiles below at fit and at prediction. */
export const CLAMPED_FEATURES = ["avgiftPerSqmMonth", "brfDebtPerSqm"] as const;
export const CLAMP_LOW_PERCENTILE = 0.01;
export const CLAMP_HIGH_PERCENTILE = 0.99;

/**
 * The features whose value can be unknown for a sold flat or a candidate, and is then
 * marginalised at the mean of the known values (the honesty rule). Sold pages read
 * before 14.4 carry none of them.
 */
export const OPTIONAL_14_4_FEATURES = ["avgiftPerSqmMonth", "brfDebtPerSqm", "tomtratt"] as const;

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
  /**
   * The training 1st and 99th percentile of a continuous feature's known values (14.4).
   * A value outside [lo, hi] is clamped at fit AND at prediction, so an extreme avgift
   * or debt cannot extrapolate. Stored here, never invented at prediction time.
   */
  lo: num.optional(),
  hi: num.optional(),
});

/**
 * Bid-premium term slots (14.4). Version 2 carries them empty; plan 04 fills `dom`
 * (days on market) and plan 10 fills `condition`.
 */
const domTermSchema = z.object({
  beta: num,
  /** Training mean of ln(1 + days on market); the term is beta x (ln(1 + days) - mean). */
  mean: num,
  /**
   * The training 1st and 99th percentile of ln(1 + days on market) (WR-02). At prediction ln(1 + days) is clamped to
   * [lnLo, lnHi], so a flat listed for two years or one listed today cannot extrapolate the term. Required in
   * version 2 and checked below (lnLo < lnHi). The coefficient is fitted on the raw values, unclamped.
   */
  lnLo: num,
  lnHi: num,
  n: num.min(0),
  kept: z.boolean(),
  cvRmse: z.object({ without: num, with: num }),
  note: z.string(),
});

const conditionTermSchema = z.object({
  beta: num,
  source: z.enum(["fit", "prior"]),
  kept: z.boolean(),
  n: num.min(0),
  cvRmse: z.object({ without: num, with: num }).nullable(),
  note: z.string(),
});

/**
 * The persisted model. `lnKrPerSqm = intercept + sum(beta_j * (x_j - mean_j))`,
 * for a sale at `asOf` (monthsAgo = 0). Every number must be finite; the
 * refinements below reject a file that would produce nonsense downstream.
 */
export const hedonicModelSchema = z
  .object({
    version: z.literal(2),
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
      /**
       * The limit the fit clamped the stage-2 values at (R-01, 14.5-10). Optional: files written before 14.5 have no
       * such field and are read as {@link STAGE2_CAP_PCT} (see {@link modelStage2Cap}); no version bump.
       */
      capPct: num.min(0).optional(),
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
      terms: z.object({
        dom: domTermSchema.nullable(),
        condition: conditionTermSchema.nullable(),
      }),
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
    { message: "features must list each of the nine features exactly once", path: ["features"] },
  )
  // WR-08: the clamp bounds the coefficients were fitted under must travel with the file. A fitted continuous
  // feature without them would be predicted unclamped (train/serve skew); lo/hi alone, or lo >= hi, is nonsense.
  .superRefine((m, ctx) => {
    m.features.forEach((f, i) => {
      const clamped = (CLAMPED_FEATURES as readonly string[]).includes(f.name);
      const hasLo = f.lo !== undefined;
      const hasHi = f.hi !== undefined;
      if (hasLo !== hasHi) {
        ctx.addIssue({ code: "custom", message: `${f.name}: lo and hi must both be present or both absent`, path: ["features", i] });
      } else if (clamped && f.source === "fit" && !hasLo) {
        ctx.addIssue({ code: "custom", message: `${f.name}: a fitted continuous feature needs clamp bounds lo and hi`, path: ["features", i] });
      } else if (hasLo && hasHi && !((f.lo as number) < (f.hi as number))) {
        ctx.addIssue({ code: "custom", message: `${f.name}: clamp bound lo must be below hi`, path: ["features", i] });
      }
    });
    const dom = m.bidPremium.terms.dom;
    if (dom !== null && !(dom.lnLo < dom.lnHi)) {
      ctx.addIssue({ code: "custom", message: "days-on-market clamp bound lnLo must be below lnHi", path: ["bidPremium", "terms", "dom"] });
    }
  });

export type HedonicModel = z.infer<typeof hedonicModelSchema>;

/** The model file version this code reads and writes (D-01: a pre-14.4 file is refused). */
export const HEDONIC_MODEL_VERSION = 2;

/** Parses an untrusted JSON value into a model, or throws one readable Error. */
export function parseHedonicModel(json: unknown): HedonicModel {
  // A file from before 14.4 lacks the nine-feature layout; name the version instead of
  // listing whatever else happens to be missing, and never read it as a current model.
  if (typeof json === "object" && json !== null && "version" in json && (json as { version: unknown }).version !== HEDONIC_MODEL_VERSION) {
    throw new Error(
      `Invalid hedonic model: version ${String((json as { version: unknown }).version)} stöds inte (koden läser version ${HEDONIC_MODEL_VERSION}); passa om modellen med scripts/fit-hedonic.ts`,
    );
  }
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
  /** Monthly avgift in kr divided by living area; null = unknown (marginalised at the training mean). */
  readonly avgiftPerSqmMonth: number | null;
  /** The association's debt in kr per m2 of its area; null = unknown. */
  readonly brfDebtPerSqm: number | null;
  /** true = tomträtt (leasehold land), false = ruled out, null = unknown. */
  readonly tomtratt: boolean | null;
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
  /** Only floor, groundOrBelow, centralityKm and the three 14.4 features are read (the imputable inputs). */
  readonly means: Readonly<Record<HedonicFeature, number>>;
  /**
   * Training percentile bounds of the continuous 14.4 features (CLAMPED_FEATURES). A known
   * value is clamped to [lo, hi]; absent bounds mean no clamp. Persisted on the feature
   * records (`lo`, `hi`), so prediction never invents them.
   */
  readonly bounds?: Partial<Record<HedonicFeature, { readonly lo: number; readonly hi: number }>>;
}

/**
 * Builds the nine feature values for one candidate. Unknown inputs take the
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

  // The three 14.4 inputs follow the floor pattern: unknown = the mean of the known
  // values (contributes exactly nothing) and the name goes into `imputed`.
  const known = (v: number | null): v is number => v !== null && Number.isFinite(v);
  const clamp = (name: HedonicFeature, v: number): number => {
    const b = ctx.bounds?.[name];
    return b === undefined ? v : Math.min(b.hi, Math.max(b.lo, v));
  };
  let avgiftPerSqmMonth: number;
  if (known(input.avgiftPerSqmMonth)) {
    avgiftPerSqmMonth = clamp("avgiftPerSqmMonth", input.avgiftPerSqmMonth);
  } else {
    avgiftPerSqmMonth = ctx.means.avgiftPerSqmMonth;
    imputed.push("avgiftPerSqmMonth");
  }
  let brfDebtPerSqm: number;
  if (known(input.brfDebtPerSqm)) {
    brfDebtPerSqm = clamp("brfDebtPerSqm", input.brfDebtPerSqm);
  } else {
    brfDebtPerSqm = ctx.means.brfDebtPerSqm;
    imputed.push("brfDebtPerSqm");
  }
  let tomtratt: number;
  if (input.tomtratt === null) {
    tomtratt = ctx.means.tomtratt;
    imputed.push("tomtratt");
  } else {
    tomtratt = input.tomtratt ? 1 : 0;
  }

  return {
    x: {
      nbLevel,
      floor,
      groundOrBelow,
      lnArea: Math.log(input.livingArea),
      monthsAgo: 0,
      centralityKm,
      avgiftPerSqmMonth,
      brfDebtPerSqm,
      tomtratt,
    },
    imputed,
  };
}

/** {@link buildFeatureRowFromContext} with the context taken from a persisted model. */
export function buildFeatureRow(model: HedonicModel, input: HedonicInput): FeatureRow {
  const bounds: Partial<Record<HedonicFeature, { lo: number; hi: number }>> = {};
  for (const f of model.features) {
    if (f.lo !== undefined && f.hi !== undefined) bounds[f.name] = { lo: f.lo, hi: f.hi };
  }
  return buildFeatureRowFromContext(
    {
      kernel: model.kernel,
      districtLnMedian: model.districtLnMedian,
      bounds,
      means: {
        nbLevel: meanOf(model, "nbLevel"),
        floor: meanOf(model, "floor"),
        groundOrBelow: meanOf(model, "groundOrBelow"),
        lnArea: meanOf(model, "lnArea"),
        monthsAgo: meanOf(model, "monthsAgo"),
        centralityKm: meanOf(model, "centralityKm"),
        avgiftPerSqmMonth: meanOf(model, "avgiftPerSqmMonth"),
        brfDebtPerSqm: meanOf(model, "brfDebtPerSqm"),
        tomtratt: meanOf(model, "tomtratt"),
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
 * How an expected overbid was put together (14.4, VAL-03): the base form, whether the
 * days-on-market term moved it, and the (still empty) condition slot. `label` is the
 * short Swedish makeup the tracked-listing block prints next to the percentage.
 */
export interface OverbidDetail {
  /** Expected overbid over asking, as a fraction (0.08 = pays 8 % over). */
  pct: number;
  /** The base form actually used: "slope" only when the model is slope AND has its b. */
  base: "flat" | "slope";
  /** The days on market the caller supplied, null when unknown. */
  domDays: number | null;
  /** True when the days term was kept AND the days were known, so it moved the premium. */
  domUsed: boolean;
  conditionIndex: -1 | 0 | 1;
  conditionUsed: boolean;
  conditionSource: "fit" | "prior";
  label: string;
}

/** What the model says about condition in the bid premium: a measured term, or "not measured" with the model's own reason. */
export type ConditionReading =
  | { readonly measured: true; readonly beta: number; readonly n: number }
  | { readonly measured: false; readonly reason: string | null };

/**
 * The ONE place that decides whether condition is measured: only a term with source "fit" that cross-validation kept
 * (R-08). A missing term, a prior or a rejected one is "not measured"; `reason` is the model's note without its own
 * "budpremie: skick ej mätt: " lead-in (null when there is no term at all). Every line and label about condition
 * (the prediction, the replay header, the before/after report) reads this, so they cannot drift apart.
 */
export function readConditionTerm(model: Pick<HedonicModel, "bidPremium">): ConditionReading {
  const term = model.bidPremium.terms.condition;
  if (term !== null && term.source === "fit" && term.kept) return { measured: true, beta: term.beta, n: term.n };
  return { measured: false, reason: term === null ? null : term.note.replace(/^budpremie: skick ej mätt: /, "") };
}

/**
 * Expected overbid over asking with its makeup. ln(1 + premium) = a_district
 * + b x (ln asking - ln pred)   [slope form only]
 * + c x (ln(1 + days) - mean)   [only when cross-validation kept the days term AND the days are known]
 * + condition term              [beta x index; only a FITTED term that cross-validation KEPT; index 0 adds exactly 0].
 * An unknown number of days adds exactly 0 (the training mean), never a guess.
 *
 * R-08 (14.4): no public Swedish source for a dated-vs-fresh bid difference was found, so the
 * unfitted prior for the condition term is 0. A missing term, a prior term or a rejected term
 * adds nothing and the label ends ", skick ej mätt" - never an invented number.
 */
export function expectedOverbidDetail(
  model: HedonicModel,
  district: InnerstanDistrict,
  askingKrPerSqm: number,
  predKrPerSqm: number,
  extra: { daysOnMarket: number | null; conditionIndex?: -1 | 0 | 1 },
): OverbidDetail {
  const bid = model.bidPremium;
  let ln = bid.perDistrict[district].a;
  const slope = bid.kind === "slope" && bid.b !== null;
  if (slope) ln += (bid.b as number) * (Math.log(askingKrPerSqm) - Math.log(predKrPerSqm));

  const dom = bid.terms.dom;
  const domKept = dom !== null && dom.kept;
  const days =
    extra.daysOnMarket !== null && Number.isFinite(extra.daysOnMarket) && extra.daysOnMarket >= 0
      ? extra.daysOnMarket
      : null;
  const domUsed = domKept && days !== null;
  if (domUsed) {
    // Clamped to the training range (WR-02): a brand-new or a years-old listing is priced at the edge of what was seen.
    const lnDays = Math.min(dom.lnHi, Math.max(dom.lnLo, Math.log(1 + (days as number))));
    ln += dom.beta * (lnDays - dom.mean);
  }

  const conditionIndex = extra.conditionIndex ?? 0;
  // Only a measured term moves the premium: source "fit" AND kept by cross-validation (R-08).
  const reading = readConditionTerm(model);
  const conditionMeasured = reading.measured;
  const conditionUsed = reading.measured && conditionIndex !== 0;
  if (reading.measured && conditionIndex !== 0) ln += reading.beta * conditionIndex;

  const base = slope ? "slope" : "flat";
  let label = slope ? "distrikt+pris" : "distrikt";
  if (domUsed) label += "+dagar";
  if (conditionUsed) label += "+skick";
  if (domKept && !domUsed) label += ", dagar okända";
  if (!conditionMeasured) label += ", skick ej mätt";
  return {
    pct: Math.exp(ln) - 1,
    base,
    domDays: days,
    domUsed,
    conditionIndex,
    conditionUsed,
    conditionSource: conditionMeasured ? "fit" : "prior",
    label,
  };
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

/**
 * Fewest sold flats with a usable photo label the condition stage will try (BID-01, R-08). Below this a 5-fold
 * cross-validation on the labelled rows holds out fewer than 20 flats per fold, too few to judge an effect of about
 * 2 percentage points (RESEARCH Q9). Claude's discretion, written down here and in the plan.
 */
export const CONDITION_MIN_LABELLED = 100;

/** Neighbour-level kernel (RESEARCH A6): 300 m bandwidth, 1 km cut-off, weight floor 0.5. */
export const KERNEL_BANDWIDTH_M = 300;
export const KERNEL_CUTOFF_M = 1000;
export const KERNEL_MIN_WEIGHT = 0.5;

/**
 * Balcony and build-year effects are never allowed to exceed this (RESEARCH Pattern 1, item 5). Since 14.5 it is the
 * default cap and the cap assumed for model files written before capPct existed; a fitted model carries its own.
 */
export const STAGE2_CAP_PCT = 0.08;

/** The one widening D-03 allows, decided by the stage-2 cross-validation (R-01). */
export const STAGE2_CAP_WIDENED_PCT = 0.12;

/** The only caps a fit may use; any other value throws (D-03, T-14.5-45). */
export const STAGE2_ALLOWED_CAPS = [STAGE2_CAP_PCT, STAGE2_CAP_WIDENED_PCT] as const;

/** The stage-2 cap a model was fitted with; models without capPct (written before 14.5) were fitted at 0,08. */
export function modelStage2Cap(model: Pick<HedonicModel, "stage2">): number {
  return model.stage2.capPct ?? STAGE2_CAP_PCT;
}

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
  // 14.4 (D-01): a higher avgift or a more indebted association should lower the price,
  // and leasehold land should too. A wrong-signed or unstable estimate is zeroed by the
  // guard (no prior exists), and the fit report says so.
  avgiftPerSqmMonth: -1,
  brfDebtPerSqm: -1,
  tomtratt: -1,
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
  avgiftPerSqmMonth: "avgift kr/kvm/mån",
  brfDebtPerSqm: "föreningsskuld kr/kvm",
  tomtratt: "tomträtt",
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
  /** Avgift in kr per m2 and month (sold page rent / living area); null = not read. */
  avgiftPerSqmMonth: number | null;
  /** The association's debt in kr per m2 (its latest annual report); null = not read. */
  brfDebtPerSqm: number | null;
  /** true = tomträtt, false = Bostadsrätt on the sold page, null = not read or another tenure. */
  tomtratt: boolean | null;
  /** Days on market as the sold page prints it (14.4 VAL-03); absent/null = not read. Feeds the bid premium only, never the resale price. */
  daysActive?: number | null;
  /**
   * Condition from the sold photos (14.4 BID-01): dated -1, ok 0, fresh +1; null/absent = no read or a read below the
   * confidence bar (left out of the condition stage, never 0). Feeds the bid premium only, never the resale price.
   */
  condition?: -1 | 0 | 1 | null;
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
  readonly avgiftPerSqmMonth: number | null;
  readonly brfDebtPerSqm: number | null;
  readonly tomtratt: boolean | null;
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
    avgiftPerSqmMonth: p.avgiftPerSqmMonth,
    brfDebtPerSqm: p.brfDebtPerSqm,
    tomtratt: p.tomtratt,
  };
}

/** How many known values a 14.4 feature has in a training set, and their range (for the zero-spread branch). */
export interface KnownStats {
  readonly n: number;
  readonly min: number;
  readonly max: number;
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
): {
  X: number[][];
  kernel: HedonicModel["kernel"];
  ctx: FeatureContext;
  colMeans: number[];
  /** Known-value counts and ranges of the three 14.4 features. */
  knownStats: Record<(typeof OPTIONAL_14_4_FEATURES)[number], KnownStats>;
} {
  const known = points.filter((p) => p.floor !== null);
  const floorMean = meanOfValues(known.map((p) => Math.min(Math.max(p.floor as number, 0), FLOOR_CLIP_MAX)));
  const groundMean = meanOfValues(known.map((p) => ((p.floor as number) <= 0 ? 1 : 0)));
  const centralityMean = meanOfValues(points.map((p) => nearestHubKm(p.lat, p.lng)));
  // The 14.4 features: means over the KNOWN values only, exactly as the floor mean is.
  const finiteOnly = (values: ReadonlyArray<number | null>): number[] =>
    values.filter((v): v is number => v !== null && Number.isFinite(v));
  const avgiftRaw = finiteOnly(points.map((p) => p.avgiftPerSqmMonth));
  const debtRaw = finiteOnly(points.map((p) => p.brfDebtPerSqm));
  // Continuous features: the 1st-99th percentile of the known values is the clamp range, and the
  // mean (what an unknown value is replaced with) is taken AFTER clamping. Too few values to
  // estimate (the feature will be recorded as absent) get no bounds.
  const boundsOf = (values: readonly number[]): { lo: number; hi: number } | null => {
    if (values.length < MIN_FIT_ROWS) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return { lo: percentileSorted(sorted, CLAMP_LOW_PERCENTILE), hi: percentileSorted(sorted, CLAMP_HIGH_PERCENTILE) };
  };
  const avgiftBounds = boundsOf(avgiftRaw);
  const debtBounds = boundsOf(debtRaw);
  const clampTo = (v: number, b: { lo: number; hi: number } | null): number =>
    b === null ? v : Math.min(b.hi, Math.max(b.lo, v));
  const avgiftKnown = avgiftRaw.map((v) => clampTo(v, avgiftBounds));
  const debtKnown = debtRaw.map((v) => clampTo(v, debtBounds));
  const tomtrattKnown = points.flatMap((p) => (p.tomtratt === null ? [] : [p.tomtratt ? 1 : 0]));
  const statsOf = (values: readonly number[]): KnownStats => ({
    n: values.length,
    min: values.length === 0 ? 0 : Math.min(...values),
    max: values.length === 0 ? 0 : Math.max(...values),
  });
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
      avgiftPerSqmMonth: meanOfValues(avgiftKnown),
      brfDebtPerSqm: meanOfValues(debtKnown),
      tomtratt: meanOfValues(tomtrattKnown),
    },
    bounds: {
      ...(avgiftBounds === null ? {} : { avgiftPerSqmMonth: avgiftBounds }),
      ...(debtBounds === null ? {} : { brfDebtPerSqm: debtBounds }),
    },
  };
  const X = points.map((p, i) => {
    const row = buildFeatureRowFromContext(ctx, pointInput(p), i);
    return HEDONIC_FEATURES.map((name) => (name === "monthsAgo" ? p.monthsAgo : row.x[name]));
  });
  const colMeans = HEDONIC_FEATURES.map((_, j) => meanOfValues(X.map((row) => row[j])));
  return {
    X,
    kernel,
    ctx,
    colMeans,
    knownStats: {
      avgiftPerSqmMonth: statsOf(avgiftKnown),
      brfDebtPerSqm: statsOf(debtKnown),
      tomtratt: statsOf(tomtrattKnown),
    },
  };
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
  readonly reason: "wrong-sign" | "unstable" | "absent";
  readonly detail: string;
}

/**
 * R-02: a 14.4 feature the data cannot estimate (too few known values, or no spread among
 * them) is recorded as zero with the TRUE reason, not run through the guard, which would
 * call it "osäker uppskattning". Null when the feature is estimable.
 */
function absentReplacement(name: HedonicFeature, stats: KnownStats): Replacement | null {
  const label = FEATURE_LABEL_SV[name];
  let detail: string | null = null;
  if (stats.n < MIN_FIT_ROWS) {
    detail = `${label}: för få kända värden i underlaget (${stats.n}; minst ${MIN_FIT_ROWS} krävs).`;
  } else if (stats.max - stats.min < 1e-12) {
    detail =
      name === "tomtratt" && stats.max === 0
        ? "tomträtt: inga tomträttsförsäljningar i underlaget (upplåtelseform är Bostadsrätt på alla sålda sidor)"
        : `${label}: ingen variation i underlaget (${stats.n} kända värden, alla lika).`;
  }
  return detail === null ? null : { beta: 0, source: "zeroed", reason: "absent", detail };
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
  /** The first ridge fit of the run, before the guard replaced anything: per feature index, null when not fitted. */
  readonly raw: Array<{ beta: number; se: number } | null>;
  readonly knownStats: Record<(typeof OPTIONAL_14_4_FEATURES)[number], KnownStats>;
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
  const { X, kernel, ctx, colMeans, knownStats } = trainingFeatureMatrix(points, medians);
  const y = points.map((p) => p.y);
  const k = HEDONIC_FEATURES.length;
  const replacements: Array<Replacement | null> = new Array<Replacement | null>(k).fill(null);
  for (const name of OPTIONAL_14_4_FEATURES) {
    replacements[HEDONIC_FEATURES.indexOf(name)] = absentReplacement(name, knownStats[name]);
  }

  let active: number[] = [];
  let fit: RidgeFit;
  const raw: Array<{ beta: number; se: number } | null> = new Array<{ beta: number; se: number } | null>(k).fill(null);
  let firstPass = true;
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
    if (firstPass) {
      active.forEach((j, pos) => {
        raw[j] = { beta: fit.beta[pos], se: fit.se[pos] };
      });
      firstPass = false;
    }
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
    raw,
    knownStats,
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
  /**
   * ln(1 + days on market) from the sold page, or null/absent when unknown. The ln(1 + days)
   * transform is a prior choice (RESEARCH A7) and is NOT searched over: a rejection by
   * cross-validation means "no detectable effect in this form".
   */
  domLn?: number | null;
  /**
   * Condition of the sold flat from its photos (BID-01): dated -1, ok 0, fresh +1. null = not labelled (no photo
   * read, or a read below the confidence bar): the row is LEFT OUT of the condition stage, never coded 0.
   * Absent on every row = the stage is not attempted at all.
   */
  cond?: -1 | 0 | 1 | null;
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

/** A usable days-on-market value: a finite ln(1 + days) at or above zero. */
function knownDomLn(r: BidPremiumRow): number | null {
  const v = r.domLn;
  return v !== undefined && v !== null && Number.isFinite(v) && v >= 0 ? v : null;
}

interface DomPremiumFit {
  /** Slope coefficient re-estimated jointly with the days term (slope base), else null. */
  b: number | null;
  /** Coefficient on ln(1 + days) - mean. */
  c: number;
  mean: number;
  /** Rows the coefficients were estimated on (days known, and an asking price for the slope base). */
  n: number;
  overallA: number;
  perDistrict: Record<InnerstanDistrict, DistrictPremium>;
}

/**
 * The base premium PLUS a days-on-market term (VAL-03). Within-district least squares on
 * [u = ln asking - ln pred (slope base only), ln(1 + days)] over the rows that have the
 * regressors (normal equations through choleskySolve), then per-district intercepts as the
 * MEDIAN of z - b u - c (domLn - mean), like the base form. A row with unknown days
 * contributes 0 to that sum (it sits at the mean). Null when fewer than MIN_DISTRICT_N rows
 * carry the regressors, or the regressors have no usable spread.
 */
function fitDomPremium(rows: readonly BidPremiumRow[], kind: "flat" | "slope"): DomPremiumFit | null {
  const slope = kind === "slope";
  const usable = rows.filter((r) => knownDomLn(r) !== null && (!slope || r.askLnKrm2 !== null));
  if (usable.length < MIN_DISTRICT_N) return null;
  const mean = meanOfValues(usable.map((r) => knownDomLn(r) as number));
  const regressors = (r: BidPremiumRow): number[] =>
    slope ? [(r.askLnKrm2 as number) - r.predLnKrm2, knownDomLn(r) as number] : [knownDomLn(r) as number];
  const p = slope ? 2 : 1;
  const A = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const rhs = new Array<number>(p).fill(0);
  for (const d of INNERSTAN_DISTRICTS) {
    const g = usable.filter((r) => r.district === d);
    if (g.length < 2) continue;
    const xs = g.map(regressors);
    const xBar = Array.from({ length: p }, (_, j) => meanOfValues(xs.map((x) => x[j])));
    const zBar = meanOfValues(g.map((r) => r.z));
    g.forEach((r, i) => {
      for (let j = 0; j < p; j++) {
        rhs[j] += (xs[i][j] - xBar[j]) * (r.z - zBar);
        for (let k = 0; k < p; k++) A[j][k] += (xs[i][j] - xBar[j]) * (xs[i][k] - xBar[k]);
      }
    });
  }
  if (A.some((row, j) => !(row[j] > 1e-9))) return null;
  let coef: number[];
  try {
    coef = choleskySolve(A, rhs);
  } catch {
    return null;
  }
  if (!coef.every((v) => Number.isFinite(v))) return null;
  const b = slope ? coef[0] : null;
  const c = coef[p - 1];

  const pool = slope ? rows.filter((r) => r.askLnKrm2 !== null) : rows;
  const adjusted = (r: BidPremiumRow): number => {
    const dl = knownDomLn(r);
    return (
      r.z -
      (b !== null && r.askLnKrm2 !== null ? b * (r.askLnKrm2 - r.predLnKrm2) : 0) -
      (dl === null ? 0 : c * (dl - mean))
    );
  };
  const overallA = medianOf(pool.map(adjusted));
  const perDistrict = byDistrict((d): DistrictPremium => {
    const g = pool.filter((r) => r.district === d);
    return g.length < MIN_DISTRICT_N
      ? { a: overallA, n: g.length, source: "fallback" }
      : { a: medianOf(g.map(adjusted)), n: g.length, source: "fit" };
  });
  return { b, c, mean, n: usable.length, overallA, perDistrict };
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
 *
 * Then, on top of the chosen base, a days-on-market term is tried (D-02/R-01, VAL-03):
 * the base and base-plus-days are both refitted on each fold's training rows and scored on
 * the SAME held-out rows with the SAME fold rule. The term is kept only when its error is
 * STRICTLY lower AND its coefficient is negative (a longer listing draws a smaller
 * premium); otherwise it is recorded as tried and rejected, and the base is left exactly as
 * it was. When the term is kept, the premium's slope and intercepts are the jointly
 * re-estimated ones, because the days coefficient is only meaningful against them.
 */
function fitBidPremiumBaseAndDays(
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

  const useSlope = slope !== null && cvSlope !== null && cvSlope < cvFlat;
  const base: HedonicModel["bidPremium"] =
    useSlope && slope !== null
      ? {
          kind: "slope",
          perDistrict: slope.perDistrict,
          b: slope.b,
          overallA: slope.overallA,
          cvRmse: { flat: cvFlat, slope: cvSlope },
          nullLabelShare,
          terms: { dom: null, condition: null },
        }
      : {
          kind: "flat",
          perDistrict: flat.perDistrict,
          b: null,
          overallA: flat.overallA,
          cvRmse: { flat: cvFlat, slope: cvSlope },
          nullLabelShare,
          terms: { dom: null, condition: null },
        };

  // ---- the days-on-market contest ----
  const kind = base.kind;
  const domFull = fitDomPremium(rows, kind);
  if (domFull === null) return base;
  let sqWithout = 0;
  let sqWith = 0;
  for (let f = 0; f < CV_FOLDS; f++) {
    const train = rows.filter((_, i) => i % CV_FOLDS !== f);
    const flatFold = fitFlatPremium(train);
    const slopeFold = kind === "slope" ? fitSlopePremium(items(train)) : null;
    const domFold = fitDomPremium(train, kind);
    for (const i of scored) {
      if (i % CV_FOLDS !== f) continue;
      const r = rows[i];
      const u = r.askLnKrm2 === null ? 0 : r.askLnKrm2 - r.predLnKrm2;
      const without =
        slopeFold !== null
          ? slopeFold.perDistrict[r.district].a + slopeFold.b * u
          : flatFold.perDistrict[r.district].a;
      let withDom = without;
      if (domFold !== null) {
        const dl = knownDomLn(r);
        withDom =
          domFold.perDistrict[r.district].a +
          (domFold.b !== null ? domFold.b * u : 0) +
          (dl === null ? 0 : domFold.c * (dl - domFold.mean));
      }
      sqWithout += (r.z - without) ** 2;
      sqWith += (r.z - withDom) ** 2;
    }
  }
  const cvWithout = scored.length === 0 ? 0 : Math.sqrt(sqWithout / scored.length);
  const cvWith = scored.length === 0 ? 0 : Math.sqrt(sqWith / scored.length);
  const improves = cvWith < cvWithout;
  const rightSign = domFull.c < 0;
  const kept = improves && rightSign;
  const note = kept
    ? `med: korsvalidering ${sv(cvWithout, 4)} -> ${sv(cvWith, 4)}`
    : !improves
      ? "prövad, förkastad: korsvalidering"
      : "prövad, förkastad: fel tecken";
  // The clamp range of the term at prediction: 1st-99th percentile of ln(1 + days) over every row with known days.
  const knownLn = rows.flatMap((r) => {
    const v = knownDomLn(r);
    return v === null ? [] : [v];
  });
  const sortedLn = [...knownLn].sort((a, b) => a - b);
  const dom = {
    beta: domFull.c,
    mean: domFull.mean,
    lnLo: percentileSorted(sortedLn, CLAMP_LOW_PERCENTILE),
    lnHi: percentileSorted(sortedLn, CLAMP_HIGH_PERCENTILE),
    n: domFull.n,
    kept,
    cvRmse: { without: cvWithout, with: cvWith },
    note,
  };
  if (!kept) return { ...base, terms: { dom, condition: null } };
  return {
    ...base,
    perDistrict: domFull.perDistrict,
    b: domFull.b,
    overallA: domFull.overallA,
    terms: { dom, condition: null },
  };
}

/** Pearson correlation of two equally long series; null with fewer than 3 points or no spread in either. */
function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length < 3 || xs.length !== ys.length) return null;
  const mx = meanOfValues(xs);
  const my = meanOfValues(ys);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (!(sxx > 1e-12) || !(syy > 1e-12)) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Least squares r = alpha + k c. Null when c has no spread. */
function fitLine(c: readonly number[], r: readonly number[]): { alpha: number; k: number } | null {
  const mc = meanOfValues(c);
  const mr = meanOfValues(r);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < c.length; i++) {
    sxx += (c[i] - mc) ** 2;
    sxy += (c[i] - mc) * (r[i] - mr);
  }
  if (!(sxx > 1e-12)) return null;
  const k = sxy / sxx;
  return { alpha: mr - k * mc, k };
}

/**
 * The condition stage (BID-01, D-12, R-08): a SECOND stage on top of the settled base and days terms, fitted on the
 * sold flats whose photos were read with enough confidence (`cond` not null) and nothing else.
 *
 * For every labelled row the residual is r = z - (a_district + b u + the days part), with the final base. Then
 * r = alpha + k cond by least squares, scored by 5-fold cross-validation on the labelled rows only (fold = labelled-row
 * index modulo {@link CV_FOLDS}): "without" predicts the training-fold mean of r, "with" the training-fold
 * alpha + k cond. The term is kept (source "fit", beta k) only when "with" is STRICTLY lower. Otherwise, and with
 * fewer than {@link CONDITION_MIN_LABELLED} labelled rows, the record is the prior: beta 0, not kept, and a note
 * "budpremie: skick ej mätt: ..." with the reason (R-08). No number from a study is ever used. The fitted estimate is
 * written into the note anyway, so a reader can see what the data said.
 *
 * Every note also carries corr(condition, asking-vs-model) over the labelled rows with an asking price, and the power
 * limit (an effect under about 2 pp cannot be seen at this n, RESEARCH Q3/Q9), so a small coefficient is not misread
 * as "no effect" or as "the effect".
 *
 * A row with `cond` null is never coded 0. The base and days fits are not touched.
 */
function conditionTermOf(
  rows: readonly BidPremiumRow[],
  bid: HedonicModel["bidPremium"],
): NonNullable<HedonicModel["bidPremium"]["terms"]["condition"]> {
  const labelled = rows.filter((r) => r.cond !== undefined && r.cond !== null);
  const n = labelled.length;
  const dom = bid.terms.dom;
  const baseOf = (r: BidPremiumRow): number => {
    let ln = bid.perDistrict[r.district].a;
    if (bid.b !== null && r.askLnKrm2 !== null) ln += bid.b * (r.askLnKrm2 - r.predLnKrm2);
    const dl = knownDomLn(r);
    if (dom !== null && dom.kept && dl !== null) ln += dom.beta * (dl - dom.mean);
    return ln;
  };
  const c = labelled.map((r) => r.cond as number);
  const resid = labelled.map((r) => r.z - baseOf(r));

  const withAsk = labelled.filter((r) => r.askLnKrm2 !== null);
  const corr = pearson(
    withAsk.map((r) => r.cond as number),
    withAsk.map((r) => (r.askLnKrm2 as number) - r.predLnKrm2),
  );
  const tail =
    ` corr(skick, utgångspris/modell) = ${corr === null ? "-" : sv(corr, 2)}; ` +
    `en effekt under ≈ 2 pp kan inte ses med n = ${n}.`;
  const prior = (reason: string, cvRmse: { without: number; with: number } | null) => ({
    beta: 0,
    source: "prior" as const,
    kept: false,
    n,
    cvRmse,
    note: `budpremie: skick ej mätt: ${reason}.${tail}`,
  });

  if (n < CONDITION_MIN_LABELLED) {
    return prior(`för få märkta försäljningar (${n} av minst ${CONDITION_MIN_LABELLED})`, null);
  }
  const full = fitLine(c, resid);
  if (full === null) return prior("ingen variation i skicket", null);

  let sqWithout = 0;
  let sqWith = 0;
  for (let f = 0; f < CV_FOLDS; f++) {
    const trainIdx = c.map((_, i) => i).filter((i) => i % CV_FOLDS !== f);
    const testIdx = c.map((_, i) => i).filter((i) => i % CV_FOLDS === f);
    const trainR = trainIdx.map((i) => resid[i]);
    const mean = meanOfValues(trainR);
    const line = fitLine(trainIdx.map((i) => c[i]), trainR);
    for (const i of testIdx) {
      sqWithout += (resid[i] - mean) ** 2;
      sqWith += (resid[i] - (line === null ? mean : line.alpha + line.k * c[i])) ** 2;
    }
  }
  const cvRmse = { without: Math.sqrt(sqWithout / n), with: Math.sqrt(sqWith / n) };
  if (!(cvRmse.with < cvRmse.without)) {
    return prior(
      `korsvalidering förkastade termen (${sv(cvRmse.without, 5)} -> ${sv(cvRmse.with, 5)}, skattning ${sv(full.k, 4)})`,
      cvRmse,
    );
  }
  return {
    beta: full.k,
    source: "fit",
    kept: true,
    n,
    cvRmse,
    note: `med: korsvalidering ${sv(cvRmse.without, 5)} -> ${sv(cvRmse.with, 5)}, skattning ${sv(full.k, 4)} per steg (föråldrat -1, vanligt 0, fräscht +1).${tail}`,
  };
}

/**
 * The bid premium: the base form and the days term of {@link fitBidPremiumBaseAndDays}, then the condition stage
 * ({@link conditionTermOf}) on the labelled sold flats. When no row carries a `cond` at all (an older caller) the
 * stage is not attempted and `terms.condition` stays null; when rows carry one (even all null) the slot is always
 * filled, either with a fitted and cross-validated term or with the documented 0 prior and its reason.
 */
export function fitBidPremium(
  rows: readonly BidPremiumRow[],
  opts: { nullLabelShare?: number } = {},
): HedonicModel["bidPremium"] {
  const bid = fitBidPremiumBaseAndDays(rows, opts);
  if (!rows.some((r) => r.cond !== undefined)) return bid;
  return { ...bid, terms: { ...bid.terms, condition: conditionTermOf(rows, bid) } };
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

function clampPct(x: number, cap: number): number {
  return Math.min(cap, Math.max(-cap, x));
}

/** One build-year bucket in the stage-2 report (D-02). */
export interface Stage2BucketReport {
  /** Eligible rows in the bucket. */
  n: number;
  /** exp(level) - 1 before clamping. */
  pctRaw: number;
  /** sd(stage-1 residuals in the bucket) / sqrt(n); null under two rows. An approximation: fitRidge's SE is not usable for collinear one-hot buckets. */
  seApprox: number | null;
  /** The value the model uses (clamped to the cap). */
  pct: number;
}

/**
 * What stage 2 measured, for the cap decision (R-01, D-02): the raw (unclamped) values with their uncertainty, which
 * values sit on the cap, and a cross-validation error that can tell the caps apart (stage-1 cvRmseLog cannot).
 */
export interface Stage2Report {
  /** Rows with a balcony flag and a build year. */
  n: number;
  /** The cap this fit used. */
  capPct: number;
  balcony: {
    /** Ridge coefficient (ln scale) from the first stage-2 fit, before the sign and stability guard. */
    gamma: number;
    /** Its standard error (ln scale, about the same number as a fraction for small effects). */
    se: number | null;
    /** exp(gamma) - 1 before the guard and the cap. */
    pctRaw: number;
    /** The value the model uses. */
    pct: number;
    source: "fit" | "prior";
  };
  buckets: Record<(typeof BUCKET_KEYS)[number], Stage2BucketReport>;
  /** Labels of the values the model holds at the cap (clamped). */
  onCap: string[];
  cv: {
    /** Held-out error (ln kr/m2) with no stage 2: the stage-1 residual alone. */
    without: number;
    /** Held-out error with stage 2 clamped at each allowed cap, on the same folds. */
    byCap: { "0.08": number; "0.12": number };
    /** The same two errors when the fitted values are applied the way predictKrPerSqm applies them (see {@link stage2CvRmse}). */
    asApplied: { "0.08": number; "0.12": number };
  };
}

const STAGE2_BUCKET_LABELS: Record<(typeof BUCKET_KEYS)[number], string> = {
  le1930: "byggår före 1931",
  y1931to1960: "byggår 1931–1960",
  y1961to1990: "byggår 1961–1990",
  ge1991: "byggår 1991 och senare",
};

function fitStage2(
  rows: readonly HedonicTrainingRow[],
  residuals: readonly number[],
  lambda: number,
  cap: number,
): {
  stage2: HedonicModel["stage2"];
  fallbacks: HedonicModel["fallbacks"];
  usedN: number;
  /** Null when there were too few eligible rows (stage 2 is then the prior). */
  detail: Omit<Stage2Report, "cv"> | null;
} {
  const eligible = rows
    .map((r, i) => i)
    .filter((i) => rows[i].enriched && rows[i].balcony !== null && rows[i].buildYear !== null);
  if (eligible.length < MIN_DISTRICT_N) {
    return {
      stage2: { capPct: cap, balcony: { pct: HEDONIC_PRIORS.balconyPct, source: "prior" }, buildYear: null },
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
      detail: null,
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
    pct = clampPct(Math.exp(gamma) - 1, cap);
    source = "fit";
    gammaUsed = gamma;
    bucketFit = withBalcony;
    bucketOffset = 1;
  }

  // Bucket level for a flat at the average balcony mix of the enriched sample, so
  // "balcony unknown" stays unbiased and a known balcony adds `pct` on top.
  const pctByBucket = {} as BuildYearBuckets;
  const bucketReports = {} as Stage2Report["buckets"];
  BUCKET_KEYS.forEach((key, b) => {
    const level = bucketFit.intercept + bucketFit.beta[bucketOffset + b] + gammaUsed * share;
    const pctRaw = Math.exp(level) - 1;
    pctByBucket[key] = clampPct(pctRaw, cap);
    const inBucket = eligible.filter((i) => bucketIndex(rows[i].buildYear as number) === b).map((i) => residuals[i]);
    bucketReports[key] = { n: inBucket.length, pctRaw, seApprox: sdOverSqrtN(inBucket), pct: pctByBucket[key] };
  });
  const onCapLabels: string[] = [];
  const sitsOnCap = (x: number): boolean => Math.abs(Math.abs(x) - cap) < 1e-9;
  if (sitsOnCap(pct)) onCapLabels.push("balkong");
  for (const key of BUCKET_KEYS) if (sitsOnCap(pctByBucket[key])) onCapLabels.push(STAGE2_BUCKET_LABELS[key]);
  return {
    stage2: { capPct: cap, balcony: { pct, source }, buildYear: { pctByBucket, source: "fit" } },
    fallbacks,
    usedN: eligible.length,
    detail: {
      n: eligible.length,
      capPct: cap,
      balcony: { gamma, se: Number.isFinite(withBalcony.se[0]) ? withBalcony.se[0] : null, pctRaw: Math.exp(gamma) - 1, pct, source },
      buckets: bucketReports,
      onCap: onCapLabels,
    },
  };
}

/** Sample standard deviation over sqrt(n); null under two values. */
function sdOverSqrtN(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const mean = meanOfValues(values);
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance) / Math.sqrt(values.length);
}

/**
 * Stage-2 cross-validation (R-01): the number that can tell the caps apart, because stage 1 is fitted before stage 2.
 * Eligible rows (balcony, build year, enriched flag) are folded by their index among the eligible rows modulo
 * {@link CV_FOLDS}. Per fold, stage 2 is fitted on the other folds with `cap`, and a held-out row's error is its
 * stage-1 residual minus what the clamped stage-2 fit predicts for it. `without` is the residual alone on the same rows.
 *
 * Two ways to turn the fitted values into a prediction, both reported:
 * - `withCap`: the regression's own prediction, ln(1 + bucket pct) + ln(1 + balcony pct) x (balcony - training share of
 *   balconies). The bucket values are levels at the average balcony mix (fitStage2), so a known balcony is centred on
 *   that mix. This measures how well the clamped effect sizes predict held-out sales, which is what the cap decides.
 * - `withCapAsApplied`: the multipliers exactly as {@link predictKrPerSqm} applies them (balcony true: x (1 + pct);
 *   false: x 1; plus the bucket value). Because the bucket values already include the average balcony effect, this
 *   over-predicts every flat with a known balcony flag by about (balcony share x balcony effect); a bigger balcony
 *   effect is penalised for that, not for predicting worse. Reported next to withCap so the difference is visible.
 * Returns NaN for all when no row is eligible.
 */
export function stage2CvRmse(
  rows: readonly HedonicTrainingRow[],
  residuals: readonly number[],
  lambda: number,
  cap: number,
): { without: number; withCap: number; withCapAsApplied: number } {
  const eligible = rows
    .map((_, i) => i)
    .filter((i) => rows[i].enriched && rows[i].balcony !== null && rows[i].buildYear !== null);
  if (eligible.length === 0) return { without: Number.NaN, withCap: Number.NaN, withCapAsApplied: Number.NaN };
  let sqWithout = 0;
  let sqWith = 0;
  let sqApplied = 0;
  for (let f = 0; f < CV_FOLDS; f++) {
    const train = eligible.filter((_, k) => k % CV_FOLDS !== f);
    const test = eligible.filter((_, k) => k % CV_FOLDS === f);
    const fitted = fitStage2(
      train.map((i) => rows[i]),
      train.map((i) => residuals[i]),
      lambda,
      cap,
    ).stage2;
    const trainShare = meanOfValues(train.map((i) => (rows[i].balcony === true ? 1 : 0)));
    const gammaLn = Math.log(1 + fitted.balcony.pct);
    for (const i of test) {
      const isBalcony = rows[i].balcony === true ? 1 : 0;
      const bucketLn =
        fitted.buildYear === null
          ? 0
          : Math.log(1 + fitted.buildYear.pctByBucket[BUCKET_KEYS[bucketIndex(rows[i].buildYear as number)]]);
      sqWithout += residuals[i] ** 2;
      sqWith += (residuals[i] - (bucketLn + gammaLn * (isBalcony - trainShare))) ** 2;
      sqApplied += (residuals[i] - (bucketLn + gammaLn * isBalcony)) ** 2;
    }
  }
  const n = eligible.length;
  return { without: Math.sqrt(sqWithout / n), withCap: Math.sqrt(sqWith / n), withCapAsApplied: Math.sqrt(sqApplied / n) };
}

// ---------------------------------------------------------------------------
// Fitting: the whole model
// ---------------------------------------------------------------------------

export interface HedonicFitReport {
  /** Rows removed by the one MAD outlier pass (Pitfall 8). */
  droppedOutliers: number;
  /** Kept rows that carried both a balcony flag and a build year (stage-2 evidence). */
  enrichedN: number;
  /** The stage-2 measurement for the cap decision; null when there were too few rows with details (14.5-10). */
  stage2: Stage2Report | null;
  /** Out-of-fold RMSE (ln kr/m2) per fold. */
  cvByFold: number[];
  /**
   * The three 14.4 features' coefficient, standard error and t from the first ridge fit,
   * BEFORE the sign/stability guard replaced anything. A feature recorded as absent has
   * no entry. This is what the R-06 decision reads: a coefficient the guard zeroed is
   * still visible here.
   */
  rawEstimates: Partial<Record<HedonicFeature, { beta: number; se: number | null; t: number | null }>>;
  /** Rows (after outlier removal) with a known value, per 14.4 feature. */
  knownCounts: Partial<Record<HedonicFeature, number>>;
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
  opts: { asOf: string; fittedAt: string; lambda?: number; stage2CapPct?: number },
): { model: HedonicModel; report: HedonicFitReport } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.asOf)) {
    throw new RangeError(`fitHedonicModel: asOf måste vara YYYY-MM-DD (fick "${opts.asOf}")`);
  }
  const stage2Cap = opts.stage2CapPct ?? STAGE2_CAP_PCT;
  if (!(STAGE2_ALLOWED_CAPS as readonly number[]).includes(stage2Cap)) {
    throw new RangeError(`fitHedonicModel: steg-2-taket kan bara vara 0,08 eller 0,12 (fick ${String(stage2Cap)})`);
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
      avgiftPerSqmMonth: r.avgiftPerSqmMonth,
      brfDebtPerSqm: r.brfDebtPerSqm,
      tomtratt: r.tomtratt,
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
    const b = final.ctx.bounds?.[name];
    const bounds = b === undefined ? {} : { lo: b.lo, hi: b.hi };
    if (rep !== null) {
      fallbacks.push({ item: name, reason: rep.reason, detail: rep.detail });
      return { name, mean: final.colMeans[j], beta: rep.beta, se: null, source: rep.source, note: rep.detail, ...bounds };
    }
    return { name, mean: final.colMeans[j], beta: final.beta[j], se: final.se[j], source: "fit" as const, ...bounds };
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
  const stage2Result = fitStage2(keptRows, residuals, lambda, stage2Cap);
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
      domLn:
        r.daysActive !== undefined && r.daysActive !== null && Number.isInteger(r.daysActive) && r.daysActive >= 0
          ? Math.log(1 + r.daysActive)
          : null,
      cond: r.condition ?? null,
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
    version: HEDONIC_MODEL_VERSION,
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
  const rawEstimates: HedonicFitReport["rawEstimates"] = {};
  const knownCounts: HedonicFitReport["knownCounts"] = {};
  for (const name of OPTIONAL_14_4_FEATURES) {
    knownCounts[name] = final.knownStats[name].n;
    const r = final.raw[HEDONIC_FEATURES.indexOf(name)];
    if (r !== null) rawEstimates[name] = { beta: r.beta, se: r.se, t: r.se > 0 ? r.beta / r.se : null };
  }
  let stage2Report: Stage2Report | null = null;
  if (stage2Result.detail !== null) {
    const at8 = stage2CvRmse(keptRows, residuals, lambda, STAGE2_CAP_PCT);
    const at12 = stage2CvRmse(keptRows, residuals, lambda, STAGE2_CAP_WIDENED_PCT);
    stage2Report = {
      ...stage2Result.detail,
      cv: {
        without: at8.without,
        byCap: { "0.08": at8.withCap, "0.12": at12.withCap },
        asApplied: { "0.08": at8.withCapAsApplied, "0.12": at12.withCapAsApplied },
      },
    };
  }
  return {
    model,
    report: { droppedOutliers, enrichedN: stage2Result.usedN, stage2: stage2Report, cvByFold, rawEstimates, knownCounts },
  };
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
  // The 14.4 features: an item the data could not estimate says so instead of printing a zero effect.
  const notEstimable = (name: HedonicFeature): boolean =>
    model.fallbacks.some((f) => f.item === name && f.reason === "absent");
  const avgift = feature("avgiftPerSqmMonth");
  lines.push(
    notEstimable("avgiftPerSqmMonth")
      ? "Avgift per kvm och månad: kan inte skattas av underlaget (se reservvärdet nedan); effekten sätts till noll."
      : `10 kr högre avgift per kvm och månad ≈ ${svPct(Math.exp(10 * avgift.beta) - 1, 2)}${avgift.se === null ? "" : ` (SE ${sv(avgift.se * 10 * 100, 2)} %)`}, källa: ${svSource(avgift.source)}.`,
  );
  const debt = feature("brfDebtPerSqm");
  lines.push(
    notEstimable("brfDebtPerSqm")
      ? "Föreningsskuld per kvm: kan inte skattas av underlaget (se reservvärdet nedan); effekten sätts till noll."
      : `1 000 kr mer föreningsskuld per kvm ≈ ${svPct(Math.exp(1000 * debt.beta) - 1, 2)}${debt.se === null ? "" : ` (SE ${sv(debt.se * 1000 * 100, 2)} %)`}, källa: ${svSource(debt.source)}.`,
  );
  lines.push(
    notEstimable("tomtratt")
      ? "Tomträtt: kan inte skattas av underlaget (se reservvärdet nedan); effekten sätts till noll och ligger inte i värderingen."
      : `${effect("tomtratt", "Tomträtt")}.`,
  );
  // monthsAgo is months BEFORE asOf: a negative coefficient means older sales were cheaper, i.e. rising prices.
  lines.push(`${effect("monthsAgo", "Prisutveckling per månad", -1)}; priset avser ${model.asOf}.`);

  const cap = modelStage2Cap(model);
  const onCap = (x: number): string => (Math.abs(Math.abs(x) - cap) < 1e-9 ? ` (på taket ±${sv(cap * 100, 0)} %)` : "");
  const balcony = model.stage2.balcony;
  lines.push(`Balkong ≈ ${svPct(balcony.pct)}${onCap(balcony.pct)}, källa: ${balcony.source === "fit" ? "data" : "studie"}.`);
  if (model.stage2.buildYear === null) {
    lines.push("Byggår: ingen uppskattning (för få försäljningar med detaljuppgifter); ingen byggårsjustering görs.");
  } else {
    const b = model.stage2.buildYear.pctByBucket;
    lines.push(
      `Byggår, jämfört med en genomsnittlig lägenhet: före 1931 ${svPct(b.le1930)}${onCap(b.le1930)}, 1931–1960 ${svPct(b.y1931to1960)}${onCap(b.y1931to1960)}, 1961–1990 ${svPct(b.y1961to1990)}${onCap(b.y1961to1990)}, 1991 och senare ${svPct(b.ge1991)}${onCap(b.ge1991)}, källa: data.`,
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
  if (bid.terms.dom !== null) {
    const dom = bid.terms.dom;
    lines.push(
      `Dagar på marknaden i budpremien: ${dom.kept ? "används" : "används inte"} (${dom.note}; koefficient ${sv(dom.beta, 4)} per ln-dag, ${dom.n} försäljningar med dagar och utgångspris). Gäller förväntat slutpris, inte lägenhetens värde.`,
    );
  }
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
