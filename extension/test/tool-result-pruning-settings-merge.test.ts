/**
 * Unit tests for the pure `mergeToolResultPruningSettings` helper used by the
 * reducer's `SetToolResultPruningSettings` command handler. Mirrors
 * `pruning-settings-merge.test.ts`: the reducer owns the optimistic apply, so
 * this merge must produce the same shape as the disk-write merge in
 * `writeToolResultPruningSettings`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeToolResultPruningSettings,
  DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
  type ToolResultPruningSettings,
} from '../src/shared/protocol';

const base: ToolResultPruningSettings = {
  ...DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
  enabled: true,
  profile: 'security',
  rules: { ansi: false, whitespace: true, blankRun: false, jsonMinify: true, lsLong: true, gitLog: false },
  tools: ['bash', 'ls'],
};

test('mergeToolResultPruningSettings: replaces top-level scalars present in the update', () => {
  const merged = mergeToolResultPruningSettings(base, { enabled: false, profile: 'default' });
  assert.equal(merged.enabled, false);
  assert.equal(merged.profile, 'default');
  // Untouched scalars preserved.
  assert.deepEqual(merged.rules, base.rules);
});

test('mergeToolResultPruningSettings: deep-merges the rules sub-object toggle-by-toggle', () => {
  const merged = mergeToolResultPruningSettings(base, { rules: { ansi: true, blankRun: true, gitLog: true } });
  assert.equal(merged.rules.ansi, true, 'ansi replaced');
  assert.equal(merged.rules.blankRun, true, 'blankRun replaced');
  assert.equal(merged.rules.gitLog, true, 'gitLog replaced');
  // Untouched toggles preserved (incl. lossy).
  assert.equal(merged.rules.whitespace, base.rules.whitespace);
  assert.equal(merged.rules.jsonMinify, base.rules.jsonMinify);
  assert.equal(merged.rules.lsLong, base.rules.lsLong);
});

test('mergeToolResultPruningSettings: rules update may be a partial sub-object', () => {
  const merged = mergeToolResultPruningSettings(base, { rules: { whitespace: false } });
  assert.equal(merged.rules.whitespace, false);
  assert.equal(merged.rules.ansi, base.rules.ansi, 'other toggles untouched');
  assert.equal(merged.rules.blankRun, base.rules.blankRun);
  assert.equal(merged.rules.jsonMinify, base.rules.jsonMinify);
});

test('mergeToolResultPruningSettings: copies the tools array when present (not an alias)', () => {
  const update: string[] = ['grep', 'find'];
  const merged = mergeToolResultPruningSettings(base, { tools: update });
  assert.deepEqual(merged.tools, ['grep', 'find']);
  assert.notEqual(merged.tools, update, 'merged array must be a copy');
  merged.tools!.push('mutated');
  assert.deepEqual(update, ['grep', 'find'], 'mutating the merged array must not affect the input');
});

test('mergeToolResultPruningSettings: tools: null is a real value, not omitted', () => {
  const cleared = mergeToolResultPruningSettings(base, { tools: null });
  assert.equal(cleared.tools, null, 'null clears the allowlist');

  const kept = mergeToolResultPruningSettings(base, { enabled: false });
  assert.deepEqual(kept.tools, base.tools, 'omitting tools preserves the current value');
});

test('mergeToolResultPruningSettings: preserves rules (same reference) when the update omits rules', () => {
  const merged = mergeToolResultPruningSettings(base, { enabled: false });
  assert.equal(merged.rules, base.rules, 'rules object reused when untouched');
});

test('mergeToolResultPruningSettings: empty update returns a value-equal shallow copy', () => {
  const merged = mergeToolResultPruningSettings(base, {});
  assert.deepEqual(merged, base);
  assert.notEqual(merged, base, 'returns a new object reference');
});

test('mergeToolResultPruningSettings: does not mutate the input state', () => {
  const snapshot: ToolResultPruningSettings = {
    ...base,
    rules: { ...base.rules },
    tools: base.tools ? [...base.tools] : null,
  };
  mergeToolResultPruningSettings(base, { enabled: false, rules: { ansi: true }, tools: ['x'] });
  assert.deepEqual(base, snapshot, 'current must be unchanged');
});