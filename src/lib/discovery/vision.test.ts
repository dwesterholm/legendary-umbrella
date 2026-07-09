import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * vision.test.ts — mocks `@anthropic-ai/sdk` directly (mirrors
 * parse-intent.test.ts's shape) so no live key/network is needed. Covers
 * Task 1 (`runVisionForCandidate` two-pass orchestration) and Task 2
 * (`runVisionPass` incremental-cost-capped per-job loop).
 */

const parse = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      beta = {
        messages: {
          parse: (...args: unknown[]) => parse(...args),
        },
      };
    },
  };
});

vi.mock("@anthropic-ai/sdk/helpers/zod", () => ({
  zodOutputFormat: (schema: unknown) => ({ __mockFormat: true, schema }),
}));

import { runVisionForCandidate, runVisionPass } from "@/lib/discovery/vision";
import { CAP_VISION_SEK_MAX } from "@/lib/discovery/cost";
import { VISION_CONFIDENCE_THRESHOLD } from "@/lib/discovery/vision-schema";
import type { DiscoveryCandidate } from "@/lib/discovery/candidate";

function baseUsage() {
  return {
    input_tokens: 1000,
    output_tokens: 100,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function attr(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    claim: "Köket verkar renoverat",
    imageIndex: 1,
    whatWasSeen: "nya vitvaror",
    confidence: 0.9,
    ...overrides,
  };
}

function deepPassOutput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    kitchen: attr(),
    bathroom: attr({ claim: null, imageIndex: 0, whatWasSeen: "", confidence: 0 }),
    overall: attr({ imageIndex: 2, whatWasSeen: "allmänt gott skick" }),
    remodelPotential: attr({
      claim: null,
      imageIndex: 0,
      whatWasSeen: "",
      confidence: 0,
    }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runVisionForCandidate", () => {
  it("returns { result: null, skippedReason: 'no_images' } and makes NO Anthropic call when imageUrls is empty", async () => {
    const result = await runVisionForCandidate("booli-1", []);

    expect(result).toEqual({ result: null, skippedReason: "no_images" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("does NOT call Sonnet when the pre-filter flags worthDeepPass:false; costSek reflects only the Haiku call", async () => {
    parse.mockResolvedValueOnce({
      parsed_output: { worthDeepPass: false },
      usage: baseUsage(),
      stop_reason: "end_turn",
    });

    const result = await runVisionForCandidate("booli-2", ["https://img.example/1.jpg"]);

    expect(parse).toHaveBeenCalledTimes(1);
    expect(result.skippedReason).toBeNull();
    expect(result.result).not.toBeNull();
    expect(result.result?.claims).toEqual([]);
    expect(result.result?.costSek).toBeGreaterThan(0);
  });

  it("calls Sonnet with the FULL capped image set when worthDeepPass:true (not a subset)", async () => {
    const urls = [
      "https://img.example/1.jpg",
      "https://img.example/2.jpg",
      "https://img.example/3.jpg",
    ];
    parse
      .mockResolvedValueOnce({
        parsed_output: { worthDeepPass: true },
        usage: baseUsage(),
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({
        parsed_output: deepPassOutput(),
        usage: baseUsage(),
        stop_reason: "end_turn",
      });

    const result = await runVisionForCandidate("booli-3", urls);

    expect(parse).toHaveBeenCalledTimes(2);
    const sonnetCallArgs = parse.mock.calls[1][0] as {
      messages: Array<{ content: Array<{ type: string }> }>;
    };
    const imageBlockCount = sonnetCallArgs.messages[0].content.filter(
      (b) => b.type === "image",
    ).length;
    expect(imageBlockCount).toBe(urls.length);
    expect(result.result).not.toBeNull();
  });

  it("drops a claim with claim:null OR confidence below VISION_CONFIDENCE_THRESHOLD; keeps a claim >= threshold with its imageIndex/whatWasSeen", async () => {
    parse
      .mockResolvedValueOnce({
        parsed_output: { worthDeepPass: true },
        usage: baseUsage(),
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({
        parsed_output: deepPassOutput({
          kitchen: attr({ confidence: VISION_CONFIDENCE_THRESHOLD - 0.01 }),
          bathroom: attr({ claim: null, imageIndex: 0, whatWasSeen: "", confidence: 0 }),
          overall: attr({ confidence: VISION_CONFIDENCE_THRESHOLD, imageIndex: 2 }),
        }),
        usage: baseUsage(),
        stop_reason: "end_turn",
      });

    // Two images sent so the surviving claim's imageIndex: 2 is IN range
    // (WR-02, 11-REVIEW.md: an out-of-range imageIndex is now dropped even
    // at full confidence) — this test's own intent is confidence-threshold
    // filtering, not bounds validation (see the dedicated WR-02 test below).
    const result = await runVisionForCandidate("booli-4", [
      "https://img.example/1.jpg",
      "https://img.example/2.jpg",
    ]);

    expect(result.result?.claims).toHaveLength(1);
    expect(result.result?.claims[0]).toMatchObject({
      attribute: "overall",
      imageIndex: 2,
      whatWasSeen: "nya vitvaror",
    });
  });

  it("WR-02: drops a claim whose imageIndex is out of range for the actual sent image count, even at full confidence", async () => {
    parse
      .mockResolvedValueOnce({
        parsed_output: { worthDeepPass: true },
        usage: baseUsage(),
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({
        parsed_output: deepPassOutput({
          // Only ONE image sent, but the model hallucinates imageIndex: 2 —
          // functionally uncited despite a non-null claim + full confidence.
          kitchen: attr({ imageIndex: 2, confidence: 0.99 }),
          bathroom: attr({ claim: null, imageIndex: 0, whatWasSeen: "", confidence: 0 }),
          // A negative/zero imageIndex must also be dropped.
          overall: attr({ imageIndex: 0, confidence: 0.99 }),
        }),
        usage: baseUsage(),
        stop_reason: "end_turn",
      });

    const result = await runVisionForCandidate("booli-4b", ["https://img.example/1.jpg"]);

    expect(result.result?.claims).toEqual([]);
  });

  it("WR-04 (12-REVIEW.md): drops a claim whose imageIndex is fractional, even when otherwise in-range and high-confidence", async () => {
    const urls = ["https://img.example/1.jpg", "https://img.example/2.jpg"];
    parse
      .mockResolvedValueOnce({
        parsed_output: { worthDeepPass: true },
        usage: baseUsage(),
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({
        parsed_output: deepPassOutput({
          // 1.5 is within the [1, capped.length] bounds but is not an
          // integer — would previously slip through and render "Bild 1.5".
          kitchen: attr({ imageIndex: 1.5, confidence: 0.99 }),
          bathroom: attr({ claim: null, imageIndex: 0, whatWasSeen: "", confidence: 0 }),
          overall: attr({ imageIndex: 2, confidence: 0.9 }),
        }),
        usage: baseUsage(),
        stop_reason: "end_turn",
      });

    const result = await runVisionForCandidate("booli-4c", urls);

    const kitchenClaim = result.result?.claims.find((c) => c.attribute === "kitchen");
    const overallClaim = result.result?.claims.find((c) => c.attribute === "overall");
    expect(kitchenClaim).toBeUndefined();
    // The other, integer-indexed claim survives — the fractional check is
    // scoped to the offending claim only.
    expect(overallClaim).toBeDefined();
    expect(overallClaim?.imageIndex).toBe(2);
  });

  it("every kept claim has a numeric imageIndex resolvable to imageUrlsUsed[imageIndex-1]", async () => {
    const urls = ["https://img.example/1.jpg", "https://img.example/2.jpg"];
    parse
      .mockResolvedValueOnce({
        parsed_output: { worthDeepPass: true },
        usage: baseUsage(),
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({
        parsed_output: deepPassOutput(),
        usage: baseUsage(),
        stop_reason: "end_turn",
      });

    const result = await runVisionForCandidate("booli-5", urls);

    for (const claim of result.result?.claims ?? []) {
      expect(claim.imageIndex).toBeGreaterThan(0);
      expect(result.result?.imageUrlsUsed[claim.imageIndex - 1]).toBeDefined();
    }
  });

  it("code-enforces the 'kräver konstruktör / väggutredning' disclaimer on a remodelPotential claim even when the model OMITS it", async () => {
    parse
      .mockResolvedValueOnce({
        parsed_output: { worthDeepPass: true },
        usage: baseUsage(),
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({
        parsed_output: deepPassOutput({
          // The mocked model output deliberately OMITS the disclaimer phrase
          // — proving the suffix is code-appended, not model-dependent.
          remodelPotential: attr({
            claim: "Planlösningen antyder att en vägg eventuellt kan vara värt att undersöka.",
            imageIndex: 1,
            whatWasSeen: "planritning med öppen planlösning",
            confidence: 0.7,
          }),
        }),
        usage: baseUsage(),
        stop_reason: "end_turn",
      });

    const result = await runVisionForCandidate("booli-7", [
      "https://img.example/floorplan.jpg",
      "https://img.example/2.jpg",
    ]);

    const remodelClaim = result.result?.claims.find(
      (c) => c.attribute === "remodelPotential",
    );
    expect(remodelClaim).toBeDefined();
    expect(remodelClaim?.claim).toContain("kräver konstruktör");
    // The model's own text never contained the phrase — confirms code, not
    // prompt compliance, is the actual source.
    expect(
      "Planlösningen antyder att en vägg eventuellt kan vara värt att undersöka.",
    ).not.toContain("kräver konstruktör");
  });

  it("kitchen/bathroom/overall claims never receive the remodelPotential disclaimer suffix", async () => {
    parse
      .mockResolvedValueOnce({
        parsed_output: { worthDeepPass: true },
        usage: baseUsage(),
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({
        parsed_output: deepPassOutput(),
        usage: baseUsage(),
        stop_reason: "end_turn",
      });

    const result = await runVisionForCandidate("booli-8", [
      "https://img.example/1.jpg",
      "https://img.example/2.jpg",
    ]);

    const nonRemodelClaims = (result.result?.claims ?? []).filter(
      (c) => c.attribute !== "remodelPotential",
    );
    expect(nonRemodelClaims.length).toBeGreaterThan(0);
    for (const claim of nonRemodelClaims) {
      expect(claim.claim).not.toContain("kräver konstruktör");
    }
  });

  it("drops a remodelPotential claim below the confidence threshold or with an out-of-bounds imageIndex, identically to the other attributes", async () => {
    parse
      .mockResolvedValueOnce({
        parsed_output: { worthDeepPass: true },
        usage: baseUsage(),
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({
        parsed_output: deepPassOutput({
          remodelPotential: attr({
            claim: "Planlösningen antyder en möjlig ombyggnad.",
            imageIndex: 1,
            whatWasSeen: "planritning",
            confidence: VISION_CONFIDENCE_THRESHOLD - 0.01,
          }),
        }),
        usage: baseUsage(),
        stop_reason: "end_turn",
      });

    const result = await runVisionForCandidate("booli-9", ["https://img.example/1.jpg"]);

    expect(
      result.result?.claims.some((c) => c.attribute === "remodelPotential"),
    ).toBe(false);
  });

  it("a remodelPotential claim attempting a banned load-bearing verdict word is DROPPED and replaced with a safe hedged fallback (CR-01/CR-02 12-REVIEW.md)", async () => {
    parse
      .mockResolvedValueOnce({
        parsed_output: { worthDeepPass: true },
        usage: baseUsage(),
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({
        parsed_output: deepPassOutput({
          // Simulates a non-compliant model attempting a banned verdict
          // word — the code must actually INSPECT the raw claim text and
          // drop/replace it, not merely append a disclaimer after it (the
          // gap this review finding exists to close).
          remodelPotential: attr({
            claim: "Väggen mellan kök och hall verkar vara bärande.",
            imageIndex: 1,
            whatWasSeen: "planritning",
            confidence: 0.7,
          }),
        }),
        usage: baseUsage(),
        stop_reason: "end_turn",
      });

    const result = await runVisionForCandidate("booli-10", ["https://img.example/1.jpg"]);

    const remodelClaim = result.result?.claims.find(
      (c) => c.attribute === "remodelPotential",
    );
    expect(remodelClaim).toBeDefined();
    // The banned load-bearing verdict word must NEVER reach the persisted/
    // rendered claim text — it is dropped entirely, not merely trailed by a
    // disclaimer.
    expect(remodelClaim?.claim).not.toMatch(/\bbärande\b|\bicke-bärande\b/i);
    expect(remodelClaim?.claim).not.toContain("Väggen mellan kök och hall");
    // The mandatory investigation-framing disclaimer is still present.
    expect(remodelClaim?.claim).toContain("kräver konstruktör");
    // The safe generic fallback replaces the banned-word claim.
    expect(remodelClaim?.claim).toContain(
      "Planlösningen antyder att en vägg eventuellt kan vara värt att undersöka.",
    );
  });

  it("a clean (non-banned-word) remodelPotential claim survives verbatim and gets the code-enforced disclaimer suffix appended", async () => {
    parse
      .mockResolvedValueOnce({
        parsed_output: { worthDeepPass: true },
        usage: baseUsage(),
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({
        parsed_output: deepPassOutput({
          remodelPotential: attr({
            claim: "Planlösningen antyder att en vägg eventuellt kan vara värt att undersöka.",
            imageIndex: 1,
            whatWasSeen: "planritning",
            confidence: 0.7,
          }),
        }),
        usage: baseUsage(),
        stop_reason: "end_turn",
      });

    const result = await runVisionForCandidate("booli-11", ["https://img.example/1.jpg"]);

    const remodelClaim = result.result?.claims.find(
      (c) => c.attribute === "remodelPotential",
    );
    expect(remodelClaim).toBeDefined();
    // The clean model claim text is preserved verbatim...
    expect(remodelClaim?.claim).toContain(
      "Planlösningen antyder att en vägg eventuellt kan vara värt att undersöka.",
    );
    // ...with the mandatory disclaimer appended, unconditionally.
    expect(remodelClaim?.claim).toContain("kräver konstruktör");
    // And still no banned load-bearing verdict word anywhere in the final text.
    expect(remodelClaim?.claim).not.toMatch(/\bbärande\b|\bicke-bärande\b/i);
  });

  it("logs ONLY { booliId, code } on a thrown Anthropic error and rethrows a coded error", async () => {
    parse.mockRejectedValue(new Error("network exploded"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runVisionForCandidate("booli-6", ["https://img.example/secret-listing.jpg"]),
    ).rejects.toThrow();

    expect(errorSpy).toHaveBeenCalled();
    const loggedPayload = JSON.stringify(errorSpy.mock.calls[0]);
    expect(loggedPayload).not.toContain("img.example/secret-listing.jpg");
    expect(loggedPayload).toContain("booli-6");

    errorSpy.mockRestore();
  });
});

describe("runVisionPass", () => {
  function makeCandidate(overrides: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate {
    return {
      address: "Testgatan 1",
      price: 3_500_000,
      rooms: 3,
      livingArea: 65,
      areaLabel: "Södermalm",
      thumbnailUrl: null,
      sourceListingUrl: "https://www.booli.se/annons/1",
      constructionYear: null,
      brfName: null,
      tenureForm: null,
      imageUrls: ["https://img.example/1.jpg"],
      vision: null,
      visionSkippedReason: null,
      latitude: null,
      longitude: null,
      floor: null,
      orientation: null,
      balcony: null,
      upcomingSale: null,
      isNewConstruction: null,
      ...overrides,
    };
  }

  it("marks a candidate with imageUrls:null as vision:null, visionSkippedReason:'no_images' with zero Anthropic calls", async () => {
    const candidates = [makeCandidate({ imageUrls: null })];

    const result = await runVisionPass(candidates);

    expect(parse).not.toHaveBeenCalled();
    expect(result[0].vision).toBeNull();
    expect(result[0].visionSkippedReason).toBe("no_images");
  });

  it("runs vision for each candidate below the running cap; the returned candidate carries vision + visionSkippedReason", async () => {
    parse.mockResolvedValue({
      parsed_output: { worthDeepPass: false },
      usage: baseUsage(),
      stop_reason: "end_turn",
    });
    const candidates = [
      makeCandidate({ sourceListingUrl: "https://www.booli.se/annons/1" }),
    ];

    const result = await runVisionPass(candidates);

    expect(result[0].vision).not.toBeNull();
    expect(result[0].visionSkippedReason).toBeNull();
  });

  it("stops running vision once the running total would exceed CAP_VISION_SEK_MAX; remaining candidates get cost_cap, distinct from no_images", async () => {
    // A large candidate set so each per-candidate estimate is small relative
    // to CAP_VISION_SEK_MAX, but a few real (non-trivial-cost) calls will
    // still exhaust the cap given a high-cost mocked usage figure.
    const HIGH_USAGE = {
      input_tokens: 5_000_000,
      output_tokens: 500_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    parse.mockResolvedValue({
      parsed_output: { worthDeepPass: false },
      usage: HIGH_USAGE,
      stop_reason: "end_turn",
    });

    const candidates = Array.from({ length: 5 }, (_, i) =>
      makeCandidate({ sourceListingUrl: `https://www.booli.se/annons/${i}` }),
    );

    const result = await runVisionPass(candidates);

    const costCapped = result.filter((c) => c.visionSkippedReason === "cost_cap");
    expect(costCapped.length).toBeGreaterThan(0);
    for (const c of costCapped) {
      expect(c.vision).toBeNull();
    }
    // Once the cap is hit, no further Anthropic calls should be made for
    // the remaining candidates — call count must be strictly less than the
    // candidate count.
    expect(parse.mock.calls.length).toBeLessThan(candidates.length);
  });

  it("processes the same booliId only once — the second occurrence reuses the first result (in-memory dedupe)", async () => {
    parse.mockResolvedValue({
      parsed_output: { worthDeepPass: false },
      usage: baseUsage(),
      stop_reason: "end_turn",
    });
    const candidates = [
      makeCandidate({ sourceListingUrl: "https://www.booli.se/annons/dup" }),
      makeCandidate({ sourceListingUrl: "https://www.booli.se/annons/dup" }),
    ];

    const result = await runVisionPass(candidates);

    expect(parse).toHaveBeenCalledTimes(1);
    expect(result[0].vision).toEqual(result[1].vision);
  });

  it("CR-03: two candidates with null sourceListingUrl never collide — each gets its OWN vision result, never the other's", async () => {
    // Two DISTINCT image sets so cross-contamination is directly observable:
    // if the second candidate were served the first's cached VisionResult
    // (the pre-fix "unknown" sentinel collision), its imageUrlsUsed would
    // wrongly equal the FIRST candidate's images.
    parse
      .mockResolvedValueOnce({
        parsed_output: { worthDeepPass: false },
        usage: baseUsage(),
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({
        parsed_output: { worthDeepPass: false },
        usage: baseUsage(),
        stop_reason: "end_turn",
      });

    const candidates = [
      makeCandidate({
        sourceListingUrl: null,
        imageUrls: ["https://img.example/candidate-a-1.jpg"],
      }),
      makeCandidate({
        sourceListingUrl: null,
        imageUrls: ["https://img.example/candidate-b-1.jpg"],
      }),
    ];

    const result = await runVisionPass(candidates);

    // Both candidates must have been sent to Claude independently — a
    // collision would dedupe the second onto the first's cached result and
    // skip its own Anthropic call entirely.
    expect(parse).toHaveBeenCalledTimes(2);
    expect(result[0].vision).not.toBeNull();
    expect(result[1].vision).not.toBeNull();
    expect(result[0].vision?.imageUrlsUsed).toEqual([
      "https://img.example/candidate-a-1.jpg",
    ]);
    expect(result[1].vision?.imageUrlsUsed).toEqual([
      "https://img.example/candidate-b-1.jpg",
    ]);
    // Never the same object/values — no cross-contamination.
    expect(result[0].vision).not.toEqual(result[1].vision);
  });

  it("CR-02: a per-candidate Claude failure degrades ONLY that candidate to visionSkippedReason:'vision_error' and the pass continues to later candidates", async () => {
    parse
      // Candidate 1's pre-filter call throws.
      .mockRejectedValueOnce(new Error("network exploded"))
      // Candidate 2's pre-filter call succeeds normally.
      .mockResolvedValueOnce({
        parsed_output: { worthDeepPass: false },
        usage: baseUsage(),
        stop_reason: "end_turn",
      });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const candidates = [
      makeCandidate({ sourceListingUrl: "https://www.booli.se/annons/fail" }),
      makeCandidate({ sourceListingUrl: "https://www.booli.se/annons/ok" }),
    ];

    const result = await runVisionPass(candidates);

    expect(result[0].vision).toBeNull();
    expect(result[0].visionSkippedReason).toBe("vision_error");
    // The second candidate is NOT stranded by the first's failure.
    expect(result[1].vision).not.toBeNull();
    expect(result[1].visionSkippedReason).toBeNull();
    expect(parse).toHaveBeenCalledTimes(2);

    errorSpy.mockRestore();
  });

  it("produces DISTINCT visionSkippedReason values for cost_cap vs no_images (never collapsed)", async () => {
    const HIGH_USAGE = {
      input_tokens: 5_000_000,
      output_tokens: 500_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    parse.mockResolvedValue({
      parsed_output: { worthDeepPass: false },
      usage: HIGH_USAGE,
      stop_reason: "end_turn",
    });

    const candidates = [
      makeCandidate({ sourceListingUrl: "https://www.booli.se/annons/c", imageUrls: null }),
      makeCandidate({ sourceListingUrl: "https://www.booli.se/annons/a" }),
      makeCandidate({ sourceListingUrl: "https://www.booli.se/annons/b" }),
    ];

    const result = await runVisionPass(candidates);

    const reasons = new Set(result.map((c) => c.visionSkippedReason).filter(Boolean));
    // The no-images candidate must report "no_images"; the HIGH_USAGE mock
    // guarantees the running total exceeds CAP_VISION_SEK_MAX after the
    // first real vision call, so a later candidate must report "cost_cap" —
    // both distinct reasons must appear, never collapsed into one.
    expect(result[0].visionSkippedReason).toBe("no_images");
    expect(reasons.has("cost_cap")).toBe(true);
    expect([...reasons]).toEqual(expect.arrayContaining(["no_images", "cost_cap"]));
  });

  it("never crosses CAP_VISION_SEK_MAX across the whole pass (sanity bound)", async () => {
    parse.mockResolvedValue({
      parsed_output: { worthDeepPass: false },
      usage: baseUsage(),
      stop_reason: "end_turn",
    });
    const candidates = Array.from({ length: 3 }, (_, i) =>
      makeCandidate({ sourceListingUrl: `https://www.booli.se/annons/${i}` }),
    );

    const result = await runVisionPass(candidates);

    const totalSpent = result.reduce((sum, c) => sum + (c.vision?.costSek ?? 0), 0);
    expect(totalSpent).toBeLessThanOrEqual(CAP_VISION_SEK_MAX);
  });
});
