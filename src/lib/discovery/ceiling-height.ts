/**
 * ceiling-height.ts - the STATED ceiling height of a listing, read from broker text
 * (Phase 14.5, CEIL-01, D-05).
 *
 * PURE, synchronous - no file system, network, clock, randomness or SDK. The text comes in,
 * a number (or nothing) goes out.
 *
 * WHAT IT READS (D-05): a height the broker WROTE, in metres ("takhöjd 3,2 m"). Nothing is
 * inferred, so the source is always "angiven". A phrase without a number ("högt i tak") is a
 * flag and never turns into a number.
 *
 * WHAT IT NEVER DOES (D-08): no picture-based height estimate exists anywhere in this phase.
 * Sold pages carry no broker text (R-03), so this is a for-sale-only fact and the hedonic model
 * never sees it.
 *
 * PII RULE: the sentence is never returned or stored. Only a number, the literal "angiven" and
 * a boolean leave this module (the text may hold seller names or phone numbers). The canonical
 * phrase returned beside the number is rebuilt from the number ("takhöjd 3,2 m"), not cut from
 * the text.
 *
 * COST OF BEING WRONG: a missed phrase costs nothing; a false hit adds up to 2 % of resale to the
 * taste term (plan 04). The accepted band is therefore narrow (2,2 to 5,0 m) and the phrase
 * lists stay conservative, the same stance as THROUGH_FLAT_RE in sun-path.ts.
 *
 * STRUCTURAL SEPARATION (LOCKED): like `taste.ts` and `sun-path.ts`, this module sits beside the
 * ranking path. `niche-score.ts` and `report/flags.ts` must NEVER import it; the static-grep
 * invariant in `niche-score.test.ts` enforces that and the "discovery/ceiling-" prefix is
 * registered there (in an earlier commit than this file).
 */

/** Lowest height read as a ceiling, in metres. Anything below is a typo or another space. */
export const CEILING_MIN_M = 2.2;
/** Highest height read as a ceiling, in metres. */
export const CEILING_MAX_M = 5.0;
/** Only this many leading characters of a text are read (ReDoS bound, T-14.5-02). */
export const CEILING_TEXT_MAX_CHARS = 50_000;

/**
 * The three stored facts. All `null` = the text was not read (no description). `tallCeilingPhrase`
 * `false` with no height = the text was read and states nothing about the ceiling.
 */
export interface CeilingFacts {
  readonly ceilingHeightM: number | null;
  readonly ceilingSource: "angiven" | null;
  readonly tallCeilingPhrase: boolean | null;
}

// --- pattern A: keyword first ("takhöjd 3,2 m", "takhöjd på ca 3 meter", "Takhöjd: 3.2m") ---------

const KW = String.raw`(?<![\p{L}])(?:tak|rums)h[öo]jd(?:en)?(?![\p{L}])`;
const FILL = String.raw`[\s:–\-(]{0,12}(?:(?:på|om|är|ca\.?|cirka|ungefär|upp\s{1,3}till|hela|runt)\s{0,3}){0,3}`;
const NUM = String.raw`(\d{1,3}(?:[.,]\d{1,2})?)(?!\d|[.,]\d)`;
const UNIT_A = String.raw`(?:\s{0,3}(m(?:eter(?:s)?)?|cm)(?![\p{L}\d²]))?`;
const PATTERN_A = new RegExp(KW + FILL + NUM + UNIT_A, "giu");

/** What may NOT follow a bare number (no unit): an area, a room count, more digits. */
const BARE_NOT_A_HEIGHT = /^\s{0,3}(?:m2|m²|kvm|rum(?![\p{L}])|st(?![\p{L}])|\d)/iu;
/** A bare whole number is a height only when the text ends or punctuation follows. */
const BARE_PUNCTUATION_ONLY = /^\s{0,3}(?:$|[.,;:!?)\]])/u;

/** Cap, then drop soft hyphens and zero-width characters and turn no-break spaces into spaces. */
function prepare(text: string): string {
  return text
    .slice(0, CEILING_TEXT_MAX_CHARS)
    .replace(/[­​-‍⁠﻿]/g, "")
    .replace(/[   ]/g, " ");
}

/** "3,2" and "3.2" are 3,2; no thousands separators exist in this range. */
function toNumber(raw: string): number {
  return Number(raw.replace(",", "."));
}

/** Canonical phrase rebuilt from the number: decimal comma, at most two decimals, no trailing zeros. */
function canonicalPhrase(metres: number): string {
  return `takhöjd ${String(metres).replace(".", ",")} m`;
}

/**
 * The stated ceiling height in the text, in metres, with the canonical phrase, or `null`.
 *
 * Accepts 2,2 to 5,0 m only. A bare number without a unit counts when it has decimals, when it is
 * a whole 200 to 500 (centimetres), or when nothing but punctuation follows it. The first match in
 * text order wins. Only the first {@link CEILING_TEXT_MAX_CHARS} characters are read.
 */
export function ceilingHeightFromText(text: string | null): { metres: number; phrase: string } | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  const prepared = prepare(text);

  for (const match of prepared.matchAll(PATTERN_A)) {
    const raw = match[1];
    const unit = match[2]?.toLowerCase();
    const number = toNumber(raw);
    let metres: number;
    if (unit === "cm") {
      metres = number / 100;
    } else if (unit) {
      metres = number;
    } else {
      const rest = prepared.slice(match.index + match[0].length, match.index + match[0].length + 12);
      if (BARE_NOT_A_HEIGHT.test(rest)) continue;
      const hasDecimals = /[.,]/.test(raw);
      if (hasDecimals) metres = number;
      else if (number >= 200 && number <= 500) metres = number / 100;
      else if (BARE_PUNCTUATION_ONLY.test(rest)) metres = number;
      else continue;
    }
    metres = Math.round(metres * 100) / 100;
    if (metres < CEILING_MIN_M || metres > CEILING_MAX_M) continue;
    return { metres, phrase: canonicalPhrase(metres) };
  }
  return null;
}

/**
 * The three stored facts for one text. `null` text (or an empty one) means "not read" and gives
 * all three `null`; a text that was read and states nothing gives `{ null, null, false }`. The
 * sentence itself is never returned.
 */
export function ceilingFactsFromText(text: string | null): CeilingFacts {
  if (typeof text !== "string" || text.trim() === "") {
    return { ceilingHeightM: null, ceilingSource: null, tallCeilingPhrase: null };
  }
  const found = ceilingHeightFromText(text);
  return {
    ceilingHeightM: found ? found.metres : null,
    ceilingSource: found ? "angiven" : null,
    tallCeilingPhrase: false,
  };
}
