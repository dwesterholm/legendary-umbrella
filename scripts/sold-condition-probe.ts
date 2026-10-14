/**
 * Sold-photo condition probe (Phase 14.4, BID-01, D-12, R-08). The paid modes are GATED: no call at all unless
 * RUN_LLM_EVALS=1, and the whole read can never pass 30 kr in total (a lifetime ledger in its own cache file).
 *
 *   RUN_LLM_EVALS=1 npx tsx scripts/sold-condition-probe.ts --smoke
 *   RUN_LLM_EVALS=1 npx tsx scripts/sold-condition-probe.ts --read --n 300
 *   npx tsx scripts/sold-condition-probe.ts --branch-report
 *
 * What it answers: can Anthropic still fetch the photos of a SOLD Booli flat (the URL is built from the photo id and
 * nobody has tried it on a sold listing), does the two-field strict-output schema compile against the live API (an
 * HTTP 400 means too heavy; mocked unit tests cannot see that), and so: can the bid premium be fitted on condition
 * (branch "fit") or must it stay at the prior 0 with the label "skick ej mätt" (branch "prior", R-08)?
 *
 *   --smoke          The first 5 flats of the stratified 300-row sample, read live under a run cap of
 *                    min(1 kr, what is left of the 30 kr lifetime budget). The cache is saved whatever happened, so a
 *                    billed failure stays in the ledger. Writes evidence/sold-condition-smoke.json (counts, enums and
 *                    error classes only: no picture URL). With no eligible sold flat it writes the evidence with
 *                    attempted 0 and makes no call.
 *   --read --n <n>   Reads up to n flats of the sample under the 30 kr LIFETIME cap (plan 10), saving the cache after
 *                    every 10 flats. Flats already in the cache cost nothing.
 *   --branch-report  No call and no RUN_LLM_EVALS needed: counts the eligible sold flats (read under the v2 shape,
 *                    at least one photo id, an asking price), reads the smoke evidence if there is one, applies the
 *                    R-08 rule and writes evidence/bid-branch.md with one line "Gren: fit" or "Gren: prior (<skäl>)".
 *
 * Gate: without RUN_LLM_EVALS=1 the paid modes print "Hoppar över: RUN_LLM_EVALS=1 krävs för betalda anrop" and exit 0
 * before any client exists. With it, a missing ANTHROPIC_API_KEY exits 1 (presence only is printed, never a value).
 *
 * Logs carry the counts, the enum and the spend; never a picture URL, never a key. Errors are printed as the class
 * name and the HTTP status only (a message can carry request details). Images are never downloaded or stored.
 */
import { existsSync, readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { slutprisCacheSchema, SOLD_DETAIL_VERSION, type SoldRow } from "@/lib/booli/slutpriser";
import { guardedDataPath, readJsonIfExists, writeJsonAtomic, writeTextAtomic } from "@/lib/discovery/json-store";
import {
  SOLD_CONDITION_CACHE_PATH,
  SOLD_CONDITION_CAP_SEK,
  SOLD_CONDITION_MIN_CONFIDENCE,
  SOLD_CONDITION_MIN_ELIGIBLE,
  SOLD_CONDITION_MODEL,
  SOLD_CONDITION_SAMPLE_N,
  SOLD_CONDITION_SMOKE_MIN_READ,
  SOLD_CONDITION_SMOKE_N,
  SOLD_CONDITION_VERSION,
  SoldConditionCallError,
  isConditionEligible,
  loadSoldConditionCache,
  runSoldConditionReads,
  saveSoldConditionCache,
  selectConditionSample,
  soldConditionBranch,
  soldConditionSpentSek,
  type SoldConditionCache,
  type SoldConditionCallFn,
  type SoldConditionOutcome,
} from "@/lib/discovery/sold-condition";
import { makeSoldConditionCall } from "@/lib/discovery/sold-condition-call";
import { formatSek } from "@/lib/discovery/sun-floorplan";

const SOLD_CACHE_PATH = ".planning/calibration/data/slutpriser-cache.json";
const EVIDENCE_DIR = ".planning/phases";
const EVIDENCE_JSON = ".planning/phases/14.4-valuation-layout-livability/evidence/sold-condition-smoke.json";
const BRANCH_MD = ".planning/phases/14.4-valuation-layout-livability/evidence/bid-branch.md";
/** The smoke cap, SEK (D-17). */
const SMOKE_CAP_SEK = 1;
/** The cache is saved after this many flats in --read. */
const SAVE_EVERY = 10;

const USAGE = `Användning (betalt, kräver RUN_LLM_EVALS=1, aldrig mer än ${formatSek(SOLD_CONDITION_CAP_SEK)} kr sammanlagt):
  RUN_LLM_EVALS=1 npx tsx scripts/sold-condition-probe.ts --smoke
  RUN_LLM_EVALS=1 npx tsx scripts/sold-condition-probe.ts --read --n <antal>
Rapport (gratis, inget anrop, kräver inte RUN_LLM_EVALS):
  npx tsx scripts/sold-condition-probe.ts --branch-report

  --smoke          Läser de första ${SOLD_CONDITION_SMOKE_N} sålda lägenheterna i urvalet (högst ${formatSek(SMOKE_CAP_SEK)} kr) och skriver bevisfilen
  --read --n <n>   Läser upp till n lägenheter i urvalet om ${SOLD_CONDITION_SAMPLE_N}, sparar cachen var ${SAVE_EVERY}:e
  --branch-report  Räknar säljfotona, läser smoketestets bevis och skriver bid-branch.md med grenen fit eller prior
Utan RUN_LLM_EVALS=1 görs inget anrop. Slutkoder: 0 klart eller överhoppat, 1 fel.`;

interface Args {
  smoke: boolean;
  read: boolean;
  n: number | null;
  branchReport: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args | null {
  const out: Args = { smoke: false, read: false, n: null, branchReport: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--help" || flag === "-h") out.help = true;
    else if (flag === "--smoke") out.smoke = true;
    else if (flag === "--read") out.read = true;
    else if (flag === "--branch-report") out.branchReport = true;
    else if (flag === "--n" && value !== undefined) {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) return null;
      out.n = n;
      i++;
    } else return null;
  }
  // Exactly one mode; --n belongs to --read only.
  const modes = [out.smoke, out.read, out.branchReport].filter(Boolean).length;
  if (!out.help && modes !== 1) return null;
  if (out.n !== null && !out.read) return null;
  if (out.read && out.n === null) return null;
  return out;
}

/** The HTTP status of an SDK error, or null. */
const httpStatusOf = (error: unknown): number | null => {
  const status = error instanceof Error ? (error as { status?: unknown }).status : undefined;
  return typeof status === "number" ? status : null;
};

/** An SDK error reduced to its class name and HTTP status; the message can carry request details, so it is never printed. */
function safeError(error: unknown): string {
  if (error instanceof SoldConditionCallError) return error.code;
  if (error instanceof Error) {
    const status = httpStatusOf(error);
    return status !== null ? `${error.name} (HTTP ${status})` : error.name;
  }
  return "UNKNOWN";
}

/**
 * Sorts a failed call into "the schema was refused" and "the picture could not be fetched". Both come back as HTTP 400,
 * so the SDK message is MATCHED here (never printed or stored): a message about downloading or fetching an image or a
 * URL is a picture problem, any other 400 is read as the grammar being too heavy.
 */
type FailureKind = "http_400" | "image_fetch_failed" | "other_error";
function failureKindOf(error: unknown): FailureKind {
  const status = httpStatusOf(error);
  if (status === 400) {
    const message = error instanceof Error ? error.message : "";
    const picture = /(download|fetch|retriev|access|timeout).{0,60}(image|url|file|media)|(image|url|file|media).{0,60}(download|fetch|retriev|access|timeout)/i;
    return picture.test(message) ? "image_fetch_failed" : "http_400";
  }
  if (status === 404 || status === 403) return "image_fetch_failed";
  return "other_error";
}

function loadSoldRows(): SoldRow[] {
  const raw = readJsonIfExists(SOLD_CACHE_PATH);
  if (raw === null) throw new Error(`Cachen med sålda lägenheter saknas: ${SOLD_CACHE_PATH}`);
  return slutprisCacheSchema.parse(raw).rows;
}

const countBy = <T extends string>(values: readonly T[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
};

function conditionsOf(reads: readonly SoldConditionOutcome[]): Record<string, number> {
  const base: Record<string, number> = { dated: 0, ok: 0, fresh: 0 };
  for (const r of reads) if (r.result) base[r.result.condition] = (base[r.result.condition] ?? 0) + 1;
  return base;
}

function writeEvidence(evidence: Record<string, unknown>): void {
  const safe = guardedDataPath(EVIDENCE_JSON, { dir: EVIDENCE_DIR, ext: ".json" });
  if (safe === null) throw new Error(`Bevisfilen får bara skrivas under ${EVIDENCE_DIR}/`);
  writeJsonAtomic(safe, evidence);
}

async function smoke(realCall: SoldConditionCallFn, today: string): Promise<number> {
  const sample = selectConditionSample(loadSoldRows(), SOLD_CONDITION_SAMPLE_N).slice(0, SOLD_CONDITION_SMOKE_N);
  const { cache, warning } = loadSoldConditionCache(SOLD_CONDITION_CACHE_PATH);
  if (warning) console.log(warning);
  const remaining = Math.max(0, SOLD_CONDITION_CAP_SEK - soldConditionSpentSek(cache));

  if (sample.length === 0) {
    writeEvidence({
      date: today,
      version: SOLD_CONDITION_VERSION,
      model: SOLD_CONDITION_MODEL,
      attempted: 0,
      read: 0,
      failed: 0,
      statuses: [],
      errorCodes: [],
      spentSek: 0,
      totalSpentSek: Number(soldConditionSpentSek(cache).toFixed(4)),
      grammar: "other_error",
      conditions: { dated: 0, ok: 0, fresh: 0 },
      note: "inga sålda lägenheter med bild-id och utgångspris att läsa",
    });
    console.log("Smoke: inga sålda lägenheter med bild-id och utgångspris, inget anrop gjordes.");
    return 0;
  }

  // Wrap the call to keep the kind of a failure: an HTTP 400 about the schema and one about a picture need different answers.
  const kinds: FailureKind[] = [];
  const statuses: number[] = [];
  const call: SoldConditionCallFn = async (blocks) => {
    try {
      return await realCall(blocks);
    } catch (error) {
      const status = httpStatusOf(error);
      if (status !== null) statuses.push(status);
      kinds.push(failureKindOf(error));
      throw error;
    }
  };

  const out = await runSoldConditionReads(
    sample.map((r) => ({ booliId: r.booliId, imageIds: r.enriched?.imageIds ?? [] })),
    { call, cache, capSek: Math.min(SMOKE_CAP_SEK, remaining), today },
  );
  // Saved whatever happened: a billed-and-failed call must stay in the lifetime ledger.
  saveSoldConditionCache(SOLD_CONDITION_CACHE_PATH, out.cacheNext);

  const readCount = out.reads.filter((r) => r.result !== null).length;
  const failed = out.reads.filter((r) => r.status === "failed").length;
  // grammar: "ok" when at least one answer parsed; otherwise the kind of the failures that stopped it.
  let grammar: "ok" | "http_400" | "image_fetch_failed" | "other_error";
  if (readCount > 0 && !kinds.includes("http_400")) grammar = "ok";
  else if (kinds.includes("http_400")) grammar = "http_400";
  else if (kinds.includes("image_fetch_failed")) grammar = "image_fetch_failed";
  else grammar = "other_error";

  const errorCodes = out.reads.flatMap((r) => (r.errorCode ? [r.errorCode] : []));
  writeEvidence({
    date: today,
    version: SOLD_CONDITION_VERSION,
    model: SOLD_CONDITION_MODEL,
    attempted: sample.length,
    read: readCount,
    failed,
    statuses: out.reads.map((r) => r.status),
    errorCodes,
    httpStatuses: statuses,
    spentSek: Number(out.spentSek.toFixed(4)),
    totalSpentSek: Number(out.totalSpentSek.toFixed(4)),
    grammar,
    conditions: conditionsOf(out.reads),
    confidences: out.reads.flatMap((r) => (r.result ? [Number(r.result.confidence.toFixed(2))] : [])),
    images: out.reads.map((r) => r.images),
  });

  for (const [i, r] of out.reads.entries()) {
    const what = r.result ? `${r.result.condition}, konfidens ${r.result.confidence.toFixed(2).replace(".", ",")}` : `ingen tolkning (${r.errorCode ?? r.status})`;
    console.log(`Smoke ${i + 1} av ${out.reads.length} (${r.status}, ${r.images} bilder): ${what}`);
  }
  console.log(
    `Smoke: ${readCount} av ${sample.length} tolkade, schemat/bilderna: ${grammar}, ${out.calls} anrop, ${out.cacheHits} från cache, ${formatSek(out.spentSek)} kr denna körning (totalt ${formatSek(out.totalSpentSek)} kr av ${formatSek(SOLD_CONDITION_CAP_SEK)} kr, smoketaket ${formatSek(SMOKE_CAP_SEK)} kr)`,
  );
  return 0;
}

async function readSample(call: SoldConditionCallFn, n: number, today: string): Promise<number> {
  const sample = selectConditionSample(loadSoldRows(), SOLD_CONDITION_SAMPLE_N).slice(0, n);
  const loaded = loadSoldConditionCache(SOLD_CONDITION_CACHE_PATH);
  if (loaded.warning) console.log(loaded.warning);
  let cache: SoldConditionCache = loaded.cache;
  const all: SoldConditionOutcome[] = [];
  let spent = 0;
  for (let i = 0; i < sample.length; i += SAVE_EVERY) {
    const chunk = sample.slice(i, i + SAVE_EVERY);
    const out = await runSoldConditionReads(
      chunk.map((r) => ({ booliId: r.booliId, imageIds: r.enriched?.imageIds ?? [] })),
      { call, cache, capSek: SOLD_CONDITION_CAP_SEK, today },
    );
    cache = out.cacheNext;
    saveSoldConditionCache(SOLD_CONDITION_CACHE_PATH, cache);
    all.push(...out.reads);
    spent += out.spentSek;
    console.log(`Läst ${Math.min(i + SAVE_EVERY, sample.length)} av ${sample.length}, ${formatSek(spent)} kr denna körning`);
    if (out.reads.some((r) => r.status === "cost_cap")) {
      console.log(`Taket på ${formatSek(SOLD_CONDITION_CAP_SEK)} kr sammanlagt är nått, körningen stannar.`);
      break;
    }
  }
  const statuses = countBy(all.map((r) => r.status));
  const errors = countBy(all.flatMap((r) => (r.errorCode ? [r.errorCode] : [])));
  console.log(
    `Skickläsning: ${all.length} lägenheter, status ${JSON.stringify(statuses)}, fel ${JSON.stringify(errors)}, skick ${JSON.stringify(conditionsOf(all))}, ${formatSek(spent)} kr denna körning, totalt ${formatSek(soldConditionSpentSek(cache))} kr av ${formatSek(SOLD_CONDITION_CAP_SEK)} kr`,
  );
  return 0;
}

interface SmokeEvidence {
  attempted: number;
  read: number;
  failed: number;
  grammar: string;
  spentSek: number;
  totalSpentSek: number;
  conditions: Record<string, number>;
  /** Confidence of each usable answer; the fit excludes those below the bar. */
  confidences: number[];
  date: string;
}

function readSmokeEvidence(): SmokeEvidence | null {
  if (!existsSync(EVIDENCE_JSON)) return null;
  try {
    const e = JSON.parse(readFileSync(EVIDENCE_JSON, "utf8")) as Partial<SmokeEvidence>;
    if (typeof e.attempted !== "number" || typeof e.read !== "number") return null;
    return {
      attempted: e.attempted,
      read: e.read,
      failed: typeof e.failed === "number" ? e.failed : 0,
      grammar: typeof e.grammar === "string" ? e.grammar : "other_error",
      spentSek: typeof e.spentSek === "number" ? e.spentSek : 0,
      totalSpentSek: typeof e.totalSpentSek === "number" ? e.totalSpentSek : 0,
      conditions: typeof e.conditions === "object" && e.conditions !== null ? (e.conditions as Record<string, number>) : {},
      confidences: Array.isArray((e as { confidences?: unknown }).confidences)
        ? ((e as { confidences: unknown[] }).confidences.filter((c) => typeof c === "number") as number[])
        : [],
      date: typeof e.date === "string" ? e.date : "okänt datum",
    };
  } catch {
    return null;
  }
}

const sv = (n: number): string => n.toLocaleString("sv-SE");
const pct = (part: number, whole: number): string => (whole > 0 ? ((part * 100) / whole).toFixed(1).replace(".", ",") : "0,0");

function branchReport(): number {
  const rows = loadSoldRows();
  const v2 = rows.filter((r) => r.enriched?.detailVersion === SOLD_DETAIL_VERSION);
  const withIds = v2.filter((r) => (r.enriched?.imageIds?.length ?? 0) > 0);
  const eligible = rows.filter(isConditionEligible);
  const smokeEvidence = readSmokeEvidence();
  const decision = soldConditionBranch({
    eligible: eligible.length,
    smoke: smokeEvidence === null ? null : { attempted: smokeEvidence.attempted, read: smokeEvidence.read },
  });

  const lines = [
    "# Budpremie och skick: fit eller prior (BID-01, R-08)",
    "",
    "Mätt, inte antaget. Grenen bestäms av två mått och reglerna står här så att de kan läsas.",
    "",
    "## Säljfoton",
    "",
    `- Sålda lägenheter lästa i v2-formatet: ${sv(v2.length)}`,
    `- Med minst ett bild-id: ${sv(withIds.length)} (${pct(withIds.length, v2.length)} %)`,
    `- Med bild-id och utgångspris (kan användas i budpremien): ${sv(eligible.length)} (${pct(eligible.length, v2.length)} % av v2)`,
    `- Urvalet för skickläsningen: ${sv(Math.min(SOLD_CONDITION_SAMPLE_N, eligible.length))} rader (stratifierat på distrikt och storleksband, fast frö)`,
    "",
    "## Smoketest (5 sålda lägenheter, högst 1 kr)",
    "",
  ];
  if (smokeEvidence === null) {
    lines.push("- Ej körd.");
  } else {
    lines.push(
      `- Körd ${smokeEvidence.date}: ${smokeEvidence.attempted} försökta, ${smokeEvidence.read} lästa, ${smokeEvidence.failed} misslyckade`,
      `- Schemat och bilderna: ${smokeEvidence.grammar}`,
      `- Kostnad: ${formatSek(smokeEvidence.spentSek)} kr (totalt ${formatSek(smokeEvidence.totalSpentSek)} kr av ${formatSek(SOLD_CONDITION_CAP_SEK)} kr)`,
      `- Skick som modellen svarade: dated ${smokeEvidence.conditions.dated ?? 0}, ok ${smokeEvidence.conditions.ok ?? 0}, fresh ${smokeEvidence.conditions.fresh ?? 0}`,
      `- Under säkerhetsgränsen ${String(SOLD_CONDITION_MIN_CONFIDENCE).replace(".", ",")} (utesluts ur anpassningen, kodas aldrig som 0): ${smokeEvidence.confidences.filter((c) => c < SOLD_CONDITION_MIN_CONFIDENCE).length} av ${smokeEvidence.confidences.length}`,
    );
  }
  lines.push(
    "",
    "## Regeln",
    "",
    `Termen för skick anpassas bara när minst ${SOLD_CONDITION_MIN_ELIGIBLE} sålda lägenheter har bild-id och utgångspris OCH smoketestet läste minst ${SOLD_CONDITION_SMOKE_MIN_READ} av ${SOLD_CONDITION_SMOKE_N} sålda lägenheter. Tröskeln på ${SOLD_CONDITION_MIN_ELIGIBLE} följer effektberäkningen i RESEARCH Q9 (cirka 220 användbara rader ger en standardavvikelse kring 0,0083, nog för att se plus minus 2 procentenheter). Annars är grenen prior: termen är 0 och budpremien märks "skick ej mätt". Ingen påhittad siffra används (R-08).`,
    "",
    decision.branch === "fit" ? "Gren: fit" : `Gren: prior (${decision.reason})`,
    "",
  );
  const safe = guardedDataPath(BRANCH_MD, { dir: EVIDENCE_DIR, ext: ".md" });
  if (safe === null) throw new Error(`Rapporten får bara skrivas under ${EVIDENCE_DIR}/`);
  writeTextAtomic(safe, lines.join("\n"));
  console.log(
    `Säljfoton: ${eligible.length} användbara av ${v2.length} v2-rader (${withIds.length} med bild-id). Smoke: ${smokeEvidence === null ? "ej körd" : `${smokeEvidence.read} av ${smokeEvidence.attempted} lästa`}. ${decision.branch === "fit" ? "Gren: fit" : `Gren: prior (${decision.reason})`}`,
  );
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    console.log(USAGE);
    return 1;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.branchReport) return branchReport();
  if (process.env.RUN_LLM_EVALS !== "1") {
    console.log("Hoppar över: RUN_LLM_EVALS=1 krävs för betalda anrop");
    return 0;
  }
  const hasKey = typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY.length > 0;
  console.log(`ANTHROPIC_API_KEY: ${hasKey ? "satt" : "saknas"}`);
  if (!hasKey) return 1;

  const call = makeSoldConditionCall(new Anthropic());
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (args.smoke) return await smoke(call, today);
    return await readSample(call, args.n as number, today);
  } catch (error) {
    console.error("FEL:", safeError(error));
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error("FEL:", safeError(e));
    process.exit(1);
  },
);
