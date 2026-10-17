// @vitest-environment node
import { describe, expect, it } from "vitest";
import snapshotJson from "@/lib/discovery/__fixtures__/forsale-snapshot.fixture.json";
import modelJson from "@/lib/discovery/__fixtures__/hedonic-model.fixture.json";
import { computeCoverage, renderCoverage } from "@/lib/discovery/fit-pipeline";
import { fitScore, parseFitSnapshot, type FitInputRow } from "@/lib/discovery/fit-score";
import { parseHedonicModel } from "@/lib/discovery/hedonic-model";
import { LAYOUT_INFLUENCE_ENABLED, type LayoutFact } from "@/lib/discovery/layout-fact";

/**
 * With the production setting (LAYOUT_INFLUENCE_ENABLED false, Daniel 2026-10-17, UAT 14.4 items 4-5) a confident
 * layout read must change nothing in the score, while the coverage line still counts what the read found and
 * says that it does not affect the score. This file does NOT mock layout-fact.
 */
const model = parseHedonicModel(modelJson);
const snapshot = parseFitSnapshot(snapshotJson);

const confidentFact: LayoutFact = {
  balconySide: "courtyard", livingOnBalconySide: true, kitchenOnBalconySide: true, bedroomOnBalconySide: true,
  windowSides: "twoOpposite", bedroomSide: "courtyard", streetEvidence: "courtyardGreenery", confidence: 0.95,
  source: "planritning+foto", version: "v", images: { booli: 4, broker: 0 },
};

describe("layout influence switched off", () => {
  it("is off", () => {
    expect(LAYOUT_INFLUENCE_ENABLED).toBe(false);
  });

  it("a confident layout scores exactly like no layout, and never applies to the sun", () => {
    const row = snapshot.rows[0] as FitInputRow;
    const without = fitScore({ ...row, layout: null }, model);
    const withLayout = fitScore({ ...row, layout: confidentFact }, model);
    expect(withLayout.layoutAppliedToSun).toBe(false);
    expect(withLayout.tasteSek).toBe(without.tasteSek);
    expect(withLayout.profitSek).toBe(without.profitSek);
  });

  it("the coverage line counts what the read found and carries the no-influence suffix", () => {
    const row = { ...(snapshot.rows[0] as FitInputRow), layout: confidentFact };
    const c = computeCoverage([row]);
    expect(c.layout).toMatchObject({ read: 1, balcony: 1, windowSides: 1, bedroom: 1 });
    const line = renderCoverage(c).split("\n")[1];
    expect(line.startsWith("Planlösning: balkongsida 1, korsdrag känt 1, sovrumssida 1, sol från planlösning ")).toBe(true);
    expect(line.endsWith(" (påverkar ej poängen)")).toBe(true);
  });
});
