import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { attachJsonlLineReader, JSONL_MAX_LINE_BYTES } from '../src/shared/jsonl';
import { boundToolProgress } from '../src/backend/session-event-handler';
import { OrderedJsonlWriter } from '../src/backend/server-io';
import { extractPreviewRequestId } from '../src/backend/server';

function collect(maxLineBytes: number) {
  const stream = new PassThrough();
  const lines: string[] = [];
  const overflows: string[] = [];
  attachJsonlLineReader(stream, (line) => lines.push(line), {
    maxLineBytes,
    onOverflow: ({ preview }) => overflows.push(preview),
  });
  return { stream, lines, overflows };
}

test('JSONL reader accepts an exact byte-limit line', () => {
  const x = collect(4);
  x.stream.end(Buffer.from('1234\n'));
  assert.deepEqual(x.lines, ['1234']);
  assert.deepEqual(x.overflows, []);
});

test('JSONL reader discards a split overlong line and recovers after LF', () => {
  const x = collect(4);
  x.stream.write(Buffer.from('123'));
  x.stream.write(Buffer.from('45'));
  x.stream.end(Buffer.from('6\nok\n'));
  assert.deepEqual(x.lines, ['ok']);
  assert.equal(x.overflows.length, 1);
});

test('JSONL reader measures multibyte UTF-8 bytes and recovers', () => {
  const x = collect(4);
  x.stream.end(Buffer.from('ééé\ny\n', 'utf8'));
  assert.deepEqual(x.lines, ['y']);
  assert.equal(x.overflows.length, 1);
});

test('JSONL reader bounds a single enormous no-LF chunk and recovers within that chunk', () => {
  const x = collect(32);
  x.stream.end(Buffer.concat([Buffer.alloc(1024 * 1024, 0x61), Buffer.from('\nok\n')]));
  assert.deepEqual(x.lines, ['ok']);
  assert.deepEqual(x.overflows, ['a'.repeat(32)]);
});

test('JSONL reader handles many tiny chunks without fragment accumulation', () => {
  const x = collect(128 * 1024);
  for (let i = 0; i < 100_000; i += 1) x.stream.write(Buffer.from('a'));
  x.stream.end(Buffer.from('\n'));
  assert.equal(x.lines[0]?.length, 100_000);
});

test('shared JSONL limit has headroom for base64-encoded 20 MiB aggregate images', () => {
  const encodedImageBytes = Math.ceil((20 * 1024 * 1024) / 3) * 4;
  assert.ok(JSONL_MAX_LINE_BYTES > encodedImageBytes + 1024 * 1024);
});

test('oversized request preview extracts a correlation id when it appears early', () => {
  assert.equal(extractPreviewRequestId('{"id":"req-42","method":"message.send","params":'), 'req-42');
  assert.equal(extractPreviewRequestId('{"method":"message.send"'), undefined);
});

test('tool progress leaves small values unchanged and marks large/cyclic values', () => {
  const small = { value: 'ok' };
  assert.equal(boundToolProgress(small, 100), small);
  assert.deepEqual(boundToolProgress('x'.repeat(200), 100), {
    $toolProgress: 'truncated',
    originalBytes: 202,
    preview: '',
  });
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.deepEqual(boundToolProgress(cyclic, 100), { $toolProgress: 'unserializable' });
});

test('ordered stdout writer waits for callbacks and preserves order', async () => {
  const written: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      setTimeout(() => { written.push(chunk.toString()); callback(); }, 5);
    },
  });
  const writer = new OrderedJsonlWriter(stream);
  writer.write({ n: 1 });
  writer.write({ n: 2 });
  writer.write({ n: 3 });
  for (let i = 0; written.length < 3 && i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(written, ['{"n":1}\n', '{"n":2}\n', '{"n":3}\n']);
});

test('ordered stdout writer coalesces stale blocked tool progress without reordering critical events', async () => {
  const written: string[] = [];
  const callbacks: Array<() => void> = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      written.push(chunk.toString());
      callbacks.push(callback);
    },
  });
  const writer = new OrderedJsonlWriter(stream, { maxQueuedBytes: 4096 });
  const progress = (partialResult: string) => ({
    event: 'tool.progress',
    payload: { sessionPath: '/s', toolCallId: 't', partialResult },
  });

  writer.write({ id: 'active', ok: true });
  writer.write(progress('stale'));
  writer.write({ id: 'intervening', ok: true });
  writer.write(progress('latest'));
  writer.write({ event: 'tool.finished', payload: { sessionPath: '/s', toolCallId: 't', status: 'completed' } });
  writer.write(progress('too-late'));

  while (callbacks.length > 0) callbacks.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(written.map((line) => JSON.parse(line)), [
    { id: 'active', ok: true },
    progress('latest'),
    { id: 'intervening', ok: true },
    { event: 'tool.finished', payload: { sessionPath: '/s', toolCallId: 't', status: 'completed' } },
  ]);
});

test('ordered stdout writer fails before writing an oversized critical record', () => {
  const fatal: Error[] = [];
  const stream = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const writer = new OrderedJsonlWriter(stream, { onFatal: (error) => fatal.push(error) });
  assert.throws(
    () => writer.write({ id: 'too-large', result: 'x'.repeat(JSONL_MAX_LINE_BYTES) }),
    /record overflow/,
  );
  assert.equal(fatal.length, 1);
});

test('ordered stdout writer drops progress at saturation but fails explicitly on critical overflow', () => {
  const callbacks: Array<() => void> = [];
  const fatal: Error[] = [];
  const stream = new Writable({ write(_chunk, _encoding, callback) { callbacks.push(callback); } });
  const writer = new OrderedJsonlWriter(stream, { maxQueuedBytes: 80, onFatal: (error) => fatal.push(error) });
  writer.write({ id: 'active', ok: true });
  writer.write({ event: 'tool.progress', payload: { sessionPath: '/s', toolCallId: 't', partialResult: 'x'.repeat(200) } });
  assert.equal(fatal.length, 0, 'droppable progress does not make saturation fatal');
  assert.throws(() => writer.write({ id: 'critical', ok: false, error: { code: 'E', message: 'x'.repeat(200) } }), /queue overflow/);
  assert.equal(fatal.length, 1);
  callbacks.shift()?.();
});
