// @vitest-environment jsdom
import { describe, expect, it, vi, beforeAll } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { DiscoveryResults } from "@/components/discovery-results";
import type { DiscoveryCandidate } from "@/lib/discovery/candidate";
import {
  HOLISTIC_DATA_ONLY_MARKER,
  type HolisticBrief,
} from "@/lib/discovery/holistic-schema";

/**
 * Phase 14 (ANL-01/ANL-04) fixture factory for a `HolisticBrief`, used only
 * to prove `holisticBrief` reaches `GalleryConditionVision` for display and
 * does NOT become a ranking input — mirrors `gallery-condition-vision.test.
 * tsx`'s own `makeHolisticBrief`.
 */
function makeHolisticBrief(overrides: Partial<HolisticBrief> = {}): HolisticBrief {
  return {
    marker: HOLISTIC_DATA_ONLY_MARKER,
    confidence: "low",
    items: [
      {
        kind: "comps-positioning",
        text: "Distinctive holistic brief item text for threading test",
      },
    ],
    dataSources: ["comps"],
    conditionAttribution: {
      explainedPct: null,
      capped: true,
      residualDrivers: ["läge"],
      canAttributeToCondition: false,
      effectivePricePerSqm: 85_000,
      debtIncluded: true,
    },
    ...overrides,
  };
}

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
    balcony: null,
    upcomingSale: null,
    isNewConstruction: null,
    kommun: null,
    areaComps: null,
    brfSummary: null,
    holisticBrief: null,
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

  // todo 007 — the vision/brief section used to render as a list BELOW this
  // grid (with an `mt-6` wrapper this test used to pin). It moved to each
  // candidate's own detail page because, keyed only by array position, it gave
  // the user no way to tell which object an insight belonged to. What matters
  // now is the inverse invariant: the grid renders NO per-candidate AI read.
  it("todo 007: the ranking grid renders no per-candidate AI insight section", () => {
    const candidatesWithBrief = variedCandidates.map((candidate, i) =>
      i === 0
        ? {
            ...candidate,
            visionSkippedReason: "no_images" as const,
            holisticBrief: makeHolisticBrief(),
          }
        : candidate,
    );

    render(<DiscoveryResults candidates={candidatesWithBrief} jobId="job-1" />);

    // The brief text is threaded on the DETAIL page now, never in the grid.
    expect(
      screen.queryByText("Distinctive holistic brief item text for threading test"),
    ).not.toBeInTheDocument();

    const grid = document.querySelector(".grid.grid-cols-1") as HTMLElement;
    expect(grid).toBeTruthy();
    expect(grid.nextElementSibling).toBeNull();
  });

  it("todo 007: each card links to its candidate's detail page by ORIGINAL index, not rank", async () => {
    render(<DiscoveryResults candidates={variedCandidates} jobId="job-1" />);

    const hrefsBefore = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('a[href^="/discover/job-1/"]'),
    ).map((a) => a.getAttribute("href"));
    expect(hrefsBefore).toHaveLength(variedCandidates.length);
    // Unranked: display order == source order.
    expect(hrefsBefore).toEqual(
      variedCandidates.map((_, i) => `/discover/job-1/${i}`),
    );

    // After re-ranking, the DISPLAY order changes but each card must still
    // address its own source index — conflating rank with index here would
    // silently link every card to the wrong object.
    await selectNiche("Renoveringspotential");

    const hrefsAfter = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('a[href^="/discover/job-1/"]'),
    ).map((a) => a.getAttribute("href"));
    expect(hrefsAfter).toHaveLength(variedCandidates.length);
    expect([...hrefsAfter].sort()).toEqual([...hrefsBefore].sort());
    expect(hrefsAfter).not.toEqual(hrefsBefore);
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

  // Phase 14 (ANL-01) — the brief still rides on the candidate; only WHERE it
  // renders changed (todo 007). The candidate reaching the card with its brief
  // intact is what the detail page depends on.
  it("Phase 14 (ANL-01): a candidate carrying a holisticBrief still reaches the grid addressable by index", () => {
    const candidatesWithBrief = variedCandidates.map((candidate, i) =>
      i === 0
        ? {
            ...candidate,
            visionSkippedReason: "no_images" as const,
            holisticBrief: makeHolisticBrief(),
          }
        : candidate,
    );

    render(<DiscoveryResults candidates={candidatesWithBrief} jobId="job-1" />);

    expect(
      document.querySelector('a[href="/discover/job-1/0"]'),
    ).toBeInTheDocument();
  });

  it("Phase 14 (ANL-04): ranking order is unaffected by attaching a holisticBrief to the last-ranked candidate", async () => {
    const { unmount } = render(
      <DiscoveryResults
        candidates={variedCandidates.map((c) => ({ ...c, holisticBrief: null }))}
      />,
    );

    await selectNiche("Inflyttningsklar");
    const gridBefore = document.querySelector(".grid") as HTMLElement;
    const orderBefore = within(gridBefore)
      .getAllByText(/gatan/i)
      .map((el) => el.textContent);

    unmount();

    // Attach the brief to whichever candidate landed LAST in the order
    // just observed — proving the brief is not itself a ranking input,
    // regardless of which candidate it lands on.
    const lastAddress = orderBefore[orderBefore.length - 1];
    const candidatesWithBriefOnLast = variedCandidates.map((c) => ({
      ...c,
      holisticBrief: c.address === lastAddress ? makeHolisticBrief() : null,
    }));

    render(<DiscoveryResults candidates={candidatesWithBriefOnLast} />);
    await selectNiche("Inflyttningsklar");
    const gridAfter = document.querySelector(".grid") as HTMLElement;
    const orderAfter = within(gridAfter)
      .getAllByText(/gatan/i)
      .map((el) => el.textContent);

    expect(orderAfter).toEqual(orderBefore);
  });
});
