import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const repoRoot = resolve(import.meta.dirname, '../..');

test('pre-push verification builds the extension without syncing it into VS Code', () => {
  const hook = readFileSync(resolve(repoRoot, '.githooks/pre-push'), 'utf8');
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));

  assert.match(hook, /npm run verify/);
  assert.match(packageJson.scripts.verify, /npm run extension:build:after-typecheck/);
  assert.match(packageJson.scripts['extension:build:after-typecheck'], /(?:^|\s)--no-sync(?:\s|$)/);
});
