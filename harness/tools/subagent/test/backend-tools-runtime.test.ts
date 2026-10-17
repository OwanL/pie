import assert from 'node:assert/strict';
import test from 'node:test';
import { createSubagentBackendTools, installSubagentBackendTools } from '../backend-tools-runtime.js';
import { pieToolsForContext } from '../../catalog/index.js';

test('subagent catalog permits the read-only backend tool', () => {
  assert.ok(pieToolsForContext('subagent').some(entry => entry.name === 'session_control'));
});

test('worker-owned backend factory is absent outside its installed lifetime', () => {
  assert.deepEqual(createSubagentBackendTools(), []);
  let calls = 0;
  const uninstall = installSubagentBackendTools(() => { calls++; return []; });
  try {
    createSubagentBackendTools();
    assert.equal(calls, 1);
    assert.throws(() => installSubagentBackendTools(() => []), /already installed/);
  } finally { uninstall(); }
  uninstall();
  assert.deepEqual(createSubagentBackendTools(), []);
});
