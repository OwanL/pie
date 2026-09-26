import { produce } from 'immer';

import type { ArchState } from '../arch-state.js';
import type { Event } from '../events.js';
import type { ReducerResult } from './helpers.js';

export function handleFileChangesUpdated(
  state: ArchState,
  event: Extract<Event, { kind: 'FileChangesUpdated' }>,
): ReducerResult {
  // Capture the pre-update change list + read set from the original state
  // (before the Immer draft mutates bySession) so the email-like un-mark
  // below compares against the previous toolCallId per path, not the new one.
  const prevChanges = state.fileChanges.bySession[event.sessionPath] ?? [];
  const readPaths = state.fileChanges.readFilePathsBySession[event.sessionPath];

  return {
    state: produce(state, (draft) => {
      draft.fileChanges.bySession[event.sessionPath] = event.fileChanges;

      // Email-like read state: a path that received a NEW tool-call
      // modification since the last update flips back to unread. A changed
      // `toolCallId` for an existing path is the signal — derivation assigns a
      // stable toolCallId per tool call, so it only changes when a genuinely
      // new modification lands (incremental upsert in tools.ts, or a re-derive
      // that now includes a newer tool call). Paths with no previous change
      // entry, or that dropped out of the list, are left untouched (not a new
      // modification — keep their read state as-is).
      //
      // Known limitation: re-derivation only sees the LOADED transcript
      // window (attach.ts), so a window that narrows (e.g. after
      // session.truncateAfter, or a SessionOpened refresh resolving a
      // different range) can make a path's visible `toolCallId` regress to an
      // earlier tool call and trip a false-positive demote-to-unread. This is
      // low-severity: read state is in-memory/per-session and usually empty at
      // open (when re-derivation runs), and the only effect is demoting a file
      // back to unread (no data loss). After a truncate the file's diff is
      // genuinely different from what was reviewed, so a demote is arguably
      // correct there anyway. A monotonic per-path version counter would be a
      // more robust signal if this ever bites.
      if (readPaths && readPaths.length > 0) {
        const prevToolByPath = new Map<string, string>();
        for (const e of prevChanges) prevToolByPath.set(e.path, e.toolCallId);
        const nextToolByPath = new Map<string, string>();
        for (const e of event.fileChanges) nextToolByPath.set(e.path, e.toolCallId);
        // The filter only ever REMOVES paths (never adds), so a matching length
        // means nothing was un-marked — skip the write so the read-set keeps
        // its reference and the webview's `readSet` useMemo stays stable.
        const stillRead = readPaths.filter((p) => {
          const prevTc = prevToolByPath.get(p);
          const nextTc = nextToolByPath.get(p);
          if (prevTc === undefined || nextTc === undefined) return true;
          return nextTc === prevTc;
        });
        if (stillRead.length !== readPaths.length) {
          draft.fileChanges.readFilePathsBySession[event.sessionPath] = stillRead;
        }
      }
    }),
    effects: [],
  };
}

/** `FileRevertResult` — settle a destructive changed-file revert. The row is
 *  removed from the reducer only after the effect confirms success (`ok:true`
 *  carries `filePath`); a failed/cancelled revert leaves the row present so
 *  the user does not lose the entry (or its read state) for a file whose
 *  changes are still there. A cancelled inline confirm (`error: 'cancelled'`)
 *  stays quiet; a real failure surfaces an operational notice consistent with
 *  the compact/interrupt failure pattern. */
export function handleFileRevertResult(
  state: ArchState,
  event: Extract<Event, { kind: 'FileRevertResult' }>,
): ReducerResult {
  if (!event.ok) {
    if (event.error === 'cancelled') return { state, effects: [] };
    return {
      state: {
        ...state,
        settings: {
          ...state.settings,
          notice: 'Could not revert that file.',
          noticeKind: 'operational-error',
          noticeRaw: event.error ?? 'revertFile failed',
          noticeSessionPath: event.sessionPath,
        },
      },
      effects: [],
    };
  }
  const nextState = produce(state, (draft) => {
    const changes = draft.fileChanges.bySession[event.sessionPath];
    if (changes) {
      draft.fileChanges.bySession[event.sessionPath] = changes.filter((c) => c.path !== event.filePath);
    }
  });
  return { state: nextState, effects: [] };
}
