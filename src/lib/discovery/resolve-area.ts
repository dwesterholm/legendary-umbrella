import { runPlaywrightRender } from "@/lib/booli/transport";
import { isBooliUrl } from "@/lib/booli/client";
import { AREA_SEARCH_PAGE_FUNCTION } from "@/lib/booli/area-search-page-function";
import { seedResolve } from "@/lib/discovery/area-seed";

/**
 * resolve-area.ts — turns a free-text Swedish area name (e.g. "Södermalm",
 * "Nacka") into Booli's opaque `areaId`, the one genuinely-new problem
 * 09-RESEARCH.md flagged as BLOCKING-within-phase (Pitfall 3 / Open
 * Question 1). Booli has no documented free-text area endpoint; the existing
 * `resolveAreaId` (client.ts) only derives an areaId from an EXISTING
 * listing's breadcrumb ladder.
 *
 * Two-path resolution, NEVER hard-blocking (09-02-PLAN.md "phase does not
 * hard-block on the probe" — must_haves):
 *   1. "probe"  — render `/sok/till-salu` via the owned `runPlaywrightRender`
 *      transport with `AREA_SEARCH_PAGE_FUNCTION` (types the search box,
 *      captures the resulting `areaIds=` param). MEDIUM-confidence,
 *      UNVERIFIED-live per 09-RESEARCH.md Assumptions Log A3 as of this plan.
 *   2. "seed"   — on probe failure/throw/no-match, fall back to the small
 *      static `AREA_SEED` launch-region list (`area-seed.ts`).
 *   3. `null`   — neither resolves. The caller surfaces "couldn't resolve
 *      area" to the user — this function NEVER fabricates an areaId.
 *
 * SSRF posture (T-09-03): the probe URL is validated with `isBooliUrl`
 * (client.ts's exact `booli.se`/`*.booli.se` https allowlist) BEFORE any
 * render — no new hostname-validation path is hand-rolled here.
 *
 * Logging posture (T-09-04): only the resolution SOURCE (`probe`/`seed`) is
 * logged, mirroring `client.ts`'s "rung served by" observability line —
 * never the token, never the raw render payload.
 */

export interface AreaResolution {
  areaId: string;
  source: "probe" | "seed";
}

/** Extracts a Booli `areaIds=<N>` value, mirroring `resolveAreaId`'s regex idiom (client.ts). */
function extractAreaId(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const match = url.match(/areaIds=(\d+)/);
  return match ? match[1] : null;
}

/**
 * Runs the live search-box probe for `name`. Returns the resolved areaId, or
 * `null` on any miss (no match, malformed response, or a thrown transport
 * error) — never throws to the caller, since a probe miss is an expected,
 * non-exceptional outcome that must fall through to the seed list.
 */
async function probeResolve(name: string): Promise<string | null> {
  try {
    const url = `https://www.booli.se/sok/till-salu?areaQuery=${encodeURIComponent(name)}`;
    if (!isBooliUrl(url)) return null;

    const items = await runPlaywrightRender(url, AREA_SEARCH_PAGE_FUNCTION);
    for (const item of items) {
      const resolvedUrl = (item as { resolvedUrl?: unknown } | null)?.resolvedUrl;
      const areaId = extractAreaId(resolvedUrl);
      if (areaId) return areaId;
    }
    return null;
  } catch (error) {
    // A dead/blocked render is a probe MISS here, not a hard failure — the
    // seed fallback below is the safety net (must_haves: "never hard-blocks").
    console.error("[resolve-area] probe failed, falling back to seed", error);
    return null;
  }
}

/**
 * Resolves a free-text Swedish area name to a Booli `areaId`, trying the live
 * probe first and falling back to the static seed list. Never fabricates an
 * id — returns `null` when neither path resolves.
 *
 * @param name - free-text area name (e.g. "Södermalm")
 */
export async function resolveArea(name: string): Promise<AreaResolution | null> {
  const probeAreaId = await probeResolve(name);
  if (probeAreaId) {
    console.error("[resolve-area] served by probe");
    return { areaId: probeAreaId, source: "probe" };
  }

  const seedAreaId = seedResolve(name);
  if (seedAreaId) {
    console.error("[resolve-area] served by seed");
    return { areaId: seedAreaId, source: "seed" };
  }

  return null;
}
