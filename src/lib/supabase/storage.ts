import type { createClient } from "@/lib/supabase/server";

/**
 * Path-convention helpers for the private `brf-pdfs` bucket (RESEARCH Pattern 3).
 *
 * The bucket is private (`public = false`, migration 002) and guarded by per-user
 * RLS keyed on the first path segment: `(storage.foldername(name))[1] = auth.uid()`.
 * So the path MUST be `{userId}/{analysisId}.pdf` — this module is the single
 * place that convention lives, so the upload/download paths can never drift from
 * the RLS prefix. The caller passes the request-scoped `createClient()` instance
 * (reused, not re-created) so RLS applies under the logged-in user (D-05).
 */

/** The request-scoped Supabase server client (awaited `createClient()`). */
type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/** The private bucket holding user BRF årsredovisning PDFs. */
export const BRF_BUCKET = "brf-pdfs";

/** Builds the RLS-aligned storage key for a user's analysis PDF. */
export function brfPdfPath(userId: string, analysisId: string): string {
  return `${userId}/${analysisId}.pdf`;
}

/**
 * Uploads (or replaces) the BRF PDF for an analysis. `upsert: true` implements
 * the D-06 replace semantics — re-running on the same analysis overwrites the
 * stored bytes rather than erroring on a duplicate path.
 */
export function uploadBrfPdf(
  supabase: SupabaseServerClient,
  userId: string,
  analysisId: string,
  bytes: Uint8Array,
) {
  return supabase.storage
    .from(BRF_BUCKET)
    .upload(brfPdfPath(userId, analysisId), bytes, {
      contentType: "application/pdf",
      upsert: true,
    });
}

/** Downloads the stored BRF PDF for an analysis (RLS restricts to the owner). */
export function downloadBrfPdf(
  supabase: SupabaseServerClient,
  userId: string,
  analysisId: string,
) {
  return supabase.storage
    .from(BRF_BUCKET)
    .download(brfPdfPath(userId, analysisId));
}
