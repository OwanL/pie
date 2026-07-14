/**
 * Unit tests for the pure `mergePruningSettings` helper used by the reducer's
 * `SetPruningSettings` Command handler (Phase 2 — setPruningSettings, Option B:
 * reducer owns the optimistic apply).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergePruningSettings,
  DEFAULT_PRUNING_SETTINGS,
  type PruningSettings,
} from '../../../src/shared/protocol';

const base: PruningSettings = {
  ...DEFAULT_PRUNING_SETTINGS,
  mode: 'shadow',
  skillCeiling: 3,
  skillAlwaysKeep: ['a'],
  toolAlwaysKeep: ['t1', 't2'],
  prepassTimeoutSec: 30,
};

test('mergePruningSettings: replaces top-level scalars present in the update', () => {
  const merged = mergePruningSettings(base, { mode: 'off', skillCeiling: 9 });
  assert.equal(merged.mode, 'off');
  assert.equal(merged.skillCeiling, 9);
  // Untouched scalars are preserved.
  assert.equal(merged.toolCeiling, base.toolCeiling);
  assert.equal(merged.model, base.model);
  assert.equal(merged.provider, base.provider);
  assert.equal(merged.thinkingLevel, base.thinkingLevel);
});

test('mergePruningSettings: replaces (and copies) the always-keep arrays when present', () => {
  const merged = mergePruningSettings(base, { skillAlwaysKeep: ['x', 'y'] });
  assert.deepEqual(merged.skillAlwaysKeep, ['x', 'y']);
  // Untouched array is preserved.
  assert.deepEqual(merged.toolAlwaysKeep, base.toolAlwaysKeep);

  // The new array is a copy, not an alias of the update's array.
  const update: string[] = ['z'];
  const m2 = mergePruningSettings(base, { skillAlwaysKeep: update });
  assert.notEqual(m2.skillAlwaysKeep, update);
  m2.skillAlwaysKeep.push('mutated');
  assert.deepEqual(update, ['z'], 'mutating the merged array must not affect the input');
});

test('mergePruningSettings: preserves arrays (same reference) when the update omits them', () => {
  const merged = mergePruningSettings(base, { mode: 'off' });
  assert.equal(merged.skillAlwaysKeep, base.skillAlwaysKeep);
  assert.equal(merged.toolAlwaysKeep, base.toolAlwaysKeep);
});

test('mergePruningSettings: treats prepassTimeoutSec null as a real value, not omitted', () => {
  const cleared = mergePruningSettings(base, { prepassTimeoutSec: null });
  assert.equal(cleared.prepassTimeoutSec, null, 'null clears the override');

  const kept = mergePruningSettings(base, { mode: 'off' });
  assert.equal(kept.prepassTimeoutSec, 30, 'omitting the field preserves the current value');
});

test('mergePruningSettings: empty update returns a value-equal shallow copy', () => {
  const merged = mergePruningSettings(base, {});
  assert.deepEqual(merged, base);
  assert.notEqual(merged, base, 'returns a new object reference');
});

test('mergePruningSettings: does not mutate the input state', () => {
  const snapshot: PruningSettings = {
    ...base,
    skillAlwaysKeep: [...base.skillAlwaysKeep],
    toolAlwaysKeep: [...base.toolAlwaysKeep],
  };
  mergePruningSettings(base, { mode: 'custom', skillAlwaysKeep: ['new'] });
  assert.deepEqual(base, snapshot, 'current must be unchanged');
});