"use server";

import { createClient } from "@/lib/supabase/server";
import { listingDataSchema, type Breadcrumb } from "@/lib/schemas/listing";
import { searchAllabrfByName, fetchAllabrfDocument } from "@/lib/brf-source/allabrf";
import { resolveOrgNr, isValidOrgNr } from "@/lib/brf-source/org-nr-resolver";
import { fetchArsredovisning } from "@/lib/brf-source/fetch-document";
import { runBrfExtraction, type AnalyzeBrfResult } from "@/lib/brf/run-extraction";

/**
 * fetch-brf-auto.ts — the orchestration seam that makes ENRICH-01 (auto-fetch
 * -> IDENTICAL runBrfExtraction pipeline) and ENRICH-02 (confirm before
 * analyze; fall through on failure) real, behind the SAME auth+ownership gate
 * as `analyzeBrf` (08-PATTERNS.md Shared Patterns — Auth+Ownership Gate).
 *
 * Two "use server" actions:
 *  - `resolveOrgNrAction(analysisId)` — read-only resolution + fiscal-year
 *    preview. Never writes status, never analyzes.
 *  - `confirmAndAnalyze(analysisId, orgNr, fiscalYear)` — invoked AFTER the
 *    user confirms (ENRICH-02 human-in-the-loop, unconditional). Writes
 *    `auto_fetching`, fetches the document, delegates to the SAME
 *    `runBrfExtraction` the manual upload path uses.
 *
 * T-08-10 (Elevation of Privilege): both actions open with the identical
 * `supabase.auth.getUser()` -> `row.user_id === user.id` gate as `analyzeBrf`
 * (analyze-brf.ts lines 50-69) — no resolution/fetch/analysis runs before it
 * passes.
 */

/** Discriminated result `resolveOrgNrAction` returns to the client. */
export type ResolveResult =
  | { ok: false; error: string }
  | {
      ok: true;
      confidence: "high";
      orgNr: string;
      matchedName: string;
      fiscalYear: number | null;
      brfName: string | null;
    }
  | { ok: true; confidence: "low" | "none"; fallThrough: true };

/** Discriminated fall-through result `confirmAndAnalyze` returns on failure. */
export type ConfirmAndAnalyzeResult =
  | AnalyzeBrfResult
  | { ok: false; fallThrough: true; error: string };

/**
 * Derives the listing's kommun for geographic corroboration (Pitfall 4) from
 * the breadcrumb wide->narrow area ladder (e.g. ["Stockholms län",
 * "Stockholms kommun", "Södermalm", ...]) — the entry whose label ends with
 * " kommun" (case-insensitive), stripped of that suffix. Returns null when no
 * such entry exists (honest degrade — resolveOrgNr's geo-corroboration check
 * then fails closed to "low"/"none", never a guess).
 *
 * NOTE: Booli breadcrumb labels are in the Swedish genitive form ("Stockholms
 * kommun" -> "Stockholms"), which may not exactly match a registry's
 * nominative kommun name ("Stockholm") — `resolveOrgNr`'s `normalizeKommun`
 * does an exact case-insensitive comparison with no genitive normalization
 * (Plan 02, out of scope for this plan to change). A format mismatch fails
 * CLOSED to "low" confidence (never wrongly promotes to "high"), which is the
 * safe direction per Pitfall 4 — this is an accepted v1 limitation, not a bug.
 */
function kommunFromBreadcrumbs(breadcrumbs: Breadcrumb[] | null): string | null {
  if (!Array.isArray(breadcrumbs)) return null;
  for (const crumb of breadcrumbs) {
    const label = crumb.label?.trim();
    if (label && /\skommun$/i.test(label)) {
      return label.replace(/\skommun$/i, "").trim();
    }
  }
  return null;
}

/**
 * `resolveOrgNrAction` — auth+ownership-gated org.nr resolution + fiscal-year
 * preview (ENRICH-01/02). Reads the persisted listing's `brfName` + kommun,
 * calls `searchAllabrfByName` -> `resolveOrgNr`, and returns a discriminated
 * result: `high` confidence previews the fiscal year for the confirmation UI;
 * `low`/`none` signals fall-through to manual upload. NEVER writes any status
 * or analyzes anything — this is a read-only reconnaissance step.
 */
export async function resolveOrgNrAction(analysisId: string): Promise<ResolveResult> {
  if (typeof analysisId !== "string" || !analysisId) {
    return { ok: false, error: "Analys-id saknas." };
  }

  // Auth gate (D-05 HARD, identical to analyzeBrf) — no guest path.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "Logga in för BRF-analys" };
  }

  // Ownership check (T-08-10) — before any Allabrf call.
  const { data: row, error: rowError } = await supabase
    .from("analyses")
    .select("id, user_id, listing_data")
    .eq("id", analysisId)
    .single();

  if (rowError || !row || row.user_id !== user.id) {
    return { ok: false, error: "Analysen hittades inte." };
  }

  // CR-01 discipline: re-validate the persisted JSONB before trusting it.
  const listingData = listingDataSchema.safeParse(row.listing_data).data;
  const brfName = listingData?.brfName ?? null;
  if (!listingData || !brfName || brfName.trim().length === 0) {
    // Honest silent degrade — auto-fetch simply not attempted.
    return { ok: true, confidence: "none", fallThrough: true };
  }

  const kommun = kommunFromBreadcrumbs(listingData.breadcrumbs);

  const candidates = await searchAllabrfByName(brfName);
  const resolution = resolveOrgNr({ brfName, kommun, candidates });

  if (resolution.confidence !== "high") {
    return { ok: true, confidence: resolution.confidence, fallThrough: true };
  }

  // Preview the fiscal year for the confirmation UI (ENRICH-02) — a failed
  // preview fetch degrades to `fiscalYear: null`, not a fall-through: the
  // resolver's confidence gate already passed, and confirmAndAnalyze will
  // re-fetch (or fail closed) on the actual confirm step.
  //
  // WR-01 (accepted tradeoff, documented rather than cached): confirmAndAnalyze
  // re-fetches the SAME Allabrf document via `fetchArsredovisning` at confirm
  // time rather than reusing this preview's `text`. This is intentional, not
  // an oversight:
  //   1. Resolution and confirmation can be arbitrarily far apart in time (the
  //      confirm UI has no timeout forcing an immediate decision) — re-fetching
  //      gets the CURRENT document rather than a possibly-stale cached one,
  //      which matters if Allabrf's data changes between the two steps.
  //   2. `fetchArsredovisning`'s `FetchedDocument` (with rung-tracked `source`/
  //      `isMostRecent`) is the ONLY value ever persisted or billed against —
  //      this preview fetch's `text` is discarded, so there is no risk of a
  //      double-bill here: this module never calls Claude, only Allabrf
  //      (a free scrape), and the CR-01 atomic CAS guarantees `confirmAndAnalyze`
  //      itself can only run `runBrfExtraction` (the billed call) once per
  //      confirm.
  //   3. A short-TTL cache keyed by analysisId would add real complexity
  //      (invalidation, memory/store lifetime) to save one free HTTP scrape —
  //      not a favorable tradeoff for a v1 auto-fetch pre-step.
  const preview = await fetchAllabrfDocument(resolution.orgNr);

  return {
    ok: true,
    confidence: "high",
    orgNr: resolution.orgNr,
    matchedName: resolution.matchedName,
    fiscalYear: preview?.fiscalYear ?? null,
    brfName,
  };
}

/**
 * `confirmAndAnalyze` — invoked AFTER the user confirms the resolved org.nr
 * (ENRICH-02, unconditional human-in-the-loop even on a high-confidence
 * match). Auth+ownership gate, redundant-work guard, re-validates the
 * client-supplied org.nr (T-08-11), writes `auto_fetching`, fetches the
 * document, and on success delegates to the SAME `runBrfExtraction` the
 * manual path runs (ENRICH-01 criterion 1) — this function never
 * reimplements the extraction pipeline. On any fetch failure it releases the
 * transient status and returns a fall-through result so the manual upload
 * path stays fully functional — never a wrong-BRF analysis (T-08-13).
 */
export async function confirmAndAnalyze(
  analysisId: string,
  orgNr: string,
  // Accepted for API symmetry with the confirmation UI's resolved preview —
  // the actual fiscal year PERSISTED is whatever `fetchArsredovisning`
  // returns at confirm-time (the source of truth, threaded to
  // `runBrfExtraction` below via `fetchMeta`), never this client-supplied
  // preview value.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _fiscalYear: number | null,
): Promise<ConfirmAndAnalyzeResult> {
  if (typeof analysisId !== "string" || !analysisId) {
    return { ok: false, error: "Analys-id saknas." };
  }

  // Auth gate (D-05 HARD, identical to analyzeBrf).
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "Logga in för BRF-analys" };
  }

  // Ownership check (T-08-10).
  const { data: row, error: rowError } = await supabase
    .from("analyses")
    .select("id, user_id, brf_status")
    .eq("id", analysisId)
    .single();

  if (rowError || !row || row.user_id !== user.id) {
    return { ok: false, error: "Analysen hittades inte." };
  }

  // T-08-11: never trust the client-passed org.nr — re-validate server-side
  // before any external call is made.
  if (!isValidOrgNr(orgNr)) {
    return {
      ok: false,
      fallThrough: true,
      error: "Ogiltigt organisationsnummer. Ladda upp årsredovisningen manuellt istället.",
    };
  }

  // CR-01 / T-08-12 redundant-work guard: a re-trigger (e.g. page reload,
  // double-click, duplicated tab, client retry-on-timeout) while a fetch is
  // already in flight, or after it already completed, must not
  // re-scrape/re-bill. This is an ATOMIC compare-and-swap — a single
  // conditional UPDATE that only flips the row to `auto_fetching` when it is
  // NOT already `auto_fetching`/`done`, mirroring generateReport's REAL CAS
  // mechanism (update().eq()....select().maybeSingle()), not just its intent.
  // The DB serialises concurrent conditional updates, so at most one caller
  // can ever observe a non-null `acquired` result — the other(s) fall through
  // without a second scrape/bill.
  //
  // PostgREST NULL-filter trap (memory: postgrest-eq-null.md): a bare
  // `.neq("brf_status", "auto_fetching")` (or a `NOT IN (...)` predicate)
  // compiles to `brf_status <> 'auto_fetching'`, and SQL's three-valued logic
  // makes `NULL <> 'x'` evaluate to NULL (unknown) — so it would SILENTLY
  // EXCLUDE every row whose `brf_status` is still NULL (the common case for a
  // brand-new analysis that has never been fetched), wedging every first-ever
  // auto-fetch attempt at "hämtning pågår redan". `.or(is.null, neq)` is the
  // only correct way to include both the NULL case and the not-blocked case.
  const { data: acquired, error: casError } = await supabase
    .from("analyses")
    .update({ brf_status: "auto_fetching" })
    .eq("id", analysisId)
    .or(
      "brf_status.is.null,and(brf_status.neq.auto_fetching,brf_status.neq.done)",
    )
    .select("id")
    .maybeSingle();

  if (casError) {
    console.error("[fetch-brf-auto] CAS acquire failed", {
      analysisId,
      code: casError.code,
    });
    return {
      ok: false,
      fallThrough: true,
      error: "Vi kunde inte starta hämtningen just nu. Försök igen senare.",
    };
  }

  if (!acquired) {
    // Another request already holds the lock (or already finished) — abort
    // without a second scrape/bill.
    return {
      ok: false,
      fallThrough: true,
      error: "En hämtning pågår redan eller är redan klar.",
    };
  }

  try {
    const doc = await fetchArsredovisning(orgNr);
    return await runBrfExtraction(
      analysisId,
      user.id,
      { kind: "ixbrl-text", text: doc.text },
      "auto_allabrf",
      // ROADMAP Success Criterion 4: thread the fetch-time fiscal-year +
      // staleness signal so it lands in the persisted BrfData (never the
      // client-supplied `_fiscalYear` preview — `doc` is the source of truth).
      { fiscalYear: doc.fiscalYear, isMostRecent: doc.isMostRecent },
    );
  } catch (error) {
    // GDPR-safe logging (T-08-14): only ids/codes, never scraped content.
    console.error("[fetch-brf-auto] auto-fetch failed", {
      analysisId,
      code: error instanceof Error ? error.message : "UNKNOWN",
    });
    // WR-02: release the transient status ONLY if it's still the one THIS
    // invocation set — a conditional UPDATE, not an unconditional write, so a
    // concurrent/retried request that has since progressed the row past
    // `auto_fetching` (e.g. into `extracting`/`scoring`/`done`) is never
    // clobbered back to null by this catch block.
    await supabase
      .from("analyses")
      .update({ brf_status: null })
      .eq("id", analysisId)
      .eq("brf_status", "auto_fetching");
    return {
      ok: false,
      fallThrough: true,
      error: "Vi kunde inte hämta årsredovisningen automatiskt. Ladda upp den manuellt istället.",
    };
  }
}
