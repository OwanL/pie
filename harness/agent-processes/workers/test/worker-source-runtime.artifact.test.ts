import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { WorkerClient } from '../../lib/rpc/worker-client.js';
import type { WorkerJsonObject } from '../../lib/rpc/worker-protocol.js';

import {
  assertSdkRuntimeAgreement,
  parseSdkRuntimeSelection,
  verifySdkRuntimeSelection,
  type SdkRuntimeSelection,
} from '../../lib/sdk-integration/sdk-runtime-selection.js';
import { WorkerRuntimeHost, type WorkerRuntimePromotionPayload } from '../worker-runtime-host';
import { createSourceArtifactTestSdkRuntime } from '../../test/fixtures/sdk-runtime-selection.js';
import { sourceDescriptor } from '../../lib/sdk-integration/test/source-fixture.js';

const SOURCE_RUNTIME_CHILD = path.resolve('harness/agent-processes/workers/test/fixtures/source-runtime-child.ts');
const WORKER_ENTRY = path.resolve('harness/agent-processes/workers/worker-entry.ts');
const TSX_LOADER = path.resolve('application/hosts/vscode/node_modules/tsx/dist/loader.mjs');

let sourceRuntimePromise: ReturnType<typeof createSourceArtifactTestSdkRuntime> | undefined;
function sourceRuntime() {
  sourceRuntimePromise ??= createSourceArtifactTestSdkRuntime(sourceDescriptor.artifactDir);
  return sourceRuntimePromise;
}

function makePromotionPayload(
  sdkPath: string,
  sdkRuntime: SdkRuntimeSelection,
  root: string,
  workerId = 'source-runtime-worker',
  sessionPath = path.join(root, 'sessions', 'session.jsonl'),
): WorkerRuntimePromotionPayload {
  const cwd = path.join(root, 'workspace');
  const agentDir = path.join(root, 'agent');
  const sessionDir = path.dirname(sessionPath);
  return {
    sdkPath,
    sdkRuntime,
    agentDir,
    startupCwd: cwd,
    sessionDir,
    sessionPath,
    creationReason: 'resume',
    writeLease: {
      coordinatorGeneration: 41,
      workerId,
      workerGeneration: 1,
      canonicalSessionPath: sessionPath,
      ownershipRevision: 1,
      nonce: 'source-runtime-test-lease',
    },
    openedPayload: {
      session: { path: sessionPath, name: 'Source runtime fixture', cwd, modifiedAt: new Date(0).toISOString(), messageCount: 0 },
      transcript: [],
      transcriptWindow: {
        totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false,
        isPartial: false, hasUserMessages: false,
      },
      busy: false,
    },
    modelSettings: { defaultModel: '', defaultThinkingLevel: 'high' },
  };
}

function buildSanitizedWorkerEnv(root: string, preload?: string): NodeJS.ProcessEnv {
  const allowed = new Set([
    'path', 'systemroot', 'windir', 'comspec', 'pathext', 'lang', 'lc_all', 'tz',
  ]);
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())),
  );
  const home = path.join(root, 'home');
  const temp = path.join(root, 'tmp');
  const loaderOptions = `--import="${pathToFileURL(TSX_LOADER).href}"`;
  const requireOptions = preload ? ` --require="${preload.replace(/\\/g, '/')}"` : '';
  return {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    TMP: temp,
    TEMP: temp,
    TMPDIR: temp,
    PIE_DATA_DIR: path.join(root, 'pie-data'),
    PI_CODING_AGENT_DIR: path.join(root, 'agent'),
    PI_CODING_AGENT_AUTH_DIR: path.join(root, 'auth'),
    PI_CODING_AGENT_SESSION_DIR: path.join(root, 'sessions'),
    TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH,
    PIE_TEST_FORCE_OFFLINE: '1',
    PIE_TEST_WORKER_BOOTSTRAP_TIMING: process.env.PIE_TEST_WORKER_BOOTSTRAP_TIMING === '1' ? '1' : undefined,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    npm_config_offline: 'true',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '*',
    NODE_OPTIONS: `${loaderOptions}${requireOptions}`,
  };
}

function sanitizedSpawn(root: string, env: NodeJS.ProcessEnv): typeof childProcess.spawn {
  return ((command: string, args: readonly string[], options: childProcess.SpawnOptions) => (
    childProcess.spawn(command, args, { ...options, cwd: path.join(root, 'workspace'), env })
  )) as typeof childProcess.spawn;
}

async function runChild(
  executable: string,
  args: string[],
  options: childProcess.SpawnOptions,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = childProcess.spawn(executable, args, options);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Source SDK child exceeded ${timeoutMs}ms. stdout=${stdout.slice(-4_000)} stderr=${stderr.slice(-4_000)}`));
    }, timeoutMs);
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

interface WorkerBootstrapProbe {
  status: 'ready' | 'failed';
  failure?: string;
  stderr: string;
  spawnHrtimeNs?: string;
  bootstrapElapsedNs?: string;
}

async function probeWorkerBootstrap(
  root: string,
  sdkRuntime: SdkRuntimeSelection,
  env: NodeJS.ProcessEnv,
  workerEntryPath = WORKER_ENTRY,
): Promise<WorkerBootstrapProbe> {
  const sessionPath = path.join(root, 'sessions', 'ipc-probe.jsonl');
  const spawn = sanitizedSpawn(root, env);
  let spawnStartedNs: bigint | undefined;
  let bootstrapElapsedNs: string | undefined;
  const timing = () => env.PIE_TEST_WORKER_BOOTSTRAP_TIMING === '1' ? {
    spawnHrtimeNs: spawnStartedNs?.toString(),
    bootstrapElapsedNs,
  } : {};
  const client = new WorkerClient({
    workerEntryPath,
    coordinatorGeneration: 41,
    workerId: `ipc-probe-${sdkRuntime.kind}`,
    workerGeneration: 1,
    sessionPath,
    sdkRuntime,
    heartbeatIntervalMs: 500,
    missedHeartbeatMs: 5_000,
    env,
    spawn: ((command, args, options) => {
      spawnStartedNs = process.hrtime.bigint();
      return spawn(command, args, options);
    }) as typeof childProcess.spawn,
  });
  try {
    await client.start();
    bootstrapElapsedNs = spawnStartedNs === undefined ? undefined : (process.hrtime.bigint() - spawnStartedNs).toString();
  } catch (error) {
    await client.waitForConfirmedExit(5_000).catch(() => undefined);
    return {
      status: 'failed',
      failure: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      stderr: client.getSnapshot().stderrTail,
      ...timing(),
    };
  }

  try {
    assert.deepEqual(await client.ping(), { kind: 'pong' });
    assert.deepEqual(await client.shutdown('IPC bootstrap fixture complete'), { kind: 'shutting-down' });
    await client.waitForConfirmedExit(5_000);
    assert.equal(client.getSnapshot().status, 'exited', 'bootstrap-only worker shutdown confirms process exit');
    return { status: 'ready', stderr: client.getSnapshot().stderrTail, ...timing() };
  } finally {
    if (client.getSnapshot().status !== 'exited' && client.getSnapshot().pid) {
      await client.forceKill().catch(() => undefined);
      await client.waitForConfirmedExit(5_000).catch(() => undefined);
    }
  }
}

test('WorkerClient source bootstrap reaches the production inherited-fd boundary', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-worker-ipc-classification-'));
  try {
    await Promise.all([
      fs.mkdir(path.join(root, 'workspace'), { recursive: true }),
      fs.mkdir(path.join(root, 'sessions'), { recursive: true }),
      fs.mkdir(path.join(root, 'home'), { recursive: true }),
    ]);
    const env = buildSanitizedWorkerEnv(root);
    const { sdkRuntime } = await sourceRuntime();
    const sourceProbe = await probeWorkerBootstrap(root, sdkRuntime, env);
    t.diagnostic(JSON.stringify({
      boundary: 'WorkerClient stdio [ignore, pipe, pipe, pipe, pipe] -> WorkerServer.openWorkerServerTransport',
      source: sourceProbe,
    }, null, 2));
    assert.equal(sourceProbe.status, 'ready', `Source bootstrap failed: ${sourceProbe.failure}\n${sourceProbe.stderr}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('production bundler emits an actual-source root worker entry with a lazy host chunk', { timeout: 180_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-worker-entry-bundle-'));
  try {
    const selected = await sourceRuntime();
    const output = path.join(root, 'bundle');
    const wrapper = path.join(root, 'build.cjs');
    await fs.writeFile(wrapper, `
      const { pathToFileURL } = require('node:url');
      (async () => {
        const vite = await import(pathToFileURL(${JSON.stringify(path.resolve('application/hosts/vscode/node_modules/vite/dist/node/index.js'))}).href);
        const config = require(${JSON.stringify(path.resolve('application/hosts/vscode/vite.config.ts'))}).default({ mode: 'node' });
        // Root-entry acceptance only; build identity scanning is unrelated.
        config.plugins = [];
        config.build.rollupOptions.input = { 'worker-entry': ${JSON.stringify(WORKER_ENTRY)} };
        config.build.outDir = ${JSON.stringify(output)};
        config.cacheDir = ${JSON.stringify(path.join(root, 'cache'))};
        await vite.build({ ...config, configFile: false, logLevel: 'error' });
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `);
    const env = buildSanitizedWorkerEnv(root);
    await Promise.all(['workspace', 'home', 'tmp', 'sessions'].map(dir => fs.mkdir(path.join(root, dir), { recursive: true })));
    const built = await runChild(process.execPath, [wrapper], {
      cwd: path.resolve('.'),
      env: { ...env, PIE_BUILD_PI_RUNTIME_SDK_PATH: selected.sdkPath, PIE_BUILD_OUTPUT_DIR: output },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    }, 120_000);
    assert.equal(built.code, 0, `actual-source worker bundle failed:\n${built.stderr}`);
    const files = await fs.readdir(output);
    assert.ok(files.some(file => /^worker-runtime-host-.*\.js$/.test(file)), 'promotion host is an emitted lazy chunk');
    const entry = path.join(output, 'worker-entry.js');
    const code = await fs.readFile(entry, 'utf8');
    assert.ok(!code.includes("require('./worker-runtime-host')"), 'no unbundled source-relative host require');
    const probe = await probeWorkerBootstrap(root, selected.sdkRuntime, env, entry);
    assert.equal(probe.status, 'ready', `built worker bootstrap failed: ${probe.failure}\n${probe.stderr}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('source runtime rejects tampered, missing, mixed, unknown, and mismatched promotion selections before loading', async () => {
  const selected = await sourceRuntime();
  const { sdkPath, sdkRuntime } = selected;

  const tampered = structuredClone(sdkRuntime) as Extract<SdkRuntimeSelection, { kind: 'source-artifact' }>;
  tampered.descriptor.identity = '0'.repeat(64);
  await assert.rejects(verifySdkRuntimeSelection(sdkPath, tampered), /identity does not match the verified artifact/);

  const missing = structuredClone(sdkRuntime) as Record<string, any>;
  delete missing.descriptor.cliPath;
  assert.throws(() => parseSdkRuntimeSelection(missing), /descriptor is invalid/);

  const mixed = { ...structuredClone(sdkRuntime), patchIdentity: {} };
  assert.throws(() => parseSdkRuntimeSelection(mixed), /unsupported fields/);

  const unknown = { ...structuredClone(sdkRuntime), kind: 'unknown-runtime' };
  assert.throws(() => parseSdkRuntimeSelection(unknown), /kind must be source-artifact/);

  const mismatched = structuredClone(sdkRuntime) as Extract<SdkRuntimeSelection, { kind: 'source-artifact' }>;
  mismatched.descriptor.sdkPath = path.join(os.tmpdir(), 'not-the-selected-sdk');
  assert.throws(() => assertSdkRuntimeAgreement(sdkPath, sdkRuntime, mismatched), /does not match initialization/);

  const host = new WorkerRuntimeHost({
    server: {
      sendFrame: () => true,
      sendLiveSemanticFrame: () => true,
      sendDetailFrame: () => true,
      onDetailDrain: () => () => undefined,
      failRuntime: () => undefined,
    } as never,
    owner: { coordinatorGeneration: 41, workerId: 'source-runtime-worker', workerGeneration: 1 },
    sdkRuntime,
  });
  await assert.rejects(
    host.promote(makePromotionPayload(sdkPath, mismatched, os.tmpdir())),
    /SDK runtime selection does not match initialization/,
  );
});

test('WorkerClient bootstraps and promotes the read-only source artifact through production worker entry offline', { timeout: 180_000 }, async (t) => {
  const selected = await sourceRuntime();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-worker-source-runtime-'));
  const cwd = path.join(root, 'workspace');
  const agentDir = path.join(root, 'agent');
  const sessionDir = path.join(root, 'sessions');
  const preload = path.join(root, 'force-offline.cjs');
  const inputPath = path.join(root, 'source-runtime-input.json');
  let client: WorkerClient | undefined;

  try {
    await Promise.all([
      fs.mkdir(cwd, { recursive: true }),
      fs.mkdir(agentDir, { recursive: true }),
      fs.mkdir(path.join(root, 'home'), { recursive: true }),
      fs.mkdir(path.join(root, 'pie-data'), { recursive: true }),
      fs.mkdir(path.join(root, 'auth'), { recursive: true }),
      fs.mkdir(path.join(root, 'tmp'), { recursive: true }),
      fs.mkdir(sessionDir, { recursive: true }),
    ]);
    await fs.writeFile(preload, [
      "const blocked = (name) => function blockedNetwork() { throw Object.assign(new Error('offline source fixture blocked ' + name), { code: 'PIE_TEST_OFFLINE' }); };",
      "globalThis.fetch = () => Promise.reject(Object.assign(new Error('offline source fixture blocked fetch'), { code: 'PIE_TEST_OFFLINE' }));",
      "const http = require('node:http'); http.request = blocked('http'); http.get = blocked('http');",
      "const https = require('node:https'); https.request = blocked('https'); https.get = blocked('https');",
      '',
    ].join('\n'), 'utf8');
    await fs.writeFile(inputPath, JSON.stringify({
      sdkRuntime: selected.sdkRuntime,
      cwd,
      agentDir,
      sessionDir,
      prepareOnly: true,
    }), 'utf8');

    const env = buildSanitizedWorkerEnv(root, preload);
    const prepared = await runChild(process.execPath, [SOURCE_RUNTIME_CHILD, inputPath], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }, 120_000);
    assert.equal(prepared.code, 0, `isolated source SDK session preparation failed:\n${prepared.stderr}\n${prepared.stdout}`);
    const sessionResult = prepared.stdout.split(/\r?\n/).map((line) => {
      try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
    }).find((line) => line?.kind === 'source-runtime-session-ready');
    assert.ok(sessionResult, `source SDK did not publish its isolated session path:\n${prepared.stderr}\n${prepared.stdout}`);
    assert.equal(sessionResult.sdkVersion, '0.80.6');
    assert.equal(typeof sessionResult.sessionPath, 'string');
    const sessionPath = await fs.realpath(sessionResult.sessionPath as string);
    const canonicalSessionDir = await fs.realpath(sessionDir);
    const relativeSessionPath = path.relative(canonicalSessionDir, sessionPath);
    assert.ok(relativeSessionPath !== '..' && !relativeSessionPath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeSessionPath),
      `source session path escaped its temp directory: ${sessionPath}`);
    assert.equal(await fs.stat(sessionPath).then((stat) => stat.isFile()), true);

    const workerId = 'source-runtime-worker';
    const runtimeEvents: string[] = [];
    client = new WorkerClient({
      workerEntryPath: WORKER_ENTRY,
      coordinatorGeneration: 41,
      workerId,
      workerGeneration: 1,
      sessionPath,
      rootSessionPath: sessionPath,
      leasePath: sessionPath,
      leaseRevision: 1,
      sdkRuntime: selected.sdkRuntime,
      heartbeatIntervalMs: 500,
      missedHeartbeatMs: 15_000,
      requestTimeoutMs: 60_000,
      env,
      spawn: sanitizedSpawn(root, env),
      onFrame: (frame) => {
        if (frame.kind === 'runtime.event' && frame.event === 'session.opened') runtimeEvents.push(frame.event);
      },
    });

    try {
      await client.start();
    } catch (error) {
      await client.waitForConfirmedExit(5_000).catch(() => undefined);
      const snapshot = client.getSnapshot();
      t.diagnostic(`source worker bootstrap stopped before promotion: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n${snapshot.stderrTail}`);
      throw error;
    }

    if (env.PIE_TEST_WORKER_BOOTSTRAP_TIMING === '1') {
      t.diagnostic(`source worker bootstrap startup stderr:\n${client.getSnapshot().stderrTail}`);
    }
    const promotion = makePromotionPayload(selected.sdkPath, selected.sdkRuntime, root, workerId, sessionPath);
    const promoted = await client.requestFrame({
      kind: 'runtime.promote',
      operationId: 'source-runtime-promotion',
      payload: promotion as unknown as WorkerJsonObject,
    }, 'runtime.ready');
    assert.equal(promoted.kind, 'runtime.ready');
    assert.ok(runtimeEvents.includes('session.opened'), 'production worker entry emitted the promoted session.opened event');

    const command = await client.requestFrame({
      kind: 'runtime.command',
      operation: 'models.list',
      payload: { params: { sessionPath }, publicRequestId: 'source-runtime-model-list' },
    }, 'response');
    assert.equal(command.kind, 'response');
    assert.equal(command.ok, true, `production worker models.list failed: ${command.ok ? '' : command.error.message}`);
    if (command.ok) assert.equal(command.result.kind, 'runtime.command');
    assert.deepEqual(await client.shutdown('source runtime fixture complete'), { kind: 'shutting-down' });
    await client.waitForConfirmedExit(10_000);
    assert.equal(client.getSnapshot().status, 'exited', 'promoted worker disposal confirms process exit');
    assert.equal(await fs.stat(sessionPath).then((stat) => stat.isFile()), true);
  } finally {
    if (client && client.getSnapshot().status !== 'exited' && client.getSnapshot().pid) {
      await client.forceKill().catch(() => undefined);
      await client.waitForConfirmedExit(5_000).catch(() => undefined);
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
