import assert from 'node:assert/strict';
import test from 'node:test';

import {
  backendLog,
  backendDebug,
  backendInfo,
  backendWarn,
  backendError,
  backendTrace,
} from '../../../src/backend/log';

/** Capture `process.stderr.write` calls for the duration of `fn`. Each captured
 *  entry is the raw string passed to `write` (without the trailing newline
 *  split — tests split on `\n` themselves). */
function captureStderr(fn: () => void): string[] {
  const original = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  process.stderr.write = ((chunk: string) => {
    lines.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

/** Parse the JSON payload of a `[pie:backend] {json}` line. */
function parseBackendLine(line: string): Record<string, unknown> {
  assert.ok(line.startsWith('[pie:backend] '), `line should start with [pie:backend] prefix: ${line}`);
  const json = line.slice('[pie:backend] '.length).trim();
  return JSON.parse(json) as Record<string, unknown>;
}

test('backendLog writes a [pie:backend] JSON line with the structured level field', () => {
  const lines = captureStderr(() => {
    backendLog('warn', 'backend-timing', 'op.failed', { label: 'start.loadSdk', durationMs: 42 });
  });
  assert.equal(lines.length, 1, 'exactly one stderr line');
  const record = parseBackendLine(lines[0]);
  assert.equal(record.level, 'warn');
  assert.equal(record.scope, 'backend-timing');
  assert.equal(record.event, 'op.failed');
  assert.equal(record.label, 'start.loadSdk');
  assert.equal(record.durationMs, 42);
  assert.equal(typeof record.ts, 'string', 'ts is an ISO string');
  assert.equal(record.pid, process.pid);
  // `level` is a structural field (not duplicated as a data field) — verified
  // exhaustively in the backendTrace test below.
});

test('backendLog ends the line with a newline (line-oriented transport)', () => {
  const lines = captureStderr(() => {
    backendLog('info', 'backend', 'boot', { ok: true });
  });
  assert.ok(lines[0].endsWith('\n'), 'line must be newline-terminated');
});

test('level helpers emit the matching level', () => {
  const lines = captureStderr(() => {
    backendDebug('backend-x', 'e1');
    backendInfo('backend-x', 'e2');
    backendWarn('backend-x', 'e3');
    backendError('backend-x', 'e4');
  });
  assert.equal(lines.length, 4);
  const levels = lines.map((l) => parseBackendLine(l).level);
  assert.deepEqual(levels, ['debug', 'info', 'warn', 'error']);
});

test('backendLog tolerates undefined data (no data fields)', () => {
  const lines = captureStderr(() => {
    backendLog('debug', 'backend-request', 'received');
  });
  const record = parseBackendLine(lines[0]);
  assert.equal(record.level, 'debug');
  assert.equal(record.scope, 'backend-request');
  assert.equal(record.event, 'received');
  // Only the structural keys are present.
  assert.deepEqual(Object.keys(record).sort(), ['event', 'level', 'pid', 'scope', 'ts']);
});

test('backendTrace lifts level out of the payload and prefixes the scope with backend-', () => {
  const lines = captureStderr(() => {
    backendTrace('sessionMetadata', 'deriveName.readFailed', { level: 'warn', error: 'boom', filePath: '/x' });
  });
  const record = parseBackendLine(lines[0]);
  assert.equal(record.level, 'warn', 'level lifted from payload into structural field');
  assert.equal(record.scope, 'backend-sessionMetadata', 'scope is prefixed with backend-');
  assert.equal(record.event, 'deriveName.readFailed');
  assert.equal(record.error, 'boom');
  assert.equal(record.filePath, '/x');
  // level must NOT be duplicated as a data field (it is the structural field).
  assert.equal(
    Object.keys(record).filter((k) => k === 'level').length,
    1,
    'level appears exactly once',
  );
});

test('backendTrace defaults to debug when no level is carried in the payload', () => {
  const lines = captureStderr(() => {
    backendTrace('request', 'received', { id: 'req-1', method: 'message.send' });
  });
  const record = parseBackendLine(lines[0]);
  assert.equal(record.level, 'debug');
  assert.equal(record.scope, 'backend-request');
  assert.equal(record.id, 'req-1');
});

test('backendTrace defaults to debug when payload is omitted entirely', () => {
  const lines = captureStderr(() => {
    backendTrace('request', 'handled');
  });
  const record = parseBackendLine(lines[0]);
  assert.equal(record.level, 'debug');
  assert.deepEqual(Object.keys(record).sort(), ['event', 'level', 'pid', 'scope', 'ts']);
});

test('backendTrace ignores an unrecognized payload level and falls back to debug', () => {
  const lines = captureStderr(() => {
    backendTrace('systemPrompt', 'harnessRead.failed', { level: 'trace' as unknown as string });
  });
  const record = parseBackendLine(lines[0]);
  assert.equal(record.level, 'debug', 'unknown level names fall back to debug');
});