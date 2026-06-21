import { z } from "zod/v4";

/**
 * sold-schema.ts — the null-tolerant normalization + persisted-read-path guard
 * for the sold-price (slutpriser) panel (PRICE-01).
 *
 * Source shape (03-SPIKE.md §1.3): Booli server-renders every comp into the page
 * HTML as `__NEXT_DATA__ → props.pageProps.__APOLLO_STATE__ → SoldProperty:<id>`.
 * We read that SSR Apollo blob — NOT the Cloudflare-walled `/graphql` API. The
 * committed fixture `__fixtures__/sold-comps.json` is a real redacted payload
 * stored in the TRUE live shape `{ items: [{ hasApollo, __APOLLO_STATE__ }] }`
 * (the exact array `fetchSoldComps` returns — Apify dataset items), so the
 * normalize here parses the live shape (the tests read the fixture; no live calls).
 *
 * Mirrors the Phase 1/2 conventions: `import { z } from "zod/v4"`, a permissive
 * `.passthrough()` raw schema (listing.ts:15-30), local `num`/`str`/`rawOf`
 * coercion helpers that fall back to null and never throw (listing.ts:64-86,
 * RESEARCH Pattern 3), and a `safeParse*` persisted read-path guard mirroring
 * `safeParseBrfData` (brf.ts:165-169, RESEARCH Pattern 4).
 */

// ---------------------------------------------------------------------------
// Raw payload schema (permissive — never break on extra/partial fields)
// ---------------------------------------------------------------------------

// Booli formatted-value objects, e.g. { formatted: "5 280 000 kr", raw: 5280000 }.
const formattedValueSchema = z
  .object({
    raw: z.number().optional(),
    value: z.string().optional(),
    formatted: z.string().optional(),
    unit: z.string().optional(),
  })
  .passthrough();

// A single rendered data point, e.g. plainText "53 300 kr/m²" / "99 m²" / "4 rum".
const dataPointSchema = z
  .object({
    value: z
      .object({ plainText: z.string().optional() })
      .passthrough()
      .optional(),
    screenReaderLabel: z.string().optional(),
  })
  .passthrough();

// A single raw `SoldProperty:<id>` Apollo entry. `.passthrough()` so the many
// fields we ignore (images, location, primaryImage, …) never break parsing.
const soldPropertyRawSchema = z
  .object({
    __typename: z.literal("SoldProperty").optional(),
    id: z.string().optional(),
    booliId: z.string().optional(),
    soldPrice: formattedValueSchema.nullable().optional(),
    listPrice: formattedValueSchema.nullable().optional(),
    soldPricePercentageDiff: formattedValueSchema.nullable().optional(),
    soldPriceAbsoluteDiff: formattedValueSchema.nullable().optional(),
    soldDate: z.string().nullable().optional(),
    objectType: z.string().nullable().optional(),
    daysActive: z.number().nullable().optional(),
    soldPriceType: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * The whole rendered page subset: `__APOLLO_STATE__` is a map keyed by
 * `SoldProperty:<id>` (+ one `Area_V3:<areaId>` context object + other keys).
 * Permissive: any key shape is tolerated; normalize picks the SoldProperty ones.
 */
export const soldPayloadSchema = z
  .object({
    __APOLLO_STATE__: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type SoldPayload = z.infer<typeof soldPayloadSchema>;

// ---------------------------------------------------------------------------
// Normalized comp — the comparison axis is pris/kvm (D-03)
// ---------------------------------------------------------------------------

/**
 * A single normalized sold record. MINIMUM (D-03): a pris/kvm (the comparison
 * axis) + a sold date + an area/tier hint. Richer attributes (floor, balcony,
 * avgift, rooms, livingArea, objectType) populate ONLY where the source exposes
 * them — the comparison never blocks on them. Every field falls back to null.
 */
export interface SoldComp {
  /** kr/m² — the comparison axis (D-03). null when the source omits it. */
  prisPerKvm: number | null;
  /** ISO "YYYY-MM-DD". null when absent. */
  soldDate: string | null;
  /** Final sale price in SEK (`soldPrice.raw`). Optional bonus. */
  soldPrice?: number | null;
  /** Sold-vs-list % diff (`soldPricePercentageDiff.raw`). Optional bonus. */
  soldVsListPct?: number | null;
  /** "Lägenhet" | "Villa" | "Radhus" | … Optional bonus. */
  objectType?: string | null;
  /** Living area in m² parsed from a dataPoint. Optional bonus. */
  livingArea?: number | null;
  /** Room count parsed from a dataPoint. Optional bonus. */
  rooms?: number | null;
  /** Floor label (e.g. "vån 2"). Optional bonus. */
  floor?: string | null;
  /** Days on market (`daysActive`). Optional bonus. */
  daysActive?: number | null;
}

// ---------------------------------------------------------------------------
// Null-tolerant coercion helpers (mirror listing.ts:88-105)
// ---------------------------------------------------------------------------

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const rawOf = (v: unknown): number | null =>
  v && typeof v === "object" && "raw" in v
    ? num((v as { raw: unknown }).raw)
    : null;

/**
 * Parses a number out of a Swedish-formatted plainText such as "53 300 kr/m²",
 * "89,5 m²", "4 rum" — strips spaces (thousands sep), maps the decimal comma to
 * a dot, and reads the leading numeric run. Returns null on no usable number.
 */
function parsePlainNumber(plain: string | null): number | null {
  if (!plain) return null;
  const cleaned = plain.replace(/ /g, " ");
  const match = cleaned.match(/-?\d[\d\s]*(?:,\d+)?/);
  if (!match) return null;
  const normalized = match[0].replace(/\s/g, "").replace(",", ".");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

type DataPoint = z.infer<typeof dataPointSchema>;

/** Finds the first dataPoint whose plainText matches a predicate. */
function findDataPoint(
  points: DataPoint[],
  test: (plain: string) => boolean,
): string | null {
  for (const p of points) {
    const plain = p?.value?.plainText;
    if (typeof plain === "string" && test(plain)) return plain;
  }
  return null;
}

/** Extracts the `displayAttributes(...).dataPoints[]` array from a raw entry. */
function dataPointsOf(entry: Record<string, unknown>): DataPoint[] {
  // The Apollo key is `displayAttributes({"queryContext":"SERP_LIST_LISTING"})`.
  const attrKey = Object.keys(entry).find((k) =>
    k.startsWith("displayAttributes"),
  );
  if (!attrKey) return [];
  const attr = entry[attrKey] as { dataPoints?: unknown } | null | undefined;
  const points = attr?.dataPoints;
  return Array.isArray(points) ? (points as DataPoint[]) : [];
}

/**
 * Normalizes the raw rendered sold payload into a `SoldComp[]`.
 *
 * Walks `__APOLLO_STATE__` for every `SoldProperty:<id>` key, reading pris/kvm,
 * m² and rooms out of the `dataPoints` plainText and the numeric `.raw` fields
 * for price/% diff. Null-tolerant throughout (RESEARCH Pattern 3): a malformed
 * or partial entry yields nulls, never a throw — so one bad comp can never blank
 * the panel. Accepts ALL of: the live `fetchSoldComps` return shape — an ARRAY of
 * Apify dataset items `[{ hasApollo, __APOLLO_STATE__ }, …]` (possibly paginated
 * across multiple items) — the full `{ __APOLLO_STATE__ }` payload, OR a bare
 * `__APOLLO_STATE__` map. Comps from every item are merged.
 */
export function normalizeSoldOutput(raw: unknown): SoldComp[] {
  if (!raw || typeof raw !== "object") return [];

  // The live source returns an ARRAY of dataset items (one per rendered page),
  // each `{ hasApollo, __APOLLO_STATE__ }`. Normalize each and merge. (Vitest's
  // committed fixture was a bare payload, which is why this mismatch never tripped
  // a test — see __fixtures__/sold-comps.json, now stored in the true live shape.)
  if (Array.isArray(raw)) {
    const merged: SoldComp[] = [];
    for (const item of raw) merged.push(...normalizeSoldOutput(item));
    return merged;
  }

  const root = raw as Record<string, unknown>;
  const state =
    (root.__APOLLO_STATE__ as Record<string, unknown> | undefined) ??
    (root as Record<string, unknown>);
  if (!state || typeof state !== "object") return [];

  const comps: SoldComp[] = [];
  for (const [key, value] of Object.entries(state)) {
    if (!key.startsWith("SoldProperty:")) continue;
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;

    const points = dataPointsOf(entry);
    const prisPerKvm = parsePlainNumber(
      findDataPoint(points, (t) => /kr\/m²/i.test(t) || /kr\/kvm/i.test(t)),
    );
    const livingArea = parsePlainNumber(
      findDataPoint(points, (t) => /\bm²/.test(t) && !/kr\/m²/i.test(t)),
    );
    const rooms = parsePlainNumber(
      findDataPoint(points, (t) => /\brum\b/i.test(t)),
    );
    const floor = findDataPoint(points, (t) => /^vån\b|^BV$/i.test(t.trim()));

    comps.push({
      prisPerKvm,
      soldDate: str(entry.soldDate),
      soldPrice: rawOf(entry.soldPrice),
      soldVsListPct: rawOf(entry.soldPricePercentageDiff),
      objectType: str(entry.objectType),
      livingArea,
      rooms,
      floor,
      daysActive: num(entry.daysActive),
    });
  }
  return comps;
}

// ---------------------------------------------------------------------------
// Persisted price_data jsonb shape + read-path guard (HIGH-1 / HIGH-3)
// ---------------------------------------------------------------------------

/** A persisted sold comp — the D-05 "receipt" list. All fields nullable. */
const soldCompSchema = z.object({
  prisPerKvm: z.number().nullable(),
  soldDate: z.string().nullable(),
  soldPrice: z.number().nullable().optional(),
  soldVsListPct: z.number().nullable().optional(),
  objectType: z.string().nullable().optional(),
  livingArea: z.number().nullable().optional(),
  rooms: z.number().nullable().optional(),
  floor: z.string().nullable().optional(),
  daysActive: z.number().nullable().optional(),
});

/**
 * The persisted `price_data` jsonb shape. Carries the PriceComparison figures
 * (all nullable so a non-`ok` state omits them honestly) PLUS the HIGH-1/HIGH-3
 * `reason` discriminator, the comp "receipt" list (D-05), and source/freshness
 * labels (D-09).
 *
 * `reason` semantics (the honest-state discriminator that fixes the "dead source
 * shown as sparse" + the false "-100 % under snitt" bugs):
 *  - `ok`                 — a real comparison was computed.
 *  - `thin`               — a REAL area query returned ≤ threshold usable comps.
 *  - `source_unavailable` — the source could not be reached/parsed (set by
 *                           Plan 05's catch around fetchSoldComps, NOT here).
 *  - `listing_pris_okand` — the listing's own pris/kvm is 0/null so no ±% is
 *                           computable.
 */
export const priceDataSchema = z.object({
  reason: z.enum(["ok", "thin", "source_unavailable", "listing_pris_okand"]),
  areaAvg: z.number().nullable(),
  deltaPct: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  trendSlope: z.number().nullable(),
  sampleSize: z.number(),
  tier: z.enum(["building", "neighborhood", "wide"]).nullable(),
  confidence: z.number(),
  /** The comparable-sales receipt (D-05). */
  comps: z.array(soldCompSchema),
  /** Source + freshness labels (D-09), e.g. "Booli" / "sålda bostäder". */
  source: z.string().nullable(),
  sourceLabel: z.string().nullable(),
  recency: z.string().nullable(),
});

export type PriceData = z.infer<typeof priceDataSchema>;

/**
 * Defensive read-path guard for persisted `price_data` (CR-01 / RESEARCH
 * Pattern 4). Returns the validated payload on success, or `null` when the
 * stored JSON is missing, malformed, or shape-drifted — callers treat `null` as
 * "not analysed yet" and degrade gracefully instead of crashing. Mirrors
 * `safeParseBrfData` (brf.ts:165-169).
 */
export function safeParsePriceData(input: unknown): PriceData | null {
  if (!input || typeof input !== "object") return null;
  const parsed = priceDataSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
