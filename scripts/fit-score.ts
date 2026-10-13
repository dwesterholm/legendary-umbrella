/**
 * Headless flip-profit ranking using the app's own pipeline modules.
 *
 * Two modes on one table renderer:
 *
 *   Replay (offline, free): reads a stored for-sale snapshot and the fitted
 *   model, scores every row and prints the ranked table.
 *     npx tsx scripts/fit-score.ts --replay <snapshot.json> [--model data/hedonic-model.json] [--track 150148]
 *
 *   Live (PAID): scrapes the four innerstan districts on Apify, ranks every
 *   comparable flat for free, detail-fetches and picture-reads only the top
 *   FIT_VISION_WINDOW, re-ranks by profit, writes a snapshot under
 *   .planning/calibration/data/ and prints the real spend. It first compares
 *   the Apify monthly headroom with the run's worst-case cost and exits with
 *   code 2 when the headroom is smaller (R-13). `--dry-run` stops right after
 *   that check, before the first paid call.
 *     npx tsx scripts/fit-score.ts [--window 20] [--budget-usd N] [--out <file>] [--dry-run]
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
import { observedApifyUsdEstimate } from "@/lib/discovery/cost";
import {
  FIT_TABLE_MAX_ROWS,
  checkApifyHeadroom,
  estimateFitRunUsd,
  fitRowKey,
  renderAreaReport,
  renderFitTable,
  renderWindowReport,
  runFitPipeline,
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
import { RENO_BAND } from "@/lib/discovery/reno-tier";

const DEFAULT_MODEL_PATH = "data/hedonic-model.json";
const DEFAULT_TRACK_ID = 150148;
const DATA_DIR = ".planning/calibration/data";
const AREA_QUERY = "innerstan (innanför tullarna)";
const APIFY_ENV = "APIFY_API_TOKEN";
const ANTHROPIC_ENV = "ANTHROPIC_API_KEY";
const EXPECTED_RENDER_MEMORY_MB = 2048;
const MAX_WINDOW = 100;

const USAGE = `Användning:
  Uppspelning (gratis, offline):
    npx tsx scripts/fit-score.ts --replay <snapshot.json> [--model ${DEFAULT_MODEL_PATH}] [--track ${DEFAULT_TRACK_ID}]
  Live-körning (BETALD: Apify + Anthropic):
    npx tsx scripts/fit-score.ts [--window ${FIT_VISION_WINDOW}] [--budget-usd <n>] [--out <fil>] [--dry-run] [--model ${DEFAULT_MODEL_PATH}] [--track ${DEFAULT_TRACK_ID}]

  --replay <fil>     Spela upp en sparad snapshot av bostäder till salu (inga nätverksanrop)
  --model <fil>      Hedonisk modell (JSON), standard ${DEFAULT_MODEL_PATH}
  --track <id>       Booli-id att visa uppdelat i detalj, standard ${DEFAULT_TRACK_ID}
  --window <n>       Live: antal annonser som får detaljsida och bildtolkning, standard ${FIT_VISION_WINDOW} (0-${MAX_WINDOW})
  --budget-usd <n>   Live: kan bara höja det Apify-utrymme som krävs, aldrig sänka det under värsta-fall-uppskattningen
  --out <fil>        Live: snapshot att skriva, standard ${DATA_DIR}/forsale-snapshot-<datum>.json (måste ligga under ${DATA_DIR}/)
  --dry-run          Live: gör förkontrollerna och Apify-utrymmeskontrollen, avsluta sedan innan första betalda anrop
  --help             Visa den här texten

Slutkoder: 0 klart (även med noll kandidater), 1 fel (argument, fil, nyckel saknas, alla distrikt misslyckades),
2 Apify-utrymmet för månaden är mindre än körningens uppskattade kostnad (inget betalt anrop gjordes).`;

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
  window: number;
  budgetUsd: number | null;
  out: string | null;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args | null {
  const out: Args = {
    replay: null,
    model: DEFAULT_MODEL_PATH,
    track: DEFAULT_TRACK_ID,
    window: FIT_VISION_WINDOW,
    budgetUsd: null,
    out: null,
    dryRun: false,
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
    else if (flag === "--window" && value !== undefined && Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= MAX_WINDOW) {
      out.window = Number(value); liveOnly = true; i++;
    } else if (flag === "--budget-usd" && value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0) {
      out.budgetUsd = Number(value); liveOnly = true; i++;
    } else if (flag === "--out" && value !== undefined) { out.out = value; liveOnly = true; i++; }
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
  console.log(`  Värde renoverad:    ${orDash(r.resaleSek, sek)} kr`);
  console.log(`  Skillnad (värde - slutpris): ${orDash(r.gapSek, sek)} kr`);
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
  console.log(renderFitTable(toFitTableRows(ranking, preRankPositions), { maxRows: FIT_TABLE_MAX_ROWS }));
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
}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

function districtOf(name: string): InnerstanDistrict | null {
  return INNERSTAN_DISTRICTS.find((d) => d.toLowerCase() === name.trim().toLowerCase()) ?? null;
}

async function printSpend(
  t0: Date,
  result: FitPipelineResult,
  apifySpendSince: (since: Date) => Promise<{ usd: number; runs: number; succeeded: number; timedOut: number; failed: number } | null>,
): Promise<void> {
  const real = await apifySpendSince(t0);
  let apifyUsd: number;
  console.log("\nKostnad:");
  if (real) {
    apifyUsd = real.usd;
    console.log(
      `  Apify (från körnings-API:t, kontot som helhet, kan inkludera andra körningar sedan ${t0.toISOString()}): ${apifyUsd.toFixed(2)} USD (≈ ${sek(apifyUsd * USD_SEK_RATE)} kr), ${real.runs} körningar (${real.succeeded} lyckade, ${real.timedOut} timeout, ${real.failed} misslyckade)`,
    );
  } else {
    const renders = result.areas.reduce((n, a) => n + a.renders, 0) + result.window.detailFetched;
    apifyUsd = observedApifyUsdEstimate({ succeeded: renders, timedOut: 0 });
    console.log(`  Apify: uppskattning (körnings-API:t svarade inte) ${apifyUsd.toFixed(2)} USD (≈ ${sek(apifyUsd * USD_SEK_RATE)} kr)`);
  }
  console.log(`  Anthropic (bildtolkning): ${result.visionSek.toFixed(2)} kr`);
  console.log(`  Totalt: ${sek(apifyUsd * USD_SEK_RATE + result.visionSek)} kr`);
}

async function runLive(args: Args): Promise<void> {
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
  if (apifyState === "saknas") process.exit(1);
  if (anthropicState === "saknas") console.log("Bildtolkning hoppas över: nyckel saknas");

  // Free: loading modules and reading limits spends nothing.
  const transport = await import("@/lib/booli/transport");
  if (transport.RENDER_MEMORY_MB !== EXPECTED_RENDER_MEMORY_MB) {
    console.error(`FEL: RENDER_MEMORY_MB är ${transport.RENDER_MEMORY_MB}, förväntade ${EXPECTED_RENDER_MEMORY_MB} (D-17). Ingen körning startad.`);
    process.exit(1);
  }
  const { splitAreaQuery } = await import("@/lib/discovery/resolve-area");
  const names = splitAreaQuery(AREA_QUERY);

  // R-13: the headroom check runs before the first paid call.
  const requiredUsd = Math.max(estimateFitRunUsd({ districts: names.length, window: args.window }), args.budgetUsd ?? 0);
  console.log(`Uppskattad Apify-kostnad (värsta fall): ${requiredUsd.toFixed(2)} USD (${names.length} distrikt, fönster ${args.window})`);
  const check = await checkApifyHeadroom(transport.apifyMonthlyHeadroomUsd, requiredUsd);
  console.log(check.message);
  if (!check.proceed) process.exit(2);
  if (args.dryRun) {
    console.log("--dry-run: förkontrollerna är klara, ingen betald körning startades.");
    return;
  }

  const { fetchAreaListings } = await import("@/lib/booli/client");
  const job = await import("@/lib/discovery/job");
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
      const settled = await Promise.allSettled(runnable.map((t) => fetchAreaListings(t.areaId as string, "Lägenhet")));
      settled.forEach((s, i) => {
        const t = runnable[i];
        if (s.status === "fulfilled") {
          areas.push({ name: t.name, listings: s.value.listings.length, renders: s.value.rendersUsed, ok: true, error: null });
          for (const raw of s.value.listings) rows.push({ district: t.district as InnerstanDistrict, candidate: toCandidate(raw) });
        } else {
          areas.push({ name: t.name, listings: 0, renders: 0, ok: false, error: (s.reason as Error)?.message ?? String(s.reason) });
        }
      });
      return { rows, areas };
    },
    enrich: (candidates, limit, opts) => job.enrichCandidateImages(candidates, limit, opts),
    vision:
      anthropicState === "satt"
        ? (candidates, opts) => vision.runVisionPass(candidates, opts)
        : async (candidates) => candidates,
  };

  const t0 = new Date();
  console.log(`\nStart: ${t0.toISOString()}`);
  const result = await runFitPipeline(deps, { model, asOf, window: args.window });

  printModelLine(model);
  console.log(renderAreaReport(result.areas));
  const everyDistrictFailed = result.areas.length > 0 && result.areas.every((a) => !a.ok);
  if (everyDistrictFailed) {
    console.error("\nFEL: alla distrikt misslyckades, ingen snapshot skrevs.");
    await printSpend(t0, result, transport.apifySpendSince);
    process.exit(1);
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
  console.log("");
  printRanking(result.ranking, result.snapshot.rows, result.preRankPositions, args.track);
  await printSpend(t0, result, transport.apifySpendSince);
  if (writeError === null) {
    console.log(`\nSnapshot skriven: ${outPath}`);
  } else {
    console.error(`\nFEL: snapshoten kunde inte skrivas till ${outPath}: ${writeError}`);
    process.exit(1);
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
  if (args.replay !== null) runReplay(args);
  else await runLive(args);
}

main().catch((e) => {
  console.error("FEL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
