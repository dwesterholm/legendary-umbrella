/**
 * stambyte-text.ts - what a broker WROTE about a stambyte (pipe replacement), read from the listing
 * text (Phase 14.6, STAM-03, D-07).
 *
 * PURE, synchronous - no file system, network, clock, randomness or SDK. The text comes in, a few
 * years and booleans go out. The run year is passed in by the caller (this module never reads a clock).
 *
 * WHAT IT READS: "Stambyte genomfört 2018", "stambyte planeras 2027", "stambyte pågår". Nothing is
 * inferred. Relining (pipes lined from the inside) is a different job from a stambyte and sets only
 * its own flag, never a year.
 *
 * PII RULE: the sentence is never returned or stored. Only years and booleans leave this module (the
 * text may hold seller names or phone numbers).
 *
 * COST OF BEING WRONG: a missed phrase costs nothing; a false hit tells Daniel a building has had its
 * pipes replaced when it has not, which is a reason to pay more. The rules therefore lean toward
 * saying nothing: a year in another clause ("badrum 2021") never becomes the stambyte year, a
 * negation discards the keyword it belongs to, and a decade ("på 1980-talet") is not a year.
 *
 * STRUCTURAL SEPARATION (LOCKED): like `ceiling-height.ts`, `taste.ts` and `sun-path.ts`, this module
 * sits beside the ranking path. `niche-score.ts` and `report/flags.ts` must NEVER import it; the
 * static-grep invariant in `niche-score.test.ts` enforces that and the "discovery/stambyte-" prefix is
 * registered there (in an earlier commit than this file).
 */

/** Only this many leading characters of a text are read (ReDoS bound, T-14.6-71). */
export const STAMBYTE_TEXT_MAX_CHARS = 50_000;

/**
 * What one text says about stambyte. All `null` = the text was not read (no description).
 * `ongoing: false` and `relining: false` with no years = the text was read and states nothing.
 */
export interface StambyteTextFacts {
  /** The latest completed stambyte year the text states (up to the run year). */
  readonly lastYear: number | null;
  /** The earliest planned stambyte year the text states (the run year or later). */
  readonly plannedYear: number | null;
  /** A stambyte is under way now. */
  readonly ongoing: boolean | null;
  /** Relining is mentioned. It is never a stambyte and never gives a year. */
  readonly relining: boolean | null;
}

const NOT_READ: StambyteTextFacts = { lastYear: null, plannedYear: null, ongoing: null, relining: null };

// --- patterns -------------------------------------------------------------------------------------
//
// All quantifiers are bounded and the text is capped before matching (T-14.6-71).

const W = String.raw`(?<![\p{L}])`;
const E = String.raw`(?![\p{L}])`;

/** "stambyte", "stambytet", "VA-stambyte", "stambytt", "stamrenovering". */
const KEYWORD = new RegExp(
  `${W}(?:va-?)?(?:stambyt(?:e|et|en|ena)?|stambytt\\p{L}{0,2}|stambyta|stamrenover\\p{L}{1,8})${E}`,
  "giu",
);

/** A year from 1950 to 2045; not a decade ("1980-talet"), not part of a longer number. */
const YEAR = /(?<![\d.,-])((?:19[5-9]\d|20[0-4]\d))(?!\d|-?tal)/gu;

/** Cap, then drop soft hyphens and zero-width characters, turn no-break spaces into spaces. */
function prepare(text: string): string {
  return text
    .slice(0, STAMBYTE_TEXT_MAX_CHARS)
    .replace(/[­​-‍⁠﻿]/g, "")
    .replace(/[   ]/g, " ");
}

/** Clauses end at ! ? ; a newline, or a full stop that is not a decimal point. */
function clausesOf(prepared: string): string[] {
  return prepared.split(/[!?;\n]+|(?<!\d)\.|\.(?!\d)/);
}

/**
 * The stambyte statements in the text, or all `null` when there is no text to read.
 *
 * `runYear` splits past from future: a year above it is planned, a year up to it is completed.
 */
export function stambyteFromText(text: string | null, opts: { readonly runYear: number }): StambyteTextFacts {
  if (typeof text !== "string" || text.trim() === "") return NOT_READ;

  let lastYear: number | null = null;
  let plannedYear: number | null = null;
  for (const clause of clausesOf(prepare(text))) {
    for (const keyword of clause.matchAll(KEYWORD)) {
      const end = keyword.index + keyword[0].length;
      const after = clause.slice(end, end + 40).matchAll(YEAR);
      const first = after.next();
      if (first.done) continue;
      const year = Number(first.value[1]);
      if (year > opts.runYear) plannedYear = plannedYear === null ? year : Math.min(plannedYear, year);
      else lastYear = lastYear === null ? year : Math.max(lastYear, year);
    }
  }
  return { lastYear, plannedYear, ongoing: false, relining: false };
}
