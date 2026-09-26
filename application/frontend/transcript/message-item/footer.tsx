/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { TurnActivityState } from '../activity';
import { TurnActivityRegion } from '../turn-activity-region';

interface MessageFooterProps {
  hasActivityFooter: boolean | undefined;
  footerActivityState: TurnActivityState | null;
}

export function MessageFooter({ hasActivityFooter, footerActivityState }: MessageFooterProps) {
  if (!hasActivityFooter) return null;

  return (
    <div class="message-activity-footer">
      {footerActivityState ? <TurnActivityRegion state={footerActivityState} /> : null}
    </div>
  );
}
