import { z } from "zod/v4";
import { OSAKER_THRESHOLD } from "@/lib/brf/sanity";

/**
 * holistic-schema.ts — Phase 14 (ANL-01/02/03) PERSISTED holistic-analysis
 * shapes for the discovery brain (SPEC §2.2/§2.6): the per-area comps
 * aggregate, the per-candidate BRF summary, and the data-only holistic brief
 * that fills in for an empty `claims: []` vision result.
 *
 * STRUCTURAL SEPARATION: on the vision/analysis read path; like
 * `flip-economics.ts` / `area-comps.ts` it must never be imported by
 * `niche-score.ts` / `flags.ts` (enforced by the niche-score.test.ts
 * static-grep invariant — this module's specifier is registered there in the
 * SAME commit that introduces this file).
 *
 * None of these shapes are EVER sent to Claude — they are code-attached from
 * comps/BRF data (deterministic aggregation + code composition), never a
 * model output. The Anthropic strict-output slim-schema discipline
 * (`vision-schema.ts`'s single-nullable-leaf rule, project memory
 * `anthropic-structured-output-limits`) is therefore structurally NOT
 * applicable here — only the READ path (a persisted, possibly
 * drifted/hand-edited row) needs a guard, mirroring `visionResultSchema`'s
 * own read-only discipline: nullable-tolerant, no numeric-constraint-chain
 * validators.
 *
 * GDPR: only pre-AGGREGATED numbers/strings are persisted here — never
 * individual sold-comp rows (those stay ephemeral inside `computeAreaComps`'s
 * caller) and never raw Allabrf document text (14-RESEARCH.md Pitfall 5).
 */

// ---------------------------------------------------------------------------
// Data-only marker + tomträtt derivation
// ---------------------------------------------------------------------------

/**
 * D-14-04's data-only marker — the SIBLING of the rendered
 * image-interpretation framing in `gallery-condition-vision.tsx`
 * ("AI-bedömning av bilder — kan vara fel" / "Tolkat från bilder i annonsen
 * …"). The string `"från bildtolkning"` itself is a CODE-COMMENT convention
 * only (see `condition-score.ts`/`flip-economics.ts`/`niche-score.test.ts`)
 * and is never rendered anywhere — this marker is therefore a new sibling of
 * that framing, not a mirror of a rendered string. Renders alongside the
 * holistic brief so a data-only inference is never mistaken for an
 * image-verified one.
 */
export const HOLISTIC_DATA_ONLY_MARKER = "Baserat på områdesdata — ingen bildtolkning" as const;

/** Matches a tenureForm value naming tomträtt (site leasehold), either graphy. */
export const TOMTRATT_TENURE_PATTERN = /tomtr(ä|a)tt/i;

/**
 * Derives a `true | null` tomträtt signal from the LISTING's `tenureForm`.
 *
 * `tenureForm` distinguishes Bostadsrätt vs Äganderätt and structurally
 * CANNOT disprove tomträtt — the BRF, not the unit, holds the tomträtt, so a
 * `tenureForm` of "Bostadsrätt" says nothing about whether the underlying
 * mark is owned or leasehold. 14-RESEARCH.md Pitfall 4 / open question OQ-2
 * records that every committed `tenureForm` fixture is `"Bostadsrätt"` and no
 * tomträtt-shaped value has ever been observed live. Returning `null`
 * (unknown) rather than `false` keeps that inertness OBSERVABLE — a `false`
 * would silently assert "no tomträtt" on evidence that cannot support it.
 *
 * @returns `true` when `tenureForm` matches `TOMTRATT_TENURE_PATTERN`,
 *   otherwise `null`. NEVER `false`.
 */
export function tomtrattFromTenureForm(tenureForm: string | null): true | null {
  return typeof tenureForm === "string" && TOMTRATT_TENURE_PATTERN.test(tenureForm) ? true : null;
}

// ---------------------------------------------------------------------------
// AreaCompsSummary — the AGGREGATE of computeAreaComps, no individual rows
// ---------------------------------------------------------------------------

/**
 * The per-area comps AGGREGATE persisted onto a `DiscoveryCandidate`,
 * deliberately carrying NO individual comp rows (GDPR + payload-size
 * discipline). Mirrors `AreaComps` (`area-comps.ts`) plus the metadata a
 * persisted read needs: `areaId` (which area this aggregate belongs to),
 * `asOf` (the reference date `computeAreaComps` was filtered against), and
 * `widenedBand` (true when the caller re-ran `computeAreaComps` with a
 * widened size/age band because the tight segment had fewer than
 * `MIN_COMPS_FOR_CONFIDENCE` comps — SPEC §2.6).
 */
export interface AreaCompsSummary {
  readonly areaId: string;
  readonly renovatedMedianPerSqm: number | null;
  readonly unrenovatedMedianPerSqm: number | null;
  readonly overallMedianPerSqm: number | null;
  readonly renovatedCapPerSqm: number | null;
  readonly sampleSize: number;
  readonly confident: boolean;
  /** ISO "YYYY-MM-DD" reference date this aggregate was computed against. */
  readonly asOf: string;
  /** True when the tight segment was widened (thin-sample fallback, SPEC §2.6). */
  readonly widenedBand: boolean;
}

/**
 * Read-path Zod guard for a persisted `AreaCompsSummary` (mirrors
 * `visionResultSchema`'s discipline — nullable-tolerant, NO numeric
 * constraint chains; this is a read guard, not an LLM-facing schema).
 */
export const areaCompsSummarySchema = z.object({
  areaId: z.string(),
  renovatedMedianPerSqm: z.number().nullable(),
  unrenovatedMedianPerSqm: z.number().nullable(),
  overallMedianPerSqm: z.number().nullable(),
  renovatedCapPerSqm: z.number().nullable(),
  sampleSize: z.number(),
  confident: z.boolean(),
  asOf: z.string(),
  widenedBand: z.boolean(),
});

// ---------------------------------------------------------------------------
// BrfSummary — D-14-02's summary, aggregate figures only, never raw doc text
// ---------------------------------------------------------------------------

/**
 * The three numeric `BrfSummary` fields `scoreExtraction`
 * (`src/lib/brf/run-extraction.ts`) reports a per-field confidence for that
 * this module carries onto `BrfSummary.fieldConfidence`. Deliberately
 * excludes `underhallsplanStatus` — that key is NOT on `BrfSummary`.
 */
export const BRF_CONFIDENCE_FIELDS = ["skuldPerKvm", "avgiftsniva", "kassaflode"] as const;

export type BrfConfidenceField = (typeof BRF_CONFIDENCE_FIELDS)[number];

/**
 * The per-candidate BRF summary (D-14-02): `skuldPerKvm`/`avgiftsniva`/
 * `kassaflode`/`stambytePlanerat` from the existing `brfExtractionSchema`
 * (`src/lib/schemas/brf.ts`), plus `tomtratt` — derived from the LISTING's
 * `tenureForm` via `tomtrattFromTenureForm`, NEVER from the BRF document
 * itself (the BRF document has no tomträtt field). `soliditet` is DEFERRED —
 * no field exists on `brfExtractionSchema` today (14-CONTEXT.md Deferred
 * Ideas). Only aggregate figures are carried here — never raw document text.
 *
 * `fieldConfidence` (CR-02, 14-REVIEW.md): the per-field confidence AFTER
 * `applySanityChecks` (`src/lib/brf/sanity.ts`), which forces an out-of-band
 * `skuldPerKvm`/`avgiftsniva` reading to `0.2` — strictly below
 * `OSAKER_THRESHOLD` — WITHOUT altering the value itself. `null` means
 * "confidence unknown" (a row persisted before this field existed, or a
 * legacy read), which every consumer MUST treat as UNTRUSTED — this is the
 * same trust pipeline the single-listing "Osäker — kontrollera själv" badge
 * uses (D-14-02).
 */
export interface BrfSummary {
  readonly skuldPerKvm: number | null;
  readonly avgiftsniva: number | null;
  readonly kassaflode: number | null;
  readonly stambytePlanerat: string | null;
  /** Derived from the listing's tenureForm — never from the BRF document. */
  readonly tomtratt: true | null;
  readonly fiscalYear: number | null;
  readonly source: "allabrf";
  /**
   * Per-field confidence after the sanity-band downgrade (CR-02). `null`
   * means unknown (legacy row) — never treat `null` as trusted.
   */
  readonly fieldConfidence: Readonly<Record<BrfConfidenceField, number | null>> | null;
}

/**
 * Read-path Zod guard for a persisted `BrfSummary` (same read-guard
 * discipline as `areaCompsSummarySchema` — nullable-tolerant, no numeric
 * constraints).
 *
 * `fieldConfidence`'s `.default(null)` is LOAD-BEARING: this schema is
 * nested inside `discoveryCandidateSchema` (`candidate.ts`), whose consumer
 * (`src/app/(app)/discover/[jobId]/page.tsx`) drops the ENTIRE candidate on
 * a nested parse failure — a required key here (with no default) would
 * erase every pre-existing persisted candidate from the results page the
 * moment this field shipped. A legacy row without the key parses to
 * `fieldConfidence: null`, which `brfFieldTrusted` treats as untrusted.
 */
export const brfSummarySchema = z.object({
  skuldPerKvm: z.number().nullable(),
  avgiftsniva: z.number().nullable(),
  kassaflode: z.number().nullable(),
  stambytePlanerat: z.string().nullable(),
  tomtratt: z.literal(true).nullable(),
  fiscalYear: z.number().nullable(),
  source: z.literal("allabrf"),
  fieldConfidence: z
    .object({
      skuldPerKvm: z.number().nullable(),
      avgiftsniva: z.number().nullable(),
      kassaflode: z.number().nullable(),
    })
    .nullable()
    .default(null),
});

/**
 * `brfFieldTrusted` — the SINGLE fail-closed `OSAKER_THRESHOLD` gate every
 * consumer must use to decide whether a `BrfSummary` figure may be
 * presented as fact or used in downstream arithmetic (CR-02, 14-REVIEW.md).
 *
 * Fails CLOSED: a `null` summary, a `null` value, a missing/`null`
 * `fieldConfidence` map, or a confidence strictly below `OSAKER_THRESHOLD`
 * all return `false`. An absent confidence is an absence of evidence, not
 * evidence of trustworthiness — per D-14-05 the phase's default posture is
 * "cannot attribute", never a silent assumption. This is deliberately the
 * ONLY place that decision is made; plan 14-10 calls it from both
 * `normalizeForConfounders` and `buildBrfItem`.
 *
 * @param brf - the `BrfSummary` to check, or `null`
 * @param field - which confidence-tracked field to check
 * @returns `true` only when the field's value is a finite number AND its
 *   confidence is a finite number `>= OSAKER_THRESHOLD`
 */
export function brfFieldTrusted(brf: BrfSummary | null, field: BrfConfidenceField): boolean {
  if (brf === null) return false;
  const value = brf[field];
  if (value === null || !Number.isFinite(value)) return false;
  if (brf.fieldConfidence === null) return false;
  const confidence = brf.fieldConfidence[field];
  return confidence !== null && Number.isFinite(confidence) && confidence >= OSAKER_THRESHOLD;
}

// ---------------------------------------------------------------------------
// HolisticBrief — the no-empty-analysis fallback (ANL-01, D-14-03/D-14-04)
// ---------------------------------------------------------------------------

/** The kinds of item a holistic brief can carry, in no particular order. */
export const HOLISTIC_BRIEF_ITEM_KINDS = [
  "comps-positioning",
  "confounder",
  "brf",
  "insufficient-data",
] as const;

export type HolisticBriefItemKind = (typeof HOLISTIC_BRIEF_ITEM_KINDS)[number];

/** One item in a `HolisticBrief` — code-generated Swedish prose, never a raw quote. */
export interface HolisticBriefItem {
  readonly kind: HolisticBriefItemKind;
  readonly text: string;
}

/**
 * The holistic-data-only opportunity brief (D-14-03) that fills in for an
 * empty `claims: []` vision result — comps positioning (R_med/U_med) +
 * hedonic confounders, plus a BRF item when this candidate is in the D-14-01
 * BRF top-N. `confidence` can NEVER be `"high"` — D-14-04 mandates a
 * downgraded confidence for a data-only brief (a data-only inference is
 * structurally weaker than an image-verified claim). `items` is guaranteed
 * non-empty by its builder (ANL-01) — every candidate leaves analysis with
 * ≥1 actionable item.
 */
export interface HolisticBrief {
  readonly marker: string;
  readonly confidence: "low" | "medium";
  readonly items: HolisticBriefItem[];
  readonly dataSources: Array<"comps" | "brf" | "hedonic">;
  readonly conditionAttribution: {
    readonly explainedPct: number | null;
    readonly capped: boolean;
    readonly residualDrivers: string[];
    readonly canAttributeToCondition: boolean;
    /**
     * WR-11 (14-REVIEW.md): the kr/m² BASIS the verdict was actually computed
     * from — `pricePerSqm` plus the förening's debt/m² when that figure was
     * usable (SPEC §2.6 rule 1). Previously computed and thrown away, which
     * left a `deepDiscount`/`explainedPct` verdict un-auditable after the fact:
     * the single most decision-relevant number in the module (and the one the
     * CR-02 ANL-04 defect turned on) was invisible in the persisted record.
     * `null` when no price was available.
     */
    readonly effectivePricePerSqm: number | null;
    /** Whether BRF debt/m² is INCLUDED in `effectivePricePerSqm` (WR-11). */
    readonly debtIncluded: boolean;
  };
}

/**
 * Read-path Zod guard for a persisted `HolisticBrief`. `confidence` is
 * restricted to `"low" | "medium"` at the schema level — a stored `"high"`
 * (write-path bug, hand-edited row) fails `safeParse` rather than being
 * silently trusted, mirroring this file's own D-14-04 invariant.
 */
export const holisticBriefSchema = z.object({
  marker: z.string(),
  confidence: z.enum(["low", "medium"]),
  items: z.array(
    z.object({
      kind: z.enum(HOLISTIC_BRIEF_ITEM_KINDS),
      text: z.string(),
    }),
  ),
  dataSources: z.array(z.enum(["comps", "brf", "hedonic"])),
  conditionAttribution: z.object({
    explainedPct: z.number().nullable(),
    capped: z.boolean(),
    residualDrivers: z.array(z.string()),
    canAttributeToCondition: z.boolean(),
    // WR-11 additions — `.default(...)` (never a bare required key) for the
    // same load-bearing reason `fieldConfidence.default(null)` above has one:
    // this schema is nested inside `discoveryCandidateSchema`, so a required
    // key here would have degraded every pre-existing persisted brief the
    // moment this field shipped.
    effectivePricePerSqm: z.number().nullable().default(null),
    debtIncluded: z.boolean().default(false),
  }),
});
