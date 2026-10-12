import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resetApifyMock,
  runsList,
  userLimits,
  apifyClientMockFactory,
} from "@/lib/booli/__mocks__/apify-client";

vi.mock("apify-client", () => apifyClientMockFactory());

// Imported AFTER the mock above is registered.
import { apifySpendSince, apifyMonthlyHeadroomUsd } from "@/lib/booli/transport";

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
