// Focused unit tests for scripts/install/lib/settings-repair.mjs — the
// extension-path rewriter that points committed absolute paths at THIS
// machine's npm global prefix. Idempotency is the key invariant: a second run
// on already-repaired settings must report changed=false.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { repairExtensionPaths } from '../lib/settings-repair.mjs';
import { inferRepoRoot } from '../../lib/sdk-version.mjs';

const POSIX = 'posix';
const WIN = 'win32';
const repoRoot = inferRepoRoot();

test('rewrites an absolute node_modules path to the local npm prefix (posix)', () => {
  const settings = { extensions: ['/home/other/.npm-global/node_modules/pi-web-access'] };
  const result = repairExtensionPaths(settings, { npmPrefix: '/home/me/.npm-global', platform: POSIX, existsSync: () => false });
  assert.equal(result.changed, true);
  assert.deepEqual(result.settings.extensions, ['/home/me/.npm-global/node_modules/pi-web-access']);
  assert.equal(result.rewritten[0].pkg, 'pi-web-access');
  assert.deepEqual(result.missing, ['pi-web-access']);
});

test('rewrites a Windows-style absolute path with backslash separator', () => {
  const settings = { extensions: ['C:/Users/other/AppData/Roaming/npm/node_modules/pi-web-access'] };
  const result = repairExtensionPaths(settings, { npmPrefix: 'C:\\Users\\me\\AppData\\Roaming\\npm', platform: WIN, existsSync: () => true });
  assert.equal(result.changed, true);
  assert.equal(result.settings.extensions[0], 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\pi-web-access');
  assert.deepEqual(result.missing, []);
});

test('is idempotent: an entry already pointing at the local prefix is left untouched', () => {
  const prefix = '/home/me/.npm-global';
  const already = [`${prefix}/node_modules/pi-web-access`];
  const result = repairExtensionPaths({ extensions: already }, { npmPrefix: prefix, platform: POSIX, existsSync: () => true });
  assert.equal(result.changed, false);
  assert.deepEqual(result.settings.extensions, already);
  assert.deepEqual(result.rewritten, []);
});

test('is idempotent across slash direction and case on Windows', () => {
  const prefix = 'C:\\Users\\Me\\AppData\\Roaming\\npm';
  // Forward-slash, differently-cased user segment already resolves to the same place.
  const already = ['C:/Users/me/AppData/Roaming/npm/node_modules/pi-web-access'];
  const result = repairExtensionPaths({ extensions: already }, { npmPrefix: prefix, platform: WIN, existsSync: () => true });
  assert.equal(result.changed, false);
});

test('leaves non-absolute and non-node_modules entries untouched', () => {
  const settings = { extensions: ['npm:pi-web-access@0.27.0', 'relative/node_modules/x'] };
  const result = repairExtensionPaths(settings, { npmPrefix: '/p', platform: POSIX, existsSync: () => true });
  assert.equal(result.changed, false);
  assert.deepEqual(result.settings.extensions, ['npm:pi-web-access@0.27.0', 'relative/node_modules/x']);
});

test('is a no-op when there are no extensions or no prefix', () => {
  assert.deepEqual(repairExtensionPaths({}, { npmPrefix: '/p', platform: POSIX }), { settings: {}, changed: false, rewritten: [], missing: [] });
  assert.deepEqual(repairExtensionPaths({ extensions: [] }, { npmPrefix: '/p', platform: POSIX }), { settings: { extensions: [] }, changed: false, rewritten: [], missing: [] });
  assert.deepEqual(repairExtensionPaths({ extensions: ['/a/node_modules/x'] }, { npmPrefix: '', platform: POSIX }), { settings: { extensions: ['/a/node_modules/x'] }, changed: false, rewritten: [], missing: [] });
});

test('ignores non-string extension entries', () => {
  const settings = { extensions: [{ name: 'object-entry' }, '/p/node_modules/x'] };
  const result = repairExtensionPaths(settings, { npmPrefix: '/local', platform: POSIX, existsSync: () => true });
  assert.equal(result.changed, true);
  assert.deepEqual(result.settings.extensions[0], { name: 'object-entry' });
  assert.equal(result.settings.extensions[1], '/local/node_modules/x');
});

test('installer no longer rewrites legacy global paths or falls back to the installed SDK', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-install-settings-paths-'));
  const settingsPath = path.join(root, 'settings.json');
  const original = {
    extensions: ['C:/Users/old/AppData/Roaming/npm/node_modules/legacy-extension'],
    packages: ['npm:pi-web-access@0.27.0'],
    skills: ['harness/agent-instructions/skills'],
  };
  try {
    writeFileSync(settingsPath, JSON.stringify(original));
    const before = readFileSync(settingsPath);
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'install', 'run.mjs'), 'repair-settings', settingsPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(settingsPath), before, 'settings and repository-owned seed paths remain untouched');
    assert.match(result.stderr, /legacy node_modules extension path\(s\) were left unchanged/);
    assert.match(result.stderr, /no global npm-prefix or installed-SDK fallback is used/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
