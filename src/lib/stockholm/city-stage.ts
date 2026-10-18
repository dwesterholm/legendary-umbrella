/**
 * city-stage.ts - the city's building facts, one set per candidate (Phase 14.6, plan 09: STAM-03, FLAG-01, CASE-01).
 *
 * The enrichment step (`watch-enrich.ts`) reads the broker text and drops it. This step adds what the CITY knows about
 * the building: the fastighetsbeteckning (when the text did not state it), the building's stored cases, and from them
 * the stambyte reading, the two balcony flags and the short "Byggärenden" list. Everything lands on the candidate's
 * facts record as derived values (years, months, tags, booleans); no case text, name or document is ever carried.
 *
 * TWO MODES
 *  - "cache-only": no network module is involved at all. The address map and the case-list files that earlier runs
 *    left behind are read, and any VALID entry is used however old it is (a replay of an old snapshot must give the
 *    same facts a month later). A row with no cached answer is left as it was.
 *  - "live": the address rungs and the case lists cache-first (a fresh cached answer costs no request), then the detail
 *    page of the few cases that matter (an interesting kind, started within five years, at most three per building,
 *    newest first), one row at a time. One case list is read per building per run however many candidates share it.
 *    A request budget (300) and a deadline (20 minutes) bound the stage, and the client's own gates (3 s per request,
 *    the 24 hour block after a refusal) stay in force because every request goes through the injected client.
 *
 * STOPS: a CityStop from the client (a refusal, a changed page, "pausad"), the budget and the deadline each END the
 * stage. A row that had not got as far as its case list keeps its facts as they were; a row whose list was read keeps
 * the list's facts even when its detail pages were cut short (what was not read stays "okant" or null, never guessed).
 * Rows never reached are counted in `notReached` and the coverage line says why.
 *
 * NEVER THROWS, NEVER FAILS THE RUN: a row that cannot be processed keeps its facts and is logged with a fixed label.
 *
 * STRUCTURAL SEPARATION (LOCKED, D-12): like the rest of `stockholm/`, `niche-score.ts` and `report/flags.ts` must
 * NEVER import this module. It loads no network module statically (the caller injects the client), so a cache-only run
 * and a unit test stay offline by construction.
 */
import { candidateFactsSchema, emptyFacts, type CandidateFacts } from "@/lib/discovery/listing-facts";
import { mergeStambyte, type CityStambyteReading } from "@/lib/discovery/stambyte-facts";
import {
  beteckningSlug,
  loadAddressMap,
  loadCaseList,
  normaliseAddressKey,
  refreshCaseListIfStale,
  saveCaseList,
  type AddressRung,
} from "@/lib/stockholm/bygglov-cache";
import {
  INTERESTING_KINDS,
  KIND_PRIORITY,
  applyDetail,
  buildingFactsOf,
  decisionKind,
  needsDetail,
  type StoredCase,
} from "@/lib/stockholm/bygglov-classify";
import { cleanAddressForSearch } from "@/lib/stockholm/beteckning-text";
import { resolveBeteckning, type MinKartaResolver } from "@/lib/stockholm/beteckning";
import type { AddressOption, CaseDetail } from "@/lib/stockholm/bygglov-parse";

/** Most requests one stage run may make (about 3 per new building: address, list, a few detail pages). */
export const CITY_STAGE_REQUEST_BUDGET = 300;
/** How long one stage run may take; a row that has not started by then is not reached. */
export const CITY_STAGE_DEADLINE_MS = 20 * 60 * 1000;
/** Detail pages opened per building and run. The rest wait for the next run (the opened ones are saved). */
const MAX_DETAILS_PER_BUILDING = 3;

/** One case list as the city client answers it (the shape of `CaseListAnswer`, spelled out so no network module is imported). */
export interface CityCaseList {
  cases: StoredCase[];
  otherCases: StoredCase[];
  headingCount: number | null;
  termsLinks: string[];
  addresses: string[];
}

/** The three calls the stage makes on the city. `makeCityClient(...)` from `bygglov-client.ts` fits. */
export interface CityStageClient {
  addressSearch(address: string): Promise<AddressOption[]>;
  caseList(beteckning: string): Promise<CityCaseList>;
  /** `null`: this one case has no usable detail page (skip it; it is not a refusal). */
  caseDetail(rec: string, archived: boolean): Promise<CaseDetail | null>;
}

/** One candidate as the stage sees it. `facts` is the record the enrichment made (null: none yet). */
export interface CityStageRow {
  readonly address: string;
  readonly brfName: string | null;
  readonly facts: CandidateFacts | null;
}

/** What the stage did. `requests` counts calls to the city and Min Karta; a cache-only run makes none. */
export interface CityStageStats {
  readonly rows: number;
  /** Rows whose fastighetsbeteckning is known (from the text, the cache or a lookup). */
  readonly resolved: number;
  readonly byRung: Readonly<Record<AddressRung, number>>;
  /** Case lists read, from the cache or the city. */
  readonly listsRead: number;
  /** Detail pages fetched from the city. */
  readonly detailsRead: number;
  readonly requests: number;
  /** Rows the stage never got to (a stop, the budget or the deadline). */
  readonly notReached: number;
  /** The fixed label of the CityStop that ended the stage, or null. */
  readonly stopped: string | null;
}

interface CommonOptions {
  /** The run date, "YYYY-MM-DD": cases that start after it are ignored and "recent" is counted from it. */
  readonly asOf: string;
  /** Directory of the city cache (the address map and `cases/`); tests and replays pass a directory. */
  readonly cacheDir?: string;
  readonly log?: (line: string) => void;
}

/** No network: the address map and case lists on disk, any valid entry whatever its age. */
export interface CacheOnlyOptions extends CommonOptions {
  readonly mode: "cache-only";
}

/** The live stage. The caller injects the client (and Min Karta), so this module stays offline by construction. */
export interface LiveOptions extends CommonOptions {
  readonly mode: "live";
  readonly client: CityStageClient;
  /** Rung (c); null or missing ends the ladder at rung (b). */
  readonly minkarta?: MinKartaResolver | null;
  /** The clock for cache ages and the deadline. */
  readonly now?: () => Date;
  /** Default {@link CITY_STAGE_REQUEST_BUDGET}. */
  readonly budget?: number;
  /** Default {@link CITY_STAGE_DEADLINE_MS}. */
  readonly deadlineMs?: number;
}

export type CityStageOptions = CacheOnlyOptions | LiveOptions;

export interface CityStageResult {
  /** Same length and order as the rows. A row the stage changed is a new object; any other is the input's own. */
  readonly facts: Array<CandidateFacts | null>;
  readonly stats: CityStageStats;
}

/** What the case list alone gives for the facts record. */
export interface CityFacts {
  readonly cityStambyte: NonNullable<CandidateFacts["cityStambyte"]>;
  readonly balkongBeviljadEjByggd: boolean | null;
  readonly balkongInglasningAnsokt: boolean | null;
  readonly byggarenden: NonNullable<CandidateFacts["byggarenden"]>;
}

type Byggarende = NonNullable<CandidateFacts["byggarenden"]>[number];

/** How far back a case still counts as news; the same five years as `buildingFactsOf`. */
const RECENT_YEARS = 5;
const MAX_ITEMS = 6;

const yearsBefore = (asOf: string, years: number): string => `${Number(asOf.slice(0, 4)) - years}${asOf.slice(4)}`;

/** The decision of one case as the "Byggärenden" cell words it. A case whose page was not read is "okant". */
function decisionOf(c: StoredCase): Byggarende["decision"] {
  if (!c.detailRead) return "okant";
  if (c.slutbeskedDate !== null) return "slutbesked";
  if (c.latest === null) return "ansokt";
  switch (decisionKind(c.latest.type, c.latest.code)) {
    case "startbesked":
      return "startbesked";
    case "lov":
    case "beslut":
      return "beviljad";
    case "slutbesked":
      return "slutbesked";
    case "avskrivet":
      return "avskrivet";
    case "avslag":
      return "avslag";
    default:
      return "okant";
  }
}

/** The case number cleaned to the characters the facts schema allows, or null when nothing is left. */
function diarieOf(raw: string): string | null {
  const cleaned = raw.replace(/[^0-9A-Za-z/ -]/g, "").trim().slice(0, 20).trim();
  return cleaned === "" ? null : cleaned;
}

/**
 * The building facts the case list gives, as the facts record stores them. The stambyte reading, the two balcony flags
 * and the dating rules come from `buildingFactsOf`; the list is built the same way as its `recent` list (newest
 * first, enforcement cases left out, interesting kinds only, at most six) but carries the case number and the
 * month of the final inspection too.
 */
export function cityFactsFromCases(allCases: readonly StoredCase[], asOf: string): CityFacts {
  const building = buildingFactsOf(allCases, asOf);
  const recentFrom = yearsBefore(asOf, RECENT_YEARS);

  const byggarenden: Byggarende[] = allCases
    .filter((c) => c.startDate <= asOf && !c.tillsyn && c.startDate >= recentFrom)
    .flatMap((c) => {
      const kind = KIND_PRIORITY.find((k) => c.kinds.includes(k) && INTERESTING_KINDS.includes(k));
      if (kind === undefined) return [];
      const item: Byggarende = {
        kind,
        month: c.startDate.slice(0, 7),
        decision: decisionOf(c),
        slutbeskedMonth: c.slutbeskedDate === null ? null : c.slutbeskedDate.slice(0, 7),
        diarie: diarieOf(c.diarie),
      };
      return [{ c, item }];
    })
    .sort((a, b) => (a.c.startDate === b.c.startDate ? b.c.rec.localeCompare(a.c.rec) : b.c.startDate.localeCompare(a.c.startDate)))
    .slice(0, MAX_ITEMS)
    .map((entry) => entry.item);

  return {
    cityStambyte: {
      lastYear: building.lastStambyteYear,
      basis: building.lastStambyteBasis,
      ongoing: building.stambyteOngoing,
      relining: building.reliningCase,
    },
    balkongBeviljadEjByggd: building.balkongBeviljadEjByggd,
    balkongInglasningAnsokt: building.balkongInglasningAnsokt,
    byggarenden,
  };
}

/** The facts record with the city's reading added and the stambyte fields merged again (text and city, D-07). */
function withCityFacts(
  base: CandidateFacts,
  beteckning: string,
  rung: AddressRung | null,
  cases: readonly StoredCase[],
  asOf: string,
): CandidateFacts {
  const city = cityFactsFromCases(cases, asOf);
  const reading: CityStambyteReading = {
    lastStambyteYear: city.cityStambyte.lastYear,
    lastStambyteBasis: city.cityStambyte.basis,
    stambyteOngoing: city.cityStambyte.ongoing,
    reliningCase: city.cityStambyte.relining === true,
  };
  const merged = mergeStambyte({ city: reading, report: null, text: base.textStambyte });
  return candidateFactsSchema.parse({
    ...base,
    fastighetsbeteckning: base.fastighetsbeteckning ?? beteckning,
    beteckningRung: base.fastighetsbeteckning !== null ? (base.beteckningRung ?? "a") : rung,
    ...city,
    ...merged,
  });
}

const EMPTY_BY_RUNG = (): Record<AddressRung, number> => ({ a: 0, a2: 0, b: 0, c: 0 });

/** The budget or the deadline ran out. `label` goes into the stats as the reason the stage stopped. */
class LimitReached extends Error {
  constructor(readonly label: "budget" | "tidsgrans") {
    super(`Stadssteget stoppade: ${label}`);
    this.name = "LimitReached";
  }
}

/** A CityStop from the client, recognised by name so this module needs no import of the client. */
function stopLabelOf(error: unknown): string | null {
  if (error instanceof LimitReached) return error.label;
  if (error instanceof Error && error.name === "CityStop") {
    const label = (error as { label?: unknown }).label;
    return typeof label === "string" && label !== "" ? label : "okant";
  }
  return null;
}

/** Newest first; the record number breaks a tie the way `buildingFactsOf` does. */
const newestFirst = (a: StoredCase, b: StoredCase): number =>
  a.startDate === b.startDate ? b.rec.localeCompare(a.rec) : b.startDate.localeCompare(a.startDate);

/**
 * Adds the city's building facts to every row, one row at a time. Never throws.
 *
 * "cache-only" reads the address map and the case-list files under `cacheDir` and makes no request. "live" asks the
 * city for what the cache lacks, inside the budget and the deadline (see the module comment).
 */
export async function runCityStage(rows: readonly CityStageRow[], opts: CityStageOptions): Promise<CityStageResult> {
  const log = opts.log ?? (() => undefined);
  const live = opts.mode === "live" ? opts : null;
  const now = live?.now ?? (() => new Date());
  const budget = live?.budget ?? CITY_STAGE_REQUEST_BUDGET;
  const deadlineMs = live?.deadlineMs ?? CITY_STAGE_DEADLINE_MS;
  const startedAt = now().getTime();

  const facts: Array<CandidateFacts | null> = rows.map((row) => row.facts);
  const byRung = EMPTY_BY_RUNG();
  let resolved = 0;
  let listsRead = 0;
  let detailsRead = 0;
  let requests = 0;
  let notReached = 0;
  let stopped: string | null = null;

  const deadlineHit = (): boolean => now().getTime() - startedAt >= deadlineMs;

  /** Called right before every request: the budget and the deadline end the stage. */
  const spend = (): void => {
    if (requests >= budget) throw new LimitReached("budget");
    if (deadlineHit()) throw new LimitReached("tidsgrans");
    requests += 1;
  };

  const counted: CityStageClient | null =
    live === null
      ? null
      : {
          addressSearch: (address) => {
            spend();
            return live.client.addressSearch(address);
          },
          caseList: (beteckning) => {
            spend();
            return live.client.caseList(beteckning);
          },
          caseDetail: (rec, archived) => {
            spend();
            return live.client.caseDetail(rec, archived);
          },
        };

  const countedMinkarta: MinKartaResolver | null =
    live?.minkarta == null
      ? null
      : async (address) => {
          spend();
          const answer = await (live.minkarta as MinKartaResolver)(address);
          // Min Karta reports how many requests it made (at most 5); the first was counted above.
          const calls = (answer as { calls?: unknown }).calls;
          if (typeof calls === "number" && calls > 1) requests += Math.floor(calls) - 1;
          return answer;
        };

  const loaded = loadAddressMap({ dir: opts.cacheDir });
  const addressMap = loaded.ok ? loaded.map : {};
  if (live === null && !loaded.ok && loaded.error !== "saknas") log(`[stockholm] adresscachen kunde inte läsas (${loaded.error})`);

  /** One building's cases per run, after its detail pages. `null`: no list could be had. */
  const buildings = new Map<string, readonly StoredCase[] | null>();

  /** The detail pages of one building. A stop cuts them short and is recorded; the pages already read are kept. */
  async function readDetails(beteckning: string, cases: readonly StoredCase[], otherCases: readonly StoredCase[], fetchedAt: Date): Promise<readonly StoredCase[]> {
    if (counted === null) return cases;
    const wanted = cases.filter((c) => needsDetail(c, opts.asOf)).sort(newestFirst).slice(0, MAX_DETAILS_PER_BUILDING);
    let updated = [...cases];
    let read = 0;
    for (const c of wanted) {
      try {
        const detail = await counted.caseDetail(c.rec, c.archived);
        if (detail === null) continue;
        const next = applyDetail(c, detail);
        updated = updated.map((x) => (x.rec === c.rec ? next : x));
        read += 1;
      } catch (error) {
        const label = stopLabelOf(error);
        if (label !== null) {
          stopped = label;
          break;
        }
        log("[stockholm] en detaljsida kunde inte läsas (hoppas över)");
      }
    }
    detailsRead += read;
    if (read > 0) {
      try {
        saveCaseList(beteckning, { cases: updated, otherCases }, { dir: opts.cacheDir, now: fetchedAt });
      } catch {
        log("[stockholm] ärendelistan kunde inte sparas (nästa körning läser om den)");
      }
    }
    return updated;
  }

  async function building(beteckning: string): Promise<readonly StoredCase[] | null> {
    const key = beteckningSlug(beteckning);
    if (buildings.has(key)) return buildings.get(key) ?? null;
    let cases: readonly StoredCase[] | null = null;
    try {
      if (counted === null) {
        const list = loadCaseList(beteckning, { dir: opts.cacheDir });
        if (list.ok) {
          cases = list.entry.cases;
          listsRead += 1;
        }
      } else {
        const refreshed = await refreshCaseListIfStale(beteckning, { dir: opts.cacheDir, now, client: counted, log });
        listsRead += 1;
        let fetchedAt = now();
        if (refreshed.source === "cache") {
          // Reading detail pages does not make the list newer: it keeps the date it was fetched.
          const entry = loadCaseList(beteckning, { dir: opts.cacheDir });
          if (entry.ok && !Number.isNaN(Date.parse(entry.entry.fetchedAt))) fetchedAt = new Date(entry.entry.fetchedAt);
        }
        cases = await readDetails(beteckning, refreshed.cases, refreshed.otherCases, fetchedAt);
      }
    } finally {
      // A building whose list failed is not asked for again in this run (a stop ends the stage anyway).
      buildings.set(key, cases);
    }
    return cases;
  }

  async function processRow(i: number): Promise<void> {
    const row = rows[i];
    const own = row.facts?.fastighetsbeteckning ?? null;
    let beteckning: string | null = own;
    let rung: AddressRung | null = own === null ? null : (row.facts?.beteckningRung ?? "a");
    if (beteckning === null && counted !== null) {
      const answer = await resolveBeteckning(
        { address: row.address, brfName: row.brfName, text: null },
        { client: counted, minkarta: countedMinkarta, cacheDir: opts.cacheDir, now, log },
      );
      beteckning = answer.beteckning;
      rung = answer.rung;
    } else if (beteckning === null) {
      const entry = addressMap[normaliseAddressKey(cleanAddressForSearch(row.address))];
      if (entry !== undefined && entry.status === "resolved" && entry.beteckning !== null) {
        beteckning = entry.beteckning;
        rung = entry.rung;
      }
    }
    if (beteckning === null) return;
    resolved += 1;
    if (rung !== null) byRung[rung] += 1;

    const cases = await building(beteckning);
    const base = row.facts ?? emptyFacts();
    if (cases === null) {
      // The beteckning is known but no list could be had: keep what is known, add nothing about cases.
      facts[i] = candidateFactsSchema.parse({
        ...base,
        fastighetsbeteckning: base.fastighetsbeteckning ?? beteckning,
        beteckningRung: base.fastighetsbeteckning !== null ? (base.beteckningRung ?? "a") : rung,
      });
      return;
    }
    facts[i] = withCityFacts(base, beteckning, rung, cases, opts.asOf);
  }

  for (let i = 0; i < rows.length; i += 1) {
    if (stopped === null && live !== null && deadlineHit()) stopped = "tidsgrans";
    if (stopped !== null) {
      notReached += 1;
      continue;
    }
    try {
      await processRow(i);
    } catch (error) {
      const label = stopLabelOf(error);
      if (label !== null) {
        stopped = label;
        notReached += 1;
      } else {
        log("[stockholm] en rad kunde inte behandlas (hoppas över)");
      }
    }
  }

  return {
    facts,
    stats: { rows: rows.length, resolved, byRung, listsRead, detailsRead, requests, notReached, stopped },
  };
}

/**
 * The one coverage line of a run, in Swedish:
 * "Stadens ärendelista: fastighetsbeteckning 7 av 10 (a 1, a2 2, b 3, c 1), ärendelista läst 6, detaljsidor 9, anrop 31, ej nådda 2"
 * plus ", stoppad (<label>)" when the stage was stopped.
 */
export function cityStageLine(stats: CityStageStats): string {
  const { a, a2, b, c } = stats.byRung;
  const line =
    `Stadens ärendelista: fastighetsbeteckning ${stats.resolved} av ${stats.rows} (a ${a}, a2 ${a2}, b ${b}, c ${c}), ` +
    `ärendelista läst ${stats.listsRead}, detaljsidor ${stats.detailsRead}, anrop ${stats.requests}, ej nådda ${stats.notReached}`;
  return stats.stopped === null ? line : `${line}, stoppad (${stats.stopped})`;
}
