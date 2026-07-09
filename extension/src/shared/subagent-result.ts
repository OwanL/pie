import type { ToolCall } from './protocol';
import { isRecord } from './type-guards';

/**
 * Subagent result parsing — pure extraction of the {@link SubagentResult}
 * structure (and its per-task {@link SubagentSingleResult} entries) from a
 * `subagent` tool call's raw `result`/`input` fields.
 *
 * Lives in `shared/` because it is consumed by BOTH the webview (rendering
 * subagent cards) and the host-side token-rate measurement (counting output
 * tokens of running subagents). It is pure data shaping — no preact, no DOM,
 * no I/O — so it is safe to run in the extension host.
 *
 * The raw shape comes from the `subagent` extension (see
 * `extensions/subagent/src/modes.ts`): one tool call carries a `results[]`
 * array (one entry per task for parallel/chain modes, all sharing the same
 * `toolCallId`). The renderable extraction normalizes the two result-field
 * shapes (`{ results }` and `{ details: { results } }`), infers a running
 * status for results that lack one, and synthesizes a placeholder when a
 * running call has not yet produced any result.
 */

export interface RawContentPart {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  result?: unknown;
}

export interface RawMessage {
  role: 'user' | 'assistant' | 'toolResult';
  content?: string | RawContentPart[];
  timestamp?: number;
  toolCallId?: string;
  details?: unknown;
  isError?: boolean;
}

export interface SubagentSingleResult {
  agent: string;
  task: string;
  /** `-1` while the subagent is still running. */
  exitCode: number;
  messages: RawMessage[];
  /** The model the subagent session actually ran with. */
  model?: string;
  stderr?: string;
  stopReason?: string;
  errorMessage?: string;
  /** Tool names currently executing inside this subagent run. */
  runningTools?: string[];
  /** The model chosen by scored selection. */
  selectedModel?: string;
  /** Thinking level applied to this run. */
  thinkingLevel?: string;
  /** Merged task scores used for selection. */
  taskScores?: Record<string, number>;
  /** Top-K candidate models. */
  selectionPool?: string[];
  /** Fit scores for each pool candidate. */
  selectionFitScores?: number[];
  /** Number of model retries before success. */
  retryCount?: number;
  /** Streaming text from the current in-progress assistant turn. */
  streamingText?: string;
  /** True while the subagent's model is actively generating the in-progress
   *  assistant turn (first delta received, message not yet ended). Drives the
   *  host token-rate clock so it advances through stalls + reasoning streams but
   *  pauses during the subagent's tool calls / between turns / pre-first-token. */
  streaming?: boolean;
  /** Per-turn throughput observations from this subagent session, forwarded to
   *  the parent run snapshot for historical tok/s attribution. */
  turnThroughputSamples?: { endedAt: string; outputTokens: number; generationDurationMs: number; status: string; modelId?: string }[];
}

export interface SubagentResult {
  mode: 'single' | 'parallel' | 'chain';
  results: SubagentSingleResult[];
}

export function isSubagentSingleResultRunning(result: SubagentSingleResult): boolean {
  return result.exitCode === -1 || (result.runningTools?.length ?? 0) > 0;
}

function isSubagentSingleResultFailed(result: SubagentSingleResult): boolean {
  if (isSubagentSingleResultRunning(result)) {
    return false;
  }

  return result.exitCode !== 0 || result.stopReason === 'error' || result.stopReason === 'aborted';
}

function nonEmptyText(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function subagentSingleResultFallbackMarkdown(result: SubagentSingleResult): string {
  if (!isSubagentSingleResultFailed(result)) {
    return '(no output)';
  }

  const detail = nonEmptyText(result.errorMessage) ?? nonEmptyText(result.stderr);
  const failureLabel =
    result.stopReason === 'aborted' ? 'Aborted'
    : result.stopReason === 'error' ? 'Error'
    : result.exitCode > 0 ? `Exit code ${result.exitCode}`
    : 'Failed';

  return detail ? `${failureLabel}: ${detail}` : `${failureLabel}: agent failed before producing any output.`;
}

function placeholderSingleResult(agent: unknown, task: unknown, taskScores?: unknown): SubagentSingleResult | undefined {
  const agentName = typeof agent === 'string' ? agent.trim() : '';
  const taskText = typeof task === 'string' ? task.trim() : '';
  if (!agentName || !taskText) {
    return undefined;
  }

  return {
    agent: agentName,
    task: taskText,
    exitCode: -1,
    messages: [],
    ...(isRecord(taskScores) ? { taskScores: taskScores as Record<string, number> } : {}),
  };
}

function synthesizeRenderableSubagentResult(input: unknown): SubagentResult | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const single = placeholderSingleResult(input.agent, input.task, input.taskScores);
  if (single) {
    return {
      mode: 'single',
      results: [single],
    };
  }

  if (Array.isArray(input.tasks)) {
    const results = input.tasks
      .map((task) => (isRecord(task) ? placeholderSingleResult(task.agent, task.task, task.taskScores ?? input.taskScores) : undefined))
      .filter((task): task is SubagentSingleResult => Boolean(task));

    if (results.length > 0) {
      return {
        mode: 'parallel',
        results,
      };
    }
  }

  if (Array.isArray(input.chain) && input.chain.length > 0) {
    const firstStep = input.chain[0];
    const result = isRecord(firstStep) ? placeholderSingleResult(firstStep.agent, firstStep.task, firstStep.taskScores ?? input.taskScores) : undefined;
    if (result) {
      return {
        mode: 'chain',
        results: [result],
      };
    }
  }

  return undefined;
}

function normalizeRenderableSubagentResult(
  result: SubagentResult,
  toolStatus: ToolCall['status'],
): SubagentResult {
  if (toolStatus !== 'running') {
    return result;
  }

  return {
    ...result,
    results: result.results.map((current) => {
      if (current.exitCode !== 0 || current.stopReason || current.errorMessage) {
        return current;
      }

      const hasRunningTools = (current.runningTools?.length ?? 0) > 0;
      const hasMessages = Array.isArray(current.messages) && current.messages.length > 0;
      if (!hasRunningTools && hasMessages) {
        return current;
      }

      return {
        ...current,
        exitCode: -1,
      };
    }),
  };
}

export function getRenderableSubagentResult(rawResult: unknown): SubagentResult | undefined {
  const raw = rawResult as { details?: unknown; results?: unknown } | undefined;

  if (raw && typeof raw === 'object' && Array.isArray(raw.results) && raw.results.length > 0) {
    return raw as SubagentResult;
  }

  const nested = raw?.details as { results?: unknown } | undefined;
  if (nested && typeof nested === 'object' && Array.isArray(nested.results) && nested.results.length > 0) {
    return nested as SubagentResult;
  }

  return undefined;
}

export function getRenderableSubagentResultFromToolCall(
  toolCall: Pick<ToolCall, 'input' | 'result' | 'status'>,
): SubagentResult | undefined {
  const renderableResult = getRenderableSubagentResult(toolCall.result);
  if (renderableResult) {
    return normalizeRenderableSubagentResult(renderableResult, toolCall.status);
  }

  if (toolCall.status === 'running') {
    return synthesizeRenderableSubagentResult(toolCall.input);
  }

  return undefined;
}

export {
  isSubagentSingleResultFailed,
  nonEmptyText,
  subagentSingleResultFallbackMarkdown,
};
