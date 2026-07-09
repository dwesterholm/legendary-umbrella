/**
 * fallback-tree.ts — the ACQ-03 observability layer. Walks a list of rungs
 * (own-Playwright first attempt, own-Playwright second independent attempt,
 * paid-actor last resort), returning WHICH rung/source served the request
 * and whether the result is degraded — never letting a paid-actor fallback
 * happen silently (05-RESEARCH.md Pattern 3).
 *
 * Rung 2 vs rung 1 (05-RESEARCH.md "Fallback Tree — precise rung
 * definitions", Pitfall 5): rung 1 and rung 2 call the SAME
 * `runPlaywrightRender()` core, but at two separate invocation SITES in the
 * rungs array the caller (client.ts, Plan 04) constructs — i.e. literally
 * calling the transport twice on failure. This is intentional, not
 * duplication: a second independent Apify run gets a fresh container and a
 * fresh RESIDENTIAL/SE proxy session/IP, which is the actual resilience lever
 * (rung 1's own internal `maxRequestRetries: 3` has already been fully
 * exhausted by the time rung 2 is attempted). Do not "clean up" rung 2 by
 * collapsing it into rung 1, and do not flag near-identical rung 1/rung 2
 * attempt functions as code-review duplication — see Pitfall 5.
 *
 * HIGH-1 discipline at the tree level: `walkFallbackTree` NEVER silently
 * returns empty/undefined when every rung is exhausted — it throws a
 * distinguishable, Swedish user-facing error, mirroring the same discipline
 * `sold-source.ts` already enforces per-source (see that file's doc comment,
 * lines 27-31).
 */

export interface FallbackResult<T> {
  data: T;
  source: "own-playwright" | "own-playwright-retry" | "paid-actor";
  rung: 1 | 2 | 3;
  health: "ok" | "degraded";
}

/**
 * Tries each rung in order. Returns the first successful rung's result,
 * discriminated by `source`/`rung`/`health` (ACQ-03 observability). Logs
 * `[booli-client] rung N (<source>) failed` on every throw (never logging a
 * secret — just the error object) and continues to the next rung. Throws
 * once every rung has failed — this function never returns an empty/ambiguous
 * result.
 */
export async function walkFallbackTree<T>(
  rungs: Array<{ source: FallbackResult<T>["source"]; attempt: () => Promise<T> }>,
): Promise<FallbackResult<T>> {
  // IN-04: `rung: (i + 1) as 1 | 2 | 3` below is a type assertion, not a
  // runtime check — a 4th+ rung would silently mis-label `rung` at runtime
  // while the type system still claims `1 | 2 | 3`. Fail loudly instead.
  if (rungs.length > 3) {
    throw new Error("walkFallbackTree supports at most 3 rungs");
  }
  let lastError: unknown;
  for (let i = 0; i < rungs.length; i++) {
    try {
      const data = await rungs[i].attempt();
      return {
        data,
        source: rungs[i].source,
        rung: (i + 1) as 1 | 2 | 3,
        health: i === 0 ? "ok" : "degraded",
      };
    } catch (error) {
      console.error(`[booli-client] rung ${i + 1} (${rungs[i].source}) failed`, error);
      lastError = error;
    }
  }
  throw new Error(
    `Alla Booli-kallor misslyckades: ${lastError instanceof Error ? lastError.message : "okant fel"}`,
  );
}
