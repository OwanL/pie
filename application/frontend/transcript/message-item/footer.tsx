/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { TurnActivityState } from '../activity';
import { TurnActivityRegion } from '../turn-activity-region';
import { useActivityFooterMotion } from '../activity-status-motion';

interface MessageFooterProps {
  hasActivityFooter: boolean | undefined;
  footerActivityState: TurnActivityState | null;
}

export function MessageFooter({ hasActivityFooter, footerActivityState }: MessageFooterProps) {
  const active = Boolean(hasActivityFooter && footerActivityState);
  const { ref, visible } = useActivityFooterMotion(active);
  if (!visible) return null;

  return (
    <div ref={ref} class="message-activity-footer" aria-hidden={active ? undefined : 'true'} inert={!active}>
      {active && footerActivityState ? <TurnActivityRegion state={footerActivityState} /> : null}
    </div>
  );
}
