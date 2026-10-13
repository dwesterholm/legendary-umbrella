/**
 * Resumable puller for the Booli sold-price (slutpriser) dataset the hedonic
 * model is fitted on (Phase 14.1, FIT-01, D-17). COSTLY: every page is a paid
 * Apify render (about 0.04-0.06 USD each), pre-approved up to the monthly
 * limit and flagged, not gated (R-13).
 *
 *   npx tsx scripts/pull-slutpriser.ts [--months 18] [--concurrency 8] [--max-renders 400] \
 *       [--budget-usd 25] [--cache .planning/calibration/data/slutpriser-cache.json]
 *   npx tsx scripts/pull-slutpriser.ts --dry-run       # prints the plan, spends nothing
 *   npx tsx scripts/pull-slutpriser.ts --report-only   # summarises the cache, spends nothing
 *   npx tsx scripts/pull-slutpriser.ts --enrich-sample 110 --budget-usd 4.2 --max-renders 110
 *       # 14.1-08: renders the sold DETAIL page of up to 110 not-yet-enriched rows (one paid render each)
 *       # and stores build year, balcony and list price on them; re-run to continue, spends nothing when 0 are left
 *       # --enrich-since 2025-10-01 limits it to sales on or after that day (older sold pages no longer carry the data)
 *
 * What it pulls: the four innerstan districts x the six R-12 size bands
 * (35-120 m2), lagenhet only, sold within the last --months months. The two
 * upper bands are capped at SLUTPRIS_UPPER_BAND_MAX_PAGES pages per district.
 * Re-running resumes: finished pages are not rendered again, failed pages are
 * retried. The cache is the only thing written, and only inside
 * `.planning/calibration/data/` (gitignored, T-14.1-04, T-14.1-12).
 *
 * Renderer (Phase 14.2, D-03, R-03): pages are read by a headed Chromium on this
 * Mac by default (--renderer local|apify or BOOLI_RENDERER; see
 * src/lib/booli/local-browser.ts). That costs nothing: the Apify token, the
 * RENDER_MEMORY_MB check, the monthly-headroom check and the --budget-usd
 * arithmetic are all skipped. A page the local browser cannot get after one
 * retry goes to Apify only with --allow-apify (capped by --apify-max-renders,
 * default 10). With --renderer apify everything below is as in 14.1. The local
 * browser serves 2 pages at a time whatever --concurrency says.
 *
 * Secret posture: prints "satt"/"saknas" for the Apify token, never the value.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  RENDER_MEMORY_MB,
  runPlaywrightRender,
  apifyMonthlyHeadroomUsd,
  apifySpendSince,
  formatApifyRunsLine,
  waitForLedgerSettle,
} from "@/lib/booli/transport";
import { APOLLO_PAGE_FUNCTION } from "@/lib/booli/page-functions";
import { isBooliUrl } from "@/lib/booli/client";
import { seedResolve } from "@/lib/discovery/area-seed";
import { INNERSTAN_DISTRICTS, type InnerstanDistrict } from "@/lib/discovery/hedonic-model";
import { OBSERVED_USD_PER_TIMED_OUT_RENDER, observedApifyUsdEstimate } from "@/lib/discovery/cost";
import { USD_SEK_RATE } from "@/lib/brf/cost";
import {
  SLUTPRIS_CONCURRENCY,
  SLUTPRIS_MAX_PAGES_PER_SLICE,
  SLUTPRIS_MAX_RETRIES,
  SLUTPRIS_MONTHS,
  SLUTPRIS_SIZE_BANDS,
  SLUTPRIS_UPPER_BAND_MAX_PAGES,
  SLUTPRIS_UPPER_BAND_MIN_M2,
  SLUTPRIS_WAIT_SECS,
  SOLD_DETAIL_PAGE_FUNCTION,
  enrichSoldRows,
  newSlutprisCache,
  pullSlutpriser,
  selectEnrichmentSample,
  slutprisCacheSchema,
  subtractMonthsIso,
  type Slice,
  type SlutprisCache,
} from "@/lib/booli/slutpriser";

/** Name only; the value is never read into a variable that is printed. */
const TOKEN_ENV_NAME = "APIFY_API_TOKEN";
const DATA_DIR = join(process.cwd(), ".planning", "calibration", "data");
const DEFAULT_CACHE = join(DATA_DIR, "slutpriser-cache.json");
/** PROBES SLUTPRIS_ORDER: newest-first (page 30 held strictly descending dates). */
const NEWEST_FIRST = true;
/** Re-read the real bill from the runs API after this many finished renders. */
const SPEND_REFRESH_EVERY = 15;
/** Fixed seed for the enrichment sample, so the same rows are drawn on every run (14.1-08). */
const ENRICH_SEED = "14.1";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const hasFlag = (name: string): boolean => process.argv.includes(name);

/** The local browser's counters for the ledger. */
interface LocalStats {
  pages: number;
  challenged: number;
  retried: number;
  failed: number;
  refused: number;
  apifyFallbacks: number;
}

/** What the renderer choice means for one run (D-03, R-03). */
interface RendererContext {
  /** True when Booli pages are read by the local browser (free). */
  local: boolean;
  allowApify: boolean;
  apifyMaxRenders: number;
}

/**
 * Resolves --renderer / BOOLI_RENDERER and prints the renderer line. Exits 1
 * with a Swedish message when no display is available and nothing was chosen.
 */
async function resolveRenderer(): Promise<RendererContext> {
  const { resolveRendererChoice } = await import("@/lib/booli/local-browser");
  const choice = resolveRendererChoice({ flag: argValue("--renderer"), env: process.env, platform: process.platform });
  if ("error" in choice) {
    console.error(choice.error);
    process.exit(1);
  }
  const local = choice.renderer === "local";
  console.log(local ? "Renderare: lokal webbläsare" : "Renderare: Apify");
  return { local, allowApify: hasFlag("--allow-apify"), apifyMaxRenders: intArg("--apify-max-renders", 10, 1, 100) };
}

/**
 * Installs the local renderer when `ctx.local` and returns a closer that is safe to call from `finally`
 * (it also unregisters the SIGINT/SIGTERM handlers). Nothing may process.exit while the browser is open.
 */
async function installRenderer(ctx: RendererContext): Promise<{
  stats: () => LocalStats | null;
  close: () => Promise<void>;
}> {
  if (!ctx.local) return { stats: () => null, close: async () => undefined };
  const lb = await import("@/lib/booli/local-browser");
  const handle = lb.installLocalRenderer({ allowApify: ctx.allowApify, apifyMaxRenders: ctx.apifyMaxRenders });
  const dispose = lb.closeOnSignals(handle);
  return {
    stats: () => handle.stats(),
    close: async () => {
      dispose();
      await handle.close();
    },
  };
}

/** Whether the Apify checks apply: always in apify mode, and in local mode only for the capped fallback. */
const needsApifyToken = (ctx: RendererContext): boolean => !ctx.local || ctx.allowApify;

/** The local-mode ledger: free pages first, then the settled real Apify bill in the one pinned format. */
async function printLocalLedger(t0: Date, stats: LocalStats, ctx: RendererContext): Promise<void> {
  console.log("\n=== KOSTNAD ===");
  console.log(
    `Lokal webbläsare: ${stats.pages} sidor (${stats.challenged} utmaningar, ${stats.retried} omförsök, ${stats.failed} misslyckade, ${stats.refused} vägrade), 0,00 USD`,
  );
  console.log(`Apify-reserv: ${stats.apifyFallbacks} renderingar (tak ${ctx.apifyMaxRenders})`);
  if (process.env[TOKEN_ENV_NAME]) {
    await waitForLedgerSettle();
    const real = await apifySpendSince(t0);
    console.log(real ? formatApifyRunsLine(real) : formatApifyRunsLine(null, "körnings-API:t svarade inte"));
    if (real) console.log(`Obs: runs-API-siffran gäller hela kontot sedan ${t0.toISOString()} och kan inkludera andra körningar.`);
  } else {
    console.log(formatApifyRunsLine(null, `${TOKEN_ENV_NAME} saknas`));
  }
}

/**
 * The pre-run Apify checks (T-14.1-01: token presence only, never the value; D-17: 2048 MB; R-13: headroom).
 * Apify mode: all three, against `budgetUsd`. Local mode: skipped entirely (R-03) unless --allow-apify, where
 * the token and the headroom for exactly the capped fallback (cap x observed cost per render) are checked.
 * Exits the process, so call it BEFORE the local browser starts.
 */
async function apifyPreflight(ctx: RendererContext, budgetUsd: number): Promise<void> {
  const tokenState = process.env[TOKEN_ENV_NAME] ? "satt" : "saknas";
  console.log(`${TOKEN_ENV_NAME}: ${tokenState}`);
  if (!needsApifyToken(ctx)) {
    console.log("Lokal webbläsare: Apify-kontrollerna (token, minne, månadsutrymme) hoppas över, inga Apify-anrop görs.");
    return;
  }
  if (tokenState === "saknas") process.exit(1);
  if (!ctx.local && RENDER_MEMORY_MB !== 2048) {
    console.error(`FEL: RENDER_MEMORY_MB är ${RENDER_MEMORY_MB}, förväntade 2048 (D-17). Ingen körning startad.`);
    process.exit(1);
  }
  // R-13: the headroom check runs before the first paid render.
  const requiredUsd = ctx.local ? ctx.apifyMaxRenders * OBSERVED_USD_PER_TIMED_OUT_RENDER : budgetUsd;
  const headroom = await apifyMonthlyHeadroomUsd();
  console.log(
    `Apify månadsutrymme: ${headroom === null ? "okänt" : `${headroom.toFixed(2)} USD`}, ${ctx.local ? `reserv (${ctx.apifyMaxRenders} renderingar)` : "budget"} ${requiredUsd.toFixed(2)} USD`,
  );
  if (headroom !== null && headroom < requiredUsd) {
    console.error(`FEL: månadsutrymmet (${headroom.toFixed(2)} USD) är mindre än ${ctx.local ? "Apify-reserven" : "--budget-usd"} (${requiredUsd.toFixed(2)} USD). Ingen körning startad.`);
    process.exit(1);
  }
}

function intArg(name: string, fallback: number, min: number, max: number): number {
  const raw = argValue(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} måste vara ett heltal mellan ${min} och ${max}`);
  return n;
}

function resolveCachePath(): string {
  const raw = argValue("--cache");
  const resolved = resolve(raw ?? DEFAULT_CACHE);
  const rel = relative(DATA_DIR, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`--cache måste ligga under ${relative(process.cwd(), DATA_DIR)}/ (fick ${raw})`);
  }
  if (!resolved.endsWith(".json")) throw new Error("--cache måste vara en .json-fil");
  return resolved;
}

// ---------------------------------------------------------------------------
// Cache I/O (atomic write: tmp + rename)
// ---------------------------------------------------------------------------
function loadCache(path: string): SlutprisCache | null {
  if (!existsSync(path)) return null;
  const parsed = slutprisCacheSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    // Refuse to continue: starting fresh would overwrite a (paid-for) file we cannot read.
    throw new Error(`Cachefilen ${path} klarar inte schemat och lämnas orörd: ${parsed.error.issues[0]?.message ?? "okänt fel"}`);
  }
  return parsed.data;
}

function persistTo(path: string): (cache: SlutprisCache) => void {
  return (cache) => {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache));
    renameSync(tmp, path);
  };
}

// ---------------------------------------------------------------------------
// Slices (R-12). Upper bands first, then the lower bands band by band.
// ---------------------------------------------------------------------------
function buildSlices(): Slice[] {
  const slices: Slice[] = [];
  const upper = SLUTPRIS_SIZE_BANDS.filter((b) => b[0] >= SLUTPRIS_UPPER_BAND_MIN_M2);
  const lower = SLUTPRIS_SIZE_BANDS.filter((b) => b[0] < SLUTPRIS_UPPER_BAND_MIN_M2);
  const make = (district: InnerstanDistrict, band: readonly [number, number], capped: boolean): Slice => {
    const areaId = seedResolve(district);
    if (!areaId) throw new Error(`Inget områdes-id i AREA_SEED för ${district}`);
    return { district, areaId, band, ...(capped ? { maxPages: SLUTPRIS_UPPER_BAND_MAX_PAGES } : {}) };
  };
  for (const band of upper) for (const d of INNERSTAN_DISTRICTS) slices.push(make(d, band, true));
  for (const band of lower) for (const d of INNERSTAN_DISTRICTS) slices.push(make(d, band, false));
  return slices;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const fmt = (n: number): string => n.toLocaleString("sv-SE");
const pct = (part: number, whole: number): string => (whole === 0 ? "-" : `${((100 * part) / whole).toFixed(1)} %`);

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function bandIndex(area: number): number {
  const last = SLUTPRIS_SIZE_BANDS.length - 1;
  for (let i = 0; i < SLUTPRIS_SIZE_BANDS.length; i++) {
    const [lo, hi] = SLUTPRIS_SIZE_BANDS[i];
    if (area >= lo && (area < hi || (i === last && area <= hi))) return i;
  }
  return -1;
}

const STUDY_MEDIAN: Partial<Record<InnerstanDistrict, string>> = {
  Södermalm: "+7 till +10 %",
  Kungsholmen: "+3 till +4 %",
};

function printSummary(cache: SlutprisCache): void {
  const rows = cache.rows;
  console.log("\n=== SAMMANFATTNING ===");
  console.log(`Fönster: sålda ${cache.cutoff} till ${cache.asOf} (asOf). Rader totalt: ${fmt(rows.length)}`);

  console.log("\nRader per stadsdel och storleksband (m²):");
  const bandLabels = SLUTPRIS_SIZE_BANDS.map((b) => `${b[0]}-${b[1]}`);
  console.log(`  ${"Stadsdel".padEnd(12)}${bandLabels.map((l) => l.padStart(8)).join("")}${"Totalt".padStart(9)}`);
  const totals = new Array<number>(SLUTPRIS_SIZE_BANDS.length).fill(0);
  let outside = 0;
  for (const d of INNERSTAN_DISTRICTS) {
    const counts = new Array<number>(SLUTPRIS_SIZE_BANDS.length).fill(0);
    let n = 0;
    for (const r of rows) {
      if (r.district !== d) continue;
      n += 1;
      const b = bandIndex(r.livingArea);
      if (b < 0) outside += 1;
      else counts[b] += 1;
    }
    counts.forEach((c, i) => (totals[i] += c));
    console.log(`  ${d.padEnd(12)}${counts.map((c) => String(c).padStart(8)).join("")}${String(n).padStart(9)}`);
  }
  console.log(`  ${"Summa".padEnd(12)}${totals.map((c) => String(c).padStart(8)).join("")}${String(rows.length).padStart(9)}`);
  if (outside > 0) console.log(`  (${outside} rader utanför 35-120 m², t.ex. avrundning i Booli-filtret)`);
  const m60to80 = rows.filter((r) => r.livingArea >= 60 && r.livingArea < 80).length;
  const m80up = rows.filter((r) => r.livingArea >= 80).length;
  console.log(`  Tröskelkontroll: 60-80 m²: ${m60to80} (krav 60), ≥80 m²: ${m80up} (krav 30)`);

  if (rows.length > 0) {
    const areas = rows.map((r) => r.livingArea);
    console.log(`\nBoyta i cachen: ${Math.min(...areas)} till ${Math.max(...areas)} m²`);
  }

  console.log("\nMånader som täcks (äldsta till nyaste såld, per stadsdel):");
  for (const d of INNERSTAN_DISTRICTS) {
    const all = rows.filter((r) => r.district === d).map((r) => r.soldDate).sort();
    // By the slice a row was pulled from (not by its living area: a flat of exactly 60 m2 sits in the 50-60 slice).
    const up = rows
      .filter((r) => r.district === d && Number(r.sliceKey.split("|")[1]?.split("-")[0]) >= SLUTPRIS_UPPER_BAND_MIN_M2)
      .map((r) => r.soldDate)
      .sort();
    const span = (xs: string[]): string => (xs.length ? `${xs[0]} till ${xs[xs.length - 1]}` : "-");
    console.log(`  ${d.padEnd(12)} alla band: ${span(all)}   |   övre band ${SLUTPRIS_UPPER_BAND_MIN_M2}-120 m² (${up.length} rader): ${span(up)}`);
  }

  const pages = Object.entries(cache.pages);
  const ok = pages.filter(([, p]) => p.status === "ok");
  const failed = pages.filter(([, p]) => p.status === "failed");
  const attempts = pages.reduce((s, [, p]) => s + p.attempts, 0);
  console.log(`\nSidor: ${pages.length} (ok ${ok.length}, misslyckade ${failed.length}), renderförsök i cachen ${attempts}`);
  for (const [k, p] of failed.slice(0, 12)) console.log(`  misslyckad: ${k} (${p.attempts} försök)`);
  if (failed.length > 12) console.log(`  ... och ${failed.length - 12} till`);

  console.log(
    `\nRäknare: saknar säljdatum ${cache.counts.missingSoldDate}, saknar koordinater ${cache.counts.missingCoords}, ` +
      `saknar pris/yta ${cache.counts.missingPriceOrArea}, dubbletter ${cache.counts.duplicates}, ` +
      `teckenavvikelse etikett/sidfunktion ${cache.counts.signDisagreements}`,
  );

  const withPct = rows.filter((r) => r.soldVsAskPct !== null);
  const neg = withPct.filter((r) => (r.soldVsAskPct as number) < 0).length;
  const zero = withPct.filter((r) => r.soldVsAskPct === 0).length;
  const pos = withPct.filter((r) => (r.soldVsAskPct as number) > 0).length;
  console.log(`\nSäljpris mot utgångspris: etikett saknas (null) ${rows.length - withPct.length} (${pct(rows.length - withPct.length, rows.length)})`);
  console.log(`  Teckenfördelning av ${withPct.length} rader med etikett: under utgångspris ${neg}, lika ${zero}, över ${pos}`);

  console.log("\nMedian säljpris mot utgångspris per stadsdel, omräknad nu (null-etiketter utanför), mot studiens siffror (CONTEXT D-03):");
  for (const d of INNERSTAN_DISTRICTS) {
    const xs = rows.filter((r) => r.district === d && r.soldVsAskPct !== null).map((r) => r.soldVsAskPct as number);
    const m = median(xs);
    const study = STUDY_MEDIAN[d] ?? "(ingen studiesiffra)";
    console.log(`  ${d.padEnd(12)} nu ${m === null ? "-" : `${m >= 0 ? "+" : ""}${m.toFixed(2)} %`} (n=${xs.length})   studien: ${study}`);
  }
  console.log("  Obs: studiens siffror kan bära teckenfelet (R-04a, A12: ett minustecken lästes som plus), så de är troligen för höga.");

  console.log("\nkr/m² per stadsdel (median, min, max):");
  for (const d of INNERSTAN_DISTRICTS) {
    const xs = rows.filter((r) => r.district === d).map((r) => r.krPerSqm);
    const m = median(xs);
    if (m === null) {
      console.log(`  ${d.padEnd(12)} -`);
      continue;
    }
    console.log(`  ${d.padEnd(12)} ${fmt(Math.round(m))}  ${fmt(Math.round(Math.min(...xs)))}  ${fmt(Math.round(Math.max(...xs)))}`);
  }

  const n = rows.length;
  const withFloor = rows.filter((r) => r.floor !== null).length;
  const withAsking = rows.filter((r) => r.askingPrice !== null).length;
  const withRooms = rows.filter((r) => r.rooms !== null).length;
  const withBuild = rows.filter((r) => r.enriched?.buildYear != null).length;
  const withBalcony = rows.filter((r) => r.enriched?.balcony != null).length;
  console.log("\nFältens täckning:");
  console.log(`  våning ${pct(withFloor, n)}, utgångspris ${pct(withAsking, n)}, rum ${pct(withRooms, n)}`);
  console.log(`  balkong ${pct(withBalcony, n)}, byggår ${pct(withBuild, n)} (kommer från detaljsidor i 14.1-08, inte från kortet)`);
}

// ---------------------------------------------------------------------------
// Sold-detail enrichment (14.1-08, R-05 Path A)
// ---------------------------------------------------------------------------
async function runEnrichment(opts: {
  cachePath: string;
  cache: SlutprisCache | null;
  sampleSize: number;
  soldSince?: string;
  maxRenders: number;
  budgetUsd: number;
  concurrency: number;
  dryRun: boolean;
  renderer: RendererContext;
}): Promise<void> {
  const { cache, cachePath } = opts;
  if (!cache) throw new Error(`Ingen cache att berika på ${cachePath} (kör själva hämtningen först)`);
  const sample = selectEnrichmentSample(cache.rows, opts.sampleSize, ENRICH_SEED, opts.soldSince ? { soldSince: opts.soldSince } : {});
  const already = cache.rows.filter((r) => r.enriched).length;
  console.log(
    `Berikning: ${sample.length} av ${cache.rows.length} rader väljs (frö "${ENRICH_SEED}"${opts.soldSince ? `, sålda från ${opts.soldSince}` : ""}, ${already} redan berikade), ` +
      `render-tak ${opts.maxRenders}, budget ${opts.budgetUsd.toFixed(2)} USD, samtidighet ${opts.concurrency}`,
  );
  if (opts.dryRun) {
    console.log(`--dry-run: inga renders körda. Uppskattad kostnad ${(Math.min(sample.length, opts.maxRenders) * 0.036).toFixed(2)} till ${(Math.min(sample.length, opts.maxRenders) * 0.059).toFixed(2)} USD (observerade kostnader per render).`);
    return;
  }
  if (sample.length === 0) {
    console.log("Inget att berika.");
    return;
  }

  await apifyPreflight(opts.renderer, opts.budgetUsd);

  const persist = persistTo(cachePath);
  const t0 = new Date();
  console.log(`Start: ${t0.toISOString()}`);
  let succeeded = 0;
  let failedRenders = 0;
  let lastRealUsd = 0;
  let refreshing = false;
  // Local pages cost nothing; the capped Apify fallback is bounded by the renderer's own cap, not by this guard.
  const spentUsd = (): number => (opts.renderer.local ? 0 : Math.max(lastRealUsd, observedApifyUsdEstimate({ succeeded, timedOut: failedRenders })));
  const refreshReal = (): void => {
    if (refreshing) return;
    refreshing = true;
    void apifySpendSince(t0)
      .then((s) => {
        if (s) lastRealUsd = s.usd;
      })
      .finally(() => {
        refreshing = false;
      });
  };
  const render = async (url: string): Promise<unknown[]> => {
    if (!isBooliUrl(url)) throw new Error(`Inte en Booli-url: ${url}`);
    try {
      const items = await runPlaywrightRender(url, SOLD_DETAIL_PAGE_FUNCTION, {
        waitSecs: SLUTPRIS_WAIT_SECS,
        maxRequestRetries: SLUTPRIS_MAX_RETRIES,
      });
      succeeded += 1;
      return items;
    } catch (e) {
      failedRenders += 1;
      throw e;
    } finally {
      if (!opts.renderer.local && (succeeded + failedRenders) % SPEND_REFRESH_EVERY === 0) refreshReal();
    }
  };

  let done = 0;
  const browser = await installRenderer(opts.renderer);
  let result: Awaited<ReturnType<typeof enrichSoldRows>>;
  try {
    result = await enrichSoldRows({
      rows: cache.rows,
      sample,
      render,
      concurrency: opts.concurrency,
      maxRenders: opts.maxRenders,
      persist: () => {
        persist(cache);
        done += 1;
        if (done % 10 === 0) console.log(`  ${done} berikade (render ${succeeded + failedRenders}, uppskattat ${spentUsd().toFixed(2)} USD)`);
      },
      budgetExceeded: () => spentUsd() >= opts.budgetUsd,
      onProgress: (msg) => console.log(`  ${msg}`),
    });
  } finally {
    await browser.close();
  }
  persist(cache);

  console.log(`\nBerikning klar. Renders: ${result.rendersUsed} (lyckade ${succeeded}, misslyckade ${failedRenders}). Berikade rader: ${result.enriched}, misslyckade: ${result.failed}.`);
  const enrichedRows = cache.rows.filter((r) => r.enriched);
  const withYear = enrichedRows.filter((r) => r.enriched?.buildYear != null).length;
  const withBalcony = enrichedRows.filter((r) => r.enriched?.balcony === true).length;
  const withoutBalcony = enrichedRows.filter((r) => r.enriched?.balcony === false).length;
  const withList = enrichedRows.filter((r) => r.enriched?.listPrice != null).length;
  console.log(
    `Rader med berikning i cachen: ${enrichedRows.length}. Byggår ${withYear} (${pct(withYear, enrichedRows.length)}), ` +
      `balkong angiven ${withBalcony}, ingen balkong angiven ${withoutBalcony}, utgångspris ${withList} (${pct(withList, enrichedRows.length)}).`,
  );

  const localStats = browser.stats();
  if (localStats) {
    await printLocalLedger(t0, localStats, opts.renderer);
  } else {
    console.log("\n=== KOSTNAD ===");
    await waitForLedgerSettle();
    const spend = await apifySpendSince(t0);
    if (spend) {
      console.log(
        `Apify-kostnad: ${spend.usd.toFixed(4)} USD (runs-api) = ${(spend.usd * USD_SEK_RATE).toFixed(2)} SEK` +
          ` | körningar ${spend.runs} (ok ${spend.succeeded}, timeout ${spend.timedOut}, fel ${spend.failed}, övrigt ${spend.other}, saknar kostnad ${spend.missingUsage})` +
          ` | per render ${spend.runs > 0 ? (spend.usd / spend.runs).toFixed(4) : "-"} USD`,
      );
      console.log("Obs: huvudboken är kontoomfattande - en samtidig körning från annat verktyg i samma fönster räknas också.");
    } else {
      const est = observedApifyUsdEstimate({ succeeded, timedOut: failedRenders });
      console.log(`Apify-kostnad: ${est.toFixed(4)} USD (estimate) - uppskattning (runs-API:t svarade inte), ${(est * USD_SEK_RATE).toFixed(2)} SEK`);
    }
    const after = await apifyMonthlyHeadroomUsd();
    console.log(`Apify månadsutrymme kvar: ${after === null ? "okänt" : `${after.toFixed(2)} USD`}`);
  }
  if (result.failed > 0 || result.rendersUsed < sample.length) {
    console.log("Kör samma kommando igen för att fortsätta (redan berikade rader renderas inte om).");
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const months = intArg("--months", SLUTPRIS_MONTHS, 1, 36);
  const requestedConcurrency = intArg("--concurrency", SLUTPRIS_CONCURRENCY, 1, 1000);
  const concurrency = Math.min(requestedConcurrency, SLUTPRIS_CONCURRENCY);
  const maxRenders = intArg("--max-renders", 400, 1, 5000);
  const budgetRaw = argValue("--budget-usd");
  const budgetUsd = budgetRaw === null ? 25 : Number(budgetRaw);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error("--budget-usd måste vara ett positivt tal");
  const cachePath = resolveCachePath();

  if (requestedConcurrency > SLUTPRIS_CONCURRENCY) {
    console.log(`Samtidighet begränsad till ${SLUTPRIS_CONCURRENCY} (begärde ${requestedConcurrency}).`);
  }

  const existing = loadCache(cachePath);

  // D-03: the renderer line comes before any dry-run return. --report-only reads the cache only and needs none.
  const rctx: RendererContext = hasFlag("--report-only")
    ? { local: false, allowApify: false, apifyMaxRenders: 10 }
    : await resolveRenderer();

  const enrichSample = intArg("--enrich-sample", 0, 0, 300);
  if (enrichSample > 0) {
    const since = argValue("--enrich-since");
    if (since !== null && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error("--enrich-since måste vara YYYY-MM-DD");
    await runEnrichment({
      cachePath,
      cache: existing,
      sampleSize: enrichSample,
      ...(since !== null ? { soldSince: since } : {}),
      maxRenders: Math.min(maxRenders, enrichSample),
      budgetUsd,
      concurrency,
      dryRun: hasFlag("--dry-run"),
      renderer: rctx,
    });
    return;
  }

  if (hasFlag("--report-only")) {
    if (!existing) throw new Error(`Ingen cache att sammanfatta på ${cachePath}`);
    printSummary(existing);
    return;
  }

  const slices = buildSlices();
  const upperCount = slices.filter((s) => s.maxPages !== undefined).length;
  const maxPlanned = slices.reduce((sum, s) => sum + Math.min(SLUTPRIS_MAX_PAGES_PER_SLICE, s.maxPages ?? SLUTPRIS_MAX_PAGES_PER_SLICE), 0);
  console.log(
    `Plan: ${slices.length} delmängder (${INNERSTAN_DISTRICTS.length} stadsdelar x ${SLUTPRIS_SIZE_BANDS.length} band; ` +
      `${upperCount} övre band med max ${SLUTPRIS_UPPER_BAND_MAX_PAGES} sidor), högst ${SLUTPRIS_MAX_PAGES_PER_SLICE} sidor per delmängd, ` +
      `övre gräns ${maxPlanned} sidor, render-tak ${maxRenders}, budget ${budgetUsd.toFixed(2)} USD, samtidighet ${concurrency}`,
  );
  console.log(
    rctx.local
      ? `Render: lokal webbläsare, 2 sidor åt gången, Apify-reserv ${rctx.allowApify ? `högst ${rctx.apifyMaxRenders} renderingar` : "av"}`
      : `Render: ${SLUTPRIS_WAIT_SECS} s väntan, ${SLUTPRIS_MAX_RETRIES} Apify-omförsök, ${RENDER_MEMORY_MB} MB`,
  );

  const asOf = new Date().toISOString().slice(0, 10);
  let cache: SlutprisCache;
  if (existing) {
    cache = existing;
    const wanted = subtractMonthsIso(asOf, months);
    console.log(
      `Återupptar cache (${existing.rows.length} rader, ${Object.keys(existing.pages).length} sidor). ` +
        (existing.cutoff === wanted
          ? `Gräns ${existing.cutoff}.`
          : `Cachens gräns ${existing.cutoff} behålls (dagens ${months} månader hade gett ${wanted}).`),
    );
  } else {
    cache = newSlutprisCache(asOf, subtractMonthsIso(asOf, months));
    console.log(`Ny cache. Sålda från ${cache.cutoff} (${months} månader före ${asOf}).`);
  }

  if (hasFlag("--dry-run")) {
    for (const s of slices) {
      console.log(`  ${s.district} ${s.band[0]}-${s.band[1]} m², områdes-id ${s.areaId}, max ${Math.min(SLUTPRIS_MAX_PAGES_PER_SLICE, s.maxPages ?? SLUTPRIS_MAX_PAGES_PER_SLICE)} sidor`);
    }
    console.log("--dry-run: inga renders körda.");
    return;
  }

  // Preflight (T-14.1-01: presence only, never the value; D-17: respect the 2048 MB fix). Skipped in local mode (R-03).
  await apifyPreflight(rctx, budgetUsd);

  mkdirSync(dirname(cachePath), { recursive: true });
  const persist = persistTo(cachePath);

  // Budget guard: the larger of the runs-API bill (refreshed in the background)
  // and the labelled per-render estimate. In-flight renders (at most 8) still
  // finish after it trips, so spend can overshoot by roughly 8 renders.
  const t0 = new Date();
  console.log(`Start: ${t0.toISOString()}`);
  let succeeded = 0;
  let failedRenders = 0;
  let lastRealUsd = 0;
  let refreshing = false;
  // Local pages cost nothing; the capped Apify fallback is bounded by the renderer's own cap, not by this guard.
  const spentUsd = (): number => (rctx.local ? 0 : Math.max(lastRealUsd, observedApifyUsdEstimate({ succeeded, timedOut: failedRenders })));
  const refreshReal = (): void => {
    if (refreshing) return;
    refreshing = true;
    void apifySpendSince(t0)
      .then((s) => {
        if (s) lastRealUsd = s.usd;
      })
      .finally(() => {
        refreshing = false;
      });
  };

  const render = async (url: string): Promise<unknown[]> => {
    try {
      const items = await runPlaywrightRender(url, APOLLO_PAGE_FUNCTION, {
        waitSecs: SLUTPRIS_WAIT_SECS,
        maxRequestRetries: SLUTPRIS_MAX_RETRIES,
      });
      succeeded += 1;
      return items;
    } catch (e) {
      failedRenders += 1;
      throw e;
    } finally {
      if (!rctx.local && (succeeded + failedRenders) % SPEND_REFRESH_EVERY === 0) refreshReal();
    }
  };

  const browser = await installRenderer(rctx);
  let result: Awaited<ReturnType<typeof pullSlutpriser>>;
  try {
    result = await pullSlutpriser({
      slices,
      render,
      cache,
      cutoffIso: cache.cutoff,
      concurrency,
      maxPagesPerSlice: SLUTPRIS_MAX_PAGES_PER_SLICE,
      maxRenders,
      newestFirst: NEWEST_FIRST,
      persist,
      onProgress: (msg) => console.log(`  ${msg}`),
      budgetExceeded: () => spentUsd() >= budgetUsd,
    });
  } finally {
    await browser.close();
  }
  persist(result.cache);

  const stopText =
    result.stoppedBy === "done"
      ? "klar (alla delmängder gick till sitt slut eller sin sidgräns)"
      : result.stoppedBy === "max-renders"
        ? `stoppad av --max-renders (${maxRenders})`
        : `stoppad av --budget-usd (${budgetUsd.toFixed(2)})`;
  console.log(`\nKörningen är ${stopText}. Renders i den här körningen: ${result.rendersUsed} (lyckade ${succeeded}, misslyckade ${failedRenders}).`);
  console.log(`Cache: ${relative(process.cwd(), cachePath)}`);

  printSummary(result.cache);

  // Spend ledger: the real bill from the runs API; labelled estimate only if that fails.
  const localStats = browser.stats();
  if (localStats) {
    await printLocalLedger(t0, localStats, rctx);
  } else {
    console.log("\n=== KOSTNAD ===");
    await waitForLedgerSettle();
    const spend = await apifySpendSince(t0);
    if (spend) {
      console.log(
        `Apify-kostnad: ${spend.usd.toFixed(4)} USD (runs-api) = ${(spend.usd * USD_SEK_RATE).toFixed(2)} SEK` +
          ` | körningar ${spend.runs} (ok ${spend.succeeded}, timeout ${spend.timedOut}, fel ${spend.failed}, övrigt ${spend.other}, saknar kostnad ${spend.missingUsage})`,
      );
      console.log("Obs: huvudboken är kontoomfattande - en samtidig körning från annat verktyg i samma fönster räknas också.");
    } else {
      const est = observedApifyUsdEstimate({ succeeded, timedOut: failedRenders });
      console.log(`Apify-kostnad: ${est.toFixed(4)} USD (estimate) - uppskattning (runs-API:t svarade inte), ${(est * USD_SEK_RATE).toFixed(2)} SEK`);
    }
    const after = await apifyMonthlyHeadroomUsd();
    console.log(`Apify månadsutrymme kvar: ${after === null ? "okänt" : `${after.toFixed(2)} USD`}`);
  }

  if (result.stoppedBy !== "done" || Object.values(result.cache.pages).some((p) => p.status === "failed")) {
    console.log("Kör samma kommando igen för att återuppta (färdiga sidor renderas inte om, misslyckade försöks på nytt).");
  }
}

main().catch((e) => {
  console.error("FEL:", e?.message ?? e);
  process.exit(1);
});
