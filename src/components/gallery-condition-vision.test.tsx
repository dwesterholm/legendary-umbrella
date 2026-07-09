// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { GalleryConditionVision } from "@/components/gallery-condition-vision";
import type { VisionResult } from "@/lib/discovery/vision-schema";

function makeVision(overrides: Partial<VisionResult> = {}): VisionResult {
  return {
    claims: [
      {
        attribute: "kitchen",
        claim: "Köket verkar renoverat",
        imageIndex: 2,
        whatWasSeen: "nya vitvaror, kaklat stänkskydd",
        confidence: 0.8,
      },
    ],
    imageUrlsUsed: [
      "https://cdn.booli.se/img1.jpg",
      "https://cdn.booli.se/img2.jpg",
    ],
    model: "claude-sonnet-4-6",
    costSek: 0.42,
    ranAt: "2026-07-07T12:00:00Z",
    ...overrides,
  };
}

const DEFAULT_SUN_PROPS = {
  latitude: null,
  longitude: null,
  floor: null,
  orientation: null,
};

describe("GalleryConditionVision", () => {
  it("always renders the Eye/terracotta identity header and locked title", () => {
    render(
      <GalleryConditionVision
        vision={null}
        visionSkippedReason="no_images"
        {...DEFAULT_SUN_PROPS}
      />,
    );

    expect(
      screen.getByText("AI-bedömning av bilder — kan vara fel"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Tolkat från bilder i annonsen/),
    ).toBeInTheDocument();
  });

  it("renders a claim row with hedged text, 'Bild n' citation, and a resolved thumbnail", () => {
    render(
      <GalleryConditionVision
        vision={makeVision()}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
      />,
    );

    expect(screen.getByText("Köket verkar renoverat")).toBeInTheDocument();
    expect(screen.getByText("KÖK")).toBeInTheDocument();
    expect(screen.getAllByText("Bild 2").length).toBeGreaterThan(0);

    const thumbnail = screen.getByAltText("Bild 2") as HTMLImageElement;
    expect(thumbnail.src).toBe("https://cdn.booli.se/img2.jpg");

    // Closing disclaimer present whenever at least one claim renders.
    expect(
      screen.getByText(/Kan vara fel — dessa bedömningar är AI:ns tolkning/),
    ).toBeInTheDocument();
  });

  it("falls back to a text 'Bild {n}' label (never a broken-image icon) when the cited image URL cannot be resolved", () => {
    const vision = makeVision({
      claims: [
        {
          attribute: "bathroom",
          claim: "Badrummet ser omodernt ut",
          imageIndex: 9, // out of range for imageUrlsUsed (length 2)
          whatWasSeen: "gammalt kakel",
          confidence: 0.7,
        },
      ],
    });

    render(
      <GalleryConditionVision
        vision={vision}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
      />,
    );

    expect(screen.getByText("Badrummet ser omodernt ut")).toBeInTheDocument();
    // Citation still present as text, never omitted.
    expect(screen.getAllByText("Bild 9").length).toBeGreaterThan(0);
    // No <img> element rendered for this claim's fallback.
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders the distinct 'no_images' empty state copy", () => {
    render(
      <GalleryConditionVision
        vision={null}
        visionSkippedReason="no_images"
        {...DEFAULT_SUN_PROPS}
      />,
    );

    expect(
      screen.getByText(
        "Inga bilder tillgängliga för den här annonsen — ingen bildbedömning kunde göras.",
      ),
    ).toBeInTheDocument();
  });

  it("renders the distinct 'cost_cap' skipped state copy (never collapsed with no_images)", () => {
    render(
      <GalleryConditionVision
        vision={null}
        visionSkippedReason="cost_cap"
        {...DEFAULT_SUN_PROPS}
      />,
    );

    expect(
      screen.getByText(
        "Bildbedömning kördes inte för den här annonsen (sökgränsen för bildanalys nåddes).",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Inga bilder tillgängliga/),
    ).not.toBeInTheDocument();
  });

  it("renders the distinct 'vision_error' skipped state copy (CR-02, never collapsed with no_images/cost_cap)", () => {
    render(
      <GalleryConditionVision
        vision={null}
        visionSkippedReason="vision_error"
        {...DEFAULT_SUN_PROPS}
      />,
    );

    expect(
      screen.getByText(
        "Bildbedömning kunde inte genomföras för den här annonsen just nu.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Inga bilder tillgängliga/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/sökgränsen för bildanalys nåddes/),
    ).not.toBeInTheDocument();
  });

  it("renders the distinct low-confidence-suppressed state when vision ran but every claim was dropped", () => {
    render(
      <GalleryConditionVision
        vision={makeVision({ claims: [] })}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
      />,
    );

    expect(
      screen.getByText(
        "För osäkert för att visa — inga bildbaserade slutsatser kunde dras med rimlig säkerhet.",
      ),
    ).toBeInTheDocument();
  });

  it("never uses severityChip/sage/destructive vocabulary", () => {
    const { container } = render(
      <GalleryConditionVision
        vision={makeVision()}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
      />,
    );

    expect(container.innerHTML).not.toMatch(/sage-/);
    expect(container.innerHTML).not.toMatch(/destructive/);
  });

  it("renders a remodelPotential claim as a PLANLÖSNING row, cited to its floor-plan image, in the same row shell as kitchen/bathroom/overall", () => {
    const vision = makeVision({
      claims: [
        {
          attribute: "remodelPotential",
          claim:
            "Planlösningen antyder att väggen mellan kök och vardagsrum eventuellt skulle kunna öppnas upp — kräver konstruktör / väggutredning för att avgöra. Detta är endast ett underlag för vidare utredning — kräver konstruktör/väggutredning för att avgöra bärande väggar.",
          imageIndex: 1,
          whatWasSeen: "planritning med kök/vardagsrum intill varandra",
          confidence: 0.6,
        },
      ],
    });

    render(
      <GalleryConditionVision
        vision={vision}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
      />,
    );

    expect(screen.getByText("PLANLÖSNING")).toBeInTheDocument();
    expect(
      screen.getByText(/Planlösningen antyder att väggen/),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Bild 1").length).toBeGreaterThan(0);
  });

  it("renders the floor-plan section-level reinforcement line once when ≥1 remodelPotential claim is shown", () => {
    const vision = makeVision({
      claims: [
        {
          attribute: "remodelPotential",
          claim:
            "Sovrum 2 och 3 ligger intill varandra — kräver konstruktör / väggutredning.",
          imageIndex: 1,
          whatWasSeen: "planritning",
          confidence: 0.6,
        },
      ],
    });

    render(
      <GalleryConditionVision
        vision={vision}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
      />,
    );

    expect(
      screen.getAllByText(
        /Observationerna ovan är AI:ns tolkning av en 2D-planritning/,
      ).length,
    ).toBe(1);
  });

  it("does not render the floor-plan reinforcement line when no remodelPotential claim exists", () => {
    render(
      <GalleryConditionVision
        vision={makeVision()}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
      />,
    );

    expect(
      screen.queryByText(
        /Observationerna ovan är AI:ns tolkning av en 2D-planritning/,
      ),
    ).not.toBeInTheDocument();
  });

  it("renders the embedded sun-path sub-block (Compass + Solexponering) given latitude/longitude/floor/orientation props", () => {
    render(
      <GalleryConditionVision
        vision={makeVision()}
        visionSkippedReason={null}
        latitude={59.33}
        longitude={18.06}
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
  });

  it("renders the sun-path ej-tillgänglig line when orientation is null, even though vision claims exist", () => {
    render(
      <GalleryConditionVision
        vision={makeVision()}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
      />,
    );

    expect(
      screen.getByText(
        "Solexponering: ej tillgänglig — riktning eller våningsdata saknas för denna annons.",
      ),
    ).toBeInTheDocument();
  });

  it("WR-04: does NOT render a 'Bild 0' citation for a sentinel/invalid imageIndex (claim text still shows)", () => {
    render(
      <GalleryConditionVision
        vision={makeVision({
          claims: [
            {
              attribute: "overall",
              claim: "Bostaden verkar ljus",
              imageIndex: 0, // sentinel — must never render as "Bild 0"
              whatWasSeen: "stora fönster",
              confidence: 0.8,
            },
          ],
        })}
        visionSkippedReason={null}
        {...DEFAULT_SUN_PROPS}
      />,
    );

    expect(screen.getByText(/Bostaden verkar ljus/)).toBeInTheDocument();
    expect(screen.queryByText("Bild 0")).not.toBeInTheDocument();
  });
});
