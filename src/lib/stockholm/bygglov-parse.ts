/**
 * bygglov-parse.ts - the city's saved case pages as typed, name-free records
 * (Phase 14.6, CASE-02, D-03, R-01).
 *
 * PURE, synchronous - no file system, network, clock or randomness. A page's HTML text comes in,
 * a typed result (or a typed failure) goes out. The fetching lives in a later module; this one
 * only reads text it is handed.
 *
 * WHAT IT READS (R-01): the city's Bygg- och plantjänsten pages embed their data as JSON. The
 * list page carries `var CaseSearchResultsViewModel = {...};` (all rows in one response, no
 * server-side paging), the detail page `const caseViewModel = JSON.parse("...");`. This module
 * parses that JSON and never the visible HTML list. cheerio is used only to reach the script
 * text and the attribute values.
 *
 * FAILS LOUDLY (T-14.6-02): a missing marker, a row that does not fit the schema, or a heading
 * count that differs from the array length is a typed failure (`shape` / `count`), never a
 * guess. The caller records it and stops.
 *
 * PII RULE (D-03, T-14.6-01): the officer's name (`Handler`, and the Handläggare line), the
 * `Documents` list and the free ärendemening never leave this module except the one-line
 * description handed to the classifier in memory. Every result is built field by field from a
 * zod schema that lists ONLY the fields read; a key that is not listed cannot ride along.
 *
 * STRUCTURAL SEPARATION (LOCKED, D-12): like `taste.ts` and `ceiling-height.ts`, this module
 * sits beside the ranking path. `niche-score.ts` and `report/flags.ts` must NEVER import it;
 * the static-grep invariant in `niche-score.test.ts` enforces that and the "stockholm/" prefix
 * is registered there (in an earlier commit than this file).
 */
import * as cheerio from "cheerio";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One row of the list page, reduced to what the pipeline may use. `description` is for the classifier only. */
export interface CaseListRow {
  /** Digits only, 1 to 12 of them. */
  readonly rec: string;
  readonly caseType: string;
  /** The free ärendemening. Handed to the classifier in memory and then dropped, never stored. */
  readonly description: string | null;
  /** YYYY-MM-DD. */
  readonly startDate: string;
  /** The fastighetsbeteckning the city lists the case under ("Droskhästen 8"). */
  readonly beteckning: string;
  /** Street addresses of the case; empty when the city lists none. */
  readonly addresses: readonly string[];
  /** The diarienummer, limited to [0-9A-Za-z/ -] and 20 characters. */
  readonly diarie: string;
  readonly archived: boolean;
}

/** Why a page could not be read. `login` and `terms` need a missing view model and a matching marker. */
export type ParseFailure = "shape" | "count" | "login" | "terms";

export type CaseListResult =
  | {
      readonly ok: true;
      readonly rows: readonly CaseListRow[];
      readonly otherRows: readonly CaseListRow[];
      /** The N of the build-case heading, or null when the page has no heading to compare. */
      readonly headingCount: number | null;
      /** Anchor TEXTS (never an href) that look like terms of use. Empty on every saved page; the spike reports it. */
      readonly termsLinks: readonly string[];
    }
  | { readonly ok: false; readonly reason: ParseFailure };

/** One decision on a case, as the city words it. `type` and `code` stay open strings (unknown ones are counted by the caller). */
export interface CaseDecision {
  /** YYYY-MM-DD, or null when the city gives none. */
  readonly date: string | null;
  readonly type: string;
  readonly code: string | null;
}

export interface CaseEstate {
  readonly beteckning: string;
  readonly address: string | null;
  readonly district: string | null;
}

/** A case detail page reduced to facts: no officer, no document list, no free text. */
export interface CaseDetail {
  /** Digits, or null: archived cases carry no RecNo in their view model (the caller knows it from the URL it asked for). */
  readonly rec: string | null;
  readonly diarie: string;
  readonly startDate: string | null;
  readonly closedDate: string | null;
  readonly estates: readonly CaseEstate[];
  /** Every decision, oldest first. */
  readonly decisions: readonly CaseDecision[];
}

export type CaseDetailResult =
  | { readonly ok: true; readonly detail: CaseDetail }
  | { readonly ok: false; readonly reason: ParseFailure };

/** One entry of the address search answer. `value` is the fastighetsbeteckning. */
export interface AddressOption {
  readonly text: string;
  readonly value: string;
}

// ---------------------------------------------------------------------------
// The embedded list view model
// ---------------------------------------------------------------------------

const LIST_MARK = "var CaseSearchResultsViewModel =";

/**
 * The parsed `CaseSearchResultsViewModel` of a list page, or null when the marker is missing or
 * the JSON does not parse (the page changed or is not a result page).
 */
export function listViewModel(html: string): unknown | null {
  const $ = cheerio.load(html);
  for (const el of $("script").toArray()) {
    const text = $(el).text();
    const at = text.indexOf(LIST_MARK);
    if (at < 0) continue;
    const rest = text.slice(at + LIST_MARK.length);
    const end = rest.lastIndexOf(";");
    try {
      return JSON.parse(end >= 0 ? rest.slice(0, end) : rest);
    } catch {
      return null;
    }
  }
  return null;
}

/** Keeps only the diarienummer characters the later mail and cache may carry (T-14.6-04). */
const diarieOf = (raw: string): string => raw.replace(/[^0-9A-Za-z/ -]/g, "").slice(0, 20);

/** "a, b", "a,b" and the escaped "a\, b" all split; empties are dropped. */
const addressesOf = (raw: string | null): string[] =>
  (raw ?? "")
    .split(/\\?,/)
    .map((part) => part.replace(/\\/g, "").trim())
    .filter((part) => part.length > 0);

// Lists only the fields read. zod strips every other key, so a field that is not named here
// (there is none that is personal on the list page, but the same rule holds as for the detail
// page) cannot reach the result.
const rowSchema = z.object({
  RecNo: z.string().regex(/^\d{1,12}$/),
  CaseTypeCode: z.string().max(80),
  Description: z.string().nullable(),
  StartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  RealEstateName: z.string().max(80),
  RealEstateAddress: z.string().nullable(),
  Name: z.string().max(60),
  IsEarchive: z.boolean(),
});

const casesSchema = z.object({ CaseSearchDetails: z.array(rowSchema) });

const listSchema = z.object({
  BuildCases: casesSchema,
  OtherCases: casesSchema,
  HasSearched: z.literal(true),
});

type RawRow = z.infer<typeof rowSchema>;

/** Built field by field, so nothing but these keys exists on a row. */
function toRow(raw: RawRow): CaseListRow {
  return {
    rec: raw.RecNo,
    caseType: raw.CaseTypeCode,
    description: raw.Description,
    startDate: raw.StartDate.slice(0, 10),
    beteckning: raw.RealEstateName.trim(),
    addresses: addressesOf(raw.RealEstateAddress),
    diarie: diarieOf(raw.Name),
    archived: raw.IsEarchive,
  };
}

// ---------------------------------------------------------------------------
// Page markers: why a page without a view model is not a result page
// ---------------------------------------------------------------------------

const LOGIN_WORDS = /logga\s{1,3}in|bankid|e-?legitimation/i;
const TERMS_WORDS = /användarvillkor|villkor\s{1,3}för\s{1,3}användning/i;
const TERMS_ANCHOR = /villkor|terms\s{1,3}of\s{1,3}use/i;
const MARKER_TEXT_MAX = 20_000;
const TERMS_TEXT_MAX = 60;

/**
 * Whether a page asks for a login (the words sit in a form or in the main heading) or shows terms
 * of use. Read only when the view model is missing: a normal result page may well carry a "Logga in"
 * link in its header.
 */
export function pageMarkers(html: string): { login: boolean; terms: boolean } {
  const $ = cheerio.load(html);
  $("script, style").remove();
  const loginText = `${$("form").text()} ${$("h1").text()}`.slice(0, MARKER_TEXT_MAX);
  const bodyText = $("body").text().slice(0, MARKER_TEXT_MAX * 5);
  return { login: LOGIN_WORDS.test(loginText), terms: TERMS_WORDS.test(bodyText) };
}

/** The reason a page without a view model gives: login first, then terms, else the page simply changed. */
function missingModelReason(html: string): ParseFailure {
  const markers = pageMarkers(html);
  if (markers.login) return "login";
  if (markers.terms) return "terms";
  return "shape";
}

/**
 * The text of every anchor that looks like terms of use ("Användarvillkor"), each cut to 60
 * characters and de-duplicated. The href is never read, so a link target cannot be stored or followed.
 */
export function termsLinks(html: string): string[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  for (const el of $("a").toArray()) {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text.length > 0 && TERMS_ANCHOR.test(text)) seen.add(text.slice(0, TERMS_TEXT_MAX));
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// The heading count
// ---------------------------------------------------------------------------

// "Byggärenden  (Visar 1-50 av 53)" sits in the list component's data-props (cheerio decodes the
// entities); "Byggärenden (53 träffar)" is the tab button. Both are bounded patterns.
const HEADING_VISAR = /Byggärenden\s{1,4}\(Visar\s{1,3}\d{1,7}\s{0,3}-\s{0,3}\d{1,7}\s{1,3}av\s{1,3}(\d{1,7})\)/u;
const HEADING_TRAFFAR = /Byggärenden\s{1,4}\((\d{1,7})\s{1,3}träffar\)/u;

/** The two counts the page itself states for the build list; each is null when the page does not say. */
function headingCounts(html: string): { visar: number | null; traffar: number | null } {
  const $ = cheerio.load(html);
  let visar: number | null = null;
  let traffar: number | null = null;
  for (const el of $("[data-props]").toArray()) {
    const head = ($(el).attr("data-props") ?? "").slice(0, 400);
    const hit = HEADING_VISAR.exec(head);
    if (hit) {
      visar = Number(hit[1]);
      break;
    }
  }
  for (const el of $("button, [role='tab']").toArray()) {
    const hit = HEADING_TRAFFAR.exec($(el).text().replace(/\s+/g, " ").trim().slice(0, 200));
    if (hit) {
      traffar = Number(hit[1]);
      break;
    }
  }
  return { visar, traffar };
}

// ---------------------------------------------------------------------------
// The list page
// ---------------------------------------------------------------------------

/**
 * The cases of a list page (a beteckning search or an extended search).
 *
 * `ok: false` with `shape` when the view model is missing or does not fit the schema, with
 * `count` when a heading count differs from the array length (a hidden server-side cap).
 */
export function parseCaseList(html: string): CaseListResult {
  const model = listViewModel(html);
  if (model === null) return { ok: false, reason: missingModelReason(html) };
  const checked = listSchema.safeParse(model);
  if (!checked.success) return { ok: false, reason: "shape" };

  const rows = checked.data.BuildCases.CaseSearchDetails.map(toRow);
  const otherRows = checked.data.OtherCases.CaseSearchDetails.map(toRow);

  const { visar, traffar } = headingCounts(html);
  if ((visar !== null && visar !== rows.length) || (traffar !== null && traffar !== rows.length)) {
    return { ok: false, reason: "count" };
  }
  return { ok: true, rows, otherRows, headingCount: visar ?? traffar, termsLinks: termsLinks(html) };
}

/** Rows whose beteckning equals the asked one: case-insensitive, trimmed, inner whitespace collapsed. */
export function exactMatchRows<T extends { readonly beteckning: string }>(rows: readonly T[], beteckning: string): T[] {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLocaleLowerCase("sv");
  const wanted = norm(beteckning);
  return rows.filter((row) => norm(row.beteckning) === wanted);
}

// ---------------------------------------------------------------------------
// The detail page
// ---------------------------------------------------------------------------

const DETAIL_SCRIPT_MAX = 2_000_000;
const DETAIL_PATTERN = /const caseViewModel =\s*JSON\.parse\(("(?:[^"\\]|\\.)*")\)/;

/**
 * The parsed `caseViewModel` of a detail page (a JSON string literal holding JSON, so it is parsed
 * twice), or null when the marker is missing or either parse fails.
 */
export function detailViewModel(html: string): unknown | null {
  const $ = cheerio.load(html);
  for (const el of $("script").toArray()) {
    const text = $(el).text();
    if (text.length > DETAIL_SCRIPT_MAX) continue;
    const match = DETAIL_PATTERN.exec(text);
    if (!match) continue;
    try {
      return JSON.parse(JSON.parse(match[1]) as string);
    } catch {
      return null;
    }
  }
  return null;
}

// Lists ONLY the fields read. `Handler` (the officer's name), `Documents` (titles can name people),
// `Group` and `Definition` (the free ärendemening) are deliberately absent: zod drops every key it
// is not told about, and the result below is built field by field besides (V8, T-14.6-01).
const detailSchema = z.object({
  CaseDetails: z.object({
    RecNo: z.string().regex(/^\d{1,12}$/).nullable(),
    Name: z.string().max(60),
    StartDate: z.string().nullable(),
    ClosedDate: z.string().nullable(),
    Estates: z.array(
      z.object({
        Name: z.string().max(80),
        Address: z.string().max(120).nullable(),
        District: z.string().max(60).nullable(),
      }),
    ),
  }),
  Decisions: z.array(
    z.object({
      DecisionDate: z.string().nullable(),
      Code: z.string().nullable(),
      Type: z.string().nullable(),
    }),
  ),
});

const DECISION_TEXT_MAX = 80;

/** "2023-03-15T00:00:00" is 2023-03-15; anything else is null. */
const dayOf = (raw: string | null): string | null => (raw !== null && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null);

/**
 * A case detail page: the diarienummer, dates, estates and EVERY decision from the embedded array
 * (the visible "Senaste beslut" list shows only the latest two).
 */
export function parseCaseDetail(html: string): CaseDetailResult {
  const model = detailViewModel(html);
  if (model === null) return { ok: false, reason: missingModelReason(html) };
  const checked = detailSchema.safeParse(model);
  if (!checked.success) return { ok: false, reason: "shape" };

  const { CaseDetails: c, Decisions: decisions } = checked.data;
  return {
    ok: true,
    detail: {
      rec: c.RecNo,
      diarie: diarieOf(c.Name),
      startDate: dayOf(c.StartDate),
      closedDate: dayOf(c.ClosedDate),
      estates: c.Estates.map((e) => ({ beteckning: e.Name.trim(), address: e.Address, district: e.District })),
      decisions: decisions
        .map((d) => ({
          date: dayOf(d.DecisionDate),
          type: (d.Type ?? "").trim().slice(0, DECISION_TEXT_MAX),
          code: d.Code === null ? null : d.Code.trim().slice(0, DECISION_TEXT_MAX),
        }))
        .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "")),
    },
  };
}

// ---------------------------------------------------------------------------
// The address search fragment
// ---------------------------------------------------------------------------

const addressSchema = z.object({
  options: z.array(z.object({ text: z.string().max(200), value: z.string().max(100) })),
});

/**
 * The options of the city's "address to fastighetsbeteckning" answer: an HTML fragment whose select
 * component carries them as JSON in `data-props`. The empty "Välj fastighet" placeholder is dropped
 * and HTML entities are decoded. Null when the fragment has no select list (an unknown address shows
 * an alert instead, or the page changed); the caller treats both as unresolved.
 */
export function parseAddressFragment(html: string): AddressOption[] | null {
  const $ = cheerio.load(html);
  for (const el of $("[data-type='select'][data-props]").toArray()) {
    let props: unknown;
    try {
      props = JSON.parse($(el).attr("data-props") ?? "");
    } catch {
      continue;
    }
    const checked = addressSchema.safeParse(props);
    if (!checked.success) continue;
    return checked.data.options.filter((o) => o.value.trim() !== "").map((o) => ({ text: o.text, value: o.value }));
  }
  return null;
}
