/**
 * valuation-report.ts - the offline before/after valuation report (Phase 14.4, VAL-05).
 *
 * Reads three run records written by `scripts/fit-score.ts --replay ... --json`:
 *   --before        the frozen pre-14.4 run (version-1 model, ceiling on)
 *   --intermediate  the old six features refitted on today's data (same bid premium)
 *   --after         the committed model, no ceiling
 * plus the snapshot all three replayed (--snapshot) and the committed model (--model), and writes
 * `valuation-report.md` and `valuation-report.json` to --out-dir (under .planning/phases/).
 *
 *     npx tsx scripts/valuation-report.ts --before <a.json> --intermediate <b.json> --after <c.json> \
 *       --snapshot <snapshot.json> --model data/hedonic-model.json --out-dir <katalog> \
 *       [--intermediate-model <modell.json>]
 *
 * --intermediate-model is the model the intermediate record was replayed with (default
 * .planning/calibration/data/hedonic-model-14.4-intermediate.json, gitignored). It is read to separate the days-on-market term
 * from the rest of the refit and to check that the intermediate record belongs to that model.
 *
 * Offline: no network, no API key, no paid call. Inputs are read-only .json files parsed with the
 * app's own schemas; the report is measured and changes no setting, model or scoring code.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFitSnapshot } from "@/lib/discovery/fit-score";
import { parseHedonicModel } from "@/lib/discovery/hedonic-model";
import { guardedDataPath, writeJsonAtomic, writeTextAtomic } from "@/lib/discovery/json-store";
import {
  buildValuationReport,
  counterfactualGaps,
  parseFitRunRecord,
  renderValuationReportMd,
} from "@/lib/discovery/valuation-report";

/** Where plan 03/04 left the intermediate model (the old six features refitted on today's data). */
const DEFAULT_INTERMEDIATE_MODEL = ".planning/calibration/data/hedonic-model-14.4-intermediate.json";

/** The only tree the report may be written to. */
const OUT_ROOT = ".planning/phases";

const USAGE = `Användning:
  npx tsx scripts/valuation-report.ts --before <fil.json> --intermediate <fil.json> --after <fil.json> --snapshot <fil.json> --model <fil.json> --out-dir <katalog> [--intermediate-model <fil.json>]

  --before        körningspost före ändringen (modell version 1, kredittak på)
  --intermediate  körningspost med de gamla sex egenskaperna omanpassade på dagens data
  --after         körningspost efter ändringen (den checkade modellen, inget tak)
  --snapshot      snapshoten alla tre körningarna spelades upp mot
  --model         den checkade modellen (data/hedonic-model.json)
  --intermediate-model  modellen mellanposten spelades upp med (standard ${DEFAULT_INTERMEDIATE_MODEL})
  --out-dir       katalog under ${OUT_ROOT}/ dit valuation-report.md och valuation-report.json skrivs
`;

interface Args {
  before: string;
  intermediate: string;
  after: string;
  snapshot: string;
  model: string;
  outDir: string;
  intermediateModel: string;
}

function parseArgs(argv: readonly string[]): Args | null {
  const found: Partial<Record<keyof Args, string>> = {};
  const names: Record<string, keyof Args> = {
    "--before": "before",
    "--intermediate": "intermediate",
    "--after": "after",
    "--snapshot": "snapshot",
    "--model": "model",
    "--out-dir": "outDir",
    "--intermediate-model": "intermediateModel",
  };
  for (let i = 0; i < argv.length; i++) {
    const key = names[argv[i]];
    const value = argv[i + 1];
    if (key === undefined || value === undefined) return null;
    found[key] = value;
    i++;
  }
  const { before, intermediate, after, snapshot, model, outDir } = found;
  if (!before || !intermediate || !after || !snapshot || !model || !outDir) return null;
  return { before, intermediate, after, snapshot, model, outDir, intermediateModel: found.intermediateModel ?? DEFAULT_INTERMEDIATE_MODEL };
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
  return JSON.parse(readFileSync(abs, "utf8")) as unknown;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    console.error(USAGE);
    process.exit(1);
  }

  const root = join(process.cwd(), OUT_ROOT);
  const mdPath = guardedDataPath(join(args.outDir, "valuation-report.md"), { dir: root, ext: ".md" });
  const jsonPath = guardedDataPath(join(args.outDir, "valuation-report.json"), { dir: root, ext: ".json" });
  if (mdPath === null || jsonPath === null) {
    console.error(`--out-dir måste ligga under ${OUT_ROOT}/`);
    process.exit(1);
  }

  try {
    const before = parseFitRunRecord(readJsonFile("--before", args.before));
    const intermediate = parseFitRunRecord(readJsonFile("--intermediate", args.intermediate));
    const after = parseFitRunRecord(readJsonFile("--after", args.after));
    const snapshot = parseFitSnapshot(readJsonFile("--snapshot", args.snapshot));
    const afterModel = parseHedonicModel(readJsonFile("--model", args.model));

    const intermediateModel = parseHedonicModel(readJsonFile("--intermediate-model", args.intermediateModel));

    const counterfactual = counterfactualGaps(snapshot.rows, afterModel);
    const intermediateCounterfactual = counterfactualGaps(snapshot.rows, intermediateModel);
    const report = buildValuationReport({
      before,
      intermediate,
      after,
      counterfactual,
      intermediateCounterfactual,
      afterModel,
      snapshotRows: snapshot.rows,
    });

    writeTextAtomic(mdPath, renderValuationReportMd(report));
    writeJsonAtomic(jsonPath, report);
    console.log(`Rapport skriven: ${mdPath}, ${jsonPath}`);
  } catch (error) {
    console.error(`Rapporten kunde inte byggas: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
