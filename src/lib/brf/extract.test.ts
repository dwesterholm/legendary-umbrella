import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * extract.test.ts — WR-02 (14-REVIEW.md). Mocks `@anthropic-ai/sdk` directly
 * (mirrors `vision.test.ts`/`parse-intent.test.ts`'s shape) so no live key or
 * network is needed. Scope is deliberately narrow: the COST-REPORTING contract
 * of `extractBrfFinancials`'s truncation-retry path, which had no test harness
 * at all (every consumer mocks this module wholesale), and which is exactly
 * where a billed call was being silently dropped from the returned `usage`.
 */

const parse = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    beta = {
      messages: {
        parse: (...args: unknown[]) => parse(...args),
      },
    };
  },
  toFile: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk/helpers/zod", () => ({
  zodOutputFormat: (schema: unknown) => ({ __mockFormat: true, schema }),
}));

import { extractBrfFinancials } from "@/lib/brf/extract";
import { costSek } from "@/lib/brf/cost";

/** The slim Claude-facing shape `toCanonicalExtraction` consumes. */
function parsedOutput() {
  const field = (value: unknown) => ({
    value,
    confidence: 0.9,
    sourceQuote: "citat",
    pageRef: 3,
  });
  return {
    skuldPerKvm: field(5000),
    avgiftsniva: field(600),
    kassaflode: field(100000),
    underhallsplanStatus: field("finns_aktuell"),
    stambytePlanerat: field("planerat"),
    storreRenoveringar: field("tak 2021"),
    ovrigaAnmarkningar: field(""),
  };
}

function usage(input: number, output: number) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

const DOC = { kind: "ixbrl-text" as const, text: "ÅRSREDOVISNING", contentHash: "hash-1" };

describe("extractBrfFinancials — billed-call cost reporting (WR-02)", () => {
  beforeEach(() => {
    parse.mockReset();
  });

  it("reports a single call's usage unchanged when no retry was needed", async () => {
    parse.mockResolvedValue({
      stop_reason: "end_turn",
      parsed_output: parsedOutput(),
      usage: usage(50_000, 800),
      content: [],
    });

    const result = await extractBrfFinancials(DOC);

    expect(parse).toHaveBeenCalledTimes(1);
    expect(result.usage.input_tokens).toBe(50_000);
    expect(result.usage.output_tokens).toBe(800);
  });

  it("SUMS both attempts' usage when a truncation retry then SUCCEEDS — the leak WR-02 reports", async () => {
    // Anthropic bills the truncated first call in full. Returning only the
    // second message's usage reported half the real spend.
    parse
      .mockResolvedValueOnce({
        stop_reason: "max_tokens",
        parsed_output: null,
        usage: usage(50_000, 2048),
        content: [],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        parsed_output: parsedOutput(),
        usage: usage(50_000, 900),
        content: [],
      });

    const result = await extractBrfFinancials(DOC);

    expect(parse).toHaveBeenCalledTimes(2);
    expect(result.usage.input_tokens).toBe(100_000);
    expect(result.usage.output_tokens).toBe(2048 + 900);
    // And the priced figure is the sum of both calls, not one of them.
    expect(costSek(result.usage)).toBeCloseTo(
      costSek(usage(50_000, 2048)) + costSek(usage(50_000, 900)),
      10,
    );
  });

  it("still throws the coded CLAUDE_MAX_TOKENS when the retry also truncates", async () => {
    parse.mockResolvedValue({
      stop_reason: "max_tokens",
      parsed_output: null,
      usage: usage(50_000, 2048),
      content: [],
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(extractBrfFinancials(DOC)).rejects.toThrow("CLAUDE_MAX_TOKENS");
    expect(parse).toHaveBeenCalledTimes(2);
    // GDPR: the log carries the hash + code only, never the document text.
    for (const call of errorSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("ÅRSREDOVISNING");
    }
    errorSpy.mockRestore();
  });

  it("does NOT retry a refusal (one billed call, coded throw)", async () => {
    parse.mockResolvedValue({
      stop_reason: "refusal",
      parsed_output: null,
      usage: usage(50_000, 10),
      content: [],
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(extractBrfFinancials(DOC)).rejects.toThrow("CLAUDE_REFUSAL");
    expect(parse).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});
