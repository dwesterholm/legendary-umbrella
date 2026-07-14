import { runPlaywrightRender } from "@/lib/booli/transport";
import { isBooliUrl } from "@/lib/booli/client";
import {
  AREA_SUGGESTION_PAGE_FUNCTION,
  type AreaSuggestion,
} from "@/lib/booli/area-suggestion-page-function";
import { seedResolve } from "@/lib/discovery/area-seed";
import type { createClient } from "@/lib/supabase/server";

/** Supabase client shape resolveArea needs for the shared area cache. */
type SupabaseServer = Awaited<ReturnType<typeof createClient>>;

/** Shared, learn-as-you-go area-name → areaId cache table (migration 012). */
const CACHE_TABLE = "area_cache";

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
  source: "probe" | "seed" | "cache";
  /** Human label for the resolved area (probe/cache), e.g. "Vasastan, Stockholms kommun". */
  label?: string;
}

/** Upper bound on areas resolved+scraped for one search (bounds Apify spend). */
export const MAX_AREAS_PER_SEARCH = 4;

/**
 * Splits a free-text area query into individual area names so a multi-area
 * search ("Södermalm och Vasastan", "Södermalm, Vasastan") resolves + scrapes
 * each area rather than failing to resolve one impossible combined name.
 *
 * Splits on the Swedish conjunction " och " and on `, & / +` separators;
 * trims, drops empties, de-dupes case-insensitively (preserving first-seen
 * order), and caps to `MAX_AREAS_PER_SEARCH`. A plain single-area query
 * ("Södermalm") returns a one-element list unchanged.
 */
export function splitAreaQuery(areaQuery: string): string[] {
  if (!areaQuery) return [];
  const parts = areaQuery
    .split(/\s+och\s+|\s*[,&/+]\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  }
  return out.slice(0, MAX_AREAS_PER_SEARCH);
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

/** Reads a previously-cached resolution. Never throws — a miss/error is `null`. */
async function readAreaCache(supabase: SupabaseServer, key: string): Promise<AreaResolution | null> {
  try {
    const { data, error } = await supabase
      .from(CACHE_TABLE)
      .select("area_id, label")
      .eq("query_key", key)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as { area_id: string; label: string | null };
    return { areaId: row.area_id, source: "cache", label: row.label ?? undefined };
  } catch (e) {
    console.error("[resolve-area] cache read failed", e);
    return null;
  }
}

/** Persists a resolution so the next search for this area is a free DB read. Never throws. */
async function writeAreaCache(supabase: SupabaseServer, key: string, res: AreaResolution): Promise<void> {
  try {
    await supabase.from(CACHE_TABLE).upsert(
      {
        query_key: key,
        area_id: res.areaId,
        label: res.label ?? null,
        source: res.source,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "query_key" },
    );
  } catch (e) {
    // Non-fatal: a cache write failure must never break resolution.
    console.error("[resolve-area] cache write failed", e);
  }
}

/**
 * Resolves a free-text Swedish area name to a Booli `areaId`. Resolution order:
 *   1. our own DB cache (`area_cache`) — a previously-resolved area is free,
 *   2. the static seed list — instant, curated launch-region areas,
 *   3. the live Booli probe — the expensive headless-render path; a hit is
 *      PERSISTED to the cache so the next search for this area skips Booli.
 *
 * Over time the cache absorbs the popular areas and Booli's own search is hit
 * less and less. Never fabricates an id — returns `null` when all paths miss.
 * The cache is only consulted/written when a `supabase` client is supplied;
 * without one (e.g. unit tests), behaviour is the original seed+probe path.
 *
 * @param name - free-text area name (e.g. "Södermalm", "Hornstull")
 * @param supabase - optional client for the shared area cache (read + write)
 */
export async function resolveArea(
  name: string,
  supabase?: SupabaseServer,
): Promise<AreaResolution | null> {
  const key = name.trim().toLowerCase();

  // (1) Our own DB cache first.
  if (supabase && key) {
    const cached = await readAreaCache(supabase, key);
    if (cached) {
      console.error("[resolve-area] served by cache");
      return cached;
    }
  }

  // (2) Static seed — free, curated, never needs Booli.
  const seedAreaId = seedResolve(name);
  if (seedAreaId) {
    console.error("[resolve-area] served by seed");
    return { areaId: seedAreaId, source: "seed" };
  }

  // (3) Live Booli probe — persist the hit so the NEXT search is a cache read.
  const probed = await probeResolve(name);
  if (probed) {
    console.error("[resolve-area] served by probe");
    if (supabase && key) await writeAreaCache(supabase, key, probed);
    return probed;
  }

  return null;
}
