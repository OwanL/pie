/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren } from 'preact';
import { useId, useRef } from 'preact/hooks';
import type { ToolCall } from '../../../lib/protocol/index.js';
import { cx } from '../../lib/components/cx';
import { toMouseEvent } from '../../lib/components/preact-events';
import { getToolCallPresentation } from '../tool-call-summary';
import { CollapsibleCloseFooter } from '../../lib/components/collapsible-close-footer';
import { CollapsibleGutter } from '../../lib/components/collapsible-gutter';
import { textFromToolResult } from '../tool-result-text';
import { toolDisclosureKey, useCollapsibleOpen } from '../use-collapsible-open';
import { useLazyDetail } from '../lazy-detail-store';
import { normalizeToolCallName } from '../tool-call-summary-model';
import { DEFAULT_CHAT_PREFS, type ChatPrefs } from '../../../lib/protocol/index.js';
import { formatToolCallResultForDisplay } from './format';
import { buildToolCallHeaderSummaryModel } from './summary-model';
import { ToolCallBody } from './tool-call-body';
import { ToolCallHeader } from './tool-call-header';
import { provisionalToolSummary } from './provisional';
import { liveToolPreview } from './display-model';
import { useToolDisclosureMotion } from './use-tool-disclosure-motion';
import type { ToolResultPruningBadgeData } from '../tool-result-pruning-badge';

interface ToolCallCardProps {
  toolCall: ToolCall;
  /** Retained only for the malformed-subagent fallback. Ordinary calls are
   * always closed initially; manual disclosure is persistent across updates. */
  autoExpand?: boolean;
  activityTailLines?: number;
  className?: string;
  workingDirectory: string | null;
  prefs?: ChatPrefs;
  summary?: string;
  renderDetails?: (toolCall: ToolCall) => ComponentChildren;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: MouseEvent) => void;
}

export function ToolCallCard({ toolCall, autoExpand = false, activityTailLines, className, workingDirectory, prefs = DEFAULT_CHAT_PREFS, summary, renderDetails, onOpenFile, onContextMenu }: ToolCallCardProps) {
  const isProvisional = toolCall.status === 'drafting' || toolCall.status === 'ready';
  const isSubagent = normalizeToolCallName(toolCall.name) === 'subagent';
  const [open, setOpen] = useCollapsibleOpen(toolDisclosureKey(toolCall.id), isSubagent && autoExpand);
  const disclosure = useToolDisclosureMotion(open, !isSubagent);
  const bodyId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const collapse = () => {
    setOpen(false);
    if (!isSubagent) cardRef.current?.querySelector<HTMLButtonElement>('.tool-call-toggle')?.focus();
  };
  const detail = useLazyDetail(toolCall.detailRef, open);
  const renderedCall = detail.state.status === 'loaded' ? { ...toolCall, result: detail.state.value, detailRef: undefined } : toolCall;
  const presentation = getToolCallPresentation(toolCall, { workingDirectory });
  const provisional = provisionalToolSummary(toolCall);
  const headerSummary = provisional?.text ?? summary ?? presentation.summary;
  const headerPath = isProvisional ? undefined : presentation.summaryPath;
  const summaryModel = isProvisional && provisional?.field === 'path'
    ? { kind: 'path' as const, text: headerSummary ?? '' }
    : isProvisional || summary !== undefined
      ? { kind: 'text' as const, text: headerSummary ?? '' }
      : buildToolCallHeaderSummaryModel(toolCall.name, headerSummary, headerPath, toolCall);
  const errorDetail = toolCall.status === 'failed' ? (textFromToolResult(renderedCall.result) ?? formatToolCallResultForDisplay(renderedCall)) || undefined : undefined;
  const pruningBadge = (toolCall.result as { details?: { pruningBadge?: ToolResultPruningBadgeData } } | null | undefined)?.details?.pruningBadge;
  const preview = !open && !isSubagent ? liveToolPreview(toolCall, activityTailLines ?? prefs.activityTailLines) : null;

  return (
    <div ref={cardRef} class={cx('tool-call-card', className)} data-status={toolCall.status} data-provisional={isProvisional ? 'true' : undefined}
      role="group" aria-label={`${presentation.name} tool call, ${isProvisional ? (toolCall.status === 'drafting' ? 'Drafting' : 'Ready') : toolCall.status}`}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(toMouseEvent(e)); }}>
      <ToolCallHeader open={open} name={presentation.name} status={toolCall.status} summary={headerSummary} summaryPath={headerPath}
        summaryModel={summaryModel ?? undefined} errorDetail={errorDetail} pruningBadge={pruningBadge}
        durationMs={toolCall.durationMs} ariaControls={disclosure.mounted ? bodyId : undefined} prefs={prefs} toolCall={toolCall}
        onToggle={() => setOpen((value) => !value)} />
      {preview && <div class="tool-call-live-preview" role="group" aria-label={`${presentation.name} ${preview.provisional ? 'draft input' : 'live result'} preview`}>
        {preview.truncated && <span class="tool-call-preview-truncation" title="Recent content only. Expand for all available details."><span aria-hidden="true">…</span><span class="sr-only">Earlier preview content omitted.</span></span>}
        {preview.provisional && preview.editIndex !== undefined && <span class="tool-call-preview-label">replacement {preview.editIndex}</span>}
        <pre style={{ '--tool-preview-lines': preview.lines }} data-truncated={preview.truncated ? 'true' : undefined}>{preview.text}</pre>
      </div>}
      {disclosure.mounted && <div ref={disclosure.bodyRef} id={bodyId} class={cx('tool-call-body-wrap', !isSubagent && 'tool-call-disclosure-body')} inert={!open} aria-hidden={!open}><div class={cx('tool-call-body-inner', !isSubagent && 'tool-call-inspector-body')}>
        {renderDetails && !isProvisional ? renderDetails(renderedCall) : <ToolCallBody toolCall={renderedCall} prefs={prefs} headerPath={headerPath} workingDirectory={workingDirectory} onOpenFile={onOpenFile} />}
        {toolCall.detailRef && detail.state.status !== 'loaded' && <div class="tool-call-detail-status" role="status">
          {detail.state.status === 'loading' || detail.state.status === 'idle' ? 'Loading details…' : <><span>{detail.state.message}</span><button type="button" onClick={detail.retry}>Retry</button></>}
        </div>}
        <CollapsibleCloseFooter onCollapse={collapse} label={isSubagent ? 'Collapse' : 'Collapse details'} />
        <CollapsibleGutter onCollapse={collapse} label={isSubagent ? 'Collapse' : `Collapse ${presentation.name} details`} class={!isSubagent ? 'tool-call-collapse-rail' : undefined} />
      </div></div>}
    </div>
  );
}
