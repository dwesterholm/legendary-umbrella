/**
 * Offline refit of the hedonic price model (Phase 14.1, FIT-01 "refit offline",
 * FIT-02, D-18, R-07, R-08, R-12). Reads the gitignored sold-price cache, fits
 * the model, prints it in plain Swedish and writes the aggregate model JSON that
 * `scripts/fit-score.ts` and Phase 14.2 load.
 *
 *   npx tsx scripts/fit-hedonic.ts [--cache .planning/calibration/data/slutpriser-cache.json] \
 *       [--out data/hedonic-model.json] [--as-of <YYYY-MM-DD, default: the cache's asOf>] \
 *       [--before-record <fil.json>] [--without-new-features --out <fil>]
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  HEDONIC_FEATURES,
  HEDONIC_MIN_LAMBDA,
  HEDONIC_RIDGE_LAMBDA,
  INNERSTAN_DISTRICTS,
  describeModel,
  fitHedonicModel,
  fitRidge,
  hedonicModelSchema,
  monthsBetweenIso,
  trainingFeatureMatrix,
  type HedonicFitReport,
  type HedonicModel,
  type HedonicTrainingRow,
  type InnerstanDistrict,
  type TrainingPoint,
} from "@/lib/discovery/hedonic-model";
import {
  slutprisCacheSchema,
  subtractMonthsIso,
  SLUTPRIS_SIZE_BANDS,
  type BrfEntry,
  type SoldRow,
} from "@/lib/booli/slutpriser";
import { parseFitRunRecord } from "@/lib/discovery/valuation-report";

const CWD = process.cwd();
const DEFAULT_CACHE = join(CWD, ".planning", "calibration", "data", "slutpriser-cache.json");
const DEFAULT_OUT = join(CWD, "data", "hedonic-model.json");
const ALLOWED_OUT_DIRS = [join(CWD, "data"), join(CWD, ".planning", "calibration", "data")];

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
function toTrainingRow(row: SoldRow, brf: Readonly<Record<string, BrfEntry>>): HedonicTrainingRow {
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
  };
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
// main
// ---------------------------------------------------------------------------
function main(): void {
  const cachePath = resolve(argValue("--cache") ?? DEFAULT_CACHE);
  const outPath = resolveOutPath();
  // R-05: the intermediate model (old feature set) must never replace the committed one.
  const intermediate = hasFlag("--without-new-features");
  if (intermediate && (argValue("--out") === null || outPath === DEFAULT_OUT)) {
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
  const withNew = trainingSource.map((r) => toTrainingRow(r, brfTable));
  // The intermediate model sees the same rows with the three new columns blanked, so they come out "absent".
  const training = intermediate
    ? withNew.map((r) => ({ ...r, avgiftPerSqmMonth: null, brfDebtPerSqm: null, tomtratt: null }))
    : withNew;
  const enrichedRows = training.filter((r) => r.enriched);

  console.log("=== MODELLANPASSNING (offline, inga nätverksanrop) ===");
  console.log(`Cache: ${relative(CWD, cachePath)} (sålda ${cache.cutoff} till ${cache.asOf}), prisnivå per ${asOf}, anpassad ${fittedAt}`);
  console.log(`Rader i cachen: ${fmt(cache.rows.length)}. Uteslutna som kalibreringsobjekt (Folkungagatan 61, ${CALIBRATION_AREA_RANGE[0]}-${CALIBRATION_AREA_RANGE[1]} kvm): ${excluded.length}`);
  console.log(`Rader med detaljuppgifter (byggår/balkong från försäljningssidan): ${fmt(enrichedRows.length)}`);

  let { model: fitted, report } = fitHedonicModel(training, { asOf, fittedAt });

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
      { asOf, fittedAt },
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
  mkdirSync(dirname(outPath), { recursive: true });
  // 2-space indent, but each kernel point on one line: [lat, lng, ln kr/m2].
  const json = JSON.stringify(model, null, 2).replace(
    /\[\s+(-?[\d.eE+-]+),\s+(-?[\d.eE+-]+),\s+(-?[\d.eE+-]+)\s+\]/g,
    "[$1, $2, $3]",
  );
  writeFileSync(outPath, `${json}\n`);
  console.log(`\nModell skriven: ${relative(CWD, outPath)} (${fmt(Math.round(json.length / 1024))} kB, ${fmt(model.kernel.points.length)} punkter)`);
}

try {
  main();
} catch (e) {
  console.error("FEL:", e instanceof Error ? e.message : e);
  process.exit(1);
}
