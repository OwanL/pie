import test from 'node:test';
import assert from 'node:assert/strict';

import { WorkerClient } from '../../../src/backend/worker-client';
import { parseWorkerServerArgs } from '../../../src/backend/worker-server';

const BASE_OPTIONS = {
  workerEntryPath: '/worker-entry.js',
  coordinatorGeneration: 1,
  workerId: 'worker-1',
  workerGeneration: 1,
  sessionPath: 's.jsonl',
  sdkPatchIdentity: { identityVersion: 1 } as never,
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

test('parseWorkerServerArgs accepts --mcp-config', () => {
  const identity = parseWorkerServerArgs([
    '--coordinator-generation', '1',
    '--worker-id', 'w1',
    '--worker-generation', '1',
    '--session-path', 's.jsonl',
    '--ipc-read-fd', '3',
    '--ipc-write-fd', '4',
    '--mcp-config', 'C:/sessions/s.mcp-overrides.json',
  ]);
  assert.equal(identity.workerId, 'w1');
});

test('parseWorkerServerArgs rejects unknown arguments', () => {
  assert.throws(() => parseWorkerServerArgs([
    '--coordinator-generation', '1',
    '--worker-id', 'w1',
    '--worker-generation', '1', '--session-path', 's.jsonl',
    '--ipc-read-fd', '3', '--ipc-write-fd', '4',
    '--mcp-configx', 'unknown',
  ]), /Unknown worker entry argument/);
});