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

// --- number, units and the three patterns --------------------------------------------------------
//
// All quantifiers are bounded and the text is capped before matching (T-14.5-02): no pattern
// repeats without a limit over the whole text. The letter look-arounds keep "takhöjdsskillnad"
// and street names from matching.

const KW = String.raw`(?<![\p{L}])(?:tak|rums)h[öo]jd(?:en)?(?![\p{L}])`;
const KW_BARE = String.raw`(?:tak|rums)h[öo]jd(?![\p{L}])`;
const FILL = String.raw`[\s:–\-(]{0,12}(?:(?:på|om|är|ca\.?|cirka|ungefär|upp\s{1,3}till|hela|runt)\s{0,3}){0,3}`;
const NUM = String.raw`(\d{1,3}(?:[.,]\d{1,2})?)`;
const UNIT_END = String.raw`(?![\p{L}\d²])`;

/** A: keyword first. "takhöjd 3,2 m", "takhöjd på ca 3 meter", "Takhöjd: 3.2m", "takhöjd 270 cm", "Rumshöjd 2,8 m". */
const PATTERN_A = new RegExp(KW + FILL + NUM + String.raw`(?!\d|[.,]\d)` + String.raw`(?:\s{0,3}(m(?:eter(?:s)?)?|cm)` + UNIT_END + ")?", "giu");
/** B: number and unit first. "3,5 meters takhöjd", "ca 3 m i takhöjd", "2,7 m takhöjd". */
const PATTERN_B = new RegExp(
  String.raw`(?<![\p{L}\d.,])` + NUM + String.raw`\s{0,3}(m(?:eter(?:s)?)?|cm)` + UNIT_END + String.raw`\s{0,3}(?:(?:i|med)\s{1,3})?` + KW_BARE,
  "giu",
);
/** C: a spelled-out number. "tre meter i takhöjd", "fyra meters takhöjd", "tre och en halv meter i takhöjd". */
const PATTERN_C = new RegExp(
  String.raw`(?<![\p{L}])(två|tre|fyra)(\s{1,3}och\s{1,3}en\s{1,3}halv)?\s{1,3}meter(?:s)?\s{1,3}(?:i\s{1,3})?` + KW_BARE,
  "giu",
);
const WORD_NUMBERS: Readonly<Record<string, number>> = { två: 2, tre: 3, fyra: 4 };

/** What may NOT follow a bare number (no unit): an area, a room count, more digits. */
const BARE_NOT_A_HEIGHT = /^\s{0,3}(?:m2|m²|kvm|rum(?![\p{L}])|st(?![\p{L}])|\d)/iu;
/** A bare whole number is a height only when the text ends or punctuation follows. */
const BARE_PUNCTUATION_ONLY = /^\s{0,3}(?:$|[.,;:!?)\]])/u;

/** A clause that is about another space: a height there is not the flat's ceiling. */
const OTHER_SPACE =
  /(?<![\p{L}])(?:källar\w*|förråd\w*|vind\w*|garage\w*|cykelrum\w*|trapphus\w*|souterräng\w*|loftsäng\w*|tvättstuga\w*|gemensam\w*|bergrum\w*|mellanplan\w*)(?![\p{L}])/iu;
/** "låg takhöjd", "lågt i tak", "låga tak": a low ceiling is never a number and never the tall flag. */
const LOW_CEILING = /(?<![\p{L}])(?:låga?\s{1,3}(?:tak|rums)h[öo]jd|lågt\s{1,3}i\s{1,3}tak|låga\s{1,3}tak)(?![\p{L}])/iu;
/** Tall-ceiling phrases that carry no number. A negation right before them rules them out. */
const TALL =
  /(?<!(?:ej|inte|ingen)\s{1,3})(?<![\p{L}])(?:högt\s{1,3}(?:i|till)\s{1,3}tak|höga\s{1,3}tak|hög\s{1,3}takh[öo]jd|generös\s{1,3}takh[öo]jd|extra\s{1,3}hög\s{1,3}takh[öo]jd)(?![\p{L}])/iu;

/** Cap, then drop soft hyphens and zero-width characters, turn no-break spaces into spaces, and unstop "ca.". */
function prepare(text: string): string {
  return text
    .slice(0, CEILING_TEXT_MAX_CHARS)
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .replace(/(?<![\p{L}])(ca)\.(?=\s)/giu, "$1");
}

/** Clauses end at ! ? ; a newline, or a full stop that is not a decimal point (landLeaseFromText splits the same way). */
function clausesOf(prepared: string): string[] {
  return prepared.split(/[!?;\n]+|(?<!\d)\.|\.(?!\d)/);
}

/** "3,2" and "3.2" are 3,2; no thousands separators exist in this range. */
function toNumber(raw: string): number {
  return Number(raw.replace(",", "."));
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Canonical phrase rebuilt from the number: decimal comma, at most two decimals, no trailing zeros. */
function canonicalPhrase(metres: number): string {
  return `takhöjd ${String(metres).replace(".", ",")} m`;
}

interface Hit {
  readonly index: number;
  readonly metres: number;
}

/** Every height candidate in one clause, from the three patterns, unsorted and not yet checked against the band. */
function hitsIn(clause: string): Hit[] {
  const hits: Hit[] = [];

  for (const match of clause.matchAll(PATTERN_A)) {
    const raw = match[1];
    const unit = match[2]?.toLowerCase();
    const number = toNumber(raw);
    let metres: number;
    if (unit === "cm") {
      metres = number / 100;
    } else if (unit) {
      metres = number;
    } else {
      const end = match.index + match[0].length;
      const rest = clause.slice(end, end + 12);
      if (BARE_NOT_A_HEIGHT.test(rest)) continue;
      if (/[.,]/.test(raw)) metres = number;
      else if (number >= 200 && number <= 500) metres = number / 100;
      else if (BARE_PUNCTUATION_ONLY.test(rest)) metres = number;
      else continue;
    }
    hits.push({ index: match.index, metres: round2(metres) });
  }

  for (const match of clause.matchAll(PATTERN_B)) {
    const number = toNumber(match[1]);
    hits.push({ index: match.index, metres: round2(match[2].toLowerCase() === "cm" ? number / 100 : number) });
  }

  for (const match of clause.matchAll(PATTERN_C)) {
    const base = WORD_NUMBERS[match[1].toLowerCase()];
    if (base === undefined) continue;
    hits.push({ index: match.index, metres: base + (match[2] ? 0.5 : 0) });
  }

  return hits;
}

interface CeilingReading {
  readonly height: { metres: number; phrase: string } | null;
  readonly tall: boolean;
}

/** One pass over the clauses: the first plausible height in text order, and whether a tall phrase was stated. */
function readCeiling(text: string): CeilingReading {
  let height: { metres: number; phrase: string } | null = null;
  let tall = false;
  for (const clause of clausesOf(prepare(text))) {
    if (OTHER_SPACE.test(clause) || LOW_CEILING.test(clause)) continue;
    if (!tall && TALL.test(clause)) tall = true;
    if (height) continue;
    const hit = hitsIn(clause)
      .sort((a, b) => a.index - b.index)
      .find((h) => h.metres >= CEILING_MIN_M && h.metres <= CEILING_MAX_M);
    if (hit) height = { metres: hit.metres, phrase: canonicalPhrase(hit.metres) };
  }
  return { height, tall };
}

/**
 * The stated ceiling height in the text, in metres, with the canonical phrase, or `null`.
 *
 * Accepts 2,2 to 5,0 m only. A bare number without a unit counts when it has decimals, when it is
 * a whole 200 to 500 (centimetres), or when nothing but punctuation follows it. The first plausible
 * match in text order wins (an implausible first match, such as "12 m", is skipped, not trusted). A
 * clause that names another space (källare, förråd, vind, garage ...) or a low ceiling gives nothing.
 * Only the first {@link CEILING_TEXT_MAX_CHARS} characters are read.
 */
export function ceilingHeightFromText(text: string | null): { metres: number; phrase: string } | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  return readCeiling(text).height;
}

/**
 * The three stored facts for one text. `null` text (or an empty one) means "not read" and gives
 * all three `null`; a text that was read and states nothing gives `{ null, null, false }`.
 * `tallCeilingPhrase` is true for "högt i tak" and its kin, with or without a number beside it, and
 * never turns into a number (D-05). The sentence itself is never returned.
 */
export function ceilingFactsFromText(text: string | null): CeilingFacts {
  if (typeof text !== "string" || text.trim() === "") {
    return { ceilingHeightM: null, ceilingSource: null, tallCeilingPhrase: null };
  }
  const { height, tall } = readCeiling(text);
  return {
    ceilingHeightM: height ? height.metres : null,
    ceilingSource: height ? "angiven" : null,
    tallCeilingPhrase: tall,
  };
}
