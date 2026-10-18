/**
 * beteckning-text.ts - the pure text rules for finding a fastighetsbeteckning (Phase 14.6, CASE-01, D-02, R-06).
 *
 * PURE: no imports, no network, no file access. Later the analysis path (watch-enrich) imports this file to read a
 * beteckning out of a broker text or a BRF name, so nothing here may pull in the city client or the cache.
 *
 * Two free rungs live here:
 *  - rung (a): a broker text that states "Fastighetsbeteckning: Stockholm Oljan 29".
 *  - rung (a2): a BRF name such as "BRF Oljan 18" read as the guess "Oljan 18". A guess is only a guess: the caller
 *    trusts it after the city confirms a case row with the candidate's own street and number.
 *
 * Every regex is bounded (small `{n,m}` quantifiers, a cut input) so a 50 000 character broker text cannot hang it.
 */

/** A text longer than this is cut before it is searched (a listing text is a few thousand characters). */
const TEXT_MAX_CHARS = 200_000;
/** At most this many "fastighetsbeteckning" words of one text are tried. */
const KEYWORD_MAX_TRIES = 20;
/** How far after the keyword the designation is looked for. */
const WINDOW_CHARS = 90;
/** A BRF name longer than this is never a "BRF <kvarter> <nr>" name. */
const BRF_NAME_MAX_CHARS = 120;

/** "Stockholm Oljan 29" gives "Oljan 29"; spaces are collapsed. The city writes the designation without the kommun. */
export function normaliseBeteckning(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^stockholm\s+/i, "")
    .trim();
}

/** A designation looks like "<kvarter words> <number>" with an optional ":<number>" (trakt:block-unit). */
const BETECKNING_SHAPE = /^\p{L}[\p{L} ]{1,60} \d{1,4}(?::\d{1,4})?$/u;

const KEYWORD = /(?<![\p{L}])fastighets?beteckning(?![\p{L}])/giu;

/**
 * What follows the keyword. Case-sensitive on purpose: the research draft used the `i` flag on the whole pattern,
 * which lets "Fastighetsbeteckning är Oljan 29" capture "är Oljan 29". Here only the keyword ignores case, and the
 * first word of the designation must start with a capital letter.
 */
const AFTER_KEYWORD =
  /^\s{0,3}[:\-–]?\s{0,3}(?:[Ss]tockholm\s{1,3})?([A-ZÅÄÖ][\p{L}]{1,24}(?:\s[A-ZÅÄÖ]?[\p{L}]{1,24}){0,2}\s\d{1,4}(?::\d{1,4})?)(?![\p{L}\d])/u;

/**
 * Rung (a): the designation a broker text states, or null. Only the matched designation is returned, never the
 * sentence around it. "Fastighetsbeteckning: Stockholm Oljan 29. Avgift ..." gives "Oljan 29".
 */
export function beteckningFromText(text: string | null | undefined): string | null {
  if (text === null || text === undefined || text === "") return null;
  const haystack = text.length > TEXT_MAX_CHARS ? text.slice(0, TEXT_MAX_CHARS) : text;
  let tries = 0;
  for (const keyword of haystack.matchAll(KEYWORD)) {
    tries += 1;
    if (tries > KEYWORD_MAX_TRIES) break;
    const start = (keyword.index ?? 0) + keyword[0].length;
    const found = AFTER_KEYWORD.exec(haystack.slice(start, start + WINDOW_CHARS));
    if (found === null) continue;
    const beteckning = normaliseBeteckning(found[1]);
    if (BETECKNING_SHAPE.test(beteckning)) return beteckning;
  }
  return null;
}

const BRF_NAME =
  /^(?:hsb\s+)?(?:brf|bostadsrättsföreningen)\s+([A-ZÅÄÖ][\p{L} ]{2,30}?)\s+(\d{1,3})$/iu;

/**
 * Rung (a2): the designation a BRF name suggests. "BRF Skalmejblåsaren 12" gives "Skalmejblåsaren 12"; the kvarter
 * word keeps the capitalisation it had. A name without a trailing number ("HSB BRF Fredhäll i Stockholm") gives null.
 * The result is a guess and must be confirmed against the city's own rows before it is used.
 */
export function beteckningGuessFromBrfName(brfName: string | null | undefined): string | null {
  if (brfName === null || brfName === undefined) return null;
  const name = brfName.replace(/\s+/g, " ").trim();
  if (name === "" || name.length > BRF_NAME_MAX_CHARS) return null;
  const found = BRF_NAME.exec(name);
  if (found === null) return null;
  return `${found[1].replace(/\s+/g, " ").trim()} ${found[2]}`;
}
