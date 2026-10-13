/**
 * json-store.ts - the one place the headless scripts write and read small JSON
 * files (Phase 14.2): the snapshot written by `scripts/fit-score.ts`, the vision
 * cache (`vision-cache.ts`) and, later, the watch state.
 *
 * Script-side only (node:fs). The app tree never imports it: an import from
 * `src/app`, `src/actions` or `src/components` would drag file-system writes
 * into the Next.js server bundle.
 *
 * Why it exists: before this file `writeJsonAtomic` and the path guard lived
 * inside `scripts/fit-score.ts`, and a second and third writer would have meant
 * a second and third copy of "write to a temp file, then rename" (a half-written
 * file is never seen by the next run).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

/** Atomic text write: a temp file in the same directory, then rename (the weekly HTML mail file uses it too). */
export function writeTextAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

/** Atomic write of a JSON value: a temp file in the same directory, then rename. */
export function writeJsonAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Parsed JSON from `path`, or `null` when the file does not exist (ENOENT).
 * Any other failure (permissions, a file that is not JSON) throws, so a caller
 * that wants "bad file = empty" must say so itself and say it out loud.
 */
export function readJsonIfExists(path: string): unknown | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
  return JSON.parse(text) as unknown;
}

/**
 * The absolute path when `path` lies inside `opts.dir` (compared with a path
 * separator, so a sibling such as `data-evil/` does not pass) and ends with
 * `opts.ext`, else `null` (T-14.1-12, T-14.2-13). Generalised from the old
 * `guardedOutPath`.
 */
export function guardedDataPath(path: string, opts: { dir: string; ext: string }): string | null {
  const dir = resolve(opts.dir);
  const abs = resolve(path);
  return abs.startsWith(dir + sep) && abs.endsWith(opts.ext) ? abs : null;
}
