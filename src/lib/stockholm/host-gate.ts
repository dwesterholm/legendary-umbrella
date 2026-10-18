/**
 * host-gate.ts - the per-host "go away for a day" file and the per-host pacer for the city e-service (Phase 14.6,
 * D-01, R-01, R-02).
 *
 * Script-side only (node:fs). The app tree never imports it. It borrows the idea of `booli-gate.mjs` (a refusal
 * means 24 hours of silence) but never reads, writes or waits on that file or its log: one gate and one spacing
 * floor PER HOST (Pitfall 2).
 */
import { makeStartGate } from "@/lib/booli/start-gate";
import { guardedDataPath, readJsonIfExists, writeJsonAtomic } from "@/lib/discovery/json-store";

/** The gitignored data directory every city file lives under. */
export const CITY_DATA_DIR = ".planning/calibration/data";
export const HOST_GATES_PATH = ".planning/calibration/data/host-gates.json";
/** A refusal keeps us away this long. */
export const HOST_BLOCK_MS = 24 * 60 * 60 * 1000;
/** Held (with `acquireRunLock`) by every city run, so two of our processes never overlap. The directory must exist. */
export const CITY_LOCK_PATH = ".planning/calibration/data/bygglov/city.lock";

export interface HostGateEntry {
  blockedUntil: string;
  reason: string;
}

export type HostGates = Record<string, HostGateEntry>;

/** The block file's content, or an empty object when there is none (tracer version; Task 2 hardens it). */
export function readHostGates(path: string = HOST_GATES_PATH): HostGates {
  const raw = readJsonIfExists(path);
  return raw === null ? {} : (raw as HostGates);
}

/** When the host's block ends, or null when it is not blocked at `now`. */
export function hostBlockedUntil(gates: HostGates, host: string, now: Date): Date | null {
  const entry = gates[host];
  if (entry === undefined) return null;
  const until = new Date(entry.blockedUntil);
  return until.getTime() > now.getTime() ? until : null;
}

/** Writes a 24 hour block for the host (tracer version; Task 2 hardens it). */
export function blockHost(path: string, host: string, label: string, now: Date, opts: { dir?: string } = {}): HostGateEntry {
  const safe = guardedDataPath(path, { dir: opts.dir ?? CITY_DATA_DIR, ext: ".json" });
  if (safe === null) throw new Error(`Spärrfilen får bara skrivas under ${opts.dir ?? CITY_DATA_DIR}/ som .json-fil (fick ${path})`);
  const entry: HostGateEntry = { blockedUntil: new Date(now.getTime() + HOST_BLOCK_MS).toISOString(), reason: label };
  writeJsonAtomic(safe, { ...readHostGates(safe), [host]: entry });
  return entry;
}

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
