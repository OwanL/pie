/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ToolCall } from '../../../../shared/protocol';

/** Compact status indicator shown at the right of the tool-call header: a
 *  spinner while running, nothing once completed. Failed keeps the
 *  interactive "Failed" status chip (with copy-error affordance) rendered by
 *  the header, so it is intentionally absent here. Follows an "alert on
 *  failure, not on success" philosophy — completion is the expected/default
 *  state and gets no glyph. */
export function ToolCallStatusGlyph({ status }: { status: ToolCall['status'] }) {
  if (status === 'running') {
    return (
      <span
        class="tool-call-status-spinner"
        role="img"
        aria-label="Running"
      />
    );
  }
  return null;
}
