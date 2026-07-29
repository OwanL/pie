/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useContext, useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import type { ChatPrefs, ToolCall } from '../../../shared/protocol';
import { shouldOpenSubagentContextMenu } from './interactions';
import { handleTranscriptClick } from './transcript-click-handler';
import { getToolCallContextType } from '../chat-prefs';
import { AskUserContext } from '../hooks/ask-user-context';

import { cx } from '../utils/cx';
import { toMouseEvent } from '../utils/preact-events';
import { CollapsibleChevron } from '../components/chevron';
import { CollapsibleCloseFooter } from '../components/collapsible-close-footer';
import { CollapsibleGutter } from '../components/collapsible-gutter';
import { ResizeHandle } from '../components/resize-handle';
import { Tooltip } from '../components/tooltip';
import { useResizableHeight } from '../components/use-resizable-height';
import {
  getRenderableSubagentResultFromToolCall,
  isSubagentSingleResultInterrupted,
  isSubagentSingleResultRunning,
  subagentSingleResultToChatMessages,
  type SubagentResult,
  type SubagentSingleResult,
} from './subagent';
import { StatusChip } from './status-chip';
import { ToolCallCard } from './tool-call-card';
import { TranscriptMessageList } from './transcript-message-list';
import type { RenderToolCall, TranscriptContextMenuHandler } from './types';
import { getToolRenderer } from './registry';
import { useCollapsibleOpen } from './use-collapsible-open';
import { type LazyDetailState, useLazyDetail } from './lazy-detail-store';
import { useStickToBottom } from './use-stick-to-bottom';
import { SubagentCallContext } from './subagent-call-context';
import { ACTIVITY_TAIL_MAX_LINES } from './activity-tail';
import { TurnActivityTailBody, isIdle, subagentPreviewTail } from './activity-tail-preview';
import { useCommittedToolLeaf } from './commit-registry';

interface ToolCallItemProps {
  toolCall: ToolCall;
  prefs: ChatPrefs;
  workingDirectory: string | null;
  onOpenFile: (path: string) => void;
  onContextMenu: TranscriptContextMenuHandler;
  renderToolCall: RenderToolCall;
}

interface SubagentBlockProps {
  toolCall: ToolCall;
  subagentResult?: SubagentResult;
  detailState?: LazyDetailState;
  onLoadDetail?: () => void;
  onRetryDetail?: () => void;
  prefs: ChatPrefs;
  workingDirectory: string | null;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: MouseEvent) => void;
  onNestedContextMenu: TranscriptContextMenuHandler;
  renderToolCall: RenderToolCall;
}

function formatActivityDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function compactTelemetryNumber(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function normalizedUsageTokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** All provider-reported token classes are disjoint in pi's normalized usage
 * shape, so their sum is the truthful aggregate consumed by the child. */
export function aggregateSubagentUsageTokens(usage: SubagentSingleResult['usage']): number {
  if (!usage) return 0;
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
    .reduce((total, value) => total + normalizedUsageTokens(value), 0);
}

function formatContextPercent(tokens: number, contextWindow: number): string {
  const percent = (tokens / contextWindow) * 100;
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

interface SubagentActivity {
  label: string;
  detail?: string;
  elapsed?: string;
  diagnostic: string;
}

export function subagentActivity(result: SubagentSingleResult, now: number): SubagentActivity | undefined {
  if (!isSubagentSingleResultRunning(result)) return undefined;
  const labels: Record<string, string> = {
    queued: 'Waiting for concurrency',
    preparing: 'Starting',
    waiting_provider: 'Waiting for provider',
    streaming: 'Waiting for output',
    running_tool: 'Running tool',
    retry_wait: 'Retrying provider',
  };
  const runningTools = result.runningTools?.filter(Boolean).join(', ');
  const hasStreamingText = !!result.streamingText?.trim();
  const hasStreamingReasoning = !!result.streamingReasoning?.trim();
  const isReceivingOutput = result.streaming === true || hasStreamingText || hasStreamingReasoning;
  // Concrete output/tool activity is more trustworthy than lifecycle metadata,
  // which can briefly lag behind streamed child updates. Name the concrete
  // stream rather than spending header space on the ambiguous "Generating".
  const label = runningTools
    ? 'Running tool'
    : hasStreamingText
      ? 'Responding'
      : hasStreamingReasoning
        ? 'Reasoning'
        : isReceivingOutput
          ? 'Waiting for output'
          : result.activityPhase
            ? labels[result.activityPhase]
            : 'Starting';
  if (!label) return undefined;
  const detail = runningTools
    ? runningTools
    : isReceivingOutput
      ? undefined
      : result.activityPhase === 'waiting_provider' && result.provider
        ? result.provider
        : result.activityDetail ?? (!result.activityPhase ? 'waiting for first status update' : undefined);
  const phaseElapsed = result.activitySince ? formatActivityDuration(now - result.activitySince) : undefined;
  const budget = result.inactivityBudgetMs ? formatActivityDuration(result.inactivityBudgetMs) : undefined;
  const diagnostic = [label, detail, phaseElapsed && `${phaseElapsed} in this state`, budget && `${budget} stall limit`]
    .filter(Boolean)
    .join(' · ');
  return { label, detail, elapsed: phaseElapsed, diagnostic };
}

function isFailed(result: SubagentSingleResult): boolean {
  if (isSubagentSingleResultRunning(result)) return false;
  return result.exitCode !== 0 || result.stopReason === 'error' || result.stopReason === 'aborted';
}

/** Extract a human-readable error summary from a single result. */
function subagentErrorDetail(result: SubagentSingleResult): string | undefined {
  if (!isFailed(result)) return undefined;
  const parts: string[] = [];
  const label =
    isSubagentSingleResultInterrupted(result) ? 'Interrupted'
    : result.stopReason === 'error' ? 'Error'
    : result.exitCode > 0 ? `Exit code ${result.exitCode}`
    : 'Failed';
  parts.push(label);
  if (result.errorMessage) parts.push(result.errorMessage);
  if (result.stderr) parts.push(result.stderr);
  return parts.join(': ');
}

/** Compact model label shown in the subagent header. */
function ModelLabel({ result }: { result: SubagentSingleResult }) {
  const model = result.selectedModel ?? result.model;
  if (!model) return null;
  // Show short name: last segment after '/' or full if no slash
  const short = model.includes('/') ? model.split('/').pop()! : model;
  const title = result.thinkingLevel
    ? `${model} (thinking: ${result.thinkingLevel})`
    : model;
  return (
    <span class="subagent-model-label transcript-header-summary-subtle" title={title}>
      {short}{result.thinkingLevel && result.thinkingLevel !== 'off' ? ` · ${result.thinkingLevel}` : ''}
    </span>
  );
}

type ParentUserContextMode = 'latest' | 'all';

interface ContextHandoffSummary {
  label: string;
  mode?: ParentUserContextMode;
  content?: string;
  state: 'inherited' | 'empty' | 'unavailable' | 'task-only';
  promptCount: number;
  clarificationCount: number;
}

function requestedParentUserContextMode(input: unknown): ParentUserContextMode | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const mode = (input as Record<string, unknown>).userContext;
  return mode === 'latest' || mode === 'all' ? mode : undefined;
}

/** Describe the actual handoff separately from the requested tool argument.
 * New results carry the exact packet; the request is only a legacy/live-start
 * fallback when that producer metadata is not available yet. */
export function subagentContextHandoffSummary(
  result: SubagentSingleResult,
  requestedMode?: ParentUserContextMode,
): ContextHandoffSummary {
  const mode = result.parentUserContextMode ?? requestedMode;
  const rawContent = result.parentUserContext;
  const content = rawContent?.trim() ? rawContent : undefined;
  const promptCount = content?.match(/^\[User prompt\]$/gm)?.length ?? 0;
  const clarificationCount = content?.match(/^\[Recorded clarification\]$/gm)?.length ?? 0;
  if (content) {
    return { label: `context ${mode ?? 'inherited'}`, mode, content, state: 'inherited', promptCount, clarificationCount };
  }
  if (result.parentUserContextMode) {
    return { label: `context ${result.parentUserContextMode} · empty`, mode: result.parentUserContextMode, state: 'empty', promptCount: 0, clarificationCount: 0 };
  }
  if (requestedMode) {
    return { label: `context ${requestedMode}`, mode: requestedMode, state: 'unavailable', promptCount: 0, clarificationCount: 0 };
  }
  return { label: 'context task only', state: 'task-only', promptCount: 0, clarificationCount: 0 };
}

function ContextHandoffLabel({ result, requestedMode }: { result: SubagentSingleResult; requestedMode?: ParentUserContextMode }) {
  const summary = subagentContextHandoffSummary(result, requestedMode);
  const sourceSummary = [
    summary.promptCount > 0 ? `${summary.promptCount} user ${summary.promptCount === 1 ? 'prompt' : 'prompts'}` : undefined,
    summary.clarificationCount > 0 ? `${summary.clarificationCount} recorded ${summary.clarificationCount === 1 ? 'clarification' : 'clarifications'}` : undefined,
  ].filter(Boolean).join(' · ');
  const explanation = summary.state === 'inherited'
    ? `${sourceSummary || 'Parent user context'} inserted into the isolated child prompt.`
    : summary.state === 'empty'
      ? `The ${summary.mode} mode was requested, but no eligible parent prompt or completed clarification was available; only the task was sent.`
      : summary.state === 'unavailable'
        ? `The tool requested ${summary.mode} context. The exact inherited packet is not available in this live-start or older saved result.`
        : 'No parent user context was requested; the child received only the delegated task.';

  return (
    <Tooltip
      placement="bottom"
      freezeWhileVisible
      contentNode={(
        <div class="subagent-context-tooltip">
          <div class="subagent-context-tooltip-title">{summary.label}</div>
          <div class="subagent-context-tooltip-summary">{explanation}</div>
          <div class="subagent-context-tooltip-section">Delegated task</div>
          <pre class="subagent-context-tooltip-content">{result.task}</pre>
          {summary.content && (
            <>
              <div class="subagent-context-tooltip-section">Exact inherited parent context</div>
              <pre class="subagent-context-tooltip-content">{summary.content}</pre>
            </>
          )}
        </div>
      )}
    >
      <span class="subagent-context-label subagent-telemetry-item">{summary.label}</span>
    </Tooltip>
  );
}

/** High-priority metadata that should remain visible before summary text. */
function PrimaryMeta({ result }: { result: SubagentSingleResult }) {
  const hasModel = !!(result.selectedModel ?? result.model);
  if (!hasModel) return null;

  return (
    <span class="subagent-primary-meta">
      <ModelLabel result={result} />
    </span>
  );
}

/** Runtime telemetry stays visible in the collapsed header at every panel
 * width. Items wrap rather than silently disappearing; full precision also
 * remains available in the tooltip. */
function ElapsedTelemetry({ result, now }: { result: SubagentSingleResult; now: number }) {
  const startedAt = result.startedAt ?? result.activitySince;
  if (!startedAt) return null;
  const endedAt = result.completedAt ?? (isSubagentSingleResultRunning(result) ? now : result.lastProgressAt ?? now);
  const elapsed = formatActivityDuration(Math.max(0, endedAt - startedAt));
  return <span class="subagent-telemetry-item subagent-telemetry-elapsed" title={`Total elapsed: ${elapsed}`}>{elapsed}</span>;
}

function RuntimeTelemetry({ result }: { result: SubagentSingleResult }) {
  const usage = result.usage;
  const contextTokens = usage?.contextTokens;
  const contextWindow = result.contextWindow;
  const hasContext = typeof contextTokens === 'number' && contextTokens > 0
    && typeof contextWindow === 'number' && contextWindow > 0;
  const latestThroughput = result.turnThroughputSamples
    ?.filter((sample) => sample.generationDurationMs > 0 && sample.outputTokens >= 0)
    .at(-1);
  const tokensPerSecond = latestThroughput
    ? latestThroughput.outputTokens / (latestThroughput.generationDurationMs / 1000)
    : undefined;
  const totalTokens = aggregateSubagentUsageTokens(usage);
  const hasTokens = totalTokens > 0;
  const usageBreakdown = usage ? {
    input: normalizedUsageTokens(usage.input),
    output: normalizedUsageTokens(usage.output),
    cacheRead: normalizedUsageTokens(usage.cacheRead),
    cacheWrite: normalizedUsageTokens(usage.cacheWrite),
  } : undefined;
  const hasCost = typeof usage?.cost === 'number' && usage.cost > 0;
  const hasRetries = typeof result.retryCount === 'number' && result.retryCount > 0;
  if (!hasContext && !hasTokens && !hasCost && tokensPerSecond == null && !hasRetries) return null;

  const title = [
    hasContext ? `Context: ${contextTokens!.toLocaleString()} / ${contextWindow!.toLocaleString()} tokens (${formatContextPercent(contextTokens!, contextWindow!)})` : undefined,
    hasTokens && usageBreakdown ? `Usage: ${totalTokens.toLocaleString()} total tokens (${usageBreakdown.input.toLocaleString()} input, ${usageBreakdown.output.toLocaleString()} output, ${usageBreakdown.cacheRead.toLocaleString()} cache read, ${usageBreakdown.cacheWrite.toLocaleString()} cache write)` : undefined,
    tokensPerSecond != null ? `Latest completed generation: ${tokensPerSecond.toFixed(1)} tokens/s` : undefined,
    usage?.cost ? `Cost: $${usage.cost.toFixed(4)}` : undefined,
    hasRetries ? `${result.retryCount} provider ${result.retryCount === 1 ? 'retry' : 'retries'}` : undefined,
  ].filter(Boolean).join(' · ');

  return (
    <span class="subagent-runtime-telemetry" title={title} aria-label={title}>
      {hasContext && (
        <span class="subagent-telemetry-item subagent-telemetry-context">
          ctx {compactTelemetryNumber(contextTokens!)} / {compactTelemetryNumber(contextWindow!)}
          <span class="subagent-telemetry-percent"> {formatContextPercent(contextTokens!, contextWindow!)}</span>
        </span>
      )}
      {hasTokens && <span class="subagent-telemetry-item subagent-telemetry-tokens">tok {compactTelemetryNumber(totalTokens)}</span>}
      {tokensPerSecond != null && <span class="subagent-telemetry-item subagent-telemetry-rate">last {tokensPerSecond.toFixed(1)} tok/s</span>}
      {hasCost && <span class="subagent-telemetry-item subagent-telemetry-cost">${usage!.cost!.toFixed(3)}</span>}
      {hasRetries && <span class="subagent-telemetry-item subagent-telemetry-retries">retry {result.retryCount}</span>}
    </span>
  );
}

type SubagentVisualStatus = 'idle' | 'running' | 'interrupted' | 'failed' | 'completed';

/** Status indicator chip at the right side of the header. */
function StatusIndicator({ status, errorDetail }: { status: SubagentVisualStatus; errorDetail?: string }) {
  if (status === 'completed') {
    return <StatusChip tone="completed" label="Finished" className="status-chip-fixed" />;
  }
  if (status !== 'failed' && status !== 'interrupted') return null;
  const interrupted = status === 'interrupted';

  return (
    <StatusChip
      tone={interrupted ? 'interrupted' : 'failed'}
      label={interrupted ? 'Interrupted' : 'Failed'}
      className="status-chip-fixed"
      copyText={errorDetail}
      copyAriaLabel={`Copy subagent ${interrupted ? 'interruption' : 'error'} detail`}
    />
  );
}

export function singleResultStatus(
  result: SubagentSingleResult,
  toolCallStatus: ToolCall['status'],
  multipleResults: boolean,
): SubagentVisualStatus {
  // A child interruption is distinct from a provider/tool failure. Check it
  // before the outer tool status because pi reports interrupted tool calls as
  // failed at the generic lifecycle layer.
  if (isSubagentSingleResultInterrupted(result)) return 'interrupted';

  // The outer tool lifecycle is authoritative once terminal. Older or raced
  // child results can retain a stale runningTools entry even though execution
  // has finished; do not leave those cards visually running forever. In a
  // parallel call, however, one failed sibling makes the outer tool fail, so a
  // child that explicitly completed must stay completed.
  if (toolCallStatus !== 'running') {
    if (isFailed(result)) return 'failed';
    if (toolCallStatus === 'failed' && (!multipleResults || result.exitCode === -1)) return 'failed';
    return 'completed';
  }
  if (isFailed(result)) return 'failed';
  // Block snapshots (sequential/parallel calls) can publish a child's terminal
  // phase before the enclosing tool result refreshes its sentinel exitCode.
  // Honour that explicit per-child terminal marker so a settled row gets the
  // completed treatment while its siblings continue running.
  if (result.activityPhase === 'completed' || result.completedAt != null) return 'completed';
  if (isSubagentSingleResultRunning(result)) {
    // A running call that has produced no activity yet is "idle" (queued /
    // not started).
    if (isIdle(result)) return 'idle';
    return 'running';
  }
  // An explicit terminal child result settles independently of the parent tool.
  // This applies equally to isolated, parallel, and sequential delegations.
  return 'completed';
}

interface SubagentSingleBlockProps {
  singleResult: SubagentSingleResult;
  toolCall: ToolCall;
  detailState?: LazyDetailState;
  onLoadDetail?: () => void;
  onRetryDetail?: () => void;
  index: number;
  prefs: ChatPrefs;
  workingDirectory: string | null;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: MouseEvent) => void;
  onNestedContextMenu: TranscriptContextMenuHandler;
  renderToolCall: RenderToolCall;
  multipleResults: boolean;
}

interface SubagentMessagesProps {
  singleResult: SubagentSingleResult;
  toolCall: ToolCall;
  index: number;
  prefs: ChatPrefs;
  workingDirectory: string | null;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: MouseEvent) => void;
  onNestedContextMenu: TranscriptContextMenuHandler;
  renderToolCall: RenderToolCall;
  /** When true, this body belongs to a nested (depth ≥ 2) subagent: it flows
   *  naturally inside the parent's bounded scroll region instead of
   *  establishing its own nested scroll container (see SubagentSingleBlock). */
  isNested?: boolean;
  /** id for this body region so the subagent header can reference it via
   *  `aria-controls` (set on the root `.subagent-messages` div). */
  bodyId?: string;
  /** Collapse the owning subagent (bottom `CollapsibleCloseFooter`). */
  onClose?: () => void;
}

/**
 * Bounded, vertically-resizable scroll region for a subagent's nested
 * transcript. Defaults to the bottom (most-recent reasoning/reply) and stays
 * pinned there as the subagent streams, unless the user scrolls up. A drag
 * handle on the top edge resizes the region.
 */
function SubagentMessages({
  singleResult,
  toolCall,
  index,
  prefs,
  workingDirectory,
  onOpenFile,
  onContextMenu,
  onNestedContextMenu,
  renderToolCall,
  isNested,
  bodyId,
  onClose,
}: SubagentMessagesProps) {
  const messages = useMemo(
    () => subagentSingleResultToChatMessages(singleResult, `${toolCall.id}-${index}`),
    [singleResult, toolCall.id, index],
  );
  const nestedCollapsibleDefaultsKey = `${prefs.autoExpandReasoning ? 'r1' : 'r0'}-${prefs.autoExpandToolCalls ? 't1' : 't0'}`;
  const { scrollRef, height, startResize, minHeight, maxHeight, canResize, resizeBy, reset } = useResizableHeight<HTMLDivElement>();
  const { handleScroll } = useStickToBottom<HTMLDivElement>(scrollRef, [messages]);

  return (
    <div
      id={bodyId}
      class="subagent-messages"
      onClick={(e) => {
        // Run the delegated code-block copy/toggle handler (buttons are rendered
        // via dangerouslySetInnerHTML), then stop propagation so the click
        // doesn't bubble to the subagent card's toggle / outer transcript.
        handleTranscriptClick(e);
        e.stopPropagation();
      }}
      onContextMenu={(e) => {
        if (!shouldOpenSubagentContextMenu(e.target)) {
          e.stopPropagation();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(toMouseEvent(e));
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {canResize && !isNested && (
        <ResizeHandle
          edge="top"
          onMouseDown={startResize('top')}
          height={height}
          minHeight={minHeight}
          maxHeight={maxHeight}
          onResizeBy={resizeBy}
          onReset={reset}
        />
      )}
      <div
        class={cx('subagent-messages-scroll', isNested && 'subagent-messages-scroll-nested')}
        ref={scrollRef}
        onScroll={handleScroll}
        style={height ? { height: `${height}px`, maxHeight: 'none' } : undefined}
      >
        {singleResult.selectionPool && singleResult.selectionPool.length > 0 && (
          <div class="subagent-model-selection">
            <span class="subagent-model-selection-title">Model selection</span>
            <div class="subagent-model-selection-pool">
              {singleResult.selectionPool.map((candidate, idx) => {
                const isChosen = candidate === (singleResult.selectedModel ?? singleResult.model);
                return (
                  <span key={idx} class={`subagent-pool-candidate${isChosen ? ' chosen' : ''}`}>
                    <span class="subagent-pool-name">{candidate.includes('/') ? candidate.split('/').pop() : candidate}</span>
                  </span>
                );
              })}
            </div>
            {singleResult.retryCount != null && singleResult.retryCount > 0 && (
              <span class="subagent-model-retries">Retries: {singleResult.retryCount}</span>
            )}
          </div>
        )}
        <TranscriptMessageList
          messages={messages}
          prefs={prefs}
          workingDirectory={workingDirectory}
          onOpenFile={onOpenFile}
          onContextMenu={onNestedContextMenu}
          renderToolCall={renderToolCall}
          readonly
          collapsibleKey={nestedCollapsibleDefaultsKey}
        />
      </div>
      {canResize && !isNested && (
        <ResizeHandle
          edge="bottom"
          onMouseDown={startResize('bottom')}
          height={height}
          minHeight={minHeight}
          maxHeight={maxHeight}
          onResizeBy={resizeBy}
          onReset={reset}
        />
      )}
      {onClose && !isNested && <CollapsibleCloseFooter onCollapse={onClose} />}
    </div>
  );
}

function SubagentSingleBlock({
  singleResult,
  toolCall,
  detailState,
  onLoadDetail,
  onRetryDetail,
  index,
  prefs,
  workingDirectory,
  onOpenFile,
  onContextMenu,
  onNestedContextMenu,
  renderToolCall,
  multipleResults,
}: SubagentSingleBlockProps) {
  const collapsibleKey = multipleResults
    ? `subagent:${toolCall.id}-${index}`
    : `subagent:${toolCall.id}`;
  const [open, setOpen] = useCollapsibleOpen(collapsibleKey, prefs.autoExpandSubagentCalls);
  useEffect(() => {
    if (open && toolCall.detailRef) onLoadDetail?.();
  }, [open, toolCall.detailRef?.key, onLoadDetail]);
  const status = singleResultStatus(singleResult, toolCall.status, multipleResults);
  const errorDetail = status === 'failed' || status === 'interrupted'
    ? subagentErrorDetail(singleResult)
    : undefined;
  // Lifecycle events do not necessarily arrive every second. Tick locally so
  // elapsed time remains visibly alive during concurrency/provider waits and
  // active streaming alike (queued children have the visual `idle` status).
  const [activityNow, setActivityNow] = useState(Date.now());
  useEffect(() => {
    if (status !== 'running' && status !== 'idle') return;
    setActivityNow(Date.now());
    const timer = setInterval(() => setActivityNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [status, singleResult.activityPhase, singleResult.activitySince]);
  const activity = status === 'running' || status === 'idle'
    ? subagentActivity(singleResult, activityNow)
    : undefined;
  // Collapsed cards keep a compact task/live-output preview. Expanded cards
  // already show the full child transcript, so repeating the preview there is
  // redundant.
  const previewTail = open
    ? undefined
    : subagentPreviewTail(
        singleResult,
        ACTIVITY_TAIL_MAX_LINES,
        status === 'running' || status === 'idle',
      );

  // Check if this subagent has a pending ask_user request (for blinking indicator).
  const askUserCtx = useContext(AskUserContext);
  const hasPendingAskUser = !open && Object.values(askUserCtx.pendingRequests).some(
    (req) => (req.method === 'select' || req.method === 'confirm' || req.method === 'input') && req.subagentCallId != null
      && (req.subagentCallId === toolCall.id || req.subagentCallId.startsWith(`${toolCall.id}:`)),
  );

  // Source attribution for nested ask_user prompts: carry this subagent's
  // call id (matching the SDK's subagentCallId stamping), agent name, and
  // nesting depth (parent depth + 1; top-level subagent = 1) down to the
  // nested transcript so ask_user prompts can label who is asking.
  const parentSubagentCtx = useContext(SubagentCallContext);
  const subagentDepth = (parentSubagentCtx?.depth ?? 0) + 1;
  const subagentCallId = multipleResults ? `${toolCall.id}:${index}` : toolCall.id;
  // Nested (depth ≥ 2) subagents live inside a parent subagent's bounded
  // scroll region. A nested header/body establishing its own scroll container
  // creates nested-scroll confusion, so nested blocks use a free-flowing body
  // (no max-height / overflow). Both depth-1 and nested headers are now
  // `relative` (non-pinning) so there is no header overlap; the nested
  // modifier still marks the free-flowing body.
  const isNested = subagentDepth > 1;
  // Stable id for the body region so the header can reference it via
  // `aria-controls` (only when the body is mounted, i.e. open or closing).
  const bodyId = useId();

  // ── Animated close ──────────────────────────────────────────────────────
  // Mirror the generic `Collapsible`: keep the body mounted with `closing`
  // while a grid-track `1fr→0fr` transition collapses it, then unmount (with
  // a timer fallback for environments where `transitionend` doesn't fire).
  // Opening mounts instantly. Keeps the subagent's open/close consistent with
  // tool-call cards and reasoning blocks (no snap).
  const [closing, setClosing] = useState(false);
  const closeFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const SUBAGENT_CLOSE_MS = 200;
  const renderBody = open || closing;

  useEffect(() => {
    if (open) setClosing(false);
  }, [open]);

  useEffect(() => () => {
    if (closeFallbackRef.current) clearTimeout(closeFallbackRef.current);
  }, []);

  const close = () => {
    if (closing && !open) return;
    if (closeFallbackRef.current) clearTimeout(closeFallbackRef.current);
    setClosing(true);
    setOpen(false);
    closeFallbackRef.current = setTimeout(() => {
      closeFallbackRef.current = null;
      setClosing(false);
    }, SUBAGENT_CLOSE_MS + 60);
  };

  const toggle = () => {
    if (open) close();
    else setOpen(true);
  };

  const onBodyTransitionEnd = (e: TransitionEvent) => {
    if (e.target !== e.currentTarget) return;
    if (closing && !open) {
      if (closeFallbackRef.current) {
        clearTimeout(closeFallbackRef.current);
        closeFallbackRef.current = null;
      }
      setClosing(false);
    }
  };

  return (
    // `overflow-clip` (not `hidden`): clips children to the rounded card
    // corners but does NOT establish a scroll container. (The header is no
    // longer sticky, so this no longer exists to free a sticky header.)
    <div
      class={cx('tool-call tool-call-subagent', 'border border-border-subtle rounded-xl bg-card shadow-sm overflow-clip transition-[border-color,background,box-shadow] duration-150 hover:border-border hover:bg-control-hover hover:shadow-md forced-colors:border forced-colors:border-[ButtonText]', status, hasPendingAskUser && 'pending-ask-user')}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(toMouseEvent(e)); }}
    >
      <div
        class={cx('subagent-header min-h-[28px] select-none', isNested && 'subagent-header-nested')}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls={renderBody ? bodyId : undefined}
        title={open ? 'Collapse' : 'Expand'}
        aria-label={`Toggle ${singleResult.agent} subagent`}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
      >
        <div class="subagent-header-content">
          <span class="subagent-agent-name transcript-header-title-mono">{singleResult.agent}</span>
          {activity && (
            <span class={cx('subagent-activity', status === 'idle' && 'subagent-activity-idle')} title={activity.diagnostic} aria-label={activity.diagnostic}>
              <span class="subagent-activity-dot" aria-hidden="true" />
              <span class="subagent-activity-label">{activity.label}{activity.elapsed ? ` ${activity.elapsed}` : ''}</span>
              {activity.detail && <span class="subagent-activity-detail">{activity.detail}</span>}
            </span>
          )}
          {!activity && status === 'idle' && (
            <span class="subagent-activity subagent-activity-idle"><span class="subagent-activity-dot" aria-hidden="true" />Waiting for dispatch</span>
          )}
          <PrimaryMeta result={singleResult} />
          <ContextHandoffLabel
            result={singleResult}
            requestedMode={requestedParentUserContextMode(toolCall.input)}
          />
          <span class="subagent-runtime-telemetry subagent-runtime-telemetry-stable">
            <ElapsedTelemetry result={singleResult} now={activityNow} />
          </span>
          <RuntimeTelemetry result={singleResult} />
        </div>
        <StatusIndicator status={status} errorDetail={errorDetail} />
        <CollapsibleChevron open={open} class="ml-0.5 shrink-0" />
      </div>
      {previewTail && !renderBody && (
        <div
          class="subagent-live-preview"
          role="status"
          aria-label={`${singleResult.agent} ${status === 'running' || status === 'idle' ? 'live' : status} output`}
        >
          <TurnActivityTailBody tail={previewTail} continuous />
        </div>
      )}
      {renderBody && (
        <div
          class="collapsible-body-wrap"
          data-closing={!open && closing ? 'true' : undefined}
          onTransitionEnd={onBodyTransitionEnd}
        >
          <div class="collapsible-body-clip">
            {toolCall.detailRef && detailState?.status !== 'loaded' ? (
              <div id={bodyId} class="subagent-messages p-3" role="status">
                {detailState?.status === 'failure'
                  || detailState?.status === 'unavailable'
                  || detailState?.status === 'stale' ? (
                    <div>
                      <div>{detailState.message}</div>
                      <button type="button" class="mt-2 text-accent underline" onClick={onRetryDetail}>Retry</button>
                    </div>
                  ) : (
                    <span>Loading subagent transcript…</span>
                  )}
              </div>
            ) : (
              <SubagentCallContext.Provider value={{ id: subagentCallId, agent: singleResult.agent, depth: subagentDepth }}>
                <SubagentMessages
                  singleResult={singleResult}
                  toolCall={toolCall}
                  index={index}
                  prefs={prefs}
                  workingDirectory={workingDirectory}
                  onOpenFile={onOpenFile}
                  onContextMenu={onContextMenu}
                  onNestedContextMenu={onNestedContextMenu}
                  renderToolCall={renderToolCall}
                  isNested={isNested}
                  bodyId={bodyId}
                  onClose={close}
                />
              </SubagentCallContext.Provider>
            )}
            {/* Left gutter collapse hitbox (border / indentation area). Only
              while actually open (not during the close animation). */}
            {open && <CollapsibleGutter onCollapse={close} />}
          </div>
        </div>
      )}
    </div>
  );
}

function SubagentBlock({
  toolCall,
  subagentResult,
  detailState,
  onLoadDetail,
  onRetryDetail,
  prefs,
  workingDirectory,
  onOpenFile,
  onContextMenu,
  onNestedContextMenu,
  renderToolCall,
}: SubagentBlockProps) {
  const result = subagentResult ?? getRenderableSubagentResultFromToolCall(toolCall);

  if (!result) {
    return (
      <ToolCallCard
        toolCall={toolCall}
        autoExpand={prefs.autoExpandSubagentCalls}
        className="tool-call-subagent"
        workingDirectory={workingDirectory}
        onOpenFile={onOpenFile}
        onContextMenu={onContextMenu}
      />
    );
  }

  const multipleResults = result.results.length > 1;

  if (multipleResults) {
    return (
      <div class="subagent-parallel-group">
        {result.results.map((singleResult, index) => (
          // Each child is wrapped so a per-child connector strip (the left spine
          // + horizontal tick) can mark it as a member of this parallel call —
          // the card itself clips overflow, so the connector lives on the wrapper.
          <div class="subagent-parallel-child" key={index}>
            <SubagentSingleBlock
              singleResult={singleResult}
              toolCall={toolCall}
              detailState={detailState}
              onLoadDetail={onLoadDetail}
              onRetryDetail={onRetryDetail}
              index={index}
              prefs={prefs}
              workingDirectory={workingDirectory}
              onOpenFile={onOpenFile}
              onContextMenu={onContextMenu}
              onNestedContextMenu={onNestedContextMenu}
              renderToolCall={renderToolCall}
              multipleResults
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <SubagentSingleBlock
      singleResult={result.results[0]}
      toolCall={toolCall}
      detailState={detailState}
      onLoadDetail={onLoadDetail}
      onRetryDetail={onRetryDetail}
      index={0}
      prefs={prefs}
      workingDirectory={workingDirectory}
      onOpenFile={onOpenFile}
      onContextMenu={onContextMenu}
      onNestedContextMenu={onNestedContextMenu}
      renderToolCall={renderToolCall}
      multipleResults={false}
    />
  );
}

function areToolCallItemPropsEqual(previous: ToolCallItemProps, next: ToolCallItemProps): boolean {
  if (
    previous.prefs !== next.prefs
    || previous.workingDirectory !== next.workingDirectory
    || previous.onOpenFile !== next.onOpenFile
    || previous.onContextMenu !== next.onContextMenu
    || previous.renderToolCall !== next.renderToolCall
  ) {
    return false;
  }

  const left = previous.toolCall;
  const right = next.toolCall;
  // Every live-pipeline tool update advances seq. Legacy running calls have no
  // producer revision, so fail open and render them defensively on every tick.
  if (
    (left.status === 'running' || right.status === 'running')
    && (!Number.isSafeInteger(left.seq) || !Number.isSafeInteger(right.seq))
  ) {
    return false;
  }

  // Tool input is immutable after tool.started. Terminal results are immutable;
  // live result/progress changes are represented by seq. Presence is still a
  // barrier so an undefined-to-defined result cannot be hidden.
  return left.id === right.id
    && left.name === right.name
    && left.status === right.status
    && left.startedAt === right.startedAt
    && left.durationMs === right.durationMs
    && left.parallelGroupId === right.parallelGroupId
    && left.executionId === right.executionId
    && left.seq === right.seq
    && left.phase === right.phase
    && left.durableEntryId === right.durableEntryId
    && left.detailRef?.key === right.detailRef?.key
    && (left.result === undefined) === (right.result === undefined);
}

function ToolCallItemBody({
  toolCall,
  prefs,
  workingDirectory,
  onOpenFile,
  onContextMenu,
  renderToolCall,
}: ToolCallItemProps) {
  const isSubagent = toolCall.name === 'subagent';
  // The compact tool/input projection is sufficient for the collapsed
  // subagent preview. The recursive transcript is requested only by the
  // subagent disclosure's open state, just like a main transcript row.
  const lazyDetail = useLazyDetail(toolCall.detailRef, false);
  const renderedToolCall = lazyDetail.state.status === 'loaded'
    ? { ...toolCall, result: lazyDetail.state.value, detailRef: undefined }
    : toolCall;
  const waitingForDetail = !!renderedToolCall.detailRef && lazyDetail.state.status !== 'loaded';
  const subagentResult = getRenderableSubagentResultFromToolCall(renderedToolCall);
  const rendererName = isSubagent || !!subagentResult
    ? 'subagent'
    : waitingForDetail ? '__default' : renderedToolCall.name;
  const Renderer = getToolRenderer(rendererName) ?? getToolRenderer('__default');

  if (Renderer) {
    return (
      <Renderer
        toolCall={renderedToolCall}
        detailState={lazyDetail.state}
        onLoadDetail={lazyDetail.load}
        onRetryDetail={lazyDetail.retry}
        prefs={prefs}
        workingDirectory={workingDirectory}
        onOpenFile={onOpenFile}
        onContextMenu={onContextMenu}
        renderToolCall={renderToolCall}
      />
    );
  }

  const contextType = getToolCallContextType(rendererName);
  const handleContextMenu = (e: MouseEvent) => onContextMenu(
    contextType,
    JSON.stringify(renderedToolCall, null, 2),
    e,
  );

  return (
    <ToolCallCard
      toolCall={renderedToolCall}
      autoExpand={prefs.autoExpandToolCalls}
      workingDirectory={workingDirectory}
      onOpenFile={onOpenFile}
      onContextMenu={handleContextMenu}
    />
  );
}

const MemoizedToolCallItemBody = memo(ToolCallItemBody, areToolCallItemPropsEqual);

export function ToolCallItem(props: ToolCallItemProps) {
  // Keep commit evidence outside the memoized heavy body: every parent/context
  // revision reaches the canonical leaf even when an equivalent structured
  // clone can reuse historical markdown/tool/subagent rendering.
  useCommittedToolLeaf(props.toolCall);
  return <MemoizedToolCallItemBody {...props} />;
}

/** Subagent renderer exposed for registry registration. */
export function SubagentToolRenderer({
  toolCall,
  detailState,
  onLoadDetail,
  onRetryDetail,
  prefs,
  workingDirectory,
  onOpenFile,
  onContextMenu,
  renderToolCall,
}: import('./registry').ToolRendererProps) {
  const subagentResult = getRenderableSubagentResultFromToolCall(toolCall);
  const contextType = getToolCallContextType('subagent');
  const handleContextMenu = (e: MouseEvent) => onContextMenu(
    contextType,
    JSON.stringify(toolCall, null, 2),
    e,
  );

  return (
    <SubagentBlock
      toolCall={toolCall}
      subagentResult={subagentResult}
      detailState={detailState}
      onLoadDetail={onLoadDetail}
      onRetryDetail={onRetryDetail}
      prefs={prefs}
      workingDirectory={workingDirectory}
      onOpenFile={onOpenFile}
      onContextMenu={handleContextMenu}
      onNestedContextMenu={onContextMenu}
      renderToolCall={renderToolCall}
    />
  );
}
