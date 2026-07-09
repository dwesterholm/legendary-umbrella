import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { costSek, costSekSonnet, SONNET_USD_PER_MTOK } from "@/lib/brf/cost";
import { assembleFactSheet } from "@/lib/report/fact-sheet";
import type { FlagSet } from "@/lib/report/flags";

// NOTE: this file is shared with Plan 03 (it adds stop-reason / log-redaction
// describe blocks). Plan 04-01's additions live in the clearly-named blocks
// below so the two plans' tests do not collide.

// ---------------------------------------------------------------------------
// Mock the Anthropic SDK so the synthesis stop-reason + log-redaction tests run
// deterministically with NO ANTHROPIC_API_KEY and NO network spend. The mock
// replaces `client.messages.parse` with a single shared mock fn; each test sets
// its return/throw with `parseMock.mockResolvedValueOnce(...)`. `new Anthropic()`
// in synthesize.ts resolves to this mock at module load.
//
// `vi.mock` is hoisted above the module body, so the mock fn must be created
// INSIDE the factory (a closure-captured top-level `const` would be in its
// temporal dead zone when the factory runs). We hang it off `globalThis` so the
// test body can reach the exact same fn instance the mocked client holds.
// ---------------------------------------------------------------------------
vi.mock("@anthropic-ai/sdk", () => {
  const mock = vi.fn();
  (globalThis as Record<string, unknown>).__parseMock = mock;
  return {
    default: class MockAnthropic {
      messages = { parse: mock };
    },
  };
});

// Import the unit under test AFTER the mock is declared (vi.mock is hoisted, so
// this static import already receives the mocked client).
import { synthesizeReport } from "@/lib/report/synthesize";

const parseMock = (globalThis as Record<string, unknown>)
  .__parseMock as ReturnType<typeof vi.fn>;

describe("04-01 Sonnet cost rates (RESEARCH Pitfall 3 / T-04-03)", () => {
  it("publishes the Sonnet 4.6 rates ($3 in / $15 out)", () => {
    expect(SONNET_USD_PER_MTOK.input).toBe(3.0);
    expect(SONNET_USD_PER_MTOK.output).toBe(15.0);
    expect(SONNET_USD_PER_MTOK.cacheWrite5m).toBe(3.75);
    expect(SONNET_USD_PER_MTOK.cacheRead).toBe(0.3);
  });

  it("costSekSonnet bills ~3× the Haiku costSek for the same usage", () => {
    const usage = { input_tokens: 3_000, output_tokens: 1_200 };
    const haiku = costSek(usage);
    const sonnet = costSekSonnet(usage);
    // input 3×, output 3× → exactly 3× for a no-cache run.
    expect(sonnet / haiku).toBeCloseTo(3, 5);
    expect(sonnet).toBeGreaterThan(haiku);
  });

  it("a typical synthesis run stays well under the 5 SEK guard", () => {
    // AI-SPEC §4b: ~3k input, ~1.2k output ≈ 0.30 SEK at USD/SEK 11.
    const cost = costSekSonnet({ input_tokens: 3_000, output_tokens: 1_200 });
    expect(cost).toBeLessThan(5);
    expect(cost).toBeCloseTo(0.3, 1);
  });

  it("leaves the Haiku costSek path unchanged (still ~0.94 SEK for 80k/1k)", () => {
    const cost = costSek({ input_tokens: 80_000, output_tokens: 1_000 });
    expect(cost).toBeCloseTo(0.94, 1);
  });
});

describe("04-01 assembleFactSheet — stable key order + ej_tillgänglig (D-07)", () => {
  const flags: FlagSet = [
    { id: "brf_high_debt", severity: "red", sourceRef: "brf.skuldPerKvm" },
  ];

  it("is deterministic: same input → byte-identical string", () => {
    const input = {
      listing: { price: 4_000_000, prisPerKvm: 80_000, address: "Testgatan 1" },
      brf: { normalized: { skuldPerKvm: 13_000 } },
      price: { deltaPct: 8, reason: "ok" },
      area: { metrics: { population: 1200 } },
      macro: null,
      flags,
      softSignals: null,
    };
    expect(assembleFactSheet(input)).toBe(assembleFactSheet(input));
  });

  it("is order-insensitive to the caller's object key insertion order", () => {
    const a = assembleFactSheet({
      listing: { price: 4_000_000, address: "Testgatan 1", prisPerKvm: 80_000 },
      brf: null,
      price: null,
      area: null,
      macro: null,
      flags,
      softSignals: null,
    });
    const b = assembleFactSheet({
      listing: { prisPerKvm: 80_000, price: 4_000_000, address: "Testgatan 1" },
      brf: null,
      price: null,
      area: null,
      macro: null,
      flags,
      softSignals: null,
    });
    expect(a).toBe(b);
  });

  it("marks an absent brf source as status ej_tillgänglig (never omitted)", () => {
    const out = assembleFactSheet({
      listing: { price: 4_000_000 },
      brf: null,
      price: { deltaPct: 8, reason: "ok" },
      area: null,
      macro: null,
      flags: [],
      softSignals: null,
    });
    const parsed = JSON.parse(out);
    expect(parsed.brf).toEqual({ status: "ej_tillgänglig" });
    expect(parsed.area).toEqual({ status: "ej_tillgänglig" });
    expect(parsed.macro).toEqual({ status: "ej_tillgänglig" });
    expect(out).toContain('"status":"ej_tillgänglig"');
  });

  it("wraps a present source as status tillgänglig with its data", () => {
    const out = assembleFactSheet({
      listing: { price: 4_000_000 },
      brf: { normalized: { skuldPerKvm: 13_000 } },
      price: null,
      area: null,
      macro: null,
      flags: [],
      softSignals: null,
    });
    const parsed = JSON.parse(out);
    expect(parsed.brf.status).toBe("tillgänglig");
    expect(parsed.brf.data.normalized.skuldPerKvm).toBe(13_000);
  });

  it("carries the deterministic flags through in order", () => {
    const out = assembleFactSheet({
      listing: null,
      brf: null,
      price: null,
      area: null,
      macro: null,
      flags,
      softSignals: null,
    });
    const parsed = JSON.parse(out);
    expect(parsed.flags).toHaveLength(1);
    expect(parsed.flags[0].id).toBe("brf_high_debt");
  });
});

// ---------------------------------------------------------------------------
// 04-03 synthesizeReport — stop-reason branching + GDPR-safe log redaction.
// These exercise the REAL shipping `synthesizeReport` path against the mocked
// Anthropic client; no key, no spend. The factSheet here carries an obviously
// sensitive marker so the redaction assertion can prove it never reaches a log.
// ---------------------------------------------------------------------------

/** A fact sheet whose payload would be a GDPR leak if it ever hit a log line. */
const SENSITIVE_FACT_SHEET = JSON.stringify({
  brf: { skuldPerKvm: 13_000, kassaflode: -250_000 },
  listing: { price: 4_250_000, address: "Hemligagatan 7" },
  __SECRET__: "SHOULD-NEVER-BE-LOGGED-financials-12345",
});

/** A well-formed parsed report the parse mock can return on the happy path. */
const VALID_PARSED = {
  leadSynthesis: "Priset ligger över snittet och föreningen är högt belånad.",
  ekonomi: { status: "bedömd", claims: [] },
  pris: { status: "bedömd", claims: [] },
  omrade: { status: "ej_tillgänglig", claims: [] },
  prioritizedFlagIds: ["brf_high_debt"],
};

/** A usage block in the SDK shape. */
const USAGE = {
  input_tokens: 3_000,
  output_tokens: 1_200,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

describe("04-03 synthesizeReport — stop-reason branching (AI-SPEC §3/§4b)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    parseMock.mockReset();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("returns the parsed report + usage on a clean end_turn", async () => {
    parseMock.mockResolvedValueOnce({
      stop_reason: "end_turn",
      parsed_output: VALID_PARSED,
      usage: USAGE,
    });

    const result = await synthesizeReport({
      factSheet: SENSITIVE_FACT_SHEET,
      analysisId: "a-1",
    });

    expect(result.parsed.leadSynthesis).toContain("högt belånad");
    expect(result.usage.input_tokens).toBe(3_000);
    expect(result.usage.output_tokens).toBe(1_200);
    expect(parseMock).toHaveBeenCalledTimes(1);
  });

  it("refusal → CLAUDE_REFUSAL with NO retry", async () => {
    parseMock.mockResolvedValueOnce({
      stop_reason: "refusal",
      parsed_output: null,
      usage: USAGE,
    });

    await expect(
      synthesizeReport({ factSheet: SENSITIVE_FACT_SHEET, analysisId: "a-2" }),
    ).rejects.toThrow("CLAUDE_REFUSAL");
    // A guardrail trip must not loop — parse called exactly once.
    expect(parseMock).toHaveBeenCalledTimes(1);
  });

  it("max_tokens twice → CLAUDE_MAX_TOKENS after exactly one retry", async () => {
    parseMock
      .mockResolvedValueOnce({
        stop_reason: "max_tokens",
        parsed_output: null,
        usage: USAGE,
      })
      .mockResolvedValueOnce({
        stop_reason: "max_tokens",
        parsed_output: null,
        usage: USAGE,
      });

    await expect(
      synthesizeReport({ factSheet: SENSITIVE_FACT_SHEET, analysisId: "a-3" }),
    ).rejects.toThrow("CLAUDE_MAX_TOKENS");
    // Original call + exactly one retry = 2; never an unbounded loop.
    expect(parseMock).toHaveBeenCalledTimes(2);
  });

  it("max_tokens then a clean retry → succeeds", async () => {
    parseMock
      .mockResolvedValueOnce({
        stop_reason: "max_tokens",
        parsed_output: null,
        usage: USAGE,
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        parsed_output: VALID_PARSED,
        usage: USAGE,
      });

    const result = await synthesizeReport({
      factSheet: SENSITIVE_FACT_SHEET,
      analysisId: "a-4",
    });

    expect(result.parsed.prioritizedFlagIds).toEqual(["brf_high_debt"]);
    expect(parseMock).toHaveBeenCalledTimes(2);
  });

  it("empty parsed_output → CLAUDE_PARSE_EMPTY", async () => {
    parseMock.mockResolvedValueOnce({
      stop_reason: "end_turn",
      parsed_output: null,
      usage: USAGE,
    });

    await expect(
      synthesizeReport({ factSheet: SENSITIVE_FACT_SHEET, analysisId: "a-5" }),
    ).rejects.toThrow("CLAUDE_PARSE_EMPTY");
  });

  it("an unknown SDK error → CLAUDE_CALL_FAILED (coded, with cause)", async () => {
    const networkError = new Error("ECONNRESET socket hang up");
    parseMock.mockRejectedValueOnce(networkError);

    await expect(
      synthesizeReport({ factSheet: SENSITIVE_FACT_SHEET, analysisId: "a-6" }),
    ).rejects.toMatchObject({
      message: "CLAUDE_CALL_FAILED",
      cause: networkError,
    });
  });
});

describe("04-03 synthesizeReport — GDPR-safe logging (T-04-11, AI-SPEC §7)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    parseMock.mockReset();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("logs ONLY { analysisId, code } — the factSheet never appears in a log line", async () => {
    parseMock.mockResolvedValueOnce({
      stop_reason: "refusal",
      parsed_output: null,
      usage: USAGE,
    });

    await expect(
      synthesizeReport({
        factSheet: SENSITIVE_FACT_SHEET,
        analysisId: "redaction-1",
      }),
    ).rejects.toThrow("CLAUDE_REFUSAL");

    // The factSheet (financials) must NEVER be serialized into a log line.
    const allLoggedText = errorSpy.mock.calls
      .map((args: unknown[]) =>
        args.map((a: unknown) => JSON.stringify(a)).join(" "),
      )
      .join("\n");

    expect(allLoggedText).not.toContain("SHOULD-NEVER-BE-LOGGED");
    expect(allLoggedText).not.toContain("Hemligagatan");
    expect(allLoggedText).not.toContain("skuldPerKvm");
    expect(allLoggedText).not.toContain("4250000");
    // It DOES carry the safe traceability pair.
    expect(allLoggedText).toContain("redaction-1");
    expect(allLoggedText).toContain("CLAUDE_REFUSAL");
  });

  it("an unknown failure logs only the analysisId + CLAUDE_CALL_FAILED, never the cause payload", async () => {
    parseMock.mockRejectedValueOnce(
      new Error(`leaked-financials ${SENSITIVE_FACT_SHEET}`),
    );

    await expect(
      synthesizeReport({
        factSheet: SENSITIVE_FACT_SHEET,
        analysisId: "redaction-2",
      }),
    ).rejects.toThrow("CLAUDE_CALL_FAILED");

    const allLoggedText = errorSpy.mock.calls
      .map((args: unknown[]) =>
        args.map((a: unknown) => JSON.stringify(a)).join(" "),
      )
      .join("\n");

    expect(allLoggedText).not.toContain("SHOULD-NEVER-BE-LOGGED");
    expect(allLoggedText).not.toContain("Hemligagatan");
    expect(allLoggedText).toContain("redaction-2");
    expect(allLoggedText).toContain("CLAUDE_CALL_FAILED");
  });
});
