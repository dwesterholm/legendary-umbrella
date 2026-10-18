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
 * (a network or page problem, a CityStop) stores nothing.
 *
 * Script-side only. This module imports client TYPES only; the caller injects the city client and the Min Karta
 * resolver. `niche-score.ts` and `report/flags.ts` must NEVER import it.
 */
import {
  addressEntryFresh,
  loadAddressMap,
  normaliseAddressKey,
  saveAddressMap,
  type AddressEntry,
  type AddressMap,
  type AddressRung,
} from "@/lib/stockholm/bygglov-cache";
import type { CityClient } from "@/lib/stockholm/bygglov-client";
import type { AddressOption } from "@/lib/stockholm/bygglov-parse";

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
}

export interface BeteckningDeps {
  client: Pick<CityClient, "addressSearch">;
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

/** Reads the address map; a damaged file is said out loud and counts as empty (the next save rewrites it). */
function readMap(deps: BeteckningDeps): AddressMap {
  const loaded = loadAddressMap({ dir: deps.cacheDir });
  if (loaded.ok) return { ...loaded.map };
  if (loaded.error !== "saknas") deps.log?.(`[stockholm] adresscachen kunde inte läsas (${loaded.error}), den skrivs om`);
  return {};
}

function remember(map: AddressMap, key: string, entry: AddressEntry, deps: BeteckningDeps): void {
  saveAddressMap({ ...map, [key]: entry }, { dir: deps.cacheDir });
}

/**
 * Finds the fastighetsbeteckning of one address. A CityStop from the client propagates (the caller decides to stop
 * the run) and stores nothing.
 */
export async function resolveBeteckning(input: BeteckningInput, deps: BeteckningDeps): Promise<BeteckningResult> {
  const address = input.address.replace(/\s+/g, " ").trim();
  if (address === "") return unknown("no_candidates", ["ingen adress"]);
  const key = normaliseAddressKey(address);

  const map = readMap(deps);
  const cached = map[key];
  if (cached !== undefined && addressEntryFresh(cached, deps.now())) {
    return { beteckning: cached.beteckning, rung: cached.rung, status: cached.status, fromCache: true, notes: [] };
  }

  const options = await deps.client.addressSearch(address);
  const match = matchAddressFragment(address, options);
  if (match.value !== null) {
    remember(map, key, { beteckning: match.value, rung: "b", status: "resolved", at: deps.now().toISOString() }, deps);
    return { beteckning: match.value, rung: "b", status: "resolved", fromCache: false, notes: [] };
  }

  const status = match.ambiguous ? "ambiguous" : "no_candidates";
  remember(map, key, { beteckning: null, rung: null, status, at: deps.now().toISOString() }, deps);
  return unknown(status, [], false);
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
