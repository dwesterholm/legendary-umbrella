import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ClaudeUsage } from "@/lib/brf/cost";
import {
  preFilterSchema,
  visionDeepPassSchema,
  VISION_CONFIDENCE_THRESHOLD,
  type VisionResult,
  type VisionConditionClaim,
} from "@/lib/discovery/vision-schema";
import { CAP_VISION_SEK_MAX, visionCostSek, estimateVisionCallSek } from "@/lib/discovery/cost";
import { CAP_IMAGES_PER_LISTING } from "@/lib/discovery/filter-schema";
import {
  VISION_PREFILTER_SYSTEM_PROMPT,
  VISION_DEEPPASS_SYSTEM_PROMPT,
} from "@/lib/discovery/vision-prompt";
import type { DiscoveryCandidate } from "@/lib/discovery/candidate";

/**
 * vision.ts — the DISC-04 core: `runVisionForCandidate` (two-pass Haiku
 * pre-filter → conditional Sonnet deep pass over ONE candidate's capped
 * image set) and `runVisionPass` (the incremental-cost-capped, per-job
 * booliId-deduped loop over a candidate array).
 *
 * Mirrors `src/lib/brf/extract.ts`'s module-scope client, model constants,
 * `messages.parse` + `zodOutputFormat` call shape, refusal/max_tokens/
 * parse-empty branching, and GDPR-safe `{ id, code }`-only catch logging —
 * extended with `image` content blocks (RESEARCH.md Pattern 1/2) instead of
 * a `document` block. `runVisionPass`'s incremental cap-before-spend
 * discipline mirrors `job.ts`'s `runSlice` exactly (RESEARCH.md Pitfall 2).
 *
 * STRUCTURAL SEPARATION (T-11-10): this module imports NOTHING from
 * `niche-score.ts` or `flags.ts`, and nothing in this file feeds a vision
 * value into `computeNicheScore` or `ReportFlags` — vision output stays on
 * its own read/write path (`DiscoveryCandidate.vision`/`visionSkippedReason`)
 * for good, per CONTEXT.md's locked structural-separation constraint.
 */

/** The Anthropic client is instantiated ONLY here (server module) — the key
 * must never reach the browser (T-02-09, mirrors extract.ts:19). */
const client = new Anthropic();

/** Haiku 4.5 — the cheap triage tier (verified id, extract.ts:22). */
const HAIKU_MODEL = "claude-haiku-4-5-20251001";

/** Sonnet 4.6 — the deep-pass tier (verified id, bare, no date suffix, synthesize.ts:24). */
const SONNET_MODEL = "claude-sonnet-4-6";

const PREFILTER_USER_INSTRUCTION =
  "Vilka bilder är värda en djupare granskning av skick?";
const DEEPPASS_USER_INSTRUCTION =
  "Bedöm kök, badrum och allmänt skick enligt schemat.";

/** The deliberate, differentiated vision failure codes (WR-06 discipline). */
const KNOWN_VISION_CODES = new Set([
  "CLAUDE_REFUSAL",
  "CLAUDE_MAX_TOKENS",
  "CLAUDE_PARSE_EMPTY",
]);

/**
 * CR-01/CR-02 (12-REVIEW.md): the actual banned-word ENFORCEMENT for
 * `remodelPotential` claims — belt-and-suspenders means code must inspect
 * and reject a banned-verdict claim, not merely append a disclaimer after
 * it. Mirrors the exact banned-word list the deep-pass prompt itself bans
 * (vision-prompt.ts:63): "bärande", "icke-bärande", "garanterat",
 * "definitivt", "kan enkelt rivas" — case-insensitive, word-boundary
 * anchored so it does not false-positive on unrelated substrings.
 *
 * MUST be tested against the MODEL's raw `attr.claim` BEFORE the
 * code-appended disclaimer suffix is concatenated (CR-02) — the disclaimer
 * itself legitimately discusses load-bearing walls in a hedged,
 * investigation-framing sense, so testing the final concatenated string
 * would either false-positive on the disclaimer's own wording or require
 * the disclaimer to awkwardly avoid ever describing what it's for.
 */
const REMODEL_BANNED_PATTERN =
  /\bbärande\b|\bicke-bärande\b|\bgaranterat\b|\bdefinitivt\b|kan enkelt rivas/i;

/**
 * The mandatory, code-appended `remodelPotential` disclaimer (T-12-03,
 * belt-and-suspenders). CR-02 (12-REVIEW.md): deliberately rewritten to
 * avoid the literal word "bärande" — the prompt bans the MODEL from using
 * this word (vision-prompt.ts:63), so the CODE's own hardcoded disclaimer
 * must not use it either, both for consistency and so this same banned-word
 * pattern can never be tripped by the disclaimer's own text.
 */
const REMODEL_DISCLAIMER =
  " Detta är endast ett underlag för vidare utredning — kräver konstruktör/väggutredning innan någon vägg berörs.";

/**
 * The generic, always-safe fallback claim substituted for a `remodelPotential`
 * claim whose raw model text trips `REMODEL_BANNED_PATTERN` (CR-01). A
 * banned-word verdict must be DROPPED, never shown even briefly — this
 * fallback re-frames the claim as a hedged investigation prompt (the same
 * framing the prompt itself mandates, vision-prompt.ts:61) so the claim
 * still communicates "this floor plan may be worth a closer look" without
 * ever asserting a load-bearing/wall-removal verdict.
 */
const REMODEL_FALLBACK_CLAIM =
  "Planlösningen antyder att en vägg eventuellt kan vara värt att undersöka.";

function isKnownVisionCode(error: unknown): boolean {
  return error instanceof Error && KNOWN_VISION_CODES.has(error.message);
}

/** Maps the SDK's typed usage onto our `ClaudeUsage` cost shape (mirrors extract.ts). */
function toClaudeUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}): ClaudeUsage {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
  };
}

/**
 * Builds the `Bild N:` + `image` content-block pairs for a capped image set
 * (RESEARCH.md Pattern 1). Used identically by both the pre-filter and
 * deep-pass calls so `imageIndex` on the deep-pass result always resolves
 * against the SAME 1-based numbering the model was shown.
 */
function imageBlocks(
  urls: string[],
): Array<
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "url"; url: string } }
> {
  return urls.flatMap((url, i) => [
    { type: "text" as const, text: `Bild ${i + 1}:` },
    { type: "image" as const, source: { type: "url" as const, url } },
  ]);
}

/** The result of `runVisionForCandidate` — a `VisionResult` or a skip reason. */
export interface RunVisionResult {
  result: VisionResult | null;
  skippedReason: "no_images" | null;
}

/**
 * Runs the two-pass vision pipeline for ONE candidate: a Haiku pre-filter
 * triage over the candidate's capped image set, followed by a Sonnet deep
 * pass ONLY when the pre-filter flags `worthDeepPass` — the FULL capped
 * image set is sent to Sonnet (not a Haiku-flagged subset; Haiku triages the
 * CANDIDATE, not individual images — RESEARCH.md Pitfall/Pattern 1).
 *
 * - No `imageUrls` → `{ result: null, skippedReason: "no_images" }`, NO
 *   Anthropic call made at all.
 * - `worthDeepPass: false` → a `VisionResult` with `claims: []` and
 *   Haiku-only cost; no Sonnet call.
 * - `worthDeepPass: true` → the Sonnet deep pass runs; claims with a null
 *   `claim` OR `confidence < VISION_CONFIDENCE_THRESHOLD` are dropped BEFORE
 *   the result is returned (never persisted, never shown greyed-out).
 * - Every kept claim carries the exact `imageIndex`/`whatWasSeen` the model
 *   attached — resolvable against `imageUrlsUsed[imageIndex - 1]`.
 * - Catch blocks log ONLY `{ booliId, code }` — never image URLs, claim
 *   text, or model output (T-11-09, mirrors extract.ts:326-338).
 *
 * @param booliId - the candidate's listing id, used ONLY for safe logging
 * @param imageUrls - the candidate's already-capped image URL set
 */
export async function runVisionForCandidate(
  booliId: string,
  imageUrls: string[],
): Promise<RunVisionResult> {
  if (imageUrls.length === 0) {
    return { result: null, skippedReason: "no_images" };
  }

  // Precondition: `imageUrls` is already host-allowlisted by the caller
  // (claimVisionSlice re-applies isAllowedImageHost on the raw persisted read
  // — WR-03, shard-1 review) before any URL reaches Anthropic's server-side
  // image fetch.
  const capped = imageUrls.slice(0, CAP_IMAGES_PER_LISTING);

  try {
    const runPreFilterOnce = () =>
      client.beta.messages.parse({
        model: HAIKU_MODEL,
        max_tokens: 300,
        temperature: 0,
        system: VISION_PREFILTER_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [...imageBlocks(capped), { type: "text", text: PREFILTER_USER_INSTRUCTION }],
          },
        ],
        output_config: { format: zodOutputFormat(preFilterSchema) },
      });

    let preFilterMessage = await runPreFilterOnce();

    if (preFilterMessage.stop_reason === "refusal") {
      throw new Error("CLAUDE_REFUSAL");
    }
    if (preFilterMessage.stop_reason === "max_tokens") {
      preFilterMessage = await runPreFilterOnce();
      if (preFilterMessage.stop_reason === "max_tokens") {
        throw new Error("CLAUDE_MAX_TOKENS");
      }
    }
    if (!preFilterMessage.parsed_output) {
      throw new Error("CLAUDE_PARSE_EMPTY");
    }

    const haikuUsage = toClaudeUsage(preFilterMessage.usage);

    if (!preFilterMessage.parsed_output.worthDeepPass) {
      return {
        result: {
          claims: [],
          imageUrlsUsed: capped,
          model: HAIKU_MODEL,
          costSek: visionCostSek(haikuUsage, null),
          ranAt: new Date().toISOString(),
        },
        skippedReason: null,
      };
    }

    // The FULL capped set — never a Haiku-flagged subset (Pitfall 4).
    const runDeepPassOnce = () =>
      client.beta.messages.parse({
        model: SONNET_MODEL,
        max_tokens: 1024,
        temperature: 0,
        system: VISION_DEEPPASS_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [...imageBlocks(capped), { type: "text", text: DEEPPASS_USER_INSTRUCTION }],
          },
        ],
        output_config: { format: zodOutputFormat(visionDeepPassSchema) },
      });

    let deepPassMessage = await runDeepPassOnce();

    if (deepPassMessage.stop_reason === "refusal") {
      throw new Error("CLAUDE_REFUSAL");
    }
    if (deepPassMessage.stop_reason === "max_tokens") {
      deepPassMessage = await runDeepPassOnce();
      if (deepPassMessage.stop_reason === "max_tokens") {
        throw new Error("CLAUDE_MAX_TOKENS");
      }
    }
    if (!deepPassMessage.parsed_output) {
      throw new Error("CLAUDE_PARSE_EMPTY");
    }

    const sonnetUsage = toClaudeUsage(deepPassMessage.usage);
    const parsed = deepPassMessage.parsed_output;

    const claims: VisionConditionClaim[] = (
      [
        ["kitchen", parsed.kitchen],
        ["bathroom", parsed.bathroom],
        ["overall", parsed.overall],
        ["remodelPotential", parsed.remodelPotential],
      ] as const
    )
      .filter(
        ([, attr]) =>
          attr.claim !== null &&
          attr.confidence >= VISION_CONFIDENCE_THRESHOLD &&
          // WR-02 (11-REVIEW.md): `imageIndex` is a bare `z.number()` (no
          // `.min()/.max()` — Anthropic numeric-constraint 400 trap) and is
          // NEVER validated against the actual sent image count elsewhere.
          // A claim whose 1-based imageIndex doesn't resolve to a real
          // image in `capped` is functionally uncited despite passing the
          // confidence filter — the mandatory-citation contract
          // (vision-schema.ts: "no uncited claim can pass through this
          // shape") requires dropping it here, before persistence, not
          // silently degrading to a placeholder box in the UI. This SAME
          // filter applies uniformly to `remodelPotential` (Phase 12,
          // DISC-05) — no special-casing.
          //
          // WR-04 (12-REVIEW.md): `imageIndex` is ALSO not `.int()`-
          // constrained (same Anthropic numeric-constraint trap), so a
          // fractional value (e.g. 1.5) would previously pass this bounds
          // check and later render a nonsensical "Bild 1.5" citation label
          // (gallery-condition-vision.tsx). A fractional index is just as
          // uncited/malformed as an out-of-range one — dropped here,
          // consistently with the rest of this filter's discipline.
          Number.isInteger(attr.imageIndex) &&
          attr.imageIndex >= 1 &&
          attr.imageIndex <= capped.length,
      )
      .map(([attribute, attr]) => ({
        attribute,
        // Belt-and-suspenders code-enforced banned-word REJECTION + mandatory
        // disclaimer (T-12-03, CR-01/CR-02 12-REVIEW.md fix): a
        // liability-bearing sentence must never depend solely on model
        // prompt compliance. The RAW model claim is inspected FIRST — if it
        // contains a banned load-bearing/wall-removal verdict word, the
        // claim is DROPPED and replaced with a generic hedged fallback
        // (REMODEL_FALLBACK_CLAIM); only then is the disclaimer appended.
        // This ordering matters (CR-02): the disclaimer itself legitimately
        // discusses load-bearing walls, so it MUST be appended AFTER the
        // banned-word check runs against the model's original text, never
        // checked as part of the final concatenated string. Kitchen/
        // bathroom/overall are UNCHANGED. Dropping this tuple entry above
        // removes the claim type entirely (config/flag flip, not a rewrite).
        claim:
          attribute === "remodelPotential"
            ? `${REMODEL_BANNED_PATTERN.test(attr.claim as string) ? REMODEL_FALLBACK_CLAIM : (attr.claim as string)}${REMODEL_DISCLAIMER}`
            : (attr.claim as string),
        imageIndex: attr.imageIndex,
        whatWasSeen: attr.whatWasSeen,
        confidence: attr.confidence,
      }));

    return {
      result: {
        claims,
        imageUrlsUsed: capped,
        model: SONNET_MODEL,
        costSek: visionCostSek(haikuUsage, sonnetUsage),
        ranAt: new Date().toISOString(),
      },
      skippedReason: null,
    };
  } catch (error) {
    // GDPR / T-11-09: log ONLY the booliId + a stable code, NEVER image
    // URLs, claim text, or model output.
    const code = isKnownVisionCode(error) ? (error as Error).message : "CLAUDE_CALL_FAILED";
    console.error("[discovery-vision]", { booliId, code });
    throw new Error(code, { cause: error });
  }
}

/**
 * `runVisionPass` — the incremental-cost-capped, per-job vision loop over a
 * candidate array (Task 2). Lives on its OWN read/write path: reads
 * `candidate.imageUrls`, writes `candidate.vision`/`visionSkippedReason` —
 * and MUST NOT pass any vision value into `filterCandidates`/`toCandidate`
 * scoring or `computeNicheScore` (T-11-10).
 *
 * Order per candidate (mirrors `runSlice`'s check-running-total-BEFORE-spend
 * discipline, RESEARCH.md Pitfall 2 — never checked only after a call):
 *  1. No `imageUrls` → `vision: null, visionSkippedReason: "no_images"`, NO call.
 *  2. Same `booliId` already vision-processed THIS pass → reuse the cached
 *     result (in-memory `Map<booliId, VisionResult>`, per-job only — a
 *     cross-job cache table is v2-deferred per RESEARCH.md "Caching" Open
 *     Question 2; this dedupe map does NOT persist across separate
 *     `runVisionPass` invocations).
 *  3. Otherwise, BEFORE calling: if `runningVisionSek + estimate` would
 *     exceed `CAP_VISION_SEK_MAX`, this candidate AND every remaining
 *     candidate are marked `vision: null, visionSkippedReason: "cost_cap"`
 *     and the loop stops (no further vision call is made).
 *  4. Otherwise call `runVisionForCandidate`, add its `costSek` to the
 *     running total, and attach the result.
 *  5. CR-02 (11-REVIEW.md): a thrown error from `runVisionForCandidate`
 *     (Claude refusal, transient API error, malformed image fetch) is caught
 *     PER CANDIDATE — only that candidate degrades to
 *     `vision: null, visionSkippedReason: "vision_error"`; the loop
 *     continues to the next candidate. A single failing candidate can never
 *     abort the whole pass or strand the job's already-scraped results.
 *
 * `cost_sek_total` (the scrape cap, `CAP_SEK_MAX`) is NEVER touched here —
 * the vision SEK total is tracked entirely separately, so a job that hits
 * its scrape cap can still report candidates with no vision, and a job that
 * hits ITS vision cap stops vision without failing the whole job.
 *
 * @param candidates - the job's persisted candidate set (read-only input)
 * @param opts.booliIdOf - resolves a candidate's dedupe/logging key (falls
 *   back to `sourceListingUrl`, or — CR-03 (11-REVIEW.md) — the candidate's
 *   own array index when `sourceListingUrl` is null/missing, since
 *   `DiscoveryCandidate` has no dedicated `booliId` field. The index fallback
 *   is guaranteed unique WITHIN one pass, unlike a shared `"unknown"`
 *   sentinel: `sourceListingUrl` is nullable (`str()` degrades silently on a
 *   missing/malformed `url`), so two OR MORE distinct candidates can
 *   legitimately have `sourceListingUrl: null` in the same job — a shared
 *   sentinel key would collide and serve the SECOND such candidate the
 *   FIRST's `VisionResult` (someone else's kitchen/bathroom claims shown
 *   under the wrong listing).
 * @returns a NEW candidate array with `vision`/`visionSkippedReason` attached
 */
export async function runVisionPass(
  candidates: DiscoveryCandidate[],
  opts: { booliIdOf?: (candidate: DiscoveryCandidate, index: number) => string } = {},
): Promise<DiscoveryCandidate[]> {
  const booliIdOf =
    opts.booliIdOf ??
    ((c: DiscoveryCandidate, i: number) => c.sourceListingUrl ?? `unknown-${i}`);

  // Per-job-only in-memory dedupe — NOT a cross-job cache (RESEARCH.md
  // "Caching" Open Question 2, explicitly deferred to v2).
  const dedupe = new Map<string, VisionResult>();

  let runningVisionSek = 0;
  let costCapHit = false;

  const out: DiscoveryCandidate[] = [];

  for (const [index, candidate] of candidates.entries()) {
    if (costCapHit) {
      out.push({ ...candidate, vision: null, visionSkippedReason: "cost_cap" });
      continue;
    }

    if (!candidate.imageUrls || candidate.imageUrls.length === 0) {
      out.push({ ...candidate, vision: null, visionSkippedReason: "no_images" });
      continue;
    }

    const booliId = booliIdOf(candidate, index);
    const cached = dedupe.get(booliId);
    if (cached) {
      out.push({ ...candidate, vision: cached, visionSkippedReason: null });
      continue;
    }

    // Incremental cap check BEFORE spend — mirrors runSlice's pre-check
    // (job.ts, RESEARCH.md Pitfall 2). CR-01 (11-REVIEW.md): `estimate` is a
    // REAL, priced worst-case per-call figure (`estimateVisionCallSek`,
    // cost.ts) derived from the actual Haiku+Sonnet token/price model — NOT
    // an arbitrary `CAP_VISION_SEK_MAX / candidates.length` average that
    // shrinks as the candidate count grows and bears no relation to what the
    // imminent call can actually cost.
    const estimate = estimateVisionCallSek();
    if (runningVisionSek + estimate > CAP_VISION_SEK_MAX) {
      costCapHit = true;
      out.push({ ...candidate, vision: null, visionSkippedReason: "cost_cap" });
      continue;
    }

    // CR-02 (11-REVIEW.md): a per-candidate Claude call failure (refusal,
    // transient API error, malformed image fetch) must degrade ONLY this
    // candidate, never abort the whole pass. `runVisionForCandidate` rethrows
    // on failure (it only owns the two-pass orchestration for ONE candidate,
    // not job-level resilience) — this try/catch is the pass-level boundary
    // that keeps one bad candidate from stranding every other candidate's
    // already-computed vision AND the job's already-scraped, always-valid
    // scrape results (which must persist regardless of vision outcome).
    try {
      const { result, skippedReason } = await runVisionForCandidate(
        booliId,
        candidate.imageUrls,
      );

      if (result) {
        runningVisionSek += result.costSek;
        dedupe.set(booliId, result);
      }

      out.push({ ...candidate, vision: result, visionSkippedReason: skippedReason });
    } catch {
      // The error itself was already logged (GDPR-safe { booliId, code })
      // inside runVisionForCandidate's own catch block — logging it again
      // here would be redundant. Degrade this candidate and continue; the
      // running cost total is untouched since no cost was returned.
      out.push({ ...candidate, vision: null, visionSkippedReason: "vision_error" });
    }
  }

  return out;
}
