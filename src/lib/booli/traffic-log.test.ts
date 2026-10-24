// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BOOLI_TRAFFIC_LOG, recordBooliRefusal, refusalLine } from "@/lib/booli/traffic-log";

const AT = new Date("2026-10-26T07:12:03.456Z");
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("traffic log refusal line (CR-01)", () => {
  it("is the exact line booli-gate.mjs --refused writes, without milliseconds", () => {
    expect(refusalLine("weekly-live", AT)).toBe("2026-10-26T07:12:03Z refused weekly-live");
  });

  it("rejects a label the gate would reject (no URL or free text can enter the log)", () => {
    expect(refusalLine("https://www.booli.se/x", AT)).toBeNull();
    expect(refusalLine("Weekly Live", AT)).toBeNull();
    expect(refusalLine("", AT)).toBeNull();
  });

  it("appends to a file in a directory it creates, and a second refusal adds a second line", () => {
    const dir = mkdtempSync(join(tmpdir(), "traffic-log-"));
    dirs.push(dir);
    const path = join(dir, "nested", "traffic.log");
    expect(recordBooliRefusal("weekly-live", { path, now: () => AT })).toBe(true);
    expect(recordBooliRefusal("weekly-live", { path, now: () => new Date("2026-10-27T07:00:00Z") })).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("2026-10-26T07:12:03Z refused weekly-live\n2026-10-27T07:00:00Z refused weekly-live\n");
  });

  it("never throws: a failing write returns false", () => {
    const ok = recordBooliRefusal("weekly-live", {
      path: "x",
      now: () => AT,
      append: () => {
        throw new Error("disk full");
      },
    });
    expect(ok).toBe(false);
  });

  it("the default path is the gitignored calibration data log the gate reads", () => {
    expect(BOOLI_TRAFFIC_LOG).toBe(".planning/calibration/data/booli-traffic-14.5.log");
  });
});
