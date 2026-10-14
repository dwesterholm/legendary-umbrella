/**
 * sold-condition-call.ts - the Anthropic strict-output call of the sold-photo condition read (Phase 14.4, BID-01, D-12).
 *
 * Script-side only: this is the one file that loads the SDK for the sold condition read. sold-condition.ts takes
 * the call as an injected function and never imports the SDK, so its tests need no network and no key.
 *
 * The call shape is the layout-call.ts one (`messages.parse` + `zodOutputFormat`), with the slim two-field schema
 * of sold-condition.ts: up to 5 URL image blocks (built from digit-only ids on bcdn.se), then one short Swedish
 * instruction. Money: the cost of an answered call is read from the usage the API returns; a refusal, a
 * truncation or an empty parse is still billed, so it is thrown as a {@link SoldConditionCallError} carrying the
 * amount and the cap sees it. An SDK error that is not a transport error (the answer arrived but did not fit the
 * schema) is counted at the per-flat estimate by `asBilledFailure`.
 *
 * STRUCTURAL SEPARATION (LOCKED): `niche-score.ts` and `report/flags.ts` must never import it.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { costSek, type ClaudeUsage } from "@/lib/brf/cost";
import {
  SOLD_CONDITION_EST_SEK_PER_FLAT,
  SOLD_CONDITION_MAX_TOKENS,
  SOLD_CONDITION_MODEL,
  SOLD_CONDITION_SYSTEM_PROMPT,
  SOLD_CONDITION_USER_INSTRUCTION,
  SoldConditionCallError,
  asBilledFailure,
  soldConditionSchema,
  type SoldConditionCallFn,
  type SoldConditionImageBlock,
} from "@/lib/discovery/sold-condition";

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

/** The injected call of `runSoldConditionReads`: one sold flat, its (at most 5) pictures, the slim strict-output schema. */
export function makeSoldConditionCall(client: Anthropic): SoldConditionCallFn {
  return async (blocks: SoldConditionImageBlock[]) => {
    let message;
    try {
      message = await client.beta.messages.parse({
        model: SOLD_CONDITION_MODEL,
        max_tokens: SOLD_CONDITION_MAX_TOKENS,
        temperature: 0,
        system: SOLD_CONDITION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: [...blocks, { type: "text", text: SOLD_CONDITION_USER_INSTRUCTION }] }],
        output_config: { format: zodOutputFormat(soldConditionSchema) },
      });
    } catch (error) {
      // parse() throws AFTER a billed answer when the output does not fit the schema; the cap must see that money.
      throw asBilledFailure(error, (e) => e instanceof Anthropic.APIError, SOLD_CONDITION_EST_SEK_PER_FLAT);
    }
    // The call completed, so it is billed whatever its stop_reason turns out to be.
    const billed = costSek(toClaudeUsage(message.usage));
    if (message.stop_reason === "refusal") throw new SoldConditionCallError("CLAUDE_REFUSAL", billed);
    if (message.stop_reason === "max_tokens") throw new SoldConditionCallError("CLAUDE_MAX_TOKENS", billed);
    if (!message.parsed_output) throw new SoldConditionCallError("CLAUDE_PARSE_EMPTY", billed);
    return { result: message.parsed_output, costSek: billed };
  };
}
