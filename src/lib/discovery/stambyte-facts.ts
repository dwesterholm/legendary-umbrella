/**
 * stambyte-facts.ts - which source wins when the city, the annual report and the broker text disagree
 * about a stambyte, and the one cell-ready answer that follows (Phase 14.6, STAM-03, D-07, R-06).
 *
 * PURE, synchronous - no file system, network, clock, randomness or SDK. Three small readings come in
 * (the city's case list for the building, the annual-report enum, the broker-text reading), one set of
 * facts goes out. Only years, booleans and enum labels leave this module.
 *
 * PRECEDENCE (D-07): per field, `bygglov_stockholm` > `arsredovisning` > `maklartext`, and a source wins
 * only with a POSITIVE finding. A city list that shows no stambyte case says nothing about a building
 * whose broker or annual report names one (the city list is thin after 2011 and starts at the
 * building's first recorded case), so "nothing found" never erases a claim from another source.
 *
 * STATUS: `pagar` over `planerat` over `genomfort`. "Done in the past" and "planned in the future" can
 * both be true of one building, and the status names the one a buyer should hear about first. The
 * annual-report enum has no year, so `planerat` from the report gives a status and a source and no
 * planned year; `nyligen_genomfort` gives `genomfort` and no completed year; `ej_nämnt` means the
 * report does not mention stambyte at all and gives nothing.
 *
 * COST OF BEING WRONG: this decides which words appear in the Stambyte column and in a reason line. It
 * never touches the fit score, the taste term, the flags or the model (D-12): the registered prefix
 * "discovery/stambyte-" in `niche-score.test.ts` keeps `niche-score.ts` and `report/flags.ts` from
 * importing it.
 */

import type { StambyteTextFacts } from "@/lib/discovery/stambyte-text";

/** Where a stambyte fact comes from, strongest first. */
export const STAMBYTE_SOURCES = ["bygglov_stockholm", "arsredovisning", "maklartext"] as const;
export type StambyteSource = (typeof STAMBYTE_SOURCES)[number];

/** The state of the building's stambyte as the column shows it. */
export const STAMBYTE_STATUSES = ["genomfort", "pagar", "planerat"] as const;
export type StambyteStatus = (typeof STAMBYTE_STATUSES)[number];

/**
 * What the city's case list says about one building (the shape `buildingFactsOf` in
 * `stockholm/bygglov-classify.ts` returns; a larger object with more fields fits). `null` = the city
 * list was not read for this building.
 */
export interface CityStambyteReading {
  readonly lastStambyteYear: number | null;
  readonly lastStambyteBasis: "slutbesked" | "start" | null;
  readonly stambyteOngoing: boolean | null;
  readonly reliningCase: boolean;
}

/**
 * The annual-report values `brf.stambytePlanerat` holds (`src/lib/brf/extract.ts`). Note the spelling
 * `nyligen_genomfort` without "ö". A `Map`, never an object literal: the value is read from stored JSON,
 * and an object-literal lookup keyed by an arbitrary string walks the prototype chain ("toString"
 * would return a function). `Map.get` has no chain to fall through (T-14.6-73; the same reason as
 * `STAMBYTE_PROSE` in `confounder-guard.ts`).
 */
const ANNUAL_REPORT_STATUS: ReadonlyMap<string, StambyteStatus | null> = new Map<string, StambyteStatus | null>([
  ["planerat", "planerat"],
  ["nyligen_genomfort", "genomfort"],
  ["ej_nämnt", null],
]);

/**
 * The status an annual-report value stands for, or `null` for "ej_nämnt", for `null`/`undefined` and
 * for anything that is not one of the three enum strings. The report gives a status and never a year.
 */
export function stambyteFromAnnualReport(value: unknown): StambyteStatus | null {
  if (typeof value !== "string") return null;
  return ANNUAL_REPORT_STATUS.get(value) ?? null;
}

/** The merged facts, ready for the Stambyte column and the reason line. */
export interface StambyteFacts {
  /** The latest completed stambyte year: the city's, else the broker's. The report has no year. */
  readonly lastStambyteYear: number | null;
  /** The planned year, only from the broker text (the city and the report give none). */
  readonly plannedStambyteYear: number | null;
  /** True: a stambyte is under way (city or text). False: a source was read and says no. Null: nothing read. */
  readonly stambyteOngoing: boolean | null;
  /** The source of the field the status came from. Null when there is no status. */
  readonly stambyteSource: StambyteSource | null;
  readonly stambyteStatus: StambyteStatus | null;
  /** True: the city or the text mentions relining. Relining is never a stambyte. */
  readonly reliningMentioned: boolean | null;
}

export interface MergeStambyteInput {
  readonly city: CityStambyteReading | null;
  /** The raw `brf.stambytePlanerat` value (or `null`). Anything outside the enum counts as nothing. */
  readonly report: unknown;
  readonly text: StambyteTextFacts | null;
}

/**
 * Merge the three sources by precedence.
 *
 * Per status, the winning source is the strongest one with a positive finding:
 * - `pagar`: the city shows a stambyte with a startbesked and no slutbesked, else the text says it is under way.
 * - `planerat`: the annual report says planned, else the text names a planned year.
 * - `genomfort`: the city has a completed year, else the report says recently done, else the text has a year.
 *
 * The status is the first of `pagar`, `planerat`, `genomfort` that has a winner. The two years are
 * independent fields and can both be set.
 */
export function mergeStambyte(input: MergeStambyteInput): StambyteFacts {
  const { city, text } = input;
  const reportStatus = stambyteFromAnnualReport(input.report);

  const cityYear = city?.lastStambyteYear ?? null;
  const textYear = text?.lastYear ?? null;
  const lastStambyteYear = cityYear ?? textYear;
  const plannedStambyteYear = text?.plannedYear ?? null;

  const ongoingSource: StambyteSource | null =
    city?.stambyteOngoing === true ? "bygglov_stockholm" : text?.ongoing === true ? "maklartext" : null;
  const plannedSource: StambyteSource | null =
    reportStatus === "planerat" ? "arsredovisning" : plannedStambyteYear !== null ? "maklartext" : null;
  const doneSource: StambyteSource | null =
    cityYear !== null
      ? "bygglov_stockholm"
      : reportStatus === "genomfort"
        ? "arsredovisning"
        : textYear !== null
          ? "maklartext"
          : null;

  let stambyteStatus: StambyteStatus | null = null;
  let stambyteSource: StambyteSource | null = null;
  if (ongoingSource) {
    stambyteStatus = "pagar";
    stambyteSource = ongoingSource;
  } else if (plannedSource) {
    stambyteStatus = "planerat";
    stambyteSource = plannedSource;
  } else if (doneSource) {
    stambyteStatus = "genomfort";
    stambyteSource = doneSource;
  }

  const stambyteOngoing =
    ongoingSource !== null ? true : city?.stambyteOngoing === false || text?.ongoing === false ? false : null;
  const reliningMentioned =
    text?.relining === true || city?.reliningCase === true ? true : text?.relining === false || city ? false : null;

  return { lastStambyteYear, plannedStambyteYear, stambyteOngoing, stambyteSource, stambyteStatus, reliningMentioned };
}
