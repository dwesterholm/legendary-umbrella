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
 *  - "live" (added with the live stage): rungs and case lists cache-first, detail pages for the few cases that matter,
 *    under a request budget and a deadline. A CityStop ends the stage and leaves every row it did not reach as before.
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
  loadAddressMap,
  loadCaseList,
  normaliseAddressKey,
  type AddressRung,
} from "@/lib/stockholm/bygglov-cache";
import {
  INTERESTING_KINDS,
  KIND_PRIORITY,
  buildingFactsOf,
  decisionKind,
  type StoredCase,
} from "@/lib/stockholm/bygglov-classify";
import { cleanAddressForSearch } from "@/lib/stockholm/beteckning-text";

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

export interface CityStageOptions {
  readonly mode: "cache-only";
  /** The run date, "YYYY-MM-DD": cases that start after it are ignored and "recent" is counted from it. */
  readonly asOf: string;
  /** Directory of the city cache (the address map and `cases/`); tests and replays pass a fixture directory. */
  readonly cacheDir?: string;
  readonly log?: (line: string) => void;
}

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

/**
 * Adds the city's building facts to every row. Cache-only: reads the address map and the case-list files under
 * `cacheDir`, makes no request, and uses a valid entry whatever its age. Never throws.
 */
export async function runCityStage(rows: readonly CityStageRow[], opts: CityStageOptions): Promise<CityStageResult> {
  const log = opts.log ?? (() => undefined);
  const facts: Array<CandidateFacts | null> = rows.map((row) => row.facts);
  const byRung = EMPTY_BY_RUNG();
  let resolved = 0;
  let listsRead = 0;

  const loaded = loadAddressMap({ dir: opts.cacheDir });
  const map = loaded.ok ? loaded.map : {};
  if (!loaded.ok && loaded.error !== "saknas") log(`[stockholm] adresscachen kunde inte läsas (${loaded.error})`);

  rows.forEach((row, i) => {
    try {
      const own = row.facts?.fastighetsbeteckning ?? null;
      let beteckning: string | null = own;
      let rung: AddressRung | null = own === null ? null : (row.facts?.beteckningRung ?? "a");
      if (beteckning === null) {
        const entry = map[normaliseAddressKey(cleanAddressForSearch(row.address))];
        if (entry !== undefined && entry.status === "resolved" && entry.beteckning !== null) {
          beteckning = entry.beteckning;
          rung = entry.rung;
        }
      }
      if (beteckning === null) return;
      resolved += 1;
      if (rung !== null) byRung[rung] += 1;

      const list = loadCaseList(beteckning, { dir: opts.cacheDir });
      const base = row.facts ?? emptyFacts();
      if (!list.ok) {
        // The beteckning is known but no list was saved: keep what is known, add nothing about cases.
        facts[i] = candidateFactsSchema.parse({
          ...base,
          fastighetsbeteckning: base.fastighetsbeteckning ?? beteckning,
          beteckningRung: base.fastighetsbeteckning !== null ? (base.beteckningRung ?? "a") : rung,
        });
        return;
      }
      listsRead += 1;
      facts[i] = withCityFacts(base, beteckning, rung, list.entry.cases, opts.asOf);
    } catch {
      log("[stockholm] en rad kunde inte behandlas (hoppas över)");
    }
  });

  return {
    facts,
    stats: { rows: rows.length, resolved, byRung, listsRead, detailsRead: 0, requests: 0, notReached: 0, stopped: null },
  };
}
