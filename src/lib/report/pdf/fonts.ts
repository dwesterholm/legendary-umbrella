import path from "node:path";
import { Font } from "@react-pdf/renderer";

/**
 * fonts.ts — register the self-hosted PDF font for the report (RPRT-03).
 *
 * `@react-pdf/renderer`'s default is PDFKit's standard-14 Helvetica (AFM), which
 * is NOT an embedded TTF; a missing glyph there can throw or box-substitute at
 * render time (RESEARCH Pitfall 1 / react-pdf #377, #852). Our product is
 * entirely Swedish, so we MUST embed a TTF with full Latin-Extended coverage for
 * å/ä/ö. We ship Open Sans (OFL — redistributable, embedding allowed) at two
 * weights.
 *
 * The TTFs are read server-side via an ABSOLUTE `process.cwd()` path — NOT a
 * bundler import (RESEARCH Pattern 2). Because that read is dynamic, `next build`
 * file-tracing would otherwise drop the assets from the server bundle; the
 * matching `outputFileTracingIncludes` entry in next.config.ts ships them
 * (RESEARCH Pitfall 2 — the same tracing the project already uses for
 * src/data/deso.geojson).
 *
 * Importing this module runs `Font.register` as a side effect, so it MUST be
 * imported before any render (report-document.tsx imports it first).
 */

/** The registered font family name; reference it as `fontFamily: REPORT_FONT_FAMILY`. */
export const REPORT_FONT_FAMILY = "Open Sans";

const FONTS_DIR = path.join(process.cwd(), "src/lib/report/pdf/fonts");

Font.register({
  family: REPORT_FONT_FAMILY,
  fonts: [
    { src: path.join(FONTS_DIR, "OpenSans-Regular.ttf") },
    { src: path.join(FONTS_DIR, "OpenSans-SemiBold.ttf"), fontWeight: 600 },
  ],
});
