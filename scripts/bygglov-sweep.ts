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
import { z } from "zod/v4";
import { acquireRunLock, type RunLock } from "@/lib/discovery/watch-state";
import { readJsonIfExists } from "@/lib/discovery/json-store";
import {
  BYGGLOV_CACHE_DIR,
  loadSweep,
  saveGuardedJson,
  saveSweep,
  sweepNeedsRefresh,
  type SweepQuery,
} from "@/lib/stockholm/bygglov-cache";
import type { CityClient, CityFetch } from "@/lib/stockholm/bygglov-client";
import { makeFixtureFetch, type FixtureRoute } from "@/lib/stockholm/fixture-fetch";
import { CITY_DATA_DIR, CITY_LOCK_PATH, HOST_GATES_PATH, assertManualRunAllowed, hostBlockedUntil, readHostGates } from "@/lib/stockholm/host-gate";
import {
  SWEEP_DISTRICTS,
  collectSweep,
  planSweep,
  runSweep,
  summariseCases,
  sweepKeywords,
  sweepWindows,
  type RunSweepDeps,
  type SweepWindow,
} from "@/lib/discovery/stambyte-join";

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
// The run state: what a stopped run must not forget
// ---------------------------------------------------------------------------

const SECONDS_KEPT = 2000;

const splitSchema = z.strictObject({
  district: z.string().min(1).max(60),
  description: z.string().min(1).max(60),
  from: z.string().regex(DATE),
  to: z.string().regex(DATE).nullable(),
  reason: z.enum(["storlek", "antal"]),
});

const stateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** Requests made to the city across all runs on this cache. */
  requests: z.number().int().nonnegative(),
  /** Seconds the city took per request (the last 2000). */
  seconds: z.array(z.number().nonnegative()).max(SECONDS_KEPT),
  /** Queries that were split, so a resumed run never asks them whole again. */
  splits: z.array(splitSchema).max(2000),
  /** Capped single years that could not be split. */
  unsplittable: z.array(splitSchema).max(2000),
});

type RunState = z.infer<typeof stateSchema>;

const emptyState = (): RunState => ({ schemaVersion: 1, requests: 0, seconds: [], splits: [], unsplittable: [] });
const statePath = (cacheDir: string) => join(cacheDir, "sweep-state.json");

/** A damaged state file is said out loud and starts a new one: the cache files themselves are what counts. */
function loadState(cacheDir: string, log: (line: string) => void): RunState {
  try {
    const raw = readJsonIfExists(statePath(cacheDir));
    if (raw === null) return emptyState();
    const parsed = stateSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    log("[svep] sweep-state.json har fel format och börjar om (cachefilerna behålls)");
  } catch {
    log("[svep] sweep-state.json går inte att läsa och börjar om (cachefilerna behålls)");
  }
  return emptyState();
}

const saveState = (cacheDir: string, state: RunState) => saveGuardedJson(statePath(cacheDir), state, cacheDir);

const sameQuery = (a: SweepQuery) => (b: { district: string; description: string; from: string; to: string | null }) =>
  a.district === b.district && a.description === b.description && a.from === b.from && a.to === b.to;

const queryKey = (q: SweepQuery) => `${q.district}|${q.description}|${q.from}|${q.to ?? "open"}`;

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const secondsText = (value: number | null) => (value === null ? "-" : value.toFixed(1).replace(".", ","));

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
    const isoDay = (d: Date) => d.toISOString().slice(0, 10);
    const state = args.dryRun ? emptyState() : loadState(args.cacheDir, log);
    const persist = () => {
      if (!args.dryRun) saveState(args.cacheDir, state);
    };

    // Seconds per request come from the client's own log lines ("<host>/<path> HTTP 200, 114 kB, 3,3 s").
    const clientLog = (line: string) => {
      log(line);
      if (!line.includes(`${CITY_HOST}/`)) return;
      const m = /(\d+),(\d) s\)?$/.exec(line);
      if (m !== null) state.seconds = [...state.seconds, Number(`${m[1]}.${m[2]}`)].slice(-SECONDS_KEPT);
    };
    const countingFetch: CityFetch = async (url, init) => {
      state.requests += 1;
      return baseFetch(url, init);
    };
    const client: CityClient = makeCityClient({ fetchImpl: countingFetch, sleep, now, log: clientLog, gatesPath, dataDir, budget: args.maxRequests });

    const windows = args.windows ?? sweepWindows();
    const plan = planSweep(args.districts, keywords, windows, () => false);
    const today = isoDay(now());
    const savedThisRun = new Set<string>();

    /** The cache file of a query when it is there and fresh. A dry run trusts only what it saved itself. */
    const loadFresh = (q: SweepQuery) => {
      if (args.dryRun && !savedThisRun.has(queryKey(q))) return null;
      const loaded = loadSweep(q, { dir: args.cacheDir });
      if (!loaded.ok || sweepNeedsRefresh(loaded.entry, now())) return null;
      return loaded.entry;
    };

    const deps: RunSweepDeps = {
      search: async (q) => {
        try {
          return await client.extendedSearch({ district: q.district, description: q.description, from: q.from, to: q.to ?? undefined });
        } finally {
          persist();
        }
      },
      isFresh: (q) => loadFresh(q) !== null,
      save: (q, answer) => {
        saveSweep(q, answer, { dir: args.cacheDir, now: now() });
        savedThisRun.add(queryKey(q));
      },
      splitRecorded: (q) => state.splits.some(sameQuery(q)),
      recordSplit: (q, reason) => {
        state.splits.push({ district: q.district, description: q.description, from: q.from, to: q.to, reason });
        persist();
      },
      recordUnsplittable: (q, reason) => {
        if (!state.unsplittable.some(sameQuery(q))) state.unsplittable.push({ district: q.district, description: q.description, from: q.from, to: q.to, reason });
        persist();
      },
      now,
      allowed: (at) => {
        if (!args.dryRun) assertManualRunAllowed(at);
      },
      stopOf: (error) => (error instanceof CityStop ? error.label : null),
      log,
      today,
    };

    const result = await runSweep(plan, deps);
    persist();

    const collection = collectSweep(plan, {
      load: (q) => loadFresh(q),
      splitRecorded: deps.splitRecorded,
      today,
    });
    const totals = summariseCases(collection.leaves.flatMap((l) => l.cases));
    console.log(
      `Svep: ${plural(collection.leaves.length, "sökning", "sökningar")}, ${totals.cases} ärenden, ${totals.beteckningar} fastigheter (stambyte ${totals.stambyte}, relining ${totals.relining})`,
    );
    console.log(
      `Anrop: ${state.requests}, median ${secondsText(median(state.seconds))} s per anrop, ${plural(result.splits.length, "delning", "delningar")} i den här körningen, ${result.saved} av ${result.total} sökningar sparade`,
    );
    for (const q of result.unsplittable) {
      console.error(`Saknas: ${q.district} ${q.description} ${q.from}..${q.to ?? "idag"} (ett enda år vars antal inte går att lita på)`);
    }
    if (unrouted.length > 0) {
      console.error(`Torrkörningen bad om sidor som inte finns sparade (${[...new Set(unrouted)].join(", ")}): ett skarpt anrop hade gjorts.`);
      return 1;
    }
    if (result.message !== null) {
      console.error(result.message);
      return 2;
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
