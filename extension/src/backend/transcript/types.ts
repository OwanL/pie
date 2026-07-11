export type MessageRole =
  | 'user'
  | 'assistant'
  | 'toolResult'
  | 'bashExecution'
  | 'custom'
  | 'branchSummary'
  | 'compactionSummary';

export interface ContentPart {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  data?: string;
  mimeType?: string;
  width?: number;
  height?: number;
}

export interface MessageLike {
  role: MessageRole;
  content?: string | ContentPart[];
  timestamp?: number;
  provider?: string;
  model?: string;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
  command?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  customType?: string;
  display?: boolean;
  summary?: string;
  stopReason?: string;
  errorMessage?: string;
  /** Raw provider usage block on assistant messages, when reported. */
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    // Anthropic/Sdk-style usage aliases.
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    // OpenAI-compatible usage aliases.
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_write_input_tokens?: number;
      cache_write_tokens?: number;
    };
    prompt_cache_hit_tokens?: number;
    // Ollama native usage fields.
    prompt_eval_count?: number;
    eval_count?: number;
    // Reasoning/thinking token aliases. A SUBSET of output (never added to
    // totals/cost separately) — surfaced so the UI can show how much of the
    // output was hidden reasoning. Common across OpenAI (`reasoning_tokens`,
    // nested under `completion_tokens_details` / `output_tokens_details`) and
    // Anthropic-style top-level fields.
    reasoningTokens?: number;
    reasoning_tokens?: number;
    output_tokens_details?: {
      reasoning_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}
