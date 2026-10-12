import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { readProviderRuntimeReference } from '../../model-providers/runtime';
import { ColdSessionStore } from '../lifecycle/cold-session-store';

type FakeEntry = { type: string; customType?: string; data?: unknown };

async function withFakeSdk(run: (store: ColdSessionStore, order: string[]) => void): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-provider-runtime-marker-'));
  const order: string[] = [];
  let nextSession = 0;
  const sdk = {
    SessionManager: {
      create: (_cwd: string, _sessionDir?: string) => {
        const sessionPath = path.join(root, `session-${++nextSession}.jsonl`);
        const entries: FakeEntry[] = [];
        order.push(`sdk-create:${nextSession}`);
        return {
          getSessionFile: () => sessionPath,
          getEntries: () => entries,
          appendCustomEntry: (customType: string, data: unknown) => {
            order.push(`append:${customType}`);
            entries.push({ type: 'custom', customType, data });
          },
        };
      },
    },
  };
  const store = new ColdSessionStore({
    sdk: sdk as any,
    coordinatorGeneration: 1,
    startupCwd: root,
    agentDir: root,
    sessionDir: root,
  });
  try {
    run(store, order);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const reference = { version: 1 as const, sha256: 'a'.repeat(64) };

test('ColdSessionStore.create attaches a provider runtime reference before returning its handle', async () => {
  await withFakeSdk((store, order) => {
    const handle = store.create({ providerRuntimeReference: reference });
    const onHandleCreated = () => {
      assert.deepEqual(readProviderRuntimeReference(handle.manager), reference);
      order.push('handle-created');
    };
    onHandleCreated();

    assert.deepEqual(order, [
      'sdk-create:1',
      'append:pie-provider-runtime-v1',
      'handle-created',
    ]);
  });
});

test('ColdSessionStore.create without a provider runtime reference preserves legacy sessions', async () => {
  await withFakeSdk((store, order) => {
    const handle = store.create();
    const onHandleCreated = () => {
      assert.equal(readProviderRuntimeReference(handle.manager), undefined);
      order.push('handle-created');
    };
    onHandleCreated();

    assert.deepEqual(order, ['sdk-create:1', 'handle-created']);
  });
});
