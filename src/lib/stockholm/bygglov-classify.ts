/**
 * bygglov-classify.ts - tags, stored cases and building facts from the city's case list
 * (Phase 14.6, CASE-02, D-03, D-08, R-05).
 *
 * PURE, synchronous - no file system, network, clock or randomness. The date a fact is measured
 * against (`asOf`) is always passed in.
 *
 * WHAT IT DOES: a keyword table turns the one-line ärendemening of a case into a TAG SET
 * (`kinds`; one description often holds several works) plus a primary kind for display and a
 * separate `tillsyn` modifier (R-05). Decisions from the detail page turn into dated facts for a
 * building: the last stambyte year, whether a stambyte is under way, whether a balcony was
 * granted but is not yet signed off.
 *
 * HONESTY RULES: a fact that needs a decision the caller has not read is `null`, never `false`.
 * "No case on record" is unknown, not "never happened" - the caller decides how to word that.
 * Relining is a separate tag and never counts as a stambyte (D-06). `balkong_renovering` and
 * `tillsyn` exist so "balkong som rasat" and "olovligt byte av balkongdörrar" can never look
 * like a new balcony.
 *
 * PII RULE (D-03, T-14.6-01): the free text is read here and dropped. A stored case carries
 * only enum tags, digits, dates and a diarienummer; there is no field that can hold a sentence.
 *
 * COST OF BEING WRONG: a missed keyword leaves a case as `annat` (nothing is flagged); a false
 * keyword hit can print a balcony or stambyte line in a mail. The rules are therefore narrow,
 * and every pattern uses letter look-arounds and bounded quantifiers only (T-14.6-03), after the
 * text is capped at BYGGLOV_TEXT_MAX_CHARS.
 *
 * STRUCTURAL SEPARATION (LOCKED, D-12): like `bygglov-parse.ts`, this module sits beside the
 * ranking path. `niche-score.ts` and `report/flags.ts` must NEVER import it; the "stockholm/"
 * prefix is registered in `niche-score.test.ts` (in an earlier commit than this file).
 */
import type { CaseDetail, CaseListRow } from "@/lib/stockholm/bygglov-parse";

/** The kinds a case can carry, in the order D-03 / R-05 list them. */
export const CASE_KINDS = [
  "balkong_ny",
  "balkong_inglasning",
  "balkongdorr",
  "balkong_renovering",
  "stambyte",
  "relining",
  "hiss",
  "vind_inredning",
  "fasad",
  "tak",
  "annat",
] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

/** Which kind is shown first when a case carries several (RESEARCH 4.2). `balkong_renovering` ranks after `balkongdorr`. */
export const KIND_PRIORITY: readonly CaseKind[] = [
  "relining",
  "stambyte",
  "balkong_inglasning",
  "balkong_ny",
  "balkongdorr",
  "balkong_renovering",
  "hiss",
  "vind_inredning",
  "fasad",
  "tak",
  "annat",
];

/**
 * True when a case's tags make it a stambyte. THE ONE PLACE for this rule (D-06, R-05, WR-03): a case that also carries
 * the relining tag ("Stambyte genom relining", "Ej stambyte, enbart relining") is a relining, not a stambyte, so it
 * never gives a stambyte year, whatever the stambyte rule also matched.
 */
export const isStambyteKinds = (kinds: readonly string[]): boolean => kinds.includes("stambyte") && !kinds.includes("relining");

/** Changing a rule or the table means a new version, so a cache entry made with the old rules is refetched at next use. */
export const BYGGLOV_RULES_VERSION = 1;

/** Only this many leading characters of a description are read (ReDoS bound, T-14.6-03). The longest real one is under 200. */
export const BYGGLOV_TEXT_MAX_CHARS = 2_000;

// --- the rule table --------------------------------------------------------------------------------
//
// Every pattern has the `u` and `i` flags, a letter look-behind on its first keyword and bounded
// quantifiers only. `W` is one word of at most 25 letters, digits or hyphens; `SEP` is the gap
// between two words.

const W = String.raw`[\p{L}\d-]{1,25}`;
const SEP = String.raw`\s{1,3}`;
/** "balkong", "balkonger", "balkongen", "balkongerna", "balkongrader", "påhängsbalkong" - the noun itself, not balkongräcke or balkongdörr. */
const BALKONG = String.raw`(?:påhängs)?balkong(?:er|en|erna|rader|raderna)?(?![\p{L}])`;
/** The attic as a place: not vindfång, not vindskydd. */
const VIND = String.raw`(?:råvind(?:en)?|vinden|vindar(?:na)?|vind|vindsutrymme[\p{L}]{0,4}|vindsvåning[\p{L}]{0,4}|vindslägenhet[\p{L}]{0,4}|vindsbostad[\p{L}]{0,4}|vindsplan[\p{L}]{0,4})(?![\p{L}])`;

interface Rule {
  readonly kind: CaseKind;
  readonly pattern: RegExp;
}

const rx = (source: string): RegExp => new RegExp(source, "iu");

/** `annat` has no rule: it is what a case with no other tag becomes. */
export const BYGGLOV_RULES: readonly Rule[] = [
  // stambyte: the word itself (also inside a compound: "VA-stambyte", "totalstambyte"), "byte av ... stammar", "stamlägen".
  { kind: "stambyte", pattern: rx(String.raw`(?<![\p{L}])(?:[\p{L}]{1,12}-?)?stam(?:byte|renovering)`) },
  {
    kind: "stambyte",
    pattern: rx(
      String.raw`(?<![\p{L}])(?:ut)?byte${SEP}av${SEP}(?:${W}${SEP}){0,3}[\p{L}]{0,14}stam(?:mar|men)(?![\p{L}])`,
    ),
  },
  { kind: "stambyte", pattern: rx(String.raw`(?<![\p{L}])stamläge(?:n|t)?(?![\p{L}])`) },

  // relining: lining the old pipes from inside. A separate tag, never a stambyte (D-06).
  { kind: "relining", pattern: rx(String.raw`(?<![\p{L}])relin(?:ing|ad|ade|ats|a)[\p{L}]{0,10}`) },

  // balkong_inglasning: glazing in an existing balcony (also "loftgångsbalkonger").
  {
    kind: "balkong_inglasning",
    pattern: rx(
      String.raw`(?<![\p{L}])inglasning[\p{L}]{0,6}${SEP}(?:av${SEP})?(?:${W}${SEP}){0,2}[\p{L}]{0,12}balkong(?:er|en|erna)?(?![\p{L}])`,
    ),
  },
  {
    kind: "balkong_inglasning",
    pattern: rx(String.raw`(?<![\p{L}])balkong(?:er|en|erna)?${SEP}(?:med${SEP})?inglasning`),
  },
  { kind: "balkong_inglasning", pattern: rx(String.raw`(?<![\p{L}])inglasad[\p{L}]{0,4}${SEP}(?:${W}${SEP}){0,1}balkong`) },

  // balkong_ny: a verb of building, then the balcony noun; "balkong med fönsterdörr"; påhängsbalkong.
  {
    kind: "balkong_ny",
    pattern: rx(
      String.raw`(?<![\p{L}])(?:uppförande|nybyggnad|nya?|tillbyggnad|montering|uppsättning|ytterligare)${SEP}(?:av${SEP})?(?:${W}${SEP}){0,3}${BALKONG}`,
    ),
  },
  {
    kind: "balkong_ny",
    pattern: rx(
      String.raw`(?<![\p{L}])balkong(?:er|en|erna)?${SEP}(?:med${SEP})?(?:fönsterdörr|balkongdörr)[\p{L}]{0,6}`,
    ),
  },
  { kind: "balkong_ny", pattern: rx(String.raw`(?<![\p{L}])påhängsbalkong[\p{L}]{0,6}`) },

  // balkongdorr: the door alone. Changing doors is not a new balcony.
  { kind: "balkongdorr", pattern: rx(String.raw`(?<![\p{L}])(?:balkong|fönster)dörr[\p{L}]{0,10}`) },

  // balkong_renovering: repair, change or a complaint about an existing balcony. The comma and the
  // semicolon end the window, so "Yttre ändring, nya balkonger" does not read as a renovation.
  {
    kind: "balkong_renovering",
    pattern: rx(
      String.raw`(?<![\p{L}])(?:renovering|ändring|reparation|underhåll|skrivelse|anmälan)[\p{L}]{0,10}[^,;]{0,40}balkong(?:er|en|erna)?(?![\p{L}])`,
    ),
  },
  {
    kind: "balkong_renovering",
    pattern: rx(
      String.raw`(?<![\p{L}])balkong(?:renovering|reparation|underhåll|ombyggnad|platt|räcke|golv|gjut)[\p{L}]{0,12}`,
    ),
  },
  {
    kind: "balkong_renovering",
    pattern: rx(String.raw`(?<![\p{L}])balkong(?:er|en|erna)?${SEP}som${SEP}(?:ra[sz]at|rämnat|skadats|fallit)`),
  },

  // hiss: a lift, also in a compound ("stoltrapphiss", "personhiss").
  { kind: "hiss", pattern: rx(String.raw`(?<![\p{L}])[\p{L}]{0,14}hiss[\p{L}]{0,12}(?![\p{L}])`) },

  // fasad: facade work or a window change. A sign on a facade ("fasadskylt") is not facade work.
  {
    kind: "fasad",
    pattern: rx(String.raw`(?<![\p{L}])(?:[\p{L}]{1,10})?fasad(?!skylt|reklam|belysning|ljusbox)[\p{L}]{0,12}`),
  },
  {
    kind: "fasad",
    pattern: rx(
      String.raw`(?<![\p{L}])(?:omfärgning|fönsterbyte|fönsterrenovering|byte${SEP}av${SEP}(?:${W}${SEP}){0,1}fönster)(?![\p{L}])`,
    ),
  },

  // tak: re-roofing and roof work.
  {
    kind: "tak",
    pattern: rx(
      String.raw`(?<![\p{L}])(?:takomläggning|takbyte|takrenovering|yttertak|nytt${SEP}tak|omläggning${SEP}av${SEP}(?:${W}${SEP}){0,1}tak)[\p{L}]{0,8}`,
    ),
  },

  // vind_inredning: building work "on the attic", a roof dormer, or a new roof terrace.
  {
    kind: "vind_inredning",
    pattern: rx(
      String.raw`(?<![\p{L}])(?:inredning|ombyggnad|ändring|utbyggnad|tillbyggnad|påbyggnad)${SEP}(?:av${SEP})?(?:${W}${SEP}){0,3}${VIND}`,
    ),
  },
  { kind: "vind_inredning", pattern: rx(String.raw`(?<![\p{L}])vindsinredning[\p{L}]{0,6}`) },
  { kind: "vind_inredning", pattern: rx(String.raw`(?<![\p{L}])takkup(?:a|or|an|ar)(?![\p{L}])`) },
  {
    kind: "vind_inredning",
    pattern: rx(
      String.raw`(?<![\p{L}])(?:ny|nya|uppförande|nybyggnad|tillbyggnad|inredning|anläggande)${SEP}(?:av${SEP})?(?:${W}${SEP}){0,1}takterrass[\p{L}]{0,6}`,
    ),
  },
];

/** An enforcement case at the start of the text, or "olovlig..." anywhere: a complaint, not a permit. */
const TILLSYN_START = rx(String.raw`^\s{0,3}\(?\s{0,3}(?:tillsyn[\p{L}]{0,15}|anmaning)`);
const TILLSYN_UNLAWFUL = rx(String.raw`(?<![\p{L}])olovlig[\p{L}]{0,8}`);

/** Cap, then drop soft hyphens and zero-width characters, and turn no-break spaces into spaces. */
function prepare(text: string): string {
  return text
    .slice(0, BYGGLOV_TEXT_MAX_CHARS)
    .replace(/[­​-‍⁠﻿]/g, "")
    .replace(/[   ]/g, " ");
}

export interface Classification {
  /** Every tag that matched, most important first; `["annat"]` when nothing matched. */
  readonly kinds: readonly CaseKind[];
  /** `kinds[0]`: the kind shown for the case. */
  readonly primary: CaseKind;
  /** An enforcement case or an "olovligt" wording. */
  readonly tillsyn: boolean;
}

/** The tag set of one ärendemening. Null and empty text give `annat`. */
export function classifyDescription(text: string | null): Classification {
  const prepared = text === null ? "" : prepare(text);
  const found = new Set<CaseKind>();
  for (const rule of BYGGLOV_RULES) {
    if (!found.has(rule.kind) && rule.pattern.test(prepared)) found.add(rule.kind);
  }
  const kinds = KIND_PRIORITY.filter((kind) => found.has(kind));
  if (kinds.length === 0) kinds.push("annat");
  return {
    kinds,
    primary: kinds[0],
    tillsyn: TILLSYN_START.test(prepared) || TILLSYN_UNLAWFUL.test(prepared),
  };
}

// --- decisions -------------------------------------------------------------------------------------

export const DECISION_KINDS = ["startbesked", "lov", "slutbesked", "avskrivet", "avslag", "beslut", "okand"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

const norm = (s: string | null): string => (s ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase("sv");

/**
 * What a decision of the city means (RESEARCH 4.2 note, an assumption from PBL practice). The code
 * wins: any type with the code "Avskrivet" or "Avslag" is that. Anything not listed is `okand`
 * and is counted by the caller, never guessed.
 */
export function decisionKind(type: string | null, code: string | null): DecisionKind {
  const c = norm(code);
  if (c === "avskrivet") return "avskrivet";
  if (c === "avslag") return "avslag";
  const t = norm(type);
  if (t === "startbesked") return "startbesked";
  if (t === "lov med startbesked" || t === "lovbeslut" || t === "lov") return "lov";
  if (t === "slutbesked / slutbevis" || t === "slutbesked" || t === "interimistiskt slutbesked") return "slutbesked";
  if (t === "beslut" && c === "bifall") return "beslut";
  return "okand";
}

// --- the stored case -------------------------------------------------------------------------------

/** What the detail page adds for an interesting case. Strings are the city's own words, cut and cleaned by the caller. */
export interface LatestDecision {
  readonly type: string;
  readonly code: string | null;
  /** YYYY-MM-DD. */
  readonly date: string | null;
}

/** A case as it is cached: tags, digits and dates. There is no field for free text or a name. */
export interface StoredCase {
  readonly rec: string;
  readonly diarie: string;
  /** YYYY-MM-DD. */
  readonly startDate: string;
  readonly kinds: readonly CaseKind[];
  readonly primary: CaseKind;
  readonly tillsyn: boolean;
  readonly archived: boolean;
  /** True once the detail page was read, so a missing decision means "none" and not "not looked at". */
  readonly detailRead: boolean;
  readonly latest: LatestDecision | null;
  /** The earliest granted Startbesked or Lov decision. */
  readonly startbeskedDate: string | null;
  readonly slutbeskedDate: string | null;
  readonly closedDate: string | null;
}

/** A parsed list row plus its classification, with the description dropped. */
export function toStoredCase(row: CaseListRow, classification: Classification): StoredCase {
  return {
    rec: row.rec,
    diarie: row.diarie,
    startDate: row.startDate,
    kinds: [...classification.kinds],
    primary: classification.primary,
    tillsyn: classification.tillsyn,
    archived: row.archived,
    detailRead: false,
    latest: null,
    startbeskedDate: null,
    slutbeskedDate: null,
    closedDate: null,
  };
}

/** The city's own words for a decision type or code, cut and cleaned so only plain text can reach a cache or a mail. */
const cleanWords = (raw: string | null): string | null => {
  if (raw === null) return null;
  const cleaned = raw.replace(/[^\p{L}\p{N} /.,()-]/gu, "").trim().slice(0, 60);
  return cleaned.length > 0 ? cleaned : null;
};

/**
 * Fills a stored case from its parsed detail page: the latest decision, the earliest granted
 * Startbesked or Lov, the latest Slutbesked, the closing date, and `detailRead: true`. The detail
 * carries no name and no free text, so the stored case still has none.
 */
export function applyDetail(stored: StoredCase, detail: CaseDetail): StoredCase {
  if (detail.rec !== null && detail.rec !== stored.rec) throw new Error("detail does not belong to this case");
  const decisions = detail.decisions
    .map((d) => ({ ...d, kind: decisionKind(d.type, d.code) }))
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  const last = decisions.length > 0 ? decisions[decisions.length - 1] : null;
  const dates = (kinds: readonly DecisionKind[]) =>
    decisions.filter((d) => kinds.includes(d.kind) && d.date !== null).map((d) => d.date as string);
  const granted = dates(["startbesked", "lov"]);
  const finished = dates(["slutbesked"]);
  return {
    ...stored,
    detailRead: true,
    latest: last === null ? null : { type: cleanWords(last.type) ?? "", code: cleanWords(last.code), date: last.date },
    startbeskedDate: granted.length > 0 ? granted[0] : null,
    slutbeskedDate: finished.length > 0 ? finished[finished.length - 1] : null,
    closedDate: detail.closedDate,
  };
}

/**
 * Whether the detail page of this case is worth a request: an interesting kind, started within the
 * last five years, not read yet. Enforcement cases never feed a fact, so they are not fetched.
 */
export function needsDetail(stored: StoredCase, asOf: string): boolean {
  if (stored.detailRead || stored.tillsyn) return false;
  if (stored.startDate > asOf || stored.startDate < yearsBefore(asOf, RECENT_YEARS)) return false;
  return stored.kinds.some((kind) => INTERESTING_KINDS.includes(kind));
}

// --- building facts --------------------------------------------------------------------------------

/** The kinds worth a detail page and a line in the "Byggärenden" cell. */
export const INTERESTING_KINDS: readonly CaseKind[] = [
  "balkong_ny",
  "balkong_inglasning",
  "balkongdorr",
  "stambyte",
  "relining",
  "hiss",
  "vind_inredning",
];

/** How far back a case still counts as news (D-08). */
const RECENT_YEARS = 5;
/** A stambyte started this long ago is taken as done even without a slutbesked on record (RESEARCH A12). */
const STAMBYTE_DONE_AFTER_YEARS = 3;
const RECENT_MAX_ITEMS = 6;

export interface RecentCase {
  readonly kind: CaseKind;
  /** YYYY-MM of the case start. */
  readonly month: string;
  /** What the decisions say; null when they were not read. */
  readonly decision: DecisionKind | null;
}

export interface BuildingFacts {
  readonly lastStambyteYear: number | null;
  /**
   * Where the year comes from: "slutbesked" (the final inspection), "start" (the detail page was read, no refusal and
   * no slutbesked, started over three years ago: taken as done, RESEARCH A12) or "ärendestart" (the detail page was
   * NOT read, so a refusal or a withdrawal cannot be ruled out: the year only says an application was started).
   */
  readonly lastStambyteBasis: "slutbesked" | "start" | "ärendestart" | null;
  /** True: a stambyte has a startbesked and no slutbesked. Null: a recent stambyte case was not read. */
  readonly stambyteOngoing: boolean | null;
  /** A relining case exists. Never turns into a stambyte year. */
  readonly reliningCase: boolean;
  /** True: a new or glazed balcony is granted and not signed off. Null: a qualifying case was not read. */
  readonly balkongBeviljadEjByggd: boolean | null;
  /** YYYY-MM of the granted decision, when the flag is true. */
  readonly balkongBeviljadMonth: string | null;
  /** True: a glazing application is on file without an outcome. Null: a qualifying case was not read. */
  readonly balkongInglasningAnsokt: boolean | null;
  /** YYYY-MM of the application, when the flag is true. */
  readonly inglasningMonth: string | null;
  /** Newest first, at most six. Enforcement cases are left out. */
  readonly recent: readonly RecentCase[];
  /** Cases whose latest decision has a type the table does not know. */
  readonly unknownDecisionTypes: number;
}

/** The same month-and-day, `years` earlier. Compared as strings, so a 29 February needs no special case. */
const yearsBefore = (asOf: string, years: number): string => `${Number(asOf.slice(0, 4)) - years}${asOf.slice(4)}`;

const latestKind = (c: StoredCase): DecisionKind | null => (c.latest === null ? null : decisionKind(c.latest.type, c.latest.code));
const isRefused = (c: StoredCase): boolean => {
  const kind = latestKind(c);
  return kind === "avskrivet" || kind === "avslag";
};
const granted = (c: StoredCase): boolean => c.startbeskedDate !== null && !isRefused(c);

/** Dated facts about one building from its stored cases. A case that starts after `asOf` is ignored everywhere. */
export function buildingFactsOf(allCases: readonly StoredCase[], asOf: string): BuildingFacts {
  const cases = allCases.filter((c) => c.startDate <= asOf);
  const recentFrom = yearsBefore(asOf, RECENT_YEARS);
  const isRecent = (c: StoredCase) => c.startDate >= recentFrom;

  // --- stambyte -----------------------------------------------------------------------------------
  const stambyte = cases.filter((c) => isStambyteKinds(c.kinds) && !c.tillsyn);

  const slutbeskedYears = stambyte
    .filter((c) => c.slutbeskedDate !== null && !isRefused(c))
    .map((c) => Number((c.slutbeskedDate as string).slice(0, 4)));
  const doneBefore = yearsBefore(asOf, STAMBYTE_DONE_AFTER_YEARS);
  // A case without a slutbesked that started over three years ago. An opened one is known not to be refused ("start");
  // an unopened one may be a refusal or a withdrawal that the list does not show ("ärendestart", WR-04).
  const startCandidates = stambyte
    .filter((c) => c.slutbeskedDate === null && c.startDate < doneBefore && !isRefused(c))
    .map((c) => ({ year: Number(c.startDate.slice(0, 4)), basis: c.detailRead ? ("start" as const) : ("ärendestart" as const) }));

  let lastStambyteYear: number | null = null;
  let lastStambyteBasis: BuildingFacts["lastStambyteBasis"] = null;
  if (slutbeskedYears.length > 0) {
    lastStambyteYear = Math.max(...slutbeskedYears);
    lastStambyteBasis = "slutbesked";
  } else if (startCandidates.length > 0) {
    // The latest year; at the same year the verified basis wins.
    const best = startCandidates.reduce((a, b) => (b.year > a.year || (b.year === a.year && b.basis === "start") ? b : a));
    lastStambyteYear = best.year;
    lastStambyteBasis = best.basis;
  }

  const stambyteRecent = stambyte.filter(isRecent);
  const ongoing = stambyteRecent.some(
    (c) => c.detailRead && granted(c) && c.slutbeskedDate === null && c.closedDate === null,
  );
  const stambyteOngoing = ongoing ? true : stambyteRecent.some((c) => !c.detailRead) ? null : false;

  // --- balcony ------------------------------------------------------------------------------------
  const balcony = cases.filter(
    (c) => (c.kinds.includes("balkong_ny") || c.kinds.includes("balkong_inglasning")) && !c.tillsyn && isRecent(c),
  );

  const built = balcony
    .filter((c) => c.detailRead && granted(c) && c.slutbeskedDate === null)
    .map((c) => (c.startbeskedDate as string).slice(0, 7))
    .sort();
  const balkongBeviljadEjByggd = built.length > 0 ? true : balcony.some((c) => !c.detailRead) ? null : false;

  const pending = balcony
    .filter((c) => c.kinds.includes("balkong_inglasning"))
    .filter((c) => !c.detailRead || (!granted(c) && !isRefused(c) && c.closedDate === null));
  const pendingRead = pending.filter((c) => c.detailRead).map((c) => c.startDate.slice(0, 7)).sort();
  const balkongInglasningAnsokt = pendingRead.length > 0 ? true : pending.some((c) => !c.detailRead) ? null : false;

  // --- the short list for the "Byggärenden" cell ---------------------------------------------------
  const recent: RecentCase[] = cases
    .filter((c) => !c.tillsyn && isRecent(c))
    .flatMap((c) => {
      const kind = KIND_PRIORITY.find((k) => c.kinds.includes(k) && INTERESTING_KINDS.includes(k));
      if (kind === undefined) return [];
      const decision: DecisionKind | null = !c.detailRead ? null : c.slutbeskedDate !== null ? "slutbesked" : latestKind(c);
      return [{ c, item: { kind, month: c.startDate.slice(0, 7), decision } satisfies RecentCase }];
    })
    .sort((a, b) => (a.c.startDate === b.c.startDate ? b.c.rec.localeCompare(a.c.rec) : b.c.startDate.localeCompare(a.c.startDate)))
    .slice(0, RECENT_MAX_ITEMS)
    .map((entry) => entry.item);

  return {
    lastStambyteYear,
    lastStambyteBasis,
    stambyteOngoing,
    reliningCase: cases.some((c) => c.kinds.includes("relining") && !c.tillsyn),
    balkongBeviljadEjByggd,
    balkongBeviljadMonth: built.length > 0 ? built[built.length - 1] : null,
    balkongInglasningAnsokt,
    inglasningMonth: pendingRead.length > 0 ? pendingRead[pendingRead.length - 1] : null,
    recent,
    unknownDecisionTypes: cases.filter((c) => latestKind(c) === "okand").length,
  };
}
