import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { BackendServer } from '../server.js';
import { sessionMcpConfigPathFor } from '../../../session-storage/settings/mcp-session-config.js';
import { InitialContextEstimateClient } from '../../context-inventory/initial-context-estimate-client.js';
import { createSyntheticSourceTestSdkRuntime } from '../../test/fixtures/sdk-runtime-selection.js';

const runtime = createSyntheticSourceTestSdkRuntime(path.resolve('/sdk'));
const sourcePath = path.resolve('harness/agent-processes/coordinator/server.ts');
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// A bounded executable-source seam: exercise the actual startup prefix without
// importing a real SDK, opening stores/auth, or attaching process stdin. Full
// readiness is guarded structurally below, not claimed as an end-to-end test.
async function startupPrefix(dependencies: Record<string, unknown>, owner: object) {
  const source = await readFile(sourcePath, 'utf8');
  const start = source.indexOf('  async start(): Promise<void> {');
  const end = source.indexOf('    const sdkStartedAt = performance.now();', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start + '  async start(): Promise<void> {'.length, end)
    .replace('this.workerEntryPath!', 'this.workerEntryPath');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction(...Object.keys(dependencies), body).call(owner, ...Object.values(dependencies));
}

for (const rejects of [false, true]) {
  test(`inventory warm precedes later startup gate and is not awaited (rejects: ${rejects})`, async () => {
    const gate = deferred();
    const entered = deferred();
    const warm = deferred();
    const order: string[] = [];
    const owner: any = { sdkPath: runtime.descriptor.sdkPath, initialContextEstimateEntryPath: '/inventory.js' };
    const run = startupPrefix({
      installBackendFatalHandlers() {},
      verifySdkRuntimeSelection: async () => { order.push('validated'); return runtime; },
      sdkRuntimeSdkPath: () => runtime.descriptor.sdkPath,
      sessionMcpConfigPathFor,
      InitialContextEstimateClient: class {
        constructor(options: any) {
          assert.equal(options.sdkRuntime, runtime);
          assert.equal(options.sdkPath, runtime.descriptor.sdkPath);
          assert.equal(options.cwd, undefined);
          assert.equal(options.agentDir, undefined);
          order.push('constructed');
        }
        warm() {
          order.push('warm');
          return rejects ? Promise.reject(new Error('optional preload failed')) : warm.promise;
        }
      },
      WorkerSupervisor: class {
        constructor(options: any) {
          assert.equal(options.mcpConfigPathFor, sessionMcpConfigPathFor);
        }
        async initialize() { order.push('later-startup'); entered.resolve(); await gate.promise; }
      },
      backendWarn: () => { order.push('warning'); },
      toErrorMessage: (error: Error) => error.message,
    }, owner);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        entered.promise,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('later startup blocked by optional warm')), 2_000);
        }),
      ]);
      assert.deepEqual(order.slice(0, 4), ['validated', 'constructed', 'warm', 'later-startup']);
      gate.resolve();
      await run;
      if (rejects) assert.ok(order.includes('warning'));
      else assert.equal(order.includes('warning'), false, 'pending warm is not a readiness fence');
    } finally {
      clearTimeout(deadline);
      gate.resolve();
      warm.resolve();
      await run;
    }
  });
}

test('startup has one non-blocking warm and no inventory discovery before backend.ready', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const start = source.slice(source.indexOf('  async start(): Promise<void> {'), source.indexOf('  /** Opt-in packaged-artifact probe'));
  assert.equal((start.match(/initialContextEstimateClient.*\.warm\(/g) ?? []).length, 1);
  assert.match(start, /void this\.initialContextEstimateClient\.warm\(\)\.catch/);
  assert.doesNotMatch(start, /await[^\n]*initialContextEstimateClient|initialContextEstimateClient[^\n]*discover/);
  assert.ok(start.indexOf('initialContextEstimateClient.warm()') < start.indexOf('await this.workerSupervisor.initialize()'));
  assert.ok(start.indexOf('await this.workerSupervisor.initialize()') < start.indexOf("this.emit('backend.ready'"));
  const entry = await readFile(path.resolve('harness/agent-processes/coordinator/index.ts'), 'utf8');
  assert.match(entry, /await server\.start\(\)/);
  assert.match(entry, /catch \(error\) \{[\s\S]*await server\?\.dispose\(\)/, 'startup failure uses the existing disposal owner');
});

test('unfinished preload sends only initialize and remains owned by coordinator disposal', async () => {
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const child: any = new EventEmitter();
  Object.assign(child, {
    pid: 43210, exitCode: null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
  });
  child.stdio = [null, child.stdout, child.stderr, inbound, outbound];
  const initialized = deferred();
  const frames: any[] = [];
  outbound.on('data', (chunk) => { frames.push(JSON.parse(chunk.toString())); initialized.resolve(); });
  let terminated = 0;
  const client = new InitialContextEstimateClient({
    entryPath: '/inventory.js', sdkPath: runtime.descriptor.sdkPath, sdkRuntime: runtime,
    spawnProcess: (() => child) as any,
    establishGuardian: async () => undefined,
    terminateTree: async () => {
      terminated += 1;
      child.exitCode = 0;
      child.emit('exit', 0, null);
    },
  });
  const server: any = new BackendServer({ analyticsContext: { mode: 'canonical-only', generationId: 'test-capture', buildId: 'test-build', workspaceId: 'test-workspace', hostInstanceId: 'test-host' },
    sdkPath: runtime.descriptor.sdkPath, sourceArtifactDescriptor: runtime.descriptor,
    cwd: '/workspace', workerEntryPath: '/worker.js',
  });
  server.initialContextEstimateClient = client;
  const warming = client.warm();
  const rejected = assert.rejects(warming, /did not complete SDK preload|disposed/);
  try {
    await initialized.promise;
    assert.equal(frames.length, 1);
    assert.deepEqual(Object.keys(frames[0]).sort(), ['kind', 'parentPid', 'protocolVersion', 'sdkPath', 'sdkRuntime']);
    assert.equal(frames[0].kind, 'initialize');
    await server.dispose();
    await rejected;
    assert.equal(terminated, 1);
    assert.equal(server.initialContextEstimateClient, undefined);
    await client.warm();
    assert.equal(frames.length, 1, 'disposed client cannot replenish its spare');
  } finally {
    await server.dispose();
    await rejected;
  }
});
