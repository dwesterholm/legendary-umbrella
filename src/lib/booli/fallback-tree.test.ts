import { describe, it, expect, vi, afterEach } from "vitest";
import { walkFallbackTree } from "@/lib/booli/fallback-tree";

/**
 * Pure-function tests for walkFallbackTree (ACQ-03). No ApifyClient mock is
 * needed here — rungs are injected fakes (05-PATTERNS.md), matching the
 * "pure function, inject fake attempt() functions" test style RESEARCH.md
 * prescribes for the fallback tree specifically.
 */
describe("walkFallbackTree", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns rung 1 result with health ok when rung 1 succeeds", async () => {
    const rung1 = vi.fn().mockResolvedValue("data-1");
    const result = await walkFallbackTree([
      { source: "own-playwright", attempt: rung1 },
    ]);
    expect(result).toEqual({
      data: "data-1",
      source: "own-playwright",
      rung: 1,
      health: "ok",
    });
    expect(rung1).toHaveBeenCalledTimes(1);
  });

  it("falls through to rung 2 on rung 1 throw, returns degraded health", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rung1 = vi.fn().mockRejectedValue(new Error("rung1 fail"));
    const rung2 = vi.fn().mockResolvedValue("data-2");

    const result = await walkFallbackTree([
      { source: "own-playwright", attempt: rung1 },
      { source: "own-playwright-retry", attempt: rung2 },
    ]);

    expect(result).toEqual({
      data: "data-2",
      source: "own-playwright-retry",
      rung: 2,
      health: "degraded",
    });
    expect(rung1).toHaveBeenCalledTimes(1);
    expect(rung2).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "[booli-client] rung 1 (own-playwright) failed",
      expect.any(Error),
    );
  });

  it("falls through to rung 3 when rungs 1 and 2 both throw, returns degraded health", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rung1 = vi.fn().mockRejectedValue(new Error("rung1 fail"));
    const rung2 = vi.fn().mockRejectedValue(new Error("rung2 fail"));
    const rung3 = vi.fn().mockResolvedValue("data-3");

    const result = await walkFallbackTree([
      { source: "own-playwright", attempt: rung1 },
      { source: "own-playwright-retry", attempt: rung2 },
      { source: "paid-actor", attempt: rung3 },
    ]);

    expect(result).toEqual({
      data: "data-3",
      source: "paid-actor",
      rung: 3,
      health: "degraded",
    });
    expect(rung1).toHaveBeenCalledTimes(1);
    expect(rung2).toHaveBeenCalledTimes(1);
    expect(rung3).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "[booli-client] rung 1 (own-playwright) failed",
      expect.any(Error),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "[booli-client] rung 2 (own-playwright-retry) failed",
      expect.any(Error),
    );
  });

  it("throws when all rungs fail (HIGH-1: never silently returns empty)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rung1 = vi.fn().mockRejectedValue(new Error("rung1 fail"));
    const rung2 = vi.fn().mockRejectedValue(new Error("rung2 fail"));
    const rung3 = vi.fn().mockRejectedValue(new Error("rung3 fail"));

    await expect(
      walkFallbackTree([
        { source: "own-playwright", attempt: rung1 },
        { source: "own-playwright-retry", attempt: rung2 },
        { source: "paid-actor", attempt: rung3 },
      ]),
    ).rejects.toThrow(/Alla Booli-kallor misslyckades/);

    expect(rung1).toHaveBeenCalledTimes(1);
    expect(rung2).toHaveBeenCalledTimes(1);
    expect(rung3).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "[booli-client] rung 3 (paid-actor) failed",
      expect.any(Error),
    );
  });

  it("throws with the HIGH-1 message even for a single-rung all-fail tree", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = vi.fn().mockRejectedValue(new Error("dead"));

    await expect(
      walkFallbackTree([{ source: "own-playwright", attempt: failing }]),
    ).rejects.toThrow(/Alla Booli-kallor misslyckades/);

    expect(errorSpy).toHaveBeenCalledWith(
      "[booli-client] rung 1 (own-playwright) failed",
      expect.any(Error),
    );
  });

  it("rejects a 4th+ rung loudly at runtime instead of silently mis-labeling `rung` (IN-04)", async () => {
    const rung = vi.fn().mockResolvedValue("data");

    await expect(
      walkFallbackTree([
        { source: "own-playwright", attempt: rung },
        { source: "own-playwright-retry", attempt: rung },
        { source: "paid-actor", attempt: rung },
        { source: "paid-actor", attempt: rung },
      ]),
    ).rejects.toThrow(/at most 3 rungs/);

    expect(rung).not.toHaveBeenCalled();
  });
});
