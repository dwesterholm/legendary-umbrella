/**
 * Layout accuracy runner (Phase 14.5 plan 02, LAYACC-01..03). Free and offline: No model call, no network, no
 * Booli page. The paid rounds of plans 05-07 are separate runners.
 *
 *   npx tsx scripts/layout-accuracy.ts --report --truth <fil> --cache <layoutcache.json> --out <json> [--md <md>]
 *
 * What it answers: how often are the layout reads stored in a cache right, measured against a truth file (flats a
 * person judged by eye)? The report holds counts, ids and enums only; it never prints or writes a per-flat read,
 * because blind judging in plans 06-07 depends on the judge not seeing what the model said.
 *
 * Output files may only be written under .planning/phases/ or .planning/calibration/data/. Errors are printed as
 * the class name only (a message can carry a path or request details).
 */
import { readFileSync } from "node:fs";
import { guardedDataPath, writeJsonAtomic } from "@/lib/discovery/json-store";
import { accuracyReport, layoutTruthFileSchema } from "@/lib/discovery/layout-accuracy";
import type { LayoutFact } from "@/lib/discovery/layout-fact";
import { LAYOUT_READ_VERSION, layoutFactFromRead, loadLayoutCache } from "@/lib/discovery/layout-read";

const OUT_DIRS = [".planning/phases", ".planning/calibration/data"] as const;

const USAGE = `Användning (gratis, inget anrop, ingen Booli-sida):
  npx tsx scripts/layout-accuracy.ts --report --truth <sanningsfil> --cache <layoutcache.json> --out <json> [--md <md>]

  --report         Räknar ut träffsäkerheten för de lagrade läsningarna mot sanningsfilen
  --truth <fil>    Sanningsfilen (zod-kontrollerad, bara id:n och uppräkningar)
  --cache <fil>    Layoutcachen med de lagrade läsningarna (poster med nuvarande läsversion används)
  --out <fil>      Var rapporten skrivs (.json under .planning/phases/ eller .planning/calibration/data/)
Rapporten innehåller bara antal, id:n och uppräkningar, aldrig en enskild läsning. Slutkoder: 0 klart, 1 fel.`;

interface Args {
  report: boolean;
  truth: string | null;
  cache: string | null;
  out: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): Args | null {
  const out: Args = { report: false, truth: null, cache: null, out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--help" || flag === "-h") out.help = true;
    else if (flag === "--report") out.report = true;
    else if (flag === "--truth" && value !== undefined) { out.truth = value; i++; }
    else if (flag === "--cache" && value !== undefined) { out.cache = value; i++; }
    else if (flag === "--out" && value !== undefined) { out.out = value; i++; }
    else return null;
  }
  if (out.report && (out.truth === null || out.cache === null || out.out === null)) return null;
  if (!out.report && (out.truth !== null || out.cache !== null || out.out !== null)) return null;
  return out;
}

/** The path when it lies under one of the allowed output directories and ends with `ext`, else null. */
function guardedOut(path: string, ext: string): string | null {
  for (const dir of OUT_DIRS) {
    const safe = guardedDataPath(path, { dir, ext });
    if (safe !== null) return safe;
  }
  return null;
}

/** An error reduced to its class name; the message can carry paths or request details, so it is never printed. */
const safeError = (error: unknown): string => (error instanceof Error ? error.name : "UNKNOWN");

/**
 * The newest stored read of the current version per Booli id (cache ids are `booli:<id>|<imageSetKey>`), as the
 * stored fact. Ties on the date are broken by the id so the choice is deterministic.
 */
function productionReads(cachePath: string): Map<number, LayoutFact> {
  const { cache, warning } = loadLayoutCache(cachePath);
  if (warning) console.log(warning);
  const newest = new Map<number, { storedAt: string; id: string; fact: LayoutFact }>();
  for (const entry of Object.values(cache.entries)) {
    if (entry.promptVersion !== LAYOUT_READ_VERSION) continue;
    const m = /^booli:(\d+)\|/.exec(entry.id);
    if (m === null) continue;
    const booliId = Number(m[1]);
    const prior = newest.get(booliId);
    if (prior !== undefined && (prior.storedAt > entry.storedAt || (prior.storedAt === entry.storedAt && prior.id > entry.id))) continue;
    newest.set(booliId, {
      storedAt: entry.storedAt,
      id: entry.id,
      fact: layoutFactFromRead(entry.result, { version: entry.promptVersion, booli: 0, broker: 0 }),
    });
  }
  return new Map([...newest].map(([id, v]) => [id, v.fact]));
}

const pct = (k: number, n: number): string => (n === 0 ? "-" : `${Math.round((100 * k) / n)} %`);

function report(args: Args & { truth: string; cache: string; out: string }): number {
  const jsonOut = guardedOut(args.out, ".json");
  if (jsonOut === null) {
    console.error(`--out måste vara en .json-fil under ${OUT_DIRS.join("/ eller ")}/`);
    return 1;
  }
  const file = layoutTruthFileSchema.parse(JSON.parse(readFileSync(args.truth, "utf8")));
  const reads = productionReads(args.cache);
  const r = accuracyReport(file, reads, { source: "production", version: LAYOUT_READ_VERSION });
  writeJsonAtomic(jsonOut, r);
  const { balcony, korsdrag, bedroom } = r.raw;
  console.log(
    `Rapport: ${r.rows} rader i urvalet, ${r.noRead} utan lagrad läsning; rå träffsäkerhet (utan spärr): ` +
      `balkong ${balcony.correct} av ${balcony.read} lästa (${pct(balcony.correct, balcony.read)}) av ${balcony.decided} avgjorda, ` +
      `korsdrag ${korsdrag.correct} av ${korsdrag.read} (${pct(korsdrag.correct, korsdrag.read)}) av ${korsdrag.decided}, ` +
      `sovrum ${bedroom.correct} av ${bedroom.read} (${pct(bedroom.correct, bedroom.read)}) av ${bedroom.decided}; skrivet till ${args.out}`,
  );
  return 0;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args === null || (!args.help && !args.report)) {
    console.log(USAGE);
    return 1;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    return report(args as Args & { truth: string; cache: string; out: string });
  } catch (error) {
    console.error("FEL:", safeError(error));
    return 1;
  }
}

process.exit(main());
