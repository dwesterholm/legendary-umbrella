import { describe, it, expect } from "vitest";
import { resolveAreaId, type SoldSourceQuery } from "@/lib/market/sold-source";

// The live Södermalm breadcrumb ladder (wide→narrow). Each crumb carries its
// areaId in the url; the final BRF crumb has none. (Real /bostad/305443 scrape.)
const sodermalmCrumbs = [
  { label: "Stockholms län", url: "https://www.booli.se/sok/slutpriser?areaIds=2" },
  { label: "Stockholms kommun", url: "https://www.booli.se/sok/slutpriser?areaIds=1" },
  { label: "Södermalm", url: "https://www.booli.se/sok/slutpriser?areaIds=115341" },
  { label: "Helgagatan", url: "https://www.booli.se/sok/slutpriser?areaIds=102186" },
  { label: "BRF Helga", url: "https://www.booli.se/bostad/305443" },
];

const q = (
  tier: SoldSourceQuery["tier"],
  breadcrumbs: SoldSourceQuery["breadcrumbs"],
): SoldSourceQuery => ({
  lat: 59.3089341,
  lng: 18.06933923,
  booliId: "305443",
  breadcrumbs,
  tier,
});

describe("resolveAreaId — D-01 tier → Booli areaId mapping", () => {
  it("maps building to the narrowest area (street/BRF-area level)", () => {
    expect(resolveAreaId(q("building", sodermalmCrumbs))).toBe("102186");
  });

  it("maps neighborhood to the neighborhood crumb (Södermalm 115341), NOT the street (regression: both used to collapse onto the street → dense neighborhood never queried → false 'thin')", () => {
    expect(resolveAreaId(q("neighborhood", sodermalmCrumbs))).toBe("115341");
  });

  it("maps wide to the kommun level (1)", () => {
    expect(resolveAreaId(q("wide", sodermalmCrumbs))).toBe("1");
  });

  it("all three tiers resolve to DISTINCT areaIds for a full ladder", () => {
    const b = resolveAreaId(q("building", sodermalmCrumbs));
    const n = resolveAreaId(q("neighborhood", sodermalmCrumbs));
    const w = resolveAreaId(q("wide", sodermalmCrumbs));
    expect(new Set([b, n, w]).size).toBe(3);
  });

  it("is robust for a short [kommun, street] ladder (no crash, every tier resolves)", () => {
    const shortCrumbs = [
      { label: "Stockholms kommun", url: "https://www.booli.se/sok/slutpriser?areaIds=1" },
      { label: "Some street", url: "https://www.booli.se/sok/slutpriser?areaIds=999" },
    ];
    expect(resolveAreaId(q("building", shortCrumbs))).toBe("999");
    expect(resolveAreaId(q("neighborhood", shortCrumbs))).toBe("1");
    expect(resolveAreaId(q("wide", shortCrumbs))).toBe("1");
  });

  it("returns null when no crumb carries an areaId (caller throws — HIGH-1)", () => {
    expect(
      resolveAreaId(q("neighborhood", [{ label: "BRF only", url: "https://www.booli.se/bostad/1" }])),
    ).toBeNull();
    expect(resolveAreaId(q("wide", null))).toBeNull();
  });
});
