/**
 * stambyte-join.ts - the sweep plan and the join helpers for the city's stambyte history
 * (Phase 14.6, STAM-01, D-05, R-01, R-05, RESEARCH 5.1 to 5.5).
 *
 * PURE, synchronous - no file system, no network, no clock, no randomness. Dates and the cases come in as
 * parameters. The cache functions and the city client are handed to the runner by `scripts/bygglov-sweep.ts`.
 *
 * WHAT IT DOES: it names the one-off sweep (11 stadsdelar x a keyword list x two start-date windows), indexes the swept
 * cases by address and by fastighetsbeteckning, says how well a sold flat's address meets that index (exact, other
 * entrance letter, same street within two house numbers, or none), and states what a building's recorded stambyten
 * looked like ON THE SALE DATE.
 *
 * HONESTY RULES:
 *  - "No case on record" is unknown, not "never had a stambyte" (RESEARCH 5.2: the record is thin after 2011).
 *  - Relining is a separate tag. A building's stambyte status comes only from cases whose kinds contain "stambyte" (R-05).
 *  - Years are counted from the SALE date. A case that started after the sale is `futureAtSale`, never a past stambyte
 *    (RESEARCH 5.5), so the later price fit cannot see the future.
 *  - A case that was withdrawn (Avskrivet) or refused (Avslag) is not a stambyte.
 *
 * PII RULE: the cases carry tags, digits, dates and street addresses only (bygglov-classify.ts). Nothing here reads a
 * name or a sentence.
 *
 * STRUCTURAL SEPARATION (LOCKED, D-12): like `ceiling-height.ts` and `sun-path.ts`, this module sits beside the ranking
 * path. `niche-score.ts` and `report/flags.ts` must NEVER import it; the "discovery/stambyte-" prefix is registered in
 * `niche-score.test.ts` (in an earlier commit than this file).
 */
import { decisionKind } from "@/lib/stockholm/bygglov-classify";

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * The stadsdelar the sweep asks about, spelled exactly as the city's dropdown spells them (the city says "Vasastaden",
 * Booli says "Vasastan"). The four the sold set uses come first, so a run that is stopped early has them.
 */
export const SWEEP_DISTRICTS = [
  "Södermalm",
  "Kungsholmen",
  "Vasastaden",
  "Östermalm",
  "Norrmalm",
  "Marieberg",
  "Fredhäll",
  "Kristineberg",
  "Reimersholme",
  "Hjorthagen",
  "Ladugårdsgärdet",
] as const;

/** The first start date of the sweep. */
export const SWEEP_START = "1985-01-01";

/** An answer with this many rows or more is not trusted to be complete: the window is split (RESEARCH 5.1). */
export const SPLIT_ROWS = 500;

/**
 * The search words. `substring` is the spike's measured answer to "does the Beskrivning field match inside words"
 * (R-07): true means a short stem finds every compound, so four words cover it. Otherwise the whole words are sent
 * one by one. The bare "VA" is never sent: inside words it would match half the language (RESEARCH 5.1).
 */
export function sweepKeywords(substring: boolean | null): string[] {
  return substring === true ? ["stam", "avlopp", "vatten", "relin"] : ["stambyte", "stamrenovering", "avlopp", "vatten", "relining"];
}

/** A start-date window. `to: null` means "up to today" (no CaseStartDateTo is sent), so the cache name never changes. */
export interface SweepWindow {
  /** YYYY-MM-DD. */
  readonly from: string;
  /** YYYY-MM-DD, or null for "up to today". */
  readonly to: string | null;
}

/** The two windows of D-05: 1985 to the end of 2009 and 2010 onwards. One window per query is plenty (RESEARCH 5.1). */
export function sweepWindows(): SweepWindow[] {
  return [
    { from: SWEEP_START, to: "2009-12-31" },
    { from: "2010-01-01", to: null },
  ];
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

/** What the join needs of a swept case. A `SweepCase` from the cache fits. */
export interface IndexableCase {
  readonly rec: string;
  readonly beteckning: string;
  readonly addresses: readonly string[];
  /** YYYY-MM-DD. */
  readonly startDate: string;
  readonly kinds: readonly string[];
  readonly archived: boolean;
}

/** True when the case carries the stambyte tag. Relining alone is not a stambyte (D-06, R-05). */
export const isStambyteCase = (c: { readonly kinds: readonly string[] }): boolean => c.kinds.includes("stambyte");
export const isReliningCase = (c: { readonly kinds: readonly string[] }): boolean => c.kinds.includes("relining");

export interface CaseTotals {
  readonly cases: number;
  readonly beteckningar: number;
  readonly stambyte: number;
  readonly relining: number;
}

/** Counts over distinct cases (by rec): cases, distinct beteckningar, stambyte-tagged, relining-tagged. */
export function summariseCases(cases: readonly IndexableCase[]): CaseTotals {
  const seen = new Map<string, IndexableCase>();
  for (const c of cases) if (!seen.has(c.rec)) seen.set(c.rec, c);
  const all = [...seen.values()];
  return {
    cases: all.length,
    beteckningar: new Set(all.map((c) => beteckningKey(c.beteckning)).filter((k) => k !== "")).size,
    stambyte: all.filter(isStambyteCase).length,
    relining: all.filter(isReliningCase).length,
  };
}

/** The comparison form of a beteckning: trimmed, inner whitespace collapsed, lower case (as the cache's `sameBeteckning`). */
export function beteckningKey(beteckning: string): string {
  return beteckning.replace(/\s+/g, " ").trim().toLocaleLowerCase("sv");
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * The key form of an address: lower case, spaces collapsed, an entrance letter closed up ("Torsgatan 48 A" ->
 * "torsgatan 48a"). The same rule as `normaliseAddressKey` in bygglov-cache.ts (which uses node:fs, so it is not
 * imported here; a test keeps the two equal).
 */
export function normaliseAddress(address: string): string {
  return address
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("sv")
    .replace(/(\d) ([a-zåäö])$/u, "$1$2");
}

export interface ParsedAddress {
  /** Lower case street name, "krukmakarg" for "Krukmakarg 42". */
  readonly street: string;
  readonly number: number;
  /** One lower case entrance letter, or null. */
  readonly letter: string | null;
}

/** The key of a parsed address: "slipgatan 11", "bondegatan 1f". */
export const addressKey = (a: ParsedAddress): string => `${a.street} ${a.number}${a.letter ?? ""}`;

/** The most numbers or letters one range ("Tengdahlsgatan 4-18", "13 A-D") expands to. */
const RANGE_MAX = 15;
const LETTER_RANGE_MAX = 8;

/**
 * The street addresses one written address stands for. The city writes several things in the address field:
 *  - "Slipgatan 11", "Bondegatan 1f", "Heleneborgsgatan 28 A": one address;
 *  - "Siargatan 9-11", "Tengdahlsgatan 4-18": a range of house numbers (every second number, or every number when the
 *    ends have different parity);
 *  - "Heleneborgsgatan 13 A-D": a range of letters;
 *  - "Tavastgatan 39", then "41": a bare number takes the street of the one before it (`inheritStreet`);
 *  - "Östgötagatan 87A O B +": the first number and letter count, the rest is ignored.
 * An address with no street and no number ("Adress saknas") gives an empty list.
 */
export function parseAddresses(raw: string, inheritStreet: string | null = null): ParsedAddress[] {
  const text = raw.replace(/\\/g, "").replace(/\s+/g, " ").trim().toLocaleLowerCase("sv");
  if (text === "") return [];

  let street: string;
  let number: number;
  let rest: string;
  const full = /^(\D*?[^\d\s])\s*(\d{1,4})(.*)$/u.exec(text);
  if (full !== null && /\p{L}/u.test(full[1])) {
    street = full[1].trim();
    number = Number(full[2]);
    rest = full[3].trim();
  } else {
    const bare = /^(\d{1,4})(.*)$/u.exec(text);
    if (bare === null || inheritStreet === null) return [];
    street = inheritStreet;
    number = Number(bare[1]);
    rest = bare[2].trim();
  }
  if (street === "") return [];

  let letters: Array<string | null> = [null];
  const letter = /^([a-zåäö])(?:\s*-\s*([a-zåäö]))?(?![a-zåäö])/u.exec(rest);
  if (letter !== null) {
    rest = rest.slice(letter[0].length).trim();
    const first = letter[1];
    const last = letter[2];
    if (last === undefined) {
      letters = [first];
    } else {
      const span = last.charCodeAt(0) - first.charCodeAt(0);
      letters = span > 0 && span < LETTER_RANGE_MAX ? Array.from({ length: span + 1 }, (_, i) => String.fromCharCode(first.charCodeAt(0) + i)) : [first];
    }
  }

  let numbers = [number];
  const range = /^-\s*(\d{1,4})(?!\d)/u.exec(rest);
  if (range !== null && letters.length === 1 && letters[0] === null) {
    const end = Number(range[1]);
    const span = end - number;
    if (span > 0 && span <= 40) {
      const step = span % 2 === 0 ? 2 : 1;
      numbers = [];
      for (let n = number; n <= end && numbers.length < RANGE_MAX; n += step) numbers.push(n);
    }
  }

  const out: ParsedAddress[] = [];
  for (const n of numbers) for (const l of letters) out.push({ street, number: n, letter: l });
  return out;
}

// ---------------------------------------------------------------------------
// The case index
// ---------------------------------------------------------------------------

export interface CaseIndex {
  /** Distinct cases by rec. */
  readonly cases: ReadonlyMap<string, IndexableCase>;
  /** Address key ("slipgatan 11", "bondegatan 1f") to the recs of the cases listed under it. */
  readonly byAddress: ReadonlyMap<string, readonly string[]>;
  /** Beteckning key ("skrovet 8") to the recs of its cases. */
  readonly byBeteckning: ReadonlyMap<string, readonly string[]>;
  /** Street to house number to entrance letter ("" for none) to recs: for the letter and near classes. */
  readonly byStreet: ReadonlyMap<string, ReadonlyMap<number, ReadonlyMap<string, readonly string[]>>>;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

/**
 * Indexes the swept cases (distinct by rec; the first copy wins). Every address of every case is indexed, also the
 * ones of a list ("Brännkyrkagatan 64,Ludvigsbergsgatan 1") and the ones a range stands for, and every beteckning.
 */
export function buildCaseIndex(cases: readonly IndexableCase[]): CaseIndex {
  const byRec = new Map<string, IndexableCase>();
  const byAddress = new Map<string, string[]>();
  const byBeteckning = new Map<string, string[]>();
  const byStreet = new Map<string, Map<number, Map<string, string[]>>>();

  for (const c of cases) {
    if (byRec.has(c.rec)) continue;
    byRec.set(c.rec, c);
    const bet = beteckningKey(c.beteckning);
    if (bet !== "") push(byBeteckning, bet, c.rec);

    let lastStreet: string | null = null;
    for (const raw of c.addresses) {
      // A written list can also hold slashes and semicolons ("Krukmakarg 42 / RINGVÄGEN 14").
      for (const part of raw.split(/[/;]/)) {
        for (const a of parseAddresses(part, lastStreet)) {
          lastStreet = a.street;
          push(byAddress, addressKey(a), c.rec);
          let numbers = byStreet.get(a.street);
          if (numbers === undefined) byStreet.set(a.street, (numbers = new Map()));
          let letters = numbers.get(a.number);
          if (letters === undefined) numbers.set(a.number, (letters = new Map()));
          push(letters, a.letter ?? "", c.rec);
        }
      }
    }
  }
  return { cases: byRec, byAddress, byBeteckning, byStreet };
}

export type AddressClass = "exact" | "letter" | "near" | "none";

export interface AddressMatch {
  readonly class: AddressClass;
  /** The recs of the cases the class rests on (empty for "none"). */
  readonly recs: readonly string[];
  /** The distinct beteckningar of those cases, as the city writes them. */
  readonly beteckningar: readonly string[];
}

/** Same street within this many house numbers (not the same number) is "near" (RESEARCH 5.3). */
export const NEAR_NUMBERS = 2;

/**
 * How a sold flat's address meets the swept cases:
 *  - exact: a case is listed under this very address ("Slipgatan 11");
 *  - letter: the same street and number with another entrance letter, or with and without one ("Bondegatan 1" and
 *    "Bondegatan 1f");
 *  - near: the same street within two house numbers; the city's address search must decide if it is the same building
 *    (a corner block lists two streets);
 *  - none: anything else, also an address with no number ("Lützengatan").
 */
export function classifySoldAddress(address: string, index: CaseIndex): AddressMatch {
  const parsed = parseAddresses(address)[0];
  if (parsed === undefined) return { class: "none", recs: [], beteckningar: [] };
  const withBeteckningar = (cls: AddressClass, recs: readonly string[]): AddressMatch => ({
    class: cls,
    recs: [...recs],
    beteckningar: [
      ...new Set(recs.map((rec) => index.cases.get(rec)?.beteckning.replace(/\s+/g, " ").trim() ?? "").filter((b) => b !== "")),
    ],
  });

  const exact = index.byAddress.get(addressKey(parsed));
  if (exact !== undefined) return withBeteckningar("exact", exact);

  const numbers = index.byStreet.get(parsed.street);
  if (numbers === undefined) return withBeteckningar("none", []);

  const same = numbers.get(parsed.number);
  if (same !== undefined) return withBeteckningar("letter", [...same.values()].flat());

  const near: string[] = [];
  for (let d = -NEAR_NUMBERS; d <= NEAR_NUMBERS; d += 1) {
    if (d === 0) continue;
    const letters = numbers.get(parsed.number + d);
    if (letters !== undefined) near.push(...[...letters.values()].flat());
  }
  return near.length > 0 ? withBeteckningar("near", [...new Set(near)]) : withBeteckningar("none", []);
}

export interface JoinCounts {
  readonly rows: number;
  readonly exact: number;
  readonly letter: number;
  readonly near: number;
  readonly none: number;
}

/** How many sold rows fall in each class (RESEARCH 5.3). */
export function joinCounts(addresses: readonly string[], index: CaseIndex): JoinCounts {
  const counts = { rows: addresses.length, exact: 0, letter: 0, near: 0, none: 0 };
  for (const address of addresses) counts[classifySoldAddress(address, index).class] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// The state of a building ON THE SALE DATE
// ---------------------------------------------------------------------------

/** What `stambyteAtSale` reads of a case. A `StoredCase` from the case list fits; a `SweepCase` fits without the decision fields. */
export interface StambyteCaseInput {
  /** YYYY-MM-DD. */
  readonly startDate: string;
  readonly kinds: readonly string[];
  /** YYYY-MM-DD. Absent or null: no slutbesked is recorded (also when the detail page was never read). */
  readonly slutbeskedDate?: string | null;
  /** The latest decision, when the detail page was read. Used only to drop a withdrawn or refused case. */
  readonly latest?: { readonly type: string; readonly code: string | null } | null;
}

export interface StambyteAtSale {
  /** At least one stambyte was finished (or old enough to count as done) on the sale date. */
  readonly recorded: boolean;
  /** The year of the latest such stambyte, or null. */
  readonly latestYear: number | null;
  /** How that year was read: the slutbesked, or (list-only and archived cases) the start of the case. */
  readonly source: "slutbesked" | "start" | null;
  /** Sale year minus `latestYear`, or null. */
  readonly yearsBefore: number | null;
  /** A stambyte started within 5 years before the sale and was not finished by it. */
  readonly ongoingAtSale: boolean;
  /** A stambyte case started AFTER the sale. It is never counted as past (RESEARCH 5.5). */
  readonly futureAtSale: boolean;
}

/** A list-only case with no slutbesked counts as done when it started at least this many years before the sale. */
export const PAST_AFTER_YEARS = 3;
/** A case that started within this many years before the sale and is not done is "ongoing at sale". */
export const ONGOING_WITHIN_YEARS = 5;

/** `iso` moved by whole years; 29 February becomes 28 February in a year without one. */
export function shiftYears(iso: string, years: number): string {
  const year = Number(iso.slice(0, 4)) + years;
  const month = iso.slice(5, 7);
  let day = iso.slice(8, 10);
  if (month === "02" && day === "29") {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    if (!leap) day = "28";
  }
  return `${String(year).padStart(4, "0")}-${month}-${day}`;
}

/**
 * The recorded stambyte state of one building on `soldDate` (YYYY-MM-DD), from its stambyte cases (RESEARCH 5.5):
 *  - PAST at the sale: the slutbesked is on or before the sale date (the year is the slutbesked's), or no slutbesked is
 *    recorded at all and the case started at least 3 years before the sale (the year is the start year: the list-only
 *    and the archived case);
 *  - FUTURE at the sale: the case started after the sale date;
 *  - ONGOING at the sale: it started on or before the sale date, is not past, and started within 5 years of the sale.
 * A relining-only building is not recorded. A case withdrawn (Avskrivet) or refused (Avslag) is ignored.
 */
export function stambyteAtSale(cases: readonly StambyteCaseInput[], soldDate: string): StambyteAtSale {
  const pastLimit = shiftYears(soldDate, -PAST_AFTER_YEARS);
  const ongoingLimit = shiftYears(soldDate, -ONGOING_WITHIN_YEARS);
  let latestYear: number | null = null;
  let source: "slutbesked" | "start" | null = null;
  let ongoing = false;
  let future = false;

  for (const c of cases) {
    if (!isStambyteCase(c)) continue;
    if (c.latest != null) {
      const decision = decisionKind(c.latest.type, c.latest.code);
      if (decision === "avskrivet" || decision === "avslag") continue;
    }
    if (c.startDate > soldDate) {
      future = true;
      continue;
    }
    const finished = c.slutbeskedDate ?? null;
    let year: number | null = null;
    let how: "slutbesked" | "start" | null = null;
    if (finished !== null) {
      if (finished <= soldDate) {
        year = Number(finished.slice(0, 4));
        how = "slutbesked";
      }
    } else if (c.startDate <= pastLimit) {
      year = Number(c.startDate.slice(0, 4));
      how = "start";
    }
    if (year !== null) {
      if (latestYear === null || year > latestYear) {
        latestYear = year;
        source = how;
      }
    } else if (c.startDate >= ongoingLimit) {
      ongoing = true;
    }
  }

  const saleYear = Number(soldDate.slice(0, 4));
  return {
    recorded: latestYear !== null,
    latestYear,
    source,
    yearsBefore: latestYear === null ? null : saleYear - latestYear,
    ongoingAtSale: ongoing,
    futureAtSale: future,
  };
}
