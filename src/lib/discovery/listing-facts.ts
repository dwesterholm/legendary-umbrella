/**
 * listing-facts.ts - the CandidateFacts record (Phase 14.2, WATCH-02, R-08): what
 * Booli's own payloads say about one listing beyond the 24 persisted candidate
 * fields (tenure, avgift, listing age, price cut, bidding, BRF id and more).
 *
 * PURE, synchronous - no clock, randomness, network, async, file or environment
 * access. The run date comes in as `asOf` ("YYYY-MM-DD"); every function returns the
 * same output for the same input.
 *
 * R-08 (facts live BESIDE the candidate): `DiscoveryCandidate`, its zod schema and
 * the `toCandidate` allowlist in `candidate.ts` are NOT widened. A facts record is
 * keyed by Booli id by its caller and travels next to the candidate. Every field is
 * `.nullable().default(null)` (the project convention, see the CR-01 comment in
 * `candidate.ts`): a record that lacks a key still parses and the missing value is
 * `null`, never `undefined`, so `=== null` guards downstream stay correct.
 *
 * PII RULE: only DERIVED values are stored. Never the listing description, never a
 * broker or seller name, phone number or e-mail address, never free text of any kind.
 * `descriptionRead`, `sunPhrases` and `landLease` are filled from a description by a
 * later step, but the description itself is read there and thrown away. The zod
 * object strips unknown keys, so free text handed to a parse cannot ride along.
 *
 * STRUCTURAL SEPARATION (LOCKED): like `taste.ts` and `reno-tier.ts`, this module
 * sits beside the ranking path. `niche-score.ts` and `report/flags.ts` must NEVER
 * import it; the static-grep invariant in `niche-score.test.ts` enforces that and
 * this module's specifier is registered there.
 *
 * CARD vs DETAIL (the one asymmetry): a search card lists only some amenities and no
 * description, so a card that omits the balcony or the elevator tells us nothing and
 * the fact stays `null` (R-04b). A detail page lists every amenity, so there a missing
 * balcony or elevator is `false`. {@link mergeFacts} lets the detail value win.
 *
 * PRICE CUT SIGN (assumption A3, resolved by a real capture on 2026-10-13): Booli's
 * `listPriceChange` is signed against the first asking price. Pokalvägen 4 (booli.se/
 * bostad/700725) carries -600 000 kr and -15,6 % and its search card shows a TrendDown
 * icon with the label "-15,6%"; Sågargatan 14 is -600 000 kr / -14,5 %; Tobaksspinnargatan
 * 10 carries +305 000 kr / +7,3 % with a TrendUp icon (the asking price went UP). So a
 * NEGATIVE Booli value is a cut. `priceCutSek` flips the sign so that a POSITIVE number
 * always means "the asking price went down by that many kronor" and a negative number
 * means it went up. `listPricePercentageDiff` is kept with Booli's own sign (negative =
 * lower), because that is what Booli prints next to the price.
 *
 * ASSUMPTIONS (named, so a reader can overrule them):
 *  - Booli's `published` timestamp ("2026-08-21 17:30:57") is a Stockholm wall-clock
 *    time; only its date is used, so a few hours of offset change nothing.
 *  - Days on market from card text is coarse by design ("En månad på Booli" is 30,
 *    "11 månader på Booli" is 330). The card gives no weeks; any other wording is null.
 *  - Only "Bostadsrätt" has been seen in `tenureForm` (52 detail pages on 2026-10-13);
 *    the string is stored as Booli writes it and never normalised here.
 *
 * FILLED LATER: `orientationFacades`, `sunPhrases`, `descriptionRead`, `landLease`,
 * `ceilingHeightM`, `ceilingSource`, `tallCeilingPhrase` and
 * `brf` come from the enrichment steps (plans 05 and 07: broker page text and the
 * public BRF page). They stay `null` here.
 *
 * Phase 14.6 (plan 09) adds sixteen more, all `null` here and filled by two later steps:
 *  - from the broker text, inside `watch-enrich.ts` before the description is dropped:
 *    `textStambyte`, `areaSource`, `areaMeasuredYear`, `areaMeasuredFirm`,
 *    `fastighetsbeteckning` and `beteckningRung` "a" (when the text states it), plus
 *    `lastStambyteYear`, `plannedStambyteYear`, `stambyteOngoing`, `stambyteSource`,
 *    `stambyteStatus` and `reliningMentioned` as merged from the text alone;
 *  - from the city's case list, in `stockholm/city-stage.ts` (a separate step the script
 *    runs, live or from the cache): `cityStambyte`, `balkongBeviljadEjByggd`,
 *    `balkongInglasningAnsokt`, `byggarenden`, the beteckning and its rung when the text
 *    gave none, and the six merged stambyte fields again with the city's reading added.
 * `textStambyte` and `cityStambyte` are kept next to the merged values so a later re-merge
 * (a new annual-report source, a changed rule) never loses what one source said.
 *
 * Every number lives in {@link FACTS_CONSTANTS}; the functions own no constants (same
 * discipline as TASTE_WEIGHTS in taste.ts).
 */

import { z } from "zod";
import { AREA_SOURCES } from "@/lib/discovery/area-source";
import { STAMBYTE_SOURCES, STAMBYTE_STATUSES } from "@/lib/discovery/stambyte-facts";
import { CASE_KINDS } from "@/lib/stockholm/bygglov-classify";

/** The one table of numbers this module uses. */
export const FACTS_CONSTANTS: { readonly DAYS_PER_MONTH: 30; readonly DAYS_PER_YEAR: 365; readonly MS_PER_DAY: 86_400_000 } = {
  DAYS_PER_MONTH: 30,
  DAYS_PER_YEAR: 365,
  MS_PER_DAY: 86_400_000,
};

/** Where a listing's age came from: Booli's publish date, or the coarse card wording. */
export const DAYS_ON_MARKET_SOURCES = ["published", "card-text"] as const;

/** The facts record. Every field is `.nullable().default(null)`; `detailFetched` defaults to false. */
export const candidateFactsSchema = z.object({
  /** Upplåtelseform exactly as Booli writes it ("Bostadsrätt", ...). Detail pages only. */
  tenureForm: z.string().nullable().default(null),
  /** Monthly avgift in kr (card dataPoint or detail `rent`). */
  avgiftMonthlySek: z.number().nullable().default(null),
  /** Monthly drift cost in kr (detail only). */
  operatingCostMonthlySek: z.number().nullable().default(null),
  constructionYear: z.number().nullable().default(null),
  /** true / false only after a detail read; a card says true or null (R-04b). */
  balcony: z.boolean().nullable().default(null),
  floor: z.number().nullable().default(null),
  /** Same card-vs-detail rule as `balcony`. */
  elevatorListed: z.boolean().nullable().default(null),
  /** "YYYY-MM-DD" from Booli's `published` (detail only). */
  publishedAt: z.string().nullable().default(null),
  daysOnMarket: z.number().nullable().default(null),
  daysOnMarketSource: z.enum(DAYS_ON_MARKET_SOURCES).nullable().default(null),
  /** Positive = the asking price went DOWN by this many kronor; negative = it went up (see module doc). */
  priceCutSek: z.number().nullable().default(null),
  /** Booli's own sign: negative = lower. */
  listPricePercentageDiff: z.number().nullable().default(null),
  biddingOpen: z.boolean().nullable().default(null),
  /** Card status: "biddingOpen", "upcomingSale", "newConstruction", ... */
  statusKey: z.string().nullable().default(null),
  brfName: z.string().nullable().default(null),
  /** Digits of the /bostadsrattsforening/<id> breadcrumb. */
  brfId: z.string().nullable().default(null),
  isNewConstruction: z.boolean().nullable().default(null),
  /** Filled by enrichment (stated orientation of the facades). */
  orientationFacades: z.array(z.enum(["north", "east", "south", "west"])).nullable().default(null),
  /** Filled by enrichment: the sun phrases found, as short derived tags (never the sentence). */
  sunPhrases: z.array(z.string()).nullable().default(null),
  /** Filled by enrichment: whether a broker description was read at all. */
  descriptionRead: z.boolean().nullable().default(null),
  /** Filled by enrichment: tomträtt stated (true) or ruled out (false). */
  landLease: z.boolean().nullable().default(null),
  /**
   * Filled by enrichment (Phase 14.5, CEIL-01): the ceiling height the broker STATED, in metres (2,2 to 5,0 only).
   * `null` = not stated or not read. A number only; the sentence is never stored.
   */
  ceilingHeightM: z.number().nullable().default(null),
  /** Where `ceilingHeightM` came from: always the broker's own words ("angiven"), never a picture (D-08). */
  ceilingSource: z.literal("angiven").nullable().default(null),
  /**
   * A tall-ceiling phrase without a number ("högt i tak"). `null` = the text was not read, `false` = read and no
   * such phrase. A flag only; it never becomes a number (D-05).
   */
  tallCeilingPhrase: z.boolean().nullable().default(null),
  /**
   * Phase 14.6 (CASE-01): the building's fastighetsbeteckning as the city writes it ("Droskhästen 8"), from the broker
   * text (rung a) or the city stage. A designation only; never a sentence.
   */
  fastighetsbeteckning: z.string().max(80).nullable().default(null),
  /** Which rung found `fastighetsbeteckning`: a text, a2 BRF name, b the city's address search, c Min Karta. */
  beteckningRung: z.enum(["a", "a2", "b", "c"]).nullable().default(null),
  /** Phase 14.6 (STAM-03, D-07): the latest completed stambyte year, the city's before the text's. */
  lastStambyteYear: z.number().nullable().default(null),
  /** The planned stambyte year; only the broker text gives one. */
  plannedStambyteYear: z.number().nullable().default(null),
  /** True: under way. False: a source was read and says no. Null: nothing read. */
  stambyteOngoing: z.boolean().nullable().default(null),
  /** The source the status came from, strongest first (D-07). */
  stambyteSource: z.enum(STAMBYTE_SOURCES).nullable().default(null),
  /** genomfort | pagar | planerat. */
  stambyteStatus: z.enum(STAMBYTE_STATUSES).nullable().default(null),
  /** Relining mentioned (city case or text). Relining is never a stambyte. */
  reliningMentioned: z.boolean().nullable().default(null),
  /** What the broker text alone said about stambyte (null = the text was not read). Kept for a later re-merge. */
  textStambyte: z
    .object({
      lastYear: z.number().nullable().default(null),
      plannedYear: z.number().nullable().default(null),
      ongoing: z.boolean().nullable().default(null),
      relining: z.boolean().nullable().default(null),
    })
    .nullable()
    .default(null),
  /** What the city's case list alone said (null = the list was not read). Kept for a later re-merge. */
  cityStambyte: z
    .object({
      lastYear: z.number().nullable().default(null),
      basis: z.enum(["slutbesked", "start"]).nullable().default(null),
      ongoing: z.boolean().nullable().default(null),
      relining: z.boolean().nullable().default(null),
    })
    .nullable()
    .default(null),
  /** Phase 14.6 (FLAG-01, D-08): a new or glazed balcony is granted and not signed off. Null: not read or not certain. */
  balkongBeviljadEjByggd: z.boolean().nullable().default(null),
  /** A glazing application is on file without an outcome. Null: not read or not certain. */
  balkongInglasningAnsokt: z.boolean().nullable().default(null),
  /**
   * The building's recent cases of interest, newest first, at most 6 (tags, months and the case number only). `null` =
   * the city list was not read for this building; `[]` = read and nothing of interest.
   */
  byggarenden: z
    .array(
      z.object({
        kind: z.enum(CASE_KINDS),
        month: z.string().regex(/^\d{4}-\d{2}$/),
        decision: z.enum(["beviljad", "startbesked", "slutbesked", "avskrivet", "avslag", "ansokt", "okant"]),
        slutbeskedMonth: z.string().regex(/^\d{4}-\d{2}$/).nullable().default(null),
        diarie: z.string().regex(/^[0-9A-Za-z/ -]{1,20}$/).nullable().default(null),
      }),
    )
    .max(6)
    .nullable()
    .default(null),
  /** Phase 14.6 (FLAG-02, D-09): where the area figure comes from, as the broker text states it. */
  areaSource: z.enum(AREA_SOURCES).nullable().default(null),
  /** The year the area was measured (only when the source is "uppmatt"). */
  areaMeasuredYear: z.number().nullable().default(null),
  /** Whether a measuring firm is named (yes/no only, never the name). */
  areaMeasuredFirm: z.boolean().nullable().default(null),
  /** Filled by the BRF step: loans and area from the association's page. */
  brf: z
    .object({
      loanSek: z.number().nullable().default(null),
      areaSqm: z.number().nullable().default(null),
      reportYear: z.number().nullable().default(null),
      debtPerSqm: z.number().nullable().default(null),
    })
    .nullable()
    .default(null),
  /** True once a detail page was read for this listing. */
  detailFetched: z.boolean().default(false),
});

export type CandidateFacts = z.infer<typeof candidateFactsSchema>;

const FACT_KEYS = Object.keys(candidateFactsSchema.shape) as (keyof CandidateFacts)[];

/** A facts record with nothing known. */
export function emptyFacts(): CandidateFacts {
  return candidateFactsSchema.parse({});
}

// ---------------------------------------------------------------------------
// Small readers (null-tolerant, never throw)
// ---------------------------------------------------------------------------

/** A finite number, or the `raw` of a FormattedValue, else null. */
function numOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v && typeof v === "object" && "raw" in v) {
    const raw = (v as { raw: unknown }).raw;
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  }
  return null;
}

const strOf = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/** A boolean, or 0 / 1 as Booli writes `biddingOpen`. */
function boolOf(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "number" && Number.isFinite(v)) return v !== 0;
  return null;
}

const positive = (n: number | null): number | null => (n !== null && n > 0 ? n : null);

/**
 * The amenity keys of an `amenities` value, or null when it is not an array. Reads inline
 * `{ key }` objects and legacy `{ __ref: 'Amenity:{"key":"balcony"}' }` refs, with an exact
 * key comparison (never a substring match: "balconyView" is not "balcony").
 */
function amenityKeysOf(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const keys: string[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    if ("__ref" in item) {
      const ref = (item as { __ref: unknown }).__ref;
      if (typeof ref !== "string" || !ref.startsWith("Amenity:")) continue;
      try {
        const key = (JSON.parse(ref.slice("Amenity:".length)) as { key?: unknown }).key;
        if (typeof key === "string") keys.push(key);
      } catch {
        /* malformed ref: skipped */
      }
    } else {
      const key = (item as { key?: unknown }).key;
      if (typeof key === "string") keys.push(key);
    }
  }
  return keys;
}

/** Days since the epoch for a "YYYY-MM-DD" (or longer, date first) string, or null for anything that is not a real date. */
function dayNumber(text: string): number | null {
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return ms / FACTS_CONSTANTS.MS_PER_DAY;
}

// ---------------------------------------------------------------------------
// Text readers
// ---------------------------------------------------------------------------

/**
 * Days on market from the wording of a search card (`displayDate`):
 * "Inkommet idag" 0, "Inkommet igår" 1, "N dagar på Booli" N, "En månad på Booli" 30,
 * "N månader på Booli" 30 x N, "N år på Booli" 365 x N. Anything else is null. Coarse by
 * design: a card says "2 månader", not which day. Pure.
 */
export function daysOnMarketFromText(text: string | null): number | null {
  if (typeof text !== "string") return null;
  const t = text.trim().toLowerCase();
  if (t === "inkommet idag") return 0;
  if (t === "inkommet igår") return 1;
  const m = t.match(/^(\d+|en|ett)\s+(dag|dagar|månad|månader|år)\s+på\s+booli$/);
  if (!m) return null;
  const n = m[1] === "en" || m[1] === "ett" ? 1 : Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2] === "dag" || m[2] === "dagar") return n;
  if (m[2] === "månad" || m[2] === "månader") return n * FACTS_CONSTANTS.DAYS_PER_MONTH;
  return n * FACTS_CONSTANTS.DAYS_PER_YEAR;
}

/**
 * Whether a description says the land is leased (tomträtt): true when stated, false when
 * ruled out (not tomträtt, "friköpt", "föreningen äger marken"), null when it says nothing or
 * there is no text. Pure.
 *
 * What rules tomträtt out (WR-10): a negation right before the noun ("ej/inte/ingen tomträtt", with
 * at most one word between; "utan tomträtt" only directly before it, because "utan" is also the
 * common conjunction), or a PAST-tense buy-out (friköpt, avlöst) in the same sentence as the
 * tomträtt mention, or, with no tomträtt mention at all, anywhere ("Marken är friköpt"). A buy-out
 * that is only possible or planned ("möjlighet att friköpa", "ska avlösas 2028") rules nothing out:
 * the flat is still on leased land today, and that is what the column exists to show.
 */
export function landLeaseFromText(text: string | null): boolean | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  const t = text.toLowerCase();
  const mentionsLease = /tomträtt/.test(t);
  if (/\b(?:ej|inte|ingen)\s+(?:\S+\s+)?tomträtt/.test(t)) return false;
  if (/\butan\s+tomträtt(?:en)?\b/.test(t)) return false;
  const boughtOut = /friköpt|friköpte|friköpts|avlöst|avlöste|avlösts/;
  if (mentionsLease) {
    const sentences = t.split(/[.;!?\n]+/);
    if (sentences.some((sentence) => /tomträtt/.test(sentence) && boughtOut.test(sentence))) return false;
    return true;
  }
  if (boughtOut.test(t)) return false;
  if (/äger\s+(?:både\s+)?(?:marken|tomten)/.test(t)) return false;
  return null;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

/** What the card and the detail page share: each is read only if the record has it. */
function commonFacts(raw: Raw): Partial<CandidateFacts> {
  const year = numOf(raw.constructionYear);
  const listPriceChange = numOf(raw.listPriceChange);
  const statusKey = strOf(raw.statusKey);
  return {
    tenureForm: strOf(raw.tenureForm),
    avgiftMonthlySek: positive(numOf(raw.rent)),
    operatingCostMonthlySek: positive(numOf(raw.operatingCost)),
    constructionYear: year !== null && Number.isInteger(year) && year >= 1600 && year <= 2100 ? year : null,
    floor: numOf(raw.floor),
    // 0 -> 0, never -0: a Booli value of 0 is "no change", not a tiny cut.
    priceCutSek: listPriceChange === null ? null : listPriceChange === 0 ? 0 : -listPriceChange,
    listPricePercentageDiff: numOf(raw.listPricePercentageDiff),
    biddingOpen: boolOf(raw.biddingOpen) ?? (statusKey === "biddingOpen" ? true : null),
    statusKey,
    brfName: strOf(raw.brfName),
    brfId: strOf(raw.brfId),
    isNewConstruction: typeof raw.isNewConstruction === "boolean" ? raw.isNewConstruction : null,
  };
}

/**
 * Facts from a reshaped search card (`fetchAreaListings` output). Amenities a card omits
 * stay null, never false (R-04b); the listing age comes from the card wording. Pure.
 */
export function factsFromCard(raw: Raw): CandidateFacts {
  const amenities = amenityKeysOf(raw.amenities);
  const days = daysOnMarketFromText(strOf(raw.displayDate));
  return candidateFactsSchema.parse({
    ...commonFacts(raw),
    elevatorListed: amenities?.includes("elevator") ? true : null,
    balcony: amenities?.includes("balcony") || raw.balcony === true ? true : null,
    daysOnMarket: days,
    daysOnMarketSource: days === null ? null : "card-text",
    detailFetched: false,
  });
}

/**
 * Facts from a reshaped detail page (`fetchListing` output). A detail page lists every
 * amenity, so a missing balcony or elevator is false. The listing age is counted in whole
 * days from Booli's publish date to `opts.asOf`; without a usable publish date the card
 * wording is used if the record has it. Pure.
 */
export function factsFromDetail(raw: Raw, opts: { asOf: string }): CandidateFacts {
  const amenities = amenityKeysOf(raw.amenities);
  const publishedText = strOf(raw.published);
  const publishedDay = publishedText === null ? null : dayNumber(publishedText);
  const asOfDay = dayNumber(opts.asOf);
  const publishedAt = publishedDay === null || publishedText === null ? null : publishedText.slice(0, 10);

  let daysOnMarket: number | null = null;
  let source: (typeof DAYS_ON_MARKET_SOURCES)[number] | null = null;
  if (publishedDay !== null && asOfDay !== null && asOfDay >= publishedDay) {
    daysOnMarket = Math.floor(asOfDay - publishedDay);
    source = "published";
  } else {
    const fromText = daysOnMarketFromText(strOf(raw.displayDate));
    if (fromText !== null) {
      daysOnMarket = fromText;
      source = "card-text";
    }
  }

  return candidateFactsSchema.parse({
    ...commonFacts(raw),
    elevatorListed: amenities === null ? null : amenities.includes("elevator"),
    balcony: amenities === null ? (raw.balcony === true ? true : null) : amenities.includes("balcony") || raw.balcony === true,
    publishedAt,
    daysOnMarket,
    daysOnMarketSource: source,
    detailFetched: true,
  });
}

/**
 * Merges a card's facts with a detail page's: the detail value wins where it has one
 * (including a detail `false`), the card fills the rest. The listing age and its source
 * travel together, and `detailFetched` comes from the detail. Returns a new record; the
 * inputs are not touched. Pure.
 */
export function mergeFacts(card: CandidateFacts, detail: CandidateFacts): CandidateFacts {
  const out: Record<string, unknown> = {};
  for (const key of FACT_KEYS) {
    out[key] = detail[key] !== null ? detail[key] : card[key];
  }
  const ageFromDetail = detail.daysOnMarket !== null;
  out.daysOnMarket = ageFromDetail ? detail.daysOnMarket : card.daysOnMarket;
  out.daysOnMarketSource = ageFromDetail ? detail.daysOnMarketSource : card.daysOnMarketSource;
  out.detailFetched = detail.detailFetched;
  return candidateFactsSchema.parse(out);
}
