/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { TurnActivityRegion } from '../turn-activity-region';
import { registerRowRenderer, type RowRendererProps } from '../registry';

function renderTypingIndicator({ row }: RowRendererProps) {
  if (row.kind !== 'typingIndicator') return null;

  return (
    <div class="activity-status-row">
      <TurnActivityRegion state={row.activityState ?? null} standalone />
    </div>
  );
}

registerRowRenderer('typingIndicator', renderTypingIndicator);
