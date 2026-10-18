/**
 * Looks up the buildings of a stored snapshot's candidates at Stockholm stad and fills the city cache (Phase 14.6,
 * plan 09: CASE-01, STAM-03, FLAG-01). City traffic only: no Booli, no Hemnet, no broker page, no paid call.
 *
 *   npx tsx scripts/bygglov-candidates.ts --snapshot .planning/calibration/data/forsale-snapshot-2026-10-13.json
 *   npx tsx scripts/bygglov-candidates.ts --snapshot src/lib/discovery/__fixtures__/forsale-snapshot-folkungagatan-61.fixture.json \
 *       --dry-run --fixtures src/lib/stockholm/__fixtures__ --cache-dir .planning/calibration/data/bygglov-dry
 *
 * For every row of the snapshot (read only, never rewritten) it finds the building's fastighetsbeteckning (the text's if
 * the row carries one, else the cache, else the city's address search, then Min Karta as the last resort), reads the
 * building's case list and the few detail pages that matter, and saves what it learns in the city cache. The weekly job
 * and the replays read the cache; this tool is how it gets filled outside the weekly window. It prints how many
 * buildings were found by which rung and one coverage line for the case lists.
 *
 * THE RULES (D-01, D-11): every request goes through the gated clients (3 s per host, honest User-Agent, one attempt,
 * the 24 hour block after a refusal, the run lock). At most `--max-requests` requests (default 300) and 20 minutes. A
 * refusal (403, 429, a login wall, a terms page, a changed page) ends the run at once, with what was saved kept.
 * Refuses to start on Mondays between 06:30 and 09:30 (the weekly job owns that stretch).
 *
 * WRITES: the city cache under `--cache-dir` (default .planning/calibration/data/bygglov/), the host-gates file when a
 * host refuses, and the run lock. Nothing else; in particular never the snapshot.
 *
 * --dry-run reads saved pages (`--fixtures <dir>`) instead of the network, with a virtual clock and a throw-away
 * gates folder, and replaces `fetch` by a function that throws, so it can neither reach the network nor touch the real
 * block list. Exit codes: 0 done (a budget or deadline stop included), 1 bad arguments or a dry run that needed a page
 * it had no copy of, 2 the city or Min Karta refused, 3 the city is on the 24 hour block list.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseFitSnapshot } from "@/lib/discovery/fit-score";
import { acquireRunLock, type RunLock } from "@/lib/discovery/watch-state";
import { rungSummaryLine, type MinKartaResolver } from "@/lib/stockholm/beteckning";
import { BYGGLOV_CACHE_DIR } from "@/lib/stockholm/bygglov-cache";
import type { CityFetch } from "@/lib/stockholm/bygglov-client";
import { cityStageLine, runCityStage, type CityStageRow } from "@/lib/stockholm/city-stage";
import { makeFixtureFetch } from "@/lib/stockholm/fixture-fetch";
import {
  CITY_DATA_DIR,
  CITY_LOCK_PATH,
  HOST_GATES_PATH,
  assertManualRunAllowed,
  hostBlockedUntil,
  readHostGates,
} from "@/lib/stockholm/host-gate";

const DATA_DIR = ".planning/calibration/data";
const DEFAULT_DRY_CACHE_DIR = `${DATA_DIR}/bygglov-dry`;
const DEFAULT_MAX_REQUESTS = 300;
const MAX_REQUESTS_CEILING = 1000;

/** The rec number the saved detail page was captured with; a dry run swaps it for the one asked for. */
const DETAIL_TEMPLATE_FILE = "case-stambyte-2020-startbesked-slutbesked.fixture.html";
const DETAIL_TEMPLATE_REC = "1208902";

interface Args {
  snapshot: string;
  dryRun: boolean;
  fixtures: string | null;
  cacheDir: string;
  maxRequests: number;
}

function parseArgs(argv: readonly string[]): Args {
  const valued = new Set(["--snapshot", "--fixtures", "--cache-dir", "--max-requests"]);
  const known = new Set([...valued, "--dry-run"]);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!known.has(arg)) throw new Error(`Okänd flagga: ${arg.slice(0, 40)}`);
    if (valued.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} behöver ett värde`);
      values.set(arg, value);
      i += 1;
    } else {
      flags.add(arg);
    }
  }

  const snapshot = values.get("--snapshot");
  if (snapshot === undefined) throw new Error("--snapshot <fil> saknas (en sparad snapshot att slå upp byggnaderna i)");
  if (!snapshot.endsWith(".json")) throw new Error("--snapshot måste vara en .json-fil");

  const dryRun = flags.has("--dry-run");
  const fixtures = values.get("--fixtures") ?? null;
  if (fixtures !== null && !dryRun) throw new Error("--fixtures hör ihop med --dry-run (en skarp körning läser aldrig sparade sidor)");
  if (dryRun && fixtures === null) throw new Error("--dry-run behöver --fixtures <mapp med sparade sidor>");

  const cacheDir = values.get("--cache-dir") ?? (dryRun ? DEFAULT_DRY_CACHE_DIR : BYGGLOV_CACHE_DIR);
  const rel = relative(resolve(DATA_DIR), resolve(cacheDir));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`--cache-dir måste ligga under ${DATA_DIR}/ (fick ${cacheDir.slice(0, 120)})`);
  }

  const maxRaw = values.get("--max-requests");
  const maxRequests = maxRaw === undefined ? DEFAULT_MAX_REQUESTS : Number(maxRaw);
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > MAX_REQUESTS_CEILING) {
    throw new Error(`--max-requests måste vara ett heltal mellan 1 och ${MAX_REQUESTS_CEILING}`);
  }
  return { snapshot, dryRun, fixtures, cacheDir, maxRequests };
}

/** The snapshot's rows as the city stage wants them. The snapshot file is only read. */
function rowsOf(snapshotPath: string): { asOf: string; rows: CityStageRow[] } {
  const snapshot = parseFitSnapshot(JSON.parse(readFileSync(snapshotPath, "utf8")));
  return {
    asOf: snapshot.asOf,
    rows: snapshot.rows.map((row) => ({
      address: row.candidate.address ?? "",
      brfName: row.facts?.brfName ?? null,
      facts: row.facts,
    })),
  };
}

/** The pages a dry run can answer from the saved copies, by URL shape. Anything else is a 404 and fails the run. */
function dryRunFetch(fixtureDir: string, unrouted: string[]): CityFetch {
  const detailTemplate = readFileSync(join(fixtureDir, DETAIL_TEMPLATE_FILE), "utf8");
  const saved = makeFixtureFetch(fixtureDir, [
    { path: "/Byggochplantjansten/CaseSearch/AddressSearch", queryKey: "addressSearchField", queryValue: "Folkungagatan 61", file: "address-search-folkungagatan-61.fixture.html" },
    { path: "/Byggochplantjansten/CaseSearch/AddressSearch", queryKey: "addressSearchField", queryValue: "Hornsgatan 42", file: "address-search-hornsgatan-42.fixture.html" },
    // Every beteckning gets the Droskhästen 8 page; the client keeps only the exact matches of the one it asked for.
    { path: "/byggochplantjansten/arendeochhandlingar", queryKey: "RealEstateName", file: "list-droskhasten-8.fixture.html" },
  ]);
  return async (url, init) => {
    const detail = /\/byggochplantjansten\/arende\/arende\/(\d{1,12})$/i.exec(new URL(url).pathname);
    if (detail !== null) {
      return new Response(detailTemplate.replaceAll(DETAIL_TEMPLATE_REC, detail[1]), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    const response = await saved(url, init);
    if (response.status === 404) unrouted.push(new URL(url).pathname);
    return response;
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const { asOf, rows } = rowsOf(args.snapshot);
  if (rows.length === 0) throw new Error("Snapshoten har inga rader");

  // The network modules are loaded here, after the arguments are checked. A dry run hands them a fetch that reads saved pages.
  const { makeCityClient, CITY_HOST } = await import("@/lib/stockholm/bygglov-client");
  const { makeMinKartaResolver, MINKARTA_HOST } = await import("@/lib/stockholm/minkarta");

  const log = (line: string) => console.log(line);
  const realFetch = globalThis.fetch;
  const unrouted: string[] = [];
  let workDir: string | null = null;
  let lock: RunLock | null = null;
  let now: () => Date;
  let sleep: (ms: number) => Promise<void>;
  let cityFetch: CityFetch;
  let gatesPath = HOST_GATES_PATH;
  let dataDir = CITY_DATA_DIR;

  if (args.dryRun) {
    const fixtureDir = resolve(args.fixtures as string);
    if (!existsSync(fixtureDir)) throw new Error(`Mappen med sparade sidor finns inte: ${args.fixtures}`);
    workDir = mkdtempSync(join(tmpdir(), "bygglov-candidates-dry-"));
    gatesPath = join(workDir, "host-gates.json");
    dataDir = workDir;
    let t = Date.now();
    now = () => new Date(t);
    sleep = async (ms) => {
      t += ms;
    };
    cityFetch = dryRunFetch(fixtureDir, unrouted);
    globalThis.fetch = (() => {
      throw new Error("torrkörning: inget nätverk");
    }) as typeof fetch;
  } else {
    assertManualRunAllowed(new Date());
    mkdirSync(BYGGLOV_CACHE_DIR, { recursive: true });
    lock = acquireRunLock(CITY_LOCK_PATH);
    if (lock.warning !== null) log(`[stockholm] ${lock.warning}`);
    now = () => new Date();
    sleep = (ms) => new Promise((done) => setTimeout(done, ms));
    cityFetch = realFetch as CityFetch;
    const blockedUntil = hostBlockedUntil(readHostGates(gatesPath, log), CITY_HOST, now());
    if (blockedUntil !== null) {
      lock.release();
      console.error(`Stadens e-tjänst är spärrad till ${blockedUntil.toISOString()}. Ingen körning gjordes.`);
      return 3;
    }
  }

  try {
    mkdirSync(args.cacheDir, { recursive: true });
    const client = makeCityClient({ fetchImpl: cityFetch, sleep, now, log, gatesPath, dataDir, budget: args.maxRequests });

    // Rung (c) only on a live run and only while Min Karta is neither blocked nor turned off in host-gates.json.
    let minkarta: MinKartaResolver | null = null;
    if (!args.dryRun) {
      const minkartaBlocked = hostBlockedUntil(readHostGates(gatesPath, log), MINKARTA_HOST, now());
      if (minkartaBlocked === null) minkarta = makeMinKartaResolver({ fetchImpl: realFetch as CityFetch, sleep, now, log, gatesPath, dataDir });
      else log("[stockholm] Min Karta är spärrad eller avstängd: steg c är av");
    }

    const { facts, stats } = await runCityStage(rows, {
      mode: "live",
      asOf,
      cacheDir: args.cacheDir,
      client,
      minkarta,
      now,
      budget: args.maxRequests,
      log,
    });

    console.log(
      rungSummaryLine(
        facts.map((f) => ({ beteckning: f?.fastighetsbeteckning ?? null, rung: f?.beteckningRung ?? null })),
      ),
    );
    console.log(cityStageLine(stats));
    console.log(`Stadens cache: ${args.cacheDir}/ (ögonblicksbilden är orörd)`);

    if (unrouted.length > 0) {
      console.error(`Torrkörningen saknade sparade sidor för: ${[...new Set(unrouted)].slice(0, 5).join(", ")}`);
      return 1;
    }
    const refusal = stats.stopped !== null && stats.stopped !== "budget" && stats.stopped !== "tidsgrans";
    return refusal ? 2 : 0;
  } finally {
    if (args.dryRun) globalThis.fetch = realFetch;
    lock?.release();
    if (workDir !== null) rmSync(workDir, { recursive: true, force: true });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : "Okänt fel");
    process.exitCode = 1;
  },
);
