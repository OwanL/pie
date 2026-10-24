import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionControlSender } from '../../lib/rpc/session-control-attribution.js';
import type { SessionContext } from '../../coordinator/server-types.js';
import {
  beginSessionQueueEdit,
  clearSessionNoteQueue,
  deliverSessionNote,
  observeSessionNoteEvent,
  SESSION_NOTE_CUSTOM_TYPE,
  SESSION_NOTE_MAX_BYTES,
  SESSION_NOTE_MAX_PENDING,
  SESSION_NOTE_MAX_PENDING_BYTES,
} from '../session-notes.js';

function fixture(isStreaming = false, withCustomMessage = true) {
  const calls: Array<{ message: unknown; options: unknown }> = [];
  const session = {
    isStreaming,
    prompt: async () => { throw new Error('session note delivery must not call prompt.'); },
    followUp: async () => { throw new Error('session note delivery must not call followUp.'); },
    steer: async () => { throw new Error('session note delivery must not call steer directly.'); },
    ...(withCustomMessage ? {
      sendCustomMessage: async (message: unknown, options: unknown) => { calls.push({ message, options }); },
    } : {}),
  };
  const context = { session, sessionPath: '/workspace/recipient.jsonl' } as unknown as SessionContext;
  const sender = createSessionControlSender(
    { sessionId: 'sender-session', identityFallback: false },
    'Sender',
    { sentAt: 10, expectReply: false },
  );
  return { calls, context, sender };
}

test('idle note appends a visible custom message without triggering a turn', async () => {
  const f = fixture();
  const result = await deliverSessionNote(f.context, {
    id: 'note-1', body: 'The fixture server is ready.', kind: 'note', sender: f.sender,
    task: { id: 'task-7', revision: 2 },
  });

  assert.deepEqual(result, {
    status: 'accepted', delivery: 'appended', id: 'note-1', kind: 'note',
    task: { id: 'task-7', revision: 2 },
  });
  assert.equal(f.calls.length, 1);
  const call = f.calls[0] as { message: { customType: string; content: string; display: boolean; details: Record<string, unknown> }; options: Record<string, unknown> };
  assert.equal(call.message.customType, SESSION_NOTE_CUSTOM_TYPE);
  assert.equal(call.message.display, true);
  assert.match(call.message.content, /No acknowledgement is requested\./u);
  assert.match(call.message.content, /This is context only; it does not assign work\./u);
  assert.match(call.message.content, /Reply address: pie-session:v1:[0-9a-f]{16}/u);
  assert.ok(!call.message.content.includes(f.sender.replyReference));
  assert.match(call.message.content, /The fixture server is ready\./u);
  assert.deepEqual(call.options, { triggerTurn: false });
  assert.equal(call.message.details['id'], 'note-1');
  assert.equal(call.message.details['kind'], 'note');
  assert.equal(call.message.details['displayBody'], 'The fixture server is ready.');
  assert.deepEqual(call.message.details['sender'], f.sender);
  assert.deepEqual(call.message.details['task'], { id: 'task-7', revision: 2 });
});

test('running result queues custom content for the next safe boundary', async () => {
  const f = fixture(true);
  const result = await deliverSessionNote(f.context, {
    id: 'result-1', body: 'Verified: both codecs pass the shared fixture.', kind: 'result', sender: f.sender,
  });

  assert.deepEqual(result, { status: 'queued', delivery: 'queued', id: 'result-1', kind: 'result' });
  assert.equal(f.calls.length, 1);
  const call = f.calls[0] as { message: { content: string }; options: Record<string, unknown> };
  assert.match(call.message.content, /\[Pie cross-session result\]/u);
  assert.match(call.message.content, /Verified: both codecs pass the shared fixture\./u);
  assert.deepEqual(call.options, { triggerTurn: false, deliverAs: 'steer' });
});

test('rejects malformed or oversized payloads and requires no-ack sender attribution', async () => {
  const f = fixture();
  const malformedSender = { ...f.sender, replyReference: 'someone-else' };
  const cases: unknown[] = [
    { id: 'note-2', body: 'x', kind: 'question', sender: f.sender },
    { id: 'note-2', body: 'x', kind: 'note', sender: malformedSender },
    { id: 'note-2', body: 'x', kind: 'note', sender: createSessionControlSender(
      { sessionId: 'sender-session', identityFallback: false }, 'Sender', { sentAt: 10, expectReply: true },
    ) },
    { id: 'note-2', body: '\u00e9'.repeat(SESSION_NOTE_MAX_BYTES), kind: 'note', sender: f.sender },
    { id: 'note-2', body: 'x', kind: 'note', sender: f.sender, unexpected: true },
    { id: 'note-2', body: 'x', kind: 'note', sender: f.sender, task: { id: 'task', revision: 0 } },
  ];

  for (const value of cases) {
    assert.deepEqual(await deliverSessionNote(f.context, value), {
      status: 'rejected', error: 'Invalid session note payload.',
    });
  }
  assert.equal(f.calls.length, 0);
});

test('fails closed when the SDK has no custom-message seam', async () => {
  const f = fixture(false, false);
  assert.deepEqual(await deliverSessionNote(f.context, {
    id: 'note-3', body: 'No wake fallback.', kind: 'note', sender: f.sender,
  }), {
    status: 'unavailable', error: 'The active SDK does not support custom session-note delivery.',
  });
});

test('reports uncertain SDK writes without retrying through another delivery API', async () => {
  const f = fixture();
  f.context.session.sendCustomMessage = async () => {
    f.calls.push({ message: { acceptedBeforeFailure: true }, options: {} });
    throw new Error('SDK write outcome is uncertain.');
  };
  assert.deepEqual(await deliverSessionNote(f.context, {
    id: 'note-4', body: 'Do not retry as a user prompt.', kind: 'note', sender: f.sender,
  }), { status: 'unknown', outcome: 'unknown', error: 'SDK write outcome is uncertain.' });
  assert.equal(f.calls.length, 1);
});

test('bounds streaming pending notes and only exact consumption frees a slot', async () => {
  const f = fixture(true);
  for (let index = 0; index < SESSION_NOTE_MAX_PENDING; index += 1) {
    const result = await deliverSessionNote(f.context, {
      id: `pending-${index}`, body: 'queued note', kind: 'note', sender: f.sender,
    });
    assert.equal(result.status, 'queued');
  }
  const overflow = await deliverSessionNote(f.context, {
    id: 'overflow', body: 'must never be sent to the SDK', kind: 'note', sender: f.sender,
  });
  assert.deepEqual(overflow, {
    status: 'rejected', outcome: 'backpressure', error: 'The session-note SDK queue is at its pending capacity.',
  });
  assert.equal(f.calls.length, SESSION_NOTE_MAX_PENDING, 'rejection happens before SDK enqueue');

  observeSessionNoteEvent(f.context, {
    type: 'message_start', message: { role: 'custom' },
  });
  const wrongType = {
    type: 'message_start', message: {
      role: 'custom', customType: 'other', details: { id: 'pending-0' },
    },
  } as unknown as Parameters<typeof observeSessionNoteEvent>[1];
  observeSessionNoteEvent(f.context, wrongType);
  const stillFull = await deliverSessionNote(f.context, {
    id: 'still-full', body: 'ordinary events did not release the note', kind: 'note', sender: f.sender,
  });
  assert.equal(stillFull.status, 'rejected');

  observeSessionNoteEvent(f.context, {
    type: 'message_start', message: {
      role: 'custom', customType: SESSION_NOTE_CUSTOM_TYPE,
      details: { id: 'pending-0' },
    },
  } as unknown as Parameters<typeof observeSessionNoteEvent>[1]);
  const reused = await deliverSessionNote(f.context, {
    id: 'reused', body: 'one exact consumption freed one slot', kind: 'note', sender: f.sender,
  });
  assert.equal(reused.status, 'queued');
  assert.equal(f.calls.length, SESSION_NOTE_MAX_PENDING + 1);
});

test('bounds aggregate encoded bytes and does not replay an unknown SDK send', async () => {
  const f = fixture(true);
  const body = 'r'.repeat(20_000);
  let accepted = 0;
  let overflow: Awaited<ReturnType<typeof deliverSessionNote>> | undefined;
  for (let index = 0; index < SESSION_NOTE_MAX_PENDING; index += 1) {
    const result = await deliverSessionNote(f.context, {
      id: `large-${index}`, body, kind: 'result', sender: f.sender,
    });
    if (result.status === 'rejected') {
      overflow = result;
      break;
    }
    assert.equal(result.status, 'queued');
    accepted += 1;
  }
  assert.ok(accepted > 1 && accepted < SESSION_NOTE_MAX_PENDING, 'aggregate byte cap should bind before record cap');
  assert.ok(overflow);
  assert.deepEqual(overflow, {
    status: 'rejected', outcome: 'backpressure', error: 'The session-note SDK queue is at its pending capacity.',
  });
  assert.equal(f.calls.length, accepted, 'aggregate byte rejection avoids SDK enqueue');
  const queuedBytes = f.calls.reduce((total, call) => total + Buffer.byteLength(JSON.stringify(call.message), 'utf8'), 0);
  assert.ok(queuedBytes <= SESSION_NOTE_MAX_PENDING_BYTES);

  const unknown = fixture(true);
  unknown.context.session.sendCustomMessage = async () => { throw new Error('uncertain queue write'); };
  assert.equal((await deliverSessionNote(unknown.context, {
    id: 'unknown', body: 'do not retry', kind: 'note', sender: unknown.sender,
  })).status, 'unknown');
  unknown.context.session.sendCustomMessage = async (message: unknown, options: unknown) => {
    unknown.calls.push({ message, options });
  };
  assert.equal((await deliverSessionNote(unknown.context, {
    id: 'unknown', body: 'same id replay', kind: 'note', sender: unknown.sender,
  })).status, 'rejected');
  assert.equal(unknown.calls.length, 0, 'uncertain SDK result remains charged and is never replayed');
  clearSessionNoteQueue(unknown.context);
  assert.equal((await deliverSessionNote(unknown.context, {
    id: 'unknown', body: 'new attempt after confirmed queue clear', kind: 'note', sender: unknown.sender,
  })).status, 'queued');
  assert.equal(unknown.calls.length, 1);
});

test('queue edit admission requires no pending note and rejects new notes until the gate releases', async () => {
  const pending = fixture(true);
  assert.equal((await deliverSessionNote(pending.context, {
    id: 'already-pending', body: 'queued first', kind: 'note', sender: pending.sender,
  })).status, 'queued');
  assert.equal(beginSessionQueueEdit(pending.context), undefined, 'existing queued note prevents edit admission');

  const gated = fixture(true);
  const release = beginSessionQueueEdit(gated.context);
  assert.equal(typeof release, 'function');
  for (const kind of ['note', 'result'] as const) {
    const response = await deliverSessionNote(gated.context, {
      id: `gated-${kind}`, body: 'retry this new intent after the edit', kind, sender: gated.sender,
    });
    assert.deepEqual(response, {
      status: 'rejected', outcome: 'recipient_queue_edit',
      error: 'A queued-message edit is in progress; this note was not queued. Retry the note after the edit finishes.',
    });
  }
  assert.equal(gated.calls.length, 0, 'gate rejection happens before SDK enqueue');

  release?.();
  const retried = await deliverSessionNote(gated.context, {
    id: 'gated-note', body: 'fresh retry after the edit', kind: 'note', sender: gated.sender,
  });
  assert.equal(retried.status, 'queued');
  assert.equal(gated.calls.length, 1);
});
