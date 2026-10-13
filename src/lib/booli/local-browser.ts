import { isBooliUrl } from "@/lib/booli/client";
import { runApifyRender, setRenderer, usableItems, type RenderFn, type RenderOpts } from "@/lib/booli/transport";

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
  /** Test seam: replaces the real browser launcher. */
  launcher?: LocalLauncher;
}

/** Counters printed in the spend block. */
export interface LocalRendererStats {
  pages: number;
  challenged: number;
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
/** Default cap on paid Apify fallbacks per run (about 0.59 USD at the observed rate). */
export const DEFAULT_APIFY_MAX_RENDERS = 10;
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
  const apifyMaxRenders = options.apifyMaxRenders ?? DEFAULT_APIFY_MAX_RENDERS;
  const windowMode = options.window ?? readWindow();
  const mode = options.mode ?? readMode();
  const stats: LocalRendererStats = { pages: 0, challenged: 0, retried: 0, apifyFallbacks: 0, failed: 0, refused: 0 };

  let browser: LocalBrowser | null = null;
  let context: LocalContext | null = null;
  let starting: Promise<LocalContext> | null = null;
  let closed = false;

  async function ensureContext(): Promise<LocalContext> {
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

  const render: RenderFn = async (url: string, pageFunction: string, _opts?: RenderOpts) => {
    // T-14.2-02: only Booli hosts are ever opened locally, and a refused URL never reaches Apify.
    if (!isBooliUrl(url)) {
      stats.refused += 1;
      throw new Error("Lokala webblasaren hamtar bara Booli-sidor");
    }
    try {
      const ctx = await ensureContext();
      const page = await ctx.newPage();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: LOCAL_NAV_TIMEOUT_MS });
        stats.pages += 1;
        const out = await compile(pageFunction)({ page, request: { url } });
        return usableItems([out]);
      } finally {
        await page.close().catch(() => undefined);
      }
    } catch (error) {
      stats.failed += 1;
      console.error("[booli-local]", error);
      throw new Error("Kunde inte hamta data fran Booli (lokal webblasare). Forsok igen.");
    }
  };
  void runApifyRender; // wired in the hardening step (allow-apify fallback)
  void allowApify;
  void apifyMaxRenders;

  setRenderer(render);

  return {
    stats: () => ({ ...stats }),
    async close() {
      if (closed) return;
      closed = true;
      setRenderer(null);
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
