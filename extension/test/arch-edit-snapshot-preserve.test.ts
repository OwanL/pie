/**
 * Regression tests for message EDIT survival across an intermediate idle
 * `session.opened` snapshot.
 *
 * Bug: `session.truncateAfter` (the first half of an edit) rewrites the session
 * file and emits a `session.opened` snapshot while the backend is idle
 * (`busy: false`) — it runs BEFORE `message.send` starts the new turn. The
 * resolution logic only preserved in-memory optimistic/streaming state when the
 * *backend* reported busy, so this idle intermediate snapshot fully replaced the
 * transcript. That wiped the pending optimistic edit message (and the original
 * message + reply), so the transcript cleared and the assistant streamed a reply
 * with no visible user message ("replies to nothing").
 *
 * Fix: treat the host's own running signal (`runningSessionPaths`, set
 * optimistically by `handleEdit`) as an additional preserve trigger, so the
 * optimistic edit message survives the intermediate truncate snapshot. The
 * authoritative `agent_end` snapshot arrives after `BusyChanged(false)` clears
 * `runningSessionPaths`, so it still replaces cleanly with the final transcript.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../src/host/core/reducer';
import type { Event } from '../src/host/core/events';
import type { ChatMessage, SessionOpenedPayload, TranscriptWindow, SessionSummary } from '../src/shared/protocol';

const sessionSummary: SessionSummary = {
  path: '/s',
  name: 'Session',
  cwd: '/workspace',
  modifiedAt: new Date().toISOString(),
  messageCount: 2,
  isPlaceholder: false,
};

const emptyWindow: TranscriptWindow = {
  totalCount: 0,
  loadedStart: 0,
  loadedEnd: 0,
  hasOlder: false,
  hasNewer: false,
  isPartial: false,
  hasUserMessages: false,
};

function userMessage(id: string, markdown: string): ChatMessage {
  return {
    id,
    role: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown,
    status: 'completed',
  };
}

function assistantMessage(id: string, markdown: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    createdAt: '2026-01-01T00:00:01.000Z',
    markdown,
    status: 'completed',
  };
}

/** Mid-edit host state: after confirming the edit, the reducer optimistically
 *  truncated the original user message + reply and appended the edited text as a
 *  `local:` message. The host marks the session running optimistically. */
function midEditState(): ArchState {
  return {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: [sessionSummary],
      openTabPaths: ['/s'],
      activeSessionPath: '/s',
      runningSessionPaths: ['/s'],
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [
          userMessage('local:edit:abc', 'edited question'),
        ],
      },
      windowBySession: {
        '/s': {
          totalCount: 1,
          loadedStart: 0,
          loadedEnd: 1,
          hasOlder: false,
          hasNewer: false,
          isPartial: false,
          hasUserMessages: true,
        },
      },
    },
  };
}

function sessionOpenedEvent(payload: SessionOpenedPayload): Event {
  return { kind: 'SessionOpened', sessionPath: '/s', payload };
}

test('mid-edit idle truncate snapshot (busy:false) preserves the optimistic edit message', () => {
  const state = midEditState();

  // The backend's `session.truncateAfter` emits this snapshot right after
  // rewriting the file: the transcript is truncated to the messages BEFORE the
  // edited entry (here, nothing), and `busy` is false because `message.send`
  // has not started the new turn yet.
  const truncateSnapshot: SessionOpenedPayload = {
    session: sessionSummary,
    transcript: [],
    transcriptWindow: { ...emptyWindow },
    busy: false,
  };

  const result = reducer(state, sessionOpenedEvent(truncateSnapshot));

  const transcript = result.state.transcript.bySession['/s']!;
  // The optimistic edited message must survive — it is newer than the truncated
  // snapshot. Previously this wiped to `[]` and the agent replied to nothing.
  assert.equal(transcript.length, 1, 'optimistic edit message is preserved across the idle truncate snapshot');
  assert.equal(transcript[0]!.id, 'local:edit:abc');
  assert.equal(transcript[0]!.markdown, 'edited question');
  // The original message + reply were truncated away from the backend file, so
  // they must NOT be resurrected into the merged transcript.
  assert.ok(
    !transcript.some((m) => m.id === 'user-1' || m.id === 'assistant-1'),
    'truncated original message + reply are not re-introduced',
  );
});

test('after the turn ends, the authoritative agent_end snapshot still replaces with the persisted transcript', () => {
  // The optimistic edit message is still in the transcript (no snapshot has
  // reconciled it yet), but the turn has ended so the host no longer considers
  // the session running.
  const state: ArchState = {
    ...midEditState(),
    sessions: {
      ...midEditState().sessions,
      runningSessionPaths: [],
    },
  };

  const finalSnapshot: SessionOpenedPayload = {
    session: sessionSummary,
    transcript: [
      userMessage('user-1-persisted', 'edited question'),
      assistantMessage('assistant-1-new', 'new answer'),
    ],
    transcriptWindow: {
      totalCount: 2,
      loadedStart: 0,
      loadedEnd: 2,
      hasOlder: false,
      hasNewer: false,
      isPartial: false,
      hasUserMessages: true,
    },
    busy: false,
  };

  const result = reducer(state, sessionOpenedEvent(finalSnapshot));

  const transcript = result.state.transcript.bySession['/s']!;
  // Once the host is no longer running, the idle authoritative snapshot wins:
  // the optimistic `local:` row is replaced by the persisted form.
  assert.equal(transcript.length, 2);
  assert.equal(transcript[0]!.id, 'user-1-persisted');
  assert.equal(transcript[1]!.id, 'assistant-1-new');
  assert.ok(
    !transcript.some((m) => m.id === 'local:edit:abc'),
    'optimistic edit message is reconciled away by the authoritative final snapshot',
  );
});
