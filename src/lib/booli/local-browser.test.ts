import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  actorCall,
  listItems,
  resetApifyMock,
  apifyClientMockFactory,
} from "@/lib/booli/__mocks__/apify-client";
import { APOLLO_PAGE_FUNCTION } from "@/lib/booli/page-functions";
import { BROKER_RENDER_PAGE_FUNCTION } from "@/lib/broker/fetch-broker-page";

vi.mock("apify-client", () => apifyClientMockFactory());
vi.mock("@/lib/apify/booli-scraper", () => ({ scrapeBooli: vi.fn() }));

// Imported AFTER the mocks above are registered.
import {
  ChallengeError,
  CLOSED_RENDERER_MESSAGE,
  closeOnSignals,
  displayAvailable,
  installLocalRenderer,
  isChallenge,
  resolveRendererChoice,
  type LocalLauncher,
  type LocalRendererHandle,
  type LocalRendererOptions,
} from "@/lib/booli/local-browser";
import { runPlaywrightRender, setRenderer } from "@/lib/booli/transport";

const BOOLI_URL = "https://www.booli.se/sok/till-salu?areaIds=115341";
const STATE = { "Listing:1": { __typename: "Listing", id: "1" } };

// ---------------------------------------------------------------------------
// A virtual clock: sleep() registers a timer; run() drives time forward until
// the awaited promise settles. No real waiting, exact timestamps.
// ---------------------------------------------------------------------------

function makeClock() {
  let nowMs = 0;
  const timers: { at: number; seq: number; resolve: () => void }[] = [];
  let seq = 0;
  const sleeps: number[] = [];
  const clock = {
    now: () => nowMs,
    sleeps,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        sleeps.push(ms);
        timers.push({ at: nowMs + ms, seq: seq++, resolve });
      }),
    async run<T>(p: Promise<T>): Promise<T> {
      let done = false;
      p.then(
        () => (done = true),
        () => (done = true),
      );
      let idle = 0;
      while (!done) {
        await new Promise<void>((r) => setImmediate(r));
        if (done) break;
        if (timers.length === 0) {
          if (++idle > 20) throw new Error("virtual clock: deadlock (no timers, promise pending)");
          continue;
        }
        idle = 0;
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = timers.shift()!;
        nowMs = Math.max(nowMs, next.at);
        next.resolve();
      }
      return p;
    },
  };
  return clock;
}

// ---------------------------------------------------------------------------
// A scripted fake browser.
// ---------------------------------------------------------------------------

interface PageScript {
  /** HTTP status goto resolves with (default 200). */
  status?: number;
  /** What the challenge probe (a string expression) returns (default clean text). */
  text?: string;
  /** Apollo state per page-function extraction; null = hasApollo false (default: one state). */
  states?: (typeof STATE | null)[];
  /** Virtual ms the navigation takes. */
  durationMs?: number;
  /** evaluate() of the page function's extractor throws. */
  throwInExtract?: boolean;
}

function makeBrowser(clock: ReturnType<typeof makeClock>, script: (url: string, n: number) => PageScript) {
  const log = {
    launches: 0,
    contexts: [] as Record<string, unknown>[],
    launchOpts: [] as { headless: boolean; channel?: string; args: string[] }[],
    opened: 0,
    closed: 0,
    open: 0,
    maxOpen: 0,
    starts: [] as number[],
    urls: [] as string[],
    browserCloses: 0,
    contextCloses: 0,
  };
  let gotoCount = 0;
  const disconnectHandlers: (() => void)[] = [];
  const launcher: LocalLauncher = {
    launch: async (opts) => {
      log.launches += 1;
      log.launchOpts.push(opts);
      return {
        newContext: async (ctxOpts) => {
          log.contexts.push(ctxOpts);
          return {
            newPage: async () => {
              log.opened += 1;
              log.open += 1;
              log.maxOpen = Math.max(log.maxOpen, log.open);
              let sc: PageScript = {};
              let extractions = 0;
              let isClosed = false;
              return {
                goto: async (url: string) => {
                  gotoCount += 1;
                  sc = script(url, gotoCount);
                  log.urls.push(url);
                  log.starts.push(clock.now());
                  if (sc.durationMs) await clock.sleep(sc.durationMs);
                  return { status: () => sc.status ?? 200 };
                },
                waitForTimeout: async () => undefined,
                evaluate: async (arg: unknown) => {
                  if (typeof arg === "string") return sc.text ?? "Booli bostäder till salu";
                  if (sc.throwInExtract) throw new Error("evaluation failed");
                  const states = sc.states ?? [STATE];
                  const state = states[Math.min(extractions, states.length - 1)];
                  extractions += 1;
                  return state;
                },
                close: async () => {
                  if (isClosed) return;
                  isClosed = true;
                  log.closed += 1;
                  log.open -= 1;
                },
              };
            },
            close: async () => {
              log.contextCloses += 1;
            },
          };
        },
        close: async () => {
          log.browserCloses += 1;
        },
        version: () => "148.0.7778.96",
        on: (_event: "disconnected", handler: () => void) => {
          disconnectHandlers.push(handler);
        },
      };
    },
  };
  return { launcher, log, disconnect: () => disconnectHandlers.forEach((h) => h()) };
}

let handle: LocalRendererHandle | null = null;
let errorSpy: ReturnType<typeof vi.spyOn>;

function install(clock: ReturnType<typeof makeClock>, launcher: LocalLauncher, extra: Partial<LocalRendererOptions> = {}) {
  handle = installLocalRenderer({
    launcher,
    window: "offscreen",
    mode: "headed",
    sleep: clock.sleep,
    now: clock.now,
    random: () => 0.5,
    ...extra,
  });
  return handle;
}

beforeEach(() => {
  resetApifyMock();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await handle?.close();
  handle = null;
  setRenderer(null);
  errorSpy.mockRestore();
});

const render = (url = BOOLI_URL) => runPlaywrightRender(url, APOLLO_PAGE_FUNCTION);

// ---------------------------------------------------------------------------

describe("isChallenge", () => {
  it.each([403, 429, 503])("HTTP %i is a challenge", (status) => {
    expect(isChallenge(status, "ren text")).not.toBeNull();
  });

  it.each([200, 404, 500])("HTTP %i with clean text is not a challenge", (status) => {
    expect(isChallenge(status, "Booli bostäder till salu")).toBeNull();
  });

  it.each(["Vänta...", "Vänta…", "Just a moment", "Verify you are human"])("a 200 page containing %j is a challenge", (marker) => {
    expect(isChallenge(200, `Titel ${marker} resten`)).not.toBeNull();
  });

  it('"Vänta inte" alone is not a challenge', () => {
    expect(isChallenge(200, "Vänta inte med att boka visning")).toBeNull();
  });
});

describe("launch settings (D-02, T-14.2-04)", () => {
  it("launches a headed browser with the automation flag, off-screen, and a throwaway sv-SE context", async () => {
    const clock = makeClock();
    const b = makeBrowser(clock, () => ({}));
    install(clock, b.launcher);
    await clock.run(render());
    expect(b.log.launchOpts[0].headless).toBe(false);
    expect(b.log.launchOpts[0].args).toContain("--disable-blink-features=AutomationControlled");
    expect(b.log.launchOpts[0].args).toContain("--window-position=4000,4000");
    expect(b.log.contexts[0]).toMatchObject({
      locale: "sv-SE",
      timezoneId: "Europe/Stockholm",
      viewport: { width: 1280, height: 900 },
      acceptDownloads: false,
    });
    expect(b.log.contexts[0]).not.toHaveProperty("storageState");
  });

  it("window visible leaves the window where it is; new-headless sets the headed user agent", async () => {
    const clock = makeClock();
    const visible = makeBrowser(clock, () => ({}));
    install(clock, visible.launcher, { window: "visible" });
    await clock.run(render());
    expect(visible.log.launchOpts[0].args).not.toContain("--window-position=4000,4000");
    await handle!.close();

    const headless = makeBrowser(clock, () => ({}));
    install(clock, headless.launcher, { mode: "new-headless" });
    await clock.run(render());
    expect(headless.log.launchOpts[0]).toMatchObject({ headless: true, channel: "chromium" });
    expect(String(headless.log.contexts[0].userAgent)).toContain("Chrome/148.0.7778.96");
    expect(String(headless.log.contexts[0].userAgent)).not.toContain("HeadlessChrome");
  });
});

describe("challenge handling (D-04)", () => {
  it("challenge then success: one 5 000 ms wait, one retry, both pages closed", async () => {
    const clock = makeClock();
    const b = makeBrowser(clock, (_u, n) => (n === 1 ? { status: 403 } : {}));
    const h = install(clock, b.launcher);
    const items = await clock.run(render());
    expect(items).toHaveLength(1);
    expect(clock.sleeps.filter((ms) => ms === 5_000)).toHaveLength(1);
    expect(h.stats()).toMatchObject({ challenged: 1, retried: 1, apifyFallbacks: 0 });
    expect(b.log.opened).toBe(2);
    expect(b.log.closed).toBe(2);
  });

  it('a 200 page whose text says "Vänta..." is treated as a challenge too', async () => {
    const clock = makeClock();
    const b = makeBrowser(clock, (_u, n) => (n === 1 ? { text: "Vänta..." } : {}));
    const h = install(clock, b.launcher);
    await clock.run(render());
    expect(h.stats().challenged).toBe(1);
  });

  it("never calls Apify: challenged twice with allowApify false rejects with the Swedish error", async () => {
    const clock = makeClock();
    const b = makeBrowser(clock, () => ({ status: 403 }));
    const h = install(clock, b.launcher, { allowApify: false });
    await expect(clock.run(render())).rejects.toThrow("Kunde inte hamta data fran Booli (lokal webblasare). Forsok igen.");
    expect(actorCall).not.toHaveBeenCalled();
    expect(h.stats()).toMatchObject({ challenged: 2, retried: 1, apifyFallbacks: 0, failed: 1 });
    expect(clock.sleeps.filter((ms) => ms === 5_000)).toHaveLength(1); // exactly one retry, no third attempt
    expect(b.log.opened).toBe(2);
    expect(b.log.closed).toBe(2);
  });

  it("allowApify true: the first doubly-challenged URL goes to Apify, the second is refused once the cap (1) is used", async () => {
    actorCall.mockResolvedValue({ status: "SUCCEEDED", defaultDatasetId: "ds-1" });
    listItems.mockResolvedValue({ items: [{ hasApollo: true, __APOLLO_STATE__: STATE }] });
    const clock = makeClock();
    const b = makeBrowser(clock, () => ({ status: 403 }));
    const h = install(clock, b.launcher, { allowApify: true, apifyMaxRenders: 1 });

    const items = await clock.run(render(`${BOOLI_URL}&page=1`));
    expect(items).toHaveLength(1);
    expect(actorCall).toHaveBeenCalledTimes(1);
    expect(h.stats().apifyFallbacks).toBe(1);

    await expect(clock.run(render(`${BOOLI_URL}&page=2`))).rejects.toThrow("lokal webblasare");
    expect(actorCall).toHaveBeenCalledTimes(1);
    expect(h.stats().apifyFallbacks).toBe(1);
  });

  it("a 200 page with hasApollo false is re-extracted once after 1 500 ms and returns the data", async () => {
    const clock = makeClock();
    const b = makeBrowser(clock, () => ({ states: [null, STATE] }));
    const h = install(clock, b.launcher);
    const items = await clock.run(render());
    expect(items).toEqual([{ hasApollo: true, __APOLLO_STATE__: STATE }]);
    expect(clock.sleeps).toContain(1_500);
    expect(h.stats().challenged).toBe(0);
  });

  it("still no Apollo data after the re-extraction counts as a challenge", async () => {
    const clock = makeClock();
    const b = makeBrowser(clock, () => ({ states: [null, null] }));
    const h = install(clock, b.launcher);
    await expect(clock.run(render())).rejects.toThrow("lokal webblasare");
    expect(h.stats().challenged).toBe(2);
    expect(clock.sleeps.filter((ms) => ms === 1_500)).toHaveLength(2); // once per attempt
    expect(actorCall).not.toHaveBeenCalled();
  });

  it("a 404 rejects without the 5 000 ms wait and without a retry", async () => {
    const clock = makeClock();
    const b = makeBrowser(clock, () => ({ status: 404 }));
    const h = install(clock, b.launcher);
    await expect(clock.run(render())).rejects.toThrow("lokal webblasare");
    expect(clock.sleeps).not.toContain(5_000);
    expect(b.log.opened).toBe(1);
    expect(h.stats()).toMatchObject({ challenged: 0, retried: 0, failed: 1 });
  });

  it("ChallengeError carries the status and marker", () => {
    const e = new ChallengeError(403, "HTTP 403");
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(403);
    expect(e.marker).toBe("HTTP 403");
  });
});

describe("Booli-only (T-14.2-02)", () => {
  it.each(["https://www.erikolsson.se/x", "http://booli.se/x", "https://evil.example/booli.se/"])(
    "refuses %s before a page opens, and never sends it to Apify even with allowApify",
    async (url) => {
      const clock = makeClock();
      const b = makeBrowser(clock, () => ({}));
      const h = install(clock, b.launcher, { allowApify: true });
      await expect(clock.run(render(url))).rejects.toThrow();
      expect(b.log.opened).toBe(0);
      expect(b.log.launches).toBe(0);
      expect(h.stats().refused).toBe(1);
      expect(actorCall).not.toHaveBeenCalled();
    },
  );
});

describe("broker pages (14.2-06)", () => {
  const BROKER_URL = "https://www.erikolsson.se/objekt/123";
  const renderBroker = (url = BROKER_URL) => runPlaywrightRender(url, BROKER_RENDER_PAGE_FUNCTION);

  it("opens a broker https page when the broker page function is used, counts it as a page, not as refused", async () => {
    const clock = makeClock();
    const b = makeBrowser(clock, () => ({}));
    const h = install(clock, b.launcher);
    const items = await clock.run(renderBroker());
    expect(items).toHaveLength(1);
    expect(b.log.urls).toEqual([BROKER_URL]);
    expect(h.stats()).toMatchObject({ pages: 1, refused: 0, failed: 0, apifyFallbacks: 0 });
  });

  it("still refuses a broker URL with the Booli page function, and an http or look-alike URL with the broker function", async () => {
    const clock = makeClock();
    const b = makeBrowser(clock, () => ({}));
    const h = install(clock, b.launcher, { allowApify: true });
    await expect(clock.run(render(BROKER_URL))).rejects.toThrow();
    await expect(clock.run(renderBroker("http://www.erikolsson.se/x"))).rejects.toThrow();
    await expect(clock.run(renderBroker("file:///etc/passwd"))).rejects.toThrow();
    expect(b.log.opened).toBe(0);
    expect(h.stats().refused).toBe(3);
    expect(actorCall).not.toHaveBeenCalled();
  });

  it("a challenged broker page gets one attempt: no wait, no retry, and never the paid Apify rung", async () => {
    const clock = makeClock();
    const b = makeBrowser(clock, () => ({ status: 403 }));
    const h = install(clock, b.launcher, { allowApify: true });
    await expect(clock.run(renderBroker())).rejects.toThrow("lokal webblasare");
    expect(clock.sleeps).not.toContain(5_000);
    expect(b.log.opened).toBe(1);
    expect(h.stats()).toMatchObject({ challenged: 1, retried: 0, failed: 1, apifyFallbacks: 0 });
    expect(actorCall).not.toHaveBeenCalled();
  });

  it("a failed broker page logs the error name only, never the message (which can carry the URL)", async () => {
    const clock = makeClock();
    const b = makeBrowser(clock, () => ({ status: 500 }));
    install(clock, b.launcher);
    await expect(clock.run(renderBroker("https://user:secret@www.erikolsson.se/objekt/1"))).rejects.toThrow();
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain("secret");
    expect(logged).toContain("broker");
  });

  it("broker pages go through the same two-page gate and pacing as Booli pages", async () => {
    const clock = makeClock();
    const b = makeBrowser(clock, () => ({ durationMs: 100 }));
    install(clock, b.launcher, { random: () => 0 });
    await clock.run(Promise.all([1, 2, 3, 4].map((n) => renderBroker(`https://broker.example/o/${n}`))));
    expect(b.log.maxOpen).toBeLessThanOrEqual(2);
    for (let k = 1; k < b.log.starts.length; k++) expect(b.log.starts[k] - b.log.starts[k - 1]).toBeGreaterThanOrEqual(1_000);
  });
});

describe("pacing and concurrency (D-02, T-14.2-06)", () => {
  it("six concurrent renders: never more than 2 pages open, starts 1 000-2 000 ms apart (instant pages)", async () => {
    const clock = makeClock();
    const b = makeBrowser(clock, () => ({}));
    const rnd = [0, 0.3, 0.9, 1, 0.5, 0.2];
    let i = 0;
    install(clock, b.launcher, { random: () => rnd[i++ % rnd.length] });
    await clock.run(Promise.all(Array.from({ length: 6 }, (_, k) => render(`${BOOLI_URL}&page=${k + 1}`))));
    expect(b.log.starts).toHaveLength(6);
    expect(b.log.maxOpen).toBeLessThanOrEqual(2);
    for (let k = 1; k < b.log.starts.length; k++) {
      const gap = b.log.starts[k] - b.log.starts[k - 1];
      expect(gap).toBeGreaterThanOrEqual(1_000);
      expect(gap).toBeLessThanOrEqual(2_000);
    }
  });

  it("slow pages: concurrency still capped at 2 and starts are never closer than 1 000 ms", async () => {
    const clock = makeClock();
    const b = makeBrowser(clock, () => ({ durationMs: 4_000 }));
    install(clock, b.launcher);
    await clock.run(Promise.all(Array.from({ length: 6 }, (_, k) => render(`${BOOLI_URL}&page=${k + 1}`))));
    expect(b.log.maxOpen).toBe(2);
    for (let k = 1; k < b.log.starts.length; k++) {
      expect(b.log.starts[k] - b.log.starts[k - 1]).toBeGreaterThanOrEqual(1_000);
    }
  });
});

describe("cleanup", () => {
  it("a page whose extraction throws is still closed", async () => {
    const clock = makeClock();
    const b = makeBrowser(clock, () => ({ throwInExtract: true }));
    const h = install(clock, b.launcher);
    await expect(clock.run(render())).rejects.toThrow("lokal webblasare");
    expect(b.log.opened).toBe(b.log.closed);
    expect(h.stats().failed).toBe(1);
  });

  it("close() twice closes the browser once; afterwards runPlaywrightRender REFUSES and never reaches Apify (CR-01)", async () => {
    actorCall.mockResolvedValue({ status: "SUCCEEDED", defaultDatasetId: "ds-1" });
    listItems.mockResolvedValue({ items: [{ hasApollo: true, __APOLLO_STATE__: STATE }] });
    const clock = makeClock();
    const b = makeBrowser(clock, () => ({}));
    const h = install(clock, b.launcher, { allowApify: true });
    await clock.run(render());
    expect(actorCall).not.toHaveBeenCalled();

    await h.close();
    await h.close();
    expect(b.log.browserCloses).toBe(1);
    expect(b.log.contextCloses).toBe(1);

    await expect(render()).rejects.toThrow(CLOSED_RENDERER_MESSAGE);
    await expect(render(`${BOOLI_URL}&page=2`)).rejects.toThrow(CLOSED_RENDERER_MESSAGE);
    expect(actorCall).not.toHaveBeenCalled();
  });

  it("a signal closes the renderer while the pipeline keeps asking: the later renders are refused, not sent to paid Apify (CR-01)", async () => {
    actorCall.mockResolvedValue({ status: "SUCCEEDED", defaultDatasetId: "ds-1" });
    listItems.mockResolvedValue({ items: [{ hasApollo: true, __APOLLO_STATE__: STATE }] });
    const clock = makeClock();
    const b = makeBrowser(clock, () => ({}));
    const h = install(clock, b.launcher, { allowApify: true });
    await clock.run(render());
    const handlers = new Map<string, () => void>();
    const proc = { once: (sig: string, fn: () => void) => void handlers.set(sig, fn), off: vi.fn() };
    // exit never really happens in the test, so the "pipeline" is still running afterwards
    closeOnSignals(h, { proc, exit: vi.fn() });
    handlers.get("SIGTERM")!();
    await expect(render(`${BOOLI_URL}&page=3`)).rejects.toThrow(CLOSED_RENDERER_MESSAGE);
    expect(actorCall).not.toHaveBeenCalled();
  });

  it("relaunches once after the browser disconnects", async () => {
    const clock = makeClock();
    const b = makeBrowser(clock, () => ({}));
    install(clock, b.launcher);
    await clock.run(render());
    b.disconnect();
    await clock.run(render());
    expect(b.log.launches).toBe(2);
  });

  it("closeOnSignals closes the browser on SIGINT / SIGTERM and exits 130 / 143", async () => {
    const clock = makeClock();
    const b = makeBrowser(clock, () => ({}));
    const h = install(clock, b.launcher);
    await clock.run(render());
    const handlers = new Map<string, () => void>();
    const proc = { once: (sig: string, fn: () => void) => void handlers.set(sig, fn), off: vi.fn() };
    const exit = vi.fn();
    const dispose = closeOnSignals(h, { proc, exit });
    expect([...handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
    handlers.get("SIGINT")!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
    expect(b.log.browserCloses).toBe(1);
    handlers.get("SIGTERM")!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
    expect(b.log.browserCloses).toBe(1); // close() is idempotent
    dispose();
    expect(proc.off).toHaveBeenCalled();
  });
});

describe("renderer choice (D-03, R-03)", () => {
  it("the flag beats the environment", () => {
    expect(resolveRendererChoice({ flag: "apify", env: { BOOLI_RENDERER: "local" }, platform: "darwin" })).toEqual({ renderer: "apify" });
  });
  it("the environment is used when there is no flag", () => {
    expect(resolveRendererChoice({ flag: null, env: { BOOLI_RENDERER: "apify" }, platform: "darwin" })).toEqual({ renderer: "apify" });
  });
  it("defaults to local when a display is available", () => {
    expect(resolveRendererChoice({ flag: null, env: {}, platform: "darwin" })).toEqual({ renderer: "local" });
  });
  it("no display and no explicit choice is an error (Swedish), never Apify", () => {
    const r = resolveRendererChoice({ flag: null, env: { SSH_CONNECTION: "1 2 3 4" }, platform: "darwin" });
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(/skärm/);
  });
  it("an unknown value is an error", () => {
    expect(resolveRendererChoice({ flag: "chrome", env: {}, platform: "darwin" })).toHaveProperty("error");
    expect(resolveRendererChoice({ flag: null, env: { BOOLI_RENDERER: "x" }, platform: "darwin" })).toHaveProperty("error");
  });
});

describe("displayAvailable", () => {
  it("darwin without SSH variables is true", () => expect(displayAvailable({}, "darwin")).toBe(true));
  it("darwin with SSH_CONNECTION is false", () => expect(displayAvailable({ SSH_CONNECTION: "a b c d" }, "darwin")).toBe(false));
  it("darwin with SSH_TTY is false", () => expect(displayAvailable({ SSH_TTY: "/dev/ttys001" }, "darwin")).toBe(false));
  it("linux with DISPLAY is true", () => expect(displayAvailable({ DISPLAY: ":0" }, "linux")).toBe(true));
  it("linux with WAYLAND_DISPLAY is true", () => expect(displayAvailable({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(true));
  it("linux without either is false", () => expect(displayAvailable({}, "linux")).toBe(false));
});

// ---------------------------------------------------------------------------
// Static guard: the browser toolchain must never enter the Next.js server graph.
// ---------------------------------------------------------------------------

describe("app tree", () => {
  const IMPORT_FROM_STATEMENT_RE = /^[ \t]*(?:import|export)\s+[\w*\s{},$]*?from\s*["']([^"']+)["']/gm;
  const SIDE_EFFECT_IMPORT_RE = /^[ \t]*import\s*["']([^"']+)["']/gm;
  const DYNAMIC_IMPORT_RE = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;

  function forbidden(specifier: string): boolean {
    return /^playwright(?:-core|-extra)?(?:\/|$)/.test(specifier) || specifier.includes("booli/local-browser");
  }

  function offendingSpecifiers(source: string): string[] {
    const found: string[] = [];
    for (const re of [IMPORT_FROM_STATEMENT_RE, SIDE_EFFECT_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
      for (const m of source.matchAll(re)) if (forbidden(m[1])) found.push(m[1]);
    }
    return found;
  }

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (/\.(?:ts|tsx|js|jsx|mjs)$/.test(name)) out.push(full);
    }
    return out;
  }

  it("the matcher is not inert: it sees static, multi-line, side-effect and dynamic imports", () => {
    expect(offendingSpecifiers('import { chromium } from "playwright";')).toEqual(["playwright"]);
    expect(offendingSpecifiers('import {\n  chromium,\n} from "playwright-core";')).toEqual(["playwright-core"]);
    expect(offendingSpecifiers('export * from "@/lib/booli/local-browser";')).toEqual(["@/lib/booli/local-browser"]);
    expect(offendingSpecifiers('import "playwright/test";')).toEqual(["playwright/test"]);
    expect(offendingSpecifiers('const pw = await import("playwright");')).toEqual(["playwright"]);
    expect(offendingSpecifiers('import { x } from "@/lib/booli/transport";')).toEqual([]);
    expect(offendingSpecifiers("// we never import playwright here")).toEqual([]);
  });

  it("no file under src/app, src/actions or src/components, nor transport.ts or client.ts, imports the browser library or local-browser", () => {
    const files = [
      ...["src/app", "src/actions", "src/components"].flatMap((d) => walk(join(process.cwd(), d))),
      join(process.cwd(), "src/lib/booli/transport.ts"),
      join(process.cwd(), "src/lib/booli/client.ts"),
    ];
    expect(files.length).toBeGreaterThan(10);
    const offenders = files
      .map((f) => ({ f, found: offendingSpecifiers(readFileSync(f, "utf8")) }))
      .filter((x) => x.found.length > 0);
    expect(offenders).toEqual([]);
  });
});
