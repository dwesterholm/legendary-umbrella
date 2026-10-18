/**
 * dry-run-cache.ts - where a `--dry-run` of a city tool may write (Phase 14.6, WR-05).
 *
 * A dry run serves saved fixture pages through the real code, with a virtual clock. Whatever it saves would look like
 * a fresh answer from the city to a later live run, which would then never ask those queries again. So a dry run must
 * never write to the live cache: it uses a throw-away directory by default, and a `--cache-dir` that is (or lies in,
 * or contains) the live cache is refused.
 *
 * Pure path logic, no file access.
 */
import { isAbsolute, join, relative, resolve } from "node:path";

/** True when `a` and `b` are the same directory, or one lies inside the other. */
function overlaps(a: string, b: string): boolean {
  const inside = (child: string, parent: string) => {
    const rel = relative(resolve(parent), resolve(child));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  return inside(a, b) || inside(b, a);
}

/**
 * Throws a Swedish message when a dry run was pointed at the live cache. Returns `requested` unchanged otherwise.
 */
export function assertDryRunCacheNotLive(requested: string, liveDir: string): string {
  if (overlaps(requested, liveDir)) {
    throw new Error(
      `--cache-dir pekar på den skarpa cachen (${liveDir}/): en torrkörning skriver aldrig dit. Utelämna flaggan eller välj en annan mapp.`,
    );
  }
  return requested;
}

/**
 * The cache directory of a dry run: the requested one (checked against the live cache), else `<tempDir>/cache`, which
 * the caller removes when the run ends.
 */
export function dryRunCacheDir(opts: { requested: string | null; liveDir: string; tempDir: string }): string {
  return opts.requested === null ? join(opts.tempDir, "cache") : assertDryRunCacheNotLive(opts.requested, opts.liveDir);
}
