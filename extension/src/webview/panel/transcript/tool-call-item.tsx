/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useContext, useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import type { ChatPrefs, ToolCall } from '../../../shared/protocol';
import { summarizeSubagentToolCallInput } from '../../../shared/tool-call-analysis';
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

/** A subagent that has been dispatched but hasn't started executing yet — the
 *  synthesized placeholder before any messages, streaming text, or nested
 *  tool calls have arrived. Renders with a muted "waiting" treatment so queued
 *  agents (e.g. not-yet-started parallel members) recede behind active ones. */
function isIdle(result: SubagentSingleResult): boolean {
  if (result.exitCode !== -1) return false;
  const hasMessages = Array.isArray(result.messages) && result.messages.length > 0;
  const hasStreamingText = !!result.streamingText?.trim();
  const hasRunningTools = (result.runningTools?.length ?? 0) > 0;
  return !hasMessages && !hasStreamingText && !hasRunningTools;
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

function singleResultStatus(
  result: SubagentSingleResult,
  toolCallStatus: ToolCall['status'],
  multipleResults: boolean,
): 'idle' | 'running' | 'failed' | 'completed' {
  if (isFailed(result)) return 'failed';
  if (isRunning(result)) {
    // A running call that has produced no activity yet is "idle" (queued /
    // not started), unless the tool call itself has already failed.
    if (isIdle(result) && toolCallStatus !== 'failed') return 'idle';
    return toolCallStatus === 'failed' ? 'failed' : 'running';
  }
  if (!multipleResults && toolCallStatus === 'running') return 'running';
  if (!multipleResults && toolCallStatus === 'failed') return 'failed';
  return 'completed';
}

function summarizeSingleResult(result: SubagentSingleResult): string | null {
  return summarizeSubagentToolCallInput({ task: result.task });
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
  const summary = summarizeSingleResult(singleResult);
  const status = singleResultStatus(singleResult, toolCall.status, multipleResults);
  const errorDetail = status === 'failed' ? subagentErrorDetail(singleResult) : undefined;

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
        <div class="flex min-w-0 flex-1 items-center gap-[7px]">
          <span class="subagent-agent-name transcript-header-title-mono">{singleResult.agent}</span>
          <PrimaryMeta result={singleResult} />
          {!open && summary && <span class="subagent-header-summary transcript-header-summary-mono">{summary}</span>}
        </div>
        <StatusIndicator status={status} errorDetail={errorDetail} />
        <CollapsibleChevron open={open} class="ml-0.5 shrink-0" />
      </div>
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
          <SubagentSingleBlock
            key={index}
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
