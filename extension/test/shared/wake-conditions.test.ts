import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_COMMAND_INTERVAL_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  MIN_COMMAND_INTERVAL_MS,
  parseCommandPredicateResult,
  validateWakeConditions,
} from '../../../shared/wake-conditions.js';

test('command wake conditions apply defaults and resolve cwd at registration', () => {
  const registrationCwd = path.join(process.cwd(), 'project');
  const result = validateWakeConditions([
    { kind: 'timer', ms: 1_000 },
    { kind: 'command', command: 'check-status', cwd: 'scripts' },
  ], { registrationCwd });

  assert.deepEqual(result.specs, [
    { kind: 'timer', ms: 1_000 },
    {
      kind: 'command',
      command: 'check-status',
      cwd: path.resolve(registrationCwd, 'scripts'),
      intervalMs: DEFAULT_COMMAND_INTERVAL_MS,
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    },
  ]);
});

test('command wake condition bounds reject short intervals and oversized timeouts', () => {
  assert.match(
    validateWakeConditions([{ kind: 'command', command: 'check', intervalMs: MIN_COMMAND_INTERVAL_MS - 1 }]).error ?? '',
    /intervalMs/,
  );
  assert.match(
    validateWakeConditions([{ kind: 'command', command: 'check', timeoutMs: MAX_COMMAND_TIMEOUT_MS + 1 }]).error ?? '',
    /timeoutMs/,
  );
});

test('command predicate parser uses exit status rather than stdout', () => {
  assert.deepEqual(parseCommandPredicateResult({ exitCode: 0, stdout: 'not a boolean' }), { satisfied: true });
  assert.deepEqual(parseCommandPredicateResult({ exitCode: 0 }), { satisfied: true });
  assert.deepEqual(parseCommandPredicateResult({ exitCode: 1, stdout: 'true', stderr: 'not yet' }), { satisfied: false });
});

test('command predicate parser treats other exits, signals, timeouts, and spawn failures as errors', () => {
  for (const result of [
    { exitCode: 2, stdout: 'ignored' },
    { exitCode: null, error: 'command predicate terminated by SIGTERM' },
    { exitCode: 0, stdout: 'ignored', timedOut: true },
    { exitCode: null, error: new Error('spawn failed') },
    { exitCode: 0, error: new Error('spawn failed') },
  ]) {
    const parsed = parseCommandPredicateResult(result);
    assert.equal(parsed.satisfied, false);
    assert.ok(parsed.error);
  }
  assert.match(
    parseCommandPredicateResult({ exitCode: null, error: new Error('spawn failed') }).error ?? '',
    /did not exit normally/,
  );
});
