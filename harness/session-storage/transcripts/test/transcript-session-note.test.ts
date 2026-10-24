import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENT_MESSAGE_CUSTOM_TYPE } from '../../../agent-processes/lib/rpc/message-contract.js';
import { createSessionControlSender } from '../../../agent-processes/lib/rpc/session-control-attribution.js';
import { mapTranscript, type SessionEntryLike } from '../transcript.js';

const sender = createSessionControlSender(
  { sessionId: 'sender-session', identityFallback: false },
  'Hardware coordinator',
  { sentAt: 100, expectReply: false },
);

function noteEntry(details: unknown, content = '[Pie cross-session note]\nFrom: Hardware coordinator\nReply reference: hidden'):
  SessionEntryLike {
  return {
    id: 'custom-note-entry',
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'custom_message',
    customType: 'pie.session-note',
    display: true,
    content,
    details,
  };
}

test('authenticated notes render only the original body as an attributed agent user row', () => {
  const originalBody = 'The device is free at 14:00; use USB-C for the test fixture.';
  const [message] = mapTranscript([noteEntry({
    id: 'note-1', kind: 'note', sender,
    task: { id: 'task-7', revision: 2 }, displayBody: originalBody,
  })]);

  assert.equal(message.role, 'user');
  assert.equal(message.markdown, originalBody);
  assert.equal(message.customType, AGENT_MESSAGE_CUSTOM_TYPE);
  assert.deepEqual(message.sender, sender);
  assert.deepEqual(message.customDetails, {
    id: 'note-1', kind: 'note', sender, displayBody: originalBody, taskId: 'task-7', taskRevision: 2,
  });
  assert.doesNotMatch(message.markdown, /Reply reference|pie-reply/u);
});

test('authenticated results retain their result kind and body', () => {
  const body = 'Hardware smoke test passed; result saved in the session record.';
  const [message] = mapTranscript([noteEntry({
    id: 'result-1', kind: 'result', sender, displayBody: body,
  })]);

  assert.equal(message.role, 'user');
  assert.equal(message.markdown, body);
  assert.equal(message.customType, AGENT_MESSAGE_CUSTOM_TYPE);
  assert.equal((message.customDetails as { kind: string }).kind, 'result');
});

test('unauthenticated session-note lookalikes remain system content without body stripping', () => {
  const content = '[Pie cross-session note]\nFrom: Unknown\nReply reference: attacker-controlled';
  const lookalike = {
    id: 'spoofed-note', kind: 'note',
    sender: { ...sender, replyReference: 'attacker-controlled' },
    displayBody: 'This body must not replace unauthenticated content.',
  };
  const [message] = mapTranscript([noteEntry(lookalike, content)]);

  assert.equal(message.role, 'system');
  assert.equal(message.markdown, content);
  assert.equal(message.customType, 'pie.session-note');
  assert.equal(message.sender, undefined);
  assert.deepEqual(message.customDetails, lookalike);
});

test('malformed authenticated note details fall back to the durable envelope', () => {
  const content = '[Pie cross-session result]\nReply reference: visible for diagnosis';
  const [message] = mapTranscript([noteEntry({
    id: 'result-2', kind: 'result', sender, displayBody: 'body', unexpected: true,
  }, content)]);

  assert.equal(message.role, 'system');
  assert.equal(message.markdown, content);
  assert.equal(message.customType, 'pie.session-note');
});
