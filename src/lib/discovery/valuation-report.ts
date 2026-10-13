/**
 * valuation-report.ts - the run-record contract that freezes a fit ranking so the
 * before/after valuation report (Phase 14.4, VAL-05) has a real "before".
 *
 * Why it exists (R-05): once the 20 % credit cap is deleted and the hedonic model
 * is refitted, today's numbers cannot be recomputed without checking out an old
 * commit. The replay therefore writes one record per run (`--json <fil>`): every
 * ranked row with its uncapped gap, its credited gap, its profit and its flag
 * strings, plus the model and snapshot the numbers came from, so a later report
 * can refuse a "before" that was not taken with the version-1 model.
 *
 * PURE: no file-system import, no clock, no network, no console. The script does the
 * writing; this file only defines the shape, builds it from a ranking and parses it
 * back from untrusted JSON.
 *
 * Flags are PLAIN STRINGS here, not the `FitFlag` union. A later plan deletes the
 * `creditCapped` flag from that union; a frozen record that still carries it must
 * keep parsing. Row objects are loose for the same reason: later plans add fields
 * (expected final price against the model, residual, overbid source) without a
 * version bump.
 *
 * STRUCTURAL SEPARATION (D-16): `niche-score.ts` and `report/flags.ts` must NEVER
 * import this file. The static-grep invariant in `niche-score.test.ts` registers the
 * prefix `discovery/valuation-` for that.
 */

import { z } from "zod/v4";
import type { FitScoreResult } from "@/lib/discovery/fit-score";
import type { HedonicModel } from "@/lib/discovery/hedonic-model";

/** Bumped only when a field the report reads changes meaning or is removed. */
export const FIT_RUN_RECORD_VERSION = 1;

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const numOrNull = z.number().nullable();

/** One ranked or not-comparable row, money unrounded. Unknown extra keys are kept. */
const fitRunRowSchema = z.looseObject({
  /** 1-based position among the ranked rows; null for a row that is not comparable. */
  rank: z.number().int().min(1).nullable(),
  /** The pre-rank key: the listing URL, else `address|asking price`. */
  key: z.string(),
  booliId: numOrNull,
  address: z.string().nullable(),
  district: z.string(),
  livingArea: numOrNull,
  askingSek: numOrNull,
  predKrPerSqm: numOrNull,
  askToPred: numOrNull,
  resaleSek: numOrNull,
  purchaseSek: numOrNull,
  overbidPct: numOrNull,
  /** Resale minus expected final price, before any cap. */
  gapSek: numOrNull,
  /** The part of the gap the profit took credit for. */
  creditSek: numOrNull,
  profitSek: numOrNull,
  renoSek: z.number(),
  tasteSek: z.number(),
  taxSek: z.number(),
  renoTier: z.string(),
  /** Plain strings: a flag a later plan deletes from the FitFlag union must still parse. */
  flags: z.array(z.string()),
  featuresImputed: z.array(z.string()),
  notComparableReason: z.string().nullable(),
});

export type FitRunRow = z.infer<typeof fitRunRowSchema>;

export const fitRunRecordSchema = z.object({
  version: z.literal(FIT_RUN_RECORD_VERSION),
  kind: z.literal("fit-replay"),
  /** The snapshot's own date (YYYY-MM-DD). */
  snapshotAsOf: dateString,
  /** Repo-relative path of the snapshot file the replay read. */
  snapshotFile: z.string(),
  /** Which model produced the numbers. */
  model: z.object({
    version: z.number(),
    asOf: dateString,
    n: z.number(),
    r2: z.number(),
    cvRmseLog: z.number(),
    residualSdLog: z.number(),
    bidPremiumKind: z.string(),
  }),
  /** The first "Sol:" line of the run, i.e. which sun source the numbers used. */
  sunLine: z.string(),
  ranked: z.array(fitRunRowSchema),
  notComparable: z.array(fitRunRowSchema),
});

export type FitRunRecord = z.infer<typeof fitRunRecordSchema>;

/** The same key rule the pre-rank map uses (`fitRowKey` in fit-pipeline), kept inline so this file stays pure. */
function rowKeyOf(r: FitScoreResult): string {
  return r.sourceListingUrl ?? `${r.address}|${r.askingSek}`;
}

function rowOf(r: FitScoreResult, rank: number | null): FitRunRow {
  return {
    rank,
    key: rowKeyOf(r),
    booliId: r.booliId,
    address: r.address,
    district: r.district,
    livingArea: r.livingArea,
    askingSek: r.askingSek,
    predKrPerSqm: r.predKrPerSqm,
    askToPred: r.askToPred,
    resaleSek: r.resaleSek,
    purchaseSek: r.purchaseSek,
    overbidPct: r.overbidPct,
    gapSek: r.gapSek,
    creditSek: r.creditSek,
    profitSek: r.profitSek,
    renoSek: r.renoSek,
    tasteSek: r.tasteSek,
    taxSek: r.taxSek,
    renoTier: r.renoTier,
    flags: [...r.flags],
    featuresImputed: [...r.featuresImputed],
    notComparableReason: r.notComparableReason,
  };
}

/** Builds the record for one replay. Money is passed through unrounded. */
export function fitRunRecordOf(input: {
  readonly snapshotAsOf: string;
  readonly snapshotFile: string;
  readonly model: HedonicModel;
  readonly sunLine: string;
  readonly ranking: {
    readonly ranked: readonly FitScoreResult[];
    readonly notComparable: readonly FitScoreResult[];
  };
}): FitRunRecord {
  const { model } = input;
  return {
    version: FIT_RUN_RECORD_VERSION,
    kind: "fit-replay",
    snapshotAsOf: input.snapshotAsOf,
    snapshotFile: input.snapshotFile,
    model: {
      version: model.version,
      asOf: model.asOf,
      n: model.n,
      r2: model.r2,
      cvRmseLog: model.cvRmseLog,
      residualSdLog: model.residualSdLog,
      bidPremiumKind: model.bidPremium.kind,
    },
    sunLine: input.sunLine,
    ranked: input.ranking.ranked.map((r, i) => rowOf(r, i + 1)),
    notComparable: input.ranking.notComparable.map((r) => rowOf(r, null)),
  };
}

/** Parses an untrusted run record, or throws one readable Error. */
export function parseFitRunRecord(json: unknown): FitRunRecord {
  const result = fitRunRecordSchema.safeParse(json);
  if (result.success) return result.data;
  const issues = result.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
  throw new Error(`Invalid fit run record: ${issues}`);
}
