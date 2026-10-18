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
 * HOW A YEAR IS CHOSEN (per keyword, inside one clause): the nearest year AFTER the keyword (within 40
 * characters) wins; only when there is none, the nearest year BEFORE it (within 25). A year is refused
 * when a comma, another keyword or another renovation topic ("kök", "badrum") sits between it and the
 * keyword, so "Köket renoverades 2021 och stambyte genomfördes 2018" gives 2018. A year above the run
 * year, or a plan word near the keyword, makes the stambyte planned; an "ongoing" word makes it
 * ongoing and ignores the years. A negation that belongs to the keyword discards it.
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
// All quantifiers are bounded and the text is capped before matching (T-14.6-71): no pattern repeats
// without a limit over the whole text. The letter look-arounds keep "stambytesplan" and street names
// from matching.

const W = String.raw`(?<![\p{L}])`;
const E = String.raw`(?![\p{L}])`;

/** The pipes themselves: "stambyte", "stambytet", "VA-stambyte", "stambyttes", "stamrenovering"; "byte av stammar", "stammarna byttes". */
const KEYWORD = new RegExp(
  [
    `${W}(?:va-?)?(?:stambyt(?:e|et|en|ena)?|stambytt\\p{L}{0,2}|stambyta|stamrenover\\p{L}{1,8}|stambytes(?:projekt|beslut|arbet)\\p{L}{0,4})${E}`,
    `${W}(?:stammarna|stammar|(?:avlopps|vatten)stammar\\p{L}{0,3})\\s{1,3}(?:\\p{L}{1,12}\\s{1,3}){0,2}?(?:byt(?:ts|tes|s|es)|bytta|utbyt\\p{L}{0,4}|renoverad\\p{L}{0,3}|renoverades|förnyad\\p{L}{0,3}|förnyades)${E}`,
    `${W}(?:byt(?:te|tes)|utbyt(?:te|tes)|renoverades|förnyades|(?:ut)?byte\\s{1,3}av)\\s{1,3}(?:(?:alla|samtliga|hela|husets|föreningens|fastighetens)\\s{1,3}){0,2}(?:(?:avlopps|vatten)?stammar(?:na)?)${E}`,
  ].join("|"),
  "giu",
);

/** A year from 1950 to 2045. Not a decade ("1980-talet"), not part of a longer number, not the second half of "a-b" or "1,2018". */
const YEAR = /(?<![\d.,-])((?:19[5-9]\d|20[0-3]\d|204[0-5]))(?!\d|-?tal)/gu;
/** "2011-2012", "2019–2020": the end of a range right after a year. */
const BETWEEN_RANGE_END = /^\s{1,3}och\s{1,3}((?:19[5-9]\d|20[0-3]\d|204[0-5]))(?!\d|-?tal)/u;
const RANGE_END = /^\s{0,2}[-–—]\s{0,2}((?:19[5-9]\d|20[0-3]\d|204[0-5]))(?!\d|-?tal)/u;

/** Words that say the stambyte lies ahead. "planer..." does not match inside "underhållsplanen". */
const PLAN = new RegExp(
  `${W}(?:planer\\p{L}{0,8}|planlagd\\p{L}{0,3}|beslut(?:ad|at)\\p{L}{0,3}|kommande|förestående|projekter\\p{L}{0,8}|genomförs|utförs|påbörjas|startas|startar|ska\\s{1,3}(?:genomföras|göras|utföras|påbörjas|startas)|kommer\\s{1,3}att|beräknas|beräknad\\p{L}{0,3}|väntas)${E}`,
  "giu",
);

/** Words that say the stambyte is under way now. ("pågick" is past tense and is NOT here.) */
const ONGOING = new RegExp(
  `${W}(?:pågår|pågående|påbörjad\\p{L}{0,3}|påbörjat|i\\s{1,3}full\\s{1,3}gång|just\\s{1,3}nu)${E}`,
  "giu",
);

/** A negation. Whether it belongs to a keyword is decided by distance (see {@link negatedKeywords}). */
const NEGATION = new RegExp(`${W}(?:inget|ingen|inga|ej|inte|icke|aldrig|saknar|saknas|utan)${E}`, "giu");

/** "istället för stambyte": the job was done another way, so no stambyte. Counts only BEFORE the keyword ("stambyte istället för relining" means the stambyte happened). */
const SUBSTITUTE = new RegExp(`${W}i\\s{0,2}stället\\s{1,3}för${E}`, "giu");

/** Relining and its kin: a different job from a stambyte. */
const RELINING = new RegExp(`${W}(?:relin\\p{L}{1,8}|rör(?:renover|lin)\\p{L}{3,8})${E}`, "iu");
/** "stambyte genom relining": the stambyte IS a relining, so its year is not a stambyte year. */
const RELINING_AS_STAMBYTE = new RegExp(`${W}(?:genom|via|med|som|i\\s{1,3}form\\s{1,3}av)\\s{1,3}(?:en\\s{1,3}|ett\\s{1,3})?relin`, "iu");

/** Other jobs a year may belong to. A year behind one of these (not joined by "och") is not the stambyte year. */
const TOPIC = new RegExp(
  `${W}(?:kök\\p{L}{0,3}|badrum\\p{L}{0,12}|golv\\p{L}{0,3}|fönster|tak(?:et)?|fasad\\p{L}{0,4}|hiss\\p{L}{0,3}|balkong\\p{L}{0,4}|el(?:en|installation\\p{L}{0,3})?|ventilation\\p{L}{0,3}|värme\\p{L}{0,6}|fiber|bredband|tvättstuga\\p{L}{0,2}|målning\\p{L}{0,2}|måla\\p{L}{0,3}|renover\\p{L}{0,8}|dörr\\p{L}{0,3}|ombyggn\\p{L}{0,6}|tillbyggn\\p{L}{0,6}|installation\\p{L}{0,3})${E}`,
  "iu",
);
const KEYWORD_ONCE = new RegExp(KEYWORD.source, "iu");
const CONJUNCTION = new RegExp(`${W}(?:och|samt|men|plus)${E}|&`, "iu");
const JOINED_TOPIC = /^\s{0,3}(?:och|samt|&)\s{1,3}$/iu;

/** Reach, in characters, between a keyword and what belongs to it. */
const YEAR_AFTER_REACH = 40;
const YEAR_BEFORE_REACH = 25;
const WORD_BEFORE_REACH = 40;
const WORD_AFTER_REACH = 60;
const NEGATION_BEFORE_REACH = 25;
const NEGATION_AFTER_REACH = 30;

/** Safety limits per text, far above any real listing (T-14.6-71). */
const MAX_KEYWORDS = 100;
const MAX_MODIFIERS = 500;

interface Span {
  readonly start: number;
  readonly end: number;
}
interface YearHit extends Span {
  readonly value: number;
}

/** Cap, then drop soft hyphens and zero-width characters, turn no-break spaces into spaces. */
function prepare(text: string): string {
  return text
    .slice(0, STAMBYTE_TEXT_MAX_CHARS)
    .replace(/[­​-‍⁠﻿]/g, "")
    .replace(/[   ]/g, " ");
}

/** Clauses end at ! ? ; a newline, or a full stop that is not a decimal point (landLeaseFromText splits the same way). */
function clausesOf(prepared: string): string[] {
  return prepared.split(/[!?;\n]+|(?<!\d)\.|\.(?!\d)/);
}

/** Spans of every match of a global pattern, at most `limit`. */
function spansOf(pattern: RegExp, clause: string, limit: number): Span[] {
  const spans: Span[] = [];
  for (const match of clause.matchAll(pattern)) {
    spans.push({ start: match.index, end: match.index + match[0].length });
    if (spans.length >= limit) break;
  }
  return spans;
}

function yearsOf(clause: string): YearHit[] {
  const hits: YearHit[] = [];
  for (const match of clause.matchAll(YEAR)) {
    hits.push({ start: match.index, end: match.index + 4, value: Number(match[1]) });
    if (hits.length >= MAX_MODIFIERS) break;
  }
  return hits;
}

/**
 * The keyword a plan or "ongoing" word belongs to: the nearest within reach, a tie going to the later one.
 * A comma between the word and the keyword cuts the tie ("Stambyte genomfört 2018, ingen avgiftshöjning
 * planerad" is not a planned stambyte). -1 = none.
 */
function nearestKeyword(
  clause: string,
  word: Span,
  keywords: readonly Span[],
  reachBefore: number,
  reachAfter: number,
): number {
  let best = -1;
  let bestGap = Number.POSITIVE_INFINITY;
  for (let i = 0; i < keywords.length; i++) {
    const k = keywords[i];
    const before = word.end <= k.start;
    if (!before && word.start < k.end) continue; // overlaps the keyword itself
    const gap = before ? k.start - word.end : word.start - k.end;
    if (gap > (before ? reachBefore : reachAfter)) continue;
    if (/,/.test(before ? clause.slice(word.end, k.start) : clause.slice(k.end, word.start))) continue;
    if (gap <= bestGap) {
      best = i;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * Keywords a negation belongs to. Before the keyword: within 25 characters and no comma or colon in
 * between ("inget stambyte", "ännu inget planerat stambyte"). After it: within 30 characters, no comma and
 * no year in between ("stambyte ej genomfört", "stambyte (ej genomfört)"), so "Stambyte genomfört 2018,
 * ingen avgiftshöjning" is not negated. Each negation binds to one keyword (the nearer one that qualifies).
 */
function negatedKeywords(clause: string, keywords: readonly Span[]): Set<number> {
  const negated = new Set<number>();
  for (const word of spansOf(NEGATION, clause, MAX_MODIFIERS)) {
    let target = -1;
    let targetGap = Number.POSITIVE_INFINITY;
    for (let i = 0; i < keywords.length; i++) {
      const k = keywords[i];
      if (word.end <= k.start) {
        const gap = k.start - word.end;
        if (gap <= NEGATION_BEFORE_REACH && !/[,:]/.test(clause.slice(word.end, k.start)) && gap < targetGap) {
          target = i;
          targetGap = gap;
        }
      } else if (word.start >= k.end) {
        const gap = word.start - k.end;
        const between = clause.slice(k.end, word.start);
        if (gap <= NEGATION_AFTER_REACH && !/,/.test(between) && !/(?<!\d)(?:19[5-9]\d|20[0-3]\d|204[0-5])(?!\d)/.test(between) && gap < targetGap) {
          target = i;
          targetGap = gap;
        }
      }
    }
    if (target >= 0) negated.add(target);
  }
  for (const word of spansOf(SUBSTITUTE, clause, MAX_MODIFIERS)) {
    for (let i = 0; i < keywords.length; i++) {
      const k = keywords[i];
      if (word.end <= k.start && k.start - word.end <= NEGATION_BEFORE_REACH && !/[,:]/.test(clause.slice(word.end, k.start))) {
        negated.add(i);
        break;
      }
    }
  }
  return negated;
}

/**
 * Words that may stand between a keyword and its year even across a comma: how the job went and hedges
 * about when ("Stambytet är slutfört, besiktigat och godkänt 2021", "stambyte inom några år, troligen
 * 2029", "stambyte, senast 2012"). Any other word after a comma starts a new subject, and its year is not
 * the stambyte year.
 */
const COMMA_FILLER: ReadonlySet<string> = new Set(
  (
    "är har var blev blivit och samt inom några år i på till som det den för av en ett sedan under senast " +
    "troligen sannolikt preliminärt preliminär ungefär ca cirka omkring runt slutfört genomfört klart färdigt " +
    "utfört gjort gjorts godkänt besiktigat avslutat slutfördes genomfördes utfördes gjordes klar färdig " +
    "slutförd genomförd utförd godkänd besiktigad avslutad avslutades nyligen tidigare redan helt " +
    "fullständigt fullt totalt först hela huset fastigheten föreningen husets även nu då nästa planerat " +
    "planerad planeras beräknat beräknas väntas"
  ).split(" "),
);

function onlyFiller(between: string): boolean {
  return (between.toLowerCase().match(/\p{L}+/gu) ?? []).every((word) => COMMA_FILLER.has(word));
}

/** True when the text between a keyword and a year says the year belongs to something else. */
function refusedAfter(between: string): boolean {
  if (/,/.test(between) && !onlyFiller(between)) return true;
  if (KEYWORD_ONCE.test(between)) return true;
  const topic = TOPIC.exec(between);
  if (topic && !JOINED_TOPIC.test(between.slice(0, topic.index))) return true;
  return false;
}

function refusedBefore(between: string): boolean {
  return /,/.test(between) || CONJUNCTION.test(between) || KEYWORD_ONCE.test(between) || TOPIC.test(between);
}

/** The year that belongs to one keyword: the nearest after it, else the nearest before it. */
function yearFor(clause: string, keyword: Span, years: readonly YearHit[]): YearHit | null {
  for (const year of years) {
    if (year.start < keyword.end) continue;
    if (year.start - keyword.end > YEAR_AFTER_REACH) break;
    if (!refusedAfter(clause.slice(keyword.end, year.start))) return year;
  }
  for (let i = years.length - 1; i >= 0; i--) {
    const year = years[i];
    if (year.end > keyword.start) continue;
    if (keyword.start - year.end > YEAR_BEFORE_REACH) break;
    if (!refusedBefore(clause.slice(year.end, keyword.start))) return year;
  }
  return null;
}

/**
 * The stambyte statements in the text, or all `null` when there is no text to read (`null` or empty).
 *
 * `runYear` splits past from future: a year above it is planned, a year up to it is completed (the latest
 * completed year wins; of several planned years the earliest). A plan word near the keyword also makes it
 * planned when the year is the run year or later, and the keyword is then not a completed stambyte. Of an
 * "ongoing" keyword only the flag is kept. Relining sets its own flag in any clause and never a year.
 * Only the first {@link STAMBYTE_TEXT_MAX_CHARS} characters are read.
 */
export function stambyteFromText(text: string | null, opts: { readonly runYear: number }): StambyteTextFacts {
  if (typeof text !== "string" || text.trim() === "") return NOT_READ;

  let lastYear: number | null = null;
  let plannedYear: number | null = null;
  let ongoing = false;
  let relining = false;
  let keywordsSeen = 0;

  for (const clause of clausesOf(prepare(text))) {
    if (RELINING.test(clause)) relining = true;
    if (keywordsSeen >= MAX_KEYWORDS) continue;
    const keywords = spansOf(KEYWORD, clause, MAX_KEYWORDS - keywordsSeen);
    if (keywords.length === 0) continue;
    keywordsSeen += keywords.length;

    const negated = negatedKeywords(clause, keywords);
    const planned = new Set<number>();
    const underWay = new Set<number>();
    for (const word of spansOf(PLAN, clause, MAX_MODIFIERS)) {
      const owner = nearestKeyword(clause, word, keywords, WORD_BEFORE_REACH, WORD_AFTER_REACH);
      if (owner >= 0) planned.add(owner);
    }
    for (const word of spansOf(ONGOING, clause, MAX_MODIFIERS)) {
      const owner = nearestKeyword(clause, word, keywords, WORD_BEFORE_REACH, WORD_AFTER_REACH);
      if (owner >= 0) underWay.add(owner);
    }
    const years = yearsOf(clause);

    for (let i = 0; i < keywords.length; i++) {
      if (negated.has(i)) continue;
      const keyword = keywords[i];
      if (underWay.has(i)) {
        ongoing = true;
        continue;
      }
      const around = clause.slice(Math.max(0, keyword.start - YEAR_BEFORE_REACH), keyword.end + YEAR_AFTER_REACH);
      if (RELINING_AS_STAMBYTE.test(around)) continue;
      const year = yearFor(clause, keyword, years);
      if (!year) continue;
      if (planned.has(i) || year.value > opts.runYear) {
        if (year.value >= opts.runYear) plannedYear = plannedYear === null ? year.value : Math.min(plannedYear, year.value);
        continue;
      }
      let value = year.value;
      const range =
        RANGE_END.exec(clause.slice(year.end, year.end + 10)) ??
        (/(?<![\p{L}])mellan\s{1,3}$/iu.test(clause.slice(Math.max(0, year.start - 10), year.start))
          ? BETWEEN_RANGE_END.exec(clause.slice(year.end, year.end + 12))
          : null);
      if (range && Number(range[1]) >= value && Number(range[1]) <= opts.runYear) value = Number(range[1]);
      lastYear = lastYear === null ? value : Math.max(lastYear, value);
    }
  }

  return { lastYear, plannedYear, ongoing, relining };
}
