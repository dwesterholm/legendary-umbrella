import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * traffic-log.ts - the one-line note a run leaves when Booli refuses it (Phase 14.5, CR-01).
 *
 * The Booli traffic gate of the phase (`booli-gate.mjs`, R-07) waits 24 hours after every line
 * "<iso time> refused <label>" in this log. The weekly live run writes that line itself when Booli challenges it, so a
 * hand-started run, the enrichment restart or a picture download on the same day is held back by the same gate.
 *
 * The log is gitignored (`.planning/calibration/data/`) and holds times and labels only: the label is checked against
 * the gate's own pattern (lower-case letters, digits, hyphens), so no URL or other text can enter it. Script-only
 * module; best effort: a write that fails returns false and never throws, because the run is already ending on a refusal.
 */

/** Where the gate reads its refusals, relative to the repository root. */
export const BOOLI_TRAFFIC_LOG = ".planning/calibration/data/booli-traffic-14.5.log";

/** Same pattern as the gate's `checkedLabel`. */
const LABEL_PATTERN = /^[a-z0-9-]{1,40}$/;

export interface TrafficLogDeps {
  path?: string;
  now?: () => Date;
  append?: (path: string, text: string) => void;
}

/** The log line for one refusal, e.g. "2026-10-26T07:12:03Z refused weekly-live". Null for a label the gate would reject. */
export function refusalLine(label: string, at: Date): string | null {
  if (!LABEL_PATTERN.test(label)) return null;
  return `${at.toISOString().replace(/\.\d{3}Z$/, "Z")} refused ${label}`;
}

/** Appends one refusal to the traffic log. Returns whether the line was written. */
export function recordBooliRefusal(label: string, deps: TrafficLogDeps = {}): boolean {
  const path = deps.path ?? BOOLI_TRAFFIC_LOG;
  const line = refusalLine(label, (deps.now ?? (() => new Date()))());
  if (line === null) return false;
  try {
    if (deps.append) deps.append(path, `${line}\n`);
    else {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${line}\n`);
    }
    return true;
  } catch {
    return false;
  }
}
