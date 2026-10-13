/**
 * Headless flip-profit ranking using the app's own pipeline modules.
 *
 * Two modes on one table renderer:
 *
 *   Replay (offline, free): reads a stored for-sale snapshot and the fitted
 *   model, scores every row and prints the ranked table.
 *     npx tsx scripts/fit-score.ts --replay <snapshot.json> [--model data/hedonic-model.json] [--track 150148]
 *
 *   Live: scrapes the four innerstan districts, ranks every comparable flat
 *   for free, detail-fetches (and, unless --no-vision, picture-reads) the
 *   window, re-ranks by profit, writes a snapshot under .planning/calibration/data/
 *   and prints the spend.
 *     npx tsx scripts/fit-score.ts [--window all|N] [--district <name>] [--no-vision]
 *         [--budget-usd N] [--out <file>] [--dry-run]
 *         [--renderer local|apify] [--allow-apify] [--apify-max-renders N]
 *
 *   Window (Phase 14.2, D-06): in local mode the default is "all": every
 *   comparable flat gets its Booli detail page and, where the detail names one,
 *   its broker page (src/lib/discovery/watch-enrich.ts), and a facts record for
 *   every row. That is free. With --renderer apify the window stays a number
 *   (default FIT_VISION_WINDOW) and "--window all" is refused with exit 1,
 *   because every page there is a paid render (denial of wallet).
 *
 *   Completeness (R-04): each district is paged until Booli's own count is in
 *   hand (HEADLESS_MAX_AREA_PAGES) and the area report prints "N av M annonser
 *   (P sidor, komplett|ofullständig)", then "Kandidatlista: komplett" or
 *   "Kandidatlista: OFULLSTÄNDIG (<districts>)". Coverage (R-05): a
 *   "Täckning (N annonser): ..." line says how much of balcony, condition,
 *   description, sun, avgift and tenure is actually known.
 *
 *   --no-vision prints "Bildtolkning: avstängd (--no-vision)" and makes no
 *   Anthropic call. Picture reading for every candidate arrives in a later plan.
 *
 *   Renderer (Phase 14.2, D-03, R-03): Booli pages are read by a headed
 *   Chromium on this Mac by default (BOOLI_RENDERER or --renderer override;
 *   see src/lib/booli/local-browser.ts). That is free: no Apify token is
 *   needed and the Apify monthly-headroom check is skipped. A page the local
 *   browser cannot get after one retry goes to Apify only with --allow-apify,
 *   capped at --apify-max-renders (default 10), and then the token and the
 *   headroom (cap x observed cost per render) are checked first. With
 *   --renderer apify the 14.1 behaviour is unchanged: the run first compares the
 *   Apify monthly headroom with its worst-case cost and exits with code 2 when
 *   the headroom is smaller (R-13). `--dry-run` stops right after the checks,
 *   before the first page is read.
 *
 * The printed table is two sections (Phase 14.2, D-12): "Förväntat under 4 M"
 * (expected final price 4 000 000 kr or less) first, then "Över 4 M förväntat";
 * ordering inside each is the profit order and '#' stays the innerstan rank.
 * Every row shows the uncapped gap ("Okapad skillnad", D-11) beside the credited
 * amount ("Krediterad", capped at 20 % of the value).
 *
 * The orchestration (order of paid calls, filters, table) lives in
 * src/lib/discovery/fit-pipeline.ts so the Phase 14.2 email can reuse it.
 *
 * Only pure discovery modules are imported STATICALLY here on purpose: the
 * replay must stay offline (FIT-06). Everything that can spend money (the
 * Apify transport, listing client, enrichment and vision modules) is loaded by
 * dynamic import() inside the live branch.
 *
 * Secret posture: environment variables are reported as satt/saknas only.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { USD_SEK_RATE } from "@/lib/brf/cost";
import { seedResolve } from "@/lib/discovery/area-seed";
import { toCandidate } from "@/lib/discovery/candidate";
import { OBSERVED_USD_PER_TIMED_OUT_RENDER, observedApifyUsdEstimate } from "@/lib/discovery/cost";
import {
  FIT_SECTION_TITLES,
  FIT_SIZE_MIN,
  FIT_TABLE_MAX_ROWS,
  checkApifyHeadroom,
  coverageOfRows,
  estimateFitRunUsd,
  fitRowKey,
  renderAreaReport,
  renderCoverage,
  renderFitSections,
  renderWindowReport,
  runFitPipeline,
  splitFitSections,
  toFitTableRows,
  FIT_FLAG_LABELS,
  type AreaReport,
  type FitPipelineDeps,
  type FitPipelineResult,
  type ScrapedRow,
} from "@/lib/discovery/fit-pipeline";
import {
  FIT_VISION_WINDOW,
  MAX_CREDIT_PCT,
  clearlyWorseAbove,
  parseFitSnapshot,
  preRank,
  rankFit,
  type FitInputRow,
  type FitScoreResult,
  type FitSnapshot,
  type ModelHealth,
} from "@/lib/discovery/fit-score";
import { INNERSTAN_DISTRICTS, parseHedonicModel, type InnerstanDistrict } from "@/lib/discovery/hedonic-model";
import { factsFromCard } from "@/lib/discovery/listing-facts";
import { RENO_BAND } from "@/lib/discovery/reno-tier";

const DEFAULT_MODEL_PATH = "data/hedonic-model.json";
const DEFAULT_TRACK_ID = 150148;
const DATA_DIR = ".planning/calibration/data";
const AREA_QUERY = "innerstan (innanför tullarna)";
const APIFY_ENV = "APIFY_API_TOKEN";
const ANTHROPIC_ENV = "ANTHROPIC_API_KEY";
const EXPECTED_RENDER_MEMORY_MB = 2048;
const MAX_WINDOW = 100;
const DEFAULT_APIFY_MAX_RENDERS = 10;
const MAX_APIFY_MAX_RENDERS = 100;

const USAGE = `Användning:
  Uppspelning (gratis, offline):
    npx tsx scripts/fit-score.ts --replay <snapshot.json> [--model ${DEFAULT_MODEL_PATH}] [--track ${DEFAULT_TRACK_ID}]
  Live-körning (lokal webbläsare är gratis för Booli; Apify och bildtolkning kostar):
    npx tsx scripts/fit-score.ts [--window all|<n>] [--district <område>] [--no-vision] [--budget-usd <n>] [--out <fil>] [--dry-run] [--renderer local|apify] [--allow-apify] [--apify-max-renders <n>] [--model ${DEFAULT_MODEL_PATH}] [--track ${DEFAULT_TRACK_ID}]

  Tabellen har två avsnitt: "Förväntat under 4 M" (förväntat slutpris högst 4 000 000 kr) och "Över 4 M förväntat".
  "Okapad skillnad" är värde minus slutpris före 20 %-taket; "Krediterad" är den del som räknas in i vinsten.
  Områdesraden säger "N av M annonser (P sidor, komplett|ofullständig)" och "Kandidatlista: komplett|OFULLSTÄNDIG (...)";
  raden "Täckning (...)" säger hur mycket som faktiskt är känt (balkong, skick, beskrivning, sol, avgift, upplåtelseform).

  --replay <fil>     Spela upp en sparad snapshot av bostäder till salu (inga nätverksanrop)
  --model <fil>      Hedonisk modell (JSON), standard ${DEFAULT_MODEL_PATH}
  --track <id>       Booli-id att visa uppdelat i detalj, standard ${DEFAULT_TRACK_ID}
  --window all|<n>   Live: antal annonser som får detaljsida (och bildtolkning). Standard: all (alla jämförbara) med lokal webbläsare,
                     ${FIT_VISION_WINDOW} med Apify. "all" kräver --renderer local; <n> är 0-${MAX_WINDOW}
  --district <namn>  Live: läs bara ett område (${INNERSTAN_DISTRICTS.join(", ")})
  --no-vision        Live: ingen bildtolkning och inget Anthropic-anrop (detaljsidor och mäklartext läses ändå)
  --budget-usd <n>   Live: kan bara höja det Apify-utrymme som krävs, aldrig sänka det under värsta-fall-uppskattningen
  --out <fil>        Live: snapshot att skriva, standard ${DATA_DIR}/forsale-snapshot-<datum>.json (måste ligga under ${DATA_DIR}/)
  --dry-run          Live: gör förkontrollerna (med Apify även utrymmeskontrollen), avsluta sedan innan första sidan hämtas
  --renderer <r>     Live: local (standard när en skärm finns; gratis) eller apify (betald). Alternativ: miljövariabeln BOOLI_RENDERER
  --allow-apify      Live, lokal webbläsare: låt en sida som blockerats två gånger gå till Apify (betald, kräver token och utrymme)
  --apify-max-renders <n>  Live: tak för Apify-renderingar med --allow-apify, standard ${DEFAULT_APIFY_MAX_RENDERS} (1-${MAX_APIFY_MAX_RENDERS})
  --help             Visa den här texten

Slutkoder: 0 klart (även med noll kandidater), 1 fel (argument, fil, nyckel saknas, alla distrikt misslyckades, ingen skärm),
2 Apify-utrymmet för månaden är mindre än körningens uppskattade kostnad (inget betalt anrop gjordes).`;

const WINDOW_ALL_NEEDS_LOCAL = "--window all kräver --renderer local (med Apify är varje sida en betald rendering)";

const sek = (n: number) => Math.round(n).toLocaleString("sv-SE");
const pct = (n: number) => `${(n * 100).toFixed(1)} %`;
const orDash = (n: number | null, f: (x: number) => string) => (n === null ? "-" : f(n));

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
  replay: string | null;
  model: string;
  track: number;
  /** null = the default for the renderer in use (all with the local browser, FIT_VISION_WINDOW with Apify). */
  window: number | "all" | null;
  district: string | null;
  noVision: boolean;
  budgetUsd: number | null;
  out: string | null;
  dryRun: boolean;
  renderer: string | null;
  allowApify: boolean;
  apifyMaxRenders: number;
  help: boolean;
}

function parseArgs(argv: string[]): Args | null {
  const out: Args = {
    replay: null,
    model: DEFAULT_MODEL_PATH,
    track: DEFAULT_TRACK_ID,
    window: null,
    district: null,
    noVision: false,
    budgetUsd: null,
    out: null,
    dryRun: false,
    renderer: null,
    allowApify: false,
    apifyMaxRenders: DEFAULT_APIFY_MAX_RENDERS,
    help: false,
  };
  let liveOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--help" || flag === "-h") out.help = true;
    else if (flag === "--dry-run") { out.dryRun = true; liveOnly = true; }
    else if (flag === "--replay" && value !== undefined) { out.replay = value; i++; }
    else if (flag === "--model" && value !== undefined) { out.model = value; i++; }
    else if (flag === "--track" && value !== undefined && Number.isInteger(Number(value))) { out.track = Number(value); i++; }
    else if (flag === "--window" && value === "all") { out.window = "all"; liveOnly = true; i++; }
    else if (flag === "--window" && value !== undefined && Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= MAX_WINDOW) {
      out.window = Number(value); liveOnly = true; i++;
    } else if (flag === "--district" && value !== undefined) { out.district = value; liveOnly = true; i++; }
    else if (flag === "--no-vision") { out.noVision = true; liveOnly = true; }
    else if (flag === "--budget-usd" && value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0) {
      out.budgetUsd = Number(value); liveOnly = true; i++;
    } else if (flag === "--out" && value !== undefined) { out.out = value; liveOnly = true; i++; }
    else if (flag === "--renderer" && value !== undefined) { out.renderer = value; liveOnly = true; i++; }
    else if (flag === "--allow-apify") { out.allowApify = true; liveOnly = true; }
    else if (
      flag === "--apify-max-renders" &&
      value !== undefined &&
      Number.isInteger(Number(value)) &&
      Number(value) >= 1 &&
      Number(value) <= MAX_APIFY_MAX_RENDERS
    ) { out.apifyMaxRenders = Number(value); liveOnly = true; i++; }
    else return null;
  }
  if (out.replay !== null && liveOnly) return null;
  return out;
}

/** The absolute --out path when it lies inside the gitignored data directory, else null (T-14.1-12). */
function guardedOutPath(path: string): string | null {
  const dir = resolve(DATA_DIR);
  const abs = resolve(path);
  return abs.startsWith(dir + sep) && abs.endsWith(".json") ? abs : null;
}

/** Atomic write: a temp file in the same directory, then rename. */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Printing (shared by replay and live)
// ---------------------------------------------------------------------------

function renoText(r: FitScoreResult): string {
  return `${r.renoTier} ${sek(r.renoSek)} (${sek(r.renoLowSek)}–${sek(r.renoHighSek)})`;
}

function printHealth(health: ModelHealth): void {
  if (health.medianFinalToPred === null) {
    console.log("\nModellhälsa: inga jämförbara rader att mäta på");
    return;
  }
  const [lo, hi] = health.band;
  console.log(
    `\nModellhälsa: median förv. slutpris / modellpris ${health.medianFinalToPred.toFixed(3)} (band ${lo}–${hi}, ${health.n} rader)`,
  );
  if (health.outOfBand) {
    console.log(
      "VARNING: medianen ligger utanför bandet. Modellens prisnivå stämmer inte med dagens utgångspriser. Ingen automatisk justering görs (R-02); en människa avgör.",
    );
  }
}

function printTracked(
  trackId: number,
  ranking: { ranked: FitScoreResult[]; notComparable: FitScoreResult[] },
  rows: readonly FitInputRow[],
  preRankPositions: ReadonlyMap<string, number>,
): void {
  const { ranked, notComparable } = ranking;
  const index = ranked.findIndex((r) => r.booliId === trackId);
  if (index < 0) {
    const notComp = notComparable.find((r) => r.booliId === trackId);
    console.log(
      notComp
        ? `\nBevakad annons ${trackId} (${notComp.address ?? "-"}) är ej jämförbar: ${notComp.notComparableReason}`
        : `\nBevakad annons ${trackId} finns inte i körningen`,
    );
    return;
  }
  const r = ranked[index];
  const sameDistrict = ranked.filter((x) => x.district === r.district);
  const districtRank = sameDistrict.indexOf(r) + 1;
  const topQuarterLimit = Math.ceil(sameDistrict.length / 4);
  const row = rows.find((x) => x.candidate.sourceListingUrl !== null && x.candidate.sourceListingUrl === r.sourceListingUrl);
  const pre = preRankPositions.get(r.sourceListingUrl ?? `${r.address}|${r.askingSek}`);

  console.log(`\nBevakad annons: uppdelning för Booli ${r.booliId} (${r.address ?? "-"}, ${r.district})`);
  console.log(`  Placering innerstan: ${index + 1} av ${ranked.length}`);
  console.log(
    `  Placering ${r.district}: ${districtRank} av ${sameDistrict.length}, översta kvartilen: ${districtRank <= topQuarterLimit ? "ja" : "nej"} (gräns: plats ${topQuarterLimit} eller bättre)`,
  );
  console.log(`  Förrank: ${pre ?? "-"}, i bildfönstret: ${row ? (row.inVisionWindow ? "ja" : "nej") : "okänt"}`);
  console.log(`  Utgångspris:        ${orDash(r.askingSek, sek)} kr (${orDash(r.livingArea, String)} kvm)`);
  console.log(`  Modellpris:         ${orDash(r.predKrPerSqm, sek)} kr/kvm, utgångspris/modell ${orDash(r.askToPred, pct)}`);
  console.log(`  Förv. överbud:      ${orDash(r.overbidPct, pct)}`);
  console.log(`  Förv. slutpris:     ${orDash(r.purchaseSek, sek)} kr`);
  // Same split function and same rounding as the table, so the line always matches the section the row was printed in.
  const inUnder = splitFitSections(toFitTableRows({ ranked: [r] }, new Map())).under.length === 1;
  console.log(`  Sektion:            ${inUnder ? FIT_SECTION_TITLES.under : FIT_SECTION_TITLES.over}`);
  console.log(`  Värde renoverad:    ${orDash(r.resaleSek, sek)} kr`);
  console.log(`  Okapad skillnad (värde - slutpris): ${orDash(r.gapSek, sek)} kr`);
  console.log(`  Kredit (max ${pct(MAX_CREDIT_PCT)} av värdet): ${orDash(r.creditSek, sek)} kr`);
  console.log(`  Reno:               ${renoText(r)}; kök ${r.renoStates.kitchen}, badrum ${r.renoStates.bathroom}, helhet ${r.renoStates.overall}`);
  console.log(`  Försäljningskostnad: ${sek(r.salesCostsSek)} kr`);
  console.log(`  Innehavskostnad:    ${sek(r.holdingCostsSek)} kr`);
  console.log(`  Skatt:              ${sek(r.taxSek)} kr`);
  console.log(`  Smak:               ${sek(r.tasteSek)} kr (sol ${pct(r.tasteSunPct)}, nav ${pct(r.tasteHubPct)}, närmaste nav ${r.nearestHub ?? "-"})`);
  console.log(`  Vinst:              ${orDash(r.profitSek, sek)} kr`);
  console.log(`  Flaggor:            ${r.flags.map((f) => FIT_FLAG_LABELS[f]).join(", ") || "-"}`);
  console.log(`  Imputerat:          ${r.featuresImputed.join(", ") || "-"}`);

  const worse = clearlyWorseAbove(ranked, trackId);
  if (worse.length === 0) {
    console.log("  Tydligt sämre annonser ovanför: inga");
  } else {
    console.log(`  Tydligt sämre annonser ovanför (${worse.length}):`);
    for (const w of worse) {
      console.log(`    plats ${ranked.indexOf(w) + 1}: ${w.address ?? "-"} (Booli ${w.booliId ?? "-"}), vinst ${orDash(w.profitSek, sek)} kr`);
    }
  }
}

function printNotComparable(notComparable: readonly FitScoreResult[]): void {
  console.log(`\nEj jämförbar (${notComparable.length}):`);
  for (const r of notComparable) {
    console.log(
      `  ${r.address ?? "-"} | utgångspris ${orDash(r.askingSek, sek)} | ${orDash(r.livingArea, String)} kvm | ${r.notComparableReason ?? "-"}`,
    );
  }
}

/** Table, tracked-listing block, not-comparable list and health: identical in replay and live. */
function printRanking(
  ranking: { ranked: FitScoreResult[]; notComparable: FitScoreResult[]; health: ModelHealth },
  rows: readonly FitInputRow[],
  preRankPositions: ReadonlyMap<string, number>,
  trackId: number,
): void {
  console.log(renderFitSections(toFitTableRows(ranking, preRankPositions), { maxRows: FIT_TABLE_MAX_ROWS }));
  printTracked(trackId, ranking, rows, preRankPositions);
  printNotComparable(ranking.notComparable);
  printHealth(ranking.health);
}

function loadModel(path: string) {
  const modelPath = resolve(path);
  if (!existsSync(modelPath)) {
    console.error(`Modellfil saknas: ${path}`);
    process.exit(1);
  }
  return parseHedonicModel(JSON.parse(readFileSync(modelPath, "utf8")));
}

function printModelLine(model: ReturnType<typeof parseHedonicModel>): void {
  console.log(
    `Modell per ${model.asOf}: n ${model.n}, R² ${model.r2.toFixed(2)}, storlek ${model.minLivingArea}–${model.maxLivingArea} kvm, renoband ${RENO_BAND}`,
  );
  if (model.note) console.log(`OBS: ${model.note}`);
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

function runReplay(args: Args): void {
  const snapshotPath = resolve(args.replay as string);
  if (!existsSync(snapshotPath)) {
    console.error(`Snapshotfil saknas: ${args.replay}`);
    process.exit(1);
  }
  const snapshot = parseFitSnapshot(JSON.parse(readFileSync(snapshotPath, "utf8")));
  const model = loadModel(args.model);
  const ranking = rankFit(snapshot.rows, model);

  // The free pre-rank is recomputed from the stored rows (their detail-page
  // facts are included, so it can differ slightly from the live run's own).
  const preRankPositions = new Map<string, number>();
  for (const p of preRank(snapshot.rows, model).ranked) preRankPositions.set(fitRowKey(p.row.candidate), p.position);

  printModelLine(model);
  console.log(
    `Snapshot per ${snapshot.asOf}: ${snapshot.rows.length} rader, ${ranking.ranked.length} jämförbara, ${ranking.notComparable.length} ej jämförbara (förrank räknat om från snapshoten)\n`,
  );
  printRanking(ranking, snapshot.rows, preRankPositions, args.track);
  console.log(`\n${renderCoverage(coverageOfRows(snapshot.rows, model))}`);
}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

function districtOf(name: string): InnerstanDistrict | null {
  return INNERSTAN_DISTRICTS.find((d) => d.toLowerCase() === name.trim().toLowerCase()) ?? null;
}

/** Local-browser counters for the spend block, or null when Apify rendered everything (14.1 mode). */
interface LocalLedger {
  stats: { pages: number; challenged: number; retried: number; failed: number; refused: number; apifyFallbacks: number };
  apifyMaxRenders: number;
}

/**
 * The spend block. Every ledger line starts at column 0 so evidence greps can
 * anchor on it. Local mode prints the free local pages first, then (after the
 * shared settle delay, WR-05) the real Apify bill from the runs API in the one
 * pinned format `formatApifyRunsLine`.
 */
async function printSpend(
  t0: Date,
  result: FitPipelineResult,
  transport: Pick<typeof import("@/lib/booli/transport"), "apifySpendSince" | "formatApifyRunsLine" | "waitForLedgerSettle">,
  local: LocalLedger | null,
): Promise<void> {
  console.log("\nKostnad:");
  if (local) {
    const s = local.stats;
    console.log(
      `Lokal webbläsare: ${s.pages} sidor (${s.challenged} utmaningar, ${s.retried} omförsök, ${s.failed} misslyckade, ${s.refused} vägrade), 0,00 USD`,
    );
    console.log(`Apify-reserv: ${s.apifyFallbacks} renderingar (tak ${local.apifyMaxRenders})`);
  }
  let apifyUsd = 0;
  if (process.env[APIFY_ENV]) {
    // WR-05: Apify books a run's usage a few seconds after it ends - wait before reading the bill, in every mode.
    await transport.waitForLedgerSettle();
    const real = await transport.apifySpendSince(t0);
    if (real) {
      apifyUsd = real.usd;
      console.log(transport.formatApifyRunsLine(real));
      console.log(`Obs: runs-API-siffran gäller hela kontot sedan ${t0.toISOString()} och kan inkludera andra körningar.`);
    } else {
      console.log(transport.formatApifyRunsLine(null, "körnings-API:t svarade inte"));
      const renders = local ? local.stats.apifyFallbacks : result.areas.reduce((n, a) => n + a.renders, 0) + result.window.detailFetched;
      apifyUsd = observedApifyUsdEstimate({ succeeded: renders, timedOut: 0 });
      console.log(`Apify: uppskattning ${apifyUsd.toFixed(2)} USD (≈ ${sek(apifyUsd * USD_SEK_RATE)} kr)`);
    }
  } else {
    console.log(transport.formatApifyRunsLine(null, `${APIFY_ENV} saknas`));
  }
  console.log(`  Anthropic (bildtolkning): ${result.visionSek.toFixed(2)} kr`);
  console.log(`  Totalt: ${sek(apifyUsd * USD_SEK_RATE + result.visionSek)} kr`);
}

async function runLive(args: Args): Promise<void> {
  // W5: the renderer line is the FIRST line runLive writes to stdout, so every dry run and every live log opens with it.
  // local-browser.ts is loaded by dynamic import only here, so --replay stays offline (FIT-06).
  const localBrowser = await import("@/lib/booli/local-browser");
  const choice = localBrowser.resolveRendererChoice({ flag: args.renderer, env: process.env, platform: process.platform });
  if ("error" in choice) {
    console.error(choice.error);
    process.exit(1);
  }
  const localMode = choice.renderer === "local";
  console.log(localMode ? "Renderare: lokal webbläsare" : "Renderare: Apify");
  // The renderer can also come from BOOLI_RENDERER or the display check, so the window/renderer pair is checked again here.
  if (args.window === "all" && !localMode) {
    console.error(WINDOW_ALL_NEEDS_LOCAL);
    process.exit(1);
  }
  const window: number | "all" = args.window ?? (localMode ? "all" : FIT_VISION_WINDOW);

  const outPath = guardedOutPath(args.out ?? `${DATA_DIR}/forsale-snapshot-${new Date().toISOString().slice(0, 10)}.json`);
  if (outPath === null) {
    console.error(`--out måste vara en .json-fil under ${DATA_DIR}/`);
    process.exit(1);
  }
  const model = loadModel(args.model);

  // Preflight. Presence only, never a value.
  const apifyState = process.env[APIFY_ENV] ? "satt" : "saknas";
  const anthropicState = process.env[ANTHROPIC_ENV] ? "satt" : "saknas";
  console.log(`${APIFY_ENV}: ${apifyState}`);
  console.log(`${ANTHROPIC_ENV}: ${anthropicState}`);
  // R-03: the local browser needs no Apify token. Only the paid modes do.
  if (apifyState === "saknas" && (!localMode || args.allowApify)) process.exit(1);
  if (args.noVision) console.log("Bildtolkning: avstängd (--no-vision)");
  else if (anthropicState === "saknas") console.log("Bildtolkning hoppas över: nyckel saknas");

  // Free: loading modules and reading limits spends nothing.
  const transport = await import("@/lib/booli/transport");
  const { splitAreaQuery } = await import("@/lib/discovery/resolve-area");
  // --district keeps AREA_QUERY's order for the districts that remain (dedupe: the first district in that order wins).
  const names = splitAreaQuery(AREA_QUERY).filter((n) => args.district === null || districtOf(n) === districtOf(args.district));

  if (!localMode) {
    if (transport.RENDER_MEMORY_MB !== EXPECTED_RENDER_MEMORY_MB) {
      console.error(`FEL: RENDER_MEMORY_MB är ${transport.RENDER_MEMORY_MB}, förväntade ${EXPECTED_RENDER_MEMORY_MB} (D-17). Ingen körning startad.`);
      process.exit(1);
    }
    // R-13: the headroom check runs before the first paid call.
    // Apify mode never gets "all" (refused above), so the window is a number here.
    const requiredUsd = Math.max(estimateFitRunUsd({ districts: names.length, window: window as number }), args.budgetUsd ?? 0);
    console.log(`Uppskattad Apify-kostnad (värsta fall): ${requiredUsd.toFixed(2)} USD (${names.length} distrikt, fönster ${window})`);
    const check = await checkApifyHeadroom(transport.apifyMonthlyHeadroomUsd, requiredUsd);
    console.log(check.message);
    if (!check.proceed) process.exit(2);
  } else if (args.allowApify) {
    // The only money that can be spent in local mode is the capped Apify fallback: check room for exactly that.
    const requiredUsd = args.apifyMaxRenders * OBSERVED_USD_PER_TIMED_OUT_RENDER;
    console.log(`Apify-reserv (--allow-apify): högst ${args.apifyMaxRenders} renderingar, värsta fall ${requiredUsd.toFixed(2)} USD`);
    const check = await checkApifyHeadroom(transport.apifyMonthlyHeadroomUsd, requiredUsd);
    console.log(check.message);
    if (!check.proceed) process.exit(2);
  } else {
    console.log("Lokal webbläsare: Apify-kontrollerna (token, minne, månadsutrymme) hoppas över, inga Apify-anrop görs.");
  }
  if (args.dryRun) {
    console.log(localMode ? "--dry-run: förkontrollerna är klara, ingen webbläsare startades." : "--dry-run: förkontrollerna är klara, ingen betald körning startades.");
    return;
  }

  const { fetchAreaListings, HEADLESS_MAX_AREA_PAGES } = await import("@/lib/booli/client");
  const { enrichAllCandidates } = await import("@/lib/discovery/watch-enrich");
  const vision = await import("@/lib/discovery/vision");

  const asOf = new Date().toISOString().slice(0, 10);
  const deps: FitPipelineDeps = {
    scrape: async () => {
      const targets: { name: string; district: InnerstanDistrict | null; areaId: string | null }[] = [];
      let supabase: unknown = null;
      for (const name of names) {
        let areaId = seedResolve(name);
        if (areaId === null) {
          // Only for a name the seed lacks: the app's own resolver, with the local Supabase defaults find-reno.ts uses.
          const { createClient } = await import("@supabase/supabase-js");
          const { resolveArea } = await import("@/lib/discovery/resolve-area");
          const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
          const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
          if (!supabaseUrl || !supabaseKey) {
            // No baked-in fallback (code review IN-09): a missing env must fail loudly,
            // never silently point a production shell at localhost.
            throw new Error(
              `Området "${name}" saknas i AREA_SEED och NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY är inte satta (läs in .env.development.local eller ~/.zshenv).`,
            );
          }
          supabase ??= createClient(supabaseUrl, supabaseKey);
          areaId = (await resolveArea(name, supabase as never))?.areaId ?? null;
        }
        targets.push({ name, district: districtOf(name), areaId });
      }

      const areas: AreaReport[] = [];
      const rows: ScrapedRow[] = [];
      const runnable = targets.filter((t) => t.areaId !== null && t.district !== null);
      for (const t of targets) {
        if (t.areaId === null) areas.push({ name: t.name, listings: 0, renders: 0, ok: false, error: "kunde inte resolvas" });
        else if (t.district === null) areas.push({ name: t.name, listings: 0, renders: 0, ok: false, error: "inte ett modellerat innerstadsdistrikt" });
      }
      // Local mode pages each district until Booli's own count is in hand and asks Booli for >= 35 m2 only (R-04, A6);
      // the Apify call is the 14.1 one (5 pages), unchanged.
      const pageOpts = localMode ? { maxPages: HEADLESS_MAX_AREA_PAGES, minLivingArea: FIT_SIZE_MIN } : undefined;
      const settled = await Promise.allSettled(runnable.map((t) => fetchAreaListings(t.areaId as string, "Lägenhet", pageOpts)));
      settled.forEach((s, i) => {
        const t = runnable[i];
        if (s.status === "fulfilled") {
          areas.push({
            name: t.name,
            listings: s.value.listings.length,
            renders: s.value.rendersUsed,
            ok: true,
            error: null,
            totalCount: s.value.totalCount,
            pages: s.value.pagesFetched,
            complete: s.value.complete,
          });
          for (const raw of s.value.listings) {
            rows.push({ district: t.district as InnerstanDistrict, candidate: toCandidate(raw), facts: factsFromCard(raw) });
          }
        } else {
          areas.push({ name: t.name, listings: 0, renders: 0, ok: false, error: (s.reason as Error)?.message ?? String(s.reason) });
        }
      });
      return { rows, areas };
    },
    // Detail page, broker page and facts for every candidate (D-06); broker photos only when something will read them.
    enrich: (candidates, limit, opts) => enrichAllCandidates(candidates, limit, { ...opts, asOf, fetchBrokerImages: !args.noVision }),
    // Vision stays as 14.1 wired it (in-app cap); --no-vision turns it off entirely.
    vision:
      anthropicState === "satt" && !args.noVision
        ? (candidates, opts) => vision.runVisionPass(candidates, opts)
        : async (candidates) => candidates,
  };

  // Local mode: install the headed-Chromium renderer into transport.ts. From here every Booli read in
  // this process (scrape, detail, vision enrichment) goes through it; Apify is touched only by an
  // explicit --allow-apify fallback. Nothing may process.exit past this point: the browser must close.
  const handle = localMode
    ? localBrowser.installLocalRenderer({ allowApify: args.allowApify, apifyMaxRenders: args.apifyMaxRenders })
    : null;
  const disposeSignals = handle ? localBrowser.closeOnSignals(handle) : null;
  const ledger = (): LocalLedger | null => (handle ? { stats: handle.stats(), apifyMaxRenders: args.apifyMaxRenders } : null);

  try {
    const t0 = new Date();
    console.log(`\nStart: ${t0.toISOString()}`);
    const result = await runFitPipeline(deps, { model, asOf, window });

    printModelLine(model);
    console.log(renderAreaReport(result.areas));
    const everyDistrictFailed = result.areas.length > 0 && result.areas.every((a) => !a.ok);
    if (everyDistrictFailed) {
      console.error("\nFEL: alla distrikt misslyckades, ingen snapshot skrevs.");
      await printSpend(t0, result, transport, ledger());
      process.exitCode = 1;
      return;
    }

    // The snapshot is written before the long printout, so a paid result survives a printing bug.
    // A failed write is reported at the end (exit 1) but never hides the paid result.
    let writeError: string | null = null;
    try {
      writeJsonAtomic(outPath, result.snapshot satisfies FitSnapshot);
    } catch (e) {
      writeError = e instanceof Error ? e.message : String(e);
    }

    console.log(
      `\nAnnonser: ${result.counts.scraped} hämtade, ${result.counts.deduped} efter dubblettstädning, ${result.counts.filtered} efter filter (lägenhet, >= 35 kvm, utgångspris <= 4 000 000 kr); ${result.ranking.ranked.length} jämförbara, ${result.ranking.notComparable.length} ej jämförbara`,
    );
    console.log(`\n${renderWindowReport(result)}`);
    console.log(`\n${renderCoverage(result.coverage)}`);
    console.log("");
    printRanking(result.ranking, result.snapshot.rows, result.preRankPositions, args.track);
    await printSpend(t0, result, transport, ledger());
    if (writeError === null) {
      console.log(`\nSnapshot skriven: ${outPath}`);
    } else {
      console.error(`\nFEL: snapshoten kunde inte skrivas till ${outPath}: ${writeError}`);
      process.exitCode = 1;
    }
  } finally {
    disposeSignals?.();
    await handle?.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    console.log(USAGE);
    process.exit(1);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  // Checked while reading the arguments, before any preflight (T-14.2-07): "all" is free only with the local browser.
  if (args.window === "all" && args.renderer === "apify") {
    console.error(WINDOW_ALL_NEEDS_LOCAL);
    process.exit(1);
  }
  if (args.district !== null && districtOf(args.district) === null) {
    console.error(`--district måste vara ett av: ${INNERSTAN_DISTRICTS.join(", ")} (fick "${args.district}")`);
    process.exit(1);
  }
  if (args.replay !== null) runReplay(args);
  else await runLive(args);
}

main().catch((e) => {
  console.error("FEL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
