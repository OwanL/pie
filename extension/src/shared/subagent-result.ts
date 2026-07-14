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
 * The raw shape comes from the `subagent` extension: new calls carry one
 * compacted child in `results[]`; legacy stored parallel/chain calls may carry
 * several. The renderable extraction normalizes the two result-field
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

export interface SubagentUsageSummary {
  /** Cumulative input tokens consumed by this sub-agent session. */
  input: number;
  /** Cumulative output tokens consumed by this sub-agent session. */
  output: number;
  /** Cumulative cache-read tokens consumed by this sub-agent session. */
  cacheRead: number;
  /** Cumulative cache-write tokens consumed by this sub-agent session. */
  cacheWrite: number;
  /** Context occupied by the most recent provider turn. */
  contextTokens?: number;
  /** Cumulative attributed cost in provider billing units (normally USD). */
  cost?: number;
  /** Completed assistant turns in this child session. */
  turns?: number;
}

export interface SubagentSingleResult {
  agent: string;
  task: string;
  /** `-1` while the subagent is still running. */
  exitCode: number;
  messages: RawMessage[];
  /** Bounded terminal answer stored outside compacted child messages. */
  finalOutput?: string;
  transcriptCompacted?: boolean;
  fileChanges?: Array<{
    path: string;
    kind: 'created' | 'modified' | 'deleted';
    description?: string;
    additions?: number;
    deletions?: number;
  }>;
  /** The model the subagent session actually ran with. */
  model?: string;
  /** Provider that owns the selected model. */
  provider?: string;
  /** Maximum context window of the selected model. */
  contextWindow?: number;
  stderr?: string;
  stopReason?: string;
  errorMessage?: string;
  /** Tool names currently executing inside this subagent run. */
  runningTools?: string[];
  /** Live child lifecycle diagnostics emitted by the subagent extension. */
  activityPhase?: 'queued' | 'preparing' | 'waiting_provider' | 'streaming' | 'running_tool' | 'retry_wait' | 'completed' | 'failed' | 'cancelled' | 'orphaned_cleanup';
  activityDetail?: string;
  activitySince?: number;
  lastProgressAt?: number;
  inactivityBudgetMs?: number;
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
  /** Streaming reasoning (thinking) from the current in-progress assistant
   *  turn. Captures `thinking_delta` events so the collapsed preview can show
   *  live reasoning before reply text arrives (instead of a generic
   *  "Generating…" placeholder). Cleared when the assistant message commits. */
  streamingReasoning?: string;
  /** True while the subagent's model is actively generating the in-progress
   *  assistant turn (first delta received, message not yet ended). Drives the
   *  host token-rate clock so it advances through stalls + reasoning streams but
   *  pauses during the subagent's tool calls / between turns / pre-first-token. */
  streaming?: boolean;
  /** Per-turn throughput observations from this subagent session, forwarded to
   *  the parent run snapshot for historical tok/s attribution. */
  turnThroughputSamples?: { endedAt: string; outputTokens: number; generationDurationMs: number; status: string; modelId?: string }[];
  /** Cumulative token usage consumed by this sub-agent session, surfaced from
   *  the raw `toolCall.result` so the parent run can attribute subagent cost.
   *  Absent when the subagent extension did not report usage (e.g. it failed
   *  before producing any, or predates the field). */
  usage?: SubagentUsageSummary;
}

export interface SubagentResult {
  mode: 'single' | 'parallel' | 'chain';
  results: SubagentSingleResult[];
}

export function isSubagentSingleResultRunning(result: SubagentSingleResult): boolean {
  // exitCode is the lifecycle source of truth. runningTools is only activity
  // detail and may be stale when a nested tool never emits execution_end after
  // an abort/provider failure.
  return result.exitCode === -1;
}

export function isSubagentSingleResultInterrupted(result: SubagentSingleResult): boolean {
  return result.stopReason === 'aborted' || result.activityPhase === 'cancelled';
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
    return nonEmptyText(result.finalOutput) ?? '(no output)';
  }

  const detail = nonEmptyText(result.errorMessage) ?? nonEmptyText(result.stderr);
  const failureLabel =
    result.stopReason === 'aborted' ? 'Aborted'
    : result.stopReason === 'error' ? 'Error'
    : result.exitCode > 0 ? `Exit code ${result.exitCode}`
    : 'Failed';

  return detail ? `${failureLabel}: ${detail}` : `${failureLabel}: agent failed before producing any output.`;
}

function placeholderSingleResult(
  agent: unknown,
  task: unknown,
  taskScores?: unknown,
  activity: Pick<SubagentSingleResult, 'activityPhase' | 'activityDetail'> = {
    activityPhase: 'preparing',
    activityDetail: 'waiting for subagent runtime status',
  },
): SubagentSingleResult | undefined {
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
    ...activity,
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
      .map((task) => (isRecord(task) ? placeholderSingleResult(
        task.agent,
        task.task,
        task.taskScores ?? input.taskScores,
        { activityPhase: 'queued', activityDetail: 'waiting for parallel task dispatch' },
      ) : undefined))
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

function terminalResultMessage(rawResult: unknown): string | undefined {
  if (!isRecord(rawResult)) return undefined;
  const content = rawResult.content;
  if (typeof content === 'string') return nonEmptyText(content);
  if (!Array.isArray(content)) return undefined;

  const text = content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text.trim() : ''))
    .filter(Boolean)
    .join('\n');
  return nonEmptyText(text);
}

/** A force-settle or pre-dispatch failure can legitimately finish with
 * `details.results: []`. Falling back to the generic tool card hides every
 * requested child, which made the failed delegation appear to have vanished.
 * Reconstruct the child cards from the immutable tool input and stamp the
 * terminal tool error onto each placeholder. */
function synthesizeTerminalSubagentResult(input: unknown, rawResult: unknown): SubagentResult | undefined {
  const synthesized = synthesizeRenderableSubagentResult(input);
  if (!synthesized) return undefined;

  const errorMessage = terminalResultMessage(rawResult)
    ?? 'Subagent failed before reporting child results.';
  return {
    ...synthesized,
    results: synthesized.results.map((result) => ({
      ...result,
      exitCode: 1,
      stopReason: 'error',
      errorMessage,
    })),
  };
}

function normalizeRenderableSubagentResult(
  result: SubagentResult,
  toolStatus: ToolCall['status'],
): SubagentResult {
  if (toolStatus !== 'running') {
    return {
      ...result,
      results: result.results.map((current) => {
        const wasStillRunning = current.exitCode === -1;
        const interrupted = isSubagentSingleResultInterrupted(current);
        const terminalExitCode = wasStillRunning
          ? (toolStatus === 'completed' ? 0 : 1)
          : current.exitCode;
        const hadLiveState = current.streaming === true || (current.runningTools?.length ?? 0) > 0;
        if (!wasStillRunning && !hadLiveState) return current;

        return {
          ...current,
          exitCode: terminalExitCode,
          runningTools: [],
          streaming: false,
          ...(wasStillRunning && toolStatus === 'failed' && !current.stopReason
            ? { stopReason: interrupted ? 'aborted' : 'error' }
            : {}),
          activityPhase: interrupted
            ? 'cancelled'
            : terminalExitCode !== 0
              ? 'failed'
              : 'completed',
        };
      }),
    };
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
  const raw = rawResult as { kind?: unknown; mode?: unknown; children?: unknown; details?: unknown; results?: unknown } | undefined;

  // Protocol-v4 live state carries a typed, bounded subagent preview rather
  // than the extension's unbounded raw partial. Rehydrate the render model so
  // the running child reply/activity stays visible before tool.finished.
  if (raw?.kind === 'subagent' && Array.isArray(raw.children) && raw.children.length > 0) {
    const mode: SubagentResult['mode'] = raw.mode === 'parallel' || raw.mode === 'chain' ? raw.mode : 'single';
    const results = raw.children.flatMap((candidate): SubagentSingleResult[] => {
      if (!isRecord(candidate)) return [];
      const id = typeof candidate.id === 'string' ? candidate.id : 'subagent';
      const agent = typeof candidate.agent === 'string' ? candidate.agent : id;
      const task = typeof candidate.task === 'string'
        ? candidate.task
        : typeof candidate.summary === 'string' ? candidate.summary : 'Delegated task';
      const phase = typeof candidate.phase === 'string' ? candidate.phase : 'running';
      const explicitExit = typeof candidate.exitCode === 'number' ? candidate.exitCode : undefined;
      const exitCode = explicitExit ?? (phase === 'completed' ? 0 : phase === 'failed' || phase === 'cancelled' ? 1 : -1);
      const summary = typeof candidate.summary === 'string' ? candidate.summary : undefined;
      const streamingText = typeof candidate.streamingText === 'string' ? candidate.streamingText : undefined;
      const messages: RawMessage[] = summary && !streamingText
        ? [{ role: 'assistant', content: [{ type: 'text', text: summary }] }]
        : [];
      return [{
        agent,
        task,
        exitCode,
        messages,
        ...(typeof candidate.model === 'string' ? { model: candidate.model } : {}),
        ...(typeof candidate.provider === 'string' ? { provider: candidate.provider } : {}),
        ...(typeof candidate.activityDetail === 'string' ? { activityDetail: candidate.activityDetail } : {}),
        ...(typeof candidate.activitySince === 'number' ? { activitySince: candidate.activitySince } : {}),
        ...(typeof candidate.lastProgressAt === 'number' ? { lastProgressAt: candidate.lastProgressAt } : {}),
        ...(typeof candidate.inactivityBudgetMs === 'number' ? { inactivityBudgetMs: candidate.inactivityBudgetMs } : {}),
        ...(typeof candidate.streaming === 'boolean' ? { streaming: candidate.streaming } : {}),
        ...(streamingText ? { streamingText } : {}),
        ...(typeof candidate.streamingReasoning === 'string' ? { streamingReasoning: candidate.streamingReasoning } : {}),
        ...(Array.isArray(candidate.runningTools)
          ? { runningTools: candidate.runningTools.filter((tool): tool is string => typeof tool === 'string') }
          : {}),
        activityPhase: phase === 'cancelled'
          ? 'cancelled'
          : phase === 'failed' ? 'failed'
          : phase === 'completed' ? 'completed'
          : phase === 'queued' ? 'queued'
          : 'streaming',
      }];
    });
    if (results.length > 0) return { mode, results };
  }

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

  // Terminal calls with empty/missing child results are not successful empty
  // runs: the subagent protocol only emits that shape when execution failed
  // before it could return per-child details (notably the settlement net).
  // Keep the delegation visible and actionable instead of collapsing it into
  // an opaque generic tool row.
  if (toolCall.result !== undefined) {
    return synthesizeTerminalSubagentResult(toolCall.input, toolCall.result);
  }

  return undefined;
}

export {
  isSubagentSingleResultFailed,
  nonEmptyText,
  subagentSingleResultFallbackMarkdown,
};
