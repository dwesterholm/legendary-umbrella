import { fetchAllabrfDocument } from "@/lib/brf-source/allabrf";

/**
 * fetch-document.ts — the phase-8-LOCAL fallback-tree walker (ENRICH-02).
 *
 * WHY a local walker instead of generalizing Phase 5's Booli fallback-tree
 * walker in `src/lib/booli/fallback-tree.ts` (08-RESEARCH.md Pattern 3, this
 * plan's objective "Fallback-tree decision (resolved)"): `fallback-tree.test.ts`
 * asserts on BOTH the fixed literal `FallbackResult<T>["source"]` union
 * (`"own-playwright" | "own-playwright-retry" | "paid-actor"`) AND the
 * hardcoded `[booli-client]` log prefix and "Alla Booli-källor" error
 * message. Generalizing that file to accept Phase 8's `"auto_allabrf"` /
 * `"auto_bolagsverket"` sources and a `[brf-source]` prefix would break
 * those Phase 5 assertions. `walkBrfSources` below copies the EXACT same
 * discipline (per-rung logging, `rungs.length > 3` loud-fail, throw-on-
 * exhaustion) at a phase-8-local call site, without touching Booli's tested
 * code (T-08-09).
 *
 * DEFERRED IDEAS (see 08-02-PLAN.md `<deferred_ideas>` + 08-RESEARCH.md Open
 * Question 2, RESOLVED): a `bolagsverket` bulk-feed rung is intentionally
 * NOT built in Phase 8 v1 — Bolagsverket has no free, on-demand,
 * name-searchable API returning a single BRF's årsredovisning; its free
 * feed is a weekly bulk zip requiring a scheduled ingestion+index pipeline,
 * a separate piece of infrastructure. `FetchedDocument.source` already
 * reserves an `"auto_bolagsverket"` variant and `walkBrfSources` accepts an
 * arbitrary rung list, so a Bolagsverket rung slots in AHEAD of Allabrf
 * without restructuring once that ingestion pipeline is built.
 */

/** A fetched årsredovisning document, ready for the shared extraction core (Plan 01's `runBrfExtraction`). */
export interface FetchedDocument {
  source: "auto_allabrf" | "auto_bolagsverket";
  text: string;
  orgNr: string;
  fiscalYear: number | null;
  /**
   * Fiscal-year staleness flag (Pitfall 5 — never silently stale, never
   * fabricated "most recent"). `false` when a newer fiscal year is
   * knowably available; `true` when the fetched year is the newest known;
   * `null` when staleness is UNKNOWN (no `availableYears` signal at all —
   * an honest "we can't tell", never defaulted to `true`).
   */
  isMostRecent: boolean | null;
}

export interface BrfRung {
  source: FetchedDocument["source"];
  attempt: () => Promise<FetchedDocument | null>;
}

/**
 * Tries each rung in order; on success returns that rung's `FetchedDocument`
 * directly (the shape is already the final `FetchedDocument`, unlike Booli's
 * generic Phase-5 walker, which wraps `data` in a `FallbackResult` envelope —
 * Phase 8 has no analogous "rung/health" metadata requirement on the
 * returned value itself, only on the walker's internal behavior).
 *
 * Discipline copied verbatim from that Phase-5 walker (fallback-tree.ts
 * lines 42-68): a thrown error OR a `null` return is treated as a rung failure,
 * logged as `[brf-source] rung N (<source>) failed`, and the walk continues
 * to the next rung. A rung list longer than 3 throws immediately (IN-04
 * loud-fail — a 4th+ rung would need runtime rung-numbering beyond what this
 * walker is verified against). Exhausting every rung throws a distinguishable
 * Swedish error — this function NEVER returns `undefined`/an empty result
 * silently (HIGH-1 discipline, T-08-09).
 *
 * WR-03: the `rungs.length > 3` guard is currently unreachable from
 * `fetchArsredovisning` (the only real caller passes exactly one Allabrf
 * rung today), but it is NOT untested dead code — it fires synchronously
 * BEFORE any rung's `attempt()` runs (see the length check ahead of the
 * loop below), so a future contributor adding a 4th rung (e.g. a
 * Bolagsverket bulk-feed rung ahead of Allabrf, see the module doc comment)
 * without updating this walker's rung-numbering assumptions gets a loud,
 * immediate failure rather than silently mis-numbered log lines. Covered
 * directly by `fetch-document.test.ts`'s "throws a loud, immediate error
 * for a rung list longer than 3 (IN-04)" case, which asserts no rung's
 * `attempt()` is ever invoked once the guard trips.
 */
export async function walkBrfSources(rungs: BrfRung[]): Promise<FetchedDocument> {
  if (rungs.length > 3) {
    throw new Error("walkBrfSources supports at most 3 rungs");
  }

  let lastError: unknown;
  for (let i = 0; i < rungs.length; i++) {
    try {
      const result = await rungs[i].attempt();
      if (result !== null) {
        return result;
      }
      // A null return (not a throw) is still a rung failure — log it the
      // same way so "attempt degraded to null" and "attempt threw" are
      // equally visible in the fallback trail.
      console.error(`[brf-source] rung ${i + 1} (${rungs[i].source}) failed`);
      lastError = new Error(`rung ${i + 1} (${rungs[i].source}) returned null`);
    } catch (error) {
      console.error(`[brf-source] rung ${i + 1} (${rungs[i].source}) failed`, error);
      lastError = error;
    }
  }

  throw new Error(
    `Alla årsredovisningskällor misslyckades: ${
      lastError instanceof Error ? lastError.message : "okänt fel"
    }`,
  );
}

/**
 * Computes the ENRICH-02 staleness flag from a fetched `fiscalYear` and the
 * list of fiscal years the source reports as available. Never fabricates
 * "most recent" when the signal is unknown (Pitfall 5): an empty/unknown
 * `availableYears` list yields `null`, not `true`.
 */
function computeIsMostRecent(
  fiscalYear: number | null,
  availableYears: number[],
): boolean | null {
  if (fiscalYear === null || availableYears.length === 0) {
    return null;
  }
  const newestKnown = Math.max(...availableYears);
  return newestKnown <= fiscalYear;
}

/**
 * Fetches an årsredovisning for `orgNr`, walking the v1 rung list (Allabrf
 * only — Bolagsverket deferred, see module doc comment). Returns a
 * `FetchedDocument` with a real fiscal-year staleness flag, or throws the
 * distinguishable Swedish "Alla årsredovisningskällor misslyckades" error
 * when the rung is exhausted (never a silent empty/undefined — the Plan 03
 * caller relies on this to honestly fall through to manual upload).
 */
export async function fetchArsredovisning(orgNr: string): Promise<FetchedDocument> {
  const rungs: BrfRung[] = [
    {
      source: "auto_allabrf",
      attempt: async () => {
        const doc = await fetchAllabrfDocument(orgNr);
        if (doc === null) return null;
        return {
          source: "auto_allabrf",
          text: doc.text,
          orgNr,
          fiscalYear: doc.fiscalYear,
          isMostRecent: computeIsMostRecent(doc.fiscalYear, doc.availableYears),
        };
      },
    },
  ];

  return walkBrfSources(rungs);
}
