import { z } from "zod/v4";
import { isAllowedImageHost } from "@/lib/booli/client";

/**
 * vision-schema.ts — Phase 11 (DISC-04) foundation contracts: the slim
 * Claude-facing pre-filter/deep-pass schemas AND the persisted `VisionResult`
 * shape + its read-guard.
 *
 * SLIM-SCHEMA DISCIPLINE (mirrors `src/lib/brf/extract.ts`'s `claudeField`
 * EXACTLY — the project's own documented workaround for the two Anthropic
 * strict-output 400s, see project memory `anthropic-structured-output-limits`
 * and 11-RESEARCH.md Pitfall 3):
 *   1. "Compiled grammar is too large" — numeric `.min()/.max()/.int()` chains
 *      across many fields. NONE are used anywhere in this file.
 *   2. "Too many parameters with union types" — every extra `.nullable()`
 *      leaf field adds a union. `conditionAttribute` has exactly ONE nullable
 *      leaf (`claim`); `visionDeepPassSchema` composes 4 of these as flat,
 *      NAMED top-level fields (kitchen/bathroom/overall/remodelPotential) —
 *      NOT an array-of-objects, which would reproduce the exact trap this
 *      file exists to avoid (11-RESEARCH.md Pitfall 3 / 11-PATTERNS.md
 *      Pattern 2). `remodelPotential` (Phase 12, DISC-05, 12-RESEARCH.md
 *      Open Question 4) reuses `conditionAttribute` VERBATIM — 4 nullable
 *      leaves total is still far under the ~28-nullable-union threshold.
 *
 * A live API smoke test (per project memory: mocked tests do NOT catch the
 * 400) against this now-4-leaf schema is Plan 04's OPERATOR-DEFERRED
 * responsibility (12-VALIDATION.md Manual-Only) — this file only statically
 * asserts the shape (nullable-leaf count, absence of numeric constraints) so
 * the trap is caught by a test, not a production 400.
 */

// ---------------------------------------------------------------------------
// CLAUDE-FACING schemas (sent to output_config.format)
// ---------------------------------------------------------------------------

/**
 * One image-cited condition attribute (kitchen/bathroom/overall). Mirrors
 * `extract.ts`'s `claudeField()` single-nullable-leaf discipline EXACTLY:
 * only `claim` is nullable; `imageIndex`/`whatWasSeen`/`confidence` are
 * always present with sentinel values when `claim` is null.
 *
 * Every claim MUST cite an image (mandatory citation, CONTEXT.md locked
 * constraint) — `imageIndex` + `whatWasSeen` are the schema-enforced citation
 * fields (no uncited claim can pass through this shape).
 */
const conditionAttribute = z.object({
  claim: z
    .string()
    .nullable()
    .describe(
      "Hedged Swedish claim, t.ex. 'Köket verkar renoverat'. Null om inte bedömbart utifrån bilderna.",
    ),
  imageIndex: z
    .number()
    .describe(
      "1-baserat index i de bilder som skickades (matchar 'Bild N'-etiketten), eller 0 om claim är null.",
    ),
  whatWasSeen: z
    .string()
    .describe(
      "Specifik synlig detalj som stödjer claim — fysiska ytskikt/inredning, t.ex. 'nya vitvaror, kaklat stänkskydd, golv'. ALDRIG personer eller identifierbara detaljer. Tom sträng om claim är null.",
    ),
  confidence: z.number().describe("0-1 konfidens i denna bedömning."),
});

/**
 * The Sonnet deep-pass schema. Four flat NAMED top-level fields (NOT
 * `z.array(z.object(...))` — see file-level doc comment / Pitfall 3). 4
 * nullable leaves total (`kitchen.claim`, `bathroom.claim`, `overall.claim`,
 * `remodelPotential.claim`), well under the ~28-nullable-union threshold
 * that tripped `extract.ts`'s original schema design.
 *
 * `remodelPotential` (Phase 12, DISC-05) reuses `conditionAttribute`
 * VERBATIM — it is an investigation-PROMPT about the floor plan (the
 * floor-plan image is already ordered first in the capped image set sent to
 * this call, `extractImageUrls`), never a load-bearing/wall-removal verdict.
 * The mandatory "kräver konstruktör / väggutredning" disclaimer is enforced
 * BOTH in the deep-pass prompt (vision-prompt.ts) AND, belt-and-suspenders,
 * in code after parsing (vision.ts) — a liability-bearing sentence must
 * never depend solely on model compliance.
 */
export const visionDeepPassSchema = z.object({
  kitchen: conditionAttribute,
  bathroom: conditionAttribute,
  overall: conditionAttribute,
  remodelPotential: conditionAttribute,
});

/**
 * The Haiku pre-filter (triage) schema — a slim boolean gate deciding whether
 * a candidate's image set is worth the more expensive Sonnet deep pass. No
 * nullable unions at all.
 */
export const preFilterSchema = z.object({
  worthDeepPass: z
    .boolean()
    .describe(
      "True om någon bild verkar visa tillräckligt av kök/badrum/allmänt skick för en djupare granskning.",
    ),
});

// ---------------------------------------------------------------------------
// PERSISTED shapes (plain TS interfaces — NOT sent to Anthropic)
// ---------------------------------------------------------------------------

/**
 * One hedged, image-cited condition claim (persisted shape). Mirrors
 * `src/lib/report/flags.ts`'s `SoftSignalField<T>` — the closest existing
 * "cite the source, hedge the language" shape in this codebase — applied to
 * an image index instead of a page ref.
 */
export interface VisionConditionClaim {
  attribute: "kitchen" | "bathroom" | "overall" | "remodelPotential";
  claim: string;
  imageIndex: number;
  whatWasSeen: string;
  confidence: number;
}

/**
 * The full per-candidate vision result — additive-nullable field on
 * `DiscoveryCandidate` (`src/lib/discovery/candidate.ts`). An empty `claims`
 * array means "vision ran, nothing cleared the confidence bar," distinct from
 * `vision: null` (see `visionSkippedReason` on `DiscoveryCandidate` for the
 * "didn't run at all" states).
 */
export interface VisionResult {
  claims: VisionConditionClaim[];
  /** The exact images sent, for thumbnail rendering (Bild N → imageUrlsUsed[N-1]). */
  imageUrlsUsed: string[];
  /** Which model produced this result — trace/audit, mirrors report.ts's `model` field. */
  model: string;
  /** This candidate's vision spend — trace, feeds the incremental CAP_VISION_SEK_MAX check. */
  costSek: number;
  /** ISO timestamp — supports cache TTL decisions later if needed. */
  ranAt: string;
}

/**
 * Read-path Zod guard for a persisted `VisionResult` (mirrors
 * `discoveryCandidateSchema`'s read-path-guard discipline — nullable-tolerant,
 * no LLM-facing numeric constraints). Consumed by
 * `discoveryCandidateSchema`'s `vision: visionResultSchema.nullable().default(null)`
 * field.
 */
export const visionResultSchema = z.object({
  claims: z.array(
    z.object({
      attribute: z.enum(["kitchen", "bathroom", "overall", "remodelPotential"]),
      claim: z.string(),
      imageIndex: z.number(),
      whatWasSeen: z.string(),
      confidence: z.number(),
    }),
  ),
  // WR-03 (shard-5 review): `imageUrlsUsed` is the array actually rendered as
  // `<img src>` thumbnails in gallery-condition-vision.tsx, yet it was the one
  // URL field with no read-path allowlist re-check (unlike
  // discoveryCandidateSchema.imageUrls). Re-apply `isAllowedImageHost` on read
  // so a tampered/corrupted persisted row cannot render an arbitrary host
  // (SSRF-beacon / tracking-pixel / mixed-content). Write-time `capped` is
  // already filtered (vision.ts), so this is a no-op for legitimate rows.
  imageUrlsUsed: z.array(z.string()).transform((urls) => urls.filter(isAllowedImageHost)),
  model: z.string(),
  costSek: z.number(),
  ranAt: z.string(),
});

/**
 * Below this confidence, a claim is dropped entirely before persistence —
 * never shown greyed-out (UI-SPEC "low-confidence claims are simply
 * omitted"). Mirrors `parseIntent`'s existing low-confidence fail-safe
 * posture (11-RESEARCH.md Recommended caps table).
 */
export const VISION_CONFIDENCE_THRESHOLD = 0.6;
