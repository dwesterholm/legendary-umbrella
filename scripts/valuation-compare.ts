/**
 * valuation-compare.ts - the offline 14.4 -> 14.5 valuation comparison (Phase 14.5-03, ENR-02, R-02).
 *
 * Reads two to four run records written by `scripts/fit-score.ts --replay ... --json` and writes
 * `valuation-compare.md` and `valuation-compare.json` to --out-dir (under .planning/phases/).
 * The tracked flat (default Folkungagatan 61, Booli id 150148) leads the report.
 *
 *     npx tsx scripts/valuation-compare.ts --before-record <a.json> --after-record <b.json> --out-dir <katalog> \
 *       [--intermediate-record <c.json>] [--after-record-cap12 <d.json>] [--track <booli-id>]
 *
 * Column labels default to the 14.4 -> 14.5 names; --label-before, --label-intermediate, --label-after
 * and --label-after-cap12 rename them (for a comparison of other records).
 *
 * Offline: no network, no API key, no paid call. Inputs are read-only .json files parsed with the
 * app's own schemas; the report is measured and changes no setting, model or scoring code.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { guardedDataPath, writeJsonAtomic, writeTextAtomic } from "@/lib/discovery/json-store";
import {
  buildValuationCompare,
  renderValuationCompareMd,
  type CompareColumnInput,
} from "@/lib/discovery/valuation-compare";
import { FOLKUNGAGATAN_61_BOOLI_ID, parseFitRunRecord } from "@/lib/discovery/valuation-report";

/** The only tree the report may be written to. */
const OUT_ROOT = ".planning/phases";

const USAGE = `Användning:
  npx tsx scripts/valuation-compare.ts --before-record <fil.json> --after-record <fil.json> --out-dir <katalog> [--intermediate-record <fil.json>] [--after-record-cap12 <fil.json>] [--track <booli-id>]

  --before-record        körningspost som jämförelsen utgår från (14.4:s "efter"-post)
  --intermediate-record  valfri mellanpost (nya koden, gamla modellen)
  --after-record         körningspost efter ändringen (14.5, steg-2-tak ±8 %)
  --after-record-cap12   valfri körningspost med steg-2-taket vidgat till ±12 %
  --out-dir              katalog under ${OUT_ROOT}/ dit valuation-compare.md och valuation-compare.json skrivs
  --track                Booli-id för lägenheten som leder rapporten (standard ${FOLKUNGAGATAN_61_BOOLI_ID}, Folkungagatan 61)
  --label-before, --label-intermediate, --label-after, --label-after-cap12   egna kolumnnamn
`;

interface Args {
  beforeRecord: string;
  intermediateRecord: string | null;
  afterRecord: string;
  afterRecordCap12: string | null;
  outDir: string;
  track: number;
  labelBefore: string;
  labelIntermediate: string;
  labelAfter: string;
  labelAfterCap12: string;
}

type ArgKey =
  | "beforeRecord"
  | "intermediateRecord"
  | "afterRecord"
  | "afterRecordCap12"
  | "outDir"
  | "track"
  | "labelBefore"
  | "labelIntermediate"
  | "labelAfter"
  | "labelAfterCap12";

function parseArgs(argv: readonly string[]): Args | null {
  const found: Partial<Record<ArgKey, string>> = {};
  const names: Record<string, ArgKey> = {
    "--before-record": "beforeRecord",
    "--intermediate-record": "intermediateRecord",
    "--after-record": "afterRecord",
    "--after-record-cap12": "afterRecordCap12",
    "--out-dir": "outDir",
    "--track": "track",
    "--label-before": "labelBefore",
    "--label-intermediate": "labelIntermediate",
    "--label-after": "labelAfter",
    "--label-after-cap12": "labelAfterCap12",
  };
  for (let i = 0; i < argv.length; i++) {
    const key = Object.hasOwn(names, argv[i]) ? names[argv[i]] : undefined;
    const value = argv[i + 1];
    if (key === undefined || value === undefined) return null;
    found[key] = value;
    i++;
  }
  const { beforeRecord, afterRecord, outDir } = found;
  if (!beforeRecord || !afterRecord || !outDir) return null;
  const track = found.track === undefined ? FOLKUNGAGATAN_61_BOOLI_ID : Number(found.track);
  if (!Number.isInteger(track) || track <= 0) return null;
  return {
    beforeRecord,
    intermediateRecord: found.intermediateRecord ?? null,
    afterRecord,
    afterRecordCap12: found.afterRecordCap12 ?? null,
    outDir,
    track,
    labelBefore: found.labelBefore ?? "14.4 (efter)",
    labelIntermediate: found.labelIntermediate ?? "14.5-kod, 14.4-modell",
    labelAfter: found.labelAfter ?? "14.5 ±8 %",
    labelAfterCap12: found.labelAfterCap12 ?? "14.5 ±12 %",
  };
}

/** Reads a .json file as untrusted JSON, or stops with a Swedish message. */
function readJsonFile(label: string, path: string): unknown {
  if (!path.toLowerCase().endsWith(".json")) {
    console.error(`${label} måste vara en .json-fil (fick ${path})`);
    process.exit(1);
  }
  const abs = resolve(path);
  if (!existsSync(abs)) {
    console.error(`${label}: filen saknas: ${path}`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(abs, "utf8")) as unknown;
  } catch (error) {
    console.error(`${label}: filen kunde inte läsas som JSON`);
    throw error;
  }
}

/** Reads and parses one run record; on a parse failure names the flag (never the content) first. */
function readRecord(label: string, path: string): ReturnType<typeof parseFitRunRecord> {
  const json = readJsonFile(label, path);
  try {
    return parseFitRunRecord(json);
  } catch (error) {
    console.error(`${label}: ogiltig körningspost`);
    throw error;
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    console.error(USAGE);
    process.exit(1);
  }

  const root = join(process.cwd(), OUT_ROOT);
  const mdPath = guardedDataPath(join(args.outDir, "valuation-compare.md"), { dir: root, ext: ".md" });
  const jsonPath = guardedDataPath(join(args.outDir, "valuation-compare.json"), { dir: root, ext: ".json" });
  if (mdPath === null || jsonPath === null) {
    console.error(`--out-dir måste ligga under ${OUT_ROOT}/`);
    process.exit(1);
  }

  try {
    const columns: CompareColumnInput[] = [
      { label: args.labelBefore, record: readRecord("--before-record", args.beforeRecord) },
    ];
    if (args.intermediateRecord !== null) {
      columns.push({ label: args.labelIntermediate, record: readRecord("--intermediate-record", args.intermediateRecord) });
    }
    columns.push({ label: args.labelAfter, record: readRecord("--after-record", args.afterRecord) });
    if (args.afterRecordCap12 !== null) {
      columns.push({ label: args.labelAfterCap12, record: readRecord("--after-record-cap12", args.afterRecordCap12) });
    }

    const compare = buildValuationCompare({ columns, trackId: args.track });

    writeTextAtomic(mdPath, renderValuationCompareMd(compare));
    writeJsonAtomic(jsonPath, compare);
    console.log(`Jämförelse skriven: ${mdPath}, ${jsonPath}`);
  } catch (error) {
    console.error(`Jämförelsen kunde inte byggas: ${error instanceof Error ? error.constructor.name : "okänt fel"}`);
    process.exit(1);
  }
}

main();
