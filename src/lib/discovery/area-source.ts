/**
 * area-source.ts - where the stated living area (boarea) comes from, read from broker text
 * (Phase 14.6, FLAG-02, D-09).
 *
 * PURE, synchronous - no file system, network, clock, randomness or SDK. The text comes in, a source
 * label (and for a measured area a year and a yes/no for "a measuring firm") goes out. The run year is
 * passed in by the caller.
 *
 * WHAT IT READS: "Boarean är uppmätt 2019", "Areauppgift enligt föreningen", "enligt ekonomisk plan".
 * An area that rests on the association's figure, not on a measurement, can be a little smaller than
 * the flat really is in an older building; that is information for Daniel, never a number in the fit.
 *
 * PII RULE: the sentence is never returned or stored. Only an enum, a year and a boolean leave the
 * reader (the text may hold seller or firm names). The firm is a boolean; no firm name is kept
 * anywhere. {@link areaAuditLines} masks every capitalised word and is for terminal printing only.
 *
 * COST OF BEING WRONG: a missed phrase costs nothing; a false "uppmätt" hides the soft flag that the
 * area may be understated. The disclaimer "ej kontrollmätt" never overrides a stated source, a seller
 * or association source is never "uppmätt", and "mätning" alone is not a measurement.
 *
 * STRUCTURAL SEPARATION (LOCKED): like `ceiling-height.ts`, `taste.ts` and `sun-path.ts`, this module
 * sits beside the ranking path. `niche-score.ts` and `report/flags.ts` must NEVER import it; the
 * static-grep invariant in `niche-score.test.ts` enforces that and the "discovery/area-source" prefix
 * is registered there (in an earlier commit than this file). The kr upside ({@link areaUpsideSek}) is
 * a separate function and never reaches the fit score, the taste term, the flags or the model.
 */

/** Only this many leading characters of a text are read (ReDoS bound, T-14.6-71). */
export const AREA_TEXT_MAX_CHARS = 50_000;

/**
 * Where the area figure comes from, strongest first. `ej_kontrollmatt` is only the broker saying it
 * was not checked, with no other source named.
 */
export const AREA_SOURCES = [
  "uppmatt",
  "forening",
  "ekonomisk_plan",
  "lagenhetsregister",
  "saljare",
  "ej_kontrollmatt",
] as const;

export type AreaSource = (typeof AREA_SOURCES)[number];

/**
 * The three stored facts. All `null` = the text was not read or states nothing. `areaMeasuredYear`
 * and `areaMeasuredFirm` are set only when the source is "uppmatt" (the firm as a yes/no, never a name).
 */
export interface AreaFacts {
  readonly areaSource: AreaSource | null;
  readonly areaMeasuredYear: number | null;
  readonly areaMeasuredFirm: boolean | null;
}

const NONE: AreaFacts = { areaSource: null, areaMeasuredYear: null, areaMeasuredFirm: null };

const W = String.raw`(?<![\p{L}])`;
const E = String.raw`(?![\p{L}])`;

/** "Areauppgift enligt föreningen", "Boarean är hämtad från bostadsrättsföreningen". */
const FORENING = new RegExp(
  `${W}(?:areauppgift\\p{L}{0,12}|arean|boarean|boytan|uppgift\\p{L}{0,12}|ytan|måtten?)\\s{1,3}(?:\\p{L}{1,12}\\s{1,3}){0,3}?(?:enligt|från|hämtad\\s{1,3}från|hämtade\\s{1,3}från|lämnad\\s{1,3}av|av)\\s{1,3}(?:bostadsrätts)?förening\\p{L}{0,6}${E}`,
  "iu",
);

/** Cap, then drop soft hyphens and zero-width characters, turn no-break spaces into spaces. */
function prepare(text: string): string {
  return text
    .slice(0, AREA_TEXT_MAX_CHARS)
    .replace(/[­​-‍⁠﻿]/g, "")
    .replace(/[   ]/g, " ");
}

/** Clauses end at ! ? ; a newline, or a full stop that is not a decimal point. */
function clausesOf(prepared: string): string[] {
  return prepared.split(/[!?;\n]+|(?<!\d)\.|\.(?!\d)/);
}

/**
 * The area source stated in the text. `null` text (or an empty one) means "not read" and gives all
 * `null`; a text that was read and states nothing gives the same.
 */
export function areaFactsFromText(text: string | null, _opts: { readonly runYear: number }): AreaFacts {
  void _opts; // the run year is used once the measured-year rule lands
  if (typeof text !== "string" || text.trim() === "") return NONE;
  for (const clause of clausesOf(prepare(text))) {
    if (FORENING.test(clause)) return { areaSource: "forening", areaMeasuredYear: null, areaMeasuredFirm: null };
  }
  return NONE;
}
