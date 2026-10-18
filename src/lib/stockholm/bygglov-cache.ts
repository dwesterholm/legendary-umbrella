/**
 * bygglov-cache.ts - the files the city lookups leave behind (Phase 14.6, D-01, CASE-02).
 *
 * Script-side only (node:fs). Every file lives under `.planning/calibration/data/bygglov/` (gitignored), is written
 * through `guardedDataPath` plus an atomic write, and holds tags, digits and dates only: the schemas are STRICT, so a
 * free-text field, an officer name or a document list can neither be saved nor be served from a hand-edited file.
 *
 * A bad file is a miss that the caller says out loud ("ogiltig JSON", "fel format", "annan fastighet"); it is never
 * renamed or deleted. The address map is the exception to "the next save overwrites it": it holds many independent
 * answers, so it is read entry by entry and a save over a file that lost entries on reading is refused (CR-01).
 *
 * `niche-score.ts` and `report/flags.ts` must NEVER import this module (the `stockholm/` prefix is registered in the
 * structural-separation test).
 */
import { join } from "node:path";
import { z } from "zod/v4";
import { guardedDataPath, readJsonIfExists, writeJsonAtomic } from "@/lib/discovery/json-store";
import { BYGGLOV_RULES_VERSION, CASE_KINDS, type StoredCase } from "@/lib/stockholm/bygglov-classify";

/** The one directory the city cache may be written to. */
export const BYGGLOV_CACHE_DIR = ".planning/calibration/data/bygglov";
/** A case list is refreshed when it is this many days old or older. */
export const CASE_LIST_TTL_DAYS = 30;

const DAY_MS = 86_400_000;
/** A `fetchedAt` further ahead of the clock than this is treated as wrong. */
const FUTURE_TOLERANCE_MS = DAY_MS;

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * The file-name form of a beteckning or search word: lower case, å and ä to a, ö to o, runs of spaces to one "-",
 * every other character dropped. The result holds only [a-z0-9-], so it cannot escape a directory. Empty when
 * nothing is left (the callers refuse that).
 */
export function beteckningSlug(text: string): string {
  return text
    .toLocaleLowerCase("sv")
    .replace(/[åä]/g, "a")
    .replace(/ö/g, "o")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ /g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/** The comparison form of a beteckning: trimmed, inner whitespace collapsed, case-insensitive (as `exactMatchRows`). */
const sameBeteckning = (a: string, b: string): boolean => {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLocaleLowerCase("sv");
  return norm(a) === norm(b);
};

// ---------------------------------------------------------------------------
// Schemas (strict: an unknown key is a failure, never silently dropped)
// ---------------------------------------------------------------------------

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const storedCaseSchema = z.strictObject({
  rec: z.string().regex(/^\d{1,12}$/),
  diarie: z.string().max(20),
  startDate: DATE,
  kinds: z.array(z.enum(CASE_KINDS)).max(CASE_KINDS.length),
  primary: z.enum(CASE_KINDS),
  tillsyn: z.boolean(),
  archived: z.boolean(),
  detailRead: z.boolean(),
  latest: z.strictObject({ type: z.string().max(60), code: z.string().max(60).nullable(), date: DATE.nullable() }).nullable(),
  startbeskedDate: DATE.nullable(),
  slutbeskedDate: DATE.nullable(),
  closedDate: DATE.nullable(),
});

const caseListEntrySchema = z.strictObject({
  schemaVersion: z.literal(1),
  rulesVersion: z.number().int(),
  beteckning: z.string().min(1).max(80),
  fetchedAt: z.string(),
  cases: z.array(storedCaseSchema).max(5000),
  /** The "other" cases of the same page (OVK, lift orders), kept for the hiss tag only. */
  otherCases: z.array(storedCaseSchema).max(5000).default([]),
});

export type CaseListEntry = {
  readonly schemaVersion: 1;
  readonly rulesVersion: number;
  readonly beteckning: string;
  readonly fetchedAt: string;
  readonly cases: readonly StoredCase[];
  readonly otherCases: readonly StoredCase[];
};

/** One case of a sweep (an extended search): tags, digits and dates, plus where it sits. No diarienummer, no text. */
export interface SweepCase {
  readonly rec: string;
  readonly beteckning: string;
  readonly addresses: readonly string[];
  readonly startDate: string;
  readonly kinds: readonly StoredCase["kinds"][number][];
  readonly primary: StoredCase["primary"];
  readonly tillsyn: boolean;
  readonly archived: boolean;
}

/** Why a cache file could not be used. Said out loud by the caller. */
export type CacheMiss = "saknas" | "ogiltig JSON" | "fel format" | "annan fastighet" | "annan sökning" | "oläsbar";

// ---------------------------------------------------------------------------
// Guarded I/O
// ---------------------------------------------------------------------------

/**
 * Writes a cache file: refused (Swedish message) unless `path` lies inside `dir` and ends in .json. Compact
 * enough, temp file then rename.
 */
export function saveGuardedJson(path: string, value: unknown, dir: string = BYGGLOV_CACHE_DIR): void {
  const safe = guardedDataPath(path, { dir, ext: ".json" });
  if (safe === null) throw new Error(`Stadens cache får bara skrivas under ${dir}/ som .json-fil (fick ${path})`);
  writeJsonAtomic(safe, value);
}

/** Reads and validates one cache file. Never throws, never renames or deletes the file. */
function loadValidated<T>(path: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: CacheMiss } {
  let raw: unknown;
  try {
    raw = readJsonIfExists(path);
  } catch (error) {
    return { ok: false, error: error instanceof SyntaxError ? "ogiltig JSON" : "oläsbar" };
  }
  if (raw === null) return { ok: false, error: "saknas" };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "fel format" };
  return { ok: true, value: parsed.data };
}

// ---------------------------------------------------------------------------
// TTL
// ---------------------------------------------------------------------------

/**
 * True when a cached entry must be fetched again: unparsable time, more than a day in the future, `ttlDays` old or
 * older, or written by another version of the classification rules. Pure: the clock is a parameter.
 */
export function cacheEntryNeedsRefresh(
  entry: { fetchedAt: string; rulesVersion: number } | null,
  now: Date,
  ttlDays: number = CASE_LIST_TTL_DAYS,
): boolean {
  if (entry === null) return true;
  if (entry.rulesVersion !== BYGGLOV_RULES_VERSION) return true;
  const fetched = Date.parse(entry.fetchedAt);
  if (Number.isNaN(fetched)) return true;
  const age = now.getTime() - fetched;
  if (age < -FUTURE_TOLERANCE_MS) return true;
  return age >= ttlDays * DAY_MS;
}

/** The 30 day rule for a case list (29 d 23 h is fresh, 30 d is stale). */
export const caseListNeedsRefresh = (entry: { fetchedAt: string; rulesVersion: number } | null, now: Date): boolean =>
  cacheEntryNeedsRefresh(entry, now, CASE_LIST_TTL_DAYS);

// ---------------------------------------------------------------------------
// Case lists, one file per beteckning
// ---------------------------------------------------------------------------

export interface CacheDirOpts {
  /** Cache directory; tests pass a temp directory. */
  dir?: string;
}

const caseListPath = (beteckning: string, dir: string): string | null => {
  const slug = beteckningSlug(beteckning);
  return slug === "" ? null : join(dir, "cases", `${slug}.json`);
};

/**
 * Saves the case list of one beteckning. The file name is the slug, so a beteckning like "../x 1" lands in
 * `cases/x-1.json`; a beteckning with nothing sluggable is refused.
 */
export function saveCaseList(
  beteckning: string,
  lists: { cases: readonly StoredCase[]; otherCases?: readonly StoredCase[] },
  opts: CacheDirOpts & { now: Date },
): void {
  const dir = opts.dir ?? BYGGLOV_CACHE_DIR;
  const path = caseListPath(beteckning, dir);
  if (path === null) throw new Error(`Ogiltig fastighetsbeteckning för cachen: "${beteckning}"`);
  const entry = caseListEntrySchema.parse({
    schemaVersion: 1,
    rulesVersion: BYGGLOV_RULES_VERSION,
    beteckning: beteckning.replace(/\s+/g, " ").trim(),
    fetchedAt: opts.now.toISOString(),
    cases: lists.cases,
    otherCases: lists.otherCases ?? [],
  });
  saveGuardedJson(path, entry, dir);
}

/**
 * Reads the case list of one beteckning. A file for another beteckning (a slug collision such as "Oljan 29" and
 * "Oljan-29") is a miss "annan fastighet", never wrong data.
 */
export function loadCaseList(
  beteckning: string,
  opts: CacheDirOpts = {},
): { ok: true; entry: CaseListEntry } | { ok: false; error: CacheMiss } {
  const dir = opts.dir ?? BYGGLOV_CACHE_DIR;
  const path = caseListPath(beteckning, dir);
  if (path === null) return { ok: false, error: "saknas" };
  const loaded = loadValidated(path, caseListEntrySchema);
  if (!loaded.ok) return loaded;
  if (!sameBeteckning(loaded.value.beteckning, beteckning)) return { ok: false, error: "annan fastighet" };
  return { ok: true, entry: loaded.value as CaseListEntry };
}

/** The slice of the city client that the refresh uses (so this module never imports the network client). */
export interface CaseListSource {
  caseList(beteckning: string): Promise<{
    cases: readonly StoredCase[];
    otherCases: readonly StoredCase[];
    headingCount: number | null;
    termsLinks: readonly string[];
  }>;
}

export interface CaseListRefresh {
  /** "cache": zero requests. "city": one request, then saved. */
  source: "cache" | "city";
  cases: readonly StoredCase[];
  otherCases: readonly StoredCase[];
  termsLinks: readonly string[];
  /** Why the cache could not be used (said out loud in the log too), or null. */
  miss: string | null;
}

/**
 * The case list of one beteckning: from the cache when it is fresh, else one request through the client and a save.
 * A stale or damaged file is said out loud. A client failure (CityStop) is NOT caught: it ends the run.
 */
export async function refreshCaseListIfStale(
  beteckning: string,
  opts: CacheDirOpts & { now: () => Date; client: CaseListSource; log?: (line: string) => void },
): Promise<CaseListRefresh> {
  const log = opts.log ?? (() => undefined);
  const loaded = loadCaseList(beteckning, { dir: opts.dir });
  let miss: string | null = null;
  if (loaded.ok) {
    if (!caseListNeedsRefresh(loaded.entry, opts.now())) {
      return { source: "cache", cases: loaded.entry.cases, otherCases: loaded.entry.otherCases, termsLinks: [], miss: null };
    }
    miss = loaded.entry.rulesVersion !== BYGGLOV_RULES_VERSION ? "regelversionen har ändrats" : "för gammal";
  } else if (loaded.error !== "saknas") {
    miss = loaded.error;
  }
  if (miss !== null) log(`[stockholm] cache ${beteckningSlug(beteckning)}: ${miss}, hämtas på nytt`);

  const fresh = await opts.client.caseList(beteckning);
  saveCaseList(beteckning, fresh, { dir: opts.dir, now: opts.now() });
  return { source: "city", cases: fresh.cases, otherCases: fresh.otherCases, termsLinks: fresh.termsLinks, miss };
}

// ---------------------------------------------------------------------------
// Address -> beteckning map (one file, shared by the sold join and the candidate lookup)
// ---------------------------------------------------------------------------

/**
 * The key form of an address: lower case, spaces collapsed, and an entrance letter closed up
 * ("Torsgatan 48 A" -> "torsgatan 48a"), so the city's "48A" and a broker's "48 A" meet.
 */
export function normaliseAddressKey(address: string): string {
  return address
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("sv")
    .replace(/(\d) ([a-zåäö])$/u, "$1$2");
}

export type AddressRung = "a" | "a2" | "b" | "c";
export type AddressStatus = "resolved" | "ambiguous" | "no_candidates";

/** What one address resolved to. A failed lookup (a network or page problem) has no entry: it is never cached. */
export interface AddressEntry {
  readonly beteckning: string | null;
  readonly rung: AddressRung | null;
  readonly status: AddressStatus;
  /** ISO time of the lookup. */
  readonly at: string;
}

export type AddressMap = Record<string, AddressEntry>;

const ADDRESS_RESOLVED_TTL_DAYS = 365;
const ADDRESS_NEGATIVE_TTL_DAYS = 30;

const addressEntrySchema = z
  .strictObject({
    beteckning: z.string().min(1).max(80).nullable(),
    rung: z.enum(["a", "a2", "b", "c"]).nullable(),
    status: z.enum(["resolved", "ambiguous", "no_candidates"]),
    at: z.string(),
  })
  .refine((e) => e.status !== "resolved" || e.beteckning !== null, { message: "resolved needs a beteckning" });

const addressKeySchema = z
  .string()
  .min(1)
  .max(100)
  .refine((k) => normaliseAddressKey(k) === k, { message: "key must be normalised" });

const addressMapFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  entries: z.record(addressKeySchema, addressEntrySchema),
});

/** A resolved entry is trusted for 365 days, an ambiguous or empty one for 30. Pure: the clock is a parameter. */
export function addressEntryFresh(entry: AddressEntry, now: Date): boolean {
  const at = Date.parse(entry.at);
  if (Number.isNaN(at)) return false;
  const age = now.getTime() - at;
  if (age < -FUTURE_TOLERANCE_MS) return false;
  const ttl = entry.status === "resolved" ? ADDRESS_RESOLVED_TTL_DAYS : ADDRESS_NEGATIVE_TTL_DAYS;
  return age < ttl * DAY_MS;
}

const addressMapPath = (dir: string) => join(dir, "address-beteckning.json");

/** Thrown instead of a save that would overwrite entries the loader could not read (CR-01). */
export class AddressMapDamaged extends Error {
  constructor(readonly detail: string) {
    super(`Adresscachen är skadad (${detail}) och skrivs inte över: öppna eller flytta address-beteckning.json först`);
    this.name = "AddressMapDamaged";
  }
}

export type AddressMapLoad =
  | {
      ok: true;
      /** Every entry that parsed on its own. */
      map: AddressMap;
      /** How many entries in the file could not be read and were left out of `map` (0 for a clean file). */
      dropped: number;
    }
  | { ok: false; error: CacheMiss };

/**
 * Reads the address map entry by entry: one damaged entry is dropped and counted, the others survive. A file that
 * is not JSON, or whose wrapper is not `{ schemaVersion: 1, entries: {...} }`, is a miss. Never throws, never
 * renames or deletes the file.
 */
export function loadAddressMap(opts: CacheDirOpts = {}): AddressMapLoad {
  const path = addressMapPath(opts.dir ?? BYGGLOV_CACHE_DIR);
  let raw: unknown;
  try {
    raw = readJsonIfExists(path);
  } catch (error) {
    return { ok: false, error: error instanceof SyntaxError ? "ogiltig JSON" : "oläsbar" };
  }
  if (raw === null) return { ok: false, error: "saknas" };
  const wrapper = z.object({ schemaVersion: z.literal(1), entries: z.record(z.string(), z.unknown()) }).safeParse(raw);
  if (!wrapper.success) return { ok: false, error: "fel format" };
  const map: AddressMap = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(wrapper.data.entries)) {
    const entry = addressEntrySchema.safeParse(value);
    if (!addressKeySchema.safeParse(key).success || !entry.success) {
      dropped += 1;
      continue;
    }
    map[key] = entry.data as AddressEntry;
  }
  return { ok: true, map, dropped };
}

/**
 * Why the map on disk must not be overwritten, or null when saving is safe (no file, or every entry in it reads).
 * A file whose parse loses anything is a hand-edited or newer-version file: the good entries in it took hours of
 * polite traffic to collect.
 */
export function addressMapDamage(opts: CacheDirOpts = {}): string | null {
  const loaded = loadAddressMap(opts);
  if (!loaded.ok) return loaded.error === "saknas" ? null : loaded.error;
  return loaded.dropped > 0 ? `${loaded.dropped} poster går inte att läsa` : null;
}

/**
 * Saves the whole map. A `fetch_failed` entry (or anything else outside the three statuses) is refused, and so is a
 * save over a damaged file (`AddressMapDamaged`): nothing on disk changes.
 */
export function saveAddressMap(map: Record<string, AddressEntry>, opts: CacheDirOpts = {}): void {
  const dir = opts.dir ?? BYGGLOV_CACHE_DIR;
  for (const entry of Object.values(map)) {
    if ((entry as { status: string }).status === "fetch_failed") {
      throw new Error("Ett misslyckat uppslag (fetch_failed) sparas aldrig i adresscachen");
    }
  }
  const damage = addressMapDamage({ dir });
  if (damage !== null) throw new AddressMapDamaged(damage);
  const file = addressMapFileSchema.parse({ schemaVersion: 1, entries: map });
  saveGuardedJson(addressMapPath(dir), file, dir);
}

// ---------------------------------------------------------------------------
// Sweep files (one extended search each)
// ---------------------------------------------------------------------------

export interface SweepQuery {
  readonly district: string;
  readonly description: string;
  /** YYYY-MM-DD. */
  readonly from: string;
  /** YYYY-MM-DD, or null for "to today". */
  readonly to: string | null;
}

const sweepCaseSchema = z.strictObject({
  rec: z.string().regex(/^\d{1,12}$/),
  // May be empty: a case the city lists without a fastighet cannot be joined, but it must not break the whole sweep file.
  beteckning: z.string().max(80),
  addresses: z.array(z.string().max(80)).max(20),
  startDate: DATE,
  kinds: z.array(z.enum(CASE_KINDS)).max(CASE_KINDS.length),
  primary: z.enum(CASE_KINDS),
  tillsyn: z.boolean(),
  archived: z.boolean(),
});

const sweepEntrySchema = z.strictObject({
  schemaVersion: z.literal(1),
  rulesVersion: z.number().int(),
  query: z.strictObject({
    district: z.string().min(1).max(60),
    description: z.string().min(1).max(60),
    from: DATE,
    to: DATE.nullable(),
  }),
  fetchedAt: z.string(),
  headingCount: z.number().int().nonnegative().nullable(),
  cases: z.array(sweepCaseSchema).max(20_000),
});

export type SweepEntry = {
  readonly schemaVersion: 1;
  readonly rulesVersion: number;
  readonly query: SweepQuery;
  readonly fetchedAt: string;
  readonly headingCount: number | null;
  readonly cases: readonly SweepCase[];
};

const compactDate = (date: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Ogiltigt datum i sökningen: ${date.slice(0, 20)}`);
  return date.replace(/-/g, "");
};

/** `<stadsdel>-<sökord>-<från>-<till|open>.json`, built from slugged parts only. */
export function sweepFileName(query: SweepQuery): string {
  const district = beteckningSlug(query.district);
  const description = beteckningSlug(query.description);
  if (district === "" || description === "") throw new Error("Ogiltig sökning för sweep-cachen: stadsdel och sökord måste ha bokstäver");
  const to = query.to === null ? "open" : compactDate(query.to);
  return `${district}-${description}-${compactDate(query.from)}-${to}.json`;
}

const sweepPath = (query: SweepQuery, dir: string) => join(dir, "sweep", sweepFileName(query));

export function saveSweep(
  query: SweepQuery,
  result: { cases: readonly SweepCase[]; headingCount: number | null },
  opts: CacheDirOpts & { now: Date },
): void {
  const dir = opts.dir ?? BYGGLOV_CACHE_DIR;
  const path = sweepPath(query, dir);
  const entry = sweepEntrySchema.parse({
    schemaVersion: 1,
    rulesVersion: BYGGLOV_RULES_VERSION,
    query: { district: query.district, description: query.description, from: query.from, to: query.to },
    fetchedAt: opts.now.toISOString(),
    headingCount: result.headingCount,
    cases: result.cases,
  });
  saveGuardedJson(path, entry, dir);
}

const sameText = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLocaleLowerCase("sv") === b.replace(/\s+/g, " ").trim().toLocaleLowerCase("sv");

/** Reads one sweep. A file written for another search under the same slugged name is a miss "annan sökning". */
export function loadSweep(
  query: SweepQuery,
  opts: CacheDirOpts = {},
): { ok: true; entry: SweepEntry } | { ok: false; error: CacheMiss } {
  const loaded = loadValidated(sweepPath(query, opts.dir ?? BYGGLOV_CACHE_DIR), sweepEntrySchema);
  if (!loaded.ok) return loaded;
  const q = loaded.value.query;
  if (!sameText(q.district, query.district) || !sameText(q.description, query.description) || q.from !== query.from || q.to !== query.to) {
    return { ok: false, error: "annan sökning" };
  }
  return { ok: true, entry: loaded.value as SweepEntry };
}

/** A sweep follows the same 30 day and rulesVersion rule as a case list. */
export const sweepNeedsRefresh = (entry: { fetchedAt: string; rulesVersion: number } | null, now: Date): boolean =>
  cacheEntryNeedsRefresh(entry, now, CASE_LIST_TTL_DAYS);
