import * as SunCalc from "suncalc";

/**
 * sun-path.ts — the DETERMINISTIC, LLM-free sun-exposure core (DISC-06).
 *
 * Mirrors `niche-score.ts`'s own file-level doc-comment discipline exactly:
 * this module is PURE (no I/O, no clock mutation beyond reading `Date.now()`
 * indirectly via caller-supplied dates — every exported function here is
 * synchronous and side-effect-free) and has ZERO Anthropic/network
 * dependency. It is NEVER imported by `niche-score.ts` or `flags.ts` (the
 * reciprocal of that invariant is asserted by this module's own doc + the
 * structural-separation test extended alongside `niche-score.test.ts`).
 *
 * `computeSunExposure` is built on `suncalc` (`SunCalc.getPosition` /
 * `SunCalc.getTimes`) — a real astronomy library, not a hand-rolled formula
 * (see 12-RESEARCH.md "Don't Hand-Roll"). Its azimuth convention was
 * numerically confirmed at install time (Task 1) AND by this module's own
 * test file's mandatory smoke test (Pitfall 1): degrees, north-zero,
 * clockwise (0=N, 90=E, 180=S, 270=W; solar noon in the northern hemisphere
 * ≈ 180).
 *
 * `computeSunExposure` returns `byFacadeAndSeason: null` (never a zeroed or
 * empty-object grid) whenever ANY of its four inputs is null/absent — this
 * is the ONLY correct "we don't know" sentinel (Pitfall 4); the UI reads
 * this null to render "ej tillgänglig", never a fabricated "0 timmar" (per
 * CONTEXT.md's "degrade, never guess" locked constraint and the UI-SPEC
 * Copywriting Contract's qualitative-only, no-false-precision rule).
 *
 * `extractOrientationFromDescription` is a pure deterministic Swedish
 * väderstreck keyword scan over ALREADY-EXTRACTED free text (mirrors
 * `brfNameFromBreadcrumbs`'s guard-clause-first / null-on-no-match skeleton,
 * `src/lib/booli/client.ts`). It matches ONLY stated orientation phrases —
 * NEVER derives orientation from an address, NEVER calls an LLM. No match
 * (or nothing to match against) returns `null`.
 *
 * Sun-path exposure is theoretical/unobstructed ONLY — no neighboring-
 * building shadowing geometry is modeled (locked constraint, CONTEXT.md).
 */

export type Facade = "north" | "east" | "south" | "west";
export type Season = "winter" | "springAutumn" | "summer";

/**
 * A qualitative, non-numeric sun-exposure descriptor per the UI-SPEC
 * Copywriting Contract — grid cells NEVER show false-precision hour counts
 * (e.g. "6.2 timmar"), only a hedged Swedish qualitative label.
 */
export type SunQualityLabel =
  | "Ingen direkt sol"
  | "Morgon, låg sol"
  | "Kväll, låg sol"
  | "Morgon, hög sol"
  | "Kväll, hög sol"
  | "Sol större delen av dagen";

export interface SunExposureResult {
  /**
   * null when latitude, longitude, floor, OR orientation is unavailable —
   * "ej tillgänglig", never guessed or zeroed.
   *
   * WR-02 (12-REVIEW.md): when non-null, this is scoped to EXACTLY the
   * facades present in the `orientation` argument passed to
   * `computeSunExposure` — a `Partial`, not a guaranteed-complete
   * `Record<Facade, ...>`. A facade NOT in `orientation` is genuinely
   * absent (no key), not present-with-fabricated-data, matching the
   * function's own "GIVEN a resolved facade list" contract: only facades
   * the caller actually stated are ever computed/returned.
   */
  byFacadeAndSeason: Partial<Record<Facade, Record<Season, SunQualityLabel>>> | null;
  orientationSource: "description" | "unavailable";
  /** low-confidence, stated-not-guessed; null when orientation is unavailable. */
  orientationConfidence: number | null;
}

const FACADES: readonly Facade[] = ["north", "east", "south", "west"];
const SEASONS: readonly Season[] = ["winter", "springAutumn", "summer"];

/** One representative UTC calendar date per season (solstices + a single equinox stand-in for spring/autumn), matched at Claude's discretion per the plan. */
const SEASON_REFERENCE_DATES: Record<Season, string> = {
  winter: "2026-12-21T12:00:00Z", // winter solstice
  springAutumn: "2026-03-20T12:00:00Z", // equinox (spring ≈ autumn, symmetric sun path)
  summer: "2026-06-21T12:00:00Z", // summer solstice
};

/** Each facade's visible ~180° azimuth arc, centered on its compass direction. */
const FACADE_AZIMUTH_CENTER: Record<Facade, number> = {
  north: 0,
  east: 90,
  south: 180,
  west: 270,
};

/** Sampled hours (UTC) across a day used to bucket sun visibility per facade/season. */
const SAMPLE_HOURS_UTC = [4, 6, 8, 10, 12, 14, 16, 18, 20];

/** Smallest signed angular distance between two azimuths (degrees), in [0, 180]. */
function angularDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * For one facade + season, counts how many sampled daylight hours the sun's
 * azimuth falls within the facade's ~180° visible arc AND the sun is above
 * the horizon (altitude > 0) — theoretical/unobstructed only, per the
 * locked constraint (no neighboring-building geometry).
 */
function sampleFacadeVisibility(
  facade: Facade,
  season: Season,
  latitude: number,
  longitude: number,
): { visibleHourFractions: number[]; morningWeighted: boolean } {
  const baseDate = new Date(SEASON_REFERENCE_DATES[season]);
  const center = FACADE_AZIMUTH_CENTER[facade];

  const visibleSamples: { hourUtc: number; altitude: number }[] = [];

  for (const hourUtc of SAMPLE_HOURS_UTC) {
    const sampleDate = new Date(baseDate);
    sampleDate.setUTCHours(hourUtc, 0, 0, 0);
    const pos = SunCalc.getPosition(sampleDate, latitude, longitude);
    if (pos.altitude <= 0) continue; // below horizon — never counted as visible
    if (angularDistance(pos.azimuth, center) <= 90) {
      visibleSamples.push({ hourUtc, altitude: pos.altitude });
    }
  }

  if (visibleSamples.length === 0) {
    return { visibleHourFractions: [], morningWeighted: false };
  }

  const avgHour =
    visibleSamples.reduce((sum, s) => sum + s.hourUtc, 0) / visibleSamples.length;
  // WR-06 (shard-1 review): split morning vs evening around the location's real
  // SOLAR noon (which depends on longitude), not a fixed UTC-13 literal. Sweden
  // is UTC+1/+2, so solar noon lands ~10-11:00 UTC — a fixed 13 mislabeled
  // afternoon-lit (west) facades as "Morgon". Fall back to 12:00 UTC only if
  // SunCalc can't resolve solar noon (e.g. polar edge cases).
  const solarNoon = SunCalc.getTimes(baseDate, latitude, longitude).solarNoon;
  const solarNoonHourUtc = solarNoon.getUTCHours() + solarNoon.getUTCMinutes() / 60;
  const noonThreshold = Number.isFinite(solarNoonHourUtc) ? solarNoonHourUtc : 12;
  const morningWeighted = avgHour < noonThreshold;

  return {
    visibleHourFractions: visibleSamples.map((s) => s.altitude),
    morningWeighted,
  };
}

/** Maps a facade/season's sampled visibility into a qualitative Swedish descriptor — never a numeric hour count. */
function describeSunQuality(
  visibleHourFractions: number[],
  morningWeighted: boolean,
): SunQualityLabel {
  const sampleCount = SAMPLE_HOURS_UTC.length;
  const visibleCount = visibleHourFractions.length;

  if (visibleCount === 0) return "Ingen direkt sol";

  const maxAltitude = Math.max(...visibleHourFractions);
  const highSun = maxAltitude >= 30;
  const coverage = visibleCount / sampleCount;

  if (coverage >= 0.6) return "Sol större delen av dagen";
  return morningWeighted
    ? highSun
      ? "Morgon, hög sol"
      : "Morgon, låg sol"
    : highSun
      ? "Kväll, hög sol"
      : "Kväll, låg sol";
}

/**
 * Computes theoretical/unobstructed sun exposure per facade × season, using
 * `suncalc`'s pure sun-position math. PURE — no I/O, no network, no
 * Anthropic dependency (DISC-06).
 *
 * Guard clause FIRST: whenever latitude, longitude, floor, OR orientation is
 * null, returns the `unavailable` sentinel — NEVER a zeroed/empty grid
 * (Pitfall 4). `floor` is accepted (and required to be non-null) for future
 * per-floor shadowing refinement even though v1's theoretical/unobstructed
 * computation does not vary by floor height — matching the locked v1 scope
 * (no neighboring-building geometry) while keeping the signature stable for
 * a later obstructed-sun-path phase (explicitly deferred, RESEARCH.md).
 *
 * WR-02 (12-REVIEW.md): `orientation` genuinely SCOPES which facades are
 * computed/returned — it is not merely a null-check gate. Only facades
 * present in `orientation` get a `grid[facade]` entry; any facade NOT
 * stated is simply absent from the returned (`Partial`) record, never
 * computed and never fabricated. This matches the doc comment's own
 * "GIVEN a resolved facade list" framing and removes the latent trap where
 * a future caller could reasonably (but incorrectly) assume
 * `result.byFacadeAndSeason.north` would be absent/undefined for an
 * orientation of `["south"]` — it now genuinely is.
 */
export function computeSunExposure(
  latitude: number | null,
  longitude: number | null,
  floor: number | null,
  orientation: Facade[] | null,
): SunExposureResult {
  if (latitude === null || longitude === null || floor === null || orientation === null) {
    return { byFacadeAndSeason: null, orientationSource: "unavailable", orientationConfidence: null };
  }

  const grid: Partial<Record<Facade, Record<Season, SunQualityLabel>>> = {};
  for (const facade of orientation) {
    grid[facade] = {} as Record<Season, SunQualityLabel>;
    for (const season of SEASONS) {
      const { visibleHourFractions, morningWeighted } = sampleFacadeVisibility(
        facade,
        season,
        latitude,
        longitude,
      );
      grid[facade]![season] = describeSunQuality(visibleHourFractions, morningWeighted);
    }
  }

  return {
    byFacadeAndSeason: grid,
    orientationSource: "description",
    // The confidence is carried by the caller's `orientation` origin
    // (extractOrientationFromDescription); this function only computes the
    // math GIVEN a resolved facade list, so it reports a fixed low
    // confidence consistent with "stated-not-guessed" — callers that need
    // the ORIGINAL extraction confidence should read it from
    // extractOrientationFromDescription's own result before calling here.
    orientationConfidence: 0.5,
  };
}

/**
 * A single Swedish väderstreck keyword pattern per facade — stated
 * orientation ONLY, never inferred.
 *
 * WR-01 (12-REVIEW.md): every directional token is `\b`-word-boundary
 * anchored, and the "balkong/fönster ... mot <direction>" alternative bounds
 * its `.*` gap to a short, same-clause window (`[^.,;!?]{0,20}`, never
 * crossing a sentence/clause boundary) instead of the previous unbounded
 * `.*` span. This closes the false-positive path where the gap swallowed an
 * entire remaining sentence and let a directional word match as a mere
 * SUBSTRING of a common Swedish place name later in the text (Norrköping,
 * Söderort, Södertälje, Söderhamn, Södermalm, Västerås, Österåker, ...) — a
 * place name never contains a word-boundary-terminated "söder"/"norr"/
 * "väster"/"öster" token on its own (the place name continues past the
 * boundary character: "Söder|köping", "Väster|ås"), so the `\b...\b`
 * anchoring alone already excludes them, and the bounded gap additionally
 * stops "balkong ... (unrelated clause) ... Norrköping" from being
 * misread as a stated orientation for "balkong".
 */
const ORIENTATION_KEYWORDS: Record<Facade, RegExp> = {
  south:
    /\bsöderläge\b|\bsöderut\b|\bmot\s+söder\b|\bi\s+söder\b|\bsöderorienterad\b|\bsöderbalkong\b|\bbalkong\w*[^.,;!?]{0,20}\bmot\s+söder\b|\bfönster\w*[^.,;!?]{0,20}\bmot\s+söder\b/i,
  west:
    /\bvästerläge\b|\bvästerut\b|\bmot\s+väster\b|\bi\s+väster\b|\bvästerorienterad\b|\bvästerbalkong\b|\bbalkong\w*[^.,;!?]{0,20}\bmot\s+väster\b|\bfönster\w*[^.,;!?]{0,20}\bmot\s+väster\b/i,
  north:
    /\bnorrläge\b|\bnorrut\b|\bmot\s+norr\b|\bi\s+norr\b|\bnorrorienterad\b|\bnorrbalkong\b|\bbalkong\w*[^.,;!?]{0,20}\bmot\s+norr\b|\bfönster\w*[^.,;!?]{0,20}\bmot\s+norr\b/i,
  east:
    /\bösterläge\b|\bösterut\b|\bmot\s+öster\b|\bi\s+öster\b|\bösterorienterad\b|\bösterbalkong\b|\bbalkong\w*[^.,;!?]{0,20}\bmot\s+öster\b|\bfönster\w*[^.,;!?]{0,20}\bmot\s+öster\b/i,
};

/**
 * Extracts a stated (never guessed) facade orientation from free listing
 * description text via a single deterministic keyword pass. Guard clause
 * first, null on no input, null on zero matches — mirrors
 * `brfNameFromBreadcrumbs`'s never-throw / null-on-anything-unmatched
 * skeleton (`src/lib/booli/client.ts`).
 *
 * NEVER derives orientation from a street address; NEVER calls an LLM
 * (both explicitly forbidden by CONTEXT.md's "degrade, never guess" locked
 * constraint) — a bare address string with no stated väderstreck phrase
 * correctly returns null even if it happens to contain a directional
 * word as a substring of a place name (e.g. "Söderlångsgatan").
 */
export function extractOrientationFromDescription(
  description: string | null,
): { facades: Facade[]; confidence: number } | null {
  if (!description) return null;

  const facades = FACADES.filter((facade) => ORIENTATION_KEYWORDS[facade].test(description));
  if (facades.length === 0) return null;

  // Deliberately LOW confidence — this is a keyword match on free text
  // written by a broker, not a structured field; the UI must label it
  // accordingly (e.g. "enligt annonstext, låg konfidens").
  return { facades, confidence: 0.5 };
}
