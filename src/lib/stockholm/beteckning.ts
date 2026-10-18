/**
 * beteckning.ts - from a street address to the building's fastighetsbeteckning (Phase 14.6, CASE-01, D-02, R-06).
 *
 * The city lists building cases by fastighetsbeteckning ("Droskhästen 8"), Booli gives a street address. A wrong
 * building would make every later column describe the wrong house, so each rung accepts an exact match only and
 * "okänd" is a normal answer. Rungs, cheapest first; the first rung that answers wins:
 *   (a)  the broker text states the beteckning                                    (free)
 *   (a2) a BRF name such as "BRF Oljan 18" read as "Oljan 18", trusted only when the city's list for that guess has
 *        a row with the candidate's own street and number                          (one GET, reused when it works)
 *   (b)  the city's own address search, accepted on the equal-address rule        (one GET)
 *   (c)  Lantmäteriet Min Karta (minkarta.ts)                                      (2 to 5 GETs, last resort)
 *
 * Every answer is remembered per normalised address (resolved 365 days, empty or ambiguous 30 days). A failed lookup
 * (a network or page problem, a CityStop) stores nothing, and neither does an empty or ambiguous answer reached
 * without rung (c): only an answer that all enabled rungs gave is a "no".
 *
 * Script-side only. This module imports client TYPES only; the caller injects the city client and the Min Karta
 * resolver. `niche-score.ts` and `report/flags.ts` must NEVER import it.
 */
import {
  addressEntryFresh,
  addressMapDamage,
  loadAddressMap,
  normaliseAddressKey,
  saveAddressMap,
  saveCaseList,
  type AddressEntry,
  type AddressMap,
  type AddressRung,
} from "@/lib/stockholm/bygglov-cache";
import type { CaseListAnswer, CityClient } from "@/lib/stockholm/bygglov-client";
import type { AddressOption } from "@/lib/stockholm/bygglov-parse";
import type { MinKartaResult } from "@/lib/stockholm/minkarta";
import {
  beteckningFromText,
  beteckningGuessFromBrfName,
  cleanAddressForSearch,
  isStreetLandBeteckning,
} from "@/lib/stockholm/beteckning-text";

/** The rungs in the order they are tried. */
export const BETECKNING_RUNGS = ["a", "a2", "b", "c"] as const satisfies readonly AddressRung[];

export type BeteckningStatus = "resolved" | "ambiguous" | "no_candidates" | "fetch_failed";

export interface BeteckningInput {
  address: string;
  brfName: string | null;
  text: string | null;
}

export interface BeteckningResult {
  /** The designation as the city writes it ("Droskhästen 8"), or null for okänd. */
  beteckning: string | null;
  /** The rung that answered (for a cached answer, the rung that answered the first time). */
  rung: AddressRung | null;
  status: BeteckningStatus;
  fromCache: boolean;
  /** Short Swedish notes about answers that were refused on the way ("inte en byggnad", "tvetydig"). */
  notes: string[];
  /**
   * Set on a rung (a2) success: the case list the city already gave for the confirmed designation, so the caller
   * does not fetch it again. It is also saved to the case-list cache.
   */
  list?: CaseListAnswer;
}

/** Rung (c): `makeMinKartaResolver(...)` from minkarta.ts. */
export type MinKartaResolver = (address: string) => Promise<Pick<MinKartaResult, "status" | "beteckning" | "reason">>;

export interface BeteckningDeps {
  client: Pick<CityClient, "addressSearch" | "caseList">;
  /** Rung (c). Null or missing: the ladder ends at rung (b). */
  minkarta?: MinKartaResolver | null;
  /** Directory of the address map; tests pass a temp directory. */
  cacheDir?: string;
  now: () => Date;
  log?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// The equal-address rule (rung b)
// ---------------------------------------------------------------------------

/** "Ormen Mindre 2, Hornsgatan 42B" gives "hornsgatan 42b". */
const optionAddressKey = (text: string): string => normaliseAddressKey(text.slice(text.indexOf(",") + 1));

/**
 * Which designation the city's options give for the asked address. Only options whose address EQUALS the asked one
 * count (a prefix match like "Hornsgatan 4" for "Hornsgatan 40" is no match); a letterless ask also accepts the
 * entrances 42A and 42B, a lettered ask only its own entrance. One designation: resolved. None: null and the next
 * rung. Two different designations: ambiguous.
 */
export function matchAddressFragment(
  asked: string,
  options: readonly AddressOption[],
): { value: string | null; ambiguous: boolean } {
  const key = normaliseAddressKey(asked);
  const hasLetter = /\d[a-zåäö]$/u.test(key);
  const values = new Set<string>();
  for (const option of options) {
    const addr = optionAddressKey(option.text);
    const equal = addr === key || (!hasLetter && addr.replace(/(\d)[a-zåäö]$/u, "$1") === key);
    if (equal) values.add(option.value);
  }
  if (values.size === 1) return { value: [...values][0], ambiguous: false };
  return { value: null, ambiguous: values.size > 1 };
}

/** The designation for the asked address, or null (nothing matched, or two designations matched). */
export function pickFromAddressFragment(asked: string, options: readonly AddressOption[]): string | null {
  return matchAddressFragment(asked, options).value;
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

const unknown = (status: BeteckningStatus, notes: string[], fromCache = false): BeteckningResult => ({
  beteckning: null,
  rung: null,
  status,
  fromCache,
  notes,
});

/**
 * Reads the address map. Every entry that parses is kept; a damaged entry or file is said out loud and the file is
 * then never written over (CR-01): the answers of this call stay in memory and the next call asks again.
 */
function readMap(deps: BeteckningDeps): { map: AddressMap; writable: boolean } {
  const loaded = loadAddressMap({ dir: deps.cacheDir });
  if (loaded.ok) {
    if (loaded.dropped > 0) {
      deps.log?.(`[stockholm] adresscachen har ${loaded.dropped} poster som inte går att läsa, filen skrivs inte över`);
    }
    return { map: { ...loaded.map }, writable: loaded.dropped === 0 };
  }
  if (loaded.error === "saknas") return { map: {}, writable: true };
  deps.log?.(`[stockholm] adresscachen kunde inte läsas (${loaded.error}), filen skrivs inte över`);
  return { map: {}, writable: false };
}

function remember(map: AddressMap, key: string, entry: AddressEntry, deps: BeteckningDeps, writable: boolean): void {
  if (!writable || addressMapDamage({ dir: deps.cacheDir }) !== null) return;
  saveAddressMap({ ...map, [key]: entry }, { dir: deps.cacheDir });
}

/** "Folkungagatan 61" -> "folkungagatan 61"; an entrance letter is dropped ("42a" -> "42"). */
const streetAndNumber = (address: string): string =>
  normaliseAddressKey(address).replace(/(\d)[a-zåäö]$/u, "$1");

/**
 * True when one of the city's listed addresses for the guessed designation is the candidate's street and number
 * (entrance letter ignored). The city sometimes writes two addresses in one cell ("Östgötagatan 33/Folkungagatan 61").
 */
function listConfirmsAddress(listed: readonly string[], address: string): boolean {
  const wanted = streetAndNumber(address);
  return listed.some((entry) => entry.split("/").some((part) => streetAndNumber(part.trim()) === wanted));
}

/**
 * Finds the fastighetsbeteckning of one address. A CityStop from the client propagates (the caller decides to stop
 * the run) and stores nothing.
 */
export async function resolveBeteckning(input: BeteckningInput, deps: BeteckningDeps): Promise<BeteckningResult> {
  const address = cleanAddressForSearch(input.address);
  if (address === "" || address.length > 80) return unknown("no_candidates", ["ingen sökbar adress"]);
  const key = normaliseAddressKey(address);

  const { map, writable } = readMap(deps);
  const cached = map[key];
  if (cached !== undefined && addressEntryFresh(cached, deps.now())) {
    return { beteckning: cached.beteckning, rung: cached.rung, status: cached.status, fromCache: true, notes: [] };
  }

  const notes: string[] = [];
  const stamp = () => deps.now().toISOString();

  /** A designation is accepted only when it is a building, not street land. Remembers and returns the answer. */
  const accept = (beteckning: string, rung: AddressRung, extra: Partial<BeteckningResult> = {}): BeteckningResult | null => {
    if (isStreetLandBeteckning(beteckning)) {
      notes.push(`${beteckning} är inte en byggnad (gatumark)`);
      return null;
    }
    remember(map, key, { beteckning, rung, status: "resolved", at: stamp() }, deps, writable);
    return { beteckning, rung, status: "resolved", fromCache: false, notes, ...extra };
  };

  // (a) the broker text states it
  const fromText = beteckningFromText(input.text);
  if (fromText !== null) {
    const hit = accept(fromText, "a");
    if (hit !== null) return hit;
  }

  // (a2) the BRF name as a guess, confirmed by a city row with this street and number
  const guess = beteckningGuessFromBrfName(input.brfName);
  if (guess !== null && !isStreetLandBeteckning(guess)) {
    const list = await deps.client.caseList(guess);
    if (listConfirmsAddress(list.addresses, address)) {
      saveCaseList(guess, list, { dir: deps.cacheDir, now: deps.now() });
      const hit = accept(guess, "a2", { list });
      if (hit !== null) return hit;
    } else {
      notes.push(`BRF-namnet ${guess} bekräftades inte av stadens ärenden`);
    }
  }

  // (b) the city's own address search, equal address only
  let ambiguous = false;
  const options = await deps.client.addressSearch(address);
  const match = matchAddressFragment(address, options);
  if (match.value !== null) {
    const hit = accept(match.value, "b");
    if (hit !== null) return hit;
  } else if (match.ambiguous) {
    ambiguous = true;
    notes.push("stadens adresssökning gav flera fastighetsbeteckningar (tvetydig)");
  }

  // (c) Min Karta, the expensive last resort
  if (deps.minkarta) {
    const lookup = await deps.minkarta(address);
    if (lookup.status === "resolved" && lookup.beteckning !== null) {
      const hit = accept(lookup.beteckning, "c");
      if (hit !== null) return hit;
    } else if (lookup.status === "ambiguous") {
      ambiguous = true;
      notes.push("Min Karta kunde inte peka ut en enskild fastighet (tvetydig)");
    } else if (lookup.status === "fetch_failed") {
      // Rung (c) did not answer, so the other rungs' "nothing" is not the whole truth: unknown, and nothing stored.
      notes.push(`Min Karta var inte tillgänglig (${lookup.reason})`);
      return unknown("fetch_failed", notes);
    }
  }

  const status = ambiguous ? "ambiguous" : "no_candidates";
  if (!deps.minkarta) {
    // Rung (c) was not tried (blocked, disabled, a dry run), so "nothing found" is not the answer of all four rungs.
    // It is not stored: once Min Karta is available again the address must be asked again, not served as unknown.
    notes.push("Min Karta användes inte, så svaret sparas inte");
    return unknown(status, notes);
  }
  remember(map, key, { beteckning: null, rung: null, status, at: stamp() }, deps, writable);
  return unknown(status, notes);
}

// ---------------------------------------------------------------------------
// The summary line
// ---------------------------------------------------------------------------

/** "Fastighetsbeteckning: 7 av 10 hittade (a 1, a2 2, b 3, c 1), okänd 3" */
export function rungSummaryLine(results: ReadonlyArray<Pick<BeteckningResult, "beteckning" | "rung">>): string {
  const count: Record<AddressRung, number> = { a: 0, a2: 0, b: 0, c: 0 };
  let found = 0;
  for (const result of results) {
    if (result.beteckning === null) continue;
    found += 1;
    if (result.rung !== null) count[result.rung] += 1;
  }
  return `Fastighetsbeteckning: ${found} av ${results.length} hittade (a ${count.a}, a2 ${count.a2}, b ${count.b}, c ${count.c}), okänd ${results.length - found}`;
}
