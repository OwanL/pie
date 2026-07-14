import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { attachJsonlLineReader, JSONL_MAX_LINE_BYTES } from '../../../src/shared/jsonl';
import { boundToolProgress } from '../../../src/backend/session-event-handler';
import { OrderedJsonlWriter } from '../../../src/backend/server-io';
import { extractPreviewRequestId } from '../../../src/backend/server';

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

test('tool progress leaves small values unchanged and safely serializes cyclic/BigInt values', () => {
  const small = { value: 'ok' };
  assert.equal(boundToolProgress(small, 100), small);
  assert.deepEqual(boundToolProgress('x'.repeat(200), 100), {
    $toolProgress: 'truncated',
    originalBytes: 202,
    preview: '',
  });
  const cyclic: { count: bigint; self?: unknown } = { count: 42n };
  cyclic.self = cyclic;
  assert.deepEqual(boundToolProgress(cyclic, 100), { count: '42n', self: '[Circular]' });
});

test('cyclic subagent progress preserves renderable lifecycle state', () => {
  const progress: any = {
    content: [{ type: 'text', text: 'working' }],
    details: {
      mode: 'single',
      results: [{
        agent: 'scout',
        task: 'inspect',
        exitCode: -1,
        messages: [],
        activityPhase: 'running_tool',
        progressGeneration: 3n,
      }],
    },
  };
  progress.details.results[0].cycle = progress;

  const bounded = boundToolProgress(progress, 10_000) as any;
  assert.equal(bounded.details.results[0].activityPhase, 'running_tool');
  assert.equal(bounded.details.results[0].progressGeneration, '3n');
  assert.equal(bounded.details.results[0].cycle, '[Circular]');
});

test('oversized subagent progress preserves a renderable activity skeleton', () => {
  const progress = {
    content: [{ type: 'text', text: 'x'.repeat(500) }],
    details: {
      mode: 'single',
      results: [{
        agent: 'worker',
        task: 'work',
        exitCode: -1,
        messages: [{ role: 'assistant', content: 'x'.repeat(500) }],
        streamingText: 'still working',
        streaming: true,
        activityPhase: 'streaming',
        diagnostic: 'oversized non-transcript field'.repeat(500),
      }],
    },
  };

  const bounded = boundToolProgress(progress, 1_000) as any;
  assert.equal(bounded.$toolProgress, 'truncated');
  assert.equal(bounded.details.mode, 'single');
  assert.equal(bounded.details.results[0].activityPhase, 'streaming');
  assert.equal(bounded.details.results[0].streamingText, 'still working');
  assert.match(bounded.details.results[0].messages[0].content[0].text, /transcript omitted/i);
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

test('ordered stdout writer prioritizes responses while preserving event order and coalescing progress', async () => {
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
    { id: 'intervening', ok: true },
    { event: 'tool.finished', payload: { sessionPath: '/s', toolCallId: 't', status: 'completed' } },
  ]);
});

test('ordered stdout writer never coalesces or supersedes sequenced semantic progress', async () => {
  const written: string[] = [];
  const callbacks: Array<() => void> = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      written.push(chunk.toString());
      callbacks.push(callback);
    },
  });
  const writer = new OrderedJsonlWriter(stream, { maxQueuedBytes: 64 * 1024 });
  const semantic = (kind: 'tool.progress' | 'tool.terminal', seq: number) => ({
    event: 'live.semantic',
    payload: {
      kind, seq, sessionPath: '/s', turnId: 'turn', attemptId: 'attempt',
      executionId: 'execution', ...(kind === 'tool.progress'
        ? { preview: { kind: 'generic', summary: String(seq) } }
        : { status: 'completed', result: 'done', durableEntryId: 'entry' }),
    },
  });

  writer.write({ id: 'active', ok: true });
  writer.write(semantic('tool.progress', 2));
  writer.write(semantic('tool.progress', 3));
  writer.write(semantic('tool.terminal', 4));
  writer.write(semantic('tool.progress', 5));
  while (callbacks.length > 0) callbacks.shift()!();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(written.map((line) => JSON.parse(line)).slice(1).map((entry) => entry.payload.seq), [2, 3, 4, 5]);
});

test('ordered stdout writer bounds remembered terminal tool keys', () => {
  const callbacks: Array<() => void> = [];
  const stream = new Writable({ write(_chunk, _encoding, callback) { callbacks.push(callback); } });
  const writer = new OrderedJsonlWriter(stream, { maxQueuedBytes: 16 * 1024 * 1024 });
  writer.write({ id: 'active', ok: true });
  for (let index = 0; index < 2_100; index += 1) {
    writer.write({
      event: 'live.semantic',
      payload: {
        kind: 'tool.terminal', sessionPath: '/s', turnId: `turn-${index}`,
        attemptId: 'attempt', executionId: `execution-${index}`, seq: 2,
      },
    });
  }
  assert.equal(writer.getDebugState().terminalToolKeys, 2_048);
  callbacks.shift()?.();
});

test('ordered stdout writer does not head-of-line block RPC responses behind a bulk event backlog', async () => {
  const written: string[] = [];
  const callbacks: Array<() => void> = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      written.push(chunk.toString());
      callbacks.push(callback);
    },
  });
  const writer = new OrderedJsonlWriter(stream, { maxQueuedBytes: 1024 * 1024 });

  writer.write({ event: 'message.delta', payload: { sessionPath: '/s', delta: 'active' } });
  for (let i = 0; i < 100; i += 1) {
    writer.write({ event: 'message.delta', payload: { sessionPath: '/s', delta: String(i) } });
  }
  writer.write({ id: 'control', ok: true, result: { ok: true } });

  callbacks.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(written[1]!), { id: 'control', ok: true, result: { ok: true } });

  while (callbacks.length > 0) callbacks.shift()!();
});

test('event-lane saturation cannot consume reserved response capacity', async () => {
  const written: string[] = [];
  const callbacks: Array<() => void> = [];
  const fatal: Error[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      written.push(chunk.toString());
      callbacks.push(callback);
    },
  });
  const writer = new OrderedJsonlWriter(stream, {
    maxQueuedBytes: 120,
    maxQueuedResponseBytes: 120,
    onFatal: (error) => fatal.push(error),
  });

  writer.write({ event: 'message.delta', payload: { delta: 'active' } });
  writer.write({ event: 'message.delta', payload: { delta: 'x'.repeat(50) } });
  writer.write({ id: 'control', ok: true, result: 'y'.repeat(50) });
  assert.equal(fatal.length, 0);

  callbacks.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(written[1]!).id, 'control');
  while (callbacks.length > 0) callbacks.shift()!();
});

test('ordered stdout writer rejects an oversized correlated response without failing the transport', async () => {
  const written: string[] = [];
  const fatal: Error[] = [];
  const stream = new Writable({ write(chunk, _encoding, callback) { written.push(chunk.toString()); callback(); } });
  const writer = new OrderedJsonlWriter(stream, { onFatal: (error) => fatal.push(error) });
  writer.write({ id: 'too-large', ok: true, result: 'x'.repeat(JSONL_MAX_LINE_BYTES) });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fatal.length, 0);
  assert.equal(written.length, 1);
  const response = JSON.parse(written[0]!);
  assert.equal(response.id, 'too-large');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'RESPONSE_TOO_LARGE');
  assert.match(response.error.message, new RegExp(`^Backend response exceeded the JSONL record limit \\(\\d+ > ${JSONL_MAX_LINE_BYTES} bytes\\)\\.$`));
});

test('ordered stdout writer still fails before writing an oversized event', () => {
  const fatal: Error[] = [];
  const stream = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const writer = new OrderedJsonlWriter(stream, { onFatal: (error) => fatal.push(error) });
  assert.throws(() => writer.write({ event: 'critical', payload: 'x'.repeat(JSONL_MAX_LINE_BYTES) }), /record overflow/);
  assert.equal(fatal.length, 1);
});

test('ordered stdout writer drops progress at saturation but fails explicitly on critical event overflow', () => {
  const callbacks: Array<() => void> = [];
  const fatal: Error[] = [];
  const stream = new Writable({ write(_chunk, _encoding, callback) { callbacks.push(callback); } });
  const writer = new OrderedJsonlWriter(stream, { maxQueuedBytes: 80, onFatal: (error) => fatal.push(error) });
  writer.write({ id: 'active', ok: true });
  writer.write({ event: 'tool.progress', payload: { sessionPath: '/s', toolCallId: 't', partialResult: 'x'.repeat(200) } });
  assert.equal(fatal.length, 0, 'droppable progress does not make saturation fatal');
  assert.throws(() => writer.write({ event: 'error', payload: { message: 'x'.repeat(200) } }), /event queue overflow/);
  assert.equal(fatal.length, 1);
  callbacks.shift()?.();
});
