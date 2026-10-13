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
 *   Picture reading (Phase 14.2, D-06, R-09): every candidate in the window is read
 *   in 3 parallel lanes (index mod 3), each capped at 20 SEK, so one run can never
 *   pass 60 SEK (src/lib/discovery/vision-cache.ts; the in-app cap of 25 SEK is a
 *   different number and is not touched). A flat already read with the same picture
 *   set comes from .planning/calibration/data/vision-cache.json (gitignored) and
 *   costs nothing. One line sums it up: "Bildtolkning: N anrop, N från cache, N
 *   hoppades över, X,XX kr av tak 60 kr (delar: a/b/c kandidater)".
 *   --no-vision prints "Bildtolkning: avstängd (--no-vision)" and makes no
 *   Anthropic call.
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
 * Every row shows one "Skillnad" (value minus expected final price, D-05): since 14.4 the whole of
 * it counts in the profit, there is no ceiling. A flat far below the model for its features gets
 * the flag "ovanligt långt under modellpris" (R-04, RESIDUAL_FLAG_BASIS in fit-score.ts); the flag
 * explains, it never changes a number. Every run prints how many rows carry it under both bases.
 *
 * "Varför här" (Phase 14.2, WATCH-03, D-08): every row has a reason column built by the pure
 * rules in src/lib/discovery/watch-reasons.ts (tenure, tomträtt, nyproduktion, bidding, price
 * cut, days on market, avgift per kvm against the district median, association debt per kvm,
 * a high floor with no elevator listed, an unusual layout, "snart till salu"). A row flagged
 * ovanligt långt under modellpris or dold-defekt-risk with no reason says "oförklarat fynd". Association debt comes
 * from Booli's public BRF page (one page per distinct association, local browser, free); the
 * line "BRF-sidor: <lästa> av <olika> lästa, <misslyckade> misslyckades" says how many were read.
 *
 * Weekly e-mail and memory (Phase 14.2, WATCH-05, D-14, D-15, R-01): with --email the run remembers
 * what it has shown in .planning/calibration/data/watch-state.json (gitignored; first-seen date, last
 * asking price, price history per listing). The mail carries only flats that are new since the last run
 * ("nya sedan förra veckan") or whose asking price changed ("prisändrad (gammalt → nytt)"); the very first
 * run, or one with an empty memory, carries the top 15 rows of each section. A week with nothing new sends
 * nothing and writes nothing ("inget nytt: 0 nya, 0 prisändrade, ingen e-post"). Delivery is SMTP through
 * nodemailer from the environment (WATCH_SMTP_URL, WATCH_EMAIL_TO, optional WATCH_EMAIL_FROM; reported as
 * satt/saknas only, never printed). Without both variables the same HTML is written to
 * .planning/calibration/data/weekly-<date>.html instead, the run says so and exits 4, and the memory is left
 * alone (the flats are mailed once the variables work; WATCH_MARK_SEEN_WITHOUT_SMTP=1 restores "mark as seen").
 * The memory is written only after the mail was accepted, so a rerun the same day finds nothing new.
 * A lock file next to the memory (watch-state.lock) stops two runs from overlapping (exit 3);
 * a failed send, or missing SMTP variables, keeps the memory untouched (exit 4); a local run that passes 2 hours is stopped (exit 5).
 * --email also works with --replay (offline apart
 * from the send itself).
 *
 * Sol (Phase 14.3, SUN-01, SUN-03, SUN-05, R-05): every row gets a sun fact before ranking: the building footprint
 * from the cached OpenStreetMap map of innerstan (.planning/calibration/data/osm/innerstan.json, gitignored), the
 * stated facades, the precedence between them and the hours of direct sun on each side with the neighbouring
 * buildings in the way (src/lib/discovery/sun-fact.ts computeSunFact, wrapped by computeSunFactSafe). The table, the mail, the coverage line and
 * the taste bonus all read that one fact. The map is refreshed only when it is missing or 31 days old (the live run
 * says "OSM-cache: <ålder> dagar gammal, ingen hämtning (gräns 31 dagar)" otherwise); the Overpass client is loaded by
 * dynamic import in that one branch, so a replay and a dry run never reach it. --osm <fil> uses that file instead and
 * skips the refresh. A missing or unreadable map gives every row "okänd" (live) or keeps the snapshot's stored sun
 * (replay) and says so. The floor-plan route is closed (FLOORPLAN_ROUTE_ENABLED, plan 14.3-03): no floor-plan cache
 * is read and no model call is made here. Map data (c) OpenStreetMap contributors, ODbL.
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
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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
  incompleteDistricts,
  renderAreaReport,
  renderBrfLine,
  renderCoverage,
  renderFitSections,
  renderWindowReport,
  runFitPipeline,
  splitFitSections,
  toFitTableRows,
  withReasonsOnFlagged,
  FIT_FLAG_LABELS,
  type AreaReport,
  type FitPipelineDeps,
  type FitPipelineResult,
  type FitTableRow,
  type ScrapedRow,
} from "@/lib/discovery/fit-pipeline";
import {
  FIT_VISION_WINDOW,
  RESIDUAL_FLAG_BASIS,
  RESIDUAL_FLAG_SD,
  clearlyWorseAbove,
  parseFitSnapshot,
  preRank,
  rankFit,
  residualFlagCounts,
  rowsAtTasteCap,
  type FitInputRow,
  type FitScoreResult,
  type FitSnapshot,
  type ModelHealth,
} from "@/lib/discovery/fit-score";
import { INNERSTAN_DISTRICTS, parseHedonicModel, type InnerstanDistrict } from "@/lib/discovery/hedonic-model";
import { guardedDataPath, writeJsonAtomic, writeTextAtomic } from "@/lib/discovery/json-store";
import { formatLayoutSummary } from "@/lib/discovery/layout-fact";
import { factsFromCard } from "@/lib/discovery/listing-facts";
import { RENO_BAND } from "@/lib/discovery/reno-tier";
import { fitRunRecordOf } from "@/lib/discovery/valuation-report";
import {
  coveredByModelOf,
  districtAvgiftMedians,
  isReasonFlagged,
  reasonCell,
  reasonsFor,
  residualReason,
} from "@/lib/discovery/watch-reasons";
import { WATCH_MAIL_ENV, WATCH_MARK_SEEN_WITHOUT_SMTP, decideAfterSend, sendWatchMail } from "@/lib/discovery/watch-mail";
import {
  renderWatchHtml,
  renderWatchText,
  selectMailRows,
  watchSubject,
  type WatchMailInput,
} from "@/lib/discovery/watch-report";
import {
  RunLockedError,
  WATCH_FIRST_MAIL_PER_SECTION,
  WATCH_STATE_PATH,
  acquireRunLock,
  diffRun,
  isFirstRun,
  loadWatchState,
  lockPathOf,
  peekWatchState,
  pruneStale,
  readRunLock,
  saveWatchState,
  type RunLock,
} from "@/lib/discovery/watch-state";
import {
  HEADLESS_VISION_CAP_SEK,
  HEADLESS_VISION_CHUNKS,
  VISION_CACHE_PATH,
  loadVisionCache,
  renderVisionLine,
  runVisionChunks,
  saveVisionCache,
  type VisionChunksResult,
} from "@/lib/discovery/vision-cache";
import { buildOsmIndex, parseOsmExtract, suspectHeights, type OsmIndex } from "@/lib/discovery/osm-buildings";
import {
  OSM_CACHE_PATH,
  loadOsmCacheRaw,
  osmCacheFailureText,
  osmCacheNeedsRefresh,
  osmCacheUnknownReason,
  readOsmCacheMeta,
  refreshOsmCacheIfStale,
  renderOsmCacheLine,
  type OsmCacheMeta,
} from "@/lib/discovery/osm-cache";
import {
  FLOORPLAN_CACHE_PATH,
  FLOORPLAN_PROBE_SUMMARY,
  FLOORPLAN_PROBE_VERSION,
  FLOORPLAN_ROUTE_ENABLED,
  floorPlanImageId,
  formatSek,
  loadFloorPlanCache,
  planBearingOf,
  type FloorPlanCache,
} from "@/lib/discovery/sun-floorplan";
import { SUN_FAILURE_REASON, computeSunFactSafe, renderSunReport, unknownSunFact, type SunFact } from "@/lib/discovery/sun-fact";
import type { PlanBearing } from "@/lib/discovery/sun-fact";

const DEFAULT_MODEL_PATH = "data/hedonic-model.json";
const DEFAULT_TRACK_ID = 150148;
const DATA_DIR = ".planning/calibration/data";
/** Where `--json` may write a run record (14.4-01, T-14.4-01): the phase evidence dirs and the gitignored data dir. */
const RUN_RECORD_ROOTS = [".planning/phases", ".planning/calibration/data"] as const;
const AREA_QUERY = "innerstan (innanför tullarna)";
const APIFY_ENV = "APIFY_API_TOKEN";
const ANTHROPIC_ENV = "ANTHROPIC_API_KEY";
const EXPECTED_RENDER_MEMORY_MB = 2048;
const MAX_WINDOW = 100;
const DEFAULT_APIFY_MAX_RENDERS = 10;
const MAX_APIFY_MAX_RENDERS = 100;

const USAGE = `Användning:
  Uppspelning (gratis, offline):
    npx tsx scripts/fit-score.ts --replay <snapshot.json> [--model ${DEFAULT_MODEL_PATH}] [--track ${DEFAULT_TRACK_ID}] [--osm <utdrag.json>] [--json <fil.json>]
  Live-körning (lokal webbläsare är gratis för Booli; Apify och bildtolkning kostar):
    npx tsx scripts/fit-score.ts [--window all|<n>] [--district <område>] [--no-vision] [--budget-usd <n>] [--out <fil>] [--dry-run] [--renderer local|apify] [--allow-apify] [--apify-max-renders <n>] [--osm <utdrag.json>] [--model ${DEFAULT_MODEL_PATH}] [--track ${DEFAULT_TRACK_ID}]
  Veckomejl med bevakningsminne (båda lägena):
    npx tsx scripts/fit-score.ts --email [--state <fil>] [--no-state-write] [--no-vision] [--dry-run]
    npx tsx scripts/fit-score.ts --replay <snapshot.json> --email [--state <fil>] [--no-state-write]

  Tabellen har två avsnitt: "Förväntat under 4 M" (förväntat slutpris högst 4 000 000 kr) och "Över 4 M förväntat".
  "Skillnad" är värde minus förväntat slutpris; hela skillnaden räknas in i vinsten (inget tak sedan 14.4).
  Flaggan "ovanligt långt under modellpris" sätts när förväntat slutpris per kvm ligger mer än två restspridningar under modellen; den förklarar men ändrar aldrig en siffra.
  Områdesraden säger "N av M annonser (P sidor, komplett|ofullständig)" och "Kandidatlista: komplett|OFULLSTÄNDIG (...)";
  raden "Täckning (...)" säger hur mycket som faktiskt är känt (balkong, skick, beskrivning, sol, avgift, upplåtelseform, föreningsskuld).
  Kolumnen "Varför här" förklarar varför en annons kan vara billig; en flaggad annons utan förklaring heter "oförklarat fynd".

  --replay <fil>     Spela upp en sparad snapshot av bostäder till salu (inga nätverksanrop)
  --osm <fil>        OSM-utdrag (JSON, .json) med byggnader och gator att räkna solen på i stället för cachen ${OSM_CACHE_PATH}.
                     Filen läses bara, ingenting hämtas och cachen uppdateras inte. Utan flaggan används cachen: uppspelning läser den
                     och hämtar aldrig; en live-körning hämtar bara när den saknas eller är 31 dagar gammal. Kolumnerna "Sol",
                     "Soltim. fri" och "Soltim. med grannhus" visar väderstreck, källa och säkerhet samt timmar sol (mar/jun/dec).
                     Data (c) OpenStreetMap contributors, ODbL
  --json <fil>       Uppspelning: skriv körningen (varje rad med okapad skillnad, krediterad del, vinst och flaggor, samt modell och snapshot)
                     som en körningspost. Filen måste sluta på .json och ligga under ${RUN_RECORD_ROOTS.map((r) => `${r}/`).join(" eller ")}.
                     Tabellen som skrivs ut är oförändrad; raden "Körningspost: <fil>" läggs till efter täckningsraden
  --model <fil>      Hedonisk modell (JSON), standard ${DEFAULT_MODEL_PATH}
  --track <id>       Booli-id att visa uppdelat i detalj, standard ${DEFAULT_TRACK_ID}
  --window all|<n>   Live: antal annonser som får detaljsida (och bildtolkning). Standard: all (alla jämförbara) med lokal webbläsare,
                     ${FIT_VISION_WINDOW} med Apify. "all" kräver --renderer local; <n> är 0-${MAX_WINDOW}
  --district <namn>  Live: läs bara ett område (${INNERSTAN_DISTRICTS.join(", ")})
  --no-vision        Live: ingen bildtolkning och inget Anthropic-anrop (detaljsidor och mäklartext läses ändå)
                     Utan den läses bilderna för alla annonser i fönstret: 3 parallella delar, högst 60 kr per körning (20 kr per del),
                     redan lästa annonser hämtas ur ${VISION_CACHE_PATH}; raden "Bildtolkning: ..." visar kostnaden
  --budget-usd <n>   Live: kan bara höja det Apify-utrymme som krävs, aldrig sänka det under värsta-fall-uppskattningen
  --out <fil>        Live: snapshot att skriva, standard ${DATA_DIR}/forsale-snapshot-<datum>.json (måste ligga under ${DATA_DIR}/)
  --dry-run          Live: gör förkontrollerna (med Apify även utrymmeskontrollen), avsluta sedan innan första sidan hämtas
  --renderer <r>     Live: local (standard när en skärm finns; gratis) eller apify (betald). Alternativ: miljövariabeln BOOLI_RENDERER
  --allow-apify      Live, lokal webbläsare: låt en sida som blockerats två gånger gå till Apify (betald, kräver token och utrymme)
  --apify-max-renders <n>  Live: tak för Apify-renderingar med --allow-apify, standard ${DEFAULT_APIFY_MAX_RENDERS} (1-${MAX_APIFY_MAX_RENDERS})
  --email            Veckomejl: kom ihåg vad som visats (${WATCH_STATE_PATH}) och skicka bara nya annonser ("nya sedan förra veckan")
                     och prisändrade ("prisändrad (gammalt → nytt)"); första körningen tar de 15 främsta i varje avsnitt.
                     En vecka utan nyheter skickar och skriver ingenting ("inget nytt: 0 nya, 0 prisändrade, ingen e-post").
                     E-post skickas via SMTP när miljövariablerna ${WATCH_MAIL_ENV.url} och ${WATCH_MAIL_ENV.to} är satta
                     (valfritt ${WATCH_MAIL_ENV.from}; värdena skrivs aldrig ut, bara satt/saknas). Annars skrivs samma HTML till
                     ${DATA_DIR}/weekly-<datum>.html, körningen avslutas med kod 4 och minnet lämnas orört (annonserna mejlas när
                     variablerna fungerar); ${WATCH_MARK_SEEN_WITHOUT_SMTP}=1 markerar dem som sedda ändå. Minnet uppdateras först när leveransen lyckats. Live-körning kräver
                     ${ANTHROPIC_ENV} om inte --no-vision anges. Med --dry-run: bara förkontroller (SMTP, minne, lås), ingen hämtning
  --state <fil>      Bevakningsminne (JSON under ${DATA_DIR}/), standard ${WATCH_STATE_PATH}; låsfilen ligger bredvid (<namn>.lock)
  --no-state-write   Skriv inte bevakningsminnet (provkörning av mejlet)
  --help             Visa den här texten

Slutkoder: 0 klart (även med noll kandidater och en tyst vecka), 1 fel (argument, fil, nyckel saknas, alla distrikt misslyckades, ingen skärm),
2 Apify-utrymmet för månaden är mindre än körningens uppskattade kostnad (inget betalt anrop gjordes),
3 en annan körning håller låset (watch-state.lock), 4 e-postleveransen misslyckades (HTML skriven, minnet orört).`;

const WINDOW_ALL_NEEDS_LOCAL = "--window all kräver --renderer local (med Apify är varje sida en betald rendering)";

const sek = (n: number) => Math.round(n).toLocaleString("sv-SE");
const pct = (n: number) => `${(n * 100).toFixed(1)} %`;
/** A signed percentage with a decimal comma: 0.042 gives "+4,2 %", -0.2 gives "-20,0 %". */
const signedPct = (n: number) => `${n < 0 ? "-" : "+"}${(Math.abs(n) * 100).toFixed(1).replace(".", ",")} %`;
const BASIS_TEXT = { expectedFinal: "förv. slutpris", asking: "utgångspris" } as const;
/** R-04: how many rows the residual flag marks under the basis in force and under the other one, on every run. */
function residualCountLine(ranked: readonly FitScoreResult[], model: ReturnType<typeof parseHedonicModel>): string {
  const c = residualFlagCounts(ranked, model.residualSdLog);
  return `Residualflagga (${FIT_FLAG_LABELS.residualFlag}): ${c.primary} av ${c.n} jämförbara (bas ${BASIS_TEXT[c.primaryBasis]}); med bas ${BASIS_TEXT[c.otherBasis]}: ${c.other}`;
}
const orDash = (n: number | null, f: (x: number) => string) => (n === null ? "-" : f(n));

/** R-09 (Phase 14.4): how many comparable rows reach the 5 % taste cap, printed after the coverage line on every run. */
function tasteCapLine(ranked: readonly FitScoreResult[]): string {
  const c = rowsAtTasteCap(ranked);
  return `Smak: 5 %-taket nås av ${c.reached} av ${c.of} rader`;
}

/** The layout step's spend line (R-07): this run's calls, cache hits, rows over the cap, failures, kr and the lifetime ledger. */
function layoutSpendLine(run: {
  calls: number;
  cacheHits: number;
  reads: ReadonlyArray<{ status: string }>;
  spentSek: number;
  totalSpentSek: number;
}, capSek: number): string {
  const count = (status: string) => run.reads.filter((r) => r.status === status).length;
  return (
    `Planlösning: ${run.calls} anrop, ${run.cacheHits} från cache, ${count("cost_cap")} över taket, ${count("failed")} misslyckade; ` +
    `${formatSek(run.spentSek)} kr denna körning (tak ${capSek} kr), totalt ${formatSek(run.totalSpentSek)} kr sedan start`
  );
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
  replay: string | null;
  /** OSM extract file for the sun stage (14.3-01); null = the cache. Read only, no refresh, replay and live. */
  osm: string | null;
  /** Replay only (14.4-01, R-05): where to write the run record; null = write none. */
  json: string | null;
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
  /** Weekly mail with the seen-listing memory (WATCH-05). Allowed with --replay. */
  email: boolean;
  /** The memory file; null = {@link WATCH_STATE_PATH}. */
  state: string | null;
  noStateWrite: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args | null {
  const out: Args = {
    replay: null,
    osm: null,
    json: null,
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
    email: false,
    state: null,
    noStateWrite: false,
    help: false,
  };
  let liveOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--help" || flag === "-h") out.help = true;
    else if (flag === "--dry-run") { out.dryRun = true; liveOnly = true; }
    else if (flag === "--replay" && value !== undefined) { out.replay = value; i++; }
    else if (flag === "--osm" && value !== undefined && value.toLowerCase().endsWith(".json")) { out.osm = value; i++; }
    else if (flag === "--json" && value !== undefined) { out.json = value; i++; }
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
    else if (flag === "--email") out.email = true;
    else if (flag === "--state" && value !== undefined) { out.state = value; i++; }
    else if (flag === "--no-state-write") out.noStateWrite = true;
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
  // --json records a replay; a live run does not write one, so refuse it rather than ignore it silently.
  if (out.json !== null && out.replay === null) return null;
  // The memory flags mean nothing without the mail: refuse them rather than ignore them silently.
  if (!out.email && (out.state !== null || out.noStateWrite)) return null;
  return out;
}

/** The listing path of a Booli URL (the vision cache key), or null when there is no parseable URL. */
function listingPathOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
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

/**
 * The "varför här" callback for a run: the reason rules read each scored row's snapshot row (its facts and
 * its candidate's upcomingSale flag), with the district avgift medians taken from the run's own comparable rows (D-09).
 * Replay and live build it the same way from the same rows, so the cells match.
 */
function makeReasonsOf(
  rows: readonly FitInputRow[],
  ranked: readonly FitScoreResult[],
  model: ReturnType<typeof parseHedonicModel>,
): (r: FitScoreResult) => string[] {
  const keyOfResult = (r: FitScoreResult): string => r.sourceListingUrl ?? `${r.address}|${r.askingSek}`;
  const byKey = new Map(rows.map((row) => [fitRowKey(row.candidate), row] as const));
  const comparable = ranked.flatMap((r) => {
    const row = byKey.get(keyOfResult(r));
    return row ? [row] : [];
  });
  const medians = districtAvgiftMedians(comparable);
  // Which of avgift and association debt the loaded model really fitted: only those reasons say "redan i värderingen".
  const covered = coveredByModelOf(model);
  return (r) => {
    const row = byKey.get(keyOfResult(r));
    const rowReasons = row ? reasonsFor(row, { medians, coveredByModel: covered }) : [];
    if (!r.flags.includes("residualFlag")) return rowReasons;
    return [...rowReasons, residualReason(r, { residualSdLog: model.residualSdLog, basis: RESIDUAL_FLAG_BASIS, covered })];
  };
}

/** The model's days-on-market term in one phrase for the tracked block (kept, tried and rejected, or absent). */
function domTermText(model: ReturnType<typeof parseHedonicModel>): string {
  const dom = model.bidPremium.terms.dom;
  return dom === null ? "saknas i modellen" : dom.note;
}

function printTracked(
  model: ReturnType<typeof parseHedonicModel>,
  trackId: number,
  ranking: { ranked: FitScoreResult[]; notComparable: FitScoreResult[] },
  rows: readonly FitInputRow[],
  preRankPositions: ReadonlyMap<string, number>,
  reasonsOf: (r: FitScoreResult) => string[],
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
  console.log(`  Förv. överbud:      ${orDash(r.overbidPct, pct)}${r.overbidDetail === null ? "" : ` (${r.overbidDetail.label})`}`);
  console.log(
    `  Dagar ute:          ${orDash(row?.facts?.daysOnMarket ?? null, (n) => String(Math.round(n)))} (dagar-term: ${domTermText(model)})`,
  );
  console.log(`  Förv. slutpris:     ${orDash(r.purchaseSek, sek)} kr`);
  // Same split function and same rounding as the table, so the line always matches the section the row was printed in.
  const inUnder = splitFitSections(toFitTableRows({ ranked: [r] }, new Map())).under.length === 1;
  console.log(`  Sektion:            ${inUnder ? FIT_SECTION_TITLES.under : FIT_SECTION_TITLES.over}`);
  console.log(`  Värde renoverad:    ${orDash(r.resaleSek, sek)} kr`);
  console.log(`  Skillnad (värde - slutpris): ${orDash(r.gapSek, sek)} kr`);
  console.log(
    `  Residual:           förv. slutpris/modell ${orDash(r.expectedFinalToPred === null ? null : r.expectedFinalToPred - 1, signedPct)} (gräns ${signedPct(Math.exp(-RESIDUAL_FLAG_SD * model.residualSdLog) - 1)}, bas ${RESIDUAL_FLAG_BASIS})`,
  );
  console.log(`  Reno:               ${renoText(r)}; kök ${r.renoStates.kitchen}, badrum ${r.renoStates.bathroom}, helhet ${r.renoStates.overall}`);
  console.log(`  Försäljningskostnad: ${sek(r.salesCostsSek)} kr`);
  console.log(`  Innehavskostnad:    ${sek(r.holdingCostsSek)} kr`);
  console.log(`  Skatt:              ${sek(r.taxSek)} kr`);
  console.log(
    `  Smak:               ${sek(r.tasteSek)} kr (sol ${pct(r.tasteSunPct)}, nav ${pct(r.tasteHubPct)}, korsdrag ${pct(r.tasteKorsdragPct)}, tyst sovrum ${pct(r.tasteQuietBedroomPct)}, närmaste nav ${r.nearestHub ?? "-"})`,
  );
  // Phase 14.3: the same three cells as the table (same formatters), so the tracked block and the table never disagree.
  const solCells = toFitTableRows({ ranked: [r] }, new Map())[0];
  console.log(`  Sol:                ${solCells.sol} | fri ${solCells.solTheoretical} | med grannhus ${solCells.solObstructed}`);
  console.log(`  Planlösning:        ${formatLayoutSummary(r.layout)}`);
  console.log(`  Vinst:              ${orDash(r.profitSek, sek)} kr`);
  console.log(`  Flaggor:            ${r.flags.map((f) => FIT_FLAG_LABELS[f]).join(", ") || "-"}`);
  console.log(`  Varför här:         ${reasonCell(reasonsOf(r), isReasonFlagged(r.flags))}`);
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
  model: ReturnType<typeof parseHedonicModel>,
  ranking: { ranked: FitScoreResult[]; notComparable: FitScoreResult[]; health: ModelHealth },
  rows: readonly FitInputRow[],
  preRankPositions: ReadonlyMap<string, number>,
  trackId: number,
  tableRows: readonly FitTableRow[],
  reasonsOf: (r: FitScoreResult) => string[],
): void {
  console.log(renderFitSections(tableRows, { maxRows: FIT_TABLE_MAX_ROWS }));
  printTracked(model, trackId, ranking, rows, preRankPositions, reasonsOf);
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

function modelLineOf(model: ReturnType<typeof parseHedonicModel>): string {
  return `Modell per ${model.asOf}: n ${model.n}, R² ${model.r2.toFixed(2)}, storlek ${model.minLivingArea}–${model.maxLivingArea} kvm, renoband ${RENO_BAND}`;
}

function printModelLine(model: ReturnType<typeof parseHedonicModel>): void {
  console.log(modelLineOf(model));
  if (model.note) console.log(`OBS: ${model.note}`);
}

// ---------------------------------------------------------------------------
// Weekly e-mail and memory (WATCH-05, shared by replay and live)
// ---------------------------------------------------------------------------

/** Exit code 3: another run holds watch-state.lock. */
const EXIT_LOCKED = 3;
/** Exit code 4: the e-mail could not be delivered (the HTML is written, the memory is untouched). */
const EXIT_MAIL_FAILED = 4;

/** Today's date as YYYY-MM-DD in Europe/Stockholm (the Monday run belongs to the Swedish date, not UTC). */
function stockholmToday(now: Date = new Date()): string {
  return now.toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
}

/** The memory file the run uses: --state or the default, guarded to the data directory (T-14.2-13). Exits 1 on a bad path. */
function resolveStatePath(args: Args): string {
  const wanted = args.state ?? WATCH_STATE_PATH;
  const safe = guardedDataPath(wanted, { dir: DATA_DIR, ext: ".json" });
  if (safe === null) {
    console.error(`--state måste vara en .json-fil under ${DATA_DIR}/`);
    process.exit(1);
  }
  return safe;
}

/** Presence only, never a value (T-14.2-11). */
function printMailEnvState(): void {
  console.log(`${WATCH_MAIL_ENV.url}: ${process.env[WATCH_MAIL_ENV.url] ? "satt" : "saknas"}`);
  console.log(`${WATCH_MAIL_ENV.to}: ${process.env[WATCH_MAIL_ENV.to] ? "satt" : "saknas"}`);
}

/**
 * The two --dry-run --email lines (W5) after the SMTP lines: the memory and the lock, both read-only
 * (a dry run takes no lock, renames no file and scrapes nothing).
 */
function printWatchDryRun(statePath: string, shownPath: string): void {
  const peek = peekWatchState(statePath);
  if (peek.kind === "missing") console.log(`watch-state: ${shownPath}: saknas (första körningen)`);
  else if (peek.kind === "corrupt") console.log(`watch-state: ${shownPath}: oläsligt (läses som tomt och flyttas åt sidan vid körning)`);
  else console.log(`watch-state: ${shownPath}: ${peek.listings} annonser sedda, senast ${peek.lastSeen ?? "-"}`);
  const lock = readRunLock(lockPathOf(statePath));
  if (lock === null) console.log("Lås: ledigt");
  else if (lock.alive) console.log(`Lås: upptaget av pid ${lock.pid} sedan ${lock.startedAt}`);
  else console.log(`Lås: ledigt (kvarglömt lås från pid ${lock.pid}, tas över)`);
}

/**
 * Takes the run lock next to the memory, or exits 3 with a Swedish message naming the holder (T-14.2-12).
 * The lock is also released on process exit, so a signal-driven exit does not leave it behind.
 */
function takeRunLock(statePath: string): RunLock {
  try {
    const lock = acquireRunLock(lockPathOf(statePath));
    if (lock.warning) console.log(`OBS: ${lock.warning}`);
    process.once("exit", () => lock.release());
    return lock;
  } catch (e) {
    if (e instanceof RunLockedError) {
      console.error(`En annan körning pågår redan (pid ${e.pid}, startad ${e.startedAt}). Den här körningen avbröts; inget skickades och inget ändrades.`);
      process.exit(EXIT_LOCKED);
    }
    throw e;
  }
}

interface WatchEmailRun {
  readonly statePath: string;
  readonly noStateWrite: boolean;
  readonly tableRows: readonly FitTableRow[];
  readonly header: WatchMailInput["header"];
}

/**
 * Diff against the memory, pick the mail rows, deliver, and only then write the memory (WATCH-05).
 * Quiet week: no mail, no file, the pruned memory is saved. Otherwise the HTML goes to
 * <memory dir>/weekly-<date>.html, then SMTP when both variables are set. Sent: the memory
 * is saved. A failed send, or missing SMTP variables, keeps the memory untouched and sets exit code 4
 * (see decideAfterSend; WATCH_MARK_SEEN_WITHOUT_SMTP=1 opts in to marking flats as seen without a mail). Never throws for delivery.
 */
async function runWatchEmail(run: WatchEmailRun): Promise<void> {
  const today = stockholmToday();
  const loaded = loadWatchState(run.statePath);
  if (loaded.warning) console.log(`OBS: ${loaded.warning}`);
  const firstRun = isFirstRun(loaded.state);
  const diff = diffRun(loaded.state, run.tableRows, today);
  const sections = selectMailRows({ rows: run.tableRows, diff, firstRun, perSectionFirstRun: WATCH_FIRST_MAIL_PER_SECTION });
  const mailed = [...sections.under, ...sections.over];
  const nNew = mailed.filter((m) => m.status === "new").length;
  const nChanged = mailed.length - nNew;
  const nextState = pruneStale(diff.next, today);

  const saveState = (): void => {
    if (run.noStateWrite) {
      console.log("Bevakningsminnet skrevs inte (--no-state-write).");
      return;
    }
    try {
      saveWatchState(run.statePath, nextState);
    } catch (e) {
      console.error(`FEL: bevakningsminnet kunde inte skrivas: ${e instanceof Error ? e.message : String(e)} (nästa körning kan skicka samma sak igen)`);
      process.exitCode = 1;
    }
  };

  if (mailed.length === 0) {
    console.log("inget nytt: 0 nya, 0 prisändrade, ingen e-post");
    saveState();
    return;
  }

  const mail: WatchMailInput = {
    date: today,
    sections,
    header: {
      ...run.header,
      note: firstRun
        ? `Första körningen (bevakningsminnet var tomt): de ${WATCH_FIRST_MAIL_PER_SECTION} främsta annonserna i varje avsnitt visas, alla markerade som nya. Härifrån visas bara nya och prisändrade annonser.`
        : null,
    },
    counts: { nNew, nChanged },
  };
  const subject = watchSubject(today, nNew, nChanged);
  const html = renderWatchHtml(mail);
  const text = renderWatchText(mail);
  const htmlFile = join(dirname(run.statePath), `weekly-${today}.html`);
  const htmlPath = relative(process.cwd(), htmlFile) || htmlFile;
  try {
    writeTextAtomic(htmlFile, html);
  } catch (e) {
    console.error(`E-post ej skickad: HTML kunde inte skrivas till ${htmlPath}: ${e instanceof Error ? e.message : String(e)}; bevakningsminnet uppdateras inte`);
    process.exitCode = EXIT_MAIL_FAILED;
    return;
  }

  const result = await sendWatchMail({ subject, text, html });
  // WR-03: only a delivered mail (or the explicit WATCH_MARK_SEEN_WITHOUT_SMTP=1) marks the flats as seen.
  const decision = decideAfterSend(result, { nNew, nChanged, htmlPath });
  if (decision.log.level === "error") console.error(decision.log.text);
  else console.log(decision.log.text);
  if (decision.saveMemory) saveState();
  if (decision.exitCode !== 0) process.exitCode = decision.exitCode;
}

// ---------------------------------------------------------------------------
// Sol (Phase 14.3): the OSM map and the sun stage, shared by replay and live
// ---------------------------------------------------------------------------

/** Where the map comes from: the --osm file (read only, no refresh) or the cache. */
type SunSourceChoice = { kind: "file"; path: string } | { kind: "cache" };

const DAY_MS = 86_400_000;
const days1 = (d: number): string => d.toFixed(1).replace(".", ",");

/** Age of the cache in days, never negative; null when there is no usable cache. */
function cacheAgeDays(meta: OsmCacheMeta | null, now: Date): number | null {
  if (meta === null) return null;
  const fetched = Date.parse(meta.fetchedAt);
  return Number.isNaN(fetched) ? null : Math.max(0, (now.getTime() - fetched) / DAY_MS);
}

type SunIndexLoad =
  | { readonly index: OsmIndex; readonly meta: OsmCacheMeta | null; readonly buildMs: number }
  | { readonly index: null; readonly failure: string };

/**
 * Reads the map and builds the index. Never throws: a missing, unreadable or invalid file comes back as
 * `failure` ("saknas (filen finns inte)", "ogiltig (<first issue>)"), so the run fails closed to "okänd" out loud (T-14.3-01).
 */
function loadSunIndex(source: SunSourceChoice): SunIndexLoad {
  const t0 = performance.now();
  let raw: unknown;
  let meta: OsmCacheMeta | null = null;
  if (source.kind === "cache") {
    const loaded = loadOsmCacheRaw(OSM_CACHE_PATH);
    if ("error" in loaded) return { index: null, failure: osmCacheFailureText(loaded.error) };
    raw = loaded.raw;
    meta = loaded.meta;
  } else {
    try {
      raw = JSON.parse(readFileSync(resolve(source.path), "utf8"));
    } catch (e) {
      return { index: null, failure: e instanceof SyntaxError ? "ogiltig (JSON)" : "saknas (oläsbar)" };
    }
  }
  try {
    const index = buildOsmIndex(parseOsmExtract(raw));
    return { index, meta, buildMs: performance.now() - t0 };
  } catch (e) {
    const issue = (e instanceof Error ? e.message : String(e)).replace(/^Invalid OSM extract: /, "").split("; ")[0];
    return { index: null, failure: `ogiltig (${issue})` };
  }
}

/** The one "Sol: ..." line that says which map the run used (or why it used none). */
function sunSourceLine(source: SunSourceChoice, load: SunIndexLoad, mode: "replay" | "live", now: Date): string {
  const name = source.kind === "file" ? `OSM-utdrag ${source.path}` : "OSM-cache";
  if (load.index === null) {
    // An unusable cache is not downloaded again for 31 days unless the refresh rule sees it; say how to fix it by hand.
    const hint = source.kind === "cache" ? "; kör: npx tsx scripts/osm-download.ts --force" : "";
    return mode === "replay"
      ? `Sol: ${name} ${load.failure}, solfakta från snapshoten${hint}`
      : `Sol: ${name} ${load.failure}, alla annonser får okänd sol${hint}`;
  }
  // CR-01: a bad height tag is replaced by an estimate; the count makes a bad import visible in every run.
  const counts = `${load.index.buildings.length} byggnader, ${load.index.roadsByName.size} gator, höjd orimlig ${suspectHeights(load.index).length} (ersatt med uppskattning)`;
  if (source.kind === "file") return `Sol: ${name} (${counts})`;
  const age = cacheAgeDays(load.meta, now);
  const where = `${age === null ? "okänd" : days1(age)} dagar gammal (OSM-tid ${load.meta?.osmBase ?? "?"}), ${counts}`;
  return mode === "replay" ? `Sol: OSM-cache ${where}; ingen hämtning i uppspelning` : `Sol: OSM-cache ${where}`;
}

/**
 * The floor-plan bearing of a row, from the floor-plan cache only (the weekly run never calls the model for this).
 * While the route is closed (FLOORPLAN_ROUTE_ENABLED false, plan 14.3-03) it is always null and the cache file is not read.
 */
function makePlanOf(): (row: FitInputRow) => PlanBearing | null {
  if (!FLOORPLAN_ROUTE_ENABLED) return () => null;
  let cache: FloorPlanCache | null = null;
  return (row) => {
    if (cache === null) {
      const loaded = loadFloorPlanCache(FLOORPLAN_CACHE_PATH);
      if (loaded.warning) console.log(`OBS: ${loaded.warning}`);
      cache = loaded.cache;
    }
    // The first Booli image is the floor plan for most flats (research); a cache entry exists only for allowed hosts.
    const url = row.candidate.imageUrls?.[0];
    if (url === undefined) return null;
    const entry = cache.entries[floorPlanImageId(url)];
    if (!entry || entry.promptVersion !== FLOORPLAN_PROBE_VERSION) return null;
    const bearingDeg = planBearingOf(entry.result);
    return bearingDeg === null ? null : { bearingDeg, confidence: entry.result.confidence };
  };
}

interface SunStage {
  /** Pure and offline; counts its own calls and time. */
  readonly sunOf: (row: FitInputRow) => SunFact | null;
  /** SUN-03: the index build plus every sunOf call so far. */
  readonly timingLine: () => string;
}

/**
 * With no index every row gets the okänd fact with `noIndexReason` (WR-05: "OSM-cache saknas", "ogiltig" or "oläsbar",
 * from the load failure, not always "saknas"); otherwise the fact comes from computeSunFact.
 */
function makeSunStage(index: OsmIndex | null, buildMs: number, noIndexReason: string = "OSM-cache saknas"): SunStage {
  const planOf = makePlanOf();
  let calls = 0;
  let ms = buildMs;
  return {
    sunOf: (row) => {
      const t0 = performance.now();
      try {
        if (index === null) return unknownSunFact(noIndexReason);
        const c = row.candidate;
        // WR-03: one bad geometry must not abort the run after the paid vision calls; the flat becomes okänd (fel).
        const { fact, failure } = computeSunFactSafe(
          index,
          {
            lat: c.latitude,
            lng: c.longitude,
            address: c.address,
            floor: c.floor ?? row.facts?.floor ?? null,
            candidateOrientation: c.orientation,
            factsFacades: row.facts?.orientationFacades ?? null,
          },
          { plan: () => planOf(row) },
        );
        if (failure !== null) console.log(`OBS: sol kunde inte beräknas för ${c.address ?? "en annons"} (${failure}); okänd (${SUN_FAILURE_REASON}), körningen fortsätter`);
        return fact;
      } finally {
        calls += 1;
        ms += performance.now() - t0;
      }
    },
    timingLine: () => `Sol: beräknat för ${calls} rader på ${Math.round(ms)} ms`,
  };
}

/** The sun report block over the comparable ranked flats in innerstan order (Phase 14.3, SUN-05). */
function sunReportOf(ranked: readonly FitScoreResult[]): string {
  return renderSunReport(
    ranked.map((r) => ({ address: r.address, sun: r.sun })),
    { probeSummary: FLOORPLAN_PROBE_SUMMARY, routeEnabled: FLOORPLAN_ROUTE_ENABLED },
  );
}

/** The first line of an OSM-cache decision: how old it is, or that it is missing. */
function osmCacheDescribe(meta: OsmCacheMeta | null, now: Date): string {
  const age = cacheAgeDays(meta, now);
  return meta === null ? "saknas" : age === null ? "okänd ålder" : `${days1(age)} dagar gammal`;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/** The absolute path a `--json` value may write to, or null when it is outside the allowed roots or not a .json file. */
function runRecordPathOf(path: string): string | null {
  for (const root of RUN_RECORD_ROOTS) {
    const abs = guardedDataPath(path, { dir: join(process.cwd(), root), ext: ".json" });
    if (abs !== null) return abs;
  }
  return null;
}

async function runReplay(args: Args): Promise<void> {
  // --email: the lock is taken before anything else, exactly as in a live run (exit 3 when another run holds it).
  const statePath = args.email ? resolveStatePath(args) : null;
  const lock = statePath === null ? null : takeRunLock(statePath);
  try {
    await runReplayInner(args, statePath);
  } finally {
    lock?.release();
  }
}

async function runReplayInner(args: Args, statePath: string | null): Promise<void> {
  const snapshotPath = resolve(args.replay as string);
  if (!existsSync(snapshotPath)) {
    console.error(`Snapshotfil saknas: ${args.replay}`);
    process.exit(1);
  }
  const snapshot = parseFitSnapshot(JSON.parse(readFileSync(snapshotPath, "utf8")));
  const model = loadModel(args.model);

  // Phase 14.3: every row gets its sun fact from the map BEFORE ranking, so taste, the table and the coverage see it.
  // A replay never downloads: with no usable map the snapshot's stored sun is kept and the line says so.
  const source: SunSourceChoice = args.osm !== null ? { kind: "file", path: args.osm } : { kind: "cache" };
  const sunLoad = loadSunIndex(source);
  const solLines: string[] = [sunSourceLine(source, sunLoad, "replay", new Date())];
  let rows = snapshot.rows;
  if (sunLoad.index !== null) {
    const stage = makeSunStage(sunLoad.index, sunLoad.buildMs);
    rows = snapshot.rows.map((row) => ({ ...row, sun: stage.sunOf(row) }));
    solLines.push(stage.timingLine());
  }

  const ranking = rankFit(rows, model);

  // 14.4-01 (R-05): freeze the ranking as a machine-readable record. Written before anything is printed;
  // the table below is unchanged by it.
  const recordPath = args.json === null ? null : runRecordPathOf(args.json);
  if (recordPath !== null) {
    writeJsonAtomic(
      recordPath,
      fitRunRecordOf({
        snapshotAsOf: snapshot.asOf,
        snapshotFile: relative(process.cwd(), snapshotPath),
        model,
        sunLine: solLines[0],
        ranking,
      }),
    );
  }

  // The free pre-rank is recomputed from the stored rows (their detail-page
  // facts are included, so it can differ slightly from the live run's own).
  const preRankPositions = new Map<string, number>();
  for (const p of preRank(rows, model).ranked) preRankPositions.set(fitRowKey(p.row.candidate), p.position);

  printModelLine(model);
  console.log(
    `Snapshot per ${snapshot.asOf}: ${rows.length} rader, ${ranking.ranked.length} jämförbara, ${ranking.notComparable.length} ej jämförbara (förrank räknat om från snapshoten)`,
  );
  for (const line of solLines) console.log(line);
  console.log("");
  const reasonsOf = makeReasonsOf(rows, ranking.ranked, model);
  const tableRows = toFitTableRows(ranking, preRankPositions, { reasonsOf });
  printRanking(model, ranking, rows, preRankPositions, args.track, tableRows, reasonsOf);
  const coverageLine = renderCoverage(withReasonsOnFlagged(coverageOfRows(rows, model), tableRows));
  console.log(`\n${coverageLine}`);
  console.log(tasteCapLine(ranking.ranked));
  console.log(residualCountLine(ranking.ranked, model));
  console.log(sunReportOf(ranking.ranked));
  if (recordPath !== null) console.log(`Körningspost: ${relative(process.cwd(), recordPath)}`);

  if (statePath !== null) {
    console.log("");
    printMailEnvState();
    await runWatchEmail({
      statePath,
      noStateWrite: args.noStateWrite,
      tableRows,
      // A replay measured no candidate list, so it says so instead of claiming "komplett".
      header: { completeness: "Kandidatlista: ej mätt (uppspelning av en sparad snapshot)", incomplete: false, coverageLine, modelLine: modelLineOf(model) },
    });
  }
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
  visionLine: string | null,
  visionSek: number,
  layoutSek: number,
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
  if (visionLine !== null) console.log(visionLine);
  console.log(`  Anthropic (bildtolkning): ${visionSek.toFixed(2)} kr`);
  console.log(`  Anthropic (planlösning): ${layoutSek.toFixed(2)} kr`);
  console.log(`  Totalt: ${sek(apifyUsd * USD_SEK_RATE + visionSek + layoutSek)} kr`);
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

  const outPath = guardedDataPath(args.out ?? `${DATA_DIR}/forsale-snapshot-${new Date().toISOString().slice(0, 10)}.json`, {
    dir: DATA_DIR,
    ext: ".json",
  });
  if (outPath === null) {
    console.error(`--out måste vara en .json-fil under ${DATA_DIR}/`);
    process.exit(1);
  }
  const model = loadModel(args.model);
  const statePath = args.email ? resolveStatePath(args) : null;

  // Preflight. Presence only, never a value.
  const apifyState = process.env[APIFY_ENV] ? "satt" : "saknas";
  const anthropicState = process.env[ANTHROPIC_ENV] ? "satt" : "saknas";
  console.log(`${APIFY_ENV}: ${apifyState}`);
  console.log(`${ANTHROPIC_ENV}: ${anthropicState}`);
  // R-03: the local browser needs no Apify token. Only the paid modes do.
  if (apifyState === "saknas" && (!localMode || args.allowApify)) process.exit(1);
  if (args.noVision) console.log("Bildtolkning: avstängd (--no-vision)");
  else if (anthropicState === "saknas") console.log("Bildtolkning hoppas över: nyckel saknas");
  // A weekly table without picture reading is not trustworthy (WATCH-05): --email needs the key, or an explicit --no-vision.
  if (args.email && !args.noVision && anthropicState === "saknas") {
    console.error(`FEL: --email kräver ${ANTHROPIC_ENV} (bildtolkning ingår i veckotabellen). Sätt nyckeln i ~/.zshenv eller ange --no-vision.`);
    process.exit(1);
  }

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
  // W5: after the renderer line, the env presence lines and the skipped-check lines, before the dry-run return.
  if (statePath !== null) {
    printMailEnvState();
    if (args.dryRun) printWatchDryRun(statePath, args.state ?? WATCH_STATE_PATH);
  }
  // Phase 14.3 (SUN-05, R-05): the weekly run goes to Overpass only when the map is missing or 31 days old.
  // A dry run prints the decision and never downloads.
  const sunSource: SunSourceChoice = args.osm !== null ? { kind: "file", path: args.osm } : { kind: "cache" };
  const osmMeta = sunSource.kind === "cache" ? readOsmCacheMeta(OSM_CACHE_PATH) : null;
  const osmDecisionAt = new Date();
  const osmNeedsRefresh = sunSource.kind === "cache" && osmCacheNeedsRefresh(osmMeta, osmDecisionAt);
  if (args.dryRun) {
    if (sunSource.kind === "file") console.log(`OSM-utdrag: ${sunSource.path}, ingen hämtning`);
    else if (osmNeedsRefresh) console.log(`OSM-cache: ${osmCacheDescribe(osmMeta, osmDecisionAt)}, hämtas vid riktig körning (gratis)`);
    else console.log(renderOsmCacheLine({ action: "fresh", ageDays: cacheAgeDays(osmMeta, osmDecisionAt), meta: osmMeta }));
    console.log(localMode ? "--dry-run: förkontrollerna är klara, ingen webbläsare startades." : "--dry-run: förkontrollerna är klara, ingen betald körning startades.");
    return;
  }

  if (sunSource.kind === "cache") {
    if (osmNeedsRefresh) {
      // The one place the Overpass client is loaded (a replay and a dry run never get here).
      const overpass = await import("@/lib/discovery/osm-overpass");
      const refreshed = await refreshOsmCacheIfStale({
        path: OSM_CACHE_PATH,
        now: new Date(),
        force: false,
        download: () =>
          overpass.downloadOsmExtract({
            fetchImpl: (url, init) => globalThis.fetch(url, init),
            sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
            now: () => new Date(),
            log: (line) => console.log(line),
          }),
      });
      console.log(refreshed.message);
    } else {
      console.log(renderOsmCacheLine({ action: "fresh", ageDays: cacheAgeDays(osmMeta, osmDecisionAt), meta: osmMeta }));
    }
  }
  const sunLoad = loadSunIndex(sunSource);
  console.log(sunSourceLine(sunSource, sunLoad, "live", new Date()));
  const sunStage = makeSunStage(sunLoad.index, sunLoad.index === null ? 0 : sunLoad.buildMs, sunLoad.index === null ? osmCacheUnknownReason(sunLoad.failure) : undefined);

  const { fetchAreaListings, HEADLESS_MAX_AREA_PAGES } = await import("@/lib/booli/client");
  const { enrichAllCandidates } = await import("@/lib/discovery/watch-enrich");
  const vision = await import("@/lib/discovery/vision");

  const asOf = new Date().toISOString().slice(0, 10);
  const visionActive = anthropicState === "satt" && !args.noVision;
  // The cache is read only when pictures will be read (a --no-vision run never touches the file).
  const loadedCache = visionActive ? loadVisionCache(VISION_CACHE_PATH) : null;
  if (loadedCache?.warning) console.log(`OBS: ${loadedCache.warning}`);
  const visionCache = loadedCache?.cache ?? { version: 1 as const, entries: {} };
  let visionStats: VisionChunksResult | null = null;
  let cacheSaveError: string | null = null;
  // Phase 14.4 (LAY-01, R-07): the layout read runs only when the picture read does (key set and not --no-vision).
  // Its modules are loaded by dynamic import here, so a replay and a dry run never reach the SDK.
  const layoutMods = visionActive
    ? {
        read: await import("@/lib/discovery/layout-read"),
        call: await import("@/lib/discovery/layout-call"),
        sdk: await import("@anthropic-ai/sdk"),
      }
    : null;
  const loadedLayoutCache = layoutMods === null ? null : layoutMods.read.loadLayoutCache(layoutMods.read.LAYOUT_CACHE_PATH);
  if (loadedLayoutCache?.warning) console.log(`OBS: ${loadedLayoutCache.warning}`);
  let layoutSpentSek = 0;
  let layoutCacheSaveError: string | null = null;
  if (layoutMods === null) console.log("Planlösning: avstängd (ingen bildtolkning)");
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
    // Picture reading for every candidate (D-06, R-09): 3 parallel lanes of at most 60 / 3 SEK each, flats already
    // read with the same picture set come from the cache. --no-vision (or no key) turns it off entirely.
    vision: visionActive
      ? async (candidates, opts) => {
          const run = await runVisionChunks(candidates, {
            brokerImagesOf: opts.brokerImagesOf,
            cache: visionCache,
            runPass: (cs, o) => vision.runVisionPass(cs, o),
            capSekTotal: HEADLESS_VISION_CAP_SEK,
            chunks: HEADLESS_VISION_CHUNKS,
            keyOf: (c) => listingPathOf(c.sourceListingUrl),
            today: asOf,
          });
          visionStats = run;
          // Saved right here, before ranking and printing, so a paid result survives any later failure.
          try {
            saveVisionCache(VISION_CACHE_PATH, run.cacheNext);
          } catch (e) {
            cacheSaveError = e instanceof Error ? e.message : String(e);
          }
          return run.candidates;
        }
      : async (candidates) => candidates,
    // Phase 14.3: the sun fact for every row, from the cached map, before ranking.
    sunOf: sunStage.sunOf,
    // Phase 14.4 (LAY-01, R-07): the layout read right after the picture read, on the same candidates and the same
    // in-memory broker photos. Capped at LAYOUT_RUN_CAP_SEK per run, cached per flat and picture set, saved at once.
    // The key is read from the environment by the SDK and never printed.
    layout:
      layoutMods === null || loadedLayoutCache === null
        ? undefined
        : async (candidates, opts) => {
            const { read: layoutRead, call: layoutCall, sdk } = layoutMods;
            const run = await layoutRead.runLayoutReads(
              candidates.map((c, i) => {
                const listingPath = listingPathOf(c.sourceListingUrl);
                return {
                  listingPath: listingPath ?? `/okänd/${i}`,
                  // No parseable listing URL means no stable cache key: such a flat is not read (the runner reports "no_plan").
                  imageUrls: listingPath === null ? [] : (c.imageUrls ?? []),
                  brokerImages: opts.brokerImagesOf(c, i),
                };
              }),
              {
                call: layoutCall.makeLayoutCall(new sdk.default()),
                cache: loadedLayoutCache.cache,
                runCapSek: layoutRead.LAYOUT_RUN_CAP_SEK,
                today: asOf,
              },
            );
            layoutSpentSek = run.spentSek;
            // Saved right here, before ranking and printing, so a paid result survives any later failure.
            try {
              layoutRead.saveLayoutCache(layoutRead.LAYOUT_CACHE_PATH, run.cacheNext);
            } catch (e) {
              layoutCacheSaveError = e instanceof Error ? e.message : String(e);
            }
            console.log(layoutSpendLine(run, layoutRead.LAYOUT_RUN_CAP_SEK));
            return run.reads.map((r) =>
              (r.status === "read" || r.status === "cache") && r.result !== null
                ? layoutRead.layoutFactFromRead(r.result, {
                    version: layoutRead.LAYOUT_READ_VERSION,
                    booli: r.images.booli,
                    broker: r.images.broker,
                  })
                : null,
            );
          },
  };

  // The run lock next to the memory, before anything is scraped (exit 3 when another run holds it).
  const lock = statePath === null ? null : takeRunLock(statePath);

  // Local mode: install the headed-Chromium renderer into transport.ts. From here every Booli read in
  // this process (scrape, detail, vision enrichment) goes through it; Apify is touched only by an
  // explicit --allow-apify fallback. Nothing may process.exit past this point: the browser must close.
  const handle = localMode
    ? localBrowser.installLocalRenderer({ allowApify: args.allowApify, apifyMaxRenders: args.apifyMaxRenders })
    : null;
  const disposeSignals = handle ? localBrowser.closeOnSignals(handle) : null;
  // WR-01: a run that hangs where no per-page timeout reaches must still end by itself (releases the lock on exit).
  const disposeWatchdog = handle ? localBrowser.armRunWatchdog(handle) : null;
  const ledger = (): LocalLedger | null => (handle ? { stats: handle.stats(), apifyMaxRenders: args.apifyMaxRenders } : null);
  /** The pinned spend line; null when pictures were not read this run. With no candidate at all it is the zero line. */
  const visionLineOf = (): string | null => {
    if (!visionActive) return null;
    const v = visionStats as VisionChunksResult | null;
    return renderVisionLine({
      calls: v?.calls ?? 0,
      cacheHits: v?.cacheHits ?? 0,
      skipped: v?.skipped ?? 0,
      spentSek: v?.spentSek ?? 0,
      chunkSizes: v?.chunkSizes ?? Array.from({ length: HEADLESS_VISION_CHUNKS }, () => 0),
    });
  };

  /** The vision spend to print: what the vision lanes paid, failed-but-billed calls included (WR-08). */
  const visionSekOf = (result: FitPipelineResult): number => (visionStats as VisionChunksResult | null)?.spentSek ?? result.visionSek;
  /** What the layout reads paid in this run, failed-but-billed calls included. */
  const layoutSekOf = (): number => layoutSpentSek;

  try {
    const t0 = new Date();
    console.log(`\nStart: ${t0.toISOString()}`);
    const result = await runFitPipeline(deps, { model, asOf, window });

    printModelLine(model);
    console.log(renderAreaReport(result.areas));
    const everyDistrictFailed = result.areas.length > 0 && result.areas.every((a) => !a.ok);
    if (everyDistrictFailed) {
      console.error("\nFEL: alla distrikt misslyckades, ingen snapshot skrevs.");
      await printSpend(t0, result, transport, ledger(), visionLineOf(), visionSekOf(result), layoutSekOf());
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
    console.log(sunStage.timingLine());
    console.log(`\n${renderWindowReport(result)}`);
    const reasonsOf = makeReasonsOf(result.snapshot.rows, result.ranking.ranked, model);
    const tableRows = toFitTableRows(result.ranking, result.preRankPositions, { reasonsOf });
    console.log(`\n${renderCoverage(withReasonsOnFlagged(result.coverage, tableRows))}`);
    console.log(tasteCapLine(result.ranking.ranked));
    console.log(residualCountLine(result.ranking.ranked, model));
    if (result.brfStats !== null) console.log(renderBrfLine(result.brfStats));
    console.log(sunReportOf(result.ranking.ranked));
    console.log("");
    printRanking(model, result.ranking, result.snapshot.rows, result.preRankPositions, args.track, tableRows, reasonsOf);
    await printSpend(t0, result, transport, ledger(), visionLineOf(), visionSekOf(result), layoutSekOf());
    if (cacheSaveError !== null) {
      console.error(`\nFEL: bildcachen kunde inte skrivas till ${VISION_CACHE_PATH}: ${cacheSaveError} (nästa körning betalar för samma annonser igen)`);
      process.exitCode = 1;
    }
    if (layoutCacheSaveError !== null) {
      console.error(`\nFEL: layoutcachen kunde inte skrivas: ${layoutCacheSaveError} (nästa körning betalar för samma annonser igen)`);
      process.exitCode = 1;
    }
    if (writeError === null) {
      console.log(`\nSnapshot skriven: ${outPath}`);
    } else {
      console.error(`\nFEL: snapshoten kunde inte skrivas till ${outPath}: ${writeError}`);
      process.exitCode = 1;
    }

    if (statePath !== null) {
      console.log("");
      await runWatchEmail({
        statePath,
        noStateWrite: args.noStateWrite,
        tableRows,
        header: {
          // The last line of the area report is the pinned "Kandidatlista: ..." line.
          completeness: renderAreaReport(result.areas).split("\n").pop() ?? "Kandidatlista: okänd",
          incomplete: result.areas.length === 0 || incompleteDistricts(result.areas).length > 0,
          coverageLine: renderCoverage(withReasonsOnFlagged(result.coverage, tableRows)),
          modelLine: modelLineOf(model),
        },
      });
    }
  } finally {
    lock?.release();
    disposeWatchdog?.();
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
  // 14.3: an --osm file is read in both modes, so a wrong path stops the run before anything else happens.
  if (args.osm !== null && !existsSync(resolve(args.osm))) {
    console.error(`OSM-utdrag saknas: ${args.osm}`);
    process.exit(1);
  }
  // 14.4-01 (T-14.4-01): a --json path is a write target, so it is checked before any work happens.
  if (args.json !== null && runRecordPathOf(args.json) === null) {
    console.error(`--json måste ligga under ${RUN_RECORD_ROOTS.map((r) => `${r}/`).join(" eller ")} och sluta på .json`);
    process.exit(1);
  }
  if (args.replay !== null) await runReplay(args);
  else await runLive(args);
}

main().catch((e) => {
  console.error("FEL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
