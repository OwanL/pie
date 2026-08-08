/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { ClickablePathButton } from '../../file-path';

import type { ToolCallHeaderSummaryModel } from './types';

export function CollapsedSummary({
  model,
  summaryPath,
  parentDepth,
  onOpenFile,
}: {
  model: ToolCallHeaderSummaryModel;
  summaryPath?: string;
  parentDepth?: number;
  onOpenFile: (path: string) => void;
}) {
  if (model.kind === 'text') {
    return (
      <span class="transcript-header-summary-mono block min-w-0 max-w-full flex-1 truncate" title={model.text}>
        {model.text}
      </span>
    );
  }

  if (model.kind === 'path') {
    return (
      <span class="block min-w-0 max-w-full flex-1" title={summaryPath ?? model.title ?? model.text}>
        <ClickablePathButton path={summaryPath ?? model.title ?? model.text} displayText={model.text} parentDepth={parentDepth} onOpenFile={onOpenFile} />
      </span>
    );
  }

  return (
    <span class="transcript-header-command-preview" title={model.title}>
      {model.prefix && <span class="transcript-header-command-prefix transcript-header-summary-subtle">{model.prefix}</span>}
      <span class="transcript-header-command-verb transcript-header-summary-command">{model.command}</span>
      {(model.detail || model.pathText || model.suffix) && (
        <span class="transcript-header-command-details">
          {model.detail && <span class="transcript-header-command-tail transcript-header-summary-mono">{model.detail}</span>}
          {model.pathLeadingQuote && <span class="transcript-header-command-tail transcript-header-summary-subtle">{model.pathLeadingQuote}</span>}
          {model.pathText && <ClickablePathButton path={model.pathText} displayText={model.pathText} parentDepth={parentDepth} />}
          {model.pathTrailingQuote && <span class="transcript-header-command-tail transcript-header-summary-subtle">{model.pathTrailingQuote}</span>}
          {model.suffix && <span class="transcript-header-command-tail transcript-header-summary-subtle">{model.suffix}</span>}
        </span>
      )}
    </span>
  );
}
