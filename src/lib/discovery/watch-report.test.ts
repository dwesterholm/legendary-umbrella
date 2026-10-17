import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FitTableRow } from "./fit-pipeline";
import {
  escapeHtml,
  formatKr,
  renderWatchHtml,
  renderWatchText,
  selectMailRows,
  statusLabel,
  watchSubject,
  type MailRow,
  type WatchMailInput,
} from "./watch-report";

function tableRow(over: Partial<FitTableRow> = {}): FitTableRow {
  return {
    rank: 1,
    preRank: 1,
    address: "Götgatan 1",
    district: "Södermalm",
    kvm: 40,
    floor: 3,
    askingKr: 3_995_000,
    budpremie: "+4,2 % (distrikt+pris+dagar)",
    expectedFinalKr: 3_900_000,
    resaleKr: 4_800_000,
    gapKr: 900_000,
    renoTier: "medel",
    renoMidKr: 300_000,
    renoLowKr: 200_000,
    renoHighKr: 400_000,
    profitKr: 250_000,
    tasteKr: 10_000,
    sol: "S gata/N gård (fastighet/gata, 0,95)",
    solTheoretical: "6,0/5,5/4,1",
    solObstructed: "5,8 (5,1\u20136,0) / 5,5 (5,5\u20135,5) / 1,2 (0,0\u20134,1) usäker",
    korsdrag: "nej",
    sovrum: "gata",
    takhojd: "okänd",
    flags: ["ovanligt långt under modellpris"],
    reasons: "tomträtt",
    link: "https://www.booli.se/bostad/150148",
    ...over,
  };
}

function manyRows(under: number, over: number): FitTableRow[] {
  const rows: FitTableRow[] = [];
  for (let i = 0; i < under; i++) rows.push(tableRow({ rank: rows.length + 1, address: `Under ${i + 1}`, expectedFinalKr: 3_500_000, link: `https://www.booli.se/bostad/${1000 + i}` }));
  for (let i = 0; i < over; i++) rows.push(tableRow({ rank: rows.length + 1, address: `Över ${i + 1}`, expectedFinalKr: 4_500_000, link: `https://www.booli.se/bostad/${2000 + i}` }));
  return rows;
}

const EMPTY_DIFF = { newRows: [], changedRows: [] };

function input(over: Partial<WatchMailInput> = {}): WatchMailInput {
  return {
    date: "2026-10-20",
    sections: { under: [], over: [] },
    header: {
      completeness: "Kandidatlista: komplett",
      incomplete: false,
      coverageLine: "Täckning (35 annonser): detaljsida 35 av 35 (100,0 %)",
      modelLine: "Modell per 2026-10-12: n 100, R² 0.80",
      note: null,
    },
    counts: { nNew: 0, nChanged: 0 },
    ...over,
  };
}

const newEntry = (row: FitTableRow): MailRow => ({ row, status: "new", oldAskingKr: null });
const changedEntry = (row: FitTableRow, old: number): MailRow => ({ row, status: "changed", oldAskingKr: old });

describe("escapeHtml", () => {
  it("escapes & < > \" '", () => {
    expect(escapeHtml(`a & b <c> "d" 'e'`)).toBe("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;");
  });
  it("an address with markup renders inert", () => {
    const entry = newEntry(tableRow({ address: "Gatan 1 <script>alert(1)</script> & Co" }));
    const html = renderWatchHtml(input({ sections: { under: [entry], over: [] } }));
    expect(html).not.toContain("<script");
    expect(html).toContain("Gatan 1 &lt;script&gt;alert(1)&lt;/script&gt; &amp; Co");
  });
  it("reasons and flags are escaped too", () => {
    const entry = newEntry(tableRow({ reasons: `hög <b>avgift</b> "x"`, flags: ["<i>flagga</i>"] }));
    const html = renderWatchHtml(input({ sections: { under: [entry], over: [] } }));
    expect(html).not.toContain("<b>avgift");
    expect(html).not.toContain("<i>flagga");
    expect(html).toContain("hög &lt;b&gt;avgift&lt;/b&gt; &quot;x&quot;");
  });
  it("header lines are escaped", () => {
    const html = renderWatchHtml(
      input({ header: { completeness: "Kandidatlista: <x>", incomplete: false, coverageLine: "a & b", modelLine: "m", note: "<n>" } }),
    );
    expect(html).toContain("Kandidatlista: &lt;x&gt;");
    expect(html).toContain("a &amp; b");
    expect(html).toContain("&lt;n&gt;");
  });
});

describe("formatKr", () => {
  it("uses a space as thousands separator", () => {
    expect(formatKr(3_795_000)).toBe("3 795 000");
    expect(formatKr(999)).toBe("999");
    expect(formatKr(1000)).toBe("1 000");
  });
  it("uses an ASCII hyphen for negatives (never U+2212)", () => {
    const s = formatKr(-125_000);
    expect(s).toBe("-125 000");
    expect(s).not.toContain("\u2212");
    expect(s.charCodeAt(0)).toBe(0x2d);
  });
  it("prints -0 and values that round to 0 as plain 0", () => {
    expect(formatKr(-0.3)).toBe("0");
    expect(formatKr(-0)).toBe("0");
    expect(formatKr(0.4)).toBe("0");
  });
  it("prints null and NaN as a dash", () => {
    expect(formatKr(null)).toBe("-");
    expect(formatKr(Number.NaN)).toBe("-");
  });
  it("rounds to whole kronor", () => {
    expect(formatKr(1234.5)).toBe("1 235");
  });
});

describe("selectMailRows", () => {
  it("first run: the top 15 of each section, all marked new, table order kept", () => {
    const rows = manyRows(20, 3);
    const sel = selectMailRows({ rows, diff: EMPTY_DIFF, firstRun: true, perSectionFirstRun: 15 });
    expect(sel.under).toHaveLength(15);
    expect(sel.over).toHaveLength(3);
    expect([...sel.under, ...sel.over].every((e) => e.status === "new" && e.oldAskingKr === null)).toBe(true);
    expect(sel.under.map((e) => e.row.address)).toEqual(rows.slice(0, 15).map((r) => r.address));
  });

  it("later run: only new and changed rows, grouped by section, the changed one carrying its old price", () => {
    const rows = manyRows(21, 20);
    const fresh = rows[3];
    const cheaper = rows[25];
    const sel = selectMailRows({
      rows,
      diff: { newRows: [fresh], changedRows: [{ row: cheaper, oldSek: 4_995_000, newSek: 4_795_000 }] },
      firstRun: false,
      perSectionFirstRun: 15,
    });
    expect(sel.under).toEqual([{ row: fresh, status: "new", oldAskingKr: null }]);
    expect(sel.over).toEqual([{ row: cheaper, status: "changed", oldAskingKr: 4_995_000 }]);
  });

  it("later run keeps the table order inside a section", () => {
    const rows = manyRows(5, 0);
    const sel = selectMailRows({ rows, diff: { newRows: [rows[4], rows[1], rows[2]], changedRows: [] }, firstRun: false, perSectionFirstRun: 15 });
    expect(sel.under.map((e) => e.row.address)).toEqual(["Under 2", "Under 3", "Under 5"]);
  });

  it("a quiet week leaves both sections empty", () => {
    const sel = selectMailRows({ rows: manyRows(10, 5), diff: EMPTY_DIFF, firstRun: false, perSectionFirstRun: 15 });
    expect(sel).toEqual({ under: [], over: [] });
  });

  it("a row at exactly 4 000 000 expected final lands in the under section", () => {
    const edge = tableRow({ expectedFinalKr: 4_000_000 });
    const sel = selectMailRows({ rows: [edge], diff: { newRows: [edge], changedRows: [] }, firstRun: false, perSectionFirstRun: 15 });
    expect(sel.under).toHaveLength(1);
    expect(sel.over).toHaveLength(0);
  });
});

describe("statusLabel (W2, D-15 wording)", () => {
  it("new row", () => {
    expect(statusLabel(newEntry(tableRow()))).toBe("nya sedan förra veckan");
  });
  it("changed row", () => {
    expect(statusLabel(changedEntry(tableRow({ askingKr: 3_795_000 }), 3_995_000))).toBe("prisändrad (3 995 000 → 3 795 000)");
  });
});

describe("renderWatchHtml", () => {
  const under = [newEntry(tableRow({ address: "Götgatan 1", reasons: "tomträtt, hög avgift" }))];
  const over = [changedEntry(tableRow({ address: "Ringvägen 2", askingKr: 3_795_000, expectedFinalKr: 4_300_000 }), 3_995_000)];
  const html = renderWatchHtml(input({ sections: { under, over }, counts: { nNew: 1, nChanged: 1 } }));

  it("is a utf-8 document with the under section before the over section", () => {
    expect(html).toContain('<meta charset="utf-8">');
    expect(html.indexOf("Förväntat under 4 M")).toBeGreaterThan(-1);
    expect(html.indexOf("Förväntat under 4 M")).toBeLessThan(html.indexOf("Över 4 M förväntat"));
  });

  it("a new row's status cell is exactly 'nya sedan förra veckan'", () => {
    expect(html).toMatch(/<td[^>]*>nya sedan förra veckan<\/td>/);
  });

  it("a changed row's status cell is exactly 'prisändrad (3 995 000 → 3 795 000)'", () => {
    expect(html).toMatch(/<td[^>]*>prisändrad \(3 995 000 → 3 795 000\)<\/td>/);
  });

  it("carries the Varför här column and cell", () => {
    expect(html).toContain("<th");
    expect(html).toMatch(/<th[^>]*>Varför här<\/th>/);
    expect(html).toMatch(/<td[^>]*>tomträtt, hög avgift<\/td>/);
  });

  it("has every column of D-15", () => {
    for (const heading of ["Status", "Adress", "Område", "kvm", "vån", "Utgångspris", "Budpremie", "Förv. slutpris", "Värde renoverad", "Skillnad", "Reno (nivå, spann)", "Vinst", "Smak", "Sol", "Soltim. fri (mar/jun/dec)", "Soltim. med grannhus (mar/jun/dec)", "Korsdrag", "Sovrum", "Takhöjd", "Flaggor", "Varför här", "Booli"]) {
      expect(html).toMatch(new RegExp(`<th[^>]*>${heading.replace(/[().]/g, "\\$&")}</th>`));
    }
  });

  it("'Budpremie' sits right after 'Utgångspris', is text (left-aligned), and its cell is escaped like the others", () => {
    const headings = [...html.slice(html.indexOf("<table"), html.indexOf("</table>")).matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(headings.indexOf("Budpremie")).toBe(headings.indexOf("Utgångspris") + 1);
    expect(html).toMatch(/<td style="[^"]*">\+4,2 % \(distrikt\+pris\+dagar\)<\/td>/);
    expect(html).not.toMatch(/<td style="[^"]*text-align:right[^"]*">\+4,2 %/);
    const hostile = renderWatchHtml(input({ sections: { under: [newEntry(tableRow({ budpremie: "<b>x</b> & (y)" }))], over: [] } }));
    expect(hostile).toContain("&lt;b&gt;x&lt;/b&gt; &amp; (y)");
    expect(hostile).not.toContain("<b>x</b>");
  });

  it("shows one 'Skillnad' column and none of the two earlier money columns", () => {
    const headings = [...html.slice(html.indexOf("<table"), html.indexOf("</table>")).matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(headings.filter((h) => h === "Skillnad")).toHaveLength(1);
    expect(headings.some((h) => /^Okapad|^Kredit/.test(h))).toBe(false);
  });

  it("'Korsdrag', 'Sovrum' and 'Takhöjd' follow the sun-hour columns right before 'Flaggor'; their cells sit at the heading indexes, are text, and are escaped (LAY-03, CEIL-02)", () => {
    const firstTable = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
    const headings = [...firstTable.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    const at = headings.indexOf("Soltim. med grannhus (mar/jun/dec)");
    expect(headings.slice(at, at + 5)).toEqual(["Soltim. med grannhus (mar/jun/dec)", "Korsdrag", "Sovrum", "Takhöjd", "Flaggor"]);
    const firstRow = firstTable.split("<tr>")[2];
    const cells = [...firstRow.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
    expect(cells).toHaveLength(headings.length);
    expect(cells[headings.indexOf("Korsdrag")]).toBe("nej");
    expect(cells[headings.indexOf("Sovrum")]).toBe("gata");
    expect(cells[headings.indexOf("Takhöjd")]).toBe("okänd");
    const hostile = renderWatchHtml(input({ sections: { under: [newEntry(tableRow({ korsdrag: "<b>ja</b>", sovrum: "g & g" }))], over: [] } }));
    expect(hostile).toContain("&lt;b&gt;ja&lt;/b&gt;");
    expect(hostile).toContain("g &amp; g");
    expect(hostile).not.toContain("<b>ja</b>");
  });

  it("the 'Takhöjd' cell is text (left-aligned), shows a stated height, and a hostile value is escaped (T-14.5-16)", () => {
    const stated = renderWatchHtml(input({ sections: { under: [newEntry(tableRow({ takhojd: "3,6 m" }))], over: [] } }));
    const firstTable = stated.slice(stated.indexOf("<table"), stated.indexOf("</table>"));
    const headings = [...firstTable.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    const tds = [...firstTable.split("<tr>")[2].matchAll(/<td([^>]*)>(.*?)<\/td>/g)];
    expect(tds).toHaveLength(headings.length);
    const at = headings.indexOf("Takhöjd");
    expect(tds[at][2]).toBe("3,6 m");
    expect(tds[at][1]).not.toContain("text-align:right");
    const hostile = renderWatchHtml(input({ sections: { under: [newEntry(tableRow({ takhojd: "<b>3 m</b> & x" }))], over: [] } }));
    expect(hostile).toContain("&lt;b&gt;3 m&lt;/b&gt; &amp; x");
    expect(hostile).not.toContain("<b>3 m</b>");
  });

  it("the three Sol columns sit right after 'Smak', and each row's cells are at the same index as the headings", () => {
    const firstTable = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
    const headings = [...firstTable.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    const smak = headings.indexOf("Smak");
    expect(headings.slice(smak, smak + 4)).toEqual(["Smak", "Sol", "Soltim. fri (mar/jun/dec)", "Soltim. med grannhus (mar/jun/dec)"]);
    expect(headings[headings.length - 1]).toBe("Booli");
    // The first body row of the first table: one <td> per heading, the Sol cells at the heading indexes.
    const firstRow = firstTable.split("<tr>")[2];
    const cells = [...firstRow.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
    expect(cells).toHaveLength(headings.length);
    expect(cells[headings.indexOf("Sol")]).toBe("S gata/N gård (fastighet/gata, 0,95)");
    expect(cells[headings.indexOf("Soltim. fri (mar/jun/dec)")]).toBe("6,0/5,5/4,1");
    expect(cells[headings.indexOf("Soltim. med grannhus (mar/jun/dec)")]).toBe("5,8 (5,1\u20136,0) / 5,5 (5,5\u20135,5) / 1,2 (0,0\u20134,1) usäker");
    expect(cells[headings.indexOf("Booli")]).toBe('<a href="https://www.booli.se/bostad/150148">Booli</a>');
  });

  it("the Sol columns are text: left-aligned, not in the numeric set", () => {
    const solCell = html.match(/<td style="[^"]*">(S gata\/N gård[^<]*)<\/td>/);
    expect(solCell).not.toBeNull();
    expect(solCell?.[0]).not.toContain("text-align:right");
  });

  it("a Sol cell with markup is escaped in the HTML", () => {
    const h = renderWatchHtml(input({ sections: { under: [newEntry(tableRow({ sol: "<b>S</b> & N", solObstructed: "<i>x</i>" }))], over: [] } }));
    expect(h).toContain("&lt;b&gt;S&lt;/b&gt; &amp; N");
    expect(h).toContain("&lt;i&gt;x&lt;/i&gt;");
    expect(h).not.toContain("<b>S</b>");
  });

  it("formats money with spaces and the reno range with an en dash", () => {
    expect(html).toContain(">3 900 000<");
    expect(html).toContain("medel 300 000 (200 000–400 000)");
  });

  it("a Booli https link becomes an anchor", () => {
    expect(html).toContain('<a href="https://www.booli.se/bostad/150148">Booli</a>');
  });

  it("a non-Booli, http or javascript link is plain escaped text", () => {
    for (const link of ["https://example.com/x", "http://www.booli.se/bostad/1", "javascript:alert(1)", "-", "https://evilbooli.se/x"]) {
      const h = renderWatchHtml(input({ sections: { under: [newEntry(tableRow({ link }))], over: [] } }));
      expect(h).not.toContain("<a ");
      expect(h).toContain(escapeHtml(link));
    }
  });

  it("an ampersand in a Booli link is escaped in the attribute", () => {
    const h = renderWatchHtml(input({ sections: { under: [newEntry(tableRow({ link: "https://www.booli.se/bostad/1?a=1&b=2" }))], over: [] } }));
    expect(h).toContain('href="https://www.booli.se/bostad/1?a=1&amp;b=2"');
  });

  it("shows the incomplete candidate list in the header", () => {
    const h = renderWatchHtml(
      input({ header: { completeness: "Kandidatlista: OFULLSTÄNDIG (Kungsholmen)", incomplete: true, coverageLine: "c", modelLine: "m" } }),
    );
    expect(h).toContain("Kandidatlista: OFULLSTÄNDIG (Kungsholmen)");
    expect(h).toContain("font-weight:bold");
  });

  it("shows date, coverage line and model line", () => {
    expect(html).toContain("Bostadsbevakning 2026-10-20: 1 nya, 1 prisändrade");
    expect(html).toContain("Täckning (35 annonser)");
    expect(html).toContain("Modell per 2026-10-12");
  });

  it("has no image, script, or remote source", () => {
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\bsrc\s*=/i);
    expect(html).not.toMatch(/url\(/i);
  });

  it("keeps Swedish letters intact", () => {
    const h = renderWatchHtml(input({ sections: { under: [newEntry(tableRow({ address: "Östgötagatan 12 å ä ö" }))], over: [] } }));
    expect(h).toContain("Östgötagatan 12 å ä ö");
  });

  it("an empty section keeps its heading with '0 annonser'", () => {
    const h = renderWatchHtml(input({ sections: { under: [], over: [] } }));
    expect(h).toContain("Förväntat under 4 M (0 annonser)");
    expect(h).toContain("Över 4 M förväntat (0 annonser)");
  });
});

describe("renderWatchText", () => {
  const under = [newEntry(tableRow({ address: "Götgatan 1" }))];
  const over = [changedEntry(tableRow({ address: "Ringvägen 2", askingKr: 3_795_000, expectedFinalKr: 4_300_000 }), 3_995_000)];
  const text = renderWatchText(input({ sections: { under, over }, counts: { nNew: 1, nChanged: 1 } }));

  it("carries the same rows and the same two status labels verbatim", () => {
    expect(text).toContain("nya sedan förra veckan");
    expect(text).toContain("prisändrad (3 995 000 → 3 795 000)");
    expect(text).toContain("Götgatan 1");
    expect(text).toContain("Ringvägen 2");
  });

  it("is not HTML-escaped and keeps the section order", () => {
    expect(text).not.toContain("&amp;");
    expect(text.indexOf("Förväntat under 4 M")).toBeLessThan(text.indexOf("Över 4 M förväntat"));
    expect(text).toContain("Förväntat under 4 M (1 annonser)");
  });

  it("an empty section prints 0 annonser", () => {
    expect(renderWatchText(input())).toContain("Över 4 M förväntat (0 annonser)");
  });

  it("the plain-text header and every row have the same number of cells, the Sol cells at the same index", () => {
    const lines = text.split("\n");
    const header = lines.find((l) => l.startsWith("Status | Adress"));
    const row = lines.find((l) => l.startsWith("nya sedan förra veckan | Götgatan 1"));
    expect(header).toBeDefined();
    expect(row).toBeDefined();
    const h = (header as string).split(" | ");
    const r = (row as string).split(" | ");
    expect(r).toHaveLength(h.length);
    expect(r[h.indexOf("Sol")]).toBe("S gata/N gård (fastighet/gata, 0,95)");
    expect(r[h.indexOf("Soltim. fri (mar/jun/dec)")]).toBe("6,0/5,5/4,1");
    expect(r[h.indexOf("Korsdrag")]).toBe("nej");
    expect(r[h.indexOf("Sovrum")]).toBe("gata");
    expect(h.indexOf("Korsdrag")).toBe(h.indexOf("Soltim. med grannhus (mar/jun/dec)") + 1);
    expect(r[h.indexOf("Takhöjd")]).toBe("okänd");
    expect(h.indexOf("Takhöjd")).toBe(h.indexOf("Sovrum") + 1);
    expect(h.indexOf("Flaggor")).toBe(h.indexOf("Takhöjd") + 1);
  });
});

describe("watchSubject", () => {
  it("is short", () => {
    expect(watchSubject("2026-10-20", 3, 1)).toBe("Bostadsbevakning 2026-10-20: 3 nya, 1 prisändrade");
  });
});

describe("purity", () => {
  it("imports no file system, transport or client module", () => {
    const source = readFileSync("src/lib/discovery/watch-report.ts", "utf8");
    expect(source.split("\n").filter((l) => /^import .*(node:fs|transport|client")/.test(l))).toEqual([]);
  });
});
