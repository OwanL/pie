import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyWorkerStderrChunk } from '../../src/backend/log';

/** Build a structured `[pie:backend] {json}` line (the backend logger shape). */
function structuredLine(record: Record<string, unknown>): string {
  return `[pie:backend] ${JSON.stringify(record)}`;
}

test('classifies a structured debug worker stderr line as debug', () => {
  const chunk = structuredLine({
    ts: '2026-08-19T00:00:00.000Z',
    pid: 123,
    level: 'debug',
    scope: 'backend-session',
    event: 'tool_execution_start',
    toolName: 'bash',
  });
  assert.equal(classifyWorkerStderrChunk(chunk), 'debug');
});

test('classifies a structured warn worker stderr line as warn', () => {
  const chunk = structuredLine({
    ts: '2026-08-19T00:00:00.000Z',
    pid: 123,
    level: 'warn',
    scope: 'backend-session',
    event: 'tool.terminalTransportBounded',
    toolName: 'subagent',
  });
  assert.equal(classifyWorkerStderrChunk(chunk), 'warn');
});

test('classifies a structured error worker stderr line as error', () => {
  const chunk = structuredLine({
    ts: '2026-08-19T00:00:00.000Z',
    pid: 123,
    level: 'error',
    scope: 'backend-worker',
    event: 'runtime frame failed',
  });
  assert.equal(classifyWorkerStderrChunk(chunk), 'error');
});

test('classifies a non-JSON worker crash stack as error', () => {
  const chunk = '[pie-worker] Error: boom\n    at main (worker-entry.ts:105:5)';
  assert.equal(classifyWorkerStderrChunk(chunk), 'error');
});

test('classifies routine warm-bash rewrite telemetry as debug', () => {
  const legacy = JSON.stringify({
    source: 'pie:warm-bash:auto-prune',
    event: 'rewrite',
    before: 'grep -rn needle .',
    after: 'grep --exclude-dir=node_modules -rn needle .',
  });
  assert.equal(classifyWorkerStderrChunk(legacy), 'debug');
  assert.equal(classifyWorkerStderrChunk(JSON.stringify({ ...JSON.parse(legacy), level: 'debug' })), 'debug');
});

test('a multi-line chunk uses the most severe level', () => {
  const chunk = [
    structuredLine({ level: 'debug', scope: 'backend-session', event: 'tool_execution_start' }),
    structuredLine({ level: 'warn', scope: 'backend-session', event: 'tool.failed' }),
  ].join('\n');
  assert.equal(classifyWorkerStderrChunk(chunk), 'warn');
});

test('an empty chunk defaults to info', () => {
  assert.equal(classifyWorkerStderrChunk(''), 'info');
  assert.equal(classifyWorkerStderrChunk('\n  \n'), 'info');
});
