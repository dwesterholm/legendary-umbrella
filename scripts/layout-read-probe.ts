/**
 * Layout read smoke (Phase 14.4, LAY-01, D-07, D-08, D-11). PAID and GATED: at most 1 kr, and no call at all
 * unless RUN_LLM_EVALS=1.
 *
 *   RUN_LLM_EVALS=1 npx tsx scripts/layout-read-probe.ts --smoke [--snapshot <fil>]
 *
 * What it answers: does the strict-output schema of the layout read compile against the live API (an HTTP 400
 * means the schema is too heavy; unit tests with a mocked call cannot see that), and what does the model say
 * about Folkungagatan 61, whose truth is known (D-11: balcony street, windows on one side, bedroom street)?
 *
 *   --smoke   Two live reads through the cached runner, under a run cap of 1 kr: Folkungagatan 61 from the
 *             snapshot (its Booli pictures, no broker photos) and the committed synthetic plan (bytes). The
 *             comparison with the truth is a FINDING, not a pass/fail: a disagreeing read is recorded as is.
 *
 * The layout cache (`layout-cache.json`, gitignored) is saved after the run whatever happened, so a billed
 * failure stays in the lifetime ledger and a successful read of Folkungagatan 61 is reused by the weekly run.
 *
 * Gate: without RUN_LLM_EVALS=1 the script prints "Hoppar över: RUN_LLM_EVALS=1 krävs för betalda anrop" and exits 0
 * before any client exists. With it, a missing ANTHROPIC_API_KEY exits 1 (presence only is printed, never a value).
 *
 * Logs carry the Booli id, the eight read fields and the spend; never a picture URL, never a key. Errors are
 * printed as the class name and the HTTP status only (a message can carry request details).
 */
import { existsSync, readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { parseFitSnapshot } from "@/lib/discovery/fit-score";
import { guardedDataPath, writeJsonAtomic } from "@/lib/discovery/json-store";
import { usableSide } from "@/lib/discovery/layout-fact";
import { makeLayoutCall } from "@/lib/discovery/layout-call";
import {
  LAYOUT_CACHE_PATH,
  LAYOUT_MODEL,
  LAYOUT_READ_VERSION,
  LAYOUT_RUN_CAP_SEK,
  LayoutCallError,
  layoutFactFromRead,
  loadLayoutCache,
  runLayoutReads,
  saveLayoutCache,
  type LayoutCallFn,
  type LayoutRead,
  type LayoutReadItem,
} from "@/lib/discovery/layout-read";
import { formatSek } from "@/lib/discovery/sun-floorplan";

const DEFAULT_SNAPSHOT = ".planning/calibration/data/forsale-snapshot-2026-10-13.json";
const SYNTHETIC_PLAN = "src/lib/discovery/__fixtures__/floorplan-north-arrow.fixture.png";
const EVIDENCE_DIR = ".planning/phases";
const EVIDENCE_JSON = ".planning/phases/14.4-valuation-layout-livability/evidence/layout-smoke.json";
const F61_BOOLI_ID = "150148";
/** The truth of D-11, hand-written: balcony and living room and the glass-walled bedroom on the street side, no courtyard windows. */
const F61_TRUTH = { balconySide: "street", windowSides: "one", bedroomSide: "street" } as const;

/** The smoke cap, SEK (D-17): two reads at about 0,4 kr each. */
const SMOKE_CAP_SEK = 1;
/**
 * The estimate checked before each smoke call. R-07 puts a full 7-picture read at about 0,43 kr, so 0,45 lets both
 * smoke reads happen under the 1 kr cap (the default 0,6 would refuse the second one); the real bill is read from
 * the API usage and counts against the cap as it comes in.
 */
const SMOKE_EST_SEK = 0.45;

const USAGE = `Användning (betalt, högst ${formatSek(SMOKE_CAP_SEK)} kr, kräver RUN_LLM_EVALS=1):
  RUN_LLM_EVALS=1 npx tsx scripts/layout-read-probe.ts --smoke [--snapshot <fil>]

  --smoke          Två riktiga läsningar (Folkungagatan 61 från snapshoten och den syntetiska planritningen) som visar att schemat går igenom
  --snapshot <fil> Snapshot med annonser (standard: ${DEFAULT_SNAPSHOT})
Utan RUN_LLM_EVALS=1 görs inget anrop. Slutkoder: 0 klart eller överhoppat, 1 fel.`;

interface Args {
  smoke: boolean;
  snapshot: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): Args | null {
  const out: Args = { smoke: false, snapshot: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--help" || flag === "-h") out.help = true;
    else if (flag === "--smoke") out.smoke = true;
    else if (flag === "--snapshot" && value !== undefined) { out.snapshot = value; i++; }
    else return null;
  }
  return out;
}

const yesNo = (b: boolean) => (b ? "ja" : "nej");
const dec2 = (x: number) => x.toFixed(2).replace(".", ",");

function describeRead(r: LayoutRead): string {
  return `balkong ${r.balconySide}, vardagsrum på balkongsidan ${yesNo(r.livingOnBalconySide)}, kök ${yesNo(r.kitchenOnBalconySide)}, sovrum ${yesNo(r.bedroomOnBalconySide)}, fönster ${r.windowSides}, sovrumssida ${r.bedroomSide}, bevis ${r.streetEvidence}, konfidens ${dec2(r.confidence)}`;
}

/** The HTTP status of an SDK error, or null. */
const httpStatusOf = (error: unknown): number | null => {
  const status = error instanceof Error ? (error as { status?: unknown }).status : undefined;
  return typeof status === "number" ? status : null;
};

/** An SDK error reduced to its class name and HTTP status; the message can carry request details, so it is never printed. */
function safeError(error: unknown): string {
  if (error instanceof LayoutCallError) return error.code;
  if (error instanceof Error) {
    const status = httpStatusOf(error);
    return status !== null ? `${error.name} (HTTP ${status})` : error.name;
  }
  return "UNKNOWN";
}

function previousGrammar(): string | null {
  try {
    if (!existsSync(EVIDENCE_JSON)) return null;
    const prev = JSON.parse(readFileSync(EVIDENCE_JSON, "utf8")) as { grammar?: unknown };
    return typeof prev.grammar === "string" ? prev.grammar : null;
  } catch {
    return null;
  }
}

function f61ItemFrom(snapshotPath: string): LayoutReadItem {
  const snapshot = parseFitSnapshot(JSON.parse(readFileSync(snapshotPath, "utf8")));
  const row = snapshot.rows.find((r) => (r.candidate.sourceListingUrl ?? "").endsWith(`/bostad/${F61_BOOLI_ID}`));
  if (!row) throw new Error(`Folkungagatan 61 (${F61_BOOLI_ID}) finns inte i snapshoten`);
  return { listingPath: `/bostad/${F61_BOOLI_ID}`, imageUrls: row.candidate.imageUrls, brokerImages: [] };
}

async function smoke(realCall: LayoutCallFn, snapshotPath: string, today: string): Promise<number> {
  const planBytes = readFileSync(SYNTHETIC_PLAN).toString("base64");
  const items: LayoutReadItem[] = [
    f61ItemFrom(snapshotPath),
    {
      listingPath: "/fixture/floorplan-north-arrow",
      imageUrls: [],
      brokerImages: [],
      planImage: { mediaType: "image/png", data: planBytes },
    },
  ];

  // Wrap the call to keep the HTTP status of a failure: an HTTP 400 is the signal that the schema is too heavy.
  const statuses: number[] = [];
  const call: LayoutCallFn = async (blocks) => {
    try {
      return await realCall(blocks);
    } catch (error) {
      const status = httpStatusOf(error);
      if (status !== null) statuses.push(status);
      throw error;
    }
  };

  const { cache, warning } = loadLayoutCache(LAYOUT_CACHE_PATH);
  if (warning) console.log(warning);
  const out = await runLayoutReads(items, { call, cache, runCapSek: SMOKE_CAP_SEK, today, estSekPerFlat: SMOKE_EST_SEK });
  // Saved whatever happened: a billed-and-failed call must stay in the lifetime ledger.
  saveLayoutCache(LAYOUT_CACHE_PATH, out.cacheNext);

  const [f61, synth] = out.reads;
  if (f61.result) console.log(`Smoke Folkungagatan 61 (${f61.status}): ${describeRead(f61.result)}`);
  else console.log(`Smoke Folkungagatan 61: ingen tolkning (${f61.status}${f61.errorCode ? `, ${f61.errorCode}` : ""})`);
  if (synth.result) console.log(`Smoke syntetisk planritning (${synth.status}): ${describeRead(synth.result)}`);
  else console.log(`Smoke syntetisk planritning: ingen tolkning (${synth.status}${synth.errorCode ? `, ${synth.errorCode}` : ""})`);

  const matchesTruth = {
    balconySide: f61.result?.balconySide === F61_TRUTH.balconySide,
    windowSides: f61.result?.windowSides === F61_TRUTH.windowSides,
    bedroomSide: f61.result?.bedroomSide === F61_TRUTH.bedroomSide,
  };
  if (f61.result) {
    console.log(
      `Folkungagatan 61 mot sanningen (balkong gata, fönster en sida, sovrum gata): balkong ${yesNo(matchesTruth.balconySide)}, fönster ${yesNo(matchesTruth.windowSides)}, sovrum ${yesNo(matchesTruth.bedroomSide)}`,
    );
    const fact = layoutFactFromRead(f61.result, { version: LAYOUT_READ_VERSION, booli: f61.images.booli, broker: f61.images.broker });
    console.log(
      `Efter spärren (konfidens ≥ 0,6 och fotobevis): balkongsida ${usableSide(fact, "balcony") ?? "okänd"}, sovrumssida ${usableSide(fact, "bedroom") ?? "okänd"}`,
    );
  }

  // grammar: "ok" when the API answered at least once without an HTTP 400; on a cache-only rerun the earlier verdict stands.
  let grammar: "ok" | "http_400" | "other_error";
  if (statuses.includes(400)) grammar = "http_400";
  else if (out.calls > 0) grammar = "ok";
  else if (out.cacheHits > 0 && previousGrammar() === "ok") grammar = "ok";
  else grammar = "other_error";

  const read = (r: LayoutRead | null) => (r === null ? null : { ...r });
  writeEvidence({
    date: today,
    version: LAYOUT_READ_VERSION,
    model: LAYOUT_MODEL,
    calls: out.calls,
    cacheHits: out.cacheHits,
    spentSek: Number(out.spentSek.toFixed(4)),
    totalSpentSek: Number(out.totalSpentSek.toFixed(4)),
    runCapSek: SMOKE_CAP_SEK,
    statuses: out.reads.map((r) => r.status),
    httpStatuses: statuses,
    grammar,
    f61: { read: read(f61.result), matchesTruth, truth: F61_TRUTH, images: f61.images },
    synthetic: { read: read(synth.result) },
  });

  const ok = out.reads.filter((r) => r.result !== null).length;
  console.log(
    `Smoke: ${ok} av 2 tolkade, schemat ${grammar === "ok" ? "gick igenom" : grammar === "http_400" ? "avvisades (HTTP 400)" : "gav annat fel"}, ${out.calls} anrop, ${out.cacheHits} från cache, ${formatSek(out.spentSek)} kr denna körning (totalt ${formatSek(out.totalSpentSek)} kr, taket ${formatSek(SMOKE_CAP_SEK)} kr gäller körningen; körtak i vanlig körning ${formatSek(LAYOUT_RUN_CAP_SEK)} kr)`,
  );
  return ok === 2 && grammar === "ok" ? 0 : 1;
}

/** Counts, enums and the verdict only: no picture URL, no key. Written under .planning/phases only. */
function writeEvidence(evidence: Record<string, unknown>): void {
  const safe = guardedDataPath(EVIDENCE_JSON, { dir: EVIDENCE_DIR, ext: ".json" });
  if (safe === null) throw new Error(`Bevisfilen får bara skrivas under ${EVIDENCE_DIR}/`);
  writeJsonAtomic(safe, evidence);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args === null || (!args.help && !args.smoke)) {
    console.log(USAGE);
    return 1;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (process.env.RUN_LLM_EVALS !== "1") {
    console.log("Hoppar över: RUN_LLM_EVALS=1 krävs för betalda anrop");
    return 0;
  }
  const hasKey = typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY.length > 0;
  console.log(`ANTHROPIC_API_KEY: ${hasKey ? "satt" : "saknas"}`);
  if (!hasKey) return 1;

  const call = makeLayoutCall(new Anthropic());
  const today = new Date().toISOString().slice(0, 10);
  try {
    return await smoke(call, args.snapshot ?? DEFAULT_SNAPSHOT, today);
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
