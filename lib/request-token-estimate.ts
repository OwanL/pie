import { countTokens } from './tokenization';

/**
 * Shared estimate of the token weight of the *request prefix* metadata that
 * precedes the conversation in a provider request: the system prompt and the
 * provider tool definitions.
 *
 * Both counts use the shared literal cl100k_base tokenizer
 * (`lib/tokenization.ts`): whitespace and reserved special-token spellings are
 * counted as ordinary text, so the system prompt is counted as-is rather than
 * trimmed. Tool definitions serialize the actual
 * `name`/`description`/`parameters` payload as one compact JSON array — no
 * Markdown catalog text and no pretty-printed whitespace — mirroring the
 * pinned pi-ai context-prefix estimation basis.
 *
 * This is an estimation basis, not a claim of an exact wire/provider total:
 * provider-specific request framing (chat wrappers, tool template overhead,
 * image/content encoding) is deliberately excluded, and provider `usage`
 * blocks remain the source of truth where available (see
 * `harness/session-storage/transcripts/context-usage.ts`).
 */

export interface RequestEstimateTool {
  name: string;
  description?: string;
  parameters?: unknown;
}

const UNSERIALIZABLE_JSON = '[unserializable]';

/** Project one tool onto its provider-request-relevant fields. The declared
 * key order keeps the array deterministic regardless of the caller's object
 * key order, and `JSON.stringify` drops properties assigned `undefined`, so
 * legacy tool definitions without optional description/parameters serialize
 * name-only with no other change to their schema values. */
function serializeToolDefinition(tool: RequestEstimateTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

/** Estimate tokens for the provider tool definitions as one compact JSON
 * array in the given order. Extra SDK bookkeeping fields (prompt snippets,
 * guidelines, source info) are not provider request content and are excluded.
 * An empty array contributes nothing. */
export function estimateToolDefinitionsTokens(tools: readonly RequestEstimateTool[]): number {
  if (tools.length === 0) return 0;
  let json: string;
  try {
    json = JSON.stringify(tools.map(serializeToolDefinition)) ?? UNSERIALIZABLE_JSON;
  } catch {
    json = UNSERIALIZABLE_JSON;
  }
  return countTokens(json);
}

/** Estimate the system prompt plus the provider tool definitions for one
 * request prefix on a single shared tokenizer basis. */
export function estimateRequestPrefixTokens(systemPrompt: string, tools: readonly RequestEstimateTool[]): number {
  return countTokens(systemPrompt) + estimateToolDefinitionsTokens(tools);
}