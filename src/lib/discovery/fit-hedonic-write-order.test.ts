// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Review 14.5 WR-07: `scripts/fit-hedonic.ts` defaults --out to the committed model. Everything that can refuse a run (the
 * stage-2 measurement for --report-json, the report schema) must come BEFORE the model is written, or an exit 1 leaves the
 * committed model replaced. The script runs at import time, so this pins the order in its source.
 */
describe("fit-hedonic.ts: nothing that can refuse the run comes after the model write (WR-07)", () => {
  const source = readFileSync(join(process.cwd(), "scripts/fit-hedonic.ts"), "utf-8");
  const at = (needle: string): number => {
    const i = source.indexOf(needle);
    expect(i, needle).toBeGreaterThan(-1);
    return i;
  };

  // The graft path has its own earlier write; the fit path's model write is the last one in the file.
  const fitModelWrite = (): number => {
    const i = source.lastIndexOf("writeTextAtomic(outPath,");
    expect(i).toBeGreaterThan(-1);
    return i;
  };

  it("the stage-2 check and the report schema are applied before the fit's writeTextAtomic(outPath, ...)", () => {
    const modelWrite = fitModelWrite();
    expect(at('throw new Error("--report-json: ingen steg-2-mätning')).toBeLessThan(modelWrite);
    expect(at("fitReportJsonSchema.parse(payload)")).toBeLessThan(modelWrite);
  });

  it("the report file is written after the model and from the text validated earlier", () => {
    expect(at("writeTextAtomic(reportJsonPath, reportText)")).toBeGreaterThan(fitModelWrite());
  });

  it("the header names the default --out as the committed model", () => {
    expect(source).toContain("REPLACES the committed model data/hedonic-model.json");
  });
});
