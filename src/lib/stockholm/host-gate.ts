/**
 * host-gate.ts - the per-host "go away for a day" file, the per-host pacer and the Monday-window check for manual
 * tools (Phase 14.6, D-01, R-01, R-02).
 *
 * Script-side only (node:fs). The app tree never imports it. It borrows the idea of `booli-gate.mjs` (a refusal
 * means 24 hours of silence) but never reads, writes or waits on that file or its log: one gate and one spacing
 * floor PER HOST (Pitfall 2).
 *
 * THE BLOCK FILE `.planning/calibration/data/host-gates.json` (gitignored): `{ "<host>": { blockedUntil, reason,
 * disabled? } }`. `reason` is a fixed label (lower-case letters, digits, hyphens), so no URL, body or message can
 * enter it. `disabled: true` means "blocked with no end" (plan 04 sets it when Min Karta refuses the honest
 * User-Agent). A damaged file is reported in Swedish and counts as no block when READ; `blockHost` rewrites it only
 * after saying so.
 *
 * THE RUN LOCK: every city run holds `acquireRunLock(CITY_LOCK_PATH)` from watch-state.ts (no lock code of its own),
 * so two of our processes never overlap. The directory must exist before the lock is taken.
 */
import { z } from "zod/v4";
import { makeStartGate } from "@/lib/booli/start-gate";
import { guardedDataPath, readJsonIfExists, writeJsonAtomic } from "@/lib/discovery/json-store";

/** The gitignored data directory every city file lives under. */
export const CITY_DATA_DIR = ".planning/calibration/data";
export const HOST_GATES_PATH = ".planning/calibration/data/host-gates.json";
/** A refusal keeps us away this long. */
export const HOST_BLOCK_MS = 24 * 60 * 60 * 1000;
/** Held (with `acquireRunLock`) by every city run, so two of our processes never overlap. The directory must exist. */
export const CITY_LOCK_PATH = ".planning/calibration/data/bygglov/city.lock";

/** What a block reason may look like: a fixed label, never free text. */
const LABEL = /^[a-z0-9-]{1,40}$/;
const HOST = /^[a-z0-9.-]{1,100}$/;

/** The end of a block with no end (`disabled`): the latest date a JavaScript Date can hold. */
export const NO_END = new Date(8_640_000_000_000_000);

const entrySchema = z.object({
  blockedUntil: z.string().refine((s) => !Number.isNaN(Date.parse(s))),
  reason: z.string().regex(LABEL),
  disabled: z.boolean().optional(),
});

export interface HostGateEntry {
  blockedUntil: string;
  reason: string;
  disabled?: boolean;
}

export type HostGates = Record<string, HostGateEntry>;

type GatesProblem = "ogiltig JSON" | "fel format" | "oläsbar";
type GatesRead = { gates: HostGates; problem: null } | { gates: HostGates; problem: GatesProblem };

/**
 * Reads the block file entry by entry: every valid entry is kept (a `disabled` flag included), and any entry or file
 * that cannot be read is reported as the problem.
 */
function readGatesChecked(path: string): GatesRead {
  let raw: unknown;
  try {
    raw = readJsonIfExists(path);
  } catch (error) {
    return { gates: {}, problem: error instanceof SyntaxError ? "ogiltig JSON" : "oläsbar" };
  }
  if (raw === null) return { gates: {}, problem: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { gates: {}, problem: "fel format" };
  const gates: HostGates = {};
  let problem: GatesProblem | null = null;
  for (const [host, value] of Object.entries(raw)) {
    const entry = entrySchema.safeParse(value);
    if (!HOST.test(host) || !entry.success) {
      problem = "fel format";
      continue;
    }
    gates[host] = entry.data;
  }
  return problem === null ? { gates, problem: null } : { gates, problem };
}

/** Block files that failed to read in full. A damaged politeness file fails CLOSED: see `hostBlockedUntil`. */
const damagedGates = new WeakSet<object>();

/** True when the gates object came from a block file that could not be read in full. */
export const hostGatesDamaged = (gates: HostGates): boolean => damagedGates.has(gates);

/**
 * The block file's content. A missing file is no block and silent. A damaged file (invalid JSON, a bad entry,
 * unreadable) is reported through `log`, in Swedish, and FAILS CLOSED: `hostBlockedUntil` treats every host as
 * blocked until a person has looked at the file. Reading never rewrites it.
 */
export function readHostGates(path: string = HOST_GATES_PATH, log?: (line: string) => void): HostGates {
  const read = readGatesChecked(path);
  if (read.problem !== null) {
    damagedGates.add(read.gates);
    log?.(`[stockholm] host-gates.json är skadad (${read.problem}): inga anrop görs förrän filen har setts över`);
  }
  return read.gates;
}

/**
 * When the host's block ends, or null when it is not blocked at `now`. A `disabled` host is blocked with no end
 * (the answer is {@link NO_END}), and so is every host when the block file was damaged (fail closed).
 */
export function hostBlockedUntil(gates: HostGates, host: string, now: Date): Date | null {
  if (damagedGates.has(gates)) return NO_END;
  const entry = gates[host];
  if (entry === undefined) return null;
  if (entry.disabled === true) return NO_END;
  const until = new Date(entry.blockedUntil);
  return until.getTime() > now.getTime() ? until : null;
}

/**
 * Puts the host on the 24 hour list. The label must be a fixed word (`/^[a-z0-9-]{1,40}$/`), the file stays under the
 * data directory (`opts.dir`, tests pass a temp one) and is written atomically. Blocks of other hosts are kept; an
 * earlier `disabled` flag is kept. A damaged file is never rewritten: that would drop the `disabled` flag of another
 * host, so this throws (Swedish message) until a person has moved or fixed the file.
 */
export function blockHost(
  path: string,
  host: string,
  label: string,
  now: Date,
  opts: { dir?: string; disabled?: boolean; log?: (line: string) => void } = {},
): HostGateEntry {
  if (!LABEL.test(label)) throw new Error(`Ogiltig etikett för spärren: använd a-z, 0-9 och bindestreck (fick "${label.slice(0, 40)}")`);
  if (!HOST.test(host)) throw new Error(`Ogiltig värd för spärren: "${host.slice(0, 40)}"`);
  const dir = opts.dir ?? CITY_DATA_DIR;
  const safe = guardedDataPath(path, { dir, ext: ".json" });
  if (safe === null) throw new Error(`Spärrfilen får bara skrivas under ${dir}/ som .json-fil (fick ${path})`);

  const read = readGatesChecked(safe);
  if (read.problem !== null) {
    opts.log?.(`[stockholm] host-gates.json är skadad (${read.problem}) och skrivs inte över`);
    throw new Error(`Spärrfilen är skadad (${read.problem}) och skrivs inte över: öppna eller flytta ${path} först`);
  }
  const disabled = opts.disabled === true || read.gates[host]?.disabled === true;
  const entry: HostGateEntry = {
    blockedUntil: new Date(now.getTime() + HOST_BLOCK_MS).toISOString(),
    reason: label,
    ...(disabled ? { disabled: true } : {}),
  };
  writeJsonAtomic(safe, { ...read.gates, [host]: entry });
  return entry;
}

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

export interface HostPacerDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * One start gate per host, each `makeStartGate(3000)`: two request starts to the same host are at least 3 000 ms
 * apart, also when awaited concurrently. A host never waits behind another host.
 */
export function makeHostPacer(deps: HostPacerDeps = {}): (host: string) => Promise<void> {
  const gates = new Map<string, () => Promise<void>>();
  return (host) => {
    let gate = gates.get(host);
    if (gate === undefined) {
      gate = makeStartGate(3000, deps);
      gates.set(host, gate);
    }
    return gate();
  };
}

// ---------------------------------------------------------------------------
// The weekly window (R-02)
// ---------------------------------------------------------------------------

/** Monday 06:30 up to but not including 09:30, local time: the weekly job runs at 07:00 and owns this stretch. */
export function inWeeklyWindow(d: Date): boolean {
  if (d.getDay() !== 1) return false;
  const minutes = d.getHours() * 60 + d.getMinutes();
  return minutes >= 6 * 60 + 30 && minutes < 9 * 60 + 30;
}

/**
 * For MANUAL city tools (spike, sweep, join): throws a Swedish message inside the weekly window. A tool calls it at
 * start and again before each request. The client itself takes no window rule, so the weekly job's own lookups are
 * not subject to it (R-02).
 */
export function assertManualRunAllowed(now: Date): void {
  if (inWeeklyWindow(now)) {
    throw new Error("Stadens verktyg startar inte på måndagar mellan 06:30 och 09:30 (veckokörningen pågår då). Kör efter 09:30.");
  }
}
