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

  it("the pre-filter triage is inverted for a reno search: dated/original flats pass, skip only when unanalyzable (D2a)", () => {
    // Dated/original stock must always go through — it's the target.
    expect(VISION_PREFILTER_SYSTEM_PROMPT).toContain("daterad");
    expect(VISION_PREFILTER_SYSTEM_PROMPT).toMatch(/ursprunglig/);
    // Skip only when there is nothing to assess at all.
    expect(VISION_PREFILTER_SYSTEM_PROMPT).toMatch(/inga interiörbilder|för mörka\/suddiga/);
    // When in doubt, pass it through (high recall).
    expect(VISION_PREFILTER_SYSTEM_PROMPT).toMatch(/osäker.*true|släpp igenom/);
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

  it("the deep-pass prompt includes a remodel-potential (värdehöjande) instruction citing the floor plan", () => {
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("remodelPotential");
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("värdehöjande");
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("planritning");
  });

  it("the remodel instruction frames BROAD professional-renovator value-adds, not only wall changes", () => {
    // Broadened (this session): walls both ways, cosmetic, bathroom, kitchen, stambyte.
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("1:a → 2:a"); // add a wall for a room
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("mikrocement"); // dated-bathroom refresh
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("måla om"); // cosmetic repaint
    expect(VISION_DEEPPASS_SYSTEM_PROMPT).toContain("stambyte"); // imminent stambyte → new bathroom
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
