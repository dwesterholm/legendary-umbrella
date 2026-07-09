import { runPlaywrightRender } from "@/lib/booli/transport";
import { isBooliUrl } from "@/lib/booli/client";
import {
  AREA_SUGGESTION_PAGE_FUNCTION,
  type AreaSuggestion,
} from "@/lib/booli/area-suggestion-page-function";
import { seedResolve } from "@/lib/discovery/area-seed";

/**
 * resolve-area.ts — turns a free-text Swedish area name (e.g. "Södermalm",
 * "Vasastan", "Hornstull") into Booli's opaque `areaId`.
 *
 * Two-path resolution, NEVER hard-blocking:
 *   1. "probe"  — drive Booli's OWN search box through the owned
 *      `runPlaywrightRender` transport (`AREA_SUGGESTION_PAGE_FUNCTION`) and
 *      read the `areaSuggestionSearch` GraphQL response Booli's client fetches.
 *      This is the real all-of-Sweden mechanism: any area/neighborhood Booli
 *      knows resolves here. Live-confirmed 2026-07-09 (Vasastan → 115349,
 *      Östermalm → 115348).
 *   2. "seed"   — on probe failure/throw/no-match, fall back to the small
 *      static `AREA_SEED` list (`area-seed.ts`) so the launch-region areas keep
 *      working even if Booli's search shape shifts.
 *   3. `null`   — neither resolves. The caller surfaces "couldn't resolve area"
 *      — this function NEVER fabricates an areaId.
 *
 * SSRF posture (T-09-03): the probe URL is validated with `isBooliUrl`
 * (client.ts's `booli.se`/`*.booli.se` https allowlist) BEFORE any render.
 *
 * Logging posture (T-09-04): only the resolution SOURCE (`probe`/`seed`) is
 * logged — never the raw render payload.
 */

export interface AreaResolution {
  areaId: string;
  source: "probe" | "seed";
  /** Human label for the resolved area (probe only), e.g. "Vasastan, Stockholms kommun". */
  label?: string;
}

/** Rank a suggestion by area type — a district/area is a better area match than a street. */
function typeRank(s: AreaSuggestion): number {
  switch (s.typeDisplayName) {
    case "Stadsdel":
      return 0;
    case "Område":
      return 1;
    case "Gata":
      return 3;
    default:
      return 2;
  }
}

/**
 * Picks the best area suggestion for a free-text query, or `null` if the list
 * is empty. Preference order:
 *   1. Exact display-name matches (case-insensitive, trimmed) over partials —
 *      "Vasastan" must not resolve to "City/Norrmalm/Vasastan".
 *   2. District > Område > other > Street (a named district beats a street that
 *      merely surfaced in the same search).
 *   3. Booli's own relevance order as the stable tiebreaker — for an ambiguous
 *      name shared across municipalities (Vasastan exists in Stockholm,
 *      Linköping, Göteborg, Örebro), Booli ranks the Stockholm district first,
 *      which is the right default for this Stockholm-focused MVP.
 *
 * Exported for unit testing against real captured `areaSuggestionSearch` shapes.
 */
export function pickBestSuggestion(
  query: string,
  suggestions: AreaSuggestion[] | undefined | null,
): AreaSuggestion | null {
  if (!suggestions || suggestions.length === 0) return null;
  const q = query.trim().toLowerCase();
  const exact = suggestions.filter((s) => (s.displayName || "").trim().toLowerCase() === q);
  const pool = exact.length > 0 ? exact : suggestions;
  const ranked = pool
    .map((s, i) => ({ s, i }))
    .sort((a, b) => typeRank(a.s) - typeRank(b.s) || a.i - b.i);
  return ranked[0]?.s ?? null;
}

/**
 * Runs the live search-box probe for `name`. Returns the resolved
 * `AreaResolution`, or `null` on any miss (no suggestion, malformed response,
 * or a thrown transport error) — never throws, since a probe miss is expected
 * and must fall through to the seed list.
 */
async function probeResolve(name: string): Promise<AreaResolution | null> {
  try {
    const url = `https://www.booli.se/sok/till-salu?areaQuery=${encodeURIComponent(name)}`;
    if (!isBooliUrl(url)) return null;

    const items = await runPlaywrightRender(url, AREA_SUGGESTION_PAGE_FUNCTION);
    const first = items[0] as { suggestions?: AreaSuggestion[] } | undefined;
    const best = pickBestSuggestion(name, first?.suggestions);
    if (best && best.id) {
      return {
        areaId: best.id,
        source: "probe",
        label: best.parentDisplayName
          ? `${best.displayName}, ${best.parentDisplayName}`
          : best.displayName,
      };
    }
    return null;
  } catch (error) {
    // A dead/blocked render is a probe MISS, not a hard failure — the seed
    // fallback below is the safety net (never hard-blocks).
    console.error("[resolve-area] probe failed, falling back to seed", error);
    return null;
  }
}

/**
 * Resolves a free-text Swedish area name to a Booli `areaId`, trying the live
 * probe first and falling back to the static seed list. Never fabricates an id
 * — returns `null` when neither path resolves.
 *
 * @param name - free-text area name (e.g. "Södermalm", "Hornstull")
 */
export async function resolveArea(name: string): Promise<AreaResolution | null> {
  const probed = await probeResolve(name);
  if (probed) {
    console.error("[resolve-area] served by probe");
    return probed;
  }

  const seedAreaId = seedResolve(name);
  if (seedAreaId) {
    console.error("[resolve-area] served by seed");
    return { areaId: seedAreaId, source: "seed" };
  }

  return null;
}
