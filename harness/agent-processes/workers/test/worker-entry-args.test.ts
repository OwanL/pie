import test from 'node:test';
import assert from 'node:assert/strict';

import { parseWorkerServerArgs } from '../../lib/rpc/worker-server.js';

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