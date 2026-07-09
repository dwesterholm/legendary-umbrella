import * as cheerio from "cheerio";

/**
 * ixbrl-to-text.ts — strips an iXBRL/HTML annual-report document down to
 * plain, normalized text so it can be fed through the SAME Claude extraction
 * call the PDF path already uses (see `src/lib/brf/run-extraction.ts`).
 *
 * WHY plain text, not a taxonomy parser (08-RESEARCH.md "Don't Hand-Roll"):
 * no mature npm package correctly parses Swedish BFN K2/K3-taxonomy iXBRL —
 * existing packages target Danish/US-GAAP taxonomies and would require a
 * bespoke taxonomy mapping with none of the benefit. Claude already reliably
 * extracts skuldPerKvm/avgiftsniva/etc. from unstructured PDF text; iXBRL is
 * valid XHTML, so its rendered text carries the same human-readable figures
 * (in prose/table form) — arguably easier than a PDF since it's already
 * digitally native with no OCR/scan risk. This module's only job is to strip
 * the markup, not interpret the underlying `ix:` tags.
 *
 * Mirrors `src/lib/broker/parse-broker-page.ts`'s degrade-not-throw contract:
 * malformed/empty input never throws — it returns "" so a bad document falls
 * through to manual upload instead of crashing the auto-fetch pipeline.
 */

/**
 * CR-02: bounds the STRIPPED plain-text output so a large-but-allowed
 * Allabrf/iXBRL response can never reach `extract.ts`'s Claude call
 * untruncated. `allabrf.ts`'s `MAX_DOC_BYTES` (8 MB) only bounds the RAW HTML
 * body; nothing downstream previously bounded the text this function derives
 * from it. This mirrors the PDF path's `BASE64_MAX_BYTES` threshold
 * discipline (extract.ts) — untrusted document content must always be
 * bounded before it becomes an unbounded cost/context-window liability, not
 * just after the fact via the post-call `COST_CAP_SEK` check.
 *
 * ~300k chars is a generous budget for Haiku's context window (well under
 * typical 200k-token limits at a conservative ~4 chars/token) while still
 * comfortably covering any real Swedish BRF annual report's full prose/table
 * content — truncation should only ever engage on a pathological/oversized
 * response, not a normal-sized document.
 */
const MAX_TEXT_CHARS = 300_000;

/**
 * Strips an iXBRL/HTML document to normalized plain text.
 *
 * - Removes `<script>`/`<style>` content before reading text (never feed
 *   script/style bodies to Claude — that would be structurally noisy without
 *   adding any financial signal).
 * - Falls back to the whole document's text (`$.root()`) when there is no
 *   `<body>` element, so a bare-fragment iXBRL snippet still yields text.
 * - Collapses runs of whitespace/newlines to single spaces and trims.
 * - CR-02: hard-truncates the result to `MAX_TEXT_CHARS` — a document that
 *   strips to something oversized degrades to a bounded prefix rather than
 *   being passed through unbounded (never throws, consistent with this
 *   module's degrade-not-throw contract; a truncated document still gives
 *   Claude the earliest financial-statement content, generally the most
 *   relevant, rather than failing the whole auto-fetch attempt).
 * - Never throws — any parse failure degrades to `""`.
 */
export function ixbrlToPlainText(ixbrlHtml: string): string {
  try {
    const $ = cheerio.load(ixbrlHtml, { xmlMode: false });
    $("script, style").remove();

    const body = $("body");
    const raw = body.length > 0 ? body.text() : $.root().text();

    const collapsed = raw.replace(/\s+/g, " ").trim();
    return collapsed.length > MAX_TEXT_CHARS
      ? collapsed.slice(0, MAX_TEXT_CHARS)
      : collapsed;
  } catch {
    return "";
  }
}
