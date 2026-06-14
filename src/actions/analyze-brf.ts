"use server";

import { createHash } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { uploadBrfPdf } from "@/lib/supabase/storage";
import { extractBrfFinancials, type FieldCitation } from "@/lib/brf/extract";
import {
  brfExtractionSchema,
  normalizeBrfExtraction,
  safeParseBrfData,
  type BrfExtraction,
  type NormalizedBrf,
} from "@/lib/schemas/brf";
import { applySanityChecks, applyManualConfidence } from "@/lib/brf/sanity";
import { computeBrfGrade, type BrfScoreResult } from "@/lib/brf/score";
import { costSek } from "@/lib/brf/cost";

/** Hard per-analysis Claude budget (AI-SPEC §6 cost-cap guardrail). */
const COST_CAP_SEK = 5;

/** Server-side upload limit (D-14). */
const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20 MB

/** Persisted BRF payload: extraction + computed grade + per-field provenance. */
export interface BrfData {
  extraction: BrfExtraction;
  normalized: NormalizedBrf;
  grade: BrfScoreResult;
  /** Per-field confidence after sanity downgrade (D-10), keyed by metric. */
  perFieldConfidence: Record<string, number>;
  citations: FieldCitation[];
  /** Fields the user manually corrected (D-12) — rendered "Manuellt angiven". */
  manualFields?: string[];
}

/** Discriminated result returned to the client (mirrors AnalyzeResult style). */
export type AnalyzeBrfResult =
  | { ok: true; data: BrfData; cached: boolean; error?: undefined }
  | { ok: false; error: string; data?: undefined; cached?: undefined };

/** The four sanity-checkable / scorable metric keys. */
const METRIC_KEYS = [
  "skuldPerKvm",
  "avgiftsniva",
  "kassaflode",
  "underhallsplanStatus",
] as const;

/**
 * Heuristic scanned-PDF detector (D-14). A born-digital PDF carries a font
 * dictionary and extractable text operators; a pure image scan does not. We
 * cannot fully parse here, so we use a cheap byte-level heuristic: the presence
 * of `/Font` and text-showing operators (`Tj`/`TJ`) suggests real text. Absence
 * across the document is a strong scanned signal. Conservative: only flags when
 * there is clearly no text layer.
 */
function detectScanned(bytes: Uint8Array): boolean {
  const head = Buffer.from(
    bytes.subarray(0, Math.min(bytes.byteLength, 2_000_000)),
  ).toString("latin1");
  const hasFont = head.includes("/Font");
  const hasTextOp = /\bTj\b|\bTJ\b/.test(head);
  return !hasFont && !hasTextOp;
}

/** Content hash for the D-06 replace-identical skip-Claude cache. */
function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A minimal slice of the Supabase client this module needs (status writes). */
type StatusWriter = Awaited<ReturnType<typeof createClient>>;

/**
 * Writes the terminal `failed` status and makes its failure observable (WR-04).
 *
 * `BrfProgress` only stops polling on a terminal status (`done`/`failed`), so a
 * silently-dropped `failed` write leaves the client spinning forever. We log
 * the DB error server-side (no financials/bytes — only ids, per T-02-12/GDPR)
 * so a stuck poller is diagnosable rather than invisible.
 */
async function writeFailedStatus(
  supabase: StatusWriter,
  analysisId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await supabase
    .from("analyses")
    .update({ brf_status: "failed", ...extra })
    .eq("id", analysisId);
  if (error) {
    // The terminal write itself failed — surface it so the stuck poller is
    // explainable. Never log the document contents (GDPR).
    console.error("[analyzeBrf] terminal failed-status write did not land", {
      analysisId,
      code: error.code,
      message: error.message,
    });
  }
}

/**
 * Runs the deterministic pipeline: sanity → grade → per-field confidence map.
 *
 * `manualFields` (D-12): fields the user explicitly entered are authoritative —
 * the GRADE is still re-scored deterministically from the value, but the
 * stored `perFieldConfidence` for a manual field is NOT subject to the sanity
 * downgrade. A user who deliberately enters an out-of-band figure should not
 * have their own input flagged "Osäker" (WR-02 — manual = authoritative).
 */
function scoreExtraction(
  extraction: BrfExtraction,
  manualFields: readonly string[] = [],
): {
  normalized: NormalizedBrf;
  grade: BrfScoreResult;
  perFieldConfidence: Record<string, number>;
} {
  // Sanity-downgrade out-of-band numeric fields (D-10) WITHOUT dropping values.
  const sanitized = applySanityChecks({
    skuldPerKvm: {
      value: extraction.skuldPerKvm.value,
      confidence: extraction.skuldPerKvm.confidence,
    },
    avgiftsniva: {
      value: extraction.avgiftsniva.value,
      confidence: extraction.avgiftsniva.confidence,
    },
  });

  const sanityConfidence: Record<string, number> = {
    skuldPerKvm: sanitized.skuldPerKvm?.confidence ?? extraction.skuldPerKvm.confidence,
    avgiftsniva: sanitized.avgiftsniva?.confidence ?? extraction.avgiftsniva.confidence,
    kassaflode: extraction.kassaflode.confidence,
    underhallsplanStatus: extraction.underhallsplanStatus.confidence,
  };

  // WR-02: a manually-corrected field is human-sourced and authoritative — its
  // confidence wins over any sanity band downgrade. The value still flows
  // through normalize/computeBrfGrade unchanged, so the GRADE stays deterministic.
  const perFieldConfidence = applyManualConfidence(sanityConfidence, manualFields);

  const normalized = normalizeBrfExtraction(extraction);
  const grade = computeBrfGrade(normalized);
  return { normalized, grade, perFieldConfidence };
}

/**
 * `analyzeBrf` — the BRF analysis spine (D-05 → store → D-06 skip → extract →
 * normalize → sanity → grade → persist with status + cost). Stays on the same
 * page (D-04 — no navigation away); the client polls `brf_status` for progress (D-13).
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

  // Ownership check (second layer behind RLS). Also fetches the prior hash/data
  // for the D-06 skip decision.
  const { data: row, error: rowError } = await supabase
    .from("analyses")
    .select("id, user_id, brf_pdf_hash, brf_data")
    .eq("id", analysisId)
    .single();

  if (rowError || !row || row.user_id !== user.id) {
    return { ok: false, error: "Analysen hittades inte." };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentHash = hashBytes(bytes);
  const scanned = detectScanned(bytes);

  // D-06 replace-identical cache: same content hash + an existing extraction →
  // skip the Claude call entirely and return the stored result (no re-bill).
  // CR-01: re-validate the persisted JSONB before reusing it — a malformed or
  // shape-drifted row must NOT be returned as an authoritative result; fall
  // through to a fresh extraction instead.
  if (row.brf_pdf_hash === contentHash) {
    const cached = safeParseBrfData(row.brf_data);
    if (cached) {
      return { ok: true, data: cached, cached: true };
    }
  }

  // Store the PDF privately (upsert = D-06 replace). Path is {userId}/{analysisId}.pdf.
  const { error: uploadError } = await uploadBrfPdf(
    supabase,
    user.id,
    analysisId,
    bytes,
  );
  if (uploadError) {
    return { ok: false, error: "Kunde inte spara PDF:en. Försök igen." };
  }

  // Status → extracting (D-13). The client polls this column. WR-03: the
  // earlier reading→extracting double-write was a dead flicker (no work between
  // the two awaited writes, and the 1.5s poller never observes `reading`), so
  // we write the single meaningful pre-call state once. The scanned flag rides
  // along on this write.
  await supabase
    .from("analyses")
    .update({ brf_status: "extracting", brf_scanned: scanned })
    .eq("id", analysisId);

  // The single Claude call. Guardrails (§6): parse failures retry once inside
  // extract.ts; refusal/truncation throw a Swedish message — route to manual entry.
  let extraction: BrfExtraction;
  let citations: FieldCitation[];
  let cost: number;
  try {
    const result = await extractBrfFinancials({ bytes, contentHash });
    cost = costSek(result.usage);

    // Cost-cap guardrail (§6): never persist a run that blew the budget; surface
    // it rather than silently billing. (Bounded retries + caching keep this rare.)
    if (cost > COST_CAP_SEK) {
      await writeFailedStatus(supabase, analysisId, { brf_cost_sek: cost });
      return {
        ok: false,
        error: "Analysen avbröts (kostnadstaket nåddes). Försök igen senare.",
      };
    }

    // Schema gate (§6): never present partial/unparsed JSON as a result.
    const parsed = brfExtractionSchema.safeParse(result.parsed);
    if (!parsed.success) {
      throw new Error("BRF_SCHEMA_INVALID");
    }
    extraction = parsed.data;
    citations = result.citations;
  } catch (error) {
    // WR-06: preserve the distinct failure reason. extract.ts now rethrows a
    // coded error (CLAUDE_REFUSAL / CLAUDE_MAX_TOKENS / CLAUDE_PARSE_EMPTY /
    // CLAUDE_CALL_FAILED), and the schema gate throws BRF_SCHEMA_INVALID. Log
    // the CODE + content hash only (never raw financials/bytes/quotes, per
    // T-02-12/GDPR) so refusal vs truncation vs network failure are
    // distinguishable in server logs.
    console.error("[analyzeBrf] extraction failed", {
      analysisId,
      contentHash,
      code: error instanceof Error ? error.message : "UNKNOWN",
    });
    await writeFailedStatus(supabase, analysisId);
    return {
      ok: false,
      error:
        "Vi kunde inte läsa dokumentet automatiskt — fyll i uppgifterna manuellt.",
    };
  }

  // Deterministic pipeline (D-08): sanity → grade. Status → scoring.
  await supabase
    .from("analyses")
    .update({ brf_status: "scoring" })
    .eq("id", analysisId);

  const { normalized, grade, perFieldConfidence } = scoreExtraction(extraction);

  const brfData: BrfData = {
    extraction,
    normalized,
    grade,
    perFieldConfidence,
    citations,
  };

  // Persist final result + status done + cost + content hash (D-06) + scanned flag.
  // GDPR: do NOT log the financials/quotes; only the hash + usage were logged in extract.ts.
  const { error: persistError } = await supabase
    .from("analyses")
    .update({
      brf_data: brfData,
      brf_status: "done",
      brf_cost_sek: cost,
      brf_pdf_hash: contentHash,
      brf_scanned: scanned,
    })
    .eq("id", analysisId);

  if (persistError) {
    return { ok: false, error: "Kunde inte spara analysen. Försök igen." };
  }

  return { ok: true, data: brfData, cached: false };
}

/**
 * `correctBrfField` — D-12 inline correction. Re-runs the deterministic pipeline
 * (normalize → sanity → computeBrfGrade) on the stored extraction with ONE field
 * overridden by a user-supplied value. It NEVER calls Claude/extract again
 * (re-extraction is the RESEARCH anti-pattern — it would re-bill and could revert
 * the correction). The corrected field is marked "Manuellt angiven".
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
