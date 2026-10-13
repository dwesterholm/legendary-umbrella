import { ApifyClient } from "apify-client";

/**
 * transport.ts — the ONE owned Apify actor-call core shared by every
 * `booli/` fallback rung and future page-shape read (05-RESEARCH.md Pattern
 * 1). This is now the ONLY module that instantiates `ApifyClient` for the
 * owned transport (05-PATTERNS.md Shared Patterns) — `client.ts` and
 * `fallback-tree.ts` call through `runPlaywrightRender`, they never
 * re-instantiate `ApifyClient` themselves.
 *
 * The actor config below reproduces `src/lib/market/sold-source.ts`'s
 * `fetchSoldComps()` actor-call block VERBATIM — every value (proxy group,
 * retry count, wait ceiling) is evidence-backed in production, not arbitrary:
 *  - `apify/playwright-scraper` (chromium) + RESIDENTIAL/SE proxy is the ONLY
 *    transport that clears Booli's Cloudflare challenge (a raw fetch, even
 *    proxy-routed, is 403'd — 03-SPIKE.md §1.2).
 *  - `maxRequestRetries: 3` — a single retry budget once produced a false
 *    negative (a 403 streak returned 0 items on retry budget 1; 3 absorbed
 *    it). Do NOT "clean up" this back down to 1 without separately
 *    re-proving a lower budget is safe (05-RESEARCH.md Anti-Patterns).
 *  - `waitSecs: 240` — Apify container cold-start (image pull + creation) can
 *    eat ~60s before crawling even begins; a warm run finishes fast, so this
 *    only raises the ceiling, it never slows a warm run down.
 *
 * HIGH-1 discipline (carried forward verbatim from sold-source.ts): a dead
 * source must be distinguishable from a genuinely-empty result. This function
 * NEVER returns `[]` to signal "the source is dead" — it throws instead, on
 * non-SUCCEEDED status, on an empty dataset, or when every item comes back
 * with `hasApollo === false`.
 *
 * Secret posture: `APIFY_API_TOKEN` is read from `process.env` only (never
 * `NEXT_PUBLIC_`) and is never logged or stringified. The catch block below
 * logs only the error object via `console.error("[booli-transport]", error)`,
 * then re-throws a Swedish, user-facing message — the raw error (and
 * certainly never the token or the `ApifyClient` instance) is never leaked.
 *
 * Renderer selection (Phase 14.2, D-02/D-03/D-05): this module owns WHICH
 * renderer serves a Booli page. `runPlaywrightRender` is the single entry
 * point; it dispatches to a renderer installed with `setRenderer()` (the local
 * headed Chromium in `local-browser.ts`, installed by headless SCRIPTS only)
 * or, when none is installed, to `runApifyRender` (the old body, moved
 * verbatim). Apify is therefore ONE renderer among two, the metered fallback,
 * and the in-app job keeps using it unchanged because the app never installs
 * anything. This file must never import the browser library: it is in the
 * Next.js server graph (via `client.ts`), and `local-browser.test.ts` guards it.
 */

const client = new ApifyClient({
  token: process.env.APIFY_API_TOKEN!,
});

/** The Apify browser actor that clears Cloudflare on Booli's HTML pages. */
const PLAYWRIGHT_SCRAPER_ACTOR = "apify/playwright-scraper";

/** Memory requested per actor run, in MB (see the call site for why not the 4096 default). */
export const RENDER_MEMORY_MB = 2048;
/** Seconds past `waitSecs` after which Apify itself aborts the run. */
export const RENDER_TIMEOUT_GRACE_SECS = 60;

/** The optional render knobs every renderer accepts (a local renderer ignores them). */
export interface RenderOpts {
  waitSecs?: number;
  maxRequestRetries?: number;
}

/** A renderer: URL + serialized page function in, usable dataset items out (HIGH-1: never `[]`). */
export type RenderFn = (
  url: string,
  pageFunction: string,
  opts?: RenderOpts,
) => Promise<unknown[]>;

/**
 * An error a renderer throws once ITS OWN retry policy is used up (WR-04). The
 * fallback tree reads the `nonRetryable` flag and stops walking: the second
 * rung exists for Apify's fresh-proxy retry, and re-requesting a challenged page
 * from the same home IP is the thing most likely to turn a soft challenge into
 * a block. Duck-typed on purpose so `fallback-tree.ts` needs no import.
 */
export class NonRetryableRenderError extends Error {
  readonly nonRetryable = true;
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableRenderError";
  }
}

/** The installed renderer, or `null` for the default (Apify). Only scripts ever set it. */
let renderer: RenderFn | null = null;

/**
 * Installs `fn` as the renderer behind `runPlaywrightRender`, or restores the
 * Apify default with `null`. Scripts call this (via `installLocalRenderer`);
 * the in-app server code never does, so its Apify input stays byte-identical.
 */
export function setRenderer(fn: RenderFn | null): void {
  renderer = fn;
}

/**
 * The HIGH-1 rule shared by every renderer (Apify and local): an empty result
 * or one where every item has `hasApollo === false` is a SOURCE failure and
 * throws, it is never returned as `[]` (which a caller could not tell from a
 * genuinely empty area). The two Swedish messages are identical on both paths.
 */
export function usableItems(items: unknown[]): unknown[] {
  // A non-200 / blocked render yields no item or hasApollo=false. Either is
  // a SOURCE failure (HIGH-1) — throw, never return [] (which would be
  // indistinguishable from a genuinely empty result).
  if (!items.length) {
    throw new Error("Inga resultat fran Booli-kallan");
  }
  const usable = items.filter(
    (it) => (it as { hasApollo?: boolean }).hasApollo !== false,
  );
  if (!usable.length) {
    throw new Error("Booli-kallan returnerade ingen Apollo-data (hasApollo=false)");
  }
  return usable;
}

/**
 * Renders `url` through the installed renderer when a script installed one
 * (local headed Chromium), else through Apify (`runApifyRender`). Throws —
 * never returns an empty array — when the render fails, the result is empty,
 * or every item lacks a usable Apollo blob.
 */
export function runPlaywrightRender(
  url: string,
  pageFunction: string,
  opts?: RenderOpts,
): Promise<unknown[]> {
  return renderer ? renderer(url, pageFunction, opts) : runApifyRender(url, pageFunction, opts);
}

/**
 * Renders `url` through the owned Apify Playwright actor and returns the usable
 * dataset items (each `{ hasApollo, __APOLLO_STATE__ }`, per `pageFunction`'s
 * contract). Throws — never returns an empty array — when the render fails,
 * the dataset is empty, or every item lacks a usable Apollo blob.
 *
 * This is the pre-14.2 body of `runPlaywrightRender`, moved verbatim.
 *
 * @param url - the pre-validated Booli URL to render (the domain allowlist
 *   check is the CALLER's responsibility — see T-05-09 in 05-03-PLAN.md's
 *   threat model; this transport treats `url` as already validated).
 * @param pageFunction - the serialized browser-side extraction function sent
 *   to the actor (see `page-functions.ts` for the shared Apollo extractor).
 * @param opts - OPTIONAL, additive-only override (D-02, 13-RESEARCH.md
 *   Pitfall 3): defaults to the proven 240s/3-retry values above so every
 *   EXISTING call site (`fetchListing`, sold-comps, broker enrichment) stays
 *   byte-for-byte unchanged. Only `fetchAreaPage`'s area-page rungs pass a
 *   lower `waitSecs` to bound worst-case per-tick duration (RESEARCH Pitfall
 *   1/2) — never lower these two literal defaults in place.
 */
export async function runApifyRender(
  url: string,
  pageFunction: string,
  opts?: RenderOpts,
): Promise<unknown[]> {
  const waitSecs = opts?.waitSecs ?? 240;
  const maxRequestRetries = opts?.maxRequestRetries ?? 3;
  try {
    const run = await client.actor(PLAYWRIGHT_SCRAPER_ACTOR).call(
      {
        startUrls: [{ url }],
        launcher: "chromium",
        proxyConfiguration: {
          useApifyProxy: true,
          apifyProxyGroups: ["RESIDENTIAL"],
          apifyProxyCountry: "SE",
        },
        // proven necessary — a single 403 streak returned 0 items on retry
        // budget 1; sold-source.ts absorbed it with 3. Do not reduce (the
        // default). A caller may still opt in to a lower scoped value.
        maxRequestRetries,
        maxPagesPerCrawl: 1,
        pageFunction,
      },
      // cold-start headroom, proven necessary in booli-scraper.ts and
      // sold-source.ts — a warm run returns as soon as it finishes.
      {
        waitSecs,
        // `log: null` turns off apify-client's default streaming of the actor's
        // run log to our stdout. Nothing reads that stream, and its volume killed
        // the headless search (exit 137) when four area scrapes ran in parallel.
        log: null,
        // The actor's default is 4096 MB per run. A four-district search fans
        // out to ~20 parallel page renders, which at 4 GB each exceeds the
        // account's 64 GB ceiling — Apify then refuses the extra runs ("exceed
        // the memory limit") and whole districts drop out of the results
        // (observed 2026-10-11/12). A Booli page renders fine in 2 GB.
        memory: RENDER_MEMORY_MB,
        // Apify's own run timeout. Without it a run we stopped waiting for
        // (`waitSecs` elapsed) keeps running up to the actor's 3600 s default,
        // holding memory and billing compute for nothing.
        timeout: waitSecs + RENDER_TIMEOUT_GRACE_SECS,
      },
    );

    // A non-SUCCEEDED run (still RUNNING at the wait ceiling, TIMED-OUT,
    // FAILED) is a TRANSIENT source failure, not a genuinely-empty result —
    // don't read a partial dataset and mislabel it. Throw distinguishably.
    if (run.status !== "SUCCEEDED") {
      throw new Error(`Booli-kallan blev inte klar i tid (status: ${run.status})`);
    }

    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    // HIGH-1: empty / hasApollo=false is a source failure (shared rule).
    return usableItems(items);
  } catch (error) {
    // Log the real error server-side before mapping to a user-facing message.
    // Never log process.env.APIFY_API_TOKEN or the ApifyClient instance.
    console.error("[booli-transport]", error);
    throw new Error(
      "Kunde inte hamta data fran Booli. Forsok igen.",
    );
  }
}

/** What Apify's runs API says a window of runs cost. */
export interface ApifySpend {
  /** Sum of `usageTotalUsd` over every run started at or after `since`. */
  usd: number;
  /** Number of runs counted (all statuses). */
  runs: number;
  succeeded: number;
  timedOut: number;
  /** FAILED and ABORTED. */
  failed: number;
  /** Any other status (RUNNING, READY, ...). */
  other: number;
  /** Runs that reported no `usageTotalUsd` (counted as 0 USD). */
  missingUsage: number;
}

const SPEND_PAGE_LIMIT = 100;
const SPEND_MAX_PAGES = 20;

/**
 * Real Apify spend for runs started at or after `since`, read from the runs
 * API (R-06, R-10: the real bill always wins over an estimate). Pages
 * newest-first and stops at the first run older than `since` or after 20
 * pages. Resolves to `null` — never throws — when the API call fails, so a
 * caller can fall back to a LABELLED estimate.
 *
 * The ledger is ACCOUNT-WIDE: a concurrent run from another tool in the same
 * window is counted too. Scripts must print that caveat next to the number.
 *
 * Secret posture: logs only the error object, never the token or the client.
 */
export async function apifySpendSince(since: Date): Promise<ApifySpend | null> {
  const sinceMs = since.getTime();
  const spend: ApifySpend = {
    usd: 0,
    runs: 0,
    succeeded: 0,
    timedOut: 0,
    failed: 0,
    other: 0,
    missingUsage: 0,
  };
  try {
    for (let page = 0; page < SPEND_MAX_PAGES; page++) {
      const { items } = await client
        .runs()
        .list({ desc: true, limit: SPEND_PAGE_LIMIT, offset: page * SPEND_PAGE_LIMIT });
      let reachedOlder = false;
      for (const item of items) {
        const startedMs = new Date(item.startedAt as Date | string).getTime();
        if (!Number.isFinite(startedMs) || startedMs < sinceMs) {
          reachedOlder = true;
          break;
        }
        spend.runs += 1;
        if (typeof item.usageTotalUsd === "number" && Number.isFinite(item.usageTotalUsd)) {
          spend.usd += item.usageTotalUsd;
        } else {
          spend.missingUsage += 1;
        }
        switch (item.status) {
          case "SUCCEEDED":
            spend.succeeded += 1;
            break;
          case "TIMED-OUT":
            spend.timedOut += 1;
            break;
          case "FAILED":
          case "ABORTED":
            spend.failed += 1;
            break;
          default:
            spend.other += 1;
        }
      }
      if (reachedOlder || items.length < SPEND_PAGE_LIMIT) break;
    }
    return spend;
  } catch (error) {
    console.error("[booli-transport] runs list", error);
    return null;
  }
}

/**
 * How long a script waits after its last Apify call before reading the runs
 * API (WR-05, D-07). Apify books a run's usage a few seconds after the run
 * ends, so reading the bill immediately reports too little. ONE constant for
 * every headless script (`fit-score.ts`, `pull-slutpriser.ts`,
 * `probe-fit-sources.ts`).
 */
export const LEDGER_SETTLE_MS = 10_000;

/** Waits `ms` (default `LEDGER_SETTLE_MS`) before a runs-API read (WR-05). */
export function waitForLedgerSettle(ms: number = LEDGER_SETTLE_MS): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The ONE runs-API ledger line the headless scripts print (W4), in Swedish
 * decimal-comma format, so later evidence checks can match it literally.
 * A zero bill is exactly
 * `Apify (runs-API): 0,00 USD, 0 körningar (0 lyckade, 0 timeout, 0 misslyckade)`;
 * an unreadable bill is `Apify (runs-API): kunde inte läsas (<reason>)` (the
 * parenthesis is omitted when no reason is given). The account-wide caveat
 * (the bill can include other runs since the start time) is printed by the
 * caller on a separate note line, not folded into this one.
 */
export function formatApifyRunsLine(spend: ApifySpend | null, reason?: string): string {
  if (spend === null) {
    return reason ? `Apify (runs-API): kunde inte läsas (${reason})` : "Apify (runs-API): kunde inte läsas";
  }
  const usd = spend.usd.toFixed(2).replace(".", ",");
  return `Apify (runs-API): ${usd} USD, ${spend.runs} körningar (${spend.succeeded} lyckade, ${spend.timedOut} timeout, ${spend.failed} misslyckade)`;
}

/**
 * Apify monthly usage headroom in USD (limit minus used so far this cycle), or
 * `null` when it cannot be determined. Lets a paid script refuse to start when
 * its own budget exceeds what is left.
 */
export async function apifyMonthlyHeadroomUsd(): Promise<number | null> {
  try {
    const limits = await client.user().limits();
    const max = limits?.limits?.maxMonthlyUsageUsd;
    const used = limits?.current?.monthlyUsageUsd;
    if (typeof max !== "number" || typeof used !== "number") return null;
    if (!Number.isFinite(max) || !Number.isFinite(used)) return null;
    return max - used;
  } catch (error) {
    console.error("[booli-transport] user limits", error);
    return null;
  }
}
