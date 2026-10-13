/**
 * Offline refit of the hedonic price model (Phase 14.1, FIT-01 "refit offline",
 * FIT-02, D-18, R-07, R-08, R-12). Reads the gitignored sold-price cache, fits
 * the model, prints it in plain Swedish and writes the aggregate model JSON that
 * `scripts/fit-score.ts` and Phase 14.2 load.
 *
 *   npx tsx scripts/fit-hedonic.ts [--cache .planning/calibration/data/slutpriser-cache.json] \
 *       [--out data/hedonic-model.json] [--as-of <YYYY-MM-DD, default: the cache's asOf>]
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
  HEDONIC_RIDGE_LAMBDA,
  INNERSTAN_DISTRICTS,
  describeModel,
  fitHedonicModel,
  fitRidge,
  hedonicModelSchema,
  monthsBetweenIso,
  trainingFeatureMatrix,
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
  const points: TrainingPoint[] = used.map((r) => ({
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
// main
// ---------------------------------------------------------------------------
function main(): void {
  const cachePath = resolve(argValue("--cache") ?? DEFAULT_CACHE);
  const outPath = resolveOutPath();
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
  const training = cache.rows.filter((r) => !isCalibrationListing(r)).map((r) => toTrainingRow(r, brfTable));
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
  console.log(`Smearing: ${sv(model.smearing, 3)}. Residualens 75:e percentil (log): ${sv(model.residualP75Log, 3)}. Residualens SD (log): ${sv(model.residualSdLog, 3)}`);

  console.log("\nKoefficienter och slutsatser i klartext:");
  for (const l of lines) console.log(`  - ${l}`);

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
