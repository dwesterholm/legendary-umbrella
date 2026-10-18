/**
 * bygglov-cache.ts - the files the city lookups leave behind (Phase 14.6, D-01, CASE-02).
 *
 * Script-side only (node:fs). Every file lives under `.planning/calibration/data/bygglov/` (gitignored), is written
 * through `guardedDataPath` plus an atomic write, and holds tags, digits and dates only: the schemas are STRICT, so a
 * free-text field, an officer name or a document list can neither be saved nor be served from a hand-edited file.
 *
 * A bad file is a miss that the caller says out loud ("ogiltig JSON", "fel format", "annan fastighet"); it is never
 * renamed or deleted (the next save overwrites it).
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
