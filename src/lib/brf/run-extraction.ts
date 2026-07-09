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

/**
 * run-extraction.ts — the shared BRF extraction/scoring core (D-06 hash
 * cache, cost-cap, sanity, A–F grade, terminal persist). Extracted from the
 * original `analyzeBrf` action body (Phase 4) so BOTH the manual-upload path
 * (`src/actions/analyze-brf.ts`) and the Phase 8 auto-fetch path
 * (`fetch-brf-auto.ts`, Plan 03) run the IDENTICAL pipeline regardless of
 * where the source document came from (ENRICH-01 success criterion 1).
 *
 * The ONLY fork point is `source.kind`:
 *  - "pdf": detectScanned + hashBytes + uploadBrfPdf (unchanged from the
 *    pre-refactor manual path).
 *  - "ixbrl-text": brf_scanned is hard-set false (iXBRL is always digitally
 *    native, never a scan), the content hash is taken over the UTF-8 text,
 *    and `uploadBrfPdf` is skipped entirely — v1 does not store the raw
 *    fetched HTML, only the extracted result + text hash (08-PATTERNS.md).
 *
 * SECURITY (T-08-03): `runBrfExtraction` performs NO auth/ownership check
 * itself — the auth gate (D-05) and the `row.user_id === user.id` ownership
 * check MUST be performed by every caller BEFORE invoking this function. Both
 * the manual `analyzeBrf` wrapper and Plan 03's auto-fetch actions duplicate
 * that gate identically; this function trusts its caller.
 */

/** Hard per-analysis Claude budget (AI-SPEC §6 cost-cap guardrail). */
export const COST_CAP_SEK = 5;

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
  /**
   * The fetched document's fiscal year (ROADMAP Success Criterion 4 /
   * ENRICH-02). `null`/absent on the manual-upload path (no auto-detected
   * fiscal year) and on any row predating this field. Additive-optional so
   * existing persisted `brf_data` JSONB rows continue to parse (CR-01).
   */
  fiscalYear?: number | null;
  /**
   * Staleness flag for `fiscalYear` — `false` when a newer årsredovisning is
   * knowably available, `true` when the fetched year is the newest known,
   * `null`/absent when unknown (never fabricated "most recent", Pitfall 5).
   */
  isMostRecent?: boolean | null;
}

/** Optional fetch-time metadata threaded from `FetchedDocument` (auto-fetch only). */
export interface BrfFetchMeta {
  fiscalYear: number | null;
  isMostRecent: boolean | null;
}

/** Discriminated result returned to the client (mirrors AnalyzeResult style). */
export type AnalyzeBrfResult =
  | { ok: true; data: BrfData; cached: boolean; error?: undefined }
  | { ok: false; error: string; data?: undefined; cached?: undefined };

/**
 * The document source union threaded through `extract.ts` and this module.
 * "pdf" is the existing manual-upload shape; "ixbrl-text" is the Phase 8
 * auto-fetch shape (iXBRL/HTML already stripped to plain text by
 * `ixbrlToPlainText`, see `src/lib/brf/ixbrl-to-text.ts`).
 */
export type BrfDocumentSource =
  | { kind: "pdf"; bytes: Uint8Array }
  | { kind: "ixbrl-text"; text: string };

/** Provenance of the source document, persisted as `brf_fetch_source`. */
export type BrfFetchSource = "manual" | "auto_bolagsverket" | "auto_allabrf";

/** The four sanity-checkable / scorable metric keys. */
export const METRIC_KEYS = [
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

/** Content hash for the D-06 replace-identical skip-Claude cache (PDF bytes). */
function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Content hash for the D-06 cache over iXBRL-derived text (UTF-8). */
function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A minimal slice of the Supabase client this module needs (status writes). */
export type StatusWriter = Awaited<ReturnType<typeof createClient>>;

/**
 * Writes the terminal `failed` status and makes its failure observable (WR-04).
 *
 * `BrfProgress` only stops polling on a terminal status (`done`/`failed`), so a
 * silently-dropped `failed` write leaves the client spinning forever. We log
 * the DB error server-side (no financials/bytes — only ids, per T-02-12/GDPR)
 * so a stuck poller is diagnosable rather than invisible.
 */
export async function writeFailedStatus(
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
    console.error("[runBrfExtraction] terminal failed-status write did not land", {
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
export function scoreExtraction(
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
 * `runBrfExtraction` — the shared BRF analysis spine (D-06 skip → extract →
 * normalize → sanity → grade → persist with status + cost + provenance).
 *
 * PRECONDITION (T-08-03): the caller MUST have already verified
 * `row.user_id === user.id` for `analysisId` — this function performs no
 * auth/ownership check of its own.
 *
 * @param analysisId - the target `analyses` row id
 * @param userId - the authenticated user's id (used only for PDF storage path)
 * @param source - the document, either raw PDF bytes or iXBRL-derived text
 * @param fetchSource - provenance, persisted as `brf_fetch_source`
 * @param fetchMeta - optional auto-fetch fiscal-year/staleness metadata
 *   (ROADMAP Success Criterion 4). Absent on the manual path — there is no
 *   auto-detected fiscal year for a manually uploaded PDF, so `BrfData`
 *   simply carries no `fiscalYear`/`isMostRecent` in that case.
 */
export async function runBrfExtraction(
  analysisId: string,
  userId: string,
  source: BrfDocumentSource,
  fetchSource: BrfFetchSource,
  fetchMeta?: BrfFetchMeta,
): Promise<AnalyzeBrfResult> {
  const supabase = await createClient();

  const { data: row, error: rowError } = await supabase
    .from("analyses")
    .select("id, user_id, brf_pdf_hash, brf_data")
    .eq("id", analysisId)
    .single();

  if (rowError || !row || row.user_id !== userId) {
    return { ok: false, error: "Analysen hittades inte." };
  }

  const contentHash =
    source.kind === "pdf" ? hashBytes(source.bytes) : hashText(source.text);
  const scanned = source.kind === "pdf" ? detectScanned(source.bytes) : false;

  // D-06 replace-identical cache: same content hash + an existing extraction →
  // skip the Claude call entirely and return the stored result (no re-bill).
  // CR-01: re-validate the persisted JSONB before reusing it — a malformed or
  // shape-drifted row must NOT be returned as an authoritative result; fall
  // through to a fresh extraction instead.
  if (row.brf_pdf_hash === contentHash) {
    const cached = safeParseBrfData(row.brf_data);
    if (cached) {
      // BL-4 (PR #1 review): this early return previously left `brf_status`
      // untouched. When the caller (`confirmAndAnalyze`) has CAS-locked the row
      // to `auto_fetching`, that leaves it pinned there forever — the client's
      // `brf_status` poller (its ONLY success signal) spins to a false-failure
      // timeout, and every future CAS acquire (predicate excludes
      // `auto_fetching`/`done`) wedges at "hämtning pågår redan". Advance to the
      // terminal `done` state (recording this fetch's provenance) so both the
      // poller and the CAS settle, exactly as the full-extraction path does.
      const { error: statusError } = await supabase
        .from("analyses")
        .update({ brf_status: "done", brf_fetch_source: fetchSource })
        .eq("id", analysisId);
      if (statusError) {
        await writeFailedStatus(supabase, analysisId);
        return { ok: false, error: "Kunde inte spara analysen. Försök igen." };
      }
      return { ok: true, data: cached, cached: true };
    }
  }

  if (source.kind === "pdf") {
    // Store the PDF privately (upsert = D-06 replace). Path is {userId}/{analysisId}.pdf.
    const { error: uploadError } = await uploadBrfPdf(
      supabase,
      userId,
      analysisId,
      source.bytes,
    );
    if (uploadError) {
      // WR-04: the client switched to the progress view optimistically and is
      // already polling brf_status. Without a terminal write the poller spins
      // on step 1 forever. Write `failed` so the poll terminates and a reload
      // shows the failure.
      await writeFailedStatus(supabase, analysisId);
      return { ok: false, error: "Kunde inte spara PDF:en. Försök igen." };
    }
  }
  // "ixbrl-text": no raw-HTML storage in v1 (08-PATTERNS.md) — only the
  // extracted result + text hash are persisted, in the terminal write below.

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
    const result = await extractBrfFinancials(
      source.kind === "pdf"
        ? { kind: "pdf", bytes: source.bytes, contentHash }
        : { kind: "ixbrl-text", text: source.text, contentHash },
    );
    cost = costSek(result.usage);

    // Cost guardrail (§6) — HONEST scope (CR-02): this is NOT a pre-call spend
    // cap. The token count (and thus cost) is unknown until AFTER the Claude
    // call returns, so this check gates PERSISTENCE of an over-budget result,
    // not the spend itself. Per-REQUEST spend is already inherently bounded by
    // the single Haiku call at `max_tokens: 2048` (+ one truncation retry),
    // observed at ~0.71 SEK — well under COST_CAP_SEK. What is NOT bounded here
    // is per-USER aggregate spend: a script hitting this authenticated action
    // repeatedly bills each call in full. A per-user rate limit / DoS guard is
    // a deferred follow-up (out of scope for this phase — see REVIEW.md CR-02).
    // WR-04 (shard-4 review): a drifted SDK usage shape can make `cost` NaN,
    // and `NaN > COST_CAP_SEK` is false — silently BYPASSING the cost gate and
    // persisting `brf_cost_sek: NaN`. Fail closed on a non-finite cost, and
    // never persist NaN.
    if (!Number.isFinite(cost) || cost > COST_CAP_SEK) {
      await writeFailedStatus(supabase, analysisId, {
        brf_cost_sek: Number.isFinite(cost) ? cost : null,
      });
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
    console.error("[runBrfExtraction] extraction failed", {
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
    // ROADMAP Success Criterion 4: carry the auto-fetch fiscal-year/staleness
    // signal into the persisted payload. `fetchMeta` is undefined on the
    // manual path, so both fields are simply absent (BrfData's optional
    // fields, not fabricated nulls-as-data).
    ...(fetchMeta ? { fiscalYear: fetchMeta.fiscalYear, isMostRecent: fetchMeta.isMostRecent } : {}),
  };

  // Persist final result + status done + cost + content hash (D-06) + scanned
  // flag + provenance. GDPR: do NOT log the financials/quotes; only the hash +
  // usage were logged in extract.ts.
  const { error: persistError } = await supabase
    .from("analyses")
    .update({
      brf_data: brfData,
      brf_status: "done",
      brf_cost_sek: cost,
      brf_pdf_hash: contentHash,
      brf_scanned: scanned,
      brf_fetch_source: fetchSource,
    })
    .eq("id", analysisId);

  if (persistError) {
    // The terminal `done` write failed, leaving brf_status pinned at `scoring`
    // (the poller would hang on step 3). Release it to `failed` so the poll
    // terminates and the user can retry. Preserve the incurred Claude cost.
    await writeFailedStatus(supabase, analysisId, { brf_cost_sek: cost });
    return { ok: false, error: "Kunde inte spara analysen. Försök igen." };
  }

  return { ok: true, data: brfData, cached: false };
}
