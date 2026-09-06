import assert from 'node:assert/strict';
import test from 'node:test';

import { BackendServer } from '../../../src/backend/server';
import { BackendError } from '../../../src/backend/server-io';

function captureJsonlWrites(stream: NodeJS.WriteStream): {
  readonly chunks: string[];
  restore(): void;
} {
  const originalWrite = stream.write;
  const chunks: string[] = [];
  stream.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (typeof done === 'function') done(null);
    return true;
  }) as typeof stream.write;
  return {
    chunks,
    restore: () => { stream.write = originalWrite; },
  };
}

function parseBackendRecords(chunks: readonly string[]): Array<Record<string, unknown>> {
  return chunks
    .join('')
    .split('\n')
    .filter((line) => line.startsWith('[pie:backend] '))
    .map((line) => JSON.parse(line.slice('[pie:backend] '.length)) as Record<string, unknown>);
}

test('expected pre-ack session cancellation is debug telemetry while the typed RPC rejection is preserved', async () => {
  const server = new BackendServer({ workerEntryPath: '/worker-entry.js', sdkPath: '/sdk', cwd: '/workspace' }) as any;
  server.handleRequest = async () => {
    throw new BackendError(
      'SESSION_OPERATION_CANCELLED',
      'The pending session operation was interrupted before runtime promotion completed.',
    );
  };
  const stderr = captureJsonlWrites(process.stderr);
  const stdout = captureJsonlWrites(process.stdout);

  try {
    await server.handleLine(JSON.stringify({
      id: 'cancelled-send',
      method: 'message.send',
      params: { sessionPath: '/session.jsonl', text: 'cancel me' },
    }));
  } finally {
    stderr.restore();
    stdout.restore();
    await server.dispose();
  }

  const records = parseBackendRecords(stderr.chunks);
  assert.equal(
    records.some((record) => record.level === 'warn' || record.level === 'error'),
    false,
    'expected cancellation produces no warning/error backend diagnostics',
  );
  const timing = records.find((record) => record.scope === 'backend-timing');
  const request = records.find((record) => (
    record.scope === 'backend-request'
    && record.id === 'cancelled-send'
    && record.event === 'cancelled'
  ));
  assert.deepEqual(
    { level: timing?.level, event: timing?.event },
    { level: 'debug', event: 'op.cancelled' },
  );
  assert.deepEqual(
    { level: request?.level, event: request?.event, code: request?.code },
    { level: 'debug', event: 'cancelled', code: 'SESSION_OPERATION_CANCELLED' },
  );

  const response = JSON.parse(stdout.chunks.join('').trim()) as {
    ok: boolean;
    error?: { code?: string };
  };
  assert.equal(response.ok, false);
  assert.equal(response.error?.code, 'SESSION_OPERATION_CANCELLED');
});
