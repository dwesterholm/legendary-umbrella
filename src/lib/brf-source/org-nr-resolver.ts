/**
 * org-nr-resolver.ts — confidence-gated `brfName` (+ listing geography) →
 * organisationsnummer resolution (ENRICH-01/02), plus strict Swedish org.nr
 * format validation.
 *
 * PURE LOGIC ONLY — this module performs NO network I/O. The registry
 * candidate list (name/kommun tuples) is looked up over the network by
 * `allabrf.ts` and injected here by the Plan 03 action layer, so
 * `resolveOrgNr` is deterministically unit-testable and trivially
 * re-targetable to a future Bolagsverket-backed candidate source without
 * touching this file's decision logic.
 *
 * Pitfall 4 (BRF name collisions — 08-RESEARCH.md): many BRFs nationwide
 * share generic names ("Björken", "Solgläntan", ...). A name-only match is
 * NEVER sufficient to auto-fetch a specific BRF's financials — doing so
 * risks silently analyzing and displaying the WRONG association's numbers to
 * the user (T-08-06, wrong-BRF information disclosure). `resolveOrgNr`
 * therefore returns `confidence: "high"` ONLY when there is EXACTLY ONE
 * name-matching candidate AND that candidate's registered kommun corroborates
 * the listing's own breadcrumb kommun. Every other case — zero matches,
 * multiple matches, or a name match with no/mismatched geographic signal —
 * fails closed to `"low"`/`"none"`, which the Plan 03 action layer must
 * treat as "never auto-fetch, fall through to manual upload / user
 * confirmation."
 *
 * V5 Input Validation (08-RESEARCH.md Security Domain): a resolved org.nr is
 * validated via `isValidOrgNr` (10-digit + Luhn/mod-10 checksum) before it is
 * ever interpolated into an outbound Allabrf/Bolagsverket URL — this mirrors
 * `url-guard.ts`'s "fail closed, never assume safe" posture, applied to
 * format validation instead of IP classification.
 */

/**
 * Validates a Swedish organisationsnummer's FORMAT: exactly 10 digits
 * (accepting both `NNNNNN-NNNN` and `NNNNNNNNNN` forms — a single hyphen is
 * stripped before validation) whose 10th digit satisfies the Luhn (mod-10)
 * checksum over the first 9 digits. Swedish organisationsnummer share the
 * same Luhn check digit as personnummer.
 *
 * Returns `false` for anything malformed (wrong length, non-digit
 * characters, more than one hyphen, bad checksum) — fail closed, never
 * "probably fine."
 */
export function isValidOrgNr(candidate: string): boolean {
  if (typeof candidate !== "string") return false;

  const hyphenCount = (candidate.match(/-/g) ?? []).length;
  if (hyphenCount > 1) return false;

  const stripped = hyphenCount === 1 ? candidate.replace("-", "") : candidate;
  if (!/^\d{10}$/.test(stripped)) return false;

  return luhnChecksumValid(stripped);
}

/**
 * Luhn (mod-10) checksum: doubles every digit at an even index (0-based,
 * from the left) among the first 9 digits, subtracts 9 from any doubled
 * value over 9, sums all 10 digits (including the check digit), and requires
 * the total to be divisible by 10.
 */
function luhnChecksumValid(tenDigits: string): boolean {
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let digit = Number(tenDigits[i]);
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  const checkDigit = Number(tenDigits[9]);
  return (sum + checkDigit) % 10 === 0;
}

/** A single registry candidate — injected by the caller, never fetched here. */
export interface OrgNrCandidate {
  orgNr: string;
  name: string;
  kommun: string | null;
}

/**
 * Discriminated result of an org.nr resolution attempt.
 *
 * - `high` — exactly one name-matching candidate, geographically
 *   corroborated, Luhn-valid org.nr. Safe to auto-fetch.
 * - `low` — one or more name-matching candidates but NOT high-confidence
 *   (ambiguous, or no/mismatched geographic corroboration). NEVER
 *   auto-fetch; the caller should surface `candidates` for user
 *   confirmation or fall through to manual upload.
 * - `none` — zero name-matching candidates.
 */
export type OrgNrResolution =
  | { confidence: "high"; orgNr: string; matchedName: string }
  | { confidence: "low"; candidates: Array<{ orgNr: string; name: string }> }
  | { confidence: "none" };

const BRF_PREFIX_RE = /^(bostadsrattsforeningen|bostadsrattsforening|brf)\s+/;

/**
 * Shared normalization chain used by BOTH `normalizeName` and
 * `normalizeKommun`: lowercases, trims, collapses internal whitespace, and
 * transliterates the three Swedish accented letters to their ASCII base (so
 * "Björken"/"Bjorken" or "Göteborg"/"Goteborg" compare equal regardless of
 * source encoding quirks). Extracted so the two comparisons can never drift
 * apart from each other.
 */
function normalizeSwedishText(value: string): string {
  return value
    .toLowerCase()
    .replace(/å/g, "a")
    .replace(/ä/g, "a")
    .replace(/ö/g, "o")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Normalizes a BRF name for comparison: applies `normalizeSwedishText`, then
 * strips a leading "bostadsrättsföreningen"/"brf"/"bostadsrattsforening"
 * prefix token so "Bostadsrättsföreningen Björken" and "Brf Björken"
 * normalize identically.
 */
function normalizeName(name: string): string {
  const lowered = normalizeSwedishText(name);
  return lowered.replace(BRF_PREFIX_RE, "").trim();
}

const KOMMUN_SUFFIX_RE = /\s+(kommun|stad)$/;

/**
 * Normalizes a kommun name for `resolveOrgNr`'s geographic-corroboration
 * comparison (D-14-09).
 *
 * WHY: Booli's breadcrumb yields the Swedish GENITIVE kommun label
 * ("Stockholms kommun" / "Stockholms"), while a registry candidate carries
 * the NOMINATIVE ("Stockholm"). With only lowercase+trim these never
 * matched, so `geoCorroborated` in `resolveOrgNr` never held for a discovery
 * candidate and `resolveOrgNr` could never reach `"high"` — making ANL-03 a
 * no-op behind an unreachable gate. This function closes that gap.
 *
 * Chain, in order: (1) the shared `normalizeSwedishText` lowercase/trim/
 * whitespace-collapse/transliterate chain (mirroring `normalizeName`, never
 * duplicating it); (2) strip a trailing " kommun" / " stad" suffix if
 * present (defence in depth — the caller already strips " kommun" from the
 * breadcrumb, but a registry value may carry it); (3) strip a SINGLE
 * trailing possessive "s" when the remaining stem is longer than 3
 * characters, so "Stockholms kommun" -> "stockholm", "Stockholm" ->
 * "stockholm", "Göteborgs" -> "goteborg", "Malmö" -> "malmo".
 *
 * WHY IT IS SAFE despite being lossy: `resolveOrgNr` applies this SAME
 * normalization to BOTH sides of the comparison (the listing's kommun AND
 * the candidate's registered kommun) — a symmetric transform applied to
 * both operands cannot create a one-sided false match. A Swedish kommun
 * name that already ends in "-s" (e.g. "Bengtsfors") has an identical
 * genitive form, so both sides still normalize to the same stem and the
 * comparison remains correct even though the intermediate stem is not the
 * "true" nominative.
 *
 * THE BOUNDED RESIDUAL RISK: two DISTINCT kommuns differing only by a
 * trailing "s" would collapse to the same stem. No such pair exists among
 * Sweden's 290 kommuns; the >3-character stem guard additionally prevents
 * short-name collapse. This can only fail in the SAFE direction for that
 * hypothetical pair, and the fail-closed Pitfall-4 posture (multiple name
 * matches still -> `"low"`) is untouched — see `resolveOrgNr` below.
 */
export function normalizeKommun(kommun: string): string {
  let normalized = normalizeSwedishText(kommun);
  normalized = normalized.replace(KOMMUN_SUFFIX_RE, "");
  if (normalized.endsWith("s")) {
    const stem = normalized.slice(0, -1);
    if (stem.length > 3) {
      normalized = stem;
    }
  }
  return normalized;
}

/**
 * Resolves `input.brfName` (+ `input.kommun` geographic corroboration)
 * against an injected list of registry candidates. NO network I/O — pure
 * decision logic over already-fetched candidates (see module doc comment).
 *
 * Per Pitfall 4: `confidence: "high"` requires ALL of:
 *   1. Exactly one candidate whose normalized name equals the normalized
 *      `brfName` (never a substring/fuzzy match — exact-after-normalization
 *      only, per the RESOLVED Open Question 3 definition).
 *   2. That candidate's kommun (case-insensitive) equals the input kommun.
 *   3. The candidate's org.nr passes `isValidOrgNr`.
 * A name-only match — no geographic signal available, or a mismatched one —
 * is NEVER promoted to `high`; it falls to `low` so the caller can only
 * offer it as a user-confirmable suggestion, never an auto-fetch.
 */
export function resolveOrgNr(input: {
  brfName: string | null;
  kommun: string | null;
  candidates: OrgNrCandidate[];
}): OrgNrResolution {
  const { brfName, kommun, candidates } = input;

  if (!brfName || brfName.trim().length === 0) {
    return { confidence: "none" };
  }

  const normalizedTarget = normalizeName(brfName);
  const nameMatches = candidates.filter(
    (c) => normalizeName(c.name) === normalizedTarget,
  );

  if (nameMatches.length === 0) {
    return { confidence: "none" };
  }

  if (nameMatches.length === 1) {
    const candidate = nameMatches[0];
    const geoCorroborated =
      kommun !== null &&
      kommun.trim().length > 0 &&
      candidate.kommun !== null &&
      normalizeKommun(candidate.kommun) === normalizeKommun(kommun);

    if (geoCorroborated && isValidOrgNr(candidate.orgNr)) {
      return {
        confidence: "high",
        orgNr: candidate.orgNr,
        matchedName: candidate.name,
      };
    }
  }

  // Multiple matches, or a single match without geographic corroboration /
  // a bad-Luhn org.nr — ambiguous or unverifiable. Never guess: fail closed
  // to "low" so the caller surfaces candidates for confirmation rather than
  // auto-fetching a possibly-wrong BRF's financials.
  return {
    confidence: "low",
    candidates: nameMatches.map((c) => ({ orgNr: c.orgNr, name: c.name })),
  };
}
