import { createHash } from "node:crypto";
import { searchAllabrfByName, fetchAllabrfDocument } from "@/lib/brf-source/allabrf";
import { resolveOrgNr } from "@/lib/brf-source/org-nr-resolver";
import { extractBrfFinancials } from "@/lib/brf/extract";
import { scoreExtraction } from "@/lib/brf/run-extraction";
import { costSek } from "@/lib/brf/cost";
import { estimateBrfLookupSek } from "@/lib/discovery/cost";
import { tomtrattFromTenureForm, type BrfSummary } from "@/lib/discovery/holistic-schema";

/**
 * brf-lookup.ts — the DISCOVERY-side BRF orchestrator (ANL-03). A PURE
 * composition of the reusable `brf-source`/`brf` primitives:
 * `searchAllabrfByName` -> `resolveOrgNr` -> `fetchAllabrfDocument` ->
 * `extractBrfFinancials` -> `scoreExtraction`.
 *
 * D-14-12 (BRF reuse boundary): this module MUST NEVER call the single-
 * listing action layer's extraction spine or its two BRF auto-fetch actions
 * (`src/lib/brf/run-extraction.ts`'s orchestrator export, or either export of
 * `src/actions/fetch-brf-auto.ts`), and MUST NEVER read or write the
 * single-listing analysis table — those are hard-bound to a single-listing
 * `analysisId` a discovery candidate does not have. A static source-grep
 * test (`brf-lookup.test.ts`) enforces this invariant so a later edit cannot
 * silently cross the boundary.
 *
 * D-14-10: this module never throws — every failure mode (missing name, no
 * registry candidates, ambiguous/unresolvable match, no document, extraction
 * failure) returns a named `outcome` with a `null` summary, so a discovery
 * candidate degrades gracefully to comps + hedonic only rather than failing
 * the whole tick.
 *
 * GDPR: the fetched Allabrf document text is analyze-only. It is never
 * returned, logged, or persisted by this module — only the aggregate
 * `BrfSummary` figures leave `lookupBrfSummary`. On an extraction failure the
 * single `console.error` logs a coded error string only.
 *
 * STRUCTURAL SEPARATION: this module's specifier (`discovery/brf-lookup`) is
 * registered in `niche-score.test.ts`'s `VISION_MODULE_SPECIFIERS` — the
 * deterministic `niche-score.ts`/`flags.ts` ranking path must never import
 * from it.
 *
 * This function performs no DB access, accepts no `jobId`/Supabase
 * parameter, and applies no concurrency/cost gating itself — bounding the
 * top-N and running candidates concurrently is the caller's responsibility
 * (plan 14-06).
 */

/**
 * How many discovery candidates get a BRF lookup attempt per job. D-14-01
 * allows 3–5; 4 is the midpoint, giving two-deep coverage on both the
 * below-market and aged-stock halves of the `enrichmentPriority` ranking
 * while keeping the worst-case added spend at 4 x one Haiku extraction
 * (~0.8 SEK each) inside `CAP_VISION_SEK_MAX = 10`. Revisit after the
 * deferred live smoke measures real latency and cost. Exported so tests
 * assert against this constant instead of a literal.
 */
export const BRF_TOP_N = 4;

/**
 * Per-extraction-failure-code billed-call count (CR-04, 14-REVIEW.md), taken
 * straight from `extract.ts`'s throw points: `CLAUDE_REFUSAL` and
 * `CLAUDE_PARSE_EMPTY` each throw after ONE completed model call.
 * `CLAUDE_MAX_TOKENS` retries `runOnce()` once before throwing, so TWO calls
 * were billed. Any code NOT in this map — notably `CLAUDE_CALL_FAILED`,
 * `extract.ts`'s catch-all for a transport/auth/rate-limit failure that
 * never completed a billed call — is charged 0 SEK. That exclusion is
 * deliberate, not an oversight: a transport failure before the model ever
 * responds incurs no Anthropic spend to account for.
 */
export const BILLED_CALLS_BY_EXTRACTION_CODE: Readonly<Record<string, number>> = {
  CLAUDE_REFUSAL: 1,
  CLAUDE_PARSE_EMPTY: 1,
  CLAUDE_MAX_TOKENS: 2,
};

/**
 * WR-01 (14-REVIEW.md): the MOST billed calls one `lookupBrfSummary` can
 * charge. Derived from the map above rather than restated, so a future code
 * with a higher call count raises the caller's pre-gate automatically.
 * `Math.max(1, ...)` keeps it a sane positive divisor even if the map were
 * ever emptied.
 *
 * `lookupBrfForTopCandidates`'s budget pre-gate (job.ts) MUST price this, not
 * one call: a gate that authorises an attempt able to charge twice what the
 * gate priced is not a check-before-spend gate.
 *
 * This is also the worst case on the SUCCESS path — `extract.ts` retries once
 * on truncation and (WR-02) now reports the summed usage of both attempts.
 */
export const MAX_BILLED_CALLS_PER_LOOKUP: number = Math.max(
  1,
  ...Object.values(BILLED_CALLS_BY_EXTRACTION_CODE),
);

/** The discriminated outcome of one `lookupBrfSummary` call. */
export type BrfLookupOutcome =
  | "ok"
  | "no_name"
  | "no_candidates"
  | "low_confidence"
  | "no_document"
  | "extract_failed";

/** The result of one BRF lookup attempt — never throws, always returns this shape. */
export interface BrfLookupResult {
  readonly summary: BrfSummary | null;
  readonly costSek: number;
  readonly outcome: BrfLookupOutcome;
}

/** The minimal per-candidate fields `lookupBrfSummary` needs. */
export interface BrfLookupInput {
  readonly brfName: string | null;
  readonly kommun: string | null;
  readonly tenureForm: string | null;
}

/**
 * Looks up a discovery candidate's BRF summary by composing the reusable
 * `brf-source`/`brf` primitives. Never throws — every step degrades to a
 * named outcome with `summary: null` instead.
 *
 * 1. No `brfName` -> `"no_name"`.
 * 2. `searchAllabrfByName` (never throws) resolves zero candidates ->
 *    `"no_candidates"`.
 * 3. `resolveOrgNr` requires `confidence === "high"` — D-14-09 EXPLICITLY
 *    REJECTED relaxing this gate to `"low"`: attributing the wrong BRF's
 *    avgift/debt to a real listing is a user-facing financial-correctness
 *    failure. Anything below `"high"` -> `"low_confidence"`, and the
 *    document is never fetched.
 * 4. `fetchAllabrfDocument` rejects a non-Luhn org.nr BEFORE constructing any
 *    URL (that guard runs inside `allabrf.ts`, not re-implemented here) and
 *    returns `null` on any other failure -> `"no_document"`.
 * 5. `extractBrfFinancials` throws CODED errors (CLAUDE_REFUSAL /
 *    CLAUDE_MAX_TOKENS / CLAUDE_PARSE_EMPTY / CLAUDE_CALL_FAILED) — caught
 *    here, logged GDPR-safely (the code only, never the document text, the
 *    org.nr, financials, or quotes) -> `"extract_failed"`.
 * 6. `scoreExtraction` (PURE — never the single-listing extraction spine)
 *    normalizes the extraction into the aggregate `BrfSummary` -> `"ok"`.
 */
export async function lookupBrfSummary(input: BrfLookupInput): Promise<BrfLookupResult> {
  if (!input.brfName || input.brfName.trim().length === 0) {
    return { summary: null, costSek: 0, outcome: "no_name" };
  }

  const candidates = await searchAllabrfByName(input.brfName);
  if (candidates.length === 0) {
    return { summary: null, costSek: 0, outcome: "no_candidates" };
  }

  const resolution = resolveOrgNr({
    brfName: input.brfName,
    kommun: input.kommun,
    candidates,
  });

  if (resolution.confidence !== "high") {
    return { summary: null, costSek: 0, outcome: "low_confidence" };
  }

  const doc = await fetchAllabrfDocument(resolution.orgNr);
  if (doc === null) {
    return { summary: null, costSek: 0, outcome: "no_document" };
  }

  const contentHash = createHash("sha256").update(doc.text, "utf8").digest("hex");

  try {
    const result = await extractBrfFinancials({
      kind: "ixbrl-text",
      text: doc.text,
      contentHash,
    });

    const { normalized, perFieldConfidence } = scoreExtraction(result.parsed);

    const summary: BrfSummary = {
      skuldPerKvm: normalized.skuldPerKvm,
      avgiftsniva: normalized.avgiftsniva,
      kassaflode: normalized.kassaflode,
      stambytePlanerat: normalized.stambytePlanerat ?? null,
      tomtratt: tomtrattFromTenureForm(input.tenureForm),
      fiscalYear: doc.fiscalYear,
      source: "allabrf",
      // CR-02 (14-REVIEW.md): carry the sanity-band-downgraded confidence
      // onto the summary WITHOUT dropping the value — sanity.ts:49-51 is
      // explicit that a value is never dropped, only its confidence
      // lowered, and the single-listing path depends on that contract.
      // The discovery path gates at the point of USE instead (plan 14-10):
      // an out-of-band skuldPerKvm must not be presentable as fact AND must
      // not enter normalizeForConfounders's
      // effectivePricePerSqm = pricePerSqm + brf.skuldPerKvm arithmetic,
      // because that is what can flip deepDiscount and silently disable the
      // SPEC §2.6 20% attribution cap (ANL-04). Read the three keys
      // explicitly (never spread perFieldConfidence, which also carries
      // underhallsplanStatus — not a BrfSummary field).
      fieldConfidence: {
        skuldPerKvm: perFieldConfidence.skuldPerKvm ?? null,
        avgiftsniva: perFieldConfidence.avgiftsniva ?? null,
        kassaflode: perFieldConfidence.kassaflode ?? null,
      },
    };

    return { summary, costSek: costSek(result.usage), outcome: "ok" };
  } catch (error) {
    // GDPR-safe logging: the coded message ONLY — never the document text,
    // the org.nr, financials, or quotes.
    const code = error instanceof Error ? error.message : "UNKNOWN";
    console.error("[discovery-brf-lookup]", { code });
    // WR-02 (14-REVIEW.md) closed the matching SUCCESS-path leak: a success
    // after a truncation retry now returns the SUMMED usage of both billed
    // calls (`extract.ts`'s `sumClaudeUsage`), so `costSek(result.usage)`
    // above is honest too — not just this failure branch.
    //
    // CR-04 (14-REVIEW.md): a code in BILLED_CALLS_BY_EXTRACTION_CODE means
    // Anthropic already billed 1 or 2 calls before extract.ts threw — charge
    // that real estimated spend against the shared CAP_VISION_SEK_MAX pool
    // (D-14-08: comps + BRF + vision share ONE 10 SEK ceiling) instead of
    // reporting 0. Under-counting a spend gate is the dangerous direction:
    // 4 top-N candidates all failing on CLAUDE_MAX_TOKENS would otherwise
    // silently record ~6.2 SEK of real spend as 0 SEK.
    return {
      summary: null,
      costSek: (BILLED_CALLS_BY_EXTRACTION_CODE[code] ?? 0) * estimateBrfLookupSek(),
      outcome: "extract_failed",
    };
  }
}
