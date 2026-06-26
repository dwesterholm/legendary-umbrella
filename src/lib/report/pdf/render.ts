import { createElement, type ReactElement } from "react";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import type { AiReport } from "@/lib/schemas/report";
import type { Flag } from "@/lib/report/flags";
import { ReportDocument } from "./report-document";

/**
 * render.ts — the server-side PDF render surface (RPRT-03, RESEARCH Pattern 1).
 *
 * `renderToBuffer` is `@react-pdf/renderer`'s Node API — it renders the
 * `<ReportDocument>` React tree to a PDF Buffer entirely server-side (Yoga +
 * PDFKit, no headless browser). This module is the ONLY place the PDF bytes are
 * produced.
 *
 * SINGLE SOURCE OF TRUTH (D-11): this module renders the data it is HANDED. It
 * does NOT import the Anthropic client, does NOT re-synthesise, and does NOT do
 * any DB I/O. The caller (`downloadReportPdf`) loads the already-persisted
 * `report_data` and passes it in — the PDF and the on-screen page therefore read
 * the exact same snapshot, never a fresh (and double-billed) synthesis.
 */

/**
 * The exact shape the PDF renders — the persisted-report slice the on-screen
 * page also consumes (`reportDataSchema.report` + `.flags`). Kept structural
 * (not a re-derived schema) so screen and PDF can never drift apart.
 */
export interface ReportPdfData {
  /** The Zod-validated synthesis output (lead + themed sections + flag ids). */
  report: AiReport;
  /** The deterministic flag set the synthesis narrated (by id). */
  flags: Flag[];
  /** The model id the report was generated with (trace footer). */
  model?: string | null;
  /** The synthesis prompt version (trace footer). */
  promptVersion?: string | null;
}

/**
 * Render the persisted report to a PDF Buffer. Receives the SAME persisted
 * `report_data` the page renders — no re-fetch, no re-synthesis (D-11).
 */
export async function renderReportPdf(data: ReportPdfData): Promise<Buffer> {
  // createElement (not JSX) keeps this a .ts file — the JSX tree lives in the
  // .tsx document. Equivalent to <ReportDocument data={data} />. ReportDocument
  // returns a <Document> root, so the produced element satisfies
  // renderToBuffer's DocumentProps element contract; the cast bridges the
  // function-component element type to that nominal expectation.
  const element = createElement(ReportDocument, {
    data,
  }) as unknown as ReactElement<DocumentProps>;
  return renderToBuffer(element);
}
