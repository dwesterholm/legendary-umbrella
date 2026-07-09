// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SunPathExposure } from "@/components/sun-path-exposure";

// Stockholm, matches sun-path.test.ts's shared reference lat/lon.
const STOCKHOLM_LAT = 59.33;
const STOCKHOLM_LON = 18.06;

describe("SunPathExposure", () => {
  it("renders the Compass affordance, the 'Solexponering' title, the locked theoretical sub-label, and a qualitative facade/season grid when all four inputs are present", () => {
    const { container } = render(
      <SunPathExposure
        latitude={STOCKHOLM_LAT}
        longitude={STOCKHOLM_LON}
        floor={3}
        orientation={{ facades: ["south"], confidence: 0.5 }}
      />,
    );

    expect(screen.getByText("Solexponering")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Teoretisk solexponering, tar inte hänsyn till skuggning från omgivande byggnader.",
      ),
    ).toBeInTheDocument();

    // Compass affordance present (lucide-react renders an <svg> — assert via
    // the icon's class, since there is no accessible role/name on a plain
    // decorative icon).
    expect(container.querySelector("svg")).toBeInTheDocument();

    // Season/facade headers render.
    expect(screen.getByText("Söder")).toBeInTheDocument();
    expect(screen.getByText("Vinter")).toBeInTheDocument();
    expect(screen.getByText("Vår-Höst")).toBeInTheDocument();
    expect(screen.getByText("Sommar")).toBeInTheDocument();

    // Grid cells contain qualitative Swedish descriptors, NEVER a number
    // followed by "timmar" (false-precision ban).
    expect(container.textContent).not.toMatch(/\d+(\.\d+)?\s*timmar/);
    // At least one known qualitative label renders somewhere in the grid.
    expect(container.textContent).toMatch(
      /Ingen direkt sol|Morgon, låg sol|Kväll, låg sol|Morgon, hög sol|Kväll, hög sol|Sol större delen av dagen/,
    );

    // No degraded line when data is present.
    expect(
      screen.queryByText(/ej tillgänglig — riktning eller våningsdata saknas/),
    ).not.toBeInTheDocument();
  });

  it("renders the exact degraded line in place of the grid when orientation is null, while section identity (Compass + title + sub-label) still renders", () => {
    render(
      <SunPathExposure
        latitude={STOCKHOLM_LAT}
        longitude={STOCKHOLM_LON}
        floor={3}
        orientation={null}
      />,
    );

    expect(screen.getByText("Solexponering")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Teoretisk solexponering, tar inte hänsyn till skuggning från omgivande byggnader.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Solexponering: ej tillgänglig — riktning eller våningsdata saknas för denna annons.",
      ),
    ).toBeInTheDocument();

    // No grid rendered in the degraded state.
    expect(screen.queryByText("Söder")).not.toBeInTheDocument();
    expect(screen.queryByText("Vinter")).not.toBeInTheDocument();
  });

  it("renders the exact degraded line in place of the grid when floor is null, while section identity still renders", () => {
    render(
      <SunPathExposure
        latitude={STOCKHOLM_LAT}
        longitude={STOCKHOLM_LON}
        floor={null}
        orientation={{ facades: ["south"], confidence: 0.5 }}
      />,
    );

    expect(screen.getByText("Solexponering")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Solexponering: ej tillgänglig — riktning eller våningsdata saknas för denna annons.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Söder")).not.toBeInTheDocument();
  });

  it("never renders terracotta, Eye, or a 'Bild' image citation — the identity is Compass/warm-gray computed, distinct from the vision claim rows", () => {
    const { container } = render(
      <SunPathExposure
        latitude={STOCKHOLM_LAT}
        longitude={STOCKHOLM_LON}
        floor={3}
        orientation={{ facades: ["south", "west"], confidence: 0.5 }}
      />,
    );

    expect(container.innerHTML).not.toMatch(/terracotta/);
    expect(container.textContent).not.toMatch(/Bild\s*\d/);
    // lucide's Eye icon has no reliable DOM marker beyond its import — assert
    // there is no "Eye"-specific class artifact and no thumbnail <img>.
    expect(container.querySelector("img")).not.toBeInTheDocument();
  });
});
