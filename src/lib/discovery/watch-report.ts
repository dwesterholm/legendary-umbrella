/**
 * watch-report.ts - the weekly mail body, as pure functions (Phase 14.2, WATCH-05,
 * D-15, R-01): rows and a memory diff in, an HTML string and a plain-text string out.
 *
 * PURE: no file, clock, environment or network access. The date, the header lines
 * and the counts come in as arguments. The two things that send or save the result
 * live elsewhere (`watch-mail.ts` for SMTP, `scripts/fit-score.ts` for the file),
 * so everything here can be tested with plain strings.
 *
 * WHAT THE MAIL CONTAINS: the same two sections as the printed table ("Förväntat
 * under 4 M" first, "Över 4 M förväntat" second), in the table's own order (profit
 * descending, then Booli id ascending). The first mail after an empty memory
 * carries the top {@link WATCH_FIRST_MAIL_PER_SECTION} rows of each section (R-01);
 * every later mail carries only rows that are new or whose asking price changed.
 *
 * STATUS WORDING (W2, D-15), exactly:
 *   - a new row:           "nya sedan förra veckan"
 *   - a price-changed row: "prisändrad (<old> → <new>)", e.g. "prisändrad (3 995 000 → 3 795 000)"
 * The HTML and the text alternative use the same two labels (see {@link statusLabel}).
 *
 * MONEY: whole kronor, a plain space between thousand groups, an ASCII hyphen for
 * a minus sign (never U+2212), and -0 printed as 0 ({@link formatKr}, review IN-06).
 *
 * SAFETY (T-14.2-10): every dynamic string goes through {@link escapeHtml} (addresses,
 * BRF-derived reasons, picture-derived text). Only https links on booli.se become
 * anchors; any other link is shown as escaped text. The HTML has inline styles only:
 * no images, no scripts, no remote content, so opening it loads nothing.
 */

import { FIT_SECTION_TITLES, splitFitSections, type FitTableRow } from "@/lib/discovery/fit-pipeline";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Escapes the five characters that matter in HTML text and attribute values: & < > " ' */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Whole kronor with a space as thousands separator and ASCII digits and hyphen. `null` and
 * non-finite numbers print "-". A value that rounds to zero prints "0", never "-0".
 */
export function formatKr(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  const rounded = Math.round(value) || 0; // `|| 0` turns -0 into 0
  const digits = Math.abs(rounded)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return rounded < 0 ? `-${digits}` : digits;
}

// ---------------------------------------------------------------------------
// Choosing the rows
// ---------------------------------------------------------------------------

/** One row of the mail: the table row, why it is in the mail, and the old price for a changed row. */
export interface MailRow {
  readonly row: FitTableRow;
  readonly status: "new" | "changed";
  /** The asking price before the change (whole kronor), null for a new row. */
  readonly oldAskingKr: number | null;
}

export interface MailSections {
  readonly under: MailRow[];
  readonly over: MailRow[];
}

/** What {@link selectMailRows} needs from the memory diff (structurally satisfied by `DiffResult<FitTableRow>`). */
export interface MailDiff {
  readonly newRows: readonly FitTableRow[];
  readonly changedRows: readonly { readonly row: FitTableRow; readonly oldSek: number; readonly newSek: number }[];
}

/**
 * Picks the rows for the mail, grouped by section, in the table's order.
 *
 * First run (R-01): the top `perSectionFirstRun` rows of each section, all marked "new".
 * Later runs: the rows the diff calls new or price-changed. The diff's rows must be the same
 * objects as the ones in `rows` (identity, not a lookup key, so this module needs no key logic).
 */
export function selectMailRows(opts: {
  rows: readonly FitTableRow[];
  diff: MailDiff;
  firstRun: boolean;
  perSectionFirstRun: number;
}): MailSections {
  const sections = splitFitSections(opts.rows);
  if (opts.firstRun) {
    const take = (part: readonly FitTableRow[]): MailRow[] =>
      part.slice(0, opts.perSectionFirstRun).map((row) => ({ row, status: "new" as const, oldAskingKr: null }));
    return { under: take(sections.under), over: take(sections.over) };
  }
  const isNew = new Set<FitTableRow>(opts.diff.newRows);
  const changed = new Map<FitTableRow, number>(opts.diff.changedRows.map((c) => [c.row, c.oldSek] as const));
  const pick = (part: readonly FitTableRow[]): MailRow[] => {
    const out: MailRow[] = [];
    for (const row of part) {
      const old = changed.get(row);
      if (old !== undefined) out.push({ row, status: "changed", oldAskingKr: old });
      else if (isNew.has(row)) out.push({ row, status: "new", oldAskingKr: null });
    }
    return out;
  };
  return { under: pick(sections.under), over: pick(sections.over) };
}

/** W2 / D-15: the status cell of a mail row. Used verbatim by the HTML and the text alternative. */
export function statusLabel(entry: Pick<MailRow, "status" | "oldAskingKr"> & { row: Pick<FitTableRow, "askingKr"> }): string {
  if (entry.status === "new") return "nya sedan förra veckan";
  return `prisändrad (${formatKr(entry.oldAskingKr)} → ${formatKr(entry.row.askingKr)})`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface WatchMailInput {
  /** YYYY-MM-DD. */
  readonly date: string;
  readonly sections: MailSections;
  readonly header: {
    /** "Kandidatlista: komplett" or "Kandidatlista: OFULLSTÄNDIG (...)" as the area report printed it. */
    readonly completeness: string;
    /** True when the candidate list is not complete: the line is shown in red and bold. */
    readonly incomplete: boolean;
    /** The "Täckning (...)" line. */
    readonly coverageLine: string;
    /** The "Modell per ..." line. */
    readonly modelLine: string;
    /** An optional extra line, e.g. the first-mail explanation. */
    readonly note?: string | null;
  };
  readonly counts: { readonly nNew: number; readonly nChanged: number };
}

/** The mail subject, short on purpose: "Bostadsbevakning 2026-10-20: 3 nya, 1 prisändrade". */
export function watchSubject(date: string, nNew: number, nChanged: number): string {
  return `Bostadsbevakning ${date}: ${nNew} nya, ${nChanged} prisändrade`;
}

/** The column headings, in order (D-15). */
const COLUMNS = [
  "Status",
  "Adress",
  "Område",
  "kvm",
  "vån",
  "Utgångspris",
  "Budpremie",
  "Förv. slutpris",
  "Värde renoverad",
  "Skillnad",
  "Reno (nivå, spann)",
  "Vinst",
  "Smak",
  "Sol",
  "Soltim. fri (mar/jun/dec)",
  "Soltim. med grannhus (mar/jun/dec)",
  "Korsdrag",
  "Sovrum",
  "Flaggor",
  "Varför här",
  "Booli",
] as const;

/** Columns whose cells are numbers (right-aligned). */
const NUMERIC = new Set<string>(["kvm", "vån", "Utgångspris", "Förv. slutpris", "Värde renoverad", "Skillnad", "Vinst", "Smak"]);

const renoText = (r: FitTableRow): string =>
  `${r.renoTier} ${formatKr(r.renoMidKr)} (${formatKr(r.renoLowKr)}–${formatKr(r.renoHighKr)})`;

/** Local, pure check: https and a booli.se host. The mail module must not pull in any transport. */
function booliHref(link: string): string | null {
  try {
    const url = new URL(link);
    if (url.protocol !== "https:") return null;
    if (url.hostname !== "booli.se" && !url.hostname.endsWith(".booli.se")) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** The cell texts of one mail row as plain strings (not yet escaped), in {@link COLUMNS} order, the link last. */
function plainCells(entry: MailRow): string[] {
  const r = entry.row;
  return [
    statusLabel(entry),
    r.address,
    r.district,
    r.kvm === null ? "-" : String(r.kvm),
    r.floor === null ? "-" : String(r.floor),
    formatKr(r.askingKr),
    r.budpremie,
    formatKr(r.expectedFinalKr),
    formatKr(r.resaleKr),
    formatKr(r.gapKr),
    renoText(r),
    formatKr(r.profitKr),
    formatKr(r.tasteKr),
    r.sol,
    r.solTheoretical,
    r.solObstructed,
    r.korsdrag,
    r.sovrum,
    r.flags.join(", ") || "-",
    r.reasons,
    r.link,
  ];
}

const TD = "padding:4px 8px;border:1px solid #cccccc;vertical-align:top;";
const TH = "padding:4px 8px;border:1px solid #cccccc;background:#f0f0f0;text-align:left;white-space:nowrap;";

function htmlRow(entry: MailRow): string {
  const cells = plainCells(entry);
  const tds = cells.map((cell, i) => {
    const column = COLUMNS[i];
    const align = NUMERIC.has(column) ? "text-align:right;white-space:nowrap;" : "";
    if (column === "Booli") {
      const href = booliHref(cell);
      const inner = href === null ? escapeHtml(cell) : `<a href="${escapeHtml(href)}">Booli</a>`;
      return `<td style="${TD}">${inner}</td>`;
    }
    return `<td style="${TD}${align}">${escapeHtml(cell)}</td>`;
  });
  return `<tr>${tds.join("")}</tr>`;
}

function htmlSection(title: string, part: readonly MailRow[]): string {
  const heading = `<h2 style="font-size:16px;margin:24px 0 8px;">${escapeHtml(title)} (${part.length} annonser)</h2>`;
  if (part.length === 0) return `${heading}\n<p style="margin:0;">Inga annonser.</p>`;
  const head = `<tr>${COLUMNS.map((c) => `<th style="${TH}">${escapeHtml(c)}</th>`).join("")}</tr>`;
  return `${heading}\n<table style="border-collapse:collapse;font-size:13px;">\n${head}\n${part.map(htmlRow).join("\n")}\n</table>`;
}

/**
 * The HTML mail: a header (date, counts, candidate-list completeness, coverage, model), then the two
 * sections. Plain table layout with inline styles; no images and no remote content.
 */
export function renderWatchHtml(input: WatchMailInput): string {
  const { header } = input;
  const completeness = header.incomplete
    ? `<p style="margin:4px 0;color:#b00020;font-weight:bold;">${escapeHtml(header.completeness)}</p>`
    : `<p style="margin:4px 0;">${escapeHtml(header.completeness)}</p>`;
  const lines = [
    `<h1 style="font-size:20px;margin:0 0 8px;">${escapeHtml(watchSubject(input.date, input.counts.nNew, input.counts.nChanged))}</h1>`,
    completeness,
    `<p style="margin:4px 0;">${escapeHtml(header.coverageLine)}</p>`,
    `<p style="margin:4px 0;">${escapeHtml(header.modelLine)}</p>`,
  ];
  if (header.note) lines.push(`<p style="margin:4px 0;">${escapeHtml(header.note)}</p>`);
  return [
    "<!doctype html>",
    '<html lang="sv">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(watchSubject(input.date, input.counts.nNew, input.counts.nChanged))}</title>`,
    "</head>",
    '<body style="font-family:Arial,Helvetica,sans-serif;color:#222222;margin:16px;">',
    ...lines,
    htmlSection(FIT_SECTION_TITLES.under, input.sections.under),
    htmlSection(FIT_SECTION_TITLES.over, input.sections.over),
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function textSection(title: string, part: readonly MailRow[]): string {
  const lines = [`${title} (${part.length} annonser)`];
  if (part.length === 0) {
    lines.push("Inga annonser.");
    return lines.join("\n");
  }
  lines.push(COLUMNS.join(" | "));
  for (const entry of part) lines.push(plainCells(entry).join(" | "));
  return lines.join("\n");
}

/** The plain-text alternative: the same header lines and rows, with the same status labels, pipe-separated. */
export function renderWatchText(input: WatchMailInput): string {
  const { header } = input;
  const lines = [watchSubject(input.date, input.counts.nNew, input.counts.nChanged), header.completeness, header.coverageLine, header.modelLine];
  if (header.note) lines.push(header.note);
  return `${[
    lines.join("\n"),
    textSection(FIT_SECTION_TITLES.under, input.sections.under),
    textSection(FIT_SECTION_TITLES.over, input.sections.over),
  ].join("\n\n")}\n`;
}
