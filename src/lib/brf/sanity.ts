/**
 * The "Osäker — kontrollera själv" confidence threshold (D-10). A field whose
 * confidence is below this is rendered with the "Osäker" badge in the UI
 * (Plan 05) and routed into the inline-edit affordance (D-12). The sanity
 * downgrade forces out-of-band values strictly below this value.
 *
 * Plan 05's UI imports this exact constant so the badge boundary and the
 * downgrade boundary can never drift apart.
 */
export const OSAKER_THRESHOLD = 0.5;

/** The confidence a sanity-failed field is forced to (strictly < OSAKER_THRESHOLD). */
const DOWNGRADED_CONFIDENCE = 0.2;

/**
 * Plausible value bands per metric, derived from BFNAR/bank guidance
 * (AI-SPEC §6, RESEARCH pitfall 4). A non-null value outside its band is a
 * likely denominator/unit confusion (e.g. monthly fee read as annual, total
 * debt read as debt/kvm) — it is confidence-downgraded, never dropped.
 *
 * Published as a single source of truth for Plan 05's methodology page.
 */
export const BRF_SANITY_BANDS = {
  /** Stockholm räntebärande skuld ÷ bostadsrättsyta, SEK/m². */
  skuldPerKvm: { min: 2000, max: 15000 },
  /** Årsavgift per kvm, SEK/m²/år. */
  avgiftsniva: { min: 300, max: 1200 },
} as const;

/** A field carrying a model-supplied value and its confidence. */
export interface SanityField<T = number> {
  value: T | null;
  confidence: number;
}

/** Which fields `applySanityChecks` inspects (each optional in the input). */
type SanityFieldKey = keyof typeof BRF_SANITY_BANDS;

/** The per-field input/output map for `applySanityChecks`. */
export type SanityInput = Partial<Record<SanityFieldKey, SanityField>>;

/**
 * Range-band confidence guardrail (D-10). For each provided field whose
 * non-null value falls outside its plausible band, forces `confidence` below
 * the Osäker threshold — regardless of how confident the model was. This is
 * the correctness layer on top of schema validity: `messages.parse` guarantees
 * shape, not that a number is right (AI-SPEC pitfall 2).
 *
 * The value is NEVER dropped or altered — only its confidence is lowered, so
 * the figure stays visible and editable for the user (D-12). In-band fields
 * pass through completely unchanged. Pure function, no Claude.
 *
 * @param input - per-field `{ value, confidence }` map (any subset)
 * @returns the same map with out-of-band fields' confidence downgraded
 */
export function applySanityChecks<T extends SanityInput>(input: T): T {
  const result = { ...input } as SanityInput;

  for (const key of Object.keys(BRF_SANITY_BANDS) as SanityFieldKey[]) {
    const field = result[key];
    if (!field || field.value === null) continue;

    const band = BRF_SANITY_BANDS[key];
    const outOfBand = field.value < band.min || field.value > band.max;
    if (outOfBand) {
      result[key] = {
        value: field.value,
        confidence: DOWNGRADED_CONFIDENCE,
      };
    }
  }

  return result as T;
}

/** Confidence assigned to a human-entered value — authoritative (WR-02). */
export const MANUAL_CONFIDENCE = 1;

/**
 * Forces every manually-corrected field's confidence to authoritative (D-12 /
 * WR-02), overriding any sanity-band downgrade. A user who deliberately enters
 * an out-of-band figure ("manual = authoritative") must not have their own
 * input flagged "Osäker" purely because it sits outside the plausible band.
 *
 * The GRADE is still re-scored deterministically from the value elsewhere;
 * this only governs the stored per-field confidence. Pure function, no Claude.
 *
 * @param perFieldConfidence - the post-sanity confidence map (mutated copy returned)
 * @param manualFields - keys the user explicitly corrected
 * @returns a new map with manual fields pinned to `MANUAL_CONFIDENCE`
 */
export function applyManualConfidence(
  perFieldConfidence: Record<string, number>,
  manualFields: readonly string[],
): Record<string, number> {
  const result = { ...perFieldConfidence };
  for (const field of manualFields) {
    if (field in result) {
      result[field] = MANUAL_CONFIDENCE;
    }
  }
  return result;
}
