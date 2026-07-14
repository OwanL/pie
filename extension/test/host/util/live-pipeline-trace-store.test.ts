import assert from 'node:assert/strict';
import test from 'node:test';
import { basename } from 'node:path';

import type { LivePipelineTraceSink } from '../../../src/host/util/live-pipeline-trace-store';
import { LivePipelineTraceStore } from '../../../src/host/util/live-pipeline-trace-store';

class MemorySink implements LivePipelineTraceSink {
  readonly files = new Map<string, string>();
  readonly removed: string[] = [];
  appendCalls = 0;
  failAppend = false;
  async append(filePath: string, data: string) {
    this.appendCalls += 1;
    if (this.failAppend) throw new Error('sensitive write failure');
    this.files.set(filePath, `${this.files.get(filePath) ?? ''}${data}`);
  }
  async size(filePath: string) { return Buffer.byteLength(this.files.get(filePath) ?? '', 'utf8'); }
  async rotate(sourcePath: string, targetPath: string) {
    const data = this.files.get(sourcePath);
    if (data === undefined) throw new Error('missing active trace');
    this.files.delete(sourcePath); this.files.set(targetPath, data);
  }
  async list() { return [...this.files.keys()].map((filePath) => basename(filePath)); }
  async remove(filePath: string) { this.removed.push(filePath); this.files.delete(filePath); }
}

function createStore(sink: MemorySink, options: Partial<ConstructorParameters<typeof LivePipelineTraceStore>[0]> = {}) {
  return new LivePipelineTraceStore({
    enabled: true,
    process: 'host',
    traceRunId: 'run-1',
    hmacKey: 'test-hmac-key',
    directory: '/trace',
    fileName: 'trace.jsonl',
    wallClock: () => 100,
    monoClock: () => 5,
    sink,
    ...options,
  });
}
function event(session = 'private-session-id') {
  return {
    process: 'host' as const,
    stage: 'host.reducer.applied' as const,
    kind: 'success' as const,
    identifiers: { session },
    eventSeq: 1,
  };
}
function records(sink: MemorySink): Array<Record<string, unknown>> {
  return [...sink.files.values()].flatMap((text) => text.trim().split('\n').filter(Boolean)).map((line) => JSON.parse(line));
}

test('disabled store short-circuits before clocks, sampling, hashing, or sink', async () => {
  const sink = new MemorySink(); let wallCalls = 0; let randomCalls = 0;
  const store = new LivePipelineTraceStore({
    enabled: false, process: 'host', traceRunId: 'run', hmacKey: 'key', sink,
    wallClock: () => { wallCalls += 1; return 1; },
    monoClock: () => { throw new Error('must not run'); },
    random: () => { randomCalls += 1; return 0; },
  });
  assert.equal(store.record(event()), false);
  await store.flush();
  assert.equal(wallCalls, 0); assert.equal(randomCalls, 0); assert.equal(sink.appendCalls, 0);
  assert.equal(store.getHealth().enabled, false);
});

test('sampling and queue bounds expose emitted, sampled, dropped, and unflushed', async () => {
  const sink = new MemorySink();
  const sampled = createStore(sink, { sampleRate: 0.5, random: () => 0.5, maxQueueSize: 1 });
  assert.equal(sampled.record(event()), false); assert.equal(sampled.getHealth().sampled, 1);
  const bounded = createStore(sink, { maxQueueSize: 1 });
  assert.equal(bounded.record(event('first')), true);
  assert.equal(bounded.record(event('second')), false);
  assert.equal(bounded.getHealth().dropped, 1);
  assert.equal(bounded.getHealth().unflushed, 1);
  await bounded.flush();
  assert.equal(bounded.getHealth().emitted, 1);
  assert.equal(bounded.getHealth().unflushed, 0);
});

test('flush writes metadata plus trace-health and no raw identifier/content fields', async () => {
  const sink = new MemorySink(); const store = createStore(sink);
  assert.equal(store.record({ ...event(), durationMs: 4, queueDepth: 2 }), true);
  await store.flush();
  const emitted = records(sink);
  assert.equal(emitted.length, 2);
  assert.equal(emitted[0]!.stage, 'host.reducer.applied');
  assert.equal(emitted[1]!.stage, 'trace.health');
  assert.equal(JSON.stringify(emitted).includes('private-session-id'), false);
  assert.deepEqual(Object.keys(emitted[1]!.health as object).sort(), [
    'currentBytes', 'dropped', 'emitted', 'retainedFiles', 'retentionMaxAgeMs',
    'retentionMaxFiles', 'rotations', 'sampled', 'unflushed', 'writeFailures',
  ]);
});

test('sink failures are swallowed and retain records for retry', async () => {
  const sink = new MemorySink(); sink.failAppend = true; const store = createStore(sink);
  store.record(event()); await store.flush();
  assert.equal(store.getHealth().writeFailures, 1); assert.equal(store.getHealth().unflushed, 1);
  sink.failAppend = false; await store.flush();
  assert.equal(store.getHealth().emitted, 1); assert.equal(store.getHealth().unflushed, 0);
});

test('size and age/file-count retention remain bounded', async () => {
  const sink = new MemorySink(); let now = 100;
  const store = createStore(sink, {
    wallClock: () => now,
    maxFileBytes: 1,
    maxRetainedFiles: 1,
    maxAgeMs: 50,
  });
  store.record(event('one')); await store.flush();
  now = 120; store.record(event('two')); await store.flush();
  now = 200; store.record(event('three')); await store.flush();
  assert.equal(store.getHealth().rotations, 2);
  assert.ok(store.getHealth().retainedFiles <= 1);
  assert.ok(sink.removed.length >= 1);
});
