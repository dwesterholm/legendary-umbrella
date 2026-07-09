import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  intentFilterSchema,
  type DiscoveryFilter,
} from "@/lib/discovery/filter-schema";
import type { ClaudeUsage } from "@/lib/brf/cost";

/**
 * parseIntent — the free-text→structured-filter Haiku call (DISC-01). Mirrors
 * `src/lib/brf/extract.ts` EXACTLY: a module-scope vendor client reading a
 * server-only env var, `messages.parse` + `zodOutputFormat`, and a try/catch
 * that logs a stable code server-side (never the free text/PII) and rethrows
 * a coded error for the action layer to map to a Swedish message (WR-06
 * discipline, T-09-07/T-02-12 posture).
 *
 * T-09-07 (prompt injection): the free text is passed as
 * `messages:[{role:"user",content:freeText}]` ONLY — it is NEVER concatenated
 * into `system`. The untrusted text is DATA the model reads, not instructions
 * that can rewrite the system prompt or the (rigid, `zodOutputFormat`-
 * validated) output contract. `filterCandidates` (candidate.ts) then runs
 * deterministically in code on the resulting filter, so a successful
 * injection can at most produce a valid `DiscoveryFilter` object — it cannot
 * escape the schema or reach arbitrary code paths.
 */
const client = new Anthropic();

/** Haiku 4.5 — same dated model id as extract.ts (RESEARCH Pattern 3). */
const MODEL = "claude-haiku-4-5-20251001";

/**
 * Below this confidence, the parse fails safe rather than silently creating a
 * job the user did not intend (09-RESEARCH.md Pattern 3 recommendation).
 * [ASSUMED — no domain-specific eval exists yet; mirrors extract.ts's
 * qualitative hedge-on-uncertainty discipline].
 */
const CONFIDENCE_THRESHOLD = 0.6;

/**
 * Steering-only system prompt. Contains NO user text — it only instructs the
 * model how to extract the structured filter fields from whatever user
 * message follows.
 */
const INTENT_PARSE_SYSTEM_PROMPT = `Du extraherar en strukturerad sökfilter fran en svensk fritextbeskrivning av en bostad en anvandare letar efter.

Fyll i:
- areaQuery: fritextnamnet pa omradet/stadsdelen anvandaren namner (t.ex. "Sodermalm"). Om inget omrade namns, gor en rimlig bedomning eller lamna en tom strang.
- priceMax: hogsta pris i SEK om ett anges (t.ex. "under 4 miljoner" -> 4000000), annars null.
- roomsMin: minsta antal rum om det anges (t.ex. "3:a" -> 3), annars null.
- sizeMin: minsta boarea i kvm om den anges, annars null.
- objectType: "Lagenhet", "Villa", "Radhus" eller "Alla" om inget specifikt anges.
- confidence: din uppskattade sakerhet (0-1) att tolkningen fangar anvandarens avsikt. Ge ett LAGT varde om texten ar tvetydig, saknar ett omrade, eller inte later som en bostadssokning.

Extrahera ENDAST det som star i anvandarens meddelande. Hitta inte pa varden.`;

/** Successful parse: a confident, structured filter + Haiku token usage. */
export interface ParseIntentSuccess {
  ok: true;
  filter: DiscoveryFilter;
  confidence: number;
  usage: ClaudeUsage;
}

/**
 * Low-confidence fail-safe: the model produced a filter but is not confident
 * enough to silently drive a job — the caller must surface it for user
 * confirmation instead of proceeding.
 */
export interface ParseIntentNeedsConfirmation {
  ok: false;
  needsConfirmation: true;
  filter: DiscoveryFilter;
  confidence: number;
}

export type ParseIntentResult = ParseIntentSuccess | ParseIntentNeedsConfirmation;

/** The deliberate, differentiated parse failure codes (WR-06 discipline). */
const KNOWN_PARSE_CODES = new Set(["INTENT_PARSE_EMPTY"]);

function isKnownParseCode(error: unknown): boolean {
  return error instanceof Error && KNOWN_PARSE_CODES.has(error.message);
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
 * Parses free Swedish text into a structured `DiscoveryFilter` via ONE Haiku
 * call. Never throws on a low-confidence parse — that is an expected,
 * non-exceptional outcome the caller must surface for confirmation, not an
 * error. Only a genuine call/parse failure (network error, empty output)
 * throws, and only after logging a stable code (never the free text — GDPR /
 * T-02-12 discipline, mirrored from extract.ts).
 *
 * @param freeText - the user's untrusted free-text search description
 */
export async function parseIntent(freeText: string): Promise<ParseIntentResult> {
  try {
    const message = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 512,
      system: INTENT_PARSE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: freeText }],
      output_config: { format: zodOutputFormat(intentFilterSchema) },
    });

    if (!message.parsed_output) {
      throw new Error("INTENT_PARSE_EMPTY");
    }

    const filter = message.parsed_output as DiscoveryFilter;
    const usage = toClaudeUsage(
      message.usage as {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
      },
    );

    if (filter.confidence < CONFIDENCE_THRESHOLD) {
      return {
        ok: false,
        needsConfirmation: true,
        filter,
        confidence: filter.confidence,
      };
    }

    return { ok: true, filter, confidence: filter.confidence, usage };
  } catch (error) {
    // GDPR / T-02-12: log ONLY a stable code, never the free text (which may
    // contain user-supplied PII like a specific address or personal detail).
    const code = isKnownParseCode(error) ? (error as Error).message : "INTENT_CALL_FAILED";
    console.error("[parse-intent]", { code });
    throw new Error(code, { cause: error });
  }
}
