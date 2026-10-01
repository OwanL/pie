import test from 'node:test';
import assert from 'node:assert/strict';

import { WorkerClient } from '../worker-client.js';
import { SDK_PATCH_IDENTITY_VERSION } from '../../sdk-integration/sdk-patch-barrier.js';

const BASE_OPTIONS = {
  workerEntryPath: '/worker-entry.js',
  coordinatorGeneration: 1,
  workerId: 'worker-1',
  workerGeneration: 1,
  sessionPath: 's.jsonl',
  sdkRuntime: {
    kind: 'legacy-patched',
    patchIdentity: {
      identityVersion: SDK_PATCH_IDENTITY_VERSION,
      sdkPath: '/sdk',
      sdkVersion: 'fixture',
      terminalDurability: { patchVersion: 1, relativePath: 'agent.js', sha256: 'a'.repeat(64) },
      retryClassifier: { patchVersion: 1, relativePath: 'retry.js', sha256: 'b'.repeat(64) },
      coldCreateDurability: { patchVersion: 1, relativePath: 'manager.js', sha256: 'c'.repeat(64) },
      sessionOwnershipAdapter: { patchVersion: 1, relativePath: 'manager.js', sha256: 'd'.repeat(64) },
      sessionReplacementAdapter: { patchVersion: 1, relativePath: 'runtime.js', sha256: 'e'.repeat(64) },
    },
  } as never,
} satisfies Partial<ConstructorParameters<typeof WorkerClient>[0]>;

/** Capture the argv `start()` passes to spawn; the fake spawn records the args
 *  and fails fast, so no worker process is created. */
async function captureSpawnArgs(extra: Partial<ConstructorParameters<typeof WorkerClient>[0]> = {}): Promise<string[]> {
  const client = new WorkerClient({
    ...BASE_OPTIONS,
    ...extra,
  } as ConstructorParameters<typeof WorkerClient>[0]);
  const captured: string[] = [];
  await client.start().catch(() => undefined);
  return captured;
}

function spawnCapture(captured: string[]): ConstructorParameters<typeof WorkerClient>[0]['spawn'] {
  return ((exec: unknown, args: unknown) => {
    void exec;
    captured.push(...(args as string[]));
    throw new Error('captured');
  }) as unknown as ConstructorParameters<typeof WorkerClient>[0]['spawn'];
}

test('WorkerClient forwards --mcp-config to the worker argv when set', async () => {
  const captured: string[] = [];
  await captureSpawnArgs({ spawn: spawnCapture(captured), mcpConfigPath: 'C:/sessions/s.mcp-overrides.json' });
  const idx = captured.indexOf('--mcp-config');
  assert.ok(idx >= 0, 'spawn argv must contain --mcp-config');
  assert.equal(captured[idx + 1], 'C:/sessions/s.mcp-overrides.json');
});

test('WorkerClient omits --mcp-config when no session override exists (default discovery)', async () => {
  const captured: string[] = [];
  await clientStart(captured);
  assert.equal(captured.indexOf('--mcp-config'), -1);
});

async function clientStart(captured: string[]): Promise<void> {
  const client = new WorkerClient({
    ...BASE_OPTIONS,
    spawn: spawnCapture(captured),
    ...{},
  } as ConstructorParameters<typeof WorkerClient>[0]);
  await client.start().catch(() => undefined);
}