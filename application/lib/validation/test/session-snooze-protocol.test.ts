import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWebviewToHostMessage } from '../protocol-validation.js';
import { validateBrowserToHostMessage } from '../browser-ingress.js';

const envelope = { sessionPath: '/sessions/work.jsonl', viewGeneration: 1,
  clientCommandId: '123e4567-e89b-42d3-a456-426614174000' };
const browser = (value: unknown) => validateBrowserToHostMessage(value, Buffer.byteLength(JSON.stringify(value)));

test('both renderer boundaries accept snooze presets and early restoration', () => {
  for (const durationHours of [4, 8, 12, 24, 48, 'monday']) {
    const message = { ...envelope, type: 'snoozeSession', durationHours };
    assert.equal(validateWebviewToHostMessage(message).ok, true);
    assert.equal(browser(message).ok, true);
  }
  const restore = { ...envelope, type: 'restoreSnoozedSession' };
  assert.equal(validateWebviewToHostMessage(restore).ok, true);
  assert.equal(browser(restore).ok, true);
});

test('snooze rejects arbitrary durations and missing or invalid targets', () => {
  for (const durationHours of [0, -4, 1, 72, 4.5, '4', null, {}, undefined]) {
    assert.equal(validateWebviewToHostMessage({ ...envelope, type: 'snoozeSession', durationHours }).ok, false);
  }
  for (const sessionPath of ['', null, 4, undefined]) {
    assert.equal(validateWebviewToHostMessage({ type: 'snoozeSession', sessionPath, durationHours: 4 }).ok, false);
    assert.equal(validateWebviewToHostMessage({ type: 'restoreSnoozedSession', sessionPath }).ok, false);
  }
});

test('browser snooze commands preserve bounded exact schemas and command identity', () => {
  const message = { ...envelope, type: 'snoozeSession', durationHours: 4 };
  assert.equal(browser({ ...message, wakeAt: Date.now() }).ok, false);
  assert.equal(browser({ ...message, sessionPath: 'x'.repeat(4097) }).ok, false);
  const { clientCommandId: _id, ...noIdentity } = message;
  assert.equal(browser(noIdentity).ok, false);
  assert.equal(browser({ ...envelope, type: 'restoreSnoozedSession', durationHours: 4 }).ok, false);
});
