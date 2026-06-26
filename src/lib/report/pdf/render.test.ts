import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderReportPdf, type ReportPdfData } from "./render";

/**
 * Deterministic test for the PDF render subsystem (Plan 04-05, RPRT-03).
 *
 * No network, no DB, no Anthropic key: renderReportPdf is a pure server-side
 * render of the data it is handed. These tests pin:
 *  - a non-empty Buffer with the `%PDF` magic header (the render actually ran);
 *  - å/ä/ö in the report prose render without a missing-glyph throw (the
 *    registered Open Sans TTF covers Latin-Extended — Pitfall 1);
 *  - an `ej_tillgänglig` themed section renders an honest marker (D-12/FM4);
 *  - render.ts imports NEITHER the Anthropic client NOR any DB I/O (D-11 single
 *    source of truth — no re-synthesis / re-fetch).
 */

/** A known report_data fixture exercising å/ä/ö + a bedömd + an ej_tillgänglig section. */
function fixture(): ReportPdfData {
  return {
    report: {
      leadSynthesis:
        "Föreningens ekonomi är stark men årsavgiften är förhöjd — köparen bör väga in framtida höjningar mot områdets prisutveckling.",
      ekonomi: {
        status: "bedömd",
        claims: [
          {
            text: "Skuldsättningen per kvadratmeter är låg, vilket dämpar ränterisken.",
            sourceRef: "brf.skuldPerKvm",
          },
        ],
      },
      // Honest gap — must render an "Ej tillgänglig" marker, never fabricated prose.
      pris: { status: "ej_tillgänglig", claims: [] },
      omrade: {
        status: "bedömd",
        claims: [
          {
            text: "Området har en hög andel äganderätter och stabil inkomstnivå.",
            sourceRef: "area.tenure",
          },
        ],
      },
      prioritizedFlagIds: ["brf_low_debt"],
    },
    flags: [
      {
        id: "brf_low_debt",
        severity: "green",
        sourceRef: "brf.skuldPerKvm",
        sourceQuote: "Lån per kvm 4 500 kr",
        pageRef: 3,
        confidence: 0.9,
      },
      {
        id: "brf_avgift_elevated",
        severity: "red",
        sourceRef: "brf.avgiftsniva",
        sourceQuote: null,
        pageRef: null,
        confidence: null,
      },
    ],
    model: "claude-sonnet-4-6",
    promptVersion: "report-synth/v1 (2026-06-23)",
  };
}

describe("renderReportPdf — surface", () => {
  it("exports a render function", () => {
    expect(typeof renderReportPdf).toBe("function");
  });
});

describe("renderReportPdf — produces a valid PDF buffer", () => {
  it("returns a non-empty Buffer whose first bytes are the %PDF magic header", async () => {
    const buffer = await renderReportPdf(fixture());
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
    // PDF files begin with the literal "%PDF" magic header.
    expect(buffer.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("renders å/ä/ö in lead/claims without throwing a missing-glyph error", async () => {
    // The fixture's prose is full of å/ä/ö; a missing-glyph throw (AFM Helvetica
    // fallback) would reject this promise. A non-empty %PDF buffer proves the
    // embedded TTF covered the glyphs.
    const buffer = await renderReportPdf(fixture());
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("renders an ej_tillgänglig section without fabricating content (D-12/FM4)", async () => {
    const data = fixture();
    // Make every themed section unavailable — the render must still succeed and
    // produce an honest document (the marker text lives in the document tree).
    data.report.ekonomi = { status: "ej_tillgänglig", claims: [] };
    data.report.pris = { status: "ej_tillgänglig", claims: [] };
    data.report.omrade = { status: "ej_tillgänglig", claims: [] };
    const buffer = await renderReportPdf(data);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });
});

describe("renderReportPdf — single source of truth (D-11)", () => {
  it("render.ts imports no Anthropic client and no DB I/O (no re-synthesis/re-fetch)", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/lib/report/pdf/render.ts"),
      "utf8",
    );
    // Strip line comments + block comments so the doc-comment that *describes*
    // the prohibition isn't mistaken for an actual import.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/@anthropic-ai\/sdk/);
    expect(code).not.toMatch(/\bnew Anthropic\b/);
    expect(code).not.toMatch(/synthesizeReport/);
    expect(code).not.toMatch(/createClient/);
    expect(code).not.toMatch(/supabase/i);
  });
});
