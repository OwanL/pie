import test from 'node:test';
import assert from 'node:assert/strict';

import { mapTranscript, type SessionEntryLike } from '../../../src/backend/transcript';

/** The wake-up text the `DeferredTriggerRegistry` injects on fire. */
function wakeUpText(reason: string, note = 'do the thing'): string {
  return (
    `[deferred trigger fired: ${reason}]\n\n` +
    'A deferred trigger you registered fired. Re-evaluate your pending task and either complete it now or call `defer_trigger` with action `register` again to keep waiting.\n\n' +
    `Task note:\n${note}`
  );
}

function userEntry(id: string, text: string): SessionEntryLike {
  return {
    id,
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'message',
    message: { role: 'user', content: text },
  };
}

test('mapTranscript re-derives the deferred-trigger tag from the wake-up text prefix on reload', () => {
  const entries: SessionEntryLike[] = [userEntry('u-1', wakeUpText('timer elapsed after 30000ms'))];
  const [msg] = mapTranscript(entries);
  assert.equal(msg.role, 'user');
  assert.equal(msg.customType, 'deferred-trigger');
  assert.deepEqual(msg.customDetails, { reason: 'timer elapsed after 30000ms' });
});

test('mapTranscript parses the reason up to the closing bracket', () => {
  const entries: SessionEntryLike[] = [
    userEntry('u-1', wakeUpText('session finished (any open session)')),
  ];
  const [msg] = mapTranscript(entries);
  assert.equal(msg.customType, 'deferred-trigger');
  assert.deepEqual(msg.customDetails, { reason: 'session finished (any open session)' });
});

test('mapTranscript leaves a plain typed user message untagged', () => {
  const entries: SessionEntryLike[] = [userEntry('u-1', 'hello, please help')];
  const [msg] = mapTranscript(entries);
  assert.equal(msg.customType, undefined);
  assert.equal(msg.customDetails, undefined);
});

test('mapTranscript does not mis-tag a message that merely mentions the prefix mid-text', () => {
  const entries: SessionEntryLike[] = [
    userEntry('u-1', 'I saw [deferred trigger fired: timer elapsed after 30000ms] in the logs'),
  ];
  const [msg] = mapTranscript(entries);
  // Only a message that STARTS with the prefix is tagged — an inline mention
  // is a real user message.
  assert.equal(msg.customType, undefined);
});
