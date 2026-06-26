"use server";

import { createHash } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { safeParseBrfData } from "@/lib/schemas/brf";
import { listingDataSchema } from "@/lib/schemas/listing";
import { safeParsePriceData } from "@/lib/market/sold-schema";
import { safeParseAreaData } from "@/lib/market/scb";
import {
  computeFlags,
  type FlagBrfInput,
  type FlagPriceInput,
  type FlagSoftSignals,
} from "@/lib/report/flags";
import { assembleFactSheet } from "@/lib/report/fact-sheet";
import { synthesizeReport } from "@/lib/report/synthesize";
import { reportSchema } from "@/lib/schemas/report";
import { REPORT_SYNTHESIS_PROMPT_VERSION } from "@/lib/report/prompt";
import { costSekSonnet } from "@/lib/brf/cost";

/**
 * Hard per-report Sonnet budget (AI-SPEC §6 / RESEARCH Pitfall 3). Mirrors the
 * Phase-2 `COST_CAP_SEK = 5` in analyze-brf.ts — a post-call PERSISTENCE gate,
 * not a pre-call spend cap (the spend is bounded by the single Sonnet call at
 * `max_tokens: 4096` + one truncation retry). Cost is computed with
 * `costSekSonnet` (Sonnet $3/$15), NOT the Haiku `costSek`.
 */
const COST_CAP_SEK = 5;

/**
 * Stale-lock window (WR-05). A `generating` row whose lock was acquired longer
 * ago than this is presumed dead (the process crashed/timed out between
 * acquiring the lock and writing a terminal status) and is reclaimable — the
 * atomic CAS acquire below allows re-locking it so the report can be
 * re-generated rather than wedging on `generating` forever. Comfortably longer
 * than one Sonnet call + one truncation retry.
 */
const STALE_LOCK_MS = 5 * 60 * 1000;

/** The model id the report is generated with — persisted for trace (AI-SPEC §7). */
const REPORT_MODEL = "claude-sonnet-4-6";

/** Discriminated result returned to the client (mirrors AnalyzeBrfResult style). */
export type GenerateReportResult =
  | { ok: true; error?: undefined }
  | { ok: false; error: string };

/** A minimal slice of the Supabase client this module needs (status writes). */
type StatusWriter = Awaited<ReturnType<typeof createClient>>;

/**
 * Writes the terminal `failed` report status and makes its failure observable.
 *
 * The analysis page polls `report_status` and only stops on a terminal status
 * (`done`/`failed`); a silently-dropped `failed` write leaves the client
 * spinning. We log only `{ analysisId, code }` (never the fact sheet / report
 * prose, AI-SPEC §7 / GDPR) so a stuck poller stays diagnosable. Mirrors
 * `writeFailedStatus` in analyze-brf.ts:82-100.
 */
async function writeFailedStatus(
  supabase: StatusWriter,
  analysisId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await supabase
    .from("analyses")
    .update({ report_status: "failed", ...extra })
    .eq("id", analysisId);
  if (error) {
    console.error("[generateReport] terminal failed-status write did not land", {
      analysisId,
      code: error.code,
    });
  }
}

/**
 * Maps the persisted, `safeParse`d BRF payload onto the deterministic flag
 * engine's numeric input. Null source → null (no flag fabricated, D-07).
 */
function toFlagBrf(
  brf: ReturnType<typeof safeParseBrfData>,
): FlagBrfInput | null {
  if (!brf) return null;
  return {
    skuldPerKvm: brf.normalized.skuldPerKvm,
    avgiftsniva: brf.normalized.avgiftsniva,
    kassaflode: brf.normalized.kassaflode,
  };
}

/**
 * Maps the persisted, `safeParse`d price payload onto the deterministic flag
 * engine's price input. `source_unavailable` is NOT a flag-eligible reason
 * (the flag engine only raises a flag on `reason === "ok"`), so it degrades to
 * `"thin"` here — the price flag is suppressed either way, and the
 * `FlagPriceInput` reason type stays satisfied.
 */
function toFlagPrice(
  price: ReturnType<typeof safeParsePriceData>,
): FlagPriceInput | null {
  if (!price) return null;
  const reason: FlagPriceInput["reason"] =
    price.reason === "source_unavailable" ? "thin" : price.reason;
  return {
    reason,
    deltaPct: price.deltaPct,
    sampleSize: price.sampleSize,
  };
}

/**
 * Lifts the cited soft signals off the persisted BRF extraction (D-02/D-03).
 * The enum signal can feed a deterministic flag; the two free-text signals are
 * narration context only. Each `extractedField` already carries the
 * `{ value, confidence, sourceQuote, pageRef }` shape `SoftSignalField` needs.
 */
function toSoftSignals(
  brf: ReturnType<typeof safeParseBrfData>,
): FlagSoftSignals | null {
  if (!brf) return null;
  const e = brf.extraction;
  return {
    stambytePlanerat: e.stambytePlanerat,
    storreRenoveringar: e.storreRenoveringar,
    ovrigaAnmarkningar: e.ovrigaAnmarkningar,
  };
}

/** Swedish, action-layer message for each synthesis failure code (WR-06). */
function messageForCode(code: string): string {
  switch (code) {
    case "CLAUDE_REFUSAL":
      return "AI-rapporten kunde inte skapas just nu. Försök igen senare.";
    case "CLAUDE_MAX_TOKENS":
    case "CLAUDE_PARSE_EMPTY":
      return "AI-rapporten blev ofullständig. Försök igen.";
    default:
      return "Vi kunde inte skapa AI-rapporten just nu. Försök igen senare.";
  }
}

/**
 * `generateReport` — the login-gated (D-09), manual-trigger (D-07) report
 * orchestrator (RPRT-01). Mirrors analyze-brf.ts exactly: auth + ownership →
 * in-flight lock → load + `safeParse` the four sources → deterministic flags →
 * assemble the stable-key fact sheet → ONE Sonnet synthesis call → Sonnet-rated
 * cost cap → validate-on-write → sha256 fingerprint (D-08) → persist
 * report_data + status + cost + fingerprint + prompt version.
 *
 * In-flight lock (RESEARCH Pitfall 5 / T-04-14): the row's `report_status` is
 * set to `generating` BEFORE the Sonnet call; a concurrent run that observes an
 * already-`generating` row short-circuits to avoid double-spending the priciest
 * call.
 *
 * @param analysisId - the analyses row to report on (must belong to the caller)
 */
export async function generateReport(
  analysisId: string,
): Promise<GenerateReportResult> {
  if (typeof analysisId !== "string" || !analysisId) {
    return { ok: false, error: "Analys-id saknas." };
  }

  // Auth gate (D-09 HARD): no guest path — mirrors analyze-brf.ts:175-181.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "Logga in för AI-rapport" };
  }

  // Ownership check (second layer behind RLS — T-04-13). Also reads the prior
  // report_status for the in-flight-lock decision and the four source columns.
  const { data: row, error: rowError } = await supabase
    .from("analyses")
    .select(
      "id, user_id, report_status, report_generating_started_at, listing_data, brf_data, price_data, area_data",
    )
    .eq("id", analysisId)
    .single();

  if (rowError || !row || row.user_id !== user.id) {
    return { ok: false, error: "Analysen hittades inte." };
  }

  // In-flight lock (WR-01 / WR-05, T-04-14 / RESEARCH Pitfall 5). The acquire
  // is an ATOMIC compare-and-swap: a single conditional UPDATE that only flips
  // a row to `generating` when it is NOT already actively locked, then RETURNS
  // the affected row. This closes the TOCTOU double-spend window — two
  // concurrent calls cannot both pass a read-then-write guard, because the DB
  // serialises the conditional update and exactly one of them gets the row back.
  //
  // WR-05 stale-lock reclamation: a `generating` row whose lock is older than
  // STALE_LOCK_MS (process died mid-synthesis) is reclaimable, so we only
  // refuse when the row is `generating` AND its lock is still fresh. We compute
  // the "fresh lock" cutoff in app code and exclude rows locked after it.
  const staleCutoffIso = new Date(Date.now() - STALE_LOCK_MS).toISOString();
  const nowIso = new Date().toISOString();

  // Refuse up-front if a FRESH lock is already held (a live concurrent run).
  // This is a fast, friendly path; the CAS below is the authoritative guard.
  if (
    row.report_status === "generating" &&
    typeof row.report_generating_started_at === "string" &&
    row.report_generating_started_at > staleCutoffIso
  ) {
    return {
      ok: false,
      error: "En AI-rapport genereras redan. Vänta ett ögonblick.",
    };
  }

  // Atomic CAS acquire BEFORE the Sonnet call. The page polls report_status.
  // `.not("report_status", "eq", "generating")` OR a stale lock would be ideal
  // as one predicate, but PostgREST cannot express "stale OR not-generating" in
  // a single .neq; we instead acquire when the row is NOT generating, and the
  // stale-row case is handled by first clearing a stale lock, below.
  if (
    row.report_status === "generating" &&
    (typeof row.report_generating_started_at !== "string" ||
      row.report_generating_started_at <= staleCutoffIso)
  ) {
    // Reclaim a stale lock atomically: only succeeds if the row is STILL
    // pinned to the exact stale timestamp we observed (no live run has since
    // re-acquired it). If someone else reclaimed first, `reclaimed` is null and
    // we fall through to the standard CAS, which will then refuse.
    await supabase
      .from("analyses")
      .update({ report_status: "failed" })
      .eq("id", analysisId)
      .eq("report_status", "generating")
      .eq(
        "report_generating_started_at",
        row.report_generating_started_at as string,
      );
  }

  // The authoritative atomic acquire: flip to `generating` only when the row is
  // NOT currently `generating`, and return the affected row so we can detect a
  // lost race. If the update writes zero rows (`locked` is null), a concurrent
  // run holds the lock — refuse rather than double-spend.
  const { data: locked, error: lockErr } = await supabase
    .from("analyses")
    .update({
      report_status: "generating",
      report_generating_started_at: nowIso,
    })
    .eq("id", analysisId)
    .neq("report_status", "generating")
    .select("id")
    .maybeSingle();
  if (lockErr) {
    // Fail closed: never proceed to spend on Sonnet if the lock write errored
    // (RLS / transient DB error). GDPR: log only { analysisId, code }.
    console.error("[generateReport] lock acquire failed", {
      analysisId,
      code: lockErr.code,
    });
    return {
      ok: false,
      error: "Vi kunde inte starta AI-rapporten just nu. Försök igen senare.",
    };
  }
  if (!locked) {
    return {
      ok: false,
      error: "En AI-rapport genereras redan. Vänta ett ögonblick.",
    };
  }

  // safeParse the four sources INDEPENDENTLY — a malformed/partial source
  // degrades to null (no flag fabricated), never throws (D-07).
  const parsedListing = listingDataSchema.safeParse(row.listing_data);
  const listing = parsedListing.success ? parsedListing.data : null;
  const brf = safeParseBrfData(row.brf_data);
  const price = safeParsePriceData(row.price_data);
  const area = safeParseAreaData(row.area_data);

  // Deterministic flags + cited soft signals (pure TS — D-01a/D-03).
  const softSignals = toSoftSignals(brf);
  const flags = computeFlags({
    brf: toFlagBrf(brf),
    price: toFlagPrice(price),
    softSignals,
  });

  // The single stable-key-order fact sheet (the synthesis input AND the
  // fingerprint input — D-08).
  const factSheet = assembleFactSheet({
    listing,
    brf,
    price,
    area,
    flags,
    softSignals,
  });

  // ---- The single Sonnet synthesis call -----------------------------------
  let parsed;
  // WR-03: `sek` is hoisted and starts null so the catch can persist the cost we
  // ACTUALLY incurred. If the Sonnet call returned (we have usage) but
  // reportSchema.parse then throws on drifted output, the call was still billed
  // — we must record that spend, not silently under-count the failure mode most
  // likely to be retried + re-billed.
  let sek: number | null = null;
  try {
    const result = await synthesizeReport({ factSheet, analysisId });

    // Cost guard (post-call persistence gate, NOT a pre-call cap) — RESEARCH
    // Pitfall 3 / T-04-16: Sonnet-rated cost feeds the 5 SEK budget. An
    // over-cap result writes `failed` and aborts persistence (no silent
    // overspend persisted as a usable report).
    sek = costSekSonnet(result.usage);
    if (sek > COST_CAP_SEK) {
      await writeFailedStatus(supabase, analysisId, { report_cost_sek: sek });
      return {
        ok: false,
        error: "Rapporten avbröts (kostnadstaket nåddes). Försök igen senare.",
      };
    }

    // Validate-on-write: never persist an unparsed/partial report.
    parsed = reportSchema.parse(result.parsed);
  } catch (error) {
    // GDPR / AI-SPEC §7: log ONLY { analysisId, code } — never the fact sheet
    // or report prose. The coded error from synthesize.ts is preserved so the
    // user-facing Swedish message can distinguish the failure mode (WR-06).
    const code = error instanceof Error ? error.message : "UNKNOWN";
    console.error("[generateReport]", { analysisId, code });
    // WR-03: record the spend we actually incurred (if the Sonnet call returned
    // before the parse threw). On a pre-spend failure `sek` is still null and we
    // write `failed` with no cost.
    await writeFailedStatus(
      supabase,
      analysisId,
      sek != null ? { report_cost_sek: sek } : {},
    );
    return { ok: false, error: messageForCode(code) };
  }

  // Staleness fingerprint (D-08): a sha256 over the stable-key fact-sheet
  // string. The page recomputes the current-input fingerprint and compares it
  // to this stored value to drive the "uppdatera" stale marker.
  const fingerprint = createHash("sha256").update(factSheet).digest("hex");

  // Persist the validated report + terminal status + Sonnet cost + fingerprint
  // + prompt version in a single write (mirrors analyze-brf.ts:303-312).
  const { error: persistError } = await supabase
    .from("analyses")
    .update({
      report_data: {
        report: parsed,
        flags,
        softSignals: softSignals ?? null,
        dataFingerprint: fingerprint,
        costSek: sek,
        model: REPORT_MODEL,
        promptVersion: REPORT_SYNTHESIS_PROMPT_VERSION,
      },
      report_status: "done",
      report_cost_sek: sek,
      report_data_fingerprint: fingerprint,
      report_prompt_version: REPORT_SYNTHESIS_PROMPT_VERSION,
    })
    .eq("id", analysisId);

  if (persistError) {
    return { ok: false, error: "Kunde inte spara rapporten. Försök igen." };
  }

  return { ok: true };
}
