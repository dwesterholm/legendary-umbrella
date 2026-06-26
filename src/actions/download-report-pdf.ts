"use server";

import { createClient } from "@/lib/supabase/server";
import { safeParseReportData } from "@/lib/schemas/report";
import { renderReportPdf } from "@/lib/report/pdf/render";

/**
 * download-report-pdf.ts — the login-gated (D-09), download-only (D-10) PDF
 * action (RPRT-03). Mirrors the auth/ownership posture of analyze-brf.ts
 * (174-193); the binary return is the only new part (RESEARCH §Pattern 1).
 *
 * SINGLE SOURCE OF TRUTH (D-11): this action loads the ALREADY-PERSISTED
 * `report_data` and renders it — it NEVER re-runs the Sonnet synthesis (no
 * synthesis / Anthropic import here) and never re-fetches the source data. The
 * PDF is the exact snapshot the page shows, never a fresh (double-billed)
 * generation.
 *
 * The PDF is rendered on demand and returned to the browser as a Blob for an
 * `URL.createObjectURL` download (RESEARCH Pitfall 6) — never stored, never
 * hosted, no public link (D-10). If the Blob return proves awkward in Next 16
 * (RESEARCH Open Q2 / A2), the documented fallback is a
 * `GET /api/analysis/[id]/report.pdf` Route Handler carrying the SAME auth
 * guard; not needed unless the build surfaces it.
 */

/** Discriminated result: a PDF Blob on success, a Swedish error otherwise. */
export type DownloadReportPdfResult =
  | { ok: true; blob: Blob; error?: undefined }
  | { ok: false; error: string };

/**
 * `downloadReportPdf` — render the persisted report for `analysisId` to a PDF
 * and return its bytes for client-side download. Login-gated + ownership-checked
 * (D-09); degrades a missing/drifted report to an affordance (D-11 read-path);
 * renders the persisted data only (no re-synthesis, D-11).
 *
 * @param analysisId - the analyses row to render (must belong to the caller)
 */
export async function downloadReportPdf(
  analysisId: string,
): Promise<DownloadReportPdfResult> {
  if (typeof analysisId !== "string" || !analysisId) {
    return { ok: false, error: "Analys-id saknas." };
  }

  // Auth gate (D-09 HARD): no guest path — mirrors analyze-brf.ts:175-181.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "Logga in för att ladda ner rapporten" };
  }

  // Ownership check (second layer behind RLS — T-04-17). A row belonging to
  // another user (IDOR) or a missing row returns "hittades inte" — no
  // cross-user PDF leak, and we never reach the renderer.
  const { data: row, error: rowError } = await supabase
    .from("analyses")
    .select("id, user_id, report_data")
    .eq("id", analysisId)
    .single();

  if (rowError || !row || row.user_id !== user.id) {
    return { ok: false, error: "Analysen hittades inte." };
  }

  // Read-path guard (CR-01 / D-11): re-validate the persisted report_data. A
  // null/undefined or shape-drifted row degrades to a "not generated yet"
  // affordance — never a crash, never a render of garbage.
  const reportData = safeParseReportData(row.report_data);
  if (!reportData) {
    return {
      ok: false,
      error: "Rapporten är inte genererad ännu. Skapa en AI-rapport först.",
    };
  }

  // Render the persisted snapshot ONLY (no re-synthesis, no re-fetch — D-11).
  let buffer: Buffer;
  try {
    buffer = await renderReportPdf({
      report: reportData.report,
      flags: reportData.flags,
      model: reportData.model,
      promptVersion: reportData.promptVersion,
    });
  } catch (error) {
    // GDPR / AI-SPEC §7: log ONLY { analysisId, code } — never the report prose.
    const code = error instanceof Error ? error.message : "UNKNOWN";
    console.error("[downloadReportPdf]", { analysisId, code });
    return {
      ok: false,
      error: "Kunde inte skapa PDF:en just nu. Försök igen senare.",
    };
  }

  // Return the bytes to the client as a Blob; the browser triggers the download
  // via URL.createObjectURL (RESEARCH Pitfall 6). A Uint8Array view avoids
  // assuming a Node Buffer is directly Blob-constructible on every runtime.
  const blob = new Blob([new Uint8Array(buffer)], {
    type: "application/pdf",
  });
  return { ok: true, blob };
}
