// @vitest-environment jsdom
import { describe, expect, it, vi, beforeAll } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { DiscoveryResults } from "@/components/discovery-results";
import type { DiscoveryCandidate } from "@/lib/discovery/candidate";

// jsdom does not implement these DOM APIs that Radix UI's Select relies on
// for scroll/pointer-capture handling. This is the first Select-driven RTL
// test in the codebase (Phase 9's filter Select has no component test) —
// polyfill locally rather than touching the shared vitest.setup.ts.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
});

function makeCandidate(overrides: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate {
  return {
    address: "Testgatan 1",
    price: 3_000_000,
    rooms: 2,
    livingArea: 50,
    areaLabel: "Testomrade",
    thumbnailUrl: null,
    sourceListingUrl: "https://www.booli.se/annons/1",
    constructionYear: null,
    brfName: null,
    tenureForm: null,
    imageUrls: null,
    vision: null,
    visionSkippedReason: null,
    latitude: null,
    longitude: null,
    floor: null,
    orientation: null,
    ...overrides,
  };
}

const variedCandidates: DiscoveryCandidate[] = [
  makeCandidate({
    address: "Gammal Billig-gatan 1",
    sourceListingUrl: "https://www.booli.se/annons/old-cheap",
    constructionYear: 1962,
    price: 1_800_000,
    livingArea: 50,
    tenureForm: "Bostadsrätt",
  }),
  makeCandidate({
    address: "Ny Snygg-gatan 2",
    sourceListingUrl: "https://www.booli.se/annons/new-average",
    constructionYear: 2021,
    price: 3_000_000,
    livingArea: 50,
    tenureForm: "Bostadsrätt",
  }),
  makeCandidate({
    address: "Mellan-gatan 3",
    sourceListingUrl: "https://www.booli.se/annons/mid-expensive",
    constructionYear: 1995,
    price: 4_000_000,
    livingArea: 50,
    tenureForm: "Äganderätt",
  }),
  makeCandidate({
    address: "Mycket Gammal-gatan 4",
    sourceListingUrl: "https://www.booli.se/annons/very-old-expensive",
    constructionYear: 1930,
    price: 5_000_000,
    livingArea: 50,
    tenureForm: "Äganderätt",
  }),
];

async function selectNiche(label: string) {
  const trigger = screen.getByRole("combobox");
  fireEvent.click(trigger);
  const option = await screen.findByRole("option", { name: label });
  fireEvent.click(option);
}

describe("DiscoveryResults", () => {
  it("renders initial 'none' order with no rank badges", () => {
    render(<DiscoveryResults candidates={variedCandidates} />);

    expect(screen.queryByText(/^#\d+$/)).not.toBeInTheDocument();
    const addresses = screen.getAllByText(/gatan/i).map((el) => el.textContent);
    expect(addresses[0]).toBe("Gammal Billig-gatan 1");
  });

  it("switching niche visibly reorders cards with no network/action call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    render(<DiscoveryResults candidates={variedCandidates} />);

    await selectNiche("Inflyttningsklar");
    const grid = document.querySelector(".grid") as HTMLElement;
    const turnkeyFirstAddress = within(grid).getAllByText(/gatan/i)[0].textContent;

    await selectNiche("Stambyte planerat — föreningen betalar");
    const stambyteFirstAddress = within(grid).getAllByText(/gatan/i)[0].textContent;

    expect(turnkeyFirstAddress).not.toBe(stambyteFirstAddress);
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("shows the terracotta degenerate banner and no rank badges with only 2 candidates", async () => {
    const twoCandidates = variedCandidates.slice(0, 2);
    render(<DiscoveryResults candidates={twoCandidates} />);

    await selectNiche("Renoveringspotential");

    expect(
      screen.getByText(
        "För få träffar för att rangordna meningsfullt — visar dem i ursprunglig ordning.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^#\d+$/)).not.toBeInTheDocument();
  });

  it("WR-01 regression: surfaces a thin-baseline caption for renovation-upside when isDegenerate is false but the price/sqm baseline sample is too small", async () => {
    // 3 total candidates (>= MIN_RANKABLE_CANDIDATES, so isDegenerate is
    // false and ranking proceeds), but only 1 has a usable price+livingArea
    // pair (< MIN_BASELINE_SAMPLE), so computeAreaBaseline returns null and
    // renovation-upside's pricePerSqmVsBaseline signal is unassessable for
    // every candidate — this must be surfaced, not silently inferred.
    const thinBaselineCandidates: DiscoveryCandidate[] = [
      makeCandidate({
        sourceListingUrl: "https://www.booli.se/annons/has-price",
        constructionYear: 1962,
        price: 2_000_000,
        livingArea: 50,
      }),
      makeCandidate({
        sourceListingUrl: "https://www.booli.se/annons/no-price-1",
        constructionYear: 1970,
        price: null,
        livingArea: null,
      }),
      makeCandidate({
        sourceListingUrl: "https://www.booli.se/annons/no-price-2",
        constructionYear: 1990,
        price: null,
        livingArea: null,
      }),
    ];

    render(<DiscoveryResults candidates={thinBaselineCandidates} />);

    await selectNiche("Renoveringspotential");

    expect(
      screen.getByText(
        /Prisjämförelse saknas för denna sökning/,
      ),
    ).toBeInTheDocument();
    // Ranking still proceeds — rank badges appear, no degenerate banner.
    expect(screen.getAllByText(/^#\d+$/).length).toBeGreaterThan(0);
    expect(
      screen.queryByText(
        "För få träffar för att rangordna meningsfullt — visar dem i ursprunglig ordning.",
      ),
    ).not.toBeInTheDocument();
  });

  it("11-REVIEW.md WR-01: the vision section wrapper carries mt-6 so the grid<->vision gap is the required minimum 24px, not the outer container's 16px space-y-4", () => {
    render(<DiscoveryResults candidates={variedCandidates} />);

    const grid = document.querySelector(".grid.grid-cols-1") as HTMLElement;
    expect(grid).toBeTruthy();
    // The vision wrapper is the grid's very next sibling — both are direct
    // children of the outer space-y-4 container. Without mt-6, the gap
    // between them would silently fall back to that outer 16px space-y-4
    // instead of the UI-SPEC's required minimum 24px visual break.
    const visionWrapper = grid.nextElementSibling as HTMLElement;
    expect(visionWrapper).toBeTruthy();
    expect(visionWrapper.className).toContain("mt-6");
    expect(visionWrapper.className).toContain("space-y-6");
  });

  it("degrades to the unranked grid with an error banner when scoring throws", async () => {
    // A candidate whose livingArea is 0 combined with malformed downstream
    // state cannot itself throw computeNicheScore (it's null-safe by
    // design) — force the failure mode by mocking the scorer module.
    vi.resetModules();
    vi.doMock("@/lib/discovery/niche-score", async () => {
      const actual = await vi.importActual<typeof import("@/lib/discovery/niche-score")>(
        "@/lib/discovery/niche-score",
      );
      return {
        ...actual,
        computeNicheScore: () => {
          throw new Error("forced scorer failure");
        },
      };
    });

    const { DiscoveryResults: MockedDiscoveryResults } = await import(
      "@/components/discovery-results"
    );

    render(<MockedDiscoveryResults candidates={variedCandidates} />);

    await selectNiche("Renoveringspotential");

    expect(
      screen.getByText(
        "Rangordningen kunde inte beräknas just nu. Kandidaterna visas i ursprunglig ordning.",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/gatan/i)).toHaveLength(variedCandidates.length);

    vi.doUnmock("@/lib/discovery/niche-score");
    vi.resetModules();
  });
});
