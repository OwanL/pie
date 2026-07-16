/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { registerRowRenderer, type RowRendererProps } from '../registry';
import { TRANSCRIPT_WINDOW_BUDGETS } from '../../../../shared/transcript-window';

function renderBottomGap({ row, isLoadingNewer, onRequestNewer }: RowRendererProps) {
  const hiddenCount = row.kind === 'bottomGap' ? row.hiddenCount : undefined;
  const label = isLoadingNewer
    ? `Loading newer messages…${hiddenCount === undefined ? '' : ` · ${hiddenCount} not loaded`}`
    : hiddenCount === undefined
      ? 'Load newer messages'
      : `Load ${Math.min(TRANSCRIPT_WINDOW_BUDGETS.pageSize, hiddenCount)} newer messages · ${hiddenCount} not loaded`;
  return (
    <div class="transcript-gap-row transcript-gap-row-bottom">
      <button type="button" class="transcript-gap-btn" disabled={isLoadingNewer} onClick={onRequestNewer}>
        {label}
      </button>
    </div>
  );
}

registerRowRenderer('bottomGap', renderBottomGap);
