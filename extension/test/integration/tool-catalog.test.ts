import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { PIE_TOOLS, TOOL_INTEGRATIONS, pieToolsForContext, unavailablePieToolNames } from '../../../tools/index';
import { createBackendTools } from '../../../tools/backend';
import { WORKER_IPC_VERSION } from '../../src/backend/worker-protocol';

const EXPECTED_PIE_TOOLS = [
  'ask_user', 'bash', 'computer', 'defer_trigger', 'playwright',
  'request_capability', 'session_changes', 'session_control', 'subagent',
];

test('catalog explicitly owns every baseline Pie tool and references real source/registration paths', async () => {
  assert.deepEqual(PIE_TOOLS.map((entry) => entry.name), EXPECTED_PIE_TOOLS);
  assert.equal(new Set(PIE_TOOLS.map((entry) => entry.name)).size, PIE_TOOLS.length);
  for (const entry of PIE_TOOLS) {
    await access(path.resolve(process.cwd(), '..', entry.sourcePath));
    if (entry.registration.kind === 'extension') {
      await access(path.resolve(process.cwd(), '..', entry.registration.entryPath));
    }
  }
  assert.deepEqual(TOOL_INTEGRATIONS.map((entry) => entry.source), [
    '@earendil-works/pi-coding-agent', 'pi-web-access', 'pi-mcp-adapter',
  ]);
});

test('inventory mirrors primary eligibility while in-memory children exclude host lifecycle tools', () => {
  assert.deepEqual(pieToolsForContext('inventory'), pieToolsForContext('primary'));
  assert.deepEqual(unavailablePieToolNames('subagent'), ['defer_trigger', 'session_control']);
  assert.deepEqual(createBackendTools({ kind: 'subagent' }), []);
});

test('primary and inventory assemble identical backend definitions without giving inventory a transport', async () => {
  let requests = 0;
  const primary = createBackendTools({
    kind: 'primary',
    requestSessionControl: async () => {
      requests += 1;
      return {
        ipcVersion: WORKER_IPC_VERSION,
        coordinatorGeneration: 1, workerId: 'test', workerGeneration: 1, workerPid: 1,
        rootSessionPath: 'C:/session.jsonl', sessionPath: 'C:/session.jsonl',
        leasePath: 'C:/session.jsonl', leaseRevision: 1, seq: 1,
        kind: 'session.control.result', requestId: 'test', ok: true, result: { sessions: [] },
      };
    },
  });
  const inventory = createBackendTools({ kind: 'inventory' });
  assert.deepEqual(primary.map((tool) => tool.name), PIE_TOOLS
    .filter((entry) => entry.registration.kind === 'backend').map((entry) => entry.name));
  const surface = (tools: typeof primary) => tools.map(({ execute: _execute, ...definition }) => definition);
  assert.deepEqual(surface(inventory), surface(primary));
  const context = { sessionManager: { getSessionFile: () => 'C:/session.jsonl' } } as never;
  const denied = await inventory[0].execute('inventory-call', { action: 'list' }, undefined, undefined, context);
  assert.equal('isError' in denied && denied.isError, true);
  assert.match(JSON.stringify(denied.content), /Inventory tool definitions cannot execute/);
  assert.equal(requests, 0);
  await primary[0].execute('primary-call', { action: 'list' }, undefined, undefined, context);
  assert.equal(requests, 1);
});
