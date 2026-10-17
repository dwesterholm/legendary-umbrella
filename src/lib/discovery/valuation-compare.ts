/**
 * valuation-compare.ts - the 14.4 -> 14.5 valuation comparison (Phase 14.5-03, ENR-02, R-02).
 *
 * Takes two to four fit run records (the 14.4 "after" record as the "before", an optional
 * intermediate, the 14.5 record, an optional record with the stage-2 limit widened to +-12 %)
 * and builds one comparison: the tracked flat first (rank, resale value, profit and credit in
 * every column), then the top 15 of every column side by side, then the largest rank moves
 * between the first and the last column. It renders the same thing as Swedish markdown.
 *
 * Why it is not `buildValuationReport`: that report is a 14.1 -> 14.4 waterfall and throws on
 * a "before" of model version 2. Here records of model version 1 and 2 are both accepted;
 * the record format itself is parsed by `parseFitRunRecord` in the caller.
 *
 * STRUCTURAL SEPARATION (LOCKED): `niche-score.ts` and `report/flags.ts` must NEVER import this
 * file (the prefix `discovery/valuation-` is registered in `niche-score.test.ts`).
 *
 * Offline: no network, no API key, no paid call. PURE: no file-system import, no clock, no
 * console. The script reads the files and writes the output.
 */

import { FOLKUNGAGATAN_61_BOOLI_ID, type FitRunRecord, type FitRunRow } from "@/lib/discovery/valuation-report";

/** How many rows each side-by-side list holds. */
const TOP_N = 15;

/** How many rank moves the report lists. */
const MOVES_N = 10;

export interface CompareColumnInput {
  /** The caller's label for the column, for example "14.4 (efter)". */
  readonly label: string;
  readonly record: FitRunRecord;
}

export interface CompareInput {
  /** Ordered by the caller: first = "before", last = the newest. At least two. */
  readonly columns: readonly CompareColumnInput[];
  /** The Booli id of the flat the report leads with. */
  readonly trackId: number;
}

export interface ColumnSummary {
  readonly label: string;
  readonly snapshotAsOf: string;
  readonly modelVersion: number;
  readonly modelAsOf: string;
  readonly modelN: number;
  readonly r2: number;
  readonly cvRmseLog: number;
  readonly ranked: number;
}

export interface TrackedColumn {
  readonly label: string;
  /** null when the flat is missing from the column or is not comparable in it. */
  readonly rank: number | null;
  readonly resaleSek: number | null;
  readonly profitSek: number | null;
  readonly creditSek: number | null;
}

export interface TopRow {
  readonly rank: number;
  readonly id: string;
  readonly address: string | null;
  readonly resaleSek: number | null;
  readonly profitSek: number | null;
  readonly tracked: boolean;
}

export interface RankMove {
  readonly id: string;
  readonly address: string | null;
  /** The rank in every column, in column order (null when the flat is not ranked there). */
  readonly ranks: readonly (number | null)[];
  /** Rank in the first column. */
  readonly from: number;
  /** Rank in the last column. */
  readonly to: number;
  /** from - to: positive means the flat climbed (a lower rank number is better). */
  readonly move: number;
}

export interface ValuationCompare {
  readonly version: 1;
  readonly trackId: number;
  /** The tracked flat's address from the first record that has it, else null. */
  readonly trackedAddress: string | null;
  readonly columns: readonly ColumnSummary[];
  readonly tracked: readonly TrackedColumn[];
  readonly top: readonly { readonly label: string; readonly rows: readonly TopRow[] }[];
  readonly moves: readonly RankMove[];
}

/** The join key of a row: the Booli id, else the row key (the listing URL). Never the rank. */
function rowIdOf(row: FitRunRow): string {
  return row.booliId !== null ? `booli:${row.booliId}` : `key:${row.key}`;
}

/** Ranked rows only, first occurrence of an id wins (the lowest rank). */
function rankedById(record: FitRunRecord): Map<string, FitRunRow> {
  const out = new Map<string, FitRunRow>();
  const sorted = [...record.ranked].filter((r) => r.rank !== null).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  for (const row of sorted) {
    const id = rowIdOf(row);
    if (!out.has(id)) out.set(id, row);
  }
  return out;
}

function findTracked(record: FitRunRecord, trackId: number): FitRunRow | null {
  for (const row of record.ranked) if (row.booliId === trackId && row.rank !== null) return row;
  return null;
}

/** Builds the comparison from two or more run records. Throws one readable Error on fewer than two. */
export function buildValuationCompare(input: CompareInput): ValuationCompare {
  const { columns, trackId } = input;
  if (columns.length < 2) throw new Error("En jämförelse behöver minst två körningsposter");

  const summaries: ColumnSummary[] = columns.map((c) => ({
    label: c.label,
    snapshotAsOf: c.record.snapshotAsOf,
    modelVersion: c.record.model.version,
    modelAsOf: c.record.model.asOf,
    modelN: c.record.model.n,
    r2: c.record.model.r2,
    cvRmseLog: c.record.model.cvRmseLog,
    ranked: c.record.ranked.length,
  }));

  let trackedAddress: string | null = null;
  const tracked: TrackedColumn[] = columns.map((c) => {
    const row = findTracked(c.record, trackId);
    if (row !== null && trackedAddress === null) trackedAddress = row.address;
    return {
      label: c.label,
      rank: row?.rank ?? null,
      resaleSek: row?.resaleSek ?? null,
      profitSek: row?.profitSek ?? null,
      creditSek: row?.creditSek ?? null,
    };
  });

  const maps = columns.map((c) => rankedById(c.record));
  const top = columns.map((c, i) => ({
    label: c.label,
    rows: [...maps[i].entries()]
      .map(([id, row]) => ({ id, row }))
      .sort((a, b) => (a.row.rank ?? 0) - (b.row.rank ?? 0))
      .slice(0, TOP_N)
      .map(({ id, row }) => ({
        rank: row.rank ?? 0,
        id,
        address: row.address,
        resaleSek: row.resaleSek,
        profitSek: row.profitSek,
        tracked: row.booliId === trackId,
      })),
  }));

  const firstMap = maps[0];
  const lastMap = maps[maps.length - 1];
  const moves: RankMove[] = [];
  for (const [id, firstRow] of firstMap) {
    const lastRow = lastMap.get(id);
    if (lastRow === undefined || firstRow.rank === null || lastRow.rank === null) continue;
    moves.push({
      id,
      address: lastRow.address ?? firstRow.address,
      ranks: maps.map((m) => m.get(id)?.rank ?? null),
      from: firstRow.rank,
      to: lastRow.rank,
      move: firstRow.rank - lastRow.rank,
    });
  }
  moves.sort((a, b) => Math.abs(b.move) - Math.abs(a.move) || a.to - b.to || a.from - b.from);

  return {
    version: 1,
    trackId,
    trackedAddress,
    columns: summaries,
    tracked,
    top,
    moves: moves.slice(0, MOVES_N),
  };
}

// ---------------------------------------------------------------------------
// Swedish number formatting: whole kronor with a space between thousands, decimal comma
// ---------------------------------------------------------------------------

function groupThousands(n: number): string {
  return String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** "1 234 567 kr", "-2 500 kr", or "-" for null. */
function krText(n: number | null): string {
  if (n === null) return "-";
  const whole = Math.round(n);
  return `${whole < 0 ? "-" : ""}${groupThousands(whole)} kr`;
}

/** "+344 502 kr" or "-2 500 kr"; "-" when either end is unknown. */
function krDelta(from: number | null, to: number | null): string {
  if (from === null || to === null) return "-";
  const d = Math.round(to) - Math.round(from);
  return `${d > 0 ? "+" : d < 0 ? "-" : ""}${groupThousands(d)} kr`;
}

const FLAT_NAME_61 = "Folkungagatan 61";

function rankText(rank: number | null): string {
  return rank === null ? "saknas" : String(rank);
}

function trackedHeading(compare: ValuationCompare): string {
  const name = compare.trackId === FOLKUNGAGATAN_61_BOOLI_ID ? FLAT_NAME_61 : (compare.trackedAddress ?? "Spårad lägenhet");
  return `${name} (${compare.trackId})`;
}

/** A markdown table cell must not hold a pipe or a line break. */
function cell(text: string): string {
  return text.replace(/[|\r\n]+/g, " ");
}

function movesWord(move: number): string {
  if (move > 0) return `upp ${move}`;
  if (move < 0) return `ned ${-move}`;
  return "oförändrad";
}

/** Renders the comparison as Swedish markdown. */
export function renderValuationCompareMd(compare: ValuationCompare): string {
  const lines: string[] = [];
  const first = compare.tracked[0];
  const last = compare.tracked[compare.tracked.length - 1];

  lines.push("# Jämförelse av värderingskörningar");
  lines.push("");
  lines.push("Offline: inget nätverk, ingen API-nyckel, inget betalt anrop.");
  lines.push("");

  lines.push(`## ${trackedHeading(compare)}`);
  lines.push("");
  lines.push(`plats ${compare.tracked.map((t) => rankText(t.rank)).join(" → ")}`);
  lines.push("");
  lines.push("| Körning | Plats | Återförsäljning | Vinst | Kredit |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const t of compare.tracked) {
    lines.push(`| ${cell(t.label)} | ${rankText(t.rank)} | ${krText(t.resaleSek)} | ${krText(t.profitSek)} | ${krText(t.creditSek)} |`);
  }
  lines.push("");
  const rankMove = first.rank !== null && last.rank !== null ? movesWord(first.rank - last.rank) : "går inte att mäta";
  lines.push(
    `Första mot sista körningen: plats ${rankMove}, återförsäljning ${krDelta(first.resaleSek, last.resaleSek)}, vinst ${krDelta(first.profitSek, last.profitSek)}, kredit ${krDelta(first.creditSek, last.creditSek)}.`,
  );
  lines.push("");

  lines.push("## Körningar");
  lines.push("");
  lines.push("| Körning | Snapshot | Modell | Modelldatum | Rader i modellen | R2 | cvRmseLog | Rankade rader |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const c of compare.columns) {
    lines.push(
      `| ${cell(c.label)} | ${c.snapshotAsOf} | v${c.modelVersion} | ${c.modelAsOf} | ${groupThousands(c.modelN)} | ${String(c.r2.toFixed(3)).replace(".", ",")} | ${String(c.cvRmseLog.toFixed(4)).replace(".", ",")} | ${c.ranked} |`,
    );
  }
  lines.push("");

  lines.push(`## Topp ${compare.top[0]?.rows.length ?? 0} bredvid varandra`);
  lines.push("");
  lines.push(`| Plats | ${compare.top.map((t) => cell(t.label)).join(" | ")} |`);
  lines.push(`| --- | ${compare.top.map(() => "---").join(" | ")} |`);
  const depth = Math.max(0, ...compare.top.map((t) => t.rows.length));
  for (let i = 0; i < depth; i++) {
    const cells = compare.top.map((t) => {
      const row = t.rows[i];
      if (row === undefined) return "";
      const name = cell(row.address ?? "okänd adress");
      return `${row.tracked ? `**${name}**` : name}, ${krText(row.profitSek)}`;
    });
    lines.push(`| ${i + 1} | ${cells.join(" | ")} |`);
  }
  lines.push("");

  lines.push("## Största platsförflyttningar");
  lines.push("");
  lines.push(
    `Mellan första ("${cell(compare.columns[0].label)}") och sista ("${cell(compare.columns[compare.columns.length - 1].label)}") körningen. Plus betyder att lägenheten steg.`,
  );
  lines.push("");
  lines.push(`| Adress | Platser | Förflyttning |`);
  lines.push("| --- | --- | --- |");
  for (const m of compare.moves) {
    const name = cell(m.address ?? "okänd adress");
    lines.push(`| ${name} | ${m.ranks.map(rankText).join(" → ")} | ${m.move > 0 ? "+" : ""}${m.move} |`);
  }
  lines.push("");

  return lines.join("\n");
}
