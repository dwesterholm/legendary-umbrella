/**
 * The sold-flat join (Phase 14.6, STAM-01, D-05): which sold flats can be tied to a building in the city's stambyte
 * register, and how many.
 *
 *   npx tsx scripts/stambyte-join.ts --stage A                      # free: addresses against the cached sweep, no request
 *   npx tsx scripts/stambyte-join.ts --stage B                      # the city's address search for the near misses
 *   npx tsx scripts/stambyte-join.ts --stage C-sample               # 100 seeded addresses of the "none" class
 *   npx tsx scripts/stambyte-join.ts --stage C                      # the rest of the "none" class, only if the sample earned it
 *   npx tsx scripts/stambyte-join.ts --stage detail                 # detail pages for stambyte cases started 2019 or later
 *   npx tsx scripts/stambyte-join.ts --stage all --evidence <path.json>
 *
 * READS the sold cache (read-only, schema-checked), the sweep cache and the address map. WRITES only files under
 * `.planning/calibration/data/`: the join file (`bygglov/sold-join.json`), the address map (`bygglov/address-beteckning.json`,
 * shared with the candidate lookup), `bygglov/join-details.json` and `bygglov/join-state.json`. The evidence (counts
 * only, no address) goes under `.planning/phases/`.
 *
 * Every run rebuilds the join from what is cached, so stages add to each other and a later stage never erases an
 * earlier answer (an old row that was identified is kept when the new build cannot reproduce it). Stage A makes no
 * request and loads no network module: the city client is imported only when a live stage has work to do.
 *
 * THE RULES (D-01, D-11): only etjanster.stockholm.se, through the gated client (3 s per host, honest User-Agent, one
 * attempt, a refusal puts the host on the 24 hour list and ends the run, run lock). No request on Mondays 06:30 to 09:30
 * (checked 3 s before every request). Per-stage request budgets. The address search is used on the equal-address rule
 * only (beteckning.ts); the map answers are remembered, so nothing is asked twice. No Booli traffic, no paid call.
 */
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { acquireRunLock, type RunLock } from "@/lib/discovery/watch-state";
import { guardedDataPath, readJsonIfExists, writeJsonAtomic, writeTextAtomic } from "@/lib/discovery/json-store";
import { slutprisCacheSchema } from "@/lib/booli/slutpriser";
import {
  BYGGLOV_CACHE_DIR,
  addressEntryFresh,
  loadAddressMap,
  loadSweep,
  saveAddressMap,
  saveGuardedJson,
  sweepNeedsRefresh,
  type AddressEntry,
  type AddressMap,
  type SweepCase,
  type SweepQuery,
} from "@/lib/stockholm/bygglov-cache";
import { applyDetail, type StoredCase } from "@/lib/stockholm/bygglov-classify";
import type { CityClient, CityFetch } from "@/lib/stockholm/bygglov-client";
import { askOneAddress } from "@/lib/stockholm/beteckning";
import { CITY_LOCK_PATH, HOST_GATES_PATH, assertManualRunAllowed, hostBlockedUntil, readHostGates } from "@/lib/stockholm/host-gate";
import {
  SWEEP_DISTRICTS,
  buildCaseIndex,
  collectSweep,
  planSweep,
  sweepKeywords,
  sweepWindows,
  type CaseIndex,
} from "@/lib/discovery/stambyte-join";
import {
  addressesToAsk,
  buildJoinEvidence,
  buildJoinRows,
  detailCandidates,
  dec,
  fmt,
  groupCounts,
  parseJoinDetails,
  planAddresses,
  renderJoinMarkdown,
  renderJoinReport,
  sampleOutcome,
  seededSample,
  summariseJoin,
  unidentifiedRows,
  type AddressPlan,
  type JoinDetail,
  type JoinEvidence,
  type JoinRow,
  type LookupAnswer,
  type SoldInput,
} from "@/lib/discovery/sold-join";

const EVIDENCE_DIR = ".planning/phases/14.6-bygglov-stambyte-uppmatning/evidence";
const SPIKE_PATH = `${EVIDENCE_DIR}/spike.json`;
const DATA_DIR = ".planning/calibration/data";
const SOLD_PATH = `${DATA_DIR}/slutpriser-cache.json`;
const DEFAULT_OUT = `${BYGGLOV_CACHE_DIR}/sold-join.json`;
const STATE_PATH = `${BYGGLOV_CACHE_DIR}/join-state.json`;
const DETAILS_PATH = `${BYGGLOV_CACHE_DIR}/join-details.json`;

const SAMPLE_SIZE = 100;
/** The sample must find at least this many addresses whose building has a recorded stambyte before the full pass runs. */
const SAMPLE_THRESHOLD = 5;
const DETAIL_FROM_YEAR = 2019;
const SAVE_EVERY = 25;
const GATE_MS = 3000;

type LiveStage = "B" | "C-sample" | "C" | "detail";
const LIVE_STAGES: readonly LiveStage[] = ["B", "C-sample", "C", "detail"];
const DEFAULT_BUDGET: Record<LiveStage, number> = { B: 1000, "C-sample": 120, C: 3000, detail: 80 };

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

interface Args {
  stage: "A" | LiveStage | "all";
  maxRequests: number | null;
  seed: number;
  out: string;
  evidence: string | null;
  sold: string;
}

function insideDir(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function parseArgs(argv: readonly string[]): Args {
  const valued = new Set(["--stage", "--max-requests", "--seed", "--out", "--evidence", "--sold"]);
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!valued.has(arg)) throw new Error(`Okänd flagga: ${arg.slice(0, 40)}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} behöver ett värde`);
    values.set(arg, value);
    i += 1;
  }
  const stage = values.get("--stage") ?? "A";
  if (!["A", "B", "C-sample", "C", "detail", "all"].includes(stage)) {
    throw new Error(`--stage: A, B, C-sample, C, detail eller all (fick "${stage.slice(0, 20)}")`);
  }
  const maxRaw = values.get("--max-requests");
  const maxRequests = maxRaw === undefined ? null : Number(maxRaw);
  if (maxRequests !== null && (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 5000)) {
    throw new Error("--max-requests: ett heltal mellan 1 och 5000");
  }
  const seedRaw = values.get("--seed");
  const seed = seedRaw === undefined ? 14 : Number(seedRaw);
  if (!Number.isInteger(seed) || seed < 0 || seed > 2 ** 31) throw new Error("--seed: ett heltal");
  const out = values.get("--out") ?? DEFAULT_OUT;
  if (!out.endsWith(".json") || !insideDir(out, DATA_DIR)) {
    throw new Error(`--out måste vara en .json-fil under ${DATA_DIR}/ (fick ${out.slice(0, 120)})`);
  }
  const evidence = values.get("--evidence") ?? null;
  if (evidence !== null && (!evidence.endsWith(".json") || !insideDir(evidence, EVIDENCE_DIR))) {
    throw new Error(`--evidence måste vara en .json-fil under ${EVIDENCE_DIR}/ (fick ${evidence.slice(0, 120)})`);
  }
  const sold = values.get("--sold") ?? SOLD_PATH;
  if (!sold.endsWith(".json")) throw new Error("--sold måste vara en .json-fil");
  return { stage: stage as Args["stage"], maxRequests, seed, out, evidence, sold };
}

// ---------------------------------------------------------------------------
// The files this script keeps beside the address map
// ---------------------------------------------------------------------------

interface State {
  schemaVersion: 1;
  requests: Record<LiveStage, number>;
  /** Wall-clock seconds spent in each stage, across runs (the 3 s pacing included). */
  seconds: Record<LiveStage, number>;
  /** Seconds the city took per request (the last 2000). */
  responseSeconds: number[];
  sample: { seed: number; size: number; keys: string[] } | null;
  lastStop: { stage: LiveStage; label: string } | null;
}

const emptyState = (): State => ({
  schemaVersion: 1,
  requests: { B: 0, "C-sample": 0, C: 0, detail: 0 },
  seconds: { B: 0, "C-sample": 0, C: 0, detail: 0 },
  responseSeconds: [],
  sample: null,
  lastStop: null,
});

const isRecordOfNumbers = (v: unknown): v is Record<LiveStage, number> =>
  typeof v === "object" && v !== null && LIVE_STAGES.every((s) => typeof (v as Record<string, unknown>)[s] === "number");

/** A damaged state file is said out loud and starts again: the address map is what carries the answers. */
function loadState(log: (line: string) => void): State {
  let raw: unknown;
  try {
    raw = readJsonIfExists(STATE_PATH);
  } catch {
    log("[koppling] join-state.json går inte att läsa och börjar om");
    return emptyState();
  }
  if (raw === null) return emptyState();
  const s = raw as Partial<State>;
  const keys = s.sample?.keys;
  if (
    s.schemaVersion !== 1 ||
    !isRecordOfNumbers(s.requests) ||
    !isRecordOfNumbers(s.seconds) ||
    !Array.isArray(s.responseSeconds) ||
    (s.sample != null && (!Array.isArray(keys) || keys.some((k) => typeof k !== "string")))
  ) {
    log("[koppling] join-state.json har fel format och börjar om");
    return emptyState();
  }
  return {
    schemaVersion: 1,
    requests: s.requests,
    seconds: s.seconds,
    responseSeconds: s.responseSeconds.filter((n): n is number => typeof n === "number").slice(-2000),
    sample: s.sample ?? null,
    lastStop: s.lastStop ?? null,
  };
}

const saveState = (state: State) => saveGuardedJson(STATE_PATH, state);

function loadDetails(log: (line: string) => void): Map<string, JoinDetail> {
  const out = new Map<string, JoinDetail>();
  let raw: unknown;
  try {
    raw = readJsonIfExists(DETAILS_PATH);
  } catch {
    log("[koppling] join-details.json går inte att läsa och börjar om");
    return out;
  }
  const parsed = parseJoinDetails(raw);
  if (parsed.dropped > 0) log(`[koppling] join-details.json: ${parsed.dropped} poster hade fel format och hoppas över`);
  for (const [rec, d] of parsed.details) out.set(rec, d);
  return out;
}

const saveDetails = (details: ReadonlyMap<string, JoinDetail>) =>
  saveGuardedJson(DETAILS_PATH, { schemaVersion: 1, details: Object.fromEntries(details) });

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// ---------------------------------------------------------------------------
// Inputs: the sold rows and the sweep
// ---------------------------------------------------------------------------

function readSpike(): { go: boolean; substring: boolean | null } {
  let raw: unknown;
  try {
    raw = readJsonIfExists(SPIKE_PATH);
  } catch {
    throw new Error(`Spikrapporten ${SPIKE_PATH} går inte att läsa. Ingen körning gjordes.`);
  }
  const spike = raw as { verdict?: unknown; substringTest?: { substring?: unknown } } | null;
  if (spike === null) throw new Error(`Spikrapporten ${SPIKE_PATH} saknas. Ingen körning gjordes.`);
  const s = spike.substringTest?.substring;
  return { go: spike.verdict === "go", substring: s === true ? true : s === false ? false : null };
}

function readSold(path: string): { rows: SoldInput[]; asOf: string; bytes: number; mtimeMs: number } {
  const file = resolve(path);
  const before = statSync(file);
  const parsed = slutprisCacheSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`Slutprisfilen klarar inte schemat: ${parsed.error.issues[0]?.message ?? "okänt fel"}`);
  const rows = parsed.data.rows.map((r) => ({
    booliId: r.booliId,
    address: r.address ?? "",
    district: r.district,
    soldDate: r.soldDate,
  }));
  return { rows, asOf: parsed.data.asOf, bytes: before.size, mtimeMs: before.mtimeMs };
}

function readSweepIndex(substring: boolean | null, log: (line: string) => void): { index: CaseIndex; leaves: number; stale: number } {
  const plan = planSweep(SWEEP_DISTRICTS, sweepKeywords(substring), sweepWindows(), () => false);
  const splits = (readJsonIfExists(`${BYGGLOV_CACHE_DIR}/sweep-state.json`) as { splits?: SweepQuery[] } | null)?.splits ?? [];
  const now = new Date();
  let stale = 0;
  const collection = collectSweep(plan, {
    load: (q) => {
      const loaded = loadSweep(q);
      if (!loaded.ok) return null;
      if (sweepNeedsRefresh(loaded.entry, now)) stale += 1;
      return loaded.entry;
    },
    splitRecorded: (q) => splits.some((s) => s.district === q.district && s.description === q.description && s.from === q.from && s.to === q.to),
    today: now.toISOString().slice(0, 10),
  });
  if (collection.missing.length > 0) {
    throw new Error(`Svepet är inte komplett i cachen (${collection.missing.length} sökningar saknas). Kör scripts/bygglov-sweep.ts först.`);
  }
  if (stale > 0) log(`[koppling] ${stale} svepfiler är äldre än 30 dagar; de används ändå (en koppling läser bara)`);
  const cases: SweepCase[] = collection.leaves.flatMap((l) => [...l.cases]);
  return { index: buildCaseIndex(cases), leaves: collection.leaves.length, stale };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const log = (line: string) => console.log(line);
  mkdirSync(BYGGLOV_CACHE_DIR, { recursive: true });

  const spike = readSpike();
  const sold = readSold(args.sold);
  const { index, leaves } = readSweepIndex(spike.substring, log);
  log(`Inläst: ${fmt(sold.rows.length)} sålda rader, ${fmt(leaves)} svepsökningar, ${fmt(index.cases.size)} ärenden i ${fmt(index.byBeteckning.size)} fastigheter`);

  const plans = planAddresses(sold.rows, index);
  const state = loadState(log);
  const details = loadDetails(log);
  const loaded = loadAddressMap({});
  // CR-01: a damaged address map is never written over. Good entries are still used; the asking stages refuse to run.
  let mapWritable = true;
  if (loaded.ok && loaded.dropped > 0) {
    mapWritable = false;
    log(`[koppling] adresscachen har ${loaded.dropped} poster som inte går att läsa, filen skrivs inte över`);
  } else if (!loaded.ok && loaded.error !== "saknas") {
    mapWritable = false;
    log(`[koppling] adresscachen kunde inte läsas (${loaded.error}), filen skrivs inte över`);
  }
  const map: AddressMap = loaded.ok ? { ...loaded.map } : {};
  const persistMap = () => {
    if (mapWritable) saveAddressMap(map);
  };
  const clock = () => new Date();

  const lookup = (key: string): LookupAnswer | undefined => {
    const e = map[key];
    return e !== undefined && addressEntryFresh(e, clock()) ? { beteckning: e.beteckning, status: e.status } : undefined;
  };

  const wanted: LiveStage[] =
    args.stage === "A" ? [] : args.stage === "all" ? [...LIVE_STAGES] : [args.stage as LiveStage];
  const budgetOf = (stage: LiveStage) => args.maxRequests ?? DEFAULT_BUDGET[stage];
  let stopMessage: string | null = null;
  let exitCode = 0;

  // -- the live part -------------------------------------------------------
  if (wanted.length > 0) {
    const sampleKeys = (): string[] => {
      if (state.sample !== null && state.sample.seed === args.seed && state.sample.size === SAMPLE_SIZE) return state.sample.keys;
      if (state.sample !== null && state.sample.seed !== args.seed) {
        log(`[koppling] stickprovet är redan draget med frö ${state.sample.seed}; --seed ${args.seed} ignoreras`);
        return state.sample.keys;
      }
      const keys = seededSample(addressesToAsk(plans, "C"), SAMPLE_SIZE, args.seed);
      state.sample = { seed: args.seed, size: SAMPLE_SIZE, keys };
      saveState(state);
      return keys;
    };
    const rowsOf = (): Record<string, JoinRow> => buildJoinRows(sold.rows, index, plans, lookup, details);
    const sampleEarned = (): { ran: boolean; hits: number; earned: boolean } => {
      if (state.sample === null) return { ran: false, hits: 0, earned: false };
      const out = sampleOutcome(state.sample.keys, lookup, index);
      const ran = out.answered >= state.sample.keys.length;
      return { ran, hits: out.hits, earned: ran && out.hits >= SAMPLE_THRESHOLD };
    };

    const held: { lock: RunLock | null } = { lock: null };
    let client: CityClient | null = null;
    let stopClass: (typeof import("@/lib/stockholm/bygglov-client"))["CityStop"] | null = null;
    let current: LiveStage = "B";

    const openCity = async (): Promise<CityClient> => {
      if (client !== null) return client;
      if (!spike.go) throw new Error(`Spikrapporten ${SPIKE_PATH} säger inte GO. Inga anrop görs.`);
      // The only place the network client is loaded: stage A and the evidence never get here.
      const { makeCityClient, CityStop, CITY_HOST } = await import("@/lib/stockholm/bygglov-client");
      stopClass = CityStop;
      const lock = acquireRunLock(CITY_LOCK_PATH);
      held.lock = lock;
      if (lock.warning !== null) log(`[stockholm] ${lock.warning}`);
      const blockedUntil = hostBlockedUntil(readHostGates(HOST_GATES_PATH, log), CITY_HOST, clock());
      if (blockedUntil !== null) {
        lock.release();
        held.lock = null;
        throw new Error(`Stadens e-tjänst är spärrad till ${blockedUntil.toISOString()}. Ingen körning gjordes.`);
      }
      const realFetch = globalThis.fetch as CityFetch;
      const countingFetch: CityFetch = async (url, init) => {
        state.requests[current] += 1;
        try {
          return await realFetch(url, init);
        } catch (error) {
          // The client keeps only the error's name; the cause code (a closed socket, a reset) tells a flaky line from a refusal.
          const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
          log(`[koppling] anropet misslyckades (${typeof cause === "string" ? cause.slice(0, 40) : "okänd orsak"})`);
          throw error;
        }
      };
      const clientLog = (line: string) => {
        log(line);
        if (!line.includes(`${CITY_HOST}/`)) return;
        const m = /(\d+),(\d) s\)?$/.exec(line);
        if (m !== null) {
          state.responseSeconds = [...state.responseSeconds, Number(`${m[1]}.${m[2]}`)].slice(-2000);
        }
      };
      client = makeCityClient({
        fetchImpl: countingFetch,
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
        now: clock,
        log: clientLog,
        budget: wanted.reduce((sum, s) => sum + budgetOf(s), 0),
      });
      return client;
    };

    const stopLabelOf = (error: unknown): string | null => (stopClass !== null && error instanceof stopClass ? error.label : null);

    /** True when the Monday window is open 3 s from now: the start gate may still hold the next request that long. */
    const windowClosed = (): boolean => {
      try {
        assertManualRunAllowed(new Date(Date.now() + GATE_MS));
        return false;
      } catch {
        return true;
      }
    };

    const remember = (key: string, entry: AddressEntry) => {
      map[key] = entry;
    };

    /** Asks the city's address search about each key not already answered, on the equal-address rule. */
    async function askAddresses(stage: "B" | "C-sample" | "C", keys: readonly string[]): Promise<string | null> {
      current = stage;
      if (!mapWritable) {
        log("[koppling] adresscachen är skadad: inga adresser frågas förrän filen har setts över (öppna eller flytta address-beteckning.json)");
        return "adresscache";
      }
      const todoKeys = keys.filter((k) => lookup(k) === undefined);
      const budget = budgetOf(stage);
      const startedAt = Date.now();
      let asked = 0;
      let stop: string | null = null;
      log(`[koppling] steg ${stage}: ${fmt(todoKeys.length)} adresser att fråga, tak ${fmt(budget)} anrop`);
      if (todoKeys.length === 0) return null;
      try {
        if (windowClosed()) {
          stop = "fonster";
          return stop;
        }
        const city = await openCity();
        for (const key of todoKeys) {
          if (asked >= budget) {
            stop = "budget";
            break;
          }
          if (windowClosed()) {
            stop = "fonster";
            break;
          }
          const asking = plans.get(key)?.asked ?? key;
          const answer = await askOneAddress(asking, {
            addressSearch: (address) => city.addressSearch(address),
            isStop: (error) => stopLabelOf(error) !== null,
            now: clock,
            log,
          });
          if (answer.requested) asked += 1;
          remember(key, answer.entry);
          if (answer.requested && asked % SAVE_EVERY === 0) {
            persistMap();
            saveState(state);
            log(`[koppling] steg ${stage}: ${fmt(asked)} av ${fmt(todoKeys.length)} frågade`);
          }
        }
      } catch (error) {
        const label = stopLabelOf(error);
        if (label === null) throw error;
        stop = label;
      } finally {
        persistMap();
        state.seconds[stage] += Math.round((Date.now() - startedAt) / 1000);
        state.lastStop = stop === null ? null : { stage, label: stop };
        saveState(state);
      }
      log(`[koppling] steg ${stage}: ${fmt(asked)} anrop${stop === null ? ", klart" : `, stoppad (${stop})`}`);
      return stop;
    }

    async function readDetails(): Promise<string | null> {
      current = "detail";
      const budget = budgetOf("detail");
      const picked = detailCandidates(rowsOf(), index, DETAIL_FROM_YEAR, new Set(details.keys()), budget);
      const startedAt = Date.now();
      let asked = 0;
      let stop: string | null = null;
      log(`[koppling] detaljsidor: ${fmt(picked.wanted)} stambyteärenden från ${DETAIL_FROM_YEAR}, ${fmt(picked.take.length)} att läsa`);
      try {
        if (picked.take.length > 0 && windowClosed()) {
          stop = "fonster";
        } else if (picked.take.length > 0) {
          const city = await openCity();
          for (const item of picked.take) {
            if (windowClosed()) {
              stop = "fonster";
              break;
            }
            const base = index.cases.get(item.rec);
            if (base === undefined) continue;
            const detail = await city.caseDetail(item.rec, item.archived);
            asked += 1;
            if (detail === null) {
              log("[koppling] en detaljsida saknades eller kunde inte tolkas och hoppas över");
              continue;
            }
            const stored: StoredCase = {
              rec: base.rec,
              diarie: "",
              startDate: base.startDate,
              kinds: base.kinds as StoredCase["kinds"],
              primary: (base.kinds[0] ?? "annat") as StoredCase["primary"],
              tillsyn: false,
              archived: item.archived,
              detailRead: false,
              latest: null,
              startbeskedDate: null,
              slutbeskedDate: null,
              closedDate: null,
            };
            try {
              const filled = applyDetail(stored, detail);
              details.set(item.rec, {
                startbeskedDate: filled.startbeskedDate,
                slutbeskedDate: filled.slutbeskedDate,
                latest: filled.latest === null ? null : { type: filled.latest.type, code: filled.latest.code },
              });
            } catch {
              log("[koppling] en detaljsida hörde inte till sitt ärende och hoppas över");
            }
            if (asked % SAVE_EVERY === 0) saveDetails(details);
          }
        }
      } catch (error) {
        const label = stopLabelOf(error);
        if (label === null) throw error;
        stop = label;
      } finally {
        saveDetails(details);
        state.seconds.detail += Math.round((Date.now() - startedAt) / 1000);
        state.lastStop = stop === null ? null : { stage: "detail", label: stop };
        saveState(state);
      }
      log(`[koppling] detaljsidor: ${fmt(asked)} anrop${stop === null ? ", klart" : `, stoppad (${stop})`}`);
      return stop;
    }

    try {
      for (const stage of wanted) {
        let stop: string | null = null;
        if (stage === "B") {
          stop = await askAddresses("B", addressesToAsk(plans, "B"));
        } else if (stage === "C-sample") {
          stop = await askAddresses("C-sample", sampleKeys());
        } else if (stage === "C") {
          const sample = sampleEarned();
          if (!sample.earned) {
            const why = !sample.ran
              ? "stickprovet har inte körts klart (kör --stage C-sample)"
              : `stickprovet gav ${sample.hits} träffar av ${SAMPLE_SIZE}, gränsen är ${SAMPLE_THRESHOLD}`;
            log(`[koppling] steg C körs inte: ${why}`);
            if (args.stage === "C") {
              stopMessage = `Steg C körs bara när stickprovet gett minst ${SAMPLE_THRESHOLD} träffar: ${why}`;
              exitCode = 4;
            }
            continue;
          }
          stop = await askAddresses("C", addressesToAsk(plans, "C"));
        } else {
          stop = await readDetails();
        }
        if (stop !== null) {
          stopMessage = `Körningen stoppad i steg ${stage} (${stop}). Allt som hann sparas finns kvar; kör om för att fortsätta.`;
          exitCode = 2;
          break;
        }
      }
    } finally {
      held.lock?.release();
    }
  }

  // -- the join file and the report ----------------------------------------
  const rows = buildJoinRows(sold.rows, index, plans, lookup, details);
  const merged = mergeWithPrevious(args.out, rows, log);
  const safeOut = guardedDataPath(args.out, { dir: DATA_DIR, ext: ".json" });
  if (safeOut === null) throw new Error(`Kopplingsfilen får bara skrivas under ${DATA_DIR}/ som .json-fil`);
  writeJsonAtomic(safeOut, {
    schemaVersion: 1,
    builtAt: new Date().toISOString(),
    soldAsOf: sold.asOf,
    soldRows: sold.rows.length,
    rows: merged,
  });

  const summary = summariseJoin(sold.rows, merged);
  const groups = groupCounts(plans);
  const evidence = buildEvidence(args, state, summary, groups, plans, lookup, index, details, merged, sold.asOf, sold.rows);
  for (const line of renderJoinReport(evidence)) console.log(line);

  const south = summary.byDistrict["Södermalm"];
  if (south !== undefined) {
    console.log(
      `Södermalm, steg A och A+ i hus med stambyteärende: ${fmt(south.freeInStambyteBuilding)} av ${fmt(south.rows)} rader (${dec((south.freeInStambyteBuilding / south.rows) * 100)} %); RESEARCH 5.3 skattade 20,6 %`,
    );
  }
  console.log(`Stickprov ingen-klassen: ${evidence.sample.hits} av ${evidence.sample.size} träffar${evidence.sample.ran ? "" : " (inte körd)"}`);
  console.log(`Anrop hittills: ${fmt(evidence.requests.total)} (B ${evidence.requests.perStage.B}, stickprov ${evidence.requests.perStage["C-sample"]}, C ${evidence.requests.perStage.C}, detalj ${evidence.requests.perStage.detail})`);

  if (args.evidence !== null) {
    const jsonPath = resolve(args.evidence);
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeJsonAtomic(jsonPath, evidence);
    writeTextAtomic(jsonPath.replace(/\.json$/, ".md"), renderJoinMarkdown(evidence));
    console.log(`Rapport: ${args.evidence} och ${args.evidence.replace(/\.json$/, ".md")}`);
  }

  // The sold cache is read-only: say so with its own size and time.
  const after = statSync(resolve(args.sold));
  if (after.size !== sold.bytes || after.mtimeMs !== sold.mtimeMs) {
    console.error("VARNING: slutprisfilen ändrades under körningen (av en annan process, inte av det här verktyget)");
  }
  if (stopMessage !== null) {
    console.error(stopMessage);
    return exitCode;
  }
  return 0;
}

/** An earlier identified row is kept when the new build cannot reproduce it (an expired cache entry): stages only add. */
function mergeWithPrevious(path: string, rows: Record<string, JoinRow>, log: (line: string) => void): Record<string, JoinRow> {
  let previous: unknown = null;
  try {
    previous = readJsonIfExists(resolve(path));
  } catch {
    log("[koppling] den gamla kopplingsfilen går inte att läsa och byts ut");
  }
  const old = (previous as { rows?: Record<string, JoinRow> } | null)?.rows;
  if (old === undefined) return rows;
  let kept = 0;
  const out = { ...rows };
  for (const [id, row] of Object.entries(rows)) {
    const before = old[id];
    if (row.stage === null && before?.stage != null && before.beteckning != null) {
      out[id] = before;
      kept += 1;
    }
  }
  if (kept > 0) log(`[koppling] ${kept} rader behåller sitt gamla svar (cachens svar har gått ut)`);
  return out;
}

function buildEvidence(
  args: Args,
  state: State,
  summary: ReturnType<typeof summariseJoin>,
  groups: ReturnType<typeof groupCounts>,
  plans: ReadonlyMap<string, AddressPlan>,
  lookup: (key: string) => LookupAnswer | undefined,
  index: CaseIndex,
  details: ReadonlyMap<string, JoinDetail>,
  rows: Record<string, JoinRow>,
  soldAsOf: string,
  soldRows: readonly SoldInput[],
): JoinEvidence {
  const sampleKeys = state.sample?.keys ?? [];
  const outcome = sampleOutcome(sampleKeys, lookup, index);
  const sampleRan = state.sample !== null && outcome.answered >= sampleKeys.length && sampleKeys.length > 0;
  const bKeys = addressesToAsk(plans, "B");
  const cKeys = addressesToAsk(plans, "C");
  const answered = (keys: readonly string[]) => keys.filter((k) => lookup(k) !== undefined).length;
  const bResolved = bKeys.filter((k) => lookup(k)?.status === "resolved").length;
  const cAnswered = answered(cKeys);
  const picked = detailCandidates(rows, index, DETAIL_FROM_YEAR, new Set(details.keys()), 0);
  const detailsRead = [...details.keys()].filter((rec) => {
    const c = index.cases.get(rec);
    return c !== undefined && Number(c.startDate.slice(0, 4)) >= DETAIL_FROM_YEAR;
  }).length;

  let decision: string;
  const cRequests = state.requests.C;
  if (!sampleRan) {
    decision = "Steg C har inte körts: stickprovet på 100 adresser har inte körts klart, så det finns inget underlag för beslutet.";
  } else if (outcome.hits < SAMPLE_THRESHOLD) {
    decision = `Steg C kördes inte. Stickprovet gav ${outcome.hits} träffar av ${state.sample?.size ?? SAMPLE_SIZE}, gränsen för att köra hela passet är ${SAMPLE_THRESHOLD}. Det skulle ha kostat ungefär ${fmt(cKeys.length)} anrop och ungefär ${fmt(Math.round((cKeys.length * 3.4) / 60))} minuter, för få nya träffar för att det ska vara värt det.`;
  } else if (cAnswered >= cKeys.length) {
    decision = `Steg C kördes. Stickprovet gav ${outcome.hits} träffar av ${state.sample?.size ?? SAMPLE_SIZE} (gräns ${SAMPLE_THRESHOLD}) och alla ${fmt(cKeys.length)} adresser i ingen-klassen är besvarade.`;
  } else {
    decision = `Steg C har påbörjats. Stickprovet gav ${outcome.hits} träffar av ${state.sample?.size ?? SAMPLE_SIZE} (gräns ${SAMPLE_THRESHOLD}); ${fmt(cAnswered)} av ${fmt(cKeys.length)} adresser är besvarade och resten väntar på nästa körning.`;
  }

  return buildJoinEvidence({
    ranAt: new Date().toISOString(),
    soldAsOf,
    summary,
    groups,
    requests: { perStage: state.requests, secondsPerStage: state.seconds, medianSecondsPerRequest: median(state.responseSeconds) },
    sample: {
      ran: sampleRan,
      size: state.sample?.size ?? SAMPLE_SIZE,
      seed: state.sample?.seed ?? args.seed,
      answered: outcome.answered,
      resolved: outcome.resolved,
      hits: outcome.hits,
      threshold: SAMPLE_THRESHOLD,
    },
    stageC: { run: cRequests > 0, decision, addressesTotal: cKeys.length, addressesAnswered: cAnswered },
    stageB: { addressesTotal: bKeys.length, addressesAnswered: answered(bKeys), resolved: bResolved },
    unidentified: unidentifiedRows(soldRows, rows, plans, lookup),
    detail: { wanted: picked.wanted, read: detailsRead, cap: DEFAULT_BUDGET.detail },
    stop: state.lastStop?.label ?? null,
  });
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : "okänt fel");
    process.exit(1);
  },
);
