/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useContext, useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
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
import { useResizableHeight } from '../components/use-resizable-height';
import {
  getRenderableSubagentResultFromToolCall,
  subagentSingleResultToChatMessages,
  type SubagentResult,
  type SubagentSingleResult,
} from './subagent';
import {
  DISPLAY_SCORE_DIMS,
  normalizeTaskScoresForDisplay,
} from './subagent-score-display';
import { StatusChip } from './status-chip';
import { ToolCallCard } from './tool-call-card';
import { TranscriptMessageList } from './transcript-message-list';
import type { RenderToolCall, TranscriptContextMenuHandler } from './types';
import { getToolRenderer } from './registry';
import { useCollapsibleOpen } from './use-collapsible-open';
import { useStickToBottom } from './use-stick-to-bottom';
import { SubagentCallContext } from './subagent-call-context';
import { ACTIVITY_TAIL_MAX_LINES } from './activity-tail';
import { TurnActivityTailBody, isIdle, subagentPreviewTail } from './activity-tail-preview';

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
  prefs: ChatPrefs;
  workingDirectory: string | null;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: MouseEvent) => void;
  onNestedContextMenu: TranscriptContextMenuHandler;
  renderToolCall: RenderToolCall;
}

function isRunning(result: SubagentSingleResult): boolean {
  return result.exitCode === -1 || (result.runningTools?.length ?? 0) > 0;
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
  if (!isRunning(result)) return undefined;
  const labels: Record<string, string> = {
    queued: 'Waiting for concurrency',
    preparing: 'Starting',
    waiting_provider: 'Waiting for provider',
    streaming: 'Generating',
    running_tool: 'Running tool',
    retry_wait: 'Retrying provider',
  };
  const runningTools = result.runningTools?.filter(Boolean).join(', ');
  const hasStreamingOutput = result.streaming === true || !!result.streamingText?.trim();
  // Concrete output/tool activity is more trustworthy than lifecycle metadata,
  // which can briefly lag behind streamed child updates.
  const label = runningTools
    ? 'Running tool'
    : hasStreamingOutput
      ? 'Generating'
      : result.activityPhase
        ? labels[result.activityPhase]
        : 'Starting';
  if (!label) return undefined;
  const detail = runningTools
    ? runningTools
    : hasStreamingOutput
      ? undefined
      : result.activityPhase === 'waiting_provider' && result.provider
        ? result.provider
        : result.activityDetail ?? (!result.activityPhase ? 'waiting for first status update' : undefined);
  const elapsed = result.activitySince ? formatActivityDuration(now - result.activitySince) : undefined;
  const budget = result.inactivityBudgetMs ? formatActivityDuration(result.inactivityBudgetMs) : undefined;
  const diagnostic = [label, detail, elapsed && `${elapsed} in this state`, budget && `${budget} stall limit`]
    .filter(Boolean)
    .join(' · ');
  return { label, detail, elapsed, diagnostic };
}

function isFailed(result: SubagentSingleResult): boolean {
  if (isRunning(result)) return false;
  return result.exitCode !== 0 || result.stopReason === 'error' || result.stopReason === 'aborted';
}

/** Extract a human-readable error summary from a single result. */
function subagentErrorDetail(result: SubagentSingleResult): string | undefined {
  if (!isFailed(result)) return undefined;
  const parts: string[] = [];
  const label =
    result.stopReason === 'aborted' ? 'Aborted'
    : result.stopReason === 'error' ? 'Error'
    : result.exitCode > 0 ? `Exit code ${result.exitCode}`
    : 'Failed';
  parts.push(label);
  if (result.errorMessage) parts.push(result.errorMessage);
  if (result.stderr) parts.push(result.stderr);
  return parts.join(': ');
}

/** Compact score bar: always shows the full effective requirement vector. */
function ScoreBar({ scores }: { scores: Record<string, number> | undefined }) {
  const normalized = normalizeTaskScoresForDisplay(scores);
  if (!normalized) return null;

  return (
    <span class="subagent-scores">
      {DISPLAY_SCORE_DIMS.map(({ key, label, full }) => {
        const val = normalized[key];
        const isDefaulted = scores?.[key] == null;
        return (
          <span
            key={key}
            class="subagent-score-dim"
            data-score={val}
            title={`${full}: ${val}/5${isDefaulted ? ' (default)' : ''}`}
          >{label}{val}</span>
        );
      })}
    </span>
  );
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

/** High-priority metadata that should remain visible before summary text. */
function PrimaryMeta({ result }: { result: SubagentSingleResult }) {
  const hasScores = !!normalizeTaskScoresForDisplay(result.taskScores);
  const hasModel = !!(result.selectedModel ?? result.model);
  if (!hasScores && !hasModel) return null;

  return (
    <span class="subagent-primary-meta">
      <ModelLabel result={result} />
      {hasScores && <ScoreBar scores={result.taskScores} />}
    </span>
  );
}

/** Runtime telemetry uses otherwise-empty header space. Context pressure is
 * highest priority; output, last-turn throughput, and retries progressively
 * disappear at narrow widths via CSS. Full precision remains in the tooltip. */
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
  const hasOutput = typeof usage?.output === 'number' && usage.output > 0;
  const hasRetries = typeof result.retryCount === 'number' && result.retryCount > 0;
  if (!hasContext && !hasOutput && tokensPerSecond == null && !hasRetries) return null;

  const cacheTokens = (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
  const title = [
    hasContext ? `Context: ${contextTokens!.toLocaleString()} / ${contextWindow!.toLocaleString()} tokens (${formatContextPercent(contextTokens!, contextWindow!)})` : undefined,
    usage ? `Usage: ${usage.input.toLocaleString()} input, ${usage.output.toLocaleString()} output, ${cacheTokens.toLocaleString()} cached` : undefined,
    tokensPerSecond != null ? `Latest completed generation: ${tokensPerSecond.toFixed(1)} tokens/s` : undefined,
    usage?.cost ? `Cost: $${usage.cost.toFixed(4)}` : undefined,
    usage?.turns ? `${usage.turns} completed ${usage.turns === 1 ? 'turn' : 'turns'}` : undefined,
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
      {hasOutput && <span class="subagent-telemetry-item subagent-telemetry-output">out {compactTelemetryNumber(usage!.output)}</span>}
      {tokensPerSecond != null && <span class="subagent-telemetry-item subagent-telemetry-rate">last {tokensPerSecond.toFixed(1)} tok/s</span>}
      {hasRetries && <span class="subagent-telemetry-item subagent-telemetry-retries">retry {result.retryCount}</span>}
    </span>
  );
}

/** Status indicator chip at the right side of the header. */
function StatusIndicator({ status, errorDetail }: { status: 'idle' | 'running' | 'failed' | 'completed'; errorDetail?: string }) {
  if (status !== 'failed') return null;

  return (
    <StatusChip
      tone="failed"
      label="Failed"
      className="status-chip-fixed"
      copyText={errorDetail}
      copyAriaLabel="Copy subagent error detail"
    />
  );
}

export function singleResultStatus(
  result: SubagentSingleResult,
  toolCallStatus: ToolCall['status'],
  multipleResults: boolean,
): 'idle' | 'running' | 'failed' | 'completed' {
  // The outer tool lifecycle is authoritative once terminal. Older or raced
  // child results can retain a stale runningTools entry even though execution
  // has finished; do not leave those cards visually running forever.
  if (toolCallStatus !== 'running') {
    if (
      toolCallStatus === 'failed'
      || result.exitCode !== 0
      || result.stopReason === 'error'
      || result.stopReason === 'aborted'
    ) return 'failed';
    return 'completed';
  }
  if (isFailed(result)) return 'failed';
  if (isRunning(result)) {
    // A running call that has produced no activity yet is "idle" (queued /
    // not started).
    if (isIdle(result)) return 'idle';
    return 'running';
  }
  return multipleResults ? 'completed' : 'running';
}

interface SubagentSingleBlockProps {
  singleResult: SubagentSingleResult;
  toolCall: ToolCall;
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
                const fitScore = singleResult.selectionFitScores?.[idx];
                const isChosen = candidate === (singleResult.selectedModel ?? singleResult.model);
                return (
                  <span key={idx} class={`subagent-pool-candidate${isChosen ? ' chosen' : ''}`}>
                    <span class="subagent-pool-name">{candidate.includes('/') ? candidate.split('/').pop() : candidate}</span>
                    {fitScore != null && <span class="subagent-pool-score">{fitScore.toFixed(1)}</span>}
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
  const status = singleResultStatus(singleResult, toolCall.status, multipleResults);
  const errorDetail = status === 'failed' ? subagentErrorDetail(singleResult) : undefined;
  // Lifecycle events do not necessarily arrive every second. Tick locally so
  // elapsed time remains visibly alive during concurrency/provider waits and
  // active streaming alike (queued children have the visual `idle` status).
  const [activityNow, setActivityNow] = useState(Date.now());
  useEffect(() => {
    if (!isRunning(singleResult)) return;
    setActivityNow(Date.now());
    const timer = setInterval(() => setActivityNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [status, singleResult.activityPhase, singleResult.activitySince]);
  const activity = subagentActivity(singleResult, activityNow);
  // Collapsed cards keep a compact task/live-output preview. Expanded cards
  // already show the full child transcript, so repeating the preview there is
  // redundant.
  const previewTail = subagentPreviewTail(
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
          <RuntimeTelemetry result={singleResult} />
        </div>
        <StatusIndicator status={status} errorDetail={errorDetail} />
        <CollapsibleChevron open={open} class="ml-0.5 shrink-0" />
      </div>
      {previewTail && !renderBody && (
        <div
          class="subagent-live-preview"
          role="status"
          aria-label={`${singleResult.agent} live output`}
        >
          <TurnActivityTailBody tail={previewTail} />
        </div>
      )}
      {renderBody && (
        <div
          class="collapsible-body-wrap"
          data-closing={!open && closing ? 'true' : undefined}
          onTransitionEnd={onBodyTransitionEnd}
        >
          <div class="collapsible-body-clip">
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

export function ToolCallItem({
  toolCall,
  prefs,
  workingDirectory,
  onOpenFile,
  onContextMenu,
  renderToolCall,
}: ToolCallItemProps) {
  const subagentResult = getRenderableSubagentResultFromToolCall(toolCall);
  const rendererName = toolCall.name === 'subagent' || !!subagentResult ? 'subagent' : toolCall.name;
  const Renderer = getToolRenderer(rendererName) ?? getToolRenderer('__default');

  if (Renderer) {
    return (
      <Renderer
        toolCall={toolCall}
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
    JSON.stringify(toolCall, null, 2),
    e,
  );

  return (
    <ToolCallCard
      toolCall={toolCall}
      autoExpand={prefs.autoExpandToolCalls}
      workingDirectory={workingDirectory}
      onOpenFile={onOpenFile}
      onContextMenu={handleContextMenu}
    />
  );
}

/** Subagent renderer exposed for registry registration. */
export function SubagentToolRenderer({
  toolCall,
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
      prefs={prefs}
      workingDirectory={workingDirectory}
      onOpenFile={onOpenFile}
      onContextMenu={handleContextMenu}
      onNestedContextMenu={onContextMenu}
      renderToolCall={renderToolCall}
    />
  );
}
