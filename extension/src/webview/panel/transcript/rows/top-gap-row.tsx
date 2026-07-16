/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { registerRowRenderer, type RowRendererProps } from '../registry';
import { TRANSCRIPT_WINDOW_BUDGETS } from '../../../../shared/transcript-window';

function renderTopGap({ row, isLoadingOlder, onRequestOlder }: RowRendererProps) {
  const hiddenCount = row.kind === 'topGap' ? row.hiddenCount : undefined;
  const label = isLoadingOlder
    ? `Loading older messages…${hiddenCount === undefined ? '' : ` · ${hiddenCount} not loaded`}`
    : hiddenCount === undefined
      ? 'Load older messages'
      : `Load ${Math.min(TRANSCRIPT_WINDOW_BUDGETS.pageSize, hiddenCount)} older messages · ${hiddenCount} not loaded`;
  return (
    <div class="transcript-gap-row">
      <button type="button" class="transcript-gap-btn" disabled={isLoadingOlder} onClick={onRequestOlder}>
        {label}
      </button>
    </div>
  );
}

registerRowRenderer('topGap', renderTopGap);
