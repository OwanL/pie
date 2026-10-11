import { useCallback } from 'preact/hooks';
import type { WebviewToHostMessage } from '../../lib/protocol/index.js';
import type { SnoozeDuration } from './snooze';

export function useSnoozeCommands(postMessage: (message: WebviewToHostMessage) => unknown) {
  const snooze = useCallback((sessionPath: string, durationHours: SnoozeDuration) => {
    postMessage({ type: 'snoozeSession', sessionPath, durationHours });
  }, [postMessage]);
  const restore = useCallback((sessionPath: string) => {
    postMessage({ type: 'restoreSnoozedSession', sessionPath });
  }, [postMessage]);
  return { snooze, restore };
}
