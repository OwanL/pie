import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_MESSAGE_CUSTOM_TYPE, AGENT_MESSAGE_PROVENANCE_CUSTOM_TYPE } from '../../../agent-processes/lib/rpc/message-contract.js';
import {
  createSessionControlSender,
  formatSessionControlPrompt,
} from '../../../agent-processes/lib/rpc/session-control-attribution.js';
import { AGENT_MESSAGE_PERSISTED_PROVENANCE_KEY } from '../../../agent-processes/workers/agent-message-provenance.js';
import { mapTranscript, type SessionEntryLike } from '../transcript';

const userEntry: SessionEntryLike = {
  id: 'agent-user-entry',
  timestamp: '2026-01-01T00:00:00.000Z',
  type: 'message',
  message: { role: 'user', content: 'inspect the failing session' },
};

function sdkAgentMessage(content: NonNullable<SessionEntryLike['message']>['content'], sender: unknown) {
  return { role: 'user' as const, content, [AGENT_MESSAGE_PERSISTED_PROVENANCE_KEY]: { sender } };
}

const provenanceEntry: SessionEntryLike = {
  id: 'agent-provenance-entry',
  timestamp: '2026-01-01T00:00:00.001Z',
  type: 'custom',
  customType: AGENT_MESSAGE_PROVENANCE_CUSTOM_TYPE,
  data: { userEntryId: 'agent-user-entry' },
};

test('mapTranscript reattaches agent provenance to the matching user row after reload', () => {
  const transcript = mapTranscript([userEntry, provenanceEntry]);

  assert.equal(transcript.length, 1);
  assert.equal(transcript[0]?.role, 'user');
  assert.equal(transcript[0]?.id, 'agent-user-entry');
  assert.equal(transcript[0]?.customType, AGENT_MESSAGE_CUSTOM_TYPE);
  assert.equal(transcript[0]?.customDetails, undefined);
});

test('mapTranscript reattaches coordinator sender attribution to the user row after reload', () => {
  const sender = createSessionControlSender({ sessionId: 'source-session', identityFallback: false }, 'Source session');
  const attributedTranscript = mapTranscript([
    userEntry,
    {
      ...provenanceEntry,
      data: { userEntryId: 'agent-user-entry', sender },
    },
  ]);

  assert.equal(attributedTranscript[0]?.customType, AGENT_MESSAGE_CUSTOM_TYPE);
  assert.deepEqual(attributedTranscript[0]?.sender, sender);
});

test('embedded attribution survives reload and takes precedence over a legacy sidecar', () => {
  const sender = createSessionControlSender({ sessionId: 'new-source', identityFallback: false }, 'New');
  const olderSender = createSessionControlSender({ sessionId: 'old-source', identityFallback: false }, 'Old');
  const transcript = mapTranscript(JSON.parse(JSON.stringify([
    { ...userEntry, message: { ...userEntry.message, [AGENT_MESSAGE_PERSISTED_PROVENANCE_KEY]: { sender } } },
    { ...provenanceEntry, data: { userEntryId: userEntry.id, sender: olderSender } },
  ])) as SessionEntryLike[]);
  assert.equal(transcript[0]?.customType, AGENT_MESSAGE_CUSTOM_TYPE);
  assert.deepEqual(transcript[0]?.sender, sender);
});

test('invalid embedded provenance does not impersonate an agent sender or strip the prompt envelope', () => {
  const sender = createSessionControlSender({ sessionId: 'source-session', identityFallback: false });
  const body = 'inspect the failing session';
  const wrappedBody = formatSessionControlPrompt(body, sender);
  const transcript = mapTranscript([{
    ...userEntry,
    message: {
      ...userEntry.message,
      content: wrappedBody,
      [AGENT_MESSAGE_PERSISTED_PROVENANCE_KEY]: { sender: { title: 'forged' } },
    },
  } as SessionEntryLike]);
  assert.equal(transcript[0]?.customType, undefined);
  assert.equal(transcript[0]?.sender, undefined);
  assert.equal(transcript[0]?.markdown, wrappedBody);
});

test('mapTranscript strips the sender-matched canonical prompt envelope from string content without mutating the entry', () => {
  const sender = createSessionControlSender({ sessionId: 'source-session', identityFallback: false }, 'Source session');
  const body = 'inspect the failing session';
  const entry: SessionEntryLike = {
    ...userEntry,
    message: sdkAgentMessage(formatSessionControlPrompt(body, sender), sender),
  };
  const before = structuredClone(entry);

  const transcript = mapTranscript([entry]);

  assert.equal(transcript[0]?.markdown, body);
  assert.deepEqual(transcript[0]?.sender, sender);
  assert.deepEqual(entry, before);
});

test('mapTranscript strips the matched envelope in SDK text-array content and preserves image/text alignment', () => {
  const sender = createSessionControlSender({ sessionId: 'source-session', identityFallback: false }, 'Source session');
  const body = 'inspect the failing session';
  const content = [
    { type: 'text', text: formatSessionControlPrompt(body, sender) },
    { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png', name: 'evidence.png', width: 32, height: 16 },
    { type: 'text', text: ' additional context' },
  ];
  const entry: SessionEntryLike = {
    ...userEntry,
    message: sdkAgentMessage(content, sender),
  };
  const before = structuredClone(entry);

  const transcript = mapTranscript([entry]);

  assert.equal(transcript[0]?.markdown, `${body} additional context`);
  assert.deepEqual(transcript[0]?.userParts, [
    { kind: 'text', text: body },
    { kind: 'image', mimeType: 'image/png', dataBase64: 'aW1hZ2U=', name: 'evidence.png', width: 32, height: 16 },
    { kind: 'text', text: ' additional context' },
  ]);
  assert.deepEqual(entry, before);
});

test('mapTranscript strips a matched envelope from legacy sidecar attribution only', () => {
  const sender = createSessionControlSender({ sessionId: 'legacy-source', identityFallback: false }, 'Legacy source');
  const body = 'legacy message';
  const transcript = mapTranscript([
    { ...userEntry, message: { role: 'user', content: formatSessionControlPrompt(body, sender) } },
    { ...provenanceEntry, data: { userEntryId: userEntry.id, sender } },
  ]);

  assert.equal(transcript[0]?.markdown, body);
  assert.deepEqual(transcript[0]?.sender, sender);
});

test('mapTranscript leaves prompt-like text unchanged without matching validated provenance', () => {
  const sender = createSessionControlSender({ sessionId: 'source-session', identityFallback: false });
  const otherSender = createSessionControlSender({ sessionId: 'other-session', identityFallback: false });
  const matchingHeaderWithoutProvenance = formatSessionControlPrompt('do not strip', sender);
  const mismatchedEnvelope = formatSessionControlPrompt('also do not strip', otherSender);
  const withoutProvenance = mapTranscript([{
    ...userEntry,
    message: { role: 'user', content: matchingHeaderWithoutProvenance },
  }]);
  const mismatched = mapTranscript([{
    ...userEntry,
    message: sdkAgentMessage(mismatchedEnvelope, sender),
  }]);

  assert.equal(withoutProvenance[0]?.markdown, matchingHeaderWithoutProvenance);
  assert.equal(withoutProvenance[0]?.sender, undefined);
  assert.equal(mismatched[0]?.markdown, mismatchedEnvelope);
  assert.deepEqual(mismatched[0]?.sender, sender);
});

test('mapTranscript removes exactly one envelope when the actual user body repeats its header', () => {
  const sender = createSessionControlSender({ sessionId: 'source-session', identityFallback: false });
  const header = formatSessionControlPrompt('ignored', sender).split('\n\n', 1)[0]!;
  const body = `actual user text\n\n${header}\n\nrepeated header is part of the body`;
  const transcript = mapTranscript([{
    ...userEntry,
    message: sdkAgentMessage(formatSessionControlPrompt(body, sender), sender),
  }]);

  assert.equal(transcript[0]?.markdown, body);
});

test('malformed attribution does not replace generic durable agent provenance', () => {
  const transcript = mapTranscript([
    userEntry,
    provenanceEntry,
    { ...provenanceEntry, id: 'bad-sender', data: { userEntryId: 'agent-user-entry', sender: { title: 'forged' } } },
  ]);

  assert.equal(transcript[0]?.customType, AGENT_MESSAGE_CUSTOM_TYPE);
  assert.equal(transcript[0]?.sender, undefined);
});

test('mapTranscript ignores malformed or unrelated agent provenance markers', () => {
  const transcript = mapTranscript([
    userEntry,
    { ...provenanceEntry, id: 'bad-marker', data: { userEntryId: '' } },
    { ...provenanceEntry, id: 'wrong-type', customType: 'pie.other' },
  ]);

  assert.equal(transcript[0]?.customType, undefined);
  assert.equal(transcript.length, 1);
});
