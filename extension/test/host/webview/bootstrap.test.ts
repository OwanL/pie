import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

type Identity = { publisher: string; name: string; version: string };
type RuntimeGeneration = { generation: string | null; outDir: string; publishedAt: number };
type PublishedGeneration = { generation: string; outDir: string; publishedAt: number };
type RuntimeLease = RuntimeGeneration & { release(): Promise<void> };
type RuntimeOptions = { extensionDir: string; identity: Identity };
type RuntimeApi = {
  publishRuntimeGeneration(options: {
    sourceOutDir: string;
    extensionDir: string;
    identity: Identity;
  }): Promise<PublishedGeneration>;
  resolveRuntimeGeneration(options: RuntimeOptions): Promise<RuntimeGeneration>;
  acquireRuntimeGeneration(options: RuntimeOptions): Promise<RuntimeLease>;
};
type BootstrapFactory = (overrides?: Record<string, unknown>) => {
  activate(context: Record<string, unknown>): Promise<unknown>;
  deactivate(): Promise<void>;
};

const require = createRequire(import.meta.url);
const runtime = require('../../../runtime/runtime-generations.cjs') as RuntimeApi;
const bootstrapModule = require('../../../runtime/bootstrap.cjs') as {
  createBootstrap: BootstrapFactory;
  LAST_LOADED_MARKER_KEY: string;
  UPDATED_PROGRESS_TITLE: string;
  PENDING_STATUS_TEXT: string;
  PENDING_STATUS_TOOLTIP: string;
};
const IDENTITY: Identity = { publisher: 'pie', name: 'pie', version: '0.3.0' };
const BUILD_ID = '0123456789abcdef0123';

async function createRuntimeSource(root: string, name: string, extensionContents: string): Promise<string> {
  const source = path.join(root, `source-${name}`);
  const renderer = path.join(source, 'webview', 'panel');
  await mkdir(path.join(renderer, '.vite'), { recursive: true });
  await mkdir(path.join(renderer, 'assets'), { recursive: true });
  await Promise.all([
    writeFile(path.join(source, 'extension.js'), extensionContents),
    writeFile(path.join(source, 'backend.js'), `backend-${name}`),
    writeFile(path.join(source, 'worker-entry.js'), `worker-${name}`),
    writeFile(path.join(source, 'pie-build-id.txt'), `${BUILD_ID}\n`),
    writeFile(path.join(renderer, 'pie-build-id.txt'), `${BUILD_ID}\n`),
    writeFile(path.join(renderer, `assets/panel-${name}.js`), `export const panel = '${name}';`),
    writeFile(path.join(renderer, '.vite', 'manifest.json'), JSON.stringify({
      'panel.tsx': { file: `assets/panel-${name}.js`, isEntry: true },
    })),
  ]);
  return source;
}

function noOpWatch(_directory: string, _listener: () => void) {
  return {
    on() { return this; },
    close() {},
  };
}

function makeContext(extensionPath: string, values: Map<string, unknown>) {
  return {
    extensionPath,
    globalState: {
      get(key: string) {
        return values.get(key);
      },
      async update(key: string, value: unknown) {
        values.set(key, value);
      },
    },
    subscriptions: [],
  } as unknown as Record<string, unknown>;
}

async function withTempRoot<T>(callback: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-bootstrap-'));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
    delete (globalThis as typeof globalThis & { __pieBootstrapEvents?: string[] }).__pieBootstrapEvents;
  }
}

test('acquires before requiring runtime code, reports updates, and releases after delegate deactivate', { timeout: 15_000 }, async () => withTempRoot(async (root) => {
  const extensionDir = path.join(root, 'extension');
  await mkdir(extensionDir, { recursive: true });
  await writeFile(path.join(extensionDir, 'package.json'), `${JSON.stringify(IDENTITY)}\n`);
  const events: string[] = [];
  (globalThis as typeof globalThis & { __pieBootstrapEvents?: string[] }).__pieBootstrapEvents = events;
  const extensionContents = `module.exports = {
    async activate(_context, metadata) {
      globalThis.__pieBootstrapEvents.push('delegate-activate:' + metadata.generation);
      return { async deactivate() { globalThis.__pieBootstrapEvents.push('delegate-deactivate'); } };
    }
  };`;
  const sourceA = await createRuntimeSource(root, 'a', extensionContents);
  const first = await runtime.publishRuntimeGeneration({ sourceOutDir: sourceA, extensionDir, identity: IDENTITY });

  const stateValues = new Map<string, unknown>();
  const progressOptions: Array<Record<string, unknown>> = [];
  const reports: Array<Record<string, unknown>> = [];
  const statusItems: Array<Record<string, unknown> & { show(): void; hide(): void; dispose(): void }> = [];
  let watcherCallback: (() => void) | undefined;
  let watcherClosed = false;
  let onStatusShown!: () => void;
  const statusShown = new Promise<void>((resolve) => { onStatusShown = resolve; });
  const vscode = {
    ProgressLocation: { Window: 7 },
    StatusBarAlignment: { Right: 2 },
    window: {
      async withProgress(options: Record<string, unknown>, task: (progress: { report(value: Record<string, unknown>): void }) => Promise<unknown>) {
        progressOptions.push(options);
        return task({ report: (value) => reports.push(value) });
      },
      createStatusBarItem() {
        const item = {
          text: '',
          tooltip: '',
          command: undefined as unknown,
          show() { events.push('status-show'); onStatusShown(); },
          hide() { events.push('status-hide'); },
          dispose() { events.push('status-dispose'); },
        } as Record<string, unknown> & { show(): void; hide(): void; dispose(): void };
        statusItems.push(item);
        return item;
      },
    },
  };
  const injectedRuntime = {
    publishRuntimeGeneration: runtime.publishRuntimeGeneration,
    resolveRuntimeGeneration: runtime.resolveRuntimeGeneration,
    async acquireRuntimeGeneration(options: RuntimeOptions) {
      events.push('acquire');
      const lease = await runtime.acquireRuntimeGeneration(options);
      return {
        ...lease,
        async release() {
          events.push('release');
          await lease.release();
        },
      };
    },
  };
  const bootstrap = bootstrapModule.createBootstrap({
    vscode,
    runtimeGenerations: injectedRuntime,
    requireModule(modulePath: string) {
      events.push(`require:${path.basename(path.dirname(modulePath))}`);
      return require(modulePath);
    },
    watch(_directory: string, listener: () => void) {
      watcherCallback = listener;
      return {
        on() { return this; },
        close() { watcherClosed = true; },
      };
    },
  });
  const context = makeContext(extensionDir, stateValues);

  const activationResult = await bootstrap.activate(context);
  assert.equal(typeof (activationResult as { deactivate?: unknown }).deactivate, 'function');
  assert.deepEqual(progressOptions[0], {
    location: 7,
    title: bootstrapModule.UPDATED_PROGRESS_TITLE,
    cancellable: false,
  });
  assert.deepEqual(reports, [{ message: bootstrapModule.UPDATED_PROGRESS_TITLE }]);
  assert.equal(events[0], 'acquire');
  assert.match(events[1]!, /^require:/u);
  assert.ok(events.some((event) => event === `delegate-activate:${first.generation}`));
  assert.deepEqual(stateValues.get(bootstrapModule.LAST_LOADED_MARKER_KEY), {
    generation: first.generation,
    publishedAt: first.publishedAt,
  });

  const sourceB = await createRuntimeSource(root, 'b', extensionContents);
  const second = await runtime.publishRuntimeGeneration({ sourceOutDir: sourceB, extensionDir, identity: IDENTITY });
  assert.notEqual(second.generation, first.generation);
  watcherCallback?.();
  await statusShown;
  assert.equal(statusItems.length, 1);
  assert.equal(statusItems[0]?.text, bootstrapModule.PENDING_STATUS_TEXT);
  assert.equal(statusItems[0]?.tooltip, bootstrapModule.PENDING_STATUS_TOOLTIP);
  assert.equal(statusItems[0]?.command, undefined, 'the pending indicator must not offer an interrupting command');

  await bootstrap.deactivate();
  assert.ok(events.indexOf('delegate-deactivate') < events.indexOf('release'));
  assert.equal(watcherClosed, true);
  assert.ok(events.includes('status-dispose'));
  assert.deepEqual(await readdir(path.join(extensionDir, 'pie-runtime', 'leases')), []);
}));

test('does not activate a fallback after a selected candidate fails during activation', async () => withTempRoot(async (root) => {
  const extensionDir = path.join(root, 'extension');
  await mkdir(extensionDir, { recursive: true });
  await writeFile(path.join(extensionDir, 'package.json'), `${JSON.stringify(IDENTITY)}\n`);
  const good = await createRuntimeSource(root, 'good', `module.exports = { activate() { return { deactivate() {} }; } };`);
  const first = await runtime.publishRuntimeGeneration({ sourceOutDir: good, extensionDir, identity: IDENTITY });
  const broken = await createRuntimeSource(root, 'broken', `module.exports = { activate() { throw new Error('selected candidate failed'); } };`);
  const second = await runtime.publishRuntimeGeneration({ sourceOutDir: broken, extensionDir, identity: IDENTITY });
  const events: string[] = [];
  const bootstrap = bootstrapModule.createBootstrap({
    vscode: { window: {} },
    runtimeGenerations: runtime,
    watch: noOpWatch,
    requireModule(modulePath: string) {
      events.push(modulePath);
      return require(modulePath);
    },
  });
  await assert.rejects(
    bootstrap.activate(makeContext(extensionDir, new Map())),
    /selected candidate failed/u,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0], path.join(extensionDir, 'pie-runtime', 'generations', second.generation, 'out', 'extension.js'));
  assert.notEqual(events[0], path.join(extensionDir, 'pie-runtime', 'generations', first.generation, 'out', 'extension.js'));
  assert.equal((await readdir(path.join(extensionDir, 'pie-runtime', 'leases'))).length, 1, 'a failed activation without cleanup retains its lease');
}));

test('uses the loaded module deactivate hook when activation fails', async () => withTempRoot(async (root) => {
  const extensionDir = path.join(root, 'extension');
  await mkdir(extensionDir, { recursive: true });
  await writeFile(path.join(extensionDir, 'package.json'), `${JSON.stringify(IDENTITY)}\n`);
  const events: string[] = [];
  (globalThis as typeof globalThis & { __pieBootstrapEvents?: string[] }).__pieBootstrapEvents = events;
  const source = await createRuntimeSource(root, 'module-cleanup', `module.exports = {
    activate() {
      globalThis.__pieBootstrapEvents.push('activate');
      throw new Error('activation failed after startup');
    },
    deactivate() {
      globalThis.__pieBootstrapEvents.push('module-deactivate');
    },
  };`);
  await runtime.publishRuntimeGeneration({ sourceOutDir: source, extensionDir, identity: IDENTITY });
  const bootstrap = bootstrapModule.createBootstrap({ vscode: { window: {} }, runtimeGenerations: runtime, watch: noOpWatch });

  await assert.rejects(bootstrap.activate(makeContext(extensionDir, new Map())), /activation failed after startup/u);
  assert.deepEqual(events, ['activate', 'module-deactivate']);
  assert.deepEqual(await readdir(path.join(extensionDir, 'pie-runtime', 'leases')), []);
}));

test('retains a lease when activation cleanup fails', async () => withTempRoot(async (root) => {
  const extensionDir = path.join(root, 'extension');
  await mkdir(extensionDir, { recursive: true });
  await writeFile(path.join(extensionDir, 'package.json'), `${JSON.stringify(IDENTITY)}\n`);
  const source = await createRuntimeSource(root, 'activation-cleanup-fails', `module.exports = {
    activate() { throw new Error('startup failed'); },
    deactivate() { throw new Error('cleanup failed'); },
  };`);
  await runtime.publishRuntimeGeneration({ sourceOutDir: source, extensionDir, identity: IDENTITY });
  const bootstrap = bootstrapModule.createBootstrap({ vscode: { window: {} }, runtimeGenerations: runtime, watch: noOpWatch });

  await assert.rejects(bootstrap.activate(makeContext(extensionDir, new Map())), /activation cleanup failed/u);
  assert.equal((await readdir(path.join(extensionDir, 'pie-runtime', 'leases'))).length, 1);
}));

test('does not release a lease when normal delegated deactivation fails', async () => withTempRoot(async (root) => {
  const extensionDir = path.join(root, 'extension');
  await mkdir(extensionDir, { recursive: true });
  await writeFile(path.join(extensionDir, 'package.json'), `${JSON.stringify(IDENTITY)}\n`);
  const source = await createRuntimeSource(root, 'deactivate-fails', `module.exports = {
    activate() {},
    deactivate() { throw new Error('shutdown failed'); },
  };`);
  await runtime.publishRuntimeGeneration({ sourceOutDir: source, extensionDir, identity: IDENTITY });
  const bootstrap = bootstrapModule.createBootstrap({ vscode: { window: {} }, runtimeGenerations: runtime, watch: noOpWatch });
  await bootstrap.activate(makeContext(extensionDir, new Map()));

  await assert.rejects(bootstrap.deactivate(), /shutdown failed/u);
  assert.equal((await readdir(path.join(extensionDir, 'pie-runtime', 'leases'))).length, 1);
}));

test('treats the global-state loaded marker as best effort after successful activation', async () => withTempRoot(async (root) => {
  const extensionDir = path.join(root, 'extension');
  await mkdir(extensionDir, { recursive: true });
  await writeFile(path.join(extensionDir, 'package.json'), `${JSON.stringify(IDENTITY)}\n`);
  const events: string[] = [];
  (globalThis as typeof globalThis & { __pieBootstrapEvents?: string[] }).__pieBootstrapEvents = events;
  const source = await createRuntimeSource(root, 'marker-fails', `module.exports = {
    activate() {
      globalThis.__pieBootstrapEvents.push('activate');
    },
    deactivate() {
      globalThis.__pieBootstrapEvents.push('deactivate');
    },
  };`);
  await runtime.publishRuntimeGeneration({ sourceOutDir: source, extensionDir, identity: IDENTITY });
  const bootstrap = bootstrapModule.createBootstrap({ vscode: { window: {} }, runtimeGenerations: runtime, watch: noOpWatch });
  const context = makeContext(extensionDir, new Map());
  (context as { globalState: { update(): Promise<void> } }).globalState.update = async () => {
    throw new Error('global state unavailable');
  };

  await bootstrap.activate(context);
  assert.deepEqual(events, ['activate']);
  assert.equal((await readdir(path.join(extensionDir, 'pie-runtime', 'leases'))).length, 1);
  await bootstrap.deactivate();
  assert.deepEqual(events, ['activate', 'deactivate']);
  assert.deepEqual(await readdir(path.join(extensionDir, 'pie-runtime', 'leases')), []);
}));

test('keeps an active generation and its worker usable through multiple publications and a fresh bootstrap', async () => withTempRoot(async (root) => {
  const extensionDir = path.join(root, 'extension');
  await mkdir(extensionDir, { recursive: true });
  await writeFile(path.join(extensionDir, 'package.json'), `${JSON.stringify(IDENTITY)}\n`);
  const workerExtension = `const { fork } = require('node:child_process');
const path = require('node:path');
module.exports = {
  async activate(_context, metadata) {
    const children = [];
    async function spawnWorker() {
      const child = fork(path.join(metadata.runtimeOutDir, 'worker-entry.js'), [metadata.generation], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      children.push(child);
      await new Promise((resolve, reject) => {
        const onMessage = (generation) => {
          child.removeListener('error', onError);
          globalThis.__pieWorkerGenerations.push(generation);
          resolve();
        };
        const onError = (error) => {
          child.removeListener('message', onMessage);
          reject(error);
        };
        child.once('message', onMessage);
        child.once('error', onError);
      });
    }
    await spawnWorker();
    return {
      spawnWorker,
      async deactivate() {
        await Promise.all(children.map((child) => new Promise((resolve) => {
          if (child.exitCode !== null) {
            resolve();
            return;
          }
          child.once('exit', resolve);
          child.kill();
        })));
      },
    };
  },
};`;
  const workerContents = `if (process.send) process.send(process.argv[2]);\nsetInterval(() => {}, 60_000);\n`;
  const sourceA = await createRuntimeSource(root, 'worker-a', workerExtension);
  await writeFile(path.join(sourceA, 'worker-entry.js'), workerContents);
  const first = await runtime.publishRuntimeGeneration({ sourceOutDir: sourceA, extensionDir, identity: IDENTITY });
  const stateValues = new Map<string, unknown>();
  const workerGenerations: string[] = [];
  (globalThis as typeof globalThis & { __pieWorkerGenerations?: string[] }).__pieWorkerGenerations = workerGenerations;
  const oldBootstrap = bootstrapModule.createBootstrap({ vscode: { window: {} }, runtimeGenerations: runtime, watch: noOpWatch });
  const oldActivation = await oldBootstrap.activate(makeContext(extensionDir, stateValues)) as { spawnWorker(): Promise<void> };
  assert.deepEqual(workerGenerations, [first.generation]);

  const publications = [];
  for (const name of ['worker-b', 'worker-c', 'worker-d']) {
    const source = await createRuntimeSource(root, name, workerExtension);
    await writeFile(path.join(source, 'worker-entry.js'), workerContents);
    publications.push(await runtime.publishRuntimeGeneration({ sourceOutDir: source, extensionDir, identity: IDENTITY }));
  }
  await oldActivation.spawnWorker();
  assert.deepEqual(workerGenerations, [first.generation, first.generation], 'the active old generation can spawn its worker after three publications');
  await stat(path.join(first.outDir, 'worker-entry.js'));

  await oldBootstrap.deactivate();
  await assert.rejects(stat(path.join(first.outDir, 'worker-entry.js')), /ENOENT/u);

  const freshBootstrap = bootstrapModule.createBootstrap({ vscode: { window: {} }, runtimeGenerations: runtime, watch: noOpWatch });
  await freshBootstrap.activate(makeContext(extensionDir, stateValues));
  assert.equal(workerGenerations.at(-1), publications.at(-1)?.generation, 'a fresh bootstrap loads the newest selected runtime');
  await freshBootstrap.deactivate();
  assert.deepEqual(await readdir(path.join(extensionDir, 'pie-runtime', 'leases')), []);
}));
