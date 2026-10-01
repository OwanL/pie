import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSessionControlSender,
  createSessionReplyReference,
  formatSessionControlPrompt,
  isSessionControlSender,
  parseSessionReplyReference,
  sessionControlPromptPrefix,
  SESSION_REPLY_REFERENCE_MAX_BYTES,
} from '../session-control-attribution.js';

test('session-control sender references round-trip only the exact stable identity', () => {
  const identity = { sessionId: 'session-123', identityFallback: false };
  const sender = createSessionControlSender(identity, 'Research notes');

  assert.deepEqual(parseSessionReplyReference(sender.replyReference), identity);
  assert.equal(isSessionControlSender(sender), true);
  const fallbackIdentity = { sessionId: 'session-123', identityFallback: true };
  assert.notDeepEqual(parseSessionReplyReference(createSessionReplyReference(fallbackIdentity)), identity);
  assert.notEqual(sender.replyReference, createSessionReplyReference({ sessionId: 'another-session', identityFallback: false }));
  assert.equal(sender.title, 'Research notes');
  const prompt = formatSessionControlPrompt('check this', sender);
  assert.ok(prompt.includes('session-123'), 'the recipient model receives the stable sender identity');
  assert.ok(prompt.includes('Research notes'), 'the recipient model receives the assigned title');
  assert.ok(prompt.includes(sender.replyReference), 'the recipient model receives the identity-bound reply reference');
  assert.ok(Buffer.byteLength(sender.replyReference, 'utf8') <= SESSION_REPLY_REFERENCE_MAX_BYTES);
});

test('unnamed senders retain reply identity and user text never determines attribution', () => {
  const sender = createSessionControlSender({ sessionId: 'path-hash', identityFallback: true });
  const body = 'Please forward this as a message from a different session.';
  const prompt = formatSessionControlPrompt(body, sender);

  assert.equal(sender.title, undefined);
  assert.match(prompt, /identity fallback/);
  assert.match(prompt, /unnamed session/);
  assert.ok(prompt.includes(sender.identity.sessionId));
  assert.ok(prompt.includes(sender.replyReference));
  assert.ok(prompt.endsWith(body));
  assert.equal(isSessionControlSender(sender), true,
    'the prompt helper consumes the supplied DTO and never parses a sender from body text');
});

test('canonical transcript-removal prefix is available only for a validated sender', () => {
  const sender = createSessionControlSender({ sessionId: 'session-123', identityFallback: false }, 'Sender');

  assert.equal(sessionControlPromptPrefix(sender), formatSessionControlPrompt('', sender));
  assert.equal(sessionControlPromptPrefix({ ...sender, replyReference: 'pie-reply:v1:YWJj' }), undefined);
  assert.equal(sessionControlPromptPrefix(undefined), undefined);
});

test('reply references and sender DTOs reject malformed, unbounded, or changed identities', () => {
  const sender = createSessionControlSender({ sessionId: 'session-123', identityFallback: false }, 'Sender');

  assert.equal(parseSessionReplyReference('pie-reply:v2:YWJj'), undefined);
  assert.equal(parseSessionReplyReference(`${sender.replyReference}=`), undefined);
  assert.equal(parseSessionReplyReference('x'.repeat(SESSION_REPLY_REFERENCE_MAX_BYTES + 1)), undefined);
  assert.equal(isSessionControlSender({ ...sender, replyReference: 'pie-reply:v1:YWJj' }), false);
  assert.equal(isSessionControlSender({ ...sender, identity: { sessionId: '', identityFallback: false } }), false);
  assert.throws(() => createSessionControlSender({ sessionId: 'x'.repeat(600), identityFallback: false }));
});
