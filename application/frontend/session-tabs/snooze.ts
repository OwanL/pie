import type { SessionCapabilities } from '../../lib/protocol/index.js';
import type { SessionSnoozeDuration as SnoozeDuration } from '../../lib/protocol/session-snooze.js';
import { isPendingTabPath } from '../../lib/session-tabs/tab-behavior.js';

export type { SessionSnoozeDuration as SnoozeDuration, SnoozedSession } from '../../lib/protocol/session-snooze.js';
export const SNOOZE_PRESETS: ReadonlyArray<{ duration: SnoozeDuration; label: string }> = [
  { duration: 4, label: '4 hours' },
  { duration: 8, label: '8 hours' },
  { duration: 12, label: '12 hours' },
  { duration: 24, label: '24 hours' },
  { duration: 48, label: '48 hours' },
  { duration: 'monday', label: 'Until Monday morning' },
];

export function getSnoozeBlockedReason(
  path: string,
  capabilities: SessionCapabilities | undefined,
  running: boolean,
  starting: boolean,
  deferred: boolean,
  pendingUIRequest: boolean,
): string | undefined {
  if (isPendingTabPath(path)) return 'A pending session cannot be snoozed yet.';
  if (pendingUIRequest) return 'Respond to the pending extension request before snoozing.';
  if (deferred) return 'Cancel pending deferred triggers before snoozing.';
  if (running || starting || capabilities?.billableActivity || capabilities?.primaryOperation) {
    return 'Wait for session activity to finish before snoozing.';
  }
  return undefined;
}
