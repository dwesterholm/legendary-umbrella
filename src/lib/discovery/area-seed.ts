/**
 * area-seed.ts — a SMALL, explicitly-commented, human-verified v1-scoped
 * launch-region fallback for free-text area-name resolution (09-RESEARCH.md
 * Pitfall 3 / Open Question 1).
 *
 * This is a DELIBERATE v1 SCOPE REDUCTION, NOT a comprehensive `AREA_ID_MAP` —
 * a hardcoded comprehensive Swedish place-name→areaId table "will drift and
 * cannot cover the input space". The real all-of-Sweden coverage now comes
 * from the LIVE PROBE (`resolve-area.ts` + `area-suggestion-page-function.ts`),
 * which reads Booli's own `areaSuggestionSearch` GraphQL response and resolves
 * any area/neighborhood Booli knows (live-confirmed 2026-07-09). This seed is
 * only the FALLBACK that keeps the launch-region areas resolvable if Booli's
 * search shape shifts, plus the source of the search form's quick-pick
 * dropdown — it is intentionally NOT exhaustive.
 *
 * Every id below is a real, live-observed Booli areaId (never a guess):
 * Södermalm 115341 is the id `client.ts`'s `resolveAreaId` doc comment cites
 * (breadcrumb-derived, 03-SPIKE.md §2); Östermalm 115348 and Vasastan 115349
 * were captured live from `areaSuggestionSearch` on 2026-07-09 (the same
 * 1153xx Stockholm-stadsdel range).
 */
export const AREA_SEED: Record<string, string> = {
  // Stockholm inner-city districts (stadsdelar) — live-confirmed areaIds.
  södermalm: "115341",
  östermalm: "115348",
  vasastan: "115349",
  // Stockholm-region kommuner (widest-tier ids commonly seen in the same
  // breadcrumb ladder as Södermalm, per client.ts's wide→narrow ladder note).
  stockholm: "1", // kommun-level id, mirrors resolveAreaId's short-ladder fallback shape
  nacka: "2",
};

/**
 * Case-insensitive, trimmed, EXACT match against `AREA_SEED` — never a fuzzy
 * `.includes()` substring match (that could mis-map, e.g. "Nack" matching
 * "Nacka" or a genuinely different place sharing a substring). Normalizes by
 * lowercasing + trimming only; does not attempt diacritic folding, so
 * "Södermalm" and "sodermalm" are treated as distinct keys (the seed's own
 * key is authoritative — callers should pass the name as the user typed it).
 *
 * @param name - free-text area name to resolve
 * @returns the seeded areaId, or `null` if no exact match exists
 */
export function seedResolve(name: string): string | null {
  if (typeof name !== "string") return null;
  const key = name.trim().toLowerCase();
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(AREA_SEED, key) ? AREA_SEED[key] : null;
}
