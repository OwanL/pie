import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('model dependency recovery uses gated root setup rather than a host-local install', () => {
  const source = readFileSync(new URL('../sync-models.mjs', import.meta.url), 'utf8');
  assert.match(source, /stop isolated development hosts, then run "proto run pnpm -- run setup" at the repo root/);
  assert.match(source, /workspace-reader gate must be clear; preserve installed Pie/);
  assert.doesNotMatch(source, /npm install|pnpm -- install/);
});
