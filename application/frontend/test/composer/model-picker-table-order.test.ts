import test from 'node:test';
import assert from 'node:assert/strict';
import { sortModelPickerEntries, type ModelSortKey } from '../../settings/model-picker-order';
import { orderModelsForPicker, type ModelPickerEntry } from '../../composer/model-list';

function entry(id: string, price?: number, provider = 'p'): ModelPickerEntry {
  return orderModelsForPicker([{ id, name: id, provider, reasoning: false, inputKinds: ['text'],
    ...(price === undefined ? {} : { subagent: { eligible: true, pricing: { input: price, output: price, cacheRead: 0, cacheWrite: 0 } } }),
  }])[0];
}
const specs = (rows: ModelPickerEntry[]) => rows.map(e => `${e.model.provider}/${e.model.id}`);

test('table numeric sorting uses actual prices, zero and missing-last in both directions', () => {
  const rows = [entry('ten', 10), entry('missing'), entry('two', 2), entry('zero', 0)];
  for (const key of ['input', 'output'] as ModelSortKey[]) {
    assert.deepEqual(specs(sortModelPickerEntries(rows, [], { key, descending: false })), ['p/zero', 'p/two', 'p/ten', 'p/missing']);
    assert.deepEqual(specs(sortModelPickerEntries(rows, [], { key, descending: true })), ['p/ten', 'p/two', 'p/zero', 'p/missing']);
  }
  const precise = [entry('a', 2.004), entry('z', 2.001)];
  assert.equal(precise[0].tokenInPrice, precise[1].tokenInPrice);
  assert.deepEqual(specs(sortModelPickerEntries(precise, [], { key: 'input', descending: false })), ['p/z', 'p/a']);
});

test('favorites stay first with exact provider isolation and deterministic ties', () => {
  const rows = [entry('same', 2, 'z'), entry('same', 2, 'a'), entry('alpha', 0), entry('beta', 1)];
  for (const descending of [false, true]) {
    const result = specs(sortModelPickerEntries(rows, ['z/same', 'p/beta'], { key: 'input', descending }));
    assert.deepEqual(result.slice(0, 2), descending ? ['z/same', 'p/beta'] : ['p/beta', 'z/same']);
    assert.ok(result.indexOf('a/same') >= 2);
  }
  assert.deepEqual(specs(sortModelPickerEntries(rows.slice(0, 2), [], { key: 'input', descending: true })), ['a/same', 'z/same']);
});
