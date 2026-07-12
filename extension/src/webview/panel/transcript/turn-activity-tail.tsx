/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { TurnActivityState } from './activity';
import { TurnActivityTailBody } from './activity-tail-preview';

interface TurnActivityBlockProps {
  state: TurnActivityState;
}

/**
 * Compact live-activity block: just the terminal-style tail body in a subtle
 * framed surface. The separate header strip (label + bouncing dots) is gone
 * for tail phases - the tail's own content carries the signal (caret + streaming
 * text). No-tail phases (thinking / preparing / pruning / starting model)
 * render the bare `TurnActivityStrip` directly at the call sites.
 */
export function TurnActivityBlock({ state }: TurnActivityBlockProps) {
  const tail = state.tail;
  if (!tail) return null;
  return (
    <div class="turn-activity-block" role="status" aria-label={state.ariaLabel}>
      <TurnActivityTailBody tail={tail} />
    </div>
  );
}
