import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyJsonPatch,
  compactJsonPatchOperations,
  diffJsonValues,
  isJsonSafeValue,
  type JsonSafeValue,
  type JsonStructuralPatchOperation,
} from '../../../src/shared/json-structural-patch';

test('structural patches reconstruct recursive transcript updates without mutating the base', () => {
  const before: JsonSafeValue = {
    kind: 'subagent',
    children: [{
      id: 'worker', phase: 'running', streamingText: 'hel',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'old' }] }],
    }],
  };
  const after: JsonSafeValue = {
    kind: 'subagent',
    children: [{
      id: 'worker', phase: 'running', streamingText: 'hello',
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'old' }] },
        { role: 'toolResult', content: [{ type: 'text', text: 'nested result' }] },
      ],
    }],
  };
  const frozenBefore = structuredClone(before);
  const operations = diffJsonValues(before, after);
  assert.ok(operations.some((operation) => operation.op === 'appendString'));
  assert.ok(operations.some((operation) => operation.op === 'appendArray'));
  const applied = applyJsonPatch(before, operations);
  assert.equal(applied.ok, true);
  if (applied.ok) assert.deepEqual(applied.value, after);
  assert.deepEqual(before, frozenBefore);
});

test('identical values produce no patch and array shrink reconstructs exactly', () => {
  const value: JsonSafeValue = { children: [1, 2, 3] };
  assert.deepEqual(diffJsonValues(value, structuredClone(value)), []);
  const next: JsonSafeValue = { children: [1] };
  const applied = applyJsonPatch(value, diffJsonValues(value, next));
  assert.deepEqual(applied, { ok: true, value: next });
});

test('patch application rejects unsafe paths and values without prototype mutation', () => {
  const base: JsonSafeValue = { safe: {} };
  const unsafe = applyJsonPatch(base, [{
    op: 'set', path: ['safe', '__proto__'], value: { polluted: true },
  }] as JsonStructuralPatchOperation[]);
  assert.equal(unsafe.ok, false);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(isJsonSafeValue(cyclic), false);
  assert.equal(isJsonSafeValue({ value: 1n }), false);
  assert.equal(isJsonSafeValue({ value: Number.NaN }), false);
});

test('patch compaction only combines adjacent operations with the same path', () => {
  assert.deepEqual(compactJsonPatchOperations([
    { op: 'appendString', path: ['text'], value: 'a' },
    { op: 'appendString', path: ['text'], value: 'b' },
    { op: 'set', path: ['phase'], value: 'running' },
    { op: 'set', path: ['phase'], value: 'completed' },
  ]), [
    { op: 'appendString', path: ['text'], value: 'ab' },
    { op: 'set', path: ['phase'], value: 'completed' },
  ]);

  const createThenDelete: JsonStructuralPatchOperation[] = [
    { op: 'set', path: ['temporary'], value: 'value' },
    { op: 'delete', path: ['temporary'] },
  ];
  assert.deepEqual(compactJsonPatchOperations(createThenDelete), createThenDelete,
    'set then delete cannot collapse when the base property may be absent');
  assert.deepEqual(applyJsonPatch({}, compactJsonPatchOperations(createThenDelete)), { ok: true, value: {} });
});

test('malformed paths and operation capacity fail closed', () => {
  assert.equal(applyJsonPatch({ value: 'x' }, [{ op: 'appendString', path: ['missing'], value: 'y' }]).ok, false);
  assert.equal(applyJsonPatch({ value: 'x' }, Array.from({ length: 4_097 }, () => ({
    op: 'set' as const, path: ['value'], value: 'x',
  }))).ok, false);
});
