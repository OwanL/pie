import type { ToolCall } from './protocol';
import type { LifecycleValueSource, SubagentAttemptPhase, SubagentAttemptSample } from '../../../shared/run-analytics-contracts.js';
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
  /** Parent-context mode requested for this delegation. */
  parentUserContextMode?: 'latest' | 'all';
  /** Exact bounded parent-context packet inserted into the child prompt. */
  parentUserContext?: string;
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
  /** Stable child lifecycle bounds for total elapsed-time display. */
  startedAt?: number;
  completedAt?: number;
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
  /** Terminal model-attempt diagnostics emitted by the subagent extension. */
  attemptRecords?: unknown[];
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
  /** Cumulative estimated output tokens for this child and nested descendants.
   * Kept independently from renderable transcript content so rate measurement
   * remains cheap and monotonic during long recursive runs. */
  cumulativeOutputTokens?: number;
  /** Per-turn throughput observations from this subagent session, forwarded to
   *  the parent run snapshot for historical tok/s attribution. */
  turnThroughputSamples?: { endedAt: string; outputTokens: number; generationDurationMs: number; status: string; modelId?: string; provider?: string }[];
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

  // A child's explicit exitCode owns its lifecycle independently of the
  // still-running parent tool. This matters for parallel/chain calls, where a
  // completed child must settle visually while its siblings continue. Missing
  // child progress is handled by synthesized placeholders above; do not turn a
  // reported exitCode 0 back into a running result based on transcript shape or
  // stale runningTools activity detail.
  return result;
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
        ...(candidate.parentUserContextMode === 'latest' || candidate.parentUserContextMode === 'all'
          ? { parentUserContextMode: candidate.parentUserContextMode }
          : {}),
        ...(typeof candidate.parentUserContext === 'string' ? { parentUserContext: candidate.parentUserContext } : {}),
        ...(typeof candidate.model === 'string' ? { model: candidate.model } : {}),
        ...(typeof candidate.selectedModel === 'string' ? { selectedModel: candidate.selectedModel } : {}),
        ...(typeof candidate.provider === 'string' ? { provider: candidate.provider } : {}),
        ...(typeof candidate.thinkingLevel === 'string' ? { thinkingLevel: candidate.thinkingLevel } : {}),
        ...(typeof candidate.activityDetail === 'string' ? { activityDetail: candidate.activityDetail } : {}),
        ...(typeof candidate.activitySince === 'number' ? { activitySince: candidate.activitySince } : {}),
        ...(typeof candidate.startedAt === 'number' ? { startedAt: candidate.startedAt } : {}),
        ...(typeof candidate.completedAt === 'number' ? { completedAt: candidate.completedAt } : {}),
        ...(typeof candidate.lastProgressAt === 'number' ? { lastProgressAt: candidate.lastProgressAt } : {}),
        ...(typeof candidate.inactivityBudgetMs === 'number' ? { inactivityBudgetMs: candidate.inactivityBudgetMs } : {}),
        ...(typeof candidate.streaming === 'boolean' ? { streaming: candidate.streaming } : {}),
        ...(streamingText ? { streamingText } : {}),
        ...(typeof candidate.streamingReasoning === 'string' ? { streamingReasoning: candidate.streamingReasoning } : {}),
        ...(typeof candidate.cumulativeOutputTokens === 'number' && Number.isFinite(candidate.cumulativeOutputTokens)
          ? { cumulativeOutputTokens: candidate.cumulativeOutputTokens }
          : {}),
        ...(Array.isArray(candidate.runningTools)
          ? { runningTools: candidate.runningTools.filter((tool): tool is string => typeof tool === 'string') }
          : {}),
        ...(Array.isArray(candidate.messages) ? { messages: candidate.messages as RawMessage[] } : {}),
        ...(typeof candidate.finalOutput === 'string' ? { finalOutput: candidate.finalOutput } : {}),
        ...(typeof candidate.transcriptCompacted === 'boolean' ? { transcriptCompacted: candidate.transcriptCompacted } : {}),
        ...(typeof candidate.contextWindow === 'number' ? { contextWindow: candidate.contextWindow } : {}),
        ...(isRecord(candidate.usage) ? { usage: candidate.usage as unknown as SubagentUsageSummary } : {}),
        ...(isRecord(candidate.taskScores) ? { taskScores: candidate.taskScores as Record<string, number> } : {}),
        ...(Array.isArray(candidate.selectionPool) ? { selectionPool: candidate.selectionPool.filter((model): model is string => typeof model === 'string') } : {}),
        ...(Array.isArray(candidate.selectionFitScores) ? { selectionFitScores: candidate.selectionFitScores.filter((score): score is number => typeof score === 'number') } : {}),
        ...(typeof candidate.retryCount === 'number' ? { retryCount: candidate.retryCount } : {}),
        ...(typeof candidate.stopReason === 'string' ? { stopReason: candidate.stopReason } : {}),
        ...(typeof candidate.errorMessage === 'string' ? { errorMessage: candidate.errorMessage } : {}),
        ...(typeof candidate.stderr === 'string' ? { stderr: candidate.stderr } : {}),
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

/**
 * Safely parse the bounded terminal attempt records emitted by the subagent
 * extension. This deliberately reads the raw terminal payload rather than the
 * renderable cast above: analytics must reject malformed extension data instead
 * of letting it become a zero-valued lifecycle observation.
 */
export function getTerminalSubagentAttemptSamplesFromToolCall(
  toolCall: Pick<ToolCall, 'id' | 'result' | 'status'>,
): { samples: SubagentAttemptSample[]; coverageComplete: boolean } {
  if (!toolCall.id || toolCall.status === 'running' || !isRecord(toolCall.result)) {
    return { samples: [], coverageComplete: false };
  }
  const direct = Array.isArray(toolCall.result.results)
    ? toolCall.result.results
    : isRecord(toolCall.result.details) && Array.isArray(toolCall.result.details.results)
      ? toolCall.result.details.results
      : [];
  const samples: SubagentAttemptSample[] = [];
  const seen = new Set<string>();
  let coverageComplete = direct.length > 0;
  const seenResults = new Set<object>();
  const visitResults = (results: unknown[], path: string, depth: number): void => {
    if (depth > 8) return;
    for (const [resultIndex, result] of results.entries()) {
      if (!isRecord(result)) {
        coverageComplete = false;
        continue;
      }
      if (seenResults.has(result)) continue;
      seenResults.add(result);
      const resultPath = `${path}${resultIndex}`;
      if (!Array.isArray(result.attemptRecords) || result.attemptRecords.length === 0) {
        coverageComplete = false;
      } else for (const [retryIndex, record] of result.attemptRecords.entries()) {
        if (!isRecord(record) || typeof record.attemptId !== 'string' || !record.attemptId.trim()
          || (record.outcome !== 'success' && record.outcome !== 'failure' && record.outcome !== 'aborted')) {
          coverageComplete = false;
          continue;
        }
        const attemptId = record.attemptId.trim();
        const sourceId = `${toolCall.id}:${resultPath}:${attemptId}`;
        if (seen.has(sourceId)) continue;
        seen.add(sourceId);
        const startedAt = finiteNonNegative(record.startedAt);
        const completedAt = finiteNonNegative(record.completedAt);
        const measuredDuration = startedAt !== null && completedAt !== null && completedAt >= startedAt
          ? completedAt - startedAt
          : null;
        // Reserved for a future extension producer. An estimate is accepted only
        // when explicitly labelled; no parent/tool duration is used as a proxy.
        const estimatedDuration = measuredDuration === null ? finiteNonNegative(record.estimatedDurationMs) : null;
        const backoffMs = finiteNonNegative(record.backoffMs);
        const phaseDurationsMs = parsePhaseDurations(record.phaseDurationsMs);
        const attemptSettlementOutcome = nonEmptyUnknownString(record.attemptSettlementOutcome);
        const cleanupOutcome = nonEmptyUnknownString(record.cleanupOutcome);
        samples.push({
          sourceId,
          attemptId,
          retryIndex,
          provider: nonEmptyUnknownString(record.provider),
          model: nonEmptyUnknownString(record.model),
          outcome: record.outcome,
          failureClass: nonEmptyUnknownString(record.failureClass),
          replaySafety: nonEmptyUnknownString(record.replaySafety),
          durationMs: measuredDuration ?? estimatedDuration,
          durationSource: lifecycleSource(measuredDuration, estimatedDuration, 'measured'),
          backoffMs,
          backoffSource: backoffMs === null ? 'unknown' : 'reported',
          phaseDurationsMs,
          phaseDurationsSource: phaseDurationsMs === null ? 'unknown' : 'measured',
          attemptSettlementOutcome: attemptSettlementOutcome ?? null,
          attemptSettlementSource: attemptSettlementOutcome ? 'reported' : 'unknown',
          parentSettlementSource: 'unknown',
          cleanupOutcome: cleanupOutcome ?? null,
          cleanupSource: cleanupOutcome ? 'reported' : 'unknown',
        });
      }
      if (!Array.isArray(result.messages)) continue;
      for (const message of result.messages) {
        if (!isRecord(message) || message.role !== 'toolResult' || message.toolName !== 'subagent') continue;
        if (isRecord(message.details) && Array.isArray(message.details.results)) {
          visitResults(message.details.results, `${resultPath}.`, depth + 1);
        }
      }
    }
  };
  visitResults(direct, '', 0);
  return { samples, coverageComplete };
}

const ATTEMPT_PHASES: readonly SubagentAttemptPhase[] = [
  'queued', 'preparing', 'waiting_provider', 'streaming', 'running_tool', 'orphaned_cleanup',
];

/** Accept only the fixed, finite producer map. retry_wait is intentionally not
 * accepted because retry.ts reports its backoff separately. */
function parsePhaseDurations(value: unknown): Partial<Record<SubagentAttemptPhase, number>> | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !ATTEMPT_PHASES.includes(key as SubagentAttemptPhase))) return null;
  const parsed: Partial<Record<SubagentAttemptPhase, number>> = {};
  for (const phase of ATTEMPT_PHASES) {
    if (!(phase in value)) continue;
    const duration = finiteNonNegative(value[phase]);
    if (duration === null) return null;
    parsed[phase] = duration;
  }
  return parsed;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? Math.trunc(value) : null;
}

function nonEmptyUnknownString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function lifecycleSource(
  measured: number | null,
  estimated: number | null,
  measuredSource: LifecycleValueSource,
): LifecycleValueSource {
  return measured !== null ? measuredSource : estimated !== null ? 'estimated' : 'unknown';
}

export function getRenderableSubagentResultFromToolCall(
  toolCall: Pick<ToolCall, 'input' | 'result' | 'status' | 'detailRef'>,
): SubagentResult | undefined {
  const renderableResult = getRenderableSubagentResult(toolCall.result);
  if (renderableResult) {
    return normalizeRenderableSubagentResult(renderableResult, toolCall.status);
  }

  if (toolCall.status === 'running' || toolCall.detailRef) {
    // Large subagent results are omitted from ordinary snapshots. Keep their
    // purpose-built card mounted from the first paint while the full detail is
    // fetched, rather than briefly degrading to the generic tool row. Normalize
    // the placeholder so terminal lazy calls cannot be counted as still running.
    const synthesized = synthesizeRenderableSubagentResult(toolCall.input);
    return synthesized ? normalizeRenderableSubagentResult(synthesized, toolCall.status) : undefined;
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
