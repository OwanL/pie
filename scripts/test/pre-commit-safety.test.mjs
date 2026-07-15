import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const repoRoot = resolve(import.meta.dirname, '../..');
const hook = readFileSync(resolve(repoRoot, '.githooks/pre-commit'), 'utf8');

const GENERATED_FILES = [
  'models.json',
  'model-profiles.yaml',
  'settings.json',
  'analysis/model-pricing-history.json',
];

test('pre-commit refuses unstaged generated or user-owned settings changes before syncing', () => {
  const guardIndex = hook.indexOf('git diff --quiet -- $generated_files');
  const syncIndex = hook.indexOf('npm run sync-models');

  assert.ok(guardIndex >= 0, 'expected an unstaged generated-file guard');
  assert.ok(syncIndex >= 0, 'expected model synchronization');
  assert.ok(guardIndex < syncIndex, 'guard must run before synchronization can overwrite or stage files');
});

test('pre-commit stages every generated model artifact', () => {
  for (const file of GENERATED_FILES) {
    assert.match(hook, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(hook, /git add -- \$generated_files/);
});
