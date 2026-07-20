import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ensureSettings } from '../ensure-settings.mjs';

function withTempDir(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-settings-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('creates settings.json from tracked defaults when settings are absent', () => withTempDir((root) => {
  const defaults = '{"pruning":{"provider":"github-copilot"}}\n';
  writeFileSync(path.join(root, 'settings.defaults.json'), defaults);

  const result = ensureSettings(root);

  assert.equal(result.created, true);
  assert.equal(readFileSync(path.join(root, 'settings.json'), 'utf8'), defaults);
}));

test('never overwrites an existing machine-local settings.json', () => withTempDir((root) => {
  writeFileSync(path.join(root, 'settings.defaults.json'), '{"pruning":{"provider":"github-copilot"}}\n');
  writeFileSync(path.join(root, 'settings.json'), '{"pruning":{"provider":"ollama"}}\n');

  const result = ensureSettings(root);

  assert.equal(result.created, false);
  assert.equal(
    readFileSync(path.join(root, 'settings.json'), 'utf8'),
    '{"pruning":{"provider":"ollama"}}\n',
  );
}));

test('fails clearly when the tracked defaults file is missing', () => withTempDir((root) => {
  assert.throws(
    () => ensureSettings(root),
    /defaults file not found/,
  );
}));
