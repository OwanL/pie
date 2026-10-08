import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough, Writable } from 'node:stream';
import { WorkerServer } from '../../lib/rpc/worker-server.js';
import type { WorkerIpcFrame } from '../../lib/rpc/worker-protocol.js';
import { WorkerRuntimeHost } from '../worker-runtime-host.js';
import { createSyntheticSourceTestSdkRuntime } from '../../test/fixtures/sdk-runtime-selection.js';

class BlockedTransport extends Writable {
  readonly frames: WorkerIpcFrame[] = [];
  readonly releases: Array<() => void> = [];
  constructor() { super({ highWaterMark: 1 }); }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.frames.push(JSON.parse(chunk.toString()));
    this.releases.push(() => callback());
  }
  drainFrames(): void { while (this.releases.length) this.releases.shift()!(); }
}

function fixture() {
  const writable = new BlockedTransport();
  const readable = new PassThrough();
  const exits: number[] = [];
  const server = new WorkerServer({
    coordinatorGeneration: 1, workerId: 'snapshot-worker', workerGeneration: 1,
    sessionPath: '/session.jsonl', rootSessionPath: '/session.jsonl',
    leasePath: '/session.jsonl', leaseRevision: 1, ipcReadFd: 3, ipcWriteFd: 4,
  }, { pid: 4242, exit: ((code?: number) => { exits.push(code ?? 0); }) as never }, { readable, writable });
  const host = new WorkerRuntimeHost({
    server, owner: { coordinatorGeneration: 1, workerId: 'snapshot-worker', workerGeneration: 1 },
    sdkRuntime: createSyntheticSourceTestSdkRuntime('/unused-sdk'),
  });
  const internals = host as unknown as { runtimeReady: boolean; emit(event: string, payload: unknown): void };
  // Explicitly model the HOT refresh state without promoting/loading any SDK.
  const setHot = () => { internals.runtimeReady = true; };
  const emit = (event: string, payload: unknown) => internals.emit(event, payload);
  server.sendFrame({ kind: 'runtime.event', event: 'busy.changed', payload: { busy: true, marker: 'active' } });
  return { writable, readable, exits, server, setHot, emit };
}

function snapshot(marker: string, extra: Record<string, unknown> = {}) {
  return {
    session: { path: '/session.jsonl', sessionId: 'session-1', name: 'Session', cwd: '/', messageCount: 1 },
    runtimeReady: true,
    transcript: [{ role: 'user', text: marker + 'x'.repeat(4.5 * 1024 * 1024) }],
    transcriptWindow: { totalCount: 1, loadedStart: 0, loadedEnd: 1, hasOlder: false, hasNewer: false, isPartial: false },
    ...extra,
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('real HOT host/server/writer coalesce full queued snapshots under inherited transport backpressure', async () => {
  const f = fixture();
  f.setHot();
  const latest = snapshot('latest');
  f.emit('session.opened', snapshot('old'));
  f.emit('busy.changed', { sessionPath: '/session.jsonl', busy: false, seq: 2 });
  f.emit('session.opened', latest);
  f.emit('agent.settled', { sessionPath: '/session.jsonl', marker: 'terminal' });
  assert.equal(f.writable.frames.length, 1, 'separate active frame blocks both large refreshes');
  f.writable.drainFrames();
  await tick();
  assert.deepEqual(f.writable.frames.map((frame) => [frame.kind === 'runtime.event' ? frame.event : frame.kind, frame.seq]), [
    ['busy.changed', 1], ['busy.changed', 2], ['session.opened', 3], ['agent.settled', 4],
  ]);
  const opened = f.writable.frames[2];
  assert.equal(opened.kind, 'runtime.event');
  if (opened.kind === 'runtime.event') assert.deepEqual(opened.payload, latest, 'latest whole snapshot is neither truncated nor projected');
  assert.deepEqual(f.exits, []);
  assert.equal(f.writable.writableEnded, false, 'no fatal worker close');
  f.readable.destroy();
  f.writable.destroy();
});

for (const protectedPublication of ['initial', 'selectionToken', 'operationId', 'replacesSessionPath'] as const) {
  test(`real host preserves ${protectedPublication} publication beside later HOT refreshes`, async () => {
    const f = fixture();
    if (protectedPublication !== 'initial') f.setHot();
    const extra = protectedPublication === 'initial' ? {} : { [protectedPublication]: 'correlation' };
    const required = { ...snapshot('required', extra), transcript: [{ role: 'user', text: 'required' }] };
    f.emit('session.opened', required);
    f.setHot();
    f.emit('session.opened', { ...required, ...Object.fromEntries(['selectionToken', 'operationId', 'replacesSessionPath'].map((key) => [key, undefined])), transcript: [{ text: 'old' }] });
    f.emit('busy.changed', { busy: false });
    const latest = { ...required, ...Object.fromEntries(['selectionToken', 'operationId', 'replacesSessionPath'].map((key) => [key, undefined])), transcript: [{ text: 'latest' }] };
    f.emit('session.opened', latest);
    f.writable.drainFrames();
    await tick();
    assert.deepEqual(f.writable.frames.map((frame) => frame.kind === 'runtime.event' ? frame.event : frame.kind),
      ['busy.changed', 'session.opened', 'busy.changed', 'session.opened']);
    const opened = f.writable.frames[1];
    if (opened.kind === 'runtime.event') assert.deepEqual(opened.payload, required);
    assert.deepEqual(f.exits, []);
    f.readable.destroy();
    f.writable.destroy();
  });
  test(`real host keeps ${protectedPublication} snapshot required and lifecycle saturation fatal`, async () => {
    const f = fixture();
    if (protectedPublication !== 'initial') f.setHot();
    const extra = protectedPublication === 'initial' ? {} : { [protectedPublication]: 'correlation' };
    const required = snapshot('required', extra);
    f.emit('session.opened', required);
    f.setHot();
    f.emit('busy.changed', { busy: false });
    f.emit('session.opened', snapshot('later'));
    f.writable.drainFrames();
    await tick();
    assert.ok(f.writable.frames.some((frame) => frame.kind === 'fatal'), 'second oversized nonreplaceable backlog still fails closed');
    // Existing fatal control-lane priority closes before queued lifecycle
    // snapshots drain; preserving that fail-closed behavior is intentional.
    assert.equal(f.writable.frames.filter((frame) => frame.kind === 'runtime.event' && frame.event === 'session.opened').length, 0);
    assert.deepEqual(f.writable.frames.map((frame) => frame.seq), f.writable.frames.map((_, index) => index + 1));
    await tick();
    assert.deepEqual(f.exits, [1]);
    f.readable.destroy();
    f.writable.destroy();
  });
}
