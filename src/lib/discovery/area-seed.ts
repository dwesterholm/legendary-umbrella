/**
 * area-seed.ts — a SMALL, explicitly-commented, human-verified v1-scoped
 * launch-region fallback for free-text area-name resolution (09-RESEARCH.md
 * Pitfall 3 / Open Question 1).
 *
 * This is a DELIBERATE v1 SCOPE REDUCTION, NOT a comprehensive `AREA_ID_MAP`.
 * 09-RESEARCH.md is explicit that a hardcoded comprehensive Swedish
 * place-name→areaId lookup table "will drift and cannot cover the input
 * space" and flags any such constant appearing in a diff as a warning sign.
 * This list exists ONLY to guarantee `resolveArea` never hard-blocks the
 * phase if the live Playwright search-box probe (`resolve-area.ts` +
 * `area-search-page-function.ts`) proves unreliable — it covers a handful of
 * Stockholm-region kommun/neighborhood names for the initial launch region
 * and nothing more. Broadening geographic coverage beyond this seed set is
 * explicitly a POST-LAUNCH improvement, gated on the live probe being
 * confirmed reliable (see 09-02-SUMMARY.md "Operator Next Steps").
 *
 * Every id below is a known, previously-observed Booli areaId — Södermalm's
 * 115341 is the same id `client.ts`'s own `resolveAreaId` doc comment cites
 * (breadcrumb-derived, 03-SPIKE.md §2), not a guess.
 */
export const AREA_SEED: Record<string, string> = {
  // Stockholm inner-city neighborhoods.
  södermalm: "115341",
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
