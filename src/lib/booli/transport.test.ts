import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  actorCall,
  listItems,
  resetApifyMock,
  runsList,
  userLimits,
  apifyClientMockFactory,
} from "@/lib/booli/__mocks__/apify-client";

vi.mock("apify-client", () => apifyClientMockFactory());

// Imported AFTER the mock above is registered.
import {
  apifySpendSince,
  apifyMonthlyHeadroomUsd,
  formatApifyRunsLine,
  runPlaywrightRender,
  setRenderer,
  usableItems,
  LEDGER_SETTLE_MS,
  RENDER_MEMORY_MB,
  RENDER_TIMEOUT_GRACE_SECS,
} from "@/lib/booli/transport";

const SINCE = new Date("2026-10-12T10:00:00.000Z");

function run(startedAt: Date | string, status: string, usageTotalUsd?: number) {
  return { id: `r-${String(startedAt)}-${status}`, status, startedAt, usageTotalUsd };
}

describe("apifySpendSince", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetApifyMock();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("pages newest-first, sums usageTotalUsd inside the window and stops at the first older run", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) =>
      run(new Date(SINCE.getTime() + 60_000 + i), "SUCCEEDED", 0.01),
    );
    const page2 = [
      run(new Date(SINCE.getTime() + 5_000), "SUCCEEDED", 0.5),
      run(new Date(SINCE.getTime() - 1), "SUCCEEDED", 9), // older -> stop here
      run(new Date(SINCE.getTime() + 1), "SUCCEEDED", 99), // never reached
    ];
    runsList
      .mockResolvedValueOnce({ items: page1, total: 103, offset: 0, limit: 100, count: 100 })
      .mockResolvedValueOnce({ items: page2, total: 103, offset: 100, limit: 100, count: 3 });

    const spend = await apifySpendSince(SINCE);

    expect(runsList).toHaveBeenCalledTimes(2);
    expect(runsList).toHaveBeenNthCalledWith(1, { desc: true, limit: 100, offset: 0 });
    expect(runsList).toHaveBeenNthCalledWith(2, { desc: true, limit: 100, offset: 100 });
    expect(spend).not.toBeNull();
    expect(spend!.usd).toBeCloseTo(100 * 0.01 + 0.5, 9);
    expect(spend!.runs).toBe(101);
  });

  it("does not request a second page when the first already reached an older run", async () => {
    runsList.mockResolvedValueOnce({
      items: [run(new Date(SINCE.getTime() + 1), "SUCCEEDED", 0.1), run(new Date(SINCE.getTime() - 1), "SUCCEEDED", 5)],
      total: 500,
      offset: 0,
      limit: 100,
      count: 2,
    });
    const spend = await apifySpendSince(SINCE);
    expect(runsList).toHaveBeenCalledTimes(1);
    expect(spend!.usd).toBeCloseTo(0.1, 9);
  });

  it("buckets statuses: SUCCEEDED, TIMED-OUT, FAILED+ABORTED, other", async () => {
    const t = new Date(SINCE.getTime() + 1000);
    runsList.mockResolvedValueOnce({
      items: [
        run(t, "SUCCEEDED", 0.036),
        run(t, "SUCCEEDED", 0.036),
        run(t, "TIMED-OUT", 0.059),
        run(t, "FAILED", 0.01),
        run(t, "ABORTED", 0.02),
        run(t, "RUNNING", 0.001),
      ],
      total: 6,
      offset: 0,
      limit: 100,
      count: 6,
    });
    const spend = await apifySpendSince(SINCE);
    expect(spend).toMatchObject({ runs: 6, succeeded: 2, timedOut: 1, failed: 2, other: 1, missingUsage: 0 });
    expect(spend!.usd).toBeCloseTo(0.036 * 2 + 0.059 + 0.01 + 0.02 + 0.001, 9);
  });

  it("counts a run without usageTotalUsd as 0 and increments missingUsage", async () => {
    const t = new Date(SINCE.getTime() + 1000);
    runsList.mockResolvedValueOnce({
      items: [run(t, "SUCCEEDED", undefined), run(t, "SUCCEEDED", 0.04)],
      total: 2,
      offset: 0,
      limit: 100,
      count: 2,
    });
    const spend = await apifySpendSince(SINCE);
    expect(spend!.usd).toBeCloseTo(0.04, 9);
    expect(spend!.missingUsage).toBe(1);
    expect(spend!.succeeded).toBe(2);
  });

  it("accepts startedAt as an ISO string", async () => {
    runsList.mockResolvedValueOnce({
      items: [
        run("2026-10-12T10:00:05.000Z", "SUCCEEDED", 0.03),
        run("2026-10-12T09:59:59.000Z", "SUCCEEDED", 7),
      ],
      total: 2,
      offset: 0,
      limit: 100,
      count: 2,
    });
    const spend = await apifySpendSince(SINCE);
    expect(spend!.usd).toBeCloseTo(0.03, 9);
    expect(spend!.runs).toBe(1);
  });

  it("returns null and logs only the error object when runs().list rejects", async () => {
    const boom = new Error("network down");
    runsList.mockRejectedValueOnce(boom);
    const spend = await apifySpendSince(SINCE);
    expect(spend).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith("[booli-transport] runs list", boom);
  });
});

describe("apifyMonthlyHeadroomUsd", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetApifyMock();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("returns max minus current", async () => {
    userLimits.mockResolvedValueOnce({
      limits: { maxMonthlyUsageUsd: 49 },
      current: { monthlyUsageUsd: 12.5 },
    });
    expect(await apifyMonthlyHeadroomUsd()).toBeCloseTo(36.5, 9);
  });

  it("returns null when the call rejects", async () => {
    userLimits.mockRejectedValueOnce(new Error("401"));
    expect(await apifyMonthlyHeadroomUsd()).toBeNull();
  });

  it("returns null when fields are missing", async () => {
    userLimits.mockResolvedValueOnce({ limits: {}, current: {} });
    expect(await apifyMonthlyHeadroomUsd()).toBeNull();
    userLimits.mockResolvedValueOnce(undefined);
    expect(await apifyMonthlyHeadroomUsd()).toBeNull();
  });
});

describe("renderer seam (Phase 14.2, D-02/D-03)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetApifyMock();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    setRenderer(null);
    errorSpy.mockRestore();
  });

  it("with a renderer installed, runPlaywrightRender calls it and never the Apify actor", async () => {
    const fake = vi.fn().mockResolvedValue([{ hasApollo: true, __APOLLO_STATE__: {} }]);
    setRenderer(fake);
    const items = await runPlaywrightRender("https://www.booli.se/x", "async function pageFunction() {}", { waitSecs: 30 });
    expect(items).toEqual([{ hasApollo: true, __APOLLO_STATE__: {} }]);
    expect(fake).toHaveBeenCalledWith("https://www.booli.se/x", "async function pageFunction() {}", { waitSecs: 30 });
    expect(actorCall).not.toHaveBeenCalled();
  });

  it("after setRenderer(null) the Apify input is unchanged (proxy, retries, memory, timeout)", async () => {
    setRenderer(() => Promise.resolve([]));
    setRenderer(null);
    actorCall.mockResolvedValue({ status: "SUCCEEDED", defaultDatasetId: "ds-1" });
    listItems.mockResolvedValue({ items: [{ hasApollo: true, __APOLLO_STATE__: {} }] });
    await runPlaywrightRender("https://www.booli.se/x", "PF");
    expect(actorCall).toHaveBeenCalledTimes(1);
    const [input, callOpts] = actorCall.mock.calls[0];
    expect(input).toEqual({
      startUrls: [{ url: "https://www.booli.se/x" }],
      launcher: "chromium",
      proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"], apifyProxyCountry: "SE" },
      maxRequestRetries: 3,
      maxPagesPerCrawl: 1,
      pageFunction: "PF",
    });
    expect(callOpts).toEqual({
      waitSecs: 240,
      log: null,
      memory: RENDER_MEMORY_MB,
      timeout: 240 + RENDER_TIMEOUT_GRACE_SECS,
    });
  });
});

describe("usableItems (HIGH-1, shared by every renderer)", () => {
  it("throws the Swedish no-results message for []", () => {
    expect(() => usableItems([])).toThrow("Inga resultat fran Booli-kallan");
  });
  it("throws the Swedish no-Apollo message when every item has hasApollo false", () => {
    expect(() => usableItems([{ hasApollo: false }, { hasApollo: false }])).toThrow(
      "Booli-kallan returnerade ingen Apollo-data (hasApollo=false)",
    );
  });
  it("keeps items without the flag and with hasApollo true", () => {
    const items = [{ hasApollo: true }, { html: "x" }, { hasApollo: false }];
    expect(usableItems(items)).toEqual([{ hasApollo: true }, { html: "x" }]);
  });
});

describe("runs-API line (W4: the one pinned ledger format)", () => {
  const zero = { usd: 0, runs: 0, succeeded: 0, timedOut: 0, failed: 0, other: 0, missingUsage: 0 };

  it("a zero bill is exactly the pinned string", () => {
    expect(formatApifyRunsLine(zero)).toBe("Apify (runs-API): 0,00 USD, 0 körningar (0 lyckade, 0 timeout, 0 misslyckade)");
  });

  it("a real bill uses two decimals and a decimal comma", () => {
    expect(formatApifyRunsLine({ ...zero, usd: 0.0549, runs: 2, succeeded: 1, timedOut: 1 })).toBe(
      "Apify (runs-API): 0,05 USD, 2 körningar (1 lyckade, 1 timeout, 0 misslyckade)",
    );
  });

  it("an unreadable bill reports the reason", () => {
    expect(formatApifyRunsLine(null, "APIFY_API_TOKEN saknas")).toBe("Apify (runs-API): kunde inte läsas (APIFY_API_TOKEN saknas)");
    expect(formatApifyRunsLine(null)).toBe("Apify (runs-API): kunde inte läsas");
  });

  it("never has a decimal point in the amount and never starts with a space", () => {
    for (const line of [formatApifyRunsLine({ ...zero, usd: 12.3456, runs: 3 }), formatApifyRunsLine(zero), formatApifyRunsLine(null, "x")]) {
      expect(line.startsWith(" ")).toBe(false);
      expect(line).not.toMatch(/\d\.\d/);
    }
  });
});

describe("ledger settle delay (WR-05)", () => {
  it("is one shared 10 000 ms constant", () => {
    expect(LEDGER_SETTLE_MS).toBe(10_000);
  });
});
