import { isBooliUrl } from "@/lib/booli/client";
import { BROKER_RENDER_PAGE_FUNCTION } from "@/lib/broker/fetch-broker-page";
import { isSafeExternalUrl } from "@/lib/broker/url-guard";
import { NonRetryableRenderError, runApifyRender, setRenderer, usableItems, type RenderFn, type RenderOpts } from "@/lib/booli/transport";

/**
 * local-browser.ts — the LOCAL browser rung (Phase 14.2, WATCH-01; D-02, D-03,
 * D-04, D-05, R-03, R-10). A headed Chromium on Daniel's own Mac renders Booli
 * pages for the headless scripts: about 5 s per page and 0 USD, instead of
 * 120-245 s and 0.04-0.06 USD per Apify render.
 *
 * How it fits (identity model): `transport.ts` owns renderer selection.
 * `installLocalRenderer()` registers `render` with `setRenderer()`; from then on
 * `runPlaywrightRender` (and so `fetchListing`, `fetchAreaListings`, the sold
 * pages, ...) is served by this browser. Apify stays the fallback rung and is
 * called only when `allowApify` is true and the per-run cap is not used up.
 *
 * One parser, two transports (D-05, R-10): the page-function STRING that the
 * Apify actor evaluates is compiled ONCE with `new Function` and called with
 * `{ page, request: { url } }`. The OUTER string is what gets compiled; the
 * inner `EXTRACT_STATE_BROWSER_FN` constant is never evaluated on its own (it is
 * a function expression nobody calls, so evaluating it returns undefined). No
 * function literal written in this file is ever passed to `page.evaluate`, so a
 * TypeScript transform cannot inject helpers into code Playwright serializes.
 *
 * Script-only module. It is imported by `scripts/*` through a dynamic
 * `import()` and never from `src/app`, `src/actions`, `src/components`,
 * `transport.ts` or `client.ts` (a test enforces it): the browser toolchain
 * must not enter the Next.js server bundle. The browser library itself is
 * loaded lazily, inside the first render, never at module load.
 *
 * Broker pages (14.2-06): the one non-Booli page the renderer opens is a
 * broker's own listing page, and only when the caller passes the repo-owned
 * `BROKER_RENDER_PAGE_FUNCTION` for an https URL (fetch-broker-page.ts has
 * already refused unsafe hosts). Same pacing and the same 2-page gate, the same
 * throwaway context (broker sites set no cookie on Booli and vice versa), one
 * attempt with no retry, and never the paid Apify rung. Without that function a
 * non-Booli URL is refused as before. The browser sits on the home network, so
 * (WR-06) the final URL after redirects must be https and either the start host or
 * a host that resolves to a public address, and every sub-request is routed
 * through the same host check (private, loopback and link-local hosts, and any
 * scheme other than http(s) and inline data, are aborted). A residual window
 * remains where Chromium resolves a name differently from Node; the page text is
 * only ever parsed as data.
 *
 * Privacy / secret posture: one throwaway browser context per run
 * (`chromium.launch`, never a persistent profile, no storage state saved,
 * downloads off), closed on `close()`. Nothing here reads or prints an env
 * value other than the two non-secret mode switches below; errors are logged
 * as the error object only.
 *
 * Env switches: `BOOLI_LOCAL_WINDOW=visible` shows the window (default:
 * parked off-screen); `BOOLI_LOCAL_MODE=new-headless` runs without a window
 * (opt-in alternative, A1 unproven against Booli; headed stays the default).
 */

/** A minimal structural view of a Playwright page: only what this module calls. */
export interface LocalPage {
  goto(url: string, opts: { waitUntil: "domcontentloaded"; timeout: number }): Promise<{ status(): number } | null>;
  evaluate(arg: unknown): Promise<unknown>;
  close(): Promise<void>;
  /** Final URL after redirects. Needed (with `route`) for broker pages, which are refused without them (WR-06). */
  url?(): string;
  /** Request interception for this page; used for broker pages only (WR-06). */
  route?(pattern: string, handler: (route: LocalRoute) => Promise<void>): Promise<void>;
}

/** The part of a Playwright route this module uses. */
export interface LocalRoute {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

/** A browser context (one per run). */
export interface LocalContext {
  newPage(): Promise<LocalPage>;
  close(): Promise<void>;
}

/** A launched browser. */
export interface LocalBrowser {
  newContext(opts: Record<string, unknown>): Promise<LocalContext>;
  close(): Promise<void>;
  version(): string;
  on?(event: "disconnected", handler: () => void): void;
}

/** Launcher shape: Playwright's `chromium` object, or a test fake. */
export interface LocalLauncher {
  launch(opts: { headless: boolean; channel?: string; args: string[] }): Promise<LocalBrowser>;
}

/** Where the window goes while headed. */
export type LocalWindow = "offscreen" | "visible";
/** Headed (verified against Booli) or new headless (opt-in, unverified). */
export type LocalMode = "headed" | "new-headless";

export interface LocalRendererOptions {
  /** Allow a paid Apify render after two challenged local attempts. Default false (D-04, R-03). */
  allowApify?: boolean;
  /** Cap on those paid fallbacks per run. Default `DEFAULT_APIFY_MAX_RENDERS`. */
  apifyMaxRenders?: number;
  /** Default from `BOOLI_LOCAL_WINDOW`, else off-screen. */
  window?: LocalWindow;
  /** Default from `BOOLI_LOCAL_MODE`, else headed. */
  mode?: LocalMode;
  /**
   * Whether a challenged Booli page earns one retry after `LOCAL_CHALLENGE_RETRY_MS` (D-04). Default true. The weekly
   * live run passes false (CR-01): Booli's first refusal is then the last request this process sends.
   */
  retryChallenge?: boolean;
  /** Test seam: replaces the real browser launcher. */
  launcher?: LocalLauncher;
  /** Test seam: whether a URL's host resolves to a public address (WR-06). Default `isSafeExternalUrl`. */
  isSafeUrl?: (url: string) => Promise<boolean>;
  /** Ceiling for one page call (WR-01). Default `LOCAL_PAGE_CALL_TIMEOUT_MS`; tests lower it. */
  pageCallTimeoutMs?: number;
  /** Test seams: wait, clock and randomness for the retry wait and pacing. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

/** Counters printed in the spend block. */
export interface LocalRendererStats {
  pages: number;
  /**
   * Challenges from BOOLI pages only (WR-01). This is the number the D-04 stop rule (`enrichStopReason`) reads: a
   * Cloudflare page on a broker's own site must never stop a run that Booli did not block.
   */
  challenged: number;
  /** Challenges from third-party broker pages; printed next to the Booli number, never part of the stop rule. */
  challengedBroker: number;
  /** Booli renders refused at once, with no request, because the latch was set (CR-01). */
  latched: number;
  retried: number;
  apifyFallbacks: number;
  failed: number;
  refused: number;
}

export interface LocalRendererHandle {
  stats(): LocalRendererStats;
  /** Closes context and browser, uninstalls the renderer. Idempotent. */
  close(): Promise<void>;
}

/** Per-render navigation timeout. */
export const LOCAL_NAV_TIMEOUT_MS = 45_000;
/**
 * Ceiling for every call into a page that has no timeout of its own (WR-01): the
 * challenge probe, the page function, opening and closing a tab. Playwright's
 * `evaluate` waits forever on a tab that stops responding, which would hold one
 * of the two semaphore slots, stall the pool, and keep the run lock live.
 */
export const LOCAL_PAGE_CALL_TIMEOUT_MS = 60_000;
/** Default cap on paid Apify fallbacks per run (about 0.59 USD at the observed rate). */
export const DEFAULT_APIFY_MAX_RENDERS = 10;
/** Pages in flight at once (D-02: concurrency <= 2, kind to Booli from a home IP). */
export const LOCAL_CONCURRENCY = 2;
/** Shortest gap between two page STARTS (D-02: 1-2 s of politeness). */
export const LOCAL_PACING_MIN_MS = 1_000;
/** Longest drawn gap between two page starts. */
export const LOCAL_PACING_MAX_MS = 2_000;
/** The one wait before the one retry of a challenged page (D-04). */
export const LOCAL_CHALLENGE_RETRY_MS = 5_000;
/**
 * Booli streams its payload: a 200 page whose extractor finds no Apollo data may
 * simply not have finished. Wait this long inside the attempt and extract once
 * more before calling it a challenge (A14).
 */
export const LOCAL_REEXTRACT_MS = 1_500;
/** HTTP statuses Cloudflare answers with when it challenges (D-04). 404 and 500 are ordinary errors. */
export const CHALLENGE_STATUSES: readonly number[] = [403, 429, 503];
/** Text that marks a challenge page even on HTTP 200 (D-04). Matched case-insensitively. */
export const CHALLENGE_MARKERS: readonly string[] = ["Vänta...", "Vänta…", "Just a moment", "Verify you are human"];

/**
 * A page Booli (or Cloudflare in front of it) answered with a challenge instead
 * of data. Retried once after `LOCAL_CHALLENGE_RETRY_MS`, then it is an error
 * (or a capped Apify render when the caller allowed one).
 */
export class ChallengeError extends Error {
  constructor(
    readonly status: number | null,
    readonly marker: string,
  ) {
    super(`Booli utmanade den lokala webblasaren (${marker})`);
    this.name = "ChallengeError";
  }
}

/** A page call (probe, page function, open, close) that did not answer within its ceiling (WR-01). */
export class PageTimeoutError extends Error {
  constructor(readonly label: string) {
    super(`Sidan svarade inte i tid (${label})`);
    this.name = "PageTimeoutError";
  }
}

/**
 * Races `work` against a timer. The timer is real, `unref`'d (it never keeps the
 * process alive by itself) and always cleared, so a fast call leaves nothing
 * behind. The abandoned `work` promise is left pending; closing the page makes
 * it settle.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PageTimeoutError(label)), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * A broker page that, after redirects, sits somewhere the start URL was not
 * allowed to be, or whose browser support for the check is missing (WR-06).
 * Not a challenge, never retried.
 */
export class UnsafeBrokerUrlError extends Error {
  constructor() {
    super("Maklarsidan hamnade pa en otillaten adress");
    this.name = "UnsafeBrokerUrlError";
  }
}

/** Schemes a page may load without a host check (inline content only). */
const INLINE_SCHEMES = new Set(["data:", "blob:", "about:"]);

/**
 * Pure challenge test. Returns the marker (a short description of why) or
 * `null` when the page is not a challenge. HTTP 403/429/503 always is one; a
 * 200, 404 or 500 only is one when its title/body text carries a marker.
 */
export function isChallenge(status: number, text: string): string | null {
  if (CHALLENGE_STATUSES.includes(status)) return `HTTP ${status}`;
  const haystack = text.toLowerCase();
  for (const marker of CHALLENGE_MARKERS) {
    if (haystack.includes(marker.toLowerCase())) return marker;
  }
  return null;
}

/**
 * A fixed string expression (NOT a function literal) evaluated in the page for
 * the challenge test: the title plus the first 2 000 characters of the visible
 * text. `innerText` is absent in some DOMs, hence the fallback to "".
 */
const CHALLENGE_PROBE_EXPRESSION =
  '(document.title || "") + " " + ((document.body && document.body.innerText) || "").slice(0, 2000)';

/** Whether a window can be opened here: macOS outside SSH, or X11/Wayland elsewhere (D-03). */
export function displayAvailable(env: Readonly<Record<string, string | undefined>>, platform: string): boolean {
  if (platform === "darwin") return !env.SSH_CONNECTION && !env.SSH_TTY;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/**
 * Which renderer a script should use (D-03, R-03): `--renderer` beats
 * `BOOLI_RENDERER`, which beats the default. The default is local when a
 * display is available. With no display and no explicit choice it is an ERROR,
 * never a silent switch to Apify: a headless server must not spend the month's
 * Apify budget by accident.
 */
export function resolveRendererChoice(input: {
  flag?: string | null;
  env: Readonly<Record<string, string | undefined>>;
  platform: string;
}): { renderer: "local" | "apify" } | { error: string } {
  const explicit = input.flag ?? input.env.BOOLI_RENDERER;
  if (explicit !== undefined && explicit !== null && explicit !== "") {
    if (explicit === "local" || explicit === "apify") return { renderer: explicit };
    return { error: `Okänd renderare "${explicit}". Använd local eller apify (--renderer eller BOOLI_RENDERER).` };
  }
  if (displayAvailable(input.env, input.platform)) return { renderer: "local" };
  return {
    error:
      "Ingen skärm hittades (SSH eller utan grafisk session), så den lokala webbläsaren kan inte öppnas. Välj uttryckligen med --renderer local (på en maskin med skärm) eller --renderer apify (betald).",
  };
}

/** How long a signal handler waits for in-flight work to settle after the browser closed, before it exits anyway. */
export const SIGNAL_SETTLE_MS = 15_000;

/**
 * Registers SIGINT and SIGTERM handlers that close the browser and then exit
 * 130 / 143 (launchd stops jobs with SIGTERM). Returns a disposer. `proc` and
 * `exit` are injectable for tests.
 *
 * Order on a signal (WR-11): `onSignal` runs first and synchronously (a script sets its "stop
 * starting new work" flag there), then the browser closes (in-flight renders fail at once, and a
 * closed renderer refuses new ones, CR-01), then `settle` is awaited for at most `settleMs` (a script
 * returns the promise of its pipeline so the last outcomes are written to its cache), and only then
 * the process exits.
 */
export function closeOnSignals(
  handle: LocalRendererHandle,
  deps: {
    proc?: { once(signal: string, fn: () => void): unknown; off(signal: string, fn: () => void): unknown };
    exit?: (code: number) => void;
    onSignal?: () => void;
    settle?: () => Promise<unknown>;
    settleMs?: number;
  } = {},
): () => void {
  const proc = deps.proc ?? process;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const finish = (code: number): void => {
    try {
      deps.onSignal?.();
    } catch {
      // a failing hook must not keep the browser open
    }
    void handle
      .close()
      .then(async () => {
        if (!deps.settle) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const limit = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, deps.settleMs ?? SIGNAL_SETTLE_MS);
        });
        try {
          await Promise.race([Promise.resolve().then(deps.settle).catch(() => undefined), limit]);
        } finally {
          clearTimeout(timer);
        }
      })
      .finally(() => exit(code));
  };
  const onInt = () => finish(130);
  const onTerm = () => finish(143);
  proc.once("SIGINT", onInt);
  proc.once("SIGTERM", onTerm);
  return () => {
    proc.off("SIGINT", onInt);
    proc.off("SIGTERM", onTerm);
  };
}

/** What a render started after `close()` is told (CR-01): the run is over, nothing is sent to Apify. */
export const CLOSED_RENDERER_MESSAGE = "Lokala webblasaren ar stangd";

/** What a Booli render started after the latch is set is told (CR-01). Keeps the words "lokal webblasare" the callers match on. */
export const BLOCKED_RENDERER_MESSAGE = "Booli har utmanat den lokala webblasaren; inga fler Booli-sidor hamtas (lokal webblasare)";

/** Whole-run ceiling for a headless script (WR-01): 2 hours, far past a normal run (about 40 minutes at most). */
export const RUN_WATCHDOG_MS = 2 * 60 * 60_000;
/** Exit code of a run stopped by the watchdog. */
export const EXIT_RUN_TIMEOUT = 5;

/**
 * Whole-run watchdog (WR-01). After `ms` it logs, closes the browser (which also
 * refuses all later renders, CR-01) and exits `EXIT_RUN_TIMEOUT`. Scripts hold a
 * lock and `caffeinate` keeps the Mac awake for as long as the process lives, so a
 * run that hangs somewhere no per-page timeout reaches must still end by itself.
 * The timer is `unref`'d. Returns a disposer. `exit` is injectable for tests.
 */
export function armRunWatchdog(
  handle: LocalRendererHandle,
  ms: number = RUN_WATCHDOG_MS,
  deps: { exit?: (code: number) => void; log?: (message: string) => void } = {},
): () => void {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? ((message: string) => console.error(message));
  const timer = setTimeout(() => {
    log(`FEL: körningen översteg ${Math.round(ms / 60_000)} minuter och avbröts (webbläsaren stängs).`);
    void handle.close().finally(() => exit(EXIT_RUN_TIMEOUT));
  }, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/** Fixed viewport (D-02). */
const VIEWPORT = { width: 1280, height: 900 } as const;

/**
 * Compiled page functions, keyed by their source string. Only repo-owned
 * page-function constants are ever compiled (T-14.2-03); page-derived text is
 * read as data and never compiled or evaluated here.
 */
type PageFn = (ctx: { page: unknown; request: { url: string } }) => Promise<unknown>;
const compiled = new Map<string, PageFn>();
function compile(source: string): PageFn {
  let fn = compiled.get(source);
  if (!fn) {
    fn = new Function(`return (${source})`)() as PageFn;
    compiled.set(source, fn);
  }
  return fn;
}

/** Real launcher, loaded lazily so importing this module never loads the browser toolchain. */
async function loadRealLauncher(): Promise<LocalLauncher> {
  const pw = await import("playwright");
  return pw.chromium as unknown as LocalLauncher;
}

function readWindow(): LocalWindow {
  return process.env.BOOLI_LOCAL_WINDOW === "visible" ? "visible" : "offscreen";
}
function readMode(): LocalMode {
  return process.env.BOOLI_LOCAL_MODE === "new-headless" ? "new-headless" : "headed";
}

/** The user agent a headed Chrome of `version` reports (new headless says "HeadlessChrome"). */
function headedUserAgent(version: string): string {
  const platform = process.platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : "X11; Linux x86_64";
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

/**
 * Installs the local renderer into `transport.ts` and returns its handle.
 * The browser launches lazily on the first render.
 */
export function installLocalRenderer(options: LocalRendererOptions = {}): LocalRendererHandle {
  const allowApify = options.allowApify ?? false;
  const retryChallenge = options.retryChallenge ?? true;
  const apifyMaxRenders = options.apifyMaxRenders ?? DEFAULT_APIFY_MAX_RENDERS;
  const pageCallTimeoutMs = options.pageCallTimeoutMs ?? LOCAL_PAGE_CALL_TIMEOUT_MS;
  const isSafeUrl = options.isSafeUrl ?? isSafeExternalUrl;
  const windowMode = options.window ?? readWindow();
  const mode = options.mode ?? readMode();
  const stats: LocalRendererStats = {
    pages: 0,
    challenged: 0,
    challengedBroker: 0,
    latched: 0,
    retried: 0,
    apifyFallbacks: 0,
    failed: 0,
    refused: 0,
  };

  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;

  let browser: LocalBrowser | null = null;
  let context: LocalContext | null = null;
  let starting: Promise<LocalContext> | null = null;
  let closed = false;
  let relaunched = false;
  let dead = false;
  // CR-01: set when a Booli page has been challenged for good (twice, or once when the retry is switched off). From
  // then on every Booli render fails at once without opening a page, whichever caller asks (area pages, detail
  // pages, BRF pages, the sold-price pull), so a loop that forgets to check the stop rule still sends nothing.
  let booliBlocked = false;

  async function ensureContext(): Promise<LocalContext> {
    if (dead) throw new Error("webblasaren tappade anslutningen igen");
    if (context) return context;
    starting ??= (async () => {
      const launcher = options.launcher ?? (await loadRealLauncher());
      const args = ["--disable-blink-features=AutomationControlled"];
      if (windowMode === "offscreen" && mode === "headed") {
        args.push("--window-position=4000,4000", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding");
      }
      const launched =
        mode === "new-headless"
          ? await launcher.launch({ headless: true, channel: "chromium", args })
          : await launcher.launch({ headless: false, args });
      browser = launched;
      // One relaunch is tolerated (a crashed or closed window); a second disconnect ends the run.
      launched.on?.("disconnected", () => {
        if (closed) return;
        browser = null;
        context = null;
        starting = null;
        if (relaunched) dead = true;
        else relaunched = true;
      });
      const ctxOpts: Record<string, unknown> = {
        locale: "sv-SE",
        timezoneId: "Europe/Stockholm",
        viewport: { ...VIEWPORT },
        acceptDownloads: false,
      };
      if (mode === "new-headless") ctxOpts.userAgent = headedUserAgent(launched.version());
      context = await launched.newContext(ctxOpts);
      return context;
    })();
    return starting;
  }

  // --- Concurrency gate: a semaphore of LOCAL_CONCURRENCY plus a shared "next start" time.
  // No p-limit dependency (project rule); ~15 lines.
  let active = 0;
  const waiters: (() => void)[] = [];
  let nextStartAt = 0;
  async function acquire(): Promise<void> {
    if (active < LOCAL_CONCURRENCY) {
      active += 1;
    } else {
      await new Promise<void>((resolve) => waiters.push(resolve)); // the slot is handed over on release
    }
    const t = now();
    const startAt = Math.max(t, nextStartAt);
    nextStartAt = startAt + LOCAL_PACING_MIN_MS + random() * (LOCAL_PACING_MAX_MS - LOCAL_PACING_MIN_MS);
    if (startAt > t) await sleep(startAt - t);
  }
  function release(): void {
    const next = waiters.shift();
    if (next) next();
    else active -= 1;
  }

  /**
   * WR-06: the broker page runs in a browser on Daniel's own network, next to local services (local
   * Supabase, the dev server, the router). The start URL was checked once in Node; this adds the two
   * checks Chromium's own behaviour needs. Per-host verdicts are cached for the run.
   */
  const hostVerdicts = new Map<string, Promise<boolean>>();
  function hostIsPublic(host: string, sampleUrl: string): Promise<boolean> {
    let verdict = hostVerdicts.get(host);
    if (!verdict) {
      verdict = isSafeUrl(sampleUrl).catch(() => false);
      hostVerdicts.set(host, verdict);
    }
    return verdict;
  }
  /** Same host as the start URL, or a host that resolves to a public address. https/http only. */
  async function brokerUrlAllowed(candidate: string, startHost: string): Promise<boolean> {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      return false;
    }
    if (INLINE_SCHEMES.has(parsed.protocol)) return true;
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    if (parsed.hostname === startHost) return true;
    return hostIsPublic(parsed.hostname, parsed.toString());
  }

  /** One attempt on a fresh page. Throws ChallengeError for a challenge, a plain Error otherwise. */
  async function attempt(url: string, pageFunction: string, broker: boolean): Promise<unknown[]> {
    await acquire();
    try {
      // A render that queued for a slot before the latch was set must not open a page after it (CR-01).
      if (booliBlocked && !broker) throw new NonRetryableRenderError(BLOCKED_RENDERER_MESSAGE);
      const ctx = await ensureContext();
      const page = await withTimeout(ctx.newPage(), pageCallTimeoutMs, "ny flik");
      try {
        if (broker) {
          // Fail closed: without the final-URL and request hooks a broker page is not opened at all.
          if (typeof page.route !== "function" || typeof page.url !== "function") throw new UnsafeBrokerUrlError();
          const startHost = new URL(url).hostname;
          await withTimeout(
            page.route("**/*", async (route) => {
              const ok = await brokerUrlAllowed(route.request().url(), startHost).catch(() => false);
              if (ok) await route.continue().catch(() => undefined);
              else await route.abort("blockedbyclient").catch(() => undefined);
            }),
            pageCallTimeoutMs,
            "natverkskontroll",
          );
        }
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: LOCAL_NAV_TIMEOUT_MS });
        stats.pages += 1;
        if (broker) {
          // Redirects are followed by the browser, so check where it actually ended up before reading it.
          const finalUrl = (page.url as () => string)();
          if (!/^https:\/\//i.test(finalUrl) || !(await brokerUrlAllowed(finalUrl, new URL(url).hostname).catch(() => false))) {
            throw new UnsafeBrokerUrlError();
          }
        }
        const status = response?.status() ?? 0;
        if (CHALLENGE_STATUSES.includes(status)) throw new ChallengeError(status, `HTTP ${status}`);
        if (status >= 400) throw new Error(`Booli svarade HTTP ${status}`);
        const text = String(await withTimeout(page.evaluate(CHALLENGE_PROBE_EXPRESSION), pageCallTimeoutMs, "utmaningstest"));
        const marker = isChallenge(status, text);
        if (marker !== null) throw new ChallengeError(status, marker);

        const run = compile(pageFunction);
        let out = await withTimeout(run({ page, request: { url } }), pageCallTimeoutMs, "sidfunktion");
        if ((out as { hasApollo?: boolean } | null)?.hasApollo === false) {
          await sleep(LOCAL_REEXTRACT_MS);
          out = await withTimeout(run({ page, request: { url } }), pageCallTimeoutMs, "sidfunktion");
          if ((out as { hasApollo?: boolean } | null)?.hasApollo === false) {
            throw new ChallengeError(status, "ingen Apollo-data");
          }
        }
        return usableItems([out]);
      } finally {
        // A tab that does not answer must not hold the slot either (WR-01).
        await withTimeout(page.close(), pageCallTimeoutMs, "stang flik").catch(() => undefined);
      }
    } finally {
      release();
    }
  }

  const render: RenderFn = async (url: string, pageFunction: string, opts?: RenderOpts) => {
    // T-14.2-02: Booli pages, plus ONE other kind of page: a broker's own listing page, opened by the
    // repo-owned broker page function (the only description and photo source, 14.2-06). Any other
    // host, or a broker URL that is not https, is refused. A refused URL never reaches Apify.
    const broker = !isBooliUrl(url) && pageFunction === BROKER_RENDER_PAGE_FUNCTION && /^https:\/\//i.test(url);
    if (!isBooliUrl(url) && !broker) {
      stats.refused += 1;
      throw new NonRetryableRenderError("Lokala webblasaren hamtar bara Booli-sidor och maklarsidor");
    }
    if (booliBlocked && !broker) {
      stats.latched += 1;
      throw new NonRetryableRenderError(BLOCKED_RENDERER_MESSAGE);
    }
    let lastError: unknown;
    // At most two attempts, and only a challenge earns the second one (D-04), unless the retry is switched off.
    for (let tryNo = 1; tryNo <= 2; tryNo++) {
      try {
        return await attempt(url, pageFunction, broker);
      } catch (error) {
        lastError = error;
        if (error instanceof NonRetryableRenderError) {
          stats.latched += 1;
          throw error;
        }
        if (!(error instanceof ChallengeError)) break;
        // A broker page is a bonus: one attempt, no wait, no retry, and never the paid Apify rung. Its challenge is
        // counted apart (WR-01) and never latches.
        if (broker) {
          stats.challengedBroker += 1;
          break;
        }
        stats.challenged += 1;
        if (tryNo === 1 && retryChallenge && !booliBlocked) {
          stats.retried += 1;
          await sleep(LOCAL_CHALLENGE_RETRY_MS);
          // The other slot may have been refused for good while this one waited: then no second request goes out.
          if (booliBlocked) break;
          continue;
        }
        // Challenged for good: Booli has refused this Mac. Latch before anything else can request another page.
        booliBlocked = true;
        // The paid rung runs only when the caller asked for it and the cap has room (D-04, R-03).
        if (!closed && allowApify && stats.apifyFallbacks < apifyMaxRenders) {
          stats.apifyFallbacks += 1;
          try {
            return await runApifyRender(url, pageFunction, opts);
          } catch (apifyError) {
            // The paid rung has had its go; the tree must not ask the local browser again (WR-04).
            throw new NonRetryableRenderError(apifyError instanceof Error ? apifyError.message : "Apify-rendering misslyckades");
          }
        }
        break;
      }
    }
    stats.failed += 1;
    // Log the error object only; never an env value (secret posture). A broker URL is attacker-influenceable
    // (it comes from a listing), so for a broker page only the error name is logged, never the message.
    console.error("[booli-local]", broker ? { broker: true, code: lastError instanceof Error ? lastError.name : "UNKNOWN" } : lastError);
    // Non-retryable (WR-04): the retry policy above is the only one. fetchListing and the area and sold
    // pages walk two rungs built for Apify's fresh-proxy retry; they must not request the page again.
    throw new NonRetryableRenderError("Kunde inte hamta data fran Booli (lokal webblasare). Forsok igen.");
  };

  setRenderer(render);

  return {
    stats: () => ({ ...stats }),
    async close() {
      if (closed) return;
      closed = true;
      // CR-01: a closed local renderer must REFUSE, never hand the URL back to the
      // Apify default. close() runs on SIGINT/SIGTERM while the pipeline is still
      // starting renders; restoring the default (setRenderer(null)) re-routed every
      // one of them to a paid actor run, past the --allow-apify gate and the cap.
      setRenderer(async () => {
        throw new NonRetryableRenderError(CLOSED_RENDERER_MESSAGE);
      });
      try {
        await context?.close();
      } catch {
        /* already gone */
      }
      try {
        await browser?.close();
      } catch {
        /* already gone */
      }
    },
  };
}
