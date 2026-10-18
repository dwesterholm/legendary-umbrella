import { describe, expect, it } from "vitest";
import { assertDryRunCacheNotLive, dryRunCacheDir } from "@/lib/stockholm/dry-run-cache";

const LIVE = ".planning/calibration/data/bygglov";

describe("dryRunCacheDir (WR-05: a dry run never writes to the live sweep cache)", () => {
  it("without --cache-dir it is a directory inside the throw-away folder, never the live one", () => {
    const dir = dryRunCacheDir({ requested: null, liveDir: LIVE, tempDir: "/tmp/bygglov-sweep-dry-abc" });
    expect(dir).toBe("/tmp/bygglov-sweep-dry-abc/cache");
  });

  it("refuses the live cache however it is spelled, a folder inside it, and a folder that contains it", () => {
    for (const bad of [LIVE, `${LIVE}/`, `./${LIVE}`, `${LIVE}/sweep`, ".planning/calibration/data", ".planning/calibration", `${process.cwd()}/${LIVE}`]) {
      expect(() => dryRunCacheDir({ requested: bad, liveDir: LIVE, tempDir: "/tmp/x" }), bad).toThrow(/skarpa cachen/);
      expect(() => assertDryRunCacheNotLive(bad, LIVE), bad).toThrow(/skarpa cachen/);
    }
  });

  it("accepts a sibling folder whose name merely starts the same way (bygglov-dry)", () => {
    expect(dryRunCacheDir({ requested: ".planning/calibration/data/bygglov-dry", liveDir: LIVE, tempDir: "/tmp/x" })).toBe(
      ".planning/calibration/data/bygglov-dry",
    );
  });
});
