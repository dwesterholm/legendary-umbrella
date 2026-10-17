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

/**
 * The injected call of `runVariantReads` for a ONE-step variant (Phase 14.5, D-10): the same request as
 * {@link makeLayoutCall} but built from the variant spec.
 *  - `temperature` is sent only when the spec has one (Opus 5.5 rejects it with HTTP 400, Pitfall 5);
 *  - `output_config.effort` is sent only when the spec sets one, beside the strict-output format;
 *  - the strict-output format comes from `spec.schema`;
 *  - cost is `layoutCallCostSek(spec.model, usage)`: thinking tokens arrive inside `output_tokens` and are billed as
 *    output, so an Opus read that thinks is priced right.
 * The refusal / max_tokens / empty-parse / billed-failure tail is the one of {@link makeLayoutCall}. No fallback and no
 * retry: an HTTP 400 is a finding for the live smoke to record.
 */
export function makeVariantLayoutCall(client: Anthropic, spec: LayoutVariantSpec): VariantCallFn {
  return async (blocks: LayoutImageBlock[]) => {
    let message;
    try {
      message = await client.beta.messages.parse({
        model: spec.model,
        max_tokens: spec.maxTokens,
        ...(spec.temperature !== null ? { temperature: spec.temperature } : {}),
        system: spec.systemPrompt,
        messages: [{ role: "user", content: [...blocks, { type: "text", text: spec.userInstruction }] }],
        output_config: {
          ...(spec.effort !== null ? { effort: spec.effort } : {}),
          format: zodOutputFormat(spec.schema as Parameters<typeof zodOutputFormat>[0]),
        },
      });
    } catch (error) {
      throw asBilledFailure(error, (e) => e instanceof Anthropic.APIError, spec.estSekPerFlat);
    }
    const billed = layoutCallCostSek(spec.model, message.usage);
    if (message.stop_reason === "refusal") throw new LayoutCallError("CLAUDE_REFUSAL", billed);
    if (message.stop_reason === "max_tokens") throw new LayoutCallError("CLAUDE_MAX_TOKENS", billed);
    if (!message.parsed_output) throw new LayoutCallError("CLAUDE_PARSE_EMPTY", billed);
    return { result: message.parsed_output, costSek: billed };
  };
}
