/**
 * The one-off stambyte sweep over the inner city (Phase 14.6, STAM-01, D-05, R-01, R-02).
 *
 *   npx tsx scripts/bygglov-sweep.ts --evidence .planning/phases/14.6-bygglov-stambyte-uppmatning/evidence/sweep.json
 *   npx tsx scripts/bygglov-sweep.ts --dry-run --fixtures src/lib/stockholm/__fixtures__ --districts Södermalm \
 *       --keywords stambyte --windows 1985-01-01:2026-10-18 --cache-dir .planning/calibration/data/bygglov-dry
 *
 * LIVE: for each stadsdel x search word x start-date window, ONE extended search (R-01: one response holds every
 * matching case, no paging), cached per query under `.planning/calibration/data/bygglov/sweep/`. A query that is
 * already cached and fresh is never asked again, so a stopped run resumes where it stopped. The search words come from
 * the spike's measured answer to "does the field match inside words" (R-07); the run refuses to start unless the spike
 * said GO.
 *
 * THE RULES (D-01, D-11): every request goes through the gated city client (3 s per host, honest User-Agent, one
 * attempt, a refusal puts the host on the 24 hour list and ends the run, run lock). The tool never starts, and stops
 * before the next request, on Mondays between 06:30 and 09:30 (R-02). At most `--max-requests` requests per run (default
 * 140). No request to any Booli or listing site, no paid call.
 *
 * --dry-run reads saved pages (`--fixtures <dir>`) instead of the network, uses a virtual clock and a throw-away block
 * list, ignores what is cached, and replaces the global `fetch` with a function that throws. A page with no saved
 * answer fails the run (it would have been a real request).
 *
 * What goes into the cache and the evidence: tags, case numbers, addresses, fastighetsbeteckningar, dates and counts
 * (bygglov-cache.ts, strict schemas). No name, no case text, no document list.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { acquireRunLock, type RunLock } from "@/lib/discovery/watch-state";
import { readJsonIfExists } from "@/lib/discovery/json-store";
import {
  BYGGLOV_CACHE_DIR,
  loadSweep,
  saveSweep,
  sweepNeedsRefresh,
  type SweepEntry,
  type SweepQuery,
} from "@/lib/stockholm/bygglov-cache";
import type { CityClient, CityFetch } from "@/lib/stockholm/bygglov-client";
import { makeFixtureFetch, type FixtureRoute } from "@/lib/stockholm/fixture-fetch";
import { CITY_DATA_DIR, CITY_LOCK_PATH, HOST_GATES_PATH, assertManualRunAllowed, hostBlockedUntil, readHostGates } from "@/lib/stockholm/host-gate";
import { SWEEP_DISTRICTS, summariseCases, sweepKeywords, sweepWindows, type SweepWindow } from "@/lib/discovery/stambyte-join";

const EVIDENCE_DIR = ".planning/phases/14.6-bygglov-stambyte-uppmatning/evidence";
const SPIKE_PATH = `${EVIDENCE_DIR}/spike.json`;
const DATA_DIR = ".planning/calibration/data";
const DEFAULT_MAX_REQUESTS = 140;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

interface Args {
  dryRun: boolean;
  fixtures: string | null;
  districts: string[];
  keywords: string[] | null;
  windows: SweepWindow[] | null;
  cacheDir: string;
  maxRequests: number;
  evidence: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function insideDir(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function parseWindows(text: string): SweepWindow[] {
  return text.split(",").map((part) => {
    const [from, to] = part.split(":");
    const end = to === undefined || to === "" || to === "open" ? null : to;
    if (!DATE.test(from ?? "") || (end !== null && !DATE.test(end)) || (end !== null && end < from)) {
      throw new Error(`--windows: använd FRÅN:TILL som ÅÅÅÅ-MM-DD (TILL får vara tomt eller "open"), fick "${part.slice(0, 30)}"`);
    }
    return { from, to: end };
  });
}

function parseArgs(argv: readonly string[]): Args {
  const valued = new Set(["--fixtures", "--districts", "--keywords", "--windows", "--cache-dir", "--max-requests", "--evidence"]);
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

  const dryRun = flags.has("--dry-run");
  const fixtures = values.get("--fixtures") ?? null;
  if (fixtures !== null && !dryRun) throw new Error("--fixtures hör ihop med --dry-run (en skarp körning läser aldrig sparade sidor)");
  if (dryRun && fixtures === null) throw new Error("--dry-run behöver --fixtures <mapp med sparade sidor>");
  const evidence = values.get("--evidence") ?? null;
  if (evidence !== null && dryRun) throw new Error("--evidence hör till en skarp körning");

  const districtsRaw = values.get("--districts");
  const districts = districtsRaw === undefined ? [...SWEEP_DISTRICTS] : districtsRaw.split(",").map((d) => d.trim()).filter((d) => d !== "");
  for (const d of districts) {
    if (!(SWEEP_DISTRICTS as readonly string[]).includes(d)) throw new Error(`--districts: okänd stadsdel "${d.slice(0, 30)}"`);
  }
  if (districts.length === 0) throw new Error("--districts: ingen stadsdel vald");

  const keywordsRaw = values.get("--keywords");
  const keywords = keywordsRaw === undefined ? null : keywordsRaw.split(",").map((k) => k.trim()).filter((k) => k !== "");
  if (keywords !== null) {
    if (keywords.length === 0) throw new Error("--keywords: inget sökord valt");
    for (const k of keywords) {
      if (!/^[\p{L}-]{2,30}$/u.test(k)) throw new Error(`--keywords: ogiltigt sökord "${k.slice(0, 30)}"`);
      if (k.toLocaleLowerCase("sv") === "va") throw new Error('--keywords: "VA" skickas aldrig (det finns i halva språket)');
    }
  }

  const windowsRaw = values.get("--windows");
  const windows = windowsRaw === undefined ? null : parseWindows(windowsRaw);

  const cacheDir = values.get("--cache-dir") ?? BYGGLOV_CACHE_DIR;
  if (!insideDir(cacheDir, DATA_DIR)) throw new Error(`--cache-dir måste ligga under ${DATA_DIR}/ (fick ${cacheDir.slice(0, 120)})`);

  const maxRaw = values.get("--max-requests");
  const maxRequests = maxRaw === undefined ? DEFAULT_MAX_REQUESTS : Number(maxRaw);
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 1000) throw new Error("--max-requests: ett heltal mellan 1 och 1000");

  if (evidence !== null) {
    if (!evidence.endsWith(".json") || !insideDir(evidence, EVIDENCE_DIR)) {
      throw new Error(`--evidence måste vara en .json-fil under ${EVIDENCE_DIR}/ (fick ${evidence.slice(0, 120)})`);
    }
  }
  return { dryRun, fixtures, districts, keywords, windows, cacheDir, maxRequests, evidence };
}

// ---------------------------------------------------------------------------
// The spike's verdict
// ---------------------------------------------------------------------------

/** Reads the spike report. A live run needs verdict "go"; the substring answer picks the search words. */
function readSpike(): { substring: boolean | null } {
  let raw: unknown;
  try {
    raw = readJsonIfExists(SPIKE_PATH);
  } catch {
    throw new Error(`Spikrapporten ${SPIKE_PATH} går inte att läsa. Ingen körning gjordes.`);
  }
  const spike = raw as { verdict?: unknown; substringTest?: { substring?: unknown } } | null;
  if (spike === null || spike.verdict !== "go") {
    throw new Error(`Spikrapporten ${SPIKE_PATH} saknas eller säger inte GO. Svepet startar inte.`);
  }
  const substring = spike.substringTest?.substring;
  return { substring: substring === true ? true : substring === false ? false : null };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

function planQueries(districts: readonly string[], keywords: readonly string[], windows: readonly SweepWindow[]): SweepQuery[] {
  const out: SweepQuery[] = [];
  for (const district of districts) {
    for (const description of keywords) {
      for (const w of windows) out.push({ district, description, from: w.from, to: w.to });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The dry-run's saved pages
// ---------------------------------------------------------------------------

/** The one saved extended search: Södermalm, "stambyte", every case since 1985. */
function dryRoutes(): FixtureRoute[] {
  return [
    {
      path: "/byggochplantjansten/arendeochhandlingar",
      queryKey: "Description",
      queryValue: "stambyte",
      file: "ext-sodermalm-stambyte-1985.fixture.html",
    },
  ];
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // Network modules are loaded here, after the arguments are checked. A dry run hands them a fetch that reads saved pages.
  const { makeCityClient, CityStop, CITY_HOST } = await import("@/lib/stockholm/bygglov-client");

  const log = (line: string) => console.log(line);
  const realFetch = globalThis.fetch;
  let workDir: string | null = null;
  let lock: RunLock | null = null;
  let now: () => Date;
  let sleep: (ms: number) => Promise<void>;
  let baseFetch: CityFetch;
  const unrouted: string[] = [];
  let gatesPath = HOST_GATES_PATH;
  let dataDir = CITY_DATA_DIR;
  let keywords: string[];

  if (args.dryRun) {
    const fixtureDir = resolve(args.fixtures as string);
    if (!existsSync(fixtureDir)) throw new Error(`Mappen med sparade sidor finns inte: ${args.fixtures}`);
    workDir = mkdtempSync(join(tmpdir(), "bygglov-sweep-dry-"));
    gatesPath = join(workDir, "host-gates.json");
    dataDir = workDir;
    let t = Date.now();
    now = () => new Date(t);
    sleep = async (ms) => {
      t += ms;
    };
    const fixtureFetch = makeFixtureFetch(fixtureDir, dryRoutes());
    baseFetch = async (url, init) => {
      const response = await fixtureFetch(url, init);
      if (response.status === 404) unrouted.push(new URL(url).pathname);
      return response;
    };
    globalThis.fetch = (() => {
      throw new Error("torrkörning: inget nätverk");
    }) as typeof fetch;
    keywords = args.keywords ?? sweepKeywords(null);
  } else {
    assertManualRunAllowed(new Date());
    const spike = readSpike();
    keywords = args.keywords ?? sweepKeywords(spike.substring);
    mkdirSync(BYGGLOV_CACHE_DIR, { recursive: true });
    mkdirSync(args.cacheDir, { recursive: true });
    lock = acquireRunLock(CITY_LOCK_PATH);
    if (lock.warning !== null) log(`[stockholm] ${lock.warning}`);
    now = () => new Date();
    sleep = (ms) => new Promise((done) => setTimeout(done, ms));
    baseFetch = realFetch as CityFetch;
    const blockedUntil = hostBlockedUntil(readHostGates(gatesPath, log), CITY_HOST, now());
    if (blockedUntil !== null) {
      lock.release();
      console.error(`Stadens e-tjänst är spärrad till ${blockedUntil.toISOString()}. Ingen körning gjordes.`);
      return 3;
    }
  }

  try {
    return await run();
  } finally {
    if (args.dryRun) globalThis.fetch = realFetch;
    lock?.release();
    if (workDir !== null) rmSync(workDir, { recursive: true, force: true });
  }

  async function run(): Promise<number> {
    let requests = 0;
    const countingFetch: CityFetch = async (url, init) => {
      requests += 1;
      return baseFetch(url, init);
    };
    const client: CityClient = makeCityClient({ fetchImpl: countingFetch, sleep, now, log, gatesPath, dataDir, budget: args.maxRequests });
    const plan = planQueries(args.districts, keywords, args.windows ?? sweepWindows());
    const entries: SweepEntry[] = [];

    try {
      for (const q of plan) {
        if (!args.dryRun) {
          const cached = loadSweep(q, { dir: args.cacheDir });
          if (cached.ok && !sweepNeedsRefresh(cached.entry, now())) {
            entries.push(cached.entry);
            continue;
          }
          assertManualRunAllowed(now());
        }
        const answer = await client.extendedSearch({ district: q.district, description: q.description, from: q.from, to: q.to ?? undefined });
        if (!answer.ok) throw new Error(`Svaret var för stort eller stämde inte med sitt antal (${answer.reason}); delning av tidsfönstret saknas ännu`);
        saveSweep(q, answer, { dir: args.cacheDir, now: now() });
        const saved = loadSweep(q, { dir: args.cacheDir });
        if (!saved.ok) throw new Error(`Sökningen sparades men gick inte att läsa tillbaka (${saved.error})`);
        entries.push(saved.entry);
      }
    } catch (error) {
      if (error instanceof CityStop) {
        console.error(`Svepet stoppat (${error.label}): ${entries.length} av ${plan.length} sökningar sparade`);
        return 2;
      }
      throw error;
    }

    const totals = summariseCases(entries.flatMap((e) => e.cases));
    console.log(
      `Svep: ${plural(entries.length, "sökning", "sökningar")}, ${totals.cases} ärenden, ${totals.beteckningar} fastigheter (stambyte ${totals.stambyte}, relining ${totals.relining})`,
    );
    console.log(`Anrop: ${requests}`);
    if (unrouted.length > 0) {
      console.error(`Torrkörningen bad om sidor som inte finns sparade (${[...new Set(unrouted)].join(", ")}): ett skarpt anrop hade gjorts.`);
      return 1;
    }
    return 0;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : "okänt fel");
    process.exit(1);
  },
);
