import { describe, it, expect } from "vitest";
import {
  VISION_PREFILTER_SYSTEM_PROMPT,
  VISION_DEEPPASS_SYSTEM_PROMPT,
} from "@/lib/discovery/vision-prompt";

/**
 * vision-prompt.test.ts — asserts the PII/people-ignore instruction is
 * present verbatim in BOTH system prompts (T-11-06) and that the deep-pass
 * prompt locks the hedged-language contract (banned verdict words).
 */

describe("vision-prompt", () => {
  it("includes the explicit people/personal-document ignore instruction in the pre-filter prompt", () => {
    expect(VISION_PREFILTER_SYSTEM_PROMPT).toContain("Ignorera");
    expect(VISION_PREFILTER_SYSTEM_PROMPT).toContain("människor");
  });

  it("includes the explicit people/personal-document ignore instruction in the deep-pass prompt", () => {
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("Ignorera");
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("människor");
  });

  it("the deep-pass prompt instructs hedged language and bans verdict words", () => {
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("verkar");
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("ser ut att");
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("tyder på");
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("garanterat");
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("definitivt");
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("kommer att");
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("bör köpas");
  });

  it("the deep-pass prompt includes a floor-plan (planlösning) remodel-potential instruction", () => {
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("planlösning");
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("planritning");
  });

  it("the floor-plan instruction mandates the 'kräver konstruktör / väggutredning' disclaimer phrase", () => {
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("kräver konstruktör / väggutredning");
  });

  it("the floor-plan instruction bans definitive load-bearing verdict words", () => {
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("bärande");
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("icke-bärande");
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("kan enkelt rivas");
  });

  it("the floor-plan instruction directs question-only hedging, never a stated load-bearing fact", () => {
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("ALDRIG");
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("FAKTUM");
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toMatch(/undersöka|utreda/);
  });
});
