/**
 * area-comps.ts — PURE comp-set aggregation for the discovery value-gap (SPEC
 * §2.2/§2.6, synthesis §5/§7). Turns a set of area sold-comps (from
 * `fetchSoldComps` → `normalizeSoldOutput`) into the renovated- vs
 * unrenovated-median kr/m² that `valueGap()` consumes.
 *
 * Booli does NOT tag condition, so renovated-vs-unrenovated is INFERRED from
 * the kr/m² distribution: within a tight comp segment ({same rooms, ±15% m²,
 * ≤12mo}), the TOP tercile of kr/m² proxies "renovated" and the BOTTOM tercile
 * proxies "unrenovated" (synthesis §7 open-item resolution). This is a
 * deliberate proxy, not ground truth — the caller must surface it hedged and
 * downgrade confidence on thin samples.
 *
 * STRUCTURAL SEPARATION: on the vision/analysis read path; like
 * `flip-economics.ts` it must never be imported by `niche-score.ts` /
 * `flags.ts` (enforced by the niche-score.test.ts static-grep invariant).
 * Pure — no I/O, no model calls.
 */

import type { SoldComp } from "@/lib/market/sold-schema";

/** Minimum comps in the segment for a confident read (§5: ≥5 in 12mo). */
export const MIN_COMPS_FOR_CONFIDENCE = 5;
/** Default ±m² band for "comparable size". */
export const DEFAULT_SIZE_BAND_PCT = 0.15;
/** Default recency window in months. */
export const DEFAULT_MAX_AGE_MONTHS = 12;

export interface AreaCompsFilter {
  /** Target room count (exact match when both sides present). */
  readonly rooms: number | null;
  /** Target living area (m²) — comps within ±`sizeBandPct` are kept. */
  readonly livingArea: number | null;
  /** ISO "YYYY-MM-DD" reference date; comps older than `maxAgeMonths` are dropped. */
  readonly asOf: string;
  /** ±m² band (default 0.15). */
  readonly sizeBandPct?: number;
  /** Recency window in months (default 12). */
  readonly maxAgeMonths?: number;
  /** Restrict to this objectType (e.g. "Lägenhet") when comps expose it. */
  readonly objectType?: string | null;
}

export interface AreaComps {
  /** Renovated-comp median kr/m² (top-tercile proxy), null on thin sample. */
  readonly renovatedMedianPerSqm: number | null;
  /** Unrenovated-comp median kr/m² (bottom-tercile proxy), null on thin sample. */
  readonly unrenovatedMedianPerSqm: number | null;
  /** Median kr/m² over the whole filtered segment. */
  readonly overallMedianPerSqm: number | null;
  /** 75th-percentile kr/m² — the Resale_W cap (§2.6). */
  readonly renovatedCapPerSqm: number | null;
  /** Number of comps that passed the segment filter. */
  readonly sampleSize: number;
  /** Whether the sample meets `MIN_COMPS_FOR_CONFIDENCE`. */
  readonly confident: boolean;
}

const EMPTY: AreaComps = {
  renovatedMedianPerSqm: null,
  unrenovatedMedianPerSqm: null,
  overallMedianPerSqm: null,
  renovatedCapPerSqm: null,
  sampleSize: 0,
  confident: false,
};

function median(sortedAsc: number[]): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedAsc[mid - 1] + sortedAsc[mid]) / 2 : sortedAsc[mid];
}

/** Linear-interpolated percentile (0..1) over an ascending array. */
function percentile(sortedAsc: number[], p: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  if (n === 1) return sortedAsc[0];
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

/** Months between two ISO dates (approximate, calendar-month based). */
function monthsBetween(fromIso: string, toIso: string): number | null {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return (
    (to.getFullYear() - from.getFullYear()) * 12 +
    (to.getMonth() - from.getMonth()) +
    (to.getDate() >= from.getDate() ? 0 : -1)
  );
}

/**
 * Filters `comps` to the candidate's segment and derives the renovated/
 * unrenovated median kr/m² via the tercile proxy. Returns an all-null
 * `AreaComps` (sampleSize 0, not confident) when nothing passes the filter —
 * a thin/absent segment is honestly represented, never fabricated.
 */
export function computeAreaComps(comps: SoldComp[], filter: AreaCompsFilter): AreaComps {
  const sizeBand = filter.sizeBandPct ?? DEFAULT_SIZE_BAND_PCT;
  const maxAge = filter.maxAgeMonths ?? DEFAULT_MAX_AGE_MONTHS;

  const kept = comps.filter((c) => {
    if (c.prisPerKvm === null || !Number.isFinite(c.prisPerKvm) || c.prisPerKvm <= 0) return false;
    // Size band (only when both sides known).
    if (filter.livingArea !== null && c.livingArea != null) {
      const lo = filter.livingArea * (1 - sizeBand);
      const hi = filter.livingArea * (1 + sizeBand);
      if (c.livingArea < lo || c.livingArea > hi) return false;
    }
    // Exact room match (only when both sides known).
    if (filter.rooms !== null && c.rooms != null && c.rooms !== filter.rooms) return false;
    // objectType (only when both sides known).
    if (filter.objectType && c.objectType && c.objectType !== filter.objectType) return false;
    // Recency (only when the comp has a date).
    if (c.soldDate) {
      const age = monthsBetween(c.soldDate, filter.asOf);
      if (age !== null && age > maxAge) return false;
    }
    return true;
  });

  const perSqm = kept.map((c) => c.prisPerKvm as number).sort((a, b) => a - b);
  const sampleSize = perSqm.length;
  if (sampleSize === 0) return EMPTY;

  // Tercile split. With a tiny sample the terciles overlap; that's fine — the
  // `confident` flag tells the caller the read is weak. The bottom third is the
  // first ceil(n/3); the top third is the last ceil(n/3).
  const third = Math.max(1, Math.ceil(sampleSize / 3));
  const bottom = perSqm.slice(0, third);
  const top = perSqm.slice(sampleSize - third);

  return {
    renovatedMedianPerSqm: median(top),
    unrenovatedMedianPerSqm: median(bottom),
    overallMedianPerSqm: median(perSqm),
    renovatedCapPerSqm: percentile(perSqm, 0.75),
    sampleSize,
    confident: sampleSize >= MIN_COMPS_FOR_CONFIDENCE,
  };
}
