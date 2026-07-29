import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyBackendStderrLine } from '../../../src/host/backend/stderr-classifier';

/** Build a structured `[pie:backend] {json}` line (the backend logger shape). */
function structuredLine(record: Record<string, unknown>): string {
  return `[pie:backend] ${JSON.stringify(record)}`;
}

test('reads level from the structured `level` field (warn)', () => {
  const line = structuredLine({
    ts: '2026-01-01T00:00:00.000Z',
    pid: 123,
    level: 'warn',
    scope: 'backend-timing',
    event: 'op.failed',
    label: 'x',
  });
  assert.equal(classifyBackendStderrLine(line), 'warn');
});

test('reads level for each structured level', () => {
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    const line = structuredLine({ level, scope: 'backend', event: 'e' });
    assert.equal(classifyBackendStderrLine(line), level);
  }
});

test('strips the [pie:backend] prefix before parsing', () => {
  // Same payload, with and without the prefix, both resolve to the structured level.
  const withPrefix = structuredLine({ level: 'error', scope: 'backend', event: 'boom' });
  const withoutPrefix = JSON.stringify({ level: 'error', scope: 'backend', event: 'boom' });
  assert.equal(classifyBackendStderrLine(withPrefix), 'error');
  assert.equal(classifyBackendStderrLine(withoutPrefix), 'error');
});

test('falls back to legacy classifier when JSON has no `level` field', () => {
  // A structured-looking line without level must not crash; it falls back.
  const line = structuredLine({ scope: 'backend-request', event: 'received', id: 'req-1' });
  // 'backend-request' substring → debug (legacy allowlist).
  assert.equal(classifyBackendStderrLine(line), 'debug');
});

test('falls back to legacy classifier when level is not a recognized value', () => {
  const line = structuredLine({ level: 'trace', scope: 'backend', event: 'e' });
  // 'trace' is not a backend log level → legacy fallback. The line text has no
  // error/failed keyword and is not in the allowlist → info.
  assert.equal(classifyBackendStderrLine(line), 'info');
});

test('legacy fallback: error keyword → warn', () => {
  assert.equal(
    classifyBackendStderrLine('[pie:backend] something went wrong: error boom'),
    'warn',
  );
  assert.equal(classifyBackendStderrLine('uncaught exception in worker'), 'warn');
  assert.equal(classifyBackendStderrLine('provider failed to respond'), 'warn');
});

test('legacy fallback: chatty poll/RPC/timing substrings → debug', () => {
  assert.equal(classifyBackendStderrLine('[pie:backend] provider_gate.metrics {...}'), 'debug');
  assert.equal(classifyBackendStderrLine('[pie:backend] backend-request received'), 'debug');
  assert.equal(classifyBackendStderrLine('[pie:backend] backend-timing op.completed'), 'debug');
  assert.equal(classifyBackendStderrLine('tool_execution_start {...}'), 'debug');
  assert.equal(classifyBackendStderrLine('tool_execution_end {...}'), 'debug');
});

test('legacy fallback: unknown line → info', () => {
  assert.equal(classifyBackendStderrLine('[pie:backend] some random diagnostic'), 'info');
});

test('non-JSON line is handled by the legacy classifier (never throws, never dropped)', () => {
  // Completely non-JSON, no keywords → info (not dropped, not an exception).
  assert.equal(classifyBackendStderrLine('provider gate not installed: ENOENT'), 'info');
  // Non-JSON with error keyword → warn.
  assert.equal(classifyBackendStderrLine('the backend crashed: error'), 'warn');
});

test('trims surrounding whitespace before classifying', () => {
  const line = `   \n${structuredLine({ level: 'warn', scope: 'backend', event: 'e' })}  \n`;
  assert.equal(classifyBackendStderrLine(line), 'warn');
});

test('empty line returns info (safe default; callers normally short-circuit)', () => {
  assert.equal(classifyBackendStderrLine(''), 'info');
  assert.equal(classifyBackendStderrLine('   '), 'info');
});

test('structured line carrying an `error` data field is classified by its level, not the error keyword', () => {
  // This is the core brittleness the structured contract fixes: a debug-level
  // trace that includes an `error` field was mis-classified as `warn` by the
  // legacy substring regex (which matched the `error` key). The structured
  // `level` field now wins.
  const line = structuredLine({
    level: 'debug',
    scope: 'backend-systemPrompt',
    event: 'harnessRead.failed',
    error: 'module not found',
  });
  assert.equal(classifyBackendStderrLine(line), 'debug');
});