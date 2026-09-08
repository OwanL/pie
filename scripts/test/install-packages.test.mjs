import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readConfiguredPackageSources } from '../install/lib/packages.mjs';

test('readConfiguredPackageSources preserves string and filtered package entries', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pie-install-packages-'));
  const settingsPath = path.join(dir, 'settings.json');
  try {
    writeFileSync(settingsPath, JSON.stringify({
      packages: [
        'npm:pi-web-access@0.27.0',
        { source: 'npm:pi-mcp-adapter@2.20.1', extensions: ['index.ts'] },
      ],
    }));

    assert.deepEqual(readConfiguredPackageSources(settingsPath), [
      'npm:pi-web-access@0.27.0',
      'npm:pi-mcp-adapter@2.20.1',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readConfiguredPackageSources rejects malformed package entries', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pie-install-packages-'));
  const settingsPath = path.join(dir, 'settings.json');
  try {
    writeFileSync(settingsPath, JSON.stringify({ packages: [{ extensions: ['index.ts'] }] }));
    assert.throws(() => readConfiguredPackageSources(settingsPath), /Invalid package source/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
