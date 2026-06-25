import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { reportSchema, type AiReport } from "@/lib/schemas/report";
import { REPORT_SYNTHESIS_SYSTEM_PROMPT } from "@/lib/report/prompt";
import type { ClaudeUsage } from "@/lib/brf/cost";

/**
 * The single Claude synthesis call (AI-SPEC §3). Strictly simpler than the
 * Phase 2 extraction (`src/lib/brf/extract.ts`): no PDF document block, no Files
 * API, no base64 — the input is a few-thousand-token JSON fact sheet of
 * already-structured data. One Sonnet call, schema-validated structured output,
 * the same coded-error + GDPR-safe-log discipline.
 *
 * The Anthropic client is instantiated ONLY here (server module). It reads
 * `ANTHROPIC_API_KEY` from the environment and is never configured to allow
 * browser use — the key must never reach the browser (T-02-09).
 */
const client = new Anthropic();

/**
 * Sonnet 4.6 — the more capable tier for opinionated cross-source synthesis
 * (AI-SPEC §4). Bare id, NO date suffix (the skill warns against suffixes).
 */
const MODEL = "claude-sonnet-4-6";

/** The terse per-request instruction — kept AFTER the cached fact block. */
const USER_INSTRUCTION = "Skriv rapporten enligt schemat.";

/** Input to the synthesis call. */
export interface SynthesizeInput {
  /**
   * Pre-assembled, already-structured facts (the `assembleFactSheet` bundle).
   * NOT raw PDFs — the deterministic numeric flags and the cited soft signals
   * are computed/extracted upstream; this call only NARRATES and PRIORITIZES
   * them (D-03), never originates them.
   */
  factSheet: string;
  /**
   * The analysis id — logged for traceability. The factSheet contents
   * (financials/GDPR) are NEVER logged.
   */
  analysisId: string;
}

/** The result of one synthesis: the parsed report + token usage. */
export interface SynthesizeResult {
  parsed: AiReport;
  usage: ClaudeUsage;
}

/** Maps the SDK's typed usage onto our `ClaudeUsage` cost shape. */
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

/**
 * Synthesizes the cross-source report from the assembled fact sheet via ONE
 * Sonnet call.
 *
 * - `messages.parse` with `zodOutputFormat(reportSchema)` guarantees the
 *   response shape (RPRT-01). `output_config.format` is the current shape (NOT
 *   the deprecated top-level `output_format`). No API-level citations and no
 *   thinking/effort — this is a single structured generation, not an agent loop.
 * - The fact block carries `cache_control: ephemeral` so a regenerate (D-08) or
 *   a `max_tokens` retry reads the larger block cheaply; the volatile
 *   per-request instruction stays AFTER the breakpoint so the cache prefix is
 *   stable (§4b.4).
 * - Branch on `stop_reason` BEFORE reading `parsed_output`: `"refusal"` throws
 *   `CLAUDE_REFUSAL` with NO retry (a guardrail trip won't fix on re-ask);
 *   `"max_tokens"` retries EXACTLY once, then throws `CLAUDE_MAX_TOKENS`; an
 *   empty `parsed_output` throws `CLAUDE_PARSE_EMPTY`.
 * - try/catch logs ONLY `{ analysisId, code }` server-side — NEVER the factSheet
 *   (financials/GDPR, AI-SPEC §7) — then rethrows a CODED error so the action
 *   layer can distinguish failure modes (WR-06). The user-facing Swedish message
 *   is produced at the action layer, not here.
 *
 * @param input - the assembled fact sheet plus the analysis id for safe logging
 * @returns the parsed report and token usage
 */
export async function synthesizeReport(
  input: SynthesizeInput,
): Promise<SynthesizeResult> {
  const { factSheet, analysisId } = input;

  try {
    const runOnce = () =>
      client.messages.parse({
        model: MODEL,
        max_tokens: 4096, // bounded — never unbounded in production (§4b.3)
        temperature: 0.4, // low; opinionated voice, but reproducible-ish
        system: REPORT_SYNTHESIS_SYSTEM_PROMPT, // stable prefix → cache-eligible
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: factSheet, // the structured bundle
                cache_control: { type: "ephemeral" }, // cache the larger fact block
              },
              { type: "text", text: USER_INSTRUCTION },
            ],
          },
        ],
        // CURRENT shape — output_config.format, NOT the deprecated top-level
        // output_format. Matches extract.ts exactly.
        output_config: { format: zodOutputFormat(reportSchema) },
      });

    let message = await runOnce();

    // Refusal: a guardrail trip — surface immediately, do NOT retry.
    if (message.stop_reason === "refusal") {
      throw new Error("CLAUDE_REFUSAL");
    }

    // Truncation: retry exactly once, then give up.
    if (message.stop_reason === "max_tokens") {
      message = await runOnce();
      if (message.stop_reason === "max_tokens") {
        throw new Error("CLAUDE_MAX_TOKENS");
      }
    }

    if (!message.parsed_output) {
      throw new Error("CLAUDE_PARSE_EMPTY");
    }

    return {
      parsed: message.parsed_output,
      usage: toClaudeUsage(message.usage),
    };
  } catch (error) {
    // GDPR / AI-SPEC §7: log ONLY the analysis id + a stable code, NEVER the
    // factSheet (financials).
    const code = isKnownSynthesisCode(error)
      ? (error as Error).message
      : "CLAUDE_CALL_FAILED";
    console.error("[report-synthesize]", { analysisId, code });
    // WR-06: rethrow a CODED error so the action layer can distinguish refusal
    // vs truncation vs parse-empty vs network failure; the user-facing Swedish
    // message is produced at the action layer.
    throw new Error(code, { cause: error });
  }
}

/** The deliberate, differentiated synthesis failure codes (WR-06). */
const KNOWN_SYNTHESIS_CODES = new Set([
  "CLAUDE_REFUSAL",
  "CLAUDE_MAX_TOKENS",
  "CLAUDE_PARSE_EMPTY",
]);

/** True when `error` is one of the deliberate stop-reason codes from `runOnce`. */
function isKnownSynthesisCode(error: unknown): boolean {
  return error instanceof Error && KNOWN_SYNTHESIS_CODES.has(error.message);
}
