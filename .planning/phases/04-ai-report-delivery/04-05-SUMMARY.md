---
phase: 04-ai-report-delivery
plan: 05
subsystem: api
tags: [react-pdf, pdf, fonts, server-action, next, vercel, supabase, idor]

# Dependency graph
requires:
  - phase: 04-01
    provides: reportSchema + reportDataSchema + safeParseReportData (the persisted report_data shape the PDF renders)
  - phase: 04-03
    provides: 004_report.sql additive report_* columns (report_data jsonb the action loads)
provides:
  - "@react-pdf/renderer PDF subsystem (RPRT-03): renderReportPdf returns a non-empty %PDF Buffer from persisted report_data only"
  - "Self-hosted Open Sans (OFL) TTF registered via Font.register, traced into the server bundle for å/ä/ö"
  - "downloadReportPdf — login-gated + ownership-checked, download-only server action returning a application/pdf Blob (D-09/D-10/D-11)"
  - "ReportDocument @react-pdf tree mirroring on-screen section order with the D-12 trust treatment"
affects: [04-06, analysis-page, ai-report-section]

# Tech tracking
tech-stack:
  added: ["@react-pdf/renderer@^4.5.1", "Open Sans TTF (OFL) Regular + SemiBold"]
  patterns:
    - "Server-side renderToBuffer in a server action — pure-JS PDF (Yoga + PDFKit), no headless browser"
    - "fs-read font asset traced via outputFileTracingIncludes (same pattern as deso.geojson)"
    - "Blob return from a server action for client URL.createObjectURL download"

key-files:
  created:
    - src/lib/report/pdf/fonts.ts
    - src/lib/report/pdf/fonts/OpenSans-Regular.ttf
    - src/lib/report/pdf/fonts/OpenSans-SemiBold.ttf
    - src/lib/report/pdf/fonts/OFL.txt
    - src/lib/report/pdf/report-document.tsx
    - src/lib/report/pdf/render.ts
    - src/lib/report/pdf/render.test.ts
    - src/actions/download-report-pdf.ts
    - src/actions/download-report-pdf.test.ts
  modified:
    - next.config.ts
    - package.json
    - package-lock.json

key-decisions:
  - "Font = Open Sans (OFL, embedding-allowed) static Regular + SemiBold TTFs from googlefonts/opensans; fontkit-verified å/ä/ö/Å/Ä/Ö coverage"
  - "render.ts kept as .ts (per plan files_modified) — JSX lives in report-document.tsx; render.ts uses React.createElement, not JSX"
  - "@react-pdf/renderer NOT added to serverExternalPackages — next build succeeds without it (Pitfall 4 / A1 confirmed against the actual build)"
  - "Blob return from the server action used directly (RESEARCH A2) — Route-Handler fallback NOT needed; build + types clean"

patterns-established:
  - "PDF render path: renderReportPdf(persisted report_data) → renderToBuffer(<ReportDocument>) → Buffer; never re-synthesise/re-fetch (D-11)"
  - "Download action: getUser() + row.user_id ownership guard → safeParseReportData read guard → render → Blob (mirrors analyze-brf.ts auth posture)"

requirements-completed: [RPRT-03]

# Metrics
duration: 9min
completed: 2026-06-26
---

# Phase 4 Plan 05: PDF Subsystem + Download Action Summary

**@react-pdf/renderer PDF subsystem (RPRT-03): a self-hosted Open Sans TTF for å/ä/ö, a ReportDocument tree mirroring the on-screen report with the D-12 trust treatment, renderReportPdf → non-empty %PDF Buffer from persisted data only, and a login-gated + ownership-checked downloadReportPdf returning an application/pdf Blob (D-09/D-10/D-11).**

## Performance

- **Duration:** ~9 min
- **Started:** 2026-06-26T08:39Z
- **Completed:** 2026-06-26T08:48Z
- **Tasks:** 3
- **Files modified:** 12 (9 created, 3 modified)

## Accomplishments
- Installed `@react-pdf/renderer@^4.5.1` (pure-JS, no headless Chromium) and shipped Open Sans (OFL) Regular + SemiBold TTFs with fontkit-verified Swedish glyph coverage, registered via `Font.register` and traced into the server bundle alongside `deso.geojson`.
- Built `ReportDocument` — an A4 `<Document>` tree mirroring the on-screen section order (lead synthesis anchor → Ekonomi/Pris/Område → prioritized flags) carrying the D-12 trust treatment (ej-finansiell-rådgivning disclaimer, "Ej tillgänglig" honest markers, source refs, sage/terracotta severity dots).
- `renderReportPdf` returns a non-empty `%PDF` Buffer from the data it is handed — no Anthropic/DB import (D-11 single source of truth), proven by a static import guard + å/ä/ö glyph smoke test.
- `downloadReportPdf` is login-gated + ownership-checked (D-09/T-04-17), degrades a null/drifted report to an affordance (D-11 read-path), renders persisted data only, and returns an `application/pdf` Blob (D-10) — 7 deterministic auth/IDOR/null/drift/happy-path tests.
- `npm run build` succeeds with `@react-pdf/renderer` left OUT of `serverExternalPackages` (Pitfall 4 / A1 confirmed).

## Task Commits

1. **Task 1: Install @react-pdf/renderer + register a self-hosted TTF + trace it** - `3b0c2d2` (feat)
2. **Task 2: ReportDocument tree + renderReportPdf (å/ä/ö smoke)** - `0b2cbc2` (feat)
3. **Task 3: downloadReportPdf login-gated action** - `a5f1b11` (test/RED) → `c48f82d` (feat/GREEN)

**Plan metadata:** (this commit) (docs: complete plan)

## Files Created/Modified
- `src/lib/report/pdf/fonts.ts` - `Font.register` of Open Sans via absolute `process.cwd()` path; exports `REPORT_FONT_FAMILY`.
- `src/lib/report/pdf/fonts/OpenSans-{Regular,SemiBold}.ttf` + `OFL.txt` - embedded font + its license.
- `src/lib/report/pdf/report-document.tsx` - the `ReportDocument` @react-pdf tree (D-11 order, D-12 trust treatment).
- `src/lib/report/pdf/render.ts` - `renderReportPdf` + `type ReportPdfData`; `renderToBuffer` wrapper, no synthesis/DB I/O.
- `src/lib/report/pdf/render.test.ts` - %PDF magic + non-empty, å/ä/ö smoke, ej_tillgänglig marker, static no-re-synthesis guard (5 tests).
- `src/actions/download-report-pdf.ts` - login-gated/ownership-checked download action returning a Blob.
- `src/actions/download-report-pdf.test.ts` - auth/IDOR/null/drift/happy-path (7 tests).
- `next.config.ts` - `outputFileTracingIncludes` extended with `./src/lib/report/pdf/fonts/*.ttf` (geojson preserved).
- `package.json` / `package-lock.json` - `@react-pdf/renderer` dependency.

## Decisions Made
- **Font = Open Sans (OFL)** static Regular + SemiBold from `googlefonts/opensans` — @fontsource ships only woff/woff2 and the Inter variable font does not register cleanly per-weight in react-pdf; static OFL TTFs are the clean fit. fontkit confirmed å/ä/ö/Å/Ä/Ö coverage before commit.
- **render.ts stays `.ts`** (per the plan's `files_modified`): the JSX tree lives in `report-document.tsx`; `render.ts` uses `React.createElement` so the file needs no `.tsx` rename.
- **No `serverExternalPackages` change** for react-pdf — confirmed against the real `next build` (Pitfall 4 / A1).
- **Blob-from-server-action** used directly (RESEARCH A2); the Route-Handler fallback was not needed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed `fontStyle: "italic"` from the "Ej tillgänglig" style**
- **Found during:** Task 2 (render test)
- **Issue:** The document styled the unavailable-marker text with `fontStyle: "italic"`, but only upright Open Sans Regular + SemiBold are registered. react-pdf threw `Could not resolve font for Open Sans, fontWeight 400, fontStyle italic` at render time — every render test failed.
- **Fix:** Dropped the italic style; the marker is distinguished by the muted colour instead (no italic TTF registered, and registering one is unnecessary scope).
- **Files modified:** src/lib/report/pdf/report-document.tsx
- **Verification:** All 5 render tests pass; %PDF buffer produced.
- **Committed in:** `0b2cbc2` (Task 2 commit)

**2. [Rule 3 - Blocking] render.ts JSX in a `.ts` file failed the oxc transform**
- **Found during:** Task 2 (render test)
- **Issue:** The plan lists `render.ts` (not `.tsx`); a JSX `<ReportDocument .../>` literal there failed vitest's oxc transform (`Expected '>' but found Identifier`).
- **Fix:** Use `React.createElement(ReportDocument, { data })` (cast to `ReactElement<DocumentProps>` for `renderToBuffer`'s type) — keeps the `.ts` extension the plan specifies; JSX stays in the `.tsx` document.
- **Files modified:** src/lib/report/pdf/render.ts
- **Verification:** vitest transforms cleanly; `npx tsc --noEmit` passes.
- **Committed in:** `0b2cbc2` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both were necessary to make the PDF render at all under the plan's chosen file layout/font. No scope creep — no extra font weights, no extra deps.

## Issues Encountered
- Initial font fetches from `@fontsource` (woff2-only) and `google/fonts` raw paths 404'd; resolved by sourcing static TTFs from `googlefonts/opensans/fonts/ttf` and verifying glyph coverage with the bundled fontkit before committing.

## Threat Surface Scan
No new trust-boundary surface beyond the plan's `<threat_model>`. The download action reuses the existing Supabase auth + RLS; T-04-17 (IDOR) is mitigated by the `row.user_id === user.id` guard and asserted by the IDOR test; T-04-19 (TTF dropped) is mitigated by the `outputFileTracingIncludes` entry; T-04-20 (re-synthesis) is mitigated and asserted (render.ts has no Anthropic/DB import; the action has no synthesis import). No `mitigate` disposition was left unimplemented.

## Known Stubs
None. All rendered content flows from the passed-in persisted `report_data`; the PDF degrades honestly (Ej tillgänglig / affordance) rather than rendering placeholder data.

## User Setup Required
None - no external service configuration required. (The 004_report.sql migration push remains human-gated per Plan 04-03; it is not introduced here.)

## Next Phase Readiness
- `downloadReportPdf` is ready to wire to a "Ladda ner PDF" button in the analysis page / `ai-report-section` (Plan 04-06 / page integration). It returns `{ ok: true, blob }`; the client triggers `URL.createObjectURL(blob)` + an anchor download.
- Render is verified deterministically; a visual review of the actual A4 layout (spacing, page breaks on a long report) is a reasonable manual check during the page-integration plan but is not blocking.

## Self-Check: PASSED

All 8 created source/asset files exist on disk; all 4 task commits (`3b0c2d2`, `0b2cbc2`, `a5f1b11`, `c48f82d`) are present in git history. Both plan test files green (12 tests), `npx tsc --noEmit` clean, `npm run build` succeeds.

---
*Phase: 04-ai-report-delivery*
*Completed: 2026-06-26*
