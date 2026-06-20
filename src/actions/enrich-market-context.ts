"use server";

import { createClient } from "@/lib/supabase/server";
import { resolveGeo, type ResolvedGeo } from "@/lib/market/geo";
import {
  fetchSoldComps,
  type PriceTier,
  type SoldSourceQuery,
} from "@/lib/market/sold-source";
import {
  normalizeSoldOutput,
  type PriceData,
  type SoldComp,
} from "@/lib/market/sold-schema";
import {
  computePriceComparison,
  PRICE_COMPARISON_THRESHOLDS,
} from "@/lib/market/compare";
import { soldSourceCostSek, SOLD_SOURCE_COST_CAP_SEK } from "@/lib/market/cost";
import { fetchScbDemographics, type AreaData } from "@/lib/market/scb";
import { listingDataSchema, type ListingData } from "@/lib/schemas/listing";

/**
 * enrich-market-context.ts — the Phase 3 server-action spine (PRICE-01 + AREA-01).
 *
 * Mirrors the analyze-brf.ts spine EXACTLY (auth gate → ownership → external →
 * cost gate → independent persist → observable terminal status). The defining
 * Phase 3 property (Success Criterion 3, D-08) is INDEPENDENT degradation: each
 * panel (price_data / area_data) persists on its own, so a dead/thin sold source
 * never blanks the area panel and a geocoding miss / SCB gap never blanks the
 * price panel.
 *
 * Honest-state ownership (HIGH-1 / HIGH-3): this action OWNS the distinction
 * between a dead source and a thin area.
 *  - sold-source fetch/parse FAILURE (fetchSoldComps throws — it never silently
 *    returns []) → price_data with reason "source_unavailable".
 *  - a REAL area returning few comps → compare.ts already tags reason "thin".
 *  - the listing's own prisPerKvm is 0/falsy → reason "listing_pris_okand"
 *    (no ±%, never a false −100 %). We pre-guard this so we don't even spend a
 *    fetch-walk when no headline can be computed.
 * These three never collapse into one.
 *
 * Trust model (D-08/D-09): the comparison + demographics are deterministic
 * (compare.ts / scb-schema.ts) — NEVER an LLM. Source + freshness labels (D-09)
 * are persisted for the trust display.
 *
 * GDPR/logging discipline (T-03-18, mirrors analyze-brf.ts): log only the
 * analysisId + error codes — NEVER the coords/financials/comp payloads.
 */

/** The D-09 source label for the sold-price panel (03-SPIKE.md — Booli SSR). */
const SOLD_SOURCE_NAME = "Booli";
const SOLD_SOURCE_LABEL = "sålda bostäder";

/**
 * The D-01 tier ladder, narrow→wide. We walk it stopping at the FIRST tier whose
 * usable comps are both ENOUGH (count) and RECENT ENOUGH (freshness) — the SPIKE
 * showed thinness manifests as stale comps, not empty results (03-SPIKE.md §1.4:
 * "Trigger the D-01 walk-up on recency + count, NOT on totalCount alone").
 */
const TIER_LADDER: readonly PriceTier[] = [
  "building",
  "neighborhood",
  "wide",
] as const;

/**
 * MEDIUM cost concern (T-03-17): bound the fetch-walk at ≤3 source calls per
 * analysis (one render per tier) so a single enrich can never bill an unbounded
 * multi-call walk. The ladder has exactly 3 tiers; this is the explicit ceiling.
 */
const MAX_SOURCE_CALLS = 3;

/**
 * Recency window for the walk-up trigger (03-SPIKE.md §1.4): comps older than
 * ~12 months are "stale". A tier is "sufficient" only when it has more than the
 * thin threshold of RECENT usable comps; otherwise we walk up to a broader tier
 * (which the spike showed is denser + fresher).
 */
const RECENCY_WINDOW_DAYS = 365;

/** Discriminated result returned to the client (mirrors AnalyzeBrfResult). */
export type EnrichMarketResult =
  | { ok: true; data: { price: PriceData | null; area: AreaData | null } }
  | { ok: false; error: string };

/** A minimal slice of the Supabase client this module needs (status writes). */
type StatusWriter = Awaited<ReturnType<typeof createClient>>;

/**
 * Writes the terminal `failed` status observably (mirrors analyze-brf.ts
 * writeFailedStatus). market_status null is reserved for "never enriched" (the
 * fetch affordance); this action never leaves it null after running, so a
 * page poller always reaches a terminal state. Never logs payloads (GDPR).
 */
async function writeFailedStatus(
  supabase: StatusWriter,
  analysisId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await supabase
    .from("analyses")
    .update({ market_status: "failed", ...extra })
    .eq("id", analysisId);
  if (error) {
    console.error("[enrich-market] terminal failed-status write did not land", {
      analysisId,
      code: error.code,
      message: error.message,
    });
  }
}

/**
 * Count of usable comps sold within the recency window (03-SPIKE.md §1.4 —
 * thinness is staleness, so the walk-up trigger weighs recency, not just count).
 * A comp with no parseable soldDate does not count toward recency. Pure: parsing
 * a stored ISO date is fine (it is not a "now" read of the comp).
 */
function recentUsableCount(comps: SoldComp[], nowMs: number): number {
  const windowMs = RECENCY_WINDOW_DAYS * 86_400_000;
  return comps.filter((c) => {
    if (
      typeof c.prisPerKvm !== "number" ||
      !Number.isFinite(c.prisPerKvm) ||
      c.prisPerKvm <= 0
    ) {
      return false;
    }
    if (!c.soldDate) return false;
    const t = Date.parse(c.soldDate);
    if (!Number.isFinite(t)) return false;
    return nowMs - t <= windowMs;
  }).length;
}

/**
 * The result of the bounded tiered fetch-walk: the chosen tier's normalized
 * comps, the tier label, and the number of source calls actually spent (for the
 * cost gate — each call is one render).
 */
interface SoldWalkResult {
  comps: SoldComp[];
  tier: PriceTier;
  renders: number;
}

/**
 * Walks the D-01 tier ladder (building → neighborhood → wide), STOPPING at the
 * first tier whose RECENT usable comps clear the thin threshold (recency + count,
 * 03-SPIKE.md §1.4). Bounded at MAX_SOURCE_CALLS renders (T-03-17): one render
 * per tier, short-circuit on the first sufficient tier. If no tier is sufficient
 * the last (widest) attempt's comps are returned so compare.ts can still tag them
 * "thin" honestly — that is a REAL sparse area, NOT a dead source.
 *
 * Throws (propagating the fetchSoldComps HIGH-1 throw) only when EVERY attempted
 * tier failed to fetch — the caller maps that to reason "source_unavailable".
 */
async function walkSoldTiers(
  base: Omit<SoldSourceQuery, "tier">,
  nowMs: number,
): Promise<SoldWalkResult> {
  const thin = PRICE_COMPARISON_THRESHOLDS.thinMaxComps;
  let renders = 0;
  let last: { comps: SoldComp[]; tier: PriceTier } | null = null;
  let lastError: unknown = null;

  for (const tier of TIER_LADDER) {
    if (renders >= MAX_SOURCE_CALLS) break;
    renders += 1;
    try {
      const raw = await fetchSoldComps({ ...base, tier });
      const comps = normalizeSoldOutput(raw);
      last = { comps, tier };
      // Sufficient = enough RECENT usable comps (recency + count). Short-circuit.
      if (recentUsableCount(comps, nowMs) > thin) {
        return { comps, tier, renders };
      }
    } catch (error) {
      // This tier's source call failed — try the next (broader) tier within the
      // call budget. Keep the error so we can rethrow if NO tier ever succeeds.
      lastError = error;
    }
  }

  // No tier was "sufficient". If at least one tier fetched, return its comps so
  // compare.ts can tag a REAL sparse area as "thin" (NOT source_unavailable).
  if (last) {
    return { comps: last.comps, tier: last.tier, renders };
  }
  // Every attempted tier failed to fetch → a genuine source failure (HIGH-1).
  throw lastError instanceof Error
    ? lastError
    : new Error("Sold source unavailable across all tiers");
}

/** A source_unavailable PriceData — the dead-source honest state (HIGH-1). */
function sourceUnavailablePrice(): PriceData {
  return {
    reason: "source_unavailable",
    areaAvg: null,
    deltaPct: null,
    min: null,
    max: null,
    trendSlope: null,
    sampleSize: 0,
    tier: null,
    confidence: 0,
    comps: [],
    source: SOLD_SOURCE_NAME,
    sourceLabel: SOLD_SOURCE_LABEL,
    recency: null,
  };
}

/** A listing_pris_okand PriceData — the listing's own pris/kvm is 0/unknown (HIGH-3). */
function listingPrisOkandPrice(): PriceData {
  return {
    reason: "listing_pris_okand",
    areaAvg: null,
    deltaPct: null,
    min: null,
    max: null,
    trendSlope: null,
    sampleSize: 0,
    tier: null,
    confidence: 0,
    comps: [],
    source: SOLD_SOURCE_NAME,
    sourceLabel: SOLD_SOURCE_LABEL,
    recency: null,
  };
}

/**
 * Newest soldDate across the comps as the D-09 recency label (ISO date), or null.
 * Pure: reading the max of stored dates, not a "now" comparison.
 */
function recencyOf(comps: SoldComp[]): string | null {
  let newest: number | null = null;
  for (const c of comps) {
    if (!c.soldDate) continue;
    const t = Date.parse(c.soldDate);
    if (!Number.isFinite(t)) continue;
    if (newest === null || t > newest) newest = t;
  }
  return newest === null ? null : new Date(newest).toISOString().slice(0, 10);
}

/**
 * Determines whether an AreaData carries usable demographics (any of the four
 * metrics present). A kommun-baseline degrade (all metrics null) is still a
 * persisted row but is NOT "usable data" for the terminal-status decision.
 */
function areaHasUsableData(area: AreaData | null): boolean {
  if (!area) return false;
  const m = area.metrics;
  return (
    m.population != null || m.age != null || m.income != null || m.tenure != null
  );
}

/**
 * `enrichMarketContext` — the Phase 3 controller. Auth → ownership → resolve geo
 * → fetch BOTH sources → deterministic compute → persist price_data + area_data
 * INDEPENDENTLY with market_status / market_source / market_cost_sek.
 *
 * Owner-only (Plan 06 HIGH-2): the detail page only renders for a persisted owner
 * row, so there is no anonymous caller — we match the analyze-brf.ts auth posture.
 *
 * @param analysisId - the analyses row to enrich (must belong to the caller)
 */
export async function enrichMarketContext(
  analysisId: string,
): Promise<EnrichMarketResult> {
  if (typeof analysisId !== "string" || !analysisId) {
    return { ok: false, error: "Analys-id saknas." };
  }

  // Auth gate (D-05 HARD — owner-only, mirrors analyze-brf.ts:175-181).
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "Logga in för marknadsdata." };
  }

  // Ownership check (second layer behind RLS — T-03-15/T-03-16, analyze-brf.ts:185-193).
  const { data: row, error: rowError } = await supabase
    .from("analyses")
    .select("id, user_id, listing_data, price_data, area_data")
    .eq("id", analysisId)
    .single();

  if (rowError || !row || row.user_id !== user.id) {
    return { ok: false, error: "Analysen hittades inte." };
  }

  // Status → fetching (mirrors the brf_status write 227-230). The page polls this.
  await supabase
    .from("analyses")
    .update({ market_status: "fetching" })
    .eq("id", analysisId);

  // Read the Plan-01-extended listing off the row (null-tolerant — an old/partial
  // row may not parse; we degrade rather than crash).
  const parsedListing = listingDataSchema.safeParse(row.listing_data);
  const listing: ListingData | null = parsedListing.success
    ? parsedListing.data
    : null;

  const lat = listing?.latitude ?? null;
  const lng = listing?.longitude ?? null;
  const hasCoords =
    typeof lat === "number" &&
    Number.isFinite(lat) &&
    typeof lng === "number" &&
    Number.isFinite(lng);

  // ---- Geo (shared input to the AREA branch; coords also gate the PRICE walk) ----
  // No coords (older analysis) → degrade to a kommun-baseline geo with no DeSO,
  // never backfill, never crash (RESEARCH Open Q3, D-06/D-08).
  const geo: ResolvedGeo = hasCoords
    ? resolveGeo(lat as number, lng as number)
    : { kommunCode: null, desoCode: null };

  // ====================================================================
  // PRICE branch (independent — its failure never touches the AREA branch)
  // ====================================================================
  let price: PriceData | null = null;
  let renders = 0;

  const listingPrisPerKvm = listing?.prisPerKvm ?? null;

  if (
    listingPrisPerKvm == null ||
    !Number.isFinite(listingPrisPerKvm) ||
    listingPrisPerKvm <= 0
  ) {
    // HIGH-3 pre-guard: no real ±% is computable from a 0/unknown listing pris/kvm.
    // Do NOT spend a fetch-walk — persist the honest listing_pris_okand reason.
    price = listingPrisOkandPrice();
  } else if (!hasCoords) {
    // No coords → no areaId ladder to query the sold source → the source is
    // structurally unreachable for this row. Honest source_unavailable (the
    // panel says "ej tillgänglig"); the AREA branch still degrades on its own.
    price = sourceUnavailablePrice();
  } else {
    try {
      const walk = await walkSoldTiers(
        {
          lat: lat as number,
          lng: lng as number,
          booliId: listing?.booliId ?? null,
          breadcrumbs: listing?.breadcrumbs ?? null,
        },
        Date.now(),
      );
      renders = walk.renders;

      const comparison = computePriceComparison({
        listingPrisPerKvm,
        comps: walk.comps,
        tier: walk.tier,
      });

      price = {
        reason: comparison.reason, // "ok" | "thin" | "listing_pris_okand"
        areaAvg: comparison.areaAvg,
        deltaPct: comparison.deltaPct,
        min: comparison.min,
        max: comparison.max,
        trendSlope: comparison.trendSlope,
        sampleSize: comparison.sampleSize,
        tier: comparison.tier,
        confidence: comparison.confidence,
        comps: walk.comps,
        source: SOLD_SOURCE_NAME,
        sourceLabel: SOLD_SOURCE_LABEL,
        recency: recencyOf(walk.comps),
      };
    } catch (error) {
      // HIGH-1: a fetch/normalize FAILURE (every tier unreachable/unparseable) is
      // a DEAD SOURCE — distinct from a real thin area. Log the error only (no
      // PII/payloads), set reason "source_unavailable". The AREA branch still runs.
      console.error("[enrich-market] price", {
        analysisId,
        code: error instanceof Error ? error.message : "UNKNOWN",
      });
      price = sourceUnavailablePrice();
    }
  }

  // Cost gate BEFORE persistence (mirrors analyze-brf.ts:250-256). The spend is
  // already bounded by MAX_SOURCE_CALLS; this refuses to PERSIST an over-cap
  // result. Renders is 0 on the pre-guard / no-coords / no-fetch paths → 0 cost.
  const cost = soldSourceCostSek({ renders });
  if (cost > SOLD_SOURCE_COST_CAP_SEK) {
    await writeFailedStatus(supabase, analysisId, { market_cost_sek: cost });
    return {
      ok: false,
      error: "Marknadsdata avbröts (kostnadstaket nåddes). Försök igen senare.",
    };
  }

  // ====================================================================
  // AREA branch (independent — its failure never touches the PRICE branch)
  // ====================================================================
  let area: AreaData | null = null;
  try {
    area = await fetchScbDemographics(geo);
  } catch (error) {
    // SCB failure → area null WITHOUT aborting the price branch (D-08). Log only.
    console.error("[enrich-market] area", {
      analysisId,
      code: error instanceof Error ? error.message : "UNKNOWN",
    });
    area = null;
  }

  // ---- Terminal status (D-08): "done" on ANY partial success ----
  // Usable price = anything except source_unavailable (ok/thin/listing_pris_okand
  // are all honest, displayable states). Usable area = at least one metric present
  // (a kommun-baseline-only row with all metrics null is persisted but not "usable"
  // for the status decision; the price side may still carry the row to "done").
  const priceUsable = price != null && price.reason !== "source_unavailable";
  const areaUsable = areaHasUsableData(area);
  const terminalStatus: "done" | "failed" =
    priceUsable || areaUsable ? "done" : "failed";

  // ---- Persist BOTH columns in one write (D-08 independent persistence) ----
  // Each of price_data / area_data is written even when the OTHER is null /
  // source_unavailable — one source failing never blanks the other.
  const { error: persistError } = await supabase
    .from("analyses")
    .update({
      price_data: price,
      area_data: area,
      market_status: terminalStatus,
      market_source: SOLD_SOURCE_NAME,
      market_cost_sek: cost,
    })
    .eq("id", analysisId);

  if (persistError) {
    console.error("[enrich-market] persist failed", {
      analysisId,
      code: persistError.code,
    });
    return { ok: false, error: "Kunde inte spara marknadsdata. Försök igen." };
  }

  return { ok: true, data: { price, area } };
}
