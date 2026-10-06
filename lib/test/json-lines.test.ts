import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

// Compare both exports within one loader graph, including under the legacy ESM runner.
const require = createRequire(import.meta.url);
const { serializeJsonLine } = require('../serialization/json-lines.js') as typeof import('../serialization/json-lines.js');
const { serializeJsonLine: rpcSerializeJsonLine } = require('../../harness/agent-processes/lib/rpc/jsonl.js') as typeof import('../../harness/agent-processes/lib/rpc/jsonl.js');

test('JSON line serializer retains exact stringify plus LF semantics and RPC compatibility', () => {
  assert.equal(rpcSerializeJsonLine, serializeJsonLine);
  for (const value of [{ text: 'é😀\n\r\u2028\u2029' }, null, undefined, true, 42, [1, undefined], { toJSON: () => 'custom' }]) {
    assert.equal(serializeJsonLine(value), `${JSON.stringify(value)}\n`);
  }
  assert.equal(serializeJsonLine(undefined), 'undefined\n');
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.throws(() => serializeJsonLine(circular), TypeError);
  assert.throws(() => serializeJsonLine(1n), TypeError);
});
