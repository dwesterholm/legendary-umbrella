/**
 * Download of the innerstan OpenStreetMap buildings and named streets (Phase 14.3, R-05, SUN-01).
 *
 *   npx tsx scripts/osm-download.ts                           hämta bara om cachen saknas eller är 31 dagar gammal eller äldre
 *   npx tsx scripts/osm-download.ts --force                   hämta alltid
 *   npx tsx scripts/osm-download.ts --import-research <dir>   bygg cachen av de tre researchfilerna i stället för nätet
 *
 * It is free: the public Overpass servers need no key and no account, and nothing here touches
 * Anthropic, Apify or Booli. Three bbox queries (buildings as ways, building relations with member
 * geometry, named highway ways) are sent one at a time to a fixed list of four Overpass hosts, with
 * retries and pauses (src/lib/discovery/osm-overpass.ts). The answer is written as ONE compact JSON file,
 * .planning/calibration/data/osm/innerstan.json (gitignored, about 20 MB), in the file contract that
 * src/lib/discovery/osm-buildings.ts parses.
 *
 * The 31-day rule (SUN-05): without --force the download happens only when the file is missing,
 * unreadable, 31 days old or older (boundary inclusive), or has a fetchedAt that is wrong. A fresh
 * cache prints "OSM-cache: <ålder> dagar gammal, ingen hämtning (gräns 31 dagar)" and makes no network call.
 *
 * A failed download keeps the old file untouched and exits 1. The file is written only after all three
 * queries succeeded (temp file, then rename).
 *
 * Fallback (Overpass dead): --import-research <dir> builds the same file from the three research
 * downloads of 2026-10-13 (osm-innerstan-buildings.json, osm-innerstan-building-relations.json,
 * osm-innerstan-roads.json). Their box is 59.30-59.35 N, 17.99-18.12 E, so a flat within 250 m of that
 * edge sees less map. Use it only when three live attempts over about half an hour have failed.
 *
 * Licence: map data (c) OpenStreetMap contributors, ODbL. The file carries the attribution and is never committed.
 * Secret posture: no key exists on this path, and nothing from the environment is read or printed.
 */
import { readFileSync, statSync } from "node:fs";
import { OSM_CACHE_DIR, OSM_CACHE_PATH, OSM_REFRESH_DAYS, refreshOsmCacheIfStale } from "@/lib/discovery/osm-cache";
import { downloadOsmExtract, importResearchExtract } from "@/lib/discovery/osm-overpass";
import { guardedDataPath } from "@/lib/discovery/json-store";

const USAGE = `Användning:
  npx tsx scripts/osm-download.ts [--force] [--path <fil>]
  npx tsx scripts/osm-download.ts --import-research <katalog> [--path <fil>]

Hämtar byggnader och namngivna gator för innerstan från Overpass (gratis, ingen nyckel) och sparar dem i
${OSM_CACHE_PATH} (gitignorerad, cirka 20 MB). Utan flaggor hämtas bara om cachen saknas eller är ${OSM_REFRESH_DAYS} dagar gammal eller äldre;
en färsk cache ger raden "OSM-cache: <ålder> dagar gammal, ingen hämtning (gräns ${OSM_REFRESH_DAYS} dagar)" och inget nätanrop.

  --force                 Hämta oavsett cachens ålder
  --path <fil>            Cachefil, standard ${OSM_CACHE_PATH} (måste ligga under ${OSM_CACHE_DIR}/ och sluta på .json)
  --import-research <dir> Bygg cachen av researchfilerna från 2026-10-13 i stället för nätet (reserv när Overpass ligger nere)
  --help                  Visa den här texten

Slutkoder: 0 klart (färsk cache eller lyckad hämtning), 1 fel (argument, misslyckad hämtning; en gammal cache lämnas orörd).`;

interface Args {
  force: boolean;
  path: string;
  importDir: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): Args | null {
  const out: Args = { force: false, path: OSM_CACHE_PATH, importDir: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--help" || flag === "-h") out.help = true;
    else if (flag === "--force") out.force = true;
    else if (flag === "--path" && value !== undefined) { out.path = value; i++; }
    else if (flag === "--import-research" && value !== undefined) { out.importDir = value; i++; }
    else return null;
  }
  return out;
}

const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1).replace(".", ",");

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
  // Refuse a path the save would refuse, before any request is sent (T-14.3-03).
  if (guardedDataPath(args.path, { dir: OSM_CACHE_DIR, ext: ".json" }) === null) {
    console.error(`--path måste ligga under ${OSM_CACHE_DIR}/ och sluta på .json (fick "${args.path}")`);
    process.exit(1);
  }

  const importDir = args.importDir;
  const download =
    importDir !== null
      ? async () => importResearchExtract(importDir, { readText: (p) => readFileSync(p, "utf8") })
      : () =>
          downloadOsmExtract({
            fetchImpl: globalThis.fetch,
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            now: () => new Date(),
            log: (line) => console.log(line),
          });

  const startedAt = Date.now();
  // An explicit import is a command, not a freshness question: it always runs.
  const result = await refreshOsmCacheIfStale({ path: args.path, now: new Date(), force: args.force || importDir !== null, download });
  console.log(result.message);

  if (result.action === "downloaded") {
    console.log(`Filstorlek: ${mb(statSync(args.path).size)} MB, ${((Date.now() - startedAt) / 1000).toFixed(1).replace(".", ",")} s`);
    if (result.meta?.source) console.log(`Källa: ${result.meta.source}`);
    console.log("Kartdata: © OpenStreetMap contributors, ODbL");
  }
  if (result.action === "failed-kept-old" || result.action === "failed-no-cache") process.exit(1);
}

main().catch((e) => {
  console.error("FEL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
