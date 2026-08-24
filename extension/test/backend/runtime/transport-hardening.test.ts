import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import * as fs from 'node:fs/promises';

import { attachJsonlLineReader, JSONL_MAX_LINE_BYTES, serializeJsonLine } from '../../../src/shared/jsonl';
import { boundToolProgress } from '../../../src/backend/session-event-handler';
import { OrderedJsonlWriter } from '../../../src/backend/server-io';
import { extractPreviewRequestId } from '../../../src/backend/server';
import { applyJsonPatch, type JsonSafeValue, type JsonStructuralPatchOperation } from '../../../src/shared/json-structural-patch';
import {
  flushBackendLivePipelineTrace,
  getBackendLivePipelineTracePath,
  getBackendLivePipelineTraceRunId,
  isBackendLivePipelineTraceEnabled,
  setBackendLivePipelineTraceEnabled,
} from '../../../src/backend/live-pipeline-trace-runtime';
import { hashBackendTraceIdentifier } from '../../helpers/backend-live-pipeline-trace';

/** Run identity this process's shared canonical trace store persists. */
const backendRunHash = hashBackendTraceIdentifier(getBackendLivePipelineTraceRunId());

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

interface WriterTraceRecord {
  stage?: string;
  kind?: string;
  reasonCode?: string;
  writerSeq?: number;
  eventSeq?: number;
  eventKind?: string;
  writerLane?: string;
  producedPayloadBytes?: number;
  runIdHash?: string;
}

async function readAppendedWriterTrace(before: string): Promise<WriterTraceRecord[]> {
  const after = await fs.readFile(getBackendLivePipelineTracePath(), 'utf8');
  const appended = after.startsWith(before) ? after.slice(before.length) : after;
  // Concurrent processes append to the same canonical file with a different
  // run identity (and their own process-local writerSeq numbers); filter them
  // out so they cannot collide with this suite's identities.
  return appended
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WriterTraceRecord)
    .filter((record) => record.runIdHash === backendRunHash);
}

function assertQueuedIdentity(
  records: WriterTraceRecord[],
  writerSeq: number,
  terminal?: { kind: string; reasonCode?: string },
): void {
  const queued = records.filter((record) =>
    record.stage === 'backend.writer.queued' && record.writerSeq === writerSeq);
  const settled = records.filter((record) =>
    record.stage === 'backend.writer.settled' && record.writerSeq === writerSeq);
  assert.equal(queued.length, 1, `writerSeq ${writerSeq} must queue exactly once`);
  assert.equal(
    settled.length,
    terminal === undefined ? 0 : 1,
    `writerSeq ${writerSeq} must have ${terminal === undefined ? 'no' : 'exactly one'} terminal record`,
  );
  if (terminal !== undefined && settled[0] !== undefined) {
    assert.equal(settled[0].kind, terminal.kind, `writerSeq ${writerSeq} terminal kind`);
    assert.equal(settled[0].reasonCode, terminal.reasonCode, `writerSeq ${writerSeq} terminal reason`);
  }
}

/** Every queued identity queues once, has at most one terminal, and every
 *  terminal record pairs with a queued identity: no queued frame is ever left
 *  without a terminal outcome and no identity is ever dropped while queued. */
function assertNoWriterIdentityContradictions(records: WriterTraceRecord[]): void {
  const queued = records.filter((record) =>
    record.stage === 'backend.writer.queued' && record.writerSeq !== undefined);
  const settled = records.filter((record) =>
    record.stage === 'backend.writer.settled' && record.writerSeq !== undefined);
  const queuedSeqs = queued.map((record) => record.writerSeq!);
  for (const writerSeq of new Set(queuedSeqs)) {
    assert.equal(
      queuedSeqs.filter((seq) => seq === writerSeq).length,
      1,
      `writerSeq ${writerSeq} must not queue twice`,
    );
    assert.ok(
      settled.filter((record) => record.writerSeq === writerSeq).length <= 1,
      `writerSeq ${writerSeq} must have at most one terminal record`,
    );
  }
  for (const record of settled) {
    assert.ok(
      queuedSeqs.includes(record.writerSeq!),
      `settled writerSeq ${record.writerSeq} must have a queued record`,
    );
  }
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
  assert.ok(bounded.details.results[0].cumulativeOutputTokens > 0);
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

test('stalled stdout coalesces contiguous v7 subagent patches without duplicating recursive snapshots', async () => {
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
    maxQueuedBytes: 2 * 1024 * 1024,
    onFatal: (error) => fatal.push(error),
  });
  writer.write({ id: 'blocked', ok: true });

  const recursiveText = 'x'.repeat(512 * 1024);
  const basePayload = {
    protocolVersion: 7, sessionPath: '/s', requestId: 'request', turnId: 'turn',
    attemptId: 'attempt', executionId: 'execution', kind: 'tool.progress', occurredAt: 1,
    checkpointBytes: 30 * 1024 * 1024,
  };
  writer.write({
    event: 'live.semantic',
    payload: {
      ...basePayload, seq: 2, baseSeq: 1, baseProgressRevision: 0, progressRevision: 1,
      update: { kind: 'snapshot', preview: {
        kind: 'subagent', mode: 'single', omittedChildren: 0,
        children: [{ id: 'worker', phase: 'running', streamingText: recursiveText, messages: [{
          role: 'assistant', content: [{ type: 'text', text: recursiveText }],
        }] }],
      } },
    },
  });
  let naiveSnapshotBytes = 0;
  for (let index = 0; index < 200; index += 1) {
    const seq = index + 3;
    naiveSnapshotBytes += Buffer.byteLength(recursiveText) * 2;
    writer.write({
      event: 'live.semantic',
      payload: {
        ...basePayload, occurredAt: seq, seq, baseSeq: seq - 1,
        baseProgressRevision: index + 1, progressRevision: index + 2,
        update: { kind: 'patch', operations: [{
          op: 'appendString', path: ['children', 0, 'streamingText'], value: 'y'.repeat(128),
        }] },
      },
    });
    assert.ok(writer.getDebugState().queuedBytes < 2 * 1024 * 1024);
    assert.equal(writer.getDebugState().queueDepth, 1);
  }
  writer.write({
    event: 'live.semantic',
    payload: {
      ...basePayload, kind: 'tool.terminal', seq: 203, status: 'completed',
      result: { kind: 'subagent', children: [] }, durableEntryId: 'entry',
    },
  });
  assert.equal(fatal.length, 0);
  assert.equal(writer.getDebugState().queueDepth, 2, 'coalesced progress remains ordered before terminal');
  assert.ok(naiveSnapshotBytes >= 200 * 1024 * 1024, 'fixture represents the former duplicate-snapshot volume');

  while (callbacks.length > 0) callbacks.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  const drained = written.map((line) => JSON.parse(line));
  assert.equal(drained[1].payload.kind, 'tool.progress');
  assert.equal(drained[1].payload.baseSeq, 1);
  assert.equal(drained[1].payload.seq, 202);
  const coalescedUpdate = drained[1].payload.update;
  assert.equal(coalescedUpdate.kind, 'snapshot');
  const reconstructed = applyJsonPatch(
    coalescedUpdate.preview as JsonSafeValue,
    coalescedUpdate.operations ?? [],
  );
  assert.equal(reconstructed.ok, true);
  if (reconstructed.ok) {
    const preview = reconstructed.value as { children: Array<{ streamingText: string }> };
    assert.equal(preview.children[0]?.streamingText.length, recursiveText.length + 200 * 128);
  }
  assert.equal(drained[2].payload.kind, 'tool.terminal');
});

test('writer trace: semantic composition drops the replaced queued identity and keeps one queued identity for the survivor', async () => {
  const callbacks: Array<() => void> = [];
  const written: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      written.push(chunk.toString());
      callbacks.push(callback);
    },
  });
  const writer = new OrderedJsonlWriter(stream, { maxQueuedBytes: 1024 * 1024 });
  const frameBytes = (frame: unknown) => Buffer.byteLength(serializeJsonLine(frame));
  const basePayload = {
    protocolVersion: 7, sessionPath: '/s', turnId: 'turn', attemptId: 'attempt',
    executionId: 'execution', kind: 'tool.progress', occurredAt: 1, checkpointBytes: 1024,
  };
  const snapshot = {
    event: 'live.semantic',
    payload: {
      ...basePayload, seq: 2, baseSeq: 1, baseProgressRevision: 0, progressRevision: 1,
      update: { kind: 'snapshot', preview: { kind: 'generic', items: [] } },
    },
  };
  const patch = {
    event: 'live.semantic',
    payload: {
      ...basePayload, seq: 3, baseSeq: 2, baseProgressRevision: 1, progressRevision: 2,
      update: { kind: 'patch', operations: [{ op: 'appendArray', path: ['items'], value: ['two'] }] },
    },
  };
  const response = { id: 'active', ok: true };

  const tracePath = getBackendLivePipelineTracePath();
  const wasEnabled = isBackendLivePipelineTraceEnabled();
  setBackendLivePipelineTraceEnabled(true);
  // Drain records buffered by earlier trace-writing tests in this process so
  // they land before the window and cannot duplicate this test's identities.
  await flushBackendLivePipelineTrace();
  const before = await fs.readFile(tracePath, 'utf8').catch(() => '');
  try {
    writer.write(response);
    assert.equal(callbacks.length, 1, 'response becomes the active OS write');
    writer.write(snapshot);
    writer.write(patch);
    await flushBackendLivePipelineTrace();
    const records = await readAppendedWriterTrace(before);

    const responseQueued = records.find((record) =>
      record.stage === 'backend.writer.queued' && record.writerLane === 'response'
      && record.producedPayloadBytes === frameBytes(response));
    const snapshotQueued = records.find((record) =>
      record.stage === 'backend.writer.queued' && record.eventSeq === 2);
    const survivorQueued = records.find((record) =>
      record.stage === 'backend.writer.queued' && record.eventSeq === 3);
    assert.ok(responseQueued && snapshotQueued && survivorQueued, 'response, snapshot, and composed survivor must each record a queued trace');
    assert.notEqual(survivorQueued.writerSeq, snapshotQueued.writerSeq, 'the composed survivor must keep its own fresh identity');
    assert.equal(writer.getDebugState().queueDepth, 1, 'composition leaves exactly one queued frame');

    // The replaced queued snapshot identity receives its dropped/coalesced
    // record; the surviving combined identity is queued but not yet terminal
    // (it is never queued and immediately dropped while it remains queued).
    assertQueuedIdentity(records, snapshotQueued.writerSeq!, { kind: 'false', reasonCode: 'writer_progress_coalesced' });
    assertQueuedIdentity(records, survivorQueued.writerSeq!);
    assertNoWriterIdentityContradictions(records);

    while (callbacks.length > 0) callbacks.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    await flushBackendLivePipelineTrace();
    const drainedRecords = await readAppendedWriterTrace(before);
    assertQueuedIdentity(drainedRecords, responseQueued.writerSeq!, { kind: 'success' });
    assertQueuedIdentity(drainedRecords, snapshotQueued.writerSeq!, { kind: 'false', reasonCode: 'writer_progress_coalesced' });
    assertQueuedIdentity(drainedRecords, survivorQueued.writerSeq!, { kind: 'success' });
    assertNoWriterIdentityContradictions(drainedRecords);

    // Composed patch semantics are preserved end to end.
    assert.equal(written.length, 2, 'only the response and the composed progress frame are written');
    assert.deepEqual(JSON.parse(written[0]!), response);
    const combined = JSON.parse(written[1]!) as {
      payload: {
        seq: number; baseSeq: number; baseProgressRevision: number;
        update: { kind: string; preview: JsonSafeValue; operations?: JsonStructuralPatchOperation[] };
      };
    };
    assert.equal(combined.payload.seq, 3);
    assert.equal(combined.payload.baseSeq, 1);
    assert.equal(combined.payload.baseProgressRevision, 0);
    assert.equal(combined.payload.update.kind, 'snapshot');
    const reconstructed = applyJsonPatch(combined.payload.update.preview, combined.payload.update.operations ?? []);
    assert.equal(reconstructed.ok, true);
    if (reconstructed.ok) assert.deepEqual(reconstructed.value, { kind: 'generic', items: ['two'] });
  } finally {
    setBackendLivePipelineTraceEnabled(wasEnabled);
    await flushBackendLivePipelineTrace();
  }
});

test('writer trace: latest-patch replacement drops the replaced queued identity without dropping the survivor while queued', async () => {
  const callbacks: Array<() => void> = [];
  const written: string[] = [];
  const fatal: Error[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      written.push(chunk.toString());
      callbacks.push(callback);
    },
  });
  // The composed snapshot+patch would exceed the event budget, so the latest
  // patch replaces the queued snapshot instead (composition is unwriteable).
  const writer = new OrderedJsonlWriter(stream, { maxQueuedBytes: 2048, onFatal: (error) => fatal.push(error) });
  const frameBytes = (frame: unknown) => Buffer.byteLength(serializeJsonLine(frame));
  const basePayload = {
    protocolVersion: 7, sessionPath: '/s', turnId: 'turn', attemptId: 'attempt',
    executionId: 'execution', kind: 'tool.progress', occurredAt: 1, checkpointBytes: 1024,
  };
  const snapshot = {
    event: 'live.semantic',
    payload: {
      ...basePayload, seq: 2, baseSeq: 1, baseProgressRevision: 0, progressRevision: 1,
      update: { kind: 'snapshot', preview: { kind: 'generic', summary: 'x'.repeat(1600) } },
    },
  };
  const patch = {
    event: 'live.semantic',
    payload: {
      ...basePayload, seq: 3, baseSeq: 2, baseProgressRevision: 1, progressRevision: 2,
      update: { kind: 'patch', operations: [{
        op: 'appendString', path: ['summary'], value: 'y'.repeat(1024),
      }] },
    },
  };
  const response = { id: 'active', ok: true };

  const tracePath = getBackendLivePipelineTracePath();
  const wasEnabled = isBackendLivePipelineTraceEnabled();
  setBackendLivePipelineTraceEnabled(true);
  // Drain records buffered by earlier trace-writing tests in this process so
  // they land before the window and cannot duplicate this test's identities.
  await flushBackendLivePipelineTrace();
  const before = await fs.readFile(tracePath, 'utf8').catch(() => '');
  try {
    writer.write(response);
    assert.equal(callbacks.length, 1, 'response becomes the active OS write');
    writer.write(snapshot);
    writer.write(patch);
    await flushBackendLivePipelineTrace();
    const records = await readAppendedWriterTrace(before);

    const responseQueued = records.find((record) =>
      record.stage === 'backend.writer.queued' && record.writerLane === 'response'
      && record.producedPayloadBytes === frameBytes(response));
    const snapshotQueued = records.find((record) =>
      record.stage === 'backend.writer.queued' && record.eventSeq === 2);
    const survivorQueued = records.find((record) =>
      record.stage === 'backend.writer.queued' && record.eventSeq === 3);
    assert.ok(responseQueued && snapshotQueued && survivorQueued, 'response, snapshot, and latest patch must each record a queued trace');
    assert.notEqual(survivorQueued.writerSeq, snapshotQueued.writerSeq, 'the latest patch must keep its own fresh identity');
    assert.equal(writer.getDebugState().queueDepth, 1, 'latest-patch replacement leaves exactly one queued frame');
    assert.equal(fatal.length, 0);

    assertQueuedIdentity(records, snapshotQueued.writerSeq!, { kind: 'false', reasonCode: 'writer_progress_coalesced' });
    assertQueuedIdentity(records, survivorQueued.writerSeq!);
    assertNoWriterIdentityContradictions(records);

    while (callbacks.length > 0) callbacks.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    await flushBackendLivePipelineTrace();
    const drainedRecords = await readAppendedWriterTrace(before);
    assertQueuedIdentity(drainedRecords, responseQueued.writerSeq!, { kind: 'success' });
    assertQueuedIdentity(drainedRecords, snapshotQueued.writerSeq!, { kind: 'false', reasonCode: 'writer_progress_coalesced' });
    assertQueuedIdentity(drainedRecords, survivorQueued.writerSeq!, { kind: 'success' });
    assertNoWriterIdentityContradictions(drainedRecords);

    // The raw latest patch is written as-is (its base revision mismatch
    // triggers the host checkpoint RPC); the replaced snapshot is never written.
    assert.equal(written.length, 2, 'only the response and the latest patch are written');
    assert.deepEqual(JSON.parse(written[0]!), response);
    const latest = JSON.parse(written[1]!) as { payload: { seq: number; update: { kind: string } } };
    assert.equal(latest.payload.seq, 3);
    assert.equal(latest.payload.update.kind, 'patch');
  } finally {
    setBackendLivePipelineTraceEnabled(wasEnabled);
    await flushBackendLivePipelineTrace();
  }
});

test('writer trace: ordinary progress replacement drops the replaced queued identity and settles the survivor once', async () => {
  const callbacks: Array<() => void> = [];
  const written: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      written.push(chunk.toString());
      callbacks.push(callback);
    },
  });
  const writer = new OrderedJsonlWriter(stream, { maxQueuedBytes: 1024 * 1024 });
  const frameBytes = (frame: unknown) => Buffer.byteLength(serializeJsonLine(frame));
  const progress = (partialResult: string) => ({
    event: 'tool.progress',
    payload: { sessionPath: '/s', toolCallId: 't', partialResult },
  });
  const stale = progress('stale');
  const latest = progress('latest');
  const response = { id: 'active', ok: true };

  const tracePath = getBackendLivePipelineTracePath();
  const wasEnabled = isBackendLivePipelineTraceEnabled();
  setBackendLivePipelineTraceEnabled(true);
  // Drain records buffered by earlier trace-writing tests in this process so
  // they land before the window and cannot duplicate this test's identities.
  await flushBackendLivePipelineTrace();
  const before = await fs.readFile(tracePath, 'utf8').catch(() => '');
  try {
    writer.write(response);
    assert.equal(callbacks.length, 1, 'response becomes the active OS write');
    writer.write(stale);
    writer.write(latest);
    await flushBackendLivePipelineTrace();
    const records = await readAppendedWriterTrace(before);

    const responseQueued = records.find((record) =>
      record.stage === 'backend.writer.queued' && record.writerLane === 'response'
      && record.producedPayloadBytes === frameBytes(response));
    const staleQueued = records.find((record) =>
      record.stage === 'backend.writer.queued' && record.writerLane === 'progress'
      && record.producedPayloadBytes === frameBytes(stale));
    const survivorQueued = records.find((record) =>
      record.stage === 'backend.writer.queued' && record.writerLane === 'progress'
      && record.producedPayloadBytes === frameBytes(latest));
    assert.ok(responseQueued && staleQueued && survivorQueued, 'response, stale, and latest progress must each record a queued trace');
    assert.notEqual(survivorQueued.writerSeq, staleQueued.writerSeq, 'the latest progress must keep its own fresh identity');
    assert.equal(writer.getDebugState().queueDepth, 1, 'ordinary replacement leaves exactly one queued frame');

    assertQueuedIdentity(records, staleQueued.writerSeq!, { kind: 'false', reasonCode: 'writer_progress_coalesced' });
    assertQueuedIdentity(records, survivorQueued.writerSeq!);
    assertNoWriterIdentityContradictions(records);

    while (callbacks.length > 0) callbacks.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    await flushBackendLivePipelineTrace();
    const drainedRecords = await readAppendedWriterTrace(before);
    assertQueuedIdentity(drainedRecords, responseQueued.writerSeq!, { kind: 'success' });
    assertQueuedIdentity(drainedRecords, staleQueued.writerSeq!, { kind: 'false', reasonCode: 'writer_progress_coalesced' });
    assertQueuedIdentity(drainedRecords, survivorQueued.writerSeq!, { kind: 'success' });
    assertNoWriterIdentityContradictions(drainedRecords);

    assert.equal(written.length, 2, 'only the response and the latest progress are written');
    assert.deepEqual(JSON.parse(written[0]!), response);
    assert.equal((JSON.parse(written[1]!) as { payload: { partialResult: string } }).payload.partialResult, 'latest');
  } finally {
    setBackendLivePipelineTraceEnabled(wasEnabled);
    await flushBackendLivePipelineTrace();
  }
});

test('writer trace: a terminal supersedes queued progress with an explicit dropped record for the removed identity', async () => {
  const callbacks: Array<() => void> = [];
  const written: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      written.push(chunk.toString());
      callbacks.push(callback);
    },
  });
  const writer = new OrderedJsonlWriter(stream, { maxQueuedBytes: 1024 * 1024 });
  const frameBytes = (frame: unknown) => Buffer.byteLength(serializeJsonLine(frame));
  const progress = { event: 'tool.progress', payload: { sessionPath: '/s', toolCallId: 't', partialResult: 'stale' } };
  const terminal = { event: 'tool.finished', payload: { sessionPath: '/s', toolCallId: 't', status: 'completed' } };
  const response = { id: 'active', ok: true };

  const tracePath = getBackendLivePipelineTracePath();
  const wasEnabled = isBackendLivePipelineTraceEnabled();
  setBackendLivePipelineTraceEnabled(true);
  // Drain records buffered by earlier trace-writing tests in this process so
  // they land before the window and cannot duplicate this test's identities.
  await flushBackendLivePipelineTrace();
  const before = await fs.readFile(tracePath, 'utf8').catch(() => '');
  try {
    writer.write(response);
    assert.equal(callbacks.length, 1, 'response becomes the active OS write');
    writer.write(progress);
    writer.write(terminal);
    await flushBackendLivePipelineTrace();
    const records = await readAppendedWriterTrace(before);

    const responseQueued = records.find((record) =>
      record.stage === 'backend.writer.queued' && record.writerLane === 'response'
      && record.producedPayloadBytes === frameBytes(response));
    const progressQueued = records.find((record) =>
      record.stage === 'backend.writer.queued' && record.writerLane === 'progress'
      && record.producedPayloadBytes === frameBytes(progress));
    const terminalQueued = records.find((record) =>
      record.stage === 'backend.writer.queued' && record.writerLane === 'lifecycle'
      && record.producedPayloadBytes === frameBytes(terminal));
    assert.ok(responseQueued && progressQueued && terminalQueued, 'response, progress, and terminal must each record a queued trace');
    assert.equal(writer.getDebugState().queueDepth, 1, 'terminal supersession leaves exactly one queued frame');

    // The removed queued progress identity receives an explicit
    // dropped/superseded record; the terminal is queued but not yet terminal.
    assertQueuedIdentity(records, progressQueued.writerSeq!, { kind: 'false', reasonCode: 'writer_progress_superseded' });
    assertQueuedIdentity(records, terminalQueued.writerSeq!);
    assertNoWriterIdentityContradictions(records);

    while (callbacks.length > 0) callbacks.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    await flushBackendLivePipelineTrace();
    const drainedRecords = await readAppendedWriterTrace(before);
    assertQueuedIdentity(drainedRecords, responseQueued.writerSeq!, { kind: 'success' });
    assertQueuedIdentity(drainedRecords, progressQueued.writerSeq!, { kind: 'false', reasonCode: 'writer_progress_superseded' });
    assertQueuedIdentity(drainedRecords, terminalQueued.writerSeq!, { kind: 'success' });
    assertNoWriterIdentityContradictions(drainedRecords);

    assert.equal(written.length, 2, 'the superseded progress is never written; response and terminal are');
    assert.deepEqual(JSON.parse(written[0]!), response);
    assert.equal((JSON.parse(written[1]!) as { payload: { status: string } }).payload.status, 'completed');
  } finally {
    setBackendLivePipelineTraceEnabled(wasEnabled);
    await flushBackendLivePipelineTrace();
  }
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

test('writer evidence: a queued event is never ahead of a response; queued-behind metadata is explicit at enqueue', async () => {
  const callbacks: Array<() => void> = [];
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callbacks.push(callback);
    },
  });
  const writer = new OrderedJsonlWriter(stream);
  const responseFrame = { id: 'evidence-response', ok: true };
  const eventFrame = { event: 'message.delta', payload: { sessionPath: '/s', delta: 'x' } };
  const secondResponseFrame = { id: 'evidence-response-2', ok: true };
  const thirdResponseFrame = { id: 'evidence-response-33', ok: true };
  const frameBytes = (frame: unknown) => Buffer.byteLength(serializeJsonLine(frame));
  const tracePath = getBackendLivePipelineTracePath();
  const wasEnabled = isBackendLivePipelineTraceEnabled();
  setBackendLivePipelineTraceEnabled(true);
  // Drain records buffered by earlier trace-writing tests in this process so
  // they land before the window and cannot duplicate this test's identities.
  await flushBackendLivePipelineTrace();
  const before = await fs.readFile(tracePath, 'utf8').catch(() => '');
  try {
    // Response write starts; the event is queued behind it; two more responses
    // queue behind both (so the second queued response sits behind another
    // queued response).
    writer.write(responseFrame);
    assert.equal(callbacks.length, 1, 'first response becomes the active OS write');
    writer.write(eventFrame);
    writer.write(secondResponseFrame);
    writer.write(thirdResponseFrame);
    await flushBackendLivePipelineTrace();
    const after = await fs.readFile(tracePath, 'utf8');
    const appended = after.startsWith(before) ? after.slice(before.length) : after;
    const records = appended
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        stage?: string; kind?: string; writerLane?: string; eventKind?: string;
        writerSeq?: number; activeWriteSeq?: number; activeWriteLane?: string;
        aheadOfResponse?: boolean; queuedBehindResponse?: boolean; producedPayloadBytes?: number;
        runIdHash?: string;
      })
      .filter((record) => record.runIdHash === backendRunHash);
    const queued = records.filter((record) => record.stage === 'backend.writer.queued');
    const responseQueued = queued.find((record) =>
      record.writerLane === 'response' && record.producedPayloadBytes === frameBytes(responseFrame));
    const eventQueued = queued.find((record) =>
      record.writerLane === 'progress' && record.producedPayloadBytes === frameBytes(eventFrame));
    const secondResponseQueued = queued.find((record) =>
      record.writerLane === 'response' && record.producedPayloadBytes === frameBytes(secondResponseFrame));
    const thirdResponseQueued = queued.find((record) =>
      record.writerLane === 'response' && record.producedPayloadBytes === frameBytes(thirdResponseFrame));
    assert.ok(responseQueued && eventQueued && secondResponseQueued && thirdResponseQueued, 'all four frames must record a queued trace');

    // The queued EVENT is behind the active response write: it must NOT count
    // as ahead of a response even though it is already enqueued.
    assert.equal(eventQueued.aheadOfResponse, false);
    assert.equal(eventQueued.activeWriteSeq, responseQueued.writerSeq);
    assert.equal(eventQueued.activeWriteLane, 'response');
    assert.equal(eventQueued.queuedBehindResponse, false);

    // A response queued while the active write is a response is behind that
    // active write, not another queued response.
    assert.equal(secondResponseQueued.aheadOfResponse, false);
    assert.equal(secondResponseQueued.queuedBehindResponse, false);
    assert.equal(secondResponseQueued.activeWriteSeq, responseQueued.writerSeq);
    // A response queued behind another queued response says so explicitly.
    assert.equal(thirdResponseQueued.aheadOfResponse, false);
    assert.equal(thirdResponseQueued.queuedBehindResponse, true);
    assert.equal(thirdResponseQueued.activeWriteSeq, responseQueued.writerSeq);

    // The active write settles with two responses queued behind it: the
    // response-priority lane could not preempt the in-flight OS write, so the
    // settling frame counts as ahead of a response.
    callbacks.shift()!();
    await flushBackendLivePipelineTrace();
    const settledAfter = await fs.readFile(tracePath, 'utf8');
    const settledAppended = settledAfter.startsWith(before) ? settledAfter.slice(before.length) : settledAfter;
    const settledRecords = settledAppended
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        stage?: string; kind?: string; writerLane?: string; writerSeq?: number;
        aheadOfResponse?: boolean; producedPayloadBytes?: number; runIdHash?: string;
      })
      .filter((record) => record.runIdHash === backendRunHash)
      .filter((record) => record.stage === 'backend.writer.settled');
    const responseSettled = settledRecords.find((record) =>
      record.writerSeq === responseQueued.writerSeq && record.writerLane === 'response');
    assert.ok(responseSettled, 'the active write must record a settled trace');
    assert.equal(responseSettled.writerSeq, responseQueued.writerSeq, 'settled identity must pair with its queued record');
    assert.equal(responseSettled.kind, 'success');
    assert.equal(responseSettled.aheadOfResponse, true);
  } finally {
    setBackendLivePipelineTraceEnabled(wasEnabled);
    await flushBackendLivePipelineTrace();
  }
});

test('writer evidence: an active event write is ahead of a queued response', async () => {
  const callbacks: Array<() => void> = [];
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callbacks.push(callback);
    },
  });
  const writer = new OrderedJsonlWriter(stream);
  const eventFrame = { event: 'message.delta', payload: { sessionPath: '/s', delta: 'active-write' } };
  const responseFrame = { id: 'evidence-response', ok: true };
  const frameBytes = (frame: unknown) => Buffer.byteLength(serializeJsonLine(frame));
  const tracePath = getBackendLivePipelineTracePath();
  const wasEnabled = isBackendLivePipelineTraceEnabled();
  setBackendLivePipelineTraceEnabled(true);
  // Drain records buffered by earlier trace-writing tests in this process so
  // they land before the window and cannot duplicate this test's identities.
  await flushBackendLivePipelineTrace();
  const before = await fs.readFile(tracePath, 'utf8').catch(() => '');
  try {
    // An EVENT becomes the active OS write; the response queues behind it.
    writer.write(eventFrame);
    assert.equal(callbacks.length, 1, 'event becomes the active OS write');
    writer.write(responseFrame);
    await flushBackendLivePipelineTrace();
    const after = await fs.readFile(tracePath, 'utf8');
    const appended = after.startsWith(before) ? after.slice(before.length) : after;
    const records = appended
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        stage?: string; writerLane?: string; eventKind?: string; writerSeq?: number;
        activeWriteSeq?: number; activeWriteLane?: string; aheadOfResponse?: boolean;
        queuedBehindResponse?: boolean; producedPayloadBytes?: number; runIdHash?: string;
      })
      .filter((record) => record.runIdHash === backendRunHash);
    const queued = records.filter((record) => record.stage === 'backend.writer.queued');
    const eventQueued = queued.find((record) =>
      record.writerLane === 'progress' && record.producedPayloadBytes === frameBytes(eventFrame));
    const responseQueued = queued.find((record) =>
      record.writerLane === 'response' && record.producedPayloadBytes === frameBytes(responseFrame));
    assert.ok(eventQueued && responseQueued, 'both frames must record a queued trace');
    // The queued response is behind the active event write and not ahead of
    // any response; the active write is identified by sequence and lane.
    assert.equal(responseQueued.aheadOfResponse, false);
    assert.equal(responseQueued.queuedBehindResponse, false);
    assert.equal(responseQueued.activeWriteSeq, eventQueued.writerSeq);
    assert.equal(responseQueued.activeWriteLane, 'progress');

    // The active event write settles with the response still queued: it was
    // ahead of that response (the response could not preempt the in-flight
    // OS write), which the settling record states explicitly.
    callbacks.shift()!();
    await flushBackendLivePipelineTrace();
    const settledAfter = await fs.readFile(tracePath, 'utf8');
    const settledAppended = settledAfter.startsWith(before) ? settledAfter.slice(before.length) : settledAfter;
    const settled = settledAppended
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        stage?: string; kind?: string; writerSeq?: number; aheadOfResponse?: boolean; runIdHash?: string;
      })
      .filter((record) => record.runIdHash === backendRunHash)
      .filter((record) => record.stage === 'backend.writer.settled');
    const eventSettled = settled.find((record) => record.writerSeq === eventQueued.writerSeq);
    assert.ok(eventSettled, 'the active write must record a settled trace');
    assert.equal(eventSettled.kind, 'success');
    assert.equal(eventSettled.aheadOfResponse, true);
  } finally {
    setBackendLivePipelineTraceEnabled(wasEnabled);
    await flushBackendLivePipelineTrace();
  }
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
