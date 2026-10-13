import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyJsonPatch,
  compactJsonPatchOperations,
  diffJsonValues,
  isJsonSafeValue,
  type JsonSafeValue,
  type JsonStructuralPatchOperation,
} from '../json-structural-patch';

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

test('root string and array growth produce applicable patches', () => {
  for (const [before, after] of [
    ['hel', 'hello'],
    [[1], [1, 2]],
    [[{ text: 'old' }], [{ text: 'new' }, { text: 'added' }]],
  ] as [JsonSafeValue, JsonSafeValue][]) {
    const operations = diffJsonValues(before, after);
    assert.deepEqual(applyJsonPatch(before, operations), { ok: true, value: after });
    assert.ok(operations.every((operation) => operation.path.length > 0 || operation.op === 'set'));
  }
});

test('sparse append arrays fail closed instead of introducing undefined entries', () => {
  const value = new Array<JsonSafeValue>(1);
  const base: JsonSafeValue = { items: [] };
  assert.equal(applyJsonPatch(base, [{ op: 'appendArray', path: ['items'], value }]).ok, false);
  assert.deepEqual(base, { items: [] });
});

test('inserted containers respect their depth in the resulting document', () => {
  const limits = { maxDepth: 2, maxPathSegments: 128, maxOperations: 4_096 };
  const base: JsonSafeValue = { nested: { items: [] } };
  const unchanged = structuredClone(base);
  for (const operation of [
    { op: 'set', path: ['nested', 'value'], value: { child: {} } },
    { op: 'appendArray', path: ['nested', 'items'], value: [{}] },
  ] as JsonStructuralPatchOperation[]) {
    assert.equal(isJsonSafeValue(operation.value, limits), true);
    assert.equal(applyJsonPatch(base, [operation], limits).ok, false);
    assert.deepEqual(base, unchanged);
  }

  for (const operation of [
    { op: 'set', path: ['nested', 'value'], value: { child: 'leaf' } },
    { op: 'appendArray', path: ['nested', 'items'], value: ['leaf'] },
    { op: 'set', path: [], value: base },
  ] as JsonStructuralPatchOperation[]) {
    const applied = applyJsonPatch(base, [operation], limits);
    assert.equal(applied.ok, true);
    if (applied.ok) assert.equal(isJsonSafeValue(applied.value, limits), true);
  }
});

test('malformed paths and operation capacity fail closed', () => {
  assert.equal(applyJsonPatch({ value: 'x' }, [{ op: 'appendString', path: ['missing'], value: 'y' }]).ok, false);
  assert.equal(applyJsonPatch({ value: 'x' }, Array.from({ length: 4_097 }, () => ({
    op: 'set' as const, path: ['value'], value: 'x',
  }))).ok, false);
});
