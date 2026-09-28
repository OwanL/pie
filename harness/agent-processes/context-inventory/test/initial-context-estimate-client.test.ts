import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  buildInitialContextInventoryEnv,
  InitialContextEstimateClient,
  type InitialContextEstimateTimingSample,
} from '../initial-context-estimate-client.js';
import { ensureSdkPatchBarrier } from '../../lib/sdk-integration/sdk-patch-barrier.js';

function createRespondingChild(
  systemPromptText = 'Complete prompt text.',
  workerTimings?: Record<string, number>,
  options: { failPreload?: boolean } = {},
): any {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outbound = new PassThrough();
  const inbound = new PassThrough();
  const child = new EventEmitter() as any;
  child.pid = 43_210;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdio = [null, stdout, stderr, inbound, outbound];
  child.kill = () => true;
  child.frames = [];
  let pending = '';
  outbound.on('data', (chunk: Buffer | string) => {
    pending += chunk.toString();
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const frame = JSON.parse(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      child.frames.push(frame);
      if (frame.kind === 'initialize') {
        if (options.failPreload) {
          inbound.end(`${JSON.stringify({ protocolVersion: 1, kind: 'result', ok: false, error: 'preload failed' })}\n`);
        } else {
          inbound.write(`${JSON.stringify({ protocolVersion: 1, kind: 'ready', timings: { sdkImportDurationMs: 45 } })}\n`);
        }
      } else if (frame.kind === 'discover') {
        inbound.end(`${JSON.stringify({
          protocolVersion: 1,
          kind: 'result',
          ok: true,
          inventory: {
            estimate: { tokens: 12_345, contextWindow: 200_000 },
            systemPrompts: [{
              source: 'harness', id: 'harness', title: 'Harness system prompt',
              text: systemPromptText, summary: 'Complete prompt text.', availability: 'available',
            }],
          },
          ...(workerTimings ? { timings: workerTimings } : {}),
        })}\n`);
      }
    }
  });
  return child;
}

test('inventory child environment forces Pi, npm, yarn, and telemetry offline', () => {
  const env = buildInitialContextInventoryEnv({
    KEEP_ME: 'yes',
    pi_offline: '0',
    NPM_CONFIG_OFFLINE: 'false',
    yarn_enable_network: '1',
  });

  assert.equal(env.KEEP_ME, 'yes');
  assert.equal(env.PI_OFFLINE, '1');
  assert.equal(env.PI_SKIP_VERSION_CHECK, '1');
  assert.equal(env.PI_TELEMETRY, '0');
  assert.equal(env.npm_config_offline, 'true');
  assert.equal(env.npm_config_update_notifier, 'false');
  assert.equal(env.YARN_OFFLINE, '1');
  assert.equal(env.YARN_ENABLE_NETWORK, '0');
  assert.equal(env.YARN_ENABLE_TELEMETRY, '0');
  assert.equal(env.COREPACK_ENABLE_NETWORK, '0');
  assert.equal(env.COREPACK_ENABLE_DOWNLOAD_PROMPT, '0');
  assert.equal(env.pi_offline, undefined, 'case-insensitive inherited conflicts are removed');
  assert.equal(env.NPM_CONFIG_OFFLINE, undefined, 'npm cannot inherit a conflicting online setting');
});

test('inventory IPC preserves complete prompt text beyond the former 256 KiB estimate-only frame', async () => {
  const fullText = 'prompt-body\n'.repeat(30_000);
  const timings: InitialContextEstimateTimingSample[] = [];
  const client = new InitialContextEstimateClient({
    entryPath: '/inventory-worker.js',
    sdkPath: '/sdk',
    sdkPatchIdentity: {} as any,
    spawnProcess: (() => createRespondingChild(fullText, {
      sdkImportDurationMs: 45,
      resourceDiscoveryDurationMs: 125,
      promptAndEstimateDurationMs: 20,
    })) as any,
    establishGuardian: async () => ({ terminate: async () => undefined }),
    onTiming: (sample) => timings.push(sample),
  });

  const discovered = await client.discover({
    cwd: '/workspace', agentDir: '/agent', model: { provider: 'mock', id: 'model-a' },
  });

  assert.equal(discovered?.systemPrompts[0]?.text, fullText);
  assert.equal(timings.length, 1, 'one bounded timing record covers discovery');
  const [timing] = timings;
  assert.equal(timing.stage, 'discover');
  assert.equal(timing.outcome, 'success');
  assert.equal(timing.sdkImportDurationMs, 45);
  assert.equal(timing.resourceDiscoveryDurationMs, 125);
  assert.equal(timing.promptAndEstimateDurationMs, 20);
  assert.ok(timing.spawnDurationMs !== undefined && timing.spawnDurationMs >= 0);
  assert.ok(timing.guardianDurationMs !== undefined && timing.guardianDurationMs >= 0
    && timing.guardianDurationMs <= 10_000);
  assert.ok(timing.responseDurationMs !== undefined && timing.responseDurationMs >= 0
    && timing.responseDurationMs < 30_000);
  assert.equal(timing.prewarmed, false);
  assert.equal(timing.preloadDurationMs, 45);
  assert.ok(timing.totalDurationMs >= (timing.responseDurationMs ?? 0));
  assert.deepEqual(Object.keys(timing).sort(), [
    'guardianDurationMs', 'outcome', 'preloadDurationMs', 'prewarmed', 'promptAndEstimateDurationMs',
    'resourceDiscoveryDurationMs', 'responseDurationMs', 'sdkImportDurationMs', 'spawnDurationMs', 'stage',
    'totalDurationMs',
  ]);
  await client.dispose();
});

test('one prewarmed child serves exactly one request, then the next request gets a fresh child', async () => {
  const children: any[] = [];
  const client = new InitialContextEstimateClient({
    entryPath: '/inventory-worker.js',
    sdkPath: '/sdk',
    sdkPatchIdentity: {} as any,
    spawnProcess: (() => {
      const child = createRespondingChild();
      children.push(child);
      return child;
    }) as any,
    establishGuardian: async () => ({ terminate: async () => undefined }),
  });

  await client.warm();
  assert.equal(children.length, 1, 'startup creates only the one optional spare');
  assert.deepEqual(children[0].frames.map((frame: any) => frame.kind), ['initialize']);
  assert.equal('cwd' in children[0].frames[0], false, 'preload receives no request-specific cwd');
  assert.equal('agentDir' in children[0].frames[0], false, 'preload receives no user settings path');

  const first = await client.discover({
    cwd: '/workspace-one', agentDir: '/agent-one', model: { provider: 'mock', id: 'model-a' },
  });
  assert.ok(first);
  assert.equal(children.length, 1, 'the public request consumes the warm child rather than spawning again');
  assert.deepEqual(children[0].frames.map((frame: any) => frame.kind), ['initialize', 'discover']);
  assert.equal(children[0].frames[1].cwd, '/workspace-one');
  assert.equal((await client.discover({
    cwd: '/workspace-two', agentDir: '/agent-two', model: { provider: 'mock', id: 'model-b' },
  }))?.estimate.tokens, 12_345);
  assert.equal(children.length, 2, 'a consumed process is never reused across requests');
  assert.deepEqual(children.map((child) => child.frames.map((frame: any) => frame.kind)), [
    ['initialize', 'discover'], ['initialize', 'discover'],
  ]);
  await client.dispose();
});

test('concurrent discoveries are capped without spawning concurrent workers', async () => {
  let spawnCount = 0;
  const client = new InitialContextEstimateClient({
    entryPath: '/inventory-worker.js',
    sdkPath: '/sdk',
    sdkPatchIdentity: {} as any,
    maxQueuedDiscoveries: 1,
    spawnProcess: (() => { spawnCount += 1; return createRespondingChild(); }) as any,
    establishGuardian: async () => ({ terminate: async () => undefined }),
  });

  const first = client.discover({
    cwd: '/workspace-one', agentDir: '/agent-one', model: { provider: 'mock', id: 'model-a' },
  });
  const capped = client.discover({
    cwd: '/workspace-two', agentDir: '/agent-two', model: { provider: 'mock', id: 'model-b' },
  });
  assert.equal(await capped, undefined, 'excess concurrent work preserves fail-open semantics');
  assert.equal((await first)?.estimate.tokens, 12_345);
  assert.equal(spawnCount, 1, 'the queue limit does not multiply child processes');
  await client.dispose();
});

test('failed prewarm is retired and the next cold request falls back to one on-demand child', async () => {
  let spawnCount = 0;
  const client = new InitialContextEstimateClient({
    entryPath: '/inventory-worker.js',
    sdkPath: '/sdk',
    sdkPatchIdentity: {} as any,
    spawnProcess: (() => createRespondingChild(
      'Complete prompt text.', undefined, { failPreload: ++spawnCount === 1 },
    )) as any,
    establishGuardian: async () => ({ terminate: async () => undefined }),
  });

  const warmup = client.warm();
  const discovery = client.discover({
    cwd: '/workspace', agentDir: '/agent', model: { provider: 'mock', id: 'model-a' },
  });
  await assert.rejects(warmup, /invalid protocol frame/);
  const inventory = await discovery;
  assert.equal(spawnCount, 2, 'a waiting open starts one fallback after failed warmup cleanup');
  assert.equal(inventory?.estimate.tokens, 12_345);
  assert.equal(spawnCount, 2, 'fallback starts exactly one normal on-demand worker');
  await client.dispose();
});

test('a request arriving during idle cleanup waits for retirement before one on-demand fallback', async () => {
  let spawnCount = 0;
  let terminationCount = 0;
  const client = new InitialContextEstimateClient({
    entryPath: '/inventory-worker.js',
    sdkPath: '/sdk',
    sdkPatchIdentity: {} as any,
    idleTimeoutMs: 1,
    spawnProcess: (() => { spawnCount += 1; return createRespondingChild(); }) as any,
    establishGuardian: async () => ({
      terminate: async () => {
        terminationCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    }),
  });

  await client.warm();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((client as any).current?.state, 'cleaning', 'idle timeout begins guardian cleanup');
  const inventory = await client.discover({
    cwd: '/workspace', agentDir: '/agent', model: { provider: 'mock', id: 'model-a' },
  });
  assert.equal(inventory?.estimate.tokens, 12_345);
  assert.equal(spawnCount, 2, 'the retiring spare is confirmed stopped before one fallback spawn');
  assert.equal(terminationCount, 2, 'both one-use worker lifecycles use guardian termination');
  await client.dispose();
});

test('an idle child crash retires its guardian before falling back to a fresh worker', async () => {
  const children: any[] = [];
  let terminationCount = 0;
  const client = new InitialContextEstimateClient({
    entryPath: '/inventory-worker.js',
    sdkPath: '/sdk',
    sdkPatchIdentity: {} as any,
    spawnProcess: (() => {
      const child = createRespondingChild();
      children.push(child);
      return child;
    }) as any,
    establishGuardian: async () => ({ terminate: async () => { terminationCount += 1; } }),
  });

  await client.warm();
  children[0].emit('exit', 1, null);
  const inventory = await client.discover({
    cwd: '/workspace', agentDir: '/agent', model: { provider: 'mock', id: 'model-a' },
  });
  assert.equal(inventory?.estimate.tokens, 12_345);
  assert.equal(children.length, 2);
  assert.equal(terminationCount, 2, 'the crashed spare and consumed fallback both use guardian cleanup');
  await client.dispose();
});

test('disposing an unused prewarmed child terminates its guardian and prevents later discovery', async () => {
  let terminateCount = 0;
  let spawnCount = 0;
  const client = new InitialContextEstimateClient({
    entryPath: '/inventory-worker.js',
    sdkPath: '/sdk',
    sdkPatchIdentity: {} as any,
    spawnProcess: (() => { spawnCount += 1; return createRespondingChild(); }) as any,
    establishGuardian: async () => ({ terminate: async () => { terminateCount += 1; } }),
  });

  await client.warm();
  await client.dispose();
  assert.equal(terminateCount, 1);
  assert.equal((client as any).active.size, 0);
  assert.equal(await client.discover({
    cwd: '/workspace', agentDir: '/agent', model: { provider: 'mock', id: 'model-a' },
  }), undefined);
  assert.equal(spawnCount, 1);
});

test('disposal during prewarm guardian setup promptly settles callers and closes late guardian ownership', async () => {
  let startGuardian!: () => void;
  const guardianStarted = new Promise<void>((resolve) => { startGuardian = resolve; });
  let resolveGuardian!: (guardian: { terminate(): Promise<void> }) => void;
  const deferredGuardian = new Promise<{ terminate(): Promise<void> }>((resolve) => { resolveGuardian = resolve; });
  let terminationCount = 0;
  let treeTerminationCount = 0;
  const client = new InitialContextEstimateClient({
    entryPath: '/inventory-worker.js',
    sdkPath: '/sdk',
    sdkPatchIdentity: {} as any,
    spawnProcess: (() => createRespondingChild()) as any,
    establishGuardian: async () => {
      startGuardian();
      return await deferredGuardian;
    },
    terminateTree: async (rootPid) => {
      treeTerminationCount += 1;
      return { rootPid, descendantPids: [] };
    },
  });

  const warmup = client.warm();
  const discovery = client.discover({
    cwd: '/workspace', agentDir: '/agent', model: { provider: 'mock', id: 'model-a' },
  });
  await guardianStarted;
  await Promise.resolve(); // Let discovery join the in-flight prewarm before disposal.
  const disposal = client.dispose();
  let promptFailure: unknown;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promptWarmup = await Promise.race([
      warmup.then(() => 'resolved' as const, (error: unknown) => { promptFailure = error; return 'rejected' as const; }),
      new Promise<'timed out'>((resolve) => { timer = setTimeout(() => resolve('timed out'), 250); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    assert.equal(promptWarmup, 'rejected', 'prewarm rejects promptly when disposal cancels guardian setup');
    assert.match(String(promptFailure), /disposed/i);

    let discoveryTimer: ReturnType<typeof setTimeout> | undefined;
    const promptDiscovery = await Promise.race([
      discovery.then((value) => value === undefined ? 'settled' as const : 'inventory' as const),
      new Promise<'timed out'>((resolve) => { discoveryTimer = setTimeout(() => resolve('timed out'), 250); }),
    ]).finally(() => { if (discoveryTimer) clearTimeout(discoveryTimer); });
    assert.equal(promptDiscovery, 'settled', 'a queued discovery does not remain blocked on guardian setup');
    await disposal;
    assert.equal(treeTerminationCount, 1, 'disposal terminates the process tree once while guardian setup is pending');
  } finally {
    resolveGuardian({ terminate: async () => { terminationCount += 1; } });
  }

  await disposal;
  for (let attempt = 0; attempt < 20 && terminationCount === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(terminationCount, 1, 'the late guardian is terminated exactly once');
  assert.equal(treeTerminationCount, 1, 'late guardian cleanup does not repeat process-tree termination');
  assert.equal((client as any).active.size, 0, 'the disposed client retains no child ownership');
  assert.equal((client as any).current, undefined);
});

test('late guardian termination failure remains owned and explicit disposal retries it', async () => {
  let startGuardian!: () => void;
  const guardianStarted = new Promise<void>((resolve) => { startGuardian = resolve; });
  let resolveGuardian!: (guardian: { terminate(): Promise<void> }) => void;
  const deferredGuardian = new Promise<{ terminate(): Promise<void> }>((resolve) => { resolveGuardian = resolve; });
  let lateCleanupFailed!: () => void;
  const lateCleanupFailure = new Promise<void>((resolve) => { lateCleanupFailed = resolve; });
  let terminationCount = 0;
  let treeTerminationCount = 0;
  const client = new InitialContextEstimateClient({
    entryPath: '/inventory-worker.js',
    sdkPath: '/sdk',
    sdkPatchIdentity: {} as any,
    spawnProcess: (() => createRespondingChild()) as any,
    establishGuardian: async () => {
      startGuardian();
      return await deferredGuardian;
    },
    terminateTree: async (rootPid) => {
      treeTerminationCount += 1;
      return { rootPid, descendantPids: [] };
    },
    onDiagnostic: (chunk) => {
      if (chunk.includes('late guardian cleanup failed:')) lateCleanupFailed();
    },
  });

  const warmup = client.warm();
  await guardianStarted;
  const firstDisposal = client.dispose();
  await assert.rejects(warmup, /disposed/i);
  await firstDisposal;
  assert.equal(treeTerminationCount, 1, 'the initial disposal terminates the child process tree');

  resolveGuardian({
    terminate: async () => {
      terminationCount += 1;
      if (terminationCount === 1) throw new Error('late guardian termination failed');
    },
  });
  await lateCleanupFailure;
  assert.equal(terminationCount, 1, 'late guardian failure is not retried automatically');
  assert.equal((client as any).active.size, 1, 'failed late cleanup remains tracked for retry');

  await client.dispose();
  assert.equal(terminationCount, 2, 'an explicit second disposal retries guardian termination');
  assert.equal(treeTerminationCount, 1, 'retry does not repeat confirmed process-tree cleanup');
  assert.equal((client as any).active.size, 0);
  assert.equal((client as any).current, undefined);
});

test('guardian failure falls back to process-tree termination and retains failed cleanup for disposal retry', async () => {
  let spawnedEnv: NodeJS.ProcessEnv | undefined;
  let guardianAttempts = 0;
  let treeAttempts = 0;
  const client = new InitialContextEstimateClient({
    entryPath: '/inventory-worker.js',
    sdkPath: '/sdk',
    sdkPatchIdentity: {} as any,
    spawnProcess: ((_command: string, _args: readonly string[], options: any) => {
      spawnedEnv = options.env;
      return createRespondingChild();
    }) as any,
    establishGuardian: async () => ({
      terminate: async () => {
        guardianAttempts += 1;
        if (guardianAttempts === 1) throw new Error('guardian close failed');
      },
    }),
    terminateTree: async (rootPid) => {
      treeAttempts += 1;
      assert.equal(rootPid, 43_210);
      return { rootPid, descendantPids: [] };
    },
  });

  const inventory = await client.discover({
    cwd: '/workspace',
    agentDir: '/agent',
    model: { provider: 'mock', id: 'model-a' },
  });

  assert.deepEqual(inventory, {
    estimate: { tokens: 12_345, contextWindow: 200_000 },
    systemPrompts: [{
      source: 'harness', id: 'harness', title: 'Harness system prompt',
      text: 'Complete prompt text.', summary: 'Complete prompt text.', availability: 'available',
    }],
  });
  assert.equal(spawnedEnv?.PI_OFFLINE, '1');
  assert.equal(treeAttempts, 1, 'guardian failure attempts the process-tree fallback');
  assert.equal((client as any).active.size, 1, 'failed cleanup remains tracked');

  await client.dispose();
  assert.equal(guardianAttempts, 2, 'disposal retries guardian termination');
  assert.equal(treeAttempts, 1, 'a successful guardian retry needs no second tree fallback');
  assert.equal((client as any).active.size, 0);
});

test('real SDK child measures cold versus prewarmed open and reads user resources on demand', { timeout: 180_000 }, async (t) => {
  if (process.env['PIE_RUN_REAL_INVENTORY_TESTS'] !== '1') {
    t.skip('Set PIE_RUN_REAL_INVENTORY_TESTS=1 to run the real-child inventory acceptance.');
    return;
  }

  const repoRoot = path.resolve(__dirname, '../../../../');
  const sdkPath = process.env['PIE_REAL_SDK_PATH']?.trim()
    || path.join(repoRoot, 'application', 'hosts', 'vscode', 'node_modules', '@earendil-works', 'pi-coding-agent');
  const tsxLoader = path.join(repoRoot, 'application', 'hosts', 'vscode', 'node_modules', 'tsx', 'dist', 'loader.cjs');
  await fs.access(path.join(sdkPath, 'dist', 'index.js'));
  await fs.access(tsxLoader);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-inventory-real-child-'));
  const previousTrustedRoot = process.env['PIE_TRUSTED_SDK_ROOT'];
  const agentDir = path.join(tempDir, 'agent');
  const authDir = path.join(tempDir, 'auth');
  const cwd = path.join(tempDir, 'workspace');
  const systemPromptPath = path.join(agentDir, 'SYSTEM.md');
  const workerPath = path.resolve(__dirname, '..', 'initial-context-estimate-worker.ts');
  const timings: InitialContextEstimateTimingSample[] = [];
  let client: InitialContextEstimateClient | undefined;
  try {
    process.env['PIE_TRUSTED_SDK_ROOT'] = path.dirname(sdkPath);
    await Promise.all([
      fs.mkdir(authDir, { recursive: true }),
      fs.mkdir(cwd, { recursive: true }),
      fs.mkdir(agentDir, { recursive: true }),
    ]);
    await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
      providers: { mock: {
        baseUrl: 'https://inventory.invalid/v1',
        api: 'openai-completions',
        apiKey: 'offline-test-only',
        models: [{
          id: 'inventory-test-model',
          name: 'Inventory Test Model',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_000,
          maxTokens: 4_000,
        }],
      } },
    }));
    await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({
      defaultProvider: 'mock',
      defaultModel: 'inventory-test-model',
    }));
    await fs.writeFile(systemPromptPath, 'request-time-settings-sentinel');

    const identity = await ensureSdkPatchBarrier(sdkPath);
    const createClient = () => new InitialContextEstimateClient({
      entryPath: workerPath,
      nodePath: process.execPath,
      sdkPath,
      sdkPatchIdentity: identity,
      timeoutMs: 90_000,
      startupTimeoutMs: 90_000,
      idleTimeoutMs: 60_000,
      onTiming: (sample) => timings.push(sample),
      spawnProcess: ((command: string, args: readonly string[], options: any) => spawn(
        command,
        ['--require', tsxLoader, ...args],
        {
          ...options,
          env: {
            ...options.env,
            PI_CODING_AGENT_DIR: agentDir,
            PI_CODING_AGENT_AUTH_DIR: authDir,
            PI_CODING_AGENT_SESSION_DIR: path.join(tempDir, 'sessions'),
          },
        },
      )) as any,
    });
    client = createClient();
    const input = {
      cwd,
      agentDir,
      model: { provider: 'mock', id: 'inventory-test-model' },
    };

    const coldInventory = await client.discover(input);
    assert.ok(coldInventory?.systemPrompts.some((entry) => entry.text.includes('request-time-settings-sentinel')), JSON.stringify(timings));

    await client.warm();
    await fs.writeFile(systemPromptPath, 'changed-after-preload-sentinel');
    const freshSettingsInventory = await client.discover(input);
    assert.ok(freshSettingsInventory);
    assert.ok(freshSettingsInventory.systemPrompts.some((entry) => entry.text.includes('changed-after-preload-sentinel')),
      'the prewarmed process first reads user resources after the actual request');
    assert.ok(!freshSettingsInventory.systemPrompts.some((entry) => entry.text.includes('request-time-settings-sentinel')),
      'preload did not cache user prompt settings');

    await client.warm();
    await fs.writeFile(systemPromptPath, 'freshly-reloaded-system-prompt-sentinel');
    const reloadedSettingsInventory = await client.discover(input);
    assert.ok(reloadedSettingsInventory?.systemPrompts.some((entry) => entry.text.includes('freshly-reloaded-system-prompt-sentinel')),
      'a later disposable process reads the latest user prompt settings');

    const cold = timings.find((sample) => sample.stage === 'discover' && sample.prewarmed === false);
    const warm = timings.find((sample) => sample.stage === 'discover' && sample.prewarmed === true);
    assert.ok(cold && warm, 'real child timings distinguish cold and prewarmed request paths');
    assert.ok(warm.totalDurationMs < cold.totalDurationMs,
      'a prewarmed real child removes SDK startup from the request critical path');
    assert.ok((cold.preloadDurationMs ?? 0) > 0, 'cold timing includes validated SDK module import cost');
    assert.ok((timings.find((sample) => sample.stage === 'prewarm')?.totalDurationMs ?? 0) > 0,
      'prewarm import cost is separately visible rather than hidden');
    console.info('real-child inventory timing:', JSON.stringify({
      coldOpenMs: cold.totalDurationMs,
      warmOpenMs: warm.totalDurationMs,
      coldSdkImportMs: cold.preloadDurationMs,
      prewarmStartupMs: timings.find((sample) => sample.stage === 'prewarm')?.totalDurationMs,
    }));
  } finally {
    await client?.dispose().catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true });
    if (previousTrustedRoot === undefined) delete process.env['PIE_TRUSTED_SDK_ROOT'];
    else process.env['PIE_TRUSTED_SDK_ROOT'] = previousTrustedRoot;
  }
});
