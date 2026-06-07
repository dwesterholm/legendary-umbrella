import Anthropic from "@anthropic-ai/sdk";
import { toFile } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { brfExtractionSchema, type BrfExtraction } from "@/lib/schemas/brf";
import { BRF_EXTRACTION_SYSTEM_PROMPT } from "@/lib/brf/prompt";
import type { ClaudeUsage } from "@/lib/brf/cost";

/**
 * The single Claude extraction call (AI-SPEC §3/§4). Mirrors the
 * `booli-scraper` structure: a module-scope vendor client reading a server-only
 * env var, a try/catch that logs server-side and throws a Swedish user message.
 *
 * The Anthropic client is instantiated ONLY here (server module). It reads
 * `ANTHROPIC_API_KEY` from the environment and is never configured to allow
 * browser use — the key must never reach the browser (T-02-09).
 */
const client = new Anthropic();

/** Haiku 4.5 — the cheapest capable model for this extraction (AI-SPEC §4). */
const MODEL = "claude-haiku-4-5-20251001";

/** Above this size we switch from base64-inline to the Files API (RESEARCH pitfall 1). */
const BASE64_MAX_BYTES = 5 * 1024 * 1024; // ~5 MB

/** Beta header required for the Files API document source. */
const FILES_API_BETA = "files-api-2025-04-14";

const USER_INSTRUCTION =
  "Extrahera nyckeltalen enligt schemat. Lämna fält null om de inte finns.";

/** A per-field citation mapped from the model's returned char/page locations. */
export interface FieldCitation {
  sourceQuote: string | null;
  pageRef: number | null;
}

/** The result of one extraction: parsed figures + token usage + raw citations. */
export interface BrfExtractionResult {
  parsed: BrfExtraction;
  usage: ClaudeUsage;
  /** All citation locations the model attached to its output text blocks. */
  citations: FieldCitation[];
}

/** Input to the extraction call. */
export interface ExtractBrfInput {
  /** The PDF bytes. */
  bytes: Uint8Array;
  /**
   * A content hash of the PDF — logged for traceability WITHOUT exposing bytes
   * or financials (T-02-12 / GDPR). Never log the PDF itself.
   */
  contentHash: string;
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

/** Pulls `{ sourceQuote, pageRef }` pairs out of the model's text-block citations. */
function collectCitations(
  content: Array<{ type: string; citations?: unknown }>,
): FieldCitation[] {
  const out: FieldCitation[] = [];
  for (const block of content) {
    if (block.type !== "text" || !Array.isArray(block.citations)) continue;
    for (const c of block.citations as Array<Record<string, unknown>>) {
      const sourceQuote =
        typeof c.cited_text === "string" ? c.cited_text : null;
      const pageRef =
        typeof c.start_page_number === "number" ? c.start_page_number : null;
      out.push({ sourceQuote, pageRef });
    }
  }
  return out;
}

/**
 * Extracts the four BRF financial figures from a PDF via ONE Haiku call.
 *
 * - `messages.parse` with `zodOutputFormat(brfExtractionSchema)` guarantees the
 *   response shape; the document block carries `citations.enabled` (D-11 trust)
 *   and `cache_control: ephemeral` (D-13 cost — the PDF dominates input tokens,
 *   so caching it makes a retry/re-run cheap; T-02-13).
 * - Transport: base64-inline for PDFs ≤ ~5 MB; the Files API for larger/scanned
 *   PDFs (avoids the request-size cap — RESEARCH pitfall 1).
 * - `stop_reason === "refusal"` throws immediately with NO retry (do not loop on
 *   a guardrail trip). `"max_tokens"` retries once, then throws.
 * - try/catch logs ONLY the content hash + token usage server-side, NEVER raw
 *   bytes, financials, or quotes (T-02-12 / GDPR, AI-SPEC §7), then throws a
 *   Swedish user-facing message.
 *
 * @param input - the PDF bytes plus a content hash for safe logging
 * @returns parsed figures, token usage, and the raw citation locations
 */
export async function extractBrfFinancials(
  input: ExtractBrfInput,
): Promise<BrfExtractionResult> {
  const { bytes, contentHash } = input;

  try {
    const useFilesApi = bytes.byteLength > BASE64_MAX_BYTES;

    // Build the document source: base64-inline for small PDFs, Files API for large.
    let documentSource:
      | { type: "base64"; media_type: "application/pdf"; data: string }
      | { type: "file"; file_id: string };

    if (useFilesApi) {
      const uploaded = await client.beta.files.upload({
        file: await toFile(bytes, "brf.pdf", {
          type: "application/pdf",
        }),
        betas: [FILES_API_BETA],
      });
      documentSource = { type: "file", file_id: uploaded.id };
    } else {
      documentSource = {
        type: "base64",
        media_type: "application/pdf",
        data: Buffer.from(bytes).toString("base64"),
      };
    }

    const runOnce = () =>
      client.beta.messages.parse({
        model: MODEL,
        max_tokens: 2048,
        temperature: 0,
        system: BRF_EXTRACTION_SYSTEM_PROMPT,
        // Files API requires its beta header; harmless for the base64 path.
        ...(useFilesApi ? { betas: [FILES_API_BETA] } : {}),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: documentSource,
                citations: { enabled: true },
                cache_control: { type: "ephemeral" },
              },
              { type: "text", text: USER_INSTRUCTION },
            ],
          },
        ],
        output_config: { format: zodOutputFormat(brfExtractionSchema) },
      });

    let message = await runOnce();

    // Refusal: a guardrail trip — surface to manual entry, do NOT retry.
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
      citations: collectCitations(
        message.content as Array<{ type: string; citations?: unknown }>,
      ),
    };
  } catch (error) {
    // GDPR / T-02-12: log ONLY the content hash, never bytes/financials/quotes.
    console.error("[brf-extract]", { contentHash, error });
    throw new Error(
      "Kunde inte läsa ut föreningens ekonomi ur PDF:en. Kontrollera filen eller fyll i uppgifterna manuellt.",
    );
  }
}
