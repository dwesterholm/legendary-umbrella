/**
 * The single source of truth for every weight and threshold used by
 * `computeNicheScore` (src/lib/discovery/niche-score.ts). Mirrors
 * `BRF_SCORE_THRESHOLDS` (src/lib/brf/score.ts:25-57) — one exported const
 * object, no magic numbers duplicated anywhere else (niche-score.ts imports
 * every boundary from here; the UI layer never hardcodes a threshold either).
 *
 * Each niche entry is a small table of per-signal weights that SUM TO 1, plus
 * any named threshold constants that signal needs. The three niches are
 * deliberately weighted to differ (DISC-03's binding "distinguishable
 * orderings" constraint) using only facts available on the extended
 * `DiscoveryCandidate` (constructionYear, tenureForm, and a price/sqm-vs-area
 * baseline computed by the caller):
 *
 *  - `renovation-upside`: rewards an OLDER building AND a LOW price/sqm vs the
 *    area baseline — an older, cheaper-per-sqm flat has renovation headroom.
 *  - `turnkey`: rewards a NEWER/recent building; deliberately does NOT reward
 *    low price/sqm (a turnkey buyer pays for move-in-ready, not a discount).
 *  - `imminent-stambyte`: rewards an OLD building via a DISTINCT hedged proxy
 *    threshold (`stambyteProxyYearCutoff`). This is a construction-year PROXY
 *    only — NOT a confirmed BRF-pays-for-stambyte signal. The real signal
 *    requires per-candidate org.nr resolution + Allabrf document fetch +
 *    extraction (Phase 8's ENRICH-01 pipeline), which costs real SEK/latency
 *    per candidate and would blow the discovery job's `CAP_SEK_MAX` if run
 *    for every candidate in an area search (RESEARCH Open Question 1,
 *    resolved). That real signal is explicitly DEFERRED to a future opt-in
 *    "deep-analyze this candidate's BRF" action reusing the exact ENRICH-01
 *    pipeline — never folded into the base ranking pass.
 */
export type NicheId = "renovation-upside" | "turnkey" | "imminent-stambyte";

/** Ordered list of niche ids, for iteration and UI option ordering. */
export const NICHE_IDS: NicheId[] = [
  "renovation-upside",
  "turnkey",
  "imminent-stambyte",
];

export const NICHE_WEIGHTS = {
  "renovation-upside": {
    // Older construction year → more renovation headroom.
    constructionYearAge: {
      weight: 0.5,
      // A building built in or before this year scores the max age sub-score.
      oldBuildYearMax: 1975,
      // A building built in or after this year scores the min age sub-score
      // (newer buildings have little renovation upside).
      newBuildYearMin: 2015,
    },
    // Cheaper per-sqm vs the area baseline → more renovation upside (a
    // discount often reflects dated condition, which is the opportunity).
    pricePerSqmVsBaseline: {
      weight: 0.5,
      // At or below this ratio (candidate/baseline) scores the max sub-score.
      lowRatioMax: 0.85,
      // At or above this ratio scores the min sub-score (no discount, no
      // renovation-upside signal from price alone).
      highRatioMin: 1.1,
    },
  },
  turnkey: {
    // Newer construction year → more likely move-in-ready.
    constructionYearAge: {
      weight: 0.7,
      // A building built in or after this year scores the max age sub-score.
      newBuildYearMin: 2015,
      // A building built in or before this year scores the min age sub-score.
      oldBuildYearMax: 1975,
    },
    // Bostadsrätt (vs Äganderätt/other) as a light tie-breaker signal — the
    // majority of Swedish turnkey-condition flats in dense urban search areas
    // are BRF-held; this does NOT reward/punish price/sqm at all (a turnkey
    // buyer pays for move-in-ready, not a discount).
    tenureFormMatch: {
      weight: 0.3,
      preferredTenureForm: "Bostadsrätt",
    },
  },
  "imminent-stambyte": {
    // Hedged construction-year PROXY (see module doc above) — distinctly
    // keyed as "stambyteProxyAge" in niche-score.ts, NEVER
    // FLAG_IDS.STAMBYTE_PLANERAT. A building built at/before this cutoff
    // scores the max proxy sub-score (older stamrör are more likely near
    // end-of-life); this is a domain-convention proxy, not a confirmed
    // financial/legal claim (RESEARCH Assumption A2).
    stambyteProxyAge: {
      weight: 1,
      stambyteProxyYearCutoff: 1970,
      // A building built in or after this year scores the min proxy
      // sub-score (modern stamrör, proxy signal does not apply).
      modernBuildYearMin: 2000,
    },
  },
} as const;
