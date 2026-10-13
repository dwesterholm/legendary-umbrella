/**
 * watch-state.ts - the weekly run's memory of what Daniel has already seen, and
 * the lock that stops two runs from overlapping (Phase 14.2, WATCH-05, D-14, R-01).
 *
 * WHY IT EXISTS: a weekly table that repeats the same 60 flats every Monday gets
 * ignored. The run remembers each flat's first-seen date and last asking price in
 * a small JSON file, so the mail can say "new since last week" or "price changed
 * from X to Y" and stay silent when nothing moved.
 *
 * WHERE IT LIVES (D-14): `.planning/calibration/data/watch-state.json`, which is
 * gitignored. Never Supabase: this is one person's local bookkeeping, not app
 * data, and a database table would add a migration for no benefit.
 *
 * PURE CORE, THIN I/O: {@link listingKey}, {@link fingerprintOf}, {@link diffRun},
 * {@link pruneStale} and {@link isFirstRun} take plain values and a plain
 * YYYY-MM-DD date string (no clock inside, so the tests are exact). File access
 * is limited to {@link loadWatchState}, {@link saveWatchState} and the lock
 * functions, all through `json-store.ts` or `node:fs`.
 *
 * IDENTITY: a listing is keyed by its Booli path (`/bostad/<n>` or `/annons/<n>`).
 * Booli serves the same flat under both forms over time, so when the key is not
 * in the memory the row is matched on a fingerprint ("address|area|living area",
 * Unicode-normalised, lower-cased). A flat that switches URL form is therefore
 * not "new"; its memory entry is re-keyed to the new path.
 *
 * A FINGERPRINT ALONE IS NOT ENOUGH (found on the first real run, 2026-10-13): two
 * different flats in one building can share address, area and size (Gyllenborgsgatan 15,
 * 38 kvm: one at 3 295 000 kr, one at 3 695 000 kr). A fingerprint match therefore also
 * needs a compatible asking price (equal, or unknown on one side) and, within a run, a
 * floor that does not contradict. The cost of being strict is a false "new" when a flat
 * switches URL form and changes price in the same week; that is visible in the mail,
 * where a false "already seen" would hide a flat.
 *
 * PRICE CHANGE: both prices known and at least 1 kr apart. A difference of 0 kr
 * is "unchanged". A missing price on either side is never a change.
 *
 * PRUNING: an entry not seen for more than {@link WATCH_PRUNE_DAYS} days is
 * dropped when the state is saved (90 days kept, 91 dropped), so a flat that sold
 * and came back months later is "new" again.
 *
 * LOCK: `watch-state.lock` next to the state file, created with the exclusive
 * flag, holding the pid and start time. A second run exits instead of racing the
 * first. A lock is stale, and taken over with a warning, when its pid is gone, when it
 * is unreadable, or when it is older than {@link LOCK_MAX_AGE_MS} whatever its pid says
 * (after a reboot the pid is routinely reused by an unrelated process, and a crashed
 * run must not block every later week). The takeover renames the stale file aside
 * first, which only one racer can win, and the winner confirms its own record is in
 * the file after creating it.
 */

import { closeSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, basename } from "node:path";
import { z } from "zod/v4";
import { guardedDataPath, readJsonIfExists, writeJsonAtomic } from "@/lib/discovery/json-store";

/** Where the memory lives (gitignored). */
export const WATCH_STATE_PATH = ".planning/calibration/data/watch-state.json";

/** The data directory every state, lock and HTML file must stay inside (T-14.2-13). */
export const WATCH_DATA_DIR = ".planning/calibration/data";

/** An entry not seen for MORE than this many days is pruned on save: 90 days old is kept, 91 is pruned. */
export const WATCH_PRUNE_DAYS = 90;

/** R-01: with an empty memory (first run, or a corrupt file read as empty) the mail carries this many rows per section. */
export const WATCH_FIRST_MAIL_PER_SECTION = 15;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const listingEntrySchema = z.object({
  firstSeen: dateString,
  lastSeen: dateString,
  /** The last asking price seen, whole kronor, null when the listing showed none. */
  lastAskingSek: z.number().nullable(),
  fingerprint: z.string(),
  priceHistory: z.array(z.object({ date: dateString, askingSek: z.number() })),
});

export const watchStateSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string().nullable(),
  listings: z.record(z.string(), listingEntrySchema),
});

export type WatchState = z.infer<typeof watchStateSchema>;
export type WatchListing = z.infer<typeof listingEntrySchema>;

export function emptyWatchState(): WatchState {
  return { version: 1, updatedAt: null, listings: {} };
}

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

/** The fields of a table row the memory reads (structurally satisfied by `FitTableRow`). */
export interface WatchRow {
  readonly link: string;
  readonly address: string;
  readonly district: string;
  readonly kvm: number | null;
  readonly askingKr: number | null;
  /** Optional: when two rows share a fingerprint, a known floor that differs makes them different flats. */
  readonly floor?: number | null;
}

/** Asking prices that do not contradict each other: equal, or unknown on one side. */
const priceCompatible = (a: number | null, b: number | null): boolean => a === null || b === null || a === b;

/** Floors that do not contradict each other: equal, or unknown on one side. */
const floorCompatible = (a: number | null | undefined, b: number | null | undefined): boolean =>
  a === null || a === undefined || b === null || b === undefined || a === b;

const LISTING_PATH = /^\/(?:bostad|annons)\/\d+/;

/**
 * "address|area label|living area": NFC-normalised (a decomposed "ö" equals a precomposed one),
 * lower-cased, runs of whitespace collapsed to one space.
 */
export function fingerprintOf(row: Pick<WatchRow, "address" | "district" | "kvm">): string {
  const part = (s: string): string => s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
  return `${part(row.address)}|${part(row.district)}|${row.kvm === null ? "-" : String(row.kvm)}`;
}

/**
 * The memory key of a row: the listing path of its link (`/bostad/<n>` or `/annons/<n>`), else
 * `fp:<fingerprint>` when the link is "-" or not a Booli listing URL.
 */
export function listingKey(row: WatchRow): string {
  try {
    const path = new URL(row.link).pathname;
    if (LISTING_PATH.test(path)) return path.match(LISTING_PATH)![0];
  } catch {
    // not a URL: fall through to the fingerprint
  }
  return `fp:${fingerprintOf(row)}`;
}

export interface ChangedRow<T extends WatchRow = WatchRow> {
  readonly row: T;
  readonly oldSek: number;
  readonly newSek: number;
}

export interface DiffResult<T extends WatchRow = WatchRow> {
  readonly newRows: T[];
  readonly changedRows: ChangedRow<T>[];
  readonly unchanged: T[];
  /** The memory after this run (not yet pruned and not yet saved). */
  readonly next: WatchState;
}

/**
 * Compares a run's rows with the memory. The same listing twice in one run (the same path, or the
 * same fingerprint under a second URL form or district) counts once, the first occurrence winning.
 * `firstSeen` is never rewritten. Rows not in this run keep their entry untouched. Pure: `today` is a
 * YYYY-MM-DD string and the input state is not mutated.
 */
export function diffRun<T extends WatchRow>(state: WatchState, rows: readonly T[], today: string): DiffResult<T> {
  const listings: Record<string, WatchListing> = { ...state.listings };
  const storedByFingerprint = new Map<string, string[]>();
  for (const [key, entry] of Object.entries(state.listings)) {
    const keys = storedByFingerprint.get(entry.fingerprint);
    if (keys === undefined) storedByFingerprint.set(entry.fingerprint, [key]);
    else keys.push(key);
  }

  const newRows: T[] = [];
  const changedRows: ChangedRow<T>[] = [];
  const unchanged: T[] = [];
  const seenKeys = new Set<string>();
  const acceptedByFingerprint = new Map<string, T[]>();

  for (const row of rows) {
    const key = listingKey(row);
    const fingerprint = fingerprintOf(row);
    // The same listing twice in one run: the same path, or the same flat under a second URL form or district.
    const twin = (acceptedByFingerprint.get(fingerprint) ?? []).some(
      (other) => priceCompatible(other.askingKr, row.askingKr) && floorCompatible(other.floor, row.floor),
    );
    if (seenKeys.has(key) || twin) continue;
    seenKeys.add(key);
    acceptedByFingerprint.set(fingerprint, [...(acceptedByFingerprint.get(fingerprint) ?? []), row]);

    let storedKey: string | null = key in listings ? key : null;
    if (storedKey === null) {
      // A URL-form switch: take over the old entry, keyed by the new path. Only an entry that is still
      // in `listings`, was not claimed by another row this run, and has a compatible asking price.
      storedKey =
        (storedByFingerprint.get(fingerprint) ?? []).find(
          (candidate) => candidate in listings && !seenKeys.has(candidate) && priceCompatible(listings[candidate].lastAskingSek, row.askingKr),
        ) ?? null;
    }

    const price = row.askingKr;
    if (storedKey === null) {
      listings[key] = {
        firstSeen: today,
        lastSeen: today,
        lastAskingSek: price,
        fingerprint,
        priceHistory: price === null ? [] : [{ date: today, askingSek: price }],
      };
      newRows.push(row);
      continue;
    }

    const old = listings[storedKey];
    if (storedKey !== key) delete listings[storedKey];
    const changed = price !== null && old.lastAskingSek !== null && Math.abs(price - old.lastAskingSek) >= 1;
    listings[key] = {
      firstSeen: old.firstSeen,
      lastSeen: today,
      lastAskingSek: price ?? old.lastAskingSek,
      fingerprint,
      priceHistory: changed ? [...old.priceHistory, { date: today, askingSek: price }] : old.priceHistory,
    };
    if (changed) changedRows.push({ row, oldSek: old.lastAskingSek as number, newSek: price });
    else unchanged.push(row);
  }

  return { newRows, changedRows, unchanged, next: { version: 1, updatedAt: today, listings } };
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
function daysBetween(from: string, to: string): number {
  const ms = (d: string): number => {
    const [y, m, day] = d.split("-").map(Number);
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

/** Drops entries whose last sighting is MORE than `days` days before `today` (90 kept, 91 dropped). */
export function pruneStale(state: WatchState, today: string, days: number = WATCH_PRUNE_DAYS): WatchState {
  const listings: Record<string, WatchListing> = {};
  for (const [key, entry] of Object.entries(state.listings)) {
    if (daysBetween(entry.lastSeen, today) <= days) listings[key] = entry;
  }
  return { ...state, listings };
}

/** True when the memory holds no listing: the first run, or a corrupt file that was read as empty (R-01). */
export function isFirstRun(state: WatchState): boolean {
  return Object.keys(state.listings).length === 0;
}

// ---------------------------------------------------------------------------
// I/O: load and save
// ---------------------------------------------------------------------------

/**
 * Reads the memory. A missing file is an empty memory with no warning. A file that is not JSON or
 * does not match the schema is read as empty, a Swedish warning is returned and the bad file is
 * renamed to `<path>.bak-<timestamp>` so the next save does not overwrite the evidence. Never throws.
 */
export function loadWatchState(
  path: string,
  opts: { now?: () => number } = {},
): { state: WatchState; warning: string | null } {
  try {
    const raw = readJsonIfExists(path);
    if (raw === null) return { state: emptyWatchState(), warning: null };
    const parsed = watchStateSchema.safeParse(raw);
    if (parsed.success) return { state: parsed.data, warning: null };
  } catch {
    // fall through: unreadable or not JSON is handled like a schema failure
  }
  const stamp = new Date((opts.now ?? Date.now)()).toISOString().replace(/[:.]/g, "-");
  const aside = `${path}.bak-${stamp}`;
  let moved = true;
  try {
    renameSync(path, aside);
  } catch {
    moved = false;
  }
  return {
    state: emptyWatchState(),
    warning: `Bevakningsminnet ${path} kunde inte läsas och lästes som tomt${moved ? `; filen flyttades till ${aside}` : " (filen kunde inte flyttas)"}`,
  };
}

/**
 * A read-only look at the memory for `--dry-run`: it never renames or writes anything (a dry run must
 * leave the world as it found it, where {@link loadWatchState} moves a bad file aside).
 * `lastSeen` is the memory's newest sighting date, or null for an empty memory.
 */
export function peekWatchState(
  path: string,
): { kind: "missing" } | { kind: "corrupt" } | { kind: "ok"; listings: number; lastSeen: string | null } {
  try {
    const raw = readJsonIfExists(path);
    if (raw === null) return { kind: "missing" };
    const parsed = watchStateSchema.safeParse(raw);
    if (!parsed.success) return { kind: "corrupt" };
    const dates = Object.values(parsed.data.listings).map((l) => l.lastSeen).sort();
    return { kind: "ok", listings: dates.length, lastSeen: dates.length === 0 ? null : dates[dates.length - 1] };
  } catch {
    return { kind: "corrupt" };
  }
}

/** Writes the memory atomically. Refuses a path outside the data directory (T-14.2-13) by throwing; `opts.dir` is for tests. */
export function saveWatchState(path: string, state: WatchState, opts: { dir?: string } = {}): void {
  const dir = opts.dir ?? WATCH_DATA_DIR;
  const safe = guardedDataPath(path, { dir, ext: ".json" });
  if (safe === null) throw new Error(`Bevakningsminnet får bara skrivas under ${dir}/ (fick ${path})`);
  writeJsonAtomic(safe, watchStateSchema.parse(state));
}

// ---------------------------------------------------------------------------
// I/O: the run lock
// ---------------------------------------------------------------------------

/** The lock file for a state file: `watch-state.json` gives `watch-state.lock` in the same directory. */
export function lockPathOf(statePath: string): string {
  return join(dirname(statePath), `${basename(statePath).replace(/\.json$/, "")}.lock`);
}

/** Thrown by {@link acquireRunLock} when another live run holds the lock. */
export class RunLockedError extends Error {
  constructor(
    readonly pid: number,
    readonly startedAt: string,
  ) {
    super(`En annan körning pågår (pid ${pid}, startad ${startedAt})`);
    this.name = "RunLockedError";
  }
}

/**
 * A lock older than this is stale even when its pid answers (WR-02): a pid is reused after a reboot,
 * and a run is stopped by its own 2 h watchdog long before this.
 */
export const LOCK_MAX_AGE_MS = 6 * 60 * 60_000;

/** True when `startedAt` is older than {@link LOCK_MAX_AGE_MS} at `nowMs`. An unparseable time counts as old. */
function lockTooOld(startedAt: string, nowMs: number): boolean {
  const started = Date.parse(startedAt);
  return !Number.isFinite(started) || nowMs - started > LOCK_MAX_AGE_MS;
}

/** True when a process with this pid exists. EPERM means it exists but belongs to someone else. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

interface LockRecord {
  readonly pid: number;
  readonly startedAt: string;
}

function readLockRecord(lockPath: string): LockRecord | null {
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockRecord>;
    if (typeof raw.pid === "number" && Number.isInteger(raw.pid) && typeof raw.startedAt === "string") {
      return { pid: raw.pid, startedAt: raw.startedAt };
    }
  } catch {
    // unreadable, not JSON, or gone
  }
  return null;
}

/** Who holds the lock right now, without taking it (the dry run prints this). Null when there is no lock file. */
export function readRunLock(
  lockPath: string,
  opts: { isAlive?: (pid: number) => boolean; now?: () => Date } = {},
): (LockRecord & { alive: boolean }) | null {
  const record = readLockRecord(lockPath);
  if (record === null) return null;
  const nowMs = (opts.now ?? (() => new Date()))().getTime();
  return { ...record, alive: (opts.isAlive ?? isPidAlive)(record.pid) && !lockTooOld(record.startedAt, nowMs) };
}

export interface RunLock {
  /** Removes the lock file. Calling it twice is harmless. */
  release(): void;
  /** Set when a lock from a dead run was taken over. */
  readonly warning: string | null;
}

/**
 * Takes the run lock: the file is created with the exclusive flag (so two runs cannot both succeed)
 * and holds the pid and start time. A lock held by a live pid that started less than
 * {@link LOCK_MAX_AGE_MS} ago throws {@link RunLockedError}; a stale one (pid gone, unreadable, or
 * too old) is taken over with a warning. The caller releases it in `finally`.
 *
 * Takeover is atomic enough for two racers (WR-02): the stale file is RENAMED to a unique name (only
 * one racer's rename can succeed; the other gets ENOENT), the loser of any race backs off, and the
 * winner re-reads the lock after creating it to confirm that its own record is the one in the file.
 */
export function acquireRunLock(
  lockPath: string,
  opts: { pid?: number; now?: () => Date; isAlive?: (pid: number) => boolean } = {},
): RunLock {
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const isAlive = opts.isAlive ?? isPidAlive;
  const token = randomBytes(8).toString("hex");
  const mine = JSON.stringify({ pid, startedAt, token });
  let warning: string | null = null;

  const create = (): boolean => {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, mine);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return false;
      throw error;
    }
  };
  const readRaw = (path: string): string | null => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };
  const lockedBy = (path: string): RunLockedError => {
    const winner = readLockRecord(path);
    return new RunLockedError(winner?.pid ?? 0, winner?.startedAt ?? "okänd tid");
  };

  if (!create()) {
    const heldRaw = readRaw(lockPath);
    const held = readLockRecord(lockPath);
    const tooOld = held !== null && lockTooOld(held.startedAt, now().getTime());
    if (held !== null && !tooOld && isAlive(held.pid)) throw new RunLockedError(held.pid, held.startedAt);
    warning =
      held === null
        ? `Låsfilen ${lockPath} var oläslig och togs över`
        : tooOld
          ? `Låsfilen ${lockPath} tillhörde pid ${held.pid} (startad ${held.startedAt}), äldre än ${LOCK_MAX_AGE_MS / 3_600_000} timmar; låset togs över (pid:et kan ha återanvänts)`
          : `Låsfilen ${lockPath} tillhörde pid ${held.pid} (startad ${held.startedAt}), som inte längre körs; låset togs över`;

    // Move the stale file aside. Exactly one racer's rename succeeds.
    const aside = `${lockPath}.stale-${pid}-${token}`;
    let moved = true;
    try {
      renameSync(lockPath, aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      moved = false; // gone already: the holder released, or another racer is taking over
    }
    if (moved) {
      if (readRaw(aside) !== heldRaw) {
        // What we moved is not what we judged stale: another run replaced it between our read and our
        // rename. Put it back (link fails if yet another file appeared) and give way.
        try {
          linkSync(aside, lockPath);
        } catch {
          // a newer lock already exists: that one wins as well
        }
        try {
          unlinkSync(aside);
        } catch {
          // already gone
        }
        throw lockedBy(lockPath);
      }
      try {
        unlinkSync(aside);
      } catch {
        // already gone
      }
    }
    if (!create()) throw lockedBy(lockPath); // another racer took it first
  }

  // Confirm the file really holds our record (a racing takeover could have replaced it).
  if (readRaw(lockPath) !== mine) throw lockedBy(lockPath);

  let released = false;
  return {
    warning,
    release() {
      if (released) return;
      released = true;
      // Only remove a lock that is still ours; never somebody else's after a takeover.
      if (readRaw(lockPath) !== mine) return;
      try {
        unlinkSync(lockPath);
      } catch {
        // already gone: nothing to release
      }
    },
  };
}
