import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  InitialContextEstimateClient,
  type InitialContextEstimateTimingSample,
} from '../initial-context-estimate-client.js';
import { createSyntheticSourceTestSdkRuntime } from '../../test/fixtures/sdk-runtime-selection.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function createSyntheticWorker(onDiscovery: () => Promise<boolean>) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const child = new EventEmitter() as any;
  child.pid = 43_210;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdio = [null, stdout, stderr, inbound, outbound];
  child.kill = () => true;
  let pending = '';
  outbound.on('data', (chunk: Buffer | string) => {
    pending += chunk.toString();
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) return;
      const frame = JSON.parse(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      if (frame.kind === 'initialize') {
        inbound.write(`${JSON.stringify({ protocolVersion: 2, kind: 'ready' })}\n`);
      } else if (frame.kind === 'discover') {
        void onDiscovery().then((ok) => inbound.write(`${JSON.stringify(ok ? {
          protocolVersion: 2,
          kind: 'result',
          ok: true,
          inventory: { estimate: { tokens: 12, contextWindow: 100 }, systemPrompts: [] },
        } : { protocolVersion: 2, kind: 'result', ok: false, error: 'synthetic failure' })}\n`));
      }
    }
  });
  return child;
}

test('discovery timing separates FIFO wait from service and end-to-end request; timing hook failures are isolated', async (t) => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const firstResponse = deferred<void>();
  const firstDiscoveryStarted = deferred<void>();
  const timings: InitialContextEstimateTimingSample[] = [];
  let workerIndex = 0;
  const client = new InitialContextEstimateClient({
    entryPath: '/synthetic-worker.js',
    sdkPath: '/sdk',
    sdkRuntime: createSyntheticSourceTestSdkRuntime('/sdk'),
    spawnProcess: (() => {
      const index = workerIndex++;
      return createSyntheticWorker(() => {
        if (index === 0) {
          firstDiscoveryStarted.resolve();
          return firstResponse.promise.then(() => true);
        }
        clock += 10;
        return Promise.resolve(false);
      });
    }) as any,
    establishGuardian: async () => ({ terminate: async () => undefined }),
    onTiming: (sample) => {
      timings.push(sample);
      throw new Error('timing observers are non-authoritative');
    },
  });
  t.after(() => client.dispose());

  const input = { cwd: '/workspace', agentDir: '/agent', model: { provider: 'mock', id: 'model' } };
  const first = client.discover(input);
  await firstDiscoveryStarted.promise;
  clock = 10;
  const second = client.discover(input);
  clock = 60;
  firstResponse.resolve();
  assert.ok(await first);
  assert.equal(await second, undefined, 'a throwing timing observer cannot break discovery failure reporting');

  assert.equal(timings.length, 2);
  const [firstTiming, secondTiming] = timings;
  assert.equal(firstTiming.stage, 'discover');
  assert.equal(secondTiming.stage, 'discover');
  assert.equal(firstTiming.queueWaitDurationMs, 0);
  assert.equal(secondTiming.queueWaitDurationMs, 50, 'later discovery records its FIFO wait');
  assert.equal(secondTiming.totalDurationMs, 10, 'service time excludes the FIFO wait');
  assert.equal(secondTiming.requestDurationMs, 60, 'end-to-end request includes queue and service time');
  for (const timing of timings) {
    assert.equal(timing.requestDurationMs, timing.queueWaitDurationMs! + timing.totalDurationMs);
  }
});
