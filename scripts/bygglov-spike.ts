/**
 * The live spike on Stockholm stad's building-permit list (Phase 14.6, CASE-03, D-01, D-04, R-06, R-07).
 *
 *   npx tsx scripts/bygglov-spike.ts --out .planning/phases/14.6-bygglov-stambyte-uppmatning/evidence/spike.json
 *   npx tsx scripts/bygglov-spike.ts --dry-run --fixtures src/lib/stockholm/__fixtures__ --only 150148 \
 *       --out .planning/calibration/data/bygglov-spike-dry.json
 *
 * LIVE: robots.txt, then Lantmäteriet Min Karta once for Folkungagatan 61 (does it accept our honest User-Agent?), then
 * for each of the 13 buildings of D-04 the way from street address to fastighetsbeteckning, the city's case list and a
 * few detail pages, then two narrow searches that tell whether the "Beskrivning" field matches inside words ("ambyte"
 * against "stambyte"). It writes a machine-readable report (`--out`, a .json) and the same in Swedish beside it (.md),
 * and the report carries the verdict GO or STOPP that plans 05-12 wait for.
 *
 * THE RULES (D-01, D-11): every request goes through the gated clients (3 s per host, honest User-Agent, one attempt,
 * 24 hour block on a refusal, run lock); never a request outside them. At most 70 city requests and 5 Min Karta
 * requests. A refusal (403, 429, a login wall, a terms page, a changed page shape, a redirect) ends the run at once and
 * the report is still written, with verdict STOPP. Min Karta refusing is not a STOPP: the host is turned off for good
 * (`disabled`) and the other ways of finding a fastighetsbeteckning stay. No request to any Booli or listing site, no
 * paid call. Refuses to start on Mondays between 06:30 and 09:30.
 *
 * --dry-run reads saved pages (`--fixtures <dir>`) instead of the network, writes only under
 * `.planning/calibration/data/` and uses a throw-away cache folder, so it can never touch the live cache or the block
 * list. `fetch` is replaced by a function that throws, so any code path that reached for the real one would fail.
 *
 * What goes into the report: addresses and fastighetsbeteckningar (public property data), counts, case tags, years and
 * months, and seconds per request. No handler name, no document list, no case text (strict schema, spike-report.ts).
 */
import { mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { acquireRunLock, type RunLock } from "@/lib/discovery/watch-state";
import { writeJsonAtomic, writeTextAtomic } from "@/lib/discovery/json-store";
import { BYGGLOV_CACHE_DIR, refreshCaseListIfStale, saveCaseList, type AddressRung } from "@/lib/stockholm/bygglov-cache";
import {
  KIND_PRIORITY,
  applyDetail,
  buildingFactsOf,
  decisionKind,
  needsDetail,
  type StoredCase,
} from "@/lib/stockholm/bygglov-classify";
import { resolveBeteckning, type BeteckningResult, type MinKartaResolver } from "@/lib/stockholm/beteckning";
import { beteckningGuessFromBrfName } from "@/lib/stockholm/beteckning-text";
import type { CityClient, CityFetch } from "@/lib/stockholm/bygglov-client";
import { makeFixtureFetch, type FixtureRoute } from "@/lib/stockholm/fixture-fetch";
import {
  CITY_DATA_DIR,
  CITY_LOCK_PATH,
  HOST_GATES_PATH,
  assertManualRunAllowed,
  blockHost,
  hostBlockedUntil,
  readHostGates,
} from "@/lib/stockholm/host-gate";
import {
  SPIKE_BUILDINGS,
  SPIKE_STOP_LABELS,
  buildSpikeReport,
  readRobots,
  renderSpikeMarkdown,
  stambyteYearsOf,
  type MinKartaStatus,
  type SpikeBuilding,
  type SpikeBuildingRecord,
  type SpikeReport,
} from "@/lib/stockholm/spike-report";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** At most this many city requests in a run (robots, lookups, case lists, detail pages, the two searches). */
const CITY_BUDGET = 70;
/** At most this many Min Karta requests in a run, the probe included. */
const MINKARTA_BUDGET = 5;
/** Rung (c) is tried for at most this many addresses after the probe. */
const MINKARTA_RUNG_MAX_ADDRESSES = 3;
/** Detail pages read per building. */
const MAX_DETAILS_PER_BUILDING = 3;
/** The two searches of the substring test need these requests at the end of the run. */
const PROBE_RESERVE = 2;
/** Each building still to come needs at least the address lookup and the list. */
const PER_BUILDING_RESERVE = 2;
/** Three failures in a row (none of them a refusal) end the run. */
const MAX_CONSECUTIVE_FAILURES = 3;

const EVIDENCE_DIR = ".planning/phases/14.6-bygglov-stambyte-uppmatning/evidence";
const DATA_DIR = ".planning/calibration/data";
const DEFAULT_LIVE_OUT = `${EVIDENCE_DIR}/spike.json`;
const DEFAULT_DRY_OUT = `${DATA_DIR}/bygglov-spike-dry.json`;

/** The probe address: Folkungagatan 61, the building the whole phase is checked against. */
const PROBE_ADDRESS = SPIKE_BUILDINGS[0].address;

/** Min Karta answers that mean "no to our User-Agent" (the resolver has already put the host on the 24 hour list). */
const MINKARTA_REFUSAL_REASONS = ["http-403", "http-429", "fel-innehallstyp"];

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

interface Args {
  dryRun: boolean;
  fixtures: string | null;
  only: string[] | null;
  out: string;
}

function parseArgs(argv: readonly string[]): Args {
  const known = new Set(["--dry-run", "--fixtures", "--only", "--out"]);
  const valued = new Set(["--fixtures", "--only", "--out"]);
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

  const onlyRaw = values.get("--only");
  const only = onlyRaw === undefined ? null : onlyRaw.split(",").map((id) => id.trim()).filter((id) => id !== "");
  if (only !== null) {
    const known = new Set(SPIKE_BUILDINGS.flatMap((b) => b.booliIds));
    for (const id of only) if (!known.has(id)) throw new Error(`--only: okänt Booli-id ${id.slice(0, 12)}`);
  }

  const out = values.get("--out") ?? (dryRun ? DEFAULT_DRY_OUT : DEFAULT_LIVE_OUT);
  const resolved = resolve(out);
  const allowedDirs = dryRun ? [DATA_DIR] : [EVIDENCE_DIR, DATA_DIR];
  const inside = allowedDirs.some((dir) => {
    const rel = relative(resolve(dir), resolved);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  });
  if (!inside) {
    throw new Error(`--out måste ligga under ${allowedDirs.join(" eller ")}/ (fick ${out.slice(0, 120)})`);
  }
  if (!resolved.endsWith(".json")) throw new Error("--out måste vara en .json-fil");
  return { dryRun, fixtures, only, out: resolved };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const norm = (s: string | null): string | null => (s === null ? null : s.replace(/\s+/g, " ").trim().toLocaleLowerCase("sv"));

/** A fetch error that is a refused redirect (we send `redirect: "error"`): undici says "unexpected redirect". */
function looksLikeRedirect(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = (error as Error & { cause?: unknown }).cause;
  const causeText = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return /redirect/i.test(`${error.message} ${causeText}`);
}

/** Seconds from the client log lines of one host ("<host>/<path> HTTP 200, 263 kB, 3,3 s" or "... HTTP 403 (0,4 s)"). */
function secondsIn(lines: readonly string[], host: string): number[] {
  const out: number[] = [];
  for (const line of lines) {
    if (!line.includes(`${host}/`)) continue;
    const m = /(\d+),(\d) s\)?$/.exec(line);
    if (m !== null) out.push(Number(`${m[1]}.${m[2]}`));
  }
  return out;
}

/** The rungs that were tried for one lookup, in order. A cached answer says only the rung that answered then. */
function rungsTriedFor(result: BeteckningResult, hadGuess: boolean, minkartaOn: boolean): AddressRung[] {
  if (result.fromCache) return result.rung === null ? [] : [result.rung];
  const order: AddressRung[] = [...(hadGuess ? (["a2"] as const) : []), "b", ...(minkartaOn ? (["c"] as const) : [])];
  if (result.rung === null) return order;
  const upTo = order.indexOf(result.rung);
  return upTo < 0 ? [result.rung] : order.slice(0, upTo + 1);
}

function blankRecord(b: SpikeBuilding): SpikeBuildingRecord {
  return {
    booliIds: [...b.booliIds],
    address: b.address,
    constructionYear: b.constructionYear,
    rungsTried: [],
    rung: null,
    beteckning: null,
    status: "avbruten",
    fromCache: false,
    buildCases: null,
    otherCases: null,
    kinds: {},
    stambyteYears: [],
    stambyteOngoing: null,
    balconyCases: [],
    recentInteresting: [],
    detailPagesRead: 0,
    requestSeconds: [],
    notes: [],
    refusal: null,
  };
}

const BALCONY_KINDS = new Set(["balkong_ny", "balkong_inglasning", "balkongdorr", "balkong_renovering"]);

function balconyCasesOf(cases: readonly StoredCase[]): SpikeBuildingRecord["balconyCases"] {
  return cases
    .filter((c) => !c.tillsyn && c.kinds.some((k) => BALCONY_KINDS.has(k)))
    .sort((a, b) => b.startDate.localeCompare(a.startDate))
    .slice(0, 30)
    .map((c) => ({
      kind: KIND_PRIORITY.find((k) => c.kinds.includes(k) && BALCONY_KINDS.has(k)) ?? "balkong_ny",
      month: c.startDate.slice(0, 7),
      decision: !c.detailRead ? null : c.slutbeskedDate !== null ? "slutbesked" : c.latest === null ? null : decisionKind(c.latest.type, c.latest.code),
    }));
}

function kindCounts(cases: readonly StoredCase[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of cases) for (const kind of c.kinds) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
}

// ---------------------------------------------------------------------------
// The dry-run's saved pages
// ---------------------------------------------------------------------------

const DETAIL_FIXTURES: Readonly<Record<string, string>> = {
  "15347864": "case-stambyte-2006-archived.fixture.html",
  "1150705": "case-balkong-2017-avskrivet.fixture.html",
  "1208902": "case-stambyte-2020-startbesked-slutbesked.fixture.html",
};

function dryRoutes(): FixtureRoute[] {
  return [
    { path: "/robots.txt", body: "User-agent: *\nAllow: /\n", contentType: "text/plain; charset=utf-8" },
    {
      path: "/Byggochplantjansten/CaseSearch/AddressSearch",
      queryKey: "addressSearchField",
      queryValue: "Folkungagatan 61",
      file: "address-search-folkungagatan-61.fixture.html",
    },
    {
      path: "/byggochplantjansten/arendeochhandlingar",
      queryKey: "RealEstateName",
      queryValue: "Droskhästen 8",
      file: "list-droskhasten-8.fixture.html",
    },
    ...Object.entries(DETAIL_FIXTURES).map(([rec, file]) => ({ path: `/Byggochplantjansten/arende/arende/${rec}`, file })),
  ];
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const selected = SPIKE_BUILDINGS.filter((b) => args.only === null || b.booliIds.some((id) => args.only?.includes(id)));
  if (selected.length === 0) throw new Error("Inga byggnader valda");

  // Network modules are loaded here, after the arguments are checked. A dry run hands them a fetch that reads saved pages.
  const { makeCityClient, CityStop, CITY_HOST } = await import("@/lib/stockholm/bygglov-client");
  const { makeMinKartaResolver, MINKARTA_HOST } = await import("@/lib/stockholm/minkarta");

  const logs: string[] = [];
  const log = (line: string) => {
    logs.push(line);
    console.log(line);
  };

  // Clock, sleep, fetch and folders: real for a live run, virtual and throw-away for a dry run.
  let workDir: string | null = null;
  let lock: RunLock | null = null;
  let now: () => Date;
  let sleep: (ms: number) => Promise<void>;
  let baseFetch: CityFetch;
  /** Dry run: paths the saved pages had no answer for. Any one of them fails the run (it would have been a real request). */
  const unrouted: string[] = [];
  let gatesPath = HOST_GATES_PATH;
  let dataDir = CITY_DATA_DIR;
  let cacheDir: string | undefined;
  const realFetch = globalThis.fetch;

  if (args.dryRun) {
    const fixtureDir = resolve(args.fixtures as string);
    if (!existsSync(fixtureDir)) throw new Error(`Mappen med sparade sidor finns inte: ${args.fixtures}`);
    workDir = mkdtempSync(join(tmpdir(), "bygglov-spike-dry-"));
    gatesPath = join(workDir, "host-gates.json");
    dataDir = workDir;
    cacheDir = join(workDir, "cache");
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
  } else {
    assertManualRunAllowed(new Date());
    mkdirSync(BYGGLOV_CACHE_DIR, { recursive: true });
    lock = acquireRunLock(CITY_LOCK_PATH);
    if (lock.warning !== null) log(`[stockholm] ${lock.warning}`);
    now = () => new Date();
    sleep = (ms) => new Promise((done) => setTimeout(done, ms));
    baseFetch = realFetch as CityFetch;
    const blockedUntil = hostBlockedUntil(readHostGates(gatesPath, log), CITY_HOST, now());
    if (blockedUntil !== null) {
      lock.release();
      console.error(`Stadens e-tjänst är spärrad till ${blockedUntil.toISOString()}. Ingen körning gjordes och ingen rapport skrevs.`);
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
    const counters = { city: 0, minkarta: 0, redirects: 0 };

    const cityFetch: CityFetch = async (url, init) => {
      counters.city += 1;
      try {
        return await baseFetch(url, init);
      } catch (error) {
        if (looksLikeRedirect(error)) counters.redirects += 1;
        throw error;
      }
    };
    const minkartaFetch: CityFetch = async (url, init) => {
      if (counters.minkarta >= MINKARTA_BUDGET) throw new Error("Min Kartas anropsbudget är slut");
      counters.minkarta += 1;
      return baseFetch(url, init);
    };

    const client: CityClient = makeCityClient({ fetchImpl: cityFetch, sleep, now, log, gatesPath, dataDir, budget: CITY_BUDGET });
    const minkartaResolver = makeMinKartaResolver({ fetchImpl: minkartaFetch, sleep, now, log, gatesPath, dataDir });

    const startedAt = now();
    const records: SpikeBuildingRecord[] = [];
    const termsLinks: string[] = [];
    let robots: { status: number | null; text: string | null } = { status: null, text: null };
    let refusal: string | null = null;
    let halted = false;
    let minkarta: SpikeReport["minkarta"] = { address: PROBE_ADDRESS, status: "ej prövad", beteckning: null, agreesWithCity: null, calls: 0 };
    let substringTest: SpikeReport["substringTest"] = { query: "ambyte", count: null, stambyteCount: null, overlap: null, substring: null };
    let mkRungAddresses = 0;

    /** Rung (c) once the probe is accepted: at most 3 addresses, never over the request budget. */
    const rungCImpl: MinKartaResolver = async (address) => {
      if (minkarta.status !== "accepted" || mkRungAddresses >= MINKARTA_RUNG_MAX_ADDRESSES || counters.minkarta >= MINKARTA_BUDGET) {
        return { status: "fetch_failed", beteckning: null, reason: "spike-gräns" };
      }
      mkRungAddresses += 1;
      return minkartaResolver(address);
    };
    /**
     * What the ladder gets as its last rung. A dry run and a Min Karta that refused have none (a permanent answer, so
     * an address nobody can find is remembered as unknown). Otherwise a rung that may say "not now" without storing it.
     */
    const rungC = (): MinKartaResolver | null => (args.dryRun || minkarta.status === "nekad" ? null : rungCImpl);

    const stopOn = (error: unknown): boolean => {
      if (!(error instanceof CityStop)) return false;
      if ((SPIKE_STOP_LABELS as readonly string[]).includes(error.label)) {
        refusal = error.label;
        return true;
      }
      return false;
    };

    // --- 1. robots.txt -------------------------------------------------------------------------------------------
    try {
      const answer = await client.robots();
      robots = { status: answer.status, text: answer.text };
      if (readRobots(answer.text).disallowsCasePages) {
        log("[stockholm] robots.txt stänger ärendesidorna: körningen slutar här");
        halted = true;
      }
    } catch (error) {
      if (!(error instanceof CityStop)) throw error;
      stopOn(error);
      halted = true;
    }

    // --- 2. Min Karta: one address, the honest User-Agent --------------------------------------------------------
    if (!halted && !args.dryRun) {
      const blocked = hostBlockedUntil(readHostGates(gatesPath, log), MINKARTA_HOST, now());
      if (blocked !== null) {
        log("[stockholm] Min Karta är spärrad eller avstängd: ingen provfråga");
      } else {
        const answer = await minkartaResolver(PROBE_ADDRESS);
        let status: MinKartaStatus;
        if (answer.status !== "fetch_failed") status = "accepted";
        else if (MINKARTA_REFUSAL_REASONS.includes(answer.reason)) status = "nekad";
        else status = "fel";
        if (status === "nekad") {
          blockHost(gatesPath, MINKARTA_HOST, "ua-nekad", now(), { dir: dataDir, disabled: true, log });
          log("[stockholm] Min Karta nekade vårt User-Agent: värden är avstängd utan slutdatum, steg c är av");
        }
        minkarta = { address: PROBE_ADDRESS, status, beteckning: answer.beteckning, agreesWithCity: null, calls: answer.calls };
      }
    }

    // --- 3. the buildings ----------------------------------------------------------------------------------------
    /** Looks up one building. A CityStop propagates to the caller. */
    async function runBuilding(b: SpikeBuilding, buildingsLeft: number): Promise<SpikeBuildingRecord> {
      const mark = logs.length;
      const record = blankRecord(b);
      const hadGuess = beteckningGuessFromBrfName(b.brfName) !== null;
      const asOf = isoDay(now());
      try {
        const result = await resolveBeteckning(
          { address: b.address, brfName: b.brfName, text: null },
          { client, minkarta: rungC(), cacheDir, now, log },
        );
        record.rung = result.rung;
        record.beteckning = result.beteckning;
        record.status = result.status;
        record.fromCache = result.fromCache;
        record.rungsTried = rungsTriedFor(result, hadGuess, rungC() !== null && minkarta.status === "accepted");
        record.notes = result.notes.map((n) => n.slice(0, 120)).slice(0, 8);
        if (result.beteckning === null) return record;

        const refreshed = await refreshCaseListIfStale(result.beteckning, { client, now, log, dir: cacheDir });
        termsLinks.push(...(result.list?.termsLinks ?? refreshed.termsLinks));
        let cases: StoredCase[] = [...refreshed.cases];

        const wanted = cases
          .filter((c) => needsDetail(c, asOf))
          .sort((a, c) => c.startDate.localeCompare(a.startDate))
          .slice(0, MAX_DETAILS_PER_BUILDING);
        for (const c of wanted) {
          if (args.dryRun && DETAIL_FIXTURES[c.rec] === undefined) {
            record.notes.push(`detaljsida för ${c.kinds[0]} ${c.startDate.slice(0, 7)} inte läst (torrkörning, ingen sparad sida)`);
            continue;
          }
          if (counters.city + PROBE_RESERVE + buildingsLeft * PER_BUILDING_RESERVE >= CITY_BUDGET) {
            record.notes.push("detaljsidor hoppades över för att spara anropsbudget");
            break;
          }
          if (!args.dryRun) assertManualRunAllowed(now());
          const detail = await client.caseDetail(c.rec, c.archived);
          try {
            const updated = applyDetail(c, detail);
            cases = cases.map((x) => (x.rec === c.rec ? updated : x));
            record.detailPagesRead += 1;
          } catch {
            record.notes.push("en detaljsida hörde inte till sitt ärende och användes inte");
          }
        }
        if (record.detailPagesRead > 0) {
          saveCaseList(result.beteckning, { cases, otherCases: refreshed.otherCases }, { dir: cacheDir, now: now() });
        }

        const facts = buildingFactsOf(cases, asOf);
        record.buildCases = cases.length;
        record.otherCases = refreshed.otherCases.length;
        record.kinds = kindCounts(cases);
        record.stambyteYears = stambyteYearsOf(cases);
        record.stambyteOngoing = facts.stambyteOngoing;
        record.balconyCases = balconyCasesOf(cases);
        record.recentInteresting = facts.recent.map((r) => ({ kind: r.kind, month: r.month, decision: r.decision }));
        return record;
      } finally {
        record.requestSeconds = secondsIn(logs.slice(mark), CITY_HOST).slice(0, 20);
      }
    }

    let consecutiveFailures = 0;
    for (let i = 0; i < selected.length && !halted; i += 1) {
      const b = selected[i];
      if (!args.dryRun) {
        try {
          assertManualRunAllowed(now());
        } catch (error) {
          log(`[stockholm] ${error instanceof Error ? error.message : "körfönstret är stängt"}`);
          halted = true;
          break;
        }
      }
      try {
        records.push(await runBuilding(b, selected.length - i - 1));
        consecutiveFailures = 0;
      } catch (error) {
        const aborted = blankRecord(b);
        if (error instanceof CityStop) {
          aborted.refusal = /^[a-z0-9-]{1,40}$/.test(error.label) ? error.label : "okand";
          if (stopOn(error)) halted = true;
          else if (error.label === "budget") halted = true;
          else if (error.label === "natverksfel" && counters.redirects > 0) halted = true;
        } else {
          aborted.notes.push(`fel i verktyget: ${error instanceof Error ? error.name : "okänt"}`);
        }
        records.push(aborted);
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) halted = true;
      }
      if (termsLinks.length > 0 && !halted) {
        log("[stockholm] en ärendesida länkar till användarvillkor: körningen slutar här");
        halted = true;
      }
    }

    // Min Karta against the city's own answer for the probe address.
    const first = records.find((r) => r.address === PROBE_ADDRESS);
    if (minkarta.status === "accepted" && minkarta.beteckning !== null && first !== undefined && first.beteckning !== null) {
      minkarta = { ...minkarta, agreesWithCity: norm(minkarta.beteckning) === norm(first.beteckning) };
    }

    // --- 4. does "Beskrivning" match inside words? ---------------------------------------------------------------
    if (!halted && !args.dryRun) {
      try {
        assertManualRunAllowed(now());
        const window = { district: "Södermalm", from: "2025-01-01", to: "2025-12-31" } as const;
        const ambyte = await client.extendedSearch({ ...window, description: "ambyte" });
        const stambyte = await client.extendedSearch({ ...window, description: "stambyte" });
        if (ambyte.ok && stambyte.ok) {
          const found = new Set(ambyte.cases.map((c) => c.rec));
          const overlap = stambyte.cases.filter((c) => found.has(c.rec)).length;
          substringTest = {
            query: "ambyte",
            count: ambyte.cases.length,
            stambyteCount: stambyte.cases.length,
            overlap,
            substring: stambyte.cases.length === 0 ? null : overlap === stambyte.cases.length ? true : overlap === 0 ? false : null,
          };
        } else {
          substringTest = {
            query: "ambyte",
            count: ambyte.ok ? ambyte.cases.length : null,
            stambyteCount: stambyte.ok ? stambyte.cases.length : null,
            overlap: null,
            substring: null,
          };
        }
      } catch (error) {
        if (!(error instanceof CityStop)) throw error;
        stopOn(error);
      }
    }

    // --- 5. the report -------------------------------------------------------------------------------------------
    const report = buildSpikeReport({
      ranAt: startedAt.toISOString(),
      dryRun: args.dryRun,
      buildings: records,
      selectedCount: selected.length,
      requests: { city: counters.city, minkarta: counters.minkarta },
      citySeconds: secondsIn(logs, CITY_HOST),
      minkartaSeconds: secondsIn(logs, MINKARTA_HOST),
      robots,
      termsLinks,
      redirects: counters.redirects,
      refusal,
      substringTest,
      minkarta,
    });
    writeJsonAtomic(args.out, report);
    const mdPath = args.out.replace(/\.json$/, ".md");
    writeTextAtomic(mdPath, renderSpikeMarkdown(report));

    console.log("");
    console.log(`Utfall: ${report.verdict === "go" ? "GO" : `STOPP (${report.stopReason})`}`);
    console.log(`Anrop: ${report.requests.city} till staden, ${report.requests.minkarta} till Min Karta. Rapport: ${args.out}`);
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
