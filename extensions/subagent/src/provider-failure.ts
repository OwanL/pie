import type { SingleResult } from "../types.js";

export const SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE_ENV =
  "PIE_SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE";

/** Provider failover is enabled unless the host explicitly mirrors it off. */
export function readFallbackOnProviderFailure(): boolean {
  const raw = process.env[SUBAGENT_FALLBACK_ON_PROVIDER_FAILURE_ENV];
  return raw === undefined || (raw !== "0" && raw !== "false");
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return `${error.name} ${error.message}${cause ? ` ${errorText(cause)}` : ""}`.toLowerCase();
  }
  return String(error ?? "").toLowerCase();
}

function numericField(value: unknown, keys: string[]): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

function resultHasAssistantOutput(result: SingleResult): boolean {
  return result.messages.some((message) => {
    if (message.role !== "assistant") return false;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content.length > 0;
    if (!Array.isArray(content)) return false;
    return content.some((part) => {
      if (!part || typeof part !== "object") return false;
      const record = part as Record<string, unknown>;
      return (record.type === "text" && typeof record.text === "string" && record.text.length > 0)
        || (record.type === "thinking" && typeof record.thinking === "string" && record.thinking.length > 0);
    });
  });
}

function resultHasToolActivity(result: SingleResult): boolean {
  if (result.replaySafety === "tool_side_effect") return true;
  return result.messages.some((message) => {
    if (message.role === "toolResult") return true;
    const content = (message as { content?: unknown }).content;
    return Array.isArray(content) && content.some((part) =>
      !!part && typeof part === "object" && (part as { type?: string }).type === "toolCall");
  });
}

/** Preserve the most conservative replay-safety observation made while streaming. */
export function markProviderReplayUnsafe(
  result: SingleResult,
  safety: "partial_output" | "tool_side_effect",
): void {
  if (safety === "tool_side_effect" || result.replaySafety === undefined || result.replaySafety === "safe") {
    result.replaySafety = safety;
  }
}

/**
 * Classify a failed provider attempt. Only transient transport/provider errors
 * become retryable; auth/client/model errors remain terminal. Replay is allowed
 * only before visible output or tool execution, preventing duplicate effects.
 */
export function classifyProviderFailure(result: SingleResult, error?: unknown): void {
  if (result.exitCode === 0) return;

  if (resultHasToolActivity(result)) result.replaySafety = "tool_side_effect";
  else if (result.replaySafety === "partial_output" || resultHasAssistantOutput(result)) result.replaySafety = "partial_output";
  else result.replaySafety = "safe";

  const structuredStatus = numericField(error, ["httpStatus", "status", "statusCode"]);
  const code = error && typeof error === "object"
    ? String((error as Record<string, unknown>).code ?? "").toLowerCase()
    : "";
  const text = `${errorText(error)} ${result.errorMessage ?? ""} ${result.stderr ?? ""}`.toLowerCase();
  const textualStatus = text.match(/\b(?:http(?: status)?|status(?: code)?|response code)\s*[:=]?\s*(4\d\d)\b/)?.[1]
    ?? text.match(/\b(4\d\d)\s*\(?\s*(?:bad request|unauthori[sz]ed|forbidden|not found|conflict|unprocessable entity|too many requests)\b/)?.[1];
  const status = structuredStatus ?? (textualStatus ? Number(textualStatus) : undefined);

  if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|invalid api key|authentication|auth failed|account suspended/.test(text)) {
    result.failureClass = "auth";
    result.retryable = false;
    return;
  }
  if (status === 429 || /rate[ -]?limit|too many requests|concurrency cap|account-pause circuit/.test(text)) {
    result.failureClass = "rate_limit";
    result.retryable = true;
    return;
  }
  if (status === 408) {
    result.failureClass = "timeout";
    result.retryable = true;
    return;
  }
  // Explicit client responses are terminal even when their wrapper mentions
  // exhausted retries; retrying a different model cannot repair a bad request.
  if (status !== undefined && status >= 400 && status <= 499) {
    result.failureClass = "unknown";
    result.retryable = false;
    return;
  }
  if (["etimedout", "esockettimedout"].includes(code) || /timed? out|timeout|header phase stalled/.test(text)) {
    result.failureClass = "timeout";
    result.retryable = true;
    return;
  }
  if ((status !== undefined && status >= 500 && status <= 599) || /\b(?:500|502|503|504)\b|server error|service unavailable|bad gateway/.test(text)) {
    result.failureClass = "server_error";
    result.retryable = true;
    return;
  }
  if (/aborterror|request was aborted|parent interrupted|subagent was aborted/.test(text)) {
    result.failureClass = "abort";
    result.retryable = false;
    return;
  }
  if (
    ["econnreset", "econnrefused", "econnaborted", "enetdown", "enetreset", "enetunreach", "ehostunreach", "epipe", "eai_again"].includes(code)
    || /fetch failed|network error|socket hang up|connection (?:reset|refused|closed)|stream ended without|transport circuit open|retries exhausted|max(?:imum)? retries exceeded/.test(text)
  ) {
    result.failureClass = "transport";
    result.retryable = true;
    return;
  }

  result.failureClass = "unknown";
  result.retryable = false;
}
