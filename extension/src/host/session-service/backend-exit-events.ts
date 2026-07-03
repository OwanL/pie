import type { Event } from '../core/events.js';

/**
 * Pure policy: given the running session paths at backend-exit time and the
 * exit info, return the sequence of `Event`s the host should dispatch.
 *
 * Extracted from `attach.ts#onExit` so the alert behavior is unit-testable
 * without mocking `vscode`. When one or more sessions were streaming, the
 * returned events include `SessionsInterrupted` so the reducer can mark their
 * orphaned streaming assistant messages `interrupted` with a reason — no
 * `message.aborted` event ever fires when the backend dies, so without this
 * those messages would stay `status: 'streaming'` forever and the user would
 * never be alerted that the interruption was not their doing. When nothing was
 * running, only the generic "PI backend stopped" notice is returned — a clean
 * exit with no in-flight work should not produce an interrupt alert.
 */
export function backendExitEvents(
  runningSessionPaths: readonly string[],
  code: number | null,
  stderr: string,
): Event[] {
  const codeSuffix = code !== null ? ` (code ${code})` : '';
  const stderrSuffix = stderr ? `: ${stderr.slice(0, 300)}` : '';
  const baseNotice = `PI backend stopped${codeSuffix}${stderrSuffix}.`;
  const interruptReason = `PI backend stopped unexpectedly${codeSuffix}${stderrSuffix}`;

  const events: Event[] = [];
  if (runningSessionPaths.length > 0) {
    const countSuffix = runningSessionPaths.length === 1
      ? ' The active session was interrupted.'
      : ` ${runningSessionPaths.length} running sessions were interrupted.`;
    events.push({ kind: 'NoticeShown', notice: baseNotice + countSuffix });
    events.push({
      kind: 'SessionsInterrupted',
      sessionPaths: [...runningSessionPaths],
      reason: interruptReason,
    });
  } else {
    events.push({ kind: 'NoticeShown', notice: baseNotice });
  }
  events.push({ kind: 'BackendReadyChanged', ready: false });
  events.push({ kind: 'RunningSessionsChanged', sessionPaths: [] });
  return events;
}
