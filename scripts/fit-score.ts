/**
 * Headless flip-profit ranking using the app's own pipeline modules.
 *
 * This version only replays a stored for-sale snapshot: no network, no Apify,
 * no Anthropic. It reads two JSON files, scores every row with the hedonic
 * model plus the reno bundle, and prints a ranked table, a decomposition for
 * one tracked listing and the list of rows that cannot be compared.
 *
 * Run: npx tsx scripts/fit-score.ts --replay <snapshot.json> [--model data/hedonic-model.json] [--track 150148]
 *
 * Only pure discovery modules are imported here on purpose: the replay must
 * stay offline (FIT-06). The live mode arrives in a later plan.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MAX_CREDIT_PCT, rankFit, parseFitSnapshot, type FitFlag, type FitScoreResult } from "@/lib/discovery/fit-score";
import { parseHedonicModel } from "@/lib/discovery/hedonic-model";
import { RENO_BAND } from "@/lib/discovery/reno-tier";

const DEFAULT_MODEL_PATH = "data/hedonic-model.json";
const DEFAULT_TRACK_ID = 150148;

const USAGE = `Användning:
  npx tsx scripts/fit-score.ts --replay <snapshot.json> [--model ${DEFAULT_MODEL_PATH}] [--track ${DEFAULT_TRACK_ID}]

  --replay <fil>   Spela upp en sparad snapshot av bostäder till salu (ingen nätverksanrop)
  --model <fil>    Hedonisk modell (JSON), standard ${DEFAULT_MODEL_PATH}
  --track <id>     Booli-id att visa uppdelat i detalj, standard ${DEFAULT_TRACK_ID}`;

const sek = (n: number) => Math.round(n).toLocaleString("sv-SE");
const pct = (n: number) => `${(n * 100).toFixed(1)} %`;
const orDash = (n: number | null, f: (x: number) => string) => (n === null ? "-" : f(n));

const FLAG_LABELS: Record<FitFlag, string> = {
  expectedFinalOver4M: "slutpris>4M",
  ejBildtolkad: "ej bildtolkad",
  hiddenDefectRisk: "dold-defekt-risk",
  creditCapped: "kredit-tak",
  renoUnknown: "reno okänd",
  notComparable: "ej jämförbar",
};

interface Args {
  replay: string | null;
  model: string;
  track: number;
}

function parseArgs(argv: string[]): Args | null {
  const out: Args = { replay: null, model: DEFAULT_MODEL_PATH, track: DEFAULT_TRACK_ID };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--replay" && value !== undefined) { out.replay = value; i++; }
    else if (flag === "--model" && value !== undefined) { out.model = value; i++; }
    else if (flag === "--track" && value !== undefined && Number.isInteger(Number(value))) { out.track = Number(value); i++; }
    else return null;
  }
  return out;
}

function renoText(r: FitScoreResult): string {
  return `${r.renoTier} ${sek(r.renoSek)} (${sek(r.renoLowSek)}–${sek(r.renoHighSek)})`;
}

function printRow(rank: number, r: FitScoreResult): void {
  console.log(
    [
      rank,
      r.address ?? "-",
      r.district,
      orDash(r.livingArea, (x) => String(x)),
      orDash(r.floor, (x) => String(x)),
      orDash(r.askingSek, sek),
      orDash(r.purchaseSek, sek),
      orDash(r.resaleSek, sek),
      renoText(r),
      orDash(r.profitSek, sek),
      sek(r.tasteSek),
      r.flags.map((f) => FLAG_LABELS[f]).join(", ") || "-",
      r.sourceListingUrl ?? "-",
    ].join(" | "),
  );
}

function printDecomposition(r: FitScoreResult, rankAll: number, totalAll: number, rankDistrict: number, totalDistrict: number): void {
  console.log(`\nUppdelning för Booli ${r.booliId} (${r.address ?? "-"}, ${r.district})`);
  console.log(`  Placering: ${rankAll} av ${totalAll} totalt, ${rankDistrict} av ${totalDistrict} i ${r.district}`);
  console.log(`  Utgångspris:        ${orDash(r.askingSek, sek)} kr (${orDash(r.livingArea, (x) => String(x))} kvm)`);
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
  console.log(`  Flaggor:            ${r.flags.map((f) => FLAG_LABELS[f]).join(", ") || "-"}`);
  console.log(`  Imputerat:          ${r.featuresImputed.join(", ") || "-"}`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args === null || args.replay === null) {
    console.log(USAGE);
    process.exit(2);
  }

  const snapshotPath = resolve(args.replay);
  const modelPath = resolve(args.model);
  if (!existsSync(snapshotPath)) {
    console.error(`Snapshotfil saknas: ${args.replay}`);
    process.exit(1);
  }
  if (!existsSync(modelPath)) {
    console.error(`Modellfil saknas: ${args.model}`);
    process.exit(1);
  }

  const snapshot = parseFitSnapshot(JSON.parse(readFileSync(snapshotPath, "utf8")));
  const model = parseHedonicModel(JSON.parse(readFileSync(modelPath, "utf8")));
  const { ranked, notComparable } = rankFit(snapshot.rows, model);

  console.log(
    `Modell per ${model.asOf}: n ${model.n}, R² ${model.r2.toFixed(2)}, storlek ${model.minLivingArea}–${model.maxLivingArea} kvm, renoband ${RENO_BAND}`,
  );
  if (model.note) console.log(`OBS: ${model.note}`);
  console.log(`Snapshot per ${snapshot.asOf}: ${snapshot.rows.length} rader, ${ranked.length} jämförbara, ${notComparable.length} ej jämförbara\n`);

  console.log(
    "# | Adress | Område | kvm | vån | Utgångspris | Förv. slutpris | Värde renoverad | Reno (nivå, spann) | Vinst | Smak | Flaggor | Länk",
  );
  ranked.forEach((r, i) => printRow(i + 1, r));

  const trackedIndex = ranked.findIndex((r) => r.booliId === args.track);
  if (trackedIndex >= 0) {
    const tracked = ranked[trackedIndex];
    const sameDistrict = ranked.filter((r) => r.district === tracked.district);
    printDecomposition(tracked, trackedIndex + 1, ranked.length, sameDistrict.indexOf(tracked) + 1, sameDistrict.length);
  } else {
    const inNotComparable = notComparable.find((r) => r.booliId === args.track);
    console.log(
      inNotComparable
        ? `\nBooli ${args.track} (${inNotComparable.address ?? "-"}) är ej jämförbar: ${inNotComparable.notComparableReason}`
        : `\nBooli ${args.track} finns inte i snapshoten`,
    );
  }

  console.log(`\nEj jämförbar (${notComparable.length}):`);
  for (const r of notComparable) {
    console.log(
      `  ${r.address ?? "-"} | utgångspris ${orDash(r.askingSek, sek)} | ${orDash(r.livingArea, (x) => String(x))} kvm | ${r.notComparableReason ?? "-"}`,
    );
  }
}

try {
  main();
} catch (e) {
  console.error("FEL:", e instanceof Error ? e.message : e);
  process.exit(1);
}
