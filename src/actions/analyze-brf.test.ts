import { describe, it, expect } from "vitest";
// RED: implemented in Plan 04 (src/actions/analyze-brf.ts).
// The import fails until the server action module exists.
import { analyzeBrf, correctBrfField } from "@/actions/analyze-brf";

describe("analyze-brf server action — module surface", () => {
  it("exports the analyzeBrf server action", () => {
    expect(typeof analyzeBrf).toBe("function");
  });

  it("exports the correctBrfField server action", () => {
    expect(typeof correctBrfField).toBe("function");
  });
});

describe("analyze-brf — deeper behavior (Plan 04 integration tests)", () => {
  // These become real integration tests in Plan 04 once the action is wired.
  it.todo("hard-blocks guest (unauthenticated) uploads per D-05");
  it.todo("enforces RLS — a user cannot read another user's BRF analysis");
  it.todo("D-06 replace: re-running on the same analysis re-extracts and overwrites");
  it.todo("content-hash skip: an identical PDF reuses the prior extraction (no re-bill)");
  it.todo("correctBrfField re-runs normalize+score only, never the Claude call (D-12)");
  it.todo("aborts the run if projected cost exceeds the 5 SEK hard cap");
});
