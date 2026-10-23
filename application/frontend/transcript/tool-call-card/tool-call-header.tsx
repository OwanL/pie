/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ToolCall } from '../../../lib/protocol/index.js';
import { CollapsibleChevron } from '../../lib/components/chevron';
import { formatDuration } from '../header';
import { StatusChip } from '../status-chip';
import { DEFAULT_CHAT_PREFS, type ChatPrefs } from '../../../lib/protocol/index.js';
import { CollapsedSummary } from './collapsed-summary';
import { ToolCallStatusGlyph } from './status-glyph';
import { buildToolCallHeaderSummaryModel } from './summary-model';
import type { ToolCallHeaderSummaryModel } from './types';
import { ToolResultPruningBadge, type ToolResultPruningBadgeData } from '../tool-result-pruning-badge';
import { ToolIcon, toolIconKind } from './tool-icon';
import { RawToolInspector } from './raw-tool-inspector';
import { splitSummaryPath } from '../../file-changes/file-path';
import { normalizeToolCallName } from '../tool-call-summary-model';
import { toolHeaderDetail } from './header-details';
import { readOutputPreview } from './read-output-preview';

interface ToolCallHeaderProps {
  open: boolean;
  bodyVisible?: boolean;
  name: string;
  nameTitle?: string;
  status: ToolCall['status'];
  summary: string | null;
  summaryPath?: string;
  summaryModel?: ToolCallHeaderSummaryModel;
  sizeHint?: string;
  errorDetail?: string;
  pruningBadge?: ToolResultPruningBadgeData | null;
  durationMs?: number;
  ariaControls?: string;
  prefs?: ChatPrefs;
  toolCall?: ToolCall;
  onOpenFile: (path: string) => void;
  onToggle: () => void;
}

export function ToolCallHeader({ open, name, nameTitle, status, summary, summaryPath, summaryModel, sizeHint, errorDetail, pruningBadge, durationMs, ariaControls, prefs = DEFAULT_CHAT_PREFS, toolCall, onOpenFile, onToggle }: ToolCallHeaderProps) {
  const kind = toolIconKind(toolCall?.name ?? name);
  const accessibleStatus = status === 'drafting' ? 'Drafting' : status === 'ready' ? 'Ready' : status === 'running' ? 'Running' : status === 'failed' ? 'Failed' : 'Completed';
  const model = summaryModel ?? buildToolCallHeaderSummaryModel(name, summary, summaryPath);
  const accessibleTarget = model?.kind === 'command' ? model.title : model?.kind === 'path' ? summaryPath ?? model.title ?? model.text : summary;
  const isSubagent = normalizeToolCallName(toolCall?.name ?? name) === 'subagent';
  const filenameOnly = model?.kind === 'path' && !isSubagent;
  const filePath = filenameOnly ? summaryPath ?? model.title ?? model.text : undefined;
  const duration = (status === 'completed' || status === 'failed') && typeof durationMs === 'number' && durationMs >= 0 ? formatDuration(durationMs) : null;
  const failureTiming = duration ? `Tool execution time: ${duration}` : undefined;
  const detail = toolCall && !isSubagent ? toolHeaderDetail(toolCall) : null;
  const preview = toolCall && !open ? readOutputPreview(toolCall) : null;
  const active = status === 'drafting' || status === 'ready' || status === 'running';
  const showSize = status !== 'failed' && !!sizeHint;
  const showPruning = status !== 'failed' && !!pruningBadge && pruningBadge.tokensSaved > 0;
  const hasMetadata = showSize || showPruning || duration || active || status === 'failed';
  const canOpenFile = !!summaryPath && !!splitSummaryPath(summaryPath).fileSection;
  return (
    <div class="tool-call-header">
      {/* Icon inspection, disclosure and file/error actions are siblings.
          Never nest another interactive target inside the native toggle. */}
      {toolCall ? <RawToolInspector toolCall={toolCall} /> : <span class="tool-call-kind-icon"><ToolIcon kind={kind} /></span>}
      <button type="button" class="tool-call-toggle" aria-expanded={open} aria-controls={ariaControls} data-pie-file-path={status !== 'drafting' && status !== 'ready' ? filePath : undefined}
        aria-label={`${name} tool call, ${accessibleStatus}.${accessibleTarget ? ` ${accessibleTarget}.` : ''}${detail ? ` ${detail}.` : ''} ${open ? 'Collapse' : 'Expand'} details`}
        title={`${filePath ?? nameTitle ?? name} · ${open ? 'Collapse' : 'Expand'} details`} onClick={onToggle}>
        <span class="tool-call-heading-content">
          {(kind === 'tool' || !model) && <span class="tool-call-name">{name}</span>}
          {model && (isSubagent
            ? <CollapsedSummary model={model} summaryPath={summaryPath} parentDepth={prefs.uiPathParentDepth} />
            : <span class="tool-call-primary-summary"><CollapsedSummary model={model} summaryPath={summaryPath} parentDepth={filenameOnly ? 0 : prefs.uiPathParentDepth} /></span>)}
          {preview && <span class="tool-call-read-preview" aria-hidden="true">{preview.end ? `${preview.start} … ${preview.end}` : preview.start}</span>}
          {detail && <span class="tool-call-secondary-detail" title={detail}>{detail}</span>}
        </span>
        {isSubagent && <CollapsibleChevron open={open} class="tool-call-disclosure" />}
      </button>
      {canOpenFile && <div class="tool-call-actions">
        <button type="button" class="tool-call-action" aria-label={`Open file ${summaryPath}`} title="Open file" onClick={() => onOpenFile(summaryPath!)}><ToolIcon kind="open" /></button>
      </div>}
      {/* Right-edge priority: failure > live/pending state > duration > pruning > size.
          Keep low-priority metadata first and file actions outside the trailing edge. */}
      {hasMetadata && <div class="tool-call-header-meta">
        {showSize && <span class="tool-call-size" title={sizeHint}>{sizeHint}</span>}
        {showPruning && <ToolResultPruningBadge badge={pruningBadge} compact />}
        {duration && <span class="tool-call-duration" title="Tool execution time">{duration}</span>}
        {status === 'failed' && <StatusChip tone="failed" label="Failed" copyText={errorDetail}
          title={[errorDetail, failureTiming].filter(Boolean).join(' · ') || undefined}
          copyAriaLabel={errorDetail ? 'Copy tool-call error detail' : undefined} />}
        {active && <ToolCallStatusGlyph status={status} />}
      </div>}
    </div>
  );
}
