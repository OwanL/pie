import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  AUTONOMOUS_MODE_ENV, AUTONOMOUS_MODE_BY_SESSION_ENV,
  isAutonomousModeEnabled, resolveAutonomousModeForSession, readAutonomousModeBySession,
} = require('../settings/autonomous-mode.ts') as typeof import('../settings/autonomous-mode.js');

test('autonomous process mode accepts only the explicit enabled flag', () => {
  for (const value of [undefined, '', '0', 'true', 'false', ' 1']) {
    assert.equal(isAutonomousModeEnabled({ [AUTONOMOUS_MODE_ENV]: value }), false);
  }
  assert.equal(isAutonomousModeEnabled({ [AUTONOMOUS_MODE_ENV]: '1' }), true);
});

test('session autonomous overrides take precedence only for boolean values at the exact root', () => {
  const root = '/sessions/root.jsonl';
  assert.equal(resolveAutonomousModeForSession(root, true, { [root]: false }), false);
  assert.equal(resolveAutonomousModeForSession(root, false, { [root]: true }), true);
  for (const overrides of [undefined, null, [], 'true', { [root]: 'false' }, { '/sessions/other.jsonl': false }]) {
    assert.equal(resolveAutonomousModeForSession(root, true, overrides), true);
    assert.equal(resolveAutonomousModeForSession(root, false, overrides), false);
  }
  for (const globalDefault of [undefined, null, 'true', 1]) {
    assert.equal(resolveAutonomousModeForSession(root, globalDefault, undefined), false);
  }
});

test('environment mirror discards malformed snapshots and filters invalid session entries', () => {
  for (const raw of [undefined, '', '{broken', 'null', '[]', 'true', '1', '"enabled"']) {
    assert.deepEqual(readAutonomousModeBySession({ [AUTONOMOUS_MODE_BY_SESSION_ENV]: raw }), {});
  }
  const overrides = readAutonomousModeBySession({ [AUTONOMOUS_MODE_BY_SESSION_ENV]: JSON.stringify({
    '/sessions/enabled.jsonl': true,
    '/sessions/disabled.jsonl': false,
    '': true,
    '/sessions/invalid.jsonl': 'true',
    '/sessions/missing.jsonl': null,
  }) });
  assert.deepEqual(overrides, {
    '/sessions/enabled.jsonl': true,
    '/sessions/disabled.jsonl': false,
  });
  assert.equal(resolveAutonomousModeForSession('/sessions/disabled.jsonl', true, overrides), false);
  assert.equal(resolveAutonomousModeForSession('/sessions/invalid.jsonl', true, overrides), true);
});
