/**
 * layout-call.ts - the Anthropic strict-output call of the layout read (Phase 14.4, LAY-01, D-07, D-08).
 *
 * Script-side only: this is the one file that loads the SDK for the layout read. layout-read.ts takes the
 * call as an injected function and never imports the SDK, so its tests need no network and no key.
 *
 * The call shape is the vision.ts one (`messages.parse` + `zodOutputFormat`), with the slim schema of
 * layout-read.ts: the plan and up to 6 photos as image blocks, then one short Swedish instruction.
 * Money: the cost of an answered call is read from the usage the API returns (`costSek`); a refusal, a
 * truncation or an empty parse is still billed, so it is thrown as a {@link LayoutCallError} carrying the
 * amount and the cap sees it. An SDK error that is not a transport error (the answer arrived but did not fit
 * the schema) is counted at the per-flat estimate by `asBilledFailure`.
 *
 * STRUCTURAL SEPARATION (LOCKED): `niche-score.ts` and `report/flags.ts` must never import it.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { layoutCallCostSek } from "@/lib/discovery/layout-cost";
import type { LayoutVariantSpec, VariantCallFn } from "@/lib/discovery/layout-experiment";
import {
  LAYOUT_EST_SEK_PER_FLAT,
  LAYOUT_MAX_TOKENS,
  LAYOUT_MODEL,
  LAYOUT_SYSTEM_PROMPT,
  LAYOUT_USER_INSTRUCTION,
  LayoutCallError,
  asBilledFailure,
  layoutReadSchema,
  type LayoutCallFn,
  type LayoutImageBlock,
} from "@/lib/discovery/layout-read";
import { FloorPlanCallError } from "@/lib/discovery/sun-floorplan";

/**
 * The injected call of `runLayoutReads`: one flat, its pictures, the slim strict-output schema.
 *
 * Money (R-04, Phase 14.5): billed at the rates of {@link LAYOUT_MODEL} (Sonnet 4.6, $3 / $15 per MTok) through
 * `layoutCallCostSek`. Reads stored before 2026-10-17 were billed at Haiku rates, about three times too low
 * (about 0,11 kr recorded for a read that cost about 0,32 kr); the lifetime ledger in layout-cache.json is not
 * rewritten, so it still shows the old, too-low total.
 */
export function makeLayoutCall(client: Anthropic): LayoutCallFn {
  return async (blocks: LayoutImageBlock[]) => {
    let message;
    try {
      message = await client.beta.messages.parse({
        model: LAYOUT_MODEL,
        max_tokens: LAYOUT_MAX_TOKENS,
        temperature: 0,
        system: LAYOUT_SYSTEM_PROMPT,
        messages: [{ role: "user", content: [...blocks, { type: "text", text: LAYOUT_USER_INSTRUCTION }] }],
        output_config: { format: zodOutputFormat(layoutReadSchema) },
      });
    } catch (error) {
      // parse() throws AFTER a billed answer when the output does not fit the schema; the cap must see that money.
      throw asBilledFailure(error, (e) => e instanceof Anthropic.APIError, LAYOUT_EST_SEK_PER_FLAT);
    }
    // The call completed, so it is billed whatever its stop_reason turns out to be.
    const billed = layoutCallCostSek(LAYOUT_MODEL, message.usage);
    if (message.stop_reason === "refusal") throw new LayoutCallError("CLAUDE_REFUSAL", billed);
    if (message.stop_reason === "max_tokens") throw new LayoutCallError("CLAUDE_MAX_TOKENS", billed);
    if (!message.parsed_output) throw new LayoutCallError("CLAUDE_PARSE_EMPTY", billed);
    return { result: message.parsed_output, costSek: billed };
  };
}

/** The prompt, schema and shape of one model call, taken from a variant spec or from one step of it. */
interface CallShape {
  model: string;
  maxTokens: number;
  temperature: number | null;
  effort: "low" | "medium" | null;
  systemPrompt: string;
  userInstruction: string;
  schema: LayoutVariantSpec["schema"];
  estSekPerFlat: number;
}

/**
 * One strict-output call built from a {@link CallShape}:
 *  - `temperature` is sent only when the shape has one (Opus 5.5 rejects it with HTTP 400, Pitfall 5);
 *  - `output_config.effort` is sent only when the shape sets one, beside the strict-output format;
 *  - the format comes from the shape's schema;
 *  - cost is `layoutCallCostSek(model, usage)`: thinking tokens arrive inside `output_tokens` and are billed as output.
 * The refusal / max_tokens / empty-parse / billed-failure tail is the one of {@link makeLayoutCall}. No fallback and no
 * retry: an HTTP 400 is a finding for the live smoke to record.
 */
async function callOnce(client: Anthropic, shape: CallShape, blocks: LayoutImageBlock[]): Promise<{ result: unknown; costSek: number }> {
  let message;
  try {
    message = await client.beta.messages.parse({
      model: shape.model,
      max_tokens: shape.maxTokens,
      ...(shape.temperature !== null ? { temperature: shape.temperature } : {}),
      system: shape.systemPrompt,
      messages: [{ role: "user", content: [...blocks, { type: "text", text: shape.userInstruction }] }],
      output_config: {
        ...(shape.effort !== null ? { effort: shape.effort } : {}),
        format: zodOutputFormat(shape.schema as Parameters<typeof zodOutputFormat>[0]),
      },
    });
  } catch (error) {
    throw asBilledFailure(error, (e) => e instanceof Anthropic.APIError, shape.estSekPerFlat);
  }
  const billed = layoutCallCostSek(shape.model, message.usage);
  if (message.stop_reason === "refusal") throw new LayoutCallError("CLAUDE_REFUSAL", billed);
  if (message.stop_reason === "max_tokens") throw new LayoutCallError("CLAUDE_MAX_TOKENS", billed);
  if (!message.parsed_output) throw new LayoutCallError("CLAUDE_PARSE_EMPTY", billed);
  return { result: message.parsed_output, costSek: billed };
}

/** The injected call of `runVariantReads` for a ONE-step variant (Phase 14.5, D-10): see {@link callOnce}. */
export function makeVariantLayoutCall(client: Anthropic, spec: LayoutVariantSpec): VariantCallFn {
  return (blocks: LayoutImageBlock[]) => callOnce(client, spec, blocks);
}

/** The HTTP status an error carries, or null. */
const statusOf = (error: unknown): number | null => {
  const status = error instanceof Error ? (error as { status?: unknown }).status : undefined;
  return typeof status === "number" ? status : null;
};

/**
 * The injected call of `runVariantReads` for the TWO-step variant d (Phase 14.5, D-10): picture 1 (the plan) goes to
 * step A alone, the remaining pictures go to step B alone, and the two answers are returned together as
 * `{ stepA, stepB }` for `combineTwoStep`. Both steps use the call shape of the spec (temperature, effort, max tokens, model).
 *  - no photos: step B is skipped and `stepB` is null (every photo-derived field is then unknown);
 *  - the billed money of the two steps is summed, and a failure in step B throws a {@link LayoutCallError} carrying step A's
 *    cost plus whatever step B was billed, so the run cap sees all of it; an HTTP status on the original error is kept on
 *    the new one so the smoke can still see a 400;
 *  - a failure in step A throws as a single call does.
 */
export function makeTwoStepLayoutCall(client: Anthropic, spec: LayoutVariantSpec): VariantCallFn {
  const steps = spec.twoStep;
  if (spec.steps !== 2 || steps === undefined) throw new Error(`Variant ${spec.id} är inte en tvåstegsvariant`);
  const shapeOf = (step: { systemPrompt: string; userInstruction: string; schema: LayoutVariantSpec["schema"] }): CallShape => ({
    model: spec.model,
    maxTokens: spec.maxTokens,
    temperature: spec.temperature,
    effort: spec.effort,
    estSekPerFlat: spec.estSekPerFlat / 2,
    ...step,
  });
  return async (blocks: LayoutImageBlock[]) => {
    const [plan, ...photos] = blocks;
    if (plan === undefined) throw new LayoutCallError("NO_IMAGES", 0);
    const a = await callOnce(client, shapeOf(steps.stepA), [plan]);
    if (photos.length === 0) return { result: { stepA: a.result, stepB: null }, costSek: a.costSek };
    try {
      const b = await callOnce(client, shapeOf(steps.stepB), photos);
      return { result: { stepA: a.result, stepB: b.result }, costSek: a.costSek + b.costSek };
    } catch (error) {
      const billedB = error instanceof FloorPlanCallError ? error.billedSek : 0;
      const wrapped = new LayoutCallError(`STEP_B_${error instanceof FloorPlanCallError ? error.code : "FAILED"}`, a.costSek + billedB);
      const status = statusOf(error);
      if (status !== null) Object.assign(wrapped, { status });
      throw wrapped;
    }
  };
}
