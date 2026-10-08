/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ToolCall } from '../../../lib/protocol/index.js';

/** Pending and processing marks disappear at completion. Failure keeps the
 *  header's visible, interactive Failed chip and copy-error affordance. */
export function ToolCallStatusGlyph({ status }: { status: ToolCall['status'] }) {
  if (status === 'running') {
    return (
      <span
        class="tool-call-status-spinner"
        role="img"
        aria-label="Running"
        title="Running · processing"
      />
    );
  }
  if (status === 'drafting' || status === 'ready') {
    return <span class="tool-call-status-draft" role="img" aria-label={status === 'drafting' ? 'Drafting' : 'Ready'} title={status === 'drafting' ? 'Generating tool arguments' : 'Arguments ready'} />;
  }
  return null;
}
