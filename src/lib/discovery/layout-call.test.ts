// @vitest-environment node
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeLayoutCall, makeVariantLayoutCall } from "@/lib/discovery/layout-call";
import { LAYOUT_VARIANTS } from "@/lib/discovery/layout-experiment";
import { layoutCallCostSek } from "@/lib/discovery/layout-cost";
import { FloorPlanCallError } from "@/lib/discovery/sun-floorplan";
import {
  LAYOUT_EST_SEK_PER_FLAT,
  LAYOUT_MAX_TOKENS,
  LAYOUT_MODEL,
  LAYOUT_OPUS_MODEL,
  LAYOUT_SYSTEM_PROMPT,
  LAYOUT_SYSTEM_PROMPT_V2,
  LAYOUT_USER_INSTRUCTION_V2,
  LAYOUT_USER_INSTRUCTION,
  LayoutCallError,
  type LayoutImageBlock,
  type LayoutRead,
} from "@/lib/discovery/layout-read";

const answer = (over: Partial<LayoutRead> = {}): LayoutRead => ({
  balconySide: "street",
  livingOnBalconySide: true,
  kitchenOnBalconySide: false,
  bedroomOnBalconySide: false,
  windowSides: "one",
  bedroomSide: "street",
  streetEvidence: "cars",
  confidence: 0.9,
  ...over,
});

const blocks: LayoutImageBlock[] = [
  { type: "image", source: { type: "url", url: "https://bcdn.se/images/cache/1_1440x0.webp" } },
  { type: "image", source: { type: "url", url: "https://bcdn.se/images/cache/2_1440x0.webp" } },
];

interface FakeMessage {
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null };
  stop_reason: string;
  parsed_output: unknown;
}

/** A client object exposing only beta.messages.parse, capturing the request, cast to the SDK type. */
function fakeClient(message: FakeMessage | Error) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        parse: async (request: Record<string, unknown>) => {
          requests.push(request);
          if (message instanceof Error) throw message;
          return message;
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const message = (over: Partial<FakeMessage> = {}): FakeMessage => ({
  usage: { input_tokens: 5500, output_tokens: 150 },
  stop_reason: "end_turn",
  parsed_output: answer(),
  ...over,
});

describe("makeLayoutCall (production read)", () => {
  it("bills at Sonnet rates, not at the Haiku table (R-04)", async () => {
    const { client } = fakeClient(message());
    const { costSek } = await makeLayoutCall(client)(blocks);
    // 5500 in and 150 out at $3 / $15 per MTok, 11 kr per dollar: about 0,21 kr. At the Haiku table it was 0,07 kr.
    expect(costSek).toBeCloseTo(layoutCallCostSek(LAYOUT_MODEL, { input_tokens: 5500, output_tokens: 150 }), 10);
    expect(costSek).toBeGreaterThan(0.2);
    expect(costSek).toBeLessThan(0.22);
  });

  it("keeps the production request shape: model, temperature 0, 400 tokens, no effort", async () => {
    const { client, requests } = fakeClient(message());
    await makeLayoutCall(client)(blocks);
    expect(requests).toHaveLength(1);
    const request = requests[0] as { model: string; max_tokens: number; temperature: number; system: string; output_config: Record<string, unknown>; messages: { content: { type: string; text?: string }[] }[] };
    expect(request.model).toBe(LAYOUT_MODEL);
    expect(request.max_tokens).toBe(LAYOUT_MAX_TOKENS);
    expect(request.temperature).toBe(0);
    expect(request.system).toBe(LAYOUT_SYSTEM_PROMPT);
    expect(request.output_config).not.toHaveProperty("effort");
    expect(request.output_config).toHaveProperty("format");
    const content = request.messages[0].content;
    expect(content.slice(0, 2).map((b) => b.type)).toEqual(["image", "image"]);
    expect(content[2]).toEqual({ type: "text", text: LAYOUT_USER_INSTRUCTION });
  });

  it("carries the billed amount on a refusal, a truncation and an empty parse", async () => {
    const expected = layoutCallCostSek(LAYOUT_MODEL, { input_tokens: 5500, output_tokens: 150 });
    for (const [patch, code] of [
      [{ stop_reason: "refusal" }, "CLAUDE_REFUSAL"],
      [{ stop_reason: "max_tokens" }, "CLAUDE_MAX_TOKENS"],
      [{ parsed_output: null }, "CLAUDE_PARSE_EMPTY"],
    ] as const) {
      const { client } = fakeClient(message(patch));
      const error = await makeLayoutCall(client)(blocks).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LayoutCallError);
      expect((error as LayoutCallError).code).toBe(code);
      expect((error as LayoutCallError).billedSek).toBeCloseTo(expected, 10);
    }
  });

  it("counts a parse failure at the per-flat estimate", async () => {
    const { client } = fakeClient(new SyntaxError("bad json"));
    const error = await makeLayoutCall(client)(blocks).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FloorPlanCallError);
    expect((error as FloorPlanCallError).code).toBe("CLAUDE_PARSE_FAILED");
    expect((error as FloorPlanCallError).billedSek).toBe(LAYOUT_EST_SEK_PER_FLAT);
  });
});

const answerV2 = () => ({ ...answer(), planPresent: true, balconyConfidence: 0.8, windowsConfidence: 0.9, bedroomConfidence: 0.5 });

type Request = {
  model: string;
  max_tokens: number;
  temperature?: number;
  system: string;
  output_config: { effort?: string; format?: unknown };
  messages: { content: { type: string; text?: string }[] }[];
};

describe("makeVariantLayoutCall (D-10, Pitfall 5)", () => {
  it("for variant c sends Opus, 4000 tokens, effort low and a format, and no temperature key at all", async () => {
    const { client, requests } = fakeClient(message({ parsed_output: answerV2(), usage: { input_tokens: 5500, output_tokens: 1200 } }));
    await makeVariantLayoutCall(client, LAYOUT_VARIANTS.c)(blocks);
    const request = requests[0] as Request;
    expect(request.model).toBe(LAYOUT_OPUS_MODEL);
    expect(request.max_tokens).toBe(4000);
    expect(request).not.toHaveProperty("temperature");
    expect(request.output_config.effort).toBe("low");
    expect(request.output_config).toHaveProperty("format");
    expect(request.system).toBe(LAYOUT_SYSTEM_PROMPT_V2);
    expect(request.messages[0].content.at(-1)).toEqual({ type: "text", text: LAYOUT_USER_INSTRUCTION_V2 });
  });

  it("for variants a and b sends temperature 0 and no effort", async () => {
    for (const [id, parsed] of [
      ["a", answer()],
      ["b", answerV2()],
    ] as const) {
      const { client, requests } = fakeClient(message({ parsed_output: parsed }));
      await makeVariantLayoutCall(client, LAYOUT_VARIANTS[id])(blocks);
      const request = requests[0] as Request;
      expect(request.temperature, id).toBe(0);
      expect(request.output_config, id).not.toHaveProperty("effort");
      expect(request.output_config, id).toHaveProperty("format");
      expect(request.model, id).toBe(LAYOUT_MODEL);
    }
    const { client, requests } = fakeClient(message({ parsed_output: answerV2() }));
    await makeVariantLayoutCall(client, LAYOUT_VARIANTS.b)(blocks);
    expect((requests[0] as Request).max_tokens).toBe(600);
  });

  it("bills with the variant's own model rates, thinking tokens included in the output", async () => {
    const usage = { input_tokens: 5500, output_tokens: 1200 };
    const opus = await makeVariantLayoutCall(fakeClient(message({ parsed_output: answerV2(), usage })).client, LAYOUT_VARIANTS.c)(blocks);
    const sonnet = await makeVariantLayoutCall(fakeClient(message({ parsed_output: answerV2(), usage })).client, LAYOUT_VARIANTS.b)(blocks);
    expect(opus.costSek).toBeCloseTo(layoutCallCostSek(LAYOUT_OPUS_MODEL, usage), 10);
    expect(sonnet.costSek).toBeCloseTo(layoutCallCostSek(LAYOUT_MODEL, usage), 10);
    expect(opus.costSek).toBeGreaterThan(sonnet.costSek);
  });

  it("carries the billed amount on a refusal, a truncation and an empty parse", async () => {
    const usage = { input_tokens: 5500, output_tokens: 4000 };
    const expected = layoutCallCostSek(LAYOUT_OPUS_MODEL, usage);
    for (const [patch, code] of [
      [{ stop_reason: "refusal" }, "CLAUDE_REFUSAL"],
      [{ stop_reason: "max_tokens" }, "CLAUDE_MAX_TOKENS"],
      [{ parsed_output: null }, "CLAUDE_PARSE_EMPTY"],
    ] as const) {
      const { client } = fakeClient(message({ usage, ...patch }));
      const error = await makeVariantLayoutCall(client, LAYOUT_VARIANTS.c)(blocks).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LayoutCallError);
      expect((error as LayoutCallError).code).toBe(code);
      expect((error as LayoutCallError).billedSek).toBeCloseTo(expected, 10);
    }
  });

  it("counts a parse failure at the variant's per-flat estimate", async () => {
    const parse = await makeVariantLayoutCall(fakeClient(new SyntaxError("bad json")).client, LAYOUT_VARIANTS.c)(blocks).catch((e: unknown) => e);
    expect((parse as FloorPlanCallError).billedSek).toBe(LAYOUT_VARIANTS.c.estSekPerFlat);
  });
});
