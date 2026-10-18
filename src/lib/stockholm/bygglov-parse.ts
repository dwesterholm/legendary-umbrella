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
    }
  | { readonly ok: false; readonly reason: ParseFailure };

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
  if (model === null) return { ok: false, reason: "shape" };
  const checked = listSchema.safeParse(model);
  if (!checked.success) return { ok: false, reason: "shape" };

  const rows = checked.data.BuildCases.CaseSearchDetails.map(toRow);
  const otherRows = checked.data.OtherCases.CaseSearchDetails.map(toRow);

  const { visar, traffar } = headingCounts(html);
  if ((visar !== null && visar !== rows.length) || (traffar !== null && traffar !== rows.length)) {
    return { ok: false, reason: "count" };
  }
  return { ok: true, rows, otherRows, headingCount: visar ?? traffar };
}

/** Rows whose beteckning equals the asked one: case-insensitive, trimmed, inner whitespace collapsed. */
export function exactMatchRows<T extends { readonly beteckning: string }>(rows: readonly T[], beteckning: string): T[] {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLocaleLowerCase("sv");
  const wanted = norm(beteckning);
  return rows.filter((row) => norm(row.beteckning) === wanted);
}
