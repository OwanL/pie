import type { Event } from '../core/events.js';

export type InterruptedSessionActivity = 'waiting for user input' | 'running a tool' | 'generating';

/** Pure backend-exit notice/cleanup policy. Paths are deduplicated because a
 * session must be counted and terminalized exactly once. Full stderr is kept
 * host-side in noticeRaw; projection redacts credentials before the webview. */
export function backendExitEvents(
  runningSessionPaths: readonly string[],
  code: number | null,
  stderr: string,
  occurredAt: number,
  activityBySession: Readonly<Record<string, InterruptedSessionActivity>> = {},
): Event[] {
  const paths = [...new Set(runningSessionPaths)];
  const codeSuffix = code !== null ? ` (code ${code})` : '';
  const reason = `PI backend stopped unexpectedly${codeSuffix}`;
  const counts = new Map<InterruptedSessionActivity, number>();
  for (const path of paths) {
    const activity = activityBySession[path] ?? 'generating';
    counts.set(activity, (counts.get(activity) ?? 0) + 1);
  }
  const breakdown = [...counts].map(([kind, count]) => `${count} ${kind}`).join(', ');
  const countText = paths.length > 0
    ? ` ${paths.length} ${paths.length === 1 ? 'session was' : 'sessions were'} interrupted${breakdown ? ` (${breakdown})` : ''}.`
    : '.';

  const events: Event[] = [{
    kind: 'NoticeShown',
    notice: `PI backend stopped${codeSuffix}.${countText}`.replace('..', '.'),
    noticeKind: 'backend-exit',
    noticeRaw: stderr || null,
  }];
  if (paths.length > 0) {
    events.push({ kind: 'SessionsInterrupted', sessionPaths: paths, reason, occurredAt });
  }
  events.push({ kind: 'BackendReadyChanged', ready: false });
  events.push({ kind: 'RunningSessionsChanged', sessionPaths: [] });
  return events;
}
