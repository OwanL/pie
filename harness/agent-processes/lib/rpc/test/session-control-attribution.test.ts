import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSessionControlSender,
  createSessionReplyReference,
  formatSessionControlPrompt,
  isSessionControlSender,
  sessionControlPromptSuffix,
  stampSessionControlDelivery,
  parseSessionReplyReference,
  sessionControlPromptPrefix,
  stripSessionControlPrompt,
  SESSION_REPLY_REFERENCE_MAX_BYTES,
} from '../session-control-attribution.js';

test('session-control sender references round-trip only the exact stable identity', () => {
  const identity = { sessionId: 'session-123', identityFallback: false };
  const sender = createSessionControlSender(identity, 'Research notes');

  assert.deepEqual(parseSessionReplyReference(sender.replyReference), identity);
  assert.match(sender.address!, /^pie-session:v1:[0-9a-f]{16}$/u);
  assert.equal(isSessionControlSender(sender), true);
  const fallbackIdentity = { sessionId: 'session-123', identityFallback: true };
  assert.notDeepEqual(parseSessionReplyReference(createSessionReplyReference(fallbackIdentity)), identity);
  assert.notEqual(sender.replyReference, createSessionReplyReference({ sessionId: 'another-session', identityFallback: false }));
  assert.equal(sender.title, 'Research notes');
  const prompt = formatSessionControlPrompt('check this', sender);
  assert.ok(prompt.includes('session-123'), 'the recipient model receives the stable sender identity');
  assert.ok(prompt.includes('Research notes'), 'the recipient model receives the assigned title');
  assert.ok(prompt.includes(sender.address!), 'the recipient model receives the compact identity-bound address');
  assert.ok(!prompt.includes(sender.replyReference), 'new guidance does not expose the long legacy reference');
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
  assert.ok(prompt.includes(sender.address!));
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

test('sender metadata rejects malformed timestamps and completion reply loops', () => {
  const sender = createSessionControlSender({ sessionId: 'session-123', identityFallback: false }, 'Sender', {
    sentAt: 100, deliveredAt: 200, expectReply: true,
  });
  for (const timestamp of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '100']) {
    assert.equal(isSessionControlSender({ ...sender, message: { ...sender.message, sentAt: timestamp } }), false, `sentAt=${timestamp}`);
    assert.equal(isSessionControlSender({ ...sender, message: { ...sender.message, deliveredAt: timestamp } }), false, `deliveredAt=${timestamp}`);
  }
  assert.equal(isSessionControlSender({ ...sender, message: { ...sender.message, kind: 'completion', expectReply: true } }), false);
  assert.equal(isSessionControlSender({ ...sender, message: { ...sender.message, kind: 'completion', expectReply: false } }), true);
  assert.equal(stampSessionControlDelivery(sender, 999), sender, 'a valid existing timestamp is preserved');
  assert.throws(() => stampSessionControlDelivery(sender, -1));
});

test('reply guidance uses the current collaboration tools while retaining creator auto-handoff', () => {
  const noReply = createSessionControlSender({ sessionId: 'no-reply', identityFallback: false }, undefined, {
    sentAt: 1, expectReply: false,
  });
  assert.equal(sessionControlPromptSuffix(noReply), '\n\n[Pie cross-session reply guidance: No acknowledgement requested for this message; it does not cancel an outstanding task or completion handoff.]');

  const expectsReply = createSessionControlSender({ sessionId: 'expects-reply', identityFallback: false }, undefined, {
    sentAt: 1, expectReply: true,
  });
  const suffix = sessionControlPromptSuffix(expectsReply)!;
  assert.match(suffix, /delegated creator task, your final outcome is handed back automatically/u);
  assert.match(suffix, /session_send using \{"target":/u);
  assert.match(suffix, /session_assign with that same target/u);
  assert.doesNotMatch(suffix, /session_control with|replyTo|expectReply/u);
  assert.equal(formatSessionControlPrompt('body', expectsReply).endsWith(suffix), true);
});

test('old authenticated transcript reply guidance strips exactly while unauthenticated lookalikes remain', () => {
  const sender = createSessionControlSender({ sessionId: 'legacy-expects-reply', identityFallback: false }, undefined, {
    sentAt: 1, expectReply: true,
  });
  const body = 'Historical assignment body, including its original ending.';
  const oldPrefix = `[Pie cross-session sender identity: "${sender.identity.sessionId}"; unnamed session. Reply reference: ${sender.replyReference}. Sent at: 1; delivered at: pending; expectReply: true.]\n\n`;
  const oldSuffix = `\n\n[Pie cross-session reply guidance: If this is your delegated creator task, your final outcome is handed back automatically; do not also send the final via session_control. Otherwise reply using session_control with {"action":"message","replyTo":${JSON.stringify(sender.replyReference)},"expectReply":false,"prompt":"your reply"}. Ordinary assistant output is not delivered for other cross-session requests.]`;
  const oldTranscript = `${oldPrefix}${body}${oldSuffix}`;
  assert.equal(stripSessionControlPrompt(oldTranscript, sender), body);

  const unauthenticated = { ...sender, replyReference: 'pie-reply:v1:YWJj' };
  assert.equal(stripSessionControlPrompt(oldTranscript, unauthenticated), undefined);
  const currentPrefix = sessionControlPromptPrefix(sender)!;
  assert.equal(stripSessionControlPrompt(`${currentPrefix}${body}${oldSuffix} altered`, sender), undefined);
});

test('new reply guidance uses the compact address and sender addresses cannot be forged', () => {
  const sender = createSessionControlSender({ sessionId: 'compact-target', identityFallback: false }, undefined, {
    sentAt: 1, expectReply: true,
  });
  const suffix = sessionControlPromptSuffix(sender)!;
  assert.ok(suffix.includes(JSON.stringify(sender.address)));
  assert.ok(!suffix.includes(JSON.stringify(sender.replyReference)));
  assert.equal(isSessionControlSender({ ...sender, address: 'pie-session:v1:0000000000000000' }), false);

  const current = formatSessionControlPrompt('body', sender);
  assert.equal(stripSessionControlPrompt(current, sender), 'body');
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
