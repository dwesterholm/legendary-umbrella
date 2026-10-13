/**
 * Floor-plan compass probe (Phase 14.3, R-01, R-09). PAID and GATED: at most 2 kr in total, and no call at all
 * unless RUN_LLM_EVALS=1.
 *
 *   RUN_LLM_EVALS=1 npx tsx scripts/sun-floorplan-probe.ts --smoke
 *   RUN_LLM_EVALS=1 npx tsx scripts/sun-floorplan-probe.ts --snapshot <fil> [--n 12] [--cap-sek 2]
 *
 * What it answers: do broker floor plans carry a compass? The research looked at 69 plans by eye and found none.
 * This asks a small model (Haiku, a separate slim strict-output call, its own cache file) and applies the R-01
 * rule: the route stays closed unless at least 10 % of the floor plans show a compass.
 *
 *   --smoke   Two live reads: the first picture of the first sample row (from the snapshot, URL source, cached) and
 *             the committed synthetic plan (bytes). It proves the strict-output grammar compiles (an HTTP 400 means the
 *             schema is too heavy) and records whether the model sees a drawn north arrow and ignores the arrow at
 *             the door.
 *   probe     Reads the first picture of the n lowest Booli ids of the snapshot, writes the cache and the evidence
 *             JSON (counts and verdict, never a URL).
 *
 * The 2 kr cap is for the WHOLE probe over all runs, smoke included: what earlier runs paid is kept in the cache file
 * (`spentSekTotal`) and counts against the next run, so a rerun or a `--smoke` cannot spend another 2 kr.
 *
 * Gate: without RUN_LLM_EVALS=1 the script prints "Hoppar över: RUN_LLM_EVALS=1 krävs för betalda anrop" and exits 0
 * before any client exists. With it, a missing ANTHROPIC_API_KEY exits 1 (presence only is printed, never a value).
 *
 * Logs carry the Booli id, the five read fields and the spend; never a picture URL, never a key.
 */
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { costSek, type ClaudeUsage } from "@/lib/brf/cost";
import { parseFitSnapshot } from "@/lib/discovery/fit-score";
import { writeJsonAtomic } from "@/lib/discovery/json-store";
import {
  FLOORPLAN_CACHE_PATH,
  FLOORPLAN_CAP_SEK,
  FLOORPLAN_EST_SEK_PER_CALL,
  FLOORPLAN_MODEL,
  FLOORPLAN_SYSTEM_PROMPT,
  FloorPlanCallError,
  addFloorPlanSpend,
  asBilledFailure,
  canAffordFloorPlanCall,
  floorPlanCompassSchema,
  floorPlanSpentSek,
  formatPct,
  formatSek,
  loadFloorPlanCache,
  pickProbeSample,
  probeVerdict,
  runFloorPlanProbe,
  saveFloorPlanCache,
  summariseReads,
  type FloorPlanCallFn,
  type FloorPlanImageBlock,
  type FloorPlanRead,
} from "@/lib/discovery/sun-floorplan";

const DEFAULT_SNAPSHOT = ".planning/calibration/data/forsale-snapshot-2026-10-13.json";
const SYNTHETIC_PLAN = "src/lib/discovery/__fixtures__/floorplan-north-arrow.fixture.png";
const EVIDENCE_JSON = ".planning/phases/14.3-sun-orientation-spike/evidence/floorplan-probe.json";
const USER_INSTRUCTION = "Är det här en planritning, och finns det en norrpil? Svara enligt schemat.";

const USAGE = `Användning (betalt, högst ${formatSek(FLOORPLAN_CAP_SEK)} kr, kräver RUN_LLM_EVALS=1):
  RUN_LLM_EVALS=1 npx tsx scripts/sun-floorplan-probe.ts --smoke [--snapshot <fil>]
  RUN_LLM_EVALS=1 npx tsx scripts/sun-floorplan-probe.ts --snapshot <fil> [--n 12] [--cap-sek 2]

  --smoke          Två riktiga läsningar (en planritning från snapshoten och den syntetiska) som visar att schemat går igenom
  --snapshot <fil> Snapshot med annonser (standard för --smoke: ${DEFAULT_SNAPSHOT})
  --n <antal>      Antal planer i provet, 1 till 50 (standard 12)
  --cap-sek <kr>   Tak i kronor, över 0 och högst ${FLOORPLAN_CAP_SEK} (standard ${FLOORPLAN_CAP_SEK})
Utan RUN_LLM_EVALS=1 görs inget anrop. Slutkoder: 0 klart eller överhoppat, 1 fel.`;

interface Args {
  smoke: boolean;
  snapshot: string | null;
  n: number;
  capSek: number;
  help: boolean;
}

function parseArgs(argv: string[]): Args | null {
  const out: Args = { smoke: false, snapshot: null, n: 12, capSek: FLOORPLAN_CAP_SEK, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--help" || flag === "-h") out.help = true;
    else if (flag === "--smoke") out.smoke = true;
    else if (flag === "--snapshot" && value !== undefined) { out.snapshot = value; i++; }
    else if (flag === "--n" && value !== undefined) { out.n = Number(value); i++; }
    else if (flag === "--cap-sek" && value !== undefined) { out.capSek = Number(value); i++; }
    else return null;
  }
  if (!Number.isInteger(out.n) || out.n < 1 || out.n > 50) return null;
  if (!(out.capSek > 0) || out.capSek > FLOORPLAN_CAP_SEK) return null;
  return out;
}

function toClaudeUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}): ClaudeUsage {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
  };
}

/** The injected call: the vision.ts call shape (messages.parse + zodOutputFormat), one picture, the slim schema. */
function makeCall(client: Anthropic): FloorPlanCallFn {
  return async (image: FloorPlanImageBlock) => {
    let message;
    try {
      message = await client.beta.messages.parse({
        model: FLOORPLAN_MODEL,
        max_tokens: 200,
        temperature: 0,
        system: FLOORPLAN_SYSTEM_PROMPT,
        messages: [{ role: "user", content: [image, { type: "text", text: USER_INSTRUCTION }] }],
        output_config: { format: zodOutputFormat(floorPlanCompassSchema) },
      });
    } catch (error) {
      // parse() throws AFTER a billed answer when the output does not fit the schema; the cap must see that money (WR-04).
      throw asBilledFailure(error, (e) => e instanceof Anthropic.APIError, FLOORPLAN_EST_SEK_PER_CALL);
    }
    // The call completed, so it is billed whatever its stop_reason turns out to be.
    const billed = costSek(toClaudeUsage(message.usage));
    if (message.stop_reason === "refusal") throw new FloorPlanCallError("CLAUDE_REFUSAL", billed);
    if (message.stop_reason === "max_tokens") throw new FloorPlanCallError("CLAUDE_MAX_TOKENS", billed);
    if (!message.parsed_output) throw new FloorPlanCallError("CLAUDE_PARSE_EMPTY", billed);
    return { result: message.parsed_output, costSek: billed };
  };
}

const yesNo = (b: boolean) => (b ? "ja" : "nej");
const dec2 = (x: number) => x.toFixed(2).replace(".", ",");

function describeRead(r: FloorPlanRead): string {
  return `plan ${yesNo(r.isFloorPlan)}, norrpil ${yesNo(r.northArrowPresent)}, norr ${r.northBearingDeg}°, balkong ${r.balconySide}, konfidens ${dec2(r.confidence)}`;
}

/** An SDK error reduced to its class name and HTTP status; the message can carry request details, so it is never printed. */
function safeError(error: unknown): string {
  if (error instanceof FloorPlanCallError) return error.code;
  if (error instanceof Error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? `${error.name} (HTTP ${status})` : error.name;
  }
  return "UNKNOWN";
}

function loadSample(path: string, n: number) {
  const snapshot = parseFitSnapshot(JSON.parse(readFileSync(path, "utf8")));
  return pickProbeSample(snapshot.rows.map((r) => r.candidate), n);
}

async function smoke(call: FloorPlanCallFn, snapshotPath: string, today: string): Promise<number> {
  const errors: string[] = [];
  let spent = 0;
  let ok = 0;

  // 1) A real Booli plan, through the cached runner so the probe does not pay for it twice.
  const first = loadSample(snapshotPath, 1);
  const { cache, warning } = loadFloorPlanCache(FLOORPLAN_CACHE_PATH);
  if (warning) console.log(warning);
  const real = await runFloorPlanProbe(first, { call, cache, capSek: FLOORPLAN_CAP_SEK, today });
  spent += real.spentSek;
  const realRead = real.reads[0];
  if (realRead?.result) {
    ok += 1;
    console.log(`Smoke ${realRead.booliId}: ${describeRead(realRead.result)}`);
  } else {
    errors.push(realRead?.error ?? realRead?.status ?? "tomt prov");
    console.log(`Smoke ${realRead?.booliId ?? "?"}: ingen tolkning (${realRead?.status ?? "tomt prov"}${realRead?.error ? `, ${realRead.error}` : ""})`);
  }
  // Saved whatever happened: a billed-and-failed call must stay in the running total.
  let ledger = real.cacheNext;
  saveFloorPlanCache(FLOORPLAN_CACHE_PATH, ledger);

  // 2) The synthetic plan (north arrow up, balcony label on the bottom side, a door arrow on the left wall).
  //    It is outside the runner, so the cap is checked here against the same cumulative total and its cost is recorded.
  if (!canAffordFloorPlanCall(ledger, FLOORPLAN_CAP_SEK)) {
    errors.push("cost_cap");
    console.log(`Smoke syntetisk: hoppas över, taket ${formatSek(FLOORPLAN_CAP_SEK)} kr är nått (hittills ${formatSek(floorPlanSpentSek(ledger))} kr)`);
  } else {
    try {
      const data = readFileSync(SYNTHETIC_PLAN).toString("base64");
      const synth = await call({ type: "image", source: { type: "base64", media_type: "image/png", data } });
      const paid = Number.isFinite(synth.costSek) && synth.costSek > 0 ? synth.costSek : FLOORPLAN_EST_SEK_PER_CALL;
      spent += paid;
      ledger = addFloorPlanSpend(ledger, paid);
      ok += 1;
      console.log(`Smoke syntetisk: ${describeRead(synth.result)}`);
      const sees = synth.result.isFloorPlan && synth.result.northArrowPresent;
      const northUp = Math.abs(((synth.result.northBearingDeg % 360) + 360) % 360) < 20 || Math.abs((((synth.result.northBearingDeg % 360) + 360) % 360) - 360) < 20;
      console.log(
        `Smoke syntetisk norrpil sedd: ${yesNo(sees)} (väntat: ja, norr 0°, balkong ned; norr uppåt ${yesNo(sees && northUp)}, balkong ned ${yesNo(synth.result.balconySide === "ned")})`,
      );
    } catch (error) {
      if (error instanceof FloorPlanCallError) {
        spent += error.billedSek;
        ledger = addFloorPlanSpend(ledger, error.billedSek);
      }
      errors.push(safeError(error));
      console.log(`Smoke syntetisk: ingen tolkning (${safeError(error)})`);
    }
    saveFloorPlanCache(FLOORPLAN_CACHE_PATH, ledger);
  }

  if (ok === 2) {
    console.log(`Smoke: 2 av 2 tolkade, ${formatSek(spent)} kr (totalt ${formatSek(floorPlanSpentSek(ledger))} kr av tak ${formatSek(FLOORPLAN_CAP_SEK)} kr)`);
    return 0;
  }
  console.log(`Smoke: ${ok} av 2 tolkade, fel: ${errors.join(", ")}, ${formatSek(spent)} kr`);
  return 1;
}

async function probe(call: FloorPlanCallFn, snapshotPath: string, n: number, capSek: number, today: string): Promise<number> {
  const items = loadSample(snapshotPath, n);
  const { cache, warning } = loadFloorPlanCache(FLOORPLAN_CACHE_PATH);
  if (warning) console.log(warning);

  const out = await runFloorPlanProbe(items, { call, cache, capSek, today });
  saveFloorPlanCache(FLOORPLAN_CACHE_PATH, out.cacheNext);

  for (const r of out.reads) {
    if (r.result) console.log(`Plan ${r.booliId}: ${r.status === "cache" ? "(cache) " : ""}${describeRead(r.result)}`);
    else console.log(`Plan ${r.booliId}: ingen tolkning (${r.status}${r.error ? `, ${r.error}` : ""})`);
  }

  const counts = summariseReads(out.reads.flatMap((r) => (r.result ? [r.result] : [])));
  const verdict = probeVerdict(counts);
  console.log(
    `Planritningsprobe: ${out.calls} anrop, ${out.cacheHits} från cache, ${formatSek(out.spentSek)} kr denna körning, ${formatSek(out.totalSpentSek)} kr totalt av tak ${formatSek(capSek)} kr`,
  );
  console.log(
    `Planer: ${counts.floorPlans} av ${items.length}, med kompass: ${counts.withCompass} (${formatPct(counts.withCompass, counts.floorPlans)} %), beslut: ${verdict === "go" ? "go" : "väg stängd"}`,
  );

  // Counts and the verdict only: no picture URL, no per-picture result.
  writeJsonAtomic(EVIDENCE_JSON, {
    date: today,
    sampled: items.length,
    floorPlans: counts.floorPlans,
    withCompass: counts.withCompass,
    prevalencePct: Number(formatPct(counts.withCompass, counts.floorPlans).replace(",", ".")),
    verdict,
    spentSek: Number(out.spentSek.toFixed(4)),
    spentSekTotal: Number(out.totalSpentSek.toFixed(4)),
    calls: out.calls,
    cacheHits: out.cacheHits,
    model: FLOORPLAN_MODEL,
  });
  const failed = out.reads.filter((r) => r.status === "failed").length;
  return failed === out.reads.length && out.reads.length > 0 ? 1 : 0;
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
  if (process.env.RUN_LLM_EVALS !== "1") {
    console.log("Hoppar över: RUN_LLM_EVALS=1 krävs för betalda anrop");
    return 0;
  }
  const hasKey = typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY.length > 0;
  console.log(`ANTHROPIC_API_KEY: ${hasKey ? "satt" : "saknas"}`);
  if (!hasKey) return 1;
  if (!args.smoke && args.snapshot === null) {
    console.log(USAGE);
    return 1;
  }

  const call = makeCall(new Anthropic());
  const today = new Date().toISOString().slice(0, 10);
  if (args.smoke) return smoke(call, args.snapshot ?? DEFAULT_SNAPSHOT, today);
  return probe(call, args.snapshot as string, args.n, args.capSek, today);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error("FEL:", e instanceof Error ? e.name : "UNKNOWN");
    process.exit(1);
  },
);
