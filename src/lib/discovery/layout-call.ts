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
import { costSek, type ClaudeUsage } from "@/lib/brf/cost";
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

function toClaudeUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}): ClaudeUsage {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
  };
}

/** The injected call of `runLayoutReads`: one flat, its pictures, the slim strict-output schema. */
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
    const billed = costSek(toClaudeUsage(message.usage));
    if (message.stop_reason === "refusal") throw new LayoutCallError("CLAUDE_REFUSAL", billed);
    if (message.stop_reason === "max_tokens") throw new LayoutCallError("CLAUDE_MAX_TOKENS", billed);
    if (!message.parsed_output) throw new LayoutCallError("CLAUDE_PARSE_EMPTY", billed);
    return { result: message.parsed_output, costSek: billed };
  };
}
