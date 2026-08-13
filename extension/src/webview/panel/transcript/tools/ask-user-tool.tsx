/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useContext, useEffect, useMemo } from 'preact/hooks';

import type { ToolCall } from '../../../../shared/protocol';
import { AskUserContext, findMatchingRequest } from '../../hooks/ask-user-context';
import { SubagentCallContext } from '../subagent-call-context';
import { ToolCallCard } from '../tool-call-card';
import { getToolCallContextType } from '../../chat-prefs';
import { ExtensionUIPrompt } from '../../extension-ui-prompt';
import { renderMarkdown } from '../../markdown';
import { toMouseEvent } from '../../utils/preact-events';
import { QuestionIcon } from '../../components/question-icon';
import { registerToolRenderer, type ToolRendererProps } from '../registry';
import type { TranscriptContextMenuHandler } from '../types';

// ─── Input type ──────────────────────────────────────────────────────────────

interface AskUserReviewMeta {
  purpose: 'review_human_verification';
  targetSessionId: string;
  targetSessionPath: string;
  criterionId: string;
  domain: string;
  expectedObservation: string;
}

interface AskUserInput {
  question: string;
  options: string[];
  allowCustom?: boolean;
  context?: string;
  reviewMeta?: AskUserReviewMeta;
}

function parseAskUserReviewMeta(value: unknown): AskUserReviewMeta | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const meta = value as Record<string, unknown>;
  if (
    meta.purpose !== 'review_human_verification'
    || typeof meta.targetSessionId !== 'string'
    || typeof meta.targetSessionPath !== 'string'
    || typeof meta.criterionId !== 'string'
    || typeof meta.domain !== 'string'
    || typeof meta.expectedObservation !== 'string'
  ) return undefined;
  return {
    purpose: 'review_human_verification',
    targetSessionId: meta.targetSessionId,
    targetSessionPath: meta.targetSessionPath,
    criterionId: meta.criterionId,
    domain: meta.domain,
    expectedObservation: meta.expectedObservation,
  };
}

function parseAskUserInput(input: unknown): AskUserInput | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.question !== 'string') return null;
  if (!Array.isArray(obj.options)) return null;
  if (!obj.options.every((o): o is string => typeof o === 'string')) return null;
  return {
    question: obj.question,
    options: obj.options as string[],
    allowCustom: typeof obj.allowCustom === 'boolean' ? obj.allowCustom : undefined,
    context: typeof obj.context === 'string' ? obj.context : undefined,
    reviewMeta: parseAskUserReviewMeta(obj.reviewMeta),
  };
}

// ─── Result type ──────────────────────────────────────────────────────────────

interface AskUserResult {
  answer: string;
  source: 'option' | 'custom' | 'cancelled';
  cancelled: boolean;
}

function parseAskUserResult(result: unknown): AskUserResult | null {
  if (!result || typeof result !== 'object') return null;
  const obj = result as Record<string, unknown>;
  // Also accept Content[] format: [{ type: 'text', text: '...' }]
  if (Array.isArray(obj.content)) {
    const textPart = (obj.content as Array<Record<string, unknown>>).find(
      (p) => p.type === 'text' && typeof p.text === 'string',
    );
    if (textPart && typeof obj.details === 'object' && obj.details !== null) {
      const details = obj.details as Record<string, unknown>;
      return {
        answer: typeof details.answer === 'string' ? details.answer : String(textPart.text),
        source: details.source === 'option' || details.source === 'custom' || details.source === 'cancelled'
          ? details.source : 'option',
        cancelled: details.cancelled === true,
      };
    }
  }
  if (typeof obj.answer === 'string') {
    return {
      answer: obj.answer,
      source: obj.source === 'option' || obj.source === 'custom' || obj.source === 'cancelled'
        ? obj.source : 'option',
      cancelled: obj.cancelled === true,
    };
  }
  return null;
}

// ─── Completed ask_user display ───────────────────────────────────────────────

function AskUserCompleted({ toolCall, parsedInput, parsedResult, onContextMenu }: {
  toolCall: ToolCall;
  parsedInput: AskUserInput;
  parsedResult: AskUserResult | null;
  onContextMenu: TranscriptContextMenuHandler;
}) {
  const contextType = getToolCallContextType('ask_user');
  const handleContextMenu = (e: MouseEvent) => onContextMenu(contextType, JSON.stringify(toolCall, null, 2), e);
  const questionHtml = useMemo(() => renderMarkdown(parsedInput.question, true, false), [parsedInput.question]);
  const contextHtml = useMemo(
    () => (parsedInput.context ? renderMarkdown(parsedInput.context, true, false) : ''),
    [parsedInput.context],
  );

  return (
    <div
      class="ask-user-completed"
      onContextMenu={(e) => { e.preventDefault(); handleContextMenu(toMouseEvent(e)); }}
    >
      <div class="ask-user-header ask-user-header-completed">
        <span class="ask-user-icon ask-user-icon-completed" aria-hidden="true"><QuestionIcon /></span>
        <div class="ask-user-question ask-user-question-completed ask-prose" dangerouslySetInnerHTML={{ __html: questionHtml }} />
      </div>
      {parsedInput.reviewMeta && (
        <div class="ask-user-review-target">Review · {parsedInput.reviewMeta.targetSessionPath}</div>
      )}
      {parsedInput.context && (
        <div class="ask-user-context ask-prose" dangerouslySetInnerHTML={{ __html: contextHtml }} />
      )}
      {parsedInput.options.length > 0 && (
        <div class="ask-user-options">
          <span class="ask-user-answer-label">Options:</span>
          <div class="ask-user-option-list" role="list" aria-label="Proposed answers">
            {parsedInput.options.map((option, index) => {
              const selected = parsedResult?.source === 'option' && parsedResult.answer === option;
              return (
                <span
                  key={`${option}-${index}`}
                  class={`ask-user-option${selected ? ' ask-user-option-selected' : ''}`}
                  role="listitem"
                  aria-label={selected ? `${option}, selected answer` : undefined}
                >
                  {option}
                </span>
              );
            })}
          </div>
        </div>
      )}
      {parsedResult && !parsedResult.cancelled && (
        <div class="ask-user-answer">
          <span class="ask-user-answer-label">Answer:</span>
          <span class="ask-user-answer-text">{parsedResult.answer}</span>
        </div>
      )}
      {parsedResult?.cancelled && (
        <div class="ask-user-cancelled">Cancelled</div>
      )}
      {!parsedResult && toolCall.result !== undefined && (
        <div class="ask-user-answer">
          <span class="ask-user-answer-label">Result:</span>
          <span class="ask-user-answer-text">{typeof toolCall.result === 'string' ? toolCall.result : JSON.stringify(toolCall.result)}</span>
        </div>
      )}
    </div>
  );
}

// ─── Main renderer ────────────────────────────────────────────────────────────

function renderAskUserTool({
  toolCall,
  prefs,
  workingDirectory,
  onOpenFile,
  onContextMenu,
  renderToolCall: _renderToolCall,
}: ToolRendererProps) {
  const parsedInput = parseAskUserInput(toolCall.input);
  const askUserCtx = useContext(AskUserContext);
  const subagentCtx = useContext(SubagentCallContext);
  const matchingRequest = findMatchingRequest(askUserCtx.pendingRequests, subagentCtx?.id ?? toolCall.id);
  const sessionPath = askUserCtx.sessionPath;
  const postMessage = askUserCtx.postMessage;
  const mountedInlineRequestId = toolCall.status === 'running' ? matchingRequest?.id : undefined;

  useEffect(() => {
    if (!mountedInlineRequestId) return;
    askUserCtx.registerInlineRequest(mountedInlineRequestId);
    return () => askUserCtx.unregisterInlineRequest(mountedInlineRequestId);
  }, [askUserCtx.registerInlineRequest, askUserCtx.unregisterInlineRequest, mountedInlineRequestId]);

  // Source label for the prompt eyebrow. Subagent questions show the agent
  // name (and nesting depth when > 1, i.e. a subagent-of-subagent) so the user
  // can tell who is asking and how deep. Main-agent questions get no label.
  const sourceLabel = parsedInput?.reviewMeta
    ? `Review · ${parsedInput.reviewMeta.targetSessionPath}`
    : subagentCtx
      ? subagentCtx.depth > 1
        ? `${subagentCtx.agent} · depth ${subagentCtx.depth}`
        : subagentCtx.agent
      : undefined;

  // Running ask_user: show interactive prompt if we have a matching request
  if (toolCall.status === 'running') {
    if (matchingRequest && sessionPath) {
      return (
        <div onContextMenu={(e) => { e.preventDefault(); onContextMenu(getToolCallContextType('ask_user'), JSON.stringify(toolCall, null, 2), toMouseEvent(e)); }}>
          <ExtensionUIPrompt
            sessionPath={sessionPath}
            request={matchingRequest}
            postMessage={postMessage}
            variant="card"
            context={parsedInput?.context}
            sourceLabel={sourceLabel}
          />
        </div>
      );
    }

    // No matching request yet — show the question with a "waiting" indicator
    // and a gentle nudge that the UI is loading. This handles the brief moment
    // before the extension_ui.request event reaches the webview.
    if (parsedInput) {
      const questionHtml = renderMarkdown(parsedInput.question, true, false);
      const contextHtml = parsedInput.context ? renderMarkdown(parsedInput.context, true, false) : '';
      return (
        <div class="ask-user-prompt ask-user-prompt-loading">
          <div class="ask-user-header">
            <span class="ask-user-icon" aria-hidden="true"><QuestionIcon /></span>
            <div class="ask-user-question ask-prose" dangerouslySetInnerHTML={{ __html: questionHtml }} />
          </div>
          {parsedInput.reviewMeta && <div class="ask-user-review-target">Review · {parsedInput.reviewMeta.targetSessionPath}</div>}
          {parsedInput.context && <div class="ask-user-context ask-prose" dangerouslySetInnerHTML={{ __html: contextHtml }} />}
          <div class="ask-user-pending">Loading response options…</div>
        </div>
      );
    }

    return (
      <div class="ask-user-prompt ask-user-prompt-loading">
        <div class="ask-user-header">
          <span class="ask-user-icon" aria-hidden="true"><QuestionIcon /></span>
          <span class="ask-user-question">Loading prompt…</span>
        </div>
        <div class="ask-user-pending">Loading response options…</div>
      </div>
    );
  }

  // Completed ask_user: show question + answer
  if ((toolCall.status === 'completed' || toolCall.status === 'failed') && parsedInput) {
    const parsedResult = typeof toolCall.result !== 'undefined' ? parseAskUserResult(toolCall.result) : null;
    return (
      <AskUserCompleted
        toolCall={toolCall}
        parsedInput={parsedInput}
        parsedResult={parsedResult}
        onContextMenu={onContextMenu}
      />
    );
  }

  // Fallback: render as a generic tool call card
  return (
    <ToolCallCard
      toolCall={toolCall}
      autoExpand={prefs.autoExpandToolCalls}
      activityTailLines={prefs.activityTailLines}
      workingDirectory={workingDirectory}
      prefs={prefs}
      onOpenFile={onOpenFile}
      onContextMenu={(e) => onContextMenu(getToolCallContextType('ask_user'), JSON.stringify(toolCall, null, 2), e)}
    />
  );
}

// Register the renderer
registerToolRenderer('ask_user', renderAskUserTool);