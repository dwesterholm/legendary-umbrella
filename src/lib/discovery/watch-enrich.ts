/**
 * watch-enrich.ts - headless enrichment of EVERY candidate in the weekly run
 * (Phase 14.2, WATCH-02, D-06, D-02): the Booli detail page, the broker page
 * where the detail names one, the broker photos as bytes, and the CandidateFacts
 * record, all in memory.
 *
 * WHY A NEW MODULE (D-02, LOCKED): `enrichCandidateImages` in `job.ts` is the
 * in-app path. It is bounded by the 300 s Server Action ceiling, picks at most
 * VISION_ENRICH_LIMIT (8) candidates and skips the ones that already have
 * images. The headless weekly run reads ALL ~75-100 candidates through the free
 * local browser, so it needs its own loop, and `job.ts` stays byte-identical.
 * This module reuses the same building blocks (`fetchListing`,
 * `fetchBrokerListingPage`, `fetchBrokerImageBytes`, `toCandidate`, the sun and
 * orientation extractors) and the same merge rules.
 *
 * It is loaded only by `scripts/fit-score.ts` (dynamic import in the live
 * branch). The app tree never imports it, and `niche-score.ts` / `flags.ts` must
 * not either (the "discovery/watch-" specifier is registered in
 * `niche-score.test.ts`).
 *
 * CONTRACT (kept from `enrichCandidateImages`):
 *  - the input order is kept; `out[i]` is REPLACED only after a successful detail
 *    fetch, so "was the detail fetched" is `out[i] !== input[i]` (identity);
 *  - card values win over detail values (floor, constructionYear, orientation),
 *    except a detail balcony `true`, which beats a card `false` (R-04b: a card's
 *    `false` means "not listed on the card", not "no balcony");
 *  - it never throws. A failed detail leaves the card candidate and the card
 *    facts in place; a failed broker leg only costs the broker text and photos.
 *
 * PII RULE (T-14.2-09): the broker or Booli description is read in memory to
 * derive booleans, canonical phrase names and facades, and then dropped. Nothing
 * of it reaches the facts record, a log line or a snapshot.
 */

import {
  DETAIL_ENRICH_MAX_RETRIES,
  DETAIL_ENRICH_WAIT_SECS,
  fetchListing,
} from "@/lib/booli/client";
import { runPool } from "@/lib/booli/slutpriser";
import { fetchBrfFacts, type BrfFacts } from "@/lib/booli/brf-page";
import { fetchBrokerImageBytes, type BrokerImageBytes } from "@/lib/broker/broker-images";
import { fetchBrokerListingPage } from "@/lib/broker/fetch-broker-page";
import { toCandidate, type DiscoveryCandidate } from "@/lib/discovery/candidate";
import {
  candidateFactsSchema,
  factsFromDetail,
  landLeaseFromText,
  type CandidateFacts,
} from "@/lib/discovery/listing-facts";
import {
  extractOrientationFromDescription,
  extractSunPhrases,
  statedSunPhrases,
  type SunPhrases,
} from "@/lib/discovery/sun-path";

/**
 * The broker-leg bounds, redeclared from `job.ts` (where they are module-private
 * and WR-02 explains them): the direct GET is cut at 15 s, each photo at 10 s,
 * and the headless escalation at 45 s with one retry. In the local run the
 * headless leg is the local browser, which since 14.2-06 opens broker pages for
 * the broker page function (one attempt, no Apify); before that it refused every
 * non-Booli host and a client-rendered broker page gave no text. Keep in step
 * with `job.ts` if it ever changes.
 */
const BROKER_DIRECT_TIMEOUT_MS = 15_000;
const BROKER_IMAGE_TIMEOUT_MS = 10_000;
const BROKER_RENDER_WAIT_SECS = 45;
const BROKER_RENDER_MAX_RETRIES = 1;

/** Broker photos fetched as bytes per candidate (same as `job.ts`). */
const BROKER_IMAGES_PER_CANDIDATE = 4;

/** The four network edges, injectable so tests need no module mocks. */
export interface WatchEnrichDeps {
  fetchListing(
    url: string,
    opts?: { waitSecs?: number; maxRequestRetries?: number },
  ): Promise<Record<string, unknown>>;
  fetchBrokerListingPage: typeof fetchBrokerListingPage;
  fetchBrokerImageBytes: typeof fetchBrokerImageBytes;
  /** The public Booli page of one association (R-07); rejects when the page cannot be rendered. */
  fetchBrfFacts(id: string): Promise<BrfFacts>;
}

const REAL_DEPS: WatchEnrichDeps = {
  fetchListing,
  fetchBrokerListingPage,
  fetchBrokerImageBytes,
  fetchBrfFacts: (id) => fetchBrfFacts(id),
};

/** What the BRF stage did: distinct associations found, pages read, pages that failed or were not reached (deadline). */
export interface BrfStats {
  readonly distinct: number;
  readonly fetched: number;
  readonly failed: number;
}

export interface WatchEnrichment {
  /** Same length and order as the input; a successfully read entry is a new object. */
  candidates: DiscoveryCandidate[];
  /** candidate index -> up to 4 broker photos as bytes (analyze-only, never persisted). */
  brokerImages: Map<number, BrokerImageBytes[]>;
  /** candidate index -> the two sun booleans, set only when a description existed. */
  sunPhrases: Map<number, SunPhrases>;
  /** candidate index -> the detail-side facts (set only for a successful detail fetch). */
  facts: Map<number, CandidateFacts>;
  /** The BRF page stage (R-07). `facts` entries of a read association carry `brf`. */
  brfStats: BrfStats;
}

export interface WatchEnrichOptions {
  /** Wall-clock budget for the whole stage; checked as each candidate starts. */
  deadlineMs: number;
  /** Candidates read at the same time. */
  concurrency: number;
  /** "YYYY-MM-DD", the run date (listing age is counted to it). */
  asOf: string;
  /** Injectable clock, so tests drive the deadline without waiting. */
  now?: () => number;
  /** Injectable network edges; defaults to the real ones. */
  deps?: WatchEnrichDeps;
  /** Fetch broker photos as bytes (default true). A run that reads no pictures passes false. */
  fetchBrokerImages?: boolean;
}

const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * Reads up to `limit` candidates that carry a listing URL, in input order, with
 * at most `opts.concurrency` in flight. See the module comment for the contract.
 */
export async function enrichAllCandidates(
  candidates: DiscoveryCandidate[],
  limit: number,
  opts: WatchEnrichOptions,
): Promise<WatchEnrichment> {
  const d = opts.deps ?? REAL_DEPS;
  const now = opts.now ?? (() => Date.now());
  const concurrency = Math.max(1, Math.floor(opts.concurrency));
  const withImages = opts.fetchBrokerImages !== false;
  const out = [...candidates];
  const brokerImages = new Map<number, BrokerImageBytes[]>();
  const sunPhrases = new Map<number, SunPhrases>();
  const facts = new Map<number, CandidateFacts>();
  const startedAt = now();
  let skipped = 0;

  const eligible: number[] = [];
  candidates.forEach((c, i) => {
    if (c.sourceListingUrl) eligible.push(i);
  });
  const todo = eligible.slice(0, Math.max(0, Math.floor(limit)));

  /** One candidate. Never throws; writes its results in one synchronous block at the end. */
  const readOne = async (i: number): Promise<void> => {
    if (now() - startedAt >= opts.deadlineMs) {
      skipped += 1;
      return;
    }
    const c = candidates[i];
    try {
      const raw = await d.fetchListing(c.sourceListingUrl as string, {
        waitSecs: DETAIL_ENRICH_WAIT_SECS,
        maxRequestRetries: DETAIL_ENRICH_MAX_RETRIES,
      });
      const detail = toCandidate(raw);
      // Merge rules as in job.ts enrichCandidateImages (lines 700-711): card value first,
      // detail fills a null; a detail balcony true beats a card false (R-04b).
      let merged: DiscoveryCandidate = {
        ...c,
        imageUrls: detail.imageUrls,
        floor: c.floor ?? detail.floor,
        constructionYear: c.constructionYear ?? detail.constructionYear,
        orientation: c.orientation ?? detail.orientation,
        balcony: detail.balcony === true ? true : (c.balcony ?? detail.balcony),
      };

      // Description for sun, orientation and land lease: broker text first, the Booli
      // detail text as fallback (job.ts lines 715-732). Held in memory only.
      let text: string | null = nonEmpty(raw.description);
      let photos: BrokerImageBytes[] = [];
      const brokerUrl = nonEmpty(raw.agencyListingUrl);
      if (brokerUrl) {
        try {
          const broker = await d.fetchBrokerListingPage(brokerUrl, {
            directTimeoutMs: BROKER_DIRECT_TIMEOUT_MS,
            render: { waitSecs: BROKER_RENDER_WAIT_SECS, maxRequestRetries: BROKER_RENDER_MAX_RETRIES },
          });
          if (broker) {
            if (broker.description) text = broker.description;
            if (!merged.orientation && broker.description) {
              const derived = extractOrientationFromDescription(broker.description);
              if (derived) merged = { ...merged, orientation: derived };
            }
            if (withImages && broker.images.length > 0) {
              photos = await d.fetchBrokerImageBytes(broker.images, BROKER_IMAGES_PER_CANDIDATE, {
                timeoutMs: BROKER_IMAGE_TIMEOUT_MS,
              });
            }
          }
        } catch {
          // The broker leg is a bonus: it never affects the detail result.
        }
      }

      const facades = merged.orientation?.facades ?? [];
      const detailFacts = candidateFactsSchema.parse({
        ...factsFromDetail(raw, { asOf: opts.asOf }),
        orientationFacades: facades.length > 0 ? facades : null,
        sunPhrases: statedSunPhrases(text),
        landLease: landLeaseFromText(text),
        descriptionRead: text !== null,
      });
      const phrases = extractSunPhrases(text);
      text = null; // the description is dropped here (PII rule)

      out[i] = merged;
      facts.set(i, detailFacts);
      if (phrases) sunPhrases.set(i, phrases);
      if (photos.length > 0) brokerImages.set(i, photos);
    } catch (error) {
      console.error("[watch-enrich] detail failed (non-fatal)", {
        code: error instanceof Error ? error.name : "UNKNOWN",
      });
    }
  };

  await runPool(
    todo.map((i) => () => readOne(i)),
    concurrency,
  );

  if (skipped > 0) {
    console.error("[watch-enrich] deadline reached, remainder not read", {
      skipped,
      deadlineMs: opts.deadlineMs,
    });
  }

  // BRF stage (R-07): one page per distinct association, after the detail stage has found the ids.
  // A rejected page, or one not reached before the deadline, leaves `brf` null on those rows and counts
  // as failed; it never throws and never stops the other associations.
  const byBrf = new Map<string, number[]>();
  for (const [i, f] of facts) {
    if (f.brfId === null) continue;
    const list = byBrf.get(f.brfId);
    if (list) list.push(i);
    else byBrf.set(f.brfId, [i]);
  }
  const brfStats = { distinct: byBrf.size, fetched: 0, failed: 0 };
  await runPool(
    [...byBrf].map(([brfId, indices]) => async () => {
      if (now() - startedAt >= opts.deadlineMs) {
        brfStats.failed += 1;
        return;
      }
      try {
        const brf = await d.fetchBrfFacts(brfId);
        for (const i of indices) {
          const current = facts.get(i);
          if (current) facts.set(i, { ...current, brf });
        }
        brfStats.fetched += 1;
      } catch (error) {
        brfStats.failed += 1;
        console.error("[watch-enrich] BRF page failed (non-fatal)", {
          code: error instanceof Error ? error.name : "UNKNOWN",
        });
      }
    }),
    concurrency,
  );

  return { candidates: out, brokerImages, sunPhrases, facts, brfStats };
}
