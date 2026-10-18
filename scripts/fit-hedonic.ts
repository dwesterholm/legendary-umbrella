/**
 * Offline refit of the hedonic price model (Phase 14.1, FIT-01 "refit offline",
 * FIT-02, D-18, R-07, R-08, R-12). Reads the gitignored sold-price cache, fits
 * the model, prints it in plain Swedish and writes the aggregate model JSON that
 * `scripts/fit-score.ts` and Phase 14.2 load.
 *
 *   npx tsx scripts/fit-hedonic.ts [--cache .planning/calibration/data/slutpriser-cache.json] \
 *       [--out data/hedonic-model.json] [--as-of <YYYY-MM-DD, default: the cache's asOf>] \
 *       [--before-record <fil.json>] [--without-new-features --out <fil>] [--stage2-cap 0.08|0.12] [--report-json <fil.json>] \
 *       [--stambyte-join .planning/calibration/data/bygglov/sold-join.json]
 *   npx tsx scripts/fit-hedonic.ts --graft-stambyte <donor.json> --out <fil.json> [--base data/hedonic-model.json]
 *
 * 14.6 (STAM-02, R-03): --stambyte-join <fil> attaches the city's building history to each sold row (what the record said on
 * the SALE date, from `stambyteAtSale`) and fits the stambyte post-stage: an optional `stambyteTerm` kept only when 5-fold
 * cross-validation improves, printed in a Stambyte block beside the circulating figures and the correlation with debt and
 * avgift. The file must sit under .planning/calibration/data/ and pass its schema, or the script stops BEFORE the sold
 * cache is read. Without the flag the model has no stambyteTerm key and is byte-compatible with a pre-14.6 fit.
 * --graft-stambyte <donor> moves ONLY the donor's stambyteTerm onto --base (default data/hedonic-model.json) after checking
 * that every other number except fittedAt and note is equal; it reads no sold cache, needs an explicit --out and writes
 * atomically. Plan 14.6-12 does the swap; plan 14.6-07 only fits to scratch files.
 *
 * 14.5 (R-01, D-03): --stage2-cap sets the limit on the balcony and build-year effects. Only 0.08 (default) and 0.12
 * are allowed; anything else stops the script before the cache is read. The fitted model records it as stage2.capPct.
 * Every fit prints the stage-2 block (raw values with their uncertainty, what sits on the cap, the stage-2
 * cross-validation for no stage 2, ±8 % and ±12 %) and the ceiling-height line (CEIL-02, R-03). --report-json writes the
 * same numbers as JSON (the fitReportJsonSchema shape) under .planning/phases/ or .planning/calibration/data/.
 *
 * 14.4 (VAL-02): avgift per m2 and month, the association's debt per m2 and tomträtt are fitted
 * features. `--before-record` reads (never writes) a frozen run record and prints the new model's
 * R² and cross-validation error next to the old model's. `--without-new-features` fits the OLD
 * feature set on the same rows (the three columns blanked, so they come out "absent") and
 * refuses to overwrite the committed model: it needs an explicit --out (R-05, the intermediate
 * model that separates "refit and stage 2" from "new features").
 *
 * NO NETWORK. This file imports nothing from the Booli transport or client, and
 * `slutpriser.ts` (schemas only here) is pure. Free to run as often as you like.
 * Because it renders no Booli page it takes no `--renderer` flag (D-03 of Phase
 * 14.2 names it, but the renderer choice lives in `fit-score.ts` and
 * `pull-slutpriser.ts`, where the data is fetched).
 *
 * Size (D-10, 14.1 review WR-06): the direction rule for the size coefficient was
 * dropped, so the size effect now comes from the data and the model's note says so.
 *
 * What goes into the committed file: coefficients, summary statistics and a point
 * cloud of [lat 3 dp, lng 3 dp, ln kr/m2]. No address, URL, sold date or price
 * (T-14.1-04). The output path must sit under `data/` or
 * `.planning/calibration/data/`.
 *
 * Nothing is tuned to pass the sanity check (R-02): features, ridge strength and
 * thresholds are the library's. A miss is printed as measured.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod/v4";
import {
  HEDONIC_FEATURES,
  HEDONIC_MIN_LAMBDA,
  HEDONIC_RIDGE_LAMBDA,
  INNERSTAN_DISTRICTS,
  describeModel,
  fitHedonicModel,
  fitRidge,
  formatStambyteBlock,
  graftStambyteTerm,
  hedonicModelSchema,
  monthsBetweenIso,
  parseHedonicModel,
  trainingFeatureMatrix,
  type HedonicFitReport,
  type HedonicModel,
  type Stage2Report,
  type HedonicTrainingRow,
  STAGE2_ALLOWED_CAPS,
  STAGE2_CAP_PCT,
  type InnerstanDistrict,
  type StambyteTrainingState,
  type TrainingPoint,
} from "@/lib/discovery/hedonic-model";
import { stambyteAtSale } from "@/lib/discovery/stambyte-join";
import {
  slutprisCacheSchema,
  subtractMonthsIso,
  SLUTPRIS_SIZE_BANDS,
  type BrfEntry,
  type SoldRow,
} from "@/lib/booli/slutpriser";
import { writeTextAtomic } from "@/lib/discovery/json-store";
import { parseFitRunRecord } from "@/lib/discovery/valuation-report";
import { fitReportJsonSchema } from "@/lib/discovery/valuation-compare";
import {
  SOLD_CONDITION_CACHE_PATH,
  SOLD_CONDITION_MIN_CONFIDENCE,
  SOLD_CONDITION_VERSION,
  conditionIndexOfRead,
  loadSoldConditionCache,
  soldConditionEntryId,
  soldConditionSpentSek,
  soldConditionUsableIds,
  type SoldConditionCache,
} from "@/lib/discovery/sold-condition";

const CWD = process.cwd();
const DEFAULT_CACHE = join(CWD, ".planning", "calibration", "data", "slutpriser-cache.json");
const DEFAULT_OUT = join(CWD, "data", "hedonic-model.json");
const CALIBRATION_DATA_DIR = join(CWD, ".planning", "calibration", "data");
const ALLOWED_OUT_DIRS = [join(CWD, "data"), CALIBRATION_DATA_DIR];
const ALLOWED_REPORT_DIRS = [join(CWD, ".planning", "phases"), CALIBRATION_DATA_DIR];

/** The listing the whole phase is calibrated against must not be in the training data (RESEARCH Pitfall 10). */
const CALIBRATION_ADDRESS = /^Folkungagatan 61\b/i;
const CALIBRATION_AREA_RANGE = [34, 36] as const;

/** Sanity thresholds (RESEARCH validation sanity, R-02). Reported, never tuned to. */
const SANITY_MIN_R2 = 0.35;
const SANITY_MAX_CV_RMSE = 0.13;

/** The study figures for median sold-vs-asking, CONTEXT D-03 (older, possibly sign-contaminated, see R-04a). */
const STUDY_PREMIUM: Partial<Record<InnerstanDistrict, string>> = {
  Södermalm: "+7 till +10 %",
  Kungsholmen: "+3 till +4 %",
};

/** The window used to separate size from recency in the size check: the latest months only. */
const SIZE_CHECK_WINDOW_MONTHS = 3;

/**
 * Build-year effects come from four age buckets (to 1930, 1931-60, 1961-90, 1991 on).
 * With ~0.12 spread in ln kr/m2 a bucket of n sales has a standard error of about
 * 0.12 / sqrt(n); 20 sales per bucket keeps it near 2.7 %. Below that the library would
 * still print a "fit" number that is mostly noise (it caps, but does not refuse, a
 * thin bucket), so the script leaves the detail sample out of the model instead and
 * says so (D-18: fall back and say so). Reported, never tuned to pass a check.
 */
const STAGE2_MIN_PER_BUCKET = 20;
const BUILD_YEAR_BUCKETS = [
  { label: "före 1931", test: (y: number) => y <= 1930 },
  { label: "1931-1960", test: (y: number) => y > 1930 && y <= 1960 },
  { label: "1961-1990", test: (y: number) => y > 1960 && y <= 1990 },
  { label: "1991 och senare", test: (y: number) => y > 1990 },
] as const;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

/** --stage2-cap: exactly "0.08" or "0.12" (D-03, one widening); read before anything else is touched. */
function resolveStage2Cap(): number {
  const raw = argValue("--stage2-cap");
  if (raw === null) return STAGE2_CAP_PCT;
  const allowed = STAGE2_ALLOWED_CAPS.find((c) => c.toFixed(2) === raw);
  if (allowed === undefined) throw new Error(`--stage2-cap kan bara vara 0.08 eller 0.12 (fick "${raw}")`);
  return allowed;
}

/** --report-json: .json only, under .planning/phases/ or .planning/calibration/data/; null when the flag is absent. */
function resolveReportJsonPath(): string | null {
  const raw = argValue("--report-json");
  if (raw === null) return null;
  const resolved = resolve(raw);
  const inside = ALLOWED_REPORT_DIRS.some((dir) => {
    const rel = relative(dir, resolved);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  });
  if (!inside) throw new Error(`--report-json måste ligga under .planning/phases/ eller .planning/calibration/data/ (fick ${raw})`);
  if (!resolved.endsWith(".json")) throw new Error("--report-json måste vara en .json-fil");
  return resolved;
}

function resolveOutPath(): string {
  const raw = argValue("--out");
  const resolved = resolve(raw ?? DEFAULT_OUT);
  const inside = ALLOWED_OUT_DIRS.some((dir) => {
    const rel = relative(dir, resolved);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  });
  if (!inside) {
    throw new Error(`--out måste ligga under data/ eller .planning/calibration/data/ (fick ${raw})`);
  }
  if (!resolved.endsWith(".json")) throw new Error("--out måste vara en .json-fil");
  return resolved;
}

/** A file path inside one of the directories, as a resolved absolute path; null when outside. */
function resolveInside(raw: string, dirs: readonly string[]): string | null {
  const resolved = resolve(raw);
  const inside = dirs.some((dir) => {
    const rel = relative(dir, resolved);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  });
  return inside ? resolved : null;
}

// ---------------------------------------------------------------------------
// The stambyte join file (14.6, STAM-02)
// ---------------------------------------------------------------------------

/** What this script reads of `sold-join.json` (plan 06 writes it); extra keys are ignored. */
const stambyteJoinFileSchema = z.looseObject({
  schemaVersion: z.literal(1),
  soldAsOf: z.string(),
  rows: z.record(
    z.string(),
    z.looseObject({
      beteckning: z.string().nullable(),
      cases: z.array(
        z.looseObject({
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          kinds: z.array(z.string()),
          slutbeskedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
          latest: z.looseObject({ type: z.string(), code: z.string().nullable() }).nullable().optional(),
        }),
      ),
    }),
  ),
});
type StambyteJoinFile = z.infer<typeof stambyteJoinFileSchema>;

/**
 * --stambyte-join: the path must sit under .planning/calibration/data/ (gitignored scratch data), end in .json and
 * parse with the schema above. Read BEFORE the sold cache so a bad file stops the script early (T-14.6-63).
 */
function loadStambyteJoin(raw: string): StambyteJoinFile {
  const path = resolveInside(raw, [CALIBRATION_DATA_DIR]);
  if (path === null) throw new Error(`--stambyte-join måste ligga under .planning/calibration/data/ (fick ${raw})`);
  if (!path.endsWith(".json")) throw new Error("--stambyte-join måste vara en .json-fil");
  if (!existsSync(path)) throw new Error(`--stambyte-join: hittar ingen kopplingsfil på ${path} (kör scripts/stambyte-join.ts först)`);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`--stambyte-join: ${relative(CWD, path)} är inte giltig JSON`);
  }
  const parsed = stambyteJoinFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`--stambyte-join: kopplingsfilen klarar inte schemat: ${parsed.error.issues[0]?.message ?? "okänt fel"} (${parsed.error.issues[0]?.path.join(".") ?? ""})`);
  }
  return parsed.data;
}

/**
 * What the city's record said about a sold flat's building ON THE SALE DATE, or null when the building was not
 * identified (or the row is not in the join file): such a row stays out of the stambyte regression.
 */
function stambyteOfSoldRow(join: StambyteJoinFile, row: SoldRow): StambyteTrainingState | null {
  const entry = join.rows[row.booliId];
  if (entry === undefined || entry.beteckning === null) return null;
  const at = stambyteAtSale(entry.cases, row.soldDate);
  return { identified: true, recorded: at.recorded, yearsBefore: at.yearsBefore, ongoingAtSale: at.ongoingAtSale };
}

/** The model file as written: 2-space indent, each kernel point on one line [lat, lng, ln kr/m2]. */
function serialiseModel(model: HedonicModel): string {
  return JSON.stringify(model, null, 2).replace(/\[\s+(-?[\d.eE+-]+),\s+(-?[\d.eE+-]+),\s+(-?[\d.eE+-]+)\s+\]/g, "[$1, $2, $3]");
}

/** --graft-stambyte <donor> [--base <fil>] --out <fil>: only the term moves; no sold cache is read. */
function graftMode(donorRaw: string): void {
  const outRaw = argValue("--out");
  if (outRaw === null) throw new Error("--graft-stambyte kräver en uttrycklig --out (basmodellen skrivs aldrig över av misstag)");
  const outPath = resolveOutPath();
  const read = (flag: string, raw: string): HedonicModel => {
    const path = resolveInside(raw, ALLOWED_OUT_DIRS);
    if (path === null) throw new Error(`${flag} måste ligga under data/ eller .planning/calibration/data/ (fick ${raw})`);
    if (!path.endsWith(".json") || !existsSync(path)) throw new Error(`${flag}: hittar ingen .json-modell på ${path}`);
    return parseHedonicModel(JSON.parse(readFileSync(path, "utf8")));
  };
  const base = read("--base", argValue("--base") ?? DEFAULT_OUT);
  const donor = read("--graft-stambyte", donorRaw);
  const grafted = graftStambyteTerm(base, donor);
  writeTextAtomic(outPath, `${serialiseModel(grafted)}\n`);
  const term = grafted.stambyteTerm;
  console.log(
    `Stambyteterm flyttad från ${relative(CWD, resolve(donorRaw))} till ${relative(CWD, outPath)}: ${term?.kept ? "behållen" : "ej behållen"} (${term?.note ?? ""}). Inget annat tal i basmodellen ändrades.`,
  );
}

// ---------------------------------------------------------------------------
// Formatting (Swedish: decimal comma)
// ---------------------------------------------------------------------------
const sv = (x: number, decimals: number): string => {
  const text = x.toFixed(decimals).replace(".", ",");
  return /^-0(,0+)?$/.test(text) ? text.slice(1) : text;
};
const svSigned = (x: number, decimals: number): string => `${x < 0 ? "-" : "+"}${sv(Math.abs(x), decimals)}`;
const svPct = (fraction: number, decimals = 1): string => `${svSigned(fraction * 100, decimals)} %`;
const fmt = (n: number): string => n.toLocaleString("sv-SE");

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------------------------------------------------------------------------
// Cache rows to training rows
// ---------------------------------------------------------------------------
function isCalibrationListing(row: SoldRow): boolean {
  return (
    row.address !== null &&
    CALIBRATION_ADDRESS.test(row.address) &&
    row.livingArea >= CALIBRATION_AREA_RANGE[0] &&
    row.livingArea <= CALIBRATION_AREA_RANGE[1]
  );
}

/**
 * Tomträtt from the sold page's tenure text: a text with "tomträtt" is true, exactly
 * "Bostadsrätt" is false, anything else (missing, "Äganderätt") is unknown (R-02).
 */
function tomtrattOf(tenureForm: string | null | undefined): boolean | null {
  if (tenureForm === null || tenureForm === undefined) return null;
  if (/tomträtt/i.test(tenureForm)) return true;
  if (tenureForm.trim().toLowerCase() === "bostadsrätt") return false;
  return null;
}

/**
 * `brf` is the cache's one-debt-figure-per-association table (14.4-02). The debt is the
 * association's LATEST annual report, not the figure at the sale date (RESEARCH Pitfall 14).
 */
function toTrainingRow(
  row: SoldRow,
  brf: Readonly<Record<string, BrfEntry>>,
  conditionOf: (row: SoldRow) => -1 | 0 | 1 | null,
): HedonicTrainingRow {
  const e = row.enriched;
  const rent = e?.rentSek ?? null;
  const debt = e?.brfId != null ? (brf[e.brfId]?.debtPerSqm ?? null) : null;
  return {
    district: row.district,
    lat: row.lat,
    lng: row.lng,
    floor: row.floor,
    livingArea: row.livingArea,
    soldPrice: row.soldPrice,
    soldDate: row.soldDate,
    soldVsAskPct: row.soldVsAskPct,
    // The detail page's list price is exact; the card-derived one is rounded to a whole percent.
    askingPrice: row.enriched?.listPrice ?? row.askingPrice,
    balcony: row.enriched?.balcony ?? null,
    buildYear: row.enriched?.buildYear ?? null,
    enriched: row.enriched != null,
    avgiftPerSqmMonth: rent !== null && rent > 0 ? rent / row.livingArea : null,
    brfDebtPerSqm: debt !== null && Number.isFinite(debt) && debt >= 0 ? debt : null,
    tomtratt: tomtrattOf(e?.tenureForm),
    // 14.4 VAL-03: days on market feed the bid premium only (never the resale price).
    daysActive: e?.daysActive ?? null,
    // 14.4 BID-01: the sold photos' condition label (confidence >= 0,6 only); feeds the bid premium only.
    condition: conditionOf(row),
  };
}

/**
 * The condition label of a sold flat from the sold-photo cache (plan 09): the entry of THIS sold listing, THIS picture
 * set and the CURRENT {@link SOLD_CONDITION_VERSION}, coded by `conditionIndexOfRead` (dated -1, ok 0, fresh +1; a read
 * under the confidence bar, or no read, is null and so stays out of the fit, never 0). A missing cache labels nothing.
 */
function conditionLookup(cache: SoldConditionCache): (row: SoldRow) => -1 | 0 | 1 | null {
  return (row) => {
    const ids = soldConditionUsableIds(row.enriched?.imageIds);
    if (ids.length === 0) return null;
    const entry = cache.entries[soldConditionEntryId(row.booliId, ids)];
    if (!entry || entry.promptVersion !== SOLD_CONDITION_VERSION) return null;
    return conditionIndexOfRead(entry.result);
  };
}

/** How many sold flats have a current read at all, and how they split by label (for the printed block). */
function conditionStats(
  rows: readonly SoldRow[],
  cache: SoldConditionCache,
): { read: number; lowConfidence: number; dated: number; ok: number; fresh: number } {
  const out = { read: 0, lowConfidence: 0, dated: 0, ok: 0, fresh: 0 };
  for (const row of rows) {
    const ids = soldConditionUsableIds(row.enriched?.imageIds);
    if (ids.length === 0) continue;
    const entry = cache.entries[soldConditionEntryId(row.booliId, ids)];
    if (!entry || entry.promptVersion !== SOLD_CONDITION_VERSION) continue;
    out.read += 1;
    const idx = conditionIndexOfRead(entry.result);
    if (idx === null) out.lowConfidence += 1;
    else if (idx < 0) out.dated += 1;
    else if (idx > 0) out.fresh += 1;
    else out.ok += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Size check: size per band instead of one slope, with and without the time effect
// ---------------------------------------------------------------------------
interface SizeBandEffect {
  readonly label: string;
  readonly pct: number;
  readonly se: number;
  readonly rows: number;
}
interface SizeCheck {
  readonly rows: number;
  readonly windowFrom: string | null;
  readonly bands: SizeBandEffect[];
}

/** Training rows as the fit sees them (rounded coordinates, ln kr/m2) and the district medians the features need. */
function pointsAndMedians(
  rows: readonly HedonicTrainingRow[],
  asOf: string,
): { points: TrainingPoint[]; medians: Record<InnerstanDistrict, number> } {
  const points: TrainingPoint[] = rows.map((r) => ({
    district: r.district,
    lat: Math.round(r.lat * 1000) / 1000,
    lng: Math.round(r.lng * 1000) / 1000,
    floor: r.floor,
    livingArea: r.livingArea,
    y: Math.log(r.soldPrice / r.livingArea),
    monthsAgo: monthsBetweenIso(r.soldDate, asOf),
    avgiftPerSqmMonth: r.avgiftPerSqmMonth,
    brfDebtPerSqm: r.brfDebtPerSqm,
    tomtratt: r.tomtratt,
  }));
  const medians = {} as Record<InnerstanDistrict, number>;
  const overall = median(points.map((p) => p.y)) ?? 0;
  for (const d of INNERSTAN_DISTRICTS) {
    const own = points.filter((p) => p.district === d).map((p) => p.y);
    medians[d] = own.length >= 30 ? (median(own) as number) : overall;
  }
  return { points, medians };
}

/**
 * Size effect per band relative to the first band (35-40 m2), estimated with the
 * same features as the model (neighbour level, floor, ground floor, time trend,
 * distance to centre) but with five band dummies instead of ln(area). Run once
 * on every sale and once on the latest months only, where all six bands exist
 * side by side, so that "big flats are recent" cannot explain the result.
 * A diagnostic for the report; it does not feed the persisted model.
 */
function sizeCheck(rows: readonly HedonicTrainingRow[], asOf: string, since: string | null): SizeCheck {
  const used = rows.filter((r) => since === null || r.soldDate >= since);
  const { points, medians } = pointsAndMedians(used, asOf);
  const { X } = trainingFeatureMatrix(points, medians);
  const col = (name: (typeof HEDONIC_FEATURES)[number]): number => HEDONIC_FEATURES.indexOf(name);
  const bandOf = (area: number): number => {
    const last = SLUTPRIS_SIZE_BANDS.length - 1;
    for (let i = 0; i <= last; i++) {
      const [lo, hi] = SLUTPRIS_SIZE_BANDS[i];
      if (area >= lo && (area < hi || (i === last && area <= hi))) return i;
    }
    return area < SLUTPRIS_SIZE_BANDS[0][0] ? 0 : last;
  };
  const design = X.map((x, i) => {
    const b = bandOf(points[i].livingArea);
    return [
      x[col("nbLevel")],
      x[col("floor")],
      x[col("groundOrBelow")],
      points[i].monthsAgo,
      x[col("centralityKm")],
      ...SLUTPRIS_SIZE_BANDS.slice(1).map((_, k) => (b === k + 1 ? 1 : 0)),
    ];
  });
  const fit = fitRidge(design, points.map((p) => p.y), HEDONIC_RIDGE_LAMBDA);
  const bands: SizeBandEffect[] = SLUTPRIS_SIZE_BANDS.slice(1).map((band, k) => ({
    label: `${band[0]}-${band[1]} kvm`,
    pct: Math.exp(fit.beta[5 + k]) - 1,
    se: fit.se[5 + k],
    rows: points.filter((p) => bandOf(p.livingArea) === k + 1).length,
  }));
  return { rows: points.length, windowFrom: since, bands };
}

function describeSizeCheck(check: SizeCheck): string[] {
  const head = check.windowFrom === null ? `alla ${fmt(check.rows)} försäljningar` : `försäljningar sedan ${check.windowFrom} (${fmt(check.rows)} st)`;
  return [
    `  ${head}:`,
    ...check.bands.map(
      (b) => `    ${b.label.padEnd(12)} ${svPct(b.pct)} mot 35-40 kvm (SE ${sv(b.se * 100, 1)} %, ${fmt(b.rows)} rader)`,
    ),
  ];
}

// ---------------------------------------------------------------------------
// The 14.4 features: how much evidence stands behind them, and how they overlap
// ---------------------------------------------------------------------------
const NEW_FEATURES = ["avgiftPerSqmMonth", "brfDebtPerSqm", "tomtratt"] as const;

function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

interface NewFeatureDiagnostics {
  /** Correlation of avgift/kvm and debt/kvm over the rows that have both (RESEARCH Q9: 0,37 among the for-sale rows). */
  readonly correlation: number | null;
  readonly correlationRows: number;
  /** 1 / (1 - R²) of regressing the feature on the other eight columns, over the rows where it is known. */
  readonly vif: Partial<Record<"avgiftPerSqmMonth" | "brfDebtPerSqm", number | null>>;
}

/** Overlap between the two continuous new features and with the six old ones (RESEARCH Q9). */
function newFeatureDiagnostics(training: readonly HedonicTrainingRow[], asOf: string): NewFeatureDiagnostics {
  const both = training.filter((r) => r.avgiftPerSqmMonth !== null && r.brfDebtPerSqm !== null);
  const correlation = pearson(
    both.map((r) => r.avgiftPerSqmMonth as number),
    both.map((r) => r.brfDebtPerSqm as number),
  );
  const { points, medians } = pointsAndMedians(training, asOf);
  const { X } = trainingFeatureMatrix(points, medians);
  const vif: NewFeatureDiagnostics["vif"] = {};
  for (const name of ["avgiftPerSqmMonth", "brfDebtPerSqm"] as const) {
    const j = HEDONIC_FEATURES.indexOf(name);
    const idx = training.map((_, i) => i).filter((i) => training[i][name] !== null);
    if (idx.length < 30) {
      vif[name] = null;
      continue;
    }
    const others = HEDONIC_FEATURES.map((_, c) => c).filter((c) => c !== j);
    const fit = fitRidge(
      idx.map((i) => others.map((c) => X[i][c])),
      idx.map((i) => X[i][j]),
      HEDONIC_MIN_LAMBDA,
    );
    vif[name] = fit.r2 >= 1 ? Number.POSITIVE_INFINITY : 1 / (1 - fit.r2);
  }
  return { correlation, correlationRows: both.length, vif };
}

/** Three significant digits with a decimal comma: a debt coefficient is about -0,0000020 per kr/m2, so fixed decimals would print zeros. */
const svSig = (x: number): string => (x === 0 ? "0" : x.toPrecision(3).replace(".", ","));

function svSourceWord(source: "fit" | "prior" | "zeroed"): string {
  if (source === "fit") return "data";
  if (source === "prior") return "studie";
  return "nollställd";
}

/** The block Daniel reads to judge the new coefficients (VAL-02): evidence, raw estimate, what was used, effect in percent. */
function printNewFeatures(args: {
  model: HedonicModel;
  report: HedonicFitReport;
  trainingRows: number;
  knownBefore: Record<(typeof NEW_FEATURES)[number], number>;
  distinctBrfs: number;
  diagnostics: NewFeatureDiagnostics;
}): void {
  const { model, report, trainingRows, knownBefore, distinctBrfs, diagnostics } = args;
  console.log("\nNya egenskaper (14.4):");
  const labels: Record<(typeof NEW_FEATURES)[number], string> = {
    avgiftPerSqmMonth: "Avgift kr/kvm/mån",
    brfDebtPerSqm: "Föreningsskuld kr/kvm",
    tomtratt: "Tomträtt",
  };
  for (const name of NEW_FEATURES) {
    const f = model.features.find((x) => x.name === name)!;
    const rawEst = report.rawEstimates[name];
    const kept = report.knownCounts[name] ?? 0;
    console.log(
      `  ${labels[name]}: kända rader ${fmt(knownBefore[name])} av ${fmt(trainingRows)}` +
        (name === "brfDebtPerSqm" ? `, distinkta föreningar ${fmt(distinctBrfs)}` : "") +
        ` (${fmt(kept)} kvar efter avvikarrensning)`,
    );
    if (rawEst === undefined) {
      console.log("    rå skattning: ingen (egenskapen kunde inte skattas, se reservvärdet nedan)");
    } else {
      console.log(
        `    rå skattning före kontrollen: β ${svSig(rawEst.beta)}, SE ${rawEst.se === null ? "-" : svSig(rawEst.se)}, t = ${rawEst.t === null ? "-" : sv(rawEst.t, 1)}`,
      );
    }
    console.log(`    använd β ${svSig(f.beta)}, källa: ${svSourceWord(f.source)}${f.se === null ? "" : `, SE ${svSig(f.se)}`}`);
    if (name === "avgiftPerSqmMonth") {
      const raw10 = rawEst === undefined ? "" : ` (rå: ${svPct(Math.exp(10 * rawEst.beta) - 1, 2)})`;
      console.log(`    effekt på kvadratmeterpriset: ${svPct(Math.exp(10 * f.beta) - 1, 2)} per 10 kr/kvm/mån${raw10}`);
    } else if (name === "brfDebtPerSqm") {
      const raw1000 = rawEst === undefined ? "" : ` (rå: ${svPct(Math.exp(1000 * rawEst.beta) - 1, 2)})`;
      console.log(`    effekt på kvadratmeterpriset: ${svPct(Math.exp(1000 * f.beta) - 1, 2)} per 1 000 kr/kvm${raw1000}`);
    }
    if (f.lo !== undefined && f.hi !== undefined) {
      console.log(`    värden begränsas till ${sv(f.lo, 1)}–${sv(f.hi, 1)} (1:a–99:e percentilen), medelvärde ${sv(f.mean, 1)}`);
    }
    for (const fb of model.fallbacks.filter((x) => x.item === name)) {
      console.log(`    reservvärde (${fb.reason}): ${fb.detail}`);
    }
  }
  console.log(
    `Korrelation avgift/kvm och skuld/kvm: ${diagnostics.correlation === null ? "-" : sv(diagnostics.correlation, 2)} (n ${fmt(diagnostics.correlationRows)})`,
  );
  const v = (x: number | null | undefined): string => (x === null || x === undefined ? "-" : Number.isFinite(x) ? sv(x, 2) : "oändlig");
  console.log(`VIF: avgift ${v(diagnostics.vif.avgiftPerSqmMonth)}, skuld ${v(diagnostics.vif.brfDebtPerSqm)}`);
}

// ---------------------------------------------------------------------------
// Bid premium: days on market (14.4 VAL-03)
// ---------------------------------------------------------------------------
function printDomBlock(model: HedonicModel, training: readonly HedonicTrainingRow[]): void {
  const withDays = training.filter((r) => r.daysActive !== undefined && r.daysActive !== null);
  const withDaysAndAsk = withDays.filter((r) => r.askingPrice !== null && r.askingPrice > 0);
  const dom = model.bidPremium.terms.dom;
  console.log("\nBudpremie: dagar på marknaden");
  console.log(
    `  Rader med dagar: ${fmt(withDays.length)} av ${fmt(training.length)}; av dem med utgångspris: ${fmt(withDaysAndAsk.length)}.`,
  );
  if (dom === null) {
    console.log(`  Dagar-termen kunde inte prövas: färre än 30 försäljningar med dagar (och utgångspris för den lutande formen). Termen saknas i modellen.`);
    return;
  }
  console.log(`  Försäljningar i skattningen: ${fmt(dom.n)} (basform: ${model.bidPremium.kind === "slope" ? "lutande" : "fast per område"}).`);
  console.log(
    `  Korsvalideringsfel (logskala, samma hållna rader): utan dagar ${sv(dom.cvRmse.without, 5)}, med dagar ${sv(dom.cvRmse.with, 5)} (${dom.cvRmse.with < dom.cvRmse.without ? "lägre" : "inte lägre"}).`,
  );
  console.log(`  Koefficient per ln(1 + dagar): ${sv(dom.beta, 5)} (${dom.beta < 0 ? "negativ: längre annons, lägre premie" : "positiv: längre annons, högre premie"}).`);
  console.log(`  Beslut: ${dom.kept ? "behålls" : "förkastas"} - ${dom.note}`);
  const a = model.bidPremium.overallA;
  const at = (days: number): number => Math.exp(a + dom.beta * (Math.log(1 + days) - dom.mean)) - 1;
  console.log(
    `  Effekt på premien för en median-lägenhet, 7 mot 60 dagar: ${svSigned((at(60) - at(7)) * 100, 2)} procentenheter (${svPct(at(7))} -> ${svPct(at(60))})` +
      `${dom.kept ? "" : "; termen används inte, siffran visar vad den skulle ha gjort"}.`,
  );
}

// ---------------------------------------------------------------------------
// Bid premium: condition from the sold photos (14.4 BID-01, R-08)
// ---------------------------------------------------------------------------
function printConditionBlock(
  model: HedonicModel,
  stats: ReturnType<typeof conditionStats>,
  spentSek: number,
): void {
  const term = model.bidPremium.terms.condition;
  console.log("\nBudpremie: skick");
  const usable = stats.read - stats.lowConfidence;
  const share = (n: number, of: number): string => (of === 0 ? "-" : `${sv((n / of) * 100, 1)} %`);
  console.log(
    `  Sålda lägenheter med läst skick (nuvarande läsversion): ${fmt(stats.read)}; ` +
      `säkerhet under ${sv(SOLD_CONDITION_MIN_CONFIDENCE, 1)} (utesluts, räknas aldrig som 0): ${fmt(stats.lowConfidence)} (${share(stats.lowConfidence, stats.read)}).`,
  );
  console.log(
    `  Användbara avläsningar: ${fmt(usable)} - föråldrat ${fmt(stats.dated)} (${share(stats.dated, usable)}), ` +
      `vanligt ${fmt(stats.ok)} (${share(stats.ok, usable)}), fräscht ${fmt(stats.fresh)} (${share(stats.fresh, usable)}).`,
  );
  console.log(`  Betalt för skicksläsningen hittills: ${sv(spentSek, 2)} kr av 30,00 kr.`);
  if (term === null) {
    console.log("  Skicktermen kunde inte prövas (ingen skickuppgift på någon rad). Termen saknas i modellen.");
    return;
  }
  console.log(`  Märkta försäljningar med slutpris mot utgångspris i skattningen: ${fmt(term.n)}.`);
  console.log(
    term.cvRmse === null
      ? "  Korsvalideringsfel: inte beräknat (för få märkta försäljningar eller ingen variation i skicket)."
      : `  Korsvalideringsfel (logskala, märkta rader): utan skick ${sv(term.cvRmse.without, 5)}, med skick ${sv(term.cvRmse.with, 5)} (${term.cvRmse.with < term.cvRmse.without ? "lägre" : "inte lägre"}).`,
  );
  console.log(`  Beslut: ${term.kept ? "behålls" : "förkastas, termen är 0 och budpremien säger 'skick ej mätt'"}; koefficient (steg i skick): ${sv(term.beta, 5)}.`);
  console.log(`  Not: ${term.note}`);
}

/**
 * CEIL-02 / R-03: Booli's sold-detail pages carry no broker text, so no sold row can state a ceiling height and the
 * hedonic ceiling feature is not built. Printed and written on every fit.
 */
const CEILING_SOLD_ROWS_WITH_HEIGHT = 0;
const CEILING_REASON = "sålda sidor har ingen annonstext, R-03; ej anpassad (för få angivna)";
const CEILING_LINE = `Takhöjd: ${CEILING_SOLD_ROWS_WITH_HEIGHT} sålda rader med angiven höjd (sålda sidor har ingen annonstext, R-03); ej anpassad (för få angivna)`;

/** The stage-2 block (D-02, R-01): what stage 2 measured, how sure it is, and which cap predicts held-out sales better. */
function printStage2(s2: Stage2Report | null, stage1Cv: number): void {
  if (s2 === null) {
    console.log("\nSteg 2 (balkong och byggår): för få försäljningar med detaljuppgifter, ingen mätning.");
  } else {
    console.log(`\nSteg 2 (balkong och byggår), n ${fmt(s2.n)}, tak ±${sv(s2.capPct * 100, 0)} %`);
    const onCapMark = (pct: number): string => (Math.abs(Math.abs(pct) - s2.capPct) < 1e-9 ? " (på taket)" : "");
    const b = s2.balcony;
    console.log(
      `  Balkong: rått ${svPct(b.pctRaw)}${b.se === null ? "" : `, SE ≈ ${sv(b.se * 100, 1)} %`}, anpassat ${svPct(b.pct)}${b.source === "prior" ? " (studiens värde, datan var för osäker)" : ""}${onCapMark(b.pct)}`,
    );
    const labels = { le1930: "före 1931", y1931to1960: "1931–1960", y1961to1990: "1961–1990", ge1991: "1991 och senare" } as const;
    for (const key of Object.keys(labels) as (keyof typeof labels)[]) {
      const v = s2.buckets[key];
      console.log(
        `  Byggår ${labels[key]}: n ${fmt(v.n)}, rått ${svPct(v.pctRaw)}${v.seApprox === null ? "" : `, SE ≈ ${sv(v.seApprox * 100, 1)} %`}, anpassat ${svPct(v.pct)}${onCapMark(v.pct)}`,
      );
    }
    console.log(`På taket: ${s2.onCap.length === 0 ? "inget" : s2.onCap.join(", ")}`);
    console.log(
      `Steg-2-korsvalidering (fel i ln kr/kvm): utan steg 2 ${sv(s2.cv.without, 5)}, med ±8 % ${sv(s2.cv.byCap["0.08"], 5)}, med ±12 % ${sv(s2.cv.byCap["0.12"], 5)}`,
    );
    console.log(
      `  Samma fel med den gamla, ocentrerade prissättningen före 14.5-11 (balkong sant x (1 + procent), annars x 1): med ±8 % ${sv(s2.cv.asApplied["0.08"], 5)}, med ±12 % ${sv(s2.cv.asApplied["0.12"], 5)}. ` +
        "Byggårsvärdena gäller en lägenhet med genomsnittlig balkongandel, så en känd balkong fick där ett tillägg som överskattade ungefär (andel med balkong x balkongeffekt). Prissättningen centrerar nu balkongen på den andelen, så det som gäller är raden ovan.",
    );
  }
  console.log(
    `Steg-1-korsvalidering (cvRmseLog) räknas före steg 2 och kan inte skilja ±8 % från ±12 %: ${sv(stage1Cv, 5)} för båda.`,
  );
  console.log(CEILING_LINE);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main(): void {
  const graftDonor = argValue("--graft-stambyte");
  if (graftDonor !== null) {
    graftMode(graftDonor);
    return;
  }
  const stage2Cap = resolveStage2Cap();
  const reportJsonPath = resolveReportJsonPath();
  const cachePath = resolve(argValue("--cache") ?? DEFAULT_CACHE);
  const outPath = resolveOutPath();
  // 14.6: the join file is checked before anything is read (T-14.6-63).
  const stambyteJoinRaw = argValue("--stambyte-join");
  const stambyteJoin = stambyteJoinRaw === null ? null : loadStambyteJoin(stambyteJoinRaw);
  // R-05: the intermediate model (old feature set) must never replace the committed one.
  const intermediate = hasFlag("--without-new-features");
  // IN-10: the check matches its message - the path must really sit under .planning/calibration/data/, not merely
  // differ from the default (data/other.json would otherwise pass).
  const calibrationRel = relative(CALIBRATION_DATA_DIR, outPath);
  const underCalibrationData = calibrationRel !== "" && !calibrationRel.startsWith("..") && !isAbsolute(calibrationRel);
  if (intermediate && (argValue("--out") === null || !underCalibrationData)) {
    throw new Error("--without-new-features kräver --out under .planning/calibration/data/ (den committade modellen skrivs aldrig över av en mellanmodell)");
  }
  // Read-only comparison record (T-14.4-12): .json only, parsed with the run-record schema.
  const beforePath = argValue("--before-record");
  let before: ReturnType<typeof parseFitRunRecord> | null = null;
  if (beforePath !== null) {
    if (!beforePath.endsWith(".json")) throw new Error("--before-record måste vara en .json-fil");
    const beforeFile = resolve(beforePath);
    if (!existsSync(beforeFile)) throw new Error(`Hittar ingen jämförelsefil på ${beforeFile}`);
    before = parseFitRunRecord(JSON.parse(readFileSync(beforeFile, "utf8")));
  }
  if (intermediate) console.log("Mellanmodell: de tre nya egenskaperna utelämnade (R-05)");
  if (!existsSync(cachePath)) throw new Error(`Hittar ingen cache på ${cachePath} (kör scripts/pull-slutpriser.ts först)`);

  const parsed = slutprisCacheSchema.safeParse(JSON.parse(readFileSync(cachePath, "utf8")));
  if (!parsed.success) {
    throw new Error(`Cachefilen klarar inte schemat: ${parsed.error.issues[0]?.message ?? "okänt fel"}`);
  }
  const cache = parsed.data;
  const asOf = argValue("--as-of") ?? cache.asOf;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error(`--as-of måste vara YYYY-MM-DD (fick ${asOf})`);
  const fittedAt = new Date().toISOString().slice(0, 10);

  // Training rows; the calibration listing is kept out (Pitfall 10).
  const excluded = cache.rows.filter(isCalibrationListing);
  const brfTable = cache.brf ?? {};
  const trainingSource = cache.rows.filter((r) => !isCalibrationListing(r));
  const conditionCacheLoaded = loadSoldConditionCache(join(CWD, SOLD_CONDITION_CACHE_PATH));
  if (conditionCacheLoaded.warning !== null) console.warn(conditionCacheLoaded.warning);
  const conditionCache = conditionCacheLoaded.cache;
  const withNew = trainingSource.map((r) => {
    const row = toTrainingRow(r, brfTable, conditionLookup(conditionCache));
    return stambyteJoin === null ? row : { ...row, stambyte: stambyteOfSoldRow(stambyteJoin, r) };
  });
  // The intermediate model sees the same rows with the three new columns blanked, so they come out "absent".
  // It also sees no condition labels: the bid-premium condition term belongs to neither "refit" nor "new
  // features", and a term kept there by a hair would leak into the before/after split of the VAL-05 report (T-14.4-40).
  const training = intermediate
    ? withNew.map((r) => ({ ...r, avgiftPerSqmMonth: null, brfDebtPerSqm: null, tomtratt: null, condition: null }))
    : withNew;
  const enrichedRows = training.filter((r) => r.enriched);

  console.log("=== MODELLANPASSNING (offline, inga nätverksanrop) ===");
  console.log(`Cache: ${relative(CWD, cachePath)} (sålda ${cache.cutoff} till ${cache.asOf}), prisnivå per ${asOf}, anpassad ${fittedAt}`);
  console.log(`Rader i cachen: ${fmt(cache.rows.length)}. Uteslutna som kalibreringsobjekt (Folkungagatan 61, ${CALIBRATION_AREA_RANGE[0]}-${CALIBRATION_AREA_RANGE[1]} kvm): ${excluded.length}`);
  console.log(`Rader med detaljuppgifter (byggår/balkong från försäljningssidan): ${fmt(enrichedRows.length)}`);

  console.log(`Steg-2-tak: ±${sv(stage2Cap * 100, 0)} % (balkong och byggår begränsas till detta)`);
  const stambyteStage = stambyteJoin !== null;
  if (stambyteJoin !== null && stambyteJoin.soldAsOf !== cache.asOf) {
    console.warn(`VARNING: kopplingsfilen bygger på försäljningar per ${stambyteJoin.soldAsOf}, cachen per ${cache.asOf}; rader som saknas i kopplingsfilen räknas som okända.`);
  }
  let { model: fitted, report } = fitHedonicModel(training, { asOf, fittedAt, stage2CapPct: stage2Cap, stambyteStage });

  // What stage 2 measured on the full detail sample, kept even when the thin-bucket gate below drops it from the model.
  const measuredStage2 = report.stage2;

  // Detail-sample evidence, and the gate that decides whether to trust it.
  const detail = training.filter((r) => r.enriched && r.balcony !== null && r.buildYear !== null);
  const bucketCounts = BUILD_YEAR_BUCKETS.map((b) => detail.filter((r) => b.test(r.buildYear as number)).length);
  const thinBuckets = BUILD_YEAR_BUCKETS.filter((_, i) => bucketCounts[i] < STAGE2_MIN_PER_BUCKET).map((b) => b.label);
  let detailDropped = false;
  console.log(
    `\nDetaljurval: ${detail.length} försäljningar med både balkong- och byggårsuppgift; ` +
      `balkong angiven på ${detail.filter((r) => r.balcony === true).length}. ` +
      `Per byggårsgrupp: ${BUILD_YEAR_BUCKETS.map((b, i) => `${b.label} ${bucketCounts[i]}`).join(", ")}.`,
  );
  if (detail.length > 0 && thinBuckets.length > 0) {
    const asMeasured = fitted.stage2;
    console.log(
      `  Underlaget är för tunt för byggår: ${thinBuckets.join(", ")} har under ${STAGE2_MIN_PER_BUCKET} försäljningar. ` +
        `Som uppmätt (för information, används inte): balkong ${svPct(asMeasured.balcony.pct)} (${asMeasured.balcony.source === "fit" ? "anpassad" : "studiens värde, data var för osäker"}), ` +
        `byggår ${asMeasured.buildYear === null ? "-" : `före 1931 ${svPct(asMeasured.buildYear.pctByBucket.le1930)}, 1931-60 ${svPct(asMeasured.buildYear.pctByBucket.y1931to1960)}, 1961-90 ${svPct(asMeasured.buildYear.pctByBucket.y1961to1990)}, 1991- ${svPct(asMeasured.buildYear.pctByBucket.ge1991)}`}.`,
    );
    console.log("  Detaljurvalet lämnas därför utanför modellen: balkong = studiens värde, ingen byggårsjustering (D-18/R-05 reservväg).");
    ({ model: fitted, report } = fitHedonicModel(
      training.map((r) => ({ ...r, balcony: null, buildYear: null, enriched: false })),
      { asOf, fittedAt, stage2CapPct: stage2Cap, stambyteStage },
    ));
    detailDropped = true;
  }

  // The size explanation goes into the model's own description when size was not taken from the data.
  const sizeFeature = fitted.features.find((f) => f.name === "lnArea");
  const windowFrom = subtractMonthsIso(asOf, SIZE_CHECK_WINDOW_MONTHS);
  const sizeAll = sizeCheck(training, asOf, null);
  const sizeRecent = sizeCheck(training, asOf, windowFrom);
  const notes: string[] = [];
  let sizeNote: string | null = null;
  if (sizeFeature && sizeFeature.source === "fit") {
    const recent = sizeRecent.bands;
    const big = recent[recent.length - 1];
    const mid = recent[recent.length - 2];
    const t = sizeFeature.se !== null && sizeFeature.se > 0 ? Math.abs(sizeFeature.beta / sizeFeature.se) : null;
    sizeNote =
      `Storlek: koefficienten tas från data (beslut D-10, ${fittedAt}). Riktningsregeln för storlek (större = billigare per kvm) togs bort vid ominpassningen ${fittedAt} ` +
      `(granskningsfynd WR-06 i 14.1), eftersom försäljningarna visar att större innerstadslägenheter kostar MER per kvm ` +
      `(koefficient ${sv(sizeFeature.beta, 4)}${sizeFeature.se !== null ? `, SE ${sv(sizeFeature.se, 4)}` : ""}${t !== null ? `, t = ${sv(t, 1)}` : ""}, härledd ur marknaden), ` +
      `och regeln nollställde den säkraste koefficienten i modellen. ` +
      `Mätt på försäljningar sedan ${windowFrom}, då alla storlekar finns sida vid sida: ${mid.label} ${svPct(mid.pct)} och ${big.label} ${svPct(big.pct)} mot 35-40 kvm. ` +
      `Mellan 35 och 50 kvm är effekten nära noll (${recent.slice(0, 2).map((b) => `${b.label} ${svPct(b.pct)}`).join(", ")}), så för lägenheter i den storleken ändras priserna lite; ` +
      `för 60-120 kvm höjs modellpriset märkbart. Daniel kan ändra beslutet D-10 genom att återställa riktningsregeln och passa om modellen.`;
    notes.push(sizeNote);
  }
  if (sizeFeature && sizeFeature.source !== "fit") {
    const recent = sizeRecent.bands;
    const big = recent[recent.length - 1];
    const mid = recent[recent.length - 2];
    notes.push(
      `Storlek: ${sizeFeature.source === "zeroed" ? "nollställd" : "ersatt med studiens värde"}. ` +
        `Sålda lägenheter är i snitt DYRARE per kvm ju större de är (${mid.label} ${svPct(mid.pct)}, ${big.label} ${svPct(big.pct)} mot 35-40 kvm, ` +
        `mätt på försäljningar sedan ${windowFrom} då alla storlekar finns sida vid sida, så det beror inte på att stora lägenheter råkar vara nyare). ` +
        `Modellen förväntar sig tvärtom (större = billigare per kvm), så regeln i D-18 sätter storlekseffekten till noll i stället för att lita på riktningen. ` +
        `Mellan 35 och 50 kvm är skillnaden nära noll (${recent.slice(0, 2).map((b) => `${b.label} ${svPct(b.pct)}`).join(", ")}), så för lägenheter i den storleken spelar nollställningen ingen roll; för 60-120 kvm räknar modellen ungefär ${sv(Math.abs(big.pct) * 100, 0)} % för lågt. ` +
        `Daniel avgör om riktningsregeln ska släppas för storlek.`,
    );
  }
  if (detailDropped) {
    notes.push(
      `Balkong och byggår: detaljurvalet (${detail.length} försäljningar med båda uppgifterna) var för litet för att mäta byggårsgrupperna (minst ${STAGE2_MIN_PER_BUCKET} per grupp krävs), ` +
        `så balkong = studiens värde ${svPct(fitted.stage2.balcony.pct)} och ingen byggårsjustering görs. ` +
        `I urvalet gav Booli säljobjektet bara för försäljningar från oktober 2025 och senare, och ${bucketCounts[0]} av ${detail.length} är byggda före 1931.`,
    );
  }
  const knownBefore = {
    avgiftPerSqmMonth: training.filter((r) => r.avgiftPerSqmMonth !== null).length,
    brfDebtPerSqm: training.filter((r) => r.brfDebtPerSqm !== null).length,
    tomtratt: training.filter((r) => r.tomtratt !== null).length,
  };
  const distinctBrfs = new Set(
    trainingSource.filter((_, i) => training[i].brfDebtPerSqm !== null).map((r) => r.enriched?.brfId),
  ).size;
  if (intermediate) {
    notes.push(
      "Mellanmodell (R-05): de tre nya egenskaperna (avgift/kvm/mån, föreningsskuld/kvm, tomträtt) är utelämnade ur anpassningen; modellen används bara för att skilja effekten av ominpassningen från effekten av de nya egenskaperna.",
    );
  } else {
    const firstDetailDate = trainingSource
      .filter((_, i) => training[i].avgiftPerSqmMonth !== null)
      .map((r) => r.soldDate)
      .sort()[0];
    const tomtrattAbsent = fitted.fallbacks.some((f) => f.item === "tomtratt" && f.reason === "absent");
    notes.push(
      `Avgift per kvm och månad och föreningsskuld per kvm kommer från Booli-sidor för sålda lägenheter` +
        `${firstDetailDate === undefined ? "" : ` (sålda från ${firstDetailDate})`}: avgift känd för ${fmt(knownBefore.avgiftPerSqmMonth)} försäljningar, ` +
        `skuld för ${fmt(knownBefore.brfDebtPerSqm)} (${fmt(distinctBrfs)} föreningar); övriga försäljningar läggs på medelvärdet av de kända och påverkar därför inte koefficienten. ` +
        `Föreningsskulden är föreningens senaste årsredovisning, inte siffran vid försäljningen. ` +
        (tomtrattAbsent
          ? "Tomträtt kan inte skattas (ingen variation i underlaget) och är nollställd."
          : "Tomträtt är skattad ur underlaget."),
    );
  }
  if (fitted.bidPremium.terms.dom !== null) {
    const dom = fitted.bidPremium.terms.dom;
    notes.push(
      `Dagar på marknaden i budpremien: ${dom.kept ? "används" : "prövades men används inte"} (${dom.note}). ` +
        "Kandidatens dagar ute är hittills, inte slutliga; det ger långa annonser en något högre premie (dokumenterat, ej korrigerat).",
    );
  }
  if (fitted.bidPremium.terms.condition !== null) {
    const cond = fitted.bidPremium.terms.condition;
    notes.push(
      cond.kept
        ? `Skick i budpremien: används (${cond.note})`
        : `Skick i budpremien: används inte, budpremien säger "skick ej mätt" (${cond.note.replace(/^budpremie: skick ej mätt: /, "")})`,
    );
  }
  const note = notes.length > 0 ? notes.join(" ") : undefined;
  // When the detail sample was left out, the library's own fallback text says "0 sales with details",
  // which is true of the refit but not of the data. Replace it with the real reason.
  const fallbacks = detailDropped
    ? fitted.fallbacks.map((f) =>
        f.item === "balcony"
          ? { ...f, detail: `balkong: detaljurvalet (${detail.length} försäljningar) var för litet för att mäta byggårsgrupperna, så balkongen mäts inte heller; studiens värde ${svPct(fitted.stage2.balcony.pct)} används.` }
          : f.item === "buildYear"
            ? { ...f, detail: `byggår: detaljurvalet (${detail.length} försäljningar, ${bucketCounts[0]} av dem byggda före 1931) har under ${STAGE2_MIN_PER_BUCKET} försäljningar i ${thinBuckets.length} av 4 byggårsgrupper; ingen byggårsjustering görs.` }
            : f,
      )
    : fitted.fallbacks;
  const model: HedonicModel = hedonicModelSchema.parse({ ...fitted, fallbacks, ...(note ? { note } : {}) });

  // ---- report ----
  const lines = describeModel(model);
  console.log(
    `\nAnvända rader: ${fmt(model.n)} av ${fmt(training.length)} (${report.droppedOutliers} avvikare uteslutna).` +
      (detailDropped ? "" : ` Rader med både balkong- och byggårsuppgift i den kvarvarande datan: ${report.enrichedN}.`),
  );
  console.log(`Modellen bygger på ${sv(model.minLivingArea, 0)}–${sv(model.maxLivingArea, 0)} kvm; kandidater utanför flaggas.`);

  console.log("\nRader per storleksband (kvm, före avvikarrensning):");
  for (const [lo, hi] of SLUTPRIS_SIZE_BANDS) {
    const n = training.filter((r) => r.livingArea >= lo && (r.livingArea < hi || (hi === SLUTPRIS_SIZE_BANDS[SLUTPRIS_SIZE_BANDS.length - 1][1] && r.livingArea <= hi))).length;
    console.log(`  ${`${lo}-${hi}`.padEnd(8)} ${fmt(n).padStart(6)}`);
  }

  console.log(`\nR²: ${sv(model.r2, 3)} (på samma data). Korsvalidering (5 delar), RMSE i logskala: ${sv(model.cvRmseLog, 3)}; per del: ${report.cvByFold.map((v) => sv(v, 3)).join(", ")}`);
  if (before !== null) {
    console.log(
      `Jämförelse med modellen före 14.4 (version ${before.model.version}): R² ${sv(before.model.r2, 3)} -> ${sv(model.r2, 3)}, ` +
        `korsvalidering ${sv(before.model.cvRmseLog, 3)} -> ${sv(model.cvRmseLog, 3)}, n ${fmt(before.model.n)} -> ${fmt(model.n)}`,
    );
  }
  console.log(`Smearing: ${sv(model.smearing, 3)}. Residualens 75:e percentil (log): ${sv(model.residualP75Log, 3)}. Residualens SD (log): ${sv(model.residualSdLog, 3)}`);

  console.log("\nKoefficienter och slutsatser i klartext:");
  for (const l of lines) console.log(`  - ${l}`);

  printStage2(measuredStage2, model.cvRmseLog);
  if (report.stambyte !== undefined) {
    console.log("");
    for (const l of formatStambyteBlock(report.stambyte)) console.log(l);
  }

  if (intermediate) {
    console.log("\nNya egenskaper (14.4): utelämnade i den här körningen (mellanmodell, R-05).");
  } else {
    printNewFeatures({
      model,
      report,
      trainingRows: training.length,
      knownBefore,
      distinctBrfs,
      diagnostics: newFeatureDiagnostics(training, asOf),
    });
  }

  const bid = model.bidPremium;
  console.log(
    `\nBudpremie, vald form: ${bid.kind === "slope" ? "lutande (premien beror på hur långt utgångspriset ligger från modellens pris)" : "fast per område"}. ` +
      `Korsvalideringsfel (logskala): fast ${sv(bid.cvRmse.flat, 4)}, lutande ${bid.cvRmse.slope === null ? "ej beräknad" : sv(bid.cvRmse.slope, 4)}.`,
  );
  console.log("Budpremie per område (modellen) mot rå median av slutpris mot utgångspris och studiens siffra (CONTEXT D-03):");
  for (const d of INNERSTAN_DISTRICTS) {
    const entry = bid.perDistrict[d];
    const raw = median(training.filter((r) => r.district === d && r.soldVsAskPct !== null).map((r) => r.soldVsAskPct as number));
    console.log(
      `  ${d.padEnd(12)} modell ${svPct(Math.exp(entry.a) - 1)} (n ${entry.n}, ${entry.source === "fit" ? "anpassad" : "reservvärde"})` +
        `   rå median ${raw === null ? "-" : `${svSigned(raw, 1)} %`}   studien ${STUDY_PREMIUM[d] ?? "(ingen studiesiffra)"}`,
    );
  }
  if (bid.kind === "slope") {
    console.log(`  (Lutande form: modellens siffra gäller när utgångspriset är lika med modellens pris, b = ${sv(bid.b ?? 0, 2)}; den är därför inte direkt jämförbar med råmedianen.)`);
  }
  console.log(`Andel försäljningar utan etikett (utelämnade ur budpremien, räknas inte som noll): ${sv(bid.nullLabelShare * 100, 1)} %`);
  printDomBlock(model, training);
  printConditionBlock(model, conditionStats(trainingSource, conditionCache), soldConditionSpentSek(conditionCache));

  console.log("\nStorlekskontroll (storlek per band mot 35-40 kvm, samma variabler som modellen men utan tidsblandning):");
  for (const l of [...describeSizeCheck(sizeAll), ...describeSizeCheck(sizeRecent)]) console.log(l);
  const sizeSource = sizeFeature?.source ?? "fit";
  console.log(
    `  Storleksvalet i modellen: ${sizeSource === "fit" ? (sizeNote ?? "koefficienten från data används") : sizeSource === "zeroed" ? "NOLLSTÄLLD av riktningsregeln (D-18); förklaringen ligger i modellfilens note" : "ersatt av studiens värde"}`,
  );

  console.log("\nReservvärden (fallbacks):");
  if (model.fallbacks.length === 0) console.log("  inga");
  for (const f of model.fallbacks) console.log(`  - ${f.item} (${f.reason}): ${f.detail}`);

  const okR2 = model.r2 >= SANITY_MIN_R2;
  const okCv = model.cvRmseLog <= SANITY_MAX_CV_RMSE;
  console.log(
    okR2 && okCv
      ? `\nR² >= ${sv(SANITY_MIN_R2, 2)} och CV-RMSE <= ${sv(SANITY_MAX_CV_RMSE, 2)}: OK (R² ${sv(model.r2, 3)}, CV-RMSE ${sv(model.cvRmseLog, 3)})`
      : `\nVARNING: R² ${sv(model.r2, 3)} (krav ${sv(SANITY_MIN_R2, 2)}), CV-RMSE ${sv(model.cvRmseLog, 3)} (tak ${sv(SANITY_MAX_CV_RMSE, 2)}). Värdena redovisas som uppmätta; inget är justerat för att klara kravet.`,
  );

  // ---- write ----
  // 2-space indent, but each kernel point on one line: [lat, lng, ln kr/m2].
  const json = serialiseModel(model);
  // Temp file + rename (IN-10): a crash mid-write must not leave a truncated committed model that every consumer refuses.
  writeTextAtomic(outPath, `${json}\n`);
  console.log(`\nModell skriven: ${relative(CWD, outPath)} (${fmt(Math.round(json.length / 1024))} kB, ${fmt(model.kernel.points.length)} punkter)`);

  if (reportJsonPath !== null) {
    if (measuredStage2 === null) throw new Error("--report-json: ingen steg-2-mätning (för få försäljningar med detaljuppgifter)");
    const diagnostics = newFeatureDiagnostics(training, asOf);
    const payload = {
      version: 1 as const,
      capPct: stage2Cap,
      n: model.n,
      r2: model.r2,
      cvRmseLog: model.cvRmseLog,
      enrichedRows: enrichedRows.length,
      stage2: measuredStage2,
      correlation: { avgiftDebt: diagnostics.correlation, rows: diagnostics.correlationRows },
      ceiling: { soldRowsWithHeight: CEILING_SOLD_ROWS_WITH_HEIGHT, fitted: false, reason: CEILING_REASON },
      // 14.6: only when the stambyte stage ran; the report schema is loose, so older readers ignore it.
      ...(report.stambyte !== undefined ? { stambyte: report.stambyte } : {}),
    };
    // Validated against the shape plan 03 defined before anything is written.
    fitReportJsonSchema.parse(payload);
    writeTextAtomic(reportJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`Anpassningsrapport skriven: ${relative(CWD, reportJsonPath)}`);
  }
}

try {
  main();
} catch (e) {
  console.error("FEL:", e instanceof Error ? e.message : e);
  process.exit(1);
}
