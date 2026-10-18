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
 * HOW A CLAUSE IS READ (per clause, in this order): a clause about a balcony, terrace, storage, plot,
 * attic, cellar or garage is skipped unless it also names boarea / boyta / bostadsyta / lägenhetsyta; a
 * negation ("ej uppmätt") is noted but does not stop a stated source in the same clause; one source phrase
 * is picked (säljare, lägenhetsregister, ekonomisk plan, förening, in that order); a "measured" phrase
 * counts only when it is not negated, no seller claims it, and an area or flat word sits within 60
 * characters before / 20 after it (or a certificate word such as "mätintyg" or a measuring-firm word is in
 * the clause). Across clauses: uppmatt > forening > ekonomisk_plan > lagenhetsregister > saljare, and
 * ej_kontrollmatt only when nothing else was found.
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

// --- patterns -------------------------------------------------------------------------------------
//
// All quantifiers are bounded and the text is capped before matching (T-14.6-71). The letter
// look-arounds keep "areamätning" from matching inside a longer word and street names out.

/** "ej uppmätt", "inte mätts", "saknar mätintyg": the broker says the area was NOT measured. */
const NEG = new RegExp(
  [
    String.raw`${W}(?:ej|inte|icke|ingen|saknar|utan)\s{1,3}(?:\p{L}{1,15}\s{1,3}){0,2}?(?:upp|om|kontroll)?mät(?:t|ts|ta|ning\p{L}{0,6}|intyg|bevis)${E}`,
    String.raw`${W}(?:har|är)\s{1,3}(?:ej|inte)\s{1,3}(?:\p{L}{1,15}\s{1,3}){0,2}?mätts${E}`,
  ].join("|"),
  "iu",
);

/** A measurement phrase that needs an area or flat word nearby, or a firm word in the clause. */
const MEASURED_WEAK = new RegExp(
  [
    String.raw`${W}(?:upp|om|kontroll|laser|egen)mät(?:t|ts|ta)${E}`,
    String.raw`${W}mätt(?:es|s)?\s{1,3}upp${E}`,
    String.raw`${W}(?:area)?mätning(?:en)?\s{1,3}(?:utförd|gjord|genomförd|utfördes|gjordes|genomfördes)${E}`,
  ].join("|"),
  "giu",
);
/** A certificate word: it is about the flat's area by itself ("mätintyg", "SS 21054"). */
const MEASURED_STRONG = new RegExp(
  [String.raw`${W}(?:mätintyg|mätbevis|mätrapport\p{L}{0,3}|areamätning\p{L}{0,3})${E}`, String.raw`${W}ss\s{0,2}21054${E}`].join("|"),
  "giu",
);
/** A measuring firm or a firm-type word. Matched only to set a boolean; no firm name is kept. */
const FIRM = new RegExp(
  String.raw`${W}(?:med\s{1,3}laser|svensk\s{1,3}areamätning|areamätning\s{1,3}sverige|enspecta|mätcentralen|areabolaget|laser(?:mätt|uppmätt|mätning)\p{L}{0,6}|certifierad\s{1,3}(?:area)?mätare|auktoriserad\s{1,3}mätare|mätfirma\p{L}{0,4}|mätföretag\p{L}{0,4}|mätkonsult\p{L}{0,4}|areamätare\p{L}{0,4})${E}`,
  "iu",
);

/** Words that say a number is the flat's area. */
const AREA_WORD = new RegExp(
  String.raw`${W}(?:area\p{L}{0,2}|boarea\p{L}{0,2}|boyta\p{L}{0,2}|bostadsyta\p{L}{0,2}|lägenhetsyta\p{L}{0,2}|ytan?|boa|kvm|kvadratmeter|m2|m²)${E}`,
  "iu",
);
/** Words that say the flat itself is meant. */
const FLAT_WORD = new RegExp(
  String.raw`${W}(?:lägenhet\p{L}{0,4}|bostadsrätt\p{L}{0,4}|bostaden|ettan|tvåan|trean|fyran|etta|tvåa|trea|fyra)${E}`,
  "iu",
);
/** A clause about another space: an area there is not the flat's. */
const OTHER_SPACE = new RegExp(
  String.raw`${W}(?:balkong\p{L}{0,4}|terrass\p{L}{0,3}|uteplats\p{L}{0,3}|förråd\p{L}{0,3}|tomt\p{L}{0,3}|trädgård\p{L}{0,3}|vind\p{L}{0,3}|källar\p{L}{0,3}|garage\p{L}{0,3})${E}`,
  "iu",
);
/** ... unless the clause also names the flat's own area. */
const OWN_AREA = new RegExp(String.raw`${W}(?:boarea|boyta|bostadsyta|lägenhetsyta)\p{L}{0,3}${E}`, "iu");

/** The year pattern of the research draft; a value above the run year is dropped by the caller. */
const YEAR = /(?<![\d.,-])((?:198\d|199\d|20[0-4]\d))(?!\d)/gu;

/**
 * The stated sources that are not a measurement, in the order a single clause is tried. Each pattern
 * is matched against one clause; the canonical name is returned, never the sentence (sun-path.ts style).
 */
const SOURCE_PHRASES: ReadonlyArray<{
  readonly source: "saljare" | "lagenhetsregister" | "ekonomisk_plan" | "forening";
  readonly pattern: RegExp;
}> = [
  {
    source: "saljare",
    pattern: new RegExp(
      [
        String.raw`${W}(?:uppgift\p{L}{0,8}|areauppgift\p{L}{0,8}|uppgiven|uppgivna|uppgett)\s{1,3}(?:\p{L}{1,12}\s{1,3}){0,2}?(?:från|av|enligt)\s{1,3}(?:säljar|ägar)\p{L}{0,6}${E}`,
        String.raw`${W}enligt\s{1,3}(?:säljar|ägar)\p{L}{0,6}${E}`,
        String.raw`${W}säljaren\s{1,3}har\s{1,3}(?:uppgett|angett|mätt)${E}`,
        String.raw`${W}(?:upp|om)?mätt\s{1,3}av\s{1,3}(?:säljar|ägar)\p{L}{0,6}${E}`,
      ].join("|"),
      "iu",
    ),
  },
  {
    source: "lagenhetsregister",
    pattern: new RegExp(
      String.raw`${W}(?:enligt|ur|från|i)\s{1,3}(?:föreningens\s{1,3})?(?:lägenhetsregist\p{L}{2,5}|lägenhetsförteckning\p{L}{0,3})${E}`,
      "iu",
    ),
  },
  {
    source: "ekonomisk_plan",
    pattern: new RegExp(
      String.raw`${W}(?:enligt|ur|från|i)\s{1,3}(?:föreningens\s{1,3})?ekonomisk\p{L}{0,3}\s{1,3}plan\p{L}{0,3}${E}`,
      "iu",
    ),
  },
  {
    source: "forening",
    pattern: new RegExp(
      [
        String.raw`${W}(?:areauppgift\p{L}{0,12}|arean|boarean|boytan|uppgift\p{L}{0,12}|ytan|måtten?)\s{1,3}(?:\p{L}{1,12}\s{1,3}){0,3}?(?:enligt|från|hämtad\s{1,3}från|hämtade\s{1,3}från|lämnad\s{1,3}av|av)\s{1,3}(?:bostadsrätts)?förening\p{L}{0,6}${E}`,
        String.raw`${W}enligt\s{1,3}(?:bostadsrätts)?förening\p{L}{0,6}\s{1,3}(?:uppgift\p{L}{0,8}|area\p{L}{0,8}|lägenhetsförteckning\p{L}{0,8})${E}`,
      ].join("|"),
      "iu",
    ),
  },
];

/** The sources strongest first, for choosing across clauses. */
const CROSS_CLAUSE_ORDER = ["forening", "ekonomisk_plan", "lagenhetsregister", "saljare"] as const;

/** Reach, in characters, of the area or flat word around a measurement phrase. */
const CONTEXT_BEFORE = 60;
const CONTEXT_AFTER = 20;

/** Cap, then drop soft hyphens and zero-width characters, turn no-break spaces into spaces. */
function prepare(text: string): string {
  return text
    .slice(0, AREA_TEXT_MAX_CHARS)
    .replace(/[­​-‍⁠﻿]/g, "")
    .replace(/[   ]/g, " ");
}

/** Clauses end at ! ? ; a newline, or a full stop that is not a decimal point (landLeaseFromText splits the same way). */
function clausesOf(prepared: string): string[] {
  return prepared.split(/[!?;\n]+|(?<!\d)\.|\.(?!\d)/);
}

interface ClauseReading {
  /** The non-measurement source phrase of the clause, if any. */
  readonly source: (typeof CROSS_CLAUSE_ORDER)[number] | null;
  /** A usable negation ("ej uppmätt") with the area in view. */
  readonly negated: boolean;
  /** A measurement the clause really states. */
  readonly measured: boolean;
  readonly firm: boolean;
  readonly year: number | null;
}

function hasAreaContext(clause: string, start: number, end: number): boolean {
  const around = `${clause.slice(Math.max(0, start - CONTEXT_BEFORE), start)}|${clause.slice(end, end + CONTEXT_AFTER)}`;
  return AREA_WORD.test(around) || FLAT_WORD.test(around);
}

function wordCount(clause: string): number {
  return (clause.match(/\p{L}+/gu) ?? []).length;
}

/** The year nearest a match inside its clause (after it first), or null; years above `runYear` do not count. */
function yearNear(clause: string, at: number, runYear: number): number | null {
  let best: { value: number; gap: number } | null = null;
  for (const match of clause.matchAll(YEAR)) {
    const value = Number(match[1]);
    if (value > runYear) continue;
    const gap = match.index >= at ? match.index - at : (at - match.index) * 2;
    if (!best || gap < best.gap) best = { value, gap };
  }
  return best ? best.value : null;
}

function readClause(clause: string, runYear: number): ClauseReading | null {
  if (OTHER_SPACE.test(clause) && !OWN_AREA.test(clause)) return null;

  let source: ClauseReading["source"] = null;
  let sellerNamed = false;
  for (const phrase of SOURCE_PHRASES) {
    if (!phrase.pattern.test(clause)) continue;
    if (phrase.source === "saljare") sellerNamed = true;
    source = phrase.source;
    break;
  }

  const firm = FIRM.test(clause);
  const negated = NEG.test(clause);
  // A negation counts as "the broker says it was not measured" only with the area in view (or a clause
  // that is nothing but the negation), so "Takhöjd ej uppmätt" is not about the area.
  const negationAboutArea = negated && (AREA_WORD.test(clause) || FLAT_WORD.test(clause) || wordCount(clause) <= 2);

  let measured = false;
  let year: number | null = null;
  if (!negated && !(sellerNamed && !firm)) {
    for (const re of [MEASURED_STRONG, MEASURED_WEAK]) {
      for (const match of clause.matchAll(re)) {
        const end = match.index + match[0].length;
        if (re === MEASURED_WEAK && !firm && !hasAreaContext(clause, match.index, end)) continue;
        measured = true;
        year = yearNear(clause, match.index, runYear);
        break;
      }
      if (measured) break;
    }
  }
  return { source, negated: negationAboutArea, measured, firm: measured && firm, year };
}

/**
 * The area source stated in the text. `null` text (or an empty one) means "not read" and gives all
 * `null`; a text that was read and states nothing gives the same.
 *
 * `uppmatt` carries the measured year (when one is stated and not above the run year) and whether a
 * measuring firm is named (true/false, never the name). Every other source leaves both `null`.
 */
export function areaFactsFromText(text: string | null, opts: { readonly runYear: number }): AreaFacts {
  if (typeof text !== "string" || text.trim() === "") return NONE;

  const sources = new Set<string>();
  let negated = false;
  let measured = false;
  let firm = false;
  let year: number | null = null;
  for (const clause of clausesOf(prepare(text))) {
    const reading = readClause(clause, opts.runYear);
    if (!reading) continue;
    if (reading.source) sources.add(reading.source);
    if (reading.negated) negated = true;
    if (reading.measured) {
      measured = true;
      if (reading.firm) firm = true;
      if (year === null) year = reading.year;
    }
  }

  if (measured) return { areaSource: "uppmatt", areaMeasuredYear: year, areaMeasuredFirm: firm };
  for (const source of CROSS_CLAUSE_ORDER) {
    if (sources.has(source)) return { areaSource: source, areaMeasuredYear: null, areaMeasuredFirm: null };
  }
  if (negated) return { areaSource: "ej_kontrollmatt", areaMeasuredYear: null, areaMeasuredFirm: null };
  return NONE;
}

// --- the live audit: clauses with every name masked ---------------------------------------------

/** Clauses worth showing when auditing the parser against real texts. */
const AUDIT_KEYWORD = /uppmät|mätning|areauppgift|boarea.{0,60}enligt|ekonomisk plan|lägenhetsregist|säljare/iu;
/** Capitalised words that are plain vocabulary and may stay readable in the audit print (prefix-matched). */
const AUDIT_ALLOWED = /^(?:Boarea|Arean|Areauppgift|Lägenheten|Mätningen|Uppmätt|Enligt|BOA|SS)\p{L}{0,4}$/u;
export const AUDIT_LINE_MAX_CHARS = 160;

/**
 * For the terminal only (never stored, never returned by a reader): the clauses of a text that mention an
 * area keyword, each at most 160 characters, with every capitalised word outside a short allowlist
 * replaced by "▒" (seller, broker and firm names), plus e-mail addresses and long digit runs (phone
 * numbers). "Boarean är uppmätt av Svensk Areamätning 2019." becomes "Boarean är uppmätt av ▒ ▒ 2019.".
 * The caller prints these beside the parsed fields to judge the parser; the masking is the PII guard.
 */
export function areaAuditLines(text: string | null): string[] {
  if (typeof text !== "string" || text.trim() === "") return [];
  const lines: string[] = [];
  // Split after the delimiters (keeping them), at the same boundaries as clausesOf.
  for (const piece of prepare(text).split(/(?<=[!?;\n])|(?<=(?<!\d)\.)|(?<=\.(?!\d))/)) {
    const clause = piece.trim();
    if (clause === "" || !AUDIT_KEYWORD.test(clause)) continue;
    const masked = clause
      .replace(/\S{1,64}@\S{1,64}/g, "▒")
      .replace(/\+?\d[\d\s-]{6,20}\d/g, "▒")
      .replace(/\p{Lu}\p{L}*/gu, (word) => (AUDIT_ALLOWED.test(word) ? word : "▒"));
    lines.push(masked.slice(0, AUDIT_LINE_MAX_CHARS));
  }
  return lines;
}

// --- the kr upside, kept apart from the score ---------------------------------------------------

/** Buildings from before this year were measured to older figures; later ones follow the 1987 standard. */
export const AREA_UPSIDE_BEFORE_YEAR = 1987;

/**
 * What one or two extra square metres would be worth at the flat's own price per square metre, in kr.
 * An ASSUMPTION shown beside the asking price (labelled "antagande"); it is never an input to the fit
 * score, the taste term, the flags or the model.
 *
 * Only for a figure that is not a measurement (förening, ekonomisk plan, lägenhetsregister, säljare, or
 * "ej kontrollmätt") in a building from before 1987. `lowSek` is one square metre and `highSek` two,
 * each rounded once from the exact price per square metre (3 695 000 kr / 35 kvm gives 105 571 and 211 143).
 */
export function areaUpsideSek(input: {
  readonly areaSource: AreaSource | null;
  readonly constructionYear: number | null;
  readonly askingSek: number | null;
  readonly livingArea: number | null;
}): { readonly lowSek: number; readonly highSek: number } | null {
  const { areaSource, constructionYear, askingSek, livingArea } = input;
  if (areaSource === null || areaSource === "uppmatt") return null;
  if (constructionYear === null || !Number.isFinite(constructionYear) || constructionYear >= AREA_UPSIDE_BEFORE_YEAR) return null;
  if (askingSek === null || livingArea === null) return null;
  if (!Number.isFinite(askingSek) || !Number.isFinite(livingArea) || askingSek <= 0 || livingArea <= 0) return null;
  const perSqm = askingSek / livingArea;
  return { lowSek: Math.round(perSqm), highSek: Math.round(perSqm * 2) };
}
