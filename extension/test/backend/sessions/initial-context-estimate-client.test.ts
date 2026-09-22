import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  buildInitialContextInventoryEnv,
  InitialContextEstimateClient,
} from '../../../src/backend/initial-context-estimate-client';

function createRespondingChild(systemPromptText = 'Complete prompt text.'): any {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outbound = new PassThrough();
  const inbound = new PassThrough();
  const child = new EventEmitter() as any;
  child.pid = 43_210;
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdio = [null, stdout, stderr, outbound, inbound];
  child.kill = () => true;
  outbound.once('finish', () => {
    inbound.end(`${JSON.stringify({
      ok: true,
      inventory: {
        estimate: { tokens: 12_345, contextWindow: 200_000 },
        systemPrompts: [{
          source: 'harness', id: 'harness', title: 'Harness system prompt',
          text: systemPromptText, summary: 'Complete prompt text.', availability: 'available',
        }],
      },
    })}\n`);
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
  const client = new InitialContextEstimateClient({
    entryPath: '/inventory-worker.js',
    sdkPath: '/sdk',
    sdkPatchIdentity: {} as any,
    spawnProcess: (() => createRespondingChild(fullText)) as any,
    establishGuardian: async () => ({ terminate: async () => undefined }),
  });

  const discovered = await client.discover({
    cwd: '/workspace', agentDir: '/agent', model: { provider: 'mock', id: 'model-a' },
  });

  assert.equal(discovered?.systemPrompts[0]?.text, fullText);
  await client.dispose();
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
