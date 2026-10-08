import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_COMMAND_INTERVAL_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  MIN_COMMAND_INTERVAL_MS,
  isValidTimerStartedAt,
  parseCommandPredicateResult,
  validateWakeConditions,
} from '../wake-conditions.js';

test('timer starts require valid ISO timestamps and accept explicit timezone offsets', () => {
  for (const value of ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00+01:00']) {
    assert.equal(isValidTimerStartedAt(value), true, value);
  }
  for (const value of [undefined, '', 'January 1 2026', '2026-02-30T00:00:00.000Z', '2026-01-01T25:00:00Z']) {
    assert.equal(isValidTimerStartedAt(value), false, String(value));
  }
});

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

test('wake validation rejects malformed durable specs instead of partially accepting a registration', () => {
  const invalid: Array<[unknown, RegExp]> = [
    [null, /non-empty array/],
    [[], /non-empty array/],
    [[null], /must be an object/],
    [[{ kind: 'session_finished', sessionPath: ' ' }], /sessionPath/],
    [[{ kind: 'timer', ms: 1.5 }], /timer.ms/],
    [[{ kind: 'command', command: ' ' }], /command.command/],
    [[{ kind: 'command', command: 'check', cwd: 42 }], /command.cwd/],
    [[{ kind: 'command', command: 'check', intervalMs: '1000' }], /intervalMs/],
    [[{ kind: 'command', command: 'check', timeoutMs: 0 }], /timeoutMs/],
  ];
  for (const [raw, expected] of invalid) {
    const result = validateWakeConditions(raw);
    assert.match(result.error ?? '', expected);
    assert.equal(result.specs, undefined);
  }
  const partial = validateWakeConditions([{ kind: 'user_input' }, { kind: 'timer', ms: 0 }]);
  assert.match(partial.error ?? '', /timer.ms/);
  assert.equal(partial.specs, undefined);
});

test('command predicate errors override exit one and retain trimmed diagnostics', () => {
  assert.deepEqual(parseCommandPredicateResult({ exitCode: 1, error: ' spawn failed ', stderr: ' unavailable ' }), {
    satisfied: false,
    error: 'command predicate failed (spawn failed; stderr: unavailable)',
  });
  assert.deepEqual(parseCommandPredicateResult({ error: new Error('spawn failed') }), {
    satisfied: false,
    error: 'command predicate did not exit normally (spawn failed)',
  });
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
