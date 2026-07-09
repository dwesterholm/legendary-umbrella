"use server";

import { createClient } from "@/lib/supabase/server";
import { safeParseBrfData, type BrfExtraction } from "@/lib/schemas/brf";
import {
  runBrfExtraction,
  scoreExtraction,
  METRIC_KEYS,
  type BrfData,
  type AnalyzeBrfResult,
} from "@/lib/brf/run-extraction";

// NOTE: do NOT re-export these types from this "use server" module. Turbopack's
// server-action loader (Next 16) enumerates `export type { … }` re-export
// SPECIFIERS as if they were server actions and emits
// `registerServerReference(BrfData, …)` against a type that has no runtime
// binding → `ReferenceError: BrfData is not defined` at import time. Importers
// pull these types directly from `@/lib/brf/run-extraction` instead. (Inline
// `export type Foo = …` aliases are safe — only the specifier form breaks.)

/** Server-side upload limit (D-14). */
const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * `analyzeBrf` — thin wrapper around the shared `runBrfExtraction` core
 * (D-05 auth gate → PDF-specific validation → delegate). Stays on the same
 * page (D-04 — no navigation away); the client polls `brf_status` for
 * progress (D-13). The manual-upload behavior is byte-identical to the
 * pre-refactor implementation — see `analyze-brf.test.ts` regression suite.
 *
 * @param formData - `analysisId` (string) and `file` (a PDF File)
 */
export async function analyzeBrf(formData: FormData): Promise<AnalyzeBrfResult> {
  const analysisId = formData.get("analysisId");
  const file = formData.get("file");

  if (typeof analysisId !== "string" || !analysisId) {
    return { ok: false, error: "Analys-id saknas." };
  }
  if (!(file instanceof File)) {
    return { ok: false, error: "Ingen fil bifogad." };
  }

  // Server-side input validation BEFORE any storage/Claude work (ASVS V5, T-02-11).
  if (file.type !== "application/pdf") {
    return { ok: false, error: "Filen måste vara en PDF." };
  }
  if (file.size > MAX_PDF_BYTES) {
    return { ok: false, error: "PDF:en är för stor (max 20 MB)." };
  }

  // Auth gate (D-05 HARD): no guest path — replace analyze.ts's guest-cookie allowance.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "Logga in för BRF-analys" };
  }

  // Ownership check (second layer behind RLS) — runBrfExtraction re-checks
  // this itself, but failing fast here avoids reading the file into memory
  // for a request that can never succeed.
  const { data: row, error: rowError } = await supabase
    .from("analyses")
    .select("id, user_id")
    .eq("id", analysisId)
    .single();

  if (rowError || !row || row.user_id !== user.id) {
    return { ok: false, error: "Analysen hittades inte." };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  return runBrfExtraction(analysisId, user.id, { kind: "pdf", bytes }, "manual");
}

/**
 * `correctBrfField` — D-12 inline correction. Re-runs the deterministic pipeline
 * (normalize → sanity → computeBrfGrade) on the stored extraction with ONE field
 * overridden by a user-supplied value. It NEVER calls Claude/extract again
 * (re-extraction is the RESEARCH anti-pattern — it would re-bill and could revert
 * the correction). The corrected field is marked "Manuellt angiven".
 *
 * Unchanged by the runBrfExtraction refactor — this action never touches
 * extraction and has no auto-fetch equivalent.
 *
 * @param formData - `analysisId`, `field` (one of the four metrics), `value`
 */
export async function correctBrfField(
  formData: FormData,
): Promise<AnalyzeBrfResult> {
  const analysisId = formData.get("analysisId");
  const field = formData.get("field");
  const rawValue = formData.get("value");

  if (typeof analysisId !== "string" || !analysisId) {
    return { ok: false, error: "Analys-id saknas." };
  }
  if (
    typeof field !== "string" ||
    !(METRIC_KEYS as readonly string[]).includes(field)
  ) {
    return { ok: false, error: "Okänt fält." };
  }

  // Auth-gated identically to analyzeBrf (D-05).
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "Logga in för BRF-analys" };
  }

  const { data: row, error: rowError } = await supabase
    .from("analyses")
    .select("id, user_id, brf_data")
    .eq("id", analysisId)
    .single();

  if (rowError || !row || row.user_id !== user.id) {
    return { ok: false, error: "Analysen hittades inte." };
  }
  // CR-01: re-validate the persisted JSONB before correcting/re-scoring it. A
  // malformed or shape-drifted row would crash the spread/dereference below;
  // treat it as "nothing to correct" rather than throwing.
  const current = safeParseBrfData(row.brf_data);
  if (!current) {
    return { ok: false, error: "Ingen analys att korrigera." };
  }

  const extraction: BrfExtraction = {
    ...current.extraction,
  };

  // Coerce the corrected value to the field's type. underhallsplanStatus is an
  // enum string; the others are numbers. A manual correction is, by definition,
  // high-confidence and human-sourced.
  const key = field as (typeof METRIC_KEYS)[number];
  if (key === "underhallsplanStatus") {
    const allowed = ["finns_aktuell", "finns_inaktuell", "saknas", "oklart"];
    const v = typeof rawValue === "string" ? rawValue : "";
    if (!allowed.includes(v)) {
      return { ok: false, error: "Ogiltigt värde för underhållsplan." };
    }
    extraction.underhallsplanStatus = {
      value: v as BrfExtraction["underhallsplanStatus"]["value"],
      confidence: 1,
      sourceQuote: null,
      pageRef: null,
    };
  } else {
    // WR-01: reject empty/whitespace-only input. Number("") and Number("  ")
    // are both 0 (finite), so without this guard clearing the editor would
    // silently persist a meaningless 0 marked "Manuellt angiven".
    const raw = typeof rawValue === "string" ? rawValue.trim() : "";
    if (raw === "") {
      return { ok: false, error: "Ogiltigt numeriskt värde." };
    }
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      return { ok: false, error: "Ogiltigt numeriskt värde." };
    }
    extraction[key] = {
      value: num,
      confidence: 1,
      sourceQuote: null,
      pageRef: null,
    };
  }

  const manualFields = Array.from(
    new Set([...(current.manualFields ?? []), field]),
  );

  // Re-run ONLY the deterministic pipeline — NO extractBrfFinancials call.
  // Pass manualFields so the corrected field's confidence stays authoritative
  // (WR-02) even when its value is outside the sanity band.
  const { normalized, grade, perFieldConfidence } = scoreExtraction(
    extraction,
    manualFields,
  );

  const brfData: BrfData = {
    ...current,
    extraction,
    normalized,
    grade,
    perFieldConfidence,
    manualFields,
  };

  const { error: persistError } = await supabase
    .from("analyses")
    .update({ brf_data: brfData })
    .eq("id", analysisId);

  if (persistError) {
    return { ok: false, error: "Kunde inte spara korrigeringen. Försök igen." };
  }

  return { ok: true, data: brfData, cached: false };
}
